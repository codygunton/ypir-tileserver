# ypir-tileserver

A private map-tile server using **YPIR** (Menon & Wu, 2023) to serve
vector tiles without revealing which tiles the client requested. The
client fetches low-zoom "basemap" tiles in the clear (world coverage via
[OpenFreeMap](https://openfreemap.org/)) and homomorphically retrieves
high-zoom detail through YPIR.

Pipeline:

```
OSM PBF  →  MBTiles (Planetiler)  →  tiles.bin + basemap/   →  YPIR server
(400 MB     (~2 GB for a region)     (PIR DB + regional       + Flask proxy
 regional)                            basemap)                 + WASM client
```

## Quick start (Docker)

One toolchain-complete container — Rust nightly, wasm-pack, Python 3,
Java 21 for Planetiler. No host installs needed beyond Docker.

```bash
git clone https://github.com/codygunton/ypir-tileserver
cd ypir-tileserver

# Build the workbench image (~5 min, one time).
docker compose build

# Start the demo. First run builds wasm + server (~3 min) and starts
# with synthetic tiles so you see the UI. Subsequent runs are instant.
docker compose up
```

Open <http://localhost:8009>.

Your CPU is auto-detected: AVX-512 hosts get the fast path, everything
else gets a portable fallback (≈7× slower but correct). Override with
`FORCE_PORTABLE=1` or `FORCE_AVX512=1` in the environment.

## Build a real dataset

The synthetic demo is a smoke test. For a real map, use the `dataset`
CLI inside the workbench container:

```bash
# In a second terminal, with `docker compose up` running:
docker compose exec workbench ./scripts/dataset build ne-us-z9-13-tiered \
    --region us-northeast \
    --bbox -80.6,38.9,-66.9,47.5 \
    --zoom-range 9-13
```

This runs, end-to-end:

1. Download the `us-northeast` OSM extract from Geofabrik (~400 MB)
2. Build an OpenMapTiles-schema MBTiles via Planetiler (~2 GB, ~15 min)
3. Extract z9-z13 PIR tiles → `datasets/ne-us-z9-13-tiered/tiles.bin`
4. Extract z0-z8 basemap tiles → `datasets/ne-us-z9-13-tiered/basemap/`

Total: ~30 min, ~5 GB peak disk in `./data/`.

Then run with that dataset:

```bash
DATASET=ne-us-z9-13-tiered docker compose up
```

### Trying different regions

```bash
# List supported Geofabrik regions
docker compose exec workbench ./scripts/dataset regions

# Manhattan only, very high resolution
docker compose exec workbench ./scripts/dataset build nyc-z14 \
    --region us-new-york --bbox -74.05,40.68,-73.89,40.85 \
    --zoom-range 14-14 --tile-size 20480

# Germany, medium zoom
docker compose exec workbench ./scripts/dataset build germany-z8-12 \
    --region europe-germany --bbox 5.9,47.3,15.0,55.0 \
    --zoom-range 8-12

# List what's built
docker compose exec workbench ./scripts/dataset list
```

Beyond any region's own basemap coverage, the Flask proxy falls back to
[OpenFreeMap](https://openfreemap.org/)'s public OpenMapTiles server, so
zooming out shows the rest of the world.

## Rebuilding after code edits

The repo is bind-mounted into the container — edit on the host, rebuild
inside. Cargo and wasm build caches live in named Docker volumes, so
rebuilds are incremental:

```bash
# After editing server/src/main.rs (or anywhere in server/):
docker compose exec workbench sh -c 'cd server && cargo build --release'
docker compose restart workbench

# After editing wasm/src/:
docker compose exec workbench sh -c 'cd wasm && wasm-pack build --target web --release'
docker compose restart workbench

# After editing demo/frontend/ or shared/frontend/:
# Just refresh the browser — no build step.

# After editing demo/proxy/server.py:
docker compose restart workbench
```

## Repository layout

```
server/             Rust YPIR PIR server (actix-web)
wasm/               Rust → WASM client for in-browser query generation
spiral-rs/          Vendored Blyss spiral-rs (wasm client dep)
demo/
  proxy/            Flask proxy (API forwarding, basemap fallback, static)
  frontend/         MapLibre-based web UI
shared/             JS modules and Python helpers
scripts/
  dataset            Top-level dataset CLI (fetch-osm, build, list)
  dev-up.sh          Docker entrypoint
  prepare_tiles.py   MBTiles → tiles.bin + tile_mapping.json
  03-extract-basemap.py  MBTiles → basemap/{z}/{x}/{y}.pbf
data/               OSM PBFs, MBTiles, Planetiler cache (gitignored)
datasets/           Built PIR datasets (gitignored)
```

## Running without Docker

The host-side scripts still work if you prefer to install Rust + Python
+ Java locally:

```bash
# One-time
rustup toolchain install nightly-2024-02-07
rustup target add wasm32-unknown-unknown --toolchain nightly-2024-02-07
cargo install wasm-pack
pip install flask requests psutil
# Plus install JRE 21+ for Planetiler.

# Build dataset
scripts/dataset build ne-us-z9-13-tiered \
    --region us-northeast --bbox -80.6,38.9,-66.9,47.5 --zoom-range 9-13

# Run
./run_demo.sh --dataset ne-us-z9-13-tiered
```

## How it works

- **Server** memory-maps `tiles.bin` and precomputes SimplePIR offline
  values at startup.
- **Client** (WASM) generates a YPIR query locally. The server never
  sees which tile is being requested — only encrypted query bytes.
- **Server** homomorphically evaluates a packed dot product and returns
  an encrypted response. The client decrypts locally to recover the
  requested PBF tile bytes.
- **Basemap tiles** are served in the clear: low-zoom data isn't
  location-sensitive, and avoiding PIR there saves orders of magnitude
  of bandwidth and latency.

Protocol details in the YPIR paper: <https://eprint.iacr.org/2024/008>

## Performance

Measured on an AVX-512 desktop (synthetic demo params, 20 KB slot size):

| DB size | AVX-512 offline precompute | Portable offline precompute |
|---:|---:|---:|
|  4096 slots |  3.9 s | 26.6 s (6.9× slower) |
| 16384 slots |  5.4 s | 39.2 s (7.3× slower) |

Per-query latency is only ~1.3× slower on portable — the penalty
dominates during the one-time offline setup, not at query time.

## Credits

- YPIR scheme and Rust implementation: [Samir Menon](https://github.com/menonsamir)
  and collaborators. This repo pins a
  [fork](https://github.com/codygunton/ypir) carrying (a) a Rayon
  parallelization of the first-dimension multiply and (b) portable
  non-AVX-512 fallbacks for the hot kernels.
- Spiral-rs primitives: server uses
  [menonsamir/spiral-rs](https://github.com/menonsamir/spiral-rs); the
  WASM client vendors [Blyss](https://github.com/blyssprivacy/sdk)'s
  fork at `spiral-rs/` with a one-line visibility patch.
- Tile rendering: [MapLibre GL JS](https://maplibre.org/).
- Tile generation: [Planetiler](https://github.com/onthegomap/planetiler)
  against the [OpenMapTiles schema](https://openmaptiles.org/).
- World basemap fallback: [OpenFreeMap](https://openfreemap.org/) (CC0,
  free forever).
- OSM data: <https://www.openstreetmap.org/> (ODbL).

## License

MIT. See [LICENSE](LICENSE).
