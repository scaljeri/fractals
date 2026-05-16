// Mandelbrot kernel for Jetson Orin: TDXR perturbation.
//
// TDXR = Triple-float mantissa (vec3<f32>, ~21 decimal digits) + int32 exponent
// per pixel. Same "floatexp" trick every deep-zoom renderer uses (rust-fractal,
// fraktaler-3, Fractalshades, davidbau GpuAdaptive). Mantissa stays unit-scale
// via renormalisation; all magnitude bookkeeping is in the int exponent, which
// gives effectively unbounded zoom range.
//
// Jetson Orin (Ampere SM 8.7) runs f64 at ~1/32 of f32 throughput; TDXR stays
// on f32 throughout, so no f64 penalty. Scale vs. the old FF-f32 kernel:
//   - 3× mantissa components instead of 2  → a few extra f32 ops per arithmetic
//   - extra ldexp calls for exponent alignment on every iteration
// Roughly 2–3× slower per iteration, but unlocks zoom past FF's ~10^14 wall.
//
// CRITICAL: compile WITHOUT --use_fast_math. Dekker's error-free transforms
// (two_sum/two_prod) depend on FMA NOT being fused into a*b. We use __*_rn
// intrinsics explicitly on the hot path to force standard IEEE rounding.
//
// Inputs:
//   orbit[]               — 6 f32/iter: [re.h, re.m, re.l, im.h, im.m, im.l]
//                           Z stays bounded (< escape radius), so no exponent.
//   orbit_len             — number of reference iterations
//   delta_re_{h,m,l}      — TD mantissa of (view - ref).re at exponent frame_exp
//   delta_im_{h,m,l}      — TD mantissa of (view - ref).im at exponent frame_exp
//   scale_{h,m,l}         — TD mantissa of view.scale at exponent frame_exp
//   frame_exp             — shared i32 exponent for all three frame quantities
//   resolution            — (width, height)
//   max_iter              — per-pixel iteration budget
//
// Output:
//   pixels[] — BGRA8 per pixel (width*height*4 bytes)

#include <cuda_runtime.h>
#include <math.h>

// ---------- Exact building blocks (IEEE round-nearest, no FMA fusion) ----------

__device__ inline float2 two_sum(float a, float b) {
    float s  = __fadd_rn(a, b);
    float bb = __fsub_rn(s, a);
    float err = __fadd_rn(__fsub_rn(a, __fsub_rn(s, bb)), __fsub_rn(b, bb));
    return make_float2(s, err);
}

__device__ inline float2 two_prod(float a, float b) {
    float p = __fmul_rn(a, b);
    float err = __fmaf_rn(a, b, -p);  // exact: err = a*b - p
    return make_float2(p, err);
}

// ---------- Triple-float (TD) arithmetic on float3 ----------
// Value (x, y, z) with true value ≈ x+y+z and |y| ≤ ulp(x)/2, |z| ≤ ulp(y)/2.
// Three-pass Priest-style renormalisation keeps the invariant even under cancellation.

__device__ inline float3 renorm3(float a, float b, float c) {
    float2 s1 = two_sum(b, c);
    float2 t1 = two_sum(a, s1.x);
    float2 t2 = two_sum(t1.y, s1.y);
    return make_float3(t1.x, t2.x, t2.y);
}

__device__ inline float3 td_add(float3 a, float3 b) {
    float2 sh = two_sum(a.x, b.x);
    float2 sm = two_sum(a.y, b.y);
    float  sl = __fadd_rn(a.z, b.z);
    float2 m  = two_sum(sh.y, sm.x);
    float  l  = __fadd_rn(__fadd_rn(sm.y, sl), m.y);
    return renorm3(sh.x, m.x, l);
}

__device__ inline float3 td_neg(float3 a) { return make_float3(-a.x, -a.y, -a.z); }
__device__ inline float3 td_sub(float3 a, float3 b) { return td_add(a, td_neg(b)); }

__device__ inline float3 td_mul(float3 a, float3 b) {
    float2 p00 = two_prod(a.x, b.x);
    float2 p01 = two_prod(a.x, b.y);
    float2 p10 = two_prod(a.y, b.x);
    // Second-order (ulp²) terms: hi parts only.
    float  p02 = __fmul_rn(a.x, b.z);
    float  p20 = __fmul_rn(a.z, b.x);
    float  p11 = __fmul_rn(a.y, b.y);
    float2 m1 = two_sum(p00.y, p01.x);
    float2 m2 = two_sum(m1.x, p10.x);
    float  l  = __fadd_rn(__fadd_rn(__fadd_rn(__fadd_rn(__fadd_rn(__fadd_rn(m1.y, m2.y), p01.y), p10.y), p02), p20), p11);
    return renorm3(p00.x, m2.x, l);
}

__device__ inline float3 td_mul_f32(float3 a, float b) {
    float2 p0 = two_prod(a.x, b);
    float2 p1 = two_prod(a.y, b);
    float  p2 = __fmul_rn(a.z, b);
    float2 m  = two_sum(p0.y, p1.x);
    float  l  = __fadd_rn(__fadd_rn(m.y, p1.y), p2);
    return renorm3(p0.x, m.x, l);
}

// Doubling is exact in f32 — just an exponent bump on each component.
__device__ inline float3 td_dbl(float3 a) {
    return make_float3(__fmul_rn(a.x, 2.0f), __fmul_rn(a.y, 2.0f), __fmul_rn(a.z, 2.0f));
}

// Multiply TD by 2^e (exact per-component exponent shift). Subnormal/underflow
// below 2^-126 flushes to zero — correct behaviour (the value is negligible
// relative to anything at a higher exponent).
__device__ inline float3 td_ldexp(float3 a, int e) {
    return make_float3(ldexpf(a.x, e), ldexpf(a.y, e), ldexpf(a.z, e));
}

// Pick the exponent that normalises max(|re.x|, |im.x|) into [1, 2). Returns 0
// when both components are essentially zero (caller keeps old exp).
__device__ inline int td_peak_exp(float3 re, float3 im) {
    float peak = fmaxf(fabsf(re.x), fabsf(im.x));
    if (peak < 1e-30f) return 0;
    return (int)floorf(log2f(peak));
}

// ---------- Reference orbit loader (TD complex, always at exponent 0) ----------

struct TdC { float3 re, im; };

__device__ inline TdC load_orbit(const float* orbit, unsigned int i) {
    const unsigned int b = i * 6u;
    TdC z;
    z.re = make_float3(orbit[b + 0], orbit[b + 1], orbit[b + 2]);
    z.im = make_float3(orbit[b + 3], orbit[b + 4], orbit[b + 5]);
    return z;
}

// ---------- Palette (IQ cosine, parameters passed in — matches browser shader) ----------
// colour(t) = a + b * cos(2π(c·t + d)). The named presets (warm/lava/ocean/...)
// are defined in worker.py PALETTES and sent through as 12 floats per kernel launch.
__device__ inline void palette(
    float t,
    float3 a, float3 b, float3 c, float3 d,
    unsigned char* r_out, unsigned char* g_out, unsigned char* b_out
) {
    const float TWOPI = 6.28318530718f;
    float rr = a.x + b.x * cosf(TWOPI * (c.x * t + d.x));
    float gg = a.y + b.y * cosf(TWOPI * (c.y * t + d.y));
    float bb = a.z + b.z * cosf(TWOPI * (c.z * t + d.z));
    *r_out = (unsigned char)(fminf(fmaxf(rr, 0.0f), 1.0f) * 255.0f);
    *g_out = (unsigned char)(fminf(fmaxf(gg, 0.0f), 1.0f) * 255.0f);
    *b_out = (unsigned char)(fminf(fmaxf(bb, 0.0f), 1.0f) * 255.0f);
}

// ---------- Main kernel ----------

extern "C" __global__ void mandelbrot_kernel(
    unsigned char* pixels,
    const float* orbit,
    unsigned int orbit_len,
    // Delta (view - ref) as TD mantissa at exponent frame_exp
    float delta_re_h, float delta_re_m, float delta_re_l,
    float delta_im_h, float delta_im_m, float delta_im_l,
    // View half-width (scale) as TD mantissa at exponent frame_exp
    float scale_h, float scale_m, float scale_l,
    int frame_exp,
    unsigned int width, unsigned int height,
    unsigned int max_iter,
    // Palette rotation phase + IQ cosine parameters (a, b, c, d, each float3)
    float palette_offset,
    float pal_a_r, float pal_a_g, float pal_a_b,
    float pal_b_r, float pal_b_g, float pal_b_b,
    float pal_c_r, float pal_c_g, float pal_c_b,
    float pal_d_r, float pal_d_g, float pal_d_b
) {
    unsigned int px = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int py = blockIdx.y * blockDim.y + threadIdx.y;
    if (px >= width || py >= height) return;

    const float aspect = (float)width / (float)height;
    const float uvx = ((float)px / (float)width) * 2.0f - 1.0f;
    const float uvy = 1.0f - ((float)py / (float)height) * 2.0f;

    const float3 scale_tdm   = make_float3(scale_h, scale_m, scale_l);
    const float3 delta_re_tdm = make_float3(delta_re_h, delta_re_m, delta_re_l);
    const float3 delta_im_tdm = make_float3(delta_im_h, delta_im_m, delta_im_l);

    // Per-pixel δ in mantissa form at exponent frame_exp:
    //   δ.re = scale·aspect·uv.x + delta_center.re
    //   δ.im = scale·uv.y        + delta_center.im
    const float3 aspect_scale_m = td_mul_f32(scale_tdm, aspect);
    const float3 pxl_dx_m = td_mul_f32(aspect_scale_m, uvx);
    const float3 pxl_dy_m = td_mul_f32(scale_tdm, uvy);
    const float3 delta_re_m_total = td_add(delta_re_tdm, pxl_dx_m);
    const float3 delta_im_m_total = td_add(delta_im_tdm, pxl_dy_m);
    const int    delta_exp = frame_exp;

    // Perturbation state: w in mantissa form + per-pixel w_exp (absolute).
    // Starting w = 0, w_exp aligned with delta so the first iterate (w_1 = δ)
    // needs no re-alignment.
    float3 w_re = make_float3(0.0f, 0.0f, 0.0f);
    float3 w_im = make_float3(0.0f, 0.0f, 0.0f);
    int    w_exp = delta_exp;
    unsigned int ref_i = 0;
    unsigned int actual_i = 0;
    bool escaped = false;
    float Zfinal_re = 0.0f, Zfinal_im = 0.0f;

    while (actual_i < max_iter && ref_i < orbit_len) {
        const TdC z = load_orbit(orbit, ref_i);

        // Reconstruct w at exponent 0 for escape/rebase checks (hi part only).
        const float w_re_actual = ldexpf(w_re.x, w_exp);
        const float w_im_actual = ldexpf(w_im.x, w_exp);
        const float Z_re = z.re.x + w_re_actual;
        const float Z_im = z.im.x + w_im_actual;

        const float zz = Z_re * Z_re + Z_im * Z_im;
        if (zz > 65536.0f) {
            escaped = true;
            Zfinal_re = Z_re;
            Zfinal_im = Z_im;
            break;
        }

        // Zhuoran rebasing (preemptive + forced at end of orbit):
        //   if |Z+w| < 2·|w|, reset w ← Z+w (at exponent 0), restart from ref 0.
        const float z_norm = fmaxf(fabsf(Z_re), fabsf(Z_im));
        const float w_norm = fmaxf(fabsf(w_re_actual), fabsf(w_im_actual));
        const bool at_end  = (ref_i + 1u >= orbit_len);
        const bool zhuoran = (ref_i > 0u && z_norm < 2.0f * w_norm);
        if (at_end || zhuoran) {
            const float3 w_re_at0 = td_ldexp(w_re, w_exp);
            const float3 w_im_at0 = td_ldexp(w_im, w_exp);
            w_re = td_add(z.re, w_re_at0);
            w_im = td_add(z.im, w_im_at0);
            w_exp = 0;
            ref_i = 0;
            continue;
        }

        // W_{n+1} = 2·z·w + w² + δ, computed in mantissa form at a common exponent.
        // Natural exponents:
        //   2·z·w   → w_exp       (z is unit-scale)
        //   w²      → 2·w_exp     (usually ≪ w_exp → underflows, correctly vanishes)
        //   δ       → delta_exp   (frame-constant)
        // target_exp = max of the three so every shift is ≤ 0 — underflow-safe.
        const float3 two_zw_re = td_sub(td_mul(z.re, td_dbl(w_re)), td_mul(z.im, td_dbl(w_im)));
        const float3 two_zw_im = td_add(td_mul(z.re, td_dbl(w_im)), td_mul(z.im, td_dbl(w_re)));
        const float3 w_sq_re   = td_sub(td_mul(w_re, w_re), td_mul(w_im, w_im));
        const float3 w_sq_im   = td_dbl(td_mul(w_re, w_im));

        const int target_exp = max(max(w_exp, 2 * w_exp), delta_exp);
        const float3 term1_re = td_ldexp(two_zw_re, w_exp - target_exp);
        const float3 term1_im = td_ldexp(two_zw_im, w_exp - target_exp);
        const float3 term2_re = td_ldexp(w_sq_re, 2 * w_exp - target_exp);
        const float3 term2_im = td_ldexp(w_sq_im, 2 * w_exp - target_exp);
        const float3 term3_re = td_ldexp(delta_re_m_total, delta_exp - target_exp);
        const float3 term3_im = td_ldexp(delta_im_m_total, delta_exp - target_exp);

        float3 new_w_re = td_add(td_add(term1_re, term2_re), term3_re);
        float3 new_w_im = td_add(td_add(term1_im, term2_im), term3_im);
        int    new_w_exp = target_exp;

        // Renormalise so mantissa peak sits in [1, 2).
        const int shift = td_peak_exp(new_w_re, new_w_im);
        if (shift != 0) {
            new_w_re = td_ldexp(new_w_re, -shift);
            new_w_im = td_ldexp(new_w_im, -shift);
            new_w_exp += shift;
        }

        w_re = new_w_re;
        w_im = new_w_im;
        w_exp = new_w_exp;
        ref_i++;
        actual_i++;
    }

    const unsigned int out_idx = (py * width + px) * 4;
    if (!escaped) {
        pixels[out_idx + 0] = 0;
        pixels[out_idx + 1] = 0;
        pixels[out_idx + 2] = 0;
        pixels[out_idx + 3] = 255;
        return;
    }

    // IQ smooth iteration: n - log2(log2(|Z|²)) + 4, plus zoom-coupled palette
    // rotation (palette_offset) so a fractal feature keeps a stable colour
    // across frames as iteration counts grow.
    const float zz_final = Zfinal_re * Zfinal_re + Zfinal_im * Zfinal_im;
    const float smooth_i = (float)actual_i - log2f(log2f(zz_final)) + 4.0f;
    const float t = log2f(smooth_i + 1.0f) * 4.0f + palette_offset;

    const float3 pal_a = make_float3(pal_a_r, pal_a_g, pal_a_b);
    const float3 pal_b = make_float3(pal_b_r, pal_b_g, pal_b_b);
    const float3 pal_c = make_float3(pal_c_r, pal_c_g, pal_c_b);
    const float3 pal_d = make_float3(pal_d_r, pal_d_g, pal_d_b);
    unsigned char r, g, b;
    palette(t, pal_a, pal_b, pal_c, pal_d, &r, &g, &b);
    // BGRA to match WebGPU canvas format on Mac.
    pixels[out_idx + 0] = b;
    pixels[out_idx + 1] = g;
    pixels[out_idx + 2] = r;
    pixels[out_idx + 3] = 255;
}
