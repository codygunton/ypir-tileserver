// pir-map-shared/frontend/tile-decoder.js
// Decodes a 20480-byte PIR slot: [u32 data_len LE][gzip PBF data][zero padding]
// Returns Uint8Array of raw gzip bytes (empty if tile is missing/corrupt).
// Uses global `pako` for decompression.
export function decodeSlotToGzip(slotBytes) {
    if (slotBytes.length < 4) return new Uint8Array(0);
    const len = slotBytes[0] | (slotBytes[1] << 8) | (slotBytes[2] << 16) | (slotBytes[3] << 24);
    if (len <= 0 || len + 4 > slotBytes.length) return new Uint8Array(0);
    return slotBytes.subarray(4, 4 + len);
}

// Decodes a PIR slot all the way to a PBF ArrayBuffer. Returns empty ArrayBuffer on error.
export function decodeSlotToPBF(slotBytes) {
    const gzip = decodeSlotToGzip(slotBytes);
    if (gzip.length === 0) return new ArrayBuffer(0);
    try { return pako.inflate(gzip).buffer; }
    catch { return new ArrayBuffer(0); }
}

// For multi-slot tiles: concatenate multiple decrypted slot Uint8Arrays before calling this.
export function decodeMultiSlotToPBF(parts) {
    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const combined = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) { combined.set(p, off); off += p.length; }
    return decodeSlotToPBF(combined);
}

// For bundled tiles: the slot contains several gzip blobs concatenated
// (no per-tile length prefix). Mapping tells us (offset, length) of this
// tile's gzip bytes inside the slot. Slice and inflate directly.
export function decodeBundledToPBF(slotBytes, offset, length) {
    if (length <= 0 || offset + length > slotBytes.length) return new ArrayBuffer(0);
    try { return pako.inflate(slotBytes.subarray(offset, offset + length)).buffer; }
    catch { return new ArrayBuffer(0); }
}
