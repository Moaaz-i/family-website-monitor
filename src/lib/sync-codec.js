// Pure encode/decode for the cross-device policy mirror.
//
// chrome.storage.sync allows 8 KB per item and 100 KB in total, while a
// whitelist can easily be larger than that, so the policy document is split
// into fixed-size chunks. These two functions know nothing about Chrome —
// that is what makes them worth testing.

export const SYNC_META_KEY = "policySyncMeta";
export const SYNC_CHUNK_PREFIX = "policySyncChunk";
export const SYNC_CHUNK_SIZE = 6000; // comfortably under the 8 KB item limit
export const SYNC_MAX_CHUNKS = 15; // ~90 KB: leaves headroom under 100 KB

export function chunkKey(index) {
  return `${SYNC_CHUNK_PREFIX}${index}`;
}

/**
 * @param {object} payload policy document, e.g. { whitelist: [...], schedule: {...} }
 * @param {number} rev monotonic revision (Date.now() of the writer)
 * @returns {{ meta: { rev: number, chunks: number, bytes: number }, chunks: string[] } | null}
 *          null when the payload cannot fit into the sync quota.
 */
export function encodePolicy(payload, rev, chunkSize = SYNC_CHUNK_SIZE) {
  let json;
  try {
    json = JSON.stringify(payload);
  } catch {
    return null;
  }
  if (typeof json !== "string") return null;

  const chunks = [];
  for (let i = 0; i < json.length; i += chunkSize) {
    chunks.push(json.slice(i, i + chunkSize));
  }
  if (chunks.length === 0) chunks.push(json);
  if (chunks.length > SYNC_MAX_CHUNKS) return null;

  return {
    meta: { rev, chunks: chunks.length, bytes: json.length },
    chunks,
  };
}

/**
 * @param {{ rev: number, chunks: number }} meta
 * @param {string[]} chunkValues stored chunk strings, in index order
 * @returns {{ rev: number, json: string, payload: object } | null}
 */
export function decodePolicy(meta, chunkValues) {
  if (!meta || typeof meta.chunks !== "number" || meta.chunks <= 0) return null;
  if (!Array.isArray(chunkValues) || chunkValues.length < meta.chunks) return null;

  let json = "";
  for (let i = 0; i < meta.chunks; i++) {
    const part = chunkValues[i];
    if (typeof part !== "string") return null;
    json += part;
  }

  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  return { rev: Number(meta.rev) || 0, json, payload };
}

/** Stable JSON for equality checks: object keys sorted at every depth. */
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}
