"""FastAPI render service. Accepts jobs, runs them in a single asyncio worker,
serves resulting mp4 files.

Run locally on Jetson:
    python3 -m src.server

Then from M5:
    curl -X POST http://jetson:8080/render -H 'Content-Type: application/json' \\
         -d '{"center_re": -0.743, "center_im": 0.131, "frames": 300}'
"""

from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path
from typing import Any

import subprocess

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import worker


# Deployment version = newest mtime across the source files. Recomputed on
# startup, so every `sudo systemctl restart mandelbrot` bumps it and the
# browser can confirm fresh code is live (instead of guessing whether the
# restart actually happened).
def _compute_version() -> str:
    src = Path(__file__).parent
    files = ("server.py", "worker.py", "kernel.cu", "reference.py")
    newest = max((src / f).stat().st_mtime for f in files)
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(newest))


VERSION = _compute_version()


RENDER_DIR = Path(__file__).parent.parent / "renders"
RENDER_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Mandelbrot render service")

# Allow browser client (M5) to call us from any origin on the LAN.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class RenderRequest(BaseModel):
    # Accept as string so the wire protocol preserves arbitrary precision.
    # Current backend converts to Python float; phase 3 will switch to gmpy2.mpfr
    # to actually use the extra digits for zoom > 10^13.
    center_re: str
    center_im: str
    frames: int = Field(default=900, ge=2, le=72000)
    fps: int = Field(default=60, ge=15, le=120)
    width: int = Field(default=1920, ge=64, le=7680)
    height: int = Field(default=1080, ge=64, le=4320)
    adaptive: bool = True
    initial_follow_frames: int = Field(default=100, ge=0, le=10000)
    # Palette preset name — must match a key in worker.PALETTES. Unknown names
    # fall back to "warm" in the worker (graceful degradation over 400-error).
    palette: str = "warm"
    # Optional sub-range render. When the browser records the first half of a
    # clip locally, it hands off [start_frame, frames) to the Jetson via these
    # fields. Defaults render the whole clip.
    start_frame: int = Field(default=0, ge=0, le=72000)
    end_frame: int | None = None
    # Zoom speed = "× shrinks per second". Worker converts to a per-frame
    # factor. Default matches the legacy hardcoded 0.97 at 60fps (~6×/s).
    speed: float = Field(default=6.0, ge=1.01, le=100.0)


class Job(BaseModel):
    id: str
    status: str  # queued | running | done | failed | cancelled
    created_at: float
    started_at: float | None = None
    finished_at: float | None = None
    progress: float = 0.0   # 0..1
    frames_done: int = 0
    frames_total: int = 0
    request: RenderRequest
    error: str | None = None

    @property
    def download_url(self) -> str | None:
        return f"/download/{self.id}" if self.status == "done" else None


JOBS: dict[str, Job] = {}
QUEUE: asyncio.Queue[str] = asyncio.Queue()
CURRENT_JOB: str | None = None


async def worker_loop():
    """Single worker consuming jobs serially."""
    global CURRENT_JOB
    while True:
        job_id = await QUEUE.get()
        job = JOBS.get(job_id)
        if job is None or job.status == "cancelled":
            continue
        CURRENT_JOB = job_id
        job.status = "running"
        job.started_at = time.time()
        job.frames_total = job.request.frames
        out_path = RENDER_DIR / f"{job_id}.mp4"

        def progress_cb(done: int, total: int) -> None:
            job.frames_done = done
            job.frames_total = total
            job.progress = done / total if total else 0.0

        def cancel_check() -> bool:
            return job.status == "cancelling"

        try:
            # Run CUDA render in a thread so we don't block asyncio.
            # Coords pass through as strings so the worker can lift them
            # into gmpy2.mpfr at the precision dictated by zoom depth —
            # this is what makes perturbation stay correct past ~10¹³ zoom.
            await asyncio.to_thread(
                worker.render_job,
                job_id,
                out_path,
                job.request.center_re,
                job.request.center_im,
                job.request.width,
                job.request.height,
                job.request.frames,
                job.request.fps,
                job.request.adaptive,
                job.request.initial_follow_frames,
                progress_cb,
                job.request.palette,
                job.request.start_frame,
                job.request.end_frame,
                cancel_check,
                job.request.speed,
            )
            if job.status == "cancelling":
                job.status = "cancelled"
            else:
                job.status = "done"
                job.progress = 1.0
            job.finished_at = time.time()
        except Exception as e:
            job.status = "failed"
            job.error = str(e)
            job.finished_at = time.time()
        finally:
            CURRENT_JOB = None


@app.on_event("startup")
async def startup():
    asyncio.create_task(worker_loop())


@app.post("/render")
async def submit_render(req: RenderRequest) -> dict[str, Any]:
    job_id = uuid.uuid4().hex[:12]
    job = Job(
        id=job_id,
        status="queued",
        created_at=time.time(),
        request=req,
        frames_total=req.frames,
    )
    JOBS[job_id] = job
    await QUEUE.put(job_id)
    return {"job_id": job_id, "status": "queued", "queue_position": QUEUE.qsize(), "version": VERSION}


@app.get("/jobs")
async def list_jobs() -> dict[str, Any]:
    return {
        "version": VERSION,
        "current": CURRENT_JOB,
        "queue_size": QUEUE.qsize(),
        "jobs": [j.model_dump() | {"download_url": j.download_url} for j in JOBS.values()],
        "worker": {
            "num_inflight_max": worker.NUM_INFLIGHT,
            "num_inflight_now": worker.INFLIGHT_NOW,
            "encoder": worker._VIDEO_ENCODER,
            "cpu_threads": 10 if worker._VIDEO_ENCODER == "libx264" else None,
            "stats": dict(worker.STATS),
        },
    }


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job.model_dump() | {"download_url": job.download_url}


@app.delete("/jobs/{job_id}")
async def cancel_job(job_id: str) -> dict[str, Any]:
    """Cancel or delete — depends on current status.

      queued    → mark cancelled (worker loop skips it)
      running   → mark cancelling (worker loop drains inflight and breaks)
      cancelling → no-op (already in progress)
      done / cancelled / failed → delete the partial mp4 (if any) + forget the job
    """
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.status == "queued":
        job.status = "cancelled"
    elif job.status == "running":
        job.status = "cancelling"
    elif job.status == "cancelling":
        pass  # already cancelling
    elif job.status in ("done", "cancelled", "failed"):
        out = RENDER_DIR / f"{job_id}.mp4"
        if out.exists():
            out.unlink()
        del JOBS[job_id]
    return {"ok": True, "status": job.status if job_id in JOBS else "deleted"}


@app.post("/merge/{job_id}")
async def merge_job(job_id: str, request: Request) -> dict[str, Any]:
    """Concatenate a user-provided browser mp4 with the Jetson's jobId.mp4 into
    a single file. Called after the client finishes both halves of a split
    record — the merged file then flows through the normal /download endpoint.
    """
    job = JOBS.get(job_id)
    if job is None or job.status != "done":
        raise HTTPException(400, f"job not ready to merge (status: {job.status if job else 'missing'})")
    jetson_mp4 = RENDER_DIR / f"{job_id}.mp4"
    if not jetson_mp4.exists():
        raise HTTPException(404, "jetson output missing")

    browser_mp4 = RENDER_DIR / f"{job_id}.browser.mp4"
    browser_mp4.write_bytes(await request.body())

    # Use ffmpeg's concat demuxer. Requires compatible codec settings in both
    # inputs; -c copy avoids re-encode. Falls back to re-encode if stream
    # parameters disagree (different encoders / profiles / keyframe intervals).
    list_file = RENDER_DIR / f"{job_id}.concat.txt"
    list_file.write_text(f"file '{browser_mp4}'\nfile '{jetson_mp4}'\n")
    merged = RENDER_DIR / f"{job_id}.merged.mp4"
    try:
        copy = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
             "-i", str(list_file), "-c", "copy", str(merged)],
            capture_output=True, text=True,
        )
        if copy.returncode != 0:
            # Re-encode fallback — two inputs, concat filter, single H.264 output.
            reenc = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error",
                 "-i", str(browser_mp4), "-i", str(jetson_mp4),
                 "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]",
                 "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast",
                 "-pix_fmt", "yuv420p", str(merged)],
                capture_output=True, text=True,
            )
            if reenc.returncode != 0:
                raise HTTPException(500, f"ffmpeg merge failed: {reenc.stderr.strip()[-500:]}")
        merged.replace(jetson_mp4)
    finally:
        browser_mp4.unlink(missing_ok=True)
        list_file.unlink(missing_ok=True)
    return {"ok": True}


@app.get("/download/{job_id}")
async def download(job_id: str) -> Response:
    job = JOBS.get(job_id)
    if job is None or job.status != "done":
        raise HTTPException(404, "job not done")
    path = RENDER_DIR / f"{job_id}.mp4"
    if not path.exists():
        raise HTTPException(404, "file not found")
    return FileResponse(path, media_type="video/mp4", filename=f"mandelbrot-{job_id}.mp4")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
