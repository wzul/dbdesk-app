"""Every image on every page of dbdesk.app: does it load, and is it a real picture?

Three failure modes a browser hides from you:
  1. an <img> that 404s but has width/height CSS, so the layout looks fine and the box is empty;
  2. a srcset candidate that 404s — the browser silently falls back, so the page "works" while
     the 2x screen the user actually has gets a broken image;
  3. a file that returns 200 with the wrong bytes (an HTML error page, a truncated file), which
     an <img> reports as naturalWidth 0 and a human reports as "rosak".

So: load each page, read what the browser chose, then fetch every candidate URL and decode it.
"""

import json
import re
import sys
import urllib.request
from urllib.parse import urljoin

from playwright.sync_api import sync_playwright

PAGES = [line.strip() for line in open("/tmp/dbdesk-pages.txt") if line.strip()]
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) dbdesk-image-audit"}


def fetch(url: str):
    request = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("Content-Type", ""), b""
    except Exception as exc:  # DNS, TLS, timeout
        return 0, str(exc)[:80], b""


def decode(raw: bytes, content_type: str):
    """Return (ok, kind, detail). Bytes that are not an image are the interesting failure."""
    if not raw:
        return False, "empty", "0 bytes"
    head = raw[:64].lstrip()
    if head[:1] == b"<":
        return False, "html", "response body is HTML, not an image"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        try:
            from PIL import Image
            import io
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
                return True, "png", f"{image.width}x{image.height}"
        except Exception as exc:
            return False, "png", f"corrupt PNG: {exc}"
    if raw[:3] == b"\xff\xd8\xff":
        try:
            from PIL import Image
            import io
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
                return True, "jpeg", f"{image.width}x{image.height}"
        except Exception as exc:
            return False, "jpeg", f"corrupt JPEG: {exc}"
    if raw[:5] in (b"<?xml", b"<svg ") or b"<svg" in raw[:200]:
        return True, "svg", f"{len(raw)} bytes"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return True, "webp", f"{len(raw)} bytes"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return True, "gif", f"{len(raw)} bytes"
    if raw[:4] == b"\x00\x00\x01\x00" or raw[:4] == b"\x00\x00\x02\x00":
        return True, "ico", f"{len(raw)} bytes"
    return False, "unknown", f"unrecognised bytes: {raw[:12]!r}"


report = []
checked = {}
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", args=["--no-sandbox"])

    for page_url in PAGES:
        # Both a 1x and a 2x context: the 2x one is what picks the hi-dpi srcset candidate.
        for label, scale in (("1x", 1), ("2x", 2)):
            context = browser.new_context(viewport={"width": 1280, "height": 900},
                                           device_scale_factor=scale)
            page = context.new_page()
            failed = []
            page.on("requestfailed",
                    lambda request, failed=failed: failed.append(request.url)
                    if request.resource_type in ("image", "media", "font", "stylesheet") else None)
            page.goto(page_url, wait_until="networkidle")
            # Images below the fold are lazy: scroll the page so every one is actually
            # requested, otherwise naturalWidth 0 means "not loaded yet", not "broken".
            page.evaluate("""async () => {
              for (let y = 0; y < document.body.scrollHeight; y += 400) {
                window.scrollTo(0, y);
                await new Promise(r => setTimeout(r, 60));
              }
              window.scrollTo(0, 0);
            }""")
            page.wait_for_timeout(600)

            found = page.evaluate("""() => {
              const out = [];
              const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
              for (const img of document.images) {
                out.push({
                  kind: 'img',
                  src: abs(img.currentSrc || img.src || ''),
                  candidates: (img.getAttribute('srcset') || '')
                      .split(',').map(s => s.trim().split(/\\s+/)[0]).filter(Boolean).map(abs),
                  natural: [img.naturalWidth, img.naturalHeight],
                  complete: img.complete,
                  alt: img.alt,
                  where: img.closest('section')?.className || img.parentElement?.className || ''
                });
              }
              // CSS background images are invisible to document.images.
              for (const element of document.querySelectorAll('*')) {
                const background = getComputedStyle(element).backgroundImage;
                if (background && background !== 'none' && background.includes('url(')) {
                  const match = background.match(/url\\(["']?(.*?)["']?\\)/);
                  if (match) out.push({kind: 'css', src: abs(match[1]), where: element.className || element.tagName});
                }
              }
              // <use href="/assets/icons.svg#x"> is an image reference too.
              for (const use of document.querySelectorAll('use')) {
                const href = use.getAttribute('href') || use.getAttribute('xlink:href');
                if (href && !href.startsWith('#')) out.push({kind: 'use', src: abs(href), where: 'svg'});
              }
              return out;
            }""")

            for item in found:
                for url in [item["src"], *item.get("candidates", [])]:
                    if not url:
                        continue
                    key = url
                    if key not in checked:
                        status, content_type, raw = fetch(url)
                        ok, kind, detail = decode(raw, content_type) if status == 200 else (False, "-", "")
                        checked[key] = {
                            "url": url, "status": status, "content_type": content_type,
                            "bytes": len(raw), "ok": ok and status == 200,
                            "kind": kind, "detail": detail,
                        }
                    entry = checked[key]
                    report.append({
                        "page": page_url, "scale": label, "role": item["kind"],
                        "used_as": item["src"], "candidate": url,
                        "natural": item.get("natural"), "complete": item.get("complete"),
                        "alt": item.get("alt", ""), "where": item.get("where", ""),
                        "http": entry["status"], "type": entry["content_type"],
                        "bytes": entry["bytes"], "decoded": entry["kind"],
                        "detail": entry["detail"], "ok": entry["ok"],
                    })
            if failed:
                for url in failed:
                    report.append({"page": page_url, "scale": label, "role": "request-failed",
                                   "candidate": url, "http": 0, "ok": False,
                                   "detail": "request failed"})
            context.close()

    browser.close()

json.dump(report, open("/tmp/image-audit.json", "w"), indent=1)

# ---- summary
bad = [row for row in report if not row.get("ok")]
by_page = {}
for row in report:
    by_page.setdefault(row["page"], {"rows": 0, "bad": 0, "urls": set()})
    by_page[row["page"]]["rows"] += 1
    by_page[row["page"]]["urls"].add(row["candidate"])
    if not row.get("ok"):
        by_page[row["page"]]["bad"] += 1

print(f"pages: {len(PAGES)}  references checked: {len(report)}  unique urls: {len(checked)}")
print(f"broken: {len(bad)}\n")
for page_url in PAGES:
    stats = by_page.get(page_url, {"rows": 0, "bad": 0, "urls": set()})
    flag = "OK  " if stats["bad"] == 0 else "FAIL"
    print(f"{flag} {page_url:50} {len(stats['urls']):2} urls  {stats['bad']} broken")

if bad:
    print("\n--- broken references")
    seen = set()
    for row in bad:
        key = (row["candidate"], row.get("http"))
        if key in seen:
            continue
        seen.add(key)
        print(f"  {row.get('http')} {row['candidate']}  ({row.get('detail','')})  on {row['page']} [{row.get('role')}]")

# images that loaded but are empty per the browser (a silent break)
silent = [row for row in report
          if row.get("role") == "img" and row.get("complete")
          and row.get("natural") and (row["natural"][0] == 0 or row["natural"][1] == 0)]
print(f"\nempty-in-browser (naturalWidth 0): {len(silent)}")
for row in silent[:10]:
    print(" ", row["page"], row["candidate"], row.get("where"))

no_alt = {row["candidate"] for row in report
          if row.get("role") == "img" and not (row.get("alt") or "").strip()}
print(f"images with no alt text: {len(no_alt)}")
for url in sorted(no_alt):
    print(" ", url)

sys.exit(1 if bad or silent else 0)
