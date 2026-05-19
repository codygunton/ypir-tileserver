#!/usr/bin/env python3
"""Sweep all five terrain workloads across N seeds × {pir, http}.

Total runs = 5 workloads × N seeds × 2 modes = 10N.

Usage:
    python run_all.py                  # 10 seeds  -> 100 runs
    python run_all.py --seeds 30       # 30 seeds  -> 300 runs
    python run_all.py --modes pir      # PIR only, 5 × 30 = 150 runs
"""

import argparse
import asyncio
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "workloads"))

from sweep import sweep, parse_modes  # noqa: E402
from run import REPO_ROOT  # noqa: E402


WORKLOADS = [
    "nyc.json",
    "murray-hill.json",
    "finger-lakes.json",
    "five-ponds.json",
    "atlantic.json",
]


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--seeds", type=int, default=10,
                   help="Number of seeds per workload (default 10)")
    p.add_argument("--start-seed", type=int, default=0)
    p.add_argument("--modes", type=parse_modes, default=["pir", "http"],
                   help="Comma-separated modes (default 'pir,http')")
    p.add_argument("--vite-url", default="http://localhost:5173")
    p.add_argument("--bail", action="store_true",
                   help="Stop on the first failure")
    args = p.parse_args()

    workload_dir = REPO_ROOT / "experiments" / "workloads"
    missing = [w for w in WORKLOADS if not (workload_dir / w).exists()]
    if missing:
        sys.exit(f"Missing workload(s): {missing}")

    total_runs = len(WORKLOADS) * args.seeds * len(args.modes)
    print(f"run_all: {len(WORKLOADS)} workloads × {args.seeds} seeds × "
          f"{len(args.modes)} modes = {total_runs} run(s)\n")

    any_failed = False
    for w in WORKLOADS:
        print(f"\n############### {w} ###############")
        sweep_args = argparse.Namespace(
            workload=workload_dir / w,
            seeds=args.seeds,
            start_seed=args.start_seed,
            modes=args.modes,
            vite_url=args.vite_url,
            out_dir=REPO_ROOT / "experiments" / "runs",
            headed=False,
            bail=args.bail,
        )
        try:
            asyncio.run(sweep(sweep_args))
        except SystemExit as e:
            # sweep() sys.exits(1) at the end if any individual run failed.
            # Surface that, but keep going to the next workload unless --bail.
            if e.code and e.code != 0:
                any_failed = True
                if args.bail:
                    print("--bail: stopping after first failure")
                    raise

    if any_failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
