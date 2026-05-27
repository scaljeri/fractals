# Mandelbrot render backend — Jetson Orin

CUDA + FastAPI render service that runs natively on a Jetson Orin AGX
(outside any cluster). The frontend calls it via `/gpu/*` when it's reachable
and transparently falls back to client-side WebGPU when it isn't.

This README is the deployment guide. Source layout is at the bottom.

---

## Prerequisites

**On your dev machine (M5 Mac):**
- `ssh` + `rsync`
- Network reachability to the Jetson (LAN, Tailscale, or VPN)

**On the Jetson:**
- JetPack installed (CUDA toolkit + drivers)
- SSH enabled, passwordless sudo for the deploy user (used by `--restart`)
- `ffmpeg` with NVENC support (installed by `run.sh setup`)

No Docker, no k8s, no GPU operator — this is a plain systemd service.

---

## How the deploy flow works

```
  dev machine (Mac)                  Jetson Orin
  ─────────────────                  ───────────
  jetson/src/ ──► build.sh ──► jetson/build/
                                   │
                                   │ rsync (deploy.sh, over SSH)
                                   ▼
                              $JETSON_DIR/  ──► run.sh ──► systemd ──► :$JETSON_PORT
```

You edit source on your Mac. `build.sh` produces a self-contained bundle in
`jetson/build/` (source + `run.sh` launcher + systemd unit template + a
bundle README). `deploy.sh` rsyncs that bundle over SSH to the Jetson. On
the Jetson you run `bash run.sh setup` once, then enable the systemd unit —
from then on it starts on boot.

**The `.env` file lives only on your dev machine.** It tells the build/deploy
scripts three things:

1. **Where to send the bundle** — `JETSON_USER@JETSON_HOST:$JETSON_DIR` is the
   rsync target.
2. **What port to bake in** — `$JETSON_PORT` gets written into the generated
   `run.sh`, the systemd unit, and the bundle README so the whole bundle is
   internally consistent. The Jetson itself doesn't need a `.env`.
3. **Who to restart as** — `deploy.sh --restart` SSHs back in as
   `JETSON_USER` to `systemctl restart mandelbrot`.

`.env` is gitignored (only `.env.example` is committed). Change the Jetson's
IP later? Edit `.env`, run `./scripts/deploy.sh` — the bundle rebuilds with
the new values embedded.

---

## First-time deployment

### 1. Configure `.env` on your dev machine

```sh
cd jetson
cp .env.example .env
$EDITOR .env
```

Fill in:

| Var | Example | Used for |
|---|---|---|
| `JETSON_USER` | `luca` | SSH login + systemd service user |
| `JETSON_HOST` | `192.168.1.100` | rsync target (LAN IP, Tailscale name, or hostname) |
| `JETSON_DIR` | `~/mandelbrot/jetson` | Where the bundle gets rsynced on the Jetson |
| `JETSON_PORT` | `8080` | Port baked into `run.sh` / systemd unit / bundle README |

### 2. Push the bundle

```sh
./scripts/deploy.sh
```

This runs `build.sh` (produces `jetson/build/`) and `rsync`s it to
`$JETSON_USER@$JETSON_HOST:$JETSON_DIR`. The bundle contains:

- `src/` — the Python + CUDA source (compiled on first launch)
- `requirements.txt` — Python deps
- `run.sh` — setup + launch script
- `systemd/mandelbrot.service` — auto-start unit template
- `README.md` — deployment instructions with your IP/port baked in

### 3. First-run setup on the Jetson

```sh
ssh $JETSON_USER@$JETSON_HOST
cd $JETSON_DIR
bash run.sh setup     # installs system packages + Python deps
bash run.sh           # starts server on $JETSON_PORT (foreground, Ctrl-C to stop)
```

`run.sh setup` installs `python3-pip`, `ffmpeg`, `build-essential`, and
`python3-dev`, then `pip install --user -r requirements.txt`. It's idempotent
— safe to re-run after bundle updates.

### 4. Enable the systemd unit (auto-start on boot)

Once `bash run.sh` confirms the service works, install the systemd unit:

```sh
# On the Jetson, inside $JETSON_DIR
sudo cp systemd/mandelbrot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mandelbrot
sudo journalctl -u mandelbrot -f
```

The unit file has `User`, `WorkingDirectory`, and `PORT` baked in from your
`.env` at build time — no `sed` needed.

From now on the service comes up at boot and restarts on failure.

### 5. Smoke-test from your dev machine

```sh
curl http://$JETSON_HOST:$JETSON_PORT/jobs
# → {"current":null,"queue_size":0,"jobs":[]}

./scripts/test-render.sh
# Submits a 120-frame 960×540 job, polls until done, downloads mp4 to /tmp/
```

---

## Updating a running deployment

After editing anything under `src/`:

```sh
./scripts/deploy.sh --restart
```

This rebuilds the bundle, rsyncs it, and `systemctl restart`s the service.
Omit `--restart` if you'd rather restart manually.

---

## Wiring the Jetson into the frontend

The Jetson just serves HTTP on `$JETSON_PORT`. How the browser reaches it
depends on how the frontend is deployed:

| Frontend deployment | How `/gpu` gets to the Jetson |
|---|---|
| `docker compose up -d` (local dev) | Set `JETSON_URL` env before starting — the Caddy container proxies `/gpu/*` there |
| Caddy-on-VM | VM Caddyfile: `handle_path /gpu/* { reverse_proxy <jetson-ip>:$PORT }` — see [../DEPLOY.md](../DEPLOY.md) |

If the Jetson is unreachable, the frontend hides the `jetson` button
automatically (30-second health-check). No special handling needed on the
Jetson side.

### Reaching a remote Jetson

If the Jetson is at home and the frontend is in the cloud:

- **Tailscale** (easiest): both machines on your tailnet, use the Tailscale name as the host
- **Cloudflare Tunnel**: `cloudflared` exposes `$JETSON_PORT` via your CF account
- **Wireguard**: self-hosted VPN
- **Port-forward on the home router**: works but exposes the unauthenticated API to the internet — prefer one of the above

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/render` | Submit job → `{job_id, status, queue_position}` |
| `GET` | `/jobs` | List jobs + current running (also used as a health probe) |
| `GET` | `/jobs/:id` | Status + progress (poll every 1-2s) |
| `GET` | `/download/:id` | mp4 bytes (`video/mp4`) |
| `DELETE` | `/jobs/:id` | Cancel queued or remove finished |

Example `POST /render` body:
```json
{
  "center_re": "-0.743643887037151",
  "center_im": "0.131825904205330",
  "frames": 900,
  "fps": 60,
  "width": 1920,
  "height": 1080,
  "adaptive": true,
  "initial_follow_frames": 100
}
```

Coords are strings to preserve precision end-to-end (future gmpy2 upgrade).

---

## Testing

Integration tests in [tests/](tests/) talk to a running service over HTTP and
exercise the full CUDA compile + render + encode path. They catch runtime
problems that static checks miss — like `nvcc not found`, which only shows up
once systemd's stripped PATH reaches pycuda.

```sh
# one-time on your dev machine:
pip install --user -r jetson/requirements-dev.txt

# run against the default target (monster:8080):
python3 -m pytest jetson/tests -v

# or a different host:
JETSON_URL=http://192.168.2.49:8080 python3 -m pytest jetson/tests -v
```

`conftest.py` resolves the target in this order: `$JETSON_URL` →
`$JETSON_HOST:$JETSON_PORT` → `http://monster:8080`.

What they cover:
- **`test_health_endpoint_responds`** — service is up and `/jobs` has the expected shape
- **`test_minimal_render_completes`** — submits an 8-frame 320×240 job, polls to terminal, asserts `status == "done"`. On failure the Jetson's `job.error` is surfaced verbatim in the pytest output, so you don't have to SSH into the box to diagnose.
- **`test_download_returns_mp4`** — same pipeline plus validates the downloaded bytes begin with an `ftyp` MP4 box.

Quick shell smoke test (bigger job, real mp4 to `/tmp/`):
```sh
./scripts/test-render.sh
```

---

## Troubleshooting

**`nvcc: command not found` during first render**
CUDA toolkit isn't on `PATH` for the service user. The systemd unit sets
`Environment=PATH=/usr/local/cuda/bin:...` to fix this. If you re-copied an
older unit, copy the generated one from `~/dev/mandelbrot/systemd/` back and
`daemon-reload` + `restart`.

**`h264_nvenc` not found** → not an error anymore
The worker probes for `h264_nvenc` at startup and falls back to
`libx264 -threads 10` when NVENC is absent. Check `journalctl -u mandelbrot`
for the `[worker] ffmpeg encoder: …` line. To actually get NVENC, install
[jetson-ffmpeg](https://github.com/jocover/jetson-ffmpeg) — the community
build with NVIDIA hardware encoder support for Jetson.

**`cuModuleLoadDataEx failed: invalid device context`**
Someone imported `pycuda.autoinit` in the worker again — that binds a CUDA
context to the importing thread, but renders run on a different thread via
`asyncio.to_thread`. The fix is in [src/worker.py](src/worker.py): explicit
`cuda.Device(0).make_context()` per render, with pop+detach in `finally`.

**Service starts but renders never finish**
Check `journalctl -u mandelbrot -f` for CUDA OOM errors. Drop
`width`/`height` in the request, or reduce `MANDELBROT_NUM_INFLIGHT`
(default 4).

**`curl` works from the Jetson itself but not from the LAN**
`run.sh` binds `0.0.0.0` by default — if you overrode `HOST`, that's the
cause. Check `ss -tlnp | grep $JETSON_PORT` on the Jetson.

**BLA seems to do nothing at shallow zoom**
Expected. Single-level BLA (skip=16) triggers when `|w| < r_n` and w grows
slowly — at shallow zoom pixels escape before the window completes. BLA
starts paying off at zoom ~10³+. Hierarchical BLA would help further but
isn't implemented.

---

## Source layout

```
jetson/
├── src/
│   ├── kernel.cu       # CUDA kernel: FF-f32 arithmetic + BLA fast-path, Zhuoran rebasing
│   ├── server.py       # FastAPI HTTP server + asyncio job queue
│   ├── worker.py       # render worker: CUDA context per call, stream pipeline, stats
│   └── reference.py    # reference orbit + BLA table generation
├── requirements.txt
├── scripts/
│   ├── build.sh        # produces ./build/ deployment bundle
│   ├── deploy.sh       # rsyncs build/ to the Jetson (reads .env)
│   ├── test-render.sh  # end-to-end curl test
│   └── _load-env.sh    # helper, sourced by deploy.sh
├── build/              # generated — rsync target
├── .env.example        # committed template
└── .env                # gitignored, your actual config
```

Runtime state on the Jetson:
- `$JETSON_DIR/renders/` — completed mp4s
- `journalctl -u mandelbrot` — service logs
