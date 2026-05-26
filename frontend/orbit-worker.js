// Background worker that does the expensive reference-orbit computation in
// complex-DD JS. Called from main.js on every view change during interactive
// use so the main thread stays free for click handling, panning, etc.
//
// Protocol:
//   main → worker: { id, viewCxStr, viewCyStr, scale, aspect, maxIter }
//   worker → main: { id, refCxStr, refCyStr, len, orbitBytes }
//
// View center comes in as a Decimal string (60 digits) so navigation precision
// survives past 10^28. The orbit iteration itself still runs in DD (~31 digits)
// for speed — at deeper zoom the rendering degrades but panning/zooming stays
// lossless. The returned `orbitBytes` is a transferable ArrayBuffer containing
// the ready-to-upload TD-f32 orbit (6 floats per iteration).

import Decimal from 'https://esm.sh/decimal.js@10';
Decimal.set({ precision: 60 });

// ---------- Double-double arithmetic on [hi, lo] f64 pairs ----------

const DD_SPLIT = 134217729; // 2^27 + 1 for f64 mantissa

function twoSum(a, b) {
  const s = a + b;
  const bb = s - a;
  return [s, (a - (s - bb)) + (b - bb)];
}
function quickTwoSum(a, b) {
  const s = a + b;
  return [s, b - (s - a)];
}
function splitF64(a) {
  const t = DD_SPLIT * a;
  const hi = t - (t - a);
  return [hi, a - hi];
}
function twoProd(a, b) {
  const [ah, al] = splitF64(a);
  const [bh, bl] = splitF64(b);
  const p = a * b;
  const err = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  return [p, err];
}
function ddAdd(a, b) {
  const [sh, se] = twoSum(a[0], b[0]);
  const [th, te] = twoSum(a[1], b[1]);
  const [u1h, u1l] = quickTwoSum(sh, se + th);
  return quickTwoSum(u1h, u1l + te);
}
function ddMul(a, b) {
  const [p, err] = twoProd(a[0], b[0]);
  return quickTwoSum(p, err + (a[0] * b[1] + a[1] * b[0]));
}
function ddSqr(a) { return ddMul(a, a); }
function ddSub(a, b) { return ddAdd(a, [-b[0], -b[1]]); }

// Complex DD = 4-tuple [reH, reL, imH, imL]
function cddAdd(a, b) {
  const re = ddAdd([a[0], a[1]], [b[0], b[1]]);
  const im = ddAdd([a[2], a[3]], [b[2], b[3]]);
  return [re[0], re[1], im[0], im[1]];
}
function cddSqr(a) {
  const ar = [a[0], a[1]];
  const ai = [a[2], a[3]];
  const ar2 = ddSqr(ar);
  const ai2 = ddSqr(ai);
  const arAi = ddMul(ar, ai);
  const re = ddSub(ar2, ai2);
  return [re[0], re[1], arAi[0] * 2, arAi[1] * 2];
}

// DD-f64 → TD-f32 triple (hi, mid, lo) with ~21 digits of precision.
function ddToF32TD(h, l) {
  const a = Math.fround(h);
  const rem1 = (h - a) + l;
  const b = Math.fround(rem1);
  const rem2 = rem1 - b;
  const c = Math.fround(rem2);
  return [a, b, c];
}

function decimalToDD(d) {
  const hi = d.toNumber();
  const lo = d.minus(hi).toNumber();
  return [hi, lo];
}

// Decimal → TD-f32 triple — same pattern as ddToF32TD but starting from a
// Decimal so 60-digit precision survives into the GPU buffer (as many digits
// as f32 TD can hold, which is ~21).
function decimalToTD(d) {
  const a = Math.fround(d.toNumber());
  const rem1 = d.minus(a);
  const b = Math.fround(rem1.toNumber());
  const rem2 = rem1.minus(b);
  const c = Math.fround(rem2.toNumber());
  return [a, b, c];
}

// Decimal → QD-f64 (4 doubles, ~62 digits). Used to emit orbit samples in QD
// form when zoomDigits ≥ 31 — the per-pixel CPU kernel reads this when in
// QD precision mode. Each component is the best f64 approximation of the
// residual after the previous components, so the four components are
// non-overlapping and sum to the original Decimal value at QD precision.
function decimalToQD(d) {
  const a0 = d.toNumber();
  const rem1 = d.minus(a0);
  const a1 = rem1.toNumber();
  const rem2 = rem1.minus(a1);
  const a2 = rem2.toNumber();
  const rem3 = rem2.minus(a2);
  const a3 = rem3.toNumber();
  return [a0, a1, a2, a3];
}

// ---------- Reference point picker ----------

// kind: 'mandelbrot' (z₀ = 0, c = ref) | 'julia' (z₀ = ref, c = juliaC).
function countOrbitLen(refCxDD, refCyDD, maxIter, kind = 'mandelbrot', juliaCxDD = null, juliaCyDD = null) {
  let z, c;
  if (kind === 'julia') {
    z = [refCxDD[0], refCxDD[1], refCyDD[0], refCyDD[1]];
    c = [juliaCxDD[0], juliaCxDD[1], juliaCyDD[0], juliaCyDD[1]];
  } else {
    z = [0, 0, 0, 0];
    c = [refCxDD[0], refCxDD[1], refCyDD[0], refCyDD[1]];
  }
  for (let i = 0; i < maxIter; i++) {
    if (z[0] * z[0] + z[2] * z[2] > 256.0) return i;
    z = cddAdd(cddSqr(z), c);
  }
  return maxIter;
}

function findReference(viewCxDD, viewCyDD, scale, aspect, maxIter, deepSearch, kind = 'mandelbrot', juliaCxDD = null, juliaCyDD = null) {
  let bestOx = 0, bestOy = 0;
  let bestLen = countOrbitLen(viewCxDD, viewCyDD, maxIter, kind, juliaCxDD, juliaCyDD);
  let bestRadiusMul = 0;
  if (bestLen >= maxIter) return { ox: 0, oy: 0, len: bestLen, gridSize: 1, radii: [0], deepSearch: !!deepSearch };

  // Interactive (deepSearch=false): cheap 3×3 within the viewport — runs on
  // every click in <50ms.
  // HQ (deepSearch=true): denser 7×7 grid AND scan three concentric radii
  // (1×, 5×, 25× viewport) so we sample a chunk of the local M-set boundary
  // structure rather than just the tiny 10⁻²² window of the current view.
  // Cost: 3×49 = 147 candidate orbits at maxIter (~30-60s at deep zoom),
  // which is the right tradeoff for a "patience" button.
  const N = deepSearch ? 7 : 3;
  const radii = deepSearch ? [1, 5, 25] : [1];

  let candidatesTried = 1;
  for (const radiusMul of radii) {
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (i === (N - 1) / 2 && j === (N - 1) / 2) continue;   // centre already counted
        const u = (i / (N - 1)) * 2 - 1;
        const v = (j / (N - 1)) * 2 - 1;
        const ox = u * scale * aspect * 0.98 * radiusMul;
        const oy = v * scale * 0.98 * radiusMul;
        const cxDD = ddAdd(viewCxDD, [ox, 0]);
        const cyDD = ddAdd(viewCyDD, [oy, 0]);
        const len = countOrbitLen(cxDD, cyDD, maxIter, kind, juliaCxDD, juliaCyDD);
        candidatesTried++;
        if (len > bestLen) {
          bestLen = len;
          bestOx = ox; bestOy = oy;
          bestRadiusMul = radiusMul;
          if (bestLen >= maxIter) return { ox: bestOx, oy: bestOy, len: bestLen, gridSize: N, radii, deepSearch: !!deepSearch, candidatesTried };
        }
      }
    }
  }
  return { ox: bestOx, oy: bestOy, len: bestLen, gridSize: N, radii, deepSearch: !!deepSearch, candidatesTried, bestRadiusMul };
}

// ---------- Orbit iteration ----------
// Two implementations. DD is ~10x faster than Decimal at shallow zoom, but
// DD's ~31 sig figs aren't enough once iteration-error accumulation kicks in:
// with 50k iterations the reference orbit loses ~5 digits to multiplicative
// error growth, so empirically DD starts producing one-colour garbage around
// zoom 10^20. Switch to Decimal well before that — 10^11 leaves us plenty of
// margin without paying for Decimal at ordinary interactive zooms.

// Both iterators output up to THREE buffers:
//   - TD-f32 (6 floats/iter) for the GPU shader (shallow & moderate zoom).
//   - DD-f64 (4 doubles/iter) for the CPU DD-f64 path (10^11 - 10^31).
//   - QD-f64 (8 doubles/iter, 4 re + 4 im) for the CPU QD-f64 path (10^31+).
// scratchQD may be null when QD storage isn't needed, in which case we skip
// the per-iteration write to save time (it's the most expensive of the three).
function iterateOrbitDD(refCxDD, refCyDD, maxIter, scratchTD, scratchDD, scratchQD, kind = 'mandelbrot', juliaCxDD = null, juliaCyDD = null) {
  // Mandelbrot: z₀ = 0, c = ref. Julia: z₀ = ref, c = juliaC (fixed).
  let z, c;
  if (kind === 'julia') {
    z = [refCxDD[0], refCxDD[1], refCyDD[0], refCyDD[1]];
    c = [juliaCxDD[0], juliaCxDD[1], juliaCyDD[0], juliaCyDD[1]];
  } else {
    z = [0, 0, 0, 0];
    c = [refCxDD[0], refCxDD[1], refCyDD[0], refCyDD[1]];
  }
  let n = 0;
  for (let i = 0; i < maxIter; i++) {
    const zr = ddToF32TD(z[0], z[1]);
    const zi = ddToF32TD(z[2], z[3]);
    scratchTD[i * 6 + 0] = zr[0]; scratchTD[i * 6 + 1] = zr[1]; scratchTD[i * 6 + 2] = zr[2];
    scratchTD[i * 6 + 3] = zi[0]; scratchTD[i * 6 + 4] = zi[1]; scratchTD[i * 6 + 5] = zi[2];
    scratchDD[i * 4 + 0] = z[0]; scratchDD[i * 4 + 1] = z[1];
    scratchDD[i * 4 + 2] = z[2]; scratchDD[i * 4 + 3] = z[3];
    if (scratchQD) {
      // DD path is only used when zoomDigits < 12, so QD precision is way
      // overkill — but emit it anyway when requested so the CPU side has a
      // single uniform format. Just zero-pad the lower halves.
      scratchQD[i * 8 + 0] = z[0]; scratchQD[i * 8 + 1] = z[1]; scratchQD[i * 8 + 2] = 0; scratchQD[i * 8 + 3] = 0;
      scratchQD[i * 8 + 4] = z[2]; scratchQD[i * 8 + 5] = z[3]; scratchQD[i * 8 + 6] = 0; scratchQD[i * 8 + 7] = 0;
    }
    n = i + 1;
    if (z[0] * z[0] + z[2] * z[2] > 256.0) break;
    z = cddAdd(cddSqr(z), c);
  }
  return n;
}

function iterateOrbitDecimal(refCxDec, refCyDec, maxIter, scratchTD, scratchDD, scratchQD, kind = 'mandelbrot', juliaCxDec = null, juliaCyDec = null) {
  const TWO = new Decimal(2);
  let zr, zi, cReDec, cImDec;
  if (kind === 'julia') {
    zr = refCxDec;
    zi = refCyDec;
    cReDec = juliaCxDec;
    cImDec = juliaCyDec;
  } else {
    zr = new Decimal(0);
    zi = new Decimal(0);
    cReDec = refCxDec;
    cImDec = refCyDec;
  }
  let n = 0;
  for (let i = 0; i < maxIter; i++) {
    const [zra, zrb, zrc] = decimalToTD(zr);
    const [zia, zib, zic] = decimalToTD(zi);
    scratchTD[i * 6 + 0] = zra; scratchTD[i * 6 + 1] = zrb; scratchTD[i * 6 + 2] = zrc;
    scratchTD[i * 6 + 3] = zia; scratchTD[i * 6 + 4] = zib; scratchTD[i * 6 + 5] = zic;
    const [zrH, zrL] = decimalToDD(zr);
    const [ziH, ziL] = decimalToDD(zi);
    scratchDD[i * 4 + 0] = zrH; scratchDD[i * 4 + 1] = zrL;
    scratchDD[i * 4 + 2] = ziH; scratchDD[i * 4 + 3] = ziL;
    if (scratchQD) {
      const [zrQ0, zrQ1, zrQ2, zrQ3] = decimalToQD(zr);
      const [ziQ0, ziQ1, ziQ2, ziQ3] = decimalToQD(zi);
      scratchQD[i * 8 + 0] = zrQ0; scratchQD[i * 8 + 1] = zrQ1; scratchQD[i * 8 + 2] = zrQ2; scratchQD[i * 8 + 3] = zrQ3;
      scratchQD[i * 8 + 4] = ziQ0; scratchQD[i * 8 + 5] = ziQ1; scratchQD[i * 8 + 6] = ziQ2; scratchQD[i * 8 + 7] = ziQ3;
    }
    n = i + 1;
    // Bailout check only needs f64 accuracy — |z| grows fast when it escapes.
    const zrN = zr.toNumber();
    const ziN = zi.toNumber();
    if (zrN * zrN + ziN * ziN > 256.0) break;
    const zr2 = zr.times(zr);
    const zi2 = zi.times(zi);
    const newZr = zr2.minus(zi2).plus(cReDec);
    const newZi = zr.times(zi).times(TWO).plus(cImDec);
    zr = newZr; zi = newZi;
  }
  return n;
}

// ---------- Message handler ----------

console.log('[orbit-worker] booted');

self.addEventListener('message', (ev) => {
  const { id, viewCxStr, viewCyStr, scale, aspect, maxIter, deepSearch, kind, juliaReStr, juliaImStr } = ev.data;
  const t0 = performance.now();
  const fractalKind = kind === 'julia' ? 'julia' : 'mandelbrot';
  console.log(`[orbit-worker] req#${id} start: kind=${fractalKind} scale=${scale.toExponential(2)} maxIter=${maxIter}${deepSearch ? ' DEEP-SEARCH (7×7 grid × 3 radii)' : ''}` + (fractalKind === 'julia' ? ` julia_c=${juliaReStr}+${juliaImStr}i` : ''));

  // Decimal precision tracks the zoom depth + margin for iteration-error
  // amplification (≈log10(max_iter)/0.3 ≈ 5-6 digits for 50k iters, plus a
  // safety cushion). At scale 10^-40 we need ~40+15 = 55 digits; at shallow
  // zoom 20 digits is fine and ~3x faster per mul than 60.
  const zoomDigits = scale > 0 ? Math.ceil(Math.log10(1 / scale)) : 0;
  const precision = Math.max(20, zoomDigits + 15);
  Decimal.set({ precision });

  const viewCxDec = new Decimal(viewCxStr);
  const viewCyDec = new Decimal(viewCyStr);
  const viewCxDD = decimalToDD(viewCxDec);
  const viewCyDD = decimalToDD(viewCyDec);

  // Julia-c is a per-render constant — same Decimal precision as everything else.
  const juliaCxDec = fractalKind === 'julia' ? new Decimal(juliaReStr ?? '0') : null;
  const juliaCyDec = fractalKind === 'julia' ? new Decimal(juliaImStr ?? '0') : null;
  const juliaCxDD = juliaCxDec ? decimalToDD(juliaCxDec) : null;
  const juliaCyDD = juliaCyDec ? decimalToDD(juliaCyDec) : null;

  // findReference only needs DD precision: it's a coarse grid search to pick
  // a candidate that escapes late. At deep zoom the grid points collapse to
  // the view center in DD and findReference returns ox=oy=0, which is fine —
  // the view center itself is a fine reference at that depth.
  const refT0 = performance.now();
  const ref = findReference(viewCxDD, viewCyDD, scale, aspect, maxIter, deepSearch, fractalKind, juliaCxDD, juliaCyDD);
  if (deepSearch) {
    console.log(`[orbit-worker] req#${id} deepSearch result: bestLen=${ref.len} (tried ${ref.candidatesTried} candidates at radii [${ref.radii.join(',')}]× viewport, found at radiusMul=${ref.bestRadiusMul ?? 0}) in ${(performance.now() - refT0).toFixed(0)}ms`);
  }

  const refCxDec = viewCxDec.plus(ref.ox);
  const refCyDec = viewCyDec.plus(ref.oy);

  // Compute the reference orbit. Always emit:
  //   - TD-f32 (6 floats/iter) for the GPU shader.
  //   - DD-f64 (4 doubles/iter) for the CPU DD-f64 path.
  // Optionally also:
  //   - QD-f64 (8 doubles/iter) for the CPU QD-f64 path. Allocated only when
  //     zoomDigits ≥ 31 (the depth past which DD-f64's 31-digit mantissa is
  //     no longer enough); otherwise null and the QD branch is skipped.
  const QD_THRESHOLD = 31;
  const wantQD = zoomDigits >= QD_THRESHOLD;
  const scratchTD = new Float32Array(maxIter * 6);
  const scratchDD = new Float64Array(maxIter * 4);
  const scratchQD = wantQD ? new Float64Array(maxIter * 8) : null;
  let n;
  if (zoomDigits < 12) {
    const refCxDD = decimalToDD(refCxDec);
    const refCyDD = decimalToDD(refCyDec);
    console.log(`[orbit-worker] req#${id} iterating DD (kind=${fractalKind}, zoomDigits=${zoomDigits}, refLen=${ref.len}, wantQD=${wantQD})`);
    n = iterateOrbitDD(refCxDD, refCyDD, ref.len, scratchTD, scratchDD, scratchQD, fractalKind, juliaCxDD, juliaCyDD);
  } else {
    console.log(`[orbit-worker] req#${id} iterating Decimal at precision ${precision} (kind=${fractalKind}, zoomDigits=${zoomDigits}, refLen=${ref.len}, wantQD=${wantQD})`);
    n = iterateOrbitDecimal(refCxDec, refCyDec, ref.len, scratchTD, scratchDD, scratchQD, fractalKind, juliaCxDec, juliaCyDec);
  }

  // Trim and transfer ownership so the main thread uploads without copying.
  const outTD = scratchTD.slice(0, n * 6);
  const outDD = scratchDD.slice(0, n * 4);
  const outQD = wantQD ? scratchQD.slice(0, n * 8) : null;
  const elapsed = (performance.now() - t0).toFixed(0);
  console.log(`[orbit-worker] req#${id} done in ${elapsed}ms, len=${n}, emitted QD=${!!outQD}`);
  const transfer = [outTD.buffer, outDD.buffer];
  if (outQD) transfer.push(outQD.buffer);
  self.postMessage({
    id,
    refCxStr: refCxDec.toString(),
    refCyStr: refCyDec.toString(),
    len: n,
    orbitBytes: outTD.buffer,
    orbitDDBytes: outDD.buffer,
    orbitQDBytes: outQD ? outQD.buffer : null,
  }, transfer);
});
