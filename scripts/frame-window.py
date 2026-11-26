#!/usr/bin/env python3
"""Put a raw app screenshot inside a macOS window frame.

GitHub renders a bare content screenshot as a floating slab of UI with no context;
a window frame signals "this is a desktop app" at a glance. The frame is drawn in
HTML and photographed with Chrome, so it stays sharp at 2x and the corners and shadow
keep real alpha — nothing is pasted in with Pillow.

    scripts/frame-window.py docs/img/src docs/img --title "DB Desk"

Originals live in `docs/img/src/`; the framed files keep the same names so every
existing link in the docs keeps working.
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
from pathlib import Path

TEMPLATE = """<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body {{ margin: 0; background: transparent; }}
  body {{ padding: {pad}px; }}
  .window {{
    width: {width}px;
    border-radius: 11px;
    overflow: hidden;
    background: #f6f6f7;
    /* Layered and bottom-heavy, the way a lit window casts on a desktop: a tight
       contact shadow, then a mid falloff, then a wide ambient one. */
    box-shadow:
      0 0 0 1px rgba(0,0,0,0.16),
      0 1px 2px rgba(0,0,0,0.20),
      0 14px 32px rgba(0,0,0,0.16),
      0 40px 80px rgba(0,0,0,0.12);
  }}
  .bar {{
    height: 38px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px;
    background: linear-gradient(#fbfbfc, #ececef);
    border-bottom: 1px solid rgba(0,0,0,0.13);
    position: relative;
  }}
  /* Stock macOS buttons are not flat discs: a hairline rim plus a top highlight is
     what makes them read as physical rather than as three coloured circles. */
  .light {{
    width: 12px; height: 12px; border-radius: 50%;
    box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.22), inset 0 1px 1px rgba(255,255,255,0.35);
  }}
  .close {{ background: radial-gradient(circle at 50% 35%, #ff8a80, #ff5f57 60%, #f0453c); }}
  .min {{ background: radial-gradient(circle at 50% 35%, #ffd977, #febc2e 60%, #eaa419); }}
  .max {{ background: radial-gradient(circle at 50% 35%, #6ee787, #28c840 60%, #1faa33); }}
  .title {{
    position: absolute; inset: 0; display: grid; place-items: center;
    font: 500 12.5px -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
    color: rgba(0,0,0,0.62); letter-spacing: 0.1px; pointer-events: none;
  }}
  img {{ display: block; width: {width}px; height: auto; }}
</style></head>
<body>
  <div class="window">
    <div class="bar">
      <span class="light close"></span><span class="light min"></span><span class="light max"></span>
      <div class="title">{title}</div>
    </div>
    <img src="{src}">
  </div>
</body></html>
"""


def png_size(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:33]
    if header[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path}: not a PNG")
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    return width, height


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--title", default="DB Desk")
    parser.add_argument("--width", type=int, default=1100, help="window width in CSS px")
    parser.add_argument("--scale", type=float, default=2.0)
    parser.add_argument("--pad", type=int, default=48, help="room for the shadow")
    args = parser.parse_args()

    sources = sorted(args.source.glob("*.png"))
    if not sources:
        raise SystemExit(f"no PNGs in {args.source}")

    args.out.mkdir(parents=True, exist_ok=True)
    workdir = Path("/tmp/dbdesk-frame")
    workdir.mkdir(exist_ok=True)

    pages = []
    for source in sources:
        width, height = png_size(source)
        data = base64.b64encode(source.read_bytes()).decode("ascii")
        page = workdir / f"{source.stem}.html"
        page.write_text(
            TEMPLATE.format(
                pad=args.pad,
                width=args.width,
                title=args.title,
                src=f"data:image/png;base64,{data}",
            )
        )
        pages.append((page, source, width, height))

    # One browser, one pass: the frames are static HTML, so the whole set is cheap.
    script = workdir / "render.py"
    jobs = [
        {
            "page": str(page),
            "out": str(args.out / source.name),
            "height": round(args.width * size[1] / size[0]) + 38 + args.pad * 2,
        }
        for page, source, *size in pages
    ]
    script.write_text(
        "import json, sys\n"
        "from playwright.sync_api import sync_playwright\n"
        f"jobs = json.loads({json.dumps(json.dumps(jobs))})\n"
        "with sync_playwright() as p:\n"
        "    browser = p.chromium.launch(channel='chrome', args=['--no-sandbox'])\n"
        "    for job in jobs:\n"
        "        page = browser.new_page(viewport={'width': VIEW_W, 'height': job['height']},\n"
        "                                device_scale_factor=SCALE)\n"
        "        page.goto('file://' + job['page'], wait_until='load')\n"
        "        page.screenshot(path=job['out'], omit_background=True)\n"
        "        print(job['out'])\n"
        "        page.close()\n"
        "    browser.close()\n".replace("VIEW_W", str(args.width + args.pad * 2)).replace(
            "SCALE", str(args.scale)
        )
    )
    result = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
    sys.stdout.write(result.stdout)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        return result.returncode

    for source in sources:
        framed = args.out / source.name
        width, height = png_size(framed)
        print(f"{source.name}: {png_size(source)[0]}x{png_size(source)[1]} -> {width}x{height}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
