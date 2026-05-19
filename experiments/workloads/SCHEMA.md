# Workload JSON schema

A workload is a deterministic, replayable sequence of viewport states.
The harness replays it against the frontend (via Playwright) and the
frontend's measurement module records per-tile events to CSV.

**Config = trajectory minus `frames`.** Edit the JSON, run
`generate_markov.py path.json`, frames are filled in deterministically.
Same params + same seed = same `frames`. Idempotent.

Start from `template-markov.json` for new workloads.

## Schema

```json
{
  "name": "pan-nyc-z12-60s",
  "kind": "markov-pan",
  "seed": 42,
  "duration_ms": 60000,
  "tick_ms": 250,
  "bounds": [-74.05, 40.68, -73.89, 40.85],
  "start": { "lng": -73.97, "lat": 40.78, "zoom": 12.0 },
  "params": { ... generator-specific ... },
  "frames": [
    { "t": 0,    "lng": -73.97,  "lat": 40.78,  "zoom": 12.0 },
    { "t": 250,  "lng": -73.969, "lat": 40.781, "zoom": 12.0 },
    ...
  ]
}
```

### Required fields

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Used as the run identifier in `experiments/runs/`. |
| `kind` | string | Workload family. `markov-pan` for now; `zoom-cascade` and `uniform-random` reserved. |
| `seed` | int | RNG seed. Same seed + same params = same trajectory. |
| `duration_ms` | int | Wall-clock duration of the workload. |
| `tick_ms` | int | Time between viewport updates. Number of frames = `duration_ms / tick_ms`. |
| `bounds` | `[w, s, e, n]` | Lng/lat clamp box. Trajectory never escapes. |
| `start` | `{lng, lat, zoom}` | Initial viewport state. |
| `params` | object | Generator-specific; see below. |
| `frames` | array of `{t, lng, lat, zoom}` | The replay sequence. |

### `markov-pan` params

| Field | Type | Meaning |
|---|---|---|
| `pan_speed_deg_per_s_at_z12` | float | Sustained pan velocity (degrees per second) at zoom 12. Scaled by `2^(z-12)` at other zooms so the *screen-space* pan rate stays constant. |
| `pan_turn_std` | float | Per-tick heading change, in radians. Larger = more wandering. |
| `pan_speed_jitter` | float | Per-tick multiplicative jitter on speed. 0.0 = constant speed; 0.3 = ±30%. |
| `zoom_change_prob_per_s` | float | Per-second probability of a discrete zoom change event. |
| `zoom_range` | `[zmin, zmax]` | Inclusive integer zoom range. Discrete steps of ±1. |
| `zoom_momentum` | float, optional | P(same direction as last change \| a change fires). 0.0 = independent coin flips (default, current behavior). 0.8 = realistic clusters of 2-4 consecutive zoom-ins/zoom-outs. Bounded behavior: at `zmax` direction is forced down, at `zmin` forced up. |
| `pan_pause_prob_per_s` | float, optional | Per-second probability of entering a pause from the moving state. 0.0 = never pause (default). ~0.15 ≈ a pause every ~6s of motion. |
| `pan_pause_duration_s` | float, optional | Mean pause length in seconds, exponentially distributed. Default 1.5. While paused, position stays fixed; zoom can still change. |

### Replay semantics

- Frames are deterministic in seed + params.
- The harness pushes each frame at its `t` offset (real-time replay) so the measurement module sees realistic inter-frame timing.
- Bounds are *clamped*, not reflected — if the trajectory hits the edge, it slides along it.

### Naming convention

`<kind>-<region>-<zoom-or-range>-<duration>.json` — e.g.,
`pan-nyc-z12-60s.json`, `zoom-cascade-z8-to-z14.json`.
