#!/usr/bin/env python3
"""Render the installable-app icons from ui/public/icon-source.svg.

A PWA needs 192px and 512px PNGs, plus a maskable 512 with the artwork inset inside
the safe zone (Android crops maskable icons to a circle/squircle, so a glyph that
fills the canvas loses its corners).

    python3 scripts/make-icons.py
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "ui" / "public" / "icon-source.svg"
OUT_DIR = ROOT / "ui" / "public" / "icons"

# Fraction of the canvas the maskable artwork may occupy (W3C safe zone is 80%).
MASKABLE_SCALE = 0.78


def main() -> int:
    from playwright.sync_api import sync_playwright

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    svg = SOURCE.read_text(encoding="utf-8")

    def page_html(scale: float = 1.0) -> str:
        inset = round((512 - 512 * scale) / 2)
        svg_style = (
            f"position:absolute;left:{inset}px;top:{inset}px;"
            f"width:{round(512 * scale)}px;height:{round(512 * scale)}px;"
        )
        # A bare <rect> outside an <svg> is ignored by the HTML parser, so the
        # full-bleed backing has to be a div with a colour.
        background = (
            '<div style="position:absolute;inset:0;background:#2563eb"></div>'
            if scale < 1
            else ""
        )
        return (
            "<!doctype html><meta charset=utf-8>"
            '<body style="margin:0;background:transparent">'
            f"<div style=\"position:relative;width:512px;height:512px\">{background}"
            f'<div style="{svg_style}">{svg.replace("<svg ", "<svg style=\"width:100%;height:100%\" ")}</div>'
            "</div></body>"
        )

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
        for name, size, scale in [
            ("icon-192.png", 192, 1.0),
            ("icon-512.png", 512, 1.0),
            ("icon-maskable-512.png", 512, MASKABLE_SCALE),
        ]:
            page = browser.new_page(viewport={"width": 512, "height": 512}, device_scale_factor=1)
            page.set_content(page_html(scale), wait_until="load")
            page.wait_for_timeout(150)
            target = OUT_DIR / name
            page.screenshot(path=str(target), omit_background=True, clip={"x": 0, "y": 0, "width": 512, "height": 512})
            if size != 512:
                from PIL import Image

                Image.open(target).resize((size, size), Image.LANCZOS).save(target)
            page.close()
            print(f"{target.relative_to(ROOT)} {target.stat().st_size} bytes")
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
