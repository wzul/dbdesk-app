#!/usr/bin/env bash
# Build the Python sidecar with PyInstaller and name it for the Rust target.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

PYTHON=${PYTHON:-python3}
"$PYTHON" -m PyInstaller \
  --noconfirm --clean \
  --distpath dist-sidecar \
  --workpath build-sidecar \
  backend/dbdesk-server.spec

TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
EXT=""
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) EXT=".exe" ;;
esac

mkdir -p src-tauri/binaries
cp "dist-sidecar/dbdesk-server$EXT" "src-tauri/binaries/dbdesk-server-$TRIPLE$EXT"
echo "sidecar ready: src-tauri/binaries/dbdesk-server-$TRIPLE$EXT"
