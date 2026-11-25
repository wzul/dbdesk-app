"""MCP tool auto-detection (no network)."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("DBDESK_HOME", tempfile.mkdtemp(prefix="dbdesk-mcp-inspect-"))
os.environ.setdefault("DBDESK_NO_NOTIFY", "1")

import dbdesk_api as api  # noqa: E402


def tool(name: str, description: str, properties: dict | None = None) -> dict:
    return {
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": properties or {}},
    }


TOOLS = [
    tool("orders_query", "Run a read-only SQL query against the orders database.", {"sql": {"type": "string"}}),
    tool("orders_list_databases", "List Postgres database names visible on the orders server."),
    tool("orders_describe_table", "Describe a table in the orders database.", {"table": {}}),
    tool("blog_query", "Run a read-only SQL query against the blog database.", {"sql": {"type": "string"}}),
    tool("blog_list_databases", "List MySQL databases the blog endpoint can see."),
    tool("events_query", "Run a read-only SQL query against the ClickHouse database.", {"query": {"type": "string"}}),
    tool("events_list_databases", "List ClickHouse databases the events endpoint can see."),
    tool("list_tables", "List tables in a database.", {"database": {}}),
    tool("get_balance", "Get the account credit balance."),
]


class McpInspect(unittest.TestCase):
    def test_detects_postgres_query_tool(self) -> None:
        api._mcp_tools = lambda url: TOOLS
        result = api._mcp_inspect("https://mcp.example.com/mcp")
        self.assertIn("orders_query", [item["name"] for item in result["query_tools"]])
        orders = next(item for item in result["query_tools"] if item["name"] == "orders_query")
        self.assertEqual(orders["sql_arg"], "sql")
        self.assertEqual(orders["dialect"], "postgres")
        self.assertEqual(orders["database"], "orders")
        self.assertIn(
            result["suggested"]["name"],
            [item["name"] for item in result["query_tools"]],
        )
        self.assertEqual(result["suggested"]["sql_arg"], "sql")
        self.assertNotIn("list_tables", [item["name"] for item in result["query_tools"]])
        self.assertNotIn("orders_list_databases", [item["name"] for item in result["query_tools"]])

    def test_detects_mysql_and_clickhouse(self) -> None:
        api._mcp_tools = lambda url: TOOLS
        result = api._mcp_inspect("https://mcp.example.com/mcp")
        by_name = {item["name"]: item for item in result["query_tools"]}
        self.assertEqual(by_name["blog_query"]["dialect"], "mysql")
        self.assertEqual(by_name["events_query"]["dialect"], "clickhouse")
        self.assertEqual(by_name["events_query"]["sql_arg"], "query")

    def test_tool_metadata_for_datalist(self) -> None:
        api._mcp_tools = lambda url: TOOLS
        result = api._mcp_inspect("https://mcp.example.com/mcp")
        names = [item["name"] for item in result["tools"]]
        self.assertIn("orders_query", names)
        self.assertEqual(result["tool_count"], len(TOOLS))


if __name__ == "__main__":
    unittest.main()
