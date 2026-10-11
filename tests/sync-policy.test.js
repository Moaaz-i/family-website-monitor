import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSyncedPayload, planApplySync } from "../src/lib/sync-policy.js";

const SYNCED_KEYS = [
  "whitelist",
  "blockedKeywords",
  "schedule",
  "dailyLimit",
  "notificationsEnabled",
  "screenTime",
];

const today = new Date().toDateString();

test("normalizeSyncedPayload publishes configuration, not counters", () => {
  const payload = normalizeSyncedPayload(
    {
      whitelist: [{ id: "a", fullUrl: "https://khanacademy.org", mode: "domain" }],
      blockedKeywords: ["youtube.com"],
      schedule: { enabled: false },
      dailyLimit: { enabled: true, sites: { "youtube.com": { minutes: 30, usedTodaySeconds: 900 } } },
      notificationsEnabled: true,
      screenTime: { enabled: true, minutes: 90, usedSeconds: 5400, lastReset: today },
      password: "pbkdf2$310000$deadbeef$cafe",
      pinHash: "pbkdf2$310000$deadbeef$cafe",
      sessionToken: "secret",
      activity: { "2026-10-11": {} },
    },
    SYNCED_KEYS,
  );

  assert.deepEqual(payload.screenTime, { enabled: true, minutes: 90 });
  assert.equal(payload.password, undefined);
  assert.equal(payload.pinHash, undefined);
  assert.equal(payload.sessionToken, undefined);
  assert.equal(payload.activity, undefined);
  assert.equal(payload.dailyLimit.sites["youtube.com"].usedTodaySeconds, 900);
  assert.equal(Object.keys(payload).length, 6);
});

test("normalizeSyncedPayload skips missing keys and normalises junk", () => {
  // Minutes that are not numbers become 0; a truthy flag becomes a boolean.
  const payload = normalizeSyncedPayload({ screenTime: { minutes: "bad", enabled: 1 } }, SYNCED_KEYS);
  assert.deepEqual(payload, { screenTime: { enabled: true, minutes: 0 } });

  // Not an object at all → the default (disabled, no budget).
  const junk = normalizeSyncedPayload({ screenTime: "nope" }, SYNCED_KEYS);
  assert.deepEqual(junk, { screenTime: { enabled: false, minutes: 0 } });

  assert.deepEqual(normalizeSyncedPayload({}, SYNCED_KEYS), {});
  assert.deepEqual(normalizeSyncedPayload({ whitelist: null }, SYNCED_KEYS), {});
});

test("planApplySync ignores the echo of our own push", () => {
  const decoded = { rev: 100, json: "{}", payload: { blockedKeywords: ["x.com"] } };
  assert.equal(planApplySync(decoded, 100, "{}", null), null);
});

test("planApplySync ignores a stale copy (no rollback)", () => {
  const decoded = { rev: 100, json: "{}", payload: { blockedKeywords: ["x.com"] } };
  // The device already accepted revision 200 from the other device.
  assert.equal(planApplySync(decoded, 200, null, null), null);
  // An equal revision is an echo, not an update.
  assert.equal(planApplySync(decoded, 100, "other json", null), null);
  // Malformed copies are refused outright.
  assert.equal(planApplySync(null, 0, null, null), null);
  assert.equal(planApplySync({ rev: "900", json: "{}", payload: {} }, 0, null, null), null);
});

test("planApplySync accepts a newer copy and keeps this device's counters", () => {
  const local = { enabled: true, minutes: 45, usedSeconds: 1200, lastReset: today };
  const decoded = {
    rev: 300,
    json: "{}",
    payload: {
      blockedKeywords: ["youtube.com"],
      screenTime: { enabled: true, minutes: 120 },
    },
  };

  const payload = planApplySync(decoded, 200, null, local);
  assert.ok(payload);
  assert.deepEqual(payload.blockedKeywords, ["youtube.com"]);
  // Configuration comes from the other device…
  assert.equal(payload.screenTime.minutes, 120);
  // …but today's usage stays here.
  assert.equal(payload.screenTime.usedSeconds, 1200);
  assert.equal(payload.screenTime.lastReset, today);
});

test("a payload without screen time is applied untouched", () => {
  const payload = planApplySync(
    { rev: 2, json: "{}", payload: { whitelist: [] } },
    1,
    null,
    { enabled: true, minutes: 30, usedSeconds: 60, lastReset: today },
  );
  assert.deepEqual(payload, { whitelist: [] });
});
