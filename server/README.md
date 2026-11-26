# DB Desk Server (self-hosted)

The same DB Desk, running on a host you control and reachable from a browser.
One container, one operator, one password.

```bash
# from the repository root
export DBDESK_SERVER_PASSWORD='pick-something-long'
docker compose -f server/docker-compose.yml up -d --build
# → http://127.0.0.1:8080  (put your TLS terminator in front)
```

The first boot hashes the password into the `dbdesk-data` volume
(`/data/server.json`); later boots reuse it, so you can drop
`DBDESK_SERVER_PASSWORD` from the environment once the volume exists. Sessions
live in memory, so restarting the container signs everyone out.

## What changes versus the desktop app

| | Desktop app | Server mode |
|---|---|---|
| Who can reach the API | anything on the loopback interface | a logged-in session only |
| Writes | straight through | require the `X-DBDesk-CSRF` header that matches the cookie |
| Login throttling | n/a | 10 failures per address per 15 minutes |
| SSH tunnels, custom tunnel commands | on | **off** unless `DBDESK_ALLOW_TUNNELS=1` |
| SQLite / local file paths | on | **off** unless `DBDESK_ALLOW_LOCAL_FILES=1` |

Those two gates exist because the features are safe on your own machine and not
on a shared host: an SSH tunnel is an outbound connection the server makes on
your behalf, and a SQLite path is an arbitrary local file read.

Still true on the server: read-only is the default per connection, production
writes ask for approval, secrets are AES-GCM encrypted at rest, and AI requests
carry SQL and schema names only.

## TLS

Terminate TLS in front (Caddy, Traefik, nginx) and forward to the container.
Cookies are marked `Secure` when the request arrives with
`X-Forwarded-Proto: https`, so make sure your proxy sets it — otherwise the
cookie is still HttpOnly but will not be restricted to HTTPS.

## Not in this image (deliberately)

- multi-user accounts, per-account connection scopes, audit export
- the MCP server (it binds loopback for local agents)
- the auto-updater (there is nothing to update — pull a new image)

Everything in that list is a planned follow-up, in that order.
