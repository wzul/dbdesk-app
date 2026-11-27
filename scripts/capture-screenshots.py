#!/usr/bin/env python3
"""Re-take the documentation screenshots against the current build.

Run it against a scratch instance of the app (desktop mode, throwaway DBDESK_HOME),
then frame the results with scripts/frame-window.py:

    scripts/make-demo-db.py /tmp/dbdesk-shots
    PORT=8930 DBDESK_HOME=/tmp/dbdesk-shots-home python backend/app.py &
    scripts/capture-screenshots.py http://127.0.0.1:8930 docs/img/src
    scripts/frame-window.py docs/img/src docs/img

Every step asserts what it expects instead of sleeping and hoping, so a UI change
fails loudly here rather than shipping a screenshot of the wrong thing.
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

WIDTH, HEIGHT, SCALE = 1100, 760, 2

QUERY = """select o.id, c.name, o.total, o.status
from orders o
join customers c on c.id = o.customer_id
order by o.total desc
limit 12;
"""


def open_connection(page, name: str = "Demo") -> str:
    """Open one named connection, whatever state the picker is in.

    By name, not by index: saving a connection moves it to the end of the list, so the
    first entry is whatever was edited last.
    """
    connection = page.evaluate(
        """async (name) => {
             const all = (await (await fetch('/api/connections')).json()).connections;
             const hit = all.find(c => c.name === name);
             if (!hit) throw new Error('no connection named ' + name);
             return hit.id;
           }""",
        name,
    )
    page.evaluate(f"localStorage.setItem('dbdesk.activeConnection','{connection}')")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(800)
    # The picker advertises "⏎ open" for the remembered connection.
    page.keyboard.press("Enter")
    page.wait_for_selector("button:has-text('orders')", timeout=15000)
    return connection


def open_table(page, name: str) -> None:
    page.get_by_role("button", name=name, exact=True).first.click()
    page.wait_for_selector(".dbd-grid-table tbody tr", timeout=15000)
    page.wait_for_timeout(600)


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8930"
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/img/src")
    out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as play:
        browser = play.chromium.launch(channel="chrome", args=["--no-sandbox"])
        context = browser.new_context(
            viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=SCALE
        )
        page = context.new_page()

        page.goto(f"{base}/", wait_until="networkidle")
        page.wait_for_timeout(700)
        open_connection(page)
        open_table(page, "orders")

        # 1. The table view.
        page.screenshot(path=str(out / "standalone.png"))
        print("standalone.png", page.title())

        # 2. Back to the picker, which now offers to resume the last connection.
        page.get_by_role("button", name="All connections").click()
        page.wait_for_selector("text=CONTINUE WHERE YOU LEFT OFF", timeout=15000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(out / "connection-picker.png"))
        print("connection-picker.png")

        # 3. Filters: raw SQL, applied — the grid must actually narrow.
        page.keyboard.press("Enter")
        page.wait_for_selector("button:has-text('orders')", timeout=15000)
        open_table(page, "orders")
        rows_before = page.locator(".dbd-grid-table tbody tr").count()
        page.get_by_role("button", name="Filter", exact=True).first.click()
        page.wait_for_selector("input[placeholder^='Pattern']", timeout=10000)
        page.fill("input[placeholder^='Pattern']", "status = 'paid'")
        page.get_by_role("button", name="Apply", exact=True).first.click()
        page.wait_for_timeout(2000)
        rows_after = page.locator(".dbd-grid-table tbody tr").count()
        assert rows_after < rows_before, f"filter did not narrow the grid ({rows_before} -> {rows_after})"
        page.screenshot(path=str(out / "filters.png"))
        print(f"filters.png  ({rows_before} rows -> {rows_after})")

        # 4. SQL tab with a join.
        page.get_by_role("button", name="SQL", exact=True).first.click()
        page.wait_for_selector("textarea", timeout=15000)
        page.fill("textarea", QUERY)
        page.wait_for_timeout(300)
        page.get_by_role("button", name="Run", exact=True).first.click()
        page.wait_for_timeout(2500)
        body = page.inner_text("body")
        assert "rows" in body, "the query produced no result summary"
        page.screenshot(path=str(out / "sql-tab.png"))
        print("sql-tab.png")

        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
