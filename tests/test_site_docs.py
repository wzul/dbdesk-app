"""The website must describe the docs it actually ships.

The docs pages, sitemap, robots.txt and llms.txt are generated from docs/*.md at deploy
time, so the failure modes are boring and real: a page that silently drops out of the
sidebar, a sitemap entry pointing at a file nobody wrote, an llms.txt link that 404s, or a
generated file that was committed stale. This checks the built output rather than the
builder.
"""

import pathlib
import re
import unittest
from xml.etree import ElementTree

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "website"
DOCS = ROOT / "docs"

PAGES = [
    "getting-started", "features", "mcp", "security", "development", "signing",
    "troubleshooting",
]


class DocsSiteTest(unittest.TestCase):
    def test_every_markdown_page_has_a_page(self):
        for slug in PAGES:
            page = SITE / "docs" / f"{slug}.html"
            self.assertTrue(page.exists(), f"missing /docs/{slug}.html")
            text = page.read_text()
            self.assertIn("<h1>", text, f"{slug}: no h1")
            # The canonical URL is what a search engine indexes; a wrong one splits rank.
            self.assertIn(f'<link rel="canonical" href="https://dbdesk.app/docs/{slug}.html">',
                          text)
            self.assertIn('"@type":"TechArticle"', text)
            self.assertIn('"@type":"BreadcrumbList"', text)
            self.assertIn("/docs/", text)
            # No repository-relative link may survive into the published page.
            self.assertNotIn('href="getting-started.md"', text)
            self.assertNotIn('href="img/', text)

    def test_no_placeholder_titles(self):
        for slug in PAGES:
            text = (SITE / "docs" / f"{slug}.html").read_text()
            self.assertNotIn(">Mcp<", text)
            self.assertNotIn(">Sql", text)

    def test_docs_index_links_every_page(self):
        index = (SITE / "docs" / "index.html").read_text()
        for slug in PAGES:
            self.assertIn(f"/docs/{slug}.html", index)

    def test_sitemap_is_valid_and_covers_docs(self):
        tree = ElementTree.parse(SITE / "sitemap.xml")
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        locs = [el.text for el in tree.findall("s:url/s:loc", ns)]
        self.assertTrue(locs)
        for path in ("https://dbdesk.app/", "https://dbdesk.app/security/",
                     "https://dbdesk.app/docs/"):
            self.assertIn(path, locs)
        for slug in PAGES:
            self.assertIn(f"https://dbdesk.app/docs/{slug}.html", locs)

    def test_every_sitemap_url_has_a_file(self):
        tree = ElementTree.parse(SITE / "sitemap.xml")
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        for loc in (el.text for el in tree.findall("s:url/s:loc", ns)):
            path = loc.removeprefix("https://dbdesk.app")
            candidate = SITE / path.strip("/")
            if path.endswith("/"):
                candidate = candidate / "index.html"
            self.assertTrue(candidate.exists(), f"sitemap lists {loc} but {candidate} is missing")

    def test_robots_points_at_the_sitemap(self):
        robots = (SITE / "robots.txt").read_text()
        self.assertIn("Sitemap: https://dbdesk.app/sitemap.xml", robots)
        self.assertIn("Allow: /", robots)

    def test_llms_txt_indexes_the_docs(self):
        llms = (SITE / "llms.txt").read_text()
        self.assertTrue(llms.startswith("# DB Desk"), "llms.txt must open with the product name")
        self.assertIn("> ", llms, "llms.txt needs a blockquote summary")
        for slug in PAGES:
            self.assertIn(f"/docs/{slug}.html", llms)
        self.assertIn("/llms-full.txt", llms)

    def test_llms_full_carries_the_markdown(self):
        full = (SITE / "llms-full.txt").read_text()
        for filename in ("getting-started.md", "features.md", "security.md"):
            heading = (DOCS / filename).read_text().splitlines()[0].lstrip("# ").strip()
            self.assertIn(heading, full)
        # Full text, not an index: every page's body should be substantially longer than
        # its description, so the file has to be bigger than the docs themselves.
        self.assertGreater(len(full), sum((DOCS / f"{s}.md").stat().st_size for s in PAGES) * 0.9)

    def test_engines_listed_match_the_backend(self):
        backend = (ROOT / "backend" / "dbdesk_api.py").read_text()
        llms = (SITE / "llms.txt").read_text()
        # A docs page that advertises an engine the app cannot open is worse than silence.
        for advertised, marker in (
            ("PostgreSQL", '"postgres"'),
            ("Amazon Redshift", '"redshift"'),
            ("CockroachDB", '"cockroachdb"'),
            ("Greenplum", '"greenplum"'),
            ("SingleStore", '"singlestore"'),
            ("Microsoft SQL Server", '"sqlserver"'),
        ):
            self.assertIn(advertised, llms)
            self.assertIn(marker, backend, f"{advertised} is advertised but not in KINDS")

    def test_generated_tree_is_committed_current(self):
        # The deploy runs the builder, so a stale copy in the repository is not fatal —
        # but it means the reviewed diff is not what ships. Compare the two.
        import subprocess
        import sys

        result = subprocess.run(
            [sys.executable, str(SITE / "tools" / "build-docs.py"), "--check"],
            capture_output=True,
            text=True,
        )
        if "No module named 'markdown'" in result.stderr:
            self.skipTest("markdown is not installed here")
        self.assertEqual(result.returncode, 0,
                         "run website/tools/build-docs.py:\n" + result.stdout + result.stderr)

    def test_docs_css_keeps_code_readable(self):
        css = (SITE / "assets" / "styles.css").read_text()
        # The base `code` rule is nowrap; without the override below, newlines collapse and
        # a four-line shell block renders as one clipped line.
        self.assertIn(".docs-body pre code { white-space: pre; }", css)
        self.assertIn(".docs-body :not(pre) > code { white-space: normal; }", css)
        self.assertRegex(css, re.compile(r"\.docs-body pre \{[^}]*overflow-x:\s*auto"))


if __name__ == "__main__":
    unittest.main()
