# Security & privacy

[← Back to the README](../README.md)

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
