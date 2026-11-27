# Security & privacy

[← Back to the README](../README.md) · [Threat model](#threat-model) ·
[What leaves your machine](#what-leaves-your-machine-measured) ·
[Report a vulnerability](../SECURITY.md) · [Privacy statement](../PRIVACY.md)

A reader-facing summary lives at <https://dbdesk.app/security/>; this file is the
technical version, and it lists the gaps as well as the controls.

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
- **AI autocomplete** is **on by default** once an AI provider is configured;
  turn it off at **Settings → AI provider → AI autocomplete**. When you press
  **⌘I**, it sends the SQL text around the caret plus dialect,
  database name and the table/column names and types referenced in the query.
  It never sends rows, result sets, passwords, API keys, SSH material or tunnel
  env, and the server rejects the request unless the toggle is on.
- **Model detection** calls `GET <base URL>/models` with your API key to list
  model names. The key stays on this Mac; only the model IDs are shown.
- **Secrets at rest** stay AES-GCM encrypted and are decrypted only to open the
  database connection.
- **Local-only option**: point the base URL at Ollama/LM Studio on
  `127.0.0.1` and nothing leaves the Mac.
- The test suite asserts that a saved password never appears in an AI payload
  and that setup drafts cannot carry secrets.

## What leaves your machine (measured)

| What you do | Outbound network |
|---|---|
| Open the app, browse the tree, view tables | none |
| Run a query, edit a row, export CSV | none |
| Save or edit a connection | none |
| Use AI (only once a provider key is configured) | your endpoint: `api.openai.com`, your own gateway, or Ollama on `127.0.0.1` |
| Check for updates | `github.com`, for the signed release manifest |

Measured against 0.13.12 with `scripts/egress-check.py`: a session that created a
connection, opened a table, ran an aggregate query and opened Settings issued **35 HTTP
requests, all to `127.0.0.1`**, and the backend held **no outbound TCP connection**. The
script drives the real UI, so the measurement can be repeated on any build.

## Threat model

**What DB Desk is trusted with.** Database credentials; the authority of the user the
database connection runs as; whatever the user types into the SQL editor; a shell command
if an SSH tunnel is configured.

**Trust boundaries.**

1. *Your machine* — everything under the app data folder is readable by your user, and so
   is the vault key next to it. Encryption at rest protects a copied file, a stray backup
   or a sync client; it does not protect against code running as you.
2. *The UI* — treated as untrusted by the backend. Read-only, statement limits and
   production approvals are enforced in the API, not in the browser. The UI is served
   over loopback and, in server mode, behind a login with CSRF tokens.
3. *Outbound* — the database, an optional AI endpoint, and the updater. Nothing else; see
   the table above.
4. *The model provider* — sees schema, SQL and your question. Never rows, never secrets.

**In scope for an attacker model.** A malicious database or a hostile server on the other
end of a connection (crafted table names, absurd column counts, slow queries); a stolen
laptop with the data folder on it; a compromised AI endpoint returning malicious drafts; a
tampered update manifest.

**Explicitly not defended against.** Malware already running as your user (it can read the
vault key and the audit log); an operator pasting `DROP TABLE` into a connection whose user
has the right to run it; a database user with more privilege than the task needs.

## Security

DB Desk executes SQL with the credentials you configure, and a custom tunnel
command is a shell command you supply. Treat a connection as code execution on
this machine. Read-only is the default and enforced by the backend, but it is a
guardrail, not a sandbox. The strongest control available to you is the database user
itself: a `GRANT SELECT`-only role makes every guardrail above redundant, and the app runs
normally that way.

