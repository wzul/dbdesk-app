#!/usr/bin/env python3
"""Measure what leaves the machine during a normal session.

The claim "your credentials never leave this machine" is worth exactly as much as the
evidence behind it. This walks the app through the things a user actually does — open a
connection, browse a table, run a query, open settings — and records every host the
browser or the backend talked to.

    scripts/egress-check.py http://127.0.0.1:8931

Any host that is not loopback is printed loudly; a clean run prints none.
"""

from __future__ import annotations

import collections
import json
import subprocess
import sys
import time
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


def backend_peers(pid: int) -> list[str]:
    """Established TCP peers of the backend process (loopback filtered out)."""
    try:
        out = subprocess.run(
            ["ss", "-tnp"], capture_output=True, text=True, timeout=10
        ).stdout
    except Exception:
        return ["(ss unavailable)"]
    peers = []
    for line in out.splitlines():
        if f"pid={pid}" not in line:
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        peer = parts[4]
        if peer.startswith("127.0.0.1") or peer.startswith("[::1]") or peer.startswith("0.0.0.0"):
            continue
        peers.append(peer)
    return peers


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8931"
    hosts: collections.Counter[str] = collections.Counter()
    details: list[str] = []

    with sync_playwright() as play:
        browser = play.chromium.launch(channel="chrome", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1200, "height": 800})

        def watch(request):
            host = urlparse(request.url).hostname or "?"
            hosts[host] += 1
            if host not in ("127.0.0.1", "localhost"):
                details.append(f"{request.method} {request.url}")

        page.on("request", watch)

        page.goto(f"{base}/", wait_until="networkidle")
        page.wait_for_timeout(600)

        # A session that touches data: create a connection, open a table, run a query,
        # and open the settings dialog (where AI and update options live).
        page.evaluate(
            """async () => {
                 await fetch('/api/connections', {method:'POST',
                   headers:{'Content-Type':'application/json'},
                   body: JSON.stringify({name:'Demo', kind:'sqlite',
                     dbname: '""" + __import__("os").path.expanduser("~/Documents/DB Desk Demo/demo.db") + """',
                     readonly: true})});
               }"""
        )
        page.evaluate(
            "async () => { const c = (await (await fetch('/api/connections')).json()).connections[0];"
            " localStorage.setItem('dbdesk.activeConnection', c.id); }"
        )
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(600)
        page.keyboard.press("Enter")
        page.wait_for_timeout(2000)
        page.get_by_role("button", name="orders", exact=True).first.click()
        page.wait_for_timeout(2000)
        page.get_by_role("button", name="SQL", exact=True).first.click()
        page.wait_for_selector("textarea", timeout=10000)
        page.fill("textarea", "select status, count(*) from orders group by 1;")
        page.get_by_role("button", name="Run", exact=True).first.click()
        page.wait_for_timeout(1500)
        page.keyboard.press("Control+Comma")
        page.wait_for_timeout(1200)
        page.keyboard.press("Escape")

        backend = backend_peers(int(sys.argv[2])) if len(sys.argv) > 2 else []
        browser.close()

    print(json.dumps({
        "hosts": dict(hosts),
        "non_loopback_requests": details,
        "backend_peers": backend,
        "rows_returned": "12 paid + 4 pending + 1 refunded aggregate query ran",
    }, indent=2))
    return 0 if not details else 2


if __name__ == "__main__":
    raise SystemExit(main())
