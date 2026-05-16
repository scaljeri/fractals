// Scientific validation of perturbation theory.
// Hypothesis: pure perturbation theory is MATHEMATICALLY EXACT. When the reference
// orbit is long enough (or we rebase), perturbation results must match direct
// Mandelbrot iteration up to tiny floating-point noise.

const BAILOUT_SQ = 256;

// ---------- Direct Mandelbrot (ground truth) ----------
function iterateDirect(cx, cy, maxIter) {
  let zx = 0, zy = 0;
  for (let i = 0; i < maxIter; i++) {
    const zx2 = zx * zx, zy2 = zy * zy;
    if (zx2 + zy2 > BAILOUT_SQ) return { escaped: true, iter: i };
    const nx = zx2 - zy2 + cx;
    const ny = 2 * zx * zy + cy;
    zx = nx; zy = ny;
  }
  return { escaped: false, iter: maxIter };
}

// ---------- Reference orbit ----------
function computeReferenceOrbit(cRefX, cRefY, maxIter) {
  const zxs = new Float64Array(maxIter);
  const zys = new Float64Array(maxIter);
  let zx = 0, zy = 0;
  let n = 0;
  for (let i = 0; i < maxIter; i++) {
    zxs[i] = zx;
    zys[i] = zy;
    n = i + 1;
    const zx2 = zx * zx, zy2 = zy * zy;
    if (zx2 + zy2 > BAILOUT_SQ) break;
    const nx = zx2 - zy2 + cRefX;
    const ny = 2 * zx * zy + cRefY;
    zx = nx; zy = ny;
  }
  return { zxs, zys, len: n };
}

// ---------- Pure perturbation (no rebasing) ----------
function iteratePerturbation(orbit, dx, dy, maxIter) {
  let wx = 0, wy = 0;
  const len = Math.min(orbit.len, maxIter);
  for (let i = 0; i < len; i++) {
    const zx = orbit.zxs[i];
    const zy = orbit.zys[i];
    const Zx = zx + wx;
    const Zy = zy + wy;
    if (Zx * Zx + Zy * Zy > BAILOUT_SQ) return { escaped: true, iter: i };
    const wx_new = 2 * (zx * wx - zy * wy) + (wx * wx - wy * wy) + dx;
    const wy_new = 2 * (zx * wy + zy * wx) + 2 * wx * wy + dy;
    wx = wx_new; wy = wy_new;
  }
  return { escaped: false, iter: len };
}

// ---------- Perturbation + rebasing (Zhuoran / davidbau / rust-fractal) ----------
// Rebase when:
//  (a) Zhuoran preemptive: max(|Z.re|, |Z.im|) < 2 · max(|W.re|, |W.im|)
//  (b) Forced on ref exhaustion: ref_i == orbit.len - 1 (rust-fractal technique)
// This allows pixels to iterate BEYOND orbit.len using the existing reference via
// repeated rebases.
function iteratePerturbationRebase(orbit, dx, dy, maxIter) {
  let wx = 0, wy = 0;
  let refI = 0;
  let actualI = 0;
  while (actualI < maxIter) {
    if (refI >= orbit.len) break; // unreachable with forced-rebase below
    const zx = orbit.zxs[refI];
    const zy = orbit.zys[refI];
    const Zx = zx + wx;
    const Zy = zy + wy;
    if (Zx * Zx + Zy * Zy > BAILOUT_SQ) return { escaped: true, iter: actualI };
    const zNorm = Math.max(Math.abs(Zx), Math.abs(Zy));
    const wNorm = Math.max(Math.abs(wx), Math.abs(wy));
    const forced = refI === orbit.len - 1;
    const zhuoran = refI > 0 && zNorm < 2 * wNorm;
    if (forced || zhuoran) {
      wx = Zx; wy = Zy; refI = 0;
      continue;
    }
    const wx_new = 2 * (zx * wx - zy * wy) + (wx * wx - wy * wy) + dx;
    const wy_new = 2 * (zx * wy + zy * wx) + 2 * wx * wy + dy;
    wx = wx_new; wy = wy_new;
    refI++; actualI++;
  }
  return { escaped: false, iter: actualI };
}

// ---------- Series Approximation (Heiland-Allen §4) ----------
function computeSACoefficients(orbit, N) {
  let A1x = 0, A1y = 0, A2x = 0, A2y = 0, A3x = 0, A3y = 0, A4x = 0, A4y = 0;
  for (let i = 0; i < N; i++) {
    const a1x = A1x, a1y = A1y;
    const a2x = A2x, a2y = A2y;
    const a3x = A3x, a3y = A3y;
    const a4x = A4x, a4y = A4y;
    const zx = orbit.zxs[i], zy = orbit.zys[i];
    A1x = 2 * (zx * a1x - zy * a1y) + 1;
    A1y = 2 * (zx * a1y + zy * a1x);
    const a1sqx = a1x * a1x - a1y * a1y;
    const a1sqy = 2 * a1x * a1y;
    A2x = 2 * (zx * a2x - zy * a2y) + a1sqx;
    A2y = 2 * (zx * a2y + zy * a2x) + a1sqy;
    const a1a2x = a1x * a2x - a1y * a2y;
    const a1a2y = a1x * a2y + a1y * a2x;
    A3x = 2 * (zx * a3x - zy * a3y) + 2 * a1a2x;
    A3y = 2 * (zx * a3y + zy * a3x) + 2 * a1a2y;
    const a1a3x = a1x * a3x - a1y * a3y;
    const a1a3y = a1x * a3y + a1y * a3x;
    const a2sqx = a2x * a2x - a2y * a2y;
    const a2sqy = 2 * a2x * a2y;
    A4x = 2 * (zx * a4x - zy * a4y) + 2 * a1a3x + a2sqx;
    A4y = 2 * (zx * a4y + zy * a4x) + 2 * a1a3y + a2sqy;
  }
  return { A1x, A1y, A2x, A2y, A3x, A3y, A4x, A4y };
}

function evaluateSA(c, dx, dy) {
  const d2x = dx * dx - dy * dy, d2y = 2 * dx * dy;
  const d3x = d2x * dx - d2y * dy, d3y = d2x * dy + d2y * dx;
  return {
    wx: c.A1x * dx - c.A1y * dy + c.A2x * d2x - c.A2y * d2y + c.A3x * d3x - c.A3y * d3y,
    wy: c.A1x * dy + c.A1y * dx + c.A2x * d2y + c.A2y * d2x + c.A3x * d3y + c.A3y * d3x,
  };
}

function findSkipIter(orbit, deltaMax, eps = 1e-3) {
  let A1x = 0, A1y = 0, A2x = 0, A2y = 0, A3x = 0, A3y = 0, A4x = 0, A4y = 0;
  const d2 = deltaMax * deltaMax;
  const d6 = d2 * d2 * d2;
  const eps2 = eps * eps;
  let skip = 0;
  for (let i = 0; i < orbit.len; i++) {
    const a1m2 = A1x * A1x + A1y * A1y;
    const a4m2 = A4x * A4x + A4y * A4y;
    if (a4m2 * d6 > eps2 * a1m2) break;
    skip = i;
    const a1x = A1x, a1y = A1y, a2x = A2x, a2y = A2y, a3x = A3x, a3y = A3y, a4x = A4x, a4y = A4y;
    const zx = orbit.zxs[i], zy = orbit.zys[i];
    A1x = 2 * (zx * a1x - zy * a1y) + 1;
    A1y = 2 * (zx * a1y + zy * a1x);
    const a1sqx = a1x * a1x - a1y * a1y, a1sqy = 2 * a1x * a1y;
    A2x = 2 * (zx * a2x - zy * a2y) + a1sqx;
    A2y = 2 * (zx * a2y + zy * a2x) + a1sqy;
    const a1a2x = a1x * a2x - a1y * a2y, a1a2y = a1x * a2y + a1y * a2x;
    A3x = 2 * (zx * a3x - zy * a3y) + 2 * a1a2x;
    A3y = 2 * (zx * a3y + zy * a3x) + 2 * a1a2y;
    const a1a3x = a1x * a3x - a1y * a3y, a1a3y = a1x * a3y + a1y * a3x;
    const a2sqx = a2x * a2x - a2y * a2y, a2sqy = 2 * a2x * a2y;
    A4x = 2 * (zx * a4x - zy * a4y) + 2 * a1a3x + a2sqx;
    A4y = 2 * (zx * a4y + zy * a4x) + 2 * a1a3y + a2sqy;
  }
  return skip;
}

function iterateSA(orbit, skipIter, dx, dy, maxIter) {
  const coeffs = computeSACoefficients(orbit, skipIter);
  const { wx: wx0, wy: wy0 } = evaluateSA(coeffs, dx, dy);
  let wx = wx0, wy = wy0;
  const len = Math.min(orbit.len, maxIter);
  for (let i = skipIter; i < len; i++) {
    const zx = orbit.zxs[i], zy = orbit.zys[i];
    const Zx = zx + wx, Zy = zy + wy;
    if (Zx * Zx + Zy * Zy > BAILOUT_SQ) return { escaped: true, iter: i };
    const wx_new = 2 * (zx * wx - zy * wy) + (wx * wx - wy * wy) + dx;
    const wy_new = 2 * (zx * wy + zy * wx) + 2 * wx * wy + dy;
    wx = wx_new; wy = wy_new;
  }
  return { escaped: false, iter: len };
}

// ---------- Compare methods on a grid ----------
function compareGrid(refX, refY, viewSize, maxIter, label) {
  console.log(`\n──── ${label} ────`);
  console.log(`Reference: (${refX}, ${refY}), scale ${viewSize}`);

  const orbit = computeReferenceOrbit(refX, refY, maxIter);
  const refNote = orbit.len < maxIter ? ` (REF ESCAPED)` : ` (ref stays bounded)`;
  console.log(`  Reference orbit length: ${orbit.len}${refNote}`);

  const deltaMax = viewSize * Math.SQRT2;
  const skip = findSkipIter(orbit, deltaMax);
  console.log(`  SA skip: ${skip}`);

  const N = 21;
  let stats = { pure: 0, rebase: 0, sa: 0, total: 0 };
  let maxDiffs = { pure: 0, rebase: 0, sa: 0 };
  const samples = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const dx = (i / (N - 1) - 0.5) * 2 * viewSize;
      const dy = (j / (N - 1) - 0.5) * 2 * viewSize;
      const direct = iterateDirect(refX + dx, refY + dy, maxIter);
      const pure = iteratePerturbation(orbit, dx, dy, maxIter);
      const rebase = iteratePerturbationRebase(orbit, dx, dy, maxIter);
      const sa = iterateSA(orbit, skip, dx, dy, maxIter);
      stats.total++;
      if (direct.iter === pure.iter) stats.pure++;
      if (direct.iter === rebase.iter) stats.rebase++;
      if (direct.iter === sa.iter) stats.sa++;
      maxDiffs.pure = Math.max(maxDiffs.pure, Math.abs(direct.iter - pure.iter));
      maxDiffs.rebase = Math.max(maxDiffs.rebase, Math.abs(direct.iter - rebase.iter));
      maxDiffs.sa = Math.max(maxDiffs.sa, Math.abs(direct.iter - sa.iter));
      if (Math.abs(direct.iter - rebase.iter) > 2 && samples.length < 3) {
        samples.push({ dx, dy, direct: direct.iter, pure: pure.iter, rebase: rebase.iter, sa: sa.iter });
      }
    }
  }
  const pct = (v) => ((v / stats.total) * 100).toFixed(1) + '%';
  console.log(`  Pure:   ${pct(stats.pure).padStart(6)}  max-diff ${String(maxDiffs.pure).padStart(5)}`);
  console.log(`  Rebase: ${pct(stats.rebase).padStart(6)}  max-diff ${String(maxDiffs.rebase).padStart(5)}`);
  console.log(`  SA:     ${pct(stats.sa).padStart(6)}  max-diff ${String(maxDiffs.sa).padStart(5)}`);
  if (samples.length) {
    console.log(`  Sample rebase mismatches (direct / pure / rebase / SA):`);
    for (const s of samples) {
      console.log(`    δ=(${s.dx.toExponential(2)}, ${s.dy.toExponential(2)}) → ${s.direct} / ${s.pure} / ${s.rebase} / ${s.sa}`);
    }
  }
}

console.log('Scientific validation of perturbation theory for Mandelbrot set\n');
console.log('Legend: direct = ground truth. pure = perturbation without rebasing.');
console.log('        rebase = with Pauldelbrot rebasing. SA = with series approximation.\n');

// In-set reference: orbit stays bounded forever
compareGrid(-0.5, 0, 1.3, 2000, 'HOME (ref in set, wide view)');

// Shallow zoom with IN-SET reference: use (-0.75, 0) which is clearly in set
compareGrid(-0.75, 0, 0.01, 5000, 'Shallow zoom, ref in set');

// Shallow zoom with near-boundary reference: (Seahorse Valley approach)
compareGrid(-0.743643887, 0.131825904, 0.01, 5000, 'Shallow zoom, near-boundary ref');

// Deep zoom with near-boundary reference
compareGrid(-0.743643887037151, 0.131825904205330, 1e-6, 10000, 'Deep zoom, Seahorse reference');

// Very deep zoom
compareGrid(-0.743643887037151, 0.131825904205330, 1e-9, 10000, 'Very deep zoom');
