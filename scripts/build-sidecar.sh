#!/usr/bin/env bash
# Build the Python sidecar (onedir) and stage it for the Tauri bundle.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

PYTHON=${PYTHON:-python3}
"$PYTHON" -m PyInstaller \
  --noconfirm --clean \
  --distpath dist-sidecar \
  --workpath build-sidecar \
  backend/dbdesk-server.spec

# Tauri copies bundle.resources into the app; stage a clean copy.
rm -rf src-tauri/sidecar
mkdir -p src-tauri/sidecar
cp -R dist-sidecar/dbdesk-server src-tauri/sidecar/dbdesk-server

echo "sidecar ready: src-tauri/sidecar/dbdesk-server/dbdesk-server"
