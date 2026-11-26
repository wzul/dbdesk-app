#!/bin/sh
set -eu
apk add --no-cache ${APK_ADD:-curl jq} >/dev/null 2>&1 || true
# Mirror the current release manifest into the site tree, same-origin.
#
# Two things matter here:
#  1. Ask the API which release is latest instead of hitting
#     /releases/latest/download/latest.json — that redirect is cached and kept
#     handing back the previous release's manifest for minutes after a tag.
#  2. Write to a temp file and rename, so nginx never serves half a JSON document.

OUT=/out/latest.json
TMP=/out/.latest.json.new

while :; do
  url=$(curl -fsSL -H 'Accept: application/vnd.github+json' \
        https://api.github.com/repos/wzul/dbdesk-app/releases/latest \
        | jq -r '.assets[] | select(.name=="latest.json") | .browser_download_url' \
        | head -1 || true)

  if [ -n "${url:-}" ] && [ "$url" != "null" ]; then
    if curl -fsSL "$url" -o "$TMP"; then
      mv "$TMP" "$OUT"
      echo "$(date -u +%FT%TZ) manifest $(jq -r .version "$OUT")"
    fi
  else
    echo "$(date -u +%FT%TZ) could not resolve the latest release asset"
  fi

  rm -f "$TMP"
  sleep 900
done
