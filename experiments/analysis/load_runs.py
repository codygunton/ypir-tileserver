"""Load all runs under experiments/runs/ into a single pandas DataFrame.

Each row is one event (one tile request from the measurement panel).
Run-level columns (workload, mode, seed, git_sha, started_at, run_name)
are joined onto the event rows so you can group/filter without juggling
separate dataframes.

Usage:
    from load_runs import load_runs
    df = load_runs()                            # default: experiments/runs/
    df = load_runs("experiments/runs", since="20260520")
    print(df.groupby(["workload", "mode"])["latency_ms"].describe())
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd


REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_RUNS_DIR = REPO_ROOT / "experiments" / "runs"


def load_runs(
    runs_dir: str | Path = DEFAULT_RUNS_DIR,
    since: str | None = None,
    workload: str | None = None,
    mode: str | None = None,
) -> pd.DataFrame:
    """Load every run directory in `runs_dir` into one DataFrame.

    Filters (all optional):
        since:    keep runs with started_at >= this prefix, e.g. "20260520"
        workload: exact match against meta.json's "workload"
        mode:     'pir' or 'http'
    """
    runs_dir = Path(runs_dir)
    if not runs_dir.exists():
        raise FileNotFoundError(f"runs directory not found: {runs_dir}")

    frames: list[pd.DataFrame] = []
    skipped: list[tuple[str, str]] = []

    for run_dir in sorted(runs_dir.iterdir()):
        if not run_dir.is_dir():
            continue
        meta_path = run_dir / "meta.json"
        events_path = run_dir / "events.csv"
        if not meta_path.exists():
            skipped.append((run_dir.name, "no meta.json"))
            continue
        try:
            meta = json.loads(meta_path.read_text())
        except Exception as e:
            skipped.append((run_dir.name, f"bad meta.json: {e}"))
            continue

        if since and meta.get("started_at", "") < since:
            continue
        if workload and meta.get("workload") != workload:
            continue
        if mode and meta.get("mode") != mode:
            continue

        if not events_path.exists() or events_path.stat().st_size == 0:
            # Empty run (no events). Still record one row so it's visible.
            df = pd.DataFrame([{}])
        else:
            df = pd.read_csv(events_path)

        df["run_name"] = run_dir.name
        df["workload"] = meta.get("workload")
        df["run_mode"] = meta.get("mode")     # 'run_mode' to avoid clash with event-level 'mode'
        df["seed"] = meta.get("seed")
        df["dataset_name"] = meta.get("dataset_name")
        df["git_sha"] = meta.get("git_sha")
        df["started_at"] = meta.get("started_at")
        df["hostname"] = meta.get("hostname")

        # Flatten meta.stats onto every event row as run_stat_<field>.
        # These are run-level totals, so they repeat across all events
        # within a run. Take .iloc[0] after groupby("run_name") to get
        # one row per run for per-run aggregates.
        stats = meta.get("stats") or {}
        for k, v in stats.items():
            if not isinstance(v, (int, float, str, bool)) and v is not None:
                continue
            df[f"run_stat_{k}"] = v

        # Convenience: wire bytes per fetched tile (constant within a run).
        # PIR  ~ slots × response_bytes per slot (≈100 KB per slot)
        # HTTP ~ slots × tile_size      per slot (≈ 20 KB per slot)
        fetches_in_run = stats.get("fetches") or 0
        if fetches_in_run:
            df["wire_bytes_down_per_fetch"] = (stats.get("bytesDown") or 0) / fetches_in_run
            df["wire_bytes_up_per_fetch"] = (stats.get("bytesUp") or 0) / fetches_in_run
        frames.append(df)

    if skipped:
        print(f"Skipped {len(skipped)} run dir(s):")
        for name, why in skipped[:5]:
            print(f"  {name}: {why}")
        if len(skipped) > 5:
            print(f"  ... and {len(skipped) - 5} more")

    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="Quick summary of all runs")
    p.add_argument("--runs-dir", default=str(DEFAULT_RUNS_DIR))
    p.add_argument("--since", default=None)
    args = p.parse_args()

    df = load_runs(args.runs_dir, since=args.since)
    if df.empty:
        print("No runs found.")
        raise SystemExit
    print(f"Loaded {len(df)} event row(s) across {df['run_name'].nunique()} run(s)")
    print()
    print("By (workload, run_mode):")
    summary = df.groupby(["workload", "run_mode"]).agg(
        runs=("run_name", "nunique"),
        events=("run_name", "size"),
        median_latency_ms=("latency_ms", "median"),
        p95_latency_ms=("latency_ms", lambda s: s.quantile(0.95)),
    )
    print(summary.to_string())
