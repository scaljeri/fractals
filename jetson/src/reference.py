"""Reference orbit computation for perturbation theory.

Iterates z_{n+1} = z_n² + c at a precision that scales with zoom depth,
then splits each complex-plane value into a triple-float (TD-f32) triple
for the GPU kernel. The reference orbit must stay coherent across tens of
thousands of iterations — Python's builtin float (f64, ~15 digits) can't
do that past zoom ~10¹³. gmpy2.mpfr gives arbitrary precision.

The GPU side uses TD-f32 (~21 decimal digits) combined with a per-pixel
i32 exponent (TDXR) — this is the "floatexp" pattern that every deep-zoom
renderer converges on (rust-fractal, fraktaler-3, Fractalshades, davidbau).
|Z_n| stays bounded by the escape radius, so orbit entries don't need an
exponent; only the per-pixel δ does.
"""

from __future__ import annotations

import math

import numpy as np
from gmpy2 import mpfr, get_context  # type: ignore[import-not-found]


BAILOUT_SQ = 256.0 * 256.0  # |Z|² > 65536 for IQ smooth iter stability


def precision_bits_for_scale(view_scale: float) -> int:
    """Pick an mpfr precision (in bits) for a given view scale.

    Rule of thumb: we need ~log₂(1/scale) bits just to represent the
    reference point accurately; double that for iteration headroom, then
    floor at 53 bits (f64 equivalent) for shallow zoom where plain float
    would have sufficed anyway.
    """
    if view_scale <= 0:
        return 53
    zoom_bits = max(0.0, math.log2(1.0 / view_scale))
    return max(53, int(2.0 * zoom_bits) + 53)


def _split_mpfr_to_td(x: mpfr) -> tuple[float, float, float]:
    """Split an mpfr value into (hi, mid, lo) f32 triple with hi+mid+lo ≈ x.

    Residuals are taken in mpfr precision, so no bits are lost even when x
    has far more digits than a single f32 can represent. Result is a valid
    TD value (|mid| ≤ ulp(hi)/2, |lo| ≤ ulp(mid)/2).
    """
    hi = np.float32(float(x))
    rem1 = x - mpfr(float(hi))
    mid = np.float32(float(rem1))
    rem2 = rem1 - mpfr(float(mid))
    lo = np.float32(float(rem2))
    return float(hi), float(mid), float(lo)


def compute_reference_orbit(
    c_re: str | float,
    c_im: str | float,
    max_iter: int,
    prec_bits: int = 53,
) -> np.ndarray:
    """Compute the reference orbit at arbitrary precision.

    Args:
        c_re, c_im: reference point — accepts strings (preserves full
            frontend precision) or plain floats.
        max_iter: iteration cap.
        prec_bits: mpfr precision in bits. Use `precision_bits_for_scale`
            to pick based on zoom depth.

    Returns: (N, 6) f32 array where each row is
        [re_hi, re_mid, re_lo, im_hi, im_mid, im_lo]
    ready to upload to the CUDA kernel. N ≤ max_iter; stops early on escape.
    """
    get_context().precision = prec_bits
    cr = mpfr(str(c_re))
    ci = mpfr(str(c_im))
    zx = mpfr(0)
    zy = mpfr(0)
    bailout = mpfr(BAILOUT_SQ)

    orbit = np.zeros((max_iter, 6), dtype=np.float32)
    n = 0
    for i in range(max_iter):
        rh, rm, rl = _split_mpfr_to_td(zx)
        ih, im_mid, il = _split_mpfr_to_td(zy)
        orbit[i, 0] = rh
        orbit[i, 1] = rm
        orbit[i, 2] = rl
        orbit[i, 3] = ih
        orbit[i, 4] = im_mid
        orbit[i, 5] = il
        n = i + 1
        zx2 = zx * zx
        zy2 = zy * zy
        if zx2 + zy2 > bailout:
            break
        nx = zx2 - zy2 + cr
        ny = 2 * zx * zy + ci
        zx, zy = nx, ny
    return orbit[:n]


def count_orbit_len(
    c_re: mpfr | float, c_im: mpfr | float, max_iter: int, prec_bits: int = 53
) -> int:
    """Iterate until escape (or max_iter) at mpfr precision; return length."""
    get_context().precision = prec_bits
    zx = mpfr(0)
    zy = mpfr(0)
    cr = c_re if isinstance(c_re, mpfr) else mpfr(str(c_re))
    ci = c_im if isinstance(c_im, mpfr) else mpfr(str(c_im))
    bailout = mpfr(BAILOUT_SQ)
    for i in range(max_iter):
        zx2 = zx * zx
        zy2 = zy * zy
        if zx2 + zy2 > bailout:
            return i
        nx = zx2 - zy2 + cr
        ny = 2 * zx * zy + ci
        zx, zy = nx, ny
    return max_iter


def find_reference(
    view_cx: mpfr | float,
    view_cy: mpfr | float,
    scale: float,
    aspect: float,
    max_iter: int,
    prec_bits: int = 53,
) -> tuple[mpfr, mpfr, int]:
    """Pick a reference point with a long orbit near the view center.

    At deep zoom the viewport is tiny and all 9×9 grid points have nearly
    identical orbits — the grid search only earns its keep at shallow zoom
    where the viewport spans a meaningful region. Skip the search when
    the center already stays in-set to max_iter.
    """
    get_context().precision = prec_bits
    vcx = view_cx if isinstance(view_cx, mpfr) else mpfr(str(view_cx))
    vcy = view_cy if isinstance(view_cy, mpfr) else mpfr(str(view_cy))

    best_cx, best_cy = vcx, vcy
    best_len = count_orbit_len(vcx, vcy, max_iter, prec_bits)
    if best_len >= max_iter:
        return best_cx, best_cy, best_len

    N = 9
    scale_mpfr = mpfr(scale)
    aspect_mpfr = mpfr(aspect)
    for i in range(N):
        for j in range(N):
            if i == (N - 1) // 2 and j == (N - 1) // 2:
                continue
            u = mpfr(i / (N - 1)) * 2 - 1
            v = mpfr(j / (N - 1)) * 2 - 1
            tx = vcx + u * scale_mpfr * aspect_mpfr * mpfr("0.98")
            ty = vcy + v * scale_mpfr * mpfr("0.98")
            n = count_orbit_len(tx, ty, max_iter, prec_bits)
            if n > best_len:
                best_len = n
                best_cx = tx
                best_cy = ty
                if best_len >= max_iter:
                    return best_cx, best_cy, best_len
    return best_cx, best_cy, best_len


