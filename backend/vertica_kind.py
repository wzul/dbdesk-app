"""Vertica: a columnar warehouse that speaks its own protocol, not PostgreSQL's.

`vertica_python` is pure Python, so there is nothing to compile and nothing to install on the
host. Vertica also has no CREATE INDEX — the projection *is* the physical design — so the
"indexes" panel lists projections instead of pretending otherwise, and DDL comes from the
built-in `EXPORT_OBJECTS()`, which is the statement Vertica itself considers canonical.

Every value comes back through the same JSON-friendly funnel as the other engines: a
`timestamptz` is a datetime, a `numeric` is a Decimal, and neither survives `json.dumps`.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import HTTPException

try:
    import vertica_python
except ModuleNotFoundError:  # pragma: no cover
    vertica_python = None

SYSTEM_SCHEMAS = ("v_catalog", "v_monitor", "v_internal", "v_func", "v_txtindex",
                  "v_system", "information_schema", "pg_catalog")


def _db():
    if vertica_python is None:
        raise HTTPException(
            400,
            "vertica_python is not installed — `pip install vertica-python` (or use a packaged build)",
        )
    return vertica_python


def _connect(conn: dict[str, Any]):
    driver = _db()
    try:
        # vertica_python.connect takes keyword arguments, not a dict.
        return driver.connect(
            host=str(conn.get("host") or "127.0.0.1"),
            port=int(conn.get("port") or 5433),
            user=str(conn.get("user") or "dbadmin"),
            password=str(conn.get("password") or ""),
            database=str(conn.get("dbname") or ""),
            connection_timeout=15,
            read_timeout=600,
        )
    except Exception as exc:
        raise HTTPException(400, f"Vertica: {_clean(exc)}") from exc


def _clean(exc: Exception) -> str:
    text = getattr(exc, "args", [None])
    if text and isinstance(text[0], str) and text[0].strip():
        return text[0].strip()[:300]
    return str(exc).strip()[:300] or "query failed"


def _ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def _value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return "0x" + raw.hex()
    if hasattr(value, "isoformat"):
        return value.isoformat(sep=" ")
    return str(value)


def test(conn: dict[str, Any]) -> dict[str, Any]:
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute("select version()")
        version = str(cursor.fetchone()[0]).split(" ")[0]
        cursor.execute(
            "select count(*) from v_catalog.tables where table_schema not in "
            "('v_catalog','v_monitor','v_internal','v_func')"
        )
        tables = int(cursor.fetchone()[0])
    except Exception as exc:
        raise HTTPException(400, f"Vertica: {_clean(exc)}") from exc
    finally:
        db.close()
    return {
        "version": f"Vertica {version} · {tables} table(s)",
        "database": str(conn.get("dbname") or ""),
        "user": str(conn.get("user") or ""),
    }


def tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(
            "select table_schema, table_name from v_catalog.tables order by table_schema, table_name"
        )
        nodes = [
            {"schema": str(schema), "name": str(name), "kind": "table", "est_rows": 0}
            for schema, name in cursor.fetchall()
            if str(schema) not in SYSTEM_SCHEMAS
        ]
        cursor.execute(
            "select table_schema, table_name from v_catalog.views order by table_schema, table_name"
        )
        nodes += [
            {"schema": str(schema), "name": str(name), "kind": "view", "est_rows": 0}
            for schema, name in cursor.fetchall()
            if str(schema) not in SYSTEM_SCHEMAS
        ]
        return nodes
    except Exception as exc:
        raise HTTPException(400, f"Vertica: {_clean(exc)}") from exc
    finally:
        db.close()


def columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(
            "select column_name, data_type, is_nullable, column_default "
            "from v_catalog.columns where table_schema = ? and table_name = ? "
            "order by ordinal_position",
            [schema, table],
        )
        rows = cursor.fetchall()
    except Exception as exc:
        raise HTTPException(400, f"Vertica: {_clean(exc)}") from exc
    finally:
        db.close()
    return [
        {
            "name": str(name),
            "type": str(data_type),
            "nullable": str(nullable).upper() in ("TRUE", "YES", "T"),
            "default": "" if default is None else str(default),
            "primary": False,
        }
        for name, data_type, nullable, default in rows
    ]


def rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
         where: str = "", columns_meta=None) -> dict[str, Any]:
    started = time.monotonic()
    sql = f"select * from {_ident(schema)}.{_ident(table)}"
    if where:
        sql += f" where {where}"
    if order_by:
        sql += f" order by {_ident(order_by)} {'DESC' if str(direction).upper() == 'DESC' else 'ASC'}"
    sql += f" limit {int(limit) + 1} offset {int(offset)}"
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(sql)
        names = [str(d[0]) for d in (cursor.description or [])]
        data = [[_value(v) for v in row] for row in cursor.fetchmany(int(limit) + 1)]
    except Exception as exc:
        raise HTTPException(400, f"Vertica: {_clean(exc)}") from exc
    finally:
        db.close()
    meta = {column["name"]: column.get("type", "") for column in (columns_meta or [])}
    return {
        "columns": [{"name": name, "type": meta.get(name, "")} for name in names],
        "rows": data[: int(limit)],
        "truncated": len(data) > int(limit),
        "offset": int(offset),
        "limit": int(limit),
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute("select export_objects('', ?)", [f"{schema}.{table}"])
        row = cursor.fetchone()
        if row and row[0]:
            return str(row[0]).strip()
    except Exception:
        pass
    finally:
        db.close()
    cols = columns(conn, schema, table)
    body = ",\n".join(
        f"  {_ident(c['name'])} {c['type']}" + ("" if c.get("nullable", True) else " NOT NULL")
        for c in cols
    )
    return f"CREATE TABLE {_ident(schema)}.{_ident(table)} (\n{body}\n);"


def indexes(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    """Vertica has projections, not indexes; report the projections that cover the table."""
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(
            "select projection_name, is_segmented from v_catalog.projections "
            "where projection_schema = ? and anchor_table_name = ? order by projection_name",
            [schema, table],
        )
        rows_ = cursor.fetchall()
    except Exception:
        return []
    finally:
        db.close()
    return [
        {"name": str(name), "unique": False, "columns": ["(projection)",
                                                         "segmented" if str(seg).upper().startswith("T") else "unsegmented"]}
        for name, seg in rows_
    ]


def query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    started = time.monotonic()
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(sql)
        if cursor.description:
            names = [str(d[0]) for d in cursor.description]
            data = [[_value(v) for v in row] for row in cursor.fetchmany(int(limit) + 1)]
        else:
            names, data = [], []
        if not readonly:
            db.commit()
    except Exception as exc:
        raise HTTPException(400, f"Vertica: {_clean(exc)}") from exc
    finally:
        db.close()
    is_read = sql.lstrip().split(None, 1)[0].upper() in ("SELECT", "WITH", "EXPLAIN", "PROFILE")
    return {
        "columns": [{"name": name, "type": ""} for name in names],
        "rows": data[: int(limit)],
        "truncated": len(data) > int(limit),
        "command": "SELECT" if is_read else sql.split(None, 1)[0].upper(),
        "readonly": readonly,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def run(conn: dict[str, Any], statements: list[str]) -> None:
    if conn.get("readonly", True):
        raise HTTPException(403, "this connection is read-only; turn off read-only in its settings")
    db = _connect(conn)
    try:
        cursor = db.cursor()
        for statement in statements:
            cursor.execute(statement)
        db.commit()
    except Exception as exc:
        raise HTTPException(400, f"Vertica: {_clean(exc)}") from exc
    finally:
        db.close()
