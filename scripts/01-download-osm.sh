#!/usr/bin/env bash
set -euo pipefail

URL="https://download.geofabrik.de/north-america-latest.osm.pbf"
OUTPUT="north-america-latest.osm.pbf"

echo "Downloading North America OSM extract (~17 GB)"
echo "URL: $URL"
echo "Output: $OUTPUT"
echo ""

# Use curl with progress bar; resume partial downloads with -C -
curl -L -C - --progress-bar -o "$OUTPUT" "$URL"

echo ""
echo "Download complete: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
