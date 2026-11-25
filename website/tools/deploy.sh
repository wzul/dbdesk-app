#!/usr/bin/env bash
# Publish the static site to the web host and reload nginx.
#
# The host is never hard-coded: this script lives in a public repo, so the target
# comes from DBDESK_WEB_HOST (an ssh destination, e.g. root@host) at run time.
#
#   DBDESK_WEB_HOST=root@<host> website/tools/deploy.sh
#
# It only ever writes ./site and ./nginx; cloudflared/ (tunnel credentials) is
# created once by hand and is never touched here.
set -euo pipefail

HOST="${DBDESK_WEB_HOST:?set DBDESK_WEB_HOST (ssh destination)}"
REMOTE_DIR="${DBDESK_WEB_DIR:-/opt/dbdesk-web}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "== syncing site → ${HOST}:${REMOTE_DIR}/site"
rsync -az --delete \
  --exclude 'preview-*.png' \
  --exclude 'tools' \
  --exclude 'deploy' \
  "$HERE/" "${HOST}:${REMOTE_DIR}/site/"

echo "== syncing nginx config"
rsync -az "$HERE/deploy/nginx/" "${HOST}:${REMOTE_DIR}/nginx/"

echo "== recreating web container"
ssh "$HOST" "cd ${REMOTE_DIR} && docker compose up -d --force-recreate web && docker compose ps"

echo "== smoke test from the host"
ssh "$HOST" "docker exec dbdesk-web wget -q -S -O /dev/null http://127.0.0.1/index.html 2>&1 | head -20"

echo "done"
