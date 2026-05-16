// Render one specific (re, im, zoom) directly via the CPU renderer core.
// Writes a PPM image to disk and prints an ASCII preview to stdout so we can
// eyeball the output without a browser. Entirely independent of main.js and
// the worker pool — just the pure render math from cpu-render-core.js.
//
// Usage:
//     node frontend/render-sample.mjs [re] [im] [zoomExp] [w] [h] [maxIter]
//
// Defaults: the "Reverse Mandelbrot" point from POINTS.md at zoom 10^30,
// rendered into a 120×60 buffer.

import Decimal from 'decimal.js';
import { writeFileSync } from 'node:fs';
import { renderTile } from './cpu-render-core.js';

const cReStr   = process.argv[2] || '-0.7436330243708595014205007223';
const cImStr   = process.argv[3] || '0.1414274379137962191116841227';
const zoomExp  = parseInt(process.argv[4] || '30', 10);
const width    = parseInt(process.argv[5] || '120', 10);
const height   = parseInt(process.argv[6] || '60', 10);
const maxIter  = parseInt(process.argv[7] || '3000', 10);

// ---- Set up precision and view parameters ----

const scale     = Math.pow(10, -zoomExp);
const frameExp  = Math.floor(Math.log2(scale));
const invFactor = Math.pow(2, -frameExp);
const scaleMant = scale * invFactor;

// Precision sized to zoom depth + iteration-error margin. Matches the worker.
const precision = Math.max(20, zoomExp + 15);
Decimal.set({ precision });

// ---- Build the reference orbit in Decimal ----

console.log(`Rendering ${width}×${height} at`);
console.log(`  re = ${cReStr}`);
console.log(`  im = ${cImStr}`);
console.log(`  zoom = 10^${zoomExp}  (scale = ${scale})`);
console.log(`  frameExp = ${frameExp}, scaleMant = ${scaleMant.toFixed(6)}`);
console.log(`  Decimal precision = ${precision}`);

const cRe = new Decimal(cReStr);
const cIm = new Decimal(cImStr);
const TWO = new Decimal(2);
let zr = new Decimal(0);
let zi = new Decimal(0);
const orbit = new Float64Array(maxIter * 4);
let orbitLen = 0;
const t0 = performance.now();
for (let i = 0; i < maxIter; i++) {
  const zrH = zr.toNumber();
  const zrL = zr.minus(zrH).toNumber();
  const ziH = zi.toNumber();
  const ziL = zi.minus(ziH).toNumber();
  orbit[i * 4 + 0] = zrH;
  orbit[i * 4 + 1] = zrL;
  orbit[i * 4 + 2] = ziH;
  orbit[i * 4 + 3] = ziL;
  orbitLen = i + 1;
  if (zrH * zrH + ziH * ziH > 256.0) break;
  const nzr = zr.times(zr).minus(zi.times(zi)).plus(cRe);
  const nzi = zr.times(zi).times(TWO).plus(cIm);
  zr = nzr; zi = nzi;
}
const orbitMs = Math.round(performance.now() - t0);
console.log(`  orbit length = ${orbitLen} (escape${orbitLen < maxIter ? 'd' : ' not reached'}) in ${orbitMs} ms`);

// ---- Render the tile ----

const palette = {
  a: [0.5, 0.5, 0.5],
  b: [0.5, 0.5, 0.5],
  c: [1.0, 1.0, 1.0],
  d: [0.00, 0.10, 0.20],   // warm palette from main.js
  offset: -0.3 * zoomExp,  // same zoom-coupled phase the live renderer uses
};

const tileT0 = performance.now();
const pixels = renderTile({
  tileX: 0, tileY: 0, tileW: width, tileH: height, canvasW: width, canvasH: height,
  orbit, orbitLen,
  scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
  deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
  maxIter, palette,
});
const tileMs = Math.round(performance.now() - tileT0);
console.log(`  render ${width}×${height} in ${tileMs} ms`);

// ---- Summary stats ----

let black = 0;
const colourCounts = new Map();
for (let i = 0; i < pixels.length; i += 4) {
  const rgb = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
  if (rgb === 0) black++;
  colourCounts.set(rgb, (colourCounts.get(rgb) ?? 0) + 1);
}
const totalPixels = width * height;
console.log(`  in-set (black): ${black} / ${totalPixels}`);
console.log(`  escaped: ${totalPixels - black} / ${totalPixels}`);
console.log(`  distinct colours: ${colourCounts.size}`);

// ---- Save as PPM (P6 raw binary) ----

const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
const body = Buffer.alloc(width * height * 3);
for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
  body[j + 0] = pixels[i + 0];
  body[j + 1] = pixels[i + 1];
  body[j + 2] = pixels[i + 2];
}
const outPath = process.argv[8] || 'render-sample.ppm';
writeFileSync(outPath, Buffer.concat([header, body]));
console.log(`  saved PPM → ${outPath}`);

// ---- ASCII preview ----

// Pack two rows into one char line (terminal glyphs are taller than wide).
const ramp = ' .:-=+*#%@';
console.log();
for (let y = 0; y < height; y += 2) {
  let row = '';
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if (r + g + b === 0) {
      row += ' ';            // in-set
    } else {
      const bright = (r + g + b) / (3 * 255);
      const idx = Math.min(ramp.length - 1, Math.floor(bright * ramp.length));
      row += ramp[idx];
    }
  }
  console.log(row);
}
