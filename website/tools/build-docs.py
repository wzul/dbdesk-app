#!/usr/bin/env python3
"""Render the repository's markdown documentation into the website.

The docs in `docs/` are the source of truth: they ship next to the code, they are what a
contributor edits, and they are already what GitHub shows. Publishing a second copy by
hand is how documentation drifts, so this script turns them into pages under
`website/docs/` at deploy time instead — plus the machine-readable files a site needs to
be read by search engines and by models:

    website/docs/index.html, website/docs/<slug>.html
    website/sitemap.xml
    website/robots.txt
    website/llms.txt          (llmstxt.org index: what the product is, where to read more)
    website/llms-full.txt     (every doc in full, for an agent that wants it all at once)

Relative markdown links are rewritten to website URLs, so `features.md` becomes
`/docs/features.html` and `../SECURITY.md` becomes the GitHub blob URL.

    python3 website/tools/build-docs.py            # write
    python3 website/tools/build-docs.py --check    # fail if the output would change

`markdown` is the only dependency: `pip install markdown` (it is not needed at runtime by
the app, only by whoever publishes the site).
"""

from __future__ import annotations

import argparse
import html
import pathlib
import re
import sys

try:
    import markdown
except ModuleNotFoundError:  # pragma: no cover - deployment-time dependency
    sys.exit("build-docs.py needs the `markdown` package: pip install markdown")

ROOT = pathlib.Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
SITE = ROOT / "website"
SITE_URL = "https://dbdesk.app"
REPO_BLOB = "https://github.com/wzul/dbdesk-app/blob/main"

# Curated order and titles: the filename already holds the slug, but "MCP server" reads
# better than "mcp" and the sidebar order should be the reading order, not the alphabet.
PAGES = [
    ("getting-started", "getting-started.md", "Install DB Desk and connect a database.",
     "Getting started"),
    ("features", "features.md", "Everything in the app, screen by screen.", "Features"),
    ("mcp", "mcp.md", "Expose your databases to local agents over MCP.", "MCP server"),
    ("security", "security.md", "What DB Desk reaches, what leaves your machine, threat model.",
     "Security"),
    ("development", "development.md", "Build from source, run the suite, package.", "Development"),
    ("signing", "signing.md", "Sign and notarize a release.", "Signing"),
    ("troubleshooting", "troubleshooting.md", "Symptom, cause, fix.", "Troubleshooting"),
]

PRODUCT = "DB Desk"
TAGLINE = (
    "A native, keyboard-first database browser for macOS, Windows and Linux. "
    "Read-only until you say otherwise, credentials encrypted on your machine, "
    "one window for every engine you touch."
)

# Engines the app actually opens today. Kept here so the docs and llms.txt describe the
# shipping product rather than an intention; see `KINDS` in backend/dbdesk_api.py.
ENGINES = [
    "PostgreSQL", "Amazon Redshift", "CockroachDB", "Greenplum",
    "MySQL", "MariaDB", "SingleStore", "Microsoft SQL Server",
    "ClickHouse", "SQLite", "DuckDB", "Elasticsearch", "InfluxDB 3", "libSQL",
    "Cloudflare D1", "MongoDB", "Redis / Valkey", "MCP servers", "HTTP SQL gateways",
]

NAV = """<header class="nav">
  <div class="wrap nav-inner">
    <a class="brand" href="/">
      <svg style="color:var(--primary)"><use href="#i-mark"/></svg>
      DB Desk
    </a>
    <nav class="nav-links">
      <a href="/#features">Features</a>
      <a href="/#databases">Databases</a>
      <a href="/#ai">AI</a>
      <a href="/#mcp">MCP</a>
      <a href="/security/">Security</a>
      <a href="/docs/"%(docs_current)s>Docs</a>
      <a href="/#download">Download</a>
    </nav>
    <div class="nav-actions">
      <a class="btn btn-ghost" href="https://github.com/wzul/dbdesk-app" target="_blank" rel="noopener">
        <svg><use href="#i-github"/></svg> GitHub
      </a>
      <a class="btn btn-primary" href="https://github.com/wzul/dbdesk-app/releases/latest">Download</a>
    </div>
    <details class="nav-mobile">
      <summary aria-label="Menu" role="button"><svg class="i-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg><svg class="i-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></summary>
      <div class="nav-mobile-panel">
        <a href="/#features">Features</a>
        <a href="/#databases">Databases</a>
        <a href="/#ai">AI</a>
        <a href="/#mcp">MCP</a>
        <a href="/security/">Security</a>
        <a href="/docs/%(docs_current)s>Docs</a>
        <a href="https://github.com/wzul/dbdesk-app" target="_blank" rel="noopener">Source on GitHub</a>
      </div>
    </details>
  </div>
</header>
"""

FOOTER = """<footer>
  <div class="wrap foot">
    <div class="foot-brand">
      <svg style="color:var(--primary)"><use href="#i-mark"/></svg>
      <span>DB Desk · dbdesk.app — a native database browser for macOS, Windows and Linux</span>
    </div>
    <div class="foot-links">
      <a href="https://github.com/wzul/dbdesk-app" target="_blank" rel="noopener">Source</a>
      <a href="/docs/"%(docs_current)s>Docs</a>
      <a href="https://github.com/wzul/dbdesk-app/releases" target="_blank" rel="noopener">Releases</a>
      <a href="/security/">Security</a>
      <a href="https://github.com/wzul/dbdesk-app/issues" target="_blank" rel="noopener">Issues</a>
    </div>
    <div>© <span id="year">2026</span> DB Desk</div>
  </div>
</footer>
"""

SYMBOLS = """<svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
  <defs>
    <symbol id="i-mark" viewBox="0 0 24 24">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="currentColor" opacity=".12"/>
      <ellipse cx="12" cy="7.4" rx="5.1" ry="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <path d="M6.9 7.4v9.2c0 1.2 2.3 2.2 5.1 2.2s5.1-1 5.1-2.2V7.4" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <path d="M6.9 12c0 1.2 2.3 2.2 5.1 2.2s5.1-1 5.1-2.2" fill="none" stroke="currentColor" stroke-width="1.5"/>
    </symbol>
    <symbol id="i-github" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2.2a9.8 9.8 0 0 0-3.1 19.1c.5.1.7-.2.7-.5v-1.9c-2.7.6-3.3-1.2-3.3-1.2-.4-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.3-1.1.6-1.4-2.2-.3-4.5-1.1-4.5-4.9 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.8-2.3 4.6-4.5 4.9.4.3.7 1 .7 2v2.9c0 .3.2.6.7.5A9.8 9.8 0 0 0 12 2.2Z"/>
    </symbol>
  </defs>
</svg>
"""


def slugify(text: str, separator: str = "-") -> str:
    """Anchor ids the toc extension and our links agree on. markdown calls this as
    slugify(value, separator), so the separator has to be a parameter."""
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[^\w\s-]", "", text.lower()).strip()
    return re.sub(r"[\s_]+", separator, text)


def rewrite_links(body: str) -> str:
    """Point markdown links at website URLs instead of repository paths."""

    def repl(match: re.Match[str]) -> str:
        href = match.group(1)
        if href.startswith(("http://", "https://", "/", "#", "mailto:")):
            return match.group(0)
        name = href.split("#", 1)[0]
        anchor = "#" + href.split("#", 1)[1] if "#" in href else ""
        if name.endswith(".md") and name.startswith("../"):
            return 'href="%s/%s%s"' % (REPO_BLOB, name[3:], anchor)
        if name.endswith(".md"):
            slug = name[:-3]
            if slug in {p[0] for p in PAGES}:
                return 'href="/docs/%s.html%s"' % (slug, anchor)
            if slug == "README":
                return 'href="/docs/%s"' % anchor
        if name.startswith("img/"):
            return 'href="/assets/img/%s%s"' % (name[4:].replace(".png", ".webp"), anchor)
        return match.group(0)

    body = re.sub(r'href="([^"]+)"', repl, body)
    # Raw <img src="img/x.png"> tags bypass the link rewrite.
    body = re.sub(
        r'(<img[^>]*\ssrc=")img/([^"]+)\.png(")',
        lambda m: f'{m.group(1)}/assets/img/{m.group(2)}.webp{m.group(3)}',
        body,
    )
    # A wide table scrolls inside its own box instead of widening the page on a phone.
    body = body.replace("<table>", '<div class="table-wrap"><table>').replace(
        "</table>", "</table></div>"
    )
    # Screenshots are the heaviest asset on a docs page; let the text paint first.
    body = body.replace("<img ", '<img loading="lazy" decoding="async" ')
    body = re.sub(r'<img([^>]*?)src="(/assets/img/([^"/]+))\.webp"([^>]*)>', _srcset, body)
    return body


def _srcset(match: re.Match[str]) -> str:
    """Add a 900px variant when one was generated next to the full-size screenshot."""
    before, src, name, after = match.group(1), match.group(2), match.group(3), match.group(4)
    small = SITE / "assets" / "img" / f"{name}-900.webp"
    if not small.exists():
        return f'<img{before}src="{src}.webp"{after}>'
    return (
        f'<img{before}src="{src}.webp" '
        f'srcset="{src}-900.webp 900w, {src}.webp 2392w" '
        f'sizes="(max-width: 760px) 92vw, 700px"{after}>'
    )


def render(markdown_text: str) -> tuple[str, list[tuple[int, str, str]]]:
    """Render one document and return (html, [(level, id, text)] headings)."""
    md = markdown.Markdown(
        extensions=["tables", "fenced_code", "toc", "sane_lists", "attr_list", "md_in_html"],
        extension_configs={"toc": {"slugify": slugify, "permalink": False}},
    )
    body = rewrite_links(md.convert(markdown_text))
    toc = [(int(entry["level"]), str(entry["id"]), str(entry["name"]))
           for entry in getattr(md, "toc_tokens", [])]
    return body, toc


def page_html(
    *,
    title: str,
    description: str,
    canonical: str,
    body: str,
    toc: list[tuple[int, str, str]],
    source: str,
    docs_current: str = ' aria-current="page"',
) -> str:
    crumbs = (
        '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":['
        '{"@type":"ListItem","position":1,"name":"DB Desk","item":"%s/"},'
        '{"@type":"ListItem","position":2,"name":"Docs","item":"%s/docs/"},'
        '{"@type":"ListItem","position":3,"name":"%s","item":"%s"}]}'
        % (SITE_URL, SITE_URL, html.escape(title), canonical)
    )
    article = (
        '{"@context":"https://schema.org","@type":"TechArticle","headline":"%s",'
        '"description":"%s","url":"%s","isPartOf":{"@type":"WebSite","name":"DB Desk",'
        '"url":"%s/"},"publisher":{"@type":"Organization","name":"DB Desk"}}'
        % (html.escape(title), html.escape(description), canonical, SITE_URL)
    )
    toc_html = ""
    if toc:
        items = "".join(
            f'<a class="docs-toc-l{lvl}" href="#{anchor}">{html.escape(text)}</a>'
            for lvl, anchor, text in toc
            if lvl <= 3
        )
        toc_html = '<aside class="docs-toc"><p class="docs-toc-title">On this page</p>%s</aside>' % items
    current = canonical.rsplit("/", 1)[-1].removesuffix(".html")
    sidebar = "".join(
        '<a class="docs-nav-item%s" href="/docs/%s.html">%s</a>'
        % (" is-active" if slug == current else "", slug, title)
        for slug, _, _, title in PAGES
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} — DB Desk docs</title>
<meta name="description" content="{html.escape(description)}">
<link rel="canonical" href="{canonical}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1115" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="article">
<meta property="og:url" content="{canonical}">
<meta property="og:site_name" content="DB Desk">
<meta property="og:title" content="{html.escape(title)} — DB Desk docs">
<meta property="og:description" content="{html.escape(description)}">
<meta property="og:image" content="{SITE_URL}/assets/img/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/favicon.svg">
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
<link rel="stylesheet" href="/assets/styles.css">
<script src="/assets/site.js" defer></script>
<script type="application/ld+json">{crumbs}</script>
<script type="application/ld+json">{article}</script>
</head>
<body>
{SYMBOLS}
{NAV % {"docs_current": docs_current}}
<main class="docs">
  <div class="wrap docs-grid">
    <nav class="docs-nav" aria-label="Documentation">
      <a class="docs-nav-item{' is-active' if canonical.endswith('/docs/') else ''}" href="/docs/">Overview</a>
      {sidebar}
    </nav>
    <article class="docs-body prose">
      <h1>{html.escape(title)}</h1>
{body}
      <p class="docs-edit"><a href="{REPO_BLOB}/{source}" target="_blank" rel="noopener">Edit this page on GitHub</a></p>
    </article>
    {toc_html}
  </div>
</main>
{FOOTER % {"docs_current": docs_current}}
</body>
</html>
"""


def docs_index() -> str:
    cards = "".join(
        '<a class="docs-card" href="/docs/%s.html"><strong>%s</strong><span>%s</span></a>'
        % (slug, html.escape(title), html.escape(description))
        for slug, _, description, title in PAGES
    )
    engines = ", ".join(ENGINES)
    body = f"""      <h1>Documentation</h1>
      <p>{html.escape(TAGLINE)}</p>
      <p>These pages are generated from the markdown in the repository, so what you read
        here is what ships with the code. Every page has an “Edit this page” link.</p>
      <h2>Engines</h2>
      <p>{html.escape(engines)}.</p>
      <p>Anything that speaks the PostgreSQL or MySQL protocol works under its own name —
        Redshift and CockroachDB use the PostgreSQL path, SingleStore the MySQL one — and a
        generic HTTP SQL gateway or an MCP server covers the rest.</p>
      <div class="docs-cards">{cards}</div>
      <h2>For machines</h2>
      <p><a href="/llms.txt">llms.txt</a> is a short index for language models,
        <a href="/llms-full.txt">llms-full.txt</a> carries every page in full, and
        <a href="/sitemap.xml">sitemap.xml</a> lists the site.</p>"""
    return page_html(
        title="Documentation",
        description="DB Desk documentation: install, features, MCP server, security model, "
                    "build from source, signing and troubleshooting.",
        canonical=f"{SITE_URL}/docs/",
        body=body,
        toc=[],
        source="docs/README.md",
        docs_current=' aria-current="page"',
    )


def build() -> dict[pathlib.Path, str]:
    out: dict[pathlib.Path, str] = {}
    listing = []
    for slug, filename, description, title in PAGES:
        source = DOCS / filename
        text = source.read_text()
        # Drop the repository's own "back to the README" link: the sidebar does that job.
        text = re.sub(r"^\[← Back to the README\]\(\.\./README\.md\).*$\n?", "", text, count=1,
                      flags=re.MULTILINE)
        # The first H1 becomes the page title in the template.
        text = re.sub(r"^# .*\n", "", text, count=1, flags=re.MULTILINE)
        body, toc = render(text)
        canonical = f"{SITE_URL}/docs/{slug}.html"
        out[SITE / "docs" / f"{slug}.html"] = page_html(
            title=title,
            description=description,
            canonical=canonical,
            body=body,
            toc=toc,
            source=f"docs/{filename}",
        )
        listing.append((slug, title, description, canonical))

    out[SITE / "docs" / "index.html"] = docs_index()

    urls = [
        ("/", "weekly", "1.0"),
        ("/security/", "monthly", "0.8"),
        ("/docs/", "weekly", "0.9"),
    ] + [(f"/docs/{slug}.html", "monthly", "0.7") for slug, _, _, _ in listing]

    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for path, freq, priority in urls:
        sitemap.append(
            f"  <url><loc>{SITE_URL}{path}</loc><changefreq>{freq}</changefreq>"
            f"<priority>{priority}</priority></url>"
        )
    sitemap.append("</urlset>")
    out[SITE / "sitemap.xml"] = "\n".join(sitemap) + "\n"

    out[SITE / "robots.txt"] = (
        "# Every page is meant to be read by people and by machines; nothing here is\n"
        "# gated. llms.txt is the short map, llms-full.txt the whole thing.\n"
        "User-agent: *\n"
        "Allow: /\n"
        f"\nSitemap: {SITE_URL}/sitemap.xml\n"
    )

    # llms.txt — llmstxt.org: H1, blockquote summary, sections of links.
    llms = [
        f"# {PRODUCT}",
        "",
        f"> {TAGLINE}",
        "",
        f"Engines: {', '.join(ENGINES)}.",
        "",
        "Read-only by default; writes need an explicit toggle, and production connections "
        "need a single-use approval bound to a hash of the exact statement. Credentials are "
        "encrypted at rest on the user's machine, and the AI features send schema and SQL, "
        "never rows, values or keys.",
        "",
        "## Docs",
    ]
    for slug, title, description, canonical in listing:
        llms.append(f"- [{title}]({canonical}): {description}")
    llms += [
        f"- [Security model]({SITE_URL}/security/): what leaves the machine, measured, "
        "with the script that reproduces the numbers.",
        "",
        "## Machine-readable",
        f"- [llms-full.txt]({SITE_URL}/llms-full.txt): every docs page in full.",
        f"- [sitemap.xml]({SITE_URL}/sitemap.xml): all pages.",
        f"- [Source](https://github.com/wzul/dbdesk-app): MIT, public, including the "
        "release pipeline and its signing steps.",
        "",
    ]
    out[SITE / "llms.txt"] = "\n".join(llms)

    full = [f"# {PRODUCT} — full documentation", "", f"> {TAGLINE}", "",
            f"Engines: {', '.join(ENGINES)}.", ""]
    for slug, title, description, canonical in listing:
        text = (DOCS / dict((p[0], p[1]) for p in PAGES)[slug]).read_text()
        text = re.sub(r"^\[← Back to the README\]\(\.\./README\.md\).*$\n?", "", text,
                      count=1, flags=re.MULTILINE)
        full.append(f"\n\n---\n\n# {title}\n\nSource: {canonical}\n\n{text.strip()}")
    out[SITE / "llms-full.txt"] = "\n".join(full) + "\n"
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="fail when the committed output differs from a rebuild")
    args = parser.parse_args()

    files = build()
    changed = []
    for path, content in files.items():
        current = path.read_text() if path.exists() else None
        if current != content:
            changed.append(path)
            if not args.check:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)

    for path in sorted(changed):
        print(("would write " if args.check else "wrote ") + str(path.relative_to(ROOT)))
    if not changed:
        print("docs up to date")
    if args.check and changed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
