import test from "node:test";
import assert from "node:assert/strict";

import {
  encodePolicy,
  decodePolicy,
  stableStringify,
  chunkKey,
  SYNC_MAX_CHUNKS,
} from "../src/lib/sync-codec.js";

const policy = {
  whitelist: Array.from({ length: 400 }, (_, i) => ({
    fullUrl: `https://site-${i}.example.com/some/deep/path?x=${i}`,
    mode: i % 2 ? "domain" : "exact",
  })),
  blockedKeywords: ["youtube.com", "tiktok.com", "roblox.com"],
  schedule: { enabled: true, days: [true, false, true, false, true, false, true], startTime: "07:00", endTime: "20:00" },
  dailyLimit: { enabled: true, sites: { "youtube.com": { minutes: 60, usedTodaySeconds: 0, lastReset: "x" } } },
};

test("encode/decode round-trips a policy larger than one item", () => {
  const enc = encodePolicy(policy, 123456);
  assert.ok(enc, "policy must fit the sync quota");
  assert.ok(enc.meta.chunks > 1, "a 400-entry whitelist must be split");
  assert.ok(enc.chunks.every((c) => c.length <= 6000), "each chunk stays under the item limit");

  const dec = decodePolicy(enc.meta, enc.chunks);
  assert.ok(dec);
  assert.equal(dec.rev, 123456);
  assert.deepEqual(dec.payload, policy);
});

test("decodePolicy survives extra stale chunks beyond meta.chunks", () => {
  const enc = encodePolicy(policy, 1);
  const withStale = [...enc.chunks, "leftover-from-a-larger-previous-write"];
  const dec = decodePolicy(enc.meta, withStale);
  assert.deepEqual(dec.payload, policy);
});

test("decodePolicy rejects truncated or missing chunks", () => {
  const enc = encodePolicy(policy, 7);
  assert.equal(decodePolicy(enc.meta, enc.chunks.slice(0, enc.chunks.length - 1)), null);
  assert.equal(decodePolicy(enc.meta, []), null);
  assert.equal(decodePolicy(null, enc.chunks), null);
  assert.equal(decodePolicy({ rev: 1, chunks: 0 }, []), null);
});

test("decodePolicy rejects corrupted data instead of throwing", () => {
  const enc = encodePolicy(policy, 1);
  const broken = [...enc.chunks];
  broken[0] = "{invalid json";
  assert.equal(decodePolicy(enc.meta, broken), null);
  assert.equal(decodePolicy(enc.meta, [123, 456]), null);
  assert.equal(decodePolicy(enc.meta, [undefined]), null);
});

test("encodePolicy refuses payloads that would exceed the quota", () => {
  const huge = { whitelist: Array.from({ length: 5000 }, (_, i) => ({ fullUrl: `https://site-${i}.example.com/very/long/path/${i}` })) };
  assert.equal(encodePolicy(huge, 1), null);
  assert.ok(SYNC_MAX_CHUNKS > 0);
});

test("encodePolicy survives non-serialisable payloads", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(encodePolicy(cyclic, 1), null);
});

test("chunkKey is stable and index-scoped", () => {
  assert.equal(chunkKey(0), "policySyncChunk0");
  assert.equal(chunkKey(12), "policySyncChunk12");
  assert.notEqual(chunkKey(1), chunkKey(10));
});

test("stableStringify ignores key order but keeps values", () => {
  assert.equal(stableStringify({ a: 1, b: [2, { c: 3, d: 4 }] }), stableStringify({ b: [2, { d: 4, c: 3 }], a: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});
