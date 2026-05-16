"""Golden-image validation for the FF (float-float) kernel rewrite.

Renders a short clip at three reference points / zoom depths and asserts each
finished mp4 has visible structure (non-trivial pixel variance). This catches
classes of precision loss where FF would otherwise produce a flat/solid frame.

Run after deploying a kernel change:

    python3 -m pytest jetson/tests/test_ff_golden.py -v

For deeper validation, save the first-frame PNG via --save-first-frame and
diff against a committed baseline:

    JETSON_URL=http://monster:8080 python3 -m pytest \\
      jetson/tests/test_ff_golden.py::test_deep_zoom -v -s
"""
from __future__ import annotations

import io
import shutil
import subprocess
import time
import tempfile
from pathlib import Path

import pytest
import requests


_HAS_FFMPEG = shutil.which("ffmpeg") is not None


POLL_INTERVAL_S = 1.0
RENDER_TIMEOUT_S = 120


# Three well-known deep-zoom targets. Same structure across depths lets us
# catch precision regressions at the edge of what FF supports (~14 digits).
GOLDEN_CASES = [
    (
        "shallow_seahorse",
        "-0.743643887037151",
        "0.131825904205330",
        30,  # initial_follow_frames — gentle zoom
    ),
    (
        "medium_seahorse",
        "-0.743643887037151",
        "0.131825904205330",
        60,  # deeper final depth
    ),
    (
        "needle",
        "-1.74995768370609908556",
        "0.00000000000000020778957360999",
        40,
    ),
]


def _submit_and_wait(base_url: str, body: dict) -> dict:
    r = requests.post(f"{base_url}/render", json=body, timeout=10)
    r.raise_for_status()
    job_id = r.json()["job_id"]
    deadline = time.monotonic() + RENDER_TIMEOUT_S
    last = None
    while time.monotonic() < deadline:
        last = requests.get(f"{base_url}/jobs/{job_id}", timeout=5).json()
        if last["status"] in {"done", "failed", "cancelled"}:
            break
        time.sleep(POLL_INTERVAL_S)
    if last is None or last["status"] != "done":
        pytest.fail(
            f"render did not complete: status={last and last['status']} "
            f"error={last and last.get('error')}"
        )
    return last, job_id


def _first_frame_stats(mp4_bytes: bytes) -> dict:
    """Decode the first frame via ffmpeg and return simple pixel stats.

    Uses ffmpeg to pipe out a raw RGB frame at 64x64; we compute min/max/std
    on the CPU to catch all-black or all-one-color regressions.
    """
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        f.write(mp4_bytes)
        path = f.name
    try:
        # -frames:v 1 -f rawvideo -pix_fmt gray -s 64x64
        proc = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", path, "-frames:v", "1",
             "-f", "rawvideo", "-pix_fmt", "gray", "-s", "64x64", "-"],
            capture_output=True, check=True,
        )
    finally:
        Path(path).unlink(missing_ok=True)
    raw = proc.stdout
    assert len(raw) == 64 * 64, f"unexpected decoded size: {len(raw)}"
    buf = memoryview(raw)
    lo = min(buf)
    hi = max(buf)
    mean = sum(buf) / len(buf)
    # population std
    var = sum((p - mean) ** 2 for p in buf) / len(buf)
    std = var ** 0.5
    return {"min": lo, "max": hi, "mean": mean, "std": std}


@pytest.mark.parametrize("name,re,im,follow", GOLDEN_CASES, ids=[c[0] for c in GOLDEN_CASES])
def test_render_has_structure(base_url: str, name: str, re: str, im: str, follow: int) -> None:
    """FF kernel must produce a visibly non-trivial frame at every depth.

    "All black" or "all one color" would indicate a precision collapse where
    FF can't represent the per-pixel delta accurately enough and all pixels
    land in the same bucket.
    """
    body = {
        "center_re": re,
        "center_im": im,
        "frames": 8,
        "fps": 30,
        "width": 320,
        "height": 240,
        "adaptive": False,
        "initial_follow_frames": follow,
    }
    job, job_id = _submit_and_wait(base_url, body)
    dl = requests.get(f"{base_url}/download/{job_id}", timeout=30)
    dl.raise_for_status()

    # Size sanity check: an 8-frame 320x240 mp4 full of structure encodes to
    # at least ~8KB. A collapsed (all-black / single-color) render would
    # crush to the codec floor (<4KB). Works without a local ffmpeg.
    assert len(dl.content) > 8_000, (
        f"[{name}] mp4 is suspiciously small ({len(dl.content)} bytes) — "
        f"likely a precision collapse producing a uniform frame"
    )

    if not _HAS_FFMPEG:
        pytest.skip(
            "ffmpeg not available locally for pixel-level validation; "
            "size sanity check passed. Install ffmpeg (brew install ffmpeg) "
            "to enable the full test."
        )

    stats = _first_frame_stats(dl.content)
    # Very lenient thresholds — we're just catching outright breakage.
    assert stats["std"] > 5.0, (
        f"[{name}] first frame has almost no pixel variance "
        f"(std={stats['std']:.2f}) — precision likely collapsed\n"
        f"stats={stats}"
    )
    assert stats["max"] > 20, (
        f"[{name}] first frame is near-black (max={stats['max']}) — "
        f"rendering pipeline probably broke, not a precision issue\n"
        f"stats={stats}"
    )
