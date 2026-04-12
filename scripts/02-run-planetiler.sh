#!/usr/bin/env bash
#
# Build an OpenMapTiles-schema MBTiles from a Geofabrik OSM PBF, using Planetiler.
#
# Input:  data/north-america-latest.osm.pbf  (from scripts/01-download-osm.sh)
# Output: data/north-america.mbtiles
#
# Downloads planetiler.jar into data/ on first run. Requires Java 21+.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/data"

INPUT="${1:-$DATA/north-america-latest.osm.pbf}"
OUTPUT="${2:-$DATA/north-america.mbtiles}"

if [[ ! -f "$INPUT" ]]; then
    echo "ERROR: OSM input not found: $INPUT" >&2
    echo "  Run scripts/01-download-osm.sh first (produces ~17 GB file)." >&2
    exit 1
fi

mkdir -p "$DATA"
JAR="$DATA/planetiler.jar"
if [[ ! -f "$JAR" ]]; then
    echo "==> Downloading planetiler.jar..."
    curl -L --progress-bar -o "$JAR" \
        https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar
fi

if ! command -v java >/dev/null 2>&1; then
    echo "ERROR: java not found (Planetiler requires Java 21+)." >&2
    exit 1
fi

# Planetiler's planet profile produces an OpenMapTiles-schema MBTiles.
# --force overwrites any existing output.
echo "==> Running Planetiler (this takes 10-30 min on a reasonable machine)..."
cd "$DATA"
java -Xmx16g -jar "$JAR" \
    --osm-path="$INPUT" \
    --output="$OUTPUT" \
    --download \
    --force

echo "==> Wrote: $OUTPUT"
du -h "$OUTPUT" | cut -f1 | xargs -I{} echo "==> Size: {}"
