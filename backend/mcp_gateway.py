"""MCP server for DB Desk.

The standalone app exposes its own capabilities over the Model Context Protocol
so a local agent (Claude Desktop, Cursor, Hermes, ...) can drive it.

Two transports share one implementation:

- ``POST /mcp`` — JSON-RPC 2.0 over Streamable HTTP, authenticated with a
  bearer token generated when the server is enabled in Settings.
- ``dbdesk-server mcp`` — a stdlib-only stdio bridge that proxies JSON-RPC to
  the running app (see ``mcp_stdio.py``).

The server listens only on the app's loopback socket. Tokens and runtime
metadata live in ``<app home>/data/mcp.json`` and ``runtime.json`` (mode 0600).
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
import sys
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

import dbdesk_api as api

APP_NAME = "DB Desk"
DEFAULT_PORT = 8765
PROTOCOL_VERSION = "2025-03-26"

runtime_router = APIRouter()
protocol_router = APIRouter()

_LOCK = threading.Lock()
_PORT = int(os.environ.get("PORT") or os.environ.get("DBDESK_PORT") or DEFAULT_PORT)
_VERSION = os.environ.get("DBDESK_VERSION") or "dev"


class ToolError(Exception):
    """A tool failed for an expected reason (bad argument, guard refusal)."""


# --------------------------------------------------------------------------- #
# storage
# --------------------------------------------------------------------------- #


def _home() -> Path:
    override = os.environ.get("DBDESK_HOME")
    if override:
        return Path(override)
    return Path.home() / "Library" / "Application Support" / APP_NAME


def _data_dir() -> Path:
    root = _home() / "data"
    root.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(root, 0o700)
    except OSError:
        pass
    return root


def _config_path() -> Path:
    return _data_dir() / "mcp.json"


def _runtime_path() -> Path:
    return _data_dir() / "runtime.json"


def _load_config() -> dict[str, Any]:
    try:
        value = json.loads(_config_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        value = {}
    return {
        "enabled": bool(value.get("enabled", False)),
        "allow_writes": bool(value.get("allow_writes", True)),
        "token": str(value.get("token") or ""),
    }


def _save_config(config: dict[str, Any]) -> None:
    path = _config_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(config, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _new_token() -> str:
    return secrets.token_urlsafe(32)


def set_runtime(port: int, version: str = "") -> None:
    """Called by app.py once the HTTP port is known."""
    global _PORT, _VERSION
    _PORT = int(port)
    if version:
        _VERSION = version
    path = _runtime_path()
    payload = {
        "port": _PORT,
        "pid": os.getpid(),
        "version": _VERSION,
        "updated_at": time.time(),
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _stdio_config() -> dict[str, Any]:
    if getattr(sys, "frozen", False):
        command = sys.executable
        args = ["mcp"]
    else:
        command = sys.executable
        args = [str(Path(__file__).resolve().with_name("app.py")), "mcp"]
    env: dict[str, str] = {}
    override = os.environ.get("DBDESK_HOME")
    if override:
        env["DBDESK_HOME"] = override
    entry: dict[str, Any] = {"command": command, "args": args}
    if env:
        entry["env"] = env
    return {"mcpServers": {"dbdesk": entry}}


def _http_config(token: str) -> dict[str, Any]:
    return {
        "mcpServers": {
            "dbdesk": {
                "url": f"http://127.0.0.1:{_PORT}/mcp",
                "headers": {"Authorization": f"Bearer {token}"},
            }
        }
    }


def _status() -> dict[str, Any]:
    config = _load_config()
    token = config["token"]
    return {
        "enabled": config["enabled"],
        "allow_writes": config["allow_writes"],
        "tools": len(TOOL_SPECS),
        "endpoint": f"http://127.0.0.1:{_PORT}/mcp",
        "token": token if config["enabled"] else "",
        "token_hint": f"…{token[-4:]}" if token else "",
        "stdio": _stdio_config(),
        "http": _http_config(token) if token else {},
        "home": str(_home()),
    }


# --------------------------------------------------------------------------- #
# tools
# --------------------------------------------------------------------------- #


def _rows_brief(result: dict[str, Any], cap: int = 500) -> dict[str, Any]:
    rows = result.get("rows") or []
    return {
        "columns": result.get("columns") or [],
        "rows": rows[:cap],
        "truncated": bool(result.get("truncated")) or len(rows) > cap,
        "duration_ms": result.get("duration_ms", 0),
    }


async def _connections_list(args: dict[str, Any]) -> dict[str, Any]:
    out = []
    for conn in api._load():
        public = api._public(conn)
        out.append(
            {
                "id": public.get("id", ""),
                "name": public.get("name", ""),
                "group": public.get("group", ""),
                "kind": public.get("kind", "postgres"),
                "database": public.get("dbname", ""),
                "readonly": bool(public.get("readonly", True)),
                "production": bool(public.get("production", False)),
                "ai_schema": bool(public.get("ai_schema", True)),
                "ai_query": bool(public.get("ai_query", True)),
            }
        )
    return {"connections": out}


async def _databases_list(args: dict[str, Any]) -> dict[str, Any]:
    conn_id = _required(args, "connection_id")
    return await api.connection_databases(conn_id)


async def _tables_list(args: dict[str, Any]) -> dict[str, Any]:
    conn_id = _required(args, "connection_id")
    tree = await api.connection_tree(conn_id, str(args.get("database") or ""))
    schema = str(args.get("schema") or "")
    if schema:
        tree = {
            "schemas": [row for row in tree.get("schemas", []) if row.get("name") == schema]
        }
    return tree


async def _table_columns(args: dict[str, Any]) -> dict[str, Any]:
    return await api.table_columns(
        _required(args, "connection_id"),
        _required(args, "schema"),
        _required(args, "table"),
        str(args.get("database") or ""),
    )


async def _table_indexes(args: dict[str, Any]) -> dict[str, Any]:
    return await api.table_indexes(
        _required(args, "connection_id"),
        _required(args, "schema"),
        _required(args, "table"),
        str(args.get("database") or ""),
    )


async def _table_ddl(args: dict[str, Any]) -> dict[str, Any]:
    return await api.table_ddl(
        _required(args, "connection_id"),
        _required(args, "schema"),
        _required(args, "table"),
        str(args.get("database") or ""),
    )


async def _table_rows(args: dict[str, Any]) -> dict[str, Any]:
    body = {
        "connection_id": _required(args, "connection_id"),
        "schema": _required(args, "schema"),
        "table": _required(args, "table"),
        "database": str(args.get("database") or ""),
        "limit": _int(args.get("limit"), 100, 1, 500),
        "offset": _int(args.get("offset"), 0, 0, 1_000_000),
        "order_by": str(args.get("order_by") or ""),
        "order_dir": str(args.get("order_dir") or "asc"),
        "filters": args.get("filters") if isinstance(args.get("filters"), list) else [],
    }
    return _rows_brief(await api.table_rows(body))


async def _table_csv(args: dict[str, Any]) -> dict[str, Any]:
    result = await api.table_csv(
        _required(args, "connection_id"),
        _required(args, "schema"),
        _required(args, "table"),
        str(args.get("database") or ""),
        _int(args.get("limit"), 2000, 1, 20000),
    )
    return {
        "filename": result.get("filename", ""),
        "rows": result.get("rows", 0),
        "truncated": bool(result.get("truncated")),
        "csv": result.get("csv", ""),
    }


async def _query(args: dict[str, Any]) -> dict[str, Any]:
    conn_id = _required(args, "connection_id")
    database = str(args.get("database") or "")
    limit = _int(args.get("limit"), 200, 1, api.MAX_ROWS)
    conn = api._with_db(api._connect(conn_id), database)
    sql = api._check_sql(str(args.get("sql") or ""))
    readonly = bool(conn.get("readonly", True))
    config = _load_config()
    if not readonly and not config.get("allow_writes", True):
        raise ToolError(
            "writes are disabled; enable 'Allow writes' in DB Desk → Settings → MCP server"
        )
    if readonly and not api.READ_SQL.match(sql):
        raise ToolError("this connection is read-only: only SELECT/WITH/SHOW/EXPLAIN is allowed")
    started = time.monotonic()
    try:
        result = api._query(conn, sql, limit, readonly)
    except HTTPException as exc:
        api._audit(conn, "mcp_query", sql, ok=False, error=str(exc.detail), notify=False)
        raise ToolError(str(exc.detail)) from exc
    api._audit(
        conn,
        "mcp_query",
        sql,
        rows=len(result.get("rows") or []),
        ok=True,
        notify=not readonly and bool(conn.get("production")),
    )
    return {
        "columns": result.get("columns") or [],
        "rows": (result.get("rows") or [])[:limit],
        "truncated": bool(result.get("truncated")),
        "command": result.get("command", ""),
        "readonly": readonly,
        "duration_ms": result.get("duration_ms")
        or round((time.monotonic() - started) * 1000),
    }


async def _ask_data(args: dict[str, Any]) -> dict[str, Any]:
    question = str(args.get("question") or "").strip()
    if not question:
        raise ToolError("question is required")
    ids = args.get("connection_ids")
    if not isinstance(ids, list) or not ids:
        single = str(args.get("connection_id") or "")
        ids = [single] if single else None
    body = {
        "question": question,
        "connection_id": str(args.get("connection_id") or ""),
        "connection_ids": ids,
        "database": str(args.get("database") or ""),
        "schema": str(args.get("schema") or ""),
        "table": str(args.get("table") or ""),
        "execute": True,
    }
    return api._ai_agent(body)


def _required(args: dict[str, Any], key: str) -> str:
    value = str(args.get(key) or "").strip()
    if not value:
        raise ToolError(f"{key} is required")
    return value


def _int(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(low, min(number, high))


def _schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": True,
    }


_STR = {"type": "string"}

TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "connections_list",
        "title": "List connections",
        "description": "List saved DB Desk connections (never includes passwords or tokens).",
        "inputSchema": _schema({}),
        "handler": _connections_list,
        "read_only": True,
    },
    {
        "name": "databases_list",
        "title": "List databases",
        "description": "List the databases reachable through a connection.",
        "inputSchema": _schema({"connection_id": _STR}, ["connection_id"]),
        "handler": _databases_list,
        "read_only": True,
    },
    {
        "name": "tables_list",
        "title": "List tables",
        "description": "List schemas and tables/views for a connection (optionally one schema).",
        "inputSchema": _schema(
            {"connection_id": _STR, "database": _STR, "schema": _STR}, ["connection_id"]
        ),
        "handler": _tables_list,
        "read_only": True,
    },
    {
        "name": "table_columns",
        "title": "Table columns",
        "description": "Column names, types and defaults for one table.",
        "inputSchema": _schema(
            {"connection_id": _STR, "schema": _STR, "table": _STR, "database": _STR},
            ["connection_id", "schema", "table"],
        ),
        "handler": _table_columns,
        "read_only": True,
    },
    {
        "name": "table_indexes",
        "title": "Table indexes",
        "description": "Indexes and primary keys for one table.",
        "inputSchema": _schema(
            {"connection_id": _STR, "schema": _STR, "table": _STR, "database": _STR},
            ["connection_id", "schema", "table"],
        ),
        "handler": _table_indexes,
        "read_only": True,
    },
    {
        "name": "table_ddl",
        "title": "Table DDL",
        "description": "Show the CREATE TABLE statement for one table.",
        "inputSchema": _schema(
            {"connection_id": _STR, "schema": _STR, "table": _STR, "database": _STR},
            ["connection_id", "schema", "table"],
        ),
        "handler": _table_ddl,
        "read_only": True,
    },
    {
        "name": "table_rows",
        "title": "Table rows",
        "description": "Read rows with optional filters, ordering, limit and offset.",
        "inputSchema": _schema(
            {
                "connection_id": _STR,
                "schema": _STR,
                "table": _STR,
                "database": _STR,
                "limit": {"type": "integer", "minimum": 1, "maximum": 500},
                "offset": {"type": "integer", "minimum": 0},
                "order_by": _STR,
                "order_dir": {"type": "string", "enum": ["asc", "desc"]},
                "filters": {"type": "array", "items": {"type": "object"}},
            },
            ["connection_id", "schema", "table"],
        ),
        "handler": _table_rows,
        "read_only": True,
    },
    {
        "name": "table_csv",
        "title": "Table CSV export",
        "description": "Export a table as CSV text (capped; check truncated).",
        "inputSchema": _schema(
            {
                "connection_id": _STR,
                "schema": _STR,
                "table": _STR,
                "database": _STR,
                "limit": {"type": "integer", "minimum": 1, "maximum": 20000},
            },
            ["connection_id", "schema", "table"],
        ),
        "handler": _table_csv,
        "read_only": True,
    },
    {
        "name": "query",
        "title": "Run SQL",
        "description": (
            "Run one SQL statement. Read-only connections accept only "
            "SELECT/WITH/SHOW/EXPLAIN. Writable connections accept writes when MCP "
            "writes are enabled; every statement is audited."
        ),
        "inputSchema": _schema(
            {
                "connection_id": _STR,
                "sql": _STR,
                "database": _STR,
                "limit": {"type": "integer", "minimum": 1, "maximum": 1000},
            },
            ["connection_id", "sql"],
        ),
        "handler": _query,
        "read_only": False,
    },
    {
        "name": "ask_data",
        "title": "Ask in natural language",
        "description": (
            "Ask DB Desk's AI agent. It can inspect schemas across the AI-enabled "
            "connections, run read-only SQL and join results locally."
        ),
        "inputSchema": _schema(
            {
                "question": _STR,
                "connection_id": _STR,
                "connection_ids": {"type": "array", "items": _STR},
                "database": _STR,
                "schema": _STR,
                "table": _STR,
            },
            ["question"],
        ),
        "handler": _ask_data,
        "read_only": True,
    },
]

TOOLS = {spec["name"]: spec for spec in TOOL_SPECS}


# --------------------------------------------------------------------------- #
# JSON-RPC
# --------------------------------------------------------------------------- #


def _tool_list() -> list[dict[str, Any]]:
    return [
        {
            "name": spec["name"],
            "title": spec["title"],
            "description": spec["description"],
            "inputSchema": spec["inputSchema"],
            "annotations": {"readOnlyHint": bool(spec["read_only"])},
        }
        for spec in TOOL_SPECS
    ]


async def _call_tool(params: dict[str, Any]) -> dict[str, Any]:
    name = str(params.get("name") or "")
    spec = TOOLS.get(name)
    if spec is None:
        raise ToolError(f"unknown tool {name!r}")
    arguments = params.get("arguments")
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict):
        raise ToolError("arguments must be an object")
    try:
        result = await spec["handler"](arguments)
    except HTTPException as exc:
        return _tool_content({"error": str(exc.detail)}, is_error=True)
    except ToolError as exc:
        return _tool_content({"error": str(exc)}, is_error=True)
    return _tool_content(result)


def _tool_content(value: Any, is_error: bool = False) -> dict[str, Any]:
    text = json.dumps(value, ensure_ascii=False, default=str)
    payload: dict[str, Any] = {
        "content": [{"type": "text", "text": text}],
        "isError": is_error,
    }
    if isinstance(value, dict) and not is_error:
        payload["structuredContent"] = value
    return payload


async def _handle(message: Any) -> dict[str, Any] | None:
    if not isinstance(message, dict):
        return _error(None, -32600, "invalid request")
    method = str(message.get("method") or "")
    request_id = message.get("id")
    params = message.get("params") or {}
    if not isinstance(params, dict):
        params = {}
    if request_id is None and method.startswith("notifications/"):
        return None
    if method == "initialize":
        requested = str(params.get("protocolVersion") or PROTOCOL_VERSION)
        return _result(
            request_id,
            {
                "protocolVersion": requested,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "dbdesk", "title": APP_NAME, "version": _VERSION},
                "instructions": (
                    "DB Desk controls local database connections. Start with "
                    "connections_list, inspect schema, then query. Reads are always "
                    "audited. Writes only run on writable connections when enabled "
                    "in Settings."
                ),
            },
        )
    if method == "ping":
        return _result(request_id, {})
    if method == "tools/list":
        return _result(request_id, {"tools": _tool_list()})
    if method == "tools/call":
        return _result(request_id, await _call_tool(params))
    if method in ("resources/list", "prompts/list"):
        key = "resources" if method.startswith("resources") else "prompts"
        return _result(request_id, {key: []})
    return _error(request_id, -32601, f"method {method!r} is not supported")


def _result(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _authorized(request: Request) -> bool:
    config = _load_config()
    if not config["enabled"] or not config["token"]:
        raise HTTPException(403, "MCP server is disabled in DB Desk → Settings")
    header = request.headers.get("authorization") or ""
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    if not token:
        token = (request.headers.get("x-dbdesk-token") or "").strip()
    if not token or not hmac.compare_digest(token, config["token"]):
        raise HTTPException(401, "invalid MCP token")
    host = (request.client.host if request.client else "") or ""
    if host not in ("127.0.0.1", "::1", "localhost", "testclient"):
        raise HTTPException(403, "MCP is loopback-only")
    return True


@protocol_router.post("/mcp")
async def mcp_endpoint(request: Request) -> Response:
    _authorized(request)
    try:
        payload = await request.json()
    except ValueError as exc:
        return JSONResponse(_error(None, -32700, "parse error"), status_code=400)
    if isinstance(payload, list):
        responses = []
        for item in payload:
            response = await _handle(item)
            if response is not None:
                responses.append(response)
        return JSONResponse(responses) if responses else Response(status_code=204)
    response = await _handle(payload)
    if response is None:
        return Response(status_code=204)
    return JSONResponse(response)


@protocol_router.get("/mcp")
async def mcp_get(request: Request) -> Response:
    _authorized(request)
    return JSONResponse(
        {
            "name": "dbdesk",
            "transport": "streamable-http",
            "protocolVersion": PROTOCOL_VERSION,
            "endpoint": "/mcp",
        }
    )


# --------------------------------------------------------------------------- #
# management API (mounted under /api)
# --------------------------------------------------------------------------- #


@runtime_router.get("/mcp/status")
async def mcp_status() -> dict[str, Any]:
    return _status()


@runtime_router.post("/mcp/status")
async def mcp_update(body: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        config = _load_config()
        if "enabled" in body:
            config["enabled"] = bool(body.get("enabled"))
            if config["enabled"] and not config["token"]:
                config["token"] = _new_token()
        if "allow_writes" in body:
            config["allow_writes"] = bool(body.get("allow_writes"))
        _save_config(config)
    return _status()


@runtime_router.post("/mcp/token/rotate")
async def mcp_rotate() -> dict[str, Any]:
    with _LOCK:
        config = _load_config()
        config["token"] = _new_token()
        _save_config(config)
    return _status()
