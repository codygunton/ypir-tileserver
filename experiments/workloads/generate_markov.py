#!/usr/bin/env python3
"""Generate a Markov-style panning workload for replay.

Produces a deterministic JSON trajectory (viewport + zoom over time)
bounded to a lng/lat box. Same seed + same params = same trajectory.

Schema: see experiments/workloads/SCHEMA.md.

Usage:
    python generate_markov.py \\
        --name pan-nyc-z12-60s \\
        --bounds=-74.05,40.68,-73.89,40.85 \\
        --start-lng -73.97 --start-lat 40.78 --start-zoom 12 \\
        --duration-ms 60000 --tick-ms 250 \\
        --seed 42 \\
        --output pan-nyc-z12-60s.json
"""

import argparse
import json
import math
import random
from pathlib import Path


def parse_bounds(s: str) -> tuple[float, float, float, float]:
    parts = [float(p) for p in s.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("--bounds must be 'w,s,e,n' (four floats)")
    w, s_, e, n = parts
    if not (w < e and s_ < n):
        raise argparse.ArgumentTypeError("--bounds must satisfy w<e and s<n")
    return w, s_, e, n


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def generate_markov_pan(args: argparse.Namespace) -> dict:
    rng = random.Random(args.seed)
    w, s, e, n = args.bounds

    # State
    lng = args.start_lng
    lat = args.start_lat
    zoom = float(args.start_zoom)
    heading = rng.uniform(0, 2 * math.pi)  # initial random direction

    zmin, zmax = args.zoom_min, args.zoom_max
    if not (zmin <= zoom <= zmax):
        raise SystemExit(f"start_zoom {zoom} outside [{zmin},{zmax}]")

    tick_s = args.tick_ms / 1000.0
    zoom_change_prob_per_tick = args.zoom_change_prob_per_s * tick_s

    frames = []
    num_frames = args.duration_ms // args.tick_ms

    for i in range(num_frames):
        t = i * args.tick_ms
        frames.append({
            "t": t,
            "lng": round(lng, 6),
            "lat": round(lat, 6),
            "zoom": round(zoom, 3),
        })

        # Pan: heading drifts; speed jitters; magnitude scales inversely with 2^(z-12)
        # so on-screen pan rate stays roughly constant across zooms.
        heading += rng.gauss(0, args.pan_turn_std)
        speed_scale = 2.0 ** (12 - zoom)  # higher zoom = smaller geographic step
        speed = args.pan_speed_deg_per_s_at_z12 * speed_scale
        speed *= 1.0 + rng.uniform(-args.pan_speed_jitter, args.pan_speed_jitter)

        # Step in (lng, lat). Use cos(lat) to keep visual speed roughly constant
        # in longitude direction (rough Mercator correction).
        dlng = speed * math.cos(heading) * tick_s / max(math.cos(math.radians(lat)), 0.1)
        dlat = speed * math.sin(heading) * tick_s
        lng = clamp(lng + dlng, w, e)
        lat = clamp(lat + dlat, s, n)

        # If we hit a wall, rotate heading toward the box interior so we slide
        # along the edge rather than getting stuck.
        if lng == w and math.cos(heading) < 0:
            heading = math.pi - heading
        if lng == e and math.cos(heading) > 0:
            heading = math.pi - heading
        if lat == s and math.sin(heading) < 0:
            heading = -heading
        if lat == n and math.sin(heading) > 0:
            heading = -heading

        # Zoom: discrete ±1 events with bounded probability per tick.
        if rng.random() < zoom_change_prob_per_tick:
            direction = rng.choice([-1, 1])
            new_zoom = zoom + direction
            if zmin <= new_zoom <= zmax:
                zoom = new_zoom

    return {
        "name": args.name,
        "kind": "markov-pan",
        "seed": args.seed,
        "duration_ms": args.duration_ms,
        "tick_ms": args.tick_ms,
        "bounds": list(args.bounds),
        "start": {
            "lng": args.start_lng,
            "lat": args.start_lat,
            "zoom": args.start_zoom,
        },
        "params": {
            "pan_speed_deg_per_s_at_z12": args.pan_speed_deg_per_s_at_z12,
            "pan_turn_std": args.pan_turn_std,
            "pan_speed_jitter": args.pan_speed_jitter,
            "zoom_change_prob_per_s": args.zoom_change_prob_per_s,
            "zoom_range": [zmin, zmax],
        },
        "frames": frames,
    }


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", required=True)
    p.add_argument("--bounds", required=True, type=parse_bounds,
                   help="Lng/lat clamp box as w,s,e,n (e.g. -74.05,40.68,-73.89,40.85)")
    p.add_argument("--start-lng", required=True, type=float)
    p.add_argument("--start-lat", required=True, type=float)
    p.add_argument("--start-zoom", required=True, type=float)
    p.add_argument("--duration-ms", type=int, default=60000)
    p.add_argument("--tick-ms", type=int, default=250)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--pan-speed-deg-per-s-at-z12", type=float, default=0.002,
                   help="Pan speed at z=12 in degrees/sec. ~0.002 ≈ a slow steady pan.")
    p.add_argument("--pan-turn-std", type=float, default=0.3,
                   help="Per-tick heading change std-dev (radians). 0.3 ≈ ~17°.")
    p.add_argument("--pan-speed-jitter", type=float, default=0.2)
    p.add_argument("--zoom-change-prob-per-s", type=float, default=0.05,
                   help="Per-second probability of a discrete ±1 zoom event.")
    p.add_argument("--zoom-min", type=int, default=9)
    p.add_argument("--zoom-max", type=int, default=13)
    p.add_argument("--output", required=True, type=Path)
    args = p.parse_args()

    trajectory = generate_markov_pan(args)
    args.output.write_text(json.dumps(trajectory, indent=2))
    print(f"Wrote {args.output} — {len(trajectory['frames'])} frames, "
          f"duration {args.duration_ms} ms, seed {args.seed}")


if __name__ == "__main__":
    main()
