# AGENTS.md

Onboarding for AI coders (and humans) working in this repo.

## What this project is

A browser-based Mandelbrot fractal explorer with infinite zoom, built on
**WebGPU** using **perturbation theory + DD (double-float) arithmetic**.
Optionally records zoom videos client-side via WebCodecs, or offloads heavy
renders to an external **Jetson Orin AGX** running a CUDA + NVENC backend.

Stack summary:
- Frontend: a single-page WebGPU app, no build step (ES modules + CDN imports).
- Backend (optional): FastAPI + CUDA kernel on a Jetson, reachable via `/gpu/*`.
- Ship target: any static host serving the frontend; Jetson stays separate.

## Folder layout

```
mandelbrot/
├── frontend/            # browser app (WebGPU, WGSL, decimal.js)
│   ├── index.html       # HUD + controls
│   ├── main.js          # shader, perturbation, record pipeline (~49 KB)
│   └── test-perturbation.mjs   # Node validation of the math
├── jetson/              # CUDA + FastAPI render service (native deploy on Jetson)
│   ├── src/             # server.py, worker.py, kernel.cu, reference.py
│   ├── scripts/         # build.sh, deploy.sh, test-render.sh
│   └── README.md
├── Dockerfile           # Caddy image: frontend + /gpu proxy (dev convenience)
├── Caddyfile            # Caddy config used by the image and docker compose
├── Caddyfile.example    # Standalone template for Caddy-on-VM setups
├── docker-compose.yml   # Local dev orchestration
├── DEPLOY.md            # Deployment guide (Caddy-on-VM)
└── MEMORY.md            # Architecture decisions + current feature state
```

## Architecture

```
 ┌────────┐          ┌────────────────────┐          ┌──────────────────┐
 │browser │──https──▶│ reverse proxy        │──────▶│ frontend (static)│
 │        │          │  <your-domain>       │          │ WebGPU app       │
 │        │          │                      │          └──────────────────┘
 │        │          │  /gpu/* ─────┐       │
 └────────┘          └──────────────┼──────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │  Jetson Orin AGX     │
                         │  FastAPI + CUDA      │
                         │  (LAN / tunnel)      │
                         └──────────────────────┘
```

- `<your-domain>/` → static `frontend/` (Caddy, nginx, S3, GH Pages, …)
- `<your-domain>/gpu/*` → reverse-proxied to the Jetson (LAN / Tailscale / tunnel)

Per-machine specifics (production hostname, Jetson LAN URL, deploy target)
live in **gitignored** files: `frontend/config.local.js`, `frontend/.env`, and
`jetson/.env`. Tracked `*.example` files document the schemas.

## How to run locally

```bash
docker compose up -d
# → http://localhost:8080
```

That brings up one Caddy container that:
- Serves `frontend/` as static files (bind-mounted, so edits are live)
- Proxies `/gpu/*` to `$JETSON_URL` (default `http://host.docker.internal:8080`)

Point the proxy somewhere real by exporting `JETSON_URL` before
`docker compose up -d`, e.g. `export JETSON_URL=http://10.0.0.42:8080`. If no
backend is reachable, the frontend health check hides the GPU-record button
automatically.

Stop with `docker compose down`.

## How to deploy the frontend

The static frontend can be hosted anywhere (Caddy file_server, nginx, S3,
GitHub Pages, …). See [DEPLOY.md](DEPLOY.md) for the rsync-over-SSH flow:

```bash
cp frontend/config.example.js frontend/config.local.js   # productionHost + lanJetsonUrl
cp frontend/.env.example frontend/.env                   # DEPLOY_USER/HOST/DIR
bash frontend/scripts/deploy.sh
```

## How to deploy the Jetson backend

The Jetson runs natively (systemd) — see [jetson/README.md](jetson/README.md).
Short version:

```bash
cp jetson/.env.example jetson/.env
# edit JETSON_USER/HOST/DIR/PORT
bash jetson/scripts/build.sh
bash jetson/scripts/deploy.sh
```

## Conventions

- **No frontend build step.** Don't add bundlers, TypeScript compilers, or npm
  scripts. ES modules + CDN imports (e.g. decimal.js from jsdelivr).
- **WGSL lives inline** in [frontend/main.js](frontend/main.js). The browser
  shader uses DD-f32 (two f32 per value, ~14 digits); the Jetson CUDA kernel
  uses the same representation (FF-f32).
- **Coords travel as strings** from UI → backend, so arbitrary precision is
  preserved end-to-end. Conversion to FF-f32 happens at the last possible step.
- **No mocks for the Jetson.** Either a real backend is reachable or the UI
  hides its button. Don't invent a stub render service.
- **No `--use_fast_math` on the CUDA kernel.** It breaks Dekker arithmetic.
  The kernel uses explicit `__fmul_rn` / `__fmaf_rn` intrinsics in the hot
  loop to force IEEE rounding.
- **After every Jetson code deploy, finish with**
  `ssh luca@monster "sudo systemctl restart mandelbrot"` — stale code
  otherwise.
- **Plans and decisions** go in [MEMORY.md](MEMORY.md), not scattered comments.

## Key files to know

| What | Where |
|---|---|
| WebGPU shader + DD-f32 math | [frontend/main.js](frontend/main.js) (shader string, top of file) |
| Perturbation rebasing (Zhuoran) | [frontend/main.js](frontend/main.js) — `rebase` logic inside the shader |
| Browser reference orbit (decimal.js, 60 digits) | [frontend/main.js](frontend/main.js) |
| Record pipeline (2-frame, overlay) | [frontend/main.js](frontend/main.js) — `recordVideo()` |
| Hostname → Jetson URL resolution | [frontend/main.js:1245](frontend/main.js#L1245) |
| Manage-jobs dashboard | [frontend/manage-jobs.html](frontend/manage-jobs.html) |
| CUDA kernel (FF + BLA) | [jetson/src/kernel.cu](jetson/src/kernel.cu) |
| FastAPI render service | [jetson/src/server.py](jetson/src/server.py) |
| CUDA worker (context, pipelining, stats) | [jetson/src/worker.py](jetson/src/worker.py) |
| Reference orbit + BLA table generation | [jetson/src/reference.py](jetson/src/reference.py) |
| Systemd unit template | [jetson/systemd/mandelbrot.service](jetson/systemd/mandelbrot.service) |
| Deploy scripts | [jetson/scripts/build.sh](jetson/scripts/build.sh), [jetson/scripts/deploy.sh](jetson/scripts/deploy.sh) |
| Live integration tests | [jetson/tests/](jetson/tests/) |
| Browser-fake debug script | [jetson/scripts/fake-browser.py](jetson/scripts/fake-browser.py) |
| Scientific validation of perturbation | [frontend/test-perturbation.mjs](frontend/test-perturbation.mjs) |

## Troubleshooting pointers

- Rendering goes wrong at extreme zoom → precision ceiling of FF is ~10¹³.
  Beyond that needs triple/quad-float in the kernel or MPFR on the CPU side.
- Jetson button doesn't appear → the frontend's 30s health-check against
  `/jobs` is failing. Confirm `/gpu/jobs` (prod) or `http://monster:8080/jobs`
  (local dev) returns 200.
- `cuModuleLoadDataEx failed: invalid device context` → someone imported
  `pycuda.autoinit` again. Don't — the worker makes its own context per
  render.
- `Unknown encoder 'h264_nvenc'` → apt's ffmpeg lacks NVENC. Worker auto-
  falls-back to libx264. To get real NVENC install `jetson-ffmpeg`.
- `No such file or directory: 'nvcc'` → systemd PATH missing
  `/usr/local/cuda/bin`. Fixed in the unit; if re-installing, re-copy the
  unit and `daemon-reload`.
- Video record produces uniform/black frames → auto-zoom boundary scoring
  picked a flat cell; lower `FLAT_THRESHOLD` or disable auto-zoom.
- BLA shows no benefit → expected at shallow zoom (~10⁰-10²). BLA starts
  paying off at zoom 10³+.
