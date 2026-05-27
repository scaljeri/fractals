// Renders the burning_ship atlas preview PNG using the same iteration
// formula, smooth-iter coloring, and "warm" palette as the live frontend.
//
// Produces frontend/assets/renders/burning_ship.png at 1200×750.
//
// Run from the repo root:
//   node frontend/scripts/render-burning-ship-preview.mjs
//
// Requires `magick` (ImageMagick) on PATH for PPM → PNG.

import { writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PNG = resolve(__dirname, '../assets/renders/burning_ship.png');
const TMP_PPM = resolve(__dirname, '../assets/renders/.burning_ship.ppm');

// Match fractals.js burning_ship defaults
const CENTER = [-0.5, -0.5];
const EXTENT = 2.4;          // vertical
const WIDTH  = 1200;
const HEIGHT = 750;
const MAX_ITER = 1500;       // generous for a static asset
const BAILOUT = 256.0;

// "warm" palette from fractals.js
const WARM_STOPS = [
  [0.00, [  4,  10,  40]],
  [0.16, [ 15,  53, 110]],
  [0.42, [105, 209, 255]],
  [0.64, [255, 252, 210]],
  [0.86, [255, 138,  28]],
  [1.00, [ 50,   7,   0]],
];

const LUT_SIZE = 2048;

function buildLUT(stops) {
  const lut = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    let a = stops[0], b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; }
    }
    const span = b[0] - a[0];
    const f = span > 0 ? (t - a[0]) / span : 0;
    const ff = f * f * (3 - 2 * f);
    lut[i * 4    ] = (a[1][0] + (b[1][0] - a[1][0]) * ff) | 0;
    lut[i * 4 + 1] = (a[1][1] + (b[1][1] - a[1][1]) * ff) | 0;
    lut[i * 4 + 2] = (a[1][2] + (b[1][2] - a[1][2]) * ff) | 0;
  }
  return lut;
}

function lutIndex(smoothIter, shift = 0) {
  if (smoothIter < 0) return -1;
  const t = Math.log(smoothIter + 1) * 0.20 + shift;
  let f = t - Math.floor(t);
  if (f < 0) f += 1;
  return (f * (LUT_SIZE - 1)) | 0;
}

const lut = buildLUT(WARM_STOPS);

// Same coordinate convention as escape-time-gpu.js / escape-time.js:
//   scale = extent / height; cx = center.x + (px - W/2) * scale; cy similar.
const scale = EXTENT / HEIGHT;
const x0 = CENTER[0] - (WIDTH * 0.5) * scale;
const y0 = CENTER[1] - (HEIGHT * 0.5) * scale;

const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
const t0 = Date.now();
let inSet = 0;

for (let py = 0; py < HEIGHT; py++) {
  const ci = y0 + py * scale;
  for (let px = 0; px < WIDTH; px++) {
    const cr = x0 + px * scale;

    let zr = 0, zi = 0;
    let zr2 = 0, zi2 = 0;
    let i = 0;

    // Burning ship: z := (|re| + i|im|)^2 + c   (matches escape-time-worker.js)
    while (i < MAX_ITER && (zr2 + zi2) <= BAILOUT) {
      const azr = Math.abs(zr);
      const azi = Math.abs(zi);
      const nzi = 2 * azr * azi + ci;
      const nzr = azr * azr - azi * azi + cr;
      zr = nzr; zi = nzi;
      zr2 = zr * zr; zi2 = zi * zi;
      i++;
    }

    const j = (py * WIDTH + px) * 3;
    if (i >= MAX_ITER) {
      pixels[j] = 0; pixels[j + 1] = 0; pixels[j + 2] = 0;
      inSet++;
    } else {
      // Smooth iter — matches escape-time-worker.js
      const log_zn = Math.log(zr2 + zi2) * 0.5;
      const nu = Math.log(log_zn / Math.LN2) / Math.LN2;
      const si = i + 1 - nu;
      const li = lutIndex(si, 0);
      pixels[j]     = lut[li * 4];
      pixels[j + 1] = lut[li * 4 + 1];
      pixels[j + 2] = lut[li * 4 + 2];
    }
  }
  if (py % 100 === 0) {
    process.stdout.write(`  row ${py}/${HEIGHT}\r`);
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n  rendered ${WIDTH}×${HEIGHT} in ${elapsed}s · in-set: ${inSet} / ${WIDTH * HEIGHT}`);

// PPM P6
const header = Buffer.from(`P6\n${WIDTH} ${HEIGHT}\n255\n`);
writeFileSync(TMP_PPM, Buffer.concat([header, pixels]));
console.log(`  wrote ${TMP_PPM}`);

// Convert to PNG
execSync(`magick "${TMP_PPM}" "${OUT_PNG}"`, { stdio: 'inherit' });
unlinkSync(TMP_PPM);
console.log(`✓ wrote ${OUT_PNG}`);
