#!/usr/bin/env bash
#
# Entrypoint for the docker-compose workbench service.
#
# 1. Detect AVX-512 availability on the host and pick RUSTFLAGS.
# 2. Build the WASM client, then the Rust server. (WASM first, with an
#    unset RUSTFLAGS, because the x86-native flags we need for the
#    server are nonsense for wasm32 and would emit hundreds of
#    feature-not-recognized warnings.)
# 3. Require a built dataset. Refuse to start otherwise — serving
#    random-byte synthetic tiles produces a blank map, which has been
#    confusing enough times to warrant a hard stop.
# 4. Start the YPIR server + Flask proxy in the foreground.
#
set -euo pipefail

ROOT="/workspace"
cd "$ROOT"

# ────────────────────────────────────────────────────────────────────
# 1. Pick RUSTFLAGS for the server build.
#
# Default is the portable path — works on any x86_64 or ARM host,
# including Apple Silicon under Rosetta 2. ~7× slower at offline
# precompute, ~1.3× slower per query; fine for demo use.
#
# Set AVX512=1 to build the fast path. Refuses if the host doesn't
# expose AVX-512 (would SIGILL at runtime).
# ────────────────────────────────────────────────────────────────────
if [[ "${AVX512:-0}" == "1" ]]; then
    if ! grep -q avx512f /proc/cpuinfo 2>/dev/null; then
        echo "==> AVX512=1 set but host CPU has no AVX-512." >&2
        echo "    Binary would SIGILL; refusing to build." >&2
        exit 1
    fi
    SERVER_RUSTFLAGS="-C target-cpu=native"
    BUILD_MODE="avx512 (opted in)"
else
    SERVER_RUSTFLAGS="-C target-cpu=native -C target-feature=-avx512f"
    BUILD_MODE="portable (default — set AVX512=1 for the fast path)"
fi
echo "==> Build mode: $BUILD_MODE"

# ────────────────────────────────────────────────────────────────────
# 2. Build WASM + server if missing. WASM gets a clean env (no
#    x86-native RUSTFLAGS); the server gets SERVER_RUSTFLAGS.
# ────────────────────────────────────────────────────────────────────
# Always invoke the build tools; they detect RUSTFLAGS / source changes
# and no-op in ~a second when there's nothing to do. Short-circuiting
# on "binary already exists" previously left stale AVX-512 binaries in
# place after switching to the portable build and vice versa.
echo "==> Building ypir-wasm..."
(cd "$ROOT/wasm" && env -u RUSTFLAGS wasm-pack build --target web --release)

FRONTEND_PKG="$ROOT/demo/frontend/pkg"
[[ -e "$FRONTEND_PKG" ]] || ln -sfn "$ROOT/wasm/pkg" "$FRONTEND_PKG"

echo "==> Building ypir-cpu-server..."
(cd "$ROOT/server" && RUSTFLAGS="$SERVER_RUSTFLAGS" cargo build --release)
SERVER_BIN="$ROOT/server/target/release/ypir-cpu-server"

# ────────────────────────────────────────────────────────────────────
# 3. Pick a dataset. Require one to exist.
# ────────────────────────────────────────────────────────────────────
DATASETS_DIR="$ROOT/datasets"
TILES_DIR=""

if [[ -n "${DATASET:-}" ]]; then
    TILES_DIR="$DATASETS_DIR/$DATASET"
    if [[ ! -f "$TILES_DIR/tiles.bin" ]]; then
        echo "==> Requested DATASET=$DATASET but $TILES_DIR/tiles.bin does not exist." >&2
        echo "    Built datasets:" >&2
        ls -1 "$DATASETS_DIR" 2>/dev/null | sed 's/^/      /' >&2 || echo "      (none)" >&2
        exit 1
    fi
else
    # First available built dataset wins.
    for d in "$DATASETS_DIR"/*/; do
        if [[ -f "$d/tiles.bin" ]]; then
            TILES_DIR="${d%/}"
            break
        fi
    done
fi

if [[ -z "$TILES_DIR" ]]; then
    cat >&2 <<'EOF'

==> No dataset found in ./datasets/. Nothing to serve.

Build the default NE-US demo dataset (~30 min, one command):

    docker compose run --rm workbench ./scripts/dataset quickstart

Then start the demo:

    docker compose up

Other commands:

    docker compose run --rm workbench ./scripts/dataset regions   # list Geofabrik regions
    docker compose run --rm workbench ./scripts/dataset build --help   # custom dataset

EOF
    exit 1
fi

NUM_TILES=$(python3 -c "import json; m=json.load(open('$TILES_DIR/tile_mapping.json')); print(m.get('num_pir_slots', m['num_tiles']))")
TILE_SIZE=$(python3 -c "import json; print(json.load(open('$TILES_DIR/tile_mapping.json'))['tile_size'])")
DATASET_NAME=$(basename "$TILES_DIR")

echo "==> Dataset: $DATASET_NAME ($NUM_TILES PIR slots, ${TILE_SIZE}B each)"

# ────────────────────────────────────────────────────────────────────
# 4. Run server + proxy in foreground.
# ────────────────────────────────────────────────────────────────────
YPIR_PORT=8084
PROXY_PORT=8009
PIDS=()
cleanup() {
    echo ""
    echo "==> Shutting down..."
    for pid in "${PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Starting YPIR server on :$YPIR_PORT..."
"$SERVER_BIN" \
    --database "$TILES_DIR/tiles.bin" \
    --tile-mapping "$TILES_DIR/tile_mapping.json" \
    --num-tiles "$NUM_TILES" \
    --tile-size "$TILE_SIZE" \
    --port "$YPIR_PORT" &
PIDS+=($!)

echo -n "==> Waiting for YPIR server (may take a minute on portable builds)..."
for _ in $(seq 1 600); do
    if (echo > /dev/tcp/localhost/$YPIR_PORT) 2>/dev/null; then
        echo " ready."
        break
    fi
    echo -n "."
    sleep 1
done

echo "==> Starting Flask proxy on :$PROXY_PORT..."
python3 "$ROOT/demo/proxy/server.py" \
    --ypir-port "$YPIR_PORT" \
    --port "$PROXY_PORT" \
    --tiles-dir "$TILES_DIR" &
PIDS+=($!)

cat <<EOF

========================================
  ypir-tileserver is ready.

  Open:  http://localhost:$PROXY_PORT
  Dataset: $DATASET_NAME  ($NUM_TILES slots)
  Build:  $BUILD_MODE

  Rebuild after editing server/src:
    docker compose exec workbench sh -c \\
      'cd server && cargo build --release'
  then restart the compose service.

  Build more datasets:
    docker compose run --rm workbench ./scripts/dataset build --help

  Ctrl-C to stop.
========================================

EOF

wait
