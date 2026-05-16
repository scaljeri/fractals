# Mandelbrot deep-zoom refactor plan

Living document for the multi-iteration refactor that lifts the browser-side
zoom ceiling from ~10^31 to 10^100+ and enables long-running deep-zoom video
production via the Jetson CUDA backend. Updated as iterations land.

## Goal

Deep-zoom **video production**, with the browser as a fluent exploration UI.
Specifically:

- Browser stays usable to ~10⁶² (interactive preview, low-res renders).
- Jetson handles production-quality video frames at any depth.
- HQ button bridges the two: explore in browser, hit HQ when found a spot,
  push to Jetson queue when ready to publish.

## Iterations

### ✓ Iteration 1 — Render-width knob + auto-scaling (DONE 2026-04-28)

Goal: give the user explicit control over render resolution before the
precision lift, so they can keep clicks responsive at deep zoom.

- HUD: `render w` dropdown (`auto`/`100`/`200`/`400`/`800`/`1920`)
- `auto` mode: scales with zoom — full at <10²⁰, 1/2 at 10²⁰⁻³⁰, 1/4 at
  10³⁰⁻⁵⁰, 1/8 past 10⁵⁰
- Persisted in `localStorage`
- Wired into both progressive CPU phases and HQ
- HQ ignores auto's downscale (auto mode = full canvas), honors manual values

Files: `frontend/index.html`, `frontend/main.js`

### ✓ Iteration 2 (foundation) — QD-f64 math library (DONE 2026-04-28)

Goal: implement the 62-digit per-pixel arithmetic needed to lift the CPU
mode ceiling from 10³¹ to 10⁶².

- `frontend/qd-f64.js`: `qdAdd`/`qdSub`/`qdMul`/`qdSqr`/`qdDiv`/`qdFromString`/
  `qdPow10`/`qdNeg`/`qdToNumber`/`qdToDD`. Bailey-Hida sloppy variants from
  libqd. ~250 lines.
- `frontend/test-cpu-render.mjs`: 11 new tests vs Decimal.js ground truth at
  ~62-digit precision. Includes Mandelbrot iteration sanity (c=−0.75 stays
  bounded, c=1 escapes early, 1+1e-60 ≠ 1).

### ⏳ Iteration 2 (integration) — Wire QD-f64 into the CPU pipeline

Goal: actually use the QD-f64 math past zoom 10³¹.

Open work:

- **orbit-worker.js**: at `zoomDigits >= 31`, also emit a `Float64Array` of
  QD samples (4 doubles per orbit point, 32 bytes/iter) alongside DD-f64.
  Total payload size: orbit_len × (24 TD-f32 + 32 DD-f64 + 32 QD-f64) =
  ~88 bytes/iter at deep zoom; for orbit_len=8000 that's ~700kB transfer.
- **cpu-render-core.js**: parallel `iteratePixelQD` and `renderTileQD`.
  The renderTile dispatch picks DD or QD based on a `precision: 'dd'|'qd'`
  flag in the message payload.
- **main.js**: `cpuRenderPixels` takes a `precision` opt; auto-selects QD
  past 10³¹ in `progressiveRender` and HQ. Stores `orbitCache.orbitQD`
  alongside `orbitCache.orbitDD`.
- **Tests**: end-to-end test at zoom 10⁴⁰ that confirms QD path produces
  visible structure.

### ⏳ Iteration 3 — view.scale mantissa/exponent

Goal: lift the `view.scale = f64` ceiling from 10³⁰⁷.

- Replace `view.scale: number` with `view.scale: { m: number, e: number }`
  where value = m·2^e, e is i32.
- Update navigation: `view.scale.m *= factor; renormaliseScale(view.scale)`
- Update display: `zoom = HOME.scale / scaleValue` where scaleValue is
  reconstructed when needed.
- Update orbit-worker dispatch: send mantissa+exp instead of f64 scale.
- Aspect ratio still f64.

Effort: medium. Lots of small touches across `main.js`, but the math is
straightforward (everything currently doing `Math.log10(view.scale)` etc.
gets a tiny helper).

### ⏳ Iteration 4 — Jetson CUDA QD-f64 backend

Goal: deep-zoom video at full resolution.

- CUDA kernel using `double-double` (DD-f64) and `quad-double` (QD-f64) on
  the Jetson Orin AGX. CUDA has native f64 unlike WebGPU — implementations
  of DD/QD are well-established (CAMPARY, libqd-cuda, etc.).
- Reference orbit + BLA still computed in MPFR (already done).
- Per-precision-tier kernel: f32 (existing FF), DD-f64 (new), QD-f64 (new).
- API: render request specifies depth, backend picks tier.

Effort: large. Needs Jetson-side QD primitives + kernel + test infrastructure.

### ⏳ Iteration 5 (research) — findReference improvements

Goal: longer reference orbits at "all-escape" views.

Currently `findReference` does a 3×3 grid (interactive) or 7×7 across 3
radii (HQ deep search). Both can fail to find a long orbit when the local
neighborhood is uniformly out-of-set.

Approaches to try:

- **Newton-style refinement** toward the nearest in-set period-N component
  (requires period detection). Used by Kalles Fraktaler / Mandel Machine.
- **Curated seed library** — known-good in-set points (centres of period-N
  components, Misiurewicz points) with refinement to nearest neighbour of
  the click target.
- **External-ray landing** — for views inside specific rays, jump to the
  ray's landing point as the seed.

This is research-level; pick one approach, prototype, measure.

### ⏳ Iteration 6 — OD-f64 (octuple-double, 109 digits)

Goal: zoom past 10⁶². Only needed if iterations 1-5 are landing and depth
ambition grows further.

- Same Bailey-Hida pattern as QD, with 8 components instead of 4.
- Per-op cost ~16× DD-f64. CPU rendering at 10¹⁰⁰ would be ~hours per
  full-canvas frame even at low resolution; only practical for stills or
  ultra-low-res video.
- For Jetson, OD on CUDA is ~doable (CAMPARY library has implementations).

## Cross-cutting concerns

### Logging discipline (standing rule)

Every new flag/cache/gen counter/code path gets:
1. A `console.log` at the decision point with the `[component] ...` prefix.
2. An entry in `window.mb()` (`window.dumpMandelbrotState`) for triage.

This is enforced by user feedback memory `feedback_debug_helpers.md`. See
also `MEMORY.md`'s "Architecture decisions" entry on this once added.

### Test discipline

- All math primitives unit-tested against Decimal.js ground truth in
  `frontend/test-cpu-render.mjs`.
- Test file imports both `cpu-render-core.js` and `qd-f64.js` so future
  precision tiers (TD-f64, OD-f64) get tested in the same harness.
- Pipeline tests (orbit-worker → cpu-render-worker → renderTile) live
  alongside the math tests.

### Handoff design

For coordinates / seed library / interesting points, see `POINTS.md` (deep
zoom catalogue). Bookmarks UI is a future iteration not on this plan; the
file is ground truth for where to look first.

## Done log

- 2026-04-27: precision floor fix (`Decimal.set({precision: ...})` floor at 60)
  — deep clicks weren't moving view.cx because precision dropped after
  shallow `ensureReference` calls.
- 2026-04-27: `cpuBlitTexture` `TEXTURE_BINDING` flag — was missing, made
  `blitUpscale` validation-fail silently → black canvas in CPU mode.
- 2026-04-27: `progressiveActive` flag — stops `cpuRender` from racing with
  `progressiveRender`'s phase chain at deep zoom.
- 2026-04-27: HQ button + cancel — explicit "patience" render at the user's
  request, hides the auto-d=2 phase that was blocking interactive flow.
- 2026-04-27: HQ click-rect preview — instant CSS-stretch of click rect to
  fill canvas (later replaced by texture-seed + tiles).
- 2026-04-27: HQ texture seed (vs clear-to-black) — preserves previous
  progressive's image as baseline so HQ doesn't blank the canvas.
- 2026-04-28: Iteration 1 (render-width knob + auto-scaling).
- 2026-04-28: Iteration 2 foundation (QD-f64 library + tests).
