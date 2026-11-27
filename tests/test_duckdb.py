"""DuckDB as a first-class local engine.

DuckDB is opened by file, like SQLite, but it is not SQLite: identifiers are double-quoted,
the catalog lives in `information_schema` plus `duckdb_tables()`/`duckdb_indexes()`, and the
read-only flag is applied at connect time because there is no server to hold a grant. These
tests run against a real DuckDB file, so a wrong catalog query fails here instead of in the
app.
"""

import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import duckdb

import duckdb_kind

requires_duckdb = unittest.skipUnless(duckdb_kind.duckdb is not None, "duckdb not installed")


def make_fixture(path: str) -> None:
    db = duckdb.connect(path)
    db.execute("create schema sales")
    db.execute(
        "create table sales.orders (id integer, customer varchar, total decimal(10,2), "
        "status varchar, created_at timestamp)"
    )
    db.executemany(
        "insert into sales.orders values (?,?,?,?,?)",
        [
            (1, "ada", "120.50", "paid", "2026-01-02 10:00:00"),
            (2, "grace", "40.00", "pending", "2026-01-03 11:30:00"),
            (3, "alan", "250.75", "paid", "2026-01-04 09:15:00"),
        ],
    )
    db.execute("create table sales.products (sku varchar, price decimal(8,2))")
    db.execute("create view sales.paid_orders as select * from sales.orders where status='paid'")
    db.close()


@requires_duckdb
class DuckDBSchemaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.path = os.path.join(cls.tmp.name, "analytics.duckdb")
        make_fixture(cls.path)
        cls.conn = {"kind": "duckdb", "dbname": cls.path, "readonly": True}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_test_endpoint_reports_version_and_tables(self):
        info = duckdb_kind.test(self.conn)
        self.assertIn("DuckDB", info["version"])
        # Two base tables; the view is not counted as a table.
        self.assertIn("2 table(s)", info["version"])
        self.assertEqual(info["database"], self.path)

    def test_tree_lists_the_user_schema_and_marks_views(self):
        nodes = duckdb_kind.tree(self.conn)
        by_name = {node["name"]: node for node in nodes}
        self.assertIn("orders", by_name)
        self.assertIn("paid_orders", by_name)
        self.assertEqual(by_name["paid_orders"]["kind"], "view")
        self.assertEqual(by_name["orders"]["kind"], "table")
        self.assertEqual(by_name["orders"]["schema"], "sales")
        # System catalogs must not leak into the sidebar.
        self.assertNotIn("information_schema", {node["schema"] for node in nodes})

    def test_columns_carry_real_types(self):
        cols = duckdb_kind.columns(self.conn, "sales", "orders")
        types = {column["name"]: column["type"] for column in cols}
        self.assertEqual(types["id"], "INTEGER")
        self.assertEqual(types["total"], "DECIMAL(10,2)")
        self.assertEqual(types["created_at"], "TIMESTAMP")

    def test_rows_paginate_and_truncate(self):
        cols = duckdb_kind.columns(self.conn, "sales", "orders")
        page = duckdb_kind.rows(self.conn, "sales", "orders", 2, 0, "id", "ASC", None,
                                where="", columns_meta=cols)
        self.assertEqual([row[0] for row in page["rows"]], [1, 2])
        self.assertTrue(page["truncated"])
        second = duckdb_kind.rows(self.conn, "sales", "orders", 2, 2, "id", "ASC", None,
                                  where="", columns_meta=cols)
        self.assertEqual([row[0] for row in second["rows"]], [3])
        self.assertFalse(second["truncated"])

    def test_decimal_and_timestamp_survive_json(self):
        cols = duckdb_kind.columns(self.conn, "sales", "orders")
        page = duckdb_kind.rows(self.conn, "sales", "orders", 1, 0, "id", "ASC", None,
                                where="", columns_meta=cols)
        row = page["rows"][0]
        # The HTTP layer has to serialise these: Decimal and datetime are not JSON types.
        for value in row:
            self.assertIsInstance(value, (str, int, float, bool, type(None)))

    def test_ddl_comes_from_the_catalog(self):
        ddl = duckdb_kind.ddl(self.conn, "sales", "orders")
        self.assertIn("CREATE TABLE", ddl.upper())
        self.assertIn("orders", ddl)
        self.assertIn("DECIMAL(10,2)", ddl.replace(" ", ""))

    def test_indexes_are_empty_not_an_error(self):
        self.assertEqual(duckdb_kind.indexes(self.conn, "sales", "orders"), [])

    def test_read_only_blocks_writes_at_open_time(self):
        with self.assertRaises(Exception):
            duckdb_kind.run(self.conn, ["delete from sales.orders"])

    def test_query_reads_and_reports_types(self):
        result = duckdb_kind.query(self.conn, "select status, count(*) n from sales.orders "
                                             "group by 1 order by 2 desc", 100, True)
        self.assertEqual(result["rows"][0], ["paid", 2])
        self.assertEqual([column["name"] for column in result["columns"]], ["status", "n"])
        self.assertTrue(result["readonly"])

    def test_missing_file_is_a_clear_404(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            duckdb_kind.tree({"kind": "duckdb", "dbname": "/nope/missing.duckdb"})
        self.assertEqual(ctx.exception.status_code, 404)


class DuckDBWiringTest(unittest.TestCase):
    def test_kind_is_registered_as_a_file_database(self):
        import dbdesk_api as api

        self.assertIn("duckdb", api.KINDS)
        self.assertIn("duckdb", api.FILE_KINDS)
        # A file database has no host, no port and no tunnel.
        self.assertNotIn("duckdb", api.DEFAULT_PORTS)

    def test_filters_have_a_duckdb_dialect(self):
        source = (ROOT / "backend" / "dbdesk_api.py").read_text()
        self.assertIn('"duckdb": _ident', source)
        self.assertIn('"duckdb": _lit', source)


if __name__ == "__main__":
    unittest.main()
