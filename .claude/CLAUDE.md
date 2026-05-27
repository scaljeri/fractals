# CLAUDE.md

Onboarding for AI coders (and humans) working in this repo.

## What this project is

A browser-only **Fractal Atlas**: twelve fractals (Mandelbrot, Julia, Burning
Ship, Mandelbulb, Sierpiński, Menger, Koch, Dragon, Cantor, Barnsley, Lorenz,
Game of Life) with an info dialog per fractal.

The infrastructural centrepiece is the **WebGPU Mandelbrot/Julia engine** with
perturbation theory + mixed-precision math (TD-f32 / DD-f64 / QD-f64). It
pushes the browser zoom ceiling past 10²⁸ while staying interactive. The other
ten fractals are built around it via shared CPU + GPU renderer pairs.

**No backend. No build step.** Static HTML/CSS/JS — open the page and explore.

## Folder layout

```
.
├── index.html                  # Atlas home (12-tile grid)
├── favicon.ico
├── assets/
│   ├── css/                    # Design tokens + site styles
│   └── renders/                # Home-grid PNG previews
├── src/
│   ├── mandelbrot/             # Mandelbrot page (WebGPU deep-zoom)
│   │   ├── index.html
│   │   └── legacy.html         # Pre-Atlas single-page version (kept for diffing)
│   ├── julia/                  # Julia page — thin shim, loads the engine with kind=julia
│   │   └── index.html
│   ├── burning-ship/           # Each generic-viewer fractal: one folder, one HTML
│   ├── mandelbulb/             # body[data-fractal-id] picks the renderer.
│   ├── sierpinski/
│   ├── menger/
│   ├── koch/
│   ├── cantor/
│   ├── barnsley/
│   ├── dragon/
│   ├── lorenz/
│   ├── game-of-life/
│   │   ├── index.html
│   │   ├── game-of-life.js
│   │   └── game-of-life-patterns.js
│   └── utils/
│       ├── fractals.js               # 12-fractal catalogue
│       ├── fractal-info.js           # Info-modal content (history, formula, refs)
│       ├── fractal-viewer.js         # Generic-page dive controller
│       ├── viewer.css                # Shared styles for src/<fractal>/index.html
│       ├── canvas.js, palette.js, webgpu-{device,palette}.js, escape-time-worker.js
│       ├── deep-zoom-engine/         # Mandelbrot/Julia engine (~6k lines)
│       │   ├── main.js
│       │   ├── orbit-worker.js
│       │   ├── cpu-render-worker.js  # CPU tile renderer (TD/DD/QD precision tiers)
│       │   ├── cpu-render-core.js    # Shared CPU iteration core
│       │   ├── qd-f64.js             # Quad-double float library (Bailey-Hida)
│       │   └── seed-select.js
│       └── renderers/
│           ├── escape-time.js, ifs.js, lsystem.js, subdivision.js, ode.js   # CPU
│           └── gpu/*.js              # WebGPU pairs
├── tests/
│   ├── test-cpu-render.mjs           # Node test runner for CPU + DD/QD math
│   ├── test-perturbation.mjs         # Node validation of the perturbation math
│   └── render-sample.mjs             # CLI sample render to PPM
├── scripts/                          # rsync deploy (gitignored — personal infra)
├── design/                           # Design references (out of build)
└── .claude/
    ├── CLAUDE.md, PLAN.md            # this file + roadmap
    └── settings.json                 # portable Claude Code allowlist
```

**Fractal-page URL pattern.** Each fractal has its own folder at
`/src/<id>/`; the `index.html` inside sets `<body data-fractal-id="...">`
which `fractal-viewer.js` reads as a fallback to the legacy `?type=` query
param. Mandelbrot and Julia load the deep-zoom engine module directly; the
other 9 share the same viewer.css + viewer.js template.

## How to run locally

```bash
python3 -m http.server 8765
# → http://localhost:8765
```

No `npm install`, no bundler, no watcher. WebGPU requires a recent browser
(Chrome 113+, Edge 113+, Safari 18+). Over `file://`, WebGPU is blocked — so
serve over HTTP even for local development.

## How to deploy

The site is static — copy the repo contents (minus the excludes baked into
`scripts/deploy.sh`) to any static host: Cloudflare Pages, Netlify, GitHub
Pages, S3 + CloudFront, Vercel, nginx, …

For rsync-over-SSH:

```bash
cp .env.example .env       # fill in DEPLOY_USER / DEPLOY_HOST / DEPLOY_DIR
bash scripts/deploy.sh     # add --dry-run for a preview
```

**HTTPS is required for WebGPU in production browsers.**

## Conventions

- **No build step (yet).** Don't add bundlers, TypeScript compilers, or npm
  scripts. ES modules + CDN imports (e.g. `decimal.js` from jsdelivr). Build
  tooling + dev server is a planned next iteration — see [PLAN.md](PLAN.md).
- **WGSL lives inline** in [src/utils/deep-zoom-engine/main.js](../src/utils/deep-zoom-engine/main.js).
  The browser shader uses DD-f32 (two f32 per value, ~14 digits); deeper zoom
  drops to CPU with DD-f64 / QD-f64 math via `cpu-render-core.js` + `qd-f64.js`.
- **Coords travel as strings** via `decimal.js`, so arbitrary precision is
  preserved end-to-end inside the browser.
- **Plans and decisions** go in [PLAN.md](PLAN.md), not scattered comments.
- **Debug helpers stay in sync** — every new flag/cache/gen counter gets a
  `console.log` at the decision point AND an entry in `window.mb()`
  (`window.dumpMandelbrotState`).

## Key files to know

| What | Where |
|---|---|
| WebGPU shader + DD-f32 math | [src/utils/deep-zoom-engine/main.js](../src/utils/deep-zoom-engine/main.js) (shader string, top of file) |
| Perturbation rebasing (Zhuoran) | [src/utils/deep-zoom-engine/main.js](../src/utils/deep-zoom-engine/main.js) — `rebase` logic inside the shader |
| Browser reference orbit (decimal.js, 60 digits) | [src/utils/deep-zoom-engine/main.js](../src/utils/deep-zoom-engine/main.js) |
| Record pipeline (WebCodecs, browser-only) | [src/utils/deep-zoom-engine/main.js](../src/utils/deep-zoom-engine/main.js) — `recordVideo()` |
| Generic fractal viewer (CPU + GPU fallback) | [src/utils/fractal-viewer.js](../src/utils/fractal-viewer.js) |
| Per-fractal CPU/GPU renderers | [src/utils/renderers/](../src/utils/renderers/) |
| Info-modal content (history, formula, refs) | [src/utils/fractal-info.js](../src/utils/fractal-info.js) |
| 12-fractal catalogue + palettes | [src/utils/fractals.js](../src/utils/fractals.js) |
| Scientific validation of perturbation | [tests/test-perturbation.mjs](../tests/test-perturbation.mjs) |
| CPU/DD/QD math tests | [tests/test-cpu-render.mjs](../tests/test-cpu-render.mjs) |

## Architecture decisions

The non-obvious choices behind the Mandelbrot/Julia engine. Read these before
proposing changes — most have been tried-and-rejected alternatives.

### Perturbation + Zhuoran rebasing
The shader and the CPU kernel both iterate `W ← 2·Z·W + W² + δ` against a
high-precision reference orbit, with **Zhuoran rebasing** when
`max(|Z.re|,|Z.im|) < 2·max(|W.re|,|W.im|)` (plus a forced rebase when the
reference is exhausted). Rejected: Pauldelbrot rebasing (too eager, hurt
deep-seahorse convergence) and Series Approximation (coefficients exploded to
~10²⁷⁰, f64 cancellation gave garbage pixels). A leftover `cddMul` helper in
the shader is from the SA prototype and can be removed.

### Browser CPU precision ladder: DD-f64 → QD-f64
The CPU renderer starts at DD-f64 (~31 digits, reaches ~10³¹) and
auto-engages QD-f64 (~62 digits, reaches ~10⁶²) past zoom 10³¹. QD is
Bailey-Hida "sloppy" variants of add/sub/mul/sqr/div ported from libqd, in
[qd-f64.js](qd-f64.js), validated to 1e-58 — 1e-60 relative error against
Decimal.js in [test-cpu-render.mjs](test-cpu-render.mjs). Decimal.js
per-pixel was rejected (~300× slower than QD-f64 because every multiply
allocates objects). WGSL multi-component f32 was rejected too — WebGPU has
no f64, and 6D/8D-f32 hand-tuned WGSL would be ~600 lines with no good way
to unit-test.

### `decimal.js` precision floor of 60
`ensureReference` calls `Decimal.set({ precision: zoomDigits + 15 })`. If
allowed to drop below 60, later `view.cx.plus(offset)` calls at deep zoom
silently round the offset to zero — the user clicks at zoom 10²⁷ and the
view doesn't move because the click offset (4.4×10⁻²⁷) lands beyond the
precision floor. Keep the floor at 60 so any later setting can only
**increase** precision, never decrease it.

### Single-level BLA (skip=16)
After the reference orbit, we precompute a BLA (Bivariate Linear
Approximation) table: per index n, the 16-step linearised map
`w ← A_n·w + B_n·δ`, valid while `|w| < r_n`. Accumulated in f64, stored as
f32 per entry (5 floats × orbit_len). Helps from zoom ~10³ upward (pixels
spend many iterations near-linearised); marginal at shallow zoom where
pixels escape inside the 16-step window. Hierarchical BLA (adaptive skip
across levels 2⁰..2^L) would unlock 10–100× at zoom >10⁸ per the
literature, but that's a larger project.

### HQ button: deep-search + adaptive iter + texture seed
`startHighQualityRender` swaps in: (1) a 7×7 grid at 3 concentric radii =
up to 147 candidate reference orbits (vs 3×3 = 8 interactively) with
`ORBIT_MAX_ITER_CAP_HQ = 50000`; (2) an adaptive iter cap
`phaseIters = clamp(5 × orbit_len, 1500, 5000)` so cheap views don't waste
budget rebasing into accumulated error; (3) a **texture seed** — the
existing `cpuBlitTexture` is preserved and upscaled into the new HQ-sized
buffer so the canvas never blanks during the render; (4) `timeoutMs:
Infinity` (deep-zoom tiles legitimately take minutes; cancellation goes
through `progressiveGen`). Visible in CPU mode only — GPU's auto-progressive
`[4, 1]` chain already runs full-quality d=1.

### `progressiveActive` + `dragLowRes` flags gate `cpuRender`
`progressiveRender`'s CPU phase block uses `cpuRenderPixels` directly,
bypassing `cpuRender()`. Without `progressiveActive` (true between
`progressiveRender` start and its `slowPathCleanup`), the orbit-worker's
response handler triggers a parallel full-res CPU render that hogs all
workers and blocks the d=4 preview for 20+ seconds. `dragLowRes` is the
same pattern for pointer-drag — live CPU re-renders during pan are useless
and pile up unfinishable work.

### Render-width override + auto-scaling
HUD `render w` dropdown (`auto`/`100`/`200`/`400`/`800`/`1920`), persisted
in `localStorage`. `auto` scales with zoom — full canvas <10²⁰, 1/2 at
10²⁰⁻³⁰, 1/4 at 10³⁰⁻⁵⁰, 1/8 past 10⁵⁰. Manual values override regardless
of zoom. HQ ignores auto's downscale (HQ in auto = full canvas) but honours
manual values exactly. `effectiveRenderWidth()` returns the target width in
device pixels; the CPU phase block divides further by the phase divisor.

### Canvas drawing buffer always at full DPR
Per-pixel rendering lands in a smaller `cpuBlitTexture`; a tiny `blitUpscale`
WGSL shader samples it with linear filtering and writes to the swapchain at
canvas size. This means d=8 → d=4 → d=2 transitions just reallocate
`cpuBlitTexture` — the swapchain stays alive and the visible image never
blanks. `cpuBlitTexture` needs `RENDER_ATTACHMENT | COPY_DST | COPY_SRC |
TEXTURE_BINDING` usage flags; missing `TEXTURE_BINDING` silently fails
bind-group creation and the canvas stays black even though tiles complete.

### Click-zoom preview is a crosshair, not a literal preview
`CLICK_ZOOM = 0.5` (one click halves the viewport) is decoupled from
`PREVIEW_SCALE = 1/6` (hover indicator size). Zoom depth per click is tuned
independently of the visual indicator — the preview is a precise crosshair,
not a scaled preview of the destination viewport.

### `AUTO_CORRECT` adaptive steering is off
Adaptive contrast-following during recording drove the camera into dead
cells. Both code paths are gated: `recordVideo` sets `const AUTO_CORRECT =
false` so segment-interpolation never runs and the camera follows the click
target frame-by-frame. Boundary-preferring cell scoring and
zoom-out-on-flat stay on — just not the full adaptive override of the
user's chosen target.

### `window.mb()` debug snapshot
Every flag, cache, gen counter, and decision point in the rendering
pipeline is surfaced via `console.log` with a `[component] ...` prefix and
via `window.dumpMandelbrotState()` (alias `window.mb()`). Invoke `window.mb()`
from devtools to get a one-shot snapshot of the entire render state when
triaging "screen black / stuck / off" reports. **Any new piece of pipeline
state must update both the console traces and the `mb()` snapshot** — this
rule is load-bearing for triage.

## Troubleshooting pointers

- Rendering goes wrong at extreme zoom → precision ceiling. Browser shader
  is FF/DD-f32 (~10¹³); CPU DD-f64 takes over from there, QD-f64 past 10³¹.
- "Black canvas" / "render is stuck" → call `window.mb()` in devtools for a
  full state dump (view, orbit cache, flags, progressive state).
- BLA shows no benefit → expected at shallow zoom (~10⁰–10²); BLA starts
  paying off at zoom 10³+.
- Video record produces uniform/black frames → auto-zoom boundary scoring
  picked a flat cell; lower `FLAT_THRESHOLD` or disable auto-zoom.
