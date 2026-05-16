// Quad-double f64 arithmetic — four-component renormalised f64 representing
// numbers with ~62 decimal digits of precision (4 × 16 ≈ 64 binary words).
//
// Ported from libqd (Bailey/Hida/Li, "Library for Double-Double and Quad-
// Double Arithmetic", 2000-2007). Reference C++ at
// https://www.davidhbailey.com/dhbsoftware/qd-2.3.x.tar.gz — algorithms
// used here are the "sloppy" variants from src/qd_inline.h, which trade a
// few low-bit ulps for ~30% speedup. Adequate for Mandelbrot perturbation
// where the per-pixel iteration error budget is wide.
//
// Representation: a quad-double is a Float64Array of length 4, [a0, a1, a2, a3]
// where a0 + a1 + a2 + a3 = exact value and the magnitudes form a
// non-overlapping descending sequence. Operations preserve this invariant
// via "renormalisation" (renorm5) which sorts and de-overlaps a 5-element
// cascade down to 4 components.
//
// Why we need it: DD-f64 (~31 digits) caps perturbation at zoom ~10^31. QD-f64
// (~62 digits) lifts that ceiling to ~10^62 while still using native f64 ops
// (~4× slower than DD-f64, vs ~300× for Decimal.js).
//
// All routines pure JS so this file is importable from Node tests.

// ---------- Error-free transformations ----------

const SPLIT = 134217729; // 2^27 + 1

// twoSum: returns [s, e] with s + e = a + b exactly. 6 flops. No magnitude
// requirement on a, b.
export function twoSum(a, b) {
  const s = a + b;
  const bb = s - a;
  const err = (a - (s - bb)) + (b - bb);
  return [s, err];
}

// quickTwoSum: same but assumes |a| >= |b|. 3 flops. Used in renormalisation
// where the magnitude ordering is established by the surrounding cascade.
export function quickTwoSum(a, b) {
  const s = a + b;
  const err = b - (s - a);
  return [s, err];
}

export function splitF64(a) {
  const t = SPLIT * a;
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

export function twoSqr(a) {
  const [ah, al] = splitF64(a);
  const p = a * a;
  const err = ((ah * ah - p) + 2 * ah * al) + al * al;
  return [p, err];
}

// threeSum: returns [s0, s1, s2] such that s0 + s1 + s2 = a + b + c exactly,
// and roughly |s0| ≥ |s1| ≥ |s2|. 18 flops.
function threeSum(a, b, c) {
  const [t1, t2] = twoSum(a, b);
  const [s0, t3] = twoSum(t1, c);
  const [s1, s2] = twoSum(t2, t3);
  return [s0, s1, s2];
}

// threeSum2: like threeSum but only returns top two components (third is
// added in approximately). 12 flops. Used when the third would be below the
// QD precision floor anyway.
function threeSum2(a, b, c) {
  const [t1, t2] = twoSum(a, b);
  const [s0, t3] = twoSum(t1, c);
  return [s0, t2 + t3];
}

// ---------- Renormalisation ----------

// renorm5: take 5 unsorted/overlapping doubles and produce a renormalised
// QD (4 doubles, sorted, non-overlapping). Direct port of libqd's renorm
// (src/qd_inline.h:renorm). The two-pass structure first cascades right-
// to-left to establish magnitude ordering, then compresses to 4 components
// while skipping zero residuals.
function renorm5(c0, c1, c2, c3, c4, out) {
  let s0, s1 = 0, s2 = 0, s3 = 0;
  if (!Number.isFinite(c0)) {
    out[0] = c0; out[1] = 0; out[2] = 0; out[3] = 0;
    return;
  }

  // Pass 1: cascade right-to-left so c0 ends up holding the dominant sum and
  // c1..c4 hold residuals of decreasing magnitude.
  let s, e;
  [s, c4] = quickTwoSum(c3, c4);
  [s, c3] = quickTwoSum(c2, s);
  [s, c2] = quickTwoSum(c1, s);
  [c0, c1] = quickTwoSum(c0, s);

  // Pass 2: compress to 4 components, skipping zeros so we don't waste
  // precision tracking trivial residuals.
  s0 = c0;
  [s0, s1] = quickTwoSum(c0, c1);
  if (s1 !== 0) {
    [s1, s2] = quickTwoSum(s1, c2);
    if (s2 !== 0) {
      [s2, s3] = quickTwoSum(s2, c3);
      if (s3 !== 0) s3 += c4;
      else         s2 += c4;
    } else {
      [s1, s2] = quickTwoSum(s1, c3);
      if (s2 !== 0) [s2, s3] = quickTwoSum(s2, c4);
      else          [s1, s2] = quickTwoSum(s1, c4);
    }
  } else {
    [s0, s1] = quickTwoSum(s0, c2);
    if (s1 !== 0) {
      [s1, s2] = quickTwoSum(s1, c3);
      if (s2 !== 0) [s2, s3] = quickTwoSum(s2, c4);
      else          [s1, s2] = quickTwoSum(s1, c4);
    } else {
      [s0, s1] = quickTwoSum(s0, c3);
      if (s1 !== 0) [s1, s2] = quickTwoSum(s1, c4);
      else          [s0, s1] = quickTwoSum(s0, c4);
    }
  }
  out[0] = s0; out[1] = s1; out[2] = s2; out[3] = s3;
}

// ---------- Constructors ----------

export function qdFromNumber(x) {
  return Float64Array.of(x, 0, 0, 0);
}

export function qdFromDD(hi, lo) {
  return Float64Array.of(hi, lo, 0, 0);
}

// 10^n as QD via square-and-multiply.
export function qdPow10(n) {
  if (n === 0) return qdFromNumber(1);
  let neg = n < 0;
  n = Math.abs(n);
  let base = qdFromNumber(10);
  let result = qdFromNumber(1);
  while (n > 0) {
    if (n & 1) result = qdMul(result, base);
    n >>>= 1;
    if (n > 0) base = qdMul(base, base);
  }
  return neg ? qdDiv(qdFromNumber(1), result) : result;
}

// Parse a decimal string into a QD. Builds digit-by-digit through QD math
// so the result is accurate to QD precision (sub-1e-60 relative).
export function qdFromString(s) {
  let i = 0;
  let neg = false;
  if (s[i] === '+' || s[i] === '-') { neg = s[i] === '-'; i++; }
  let intPart = qdFromNumber(0);
  while (i < s.length && s[i] >= '0' && s[i] <= '9') {
    intPart = qdMul(intPart, qdFromNumber(10));
    intPart = qdAdd(intPart, qdFromNumber(s.charCodeAt(i) - 48));
    i++;
  }
  let result = intPart;
  if (s[i] === '.') {
    i++;
    let frac = qdFromNumber(0);
    let scale = qdFromNumber(1);
    while (i < s.length && s[i] >= '0' && s[i] <= '9') {
      scale = qdMul(scale, qdFromNumber(10));
      frac = qdMul(frac, qdFromNumber(10));
      frac = qdAdd(frac, qdFromNumber(s.charCodeAt(i) - 48));
      i++;
    }
    frac = qdDiv(frac, scale);
    result = qdAdd(intPart, frac);
  }
  if (s[i] === 'e' || s[i] === 'E') {
    i++;
    let expSign = 1;
    if (s[i] === '+') i++;
    else if (s[i] === '-') { expSign = -1; i++; }
    let exp = 0;
    while (i < s.length && s[i] >= '0' && s[i] <= '9') {
      exp = exp * 10 + (s.charCodeAt(i) - 48);
      i++;
    }
    exp *= expSign;
    if (exp !== 0) result = qdMul(result, qdPow10(exp));
  }
  return neg ? qdNeg(result) : result;
}

// ---------- Arithmetic ----------

export function qdNeg(a) {
  return Float64Array.of(-a[0], -a[1], -a[2], -a[3]);
}

// qdAdd: sloppy version from libqd qd_inline.h:sloppy_add. Ten twoSums plus
// a renormalisation. Roughly 80 flops.
export function qdAdd(a, b) {
  let [s0, t0] = twoSum(a[0], b[0]);
  let [s1, t1] = twoSum(a[1], b[1]);
  let [s2, t2] = twoSum(a[2], b[2]);
  let [s3, t3] = twoSum(a[3], b[3]);

  // s1 += t0
  [s1, t0] = twoSum(s1, t0);
  // three-sum (s2, t0, t1)
  [s2, t0, t1] = threeSum(s2, t0, t1);
  // three-sum2 (s3, t0, t2) — drops third return because it's below precision
  [s3, t0]     = threeSum2(s3, t0, t2);
  t0 = t0 + t1 + t3;

  const out = new Float64Array(4);
  renorm5(s0, s1, s2, s3, t0, out);
  return out;
}

export function qdSub(a, b) {
  return qdAdd(a, qdNeg(b));
}

// qdMul: sloppy multiply, libqd qd_inline.h:sloppy_mul. ~120 flops.
export function qdMul(a, b) {
  // Six twoProds for a[0..2] × b[0..2].
  let [p0, q0] = twoProd(a[0], b[0]);
  let [p1, q1] = twoProd(a[0], b[1]);
  let [p2, q2] = twoProd(a[1], b[0]);
  let [p3, q3] = twoProd(a[0], b[2]);
  let [p4, q4] = twoProd(a[1], b[1]);
  let [p5, q5] = twoProd(a[2], b[0]);

  // three-sum on (p1, p2, q0)
  [p1, p2, q0] = threeSum(p1, p2, q0);

  // Six-three sum: (p2, q1, q2) and (p3, p4, p5) → (s0, s1, s2)
  [p2, q1, q2] = threeSum(p2, q1, q2);
  [p3, p4, p5] = threeSum(p3, p4, p5);

  let [s0, t0] = twoSum(p2, p3);
  let [s1, t1] = twoSum(q1, p4);
  let s2 = q2 + p5;
  [s1, t0] = twoSum(s1, t0);
  s2 += (t0 + t1);

  // O(eps^3) terms — sum the smallest contributions in plain f64.
  s1 += a[0] * b[3] + a[1] * b[2] + a[2] * b[1] + a[3] * b[0]
      + q0 + q3 + q4 + q5;

  const out = new Float64Array(4);
  renorm5(p0, p1, s0, s1, s2, out);
  return out;
}

// qdSqr: exploit a*a's symmetry to halve cross-term count vs qdMul. Direct
// port of libqd qd_inline.h:sloppy_sqr — same accuracy as qdMul(a, a) but
// roughly 30% fewer flops.
export function qdSqr(a) {
  let [p0, q0] = twoSqr(a[0]);
  let [p1, q1] = twoProd(2 * a[0], a[1]);
  let [p2, q2] = twoProd(2 * a[0], a[2]);
  let [p3, q3] = twoSqr(a[1]);

  let t0, t1;

  // Mix p1 with q0
  [p1, q0] = twoSum(q0, p1);

  // Now (q0, q1) and (p2, p3)
  [q0, q1] = twoSum(q0, q1);
  [p2, p3] = twoSum(p2, p3);

  // Combine into 4 components
  let s0, s1;
  [s0, t0] = twoSum(q0, p2);
  [s1, t1] = twoSum(q1, p3);

  [s1, t0] = twoSum(s1, t0);
  t0 = t0 + t1;

  [s1, t0] = quickTwoSum(s1, t0);
  [p2, t1] = quickTwoSum(s0, s1);
  [p3, q0] = quickTwoSum(t1, t0);

  // O(eps^3) cross terms: 2·a0·a3 and 2·a1·a2.
  let p4 = 2 * a[0] * a[3];
  let p5 = 2 * a[1] * a[2];

  [p4, p5] = twoSum(p4, p5);
  [q2, q3] = twoSum(q2, q3);

  [t0, t1] = twoSum(p4, q2);
  t1 = t1 + p5 + q3;

  [p3, p4] = twoSum(p3, t0);
  p4 = p4 + q0 + t1;

  const out = new Float64Array(4);
  renorm5(p0, p1, p2, p3, p4, out);
  return out;
}

// qdDiv: Newton-Raphson divide. Initial f64 estimate, then 3 sloppy
// refinement iterations (each at QD precision). Reaches ~62 digits.
export function qdDiv(a, b) {
  let q0 = a[0] / b[0];
  let r = qdSub(a, qdMul(qdFromNumber(q0), b));

  let q1 = r[0] / b[0];
  r = qdSub(r, qdMul(qdFromNumber(q1), b));

  let q2 = r[0] / b[0];
  r = qdSub(r, qdMul(qdFromNumber(q2), b));

  let q3 = r[0] / b[0];

  const out = new Float64Array(4);
  renorm5(q0, q1, q2, q3, 0, out);
  return out;
}

// Multiply by 2^e (exact, no rounding error). Used by the perturbation
// inner loop where 2·z·w doubles a QD; doubling each component is bit-exact
// because f64 multiplication by a power-of-2 just shifts the exponent field.
export function qdMulPow2(a, e) {
  const f = Math.pow(2, e);
  return Float64Array.of(a[0] * f, a[1] * f, a[2] * f, a[3] * f);
}

// ---------- Conversions / utilities ----------

export function qdToNumber(a) {
  return a[0] + a[1] + a[2] + a[3];
}

export function qdToString(a) {
  return qdToNumber(a).toExponential(15);
}

// Project to DD-f64 (top two components). Use when arithmetic only needs
// 31-digit precision — saves the per-op cost of carrying the lower halves.
export function qdToDD(a) {
  return [a[0], a[1]];
}
