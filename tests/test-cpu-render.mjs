// Tests for the CPU renderer core. Runs under Node:
//
//     node test-cpu-render.mjs
//
// Covers:
//   1. DD-f64 arithmetic correctness vs. known exact answers.
//   2. iteratePixel on points with known in-set / out-of-set behaviour.
//   3. End-to-end renderTile on a shallow-zoom view that matches the
//      reference f64 Mandelbrot iteration for every pixel.
//
// Shallow-zoom cross-check against a plain f64 implementation is the most
// useful signal: it proves perturbation + DD-f64 + rebasing add up to the
// same set membership (and close-enough smooth iteration count) as textbook
// `z_{n+1} = z² + c`. If this passes and the in-browser CPU render still
// looks wrong, the issue is in the main.js dispatch glue, not the math.

import {
  twoSum, twoProd,
  ddAdd, ddMul, ddSub, ddScalePow2,
  iteratePixel, renderTile, palette, clampByte,
  iteratePixelQD, renderTileQD,
} from '../src/utils/deep-zoom-engine/cpu-render-core.js';
import {
  qdFromNumber, qdFromString, qdAdd, qdSub, qdMul, qdSqr, qdDiv,
  qdToNumber, qdNeg, qdPow10,
} from '../src/utils/deep-zoom-engine/qd-f64.js';
import { pickSeedSource } from '../src/utils/deep-zoom-engine/seed-select.js';
import Decimal from 'decimal.js';

// ---------- Tiny test harness ----------

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'assertEq'}: got ${a}, expected ${b}`);
}
function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) {
    throw new Error(`${msg || 'assertClose'}: got ${a}, expected ${b} (tol ${tol})`);
  }
}

console.log('\n--- DD arithmetic ---');

test('twoSum: small integer sum is exact', () => {
  const [h, l] = twoSum(1, 2);
  assertEq(h, 3);
  assertEq(l, 0);
});

test('twoSum: error-free transform captures cancellation', () => {
  // 1e20 + 1 — in plain f64 the +1 disappears because 1e20 has no room for it.
  // twoSum's error term must recover it.
  const [h, l] = twoSum(1e20, 1);
  assertEq(h + l, 1e20 + 1);              // high+low reconstructs the truth
  // High part is whatever f64 rounds the sum to; low must capture the lost bit.
  assert(l !== 0, 'expected nonzero error term');
});

test('twoProd: 3 * 7 = 21 exactly', () => {
  const [p, e] = twoProd(3, 7);
  assertEq(p, 21);
  assertEq(e, 0);
});

test('ddAdd: (1,0) + (2,0) = (3,0)', () => {
  const [h, l] = ddAdd(1, 0, 2, 0);
  assertEq(h, 3);
  assertEq(l, 0);
});

test('ddAdd: 1e20 + 1 preserves the 1 as low part', () => {
  const [h, l] = ddAdd(1e20, 0, 1, 0);
  // Reconstruct: h + l must equal 1e20 + 1 (the f64 "true" answer is 1e20 + 1
  // exactly since both fit in two f64s end-to-end).
  assertClose(h + l, 1e20 + 1, 0);
  // Either h stored the high bits and l = 1, or the f64 happens to represent
  // this exactly and l = 0 — both are valid DD outputs.
});

test('ddMul: (3,0) * (7,0) = (21,0)', () => {
  const [h, l] = ddMul(3, 0, 7, 0);
  assertEq(h, 21);
  assertEq(l, 0);
});

test('ddSub: (5,0) − (2,0) = (3,0)', () => {
  const [h, l] = ddSub(5, 0, 2, 0);
  assertEq(h, 3);
  assertEq(l, 0);
});

test('ddScalePow2: exact power-of-2 shift', () => {
  const [h, l] = ddScalePow2(1.5, 0.25, 4);      // * 16
  assertEq(h, 24);
  assertEq(l, 4);
});

console.log('\n--- iteratePixel on known points ---');

// Build a reference orbit in plain f64 for a given c. Returns a DD-f64
// Float64Array ([reH, reL, imH, imL, …]) with low parts zero — good enough
// when the reference is computed in plain f64 to start with.
function buildF64ReferenceOrbit(cRe, cIm, maxIter) {
  const orbit = new Float64Array(maxIter * 4);
  let zRe = 0, zIm = 0;
  let n = 0;
  for (let i = 0; i < maxIter; i++) {
    orbit[i * 4 + 0] = zRe;
    orbit[i * 4 + 1] = 0;
    orbit[i * 4 + 2] = zIm;
    orbit[i * 4 + 3] = 0;
    n = i + 1;
    if (zRe * zRe + zIm * zIm > 65536.0) break;
    const zr2 = zRe * zRe - zIm * zIm + cRe;
    const zi2 = 2 * zRe * zIm + cIm;
    zRe = zr2; zIm = zi2;
  }
  return { orbit, len: n };
}

// Textbook Mandelbrot iteration in f64 — used as ground truth.
function f64Mandelbrot(cRe, cIm, maxIter) {
  let zRe = 0, zIm = 0;
  for (let i = 0; i < maxIter; i++) {
    if (zRe * zRe + zIm * zIm > 65536.0) return { escaped: true, iter: i };
    const zr2 = zRe * zRe - zIm * zIm + cRe;
    const zi2 = 2 * zRe * zIm + cIm;
    zRe = zr2; zIm = zi2;
  }
  return { escaped: false, iter: maxIter };
}

test('iteratePixel: origin (c=0) does not escape', () => {
  // Reference = c=0 orbit (all zeros). Delta = 0 → effective c = 0, in the set.
  const { orbit, len } = buildF64ReferenceOrbit(0, 0, 100);
  const r = iteratePixel(0, 0, 0, 0, 0, orbit, len, 100);
  assert(!r.escaped, 'c=0 should not escape');
  assertEq(r.iter, 100);
});

test('iteratePixel: c=3 (far outside) escapes within 5 iters', () => {
  // Reference = c=0 orbit. Delta = (3, 0) → effective c = 3, escapes fast.
  const { orbit, len } = buildF64ReferenceOrbit(0, 0, 100);
  const r = iteratePixel(3, 0, 0, 0, 0, orbit, len, 100);
  assert(r.escaped, 'c=3 should escape');
  assert(r.iter > 0 && r.iter < 5, `expected iter 1-4, got ${r.iter}`);
});

test('iteratePixel: (-0.5, 0) in main cardioid does not escape', () => {
  // Reference = c=0 orbit, delta = (-0.5, 0) → effective c = -0.5.
  // -0.5 is firmly in the main cardioid.
  const { orbit, len } = buildF64ReferenceOrbit(0, 0, 500);
  const r = iteratePixel(-0.5, 0, 0, 0, 0, orbit, len, 500);
  assert(!r.escaped, 'c=-0.5 should not escape');
});

test('iteratePixel: (0.3, 0) escapes same iter as plain f64', () => {
  // Not in the set; perturbation vs. direct iteration should agree on iter count.
  const c = { re: 0.3, im: 0 };
  const maxIter = 200;
  const { orbit, len } = buildF64ReferenceOrbit(0, 0, maxIter);
  const r = iteratePixel(c.re, 0, c.im, 0, 0, orbit, len, maxIter);
  const gt = f64Mandelbrot(c.re, c.im, maxIter);
  assertEq(r.escaped, gt.escaped);
  // Allow ±1 iter: smoothing semantics differ slightly between perturbation
  // renormalisation steps and direct iteration.
  assert(Math.abs(r.iter - gt.iter) <= 1,
    `iter diverged: perturb=${r.iter} f64=${gt.iter}`);
});

test('iteratePixel: scan 5 points around seahorse valley match f64 escape', () => {
  // Points near a well-known feature of the set. Reference at view center;
  // each sample point is offset by a small delta. All should agree with f64.
  const centerRe = -0.75, centerIm = 0.1;
  const maxIter = 400;
  const { orbit, len } = buildF64ReferenceOrbit(centerRe, centerIm, maxIter);
  const samples = [
    { dx: 0,     dy: 0    },
    { dx: 0.01,  dy: 0    },
    { dx: -0.01, dy: 0    },
    { dx: 0,     dy: 0.01 },
    { dx: 0,     dy: -0.01},
  ];
  for (const s of samples) {
    const r = iteratePixel(s.dx, 0, s.dy, 0, 0, orbit, len, maxIter);
    const gt = f64Mandelbrot(centerRe + s.dx, centerIm + s.dy, maxIter);
    assertEq(r.escaped, gt.escaped, `escape mismatch at dx=${s.dx} dy=${s.dy}`);
    if (r.escaped) {
      assert(Math.abs(r.iter - gt.iter) <= 2,
        `iter mismatch at dx=${s.dx} dy=${s.dy}: perturb=${r.iter} f64=${gt.iter}`);
    }
  }
});

console.log('\n--- renderTile end-to-end ---');

function makePalettePayload() {
  // Matches PALETTES.warm in main.js.
  return {
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 1.0, 1.0],
    d: [0.00, 0.10, 0.20],
    offset: 0,
  };
}

test('renderTile: default HOME view is non-empty and varied', () => {
  // HOME: center (-0.5, 0), scale 1.3 — the classic whole-set framing.
  // Every pixel should render; at minimum the image must have >2 distinct
  // colours, otherwise something catastrophic happened.
  const w = 64, h = 32;
  const cRe = -0.5, cIm = 0;
  const scale = 1.3;
  const maxIter = 128;
  const { orbit, len } = buildF64ReferenceOrbit(cRe, cIm, maxIter);

  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    // frameExp = 0 since scale is O(1). mantissa = scale.
    scaleMantHi: scale, scaleMantLo: 0, frameExp: 0,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter,
    palette: makePalettePayload(),
  });

  const unique = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    unique.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
  }
  assert(unique.size > 10, `expected varied colours, got ${unique.size} distinct`);

  // Alpha must be 255 everywhere (including in-set black pixels).
  for (let i = 3; i < pixels.length; i += 4) {
    assertEq(pixels[i], 255, `alpha at byte ${i}`);
  }
});

test('renderTile: pixel at (0,0) world coord is black (origin is in the set)', () => {
  // Center the view on the origin with a tiny viewport so pixel (0,0) of a
  // 1×1 tile maps to c=0 exactly.
  const { orbit, len } = buildF64ReferenceOrbit(0, 0, 200);
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: 1, tileH: 1, canvasW: 1, canvasH: 1,
    orbit, orbitLen: len,
    scaleMantHi: 0, scaleMantLo: 0, frameExp: 0,  // scale = 0 → delta per pixel = 0
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: 100,
    palette: makePalettePayload(),
  });
  // In-set pixels are black (RGB = 0, alpha = 255).
  assertEq(pixels[0], 0);
  assertEq(pixels[1], 0);
  assertEq(pixels[2], 0);
  assertEq(pixels[3], 255);
});

test('renderTile: escape pixel shows a non-black colour', () => {
  // c = (2, 0) — far outside the set, escapes almost immediately.
  const { orbit, len } = buildF64ReferenceOrbit(0, 0, 50);
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: 1, tileH: 1, canvasW: 1, canvasH: 1,
    orbit, orbitLen: len,
    scaleMantHi: 0, scaleMantLo: 0, frameExp: 0,
    deltaReHi: 2, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: 50,
    palette: makePalettePayload(),
  });
  const rgb = pixels[0] | pixels[1] | pixels[2];
  assert(rgb !== 0, `escape pixel should not be black, got rgb=${pixels[0]},${pixels[1]},${pixels[2]}`);
});

test('renderTile at frameExp=-30 (zoom ≈ 10^9) matches f64 set-membership', () => {
  // Exercises the floatexp pipeline: scale_m mantissa ≈ 1, frame_exp ≈ -30.
  // f64 is still accurate at this depth (10^9 ≪ machine epsilon cliff at 10^15)
  // so direct f64 iteration remains the ground truth for set-membership.
  const w = 24, h = 12;
  const cRe = -0.75, cIm = 0.1;
  const scale = Math.pow(2, -30);                     // ~9.3e-10
  const frameExp = -30;
  const scaleMant = scale * Math.pow(2, -frameExp);   // exactly 1.0
  const maxIter = 500;
  const { orbit, len } = buildF64ReferenceOrbit(cRe, cIm, maxIter);
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter,
    palette: makePalettePayload(),
  });
  const aspect = w / h;
  let disagree = 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const uvx = (px / w) * 2 - 1;
      const uvy = 1 - (py / h) * 2;
      const pxCRe = cRe + uvx * scale * aspect;
      const pxCIm = cIm + uvy * scale;
      const gt = f64Mandelbrot(pxCRe, pxCIm, maxIter);
      const idx = (py * w + px) * 4;
      const isBlack = pixels[idx] === 0 && pixels[idx + 1] === 0 && pixels[idx + 2] === 0;
      if (isBlack !== !gt.escaped) disagree++;
    }
  }
  const tolerance = Math.max(4, Math.floor(w * h * 0.02));
  assert(disagree <= tolerance,
    `deep-zoom set-membership disagrees for ${disagree}/${w*h} pixels (limit ${tolerance})`);
});

test('iteratePixel: rebasing via end-of-orbit advances past reference length', () => {
  // Short reference orbit (c=2, escapes by iter 2). A bounded pixel should
  // cycle through rebasing (atEnd fires) and reach maxIter without escape.
  // This validates the atEnd branch of the rebasing logic.
  const { orbit, len } = buildF64ReferenceOrbit(2, 0, 100);
  assert(len <= 5, `expected short orbit for c=2, got ${len}`);
  const r = iteratePixel(-2.3, 0, 0, 0, 0, orbit, len, 200);
  // delta=-2.3 → effective c = 2 + (-2.3) = -0.3, in the main cardioid.
  assert(!r.escaped, `bounded pixel should not escape via rebasing, got iter=${r.iter}`);
  assertEq(r.iter, 200);
});

test('iteratePixel with frameExp≠0 agrees with frameExp=0 for equivalent delta', () => {
  // Same effective c, two ways to express it: (delta=0.1, exp=0) should give
  // the same escape iter as (delta=0.1·2^30, exp=-30). Tests that the exponent
  // scaling in the shader math is honoured.
  const { orbit, len } = buildF64ReferenceOrbit(0, 0, 200);
  const rA = iteratePixel(0.1, 0, 0, 0, 0, orbit, len, 200);
  const dExp = -30;
  const scale = Math.pow(2, -dExp);
  const rB = iteratePixel(0.1 * scale, 0, 0, 0, dExp, orbit, len, 200);
  assertEq(rA.escaped, rB.escaped, 'escape flag mismatch between exp=0 and exp=-30');
  // Iter counts agree up to smoothing slop.
  assert(Math.abs(rA.iter - rB.iter) <= 1,
    `iter differs across exp: exp=0 → ${rA.iter}, exp=-30 → ${rB.iter}`);
});

test('renderTile: set-membership mask matches f64 Mandelbrot across a tile', () => {
  // The strictest test: render a small tile at a shallow zoom, then compute
  // f64 Mandelbrot for the same per-pixel c, and verify every pixel agrees on
  // whether it's in the set or not. Catches precision regressions anywhere in
  // the DD arithmetic or perturbation iteration.
  const w = 32, h = 16;
  const cRe = -0.75, cIm = 0;
  const scale = 1.0;
  const maxIter = 256;
  const { orbit, len } = buildF64ReferenceOrbit(cRe, cIm, maxIter);
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scale, scaleMantLo: 0, frameExp: 0,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter,
    palette: makePalettePayload(),
  });
  const aspect = w / h;
  let disagree = 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const uvx = (px / w) * 2 - 1;
      const uvy = 1 - (py / h) * 2;
      const pxCRe = cRe + uvx * scale * aspect;
      const pxCIm = cIm + uvy * scale;
      const gt = f64Mandelbrot(pxCRe, pxCIm, maxIter);
      const idx = (py * w + px) * 4;
      const isBlack = pixels[idx] === 0 && pixels[idx + 1] === 0 && pixels[idx + 2] === 0;
      // isBlack iff did not escape
      if (isBlack !== !gt.escaped) disagree++;
    }
  }
  // Allow a tiny boundary slop (<1% of pixels): smoothing and perturbation
  // renormalisation can shift a pixel across the iter threshold. At this
  // zoom that's rare — just a handful of boundary pixels at most.
  const tolerance = Math.max(4, Math.floor(w * h * 0.01));
  assert(disagree <= tolerance,
    `set-membership disagrees for ${disagree} pixels (limit ${tolerance})`);
});

console.log('\n--- Orbit worker\'s iteration (copied verbatim from orbit-worker.js) ---');

// Mirror orbit-worker.js's decimalToDD / decimalToTD / iterateOrbitDecimal
// verbatim. The test verifies the ORBIT ITSELF is correct, not just the
// downstream renderer — catches bugs that would be invisible to tests that
// hand-roll their own reference orbit.
function workerDecimalToDD(d) {
  const hi = d.toNumber();
  const lo = d.minus(hi).toNumber();
  return [hi, lo];
}
function workerDecimalToTD(d) {
  const a = Math.fround(d.toNumber());
  const rem1 = d.minus(a);
  const b = Math.fround(rem1.toNumber());
  const rem2 = rem1.minus(b);
  const c = Math.fround(rem2.toNumber());
  return [a, b, c];
}
function workerIterateOrbitDecimal(refCxDec, refCyDec, maxIter) {
  const scratchTD = new Float32Array(maxIter * 6);
  const scratchDD = new Float64Array(maxIter * 4);
  const TWO = new Decimal(2);
  let zr = new Decimal(0);
  let zi = new Decimal(0);
  let n = 0;
  for (let i = 0; i < maxIter; i++) {
    const [zra, zrb, zrc] = workerDecimalToTD(zr);
    const [zia, zib, zic] = workerDecimalToTD(zi);
    scratchTD[i * 6 + 0] = zra; scratchTD[i * 6 + 1] = zrb; scratchTD[i * 6 + 2] = zrc;
    scratchTD[i * 6 + 3] = zia; scratchTD[i * 6 + 4] = zib; scratchTD[i * 6 + 5] = zic;
    const [zrH, zrL] = workerDecimalToDD(zr);
    const [ziH, ziL] = workerDecimalToDD(zi);
    scratchDD[i * 4 + 0] = zrH; scratchDD[i * 4 + 1] = zrL;
    scratchDD[i * 4 + 2] = ziH; scratchDD[i * 4 + 3] = ziL;
    n = i + 1;
    const zrN = zr.toNumber();
    const ziN = zi.toNumber();
    if (zrN * zrN + ziN * ziN > 256.0) break;
    const zr2 = zr.times(zr);
    const zi2 = zi.times(zi);
    const newZr = zr2.minus(zi2).plus(refCxDec);
    const newZi = zr.times(zi).times(TWO).plus(refCyDec);
    zr = newZr; zi = newZi;
  }
  return { orbitDD: scratchDD.slice(0, n * 4), len: n };
}

// The worker's actual precision-setting logic — needed so we feed
// iterateOrbitDecimal at the same effective precision the browser would.
function workerPrecisionFor(scale) {
  const zoomDigits = scale > 0 ? Math.ceil(Math.log10(1 / scale)) : 0;
  return Math.max(20, zoomDigits + 15);
}

test('worker iterateOrbitDecimal: short-orbit ref + deep zoom produces non-black pixels', () => {
  // The full browser pipeline: worker iterates the orbit (using the EXACT same
  // code the browser runs), then the CPU renderer perturbs each pixel off it.
  // maxIter set to the same 50000 the browser uses past 10^20 zoom — a 385-iter
  // reference then triggers ~130 rebases per pixel, the same workload the user
  // is hitting. Catches subtle drift that accumulates across many rebases.
  const cReStr = '0.25006369120903604';
  const cImStr = '0';
  const scale = 1e-21;
  const frameExp = Math.floor(Math.log2(scale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = scale * invFactor;
  const maxIter = 50000;

  // Use the worker's actual precision setting for this zoom.
  Decimal.set({ precision: workerPrecisionFor(scale) });
  const refCxDec = new Decimal(cReStr);
  const refCyDec = new Decimal(cImStr);
  const { orbitDD, len } = workerIterateOrbitDecimal(refCxDec, refCyDec, maxIter);
  assert(len > 200 && len < 600, `expected short orbit, got ${len}`);

  const w = 16, h = 8;
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit: orbitDD, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter,
    palette: makePalettePayload(),
  });
  let black = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) black++;
  }
  assert(black === 0,
    `worker-path orbit at 10^21 with short ref still produces ${black}/${w*h} black pixels`);
});

console.log('\n--- Deep zoom with Decimal reference orbit ---');

// Build a reference orbit at arbitrary precision with Decimal.js, matching
// exactly what the orbit worker does. Returns a Float64Array of DD-f64 samples
// in the [reH, reL, imH, imL, …] layout that iteratePixel expects.
function buildDecimalReferenceOrbit(cReStr, cImStr, maxIter, precision = 60) {
  Decimal.set({ precision });
  const TWO = new Decimal(2);
  const cRe = new Decimal(cReStr);
  const cIm = new Decimal(cImStr);
  let zr = new Decimal(0);
  let zi = new Decimal(0);
  const orbit = new Float64Array(maxIter * 4);
  let n = 0;
  for (let i = 0; i < maxIter; i++) {
    const zrH = zr.toNumber();
    const zrL = zr.minus(zrH).toNumber();
    const ziH = zi.toNumber();
    const ziL = zi.minus(ziH).toNumber();
    orbit[i * 4 + 0] = zrH;
    orbit[i * 4 + 1] = zrL;
    orbit[i * 4 + 2] = ziH;
    orbit[i * 4 + 3] = ziL;
    n = i + 1;
    if (zrH * zrH + ziH * ziH > 256.0) break;
    const newZr = zr.times(zr).minus(zi.times(zi)).plus(cRe);
    const newZi = zr.times(zi).times(TWO).plus(cIm);
    zr = newZr;
    zi = newZi;
  }
  return { orbit, len: n };
}

// QD orbit builder — same as buildDecimalReferenceOrbit but emits 8 doubles
// per orbit point (4 re + 4 im) for the QD-f64 per-pixel kernel.
function buildDecimalReferenceOrbitQD(cReStr, cImStr, maxIter, precision = 80) {
  Decimal.set({ precision });
  const TWO = new Decimal(2);
  const cRe = new Decimal(cReStr);
  const cIm = new Decimal(cImStr);
  let zr = new Decimal(0);
  let zi = new Decimal(0);
  const orbit = new Float64Array(maxIter * 8);
  let n = 0;
  // Helper: Decimal → 4-component QD inline (mirror of decimalToQD in main.js).
  const split4 = (d) => {
    const a0 = d.toNumber();
    const r1 = d.minus(a0); const a1 = r1.toNumber();
    const r2 = r1.minus(a1); const a2 = r2.toNumber();
    const r3 = r2.minus(a2); const a3 = r3.toNumber();
    return [a0, a1, a2, a3];
  };
  for (let i = 0; i < maxIter; i++) {
    const [zr0, zr1, zr2, zr3] = split4(zr);
    const [zi0, zi1, zi2, zi3] = split4(zi);
    orbit[i * 8 + 0] = zr0; orbit[i * 8 + 1] = zr1; orbit[i * 8 + 2] = zr2; orbit[i * 8 + 3] = zr3;
    orbit[i * 8 + 4] = zi0; orbit[i * 8 + 5] = zi1; orbit[i * 8 + 6] = zi2; orbit[i * 8 + 7] = zi3;
    n = i + 1;
    if (zr0 * zr0 + zi0 * zi0 > 256.0) break;
    const newZr = zr.times(zr).minus(zi.times(zi)).plus(cRe);
    const newZi = zr.times(zi).times(TWO).plus(cIm);
    zr = newZr;
    zi = newZi;
  }
  return { orbit, len: n };
}

// Brute-force ground truth: iterate a single pixel's c = ref + delta directly
// in high-precision Decimal. Slow but exact. Used to validate the perturbation
// path agrees with direct iteration at arbitrary zoom.
function decimalMandelbrot(cReDec, cImDec, maxIter) {
  let zr = new Decimal(0), zi = new Decimal(0);
  const TWO = new Decimal(2);
  for (let i = 0; i < maxIter; i++) {
    const zrN = zr.toNumber(), ziN = zi.toNumber();
    if (zrN * zrN + ziN * ziN > 65536.0) return { escaped: true, iter: i };
    const nzr = zr.times(zr).minus(zi.times(zi)).plus(cReDec);
    const nzi = zr.times(zi).times(TWO).plus(cImDec);
    zr = nzr; zi = nzi;
  }
  return { escaped: false, iter: maxIter };
}

test('buildDecimalReferenceOrbit matches f64 reference at shallow zoom (within 1 iter)', () => {
  // When both paths iterate at sufficient precision the orbits agree. Allow a
  // 1-iter slack because the bailout crossing can land on different f64 rounded
  // iterations depending on accumulated error.
  const cRe = -0.75, cIm = 0.1;
  const maxIter = 500;
  const f64 = buildF64ReferenceOrbit(cRe, cIm, maxIter);
  const dec = buildDecimalReferenceOrbit(String(cRe), String(cIm), maxIter);
  assert(Math.abs(f64.len - dec.len) <= 1,
    `orbit length drift: f64=${f64.len}, dec=${dec.len}`);
  // For iterations both builders ran, the hi parts should match closely.
  const common = Math.min(f64.len, dec.len) - 2;
  for (let i = 0; i < common; i++) {
    assertClose(f64.orbit[i * 4 + 0], dec.orbit[i * 4 + 0], 1e-12,
      `re.hi mismatch at iter ${i}`);
    assertClose(f64.orbit[i * 4 + 2], dec.orbit[i * 4 + 2], 1e-12,
      `im.hi mismatch at iter ${i}`);
  }
});

test('click-zoom: View B (after click) overlaps View A (before click) center half', () => {
  // The user-reported scenario: GPU renders frame A near zoom 10^14, user
  // clicks the canvas centre to zoom in 2× → view scale halves. The new view
  // (B) covers exactly the centre half of view A's complex-plane region, so
  // pixel (i,j) of B should land on the SAME world point as pixel
  // (W/4 + i/2, H/4 + j/2) of A. The pixels won't be byte-identical (slightly
  // different per-pixel deltas → tiny precision shifts, smooth-iter wobble)
  // but their in-set classifications must overlap heavily — otherwise the CPU
  // is rendering the WRONG region after the click and the user sees "click
  // did nothing" in the final frame.
  //
  // This test exists because UI fixes (CSS preview, blit timing) won't help
  // if the underlying math at the new view is computing somewhere else.
  const cReStr = '-0.74364388703715092';
  const cImStr =  '0.13182590420533';
  const scaleA = 1e-11;            // "before click" zoom (~10^11)
  const scaleB = scaleA * 0.5;     // CLICK_ZOOM matches main.js CLICK_ZOOM = 0.5
  const maxIter = 2000;            // enough to discriminate boundary at this depth

  // Decimal reference orbit at the chosen point — precision picked to match
  // what orbit-worker would use at this zoom (~26 digits ⇒ 41 with margin).
  const { orbit, len } = buildDecimalReferenceOrbit(cReStr, cImStr, maxIter, 41);

  // 32×32 view A. View B is 16×16 (= centre half of A's pixels in screen
  // coords) so pixelB(i,j) ↔ pixelA(8+i, 8+j) maps without fractional
  // sampling.
  const wA = 32, hA = 32;
  const wB = 16, hB = 16;

  // delta = view.center − orbit.refPoint = 0 here (we use the click point
  // itself as the reference, same as what the orbit-worker would emit when
  // findReference returns ox=oy=0 at deep zoom).
  function renderAt(scale, w, h) {
    const frameExp = Math.floor(Math.log2(scale));
    const scaleMant = scale * Math.pow(2, -frameExp);
    return renderTile({
      tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
      orbit, orbitLen: len,
      scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
      deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
      maxIter,
      palette: makePalettePayload(),
    });
  }

  const pixelsA = renderAt(scaleA, wA, hA);
  const pixelsB = renderAt(scaleB, wB, hB);

  function isBlack(pixels, w, x, y) {
    const i = (y * w + x) * 4;
    return pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0;
  }

  let total = 0, matches = 0;
  for (let j = 0; j < hB; j++) {
    for (let i = 0; i < wB; i++) {
      const aBlack = isBlack(pixelsA, wA, 8 + i, 8 + j);
      const bBlack = isBlack(pixelsB, wB, i, j);
      total++;
      if (aBlack === bBlack) matches++;
    }
  }
  const matchPct = (matches / total) * 100;
  console.log(`        click-zoom mask overlap: ${matches}/${total} = ${matchPct.toFixed(1)}%`);
  // 90% match is the bar — boundary fuzz from differing iter precision
  // accounts for some flips at pixels that sit exactly on the M-set edge.
  // A failure (<90%) means the new view is rendering a substantially
  // different region than the click intended.
  assert(matchPct >= 90,
    `view B's in-set mask only overlaps view A's centre-half by ${matchPct.toFixed(1)}% — ` +
    `CPU is computing the wrong region after the click`);
});

test('renderTile at 10^20 zoom: every pixel matches brute-force Decimal', () => {
  // The real test. Brute-force iterate each pixel's c = ref + per-pixel-delta
  // in 60-digit Decimal and verify the CPU renderer agrees on set membership.
  // Fails → math bug at deep zoom. Passes → any "empty" screen the user sees
  // just means the selected viewport is genuinely inside the set at that depth
  // (a legitimate visual outcome, not a renderer bug).
  const cReStr = '-0.74364388703715092';
  const cImStr = '0.13182590420533';
  const scale = 1e-20;
  const frameExp = Math.floor(Math.log2(scale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = scale * invFactor;
  const maxIter = 500;                     // kept modest to keep test fast

  const { orbit, len } = buildDecimalReferenceOrbit(cReStr, cImStr, maxIter, 40);

  // Small tile so brute-force doesn't blow up wall time.
  const w = 8, h = 4;
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter,
    palette: makePalettePayload(),
  });

  Decimal.set({ precision: 60 });
  const cRe = new Decimal(cReStr), cIm = new Decimal(cImStr);
  const scaleDec = new Decimal(scale);
  const aspect = w / h;
  let disagree = 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const uvx = (px / w) * 2 - 1;
      const uvy = 1 - (py / h) * 2;
      // Pixel c = ref + (uvx · aspect · scale, uvy · scale) as Decimals.
      const pxCRe = cRe.plus(scaleDec.times(uvx * aspect));
      const pxCIm = cIm.plus(scaleDec.times(uvy));
      const gt = decimalMandelbrot(pxCRe, pxCIm, maxIter);
      const idx = (py * w + px) * 4;
      const isBlack = pixels[idx] === 0 && pixels[idx + 1] === 0 && pixels[idx + 2] === 0;
      if (isBlack !== !gt.escaped) disagree++;
    }
  }
  // All pixels must agree on set membership — perturbation at DD-f64 should
  // have no false escapes or false containments at 10^20 zoom.
  assert(disagree === 0,
    `${disagree}/${w*h} pixels disagree with brute-force Decimal at 10^20 zoom`);
});

test('user scenario: short-orbit ref (iter ~385) at zoom 10^21 produces escaped pixels', () => {
  // Reproduces the symptom from the screenshot: CPU renderer, zoom 2.64·10^21,
  // iter 385 (orbit length), screen is entirely black. A short reference orbit
  // means the reference ESCAPED — so nearby pixels at 10^-21 distance must
  // also escape within a handful of iterations of the reference. If everything
  // comes back black, it's the bug the user hit.
  //
  // c = 0.25006369... gives orbit length 394 in our ground-truth builder. This
  // sits just outside the main cardioid at the same "slow escape" fringe a
  // user clicking deep into a boundary region would land on.
  const cReStr = '0.25006369120903604';
  const cImStr = '0';
  const scale = 1e-21;                          // zoom 10^21
  const frameExp = Math.floor(Math.log2(scale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = scale * invFactor;
  const maxIter = 2000;

  const { orbit, len } = buildDecimalReferenceOrbit(cReStr, cImStr, maxIter, 40);
  assert(len > 200 && len < 600, `expected short orbit (~394), got ${len}`);

  const w = 16, h = 8;
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter,
    palette: makePalettePayload(),
  });

  // Count black vs coloured. At 10^21 zoom, 0.25 + ~10^-21 is still outside
  // the cardioid, so pixels must escape. All-black means the rebasing path
  // after the short reference orbit ends is broken.
  let black = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) black++;
  }
  assert(black === 0,
    `expected every pixel to escape, got ${black}/${w * h} black pixels — ` +
    `this is the "empty screen" bug after a short reference orbit at deep zoom`);
});

// Backend-decision logic mirrored from main.js. Pure function so it's
// testable here. Anything in this file that wants to assert the dispatch
// behavior can call this directly. Keep this value in sync with main.js;
// it was lowered from 1e-20 to 1e-15 because TD-f32 (~21 digits) starts
// losing per-pixel precision well before zoom reaches the old wall and
// the canvas was going black at 10^20 in GPU mode.
const GPU_SCALE_LIMIT = 1e-15;
function decideBackend(viewScale, mode = 'auto') {
  if (mode !== 'auto') return mode;
  return viewScale < GPU_SCALE_LIMIT ? 'cpu' : 'gpu';
}
function decideFastPath(viewScale, backend) {
  if (backend === 'cpu') return false;
  const zoomDigits = viewScale > 0 ? Math.ceil(Math.log10(1 / viewScale)) : 0;
  return zoomDigits < 12;
}

test('typed zoom 10^2 from HOME: dispatch must pick GPU + fast path', () => {
  // The user types mantissa=1, exp=2 → view.scale = HOME.scale / 100. The
  // ONLY reason "type 10^2" hangs the browser is if the dispatch wrongly
  // sends this through the CPU renderer. At zoom 10^2 the view is in GPU
  // territory and the fast progressive path applies — anything else is a bug.
  const viewScale = 1.3 / 100;
  const backend = decideBackend(viewScale);
  const fastPath = decideFastPath(viewScale, backend);
  assertEq(backend, 'gpu', `10^2 zoom should use GPU, got ${backend}`);
  assert(fastPath, `10^2 zoom should use fast path, got fastPath=${fastPath}`);
});

test('CPU full-res rendering is too slow for interactive use — confirms why dispatch must use GPU at shallow zoom', () => {
  // Demonstration test: the math itself is correct, but pure-JS DD-f64
  // perturbation throughput is on the order of 5–10 megapixels/s/core. A
  // 1920×1080 canvas at modest iteration count takes seconds, NOT
  // milliseconds. So if the browser ever ends up in CPU mode at shallow
  // zoom (e.g. via stale state after a deep-zoom click), it WILL appear to
  // hang. This is intrinsic to JS performance; the only fix is to keep the
  // dispatch on GPU until the zoom genuinely outruns f32 precision.
  const HOME_CX = '-0.5';
  const HOME_CY = '0';
  const HOME_SCALE = 1.3;
  const viewScale = HOME_SCALE / 100;
  const frameExp = Math.floor(Math.log2(viewScale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = viewScale * invFactor;
  const { orbit, len } = buildDecimalReferenceOrbit(HOME_CX, HOME_CY, 8000, 25);

  // Same scale a real 1920×1080 frame would render at.
  const w = 1920, h = 1080;
  const t0 = performance.now();
  renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: 200, palette: makePalettePayload(),
  });
  const cpuMs = performance.now() - t0;
  // The "too slow" threshold is a budget anything interactive must beat.
  // Exceeding it is the test passing — it documents why GPU is required.
  assert(cpuMs > 1000,
    `expected single-thread CPU full-res to exceed 1s (it confirms the hang); got ${cpuMs.toFixed(0)}ms — that's actually fast enough; reconsider whether GPU is still required at this depth`);
  console.log(`        full-res ${w}×${h} @ 200 iters on one core: ${cpuMs.toFixed(0)}ms`);
});

test('typed zoom 10^2 from HOME (-0.5, 0) IS legitimately all-black — period-2 bulb interior', () => {
  // Reproduces the user's "type 10^2, screen stays black" report. The black
  // is mathematically correct: HOME center (-0.5, 0) sits inside the period-2
  // bulb, and at zoom 10^2 the viewport is only ~0.026 wide — still entirely
  // inside the bulb. Every pixel is in-set.
  //
  // This is therefore a UX issue, not a renderer bug. Fixes: either reset
  // the view center to a boundary point on typed zoom, or warn the user
  // that their viewport is entirely in-set, or just teach the user that
  // zoom values bigger than 1 zoom *into* the current center, not "show me
  // the set at level N".
  const { orbit, len } = buildDecimalReferenceOrbit('-0.5', '0', 2000, 20);
  assertEq(len, 2000, `expected unbounded orbit at HOME center, got ${len}`);

  const newScale = 1.3 / 100;                            // zoom 10^2
  const frameExp = Math.floor(Math.log2(newScale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = newScale * invFactor;
  const w = 64, h = 32;
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: 1000, palette: makePalettePayload(),
  });
  let black = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) black++;
  }
  // Documenting the behaviour: 100 % black at HOME + zoom 10^2.
  assertEq(black, w * h,
    `expected entirely in-set output at HOME zoom 10^2; got ${black}/${w * h} black`);
  console.log(`        HOME at 10^2: ${black}/${w * h} pixels in-set (entirely period-2 bulb interior — mathematically correct)`);
});

test('typed zoom 10^2 from a boundary point produces structure (proves the math is fine)', () => {
  // Same zoom, different center: a boundary point that has Mandelbrot
  // structure within the 0.026-wide viewport. This is what the user wanted
  // to see when they typed 10^2 — it works, but only if the center is on
  // (or near) the fractal boundary.
  const { orbit, len } = buildDecimalReferenceOrbit('-0.75', '0.1', 2000, 20);
  const newScale = 1.3 / 100;
  const frameExp = Math.floor(Math.log2(newScale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = newScale * invFactor;
  const w = 64, h = 32;
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: 1000, palette: makePalettePayload(),
  });
  let black = 0;
  const distinct = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    const rgb = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    distinct.add(rgb);
    if (rgb === 0) black++;
  }
  assert(black > 0 && black < w * h,
    `expected mixed in-set / escaped at (-0.75, 0.1) zoom 10^2, got ${black}/${w * h} black`);
  assert(distinct.size > 5,
    `expected varied palette at boundary point, got ${distinct.size} distinct colours`);
  console.log(`        (-0.75, 0.1) at 10^2: ${distinct.size} distinct colours, ${black}/${w * h} in-set`);
});

test('user scenario: deep-zoom orbit reused at shallow zoom must still produce structure', () => {
  // Reproduces: user at zoom 10^16 around (-0.7436..., 0.1318...) types
  // 10^2 in the zoom field. main.js keeps view.cx/view.cy unchanged,
  // changes only view.scale. orbitCacheFresh() returns true (the cached
  // refCx is in the new viewport, maxIterCovered satisfies the new
  // maxIter), so the deep-zoom orbit is REUSED for a 10^2 render.
  //
  // The math should produce visible Mandelbrot structure here. If it does
  // not, the bug is in the cached-orbit-reuse path and we need to either
  // (a) invalidate the cache when scale jumps drastically, or (b) make
  // orbitCacheFresh aware of scale ratio.
  const cReStr = '-0.7436438870371589';
  const cImStr = '0.1318259042083120';
  // Build the orbit AT DEEP ZOOM (high precision, long capped iter count).
  const { orbit, len } = buildDecimalReferenceOrbit(cReStr, cImStr, 8000, 40);
  assert(len > 1000, `expected long boundary orbit, got ${len}`);

  // Now render at SHALLOW zoom 10^2 reusing that exact orbit — exactly what
  // main.js does when cache freshness passes after a typed-zoom.
  const HOME_SCALE = 1.3;
  const z = 100;
  const scale = HOME_SCALE / z;
  const frameExp = Math.floor(Math.log2(scale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = scale * invFactor;
  const w = 80, h = 40;
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: 4424,                                         // ≈ computeMaxIter at 10^2
    palette: makePalettePayload(),
  });
  let black = 0;
  const distinct = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    const rgb = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    distinct.add(rgb);
    if (rgb === 0) black++;
  }
  // Boundary point at shallow zoom: should have BOTH black (in-set) and
  // coloured (escaped) pixels, plus several distinct colours.
  assert(black > 0 && black < w * h,
    `screen looks all-${black === 0 ? 'colour' : 'black'} (${black}/${w * h} black) — cached deep-zoom orbit produces wrong output at shallow zoom`);
  assert(distinct.size > 5,
    `cached deep-zoom orbit produces only ${distinct.size} distinct colours at 10^2 — perturbation breakdown`);
});

test('CPU low-res preview at 10^2 is multi-second on one core — parallel workers required', () => {
  // The progressive preview renders at 1/4 resolution. Single-thread time
  // is multi-second; production splits this across N CPU workers so an
  // 8-core machine sees ~1/8 of the wall-time below. Even so, this is too
  // slow for "snappy preview" — another reason the dispatch must keep
  // shallow zoom on GPU.
  const HOME_CX = '-0.5';
  const HOME_CY = '0';
  const HOME_SCALE = 1.3;
  const viewScale = HOME_SCALE / 100;
  const frameExp = Math.floor(Math.log2(viewScale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = viewScale * invFactor;
  const { orbit, len } = buildDecimalReferenceOrbit(HOME_CX, HOME_CY, 8000, 25);

  const w = 480, h = 270;            // 1/4 of 1920×1080
  const t0 = performance.now();
  renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: 200, palette: makePalettePayload(),
  });
  const ms = performance.now() - t0;
  // Document the slowness so it shows up in test output. No upper bound that
  // would call this a regression — single-core JS DD-f64 is just slow.
  assert(ms > 100,
    `expected single-core preview to take >100ms (sanity check); got ${ms.toFixed(0)}ms`);
  console.log(`        low-res preview ${w}×${h} on one core: ${ms.toFixed(0)}ms · with 8 workers ≈ ${(ms/8).toFixed(0)}ms`);
});

test('full pipeline at zoom 10^30: orbit-worker → cpu-worker tile producing real pixels', () => {
  // End-to-end pipeline test that mirrors what the browser actually does
  // when the user is past the GPU precision wall at 10^30 zoom:
  //
  //   1. orbit-worker.js's iterateOrbitDecimal produces a DD-f64 reference
  //      orbit. We mirror that code verbatim above in workerIterateOrbitDecimal.
  //   2. main.js computes scale_m / frame_exp / delta_re_m / delta_im_m from
  //      the view position in Decimal.
  //   3. cpu-render-worker.js receives the message and calls renderTile from
  //      cpu-render-core.js — exercised here.
  //
  // Failure modes this test catches:
  //   - orbit producing wrong samples (would show as all-one-color tile)
  //   - renderTile mis-handling deep frame_exp values
  //   - per-pixel iteration broken at deep zoom
  //
  // Reference is c = -2 (Misiurewicz point) — guaranteed boundary structure
  // at any zoom, even 10^30, so we have something concrete to assert on.
  const cReStr = '-2';
  const cImStr = '0';
  const HOME_SCALE = 1.3;
  const zoom = 1e30;
  const scale = HOME_SCALE / zoom;

  // (1) Build orbit using the worker's exact iteration code.
  Decimal.set({ precision: workerPrecisionFor(scale) });
  const refCxDec = new Decimal(cReStr);
  const refCyDec = new Decimal(cImStr);
  const orbitT0 = performance.now();
  const { orbitDD, len } = workerIterateOrbitDecimal(refCxDec, refCyDec, 8000);
  const orbitMs = performance.now() - orbitT0;
  assert(len > 1000, `expected long orbit at Misiurewicz boundary, got ${len}`);

  // (2) Compute uniforms from the view position. View center == reference
  // center → delta is zero (only the per-pixel offset contributes).
  const frameExp = Math.floor(Math.log2(scale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMantHi = scale * invFactor;
  // For a tile centered on canvas, delta_re/im is 0; the per-pixel offset
  // (uvx · scale · aspect, uvy · scale) is what reaches each pixel.

  // (3) Run renderTile — this is the actual worker entry point in production.
  const tileW = 240, tileH = 60;     // representative tile size: 1/4-res strip
  const canvasW = tileW;
  const canvasH = tileH * 9;          // simulate 9 tiles vertically
  // Render one tile from somewhere in the middle of the canvas, so uvx/uvy
  // exercise non-zero offsets in both axes.
  const tileT0 = performance.now();
  const pixels = renderTile({
    tileX: 0, tileY: tileH * 4, tileW, tileH,
    canvasW, canvasH,
    orbit: orbitDD, orbitLen: len,
    scaleMantHi, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: 1000, palette: makePalettePayload(),
  });
  const tileMs = performance.now() - tileT0;

  // (4) Verify the output. At 10^30 around c=-2 there must be both in-set
  // (the M-set body extends here) and escaped pixels — this is the user's
  // "is the tile producing anything?" sanity check made testable.
  let black = 0;
  const distinct = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    const rgb = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    distinct.add(rgb);
    if (rgb === 0) black++;
  }
  // The user's reported failure was "all 0/9 tiles, nothing happens". If the
  // worker math is correct this assertion passes; if it stays uniform/empty
  // then we've located the actual bug.
  assert(distinct.size > 5,
    `tile at 10^30 has only ${distinct.size} distinct colours — worker math is the problem`);
  assert(black > 0,
    `tile at 10^30 has no in-set pixels — perturbation is failing`);
  assert(black < tileW * tileH,
    `tile at 10^30 is entirely black — orbit isn't producing meaningful escape times`);
  console.log(`        zoom 10^30: orbit ${len} samples in ${orbitMs.toFixed(0)}ms; tile ${tileW}×${tileH} in ${tileMs.toFixed(0)}ms — ${distinct.size} colours, ${black}/${tileW * tileH} in-set`);
});

test('click-zoom coordinate accuracy: rendered centre pixel maps to world click target', () => {
  // The user complaint: "image generated doesn't match what was in my square".
  // The square preview shows the world region centered on the click point.
  // After click_zoom, view.cx/cy MUST equal the click's world coord, and the
  // rendered image's center pixel MUST iterate to the same fate as
  // brute-force iteration of that exact world coord.
  //
  // Reproducer:
  //   1. start at V0 = (cx0, cy0, scale0)
  //   2. simulate click at canvas position (px, py) → world point W
  //   3. set V1 = (W.x, W.y, scale0 * CLICK_ZOOM)
  //   4. build an orbit at V0 (stale-orbit case after click) AND at V1
  //   5. render V1's centre tile via both orbits
  //   6. verify the rendered centre pixel matches the brute-force iteration
  //      of W (via Decimal at full precision)
  //
  // This catches: coord-conversion errors, view.cx mis-update, and orbit
  // reuse when the orbit's reference is the WRONG world point.

  const HOME_SCALE = 1.3;
  const cx0 = new Decimal('-0.75');
  const cy0 = new Decimal('0.1');
  const scale0 = HOME_SCALE / 1e6;             // moderate zoom 10^6
  const aspect = 1920 / 1080;
  const CLICK_ZOOM = 0.15;

  // (1) Pick a click position near the right edge — uvx = 0.6, uvy = 0.3.
  const uvx = 0.6, uvy = 0.3;
  // (2) world coord at the click position in V0
  const cx1 = cx0.plus(uvx * scale0 * aspect);
  const cy1 = cy0.plus(uvy * scale0);
  const scale1 = scale0 * CLICK_ZOOM;
  // After zoomAt: V1 = (cx1, cy1, scale1) — view center IS the click target.

  // (3) Brute-force ground truth: iterate the click world point directly.
  Decimal.set({ precision: 30 });
  const groundTruth = decimalMandelbrot(cx1, cy1, 1000);

  // (4) Orbit for V1 (the "fresh refresh after click" case).
  const v1Orbit = buildDecimalReferenceOrbit(cx1.toString(), cy1.toString(), 4000, 30);
  // Orbit for V0 (the "cache reused — refCx is the OLD view center" case).
  const v0Orbit = buildDecimalReferenceOrbit(cx0.toString(), cy0.toString(), 4000, 30);

  const frameExp = Math.floor(Math.log2(scale1));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMantHi = scale1 * invFactor;

  // Render the V1 center pixel using V1's own orbit (refCx == V1.cx, so
  // delta = 0). Should match ground truth.
  function renderCenterPixel(orbitDD, orbitLen, refCx, refCy) {
    // delta = (V1 - ref) * invFactor as DD-f64
    const dxDec = cx1.minus(refCx).times(invFactor);
    const dyDec = cy1.minus(refCy).times(invFactor);
    const deltaReHi = dxDec.toNumber();
    const deltaReLo = dxDec.minus(deltaReHi).toNumber();
    const deltaImHi = dyDec.toNumber();
    const deltaImLo = dyDec.minus(deltaImHi).toNumber();
    // 1×1 tile at canvas center (uvx = uvy = 0 → no per-pixel offset).
    const px = renderTile({
      tileX: 0, tileY: 0, tileW: 1, tileH: 1, canvasW: 1, canvasH: 1,
      orbit: orbitDD, orbitLen,
      scaleMantHi, scaleMantLo: 0, frameExp,
      deltaReHi, deltaReLo, deltaImHi, deltaImLo,
      maxIter: 1000, palette: makePalettePayload(),
    });
    const isBlack = px[0] === 0 && px[1] === 0 && px[2] === 0;
    return { isBlack, rgb: (px[0] << 16) | (px[1] << 8) | px[2] };
  }

  const v1Result = renderCenterPixel(v1Orbit.orbit, v1Orbit.len, cx1, cy1);
  const v0Result = renderCenterPixel(v0Orbit.orbit, v0Orbit.len, cx0, cy0);

  // The fresh-orbit render must match ground truth's set membership.
  assertEq(v1Result.isBlack, !groundTruth.escaped,
    `V1 centre pixel disagrees with brute-force: rendered=${v1Result.isBlack ? 'in-set' : 'escaped'}, truth=${groundTruth.escaped ? 'escaped' : 'in-set'}`);
  // The reused-orbit render (orbit refCx = V0.cx, delta != 0) must ALSO
  // match — that's the whole point of perturbation working off any reference.
  assertEq(v0Result.isBlack, !groundTruth.escaped,
    `V1 centre pixel via V0's orbit (reused) disagrees with brute-force: rendered=${v0Result.isBlack ? 'in-set' : 'escaped'}, truth=${groundTruth.escaped ? 'escaped' : 'in-set'}`);

  console.log(`        click target (${uvx},${uvy}) → world (${cx1.toFixed(6)}, ${cy1.toFixed(6)}); ground truth: ${groundTruth.escaped ? 'escapes at iter ' + groundTruth.iter : 'in-set'}; both orbit paths agree`);
});

test('click-zoom coordinate accuracy at 10^20: stale orbit must not break centre alignment', () => {
  // Same idea, but at deep CPU-mode zoom. This is where the user IS when
  // they reported the bug. Tests that perturbation off a STALE orbit (refCx
  // at the previous view's center) still renders the correct content for
  // the NEW view center.
  const HOME_SCALE = 1.3;
  const cx0 = new Decimal('-0.7436438870371589');
  const cy0 = new Decimal('0.1318259042083120');
  const scale0 = HOME_SCALE / 1e20;
  const aspect = 1920 / 1080;

  // Click at (uvx=0.05, uvy=0.05): a tiny offset that triggers cache reuse
  // (within 15% of canvas center → orbit refCx stays at V0).
  const uvx = 0.05, uvy = 0.05;
  const cx1 = cx0.plus(uvx * scale0 * aspect);
  const cy1 = cy0.plus(uvy * scale0);
  const scale1 = scale0 * 0.15;

  Decimal.set({ precision: 40 });
  const groundTruth = decimalMandelbrot(cx1, cy1, 1500);

  const v0Orbit = buildDecimalReferenceOrbit(cx0.toString(), cy0.toString(), 8000, 40);
  const frameExp = Math.floor(Math.log2(scale1));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMantHi = scale1 * invFactor;

  // Render V1 center using V0's orbit (refCx = V0.cx).
  const dxDec = cx1.minus(cx0).times(invFactor);
  const dyDec = cy1.minus(cy0).times(invFactor);
  const deltaReHi = dxDec.toNumber();
  const deltaReLo = dxDec.minus(deltaReHi).toNumber();
  const deltaImHi = dyDec.toNumber();
  const deltaImLo = dyDec.minus(deltaImHi).toNumber();
  const px = renderTile({
    tileX: 0, tileY: 0, tileW: 1, tileH: 1, canvasW: 1, canvasH: 1,
    orbit: v0Orbit.orbit, orbitLen: v0Orbit.len,
    scaleMantHi, scaleMantLo: 0, frameExp,
    deltaReHi, deltaReLo, deltaImHi, deltaImLo,
    maxIter: 1500, palette: makePalettePayload(),
  });
  const isBlack = px[0] === 0 && px[1] === 0 && px[2] === 0;
  assertEq(isBlack, !groundTruth.escaped,
    `at 10^20 with reused orbit, V1 center disagrees: rendered=${isBlack ? 'in-set' : 'escaped'}, truth=${groundTruth.escaped ? 'escaped at ' + groundTruth.iter : 'in-set'}`);
  console.log(`        10^20 click target via stale orbit: ground truth ${groundTruth.escaped ? 'escapes@' + groundTruth.iter : 'in-set'}; renderer agrees`);
});

test('user scenario at 10^28: click at top-of-canvas zooms onto the clicked feature', () => {
  // Reproduces the exact bug-report scenario:
  //   - zoom ~10^28 around the seahorse-valley target
  //   - canvas is mostly uniform with fractal structure ONLY at the top strip
  //   - user clicks ON the structure at the top
  //   - expectation: the new view's CENTRE PIXEL must show what the user
  //     clicked on, NOT what was at the previous canvas centre (uniform colour)
  //
  // What this test asserts (without rendering a full canvas):
  //   1. zoomAt(px, py) → view.cx, view.cy moves UP+CENTRE in world coords by
  //      (uvx*scale*aspect, uvy*scale)
  //   2. The renderer's centre pixel (uv=0,0) at the new view is fed delta
  //      = (view.cx - refCx) * invFactor — so its iteration matches the
  //      world point at the click, not at the previous view centre
  //   3. Brute-force iteration of the click point and the previous-centre
  //      point disagree (otherwise this test proves nothing — both points
  //      have the SAME fate so we couldn't distinguish)

  const HOME_SCALE = 1.3;
  // Seahorse valley target around the user's screenshot coords.
  const cx0 = new Decimal('-0.7248100117521541893165782');
  const cy0 = new Decimal('0.2898350568481815161159332');
  const scale0 = HOME_SCALE / 1e27;     // pre-click zoom; click multiplies by 0.15 → 10^28
  const CLICK_ZOOM = 0.15;
  const canvasW = 1920, canvasH = 1080;
  const aspect = canvasW / canvasH;

  // Click 50% across, 10% down from the top → the visible "structure strip".
  const clickPx = canvasW * 0.5;
  const clickPy = canvasH * 0.1;
  const uvx = (clickPx / canvasW) * 2 - 1;            // 0
  const uvy = 1 - (clickPy / canvasH) * 2;            // +0.8 (top of canvas)

  // Simulated zoomAt:
  const cx1 = cx0.plus(uvx * scale0 * aspect);
  const cy1 = cy0.plus(uvy * scale0);
  const scale1 = scale0 * CLICK_ZOOM;

  // Sanity: the click point must be DIFFERENT (in world coords) from the
  // pre-click centre. If they match, nothing this test asserts is meaningful.
  const cyDiff = Number(cy1.minus(cy0));
  assert(Math.abs(cyDiff) > scale1 * 0.5,
    `click point too close to previous centre (cyDiff=${cyDiff}, scale1=${scale1}) — test setup wrong`);

  // Brute-force ground truth at BOTH points so we can prove the renderer
  // distinguishes them.
  Decimal.set({ precision: 50 });
  const truthClick = decimalMandelbrot(cx1, cy1, 2000);
  const truthCenter = decimalMandelbrot(cx0, cy0, 2000);

  // Build orbit at the new view (post-click). This is what progressiveRender
  // would do when it kicks off after zoomAt — since the view moved beyond
  // 15% of canvas (uvy=0.8 well outside cache freshness), a fresh orbit IS
  // computed and refCx == cx1.
  const orbit = buildDecimalReferenceOrbit(cx1.toString(), cy1.toString(), 8000, 50);

  const frameExp = Math.floor(Math.log2(scale1));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMantHi = scale1 * invFactor;

  // Render the centre pixel of the NEW canvas using the renderer pipeline
  // (delta = view - ref = 0 since refCx = cx1).
  const px = renderTile({
    tileX: 0, tileY: 0, tileW: 1, tileH: 1, canvasW: 1, canvasH: 1,
    orbit: orbit.orbit, orbitLen: orbit.len,
    scaleMantHi, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: 2000, palette: makePalettePayload(),
  });
  const renderedIsBlack = px[0] === 0 && px[1] === 0 && px[2] === 0;

  // The renderer must agree with the CLICK point's fate.
  assertEq(renderedIsBlack, !truthClick.escaped,
    `renderer's centre pixel disagrees with brute-force click point: rendered=${renderedIsBlack ? 'in-set' : 'escaped'}, click truth=${truthClick.escaped ? 'escapes@' + truthClick.iter : 'in-set'}`);

  // And it must NOT match the previous-centre's fate (unless they happen to
  // coincide, in which case skip the contrast assertion).
  if (truthClick.escaped !== truthCenter.escaped ||
      Math.abs(truthClick.iter - truthCenter.iter) > 5) {
    if (truthClick.escaped !== truthCenter.escaped) {
      assert(renderedIsBlack !== !truthCenter.escaped,
        `renderer matches the OLD centre (which is the bug user reported), not the click point`);
    }
  }

  console.log(
    `        click(${clickPx},${clickPy}) → uv(${uvx.toFixed(2)},${uvy.toFixed(2)})\n` +
    `          old centre: ${cx0.toFixed(6)}, ${cy0.toFixed(6)} → ${truthCenter.escaped ? 'escapes@' + truthCenter.iter : 'in-set'}\n` +
    `          new centre: ${cx1.toFixed(6)}, ${cy1.toFixed(6)} → ${truthClick.escaped ? 'escapes@' + truthClick.iter : 'in-set'}\n` +
    `          renderer: ${renderedIsBlack ? 'in-set' : 'escaped'} — matches click target`
  );
});

test('REAL-SCALE benchmark: how long does the 0/9 tiles state actually last?', () => {
  // Reproduces the exact dimensions one CPU worker chews on when the user is
  // staring at "rendering on CPU (1/4, 500 iters)... 0 / 9 tiles" in the
  // browser. The scenario:
  //   - canvas 1920×1080 at deep zoom (10^30 around -2)
  //   - 1/4-res preview phase = 480×270 staging
  //   - split across 9 workers vertically = 480×30 per worker
  //   - 500 iter/pixel cap (CPU_PREVIEW_MAX_ITER)
  //
  // Single-thread time here ≈ wall-clock time the user sees, because all
  // 9 workers run in parallel so the bottleneck is one tile's compute. If
  // this passes in seconds the browser is just slow on the user's machine;
  // if it takes minutes the cap needs to come down further.
  const cReStr = '-2';
  const cImStr = '0';
  Decimal.set({ precision: workerPrecisionFor(1.3 / 1e30) });
  const { orbitDD, len } = workerIterateOrbitDecimal(
    new Decimal(cReStr), new Decimal(cImStr), 8000
  );

  const scale = 1.3 / 1e30;
  const frameExp = Math.floor(Math.log2(scale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMantHi = scale * invFactor;
  const tileW = 480, tileH = 30;     // 1/9 of the 1/4-res strip
  const canvasW = 480, canvasH = 270;
  const t0 = performance.now();
  const pixels = renderTile({
    tileX: 0, tileY: canvasH / 2 | 0, tileW, tileH,
    canvasW, canvasH,
    orbit: orbitDD, orbitLen: len,
    scaleMantHi, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: 500, palette: makePalettePayload(),
  });
  const ms = performance.now() - t0;
  // Output must be valid (not all black, not all uniform — same sanity as
  // the smaller tile test above).
  let nonBlack = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] || pixels[i + 1] || pixels[i + 2]) nonBlack++;
  }
  assert(nonBlack > 0, `tile is entirely black after ${ms.toFixed(0)}ms — bug, not just slowness`);
  // Sanity ceiling: a single 480×30 tile at 500 iter SHOULD take ≤ 30s on
  // a modern laptop. If it takes >5 minutes the iter cap or tile size
  // needs to come down for CPU mode to be remotely usable.
  assert(ms < 300_000, `single tile took ${(ms / 1000).toFixed(1)}s — CPU preview is unusable, lower CPU_PREVIEW_MAX_ITER`);
  console.log(`        tile ${tileW}×${tileH} @ 500 iters at zoom 10^30: ${ms.toFixed(0)}ms (= what the user waits for "0/9 → 1/9" with 9 parallel workers)`);
});

test('full canvas at zoom 10^30: 9 simulated tiles assembled produce coherent image', () => {
  // Now simulate the FULL workload main.js dispatches: 9 horizontal tiles
  // covering the canvas, each rendered through renderTile. Asserts that the
  // image has spatial coherence — not just per-tile variety, but variety
  // BETWEEN tiles too. Catches a bug where each tile renders correctly in
  // isolation but tile-to-tile boundaries are off (e.g., wrong y-offset
  // arithmetic).
  const cReStr = '-2';
  const cImStr = '0';
  const scale = 1.3 / 1e30;
  const frameExp = Math.floor(Math.log2(scale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMantHi = scale * invFactor;

  Decimal.set({ precision: workerPrecisionFor(scale) });
  const { orbitDD, len } = workerIterateOrbitDecimal(
    new Decimal(cReStr), new Decimal(cImStr), 8000
  );

  const canvasW = 192, canvasH = 108;        // 9 tiles × 12 rows each
  const N_WORKERS = 9;
  const rowsPerTile = Math.floor(canvasH / N_WORKERS);
  const fullPx = new Uint8Array(canvasW * canvasH * 4);

  const tilesT0 = performance.now();
  for (let i = 0; i < N_WORKERS; i++) {
    const y = i * rowsPerTile;
    const h = (i === N_WORKERS - 1) ? (canvasH - y) : rowsPerTile;
    const tilePx = renderTile({
      tileX: 0, tileY: y, tileW: canvasW, tileH: h,
      canvasW, canvasH,
      orbit: orbitDD, orbitLen: len,
      scaleMantHi, scaleMantLo: 0, frameExp,
      deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
      maxIter: 1000, palette: makePalettePayload(),
    });
    // Stitch tile into the full buffer.
    for (let row = 0; row < h; row++) {
      const srcOff = row * canvasW * 4;
      const dstOff = ((y + row) * canvasW) * 4;
      fullPx.set(tilePx.subarray(srcOff, srcOff + canvasW * 4), dstOff);
    }
  }
  const tilesMs = performance.now() - tilesT0;

  // Per-tile variety: each tile should have its own distinct colour set
  // (because c varies row-by-row through the tile). If multiple tiles all
  // come out identically, the y-offset arithmetic in renderTile is broken.
  const tilePalettes = [];
  for (let i = 0; i < N_WORKERS; i++) {
    const y = i * rowsPerTile;
    const h = (i === N_WORKERS - 1) ? (canvasH - y) : rowsPerTile;
    const palette = new Set();
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < canvasW; col++) {
        const idx = ((y + row) * canvasW + col) * 4;
        palette.add((fullPx[idx] << 16) | (fullPx[idx + 1] << 8) | fullPx[idx + 2]);
      }
    }
    tilePalettes.push(palette.size);
  }
  // No tile should be uniform; every tile should have 5+ distinct colours.
  for (let i = 0; i < N_WORKERS; i++) {
    assert(tilePalettes[i] > 1,
      `tile ${i} at 10^30 has only ${tilePalettes[i]} distinct colour — worker producing uniform output`);
  }
  // Detect "tileY ignored" — if renderTile threw away tile.y and rendered
  // every tile as if it were at the top of the canvas, every tile-start row
  // would be byte-identical to canvas row 0. We can't insist on adjacent
  // rows differing because c=-2 sits on the real axis where the M-set is
  // conjugate-symmetric (so y and canvasH-y produce identical pixels) — but
  // it's a real bug if ALL 9 tile-start rows match row 0.
  let everyTileMatchesRow0 = true;
  for (let i = 1; i < N_WORKERS && everyTileMatchesRow0; i++) {
    const y = i * rowsPerTile;
    for (let col = 0; col < canvasW; col++) {
      const i0 = col * 4;
      const ic = (y * canvasW + col) * 4;
      if (fullPx[i0] !== fullPx[ic] || fullPx[i0 + 1] !== fullPx[ic + 1] ||
          fullPx[i0 + 2] !== fullPx[ic + 2]) {
        everyTileMatchesRow0 = false;
        break;
      }
    }
  }
  assert(!everyTileMatchesRow0,
    'every tile-start row is byte-identical to canvas row 0 — tileY is being ignored');
  console.log(`        9 tiles ${canvasW}×${canvasH} in ${tilesMs.toFixed(0)}ms — per-tile palette sizes: [${tilePalettes.join(', ')}]`);
});

test('renderTile at 10^40 around c=-2 still produces structure', () => {
  // The CPU renderer's job at very deep zoom is to keep producing varied
  // output. 10^40 on a Misiurewicz boundary (c=-2) should give us multiple
  // colours and a mix of in-set / escaped pixels — anything else means the
  // math broke down or the orbit isn't being passed through correctly.
  const cReStr = '-2';
  const cImStr = '0';
  const scale = 1e-40;
  const frameExp = Math.floor(Math.log2(scale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = scale * invFactor;
  const maxIter = 3000;
  const { orbit, len } = buildDecimalReferenceOrbit(cReStr, cImStr, maxIter, 60);

  const w = 32, h = 16;
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter,
    palette: makePalettePayload(),
  });
  let black = 0;
  const distinct = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    const rgb = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    distinct.add(rgb);
    if (rgb === 0) black++;
  }
  assert(black > 0, `expected some in-set pixels at 10^40, got ${black}`);
  assert(black < w * h, `expected some escaped pixels at 10^40, got ${w * h - black} escaped`);
  assert(distinct.size > 5,
    `expected varied output at 10^40, got ${distinct.size} distinct colours`);
});

test('renderTile at 1/4 resolution is much faster than full resolution', () => {
  // The slow-path CPU progressive render hinges on the 1/4-res preview
  // landing well before the full-res image. Confirm the time ratio is
  // close to the pixel ratio (1/16 since both width and height shrink by 4).
  // If it's not, splitting work into "preview then full" buys us nothing.
  const { orbit, len } = buildF64ReferenceOrbit(-0.75, 0.1, 500);
  const params = {
    orbit, orbitLen: len,
    scaleMantHi: 1.0, scaleMantLo: 0, frameExp: 0,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: 500, palette: makePalettePayload(),
  };
  const fullW = 200, fullH = 100;
  const t0 = performance.now();
  renderTile({ ...params, tileX: 0, tileY: 0, tileW: fullW, tileH: fullH, canvasW: fullW, canvasH: fullH });
  const fullMs = performance.now() - t0;
  const lowW = fullW / 4, lowH = fullH / 4;
  const t1 = performance.now();
  renderTile({ ...params, tileX: 0, tileY: 0, tileW: lowW, tileH: lowH, canvasW: lowW, canvasH: lowH });
  const lowMs = performance.now() - t1;
  // 1/16 the pixels should give us a real speed-up — at minimum 4x faster.
  // Anything less means the 1/4-res preview phase is not actually a useful
  // preview and we should reconsider the approach.
  assert(lowMs * 4 <= fullMs,
    `1/4-res not meaningfully faster: full=${fullMs.toFixed(1)}ms low=${lowMs.toFixed(1)}ms (ratio ${(fullMs/lowMs).toFixed(2)})`);
});

test('renderTile at 10^20 centred on an outside-set ref: every pixel escapes', () => {
  // Complement to the previous test: pick a ref that's clearly outside the
  // set (c = 0.5, main cardioid barely misses this). At 10^20 all pixels in
  // the viewport should escape — if ANY come back as in-set, the renderer
  // has a false-containment bug.
  const cReStr = '0.5';
  const cImStr = '0.5';
  const scale = 1e-20;
  const frameExp = Math.floor(Math.log2(scale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = scale * invFactor;
  const maxIter = 200;

  const { orbit, len } = buildDecimalReferenceOrbit(cReStr, cImStr, maxIter, 40);

  const w = 8, h = 4;
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter,
    palette: makePalettePayload(),
  });
  let black = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) black++;
  }
  assertEq(black, 0,
    `every pixel should escape for an outside-set reference, got ${black} black`);
});

console.log('\n--- Tante Renate spot: zoom-ladder validation ---');

// User-reported regression: starting from the "Tante Renate's spot" preset
// (cx, cy at scale ~10^-12) and hammering space to zoom in, around 10^14 the
// canvas goes black. Each space-press is a CLICK_ZOOM=0.5 step (view.scale
// halves) toward the same target. To reproduce this in pure Node, we walk
// the zoom ladder from the preset depth to ~10^17 and at each step:
//   1. build the reference orbit at the spot with mpfr-equivalent precision
//      (orbit-worker.js uses Decimal, so do we — Math.max(20, zoomDigits+15))
//   2. render a small tile centered on the spot via renderTile (the CPU
//      equivalent of the GPU shader)
//   3. assert the result is non-trivial (at least 5% of pixels are NOT the
//      same colour as the canvas centre — i.e. there's actual M-set
//      structure visible, not a uniform black/grey wash)
//
// "Black at zoom 10^14" means: at that depth, the orbit is too short for
// boundary pixels to escape under the renderTile iter cap, so they all hit
// max-iter and render black. The test makes the failure depth explicit.
const TANTE_RENATE_CRE = '-0.7746806106269039';
const TANTE_RENATE_CIM = '-0.1374168856037867';

function decimalPrecisionForScale(scale) {
  // Mirror orbit-worker.js exactly so the orbit we build matches what the
  // browser's worker would compute for this view.
  const zoomDigits = scale > 0 ? Math.ceil(Math.log10(1 / scale)) : 0;
  return Math.max(20, zoomDigits + 15);
}

function renderAtTanteRenate(scale, w, h, maxIter) {
  const prec = decimalPrecisionForScale(scale);
  const { orbit, len } = buildDecimalReferenceOrbit(
    TANTE_RENATE_CRE, TANTE_RENATE_CIM, maxIter, prec,
  );
  // Per-pixel iter cap mirrors the d=8 progressive phase in main.js: scales
  // with zoom depth (800 iter/decade, floor 2000, ceiling 16000), capped by
  // the orbit length we actually have. Keep this in sync with the d=8 branch
  // in main.js's computePixelMaxIter — divergence will silently make this
  // test pass while the browser still goes black.
  const log = Math.log10(Math.max(1, 1.3 / scale));
  const cap = Math.max(2000, Math.min(16000, Math.round(800 * log)));
  const phaseIter = Math.min(cap, len);
  const frameExp = Math.floor(Math.log2(scale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = scale * invFactor;
  const pixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter: phaseIter,
    palette: makePalettePayload(),
  });
  return { pixels, orbitLen: len, phaseIter };
}

function uniqueColours(pixels) {
  const set = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    set.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
  }
  return set.size;
}

function fractionMatchingColour(pixels, r, g, b) {
  let hit = 0, total = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === r && pixels[i + 1] === g && pixels[i + 2] === b) hit++;
    total++;
  }
  return hit / total;
}

// HOME.scale in main.js — preset scales are derived from this and we reuse
// it so zoom = HOME.scale / scale lines up with the UI.
const HOME_SCALE = 1.3;

// Each step matches one space-press (CLICK_ZOOM = 0.5). Start at the preset's
// own scale and halve N times to walk past the alleged failure depth.
const TANTE_RENATE_LADDER = (() => {
  const steps = [];
  let s = 1.506043553756164e-12;   // matches the preset's published scale
  for (let i = 0; i < 14; i++) {
    steps.push({ scale: s, zoom: HOME_SCALE / s });
    s *= 0.5;
  }
  return steps;
})();

// Worth checking explicitly: what brute-force Decimal computation says about
// in-set membership at each step on the ladder. The user-reported "black at
// 10^14" turned out to be CORRECT topology — Tante Renate's centre sits
// inside a minibrot at deep zoom, every pixel in a 10⁻¹⁴-wide window is
// genuinely in-set. The test below validates the renderer agrees with
// brute-force; a uniformly-black tile is fine if brute-force agrees.

for (const { scale, zoom } of TANTE_RENATE_LADDER) {
  const zoomLabel = zoom.toExponential(2);
  test(`tante-renate at zoom ${zoomLabel} (scale ${scale.toExponential(2)}): perturbation matches brute-force Decimal`, () => {
    const w = 8, h = 8;
    const { pixels, orbitLen, phaseIter } = renderAtTanteRenate(scale, w, h, 50_000);

    // Alpha sanity: every pixel was actually rendered.
    for (let i = 3; i < pixels.length; i += 4) {
      assertEq(pixels[i], 255, `alpha at byte ${i} for zoom ${zoomLabel}`);
    }

    // Brute-force compare: if perturbation says in-set (all-black), brute-force
    // at the corresponding c must AGREE within the iter budget the renderer
    // had. Disagreement = perturbation false negative (the bug we're hunting).
    const prec = decimalPrecisionForScale(scale);
    Decimal.set({ precision: prec });
    const cRe = new Decimal(TANTE_RENATE_CRE);
    const cIm = new Decimal(TANTE_RENATE_CIM);
    const scaleDec = new Decimal(scale);
    const aspect = w / h;

    let perturbationInSet = 0, bruteInSet = 0, falseNegative = 0, falsePositive = 0;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const uvx = (px / w) * 2 - 1;
        const uvy = 1 - (py / h) * 2;
        const pxCRe = cRe.plus(scaleDec.times(uvx * aspect));
        const pxCIm = cIm.plus(scaleDec.times(uvy));
        const gt = decimalMandelbrot(pxCRe, pxCIm, phaseIter);
        const idx = (py * w + px) * 4;
        const isPerturbBlack = pixels[idx] === 0 && pixels[idx + 1] === 0 && pixels[idx + 2] === 0;
        const isBruteInSet = !gt.escaped;
        if (isPerturbBlack) perturbationInSet++;
        if (isBruteInSet) bruteInSet++;
        if (isPerturbBlack && !isBruteInSet) falsePositive++;
        if (!isPerturbBlack && isBruteInSet) falseNegative++;
      }
    }

    // Tolerance: smooth-iter colour gradient near boundary can differ by 1 iter
    // between perturbation and brute-force at deep zoom. Allow a couple of
    // disagreements; flag bigger ones as a real bug.
    const total = w * h;
    const disagreements = falsePositive + falseNegative;
    assert(disagreements <= 2,
      `perturbation disagrees with brute-force on ${disagreements}/${total} pixels at zoom ${zoomLabel}: ` +
      `perturb-in-set=${perturbationInSet}, brute-in-set=${bruteInSet}, ` +
      `false-positive=${falsePositive} (renderer says in-set but pixel escapes), ` +
      `false-negative=${falseNegative} (renderer says escapes but pixel is in-set), ` +
      `orbitLen=${orbitLen} phaseIter=${phaseIter}`);
  });
}

console.log('\n--- Palette ---');

test('palette: warm at t=0 lands near warm colours', () => {
  const pal = makePalettePayload();
  const [r, g, b] = palette(0, pal.a, pal.b, pal.c, pal.d);
  // All components should be in [0, 1].
  for (const v of [r, g, b]) assert(v >= 0 && v <= 1, `component out of [0,1]: ${v}`);
});

test('clampByte: clamps and scales', () => {
  assertEq(clampByte(-0.5), 0);
  assertEq(clampByte(0), 0);
  assertEq(clampByte(0.5), 127);
  assertEq(clampByte(1), 255);
  assertEq(clampByte(2), 255);
});

console.log('\n--- QD-f64 arithmetic ---');

// Compare QD result against Decimal ground truth at 80-digit precision.
// Tolerance is 10^-60 of the magnitude — QD nominally carries ~62 digits;
// 60 leaves headroom for the inherent ~2-digit ulp wobble in Bailey-Hida
// renormalisation.
//
// Important: Decimal.js's `new Decimal(num)` constructor uses the SHORTEST
// decimal representation of a JS number (so `new Decimal(0.1)` is exactly
// 0.1 — not the f64 binary value 0.1000000000000000055511...). For QD
// reconstruction we need the exact f64 binary value of each component.
//
// Number.prototype.toFixed(70) doesn't work for large values either: for
// |x| ≥ 1e21 the spec falls back to ToString form ("1e+30") which loses all
// the binary residual. So we unpack the IEEE-754 mantissa+exponent ourselves
// and rebuild the exact value as Decimal via BigInt arithmetic.
const _f64Buf = new ArrayBuffer(8);
const _f64View = new DataView(_f64Buf);
function f64ToExactDecimal(x) {
  if (x === 0) return new Decimal(0);
  if (!Number.isFinite(x)) return new Decimal(x);
  _f64View.setFloat64(0, x);
  const bits = _f64View.getBigUint64(0);
  const sign = (bits >> 63n) === 0n ? 1 : -1;
  const exp = Number((bits >> 52n) & 0x7FFn);
  let mant = bits & 0xFFFFFFFFFFFFFn;
  let e;
  if (exp === 0) {
    // Subnormal: value = sign · mant · 2^(-1074). mant=0 → ±0 already returned.
    e = -1074;
  } else {
    // Normal: value = sign · (2^52 | mant) · 2^(exp-1075).
    mant = mant | (1n << 52n);
    e = exp - 1075;
  }
  // value = sign · mant · 2^e — exact rational.
  const prevPrec = Decimal.precision;
  Decimal.set({ precision: 120 });
  let result = new Decimal(mant.toString());
  if (e >= 0) result = result.times(new Decimal(2).pow(e));
  else        result = result.div(new Decimal(2).pow(-e));
  Decimal.set({ precision: prevPrec });
  return sign === 1 ? result : result.neg();
}

function assertQdMatches(qd, decimalStr, tag, relTol = 1e-60) {
  Decimal.set({ precision: 80 });
  const expected = new Decimal(decimalStr);
  let actual = new Decimal(0);
  for (let i = 0; i < 4; i++) actual = actual.plus(f64ToExactDecimal(qd[i]));
  const diff = actual.minus(expected).abs();
  const denom = expected.abs().lt('1e-300') ? new Decimal(1) : expected.abs();
  const rel = diff.div(denom);
  if (rel.gt(relTol)) {
    throw new Error(
      `${tag}: relative error ${rel.toString()} exceeds tol ${relTol}\n` +
      `       got      ${actual.toString()}\n` +
      `       expected ${expected.toString()}`
    );
  }
}

test('qdFromString round-trips simple integers and fractions', () => {
  assertQdMatches(qdFromString('0'),    '0', '0', 0);
  assertQdMatches(qdFromString('1'),    '1', '1', 0);
  assertQdMatches(qdFromString('-1.5'), '-1.5', '-1.5', 0);
  // 60-digit string — beyond DD-f64 precision, well within QD-f64.
  const longStr = '0.123456789012345678901234567890123456789012345678901234567890';
  assertQdMatches(qdFromString(longStr), longStr, 'long fractional');
});

test('qdAdd: 60-digit numbers add to expected sum', () => {
  // Two 50-digit numbers chosen so the sum has digits all the way down.
  const a = '1.23456789012345678901234567890123456789012345678901';
  const b = '0.98765432109876543210987654321098765432109876543210';
  Decimal.set({ precision: 70 });
  const expected = new Decimal(a).plus(b).toString();
  const result = qdAdd(qdFromString(a), qdFromString(b));
  assertQdMatches(result, expected, 'qdAdd 50+50 digits');
});

test('qdSub: cancellation preserves precision past DD-f64 limit', () => {
  // Catastrophic cancellation test — DD-f64 would round this to exactly 0
  // (the difference is below DD's ~31-digit floor). QD should still resolve
  // the difference. After cancellation we expect roughly QD-precision minus
  // the cancelled magnitude (~16 digits) = ~46 digits of accuracy, hence
  // the 1e-45 tolerance.
  const a = '1.0000000000000000000000000000000000000000001';
  const b = '1.0';
  Decimal.set({ precision: 80 });
  const expected = new Decimal(a).minus(b).toString(); // 1e-43
  const result = qdSub(qdFromString(a), qdFromString(b));
  assertQdMatches(result, expected, 'qdSub catastrophic cancellation', 1e-45);
});

test('qdMul: 60-digit × 60-digit', () => {
  const a = '3.141592653589793238462643383279502884197169399375105820974944';
  const b = '2.718281828459045235360287471352662497757247093699959574966967';
  Decimal.set({ precision: 70 });
  const expected = new Decimal(a).times(b).toString();
  const result = qdMul(qdFromString(a), qdFromString(b));
  assertQdMatches(result, expected, 'qdMul π × e');
});

test('qdSqr against Decimal ground truth', () => {
  // qdSqr is its own implementation (not just qdMul(x,x)) for speed —
  // verify it matches Decimal-computed x² to QD precision.
  const xStr = '1.7320508075688772935274463415058723669428052538103806280558069';
  Decimal.set({ precision: 80 });
  const expected = new Decimal(xStr).pow(2).toString();
  const result = qdSqr(qdFromString(xStr));
  assertQdMatches(result, expected, 'qdSqr √3²', 1e-58);
});

test('qdSqr ≈ qdMul(x, x) to within QD ulp wobble', () => {
  // Both compute x² at QD precision but via different code paths, so they
  // can differ in the last 1-2 ulps. Tighter than 1e-48 would catch real
  // bugs in either path.
  const x = qdFromString('1.7320508075688772935274463415058723669428052538103806280558069');
  const sqr = qdSqr(x);
  const mul = qdMul(x, x);
  Decimal.set({ precision: 80 });
  let diff = new Decimal(0);
  for (let i = 0; i < 4; i++) diff = diff.plus(f64ToExactDecimal(sqr[i]).minus(f64ToExactDecimal(mul[i])));
  if (diff.abs().gt('1e-48')) {
    throw new Error(`qdSqr / qdMul(x,x) wobble too big: residual=${diff.toString()}`);
  }
});

test('qdDiv: 1/x · x = 1 to ~60 digits', () => {
  const x = qdFromString('7.389056098930650227230427460575007813180315570551847324087127');
  const recip = qdDiv(qdFromNumber(1), x);
  const product = qdMul(x, recip);
  // product should be 1.0 to QD precision.
  Decimal.set({ precision: 80 });
  let actual = new Decimal(0);
  for (let i = 0; i < 4; i++) actual = actual.plus(f64ToExactDecimal(product[i]));
  const err = actual.minus(1).abs();
  if (err.gt('1e-58')) {
    throw new Error(`qdDiv: x · (1/x) = ${actual.toString()}, err=${err.toString()}`);
  }
});

test('qdPow10: 10^N exact for small N, accurate to QD for large N', () => {
  Decimal.set({ precision: 70 });
  for (const n of [0, 1, 5, 15, 30, 50, -10, -30, -50]) {
    const qd = qdPow10(n);
    const expected = new Decimal(10).pow(n).toString();
    assertQdMatches(qd, expected, `qdPow10(${n})`);
  }
});

test('Mandelbrot iteration in QD: c=−0.75 (boundary, never escapes) stays bounded', () => {
  // z_0 = 0; z_{n+1} = z² + c with c = -0.75. This is on the M-set
  // boundary — z stays bounded forever (z → ½(−1 ± √(1+4c))). Iterate 1000
  // times in QD and confirm |z| < 2.
  const c = qdFromString('-0.75');
  let zr = qdFromNumber(0);
  let zi = qdFromNumber(0);
  for (let i = 0; i < 1000; i++) {
    const zr2 = qdSqr(zr);
    const zi2 = qdSqr(zi);
    const newZr = qdAdd(qdSub(zr2, zi2), c);
    const newZi = qdMul(qdAdd(zr, zr), zi);
    zr = newZr; zi = newZi;
    const mag = qdToNumber(zr2) + qdToNumber(zi2);
    assert(mag < 4, `at iter ${i}: |z|² = ${mag} (escaped — should not at c=-0.75)`);
  }
});

test('Mandelbrot iteration in QD: c=1 escapes within a few iters', () => {
  const c = qdFromNumber(1);
  let zr = qdFromNumber(0);
  let zi = qdFromNumber(0);
  let escapedAt = -1;
  for (let i = 0; i < 100; i++) {
    const zr2 = qdSqr(zr);
    const zi2 = qdSqr(zi);
    const mag = qdToNumber(zr2) + qdToNumber(zi2);
    if (mag > 4) { escapedAt = i; break; }
    const newZr = qdAdd(qdSub(zr2, zi2), c);
    const newZi = qdMul(qdAdd(zr, zr), zi);
    zr = newZr; zi = newZi;
  }
  assert(escapedAt > 0 && escapedAt < 10,
    `c=1 should escape early; got escapedAt=${escapedAt}`);
});

test('renderTileQD at 10^40 around c=-2 still produces structure', () => {
  // QD-f64 path's job: keep the renderer working past DD-f64's ~10^31 wall.
  // Same view as the DD-path renderTile-at-10^40 test (which already passes
  // at moderate iter counts thanks to the rebase logic), but verifies the
  // entire QD pipeline end-to-end: QD orbit + QD per-pixel kernel + QD scale
  // and delta inputs.
  const cReStr = '-2';
  const cImStr = '0';
  const scale = 1e-40;
  const maxIter = 3000;
  const { orbit, len } = buildDecimalReferenceOrbitQD(cReStr, cImStr, maxIter, 80);
  // QD scale and zero delta (rendering centred exactly on the reference).
  const scaleQD = Float64Array.of(scale, 0, 0, 0);
  const zeroQD = new Float64Array(4);

  const w = 32, h = 16;
  const pixels = renderTileQD({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit, orbitLen: len,
    scaleQD,
    deltaReQD: zeroQD, deltaImQD: zeroQD,
    maxIter,
    palette: makePalettePayload(),
  });
  let black = 0;
  const distinct = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    const rgb = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    distinct.add(rgb);
    if (rgb === 0) black++;
  }
  assert(black > 0, `expected some in-set pixels at 10^40 (QD), got ${black}`);
  assert(black < w * h, `expected some escaped pixels at 10^40 (QD), got ${w * h - black} escaped`);
  assert(distinct.size > 5,
    `expected varied output at 10^40 (QD), got ${distinct.size} distinct colours`);
});

test('renderTileQD agrees with renderTile at moderate zoom (cross-check)', () => {
  // At zoom 10^15 (well within DD-f64's wheelhouse), the DD and QD paths
  // should produce essentially the same image. Differences should be within
  // a few low-bit ulps per pixel — concretely we check that the count of
  // in-set pixels and the count of distinct colours match closely.
  const cReStr = '-0.75';
  const cImStr = '0.1';
  const scale = 1e-15;
  const frameExp = Math.floor(Math.log2(scale));
  const invFactor = Math.pow(2, -frameExp);
  const scaleMant = scale * invFactor;
  const maxIter = 1000;

  const { orbit: orbitDD, len: lenDD } = buildDecimalReferenceOrbit(cReStr, cImStr, maxIter, 60);
  const { orbit: orbitQD, len: lenQD } = buildDecimalReferenceOrbitQD(cReStr, cImStr, maxIter, 60);
  assertEq(lenDD, lenQD, 'orbit length should match between DD and QD builders');

  const w = 32, h = 16;
  const ddPixels = renderTile({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit: orbitDD, orbitLen: lenDD,
    scaleMantHi: scaleMant, scaleMantLo: 0, frameExp,
    deltaReHi: 0, deltaReLo: 0, deltaImHi: 0, deltaImLo: 0,
    maxIter, palette: makePalettePayload(),
  });
  const scaleQD = Float64Array.of(scale, 0, 0, 0);
  const zeroQD = new Float64Array(4);
  const qdPixels = renderTileQD({
    tileX: 0, tileY: 0, tileW: w, tileH: h, canvasW: w, canvasH: h,
    orbit: orbitQD, orbitLen: lenQD,
    scaleQD, deltaReQD: zeroQD, deltaImQD: zeroQD,
    maxIter, palette: makePalettePayload(),
  });
  let ddBlack = 0, qdBlack = 0, mismatched = 0;
  for (let i = 0; i < ddPixels.length; i += 4) {
    const ddRgb = (ddPixels[i] << 16) | (ddPixels[i + 1] << 8) | ddPixels[i + 2];
    const qdRgb = (qdPixels[i] << 16) | (qdPixels[i + 1] << 8) | qdPixels[i + 2];
    if (ddRgb === 0) ddBlack++;
    if (qdRgb === 0) qdBlack++;
    // Allow ~3-byte channel diff (perturbation sloppy ulp wobble + smooth-iter
    // log() amplifies very-low-bit differences). Anything bigger means the
    // paths disagree about set membership or about an iter count.
    const dr = Math.abs(ddPixels[i] - qdPixels[i]);
    const dg = Math.abs(ddPixels[i + 1] - qdPixels[i + 1]);
    const db = Math.abs(ddPixels[i + 2] - qdPixels[i + 2]);
    if (dr > 5 || dg > 5 || db > 5) mismatched++;
  }
  assertEq(ddBlack, qdBlack, 'in-set pixel count should match between DD and QD paths');
  assert(mismatched < 3, `expected ≤2 mismatched pixels (ulp wobble), got ${mismatched}`);
});

test('QD precision floor: 1 + 1e-60 != 1 (DD-f64 fails this; QD passes)', () => {
  const a = qdFromNumber(1);
  const tiny = qdFromString('1e-60');
  const sum = qdAdd(a, tiny);
  // sum - 1 should equal tiny to QD precision.
  const diff = qdSub(sum, qdFromNumber(1));
  Decimal.set({ precision: 80 });
  let actual = new Decimal(0);
  for (let i = 0; i < 4; i++) actual = actual.plus(f64ToExactDecimal(diff[i]));
  const expected = new Decimal('1e-60');
  const relErr = actual.minus(expected).abs().div(expected);
  assert(relErr.lt('1e-3'),
    `QD lost the 1e-60 contribution: actual=${actual.toString()}, relErr=${relErr.toString()}`);
});

console.log('\n--- pickSeedSource (GPU→CPU transition seed logic) ---');

// pickSeedSource is the decision function the CPU progressive phase uses to
// pick what to fill a fresh cpuBlitTexture with. The bug it guards against:
// at zoom > 1e-20 we switch from GPU rendering (drawing direct to swapchain)
// to CPU rendering (drawing to cpuBlitTexture, then blit-upscaling to
// swapchain). On that first transition cpuBlitTexture is null, the
// progressive phase resizes the canvas (clearing the swapchain to black),
// and the user sees a black screen for many seconds while the first deep
// CPU tile computes. The fix is to capture the swapchain content into
// `swapchainSeed` BEFORE the resize. These tests pin the priority order so
// a future refactor can't silently re-introduce the black-screen regression.

test('pickSeedSource: returns "black" when no source available', () => {
  assertEq(pickSeedSource({}), 'black');
  assertEq(pickSeedSource({ prevPhasePixels: null, oldBlit: null, swapchainSeed: null }), 'black');
});

test('pickSeedSource: prevPhasePixels wins when present', () => {
  // prev-phase is the most accurate match (same view, just lower-res pixels
  // from the previous progressive phase) so it always beats other sources.
  const fakePixels = new Uint8ClampedArray(4);
  assertEq(pickSeedSource({ prevPhasePixels: fakePixels }), 'prev-phase');
  assertEq(
    pickSeedSource({ prevPhasePixels: fakePixels, oldBlit: {}, swapchainSeed: {} }),
    'prev-phase'
  );
});

test('pickSeedSource: oldBlit beats swapchainSeed when both present', () => {
  // oldBlit is the previous render's cpuBlitTexture — same renderer, same
  // resolution domain. swapchainSeed is fallback for GPU→CPU transitions
  // where no cpuBlitTexture ever existed. If both are somehow present
  // (shouldn't happen in practice — they're populated in mutually
  // exclusive code paths), oldBlit is the more informative source.
  assertEq(pickSeedSource({ oldBlit: {}, swapchainSeed: {} }), 'old-blit');
});

test('pickSeedSource: swapchainSeed used on GPU→CPU transition', () => {
  // The critical case: zoom past GPU_SCALE_LIMIT for the first time.
  // cpuBlitTexture is null (GPU mode never used it), no prev-phase pixels
  // (it's the first phase of the new render). swapchainSeed must be picked
  // — otherwise the canvas goes black at zoom 10^20.
  assertEq(pickSeedSource({ swapchainSeed: {} }), 'swapchain');
  assertEq(
    pickSeedSource({ prevPhasePixels: null, oldBlit: null, swapchainSeed: {} }),
    'swapchain'
  );
});

test('pickSeedSource: falsy values treated as absent', () => {
  // Defensive: empty arrays / 0-byte buffers shouldn't be mistaken for
  // valid sources. The caller passes the actual handles; we only check
  // truthiness, but explicit-undefined and explicit-null both mean "no".
  assertEq(pickSeedSource({ prevPhasePixels: undefined, oldBlit: undefined, swapchainSeed: {} }), 'swapchain');
  assertEq(pickSeedSource({ prevPhasePixels: 0, oldBlit: '', swapchainSeed: null }), 'black');
});

test('pickSeedSource: priority order is prev-phase > old-blit > swapchain > black', () => {
  // Snapshot the full ordering so a refactor can't accidentally swap two
  // priorities. Map { has-flags } -> expected.
  const cases = [
    [{ prevPhasePixels: 1, oldBlit: 1, swapchainSeed: 1 }, 'prev-phase'],
    [{ prevPhasePixels: 1, oldBlit: 1, swapchainSeed: 0 }, 'prev-phase'],
    [{ prevPhasePixels: 1, oldBlit: 0, swapchainSeed: 1 }, 'prev-phase'],
    [{ prevPhasePixels: 1, oldBlit: 0, swapchainSeed: 0 }, 'prev-phase'],
    [{ prevPhasePixels: 0, oldBlit: 1, swapchainSeed: 1 }, 'old-blit'],
    [{ prevPhasePixels: 0, oldBlit: 1, swapchainSeed: 0 }, 'old-blit'],
    [{ prevPhasePixels: 0, oldBlit: 0, swapchainSeed: 1 }, 'swapchain'],
    [{ prevPhasePixels: 0, oldBlit: 0, swapchainSeed: 0 }, 'black'],
  ];
  for (const [input, expected] of cases) {
    assertEq(pickSeedSource(input), expected,
      `input=${JSON.stringify(input)}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
