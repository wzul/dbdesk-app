"""DB Desk backend — PostgreSQL / MySQL / ClickHouse browsing for Hermes.

Routes are mounted at ``/api/plugins/dbdesk/``. Dialects:

- **PostgreSQL** — the system ``psql`` binary, CSV + ``\\gdesc`` for column types.
- **MySQL / MariaDB** — the ``mysql``/``mariadb`` client in batch mode.
- **ClickHouse** — its HTTP interface (stdlib ``urllib``), ``JSONCompact``.

No Python database driver is required. Every statement runs in a separate
process/request with a hard timeout. Passwords live only in
``<hermes home>/plugin-data/dbdesk/connections.json`` (mode 0600) and are never
returned to the UI.

Read-only is the default and is a guardrail, not a sandbox: Postgres enforces it
with ``default_transaction_read_only``, MariaDB/MySQL with a read-only session
(``tx_read_only`` / ``transaction_read_only``), ClickHouse with ``readonly=1``;
the query runner independently refuses non-read statements on a read-only
connection.
"""

from __future__ import annotations

import atexit
import base64
import csv
import datetime
import decimal
import hashlib
import http.server
import io
import json
import os
import re
import secrets as pysecrets
import shutil
import socket
import sqlite3
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

try:  # available in the gateway's runtime; used only for credential encryption
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:  # pragma: no cover - surfaces on save with a clear error
    AESGCM = None

try:  # the Hermes runtime provides this; standalone/CI falls back to the env
    from hermes_constants import get_hermes_home
except ImportError:  # pragma: no cover

    def get_hermes_home() -> Path:
        return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))

router = APIRouter()

PSQL = shutil.which("psql") or "/usr/bin/psql"
SSH = shutil.which("ssh") or "/usr/bin/ssh"
MYSQL = shutil.which("mysql") or shutil.which("mariadb") or "/usr/bin/mysql"
NULL_SENTINEL = "\u2400"
QUERY_TIMEOUT = 30
MAX_ROWS = 1000
KINDS = {"postgres", "mysql", "clickhouse", "mcp", "http", "sqlite"}
_SSH_TUNNELS: dict[str, dict[str, Any]] = {}


def _close_tunnels() -> None:
    for entry in list(_SSH_TUNNELS.values()):
        try:
            entry["proc"].terminate()
        except OSError:
            pass
    _SSH_TUNNELS.clear()


atexit.register(_close_tunnels)
READ_SQL = re.compile(r"(?is)^\s*(select|with|show|describe|desc|explain|table|values)\b")


# --------------------------------------------------------------------------- #
# storage
# --------------------------------------------------------------------------- #


def _data_dir() -> Path:
    override = os.environ.get("DBDESK_HOME")
    root = (
        Path(override) / "data"
        if override
        else get_hermes_home() / "plugin-data" / "dbdesk"
    )
    root.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(root, 0o700)
    except OSError:
        pass
    return root


def _store_path() -> Path:
    return _data_dir() / "connections.json"


def _vault_key() -> bytes:
    path = _data_dir() / "vault.key"
    if not path.exists():
        path.write_bytes(pysecrets.token_bytes(32))
        os.chmod(path, 0o600)
    return path.read_bytes()


def _encrypt(value: str) -> str:
    if AESGCM is None:
        raise HTTPException(500, "credential encryption unavailable (cryptography missing)")
    nonce = pysecrets.token_bytes(12)
    blob = AESGCM(_vault_key()).encrypt(nonce, str(value).encode("utf-8"), b"dbdesk")
    return "v1:" + base64.urlsafe_b64encode(nonce + blob).decode("ascii")


def _decrypt(token: str) -> str:
    if not token:
        return ""
    if not token.startswith("v1:"):
        return str(token)
    try:
        raw = base64.urlsafe_b64decode(token[3:].encode("ascii"))
        return AESGCM(_vault_key()).decrypt(raw[:12], raw[12:], b"dbdesk").decode("utf-8")
    except Exception:
        return ""


def _load() -> list[dict[str, Any]]:
    path = _store_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    conns = data.get("connections") if isinstance(data, dict) else None
    out = [c for c in conns or [] if isinstance(c, dict) and c.get("id")]
    migrated = False
    for conn in out:
        if conn.get("password"):
            if not conn.get("password_enc"):
                conn["password_enc"] = _encrypt(conn.pop("password"))
            else:
                conn.pop("password", None)
            migrated = True
        conn.pop("password", None)
    if migrated:
        _save(out)
    return out


def _save(conns: list[dict[str, Any]]) -> None:
    path = _store_path()
    tmp = path.with_suffix(".tmp")
    clean = [{k: v for k, v in conn.items() if k != "password"} for conn in conns]
    tmp.write_text(json.dumps({"connections": clean}, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _public(conn: dict[str, Any]) -> dict[str, Any]:
    out = {
        k: v
        for k, v in conn.items()
        if k not in ("password", "password_enc", "ch_headers", "ch_headers_enc")
    }
    out["ch_headers_set"] = bool(conn.get("ch_headers_enc"))
    out.setdefault("kind", "postgres")
    return out


def _get(conn_id: str) -> dict[str, Any]:
    for conn in _load():
        if conn["id"] == conn_id:
            conn = dict(conn)
            conn.setdefault("kind", "postgres")
            conn["password"] = _decrypt(conn.get("password_enc", ""))
            conn["ch_headers"] = _decrypt(conn.get("ch_headers_enc", ""))
            return conn
    raise HTTPException(404, f"connection {conn_id!r} not found")


def _tunnel(conn: dict[str, Any]) -> int:
    """Local port forwarding the connection's host:port through its SSH host.

    One ``ssh -N -L`` per connection, reused for the life of the plugin process.
    The target is resolved by the SSH server, so ``host`` is the target as that
    machine sees it (127.0.0.1 for a published port, or a container IP).
    """
    ssh_host = str(conn.get("ssh_host") or "").strip()
    target_host = str(conn.get("host") or "127.0.0.1")
    target_port = int(conn.get("port") or 0)
    key = "|".join(
        str(conn.get(name) or "")
        for name in ("id", "ssh_host", "ssh_port", "ssh_user", "ssh_key", "host", "port")
    )
    entry = _SSH_TUNNELS.get(key)
    if entry and entry["proc"].poll() is None:
        return int(entry["port"])

    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = int(probe.getsockname()[1])
    probe.close()

    command = [
        SSH, "-N",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=8",
        "-p", str(conn.get("ssh_port") or 22),
    ]
    if conn.get("ssh_key"):
        command += ["-i", str(conn["ssh_key"])]
    command += [
        "-L", f"127.0.0.1:{port}:{target_host}:{target_port}",
        f"{conn.get('ssh_user') or 'root'}@{ssh_host}",
    ]
    proc = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            detail = (proc.stderr.read() if proc.stderr else "") or "ssh exited"
            raise HTTPException(502, f"SSH tunnel failed: {detail.strip()[:300]}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                _SSH_TUNNELS[key] = {"proc": proc, "port": port}
                return port
        except OSError:
            time.sleep(0.15)
    proc.kill()
    raise HTTPException(504, "SSH tunnel did not open in time")


def _tunnel_env(conn: dict[str, Any]) -> dict[str, str]:
    raw = conn.get("tunnel_env")
    values: dict[str, str] = {}
    if isinstance(raw, dict):
        return {str(key): str(value) for key, value in raw.items()}
    for line in str(raw or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key:
            values[key] = value.strip().strip('"').strip("'")
    return values


def _command_tunnel(conn: dict[str, Any]) -> None:
    """Run a custom tunnel command and wait for the local host:port to accept.

    ``tunnel_command`` is an operator-supplied shell command (SSM port
    forwarding, cloudflared access tcp, a bastion script, ...). The connection's
    host/port are the LOCAL endpoint the command opens.
    """
    command = str(conn.get("tunnel_command") or "").strip()
    if not command:
        return
    host = str(conn.get("host") or "127.0.0.1")
    port = int(conn.get("port") or 0)
    if port <= 0:
        raise HTTPException(400, "a custom tunnel needs a local port in Host/Port")

    def open_now() -> bool:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            return False

    if open_now():
        return
    key = f"cmd|{conn.get('id')}|{hashlib.sha1(command.encode()).hexdigest()}|{host}:{port}"
    entry = _SSH_TUNNELS.get(key)
    if entry and entry["proc"].poll() is None and open_now():
        return
    timeout = max(5, min(int(conn.get("tunnel_timeout") or 25), 120))
    env = {
        "PATH": "/root/.local/bin:/usr/local/bin:/usr/bin:/bin",
        "HOME": os.environ.get("HOME", "/root"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "HERMES_HOME": str(get_hermes_home()),
        **_tunnel_env(conn),
    }
    try:
        proc = subprocess.Popen(
            ["/bin/sh", "-lc", command],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, **env},
        )
    except OSError as exc:
        raise HTTPException(500, f"could not start tunnel command: {exc}") from exc
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            detail = (proc.stderr.read() if proc.stderr else "") or "tunnel command exited"
            raise HTTPException(502, f"tunnel command failed: {detail.strip()[:500]}")
        if open_now():
            _SSH_TUNNELS[key] = {"proc": proc, "port": port}
            return
        time.sleep(0.2)
    proc.kill()
    raise HTTPException(504, f"tunnel did not open {host}:{port} within {timeout}s")


def _connect(conn_id: str) -> dict[str, Any]:
    conn = _get(conn_id)
    if str(conn.get("kind") or "") in ("mcp", "http", "sqlite"):
        return conn
    if str(conn.get("tunnel_command") or "").strip():
        _command_tunnel(conn)
        return conn
    if str(conn.get("tunnel_command") or "").strip():
        _command_tunnel(conn)
    elif str(conn.get("ssh_host") or "").strip():
        conn = dict(conn, host="127.0.0.1", port=_tunnel(conn))
    return conn


def _with_db(conn: dict[str, Any], database: str | None) -> dict[str, Any]:
    if str(conn.get("kind") or "") == "sqlite":
        return conn
    if database:
        return dict(conn, dbname=str(database))
    return conn


def _writable(conn: dict[str, Any]) -> None:
    if str(conn.get("kind") or "") in ("mcp", "http"):
        raise HTTPException(403, "MCP/HTTP connections are read-only in DB Desk")
    if conn.get("readonly", True):
        raise HTTPException(403, "this connection is read-only; turn off read-only in its settings")


def _guard_readonly(conn: dict[str, Any], sql: str) -> None:
    if conn.get("readonly", True) and not READ_SQL.match(sql):
        raise HTTPException(403, "read-only connection: only SELECT/SHOW/EXPLAIN statements are allowed")


def _queries_path() -> Path:
    return _data_dir() / "queries.json"


def _load_queries() -> dict[str, Any]:
    path = _queries_path()
    if not path.exists():
        return {"history": [], "saved": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"history": [], "saved": []}
    return {
        "history": [h for h in data.get("history") or [] if isinstance(h, dict)][:300],
        "saved": [q for q in data.get("saved") or [] if isinstance(q, dict) and q.get("id")][:200],
    }


def _save_queries(data: dict[str, Any]) -> None:
    path = _queries_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _record_history(conn: dict[str, Any], sql: str, result: dict[str, Any] | None = None, error: str = "") -> None:
    data = _load_queries()
    entry = {
        "id": uuid.uuid4().hex[:10],
        "ts": time.time(),
        "connection_id": conn.get("id", ""),
        "connection_name": conn.get("name", ""),
        "kind": _kind(conn),
        "database": conn.get("dbname", ""),
        "sql": sql[:8000],
        "rows": len(result.get("rows") or []) if result else 0,
        "duration_ms": result.get("duration_ms", 0) if result else 0,
        "ok": not error,
        "error": error[:500],
    }
    history = data["history"]
    if history and history[0].get("sql") == entry["sql"] and history[0].get("connection_id") == entry["connection_id"]:
        history[0].update(entry, id=history[0]["id"])
    else:
        history.insert(0, entry)
    data["history"] = history[:300]
    _save_queries(data)


def _views_path() -> Path:
    return _data_dir() / "views.json"


def _load_views() -> list[dict[str, Any]]:
    path = _views_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [v for v in data.get("views") or [] if isinstance(v, dict) and v.get("id")][:300]


def _save_views(views: list[dict[str, Any]]) -> None:
    path = _views_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"views": views}, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


# --------------------------------------------------------------------------- #
# shared SQL bits
# --------------------------------------------------------------------------- #


def _lit(value: Any) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def _my_lit(value: Any) -> str:
    text = (
        str(value)
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\0", "\\0")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\x1a", "\\Z")
    )
    return "'" + text + "'"


def _my_ident(name: str) -> str:
    return "`" + str(name).replace("`", "``") + "`"


def _ch_lit(value: Any) -> str:
    text = (
        str(value)
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return "'" + text + "'"


def _ch_ident(name: str) -> str:
    return "`" + str(name).replace("`", "``") + "`"


def _has_multiple_statements(sql: str) -> bool:
    stripped = sql.strip().rstrip(";").strip()
    i, n = 0, len(stripped)
    tag: str | None = None
    quote: str | None = None
    while i < n:
        ch = stripped[i]
        if tag:
            if stripped.startswith(tag, i):
                i += len(tag)
                tag = None
                continue
            i += 1
            continue
        if quote:
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            continue
        if ch == "$":
            match = re.match(r"\$[A-Za-z_0-9]*\$", stripped[i:])
            if match:
                tag = match.group(0)
                i += len(tag)
                continue
        if ch == ";":
            return True
        i += 1
    return False


def _check_sql(sql: str) -> str:
    sql = (sql or "").strip()
    if not sql:
        raise HTTPException(400, "empty SQL")
    if _has_multiple_statements(sql):
        raise HTTPException(400, "run one statement at a time")
    return sql.rstrip().rstrip(";").strip()


def _clean_error(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"^psql: (error: )?", "", text)
    text = re.sub(r"^ERROR \d+ \(\w+\) at line \d+: ", "ERROR: ", text)
    return text[:4000] or "query failed"


def _like_escape(value: Any) -> str:
    return str(value).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _where_clause(kind: str, filters: Any) -> str:
    if not isinstance(filters, list):
        return ""
    quote = {
        "postgres": _ident, "mysql": _my_ident, "clickhouse": _ch_ident, "sqlite": _sqlite_ident
    }[kind]
    literal = {
        "postgres": _lit, "mysql": _my_lit, "clickhouse": _ch_lit, "sqlite": _sqlite_lit
    }[kind]
    clauses: list[str] = []
    for item in filters[:8]:
        if not isinstance(item, dict) or item.get("enabled") is False:
            continue
        column = str(item.get("column") or "").strip()
        op = str(item.get("op") or "eq").strip().lower()
        value = item.get("value")
        if not column:
            continue
        target = quote(column)
        if op == "isnull":
            clauses.append(f"{target} IS NULL")
        elif op == "notnull":
            clauses.append(f"{target} IS NOT NULL")
        elif op in ("contains", "startswith"):
            insensitive = item.get("insensitive", True)
            pattern = _like_escape(value)
            if op == "contains":
                pattern = "%" + pattern + "%"
            else:
                pattern = pattern + "%"
            if kind == "sqlite":
                cast = f"CAST({target} AS TEXT)"
                if op == "contains":
                    left = f"lower({cast})" if insensitive else cast
                    right = f"lower({literal(value)})" if insensitive else literal(value)
                    clauses.append(f"instr({left}, {right}) > 0")
                else:
                    left = f"lower(substr({cast}, 1, length({literal(value)})))" if insensitive else f"substr({cast}, 1, length({literal(value)}))"
                    right = f"lower({literal(value)})" if insensitive else literal(value)
                    clauses.append(f"{left} = {right}")
            elif kind == "postgres":
                operator = "ILIKE" if insensitive else "LIKE"
                clauses.append(f"{target}::text {operator} {literal(pattern)}")
            elif kind == "mysql":
                if insensitive:
                    clauses.append(
                        f"LOWER(CAST({target} AS CHAR)) LIKE LOWER({literal(pattern)})"
                    )
                else:
                    clauses.append(f"CAST({target} AS CHAR) LIKE BINARY {literal(pattern)}")
            else:
                if op == "contains":
                    function = (
                        "positionCaseInsensitiveUTF8"
                        if insensitive
                        else "positionCaseSensitiveUTF8"
                    )
                    clauses.append(f"{function}(toString({target}), {literal(value)}) > 0")
                elif insensitive:
                    clauses.append(
                        f"positionCaseInsensitiveUTF8(toString({target}), {literal(value)}) = 1"
                    )
                else:
                    clauses.append(f"startsWith(toString({target}), {literal(value)})")
        else:
            compare = {"eq": "=", "neq": "<>", "gt": ">", "lt": "<", "gte": ">=", "lte": "<="}.get(op, "=")
            if value is None:
                clauses.append(f"{target} IS NULL" if op == "eq" else f"{target} IS NOT NULL")
            else:
                clauses.append(f"{target} {compare} {literal(value)}")
    return " AND ".join(clauses)


def _csv_cell(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    return '"' + text.replace('"', '""') + '"' if any(ch in text for ch in ',"\n\r') else text


def _csv_from(columns: list[dict[str, Any]], rows: list[list[Any]]) -> str:
    lines = [",".join(_csv_cell(column.get("name", "")) for column in columns)]
    for row in rows:
        lines.append(",".join(_csv_cell(value) for value in row))
    return "\n".join(lines) + "\n"


def _pg_run_csv(conn: dict[str, Any], sql: str) -> str:
    """CSV with NULLs as empty fields (no sentinel marker)."""
    if psycopg is not None:
        columns, rows = _pg_native_exec(conn, sql, readonly=True)
        rows = [
            [json.dumps(value) if isinstance(value, (dict, list)) else value for value in row]
            for row in rows
        ]
        return _csv_from(columns, rows)
    cmd = [
        PSQL, "-X", "-q", "--csv",
        "-h", str(conn.get("host") or "127.0.0.1"),
        "-p", str(conn.get("port") or 5432),
        "-U", str(conn.get("user") or "postgres"),
        "-d", str(conn.get("dbname") or "postgres"),
    ]
    try:
        proc = subprocess.run(
            cmd, input=sql + ";\n", text=True, capture_output=True,
            env=_pg_env(conn, True), timeout=QUERY_TIMEOUT + 15,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(408, "export timed out") from exc
    if proc.returncode != 0:
        raise HTTPException(400, _clean_error(proc.stderr or proc.stdout))
    return proc.stdout


# --------------------------------------------------------------------------- #
# optional native drivers — persistent connections when the drivers exist
# --------------------------------------------------------------------------- #

try:  # standalone bundle ships psycopg; the Hermes runtime may not
    import psycopg
    import psycopg.postgres
except Exception:  # pragma: no cover - the psql CLI path still works
    psycopg = None

try:  # pure Python, works everywhere
    import pymysql
except Exception:  # pragma: no cover - the mysql CLI path still works
    pymysql = None

try:  # bundled CA store (PyInstaller builds have no system OpenSSL paths)
    import certifi

    _CA_FILE = certifi.where()
except Exception:  # pragma: no cover
    _CA_FILE = ""


def _ssl_context() -> ssl.SSLContext:
    if _CA_FILE:
        try:
            return ssl.create_default_context(cafile=_CA_FILE)
        except Exception:
            pass
    return ssl.create_default_context()

_POOLS: dict[str, dict[str, Any]] = {}
_POOLS_GUARD = threading.Lock()


def _close_pools() -> None:
    with _POOLS_GUARD:
        entries = list(_POOLS.values())
        _POOLS.clear()
    for entry in entries:
        try:
            entry["conn"].close()
        except Exception:
            pass


def _pool_key(conn: dict[str, Any], driver: str) -> str:
    return "|".join(
        [
            driver,
            str(conn.get("id") or ""),
            str(conn.get("host") or ""),
            str(conn.get("port") or ""),
            str(conn.get("dbname") or ""),
            str(conn.get("user") or ""),
            "ro" if conn.get("readonly", True) else "rw",
        ]
    )


def _pool_get(key: str, factory) -> dict[str, Any]:
    with _POOLS_GUARD:
        entry = _POOLS.get(key)
    if entry is not None:
        return entry
    connection = factory()
    entry = {"conn": connection, "lock": threading.Lock()}
    with _POOLS_GUARD:
        existing = _POOLS.get(key)
        if existing is not None:
            try:
                connection.close()
            except Exception:
                pass
            return existing
        _POOLS[key] = entry
    return entry


atexit.register(_close_pools)


def _pg_rows_sql(conn: dict[str, Any], sql: str) -> list[list[Any]]:
    if psycopg is not None:
        _, rows = _pg_native_exec(conn, sql, readonly=True)
        return rows
    out = _pg_run(conn, sql.rstrip().rstrip(";") + ";\n")
    _, rows = _parse_pg_result(out)
    return rows


def _my_rows_sql(conn: dict[str, Any], sql: str) -> list[list[Any]]:
    if pymysql is not None:
        _, rows = _my_native_exec(conn, sql, readonly=True)
        return rows
    out = _my_run(conn, sql, readonly=True)
    _, rows = _parse_my(out)
    return rows


def _pg_native_script(conn: dict[str, Any], statements: list[str]) -> None:
    key = _pool_key(conn, "pg")
    entry = _pool_get(key, lambda: _pg_open_native(conn))
    with entry["lock"]:
        cursor = entry["conn"].cursor()
        try:
            cursor.execute("BEGIN")
            for statement in statements:
                cursor.execute(statement)
            cursor.execute("COMMIT")
        except Exception as exc:
            try:
                cursor.execute("ROLLBACK")
            except Exception:
                pass
            _pool_drop(key)
            raise HTTPException(400, _clean_error(str(exc))) from exc
        finally:
            try:
                cursor.close()
            except Exception:
                pass


def _my_native_script(conn: dict[str, Any], statements: list[str]) -> None:
    key = _pool_key(conn, "my")
    entry = _pool_get(key, lambda: _my_open_native(conn))
    with entry["lock"]:
        cursor = entry["conn"].cursor()
        try:
            entry["conn"].begin()
            for statement in statements:
                cursor.execute(statement)
            entry["conn"].commit()
        except Exception as exc:
            try:
                entry["conn"].rollback()
            except Exception:
                pass
            _pool_drop(key)
            raise HTTPException(400, _clean_error(str(exc))) from exc
        finally:
            try:
                cursor.close()
            except Exception:
                pass


def _pool_drop(key: str) -> None:
    with _POOLS_GUARD:
        entry = _POOLS.pop(key, None)
    if entry is not None:
        try:
            entry["conn"].close()
        except Exception:
            pass


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item) for item in value]
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return "0x" + raw.hex()
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        return str(value)
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    return str(value)


def _native_cell(value: Any) -> Any:
    """JSON-friendly value for psycopg/PyMySQL results."""
    if isinstance(value, (dict, list, tuple, set)):
        # Grid cells expect text for JSON values; encode once, without
        # double-encoding nested objects.
        return json.dumps(_jsonable(value), separators=(",", ":"), default=str)
    return _jsonable(value)


# --- PostgreSQL ------------------------------------------------------------ #

_PG_OID_TYPES = {
    16: "boolean", 17: "bytea", 19: "name", 20: "bigint", 21: "smallint",
    23: "integer", 25: "text", 26: "oid", 114: "json", 700: "real",
    701: "double precision", 1042: "char", 1043: "varchar", 1082: "date",
    1083: "time", 1114: "timestamp", 1184: "timestamptz", 1186: "interval",
    1700: "numeric", 2950: "uuid", 3802: "jsonb",
}


def _pg_type_name(code: Any) -> str:
    try:
        info = psycopg.postgres.types.get(int(code))
    except Exception:
        info = None
    return getattr(info, "name", "") or _PG_OID_TYPES.get(int(code), "text")


def _pg_open_native(conn: dict[str, Any]):
    readonly = bool(conn.get("readonly", True))
    db = psycopg.connect(
        host=conn.get("host") or "127.0.0.1",
        port=int(conn.get("port") or 5432),
        dbname=conn.get("dbname") or "postgres",
        user=conn.get("user") or "postgres",
        password=conn.get("password") or "",
        connect_timeout=10,
        sslmode=conn.get("sslmode") or "prefer",
        autocommit=True,
        application_name="dbdesk",
    )
    with db.cursor() as cur:
        cur.execute(f"SET statement_timeout = {int(QUERY_TIMEOUT * 1000)}")
        if readonly:
            cur.execute("SET default_transaction_read_only = on")
    return db


def _pg_native_exec(
    conn: dict[str, Any],
    sql: str,
    params: Any = None,
    *,
    readonly: bool = True,
    limit: int = 0,
) -> tuple[list[dict[str, Any]], list[list[Any]]]:
    key = _pool_key(conn, "pg")
    entry = _pool_get(key, lambda: _pg_open_native(conn))
    columns: list[dict[str, Any]] = []
    rows: list[list[Any]] = []
    with entry["lock"]:
        try:
            with entry["conn"].cursor() as cur:
                cur.execute(sql, params)
                if cur.description:
                    columns = [
                        {"name": desc.name, "type": _pg_type_name(desc.type_code)}
                        for desc in cur.description
                    ]
                    fetched = cur.fetchmany(limit + 1) if limit else cur.fetchall()
                    rows = [[_native_cell(value) for value in row] for row in fetched]
        except Exception as exc:
            _pool_drop(key)
            raise HTTPException(400, _clean_error(str(exc))) from exc
    return columns, rows


def _pg_native_dicts(conn: dict[str, Any], sql: str, params: Any = None) -> list[dict[str, Any]]:
    columns, rows = _pg_native_exec(conn, sql, params, readonly=True)
    names = [column["name"] for column in columns]
    return [dict(zip(names, row)) for row in rows]


# --- MySQL / MariaDB ------------------------------------------------------- #

_MY_TYPE_NAMES = {
    0: "decimal", 1: "tinyint", 2: "smallint", 3: "int", 4: "float",
    5: "double", 6: "null", 7: "timestamp", 8: "bigint", 9: "mediumint",
    10: "date", 11: "time", 12: "datetime", 13: "year", 15: "varchar",
    16: "bit", 245: "json", 246: "decimal", 247: "enum", 248: "set",
    249: "tinyblob", 250: "mediumblob", 251: "longblob", 252: "blob",
    253: "varchar", 254: "char", 255: "geometry",
}


def _my_open_native(conn: dict[str, Any]):
    readonly = bool(conn.get("readonly", True))
    db = pymysql.connect(
        host=conn.get("host") or "127.0.0.1",
        port=int(conn.get("port") or 3306),
        user=conn.get("user") or "root",
        password=conn.get("password") or "",
        database=conn.get("dbname") or None,
        connect_timeout=10,
        autocommit=True,
        charset="utf8mb4",
    )
    flavor = "mariadb" if "mariadb" in str(db.get_server_info() or "").lower() else "mysql"
    with db.cursor() as cur:
        if readonly:
            try:
                cur.execute(
                    "SET SESSION tx_read_only = 1"
                    if flavor == "mariadb"
                    else "SET SESSION transaction_read_only = 1"
                )
            except pymysql.Error:
                pass
        try:
            cur.execute(
                "SET SESSION max_statement_time = 30"
                if flavor == "mariadb"
                else "SET SESSION MAX_EXECUTION_TIME = 30000"
            )
        except pymysql.Error:
            pass
    return db


def _my_native_exec(
    conn: dict[str, Any],
    sql: str,
    params: Any = None,
    *,
    readonly: bool = True,
    limit: int = 0,
) -> tuple[list[dict[str, Any]], list[list[Any]]]:
    key = _pool_key(conn, "my")
    entry = _pool_get(key, lambda: _my_open_native(conn))
    columns: list[dict[str, Any]] = []
    rows: list[list[Any]] = []
    with entry["lock"]:
        try:
            with entry["conn"].cursor() as cur:
                cur.execute(sql, params)
                if cur.description:
                    columns = [
                        {
                            "name": desc[0],
                            "type": _MY_TYPE_NAMES.get(int(desc[1]), "text"),
                        }
                        for desc in cur.description
                    ]
                    fetched = cur.fetchmany(limit + 1) if limit else cur.fetchall()
                    rows = [[_native_cell(value) for value in row] for row in fetched]
        except Exception as exc:
            _pool_drop(key)
            raise HTTPException(400, _clean_error(str(exc))) from exc
    return columns, rows


# --------------------------------------------------------------------------- #
# PostgreSQL
# --------------------------------------------------------------------------- #


def _pg_env(conn: dict[str, Any], readonly: bool) -> dict[str, str]:
    options = "-c statement_timeout=30000"
    if readonly:
        options += " -c default_transaction_read_only=on"
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": os.path.expanduser("~"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PGPASSWORD": str(conn.get("password") or ""),
        "PGCONNECT_TIMEOUT": "8",
        "PGAPPNAME": "dbdesk",
        "PGSSLMODE": str(conn.get("sslmode") or "prefer"),
        "PGOPTIONS": options,
    }


def _pg_run(conn: dict[str, Any], script: str, *, readonly: bool = True, timeout: int = QUERY_TIMEOUT) -> str:
    cmd = [
        PSQL, "-X", "-q", "--csv", "-P", f"null={NULL_SENTINEL}", "-v", "ON_ERROR_STOP=1",
        "-h", str(conn.get("host") or "127.0.0.1"),
        "-p", str(conn.get("port") or 5432),
        "-U", str(conn.get("user") or "postgres"),
        "-d", str(conn.get("dbname") or "postgres"),
    ]
    try:
        proc = subprocess.run(
            cmd, input=script, text=True, capture_output=True,
            env=_pg_env(conn, readonly), timeout=timeout + 5,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(408, f"query timed out after {timeout}s") from exc
    except OSError as exc:
        raise HTTPException(500, f"could not run psql: {exc}") from exc
    if proc.returncode != 0:
        raise HTTPException(400, _clean_error(proc.stderr or proc.stdout))
    return proc.stdout


def _pg_raw(conn: dict[str, Any], script: str) -> str:
    """Unformatted psql output (for ``\\d+`` and other meta-command reports)."""
    cmd = [
        PSQL, "-X", "-q", "-P", "pager=off",
        "-h", str(conn.get("host") or "127.0.0.1"),
        "-p", str(conn.get("port") or 5432),
        "-U", str(conn.get("user") or "postgres"),
        "-d", str(conn.get("dbname") or "postgres"),
    ]
    try:
        proc = subprocess.run(
            cmd, input=script, text=True, capture_output=True,
            env=_pg_env(conn, True), timeout=QUERY_TIMEOUT + 5,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(408, "schema read timed out") from exc
    if proc.returncode != 0:
        raise HTTPException(400, _clean_error(proc.stderr or proc.stdout))
    return proc.stdout


def _pg_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    if psycopg is not None:
        columns = _columns(conn, schema, table)
        if not columns:
            return ""
        lines = []
        for column in columns:
            line = f'  {_ident(column["name"])} {column.get("type") or "text"}'
            if not column.get("nullable", True):
                line += " NOT NULL"
            if column.get("default") not in (None, ""):
                line += f' DEFAULT {column["default"]}'
            lines.append(line)
        keys = [column["name"] for column in columns if column.get("pk")]
        if keys:
            lines.append("  PRIMARY KEY (" + ", ".join(_ident(key) for key in keys) + ")")
        ddl = f'CREATE TABLE {_ident(schema)}.{_ident(table)} (\n' + ",\n".join(lines) + "\n);"
        for item in _indexes(conn, schema, table):
            definition = str(item.get("definition") or "")
            if definition and not item.get("primary"):
                ddl += "\n" + definition.rstrip().rstrip(";") + ";"
        return ddl
    return _pg_raw(conn, "\\d+ " + f"{_ident(schema)}.{_ident(table)}\n").strip()


def _my_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    sql = f"SHOW CREATE TABLE {_my_ident(schema)}.{_my_ident(table)}"
    if pymysql is not None:
        _, rows = _my_native_exec(conn, sql, readonly=True)
        return str(rows[0][1]) if rows and len(rows[0]) > 1 else ""
    out = _my_run(conn, sql, readonly=True)
    _, rows = _parse_my(out)
    return str(rows[0][1]) if rows and len(rows[0]) > 1 else ""


def _ch_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    payload = _ch_json(
        conn, f"SHOW CREATE TABLE {_ch_ident(schema)}.{_ch_ident(table)}", readonly=True
    )
    _, rows = _ch_result(payload)
    return str(rows[0][0]) if rows else ""


def _mcp_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    dialect = str(conn.get("mcp_dialect") or "postgres")
    quote = lambda name: _mcp_quote(dialect, name)
    columns = _mcp_columns(conn, schema, table)
    body = ",\n".join(
        f"  {quote(column['name'])} {column['type']}"
        + ("" if column.get("nullable", True) else " NOT NULL")
        for column in columns
    )
    return (
        f"-- MCP connection · {dialect} metadata\n"
        f"CREATE TABLE {quote(schema)}.{quote(table)} (\n{body}\n);"
    )


def _ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    kind = _kind(conn)
    if kind == "mcp":
        return _mcp_ddl(conn, schema, table)
    if kind == "http":
        return _http_ddl(conn, schema, table)
    if kind == "sqlite":
        return _sqlite_ddl(conn, schema, table)
    if kind == "mysql":
        return _my_ddl(conn, schema, table)
    if kind == "clickhouse":
        return _ch_ddl(conn, schema, table)
    return _pg_ddl(conn, schema, table)


def _parse_pg_result(out: str) -> tuple[list[dict[str, str]], list[list[Any]]]:
    types: dict[str, str] = {}
    data = out
    marker = "\nColumn,Type\n"
    idx = out.rfind(marker)
    if idx != -1:
        data = out[:idx]
        types = _parse_pg_types(out[idx + len(marker):])
    elif out.startswith("Column,Type\n"):
        data = ""
        types = _parse_pg_types(out[len("Column,Type\n"):])
    records = [r for r in csv.reader(io.StringIO(data)) if r]
    if not records:
        return [], []
    header = records[0]
    body = records[1:]
    columns = [{"name": name, "type": types.get(name, "")} for name in header]
    rows = [[None if v == NULL_SENTINEL else v for v in row] for row in body]
    return columns, rows


def _parse_pg_types(text: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for row in csv.reader(io.StringIO(text)):
        if len(row) >= 2 and row[0] != "Column":
            found[row[0]] = row[1]
    return found


def _pg_json(conn: dict[str, Any], sql: str) -> Any:
    out = _pg_run(conn, sql.rstrip().rstrip(";") + ";\n")
    records = list(csv.reader(io.StringIO(out)))
    if len(records) < 2 or not records[-1]:
        return None
    try:
        return json.loads(records[-1][0])
    except ValueError as exc:
        raise HTTPException(500, f"unexpected database output: {records[-1][0][:200]}") from exc


def _pg_test(conn: dict[str, Any]) -> dict[str, Any]:
    if psycopg is not None:
        _, rows = _pg_native_exec(
            conn,
            "SELECT version(), current_database(), current_user,"
            " current_setting('transaction_read_only')",
            readonly=False,
        )
        row = rows[0] if rows else ["", "", "", ""]
        return {"version": row[0], "database": row[1], "user": row[2]}
    return _pg_json(
        conn,
        "SELECT json_build_object('version', version(), 'database', current_database(),"
        " 'user', current_user, 'readonly', current_setting('transaction_read_only'))",
    )


def _pg_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    if psycopg is not None:
        return _pg_native_dicts(
            conn,
            """
            SELECT n.nspname AS schema,
                   c.relname AS name,
                   CASE c.relkind
                     WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
                     WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
                     WHEN 'f' THEN 'foreign table' ELSE 'table'
                   END AS kind,
                   GREATEST(c.reltuples, 0)::bigint AS est_rows
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','p','v','m','f')
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND n.nspname NOT LIKE 'pg_toast%'
              AND n.nspname NOT LIKE 'pg_temp%'
            ORDER BY n.nspname, c.relname
            """,
        )
    return _pg_json(
        conn,
        """
        SELECT coalesce(json_agg(x ORDER BY x.schema, x.name), '[]'::json) FROM (
          SELECT n.nspname AS schema,
                 c.relname AS name,
                 CASE c.relkind
                   WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
                   WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
                   WHEN 'f' THEN 'foreign table' ELSE 'table'
                 END AS kind,
                 GREATEST(c.reltuples, 0)::bigint AS est_rows
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r','p','v','m','f')
            AND n.nspname NOT IN ('pg_catalog','information_schema')
            AND n.nspname NOT LIKE 'pg_toast%'
            AND n.nspname NOT LIKE 'pg_temp%'
        ) x
        """,
    ) or []


def _pg_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    sql = f"""
        SELECT coalesce(json_agg(x ORDER BY x.ord), '[]'::json) FROM (
          SELECT a.attnum AS ord, a.attname AS name,
                 format_type(a.atttypid, a.atttypmod) AS type,
                 NOT a.attnotnull AS nullable,
                 pg_get_expr(d.adbin, d.adrelid) AS "default",
                 col_description(c.oid, a.attnum) AS comment,
                 CASE WHEN a.attidentity <> '' THEN 'identity'
                      WHEN a.attgenerated <> '' THEN 'generated'
                      ELSE '' END AS extra,
                 CASE WHEN a.attcollation <> 0
                      THEN (SELECT collname FROM pg_collation WHERE oid = a.attcollation)
                      ELSE NULL END AS collation,
                 NULL AS charset,
                 EXISTS (
                   SELECT 1 FROM pg_index i
                   WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)
                 ) AS pk,
                 (
                   SELECT json_build_object(
                     'schema', fn.nspname, 'table', fc.relname, 'column', fa.attname
                   )
                   FROM pg_constraint con
                   JOIN pg_class fc ON fc.oid = con.confrelid
                   JOIN pg_namespace fn ON fn.oid = fc.relnamespace
                   JOIN pg_attribute fa
                     ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[1]
                   WHERE con.contype = 'f' AND con.conrelid = c.oid
                     AND con.conkey[1] = a.attnum
                   LIMIT 1
                 ) AS fk
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = {_lit(schema)} AND c.relname = {_lit(table)}
            AND a.attnum > 0 AND NOT a.attisdropped
        ) x
        """
    if psycopg is not None:
        _, rows = _pg_native_exec(conn, sql, readonly=True)
        value = rows[0][0] if rows and rows[0] else None
        data = json.loads(value) if isinstance(value, str) else (value or [])
        for row in data:
            row.pop("ord", None)
        return data
    rows = _pg_json(conn, sql) or []
    for row in rows:
        row.pop("ord", None)
    return rows


def _pg_rows(conn, schema, table, limit, offset, order_by, direction, filters=None) -> dict[str, Any]:
    sql = f"SELECT * FROM {_ident(schema)}.{_ident(table)}"
    where = _where_clause("postgres", filters)
    if where:
        sql += f" WHERE {where}"
    if order_by:
        sql += f" ORDER BY {_ident(order_by)} {direction}"
    sql += f" LIMIT {limit + 1} OFFSET {offset}"
    started = time.monotonic()
    if psycopg is not None:
        columns, rows = _pg_native_exec(conn, sql, readonly=True, limit=limit)
        meta = {column["name"]: column.get("type", "") for column in _columns(conn, schema, table)}
        for column in columns:
            column["type"] = meta.get(column["name"], column["type"])
        return {
            "columns": columns, "rows": rows[:limit], "truncated": len(rows) > limit,
            "offset": offset, "limit": limit,
            "duration_ms": round((time.monotonic() - started) * 1000),
        }
    out = _pg_run(conn, sql + ";\n\\gdesc\n")
    columns, rows = _parse_pg_result(out)
    return {
        "columns": columns, "rows": rows[:limit], "truncated": len(rows) > limit,
        "offset": offset, "limit": limit,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _pg_query(conn, sql, limit, readonly) -> dict[str, Any]:
    is_read = bool(READ_SQL.match(sql))
    started = time.monotonic()
    if psycopg is not None:
        columns, rows = _pg_native_exec(
            conn, sql, readonly=readonly, limit=limit if is_read else 0
        )
        return {
            "columns": columns, "rows": rows[:limit], "truncated": len(rows) > limit,
            "command": "SELECT" if is_read else sql.split(None, 1)[0].upper(),
            "readonly": readonly,
            "duration_ms": round((time.monotonic() - started) * 1000),
        }
    if is_read:
        wrapped = f"SELECT * FROM (\n{sql}\n) AS dbdesk_q LIMIT {limit + 1};\n\\gdesc\n"
        try:
            out = _pg_run(conn, wrapped, readonly=readonly)
            columns, rows = _parse_pg_result(out)
        except HTTPException:
            out = _pg_run(conn, sql + ";\n\\gdesc\n", readonly=readonly)
            columns, rows = _parse_pg_result(out)
        return {
            "columns": columns, "rows": rows[:limit], "truncated": len(rows) > limit,
            "command": "SELECT", "readonly": readonly,
            "duration_ms": round((time.monotonic() - started) * 1000),
        }
    script = sql + ((";\n\\gdesc\n") if re.search(r"(?i)\breturning\b", sql) else ";\n")
    out = _pg_run(conn, script, readonly=readonly)
    columns, rows = _parse_pg_result(out) if "returning" in sql.lower() else ([], [])
    return {
        "columns": columns, "rows": rows, "truncated": False,
        "command": sql.split(None, 1)[0].upper(), "readonly": readonly,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _pg_mutation(conn, sql: str) -> None:
    if psycopg is not None:
        _pg_native_exec(conn, sql, readonly=False)
        return
    _pg_run(conn, sql + ";\n", readonly=False)


# --------------------------------------------------------------------------- #
# MySQL / MariaDB
# --------------------------------------------------------------------------- #

_FLAVOR: dict[str, str] = {}


def _my_env(conn: dict[str, Any]) -> dict[str, str]:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": os.path.expanduser("~"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "MYSQL_PWD": str(conn.get("password") or ""),
    }


def _my_exec(conn: dict[str, Any], sql: str, *, init: str | None = None, timeout: int = QUERY_TIMEOUT) -> str:
    cmd = [
        MYSQL, "--batch", "--connect-timeout=8",
        "-h", str(conn.get("host") or "127.0.0.1"),
        "-P", str(conn.get("port") or 3306),
        "-u", str(conn.get("user") or "root"),
        "-D", str(conn.get("dbname") or ""),
    ]
    if init:
        cmd += ["--init-command", init]
    cmd += ["-e", sql]
    try:
        proc = subprocess.run(
            cmd, text=True, capture_output=True, env=_my_env(conn), timeout=timeout + 5,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(408, f"query timed out after {timeout}s") from exc
    except OSError as exc:
        raise HTTPException(500, f"could not run mysql: {exc}") from exc
    if proc.returncode != 0:
        raise HTTPException(400, _clean_error(proc.stderr or proc.stdout))
    return proc.stdout


def _my_flavor(conn: dict[str, Any]) -> str:
    key = str(conn.get("id") or f"{conn.get('host')}:{conn.get('port')}")
    if key not in _FLAVOR:
        if pymysql is not None:
            _, rows = _my_native_exec(conn, "SELECT VERSION()", readonly=True)
            version = str(rows[0][0]) if rows and rows[0] else ""
        else:
            version = _my_exec(conn, "SELECT VERSION()", timeout=8)
        _FLAVOR[key] = "mariadb" if "mariadb" in version.lower() else "mysql"
    return _FLAVOR[key]


def _my_readonly_init(conn: dict[str, Any]) -> str:
    return "SET SESSION tx_read_only=1" if _my_flavor(conn) == "mariadb" else "SET SESSION transaction_read_only=1"


def _my_unescape(text: str) -> str:
    out: list[str] = []
    i = 0
    mapping = {"n": "\n", "t": "\t", "0": "\0", "r": "\r", "Z": "\x1a", "b": "\b", "\\": "\\"}
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            nxt = text[i + 1]
            out.append(mapping.get(nxt, nxt))
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _parse_my(out: str) -> tuple[list[dict[str, str]], list[list[Any]]]:
    lines = out.split("\n")
    while lines and lines[-1] == "":
        lines.pop()
    if not lines:
        return [], []
    header = [_my_unescape(cell) for cell in lines[0].split("\t")]
    rows: list[list[Any]] = []
    for line in lines[1:]:
        cells = [_my_unescape(cell) for cell in line.split("\t")]
        rows.append([None if cell == "NULL" else cell for cell in cells])
    return [{"name": name, "type": ""} for name in header], rows


def _my_run(conn: dict[str, Any], sql: str, *, readonly: bool, timeout: int = QUERY_TIMEOUT) -> str:
    init = _my_readonly_init(conn) if readonly else None
    return _my_exec(conn, sql, init=init, timeout=timeout)


def _my_test(conn: dict[str, Any]) -> dict[str, Any]:
    if pymysql is not None:
        _, rows = _my_native_exec(
            conn, "SELECT VERSION(), DATABASE(), CURRENT_USER()", readonly=True
        )
        row = rows[0] if rows else ["", "", ""]
        return {"version": row[0], "database": row[1], "user": row[2]}
    out = _my_exec(conn, "SELECT VERSION(), DATABASE(), CURRENT_USER()", timeout=8)
    columns, rows = _parse_my(out)
    row = rows[0] if rows else ["", "", ""]
    return {"version": row[0], "database": row[1], "user": row[2]}


def _my_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    sql = (
        "SELECT table_schema, table_name, "
        "CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END, "
        "COALESCE(table_rows, 0) "
        "FROM information_schema.tables "
        "WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') "
        f"  AND table_schema = {_my_lit(conn.get('dbname') or '')} "
        "ORDER BY table_schema, table_name"
    )
    if pymysql is not None:
        _, rows = _my_native_exec(conn, sql, readonly=True)
    else:
        out = _my_run(conn, sql, readonly=True)
        _, rows = _parse_my(out)
    return [
        {"schema": r[0], "name": r[1], "kind": r[2], "est_rows": int(r[3] or 0)}
        for r in rows
    ]


def _my_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    sql = (
        "SELECT c.column_name, c.column_type, c.is_nullable, c.column_default, c.column_key, "
        "c.character_set_name, c.collation_name, c.extra, c.column_comment, "
        "k.referenced_table_schema, k.referenced_table_name, k.referenced_column_name "
        "FROM information_schema.columns c "
        "LEFT JOIN information_schema.key_column_usage k "
        "  ON k.table_schema = c.table_schema AND k.table_name = c.table_name "
        " AND k.column_name = c.column_name AND k.referenced_table_name IS NOT NULL "
        f"WHERE c.table_schema = {_my_lit(schema)} AND c.table_name = {_my_lit(table)} "
        "ORDER BY c.ordinal_position"
    )
    if pymysql is not None:
        _, rows = _my_native_exec(conn, sql, readonly=True)
    else:
        out = _my_run(conn, sql, readonly=True)
        _, rows = _parse_my(out)
    result = []
    for r in rows:
        fk = None
        if len(r) > 11 and r[10]:
            fk = {"schema": r[9], "table": r[10], "column": r[11]}
        result.append(
            {
                "name": r[0],
                "type": r[1],
                "nullable": str(r[2]).upper() == "YES",
                "default": r[3],
                "pk": str(r[4]).upper() == "PRI",
                "fk": fk,
                "charset": r[5] or None,
                "collation": r[6] or None,
                "extra": r[7] or "",
                "comment": r[8] or None,
            }
        )
    return result


def _my_rows(conn, schema, table, limit, offset, order_by, direction, columns_meta, filters=None) -> dict[str, Any]:
    if pymysql is not None:
        exprs = "*"
    else:
        exprs = ", ".join(
            f"IF({_my_ident(c['name'])} IS NULL, '{NULL_SENTINEL}', {_my_ident(c['name'])}) AS {_my_ident(c['name'])}"
            for c in columns_meta
        ) or "*"
    sql = f"SELECT {exprs} FROM {_my_ident(schema)}.{_my_ident(table)}"
    where = _where_clause("mysql", filters)
    if where:
        sql += f" WHERE {where}"
    if order_by:
        sql += f" ORDER BY {_my_ident(order_by)} {direction}"
    sql += f" LIMIT {limit + 1} OFFSET {offset}"
    started = time.monotonic()
    types = {c["name"]: c.get("type", "") for c in columns_meta}
    if pymysql is not None:
        columns, rows = _my_native_exec(conn, sql, readonly=True, limit=limit)
        for column in columns:
            column["type"] = types.get(column["name"], column["type"])
    else:
        out = _my_run(conn, sql, readonly=True)
        _, rows = _parse_my(out)
        columns = [{"name": c["name"], "type": types.get(c["name"], "")} for c in columns_meta]
        rows = [[None if v == NULL_SENTINEL else v for v in row] for row in rows]
    return {
        "columns": columns, "rows": rows[:limit], "truncated": len(rows) > limit,
        "offset": offset, "limit": limit,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _my_query(conn, sql, limit, readonly) -> dict[str, Any]:
    _guard_readonly(conn, sql)
    is_read = bool(READ_SQL.match(sql))
    started = time.monotonic()
    if pymysql is not None:
        columns, rows = _my_native_exec(
            conn, sql, readonly=readonly, limit=limit if is_read else 0
        )
        return {
            "columns": columns, "rows": rows[:limit], "truncated": len(rows) > limit,
            "command": "SELECT" if is_read else sql.split(None, 1)[0].upper(),
            "readonly": readonly,
            "duration_ms": round((time.monotonic() - started) * 1000),
        }
    if is_read:
        wrapped = f"SELECT * FROM (\n{sql}\n) AS dbdesk_q LIMIT {limit + 1}"
        try:
            out = _my_run(conn, wrapped, readonly=readonly)
            columns, rows = _parse_my(out)
        except HTTPException:
            out = _my_run(conn, sql, readonly=readonly)
            columns, rows = _parse_my(out)
        return {
            "columns": columns, "rows": rows[:limit], "truncated": len(rows) > limit,
            "command": "SELECT", "readonly": readonly,
            "duration_ms": round((time.monotonic() - started) * 1000),
        }
    out = _my_run(conn, sql, readonly=readonly)
    columns, rows = _parse_my(out) if re.search(r"(?i)\breturning\b", sql) else ([], [])
    return {
        "columns": columns, "rows": rows, "truncated": False,
        "command": sql.split(None, 1)[0].upper(), "readonly": readonly,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _my_mutation(conn, sql: str) -> None:
    if pymysql is not None:
        _my_native_exec(conn, sql, readonly=False)
        return
    _my_run(conn, sql, readonly=False)


# --------------------------------------------------------------------------- #
# ClickHouse
# --------------------------------------------------------------------------- #


CH_HEADER_DENY = {"host", "content-length", "connection", "transfer-encoding"}
CH_HEADER_LINE = re.compile(r"^([A-Za-z0-9-]+):\s*(.*)$")


def _parse_ch_headers(raw: Any, *, strict: bool = False) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in str(raw or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = CH_HEADER_LINE.match(line)
        if not match:
            if strict:
                raise HTTPException(400, "ClickHouse headers must be 'Name: value' per line")
            continue
        name, value = match.group(1), match.group(2).strip()
        if name.lower() in CH_HEADER_DENY:
            if strict:
                raise HTTPException(400, f"header {name} is managed by DB Desk")
            continue
        headers[name] = value[:4000]
    return headers


def _ch_url(conn: dict[str, Any], readonly: bool) -> str:
    secure = str(conn.get("sslmode") or "") in ("require", "verify-ca", "verify-full")
    scheme = "https" if secure else "http"
    host = str(conn.get("host") or "127.0.0.1")
    port = str(conn.get("port") or 8123)
    path = str(conn.get("ch_path") or "/").strip() or "/"
    if not path.startswith("/"):
        path = "/" + path
    query = {"database": str(conn.get("dbname") or "default"), "default_format": "JSONCompact"}
    if readonly:
        query["readonly"] = "1"
    query["max_execution_time"] = str(QUERY_TIMEOUT)
    return f"{scheme}://{host}:{port}{path}?{urllib.parse.urlencode(query)}"


def _ch_request(conn: dict[str, Any], sql: str, *, readonly: bool = True, timeout: int = QUERY_TIMEOUT) -> str:
    headers = {
        "X-ClickHouse-User": str(conn.get("user") or "default"),
        "X-ClickHouse-Key": str(conn.get("password") or ""),
        "Content-Type": "text/plain; charset=utf-8",
        **_parse_ch_headers(conn.get("ch_headers")),
    }
    request = urllib.request.Request(
        _ch_url(conn, readonly), data=sql.encode("utf-8"), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout + 5) as response:
            return response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise HTTPException(400, _clean_error(body)) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(502, f"ClickHouse request failed: {exc}") from exc


def _ch_json(conn: dict[str, Any], sql: str, *, readonly: bool = True) -> Any:
    text = _ch_request(conn, sql.rstrip().rstrip(";"), readonly=readonly).strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError as exc:
        raise HTTPException(500, f"unexpected ClickHouse output: {text[:200]}") from exc


def _ch_result(payload: Any) -> tuple[list[dict[str, str]], list[list[Any]]]:
    if not isinstance(payload, dict):
        return [], []
    columns = [
        {"name": str(meta.get("name", "")), "type": str(meta.get("type", ""))}
        for meta in payload.get("meta") or []
    ]
    rows = payload.get("data") or []
    return columns, [list(row) for row in rows]


def _ch_test(conn: dict[str, Any]) -> dict[str, Any]:
    payload = _ch_json(
        conn,
        "SELECT version() AS version, currentDatabase() AS database, currentUser() AS user",
        readonly=True,
    )
    columns, rows = _ch_result(payload)
    row = rows[0] if rows else ["", "", ""]
    return {"version": row[0], "database": row[1], "user": row[2]}


def _ch_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    payload = _ch_json(
        conn,
        "SELECT database AS schema, name, engine, total_rows FROM system.tables "
        "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        f"  AND database = {_ch_lit(conn.get('dbname') or '')} "
        "ORDER BY database, name",
        readonly=True,
    )
    _, rows = _ch_result(payload)
    return [
        {
            "schema": r[0], "name": r[1],
            "kind": "table", "engine": r[2], "est_rows": int(r[3] or 0),
        }
        for r in rows
    ]


def _ch_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    payload = _ch_json(
        conn,
        "SELECT name, type, is_in_primary_key, is_in_sorting_key, default_expression, "
        "default_kind, comment "
        "FROM system.columns "
        f"WHERE database = {_ch_lit(schema)} AND table = {_ch_lit(table)} "
        "ORDER BY position",
        readonly=True,
    )
    _, rows = _ch_result(payload)
    out = []
    for r in rows:
        out.append({
            "name": r[0],
            "type": r[1],
            "nullable": str(r[1]).startswith("Nullable("),
            "default": r[4] or None,
            "pk": bool(int(r[2] or 0)) or bool(int(r[3] or 0)),
            "charset": None,
            "collation": None,
            "extra": r[5] or "",
            "comment": r[6] or None,
        })
    return out


def _ch_rows(conn, schema, table, limit, offset, order_by, direction, filters=None) -> dict[str, Any]:
    sql = f"SELECT * FROM {_ch_ident(schema)}.{_ch_ident(table)}"
    where = _where_clause("clickhouse", filters)
    if where:
        sql += f" WHERE {where}"
    if order_by:
        sql += f" ORDER BY {_ch_ident(order_by)} {direction}"
    sql += f" LIMIT {limit + 1} OFFSET {offset}"
    started = time.monotonic()
    payload = _ch_json(conn, sql, readonly=True)
    columns, rows = _ch_result(payload)
    return {
        "columns": columns, "rows": rows[:limit], "truncated": len(rows) > limit,
        "offset": offset, "limit": limit,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _ch_query(conn, sql, limit, readonly) -> dict[str, Any]:
    _guard_readonly(conn, sql)
    is_read = bool(READ_SQL.match(sql))
    started = time.monotonic()
    if is_read:
        wrapped = f"SELECT * FROM (\n{sql}\n) AS dbdesk_q LIMIT {limit + 1}"
        try:
            payload = _ch_json(conn, wrapped, readonly=readonly)
        except HTTPException:
            payload = _ch_json(conn, sql, readonly=readonly)
    else:
        payload = _ch_json(conn, sql, readonly=False)
    columns, rows = _ch_result(payload)
    return {
        "columns": columns, "rows": rows[:limit], "truncated": len(rows) > limit,
        "command": "SELECT" if is_read else sql.split(None, 1)[0].upper(),
        "readonly": readonly,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _ch_mutation(conn, sql: str) -> None:
    _ch_request(conn, sql, readonly=False)


# --------------------------------------------------------------------------- #
# SQLite (single file, no server)
# --------------------------------------------------------------------------- #


def _sqlite_lit(value: Any) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "X'" + bytes(value).hex() + "'"
    return "'" + str(value).replace("'", "''") + "'"


def _sqlite_ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def _sqlite_file(conn: dict[str, Any]) -> str:
    path = str(conn.get("dbname") or "").strip()
    if not path:
        raise HTTPException(400, "SQLite database file is required")
    return os.path.abspath(os.path.expanduser(path))


def _sqlite_open(conn: dict[str, Any], *, readonly: bool = True) -> sqlite3.Connection:
    path = _sqlite_file(conn)
    if not os.path.exists(path):
        raise HTTPException(404, f"SQLite database file not found: {path}")
    if not os.path.isfile(path):
        raise HTTPException(400, f"SQLite path is not a file: {path}")
    uri = "file:" + urllib.parse.quote(path, safe="/") + ("?mode=ro" if readonly else "?mode=rw")
    try:
        db = sqlite3.connect(uri, uri=True, timeout=10)
    except sqlite3.Error as exc:
        raise HTTPException(400, f"SQLite: {exc}") from exc
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA busy_timeout = 5000")
    except sqlite3.Error:
        pass
    return db


def _sqlite_cell(value: Any) -> Any:
    """JSON-friendly cell value: BLOBs become UTF-8 text or a hex literal."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return "0x" + raw.hex()
    return value


def _sqlite_typeof(values: list[Any]) -> str:
    for value in values:
        if value is None:
            continue
        if isinstance(value, bool):
            return "BOOLEAN"
        if isinstance(value, int):
            return "INTEGER"
        if isinstance(value, float):
            return "REAL"
        if isinstance(value, (bytes, bytearray, memoryview)):
            return "BLOB"
        return "TEXT"
    return ""


def _sqlite_test(conn: dict[str, Any]) -> dict[str, Any]:
    db = _sqlite_open(conn, readonly=True)
    try:
        version = db.execute("SELECT sqlite_version()").fetchone()[0]
        tables = db.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchone()[0]
    except sqlite3.Error as exc:
        raise HTTPException(400, f"SQLite: {exc}") from exc
    finally:
        db.close()
    return {
        "version": f"SQLite {version} · {int(tables)} table(s)",
        "database": _sqlite_file(conn),
        "user": "sqlite",
    }


def _sqlite_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    db = _sqlite_open(conn, readonly=True)
    try:
        rows = db.execute(
            "SELECT type, name FROM sqlite_master "
            "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' "
            "ORDER BY name"
        ).fetchall()
    except sqlite3.Error as exc:
        raise HTTPException(400, f"SQLite: {exc}") from exc
    finally:
        db.close()
    return [
        {
            "schema": "main",
            "name": str(row["name"]),
            "kind": "view" if str(row["type"]) == "view" else "table",
            "est_rows": 0,
        }
        for row in rows
    ]


def _sqlite_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    db = _sqlite_open(conn, readonly=True)
    try:
        info = db.execute(f"PRAGMA table_info({_sqlite_lit(table)})").fetchall()
        fks: dict[str, dict[str, Any]] = {}
        try:
            for row in db.execute(f"PRAGMA foreign_key_list({_sqlite_lit(table)})").fetchall():
                fks[str(row["from"])] = {
                    "schema": "main",
                    "table": str(row["table"]),
                    "column": str(row["to"]),
                }
        except sqlite3.Error:
            pass
    except sqlite3.Error as exc:
        raise HTTPException(400, f"SQLite: {exc}") from exc
    finally:
        db.close()
    return [
        {
            "name": str(row["name"]),
            "type": str(row["type"] or ""),
            "nullable": not bool(row["notnull"]) and not bool(row["pk"]),
            "default": row["dflt_value"],
            "pk": bool(row["pk"]),
            "fk": fks.get(str(row["name"])),
            "charset": None,
            "collation": None,
            "extra": "",
            "comment": None,
        }
        for row in info
    ]


def _sqlite_rows(
    conn, schema, table, limit, offset, order_by, direction, filters=None
) -> dict[str, Any]:
    meta = {column["name"]: column.get("type", "") for column in _columns(conn, schema, table)}
    sql = f"SELECT * FROM {_sqlite_ident(table)}"
    where = _where_clause("sqlite", filters)
    if where:
        sql += f" WHERE {where}"
    if order_by:
        sql += f" ORDER BY {_sqlite_ident(order_by)} {direction}"
    sql += f" LIMIT {limit + 1} OFFSET {offset}"
    started = time.monotonic()
    db = _sqlite_open(conn, readonly=True)
    try:
        cursor = db.execute(sql)
        names = [column[0] for column in cursor.description or []]
        rows = [[_sqlite_cell(value) for value in row] for row in cursor.fetchmany(limit + 1)]
    except sqlite3.Error as exc:
        raise HTTPException(400, f"SQLite: {exc}") from exc
    finally:
        db.close()
    columns = [{"name": name, "type": meta.get(name, "")} for name in names]
    return {
        "columns": columns, "rows": rows[:limit], "truncated": len(rows) > limit,
        "offset": offset, "limit": limit,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _sqlite_query(conn, sql, limit, readonly) -> dict[str, Any]:
    _guard_readonly(conn, sql)
    is_read = bool(READ_SQL.match(sql))
    started = time.monotonic()
    db = _sqlite_open(conn, readonly=readonly)
    try:
        cursor = db.execute(sql)
        if cursor.description:
            names = [column[0] for column in cursor.description]
            rows = [[_sqlite_cell(value) for value in row] for row in cursor.fetchmany(limit + 1)]
        else:
            names, rows = [], []
        if not is_read:
            db.commit()
    except sqlite3.Error as exc:
        raise HTTPException(400, f"SQLite: {exc}") from exc
    finally:
        db.close()
    return {
        "columns": [
            {
                "name": name,
                "type": _sqlite_typeof([row[index] for row in rows[:20]]),
            }
            for index, name in enumerate(names)
        ],
        "rows": rows[:limit],
        "truncated": len(rows) > limit,
        "command": "SELECT" if is_read else sql.split(None, 1)[0].upper(),
        "readonly": readonly,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _sqlite_exec(conn: dict[str, Any], statements: list[str]) -> None:
    """Run statements in one write transaction (sqlite3 allows one at a time)."""
    db = _sqlite_open(conn, readonly=False)
    try:
        with db:
            for statement in statements:
                db.execute(statement)
    except sqlite3.Error as exc:
        raise HTTPException(400, f"SQLite: {exc}") from exc
    finally:
        db.close()


def _sqlite_mutation(conn, sql: str) -> None:
    _sqlite_exec(conn, [sql])


def _sqlite_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    db = _sqlite_open(conn, readonly=True)
    try:
        row = db.execute(
            "SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')",
            (table,),
        ).fetchone()
    except sqlite3.Error as exc:
        raise HTTPException(400, f"SQLite: {exc}") from exc
    finally:
        db.close()
    return str(row[0]) if row and row[0] else ""


def _sqlite_indexes(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    db = _sqlite_open(conn, readonly=True)
    try:
        listing = db.execute(f"PRAGMA index_list({_sqlite_lit(table)})").fetchall()
        result = []
        for row in listing:
            name = str(row["name"])
            columns = [
                str(info["name"])
                for info in db.execute(f"PRAGMA index_info({_sqlite_lit(name)})").fetchall()
            ]
            result.append(
                {
                    "name": name,
                    "unique": bool(row["unique"]),
                    "algorithm": "BTREE",
                    "columns": ", ".join(columns),
                    "column_names": columns,
                    "primary": str(row["origin"]) == "pk",
                }
            )
    except sqlite3.Error as exc:
        raise HTTPException(400, f"SQLite: {exc}") from exc
    finally:
        db.close()
    return result


def _index_meta(row: dict[str, Any], definition: str) -> None:
    """Parse a PostgreSQL index definition into algorithm + columns."""
    method = re.search(r"USING\s+(\w+)", definition, re.I)
    row["algorithm"] = method.group(1).lower() if method else ""
    match = re.search(r"\(([^()]*)\)", definition)
    names: list[str] = []
    if match:
        for part in match.group(1).split(","):
            name = part.strip().split(" ")[0].strip('"')
            if name:
                names.append(name)
    row["column_names"] = names


def _indexes(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    kind = _kind(conn)
    if kind in ("mcp", "http"):
        return []
    if kind == "sqlite":
        return _sqlite_indexes(conn, schema, table)
    if kind == "mysql":
        rows = _my_rows_sql(
            conn,
            "SELECT index_name, non_unique, index_type, "
            "GROUP_CONCAT(column_name ORDER BY seq_in_index) "
            "FROM information_schema.statistics "
            f"WHERE table_schema = {_my_lit(schema)} AND table_name = {_my_lit(table)} "
            "GROUP BY index_name, non_unique ORDER BY index_name",
        )
        return [
            {
                "name": r[0],
                "unique": str(r[1]) == "0",
                "algorithm": str(r[2] or ""),
                "columns": str(r[3] or ""),
                "column_names": [part.strip() for part in str(r[3] or "").split(",") if part.strip()],
                "primary": str(r[0]).upper() == "PRIMARY",
            }
            for r in rows
        ]
    if kind == "clickhouse":
        return []
    if kind == "postgres" and psycopg is not None:
        rows = _pg_native_dicts(
            conn,
            "SELECT indexname AS name, indexdef AS definition FROM pg_indexes "
            f"WHERE schemaname = {_lit(schema)} AND tablename = {_lit(table)} "
            "ORDER BY indexname",
        )
        for row in rows:
            definition = str(row.get("definition") or "")
            row["unique"] = "UNIQUE INDEX" in definition
            row["columns"] = definition
            row["primary"] = row["name"].endswith("_pkey") or "PRIMARY KEY" in definition
            _index_meta(row, definition)
        return rows
    rows = _pg_json(
        conn,
        f"""
        SELECT coalesce(json_agg(x ORDER BY x.name), '[]'::json) FROM (
          SELECT indexname AS name, indexdef AS definition
          FROM pg_indexes
          WHERE schemaname = {_lit(schema)} AND tablename = {_lit(table)}
        ) x
        """,
    ) or []
    for row in rows:
        definition = str(row.get("definition") or "")
        row["unique"] = "UNIQUE INDEX" in definition
        row["columns"] = definition
        row["primary"] = row["name"].endswith("_pkey") or "PRIMARY KEY" in definition
        _index_meta(row, definition)
    return rows


def _activity(conn: dict[str, Any]) -> list[dict[str, Any]]:
    kind = _kind(conn)
    if kind in ("mcp", "http", "sqlite"):
        return []
    if kind == "mysql":
        out = _my_run(
            conn,
            "SELECT id, user, db, command, time, state, LEFT(info, 500) "
            "FROM information_schema.processlist "
            "WHERE id <> CONNECTION_ID() ORDER BY time DESC",
            readonly=True,
        )
        _, rows = _parse_my(out)
        return [
            {
                "id": r[0],
                "user": r[1],
                "database": r[2],
                "state": r[5] or r[3],
                "seconds": float(r[4] or 0),
                "query": r[6],
            }
            for r in rows
        ]
    if kind == "mysql" and pymysql is not None:
        _, rows = _my_native_exec(
            conn,
            "SELECT id, user, db, command, time, state, LEFT(info, 500) "
            "FROM information_schema.processlist "
            "WHERE id <> CONNECTION_ID() ORDER BY time DESC",
            readonly=True,
        )
        return [
            {
                "id": row[0],
                "user": row[1],
                "database": row[2],
                "state": row[5] or row[3],
                "seconds": float(row[4] or 0),
                "query": row[6],
            }
            for row in rows
        ]
    if kind == "clickhouse":
        payload = _ch_json(
            conn,
            "SELECT query_id, user, elapsed, read_rows, left(query, 500) "
            "FROM system.processes ORDER BY elapsed DESC",
            readonly=True,
        )
        _, rows = _ch_result(payload)
        return [
            {
                "id": r[0],
                "user": r[1],
                "database": "",
                "state": f"{r[2]}s · {r[3]} rows",
                "seconds": float(r[2] or 0),
                "query": r[4],
            }
            for r in rows
        ]
    if psycopg is not None:
        return _pg_native_dicts(
            conn,
            """
            SELECT pid AS id, usename AS "user", datname AS database, state,
                   extract(epoch FROM (now() - query_start)) AS seconds,
                   left(query, 500) AS query
            FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
            ORDER BY seconds DESC NULLS LAST
            """,
        )
    rows = _pg_json(
        conn,
        """
        SELECT coalesce(json_agg(x ORDER BY x.seconds DESC NULLS LAST), '[]'::json) FROM (
          SELECT pid AS id, usename AS "user", datname AS database, state,
                 round(extract(epoch from (now() - query_start))::numeric, 1) AS seconds,
                 left(query, 500) AS query
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
        ) x
        """,
    ) or []
    return rows


# --------------------------------------------------------------------------- #
# MCP over HTTP (standalone) — JSON-RPC + OAuth (PKCE, loopback redirect)
# --------------------------------------------------------------------------- #

MCP_PROTOCOL = "2025-06-18"
_MCP_SESSIONS: dict[str, dict[str, Any]] = {}
_MCP_FLOWS: dict[str, dict[str, Any]] = {}
_MCP_GUARD = threading.Lock()


def _mcp_tokens_path() -> Path:
    return _data_dir() / "mcp_tokens.json"


def _load_mcp_tokens() -> dict[str, Any]:
    path = _mcp_tokens_path()
    if not path.exists():
        return {"servers": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"servers": {}}
    servers = data.get("servers") if isinstance(data, dict) else None
    return {"servers": servers if isinstance(servers, dict) else {}}


def _save_mcp_tokens(data: dict[str, Any]) -> None:
    path = _mcp_tokens_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _mcp_http_json(
    url: str,
    *,
    payload: Any = None,
    form: Any = None,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
) -> Any:
    request_headers = {"Accept": "application/json", "User-Agent": "DB Desk"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    elif form is not None:
        body = urllib.parse.urlencode(form).encode("utf-8")
        request_headers["Content-Type"] = "application/x-www-form-urlencoded"
    else:
        body = None
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(
        url, data=body, headers=request_headers, method="POST" if body is not None else "GET"
    )
    try:
        with urllib.request.urlopen(
            request, timeout=timeout, context=_ssl_context()
        ) as response:
            text = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise HTTPException(502, f"{url} returned {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise HTTPException(502, f"cannot reach {url}: {exc.reason}") from exc
    if not text.strip():
        return {}
    try:
        return json.loads(text)
    except ValueError as exc:
        raise HTTPException(502, f"{url} returned non-JSON") from exc


def _mcp_discovery(url: str) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(400, "MCP server URL must be http:// or https://")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    resource = None
    for candidate in (
        origin + "/.well-known/oauth-protected-resource",
        origin + "/.well-known/oauth-protected-resource" + (parsed.path or ""),
    ):
        try:
            resource = _mcp_http_json(candidate, timeout=15)
            break
        except HTTPException:
            continue
    issuer = origin
    scope = "mcp"
    resource_url = url
    if isinstance(resource, dict):
        resource_url = str(resource.get("resource") or url)
        servers = resource.get("authorization_servers") or []
        if servers:
            issuer = str(servers[0])
        if resource.get("scopes_supported"):
            scope = " ".join(str(item) for item in resource["scopes_supported"])
    meta = None
    for candidate in (
        issuer.rstrip("/") + "/.well-known/oauth-authorization-server",
        issuer.rstrip("/") + "/.well-known/openid-configuration",
    ):
        try:
            meta = _mcp_http_json(candidate, timeout=15)
            break
        except HTTPException:
            continue
    if not isinstance(meta, dict) or not meta.get("authorization_endpoint") or not meta.get("token_endpoint"):
        raise HTTPException(400, "could not discover OAuth endpoints for this MCP server")
    return {
        "authorization_endpoint": str(meta["authorization_endpoint"]),
        "token_endpoint": str(meta["token_endpoint"]),
        "registration_endpoint": str(meta.get("registration_endpoint") or ""),
        "scope": str(meta.get("scope") or scope),
        "resource": resource_url,
        "issuer": issuer,
    }


def _mcp_register(meta: dict[str, Any], redirect_uri: str) -> str:
    endpoint = meta.get("registration_endpoint") or ""
    if not endpoint:
        raise HTTPException(
            400,
            "this MCP server does not support dynamic client registration; "
            "register a client manually and set mcp_client_id",
        )
    payload = _mcp_http_json(
        endpoint,
        payload={
            "client_name": "DB Desk",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": meta.get("scope") or "mcp",
        },
    )
    client_id = str(payload.get("client_id") or "") if isinstance(payload, dict) else ""
    if not client_id:
        raise HTTPException(502, "MCP client registration returned no client_id")
    return client_id


def _mcp_save_server(url: str, meta: dict[str, Any], client_id: str, payload: dict[str, Any]) -> None:
    data = _load_mcp_tokens()
    entry = data["servers"].get(url) or {}
    entry.update(
        {
            "client_id": client_id,
            "token_endpoint": meta["token_endpoint"],
            "resource": meta.get("resource") or url,
            "scope": meta.get("scope") or "",
            "access_enc": _encrypt(str(payload.get("access_token") or "")),
            "expires_at": time.time() + int(payload.get("expires_in") or 3600),
        }
    )
    if payload.get("refresh_token"):
        entry["refresh_enc"] = _encrypt(str(payload["refresh_token"]))
    data["servers"][url] = entry
    _save_mcp_tokens(data)


def _mcp_access_token(url: str) -> str:
    data = _load_mcp_tokens()
    entry = data["servers"].get(url)
    if not isinstance(entry, dict) or not entry.get("access_enc"):
        return ""
    if float(entry.get("expires_at") or 0) > time.time() + 60:
        return _decrypt(str(entry["access_enc"]))
    if not entry.get("refresh_enc"):
        return ""
    try:
        payload = _mcp_http_json(
            str(entry["token_endpoint"]),
            form={
                "grant_type": "refresh_token",
                "refresh_token": _decrypt(str(entry["refresh_enc"])),
                "client_id": str(entry.get("client_id") or ""),
                "resource": str(entry.get("resource") or url),
            },
        )
    except HTTPException:
        return ""
    if not isinstance(payload, dict) or not payload.get("access_token"):
        return ""
    entry["access_enc"] = _encrypt(str(payload["access_token"]))
    if payload.get("refresh_token"):
        entry["refresh_enc"] = _encrypt(str(payload["refresh_token"]))
    entry["expires_at"] = time.time() + int(payload.get("expires_in") or 3600)
    data["servers"][url] = entry
    _save_mcp_tokens(data)
    return str(payload["access_token"])


def _mcp_page(message: str) -> bytes:
    html = (
        "<!doctype html><meta charset=utf-8><title>DB Desk</title>"
        "<style>body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;"
        "display:grid;place-items:center;height:100vh;margin:0;color:#1f2328}"
        "div{max-width:380px;text-align:center;line-height:1.5}</style>"
        f"<div><h2>DB Desk</h2><p>{message}</p></div>"
    )
    return html.encode("utf-8")


def _mcp_oauth_start(url: str) -> dict[str, Any]:
    url = url.strip()
    meta = _mcp_discovery(url)
    state = pysecrets.token_urlsafe(24)
    verifier = pysecrets.token_urlsafe(64)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("utf-8")).digest())
        .rstrip(b"=")
        .decode("ascii")
    )

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            if parsed.path != "/callback":
                self._send(404, "Not found")
                return
            if params.get("state", [""])[0] != state:
                self._send(400, "State mismatch. Start the authorization again.")
                return
            error = params.get("error", [""])[0]
            if error:
                self._send(400, f"Authorization failed: {error}")
            else:
                flow = _MCP_FLOWS.get(state) or {}
                try:
                    payload = _mcp_http_json(
                        flow["meta"]["token_endpoint"],
                        form={
                            "grant_type": "authorization_code",
                            "code": params.get("code", [""])[0],
                            "redirect_uri": flow["redirect"],
                            "client_id": flow["client_id"],
                            "code_verifier": flow["verifier"],
                            "resource": flow["meta"].get("resource") or url,
                        },
                    )
                    _mcp_save_server(url, flow["meta"], flow["client_id"], payload)
                    self._send(200, "Connected. You can close this window and return to DB Desk.")
                except Exception as exc:  # noqa: BLE001
                    self._send(400, f"Token exchange failed: {exc}")
            threading.Thread(target=server.shutdown, daemon=True).start()

        def _send(self, status: int, message: str) -> None:
            body = _mcp_page(message)
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            return

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = int(server.server_address[1])
    redirect_uri = f"http://127.0.0.1:{port}/callback"
    client_id = _mcp_register(meta, redirect_uri)
    _MCP_FLOWS[state] = {
        "url": url,
        "meta": meta,
        "client_id": client_id,
        "redirect": redirect_uri,
        "verifier": verifier,
    }
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "scope": meta.get("scope") or "mcp",
    }
    if meta.get("resource"):
        params["resource"] = meta["resource"]
    endpoint = meta["authorization_endpoint"]
    auth_url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(params)

    threading.Thread(target=server.serve_forever, daemon=True).start()

    def stop_later() -> None:
        time.sleep(300)
        try:
            server.shutdown()
        except Exception:
            pass

    threading.Thread(target=stop_later, daemon=True).start()
    try:
        import webbrowser

        webbrowser.open(auth_url)
    except Exception:
        pass
    return {"auth_url": auth_url, "state": state}


def _mcp_post(
    url: str, payload: dict[str, Any], token: str, session_id: str = ""
) -> tuple[Any, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "DB Desk",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(
            request, timeout=QUERY_TIMEOUT, context=_ssl_context()
        ) as response:
            content_type = response.headers.get_content_type()
            session = response.headers.get("Mcp-Session-Id") or session_id
            body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise HTTPException(401, "mcp_auth_required: authorize this MCP server") from exc
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise HTTPException(502, f"MCP returned {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise HTTPException(502, f"MCP unreachable: {exc.reason}") from exc
    if not body.strip():
        return None, session
    message = None
    if content_type == "text/event-stream" or body.lstrip().startswith("data:"):
        for line in body.splitlines():
            if not line.startswith("data:"):
                continue
            chunk = line[5:].strip()
            if not chunk:
                continue
            try:
                parsed = json.loads(chunk)
            except ValueError:
                continue
            if parsed.get("id") == payload.get("id") or "result" in parsed or "error" in parsed:
                message = parsed
                break
        if message is None:
            raise HTTPException(502, "MCP event stream had no matching response")
    else:
        try:
            message = json.loads(body)
        except ValueError as exc:
            raise HTTPException(502, "MCP returned non-JSON") from exc
    if message.get("error"):
        error = message["error"]
        text = error.get("message") if isinstance(error, dict) else str(error)
        raise HTTPException(400, f"MCP error: {text}"[:1000])
    return message.get("result"), session


def _mcp_session(url: str, token: str) -> str:
    with _MCP_GUARD:
        entry = _MCP_SESSIONS.get(url)
    if entry and entry.get("token") == token:
        return str(entry.get("session") or "")
    payload = {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": "DB Desk", "version": "0.3.0"},
        },
    }
    result, session = _mcp_post(url, payload, token)
    try:
        _mcp_post(url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, token, session or "")
    except HTTPException:
        pass
    with _MCP_GUARD:
        _MCP_SESSIONS[url] = {
            "session": session or "",
            "token": token,
            "protocol": (result or {}).get("protocolVersion") if isinstance(result, dict) else "",
        }
    return session or ""


def _mcp_native_call(conn: dict[str, Any], sql: str) -> Any:
    url = str(conn.get("mcp_url") or "").strip()
    tool = str(conn.get("mcp_tool") or "query").strip() or "query"
    argument = str(conn.get("mcp_sql_arg") or "sql").strip() or "sql"
    arguments: dict[str, Any] = {argument: sql}
    extra = str(conn.get("mcp_extra_args") or "").strip()
    if extra:
        try:
            parsed = json.loads(extra)
        except ValueError as exc:
            raise HTTPException(400, "MCP extra arguments must be a JSON object") from exc
        if not isinstance(parsed, dict):
            raise HTTPException(400, "MCP extra arguments must be a JSON object")
        arguments.update(parsed)
    token = _mcp_access_token(url)
    session = _mcp_session(url, token)
    result, _ = _mcp_post(
        url,
        {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        },
        token,
        session,
    )
    if result is None:
        raise HTTPException(502, "MCP returned an empty result")
    if isinstance(result, dict) and result.get("isError"):
        text = "\n".join(
            str(block.get("text", ""))
            for block in result.get("content") or []
            if isinstance(block, dict)
        )
        raise HTTPException(400, text[:1000] or "MCP tool reported an error")
    return result


def _mcp_status(url: str) -> dict[str, Any]:
    data = _load_mcp_tokens()
    entry = data["servers"].get(url) or {}
    authorized = bool(entry.get("access_enc"))
    return {
        "authorized": authorized,
        "expires_at": entry.get("expires_at"),
        "scope": entry.get("scope") or "",
    }


# --------------------------------------------------------------------------- #
# MCP (query tool) transport
# --------------------------------------------------------------------------- #


def _mcp_allowlist() -> list[str]:
    try:
        from hermes_cli.config import load_config

        config = load_config() or {}
    except Exception:
        return []
    entries = ((config.get("plugins") or {}).get("entries") or {})
    entry = entries.get("dbdesk") or {}
    allow = entry.get("mcp_allowlist") or []
    return [str(item) for item in allow] if isinstance(allow, list) else []


def _parse_markdown_table(text: str):
    lines = [line.strip() for line in text.splitlines() if line.strip().startswith("|")]
    if len(lines) < 2:
        return None

    def cells(line: str):
        return [cell.strip() for cell in line.strip("|").split("|")]

    header = cells(lines[0])
    body = []
    for line in lines[1:]:
        parts = cells(line)
        if parts and all(set(part) <= set("-: ") for part in parts):
            continue
        body.append(parts)
    return [{"name": name} for name in header], body


def _mcp_table(value: Any):
    if isinstance(value, dict):
        if "structuredContent" in value:
            return _mcp_table(value["structuredContent"])
        if isinstance(value.get("content"), list):
            text = "\n".join(
                str(block.get("text", ""))
                for block in value["content"]
                if isinstance(block, dict)
            )
            return _mcp_table(text)
        if "columns" in value and "rows" in value:
            columns = [
                {"name": str(column.get("name") if isinstance(column, dict) else column)}
                for column in value["columns"]
            ]
            return columns, [list(row) for row in value["rows"]]
        for key in ("rows", "data", "result"):
            if key in value:
                return _mcp_table(value[key])
        return [{"name": key} for key in value], [[value[key] for key in value]]
    if isinstance(value, list):
        if not value:
            return [], []
        if all(isinstance(item, dict) for item in value):
            names: list[str] = []
            for item in value:
                for key in item:
                    if key not in names:
                        names.append(key)
            return [{"name": name} for name in names], [
                [item.get(name) for name in names] for item in value
            ]
        if all(isinstance(item, list) for item in value):
            width = max(len(item) for item in value)
            return [{"name": f"c{index + 1}"} for index in range(width)], [
                list(item) + [None] * (width - len(item)) for item in value
            ]
        return [{"name": "result"}], [[item] for item in value]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            parsed = None
        if parsed is not None:
            return _mcp_table(parsed)
        table = _parse_markdown_table(value)
        return table if table else ([{"name": "result"}], [[value]])
    return [{"name": "result"}], [[value]]


def _mcp_call(conn: dict[str, Any], sql: str) -> Any:
    url = str(conn.get("mcp_url") or "").strip()
    if url:
        return _mcp_native_call(conn, sql)
    server = str(conn.get("mcp_server") or "").strip()
    tool = str(conn.get("mcp_tool") or "query").strip() or "query"
    argument = str(conn.get("mcp_sql_arg") or "sql").strip() or "sql"
    if not server:
        raise HTTPException(400, "MCP connection has no server configured")
    if server not in _mcp_allowlist():
        raise HTTPException(
            403,
            f"MCP server {server!r} is not allowed for dbdesk. Add it to "
            f"plugins.entries.dbdesk.mcp_allowlist in config.yaml.",
        )
    try:
        from tools.mcp_tool_handlers import _make_tool_handler
    except Exception as exc:
        raise HTTPException(500, f"MCP client unavailable: {exc}") from exc
    try:
        raw = _make_tool_handler(server, tool, QUERY_TIMEOUT)({argument: sql})
    except Exception as exc:
        raise HTTPException(502, f"MCP call failed: {exc}") from exc
    return _mcp_unwrap(raw)


def _mcp_unwrap(raw: Any) -> Any:
    text = raw if isinstance(raw, str) else json.dumps(raw)
    try:
        data = json.loads(text)
    except ValueError:
        return text
    if isinstance(data, dict):
        if data.get("error"):
            raise HTTPException(400, str(data["error"])[:1000])
        if "structuredContent" in data:
            return data["structuredContent"]
        if "result" in data:
            return data["result"]
    return data


def _mcp_query(conn: dict[str, Any], sql: str, limit: int = MAX_ROWS) -> dict[str, Any]:
    started = time.monotonic()
    value = _mcp_call(conn, sql)
    columns, rows = _mcp_table(value)
    return {
        "columns": columns,
        "rows": rows[:limit],
        "truncated": len(rows) > limit,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _mcp_dicts(result: dict[str, Any]) -> list[dict[str, Any]]:
    names = [column["name"] for column in result["columns"]]
    return [dict(zip(names, row)) for row in result["rows"]]


def _mcp_bool(value: Any) -> bool:
    return str(value).strip().lower() in ("1", "true", "t", "yes", "y")


def _mcp_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    dialect = str(conn.get("mcp_dialect") or "postgres")
    if dialect == "mysql":
        sql = (
            "SELECT table_schema AS schema, table_name AS name, "
            "CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END AS kind, "
            "COALESCE(table_rows, 0) AS est_rows "
            "FROM information_schema.tables "
            "WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') "
            "ORDER BY 1, 2"
        )
    elif dialect == "clickhouse":
        sql = (
            "SELECT database AS schema, name, engine AS kind, total_rows AS est_rows "
            "FROM system.tables "
            "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
            "ORDER BY 1, 2"
        )
    else:
        sql = (
            "SELECT n.nspname AS schema, c.relname AS name, "
            "CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind, "
            "GREATEST(c.reltuples, 0)::bigint AS est_rows "
            "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE c.relkind IN ('r','p','v','m','f') "
            "AND n.nspname NOT IN ('pg_catalog','information_schema') "
            "ORDER BY 1, 2"
        )
    rows = _mcp_dicts(_mcp_query(conn, sql, 5000))
    return [
        {
            "schema": str(row.get("schema") or ""),
            "name": str(row.get("name") or ""),
            "kind": str(row.get("kind") or "table"),
            "est_rows": int(row.get("est_rows") or 0),
        }
        for row in rows
        if row.get("schema") and row.get("name")
    ]


def _mcp_lit(value: Any) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _mcp_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    dialect = str(conn.get("mcp_dialect") or "postgres")
    if dialect == "mysql":
        sql = (
            "SELECT c.column_name AS name, c.column_type AS type, c.is_nullable AS nullable, "
            "c.column_default AS `default`, (c.column_key = 'PRI') AS pk "
            "FROM information_schema.columns c "
            f"WHERE c.table_schema = {_mcp_lit(schema)} AND c.table_name = {_mcp_lit(table)} "
            "ORDER BY c.ordinal_position"
        )
    elif dialect == "clickhouse":
        sql = (
            "SELECT name, type, startsWith(type, 'Nullable(') AS nullable, "
            "default_expression AS `default`, "
            "(is_in_primary_key OR is_in_sorting_key) AS pk "
            "FROM system.columns "
            f"WHERE database = {_mcp_lit(schema)} AND table = {_mcp_lit(table)} "
            "ORDER BY position"
        )
    else:
        sql = (
            "SELECT c.column_name AS name, c.data_type AS type, "
            "(c.is_nullable = 'YES') AS nullable, c.column_default AS \"default\", "
            "EXISTS (SELECT 1 FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu "
            "ON kcu.constraint_name = tc.constraint_name "
            "AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name "
            "WHERE tc.constraint_type = 'PRIMARY KEY' "
            "AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name "
            "AND kcu.column_name = c.column_name) AS pk "
            "FROM information_schema.columns c "
            f"WHERE c.table_schema = {_mcp_lit(schema)} AND c.table_name = {_mcp_lit(table)} "
            "ORDER BY c.ordinal_position"
        )
    rows = _mcp_dicts(_mcp_query(conn, sql, 2000))
    return [
        {
            "name": str(row.get("name") or ""),
            "type": str(row.get("type") or ""),
            "nullable": _mcp_bool(row.get("nullable")),
            "default": row.get("default"),
            "pk": _mcp_bool(row.get("pk")),
            "fk": None,
        }
        for row in rows
        if row.get("name")
    ]


def _mcp_quote(dialect: str, name: str) -> str:
    if dialect == "mysql" or dialect == "clickhouse":
        return "`" + str(name).replace("`", "``") + "`"
    return '"' + str(name).replace('"', '""') + '"'


def _mcp_rows(conn, schema, table, limit, offset, order_by, direction, filters=None):
    dialect = str(conn.get("mcp_dialect") or "postgres")
    target = f"{_mcp_quote(dialect, schema)}.{_mcp_quote(dialect, table)}"
    sql = f"SELECT * FROM {target}"
    where = _where_clause(
        dialect if dialect in ("postgres", "mysql", "clickhouse") else "postgres", filters
    )
    if where:
        sql += f" WHERE {where}"
    if order_by:
        sql += f" ORDER BY {_mcp_quote(dialect, order_by)} {direction}"
    sql += f" LIMIT {limit + 1} OFFSET {offset}"
    result = _mcp_query(conn, sql, limit + 1)
    rows = result["rows"]
    return {
        "columns": result["columns"],
        "rows": rows[:limit],
        "truncated": len(rows) > limit,
        "offset": offset,
        "limit": limit,
        "duration_ms": result["duration_ms"],
    }


def _mcp_test(conn: dict[str, Any]) -> dict[str, Any]:
    result = _mcp_query(conn, "SELECT 1 AS ok", 1)
    label = conn.get("mcp_url") or conn.get("mcp_server") or "mcp"
    return {
        "version": f"MCP · {label} · {conn.get('mcp_tool') or 'query'}",
        "database": conn.get("dbname") or "",
        "user": "mcp",
        "probe": result["rows"][:1],
    }


def _mcp_databases(conn: dict[str, Any]) -> list[str]:
    return [str(conn.get("dbname") or "mcp")]


# --------------------------------------------------------------------------- #
# HTTP query gateway transport
# --------------------------------------------------------------------------- #


def _http_headers(conn: dict[str, Any]) -> dict[str, str]:
    raw = conn.get("http_headers")
    if isinstance(raw, dict):
        return {str(key): str(value) for key, value in raw.items()}
    headers: dict[str, str] = {}
    for line in str(raw or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if key and value:
            headers[key] = value
    return headers


def _http_query(conn: dict[str, Any], sql: str, limit: int = MAX_ROWS) -> dict[str, Any]:
    url = str(conn.get("http_url") or "").strip()
    if not url:
        raise HTTPException(400, "HTTP connection has no URL configured")
    method = str(conn.get("http_method") or "POST").strip().upper()
    if method not in ("GET", "POST"):
        method = "POST"
    field = str(conn.get("http_sql_field") or "sql").strip() or "sql"
    headers = {
        "Accept": "application/json",
        "User-Agent": "dbdesk/0.1",
        **_http_headers(conn),
    }
    data: bytes | None = None
    body_mode = str(conn.get("http_body_mode") or "json").strip().lower()
    if method == "GET":
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}{urllib.parse.urlencode({field: sql})}"
    elif body_mode == "raw":
        data = sql.encode("utf-8")
        headers["Content-Type"] = "text/plain; charset=utf-8"
    else:
        data = json.dumps({field: sql}).encode("utf-8")
        headers["Content-Type"] = "application/json"
    timeout = max(5, min(int(conn.get("http_timeout") or 30), 120))
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise HTTPException(400, _clean_error(detail)) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(502, f"HTTP query gateway failed: {exc}") from exc
    try:
        parsed = json.loads(body)
    except ValueError:
        parsed = body
    if isinstance(parsed, dict) and isinstance(parsed.get("meta"), list) and "data" in parsed:
        columns = [
            {"name": str(meta.get("name", "")), "type": str(meta.get("type", ""))}
            for meta in parsed["meta"]
            if isinstance(meta, dict)
        ]
        raw_rows = parsed.get("data") or []
        if raw_rows and isinstance(raw_rows[0], dict):
            rows = [
                [row.get(meta.get("name")) for meta in parsed["meta"] if isinstance(meta, dict)]
                for row in raw_rows
            ]
        else:
            rows = [list(row) for row in raw_rows]
    else:
        if isinstance(parsed, dict):
            if parsed.get("error"):
                raise HTTPException(400, str(parsed["error"])[:1000])
            for key in ("structuredContent", "result", "data"):
                if key in parsed:
                    parsed = parsed[key]
                    break
        columns, rows = _mcp_table(parsed)
    return {
        "columns": columns,
        "rows": rows[:limit],
        "truncated": len(rows) > limit,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _http_test(conn: dict[str, Any]) -> dict[str, Any]:
    result = _http_query(conn, "SELECT 1 AS ok", 1)
    return {
        "version": f"HTTP · {conn.get('http_url')}",
        "database": conn.get("dbname") or "",
        "user": conn.get("user") or "http",
        "probe": result["rows"][:1],
    }


def _http_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    dialect = str(conn.get("http_dialect") or "postgres")
    if dialect == "mysql":
        sql = (
            "SELECT table_schema AS schema, table_name AS name, "
            "CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END AS kind, "
            "COALESCE(table_rows, 0) AS est_rows "
            "FROM information_schema.tables "
            "WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') "
            "ORDER BY 1, 2"
        )
    elif dialect == "clickhouse":
        sql = (
            "SELECT database AS schema, name, engine AS kind, total_rows AS est_rows "
            "FROM system.tables "
            "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
            "ORDER BY 1, 2"
        )
    else:
        sql = (
            "SELECT n.nspname AS schema, c.relname AS name, "
            "CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind, "
            "GREATEST(c.reltuples, 0)::bigint AS est_rows "
            "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE c.relkind IN ('r','p','v','m','f') "
            "AND n.nspname NOT IN ('pg_catalog','information_schema') "
            "ORDER BY 1, 2"
        )
    rows = _mcp_dicts(_http_query(conn, sql, 5000))
    return [
        {
            "schema": str(row.get("schema") or ""),
            "name": str(row.get("name") or ""),
            "kind": str(row.get("kind") or "table"),
            "est_rows": int(row.get("est_rows") or 0),
        }
        for row in rows
        if row.get("schema") and row.get("name")
    ]


def _http_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    dialect = str(conn.get("http_dialect") or "postgres")
    if dialect == "mysql":
        sql = (
            "SELECT c.column_name AS name, c.column_type AS type, c.is_nullable AS nullable, "
            "c.column_default AS `default`, (c.column_key = 'PRI') AS pk "
            "FROM information_schema.columns c "
            f"WHERE c.table_schema = {_mcp_lit(schema)} AND c.table_name = {_mcp_lit(table)} "
            "ORDER BY c.ordinal_position"
        )
    elif dialect == "clickhouse":
        sql = (
            "SELECT name, type, startsWith(type, 'Nullable(') AS nullable, "
            "default_expression AS `default`, "
            "(is_in_primary_key OR is_in_sorting_key) AS pk "
            "FROM system.columns "
            f"WHERE database = {_mcp_lit(schema)} AND table = {_mcp_lit(table)} "
            "ORDER BY position"
        )
    else:
        sql = (
            "SELECT c.column_name AS name, c.data_type AS type, "
            "(c.is_nullable = 'YES') AS nullable, c.column_default AS \"default\", "
            "EXISTS (SELECT 1 FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu "
            "ON kcu.constraint_name = tc.constraint_name "
            "AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name "
            "WHERE tc.constraint_type = 'PRIMARY KEY' "
            "AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name "
            "AND kcu.column_name = c.column_name) AS pk "
            "FROM information_schema.columns c "
            f"WHERE c.table_schema = {_mcp_lit(schema)} AND c.table_name = {_mcp_lit(table)} "
            "ORDER BY c.ordinal_position"
        )
    rows = _mcp_dicts(_http_query(conn, sql, 2000))
    return [
        {
            "name": str(row.get("name") or ""),
            "type": str(row.get("type") or ""),
            "nullable": _mcp_bool(row.get("nullable")),
            "default": row.get("default"),
            "pk": _mcp_bool(row.get("pk")),
            "fk": None,
        }
        for row in rows
        if row.get("name")
    ]


def _http_rows(conn, schema, table, limit, offset, order_by, direction, filters=None):
    dialect = str(conn.get("http_dialect") or "postgres")
    target = f"{_mcp_quote(dialect, schema)}.{_mcp_quote(dialect, table)}"
    sql = f"SELECT * FROM {target}"
    where = _where_clause(
        dialect if dialect in ("postgres", "mysql", "clickhouse") else "postgres", filters
    )
    if where:
        sql += f" WHERE {where}"
    if order_by:
        sql += f" ORDER BY {_mcp_quote(dialect, order_by)} {direction}"
    sql += f" LIMIT {limit + 1} OFFSET {offset}"
    result = _http_query(conn, sql, limit + 1)
    rows = result["rows"]
    return {
        "columns": result["columns"],
        "rows": rows[:limit],
        "truncated": len(rows) > limit,
        "offset": offset,
        "limit": limit,
        "duration_ms": result["duration_ms"],
    }


def _http_databases(conn: dict[str, Any]) -> list[str]:
    return [str(conn.get("dbname") or "http")]


def _http_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    dialect = str(conn.get("http_dialect") or "postgres")
    quote = lambda name: _mcp_quote(dialect, name)
    columns = _http_columns(conn, schema, table)
    body = ",\n".join(
        f"  {quote(column['name'])} {column['type']}"
        + ("" if column.get("nullable", True) else " NOT NULL")
        for column in columns
    )
    return (
        f"-- HTTP connection · {dialect} metadata\n"
        f"CREATE TABLE {quote(schema)}.{quote(table)} (\n{body}\n);"
    )


# --------------------------------------------------------------------------- #
# dispatch
# --------------------------------------------------------------------------- #


def _kind(conn: dict[str, Any]) -> str:
    kind = str(conn.get("kind") or "postgres")
    return kind if kind in KINDS else "postgres"


def _test(conn: dict[str, Any]) -> dict[str, Any]:
    kind = _kind(conn)
    if kind == "mcp":
        return _mcp_test(conn)
    if kind == "http":
        return _http_test(conn)
    if kind == "sqlite":
        return _sqlite_test(conn)
    if kind == "mysql":
        return _my_test(conn)
    if kind == "clickhouse":
        return _ch_test(conn)
    return _pg_test(conn)


def _tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    kind = _kind(conn)
    if kind == "mcp":
        return _mcp_tree(conn)
    if kind == "http":
        return _http_tree(conn)
    if kind == "sqlite":
        return _sqlite_tree(conn)
    if kind == "mysql":
        return _my_tree(conn)
    if kind == "clickhouse":
        return _ch_tree(conn)
    return _pg_tree(conn)


def _columns_live(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    kind = _kind(conn)
    if kind == "mcp":
        return _mcp_columns(conn, schema, table)
    if kind == "http":
        return _http_columns(conn, schema, table)
    if kind == "sqlite":
        return _sqlite_columns(conn, schema, table)
    if kind == "mysql":
        return _my_columns(conn, schema, table)
    if kind == "clickhouse":
        return _ch_columns(conn, schema, table)
    return _pg_columns(conn, schema, table)


# Column metadata is fetched for every table view and, for MySQL, again inside
# the rows query. A short-lived cache turns those repeats into memory reads.
_COLUMN_CACHE: dict[tuple, tuple[float, list[dict[str, Any]]]] = {}
COLUMN_CACHE_TTL = 60.0
COLUMN_CACHE_MAX = 600


def _invalidate_columns() -> None:
    _COLUMN_CACHE.clear()


_COLUMN_LOCKS: dict[tuple, "threading.Lock"] = {}
_COLUMN_LOCKS_GUARD = threading.Lock()


def _columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    key = (
        str(conn.get("id") or ""),
        _kind(conn),
        str(conn.get("dbname") or ""),
        str(schema),
        str(table),
    )
    now = time.monotonic()
    hit = _COLUMN_CACHE.get(key)
    if hit and now - hit[0] < COLUMN_CACHE_TTL:
        return [dict(column) for column in hit[1]]

    # The page fires /columns and /table/rows together on every table open.
    # Coalesce those two lookups so only one metadata query runs.
    with _COLUMN_LOCKS_GUARD:
        lock = _COLUMN_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _COLUMN_LOCKS[key] = lock
    with lock:
        now = time.monotonic()
        hit = _COLUMN_CACHE.get(key)
        if hit and now - hit[0] < COLUMN_CACHE_TTL:
            return [dict(column) for column in hit[1]]
        result = _columns_live(conn, schema, table)
        if len(_COLUMN_CACHE) >= COLUMN_CACHE_MAX:
            oldest = min(_COLUMN_CACHE, key=lambda item: _COLUMN_CACHE[item][0])
            _COLUMN_CACHE.pop(oldest, None)
        _COLUMN_CACHE[key] = (now, [dict(column) for column in result])
        return result


def _rows(conn, schema, table, limit, offset, order_by, direction, filters=None) -> dict[str, Any]:
    kind = _kind(conn)
    if kind == "mcp":
        return _mcp_rows(conn, schema, table, limit, offset, order_by, direction, filters)
    if kind == "http":
        return _http_rows(conn, schema, table, limit, offset, order_by, direction, filters)
    if kind == "sqlite":
        return _sqlite_rows(conn, schema, table, limit, offset, order_by, direction, filters)
    if kind == "mysql":
        return _my_rows(
            conn, schema, table, limit, offset, order_by, direction,
            _columns(conn, schema, table), filters,
        )
    if kind == "clickhouse":
        return _ch_rows(conn, schema, table, limit, offset, order_by, direction, filters)
    return _pg_rows(conn, schema, table, limit, offset, order_by, direction, filters)


def _query(conn, sql, limit, readonly) -> dict[str, Any]:
    kind = _kind(conn)
    if kind == "mcp":
        _guard_readonly(conn, sql)
        return _mcp_query(conn, sql, limit)
    if kind == "http":
        _guard_readonly(conn, sql)
        return _http_query(conn, sql, limit)
    if kind == "sqlite":
        return _sqlite_query(conn, sql, limit, readonly)
    if kind == "mysql":
        return _my_query(conn, sql, limit, readonly)
    if kind == "clickhouse":
        return _ch_query(conn, sql, limit, readonly)
    _guard_readonly(conn, sql)
    return _pg_query(conn, sql, limit, readonly)


# --------------------------------------------------------------------------- #
# AI setup assistant (connection picker)
# --------------------------------------------------------------------------- #

SETUP_FIELDS = {
    "kind", "name", "group", "host", "port", "dbname", "user", "sslmode",
    "ssh_host", "ssh_user", "ssh_port", "tunnel_command",
    "http_url", "http_method", "http_dialect", "mcp_url", "mcp_tool",
}
SETUP_KINDS = {"postgres", "mysql", "clickhouse", "sqlite", "http"}
SECRET_HINTS = ("pass", "secret", "token", "key", "cookie", "auth", "header", "env")


def _ai_setup_sanitize(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    draft: dict[str, Any] = {}
    for key, item in value.items():
        name = str(key)
        lowered = name.lower()
        if name not in SETUP_FIELDS or any(hint in lowered for hint in SECRET_HINTS):
            continue
        if name == "kind":
            kind = str(item or "").lower()
            if kind not in SETUP_KINDS:
                continue
            draft[name] = kind
        elif name in ("port", "ssh_port"):
            try:
                draft[name] = int(item)
            except (TypeError, ValueError):
                continue
        elif item not in (None, ""):
            draft[name] = str(item)[:200]
    return draft


def _ai_setup(question: str, history: Any) -> dict[str, Any]:
    config = _load_ai_config()
    system = (
        "You are DB Desk's connection setup assistant. Help the user fill a database "
        "connection form. Reply with JSON only: "
        '{"answer": "<short reply, ask a clarifying question if needed>", '
        '"draft": {<connection fields>}}. '
        "Allowed draft fields: kind (postgres, mysql, clickhouse, sqlite, http), name, group, "
        "host, port, dbname, user, sslmode, ssh_host, ssh_user, ssh_port, tunnel_command, "
        "http_url, http_method, http_dialect. "
        "NEVER include a password, token, cookie, header value, private key or secret in the "
        "answer or draft; the user types secrets into the form. Omit unknown fields. "
        "Defaults: postgres 5432, mysql 3306, clickhouse 8123; use ssh_* only when the user "
        "mentions a tunnel/bastion."
    )
    messages = [{"role": "system", "content": system}]
    messages.extend(_ai_history(history))
    messages.append({"role": "user", "content": question})
    payload = {
        "model": config.get("model") or AI_DEFAULT_MODEL,
        "temperature": 0,
        "messages": messages,
        "response_format": {"type": "json_object"},
    }
    data = _ai_post(config, payload)
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise HTTPException(502, "unexpected response from the AI provider") from exc
    parsed = _ai_extract_json(str(content))
    answer = str(parsed.get("answer") or "").strip()[:2000]
    draft = _ai_setup_sanitize(parsed.get("draft"))
    if not answer and not draft:
        raise HTTPException(502, "the AI returned no setup suggestion")
    return {"answer": answer, "draft": draft}


# --------------------------------------------------------------------------- #
# Multi-database agent (discovery -> plan -> local join)
# --------------------------------------------------------------------------- #

AI_AGENT_STEPS = 4
AI_AGENT_MAX_SOURCES = 3
AI_AGENT_MAX_ROWS = 500
AI_AGENT_SOURCE_ROWS = 5000
AI_AGENT_JOIN_MS = 5000
AI_KINDS = ("postgres", "mysql", "clickhouse", "sqlite")
AI_NUMERIC_HINTS = (
    "int", "serial", "float", "double", "decimal", "numeric", "real",
    "number", "money", "year",
)


def _ai_kind_ok(conn: dict[str, Any]) -> bool:
    return _kind(conn) in AI_KINDS


def _ai_scope(ids: Any) -> list[dict[str, Any]]:
    """AI-enabled connections, optionally restricted to a set of ids.

    A connection is AI-enabled unless ``ai_schema`` was switched off. Only
    schema-capable kinds are eligible; MCP/HTTP connections stay manual.
    """
    explicit = ids is not None
    wanted = {str(value) for value in (ids or []) if str(value).strip()}
    out: list[dict[str, Any]] = []
    for conn in _load():
        if not _ai_kind_ok(conn):
            continue
        if explicit and conn["id"] not in wanted:
            continue
        if not bool(conn.get("ai_schema", True)):
            continue
        out.append(dict(conn, kind=_kind(conn)))
    return out


def _ai_catalog_entry(conn: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(conn.get("id") or ""),
        "name": str(conn.get("name") or ""),
        "group": str(conn.get("group") or ""),
        "kind": _kind(conn),
        "dbname": str(conn.get("dbname") or ""),
        "query": bool(conn.get("ai_query", True)),
    }


def _ai_describe(conn: dict[str, Any], tables: Any) -> str:
    label = str(conn.get("name") or conn.get("id") or "")
    head = f"DATABASE {label} (kind={_kind(conn)}, db={conn.get('dbname') or ''})"
    wanted = [str(value) for value in (tables or []) if str(value).strip()][:6]
    try:
        tree = _tree(conn)
    except HTTPException as exc:
        return head + f"\nCould not read schema: {exc.detail}"
    if not wanted:
        names = [f"{row.get('schema')}.{row.get('name')}" for row in tree][:80]
        return head + "\nTables: " + (", ".join(names) if names else "(none)")
    lines = [head]
    for value in wanted:
        schema, _, table = value.rpartition(".")
        matches = [
            row for row in tree
            if str(row.get("name")) == (table or value)
            and (not schema or str(row.get("schema")) == schema)
        ][:1]
        if not matches:
            lines.append(f"{value}: not found")
            continue
        row = matches[0]
        try:
            columns = _columns(conn, str(row.get("schema")), str(row.get("name")))
        except HTTPException as exc:
            lines.append(f"{value}: columns unavailable ({exc.detail})")
            continue
        body = ", ".join(
            f"{column.get('name')} {column.get('type') or ''}".strip()
            for column in columns[:80]
        )
        lines.append(f"COLUMNS {row.get('schema')}.{row.get('name')}: {body}")
    return "\n".join(lines)[:16000]


def _ai_agent_system(
    catalog: list[dict[str, Any]],
    current: dict[str, Any] | None,
    schema: str,
    table: str,
    question: str,
) -> str:
    today = datetime.date.today().isoformat()
    focus = ""
    if current is not None:
        focus = _ai_schema_context(current, schema, table, question)
    lines = []
    for entry in catalog:
        current_tag = " (current)" if current is not None and entry["id"] == current.get("id") else ""
        group = f' group="{entry["group"]}"' if entry["group"] else ""
        lines.append(
            f'- id={entry["id"]} name="{entry["name"]}" kind={entry["kind"]} '
            f'db="{entry["dbname"]}"{group} '
            f'query={"yes" if entry["query"] else "no"}{current_tag}'
        )
    return (
        "You are DB Desk's database agent. You can inspect and query several databases, "
        "then join their results locally. Never ask for, output or infer credentials. "
        "Reply with exactly one JSON object and no prose.\n\n"
        "CURRENT DATABASE\n" + (focus or "(none)") + "\n\n"
        "AI-ENABLED DATABASES\n" + ("\n".join(lines) or "(none)") + "\n\n"
        "Actions:\n"
        '1. {"action":"describe","requests":[{"connection":"<id>","tables":["schema.table"]}]} '
        "when you need tables or columns that are not described yet. Omit tables to list them; "
        "at most 3 requests.\n"
        '2. {"action":"run","sources":[{"connection":"<id>","sql":"<statement>"}],'
        '"join_sql":"<optional>","explanation":"<one sentence>"} '
        "to answer with data. Each source SQL uses that database's own dialect and must be "
        "read-only. For 2-3 sources also return join_sql: a SQLite query (read-only) over the "
        "local temporary tables src_0, src_1, ... built from the returned columns. Rows are "
        "joined on this Mac and are never sent to you.\n"
        '3. {"action":"answer","answer":"<short reply>"} for greetings or non-data questions.\n'
        "Rules: no INSERT/UPDATE/DELETE/DDL, one statement per source, quote identifiers when "
        "needed, add LIMIT 500 to detail rows, use today's date " + today + " for relative dates, "
        "and only use tables/columns you have seen. If the answer spans another listed database, "
        "include it in the same plan instead of asking the user to pick."
    )


def _ai_unique_names(columns: list[dict[str, Any]]) -> list[str]:
    seen: dict[str, int] = {}
    out: list[str] = []
    for index, column in enumerate(columns):
        name = str(column.get("name") or f"col_{index + 1}")
        count = seen.get(name, 0) + 1
        seen[name] = count
        out.append(name if count == 1 else f"{name}_{count}")
    return out


def _ai_sqlite_type(value: Any) -> str:
    kind = str(value or "").lower()
    return "NUMERIC" if any(hint in kind for hint in AI_NUMERIC_HINTS) else "TEXT"


def _ai_join_cell(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str)
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, (str, int, float)) or value is None:
        return value
    return str(value)


def _ai_local_join(results: list[dict[str, Any]], join_sql: str) -> dict[str, Any]:
    """Join per-database result sets inside an in-memory SQLite database.

    Only SQL and row counts travel to the provider; the rows themselves are
    loaded into temp tables ``src_0``, ``src_1`` ... and never leave the Mac.
    """
    sql = _check_sql(join_sql)
    if not READ_SQL.match(sql):
        raise HTTPException(400, "the local join must be a read-only SQLite query")
    db = sqlite3.connect(":memory:")
    started = time.monotonic()
    deadline = started + AI_AGENT_JOIN_MS / 1000
    columns: list[dict[str, Any]] = []
    rows: list[list[Any]] = []
    try:
        for index, result in enumerate(results):
            source_columns = result.get("columns") or []
            if not source_columns:
                raise HTTPException(400, f"source {index + 1} returned no columns")
            names = _ai_unique_names(source_columns)
            types = [_ai_sqlite_type(column.get("type")) for column in source_columns]
            body = ", ".join(f'"{name}" {kind}' for name, kind in zip(names, types))
            db.execute(f'CREATE TABLE "src_{index}" ({body})')
            placeholders = ", ".join("?" for _ in names)
            db.executemany(
                f'INSERT INTO "src_{index}" VALUES ({placeholders})',
                [[_ai_join_cell(value) for value in row] for row in result.get("rows") or []],
            )
        db.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 2000)
        try:
            cursor = db.execute(f"SELECT * FROM (\n{sql}\n) LIMIT {AI_AGENT_MAX_ROWS + 1}")
            rows = [list(row) for row in cursor.fetchall()]
            columns = [{"name": desc[0], "type": ""} for desc in cursor.description or []]
        except sqlite3.OperationalError as exc:
            if "interrupted" in str(exc).lower():
                raise HTTPException(
                    400, f"local join timed out after {AI_AGENT_JOIN_MS} ms"
                ) from exc
            raise
    except sqlite3.Error as exc:
        raise HTTPException(400, f"local join failed: {exc}") from exc
    finally:
        db.close()
    return {
        "columns": columns,
        "rows": rows[:AI_AGENT_MAX_ROWS],
        "truncated": len(rows) > AI_AGENT_MAX_ROWS,
        "join_ms": round((time.monotonic() - started) * 1000),
    }


def _ai_agent_source(conn: dict[str, Any], sql: str) -> dict[str, Any]:
    wrapped = f"SELECT * FROM (\n{sql}\n) AS dbdesk_ai LIMIT {AI_AGENT_SOURCE_ROWS + 1}"
    readonly_conn = dict(conn, readonly=True)
    started = time.monotonic()
    try:
        result = _query(readonly_conn, wrapped, AI_AGENT_SOURCE_ROWS, True)
    except HTTPException as exc:
        _audit(conn, "ai_read", sql, ok=False, error=str(exc.detail), notify=False)
        raise
    rows = result.get("rows") or []
    _audit(conn, "ai_read", sql, rows=len(rows), ok=True, notify=False)
    return {
        "connection": str(conn.get("id") or ""),
        "name": str(conn.get("name") or conn.get("id") or ""),
        "kind": _kind(conn),
        "sql": sql,
        "columns": result.get("columns") or [],
        "rows": rows[:AI_AGENT_SOURCE_ROWS],
        "truncated": bool(result.get("truncated")) or len(rows) > AI_AGENT_SOURCE_ROWS,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _ai_agent(body: dict[str, Any]) -> dict[str, Any]:
    question = str(body.get("question") or "").strip()[:2000]
    if not question:
        raise HTTPException(400, "question is required")
    scope = _ai_scope(body.get("connection_ids"))
    if not scope:
        raise HTTPException(
            400, "no AI-enabled database connections; enable AI in a connection's settings"
        )
    scope_map = {conn["id"]: conn for conn in scope}
    current: dict[str, Any] | None = None
    current_id = str(body.get("connection_id") or "")
    if current_id and current_id in scope_map:
        try:
            current = _get(current_id)
        except HTTPException:
            current = scope_map[current_id]
        if not _ai_kind_ok(current):
            current = None
    schema = str(body.get("schema") or "")
    table = str(body.get("table") or "")
    catalog = [_ai_catalog_entry(conn) for conn in scope]
    system = _ai_agent_system(catalog, current, schema, table, question)
    config = _load_ai_config()
    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    messages.extend(_ai_history(body.get("history")))
    messages.append({"role": "user", "content": question})
    steps: list[str] = []
    started = time.monotonic()
    last_error = ""

    for _attempt in range(AI_AGENT_STEPS):
        payload = {
            "model": config.get("model") or AI_DEFAULT_MODEL,
            "temperature": 0,
            "messages": messages,
            "response_format": {"type": "json_object"},
        }
        data = _ai_post(config, payload)
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise HTTPException(502, "unexpected response from the AI provider") from exc
        parsed = _ai_extract_json(str(content))
        action = str(parsed.get("action") or "").strip().lower()
        if not action:
            action = "run" if parsed.get("sql") else "answer"

        if action == "answer":
            answer = str(parsed.get("answer") or parsed.get("explanation") or "").strip()
            if not answer:
                raise HTTPException(502, "the AI returned an empty answer")
            return {
                "sql": "",
                "explanation": answer[:2000],
                "columns": [],
                "rows": [],
                "sources": [],
                "steps": steps,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
            }

        if action == "describe":
            requests = parsed.get("requests")
            if not isinstance(requests, list) or not requests:
                raise HTTPException(502, "the AI asked for schema without listing requests")
            chunks: list[str] = []
            for item in requests[:3]:
                if not isinstance(item, dict):
                    continue
                cid = str(item.get("connection") or current_id or "")
                conn = scope_map.get(cid)
                if conn is None:
                    chunks.append(f"connection {cid}: not in the AI scope")
                    continue
                chunks.append(_ai_describe(conn, item.get("tables")))
                steps.append(f"inspected {conn.get('name') or cid}")
            messages.append({"role": "assistant", "content": json.dumps(parsed)})
            messages.append(
                {
                    "role": "user",
                    "content": "SCHEMA RESULTS\n\n" + "\n\n".join(chunks)
                    + "\n\nReply with the next JSON action.",
                }
            )
            continue

        if action == "run":
            sources = parsed.get("sources")
            if not isinstance(sources, list) or not sources:
                # tolerate a single legacy-style {"sql": ...}
                if parsed.get("sql"):
                    sources = [{"connection": current_id, "sql": parsed.get("sql")}]
                else:
                    raise HTTPException(502, "the AI returned no SQL sources")
            plan: list[tuple[dict[str, Any], str]] = []
            problem = ""
            for item in sources[:AI_AGENT_MAX_SOURCES]:
                if not isinstance(item, dict):
                    problem = "a source was not an object"
                    break
                cid = str(item.get("connection") or current_id or "")
                conn = scope_map.get(cid)
                if conn is None:
                    problem = f"connection {cid!r} is not in the AI scope"
                    break
                if not bool(conn.get("ai_query", True)):
                    problem = (
                        f"{conn.get('name') or cid} is inspect-only; AI queries are disabled"
                    )
                    break
                try:
                    sql_text = _check_sql(str(item.get("sql") or ""))
                except HTTPException as exc:
                    problem = str(exc.detail)
                    break
                if not READ_SQL.match(sql_text):
                    problem = "the AI produced a non-read statement; refused"
                    break
                plan.append((conn, sql_text))
            if problem:
                last_error = problem
                messages.append({"role": "assistant", "content": json.dumps(parsed)})
                messages.append(
                    {
                        "role": "user",
                        "content": f"That plan was rejected: {problem}. Reply with a corrected JSON action.",
                    }
                )
                continue

            explanation = str(parsed.get("explanation") or "")[:500]
            join_sql = str(parsed.get("join_sql") or "").strip()
            if len(plan) > 1 and not join_sql:
                last_error = "join_sql is required when a plan uses more than one database"
                messages.append({"role": "assistant", "content": json.dumps(parsed)})
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "That plan was rejected: add join_sql (read-only SQLite over "
                            "src_0, src_1, ...). Reply with a corrected JSON action."
                        ),
                    }
                )
                continue
            if body.get("execute") is False:
                return {
                    "sql": plan[0][1] if len(plan) == 1 else "",
                    "join_sql": join_sql if len(plan) > 1 else "",
                    "explanation": explanation,
                    "columns": [],
                    "rows": [],
                    "sources": [
                        {
                            "connection": conn["id"],
                            "name": conn.get("name") or conn["id"],
                            "kind": _kind(conn),
                            "sql": sql_text,
                            "rows": 0,
                            "duration_ms": 0,
                        }
                        for conn, sql_text in plan
                    ],
                    "steps": steps,
                    "planned": True,
                    "elapsed_ms": round((time.monotonic() - started) * 1000),
                }
            try:
                results = [_ai_agent_source(conn, sql_text) for conn, sql_text in plan]
            except HTTPException as exc:
                last_error = str(exc.detail)
                messages.append({"role": "assistant", "content": json.dumps(parsed)})
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "One source failed with:\n" + last_error[:1200]
                            + "\nReply with a corrected JSON action using the listed columns."
                        ),
                    }
                )
                continue
            if len(results) > 1:
                merged = _ai_local_join(results, join_sql)
            else:
                merged = {
                    "columns": results[0]["columns"],
                    "rows": results[0]["rows"][:AI_AGENT_MAX_ROWS],
                    "truncated": results[0]["truncated"],
                    "join_ms": 0,
                }
            for result in results:
                steps.append(
                    f"ran {result['name']} ({len(result['rows'])} rows, {result['duration_ms']} ms)"
                )
            if len(results) > 1:
                steps.append(f"joined {len(results)} databases locally")
            return {
                "sql": plan[0][1] if len(plan) == 1 else "",
                "join_sql": join_sql if len(plan) > 1 else "",
                "explanation": explanation,
                "columns": merged["columns"],
                "rows": merged["rows"],
                "truncated": merged["truncated"],
                "join_ms": merged.get("join_ms", 0),
                "sources": [
                    {
                        "connection": result["connection"],
                        "name": result["name"],
                        "kind": result["kind"],
                        "sql": result["sql"],
                        "rows": len(result["rows"]),
                        "duration_ms": result["duration_ms"],
                    }
                    for result in results
                ],
                "steps": steps,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
            }

        raise HTTPException(502, f"the AI returned an unknown action {action!r}")

    raise HTTPException(502, last_error or "the AI did not produce a usable plan")


# --------------------------------------------------------------------------- #
# AI harness (natural language -> read-only SQL)
# --------------------------------------------------------------------------- #

AI_DEFAULT_BASE = "https://api.openai.com/v1"
AI_DEFAULT_MODEL = "gpt-4o-mini"


def _ai_path() -> Path:
    return _data_dir() / "ai.json"


def _load_ai_config() -> dict[str, Any]:
    path = _ai_path()
    if not path.exists():
        return {"base_url": AI_DEFAULT_BASE, "model": AI_DEFAULT_MODEL, "api_key_enc": ""}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    return {
        "base_url": str(data.get("base_url") or AI_DEFAULT_BASE),
        "model": str(data.get("model") or AI_DEFAULT_MODEL),
        "api_key_enc": str(data.get("api_key_enc") or ""),
    }


def _save_ai_config(config: dict[str, Any]) -> None:
    path = _ai_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(config, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _ai_key(config: dict[str, Any]) -> str:
    token = config.get("api_key_enc") or ""
    return _decrypt(token) if token else ""


def _ai_post(config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    key = _ai_key(config)
    if not key:
        raise HTTPException(400, "AI is not configured: add an API key in AI settings")
    base = str(config.get("base_url") or AI_DEFAULT_BASE).rstrip("/")
    url = base + "/chat/completions"
    headers = {"Authorization": f"Bearer {key}"}
    try:
        return _mcp_http_json(url, payload=payload, headers=headers, timeout=60)
    except HTTPException as exc:
        # Some OpenAI-compatible servers reject response_format.
        if "response_format" in payload:
            retry = dict(payload)
            retry.pop("response_format", None)
            return _mcp_http_json(url, payload=retry, headers=headers, timeout=60)
        raise exc


def _ai_schema_context(conn: dict[str, Any], schema: str, table: str, question: str) -> str:
    try:
        tables = _tree(conn)
    except HTTPException:
        tables = []
    names = [f"{row['schema']}.{row['name']}" for row in tables][:120]
    lines = [f"Database: {conn.get('dbname') or ''}"]
    if names:
        lines.append("Tables: " + ", ".join(names))
    lowered = question.lower()
    tokens = set(re.findall(r"[a-z0-9_]+", lowered))
    focus = [
        row for row in tables
        if row.get("schema") == schema and row.get("name") == table
    ][:1]
    for row in tables:
        if len(focus) >= 4:
            break
        name = str(row.get("name") or "").lower()
        if not name or any(item is row for item in focus):
            continue
        stem = name[:-1] if name.endswith("s") else name
        if name in lowered or name in tokens or stem in tokens:
            focus.append(row)
    for row in focus[:3]:
        try:
            columns = _columns(conn, row["schema"], row["name"])
        except HTTPException:
            continue
        body = ", ".join(
            f"{column['name']} {column.get('type') or ''}".strip()
            for column in columns[:60]
        )
        lines.append(f"Columns for {row['schema']}.{row['name']}: {body}")
    return "\n".join(lines)[:20000]


def _ai_extract_json(text: str) -> dict[str, Any]:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z0-9]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    try:
        value = json.loads(cleaned)
        return value if isinstance(value, dict) else {}
    except ValueError:
        match = re.search(r"\{.*\}", cleaned, re.S)
        if not match:
            raise HTTPException(502, "the AI did not return JSON")
        try:
            value = json.loads(match.group(0))
        except ValueError as exc:
            raise HTTPException(502, "the AI returned invalid JSON") from exc
        return value if isinstance(value, dict) else {}


def _ai_history(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    messages = []
    for item in value[-12:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "")
        content = str(item.get("content") or "")[:4000]
        if role in ("user", "assistant") and content.strip():
            messages.append({"role": role, "content": content})
    return messages


def _ai_request(
    conn: dict[str, Any],
    database: str,
    schema: str,
    table: str,
    question: str,
    error: str = "",
    previous: str = "",
    history: Any = None,
) -> dict[str, Any]:
    config = _load_ai_config()
    dialect = {"postgres": "PostgreSQL", "mysql": "MySQL/MariaDB", "clickhouse": "ClickHouse", "sqlite": "SQLite"}.get(_kind(conn), "SQL")
    today = datetime.date.today().isoformat()
    context = _ai_schema_context(conn, schema, table, question)
    system = (
        "You are DB Desk's SQL assistant. For data questions, translate them into exactly one "
        f"read-only {dialect} SELECT statement and reply with JSON only: "
        '{"sql": "<statement>", "explanation": "<one short sentence>"}. '
        "If the user greets you, thanks you, or asks something that is not a data question, "
        'do not invent SQL: reply with {"answer": "<short helpful reply>", "sql": ""}. '
        "Rules: no INSERT/UPDATE/DELETE/DDL, no multiple statements, quote identifiers when needed, "
        f"add LIMIT 500 when returning detail rows, use today's date {today} for relative dates. "
        "Use only the tables and columns listed.\n\n" + context
    )
    messages = [{"role": "system", "content": system}]
    messages.extend(_ai_history(history))
    messages.append({"role": "user", "content": question})
    if error:
        messages.append(
            {
                "role": "assistant",
                "content": json.dumps({"sql": previous, "explanation": ""}),
            }
        )
        messages.append(
            {
                "role": "user",
                "content": (
                    "That SQL failed with:\n" + error[:1200]
                    + "\nReturn a corrected JSON object using only the listed columns and tables."
                ),
            }
        )
    payload = {
        "model": config.get("model") or AI_DEFAULT_MODEL,
        "temperature": 0,
        "messages": messages,
        "response_format": {"type": "json_object"},
    }
    data = _ai_post(config, payload)
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise HTTPException(502, "unexpected response from the AI provider") from exc
    parsed = _ai_extract_json(str(content))
    sql_text = str(parsed.get("sql") or "").strip()
    if not sql_text:
        answer = str(parsed.get("answer") or parsed.get("explanation") or "").strip()
        if not answer:
            raise HTTPException(502, "the AI returned neither SQL nor an answer")
        return {"sql": "", "explanation": answer[:1000]}
    sql = _check_sql(sql_text)
    if not READ_SQL.match(sql):
        raise HTTPException(400, "the AI produced a non-read statement; refused")
    explanation = str(parsed.get("explanation") or "")[:500]
    return {"sql": sql, "explanation": explanation}


def _ai_run(conn: dict[str, Any], sql: str) -> dict[str, Any]:
    wrapped = f"SELECT * FROM (\n{sql}\n) AS dbdesk_ai LIMIT {MAX_ROWS}"
    readonly_conn = dict(conn, readonly=True)
    started = time.monotonic()
    result = _query(readonly_conn, wrapped, MAX_ROWS, True)
    result["duration_ms"] = round((time.monotonic() - started) * 1000)
    return result


# --------------------------------------------------------------------------- #
# connection bundles (export / import / QR)
# --------------------------------------------------------------------------- #

BUNDLE_FORMAT = "dbdesk.connections"
BUNDLE_VERSION = 1


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _bundle_item(conn: dict[str, Any]) -> dict[str, Any]:
    kind = str(conn.get("kind") or "postgres")
    fields = ["name", "group", "dbname", "readonly", "production"]
    if kind in ("postgres", "mysql", "clickhouse"):
        fields += ["host", "port", "user"]
        if kind == "postgres":
            fields += ["sslmode"]
        if kind == "clickhouse":
            fields += ["ch_path"]
        fields += [
            "ssh_host", "ssh_user", "ssh_port", "ssh_key",
            "tunnel_command", "tunnel_env", "tunnel_timeout",
        ]
    if kind == "mcp":
        fields += [
            "mcp_url", "mcp_server", "mcp_tool", "mcp_sql_arg",
            "mcp_dialect", "mcp_extra_args",
        ]
    if kind == "http":
        fields += [
            "http_url", "http_method", "http_sql_field", "http_headers",
            "http_body_mode", "http_dialect", "http_timeout",
        ]
    defaults = {
        "readonly": True,
        "production": False,
        "sslmode": "prefer",
        "ssh_user": "root",
        "ssh_port": 22,
        "tunnel_timeout": 25,
        "mcp_tool": "query",
        "mcp_sql_arg": "sql",
        "mcp_dialect": "postgres",
        "http_method": "POST",
        "http_sql_field": "sql",
        "http_body_mode": "json",
        "http_dialect": "postgres",
        "http_timeout": 30,
    }
    item: dict[str, Any] = {"kind": kind}
    for key in fields:
        value = conn.get(key)
        if value in (None, "", [], {}):
            continue
        if key in defaults and value == defaults[key]:
            continue
        item[key] = value
    return item


def _bundle_document(
    connections: list[dict[str, Any]],
    include_secrets: bool,
    passphrase: str,
    *,
    extras: dict[str, Any] | None = None,
    source_ids: bool = False,
) -> dict[str, Any]:
    items = []
    for conn in connections:
        item = _bundle_item(conn)
        if source_ids:
            item["source_id"] = conn.get("id", "")
        if include_secrets:
            item["password"] = _decrypt(conn.get("password_enc", ""))
            if conn.get("ch_headers_enc"):
                item["ch_headers"] = _decrypt(str(conn.get("ch_headers_enc")))
        items.append(item)
    payload = {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "created_at": time.time(),
        "connections": items,
    }
    if extras:
        payload.update(extras)
    if not include_secrets:
        return {"bundle": json.dumps(payload, separators=(",", ":")), "encrypted": False}
    if len(passphrase) < 8:
        raise HTTPException(400, "passphrase must be at least 8 characters")
    if AESGCM is None:
        raise HTTPException(500, "cryptography is not available")
    salt = os.urandom(16)
    nonce = os.urandom(12)
    key = hashlib.scrypt(
        passphrase.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32
    )
    ciphertext = AESGCM(key).encrypt(
        nonce, json.dumps(payload, separators=(",", ":")).encode("utf-8"), None
    )
    envelope = {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "encrypted": True,
        "kdf": {"name": "scrypt", "n": 2**14, "r": 8, "p": 1, "salt": _b64(salt)},
        "nonce": _b64(nonce),
        "ciphertext": _b64(ciphertext),
    }
    return {"bundle": json.dumps(envelope, separators=(",", ":")), "encrypted": True}


def _bundle_export(
    connections: list[dict[str, Any]], include_secrets: bool, passphrase: str
) -> dict[str, Any]:
    return _bundle_document(connections, include_secrets, passphrase)


def _bundle_open(bundle: str, passphrase: str) -> dict[str, Any]:
    text = (bundle or "").strip()
    if not text:
        raise HTTPException(400, "bundle is required")
    if text.startswith("dbdesk://"):
        parsed = urllib.parse.urlparse(text)
        text = urllib.parse.unquote(parsed.query or parsed.path or "")
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise HTTPException(400, "bundle is not valid JSON") from exc
    if not isinstance(data, dict) or data.get("format") != BUNDLE_FORMAT:
        raise HTTPException(400, "not a DB Desk connection bundle")
    if data.get("encrypted"):
        if not passphrase:
            raise HTTPException(400, "this bundle is encrypted; passphrase is required")
        if AESGCM is None:
            raise HTTPException(500, "cryptography is not available")
        kdf = data.get("kdf") or {}
        try:
            salt = base64.b64decode(str(kdf.get("salt") or ""))
            nonce = base64.b64decode(str(data.get("nonce") or ""))
            ciphertext = base64.b64decode(str(data.get("ciphertext") or ""))
            key = hashlib.scrypt(
                passphrase.encode("utf-8"),
                salt=salt,
                n=int(kdf.get("n") or 2**14),
                r=int(kdf.get("r") or 8),
                p=int(kdf.get("p") or 1),
                dklen=32,
            )
            plaintext = AESGCM(key).decrypt(nonce, ciphertext, None)
            data = json.loads(plaintext.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, "could not decrypt the bundle (wrong passphrase?)") from exc
    return data


def _bundle_parse(bundle: str, passphrase: str) -> list[dict[str, Any]]:
    data = _bundle_open(bundle, passphrase)
    items = data.get("connections")
    if not isinstance(items, list) or not items:
        raise HTTPException(400, "bundle has no connections")
    return [item for item in items if isinstance(item, dict)]


def _record_from_bundle(item: dict[str, Any], record_id: str) -> dict[str, Any]:
    kind = str(item.get("kind") or "postgres")
    if kind not in KINDS:
        raise HTTPException(400, f"unknown database type {kind!r} in bundle")
    password = item.get("password")
    record = {
        "id": record_id,
        "kind": kind,
        "name": str(item.get("name") or item.get("dbname") or "Imported")[:120],
        "group": str(item.get("group") or "")[:80],
        "host": str(item.get("host") or ""),
        "port": int(item.get("port") or 0),
        "dbname": str(item.get("dbname") or ""),
        "user": str(item.get("user") or ""),
        "password_enc": _encrypt(str(password)) if password not in (None, "") else "",
        "ch_headers_enc": _encrypt(str(item.get("ch_headers")))
        if item.get("ch_headers")
        else "",
        "ch_path": str(item.get("ch_path") or "/"),
        "sslmode": str(item.get("sslmode") or "prefer"),
        "readonly": bool(item.get("readonly", True)),
        "production": bool(item.get("production", False)),
        "ssh_host": str(item.get("ssh_host") or ""),
        "ssh_user": str(item.get("ssh_user") or "root"),
        "ssh_port": int(item.get("ssh_port") or 22),
        "ssh_key": str(item.get("ssh_key") or ""),
        "mcp_url": str(item.get("mcp_url") or ""),
        "mcp_server": str(item.get("mcp_server") or ""),
        "mcp_tool": str(item.get("mcp_tool") or "query"),
        "mcp_sql_arg": str(item.get("mcp_sql_arg") or "sql"),
        "mcp_dialect": str(item.get("mcp_dialect") or "postgres"),
        "mcp_extra_args": str(item.get("mcp_extra_args") or ""),
        "http_url": str(item.get("http_url") or ""),
        "http_method": str(item.get("http_method") or "POST"),
        "http_sql_field": str(item.get("http_sql_field") or "sql"),
        "http_headers": str(item.get("http_headers") or ""),
        "http_body_mode": str(item.get("http_body_mode") or "json"),
        "http_dialect": str(item.get("http_dialect") or "postgres"),
        "http_timeout": int(item.get("http_timeout") or 30),
        "tunnel_command": str(item.get("tunnel_command") or ""),
        "tunnel_env": str(item.get("tunnel_env") or ""),
        "tunnel_timeout": int(item.get("tunnel_timeout") or 25),
        "db_labels": {
            str(key)[:128]: str(value)[:80]
            for key, value in (item.get("db_labels") or {}).items()
            if str(value).strip()
        },
    }
    if not record["dbname"]:
        raise HTTPException(400, "bundle connection is missing a database name")
    return record


# --------------------------------------------------------------------------- #
# connections
# --------------------------------------------------------------------------- #


@router.get("/connections")
async def list_connections() -> dict[str, Any]:
    return {"connections": [_public(c) for c in _load()]}


@router.post("/connections")
async def save_connection(body: dict[str, Any]) -> dict[str, Any]:
    conns = _load()
    conn_id = (body.get("id") or "").strip() or uuid.uuid4().hex[:12]
    existing = next((c for c in conns if c["id"] == conn_id), None)

    kind = str(body.get("kind") or (existing or {}).get("kind") or "postgres")
    if kind not in KINDS:
        raise HTTPException(400, f"unknown database type {kind!r}")

    def pick(key: str, default: Any = None) -> Any:
        if key in body:
            value = body[key]
            return default if value in (None, "") else value
        if existing is not None and existing.get(key) not in (None, ""):
            return existing.get(key)
        return default

    name = (body.get("name") or "").strip() or (body.get("dbname") or "").strip() or "Database"
    host = "" if kind in ("mcp", "http", "sqlite") else str(pick("host", "127.0.0.1")).strip()
    port = (
        0
        if kind in ("mcp", "http", "sqlite")
        else int(pick("port", {"postgres": 5432, "mysql": 3306, "clickhouse": 8123}[kind]))
    )
    dbname = (body.get("dbname") or (existing or {}).get("dbname") or "").strip()
    user = (body.get("user") or (existing or {}).get("user") or "").strip()
    if not dbname:
        raise HTTPException(400, "database name is required")
    if kind == "sqlite":
        dbname = os.path.expanduser(dbname)
    if not user:
        user = {
            "postgres": "postgres", "mysql": "root", "clickhouse": "default",
            "mcp": "mcp", "http": "http", "sqlite": "sqlite",
        }[kind]
    mcp_url = str(pick("mcp_url", "")).strip()
    mcp_server = str(pick("mcp_server", "")).strip()
    mcp_tool = str(pick("mcp_tool", "query")).strip() or "query"
    mcp_extra_args = str(pick("mcp_extra_args", "")).strip()
    mcp_sql_arg = str(pick("mcp_sql_arg", "sql")).strip() or "sql"
    mcp_dialect = str(pick("mcp_dialect", "postgres")).strip().lower()
    if kind == "mcp":
        if not mcp_server and not mcp_url:
            raise HTTPException(400, "MCP server name or URL is required")
        if mcp_dialect not in ("postgres", "mysql", "clickhouse"):
            raise HTTPException(400, "MCP dialect must be postgres, mysql or clickhouse")
    http_url = str(pick("http_url", "")).strip()
    http_method = str(pick("http_method", "POST")).strip().upper()
    http_sql_field = str(pick("http_sql_field", "sql")).strip() or "sql"
    http_headers = str(pick("http_headers", ""))
    http_body_mode = str(pick("http_body_mode", "json")).strip().lower()
    http_dialect = str(pick("http_dialect", "postgres")).strip().lower()
    http_timeout = int(pick("http_timeout", 30))
    if kind == "http":
        if not http_url:
            raise HTTPException(400, "HTTP URL is required")
        if http_method not in ("GET", "POST"):
            raise HTTPException(400, "HTTP method must be GET or POST")
        if http_dialect not in ("postgres", "mysql", "clickhouse"):
            raise HTTPException(400, "HTTP dialect must be postgres, mysql or clickhouse")
        if http_body_mode not in ("json", "raw"):
            raise HTTPException(400, "HTTP body mode must be json or raw")
        http_timeout = max(5, min(http_timeout, 120))

    password = body.get("password")
    if password in (None, ""):
        password_enc = (existing or {}).get("password_enc", "")
    else:
        password_enc = _encrypt(str(password))

    ch_headers = body.get("ch_headers")
    if body.get("ch_headers_clear"):
        ch_headers_enc = ""
    elif ch_headers in (None, ""):
        ch_headers_enc = (existing or {}).get("ch_headers_enc", "")
    else:
        _parse_ch_headers(str(ch_headers), strict=True)
        ch_headers_enc = _encrypt(str(ch_headers).strip())
    ch_path = str(pick("ch_path", "/")).strip() or "/"
    if not ch_path.startswith("/"):
        ch_path = "/" + ch_path
    if "?" in ch_path or "\n" in ch_path or "\r" in ch_path:
        raise HTTPException(400, "ClickHouse HTTP path must be a plain path such as /")

    labels = body.get("db_labels")
    if labels is None:
        labels = (existing or {}).get("db_labels", {})
    record = {
        "id": conn_id,
        "kind": kind,
        "name": name,
        "group": str(pick("group", "")).strip()[:80],
        "host": host,
        "port": port,
        "dbname": dbname,
        "user": user,
        "password_enc": password_enc,
        "ch_headers_enc": ch_headers_enc,
        "ch_path": ch_path,
        "sslmode": str(pick("sslmode", "prefer")).strip() or "prefer",
        "readonly": True if kind in ("mcp", "http") else bool(pick("readonly", True)),
        "production": bool(pick("production", False)),
        "ai_schema": bool(pick("ai_schema", True)),
        "ai_query": bool(pick("ai_query", True)),
        "ssh_host": "" if kind in ("mcp", "http", "sqlite") else str(pick("ssh_host", "")).strip(),
        "ssh_user": "" if kind == "sqlite" else str(pick("ssh_user", "root")).strip(),
        "ssh_port": int(pick("ssh_port", 22)),
        "ssh_key": "" if kind in ("mcp", "http", "sqlite") else str(pick("ssh_key", "")).strip(),
        "mcp_url": mcp_url,
        "mcp_server": mcp_server,
        "mcp_tool": mcp_tool,
        "mcp_sql_arg": mcp_sql_arg,
        "mcp_dialect": mcp_dialect,
        "mcp_extra_args": mcp_extra_args,
        "http_url": http_url,
        "http_method": http_method,
        "http_sql_field": http_sql_field,
        "http_headers": http_headers,
        "http_body_mode": http_body_mode,
        "http_dialect": http_dialect,
        "http_timeout": http_timeout,
        "tunnel_command": "" if kind == "sqlite" else str(pick("tunnel_command", "")).strip(),
        "tunnel_env": "" if kind == "sqlite" else str(pick("tunnel_env", "")),
        "tunnel_timeout": max(5, min(int(pick("tunnel_timeout", 25)), 120)),
        "db_labels": {
            str(k)[:128]: str(v)[:80] for k, v in (labels or {}).items() if str(v).strip()
        },
    }
    conns = [c for c in conns if c["id"] != conn_id] + [record]
    _invalidate_columns()
    _close_pools()
    _save(conns)
    return {"connection": _public(record)}


@router.get("/ai/config")
async def ai_config() -> dict[str, Any]:
    config = _load_ai_config()
    return {
        "base_url": config["base_url"],
        "model": config["model"],
        "configured": bool(_ai_key(config)),
    }


@router.post("/ai/config")
async def ai_config_save(body: dict[str, Any]) -> dict[str, Any]:
    current = _load_ai_config()
    api_key = body.get("api_key")
    config = {
        "base_url": str(body.get("base_url") or current["base_url"]).strip() or AI_DEFAULT_BASE,
        "model": str(body.get("model") or current["model"]).strip() or AI_DEFAULT_MODEL,
        "api_key_enc": current["api_key_enc"],
    }
    if api_key not in (None, ""):
        config["api_key_enc"] = _encrypt(str(api_key))
    _save_ai_config(config)
    return {"ok": True, "configured": bool(config["api_key_enc"]), "base_url": config["base_url"], "model": config["model"]}


@router.post("/ai/setup")
async def ai_setup(body: dict[str, Any]) -> dict[str, Any]:
    question = str(body.get("question") or "").strip()[:1200]
    if not question:
        raise HTTPException(400, "question is required")
    return _ai_setup(question, body.get("history"))


@router.get("/ai/catalog")
async def ai_catalog() -> dict[str, Any]:
    return {"connections": [_ai_catalog_entry(conn) for conn in _ai_scope(None)]}


@router.post("/ai/agent")
async def ai_agent(body: dict[str, Any]) -> dict[str, Any]:
    return _ai_agent(body)


@router.post("/ai/ask")
async def ai_ask(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    if _kind(conn) in ("mcp", "http"):
        raise HTTPException(400, "AI queries work on PostgreSQL, MySQL/MariaDB, ClickHouse and SQLite connections")
    question = str(body.get("question") or "").strip()[:2000]
    if not question:
        raise HTTPException(400, "question is required")
    schema = str(body.get("schema") or "")
    table = str(body.get("table") or "")
    database = str(body.get("database") or "")
    history = body.get("history")
    planned = _ai_request(conn, database, schema, table, question, history=history)
    if not planned["sql"]:
        return {"sql": "", "explanation": planned["explanation"]}
    if body.get("execute") is False:
        return {"sql": planned["sql"], "explanation": planned["explanation"]}
    retried = False
    try:
        result = _ai_run(conn, planned["sql"])
    except HTTPException as exc:
        if exc.status_code != 400:
            raise
        planned = _ai_request(
            conn,
            database,
            schema,
            table,
            question,
            error=str(exc.detail),
            previous=planned["sql"],
            history=history,
        )
        retried = True
        result = _ai_run(conn, planned["sql"])
    return {
        "sql": planned["sql"],
        "explanation": planned["explanation"],
        "retried": retried,
        **result,
    }


@router.post("/connections/export")
async def export_connections(body: dict[str, Any]) -> dict[str, Any]:
    ids = [str(value) for value in (body.get("ids") or []) if str(value).strip()]
    connections = _load()
    selected = [conn for conn in connections if not ids or conn["id"] in ids]
    if not selected:
        raise HTTPException(404, "no connections to export")
    result = _bundle_export(
        selected,
        bool(body.get("include_secrets")),
        str(body.get("passphrase") or ""),
    )
    result["count"] = len(selected)
    return result


@router.post("/connections/import")
async def import_connections(body: dict[str, Any]) -> dict[str, Any]:
    items = _bundle_parse(
        str(body.get("bundle") or ""), str(body.get("passphrase") or "")
    )
    if body.get("preview"):
        return {
            "preview": True,
            "count": len(items),
            "connections": [
                {
                    "name": str(item.get("name") or item.get("dbname") or "Imported"),
                    "kind": str(item.get("kind") or "postgres"),
                    "host": str(item.get("host") or ""),
                    "port": int(item.get("port") or 0),
                    "dbname": str(item.get("dbname") or ""),
                    "production": bool(item.get("production", False)),
                    "readonly": bool(item.get("readonly", True)),
                    "has_password": item.get("password") not in (None, ""),
                }
                for item in items
            ],
        }
    connections = _load()
    existing = {conn["id"] for conn in connections}
    added = 0
    for item in items:
        record = _record_from_bundle(item, uuid.uuid4().hex[:12])
        while record["id"] in existing:
            record["id"] = uuid.uuid4().hex[:12]
        existing.add(record["id"])
        connections.append(record)
        added += 1
    _invalidate_columns()
    _close_pools()
    _save(connections)
    return {"ok": True, "added": added, "count": len(items)}


@router.post("/backup/export")
async def backup_export(body: dict[str, Any]) -> dict[str, Any]:
    connections = _load()
    views = _load_views()
    saved = _load_queries()["saved"]
    result = _bundle_document(
        connections,
        bool(body.get("include_secrets")),
        str(body.get("passphrase") or ""),
        extras={"views": views, "saved_queries": saved},
        source_ids=True,
    )
    result.update(
        {
            "connections_count": len(connections),
            "views_count": len(views),
            "queries_count": len(saved),
        }
    )
    return result


@router.post("/backup/import")
async def backup_import(body: dict[str, Any]) -> dict[str, Any]:
    data = _bundle_open(
        str(body.get("bundle") or ""), str(body.get("passphrase") or "")
    )
    items = [item for item in data.get("connections") or [] if isinstance(item, dict)]
    if not items:
        raise HTTPException(400, "bundle has no connections")
    pending_views = [view for view in data.get("views") or [] if isinstance(view, dict)]
    pending_queries = [
        query for query in data.get("saved_queries") or [] if isinstance(query, dict)
    ]
    if body.get("preview"):
        return {
            "preview": True,
            "encrypted": bool(data.get("encrypted")),
            "count": len(items),
            "connections": [
                {
                    "name": str(item.get("name") or item.get("dbname") or ""),
                    "kind": str(item.get("kind") or "postgres"),
                    "database": str(item.get("dbname") or ""),
                    "has_password": item.get("password") not in (None, ""),
                }
                for item in items
            ],
            "views": len(pending_views),
            "queries": len(pending_queries),
        }

    mapping: dict[str, str] = {}
    records = _load()
    for item in items:
        record_id = uuid.uuid4().hex[:12]
        record = _record_from_bundle(item, record_id)
        source = str(item.get("source_id") or "")
        if source:
            mapping[source] = record_id
        records.append(record)
    _save(records)
    _invalidate_columns()
    _close_pools()

    views = _load_views()
    added_views = 0
    for view in pending_views:
        entry = dict(view)
        entry["id"] = uuid.uuid4().hex[:10]
        entry["connection_id"] = mapping.get(
            str(entry.get("connection_id") or ""), str(entry.get("connection_id") or "")
        )
        views.append(entry)
        added_views += 1
    if added_views:
        _save_views(views)

    queries = _load_queries()
    added_queries = 0
    for query in pending_queries:
        entry = dict(query)
        entry["id"] = uuid.uuid4().hex[:10]
        entry["connection_id"] = mapping.get(
            str(entry.get("connection_id") or ""), str(entry.get("connection_id") or "")
        )
        queries["saved"].append(entry)
        added_queries += 1
    if added_queries:
        _save_queries(queries)

    return {
        "ok": True,
        "connections": len(items),
        "views": added_views,
        "queries": added_queries,
    }


@router.delete("/connections/{conn_id}")
async def delete_connection(conn_id: str) -> dict[str, Any]:
    conns = _load()
    kept = [c for c in conns if c["id"] != conn_id]
    if len(kept) == len(conns):
        raise HTTPException(404, f"connection {conn_id!r} not found")
    _invalidate_columns()
    _close_pools()
    _save(kept)
    return {"ok": True}


@router.post("/connections/test")
async def test_connection(body: dict[str, Any]) -> dict[str, Any]:
    conn = dict(body)
    conn_id = conn.get("id")
    if conn_id:
        saved = _get(conn_id)
        for key in (
            "kind", "host", "port", "dbname", "user", "sslmode", "password",
            "ch_headers", "ch_path",
            "ssh_host", "ssh_user", "ssh_port", "ssh_key",
            "mcp_url", "mcp_server", "mcp_tool", "mcp_sql_arg", "mcp_dialect", "mcp_extra_args",
            "http_url", "http_method", "http_sql_field", "http_headers",
            "http_body_mode", "http_dialect", "http_timeout", "tunnel_command", "tunnel_timeout",
            "tunnel_env",
        ):
            if conn.get(key) in (None, ""):
                conn[key] = saved.get(key)
    if not conn.get("dbname"):
        raise HTTPException(400, "database name is required")
    if str(conn.get("tunnel_command") or "").strip():
        _command_tunnel(conn)
    elif str(conn.get("ssh_host") or "").strip():
        conn = dict(conn, host="127.0.0.1", port=_tunnel(conn))
    if not conn.get("user"):
        conn["user"] = {
            "postgres": "postgres", "mysql": "root", "clickhouse": "default",
            "mcp": "mcp", "http": "http", "sqlite": "sqlite",
        }.get(_kind(conn), "postgres")
    if _kind(conn) == "sqlite":
        conn["dbname"] = os.path.expanduser(str(conn.get("dbname") or ""))
    return {"ok": True, "server": _test(conn)}


# --------------------------------------------------------------------------- #
# schema browsing
# --------------------------------------------------------------------------- #


@router.get("/connections/{conn_id}/tree")
async def connection_tree(conn_id: str, database: str = "") -> dict[str, Any]:
    conn = _with_db(_connect(conn_id), database)
    rows = _tree(conn)
    schemas: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        schemas.setdefault(row["schema"], []).append(row)
    return {"schemas": [{"name": name, "tables": tables} for name, tables in sorted(schemas.items())]}


@router.get("/connections/{conn_id}/columns")
async def table_columns(conn_id: str, schema: str, table: str, database: str = "") -> dict[str, Any]:
    conn = _with_db(_connect(conn_id), database)
    return {"columns": _columns(conn, schema, table)}


@router.get("/connections/{conn_id}/databases")
async def connection_databases(conn_id: str) -> dict[str, Any]:
    conn = _connect(conn_id)
    kind = _kind(conn)
    if kind == "mcp":
        names = _mcp_databases(conn)
    elif kind == "http":
        names = _http_databases(conn)
    elif kind == "sqlite":
        names = ["main"]
    elif kind == "mysql":
        rows = _my_rows_sql(conn, "SHOW DATABASES")
        names = [
            r[0] for r in rows
            if r and r[0] and r[0] not in ("information_schema", "performance_schema", "mysql", "sys")
        ]
    elif kind == "clickhouse":
        payload = _ch_json(conn, "SELECT name FROM system.databases ORDER BY name", readonly=True)
        _, rows = _ch_result(payload)
        names = [
            r[0] for r in rows
            if r and r[0] not in ("system", "INFORMATION_SCHEMA", "information_schema")
        ]
    else:
        names = [
            row[0]
            for row in _pg_rows_sql(
                conn,
                "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
            )
        ]
    labels = conn.get("db_labels") or {}
    return {
        "databases": [
            {"name": name, "label": labels.get(name, "")} for name in names
        ]
    }


@router.get("/connections/{conn_id}/db-hints")
async def database_hints(conn_id: str) -> dict[str, Any]:
    """Suggested labels for each database — the WordPress site URL's host."""
    conn = _connect(conn_id)
    if _kind(conn) != "mysql":
        return {"hints": {}}

    rows = _my_rows_sql(conn, "SHOW DATABASES")
    names = [
        r[0] for r in rows
        if r and r[0] and r[0] not in ("information_schema", "performance_schema", "mysql", "sys")
    ][:40]

    hints: dict[str, str] = {}
    for name in names:
        try:
            found = _my_rows_sql(
                conn,
                "SELECT table_name FROM information_schema.tables "
                f"WHERE table_schema = {_my_lit(name)} "
                "AND (table_name = 'options' OR table_name LIKE '%options') "
                "ORDER BY CHAR_LENGTH(table_name), table_name LIMIT 1",
            )
            table = found[0][0] if found and found[0] else ""
            if not table:
                continue
            option = _my_rows_sql(
                conn,
                f"SELECT option_value FROM {_my_ident(name)}.{_my_ident(str(table))} "
                "WHERE option_name = 'siteurl' LIMIT 1",
            )
            url = str(option[0][0]) if option and option[0] else ""
            if url:
                host = urllib.parse.urlparse(url if "//" in url else f"//{url}").hostname or ""
                if host:
                    hints[name] = host[:80]
        except HTTPException:
            continue
    return {"hints": hints}


@router.get("/connections/{conn_id}/wp-info")
async def wordpress_info(conn_id: str, database: str = "") -> dict[str, Any]:
    conn = _with_db(_connect(conn_id), database)
    if _kind(conn) != "mysql":
        return {
            "found": False,
            "message": "WordPress info is available for MySQL/MariaDB connections.",
        }
    db = str(conn.get("dbname") or "")
    try:
        rows = _my_rows_sql(
            conn,
            "SELECT table_name FROM information_schema.tables "
            f"WHERE table_schema = {_my_lit(db)} "
            "AND (table_name = 'options' OR table_name LIKE '%options') "
            "ORDER BY CHAR_LENGTH(table_name), table_name LIMIT 1",
        )
    except HTTPException:
        return {"found": False, "message": "Could not inspect the schema."}
    options_table = rows[0][0] if rows and rows[0] else ""
    if not options_table:
        return {"found": False, "message": "No WordPress options table found in this database."}

    prefix = options_table[: -len("options")] if options_table.endswith("options") else ""
    options: dict[str, str] = {}
    try:
        rows = _my_rows_sql(
            conn,
            f"SELECT option_name, option_value FROM {_my_ident(db)}.{_my_ident(str(options_table))} "
            "WHERE option_name IN ('siteurl','home','blogname','template','stylesheet','active_plugins')",
        )
        for row in rows:
            if row and len(row) >= 2:
                options[str(row[0])] = str(row[1] or "")
    except HTTPException:
        pass

    counts = {"post": 0, "page": 0, "attachment": 0, "users": 0}
    try:
        rows = _my_rows_sql(
            conn,
            f"SELECT post_type, COUNT(*) FROM {_my_ident(db)}.{_my_ident(prefix + 'posts')} "
            "GROUP BY post_type",
        )
        for row in rows:
            if row and row[0] in counts:
                counts[str(row[0])] = int(row[1] or 0)
    except HTTPException:
        pass
    try:
        rows = _my_rows_sql(
            conn,
            f"SELECT COUNT(*) FROM {_my_ident(db)}.{_my_ident(prefix + 'users')}",
        )
        if rows and rows[0]:
            counts["users"] = int(rows[0][0] or 0)
    except HTTPException:
        pass

    plugins = re.findall(r's:\d+:"([^"]+)"', options.get("active_plugins", ""))
    return {
        "found": True,
        "prefix": prefix,
        "options_table": options_table,
        "siteurl": options.get("siteurl", ""),
        "home": options.get("home", ""),
        "blogname": options.get("blogname", ""),
        "theme": options.get("stylesheet") or options.get("template") or "",
        "plugins": plugins[:100],
        "counts": counts,
    }


@router.get("/connections/{conn_id}/activity")
async def connection_activity(conn_id: str) -> dict[str, Any]:
    conn = _connect(conn_id)
    queries = _activity(conn)
    kind = _kind(conn)
    note = {
        "sqlite": "SQLite is a local file; it has no server sessions to monitor.",
        "mcp": "MCP connections do not expose server sessions.",
        "http": "HTTP gateways do not expose server sessions.",
    }.get(kind, "Visibility depends on the database account's privileges (pg_monitor / PROCESS).")
    return {
        "queries": queries,
        "count": len(queries),
        "note": note,
    }


@router.get("/connections/{conn_id}/indexes")
async def table_indexes(conn_id: str, schema: str, table: str, database: str = "") -> dict[str, Any]:
    conn = _with_db(_connect(conn_id), database)
    return {"indexes": _indexes(conn, schema, table)}


@router.post("/table/index")
async def table_index(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    _writable(conn)
    schema = str(body.get("schema") or "")
    table = str(body.get("table") or "")
    action = str(body.get("action") or "")
    name = str(body.get("name") or "").strip()
    if not schema or not table or not action or not IDENT_RE.match(name):
        raise HTTPException(400, "schema, table, action and a valid index name are required")
    kind = _kind(conn)
    if kind == "clickhouse":
        raise HTTPException(400, "index editing is not supported for ClickHouse")
    if action == "create":
        columns = [str(column) for column in body.get("columns") or []]
        if not columns or any(not IDENT_RE.match(column) for column in columns):
            raise HTTPException(400, "at least one valid column is required")
        unique = bool(body.get("unique"))
        if kind == "sqlite":
            cols = ", ".join(_sqlite_ident(column) for column in columns)
            sql = (
                f"CREATE {'UNIQUE ' if unique else ''}INDEX {_sqlite_ident(name)} "
                f"ON {_sqlite_ident(table)} ({cols})"
            )
        elif kind == "mysql":
            cols = ", ".join(_my_ident(column) for column in columns)
            sql = (
                f"CREATE {'UNIQUE ' if unique else ''}INDEX {_my_ident(name)} "
                f"ON {_my_ident(schema)}.{_my_ident(table)} ({cols})"
            )
        else:
            cols = ", ".join(_ident(column) for column in columns)
            sql = (
                f"CREATE {'UNIQUE ' if unique else ''}INDEX {_ident(name)} "
                f"ON {_ident(schema)}.{_ident(table)} ({cols})"
            )
    elif action == "drop":
        if kind == "sqlite":
            sql = f"DROP INDEX {_sqlite_ident(name)}"
        elif kind == "mysql":
            sql = (
                f"ALTER TABLE {_my_ident(schema)}.{_my_ident(table)} "
                f"DROP INDEX {_my_ident(name)}"
            )
        else:
            sql = f"DROP INDEX {_ident(schema)}.{_ident(name)}"
    else:
        raise HTTPException(400, "unknown action")
    return _mutation(conn, body, sql, False, "index")


@router.get("/connections/{conn_id}/ddl")
async def table_ddl(conn_id: str, schema: str, table: str, database: str = "") -> dict[str, Any]:
    conn = _with_db(_connect(conn_id), database)
    if not schema or not table:
        raise HTTPException(400, "schema and table are required")
    return {"ddl": _ddl(conn, schema, table)}


@router.post("/mcp/authorize")
async def mcp_authorize(body: dict[str, Any]) -> dict[str, Any]:
    url = str(body.get("url") or "").strip()
    if not url:
        raise HTTPException(400, "MCP server URL is required")
    return _mcp_oauth_start(url)


@router.get("/mcp/oauth/status")
async def mcp_oauth_status(url: str) -> dict[str, Any]:
    return _mcp_status(url.strip())


@router.post("/mcp/logout")
async def mcp_logout(body: dict[str, Any]) -> dict[str, Any]:
    url = str(body.get("url") or "").strip()
    if url:
        data = _load_mcp_tokens()
        data["servers"].pop(url, None)
        _save_mcp_tokens(data)
        _MCP_SESSIONS.pop(url, None)
    return {"ok": True}


@router.get("/views")
async def list_views() -> dict[str, Any]:
    return {"views": _load_views()}


@router.post("/views")
async def save_view(body: dict[str, Any]) -> dict[str, Any]:
    name = str(body.get("name") or "").strip()[:80]
    table = str(body.get("table") or "").strip()
    if not name or not table:
        raise HTTPException(400, "name and table are required")
    views = _load_views()
    view_id = str(body.get("id") or "").strip() or uuid.uuid4().hex[:10]
    entry = {
        "id": view_id,
        "name": name,
        "connection_id": str(body.get("connection_id") or ""),
        "database": str(body.get("database") or ""),
        "schema": str(body.get("schema") or ""),
        "table": table,
        "filters": body.get("filters") or [],
        "order_by": str(body.get("order_by") or ""),
        "order_dir": "desc" if str(body.get("order_dir") or "").lower() == "desc" else "asc",
        "limit": max(1, min(int(body.get("limit") or 100), MAX_ROWS)),
        "created_at": time.time(),
    }
    views = [v for v in views if v["id"] != view_id] + [entry]
    _save_views(views)
    return {"view": entry}


@router.delete("/views/{view_id}")
async def delete_view(view_id: str) -> dict[str, Any]:
    views = _load_views()
    kept = [v for v in views if v["id"] != view_id]
    if len(kept) == len(views):
        raise HTTPException(404, "view not found")
    _save_views(kept)
    return {"ok": True}


@router.get("/connections/{conn_id}/table/csv")
async def table_csv(
    conn_id: str, schema: str, table: str, database: str = "", limit: int = 50000
) -> dict[str, Any]:
    conn = _with_db(_connect(conn_id), database)
    if not schema or not table:
        raise HTTPException(400, "schema and table are required")
    cap = max(1, min(int(limit), 200000))
    kind = _kind(conn)
    if kind == "postgres":
        sql = f"SELECT * FROM {_ident(schema)}.{_ident(table)} LIMIT {cap + 1}"
        text = _pg_run_csv(conn, sql)
        lines = text.rstrip("\n").splitlines()
        truncated = len(lines) - 1 > cap
        rows = max(0, len(lines) - 1)
        csv_text = "\n".join(lines[: cap + 1]) + "\n"
    else:
        result = _rows(conn, schema, table, cap + 1, 0, "", "ASC", None)
        truncated = bool(result.get("truncated"))
        rows = len(result["rows"][:cap])
        csv_text = _csv_from(result["columns"], result["rows"][:cap])
    return {
        "csv": csv_text,
        "filename": f"{schema}.{table}.csv",
        "rows": rows,
        "truncated": truncated,
    }


@router.post("/table/sql")
async def table_sql(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    kind = _kind(conn)
    if kind in ("mcp", "http"):
        raise HTTPException(400, "SQL generation works on PostgreSQL, MySQL/MariaDB, ClickHouse and SQLite")
    schema = str(body.get("schema") or "")
    table = str(body.get("table") or "")
    if not schema or not table:
        raise HTTPException(400, "schema and table are required")
    quote = {
        "postgres": _ident,
        "mysql": _my_ident,
        "clickhouse": _ch_ident,
        "sqlite": _sqlite_ident,
    }[kind]
    filters = [item for item in body.get("filters") or [] if isinstance(item, dict)]
    filters = [
        item
        for item in filters
        if item.get("enabled") is not False
        and (
            str(item.get("op") or "").lower() in ("isnull", "notnull")
            or str(item.get("value") or "") != ""
        )
    ]
    sql = f"SELECT *\nFROM {quote(schema)}.{quote(table)}"
    where = _where_clause(kind, filters)
    if where:
        sql += f"\nWHERE {where}"
    order_by = str(body.get("order_by") or "").strip()
    if order_by:
        direction = "DESC" if str(body.get("order_dir") or "").lower() == "desc" else "ASC"
        sql += f"\nORDER BY {quote(order_by)} {direction}"
    limit = max(1, min(int(body.get("limit") or 100), MAX_ROWS))
    sql += f"\nLIMIT {limit};"
    return {"sql": sql}


@router.post("/table/rows")
async def table_rows(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    schema = str(body.get("schema") or "")
    table = str(body.get("table") or "")
    if not schema or not table:
        raise HTTPException(400, "schema and table are required")
    limit = max(1, min(int(body.get("limit") or 100), MAX_ROWS))
    offset = max(0, int(body.get("offset") or 0))
    order_by = str(body.get("order_by") or "").strip()
    direction = "DESC" if str(body.get("order_dir") or "").lower() == "desc" else "ASC"
    return _rows(conn, schema, table, limit, offset, order_by, direction, body.get("filters"))


# --------------------------------------------------------------------------- #
# SQL runner
# --------------------------------------------------------------------------- #


@router.post("/query")
async def run_query(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    sql = _check_sql(str(body.get("sql") or ""))
    limit = max(1, min(int(body.get("limit") or 200), MAX_ROWS))
    readonly = bool(conn.get("readonly", True))
    try:
        result = _query(conn, sql, limit, readonly)
    except HTTPException as exc:
        try:
            _record_history(conn, sql, error=str(exc.detail))
        except OSError:
            pass
        raise
    try:
        _record_history(conn, sql, result=result)
    except OSError:
        pass
    return result


@router.get("/audit")
async def audit_log(limit: int = 100) -> dict[str, Any]:
    return {"entries": _read_audit(max(1, min(limit, 500)))}


@router.get("/queries/history")
async def query_history(limit: int = 50, connection_id: str = "") -> dict[str, Any]:
    history = _load_queries()["history"]
    if connection_id:
        history = [h for h in history if h.get("connection_id") == connection_id]
    return {"history": history[: max(1, min(limit, 200))]}


@router.delete("/queries/history")
async def clear_history() -> dict[str, Any]:
    data = _load_queries()
    data["history"] = []
    _save_queries(data)
    return {"ok": True}


@router.get("/queries/saved")
async def list_saved() -> dict[str, Any]:
    return {"saved": _load_queries()["saved"]}


@router.post("/queries/saved")
async def save_query(body: dict[str, Any]) -> dict[str, Any]:
    name = str(body.get("name") or "").strip()[:80]
    sql = str(body.get("sql") or "").strip()
    if not name or not sql:
        raise HTTPException(400, "name and sql are required")
    data = _load_queries()
    query_id = str(body.get("id") or "").strip() or uuid.uuid4().hex[:10]
    entry = {
        "id": query_id,
        "name": name,
        "sql": sql[:8000],
        "connection_id": str(body.get("connection_id") or ""),
        "database": str(body.get("database") or ""),
        "created_at": time.time(),
    }
    data["saved"] = [q for q in data["saved"] if q["id"] != query_id] + [entry]
    _save_queries(data)
    return {"query": entry}


@router.delete("/queries/saved/{query_id}")
async def delete_saved(query_id: str) -> dict[str, Any]:
    data = _load_queries()
    kept = [q for q in data["saved"] if q["id"] != query_id]
    if len(kept) == len(data["saved"]):
        raise HTTPException(404, "saved query not found")
    data["saved"] = kept
    _save_queries(data)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# row edits
# --------------------------------------------------------------------------- #


def _audit_path() -> Path:
    return _data_dir() / "audit.jsonl"


def _audit(
    conn: dict[str, Any],
    action: str,
    sql: str,
    *,
    rows: int = 0,
    ok: bool = True,
    error: str = "",
    notify: bool = True,
) -> None:
    entry = {
        "ts": time.time(),
        "connection_id": conn.get("id", ""),
        "connection_name": conn.get("name", ""),
        "kind": _kind(conn),
        "database": conn.get("dbname", ""),
        "production": bool(conn.get("production")),
        "action": action,
        "approval_id": "",
        "rows": rows,
        "ok": ok,
        "error": error[:500],
        "sql": sql[:4000],
    }
    try:
        path = _audit_path()
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
        os.chmod(path, 0o600)
    except OSError:
        return
    if notify and entry["production"] and ok:
        _notify_production(entry)


def _notify_production(entry: dict[str, Any]) -> None:
    """Best-effort Telegram notice (fire and forget, never blocks the write)."""
    if os.environ.get("DBDESK_NOTIFY") != "1":
        return
    cli = shutil.which("hermes") or "/root/.local/bin/hermes"
    if not cli or not os.path.exists(cli):
        return
    text = (
        f"DB Desk PROD write: {entry['action']} on {entry['connection_name']} "
        f"({entry['database']}) · {entry['rows']} row(s)\n{entry['sql'][:300]}"
    )
    try:
        subprocess.Popen(
            [cli, "send", "--to", "telegram", text],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "PATH": "/root/.local/bin:/usr/local/bin:/usr/bin:/bin"},
        )
    except OSError:
        pass


def _approvals_path() -> Path:
    return _data_dir() / "approvals.json"


def _load_approvals() -> list[dict[str, Any]]:
    path = _approvals_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    entries = data.get("approvals") if isinstance(data, dict) else None
    return [entry for entry in entries or [] if isinstance(entry, dict) and entry.get("id")][:300]


def _save_approvals(entries: list[dict[str, Any]]) -> None:
    path = _approvals_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"approvals": entries}, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _approval_hash(sql: str) -> str:
    return hashlib.sha256(sql.encode("utf-8")).hexdigest()[:24]


def _approval_notice(entry: dict[str, Any]) -> None:
    if os.environ.get("DBDESK_NOTIFY") != "1":
        return
    cli = shutil.which("hermes") or "/root/.local/bin/hermes"
    if not cli or not os.path.exists(cli):
        return
    url = ""
    try:
        from hermes_cli.config import load_config

        config = load_config() or {}
        url = str(((config.get("webapp") or {}).get("public_url") or "")).rstrip("/")
    except Exception:
        pass
    where = f"\nOpen {url}/#/dbdesk → Approvals" if url else "\nOpen DB Desk → Approvals"
    text = (
        f"DB Desk approval required\n{entry['action']} on {entry['connection_name']} "
        f"({entry['database']})\n{entry['sql'][:400]}{where}"
    )
    try:
        subprocess.Popen(
            [cli, "send", "-t", "telegram", text],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "PATH": "/root/.local/bin:/usr/local/bin:/usr/bin:/bin"},
        )
    except OSError:
        pass


def _require_approval(conn: dict[str, Any], body: dict[str, Any], action: str, sql: str) -> str:
    """A production write needs an approved, unconsumed approval for this SQL."""
    if not conn.get("production"):
        return ""
    approval_id = str(body.get("approval_id") or "").strip()
    if not approval_id:
        raise HTTPException(403, "approval_required: this production write needs an approval")
    entries = _load_approvals()
    entry = next((item for item in entries if item.get("id") == approval_id), None)
    if (
        entry is None
        or entry.get("status") != "approved"
        or entry.get("used_at")
        or entry.get("connection_id") != conn.get("id")
        or entry.get("hash") != _approval_hash(sql)
    ):
        raise HTTPException(403, "approval_invalid: approve this exact statement first")
    entry["used_at"] = time.time()
    _save_approvals(entries)
    return approval_id


def _read_audit(limit: int = 100) -> list[dict[str, Any]]:
    path = _audit_path()
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    entries = []
    for line in reversed(lines):
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue
    return entries


def _predicate(quote, literal, pk: dict[str, Any]) -> str:
    return " AND ".join(
        f"{quote(k)} IS NULL" if v is None else f"{quote(k)} = {literal(v)}" for k, v in pk.items()
    )


def _build_update(conn, schema, table, pk, changes) -> tuple[str, bool]:
    kind = _kind(conn)
    if kind == "sqlite":
        sets = ", ".join(f"{_sqlite_ident(k)} = {_sqlite_lit(v)}" for k, v in changes.items())
        where = _predicate(_sqlite_ident, _sqlite_lit, pk)
        return f"UPDATE {_sqlite_ident(table)} SET {sets} WHERE {where}", False
    if kind == "mysql":
        sets = ", ".join(f"{_my_ident(k)} = {_my_lit(v)}" for k, v in changes.items())
        where = _predicate(_my_ident, _my_lit, pk)
        return f"UPDATE {_my_ident(schema)}.{_my_ident(table)} SET {sets} WHERE {where}", False
    if kind == "clickhouse":
        sets = ", ".join(f"{_ch_ident(k)} = {_ch_lit(v)}" for k, v in changes.items())
        where = _predicate(_ch_ident, _ch_lit, pk)
        return (
            f"ALTER TABLE {_ch_ident(schema)}.{_ch_ident(table)} UPDATE {sets} WHERE {where}",
            True,
        )
    sets = ", ".join(f"{_ident(k)} = {_lit(v)}" for k, v in changes.items())
    where = _predicate(_ident, _lit, pk)
    return f"UPDATE {_ident(schema)}.{_ident(table)} SET {sets} WHERE {where}", False


def _build_delete(conn, schema, table, pk) -> tuple[str, bool]:
    kind = _kind(conn)
    if kind == "sqlite":
        where = _predicate(_sqlite_ident, _sqlite_lit, pk)
        return f"DELETE FROM {_sqlite_ident(table)} WHERE {where}", False
    if kind == "mysql":
        where = _predicate(_my_ident, _my_lit, pk)
        return f"DELETE FROM {_my_ident(schema)}.{_my_ident(table)} WHERE {where}", False
    if kind == "clickhouse":
        where = _predicate(_ch_ident, _ch_lit, pk)
        return f"ALTER TABLE {_ch_ident(schema)}.{_ch_ident(table)} DELETE WHERE {where}", True
    where = _predicate(_ident, _lit, pk)
    return f"DELETE FROM {_ident(schema)}.{_ident(table)} WHERE {where}", False


def _build_insert(conn, schema, table, values) -> tuple[str, bool]:
    kind = _kind(conn)
    if kind == "sqlite":
        cols = ", ".join(_sqlite_ident(k) for k in values)
        vals = ", ".join("NULL" if v is None else _sqlite_lit(v) for v in values.values())
        return f"INSERT INTO {_sqlite_ident(table)} ({cols}) VALUES ({vals})", False
    if kind == "mysql":
        cols = ", ".join(_my_ident(k) for k in values)
        vals = ", ".join("NULL" if v is None else _my_lit(v) for v in values.values())
        return f"INSERT INTO {_my_ident(schema)}.{_my_ident(table)} ({cols}) VALUES ({vals})", False
    if kind == "clickhouse":
        cols = ", ".join(_ch_ident(k) for k in values)
        vals = ", ".join("NULL" if v is None else _ch_lit(v) for v in values.values())
        return f"INSERT INTO {_ch_ident(schema)}.{_ch_ident(table)} ({cols}) VALUES ({vals})", False
    cols = ", ".join(_ident(k) for k in values)
    vals = ", ".join("NULL" if v is None else _lit(v) for v in values.values())
    return f"INSERT INTO {_ident(schema)}.{_ident(table)} ({cols}) VALUES ({vals})", False


def _build_insert_multi(conn, schema, table, columns, rows) -> str:
    kind = _kind(conn)
    quote = {
        "postgres": _ident, "mysql": _my_ident, "clickhouse": _ch_ident, "sqlite": _sqlite_ident
    }[kind]
    literal = {
        "postgres": _lit, "mysql": _my_lit, "clickhouse": _ch_lit, "sqlite": _sqlite_lit
    }[kind]
    cols = ", ".join(quote(column) for column in columns)
    values = ",\n  ".join(
        "(" + ", ".join("NULL" if value is None else literal(value) for value in row) + ")"
        for row in rows
    )
    target = (
        f"{quote(table)}" if kind == "sqlite" else f"{quote(schema)}.{quote(table)}"
    )
    return f"INSERT INTO {target} ({cols}) VALUES\n  {values}"


def _run_mutation(conn, sql: str) -> None:
    _invalidate_columns()
    kind = _kind(conn)
    if kind == "sqlite":
        _sqlite_mutation(conn, sql)
    elif kind == "mysql":
        _my_mutation(conn, sql)
    elif kind == "clickhouse":
        _ch_mutation(conn, sql)
    else:
        _pg_mutation(conn, sql)


def _mutation(
    conn, body: dict[str, Any], sql: str, is_async: bool, action: str = "write"
) -> dict[str, Any]:
    """``preview: true`` returns the exact statement without running it."""
    if body.get("preview"):
        return {"ok": True, "preview": True, "sql": sql + ";", "async": is_async}
    _require_approval(conn, body, action, sql + ";")
    try:
        _run_mutation(conn, sql)
    except Exception as exc:
        _audit(conn, action, sql, ok=False, error=str(getattr(exc, "detail", exc)))
        raise
    _audit(conn, action, sql, ok=True)
    return {"ok": True, "sql": sql + ";", "async": is_async}


IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
TYPE_RE = re.compile(r"^[A-Za-z0-9_ ,().\[\]]{1,120}$")


@router.post("/table/alter")
async def alter_table(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    _writable(conn)
    schema = str(body.get("schema") or "")
    table = str(body.get("table") or "")
    action = str(body.get("action") or "")
    name = str(body.get("name") or "").strip()
    if not schema or not table or not action:
        raise HTTPException(400, "schema, table and action are required")
    if not IDENT_RE.match(name):
        raise HTTPException(400, "invalid column name")
    kind = _kind(conn)
    quote = {
        "postgres": _ident, "mysql": _my_ident, "clickhouse": _ch_ident, "sqlite": _sqlite_ident
    }[kind]
    literal = {
        "postgres": _lit, "mysql": _my_lit, "clickhouse": _ch_lit, "sqlite": _sqlite_lit
    }[kind]
    target = (
        f"{quote(table)}" if kind == "sqlite" else f"{quote(schema)}.{quote(table)}"
    )

    if action == "add_column":
        column_type = str(body.get("type") or "").strip()
        if not column_type or not TYPE_RE.match(column_type):
            raise HTTPException(400, "invalid column type")
        nullable = bool(body.get("nullable", True))
        default = body.get("default")
        if kind == "mysql":
            sql = f"ALTER TABLE {target} ADD COLUMN {quote(name)} {column_type} " + (
                "NULL" if nullable else "NOT NULL"
            )
            if default not in (None, ""):
                sql += f" DEFAULT {literal(default)}"
        elif kind == "clickhouse":
            sql = f"ALTER TABLE {target} ADD COLUMN {quote(name)} {column_type}"
            if default not in (None, ""):
                sql += f" DEFAULT {literal(default)}"
        else:
            sql = f"ALTER TABLE {target} ADD COLUMN {quote(name)} {column_type}"
            if not nullable:
                sql += " NOT NULL"
            if default not in (None, ""):
                sql += f" DEFAULT {literal(default)}"
    elif action == "drop_column":
        sql = f"ALTER TABLE {target} DROP COLUMN {quote(name)}"
    elif action == "rename_column":
        new_name = str(body.get("new_name") or "").strip()
        if not IDENT_RE.match(new_name):
            raise HTTPException(400, "invalid new column name")
        sql = f"ALTER TABLE {target} RENAME COLUMN {quote(name)} TO {quote(new_name)}"
    else:
        raise HTTPException(400, "unknown action")

    return _mutation(conn, body, sql, kind == "clickhouse", "alter")


@router.post("/approvals")
async def create_approval(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    if not conn.get("production"):
        raise HTTPException(400, "approvals are only needed for production connections")
    sql = str(body.get("sql") or "").strip()
    action = str(body.get("action") or "write").strip()
    if not sql:
        raise HTTPException(400, "sql is required")
    entry = {
        "id": uuid.uuid4().hex[:12],
        "ts": time.time(),
        "connection_id": conn.get("id"),
        "connection_name": conn.get("name", ""),
        "database": conn.get("dbname", ""),
        "schema": str(body.get("schema") or ""),
        "table": str(body.get("table") or ""),
        "action": action,
        "sql": sql[:4000],
        "hash": _approval_hash(sql),
        "status": "pending",
        "decided_at": None,
        "used_at": None,
    }
    entries = _load_approvals()
    entries.append(entry)
    _save_approvals(entries[:300])
    _approval_notice(entry)
    _audit(conn, "approval_requested", sql)
    return {"approval": entry}


@router.get("/approvals")
async def list_approvals(limit: int = 50) -> dict[str, Any]:
    entries = _load_approvals()
    entries.sort(key=lambda item: item.get("ts") or 0, reverse=True)
    return {"approvals": entries[: max(1, min(limit, 200))]}


@router.post("/approvals/{approval_id}/decision")
async def decide_approval(approval_id: str, body: dict[str, Any]) -> dict[str, Any]:
    decision = str(body.get("decision") or "").strip().lower()
    if decision not in ("approve", "deny"):
        raise HTTPException(400, "decision must be approve or deny")
    entries = _load_approvals()
    entry = next((item for item in entries if item.get("id") == approval_id), None)
    if entry is None:
        raise HTTPException(404, "approval not found")
    if entry.get("status") != "pending":
        raise HTTPException(409, f"approval already {entry.get('status')}")
    entry["status"] = "approved" if decision == "approve" else "denied"
    entry["decided_at"] = time.time()
    action = str(entry.get("action") or "")
    payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else {}
    if decision == "approve" and action in ("delete_connection", "update_connection"):
        target = str(payload.get("connection_id") or entry.get("connection_id") or "")
        try:
            existing = _get(target)
        except HTTPException as exc:
            entry["status"] = "failed"
            entry["error"] = str(exc.detail)
            _save_approvals(entries)
            raise
        if action == "delete_connection":
            _audit(existing, "mcp_connection_delete", str(entry.get("sql") or ""), ok=True, notify=False)
            _save([conn for conn in _load() if conn["id"] != target])
            _close_pools()
            _invalidate_columns()
        else:
            changes = payload.get("changes") if isinstance(payload.get("changes"), dict) else {}
            try:
                await save_connection({**_public(existing), **changes, "id": target})
            except HTTPException as exc:
                entry["status"] = "failed"
                entry["error"] = str(exc.detail)
                _save_approvals(entries)
                raise
            _audit(existing, "mcp_connection_update", str(entry.get("sql") or ""), ok=True, notify=False)
        entry["used_at"] = time.time()
    _save_approvals(entries)
    return {"approval": entry}


@router.post("/rows/delete_bulk")
async def delete_rows_bulk(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    _writable(conn)
    schema = str(body.get("schema") or "")
    table = str(body.get("table") or "")
    pks = body.get("pks") or []
    if not table or not isinstance(pks, list) or not pks:
        raise HTTPException(400, "table and pks are required")
    if len(pks) > 500:
        raise HTTPException(400, "too many rows (500 max per bulk delete)")
    statements = []
    for pk in pks:
        if not isinstance(pk, dict) or not pk:
            raise HTTPException(400, "every pk must be an object")
        sql, _ = _build_delete(conn, schema, table, pk)
        statements.append(sql)
    preview_sql = statements[0] + (
        f"\n-- … {len(statements) - 1} more statement(s), {len(statements)} rows total"
        if len(statements) > 1
        else ""
    )
    if body.get("preview"):
        return {"preview": True, "sql": preview_sql + ";", "rows": len(statements)}
    _require_approval(conn, body, "delete_bulk", preview_sql + ";")
    kind = _kind(conn)
    if kind == "sqlite":
        _sqlite_exec(conn, statements)
    elif kind == "mysql":
        if pymysql is not None:
            _my_native_script(conn, statements)
        else:
            _my_run(conn, "START TRANSACTION;\n" + ";\n".join(statements) + ";\nCOMMIT;", readonly=False)
    elif kind == "clickhouse":
        for statement in statements:
            _ch_mutation(conn, statement)
    else:
        if psycopg is not None:
            _pg_native_script(conn, statements)
        else:
            _pg_run(conn, "BEGIN;\n" + ";\n".join(statements) + ";\nCOMMIT;\n", readonly=False)
    _invalidate_columns()
    _audit(conn, "delete_bulk", preview_sql, rows=len(statements))
    return {"ok": True, "rows": len(statements)}


@router.post("/rows/update")
async def update_row(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    _writable(conn)
    schema, table = str(body.get("schema") or ""), str(body.get("table") or "")
    pk = body.get("pk") or {}
    changes = body.get("changes") or {}
    if not table or not pk or not changes:
        raise HTTPException(400, "table, pk and changes are required")
    sql, is_async = _build_update(conn, schema, table, pk, changes)
    return _mutation(conn, body, sql, is_async, "update")


@router.post("/rows/delete")
async def delete_row(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    _writable(conn)
    schema, table = str(body.get("schema") or ""), str(body.get("table") or "")
    pk = body.get("pk") or {}
    if not table or not pk:
        raise HTTPException(400, "table and pk are required")
    sql, is_async = _build_delete(conn, schema, table, pk)
    return _mutation(conn, body, sql, is_async, "delete")


@router.post("/rows/import")
async def import_rows(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    _writable(conn)
    schema = str(body.get("schema") or "")
    table = str(body.get("table") or "")
    columns = [str(column) for column in body.get("columns") or []]
    rows = body.get("rows") or []
    if not schema or not table or not columns or not rows:
        raise HTTPException(400, "schema, table, columns and rows are required")
    if len(columns) > 200:
        raise HTTPException(400, "too many columns")
    if len(rows) > 5000:
        raise HTTPException(400, "too many rows (5000 max per import)")
    normalized: list[list[Any]] = []
    for row in rows:
        if not isinstance(row, list) or len(row) != len(columns):
            raise HTTPException(400, "every row must have the same number of columns")
        normalized.append(row)

    chunks = [normalized[index : index + 200] for index in range(0, len(normalized), 200)]
    statements = [_build_insert_multi(conn, schema, table, columns, chunk) for chunk in chunks]

    note = (
        f"\n-- … {len(statements) - 1} more statement(s), {len(normalized)} rows total"
        if len(statements) > 1
        else ""
    )
    preview_sql = statements[0] + ";" + note
    if body.get("preview"):
        return {
            "preview": True,
            "sql": preview_sql,
            "statements": len(statements),
            "rows": len(normalized),
        }

    _require_approval(conn, body, "import", preview_sql)
    kind = _kind(conn)
    if kind == "sqlite":
        _sqlite_exec(conn, statements)
    elif kind == "clickhouse":
        for statement in statements:
            _ch_mutation(conn, statement)
    elif kind == "mysql":
        if pymysql is not None:
            _my_native_script(conn, statements)
        else:
            _my_run(
                conn,
                "START TRANSACTION;\n" + ";\n".join(statements) + ";\nCOMMIT;",
                readonly=False,
            )
    else:
        if psycopg is not None:
            _pg_native_script(conn, statements)
        else:
            _pg_run(
                conn,
                "BEGIN;\n" + ";\n".join(statements) + ";\nCOMMIT;\n",
                readonly=False,
            )
    _invalidate_columns()
    _audit(conn, "import", f"INSERT {len(normalized)} row(s) into {schema}.{table}", rows=len(normalized))
    return {"ok": True, "rows": len(normalized), "statements": len(statements)}


@router.post("/rows/insert")
async def insert_row(body: dict[str, Any]) -> dict[str, Any]:
    conn = _with_db(_connect(str(body.get("connection_id") or "")), body.get("database"))
    _writable(conn)
    schema, table = str(body.get("schema") or ""), str(body.get("table") or "")
    values = body.get("values") or {}
    if not table or not values:
        raise HTTPException(400, "table and values are required")
    sql, is_async = _build_insert(conn, schema, table, values)
    return _mutation(conn, body, sql, is_async, "insert")
