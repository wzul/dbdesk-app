"""SQL Server support, tested without a SQL Server.

CI has no SQL Server, so the driver is faked at the `pymssql` boundary and the tests
assert the parts that break silently: the exact statement shapes T-SQL needs, the
identifier/literal quoting, the catalog mapping, and the read-only guard.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("DBDESK_HOME", tempfile.mkdtemp(prefix="dbdesk-mssql-test-"))

import dbdesk_api as api  # noqa: E402


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection
        self.description = None
        self._rows: list[list[object]] = []

    def execute(self, sql, params=None):
        self.connection.executed.append(sql)
        result = self.connection.results.pop(0) if self.connection.results else ([], [])
        columns, rows = result
        self.description = (
            [(name, code, None, None, None, None, None) for name, code in columns]
            if columns
            else None
        )
        self._rows = list(rows)

    def fetchall(self):
        return self._rows

    def fetchmany(self, size):
        return self._rows[:size]

    def close(self):
        pass


class FakeConnection:
    def __init__(self, results=None):
        self.executed: list[str] = []
        self.results = list(results or [])
        self.kwargs: dict[str, object] = {}

    def cursor(self):
        return FakeCursor(self)


class FakePymssql:
    def __init__(self, results=None):
        self.connection = FakeConnection(results)
        self.calls: list[dict[str, object]] = []

    @property
    def results(self):
        return self.connection.results

    @results.setter
    def results(self, value):
        self.connection.results = value

    def connect(self, **kwargs):
        self.calls.append(kwargs)
        self.connection.kwargs = kwargs
        return self.connection


CONN = {
    "id": "fake-sqlserver",
    "kind": "sqlserver",
    "host": "db.internal",
    "port": 1433,
    "dbname": "shop",
    "user": "app",
    "password": "secret",
    "readonly": True,
}


class SqlServerAdapterTest(unittest.TestCase):
    def setUp(self):
        self.original = api.pymssql
        self.fake = FakePymssql()
        api.pymssql = self.fake
        api._close_pools()

    def tearDown(self):
        api.pymssql = self.original
        api._close_pools()

    # --- quoting ---------------------------------------------------------- #

    def test_literals_are_unicode_and_escaped(self):
        self.assertEqual(api._ms_lit("o'brien"), "N'o''brien'")
        self.assertEqual(api._ms_lit(5), "N'5'")

    def test_identifiers_use_brackets_and_escape_closing_bracket(self):
        self.assertEqual(api._ms_ident("orders"), "[orders]")
        self.assertEqual(api._ms_ident("odd]name"), "[odd]]name]")

    def test_type_text_composes_sizes_like_the_catalog(self):
        cases = [
            (("nvarchar", 100, 0, 0), "nvarchar(50)"),   # max_length is bytes for n-types
            (("nvarchar", -1, 0, 0), "nvarchar(max)"),
            (("varchar", 20, 0, 0), "varchar(20)"),
            (("decimal", 16, 10, 2), "decimal(10,2)"),
            (("datetime2", 8, 0, 3), "datetime2(3)"),
            (("timestamp", 8, 0, 0), "rowversion"),       # not a datetime
            (("int", 4, 10, 0), "int"),
        ]
        for args, expected in cases:
            with self.subTest(args=args):
                self.assertEqual(api._ms_type_text(*args), expected)

    # --- connection ------------------------------------------------------- #

    def test_connect_kwargs(self):
        api._ms_exec({**CONN, "encryption": "require"}, "SELECT 1")
        kwargs = self.fake.calls[0]
        self.assertEqual(kwargs["server"], "db.internal")
        self.assertEqual(kwargs["port"], "1433")     # pymssql wants a string
        self.assertEqual(kwargs["database"], "shop")
        self.assertEqual(kwargs["encryption"], "require")
        self.assertTrue(kwargs["autocommit"])

    def test_unknown_encryption_mode_is_ignored(self):
        api._ms_exec({**CONN, "encryption": "banana"}, "SELECT 1")
        self.assertNotIn("encryption", self.fake.calls[0])

    def test_missing_driver_is_a_clear_error(self):
        api.pymssql = None
        with self.assertRaises(api.HTTPException) as caught:
            api._ms_exec(dict(CONN, id="no-driver"), "SELECT 1")
        self.assertIn("pymssql", str(caught.exception.detail))

    # --- statements ------------------------------------------------------- #

    def test_rows_sql_pages_with_offset_fetch_and_brackets(self):
        self.fake.results = [([("id", 3)], [[1], [2], [3]])]
        conn = dict(CONN, id="rows-page")
        api._ms_rows(conn, "dbo", "orders", 2, 4, "id", "DESC", [])
        sql = self.fake.connection.executed[0]
        self.assertIn("SELECT * FROM [dbo].[orders]", sql)
        self.assertIn("ORDER BY [id] DESC", sql)
        self.assertIn("OFFSET 4 ROWS FETCH NEXT 3 ROWS ONLY", sql)
        self.assertNotIn("TOP", sql, "TOP cannot be combined with OFFSET/FETCH")

    def test_rows_sql_without_an_order_still_orders(self):
        self.fake.results = [([("id", 3)], [[1]])]
        api._ms_rows(dict(CONN, id="rows-noorder"), "dbo", "orders", 5, 0, None, "ASC", [])
        self.assertIn("ORDER BY (SELECT NULL)", self.fake.connection.executed[0])

    def test_filters_compile_to_tsql(self):
        self.fake.results = [([("id", 3)], [])]
        api._ms_rows(
            dict(CONN, id="rows-filter"),
            "dbo",
            "orders",
            10,
            0,
            "id",
            "ASC",
            [{"name": "status", "type": "nvarchar(20)"}],
            filters=[
                {"column": "status", "op": "eq", "value": "paid"},
                {"column": "total", "op": "gte", "value": 10},
            ],
        )
        sql = self.fake.connection.executed[0]
        self.assertIn("[status] = N'paid'", sql)
        self.assertIn("[total] >= N'10'", sql)
        self.assertIn(" AND ", sql)

    def test_contains_filter_pins_a_collation(self):
        self.fake.results = [([("id", 3)], [])]
        api._ms_rows(
            dict(CONN, id="rows-contains"),
            "dbo",
            "orders",
            10,
            0,
            None,
            "ASC",
            [{"name": "note", "type": "nvarchar(max)"}],
            filters=[{"column": "note", "op": "contains", "value": "review", "insensitive": True}],
        )
        sql = self.fake.connection.executed[0]
        self.assertIn("COLLATE Latin1_General_100_CI_AS", sql)
        self.assertIn("LIKE N'%review%'", sql)

    def test_read_only_connection_refuses_writes(self):
        with self.assertRaises(api.HTTPException) as caught:
            api._ms_query(dict(CONN, readonly=True), "DELETE FROM dbo.orders", 10, True)
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(self.fake.connection.executed, [], "the statement must never reach the server")

    def test_query_truncates_to_the_limit(self):
        self.fake.results = [([("id", 3)], [[1], [2], [3]])]
        result = api._ms_query(dict(CONN, id="query-limit"), "SELECT id FROM dbo.orders", 2, True)
        self.assertEqual(result["rows"], [[1], [2]])
        self.assertTrue(result["truncated"])
        self.assertEqual(self.fake.connection.executed[0], "SELECT id FROM dbo.orders")

    # --- catalog ---------------------------------------------------------- #

    def test_tree_maps_tables_and_views(self):
        self.fake.results = [
            ([("schema", 1), ("name", 1), ("kind", 1), ("rows", 3)],
             [["dbo", "orders", "table", 17], ["sales", "v_monthly", "view", 0]]),
        ]
        tree = api._ms_tree(dict(CONN, id="tree"))
        self.assertEqual(
            tree,
            [
                {"schema": "dbo", "name": "orders", "kind": "table", "est_rows": 17},
                {"schema": "sales", "name": "v_monthly", "kind": "view", "est_rows": 0},
            ],
        )

    def test_columns_map_the_catalog(self):
        row = [
            "customer_id", "int", 4, 10, 0, False, None, False, False, False,
            "dbo", "customers", "id",
        ]
        self.fake.results = [
            ([("c", 1), ("t", 1), ("ml", 3), ("p", 3), ("s", 3), ("n", 1), ("d", 1),
              ("i", 1), ("comp", 1), ("pk", 3), ("fks", 1), ("fkt", 1), ("fkc", 1)], [row]),
        ]
        columns = api._ms_columns(dict(CONN, id="columns"), "dbo", "orders")
        self.assertEqual(columns[0]["name"], "customer_id")
        self.assertEqual(columns[0]["type"], "int")
        self.assertFalse(columns[0]["nullable"])
        self.assertEqual(
            columns[0]["fk"], {"schema": "dbo", "table": "customers", "column": "id"}
        )
        # OBJECT_ID receives the bracketed, escaped name
        self.assertIn("OBJECT_ID(N'[dbo].[orders]')", self.fake.connection.executed[0])


if __name__ == "__main__":
    unittest.main()
