# Development

[← Back to the README](../README.md)

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
