import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Two paths outside the vite root that the app imports from:
//   /shared/*.js      -> <repo>/shared/frontend/*.js
//   ./pkg/*.js        -> <repo>/wasm/pkg/*.js (reached via the `pkg` symlink)
//
// The shared modules are resolved via an alias so they load directly off
// disk; /api, /basemap, and /shared (as HTTP fetches, not imports) are
// proxied to the Flask dev proxy so the server-side stack is untouched.

const PROXY_TARGET = process.env.VITE_PROXY_TARGET || 'http://localhost:8009';

export default defineConfig({
  root: __dirname,
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
