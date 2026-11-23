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

`externalBin` in `src-tauri/tauri.conf.json` tells Tauri to place the sidecar
next to the main executable inside `DB Desk.app/Contents/MacOS/dbdesk-server`.
The Rust shell starts it on a free localhost port, waits until it accepts
connections, then opens a window pointed at it. The child is killed on exit.

The GitHub Actions workflow builds both architectures on every push:

- `macos-13` → `x86_64-apple-darwin` (Intel)
- `macos-14` → `aarch64-apple-darwin` (Apple Silicon)

Unsigned DMGs run after a right-click → **Open**. For distribution, add the
usual signing/notarization secrets (`APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID`); Tauri picks them up automatically.

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

Everything the plugin page does:

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

- **Telegram notices are off** unless `DBDESK_NOTIFY=1` and a `hermes` CLI is on
  PATH. Production approvals still work — approve them in the **Approvals**
  drawer.
- **MCP connections** need a Hermes runtime; they are listed but cannot run
  queries here. HTTP gateways work normally.
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
ui/src/main.jsx           mounts the page, toasts, light/dark
src-tauri/                Tauri v2 shell, config, icons, capabilities
scripts/build-sidecar.sh  PyInstaller -> src-tauri/binaries/dbdesk-server-<triple>
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

## Security

DB Desk executes SQL with the credentials you configure, and a custom tunnel
command is a shell command you supply. Treat a connection as code execution on
this machine. Read-only is the default and enforced by the backend, but it is a
guardrail, not a sandbox.

## License

MIT.
