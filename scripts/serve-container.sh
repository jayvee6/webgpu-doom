#!/usr/bin/env bash
#
# Build the project and serve dist/ from a dedicated Apple `container` (nginx in a
# Linux VM) on http://localhost:5180. The container is decoupled from any editor /
# Claude session, so the serve port survives session churn.
#
# WebGPU itself still renders in the HOST browser (Metal) — Linux VMs have no GPU.
# This only stabilises the *serve* side. dist/ is volume-mounted, so after the first
# run you just `npm run build` again and reload the browser; the container keeps up.
#
# Usage:
#   scripts/serve-container.sh            # build + (re)serve on :5180
#   PORT=8080 scripts/serve-container.sh  # override host port
#   scripts/serve-container.sh --no-build # serve the existing dist/ as-is
set -euo pipefail

NAME="webgpu-doom-server"
PORT="${PORT:-5180}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v container >/dev/null 2>&1; then
  echo "error: Apple 'container' CLI not found (brew install --cask container)" >&2
  exit 1
fi

# Apple container services must be up or every command fails with an XPC error.
container system status >/dev/null 2>&1 || container system start

if [[ "${1:-}" != "--no-build" ]]; then
  echo "==> building dist/"
  npm run build
fi

if [[ ! -f "$ROOT/dist/index.html" ]]; then
  echo "error: dist/ not built — run without --no-build" >&2
  exit 1
fi

# (Re)create the server container. dist/ is mounted read-only; nginx serves it and
# honours range requests (the WAD loader streams via HTTP range).
container rm -f "$NAME" >/dev/null 2>&1 || true
container run -d --name "$NAME" -p "${PORT}:80" \
  -v "$ROOT/dist:/usr/share/nginx/html:ro" \
  nginx:alpine >/dev/null

echo "==> serving on http://localhost:${PORT}/  (container: ${NAME})"
echo "    rebuild with 'npm run build' and reload — the container picks up dist/ live."
echo "    stop with: container rm -f ${NAME}"
