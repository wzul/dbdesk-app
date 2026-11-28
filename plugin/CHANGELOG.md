# Changelog

## 0.8.13

- Keyboard navigation in the tree and the data grid: one tab stop per pane, arrow keys to move,
  Home/End for the ends of a row, PageUp/PageDown, and Ctrl+C to copy the focused cell. Opening a
  database or a table no longer needs the mouse.
- Settings and the shortcut sheet are real dialogs: focus moves in, Tab stays inside, Escape closes
  and focus returns to the control that opened them.
- A page of rows can now be 1000 or 2000 rows (the grid virtualises above 100), so the page-size
  picker offers both.

## 0.8.11

- AI autocomplete now defaults to **on** once an AI provider is configured; turn it off under AI provider settings if you do not want it.

## 0.8.10

- **Detect models**: enter the base URL and API key, press **Detect models** and pick from the provider's model list instead of typing the name (with **Type** to fall back to a custom model).
- **AI autocomplete (opt-in)**: enable it in the AI panel settings, then press **⌘I** in the SQL editor. The configured provider returns a continuation at the caret; **Tab** inserts it, **Esc** dismisses it.
- Sends only the SQL text plus dialect, database name and referenced table/column names and types — never rows, passwords or tokens.
- New `POST /ai/models` and `POST /ai/complete` endpoints; `ai_complete` is stored with the AI config and rejected server-side when off.

## 0.8.9

- Alias-aware SQL autocomplete: typing `c.` lists the columns of the table aliased `c`, and columns from every table referenced in `FROM`/`JOIN` are suggested.
- Fuzzy matching with ranked results across keywords, tables, columns and functions, plus a detail label showing the source table/schema.
- `⌘Space` / `Ctrl+Space` opens the suggestion list manually; `⌘Space` at the end of a line no longer requires 2 typed characters.

## 0.8.8

- Export the current table as **CSV**, **JSON** or **SQL INSERTs** from the table right-click menu or the **More** menu; exports respect active filters and sort.
- Table right-click menu: **Open**, **Export as CSV/JSON/SQL**, **Copy name** and **Delete table…** (write-enabled SQL connections).
- **Quick panel** (`⌘P` / `Ctrl+P`): jump to tables, views, schemas, functions or connections, or run actions such as new SQL tab, toggle theme, settings and close connection.
- SQL editor syntax highlighting for keywords, strings, numbers, comments and function calls.
- JSON/JSONB cells open a large editor modal with **Format**, **NULL**, Cancel and Save.
- New `POST /table/export`, `POST /table/drop` and `GET /connections/{id}/functions` endpoints.

## 0.6.12

- Table tabs are flat underline tabs instead of boxed chips.
- Navigating between tables replaces the current tab while it is pristine (no filters/sort/limit/column changes); a new tab opens only after a modification.

## 0.6.11

- Right-click a connection → **Clone connection**: duplicates it with encrypted credentials, flags and settings, named "(copy)".

## 0.6.10

- Header gives the connection name `flex-1` (no more "C.."), hides the host line below 2xl, and drops the competing spacer; the full name stays readable.

## 0.6.9

- Connection rail: open connections as a compact icon rail; click to switch, right-click to remove, `+` opens the picker.
- Open database dialog from the header/rail database icon: search databases, Open or New.
- The full connections list no longer takes sidebar space.

## 0.6.8

- Data toolbar is one compact row: secondary actions are icon-only and Export/Copy/Chart/Import live in a More menu; no wrapping.

## 0.6.7

- ClickHouse header edit form lists saved header names (values stay encrypted) and states that new lines replace the saved set.

## 0.6.6

- ClickHouse/HTTP requests send a browser User-Agent by default, avoiding Cloudflare Bot Fight Mode error 1010; custom `User-Agent` headers override it case-insensitively.

## 0.6.5

- HTTPS requests from ClickHouse and HTTP gateway connections use the bundled certifi CA store, fixing `CERTIFICATE_VERIFY_FAILED` in the packaged app.

## 0.6.4

- ClickHouse: port 443 implies https when SSL mode is `prefer`, so Cloudflare/HTTPS endpoints do not receive a plain HTTP request.

## 0.6.3

- ClickHouse: a full `https://host[:port][/path]` in the Host field is accepted and normalized (443 + require for https); clearer request errors include the resolved URL.

## 0.6.2

- Generate a dialect-correct SELECT from the current table, enabled filters, order and limit; preview with Copy / Open in SQL.

## 0.6.1

- ClickHouse: optional HTTP path and encrypted custom HTTP headers (Cloudflare Access service tokens, API gateway headers).

## 0.6.0

- Schema tab is a structure grid (columns with charset, collation, nullable, default, extra, FK, comment; index grid) instead of a DDL block; DDL moved to a button.
- Multi-row filter panel with per-row enable checkbox, Apply, Apply all and disabled-filter skipping in WHERE.
- SQL toolbar: Save / Saved query buttons.
- Backup & restore endpoints for connections + saved views + saved queries (optional encrypted passwords).
- Preference storage for notifications and appearance.

## 0.5.0

- **Multi-database AI agent**: `/ai/catalog` + `/ai/agent`; the agent inspects schemas on demand, plans one read-only statement per database (max 3) and a SQLite join.
- Result sets are joined locally in in-memory SQLite; only schema, SQL, row counts and errors reach the provider.
- AI panel scope bar (all / current / none), per-source SQL blocks, local-join block, merged result and step log.
- Per-connection **AI can see this schema** and **AI can run read-only queries** switches; inspect-only mode.
- Agent reads (`ai_read`) go to the audit log; no production notification for reads.

## 0.4.0

- AI setup assistant on the picker: describe a database and get a field-by-field draft; secrets are stripped server-side.
- Settings (⌘,): updates, native notifications + test, AI provider, data path.

## 0.3.5

- Conversational replies without SQL.

## 0.3.4

- Cursor-style AI chat panel: thread, thought line, SQL block, composer.

## 0.3.3

- AI chat with history (multi-turn), read-only SQL.

## 0.2.0

- **SQLite** connections: open a local `.db` file (path instead of host/port), read-only via `mode=ro`.
- SQLite schema tree (`sqlite_master`), typed columns (`PRAGMA table_info`), indexes, DDL, inline edit/insert/delete, filters, CSV import/export, add/drop/rename column, index create/drop.
- SQLite statements run one at a time inside a transaction (stdlib `sqlite3`); BLOBs render as UTF-8 text or hex.
- Connection form: SQLite hides host/port/user/password/SSL/SSH and asks for a **Database file**.
- Activity drawer shows a SQLite-specific note (no server sessions).

## 0.1.0

First public release.

- Connections: PostgreSQL, MySQL/MariaDB, ClickHouse, MCP query tools, HTTP query gateways.
- SSH tunnel and custom tunnel command (SSM, cloudflared, bastion scripts) with `tunnel_env`.
- Encrypted credentials (AES-GCM) and 0600 connection store.
- Schema tree, DB switcher, per-database labels with WordPress auto-detect.
- Data grid: tabs, typed inline editors, insert/delete, row filters (case-insensitive contains), saved views, column show/hide, row detail, virtualized rows, Load more, copy/multi-select.
- SQL: autocomplete, formatter, history, saved queries, CSV, charts.
- Schema: DDL, cross-connection diff, add/drop/rename column, index editor.
- CSV import and whole-table export.
- Serialized-PHP parse/fix; WordPress Site tab.
- Production approvals (Telegram notice + Approvals), audit log, read-only guard.
- Activity monitor.
- Agent tools `db_connections`, `db_query` (read-only).
