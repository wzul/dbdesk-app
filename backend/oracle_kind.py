"""Oracle, in thin mode: no Oracle client library, no `ORACLE_HOME`, no `ldconfig`.

python-oracledb's thin driver speaks the Oracle wire protocol from pure Python (with a small
compiled core), so a user can open a database without installing Instant Client — the step
that makes most Oracle tooling painful on a laptop. The catalog is `ALL_*` views scoped to
the schemas the login can see, and a table is addressed as OWNER.TABLE in double quotes.

Read-only: a transaction is opened read-only per session (`SET TRANSACTION READ ONLY`) so a
statement that writes fails at the server as well as at the statement guard.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import HTTPException

try:
    import oracledb
except ModuleNotFoundError:  # pragma: no cover
    oracledb = None

# Oracle's own schemas: listing them buries the user's tables under the data dictionary.
SYSTEM_OWNERS = {
    "SYS", "SYSTEM", "OUTLN", "XDB", "MDSYS", "CTXSYS", "ORDSYS", "ORDDATA", "DBSNMP",
    "APPQOSSYS", "GSMADMIN_INTERNAL", "AUDSYS", "LBACSYS", "DVF", "DVSYS", "OJVMSYS",
    "WMSYS", "OLAPSYS", "RDSADMIN", "REMOTE_SCHEDULER_AGENT", "SYSBACKUP", "SYSDG",
    "SYSKM", "SYSRAC", "SYS$UMF", "GSMCATUSER", "GSMROOTUSER", "GSMUSER", "XS$NULL",
    "DIP", "ANONYMOUS", "PUBLIC",
}


def _db():
    if oracledb is None:
        raise HTTPException(
            400, "oracledb is not installed — `pip install oracledb` (or use a packaged build)"
        )
    return oracledb


def _connect(conn: dict[str, Any], *, readonly: bool = True):
    driver = _db()
    host = str(conn.get("host") or "127.0.0.1")
    port = int(conn.get("port") or 1521)
    service = str(conn.get("dbname") or "").strip()
    if not service:
        raise HTTPException(400, "Oracle needs a service name (or SID) in the database field")
    # `host:port/service` also accepts a full descriptor if the user pasted one.
    dsn = service if "/" in service and "(" in service else f"{host}:{port}/{service}"
    try:
        db = driver.connect(
            user=str(conn.get("user") or ""),
            password=str(conn.get("password") or ""),
            dsn=dsn,
            tcp_connect_timeout=15,
        )
    except Exception as exc:
        raise HTTPException(400, f"Oracle: {_clean(exc)}") from exc
    if readonly:
        try:
            # A read-only transaction makes a write fail in the server, not just in the guard.
            db.execute("set transaction read only")
        except Exception:
            pass  # some proxies/older versions refuse; the statement guard still applies
    return db


def _clean(exc: Exception) -> str:
    message = str(exc)
    text = getattr(exc, "args", [None])[0]
    if isinstance(text, str) and text.strip():
        return text.strip()[:300]
    return message.strip()[:300] or "query failed"


def _value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return "0x" + raw.hex()
    if hasattr(value, "read"):  # CLOB/BLOB
        try:
            data = value.read()
            return data if isinstance(data, str) else "0x" + bytes(data).hex()
        except Exception:
            return str(value)
    if hasattr(value, "isoformat"):
        return value.isoformat(sep=" ")
    return str(value)


def _ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def test(conn: dict[str, Any]) -> dict[str, Any]:
    db = _connect(conn, readonly=True)
    try:
        version = db.version
        schema = db.username or ""
        cursor = db.cursor()
        cursor.execute("select count(*) from all_tables where owner = sys_context('userenv','current_schema')")
        tables = int(cursor.fetchone()[0])
    except Exception as exc:
        raise HTTPException(400, f"Oracle: {_clean(exc)}") from exc
    finally:
        db.close()
    return {
        "version": f"Oracle {version} · {tables} table(s)",
        "database": str(conn.get("dbname") or ""),
        "user": schema,
    }


def tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(
            "select owner, table_name from all_tables where owner not in "
            "(select username from all_users where oracle_maintained = 'Y') "
            "order by owner, table_name"
        )
        nodes = [
            {"schema": str(owner), "name": str(name), "kind": "table", "est_rows": 0}
            for owner, name in cursor.fetchall()
            if str(owner).upper() not in SYSTEM_OWNERS
        ]
        cursor.execute(
            "select owner, view_name from all_views where owner not in "
            "(select username from all_users where oracle_maintained = 'Y') "
            "order by owner, view_name"
        )
        nodes += [
            {"schema": str(owner), "name": str(name), "kind": "view", "est_rows": 0}
            for owner, name in cursor.fetchall()
            if str(owner).upper() not in SYSTEM_OWNERS
        ]
        return nodes
    except Exception as exc:
        # `oracle_maintained` only exists on 12c+; fall back to the static list.
        try:
            cursor = db.cursor()
            cursor.execute(
                "select owner, table_name from all_tables order by owner, table_name"
            )
            return [
                {"schema": str(owner), "name": str(name), "kind": "table", "est_rows": 0}
                for owner, name in cursor.fetchall()
                if str(owner).upper() not in SYSTEM_OWNERS
            ]
        except Exception:
            raise HTTPException(400, f"Oracle: {_clean(exc)}") from exc
    finally:
        db.close()


def columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(
            "select column_name, data_type, nullable, data_default, data_precision, data_scale, "
            "char_length from all_tab_columns where owner = :1 and table_name = :2 "
            "order by column_id",
            [schema.upper(), table.upper()],
        )
        rows = cursor.fetchall()
    except Exception as exc:
        raise HTTPException(400, f"Oracle: {_clean(exc)}") from exc
    finally:
        db.close()
    out = []
    for name, data_type, nullable, default, precision, scale, length in rows:
        kind = str(data_type)
        if precision and scale:
            kind = f"{kind}({int(precision)},{int(scale)})"
        elif precision:
            kind = f"{kind}({int(precision)})"
        elif length and "CHAR" in kind.upper():
            kind = f"{kind}({int(length)})"
        out.append({
            "name": str(name),
            "type": kind,
            "nullable": str(nullable).upper() == "Y",
            "default": "" if default is None else str(default).strip(),
            "primary": False,
        })
    return out


def rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
         where: str = "", columns_meta=None) -> dict[str, Any]:
    started = time.monotonic()
    target = f"{_ident(schema)}.{_ident(table)}"
    sql = f"select * from {target}"
    if where:
        sql += f" where {where}"
    if order_by:
        sql += f" order by {_ident(order_by)} {'DESC' if str(direction).upper() == 'DESC' else 'ASC'}"
    # Oracle 12c+ has OFFSET/FETCH; ROWNUM was the old way and is worse for large offsets.
    sql += f" offset {int(offset)} rows fetch next {int(limit) + 1} rows only"
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(sql)
        names = [str(d[0]) for d in (cursor.description or [])]
        data = [[_value(v) for v in row] for row in cursor.fetchmany(int(limit) + 1)]
    except Exception as exc:
        raise HTTPException(400, f"Oracle: {_clean(exc)}") from exc
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
    text = ""
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(
            "select dbms_metadata.get_ddl('TABLE', :1, :2) from dual",
            [table.upper(), schema.upper()],
        )
        row = cursor.fetchone()
        # GET_DDL returns a CLOB and a CLOB is read lazily: fetch it while the connection is
        # still open, or the read fails with DPY-1001 once the session is closed.
        if row and row[0] is not None:
            materialised = _value(row[0])
            text = materialised if isinstance(materialised, str) else str(materialised)
    except Exception:
        text = ""
    finally:
        db.close()
    if text.strip():
        return text.strip().rstrip(";") + ";"
    cols = columns(conn, schema, table)
    body = ",\n".join(
        f"  {_ident(c['name'])} {c['type']}" + ("" if c.get("nullable", True) else " NOT NULL")
        for c in cols
    )
    return f"CREATE TABLE {_ident(schema)}.{_ident(table)} (\n{body}\n);"


def indexes(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    db = _connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(
            "select i.index_name, i.uniqueness, c.column_name from all_indexes i "
            "join all_ind_columns c on c.index_owner = i.owner and c.index_name = i.index_name "
            "where i.table_owner = :1 and i.table_name = :2 order by i.index_name, c.column_position",
            [schema.upper(), table.upper()],
        )
        rows_ = cursor.fetchall()
    except Exception:
        return []
    finally:
        db.close()
    grouped: dict[str, dict[str, Any]] = {}
    for name, uniqueness, column in rows_:
        entry = grouped.setdefault(str(name), {"name": str(name),
                                               "unique": str(uniqueness).upper() == "UNIQUE",
                                               "columns": []})
        entry["columns"].append(str(column))
    return list(grouped.values())


def query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    started = time.monotonic()
    db = _connect(conn, readonly=readonly)
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
        raise HTTPException(400, f"Oracle: {_clean(exc)}") from exc
    finally:
        db.close()
    is_read = sql.lstrip().split(None, 1)[0].upper() in ("SELECT", "WITH", "EXPLAIN")
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
    db = _connect(conn, readonly=False)
    try:
        cursor = db.cursor()
        for statement in statements:
            cursor.execute(statement)
        db.commit()
    except Exception as exc:
        raise HTTPException(400, f"Oracle: {_clean(exc)}") from exc
    finally:
        db.close()
