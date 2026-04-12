#!/usr/bin/env bash
#
# ypir-tileserver — YPIR CPU private map-tile demo
#
# Usage:
#   ./run_demo.sh --dataset <name>    # Use a dataset from datasets/<name>/
#   ./run_demo.sh --tiles-dir PATH    # Point at any tiles directory
#   ./run_demo.sh --synthetic         # Generate synthetic tiles first
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

YPIR_PORT=8084
PROXY_PORT=8009
USE_SYNTHETIC=false
DATASET=""
TILES_DIR=""
DATASETS_DIR="$ROOT/datasets"

usage() {
    cat <<EOF
Usage: $0 [options]

  --dataset NAME        Use datasets/NAME/ (contains tiles.bin, tile_mapping.json, basemap/)
  --tiles-dir PATH      Point at an arbitrary tiles directory
  --synthetic           Generate 1000 synthetic tiles (for smoke-testing)
  --ypir-port N         YPIR server port (default 8084)
  --proxy-port N        HTTP proxy port (default 8009)

Available datasets:
EOF
    ls -1 "$DATASETS_DIR" 2>/dev/null || echo "  (none — run scripts/build-dataset.sh to generate one)"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --synthetic)   USE_SYNTHETIC=true; shift ;;
        --dataset)     DATASET="$2"; shift 2 ;;
        --tiles-dir)   TILES_DIR="$2"; shift 2 ;;
        --ypir-port)   YPIR_PORT="$2"; shift 2 ;;
        --proxy-port)  PROXY_PORT="$2"; shift 2 ;;
        -h|--help)     usage; exit 0 ;;
        *)             echo "Unknown option: $1" >&2; usage; exit 1 ;;
    esac
done

# ─── Kill stale processes on OUR ports ONLY ─────────────────────────
kill_port() {
    local port=$1
    local pids
    pids=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' || true)
    if [[ -n "$pids" ]]; then
        echo "==> Killing stale process(es) on port $port (PIDs: $pids)"
        for pid in $pids; do kill "$pid" 2>/dev/null || true; done
        sleep 1
    fi
}
kill_port "$YPIR_PORT"
kill_port "$PROXY_PORT"

# ─── Cleanup on exit ────────────────────────────────────────────────
PIDS=()
CLEANED_UP=false
cleanup() {
    if $CLEANED_UP; then return; fi
    CLEANED_UP=true
    echo ""; echo "Shutting down..."
    for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
    for i in $(seq 1 6); do
        alive=false
        for pid in "${PIDS[@]}"; do kill -0 "$pid" 2>/dev/null && alive=true && break; done
        $alive || break
        sleep 0.5
    done
    for pid in "${PIDS[@]}"; do kill -9 "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
    echo "Done."
}
trap cleanup EXIT INT TERM

# ─── Build ypir-wasm if needed ──────────────────────────────────────
WASM_PKG="$ROOT/wasm/pkg"
if [[ ! -f "$WASM_PKG/ypir_wasm_bg.wasm" ]]; then
    echo "==> Building ypir-wasm (~30s)..."
    (cd "$ROOT/wasm" && wasm-pack build --target web --release)
fi

# ─── Symlink WASM pkg into frontend ─────────────────────────────────
FRONTEND_PKG="$ROOT/demo/frontend/pkg"
[[ -e "$FRONTEND_PKG" ]] || ln -sf "$WASM_PKG" "$FRONTEND_PKG"

# ─── Build YPIR server if needed ────────────────────────────────────
YPIR_SERVER="$ROOT/server/target/release/ypir-cpu-server"
if [[ ! -x "$YPIR_SERVER" ]]; then
    echo "==> Building YPIR CPU server (this may take a few minutes; nightly Rust required)..."
    (cd "$ROOT/server" && cargo build --release)
fi

# ─── Resolve tiles directory ────────────────────────────────────────
if $USE_SYNTHETIC; then
    TILES_DIR="$ROOT/datasets/synthetic"
    mkdir -p "$TILES_DIR"
    echo "==> Generating 1000 synthetic tiles at $TILES_DIR"
    python3 "$ROOT/scripts/prepare_tiles.py" \
        --synthetic --synthetic-count 1000 --output "$TILES_DIR"
elif [[ -n "$DATASET" ]]; then
    TILES_DIR="$DATASETS_DIR/$DATASET"
elif [[ -z "$TILES_DIR" ]]; then
    # Pick first available dataset if nothing specified
    for d in "$DATASETS_DIR"/*/; do
        if [[ -f "$d/tiles.bin" ]]; then TILES_DIR="${d%/}"; break; fi
    done
fi

if [[ -z "$TILES_DIR" || ! -f "$TILES_DIR/tiles.bin" ]]; then
    echo "ERROR: no tiles.bin found." >&2
    usage
    exit 1
fi

NUM_TILES=$(python3 -c "import json; m=json.load(open('$TILES_DIR/tile_mapping.json')); print(m.get('num_pir_slots', m['num_tiles']))")
TILE_SIZE=$(python3 -c "import json; print(json.load(open('$TILES_DIR/tile_mapping.json'))['tile_size'])")
DATASET_NAME=$(python3 -c "
import json, os
p = '$TILES_DIR/dataset.json'
print(json.load(open(p))['name'] if os.path.isfile(p) else os.path.basename('$TILES_DIR'))
")

echo "==> Dataset: $DATASET_NAME ($NUM_TILES PIR slots, ${TILE_SIZE}B each)"

# ─── Start YPIR server ──────────────────────────────────────────────
echo "==> Starting YPIR CPU server on port $YPIR_PORT..."
"$YPIR_SERVER" \
    --database "$TILES_DIR/tiles.bin" \
    --tile-mapping "$TILES_DIR/tile_mapping.json" \
    --num-tiles "$NUM_TILES" \
    --tile-size "$TILE_SIZE" \
    --port "$YPIR_PORT" &
YPIR_PID=$!
PIDS+=($YPIR_PID)

echo -n "==> Waiting for YPIR server..."
for i in $(seq 1 120); do
    if ! kill -0 "$YPIR_PID" 2>/dev/null; then
        echo " FAILED (process exited)"; exit 1
    fi
    if (echo > /dev/tcp/localhost/$YPIR_PORT) 2>/dev/null; then echo " ready!"; break; fi
    if [[ $i -eq 120 ]]; then echo " TIMEOUT"; exit 1; fi
    echo -n "."; sleep 1
done

# ─── Start Flask proxy ──────────────────────────────────────────────
echo "==> Starting Flask proxy on port $PROXY_PORT..."
python3 "$ROOT/demo/proxy/server.py" \
    --ypir-port "$YPIR_PORT" \
    --port "$PROXY_PORT" \
    --tiles-dir "$TILES_DIR" &
PROXY_PID=$!
PIDS+=($PROXY_PID)

sleep 2
if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "ERROR: Flask proxy failed to start" >&2
    exit 1
fi

cat <<EOF

========================================
  YPIR tile-server demo ready!

  Open:  http://localhost:$PROXY_PORT

  YPIR server:  localhost:$YPIR_PORT
  Flask proxy:  localhost:$PROXY_PORT
  Tiles:        $NUM_TILES

  Press Ctrl+C to stop
========================================

EOF

wait
