#!/usr/bin/env python3
"""Generate (or regenerate) frames for a Markov-pan workload from a config JSON.

The config and the trajectory share the same schema (see SCHEMA.md): a
config is just a trajectory without the `frames` field. This script reads
the config, fills in `frames` deterministically from `seed` + `params`,
and writes the file back. Idempotent — same params + same seed = same file.

Usage:
    python generate_markov.py experiments/workloads/pan-nyc-z12-60s.json

    # write to a different path
    python generate_markov.py config.json --output out.json

    # override the seed (useful for sweeps over the same config)
    python generate_markov.py config.json --seed 7

Required fields in the config:
    name, kind ("markov-pan"), seed, duration_ms, tick_ms,
    bounds [w,s,e,n], start {lng,lat,zoom}, params { ... }

Where params has:
    pan_speed_deg_per_s_at_z12, pan_turn_std, pan_speed_jitter,
    zoom_change_prob_per_s, zoom_range [zmin, zmax],
    zoom_momentum (optional, default 0.0)
"""

import argparse
import json
import math
import random
import sys
from pathlib import Path


REQUIRED_PARAMS = (
    "pan_speed_deg_per_s_at_z12",
    "pan_turn_std",
    "pan_speed_jitter",
    "zoom_change_prob_per_s",
    "zoom_range",
)


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def validate(cfg: dict) -> None:
    if cfg.get("kind") != "markov-pan":
        raise SystemExit(f"Config kind must be 'markov-pan' (got {cfg.get('kind')!r})")
    for k in ("name", "seed", "duration_ms", "tick_ms", "bounds", "start", "params"):
        if k not in cfg:
            raise SystemExit(f"Config missing required field: {k}")
    if len(cfg["bounds"]) != 4:
        raise SystemExit("`bounds` must be [w, s, e, n]")
    for k in ("lng", "lat", "zoom"):
        if k not in cfg["start"]:
            raise SystemExit(f"`start` missing required field: {k}")
    for k in REQUIRED_PARAMS:
        if k not in cfg["params"]:
            raise SystemExit(f"`params` missing required field: {k}")
    zmin, zmax = cfg["params"]["zoom_range"]
    z0 = cfg["start"]["zoom"]
    if not (zmin <= z0 <= zmax):
        raise SystemExit(f"start.zoom={z0} outside zoom_range=[{zmin},{zmax}]")


def generate_frames(cfg: dict) -> list[dict]:
    rng = random.Random(cfg["seed"])
    w, s, e, n = cfg["bounds"]
    lng = cfg["start"]["lng"]
    lat = cfg["start"]["lat"]
    zoom = float(cfg["start"]["zoom"])
    heading = rng.uniform(0, 2 * math.pi)

    p = cfg["params"]
    zmin, zmax = p["zoom_range"]
    tick_s = cfg["tick_ms"] / 1000.0
    zoom_change_prob_per_tick = p["zoom_change_prob_per_s"] * tick_s
    # Momentum: P(same direction as last zoom change | a change fires).
    # 0.0 = independent coin flips (jittery). ~0.8 = clusters of consecutive
    # zoom-ins or zoom-outs. Default is 0.0 for backwards compatibility.
    zoom_momentum = p.get("zoom_momentum", 0.0)
    last_zoom_direction: int | None = None

    frames = []
    num_frames = cfg["duration_ms"] // cfg["tick_ms"]

    for i in range(num_frames):
        frames.append({
            "t": i * cfg["tick_ms"],
            "lng": round(lng, 6),
            "lat": round(lat, 6),
            "zoom": round(zoom, 3),
        })

        # Pan: heading drift + Mercator-corrected step. Speed scales with
        # 2^(12-zoom) so on-screen pan rate stays roughly constant across zooms.
        heading += rng.gauss(0, p["pan_turn_std"])
        speed_scale = 2.0 ** (12 - zoom)
        speed = p["pan_speed_deg_per_s_at_z12"] * speed_scale
        speed *= 1.0 + rng.uniform(-p["pan_speed_jitter"], p["pan_speed_jitter"])

        dlng = speed * math.cos(heading) * tick_s / max(math.cos(math.radians(lat)), 0.1)
        dlat = speed * math.sin(heading) * tick_s
        lng = clamp(lng + dlng, w, e)
        lat = clamp(lat + dlat, s, n)

        # Slide along walls rather than getting stuck in a corner.
        if lng == w and math.cos(heading) < 0:
            heading = math.pi - heading
        if lng == e and math.cos(heading) > 0:
            heading = math.pi - heading
        if lat == s and math.sin(heading) < 0:
            heading = -heading
        if lat == n and math.sin(heading) > 0:
            heading = -heading

        # Discrete ±1 zoom events with momentum.
        if rng.random() < zoom_change_prob_per_tick:
            if last_zoom_direction is None:
                direction = rng.choice([-1, 1])
            elif rng.random() < zoom_momentum:
                direction = last_zoom_direction
            else:
                direction = -last_zoom_direction
            # At a boundary, flip direction (zmax can only zoom out, etc.).
            if not (zmin <= zoom + direction <= zmax):
                direction = -direction
            new_zoom = zoom + direction
            if zmin <= new_zoom <= zmax:
                zoom = new_zoom
                last_zoom_direction = direction

    return frames


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("config", type=Path,
                   help="Path to the config / trajectory JSON. Frames are regenerated in place.")
    p.add_argument("--output", "-o", type=Path,
                   help="Write to a different path instead of overwriting the config")
    p.add_argument("--seed", type=int,
                   help="Override the seed in the config (useful for sweeps)")
    args = p.parse_args()

    if not args.config.exists():
        sys.exit(f"Config not found: {args.config}")

    cfg = json.loads(args.config.read_text())
    if args.seed is not None:
        cfg["seed"] = args.seed
    validate(cfg)

    cfg["frames"] = generate_frames(cfg)

    out_path = args.output or args.config
    out_path.write_text(json.dumps(cfg, indent=2))
    print(f"Wrote {out_path} — {len(cfg['frames'])} frames, "
          f"duration {cfg['duration_ms']} ms, seed {cfg['seed']}")


if __name__ == "__main__":
    main()
