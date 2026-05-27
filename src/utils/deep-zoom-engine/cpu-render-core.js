// Pure CPU-renderer math, imported by both cpu-render-worker.js and the
// Node-side tests in test-cpu-render.mjs. Keeping this file self-contained
// (no Worker APIs, no Decimal.js) is what makes it usable from Node directly.

import { qdAdd, qdSub, qdMul, qdSqr, qdMulPow2, qdFromNumber } from './qd-f64.js';

// ---------- DD-f64 arithmetic ----------

const DD_SPLIT = 134217729; // 2^27 + 1

export function twoSum(a, b) {
  const s = a + b;
  const bb = s - a;
  return [s, (a - (s - bb)) + (b - bb)];
}
export function quickTwoSum(a, b) {
  const s = a + b;
  return [s, b - (s - a)];
}
export function splitF64(a) {
  const t = DD_SPLIT * a;
  const hi = t - (t - a);
  return [hi, a - hi];
}
export function twoProd(a, b) {
  const [ah, al] = splitF64(a);
  const [bh, bl] = splitF64(b);
  const p = a * b;
  const err = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  return [p, err];
}
export function ddAdd(ah, al, bh, bl) {
  const [sh, se] = twoSum(ah, bh);
  const [th, te] = twoSum(al, bl);
  const [u1h, u1l] = quickTwoSum(sh, se + th);
  return quickTwoSum(u1h, u1l + te);
}
export function ddMul(ah, al, bh, bl) {
  const [p, err] = twoProd(ah, bh);
  return quickTwoSum(p, err + (ah * bl + al * bh));
}
export function ddSub(ah, al, bh, bl) { return ddAdd(ah, al, -bh, -bl); }
export function ddScalePow2(ah, al, e) {
  const f = Math.pow(2, e);
  return [ah * f, al * f];
}

// ---------- Per-pixel perturbation ----------

// Iterate w_{n+1} = 2 z_n w_n + w_n² + δ in DD-f64, with Zhuoran rebasing.
// Returns { escaped, iter, Zre, Zim } so the caller can do the smoothing
// formula + palette lookup.
export function iteratePixel(deltaReH, deltaReL, deltaImH, deltaImL, frameExp,
                             orbit, orbitLen, maxIter, kind = 'mandelbrot') {
  // Mandelbrot: w₀ = 0 (both pixel & ref orbits start at 0).
  // Julia:      w₀ = δz (pixel starts at view-pixel; ref at view-centre).
  // Either way, w_exp aligns with delta_exp so the first step has no shift.
  let wReH, wReL, wImH, wImL;
  if (kind === 'julia') {
    wReH = deltaReH; wReL = deltaReL;
    wImH = deltaImH; wImL = deltaImL;
  } else {
    wReH = 0; wReL = 0; wImH = 0; wImL = 0;
  }
  let wExp = frameExp;
  const deltaExp = frameExp;

  let refI = 0;
  let actualI = 0;
  let escaped = false;
  let Zre = 0, Zim = 0;

  while (actualI < maxIter) {
    if (refI >= orbitLen) break;
    const zRe = orbit[refI * 4 + 0];
    const zIm = orbit[refI * 4 + 2];

    // Reconstruct w at exp 0 — only the hi part; enough for escape/rebase checks.
    const wPow = Math.pow(2, wExp);
    const wReAct = wReH * wPow;
    const wImAct = wImH * wPow;
    Zre = zRe + wReAct;
    Zim = zIm + wImAct;
    const zz = Zre * Zre + Zim * Zim;
    if (zz > 65536.0) { escaped = true; break; }

    // Rebasing (Zhuoran + forced at end of reference orbit). Set w = Z + w
    // in mantissa form at exp 0, restart from ref_i = 0.
    const zNorm = Math.max(Math.abs(Zre), Math.abs(Zim));
    const wNorm = Math.max(Math.abs(wReAct), Math.abs(wImAct));
    const atEnd = (refI + 1 >= orbitLen);
    const zhuoran = (refI > 0 && zNorm < 2.0 * wNorm);
    if (atEnd || zhuoran) {
      const [wReAt0H, wReAt0L] = ddScalePow2(wReH, wReL, wExp);
      const [wImAt0H, wImAt0L] = ddScalePow2(wImH, wImL, wExp);
      const zReDD = orbit[refI * 4 + 0];
      const zReDDL = orbit[refI * 4 + 1];
      const zImDD = orbit[refI * 4 + 2];
      const zImDDL = orbit[refI * 4 + 3];
      [wReH, wReL] = ddAdd(zReDD, zReDDL, wReAt0H, wReAt0L);
      [wImH, wImL] = ddAdd(zImDD, zImDDL, wImAt0H, wImAt0L);
      // Julia: w must be expressed in the new reference frame as (z_actual − Z[0]).
      // Mandelbrot's Z[0] = 0 so the subtract would be a no-op (skip it). For
      // Julia, Z[0] = z_ref, and skipping the subtract leaks z_ref into w on
      // every rebase — that's the "Julia deep zoom degrades fast" bug.
      if (kind === 'julia') {
        const z0ReH = orbit[0], z0ReL = orbit[1];
        const z0ImH = orbit[2], z0ImL = orbit[3];
        [wReH, wReL] = ddSub(wReH, wReL, z0ReH, z0ReL);
        [wImH, wImL] = ddSub(wImH, wImL, z0ImH, z0ImL);
      }
      wExp = 0;
      refI = 0;
      continue;
    }

    // W_{n+1} = 2·z·w + w² + δ, computed in DD mantissa form at a shared exp.
    // Natural exponents: 2zw → wExp, w² → 2*wExp, δ → deltaExp. Target is
    // the max (least negative) — every other term shifts down (safe).
    const zReL = orbit[refI * 4 + 1];
    const zImL = orbit[refI * 4 + 3];
    const [zrwrH, zrwrL] = ddMul(zRe, zReL, wReH, wReL);
    const [ziwiH, ziwiL] = ddMul(zIm, zImL, wImH, wImL);
    const [zrwiH, zrwiL] = ddMul(zRe, zReL, wImH, wImL);
    const [ziwrH, ziwrL] = ddMul(zIm, zImL, wReH, wReL);
    let [twoZwReH, twoZwReL] = ddSub(zrwrH, zrwrL, ziwiH, ziwiL);
    twoZwReH *= 2; twoZwReL *= 2;
    let [twoZwImH, twoZwImL] = ddAdd(zrwiH, zrwiL, ziwrH, ziwrL);
    twoZwImH *= 2; twoZwImL *= 2;
    const [wr2H, wr2L] = ddMul(wReH, wReL, wReH, wReL);
    const [wi2H, wi2L] = ddMul(wImH, wImL, wImH, wImL);
    const [wsqReH, wsqReL] = ddSub(wr2H, wr2L, wi2H, wi2L);
    let [wrwiH, wrwiL] = ddMul(wReH, wReL, wImH, wImL);
    wrwiH *= 2; wrwiL *= 2;

    const targetExp = Math.max(wExp, 2 * wExp, deltaExp);
    const [t1ReH, t1ReL] = ddScalePow2(twoZwReH, twoZwReL, wExp - targetExp);
    const [t1ImH, t1ImL] = ddScalePow2(twoZwImH, twoZwImL, wExp - targetExp);
    const [t2ReH, t2ReL] = ddScalePow2(wsqReH, wsqReL, 2 * wExp - targetExp);
    const [t2ImH, t2ImL] = ddScalePow2(wrwiH, wrwiL, 2 * wExp - targetExp);

    // Mandelbrot adds δc each iter; Julia's δc is 0 (c identical for pixel and ref).
    let [sumReH, sumReL] = ddAdd(t1ReH, t1ReL, t2ReH, t2ReL);
    let [sumImH, sumImL] = ddAdd(t1ImH, t1ImL, t2ImH, t2ImL);
    if (kind !== 'julia') {
      const [t3ReH, t3ReL] = ddScalePow2(deltaReH, deltaReL, deltaExp - targetExp);
      const [t3ImH, t3ImL] = ddScalePow2(deltaImH, deltaImL, deltaExp - targetExp);
      [sumReH, sumReL] = ddAdd(sumReH, sumReL, t3ReH, t3ReL);
      [sumImH, sumImL] = ddAdd(sumImH, sumImL, t3ImH, t3ImL);
    }

    const peak = Math.max(Math.abs(sumReH), Math.abs(sumImH));
    let shift = 0;
    if (peak > 1e-300) shift = Math.floor(Math.log2(peak));
    if (shift !== 0) {
      [sumReH, sumReL] = ddScalePow2(sumReH, sumReL, -shift);
      [sumImH, sumImL] = ddScalePow2(sumImH, sumImL, -shift);
    }
    wReH = sumReH; wReL = sumReL;
    wImH = sumImH; wImL = sumImL;
    wExp = targetExp + shift;

    refI++;
    actualI++;
  }
  return { escaped, iter: actualI, Zre, Zim };
}

// ---------- Per-pixel perturbation (QD-f64) ----------

// QD-f64 variant of iteratePixel. Same algorithm — Zhuoran rebasing,
// w_{n+1} = 2·z·w + w² + δ — but in 62-digit QD arithmetic instead of
// 31-digit DD. No frame_exp scaling needed because QD's f64 components
// represent absolute values (not mantissas) and the smallest non-underflow
// f64 is ~10⁻³²³, far below any zoom we'd render at.
//
// Orbit storage layout: 8 doubles per orbit point — orbit[i*8..i*8+3] =
// re QD components, orbit[i*8+4..i*8+7] = im QD components. Emitted by
// orbit-worker.js when zoomDigits ≥ 31.
//
// Inputs:
//   deltaRe, deltaIm: Float64Array of length 4 (QD-f64 of pixel-vs-ref offset).
//   orbit:            Float64Array, 8 doubles/orbit-point.
//   orbitLen, maxIter: same as DD path.
// Returns same shape as iteratePixel: { escaped, iter, Zre, Zim }.
export function iteratePixelQD(deltaRe, deltaIm, orbit, orbitLen, maxIter, kind = 'mandelbrot') {
  // Mandelbrot: w₀ = 0. Julia: w₀ = δz (per-pixel offset).
  let wRe, wIm;
  if (kind === 'julia') {
    wRe = Float64Array.from(deltaRe);
    wIm = Float64Array.from(deltaIm);
  } else {
    wRe = new Float64Array(4);
    wIm = new Float64Array(4);
  }

  let refI = 0;
  let actualI = 0;
  let escaped = false;
  let Zre = 0, Zim = 0;

  while (actualI < maxIter) {
    if (refI >= orbitLen) break;

    // Read z[refI] from QD orbit. Subarray returns a view (no copy).
    const zReView = orbit.subarray(refI * 8,     refI * 8 + 4);
    const zImView = orbit.subarray(refI * 8 + 4, refI * 8 + 8);

    // Reconstruct Z = z + w for escape and rebase checks. Top components
    // are sufficient for the escape-magnitude test (precision below 10⁻¹⁶
    // doesn't affect the |Z|² > 65536 decision).
    Zre = zReView[0] + wRe[0];
    Zim = zImView[0] + wIm[0];
    const zz = Zre * Zre + Zim * Zim;
    if (zz > 65536.0) { escaped = true; break; }

    // Rebase (Zhuoran + forced at end of reference orbit). Set w := z + w
    // (in QD), restart from refI = 0. Copy z views into fresh QDs because
    // qdAdd allocates new output but reads the inputs and we want to be
    // safe against any aliasing surprises with subarray views.
    const zNorm = Math.max(Math.abs(Zre), Math.abs(Zim));
    const wNorm = Math.max(Math.abs(wRe[0]), Math.abs(wIm[0]));
    const atEnd = (refI + 1 >= orbitLen);
    const zhuoran = (refI > 0 && zNorm < 2.0 * wNorm);
    if (atEnd || zhuoran) {
      const zReCopy = Float64Array.from(zReView);
      const zImCopy = Float64Array.from(zImView);
      wRe = qdAdd(zReCopy, wRe);
      wIm = qdAdd(zImCopy, wIm);
      // Same Julia rebase correction as the DD path — subtract Z[0] so w lands
      // in the new reference frame. Mandelbrot's Z[0] = 0 → skip.
      if (kind === 'julia') {
        const z0ReCopy = Float64Array.from(orbit.subarray(0, 4));
        const z0ImCopy = Float64Array.from(orbit.subarray(4, 8));
        wRe = qdSub(wRe, z0ReCopy);
        wIm = qdSub(wIm, z0ImCopy);
      }
      refI = 0;
      continue;
    }

    // w_{n+1} = 2·z·w + w² + δ in QD-f64.
    // 2·z·w (real) = 2·(zr·wr − zi·wi)
    // 2·z·w (imag) = 2·(zr·wi + zi·wr)
    const zReQD = Float64Array.from(zReView);
    const zImQD = Float64Array.from(zImView);
    const zrWr = qdMul(zReQD, wRe);
    const ziWi = qdMul(zImQD, wIm);
    const zrWi = qdMul(zReQD, wIm);
    const ziWr = qdMul(zImQD, wRe);
    const twoZwRe = qdMulPow2(qdSub(zrWr, ziWi), 1);
    const twoZwIm = qdMulPow2(qdAdd(zrWi, ziWr), 1);

    // w² (real) = wr² − wi², w² (imag) = 2·wr·wi
    const wrSq = qdSqr(wRe);
    const wiSq = qdSqr(wIm);
    const wsqRe = qdSub(wrSq, wiSq);
    const wsqIm = qdMulPow2(qdMul(wRe, wIm), 1);

    // Sum into next w. Julia drops +δc (c is identical for pixel & ref).
    if (kind === 'julia') {
      wRe = qdAdd(twoZwRe, wsqRe);
      wIm = qdAdd(twoZwIm, wsqIm);
    } else {
      wRe = qdAdd(qdAdd(twoZwRe, wsqRe), deltaRe);
      wIm = qdAdd(qdAdd(twoZwIm, wsqIm), deltaIm);
    }

    refI++;
    actualI++;
  }
  return { escaped, iter: actualI, Zre, Zim };
}

// ---------- Tile loop (QD-f64) ----------

// QD-f64 variant of renderTile. Caller is responsible for passing scale and
// view-vs-ref delta as QD-f64 (Float64Array of 4). Same color/palette logic
// as renderTile, just the per-pixel iteration runs in QD.
export function renderTileQD({
  tileX, tileY, tileW, tileH, canvasW, canvasH,
  orbit, orbitLen,
  scaleQD,            // Float64Array(4)
  deltaReQD, deltaImQD, // Float64Array(4) each
  maxIter, palette: pal,
  kind = 'mandelbrot',
  onRowProgress,
}) {
  const aspect = canvasW / canvasH;
  const aspectQD = qdFromNumber(aspect);
  const scaleAspectQD = qdMul(scaleQD, aspectQD); // scale * aspect, precomputed
  const pixels = new Uint8ClampedArray(tileW * tileH * 4);

  for (let py = 0; py < tileH; py++) {
    if (onRowProgress && (py & 15) === 0) onRowProgress(py, tileH);
    const cy = tileY + py;
    const uvy = 1 - (cy / canvasH) * 2;
    const uvyQD = qdFromNumber(uvy);
    const dyRow = qdMul(scaleQD, uvyQD);
    const pxDy = qdAdd(deltaImQD, dyRow);
    for (let px = 0; px < tileW; px++) {
      const cx = tileX + px;
      const uvx = (cx / canvasW) * 2 - 1;
      const uvxQD = qdFromNumber(uvx);
      const dxCol = qdMul(scaleAspectQD, uvxQD);
      const pxDx = qdAdd(deltaReQD, dxCol);

      const r = iteratePixelQD(pxDx, pxDy, orbit, orbitLen, maxIter, kind);
      const pxIdx = (py * tileW + px) * 4;
      if (!r.escaped) {
        pixels[pxIdx + 3] = 255;
        continue;
      }
      const zz = r.Zre * r.Zre + r.Zim * r.Zim;
      const smoothI = r.iter - Math.log2(Math.log2(zz)) + 4.0;
      const t = Math.log2(smoothI + 1.0) * 4.0 + pal.offset;
      const [cr, cg, cb] = palette(t, pal.a, pal.b, pal.c, pal.d);
      pixels[pxIdx + 0] = clampByte(cr);
      pixels[pxIdx + 1] = clampByte(cg);
      pixels[pxIdx + 2] = clampByte(cb);
      pixels[pxIdx + 3] = 255;
    }
  }
  return pixels;
}

// ---------- Palette (IQ cosine) ----------

export function palette(t, a, b, c, d) {
  const TAU = 6.283185307179586;
  return [
    a[0] + b[0] * Math.cos(TAU * (c[0] * t + d[0])),
    a[1] + b[1] * Math.cos(TAU * (c[1] * t + d[1])),
    a[2] + b[2] * Math.cos(TAU * (c[2] * t + d[2])),
  ];
}

export function clampByte(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 255;
  return (x * 255) | 0;
}

// ---------- Tile loop ----------

// Render one tile into a freshly-allocated RGBA Uint8ClampedArray. Takes the
// same field set the worker receives so the worker just forwards its payload.
// Optional `onRowProgress(rowsDone, totalRows)` callback fires every ~16
// rows so the UI can show within-tile progress (each tile of e.g. 1800×112
// at deep zoom takes minutes; without per-row reporting the status pill
// just shows "0/9 tiles" until the first whole tile lands).
export function renderTile({
  tileX, tileY, tileW, tileH, canvasW, canvasH,
  orbit, orbitLen,
  scaleMantHi, scaleMantLo, frameExp,
  deltaReHi, deltaReLo, deltaImHi, deltaImLo,
  maxIter, palette: pal,
  kind = 'mandelbrot',
  onRowProgress,
}) {
  const aspect = canvasW / canvasH;
  const pixels = new Uint8ClampedArray(tileW * tileH * 4);

  for (let py = 0; py < tileH; py++) {
    if (onRowProgress && (py & 15) === 0) onRowProgress(py, tileH);
    const cy = tileY + py;
    const uvy = 1 - (cy / canvasH) * 2;
    const [dyRowH, dyRowL] = ddMul(scaleMantHi, scaleMantLo, uvy, 0);
    const [pxDyH, pxDyL] = ddAdd(deltaImHi, deltaImLo, dyRowH, dyRowL);
    for (let px = 0; px < tileW; px++) {
      const cx = tileX + px;
      const uvx = (cx / canvasW) * 2 - 1;
      const [axH, axL] = ddMul(scaleMantHi, scaleMantLo, aspect, 0);
      const [dxColH, dxColL] = ddMul(axH, axL, uvx, 0);
      const [pxDxH, pxDxL] = ddAdd(deltaReHi, deltaReLo, dxColH, dxColL);

      const r = iteratePixel(
        pxDxH, pxDxL, pxDyH, pxDyL, frameExp,
        orbit, orbitLen, maxIter, kind
      );
      const pxIdx = (py * tileW + px) * 4;
      if (!r.escaped) {
        pixels[pxIdx + 3] = 255;
        continue;
      }
      const zz = r.Zre * r.Zre + r.Zim * r.Zim;
      const smoothI = r.iter - Math.log2(Math.log2(zz)) + 4.0;
      const t = Math.log2(smoothI + 1.0) * 4.0 + pal.offset;
      const [cr, cg, cb] = palette(t, pal.a, pal.b, pal.c, pal.d);
      pixels[pxIdx + 0] = clampByte(cr);
      pixels[pxIdx + 1] = clampByte(cg);
      pixels[pxIdx + 2] = clampByte(cb);
      pixels[pxIdx + 3] = 255;
    }
  }
  return pixels;
}
