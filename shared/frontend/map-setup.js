// pir-map-shared/frontend/map-setup.js
//
// Shared map initialization for all PIR demos.
// Handles: MapLibre setup, pir:// protocol, basemap routing, zoom debounce.
//
// fetchTileFn: async (z, x, y, abortSignal) => ArrayBuffer
//   Called ONLY for PIR tiles (z > basemapMaxZoom). Basemap tiles are
//   fetched directly from /basemap/{z}/{x}/{y}.pbf when available.

let _fetchTileFn = () => Promise.resolve(new ArrayBuffer(0));
let _basemapMaxZoom = -1;  // -1 = no basemap
const _basemapCache = new Map();

maplibregl.addProtocol('pir', async (params, abortController) => {
    const parts = params.url.replace('pir://', '').split('/');
    if (parts[0] === 'tiles') parts.shift();
    const [z, x, y] = parts.map(Number);
    const key = `${z}/${x}/${y}`;
    const signal = abortController.signal;

    // Short debounce: skip tiles cancelled during zoom animation
    await new Promise(r => {
        const t = setTimeout(r, 50);
        signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
    });
    if (signal?.aborted) return { data: new ArrayBuffer(0) };

    // Basemap tiles: fetch from static endpoint (no PIR needed)
    if (_basemapMaxZoom >= 0 && z <= _basemapMaxZoom) {
        const cached = _basemapCache.get(key);
        if (cached !== undefined) return { data: cached };
        try {
            const resp = await fetch(`/basemap/${z}/${x}/${y}.pbf`, { signal });
            if (!resp.ok) {
                _basemapCache.set(key, new ArrayBuffer(0));
                return { data: new ArrayBuffer(0) };
            }
            const data = await resp.arrayBuffer();
            _basemapCache.set(key, data);
            return { data };
        } catch {
            return { data: new ArrayBuffer(0) };
        }
    }

    // PIR tiles: delegate to the demo-specific fetch function
    const data = await _fetchTileFn(z, x, y, signal);
    return { data };
});

export function initMap(mappingData, fetchTileFn, opts = {}) {
    _fetchTileFn = fetchTileFn;
    _basemapMaxZoom = opts.basemapMaxZoom ?? -1;

    const center = opts.center || mappingData.center || [-73.9857, 40.7484];
    const maxZoom = mappingData.max_zoom || 11;
    const initialZoom = opts.zoom ?? 14;

    const map = new maplibregl.Map({
        container: 'map',
        center: center,
        zoom: initialZoom,
        minZoom: 0,
        maxZoom: 16,
        style: {
            version: 8,
            name: 'PIR Vector Tiles',
            sources: {
                pir: {
                    type: 'vector',
                    tiles: ['pir://tiles/{z}/{x}/{y}'],
                    minzoom: 0,
                    maxzoom: maxZoom,
                },
            },
            layers: [
                // Background
                {
                    id: 'background',
                    type: 'background',
                    paint: { 'background-color': '#1a1a2e' },
                },
                // Water
                {
                    id: 'water',
                    type: 'fill',
                    source: 'pir',
                    'source-layer': 'water',
                    paint: {
                        'fill-color': '#1a3a5c',
                        'fill-opacity': 0.8,
                    },
                },
                // Landcover
                {
                    id: 'landcover',
                    type: 'fill',
                    source: 'pir',
                    'source-layer': 'landcover',
                    paint: {
                        'fill-color': '#1e3a1e',
                        'fill-opacity': 0.4,
                    },
                },
                // Landuse
                {
                    id: 'landuse',
                    type: 'fill',
                    source: 'pir',
                    'source-layer': 'landuse',
                    paint: {
                        'fill-color': '#2a2a3e',
                        'fill-opacity': 0.5,
                    },
                },
                // Park
                {
                    id: 'park',
                    type: 'fill',
                    source: 'pir',
                    'source-layer': 'park',
                    paint: {
                        'fill-color': '#1e4a1e',
                        'fill-opacity': 0.3,
                    },
                },
                // Buildings
                {
                    id: 'building',
                    type: 'fill',
                    source: 'pir',
                    'source-layer': 'building',
                    minzoom: 10,
                    paint: {
                        'fill-color': '#3a3a5e',
                        'fill-opacity': 0.6,
                        'fill-outline-color': '#4a4a6e',
                    },
                },
                // Roads — highway
                {
                    id: 'road-highway',
                    type: 'line',
                    source: 'pir',
                    'source-layer': 'transportation',
                    filter: ['==', 'class', 'motorway'],
                    paint: {
                        'line-color': '#f0a050',
                        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 10, 3, 14, 6],
                    },
                },
                // Roads — major
                {
                    id: 'road-major',
                    type: 'line',
                    source: 'pir',
                    'source-layer': 'transportation',
                    filter: ['in', 'class', 'trunk', 'primary'],
                    paint: {
                        'line-color': '#c0a060',
                        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.3, 10, 1.5, 14, 4],
                    },
                },
                // Roads — secondary
                {
                    id: 'road-secondary',
                    type: 'line',
                    source: 'pir',
                    'source-layer': 'transportation',
                    filter: ['in', 'class', 'secondary', 'tertiary'],
                    minzoom: 8,
                    paint: {
                        'line-color': '#808090',
                        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.3, 14, 2],
                    },
                },
                // Roads — minor
                {
                    id: 'road-minor',
                    type: 'line',
                    source: 'pir',
                    'source-layer': 'transportation',
                    filter: ['in', 'class', 'minor', 'service', 'path'],
                    minzoom: 10,
                    paint: {
                        'line-color': '#606070',
                        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.2, 14, 1],
                    },
                },
                // Boundaries
                {
                    id: 'boundary',
                    type: 'line',
                    source: 'pir',
                    'source-layer': 'boundary',
                    paint: {
                        'line-color': '#6a6a8e',
                        'line-width': 1,
                        'line-dasharray': [3, 2],
                    },
                },
            ],
        },
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-left');

    if (opts.onZoom) {
        map.on('zoomend', () => opts.onZoom(map.getZoom()));
        map.on('load', () => opts.onZoom(map.getZoom()));
    }
}
