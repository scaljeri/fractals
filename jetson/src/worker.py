"""Render worker: takes a job spec, drives the CUDA kernel frame by frame, and
pipes BGRA frames to ffmpeg (h264_nvenc) to produce an mp4.

This module is designed to be called by the FastAPI server's async worker.
"""

from __future__ import annotations

import collections
import math
import subprocess
import time
from pathlib import Path
from typing import Callable

# `os` is imported below where NUM_INFLIGHT is defined; re-import is a no-op.

import numpy as np
import pycuda.driver as cuda  # type: ignore[import-not-found]
from pycuda.compiler import SourceModule  # type: ignore[import-not-found]
from gmpy2 import mpfr, get_context  # type: ignore[import-not-found]

from . import reference

# Do not use pycuda.autoinit: it creates a context bound to the importing
# thread (FastAPI main), which is NOT the thread asyncio.to_thread uses to
# run render_job → cuModuleLoadDataEx fails with "invalid device context".
# Instead, create and destroy the context inside render_job on whatever
# thread is running. cuda.init() is process-wide and safe to call here.
cuda.init()


def _pick_video_encoder() -> str:
    """Probe ffmpeg for h264_nvenc; fall back to libx264 if absent.

    Ubuntu's apt-provided ffmpeg is built without NVENC. Trying to use
    h264_nvenc on such a build causes ffmpeg to exit immediately with
    `Unknown encoder`, which shows up in Python as `Broken pipe` when
    we try to write frames. Detect once at import and log the choice.
    """
    probe = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "color=c=black:s=64x64:r=15:d=1",
         "-c:v", "h264_nvenc", "-frames:v", "1", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    if probe.returncode == 0:
        print("[worker] ffmpeg encoder: h264_nvenc")
        return "h264_nvenc"
    print("[worker] ffmpeg encoder: libx264 (h264_nvenc not available)")
    print(f"[worker]   nvenc probe stderr: {probe.stderr.strip()[:200]}")
    return "libx264"


_VIDEO_ENCODER = _pick_video_encoder()

import os

# Number of frames pipelined through the GPU at once. Each slot gets its own
# CUDA stream + d_pixels buffer + pinned host buffer. Can be overridden with
# MANDELBROT_NUM_INFLIGHT (takes effect on service restart).
#
# Tuning note: the Mandelbrot kernel has heavy branch divergence (pixels
# inside the set iterate max_iter times, pixels outside escape in 5–50
# iters), so even at "GPU 99%" many SMs sit idle within each kernel. Running
# multiple kernels concurrently fills those gaps. CPU parallelism is not
# the answer: the encoder only takes ~28ms/frame while the kernel takes
# seconds, so at NUM_INFLIGHT=1 the CPU is idle because it has nothing to
# do — not because it's being scheduled badly.
NUM_INFLIGHT = int(os.environ.get("MANDELBROT_NUM_INFLIGHT", "4"))

# Live telemetry exposed to the HTTP layer. Python int/float reads/writes
# are atomic under the GIL, so the main thread can read these while the
# render thread updates them — no lock needed.
INFLIGHT_NOW = 0
STATS = {
    "frames_done": 0,       # frames completed in the CURRENT job
    "gpu_ms_total": 0.0,    # CUDA-event time: kernel launch + dtoh
    "cpu_ms_total": 0.0,    # wall clock for ffmpeg write + view update
    "job_id": None,         # id of the job these stats belong to
}


def _reset_stats(job_id: str | None) -> None:
    STATS["frames_done"] = 0
    STATS["gpu_ms_total"] = 0.0
    STATS["cpu_ms_total"] = 0.0
    STATS["job_id"] = job_id

# Tunable constants, mirror main.js record-loop.
ZOOM_IN = 0.97
ZOOM_IN_SLOW = 0.995
ZOOM_OUT = 1.08
MOVE_NORMAL = 0.04
MOVE_RECOVER = 0.10
MOVE_ESCAPE = 0.20
MIX_BOUNDARY = 0.05
CONTRAST_OK = 6
ANALYZE_INTERVAL = 100

# IQ cosine palette presets — MUST mirror PALETTES in frontend/main.js so that
# Jetson-rendered videos match the browser's preview of the same palette.
# colour(t) = a + b * cos(2π(c·t + d)).
PALETTES = {
    "warm":     {"a": (0.5, 0.5, 0.5), "b": (0.5, 0.5, 0.5), "c": (1.0, 1.0, 1.0), "d": (0.00, 0.10, 0.20)},
    "lava":     {"a": (0.5, 0.5, 0.5), "b": (0.5, 0.5, 0.5), "c": (1.0, 0.7, 0.4), "d": (0.00, 0.15, 0.20)},
    "ocean":    {"a": (0.5, 0.5, 0.5), "b": (0.5, 0.5, 0.5), "c": (1.0, 1.0, 1.0), "d": (0.30, 0.20, 0.20)},
    "electric": {"a": (0.5, 0.5, 0.5), "b": (0.5, 0.5, 0.5), "c": (2.0, 1.0, 0.0), "d": (0.50, 0.20, 0.25)},
    "rainbow":  {"a": (0.5, 0.5, 0.5), "b": (0.5, 0.5, 0.5), "c": (1.0, 1.0, 1.0), "d": (0.00, 0.33, 0.67)},
}


def _load_kernel() -> SourceModule:
    """Compile kernel.cu. Must be called with an active CUDA context.

    No caching across contexts — SourceModule is bound to the context it
    was created in, and we make a fresh context per render. pycuda's
    on-disk cache keeps the nvcc cost down on repeat compiles.

    IMPORTANT: no `--use_fast_math`. Fast-math fuses `a*b` into FMA which
    zeroes the error term in Dekker's TwoProd — the FF arithmetic depends
    on that error term being exact. The kernel uses __*_rn intrinsics in
    the hot loop to force IEEE rounding regardless.
    """
    kernel_path = Path(__file__).parent / "kernel.cu"
    src = kernel_path.read_text()
    return SourceModule(src, options=["-O3"], no_extern_c=True)


def _get_kernel():
    return _load_kernel().get_function("mandelbrot_kernel")


def _find_contrast(pixels: np.ndarray, prefer_uv: tuple[float, float] | None = None):
    """Port of findMaxContrastPixel from main.js — operates on BGRA pixels."""
    h, w = pixels.shape[0], pixels.shape[1]
    cols, rows = 12, 12
    cellW = w // cols
    cellH = h // rows
    step = 4
    best_x, best_y = w / 2, h / 2
    best_score = -1
    best_mix = 0.0
    total_grad = 0.0
    total_samples = 0

    for cy in range(rows):
        for cx in range(cols):
            x0, y0 = cx * cellW, cy * cellH
            x1 = min(x0 + cellW - step, w - step)
            y1 = min(y0 + cellH - step, h - step)

            # Subsample region
            sub = pixels[y0:y1:step, x0:x1:step, :3].astype(np.int16)
            if sub.size == 0:
                continue
            right = pixels[y0:y1:step, x0 + step:x1 + step:step, :3].astype(np.int16)
            down = pixels[y0 + step:y1 + step:step, x0:x1:step, :3].astype(np.int16)
            mh = min(sub.shape[0], down.shape[0])
            mw = min(sub.shape[1], right.shape[1])
            grad_x = np.abs(sub[:mh, :mw] - right[:mh, :mw]).sum()
            grad_y = np.abs(sub[:mh, :mw] - down[:mh, :mw]).sum()
            grad = float(grad_x + grad_y)
            samples = mh * mw
            lums = sub[:mh, :mw].sum(axis=-1)
            black = int((lums < 30).sum())
            colored = samples - black
            mix = min(black, colored) / samples if samples > 0 else 0.0

            proximity = 1.0
            if prefer_uv is not None:
                cell_uvx = ((x0 + cellW / 2) / w) * 2 - 1
                cell_uvy = 1 - ((y0 + cellH / 2) / h) * 2
                d = math.hypot(cell_uvx - prefer_uv[0], cell_uvy - prefer_uv[1])
                proximity = 2.0 / (1.0 + d * 2.0)

            score = grad * (1 + 8 * mix) * proximity
            total_grad += grad
            total_samples += samples
            if score > best_score:
                best_score = score
                best_x = x0 + cellW / 2
                best_y = y0 + cellH / 2
                best_mix = mix

    avg = total_grad / total_samples if total_samples > 0 else 0.0
    return {
        "x": best_x,
        "y": best_y,
        "score": best_score,
        "avg_contrast": avg,
        "best_mix_ratio": best_mix,
    }


def render_job(
    job_id: str,
    out_path: Path,
    center_re: str,
    center_im: str,
    width: int = 1920,
    height: int = 1080,
    frames: int = 900,
    fps: int = 60,
    adaptive: bool = True,
    initial_follow_frames: int = 100,
    progress_cb: Callable[[int, int], None] | None = None,
    palette: str = "warm",
    start_frame: int = 0,
    end_frame: int | None = None,
    cancel_check: Callable[[], bool] | None = None,
    speed: float = 6.0,
):
    """Render a video. Streams BGRA frames to ffmpeg.

    Coords arrive as strings so the full browser-side precision (60 digit
    decimal.js) reaches us intact. We then pick an mpfr precision based on
    the final zoom depth and run the reference orbit + camera-center math
    in arbitrary precision. Only the per-pixel δ ends up as FF-f32 on the
    GPU — exactly the asymmetry perturbation theory exploits.
    """
    HOME_CX, HOME_CY = "-0.5", "0.0"
    HOME_SCALE = 1.3
    aspect = width / height

    # Unknown palette → silently fall back to warm. Browser and Jetson share the
    # same preset names but if they drift (e.g., old frontend against new backend)
    # a sensible default beats a crash.
    pal = PALETTES.get(palette, PALETTES["warm"])

    # Clamp the render window. None/past-end → render to the end of the clip.
    start_frame = max(0, min(frames, start_frame))
    effective_end = frames if end_frame is None else max(start_frame, min(frames, end_frame))

    # Convert user-facing "× per second" speed into per-frame shrink factor —
    # matches the browser's zoomFactorPerFrame() so Jetson and browser renders
    # stay in lockstep on the same clip.
    safe_speed = max(1.01, float(speed))
    zoom_in = (1.0 / safe_speed) ** (1.0 / max(1, fps))

    # Precision scales with the deepest view we'll reach (≈ HOME · zoom_in^N).
    final_scale_est = HOME_SCALE * (zoom_in ** max(1, frames))
    prec_bits = reference.precision_bits_for_scale(final_scale_est)
    get_context().precision = prec_bits

    _reset_stats(job_id)
    ctx = cuda.Device(0).make_context()
    try:
        return _render_job_in_context(
            job_id, out_path, center_re, center_im, width, height,
            frames, fps, adaptive, initial_follow_frames, progress_cb,
            HOME_CX, HOME_CY, HOME_SCALE, aspect, prec_bits, pal,
            start_frame, effective_end, cancel_check, zoom_in,
        )
    finally:
        ctx.pop()
        ctx.detach()


def _render_job_in_context(
    job_id, out_path, center_re, center_im, width, height,
    frames, fps, adaptive, initial_follow_frames, progress_cb,
    HOME_CX, HOME_CY, HOME_SCALE, aspect, prec_bits, pal,
    start_frame, end_frame, cancel_check, zoom_in,
):
    kernel = _get_kernel()
    get_context().precision = prec_bits

    # Per-job zoom parameters (derived from the user's speed setting). The
    # module-level ZOOM_IN / ZOOM_IN_SLOW constants are ignored for this run.
    cruise_zoom = zoom_in
    slow_zoom = zoom_in ** 0.15  # "crawl" at ~15% of cruise speed

    # Camera state: centres in mpfr (arbitrary precision), scale in f64
    # (range/magnitude only; no per-pixel math depends on its precision).
    view_cx = mpfr(HOME_CX)
    view_cy = mpfr(HOME_CY)
    view_scale = HOME_SCALE
    target_cx = mpfr(str(center_re))
    target_cy = mpfr(str(center_im))

    # Adaptive steering state (mirrors main.js)
    seg_start_uv = (0.0, 0.0)
    seg_end_uv = (0.0, 0.0)
    seg_start_zoom = cruise_zoom
    seg_end_zoom = cruise_zoom
    seg_start_move = MOVE_NORMAL
    seg_end_move = MOVE_NORMAL
    seg_frame_start = ANALYZE_INTERVAL
    cached_uv = (0.0, 0.0)
    cached_zoom = cruise_zoom
    cached_move = MOVE_NORMAL

    # Per-slot GPU + pinned-host buffers so NUM_INFLIGHT frames can be in
    # flight. Pinned memory is required for async memcpy_dtoh to overlap with
    # subsequent kernel launches.
    pixels_bytes = width * height * 4
    streams = [cuda.Stream() for _ in range(NUM_INFLIGHT)]
    d_pixels_list = [cuda.mem_alloc(pixels_bytes) for _ in range(NUM_INFLIGHT)]
    h_pixels_list = [
        cuda.pagelocked_empty((height, width, 4), dtype=np.uint8)
        for _ in range(NUM_INFLIGHT)
    ]
    slot_events: list = [None] * NUM_INFLIGHT
    # Per-slot start/end events so we can time the GPU half of each frame
    # (kernel + memcpy_dtoh) independently of CPU work.
    slot_start_evts = [cuda.Event() for _ in range(NUM_INFLIGHT)]
    slot_end_evts   = [cuda.Event() for _ in range(NUM_INFLIGHT)]

    # Start ffmpeg. Encoder picked at import time based on what's available.
    ffmpeg_cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo",
        "-pixel_format", "bgra",
        "-video_size", f"{width}x{height}",
        "-framerate", str(fps),
        "-i", "pipe:0",
        "-c:v", _VIDEO_ENCODER,
    ]
    if _VIDEO_ENCODER == "h264_nvenc":
        ffmpeg_cmd += ["-preset", "p7", "-rc", "vbr", "-b:v", "20M", "-maxrate", "30M"]
    else:
        # libx264 CPU fallback. Pin to 10 encoder threads (one per core) so
        # /jobs can report an explicit number for the dashboard; Jetson Orin
        # AGX has 12 cores, leaving 2 for Python / kernel orchestration.
        ffmpeg_cmd += ["-preset", "veryfast", "-crf", "20", "-threads", "10"]
    ffmpeg_cmd += ["-pix_fmt", "yuv420p", str(out_path)]
    ffmpeg = subprocess.Popen(
        ffmpeg_cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE,
    )

    try:
        block = (16, 16, 1)
        grid = ((width + 15) // 16, (height + 15) // 16, 1)

        # Reference orbit computed once per analysis window. For now re-use the
        # orbit throughout; phase 3 will update per segment if needed.
        # Build initial orbit from HOME center — this is mostly unused for the
        # first frames anyway (pixels escape quickly at HOME scale).
        def build_orbit(cx, cy, max_iter: int):
            ref_cx, ref_cy, ref_len = reference.find_reference(
                cx, cy, view_scale, aspect, max_iter, prec_bits,
            )
            orbit = reference.compute_reference_orbit(
                ref_cx, ref_cy, ref_len, prec_bits,
            )
            return orbit, ref_cx, ref_cy

        def compute_max_iter() -> int:
            zoom_factor = HOME_SCALE / view_scale
            log = math.log10(max(1.0, zoom_factor))
            return min(50000, int(1024 + 1500 * log + 100 * log * log))

        max_iter = compute_max_iter()
        orbit, ref_cx, ref_cy = build_orbit(view_cx, view_cy, max_iter)

        # Orbit buffer: 6 f32 per iter (TD complex at exponent 0). BLA is dropped
        # for now — Phase 3 will add a multi-level BLA tree for skip acceleration.
        d_orbit = cuda.mem_alloc(orbit.nbytes)
        d_orbit_cap = orbit.nbytes
        cuda.memcpy_htod(d_orbit, orbit)
        orbit_len_gpu = len(orbit)

        inflight: collections.deque = collections.deque()  # (frame_idx, slot)
        # Track which slot was most recently drained — that buffer is the
        # "latest pixels" snapshot used for adaptive contrast analysis.
        last_drained_slot = 0

        def drain_one() -> None:
            nonlocal last_drained_slot
            global INFLIGHT_NOW
            fidx, slot = inflight.popleft()
            slot_events[slot].synchronize()
            # GPU time is measured between our two per-slot events.
            gpu_ms = slot_start_evts[slot].time_till(slot_end_evts[slot])
            cpu_t0 = time.monotonic()
            ffmpeg.stdin.write(bytes(h_pixels_list[slot]))
            cpu_ms = (time.monotonic() - cpu_t0) * 1000.0
            last_drained_slot = slot
            INFLIGHT_NOW = len(inflight)
            STATS["frames_done"] += 1
            STATS["gpu_ms_total"] += gpu_ms
            STATS["cpu_ms_total"] += cpu_ms
            if progress_cb:
                # Report progress relative to the actual render range so the
                # browser's bar fills from 0→100% during this job, even if it
                # only covers the tail of a clip after a browser handoff.
                progress_cb(fidx + 1 - start_frame, end_frame - start_frame)

        def drain_all() -> None:
            while inflight:
                drain_one()

        def launch(i: int) -> None:
            global INFLIGHT_NOW
            slot = i % NUM_INFLIGHT
            stream = streams[slot]
            # TDXR: pick frame_exp so scale's mantissa sits in [1, 2). Same exponent
            # is shared by scale and delta_center; deltas stay in mpfr precision
            # until the final split to TD-f32 so no bits are lost on the shift.
            frame_exp = int(math.floor(math.log2(abs(view_scale)))) if view_scale > 0 else 0
            pow2_inv = mpfr(2) ** (-frame_exp)

            # Scale mantissa: view_scale · 2^(-frame_exp) → mpfr → TD-f32 triple.
            scale_mant_mpfr = mpfr(view_scale) * pow2_inv
            s_h, s_m, s_l = reference._split_mpfr_to_td(scale_mant_mpfr)

            # Delta mantissas: (view - ref) · 2^(-frame_exp) → mpfr → TD-f32.
            # Keeping residuals in mpfr all the way through is what gives us
            # the full 21-digit precision the TD kernel expects.
            dcx_scaled = (view_cx - ref_cx) * pow2_inv
            dcy_scaled = (view_cy - ref_cy) * pow2_inv
            dre_h, dre_m, dre_l = reference._split_mpfr_to_td(dcx_scaled)
            dim_h, dim_m, dim_l = reference._split_mpfr_to_td(dcy_scaled)

            # Palette rotation: drift phase with zoom depth so a fractal feature
            # keeps roughly the same colour across frames as iter counts grow.
            # -0.3 cycles per decade mirrors the browser shader; keep in sync.
            zoom_decades = max(0.0, math.log10(HOME_SCALE / view_scale))
            palette_offset = -0.3 * zoom_decades

            slot_start_evts[slot].record(stream)
            kernel(
                d_pixels_list[slot],
                d_orbit,
                np.uint32(orbit_len_gpu),
                np.float32(dre_h), np.float32(dre_m), np.float32(dre_l),
                np.float32(dim_h), np.float32(dim_m), np.float32(dim_l),
                np.float32(s_h),   np.float32(s_m),   np.float32(s_l),
                np.int32(frame_exp),
                np.uint32(width), np.uint32(height),
                np.uint32(compute_max_iter()),
                np.float32(palette_offset),
                np.float32(pal["a"][0]), np.float32(pal["a"][1]), np.float32(pal["a"][2]),
                np.float32(pal["b"][0]), np.float32(pal["b"][1]), np.float32(pal["b"][2]),
                np.float32(pal["c"][0]), np.float32(pal["c"][1]), np.float32(pal["c"][2]),
                np.float32(pal["d"][0]), np.float32(pal["d"][1]), np.float32(pal["d"][2]),
                block=block, grid=grid, stream=stream,
            )
            cuda.memcpy_dtoh_async(
                h_pixels_list[slot], d_pixels_list[slot], stream=stream
            )
            slot_end_evts[slot].record(stream)
            slot_events[slot] = slot_end_evts[slot]
            inflight.append((i, slot))
            INFLIGHT_NOW = len(inflight)

        for i in range(frames):
            # Honour user cancellation: server flips job.status to "cancelling";
            # we poll via cancel_check and bail out. Draining inflight first so
            # ffmpeg gets a clean tail of frames (partial mp4 stays playable).
            if cancel_check is not None and cancel_check():
                drain_all()
                break
            # Render only frames inside [start_frame, end_frame). Outside the
            # range we still advance the camera state so the path is identical
            # to a full render (browser can record [0, start_frame) and the
            # two outputs stitch seamlessly).
            if start_frame <= i < end_frame:
                if len(inflight) >= NUM_INFLIGHT:
                    drain_one()
                launch(i)

            # Decide view for frame i+1 using the same logic as before.
            if i >= frames - 1:
                continue

            # Non-adaptive = pure click-following for the whole render.
            # initial_follow_frames becomes a don't-care in that mode; if the
            # caller set it anyway we still take the follow branch.
            if not adaptive or i < initial_follow_frames:
                # Use mpfr target; difference projected into normalised uv
                # via division by scale (f64). Final uv only needs low
                # precision — it's just a direction hint for the next step.
                dx = float(target_cx - view_cx)
                dy = float(target_cy - view_cy)
                cached_uv = (
                    max(-1, min(1, dx / (view_scale * aspect))),
                    max(-1, min(1, dy / view_scale)),
                )
                cached_zoom = cruise_zoom
                cached_move = MOVE_NORMAL
                seg_end_uv = cached_uv
                seg_end_zoom = cruise_zoom
                seg_end_move = MOVE_NORMAL
            else:
                # Adaptive analysis reads back frame i's pixels, so drain the
                # whole ring before it. Happens every ANALYZE_INTERVAL frames.
                if adaptive and (i - initial_follow_frames) % ANALYZE_INTERVAL == 0:
                    drain_all()
                    seg_start_uv = seg_end_uv
                    seg_start_zoom = seg_end_zoom
                    seg_start_move = seg_end_move
                    seg_frame_start = i
                    c = _find_contrast(
                        h_pixels_list[last_drained_slot], prefer_uv=seg_start_uv,
                    )
                    seg_end_uv = (
                        (c["x"] / width) * 2 - 1,
                        1 - (c["y"] / height) * 2,
                    )
                    if c["best_mix_ratio"] > MIX_BOUNDARY:
                        seg_end_zoom, seg_end_move = cruise_zoom, MOVE_NORMAL
                    elif c["avg_contrast"] > CONTRAST_OK:
                        seg_end_zoom, seg_end_move = slow_zoom, MOVE_RECOVER
                    else:
                        seg_end_zoom, seg_end_move = ZOOM_OUT, MOVE_ESCAPE
                t = min(1.0, (i - seg_frame_start) / ANALYZE_INTERVAL)
                cached_uv = (
                    seg_start_uv[0] + (seg_end_uv[0] - seg_start_uv[0]) * t,
                    seg_start_uv[1] + (seg_end_uv[1] - seg_start_uv[1]) * t,
                )
                cached_zoom = seg_start_zoom + (seg_end_zoom - seg_start_zoom) * t
                cached_move = seg_start_move + (seg_end_move - seg_start_move) * t

            # View update: increment is a small f64 quantity (~scale * 0.04)
            # but we add it to an mpfr centre to preserve the cumulative
            # precision across many frames at deep zoom.
            view_cx = view_cx + mpfr(cached_uv[0] * view_scale * aspect * cached_move)
            view_cy = view_cy + mpfr(cached_uv[1] * view_scale * cached_move)
            view_scale = min(HOME_SCALE, view_scale * cached_zoom)

            # Rebuild reference only when the current ref is clearly outside the
            # viewport. Loose threshold (1× scale, not the original 3×) + no jump
            # to a different grid point unless really needed minimises discrete
            # reference switches, which were visible as frame-to-frame flicker
            # in recorded video. Must drain before re-uploading d_orbit because
            # inflight kernels are still reading it.
            ref_drift_x = float(abs(view_cx - ref_cx))
            ref_drift_y = float(abs(view_cy - ref_cy))
            if ref_drift_x > view_scale * aspect or ref_drift_y > view_scale:
                drain_all()
                max_iter = compute_max_iter()
                orbit, ref_cx, ref_cy = build_orbit(view_cx, view_cy, max_iter)
                if orbit.nbytes > d_orbit_cap:
                    d_orbit.free()
                    d_orbit = cuda.mem_alloc(orbit.nbytes)
                    d_orbit_cap = orbit.nbytes
                cuda.memcpy_htod(d_orbit, orbit)
                orbit_len_gpu = len(orbit)

        # Drain any frames still in flight at the end.
        drain_all()

    finally:
        if ffmpeg.stdin:
            try:
                ffmpeg.stdin.close()
            except BrokenPipeError:
                pass
        # Drain stderr so the reason for a non-zero exit ends up in job.error
        # instead of being swallowed as a bare "Broken pipe".
        stderr_bytes = ffmpeg.stderr.read() if ffmpeg.stderr else b""
        rc = ffmpeg.wait()
        for buf in d_pixels_list:
            buf.free()
        try:
            d_orbit.free()
        except Exception:
            pass  # may not exist if we failed before allocation
        if rc != 0:
            tail = stderr_bytes.decode(errors="replace").strip()[-800:]
            raise RuntimeError(
                f"ffmpeg exited {rc} (encoder={_VIDEO_ENCODER}); stderr: {tail or '(empty)'}"
            )
