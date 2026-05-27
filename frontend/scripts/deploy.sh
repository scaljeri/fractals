#!/usr/bin/env bash
# Sync the static frontend to the deploy target configured in frontend/.env.
#
# Usage:
#   ./scripts/deploy.sh             # rsync everything
#   ./scripts/deploy.sh --dry-run   # show what would change without copying
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/_load-env.sh"

EXTRA_FLAGS=()
if [[ "${1-}" == "--dry-run" ]]; then
  EXTRA_FLAGS+=(--dry-run)
fi
# Allow RSYNC_FLAGS from .env (space-separated).
if [[ -n "${RSYNC_FLAGS:-}" ]]; then
  # shellcheck disable=SC2206
  EXTRA_FLAGS+=($RSYNC_FLAGS)
fi

REMOTE="$DEPLOY_USER@$DEPLOY_HOST"
echo "→ syncing frontend/ to $REMOTE:$DEPLOY_DIR"
# No --delete by default: the target dir may be shared with other apps.
# Add RSYNC_FLAGS="--delete" in .env if you want a strict mirror.
rsync -av \
  --exclude '.env' \
  --exclude '.env.example' \
  --exclude 'config.local.js' \
  --exclude 'config.example.js' \
  --exclude 'node_modules/' \
  --exclude 'scripts/' \
  --exclude '*.ppm' \
  --exclude 'test-*.mjs' \
  --exclude 'tr-bruteforce.mjs' \
  --exclude 'render-sample.mjs' \
  --exclude 'package.json' \
  --exclude 'package-lock.json' \
  "${EXTRA_FLAGS[@]}" \
  "$ROOT/" "$REMOTE:$DEPLOY_DIR/"

echo "✓ deployed to $REMOTE:$DEPLOY_DIR"
