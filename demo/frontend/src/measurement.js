// Lightweight per-query event log for tile-packaging experiments.
//
// Records one row per resolved tile request. Panel shows aggregates
// over the session; CSV export dumps raw events for offline analysis.

const events = [];
let wireSizes = { query_bytes: 0, response_bytes: 0 };

export function setWireSizes({ query_bytes, response_bytes }) {
  wireSizes = { query_bytes, response_bytes };
}

export function recordQuery(ev) {
  events.push({
    t: Date.now(),
    ...ev,
  });
}

export function stats() {
  const pirEvents = events.filter(e => e.kind === 'pir');
  const hits = events.filter(e => e.kind === 'cache-hit').length;
  const total = events.length;
  const pirCount = pirEvents.length;

  const latencies = pirEvents.map(e => e.latency_ms).sort((a, b) => a - b);
  const avg = latencies.length
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : 0;
  const pct = (p) =>
    latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : 0;

  const slotsTotal = pirEvents.reduce((s, e) => s + (e.slots || 0), 0);
  const bytesUp = slotsTotal * wireSizes.query_bytes;
  const bytesDown = slotsTotal * wireSizes.response_bytes;

  return {
    total,
    pir: pirCount,
    cacheHits: hits,
    hitRate: total ? hits / total : 0,
    avgMs: avg,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    slotsTotal,
    bytesUp,
    bytesDown,
  };
}

export function downloadCsv() {
  const cols = ['t', 'kind', 'key', 'z', 'slots', 'latency_ms', 'decode_ms', 'error'];
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
  a.download = `ypir-measurements-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
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
