"""Minimal MCP stdio bridge for DB Desk (stdlib only).

Run as ``dbdesk-server mcp`` (bundled app) or ``python backend/app.py mcp``.
It reads the bearer token from ``<app home>/data/mcp.json``, discovers the
app's port from ``runtime.json`` and proxies newline-delimited JSON-RPC to
``POST /mcp``.

The DB Desk app must be open, and MCP must be enabled in Settings.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

APP_NAME = "DB Desk"


def _home() -> Path:
    override = os.environ.get("DBDESK_HOME")
    if override:
        return Path(override)
    return Path.home() / "Library" / "Application Support" / APP_NAME


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _fail(message: str, code: int = 1) -> None:
    sys.stderr.write(f"dbdesk mcp: {message}\n")
    sys.stderr.flush()
    raise SystemExit(code)


def _target() -> tuple[str, str]:
    data = _home() / "data"
    config = _read_json(data / "mcp.json")
    if not config.get("enabled"):
        _fail("MCP is disabled. Open DB Desk → Settings → MCP server and enable it.")
    token = str(config.get("token") or "")
    if not token:
        _fail("MCP token is missing. Rotate it in DB Desk → Settings → MCP server.")
    runtime = _read_json(data / "runtime.json")
    port = int(runtime.get("port") or 0)
    pid = int(runtime.get("pid") or 0)
    if not port:
        _fail("DB Desk is not running. Open the app, then restart the agent.")
    if pid:
        try:
            os.kill(pid, 0)
        except OSError:
            _fail("DB Desk is not running (stale runtime file). Open the app first.")
    return f"http://127.0.0.1:{port}/mcp", token


def _post(url: str, token: str, payload: Any) -> tuple[int, Any]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    except OSError as exc:
        raise RuntimeError(f"cannot reach DB Desk at {url}: {exc}") from exc
    if not raw:
        return status, None
    try:
        return status, json.loads(raw.decode("utf-8"))
    except ValueError:
        return status, raw.decode("utf-8", "replace")


def _error(message: Any) -> dict[str, Any]:
    request_id = message.get("id") if isinstance(message, dict) else None
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32000, "message": str(message)},
    }


def main() -> None:
    url, token = _target()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            sys.stdout.write(json.dumps(_error("invalid JSON")) + "\n")
            sys.stdout.flush()
            continue
        try:
            status, reply = _post(url, token, message)
        except RuntimeError as exc:
            reply = _error(exc)
            status = 0
        if isinstance(message, dict) and "id" not in message:
            continue  # notification: no response
        if reply is None and status == 204:
            continue
        if not isinstance(reply, dict) and not isinstance(reply, list):
            reply = _error(reply)
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
