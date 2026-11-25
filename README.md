# DB Desk — standalone

A TablePlus-style database browser for **PostgreSQL, MySQL/MariaDB, ClickHouse,
SQLite, MongoDB and Redis/Valkey** — a native Mac app, no Hermes required.

![DB Desk](docs/img/standalone.png)

DB Desk is a small Tauri shell around a local Python sidecar (FastAPI). The
sidecar serves the UI and talks to your databases; nothing leaves the Mac.

## Download

[**Latest release**](https://github.com/wzul/dbdesk-app/releases/latest) · macOS 13+ ·
Apple silicon and Intel · ad-hoc signed

1. Open the DMG and drag **DB Desk** into **Applications**.
2. The first launch is ad-hoc signed: right-click the app → **Open** once.
3. Updates are signed and delivered in-app (Settings → Updates).

## Quick start

1. **New connection** — choose PostgreSQL, MySQL/MariaDB, ClickHouse, SQLite,
   MongoDB, Redis/Valkey, MCP or an HTTP gateway. Add an SSH tunnel or a custom
   tunnel command if the database is private.
2. **Pick a table** — the grid loads with a sticky header, resizable columns and
   a bottom **Data / Structure** switcher.
3. **Work** — double-click a cell to edit, **⌘F** to filter, **⌘T** for a new SQL
   tab, **⌘R** to refresh, **⌘,** for settings, **⌘/** for the shortcut list.

The picker remembers the last connection, so **Continue where you left off**
takes you straight back after a relaunch.

## Beyond TablePlus

DB Desk follows the TablePlus model and adds workflows that normally need a
second tool (or a hand-written query):

- **Reveal encrypted columns in place** — store a per-connection AES key
  (raw, `base64:` Laravel `APP_KEY`, or passphrase) and name the encrypted
  columns. AES-256-GCM/CBC envelopes are detected and decrypted in the grid
  behind a **Decrypt** toggle. The key stays encrypted at rest and never goes
  to the AI.
- **Browse in your timezone** — set a display timezone and how naive timestamps
  are stored (`UTC` by default). `timestamp without time zone` and `timestamptz`
  render in your zone, and filter values are converted back automatically.
- **MongoDB and Redis/Valkey next to SQL** — collections, documents, keys, a
  value drawer and a command console share the same read-only guards, production
  approvals and audit trail as your SQL tables.

The full list is in [Features](docs/features.md).

## Documentation

| Guide | What is inside |
|---|---|
| [Getting started](docs/getting-started.md) | Requirements, run from source, build the macOS app, updates, data. |
| [Features](docs/features.md) | Connections, grid, filters, SQL tabs, AI, MCP, desktop integration. |
| [MCP server](docs/mcp.md) | Expose DB Desk to agents; tools, approvals, writes, access model. |
| [Security & privacy](docs/security.md) | Trust model, secrets, AI privacy, permissions. |
| [Development](docs/development.md) | Performance, tests, repository layout. |
| [Signing & notarization](docs/signing.md) | Ad-hoc signing, notarization, CI secrets. |
| [Troubleshooting](docs/troubleshooting.md) | MCP errors, MySQL over MCP, notifications, Cloudflare. |

## Development

```bash
make install            # root npm, ui npm, backend pip
make server             # build the page and serve http://127.0.0.1:8765
npm run app             # desktop shell (Rust + Tauri)
```

Tests: `.venv/bin/python -m unittest discover -s tests`. See
[Development](docs/development.md).

## Security

Read-only is the default. Every write shows the exact SQL; production
connections require an explicit confirmation and approval; secrets are AES-GCM
encrypted at rest; MCP binds to loopback with a bearer token. Read-only is a
guardrail, not a sandbox — see [Security & privacy](docs/security.md).

## License

MIT.
