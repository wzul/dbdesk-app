"""Standalone server smoke tests (no display, no database server required)."""

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

os.environ.setdefault("DBDESK_HOME", tempfile.mkdtemp(prefix="dbdesk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

import app as standalone  # noqa: E402
import mcp_gateway  # noqa: E402


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


class McpServer(unittest.TestCase):
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
        mcp_gateway._save_config({"enabled": False, "allow_writes": True, "token": ""})

    def tearDown(self) -> None:
        mcp_gateway._save_config({"enabled": False, "allow_writes": True, "token": ""})
        os.unlink(self.db_path)

    def add_connection(self, readonly: bool = True) -> str:
        response = self.client.post(
            "/api/connections",
            json={
                "kind": "sqlite",
                "name": f"mcp-{'ro' if readonly else 'rw'}",
                "dbname": self.db_path,
                "readonly": readonly,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["connection"]["id"]

    def enable(self, allow_writes: bool = True) -> str:
        response = self.client.post(
            "/api/mcp/status", json={"enabled": True, "allow_writes": allow_writes}
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertTrue(data["enabled"])
        self.assertTrue(data["token"])
        return data["token"]

    def rpc(self, payload, token: str = ""):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return self.client.post("/mcp", json=payload, headers=headers)

    def call_tool(self, token: str, name: str, arguments: dict | None = None):
        response = self.rpc(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            },
            token,
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["result"]

    def test_disabled_and_auth(self) -> None:
        status = self.client.get("/api/mcp/status").json()
        self.assertFalse(status["enabled"])
        self.assertEqual(status["token"], "")
        self.assertEqual(self.rpc({"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code, 403)

        token = self.enable()
        self.assertEqual(self.rpc({"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code, 401)
        self.assertEqual(
            self.rpc({"jsonrpc": "2.0", "id": 1, "method": "ping"}, "wrong").status_code, 401
        )
        response = self.rpc({"jsonrpc": "2.0", "id": 1, "method": "ping"}, token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["result"], {})

    def test_initialize_and_tools(self) -> None:
        token = self.enable()
        response = self.rpc(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-03-26"},
            },
            token,
        )
        init = response.json()["result"]
        self.assertEqual(init["protocolVersion"], "2025-03-26")
        self.assertEqual(init["serverInfo"]["name"], "dbdesk")
        self.assertIn("tools", init["capabilities"])

        listing = self.rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, token)
        names = {tool["name"] for tool in listing.json()["result"]["tools"]}
        self.assertTrue(
            {"connections_list", "tables_list", "query", "ask_data", "table_rows"} <= names
        )

        notification = self.rpc(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}, token
        )
        self.assertEqual(notification.status_code, 204)

    def test_query_and_writes(self) -> None:
        token = self.enable(allow_writes=True)
        ro = self.add_connection(readonly=True)
        rw = self.add_connection(readonly=False)

        result = self.call_tool(
            token, "query", {"connection_id": ro, "sql": "select name from people order by id"}
        )
        self.assertFalse(result["isError"])
        payload = json.loads(result["content"][0]["text"])
        self.assertEqual([row[0] for row in payload["rows"]], ["Ali", "Siti"])

        refused = self.call_tool(token, "query", {"connection_id": ro, "sql": "delete from people"})
        self.assertTrue(refused["isError"])

        written = self.call_tool(
            token,
            "query",
            {"connection_id": rw, "sql": "insert into people(name) values ('Abu')"},
        )
        self.assertFalse(written["isError"])
        check = self.call_tool(
            token,
            "query",
            {"connection_id": rw, "sql": "select count(*) from people"},
        )
        self.assertEqual(json.loads(check["content"][0]["text"])["rows"][0][0], 3)

    def test_writes_toggle_and_connections_hide_secrets(self) -> None:
        token = self.enable(allow_writes=False)
        rw = self.add_connection(readonly=False)

        refused = self.call_tool(
            token,
            "query",
            {"connection_id": rw, "sql": "insert into people(name) values ('Nope')"},
        )
        self.assertTrue(refused["isError"])
        self.assertIn("writes are disabled", refused["content"][0]["text"])

        listing = self.call_tool(token, "connections_list")
        text = listing["content"][0]["text"]
        self.assertIn("mcp-rw", text)
        self.assertNotIn("password", text.lower())

    def test_table_rows_and_rotate(self) -> None:
        token = self.enable()
        cid = self.add_connection(readonly=True)
        rows = self.call_tool(
            token,
            "table_rows",
            {"connection_id": cid, "schema": "main", "table": "people", "limit": 5},
        )
        self.assertFalse(rows["isError"])
        self.assertEqual(len(json.loads(rows["content"][0]["text"])["rows"]), 2)

        rotated = self.client.post("/api/mcp/token/rotate").json()["token"]
        self.assertNotEqual(rotated, token)
        self.assertEqual(
            self.rpc({"jsonrpc": "2.0", "id": 1, "method": "ping"}, token).status_code, 401
        )
        self.assertEqual(
            self.rpc({"jsonrpc": "2.0", "id": 1, "method": "ping"}, rotated).status_code, 200
        )


if __name__ == "__main__":
    unittest.main()
