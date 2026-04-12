"""
Flask proxy server for the YPIR PIR map demo.

Forwards API requests to the Rust YPIR server over HTTP,
and serves the static frontend files.
"""

import argparse
import json
import logging
import os
import sys

import requests
from flask import Flask, Response, jsonify, request, send_from_directory

# Repo layout: demo/proxy/server.py → repo root is ../..
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(_REPO_ROOT, "shared", "proxy"))
from common import load_dataset_info, load_tile_mapping

logger = logging.getLogger(__name__)

SHARED_FRONTEND_DIR = os.path.join(_REPO_ROOT, "shared", "frontend")


def create_app(ypir_host: str, ypir_port: int, tiles_dir: str) -> Flask:
    frontend_dir = os.path.join(_REPO_ROOT, "demo", "frontend")

    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB

    ypir_base = f"http://{ypir_host}:{ypir_port}"

    # ------------------------------------------------------------------ #
    # YPIR PIR setup endpoint
    # ------------------------------------------------------------------ #

    @app.route("/api/setup", methods=["POST"])
    def setup():
        payload = request.get_data()
        logger.info("Forwarding /api/setup (%d bytes) to YPIR server", len(payload))
        try:
            resp = requests.post(
                f"{ypir_base}/api/setup",
                data=payload,
                headers={"Content-Type": "application/octet-stream"},
                timeout=30,
            )
            resp.raise_for_status()
            return Response(resp.content, content_type="text/plain")
        except Exception as exc:
            logger.error("YPIR server setup failed: %s", exc)
            return jsonify({"status": "error", "message": str(exc)}), 502

    # ------------------------------------------------------------------ #
    # YPIR PIR batch query endpoint
    # ------------------------------------------------------------------ #

    @app.route("/api/query-batch", methods=["POST"])
    def query_batch():
        payload = request.get_data()
        logger.info(
            "Forwarding /api/query-batch (%d bytes) to YPIR server", len(payload)
        )
        try:
            resp = requests.post(
                f"{ypir_base}/api/query-batch",
                data=payload,
                headers={"Content-Type": "application/octet-stream"},
                timeout=120,
            )
            resp.raise_for_status()
            return Response(resp.content, content_type="application/octet-stream")
        except Exception as exc:
            logger.error("YPIR server batch query failed: %s", exc)
            return jsonify({"status": "error", "message": str(exc)}), 502

    # ------------------------------------------------------------------ #
    # PIR parameters — forwarded from YPIR server
    # ------------------------------------------------------------------ #

    @app.route("/api/params", methods=["GET"])
    def params():
        try:
            resp = requests.get(f"{ypir_base}/api/params", timeout=5)
            resp.raise_for_status()
            return jsonify(resp.json())
        except Exception as exc:
            logger.error("Failed to fetch params from YPIR server: %s", exc)
            return jsonify({"error": str(exc)}), 502

    # ------------------------------------------------------------------ #
    # Dataset metadata
    # ------------------------------------------------------------------ #

    @app.route("/api/dataset", methods=["GET"])
    def dataset_info():
        return jsonify(load_dataset_info(tiles_dir))

    # ------------------------------------------------------------------ #
    # Tile mapping file
    # ------------------------------------------------------------------ #

    @app.route("/api/tile-mapping", methods=["GET"])
    def tile_mapping():
        try:
            mapping = load_tile_mapping(tiles_dir)
            return jsonify(mapping)
        except FileNotFoundError:
            return jsonify({"error": "tile_mapping.json not found"}), 404
        except json.JSONDecodeError as exc:
            return jsonify({"error": f"Invalid JSON: {exc}"}), 500

    # ------------------------------------------------------------------ #
    # CPU metrics
    # ------------------------------------------------------------------ #

    @app.route("/api/metrics", methods=["GET"])
    def metrics():
        try:
            import psutil
            cpu = psutil.cpu_percent(interval=None)
            mem = psutil.virtual_memory()
            return jsonify({
                "cpu_percent": round(cpu, 1),
                "memory_used_mb": int(mem.used / 1024 / 1024),
                "memory_total_mb": int(mem.total / 1024 / 1024),
            })
        except ImportError:
            return jsonify({"error": "psutil not installed"}), 500
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500

    # ------------------------------------------------------------------ #
    # Basemap tiles (static, no PIR — served directly as gzipped PBF)
    # ------------------------------------------------------------------ #

    basemap_dir = os.path.join(tiles_dir, "basemap")

    @app.route("/basemap/<int:z>/<int:x>/<int:y>.pbf")
    def basemap_tile(z, x, y):
        tile_path = os.path.join(basemap_dir, str(z), str(x), f"{y}.pbf")
        if not os.path.isfile(tile_path):
            return Response(b"", status=404)
        with open(tile_path, "rb") as f:
            data = f.read()
        return Response(
            data,
            content_type="application/x-protobuf",
            headers={
                "Content-Encoding": "gzip",
                "Cache-Control": "public, max-age=86400",
            },
        )

    # ------------------------------------------------------------------ #
    # Shared JS modules (served from pir-map-shared/frontend/)
    # ------------------------------------------------------------------ #

    @app.route("/shared/<path:filename>")
    def shared_files(filename):
        return send_from_directory(SHARED_FRONTEND_DIR, filename)

    # ------------------------------------------------------------------ #
    # Static frontend files
    # ------------------------------------------------------------------ #

    @app.route("/")
    def index():
        return send_from_directory(frontend_dir, "index.html")

    @app.route("/<path:path>")
    def static_files(path):
        return send_from_directory(frontend_dir, path)

    return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Flask proxy server for the YPIR PIR map demo"
    )
    parser.add_argument(
        "--ypir-host",
        default="localhost",
        help="Hostname of the YPIR server (default: localhost)",
    )
    parser.add_argument(
        "--ypir-port",
        type=int,
        default=8084,
        help="Port of the YPIR server (default: 8084)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8009,
        help="Port for this HTTP proxy server (default: 8009)",
    )
    parser.add_argument(
        "--tiles-dir",
        required=True,
        help="Path to directory containing tiles.bin and tile_mapping.json",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    tiles_dir = os.path.abspath(args.tiles_dir)
    if not os.path.isdir(tiles_dir):
        logger.error("Tiles directory does not exist: %s", tiles_dir)
        raise SystemExit(1)

    app = create_app(args.ypir_host, args.ypir_port, tiles_dir)

    logger.info(
        "Starting YPIR proxy on :%d  (YPIR server at %s:%d, tiles: %s)",
        args.port,
        args.ypir_host,
        args.ypir_port,
        tiles_dir,
    )
    app.run(host="0.0.0.0", port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
