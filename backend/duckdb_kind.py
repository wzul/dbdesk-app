"""DuckDB: an embedded analytical engine, opened like SQLite but read differently.

DuckDB speaks SQL with PostgreSQL's habits (double-quoted identifiers, standard string
literals) instead of SQLite's, and it keeps its own catalog functions — `duckdb_tables()`,
`duckdb_columns()`, `duckdb_indexes()` — alongside `information_schema`. This module keeps
that knowledge out of the 8k-line API file, so the API only has to know how to dispatch.

Nothing here writes unless the connection says so: a file database has no server-side
grants to fall back on, so read-only has to be enforced at open time (`read_only=True`)
and again before any write statement runs.
"""

from __future__ import annotations

import os
import time
from typing import Any

from fastapi import HTTPException

try:  # the packaged app ships the wheel; a source checkout may not have it yet
    import duckdb
except ModuleNotFoundError:  # pragma: no cover - exercised by the "driver missing" path
    duckdb = None


def _db() -> Any:
    if duckdb is None:
        raise HTTPException(
            400,
            "duckdb is not installed — `pip install duckdb` (or use a packaged build)",
        )
    return duckdb


def _file(conn: dict[str, Any]) -> str:
    path = os.path.expanduser(str(conn.get("dbname") or "").strip())
    if not path:
        raise HTTPException(400, "DuckDB needs a path to a .duckdb file")
    return path


def _open(conn: dict[str, Any], *, readonly: bool = True):
    database = _db()
    path = _file(conn)
    if not os.path.exists(path):
        raise HTTPException(404, f"DuckDB file not found: {path}")
    if not os.path.isfile(path):
        raise HTTPException(400, f"DuckDB path is not a file: {path}")
    try:
        # DuckDB takes the read-only decision at connect time and refuses a second writer
        # on the same file, so this flag is the actual guard, not a hint.
        return database.connect(path, read_only=readonly)
    except Exception as exc:  # duckdb raises its own Error subclass
        if readonly:
            raise HTTPException(
                400,
                f"DuckDB could not open the file read-only: {exc}. If another process is "
                "writing to it, close that first.",
            ) from exc
        raise HTTPException(400, f"DuckDB: {exc}") from exc


def _ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def _cell(value: Any) -> Any:
    """JSON-friendly cell: DuckDB returns dates, decimals, UUIDs and blobs."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return "0x" + raw.hex()
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _typeof(values: list[Any]) -> str:
    for value in values:
        if value is None:
            continue
        if isinstance(value, bool):
            return "BOOLEAN"
        if isinstance(value, int):
            return "BIGINT"
        if isinstance(value, float):
            return "DOUBLE"
        if isinstance(value, (bytes, bytearray, memoryview)):
            return "BLOB"
        if hasattr(value, "isoformat"):
            return "TIMESTAMP"
        return "VARCHAR"
    return ""


def test(conn: dict[str, Any]) -> dict[str, Any]:
    db = _open(conn, readonly=True)
    try:
        version = db.execute("select version()").fetchone()[0]
        tables = db.execute(
            "select count(*) from information_schema.tables where table_type = 'BASE TABLE'"
        ).fetchone()[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"DuckDB: {exc}") from exc
    finally:
        db.close()
    return {
        "version": f"DuckDB {str(version).split(' ')[0]} · {int(tables)} table(s)",
        "database": _file(conn),
    }


def tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    db = _open(conn, readonly=True)
    try:
        rows = db.execute(
            "select table_schema, table_name, table_type from information_schema.tables "
            "order by table_schema, table_name"
        ).fetchall()
    except Exception as exc:
        raise HTTPException(400, f"DuckDB: {exc}") from exc
    finally:
        db.close()
    out = []
    for schema, name, table_type in rows:
        # DuckDB keeps its own bookkeeping in information_schema and pg_catalog; listing
        # those would bury the user's tables under system noise.
        if str(schema) in ("information_schema", "pg_catalog", "system"):
            continue
        out.append({
            "schema": str(schema),
            "name": str(name),
            "kind": "view" if "VIEW" in str(table_type).upper() else "table",
            "est_rows": 0,
        })
    return out


def columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    db = _open(conn, readonly=True)
    try:
        rows = db.execute(
            "select column_name, data_type, is_nullable, column_default "
            "from information_schema.columns "
            "where table_schema = ? and table_name = ? order by ordinal_position",
            [schema, table],
        ).fetchall()
    except Exception as exc:
        raise HTTPException(400, f"DuckDB: {exc}") from exc
    finally:
        db.close()
    return [
        {
            "name": str(name),
            "type": str(data_type),
            "nullable": str(nullable).upper() == "YES",
            "default": "" if default is None else str(default),
            "primary": False,
        }
        for name, data_type, nullable, default in rows
    ]


def rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
         where: str = "", columns_meta: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    meta = {column["name"]: column.get("type", "") for column in (columns_meta or [])}
    target = f"{_ident(schema)}.{_ident(table)}" if schema else _ident(table)
    sql = f"select * from {target}"
    if where:
        sql += f" where {where}"
    if order_by:
        sql += f" order by {_ident(order_by)} {'DESC' if str(direction).upper() == 'DESC' else 'ASC'}"
    sql += f" limit {int(limit) + 1} offset {int(offset)}"
    started = time.monotonic()
    db = _open(conn, readonly=True)
    try:
        cursor = db.execute(sql)
        names = [column[0] for column in cursor.description or []]
        data = [[_cell(value) for value in row] for row in cursor.fetchmany(int(limit) + 1)]
    except Exception as exc:
        raise HTTPException(400, f"DuckDB: {exc}") from exc
    finally:
        db.close()
    return {
        "columns": [{"name": name, "type": meta.get(name, "")} for name in names],
        "rows": data[: int(limit)],
        "truncated": len(data) > int(limit),
        "offset": int(offset),
        "limit": int(limit),
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    db = _open(conn, readonly=True)
    try:
        row = db.execute(
            "select sql from duckdb_tables() where schema_name = ? and table_name = ?",
            [schema, table],
        ).fetchone()
        if row is None:
            row = db.execute(
                "select sql from duckdb_views() where schema_name = ? and view_name = ?",
                [schema, table],
            ).fetchone()
    except Exception as exc:
        raise HTTPException(400, f"DuckDB: {exc}") from exc
    finally:
        db.close()
    if row and row[0]:
        return str(row[0]).rstrip(";") + ";"
    # Older builds do not expose the catalog function; assemble the statement instead of
    # returning an empty panel.
    cols = columns(conn, schema, table)
    body = ",\n".join(
        f"  {_ident(column['name'])} {column['type']}"
        + ("" if column.get("nullable", True) else " NOT NULL")
        for column in cols
    )
    return f"CREATE TABLE {_ident(schema)}.{_ident(table)} (\n{body}\n);"


def indexes(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    db = _open(conn, readonly=True)
    try:
        rows = db.execute(
            "select index_name, is_unique, expressions from duckdb_indexes() "
            "where schema_name = ? and table_name = ?",
            [schema, table],
        ).fetchall()
    except Exception:
        # duckdb_indexes() is version-dependent; an empty list is honest, an error is not.
        return []
    finally:
        db.close()
    return [
        {
            "name": str(name),
            "unique": bool(unique),
            "columns": [str(expr) for expr in (expressions or [])],
        }
        for name, unique, expressions in rows
    ]


def query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    started = time.monotonic()
    is_read = bool(conn.get("_read_sql_match"))
    db = _open(conn, readonly=readonly)
    try:
        cursor = db.execute(sql)
        if cursor.description:
            names = [column[0] for column in cursor.description]
            data = [[_cell(value) for value in row] for row in cursor.fetchmany(int(limit) + 1)]
        else:
            names, data = [], []
        if not is_read:
            db.commit()
    except Exception as exc:
        raise HTTPException(400, f"DuckDB: {exc}") from exc
    finally:
        db.close()
    return {
        "columns": [
            {"name": name, "type": _typeof([row[index] for row in data[:20]])}
            for index, name in enumerate(names)
        ],
        "rows": data[: int(limit)],
        "truncated": len(data) > int(limit),
        "command": "SELECT" if is_read else sql.split(None, 1)[0].upper(),
        "readonly": readonly,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def run(conn: dict[str, Any], statements: list[str]) -> None:
    if conn.get("readonly", True):
        raise HTTPException(403, "this connection is read-only; turn off read-only in its settings")
    db = _open(conn, readonly=False)
    try:
        for statement in statements:
            db.execute(statement)
        db.commit()
    except Exception as exc:
        raise HTTPException(400, f"DuckDB: {exc}") from exc
    finally:
        db.close()
