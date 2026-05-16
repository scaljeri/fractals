# MEMORY.md

Log of architecture decisions and current feature state. Written so a future
contributor (AI or human) can rebuild the mental model without re-deriving
every choice from the code.

> Scope: the Jetson render backend and its interaction with the browser
> frontend. Pure-browser decisions (decimal.js, WebGPU shader) live here too
> because the frontend and backend are co-evolved.

---

## Architecture decisions

### Perturbation theory + Zhuoran rebasing
Browser shader and CUDA kernel both use `W_{n+1} = 2·Z·W + W² + δ` against a
high-precision reference orbit, with **Zhuoran rebasing** triggered by
`max(|Z.re|,|Z.im|) < 2·max(|W.re|,|W.im|)` plus a forced rebase when the
reference orbit is exhausted.

Rejected alternatives:
- **Pauldelbrot rebasing** — triggered too eagerly in some regions, hurt
  convergence on deep seahorse test points.
- **Series Approximation (SA)** — catastrophic: coefficients Aₖ exploded to
  ~10²⁷⁰, f64 cancellation produced garbage pixels. Removed entirely; the
  unused `cddMul` helper in the shader is a leftover.

### Float-float (FF) arithmetic on the Jetson GPU — not DD-f64
The kernel uses **two f32 per value** (a.k.a. FF / "float-float", ~48-bit
mantissa, ~14 decimal digits) implemented with Dekker's TwoSum / TwoProd.
Reference orbit is computed in Python f64 for accuracy, then split into
(f32 hi, f32 lo) pairs on the way into the GPU upload.

**Why not DD-f64?** Jetson Orin AGX is Ampere SM 8.7 — consumer-grade
silicon where FP64 runs at ~1/32 of FP32. Measured: DD-f64 ≈ 1.44 μs/pixel,
FF-f32 ≈ 0.20 μs/pixel. Same visual precision (matches browser WGSL).

**Why not triple/quad-float?** FF covers ~10¹³ zoom; we haven't hit that
ceiling in practice. TD/QD would be several more multiplications per iter
and is deferred.

### No `--use_fast_math` on the kernel
Fast-math fuses `a*b` into FMA aggressively, which **zeroes the error term
in Dekker's TwoProd** and destroys FF precision. The hot loop uses explicit
`__fmul_rn` / `__fmaf_rn` / `__fadd_rn` intrinsics to force IEEE rounding
regardless of compiler flags.

### Single-level BLA (skip=16) for moderate-to-deep zoom
After computing the reference orbit we precompute a BLA (Bivariate Linear
Approximation) table: per reference index n, the 16-step linearized map
`w ← A_n·w + B_n·δ` valid while `|w| < r_n`. Accumulated in f64, stored
as f32 per entry (5 floats × orbit_len). The kernel checks the radius at
the top of every iteration and, if valid, does one complex MAD instead of
16 perturbation steps.

Helps at zoom ~10³ and beyond (pixels spend many iterations near-linearized).
Marginal at shallow zoom where pixels escape before the 16-step window
completes. **Hierarchical BLA** (levels 2⁰..2^L, adaptive skip) would give
the 10-100× wins the research literature claims at zoom >10⁸, but that's a
separate, larger project.

### decimal.js (UI) + gmpy2/mpfr (Jetson) for deep-zoom precision
Coord inputs come in as strings, held as `Decimal` at 60-digit precision on
the UI side. They travel to the Jetson as strings and are parsed there into
`gmpy2.mpfr` at a precision that scales with zoom depth
(`precision_bits_for_scale`). Reference orbit + view-centre arithmetic runs
in that mpfr precision; only the per-pixel δ is rounded to FF-f32 for the
GPU.

This is what makes perturbation actually stay correct past ~10¹³ zoom: the
one place that needs high precision (the reference orbit) has it, while the
GPU's cheap FF-f32 arithmetic keeps working for δ because δ stays small
regardless of zoom.

### CUDA context per render (not pycuda.autoinit)
`pycuda.autoinit` binds a CUDA context to the thread that imports it. In
FastAPI that's the main thread at startup, but renders run via
`asyncio.to_thread` on a worker thread with no current context →
`cuModuleLoadDataEx failed: invalid device context`. Fix: `cuda.init()` at
module load, then `cuda.Device(0).make_context()` / `ctx.pop()` /
`ctx.detach()` per render call on whatever thread executes it.

### Jetson stays outside the k3s cluster
Jetson Orin AGX hosts the CUDA + FFmpeg render service natively (systemd).
The cluster reaches it via a Helm-templated `Service: ExternalName` pointing
at a LAN/Tailscale address, with a Traefik StripPrefix middleware turning
`/gpu/*` into the backend's normal paths.

**Why:** running CUDA workloads in k3s would need the nvidia-container
runtime, GPU scheduling, and a device-plugin — out of scope.
**How to apply:** if new GPU workloads appear, default to native-on-the-
Jetson + ingress-proxy before reaching for in-cluster GPU scheduling.

### libx264 with `-threads 10` (for now)
Ubuntu's apt ffmpeg is built **without NVENC**. First deploy hit
`Unknown encoder 'h264_nvenc'` → ffmpeg exited → the worker wrote into a
broken pipe. Auto-detect at worker import probes for `h264_nvenc` and
falls back to libx264 with 10 encoder threads (matches the number of
cores, leaves 2 for Python/kernel orchestration). Installing
`jetson-ffmpeg` (community build with NVENC) would flip the auto-detect
to h264_nvenc without code changes.

### NUM_INFLIGHT = 4 default, but compute-bound so diminishing returns
The worker pipelines N frames through N CUDA streams with pinned host
buffers and async memcpy. With FF-f32 the kernel is close to the GPU's
FP32 peak — concurrent kernels from additional streams mostly queue. N=1
gives ~same wall-clock with less GPU memory. Kept at 4 with env override
(`MANDELBROT_NUM_INFLIGHT`) for flexibility.

### 2-frame GPU/CPU pipeline in the browser (WebCodecs path)
Independent of the Jetson. Browser recording keeps two frames in flight:
while frame N+1 renders on the GPU, frame N's pixels are being read back
and fed into the WebCodecs encoder. Roughly doubled record throughput vs.
the naïve serial loop.

### AUTO_CORRECT / adaptive steering is off end-to-end
Adaptive contrast-following drove the camera into dead cells during
recordings. **Both** paths are gated:

- Browser `recordVideo`: `const AUTO_CORRECT = false` — segment-interpolation
  never runs; the camera follows the click target frame-by-frame.
- Jetson request (from `queueOnJetson`): `adaptive: false` and
  `initial_follow_frames: frames` — same end-to-end behaviour on the backend.
- Jetson worker: when `adaptive=false`, the follow-click branch runs for
  every frame regardless of `initial_follow_frames`. Don't rely on
  `initial_follow_frames` being a useful knob in non-adaptive mode.

Boundary-preferring cell scoring and zoom-out-on-flat stay on — just not
the full adaptive steering that overrode the user's chosen target.

### Click-zoom preview is a small crosshair, not a literal preview
`CLICK_ZOOM = 0.5` (one click halves the viewport) but `PREVIEW_SCALE = 1/6`
(hover indicator is 1/6 the canvas). Decoupled on purpose so the zoom depth
per click can be tuned independently of the visual indicator. The preview
acts as a precise crosshair.

### Browser CPU per-pixel kernel: DD-f64 → QD-f64 ladder
The browser CPU renderer started as DD-f64 (~31 digits, reaches ~10³¹).
QD-f64 (~62 digits, reaches ~10⁶²) lives in `frontend/qd-f64.js` and
auto-engages past zoom 10³¹. Bailey-Hida sloppy variants of add/sub/mul/sqr/
div, ported from libqd. Tests in `test-cpu-render.mjs` validate against
Decimal.js ground truth at 1e-58 to 1e-60 relative error.

**Why not Decimal.js per-pixel?** ~300× slower than QD-f64 because each
multiply allocates new objects. Per pixel iteration would take ~100ms
in Decimal vs ~1ms in QD-f64 — unworkable even at low res for video.

**Why not multi-component f32 in the WGSL shader?** WebGPU has no f64,
just f32. Would need 6D-f32 / 8D-f32 to reach 10⁴²/10⁵⁶, ~600+ lines of
hand-tuned WGSL with no good way to unit-test. Deferred indefinitely;
the Jetson CUDA path is the right place for deep-zoom video.

### `progressiveActive` flag stops cpuRender from racing the phase chain
`progressiveRender`'s CPU phase block uses `cpuRenderPixels` directly,
bypassing `cpuRender()`. Without a guard, the orbit-worker's response
handler triggers `requestRender()` → `cpuRender()` → a parallel full-res
CPU render that hogs all 9 workers, blocking progressive's d=4 preview
for 20+ seconds. The `progressiveActive` boolean (true between the start
of a `progressiveRender` and its `slowPathCleanup`) makes `cpuRender` bail
early.

### `dragLowRes` flag stops cpuRender during pan
Same pattern as `progressiveActive`. Live-updating the CPU image during a
pointer-drag is useless (each render is seconds late) but queues mountains
of unfinishable work onto the workers. `cpuRender` returns early if
`dragLowRes` is set; `pointerup` clears it and triggers a single render.

### Render-width override + auto-scaling
HUD has a `render w` dropdown (`auto`/`100`/`200`/`400`/`800`/`1920`),
persisted in localStorage. `auto` mode scales render resolution with zoom
depth: full canvas <10²⁰, 1/2 at 10²⁰⁻³⁰, 1/4 at 10³⁰⁻⁵⁰, 1/8 past 10⁵⁰.
Manual values override regardless of zoom. HQ button ignores auto's
downscale (HQ in auto = full canvas) but honors manual values exactly.

`effectiveRenderWidth()` returns the chosen target width in device pixels;
the CPU phase block divides further by the phase divisor (d=8, d=4) so a
manual setting of "render w = 400" gives d=8 at 50px, d=4 at 100px.

### Canvas drawing buffer always at full DPR
Per-pixel rendering happens at `cpuBlitTexture` resolution (smaller than
canvas if user is at deep zoom or set a manual override). `blitUpscale` is
a tiny WGSL shader that samples `cpuBlitTexture` with a linear filter and
writes to the swapchain at canvas size. This means:
- Canvas drawing buffer never has to resize during a phase chain
  (resizing reconfigures the swapchain to black, destroying any preview
  that's currently visible).
- d=8 → d=4 → d=2 transitions just reallocate `cpuBlitTexture` at the new
  phase resolution; the swapchain stays alive.

`cpuBlitTexture` needs `RENDER_ATTACHMENT | COPY_DST | COPY_SRC | TEXTURE_BINDING`
usage. The `TEXTURE_BINDING` flag was missing in early iterations of the
blit-upscale code, causing the bind-group creation to silently fail and
the swapchain to stay black even though tiles completed correctly.

### HQ button: deep-search reference orbit + adaptive iter cap + texture seed
`startHighQualityRender` triggers a full-quality render of the current view:

1. **Deep orbit search** (`deepSearch: true` flag in orbit-worker). 7×7 grid
   at 3 concentric radii (1×, 5×, 25× viewport) = up to 147 candidate
   reference orbits, vs the 3×3 = 8 used interactively. Iteration cap
   `ORBIT_MAX_ITER_CAP_HQ = 50000` vs interactive 8000.
2. **Adaptive iter cap**: `phaseIters = clamp(5 × orbit_len, 1500, 5000)`.
   Spending 5000 iter/pixel against a 300-long reference is wasted work —
   perturbation rebases ~16× per pixel and DD-f64 accumulates error well
   before reaching maxIter. The clamp adapts cost to what's actually useful
   at this view.
3. **Texture seed (not clear)**: HQ saves the current `cpuBlitTexture`,
   allocates a new one at HQ size, and `blitUpscale`s old → new with linear
   filtering. Without this the canvas blanks to black for the entire HQ
   render duration; with it, the existing image is the visible baseline
   and tiles progressively sharpen it.
4. **No per-tile timeout**: HQ passes `{ timeoutMs: Infinity }` to
   `cpuRenderPixels`. Full-canvas tiles at deep zoom legitimately take
   minutes; the user cancels via the button (which bumps `progressiveGen`
   so the in-flight render's `myGen` check bails on next await boundary).
5. **Visible only in CPU mode**: `updateHUD()` toggles `display: none` when
   `effectiveBackend() === 'gpu'` because the auto-progressive `[4, 1]`
   chain already runs full-quality d=1 there — HQ would be a no-op.

### `Decimal.set({precision})` minimum floor of 60 in main thread
`ensureReference` (the sync orbit path used during recording) calls
`Decimal.set({ precision: zoomDigits + 15 })`. If allowed to drop below 60,
subsequent `view.cx.plus(offset)` calls at deeper zoom silently round the
offset to zero — the user clicks at zoom 10²⁷ and `view.cx` doesn't move
because the click offset (4.4×10⁻²⁷) lands beyond the precision floor.
Keep the floor at 60 (the startup default) so any later precision setting
can only INCREASE precision, never decrease it.

### `window.mb()` debug snapshot + traced events
Every flag, cache, gen counter, and decision point in the rendering pipeline
is surfaced via `console.log` with a `[component] ...` prefix and via
`window.dumpMandelbrotState()` (alias `window.mb()`). User invokes
`window.mb()` from devtools to get a one-shot snapshot of the entire
render state when triaging "screen black / stuck / off" reports.

**Standing rule**: any new piece of state added to the rendering pipeline
must update both the console traces and the `mb()` snapshot. Recorded as
auto-memory `feedback_debug_helpers.md`.

### Single Caddy image for dev + standalone prod
The repo-root `Dockerfile` + `Caddyfile` produce one image that serves the
frontend AND proxies `/gpu/*` when run standalone (`docker compose up` or
Caddy-on-VM). In k3s the chart only uses the static half; the `/gpu`
routing is done by the Ingress + Middleware. Duplication is intentional
— keeps dev parity with standalone prod without forking the image.

### Deploy flow: source on Mac → bundle → rsync → systemd
All Jetson source lives in the repo on the dev machine. `build.sh` reads
`.env` and produces `jetson/build/` (source + generated `run.sh` + systemd
unit with real paths baked in). `deploy.sh` rsyncs it to
`luca@monster:/home/luca/dev/mandelbrot`, excluding `venv/`, `renders/`,
`__pycache__/`. The systemd unit template lives at
[jetson/systemd/mandelbrot.service](jetson/systemd/mandelbrot.service)
with `@JETSON_USER@` / `@JETSON_DIR@` / `@JETSON_PORT@` placeholders.

**`.env` lives only on the dev machine** — it tells build/deploy scripts
where to rsync, what port to bake into the bundle. The Jetson itself
doesn't need it.

### Frontend-hostname-based Jetson URL resolution
`main.js` picks the Jetson endpoint from `window.location.hostname`:
- `mandelbrot.calje.eu` → `/gpu` same-origin (production, via ingress)
- `localhost` / `127.0.0.1` → `http://monster:8080` direct (LAN dev)
- anything else → `localStorage.jetsonUrl` or `jetson.local:8080` default

No per-dev prompts once the URL is set. Requires `monster` in /etc/hosts
on the dev machine (pointing at the Jetson's LAN IP).

---

## Current state

Legend: ✓ works · ✗ off/broken · ⏳ partially done / untested in prod

### Rendering pipeline
- ✓ Browser WebGPU renderer: perturbation + Zhuoran, TD-f32, decimal.js coord I/O
- ✓ Browser CPU renderer: DD-f64 perturbation in worker pool, takes over past 10²⁰
- ✓ QD-f64 math library + tests (`frontend/qd-f64.js`, ~62 digit precision, reaches 10⁶²)
- ⏳ QD-f64 wired into orbit-worker + cpu-render-core + progressiveRender/HQ (in progress)
- ✓ Click-to-zoom + hover crosshair + coord auto-fill
- ✓ Render-width knob in HUD (auto/manual, persisted)
- ✓ HQ button (deep-search reference + adaptive iter + texture seed; visible CPU mode only)
- ✓ WebCodecs recording with 2-frame pipeline + overlay
- ✓ Jetson CUDA kernel: FF-f32 + single-level BLA, ~200 ns/pixel at moderate zoom
- ✓ Jetson health probe + dynamic UI (button hides when unreachable)
- ✗ AUTO_CORRECT adaptive contrast steering (gated off)

### Jetson backend infra
- ✓ FastAPI + asyncio queue, single worker loop
- ✓ CUDA context per-render (fixed thread-binding bug)
- ✓ pycuda compile caches kernel cubin (nvcc not rerun after first render)
- ✓ Auto-detect h264_nvenc / libx264 at startup, falls back gracefully
- ✓ stderr of ffmpeg drained into `job.error` so failures surface in the UI
- ✓ Systemd unit runs on boot, env=`PATH=/usr/local/cuda/bin:...` fixes nvcc-on-PATH
- ✓ Live stats: per-frame GPU/CPU ms via CUDA events + wall clock

### Ops + docs
- ✓ Deploy: `./scripts/deploy.sh [--restart]` from Mac (rsync + optional systemctl)
- ✓ Manage-jobs dashboard at `/manage-jobs.html` with live inflight indicator + timing bar
- ✓ Browser-fake test script `scripts/fake-browser.py` surfaces server errors verbatim
- ✓ pytest live tests (health / render / download / FF golden size-sanity)
- ⏳ Helm chart exists in `helm/mandelbrot/`, never deployed to a real cluster
- ✓ MPFR / gmpy2 reference orbit on Jetson (`precision_bits_for_scale` adapts per render; zoom no longer capped at f64's ~10¹³)

---

## Open technical debts

Prioritized by expected impact. See [plan.md](plan.md) for the active deep-
zoom refactor roadmap (iterations 2-6).

1. **Wire QD-f64 into the CPU pipeline** — math library and tests are done;
   need to update `orbit-worker.js` to emit QD samples past 10³¹,
   `cpu-render-core.js` to add `iteratePixelQD` / `renderTileQD`, and
   `main.js` to auto-select QD vs DD based on zoom. Lifts browser CPU mode
   from 10³¹ to 10⁶². See plan.md iteration 2 (integration).
2. **`view.scale` mantissa+exponent** — currently `view.scale: number` (f64)
   underflows at zoom 10³⁰⁷. Replace with `{m, e}` so navigation can go
   arbitrarily deep. ~30 small touches in `main.js`.
3. **Jetson CUDA QD-f64 backend** — for production-quality deep-zoom video,
   the Jetson kernel needs DD-f64 / QD-f64 paths. CUDA has native f64 so
   this is significantly easier than WebGPU (no f32 emulation needed).
   Existing FF-f32 path stays for shallow video.
4. **Hierarchical BLA** — single-level skip=16 plateaus around zoom 10⁴-10⁶.
   Multi-level (skip adapts 2⁰..2^L) unlocks 10-100× at zoom 10⁸+. Larger
   reference + BLA tables, more complex kernel branch, but no new arithmetic.
2. **jetson-ffmpeg** — installs a community ffmpeg build with NVENC. Flips
   the auto-detect to `h264_nvenc` without code changes. Frees ~10 CPU
   threads from encoding duty (useful once libx264 stops being the right
   answer, e.g. for longer renders).
3. **Real k3s deploy** — chart exists and templates clean. Needs: DNS
   pointing at cluster, cert-manager ClusterIssuer, image pushed to
   registry. Chart has never actually been applied.
4. **GPU-side triple-float (TF-f32) or quad-float (QF-f32)** — FF-f32's 14
   digits is enough for the per-pixel δ at essentially any zoom in theory,
   but cumulative error over hundreds of thousands of iterations at extreme
   zoom (>10¹⁰⁰) will eventually exceed δ. TF/QF gives 21/28 digits per
   value. Only needed once the reference + BLA can already drive the kernel
   that deep.
5. **Delete `cddMul` from the browser shader** — leftover SA prototype,
   safe to remove.
6. **Split health endpoint** — browser health-check hits `/jobs`. Splitting
   out a lightweight `/healthz` would reduce the polling cost on a busy
   Jetson.
7. **Golden tests need a pure-Python video decoder** — currently require
   local `ffmpeg` for pixel-level validation (skip gracefully when absent,
   but the full check is nicer).

---

## How to run

```sh
# local dev (docker compose + caddy proxy to monster:8080 for /gpu)
docker compose up -d              # → http://localhost:8080

# or simpler static serve (python http.server on 8765)
cd frontend && python3 -m http.server 8765

# deploy jetson backend
cd jetson && ./scripts/deploy.sh --restart

# run tests against live Jetson
python3 -m pytest jetson/tests -v

# benchmark
python3 jetson/scripts/fake-browser.py --frames 300 --width 960 --height 540

# helm (future)
helm install mandelbrot ./helm/mandelbrot \
  -n mandelbrot --create-namespace \
  -f my-values.yaml
```

Details in [AGENTS.md](AGENTS.md), [DEPLOY.md](DEPLOY.md),
[jetson/README.md](jetson/README.md), and
[helm/mandelbrot/README.md](helm/mandelbrot/README.md).

---

## Known performance numbers (Jetson Orin AGX, 960×540)

| Kernel variant | GPU ms/frame | ns/pixel | Notes |
|---|---|---|---|
| DD-f64 (pre-migration) | ~750* | ~1440 | *extrapolated from 10.4s @ 3600×2016 |
| FF-f32 (Phase 1)       | 104.5 | 200 | 7.2× faster per pixel |
| FF-f32 + BLA shallow   | 118.9 | 229 | BLA overhead >= benefit; marginal regression |
| FF-f32 + BLA deep (~10⁴) | 480.7 | 926 | max_iter ~9k, BLA recoups ~30% vs no-BLA at this depth |

Moderate-deep zoom at 3600×2016 went from ~10 s/frame to ~1.4 s/frame end-to-end.
