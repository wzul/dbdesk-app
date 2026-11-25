# MCP server

[← Back to the README](../README.md)

DB Desk can act as a Model Context Protocol server so a **local** agent can
drive the same connections the app uses. Nothing is exposed until you enable it
in **Settings → MCP server**.

### Transports

**stdio** (Claude Desktop, Cursor, most clients): the bundled sidecar runs as a
bridge and talks to the open app.

```json
{
  "mcpServers": {
    "dbdesk": {
      "command": "/Applications/DB Desk.app/Contents/Resources/sidecar/dbdesk-server/dbdesk-server",
      "args": ["mcp"],
      "env": { "DBDESK_HOME": "/Users/you/Library/Application Support/DB Desk" }
    }
  }
}
```

Use **Copy stdio config** in Settings to get the exact paths for your install.

**HTTP** (Streamable HTTP, JSON-RPC 2.0): `POST http://127.0.0.1:<port>/mcp`
with `Authorization: Bearer <token>`. Use **Copy HTTP config**.

The app must be open. The bridge discovers the port from
`<app home>/data/runtime.json`; the token lives in `<app home>/data/mcp.json`
(mode 0600).

### Connecting to an MCP server

1. Paste the Streamable-HTTP URL and click **Authorize**.
2. Click **Detect tools**. DB Desk calls `tools/list` and shows the tools that
   look like SQL runners (usually names ending in `_query`), with the detected
   dialect and database name.
3. Pick one. DB Desk fills the **SQL argument** (usually `sql`), the dialect and
   the **Database label**.

For an MCP connection the **Database** field is only a display label — the
tool you pick determines the real database. If the tool itself needs a
database argument, put it in **Extra arguments**, for example
`{"database":"analytics"}`.

### Tools

| Tool | What it does |
|---|---|
| `connections_list` | saved connections (no passwords or tokens) |
| `databases_list` | databases reachable through a connection |
| `tables_list` | schemas + tables/views |
| `table_columns` / `table_indexes` / `table_ddl` | structure |
| `table_rows` | rows with filters, order, limit, offset |
| `table_csv` | CSV text (capped, reports `truncated`) |
| `query` | one SQL statement, audited as `mcp_query` |
| `ask_data` | DB Desk's AI agent, including multi-database local joins |
| `connection_draft` | propose a connection; the user reviews it and types the password |
| `connection_update` | edit non-secret fields (host, port, db, user, group, SSH) |
| `connection_delete` | queue deletion for approval |
| `connection_test` | open the saved connection and return server details |
| `views_list` / `view_create` / `view_delete` | manage saved views |
| `queries_list` / `query_save` / `query_delete` | manage the SQL snippets in the Queries drawer |
| `app_status` | version, data path, counts, AI model, MCP and notification state |
| `settings_update` | toggle notifications, set the AI model, turn MCP writes off |

### Connection drafts

An agent cannot receive or send database passwords. `connection_draft` stores a
pending draft; the picker shows **Agent drafted “…”** with **Review**. The normal
connection form opens prefilled, the user types the password, and saving marks
the draft applied. Drafts never contain secret-like keys.

### Destructive actions

`connection_delete` and production `connection_update` create entries in
**Approvals**. Nothing changes until the user approves; the audit log records
both the request and the result. `settings_update` cannot enable writes, change
the AI base URL/key or read the MCP token.

### Writes

- A **read-only** connection only accepts `SELECT`/`WITH`/`SHOW`/`EXPLAIN`.
- A writable connection can run writes when **Allow writes** is on (it is on
  when you first enable MCP; turn it off if the agent should be read-only).
- Production writes use the existing audit + native notification path.
- Every MCP statement is written to the audit log with action `mcp_query`.

### Connection access model

The connection picker is **not** an access gate. MCP clients talk to the local
service directly, so when the server is enabled, **every saved connection is
reachable** — even one you never opened in the picker. A tunnel or pool is
opened on demand by the backend when a tool first uses that connection. Opening
a table in the UI and exposing a connection to MCP are separate things.

To restrict what an agent can touch:

- turn the **MCP server** off when you are not using it;
- keep connections **read-only**, or give their database user limited grants;
- turn **Allow writes** off for an agent that should only read;
- delete connections you do not want exposed;
- quit DB Desk — both stdio and HTTP transports stop immediately.

### Writes

- A **read-only** connection only accepts `SELECT`/`WITH`/`SHOW`/`EXPLAIN`.
- A writable connection can run writes when **Allow writes** is on.
- Production writes are written to the audit log and send the native
  notification. They do **not** raise the approval drawer — keep the MCP token
  private and prefer read-only connections for agents.
- Every MCP statement is written to the audit log with action `mcp_query`.

### Security

- The HTTP endpoint binds to the app's loopback socket only.
- Requests require the bearer token; rotate it from Settings at any time.
- Tool results never include passwords, API keys or SSH material.
- Disable the server (or quit the app) and both transports stop immediately.
