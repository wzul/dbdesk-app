"""Mobile checks that can run without a browser.

The live audit (Playwright at 320–1024px) found what CSS alone had broken: the docs grid kept
its three tracks on a phone because a later rule overrode the media query, links were 19px
tall, and the header simply hid its navigation below 960px with nothing in its place. Those
are structural, so they can be pinned here cheaply: every page has the menu, every page loads
the script that closes it, and the stylesheet keeps the rules that make the layout fit.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "website"

PAGES = ["index.html", "security/index.html", "docs/index.html"] + [
    f"docs/{slug}.html" for slug in
    ("getting-started", "features", "mcp", "security", "development", "signing", "troubleshooting")
]


class MobileTest(unittest.TestCase):
    def test_every_page_has_the_mobile_menu(self):
        for page in PAGES:
            html = (SITE / page).read_text()
            with self.subTest(page=page):
                self.assertIn('class="nav-mobile"', html)
                self.assertIn("nav-mobile-panel", html)
                # A menu with no script cannot be closed with Escape or a tap outside.
                self.assertIn("/assets/site.js", html)

    def test_menu_lists_the_same_destinations_as_the_header(self):
        home = (SITE / "index.html").read_text()
        match = re.search(r'<div class="nav-mobile-panel">(.*?)</div>', home, re.S)
        self.assertIsNotNone(match, "no mobile menu panel in index.html")
        panel = match.group(1)
        for href in ("/#features", "/#databases", "/#ai", "/#mcp", "/security/", "/docs/"):
            self.assertIn(f'href="{href}"', panel)

    def test_stylesheet_keeps_the_mobile_layout_rules(self):
        css = (SITE / "assets" / "styles.css").read_text()
        # The docs grid must collapse; a later three-track declaration would silently win.
        mobile_block = css[css.index("@media (max-width: 760px)"):]
        self.assertIn("grid-template-columns: minmax(0, 1fr)", mobile_block)
        self.assertIn(".nav-mobile { display: inline-flex; }", css)
        self.assertIn(".docs-body pre code { white-space: pre; }", css)
        self.assertIn(".docs-body a { overflow-wrap: anywhere; }", css)
        # Tap targets: the footer and nav links get a real hit area on a phone.
        self.assertIn("min-height: 36px", css)
        self.assertIn("min-height: 44px", css)

    def test_badges_meet_aa_contrast(self):
        css = (SITE / "assets" / "styles.css").read_text()
        # Measured at 2.81:1 before; the pairs below are 5.5:1 or better.
        self.assertIn(".badge-ok { background: #def2e6; color: #0b6b2f; }", css)
        self.assertIn(".badge-gap { background: #fde8e8; color: #b91c1c; }", css)
        self.assertNotIn("badge-ok { background: color-mix(in srgb, var(--ok) 14%", css)

    def test_no_skipped_heading_levels(self):
        # h1 → h3 (security) and h2 → h4 (home) were both flagged by Lighthouse.
        for page in ("index.html", "security/index.html"):
            html = (SITE / page).read_text()
            levels = [int(m.group(1)) for m in re.finditer(r"<h([1-6])[ >]", html)]
            with self.subTest(page=page):
                self.assertEqual(levels[0], 1, "page must start with an h1")
                for previous, current in zip(levels, levels[1:]):
                    self.assertLessEqual(current, previous + 1,
                                        f"heading jumps {previous} → {current} in {page}")


if __name__ == "__main__":
    unittest.main()
