// Thin worker wrapper around cpu-render-core.js. All the math — DD-f64
// arithmetic, per-pixel perturbation, palette, tile loop — lives in the core
// module so it's unit-testable from Node. This file just owns the Worker
// message interface.
//
// Protocol (main → worker):
//   {
//     tileX, tileY, tileW, tileH,      // tile in canvas pixel coords
//     canvasW, canvasH,
//     orbit:    Float64Array,          // DD-f64 samples: [reH, reL, imH, imL, ...]
//     orbitLen,
//     scaleMantHi, scaleMantLo,        // DD-f64 mantissa of view.scale at frameExp
//     frameExp,                        // i32 exponent shared with scale + delta
//     deltaReHi, deltaReLo,
//     deltaImHi, deltaImLo,            // DD-f64 mantissa of view - ref at frameExp
//     maxIter,
//     palette: { a, b, c, d, offset },
//   }
//
// Protocol (worker → main):
//   { tileX, tileY, tileW, tileH, pixels: ArrayBuffer }  // tight RGBA

import { renderTile, renderTileQD } from './cpu-render-core.js';

console.log('[cpu-worker] booted');

self.addEventListener('message', (ev) => {
  const p = ev.data;
  const tag = `(${p.tileX},${p.tileY} ${p.tileW}×${p.tileH})`;
  // precision: 'dd' (default) or 'qd'. Dispatched explicitly so we don't
  // accidentally run a DD kernel against a QD orbit (or vice versa).
  const precision = p.precision || 'dd';
  console.log(`[cpu-worker] tile ${tag} start: orbitLen=${p.orbitLen} maxIter=${p.maxIter} precision=${precision}${precision === 'dd' ? ` frameExp=${p.frameExp}` : ''}`);
  const t0 = performance.now();
  // Per-row progress: throttle to at most one message per 250ms so we don't
  // flood the main thread with progress events on a fast tile.
  let lastProgressMs = 0;
  const onRowProgress = (rowsDone, totalRows) => {
    const now = performance.now();
    if (now - lastProgressMs < 250) return;
    lastProgressMs = now;
    self.postMessage({
      type: 'progress',
      reqId: p.reqId,
      tileX: p.tileX, tileY: p.tileY,
      rowsDone, totalRows,
    });
  };
  const args = { ...p, onRowProgress };
  const pixels = precision === 'qd' ? renderTileQD(args) : renderTile(args);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`[cpu-worker] tile ${tag} done in ${ms}ms (${precision})`);
  self.postMessage(
    {
      reqId: p.reqId,                    // echo so main can drop stale responses
      tileX: p.tileX, tileY: p.tileY,
      tileW: p.tileW, tileH: p.tileH,
      pixels: pixels.buffer,
    },
    [pixels.buffer]
  );
});
