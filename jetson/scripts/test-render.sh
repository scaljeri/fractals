#!/usr/bin/env bash
# End-to-end test: submit a short render to the Jetson and download the result.
# Reads target host from .env (override with $1).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/_load-env.sh"

HOST="${1:-$JETSON_HOST:$JETSON_PORT}"
echo "→ testing http://$HOST"

JOB=$(curl -s -X POST "http://$HOST/render" \
  -H 'Content-Type: application/json' \
  -d '{
    "center_re": "-0.743643887037151",
    "center_im": "0.131825904205330",
    "frames": 120,
    "fps": 60,
    "width": 960,
    "height": 540,
    "adaptive": true,
    "initial_follow_frames": 50
  }')
echo "submitted: $JOB"

ID=$(printf '%s' "$JOB" | sed -E 's/.*"job_id":"([^"]+)".*/\1/')
echo "polling job $ID..."

while true; do
  S=$(curl -s "http://$HOST/jobs/$ID")
  STATUS=$(printf '%s' "$S" | sed -E 's/.*"status":"([^"]+)".*/\1/')
  PROG=$(printf '%s' "$S" | sed -E 's/.*"progress":([0-9.]+).*/\1/')
  printf '  %s  %5.1f%%\n' "$STATUS" "$(awk "BEGIN{print $PROG * 100}")"
  if [[ "$STATUS" =~ ^(done|failed|cancelled)$ ]]; then break; fi
  sleep 2
done

if [[ "$STATUS" == "done" ]]; then
  OUT="/tmp/mandelbrot-jetson-$ID.mp4"
  curl -s -o "$OUT" "http://$HOST/download/$ID"
  echo "✓ downloaded: $OUT"
  ls -lh "$OUT"
else
  echo "✗ render did not complete: $STATUS"
  exit 1
fi
