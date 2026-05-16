#!/usr/bin/env python3
"""Fake the browser's jetson-button flow against a running render service.

Talks only to the HTTP API (like the real frontend does) and prints every
step verbosely — what's submitted, the raw response, each poll, the final
status, and on failure the server-side `error` field. That error field is
what tells you which *command* inside the render pipeline blew up (e.g.
`cuModuleLoadDataEx failed: …`, `ffmpeg returned non-zero`, etc.).

Run:
    python3 jetson/scripts/fake-browser.py
    JETSON_URL=http://monster:8080 python3 jetson/scripts/fake-browser.py
    python3 jetson/scripts/fake-browser.py --frames 8 --width 320 --height 240
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError


def _get_json(url: str, timeout: float = 10) -> dict:
    with urlrequest.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _post_json(url: str, body: dict, timeout: float = 10) -> dict:
    req = urlrequest.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _trace(step: str, payload) -> None:
    print(f"→ {step}")
    if payload is not None:
        print(json.dumps(payload, indent=2))
    print()


def main() -> int:
    default_base = os.environ.get("JETSON_URL") or (
        f"http://{os.environ.get('JETSON_HOST', 'monster')}:"
        f"{os.environ.get('JETSON_PORT', '8080')}"
    )
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default=default_base.rstrip("/"))
    p.add_argument("--center-re", default="-0.743643887037151")
    p.add_argument("--center-im", default="0.131825904205330")
    p.add_argument("--frames", type=int, default=8,
                   help="small defaults so the pipeline blows up fast")
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--width", type=int, default=320)
    p.add_argument("--height", type=int, default=240)
    p.add_argument("--adaptive", action="store_true")
    p.add_argument("--poll-interval", type=float, default=1.0)
    p.add_argument("--timeout", type=float, default=120)
    args = p.parse_args()

    print(f"target: {args.base_url}\n")

    # 1. Health — same call the frontend does every 30s.
    try:
        health = _get_json(f"{args.base_url}/jobs", timeout=5)
    except (HTTPError, URLError) as e:
        print(f"✗ cannot reach {args.base_url}/jobs: {e}")
        return 2
    _trace("GET /jobs (health)", {
        "current": health["current"],
        "queue_size": health["queue_size"],
        "job_count": len(health["jobs"]),
    })

    # 2. Submit — mirrors the browser's queueOnJetson() body.
    body = {
        "center_re": args.center_re,
        "center_im": args.center_im,
        "frames": args.frames,
        "fps": args.fps,
        "width": args.width,
        "height": args.height,
        "adaptive": args.adaptive,
        "initial_follow_frames": min(50, args.frames // 2),
    }
    _trace("POST /render", body)
    try:
        submit = _post_json(f"{args.base_url}/render", body)
    except HTTPError as e:
        print(f"✗ submit rejected: HTTP {e.code}\n{e.read().decode()}")
        return 2
    job_id = submit["job_id"]
    _trace("response", submit)

    # 3. Poll — print each status snapshot so a failure mid-render is visible.
    deadline = time.monotonic() + args.timeout
    last = None
    print(f"→ polling /jobs/{job_id} every {args.poll_interval}s")
    while time.monotonic() < deadline:
        last = _get_json(f"{args.base_url}/jobs/{job_id}")
        stamp = time.strftime("%H:%M:%S")
        print(
            f"  [{stamp}] status={last['status']:<9s} "
            f"frames={last['frames_done']}/{last['frames_total']} "
            f"progress={last['progress']:.2%}"
        )
        if last["status"] in {"done", "failed", "cancelled"}:
            break
        time.sleep(args.poll_interval)
    else:
        print(f"\n✗ timed out after {args.timeout}s — last snapshot:")
        print(json.dumps(last, indent=2))
        return 3

    print()

    # 4. Report the exact failure the browser would see.
    if last["status"] != "done":
        print(f"✗ job {last['status']}")
        err = last.get("error")
        if err:
            print(f"\nserver error:\n  {err}\n")
            print("↑ this is the string the frontend shows in its alert.")
            print("  Look for it verbatim in pycuda/ffmpeg/jetson source.")
        else:
            print("  (no error field returned — check journalctl on the Jetson)")
        print("\nfull job payload:")
        print(json.dumps(last, indent=2))
        return 1

    # 5. Success path — download like the browser does.
    _trace("GET /download/" + job_id, None)
    with urlrequest.urlopen(f"{args.base_url}/download/{job_id}", timeout=30) as r:
        data = r.read()
    ok = data[4:8] == b"ftyp"
    print(f"got {len(data)} bytes, mp4 header {'ok' if ok else 'MISSING'}")
    if not ok:
        print(f"first bytes: {data[:16]!r}")
        return 1
    out = f"/tmp/fake-browser-{job_id}.mp4"
    with open(out, "wb") as f:
        f.write(data)
    print(f"✓ saved {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
