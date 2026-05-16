// Seed-source selection for the CPU progressive phase. Pure decision
// function — no WebGPU calls — so it can be unit-tested in Node.
//
// When a CPU phase is about to allocate a fresh `cpuBlitTexture`, we want to
// fill it with the best available "previous content" so the user sees a
// stretched/blurry preview during the seconds it takes for the first tile
// to arrive (at deep zoom, the first tile alone can take 10–30s). The
// caller passes whichever sources it has on hand and we pick the most
// informative one.
//
// Sources (in priority order):
//   1. 'prev-phase'  — pixels from the previous phase of THIS dispatch.
//                      Same view, just lower resolution → best match for the
//                      target. Caller has them as a CPU-side Uint8ClampedArray.
//   2. 'old-blit'    — the previous render's `cpuBlitTexture`. Same renderer,
//                      possibly different dimensions, possibly different view.
//                      Used when the cpuBlitTexture lifecycle survives across
//                      progressiveRender calls (e.g. CPU→CPU view change).
//   3. 'swapchain'   — captured swapchain content from before the canvas
//                      resize. Only available on GPU→CPU transitions, where
//                      the GPU render landed directly on the swapchain (no
//                      cpuBlitTexture ever existed). Without this branch the
//                      first-deep-zoom render shows a black canvas.
//   4. 'black'       — no previous content at all (fresh page load directly
//                      into CPU mode, e.g. URL hash points at a deep preset).
//
// Returns one of the four strings above. Truthiness-only check — caller
// owns the actual GPU resource handles.
export function pickSeedSource({ prevPhasePixels, oldBlit, swapchainSeed }) {
  if (prevPhasePixels) return 'prev-phase';
  if (oldBlit) return 'old-blit';
  if (swapchainSeed) return 'swapchain';
  return 'black';
}
