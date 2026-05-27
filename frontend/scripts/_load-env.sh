#!/usr/bin/env bash
# Source this from other shell scripts to load frontend/.env.
# Usage: source "$(dirname "$0")/_load-env.sh"
set -euo pipefail

ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${DEPLOY_USER:?DEPLOY_USER not set in .env}"
: "${DEPLOY_HOST:?DEPLOY_HOST not set in .env}"
: "${DEPLOY_DIR:?DEPLOY_DIR not set in .env}"
: "${RSYNC_FLAGS:=}"
