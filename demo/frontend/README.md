# Frontend dev (vite)

This directory is served two ways:

- **Production / stock demo:** Flask serves these files directly
  (`demo/proxy/server.py`). No build step. This is what `docker compose up`
  and `run_demo.sh` use.
- **Dev iteration (this branch):** vite dev server with hot reload, ES
  module resolution, and a proxy to Flask for the backend endpoints.

## One-time

```bash
cd demo/frontend
npm install
```

## Dev loop

Prerequisite: the Rust server + Flask proxy are running (via Docker or
`run_demo.sh`). Flask must be listening on `http://localhost:8009` (the
default).

```bash
cd demo/frontend
npm run dev
```

Opens `http://localhost:5173`. `/api/*` and `/basemap/*` are proxied to
Flask. Edit any file in `demo/frontend/` or `shared/frontend/` — the
browser reloads.

To point at a Flask running somewhere other than `localhost:8009`:

```bash
VITE_PROXY_TARGET=http://otherhost:8009 npm run dev
```

## WASM artifact

The `demo/frontend/pkg` symlink must point at a valid `wasm/pkg`
directory produced by `wasm-pack build`. Inside Docker this is done by
`scripts/dev-up.sh`. On a host checkout, `run_demo.sh` handles it. If the
symlink is broken you'll see a 404 on `/pkg/ypir_wasm.js` at startup.

## Measurement panel

A per-session event log lives in `src/measurement.js`. The bottom-left
panel shows PIR query count, cache hit rate, p50/p95 latency, and rolling
bytes in/out. **Download CSV** dumps raw events for offline analysis
across experimental runs.

This is the scaffold for tile-packaging experiments. When you add new
things worth measuring (decode time, reassembly time, per-zoom
breakdowns), extend `recordQuery({...})` calls in `app.js` and
`stats()` / CSV columns in `measurement.js`.
