# DB Desk — standalone

A TablePlus-style database browser for **PostgreSQL, MySQL/MariaDB, ClickHouse
and SQLite** that runs on your Mac without Hermes.

![DB Desk standalone](docs/img/standalone.png)

This repository is the standalone packaging of the DB Desk Hermes plugin
([wzul/dbdesk](https://github.com/wzul/dbdesk)): the same page and the same
backend adapters, wrapped in a small Tauri shell with a Python sidecar.

```
┌──────────────────────────────┐
│ Tauri (Rust)                 │
│  · spawns the sidecar        │
│  · opens a native window     │
│         │                    │
│         ▼                    │
│ http://127.0.0.1:<random>    │
│  ┌────────────────────────┐  │
│  │ Python sidecar         │  │
│  │  · FastAPI /api/*      │  │
│  │  · serves the built UI │  │
│  │  · psql / mysql / HTTP │  │
│  │  · stdlib sqlite3      │  │
│  └────────────────────────┘  │
└──────────────────────────────┘
```

## Requirements

- **Node.js 26 LTS** (or any 22.12+; the repo ships `.nvmrc`)
- **Python 3.11+**
- **Rust stable** (1.77+) and Xcode Command Line Tools on macOS
- `psql` and/or `mysql` clients for those connection types (SQLite uses the
  Python standard library)

The server binds to `127.0.0.1` only. Credentials are encrypted at rest with
AES-GCM in the app-data directory (see *Data* below) and are never returned to
the UI.

## Run from source

```bash
# dependencies
make install            # root npm, ui npm, backend pip

# build the page and start the server (opens http://127.0.0.1:8765)
make server

# or run the desktop shell in development (spawns the Python server itself)
npm run app
```

`npm run app` needs Rust and the Tauri system dependencies. On macOS that is
Xcode Command Line Tools; on Linux see the Tauri prerequisites.

### UI-only development

```bash
python backend/app.py              # terminal 1 — API on :8765
npm --prefix ui run dev            # terminal 2 — Vite on :5173, proxies /api
```

## Build the macOS app

```bash
make sidecar        # PyInstaller one-file server -> src-tauri/binaries/
npm --prefix ui run build
npm run tauri build # -> src-tauri/target/release/bundle/dmg/*.dmg
```

The sidecar is a PyInstaller **onedir** tree (no unpack on launch). Tauri ships
it as a bundle resource, so it lands in
`DB Desk.app/Contents/Resources/sidecar/dbdesk-server/`. The Rust shell shows a
splash window immediately, starts the sidecar on a free localhost port, waits
until it accepts connections, then navigates the same window to it. The child is
killed on exit. The splash is `ui/public/splash.html`.

The GitHub Actions workflow builds both architectures on every push:

- `macos-13` → `x86_64-apple-darwin` (Intel)
- `macos-14` → `aarch64-apple-darwin` (Apple Silicon)

Unsigned DMGs run after a right-click → **Open**. For distribution, add the
usual signing/notarization secrets (`APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID`); Tauri picks them up automatically.

## Performance

- **Persistent connections.** PostgreSQL uses `psycopg` and MySQL/MariaDB uses
  `PyMySQL` when installed, keeping one pooled connection per configured
  connection (serialized with a per-connection lock). Measured against local
  containers, a table page dropped from ~95 ms to ~1.6 ms per call. The
  `psql`/`mysql` CLIs remain as a fallback when the drivers are missing (the
  Hermes runtime does not ship them).
- **Column metadata cache.** `/columns` and `/table/rows` share a 60-second
  cache with in-flight coalescing, so a table open runs one metadata query
  instead of two and repeat views never touch the database.
- **Fast launch.** The sidecar is a onedir build (no extraction) and the splash
  window appears immediately while the backend starts.
- **Statement timeouts** are set on the session (`statement_timeout` /
  `MAX_EXECUTION_TIME` / `max_statement_time`), so a runaway query cannot block
  the UI forever.

## Updates

The app checks GitHub Releases for a signed update manifest when it opens.
When a newer version exists, the picker shows **Update available — vX**;
**Update now** downloads the `.app.tar.gz`, verifies the minisign signature,
replaces the bundle and relaunches.

- No Apple Developer account is involved: the updater uses its own minisign
  keypair. The public key is in `src-tauri/tauri.conf.json`; the private key
  lives only in the `TAURI_SIGNING_PRIVATE_KEY` CI secret.
- Releases are published by `.github/workflows/release.yml` when a `v*` tag is
  pushed; it reuses the successful `main` build and writes `latest.json`.
- The first build with the updater (0.7.1) must be installed manually once;
  later versions update in place.
- Manifest URL:
  `https://github.com/wzul/dbdesk-app/releases/latest/download/latest.json`

## Data

| Platform | Location |
|---|---|
| macOS | `~/Library/Application Support/DB Desk/data` |
| Linux | `~/.local/share/dbdesk/data` (`$XDG_DATA_HOME`) |
| Windows | `%APPDATA%\DB Desk\data` |

Set `DBDESK_HOME` to override. The directory contains:

- `connections.json` — connections, passwords AES-GCM encrypted
- `vault.key` — the 32-byte key (0600)
- `audit.jsonl`, `approvals.json`, `queries.json`, `views.json`

## What works

- **MCP server for local agents** — Settings → **MCP server** exposes DB Desk
  to Claude Desktop, Cursor, Hermes or any MCP client over stdio or loopback
  HTTP. Tools cover connections, databases, tables, columns, indexes, DDL,
  rows, CSV, SQL and the AI agent. Disabled by default; one toggle generates a
  bearer token.
- **Settings (⌘,)** — one preferences window: updates, native notification
  toggle + test, MCP server, AI provider (base URL/model/key), application-data
  path and version. Open it with **⌘,**, the gear on the picker, or the gear in
  the app header.
- **AI setup assistant** — **AI setup** on the picker: describe the database
  (“MySQL on my VPS behind a bastion”) and the agent returns a field-by-field
  draft; **Use this setup** opens the form prefilled. Passwords are never sent:
  the draft is sanitized server-side and the form leaves the password blank.
- **Ask AI (read-only)** — the header **AI** button opens a prompt bar. It sends
  the current table/column names and your question to an OpenAI-compatible
  endpoint (OpenAI, OpenRouter, Ollama, LM Studio, ...), receives one SELECT,
  runs it read-only and shows the SQL and rows. The panel is a **chat**: press
  Enter, read the result, then type a follow-up (“pecahkan ikut bulan”) and the
  previous SQL/answers are carried into the next request. If a statement fails
  (for example a wrong column name), the error and the relevant schema are sent
  back once so the model can correct the query. Server-side rules refuse any non-read
  statement. Configure base URL, model and API key under the AI
  settings; the key is encrypted at rest and row data is never sent.
- **Multi-database agent** — the AI scope bar defaults to every AI-enabled
  connection. When a question spans databases (“who is in app-db but not the
  warehouse?”) the agent first requests the missing schemas, then returns one
  read-only statement per database plus a join. DB Desk runs each statement
  against its own database, loads the result sets into an in-memory SQLite
  database and executes the join **locally**. Only schema names, SQL, row
  counts and error text go to the provider — never the rows. Each answer shows
  the per-source SQL (copy, or open in SQL when it is the current connection),
  the local join, the merged table and a short step log.
- **Per-connection AI switches** — in the connection form, turn off **AI can
  see this schema** to hide a database from the agent entirely, or turn off
  **AI can run read-only queries** to keep it inspect-only. Statements run by
  the agent are written to the audit log.
- **Docked AI and record panels** — the AI chat opens on the right without
  covering the grid; clicking a row number opens a TablePlus-style **Record**
  panel on the right with each column name, type and value.
- **Connection picker** — the app opens on a TablePlus-style list: search,
  groups, type icons, read-only/PROD badges; pick a connection, then the full
  browser opens. Right-click a connection for **Open / Edit / Test / Export /
  Delete**. **New connection** goes straight to the form, and the chevron
  in the header returns to the list.
- **Import / export & QR** — export one connection from the share icon or all of
  them from the picker as a `.dbdesk` bundle. Passwords are left out by default;
  tick **Include passwords** to encrypt them with a passphrase (scrypt +
  AES-GCM). Import accepts a file, pasted bundle or `dbdesk://` link, shows a
  preview, then merges with new ids. **Show QR** renders a scannable code for a
  single connection (QR capacity is limited, so large bundles fall back to the
  file/copy).
- Everything the plugin page does:

- connections (Postgres, MySQL/MariaDB, ClickHouse, SQLite) with SSH tunnels,
  custom tunnel commands, MCP query tools and HTTP gateways
- schema tree, typed data grid, inline editing, filters, tabs, saved views
- SQL runner, autocomplete, formatter, history, saved queries, charts
- schema DDL, cross-connection diff, add/drop/rename column, index editor
- CSV import and whole-table export
- serialized-PHP tools and the WordPress Site tab
- read-only guard, production approvals and the write audit log
- Activity drawer

Notes for the standalone build:

- **Native macOS notifications** — approval requests and production writes show
  a system notification while the app is running. Nothing is sent to Telegram or
  any external service. Approve writes in the **Approvals** drawer; test with
  **Settings → Notifications → Test**.
  Because the build is ad-hoc signed (no Apple Developer ID), macOS ties the
  notification permission to the current signature and drops it after every
  update. Open **System Settings → Notifications → DB Desk**, enable it and
  choose **Alerts**; the Settings panel has a shortcut plus diagnostics. The
  **Fallback** test posts through Script Editor for setups where native delivery
  still fails. With a Developer ID build the permission survives updates.
- **MCP connections work directly.** Add the streamable-HTTP endpoint
  (e.g. `https://mcp.example.com/mcp`), the tool name and SQL argument,
  then **Authorize**: DB Desk runs OAuth 2.1 with PKCE through a loopback
  redirect, opens the system browser, stores the tokens encrypted and refreshes
  them automatically. No token pasting. Unauthenticated MCP servers also work;
  Hermes-style named MCP servers still work in the plugin.
- SQLite needs the file on this machine (no upload).

## Tests

```bash
npm --prefix ui run build
python -m unittest discover -s tests -v
```

The smoke test drives the real FastAPI app with an in-memory/temporary SQLite
database, so no server is required.

## Layout

```
backend/app.py            FastAPI app: /api/* + static UI + /health
backend/dbdesk_api.py     adapters (standalone copy of the plugin backend)
backend/dbdesk-server.spec PyInstaller one-file build
ui/src/plugin.js          DB Desk page (same file as the Hermes plugin)
ui/src/sdk-shim.jsx       the few Hermes SDK pieces the page imports
ui/src/main.jsx           shell: connection picker vs the page, toasts, theme
ui/src/launcher.jsx       TablePlus-style connection list
src-tauri/                Tauri v2 shell, config, icons, capabilities
src-tauri/sidecar/        staged onedir sidecar (gitignored, built by script)
scripts/build-sidecar.sh  PyInstaller onedir -> src-tauri/sidecar/dbdesk-server/
tests/test_standalone.py  server smoke tests
```

`ui/src/plugin.js` and `backend/dbdesk_api.py` are copies; the sync script
refreshes them from a local Hermes checkout:

```bash
scripts/sync-plugin.sh /path/to/.hermes/plugins/dbdesk
```

## Signing & notarization (macOS, optional)

The default CI builds are **unsigned** and free: they run on your own Mac after
the steps below. Signing + notarization is only needed for clean distribution to
other people, and requires a paid Apple Developer account.

### Install an unsigned build (no Apple Developer account)

**Build it on the Mac that will run it** — locally built apps are not
quarantined, so Gatekeeper does not complain at all:

```bash
git clone https://github.com/wzul/dbdesk-app
cd dbdesk-app
make install          # Node, Python deps
make bundle           # Python + Rust toolchain required
open "src-tauri/target/release/bundle/macos/DB Desk.app"
```

**Or download the CI DMG**, drag **DB Desk** to Applications, then:

- macOS 15+: open it once, then **System Settings → Privacy & Security → Open
  Anyway**; or
- remove the quarantine flag:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/DB Desk.app"
  ```

Only do this for a build you trust (this repository's CI or your own).

### What you need

1. **Apple Developer Program** membership (paid, currently US$99/year).
2. A **Developer ID Application** certificate — not “Apple Development”.
3. Your **Team ID** (developer.apple.com → Membership).
4. Notarization credentials: either an **app-specific password** for your Apple
   ID, or an **App Store Connect API key**.

### Create the certificate

On a Mac, either:

- Xcode → Settings → Accounts → select your team → **Manage Certificates** → **+**
  → **Developer ID Application**, or
- developer.apple.com → Certificates, Identifiers & Profiles → **+** →
  **Developer ID Application** (upload a CSR made with Keychain Access).

Then export it: Keychain Access → **My Certificates** → right-click
`Developer ID Application: …` → **Export** → `.p12` with a password.

```bash
security find-identity -v -p codesigning
# "Developer ID Application: Your Name (ABCDE12345)"
```

### Add the GitHub secrets

```bash
# certificate (.p12) as base64
base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE
gh secret set APPLE_CERTIFICATE_PASSWORD   # the .p12 password
gh secret set APPLE_SIGNING_IDENTITY --body "Developer ID Application: Your Name (ABCDE12345)"
gh secret set APPLE_TEAM_ID --body "ABCDE12345"

# notarization: Apple ID + app-specific password (appleid.apple.com → Sign-in
# and Security → App-Specific Passwords)
gh secret set APPLE_ID --body "you@example.com"
gh secret set APPLE_PASSWORD
```

API-key alternative (better for CI, no password/2FA):

```bash
gh secret set APPLE_API_ISSUER --body "<issuer-uuid>"
gh secret set APPLE_API_KEY --body "<key-id>"
# write AuthKey_<key-id>.p8 from a secret to a file before the build step
```

Tauri reads these environment variables directly; the workflow already passes
them through, and only signs when `APPLE_SIGNING_IDENTITY` is set.

### What the workflow does

1. Imports the `.p12` and signs `dbdesk-server` on its own with hardened runtime
   and the entitlements below (nested binaries must be signed before notarizing
   the app).
2. `tauri build` signs `DB Desk.app` (hardened runtime), notarizes it with
   `notarytool`, and staples the ticket.
3. Verifies with `codesign` and `spctl`.
4. Produces `DB Desk_<version>_<arch>.dmg`.

### Entitlements

`src-tauri/entitlements.plist` disables **library validation**:

```xml
<key>com.apple.security.cs.disable-library-validation</key>
<true/>
```

The Python sidecar is a PyInstaller one-file binary. On launch it extracts its
dylibs to a temp directory and `dlopen()`s them. Hardened runtime (required for
notarization) refuses to load libraries not signed by the same Team ID, so
without this entitlement the notarized app starts and then the backend dies.
`com.apple.security.cs.allow-unsigned-executable-memory` covers Python
extensions that map executable memory at runtime.

### Verify a build

```bash
codesign --verify --deep --strict --verbose=2 "DB Desk.app"
codesign -dv --verbose=4 "DB Desk.app"     # TeamIdentifier + hardened runtime
spctl --assess --type execute --verbose=2 "DB Desk.app"   # accepted / notarized
xcrun stapler validate "DB Desk.app"
```

If the DMG itself is not stapled (the app inside is), submit and staple it once:

```bash
xcrun notarytool submit "DB Desk_0.1.0_aarch64.dmg" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD" --wait
xcrun stapler staple "DB Desk_0.1.0_aarch64.dmg"
```

### Local signed build

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
export APPLE_ID="you@example.com" APPLE_PASSWORD="app-specific-password" APPLE_TEAM_ID="ABCDE12345"
make bundle
```

Keep the `.p12` and passwords out of the repo; the certificate can be revoked
from developer.apple.com if it leaks.

## MCP server

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

### Security

- The HTTP endpoint binds to the app's loopback socket only.
- Requests require the bearer token; rotate it from Settings at any time.
- Tool results never include passwords, API keys or SSH material.
- Disable the server (or quit the app) and both transports stop immediately.

## AI privacy

- **Prompts are built from allowlists, not connection records.** Data questions
  send table/column names, the question and previous SQL only — never rows,
  passwords, tokens, SSH keys, headers or tunnel env. The agent catalog carries
  only id, display name, group, kind and database name; hosts and users are
  omitted.
- **Cross-database rows stay local.** Result sets are loaded into in-memory
  SQLite and joined on this Mac. The join query and row counts are visible to
  the model; the cell values are not.
- **AI setup** sends only your message and generic instructions. The returned
  draft is sanitized: keys containing `password`, `token`, `secret`, `key`,
  `header`, `env`, `auth` or `cookie` are dropped.
- **Secrets at rest** stay AES-GCM encrypted and are decrypted only to open the
  database connection.
- **Local-only option**: point the base URL at Ollama/LM Studio on
  `127.0.0.1` and nothing leaves the Mac.
- The test suite asserts that a saved password never appears in an AI payload
  and that setup drafts cannot carry secrets.

## Security

DB Desk executes SQL with the credentials you configure, and a custom tunnel
command is a shell command you supply. Treat a connection as code execution on
this machine. Read-only is the default and enforced by the backend, but it is a
guardrail, not a sandbox.

## License

MIT.
