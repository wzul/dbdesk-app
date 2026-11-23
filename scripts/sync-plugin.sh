#!/usr/bin/env bash
# Refresh the vendored copies from a local Hermes plugin checkout.
#
#   scripts/sync-plugin.sh ~/.hermes/plugins/dbdesk
set -euo pipefail

SOURCE=${1:-}
if [ -z "$SOURCE" ] || [ ! -d "$SOURCE" ]; then
  echo "usage: $0 /path/to/.hermes/plugins/dbdesk" >&2
  exit 1
fi

ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)

cp "$SOURCE/desktop/plugin.js" "$ROOT/ui/src/plugin.js"
cp "$SOURCE/dashboard/plugin_api.py" "$ROOT/backend/dbdesk_api.py"

# Re-apply the standalone storage override (the plugin version reads Hermes home).
python3 - "$ROOT/backend/dbdesk_api.py" <<'PY'
import sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read()
old = '''def _data_dir() -> Path:
    root = get_hermes_home() / "plugin-data" / "dbdesk"'''
new = '''def _data_dir() -> Path:
    override = os.environ.get("DBDESK_HOME")
    root = (
        Path(override) / "data"
        if override
        else get_hermes_home() / "plugin-data" / "dbdesk"
    )'''
if old not in text:
    raise SystemExit("adapter layout changed: update scripts/sync-plugin.sh")
text = text.replace(old, new)
text = text.replace(
    'if os.environ.get("DBDESK_NO_NOTIFY") == "1":',
    'if os.environ.get("DBDESK_NOTIFY") != "1":',
)
open(path, "w", encoding="utf-8").write(text)
PY

# Hide the MCP connection type: it needs the Hermes runtime, which the
# standalone app does not ship.
python3 - "$ROOT/ui/src/plugin.js" <<'PY'
import sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read()
old = """                        jsx('option', { value: 'sqlite', children: 'SQLite (file)' }, 'sqlite'),
                        jsx('option', { value: 'mcp', children: 'MCP (query tool)' }, 'mcp'),"""
new = """                        jsx('option', { value: 'sqlite', children: 'SQLite (file)' }, 'sqlite'),
                        ...(globalThis.__DBDESK_NO_MCP__
                          ? []
                          : [jsx('option', { value: 'mcp', children: 'MCP (query tool)' }, 'mcp')]),"""
if old not in text:
    raise SystemExit("connection form changed: update scripts/sync-plugin.sh")
open(path, "w", encoding="utf-8").write(text.replace(old, new, 1))
PY

echo "synced plugin.js (MCP hidden) and dbdesk_api.py from $SOURCE"
