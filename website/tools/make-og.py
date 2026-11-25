#!/usr/bin/env python3
"""Render the 1200x630 link-preview card for dbdesk.app.

The card is HTML (so the type is real and re-editable); this script renders it with
the system Chrome through Playwright and writes assets/img/og.png at exactly
1200x630. Run it after any change to tools/og-card.html:

    python3 website/tools/make-og.py

Needs playwright with a system Chrome (channel="chrome"). The screenshot is taken
at deviceScaleFactor=1 because Open Graph consumers expect the literal pixel size.
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "og-card.html"
OUT = ROOT / "assets" / "img" / "og.png"


def main() -> int:
    if not SRC.exists():
        print(f"missing source: {SRC}", file=sys.stderr)
        return 1
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1)
        page.goto(SRC.as_uri(), wait_until="networkidle")
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT), clip={"x": 0, "y": 0, "width": 1200, "height": 630})
        browser.close()
    size = OUT.stat().st_size
    print(f"{OUT} {size} bytes")
    return 0 if size > 10_000 else 1


if __name__ == "__main__":
    raise SystemExit(main())
