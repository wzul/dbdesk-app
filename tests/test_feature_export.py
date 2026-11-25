"""Table export, drop and function listing tests."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("DBDESK_HOME", tempfile.mkdtemp(prefix="dbdesk-export-"))
os.environ.setdefault("DBDESK_NO_NOTIFY", "1")

from fastapi.testclient import TestClient  # noqa: E402

import app as standalone  # noqa: E402
import dbdesk_api  # noqa: E402


class ExportFeatures(unittest.TestCase):
    def setUp(self) -> None:
        dbdesk_api._save([])
        self.client = TestClient(standalone.app)
        handle, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        con = sqlite3.connect(self.db_path)
        con.executescript(
            """
            CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, country TEXT);
            INSERT INTO people (name, country) VALUES ('Ali', 'MY'), ('Siti', 'SG'), ('Abu', 'MY');
            CREATE TABLE scratch (id INTEGER PRIMARY KEY);
            """
        )
        con.commit()
        con.close()
        response = self.client.post(
            "/api/connections",
            json={"kind": "sqlite", "name": "export", "dbname": self.db_path, "readonly": False},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.cid = response.json()["connection"]["id"]

    def tearDown(self) -> None:
        dbdesk_api._save([])
        os.unlink(self.db_path)

    def export(self, fmt: str, **extra):
        body = {
            "connection_id": self.cid,
            "schema": "main",
            "table": "people",
            "format": fmt,
            "limit": 50,
            **extra,
        }
        return self.client.post("/api/table/export", json=body)

    def test_csv_json_sql_export_respects_filters(self) -> None:
        filters = [{"mode": "column", "column": "country", "op": "eq", "value": "MY", "enabled": True}]
        csv_response = self.export("csv", filters=filters)
        self.assertEqual(csv_response.status_code, 200, csv_response.text)
        payload = csv_response.json()
        self.assertTrue(payload["filename"].endswith(".csv"))
        self.assertIn("Ali", payload["content"])
        self.assertIn("Abu", payload["content"])
        self.assertNotIn("Siti", payload["content"])

        json_response = self.export("json", filters=filters)
        self.assertEqual(json_response.status_code, 200, json_response.text)
        rows = json.loads(json_response.json()["content"])
        self.assertEqual([row["name"] for row in rows], ["Ali", "Abu"])

        sql_response = self.export("sql", filters=filters)
        self.assertEqual(sql_response.status_code, 200, sql_response.text)
        sql = sql_response.json()["content"]
        self.assertIn("INSERT INTO", sql)
        self.assertIn("'Ali'", sql)
        self.assertNotIn("Siti", sql)

    def test_export_orders_and_limit(self) -> None:
        response = self.export("json", order_by="name", order_dir="desc", limit=2)
        rows = json.loads(response.json()["content"])
        self.assertEqual([row["name"] for row in rows], ["Siti", "Ali"])
        self.assertTrue(response.json()["truncated"])

    def test_drop_preview_and_execute(self) -> None:
        body = {"connection_id": self.cid, "schema": "main", "table": "scratch"}
        preview = self.client.post("/api/table/drop", json={**body, "preview": True})
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertIn("DROP TABLE", preview.json()["sql"])
        dropped = self.client.post("/api/table/drop", json=body)
        self.assertEqual(dropped.status_code, 200, dropped.text)
        con = sqlite3.connect(self.db_path)
        try:
            names = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        finally:
            con.close()
        self.assertNotIn("scratch", names)

    def test_functions_empty_for_sqlite(self) -> None:
        response = self.client.get(f"/api/connections/{self.cid}/functions")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["functions"], [])


if __name__ == "__main__":
    unittest.main()
