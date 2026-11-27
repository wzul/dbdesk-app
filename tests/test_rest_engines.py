"""REST engines: Elasticsearch, InfluxDB 3, Cloudflare D1 and libSQL.

None of these has a driver, so the only thing that can be wrong is the request shape and the
JSON parsing — which is exactly what a mock server proves. The payloads below are copied
from each API (cat indices, _search hits, InfluxDB query_sql rows, D1's result[0].results,
libSQL's pipeline {type,value} cells), because a parser tested against an invented shape
passes here and then fails in front of a user.
"""

import http.server
import json
import pathlib
import sys
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import rest_kinds  # noqa: E402

from fastapi import HTTPException  # noqa: E402


class _Handler(http.server.BaseHTTPRequestHandler):
    """One server for every test: each test installs a responder(method, path, body)."""

    responder = None
    seen: list = []

    def log_message(self, fmt, *args):
        return

    def _handle(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else None
        type(self).seen.append({
            "method": method, "path": self.path.split("?")[0], "body": body,
            "auth": self.headers.get("Authorization"),
        })
        if type(self).responder is None:
            status, payload = 404, {"error": "no responder"}
        else:
            status, payload = type(self).responder(method, self.path.split("?")[0], body)
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


class RestEngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        _Handler.responder = None
        _Handler.seen = []

    def conn(self, kind, **extra):
        return {"kind": kind, "host": "127.0.0.1", "port": self.port,
                "readonly": True, **extra}

    def routes(self, mapping):
        def respond(method, path, body):
            key = (method, path)
            if key not in mapping:
                return 404, {"error": f"no route {method} {path}"}
            return 200, mapping[key]

        _Handler.responder = respond

    # ----------------------------------------------------------------- Elasticsearch

    def elastic(self):
        self.routes({
            ("GET", "/"): {"version": {"number": "9.2.4"}, "cluster_name": "dbdesk"},
            ("GET", "/_cat/indices"): [
                {"index": "orders", "docs.count": "17", "health": "green"},
                {"index": ".kibana", "docs.count": "1", "health": "green"},
            ],
            ("GET", "/orders/_mapping"): {"orders": {"mappings": {"properties": {
                "id": {"type": "integer"},
                "customer": {"type": "text"},
                "total": {"type": "scaled_float"},
            }}}},
            ("POST", "/orders/_search"): {"hits": {"hits": [
                {"_id": "1", "_source": {"id": 1, "customer": "ada", "total": 120.5}},
                {"_id": "2", "_source": {"id": 2, "customer": "grace", "total": 40.0}},
            ]}},
            ("POST", "/_sql"): {
                "columns": [{"name": "status", "type": "keyword"},
                            {"name": "n", "type": "long"}],
                "rows": [["paid", 2], ["pending", 1]],
            },
        })

    def test_elasticsearch_test_and_basic_auth(self):
        self.elastic()
        info = rest_kinds.es_test(self.conn("elasticsearch", user="elastic", password="pw"))
        self.assertIn("Elasticsearch 9.2.4", info["version"])
        self.assertEqual(_Handler.seen[0]["auth"], "Basic ZWxhc3RpYzpwdw==")

    def test_elasticsearch_tree_hides_system_indices(self):
        self.elastic()
        nodes = rest_kinds.es_tree(self.conn("elasticsearch"))
        self.assertEqual([node["name"] for node in nodes], ["orders"])
        self.assertEqual(nodes[0]["est_rows"], 17)

    def test_elasticsearch_columns_and_rows(self):
        self.elastic()
        columns = rest_kinds.es_columns(self.conn("elasticsearch"), "indices", "orders")
        self.assertEqual([column["name"] for column in columns], ["id", "customer", "total"])
        page = rest_kinds.es_rows(self.conn("elasticsearch"), "indices", "orders", 10, 0,
                                  None, "ASC")
        self.assertEqual(page["rows"][0][0], 1)
        self.assertIn("_id", [column["name"] for column in page["columns"]])
        body = [entry for entry in _Handler.seen if entry["path"] == "/orders/_search"][0]["body"]
        self.assertEqual(body["size"], 11, "ask for one row more than the page, to detect truncation")

    def test_elasticsearch_query_uses_the_sql_endpoint(self):
        self.elastic()
        result = rest_kinds.es_query(
            self.conn("elasticsearch"),
            "SELECT status, count(*) FROM orders GROUP BY status", 100, True)
        self.assertEqual(result["rows"][0], ["paid", 2])

    def test_elasticsearch_refuses_a_write_when_read_only(self):
        self.elastic()
        with self.assertRaises(HTTPException) as ctx:
            rest_kinds.es_query(self.conn("elasticsearch"), "DELETE FROM orders", 10, True)
        self.assertEqual(ctx.exception.status_code, 403)

    # ----------------------------------------------------------------- InfluxDB 3

    def influx(self):
        answers = {
            "SHOW TABLES": [
                {"table_catalog": "dbdesk", "table_schema": "iox", "table_name": "cpu",
                 "table_type": "BASE TABLE"},
                {"table_catalog": "dbdesk", "table_schema": "iox", "table_name": "orders",
                 "table_type": "BASE TABLE"},
            ],
            'SHOW COLUMNS FROM "cpu"': [
                {"column_name": "time", "data_type": "timestamp", "is_nullable": "NO"},
                {"column_name": "host", "data_type": "varchar", "is_nullable": "YES"},
                {"column_name": "usage", "data_type": "double", "is_nullable": "YES"},
            ],
            'SELECT * FROM "cpu" ORDER BY "time" ASC LIMIT 11 OFFSET 0': [
                {"time": "2026-01-01T00:00:00Z", "host": "web-1", "usage": 12.5},
                {"time": "2026-01-01T00:01:00Z", "host": "web-2", "usage": 9.0},
            ],
        }

        def respond(method, path, body):
            if path == "/health":
                return 200, {"status": "pass", "version": "3.4.0"}
            if path == "/api/v3/query_sql":
                statement = (body or {}).get("q", "")
                if statement in answers:
                    return 200, answers[statement]
                return 200, []
            return 404, {"error": f"no route {path}"}

        _Handler.responder = respond

    def test_influx_test_tree_columns_rows(self):
        self.influx()
        conn = self.conn("influxdb3", dbname="dbdesk", password="token-123")
        info = rest_kinds.influx_test(conn)
        self.assertIn("3.4.0", info["version"])
        nodes = rest_kinds.influx_tree(conn)
        self.assertEqual([node["name"] for node in nodes], ["cpu", "orders"])
        columns = rest_kinds.influx_columns(conn, "iox", "cpu")
        self.assertEqual([column["name"] for column in columns], ["time", "host", "usage"])
        self.assertTrue(columns[0]["primary"])
        page = rest_kinds.influx_rows(conn, "iox", "cpu", 10, 0, None, "ASC")
        self.assertEqual(page["rows"][0][1], "web-1")
        self.assertTrue(any(entry["auth"] == "Bearer token-123" for entry in _Handler.seen))

    # ----------------------------------------------------------------- Cloudflare D1

    def d1(self):
        account, database = "acct-uuid", "db-uuid"
        base = f"/client/v4/accounts/{account}/d1/database/{database}/query"

        def respond(method, path, body):
            if path != base:
                return 404, {"error": f"no route {path}"}
            sql = (body or {}).get("sql", "")
            if "sqlite_master where type in" in sql:
                rows = [{"name": "orders", "type": "table"}, {"name": "v_paid", "type": "view"}]
            elif "pragma table_info" in sql:
                rows = [{"cid": 0, "name": "id", "type": "INTEGER", "notnull": 1,
                         "dflt_value": None, "pk": 1}]
            elif "sqlite_version" in sql:
                rows = [{"version": "3.48.0"}]
            elif "count(*) as n from sqlite_master" in sql:
                rows = [{"n": 2}]
            elif "sqlite_master where name" in sql:
                rows = [{"sql": "CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)"}]
            else:
                rows = [{"id": 1, "total": 120.5}, {"id": 2, "total": 40.0}]
            return 200, {"success": True, "result": [{"results": rows}], "errors": []}

        _Handler.responder = respond
        return account, database

    def test_d1_url_shapes_and_rows(self):
        account, database = self.d1()
        conn = self.conn("d1", user=account, dbname=database, password="cf-token")
        info = rest_kinds.d1_test(conn)
        self.assertIn("SQLite 3.48.0", info["version"])
        nodes = rest_kinds.d1_tree(conn)
        self.assertEqual([node["name"] for node in nodes], ["orders", "v_paid"])
        self.assertEqual(nodes[1]["kind"], "view")
        columns = rest_kinds.d1_columns(conn, "main", "orders")
        self.assertTrue(columns[0]["primary"])
        self.assertIn("CREATE TABLE orders", rest_kinds.d1_ddl(conn, "main", "orders"))
        page = rest_kinds.d1_rows(conn, "main", "orders", 10, 0, "id", "ASC")
        self.assertEqual(page["rows"][0][0], 1)
        self.assertEqual(page["columns"][0]["name"], "id")
        self.assertTrue(any(entry["auth"] == "Bearer cf-token" for entry in _Handler.seen))

    def test_d1_needs_account_and_database(self):
        with self.assertRaises(HTTPException) as ctx:
            rest_kinds.d1_tree(self.conn("d1", user="", dbname=""))
        self.assertEqual(ctx.exception.status_code, 400)

    # ----------------------------------------------------------------- libSQL

    def test_libsql_pipeline_cells_become_values(self):
        def respond(method, path, body):
            if path != "/v2/pipeline":
                return 404, {"error": f"no route {path}"}
            sql = ((body or {}).get("requests") or [{}])[0].get("stmt", {}).get("sql", "")
            if "sqlite_master where type in" in sql:
                cols = [{"name": "name"}, {"name": "type"}]
                rows = [[{"type": "text", "value": "orders"},
                         {"type": "text", "value": "table"}]]
            elif "pragma table_info" in sql:
                cols = [{"name": "name"}, {"name": "type"}, {"name": "notnull"},
                        {"name": "dflt_value"}, {"name": "pk"}]
                rows = [[{"type": "text", "value": "id"},
                         {"type": "text", "value": "INTEGER"},
                         {"type": "integer", "value": "1"},
                         {"type": "null"},
                         {"type": "integer", "value": "1"}]]
            else:
                cols = [{"name": "id"}, {"name": "total"}]
                rows = [[{"type": "integer", "value": "1"},
                         {"type": "float", "value": 120.5}]]
            return 200, {"results": [
                {"type": "ok", "response": {"type": "execute",
                                            "result": {"cols": cols, "rows": rows,
                                                       "affected_row_count": 0}}},
                {"type": "ok", "response": {"type": "close"}},
            ]}

        _Handler.responder = respond
        conn = {"kind": "libsql", "host": f"http://127.0.0.1:{self.port}",
                "password": "turso-token", "readonly": True}
        nodes = rest_kinds.libsql_tree(conn)
        self.assertEqual(nodes[0]["name"], "orders")
        columns = rest_kinds.libsql_columns(conn, "main", "orders")
        self.assertEqual(columns[0]["type"], "INTEGER")
        page = rest_kinds.libsql_rows(conn, "main", "orders", 10, 0, "id", "ASC")
        # libSQL returns {type, value}; the grid needs the value, with the right Python type.
        self.assertEqual(page["rows"], [[1, 120.5]])
        self.assertEqual(page["columns"][0]["type"], "BIGINT")
        self.assertEqual(_Handler.seen[0]["path"], "/v2/pipeline")
        self.assertEqual(_Handler.seen[0]["auth"], "Bearer turso-token")

    def test_libsql_scheme_rewrite(self):
        url = rest_kinds._libsql_url({"host": "libsql://db-desks.turso.io"})
        self.assertEqual(url, "https://db-desks.turso.io/v2/pipeline")

    # ----------------------------------------------------------------- shared behaviour

    def test_every_rest_engine_refuses_writes_read_only(self):
        for kind in ("d1", "libsql", "influxdb3", "elasticsearch"):
            with self.subTest(kind=kind):
                with self.assertRaises(HTTPException) as ctx:
                    rest_kinds._guard(self.conn(kind), "update t set x = 1")
                self.assertEqual(ctx.exception.status_code, 403)

    def test_a_connection_error_names_the_engine(self):
        conn = {"kind": "elasticsearch", "host": "127.0.0.1", "port": 1, "readonly": True}
        with self.assertRaises(HTTPException) as ctx:
            rest_kinds.es_test(conn)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("Elasticsearch", str(ctx.exception.detail))

    def test_error_bodies_are_reduced_to_the_useful_sentence(self):
        self.assertEqual(
            rest_kinds._explain({"error": {"type": "index_not_found_exception",
                                           "reason": "no such index [orders]"}}, 404),
            "no such index [orders]",
        )
        self.assertEqual(
            rest_kinds._explain({"errors": [{"message": "bad token"}]}, 403), "bad token")
        self.assertEqual(rest_kinds._explain({"raw": "oops"}, 500), "oops")

    def test_api_http_error_reason_surfaces(self):
        _Handler.responder = lambda method, path, body: (401, {"error": "invalid api key"})
        with self.assertRaises(HTTPException) as ctx:
            rest_kinds.es_tree(self.conn("elasticsearch"))
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertEqual(str(ctx.exception.detail), "invalid api key")


if __name__ == "__main__":
    unittest.main()
