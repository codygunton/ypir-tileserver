# Workload templates

Five terrain types for comparing PIR vs HTTP across geographies with
different vector-tile density. All at z=12 with identical pan params +
seed=42; the only varying axis is terrain (and the bounded random walk
that terrain admits).

Schema: see [SCHEMA.md](SCHEMA.md). Regenerate after editing:
`python generate_markov.py <file>.json`.

## Start points

| File | Terrain | Start (lng, lat, z) | Hash for sanity check | Bounds (w, s, e, n) |
|---|---|---|---|---|
| [nyc.json](nyc.json) | Urban (Manhattan) | -73.97, 40.78, 12 | `#12/40.78/-73.97` | -74.05, 40.68 → -73.89, 40.85 |
| [murray-hill.json](murray-hill.json) | Suburban (Queens) | -73.81, 40.76, 12 | `#12/40.76/-73.81` | -73.88, 40.70 → -73.72, 40.83 |
| [finger-lakes.json](finger-lakes.json) | Mixed (East Ithaca + Cayuga Lake) | -76.48, 42.45, 12 | `#12/42.45/-76.48` | -76.65, 42.40 → -76.30, 42.75 |
| [five-ponds.json](five-ponds.json) | Wilderness (W. Adirondacks) | -74.70, 44.00, 12 | `#12/44.00/-74.70` | -74.90, 43.85 → -74.50, 44.20 |
| [atlantic.json](atlantic.json) | Ocean (S of Long Island) | -73.15, 40.33, 12 | `#12/40.33/-73.15` | -73.30, 40.20 → -73.00, 40.45 |

Paste the hash onto `http://localhost:5173/` (or `?mode=http`) to drop the
map at that start point. MapLibre's hash format is `#zoom/lat/lng` — note
the lat/lng order is flipped vs the JSON.

## Authoring a new one

```bash
cp template-markov.json my-workload.json
# edit name, description, bounds, start, params
python generate_markov.py my-workload.json
```
