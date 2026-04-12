#!/usr/bin/env bash
#
# End-to-end dataset build: OSM PBF → MBTiles → PIR tiles.bin + basemap/.
#
# Usage:
#   scripts/build-dataset.sh <name> <bbox> [zoom-range] [tile-size]
#
# Example (Northeast US, z9-z13, 20 KB slots):
#   scripts/build-dataset.sh ne-us-z9-13-tiered \
#     -80.6,38.9,-66.9,47.5 9-13 20480
#
# Writes to datasets/<name>/ :
#   tiles.bin, tile_mapping.json, dataset.json, basemap/{z}/{x}/{y}.pbf
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NAME="${1:?dataset name required (e.g. ne-us-z9-13-tiered)}"
BBOX="${2:?bbox required (west,south,east,north)}"
ZOOM_RANGE="${3:-9-13}"
TILE_SIZE="${4:-20480}"
BASEMAP_MAX_ZOOM="${5:-8}"

MIN_ZOOM="${ZOOM_RANGE%%-*}"
MAX_ZOOM="${ZOOM_RANGE##*-}"

DATA="$ROOT/data"
MBTILES="$DATA/north-america.mbtiles"
OUT="$ROOT/datasets/$NAME"

if [[ ! -f "$MBTILES" ]]; then
    echo "ERROR: $MBTILES not found. Run:" >&2
    echo "  scripts/01-download-osm.sh && scripts/02-run-planetiler.sh" >&2
    exit 1
fi

mkdir -p "$OUT"

# Convert bbox "w,s,e,n" → west,east,north,south for prepare_tiles.py
IFS=',' read -r W S E N <<< "$BBOX"

echo "==> Extracting PIR tiles (z${MIN_ZOOM}-z${MAX_ZOOM}, ${TILE_SIZE}B slots)..."
python3 "$ROOT/scripts/prepare_tiles.py" \
    --input "$MBTILES" \
    --output "$OUT" \
    --min-zoom "$MIN_ZOOM" \
    --max-zoom "$MAX_ZOOM" \
    --tile-size "$TILE_SIZE" \
    --bbox "$W,$S,$E,$N"

echo "==> Extracting basemap (z0-z${BASEMAP_MAX_ZOOM})..."
python3 "$ROOT/scripts/03-extract-basemap.py" \
    --input "$MBTILES" \
    --output "$OUT/basemap" \
    --min-zoom 0 \
    --max-zoom "$BASEMAP_MAX_ZOOM"

cat > "$OUT/dataset.json" <<EOF
{
  "name": "$NAME",
  "bbox": [$W, $S, $E, $N],
  "pir_zoom_range": [$MIN_ZOOM, $MAX_ZOOM],
  "basemap_zoom_range": [0, $BASEMAP_MAX_ZOOM],
  "tile_size_bytes": $TILE_SIZE
}
EOF

echo ""
echo "==> Dataset ready at: $OUT"
du -sh "$OUT"/* 2>/dev/null | sed 's/^/    /'
