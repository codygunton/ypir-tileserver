#!/usr/bin/env python3
"""Extract low-zoom (z0-z8 by default) tiles from an MBTiles file into a
directory tree of gzip-compressed PBF files: basemap/{z}/{x}/{y}.pbf.

The Flask proxy serves these directly (Content-Encoding: gzip) as a "free"
basemap beneath the PIR-protected high-zoom layer.

MBTiles stores tiles in TMS y convention; we flip to XYZ to match slippy
map / MapLibre expectations.
"""

import argparse
import os
import sqlite3
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="Path to MBTiles file")
    ap.add_argument("--output", required=True, help="Output basemap/ directory")
    ap.add_argument("--min-zoom", type=int, default=0)
    ap.add_argument("--max-zoom", type=int, default=8)
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        print(f"ERROR: {args.input} not found", file=sys.stderr)
        return 1

    os.makedirs(args.output, exist_ok=True)
    conn = sqlite3.connect(args.input)
    cur = conn.cursor()
    cur.execute(
        "SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles "
        "WHERE zoom_level BETWEEN ? AND ?",
        (args.min_zoom, args.max_zoom),
    )

    count = 0
    for z, x, tms_y, blob in cur:
        # TMS y → XYZ y
        y = (1 << z) - 1 - tms_y
        out_dir = os.path.join(args.output, str(z), str(x))
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, f"{y}.pbf"), "wb") as f:
            f.write(blob)
        count += 1
        if count % 5000 == 0:
            print(f"  {count} tiles...", flush=True)

    conn.close()
    print(f"==> Wrote {count} tiles to {args.output} (z{args.min_zoom}-z{args.max_zoom})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
