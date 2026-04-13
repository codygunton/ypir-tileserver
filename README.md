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

# Build the default NE-US dataset (~30 min; uses Geofabrik OSM + Planetiler).
# Produces datasets/ne-us-z9-13-tiered/{tiles.bin, basemap/, ...}.
docker compose run --rm workbench ./scripts/dataset quickstart

# Start the demo. First run builds wasm + server (~3 min); subsequent
# runs are instant.
docker compose up
```

Open <http://localhost:8009>.

The `dataset build` step, end-to-end:

1. Download the `us-northeast` OSM extract from Geofabrik (~400 MB)
2. Build an OpenMapTiles-schema MBTiles via Planetiler (~2 GB, ~15 min)
3. Extract z9-z13 PIR tiles → `datasets/ne-us-z9-13-tiered/tiles.bin`
4. Extract z0-z8 basemap tiles → `datasets/ne-us-z9-13-tiered/basemap/`

Total: ~30 min, ~5 GB peak disk in `./data/`.

The default build is portable: scalar Rust that the compiler
auto-vectorizes to AVX-2 on x86_64 and NEON on aarch64. Works on
any supported host, including native Apple Silicon (no Rosetta
needed). ≈7× slower at one-time offline precompute, ≈1.3× slower
per query than the AVX-512 path — the slowdown is almost entirely
at startup; once the server is serving queries, the difference is
below human perception.

To opt into the fast path on an AVX-512 host (Intel Xeon
Skylake-SP+, AMD EPYC Genoa+):

    AVX512=1 docker compose up

### Picking a specific dataset

With only one built dataset, `docker compose up` uses it automatically.
With more than one, set `DATASET`:

```bash
DATASET=ne-us-z9-13-tiered docker compose up
```

### Trying different regions

Use `docker compose run --rm` for one-shot dataset commands — no running
service needed:

```bash
# List supported Geofabrik regions
docker compose run --rm workbench ./scripts/dataset regions

# Manhattan only, very high resolution
docker compose run --rm workbench ./scripts/dataset build nyc-z14 \
    --region us-new-york --bbox -74.05,40.68,-73.89,40.85 \
    --zoom-range 14-14 --tile-size 20480

# Germany, medium zoom
docker compose run --rm workbench ./scripts/dataset build germany-z8-12 \
    --region europe-germany --bbox 5.9,47.3,15.0,55.0 \
    --zoom-range 8-12

# List what's built
docker compose run --rm workbench ./scripts/dataset list
```

Beyond any region's own basemap coverage, the Flask proxy falls back to
[OpenFreeMap](https://openfreemap.org/)'s public OpenMapTiles server, so
zooming out shows the rest of the world.

## Rebuilding after code edits

The repo is bind-mounted into the container — edit on the host, rebuild
inside. Cargo and wasm build caches live in named Docker volumes, so
rebuilds are incremental.

For any change to `server/`, `wasm/`, `demo/proxy/`, or `shared/proxy/`:

```bash
docker compose restart workbench
```

That re-runs the entrypoint, which invokes `cargo build --release` and
`wasm-pack build` (both are cheap no-ops when nothing changed, ~5–10s)
before starting the server and proxy again.

For any change to `demo/frontend/` or `shared/frontend/` — just refresh
the browser. No build step, no restart.

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
  dataset            Top-level dataset CLI (quickstart, fetch-osm, build, list, ...)
  dev-up.sh          Docker entrypoint — build tools + start server+proxy
  prepare_tiles.py   MBTiles → tiles.bin + tile_mapping.json
  03-extract-basemap.py  MBTiles → basemap/{z}/{x}/{y}.pbf
data/               OSM PBFs, MBTiles, Planetiler cache (gitignored)
datasets/           Built PIR datasets (gitignored)
```

## Running without Docker

If you'd rather install the toolchain on your host:

```bash
# One-time setup
rustup toolchain install nightly
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
pip install flask requests psutil
# Plus install JRE 21+ for Planetiler (e.g. apt install temurin-21-jre).

# Build the default NE-US dataset
./scripts/dataset quickstart

# Run (auto-detects AVX-512 from the host, unlike the Docker path
# which defaults to portable; set RUSTFLAGS to override).
./run_demo.sh --dataset ne-us-z9-13-tiered
```

## How it works

- **Server** reads `tiles.bin` into memory at startup and precomputes
  SimplePIR offline values from it. Memory resident, ready to serve.
- **Client** (WASM) generates a YPIR query locally. The server never
  sees which tile is being requested — only encrypted query bytes.
- **Server** homomorphically evaluates a packed dot product and returns
  an encrypted response. The client decrypts locally to recover the
  requested PBF tile bytes.
- **Basemap tiles** (low zoom) are served in the clear: that data isn't
  location-sensitive, and avoiding PIR there saves orders of magnitude
  of bandwidth and latency.

Protocol details in the YPIR paper: <https://eprint.iacr.org/2024/008>

## Performance

Measured on an AVX-512 Intel desktop, 20 KB PIR slot size:

| DB size | AVX-512 offline precompute | Portable offline precompute |
|---:|---:|---:|
|  4,096 slots |  3.9 s | 26.6 s (6.9× slower) |
| 16,384 slots |  5.4 s | 39.2 s (7.3× slower) |
|100,000 slots (NE-US) | ≈20 s | ≈140 s |

Offline precompute runs once at server startup. Per-query latency is
only ~1.3× slower on portable (≈8 ms overhead on a packed response).

The "portable" path is scalar Rust that the compiler auto-vectorizes:
AVX-2 on x86_64, NEON on aarch64. Binaries don't share instruction
sets across architectures — building on Apple Silicon produces NEON
code automatically; building on x86 produces AVX-2 (or AVX-512 if you
set `AVX512=1`).

## Credits

- YPIR scheme and Rust implementation: [Samir Menon](https://github.com/menonsamir)
  and collaborators. This repo pins a
  [fork](https://github.com/codygunton/ypir) carrying (a) a Rayon
  parallelization of the first-dimension multiply and (b) portable
  non-AVX-512 fallbacks for the hot kernels.
- Spiral-rs primitives (the underlying LWE/NTT library):
  - Server pins a [fork](https://github.com/codygunton/spiral-rs) of
    [menonsamir/spiral-rs](https://github.com/menonsamir/spiral-rs)
    with cfg-gated x86 imports and scalar fallbacks for the `avx2`-only
    routines so aarch64 builds work.
  - WASM client vendors [Blyss](https://github.com/blyssprivacy/sdk)'s
    separate fork at `spiral-rs/` with a one-line visibility patch
    (needed to assemble YPIR expansion public keys).
- Tile rendering: [MapLibre GL JS](https://maplibre.org/).
- Tile generation: [Planetiler](https://github.com/onthegomap/planetiler)
  against the [OpenMapTiles schema](https://openmaptiles.org/).
- World basemap fallback: [OpenFreeMap](https://openfreemap.org/) (CC0,
  free forever).
- OSM data: <https://www.openstreetmap.org/> (ODbL).

## License

MIT. See [LICENSE](LICENSE).
