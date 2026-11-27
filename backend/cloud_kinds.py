"""Cloud warehouses: Athena, DynamoDB, BigQuery and Snowflake.

None of these can be reached from a laptop without an account, so this module is written to
the published API and left untested against a live account — the honest state is "implemented,
not yet proven". Two deliberate choices:

* **No AWS or Google SDK.** boto3 plus google-cloud-bigquery plus their dependencies add well
  over a hundred megabytes to a desktop installer for four engines, and the two APIs needed
  here are a POST with a SigV4 header and a POST with a bearer token. Signing is ~40 lines of
  hmac and hashing, and a service-account JWT is ~30 lines on top of `cryptography`, which the
  app already ships (it is what encrypts the vault).
* **Snowflake keeps its official connector.** Its SQL API needs a session handshake that is not
  worth re-implementing, and the connector is imported lazily so the app starts and runs every
  other engine without it installed.

Connection fields, mapped per engine (documented in docs/features.md):

    Athena      user = access key id, password = secret key,
                dbname = database, options = {"region": "...", "output": "s3://bucket/prefix"}
    DynamoDB    user = access key id, password = secret key,
                options = {"region": "...", "endpoint": "https://..." (optional)}
    BigQuery    user = service account e-mail, password = private key (PEM),
                options = {"project": "...", "dataset": "...", "location": "..."}
    Snowflake   user, password, host = "<account>.snowflakecomputing.com",
                dbname = database, options = {"warehouse": "...", "role": "...", "schema": "..."}
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from fastapi import HTTPException

CLOUD_KINDS = {"athena", "dynamodb", "bigquery", "snowflake"}

# Short names on purpose: these open every error message, and "Amazon Athena: …" reads worse
# than "Athena: …" in a log line.
NAMES = {"athena": "Athena", "dynamodb": "DynamoDB",
         "bigquery": "BigQuery", "snowflake": "Snowflake"}


def handles(kind: str) -> bool:
    return kind in CLOUD_KINDS


def _options(conn: dict[str, Any]) -> dict[str, Any]:
    raw = str(conn.get("options") or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"{NAMES[_kind(conn)]}: options must be JSON — {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(
            400, f"{NAMES[_kind(conn)]}: options must be a JSON object, not {type(parsed).__name__}"
        )
    return parsed


def _kind(conn: dict[str, Any]) -> str:
    kind = str(conn.get("kind") or "")
    return kind if kind in CLOUD_KINDS else "athena"


def _http(method: str, url: str, *, headers: dict[str, str], body: bytes | None = None,
          engine: str = "HTTP") -> tuple[int, Any]:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60, context=ssl.create_default_context()) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    except urllib.error.URLError as exc:
        raise HTTPException(502, f"{engine}: could not reach {url.split('/')[2]} — {exc.reason}") from exc
    try:
        parsed = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        parsed = {"raw": raw[:400].decode(errors="replace")}
    if status >= 400:
        raise HTTPException(status, f"{engine}: {_explain(parsed, status)}")
    return status, parsed


def _explain(parsed: Any, status: int) -> str:
    if isinstance(parsed, dict):
        for key in ("message", "Message", "error", "__type", "error_description"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:300]
            if isinstance(value, dict):
                inner = value.get("message") or value.get("reason")
                if isinstance(inner, str):
                    return inner[:300]
        if parsed.get("raw"):
            return str(parsed["raw"])[:300]
    return f"request failed with status {status}"


def _cell(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return "0x" + raw.hex()
    if isinstance(value, (list, tuple)):
        return [_cell(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _cell(v) for k, v in value.items()}
    if hasattr(value, "isoformat"):
        return value.isoformat(sep=" ")
    return str(value)


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


def _columns_from_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    names: list[str] = []
    for row in rows[:50]:
        for key in row:
            if key not in names:
                names.append(key)
    return [{"name": name, "type": _type_of([row.get(name) for row in rows[:50]])} for name in names]


# --------------------------------------------------------------------------- #
# AWS SigV4 — shared by Athena and DynamoDB
# --------------------------------------------------------------------------- #


def _sign_v4(conn: dict[str, Any], service: str, region: str, host: str, *,
             target: str | None, payload: bytes) -> dict[str, str]:
    access = str(conn.get("user") or "").strip()
    secret = str(conn.get("password") or "").strip()
    if not access or not secret:
        raise HTTPException(
            400, f"{NAMES[_kind(conn)]}: needs an access key id (user) and secret key (password)"
        )
    now = time.gmtime()
    amz_date = time.strftime("%Y%m%dT%H%M%SZ", now)
    date_stamp = time.strftime("%Y%m%d", now)
    content_type = "application/x-amz-json-1.1"
    canonical_headers = (
        f"content-type:{content_type}\n"
        f"host:{host}\n"
        f"x-amz-date:{amz_date}\n"
    )
    signed_headers = "content-type;host;x-amz-date"
    if target:
        canonical_headers += f"x-amz-target:{target}\n"
        signed_headers += ";x-amz-target"
    canonical_request = "\n".join([
        "POST",
        "/",
        "",
        canonical_headers,
        signed_headers,
        hashlib.sha256(payload).hexdigest(),
    ])
    scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        scope,
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    ])

    def sign(key: bytes, message: str) -> bytes:
        return hmac.new(key, message.encode(), hashlib.sha256).digest()

    signing_key = sign(
        sign(sign(sign(("AWS4" + secret).encode(), date_stamp), region), service), "aws4_request"
    )
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    headers = {
        "content-type": content_type,
        "host": host,
        "x-amz-date": amz_date,
        "Authorization": (
            f"AWS4-HMAC-SHA256 Credential={access}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
    }
    if target:
        headers["x-amz-target"] = target
    return headers


def _aws(conn: dict[str, Any], service: str, operation: str, body: dict[str, Any]) -> dict[str, Any]:
    options = _options(conn)
    region = str(options.get("region") or conn.get("host") or "us-east-1").strip()
    endpoint = str(options.get("endpoint") or "").strip()
    host = endpoint.split("://", 1)[-1] if endpoint else f"{service}.{region}.amazonaws.com"
    url = (endpoint or f"https://{host}") + "/"
    target = f"{'Athena' if service == 'athena' else 'DynamoDB'}_20120810.{operation}" \
        if service == "dynamodb" else f"AmazonAthena.{operation}"
    payload = json.dumps(body).encode()
    headers = _sign_v4(conn, service, region, host, target=target, payload=payload)
    _, parsed = _http("POST", url, headers=headers, body=payload, engine=NAMES[_kind(conn)])
    return parsed


# --------------------------------------------------------------------------- #
# Athena
# --------------------------------------------------------------------------- #


def athena_test(conn: dict[str, Any]) -> dict[str, Any]:
    options = _options(conn)
    database = str(conn.get("dbname") or "").strip()
    if not database:
        raise HTTPException(400, "Athena: needs a database name")
    if not options.get("output"):
        raise HTTPException(
            400, 'Athena: needs an S3 output location in options — {"output": "s3://bucket/prefix"}'
        )
    rows = athena_query(conn, f'SHOW TABLES IN "{database}"', 50, True)["rows"]
    return {
        "version": f"Athena · {len(rows)} table(s) in {database}",
        "database": database,
        "user": str(conn.get("user") or "")[:8] + "…",
    }


def athena_query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    options = _options(conn)
    database = str(conn.get("dbname") or "").strip()
    output = str(options.get("output") or "").strip()
    if not output:
        raise HTTPException(
            400, 'Athena: needs an S3 output location in options — {"output": "s3://bucket/prefix"}'
        )
    started = time.monotonic()
    payload = {
        "QueryString": sql.strip().rstrip(";"),
        "QueryExecutionContext": {
            "Database": database,
            "Catalog": str(options.get("catalog") or "AwsDataCatalog"),
        },
        "ResultConfiguration": {"OutputLocation": output},
    }
    if options.get("workgroup"):
        payload["WorkGroup"] = str(options["workgroup"])
    started_query = _aws(conn, "athena", "StartQueryExecution", payload)
    query_id = (started_query.get("QueryExecutionId") or "")
    if not query_id:
        raise HTTPException(400, "Athena: no query execution id returned")

    # Athena is asynchronous: poll until the execution leaves QUEUED/RUNNING.
    deadline = time.monotonic() + 120
    while True:
        status_payload = _aws(conn, "athena", "GetQueryExecution", {"QueryExecutionId": query_id})
        state = ((status_payload.get("QueryExecution") or {}).get("Status") or {}).get("State", "")
        if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            break
        if time.monotonic() > deadline:
            raise HTTPException(504, "Athena: the query did not finish within 120s")
        time.sleep(1.0)
    if state != "SUCCEEDED":
        reason = ((status_payload.get("QueryExecution") or {}).get("Status") or {}).get(
            "StateChangeReason", state)
        raise HTTPException(400, f"Athena: {reason}")

    results = _aws(conn, "athena", "GetQueryResults", {"QueryExecutionId": query_id, "MaxResults": int(limit) + 2})
    result_set = results.get("ResultSet") or {}
    meta = (result_set.get("ResultSetMetadata") or {}).get("ColumnInfo") or []
    names = [str(column.get("Name")) for column in meta]
    data = []
    for index, row in enumerate(result_set.get("Rows") or []):
        values = [str((item.get("VarCharValue") if item.get("VarCharValue") is not None else ""))
                  for item in (row.get("Data") or [])]
        if index == 0:
            # The first row of a DDL/DML result set is the header Athena invents; when the
            # column names match it, the row carries no data.
            if values == names:
                continue
        data.append(values)
    return {
        "columns": [{"name": str(column.get("Name")),
                     "type": str(column.get("Type") or "").upper()} for column in meta],
        "rows": data[: int(limit)],
        "truncated": bool(results.get("NextToken")) or len(data) > int(limit),
        "command": "SELECT" if sql.lstrip().upper().startswith(("SELECT", "WITH", "SHOW")) else sql.split(None, 1)[0].upper(),
        "readonly": readonly,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def athena_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    database = str(conn.get("dbname") or "").strip()
    result = athena_query(conn, f'SHOW TABLES IN "{database}"', 500, True)
    return [
        {"schema": database, "name": str(row[0]), "kind": "table", "est_rows": 0}
        for row in result["rows"] if row
    ]


def athena_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    result = athena_query(conn, f'SHOW COLUMNS IN "{table}"', 500, True)
    names = [column["name"].lower() for column in result["columns"]]
    out = []
    for row in result["rows"]:
        record = dict(zip(names, row))
        out.append({
            "name": str(record.get("column") or record.get("field") or row[0]),
            "type": str(record.get("type") or (row[1] if len(row) > 1 else "")),
            "nullable": True,
            "default": "",
            "primary": False,
        })
    return out


def athena_rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
                where: str = "", columns_meta=None) -> dict[str, Any]:
    sql = f'select * from "{schema}"."{table}"'
    if where:
        sql += f" where {where}"
    if order_by:
        sql += f' order by "{order_by}" {"desc" if str(direction).upper() == "DESC" else "asc"}'
    # Athena has OFFSET, but a large one scans everything before it; keep the page honest.
    sql += f" limit {int(limit) + 1} offset {int(offset)}"
    result = athena_query(conn, sql, limit, True)
    return {
        "columns": result["columns"],
        "rows": result["rows"][: int(limit)],
        "truncated": len(result["rows"]) > int(limit),
        "offset": int(offset),
        "limit": int(limit),
        "duration_ms": result["duration_ms"],
    }


def athena_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    result = athena_query(conn, f'SHOW CREATE TABLE "{schema}"."{table}"', 5, True)
    for row in result["rows"]:
        for value in row:
            if value and "CREATE" in str(value).upper():
                return str(value).strip().rstrip(";") + ";"
    columns_meta = athena_columns(conn, schema, table)
    body = ",\n".join(f'  "{c["name"]}" {c["type"] or "string"}' for c in columns_meta)
    return f'CREATE TABLE "{schema}"."{table}" (\n{body}\n);'


def athena_indexes(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    """Athena tables are files in S3: partitions are the closest thing to an index."""
    result = athena_query(conn, f'SHOW PARTITIONS "{schema}"."{table}"', 200, True)
    partitions = [str(row[0]).split("=")[0] for row in result["rows"] if row]
    if not partitions:
        return []
    unique = sorted(set(partitions))
    return [{"name": "partition", "unique": False, "columns": unique}]


# --------------------------------------------------------------------------- #
# DynamoDB
# --------------------------------------------------------------------------- #


def dynamodb_test(conn: dict[str, Any]) -> dict[str, Any]:
    payload = _aws(conn, "dynamodb", "ListTables", {"Limit": 100})
    tables = payload.get("TableNames") or []
    return {
        "version": f"DynamoDB · {len(tables)} table(s)",
        "database": str(_options(conn).get("region") or conn.get("host") or ""),
        "user": str(conn.get("user") or "")[:8] + "…",
    }


def dynamodb_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    payload = _aws(conn, "dynamodb", "ListTables", {"Limit": 1000})
    region = str(_options(conn).get("region") or "region")
    return [
        {"schema": region, "name": str(name), "kind": "table", "est_rows": 0}
        for name in sorted(payload.get("TableNames") or [])
    ]


def dynamodb_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    payload = _aws(conn, "dynamodb", "DescribeTable", {"TableName": table})
    description = payload.get("Table") or {}
    attributes = {str(a.get("AttributeName")): str(a.get("AttributeType"))
                  for a in (description.get("AttributeDefinitions") or [])}
    key_names = []
    for key in (description.get("KeySchema") or []):
        key_names.append(str(key.get("AttributeName")))
    out = [
        {"name": name, "type": {"S": "string", "N": "number", "B": "binary"}.get(type_, type_),
         "nullable": name not in key_names, "default": "", "primary": name in key_names}
        for name, type_ in attributes.items()
    ]
    # A DynamoDB item has no fixed columns; the attributes are only the keys it is indexed on.
    out.append({"name": "(attributes)", "type": "item", "nullable": True, "default": "",
                "primary": False})
    return out


def dynamodb_rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
                  where: str = "", columns_meta=None) -> dict[str, Any]:
    if int(offset):
        raise HTTPException(400, "DynamoDB has no OFFSET: page with the LastEvaluatedKey cursor instead")
    started = time.monotonic()
    payload = _aws(conn, "dynamodb", "Scan", {"TableName": table, "Limit": int(limit) + 1})
    items = payload.get("Items") or []
    rows = [{str(k): _dynamo(v) for k, v in item.items()} for item in items]
    columns = columns_meta or _columns_from_rows(rows)
    names = [column["name"] for column in columns] or list(rows[0].keys() if rows else [])
    meta = {column["name"]: column.get("type", "") for column in columns}
    return {
        "columns": [{"name": name, "type": meta.get(name, "")} for name in names],
        "rows": [[row.get(name) for name in names] for row in rows[: int(limit)]],
        "truncated": len(rows) > int(limit) or bool(payload.get("LastEvaluatedKey")),
        "offset": 0,
        "limit": int(limit),
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _dynamo(value: Any) -> Any:
    """DynamoDB attributes are tagged unions: {"S": "ada"} means the string 'ada'."""
    if isinstance(value, dict) and len(value) > 1:
        # A whole item: unwrap each attribute in turn.
        return {str(key): _dynamo(inner) for key, inner in value.items()}
    if isinstance(value, dict) and len(value) == 1:
        tag, inner = next(iter(value.items()))
        if tag in ("S", "N", "BOOL", "NULL"):
            return inner if tag != "NULL" else None
        if tag == "B":
            return base64.b64decode(inner) if isinstance(inner, str) else inner
        if tag in ("L", "SS", "NS"):
            return [_dynamo(item) for item in inner] if isinstance(inner, list) else inner
        if tag in ("M", "BS"):
            if isinstance(inner, dict):
                return {str(k): _dynamo(v) for k, v in inner.items()}
            return inner
    return _cell(value)


def dynamodb_query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    """DynamoDB has no SQL. A statement this panel can honour is a JSON PartiQL pass-through."""
    _guard(conn, sql)
    started = time.monotonic()
    payload = _aws(conn, "dynamodb", "ExecuteStatement",
                   {"Statement": sql.strip().rstrip(";"), "Limit": int(limit)})
    items = payload.get("Items") or []
    rows = [{str(k): _dynamo(v) for k, v in item.items()} for item in items]
    columns = _columns_from_rows(rows)
    return {
        "columns": columns,
        "rows": [[row.get(column["name"]) for column in columns] for row in rows[: int(limit)]],
        "truncated": len(rows) > int(limit),
        "command": sql.split(None, 1)[0].upper(),
        "readonly": readonly,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def dynamodb_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    payload = _aws(conn, "dynamodb", "DescribeTable", {"TableName": table})
    return json.dumps(payload.get("Table") or {}, indent=2, default=str)


def dynamodb_indexes(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    payload = _aws(conn, "dynamodb", "DescribeTable", {"TableName": table})
    description = payload.get("Table") or {}
    out = []
    for key in (description.get("GlobalSecondaryIndexes") or []):
        out.append({"name": str(key.get("IndexName")), "unique": False,
                    "columns": [str(k.get("AttributeName")) for k in (key.get("KeySchema") or [])]})
    for key in (description.get("LocalSecondaryIndexes") or []):
        out.append({"name": str(key.get("IndexName")), "unique": False,
                    "columns": [str(k.get("AttributeName")) for k in (key.get("KeySchema") or [])]})
    return out


# --------------------------------------------------------------------------- #
# BigQuery
# --------------------------------------------------------------------------- #


def _bigquery_token(conn: dict[str, Any]) -> str:
    """A service-account JWT exchanged for an access token, without the Google SDK."""
    client_email = str(conn.get("user") or "").strip()
    pem = str(conn.get("password") or "").replace("\\n", "\n").strip()
    if not client_email or "BEGIN PRIVATE KEY" not in pem:
        raise HTTPException(
            400,
            "BigQuery: needs the service-account e-mail (user) and its private key PEM (password)",
        )
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
    except ModuleNotFoundError as exc:  # pragma: no cover
        raise HTTPException(400, "BigQuery signing needs the cryptography package") from exc

    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    claims = {
        "iss": client_email,
        "scope": "https://www.googleapis.com/auth/bigquery.readonly",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }

    def b64(payload: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()

    signing_input = f"{b64(header)}.{b64(claims)}".encode()
    key: Any = serialization.load_pem_private_key(pem.encode(), password=None)
    signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    assertion = f"{signing_input.decode()}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"
    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion,
    }).encode()
    _, payload = _http(
        "POST", "https://oauth2.googleapis.com/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=body, engine="BigQuery",
    )
    token = payload.get("access_token")
    if not token:
        raise HTTPException(400, "BigQuery: no access token in the OAuth response")
    return str(token)


def _bigquery(conn: dict[str, Any], method: str, url: str, body: dict[str, Any] | None = None):
    token = _bigquery_token(conn)
    payload = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if payload:
        headers["Content-Type"] = "application/json"
    _, parsed = _http(method, url, headers=headers, body=payload, engine="BigQuery")
    return parsed


def bigquery_project(conn: dict[str, Any]) -> str:
    project = str(_options(conn).get("project") or "").strip()
    if not project:
        raise HTTPException(400, 'BigQuery: needs a project in options — {"project": "my-project"}')
    return project


def bigquery_test(conn: dict[str, Any]) -> dict[str, Any]:
    project = bigquery_project(conn)
    payload = _bigquery(conn, "GET", f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/datasets")
    datasets = payload.get("datasets") or []
    return {
        "version": f"BigQuery · {len(datasets)} dataset(s) in {project}",
        "database": project,
        "user": str(conn.get("user") or ""),
    }


def bigquery_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    project = bigquery_project(conn)
    dataset = str(_options(conn).get("dataset") or "").strip() or str(conn.get("dbname") or "").strip()
    if not dataset:
        payload = _bigquery(conn, "GET",
                            f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/datasets")
        datasets = [str(item.get("datasetReference", {}).get("datasetId"))
                    for item in (payload.get("datasets") or [])]
    else:
        datasets = [dataset]
    nodes: list[dict[str, Any]] = []
    for name in datasets:
        payload = _bigquery(
            conn, "GET",
            f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/datasets/{name}/tables",
        )
        for table in payload.get("tables") or []:
            nodes.append({
                "schema": name,
                "name": str(table.get("tableReference", {}).get("tableId")),
                "kind": "view" if str(table.get("type")) == "VIEW" else "table",
                "est_rows": 0,
            })
    return nodes


def bigquery_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    project = bigquery_project(conn)
    payload = _bigquery(
        conn, "GET",
        f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/datasets/{schema}/tables/{table}",
    )
    fields = (payload.get("schema") or {}).get("fields") or []
    out = []
    for field in fields:
        mode = str(field.get("mode") or "NULLABLE").upper()
        out.append({
            "name": str(field.get("name")),
            "type": str(field.get("type") or ""),
            "nullable": mode != "REQUIRED",
            "default": "",
            "primary": False,
        })
    return out


def bigquery_rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
                  where: str = "", columns_meta=None) -> dict[str, Any]:
    sql = f"select * from `{bigquery_project(conn)}.{schema}.{table}`"
    if where:
        sql += f" where {where}"
    if order_by:
        sql += f" order by `{order_by}` {'DESC' if str(direction).upper() == 'DESC' else 'ASC'}"
    sql += f" limit {int(limit) + 1} offset {int(offset)}"
    result = bigquery_query(conn, sql, limit + 1, True)
    return {
        "columns": result["columns"],
        "rows": result["rows"][: int(limit)],
        "truncated": len(result["rows"]) > int(limit),
        "offset": int(offset),
        "limit": int(limit),
        "duration_ms": result["duration_ms"],
    }


def bigquery_query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    _guard(conn, sql)
    started = time.monotonic()
    project = bigquery_project(conn)
    payload = _bigquery(
        conn, "POST", f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/queries",
        {
            "query": sql.strip().rstrip(";"),
            "useLegacySql": False,
            "maxResults": int(limit),
            "timeoutMs": 60000,
            "location": str(_options(conn).get("location") or "US"),
        },
    )
    schema = (payload.get("schema") or {}).get("fields") or []
    names = [str(field.get("name")) for field in schema]
    types = [str(field.get("type") or "") for field in schema]
    rows = []
    for row in payload.get("rows") or []:
        values = []
        for cell in (row.get("f") or []):
            value = cell.get("v")
            if isinstance(value, dict):  # nested/repeated records come back as {"f": [...]}
                values.append(str(value))
            else:
                values.append(value)
        rows.append(values)
    return {
        "columns": [{"name": name, "type": type_} for name, type_ in zip(names, types)],
        "rows": rows[: int(limit)],
        "truncated": len(rows) > int(limit) or bool(payload.get("pageToken")),
        "command": "SELECT" if sql.lstrip().upper().startswith(("SELECT", "WITH")) else sql.split(None, 1)[0].upper(),
        "readonly": readonly,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def bigquery_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    project = bigquery_project(conn)
    payload = _bigquery(conn, "GET",
                        f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/datasets/{schema}/tables/{table}")
    fields = (payload.get("schema") or {}).get("fields") or []
    body = ",\n".join(
        f"  `{field.get('name')}` {field.get('type')}"
        + (" REPEATED" if str(field.get("mode", "")).upper() == "REPEATED" else "")
        for field in fields
    )
    return f"CREATE TABLE `{project}.{schema}.{table}` (\n{body}\n);"


def bigquery_indexes(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    """BigQuery has partitioning and clustering instead of indexes."""
    project = bigquery_project(conn)
    payload = _bigquery(conn, "GET",
                        f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/datasets/{schema}/tables/{table}")
    out = []
    clustering = (payload.get("clustering") or {}).get("fields") or []
    if clustering:
        out.append({"name": "clustered", "unique": False, "columns": [str(c) for c in clustering]})
    partition = payload.get("timePartitioning") or {}
    if partition:
        out.append({"name": "partitioned", "unique": False,
                    "columns": [str(partition.get("field") or "_PARTITIONTIME")]})
    return out


# --------------------------------------------------------------------------- #
# Snowflake (official connector, imported only when used)
# --------------------------------------------------------------------------- #


def _snowflake_connect(conn: dict[str, Any]):
    try:
        import snowflake.connector as connector
    except ModuleNotFoundError as exc:
        raise HTTPException(
            400,
            "Snowflake: needs its connector — `pip install snowflake-connector-python`",
        ) from exc
    options = _options(conn)
    try:
        return connector.connect(
            account=str(conn.get("host") or "").split(".")[0] or None,
            host=str(conn.get("host") or "") or None,
            user=str(conn.get("user") or ""),
            password=str(conn.get("password") or ""),
            database=str(conn.get("dbname") or "") or None,
            schema=str(options.get("schema") or "") or None,
            warehouse=str(options.get("warehouse") or "") or None,
            role=str(options.get("role") or "") or None,
            login_timeout=20,
            network_timeout=60,
        )
    except Exception as exc:
        raise HTTPException(400, f"Snowflake: {str(exc).strip()[:300]}") from exc


def snowflake_test(conn: dict[str, Any]) -> dict[str, Any]:
    db = _snowflake_connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute("select current_version()")
        version = str(cursor.fetchone()[0])
    except Exception as exc:
        raise HTTPException(400, f"Snowflake: {str(exc).strip()[:300]}") from exc
    finally:
        db.close()
    return {"version": f"Snowflake {version}", "database": str(conn.get("dbname") or ""),
            "user": str(conn.get("user") or "")}


def snowflake_tree(conn: dict[str, Any]) -> list[dict[str, Any]]:
    database = str(conn.get("dbname") or "")
    db = _snowflake_connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(
            "select table_schema, table_name, table_type from "
            f"{database}.information_schema.tables order by table_schema, table_name"
        )
        rows = cursor.fetchall()
    except Exception as exc:
        raise HTTPException(400, f"Snowflake: {str(exc).strip()[:300]}") from exc
    finally:
        db.close()
    return [
        {"schema": str(schema), "name": str(name),
         "kind": "view" if "VIEW" in str(kind).upper() else "table", "est_rows": 0}
        for schema, name, kind in rows
        if str(schema).upper() != "INFORMATION_SCHEMA"
    ]


def snowflake_columns(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    database = str(conn.get("dbname") or "")
    db = _snowflake_connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(
            "select column_name, data_type, is_nullable, column_default from "
            f"{database}.information_schema.columns where table_schema = %s and table_name = %s "
            "order by ordinal_position",
            (schema, table),
        )
        rows = cursor.fetchall()
    except Exception as exc:
        raise HTTPException(400, f"Snowflake: {str(exc).strip()[:300]}") from exc
    finally:
        db.close()
    return [
        {"name": str(name), "type": str(data_type),
         "nullable": str(nullable).upper() == "YES",
         "default": "" if default is None else str(default), "primary": False}
        for name, data_type, nullable, default in rows
    ]


def snowflake_rows(conn, schema, table, limit, offset, order_by, direction, filters=None,
                   where: str = "", columns_meta=None) -> dict[str, Any]:
    started = time.monotonic()
    database = str(conn.get("dbname") or "")
    sql = f'select * from "{database}"."{schema}"."{table}"'
    if where:
        sql += f" where {where}"
    if order_by:
        sql += f' order by "{order_by}" {"DESC" if str(direction).upper() == "DESC" else "ASC"}'
    sql += f" limit {int(limit) + 1} offset {int(offset)}"
    result = snowflake_query(conn, sql, limit + 1, True)
    return {
        "columns": result["columns"],
        "rows": result["rows"][: int(limit)],
        "truncated": len(result["rows"]) > int(limit),
        "offset": int(offset),
        "limit": int(limit),
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def snowflake_query(conn, sql: str, limit: int, readonly: bool) -> dict[str, Any]:
    _guard(conn, sql)
    started = time.monotonic()
    db = _snowflake_connect(conn)
    try:
        cursor = db.cursor()
        cursor.execute(sql)
        names = [str(column[0]) for column in (cursor.description or [])]
        data = [[_cell(value) for value in row] for row in (cursor.fetchmany(int(limit) + 1) or [])]
    except Exception as exc:
        raise HTTPException(400, f"Snowflake: {str(exc).strip()[:300]}") from exc
    finally:
        db.close()
    return {
        "columns": [{"name": name, "type": _type_of([row[index] for row in data[:20]])}
                    for index, name in enumerate(names)],
        "rows": data[: int(limit)],
        "truncated": len(data) > int(limit),
        "command": "SELECT" if sql.lstrip().upper().startswith(("SELECT", "WITH")) else sql.split(None, 1)[0].upper(),
        "readonly": readonly,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def snowflake_ddl(conn: dict[str, Any], schema: str, table: str) -> str:
    database = str(conn.get("dbname") or "")
    result = snowflake_query(conn, f'select get_ddl(\'table\', \'{database}.{schema}.{table}\')', 1, True)
    for row in result["rows"]:
        if row and row[0]:
            return str(row[0]).strip().rstrip(";") + ";"
    return f'-- Snowflake could not return DDL for "{database}"."{schema}"."{table}"'


def snowflake_indexes(conn: dict[str, Any], schema: str, table: str) -> list[dict[str, Any]]:
    """Snowflake has clustering keys, not indexes."""
    result = snowflake_query(
        conn,
        f'select cluster_by from "{str(conn.get("dbname") or "")}".information_schema.tables '
        f"where table_schema = '{schema}' and table_name = '{table}'",
        1, True,
    )
    for row in result["rows"]:
        if row and row[0] and str(row[0]).strip():
            return [{"name": "cluster_by", "unique": False,
                     "columns": [part.strip() for part in str(row[0]).split(",")]}]
    return []


def _guard(conn: dict[str, Any], sql: str) -> None:
    if not conn.get("readonly", True):
        return
    statement = sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""
    if statement not in ("SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"):
        raise HTTPException(403, "this connection is read-only; turn off read-only in its settings")


def run(conn: dict[str, Any], statements: list[str]) -> None:
    kind = _kind(conn)
    if conn.get("readonly", True):
        raise HTTPException(403, "this connection is read-only; turn off read-only in its settings")
    if kind == "snowflake":
        db = _snowflake_connect(conn)
        try:
            cursor = db.cursor()
            for statement in statements:
                cursor.execute(statement)
        except Exception as exc:
            raise HTTPException(400, f"Snowflake: {str(exc).strip()[:300]}") from exc
        finally:
            db.close()
        return
    raise HTTPException(400, f"{NAMES[kind]} writes are not wired yet")


# --------------------------------------------------------------------------- #
# registry
# --------------------------------------------------------------------------- #

ENGINES = {
    "athena": {"test": athena_test, "tree": athena_tree, "columns": athena_columns,
               "rows": athena_rows, "query": athena_query, "ddl": athena_ddl,
               "indexes": athena_indexes},
    "dynamodb": {"test": dynamodb_test, "tree": dynamodb_tree, "columns": dynamodb_columns,
                 "rows": dynamodb_rows, "query": dynamodb_query, "ddl": dynamodb_ddl,
                 "indexes": dynamodb_indexes},
    "bigquery": {"test": bigquery_test, "tree": bigquery_tree, "columns": bigquery_columns,
                 "rows": bigquery_rows, "query": bigquery_query, "ddl": bigquery_ddl,
                 "indexes": bigquery_indexes},
    "snowflake": {"test": snowflake_test, "tree": snowflake_tree, "columns": snowflake_columns,
                  "rows": snowflake_rows, "query": snowflake_query, "ddl": snowflake_ddl,
                  "indexes": snowflake_indexes},
}
