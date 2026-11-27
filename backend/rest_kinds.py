"""Engines that are reached over HTTP instead of a database wire protocol.

Elasticsearch, InfluxDB 3, Cloudflare D1 and libSQL/Turso have no driver to install and no
port to tunnel: each is a REST API with its own vocabulary, its own way of naming a table,
and its own JSON shape for a row. That is why they live here rather than inside the
PostgreSQL-shaped parts of the API — the only shared thing is how a request is made.

Shared rules:

* Credentials come from the connection (user/password, already decrypted) and are turned
  into the header that engine expects. Nothing is written to a log or an error message.
* Read-only is enforced here, before the statement leaves the process, because there is no
  server-side grant to fall back on for a token that can write.
* An error carries the engine name and the API's own message: "Elasticsearch: index_not_found"
  tells you what to do, a bare 500 does not.
"""

from __future__ import annotations

import base64
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from fastapi import HTTPException

TIMEOUT = 30

# Kinds handled by this module. Kept as a set so the API can ask "is this one of ours?".
REST_KINDS = {"elasticsearch", "influxdb3", "d1", "libsql"}


# --------------------------------------------------------------------------- #
# plumbing
# --------------------------------------------------------------------------- #


def _base(conn: dict[str, Any], default_port: int) -> str:
    """Base URL: the host field may already be a full URL (Cloudflare, Turso)."""
    host = str(conn.get("host") or "").strip().rstrip("/")
    if not host:
        raise HTTPException(400, "host is required")
    if host.startswith(("http://", "https://")):
        return host
    port = int(conn.get("port") or default_port)
    scheme = "https" if str(conn.get("sslmode") or "") == "require" or port == 443 else "http"
    if (scheme, port) == ("https", 443):
        return f"https://{host}"
    return f"{scheme}://{host}:{port}"


def _request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: Any = None,
    timeout: int = TIMEOUT,
    engine: str = "HTTP",
) -> tuple[int, Any]:
    data = None
    merged = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
        merged["Content-Type"] = "application/json"
    merged.update(headers or {})
    request = urllib.request.Request(url, data=data, method=method, headers=merged)
    context = ssl.create_default_context()
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    except urllib.error.URLError as exc:
        # A connection error is the most common failure and the least useful as a 500, so
        # name the engine and keep the host visible.
        raise HTTPException(502, f"{engine}: could not reach {urlparse.host(url)} — {exc.reason}") from exc
    except TimeoutError as exc:
        raise HTTPException(504, f"{engine}: {urlparse.host(url)} timed out after {timeout}s") from exc
    try:
        parsed = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        parsed = {"raw": raw[:400].decode(errors="replace")}
    if status >= 400:
        raise HTTPException(status, _explain(parsed, status))
    return status, parsed


def _explain(parsed: Any, status: int) -> str:
    """Pull the useful sentence out of an error body instead of dumping the whole thing."""
    if isinstance(parsed, dict):
        for key in ("error", "message", "detail", "errors"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:300]
            if isinstance(value, dict):
                for inner in ("reason", "message", "type"):
                    text = value.get(inner)
                    if isinstance(text, str) and text.strip():
                        return text.strip()[:300]
            if isinstance(value, list) and value:
                first = value[0]
                if isinstance(first, dict):
                    text = first.get("message") or first.get("code") or first.get("detail")
                    if isinstance(text, str):
                        return text.strip()[:300]
                if isinstance(first, str):
                    return first[:300]
        if parsed.get("raw"):
            return str(parsed["raw"])[:300]
    return f"request failed with status {status}"


def _basic_auth(conn: dict[str, Any]) -> str:
    user = str(conn.get("user") or "")
    password = str(conn.get("password") or "")
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    return f"Basic {token}"


def _bearer(conn: dict[str, Any]) -> str:
    # The password field holds the token: one secret field, whichever the provider calls it.
    token = str(conn.get("password") or conn.get("user") or "").strip()
    if not token:
        raise HTTPException(400, "an API token is required (stored in the password field)")
    return f"Bearer {token}"


def _guard(conn: dict[str, Any], sql: str) -> None:
    """Refuse a write on a read-only connection before it is sent anywhere."""
    if not conn.get("readonly", True):
        return
    statement = sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""
    if statement not in ("SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "GET"):
        raise HTTPException(403, "this connection is read-only; turn off read-only in its settings")


def _columns_from_rows(rows: list[dict[str, Any]], limit: int = 50) -> list[dict[str, Any]]:
    """Column list for an engine that returns JSON objects: keys, typed from the values."""
    names: list[str] = []
    for row in rows[:limit]:
        for key in row:
            if key not in names:
                names.append(key)
    return [{"name": name, "type": _type_of([row.get(name) for row in rows[:limit]])}
            for name in names]


ARROW_TYPES = {
    "Dictionary(Int32, Utf8)": "VARCHAR",
    "Utf8": "VARCHAR",
    "Float64": "DOUBLE",
    "Float32": "FLOAT",
    "Int64": "BIGINT",
    "Int32": "INTEGER",
    "Boolean": "BOOLEAN",
}


def _arrow_type(data_type: str) -> str:
    text = str(data_type or "")
    if text in ARROW_TYPES:
        return ARROW_TYPES[text]
    if text.startswith("Timestamp"):
        return "TIMESTAMP"
    return text


def _type_of(values: list[Any]) -> str:
    for value in values:
        if value is None:
            continue
        if isinstance(value, bool):
            return "BOOLEAN"
        if isinstance(value, int):
            return "BIGINT"
        if isinstance(value, float):
            return "DOUBLE"
        if isinstance(value, dict):
            return "OBJECT"
        if isinstance(value, list):
            return "ARRAY"
        return "VARCHAR"
    return ""


def _flatten(value: Any, prefix: str = "", depth: int = 0) -> dict[str, Any]:
    """Elasticsearch documents are nested; the grid is a table, so flatten two levels."""
    if not isinstance(value, dict) or depth >= 2:
        return {prefix.rstrip(".") or "value": value}
    out: dict[str, Any] = {}
    for key, item in value.items():
        out.update(_flatten(item, f"{prefix}{key}.", depth + 1))
    return out


def _ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


class urlparse:  # noqa: N801 - a tiny helper, not the stdlib class
    """Just the host, for error messages."""

    @staticmethod
    def host(url: str) -> str:
        rest = url.split("://", 1)[-1]
        return rest.split("/", 1)[0]


def engine_name(kind: str) -> str:
    return {
        "elasticsearch": "Elasticsearch",
        "influxdb3": "InfluxDB 3",
        "d1": "Cloudflare D1",
        "libsql": "libSQL",
    }.get(kind, kind)


# --------------------------------------------------------------------------- #
# Elasticsearch
# --------------------------------------------------------------------------- #


def _es_request(method: str, url: str, *, headers=None, body=None):
    return _request(method, url, headers=headers, body=body, engine="Elasticsearch")


def _influx_request(method: str, url: str, *, headers=None, body=None):
    return _request(method, url, headers=headers, body=body, engine="InfluxDB 3")


def _d1_request(method: str, url: str, *, headers=None, body=None):
    return _request(method, url, headers=headers, body=body, engine="Cloudflare D1")


def _libsql_request(method: str, url: str, *, headers=None, body=None):
    return _request(method, url, headers=headers, body=body, engine="libSQL")


def _es_headers(conn: dict[str, Any]) -> dict[str, str]:
    api_key = str(conn.get("http_headers") or "").strip()
    if api_key.lower().startswith("apikey "):
        return {"Authorization": api_key}
    if conn.get("user") or conn.get("password"):
        return {"Authorization": _basic_auth(conn)}
    return {}


def es_test(conn: dict[str, Any]) -> dict[str, Any]:
    _, info = _es_request("GET", _base(conn, 9200), headers=_es_headers(conn))
    version = (info.get("version") or {}).get("number") or "?"
    return {
        "version": f"Elasticsearch {version} · {(info.get('cluster_name') or '')}".strip(" ·"),
        "database": str(conn.get("dbname") or conn.get("host") or ""),
        "user": str(conn.get("user") or "api-key"),
    }


def es_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    url = _base(conn, 9200) + "/_cat/indices?format=json&h=index,docs.count,health"
    _, payload = _es_request("GET", url, headers=_es_headers(conn))
    rows = payload if isinstance(payload, list) else []
    return [
        {
            "schema": "indices",
            "name": str(row.get("index")),
            "kind": "table",
            "est_rows": int(row.get("docs.count") or 0) if str(row.get("docs.count") or "").isdigit() else 0,
        }
        for row in sorted(rows, key=lambda item: str(item.get("index")))
        # An index whose name starts with "." is Elasticsearch's own bookkeeping.
        if not str(row.get("index", "")).startswith(".")
    ]


def es_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    url = _base(conn, 9200) + f"/{urllib.parse.quote(table)}/_mapping"
    _, payload = _es_request("GET", url, headers=_es_headers(conn))
    properties: dict[str, Any] = {}
    for index in payload.values():
        mapping = (index.get("mappings") or {}).get("properties") or {}
        for name, spec in mapping.items():
            properties[name] = spec
    out = []
    for name, spec in properties.items():
        kind = str(spec.get("type") or ("object" if "properties" in spec else "unknown"))
        out.append({
            "name": name,
            "type": kind,
            "nullable": True,
            "default": "",
            "primary": name == "_id",
        })
    return out


def es_rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
            where: str = "", columns_meta=None) -> dict[str, Any]:
    started = time.monotonic()
    body: dict[str, Any] = {"size": int(limit) + 1, "from": int(offset)}
    # Sorted on _doc unless asked otherwise: a stable page beats a relevance order nobody
    # asked for when the grid is paging.
    body["sort"] = [{order_by: {"order": str(direction).lower()}}] if order_by else [{"_doc": "asc"}]
    if where:
        body["query"] = {"query_string": {"query": where, "lenient": True}}
    _, payload = _es_request(
        "POST", _base(conn, 9200) + f"/{urllib.parse.quote(table)}/_search",
        headers=_es_headers(conn), body=body,
    )
    hits = ((payload.get("hits") or {}).get("hits") or [])
    documents = [dict(_flatten(hit.get("_source") or {}), _id=hit.get("_id")) for hit in hits]
    names: list[str] = []
    for document in documents:
        for key in document:
            if key not in names:
                names.append(key)
    rows = [[document.get(name) for name in names] for document in documents[: int(limit)]]
    return {
        "columns": [{"name": name, "type": _type_of([d.get(name) for d in documents])}
                    for name in names],
        "rows": rows,
        "truncated": len(documents) > int(limit),
        "offset": int(offset),
        "limit": int(limit),
        "duration_ms": _ms(started),
    }


def es_query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    """Elasticsearch has a SQL endpoint, but only on some distributions; try it and say so."""
    _guard(conn, sql)
    started = time.monotonic()
    url = _base(conn, 9200) + "/_sql?format=json"
    _, payload = _es_request("POST", url, headers=_es_headers(conn), body={"query": sql, "fetch_size": int(limit)})
    columns = payload.get("columns") or []
    rows = payload.get("rows") or []
    return {
        "columns": [{"name": str(col.get("name")), "type": str(col.get("type") or "")} for col in columns],
        "rows": rows[: int(limit)],
        "truncated": len(rows) > int(limit),
        "command": "SELECT",
        "readonly": readonly,
        "duration_ms": _ms(started),
    }


def es_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    url = _base(conn, 9200) + f"/{urllib.parse.quote(table)}/_mapping"
    _, payload = _es_request("GET", url, headers=_es_headers(conn))
    mapping = {}
    for index in payload.values():
        mapping.update((index.get("mappings") or {}))
    body = json.dumps(mapping, indent=2)
    return f"PUT /{table}\n{{\n  \"mappings\": {body.replace(chr(10), chr(10) + '  ')}\n}}"


# --------------------------------------------------------------------------- #
# InfluxDB 3
# --------------------------------------------------------------------------- #


def _influx_headers(conn: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": _bearer(conn)}


def _influx_sql(conn: dict[str, Any], sql: str, limit: int | None = None) -> list[dict[str, Any]]:
    database = str(conn.get("dbname") or "").strip()
    if not database:
        raise HTTPException(400, "InfluxDB 3 needs a database name")
    url = _base(conn, 8181) + "/api/v3/query_sql"
    body = {"db": database, "q": sql, "format": "json"}
    if limit:
        body["limit"] = int(limit)
    _, payload = _influx_request("POST", url, headers=_influx_headers(conn), body=body)
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    return []


def influx_test(conn: dict[str, Any]) -> dict[str, Any]:
    _, health = _influx_request("GET", _base(conn, 8181) + "/health", headers=_influx_headers(conn))
    # /health answers plain text "OK" unless JSON is requested; a version is a bonus, not a
    # requirement, so it is only shown when the server actually reports one.
    version = ""
    if isinstance(health, dict):
        version = str(health.get("version") or "")
    # Count the user's measurements only: SHOW TABLES also lists the system schema.
    tables = [
        row for row in (_influx_sql(conn, "SHOW TABLES") if conn.get("dbname") else [])
        if str(row.get("table_schema") or "") not in ("system", "information_schema")
    ]
    label = f"InfluxDB {version}" if version else "InfluxDB 3"
    return {
        "version": f"{label} · {len(tables)} table(s)",
        "database": str(conn.get("dbname") or ""),
        "user": "token",
        "probe": list(health)[:4] if isinstance(health, dict) else str(health)[:40],
    }


def influx_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    rows = _influx_sql(conn, "SHOW TABLES")
    out = []
    for row in rows:
        name = row.get("table_name") or row.get("name") or row.get("table")
        if not name:
            continue
        schema = str(row.get("table_schema") or conn.get("dbname") or "public")
        if schema in ("system", "information_schema"):
            continue
        out.append({
            "schema": schema,
            "name": str(name),
            "kind": "view" if str(row.get("table_type") or "").upper() == "VIEW" else "table",
            "est_rows": 0,
        })
    return out


def influx_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    rows = _influx_sql(conn, f'SHOW COLUMNS FROM "{table}"')
    out = []
    for row in rows:
        name = row.get("column_name") or row.get("name")
        if not name:
            continue
        out.append({
            "name": str(name),
            "type": _arrow_type(str(row.get("data_type") or row.get("type") or "")),
            "nullable": str(row.get("is_nullable") or "YES").upper() != "NO",
            "default": "",
            "primary": str(row.get("column_name") or "") == "time",
        })
    return out


def influx_rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
                where: str = "", columns_meta=None) -> dict[str, Any]:
    started = time.monotonic()
    sql = f'SELECT * FROM "{table}"'
    if where:
        sql += f" WHERE {where}"
    order = order_by or "time"
    sql += f' ORDER BY "{order}" {"DESC" if str(direction).upper() == "DESC" else "ASC"}'
    sql += f" LIMIT {int(limit) + 1} OFFSET {int(offset)}"
    documents = _influx_sql(conn, sql, limit=int(limit) + 1)
    names: list[str] = []
    for document in documents:
        for key in document:
            if key not in names:
                names.append(key)
    meta = {column["name"]: column.get("type", "") for column in (columns_meta or [])}
    return {
        "columns": [{"name": name, "type": meta.get(name) or _type_of([d.get(name) for d in documents])}
                    for name in names],
        "rows": [[document.get(name) for name in names] for document in documents[: int(limit)]],
        "truncated": len(documents) > int(limit),
        "offset": int(offset),
        "limit": int(limit),
        "duration_ms": _ms(started),
    }


def influx_query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    _guard(conn, sql)
    started = time.monotonic()
    documents = _influx_sql(conn, sql, limit=int(limit) + 1)
    columns = _columns_from_rows(documents)
    return {
        "columns": columns,
        "rows": [[document.get(column["name"]) for column in columns] for document in documents[: int(limit)]],
        "truncated": len(documents) > int(limit),
        "command": "SELECT",
        "readonly": readonly,
        "duration_ms": _ms(started),
    }


def influx_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    columns = influx_columns(conn, schema, table)
    lines = ",\n".join(
        f'  "{column["name"]}" {column["type"] or "VARCHAR"}' for column in columns
    )
    return f'-- InfluxDB 3 measurement "{table}" (schema is implicit; written as a table sketch)\nCREATE TABLE "{table}" (\n{lines}\n);'


# --------------------------------------------------------------------------- #
# Cloudflare D1
# --------------------------------------------------------------------------- #


def _d1_url(conn: dict[str, Any]) -> str:
    account = str(conn.get("user") or "").strip()
    database = str(conn.get("dbname") or "").strip()
    if not account or not database:
        raise HTTPException(400, "D1 needs the account id (user) and the database id (database)")
    host = str(conn.get("host") or "").strip().rstrip("/")
    base = _base(conn, 443) if host else "https://api.cloudflare.com"
    if "/client/v4" not in base:
        base += "/client/v4"
    return f"{base}/accounts/{account}/d1/database/{database}/query"


def _d1_run(conn: dict[str, Any], sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
    _, payload = _d1_request(
        "POST", _d1_url(conn),
        headers={"Authorization": _bearer(conn)},
        body={"sql": sql, "params": params or []},
    )
    result = payload.get("result") or []
    if isinstance(result, list) and result:
        first = result[0]
        if isinstance(first, dict):
            return first.get("results") or []
    return []


def d1_test(conn: dict[str, Any]) -> dict[str, Any]:
    rows = _d1_run(conn, "select sqlite_version() as version")
    tables = _d1_run(conn, "select count(*) as n from sqlite_master where type = 'table'")
    version = (rows[0].get("version") if rows else "?") or "?"
    count = (tables[0].get("n") if tables else 0) or 0
    return {
        "version": f"D1 · SQLite {version} · {int(count)} table(s)",
        "database": str(conn.get("dbname") or ""),
        "user": str(conn.get("user") or ""),
    }


def d1_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    rows = _d1_run(
        conn,
        "select name, type from sqlite_master "
        "where type in ('table','view') and name not like 'sqlite_%' order by name",
    )
    return [
        {"schema": "main", "name": str(row.get("name")), "kind": str(row.get("type")) == "view" and "view" or "table",
         "est_rows": 0}
        for row in rows
    ]


def d1_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    rows = _d1_run(conn, f'pragma table_info("{table}")')
    return [
        {
            "name": str(row.get("name")),
            "type": str(row.get("type") or "").upper(),
            "nullable": not bool(row.get("notnull")),
            "default": "" if row.get("dflt_value") is None else str(row.get("dflt_value")),
            "primary": bool(row.get("pk")),
        }
        for row in rows
    ]


def d1_rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
            where: str = "", columns_meta=None) -> dict[str, Any]:
    started = time.monotonic()
    sql = f'select * from "{table}"'
    if where:
        sql += f" where {where}"
    if order_by:
        sql += f' order by "{order_by}" {"desc" if str(direction).upper() == "DESC" else "asc"}'
    sql += f" limit {int(limit) + 1} offset {int(offset)}"
    documents = _d1_run(conn, sql)
    columns = columns_meta or _columns_from_rows(documents)
    names = [column["name"] for column in columns] or list(documents[0].keys() if documents else [])
    meta = {column["name"]: column.get("type", "") for column in columns}
    return {
        "columns": [{"name": name, "type": meta.get(name, "")} for name in names],
        "rows": [[document.get(name) for name in names] for document in documents[: int(limit)]],
        "truncated": len(documents) > int(limit),
        "offset": int(offset),
        "limit": int(limit),
        "duration_ms": _ms(started),
    }


def d1_query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    _guard(conn, sql)
    started = time.monotonic()
    documents = _d1_run(conn, sql)
    # A write statement comes back with no rows; report it as such rather than inventing one.
    columns = _columns_from_rows(documents) if documents else []
    is_read = sql.lstrip().split(None, 1)[0].upper() in ("SELECT", "WITH", "PRAGMA", "EXPLAIN")
    return {
        "columns": columns,
        "rows": [[document.get(column["name"]) for column in columns] for document in documents[: int(limit)]],
        "truncated": len(documents) > int(limit),
        "command": "SELECT" if is_read else sql.split(None, 1)[0].upper(),
        "readonly": readonly,
        "duration_ms": _ms(started),
    }


def d1_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    rows = _d1_run(conn, "select sql from sqlite_master where name = ?", [table])
    if rows and rows[0].get("sql"):
        return str(rows[0]["sql"]).rstrip(";") + ";"
    columns = d1_columns(conn, schema, table)
    body = ",\n".join(f'  "{c["name"]}" {c["type"] or "TEXT"}' for c in columns)
    return f'CREATE TABLE "{table}" (\n{body}\n);'


# --------------------------------------------------------------------------- #
# libSQL / Turso
# --------------------------------------------------------------------------- #


def _libsql_url(conn: dict[str, Any]) -> str:
    host = str(conn.get("host") or "").strip().rstrip("/")
    if not host:
        raise HTTPException(400, "libSQL needs the database URL (host)")
    if host.startswith("libsql://"):
        host = "https://" + host[len("libsql://"):]
    elif not host.startswith(("http://", "https://")):
        host = "https://" + host
    return host + "/v2/pipeline"


def _libsql_run(conn: dict[str, Any], sql: str, args: list[Any] | None = None) -> dict[str, Any]:
    body = {
        "requests": [
            {"type": "execute", "stmt": {"sql": sql, "args": [
                _libsql_arg(value) for value in (args or [])
            ]}},
            {"type": "close"},
        ]
    }
    _, payload = _libsql_request("POST", _libsql_url(conn), headers={"Authorization": _bearer(conn)}, body=body)
    results = payload.get("results") or []
    if not results:
        return {"columns": [], "rows": []}
    first = results[0]
    if first.get("type") == "error":
        raise HTTPException(400, f"libSQL: {first.get('error', {}).get('message', 'query failed')}")
    response = (first.get("response") or {}).get("result") or {}
    columns = [str(col.get("name")) for col in (response.get("cols") or [])]
    rows = [[_libsql_value(cell) for cell in row] for row in (response.get("rows") or [])]
    return {"columns": columns, "rows": rows}


def _libsql_arg(value: Any) -> dict[str, Any]:
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    return {"type": "text", "value": str(value)}


def _libsql_value(cell: Any) -> Any:
    """libSQL returns every value as {type, value}; the grid wants the value."""
    if isinstance(cell, dict):
        kind = cell.get("type")
        if kind == "null":
            return None
        if kind in ("integer", "float"):
            try:
                return int(cell["value"]) if kind == "integer" else float(cell["value"])
            except (TypeError, ValueError):
                return cell.get("value")
        if kind == "blob":
            return cell.get("base64") or cell.get("value")
        return cell.get("value")
    return cell


def libsql_test(conn: dict[str, Any]) -> dict[str, Any]:
    result = _libsql_run(conn, "select sqlite_version() as version")
    rows = result["rows"]
    tables = _libsql_run(conn, "select count(*) as n from sqlite_master where type = 'table'")
    version = rows[0][0] if rows and rows[0] else "?"
    count = tables["rows"][0][0] if tables["rows"] else 0
    return {
        "version": f"libSQL · SQLite {version} · {int(count or 0)} table(s)",
        "database": str(conn.get("host") or ""),
        "user": "token",
    }


def libsql_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    result = _libsql_run(
        conn,
        "select name, type from sqlite_master where type in ('table','view') "
        "and name not like 'sqlite_%' order by name",
    )
    out = []
    for name, table_type in result["rows"]:
        out.append({
            "schema": "main",
            "name": str(name),
            "kind": "view" if str(table_type) == "view" else "table",
            "est_rows": 0,
        })
    return out


def libsql_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    result = _libsql_run(conn, f'pragma table_info("{table}")')
    names = result["columns"]
    out = []
    for row in result["rows"]:
        record = dict(zip(names, row))
        out.append({
            "name": str(record.get("name")),
            "type": str(record.get("type") or "").upper(),
            "nullable": not bool(record.get("notnull")),
            "default": "" if record.get("dflt_value") is None else str(record.get("dflt_value")),
            "primary": bool(record.get("pk")),
        })
    return out


def libsql_rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
                where: str = "", columns_meta=None) -> dict[str, Any]:
    started = time.monotonic()
    sql = f'select * from "{table}"'
    if where:
        sql += f" where {where}"
    if order_by:
        sql += f' order by "{order_by}" {"desc" if str(direction).upper() == "DESC" else "asc"}'
    sql += f" limit {int(limit) + 1} offset {int(offset)}"
    result = _libsql_run(conn, sql)
    names = result["columns"] or [column["name"] for column in (columns_meta or [])]
    meta = {column["name"]: column.get("type", "") for column in (columns_meta or [])}
    data = result["rows"]
    return {
        "columns": [{"name": name, "type": meta.get(name) or _type_of(
            [row[names.index(name)] for row in data[:20]] if name in names else []
        )} for name in names],
        "rows": data[: int(limit)],
        "truncated": len(data) > int(limit),
        "offset": int(offset),
        "limit": int(limit),
        "duration_ms": _ms(started),
    }


def libsql_query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    _guard(conn, sql)
    started = time.monotonic()
    result = _libsql_run(conn, sql)
    names = result["columns"]
    data = result["rows"]
    is_read = sql.lstrip().split(None, 1)[0].upper() in ("SELECT", "WITH", "PRAGMA", "EXPLAIN")
    return {
        "columns": [{"name": name, "type": _type_of([row[index] for row in data[:20]])}
                    for index, name in enumerate(names)],
        "rows": data[: int(limit)],
        "truncated": len(data) > int(limit),
        "command": "SELECT" if is_read else sql.split(None, 1)[0].upper(),
        "readonly": readonly,
        "duration_ms": _ms(started),
    }


def libsql_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    result = _libsql_run(conn, "select sql from sqlite_master where name = ?", [table])
    for row in result["rows"]:
        if row and row[0]:
            return str(row[0]).rstrip(";") + ";"
    columns = libsql_columns(conn, schema, table)
    body = ",\n".join(f'  "{c["name"]}" {c["type"] or "TEXT"}' for c in columns)
    return f'CREATE TABLE "{table}" (\n{body}\n);'


# --------------------------------------------------------------------------- #
# registry
# --------------------------------------------------------------------------- #

ENGINES = {
    "elasticsearch": {
        "name": engine_name("elasticsearch"),
        "test": es_test, "tree": es_tree, "columns": es_columns, "rows": es_rows,
        "query": es_query, "ddl": es_ddl,
    },
    "influxdb3": {
        "name": engine_name("influxdb3"),
        "test": influx_test, "tree": influx_tree, "columns": influx_columns,
        "rows": influx_rows, "query": influx_query, "ddl": influx_ddl,
    },
    "d1": {
        "name": engine_name("d1"),
        "test": d1_test, "tree": d1_tree, "columns": d1_columns, "rows": d1_rows,
        "query": d1_query, "ddl": d1_ddl,
    },
    "libsql": {
        "name": engine_name("libsql"),
        "test": libsql_test, "tree": libsql_tree, "columns": libsql_columns,
        "rows": libsql_rows, "query": libsql_query, "ddl": libsql_ddl,
    },
}


def handles(kind: str) -> bool:
    return kind in ENGINES
