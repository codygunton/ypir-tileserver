import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Two paths outside the vite root that the app imports from:
//   /shared/*.js      -> <repo>/shared/frontend/*.js
//   ./pkg/*.js        -> <repo>/wasm/pkg/*.js (reached via the `pkg` symlink)
//
// /api and /basemap are proxied to the Flask dev proxy so the server-side
// stack is untouched. /raw (the non-PIR HTTP baseline) is served by a vite
// middleware that reads tiles.bin directly — Flask doesn't know about it.

const PROXY_TARGET = process.env.VITE_PROXY_TARGET || 'http://localhost:8009';

/** Locate the dataset dir vite should serve raw slots from. Order:
 *    1. VITE_DATASET_DIR env var (absolute or relative to vite cwd)
 *    2. DATASET env var → ../../datasets/$DATASET
 *    3. the only subdir of ../../datasets/ (if exactly one)
 *  Returns null if none of these resolve to a readable dataset.
 */
function resolveDatasetDir() {
  if (process.env.VITE_DATASET_DIR) {
    return path.resolve(process.env.VITE_DATASET_DIR);
  }
  const datasetsRoot = path.resolve(__dirname, '../../datasets');
  if (process.env.DATASET) {
    return path.join(datasetsRoot, process.env.DATASET);
  }
  if (fs.existsSync(datasetsRoot)) {
    const entries = fs.readdirSync(datasetsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory());
    if (entries.length === 1) return path.join(datasetsRoot, entries[0].name);
  }
  return null;
}

/** Vite plugin: serve /raw/<slot_idx> from tiles.bin without touching Flask. */
function rawSlotPlugin() {
  return {
    name: 'ypir-raw-slot',
    configureServer(server) {
      const datasetDir = resolveDatasetDir();
      if (!datasetDir) {
        server.config.logger.warn(
          '[ypir-raw-slot] no dataset found — set VITE_DATASET_DIR or DATASET. HTTP-baseline mode will not work.',
        );
        return;
      }
      const mappingPath = path.join(datasetDir, 'tile_mapping.json');
      const tilesBinPath = path.join(datasetDir, 'tiles.bin');
      if (!fs.existsSync(mappingPath) || !fs.existsSync(tilesBinPath)) {
        server.config.logger.warn(
          `[ypir-raw-slot] missing tile_mapping.json or tiles.bin under ${datasetDir} — HTTP-baseline mode disabled`,
        );
        return;
      }
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
      const tileSize = mapping.tile_size;
      const numSlots = mapping.num_pir_slots;
      if (!tileSize || !numSlots) {
        server.config.logger.warn('[ypir-raw-slot] tile_mapping.json missing tile_size or num_pir_slots');
        return;
      }

      // Detect a 16-byte header (mirrors what the Rust server auto-detects).
      let headerOffset = 0;
      const fd = fs.openSync(tilesBinPath, 'r');
      const headerBuf = Buffer.alloc(16);
      fs.readSync(fd, headerBuf, 0, 16, 0);
      const headerN = Number(headerBuf.readBigUInt64LE(0));
      const headerSz = Number(headerBuf.readBigUInt64LE(8));
      if (headerN === numSlots && headerSz === tileSize) headerOffset = 16;
      fs.closeSync(fd);

      server.config.logger.info(
        `[ypir-raw-slot] serving ${numSlots} slot(s) of ${tileSize} B from ${tilesBinPath}` +
        (headerOffset ? ' (16-byte header detected)' : ''),
      );

      server.middlewares.use('/raw', (req, res, next) => {
        const m = (req.url || '').match(/^\/(\d+)(?:\?.*)?$/);
        if (!m) return next();
        const idx = parseInt(m[1], 10);
        if (idx < 0 || idx >= numSlots) {
          res.statusCode = 404;
          return res.end();
        }
        const offset = headerOffset + idx * tileSize;
        const handle = fs.openSync(tilesBinPath, 'r');
        const buf = Buffer.alloc(tileSize);
        try {
          fs.readSync(handle, buf, 0, tileSize, offset);
        } finally {
          fs.closeSync(handle);
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.end(buf);
      });
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [rawSlotPlugin()],
  server: {
    port: 5173,
    strictPort: false,
    fs: {
      // Allow reading /shared/frontend and /wasm/pkg from outside the root.
      allow: [path.resolve(__dirname, '../..')],
    },
    proxy: {
      '/api': { target: PROXY_TARGET, changeOrigin: false },
      '/basemap': { target: PROXY_TARGET, changeOrigin: false },
    },
  },
  resolve: {
    alias: [
      {
        find: /^\/shared\//,
        replacement: path.resolve(__dirname, '../../shared/frontend') + '/',
      },
      // The `demo/frontend/pkg` symlink created by dev-up.sh is absolute
      // to `/workspace/wasm/pkg` (valid inside Docker only). Alias the
      // relative import so vite works on the host regardless of symlink
      // state.
      {
        find: /^\.\/pkg\//,
        replacement: path.resolve(__dirname, '../../wasm/pkg') + '/',
      },
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
