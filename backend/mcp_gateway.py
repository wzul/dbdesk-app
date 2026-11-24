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
# connection drafts, prefs and approvals
# --------------------------------------------------------------------------- #

DRAFT_KINDS = {"postgres", "mysql", "clickhouse", "sqlite"}
DRAFT_TEXT_FIELDS = (
    "group", "host", "user", "sslmode", "ssh_host", "ssh_user", "tunnel_command",
    "ch_path",
)
UPDATE_FIELDS = (
    "name", "group", "host", "port", "dbname", "user", "sslmode",
    "ssh_host", "ssh_user", "ssh_port", "tunnel_command", "ch_path",
)


def _drafts_path() -> Path:
    return _data_dir() / "connection-drafts.json"


def _load_drafts() -> list[dict[str, Any]]:
    try:
        value = json.loads(_drafts_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        value = {}
    drafts = value.get("drafts") if isinstance(value, dict) else None
    return [item for item in drafts or [] if isinstance(item, dict) and item.get("id")][:50]


def _save_drafts(drafts: list[dict[str, Any]]) -> None:
    path = _drafts_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"drafts": drafts[:50]}, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _sanitize_draft(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ToolError("draft must be an object")
    kind = str(value.get("kind") or "postgres").strip().lower()
    if kind not in DRAFT_KINDS:
        raise ToolError("kind must be postgres, mysql, clickhouse or sqlite")
    name = str(value.get("name") or "").strip()[:80]
    dbname = str(value.get("dbname") or "").strip()[:500]
    if not name:
        raise ToolError("name is required")
    if not dbname:
        raise ToolError("dbname is required")
    draft: dict[str, Any] = {"kind": kind, "name": name, "dbname": dbname}
    for field in DRAFT_TEXT_FIELDS:
        item = str(value.get(field) or "").strip()
        if item:
            draft[field] = item[:200]
    default_port = {"postgres": 5432, "mysql": 3306, "clickhouse": 8123}.get(kind, 0)
    draft["port"] = _int(value.get("port"), default_port, 0, 65535)
    draft["ssh_port"] = _int(value.get("ssh_port"), 22, 0, 65535)
    draft["readonly"] = bool(value.get("readonly", True))
    draft["production"] = bool(value.get("production", False))
    if kind == "sqlite":
        for field in ("host", "port", "user", "sslmode", "ssh_host", "ssh_user", "ssh_port"):
            draft.pop(field, None)
    return draft


def _create_draft(draft: dict[str, Any], note: str = "") -> dict[str, Any]:
    entry = {
        "id": secrets.token_hex(6),
        "created_at": time.time(),
        "status": "pending",
        "source": "agent",
        "note": note[:500],
        "draft": draft,
    }
    with _LOCK:
        drafts = _load_drafts()
        drafts.append(entry)
        _save_drafts(drafts)
    return entry


def _prefs_path() -> Path:
    return _data_dir() / "prefs.json"


APPEARANCES = {"system", "light", "dark"}


def _load_prefs() -> dict[str, Any]:
    try:
        value = json.loads(_prefs_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        value = {}
    appearance = str(value.get("appearance") or "system").lower()
    if appearance not in APPEARANCES:
        appearance = "system"
    return {
        "notifications": bool(value.get("notifications", True)),
        "appearance": appearance,
    }


def _save_prefs(prefs: dict[str, Any]) -> None:
    path = _prefs_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(prefs, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _request_approval(
    conn: dict[str, Any], action: str, preview: str, payload: dict[str, Any]
) -> dict[str, Any]:
    entry = {
        "id": secrets.token_hex(6),
        "ts": time.time(),
        "connection_id": conn.get("id"),
        "connection_name": conn.get("name", ""),
        "database": conn.get("dbname", ""),
        "schema": "",
        "table": "",
        "action": action,
        "sql": preview[:4000],
        "hash": api._approval_hash(preview),
        "status": "pending",
        "decided_at": None,
        "used_at": None,
        "source": "mcp",
        "payload": payload,
    }
    entries = api._load_approvals()
    entries.append(entry)
    api._save_approvals(entries[:300])
    api._approval_notice(entry)
    api._audit(conn, "approval_requested", preview)
    return entry


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
    kind = api._kind(conn)
    if not readonly and not config.get("allow_writes", True):
        raise ToolError(
            "writes are disabled; enable 'Allow writes' in DB Desk → Settings → MCP server"
        )
    if kind == "redis":
        command = (sql.split() or [""])[0].upper()
        if readonly and command and command not in api.REDIS_READ_COMMANDS:
            raise ToolError("this Redis connection is read-only: only read commands are allowed")
        if command and command not in api.REDIS_READ_COMMANDS and conn.get("production"):
            raise ToolError(
                "production Redis writes need approval in the DB Desk app; run the command there"
            )
    elif kind == "mongodb":
        pass  # the Mongo command runner only performs finds/aggregates
    elif readonly and not api.READ_SQL.match(sql):
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


async def _connection_draft(args: dict[str, Any]) -> dict[str, Any]:
    entry = _create_draft(_sanitize_draft(args), str(args.get("note") or ""))
    return {
        "draft": entry,
        "next": (
            "Review it in DB Desk and type the password there. Secrets must never be "
            "sent through this tool."
        ),
    }


async def _connection_update(args: dict[str, Any]) -> dict[str, Any]:
    cid = _required(args, "connection_id")
    conn = api._get(cid)
    changes: dict[str, Any] = {}
    for field in UPDATE_FIELDS:
        if field not in args:
            continue
        value = args.get(field)
        if field in ("port", "ssh_port"):
            changes[field] = _int(value, int(conn.get(field) or 0), 0, 65535)
        else:
            changes[field] = str(value or "").strip()[:500]
    if "production" in args:
        changes["production"] = bool(args.get("production"))
    if not changes:
        raise ToolError("no supported fields to update")
    preview = (
        f'-- update connection "{conn.get("name")}"\n'
        + "\n".join(f"-- {key} = {value}" for key, value in sorted(changes.items()))
    )
    if conn.get("production") or changes.get("production") is True:
        approval = _request_approval(
            conn, "update_connection", preview, {"connection_id": cid, "changes": changes}
        )
        return {
            "pending_approval": approval,
            "message": "Production change queued. Approve it in DB Desk → Approvals.",
        }
    body = {**api._public(conn), **changes, "id": cid}
    result = await api.save_connection(body)
    api._audit(conn, "mcp_connection_update", preview, ok=True, notify=False)
    return {"connection": result["connection"], "changed": sorted(changes)}


async def _connection_delete(args: dict[str, Any]) -> dict[str, Any]:
    cid = _required(args, "connection_id")
    conn = api._get(cid)
    preview = (
        f'-- delete connection "{conn.get("name")}" '
        f'({conn.get("kind")}, {conn.get("dbname")})'
    )
    approval = _request_approval(
        conn, "delete_connection", preview, {"connection_id": cid}
    )
    return {
        "pending_approval": approval,
        "message": "Deletion queued. Approve it in DB Desk → Approvals.",
    }


async def _connection_test(args: dict[str, Any]) -> dict[str, Any]:
    cid = _required(args, "connection_id")
    conn = api._get(cid)
    result = await api.test_connection({"id": cid})
    api._audit(conn, "mcp_connection_test", "-- test connection", ok=True, notify=False)
    return result


async def _views_list(args: dict[str, Any]) -> dict[str, Any]:
    return await api.list_views()


async def _view_create(args: dict[str, Any]) -> dict[str, Any]:
    body = {
        "name": _required(args, "name"),
        "connection_id": _required(args, "connection_id"),
        "database": str(args.get("database") or ""),
        "schema": _required(args, "schema"),
        "table": _required(args, "table"),
        "filters": args.get("filters") if isinstance(args.get("filters"), list) else [],
        "order_by": str(args.get("order_by") or ""),
        "order_dir": str(args.get("order_dir") or "asc"),
        "limit": _int(args.get("limit"), 100, 1, 1000),
    }
    return await api.save_view(body)


async def _view_delete(args: dict[str, Any]) -> dict[str, Any]:
    return await api.delete_view(_required(args, "view_id"))


async def _queries_list(args: dict[str, Any]) -> dict[str, Any]:
    return await api.list_saved()


async def _query_save(args: dict[str, Any]) -> dict[str, Any]:
    name = _required(args, "name")
    sql = api._check_sql(str(args.get("sql") or ""))
    body = {
        "name": name,
        "sql": sql,
        "connection_id": str(args.get("connection_id") or ""),
        "database": str(args.get("database") or ""),
    }
    return await api.save_query(body)


async def _query_delete(args: dict[str, Any]) -> dict[str, Any]:
    return await api.delete_saved(_required(args, "query_id"))


async def _app_status(args: dict[str, Any]) -> dict[str, Any]:
    ai = api._load_ai_config()
    mcp = _load_config()
    return {
        "version": _VERSION,
        "home": str(_home()),
        "connections": len(api._load()),
        "saved_views": len(api._load_views()),
        "ai": {"configured": bool(api._ai_key(ai)), "model": ai.get("model", "")},
        "mcp": {
            "enabled": mcp["enabled"],
            "allow_writes": mcp["allow_writes"],
            "tools": len(TOOL_SPECS),
        },
        "notifications": _load_prefs()["notifications"],
        "appearance": _load_prefs()["appearance"],
    }


async def _settings_update(args: dict[str, Any]) -> dict[str, Any]:
    changed: list[str] = []
    if "notifications" in args:
        prefs = _load_prefs()
        prefs["notifications"] = bool(args.get("notifications"))
        _save_prefs(prefs)
        changed.append("notifications")
    if "appearance" in args:
        appearance = str(args.get("appearance") or "").lower()
        if appearance not in APPEARANCES:
            raise ToolError("appearance must be system, light or dark")
        prefs = _load_prefs()
        prefs["appearance"] = appearance
        _save_prefs(prefs)
        changed.append("appearance")
    if "ai_model" in args:
        model = str(args.get("ai_model") or "").strip()[:100]
        if not model:
            raise ToolError("ai_model must not be empty")
        await api.ai_config_save({"model": model})
        changed.append("ai_model")
    if "allow_writes" in args:
        if bool(args.get("allow_writes")):
            raise ToolError(
                "enabling writes must be done by the user in DB Desk → Settings → MCP server"
            )
        with _LOCK:
            config = _load_config()
            config["allow_writes"] = False
            _save_config(config)
        changed.append("allow_writes")
    if not changed:
        raise ToolError("supported settings: notifications, ai_model, allow_writes=false")
    result = await _app_status({})
    result["changed"] = changed
    return result


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
    {
        "name": "connection_draft",
        "title": "Draft a connection",
        "description": (
            "Create a pending connection draft (no password). The user reviews it in "
            "DB Desk and types the secret there."
        ),
        "inputSchema": _schema(
            {
                "kind": {"type": "string", "enum": ["postgres", "mysql", "clickhouse", "sqlite"]},
                "name": _STR,
                "group": _STR,
                "host": _STR,
                "port": {"type": "integer"},
                "dbname": _STR,
                "user": _STR,
                "sslmode": _STR,
                "ssh_host": _STR,
                "ssh_user": _STR,
                "ssh_port": {"type": "integer"},
                "tunnel_command": _STR,
                "ch_path": _STR,
                "readonly": {"type": "boolean"},
                "production": {"type": "boolean"},
                "note": _STR,
            },
            ["kind", "name", "dbname"],
        ),
        "handler": _connection_draft,
        "read_only": False,
    },
    {
        "name": "connection_update",
        "title": "Update a connection",
        "description": (
            "Update non-secret fields of an existing connection. Production changes "
            "create an approval and wait for the user."
        ),
        "inputSchema": _schema(
            {
                "connection_id": _STR,
                "name": _STR,
                "group": _STR,
                "host": _STR,
                "port": {"type": "integer"},
                "dbname": _STR,
                "user": _STR,
                "sslmode": _STR,
                "ssh_host": _STR,
                "ssh_user": _STR,
                "ssh_port": {"type": "integer"},
                "tunnel_command": _STR,
                "ch_path": _STR,
                "production": {"type": "boolean"},
            },
            ["connection_id"],
        ),
        "handler": _connection_update,
        "read_only": False,
    },
    {
        "name": "connection_delete",
        "title": "Delete a connection",
        "description": "Queue deletion of a connection; the user must approve it in DB Desk.",
        "inputSchema": _schema({"connection_id": _STR}, ["connection_id"]),
        "handler": _connection_delete,
        "read_only": False,
    },
    {
        "name": "connection_test",
        "title": "Test a connection",
        "description": "Open the saved connection and return server/version details.",
        "inputSchema": _schema({"connection_id": _STR}, ["connection_id"]),
        "handler": _connection_test,
        "read_only": True,
    },
    {
        "name": "views_list",
        "title": "List saved views",
        "description": "List saved table views (filters, ordering, limits).",
        "inputSchema": _schema({}),
        "handler": _views_list,
        "read_only": True,
    },
    {
        "name": "view_create",
        "title": "Save a view",
        "description": "Create or replace a saved view for a table.",
        "inputSchema": _schema(
            {
                "name": _STR,
                "connection_id": _STR,
                "database": _STR,
                "schema": _STR,
                "table": _STR,
                "filters": {"type": "array", "items": {"type": "object"}},
                "order_by": _STR,
                "order_dir": {"type": "string", "enum": ["asc", "desc"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": 1000},
            },
            ["name", "connection_id", "schema", "table"],
        ),
        "handler": _view_create,
        "read_only": False,
    },
    {
        "name": "view_delete",
        "title": "Delete a saved view",
        "description": "Delete a saved view by id.",
        "inputSchema": _schema({"view_id": _STR}, ["view_id"]),
        "handler": _view_delete,
        "read_only": False,
    },
    {
        "name": "queries_list",
        "title": "List saved queries",
        "description": "List saved SQL snippets (name, SQL, connection).",
        "inputSchema": _schema({}),
        "handler": _queries_list,
        "read_only": True,
    },
    {
        "name": "query_save",
        "title": "Save a query",
        "description": "Save one SQL statement under a name for the user.",
        "inputSchema": _schema(
            {"name": _STR, "sql": _STR, "connection_id": _STR, "database": _STR},
            ["name", "sql"],
        ),
        "handler": _query_save,
        "read_only": False,
    },
    {
        "name": "query_delete",
        "title": "Delete a saved query",
        "description": "Delete a saved query by id.",
        "inputSchema": _schema({"query_id": _STR}, ["query_id"]),
        "handler": _query_delete,
        "read_only": False,
    },
    {
        "name": "app_status",
        "title": "DB Desk status",
        "description": (
            "Version, data path, connection/view counts, AI configured/model and MCP state."
        ),
        "inputSchema": _schema({}),
        "handler": _app_status,
        "read_only": True,
    },
    {
        "name": "settings_update",
        "title": "Update safe settings",
        "description": (
            "Toggle notifications, choose the appearance (system/light/dark), set the AI "
            "model, or turn MCP writes off. It cannot change the AI base URL, API key, "
            "MCP token or enable writes."
        ),
        "inputSchema": _schema(
            {
                "notifications": {"type": "boolean"},
                "appearance": {"type": "string", "enum": ["system", "light", "dark"]},
                "ai_model": _STR,
                "allow_writes": {"type": "boolean"},
            }
        ),
        "handler": _settings_update,
        "read_only": False,
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


@runtime_router.get("/connection-drafts")
async def list_connection_drafts() -> dict[str, Any]:
    return {"drafts": [item for item in _load_drafts() if item.get("status") == "pending"]}


@runtime_router.post("/connection-drafts/{draft_id}/{action}")
async def update_connection_draft(draft_id: str, action: str) -> dict[str, Any]:
    if action not in ("applied", "dismissed"):
        raise HTTPException(404, "unknown draft action")
    with _LOCK:
        drafts = _load_drafts()
        entry = next((item for item in drafts if item.get("id") == draft_id), None)
        if entry is None:
            raise HTTPException(404, "draft not found")
        entry["status"] = action
        entry["updated_at"] = time.time()
        _save_drafts(drafts)
    return {"draft": entry}


@runtime_router.get("/prefs")
async def get_prefs() -> dict[str, Any]:
    return _load_prefs()


@runtime_router.post("/prefs")
async def set_prefs(body: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        prefs = _load_prefs()
        if "notifications" in body:
            prefs["notifications"] = bool(body.get("notifications"))
        if "appearance" in body:
            appearance = str(body.get("appearance") or "").lower()
            if appearance in APPEARANCES:
                prefs["appearance"] = appearance
        _save_prefs(prefs)
    return prefs
