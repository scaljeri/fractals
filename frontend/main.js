import Decimal from 'https://esm.sh/decimal.js@10';
import { pickSeedSource } from './seed-select.js';
// Precision chain (deepest is the wall):
//   - View center in Decimal: 60 digits (~10^55) — navigation precision.
//   - Reference orbit in JS-DD: ~31 digits — iteration precision inside the worker.
//   - GPU shader TDXR-f32: 21-digit mantissa × i32 exponent range. Effectively
//     unbounded zoom magnitude; the 21-digit precision is what pixels actually see.
// Navigation works at 60 digits; rendering quality degrades past ~10^28 where
// the orbit iteration precision becomes the limit.
Decimal.set({ precision: 60 });

const WGSL = /* wgsl */ `
// TDXR: triple-float mantissa + int32 exponent (floatexp-style) for unbounded zoom range.
// Scale and delta_center share one frame-wide exponent; each pixel's w tracks its own
// exponent and rescales per step. This is the core trick every deep-zoom renderer uses
// (rust-fractal, fraktaler-3, Fractalshades, davidbau GpuAdaptive all converge on it).
struct Uniforms {
  resolution: vec2<f32>,   // offset 0
  _pad0: vec2<f32>,
  scale_m: vec3<f32>,      // offset 16 — TD mantissa of view.scale
  frame_exp: i32,          // offset 28 — shared exponent for scale_m, delta_re_m, delta_im_m
  delta_re_m: vec3<f32>,   // offset 32 — TD mantissa of (view - ref).re
  _pad2: f32,
  delta_im_m: vec3<f32>,   // offset 48 — TD mantissa of (view - ref).im
  _pad3: f32,
  orbit_len: u32,          // offset 64
  max_iter: u32,
  // mode: 0 = perturbation (TD-f32 + reference orbit, deep zoom),
  //       1 = direct (f32 z = z²+c, shallow zoom). At shallow zoom direct
  //       is simpler/cheaper because there's no orbit-worker round trip.
  mode: u32,               // offset 72
  palette_offset: f32,     // offset 76 — zoom-coupled phase shift (palette rotation)
  // IQ cosine palette parameters: colour(t) = a + b * cos(2π(c·t + d))
  palette_a: vec3<f32>,    // offset 80
  _pad5: f32,
  palette_b: vec3<f32>,    // offset 96
  _pad6: f32,
  palette_c: vec3<f32>,    // offset 112
  _pad7: f32,
  palette_d: vec3<f32>,    // offset 128
  _pad8: f32,
  // kind: 0 = Mandelbrot (z₀ = 0, c per pixel),
  //       1 = Julia (z₀ per pixel, c = julia_c fixed).
  // The iteration rule z := z² + c is identical; what differs is which
  // parameter varies per pixel and (for perturbation) whether the +δc
  // term applies — for Julia δc = 0 since c is identical for every pixel.
  // Layout: scalars only to keep alignment trivial (4-byte). Struct total
  // ends on a 16-byte boundary so the UBO buffer is 176 bytes.
  kind: u32,               // offset 144
  _pad9a: u32,             // offset 148
  julia_re: f32,           // offset 152 — re(julia_c) for Julia mode
  julia_im: f32,           // offset 156 — im(julia_c) for Julia mode
  escape_radius_sq: f32,   // offset 160 — bailout², user-configurable (default 65536 = 256²)
  _pad9c: f32,             // offset 164
  _pad9d: f32,             // offset 168
  _pad9e: f32,             // offset 172
};

@group(0) @binding(0) var<uniform> u: Uniforms;
// Reference orbit: 6 f32 per iteration — [re.hi, re.mid, re.lo, im.hi, im.mid, im.lo].
// |Z_n| stays bounded (< escape radius 256) so the orbit lives at exponent 0 always.
@group(0) @binding(1) var<storage, read> orbit: array<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  return vec4<f32>(p[vi], 0.0, 1.0);
}

// IQ cosine palette — parameters come in via uniforms so the browser UI can swap
// presets without recompiling the shader. See PALETTES in main.js for the set.
fn palette(t: f32) -> vec3<f32> {
  return u.palette_a + u.palette_b * cos(6.28318530718 * (u.palette_c * t + u.palette_d));
}

// ---------- Exact building blocks ----------

fn two_sum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  let bb = s - a;
  return vec2<f32>(s, (a - (s - bb)) + (b - bb));
}

fn two_prod(a: f32, b: f32) -> vec2<f32> {
  let p = a * b;
  return vec2<f32>(p, fma(a, b, -p));
}

// ---------- Triple-float (TD) arithmetic on vec3<f32> ----------
// Value (a, b, c) with true value ≈ a+b+c — gives ~21 decimal digits of precision.

fn renorm3(a: f32, b: f32, c: f32) -> vec3<f32> {
  let s1 = two_sum(b, c);
  let t1 = two_sum(a, s1.x);
  let t2 = two_sum(t1.y, s1.y);
  return vec3<f32>(t1.x, t2.x, t2.y);
}

fn td_add(a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
  let sh = two_sum(a.x, b.x);
  let sm = two_sum(a.y, b.y);
  let sl = a.z + b.z;
  let m  = two_sum(sh.y, sm.x);
  let l  = sm.y + sl + m.y;
  return renorm3(sh.x, m.x, l);
}

fn td_sub(a: vec3<f32>, b: vec3<f32>) -> vec3<f32> { return td_add(a, -b); }

fn td_mul(a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
  let p00 = two_prod(a.x, b.x);
  let p01 = two_prod(a.x, b.y);
  let p10 = two_prod(a.y, b.x);
  let p02 = a.x * b.z;
  let p20 = a.z * b.x;
  let p11 = a.y * b.y;
  let m1 = two_sum(p00.y, p01.x);
  let m2 = two_sum(m1.x, p10.x);
  let l  = m1.y + m2.y + p01.y + p10.y + p02 + p20 + p11;
  return renorm3(p00.x, m2.x, l);
}

fn td_mul_f32(a: vec3<f32>, b: f32) -> vec3<f32> {
  let p0 = two_prod(a.x, b);
  let p1 = two_prod(a.y, b);
  let p2 = a.z * b;
  let m  = two_sum(p0.y, p1.x);
  let l  = m.y + p1.y + p2;
  return renorm3(p0.x, m.x, l);
}

fn td_dbl(a: vec3<f32>) -> vec3<f32> { return a + a; }

// Scale a TD value by 2^e (exact: each f32 component's exponent bit bumps by e).
// If e ≤ -126, component underflows to 0 — fine, means the value is negligible
// relative to anything at a higher exponent.
fn td_ldexp(a: vec3<f32>, e: i32) -> vec3<f32> {
  return vec3<f32>(ldexp(a.x, e), ldexp(a.y, e), ldexp(a.z, e));
}

// ---------- TD complex ----------

struct TdC { re: vec3<f32>, im: vec3<f32> };

fn tdc_add(a: TdC, b: TdC) -> TdC {
  return TdC(td_add(a.re, b.re), td_add(a.im, b.im));
}

fn load_orbit(i: u32) -> TdC {
  let b = i * 6u;
  return TdC(
    vec3<f32>(orbit[b], orbit[b + 1u], orbit[b + 2u]),
    vec3<f32>(orbit[b + 3u], orbit[b + 4u], orbit[b + 5u]),
  );
}

// Pick the exponent that normalises a TD complex mantissa into |m| ∈ [1, 2).
// Returns 0 if both components are essentially zero (caller keeps old exp).
fn td_peak_exp(re: vec3<f32>, im: vec3<f32>) -> i32 {
  let peak = max(abs(re.x), abs(im.x));
  if (peak < 1e-30) { return 0; }
  return i32(floor(log2(peak)));
}

// ---------- Direct iteration ----------
// Plain z = z² + c in f32. No reference orbit. Per-pixel c reconstructed
// from the same uniforms perturbation uses (delta_re_m + per-pixel offset,
// shifted by frame_exp). Used when zoom is shallow enough that f32 precision
// (~7 digits) covers the pixel size — past that the pertubation path takes
// over, with its TD-f32 mantissa carrying ~21 digits.
fn fs_direct(uv: vec2<f32>, aspect: f32) -> vec4<f32> {
  let aspect_scale_m = td_mul_f32(u.scale_m, aspect);
  let pxl_dx_m = td_mul_f32(aspect_scale_m, uv.x);
  let pxl_dy_m = td_mul_f32(u.scale_m, uv.y);
  // In direct mode, delta_re_m carries view.cx (mantissa form); add the
  // per-pixel offset to get the canvas-pixel complex coord, then reconstruct at exp 0.
  let pxl_re_m = td_add(u.delta_re_m, pxl_dx_m);
  let pxl_im_m = td_add(u.delta_im_m, pxl_dy_m);
  let pxl_re = ldexp(pxl_re_m.x, u.frame_exp) + ldexp(pxl_re_m.y, u.frame_exp) + ldexp(pxl_re_m.z, u.frame_exp);
  let pxl_im = ldexp(pxl_im_m.x, u.frame_exp) + ldexp(pxl_im_m.y, u.frame_exp) + ldexp(pxl_im_m.z, u.frame_exp);

  // Mandelbrot: z₀ = 0, c = canvas pixel. Julia: z₀ = canvas pixel, c = u.julia_c.
  // The iteration body is identical — both compute z := z² + c.
  var cx: f32;
  var cy: f32;
  var zr: f32;
  var zi: f32;
  if (u.kind == 1u) {
    zr = pxl_re; zi = pxl_im;
    cx = u.julia_re; cy = u.julia_im;
  } else {
    zr = 0.0; zi = 0.0;
    cx = pxl_re; cy = pxl_im;
  }
  var i: u32 = 0u;
  var escaped = false;
  loop {
    if (i >= u.max_iter) { break; }
    let zz = zr * zr + zi * zi;
    if (zz > u.escape_radius_sq) { escaped = true; break; }
    let nzr = zr * zr - zi * zi + cx;
    let nzi = 2.0 * zr * zi + cy;
    zr = nzr; zi = nzi;
    i = i + 1u;
  }
  if (!escaped) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let zz = zr * zr + zi * zi;
  let smooth_i = f32(i) - log2(log2(zz)) + 4.0;
  let t = log2(smooth_i + 1.0) * 4.0 + u.palette_offset;
  return vec4<f32>(palette(t), 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let aspect = u.resolution.x / u.resolution.y;
  let uv = vec2<f32>(
    (pos.x / u.resolution.x) * 2.0 - 1.0,
    1.0 - (pos.y / u.resolution.y) * 2.0,
  );

  if (u.mode == 1u) { return fs_direct(uv, aspect); }

  // Per-pixel δ in mantissa form at u.frame_exp:
  //   scale_m · uv.x · aspect + delta_re_m,  scale_m · uv.y + delta_im_m
  // uv.x and aspect are O(1) so mantissa magnitudes stay reasonable.
  let aspect_scale_m = td_mul_f32(u.scale_m, aspect);
  let pxl_dx_m = td_mul_f32(aspect_scale_m, uv.x);
  let pxl_dy_m = td_mul_f32(u.scale_m, uv.y);
  let delta_re_m = td_add(u.delta_re_m, pxl_dx_m);
  let delta_im_m = td_add(u.delta_im_m, pxl_dy_m);
  let delta_exp  = u.frame_exp;

  // Init for w:
  //   Mandelbrot: w₀ = 0 (both pixel and ref orbits start at 0).
  //   Julia:      w₀ = δz (pixel orbit starts at view-pixel; ref at view-centre).
  // w_exp starts aligned with delta so the first iterate sits naturally at
  // the right scale with no alignment shift.
  var w_re: vec3<f32>;
  var w_im: vec3<f32>;
  if (u.kind == 1u) {
    w_re = delta_re_m;
    w_im = delta_im_m;
  } else {
    w_re = vec3<f32>(0.0);
    w_im = vec3<f32>(0.0);
  }
  var w_exp: i32 = delta_exp;
  var ref_i: u32 = 0u;
  var actual_i: u32 = 0u;
  var escaped = false;
  var Zfinal_re: f32 = 0.0;
  var Zfinal_im: f32 = 0.0;

  loop {
    if (actual_i >= u.max_iter) { break; }
    if (ref_i >= u.orbit_len) { break; }

    let z = load_orbit(ref_i);

    // Reconstruct w at exponent 0 (only hi-part precision needed — this is just for
    // escape/rebase checks, not for the iteration itself).
    let w_re_actual = ldexp(w_re.x, w_exp);
    let w_im_actual = ldexp(w_im.x, w_exp);
    let Z_re = z.re.x + w_re_actual;
    let Z_im = z.im.x + w_im_actual;

    let zz = Z_re * Z_re + Z_im * Z_im;
    if (zz > u.escape_radius_sq) {
      escaped = true;
      Zfinal_re = Z_re;
      Zfinal_im = Z_im;
      break;
    }

    // Rebasing (Zhuoran preemptive + forced at end of orbit):
    //   if |Z+w| < 2·|w|, continue iterating as if w were the "new Z" from ref 0.
    // Implemented by: set w = Z+w (in mantissa form, new exp = 0), reset ref_i.
    let z_norm = max(abs(Z_re), abs(Z_im));
    let w_norm = max(abs(w_re_actual), abs(w_im_actual));
    let at_end = (ref_i + 1u >= u.orbit_len);
    let zhuoran = (ref_i > 0u && z_norm < 2.0 * w_norm);
    if (at_end || zhuoran) {
      let w_re_at0 = td_ldexp(w_re, w_exp);
      let w_im_at0 = td_ldexp(w_im, w_exp);
      w_re = td_add(z.re, w_re_at0);
      w_im = td_add(z.im, w_im_at0);
      // After rebase, w should be (z_actual − Z[0]) in the new reference frame.
      // Mandelbrot has Z[0] = 0 so the subtract is a no-op (skipped). Julia has
      // Z[0] = z_ref, so omitting this subtract leaks z_ref into w every rebase
      // and degrades precision after just a few cycles.
      if (u.kind == 1u) {
        let z0 = load_orbit(0u);
        w_re = td_sub(w_re, z0.re);
        w_im = td_sub(w_im, z0.im);
      }
      w_exp = 0;
      ref_i = 0u;
      continue;
    }

    // W_{n+1} = 2·z·w + w² + δ, all computed in mantissa form at a common exponent.
    // Natural exponents:
    //   2·z·w   → w_exp      (z is unit-scale)
    //   w²      → 2·w_exp    (typically more negative, often underflows to 0)
    //   δ       → delta_exp  (frame-constant)
    // Align to target_exp = max of the three (so all shifts are ≤ 0 — underflow-safe).
    let two_zw_re = td_mul(z.re, td_dbl(w_re)) - td_mul(z.im, td_dbl(w_im));
    let two_zw_im = td_mul(z.re, td_dbl(w_im)) + td_mul(z.im, td_dbl(w_re));
    let w_sq_re = td_sub(td_mul(w_re, w_re), td_mul(w_im, w_im));
    let w_sq_im = td_dbl(td_mul(w_re, w_im));

    let target_exp = max(max(w_exp, 2 * w_exp), delta_exp);
    let term1_re = td_ldexp(two_zw_re, w_exp - target_exp);
    let term1_im = td_ldexp(two_zw_im, w_exp - target_exp);
    let term2_re = td_ldexp(w_sq_re, 2 * w_exp - target_exp);
    let term2_im = td_ldexp(w_sq_im, 2 * w_exp - target_exp);

    // Mandelbrot: w_{n+1} = 2zw + w² + δc (δc per pixel).
    // Julia:      w_{n+1} = 2zw + w²     (δc = 0, c is identical for ref & pixel).
    var new_w_re: vec3<f32>;
    var new_w_im: vec3<f32>;
    if (u.kind == 1u) {
      new_w_re = td_add(term1_re, term2_re);
      new_w_im = td_add(term1_im, term2_im);
    } else {
      let term3_re = td_ldexp(delta_re_m, delta_exp - target_exp);
      let term3_im = td_ldexp(delta_im_m, delta_exp - target_exp);
      new_w_re = td_add(td_add(term1_re, term2_re), term3_re);
      new_w_im = td_add(td_add(term1_im, term2_im), term3_im);
    }
    var new_w_exp = target_exp;

    // Renormalise so mantissa peak sits in [1, 2). No-op when already normalised.
    let shift = td_peak_exp(new_w_re, new_w_im);
    if (shift != 0) {
      new_w_re = td_ldexp(new_w_re, -shift);
      new_w_im = td_ldexp(new_w_im, -shift);
      new_w_exp = new_w_exp + shift;
    }

    w_re = new_w_re;
    w_im = new_w_im;
    w_exp = new_w_exp;
    ref_i = ref_i + 1u;
    actual_i = actual_i + 1u;
  }

  if (!escaped) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let zz = Zfinal_re * Zfinal_re + Zfinal_im * Zfinal_im;
  let smooth_i = f32(actual_i) - log2(log2(zz)) + 4.0;
  // Palette rotation: offset shifts the cosine phase in sync with zoom depth,
  // so a given fractal feature keeps a similar colour as iter counts grow.
  let t = log2(smooth_i + 1.0) * 4.0 + u.palette_offset;
  return vec4<f32>(palette(t), 1.0);
}
`;

const canvas = document.getElementById('canvas');
const selectionEl = document.getElementById('selection');
const zoomMantissaInput = document.getElementById('zoom-mantissa');
const zoomExpInput = document.getElementById('zoom-exp');
const zoomSuffix = document.getElementById('zoom-suffix');
const iterEl = document.getElementById('iter');
const resetBtn = document.getElementById('reset');
const errorEl = document.getElementById('error');
const paletteEl = document.getElementById('palette');
// Quality-tier render system. The HQ button used to live at the bottom-right
// as an explicit "render at maximum quality" CTA. Replaced by the `h`
// keyboard shortcut which bumps a quality tier (0 → 1 → 2 → 3); each tier
// triggers progressively more expensive renders at the current view. Reset
// to 0 on any view change (click/zoom/pan/preset/typed-zoom).
const MAX_QUALITY_LEVEL = 3;
let qualityLevel = 0;

// Preset locations curated from the deep-zoom community.
// Sources: mandelbrot.neocities.org/gallery, MROB Mu-Ency, paulbourke.net,
// fractaljourney.blogspot.com, the Misiurewicz point M_{23,2} from
// users.math.yale.edu/.../Mis.html.
//
// `scale` is the value `view.scale` should take (= HOME.scale / zoomFactor,
// so a `scale` of 5.9e-3 corresponds to zoom ≈ 220×). Each entry's `cx`/`cy`
// are decimal strings parsed via `new Decimal(...)` to preserve full
// precision past f64.
const PRESETS = {
  'seahorse-valley':       { name: 'Seahorse Valley',       cx: '-0.7451968299999999',     cy: '0.10186988500000009',     scale: 5.9049e-3 },
  'elephant-valley':       { name: 'Elephant Valley',       cx: '0.27205033514905763',    cy: '0.006118038612346085',    scale: 2.4031526709817415e-3 },
  'triple-spiral-valley':  { name: 'Triple Spiral Valley',  cx: '-0.0875937321188787',    cy: '0.6550902802386774',      scale: 2.216006624297726e-3 },
  'seahorse-horn':         { name: "Seahorse's Horn",       cx: '-1.25066',                cy: '0.02012',                 scale: 2.2824856349263888e-4 },
  'elephant-trunk':        { name: "Elephant's Trunk",      cx: '0.2777323864244548',     cy: '0.0073446267400780795',   scale: 1.1129292811671919e-5 },
  'line-zero':             { name: 'Line Zero',             cx: '-1.7498024609283975',    cy: '0',                       scale: 4.9722957431449e-8 },
  'carousel':              { name: 'Carousel',              cx: '0.35787121400640803',    cy: '-0.10813970113434704',    scale: 9.68059489050412e-9 },
  'turbulence':            { name: 'Turbulence',            cx: '-0.5360670633819427',    cy: '-0.5255257785409202',     scale: 5.1991824685514734e-9 },
  'lsd':                   { name: 'LSD',                   cx: '-0.22163951090127437',   cy: '-0.7115537848292754',     scale: 1.3206745765135308e-9 },
  'sprites':               { name: 'Sprites',               cx: '-1.1541266482218018',    cy: '0.30877492767191256',     scale: 1.696818191471427e-11 },
  'wormhole':              { name: 'Wormhole',              cx: '-1.7397156556930304',    cy: '-9.157504622931403e-8',   scale: 5.205901380161776e-11 },
  'praline':               { name: 'Praline',               cx: '-1.7397082221332807',    cy: '-4.768199679090003e-6',   scale: 1.560355187926224e-11 },
  'elephants-eye':         { name: "Elephant's Eye",        cx: '0.33698444648740383',    cy: '0.048778219678026105',    scale: 7.178441004711243e-12 },
  'galaxies':              { name: 'Galaxies',              cx: '0.452721018749286',      cy: '0.39649427698014',        scale: 1.1859210000000005e-13 },
  'tante-renate':          { name: "Tante Renate's spot",   cx: '-0.7746806106269039',    cy: '-0.1374168856037867',     scale: 1.506043553756164e-12 },
  'm23-2':                 { name: 'Misiurewicz M₂₃,₂',     cx: '-0.77568377',             cy: '0.13646737',              scale: 5e-4 },

  // ---- Julia presets: each is a `c` value that produces a famous K_c. ----
  // Selecting one switches kind→julia, updates view.juliaC, and resets the
  // viewport to the per-kind HOME so the whole set is visible. Then zoom in
  // by clicking — the deep-zoom engine handles it identically to Mandelbrot.
  'julia-basilica':        { name: 'Basilica (c = −1)',                kind: 'julia', juliaRe: '-1.0',         juliaIm: '0.0' },
  'julia-san-marco':       { name: 'San Marco (c = −0.75)',            kind: 'julia', juliaRe: '-0.75',        juliaIm: '0.0' },
  'julia-dendrite':        { name: 'Dendrite (c = i)',                 kind: 'julia', juliaRe: '0.0',          juliaIm: '1.0' },
  'julia-rabbit':          { name: "Douady's Rabbit (period 3)",       kind: 'julia', juliaRe: '-0.122',       juliaIm: '0.745' },
  'julia-cauliflower':     { name: 'Cauliflower (rabbit cousin)',      kind: 'julia', juliaRe: '-0.7',         juliaIm: '0.27015' },
  'julia-siegel':          { name: 'Siegel disk',                      kind: 'julia', juliaRe: '-0.391',       juliaIm: '-0.587' },
  'julia-spirals':         { name: 'Galaxy spirals',                   kind: 'julia', juliaRe: '-0.835',       juliaIm: '-0.2321' },
  'julia-frost':           { name: 'Frost (deep dendrite)',            kind: 'julia', juliaRe: '-0.74543',     juliaIm: '0.11301' },
  'julia-lace':            { name: 'Lace',                             kind: 'julia', juliaRe: '-0.54',        juliaIm: '0.54' },
  'julia-tendrils':        { name: 'Tendrils',                         kind: 'julia', juliaRe: '0.285',        juliaIm: '0.485' },
  'julia-storm':           { name: 'Storm',                            kind: 'julia', juliaRe: '-0.7269',      juliaIm: '0.1889' },
  'julia-airplane':        { name: 'Airplane (period 3 real)',         kind: 'julia', juliaRe: '-1.7549',      juliaIm: '0.0' },
  'julia-icefractal':      { name: 'Lacy spirals (icefractal pick)',   kind: 'julia', juliaRe: '-0.38',        juliaIm: '0.61' },
};
const presetSelect = document.getElementById('presets');
// Render-width override. "auto" = zoom-aware default (full canvas at shallow
// zoom, progressively coarser as zoom deepens, see effectiveRenderWidth).
// Numeric value = force renders at that width regardless of zoom — useful
// when the user wants a fast preview at very deep zoom or specifically wants
// to control quality. Persisted in localStorage.
const renderWidthSelect = document.getElementById('render-width');
const RENDER_WIDTH_KEY = 'renderWidthOverride';
{
  const saved = localStorage.getItem(RENDER_WIDTH_KEY);
  if (saved && renderWidthSelect) {
    const opt = [...renderWidthSelect.options].find(o => o.value === saved);
    if (opt) renderWidthSelect.value = saved;
  }
}
if (renderWidthSelect) {
  renderWidthSelect.addEventListener('change', () => {
    localStorage.setItem(RENDER_WIDTH_KEY, renderWidthSelect.value);
    console.log(`[render-width] override set to '${renderWidthSelect.value}' — next render will use it`);
    if (typeof requestRender === 'function') requestRender();
  });
}

// Auto-zoom: a self-pacing zoom-loop toward the canvas centre. Each step
// waits for the previous render to finish (via the progressiveActive flag)
// before firing the next, so at deep zoom where renders take minutes the
// auto-zoom just zooms more slowly — never queues up faster than the
// renderer can keep up.
//
// Why centre, not e.g. the coord-marker target? The user has already
// navigated to the spot they care about (it's the canvas centre); auto-zoom
// is the "keep going deeper" knob, not a "fly to here" knob.
const autoZoomBtn = document.getElementById('auto-zoom');
const AUTO_ZOOM_INTERVAL_MS = 500;
let autoZoomActive = false;
let autoZoomTimerId = null;

function startAutoZoom() {
  if (autoZoomActive) return;
  autoZoomActive = true;
  if (autoZoomBtn) {
    autoZoomBtn.textContent = '⏸ auto';
    autoZoomBtn.classList.add('active');
  }
  console.log(`[auto-zoom] started — zooming toward canvas centre, will defer when progressiveActive`);
  scheduleNextAutoZoom();
}
function stopAutoZoom() {
  if (!autoZoomActive) return;
  autoZoomActive = false;
  if (autoZoomTimerId) { clearTimeout(autoZoomTimerId); autoZoomTimerId = null; }
  if (autoZoomBtn) {
    autoZoomBtn.textContent = '▶ auto';
    autoZoomBtn.classList.remove('active');
  }
  console.log(`[auto-zoom] stopped`);
}
function scheduleNextAutoZoom() {
  if (!autoZoomActive) return;
  autoZoomTimerId = setTimeout(() => {
    if (!autoZoomActive) return;
    if (progressiveActive || hqInFlight) {
      // Render in progress; check again soon. This is the "self-pacing"
      // mechanism — when renders take minutes the auto-zoom waits for them.
      scheduleNextAutoZoom();
      return;
    }
    if (typeof zoomAt !== 'function') return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) { scheduleNextAutoZoom(); return; }
    // Zoom at canvas centre with the same factor as a click. CSS preview
    // transform fires too, giving the user the same "instant zoom" feel.
    zoomAt(rect.width / 2, rect.height / 2, rect, CLICK_ZOOM);
    scheduleNextAutoZoom();
  }, AUTO_ZOOM_INTERVAL_MS);
}
if (autoZoomBtn) {
  autoZoomBtn.addEventListener('click', () => {
    if (autoZoomActive) stopAutoZoom();
    else startAutoZoom();
  });
}

// Preset dropdown handler. Just writes the preset's cx/cy into the re/im
// input fields and surfaces the coord-marker — does NOT change view.scale,
// view.cx, or view.cy and does NOT trigger a render. The user can see WHERE
// the preset would land in the current view (the marker projects onto the
// canvas if the point is in-viewport; otherwise the marker hides itself)
// and can decide whether to navigate there manually, click into that
// region, or hit the "go to" path some future iteration adds. Preset's
// `scale` is not consumed by this handler — it's metadata for a possible
// future "warp here" affordance.
if (presetSelect) {
  presetSelect.addEventListener('change', () => {
    const key = presetSelect.value;
    if (!key) return;
    const p = PRESETS[key];
    if (!p || p.kind === 'julia') {
      // Defensive: Julia keys aren't in this dropdown anymore, but ignore
      // anyway in case the option set drifts.
      console.warn(`[presets] '${key}' not a Mandelbrot preset — ignoring`);
      presetSelect.value = '';
      return;
    }
    console.log(`[presets] '${p.name}' centring viewport on cx=${p.cx} cy=${p.cy} (scale unchanged at ${view.scale.toExponential(2)}; preset's own scale ${p.scale.toExponential(2)} ignored)`);
    // Pan the viewport so the preset's coordinate is at the centre. Keep
    // the user's current zoom — they can step in with space / click /
    // auto-zoom from the new vantage point. Quality tier resets to 0 since
    // the view changed.
    qualityLevel = 0;
    view.cx = new Decimal(p.cx);
    view.cy = new Decimal(p.cy);
    if (coordReInput) coordReInput.value = p.cx;
    if (coordImInput) coordImInput.value = p.cy;
    // NOTE: presetSelect.value is intentionally NOT reset — the dropdown
    // stays on the selected preset's name as a label of "this is the spot
    // I navigated to". If the user later pans / types new coords, the
    // dropdown becomes a stale label but is harmless.
    if (typeof updateHUD === 'function') updateHUD();
    if (typeof pokeCoordMarker === 'function') pokeCoordMarker();
    if (typeof progressiveRender === 'function') progressiveRender();
  });
}

// Julia preset dropdown — separate from the Mandelbrot presets so the user
// never has to scroll past one set to reach the other. Selecting an entry
// applies the c value, resets the viewport to Julia's HOME (so the whole K_c
// is in frame), and invalidates the orbit cache.
const juliaPresetSelect = document.getElementById('julia-presets');
if (juliaPresetSelect) {
  juliaPresetSelect.addEventListener('change', () => {
    const key = juliaPresetSelect.value;
    if (!key) return;
    const p = PRESETS[key];
    if (!p || p.kind !== 'julia') {
      console.warn(`[presets] '${key}' not a Julia preset — ignoring`);
      juliaPresetSelect.value = '';
      return;
    }
    console.log(`[presets] julia '${p.name}' c=${p.juliaRe}+${p.juliaIm}i (viewport reset to home, orbit cache invalidated)`);
    view.juliaC = { re: parseFloat(p.juliaRe), im: parseFloat(p.juliaIm) };
    const jhome = HOME_BY_KIND.julia;
    view.cx = jhome.cx; view.cy = jhome.cy; view.scale = jhome.scale;
    qualityLevel = 0;
    invalidateOrbitCache();
    syncJuliaCInputs();
    if (typeof updatePickerMarker === 'function') updatePickerMarker();
    if (typeof updateOrbitForCurrentC === 'function') updateOrbitForCurrentC();
    if (typeof updateHUD === 'function') updateHUD();
    updateCoordInputsFromView();
    updateCoordMarker();
    if (typeof progressiveRender === 'function') progressiveRender();
  });
}

// IQ cosine palette presets: colour(t) = a + b * cos(2π(c·t + d)).
// Names here must match jetson/src/worker.py PALETTES so Jetson-rendered videos
// look identical to in-browser previews/recordings.
const PALETTES = {
  warm:     { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1.0, 1.0, 1.0], d: [0.00, 0.10, 0.20] },
  lava:     { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1.0, 0.7, 0.4], d: [0.00, 0.15, 0.20] },
  ocean:    { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1.0, 1.0, 1.0], d: [0.30, 0.20, 0.20] },
  electric: { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [2.0, 1.0, 0.0], d: [0.50, 0.20, 0.25] },
  rainbow:  { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1.0, 1.0, 1.0], d: [0.00, 0.33, 0.67] },
  // Ice — matches icefractal.com. Single slow gradient from dark navy at low
  // smooth-iter values up to bright white at high smooth-iter, with the phase
  // tuned so the typical t-range (≈4 → 40) maps cleanly to that arc. Tiny
  // frequency (0.014) means the palette barely starts a second cycle even
  // past 10⁶ iterations — visible boundary stays a single icy trail instead
  // of the rainbow banding that comes from c=1 palettes.
  //   cos(2π·(0.014·t + 0.44)) ranges from −1 at t≈4 → +1 at t≈40.
  //   at cos = −1: (a−b) = (0.00, 0.10, 0.30) — deep navy
  //   at cos = +1: (a+b) = (1.00, 1.00, 1.00) — pure white
  ice:      { a: [0.50, 0.55, 0.65], b: [0.50, 0.45, 0.35], c: [0.014, 0.014, 0.014], d: [0.44, 0.44, 0.44] },
};
function currentPalette() { return PALETTES[paletteEl.value] || PALETTES.warm; }

function fatal(msg) {
  errorEl.textContent = msg;
  errorEl.style.display = 'flex';
  throw new Error(msg);
}

if (!navigator.gpu) fatal('WebGPU is not supported in this browser. Try Safari 26+, Chrome, or Edge.');

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) fatal('No WebGPU adapter available.');
const device = await adapter.requestDevice();
const context = canvas.getContext('webgpu');
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({
  device, format, alphaMode: 'opaque',
  // TEXTURE_BINDING added so the CPU-phase block can `blitUpscale` from the
  // current swapchain into cpuBlitTexture before a canvas resize, preserving
  // the previous render's content as the seed for the new render. Without it,
  // shallow-GPU → deep-CPU transitions clear the swapchain to black on resize.
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
});

const module = device.createShaderModule({ code: WGSL });
const pipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module, entryPoint: 'vs' },
  fragment: { module, entryPoint: 'fs', targets: [{ format }] },
  primitive: { topology: 'triangle-list' },
});

// Blit-upscale pipeline: samples a smaller texture (cpuBlitTexture at phase
// resolution, e.g. 1/4 of canvas) onto the full-size swapchain with linear
// filtering. Used so the CPU phase loop doesn't have to resize the canvas
// drawing buffer (which would clear the swapchain to black mid-preview and
// destroy the click-zoom CSS transform's preview pixels).
const BLIT_WGSL = `
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) idx: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let xy = p[idx];
  var out: VOut;
  out.pos = vec4f(xy, 0.0, 1.0);
  // Map clip [-1, 1] → uv [0, 1]; flip y because canvas/textures use top-left origin.
  out.uv = vec2f(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5));
  return out;
}
@group(0) @binding(0) var t_blit: texture_2d<f32>;
@group(0) @binding(1) var s_blit: sampler;
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  return textureSample(t_blit, s_blit, in.uv);
}
`;
const blitModule = device.createShaderModule({ code: BLIT_WGSL });
const blitPipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module: blitModule, entryPoint: 'vs' },
  fragment: { module: blitModule, entryPoint: 'fs', targets: [{ format }] },
  primitive: { topology: 'triangle-list' },
});
const blitSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
let blitUpscaleSeq = 0;
function blitUpscale(srcTexture, displayTex) {
  const _seq = ++blitUpscaleSeq;
  // Sanity check — the closure-captured cpuBlitTexture might have been
  // destroyed by a phase-transition allocateNew, in which case createView()
  // throws. Log dimensions every call so the user trace shows whether
  // blitUpscale ran AND with what sizes.
  if (!srcTexture || !displayTex) {
    console.warn(`[blitUpscale #${_seq}] SKIP: src=${!!srcTexture} dst=${!!displayTex}`);
    return;
  }
  const bg = device.createBindGroup({
    layout: blitPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTexture.createView() },
      { binding: 1, resource: blitSampler },
    ],
  });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: displayTex.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'clear',                    // every frag overwrites; clear avoids "undefined contents" on freshly-acquired swap textures
      storeOp: 'store',
    }],
  });
  pass.setPipeline(blitPipeline);
  pass.setBindGroup(0, bg);
  pass.draw(3);
  pass.end();
  device.queue.submit([enc.finish()]);
  if (_seq % 10 === 1) {   // throttle — one log per 10 calls keeps trace readable
    console.log(`[blitUpscale #${_seq}] src=${srcTexture.width}×${srcTexture.height} → display=${displayTex.width}×${displayTex.height}`);
  }
}

const UBO_SIZE = 176;
const uniformBuffer = device.createBuffer({
  size: UBO_SIZE,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

// Reference orbit buffer: 6 × f32 per iteration (TD complex), up to MAX_ORBIT_LEN
const MAX_ORBIT_LEN = 50000;
const ORBIT_BYTES_PER_ITER = 24; // 6 × f32 = (re.hi, re.mid, re.lo, im.hi, im.mid, im.lo)
const orbitBuffer = device.createBuffer({
  size: MAX_ORBIT_LEN * ORBIT_BYTES_PER_ITER,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});

// ---------- DD arithmetic on pairs of f64 (JS side) ----------
// A DD value is represented as [hi, lo] where hi+lo is the true value (~31 digits).
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
function ddSub(a, b) { return ddAdd(a, [-b[0], -b[1]]); }
function ddMul(a, b) {
  const [p, err] = twoProd(a[0], b[0]);
  return quickTwoSum(p, err + (a[0] * b[1] + a[1] * b[0]));
}
function ddSqr(a) { return ddMul(a, a); }

// Complex DD as 4-tuple [reH, reL, imH, imL]
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

function cddMul(a, b) {
  const ar = [a[0], a[1]], ai = [a[2], a[3]];
  const br = [b[0], b[1]], bi = [b[2], b[3]];
  const arbr = ddMul(ar, br);
  const aibi = ddMul(ai, bi);
  const arbi = ddMul(ar, bi);
  const aibr = ddMul(ai, br);
  const re = ddSub(arbr, aibi);
  const im = ddAdd(arbi, aibr);
  return [re[0], re[1], im[0], im[1]];
}

// Convert a DD f64 pair to a TD f32 triple for GPU upload.
// Splits the f64 value (h+l) into three f32 components with ~21 decimal digits.
function ddToF32TD(h, l) {
  const a = Math.fround(h);
  const rem1 = (h - a) + l;
  const b = Math.fround(rem1);
  const rem2 = rem1 - b;
  const c = Math.fround(rem2);
  return [a, b, c];
}

// ---------- Arbitrary-precision I/O via decimal.js ----------
// View center is Decimal (60 digits). Everything downstream of a view-center
// read either stays in Decimal (freshness, delta computation) or converts
// at the boundary (TD-f32 for shader, DD for orbit iteration in the worker).

function decimalToDD(d) {
  // Best f64 approximation, then residual captured in a second f64.
  const hi = d.toNumber();
  const lo = d.minus(hi).toNumber();
  return [hi, lo];
}

// Decimal → QD-f64 (4 doubles, ~62 digits). Each component is the best f64
// approximation of the residual after the previous components, so the four
// components are non-overlapping and sum to the original Decimal value at
// QD precision. Returns a Float64Array so it can be transferred directly
// into the cpu-render-worker tile message.
function decimalToQD(d) {
  const a0 = d.toNumber();
  const rem1 = d.minus(a0);
  const a1 = rem1.toNumber();
  const rem2 = rem1.minus(a1);
  const a2 = rem2.toNumber();
  const rem3 = rem2.minus(a2);
  const a3 = rem3.toNumber();
  return Float64Array.of(a0, a1, a2, a3);
}

// Split a small Decimal into TD-f32 triple (three nested fround + residuals).
// Used for the delta and scale mantissas sent to the shader — where a small
// input doesn't need more than 21-digit precision anyway, but Decimal's
// 60-digit subtraction kept us accurate across the full zoom range.
function decimalToTD(d) {
  const a = Math.fround(d.toNumber());
  const rem1 = d.minus(a);
  const b = Math.fround(rem1.toNumber());
  const rem2 = rem1.minus(b);
  const c = Math.fround(rem2.toNumber());
  return [a, b, c];
}

function decimalToString(d, digits = 40) {
  return d.toPrecision(digits).replace(/\.?0+$/, '');
}

function parseDecimal(str) {
  // Returns a Decimal or null on invalid input.
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;
  try { return new Decimal(s); } catch { return null; }
}

const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: uniformBuffer } },
    { binding: 1, resource: { buffer: orbitBuffer } },
  ],
});

// View center stored as Decimal (60 digits) so navigation stays exact past
// the DD-pair ~10^28 ceiling. Scale stays as plain f64 — its exponent goes
// into the shader as an i32 (TDXR frame_exp), so the magnitude is unbounded
// even though the mantissa is a single f64.
// HOME is what `reset` returns to: scale 1.3 frames the whole M-set, and
// the center is the classic seahorse-valley target so the user lands on
// something visually interesting on first load. Matches the default
// re/im inputs in index.html.
// HOME-per-kind: when the user resets, they land on the canonical view for
// the active fractal. Mandelbrot starts on Misiurewicz M₂₃,₂; Julia starts
// centred on the origin (the natural |z| < 2 viewport for any K_c).
const HOME_BY_KIND = {
  mandelbrot: {
    cx: new Decimal('-0.743643887037151'),
    cy: new Decimal('0.131825904205330'),
    scale: 1.3,
  },
  julia: {
    cx: new Decimal('0'),
    cy: new Decimal('0'),
    scale: 1.5,
  },
};

// Active fractal kind. Parsed from the URL (?kind=julia&jre=...&jim=...) on
// boot. Julia-c lives on view because it's a per-render parameter the GPU
// shader, CPU kernel, and orbit worker all read directly.
const urlParams = new URLSearchParams(location.search);
const initialKind = urlParams.get('kind') === 'julia' ? 'julia' : 'mandelbrot';
const HOME = HOME_BY_KIND[initialKind];

// Parse Julia c from URL with a sane default. Default sits near the boundary
// between the main cardioid and the period-3 bulb (icefractal.com's picker
// lands here at a click) — produces the dense, lacy Julia image with paired
// spiral lobes that's the most visually-rich "default-looking" Julia. Override
// via ?jre=…&jim=… or via the c-inputs in the UI.
function parseJuliaC() {
  const jre = parseFloat(urlParams.get('jre'));
  const jim = parseFloat(urlParams.get('jim'));
  return {
    re: Number.isFinite(jre) ? jre : -0.38,
    im: Number.isFinite(jim) ? jim : 0.61,
  };
}

// Escape radius — the "bailout" beyond which the iteration is declared
// divergent. Standard choices: 2 (mathematical minimum for z²+c), 4, 16,
// 256 (our long-standing default — generous, gives smooth gradients in the
// outer halo). The shape of the set is unchanged; only the smooth-coloring
// shape near the boundary depends on this. Squared form (R²) stored so the
// shader does one compare instead of a sqrt per iter.
const DEFAULT_ESCAPE_RADIUS = 256;
function parseEscapeRadius() {
  const r = parseFloat(urlParams.get('esc'));
  if (!Number.isFinite(r) || r < 1) return DEFAULT_ESCAPE_RADIUS;
  return Math.min(1e6, r);
}

// User override for max iterations per pixel. null = use the zoom-adaptive
// computeMaxIter() default. Any finite positive integer (clamped to
// MAX_ORBIT_LEN) overrides the adaptive value. Override survives in the URL
// via ?iter=…
function parseMaxIterOverride() {
  const n = parseInt(urlParams.get('iter'), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

const view = {
  kind: initialKind,
  cx: HOME.cx,
  cy: HOME.cy,
  scale: HOME.scale,
  juliaC: parseJuliaC(),
  escapeRadius: parseEscapeRadius(),
  maxIterOverride: parseMaxIterOverride(),
};
console.log(`[boot] kind=${view.kind} home=${HOME.cx}+${HOME.cy}i scale=${HOME.scale}` + (view.kind === 'julia' ? ` juliaC=${view.juliaC.re}+${view.juliaC.im}i` : ''));
if (view.kind === 'julia') {
  document.title = 'julia · calje';
}
// Per-kind default palette: Julia gets the icefractal-style ice palette
// (monotonic dark-blue → white), Mandelbrot keeps the warm cosine cycle.
// URL ?palette=… overrides both.
{
  const paletteParam = urlParams.get('palette');
  if (paletteEl) {
    if (paletteParam && paletteEl.querySelector(`option[value="${paletteParam}"]`)) {
      paletteEl.value = paletteParam;
      console.log(`[boot] palette from URL: ${paletteParam}`);
    } else if (view.kind === 'julia') {
      paletteEl.value = 'ice';
      console.log(`[boot] palette defaulted to 'ice' for kind=julia`);
    }
  }
}
// Set data-kind on body immediately so kind-conditional CSS (the c-picker
// visibility, the Julia-only hotkey strip extension) is correct *before*
// the rest of the script runs and possibly bails on an error elsewhere.
// Done here so it doesn't depend on the picker DOM lookup succeeding later.
document.body.dataset.kind = view.kind;

function viewAddOffset(oxF64, oyF64) {
  view.cx = view.cx.plus(oxF64);
  view.cy = view.cy.plus(oyF64);
  // Repositioning the marker here (not just in render()/updateHUD) keeps it
  // glued to its world coords during a drag-pan — otherwise the rAF-throttled
  // render trails the pointermove by a frame and the marker visibly stutters.
  updateCoordMarker();
}

function resetView() {
  const home = HOME_BY_KIND[view.kind] || HOME;
  view.cx = home.cx; view.cy = home.cy; view.scale = home.scale;
  updateCoordMarker();
}

function computeMaxIter() {
  // User override from the iter input or ?iter= URL param takes precedence
  // over the zoom-adaptive default. Clamped to [16, MAX_ORBIT_LEN] so a typo
  // can't lock the renderer at 0 (instantly black canvas) or above buffer.
  if (Number.isFinite(view.maxIterOverride) && view.maxIterOverride >= 1) {
    return Math.min(MAX_ORBIT_LEN, view.maxIterOverride);
  }
  const zoomFactor = HOME.scale / view.scale;
  const log = Math.log10(Math.max(1, zoomFactor));
  // Aggressive budget — filaments near boundary need deep iteration counts.
  return Math.min(MAX_ORBIT_LEN, Math.round(1024 + 1500 * log + 100 * log * log));
}

// Per-pixel max iterations actually issued to the renderer. The GPU shader
// can chew through 50k iterations across millions of pixels in tens of
// milliseconds, but pure-JS DD-f64 perturbation does ~5 megapixels/second
// per core — at 50k iters a single tile takes minutes. Cap CPU heavily so
// the user gets a visible image in seconds. Some filament detail is lost
// at deep zoom; that's the price of the 1000× speed gap with the GPU.
//
// Phase-dependent caps so deep-zoom CPU still produces useful pixels:
//   d=8 (instant preview): 500 iters — boundary structure won't all show
//     but the user sees colour zones inside ~3s.
//   d=4 (mid):            1500 iters — 3× the budget for cleaner gradients
//     while staying within ~10s tile time.
//   d=2 (final, debounced): scales with zoom, capped at 5000. At zoom 10^15
//     1500 is plenty; at 10^21 we want ~5000 to stop the "uniform brown
//     because everything hits maxIter before escape" effect. d=2 already
//     waits behind the 2s click-debounce, so the longer compute time only
//     fires when the user has settled.
const CPU_FINAL_MAX_ITER_FLOOR = 1500;
const CPU_FINAL_MAX_ITER_CEIL  = 5000;
const CPU_MID_MAX_ITER         = 1500;
const CPU_PREVIEW_MAX_ITER     = 500;
const CPU_PIXEL_MAX_ITER       = CPU_FINAL_MAX_ITER_CEIL;  // exposed in mb() snapshot
function computePixelMaxIter(phaseDivisor) {
  const full = computeMaxIter();
  if (effectiveBackend() !== 'cpu') return full;
  // d=8: cheapest preview. Cap scales with zoom DEPTH, not orbit length.
  // Earlier formula was Math.min(2000, 0.6 * orbitLen), which broke at "in
  // set" reference spots like Tante Renate (orbit hits the 50k cap without
  // escaping → pixels need many thousands of iters to discriminate but the
  // formula clamps to 2000 → all-black canvas at zoom > ~5×10¹³). Boundary
  // pixels need roughly N iters per zoom decade to escape, so let the cap
  // grow with depth: floor 2000 (keeps shallow zoom snappy), ceiling 16000
  // (keeps d=8 well under 30s even at zoom 10²⁰).
  if (phaseDivisor >= 8) {
    const log = Math.log10(Math.max(1, HOME.scale / view.scale));
    const cap = Math.max(2000, Math.min(16000, Math.round(800 * log)));
    return Math.min(cap, full);
  }
  // d=4: middle preview — bumped from 500 to 1500 so the colour gradient
  // outside the immediate boundary doesn't collapse into a single uniform
  // shade.
  if (phaseDivisor >= 3) return Math.min(CPU_MID_MAX_ITER, full);
  // d=2 or d=1: final patience phase. Scale iter cap with zoom depth.
  // 200 iters per zoom-decade gives 200·15=3000 at z=10^15, 200·21=4200 at
  // z=10^21, capped to 5000 so the tile time stays bounded.
  const zoomDigits = Math.max(0, Math.ceil(Math.log10(HOME.scale / view.scale)));
  const scaled = Math.max(CPU_FINAL_MAX_ITER_FLOOR, 200 * zoomDigits);
  return Math.min(CPU_FINAL_MAX_ITER_CEIL, scaled, full);
}

// Effective phase list. CPU mode runs d=8 (instant preview at click-rect
// resolution) then d=4 (the "middle res" the user gets after the 2s click
// debounce). d=2 is NOT auto-fired anymore — it took 90+ seconds at zoom
// ≥10^19 which broke the "zoom around quickly" UX. The user explicitly
// requests d=1 / full quality via the "render hq" button (see
// startHighQualityRender below) — that pours the full iteration budget into
// every pixel and shows a spinner while it works.
// CPU mode: a SINGLE auto-fired phase at d=8 (1/8 of the canvas DPR),
// which lands in ~3s even at deep zoom. Quality improvements past this
// are explicit-only via the `h` keyboard shortcut (renderAtQualityTier).
// Used to be [8, 4] but auto-firing d=4 took 37s+ at deep zoom and the
// user saw "the canvas keeps improving on its own" which broke the
// "click → see something fast → decide what to do" UX.
const PROGRESSIVE_PHASES_CPU = [8];

// Resolves the override "render width" picker to a target render width in
// device pixels. Returns null if the renderer should use its own default.
//
// Auto mode scales coarseness with zoom depth — past 10^31 (where DD-f64
// per-pixel breaks down and we'd be punting to QD-f64 / Decimal kernels which
// are 4-300× slower) we drop to 1/2, 1/4, 1/8 to keep tile time reasonable.
// Manual mode honors the user's choice exactly.
function effectiveRenderWidth() {
  const dpr = window.devicePixelRatio || 1;
  const fullW = canvas.clientWidth * dpr;
  if (!renderWidthSelect || renderWidthSelect.value === 'auto') {
    const zoomDigits = Math.abs(view.scale) > 0 ? Math.ceil(Math.log10(1 / Math.abs(view.scale))) : 0;
    let divisor = 1;
    if (zoomDigits >= 50)      divisor = 8;
    else if (zoomDigits >= 30) divisor = 4;
    else if (zoomDigits >= 20) divisor = 2;
    return Math.max(2, Math.floor(fullW / divisor / 2) * 2);
  }
  const manual = parseInt(renderWidthSelect.value, 10);
  if (!Number.isFinite(manual) || manual <= 0) return Math.max(2, Math.floor(fullW / 2) * 2);
  return Math.max(2, Math.floor(manual / 2) * 2);
}
function effectivePhases() {
  return effectiveBackend() === 'cpu' ? PROGRESSIVE_PHASES_CPU : PROGRESSIVE_PHASES;
}

// Reference orbit doesn't need to be as long as per-pixel max_iter — the
// shader and CPU paths both rebase (Zhuoran/at-end) through it, so a short
// orbit gets reused for arbitrarily long pixel iterations. Keeping this cap
// modest is a big win at deep zoom: findReference does 8 candidate
// countOrbitLen runs, and at maxIter=50k each that's seconds of DD math
// before the orbit even starts computing.
// Bumped from 8000 → 16000: at zoom 10^11+ the per-pixel maxIter (~25k+) is
// significantly larger than the reference orbit, so each pixel rebases ~3-5×
// through the reference, accumulating TD-f32 ulp error. Doubling the cap
// halves the rebase count for the same pixel iter, eliminating the
// "wedge"-shaped artifacts inside in-set regions of minibrots.
const ORBIT_MAX_ITER_CAP = 16000;
const ORBIT_MAX_ITER_CAP_HQ = 50000;     // HQ button: pour ~3× more compute into finding a long reference
function computeOrbitMaxIter(hq = false) {
  return Math.min(hq ? ORBIT_MAX_ITER_CAP_HQ : ORBIT_MAX_ITER_CAP, computeMaxIter());
}

function updateHUD() {
  const z = HOME.scale / view.scale;
  const { mantissa, exp } = splitZoomToMantissaExp(z);
  // Skip rewriting fields the user is currently editing — otherwise renders
  // mid-typing would clobber the in-progress value.
  if (document.activeElement !== zoomMantissaInput) {
    zoomMantissaInput.value = isFinite(mantissa) ? mantissa.toFixed(2) : '—';
  }
  if (document.activeElement !== zoomExpInput) {
    zoomExpInput.value = String(exp);
  }
  // Show which algorithm the renderer is using so the user can see the
  // shallow → deep transition (direct → perturbation → CPU-perturbation).
  const tech = effectiveTechnique();
  const techLabel = ({
    'direct':            ' · direct',
    'perturbation':      ' · perturb',
    'cpu-perturbation':  ' · CPU perturb',
  })[tech] || '';
  zoomSuffix.textContent = techLabel;
  iterEl.textContent = `iter ${orbitCache.len}`;
  // (HQ button removed — quality bumps are now via the `h` keyboard shortcut.)
  updateCoordMarker();
}

// Project the (re, im) coords from the input fields onto the canvas and
// show a small marker there. Hidden by default — appears on mouse-move /
// coord-input edits and fades back out after a short rest, so the marker
// doesn't compete with the fractal when the user is reading the image.
//
//   showCoordMarkerNow()  — compute position, mark visible (no auto-hide).
//   pokeCoordMarker()     — show + reset auto-hide timer.
//   updateCoordMarker()   — reposition only if currently shown; called from
//                           every view-state change so the marker tracks
//                           drag/zoom while it IS visible.
const coordMarkerEl = document.getElementById('coord-marker');
let coordMarkerVisible = false;
let coordMarkerHideTimer = null;
const COORD_MARKER_REST_MS = 5000;

function showCoordMarkerNow() {
  if (!coordMarkerEl) return;
  const target = parseCoordTarget();
  if (!target) { coordMarkerEl.classList.remove('active'); coordMarkerVisible = false; return; }
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    coordMarkerEl.classList.remove('active'); coordMarkerVisible = false; return;
  }
  const aspect = rect.width / rect.height;
  // delta is small after the subtraction (Decimal preserves the digits we
  // need); coercing to f64 only loses precision when the target is so far
  // outside the viewport that we'd hide the marker anyway.
  const dx = Number(target.cx.minus(view.cx));
  const dy = Number(target.cy.minus(view.cy));
  const uvx = dx / (view.scale * aspect);
  const uvy = dy / view.scale;
  if (!isFinite(uvx) || !isFinite(uvy) ||
      Math.abs(uvx) > 1 || Math.abs(uvy) > 1) {
    coordMarkerEl.classList.remove('active'); coordMarkerVisible = false; return;
  }
  // uv ∈ [-1, 1]; canvas y is inverted (top-left origin).
  const screenX = rect.left + (uvx + 1) * 0.5 * rect.width;
  const screenY = rect.top  + (1 - uvy) * 0.5 * rect.height;
  coordMarkerEl.style.left = screenX + 'px';
  coordMarkerEl.style.top  = screenY + 'px';
  // Both classes together: visible AND bright. Since the marker only shows
  // during recent activity, no point starting in the subtle state.
  coordMarkerEl.classList.add('active');
  coordMarkerEl.classList.add('highlighted');
  coordMarkerVisible = true;
}

function hideCoordMarker() {
  if (!coordMarkerEl) return;
  coordMarkerEl.classList.remove('active');
  coordMarkerEl.classList.remove('highlighted');
  coordMarkerVisible = false;
}

function pokeCoordMarker() {
  showCoordMarkerNow();
  if (coordMarkerHideTimer) clearTimeout(coordMarkerHideTimer);
  coordMarkerHideTimer = setTimeout(hideCoordMarker, COORD_MARKER_REST_MS);
}

function updateCoordMarker() {
  // Only reposition when already visible. View-state changes that happen
  // while the marker is hidden don't surface it on their own; the user has
  // to move the mouse (or edit the coord inputs) to see it.
  if (coordMarkerVisible) showCoordMarkerNow();
}

// Decompose z = mantissa · 10^exp with mantissa ∈ [1, 10) (or 0 for z=0).
function splitZoomToMantissaExp(z) {
  if (!isFinite(z) || z <= 0) return { mantissa: NaN, exp: 0 };
  const exp = Math.floor(Math.log10(z));
  const mantissa = z / Math.pow(10, exp);
  return { mantissa, exp };
}

// Apply current values from BOTH inputs as a zoom factor of mantissa · 10^exp.
// Triggers progressiveRender so deep-zoom transitions get the correct path
// (sync vs async orbit, spinner, etc.).
function applyZoomFromInputs() {
  const mantissa = parseFloat(zoomMantissaInput.value);
  const exp = parseInt(zoomExpInput.value, 10);
  if (!isFinite(mantissa) || mantissa <= 0 || !Number.isFinite(exp)) {
    // Invalid — revert both fields to current view.
    const z = HOME.scale / view.scale;
    const split = splitZoomToMantissaExp(z);
    zoomMantissaInput.value = split.mantissa.toFixed(2);
    zoomExpInput.value = String(split.exp);
    return;
  }
  const z = mantissa * Math.pow(10, exp);
  if (!isFinite(z) || z <= 0) return;
  qualityLevel = 0;     // typed zoom changes view → reset tier
  view.scale = HOME.scale / z;
  updateCoordMarker();
  progressiveRender();
  updateCoordInputsFromView();
}

for (const el of [zoomMantissaInput, zoomExpInput]) {
  el.addEventListener('blur', applyZoomFromInputs);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') {
      // Revert both fields to current view, then drop focus.
      const z = HOME.scale / view.scale;
      const split = splitZoomToMantissaExp(z);
      zoomMantissaInput.value = split.mantissa.toFixed(2);
      zoomExpInput.value = String(split.exp);
      el.blur();
    }
  });
}

// ----- Kind selector + Julia-c inputs -----
// Switching kind resets the view to the per-kind HOME, invalidates the orbit
// cache (kind change means a fundamentally different orbit), and re-renders.
// Editing julia-c only invalidates the orbit cache + re-renders; the view
// stays put so the user can compare Julias of nearby c at the same zoom.
const kindSelectEl = document.getElementById('kind-select');
const kindLabelEl  = document.getElementById('kind-label');
const juliaCLabelEl = document.getElementById('julia-c-label');
const juliaCReInput = document.getElementById('julia-c-re');
const juliaCImInput = document.getElementById('julia-c-im');

function syncJuliaCInputs() {
  if (juliaCReInput) juliaCReInput.value = String(view.juliaC.re);
  if (juliaCImInput) juliaCImInput.value = String(view.juliaC.im);
}

function setJuliaInputsVisible(visible) {
  const display = visible ? '' : 'none';
  if (juliaCLabelEl) juliaCLabelEl.style.display = display;
  if (juliaCReInput) juliaCReInput.style.display = display;
  if (juliaCImInput) juliaCImInput.style.display = display;
  // Preset dropdowns are kind-specific — show only the one matching the active
  // fractal. Mandelbrot presets pan the viewport; Julia presets set c.
  const mandelPreset = document.getElementById('presets');
  const juliaPreset  = document.getElementById('julia-presets');
  if (mandelPreset) mandelPreset.style.display = visible ? 'none' : '';
  if (juliaPreset)  juliaPreset.style.display  = visible ? ''     : 'none';
}

function invalidateOrbitCache() {
  // Force the next render to fetch a fresh orbit — orbit content depends on
  // kind and (for Julia) on juliaC.
  orbitCache.len = 0;
  orbitCache.maxIterCovered = 0;
  orbitDirty = false;
}

function applyKindFromUI() {
  const next = kindSelectEl?.value === 'julia' ? 'julia' : 'mandelbrot';
  if (next === view.kind) return;
  console.log(`[kind] switching ${view.kind} → ${next}`);
  view.kind = next;
  const home = HOME_BY_KIND[next];
  view.cx = home.cx; view.cy = home.cy; view.scale = home.scale;
  qualityLevel = 0;
  invalidateOrbitCache();
  setJuliaInputsVisible(next === 'julia');
  if (kindLabelEl) kindLabelEl.textContent = next;
  document.title = `${next} · calje`;
  // CSS visibility hook for the c-picker (visible only in Julia mode).
  document.body.dataset.kind = next;
  if (typeof updatePickerMarker === 'function') updatePickerMarker();
  if (typeof updateOrbitForCurrentC === 'function') updateOrbitForCurrentC();
  if (typeof updateHUD === 'function') updateHUD();
  updateCoordInputsFromView();
  updateCoordMarker();
  if (typeof progressiveRender === 'function') progressiveRender();
}

function applyJuliaCFromInputs() {
  if (view.kind !== 'julia') return;
  const re = parseFloat(juliaCReInput.value);
  const im = parseFloat(juliaCImInput.value);
  if (!isFinite(re) || !isFinite(im)) {
    syncJuliaCInputs();
    return;
  }
  if (re === view.juliaC.re && im === view.juliaC.im) return;
  console.log(`[kind] julia c updated: ${view.juliaC.re}+${view.juliaC.im}i → ${re}+${im}i`);
  view.juliaC = { re, im };
  qualityLevel = 0;
  invalidateOrbitCache();
  if (typeof updatePickerMarker === 'function') updatePickerMarker();
  if (typeof updateOrbitForCurrentC === 'function') updateOrbitForCurrentC();
  if (typeof progressiveRender === 'function') progressiveRender();
}

if (kindSelectEl) {
  kindSelectEl.value = view.kind;
  kindSelectEl.addEventListener('change', applyKindFromUI);
}
setJuliaInputsVisible(view.kind === 'julia');
if (kindLabelEl) kindLabelEl.textContent = view.kind;
syncJuliaCInputs();

for (const el of [juliaCReInput, juliaCImInput].filter(Boolean)) {
  el.addEventListener('blur', applyJuliaCFromInputs);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') { syncJuliaCInputs(); el.blur(); }
  });
}

// ----- Escape radius input -----
// Changing the escape radius shifts smooth-coloring shape near the boundary
// (the set itself is unchanged). No orbit invalidate needed — the orbit
// worker keeps its own safe-large bailout (256); only the shader & CPU
// per-pixel escape check use the user value. requestRender redraws with the
// new uniform value baked into the UBO.
const escapeRadiusInput = document.getElementById('escape-radius');
function syncEscapeRadiusInput() {
  if (escapeRadiusInput) escapeRadiusInput.value = String(view.escapeRadius);
}
// `commit` distinguishes mid-typing input events (commit=false) from terminal
// blur/Enter (commit=true). On mid-typing we never write back to the input —
// re-assigning .value forces the cursor to the end and clobbers the user's
// edit. We only revert on commit if the final value is invalid.
function applyEscapeRadiusFromInput(commit) {
  if (!escapeRadiusInput) return;
  const raw = escapeRadiusInput.value;
  // Accept either dot or comma as decimal separator (European locale tolerance).
  const r = parseFloat(String(raw).replace(',', '.'));
  if (!Number.isFinite(r) || r < 1) {
    if (commit) {
      console.warn(`[escape-radius] invalid input "${raw}" on commit — reverting to ${view.escapeRadius}`);
      syncEscapeRadiusInput();
    }
    return;
  }
  const clamped = Math.min(1e6, r);
  if (clamped === view.escapeRadius) return;
  console.log(`[escape-radius] ${view.escapeRadius} → ${clamped} (sq=${(clamped * clamped).toFixed(0)}) — triggering re-render`);
  view.escapeRadius = clamped;
  // NOTE: deliberately no syncEscapeRadiusInput() here — the input already
  // holds the user's typed value, and re-assigning .value would jump the
  // cursor to the end mid-edit.
  if (typeof progressiveRender === 'function') progressiveRender();
  else if (typeof requestRender === 'function') requestRender();
}
if (escapeRadiusInput) {
  syncEscapeRadiusInput();
  escapeRadiusInput.addEventListener('input',  () => applyEscapeRadiusFromInput(false));
  escapeRadiusInput.addEventListener('change', () => applyEscapeRadiusFromInput(true));
  escapeRadiusInput.addEventListener('blur',   () => applyEscapeRadiusFromInput(true));
  escapeRadiusInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); escapeRadiusInput.blur(); }
    if (e.key === 'Escape') { syncEscapeRadiusInput(); escapeRadiusInput.blur(); }
  });
}

// ----- Iter override input -----
// Empty = auto (use computeMaxIter's adaptive default). Any integer ≥ 16
// overrides the per-frame max iterations, both in the GPU shader and the
// orbit worker (which size their loops from computeMaxIter / computeOrbitMaxIter).
const iterOverrideInput = document.getElementById('iter-override');
function syncIterOverrideInput() {
  if (!iterOverrideInput) return;
  iterOverrideInput.value = view.maxIterOverride != null ? String(view.maxIterOverride) : '';
}
function applyIterOverrideFromInput(commit) {
  if (!iterOverrideInput) return;
  const raw = iterOverrideInput.value.trim();
  if (raw === '') {
    if (view.maxIterOverride !== null) {
      console.log(`[iter-override] cleared → auto (computeMaxIter() will pick the adaptive value)`);
      view.maxIterOverride = null;
      invalidateOrbitCache();
      if (typeof progressiveRender === 'function') progressiveRender();
    }
    return;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    if (commit) {
      console.warn(`[iter-override] invalid input "${raw}" — reverting to ${view.maxIterOverride ?? 'auto'}`);
      syncIterOverrideInput();
    }
    return;
  }
  const clamped = Math.min(MAX_ORBIT_LEN, n);
  if (clamped === view.maxIterOverride) return;
  console.log(`[iter-override] ${view.maxIterOverride ?? 'auto'} → ${clamped} (was zoom-adaptive: ${1024 + Math.round(1500 * Math.log10(Math.max(1, HOME.scale / view.scale)))})`);
  view.maxIterOverride = clamped;
  // Bump iter > orbit's maxIterCovered → orbit cache stale → worker refetch.
  invalidateOrbitCache();
  if (typeof progressiveRender === 'function') progressiveRender();
}
if (iterOverrideInput) {
  syncIterOverrideInput();
  iterOverrideInput.addEventListener('input',  () => applyIterOverrideFromInput(false));
  iterOverrideInput.addEventListener('change', () => applyIterOverrideFromInput(true));
  iterOverrideInput.addEventListener('blur',   () => applyIterOverrideFromInput(true));
  iterOverrideInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); iterOverrideInput.blur(); }
    if (e.key === 'Escape') { syncIterOverrideInput(); iterOverrideInput.blur(); }
  });
}

// ===========================================================================
// Julia c-picker
// ---------------------------------------------------------------------------
// A small static thumbnail of the Mandelbrot set, sitting in the bottom-right
// corner when kind=julia. Clicking anywhere on it sets view.juliaC to the
// underlying complex coord and re-renders the main Julia canvas.
//
// Why the picker doesn't need the deep-zoom engine: it's a fixed view of the
// whole Mandelbrot at modest resolution (~280×220). One plain-JS render at
// page load, takes ~30-100ms. After that it's just a click target with a
// marker that shows the currently-selected c.
// ===========================================================================
const pickerCanvas = document.getElementById('julia-picker-canvas');
const pickerMarker = document.getElementById('julia-picker-marker');
const pickerHover  = document.getElementById('julia-picker-hover');
const pickerCoords = document.getElementById('julia-picker-c');
const orbitCanvas  = document.getElementById('julia-orbit-canvas');
const orbitCtx     = orbitCanvas?.getContext('2d');

// Render the iteration orbit of c under z := z² + c starting from z = 0
// (i.e. the Mandelbrot orbit of c). When c is inside M the orbit stays bounded
// and traces a periodic or quasi-periodic figure; when c is outside it escapes
// quickly and the orbit shoots off to infinity, clipped by the bbox below.
//
// Visual: white vector strokes connecting successive z values on a black
// background. Coordinate frame is centered on the origin with extent ±2 so
// the full z²+c attractor fits.
function renderOrbitForC(cRe, cIm) {
  if (!orbitCtx) return;
  const w = orbitCanvas.width, h = orbitCanvas.height;
  orbitCtx.fillStyle = '#000';
  orbitCtx.fillRect(0, 0, w, h);

  // Iterate, collect points until escape or maxIter
  const maxIter = 200;
  const pts = [[0, 0]];
  let zr = 0, zi = 0;
  for (let i = 0; i < maxIter; i++) {
    const zr2 = zr * zr, zi2 = zi * zi;
    if (zr2 + zi2 > 4) break;
    const nzr = zr2 - zi2 + cRe;
    const nzi = 2 * zr * zi + cIm;
    zr = nzr; zi = nzi;
    pts.push([zr, zi]);
  }

  // Project complex coords to canvas pixels — origin at canvas centre, math y
  // (positive = up). Extent ±2 so the natural |z| ≤ 2 range fits with margin.
  const VIEW_HALF = 2;
  const scale = Math.min(w, h) * 0.46 / VIEW_HALF;
  const ox = w / 2, oy = h / 2;
  const proj = (x, y) => [ox + x * scale, oy - y * scale];

  // Faint origin crosshair for orientation
  orbitCtx.strokeStyle = 'rgba(124, 255, 107, 0.18)';
  orbitCtx.lineWidth = 0.5;
  orbitCtx.beginPath();
  orbitCtx.moveTo(0, oy); orbitCtx.lineTo(w, oy);
  orbitCtx.moveTo(ox, 0); orbitCtx.lineTo(ox, h);
  orbitCtx.stroke();

  // Orbit strokes
  orbitCtx.strokeStyle = 'rgba(242, 240, 234, 0.92)';
  orbitCtx.lineWidth = 1.4;
  orbitCtx.lineCap = 'round';
  orbitCtx.lineJoin = 'round';
  orbitCtx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = proj(pts[i][0], pts[i][1]);
    if (i === 0) orbitCtx.moveTo(px, py);
    else orbitCtx.lineTo(px, py);
  }
  orbitCtx.stroke();

  // Dot at z=0 (orbit start)
  const [sx, sy] = proj(0, 0);
  orbitCtx.fillStyle = 'rgba(124, 255, 107, 0.9)';
  orbitCtx.beginPath();
  orbitCtx.arc(sx, sy, 2.5, 0, Math.PI * 2);
  orbitCtx.fill();
}

// Viewport of the picker in complex coords — shows the full Mandelbrot with
// some padding so points just outside M (which produce interesting "dust"
// Julias) are still reachable.
const PICKER_VIEW = { xmin: -2.1, xmax: 0.7, ymin: -1.15, ymax: 1.15 };

// Math convention: positive imaginary axis points UP. Screen pixels go top→bottom,
// so py = 0 must map to ymax (not ymin) and vice versa.
function pickerComplexFromPixel(px, py, w, h) {
  const re = PICKER_VIEW.xmin + (px / w) * (PICKER_VIEW.xmax - PICKER_VIEW.xmin);
  const im = PICKER_VIEW.ymax - (py / h) * (PICKER_VIEW.ymax - PICKER_VIEW.ymin);
  return { re, im };
}

function pickerPixelFromComplex(re, im, w, h) {
  const px = (re - PICKER_VIEW.xmin) / (PICKER_VIEW.xmax - PICKER_VIEW.xmin) * w;
  const py = (PICKER_VIEW.ymax - im) / (PICKER_VIEW.ymax - PICKER_VIEW.ymin) * h;
  return { px, py };
}

function renderPickerOnce() {
  if (!pickerCanvas) return;
  const ctx = pickerCanvas.getContext('2d');
  const w = pickerCanvas.width, h = pickerCanvas.height;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const maxIter = 192;
  const t0 = performance.now();
  for (let py = 0; py < h; py++) {
    // Flip y so positive imaginary axis sits at the top of the canvas (math
    // convention). Mandelbrot is symmetric across the real axis so this
    // looks the same as the unflipped render — it only matters for the
    // marker position to match the click position.
    const cy = PICKER_VIEW.ymax - (py / h) * (PICKER_VIEW.ymax - PICKER_VIEW.ymin);
    for (let px = 0; px < w; px++) {
      const cx = PICKER_VIEW.xmin + (px / w) * (PICKER_VIEW.xmax - PICKER_VIEW.xmin);
      const off = (py * w + px) * 4;
      // Main cardioid + period-2 bulb skip — keeps most of M black and fast.
      const cxm = cx - 0.25;
      const cy2 = cy * cy;
      const q = cxm * cxm + cy2;
      if (q * (q + cxm) <= 0.25 * cy2) { data[off + 3] = 255; continue; }
      const xp = cx + 1;
      if (xp * xp + cy2 <= 0.0625) { data[off + 3] = 255; continue; }
      let zr = 0, zi = 0;
      let i = 0;
      while (i < maxIter) {
        const zr2 = zr * zr;
        const zi2 = zi * zi;
        if (zr2 + zi2 > 4) break;
        zi = 2 * zr * zi + cy;
        zr = zr2 - zi2 + cx;
        i++;
      }
      if (i === maxIter) {
        data[off + 3] = 255;            // in-set: black
      } else {
        // Cool blue-to-white escape gradient — keep it monochrome so the
        // marker dot (accent green) is the eye-catcher.
        const t = i / maxIter;
        const v = Math.pow(t, 0.4);
        data[off    ] = (40 + 180 * v) | 0;
        data[off + 1] = (60 + 180 * v) | 0;
        data[off + 2] = (120 + 130 * v) | 0;
        data[off + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  console.log(`[julia-picker] rendered ${w}×${h} in ${(performance.now() - t0).toFixed(0)}ms`);
}

function updateOrbitForCurrentC() {
  if (view.kind !== 'julia') return;
  renderOrbitForC(view.juliaC.re, view.juliaC.im);
}

function updatePickerMarker() {
  if (!pickerMarker || !pickerCanvas) return;
  const { px, py } = pickerPixelFromComplex(
    view.juliaC.re, view.juliaC.im,
    pickerCanvas.clientWidth || pickerCanvas.width,
    pickerCanvas.clientHeight || pickerCanvas.height,
  );
  // Only show the marker if the point is inside the picker viewport.
  const w = pickerCanvas.clientWidth || pickerCanvas.width;
  const h = pickerCanvas.clientHeight || pickerCanvas.height;
  if (px < 0 || px > w || py < 0 || py > h) {
    pickerMarker.classList.remove('active');
  } else {
    pickerMarker.style.left = px + 'px';
    pickerMarker.style.top  = py + 'px';
    pickerMarker.classList.add('active');
  }
  if (pickerCoords) {
    const re = view.juliaC.re;
    const im = view.juliaC.im;
    pickerCoords.textContent = `${re.toFixed(4)} ${im >= 0 ? '+' : '−'} ${Math.abs(im).toFixed(4)}i`;
  }
}

function applyJuliaCFromPicker(cssX, cssY) {
  const rect = pickerCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const px = cssX - rect.left, py = cssY - rect.top;
  const { re, im } = pickerComplexFromPixel(px, py, w, h);
  console.log(`[julia-picker] clicked (${px.toFixed(1)}, ${py.toFixed(1)}) → c = ${re.toFixed(5)} + ${im.toFixed(5)}i`);
  view.juliaC = { re, im };
  qualityLevel = 0;
  invalidateOrbitCache();
  syncJuliaCInputs();
  updatePickerMarker();
  updateOrbitForCurrentC();
  if (typeof progressiveRender === 'function') progressiveRender();
}

if (pickerCanvas) {
  pickerCanvas.addEventListener('click', (e) => applyJuliaCFromPicker(e.clientX, e.clientY));
  // Drag-to-update: holding down the mouse and moving updates c live for a
  // really tactile "scrub the Mandelbrot to morph the Julia" feel.
  let pickerDragging = false;
  pickerCanvas.addEventListener('pointerdown', (e) => {
    pickerDragging = true;
    pickerCanvas.setPointerCapture(e.pointerId);
    applyJuliaCFromPicker(e.clientX, e.clientY);
  });
  pickerCanvas.addEventListener('pointermove', (e) => {
    // Hover preview marker (light grey) follows the cursor always.
    const rect = pickerCanvas.getBoundingClientRect();
    if (pickerHover) {
      pickerHover.style.left = (e.clientX - rect.left) + 'px';
      pickerHover.style.top  = (e.clientY - rect.top)  + 'px';
      pickerHover.classList.add('active');
    }
    // Live orbit preview — render the orbit for the cursor's c WITHOUT
    // committing it to view.juliaC. So the orbit miniview morphs as you
    // sweep the Mandelbrot, but the Julia canvas only re-renders on click.
    if (orbitCtx && !pickerDragging) {
      const { re, im } = pickerComplexFromPixel(
        e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height
      );
      renderOrbitForC(re, im);
    }
    if (pickerDragging) applyJuliaCFromPicker(e.clientX, e.clientY);
  });
  pickerCanvas.addEventListener('pointerup', (e) => {
    pickerDragging = false;
    try { pickerCanvas.releasePointerCapture(e.pointerId); } catch {}
  });
  pickerCanvas.addEventListener('pointerleave', () => {
    if (pickerHover) pickerHover.classList.remove('active');
    // Cursor gone → snap orbit back to the committed c.
    updateOrbitForCurrentC();
  });
  renderPickerOnce();
  // Initial marker + body data-kind attribute so the CSS visibility rule fires.
  document.body.dataset.kind = view.kind;
  updatePickerMarker();
}

// Reference orbit computed in JS-DD (~31 digits), stored as TD-f32 for GPU (6 × f32 per iter).
// refCx/refCy are Decimal so the full 60-digit view precision survives into the
// delta computation in render() — otherwise subtracting a Decimal view from a
// DD-pair ref would collapse everything past ~10^28 back to zero.
const orbitScratch = new Float32Array(MAX_ORBIT_LEN * 6);
// Parallel DD-f64 buffer for the CPU renderer — kept in sync with orbitScratch
// so a sync ensureReference() call (recording path) leaves both backends ready.
const orbitScratchDD = new Float64Array(MAX_ORBIT_LEN * 4);
const orbitCache = {
  refCx: new Decimal(0), refCy: new Decimal(0),
  scale: NaN,
  len: 0,
  // DD-f64 orbit samples [reH, reL, imH, imL, …] for the CPU renderer. The
  // GPU shader reads the TD-f32 buffer directly out of orbitBuffer, but the
  // CPU worker needs the samples in-memory on the main thread.
  orbitDD: null,
  // QD-f64 orbit samples [re0, re1, re2, re3, im0, im1, im2, im3, …]. Only
  // populated past zoomDigits ≥ 31 — the depth where DD-f64's 31-digit
  // mantissa stops being enough for accurate per-pixel perturbation. Null
  // at shallower zoom; the CPU kernel checks for it and falls back to DD.
  orbitQD: null,
  // The maxIter we asked the worker for when it produced the current orbit.
  // If the orbit naturally escaped at a smaller `len`, we've still *covered*
  // the full request — running again won't give us more iterations, so the
  // cache check uses maxIterCovered (not len) to avoid an infinite request loop.
  maxIterCovered: 0,
};

// Iterate in complex-DD (~31 digits) — matches the reference-orbit computation
// precision, so reference-finding stays correct past the f64 ~10^15 wall.
function countOrbitLen(cxDD, cyDD, maxIter) {
  // Per-kind: Mandelbrot iterates z := z² + c starting at z₀ = 0, with
  // c = (cxDD, cyDD). Julia iterates z := z² + julia_c starting at
  // z₀ = (cxDD, cyDD), with c = view.juliaC (per-render constant).
  let z, c;
  if (view.kind === 'julia') {
    z = [cxDD[0], cxDD[1], cyDD[0], cyDD[1]];
    c = [view.juliaC.re, 0, view.juliaC.im, 0];
  } else {
    z = [0, 0, 0, 0]; // complex DD: [reH, reL, imH, imL]
    c = [cxDD[0], cxDD[1], cyDD[0], cyDD[1]];
  }
  for (let i = 0; i < maxIter; i++) {
    // Bailout needs only f32-ish precision — hi parts are plenty to compare to 256.
    if (z[0] * z[0] + z[2] * z[2] > 256.0) return i;
    z = cddAdd(cddSqr(z), c);
  }
  return maxIter;
}

// Grid-search a reference that escapes as late as possible; returns offset (f64)
// from view center. View center passed as DD pair so sub-pixel offsets survive
// even at 10^20+ zoom where plain f64 would collapse them to zero.
function findReference(viewCxDD, viewCyDD, scale, aspect, maxIter) {
  let bestOx = 0, bestOy = 0;
  let bestLen = countOrbitLen(viewCxDD, viewCyDD, maxIter);
  if (bestLen >= maxIter) return { ox: 0, oy: 0, len: bestLen };

  // 3×3 grid = 8 candidates around the centre. Used to be 9×9 = 80, which at
  // deep zoom with max_iter ~10k+ stalls the main thread for hundreds of ms
  // (each candidate runs countOrbitLen in complex-DD JS). 3×3 is 10× cheaper
  // and still finds a usable reference — the viewport is tiny at deep zoom,
  // so candidates near the centre behave almost identically anyway.
  const N = 3;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === (N - 1) / 2 && j === (N - 1) / 2) continue;
      const u = (i / (N - 1)) * 2 - 1;
      const v = (j / (N - 1)) * 2 - 1;
      const ox = u * scale * aspect * 0.98;
      const oy = v * scale * 0.98;
      const cxDD = ddAdd(viewCxDD, [ox, 0]);
      const cyDD = ddAdd(viewCyDD, [oy, 0]);
      const len = countOrbitLen(cxDD, cyDD, maxIter);
      if (len > bestLen) {
        bestLen = len;
        bestOx = ox; bestOy = oy;
        if (bestLen >= maxIter) return { ox: bestOx, oy: bestOy, len: bestLen };
      }
    }
  }
  return { ox: bestOx, oy: bestOy, len: bestLen };
}

function orbitCacheFresh(viewCx, viewCy, scale, aspect, maxIter) {
  if (orbitCache.len <= 0) {
    console.log(`[orbitCacheFresh] STALE: cache empty (len=${orbitCache.len})`);
    return false;
  }
  // After subtraction the result is small (within viewport), so coercing to
  // f64 via Number() keeps plenty of precision for the viewport comparison.
  const dx = Number(viewCx.minus(orbitCache.refCx));
  const dy = Number(viewCy.minus(orbitCache.refCy));
  const inViewport = Math.abs(dx) < scale * aspect && Math.abs(dy) < scale;
  const iterOK = maxIter <= orbitCache.maxIterCovered;
  const fresh = inViewport && iterOK;
  console.log(
    `[orbitCacheFresh] ${fresh ? 'FRESH' : 'STALE'}: ` +
    `dx=${dx.toExponential(2)} (limit=${(scale * aspect).toExponential(2)}) ` +
    `dy=${dy.toExponential(2)} (limit=${scale.toExponential(2)}) ` +
    `inViewport=${inViewport} ` +
    `maxIter=${maxIter} maxIterCovered=${orbitCache.maxIterCovered} iterOK=${iterOK} ` +
    `cachedLen=${orbitCache.len}`
  );
  return fresh;
}

function iterateOrbitDD(refCxDD, refCyDD, maxIter) {
  let z, c;
  if (view.kind === 'julia') {
    z = [refCxDD[0], refCxDD[1], refCyDD[0], refCyDD[1]];
    c = [view.juliaC.re, 0, view.juliaC.im, 0];
  } else {
    z = [0, 0, 0, 0];
    c = [refCxDD[0], refCxDD[1], refCyDD[0], refCyDD[1]];
  }
  let n = 0;
  for (let i = 0; i < maxIter; i++) {
    const zr = ddToF32TD(z[0], z[1]);
    const zi = ddToF32TD(z[2], z[3]);
    orbitScratch[i * 6 + 0] = zr[0]; orbitScratch[i * 6 + 1] = zr[1]; orbitScratch[i * 6 + 2] = zr[2];
    orbitScratch[i * 6 + 3] = zi[0]; orbitScratch[i * 6 + 4] = zi[1]; orbitScratch[i * 6 + 5] = zi[2];
    orbitScratchDD[i * 4 + 0] = z[0]; orbitScratchDD[i * 4 + 1] = z[1];
    orbitScratchDD[i * 4 + 2] = z[2]; orbitScratchDD[i * 4 + 3] = z[3];
    n = i + 1;
    if (z[0] * z[0] + z[2] * z[2] > 256.0) break;
    z = cddAdd(cddSqr(z), c);
  }
  return n;
}

function iterateOrbitDecimal(refCxDec, refCyDec, maxIter) {
  const TWO = new Decimal(2);
  let zr, zi, cReDec, cImDec;
  if (view.kind === 'julia') {
    zr = refCxDec; zi = refCyDec;
    cReDec = new Decimal(view.juliaC.re);
    cImDec = new Decimal(view.juliaC.im);
  } else {
    zr = new Decimal(0); zi = new Decimal(0);
    cReDec = refCxDec; cImDec = refCyDec;
  }
  let n = 0;
  for (let i = 0; i < maxIter; i++) {
    const [zra, zrb, zrc] = decimalToTD(zr);
    const [zia, zib, zic] = decimalToTD(zi);
    orbitScratch[i * 6 + 0] = zra; orbitScratch[i * 6 + 1] = zrb; orbitScratch[i * 6 + 2] = zrc;
    orbitScratch[i * 6 + 3] = zia; orbitScratch[i * 6 + 4] = zib; orbitScratch[i * 6 + 5] = zic;
    const [zrH, zrL] = decimalToDD(zr);
    const [ziH, ziL] = decimalToDD(zi);
    orbitScratchDD[i * 4 + 0] = zrH; orbitScratchDD[i * 4 + 1] = zrL;
    orbitScratchDD[i * 4 + 2] = ziH; orbitScratchDD[i * 4 + 3] = ziL;
    n = i + 1;
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

function ensureReference(viewCx, viewCy, scale, aspect, maxIter) {
  // Synchronous version — used only by the recording path where every frame
  // needs a fresh orbit before the kernel can run. Interactive use goes
  // through the worker instead (see requestOrbitUpdateAsync below).
  if (orbitCacheFresh(viewCx, viewCy, scale, aspect, maxIter)) return;

  // Precision: zoom depth + 15-digit margin for iteration-error amplification.
  // Floor at 60 (the startup default) so this function never *lowers* the
  // global precision. If we drop precision here at shallow zoom, every
  // subsequent view.cx.plus(offset) at deeper zoom will silently round the
  // offset to zero — the user clicks at deep zoom and view.cx doesn't move
  // because the click offset (e.g. 4e-27) lands beyond the precision floor.
  const zoomDigits = scale > 0 ? Math.ceil(Math.log10(1 / scale)) : 0;
  Decimal.set({ precision: Math.max(60, zoomDigits + 15) });

  const viewCxDD = decimalToDD(viewCx);
  const viewCyDD = decimalToDD(viewCy);
  const ref = findReference(viewCxDD, viewCyDD, scale, aspect, maxIter);

  const refCxDec = viewCx.plus(ref.ox);
  const refCyDec = viewCy.plus(ref.oy);

  // DD only for shallow zoom; past 10^11 iteration-error accumulation eats
  // its ~31 digits and the orbit starts diverging from the click target.
  let n;
  if (zoomDigits < 12) {
    const refCxDD = decimalToDD(refCxDec);
    const refCyDD = decimalToDD(refCyDec);
    n = iterateOrbitDD(refCxDD, refCyDD, ref.len);
  } else {
    n = iterateOrbitDecimal(refCxDec, refCyDec, ref.len);
  }
  device.queue.writeBuffer(orbitBuffer, 0, orbitScratch.buffer, 0, n * ORBIT_BYTES_PER_ITER);
  orbitCache.refCx = refCxDec;
  orbitCache.refCy = refCyDec;
  orbitCache.scale = scale;
  orbitCache.len = n;
  orbitCache.maxIterCovered = maxIter;
  // Publish a fresh DD-f64 copy for the CPU renderer. Slicing matters — the
  // scratch buffer is reused across calls and the cache must not alias it.
  orbitCache.orbitDD = orbitScratchDD.slice(0, n * 4);
}

// ---------- Async orbit computation via Web Worker ----------
// Interactive renders offload the complex-DD reference-orbit work to a worker
// thread so the main thread never blocks for 100–500 ms while the user is
// clicking. The worker posts back a ready-to-upload Float32Array (TD-f32),
// we write it to the GPU buffer, and trigger a render.
let orbitWorker = null;
let orbitWorkerReqId = 0;
let orbitWorkerLatestCompleted = 0;
let orbitDirty = false;    // an orbit request is in flight; skip GPU submits until it lands
let pendingReqMaxIter = 0; // maxIter of the most recent request — restored into the cache on response

function attachOrbitWorkerListeners(w) {
  w.addEventListener('message', onOrbitWorkerMessage);
  w.addEventListener('error', onOrbitWorkerError);
  w.addEventListener('messageerror', onOrbitWorkerMessageError);
}

function spawnOrbitWorker() {
  orbitWorker = new Worker(new URL('./orbit-worker.js', import.meta.url), { type: 'module' });
  attachOrbitWorkerListeners(orbitWorker);
}

// Terminate-and-respawn the orbit worker. Call this when we're about to
// dispatch a NEW orbit request and the previous one hasn't completed yet —
// e.g. rapid preset-dropdown switching. Without this guard, postMessage
// queues each ~6–12 MB orbit request (refCxStr, refCyStr, scale, etc. on
// the way in; orbitBytes + orbitDDBytes + orbitQDBytes on the way out).
// Five rapid clicks at deep zoom = ~60 MB pinned in the message queue, and
// the structured-clone of large Float64Arrays per response amplifies it
// further. After ten or twenty clicks the tab OOMs and the GPU process
// can take other WebGPU tabs down with it.
function cancelInFlightOrbitWorker() {
  if (!orbitDirty) return; // no in-flight request, nothing to drain
  console.warn(`[orbit-worker] cancelling in-flight req#${orbitWorkerReqId}: terminate+respawn to drain queued postMessage clones`);
  try { orbitWorker.terminate(); } catch (e) { console.warn('[orbit-worker] terminate threw', e); }
  // Bump latest-completed past every prior reqId so any in-flight responses
  // (already in the queue but not yet delivered) would be dropped if they
  // somehow still arrived. Belt-and-braces — terminate() should kill them.
  orbitWorkerLatestCompleted = orbitWorkerReqId;
  orbitDirty = false;
  spawnOrbitWorker();
}

spawnOrbitWorker();

function requestOrbitUpdateAsync(viewCx, viewCy, scale, aspect, maxIter, deepSearch = false) {
  // deepSearch bypasses the cache check: if the user explicitly asked for
  // HQ-quality, we always re-run the orbit search even if the existing cache
  // is "fresh" by interactive standards — the existing orbit was found by the
  // cheap 3×3 grid; a 7×7×3-radii search may turn up a much longer reference.
  if (!deepSearch && orbitCacheFresh(viewCx, viewCy, scale, aspect, maxIter)) {
    console.log(`[requestOrbitUpdateAsync] cache hit, no work — len=${orbitCache.len} maxIterCovered=${orbitCache.maxIterCovered}`);
    return false; // nothing to do
  }
  // Drain any in-flight orbit dispatch before starting a new one. Cheap
  // when nothing's pending; critical when the user is rapidly switching
  // presets (each switch enqueues a multi-MB postMessage).
  cancelInFlightOrbitWorker();
  orbitDirty = true;
  pendingReqMaxIter = maxIter;
  const id = ++orbitWorkerReqId;
  console.log(`[requestOrbitUpdateAsync] dispatching req#${id}: kind=${view.kind} scale=${scale.toExponential(2)} aspect=${aspect.toFixed(3)} maxIter=${maxIter} prevCacheLen=${orbitCache.len}${deepSearch ? ' DEEP-SEARCH' : ''}` + (view.kind === 'julia' ? ` juliaC=${view.juliaC.re}+${view.juliaC.im}i` : ''));
  // Wire protocol: Decimal strings so the worker gets the full 60-digit
  // navigation precision (orbit iteration itself falls back to DD internally).
  orbitWorker.postMessage({
    id,
    viewCxStr: viewCx.toString(),
    viewCyStr: viewCy.toString(),
    scale, aspect, maxIter, deepSearch,
    kind: view.kind,
    juliaReStr: view.juliaC.re.toString(),
    juliaImStr: view.juliaC.im.toString(),
  });
  return true;
}

function onOrbitWorkerMessage(ev) {
  try {
    const { id, refCxStr, refCyStr, len, orbitBytes, orbitDDBytes, orbitQDBytes } = ev.data;
    // Drop stale responses — we only care about the most-recent orbit request.
    if (id <= orbitWorkerLatestCompleted) {
      console.log(`[orbitWorker→main] DROP req#${id}: already saw response for ≥${orbitWorkerLatestCompleted}`);
      return;
    }
    orbitWorkerLatestCompleted = id;
    // Drop non-latest too: a sync ensureReference call (or a newer async
    // request) may have bumped orbitWorkerReqId since this message was
    // posted. Accepting it would stomp a fresher cache with stale data —
    // which is exactly the "zooming stops" bug at moderate depth where
    // sync and async orbit paths coexist.
    if (id !== orbitWorkerReqId) {
      console.log(`[orbitWorker→main] DROP req#${id}: superseded by req#${orbitWorkerReqId}`);
      return;
    }
    console.log(`[orbitWorker→main] ACCEPT req#${id}: len=${len} (max=${pendingReqMaxIter}) escapedEarly=${len < pendingReqMaxIter}`);
    orbitDirty = false;

    if (len > 0) {
      // Upload the freshly-computed orbit to the GPU. writeBuffer with a
      // typed array takes dataOffset/size in elements; `len * 6` floats =
      // one TD-complex per reference iteration.
      const orbitArr = new Float32Array(orbitBytes);
      device.queue.writeBuffer(orbitBuffer, 0, orbitArr, 0, len * 6);
    }
    // CPU renderer keeps the DD-f64 samples in memory so it doesn't have to
    // re-derive them from TD-f32 (which would lose precision we've already
    // paid for).
    orbitCache.orbitDD = orbitDDBytes ? new Float64Array(orbitDDBytes) : null;
    // QD-f64 orbit samples: 8 doubles per orbit point (4 re + 4 im). Only
    // emitted by the worker past zoomDigits ≥ 31; null at shallower zoom.
    orbitCache.orbitQD = orbitQDBytes ? new Float64Array(orbitQDBytes) : null;
    orbitCache.refCx = new Decimal(refCxStr);
    orbitCache.refCy = new Decimal(refCyStr);
    orbitCache.len = len;
    // Mark the full request-range as covered even when the orbit escaped
    // early (len < maxIter). Running again would produce the same orbit —
    // no point burning worker cycles on every frame.
    if (id === orbitWorkerReqId) orbitCache.maxIterCovered = pendingReqMaxIter;
    requestRender();
  } catch (err) {
    console.error('[orbit-worker] response handler failed:', err);
    orbitDirty = false;     // unstick the gate so interaction resumes
    requestRender();
  }
}

// Unhandled exceptions inside the worker itself (bad math, transfer failure)
// never turn into message events — catch them here and release the gate.
function onOrbitWorkerError(e) {
  console.error('[orbit-worker] error:', e.message, e);
  orbitDirty = false;
  requestRender();
}
function onOrbitWorkerMessageError(e) {
  console.error('[orbit-worker] messageerror (structured-clone failure):', e);
  orbitDirty = false;
  requestRender();
}

let pendingFrame = false;
let isRecording = false;
let skipReferenceUpdate = false;
// Track whether the GPU is still chewing on a previously-submitted interactive
// render. When rapid clicks stack up faster than the GPU can render, we skip
// launching intermediate frames and only render the *latest* view once the GPU
// is free — otherwise the queue fills with stale zoom states and the user sees
// the canvas "catch up" one old frame at a time.
let gpuBusy = false;
let renderNeeded = false;
function requestRender() {
  if (isRecording) return;
  renderNeeded = true;
  if (gpuBusy) return;         // onSubmittedWorkDone callback will re-pump
  if (pendingFrame) return;    // rAF already scheduled
  pendingFrame = true;
  requestAnimationFrame(() => {
    pendingFrame = false;
    if (isRecording || gpuBusy || !renderNeeded) return;
    renderNeeded = false;
    dispatchRender();
  });
}

const uboData = new ArrayBuffer(UBO_SIZE);
const uboF32 = new Float32Array(uboData);
const uboU32 = new Uint32Array(uboData);
const uboI32 = new Int32Array(uboData);

let renderCallSeq = 0;
function render() {
  const _seq = ++renderCallSeq;
  pendingFrame = false;
  const aspect = canvas.width / canvas.height;
  const orbitMaxIter = computeOrbitMaxIter();
  const directMode = effectiveTechnique() === 'direct';
  console.log(`[render #${_seq}] entry: canvas=${canvas.width}×${canvas.height} aspect=${aspect.toFixed(3)} backend=${effectiveBackend()} technique=${effectiveTechnique()} directMode=${directMode} kind=${view.kind} escapeR=${view.escapeRadius} (sq=${view.escapeRadius * view.escapeRadius}) orbitDirty=${orbitDirty} cachedOrbitLen=${orbitCache.len} maxIterCovered=${orbitCache.maxIterCovered}`);
  if (!skipReferenceUpdate && !directMode) {
    // Direct mode skips the orbit worker entirely — z=z²+c per pixel needs
    // no reference. Perturbation still requires a fresh orbit to perturb off.
    if (isRecording) {
      // Recording demands a fresh orbit before each frame — sync path.
      ensureReference(view.cx, view.cy, view.scale, aspect, orbitMaxIter);
    } else {
      // Interactive: fire off the worker if the cache is stale. If we kicked
      // off a request (or one is still in flight), skip the GPU submit — the
      // worker's response handler will call requestRender() again once the
      // fresh orbit is uploaded.
      requestOrbitUpdateAsync(view.cx, view.cy, view.scale, aspect, orbitMaxIter);
      if (orbitDirty) {
        console.log(`[render #${_seq}] BAIL: orbitDirty after request — swapchain stays in current state until orbit lands`);
        return;
      }
    }
  }

  // TDXR frame exponent: chosen so scale_m ≈ mantissa in [1, 2). Shared by scale
  // and delta_center so the shader only needs one frame_exp uniform. Exponent range
  // is i32, so zoom magnitude is effectively unbounded (mantissa still TD = 21 digits).
  const scaleAbs = Math.abs(view.scale);
  const frameExp = scaleAbs > 0 ? Math.floor(Math.log2(scaleAbs)) : 0;
  const invFactor = Math.pow(2, -frameExp); // multiply by this to normalise to mantissa

  // UBO layout (f32 index · 4 bytes = offset):
  //   [0..1]   resolution          |   [2..3]   pad
  //   [4..6]   scale_m TD mantissa |   [7]      frame_exp i32
  //   [8..10]  delta_re_m TD       |   [11]     pad
  //   [12..14] delta_im_m TD       |   [15]     pad
  //   [16]     orbit_len u32       |   [17]     max_iter u32   |   [18] pad   |   [19] palette_offset f32
  //   [20..22] palette_a           |   [23] pad
  //   [24..26] palette_b           |   [27] pad
  //   [28..30] palette_c           |   [31] pad
  //   [32..34] palette_d           |   [35] pad
  uboF32[0] = canvas.width;
  uboF32[1] = canvas.height;
  const scaleMantTD = ddToF32TD(view.scale * invFactor, 0);
  uboF32[4] = scaleMantTD[0]; uboF32[5] = scaleMantTD[1]; uboF32[6] = scaleMantTD[2];
  uboI32[7] = frameExp;

  // delta_re_m / delta_im_m mean different things depending on mode:
  //   perturbation: (view - ref) mantissa — the small offset off the orbit
  //   direct:        view center mantissa — c_pixel = this + per-pixel offset
  // The shader inspects u.mode and interprets accordingly.
  if (directMode) {
    const cxMant = view.cx.times(invFactor);
    const cyMant = view.cy.times(invFactor);
    const cxTD = decimalToTD(cxMant);
    const cyTD = decimalToTD(cyMant);
    uboF32[8]  = cxTD[0]; uboF32[9]  = cxTD[1]; uboF32[10] = cxTD[2];
    uboF32[12] = cyTD[0]; uboF32[13] = cyTD[1]; uboF32[14] = cyTD[2];
  } else {
    // Delta in 60-digit Decimal so view-vs-ref subtraction stays exact past
    // 10^28 (DD would collapse it to zero there). Result is small (within
    // viewport), so splitting to TD-f32 preserves everything we can use.
    const dxDec = view.cx.minus(orbitCache.refCx).times(invFactor);
    const dyDec = view.cy.minus(orbitCache.refCy).times(invFactor);
    const dreTD = decimalToTD(dxDec);
    const dimTD = decimalToTD(dyDec);
    uboF32[8]  = dreTD[0]; uboF32[9]  = dreTD[1]; uboF32[10] = dreTD[2];
    uboF32[12] = dimTD[0]; uboF32[13] = dimTD[1]; uboF32[14] = dimTD[2];
  }
  uboU32[16] = directMode ? 0 : orbitCache.len;
  uboU32[17] = computeMaxIter();
  uboU32[18] = directMode ? 1 : 0;       // mode flag — see Uniforms struct
  // Palette rotation: drift phase with zoom depth. Negative so as iter grows
  // (at deeper zoom) the palette counter-rotates and a fractal feature stays
  // roughly the same colour across frames. 0.3 cycles per decade zoom is a
  // cinematic default — tune here if flicker remains or rotation feels off.
  const zoomDecades = Math.log10(Math.max(1, HOME.scale / view.scale));
  uboF32[19] = -0.3 * zoomDecades;
  const pal = currentPalette();
  uboF32[20] = pal.a[0]; uboF32[21] = pal.a[1]; uboF32[22] = pal.a[2];
  uboF32[24] = pal.b[0]; uboF32[25] = pal.b[1]; uboF32[26] = pal.b[2];
  uboF32[28] = pal.c[0]; uboF32[29] = pal.c[1]; uboF32[30] = pal.c[2];
  uboF32[32] = pal.d[0]; uboF32[33] = pal.d[1]; uboF32[34] = pal.d[2];
  // Julia uniforms: offset 144 (kind, u32), 152 (julia_re, f32), 156 (julia_im, f32).
  uboU32[36] = view.kind === 'julia' ? 1 : 0;
  uboF32[38] = view.juliaC.re;
  uboF32[39] = view.juliaC.im;
  // Escape radius squared at offset 160 (uboF32[40]). Squared so the shader
  // does one compare instead of a sqrt per iter.
  uboF32[40] = view.escapeRadius * view.escapeRadius;
  device.queue.writeBuffer(uniformBuffer, 0, uboData);

  const isRec = isRecording && recordTexture;
  const isCap = !!captureTarget;
  const texture = isRec
    ? recordTexture
    : (isCap ? captureTarget.texture : context.getCurrentTexture());
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: texture.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'clear',
      storeOp: 'store',
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();

  // Mirror the GPU render into lastFrameTexture so the CPU phase (which
  // fires when the user zooms past GPU_SCALE_LIMIT) has a persistent copy
  // of "what's on the screen right now" to use as a seed. Skip in record /
  // capture modes — those don't go through the swapchain anyway, and the
  // copy source/dest dimensions wouldn't match.
  if (!isRec && !isCap) {
    ensureLastFrameTexture(texture.width, texture.height);
    encoder.copyTextureToTexture(
      { texture },
      { texture: lastFrameTexture },
      { width: texture.width, height: texture.height, depthOrArrayLayers: 1 }
    );
  }

  if (isRec && readbackBuffer) {
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: readbackBuffer, bytesPerRow: readbackBytesPerRow, rowsPerImage: texture.height },
      { width: texture.width, height: texture.height, depthOrArrayLayers: 1 }
    );
    // Also blit the frame to the swapchain so the user sees a live preview.
    const displayTexture = context.getCurrentTexture();
    if (displayTexture.width === texture.width && displayTexture.height === texture.height) {
      encoder.copyTextureToTexture(
        { texture },
        { texture: displayTexture },
        { width: texture.width, height: texture.height, depthOrArrayLayers: 1 }
      );
    }
  } else if (isCap) {
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: captureTarget.readback, bytesPerRow: captureTarget.bpr, rowsPerImage: texture.height },
      { width: texture.width, height: texture.height, depthOrArrayLayers: 1 }
    );
  }

  device.queue.submit([encoder.finish()]);
  // Interactive throttle: mark the GPU busy until this submission completes,
  // then pump requestRender so the latest view state (possibly updated by
  // clicks during the submit) gets rendered. Recording has its own inflight
  // bookkeeping and bypasses requestRender, so this is safe during records.
  gpuBusy = true;
  device.queue.onSubmittedWorkDone().then(() => {
    gpuBusy = false;
    if (renderNeeded && !isRecording) requestRender();
  }, (err) => {
    // A canvas resize or lost context can reject the waiter. Always release
    // the gate so subsequent renders can still go through instead of
    // silently freezing the canvas.
    console.error('GPU onSubmittedWorkDone rejected:', err);
    gpuBusy = false;
    if (renderNeeded && !isRecording) requestRender();
  });
  updateHUD();
}

// ---------- Backend selection (GPU vs CPU) ----------
// The WGSL shader uses TD-f32 per-pixel math (~21 digits), so it starts
// producing garbage past ~10^21 zoom. The CPU worker pool runs the same
// perturbation algorithm in DD-f64 (~31 digits), pushing the wall out to
// ~10^28 at the cost of ~1000x throughput.
//
//   renderBackend === 'auto'  → GPU until zoom crosses the TD-f32 wall
//   renderBackend === 'gpu'   → force GPU (one-colour garbage past ~10^17)
//   renderBackend === 'cpu'   → force CPU (slow but correct everywhere)
//
// Threshold rationale: TD-f32 has ~21 decimal digits of relative precision,
// but perturbation iteration accumulates rounding errors as the running
// orbit-delta passes through values up to |z|≈2. Empirically, by the time
// the user reaches display zoom ~10^17 the GPU output starts going uniform
// (per-pixel deltas get aliased into the same rounding bucket), and by
// ~10^20 the canvas is fully black even though the renderer is "working".
// Hand-off to the DD/QD CPU paths well before that wall — 1e-15 gives ~5
// orders of headroom over what TD-f32 can safely resolve, and CPU
// progressive at zoom 10^15 still finishes the d=4 phase in a couple
// seconds.
const GPU_SCALE_LIMIT = 1e-15;
let renderBackend = 'auto';

function effectiveBackend() {
  if (renderBackend !== 'auto') return renderBackend;
  return view.scale < GPU_SCALE_LIMIT ? 'cpu' : 'gpu';
}

// Two algorithms:
//  - direct: z = z² + c per pixel in plain f32. Simple, no reference orbit.
//    Good while pixel size > f32 precision (≈ 2·10⁻⁷ near the magnitude-2
//    escape bound). Fails past zoom ~10⁶, but we switch earlier with margin.
//  - perturbation: each pixel iterates w = 2zw + w² + δ off a high-precision
//    reference orbit. Works to ~10²¹ on the GPU shader (TD-f32 ≈ 21 digits).
// CPU mode is itself perturbation, just in DD-f64 on the worker pool.
const DIRECT_ZOOM_LIMIT = 1e5;
function effectiveTechnique() {
  if (effectiveBackend() === 'cpu') return 'cpu-perturbation';
  const zoom = HOME.scale / view.scale;
  return zoom < DIRECT_ZOOM_LIMIT ? 'direct' : 'perturbation';
}

// Screenshot pipeline: one-shot texture + readback buffer. When non-null,
// render() writes to this texture and copies the result to the buffer. The
// takeScreenshot() handler awaits the buffer, decodes it to a PNG blob, and
// hands it to both the disk-download path and the system clipboard.
let captureTarget = null;

// ---------- CPU renderer ----------
// Pool of workers. Default is (hardware cores − 1) so the main thread still
// has room to composite and handle input; the user can override via the
// top-bar "cpus" input (persisted in localStorage). Resizing defers until
// the current render finishes so we never terminate a busy worker.
const CPU_COUNT_KEY = 'cpuWorkerCount';
const CPU_COUNT_DEFAULT = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
const CPU_COUNT_MAX = Math.max(1, navigator.hardwareConcurrency || 8);
let cpuWorkers = [];
let pendingCpuCount = null;

function spawnCpuWorker() {
  const w = new Worker(new URL('./cpu-render-worker.js', import.meta.url), { type: 'module' });
  // Surface worker-internal errors and structured-clone failures to the
  // console — without this the worker can die silently and main just sees
  // an event that never arrives, leaving the "0/9 tiles" indicator stuck.
  w.addEventListener('error', (e) => {
    console.error('[cpu-worker] error:', e.message || e, e);
  });
  w.addEventListener('messageerror', (e) => {
    console.error('[cpu-worker] messageerror (clone failed):', e);
  });
  return w;
}

function applyCpuWorkerCount(n) {
  while (cpuWorkers.length > n) cpuWorkers.pop().terminate();
  while (cpuWorkers.length < n) cpuWorkers.push(spawnCpuWorker());
}

function setCpuWorkerCount(n) {
  n = Math.max(1, Math.min(CPU_COUNT_MAX, n | 0));
  if (cpuRenderInFlight) {
    pendingCpuCount = n;
  } else {
    applyCpuWorkerCount(n);
  }
  return n;
}

function currentCpuWorkerCount() {
  return pendingCpuCount != null ? pendingCpuCount : cpuWorkers.length;
}

// Declare the in-flight flag early so setCpuWorkerCount can reference it.
let cpuRenderInFlight = false;

// Seed the pool with the saved or default count.
{
  const saved = parseInt(localStorage.getItem(CPU_COUNT_KEY), 10);
  const initial = Number.isFinite(saved) && saved > 0 ? saved : CPU_COUNT_DEFAULT;
  applyCpuWorkerCount(Math.max(1, Math.min(CPU_COUNT_MAX, initial)));
}

// Clean up workers on tab close so we don't leak threads on SPA-style navs.
window.addEventListener('beforeunload', () => {
  for (const w of cpuWorkers) w.terminate();
  cpuWorkers = [];
});

// Dedicated blit texture so the CPU path doesn't compete with screenshot /
// recording textures. Lazily sized to canvas dimensions.
// RENDER_ATTACHMENT is required so we can clear it to black between renders
// (otherwise stale pixels from previous renders show through wherever the
// new tiles haven't yet written).
let cpuBlitTexture = null;

// Persistent "last GPU frame" texture. WebGPU swapchain textures returned
// by `context.getCurrentTexture()` are guaranteed to start zeroed per spec
// (https://gpuweb.github.io/gpuweb/#dom-gpucanvascontext-getcurrenttexture),
// so we cannot read back the previously-displayed frame from the swapchain.
// Instead, every time GPU mode finishes a render-pass, we copy the freshly-
// rendered swapchain texture into this side-texture. On the GPU→CPU
// transition that fires at zoom > GPU_SCALE_LIMIT, the CPU phase uses this
// to seed cpuBlitTexture so the user sees their last GPU render (linearly
// upscaled) for the seconds it takes the first deep-zoom CPU tile to land,
// instead of a black canvas.
let lastFrameTexture = null;
function ensureLastFrameTexture(w, h) {
  if (lastFrameTexture && lastFrameTexture.width === w && lastFrameTexture.height === h) return;
  if (lastFrameTexture) lastFrameTexture.destroy();
  lastFrameTexture = device.createTexture({
    size: [w, h, 1],
    format,
    usage: GPUTextureUsage.COPY_DST
         | GPUTextureUsage.COPY_SRC
         | GPUTextureUsage.TEXTURE_BINDING,
  });
  console.log(`[ensureLastFrameTexture] allocate ${w}×${h}`);
}

function ensureCpuBlitTexture(w, h) {
  if (cpuBlitTexture && cpuBlitTexture.width === w && cpuBlitTexture.height === h) return;
  if (cpuBlitTexture) {
    console.log(`[ensureCpuBlitTexture] destroy ${cpuBlitTexture.width}×${cpuBlitTexture.height}, allocate ${w}×${h}`);
    cpuBlitTexture.destroy();
  } else {
    console.log(`[ensureCpuBlitTexture] allocate ${w}×${h} (first time)`);
  }
  cpuBlitTexture = device.createTexture({
    size: [w, h, 1],
    format,
    // TEXTURE_BINDING is required so blitUpscale() can sample from this
    // texture in its fragment shader. Without it, every CreateBindGroup
    // call inside blitUpscale fails the validation
    //   "usage doesn't include TextureUsage::TextureBinding"
    // and the swapchain never gets the new tile pixels — workers complete,
    // yellow flashes appear, but the canvas stays black.
    usage: GPUTextureUsage.RENDER_ATTACHMENT
         | GPUTextureUsage.COPY_DST
         | GPUTextureUsage.COPY_SRC
         | GPUTextureUsage.TEXTURE_BINDING,
  });
}
// Briefly overlay a yellow-bordered div at the canvas region a tile just
// updated. Pure DOM — fades via CSS animation, then garbage-collects itself.
// `targetW`/`targetH` are the staging-texture (canvas) pixel dimensions so we
// can scale tile coords back into CSS pixels.
// Nearest-neighbor upscale of a tightly-packed RGBA/BGRA buffer. Used to
// pre-seed a higher-resolution staging texture with the previous phase's
// pixels so tiles that miss the per-tile timeout fall back to the lower-res
// content instead of black strips. NN is fine here — the result is a stop-gap
// the worker tiles overwrite as they finish; a fancier filter would just burn
// CPU on pixels that get replaced anyway.
function upscalePixelsNN(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint8Array(dstW * dstH * 4);
  const sxScale = srcW / dstW;
  const syScale = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor(y * syScale));
    const srcRow = sy * srcW * 4;
    const dstRow = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x * sxScale));
      const s = srcRow + sx * 4;
      const o = dstRow + x * 4;
      dst[o + 0] = src[s + 0];
      dst[o + 1] = src[s + 1];
      dst[o + 2] = src[s + 2];
      dst[o + 3] = 255;
    }
  }
  return dst;
}

// Check whether a tile's RGBA pixel buffer contains any non-black pixels.
// Sub-samples every 16th pixel for speed (a fully-uniform tile has a uniform
// stride pattern so we never need to check every byte). Used to suppress
// the yellow flash overlay on tiles that came back entirely in-set, which
// happens a lot at deep zoom with a short reference orbit and would
// otherwise misleadingly suggest "useful tile arrived" when it was actually
// all-black.
function tileHasVisiblePixels(tilePixels) {
  if (!tilePixels || tilePixels.length === 0) return false;
  // Stride 64 bytes = 16 pixels. Tiles are typically tens of thousands of
  // pixels so this samples ~1k positions — fast and statistically reliable.
  for (let i = 0; i < tilePixels.length; i += 64) {
    if (tilePixels[i] | tilePixels[i + 1] | tilePixels[i + 2]) return true;
  }
  return false;
}

function flashTileRegion(tx, ty, tw, th, targetW, targetH) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const sx = rect.width / targetW;
  const sy = rect.height / targetH;
  const flash = document.createElement('div');
  flash.className = 'tile-flash';
  flash.style.left = (rect.left + tx * sx) + 'px';
  flash.style.top = (rect.top + ty * sy) + 'px';
  flash.style.width = (tw * sx) + 'px';
  flash.style.height = (th * sy) + 'px';
  document.body.appendChild(flash);
  // CSS animation is 600ms; remove the element shortly after so the DOM
  // doesn't accumulate dead nodes.
  setTimeout(() => flash.remove(), 700);
}

function clearCpuBlitTexture() {
  if (!cpuBlitTexture) return;
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: cpuBlitTexture.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'clear',
      storeOp: 'store',
    }],
  });
  pass.end();
  device.queue.submit([enc.finish()]);
}

// Visible CPU-render indicator. Shows while tiles are outstanding so the
// user sees progress instead of a frozen stale image. Count is updated live
// via the per-tile Promise resolution.
const cpuStatusEl = document.getElementById('cpu-status');
const cpuStatusTextEl = document.getElementById('cpu-status-text');
function showCpuStatus(text) {
  if (!cpuStatusEl) return;
  if (cpuStatusTextEl && text) cpuStatusTextEl.textContent = text;
  cpuStatusEl.classList.add('active');
}
function hideCpuStatus() {
  if (!cpuStatusEl) return;
  cpuStatusEl.classList.remove('active');
}

// cpuRenderPixels: shared compute path. Returns an Uint8Array of w*h*4 bytes
// in the channel order requested by `wantBgra`. Pure function of the current
// view + orbitCache; safe to call from interactive render AND the record loop.
//
// onTile(tileX, tileY, tileW, tileH, pixels) fires on every tile arrival
// with already-channel-swapped pixels — caller can blit incrementally as
// tiles complete instead of waiting for the full Promise.all.
// Per-dispatch request id. Workers echo this back; handlers drop responses
// whose id doesn't match. Without it, a stale handler from a cancelled
// progressiveRender (whose await never returned) keeps listening on the
// worker, and a NEW dispatch's response fires it too — hands stale pixel
// dimensions to onTile and triggers a WebGPU validation error.
let cpuDispatchReqId = 0;
// Outstanding dispatches: reqId → list of {tile, resolve} entries. When a
// new dispatch starts while previous ones are still in-flight, we resolve
// the leftover promises (with empty-pixel results so any onProgress
// counters wrap up gracefully) and terminate+respawn workers to drop their
// queued messages. Without this guard, rapid clicks/spaces at deep zoom
// pile orbit-clones into worker queues — each pending postMessage holds
// its own ~5MB structured-clone of the orbit Float64Array, so 100 queued
// messages × 9 workers × 5MB = ~4.5GB and we OOM the tab (or crash the
// GPU process and freeze every other WebGPU tab in the browser).
const cpuDispatchEntries = new Map();   // reqId → [{tile, resolve}]
function cancelInFlightCpuDispatches() {
  if (cpuDispatchEntries.size === 0) return;
  const stale = cpuDispatchEntries.size;
  let resolvedTiles = 0;
  for (const entries of cpuDispatchEntries.values()) {
    for (const entry of entries) {
      const { tile, resolve } = entry;
      const empty = new ArrayBuffer(tile.w * tile.h * 4);
      resolve({ tileX: tile.x, tileY: tile.y, tileW: tile.w, tileH: tile.h, pixels: empty });
      resolvedTiles++;
    }
  }
  cpuDispatchEntries.clear();
  // Terminate + respawn the worker pool. The workers may have queued
  // messages from the dispatches we just cancelled; killing them drops
  // those queued clones, immediately freeing the memory they held.
  const targetCount = cpuWorkers.length;
  for (const w of cpuWorkers) w.terminate();
  cpuWorkers = [];
  for (let i = 0; i < targetCount; i++) cpuWorkers.push(spawnCpuWorker());
  console.warn(`[cpuRenderPixels] cancelled ${stale} prior dispatch(es), resolved ${resolvedTiles} tile promises with empty pixels, respawned ${targetCount} workers (frees queued message memory)`);
}
async function cpuRenderPixels(w, h, maxIter, wantBgra, onProgress, onTile, opts) {
  if (orbitDirty || !orbitCache.orbitDD || orbitCache.len === 0) return null;
  // Guard: drop any prior in-flight dispatches before we add work to the
  // worker queues. See cpuDispatchEntries comment above.
  if (cpuDispatchEntries.size > 0) cancelInFlightCpuDispatches();

  // Auto-select per-pixel precision from zoom depth (or honor caller's
  // override via opts.precision). Past 10^31 the DD-f64 mantissa stops being
  // enough; the orbit-worker emits orbitQD storage automatically at the same
  // threshold so this just needs to know which kernel to dispatch.
  const zoomDigits = Math.abs(view.scale) > 0 ? Math.ceil(Math.log10(1 / Math.abs(view.scale))) : 0;
  const QD_THRESHOLD = 31;
  const precision = opts?.precision ?? (zoomDigits >= QD_THRESHOLD ? 'qd' : 'dd');
  if (precision === 'qd' && !orbitCache.orbitQD) {
    // Caller asked for QD but the orbit worker hasn't emitted QD samples
    // (cache is from a sub-10^31 fetch). Fall back to DD; the next orbit
    // refresh past 10^31 will populate orbitQD.
    console.log(`[cpuRenderPixels] precision=qd requested but orbitQD missing — falling back to DD (orbit-worker hadn't crossed the QD_THRESHOLD when this orbit was computed)`);
  }
  const usingQD = precision === 'qd' && orbitCache.orbitQD;

  // DD-f64 path: same mantissa+exp layout the GPU shader uses.
  // QD-f64 path: no frame_exp; the QD components carry the full magnitude
  // because f64 has range down to ~10^-308 — far below any zoom we render.
  const scaleAbs = Math.abs(view.scale);
  const frameExp = scaleAbs > 0 ? Math.floor(Math.log2(scaleAbs)) : 0;
  const invFactor = Math.pow(2, -frameExp);
  const [scaleMantHi, scaleMantLo] = decimalToDD(new Decimal(view.scale).times(invFactor));
  const [deltaReHi, deltaReLo] = decimalToDD(view.cx.minus(orbitCache.refCx).times(invFactor));
  const [deltaImHi, deltaImLo] = decimalToDD(view.cy.minus(orbitCache.refCy).times(invFactor));

  // QD payload (only built when needed).
  let scaleQD = null, deltaReQD = null, deltaImQD = null;
  if (usingQD) {
    scaleQD   = decimalToQD(new Decimal(view.scale));
    deltaReQD = decimalToQD(view.cx.minus(orbitCache.refCx));
    deltaImQD = decimalToQD(view.cy.minus(orbitCache.refCy));
  }

  const pal = currentPalette();
  const zoomDecades = Math.log10(Math.max(1, HOME.scale / view.scale));
  const paletteOffset = -0.3 * zoomDecades;

  // Partition canvas into horizontal strips, one per worker. Last strip
  // absorbs the remainder so no rows are lost to flooring.
  const N = cpuWorkers.length;
  const rowsPerTile = Math.floor(h / N);
  const tiles = [];
  let yCursor = 0;
  for (let i = 0; i < N; i++) {
    const rows = (i === N - 1) ? (h - yCursor) : rowsPerTile;
    if (rows > 0) tiles.push({ x: 0, y: yCursor, w, h: rows });
    yCursor += rows;
  }

  // QD path uses a wholly different orbit storage (8 doubles/iter vs 4) and
  // a different inner kernel. The worker's `precision` flag picks which.
  const orbit = usingQD ? orbitCache.orbitQD : orbitCache.orbitDD;
  const orbitLen = orbitCache.len;
  const palettePayload = { a: pal.a, b: pal.b, c: pal.c, d: pal.d, offset: paletteOffset };

  // Each worker gets one tile; listener resolves on matching tile coords.
  // Workers process messages FIFO so cross-tile aliasing can't occur here.
  let tilesDone = 0;
  const totalTiles = tiles.length;
  if (onProgress) onProgress(tilesDone, totalTiles, /*rowsAcrossWorkers*/ 0, /*totalRowsAcrossWorkers*/ 0);
  // Per-worker row progress reporter: workers periodically post
  // {type:'progress', tileX, tileY, rowsDone, totalRows}; we aggregate them
  // into a single "rows done across all in-flight workers" number that the
  // status pill can show, so a long tile doesn't sit at "0/N tiles" for
  // minutes at deep zoom — the elapsed-rows count keeps moving.
  const rowsByTile = new Map();    // key = `${tx},${ty}` → rowsDone
  const totalRowsAcrossTiles = tiles.reduce((s, t) => s + t.h, 0);
  function aggregateRowsDone() {
    let sum = 0;
    for (const v of rowsByTile.values()) sum += v;
    return sum;
  }
  // Per-tile timeout. At deep zoom on a slow machine a tile can take many
  // seconds; 90s is generous for everything short of "this worker is wedged".
  // On timeout we resolve with an empty (black) tile so the rest of the
  // pipeline doesn't hang waiting on one stuck worker.
  // HQ overrides this with a much longer timeout (or Infinity): full-canvas
  // tiles at deep zoom legitimately need many minutes, and bailing them out
  // at 90s leaves cpuBlitTexture in a half-written state that blitUpscale
  // then samples as black/garbage strips.
  const TILE_TIMEOUT_MS = opts?.timeoutMs ?? 90000;
  const dispatchT0 = performance.now();
  const reqId = ++cpuDispatchReqId;
  console.log(`[cpuRenderPixels] req#${reqId} dispatching ${tiles.length} tiles to ${cpuWorkers.length} workers (canvas ${w}×${h}, ${maxIter} iters, precision=${usingQD ? 'qd' : 'dd'}, frameExp=${frameExp}, timeoutMs=${TILE_TIMEOUT_MS === Infinity ? 'none' : TILE_TIMEOUT_MS})`);
  // Register this dispatch in the global registry so cancelInFlightCpuDispatches
  // can resolve our outstanding promises if a NEXT dispatch arrives before
  // we finish.
  const myEntries = [];
  cpuDispatchEntries.set(reqId, myEntries);
  const results = await Promise.all(tiles.map((tile, i) => new Promise((resolve) => {
    myEntries.push({ tile, resolve });
    const worker = cpuWorkers[i];
    let done = false;
    // Skip the timeout entirely when caller passed Infinity (HQ render).
    // The user cancels via the HQ button (which bumps progressiveGen → onTile
    // bails) — the timeout safety net is only needed for interactive paths
    // where a wedged worker would otherwise hang the progressive chain.
    const timeout = TILE_TIMEOUT_MS === Infinity ? null : setTimeout(() => {
      if (done) return;
      done = true;
      worker.removeEventListener('message', handler);
      console.warn(`[cpu-worker ${i}] req#${reqId} tile (${tile.x},${tile.y} ${tile.w}×${tile.h}) timed out after ${TILE_TIMEOUT_MS} ms — resolving with empty pixels`);
      const empty = new ArrayBuffer(tile.w * tile.h * 4);
      tilesDone++;
      rowsByTile.set(`${tile.x},${tile.y}`, tile.h);
      if (onProgress) onProgress(tilesDone, totalTiles, aggregateRowsDone(), totalRowsAcrossTiles);
      resolve({ tileX: tile.x, tileY: tile.y, tileW: tile.w, tileH: tile.h, pixels: empty });
    }, TILE_TIMEOUT_MS);
    const handler = (ev) => {
      // First filter: ignore responses from older dispatches that this
      // worker is still draining. Without this, a still-attached handler
      // from a cancelled progressiveRender fires for a NEW dispatch's
      // response and uses stale tile dimensions for the upload.
      if (ev.data.reqId !== reqId) return;
      if (ev.data.tileX !== tile.x || ev.data.tileY !== tile.y) return;
      // Per-row progress messages: update the aggregate counter and notify
      // the caller via onProgress with the row-progress numbers. They share
      // the channel with the final tile-done message; differentiated by
      // ev.data.type === 'progress'.
      if (ev.data.type === 'progress') {
        rowsByTile.set(`${tile.x},${tile.y}`, ev.data.rowsDone);
        if (onProgress) onProgress(tilesDone, totalTiles, aggregateRowsDone(), totalRowsAcrossTiles);
        return;
      }
      if (done) return;
      done = true;
      clearTimeout(timeout);
      worker.removeEventListener('message', handler);
      tilesDone++;
      // Mark this tile fully-done in the row map (so aggregateRowsDone()
      // continues to reflect the truth after completion).
      rowsByTile.set(`${tile.x},${tile.y}`, tile.h);
      const elapsed = performance.now() - dispatchT0;
      console.log(`[cpu-worker ${i}] req#${reqId} tile done after ${elapsed.toFixed(0)}ms (${tilesDone}/${totalTiles})`);
      // Fire per-tile callback with channel-swapped pixels so the caller
      // doesn't have to redo the BGRA swap.
      if (onTile) {
        const tilePx = new Uint8ClampedArray(ev.data.pixels);
        let processed;
        if (!wantBgra) {
          processed = tilePx;
        } else {
          processed = new Uint8Array(tilePx.length);
          for (let p = 0; p < tilePx.length; p += 4) {
            processed[p + 0] = tilePx[p + 2];
            processed[p + 1] = tilePx[p + 1];
            processed[p + 2] = tilePx[p + 0];
            processed[p + 3] = 255;
          }
        }
        onTile(tile.x, tile.y, tile.w, tile.h, processed);
      }
      if (onProgress) onProgress(tilesDone, totalTiles, aggregateRowsDone(), totalRowsAcrossTiles);
      resolve(ev.data);
    };
    worker.addEventListener('message', handler);
    worker.postMessage({
      reqId,
      tileX: tile.x, tileY: tile.y, tileW: tile.w, tileH: tile.h,
      canvasW: w, canvasH: h,
      orbit, orbitLen,
      // DD payload (always sent — used by renderTile when precision='dd').
      scaleMantHi, scaleMantLo, frameExp,
      deltaReHi, deltaReLo, deltaImHi, deltaImLo,
      // QD payload (only when precision='qd'; renderTileQD reads these).
      precision: usingQD ? 'qd' : 'dd',
      scaleQD, deltaReQD, deltaImQD,
      maxIter,
      palette: palettePayload,
      // Julia plumbing: kind selects the iteration init/recurrence branch in
      // cpu-render-core. juliaC is unused by Mandelbrot but harmless to send.
      kind: view.kind,
    });
  })));
  // Dispatch's tiles all settled (real completions, timeouts, or cancellations).
  // Drop the registry entry so a future dispatch's cancel-loop doesn't try to
  // re-resolve already-settled promises (idempotent but still wasted work).
  cpuDispatchEntries.delete(reqId);

  // Assemble tiles. Worker writes RGBA; swap B<->R when the caller wants BGRA
  // (Mac WebGPU swapchain format).
  const full = new Uint8Array(w * h * 4);
  for (const r of results) {
    const tilePx = new Uint8ClampedArray(r.pixels);
    for (let ty = 0; ty < r.tileH; ty++) {
      const srcRow = ty * r.tileW * 4;
      const dstRow = ((r.tileY + ty) * w + r.tileX) * 4;
      if (!wantBgra) {
        full.set(tilePx.subarray(srcRow, srcRow + r.tileW * 4), dstRow);
      } else {
        for (let tx = 0; tx < r.tileW; tx++) {
          const s = srcRow + tx * 4;
          const d = dstRow + tx * 4;
          full[d + 0] = tilePx[s + 2]; // B ← R
          full[d + 1] = tilePx[s + 1];
          full[d + 2] = tilePx[s + 0]; // R ← B
          full[d + 3] = 255;
        }
      }
    }
  }
  return full;
}

// Helper: upload a pre-rendered RGBA/BGRA pixel buffer onto the swapchain.
// Shared between cpuRender (interactive) and progressiveRender's slow path
// (per-phase blits) so both write through the same code.
function blitCpuPixels(pixels, w, h) {
  ensureCpuBlitTexture(w, h);
  device.queue.writeTexture(
    { texture: cpuBlitTexture },
    pixels.buffer,
    { bytesPerRow: w * 4, rowsPerImage: h },
    { width: w, height: h, depthOrArrayLayers: 1 }
  );
  const displayTex = context.getCurrentTexture();
  if (displayTex.width === w && displayTex.height === h) {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: cpuBlitTexture },
      { texture: displayTex },
      { width: w, height: h, depthOrArrayLayers: 1 }
    );
    device.queue.submit([encoder.finish()]);
  }
}

// Interactive CPU render: rates pixels via cpuRenderPixels, uploads to a blit
// texture, copy-blits onto the swapchain. Generations drop stale results so
// a mid-flight click that fires a fresher render doesn't get stomped.
// cpuRenderInFlight is declared up with the worker-pool helpers so they can
// defer a resize until the current render finishes.
let cpuRenderGen = 0;
let cpuRenderQueued = false;

async function cpuRender() {
  if (cpuRenderInFlight) { cpuRenderQueued = true; return; }
  // progressiveRender owns the CPU pipeline whenever it's running — phases
  // [4, 2] already cover preview + final at controlled iter caps. Letting a
  // requestRender() (e.g. from the orbit-worker handler after the post-click
  // orbit lands) drop into cpuRender here would dispatch a parallel full-res
  // 2000-iter render that hogs all 9 workers, blocking progressive's d=4
  // preview from starting for 20+ seconds. The user's click then APPEARS to
  // be ignored even though view.cx/cy were updated correctly.
  if (progressiveActive) return;
  // Drag-pan in CPU mode would queue a CPU render per pointermove (60Hz). Each
  // render takes 5–30s and workers process messages serially with no cancel
  // mechanism, so a few seconds of panning queues minutes of unfinishable work
  // and saturates worker queues — the tab and Chrome become unresponsive
  // because the orbit Float64Array gets structured-cloned to all 9 workers on
  // every dispatch. Skip CPU rendering entirely while dragging; pointerup
  // calls exitDragQuality → resize → requestRender, which will fire one
  // cpuRender for the final view.
  if (dragLowRes) return;

  // Orbit refresh used to piggy-back on the GPU render() path. In CPU mode
  // that path is never taken, so cpuRender has to drive the orbit worker
  // itself — otherwise the cache stays stale (or empty on first CPU frame)
  // and every pixel perturbs off the wrong reference, producing an all-black
  // image. Fire the request then wait for the worker's response to re-enter.
  const aspectForOrbit = canvas.width / canvas.height;
  requestOrbitUpdateAsync(view.cx, view.cy, view.scale, aspectForOrbit, computeOrbitMaxIter());
  if (orbitDirty || !orbitCache.orbitDD || orbitCache.len === 0) {
    // Wait for the orbit worker; response handler calls requestRender again.
    return;
  }

  cpuRenderInFlight = true;
  const myGen = ++cpuRenderGen;
  const renderT0 = performance.now();
  try {
    const w = canvas.width;
    const h = canvas.height;
    const maxIter = computePixelMaxIter();
    const wantBgra = format === 'bgra8unorm';

    showCpuStatus(`rendering on CPU (${maxIter} iters)… 0 / ${cpuWorkers.length} tiles · 0%`);
    const pixels = await cpuRenderPixels(w, h, maxIter, wantBgra, (done, total, rowsDone, totalRows) => {
      if (myGen !== cpuRenderGen) return;
      const pct = totalRows > 0 ? Math.round(100 * rowsDone / totalRows) : 0;
      showCpuStatus(`rendering on CPU (${maxIter} iters)… ${done}/${total} tiles · ${pct}%`);
    });
    if (myGen !== cpuRenderGen || !pixels) { hideCpuStatus(); return; }

    blitCpuPixels(pixels, w, h);
    const elapsedMs = Math.round(performance.now() - renderT0);
    showCpuStatus(`CPU render: ${elapsedMs} ms · ${cpuWorkers.length} cores`);
    setTimeout(() => {
      // Auto-hide only if a newer render didn't take over in the meantime.
      if (myGen === cpuRenderGen) hideCpuStatus();
    }, 1500);
    updateHUD();
  } finally {
    cpuRenderInFlight = false;
    // Apply any worker-count resize the user requested while we were busy.
    if (pendingCpuCount != null) { applyCpuWorkerCount(pendingCpuCount); pendingCpuCount = null; }
    if (cpuRenderQueued) { cpuRenderQueued = false; cpuRender(); }
  }
}

// Backend-aware render dispatcher. rAF callbacks (requestRender) route
// through this so the choice of GPU vs CPU is reconsidered every frame.
function dispatchRender() {
  if (effectiveBackend() === 'cpu') {
    cpuRender();
  } else {
    render();
  }
}

// Record pipeline uses a PAIR of record textures and readback buffers so the
// GPU can start frame N+1 while the CPU processes frame N. `recordTexture`
// (singular) points at the slot the render() function is currently writing to.
let recordTextures = [null, null];
let recordTexture = null;
function ensureRecordTextures(width, height) {
  const ok = recordTextures.every(t => t && t.width === width && t.height === height);
  if (ok) return;
  disposeRecordTextures();
  for (let i = 0; i < 2; i++) {
    recordTextures[i] = device.createTexture({
      size: [width, height, 1],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  }
}
function disposeRecordTextures() {
  for (const t of recordTextures) if (t) t.destroy();
  recordTextures = [null, null];
  recordTexture = null;
}

// The record pipeline alternates between two readback buffers; render() picks
// one by pointing `readbackBuffer` / `readbackBytesPerRow` at the current slot.
let readbackBuffer = null;
let readbackBytesPerRow = 0;
let recordReadbackBuffers = [null, null];
function ensureRecordReadbackPair(width, height) {
  const bpr = Math.ceil(width * 4 / 256) * 256;
  const ok = recordReadbackBuffers.every(b => b && b._w === width && b._h === height);
  if (ok) return bpr;
  disposeRecordReadbackPair();
  for (let i = 0; i < 2; i++) {
    const b = device.createBuffer({
      size: bpr * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    b._w = width; b._h = height; b._bpr = bpr;
    recordReadbackBuffers[i] = b;
  }
  readbackBytesPerRow = bpr;
  return bpr;
}
function disposeRecordReadbackPair() {
  for (const b of recordReadbackBuffers) if (b) b.destroy();
  recordReadbackBuffers = [null, null];
}

function disposeReadback() {
  readbackBuffer = null;
  disposeRecordReadbackPair();
  readbackBytesPerRow = 0;
}

function disposeRecordTexture() { disposeRecordTextures(); } // back-compat name

// Drop to a coarse render target during interactive pans so the image keeps up
// with the cursor. CSS stretches the small canvas to the viewport — it looks
// pixelated while dragging, then snaps back to full quality on pointerup.
// Declared before resize() so the initial resize() call isn't hit by a TDZ.
const DRAG_LOWRES_DIVISOR = 4;
let dragLowRes = false;

function resize() {
  if (isRecording) return;
  if (dragLowRes) return;   // Don't bump back to full res mid-drag.
  const dpr = window.devicePixelRatio || 1;
  // Keep dimensions even for H.264 encoding.
  const w = Math.max(2, Math.floor(canvas.clientWidth * dpr / 2) * 2);
  const h = Math.max(2, Math.floor(canvas.clientHeight * dpr / 2) * 2);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  requestRender();
}
window.addEventListener('resize', resize);
resize();

function enterDragQuality() {
  if (dragLowRes || isRecording) return;
  dragLowRes = true;
  const w = Math.max(2, Math.floor(canvas.width / DRAG_LOWRES_DIVISOR / 2) * 2);
  const h = Math.max(2, Math.floor(canvas.height / DRAG_LOWRES_DIVISOR / 2) * 2);
  canvas.width = w;
  canvas.height = h;
}
function exitDragQuality() {
  if (!dragLowRes) return;
  dragLowRes = false;
  resize(); // snaps canvas back to CSS × DPR
}

// Click-zoom progressive render. Four phases, each at a finer resolution:
//   1/8 → 1/4 → 1/2 → full. The first three run back-to-back (cheap), and
//   we then pause for idle before kicking off the expensive full-res phase —
//   a click during that pause bumps progressiveGen and aborts the chain, so
//   rapid clicks never tie up the GPU with big renders.
let progressiveGen = 0;
// GPU mode: a SINGLE auto-fired phase at d=4 (1/4 canvas DPR — fast even
// at deep zoom). Higher quality is explicit-only via the `h` shortcut
// (renderAtQualityTier). Used to be [4, 1] but the auto d=1 took multiple
// seconds at zoom 10^11+ and made "click → see something" feel laggy; the
// user wants the auto-render to be one fast pass and let them decide
// whether to spend on quality.
const PROGRESSIVE_PHASES = [4];
const PROGRESSIVE_IDLE_MS = 2000;  // idle window before the final full-res phase

function setCanvasDivisor(d) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(2, Math.floor(canvas.clientWidth * dpr / d / 2) * 2);
  const h = Math.max(2, Math.floor(canvas.clientHeight * dpr / d / 2) * 2);
  if (canvas.width !== w || canvas.height !== h) {
    console.log(`[setCanvasDivisor] d=${d}: ${canvas.width}×${canvas.height} → ${w}×${h} (clears swapchain to black)`);
    canvas.width = w;
    canvas.height = h;
  }
}

const clickSpinner = document.getElementById('click-spinner');
// When active, pointermove updates the spinner position so it glides with the
// cursor during the idle-debounce phase — otherwise a user who nudges the
// mouse after clicking sees the countdown pinned to stale coordinates.
let clickSpinnerActive = false;
function showClickSpinner(x, y) {
  clickSpinner.style.left = x + 'px';
  clickSpinner.style.top  = y + 'px';
  clickSpinner.classList.remove('active');
  void clickSpinner.offsetWidth; // force reflow so a repeat click restarts the fill
  clickSpinner.classList.add('active');
  clickSpinnerActive = true;
}
function hideClickSpinner() {
  clickSpinner.classList.remove('active');
  clickSpinnerActive = false;
}
function moveClickSpinner(x, y) {
  if (!clickSpinnerActive) return;
  clickSpinner.style.left = x + 'px';
  clickSpinner.style.top  = y + 'px';
}

// While the full-res phase is rendering, we lock out new clicks so a burst
// of zooms can't queue up back-to-back expensive renders + orbit-worker
// requests — that combination has crashed the tab at deep zoom.
let fullResLocked = false;
function unlockFullRes() {
  if (!fullResLocked) return;
  fullResLocked = false;
  canvas.style.cursor = '';
}

// Set while progressiveRender owns the render pipeline. cpuRender bails when
// this is true so a stray requestRender() (e.g. from the orbit-worker handler
// after a fresh orbit lands) doesn't fire a parallel full-res CPU render
// that hogs all 9 workers and starves the progressive phase chain.
let progressiveActive = false;

async function progressiveRender() {
  if (isRecording) { requestRender(); return; }
  // Drain any leftover CPU worker dispatches before starting. The cancel-
  // on-new guard inside cpuRenderPixels only fires when the NEW render is
  // also CPU-bound. But zoom-out / preset / reset / typed-zoom can switch
  // from a deep-zoom CPU view to a shallow GPU view without ever calling
  // cpuRenderPixels — meaning the previous dispatch's workers keep
  // grinding through their queued tile messages forever. After a few such
  // transitions the queued ~5MB orbit clones add up to gigabytes and the
  // tab OOMs (and on Mac can take the GPU process down with it, freezing
  // every other WebGPU tab in the browser).
  if (cpuDispatchEntries.size > 0) {
    console.warn(`[progressiveRender] draining ${cpuDispatchEntries.size} leftover CPU dispatch(es) before new render starts`);
    cancelInFlightCpuDispatches();
  }
  const myGen = ++progressiveGen;
  progressiveActive = true;
  try {
    return await progressiveRenderImpl(myGen);
  } finally {
    if (myGen === progressiveGen) progressiveActive = false;
  }
}

async function progressiveRenderImpl(myGen) {

  const cpuMode = effectiveBackend() === 'cpu';
  const tech = effectiveTechnique();
  const zoom = HOME.scale / view.scale;
  console.log(`[progressiveRender] gen=${myGen} zoom=${zoom.toExponential(2)} backend=${effectiveBackend()} technique=${tech}`);
  // Stale-indicator clear: a previous deep-zoom CPU render may have left the
  // pill at "0/9 tiles" because its workers are still grinding away (and
  // there's no cancel mechanism). If the new view doesn't need CPU, hide it
  // immediately so the user isn't staring at a misleading stuck indicator.
  if (!cpuMode) hideCpuStatus();
  const scaleAbs = Math.abs(view.scale);
  const zoomDigits = scaleAbs > 0 ? Math.ceil(Math.log10(1 / scaleAbs)) : 0;
  // Fast path: GPU + DD orbit (zoom < 10^11). Sync ensureReference is cheap
  // enough here that every phase below can actually submit a render. Slow
  // path: CPU mode OR Decimal-orbit GPU mode — skip the phase loop because
  // each setCanvasDivisor() reconfigures the WebGPU swapchain to a black
  // texture, and if the orbit hasn't returned yet that's what stays on
  // screen ("zooming stops, then black" at deep zoom).
  const fastPath = !cpuMode && zoomDigits < 12;
  console.log(`[progressiveRender] gen=${myGen} path=${fastPath ? 'FAST' : 'SLOW'} zoomDigits=${zoomDigits}`);

  if (fastPath) {
    // Direct mode skips the orbit entirely — z=z²+c per pixel needs no
    // reference. Only refresh when we'll actually use the orbit.
    if (effectiveTechnique() !== 'direct') {
      // Invalidate any in-flight async orbit request so its eventual response
      // doesn't stomp the sync-computed cache we're about to write.
      ++orbitWorkerReqId;
      orbitDirty = false;
      const aspect = canvas.width / canvas.height;
      ensureReference(view.cx, view.cy, view.scale, aspect, computeOrbitMaxIter());
    }

    let firstFrameLanded = false;
    for (const d of PROGRESSIVE_PHASES) {
      if (myGen !== progressiveGen) { hideClickSpinner(); unlockFullRes(); return; }
      // Before the final (full-res) phase, wait for the user to stop clicking.
      // The spinner counts down the idle window so the user can see how much
      // longer they have to click-cancel. Animation is pinned to
      // PROGRESSIVE_IDLE_MS in CSS.
      if (d === 1) {
        if (lastClickViewport) showClickSpinner(lastClickViewport.x, lastClickViewport.y);
        await new Promise(r => setTimeout(r, PROGRESSIVE_IDLE_MS));
        hideClickSpinner();
        if (myGen !== progressiveGen) { unlockFullRes(); return; }
        // Commit: after this point clicks are blocked until the GPU finishes.
        fullResLocked = true;
        canvas.style.cursor = 'progress';
      }
      // Drain any prior GPU work BEFORE resizing — otherwise setCanvasDivisor
      // reconfigures the swapchain while a submit is mid-flight, invalidating
      // its target texture.
      if (gpuBusy) {
        try { await device.queue.onSubmittedWorkDone(); } catch {}
      }
      setCanvasDivisor(d);
      // Direct render() call (skip requestRender). requestRender's gpuBusy
      // gate would silently defer this submit until the previous click's
      // full-res GPU work finished — which is why low-res used to land AFTER
      // the spinner appeared. Direct call always submits.
      render();
      try { await device.queue.onSubmittedWorkDone(); } catch {}
      await new Promise(r => requestAnimationFrame(r));   // browser composite
      if (!firstFrameLanded) { clearZoomPreview(); firstFrameLanded = true; }
    }

    // Wait for the full-res render to flush through. 30s ceiling so a stuck
    // pipeline can't permanently lock the UI.
    const deadline = performance.now() + 30000;
    while (myGen === progressiveGen && performance.now() < deadline) {
      if (!orbitDirty && !gpuBusy && !pendingFrame && !renderNeeded) break;
      await new Promise(r => setTimeout(r, 50));
    }
    try { await device.queue.onSubmittedWorkDone(); } catch {}
    unlockFullRes();
    return;
  }

  // Slow path: progressive phases on top of an async-orbit + (optionally)
  // CPU tile renderer. Same [4, 1] phase shape the fast path uses, so the
  // user always gets a low-res preview before paying for the full render.
  // Without phases here, a typed-in deep zoom or CPU-mode click skipped
  // straight to "rendering 0/N tiles" with a blank canvas behind it.

  // Spinner from the start so there's visible feedback during the orbit
  // refresh phase too — at deep zoom the worker alone can take seconds.
  if (lastClickViewport) showClickSpinner(lastClickViewport.x, lastClickViewport.y);

  function slowPathCleanup() {
    hideClickSpinner();
    if (cpuMode) hideCpuStatus();
    unlockFullRes();
    // CSS zoom-preview (applyZoomPreview) is normally cleared at end of
    // the d=8 phase. If the phase gets cancelled (e.g. user pressed `h`
    // mid-render → renderAtQualityTier bumps progressiveGen) the
    // post-loop clear never fires, leaving the canvas CSS-transformed
    // when the tier render writes to it — looks black/cropped.
    clearZoomPreview();
  }

  // 1) Orbit refresh — same orbit serves every phase below, so do it once.
  const aspect0 = canvas.width / canvas.height;
  const orbitWaitT0 = performance.now();
  console.log(`[progressiveRender] gen=${myGen} requesting orbit (maxIter=${computeOrbitMaxIter()})`);
  requestOrbitUpdateAsync(view.cx, view.cy, view.scale, aspect0, computeOrbitMaxIter());
  const orbitDeadline = performance.now() + 60000;
  while (myGen === progressiveGen && performance.now() < orbitDeadline) {
    if (!orbitDirty && orbitCache.orbitDD && orbitCache.len > 0) break;
    await new Promise(r => setTimeout(r, 50));
  }
  if (myGen !== progressiveGen) { slowPathCleanup(); return; }
  console.log(`[progressiveRender] gen=${myGen} orbit ready: len=${orbitCache.len} after ${(performance.now() - orbitWaitT0).toFixed(0)}ms`);

  // 2) Phase loop — low-res preview first, then full-res after the debounce.
  // CPU mode uses [4, 2] instead of [4, 1] so the user doesn't wait minutes
  // for a full-res CPU render that's not even noticeably better than 1/2.
  const phases = effectivePhases();
  const finalPhase = phases[phases.length - 1];
  let firstFrameLanded = false;
  // Hold the previous CPU phase's pixel buffer so the next phase can pre-seed
  // its (larger) staging texture with a 2× upscale of those pixels — that way
  // d=2 tiles that miss the per-tile timeout fall back to upscaled d=4 content
  // instead of the black that clearCpuBlitTexture would leave.
  let prevPhasePixels = null;
  let prevPhaseW = 0, prevPhaseH = 0;
  for (const d of phases) {
    if (myGen !== progressiveGen) { slowPathCleanup(); return; }

    if (d === finalPhase && phases.length > 1) {
      // Debounce window before the most expensive phase — rapid re-targeting
      // clicks during this 2s cancel the chain via myGen.
      // Skip when there's only one phase: the user already paid for the
      // click; making them wait an additional 2s before ANY work starts
      // is just dead time.
      await new Promise(r => setTimeout(r, PROGRESSIVE_IDLE_MS));
      if (myGen !== progressiveGen) { slowPathCleanup(); return; }
      fullResLocked = true;
      canvas.style.cursor = 'progress';
    }

    if (cpuMode) {
      const dpr = window.devicePixelRatio || 1;
      // Render width is the user/auto override. Phase divides further so d=8
      // is 1/8 of the chosen width (instant blocky preview), d=4 is 1/4.
      // Default canvas DPR is used as the upper bound — phase target can never
      // exceed the swapchain's drawing buffer (no point computing more pixels
      // than we'll ever display).
      const baseRenderW = effectiveRenderWidth();
      const baseRenderH = Math.max(2, Math.floor(baseRenderW * (canvas.clientHeight / canvas.clientWidth) / 2) * 2);
      const targetW = Math.max(2, Math.floor(baseRenderW / d / 2) * 2);
      const targetH = Math.max(2, Math.floor(baseRenderH / d / 2) * 2);
      const wantBgra = format === 'bgra8unorm';
      const phaseIters = computePixelMaxIter(d);
      const phaseT0 = performance.now();
      console.log(`[progressiveRender] gen=${myGen} CPU phase d=${d} dispatch: ${targetW}×${targetH} (render-width override=${renderWidthSelect?.value ?? 'auto'}, baseRenderW=${baseRenderW}), ${cpuWorkers.length} workers, ${phaseIters} iters (orbitLen=${orbitCache.len}; ratio iters/orbitLen=${(phaseIters / Math.max(1, orbitCache.len)).toFixed(2)})`);
      // Incremental blit: each worker tile is uploaded to a staging texture
      // as it arrives, and the staging is copy-blitted to the swapchain on
      // every tile so the user sees the canvas fill up strip-by-strip
      // instead of waiting through one long opaque "0/N tiles" pause.
      if (gpuBusy) { try { await device.queue.onSubmittedWorkDone(); } catch {} }
      // GPU→CPU transition seed: if cpuBlitTexture is null (we just came
      // from GPU mode), use lastFrameTexture as the seed source. This is
      // a persistent copy of the most recent GPU swapchain render — we
      // can't read the swapchain itself because WebGPU spec guarantees
      // textures returned by getCurrentTexture() start zeroed, so the
      // GPU render path mirrors each frame into lastFrameTexture for us.
      // This gets blitted into the new cpuBlitTexture below as the seed,
      // so the user sees their last GPU render (linearly upscaled) until
      // CPU tiles arrive — instead of a black canvas for the many seconds
      // a deep-zoom CPU pass takes.
      const swapchainSeed = (!cpuBlitTexture && lastFrameTexture) ? lastFrameTexture : null;
      if (swapchainSeed) {
        console.log(`[CPU phase] GPU→CPU transition: using lastFrameTexture ${swapchainSeed.width}×${swapchainSeed.height} as seed`);
      } else if (!cpuBlitTexture) {
        console.log(`[CPU phase] GPU→CPU transition but no lastFrameTexture available — canvas will go black until first tile arrives`);
      }
      // Resize canvas to FULL resolution (not phase resolution). cpuBlitTexture
      // holds the phase-resolution pixels; blitUpscale samples it onto the
      // full-size swapchain via a render pass with linear filtering. Skipping
      // the canvas-shrink keeps the swapchain alive across the d=4 → d=2
      // transition and lets the click-zoom CSS preview transform stay valid
      // (a canvas-resize would clear the swapchain to black, replacing the
      // preview pixels with a black-stretched canvas mid-render).
      const fullW = Math.max(2, Math.floor(canvas.clientWidth * dpr / 2) * 2);
      const fullH = Math.max(2, Math.floor(canvas.clientHeight * dpr / 2) * 2);
      if (canvas.width !== fullW || canvas.height !== fullH) {
        console.log(`[CPU phase] canvas resize ${canvas.width}×${canvas.height} → ${fullW}×${fullH} (clears swapchain to black; blitUpscale next tile fills it)`);
        canvas.width = fullW;
        canvas.height = fullH;
      }
      // Seed the new cpuBlitTexture so the canvas isn't blank while tiles
      // compute. Four sources, in order of preference:
      //   - prevPhasePixels (subsequent phase in this dispatch): upscaled
      //     CPU pixels from the previous phase.
      //   - old cpuBlitTexture (first phase of this dispatch, but a previous
      //     render left a texture lying around): GPU-side render-pass-blit
      //     with linear filtering — handles arbitrary size mismatch.
      //   - swapchainSeed (GPU→CPU transition): the swapchain content we
      //     captured above before the canvas resize wiped it.
      //   - clear to black (no previous content at all — fresh page load
      //     into CPU mode).
      // Without this seed the swapchain stays whatever colour canvas-resize
      // cleared it to (black) until the first tile arrives, which at deep
      // zoom is many seconds.
      const oldBlit = cpuBlitTexture;
      const needRealloc = !oldBlit || oldBlit.width !== targetW || oldBlit.height !== targetH;
      // First phase of a new render = view changed. We deliberately clear
      // cpuBlitTexture to black instead of seeding from the previous view's
      // pixels: combined with the d=8 skip-on-black workaround, a non-black
      // seed leaks pre-click content into "skipped" tiles and the final
      // composite looks identical to the pre-click view ("the click did
      // nothing"). prev-phase seeding (intra-render upscale) is still safe
      // because it represents the SAME view at lower resolution.
      const isFirstPhaseOfNewRender = !prevPhasePixels;
      if (needRealloc) {
        cpuBlitTexture = device.createTexture({
          size: [targetW, targetH, 1],
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST
               | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
        });
        if (isFirstPhaseOfNewRender) {
          console.log(`[CPU phase] seed selection: black (first phase of new render — discard cross-render content to avoid view-leak)`);
          clearCpuBlitTexture();
        } else {
          const seedKind = pickSeedSource({ prevPhasePixels, oldBlit, swapchainSeed });
          console.log(`[CPU phase] seed selection: ${seedKind} (intra-render seeding, prevPhasePixels=${!!prevPhasePixels} oldBlit=${!!oldBlit} swapchainSeed=${!!swapchainSeed})`);
          if (seedKind === 'prev-phase') {
            const seed = upscalePixelsNN(prevPhasePixels, prevPhaseW, prevPhaseH, targetW, targetH);
            device.queue.writeTexture(
              { texture: cpuBlitTexture },
              seed.buffer,
              { bytesPerRow: targetW * 4, rowsPerImage: targetH },
              { width: targetW, height: targetH, depthOrArrayLayers: 1 }
            );
          } else if (seedKind === 'old-blit') {
            blitUpscale(oldBlit, cpuBlitTexture);
          } else if (seedKind === 'swapchain') {
            blitUpscale(swapchainSeed, cpuBlitTexture);
          } else {
            clearCpuBlitTexture();
          }
        }
        if (oldBlit) oldBlit.destroy();
        // Don't destroy swapchainSeed — it's a borrowed reference to
        // lastFrameTexture, which the GPU render path keeps alive.
      } else if (prevPhasePixels) {
        // Same dimensions as last phase (rare — only when render-width
        // override matches across phases). Still seed in case content from
        // previous phase is more useful than what the d=4 destroyed below.
        const seed = upscalePixelsNN(prevPhasePixels, prevPhaseW, prevPhaseH, targetW, targetH);
        device.queue.writeTexture(
          { texture: cpuBlitTexture },
          seed.buffer,
          { bytesPerRow: targetW * 4, rowsPerImage: targetH },
          { width: targetW, height: targetH, depthOrArrayLayers: 1 }
        );
      } else if (isFirstPhaseOfNewRender) {
        // Reused-but-stale cpuBlitTexture (same dimensions, cross-render).
        // Clear it so the d=8 skip-on-black workaround preserves black,
        // not the previous view's pixels.
        clearCpuBlitTexture();
      }
      // Don't blit cpuBlitTexture to the swapchain on the first phase of a
      // new render. The cleared texture would visually wipe whatever
      // applyZoomPreview's CSS transform is scaling — the user would see
      // black behind the (now scaled) preview. By skipping this, the
      // swapchain keeps the previously-presented frame which CSS scales
      // into a sharp directional preview while d=8 computes underneath.
      // Subsequent phases (none in CPU mode currently) keep the early-blit
      // behaviour because their cpuBlitTexture has prev-phase content.
      if (!isFirstPhaseOfNewRender) {
        blitUpscale(cpuBlitTexture, context.getCurrentTexture());
      }
      showCpuStatus(`rendering on CPU (1/${d}, ${phaseIters} iters)… 0 / ${cpuWorkers.length} tiles · 0%`);
      const pixels = await cpuRenderPixels(
        targetW, targetH, phaseIters, wantBgra,
        (done, total, rowsDone, totalRows) => {
          if (myGen === progressiveGen) {
            const pct = totalRows > 0 ? Math.round(100 * rowsDone / totalRows) : 0;
            showCpuStatus(`rendering on CPU (1/${d}, ${phaseIters} iters)… ${done}/${total} tiles · ${pct}%`);
          }
        },
        // onTile: per-tile incremental blit + visible flash so the user can
        // see WHICH worker just delivered.
        (tx, ty, tw, th, tilePixels) => {
          if (myGen !== progressiveGen) return;
          // Probe the tile pixels — count non-black bytes and sample the
          // middle pixel so we can tell from the trace whether the worker is
          // computing real colours or returning all-zero (which would make
          // the canvas appear black even though everything else works).
          let nonZero = 0;
          for (let i = 0; i < tilePixels.length; i += 4) {
            if (tilePixels[i] | tilePixels[i+1] | tilePixels[i+2]) nonZero++;
          }
          const midI = ((th >> 1) * tw + (tw >> 1)) * 4;
          if (tx === 0 && ty === 0) {   // log just the first tile per phase to keep trace readable
            console.log(`[onTile] tile(${tx},${ty} ${tw}×${th}) nonZeroPixels=${nonZero}/${tw*th} midRGBA=[${tilePixels[midI]},${tilePixels[midI+1]},${tilePixels[midI+2]},${tilePixels[midI+3]}]`);
          }
          // d=8 is the cheap preview phase. At deep zoom the iter cap (~60% of
          // orbit length, capped at 2000) is often too low for boundary pixels
          // to escape, and the tile comes back all-black even though that
          // region isn't genuinely in-set. Painting the all-black tile over
          // the upscaled-GPU seed wipes out the only visible reference the
          // user has and leaves a partial-black canvas that the user has to
          // manually `h`-press out of. Skip the write so the seed pixels stay
          // visible in those tiles; the next phase (h-tier with full iter cap)
          // will overwrite with truthful pixels when invoked.
          if (d === 8 && nonZero === 0) {
            if (tx === 0 && ty === 0) {
              console.log(`[onTile] d=8 tile(${tx},${ty}) all-black — preserving seed pixels (press h for accurate render)`);
            }
            return;
          }
          device.queue.writeTexture(
            { texture: cpuBlitTexture, origin: { x: tx, y: ty } },
            tilePixels,
            { bytesPerRow: tw * 4, rowsPerImage: th },
            { width: tw, height: th, depthOrArrayLayers: 1 }
          );
          // Sample cpuBlitTexture (phase-res) onto the full-size swapchain via
          // the blit-upscale shader — keeps swapchain content alive across
          // multi-phase transitions. Skipped on the first phase of a new
          // render: the CSS zoom-preview is overlaying the canvas at this
          // moment, scaling whatever swapchain content was last presented
          // (the pre-click frame). Touching the swapchain mid-d=8 would
          // overwrite that with a half-rendered black-mostly cpuBlitTexture
          // and the CSS preview would scale that. The end-of-phase blit
          // below replaces the swapchain in one motion.
          if (!isFirstPhaseOfNewRender) {
            blitUpscale(cpuBlitTexture, context.getCurrentTexture());
          }
          // Only fire the flash overlay when the tile actually delivered
          // visible pixels. At deep zoom with a short reference orbit, many
          // tiles come back all-black (every pixel classified in-set), and a
          // yellow flash on each such tile is misleading "look, work
          // happened!" — better to surface flashes only when there's
          // actually new colour to show.
          if (tileHasVisiblePixels(tilePixels)) {
            flashTileRegion(tx, ty, tw, th, targetW, targetH);
          }
          // CPU mode: keep the CSS zoom preview visible during the entire
          // d=8 pass. The preview shows the click-rect's existing pixels
          // CSS-stretched at the new zoom — sharp, instantly correct
          // direction. If we cleared on the first tile (as the GPU path
          // does), the user would see a half-rendered cpuBlitTexture mixed
          // with stale skip-on-black seed pixels — which looks identical
          // to the pre-click view and reads as "click did nothing". The
          // post-loop clearZoomPreview at end of phase swaps it for real
          // pixels in one motion.
        }
      );
      if (myGen !== progressiveGen || !pixels) { slowPathCleanup(); return; }
      try { await device.queue.onSubmittedWorkDone(); } catch {}
      console.log(`[progressiveRender] gen=${myGen} CPU phase d=${d} complete in ${(performance.now() - phaseT0).toFixed(0)}ms`);
      // First phase of new render: per-tile blits were skipped to preserve
      // CSS preview content on the swapchain. Push the final cpuBlitTexture
      // (containing new tiles + black where skip-on-black preserved the
      // cleared background) to the swapchain in one shot, then clear the
      // CSS transform. From the user's perspective: CSS preview snaps to
      // real new render in one frame.
      if (isFirstPhaseOfNewRender) {
        blitUpscale(cpuBlitTexture, context.getCurrentTexture());
      }
      if (!firstFrameLanded) { clearZoomPreview(); firstFrameLanded = true; }
      prevPhasePixels = pixels;
      prevPhaseW = targetW;
      prevPhaseH = targetH;
    } else {
      // Slow GPU path: render() submits in milliseconds, so the brief
      // swapchain blank between resize and submit is barely perceptible.
      if (gpuBusy) { try { await device.queue.onSubmittedWorkDone(); } catch {} }
      setCanvasDivisor(d);
      render();
      try { await device.queue.onSubmittedWorkDone(); } catch {}
    }
    await new Promise(r => requestAnimationFrame(r));
    if (!firstFrameLanded) { clearZoomPreview(); firstFrameLanded = true; }
  }

  slowPathCleanup();
}

const CLICK_ZOOM = 0.15;     // scale factor per click AND size of hover preview rect (~6.7× zoom)
const PREVIEW_SCALE = CLICK_ZOOM; // rect is an honest preview: after click, that region fills the canvas

// Click-zoom preview: stretch the pre-click pixels in the click rect to fill
// the canvas via CSS transform, so the user sees an instant "fake zoom" that
// roughly matches what's coming. progressiveRender clears the transform when
// the first real frame lands. Only applied for zoom-in (factor < 1) since
// zoom-out has nothing useful to show outside the current canvas.
//
// Math: the click rect is centered at (px, py) with size (cssW * PREVIEW_SCALE,
// cssH * PREVIEW_SCALE). We want its top-left to map to (0, 0) and bottom-right
// to (cssW, cssH). Using transform-origin: 0 0, the CSS transform `scale(S)
// translate(tx, ty)` maps (x, y) → (S*(x+tx), S*(y+ty)). Set (px - r, py - rh)
// → (0, 0): tx = r - px, ty = rh - py. Then scale S = cssW / (2r) = 1/factor
// makes (px + r, py + rh) → (cssW, cssH).
let zoomPreviewActive = false;
function applyZoomPreview(px, py, factor) {
  if (factor >= 1) {
    console.log(`[applyZoomPreview] skip (zoom-out, factor=${factor})`);
    return;
  }
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    console.log(`[applyZoomPreview] skip (canvas rect empty: ${rect.width}×${rect.height})`);
    return;
  }
  const r  = rect.width  * PREVIEW_SCALE / 2;
  const rh = rect.height * PREVIEW_SCALE / 2;
  const S = 1 / factor;
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform = `scale(${S}) translate(${r - px}px, ${rh - py}px)`;
  zoomPreviewActive = true;
  console.log(`[applyZoomPreview] scale(${S.toFixed(3)}) translate(${(r-px).toFixed(1)}, ${(rh-py).toFixed(1)}) at click(${px.toFixed(1)},${py.toFixed(1)}) on rect=${rect.width.toFixed(0)}×${rect.height.toFixed(0)}`);
}
function clearZoomPreview() {
  if (!zoomPreviewActive) return;
  zoomPreviewActive = false;
  canvas.style.transform = '';
  canvas.style.transformOrigin = '';
  console.log(`[clearZoomPreview] CSS transform removed — canvas back to 1:1`);
}

function zoomAt(px, py, rect, factor) {
  // Any zoom action invalidates whatever quality tier we'd reached for the
  // previous view. Reset so the next `h` press starts climbing fresh.
  qualityLevel = 0;
  const aspect = rect.width / rect.height;
  const uvx = (px / rect.width) * 2 - 1;
  const uvy = 1 - (py / rect.height) * 2;
  const cxBefore = view.cx.toString();
  const cyBefore = view.cy.toString();
  const scaleBefore = view.scale;
  viewAddOffset(uvx * view.scale * aspect, uvy * view.scale);
  view.scale = view.scale * factor;
  console.log(
    `[zoomAt] click(px=${px.toFixed(1)},py=${py.toFixed(1)}) rect=${rect.width.toFixed(0)}×${rect.height.toFixed(0)} ` +
    `uv=(${uvx.toFixed(3)},${uvy.toFixed(3)}) factor=${factor}\n` +
    `         scale: ${scaleBefore.toExponential(3)} → ${view.scale.toExponential(3)}\n` +
    `         cx:    ${cxBefore}\n` +
    `             →  ${view.cx.toString()}\n` +
    `         cy:    ${cyBefore}\n` +
    `             →  ${view.cy.toString()}`
  );
  // Marker uses view.scale for projection — re-surface and highlight it on
  // every zoom step so the user can track the re/im target through the
  // dive. pokeCoordMarker (vs updateCoordMarker) is what makes the marker
  // re-appear if it had auto-hidden, and resets the 1.2s rest timer.
  pokeCoordMarker();
  // Sync the HUD (zoom mantissa/exp + technique label) immediately so it
  // reflects the new view regardless of which render path takes over. Without
  // this, CPU-mode clicks (which use cpuRenderPixels directly, bypassing
  // render() and cpuRender()) leave the HUD stuck on the previous zoom.
  updateHUD();
  // Remember where the user clicked so the debounce spinner can appear there.
  lastClickViewport = { x: rect.left + px, y: rect.top + py };
  // Instant fake-zoom preview: CSS-stretch the pre-click pixels in the click
  // rect to fill the canvas. progressiveRender clears the transform when the
  // first real frame lands.
  applyZoomPreview(px, py, factor);
  progressiveRender();
}
let lastClickViewport = null;

// Hover preview: a small rectangle at the cursor acting as a crosshair.
// Size is PREVIEW_SCALE · canvas, decoupled from CLICK_ZOOM so the zoom
// depth per click can be tuned independently of the visual indicator.
function showHoverPreview(px, py, rect) {
  const w = rect.width * PREVIEW_SCALE;
  const h = rect.height * PREVIEW_SCALE;
  selectionEl.style.display = 'block';
  selectionEl.style.left = (rect.left + px - w / 2) + 'px';
  selectionEl.style.top = (rect.top + py - h / 2) + 'px';
  selectionEl.style.width = w + 'px';
  selectionEl.style.height = h + 'px';
}

// Pointer state machine: a press is ambiguous (click vs drag) until the
// pointer moves past DRAG_THRESHOLD or is released. Click → zoom. Drag → pan.
const DRAG_THRESHOLD_PX = 4;
let pointerState = null;

canvas.addEventListener('pointermove', (e) => {
  // Spinner follows the cursor while the progressive-render idle countdown is
  // running — otherwise the countdown appears stuck at the original click.
  moveClickSpinner(e.clientX, e.clientY);
  // If a button is down we're either starting a drag or already panning.
  if (pointerState) {
    const totalDx = e.clientX - pointerState.startX;
    const totalDy = e.clientY - pointerState.startY;
    if (!pointerState.panning && Math.hypot(totalDx, totalDy) > DRAG_THRESHOLD_PX) {
      pointerState.panning = true;
      canvas.style.cursor = 'grabbing';
      selectionEl.style.display = 'none';
      // Pan needs a 1:1 canvas; the click-zoom preview transform would stretch
      // the panned content otherwise.
      clearZoomPreview();
      enterDragQuality();
    }
    if (pointerState.panning) {
      const dx = e.clientX - pointerState.lastX;
      const dy = e.clientY - pointerState.lastY;
      const r = pointerState.rect;
      const aspect = r.width / r.height;
      // Screen → complex: d_uv = 2·dpx/width; d_complex = d_uv · scale · (aspect, 1)
      // Content follows the finger, so the view center shifts by -d_complex.
      const dxComplex = (dx / r.width) * 2 * view.scale * aspect;
      const dyComplex = -(dy / r.height) * 2 * view.scale; // screen y is inverted
      viewAddOffset(-dxComplex, -dyComplex);
      pointerState.lastX = e.clientX;
      pointerState.lastY = e.clientY;
      requestRender();
      return;
    }
  }

  // No drag in progress → hover-crosshair behaviour.
  if (isRecording || armingForRecord || fullResLocked) { selectionEl.style.display = 'none'; return; }
  const r = canvas.getBoundingClientRect();
  showHoverPreview(e.clientX - r.left, e.clientY - r.top, r);
});

canvas.addEventListener('pointerleave', () => {
  if (!pointerState) selectionEl.style.display = 'none';
});

canvas.addEventListener('pointerdown', (e) => {
  if (isRecording) return;
  // While full-res is rendering, ignore clicks — queuing more zooms here is
  // what crashes the tab. The lock clears when the render finishes.
  if (fullResLocked) { e.preventDefault(); return; }
  if (e.button !== 0 && e.button !== 2) return;
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;

  if (armingForRecord) {
    const aspect = r.width / r.height;
    const uvx = (px / r.width) * 2 - 1;
    const uvy = 1 - (py / r.height) * 2;
    const tx = view.cx.plus(uvx * view.scale * aspect);
    const ty = view.cy.plus(uvy * view.scale);
    const pending = pendingClickRecord;
    pendingClickRecord = null;
    disarmRecord();
    const recordPromise = startRecordingWithTarget(tx, ty, pending?.framesOverride, pending?.backend ?? 'auto');
    if (pending) recordPromise.then(pending.resolve, pending.reject);
    return;
  }

  // Defer the click-vs-drag decision to pointerup. Capture the pointer so
  // we still get move/up events if it leaves the canvas mid-drag.
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  pointerState = {
    pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY,
    lastX: e.clientX,  lastY: e.clientY,
    startPx: px, startPy: py,
    rect: r,
    button: e.button,
    shiftKey: e.shiftKey,
    panning: false,
  };
});

canvas.addEventListener('pointerup', (e) => {
  if (!pointerState) return;
  const state = pointerState;
  pointerState = null;
  try { canvas.releasePointerCapture(state.pointerId); } catch {}
  canvas.style.cursor = '';

  if (state.panning) {
    // Drag finished — restore full-res canvas and let the user savour the
    // sharp result.
    exitDragQuality();
    updateCoordInputsFromView();
    return;
  }

  // No drag → treat as a click-zoom at the original press point.
  // Left → zoom in; shift-click or right-click → zoom out.
  const factor = state.shiftKey || state.button === 2 ? 1 / CLICK_ZOOM : CLICK_ZOOM;
  zoomAt(state.startPx, state.startPy, state.rect, factor);
  updateCoordInputsFromView();
});

canvas.addEventListener('pointercancel', (e) => {
  if (pointerState) {
    try { canvas.releasePointerCapture(pointerState.pointerId); } catch {}
    pointerState = null;
  }
  exitDragQuality();
  canvas.style.cursor = '';
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

resetBtn.addEventListener('click', () => {
  resetView();
  requestRender();
});

paletteEl.addEventListener('change', requestRender);

// --- CPU worker count ---
const cpuCountInput = document.getElementById('cpu-count');
if (cpuCountInput) {
  cpuCountInput.max = String(CPU_COUNT_MAX);
  cpuCountInput.value = String(currentCpuWorkerCount());
  cpuCountInput.addEventListener('change', () => {
    const requested = parseInt(cpuCountInput.value, 10);
    const n = setCpuWorkerCount(Number.isFinite(requested) ? requested : CPU_COUNT_DEFAULT);
    cpuCountInput.value = String(n);
    localStorage.setItem(CPU_COUNT_KEY, String(n));
    // If CPU rendering is currently active, kick a fresh render with the new pool.
    if (effectiveBackend() === 'cpu') requestRender();
  });
}

// --- screenshot ---
// Button downloads a PNG of the current view; Ctrl/Cmd+C copies the same PNG
// to the clipboard. Clipboard and download are kept separate because Chrome
// disallows the two in a single gesture (the download "consumes" the gesture
// and a subsequent clipboard.write fails with NotAllowedError).
//
// Dedicated offscreen texture instead of canvas.toBlob — toBlob on a WebGPU
// canvas can return a blank image once the swapchain has been presented.
const screenshotBtn = document.getElementById('screenshot');

async function captureCurrentViewAsBlob() {
  // Abort any in-flight progressive chain and make sure we're at full res.
  progressiveGen++;
  hideClickSpinner();
  unlockFullRes();
  if (dragLowRes) exitDragQuality();
  setCanvasDivisor(1);

  const w = canvas.width;
  const h = canvas.height;
  const aspect = w / h;
  // Force a synchronous orbit update so the captured image is guaranteed
  // fresh for the current view (render() skips GPU submit if orbitDirty).
  ensureReference(view.cx, view.cy, view.scale, aspect, computeOrbitMaxIter());

  const bpr = Math.ceil(w * 4 / 256) * 256;
  const tex = device.createTexture({
    size: [w, h, 1], format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const buf = device.createBuffer({
    size: bpr * h,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  captureTarget = { texture: tex, readback: buf, bpr };

  try {
    render();
    await device.queue.onSubmittedWorkDone();
    await buf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buf.getMappedRange());
    // Tight RGBA for ImageData. Swap B<->R because the preferred canvas
    // format on Mac is bgra8unorm (same swap the record path does).
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = y * bpr + x * 4;
        const d = (y * w + x) * 4;
        pixels[d + 0] = mapped[s + 2];
        pixels[d + 1] = mapped[s + 1];
        pixels[d + 2] = mapped[s + 0];
        pixels[d + 3] = 255;
      }
    }
    buf.unmap();

    const off = new OffscreenCanvas(w, h);
    off.getContext('2d').putImageData(new ImageData(pixels, w, h), 0, 0);
    return await off.convertToBlob({ type: 'image/png' });
  } finally {
    captureTarget = null;
    tex.destroy();
    buf.destroy();
    requestRender();
  }
}

async function runScreenshot(action) {
  if (isRecording) { alert('Cannot screenshot while recording.'); return; }
  screenshotBtn.disabled = true;
  const origLabel = screenshotBtn.textContent;
  screenshotBtn.textContent = 'capturing…';
  try {
    const blob = await captureCurrentViewAsBlob();
    await action(blob);
  } catch (err) {
    console.error('[screenshot] failed:', err);
    alert('Screenshot failed: ' + err.message);
  } finally {
    screenshotBtn.disabled = false;
    screenshotBtn.textContent = origLabel;
  }
}

// Lightweight auto-hiding toast. Subsequent calls cancel the previous
// hide-timer so rapid copies don't make the bar flicker.
const snackbarEl = document.getElementById('snackbar');
let snackbarTimer = null;
function showSnackbar(message, ms = 1800) {
  if (!snackbarEl) return;
  snackbarEl.textContent = message;
  snackbarEl.classList.add('active');
  if (snackbarTimer) clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(() => {
    snackbarEl.classList.remove('active');
    snackbarTimer = null;
  }, ms);
}

function downloadBlob(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mandelbrot-${Date.now()}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

screenshotBtn.addEventListener('click', () => runScreenshot(async (blob) => {
  downloadBlob(blob);
}));

// ---------- High-quality render ----------
// Click → spinner appears, current view re-renders at full resolution with a
// large iteration budget. Click again → cancel. Any other interaction (canvas
// click, drag, typed zoom, palette change → progressiveRender call) bumps
// progressiveGen and the HQ render bails on its next myGen check.
//
// Why this exists: PROGRESSIVE_PHASES_CPU was [8, 4, 2] but d=2 at deep zoom
// took 90+ seconds, blocking the user from zooming around quickly. Dropping
// d=2 from auto-fire and exposing it behind a button means the user pays the
// long render time only when they've found a spot they want to study.
// Quality tiers triggered by the `h` shortcut:
//   tier 1 — half the canvas's full DPR (effectively d=2), no deep orbit,
//            mid iter cap. ~4× the work of the default d=4 progressive.
//   tier 2 — full canvas (d=1), no deep orbit, mid iter cap.
//   tier 3 — full canvas + DEEP orbit search (7×7 × 3 radii) + max iter cap.
//            This is what the old HQ button did.
// Reset on any view change (zoomAt / drag-pan / preset / typed-zoom / reset).
let hqInFlight = false;
async function renderAtQualityTier(tier) {
  if (hqInFlight) {
    console.log(`[quality] cancel requested by user (tier=${tier})`);
    progressiveGen++;
    hqInFlight = false;
    hideCpuStatus();
    return;
  }
  // Cancel any progressive chain so we don't fight over workers / GPU.
  const myGen = ++progressiveGen;
  progressiveActive = true;
  hqInFlight = true;
  const t0 = performance.now();
  // Tier 3 = full HQ (deep orbit + max iters); tiers 1 and 2 are lighter.
  const useDeepOrbit = tier >= 3;
  const useMaxIters  = tier >= 3;
  // Tier 1 renders at half the canvas DPR; tiers 2/3 at full DPR.
  const sizeDivisor  = tier === 1 ? 2 : 1;

  try {
    const isCpu = effectiveBackend() === 'cpu';
    const dpr = window.devicePixelRatio || 1;
    // Canvas drawing buffer (swapchain). Always full DPR — that's what the
    // browser composites at 1:1 once tiles are blitted in.
    const canvasW = Math.max(2, Math.floor(canvas.clientWidth  * dpr / 2) * 2);
    const canvasH = Math.max(2, Math.floor(canvas.clientHeight * dpr / 2) * 2);
    // Render target dimensions. We honor the manual render-width override
    // exactly. In auto mode we use the canvas DPR scaled by the tier's
    // sizeDivisor (tier 1 = half, tier 2/3 = full) so each `h` press climbs
    // the resolution ladder.
    const overrideVal = renderWidthSelect?.value ?? 'auto';
    let fullW, fullH;
    if (overrideVal === 'auto') {
      fullW = Math.max(2, Math.floor(canvasW / sizeDivisor / 2) * 2);
      fullH = Math.max(2, Math.floor(canvasH / sizeDivisor / 2) * 2);
    } else {
      const manual = parseInt(overrideVal, 10);
      fullW = Math.max(2, Math.floor(manual / 2) * 2);
      fullH = Math.max(2, Math.floor(fullW * (canvas.clientHeight / canvas.clientWidth) / 2) * 2);
    }
    const aspect = fullW / fullH;
    console.log(`[quality] tier=${tier}: render=${fullW}×${fullH} (override=${overrideVal}, divisor=${sizeDivisor}) canvas=${canvasW}×${canvasH} useDeepOrbit=${useDeepOrbit} useMaxIters=${useMaxIters} backend=${effectiveBackend()}`);

    // 1) Deep orbit refresh — HQ uses a 7×7 grid at three concentric radii
    // (1×, 5×, 25× viewport) and the larger ORBIT_MAX_ITER_CAP_HQ. This is
    // ~150× the work of the interactive 3×3 search and can take 30-60s at
    // deep zoom, but it's the only thing that breaks the "uniform brown
    // because reference orbit too short" ceiling. The orbit cache is
    // bypassed (deepSearch=true) so HQ always re-searches even if the
    // interactive cache is "fresh" by 3×3 standards.
    //
    // Status pill ticker: the original code only updated the status text
    // when a tile completed (or never, during orbit search). At deep zoom a
    // single tile can take many minutes, leaving the user staring at "0/9
    // tiles · 0s" with no visible progress. A 1Hz tick keeps the elapsed-
    // time counter moving so the user sees the renderer is alive.
    let hqStageText = '';
    const updateHqStatus = () => {
      if (myGen !== progressiveGen) return;
      const elapsed = ((performance.now() - t0) / 1000).toFixed(0);
      showCpuStatus(`${hqStageText} · ${elapsed}s`);
    };
    const hqTicker = setInterval(updateHqStatus, 1000);

    try {
    // Tier 3 only: refresh orbit with deep search. Tiers 1/2 reuse whatever
    // orbit is in the cache (they're just resolution/iter improvements over
    // the existing data; recomputing the orbit at lower tiers is cheap-ish
    // but adds 30-60s at deep zoom for no extra quality).
    if (useDeepOrbit) {
      const hqOrbitMaxIter = computeOrbitMaxIter(true);
      const orbitT0 = performance.now();
      hqStageText = `tier ${tier}/3: searching for long reference orbit (cap ${hqOrbitMaxIter} iters)…`;
      updateHqStatus();
      requestOrbitUpdateAsync(view.cx, view.cy, view.scale, aspect, hqOrbitMaxIter, true);
      const orbitDeadline = performance.now() + 180000;     // up to 3 min for the deep search
      while (myGen === progressiveGen && performance.now() < orbitDeadline) {
        if (!orbitDirty && orbitCache.orbitDD && orbitCache.len > 0) break;
        await new Promise(r => setTimeout(r, 50));
      }
      if (myGen !== progressiveGen) { console.log(`[quality] tier=${tier} cancelled during orbit wait`); return; }
      const orbitMs = Math.round(performance.now() - orbitT0);
      console.log(`[quality] tier=${tier} deep orbit search done in ${orbitMs}ms — len=${orbitCache.len}`);
    }

    if (isCpu) {
      // CPU mode: full canvas. Iter cap adapts to orbit length: spending
      // 5000 iter/pixel against a 300-long reference is wasted work because
      // perturbation rebases ~16× per pixel and DD-f64 accumulates error well
      // before reaching maxIter. Cap at 5× orbit length (where rebases become
      // meaningless), floor at CPU_MID_MAX_ITER (1500 — same as d=4 phase, so
      // HQ at minimum gives a full-resolution version of d=4), ceiling at
      // CPU_FINAL_MAX_ITER_CEIL (5000 — where additional iter budget would
      // help if the orbit were long enough).
      // Canvas drawing buffer always at full DPR (canvasW × canvasH) — so the
      // composited image stays sharp on the user's display even when the
      // render target (fullW × fullH from the override) is smaller.
      // blitUpscale upsamples the smaller cpuBlitTexture into the larger
      // swapchain via the linear-filter blit shader.
      if (canvas.width !== canvasW || canvas.height !== canvasH) {
        console.log(`[hq] canvas resize ${canvas.width}×${canvas.height} → ${canvasW}×${canvasH}`);
        canvas.width = canvasW;
        canvas.height = canvasH;
      }
      // Seed the new cpuBlitTexture with the previous render's pixels (the
      // d=4 progressive result still on screen) instead of clearing to
      // black. Without this the user clicks HQ and stares at a black canvas
      // for the entire HQ render duration (5-30+ minutes at deep zoom),
      // since HQ tiles only fill in slowly. With the seed, they see the
      // existing image immediately and tiles progressively sharpen it.
      const oldBlit = cpuBlitTexture;
      const needRealloc = !oldBlit || oldBlit.width !== fullW || oldBlit.height !== fullH;
      if (needRealloc) {
        // Allocate new WITHOUT destroying old yet — we need to sample the old
        // one into the new one via blitUpscale.
        cpuBlitTexture = device.createTexture({
          size: [fullW, fullH, 1],
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST
               | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
        });
        console.log(`[hq] realloc cpuBlitTexture ${oldBlit ? `${oldBlit.width}×${oldBlit.height}` : '(none)'} → ${fullW}×${fullH}, seeding from previous`);
        if (oldBlit) {
          // Render-pass-blit old → new with linear filtering. Both sizes can
          // differ; the linear sampler in blitUpscale handles the rescale.
          blitUpscale(oldBlit, cpuBlitTexture);
          oldBlit.destroy();
        } else {
          // No previous content (HQ pressed before any other render) → black.
          clearCpuBlitTexture();
        }
      }
      // Push the (possibly seeded) cpuBlitTexture onto the swapchain so the
      // user immediately sees something — NOT a black canvas.
      blitUpscale(cpuBlitTexture, context.getCurrentTexture());

      const orbitLen = orbitCache.len || 1;
      // Iter cap by tier: tier 1 = mid (1500 — same as d=4 progressive),
      // tier 2 = full (5000 capped at orbit-relative ceil), tier 3 = max.
      const tierIters = useMaxIters
        ? Math.min(CPU_FINAL_MAX_ITER_CEIL, Math.max(CPU_MID_MAX_ITER, 5 * orbitLen))
        : (tier === 1 ? CPU_MID_MAX_ITER : Math.min(CPU_FINAL_MAX_ITER_CEIL, Math.max(CPU_MID_MAX_ITER, 3 * orbitLen)));
      const phaseIters = tierIters;
      const wantBgra = format === 'bgra8unorm';
      console.log(`[quality] tier=${tier} CPU dispatch: ${fullW}×${fullH}, ${cpuWorkers.length} workers, ${phaseIters} iters (orbitLen=${orbitLen}, useMaxIters=${useMaxIters})`);
      hqStageText = `tier ${tier}/3 · ${phaseIters} iters · 0 / ${cpuWorkers.length} tiles`;
      updateHqStatus();
      const pixels = await cpuRenderPixels(
        fullW, fullH, phaseIters, wantBgra,
        (done, total, rowsDone, totalRows) => {
          // The 1Hz ticker keeps elapsed-time moving between tile completions;
          // we just refresh the count text here and let the ticker append the
          // new elapsed value on its next fire. With per-row reporting from
          // workers, rowsDone/totalRows ticks UP within each tile so the
          // user sees granular progress even when whole tiles take minutes.
          if (myGen === progressiveGen) {
            const pct = totalRows > 0 ? Math.round(100 * rowsDone / totalRows) : 0;
            hqStageText = `tier ${tier}/3 · ${phaseIters} iters · ${done}/${total} tiles · ${pct}%`;
            updateHqStatus();
          }
        },
        (tx, ty, tw, th, tilePixels) => {
          if (myGen !== progressiveGen) return;
          device.queue.writeTexture(
            { texture: cpuBlitTexture, origin: { x: tx, y: ty } },
            tilePixels,
            { bytesPerRow: tw * 4, rowsPerImage: th },
            { width: tw, height: th, depthOrArrayLayers: 1 }
          );
          blitUpscale(cpuBlitTexture, context.getCurrentTexture());
          // Flash the tile region only when this tile actually delivered
          // visible pixels — same rule as the progressive CPU phase.
          if (tileHasVisiblePixels(tilePixels)) {
            flashTileRegion(tx, ty, tw, th, fullW, fullH);
          }
        },
        // No per-tile timeout for HQ. Full-canvas tiles at deep zoom
        // legitimately take many minutes; the user cancels via the button.
        { timeoutMs: Infinity }
      );
      if (myGen !== progressiveGen) { console.log(`[hq] cancelled during CPU render`); return; }
      try { await device.queue.onSubmittedWorkDone(); } catch {}
    } else {
      // GPU mode: render at full canvas with full iter budget. For tiers 1-2
      // we use the cached orbit (no deep search); tier 3 paid for the deep
      // search above and now renders with that better orbit.
      //
      // The old version just called render() once and awaited
      // onSubmittedWorkDone — but render() BAILS without submitting when
      // orbitDirty is true (line ~1394). That meant the function returned
      // before the orbit worker finished, leaving the just-cleared swapchain
      // black until requestRender() happened to fire later. The fix mirrors
      // the progressive fast path's wait loop (line ~2405): drive successive
      // render() attempts until the orbit lands AND the swapchain has
      // committed pixels, with a 30s ceiling so a stuck pipeline can't lock
      // us forever.
      console.log(`[hq-gpu] tier=${tier} entry: gpuBusy=${gpuBusy} orbitDirty=${orbitDirty} canvas=${canvas.width}×${canvas.height} cachedOrbitLen=${orbitCache.len}`);
      if (gpuBusy) {
        console.log(`[hq-gpu] tier=${tier} draining prior GPU work before resize`);
        try { await device.queue.onSubmittedWorkDone(); } catch {}
      }
      const beforeW = canvas.width, beforeH = canvas.height;
      setCanvasDivisor(sizeDivisor);
      console.log(`[hq-gpu] tier=${tier} after setCanvasDivisor(${sizeDivisor}): ${beforeW}×${beforeH} → ${canvas.width}×${canvas.height} (swapchain cleared)`);
      const submitSeqBefore = renderCallSeq;
      render();
      console.log(`[hq-gpu] tier=${tier} render() returned: seqAdvanced=${renderCallSeq > submitSeqBefore} orbitDirty=${orbitDirty} gpuBusy=${gpuBusy} pendingFrame=${pendingFrame} renderNeeded=${renderNeeded}`);
      // Wait for the actual GPU work to land. We may need to round-trip
      // through the orbit worker (orbitDirty → orbit response →
      // requestRender → dispatchRender → render) before any pixels arrive.
      const deadline = performance.now() + 30000;
      let waitTicks = 0;
      while (myGen === progressiveGen && performance.now() < deadline) {
        if (!orbitDirty && !gpuBusy && !pendingFrame && !renderNeeded) break;
        if (++waitTicks % 20 === 1) {
          console.log(`[hq-gpu] tier=${tier} waiting tick=${waitTicks} orbitDirty=${orbitDirty} gpuBusy=${gpuBusy} pendingFrame=${pendingFrame} renderNeeded=${renderNeeded} cachedOrbitLen=${orbitCache.len}`);
        }
        await new Promise(r => setTimeout(r, 50));
      }
      if (myGen !== progressiveGen) {
        console.log(`[hq-gpu] tier=${tier} cancelled during wait (myGen=${myGen} progressiveGen=${progressiveGen}) — bailing`);
      } else if (performance.now() >= deadline) {
        console.warn(`[hq-gpu] tier=${tier} 30s deadline hit: orbitDirty=${orbitDirty} gpuBusy=${gpuBusy} pendingFrame=${pendingFrame} renderNeeded=${renderNeeded} — swapchain may be stale`);
      }
      try { await device.queue.onSubmittedWorkDone(); } catch {}
      console.log(`[hq-gpu] tier=${tier} done — final renderCallSeq=${renderCallSeq} (started at ${submitSeqBefore})`);
    }
    const elapsedMs = Math.round(performance.now() - t0);
    console.log(`[quality] tier=${tier} complete in ${elapsedMs}ms`);
    if (isCpu) showCpuStatus(`tier ${tier}/3 done · ${(elapsedMs/1000).toFixed(1)}s`);
    setTimeout(() => { if (myGen === progressiveGen) hideCpuStatus(); }, 2000);
    } finally {
      // Always clear the 1Hz status ticker, even on cancel/error paths,
      // so a future render isn't competing with a leftover interval.
      clearInterval(hqTicker);
    }
  } finally {
    if (myGen === progressiveGen) progressiveActive = false;
    hqInFlight = false;
  }
}

// `h` keyboard shortcut: bump quality tier and trigger the corresponding
// render. Resets to 0 on any view change (zoomAt, drag-pan, preset, typed
// zoom). At max tier (3), shows a snackbar and refuses further bumps.
//
// While a tier render is in flight, additional `h` presses are IGNORED —
// not stacked, not cancelled. The user has to wait for the current tier
// to finish (or zoom/click to abort) before requesting the next one.

// True iff a long-running render is in flight. Used to gate keyboard
// shortcuts (space, h) so the user can't stack zooms / quality bumps
// faster than the renderer can absorb them — at deep zoom one CPU
// progressive pass takes 10+ seconds, and queueing five space presses
// in that window used to cascade into back-to-back full pipelines.
//
// Includes cpuRenderInFlight because the orbit-worker callback path can
// trigger a non-progressive cpuRender (e.g. fresh orbit lands while the
// user is idle) — without this gate, a space press during that window
// would bump progressiveGen and stomp the in-flight CPU dispatch's
// generation check, leaving stale tile callbacks scheduled against a
// new render they don't belong to.
function isRenderBusy() {
  return progressiveActive || hqInFlight || cpuRenderInFlight;
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'h' && e.key !== 'H') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  if (isRenderBusy()) {
    showSnackbar(hqInFlight
      ? `Tier ${qualityLevel}/${MAX_QUALITY_LEVEL} still rendering — wait for it to finish`
      : `Render in progress — wait for it to finish`);
    console.log(`[quality] h pressed but render busy (progressiveActive=${progressiveActive} hqInFlight=${hqInFlight}) — ignoring`);
    return;
  }
  if (qualityLevel >= MAX_QUALITY_LEVEL) {
    showSnackbar(`Already at max quality (tier ${MAX_QUALITY_LEVEL}/${MAX_QUALITY_LEVEL})`);
    console.log(`[quality] h pressed but already at max tier ${qualityLevel}`);
    return;
  }
  qualityLevel++;
  console.log(`[quality] h → tier ${qualityLevel}/${MAX_QUALITY_LEVEL}`);
  renderAtQualityTier(qualityLevel);
});

// Copy current view to clipboard as PNG. Reused by the toolbar "copy" button
// AND the Ctrl/Cmd+C shortcut so both paths produce identical behaviour.
function copyCurrentViewToClipboard() {
  return runScreenshot(async (blob) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showSnackbar('Copied screenshot to clipboard');
    } catch (err) {
      console.warn('[screenshot] clipboard write failed:', err);
      showSnackbar('Clipboard copy failed — see console');
    }
  });
}

const copyClipboardBtn = document.getElementById('copy-clipboard');
copyClipboardBtn.addEventListener('click', copyCurrentViewToClipboard);

// Ctrl/Cmd+C copies the current view to the clipboard as PNG.
// Ctrl/Cmd+Shift+C downloads the view as a PNG file (same as the
// screenshot button). Ignored when the user is copying from a text field
// (coord inputs) or when there's text selected on the page, so we don't
// hijack normal copy operations.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'c' && e.key !== 'C') return;
  if (!(e.metaKey || e.ctrlKey)) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const sel = window.getSelection();
  if (sel && sel.toString().length > 0) return;
  e.preventDefault();
  if (e.shiftKey) {
    console.log('[screenshot] ⌘/Ctrl+Shift+C → copy PNG to clipboard');
    copyCurrentViewToClipboard();
  } else {
    console.log('[screenshot] ⌘/Ctrl+C → download PNG');
    runScreenshot(async (blob) => {
      downloadBlob(blob);
      showSnackbar('Saved screenshot');
    });
  }
});

// Spacebar = "zoom one click toward the re/im coord". Shift+Space = "zoom
// out one step from the same target". If the typed coord projects within
// the current viewport we use that pixel; otherwise we fall back to canvas
// centre. Same factor as a (shift-)click. Ignored when focus is in an
// input so the user can type a space into coord fields, zoom inputs, etc.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  // Avoid hijacking modifier-space combos that OS / other shortcuts might
  // use. Shift is the only modifier we care about here (zoom-out).
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  // Same gate as `h`: a long-running render owns the worker pool, and
  // stacking another zoom on top would cancel-and-restart the pipeline
  // before the user has anything to look at. Wait for the current pass.
  if (isRenderBusy()) {
    showSnackbar(`Render in progress — wait for it to finish`);
    console.log(`[space-zoom] ignored: render busy (progressiveActive=${progressiveActive} hqInFlight=${hqInFlight})`);
    return;
  }
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  // Default to canvas centre.
  let px = rect.width / 2;
  let py = rect.height / 2;
  // If the re/im inputs hold a valid coord, project it onto the canvas and
  // zoom toward the projected pixel. Off-canvas projections fall back to
  // centre — silently, since the marker UI already signals "off-canvas".
  const target = (typeof parseCoordTarget === 'function') ? parseCoordTarget() : null;
  if (target) {
    const aspect = rect.width / rect.height;
    const dx = Number(target.cx.minus(view.cx));
    const dy = Number(target.cy.minus(view.cy));
    const uvx = dx / (view.scale * aspect);
    const uvy = dy / view.scale;
    if (Number.isFinite(uvx) && Number.isFinite(uvy) && Math.abs(uvx) <= 1 && Math.abs(uvy) <= 1) {
      px = (uvx + 1) * 0.5 * rect.width;
      py = (1 - uvy) * 0.5 * rect.height;
      console.log(`[space-zoom] target re/im in viewport → zoom${e.shiftKey ? '-out' : '-in'} toward (${px.toFixed(1)}, ${py.toFixed(1)}) [uv ${uvx.toFixed(3)},${uvy.toFixed(3)}]`);
    } else {
      console.log(`[space-zoom] target re/im OUT of viewport (uv ${uvx.toFixed(3)},${uvy.toFixed(3)}) → falling back to canvas centre (zoom${e.shiftKey ? '-out' : '-in'})`);
    }
  } else {
    console.log(`[space-zoom] no valid re/im coord → zoom${e.shiftKey ? '-out' : '-in'} toward canvas centre`);
  }
  // Shift toggles zoom direction: same factor convention as click vs
  // shift-click (1/CLICK_ZOOM = ~6.67× zoom out per press).
  const factor = e.shiftKey ? 1 / CLICK_ZOOM : CLICK_ZOOM;
  zoomAt(px, py, rect, factor);
});

// --- recording ---
const recordBtn = document.getElementById('record');
const durationInput = document.getElementById('duration');
const fpsInput = document.getElementById('fps');

// Total frames = duration × fps, clamped to something sane. Duration is what
// the user thinks in ("make me a 15-second clip"); frames is an internal
// detail derived from that and the fps setting.
function readTotalFrames() {
  const fps = Math.max(15, Math.min(120, parseInt(fpsInput.value, 10) || 60));
  const duration = Math.max(1, Math.min(1200, parseFloat(durationInput.value) || 15));
  return Math.max(2, Math.min(72000, Math.round(duration * fps)));
}
const progressEl = document.getElementById('progress');
const progressText = document.getElementById('progress-text');
const progressFill = document.getElementById('progress-fill');
const progressCancel = document.getElementById('progress-cancel');

let activeRecording = null;

async function pickCodec(width, height, fps, bitrate) {
  const candidates = ['avc1.640033', 'avc1.640028', 'avc1.4D0028', 'avc1.42E01F'];
  for (const codec of candidates) {
    try {
      const res = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
      if (res && res.supported) return codec;
    } catch {}
  }
  return null;
}

let muxerMod = null;
async function loadMuxer() {
  if (!muxerMod) muxerMod = await import('https://esm.sh/mp4-muxer');
  return muxerMod;
}

// --- Per-frame overlay (burned into video frames, not shown on live canvas) ---
// Renders zoom factor + precision to an OffscreenCanvas, then alpha-blends the
// result into the captured BGRA pixel buffer before it goes to the video encoder.
// Superscript-digit mapping for pretty 10ⁿ notation.
const SUP_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
function sup(n) {
  const s = Math.round(n).toString();
  let out = '';
  for (const ch of s) out += ch === '-' ? '⁻' : SUP_DIGITS[+ch];
  return out;
}

const OVERLAY_W = 520;
const OVERLAY_H = 140;
const overlayCanvas = new OffscreenCanvas(OVERLAY_W, OVERLAY_H);
const overlayCtx = overlayCanvas.getContext('2d');

function drawOverlay() {
  const zoomFactor = HOME.scale / view.scale;
  const zoomLog = Math.log10(Math.max(1, zoomFactor));
  const scaleLog = Math.log10(view.scale);

  // Lines: large zoom label, secondary scale + precision info.
  overlayCtx.clearRect(0, 0, OVERLAY_W, OVERLAY_H);
  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  overlayCtx.fillRect(0, 0, OVERLAY_W, OVERLAY_H);
  overlayCtx.textBaseline = 'top';

  // Big zoom number: "10⁵×"  (+ "(1.2e+05)" fine print next to it)
  overlayCtx.font = 'bold 40px ui-monospace, Menlo, monospace';
  overlayCtx.fillStyle = '#ffffff';
  const zoomLabel = `10${sup(zoomLog)}×`;
  overlayCtx.fillText(zoomLabel, 20, 14);

  overlayCtx.font = '18px ui-monospace, Menlo, monospace';
  overlayCtx.fillStyle = '#8eeaff';
  const zoomExact = zoomFactor.toExponential(2).replace('+', '');
  overlayCtx.fillText(`(${zoomExact}× deeper than HOME)`, 175, 30);

  // Second line: scale as 10ⁿ + precision label.
  overlayCtx.font = '20px ui-monospace, Menlo, monospace';
  overlayCtx.fillStyle = '#ffffff';
  overlayCtx.fillText(`scale 10${sup(scaleLog)}`, 20, 82);

  overlayCtx.font = '16px ui-monospace, Menlo, monospace';
  overlayCtx.fillStyle = '#9fe';
  overlayCtx.fillText('precision: 21 digits (TDXR-f32)', 20, 112);
}

// Alpha-blend the current overlayCanvas into a BGRA pixel buffer.
// The pixel buffer is tightly packed (stride = width*4, no row padding).
function blitOverlay(pixels, width, height) {
  const x0 = 16, y0 = 16; // top-left padding
  const img = overlayCtx.getImageData(0, 0, OVERLAY_W, OVERLAY_H);
  const src = img.data;
  const rowBytes = width * 4;
  const drawW = Math.min(OVERLAY_W, width - x0);
  const drawH = Math.min(OVERLAY_H, height - y0);
  for (let y = 0; y < drawH; y++) {
    const dstY = y0 + y;
    if (dstY >= height) break;
    for (let x = 0; x < drawW; x++) {
      const sIdx = (y * OVERLAY_W + x) * 4;
      const a = src[sIdx + 3];
      if (a === 0) continue;
      const dIdx = dstY * rowBytes + (x0 + x) * 4;
      const r = src[sIdx], g = src[sIdx + 1], b = src[sIdx + 2];
      if (a === 255) {
        // Output is BGRA (Mac WebGPU); swap R/B channels.
        pixels[dIdx + 0] = b;
        pixels[dIdx + 1] = g;
        pixels[dIdx + 2] = r;
      } else {
        const alpha = a / 255;
        const invA = 1 - alpha;
        pixels[dIdx + 0] = Math.round(pixels[dIdx + 0] * invA + b * alpha);
        pixels[dIdx + 1] = Math.round(pixels[dIdx + 1] * invA + g * alpha);
        pixels[dIdx + 2] = Math.round(pixels[dIdx + 2] * invA + r * alpha);
      }
    }
  }
}

async function recordVideo({ totalFrames, fps, zoomIn, backend = 'auto' }) {
  const { Muxer, ArrayBufferTarget } = await loadMuxer();
  const width = canvas.width;
  const height = canvas.height;
  const bitrate = Math.min(40_000_000, Math.round(width * height * fps * 0.1));

  const codec = await pickCodec(width, height, fps, bitrate);
  if (!codec) throw new Error('No supported H.264 encoder in this browser.');

  // Resolve 'auto': use CPU if the final frame's zoom will exceed the GPU
  // precision wall. Any frame at that depth would come out as one-colour
  // garbage on GPU, so the whole clip switches even though early frames
  // could have rendered on GPU — simpler and guarantees consistent output.
  const finalScale = HOME.scale * Math.pow(zoomIn, totalFrames);
  const resolvedBackend = backend === 'auto'
    ? (finalScale < GPU_SCALE_LIMIT ? 'cpu' : 'gpu')
    : backend;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
  });

  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e; },
  });
  encoder.configure({ codec, width, height, bitrate, framerate: fps });

  // User's click = direction hint ONLY for frame 0. After that, pure contrast-driven.
  const clickTarget = { cx: view.cx, cy: view.cy };

  // Camera starts at HOME, then follows contrast. Zoom is ADAPTIVE: zoom in when
  // a boundary is visible, zoom out when the view goes flat. Final depth is
  // wherever contrast-following naturally leads us — "beautiful every frame"
  // matters more than a fixed end depth.
  const aspect = width / height;
  view.cx = HOME.cx; view.cy = HOME.cy;
  view.scale = HOME.scale;

  // Per-frame zoom factor, derived from the user's speed setting.
  const ZOOM_IN     = zoomIn;
  const MOVE_NORMAL = 0.04;

  // Tear down any lingering readback buffers before allocating fresh ones. A
  // previous recording that was cancelled or errored mid-flight can leave a
  // slot's mapAsync promise pending — the next mapAsync on the same buffer
  // throws "Buffer already has an outstanding map pending". Fresh buffers
  // every record is cheap and avoids that class of bug entirely.
  disposeReadback();
  disposeRecordTextures();
  ensureRecordTextures(width, height);
  const bpr = ensureRecordReadbackPair(width, height);
  const vfFormat = format === 'bgra8unorm' ? 'BGRA' : 'RGBA';
  const frameDuration = Math.round(1_000_000 / fps);

  const recording = { cancelled: false };
  activeRecording = recording;

  // Two-slot pipeline: while the CPU processes frame N (readback + overlay +
  // encode), the GPU is already rendering frame N+1. Cuts wall time when the
  // GPU is underutilised (encoder- or readback-bound cases).
  const slots = [
    { tex: recordTextures[0], buf: recordReadbackBuffers[0], frame: -1, mapP: null },
    { tex: recordTextures[1], buf: recordReadbackBuffers[1], frame: -1, mapP: null },
  ];


  function submitSlot(idx, slot) {
    slot.frame = idx;
    // render() consults the module-level record pointers to pick its target.
    recordTexture = slot.tex;
    readbackBuffer = slot.buf;
    render();
    // Kick off mapAsync but don't await — GPU can keep working while we do CPU stuff.
    slot.mapP = slot.buf.mapAsync(GPUMapMode.READ);
  }

  async function drainSlot(slot) {
    await slot.mapP;
    const mapped = new Uint8Array(slot.buf.getMappedRange());
    let pixels;
    if (bpr === width * 4) {
      pixels = new Uint8Array(mapped);
    } else {
      pixels = new Uint8Array(width * height * 4);
      const rowBytes = width * 4;
      for (let y = 0; y < height; y++) {
        pixels.set(
          mapped.subarray(y * bpr, y * bpr + rowBytes),
          y * rowBytes
        );
      }
    }
    slot.buf.unmap();
    drawOverlay();
    blitOverlay(pixels, width, height);
    const timestamp = Math.round((slot.frame * 1_000_000) / fps);
    const vf = new VideoFrame(pixels, {
      format: vfFormat, codedWidth: width, codedHeight: height,
      timestamp, duration: frameDuration,
    });
    encoder.encode(vf, { keyFrame: slot.frame % (fps * 2) === 0 });
    vf.close();
    updateProgress(slot.frame + 1, totalFrames);
    return pixels;
  }

  // Advance view for the frame we're about to submit — straight follow-path
  // from HOME toward the clickTarget, zoom in by ZOOM_IN per frame.
  function advanceView() {
    // Target can be deep (well past 10^28), but the *delta* from the current
    // view is what drives the move direction — at any frame the current view
    // and target differ by at most ~1 in |Re|+|Im| terms, so coercing to f64
    // for the direction calc is safe.
    const dx = Number(clickTarget.cx.minus(view.cx));
    const dy = Number(clickTarget.cy.minus(view.cy));
    const uvx = Math.max(-1, Math.min(1, dx / (view.scale * aspect)));
    const uvy = Math.max(-1, Math.min(1, dy / view.scale));
    viewAddOffset(uvx * view.scale * aspect * MOVE_NORMAL, uvy * view.scale * MOVE_NORMAL);
    view.scale = Math.min(HOME.scale, view.scale * ZOOM_IN);
  }

  // CPU record loop: synchronous per-frame render in DD-f64 via the worker
  // pool, then the frame goes straight into VideoFrame. No GPU pipelining,
  // so wall time is ~N × (per-frame CPU compute) — easily minutes for a
  // 10^25 zoom clip, but it's the only path that stays correct past 10^21.
  async function runCpuLoop() {
    for (let i = 0; i < totalFrames; i++) {
      if (recording.cancelled) break;
      if (encoderError) throw encoderError;
      if (i > 0) advanceView();

      // Sync orbit for this frame's view (populates orbitCache.orbitDD).
      ensureReference(view.cx, view.cy, view.scale, aspect, computeOrbitMaxIter());

      const wantBgra = vfFormat === 'BGRA';
      const pixels = await cpuRenderPixels(width, height, computeMaxIter(), wantBgra);
      if (!pixels) continue;

      drawOverlay();
      blitOverlay(pixels, width, height);
      const timestamp = Math.round((i * 1_000_000) / fps);
      const vf = new VideoFrame(pixels, {
        format: vfFormat, codedWidth: width, codedHeight: height,
        timestamp, duration: frameDuration,
      });
      encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      updateProgress(i + 1, totalFrames);

      while (encoder.encodeQueueSize > 8 && !recording.cancelled) {
        await new Promise(r => setTimeout(r, 4));
      }
    }
  }

  try {
    if (resolvedBackend === 'cpu') {
      await runCpuLoop();
    } else {
      // Kick off frame 0 with view at HOME (already set above).
      submitSlot(0, slots[0]);

      for (let i = 1; i < totalFrames; i++) {
        if (recording.cancelled) break;
        if (encoderError) throw encoderError;

        advanceView();                                 // compute view for frame i
        submitSlot(i, slots[i % 2]);                   // start GPU on frame i
        await drainSlot(slots[(i - 1) % 2]);           // finish CPU on frame i-1

        while (encoder.encodeQueueSize > 8 && !recording.cancelled) {
          await new Promise(r => setTimeout(r, 4));
        }
      }

      // Drain the final in-flight frame.
      if (!recording.cancelled) {
        await drainSlot(slots[(totalFrames - 1) % 2]);
      }
    }

    await encoder.flush();
    encoder.close();
    muxer.finalize();

    if (recording.cancelled) return null;
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  } finally {
    skipReferenceUpdate = false;
    activeRecording = null;
    disposeReadback();
    disposeRecordTexture();
  }
}

// Shared progress state. Both backends feed into the same counters so the
// progress bar shows combined frames, elapsed time, and per-backend counts
// + fps — the stats that used to live in a separate post-record dialog.
const recordProgress = {
  total: 0,
  // Targets are what each backend was ASKED to render. Used to decide which
  // backend rows to show pre-emptively (so "jetson 0 @ — fps" appears while
  // the Jetson is still submitting, instead of the user wondering where it is).
  browserTarget: 0, jetsonTarget: 0,
  browserDone: 0, jetsonDone: 0,
  startedAt: 0,
  // Set to performance.now() when the record stops — freezes the elapsed-time
  // field so the clock doesn't keep ticking after completion.
  stoppedAt: 0,
};
let progressTicker = null;

function resetRecordProgress({ total, browserTarget, jetsonTarget }) {
  recordProgress.total = total;
  recordProgress.browserTarget = browserTarget;
  recordProgress.jetsonTarget = jetsonTarget;
  recordProgress.browserDone = 0;
  recordProgress.jetsonDone = 0;
  recordProgress.startedAt = performance.now();
  recordProgress.stoppedAt = 0;
  renderRecordProgress();
  if (progressTicker == null) {
    progressTicker = setInterval(renderRecordProgress, 500);
  }
}
function stopRecordProgress() {
  recordProgress.stoppedAt = performance.now();
  if (progressTicker != null) { clearInterval(progressTicker); progressTicker = null; }
  renderRecordProgress();
}
function elapsedMsNow() {
  if (!recordProgress.startedAt) return 0;
  const end = recordProgress.stoppedAt || performance.now();
  return end - recordProgress.startedAt;
}

function fmtElapsed(ms) {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s - m * 60).toFixed(0)}s`;
}
function fmtFps(frames, ms) {
  if (!isFinite(ms) || ms <= 0 || !frames) return '— fps';
  return `${(frames * 1000 / ms).toFixed(1)} fps`;
}

function renderRecordProgress() {
  const b = recordProgress.browserDone;
  const j = recordProgress.jetsonDone;
  const done = b + j;
  const total = recordProgress.total || 1;
  const ms = elapsedMsNow();

  // Header: combined progress + elapsed.
  const parts = [`${done} / ${total} frames`, fmtElapsed(ms)];
  // Per-backend rows — show both frame count and fps so the user can compare
  // contributions directly (instead of decoding an opaque 55/45 share).
  if (recordProgress.browserTarget > 0) {
    parts.push(`browser ${b} @ ${fmtFps(b, ms)}`);
  }
  if (recordProgress.jetsonTarget > 0) {
    parts.push(`jetson ${j} @ ${fmtFps(j, ms)}`);
  }

  progressText.textContent = parts.join(' · ');
  progressFill.style.width = `${Math.min(100, (done / total) * 100)}%`;
}

function updateProgress(done, total) {
  // Called from the browser record loop — we ignore `total` here because the
  // overall total is set once (per record) by the modal orchestrator.
  recordProgress.browserDone = done;
  renderRecordProgress();
}

function setProgressVisible(v) {
  progressEl.classList.toggle('active', v);
}

const armBar = document.getElementById('arm-bar');
const armCancel = document.getElementById('arm-cancel');
let armingForRecord = false;
// When the modal is in "browser → jetson" sequential mode and the browser half
// needs a click to pick its target, we set this so the pointerdown handler can
// chain the recording's completion back to the modal's orchestrator.
let pendingClickRecord = null;

function armRecord() {
  if (typeof VideoEncoder === 'undefined') {
    alert('WebCodecs VideoEncoder is not available in this browser.');
    return;
  }
  armingForRecord = true;
  armBar.classList.add('active');
  recordBtn.disabled = true;
}

function disarmRecord() {
  armingForRecord = false;
  armBar.classList.remove('active');
  recordBtn.disabled = false;
}

// Cancellation path: Escape key, the arm-bar cancel button, or re-opening the
// modal. Unlike disarmRecord() (called during successful hand-off to the actual
// recording), this one rejects any modal-side awaiter.
function cancelArm() {
  disarmRecord();
  if (pendingClickRecord) {
    const { reject } = pendingClickRecord;
    pendingClickRecord = null;
    reject(new Error('cancelled'));
  }
}

const speedInput = document.getElementById('speed');

// User-facing speed is "× shrinks per second". Convert to a per-frame shrink
// factor: zoomIn = (1/speed)^(1/fps). E.g. speed=6 @ 60fps → zoomIn ≈ 0.9706.
function zoomFactorPerFrame(speed, fps) {
  const s = Math.max(1.01, Number(speed) || 6);
  const f = Math.max(1, fps);
  return Math.pow(1 / s, 1 / f);
}
function readSpeed() {
  return Math.max(1.01, parseFloat(speedInput.value) || 6);
}

// Split-mode handshake between the modal and the browser recorder. When
// `holdBrowserBlob` is true, the recorder stashes the produced mp4 into
// `pendingBrowserBlob` for the modal to upload to the Jetson /merge endpoint —
// otherwise the recorder auto-downloads as before.
let holdBrowserBlob = false;
let pendingBrowserBlob = null;

// Optional `framesOverride` lets the caller cap recording length (used by the
// split-mode modal so the browser only records [0, split) and the Jetson
// picks up [split, total)).
async function startRecordingWithTarget(targetCx, targetCy, framesOverride, backend = 'auto') {
  const fullFrames = readTotalFrames();
  const totalFrames = framesOverride != null ? Math.max(2, framesOverride) : fullFrames;
  const fps = Math.max(15, Math.min(120, parseInt(fpsInput.value, 10) || 60));
  const zoomIn = zoomFactorPerFrame(readSpeed(), fps);

  const savedView = { cx: view.cx, cy: view.cy, scale: view.scale };
  view.cx = targetCx; view.cy = targetCy;

  isRecording = true;
  recordBtn.disabled = true;
  resetBtn.disabled = true;
  setProgressVisible(true);
  updateProgress(0, totalFrames);

  const recordT0 = performance.now();
  let stats = { success: false, frames: 0, elapsedMs: 0 };
  try {
    const blob = await recordVideo({ totalFrames, fps, zoomIn, backend });
    const elapsed = performance.now() - recordT0;
    if (blob) {
      stats = { success: true, frames: totalFrames, elapsedMs: elapsed };
      // Remember wall-clock ms/frame so the next split-mode record can hand
      // the Jetson a fair share of the work instead of a blind 50/50.
      const msPerFrame = elapsed / totalFrames;
      if (isFinite(msPerFrame) && msPerFrame > 0) {
        localStorage.setItem(BROWSER_MS_PER_FRAME_KEY, msPerFrame.toFixed(2));
      }
      // Split mode: hold the blob for the modal to upload to /merge. Otherwise
      // download immediately as before.
      if (holdBrowserBlob) {
        pendingBrowserBlob = blob;
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mandelbrot-${Date.now()}.mp4`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    }
  } catch (e) {
    console.error(e);
    alert('Recording failed: ' + e.message);
  } finally {
    isRecording = false;
    Object.assign(view, savedView);
    recordBtn.disabled = false;
    resetBtn.disabled = false;
    // NOTE: progress bar stays visible — the modal orchestrator hides it once
    // both backends finish, otherwise the faster one would clear the bar while
    // the slower one is still working.
    requestRender();
  }
  return stats;
}

// Coordinate inputs: if both parse to finite numbers, record uses them directly
// (no click needed). If either is empty/invalid, fall back to arming for click.
const coordReInput = document.getElementById('coord-re');
const coordImInput = document.getElementById('coord-im');

// Returns { cx: Decimal, cy: Decimal } parsed from the coord inputs — preserves
// any number of digits the user typed, full 60-digit precision. Returns null
// if either input is empty or invalid.
function parseCoordTarget() {
  const cx = parseDecimal(coordReInput.value);
  const cy = parseDecimal(coordImInput.value);
  if (!cx || !cy) return null;
  if (!cx.isFinite() || !cy.isFinite()) return null;
  return { cx, cy };
}

// Write the current view center into the coord inputs. Called after every
// click-zoom so the user can immediately hit "record" to film from that spot.
function updateCoordInputsFromView() {
  coordReInput.value = decimalToString(view.cx);
  coordImInput.value = decimalToString(view.cy);
  updateCoordMarker();
}

// Editing the re/im inputs surfaces the marker so the user can see where
// the new coord lands.
for (const el of [coordReInput, coordImInput]) {
  el.addEventListener('input', pokeCoordMarker);
}
// Reposition the marker on resize/scroll so it tracks the canvas geometry.
window.addEventListener('resize', updateCoordMarker);
window.addEventListener('scroll', updateCoordMarker, { passive: true });

// Mouse-move over the canvas surfaces the marker (and gives it the bigger
// "highlighted" look). Both fade out together after the mouse rests.
canvas.addEventListener('pointermove', pokeCoordMarker);

// Record button opens the unified modal (browser / jetson / both). The actual
// launch branches live inside the modal's Start handler below.
recordBtn.addEventListener('click', () => {
  if (isRecording || armingForRecord) return;
  openRecordModal();
});

armCancel.addEventListener('click', cancelArm);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && armingForRecord) cancelArm();
});

progressCancel.addEventListener('click', () => {
  if (recordProgress.stoppedAt > 0) {
    // Record finished — cancel button doubles as "close progress bar".
    setProgressVisible(false);
    return;
  }
  if (activeRecording) activeRecording.cancelled = true;
  if (activeJetsonJob) {
    const { url, jobId } = activeJetsonJob;
    activeJetsonJob = null;
    // Fire-and-forget DELETE; the poll loop will see status transition to
    // "cancelled" on its next tick and exit cleanly.
    fetch(`${url}/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
  }
});

// --- Jetson Orin render service ---
// Where to reach the Jetson depends on how the browser itself is being served:
//  - mandelbrot.calje.eu → reverse-proxied at /gpu on the same origin (prod)
//  - localhost / 127.0.0.1 → direct to monster:8080 on the LAN (home dev)
//  - anything else → localStorage override, falls back to jetson.local:8080
const PRODUCTION_HOST = 'mandelbrot.calje.eu';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LAN_JETSON_URL = 'http://monster:8080';
function resolveJetsonUrl() {
  const host = window.location.hostname;
  if (host === PRODUCTION_HOST) return window.location.origin + '/gpu';
  if (LOCAL_HOSTS.has(host))   return LAN_JETSON_URL;
  return localStorage.getItem('jetsonUrl') || 'http://jetson.local:8080';
}
const IS_PRODUCTION = window.location.hostname === PRODUCTION_HOST;

async function checkJetsonAvailable() {
  const url = resolveJetsonUrl();
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(url.replace(/\/$/, '') + '/jobs', { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(to);
    if (!res.ok) return { ok: false, version: null };
    const data = await res.json().catch(() => ({}));
    return { ok: true, version: data.version ?? null };
  } catch {
    return { ok: false, version: null };
  }
}

// Cached availability so the record modal can synchronously reflect state
// instead of racing a probe against the Start button. `null` = probe in flight
// (or never run), so the modal can render a "checking…" placeholder instead of
// falsely claiming the Jetson is offline. `jetsonVersion` reflects the deploy
// timestamp exposed by the server — proof the latest code is live.
let jetsonAvailable = null;
let jetsonVersion = null;
const jetsonLink = document.getElementById('jetson-link');
async function refreshJetsonAvailability() {
  const probe = await checkJetsonAvailable();
  jetsonAvailable = probe.ok;
  jetsonVersion = probe.version;
  console.debug('[jetson-probe]', probe, '→ url:', resolveJetsonUrl());
  // Show/hide the "jobs" link in the top bar so the dashboard is one click
  // away when the Jetson is reachable, and invisible when it isn't.
  if (jetsonLink) {
    if (jetsonAvailable) {
      jetsonLink.href = 'manage-jobs.html';
      jetsonLink.style.display = '';
    } else {
      jetsonLink.style.display = 'none';
    }
  }
  if (recordModal?.classList.contains('active')) syncJetsonModalState();
}
refreshJetsonAvailability();
setInterval(refreshJetsonAvailability, 30_000);

// Tracks the currently-running Jetson job so the progress cancel button can
// propagate a cancel to the remote worker (local cancel alone would stop the
// browser record but the Jetson would keep chewing through its range).
let activeJetsonJob = null; // { url, jobId }

// Submit a render job to the Jetson and poll until finished. Returns a stats
// object (with `jobId` + `url` so the caller can merge/download later). Auto-
// downloads unless `skipDownload` is set — split mode skips here and lets the
// modal orchestrator upload the browser half and download the merged result.
async function runJetsonJob({ startFrame = 0, endFrame = null, skipDownload = false } = {}) {
  let url = resolveJetsonUrl();
  const autoResolved = IS_PRODUCTION || LOCAL_HOSTS.has(window.location.hostname);
  if (!autoResolved) {
    const entered = prompt('Jetson render service URL:', url);
    if (!entered) return 'cancelled';
    url = entered;
    localStorage.setItem('jetsonUrl', url);
  }

  const frames = readTotalFrames();
  const fps = Math.max(15, Math.min(120, parseInt(fpsInput.value, 10) || 60));

  const target = parseCoordTarget();
  const cx = target ? target.cx : view.cx;
  const cy = target ? target.cy : view.cy;
  const body = {
    center_re: decimalToString(cx),
    center_im: decimalToString(cy),
    frames, fps,
    width: canvas.width,
    height: canvas.height,
    adaptive: false,
    initial_follow_frames: frames,
    palette: paletteEl.value,
    start_frame: startFrame,
    end_frame: endFrame ?? frames,
    speed: readSpeed(),
  };

  // Keep progress visible while the submission is in flight; the overall
  // frame count still ticks up in the browser-controlled state object.
  setProgressVisible(true);

  let jobId;
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    jobId = data.job_id;
    activeJetsonJob = { url: url.replace(/\/$/, ''), jobId };
  } catch (e) {
    setProgressVisible(false);
    alert(`Failed to queue render on Jetson: ${e.message}\n\nCheck the URL and that the service is running:\n  python3 -m src.server`);
    return { success: false, frames: 0, elapsedMs: 0, jobId: null };
  }

  let lastStatus = 'queued';
  let lastJob = null;
  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    let s;
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/jobs/${jobId}`);
      s = await res.json();
    } catch (e) {
      continue;  // transient poll failure; retry on next tick
    }
    lastStatus = s.status;
    lastJob = s;
    recordProgress.jetsonDone = s.frames_done || 0;
    renderRecordProgress();
    if (s.status === 'done' || s.status === 'failed' || s.status === 'cancelled') break;
  }

  if (lastStatus === 'done' && !skipDownload) {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/download/${jobId}`);
      const blob = await res.blob();
      const dl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dl;
      a.download = `mandelbrot-jetson-${jobId}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(dl), 10_000);
    } catch (e) {
      alert(`Download failed: ${e.message}`);
    }
  } else if (lastStatus !== 'cancelled' && lastStatus !== 'done') {
    console.error('Jetson job', lastStatus, lastJob);
    const err = lastJob?.error ? `\n\n${lastJob.error}` : '';
    alert(`Jetson job ${lastStatus}${err}\n\n(full payload in devtools console)`);
  }

  activeJetsonJob = null;
  // Don't hide the progress bar here — modal orchestrator hides it once both
  // backends are done.
  // Derive wall-clock duration from the job's server timestamps so we don't
  // include POST latency or polling overhead in the Jetson-side stat.
  const jetsonFrames = lastJob?.frames_done ?? 0;
  const jetsonStartTs = lastJob?.started_at;
  const jetsonEndTs   = lastJob?.finished_at;
  const jetsonElapsedMs = (jetsonStartTs && jetsonEndTs) ? (jetsonEndTs - jetsonStartTs) * 1000 : 0;
  return {
    success: lastStatus === 'done',
    frames: jetsonFrames,
    elapsedMs: jetsonElapsedMs,
    jobId,
    url: url.replace(/\/$/, ''),
  };
}

// ---------- Unified record modal ----------

const recordModal = document.getElementById('record-modal');
const recModalStartBtn = document.getElementById('rec-modal-start');
const recModalCancelBtn = document.getElementById('rec-modal-cancel');
const recBrowserCb = document.getElementById('rec-browser');
const recJetsonCb = document.getElementById('rec-jetson');
const recJetsonLabel = document.getElementById('rec-jetson-label');
const recJetsonHint = document.getElementById('rec-jetson-hint');

// Paint the Jetson checkbox based on the cached availability. Called both when
// the modal opens and whenever a background probe updates availability.
function syncJetsonModalState() {
  if (jetsonAvailable === null) {
    recJetsonCb.disabled = true;
    recJetsonLabel.classList.add('disabled');
    recJetsonHint.textContent = 'checking…';
  } else if (jetsonAvailable) {
    recJetsonCb.disabled = false;
    recJetsonLabel.classList.remove('disabled');
    const ver = jetsonVersion ? ` · ${jetsonVersion}` : '';
    recJetsonHint.textContent = `${resolveJetsonUrl()} · online${ver}`;
  } else {
    recJetsonCb.disabled = true;
    recJetsonCb.checked = false;
    recJetsonLabel.classList.add('disabled');
    recJetsonHint.textContent = 'not reachable';
  }
}

// Remember last jetson checkbox choice so repeat records don't force the user
// to re-check it every time. Browser box stays on by default.
const JETSON_CHOICE_KEY = 'recordJetsonChecked';
// Rolling record of how long a single frame takes on each backend. Used to
// proportion the frame-range split when the user picks both targets.
const BROWSER_MS_PER_FRAME_KEY = 'browserMsPerFrame';

// Split `totalFrames` so the browser and the Jetson finish at roughly the same
// wall-clock time. Returns the browser's frame share — the Jetson picks up the
// rest. Falls back to 50/50 when either backend has no prior timing data.
async function computeSplitFrame(totalFrames) {
  const browserMs = parseFloat(localStorage.getItem(BROWSER_MS_PER_FRAME_KEY));
  let jetsonMs = NaN;
  try {
    const url = resolveJetsonUrl().replace(/\/$/, '') + '/jobs';
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const s = data.worker?.stats;
      if (s && s.frames_done > 0) {
        jetsonMs = (s.gpu_ms_total + s.cpu_ms_total) / s.frames_done;
      }
    }
  } catch {}

  if (!isFinite(browserMs) || !isFinite(jetsonMs) || browserMs <= 0 || jetsonMs <= 0) {
    return Math.floor(totalFrames / 2);
  }
  // If browser takes B ms/frame and jetson takes J ms/frame, splitting N frames
  // so both finish at the same moment means browser_frames · B = jetson_frames · J,
  // which solves to browser_frames = N · J / (B + J).
  const browserShare = totalFrames * jetsonMs / (browserMs + jetsonMs);
  return Math.max(0, Math.min(totalFrames, Math.round(browserShare)));
}
function openRecordModal() {
  if (armingForRecord) cancelArm();
  recordModal.classList.add('active');
  recJetsonCb.checked = localStorage.getItem(JETSON_CHOICE_KEY) === '1';
  syncJetsonModalState();
  // Kick off a fresh probe in the background — if it flips state mid-modal,
  // syncJetsonModalState re-runs from refreshJetsonAvailability.
  refreshJetsonAvailability();
}

function closeRecordModal() {
  recordModal.classList.remove('active');
}

recModalCancelBtn.addEventListener('click', closeRecordModal);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recordModal.classList.contains('active')) closeRecordModal();
});
recordModal.addEventListener('click', (e) => {
  // Click on the dark backdrop (not the card) closes the modal.
  if (e.target === recordModal) closeRecordModal();
});

// Run the browser-side recording and return a promise that resolves to a stats
// object ({ success, frames, elapsedMs }). `framesOverride` caps the recording
// length (used in split mode — browser does [0, split), Jetson does the rest).
// Handles both coord-target and click-arm paths.
function recordInBrowser(framesOverride, backend = 'auto') {
  const target = parseCoordTarget();
  if (target) {
    return startRecordingWithTarget(target.cx, target.cy, framesOverride, backend);
  }
  return new Promise((resolve, reject) => {
    armRecord();
    pendingClickRecord = { resolve, reject, framesOverride, backend };
  });
}

recModalStartBtn.addEventListener('click', async () => {
  const wantBrowser = recBrowserCb.checked;
  const wantJetson = recJetsonCb.checked && !recJetsonCb.disabled;
  // Radio for renderer: 'auto' | 'gpu' | 'cpu'. Only applies to the browser
  // recording path; the Jetson has its own renderer and ignores this.
  const selectedRendererEl = document.querySelector('input[name="rec-renderer"]:checked');
  const browserBackend = selectedRendererEl ? selectedRendererEl.value : 'auto';
  if (!wantBrowser && !wantJetson) {
    alert('Pick at least one target (browser or jetson).');
    return;
  }
  localStorage.setItem(JETSON_CHOICE_KEY, wantJetson ? '1' : '0');
  closeRecordModal();

  const totalFrames = readTotalFrames();

  // SPLIT MODE (both checked): browser is the lead and takes frames [0, split)
  // locally; Jetson picks up [split, total) remotely. Split point is derived
  // from measured per-frame speed of each backend so the slower one gets a
  // proportionally smaller share and both finish around the same time. Both
  // simulate the same camera path from HOME (worker.py advances view state
  // even for skipped frames), so the two outputs line up back-to-back.
  //
  // SINGLE-TARGET (only one checked): that target renders the whole clip.
  const splitFrame = (wantBrowser && wantJetson) ? await computeSplitFrame(totalFrames) : 0;
  const browserFrames = wantBrowser && wantJetson ? splitFrame : totalFrames;
  const jetsonStart  = wantBrowser && wantJetson ? splitFrame : 0;
  const jetsonEnd    = totalFrames;
  if (wantBrowser && wantJetson) {
    console.log(`record split: browser [0,${splitFrame}) · jetson [${splitFrame},${totalFrames})`);
  }

  // Skip a target when the split hands it a degenerate range — e.g. a very
  // slow browser against a fast Jetson can round browser's share down to
  // zero, in which case the Jetson just does the whole clip.
  const doBrowser = wantBrowser && browserFrames >= 2;
  const doJetson  = wantJetson  && jetsonEnd > jetsonStart;

  resetRecordProgress({
    total: totalFrames,
    browserTarget: doBrowser ? browserFrames : 0,
    jetsonTarget: doJetson ? (jetsonEnd - jetsonStart) : 0,
  });
  setProgressVisible(true);

  // Split mode: both backends render part of the clip. Tell the browser record
  // to hold its blob (instead of auto-downloading) so we can upload it to the
  // Jetson for concatenation — single merged mp4 out, not two fragments.
  const splitMode = doBrowser && doJetson;
  holdBrowserBlob = splitMode;
  pendingBrowserBlob = null;

  const overallT0 = performance.now();
  let browserStats = null;
  let jetsonStats = null;
  try {
    const jetsonPromise = doJetson
      ? runJetsonJob({ startFrame: jetsonStart, endFrame: jetsonEnd, skipDownload: splitMode })
      : null;
    if (doBrowser) browserStats = await recordInBrowser(browserFrames, browserBackend);
    if (jetsonPromise) jetsonStats = await jetsonPromise;
  } catch (e) {
    if (e?.message !== 'cancelled') console.error('record flow:', e);
  }
  const overallElapsedMs = performance.now() - overallT0;
  // Clamp the per-backend counters to their targets so the bar hits 100% even
  // when the final poll/update was missed. Then stop the clock.
  if (browserStats?.success) recordProgress.browserDone = recordProgress.browserTarget;
  if (jetsonStats?.success)  recordProgress.jetsonDone  = recordProgress.jetsonTarget;
  stopRecordProgress();

  // Post-processing: merge the two parts into a single mp4 if both succeeded.
  if (splitMode && browserStats?.success && jetsonStats?.success && pendingBrowserBlob) {
    // Bar stays at 100%; the text marks the phase transitions from rendering
    // to merging to downloading so the user sees activity after "100%".
    progressFill.style.width = '100%';
    progressText.textContent = 'uploading browser part…';
    try {
      const mergeRes = await fetch(`${jetsonStats.url}/merge/${jetsonStats.jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'video/mp4' },
        body: pendingBrowserBlob,
      });
      if (!mergeRes.ok) throw new Error(`HTTP ${mergeRes.status}: ${await mergeRes.text()}`);
      progressText.textContent = 'downloading merged mp4…';
      const dlRes = await fetch(`${jetsonStats.url}/download/${jetsonStats.jobId}`);
      const blob = await dlRes.blob();
      triggerBlobDownload(blob, `mandelbrot-${Date.now()}.mp4`);
    } catch (e) {
      console.error('merge failed', e);
      alert(`Merge failed: ${e.message}\n\nDownloading both parts separately.`);
      triggerBlobDownload(pendingBrowserBlob, `mandelbrot-part1-${Date.now()}.mp4`);
      try {
        const dlRes = await fetch(`${jetsonStats.url}/download/${jetsonStats.jobId}`);
        triggerBlobDownload(await dlRes.blob(), `mandelbrot-part2-${Date.now()}.mp4`);
      } catch {}
    }
  }
  pendingBrowserBlob = null;
  holdBrowserBlob = false;

  setProgressVisible(false);
  if (browserStats?.success || jetsonStats?.success) {
    showStatsModal(browserStats, jetsonStats, overallElapsedMs);
  }
});

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- Post-record stats modal ----------

const statsModal = document.getElementById('stats-modal');
const statsBody = document.getElementById('stats-body');
const statsOkBtn = document.getElementById('stats-ok');

function addStatsRow(label, value, cls = '') {
  const l = document.createElement('span');
  l.className = `label ${cls}`.trim();
  l.textContent = label;
  const v = document.createElement('span');
  v.className = `value ${cls}`.trim();
  v.textContent = value;
  statsBody.appendChild(l);
  statsBody.appendChild(v);
}
function addStatsSep() {
  const sep = document.createElement('div');
  sep.className = 'sep';
  statsBody.appendChild(sep);
}

function showStatsModal(browser, jetson, overallMs) {
  const browserFrames = browser?.frames ?? 0;
  const jetsonFrames = jetson?.frames ?? 0;
  const doneFrames = browserFrames + jetsonFrames;
  // `recordProgress.total` is what the user asked for. Diverges from actual
  // done when a backend fails or the user cancels mid-render — flag it so
  // the stats read honestly instead of silently pretending "81 frames" was
  // the goal when it was actually "100 frames requested, 81 delivered".
  const requested = recordProgress.total || doneFrames;
  const incomplete = doneFrames < requested;

  statsBody.innerHTML = '';
  addStatsRow(
    incomplete ? 'rendered' : 'total',
    incomplete
      ? `${doneFrames} / ${requested} frames · ${fmtElapsed(overallMs)}`
      : `${doneFrames} frames · ${fmtElapsed(overallMs)}`,
    'highlight',
  );
  addStatsRow('throughput', `${fmtFps(doneFrames, overallMs)} (wall-clock)`, 'highlight');
  if (incomplete) {
    addStatsRow('note', `${requested - doneFrames} frames missing (cancelled or failed)`, 'highlight');
  }

  if (browserFrames > 0 || jetsonFrames > 0) addStatsSep();
  if (browserFrames > 0) {
    addStatsRow('browser',
      `${browserFrames} frames · ${fmtFps(browserFrames, browser.elapsedMs)} · ${fmtElapsed(browser.elapsedMs)}`);
  }
  if (jetsonFrames > 0) {
    addStatsRow('jetson',
      `${jetsonFrames} frames · ${fmtFps(jetsonFrames, jetson.elapsedMs)} · ${fmtElapsed(jetson.elapsedMs)}`);
  }
  statsModal.classList.add('active');
}

function closeStatsModal() { statsModal.classList.remove('active'); }
statsOkBtn.addEventListener('click', closeStatsModal);
statsModal.addEventListener('click', (e) => { if (e.target === statsModal) closeStatsModal(); });
window.addEventListener('keydown', (e) => {
  if ((e.key === 'Escape' || e.key === 'Enter') && statsModal.classList.contains('active')) closeStatsModal();
});

// ---------- Debug helpers ----------
// One-call snapshot of every piece of state I'd want to see when triaging
// "the screen is black" / "the layout is off" / "rendering is stuck" reports.
// Returns the snapshot AND console-logs it grouped, so the user can copy-paste
// or just eyeball it. Prefer `window.mb()` (alias) for terseness.
window.dumpMandelbrotState = function dumpMandelbrotState() {
  const z = HOME.scale / view.scale;
  const zoomDigits = Math.abs(view.scale) > 0 ? Math.ceil(Math.log10(1 / Math.abs(view.scale))) : 0;
  const decimalPrec = (typeof Decimal.precision === 'number') ? Decimal.precision : Decimal.config().precision;
  const snap = {
    view: {
      kind: view.kind,                       // mandelbrot | julia
      juliaC: view.kind === 'julia' ? { ...view.juliaC } : null,
      escapeRadius: view.escapeRadius,
      escapeRadiusSq: view.escapeRadius * view.escapeRadius,
      maxIterOverride: view.maxIterOverride,
      effectiveMaxIter: computeMaxIter(),
      cx: view.cx.toString(),
      cy: view.cy.toString(),
      scale: view.scale,
      scaleExp: view.scale.toExponential(3),
      zoom: z.toExponential(3),
      zoomDigits,
    },
    backend: {
      effectiveBackend: effectiveBackend(),
      effectiveTechnique: effectiveTechnique(),
      renderBackendOverride: renderBackend,
      gpuScaleLimit: GPU_SCALE_LIMIT,
      directZoomLimit: DIRECT_ZOOM_LIMIT,
    },
    orbitCache: {
      len: orbitCache.len,
      maxIterCovered: orbitCache.maxIterCovered,
      cachedScale: orbitCache.scale,
      refCx: orbitCache.refCx ? orbitCache.refCx.toString() : null,
      refCy: orbitCache.refCy ? orbitCache.refCy.toString() : null,
      hasOrbitDD: !!orbitCache.orbitDD,
      orbitDDLen: orbitCache.orbitDD ? orbitCache.orbitDD.length : 0,
      hasOrbitQD: !!orbitCache.orbitQD,
      orbitQDLen: orbitCache.orbitQD ? orbitCache.orbitQD.length : 0,
      // How "fresh" is the cache for the CURRENT view? Same logic as orbitCacheFresh.
      ...(orbitCache.refCx ? (() => {
        const aspect = canvas.width / canvas.height;
        const dx = Number(view.cx.minus(orbitCache.refCx));
        const dy = Number(view.cy.minus(orbitCache.refCy));
        return {
          dxFromRef: dx.toExponential(3),
          dyFromRef: dy.toExponential(3),
          inViewport: Math.abs(dx) < view.scale * aspect && Math.abs(dy) < view.scale,
          maxIterRequested: computeOrbitMaxIter(),
          freshForCurrentView: orbitCacheFresh(view.cx, view.cy, view.scale, aspect, computeOrbitMaxIter()),
        };
      })() : {}),
    },
    iter: {
      computeMaxIter: computeMaxIter(),
      computeOrbitMaxIter: computeOrbitMaxIter(),
      computeOrbitMaxIter_hq: computeOrbitMaxIter(true),
      MAX_ORBIT_LEN,
      ORBIT_MAX_ITER_CAP,
      ORBIT_MAX_ITER_CAP_HQ,
      // Per-phase iter caps as they would be issued RIGHT NOW for the current
      // view + backend. Lets you see at a glance whether the d=2 phase is
      // about to run with too few iterations to expose the boundary.
      cpuPhaseIterCaps: {
        d8:  effectiveBackend() === 'cpu' ? computePixelMaxIter(8) : '(GPU mode — uses computeMaxIter)',
        d4:  effectiveBackend() === 'cpu' ? computePixelMaxIter(4) : '(GPU mode — uses computeMaxIter)',
        d2:  effectiveBackend() === 'cpu' ? computePixelMaxIter(2) : '(GPU mode — uses computeMaxIter)',
      },
      // Diagnostic: ratio between per-pixel iter cap and orbit length. If
      // ratio >> 1 the perturbation will rebase repeatedly (TD-f32 / DD-f64
      // accumulating error) — likely cause of "uniform brown" zones.
      perPixelIterVsOrbitLen: orbitCache.len > 0
        ? `${computeMaxIter()}/${orbitCache.len} = ${(computeMaxIter() / orbitCache.len).toFixed(1)}× rebases needed`
        : 'no orbit',
      // Which CPU precision tier the next render would use, given current
      // zoom and orbit cache state. 'dd' for zoomDigits<31, 'qd' for ≥31
      // (auto-promoted), 'dd-fallback' if QD requested but orbit-worker
      // hadn't emitted QD samples yet.
      cpuPrecisionTier: (() => {
        if (effectiveBackend() !== 'cpu') return '(GPU mode)';
        const zoomDigits = Math.abs(view.scale) > 0 ? Math.ceil(Math.log10(1 / Math.abs(view.scale))) : 0;
        if (zoomDigits < 31) return 'dd';
        return orbitCache.orbitQD ? 'qd' : 'dd-fallback (orbit-worker not yet at QD threshold)';
      })(),
    },
    palette: (() => {
      const pal = currentPalette();
      const zoomDecades = Math.log10(Math.max(1, HOME.scale / view.scale));
      return {
        name: paletteEl?.value ?? '(unknown)',
        a: pal.a, b: pal.b, c: pal.c, d: pal.d,
        zoomDecadeRotation: -0.3 * zoomDecades,
      };
    })(),
    canvas: {
      drawingBuffer: { w: canvas.width, h: canvas.height },
      cssClient: { w: canvas.clientWidth, h: canvas.clientHeight },
      dpr: window.devicePixelRatio || 1,
      cssTransform: canvas.style.transform || '(none)',
      cssTransformOrigin: canvas.style.transformOrigin || '(default)',
    },
    renderWidth: {
      override: renderWidthSelect?.value ?? '(no element)',
      effective: typeof effectiveRenderWidth === 'function' ? effectiveRenderWidth() : null,
      // What auto-mode would pick for the current zoom — useful for sanity-
      // checking the depth-based downscale thresholds.
      autoFor10pow20: 'auto downscales: <10^20 = 1×, 10^20-30 = 1/2, 10^30-50 = 1/4, ≥10^50 = 1/8',
    },
    flags: {
      orbitDirty,
      gpuBusy,
      pendingFrame,
      renderNeeded,
      isRecording,
      fullResLocked,
      progressiveActive,
      dragLowRes,
      cpuRenderInFlight,
      cpuRenderQueued,
      zoomPreviewActive,
      skipReferenceUpdate,
      armingForRecord,
      hqInFlight,                       // user-triggered tiered-quality render running (cancellable by another `h` press)
      qualityLevel,                     // 0 = default progressive; 1-3 = `h`-stepped tiers (1=half/no-deep, 2=full/no-deep, 3=full/deep-orbit/max-iters)
      maxQualityLevel: MAX_QUALITY_LEVEL,
      autoZoomActive,                   // user toggled the ▶auto button — zoom-loop fires toward canvas centre, deferring while progressiveActive
    },
    progressive: {
      progressiveGen,
      orbitWorkerReqId,
      orbitWorkerLatestCompleted,
      orbitDirty,                       // an orbit request is in flight; rapid preset switches that bump this without draining used to OOM the tab
      orbitInFlight: orbitWorkerReqId - orbitWorkerLatestCompleted,
      cpuDispatchReqId,
      cpuDispatchEntriesSize: cpuDispatchEntries.size, // outstanding cpuRenderPixels dispatches; >1 means pile-up risk avoided by cancel-on-new
      cpuRenderGen,
      renderCallSeq,                    // bumps on every render() entry — total GPU render attempts
      blitUpscaleSeq,                   // bumps on every blitUpscale() — total CPU→swapchain blits
      progressivePhasesGpu: PROGRESSIVE_PHASES,
      progressivePhasesCpu: PROGRESSIVE_PHASES_CPU,
      progressiveIdleMs: PROGRESSIVE_IDLE_MS,
    },
    cpuBlitTexture: cpuBlitTexture ? {
      width: cpuBlitTexture.width,
      height: cpuBlitTexture.height,
      format: cpuBlitTexture.format,
    } : null,
    lastFrameTexture: lastFrameTexture ? {
      width: lastFrameTexture.width,
      height: lastFrameTexture.height,
      format: lastFrameTexture.format,
    } : null,
    cpuPool: {
      workerCount: cpuWorkers.length,
      pendingCount: pendingCpuCount,
      hardwareConcurrency: navigator.hardwareConcurrency,
    },
    config: {
      home: { cx: HOME.cx.toString(), cy: HOME.cy.toString(), scale: HOME.scale },
      clickZoom: CLICK_ZOOM,
      previewScale: PREVIEW_SCALE,
      decimalPrecision: decimalPrec,
      cpuFinalMaxIterFloor: CPU_FINAL_MAX_ITER_FLOOR,
      cpuFinalMaxIterCeil: CPU_FINAL_MAX_ITER_CEIL,
      cpuMidMaxIter: CPU_MID_MAX_ITER,
      cpuPreviewMaxIter: CPU_PREVIEW_MAX_ITER,
    },
    lastClickViewport,
  };
  console.groupCollapsed(`%c[mandelbrot state] zoom=${snap.view.zoom} scale=${snap.view.scaleExp} backend=${snap.backend.effectiveBackend}/${snap.backend.effectiveTechnique} orbitLen=${snap.orbitCache.len}`, 'color:#5af');
  console.log('view:', snap.view);
  console.log('backend:', snap.backend);
  console.log('orbitCache:', snap.orbitCache);
  console.log('iter:', snap.iter);
  console.log('palette:', snap.palette);
  console.log('canvas:', snap.canvas);
  console.log('renderWidth:', snap.renderWidth);
  console.log('flags:', snap.flags);
  console.log('progressive:', snap.progressive);
  console.log('cpuBlitTexture:', snap.cpuBlitTexture);
  console.log('lastFrameTexture:', snap.lastFrameTexture);
  console.log('cpuPool:', snap.cpuPool);
  console.log('config:', snap.config);
  if (snap.lastClickViewport) console.log('lastClickViewport:', snap.lastClickViewport);
  console.groupEnd();
  return snap;
};
window.mb = window.dumpMandelbrotState;
console.log('[mandelbrot] debug helper ready: call window.mb() (or window.dumpMandelbrotState()) for a full state dump.');

// ---------------------------------------------------------------------------
// One-shot boot sync — runs once everything (coord input refs, kind UI, etc.)
// has been declared. Without this, mandelbrot.html?kind=julia loads view.cx/cy
// from HOME_BY_KIND.julia (= 0+0i) but the coord-re/coord-im inputs keep
// their hard-coded HTML default values (Mandelbrot home) until the user
// triggers something that calls updateCoordInputsFromView.
// ---------------------------------------------------------------------------
console.log(`[boot] one-shot sync: kind=${view.kind} view.cx=${view.cx} view.cy=${view.cy}`);
updateCoordInputsFromView();
if (typeof updateHUD === 'function') updateHUD();
if (typeof updatePickerMarker === 'function') updatePickerMarker();
if (typeof updateOrbitForCurrentC === 'function') updateOrbitForCurrentC();
