"""Standalone server smoke tests (no display, no database server required)."""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("DBDESK_HOME", tempfile.mkdtemp(prefix="dbdesk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

import app as standalone  # noqa: E402


class StandaloneServer(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(standalone.app)
        handle, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        con = sqlite3.connect(self.db_path)
        con.executescript(
            """
            CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
            INSERT INTO people (name) VALUES ('Ali'), ('Siti');
            """
        )
        con.commit()
        con.close()

    def tearDown(self) -> None:
        os.unlink(self.db_path)

    def add_connection(self, readonly: bool = True) -> dict:
        response = self.client.post(
            "/api/connections",
            json={
                "kind": "sqlite",
                "name": "test",
                "dbname": self.db_path,
                "readonly": readonly,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["connection"]

    def test_health(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

    def test_sqlite_flow(self) -> None:
        record = self.add_connection(readonly=False)
        cid = record["id"]

        tree = self.client.get(f"/api/connections/{cid}/tree").json()
        self.assertEqual(tree["schemas"][0]["tables"][0]["name"], "people")

        rows = self.client.post(
            "/api/table/rows",
            json={"connection_id": cid, "schema": "main", "table": "people", "limit": 10},
        ).json()
        self.assertEqual([row[1] for row in rows["rows"]], ["Ali", "Siti"])

        query = self.client.post(
            "/api/query",
            json={"connection_id": cid, "sql": "select count(*) from people"},
        ).json()
        self.assertEqual(query["rows"][0][0], 2)

        insert = self.client.post(
            "/api/rows/insert",
            json={"connection_id": cid, "schema": "main", "table": "people", "values": {"name": "Abu"}},
        )
        self.assertEqual(insert.status_code, 200, insert.text)

    def test_readonly_refuses_writes(self) -> None:
        cid = self.add_connection(readonly=True)["id"]
        response = self.client.post(
            "/api/query",
            json={"connection_id": cid, "sql": "delete from people"},
        )
        self.assertEqual(response.status_code, 403)

    def test_ui_is_served(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("DB Desk", response.text)


if __name__ == "__main__":
    unittest.main()
