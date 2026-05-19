# CLAUDE.md — YPIR tileserver cryptographic-invariants anchor

This file is for Claude Code sessions iterating on the **frontend**, **tile
packaging**, or **measurement harness** without needing to re-read the
crypto each time. It pins what must hold, what's safe to change, and where
the experimentation surface lives. User-facing onboarding is in
[README.md](README.md); this file is denser and agent-facing.

Assumes the reader knows what PIR / LWE / RLWE are. Line numbers are
pinned to the state of the repo when written and may drift; function and
struct names are the durable anchors.

---

## 0. Cheat sheet

### Hard constraints (violate at your peril)

- The YPIR param set is chosen by `ypir::params::params_for_scenario_simplepir(num_tiles, item_size_bits)` at [server/src/main.rs:357](server/src/main.rs:357). Do **not** hand-tune `Params` fields downstream; let the selector run. Its output is `Box::leak`'d to `&'static Params` at [server/src/main.rs:358](server/src/main.rs:358) and threaded through everything.
- Record count is implicitly rounded up to fill `db_rows = 2^(db_dim_1 + poly_len_log2)`. The loader stops at `num_tiles.min(db_rows)` ([server/src/main.rs:126](server/src/main.rs:126)); tiles beyond `db_rows` are silently dropped. Your dataset's `num_pir_slots` must fit.
- Record size is `tile_size` bytes, capped by `instances * poly_len * pt_bits / 8` (`bytes_from_coeffs` at [server/src/main.rs:118](server/src/main.rs:118)). Over-sized tiles are truncated in the packing loop; under-sized are zero-padded (implicit).
- `poly_len = 2048`, `crt_count = 2`, `moduli = [268369921, 249561089]` — hardcoded in spiral-rs' parameter init. Do not alter.
- The WASM client's expansion-key assembly depends on `Client::get_sk_reg()` being `pub` in the vendored Blyss `spiral-rs/` fork ([spiral-rs/src/client.rs:392](spiral-rs/src/client.rs:392)). Re-syncing from Blyss upstream re-introduces `pub(crate)`; reapply the patch. `get_sk_gsw()` correctly remains `pub(crate)` — the client never needs it.
- The hint (`OfflinePrecomputedValues`) is rebuilt from scratch on every server start. There is no persistence, no content hash, no cache.
- `AVX512=1` is a compile-time opt-in. `scripts/dev-up.sh` refuses on hosts without `avx512f` to prevent SIGILL ([scripts/dev-up.sh:30-41](scripts/dev-up.sh)).
- Query buffers must be 64-byte aligned: the server materialises queries into `AlignedMemory64` at [server/src/main.rs:287](server/src/main.rs:287) because the ypir kernel uses `_mm512_load_si512`.

### Soft knobs (safe without crypto review)

- `tile_size` CLI arg (default 20480). Triggers a new selector run → new params → new hint.
- Tile ordering inside `tiles.bin`. Pure permutation of first-dim positions; affects only cache behavior of the multiply.
- `num_tiles` (indirectly, via the dataset build).
- Rayon thread count (`RAYON_NUM_THREADS`), env-log level, HTTP port, frontend batch coalescing window.

---

## 1. Database shape

The DB is a `db_rows × db_cols` matrix of `u16` values each `< pt_modulus`,
stored row-major in a flat `Vec<u16>` of length `db_rows * db_cols`.

| Axis | Size | Role |
|---|---|---|
| Row (first dim) | `db_rows = 1 << (db_dim_1 + poly_len_log2)` | One record (one PIR slot / one tile). The axis the parallelized multiply walks. |
| Col (cheap axis) | `db_cols = instances * poly_len` | Coefficient position within the record. Walked innermost. |

Set at [server/src/main.rs:76-77](server/src/main.rs:76) and again at
[server/src/main.rs:360-361](server/src/main.rs:360). `db_rows` is a power
of two by construction (`poly_len = 2048`, `db_dim_1` from the selector).

**Packing** (tile bytes → coefficients, [server/src/main.rs:135-149](server/src/main.rs:135)):
`pt_bits = floor(log2(pt_modulus))` bits are extracted from the tile
byte-stream per coefficient, little-endian, and reduced mod `pt_modulus`.
Over-sized tiles are truncated; padding bytes get read as 0.

**Spatial-locality implication for tile packaging.** Record index → first-dim
position. The first-dim multiply walks that axis, so a Morton/Hilbert
ordering of tile coords across first-dim positions is *perf* only, not
correctness or security. Within a record the bytes are contiguous in the
cheap (column) axis.

**Alignment.** `db_rows` is always a power of two. Query buffers are
64-byte aligned via `AlignedMemory64`. No constraint on the tile byte
layout beyond the size cap above.

---

## 2. Query/response wire flow

### Endpoints (actix-web, [server/src/main.rs:418-425](server/src/main.rs:418))

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/params` | — | JSON: `{num_items, tile_size, ypir_params (stringified spiral Params JSON), setup_bytes, query_bytes, response_bytes, instances, rlwe_q_prime_1, rlwe_q_prime_2}` ([server/src/main.rs:194-207](server/src/main.rs:194)) |
| POST | `/api/setup` | Expansion-key bytes (see below) | `uuid` as text, used in every subsequent query ([server/src/main.rs:209-233](server/src/main.rs:209)) |
| POST | `/api/query-batch` | `[uuid:36][count:u32LE][q0:query_bytes]…[qN:query_bytes]` | Concatenated ciphertexts, each `response_bytes` long ([server/src/main.rs:235-326](server/src/main.rs:235)) |

Payload cap is 200 MB ([server/src/main.rs:421](server/src/main.rs:421)).

### Wire sizes

All computed once at startup and returned by `/api/params` ([server/src/main.rs:371-377](server/src/main.rs:371)):

```
setup_bytes     = poly_len_log2 * t_exp_left * poly_len * 8
query_bytes     = db_rows * 8                       // CRT-packed u64s
response_bytes  = instances * ct_bytes
ct_bytes        = ceil((q_1_bits + q_2_bits) * poly_len / 8)
q_1_bits        = ceil(log2(rlwe_q_prime_2))
q_2_bits        = ceil(log2(rlwe_q_prime_1))
```

For the default NE-US dataset (`num_tiles ≈ 82750`, `tile_size = 20480`),
setup is ≈2.7 MB and a single query/response pair is on the order of MB in
/ ~100 KB out — verify via `/api/params` at runtime rather than reading
numbers from this doc.

### Client side (WASM)

`YpirClient` at [wasm/src/lib.rs:188-372](wasm/src/lib.rs:188). Three
public entry points:

- `generate_keys()` ([wasm/src/lib.rs:231-253](wasm/src/lib.rs:231)). Calls
  `client.get_sk_reg()` at line 233 — **this is why the vendored Blyss
  fork's visibility patch exists.** Builds expansion params via
  `raw_generate_expansion_params` ([wasm/src/lib.rs:90-113](wasm/src/lib.rs:90)),
  extracts row 1 of each, and **condenses** (packs two CRT limbs
  as `lo | (hi << 32)` in one u64, [wasm/src/lib.rs:37-49](wasm/src/lib.rs:37))
  to halve the wire size.
- `generate_query(target_row)` ([wasm/src/lib.rs:257-309](wasm/src/lib.rs:257)).
  Builds a selection vector over `1 << db_dim_1` RLWE ciphertexts,
  extracts each `b` row ([wasm/src/lib.rs:117-119](wasm/src/lib.rs:117)),
  concatenates, and CRT-packs the result ([wasm/src/lib.rs:53-62](wasm/src/lib.rs:53)).
- `decode_response(data)` ([wasm/src/lib.rs:314-349](wasm/src/lib.rs:314)).
  Per instance: recover the modulus-switched ciphertext, decrypt with
  `sk_reg`, rescale to `pt_modulus`, then bit-pack `pt_bits`-wide plaintext
  coefficients back into contiguous bytes.

### Server-side setup decode

`deserialize_pub_params` at [server/src/main.rs:156-192](server/src/main.rs:156)
expects exactly `params.poly_len_log2` condensed 1×`t_exp_left` matrices.
Wrong count → 400 ([server/src/main.rs:219-225](server/src/main.rs:219)).
Truncated input → `warn!` and the session gets fewer matrices (likely
broken queries; this is not validated further).

---

## 3. Parameter knobs and where they live

### Safe to tune (within the existing selector)

`tile_size` and `num_tiles`. Both flow into
`params_for_scenario_simplepir(num_tiles, item_size_bits)` ([server/src/main.rs:354-357](server/src/main.rs:354)).
The selector picks a `Params` believed secure for those dimensions. Changing
either requires a new offline precompute but no crypto review on your part.

### Requires crypto review

Any edit to fields inside the `spiral_rs::params::Params` struct that the
selector returns: `n`, `q2_bits`, `pt_modulus`, `noise_width`, `moduli`,
`db_dim_1`/`db_dim_2`, `t_gsw`/`t_conv`/`t_exp_left`/`t_exp_right`,
`instances`. These live in the external `ypir` crate pinned at
`github.com/codygunton/ypir @ 4b8a22ff` in [server/Cargo.toml:9](server/Cargo.toml:9).
The security argument for a given tuple lives in the YPIR paper + that crate,
not in this repo.

### Unknown without reading the `ypir` crate

The full selector algorithm — which `(n, q2_bits, db_dim_1, …)` tuple it
produces for a given `(num_tiles, item_size_bits)` and how it decides. Treat
as an opaque function; don't reverse-engineer a recipe.

### Serialized `Params` for the client

`build_ypir_params_json` at [server/src/main.rs:328-346](server/src/main.rs:328)
emits the JSON shape spiral-rs' `params_from_json` parses
([wasm/src/lib.rs:206](wasm/src/lib.rs:206)). If you add or rename fields
there, do it on both sides.

---

## 4. Preprocessing and the hint

- Trigger: `y_server.perform_offline_precomputation_simplepir(None)` at
  [server/src/main.rs:395](server/src/main.rs:395).
- Input: `&'static YServer<'static, u16>` built from the `Vec<u16>` DB at
  [server/src/main.rs:387-389](server/src/main.rs:387). `YServer::new`
  consumes the `Vec<u16>` via `.into_iter()`.
- Output: `OfflinePrecomputedValues<'static>` held in
  `ServerState.offline_vals` for the lifetime of the process.
- Determinism: no RNG passed. Deterministic in `(params, db_bytes)`. Any
  byte of `tiles.bin` changing invalidates. Record reorder invalidates.
  `num_tiles`/`tile_size` change → different selector output → different hint.
- Persistence: **none.** Every server start recomputes from scratch.
- Cost (per [README.md:175-179](README.md:175)): ≈20 s AVX-512 / ≈140 s
  portable for ≈100K slots on a desktop-class CPU. Scales roughly with DB
  bytes.
- Hint internals: defined in the external `ypir` crate. Not visible in this
  repo. Treat as opaque. Flag: unclear whether it has serde impls, which
  gates how cheap a disk-cache experiment is.

---

## 5. First-dimension multiply and parallelization

- **Batch-level Rayon** (visible here): [server/src/main.rs:278-314](server/src/main.rs:278).
  `(0..count).into_par_iter()` runs each query in the batch on a rayon
  thread; per-query work is query deserialization → `AlignedMemory64`
  copy → `perform_online_computation_simplepir` → serialize. Per-query
  elapsed logged at line 305; per-batch elapsed at line 316.
- **Within-multiply Rayon** (not in this repo): the `codygunton/ypir` fork
  adds Rayon parallelization of the first-dim multiply per its README and
  the repo-level `rayon` dep at [server/Cargo.toml:22](server/Cargo.toml:22).
  Exact chunking strategy, thread working-set shape, and whether it
  interacts with batch-level rayon (nested pools) is **not inspected in
  this repo.** If you care about those details, read the fork source.
- Per-thread working set: expected shape is a contiguous slice of the
  first dim (the `db_rows` axis) multiplied against the full query vector.
  Record order therefore influences which memory chunks each thread
  touches. Whether that matters measurably for `db_rows` in the ~100K
  range is an open experimental question.

---

## 6. Experimentation surface

### DB construction is cleanly separable

`load_db_as_u16_iter` ([server/src/main.rs:70-154](server/src/main.rs:70)) is
pure: bit-packs `tile_size` bytes into `db_cols` u16 coefficients, no
crypto. The resulting `Vec<u16>` is handed to `YServer::new`
([server/src/main.rs:388](server/src/main.rs:388)), which runs preprocessing
internally. Any tile layout works as long as the binary blob has
`num_tiles * tile_size` bytes in row-major record order (plus the optional
16-byte `[num_tiles u64 LE][tile_size u64 LE]` header the loader auto-detects
at [server/src/main.rs:89-106](server/src/main.rs:89)).

### Tile-packaging knobs

| Knob | Where it lives | Crypto-sensitive? |
|---|---|---|
| Record order (Morton/Hilbert over tile coords) | [scripts/prepare_tiles.py](scripts/prepare_tiles.py) writes `tiles.bin` + `tile_mapping.json` in pairs; client looks up z/x/y → slot index in the mapping | No. Only affects first-dim cache behavior. New offline precompute required. |
| `tile_size` | `--tile-size` CLI arg → `params_for_scenario_simplepir` | No (selector re-runs). New precompute required. |
| Bucketing by zoom (separate DBs per zoom band) | Requires multiple `YServer`s or a multiplexed endpoint — server currently holds exactly one | Architectural, not crypto. Each server uses the selector independently. |
| Empty-tile handling (synthetic vs. skip vs. sentinel) | `make_synthetic_mvt_tile` in [scripts/prepare_tiles.py](scripts/prepare_tiles.py); `pack_tile_into_slots` for multi-slot packing | No. |
| Neighborhood batching (group adjacent tiles into one slot) | Same, and the mapping JSON must track which slots belong to which tile | No crypto. Changes effective record size; client must know the mapping to reassemble. |

The mapping JSON is the contract between `prepare_tiles.py` and the client.
Slots are identified by index into `tiles.bin`; a tile can span
multiple slots (list of indices) if it's larger than `tile_size`. See the
existing `datasets/*/tile_mapping.json` for the schema.

### Content-addressable hint cache (not implemented)

Hints are deterministic in DB content. A SHA-256 over the loaded `Vec<u16>`
(or over `tiles.bin` bytes after header detection) would key a serialized
hint. Natural location: `datasets/<name>/hint-<sha>.bin`, loaded by
`main.rs` just after constructing the DB. **Gate:** whether
`OfflinePrecomputedValues` has serde impls — unknown from this repo.
If not, this is a non-trivial change inside the `ypir` fork, not a thin
wrapper.

### Existing instrumentation

- Server (env_logger INFO to stderr):
  - Offline precompute elapsed, [server/src/main.rs:396](server/src/main.rs:396).
  - Per-query elapsed, [server/src/main.rs:305](server/src/main.rs:305).
  - Per-batch elapsed, [server/src/main.rs:316](server/src/main.rs:316).
  - Wire sizes at startup, [server/src/main.rs:379](server/src/main.rs:379).
  - DB dimensions at load, [server/src/main.rs:81-84](server/src/main.rs:81) and [server/src/main.rs:152](server/src/main.rs:152).
- Proxy: `GET /api/metrics` returns `{cpu, memory}` via psutil
  ([demo/proxy/server.py](demo/proxy/server.py)).
- Frontend: `performance.now()` bracketing the PIR fetch; displayed in the
  UI badge. See [demo/frontend/app.js](demo/frontend/app.js) around the
  dispatcher.enqueue call.

### Missing for a measurement harness

- Structured output (JSON lines or a `/api/stats` endpoint). Current logs
  are plain text to stderr.
- Hint size in bytes. Would require introspection into `OfflinePrecomputedValues`.
- Per-query server-side breakdown: body parse / `AlignedMemory64` copy /
  online compute / response serialize. Only the third is timed today.
- WASM-side timings (`generate_keys`, `generate_query`, `decode_response`).
  No `performance.mark` calls in the WASM wrapper.
- Batch queuing time (how long a request waited in the frontend
  dispatcher before being sent).

### Minimum viable experiment loop (record-order change)

1. Edit [scripts/prepare_tiles.py](scripts/prepare_tiles.py) to emit
   `tiles.bin` in the new order. Keep `tile_mapping.json` consistent —
   this is the client's only way to translate z/x/y to a slot index.
2. `./scripts/dataset build <name> …` (or just rerun `prepare_tiles.py` if
   the MBTiles are already built).
3. Restart the server (`docker compose restart workbench` inside the
   workbench, or `run_demo.sh` on the host). Offline precompute runs again
   — this is the bottleneck at ≈20 s AVX-512 / ≈140 s portable for NE-US.
4. Measure:
   - Server-side pure compute via the INFO log lines.
   - End-to-end via the browser or a scripted `POST /api/query-batch`.
   - `/api/params` to confirm the selector picked the same param set
     (sanity — tile count and size didn't change).

Step 3 is the single biggest time sink. A hint cache (above) cuts it from
~minutes to ~seconds. Everything else in the loop is cheap.

---

## 7. Fork landscape

- **`ypir` crate** — `github.com/codygunton/ypir @ 4b8a22ffaa9c4273153c08dd2759370f1c1ea4aa`, [server/Cargo.toml:9](server/Cargo.toml:9). Fork of `menonsamir/ypir`. Per the README: Rayon for the first-dim multiply, plus aarch64-safe fallbacks for hot kernels. Not vendored. Source of truth for: parameter selector, `YServer`, `OfflinePrecomputedValues`, `perform_offline_precomputation_simplepir`, `perform_online_computation_simplepir`.
- **Server's `spiral-rs`** — `github.com/codygunton/spiral-rs @ 707c1be6b1455d88420818959ccdedc1f4ddb6d0`, [server/Cargo.toml:10](server/Cargo.toml:10). Fork of `menonsamir/spiral-rs`. Adds cfg-gated scalar paths so aarch64 builds work. Not vendored.
- **Vendored `spiral-rs/`** at repo root — Blyss fork (per its `Cargo.toml`). Already has `#[cfg(target_feature = "avx2")]` gates in both `ntt.rs` and `poly.rs`. The local modification is one line: `Client::get_sk_reg()` made `pub` instead of `pub(crate)` ([spiral-rs/src/client.rs:392](spiral-rs/src/client.rs:392)). Needed because the WASM client assembles the YPIR expansion public keys itself and has to read the RLWE secret directly. `get_sk_gsw()` correctly remains `pub(crate)` — the client never needs GSW expansion.

Two forks of spiral-rs, not one: the server's (codygunton) fork exposes
both `get_sk_reg` and `get_sk_gsw`, has the aarch64-specific gating, and
is a git dep. The vendored Blyss fork at `spiral-rs/` is a different
lineage entirely, used only by the WASM crate via `path = "../spiral-rs"`
in [wasm/Cargo.toml](wasm/Cargo.toml). Unifying them would mean
backporting all of one side's changes to the other; no in-repo plan to do so.

---

## 8. Things left unknown (deliberately)

These require reading code outside this repo. Flagged so future sessions
don't paper over them:

- Exact chunking of the first-dim multiply inside the `ypir` fork. The
  repo-level README claims Rayon parallelization; the fork source is
  authoritative. Relevant to cache-aware tile packaging.
- Whether `OfflinePrecomputedValues` is serde-serializable. Gates the hint
  cache experiment's scope (wrapper vs. fork edit).
- The selector's exact mapping `(num_tiles, item_size_bits) → Params`.
  Opaque here. Read `ypir::params` to understand which knobs it actually
  explores.
