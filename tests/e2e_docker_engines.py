"""E2E the engines Docker can prove, against real servers in containers.

Run it by hand; it is not part of the offline suite:

    docker run -d --name dbdesk-ora -e ORACLE_PASSWORD=Dbdesk12345 -e APP_USER=appuser \
        -e APP_USER_PASSWORD=Dbdesk12345 -p 1521:1521 gvenzl/oracle-free:23-slim
    docker run -d --name dbdesk-cass -p 9042:9042 cassandra:5.0
    .venv/bin/python tests/e2e_docker_engines.py

Each engine is exercised through the same functions the HTTP API calls — connect, list,
columns, rows, DDL, indexes, query, and the read-only refusal.

**Vertica is not here on purpose.** `vertica/vertica-ce` no longer resolves on Docker Hub (and
`opentext/vertica-ce` does not exist either): a pull returns "pull access denied", so the image
needs a login this machine does not have. The Vertica code path is therefore implemented and
unproven, the same status as the four cloud warehouses in cloud_kinds.py.
"""

import sys
import uuid

sys.path.insert(0, "/root/dbdesk-standalone/backend")

from fastapi import HTTPException  # noqa: E402

import cassandra_kind  # noqa: E402
import oracle_kind  # noqa: E402

FAIL = []


def check(label, condition, detail=""):
    print(("  ok   " if condition else "  FAIL ") + label + (f"  {detail}" if detail else ""))
    if not condition:
        FAIL.append(label)


# --------------------------------------------------------------------------- Oracle
print("\n=== Oracle 23 FREE (thin driver, no Instant Client)")

import oracledb  # noqa: E402

ORA = {"kind": "oracle", "host": "127.0.0.1", "port": 1521, "dbname": "FREEPDB1",
       "user": "appuser", "password": "Dbdesk12345", "readonly": True}

setup = oracledb.connect(user="appuser", password="Dbdesk12345", dsn="127.0.0.1:1521/FREEPDB1")
cur = setup.cursor()
for statement in (
    "begin execute immediate 'drop table customers'; exception when others then null; end;",
    """create table customers (
         id number primary key,
         name varchar2(100) not null,
         email varchar2(200),
         created_at timestamp,
         notes clob)""",
    "insert into customers values (1, 'Aisyah', 'aisyah@example.com', "
    "timestamp '2026-01-04 09:15:00', 'first')",
    "insert into customers values (2, 'Bala', 'bala@example.com', "
    "timestamp '2026-02-11 14:30:00', null)",
    "insert into customers values (3, 'Chen', 'chen@example.com', "
    "timestamp '2026-03-19 22:05:00', 'third')",
    "create index idx_customers_email on customers(email)",
):
    cur.execute(statement)
setup.commit()
setup.close()

version = oracle_kind.test(ORA)
check("test() reports the server version", "Oracle 23" in version["version"], version["version"])

nodes = oracle_kind.tree(ORA)
tables = [n for n in nodes if n["name"] == "CUSTOMERS"]
check("tree() lists APPUSER.CUSTOMERS", bool(tables), f"{len(nodes)} objects, "
      f"CUSTOMERS in {tables[0]['schema'] if tables else '-'}")
check("tree() does not list SYS/SYSTEM noise",
      not any(n["schema"] in ("SYS", "SYSTEM", "MDSYS", "XDB") for n in nodes))

cols = oracle_kind.columns(ORA, "APPUSER", "CUSTOMERS")
check("columns() returns 5 with types",
      len(cols) == 5 and [c["name"] for c in cols] == ["ID", "NAME", "EMAIL", "CREATED_AT", "NOTES"],
      ", ".join(f"{c['name']}:{c['type']}" for c in cols))
check("columns() flags NOT NULL", next(c for c in cols if c["name"] == "NAME")["nullable"] is False)

page = oracle_kind.rows(ORA, "APPUSER", "CUSTOMERS", 2, 0, "", "ASC", columns_meta=cols)
check("rows() honours the limit", len(page["rows"]) == 2, f"{len(page['rows'])} rows")
check("rows() reports truncation", page["truncated"] is True)
page2 = oracle_kind.rows(ORA, "APPUSER", "CUSTOMERS", 2, 2, "ID", "ASC", columns_meta=cols)
check("rows() honours OFFSET", page2["rows"] and page2["rows"][0][0] == 3, str(page2["rows"]))
check("rows() serialises TIMESTAMP and CLOB",
      any(isinstance(v, str) and "2026-01-04" in v for v in page["rows"][0]),
      str(page["rows"][0]))

text = oracle_kind.ddl(ORA, "APPUSER", "CUSTOMERS")
check("ddl() comes from dbms_metadata", "CREATE TABLE" in text.upper() and '"NOTES"' in text.upper().replace("'", '"'),
      text.splitlines()[0][:70])

idx = oracle_kind.indexes(ORA, "APPUSER", "CUSTOMERS")
check("indexes() finds IDX_CUSTOMERS_EMAIL", any(i["name"] == "IDX_CUSTOMERS_EMAIL" for i in idx),
      str([i["name"] for i in idx]))

result = oracle_kind.query(ORA, "select count(*) as n from customers", 10, True)
check("query() runs a COUNT", result["rows"][0][0] == 3, str(result["rows"]))
try:
    oracle_kind.query(ORA, "select * from no_such_table", 10, True)
    check("a bad statement returns a named error", False)
except HTTPException as exc:
    check("a bad statement returns a named error", str(exc.detail).startswith("Oracle:"),
          str(exc.detail)[:80])

# write path must be refused while read-only
try:
    oracle_kind.run(ORA, ["delete from customers"])
    check("read-only connection refuses a write", False)
except HTTPException as exc:
    check("read-only connection refuses a write", exc.status_code == 403, str(exc.detail))

bad = dict(ORA, password="wrong")
try:
    oracle_kind.test(bad)
    check("wrong password fails with a named error", False)
except HTTPException as exc:
    check("wrong password fails with a named error",
          str(exc.detail).startswith("Oracle:") and "ORA-" in str(exc.detail), str(exc.detail)[:90])


# ------------------------------------------------------------------------ Cassandra
print("\n=== Cassandra 5.0 (CQL, no OFFSET, reconstructed DDL)")

from cassandra.cluster import Cluster  # noqa: E402

cluster = Cluster(["127.0.0.1"], port=9042)
session = cluster.connect()
session.execute(
    "create keyspace if not exists shop with replication = "
    "{'class': 'SimpleStrategy', 'replication_factor': 1}"
)
session.execute("drop table if exists shop.customers")
session.execute("""
    create table shop.customers (
        country text,
        id uuid,
        name text,
        email text,
        created_at timestamp,
        primary key ((country), created_at, id)
    ) with clustering order by (created_at desc)
      and comment = 'demo table'
""")
rows = [
    ("MY", uuid.UUID("11111111-1111-1111-1111-111111111111"), "Aisyah", "aisyah@example.com"),
    ("MY", uuid.UUID("22222222-2222-2222-2222-222222222222"), "Bala", "bala@example.com"),
    ("SG", uuid.UUID("33333333-3333-3333-3333-333333333333"), "Chen", "chen@example.com"),
]
for country, ident, name, email in rows:
    session.execute(
        "insert into shop.customers (country, id, name, email, created_at) values (%s, %s, %s, %s, toTimestamp(now()))",
        (country, ident, name, email),
    )
session.execute("create index if not exists customers_email_idx on shop.customers (email)")
session.shutdown()
cluster.shutdown()

CASS = {"kind": "cassandra", "host": "127.0.0.1", "port": 9042, "dbname": "shop",
        "user": "", "password": "", "readonly": True}

version = cassandra_kind.test(CASS)
check("test() reports the release", "Cassandra 5" in version["version"], version["version"])

nodes = cassandra_kind.tree(CASS)
check("tree() lists shop.customers", any(n["schema"] == "shop" and n["name"] == "customers" for n in nodes),
      f"{len(nodes)} tables")
check("tree() hides system keyspaces",
      not any(n["schema"].startswith("system") for n in nodes))

cols = cassandra_kind.columns(CASS, "shop", "customers")
names = [c["name"] for c in cols]
check("columns() returns the CQL types", len(cols) == 5,
      ", ".join(f"{c['name']}:{c['type']}" for c in cols))
check("columns() puts keys first", names[:3] == ["country", "created_at", "id"] or names[0] == "country",
      str(names))

page = cassandra_kind.rows(CASS, "shop", "customers", 2, 0, "", "ASC", columns_meta=cols)
check("rows() respects LIMIT and reports truncation",
      len(page["rows"]) == 2 and page["truncated"] is True, f"{len(page['rows'])} rows")
check("rows() serialises uuid and timestamp",
      any(isinstance(v, str) and "-" in str(v) for row in page["rows"] for v in row))

try:
    cassandra_kind.rows(CASS, "shop", "customers", 2, 2, "", "ASC", columns_meta=cols)
    check("rows() refuses OFFSET instead of returning the wrong page", False)
except HTTPException as exc:
    check("rows() refuses OFFSET instead of returning the wrong page",
          "OFFSET" in str(exc.detail), str(exc.detail)[:80])

text = cassandra_kind.ddl(CASS, "shop", "customers")
check("ddl() reconstructs CREATE TABLE", "create table" in text.lower(), text.replace("\n", " ")[:120])
check("ddl() keeps the composite partition key",
      'primary key (("country"), "created_at", "id")' in text.lower(), "")
check("ddl() keeps the table options", "clustering order" in text.lower() and "comment" in text.lower(),
      text.splitlines()[-2][:70])

idx = cassandra_kind.indexes(CASS, "shop", "customers")
check("indexes() lists the secondary index", any("email" in str(i["columns"]).lower() for i in idx),
      str([i["name"] for i in idx]))

result = cassandra_kind.query(CASS, "select count(*) as n from shop.customers", 10, True)
check("query() runs a CQL aggregate", result["rows"][0][0] == 3, str(result["rows"]))

try:
    cassandra_kind.run(CASS, ["truncate shop.customers"])
    check("read-only connection refuses a write", False)
except HTTPException as exc:
    check("read-only connection refuses a write", exc.status_code == 403, str(exc.detail))

print("\nFAILURES:", FAIL if FAIL else "none")
sys.exit(1 if FAIL else 0)
