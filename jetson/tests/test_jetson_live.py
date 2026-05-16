"""Live integration tests against the running Jetson render service.

These talk to the real service over HTTP — they do not mock CUDA. Run with the
service up (systemd unit active or `bash run.sh` foreground):

    pytest jetson/tests -v
    JETSON_URL=http://monster:8080 pytest jetson/tests -v

A failure here with error `No such file or directory: 'nvcc'` means the
service's PATH is missing `/usr/local/cuda/bin` — check the systemd unit's
`Environment=PATH=…` line and restart.
"""
import time

import pytest
import requests


TERMINAL = {"done", "failed", "cancelled"}
POLL_INTERVAL_S = 1.0
RENDER_TIMEOUT_S = 120  # 8 frames @ 320x240 should finish in seconds; generous.


def test_health_endpoint_responds(base_url: str) -> None:
    """Service is reachable and /jobs returns the expected shape."""
    r = requests.get(f"{base_url}/jobs", timeout=5)
    r.raise_for_status()
    data = r.json()
    assert set(data.keys()) >= {"current", "queue_size", "jobs"}


def test_minimal_render_completes(base_url: str) -> None:
    """Smoke test the full pipeline: submit → CUDA compile → render → encode.

    This is the test that catches the nvcc-not-on-PATH class of problem:
    it'll return `status='failed'` with the nvcc error in `job.error`, and we
    surface that error verbatim in the assertion message.
    """
    body = {
        # Classic deep seahorse point — cheap at this size, but exercises
        # perturbation + rebasing code paths.
        "center_re": "-0.743643887037151",
        "center_im": "0.131825904205330",
        "frames": 8,
        "fps": 30,
        "width": 320,
        "height": 240,
        "adaptive": False,
        "initial_follow_frames": 0,
    }
    submit = requests.post(f"{base_url}/render", json=body, timeout=10)
    submit.raise_for_status()
    job_id = submit.json()["job_id"]

    job = _poll_until_terminal(base_url, job_id, timeout_s=RENDER_TIMEOUT_S)

    assert job["status"] == "done", (
        f"render failed: {job.get('error') or '(no error field)'}\n"
        f"full job payload: {job!r}"
    )
    assert job["frames_done"] == body["frames"]


def test_download_returns_mp4(base_url: str) -> None:
    """The completed job produces a real mp4 blob."""
    body = {
        "center_re": "-0.75",
        "center_im": "0",
        "frames": 4,
        "fps": 30,
        "width": 320,
        "height": 240,
        "adaptive": False,
        "initial_follow_frames": 0,
    }
    submit = requests.post(f"{base_url}/render", json=body, timeout=10)
    submit.raise_for_status()
    job_id = submit.json()["job_id"]
    job = _poll_until_terminal(base_url, job_id, timeout_s=RENDER_TIMEOUT_S)
    if job["status"] != "done":
        pytest.fail(f"render failed: {job.get('error')}")

    dl = requests.get(f"{base_url}/download/{job_id}", timeout=10)
    dl.raise_for_status()
    assert dl.headers.get("content-type", "").startswith("video/mp4")
    # MP4 files begin with an `ftyp` box at bytes 4..8.
    assert dl.content[4:8] == b"ftyp", "downloaded bytes are not a valid mp4"


def _poll_until_terminal(base_url: str, job_id: str, *, timeout_s: float) -> dict:
    deadline = time.monotonic() + timeout_s
    last = None
    while time.monotonic() < deadline:
        r = requests.get(f"{base_url}/jobs/{job_id}", timeout=5)
        r.raise_for_status()
        last = r.json()
        if last["status"] in TERMINAL:
            return last
        time.sleep(POLL_INTERVAL_S)
    pytest.fail(f"job {job_id} did not finish within {timeout_s}s; last state: {last!r}")
