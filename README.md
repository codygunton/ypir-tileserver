# ypir-tileserver

A private map-tile server using **YPIR** (Menon & Wu, 2023) to serve
vector tiles without revealing which tiles the client requested. The
client downloads low-zoom "basemap" tiles in the clear and fetches
high-zoom detail through homomorphic-encryption-based PIR.

Pipeline:

```
OSM PBF  →  MBTiles (Planetiler)  →  tiles.bin + basemap/   →  YPIR server
(17 GB)      (~30 GB)                (PIR DB + free basemap)    + Flask proxy + WASM client
```

## Repository layout

```
server/       Rust YPIR PIR server (actix-web)
wasm/         Rust → WASM client for in-browser query generation
spiral-rs/    Vendored Blyss spiral-rs with one patch (get_sk_reg made pub)
demo/
  proxy/      Flask proxy (serves frontend + forwards PIR API)
  frontend/   MapLibre-based web UI
shared/       JS modules and Python helpers reusable across PIR schemes
scripts/      Dataset-build pipeline
datasets/     Generated PIR datasets (gitignored — rebuild with scripts/)
```

## Quick start (synthetic demo)

Smoke-tests end-to-end without requiring any OSM data:

    ./run_demo.sh --synthetic

Then open <http://localhost:8009>.

## Real-data quick start

1. **Download OSM** (~17 GB):

        scripts/01-download-osm.sh

2. **Build MBTiles** with Planetiler (~30 GB, 10-30 min, Java 21+):

        scripts/02-run-planetiler.sh

3. **Build a dataset** for a bounding box and zoom range:

        scripts/build-dataset.sh ne-us-z9-13-tiered \
          -80.6,38.9,-66.9,47.5 9-13 20480

4. **Run the demo**:

        ./run_demo.sh --dataset ne-us-z9-13-tiered

## Build requirements

- **Nightly Rust** (for AVX-512 intrinsics used by the YPIR server)
- **wasm-pack** (for the browser client)
- **Python 3** with `flask`, `requests`, `psutil`
- **Java 21+** (for Planetiler, only if regenerating MBTiles)
- An **AVX-512 capable CPU** (Intel: Ice Lake+, AMD: Zen 4+)

## How it works

- **Server** loads `tiles.bin` into memory and precomputes offline values
  per YPIR's SimplePIR variant.
- **Client** (WASM) generates a YPIR query, batch-sent through the Flask
  proxy to the server's `/api/query-batch`.
- **Server** homomorphically evaluates the dot-product-and-packing and
  returns encrypted responses; the client decrypts locally to recover
  the requested PBF tile bytes.
- **Basemap** (z0-z8) is served in the clear — the protected zoom range
  is where location privacy matters.

See the YPIR paper for protocol details: <https://eprint.iacr.org/2024/008>

## Credits

- YPIR scheme + Rust implementation: [Samir Menon](https://github.com/menonsamir) and collaborators.
  This repo depends on a [fork](https://github.com/codygunton/ypir) carrying a
  small Rayon-based parallelization of the first-dimension matrix
  multiply.
- Spiral-rs (underlying RLWE primitives): the server depends on
  [menonsamir/spiral-rs](https://github.com/menonsamir/spiral-rs); the
  WASM client vendors [blyssprivacy/sdk](https://github.com/blyssprivacy/sdk)'s
  spiral-rs fork at `spiral-rs/` with a one-line visibility change
  (`get_sk_reg` made `pub`).
- Tile rendering: [MapLibre GL JS](https://maplibre.org/)
- Tile generation: [Planetiler](https://github.com/onthegomap/planetiler)
  against [OpenMapTiles schema](https://openmaptiles.org/).
- OSM data: <https://www.openstreetmap.org/> (ODbL).

## License

MIT. See [LICENSE](LICENSE).
