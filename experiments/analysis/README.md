# Analysis

Notebooks and helpers that consume `experiments/runs/`. Output (figures)
gets copied into `paper/figures/` once finalized and uploaded to Overleaf.

## Quick summary from the CLI

```bash
python experiments/analysis/load_runs.py
python experiments/analysis/load_runs.py --since 20260520
```

Prints one row per `(workload, mode)` with run count, total events,
median latency, p95 latency.

## Canonical load + plot snippet

```python
import sys
sys.path.insert(0, "experiments/analysis")
from load_runs import load_runs

df = load_runs()                              # everything under experiments/runs/
fetches = df[df["kind"].isin(["pir", "http"])]

# Per-(workload, mode) latency summary
fetches.groupby(["workload", "run_mode"])["latency_ms"].describe()

# Latency CDFs per mode within one workload
import matplotlib.pyplot as plt
import numpy as np

w = fetches[fetches["workload"] == "pan-nyc-urban-z12-seed0"]   # or aggregate across seeds
for mode, sub in w.groupby("run_mode"):
    x = np.sort(sub["latency_ms"].dropna())
    y = np.linspace(0, 1, len(x), endpoint=False)
    plt.plot(x, y, label=mode)
plt.xlabel("latency (ms)"); plt.ylabel("CDF"); plt.legend()
plt.savefig("../paper/figures/latency-cdf-nyc.png", dpi=200, bbox_inches="tight")
```

## Columns

| Column | Source | Notes |
|---|---|---|
| `t` | events.csv | Wall-clock ms (frontend `Date.now()`) |
| `mode` | events.csv | Mode at recordQuery time (`pir`/`http`). Same as `run_mode` in practice. |
| `kind` | events.csv | `pir`, `http`, or `cache-hit` |
| `key` | events.csv | `z/x/y` tile id |
| `z` | events.csv | Zoom level |
| `slots` | events.csv | Number of PIR slots this tile spans |
| `latency_ms` | events.csv | End-to-end fetch time |
| `bytes_decoded` | events.csv | Decoded PBF size after decryption + decompression |
| `error` | events.csv | Error name if the fetch failed |
| `workload` | meta.json | E.g., `pan-nyc-urban-z12-seed7` |
| `run_mode` | meta.json | `pir` or `http` |
| `seed` | meta.json | RNG seed used to generate the trajectory |
| `git_sha` | meta.json | Repo SHA at run time (suffix `-dirty` if uncommitted changes) |
| `started_at` | meta.json | UTC `YYYYMMDDTHHMMSSZ` |
| `run_name` | dir name | The full `experiments/runs/` subdir |
