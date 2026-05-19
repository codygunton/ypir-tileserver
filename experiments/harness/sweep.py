#!/usr/bin/env python3
"""Batch-replay one workload config across multiple seeds and modes.

Same bounds + same params, different RNG seeds, replayed in both PIR
and HTTP modes (or whatever subset). Each (seed, mode) combination
lands in its own experiments/runs/ directory.

Usage:
    python sweep.py --workload ../workloads/my-config.json --seeds 10
    python sweep.py --workload ../workloads/my-config.json --seeds 30 --modes pir
    python sweep.py --workload ../workloads/my-config.json --seeds 10 --start-seed 100
"""

import argparse
import asyncio
import json
import sys
import tempfile
from copy import deepcopy
from pathlib import Path

# Sibling-module imports without a package.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "workloads"))

from run import run_replay, REPO_ROOT  # noqa: E402
from generate_markov import generate_frames, validate  # noqa: E402


def parse_modes(s: str) -> list[str]:
    items = [m.strip() for m in s.split(",") if m.strip()]
    for m in items:
        if m not in ("pir", "http"):
            raise argparse.ArgumentTypeError(f"unknown mode: {m!r} (expected pir or http)")
    if not items:
        raise argparse.ArgumentTypeError("--modes is empty")
    return items


async def sweep(args: argparse.Namespace) -> None:
    base_cfg = json.loads(args.workload.read_text())
    if base_cfg.get("name", "").upper() == "REPLACE-ME":
        sys.exit(f"{args.workload} still has name=REPLACE-ME from the template.")

    seeds = list(range(args.start_seed, args.start_seed + args.seeds))
    total = len(seeds) * len(args.modes)
    print(f"Sweep: {len(seeds)} seed(s) × {len(args.modes)} mode(s) = {total} run(s)")
    print(f"Seeds: {seeds}")
    print(f"Modes: {args.modes}")

    failures: list[tuple[int, str, str]] = []
    i = 0

    with tempfile.TemporaryDirectory(prefix="ypir-sweep-") as tmp_root:
        tmp_root = Path(tmp_root)

        for seed in seeds:
            cfg = deepcopy(base_cfg)
            cfg["seed"] = seed
            cfg["name"] = f"{base_cfg['name']}-seed{seed}"
            validate(cfg)
            cfg["frames"] = generate_frames(cfg)

            tmp_file = tmp_root / f"{cfg['name']}.json"
            tmp_file.write_text(json.dumps(cfg, indent=2))

            for mode in args.modes:
                i += 1
                print(f"\n=== [{i}/{total}] seed={seed} mode={mode} ===")
                run_args = argparse.Namespace(
                    workload=tmp_file,
                    mode=mode,
                    vite_url=args.vite_url,
                    out_dir=args.out_dir,
                    headed=args.headed,
                )
                try:
                    await run_replay(run_args)
                except Exception as e:
                    msg = f"{type(e).__name__}: {e}"
                    print(f"  RUN FAILED: {msg}")
                    failures.append((seed, mode, msg))
                    if args.bail:
                        raise

    print()
    print(f"Sweep done: {total - len(failures)} succeeded, {len(failures)} failed.")
    if failures:
        for seed, mode, msg in failures:
            print(f"  fail: seed={seed} mode={mode}  ({msg})")
        sys.exit(1)


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--workload", required=True, type=Path,
                   help="Path to the workload config JSON")
    p.add_argument("--seeds", type=int, default=10,
                   help="Number of seeds to run (default 10)")
    p.add_argument("--start-seed", type=int, default=0,
                   help="First seed; sweep covers [start, start+seeds) (default 0)")
    p.add_argument("--modes", type=parse_modes, default=["pir", "http"],
                   help="Comma-separated modes (default 'pir,http')")
    p.add_argument("--vite-url", default="http://localhost:5173")
    p.add_argument("--out-dir", type=Path, default=REPO_ROOT / "experiments" / "runs")
    p.add_argument("--headed", action="store_true",
                   help="Run with visible browser windows (slows things down)")
    p.add_argument("--bail", action="store_true",
                   help="Stop on the first failure")
    args = p.parse_args()

    if not args.workload.exists():
        sys.exit(f"Workload not found: {args.workload}")

    asyncio.run(sweep(args))


if __name__ == "__main__":
    main()
