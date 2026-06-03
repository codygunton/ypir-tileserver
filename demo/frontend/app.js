import init, { YpirClient } from './pkg/ypir_wasm.js';
import { LRUTileCache } from '/shared/tile-cache.js';
import { TileBatchDispatcher } from '/shared/tile-batch.js';
import { decodeSlotToPBF, decodeMultiSlotToPBF, decodeBundledToPBF } from '/shared/tile-decoder.js';
import { initMap } from '/shared/map-setup.js';
import * as measurement from './src/measurement.js';

// --- Mode: ?mode=http for the non-PIR baseline, default = PIR ---
const MODE = (new URLSearchParams(window.location.search).get('mode') || 'pir').toLowerCase();
const IS_PIR = MODE === 'pir';
measurement.setMode(MODE);

// --- State ---
let client = null;
let sessionUuid = null;
let tileMapping = null;
let pirParams = null;
let queryCount = 0;
let totalLatencyMs = 0;
let lastQueryMs = 0;
let currentZoom = 6;
const tileCache = new LRUTileCache(500 * 1024 * 1024); // 500 MB

// --- Mapping helpers ---
// `mapping` is the raw tile_mapping.json entry. Three forms:
//   int                     -> single slot, whole-slot tile (legacy)
//   list[int]               -> multi-slot whole-tile span (legacy)
//   {slot, offset, length}  -> bundled into a shared slot (new)
function mappingSlots(m) {
    if (Array.isArray(m)) return m;
    if (typeof m === 'number') return [m];
    return [m.slot];
}
function mappingKind(m) {
    if (Array.isArray(m)) return m.length > 1 ? 'span' : 'single';
    if (typeof m === 'number') return 'single';
    return 'bundled';
}

// --- YPIR PIR backend ---
const ypirBackend = {
    processBatch: async (tiles, abortSignal) => {
        // Dedupe slots across tiles: tiles sharing a bundled slot share one
        // PIR query. uniqueSlots[i] -> the slot index queried at position i.
        const slotToIndex = new Map();
        const uniqueSlots = [];
        for (const t of tiles) {
            for (const s of mappingSlots(t.mapping)) {
                if (!slotToIndex.has(s)) {
                    slotToIndex.set(s, uniqueSlots.length);
                    uniqueSlots.push(s);
                }
            }
        }
        const B = uniqueSlots.length;
        console.log(`Dispatcher flush: ${tiles.length} tile(s), ${B} unique slot query(ies)`);

        // Generate query payloads
        const uuidBytes = new TextEncoder().encode(sessionUuid);
        const qBytes = pirParams.query_bytes;
        const queryPayloads = [];
        for (let i = 0; i < B; i++) {
            queryPayloads.push(new Uint8Array(client.generate_query(uniqueSlots[i])));
            if ((i + 1) % 5 === 0) await new Promise(r => setTimeout(r, 0));
        }

        // Build batch payload: [UUID:36][count:uint32LE][q0]...[qB-1]
        const batchPayload = new Uint8Array(36 + 4 + B * qBytes);
        batchPayload.set(uuidBytes, 0);
        new DataView(batchPayload.buffer).setUint32(36, B, true);
        for (let i = 0; i < B; i++) {
            batchPayload.set(queryPayloads[i], 36 + 4 + i * qBytes);
        }

        const rawResp = await fetch('/api/query-batch', {
            method: 'POST',
            body: batchPayload,
            headers: { 'Content-Type': 'application/octet-stream' },
            signal: abortSignal,
        });
        if (!rawResp.ok) throw new Error(`/api/query-batch failed: ${rawResp.status}`);
        const rawBuf = await rawResp.arrayBuffer();

        // Slice response into per-slot raw Uint8Arrays, indexed by slot number.
        const rBytes = pirParams.response_bytes;
        const slotRaw = new Map();
        for (let i = 0; i < B; i++) {
            slotRaw.set(uniqueSlots[i], new Uint8Array(rawBuf, i * rBytes, rBytes));
        }

        // Decode per tile based on mapping kind.
        const tileSize = pirParams.tile_size;
        const decodedSlot = new Map();   // slot_idx -> decrypted plaintext Uint8Array
        function getDecoded(slot) {
            if (!decodedSlot.has(slot)) {
                const raw = slotRaw.get(slot);
                decodedSlot.set(slot, new Uint8Array(client.decode_response(raw)).subarray(0, tileSize));
            }
            return decodedSlot.get(slot);
        }

        const results = new Map();
        for (const t of tiles) {
            let result;
            try {
                const kind = mappingKind(t.mapping);
                if (kind === 'bundled') {
                    const m = t.mapping;
                    result = decodeBundledToPBF(getDecoded(m.slot), m.offset, m.length);
                } else if (kind === 'single') {
                    const idx = typeof t.mapping === 'number' ? t.mapping : t.mapping[0];
                    result = decodeSlotToPBF(getDecoded(idx));
                } else {
                    result = decodeMultiSlotToPBF(t.mapping.map(getDecoded));
                }
            } catch (e) {
                console.error(`[decode] ${t.key}: ERROR`, e);
                result = new ArrayBuffer(0);
            }
            results.set(t.key, result);
        }
        return results;
    }
};

const dispatcher = new TileBatchDispatcher(ypirBackend, 100);

// --- HTTP baseline: fetch raw slots directly, no batching ---
// Slot-level inflight dedup so multiple tiles sharing one bundled slot only
// generate one /raw/<idx> request even when concurrently requested.
const httpSlotInflight = new Map();
async function fetchSlotHttp(idx, abortSignal) {
    if (httpSlotInflight.has(idx)) return httpSlotInflight.get(idx);
    const p = (async () => {
        const r = await fetch(`/raw/${idx}`, { signal: abortSignal });
        if (!r.ok) throw new Error(`/raw/${idx} failed: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
    })();
    httpSlotInflight.set(idx, p);
    p.finally(() => httpSlotInflight.delete(idx));
    return p;
}

async function fetchTileHttp(mapping, abortSignal) {
    const kind = mappingKind(mapping);
    if (kind === 'bundled') {
        const m = mapping;
        const slot = await fetchSlotHttp(m.slot, abortSignal);
        return decodeBundledToPBF(slot, m.offset, m.length);
    }
    const slots = mappingSlots(mapping);
    const parts = await Promise.all(slots.map(s => fetchSlotHttp(s, abortSignal)));
    return parts.length > 1 ? decodeMultiSlotToPBF(parts) : decodeSlotToPBF(parts[0]);
}

// --- UI helpers ---
function setStatus(msg) {
    document.getElementById('loading-status').textContent = msg;
}

function setProgress(pct) {
    document.getElementById('loading-bar').style.width = pct + '%';
}

// --- Initialization ---
async function initialize() {
    try {
        // Fetch dataset info for display
        try {
            const dsResp = await fetch('/api/dataset');
            if (dsResp.ok) {
                const ds = await dsResp.json();
                const modeLabel = IS_PIR ? 'PIR mode' : 'HTTP baseline mode';
                document.getElementById('loading-dataset').textContent = `Dataset: ${ds.name} — ${modeLabel}`;
            }
        } catch { /* non-critical */ }

        if (IS_PIR) {
            setStatus('Loading WASM module...');
            setProgress(5);
            await init();

            setStatus('Fetching PIR parameters...');
            setProgress(10);
            const paramsResp = await fetch('/api/params');
            if (!paramsResp.ok) throw new Error('Failed to fetch /api/params');
            pirParams = await paramsResp.json();
            console.log('PIR params:', pirParams);
            measurement.setWireSizes({
                query_bytes: pirParams.query_bytes,
                response_bytes: pirParams.response_bytes,
            });

            setStatus('Initializing YPIR PIR client...');
            setProgress(15);
            client = new YpirClient(
                pirParams.ypir_params,
                BigInt(pirParams.rlwe_q_prime_1),
                BigInt(pirParams.rlwe_q_prime_2)
            );
            console.log(`YPIR client: ${pirParams.num_items} items, ${client.query_bytes()} B/query, ${client.num_instances()} instances`);

            setStatus('Generating encryption keys...');
            setProgress(20);
            const setupBytes = client.generate_keys();
            console.log(`Setup data: ${(setupBytes.length / 1024).toFixed(1)} KB`);

            setStatus(`Uploading keys (${(setupBytes.length / 1024).toFixed(1)} KB)...`);
            setProgress(50);
            const setupResp = await fetch('/api/setup', {
                method: 'POST',
                body: setupBytes,
                headers: { 'Content-Type': 'application/octet-stream' },
            });
            if (!setupResp.ok) throw new Error(`Failed to upload keys: ${setupResp.status}`);
            sessionUuid = (await setupResp.text()).trim();
            console.log(`Session UUID: ${sessionUuid}`);
        } else {
            console.log('HTTP baseline mode: skipping PIR setup');
            setProgress(50);
        }

        setStatus('Loading tile mapping...');
        setProgress(80);
        const mappingResp = await fetch('/api/tile-mapping');
        if (!mappingResp.ok) throw new Error('Failed to fetch tile mapping');
        const mappingData = await mappingResp.json();
        tileMapping = new Map(Object.entries(mappingData.tiles));
        console.log(`Tile mapping: ${tileMapping.size} tiles, z${mappingData.min_zoom}-${mappingData.max_zoom}`);

        // In HTTP mode, set wire sizes from the dataset metadata (no PIR params available).
        if (!IS_PIR) {
            measurement.setWireSizes({
                query_bytes: 0,
                response_bytes: mappingData.tile_size || 0,
            });
        }

        setStatus('Starting map...');
        setProgress(95);
        const map = initMap(mappingData, fetchTileViaPIR, {
            zoom: 6,
            center: [-73.5, 42.0],
            onZoom: (z) => {
                currentZoom = z;
                updatePirStats();
            },
        });

        // Expose a small replay/inspection API for the experiment harness.
        // Always on — small footprint, no behavior change when unused.
        let lastFrame = null;
        window.__experimentReplay = {
            ready: false,
            currentTrajectoryState: null,
            getMode: () => MODE,
            isReady: () => window.__experimentReplay.ready,
            pushFrame: ({ t, lng, lat, zoom }) => {
                map.jumpTo({ center: [lng, lat], zoom });
                let pan_speed_deg_per_s = 0;
                let frame_idx = 0;
                if (lastFrame !== null) {
                    const dt_s = (t - lastFrame.t) / 1000;
                    if (dt_s > 0) {
                        const dlng = lng - lastFrame.lng;
                        const dlat = lat - lastFrame.lat;
                        pan_speed_deg_per_s = Math.sqrt(dlng * dlng + dlat * dlat) / dt_s;
                    }
                    frame_idx = lastFrame.frame_idx + 1;
                }
                window.__experimentReplay.currentTrajectoryState = {
                    frame_idx,
                    pan_lng: lng,
                    pan_lat: lat,
                    pan_zoom: zoom,
                    pan_speed_deg_per_s: Number(pan_speed_deg_per_s.toFixed(6)),
                };
                lastFrame = { t, lng, lat, frame_idx };
            },
            getEvents: () => measurement.getEvents ? measurement.getEvents() : [],
            getStats: () => measurement.stats(),
            clearEvents: () => measurement.clearEvents(),
        };

        // Slot-boundary overlay: draw edges only between tiles in different
        // PIR slots. Tiles inside the same bundled slot share continuous
        // regions (no line between them) so bundling is legible at a glance.
        setupSlotBoundaryOverlay(map);

        setProgress(100);
        setTimeout(() => {
            document.getElementById('loading-screen').style.display = 'none';
            const badge = document.getElementById('pir-badge');
            badge.style.display = 'flex';
            badge.querySelector('strong').textContent = IS_PIR ? 'YPIR PIR Active' : 'HTTP Baseline Active';
            document.getElementById('cpu-metrics').style.display = 'block';
            document.getElementById('measurement-panel').style.display = 'block';
            document.getElementById('view-toggles').style.display = 'block';

            // Tile boundary overlay via MapLibre's built-in debug flag.
            const tb = document.getElementById('toggle-tile-boundaries');
            tb.addEventListener('change', () => {
                map.showTileBoundaries = tb.checked;
            });

            // Slot boundary toggle.
            const sb = document.getElementById('toggle-slot-boundaries');
            sb.addEventListener('change', () => {
                const apply = () => {
                    map.setLayoutProperty('slot-boundaries', 'visibility',
                        sb.checked ? 'visible' : 'none');
                    if (sb.checked) refreshSlotBoundaries(map);
                };
                if (map.getLayer('slot-boundaries')) apply();
                else map.once('load', apply);
            });

            // Labels toggle: flip visibility on every layer whose id starts
            // with 'label-' (label-water, label-place-*, label-road).
            // Note: glyph PBFs are fetched from openfreemap.org — that
            // traffic is *not* private.
            const lb = document.getElementById('toggle-labels');
            lb.addEventListener('change', () => {
                const apply = () => {
                    const vis = lb.checked ? 'visible' : 'none';
                    const ids = map.getStyle().layers
                        .filter(l => l.id.startsWith('label-'))
                        .map(l => l.id);
                    console.log(`Labels toggle: ${ids.length} layer(s)`, ids);
                    for (const id of ids) {
                        map.setLayoutProperty(id, 'visibility', vis);
                    }
                };
                if (map.isStyleLoaded()) apply();
                else map.once('load', apply);
            });

            updateMeasurementPanel();
            window.__experimentReplay.ready = true;
        }, 300);

        startMetricsPolling();

    } catch (err) {
        console.error('Init failed:', err);
        setStatus(`Error: ${err.message}`);
        document.querySelector('.loading-spinner').style.display = 'none';
    }
}

// --- Basemap zoom threshold: z <= this are served as static tiles (no PIR) ---
const BASEMAP_MAX_ZOOM = 8;

// Current trajectory state at event time — stamped onto every recordQuery.
// Returns {} when not in a replay (so normal browsing still works).
function trajectoryState() {
    return window.__experimentReplay?.currentTrajectoryState || {};
}

// --- Tile fetching: basemap (static) or PIR depending on zoom ---
async function fetchTileViaPIR(z, x, y, abortSignal) {
    const key = `${z}/${x}/${y}`;

    const cached = tileCache.get(key);
    if (cached) {
        measurement.recordQuery({ kind: 'cache-hit', key, z, ...trajectoryState() });
        return cached;
    }

    // Short debounce: skip tiles cancelled during zoom animation.
    await new Promise(r => {
        const t = setTimeout(r, 50);
        abortSignal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
    });
    if (abortSignal?.aborted) return new ArrayBuffer(0);

    // Basemap tiles: fetch directly from static endpoint (no privacy needed)
    if (z <= BASEMAP_MAX_ZOOM) {
        try {
            const resp = await fetch(`/basemap/${z}/${x}/${y}.pbf`, { signal: abortSignal });
            if (!resp.ok) {
                // Cache miss to avoid re-requesting missing ocean tiles
                tileCache.set(key, new ArrayBuffer(0));
                return new ArrayBuffer(0);
            }
            const pbf = await resp.arrayBuffer();
            tileCache.set(key, pbf);
            return pbf;
        } catch (e) {
            if (e?.name !== 'AbortError') console.error(`Basemap ${key}: failed`, e?.message);
            return new ArrayBuffer(0);
        }
    }

    // High-zoom tiles: PIR or HTTP baseline depending on mode
    const mapping = tileMapping.get(key);
    if (mapping === undefined) return new ArrayBuffer(0);

    const slotsForTile = mappingSlots(mapping);
    const kind = mappingKind(mapping);
    const tag = IS_PIR ? 'PIR' : 'HTTP';
    console.log(`${tag} fetch: ${key} -> ${kind} [${slotsForTile.join(',')}]`);

    const t0 = performance.now();
    try {
        const pbf = IS_PIR
            ? await dispatcher.enqueue(z, x, y, mapping, abortSignal)
            : await fetchTileHttp(mapping, abortSignal);
        if (pbf.byteLength === 0) return pbf;

        tileCache.set(key, pbf);

        const elapsed = performance.now() - t0;
        queryCount++;
        totalLatencyMs += elapsed;
        lastQueryMs = elapsed;
        updatePirStats();
        measurement.recordQuery({
            kind: IS_PIR ? 'pir' : 'http',
            key,
            z,
            slots: slotsForTile.length,
            mapping_kind: kind,
            latency_ms: Math.round(elapsed),
            bytes_decoded: pbf.byteLength,
            ...trajectoryState(),
        });
        console.log(`${tag} ${key}: OK ${kind} ${slotsForTile.length} slot(s) in ${elapsed.toFixed(0)}ms`);
        return pbf;
    } catch (e) {
        if (e?.name !== 'AbortError') {
            console.error(`${tag} ${key}: fetch failed:`, e?.message || e);
            measurement.recordQuery({
                kind: IS_PIR ? 'pir' : 'http',
                key,
                z,
                slots: slotsForTile.length,
                mapping_kind: kind,
                error: e?.name || 'error',
                ...trajectoryState(),
            });
        }
        return new ArrayBuffer(0);
    }
}

function updatePirStats() {
    const avg = queryCount > 0 ? (totalLatencyMs / queryCount).toFixed(0) : '—';
    document.getElementById('pir-stats').textContent =
        `z${currentZoom.toFixed(1)} | ${queryCount} queries | avg ${avg}ms`;
    document.getElementById('query-time').textContent =
        `${lastQueryMs.toFixed(0)}ms`;
    updateMeasurementPanel();
}

function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function updateMeasurementPanel() {
    const s = measurement.stats();
    const el = document.getElementById('measurement-body');
    if (!el) return;
    el.innerHTML = `
        <div class="metrics-row"><span class="metrics-label">Mode</span><span class="metrics-value">${s.mode.toUpperCase()}</span></div>
        <div class="metrics-row"><span class="metrics-label">Fetches</span><span class="metrics-value">${s.fetches}</span></div>
        <div class="metrics-row"><span class="metrics-label">Cache hits</span><span class="metrics-value">${s.cacheHits} (${(s.hitRate * 100).toFixed(0)}%)</span></div>
        <div class="metrics-row"><span class="metrics-label">p50 / p95</span><span class="metrics-value">${s.p50Ms.toFixed(0)} / ${s.p95Ms.toFixed(0)} ms</span></div>
        <div class="metrics-row"><span class="metrics-label">Bytes up</span><span class="metrics-value">${fmtBytes(s.bytesUp)}</span></div>
        <div class="metrics-row"><span class="metrics-label">Bytes down</span><span class="metrics-value">${fmtBytes(s.bytesDown)}</span></div>
    `;
}

// --- Slot-boundary overlay ---
// Highlights inter-slot edges in the current viewport so bundling is
// visually legible: tiles inside one bundled slot appear as continuous
// regions, while singleton tiles keep all four borders.

function tileToLngLat(z, x, y) {
    const n = 1 << z;
    const lng = x / n * 360 - 180;
    const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
    return [lng, lat_rad * 180 / Math.PI];
}

// Representative slot id for a tile, regardless of mapping form. Tiles in
// the same bundle return the same id; tiles in different slots return
// different ids. Returns null if the tile isn't in the mapping.
function slotForTile(z, x, y) {
    const m = tileMapping?.get(`${z}/${x}/${y}`);
    if (m === undefined) return null;
    return mappingSlots(m)[0];
}

function setupSlotBoundaryOverlay(map) {
    const install = () => {
        if (map.getSource('slot-boundaries')) return;
        map.addSource('slot-boundaries', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
            id: 'slot-boundaries',
            type: 'line',
            source: 'slot-boundaries',
            layout: { visibility: 'none' },
            paint: {
                'line-color': '#ff5252',
                'line-width': 2.0,
                'line-opacity': 0.9,
            },
        });
    };
    if (map.isStyleLoaded()) install();
    else map.once('load', install);

    map.on('moveend', () => {
        if (map.getLayer('slot-boundaries') &&
            map.getLayoutProperty('slot-boundaries', 'visibility') === 'visible') {
            refreshSlotBoundaries(map);
        }
    });
}

function refreshSlotBoundaries(map) {
    const z = Math.round(map.getZoom());
    // Only meaningful for PIR-zone tiles; below the basemap cutoff every
    // tile is fetched in the clear, slot concept doesn't apply.
    if (z <= BASEMAP_MAX_ZOOM) {
        map.getSource('slot-boundaries').setData({ type: 'FeatureCollection', features: [] });
        return;
    }
    const bounds = map.getBounds();
    const w = bounds.getWest(), e = bounds.getEast();
    const s = bounds.getSouth(), n = bounds.getNorth();

    // Tile X-range from lng bounds; tile Y-range from lat bounds (Web Mercator).
    const N = 1 << z;
    const xMin = Math.max(0, Math.floor((w + 180) / 360 * N) - 1);
    const xMax = Math.min(N - 1, Math.ceil((e + 180) / 360 * N) + 1);
    const yFromLat = (lat) => {
        const r = lat * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N);
    };
    const yMin = Math.max(0, yFromLat(n) - 1);
    const yMax = Math.min(N - 1, yFromLat(s) + 1);

    const features = [];
    for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
            const here = slotForTile(z, x, y);
            if (here === null) continue;

            // Only emit the N and W edges of each tile — every shared
            // edge is owned by exactly one tile, naturally deduping.
            const nw = tileToLngLat(z, x, y);
            const ne = tileToLngLat(z, x + 1, y);
            const sw = tileToLngLat(z, x, y + 1);

            // N edge: this tile vs (z, x, y-1).
            const above = slotForTile(z, x, y - 1);
            if (above !== here) {
                features.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [nw, ne] },
                });
            }
            // W edge: this tile vs (z, x-1, y).
            const left = slotForTile(z, x - 1, y);
            if (left !== here) {
                features.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [nw, sw] },
                });
            }
        }
    }

    map.getSource('slot-boundaries').setData({
        type: 'FeatureCollection',
        features,
    });
}

// --- CPU metrics polling ---
function startMetricsPolling() {
    async function poll() {
        try {
            const resp = await fetch('/api/metrics');
            if (!resp.ok) return;
            const m = await resp.json();
            if (m.error) return;
            document.getElementById('cpu-util').textContent = `${m.cpu_percent}%`;
            document.getElementById('cpu-mem').textContent =
                `${m.memory_used_mb} / ${m.memory_total_mb} MB`;
        } catch {
            // Metrics unavailable
        }
    }
    poll();
    setInterval(poll, 2000);
}

// --- Measurement panel controls ---
document.addEventListener('DOMContentLoaded', () => {
    const dl = document.getElementById('measurement-download');
    if (dl) dl.addEventListener('click', () => measurement.downloadCsv());
    const clr = document.getElementById('measurement-clear');
    if (clr) clr.addEventListener('click', () => {
        measurement.clearEvents();
        updateMeasurementPanel();
    });
});

// --- Start ---
initialize();
