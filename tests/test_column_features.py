"""Encrypted-column reveal and timezone display/filter tests."""

from __future__ import annotations

import base64
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("DBDESK_HOME", tempfile.mkdtemp(prefix="dbdesk-columns-"))
os.environ.setdefault("DBDESK_NO_NOTIFY", "1")

from fastapi.testclient import TestClient  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

import app as standalone  # noqa: E402
import dbdesk_api  # noqa: E402


class ColumnFeatures(unittest.TestCase):
    def setUp(self) -> None:
        dbdesk_api._save([])
        self.client = TestClient(standalone.app)
        handle, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        con = sqlite3.connect(self.db_path)
        con.executescript(
            """
            CREATE TABLE events (id INTEGER PRIMARY KEY, created_at timestamp, note text);
            INSERT INTO events (created_at, note) VALUES ('2023-05-23T07:05:34.863445', 'utc');
            CREATE TABLE accounts (id INTEGER PRIMARY KEY, account_number varchar);
            """
        )
        self.key = b"0123456789abcdef0123456789abcdef"
        iv = os.urandom(12)
        ciphertext = AESGCM(self.key).encrypt(iv, b"123-456-789", None)
        self.envelope = json.dumps(
            {
                "p": base64.b64encode(ciphertext).decode(),
                "h": {"iv": base64.b64encode(iv).decode()},
            }
        )
        con.execute("INSERT INTO accounts (account_number) VALUES (?)", (self.envelope,))
        con.commit()
        con.close()
        response = self.client.post(
            "/api/connections",
            json={
                "kind": "sqlite",
                "name": "columns",
                "dbname": self.db_path,
                "readonly": False,
                "display_tz": "Asia/Kuala_Lumpur",
                "storage_tz": "UTC",
                "decrypt_key": self.key.decode(),
                "decrypt_columns": "account_number",
                "decrypt_algo": "auto",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.record = response.json()["connection"]
        self.cid = self.record["id"]

    def tearDown(self) -> None:
        dbdesk_api._save([])
        os.unlink(self.db_path)

    def test_public_hides_the_key(self) -> None:
        self.assertTrue(self.record["decrypt_key_set"])
        self.assertNotIn("decrypt_key", self.record)
        self.assertNotIn("decrypt_key_enc", self.record)
        self.assertEqual(self.record["display_tz"], "Asia/Kuala_Lumpur")

    def test_timezone_display_and_filter(self) -> None:
        rows = self.client.post(
            "/api/table/rows",
            json={"connection_id": self.cid, "schema": "main", "table": "events", "limit": 10},
        ).json()
        self.assertEqual(rows["rows"][0][1], "2023-05-23 15:05:34.863445+08:00")
        self.assertEqual(rows["display_timezone"], "Asia/Kuala_Lumpur")

        conn = {"display_tz": "Asia/Kuala_Lumpur", "storage_tz": "UTC"}
        sql = dbdesk_api._where_clause(
            "postgres",
            [{"mode": "column", "column": "created_at", "op": "eq", "value": "2023-05-23 15:05:34.863445"}],
            [{"name": "created_at", "type": "timestamp without time zone"}],
            conn,
        )
        self.assertIn("2023-05-23 07:05:34.863445", sql)

    def test_decrypts_the_configured_column(self) -> None:
        rows = self.client.post(
            "/api/table/rows",
            json={"connection_id": self.cid, "schema": "main", "table": "accounts", "limit": 10},
        ).json()
        self.assertEqual(rows["rows"][0][1], self.envelope)
        self.assertEqual(rows["decrypted_rows"][0][1], "123-456-789")
        self.assertEqual(rows["decrypted_columns"], ["account_number"])

    def test_bad_key_leaves_the_ciphertext(self) -> None:
        response = self.client.post(
            "/api/connections",
            json={
                "id": self.cid,
                "kind": "sqlite",
                "name": "columns",
                "dbname": self.db_path,
                "readonly": False,
                "display_tz": "UTC",
                "decrypt_key": "not-the-right-key",
                "decrypt_columns": "account_number",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        rows = self.client.post(
            "/api/table/rows",
            json={"connection_id": self.cid, "schema": "main", "table": "accounts", "limit": 10},
        ).json()
        self.assertNotIn("decrypted_rows", rows)


if __name__ == "__main__":
    unittest.main()
