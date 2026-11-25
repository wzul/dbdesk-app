# Troubleshooting

[← Back to the README](../README.md)

## ClickHouse behind Cloudflare Access

ClickHouse uses its HTTP interface, so a Zero Trust application works without a
tunnel:

1. In Cloudflare Zero Trust create a **service token** (Access → Service Auth).
2. Add a ClickHouse connection: **host** = the public hostname (a full
   `https://…` URL is accepted and normalized), **port** `443`, **SSL mode**
   `require`. An `https://` host implies `require` and port 443; port 443
   also implies https (unless SSL mode is `disable`).
3. Set **HTTP path** if the endpoint is mounted on a subpath (default `/`).
4. Paste the headers into **Custom HTTP headers**, one per line:

   ```
   CF-Access-Client-Id: <client id>.access
   CF-Access-Client-Secret: <client secret>
   ```

5. **Test**, then save.

If Cloudflare returns **error 1010** (Bot Fight Mode), it is rejecting the
`Python-urllib` browser signature. DB Desk now sends a browser User-Agent by
default; you can override it with a `User-Agent: …` line in the custom headers.

Headers are AES-GCM encrypted in the connection store; values are never returned
to the UI or AI prompts. The edit form lists the saved header **names** and an
empty box: typing new lines **replaces** the saved set, leaving it blank keeps
it, and **Remove saved headers** clears it. Headers are only included in
exports/backups when you tick **Include passwords**. `Host`, `Content-Length`, `Connection` and `Transfer-Encoding` are
rejected so the HTTP client keeps control of the transport. The same fields can
carry other proxy headers (e.g. an API gateway token).

## Common errors

**MCP: `unknown tool "query"`** — the server does not expose a tool with that
literal name. Open the connection, click **Detect tools**, and pick the tool
that runs SQL (often `<name>_query`). The tool determines the database; the
**Database** field is only a display label.

**MySQL MCP: `Error 1064 ... near 'schema'`** — fixed in 0.13.5. Update the app;
the tree aliases `schema` with backticks.

**MCP connection shows "No tables"** — check the detected **SQL dialect**
(PostgreSQL / MySQL / ClickHouse) and that the chosen tool is the read-only SQL
runner. The tree queries `information_schema`/`pg_class`, so the tool must allow
those reads.

**Notifications do not appear** — after an update macOS resets the permission.
Open **System Settings → Notifications → DB Desk** and allow alerts; then use
**Settings → Notifications → Test**.

**macOS says the app is damaged or from an unidentified developer** — the build
is ad-hoc signed. Right-click the app → **Open** once, or run
`xattr -dr com.apple.quarantine /Applications/DB\ Desk.app`.
