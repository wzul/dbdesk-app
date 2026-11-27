"""Every asset a page asks for must exist on disk.

The homepage shipped `src="/assets/img/standalone"` while the file was `standalone.webp`, so the
plain `src` and the 2392w srcset candidate were both 404 and only the 900w variant worked on a
1x screen. A browser hides that: it silently falls back to the candidate that does resolve, so
the page looks correct on the machine you check it on and shows an empty box on a retina screen.

This is the cheap guard for that class of mistake: resolve every local reference in the shipped
HTML and CSS against the filesystem.
"""

import re
import unittest
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "website"

# Directories whose HTML/CSS is actually published.
SOURCES = ["index.html", "security/index.html", "assets/styles.css"]
SOURCES += sorted(str(path.relative_to(SITE)) for path in (SITE / "docs").glob("*.html"))


def references(text: str):
    """Local URLs a browser would fetch for this document: src, href, srcset, url(), content=."""
    found = set()
    for match in re.finditer(r'(?:src|href)="(/[^"#?\s]+)(?:\?[^"]*)?"', text):
        found.add(match.group(1))
    for match in re.finditer(r'srcset="([^"]+)"', text):
        for candidate in match.group(1).split(","):
            url = candidate.strip().split(" ")[0]
            if url.startswith("/"):
                found.add(url.split("?")[0])
    for match in re.finditer(r'url\(["\']?(/[^"\')?]+)', text):
        found.add(match.group(1))
    for match in re.finditer(r'content="https://dbdesk\.app(/[^"?]+)', text):
        found.add(match.group(1))
    return found


class SiteAssetsTest(unittest.TestCase):
    def test_every_local_reference_resolves_to_a_file(self):
        missing = {}
        for source in SOURCES:
            path = SITE / source
            if not path.exists():
                continue
            text = path.read_text()
            for url in sorted(references(text)):
                if url in ("/", ""):
                    continue
                target = SITE / url.lstrip("/")
                if target.is_dir():
                    target = target / "index.html"
                if not target.exists():
                    missing.setdefault(url, []).append(source)
        self.assertEqual(missing, {}, "references with no file:\n" + "\n".join(
            f"  {url}  <- {', '.join(sorted(set(pages)))}" for url, pages in sorted(missing.items())
        ))

    def test_image_sources_keep_their_extension(self):
        """An extensionless image URL is a 404 unless a server rewrites it; nginx does not."""
        offenders = []
        for source in SOURCES:
            path = SITE / source
            if not path.exists():
                continue
            for match in re.finditer(r'(?:src|srcset)="([^"]+)"', path.read_text()):
                for candidate in match.group(1).split(","):
                    url = candidate.strip().split(" ")[0]
                    if not url.startswith("/assets/img/"):
                        continue
                    last = url.split("?")[0].rsplit("/", 1)[-1]
                    if not last.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".svg", ".avif", ".ico")):
                        offenders.append(f"{source}: {url}")
        self.assertEqual(offenders, [], "image URLs without a file extension:\n" + "\n".join(offenders))

    def test_every_published_image_is_reachable_from_some_page(self):
        """A file nothing points at is dead weight in the deploy."""
        published = {
            f"img/{path.name}" for path in (SITE / "assets" / "img").iterdir() if path.is_file()
        }
        referenced = set()
        for source in SOURCES:
            path = SITE / source
            if not path.exists():
                continue
            for url in references(path.read_text()):
                if "/assets/img/" in url:
                    referenced.add("img/" + url.split("/assets/img/")[-1])
        # the social card is referenced from meta content, which the src scan does not always see
        unreferenced = published - referenced - {"og.png"}
        self.assertEqual(unreferenced, set(), f"assets nothing references: {sorted(unreferenced)}")


if __name__ == "__main__":
    unittest.main()
