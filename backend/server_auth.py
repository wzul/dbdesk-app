"""Server mode: authentication, sessions and the hosted-feature gates.

DB Desk was written as a local app: the API trusts anything that reaches
127.0.0.1. `DBDESK_SERVER=1` puts it behind a login so the same process can be
hosted in a container, and turns off the two features that are safe on your own
machine but not on a shared server:

  tunnels (SSH -L / custom commands)   → DBDESK_ALLOW_TUNNELS=1 re-enables
  SQLite / local file paths            → DBDESK_ALLOW_LOCAL_FILES=1 re-enables

Everything here is deliberately dependency-free (hashlib.scrypt, secrets, no
framework beyond Starlette) so the image stays small and the surface auditable.

Threat model, stated plainly: one operator, one password, one session cookie.
It is not multi-tenant — every account that can log in sees every connection.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

from fastapi import Request

SESSION_COOKIE = "dbdesk_session"
CSRF_COOKIE = "dbdesk_csrf"
CSRF_HEADER = "x-dbdesk-csrf"
SESSION_TTL = 12 * 60 * 60          # 12 hours
LOGIN_WINDOW = 15 * 60              # 15 minutes
LOGIN_MAX_FAILURES = 10             # per client address, per window

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
PUBLIC_PREFIXES = (
    "/health",
    "/api/auth/",
    "/assets/",
    "/favicon",
    "/login",
)
PUBLIC_EXACT = {"/", "/index.html", "/manifest.webmanifest", "/sw.js"}

# Feature gates: request path → a predicate over the JSON body.
GATED_CONNECTIONS = "/api/connections"


def server_mode() -> bool:
    return os.environ.get("DBDESK_SERVER") == "1"


def tunnels_allowed() -> bool:
    return os.environ.get("DBDESK_ALLOW_TUNNELS") == "1"


def local_files_allowed() -> bool:
    return os.environ.get("DBDESK_ALLOW_LOCAL_FILES") == "1"


# --------------------------------------------------------------------------- #
# password + session storage
# --------------------------------------------------------------------------- #


def _state_path() -> Path:
    return Path(os.environ.get("DBDESK_HOME") or ".") / "server.json"


def hash_password(password: str, *, n: int = 2 ** 14, r: int = 8, p: int = 1) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=32)
    return "scrypt${}${}${}${}${}".format(
        n, r, p, salt.hex(), digest.hex()
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, digest_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        digest = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt_hex),
            n=int(n), r=int(r), p=int(p), dklen=len(digest_hex) // 2,
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except Exception:
        return False


def load_state() -> dict[str, Any]:
    path = _state_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def save_state(state: dict[str, Any]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def configured_password_hash() -> str:
    """Explicit hash wins, then a plain password from the environment, then disk.

    A plain `DBDESK_SERVER_PASSWORD` is hashed once and written to server.json, so
    a container restart does not invalidate existing sessions.
    """
    explicit = (os.environ.get("DBDESK_SERVER_PASSWORD_HASH") or "").strip()
    if explicit:
        return explicit
    state = load_state()
    if state.get("password_hash"):
        return state["password_hash"]
    plain = os.environ.get("DBDESK_SERVER_PASSWORD") or ""
    if plain:
        hashed = hash_password(plain)
        state["password_hash"] = hashed
        save_state(state)
        return hashed
    return ""


# --------------------------------------------------------------------------- #
# sessions and CSRF
# --------------------------------------------------------------------------- #


class SessionStore:
    """In-memory sessions. A restart logs everyone out, which is the right default
    for an admin surface; the password hash outlives it on disk."""

    def __init__(self, ttl: int = SESSION_TTL) -> None:
        self.ttl = ttl
        self._sessions: dict[str, float] = {}

    def issue(self) -> str:
        token = secrets.token_urlsafe(32)
        self._sessions[token] = time.time() + self.ttl
        return token

    def valid(self, token: str | None) -> bool:
        if not token:
            return False
        expiry = self._sessions.get(token)
        if not expiry:
            # An evicted or stale token must not be resurrected by a later request.
            return False
        if expiry < time.time():
            self._sessions.pop(token, None)
            return False
        return True

    def drop(self, token: str | None) -> None:
        if token:
            self._sessions.pop(token, None)


class LoginThrottle:
    def __init__(self, limit: int = LOGIN_MAX_FAILURES, window: int = LOGIN_WINDOW) -> None:
        self.limit = limit
        self.window = window
        self._failures: dict[str, list[float]] = {}

    def _recent(self, key: str) -> list[float]:
        now = time.time()
        stamps = [t for t in self._failures.get(key, []) if now - t < self.window]
        if stamps:
            self._failures[key] = stamps
        else:
            self._failures.pop(key, None)
        return stamps

    def blocked(self, key: str) -> bool:
        return len(self._recent(key)) >= self.limit

    def record_failure(self, key: str) -> None:
        self._failures.setdefault(key, []).append(time.time())

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)


store = SessionStore()
throttle = LoginThrottle()


def client_key(request) -> str:
    """Behind a reverse proxy the socket address is the proxy; prefer the headers a
    trusted front end sets. Trusting XFF blindly would let anyone forge a fresh
    bucket, so only the last hop is used."""
    forwarded = request.headers.get("x-real-ip") or ""
    if not forwarded:
        xff = request.headers.get("x-forwarded-for") or ""
        forwarded = xff.split(",")[-1].strip() if xff else ""
    return forwarded or (request.client.host if request.client else "unknown")


def is_secure_request(request) -> bool:
    return (
        request.url.scheme == "https"
        or (request.headers.get("x-forwarded-proto") or "").lower() == "https"
    )


# --------------------------------------------------------------------------- #
# middleware
# --------------------------------------------------------------------------- #


def _json_body(request) -> dict[str, Any]:
    raw = getattr(request, "_dbdesk_body", b"")
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


TUNNEL_KEYS = ("ssh_host", "ssh_key", "ssh_user", "tunnel_command")


def _connection_violation(body: dict[str, Any]) -> tuple[int, str] | None:
    if not tunnels_allowed():
        for key in TUNNEL_KEYS:
            if str(body.get(key) or "").strip():
                return 403, (
                    "SSH tunnels and custom tunnel commands are disabled on this "
                    "server (DBDESK_ALLOW_TUNNELS=1 enables them)"
                )
    if not local_files_allowed() and str(body.get("kind") or "") == "sqlite":
        return 403, (
            "SQLite connections are disabled on this server "
            "(DBDESK_ALLOW_LOCAL_FILES=1 enables them)"
        )
    return None


def install_server_mode(app) -> None:
    """Wrap the app: login required for the API, CSRF on writes, feature gates."""
    from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse
    from starlette.middleware.base import BaseHTTPMiddleware

    login_page = LOGIN_HTML

    class ServerModeMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            path = request.url.path
            token = request.cookies.get(SESSION_COOKIE)
            authed = store.valid(token)

            # The API is the thing worth protecting; the static shell is not secret
            # (it is the same bundle anyone can download) and the login screen has to
            # load before there is a session at all.
            protected = path.startswith("/api/") and not path.startswith("/api/auth/")

            if protected:
                if not authed:
                    return JSONResponse({"detail": "authentication required"}, status_code=401)
                if request.method not in SAFE_METHODS:
                    header = request.headers.get(CSRF_HEADER) or ""
                    cookie = request.cookies.get(CSRF_COOKIE) or ""
                    if not cookie or not hmac.compare_digest(header, cookie):
                        return JSONResponse({"detail": "CSRF token missing or invalid"}, status_code=403)
                    body = await request.body()
                    setattr(request, "_dbdesk_body", body)
                    if path == GATED_CONNECTIONS:
                        violation = _connection_violation(_json_body(request))
                        if violation:
                            return JSONResponse({"detail": violation[1]}, status_code=violation[0])
                    request = _with_replay(request, body)

            if path in ("/", "/index.html") and not authed:
                return HTMLResponse(login_page, status_code=200)

            return await call_next(request)

    def _with_replay(request, body: bytes):
        """A BaseHTTPMiddleware that reads the body must hand it back down."""
        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}

        request._receive = receive
        return request

    app.add_middleware(ServerModeMiddleware)

    @app.post("/api/auth/login")
    async def login(request: Request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        password = str((payload or {}).get("password") or "")
        key = client_key(request)
        if throttle.blocked(key):
            return JSONResponse(
                {"detail": "too many attempts — wait a few minutes"}, status_code=429
            )
        expected = configured_password_hash()
        if not expected:
            return JSONResponse(
                {"detail": "server has no password configured — set DBDESK_SERVER_PASSWORD"},
                status_code=503,
            )
        if not verify_password(password, expected):
            throttle.record_failure(key)
            return JSONResponse({"detail": "wrong password"}, status_code=401)

        throttle.reset(key)
        session = store.issue()
        csrf = secrets.token_urlsafe(24)
        response = JSONResponse({"ok": True, "csrf": csrf})
        response.set_cookie(
            SESSION_COOKIE, session, httponly=True, samesite="lax",
            secure=is_secure_request(request), max_age=SESSION_TTL, path="/",
        )
        # The CSRF token must be readable by the page that sends it back.
        response.set_cookie(
            CSRF_COOKIE, csrf, httponly=False, samesite="lax",
            secure=is_secure_request(request), max_age=SESSION_TTL, path="/",
        )
        return response

    @app.post("/api/auth/logout")
    async def logout(request: Request):
        store.drop(request.cookies.get(SESSION_COOKIE))
        response = JSONResponse({"ok": True})
        response.delete_cookie(SESSION_COOKIE, path="/")
        response.delete_cookie(CSRF_COOKIE, path="/")
        return response

    @app.get("/api/auth/session")
    async def session(request: Request):
        authed = store.valid(request.cookies.get(SESSION_COOKIE))
        return JSONResponse({"authenticated": authed})

    @app.get("/login")
    async def login_form(request: Request):
        if store.valid(request.cookies.get(SESSION_COOKIE)):
            return RedirectResponse("/", status_code=303)
        return HTMLResponse(login_page)


LOGIN_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DB Desk — sign in</title>
<style>
  :root{color-scheme:light dark;--bg:#fff;--fg:#0f172a;--muted:#475569;--faint:#64748b;
        --stroke:#e2e8f0;--primary:#2563eb;--danger:#dc2626;--card:#f8fafc}
  @media (prefers-color-scheme: dark){:root{--bg:#0f1115;--fg:#e8ecf3;--muted:#c2cad8;
        --faint:#94a3b8;--stroke:#252b38;--primary:#6aa5ff;--danger:#f87171;--card:#141821}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);
       color:var(--fg);font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif}
  form{width:min(360px,calc(100vw - 32px));padding:26px;border:1px solid var(--stroke);
       border-radius:12px;background:var(--card);display:grid;gap:14px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:16px}
  .mark{width:26px;height:26px;border-radius:8px;background:var(--primary);display:grid;place-items:center;color:#fff}
  p.hint{margin:0;color:var(--muted);font-size:12.5px}
  label{display:grid;gap:6px;font-size:12.5px;color:var(--muted)}
  .field{position:relative;display:flex}
  input{flex:1;height:38px;padding:0 10px;border-radius:6px;border:1px solid var(--stroke);
        background:var(--bg);color:var(--fg);font:inherit;appearance:none}
  input:focus{outline:none;border-color:var(--primary);
              box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 22%,transparent)}
  .reveal{position:relative;margin-left:-34px;width:34px;border:0;background:transparent;
          color:var(--faint);font:inherit;font-size:11px;cursor:pointer}
  .reveal:hover{color:var(--muted)}
  button{height:38px;border:0;border-radius:6px;background:var(--primary);color:#fff;
         font:inherit;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  .error{color:var(--danger);font-size:12.5px;min-height:16px;margin:0}
</style></head>
<body>
<form id="f">
  <div class="brand"><span class="mark">▤</span> DB Desk</div>
  <p class="hint">This server holds database connections. Sign in to continue.</p>
  <label>Password
    <span class="field">
      <input id="p" type="password" autocomplete="current-password" required autofocus>
      <button class="reveal" id="r" type="button" aria-label="Show password">show</button>
    </span>
  </label>
  <p class="error" id="e"></p>
  <button id="b" type="submit">Sign in</button>
</form>
<script>
  const field = document.getElementById('p');
  const reveal = document.getElementById('r');
  reveal.addEventListener('click', () => {
    const hidden = field.type === 'password';
    field.type = hidden ? 'text' : 'password';
    reveal.textContent = hidden ? 'hide' : 'show';
    reveal.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
    field.focus();
  });
  const form = document.getElementById('f');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('b');
    const error = document.getElementById('e');
    button.disabled = true; error.textContent = '';
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({password: document.getElementById('p').value})
      });
      if (response.ok) { location.assign('/'); return; }
      const payload = await response.json().catch(() => ({}));
      error.textContent = payload.detail || 'Sign in failed';
    } catch (failure) {
      error.textContent = 'Network error — is the server reachable?';
    } finally {
      button.disabled = false;
    }
  });
</script>
</body></html>
"""
