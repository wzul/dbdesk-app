#!/usr/bin/env python3
"""Generate the Hermes plugin from the app sources.

DB Desk ships twice: as the standalone app (this repo) and as a Hermes plugin.
Keeping two copies of 18k lines in two repositories meant a sync script that had
to rewrite code after copying — which is how the plugin repo drifted to a v0.1.0
release while the plugin itself was at 0.8.11.

So this repo is the single source of truth and `plugin/` is generated:

    ui/src/plugin.js        → plugin/desktop/plugin.js      (verbatim)
    backend/dbdesk_api.py   → plugin/dashboard/plugin_api.py (Hermes storage,
                                                             opt-in notifications)

Everything else under plugin/ (metadata, docs, the plugin's own test suite) is
authored here and copied by hand, not generated.

    python3 scripts/build-plugin.py           # write plugin/
    python3 scripts/build-plugin.py --check   # fail if plugin/ is stale (CI)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugin"

# The app stores data under DBDESK_HOME (or the OS app-data folder); the plugin
# lives inside Hermes and uses its plugin-data directory unless overridden. The
# app version is the "new" text here, so generating the plugin means going back to
# the Hermes wording.
APP_DATA_DIR = '''def _data_dir() -> Path:
    override = os.environ.get("DBDESK_HOME")
    root = (
        Path(override) / "data"
        if override
        else get_hermes_home() / "plugin-data" / "dbdesk"
    )'''

PLUGIN_DATA_DIR = '''def _data_dir() -> Path:
    root = get_hermes_home() / "plugin-data" / "dbdesk"'''

REPLACEMENTS: list[tuple[str, str, str]] = [
    ("backend/dbdesk_api.py", APP_DATA_DIR, PLUGIN_DATA_DIR),
    # Notifications are opt-in inside Hermes; the standalone app has them on.
    (
        "backend/dbdesk_api.py",
        'if os.environ.get("DBDESK_NOTIFY") != "1":',
        'if os.environ.get("DBDESK_NO_NOTIFY") == "1":',
    ),
]

COPIES: list[tuple[str, str]] = [
    ("ui/src/plugin.js", "plugin/desktop/plugin.js"),
]


def plugin_version() -> str:
    import re

    text = (PLUGIN / "plugin.yaml").read_text(encoding="utf-8")
    match = re.search(r'^version:\s*"?([^"\n]+)"?', text, re.MULTILINE)
    if not match:
        raise SystemExit("plugin/plugin.yaml has no version")
    return match.group(1).strip()


def generated_files() -> dict[Path, str]:
    """path → expected content, everything `--check` compares against."""
    out: dict[Path, str] = {}

    # dashboard/manifest.json carries its own copy of the version; deriving it from
    # plugin.yaml is the difference between one version and two that disagree.
    import json

    manifest_path = PLUGIN / "dashboard" / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["version"] = plugin_version()
        out[manifest_path] = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"

    for source, target in COPIES:
        out[ROOT / target] = (ROOT / source).read_text(encoding="utf-8")

    patches: dict[str, list[tuple[str, str]]] = {}
    for source, old, new in REPLACEMENTS:
        patches.setdefault(source, []).append((old, new))

    for source, rules in patches.items():
        text = (ROOT / source).read_text(encoding="utf-8")
        for old, new in rules:
            if old not in text:
                raise SystemExit(
                    f"{source}: expected block not found — update scripts/build-plugin.py\n"
                    f"  looked for: {old.splitlines()[0]}"
                )
            text = text.replace(old, new)
        out[ROOT / "plugin/dashboard/plugin_api.py"] = text

    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify, do not write")
    args = parser.parse_args()

    stale: list[str] = []
    for path, content in generated_files().items():
        current = path.read_text(encoding="utf-8") if path.exists() else ""
        if current == content:
            continue
        if args.check:
            stale.append(str(path.relative_to(ROOT)))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        print(f"wrote {path.relative_to(ROOT)}")

    if args.check and stale:
        print("plugin/ is out of date:", ", ".join(stale), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
