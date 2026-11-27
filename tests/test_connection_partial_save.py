"""Saving part of a connection must not clear the parts you did not send.

The save endpoint doubles as the update endpoint (`id` in the body), and every field
falls back to the stored row — except the name, which fell back to "Database". Flipping
`readonly` from a script silently renamed the connection; this keeps that from
returning.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("DBDESK_HOME", tempfile.mkdtemp(prefix="dbdesk-connsave-"))

from fastapi.testclient import TestClient  # noqa: E402

import app as server  # noqa: E402


class PartialConnectionSaveTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        self.db = Path(tempfile.mkdtemp(prefix="dbdesk-connsave-db-")) / "demo.db"

    def save(self, payload):
        response = self.client.post("/api/connections", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["connection"]

    def test_readonly_flip_keeps_the_name_and_path(self):
        created = self.save({"name": "Demo", "kind": "sqlite", "dbname": str(self.db)})
        updated = self.save({"id": created["id"], "readonly": not created["readonly"]})
        self.assertEqual(updated["name"], "Demo")
        self.assertEqual(updated["dbname"], str(self.db))
        self.assertEqual(updated["readonly"], not created["readonly"])

    def test_rename_still_works(self):
        created = self.save({"name": "Demo", "kind": "sqlite", "dbname": str(self.db)})
        renamed = self.save({"id": created["id"], "name": "Shop"})
        self.assertEqual(renamed["name"], "Shop")


if __name__ == "__main__":
    unittest.main()
