#!/usr/bin/env bash
# Build the bundle and rsync it to the Jetson (configured via .env).
#
# Usage:
#   ./scripts/deploy.sh             # build + sync
#   ./scripts/deploy.sh --restart   # also restart the systemd service after sync
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/_load-env.sh"

# Build first
"$ROOT/scripts/build.sh"

REMOTE="$JETSON_USER@$JETSON_HOST"
echo "→ syncing build/ to $REMOTE:$JETSON_DIR"
ssh "$REMOTE" "mkdir -p $JETSON_DIR"
rsync -av --delete \
  --exclude renders/ \
  --exclude venv/ \
  --exclude __pycache__/ \
  "$ROOT/build/" "$REMOTE:$JETSON_DIR/"

if [[ "${1-}" == "--restart" ]]; then
  echo "→ restarting systemd service"
  ssh "$REMOTE" "sudo systemctl restart mandelbrot && sudo systemctl status mandelbrot --no-pager -l | head -20"
fi

echo "✓ deployed"
echo "  Test from M5: ./scripts/test-render.sh"
echo "  Or browser:   http://$JETSON_HOST:$JETSON_PORT"
