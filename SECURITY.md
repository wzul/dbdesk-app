# Security policy

DB Desk runs SQL with the credentials you give it, so a bug here can reach a real
database. Reports are welcome and taken seriously.

## Reporting a vulnerability

Use GitHub's private advisory form — it is the only channel that stays private until a
fix ships:

**https://github.com/wzul/dbdesk-app/security/advisories/new**

The same contact is published at <https://dbdesk.app/.well-known/security.txt>
(RFC 9116). Please do not open a public issue, and do not test against a database you
do not own.

A useful report contains:

- the version (`Settings → About`, or the file name of the download) and the platform,
- the database kind involved (PostgreSQL, MySQL, ClickHouse, SQLite, MongoDB, Redis,
  MCP, HTTP) if the bug is driver-specific,
- what an attacker gains — the difference between "the UI shows a stray tooltip" and
  "a crafted table name escapes the read-only guard" decides how fast it gets fixed,
- the smallest reproduction you can manage.

## What is in scope

- The desktop app and its Tauri shell (`src-tauri/`).
- The local sidecar API (`backend/`): authentication, CSRF, the read-only guard, the
  production-approval check, tunnel handling, path handling.
- The AI payload builder — anything that sends more than schema, SQL and your question.
- The credential vault: encryption, file modes, key handling.
- The updater path: signature verification, the manifest fetch.
- The plugin (`plugin/`) and the MCP server.
- The build and release pipeline in `.github/workflows/`.

## What is out of scope

- The security of your own database, its grants, or your network.
- Anything that already requires code execution on the host as your user — a local
  SQLite file you can edit, for example.
- Vulnerabilities in a dependency that the upstream project has not fixed and that the
  app cannot mitigate; send those upstream, and tell us if the app should pin.
- Missing hardening headers on `dbdesk.app` that have no practical effect.
- Reports produced only by an automated scanner with no demonstrated impact.

## What happens next

- Acknowledgement: best effort, usually within a few days. This is a small project, not
  a company with a rota.
- A confirmed issue gets a fix in the next release and a line in the changelog; you are
  credited unless you ask not to be.
- There is no bug bounty. Please do not spend money finding bugs here expecting a
  payout.

## Safe harbour

If you keep to the scope above, test only against your own instances, do not exfiltrate
data beyond what a proof of concept needs, and give us a reasonable window before
disclosure, we will not pursue the report and will say so in writing if you need it.

## Known gaps

Published deliberately, because a policy that only lists strengths is marketing:

- Windows installers are not code-signed yet, so SmartScreen may warn; compare the
  SHA-256 in `SHA256SUMS.txt` against the download.
- `SHA256SUMS.txt` is not yet signed independently of GitHub.
- Updates are verified by the Tauri updater's pinned minisign key; the manifest itself
  is fetched from GitHub Releases.
