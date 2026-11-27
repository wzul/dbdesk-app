# Privacy statement

**Short version: there is no DB Desk account, no DB Desk server, and no telemetry. We
do not collect anything about you, because there is nowhere for it to go.**

This covers the desktop app, the optional server mode, and `dbdesk.app`.

## What stays on your machine

| Data | Where | Notes |
|---|---|---|
| Connections (hosts, users, options) | `connections.json` in the app data folder | mode `0600`, owned by your user |
| Passwords, keys, tokens | same file, AES-256-GCM encrypted | vault key alongside it, mode `0600` |
| Audit log of executed statements | `audit.jsonl` in the same folder | what ran, on which connection, when |
| Production approvals | `approvals.json` | single-use, bound to a SQL hash |
| UI preferences | local storage of the app window | theme, layout, which connection was last open |

The app data folder is the per-user configuration directory of your platform
(`~/Library/Application Support/…` on macOS, `%APPDATA%\…` on Windows, `~/.local/share/…`
on Linux), or whatever `DBDESK_HOME` points at.

## What leaves your machine

Only what you configure:

1. **Your database.** Queries go to the host you entered. If you set up an SSH tunnel,
   traffic goes through your own SSH server.
2. **Your AI endpoint — only if you add a key.** No key, no AI, no calls. The payload
   carries table and column names, types, your question and the current SQL. It never
   carries rows, result sets, passwords, tokens, SSH material or headers. Point the base
   URL at Ollama or LM Studio on `127.0.0.1` and nothing leaves the machine at all.
3. **The updater.** A check against `github.com` for the signed release manifest. Install
   is gated on a signature that the app verifies with a pinned public key. Automatic
   updates can be switched off in Settings; the check itself can be avoided by running a
   build with the updater disabled.

Nothing else. There is no analytics SDK, no crash reporter, no usage ping, no advertising
identifier, and no server of ours that the app talks to. You can verify this with
`scripts/egress-check.py` in the repository, or with any network monitor.

## Server mode

`DBDESK_SERVER=1` runs the same build as a single-tenant web app **on your own machine or
VPS**. In that mode:

- your browser talks to your server; the credentials stay in that container's data
  directory,
- sessions live in memory, so a restart signs everyone out,
- login attempts are counted per client address and throttled,
- access logs are whatever your own reverse proxy writes — we never see them.

We do not operate a multi-tenant DB Desk service, and your connections are never sent to
one.

## Cookies and the website

`dbdesk.app` is a static site. It sets no cookies, runs no analytics script of its own, and
has no sign-in. Cloudflare serves it and may keep its own request logs as any CDN does;
that is Cloudflare's processing, not ours, and covers HTTP metadata rather than your
database.

## Deleting your data

Everything is local, so deleting is local:

- **In the app:** delete a connection, or clear the AI key in Settings.
- **Files:** remove the app data folder (see above). That removes connections, the vault,
  the audit log and approvals in one go.
- **Uninstalling** the app removes the binary; the data folder is left behind on purpose,
  so an upgrade or reinstall keeps your connections. Delete it by hand to start clean.

## Changes

This statement lives in the repository, so its history is the changelog. Material changes
are noted in the release notes of the version that ships them.

Questions: open an issue at
<https://github.com/wzul/dbdesk-app/issues>, or use the private advisory form in
[SECURITY.md](SECURITY.md) if the question is itself sensitive.
