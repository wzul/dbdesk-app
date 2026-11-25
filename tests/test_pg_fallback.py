"""The pg8000 adapter that stands in for psycopg on platforms without wheels.

These are offline tests: a fake pg8000 module records the arguments it is handed,
so nothing here needs a live PostgreSQL server. The live behaviour was verified
against a real server separately (rows, aggregates, DDL, a write).
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("DBDESK_HOME", tempfile.mkdtemp(prefix="dbdesk-pgfallback-"))
os.environ.setdefault("DBDESK_NO_NOTIFY", "1")

import dbdesk_api as api  # noqa: E402


class _FakeCursor:
    def __init__(self):
        self.executed = []
        self.description = [
            ("id", 23, None, None, None, None, None),
            ("total", 1700, None, None, None, None, None),
        ]
        self.rowcount = 2

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        return [(1, "49.90")]

    def fetchone(self):
        return (1, "49.90")

    def fetchmany(self, size=None):
        return [(1, "49.90")][: size or 1]

    def close(self):
        pass


class _FakeConnection:
    def __init__(self):
        self.autocommit = False
        self.cursor_obj = _FakeCursor()

    def cursor(self):
        return self.cursor_obj

    def close(self):
        pass

    def commit(self):
        pass

    def rollback(self):
        pass


class _FakeModule:
    def __init__(self):
        self.kwargs = None
        self.connection = _FakeConnection()

    def connect(self, **kwargs):
        self.kwargs = kwargs
        return self.connection


class Pg8000AdapterTest(unittest.TestCase):
    def setUp(self):
        self.module = _FakeModule()
        self.driver = api._Pg8000Driver(self.module)

    def test_connect_maps_psycopg_keywords(self):
        conn = self.driver.connect(
            host="db.internal",
            port=5432,
            dbname="app",
            user="reader",
            password="secret",
            connect_timeout=10,
            sslmode="prefer",
            autocommit=True,
            application_name="dbdesk",
        )

        self.assertEqual(
            self.module.kwargs,
            {"host": "db.internal", "port": 5432, "database": "app",
             "user": "reader", "password": "secret", "timeout": 10},
        )
        self.assertIsInstance(conn, api._Pg8000Connection)
        # psycopg gets autocommit from the connect() call; pg8000 needs the attribute.
        self.assertTrue(self.module.connection.autocommit)

    def test_sslmode_require_adds_an_unverified_context(self):
        self.driver.connect(host="h", dbname="d", user="u", sslmode="require")
        assert self.module.kwargs is not None
        context = self.module.kwargs["ssl_context"]
        self.assertFalse(context.check_hostname)
        self.assertEqual(context.verify_mode, api.ssl.CERT_NONE)

    def test_sslmode_disable_sends_no_context(self):
        self.driver.connect(host="h", dbname="d", user="u", sslmode="disable")
        self.assertIsNotNone(self.module.kwargs)
        self.assertNotIn("ssl_context", self.module.kwargs or {})

    def test_description_entries_expose_name_and_type_code(self):
        with self.driver.connect(host="h", dbname="d", user="u"):
            pass
        cursor = self.driver.connect(host="h", dbname="d", user="u").cursor()
        columns = [
            {"name": desc.name, "type": api._pg_type_name(desc.type_code)}
            for desc in cursor.description
        ]
        # psycopg reports the server's own spellings; the fallback must match so a
        # column header does not change wording between platforms.
        self.assertEqual(columns, [{"name": "id", "type": "int4"},
                                   {"name": "total", "type": "numeric"}])

    def test_cursor_is_a_context_manager_and_passes_params(self):
        cursor = self.driver.connect(host="h", dbname="d", user="u").cursor()
        with cursor as cur:
            cur.execute("select * from t where id = %s", [7])
        self.assertEqual(cur._cursor.executed, [("select * from t where id = %s", (7,))])

    def test_fallback_type_names_match_psycopg_spelling(self):
        driver = api._Pg8000Driver(self.module)
        self.assertEqual(driver.postgres.types.get(23).name, "int4")
        self.assertEqual(driver.postgres.types.get(1184).name, "timestamptz")
        self.assertIsNone(driver.postgres.types.get(999999))


if __name__ == "__main__":
    unittest.main()
