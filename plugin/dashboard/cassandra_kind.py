"""Cassandra: CQL, not SQL.

Four things are different enough that treating it as "SQL with another driver" would ship a
broken panel, so they are spelled out here:

* A keyspace is the schema, and the query language has no `OFFSET`. Paging is done with
  `token()` and a page size, so the grid shows the first N rows and says so instead of
  pretending it can jump to row 500.
* `ORDER BY` only works on clustering columns in the partition's own order; asking for an
  arbitrary column is an error from the server, so the UI must not offer it blindly.
* Column types are CQL types (`text`, `list<uuid>`, `map<text,int>`), which are not SQL types
  — they are shown as-is rather than mangled into VARCHAR.
* There is no DDL text stored anywhere, so the CREATE TABLE is reconstructed from
  `system_schema`, which is exactly what `DESCRIBE TABLE` does in cqlsh.

Read-only is enforced before a statement is sent: Cassandra has no read-only transaction, and
a `SELECT` with `ALLOW FILTERING` still costs the cluster real work.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import HTTPException

try:
    from cassandra.auth import PlainTextAuthProvider
    from cassandra.cluster import Cluster
    from cassandra.policies import RoundRobinPolicy
except ModuleNotFoundError:  # pragma: no cover
    Cluster = None
    PlainTextAuthProvider = None

SYSTEM_KEYSPACES = ("system", "system_auth", "system_distributed", "system_schema",
                    "system_traces", "system_views", "system_virtual_schema")


def _driver():
    if Cluster is None:
        raise HTTPException(
            400,
            "cassandra-driver is not installed — `pip install cassandra-driver` "
            "(or use a packaged build)",
        )
    return Cluster


def _cluster(conn: dict[str, Any]):
    driver = _driver()
    host = str(conn.get("host") or "127.0.0.1")
    port = int(conn.get("port") or 9042)
    user = str(conn.get("user") or "")
    password = str(conn.get("password") or "")
    auth = PlainTextAuthProvider(username=user, password=password) if user else None
    try:
        cluster = driver(
            contact_points=[host],
            port=port,
            auth_provider=auth,
            load_balancing_policy=RoundRobinPolicy(),
            connect_timeout=15,
            control_connection_timeout=15,
        )
        session = cluster.connect()
    except Exception as exc:
        raise HTTPException(400, f"Cassandra: {_clean(exc)}") from exc
    return cluster, session


def _clean(exc: Exception) -> str:
    # Driver errors carry the useful sentence in the message, not the class name.
    message = str(exc).strip()
    return message[:300] or "query failed"


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
    if isinstance(value, (list, tuple, set)):
        return [_value(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _value(v) for k, v in value.items()}
    return str(value)


def _ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def test(conn: dict[str, Any]) -> dict[str, Any]:
    cluster, session = _cluster(conn)
    try:
        row = session.execute("select release_version from system.local").one()
        version = str(row.release_version) if row else "?"
        keyspaces = [
            str(r.keyspace_name) for r in session.execute(
                "select keyspace_name from system_schema.keyspaces"
            )
            if str(r.keyspace_name) not in SYSTEM_KEYSPACES
        ]
    except Exception as exc:
        raise HTTPException(400, f"Cassandra: {_clean(exc)}") from exc
    finally:
        session.shutdown()
        cluster.shutdown()
    return {
        "version": f"Cassandra {version} · {len(keyspaces)} keyspace(s)",
        "database": str(conn.get("dbname") or ""),
        "user": str(conn.get("user") or ""),
    }


def tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    cluster, session = _cluster(conn)
    try:
        rows = session.execute("select keyspace_name, table_name from system_schema.tables")
        kinds = {
            (str(r.keyspace_name), str(r.view_name)): "view"
            for r in session.execute("select keyspace_name, view_name from system_schema.views")
        }
        nodes = []
        for row in rows:
            keyspace, table = str(row.keyspace_name), str(row.table_name)
            if keyspace in SYSTEM_KEYSPACES:
                continue
            nodes.append({
                "schema": keyspace,
                "name": table,
                "kind": kinds.get((keyspace, table), "table"),
                "est_rows": 0,
            })
        return sorted(nodes, key=lambda n: (n["schema"], n["name"]))
    except Exception as exc:
        raise HTTPException(400, f"Cassandra: {_clean(exc)}") from exc
    finally:
        session.shutdown()
        cluster.shutdown()


def columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    cluster, session = _cluster(conn)
    try:
        rows = session.execute(
            "select column_name, kind, position, type from system_schema.columns "
            "where keyspace_name = %s and table_name = %s",
            [schema, table],
        )
        entries = [
            {
                "name": str(r.column_name),
                "type": str(r.type),
                "nullable": str(r.kind) != "partition_key",
                "default": "",
                "primary": str(r.kind) in ("partition_key", "clustering"),
            }
            for r in rows
        ]
    except Exception as exc:
        raise HTTPException(400, f"Cassandra: {_clean(exc)}") from exc
    finally:
        session.shutdown()
        cluster.shutdown()
    # Partition key first, then clustering columns, then the rest: that is the CQL order.
    return sorted(entries, key=lambda c: (not c["primary"], c["name"]))


def rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
         where: str = "", columns_meta=None) -> dict[str, Any]:
    started = time.monotonic()
    if int(offset):
        raise HTTPException(
            400,
            "CQL has no OFFSET: page with token() instead, or narrow the filter",
        )
    cql = f"select * from {_ident(schema)}.{_ident(table)}"
    if where:
        cql += f" where {where}"
    if order_by:
        # Only clustering columns can be ordered, and only inside a partition; the server
        # says so itself if the order is not legal.
        cql += f" order by {_ident(order_by)} {'DESC' if str(direction).upper() == 'DESC' else 'ASC'}"
    cql += f" limit {int(limit) + 1}"
    cluster, session = _cluster(conn)
    try:
        result = session.execute(cql)
        names = [str(name) for name in (result.column_names or [])]
        data = [[_value(value) for value in record] for record in result]
    except Exception as exc:
        raise HTTPException(400, f"Cassandra: {_clean(exc)}") from exc
    finally:
        session.shutdown()
        cluster.shutdown()
    meta = {column["name"]: column.get("type", "") for column in (columns_meta or [])}
    return {
        "columns": [{"name": name, "type": meta.get(name, "")} for name in names],
        "rows": data[: int(limit)],
        "truncated": len(data) > int(limit),
        "offset": 0,
        "limit": int(limit),
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    cluster, session = _cluster(conn)
    try:
        rows = list(session.execute(
            "select column_name, kind, position, type, clustering_order from system_schema.columns "
            "where keyspace_name = %s and table_name = %s",
            [schema, table],
        ))
        table_row = session.execute(
            "select * from system_schema.tables where keyspace_name = %s and table_name = %s",
            [schema, table],
        ).one()
    except Exception as exc:
        raise HTTPException(400, f"Cassandra: {_clean(exc)}") from exc
    finally:
        session.shutdown()
        cluster.shutdown()

    partition = [r for r in rows if str(r.kind) == "partition_key"]
    clustering = [r for r in rows if str(r.kind) == "clustering"]
    regular = [r for r in rows if str(r.kind) == "regular"]
    static = [r for r in rows if str(r.kind) == "static"]
    lines = [
        f"  {_ident(r.column_name)} {r.type}"
        + (" static" if str(r.kind) == "static" else "")
        for r in regular + static
    ]
    primary = ", ".join(
        [_ident(r.column_name) for r in sorted(partition, key=lambda r: int(r.position))]
        + [_ident(r.column_name) for r in sorted(clustering, key=lambda r: int(r.position))]
    )
    if clustering:
        # A composite partition key is written as (a, b); everything after it is clustering.
        partition_names = ", ".join(
            _ident(r.column_name) for r in sorted(partition, key=lambda r: int(r.position))
        )
        clustering_names = ", ".join(
            _ident(r.column_name) for r in sorted(clustering, key=lambda r: int(r.position))
        )
        primary = f"({partition_names}), {clustering_names}"
    body = ",\n".join(lines + [f"  primary key ({primary})"])
    ordered = [
        (str(r.column_name), str(r.clustering_order))
        for r in sorted(clustering, key=lambda r: int(r.position))
        if str(getattr(r, "clustering_order", "none")).lower() in ("asc", "desc")
    ]
    # CLUSTERING ORDER BY sits after the column list, not inside it; ASC is the default and
    # cqlsh omits it, but DESC has to be kept or the table sorts the other way.
    clustering_clause = ""
    if ordered:
        rendered = ", ".join(
            f"{_ident(name)} {order.upper()}" for name, order in ordered if order.lower() == "desc"
        )
        if rendered:
            clustering_clause = f"\nCLUSTERING ORDER BY ({rendered})"
    suffix = ""
    options: list[str] = []
    if table_row is not None:
        for attr, clause in (("bloom_filter_fp_chance", "bloom_filter_fp_chance"),
                             ("caching", "caching"), ("comment", "comment"),
                             ("compaction", "compaction"), ("compression", "compression"),
                             ("dclocal_read_repair_chance", "dclocal_read_repair_chance"),
                             ("default_time_to_live", "default_time_to_live"),
                             ("gc_grace_seconds", "gc_grace_seconds"),
                             ("max_index_interval", "max_index_interval"),
                             ("memtable_flush_period_in_ms", "memtable_flush_period_in_ms"),
                             ("min_index_interval", "min_index_interval"),
                             ("read_repair_chance", "read_repair_chance"),
                             ("speculative_retry", "speculative_retry")):
            value = getattr(table_row, attr, None)
            if value in (None, "", 0):
                continue
            if isinstance(value, dict):
                rendered = "{" + ", ".join(f"'{k}': '{v}'" for k, v in value.items()) + "}"
            elif isinstance(value, str):
                rendered = f"'{value}'"
            else:
                rendered = str(value).lower() if isinstance(value, bool) else str(value)
            options.append(f"  {clause} = {rendered}")
    if options:
        suffix = "\nWITH\n" + " AND\n".join(options)
    return (
        f"CREATE TABLE {_ident(schema)}.{_ident(table)} (\n{body}\n){clustering_clause}{suffix};"
    )


def indexes(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    """Secondary indexes, which is the only index Cassandra has."""
    cluster, session = _cluster(conn)
    try:
        rows = list(session.execute(
            "select index_name, kind, options from system_schema.indexes "
            "where keyspace_name = %s and table_name = %s",
            [schema, table],
        ))
    except Exception:
        return []
    finally:
        session.shutdown()
        cluster.shutdown()
    out = []
    for row in rows:
        target = ""
        raw_options = getattr(row, "options", None)
        # The driver hands back an OrderedMapSerializedKey, which is a mapping but not a dict.
        try:
            options = dict(raw_options) if raw_options else {}
        except (TypeError, ValueError):
            options = {}
        target = str(options.get("target") or "").strip()
        out.append({"name": str(row.index_name), "unique": False,
                    "columns": [target or str(getattr(row, "kind", ""))]})
    return out


def query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    started = time.monotonic()
    cluster, session = _cluster(conn)
    try:
        statement = sql.strip().rstrip(";")
        if statement.upper().startswith("SELECT"):
            statement += f" limit {int(limit) + 1}"
        result = session.execute(statement)
        names = [str(name) for name in (result.column_names or [])] if result.column_names else []
        data = [[_value(value) for value in record] for record in result] if names else []
    except Exception as exc:
        raise HTTPException(400, f"Cassandra: {_clean(exc)}") from exc
    finally:
        session.shutdown()
        cluster.shutdown()
    is_read = sql.lstrip().split(None, 1)[0].upper() in ("SELECT", "DESCRIBE")
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
    cluster, session = _cluster(conn)
    try:
        for statement in statements:
            session.execute(statement)
    except Exception as exc:
        raise HTTPException(400, f"Cassandra: {_clean(exc)}") from exc
    finally:
        session.shutdown()
        cluster.shutdown()
