#!/usr/bin/env python3
"""Replay a workload trajectory against the frontend, collect measurements.

Drives a headless Chromium pointed at the vite dev server, navigates to the
chosen mode (PIR or HTTP baseline), waits for app init, pushes trajectory
frames in real time via `window.__experimentReplay.pushFrame`, then dumps
the measurement events + run metadata into a named run directory.

Assumes the full stack is already running:
    - Rust YPIR server on :8084 (PIR mode only)
    - Flask proxy on :8009
    - vite dev server on :5173 (or wherever --vite-url points)

Usage:
    python run.py --workload ../workloads/pan-nyc-z12-60s.json --mode pir
"""

import argparse
import asyncio
import csv
import json
import platform
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("Playwright not installed. Run:", file=sys.stderr)
    print("    pip install -r experiments/harness/requirements.txt", file=sys.stderr)
    print("    playwright install chromium", file=sys.stderr)
    raise

try:
    import requests
except ImportError:
    requests = None  # /api/dataset probing falls back to None


REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def git_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, cwd=REPO_ROOT, check=True,
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, cwd=REPO_ROOT, check=True,
        ).stdout.strip()
        return f"{out}{'-dirty' if dirty else ''}"
    except Exception:
        return "unknown"


async def wait_for_event_settle(page, threshold_s: float = 2.0, timeout_s: float = 60.0) -> int:
    """Block until window.__experimentReplay.getEvents().length is stable
    for `threshold_s` seconds, or until `timeout_s` elapsed."""
    last_count = -1
    stable_since = None
    deadline = time.monotonic() + timeout_s
    while True:
        count = await page.evaluate("() => window.__experimentReplay.getEvents().length")
        now = time.monotonic()
        if count != last_count:
            last_count = count
            stable_since = now
        elif stable_since is not None and now - stable_since >= threshold_s:
            return count
        if now >= deadline:
            print(f"  Settle timeout after {timeout_s:.0f}s; proceeding with {last_count} events")
            return last_count
        await asyncio.sleep(0.25)


def probe_dataset_info(vite_url: str) -> dict | None:
    """Best-effort fetch of /api/dataset so meta.json records which dataset
    each run was against. Returns None if anything fails."""
    if requests is None:
        return None
    try:
        r = requests.get(f"{vite_url.rstrip('/')}/api/dataset", timeout=5)
        if r.ok:
            return r.json()
    except Exception:
        pass
    return None


async def run_replay(args: argparse.Namespace) -> None:
    workload = json.loads(args.workload.read_text())
    sha = git_sha()
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_name = f"{workload['name']}-{args.mode}-{sha}-{ts}"
    run_dir = args.out_dir / run_name
    run_dir.mkdir(parents=True, exist_ok=True)
    print(f"Run dir: {run_dir}")

    url = f"{args.vite_url.rstrip('/')}/?mode={args.mode}"
    console_log: list[str] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=not args.headed)
        context = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await context.new_page()
        page.on("console", lambda msg: console_log.append(f"[{msg.type}] {msg.text}"))

        print(f"Navigating: {url}")
        await page.goto(url, wait_until="load", timeout=60_000)

        print("Waiting for app to initialize...")
        await page.wait_for_function(
            "() => window.__experimentReplay && window.__experimentReplay.isReady() === true",
            timeout=120_000,
        )
        actual_mode = await page.evaluate("() => window.__experimentReplay.getMode()")
        print(f"App ready in mode={actual_mode!r}")

        # Drop any events from the initial map load (z=6 default viewport).
        await page.evaluate("() => window.__experimentReplay.clearEvents()")

        print(f"Replaying {len(workload['frames'])} frames over {workload['duration_ms']} ms...")
        t_start = time.monotonic()
        for frame in workload["frames"]:
            target = t_start + frame["t"] / 1000.0
            now = time.monotonic()
            wait = target - now
            if wait > 0:
                await asyncio.sleep(wait)
            elif wait < -0.25:
                # Falling behind by more than 250ms — note it but keep going.
                print(f"  Behind by {-wait*1000:.0f}ms at frame t={frame['t']}ms")
            await page.evaluate(
                "(f) => window.__experimentReplay.pushFrame(f)",
                {
                    "t": frame["t"],
                    "lng": frame["lng"],
                    "lat": frame["lat"],
                    "zoom": frame["zoom"],
                },
            )
        replay_elapsed_s = time.monotonic() - t_start
        print(f"Replay finished in {replay_elapsed_s:.1f}s. Waiting for in-flight tiles to settle...")

        final_count = await wait_for_event_settle(page, threshold_s=2.0, timeout_s=120.0)
        events = await page.evaluate("() => window.__experimentReplay.getEvents()")
        stats = await page.evaluate("() => window.__experimentReplay.getStats()")

        await browser.close()

    # --- Write outputs ---
    if events:
        cols = sorted({k for e in events for k in e.keys()})
        with (run_dir / "events.csv").open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(events)

    (run_dir / "trajectory.json").write_text(json.dumps(workload, indent=2))

    dataset_info = probe_dataset_info(args.vite_url)
    meta = {
        "run_name": run_name,
        "workload": workload["name"],
        "seed": workload.get("seed"),
        "mode": args.mode,
        "vite_url": args.vite_url,
        "git_sha": sha,
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "started_at": ts,
        "replay_elapsed_s": round(replay_elapsed_s, 2),
        "event_count": len(events),
        "dataset": dataset_info,
        "dataset_name": (dataset_info or {}).get("name"),
        "stats": stats,
    }
    (run_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    if console_log:
        (run_dir / "console.log").write_text("\n".join(console_log))

    print()
    print(f"Run complete: {run_dir}")
    print(f"  Mode:         {args.mode}")
    print(f"  Events:       {len(events)} (final settled count: {final_count})")
    print(f"  Fetches:      {stats.get('fetches', 0)}")
    print(f"  Cache hits:   {stats.get('cacheHits', 0)}")
    print(f"  p50 / p95:    {stats.get('p50Ms', 0):.0f} / {stats.get('p95Ms', 0):.0f} ms")
    print(f"  Bytes down:   {stats.get('bytesDown', 0):,}")


def main() -> None:
    p = argparse.ArgumentParser(description="Replay a workload against the frontend",
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--workload", required=True, type=Path,
                   help="Path to a workload JSON (see experiments/workloads/SCHEMA.md)")
    p.add_argument("--mode", choices=["pir", "http"], default="pir")
    p.add_argument("--vite-url", default="http://localhost:5173")
    p.add_argument("--out-dir", type=Path, default=REPO_ROOT / "experiments" / "runs",
                   help="Where to create the run directory (default: experiments/runs/)")
    p.add_argument("--headed", action="store_true",
                   help="Run with a visible browser window (useful for debugging)")
    args = p.parse_args()

    if not args.workload.exists():
        sys.exit(f"Workload not found: {args.workload}")

    asyncio.run(run_replay(args))


if __name__ == "__main__":
    main()
