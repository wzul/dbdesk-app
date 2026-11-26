# Security

## Reporting

Open a **private security advisory** on the repository
(*Security → Advisories → Report a vulnerability*) or email the maintainer.
Please do not open a public issue for a vulnerability.

## Trust model

DB Desk is a **database client**: it is not a sandbox.

- **SQL execution.** Every query runs with the credentials the operator
  configures, through the system `psql`/`mysql` client, the ClickHouse HTTP
  interface, an MCP server or an HTTP query gateway. A read-only connection is a
  guardrail (`default_transaction_read_only`, `tx_read_only`, `readonly=1`, or a
  SELECT-only check), not a database permission boundary. Use database accounts
  that are themselves read-only.
- **Custom tunnel commands.** A connection's `tunnel_command` is a shell command
  executed by the plugin host (`/bin/sh -lc`) with the configured `tunnel_env`.
  Anyone who can edit a connection can run commands as that host user. Only add
  connections/tunnel commands you trust.
- **Secrets at rest.** Passwords are encrypted with AES-GCM
  (`plugin-data/dbdesk/connections.json`, key in `vault.key`, both `0600`). HTTP
  headers (e.g. Cloudflare Access service tokens) and tunnel `KEY=VALUE` env are
  stored in the same 0600 file; they are not separately encrypted. The encryption
  protects a copied/backed-up connection file — it does not isolate the secrets
  from the host user.
- **Agent tools.** `db_connections` and `db_query` are read-only: only
  SELECT/WITH/SHOW/EXPLAIN, at most 200 rows, cells truncated to 2000 chars.
  MCP tool calls require an operator allowlist
  (`plugins.entries.dbdesk.mcp_allowlist`, default deny).
- **Webapp access.** The Hermes webapp authentication gates the plugin's HTTP
  routes. Anyone who can use the webapp can use the configured connections; use
  a dedicated Hermes account/profile or do not expose the webapp broadly.
- **No telemetry.** The plugin makes no network request except to the database,
  MCP/HTTP endpoint, tunnel command, or the optional `hermes send` Telegram
  notice for audits/approvals you trigger.

## Operational recommendations

- Use read-only database accounts for browsing; keep write credentials for
  connections that need them.
- Mark production connections **production**; approvals are bound to the exact
  SQL hash and are single-use.
- Rotate any credential you paste into a connection if the host is shared.
- Review `tunnel_command` changes like code.
