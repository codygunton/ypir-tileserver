// Lightweight per-query event log for tile-packaging experiments.
//
// Records one row per resolved tile request. Panel shows aggregates
// over the session; CSV export dumps raw events for offline analysis.
//
// Event kinds: 'pir', 'http', 'cache-hit'. Wire sizes are set per mode:
//   PIR mode  -> { query_bytes, response_bytes } from /api/params
//   HTTP mode -> { 0, tile_size }                from /api/tile-mapping

const events = [];
let wireSizes = { query_bytes: 0, response_bytes: 0 };
let mode = 'pir';

export function setMode(m) {
  mode = m;
}

export function setWireSizes({ query_bytes, response_bytes }) {
  wireSizes = { query_bytes, response_bytes };
}

export function recordQuery(ev) {
  events.push({
    t: Date.now(),
    mode,
    ...ev,
  });
}

export function stats() {
  const fetchEvents = events.filter(e => e.kind === 'pir' || e.kind === 'http');
  const hits = events.filter(e => e.kind === 'cache-hit').length;
  const total = events.length;
  const fetchCount = fetchEvents.length;

  const latencies = fetchEvents
    .filter(e => typeof e.latency_ms === 'number')
    .map(e => e.latency_ms)
    .sort((a, b) => a - b);
  const avg = latencies.length
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : 0;
  const pct = (p) =>
    latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : 0;

  const slotsTotal = fetchEvents.reduce((s, e) => s + (e.slots || 0), 0);
  const bytesUp = slotsTotal * wireSizes.query_bytes;
  const bytesDown = slotsTotal * wireSizes.response_bytes;
  const bytesDecoded = fetchEvents.reduce((s, e) => s + (e.bytes_decoded || 0), 0);

  return {
    mode,
    total,
    fetches: fetchCount,
    cacheHits: hits,
    hitRate: total ? hits / total : 0,
    avgMs: avg,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    slotsTotal,
    bytesUp,
    bytesDown,
    bytesDecoded,
  };
}

export function downloadCsv() {
  const cols = ['t', 'mode', 'kind', 'key', 'z', 'slots', 'latency_ms', 'bytes_decoded', 'error'];
  const lines = [cols.join(',')];
  for (const e of events) {
    lines.push(
      cols
        .map(c => {
          const v = e[c];
          if (v === undefined || v === null) return '';
          const s = String(v);
          return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    );
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ypir-measurements-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function clearEvents() {
  events.length = 0;
}

export function eventCount() {
  return events.length;
}

export function getEvents() {
  return events.slice();
}
