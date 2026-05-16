#!/usr/bin/env bash
# Build a self-contained deployment bundle in ./build/
# Reads .env for JETSON_USER, JETSON_HOST, JETSON_DIR, JETSON_PORT and embeds
# them into the generated run.sh / README so the bundle is self-documenting.
#
# Usage: ./scripts/build.sh
# Then:  ./scripts/deploy.sh   (rsyncs build/ to the Jetson)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"

# Load .env if present (optional for build — deploy.sh requires it).
ENV_FILE="$ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi
# Placeholders for when .env is empty or missing — bundle remains self-documenting.
JETSON_USER="${JETSON_USER:-<user>}"; [[ -z "$JETSON_USER" ]] && JETSON_USER="<user>"
JETSON_HOST="${JETSON_HOST:-<jetson-ip>}"; [[ -z "$JETSON_HOST" ]] && JETSON_HOST="<jetson-ip>"
JETSON_DIR="${JETSON_DIR:-~/mandelbrot/jetson}"; [[ -z "$JETSON_DIR" ]] && JETSON_DIR="~/mandelbrot/jetson"
JETSON_PORT="${JETSON_PORT:-8080}"; [[ -z "$JETSON_PORT" ]] && JETSON_PORT="8080"

echo "→ cleaning $BUILD"
rm -rf "$BUILD"
mkdir -p "$BUILD/src" "$BUILD/systemd"

echo "→ copying source"
cp "$ROOT/src/"*.py     "$BUILD/src/"
cp "$ROOT/src/"*.cu     "$BUILD/src/"
cp "$ROOT/requirements.txt" "$BUILD/"

echo "→ writing run.sh (port $JETSON_PORT)"
cat > "$BUILD/run.sh" <<EOF
#!/usr/bin/env bash
# Launch the Mandelbrot render service on the Jetson.
#   bash run.sh setup   # one-time: install system packages + Python deps
#   bash run.sh         # every run
set -euo pipefail

ROOT="\$(cd "\$(dirname "\$0")" && pwd)"
cd "\$ROOT"

# pycuda needs nvcc at runtime — Jetson CUDA toolkit lives here by default.
export PATH="/usr/local/cuda/bin:\$PATH"

if [[ "\${1-}" == "setup" ]]; then
  echo "→ installing system packages (sudo)"
  sudo apt update
  sudo apt install -y python3-pip ffmpeg build-essential python3-dev python3-venv
  if [[ ! -d "\$ROOT/venv" ]]; then
    echo "→ creating venv at \$ROOT/venv"
    python3 -m venv "\$ROOT/venv"
  fi
  echo "→ installing Python deps into venv"
  "\$ROOT/venv/bin/pip" install --upgrade pip
  "\$ROOT/venv/bin/pip" install -r requirements.txt
  echo "✓ setup done — now run: bash run.sh"
  exit 0
fi

# Prefer the bundle's venv if it exists, else fall back to system python3.
if [[ -x "\$ROOT/venv/bin/python" ]]; then
  PYTHON="\$ROOT/venv/bin/python"
else
  PYTHON="python3"
fi

PORT="\${PORT:-$JETSON_PORT}"
HOST="\${HOST:-0.0.0.0}"
echo "→ starting server on \$HOST:\$PORT"
exec "\$PYTHON" -m uvicorn src.server:app --host "\$HOST" --port "\$PORT"
EOF
chmod +x "$BUILD/run.sh"

echo "→ rendering systemd unit from template"
sed \
  -e "s|@JETSON_USER@|$JETSON_USER|g" \
  -e "s|@JETSON_DIR@|$JETSON_DIR|g" \
  -e "s|@JETSON_PORT@|$JETSON_PORT|g" \
  "$ROOT/systemd/mandelbrot.service" > "$BUILD/systemd/mandelbrot.service"

echo "→ writing deploy README"
cat > "$BUILD/README.md" <<EOF
# Mandelbrot render backend — deployment bundle

Copy this folder to the Jetson (e.g. \`$JETSON_DIR\`), then:

\`\`\`sh
cd $JETSON_DIR
bash run.sh setup       # one-time
bash run.sh             # starts server on :$JETSON_PORT
\`\`\`

For auto-start on boot:

\`\`\`sh
sudo cp systemd/mandelbrot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mandelbrot
sudo journalctl -u mandelbrot -f
\`\`\`

## Browser client

In \`http://localhost:8765\`, click **jetson** and enter:

\`\`\`
http://$JETSON_HOST:$JETSON_PORT
\`\`\`

## API

- \`POST /render\` — submit job
- \`GET /jobs/:id\` — poll status
- \`GET /download/:id\` — fetch mp4
- \`DELETE /jobs/:id\` — cancel/remove

Renders land in \`./renders/\` relative to this directory.
EOF

echo "✓ build complete at $BUILD"
if [[ "$JETSON_HOST" == "<jetson-ip>" ]]; then
  echo ""
  echo "  (.env not filled in — the bundle contains placeholders)"
  echo "  Fill in .env and rebuild to embed your IP into the bundle README."
else
  echo ""
  echo "  Deploy with:  ./scripts/deploy.sh"
  echo "  Target:       $JETSON_USER@$JETSON_HOST:$JETSON_DIR"
fi
