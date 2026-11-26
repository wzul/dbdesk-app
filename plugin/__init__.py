"""DB Desk — agent half.

Read-only tools over the same connections the UI uses. The desktop/webapp half
is ``desktop/plugin.js``; the HTTP backend is ``dashboard/plugin_api.py``.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

_API = None


def _api():
    """Load the HTTP backend module once (it owns the connection store/dialects)."""
    global _API
    if _API is None:
        path = Path(__file__).parent / "dashboard" / "plugin_api.py"
        spec = importlib.util.spec_from_file_location("dbdesk_api", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _API = module
    return _API


def _safe(value: Any) -> Any:
    if value is None or isinstance(value, (int, float, bool)):
        return value
    text = str(value)
    return text if len(text) <= 2000 else text[:2000] + "…"


def _connections(params, **kwargs):
    del params, kwargs
    api = _api()
    rows = []
    for conn in api._load():
        rows.append(
            {
                "id": conn.get("id"),
                "name": conn.get("name"),
                "kind": conn.get("kind", "postgres"),
                "database": conn.get("dbname"),
                "group": conn.get("group", ""),
                "readonly": bool(conn.get("readonly", True)),
                "production": bool(conn.get("production", False)),
                "ssh": bool(conn.get("ssh_host")),
                "tunnel": bool(conn.get("tunnel_command") or conn.get("ssh_host")),
            }
        )
    return json.dumps({"connections": rows}, indent=2)


def _query(params, **kwargs):
    del kwargs
    api = _api()
    connection_id = str(params.get("connection_id") or "").strip()
    sql = str(params.get("sql") or "").strip()
    try:
        limit = max(1, min(int(params.get("limit") or 50), 200))
    except (TypeError, ValueError):
        limit = 50
    if not connection_id or not sql:
        return json.dumps({"error": "connection_id and sql are required"})
    try:
        conn = api._connect(connection_id)
        sql = api._check_sql(sql)
        if not api.READ_SQL.match(sql):
            return json.dumps(
                {"error": "read-only tool: only SELECT / WITH / SHOW / EXPLAIN statements are allowed"}
            )
        result = api._query(conn, sql, limit, True)
    except Exception as exc:  # HTTPException or dialect error
        return json.dumps({"error": str(getattr(exc, "detail", exc))})

    columns = [column.get("name") for column in result.get("columns") or []]
    rows = [[_safe(value) for value in row] for row in result.get("rows") or []]
    return json.dumps(
        {
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "truncated": bool(result.get("truncated")),
            "duration_ms": result.get("duration_ms", 0),
        },
        indent=2,
    )


def register(ctx):
    ctx.register_tool(
        name="db_connections",
        toolset="dbdesk",
        schema={
            "name": "db_connections",
            "description": (
                "List the database connections configured in DB Desk (id, name, kind, "
                "database, read-only, production). Secrets are never returned."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
        handler=_connections,
    )
    ctx.register_tool(
        name="db_query",
        toolset="dbdesk",
        schema={
            "name": "db_query",
            "description": (
                "Run a READ-ONLY SQL query against a DB Desk connection and return columns "
                "and rows. Only SELECT/WITH/SHOW/EXPLAIN are accepted; writes are refused."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "connection_id": {
                        "type": "string",
                        "description": "Connection id from db_connections.",
                    },
                    "sql": {"type": "string", "description": "A single read-only SQL statement."},
                    "limit": {
                        "type": "integer",
                        "description": "Maximum rows to return (default 50, max 200).",
                    },
                },
                "required": ["connection_id", "sql"],
            },
        },
        handler=_query,
    )
