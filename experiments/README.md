# Experiments

End-to-end measurement harness for the SIGSPATIAL applications submission.

## Layout

```
experiments/
  harness/        # Python scripts that drive a run (Playwright-driven browser + log capture)
  configs/        # named experiment configs (TOML/JSON) — one per cell of the experiment matrix
  workloads/      # JSON trajectory definitions (viewport + zoom over time)
  runs/           # gitignored: CSVs and per-run metadata land here
  analysis/       # pandas notebooks that consume runs/ and produce figures
```

## Experiment matrix

Three axes, kept small on purpose:

1. **Privacy mode**: `pir` (current YPIR stack) vs. `http` (direct serving of
   `tiles.bin` slots over plain HTTP — see `harness/baseline_server.py`).
2. **Packaging**: variants produced by `scripts/prepare_tiles.py` — e.g.
   `flat-20k`, `neighborhood-4-20k`, `zcurve-20k`, plus a tile-size sweep
   `{4k, 20k, 80k}` at fixed packaging.
3. **Workload**: named trajectories in `workloads/` — initially three:
   - `pan-nyc-z12.json`: 60 s panning across NYC at z=12.
   - `zoom-cascade-z8-to-z14.json`: zoom-in cascade at fixed coordinate.
   - `random-z9-13.json`: uniform random tile draws across the dataset.

Each cell = one row in `configs/`, run via the harness, produces one
directory under `runs/`.

## A run directory

```
runs/<config-name>-<git-sha>-<timestamp>/
  config.toml                # frozen copy of the input config
  meta.json                  # git SHA, hostname, machine info, wall times
  server.log                 # captured Rust server stderr
  proxy.log                  # captured Flask proxy stdout/stderr
  frontend.csv               # client-side measurement CSV (per-tile)
  trajectory.json            # the exact workload that was replayed
```

## Running a single cell

```bash
cd experiments
python harness/run.py --config configs/<name>.toml
```

## Sweeping all cells

```bash
python harness/sweep.py --matrix configs/matrix.toml
```

## Notes

- The hint cache (per CLAUDE.md §6) is the single biggest perf win for the
  experiment loop. Without it, each new packaging variant pays 20-140 s of
  offline precompute on server start. Coordinate with Cody on this.
- Every run is keyed on `git rev-parse HEAD` for traceability. Don't run
  experiments from a dirty working tree if you care about reproducibility.
