"""Server-mode auth: login, sessions, CSRF and the hosted-feature gates."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

HOME = tempfile.mkdtemp(prefix="dbdesk-server-")
os.environ["DBDESK_HOME"] = HOME
os.environ.setdefault("DBDESK_NO_NOTIFY", "1")
os.environ["DBDESK_SERVER_PASSWORD"] = "hunter2-correct-horse"

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import server_auth  # noqa: E402


def build_app() -> TestClient:
    app = FastAPI()

    @app.get("/api/connections")
    async def list_connections():
        return {"connections": []}

    @app.post("/api/connections")
    async def save_connection(request: Request):
        body = await request.json()
        return {"saved": body.get("name")}

    server_auth.install_server_mode(app)
    return TestClient(app)


class ServerModeTest(unittest.TestCase):
    def setUp(self):
        server_auth.store = server_auth.SessionStore()
        server_auth.throttle = server_auth.LoginThrottle()
        self.client = build_app()

    def login(self, password: str = "hunter2-correct-horse"):
        response = self.client.post("/api/auth/login", json={"password": password})
        csrf = response.cookies.get(server_auth.CSRF_COOKIE) or ""
        return response, csrf

    def test_api_requires_a_login(self):
        response = self.client.get("/api/connections")
        self.assertEqual(response.status_code, 401)
        self.assertIn("authentication required", response.text)

    def test_root_serves_the_login_screen_when_signed_out(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Sign in", response.text)

    def test_login_then_protected_route_works(self):
        response, _ = self.login()
        self.assertEqual(response.status_code, 200)
        self.assertIn("ok", response.text)
        self.assertIn(server_auth.SESSION_COOKIE, response.cookies)
        self.assertEqual(self.client.get("/api/connections").status_code, 200)

    def test_wrong_password_is_rejected_and_then_throttled(self):
        first, _ = self.login("nope")
        self.assertEqual(first.status_code, 401)
        for _ in range(server_auth.LOGIN_MAX_FAILURES):
            self.login("nope")
        blocked, _ = self.login("hunter2-correct-horse")
        self.assertEqual(blocked.status_code, 429)

    def test_writes_need_the_csrf_header(self):
        _, csrf = self.login()
        without = self.client.post("/api/connections", json={"name": "x"})
        self.assertEqual(without.status_code, 403)

        with_header = self.client.post(
            "/api/connections", json={"name": "x"}, headers={server_auth.CSRF_HEADER: csrf}
        )
        self.assertEqual(with_header.status_code, 200)
        self.assertIn("x", with_header.text)

        forged = self.client.post(
            "/api/connections", json={"name": "x"}, headers={server_auth.CSRF_HEADER: "not-the-cookie"}
        )
        self.assertEqual(forged.status_code, 403)

    def test_tunnels_are_refused_unless_enabled(self):
        _, csrf = self.login()
        body = {"name": "prod", "kind": "postgres", "host": "db", "ssh_host": "bastion.example"}
        response = self.client.post(
            "/api/connections", json=body, headers={server_auth.CSRF_HEADER: csrf}
        )
        self.assertEqual(response.status_code, 403)
        self.assertIn("DBDESK_ALLOW_TUNNELS", response.text)

        os.environ["DBDESK_ALLOW_TUNNELS"] = "1"
        try:
            allowed = self.client.post(
                "/api/connections", json=body, headers={server_auth.CSRF_HEADER: csrf}
            )
            self.assertEqual(allowed.status_code, 200)
        finally:
            os.environ.pop("DBDESK_ALLOW_TUNNELS", None)

    def test_local_sqlite_paths_are_refused_unless_enabled(self):
        _, csrf = self.login()
        body = {"name": "local", "kind": "sqlite", "dbname": "/etc/passwd"}
        response = self.client.post(
            "/api/connections", json=body, headers={server_auth.CSRF_HEADER: csrf}
        )
        self.assertEqual(response.status_code, 403)
        self.assertIn("DBDESK_ALLOW_LOCAL_FILES", response.text)

    def test_logout_ends_the_session(self):
        _, csrf = self.login()
        self.assertEqual(self.client.post("/api/auth/logout").status_code, 200)
        self.assertEqual(self.client.get("/api/connections").status_code, 401)

    def test_password_hash_round_trip(self):
        stored = server_auth.hash_password("s3cret")
        self.assertTrue(server_auth.verify_password("s3cret", stored))
        self.assertFalse(server_auth.verify_password("s3cres", stored))
        self.assertFalse(server_auth.verify_password("s3cret", "garbage"))

    def test_no_password_configured_says_so_instead_of_letting_anyone_in(self):
        os.environ.pop("DBDESK_SERVER_PASSWORD", None)
        empty_home = tempfile.mkdtemp(prefix="dbdesk-nopass-")
        previous = os.environ["DBDESK_HOME"]
        os.environ["DBDESK_HOME"] = empty_home
        try:
            self.client = build_app()
            response, _ = self.login("anything")
            self.assertEqual(response.status_code, 503)
        finally:
            os.environ["DBDESK_HOME"] = previous
            os.environ["DBDESK_SERVER_PASSWORD"] = "hunter2-correct-horse"


if __name__ == "__main__":
    unittest.main()
