#!/usr/bin/env bash
# Fetch the Freedoom IWADs into public/ so Vite serves them same-origin (no CORS).
# WADs are gitignored — this is the canonical way to (re)hydrate assets.
set -euo pipefail

VERSION="${FREEDOOM_VERSION:-0.13.0}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public"
URL="https://github.com/freedoom/freedoom/releases/download/v${VERSION}/freedoom-${VERSION}.zip"
ZIP="$(mktemp -t freedoom-XXXX).zip"

if [[ -f "$DEST/freedoom1.wad" ]]; then
  echo "freedoom1.wad already present in public/ — skipping (delete it to re-fetch)."
  exit 0
fi

echo "Downloading Freedoom v${VERSION}…"
curl -fL --progress-bar "$URL" -o "$ZIP"

echo "Extracting WADs → $DEST"
# The zip contains freedoom-<ver>/freedoom1.wad and freedoom2.wad
unzip -j -o "$ZIP" '*/freedoom1.wad' '*/freedoom2.wad' -d "$DEST"
rm -f "$ZIP"

echo "Done:"
ls -lh "$DEST"/*.wad
