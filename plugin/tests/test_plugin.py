"""DB Desk automated tests — backend helpers, storage, endpoints and agent tools.

Run with the Hermes Python (the module imports FastAPI + cryptography):

    ./tests/run.sh

No database server is required: dialect calls are mocked, storage is a temp
HERMES_HOME, and the endpoint functions are exercised directly.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import re
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

PLUGIN = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PLUGIN / "dashboard"))

import plugin_api as api  # noqa: E402
from fastapi import HTTPException  # noqa: E402


def conn(kind: str = "postgres", **over):
    """A fully-shaped connection record for builders/tests."""
    base = {
        "id": "c1",
        "kind": kind,
        "name": "test",
        "group": "",
        "host": "127.0.0.1",
        "port": 5432,
        "dbname": "db",
        "user": "u",
        "password": "p",
        "password_enc": "",
        "sslmode": "disable",
        "readonly": False,
        "production": False,
        "ssh_host": "",
        "ssh_user": "root",
        "ssh_port": 22,
        "ssh_key": "",
        "db_labels": {},
    }
    base.update(over)
    return base


class Base(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        os.environ["HERMES_HOME"] = str(self.home)
        os.environ["DBDESK_NO_NOTIFY"] = "1"
        (self.home / "plugin-data" / "dbdesk").mkdir(parents=True)

    def tearDown(self) -> None:
        os.environ.pop("HERMES_HOME", None)
        os.environ.pop("DBDESK_NO_NOTIFY", None)
        self._tmp.cleanup()

    @staticmethod
    def conn(kind: str = "postgres", **over):
        return conn(kind, **over)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


class TestHelpers(unittest.TestCase):
    def test_multiple_statements(self):
        self.assertFalse(api._has_multiple_statements("select 1"))
        self.assertTrue(api._has_multiple_statements("select 1; select 2"))
        self.assertFalse(api._has_multiple_statements("select ';'"))
        self.assertFalse(api._has_multiple_statements("select $$a;b$$"))
        self.assertFalse(api._has_multiple_statements('select "a;b"'))

    def test_check_sql(self):
        self.assertEqual(api._check_sql(" select 1; "), "select 1")
        with self.assertRaises(HTTPException) as ctx:
            api._check_sql("   ")
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException):
            api._check_sql("select 1; select 2")

    def test_literals(self):
        self.assertEqual(api._lit("O'Reilly"), "'O''Reilly'")
        self.assertEqual(api._ident('a"b'), '"a""b"')
        self.assertEqual(api._my_lit("a'b\\c"), "'a\\'b\\\\c'")
        self.assertEqual(api._my_ident("a`b"), "`a``b`")
        self.assertEqual(api._ch_lit("a'b\\c"), "'a\\'b\\\\c'")

    def test_where_clause(self):
        filters = [
            {"column": "name", "op": "eq", "value": "x"},
            {"column": "gone", "op": "isnull"},
        ]
        self.assertEqual(
            api._where_clause("postgres", filters),
            '"name" = \'x\' AND "gone" IS NULL',
        )
        self.assertEqual(
            api._where_clause("mysql", [{"column": "name", "op": "contains", "value": "x"}]),
            "LOWER(CAST(`name` AS CHAR)) LIKE LOWER('%x%')",
        )
        self.assertEqual(
            api._where_clause(
                "mysql",
                [{"column": "name", "op": "contains", "value": "x", "insensitive": False}],
            ),
            "CAST(`name` AS CHAR) LIKE BINARY '%x%'",
        )
        self.assertEqual(
            api._where_clause(
                "postgres",
                [{"column": "name", "op": "startswith", "value": "x", "insensitive": False}],
            ),
            '"name"::text LIKE \'x%\'',
        )
        self.assertEqual(
            api._where_clause(
                "clickhouse",
                [{"column": "name", "op": "contains", "value": "x", "insensitive": False}],
            ),
            "positionCaseSensitiveUTF8(toString(`name`), 'x') > 0",
        )
        self.assertEqual(
            api._where_clause("clickhouse", [{"column": "n", "op": "gt", "value": "5"}]),
            "`n` > '5'",
        )
        self.assertEqual(
            api._where_clause("sqlite", [{"column": "n", "op": "eq", "value": "5"}]),
            '"n" = \'5\'',
        )
        self.assertEqual(
            api._where_clause(
                "sqlite",
                [{"column": "name", "op": "contains", "value": "x", "insensitive": False}],
            ),
            "instr(CAST(\"name\" AS TEXT), 'x') > 0",
        )
        self.assertEqual(
            api._where_clause(
                "sqlite",
                [{"column": "name", "op": "startswith", "value": "x"}],
            ),
            "lower(substr(CAST(\"name\" AS TEXT), 1, length('x'))) = lower('x')",
        )

    def test_like_escape(self):
        self.assertEqual(api._like_escape("50%_x"), "50\\%\\_x")

    def test_column_cache(self):
        record = conn("mysql")
        calls = []

        def fake(conn_arg, schema, table):
            calls.append((schema, table))
            return [{"name": "id", "type": "int", "nullable": False, "default": None, "pk": True}]

        api._invalidate_columns()
        with mock.patch.object(api, "_my_columns", side_effect=fake):
            first = api._columns(record, "db", "t")
            second = api._columns(record, "db", "t")
            api._invalidate_columns()
            api._columns(record, "db", "t")

        self.assertEqual(len(calls), 2)
        self.assertEqual(first, second)
        self.assertIsNot(first, second)

    def test_column_cache_coalesces_concurrent_lookups(self):
        record = conn("postgres")
        calls = []

        def slow(conn_arg, schema, table):
            calls.append((schema, table))
            time.sleep(0.05)
            return [{"name": "id"}]

        api._invalidate_columns()
        with mock.patch.object(api, "_pg_columns", side_effect=slow):
            threads = [
                threading.Thread(target=api._columns, args=(record, "public", "t"))
                for _ in range(4)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        self.assertEqual(len(calls), 1)

    def test_csv_from(self):
        csv_text = api._csv_from(
            [{"name": "a"}, {"name": "b"}],
            [[1, None], ["x,y", 'q"z']],
        )
        self.assertEqual(csv_text, 'a,b\n1,\n"x,y","q""z"\n')


# --------------------------------------------------------------------------- #
# vault + storage
# --------------------------------------------------------------------------- #


class TestVault(Base):
    def test_encrypt_roundtrip(self):
        token = api._encrypt("s3cret")
        self.assertTrue(token.startswith("v1:"))
        self.assertNotIn("s3cret", token)
        self.assertEqual(api._decrypt(token), "s3cret")
        self.assertEqual(api._decrypt(""), "")

    async def test_save_connection_encrypts(self):
        saved = await api.save_connection(
            {
                "kind": "postgres",
                "name": "PG",
                "host": "127.0.0.1",
                "port": 5432,
                "dbname": "db",
                "user": "u",
                "password": "hunter2",
            }
        )
        public = saved["connection"]
        self.assertNotIn("password", public)
        self.assertNotIn("password_enc", public)
        raw = json.loads((api._store_path()).read_text())["connections"][0]
        self.assertNotIn("password", raw)
        self.assertTrue(raw["password_enc"].startswith("v1:"))
        self.assertEqual(api._get(raw["id"])["password"], "hunter2")

    def test_clickhouse_header_parser(self):
        headers = api._parse_ch_headers(
            "CF-Access-Client-Id: abc\nX-Test:  1\n# comment\n"
        )
        self.assertEqual(headers["CF-Access-Client-Id"], "abc")
        self.assertEqual(headers["X-Test"], "1")
        with self.assertRaises(HTTPException):
            api._parse_ch_headers("not a header", strict=True)
        with self.assertRaises(HTTPException):
            api._parse_ch_headers("Host: evil", strict=True)

    def test_clickhouse_default_user_agent_and_override(self):
        conn = self.conn("clickhouse", user="u", password="p", ch_headers="")
        headers = api._ch_headers(conn)
        self.assertIn("Mozilla/5.0", headers["User-Agent"])
        self.assertEqual(headers["X-ClickHouse-User"], "u")

        conn["ch_headers"] = "user-agent: Custom/1.0\nCF-Access-Client-Id: id"
        headers = api._ch_headers(conn)
        user_agents = [key for key in headers if key.lower() == "user-agent"]
        self.assertEqual(user_agents, ["user-agent"])
        self.assertEqual(headers["user-agent"], "Custom/1.0")
        self.assertEqual(headers["CF-Access-Client-Id"], "id")

    def test_clickhouse_url_path(self):
        conn = self.conn(
            "clickhouse",
            host="ch.example.com",
            port=443,
            dbname="default",
            sslmode="require",
            ch_path="ch",
        )
        url = api._ch_url(conn, True)
        self.assertTrue(url.startswith("https://ch.example.com:443/ch?"))
        self.assertIn("readonly=1", url)

    def test_clickhouse_host_url_is_normalized(self):
        conn = self.conn(
            "clickhouse",
            host="https://ch.example.com",
            port=8123,
            dbname="default",
            sslmode="prefer",
            ch_path="/",
        )
        url = api._ch_url(conn, True)
        self.assertTrue(url.startswith("https://ch.example.com:443/?"), url)

        conn = self.conn(
            "clickhouse",
            host="https://ch.example.com:8443/ch",
            port=8123,
            dbname="default",
            sslmode="prefer",
            ch_path="/",
        )
        url = api._ch_url(conn, True)
        self.assertTrue(url.startswith("https://ch.example.com:8443/ch?"), url)

        conn = self.conn(
            "clickhouse",
            host="ch.example.com",
            port=443,
            dbname="default",
            sslmode="prefer",
            ch_path="/",
        )
        self.assertTrue(api._ch_url(conn, True).startswith("https://ch.example.com:443/?"))

    async def test_clickhouse_host_url_saved_normalized(self):
        saved = await api.save_connection(
            {
                "kind": "clickhouse",
                "name": "CH URL",
                "host": "https://ch.example.com:8443/ch",
                "port": 8123,
                "dbname": "default",
                "user": "default",
                "sslmode": "prefer",
                "ch_path": "/",
            }
        )
        record = saved["connection"]
        self.assertEqual(record["host"], "ch.example.com")
        self.assertEqual(record["port"], 8443)
        self.assertEqual(record["ch_path"], "/ch")
        self.assertEqual(record["sslmode"], "require")

    async def test_mariadb_flavor_is_stored(self):
        saved = await api.save_connection(
            {
                "kind": "mysql",
                "flavor": "mariadb",
                "name": "Maria",
                "host": "127.0.0.1",
                "port": 3306,
                "dbname": "app",
                "user": "root",
            }
        )
        self.assertEqual(saved["connection"]["flavor"], "mariadb")
        self.assertEqual(api._get(saved["connection"]["id"])["flavor"], "mariadb")

    async def test_clone_connection_keeps_secret(self):
        saved = await api.save_connection(
            {
                "kind": "postgres",
                "name": "Clone me",
                "host": "db.example.com",
                "port": 5432,
                "dbname": "app",
                "user": "app",
                "password": "clonepass",
                "production": True,
                "readonly": True,
            }
        )
        cid = saved["connection"]["id"]
        cloned = (await api.clone_connection(cid))["connection"]
        self.assertNotEqual(cloned["id"], cid)
        self.assertEqual(cloned["name"], "Clone me (copy)")
        self.assertTrue(cloned["production"])
        self.assertTrue(cloned["readonly"])
        self.assertNotIn("password", cloned)
        self.assertEqual(api._get(cloned["id"])["password"], "clonepass")
        self.assertEqual(len(api._load()), 2)

    async def test_clickhouse_headers_are_encrypted(self):
        saved = await api.save_connection(
            {
                "kind": "clickhouse",
                "name": "CH",
                "host": "ch.example.com",
                "port": 443,
                "dbname": "default",
                "user": "default",
                "password": "pw",
                "sslmode": "require",
                "ch_path": "/ch",
                "ch_headers": "CF-Access-Client-Id: id\nCF-Access-Client-Secret: sec",
            }
        )
        public = saved["connection"]
        cid = public["id"]
        self.assertTrue(public["ch_headers_set"])
        self.assertNotIn("ch_headers", public)
        self.assertEqual(
            public["ch_header_names"],
            ["CF-Access-Client-Id", "CF-Access-Client-Secret"],
        )
        self.assertNotIn("sec", json.dumps(public["ch_header_names"]))
        self.assertEqual(public["ch_path"], "/ch")
        raw = (api._store_path()).read_text()
        self.assertNotIn("CF-Access-Client-Secret", raw)
        self.assertIn("ch_headers_enc", json.loads(raw)["connections"][0])

        conn = api._get(cid)
        self.assertIn("CF-Access-Client-Secret: sec", conn["ch_headers"])
        await api.save_connection({**public, "id": cid, "name": "CH renamed"})
        self.assertIn("CF-Access-Client-Secret: sec", api._get(cid)["ch_headers"])

        secure = api._bundle_document(
            [api._load()[0]], True, "correct horse battery", source_ids=True
        )
        data = api._bundle_open(secure["bundle"], "correct horse battery")
        self.assertIn("CF-Access-Client-Secret", data["connections"][0]["ch_headers"])
        plain = api._bundle_document([api._load()[0]], False, "")
        opened = api._bundle_open(plain["bundle"], "")
        self.assertNotIn("ch_headers", opened["connections"][0])

        await api.save_connection(
            {**api._public(api._get(cid)), "id": cid, "ch_headers_clear": True}
        )
        self.assertEqual(api._get(cid)["ch_headers"], "")
        self.assertEqual(api._public(api._get(cid))["ch_header_names"], [])

    def test_plaintext_migration(self):
        path = api._store_path()
        path.write_text(
            json.dumps(
                {
                    "connections": [
                        {
                            "id": "c1",
                            "name": "legacy",
                            "dbname": "db",
                            "user": "u",
                            "password": "plain",
                        }
                    ]
                }
            )
        )
        conns = api._load()
        raw = json.loads(path.read_text())["connections"][0]
        self.assertNotIn("password", raw)
        self.assertEqual(api._decrypt(raw["password_enc"]), "plain")
        self.assertEqual(conns[0]["id"], "c1")

    async def test_merge_safe_update(self):
        first = await api.save_connection(
            {
                "kind": "postgres",
                "name": "PG",
                "group": "prod",
                "host": "127.0.0.1",
                "port": 5432,
                "dbname": "db",
                "user": "u",
                "password": "pw",
                "ssh_host": "example.com",
                "db_labels": {"db": "site.example"},
            }
        )
        cid = first["connection"]["id"]
        await api.save_connection(
            {"id": cid, "kind": "postgres", "name": "PG", "dbname": "db", "user": "u"}
        )
        merged = (await api.list_connections())["connections"][0]
        self.assertEqual(merged["group"], "prod")
        self.assertEqual(merged["ssh_host"], "example.com")
        self.assertEqual(merged["db_labels"], {"db": "site.example"})
        await api.save_connection(
            {"id": cid, "kind": "postgres", "name": "PG", "dbname": "db", "user": "u", "group": ""}
        )
        cleared = (await api.list_connections())["connections"][0]
        self.assertEqual(cleared["group"], "")


# --------------------------------------------------------------------------- #
# SQL builders
# --------------------------------------------------------------------------- #


class TestBuilders(unittest.TestCase):
    def test_update(self):
        sql, is_async = api._build_update(
            conn(), "public", "users", {"id": "1"}, {"name": "O'Reilly"}
        )
        self.assertEqual(
            sql,
            'UPDATE "public"."users" SET "name" = \'O\'\'Reilly\' WHERE "id" = \'1\'',
        )
        self.assertFalse(is_async)

    def test_update_clickhouse_async(self):
        sql, is_async = api._build_update(
            conn("clickhouse"), "db", "t", {"id": "1"}, {"v": "x"}
        )
        self.assertIn("ALTER TABLE `db`.`t` UPDATE", sql)
        self.assertTrue(is_async)

    def test_delete_null_pk(self):
        sql, _ = api._build_delete(conn(), "public", "t", {"id": None})
        self.assertIn('"id" IS NULL', sql)

    def test_insert(self):
        sql, _ = api._build_insert(
            conn("mysql"), "db", "t", {"a": "1", "b": None}
        )
        self.assertEqual(
            sql,
            "INSERT INTO `db`.`t` (`a`, `b`) VALUES ('1', NULL)",
        )

    def test_insert_multi(self):
        sql = api._build_insert_multi(
            conn(), "public", "t", ["a", "b"], [["1", None], ["2", "x"]]
        )
        self.assertEqual(
            sql,
            'INSERT INTO "public"."t" ("a", "b") VALUES\n  (\'1\', NULL),\n  (\'2\', \'x\')',
        )

    def test_sqlite_builders_are_unqualified(self):
        sql, _ = api._build_update(conn("sqlite"), "main", "users", {"id": 1}, {"name": "x"})
        self.assertEqual(sql, 'UPDATE "users" SET "name" = \'x\' WHERE "id" = \'1\'')
        sql, _ = api._build_delete(conn("sqlite"), "main", "users", {"id": 1})
        self.assertEqual(sql, 'DELETE FROM "users" WHERE "id" = \'1\'')
        sql, _ = api._build_insert(conn("sqlite"), "main", "users", {"id": 1})
        self.assertEqual(sql, 'INSERT INTO "users" ("id") VALUES (\'1\')')
        sql = api._build_insert_multi(conn("sqlite"), "main", "t", ["a"], [["1"]])
        self.assertEqual(sql, 'INSERT INTO "t" ("a") VALUES\n  (\'1\')')


# --------------------------------------------------------------------------- #
# query history + views
# --------------------------------------------------------------------------- #


class TestStores(Base):
    async def test_history_dedupe(self):
        conn = self.conn()
        api._record_history(conn, "select 1", {"rows": [], "duration_ms": 5})
        api._record_history(conn, "select 1", {"rows": [], "duration_ms": 6})
        history = api._load_queries()["history"]
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["duration_ms"], 6)

    async def test_saved_queries_endpoints(self):
        saved = await api.save_query(
            {"name": "q1", "sql": "select 1", "connection_id": "c1"}
        )
        self.assertEqual(len((await api.list_saved())["saved"]), 1)
        await api.delete_saved(saved["query"]["id"])
        self.assertEqual((await api.list_saved())["saved"], [])

    async def test_views_endpoints(self):
        saved = await api.save_view(
            {
                "name": "v1",
                "connection_id": "c1",
                "database": "db",
                "schema": "public",
                "table": "t",
                "filters": [{"column": "a", "op": "eq", "value": "1"}],
                "order_by": "a",
                "limit": 50,
            }
        )
        views = (await api.list_views())["views"]
        self.assertEqual(views[0]["name"], "v1")
        await api.delete_view(saved["view"]["id"])
        self.assertEqual((await api.list_views())["views"], [])


# --------------------------------------------------------------------------- #
# SQLite (local file)
# --------------------------------------------------------------------------- #


class TestSqlite(Base):
    def setUp(self) -> None:
        super().setUp()
        import sqlite3

        self.path = str(self.home / "app.db")
        db = sqlite3.connect(self.path)
        db.executescript(
            """
            CREATE TABLE users (
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL,
              age INTEGER
            );
            CREATE INDEX idx_users_name ON users(name);
            CREATE VIEW adults AS SELECT * FROM users WHERE age >= 18;
            INSERT INTO users (name, age) VALUES ('Ali', 30), ('Siti', 17), ('ali baba', 40);
            """
        )
        db.commit()
        db.close()
        self.writable = self.conn(
            "sqlite", dbname=self.path, readonly=False, port=0, host="", user="sqlite"
        )
        self.readonly = {**self.writable, "readonly": True}

    def test_metadata(self):
        server = api._test(self.writable)
        self.assertIn("SQLite", server["version"])
        self.assertEqual(server["user"], "sqlite")

        tree = {row["name"]: row for row in api._tree(self.writable)}
        self.assertEqual(tree["users"]["kind"], "table")
        self.assertEqual(tree["users"]["schema"], "main")
        self.assertEqual(tree["adults"]["kind"], "view")

        columns = api._columns(self.writable, "main", "users")
        self.assertEqual([column["name"] for column in columns], ["id", "name", "age"])
        self.assertTrue(columns[0]["pk"])
        self.assertFalse(columns[0]["nullable"])
        self.assertFalse(columns[1]["nullable"])

        indexes = api._indexes(self.writable, "main", "users")
        self.assertEqual(indexes[0]["name"], "idx_users_name")
        self.assertEqual(indexes[0]["columns"], "name")

        self.assertIn("CREATE TABLE users", api._ddl(self.writable, "main", "users"))

    def test_rows_and_case_insensitive_filter(self):
        result = api._rows(
            self.readonly, "main", "users", 10, 0, "id", "ASC",
            [{"column": "name", "op": "contains", "value": "ALI"}],
        )
        self.assertEqual([row[1] for row in result["rows"]], ["Ali", "ali baba"])

        page = api._rows(self.readonly, "main", "users", 2, 0, "id", "ASC")
        self.assertTrue(page["truncated"])
        self.assertEqual(len(page["rows"]), 2)

    def test_query_and_readonly_guard(self):
        result = api._query(self.readonly, "select name, age from users order by id", 10, True)
        self.assertEqual(result["rows"][0], ["Ali", 30])
        self.assertEqual(result["command"], "SELECT")
        with self.assertRaises(HTTPException) as ctx:
            api._query(self.readonly, "delete from users", 10, True)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_mutations(self):
        insert = api._build_insert(self.writable, "main", "users", {"name": "Abu", "age": 22})[0]
        api._mutation(self.writable, {}, insert, False, "insert")
        update = api._build_update(self.writable, "main", "users", {"name": "Abu"}, {"age": 23})[0]
        api._mutation(self.writable, {}, update, False, "update")
        self.assertIn(23, [row[2] for row in api._rows(self.writable, "main", "users", 10, 0, "id", "ASC")["rows"]])
        delete = api._build_delete(self.writable, "main", "users", {"name": "Abu"})[0]
        api._mutation(self.writable, {}, delete, False, "delete")
        self.assertNotIn("Abu", [row[1] for row in api._rows(self.writable, "main", "users", 10, 0, "id", "ASC")["rows"]])

    def test_bulk_exec_is_transactional(self):
        api._sqlite_exec(
            self.writable,
            ["DELETE FROM users WHERE id = 1", "DELETE FROM users WHERE id = 2"],
        )
        rows = api._rows(self.writable, "main", "users", 10, 0, "id", "ASC")["rows"]
        self.assertEqual(len(rows), 1)

    def test_missing_file(self):
        ghost = {**self.readonly, "dbname": str(self.home / "nope.db")}
        with self.assertRaises(HTTPException) as ctx:
            api._test(ghost)
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_save_connection_defaults(self):
        saved = await api.save_connection(
            {"kind": "sqlite", "name": "Local", "dbname": "~/app.db"}
        )
        record = saved["connection"]
        self.assertEqual(record["host"], "")
        self.assertEqual(record["port"], 0)
        self.assertEqual(record["user"], "sqlite")
        self.assertEqual(record["ssh_host"], "")
        self.assertTrue(record["readonly"])
        self.assertTrue(record["dbname"].endswith("/app.db"))
        self.assertEqual((await api.connection_databases(record["id"]))["databases"], [{"name": "main", "label": ""}])




# --------------------------------------------------------------------------- #
# AI harness
# --------------------------------------------------------------------------- #


class TestAi(Base):
    def setUp(self) -> None:
        super().setUp()
        api._save_ai_config(
            {
                "base_url": "https://example.invalid/v1",
                "model": "test",
                "api_key_enc": api._encrypt("sk-test"),
            }
        )

    async def test_plan_only(self):
        completion = {
            "choices": [
                {"message": {"content": '{"sql":"select 1 as one","explanation":"one"}'}}
            ]
        }
        with mock.patch.object(api, "_connect", lambda cid: self.conn("postgres")), \
             mock.patch.object(api, "_ai_schema_context", lambda *a, **k: ""), \
             mock.patch.object(api, "_ai_post", lambda *a, **k: completion):
            result = await api.ai_ask(
                {"connection_id": "c1", "question": "one", "execute": False}
            )
        self.assertEqual(result["sql"], "select 1 as one")
        self.assertEqual(result["explanation"], "one")

    def test_context_matches_singular_table_names(self):
        tables = [
            {"schema": "public", "name": "push_settings", "kind": "table", "est_rows": 0},
            {"schema": "public", "name": "purchases", "kind": "table", "est_rows": 0},
        ]
        columns = {
            "push_settings": [{"name": "created_at", "type": "timestamptz"}],
            "purchases": [
                {"name": "created_on", "type": "timestamptz"},
                {"name": "amount", "type": "numeric"},
            ],
        }

        with mock.patch.object(api, "_tree", return_value=tables), \
             mock.patch.object(api, "_columns", side_effect=lambda c, s, t: columns[t]):
            context = api._ai_schema_context(
                self.conn("postgres"), "public", "push_settings", "berapa purchase hari ni"
            )

        self.assertIn("purchases", context)
        self.assertIn("created_on", context)

    async def test_ask_payload_has_no_connection_secret(self):
        saved = await api.save_connection(
            {
                "kind": "postgres",
                "name": "secret-db",
                "host": "db.example.com",
                "port": 5432,
                "dbname": "app",
                "user": "app",
                "password": "sup3rsecret",
            }
        )
        cid = saved["connection"]["id"]
        captured = {}

        def fake(config, payload):
            captured.update(payload)
            return {"choices": [{"message": {"content": '{"sql":"select 1","explanation":"x"}'}}]}

        with mock.patch.object(api, "_connect", lambda cid: api._get(cid)), \
             mock.patch.object(api, "_ai_schema_context", lambda *a, **k: ""), \
             mock.patch.object(api, "_ai_post", side_effect=fake):
            await api.ai_ask({"connection_id": cid, "question": "users?", "execute": False})

        payload = json.dumps(captured)
        self.assertNotIn("sup3rsecret", payload)
        self.assertNotIn("password", payload.lower())

    async def test_ai_setup_sanitizes_secrets(self):
        captured = {}

        def fake(config, payload):
            captured.update(payload)
            return {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "answer": "Use this.",
                                    "draft": {
                                        "kind": "mysql",
                                        "host": "db.example.com",
                                        "port": "3306",
                                        "password": "sup3rsecret",
                                        "http_headers": "Authorization: Bearer x",
                                        "tunnel_env": "AWS_SECRET_ACCESS_KEY=x",
                                    },
                                }
                            )
                        }
                    }
                ]
            }

        with mock.patch.object(api, "_ai_post", side_effect=fake):
            result = await api.ai_setup({"question": "connect to mysql"})

        self.assertEqual(result["draft"]["host"], "db.example.com")
        self.assertEqual(result["draft"]["port"], 3306)
        self.assertNotIn("password", result["draft"])
        self.assertNotIn("http_headers", result["draft"])
        self.assertNotIn("tunnel_env", result["draft"])
        self.assertNotIn("sup3rsecret", json.dumps(result))
        self.assertNotIn("sup3rsecret", json.dumps(captured))

    async def test_answer_without_sql(self):
        completion = {
            "choices": [{"message": {"content": '{"answer":"Hello!","sql":""}'}}]
        }
        with mock.patch.object(api, "_connect", lambda cid: self.conn("postgres")), \
             mock.patch.object(api, "_ai_schema_context", lambda *a, **k: ""), \
             mock.patch.object(api, "_ai_post", return_value=completion), \
             mock.patch.object(api, "_ai_run") as run:
            result = await api.ai_ask({"connection_id": "c1", "question": "hello"})
        self.assertEqual(result["sql"], "")
        self.assertEqual(result["explanation"], "Hello!")
        run.assert_not_called()

    async def test_history_is_forwarded(self):
        captured = {}

        def fake(config, payload):
            captured.update(payload)
            return {
                "choices": [
                    {"message": {"content": '{"sql":"select 1","explanation":"ok"}'}}
                ]
            }

        with mock.patch.object(api, "_connect", lambda cid: self.conn("postgres")), \
             mock.patch.object(api, "_ai_schema_context", lambda *a, **k: ""), \
             mock.patch.object(api, "_ai_post", side_effect=fake):
            await api.ai_ask(
                {
                    "connection_id": "c1",
                    "question": "pecahkan ikut bulan",
                    "execute": False,
                    "history": [
                        {"role": "user", "content": "berapa purchase"},
                        {"role": "assistant", "content": '{"sql":"select count(*) from purchases"}'},
                    ],
                }
            )

        contents = [message["content"] for message in captured["messages"]]
        self.assertIn("berapa purchase", contents)
        self.assertTrue(any("select count(*) from purchases" in text for text in contents))
        self.assertEqual(contents[-1], "pecahkan ikut bulan")

    async def test_refuses_non_read(self):
        completion = {
            "choices": [
                {"message": {"content": '{"sql":"delete from users","explanation":"bad"}'}}
            ]
        }
        with mock.patch.object(api, "_connect", lambda cid: self.conn("postgres")), \
             mock.patch.object(api, "_ai_schema_context", lambda *a, **k: ""), \
             mock.patch.object(api, "_ai_post", lambda *a, **k: completion):
            with self.assertRaises(HTTPException) as ctx:
                await api.ai_ask({"connection_id": "c1", "question": "bad", "execute": False})
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("non-read", str(ctx.exception.detail))


# --------------------------------------------------------------------------- #
# multi-database agent
# --------------------------------------------------------------------------- #


class TestMultiDbAgent(Base):
    def setUp(self) -> None:
        super().setUp()
        api._save_ai_config(
            {
                "base_url": "https://example.invalid/v1",
                "model": "test",
                "api_key_enc": api._encrypt("sk-test"),
            }
        )

    async def _save(self, name: str, kind: str = "postgres", **over) -> str:
        body = {
            "kind": kind,
            "name": name,
            "host": "db.example.com",
            "port": 5432,
            "dbname": name,
            "user": "app",
            "password": "sup3rsecret",
        }
        if kind == "mysql":
            body["port"] = 3306
        body.update(over)
        saved = await api.save_connection(body)
        return saved["connection"]["id"]

    async def test_catalog_lists_enabled_and_flags(self):
        first = await self._save("app")
        second = await self._save("analytics", kind="mysql", ai_query=False)
        await self._save("private", ai_schema=False)

        catalog = (await api.ai_catalog())["connections"]
        ids = [entry["id"] for entry in catalog]
        self.assertIn(first, ids)
        self.assertIn(second, ids)
        self.assertEqual(len(catalog), 2)
        entry = next(item for item in catalog if item["id"] == second)
        self.assertFalse(entry["query"])
        self.assertNotIn("host", entry)
        self.assertNotIn("user", entry)
        self.assertNotIn("sup3rsecret", json.dumps(catalog))

    async def test_describe_then_local_join(self):
        first = await self._save("app")
        second = await self._save("analytics", kind="mysql")
        responses = [
            {"action": "describe", "requests": [{"connection": second, "tables": ["events"]}]},
            {
                "action": "run",
                "sources": [
                    {"connection": first, "sql": "select email from users"},
                    {"connection": second, "sql": "select email from events"},
                ],
                "join_sql": (
                    "select distinct src_0.email from src_0 "
                    "join src_1 on src_0.email = src_1.email"
                ),
                "explanation": "Users present in both systems.",
            },
        ]
        posted = []

        def fake(config, payload):
            posted.append(payload)
            return {
                "choices": [{"message": {"content": json.dumps(responses[len(posted) - 1])}}]
            }

        def source(conn, sql):
            rows = [["a@x"], ["b@x"]] if conn["id"] == first else [["b@x"]]
            return {
                "connection": conn["id"],
                "name": conn["name"],
                "kind": api._kind(conn),
                "sql": sql,
                "columns": [{"name": "email", "type": "text"}],
                "rows": rows,
                "truncated": False,
                "duration_ms": 2,
            }

        with mock.patch.object(api, "_ai_post", side_effect=fake), \
             mock.patch.object(api, "_ai_describe", return_value="COLUMNS events.email text"), \
             mock.patch.object(api, "_ai_agent_source", side_effect=source):
            result = api._ai_agent(
                {
                    "question": "who is in both?",
                    "connection_ids": [first, second],
                    "connection_id": first,
                }
            )

        self.assertEqual(result["rows"], [["b@x"]])
        self.assertEqual(len(result["sources"]), 2)
        self.assertTrue(result["join_sql"])
        self.assertIn("inspected analytics", result["steps"])
        second = json.dumps(posted[1])
        self.assertNotIn("a@x", second)
        self.assertNotIn("b@x", second)
        prompt = json.dumps(posted[0])
        self.assertIn("analytics", prompt)
        self.assertIn(first, prompt)
        self.assertNotIn("sup3rsecret", prompt)
        self.assertNotIn("db.example.com", prompt)

    async def test_inspect_only_connection_cannot_run(self):
        first = await self._save("app")
        await self._save("warehouse", ai_query=False)
        plan = {
            "action": "run",
            "sources": [{"connection": "missing", "sql": "select 1"}],
            "explanation": "x",
        }
        conns = (await api.list_connections())["connections"]
        warehouse = next(c["id"] for c in conns if c["name"] == "warehouse")
        plan["sources"] = [{"connection": warehouse, "sql": "select 1 as one"}]
        completion = {"choices": [{"message": {"content": json.dumps(plan)}}]}

        with mock.patch.object(api, "_ai_post", return_value=completion):
            with self.assertRaises(HTTPException) as ctx:
                api._ai_agent(
                    {"question": "one", "connection_ids": [first, warehouse], "connection_id": first}
                )
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("inspect-only", str(ctx.exception.detail))

    async def test_empty_scope_is_refused(self):
        first = await self._save("app")
        completion = {"choices": [{"message": {"content": '{"action":"answer","answer":"hi"}'}}]}
        with mock.patch.object(api, "_ai_post", return_value=completion):
            with self.assertRaises(HTTPException) as ctx:
                api._ai_agent({"question": "hi", "connection_ids": [], "connection_id": first})
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("AI-enabled", str(ctx.exception.detail))

    async def test_local_join_matches_numeric_affinity(self):
        left = {
            "columns": [{"name": "id", "type": "integer"}, {"name": "name", "type": "text"}],
            "rows": [[5, "a"], [6, "b"]],
        }
        right = {
            "columns": [{"name": "id", "type": "varchar"}, {"name": "plan", "type": "varchar"}],
            "rows": [["5", "pro"]],
        }
        result = api._ai_local_join(
            [left, right],
            "select src_0.name, src_1.plan from src_0 join src_1 on src_0.id = src_1.id",
        )
        self.assertEqual(result["rows"], [["a", "pro"]])
        self.assertEqual([column["name"] for column in result["columns"]], ["name", "plan"])

    def test_local_join_rejects_writes(self):
        left = {"columns": [{"name": "id", "type": "integer"}], "rows": [[1]]}
        with self.assertRaises(HTTPException) as ctx:
            api._ai_local_join([left], "delete from src_0")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_unique_columns(self):
        names = api._ai_unique_names(
            [{"name": "id"}, {"name": "id"}, {"name": "id"}, {"name": "name"}]
        )
        self.assertEqual(names, ["id", "id_2", "id_3", "name"])


# --------------------------------------------------------------------------- #
# connection bundles
# --------------------------------------------------------------------------- #


class TestBundles(Base):
    async def _save(self) -> str:
        saved = await api.save_connection(
            {
                "kind": "postgres",
                "name": "Imported PG",
                "host": "127.0.0.1",
                "port": 5432,
                "dbname": "demo",
                "user": "u",
                "password": "secret",
                "readonly": True,
            }
        )
        return saved["connection"]["id"]

    async def test_roundtrip_with_secrets(self):
        conn_id = await self._save()
        exported = await api.export_connections(
            {"ids": [conn_id], "include_secrets": True, "passphrase": "correct horse"}
        )
        self.assertTrue(exported["encrypted"])
        self.assertEqual(exported["count"], 1)

        with self.assertRaises(HTTPException):
            await api.import_connections(
                {"bundle": exported["bundle"], "passphrase": "wrong", "preview": True}
            )

        preview = await api.import_connections(
            {"bundle": exported["bundle"], "passphrase": "correct horse", "preview": True}
        )
        self.assertEqual(preview["count"], 1)
        self.assertTrue(preview["connections"][0]["has_password"])

        await api.delete_connection(conn_id)
        result = await api.import_connections(
            {"bundle": exported["bundle"], "passphrase": "correct horse"}
        )
        self.assertEqual(result["added"], 1)
        rows = (await api.list_connections())["connections"]
        self.assertEqual(len(rows), 1)
        record = api._get(rows[0]["id"])
        self.assertEqual(record["name"], "Imported PG")
        self.assertEqual(record["password"], "secret")
        self.assertTrue(record["readonly"])

    async def test_export_without_secrets(self):
        conn_id = await self._save()
        exported = await api.export_connections({"ids": [conn_id], "include_secrets": False})
        self.assertFalse(exported["encrypted"])
        self.assertNotIn("secret", exported["bundle"])
        result = await api.import_connections({"bundle": exported["bundle"]})
        self.assertEqual(result["added"], 1)
        rows = (await api.list_connections())["connections"]
        self.assertEqual(len(rows), 2)

    async def test_requires_passphrase_for_secrets(self):
        conn_id = await self._save()
        with self.assertRaises(HTTPException):
            await api.export_connections(
                {"ids": [conn_id], "include_secrets": True, "passphrase": "short"}
            )


# --------------------------------------------------------------------------- #
# endpoints
# --------------------------------------------------------------------------- #


class TestEndpoints(Base):
    async def test_connection_requires_db(self):
        with self.assertRaises(HTTPException) as ctx:
            await api.save_connection({"name": "x"})
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_test_connection_mocked(self):
        await api.save_connection(
            {
                "kind": "postgres",
                "name": "PG",
                "host": "127.0.0.1",
                "port": 5432,
                "dbname": "db",
                "user": "u",
                "password": "pw",
            }
        )
        cid = (await api.list_connections())["connections"][0]["id"]
        with mock.patch.object(api, "_test", return_value={"version": "16"}):
            result = await api.test_connection({"id": cid})
        self.assertEqual(result["server"]["version"], "16")

    async def test_query_passes_readonly(self):
        conn = self.conn(readonly=True)
        calls = {}

        def fake_query(conn_arg, sql, limit, readonly):
            calls.update(sql=sql, limit=limit, readonly=readonly)
            return {"columns": [], "rows": [], "truncated": False, "duration_ms": 1}

        with mock.patch.object(api, "_connect", lambda cid: dict(conn)):
            with mock.patch.object(api, "_query", side_effect=fake_query):
                await api.run_query({"connection_id": "c1", "sql": "select 1"})
        self.assertTrue(calls["readonly"])

    async def test_mutation_preview_does_not_run(self):
        conn = self.conn()
        body = {
            "connection_id": "c1",
            "schema": "public",
            "table": "t",
            "pk": {"id": "1"},
            "changes": {"a": "2"},
        }
        with mock.patch.object(api, "_connect", lambda cid: dict(conn)):
            with mock.patch.object(api, "_run_mutation") as run:
                preview = await api.update_row({**body, "preview": True})
                run.assert_not_called()
                self.assertIn("UPDATE", preview["sql"])
                await api.update_row(body)
                run.assert_called_once()

    async def test_read_only_refuses_preview(self):
        conn = self.conn(readonly=True)
        with mock.patch.object(api, "_connect", lambda cid: dict(conn)):
            with self.assertRaises(HTTPException) as ctx:
                await api.update_row(
                    {
                        "connection_id": "c1",
                        "schema": "public",
                        "table": "t",
                        "pk": {"id": "1"},
                        "changes": {"a": "2"},
                        "preview": True,
                    }
                )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_import_preview_and_validation(self):
        conn = self.conn()
        body = {
            "connection_id": "c1",
            "schema": "public",
            "table": "t",
            "columns": ["a", "b"],
            "rows": [["1", None], ["2", "x"]],
        }
        with mock.patch.object(api, "_connect", lambda cid: dict(conn)):
            preview = await api.import_rows({**body, "preview": True})
            self.assertEqual(preview["rows"], 2)
            self.assertIn("INSERT INTO", preview["sql"])
            with self.assertRaises(HTTPException):
                await api.import_rows({**body, "rows": [["only-one"]]})
            with self.assertRaises(HTTPException):
                await api.import_rows({**body, "rows": [["1", "2"]] * 5001})

    async def test_alter_rename_preview(self):
        conn = self.conn()
        with mock.patch.object(api, "_connect", lambda cid: dict(conn)):
            result = await api.alter_table(
                {
                    "connection_id": "c1",
                    "schema": "public",
                    "table": "t",
                    "action": "rename_column",
                    "name": "old",
                    "new_name": "new",
                    "preview": True,
                }
            )
        self.assertEqual(
            result["sql"], 'ALTER TABLE "public"."t" RENAME COLUMN "old" TO "new";'
        )

    async def test_index_rejects_clickhouse(self):
        conn = self.conn("clickhouse")
        with mock.patch.object(api, "_connect", lambda cid: dict(conn)):
            with self.assertRaises(HTTPException) as ctx:
                await api.table_index(
                    {
                        "connection_id": "c1",
                        "schema": "db",
                        "table": "t",
                        "action": "create",
                        "name": "idx",
                        "columns": ["a"],
                    }
                )
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_index_create_sql(self):
        conn = self.conn()
        with mock.patch.object(api, "_connect", lambda cid: dict(conn)):
            result = await api.table_index(
                {
                    "connection_id": "c1",
                    "schema": "public",
                    "table": "t",
                    "action": "create",
                    "name": "idx",
                    "columns": ["a", "b"],
                    "unique": True,
                    "preview": True,
                }
            )
        self.assertEqual(
            result["sql"], 'CREATE UNIQUE INDEX "idx" ON "public"."t" ("a", "b");'
        )


# --------------------------------------------------------------------------- #
# MCP + audit
# --------------------------------------------------------------------------- #


class TestMcpAndAudit(Base):
    def test_mcp_table_shapes(self):
        columns, rows = api._mcp_table([{"id": 1, "name": "A"}, {"id": 2, "name": "B"}])
        self.assertEqual([column["name"] for column in columns], ["id", "name"])
        self.assertEqual(rows, [[1, "A"], [2, "B"]])

        columns, rows = api._mcp_table({"columns": [{"name": "a"}], "rows": [[1]]})
        self.assertEqual(columns, [{"name": "a"}])
        self.assertEqual(rows, [[1]])

        columns, rows = api._mcp_table("| id | name |\n|---|---|\n| 1 | A |")
        self.assertEqual([column["name"] for column in columns], ["id", "name"])
        self.assertEqual(rows, [["1", "A"]])

    def test_mcp_allowlist_gate(self):
        with mock.patch.object(api, "_mcp_allowlist", return_value=[]):
            with self.assertRaises(HTTPException) as ctx:
                api._mcp_call({"mcp_server": "demo", "mcp_tool": "query"}, "select 1")
        self.assertEqual(ctx.exception.status_code, 403)

    def test_mcp_query_and_readonly_guard(self):
        conn = self.conn("mcp", mcp_server="demo", mcp_dialect="postgres", readonly=True)
        with mock.patch.object(api, "_mcp_call", return_value=[{"n": 1}]):
            result = api._query(conn, "select 1", 10, True)
        self.assertEqual(result["rows"], [[1]])
        with self.assertRaises(HTTPException) as ctx:
            api._query(conn, "delete from t", 10, True)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_audit_log(self):
        conn = self.conn(production=False)
        api._audit(conn, "update", "UPDATE t SET a = 1")
        api._audit(conn, "delete", "DELETE FROM t", rows=1)
        entries = api._read_audit(10)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["action"], "delete")
        self.assertEqual(entries[0]["rows"], 1)


# --------------------------------------------------------------------------- #
# transports (custom tunnel + HTTP gateway)
# --------------------------------------------------------------------------- #


class TestTransports(Base):
    def test_http_headers_parse(self):
        headers = api._http_headers(
            {
                "http_headers": "# comment\nCF-Access-Client-Id: abc\n"
                "CF-Access-Client-Secret: def\nMalformed\n"
            }
        )
        self.assertEqual(
            headers, {"CF-Access-Client-Id": "abc", "CF-Access-Client-Secret": "def"}
        )

    def test_http_query_sends_headers(self):
        connection = conn(
            "http",
            http_url="https://gw.example/query",
            http_method="POST",
            http_sql_field="sql",
            http_headers="CF-Access-Client-Id: abc",
            http_headers_raw="",
            http_dialect="postgres",
        )
        connection["http_headers"] = "CF-Access-Client-Id: abc"
        seen = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"columns":[{"name":"n"}],"rows":[[1]]}'

        def fake_urlopen(request, timeout=0, context=None):
            seen["url"] = request.full_url
            seen["headers"] = {key.lower(): value for key, value in request.header_items()}
            seen["data"] = request.data
            return Response()

        with mock.patch.object(api.urllib.request, "urlopen", side_effect=fake_urlopen):
            result = api._http_query(connection, "select 1", 10)
        self.assertEqual(result["rows"], [[1]])
        self.assertEqual(seen["url"], "https://gw.example/query")
        self.assertEqual(seen["headers"]["cf-access-client-id"], "abc")
        self.assertIn(b"select 1", seen["data"])

    def test_http_clickhouse_raw_body(self):
        connection = conn(
            "http",
            http_url="https://cloud.example:8443/?default_format=JSON",
            http_method="POST",
            http_body_mode="raw",
            http_headers="CF-Access-Client-Id: abc",
            http_dialect="clickhouse",
            http_sql_field="sql",
        )
        connection["http_headers"] = "CF-Access-Client-Id: abc"
        seen = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"meta":[{"name":"n","type":"UInt8"}],"data":[{"n":1}]}'

        def fake_urlopen(request, timeout=0, context=None):
            seen["data"] = request.data
            seen["headers"] = {key.lower(): value for key, value in request.header_items()}
            return Response()

        with mock.patch.object(api.urllib.request, "urlopen", side_effect=fake_urlopen):
            result = api._http_query(connection, "select 1", 10)
        self.assertEqual(result["columns"], [{"name": "n", "type": "UInt8"}])
        self.assertEqual(result["rows"], [[1]])
        self.assertEqual(seen["data"], b"select 1")
        self.assertIn("text/plain", seen["headers"]["content-type"])

    async def test_http_requires_url(self):
        with self.assertRaises(HTTPException) as ctx:
            await api.save_connection(
                {"kind": "http", "name": "GW", "dbname": "app", "mcp_server": ""}
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_command_tunnel_requires_port(self):
        with self.assertRaises(HTTPException) as ctx:
            api._command_tunnel({"id": "t", "host": "127.0.0.1", "port": 0, "tunnel_command": "true"})
        self.assertEqual(ctx.exception.status_code, 400)


# --------------------------------------------------------------------------- #
# approvals + bulk delete
# --------------------------------------------------------------------------- #


class TestApprovals(Base):
    async def test_production_write_needs_approval(self):
        conn = self.conn(production=True, readonly=False)
        api._save([conn])
        body = {
            "connection_id": "c1",
            "schema": "public",
            "table": "t",
            "pk": {"id": "1"},
            "changes": {"a": "1"},
        }
        with mock.patch.object(api, "_connect", lambda cid: dict(conn)):
            with mock.patch.object(api, "_run_mutation"):
                with self.assertRaises(HTTPException) as ctx:
                    await api.update_row(body)
                self.assertEqual(ctx.exception.status_code, 403)

                preview = await api.update_row({**body, "preview": True})
                with mock.patch.object(api, "_approval_notice"):
                    approval = (
                        await api.create_approval(
                            {
                                "connection_id": "c1",
                                "sql": preview["sql"],
                                "action": "update",
                                "schema": "public",
                                "table": "t",
                            }
                        )
                    )["approval"]
                await api.decide_approval(approval["id"], {"decision": "approve"})
                result = await api.update_row({**body, "approval_id": approval["id"]})
                self.assertTrue(result["ok"])
                with self.assertRaises(HTTPException):
                    await api.update_row({**body, "approval_id": approval["id"]})

    async def test_bulk_delete_preview(self):
        conn = self.conn(readonly=False)
        api._save([conn])
        with mock.patch.object(api, "_connect", lambda cid: dict(conn)):
            result = await api.delete_rows_bulk(
                {
                    "connection_id": "c1",
                    "schema": "public",
                    "table": "t",
                    "pks": [{"id": "1"}, {"id": "2"}],
                    "preview": True,
                }
            )
        self.assertEqual(result["rows"], 2)
        self.assertIn("DELETE FROM", result["sql"])


# --------------------------------------------------------------------------- #
# agent tools
# --------------------------------------------------------------------------- #


class TestAgent(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("dbdesk_agent", PLUGIN / "__init__.py")
        cls.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.mod)
        cls.tools = {}

        class Ctx:
            def register_tool(self, **kwargs):
                cls.tools[kwargs["name"]] = kwargs["handler"]

        cls.mod.register(Ctx())

    def setUp(self):
        self.mod._API = mock.Mock()

    def test_tools_registered(self):
        self.assertEqual(set(self.tools), {"db_connections", "db_query"})

    def test_connections(self):
        self.mod._API._load.return_value = [
            {
                "id": "c1",
                "name": "PG",
                "kind": "postgres",
                "dbname": "db",
                "readonly": True,
                "production": True,
                "group": "prod",
            }
        ]
        payload = json.loads(self.tools["db_connections"]({}))
        self.assertEqual(payload["connections"][0]["id"], "c1")
        self.assertNotIn("password", payload["connections"][0])

    def test_query_success(self):
        self.mod._API._connect.return_value = {"id": "c1", "readonly": True}
        self.mod._API._check_sql.side_effect = lambda sql: sql
        self.mod._API.READ_SQL = re.compile(r"^(select|with)\b", re.I)
        self.mod._API._query.return_value = {
            "columns": [{"name": "n"}],
            "rows": [["1"]],
            "truncated": False,
            "duration_ms": 2,
        }
        payload = json.loads(
            self.tools["db_query"]({"connection_id": "c1", "sql": "select 1"})
        )
        self.assertEqual(payload["rows"], [["1"]])

    def test_query_refuses_write(self):
        self.mod._API._connect.return_value = {"id": "c1"}
        self.mod._API._check_sql.side_effect = lambda sql: sql
        self.mod._API.READ_SQL = re.compile(r"^(select|with)\b", re.I)
        payload = json.loads(
            self.tools["db_query"]({"connection_id": "c1", "sql": "delete from t"})
        )
        self.assertIn("read-only", payload["error"])

    def test_query_requires_args(self):
        payload = json.loads(self.tools["db_query"]({}))
        self.assertIn("required", payload["error"])


# --------------------------------------------------------------------------- #
# MongoDB / Redis adapters (optional drivers)
# --------------------------------------------------------------------------- #

try:  # pragma: no cover - optional test dependencies
    import mongomock  # noqa: E402
except Exception:
    mongomock = None

try:  # pragma: no cover - optional test dependencies
    import fakeredis  # noqa: E402
except Exception:
    fakeredis = None


@unittest.skipIf(mongomock is None, "mongomock is not installed")
class TestMongo(Base):
    def setUp(self) -> None:
        super().setUp()
        self.mongo = mongomock.MongoClient()
        self.mongo.db.users.insert_many(
            [
                {"name": "Ali", "age": 30, "tags": ["a"]},
                {"name": "Siti", "age": 25},
            ]
        )
        self.record = self.conn(
            "mongodb",
            dbname="db",
            host="127.0.0.1",
            port=27017,
            user="u",
            readonly=False,
        )
        self.patch = mock.patch.object(api, "_mongo_client", lambda record: self.mongo)
        self.patch.start()

    def tearDown(self) -> None:
        self.patch.stop()
        super().tearDown()

    def test_tree_columns_indexes(self):
        tree = api._mongo_tree(self.record)
        self.assertEqual([row["name"] for row in tree], ["users"])
        columns = api._mongo_columns(self.record, "db", "users")
        self.assertEqual(columns[0]["name"], "_id")
        self.assertTrue(columns[0]["pk"])
        self.assertEqual(
            [row["name"] for row in api._mongo_indexes(self.record, "db", "users")], ["_id_"]
        )

    def test_rows_filter_and_query(self):
        rows = api._mongo_rows(
            self.record,
            "db",
            "users",
            10,
            0,
            "age",
            "asc",
            [{"mode": "column", "column": "name", "op": "contains", "value": "li"}],
        )
        index = [column["name"] for column in rows["columns"]].index("name")
        self.assertEqual([row[index] for row in rows["rows"]], ["Ali"])

        result = api._mongo_query(
            self.record,
            json.dumps({"collection": "users", "find": {"age": {"$gt": 26}}}),
            10,
            True,
        )
        index = [column["name"] for column in result["columns"]].index("name")
        self.assertEqual([row[index] for row in result["rows"]], ["Ali"])

    def test_writes_and_production_approval(self):
        inserted = api._mongo_insert_documents(
            self.record, {"collection": "users", "document": {"name": "Abu", "age": 40}}
        )
        self.assertEqual(inserted["inserted"], 1)
        updated = api._mongo_update_documents(
            self.record,
            {"collection": "users", "filter": {"name": "Abu"}, "changes": {"age": 41}},
        )
        self.assertEqual(updated["modified"], 1)
        deleted = api._mongo_delete_documents(
            self.record, {"collection": "users", "filter": {"name": "Abu"}}
        )
        self.assertEqual(deleted["deleted"], 1)

        production = self.conn(production=True)
        with self.assertRaises(HTTPException) as ctx:
            api._mongo_update_documents(
                production,
                {"collection": "users", "filter": {"name": "Ali"}, "changes": {"age": 31}},
            )
        self.assertEqual(ctx.exception.status_code, 403)


@unittest.skipIf(fakeredis is None, "fakeredis is not installed")
class TestRedis(Base):
    def setUp(self) -> None:
        super().setUp()
        self.redis = fakeredis.FakeRedis(decode_responses=False)
        self.redis.set("user:1", "Ali")
        self.redis.hset("user:2", mapping={"name": "Siti"})
        self.redis.rpush("list:1", "a", "b")
        self.record = self.conn("redis", dbname="0", host="127.0.0.1", port=6379, redis_db=0)
        self.patch = mock.patch.object(
            api, "_redis_client", lambda record, database=None: self.redis
        )
        self.patch.start()

    def tearDown(self) -> None:
        self.patch.stop()
        super().tearDown()

    def test_tree_and_rows(self):
        tree = api._redis_tree(self.record)
        self.assertEqual(tree[0]["name"], "keys")
        rows = api._redis_rows(self.record, "db0", "keys", 10, 0, "", "", None)
        self.assertEqual(
            sorted(row[0] for row in rows["rows"]), ["list:1", "user:1", "user:2"]
        )
        self.assertEqual([column["name"] for column in rows["columns"]], ["key", "type", "ttl", "size"])

    def test_commands_and_guard(self):
        result = api._redis_query(self.record, "HGETALL user:2", 10, True)
        self.assertEqual(result["rows"], [["name", "Siti"]])
        with self.assertRaises(HTTPException) as ctx:
            api._redis_query(self.record, "SET nope 1", 10, True)
        self.assertEqual(ctx.exception.status_code, 403)
        written = api._redis_command_write(self.record, {"command": "SET greeting hello"})
        self.assertTrue(written["ok"])
        self.assertEqual(self.redis.get("greeting"), b"hello")




class TestColumnFeatures(Base):
    def test_public_hides_decryption_key(self):
        record = self.conn(decrypt_key_enc=api._encrypt("super-secret"), decrypt_columns="card")
        public = api._public(record)
        self.assertTrue(public["decrypt_key_set"])
        self.assertNotIn("decrypt_key", public)
        self.assertNotIn("decrypt_key_enc", public)

    def test_decrypts_gcm_envelope(self):
        import base64
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        key = b"0123456789abcdef0123456789abcdef"
        iv = os.urandom(12)
        ciphertext = AESGCM(key).encrypt(iv, b"123-456-789", None)
        envelope = json.dumps(
            {
                "p": base64.b64encode(ciphertext).decode(),
                "h": {"iv": base64.b64encode(iv).decode()},
            }
        )
        self.assertEqual(api._decrypt_payload(envelope, [key], "auto"), "123-456-789")

    def test_timezone_filter_conversion(self):
        conn = {"display_tz": "Asia/Kuala_Lumpur", "storage_tz": "UTC"}
        sql = api._where_clause(
            "postgres",
            [
                {
                    "mode": "column",
                    "column": "created_at",
                    "op": "eq",
                    "value": "2023-05-23 15:05:34.863445",
                }
            ],
            [{"name": "created_at", "type": "timestamp without time zone"}],
            conn,
        )
        self.assertIn("2023-05-23 07:05:34.863445", sql)

    def test_apply_decryption_rows(self):
        import base64
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        key = b"0123456789abcdef0123456789abcdef"
        iv = os.urandom(12)
        ciphertext = AESGCM(key).encrypt(iv, b"4111", None)
        envelope = json.dumps(
            {
                "p": base64.b64encode(ciphertext).decode(),
                "h": {"iv": base64.b64encode(iv).decode()},
            }
        )
        record = self.conn(
            decrypt_key_enc=api._encrypt(key.decode()),
            decrypt_columns="card",
        )
        result = api._apply_decryption(
            record,
            {"columns": [{"name": "card", "type": "varchar"}], "rows": [[envelope]]},
        )
        self.assertEqual(result["decrypted_rows"], [["4111"]])
        self.assertEqual(result["decrypted_columns"], ["card"])




class TestMcpInspect(Base):
    def _tools(self):
        def tool(name, description, properties=None):
            return {
                "name": name,
                "description": description,
                "inputSchema": {"type": "object", "properties": properties or {}},
            }

        return [
            tool("orders_query", "Run a read-only SQL query against the orders database.", {"sql": {}}),
            tool("orders_list_databases", "List Postgres database names visible on the orders server."),
            tool("blog_query", "Run a read-only SQL query against the blog database.", {"sql": {}}),
            tool("blog_list_databases", "List MySQL databases the blog endpoint can see."),
            tool("events_query", "Run a read-only SQL query against the ClickHouse database.", {"query": {}}),
            tool("events_list_databases", "List ClickHouse databases the events endpoint can see."),
            tool("list_tables", "List tables in a database.", {"database": {}}),
        ]

    def test_detects_query_tools(self):
        with mock.patch.object(api, "_mcp_tools", lambda url: self._tools()):
            result = api._mcp_inspect("https://mcp.example.com/mcp")
        names = [item["name"] for item in result["query_tools"]]
        self.assertIn("orders_query", names)
        self.assertIn("blog_query", names)
        self.assertIn("events_query", names)
        self.assertNotIn("list_tables", names)
        by_name = {item["name"]: item for item in result["query_tools"]}
        self.assertEqual(by_name["orders_query"]["sql_arg"], "sql")
        self.assertEqual(by_name["orders_query"]["dialect"], "postgres")
        self.assertEqual(by_name["blog_query"]["dialect"], "mysql")
        self.assertEqual(by_name["events_query"]["dialect"], "clickhouse")
        self.assertEqual(by_name["events_query"]["sql_arg"], "query")
        self.assertEqual(result["tool_count"], 7)



# --------------------------------------------------------------------------- #
# AI model discovery + autocomplete
# --------------------------------------------------------------------------- #


class TestAiComplete(Base):
    def setUp(self) -> None:
        super().setUp()
        api._save_ai_config(
            {
                "base_url": "https://example.invalid/v1",
                "model": "test",
                "api_key_enc": api._encrypt("sk-test"),
                "ai_complete": True,
            }
        )

    async def test_models_lists_and_sorts(self):
        payload = {"data": [{"id": "b-model"}, {"id": "a-model"}, "c-model"]}
        with mock.patch.object(api, "_mcp_http_json", return_value=payload) as http:
            result = await api.ai_models(
                {"base_url": "https://example.invalid/v1", "api_key": "sk-x"}
            )
        self.assertEqual(result["models"], ["a-model", "b-model", "c-model"])
        self.assertTrue(http.call_args.args[0].endswith("/v1/models"))

    async def test_models_requires_a_key(self):
        api._save_ai_config(
            {"base_url": "https://example.invalid/v1", "model": "test", "api_key_enc": ""}
        )
        with self.assertRaises(HTTPException) as ctx:
            await api.ai_models({"base_url": "https://example.invalid/v1", "api_key": ""})
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_complete_requires_opt_in(self):
        api._save_ai_config(
            {
                "base_url": "https://example.invalid/v1",
                "model": "test",
                "api_key_enc": api._encrypt("sk-test"),
                "ai_complete": False,
            }
        )
        with self.assertRaises(HTTPException) as ctx:
            await api.ai_complete(
                {"connection_id": "c1", "sql": "select * from t", "caret": 4}
            )
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_complete_returns_first_line(self):
        completion = {"choices": [{"message": {"content": "```sql\ncountry\n```"}}]}
        with mock.patch.object(api, "_connect", lambda cid: self.conn("sqlite")), \
             mock.patch.object(api, "_ai_complete_context", lambda *a, **k: "Dialect: sqlite"), \
             mock.patch.object(api, "_ai_post", lambda *a, **k: completion):
            result = await api.ai_complete(
                {
                    "connection_id": "c1",
                    "sql": "select * from customers where ",
                    "caret": 27,
                }
            )
        self.assertEqual(result["suggestion"], "country")

    async def test_autocomplete_defaults_to_on(self):
        path = api._ai_path()
        if path.exists():
            path.unlink()
        status = await api.ai_config()
        self.assertTrue(status["ai_complete"])

    async def test_config_roundtrip_keeps_opt_in(self):
        saved = await api.ai_config_save(
            {"base_url": "https://example.invalid/v1", "model": "m", "ai_complete": True}
        )
        self.assertTrue(saved["ai_complete"])
        status = await api.ai_config()
        self.assertTrue(status["ai_complete"])


if __name__ == "__main__":
    unittest.main()
