import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStrictUrl,
  isMatchingSite,
  isEntryAllowed,
  resolveRedirectUrl,
  isValidRedirectTarget,
  normalizeUrl,
} from "../src/lib/url.js";
import {
  migrateDailyLimit,
  isWithinSchedule,
  determineUrlStatus,
  isDailyLimitExceeded,
} from "../src/lib/rules.js";

test("buildStrictUrl normalizes host, path, query order", () => {
  assert.equal(
    buildStrictUrl("https://WWW.Youtube.com/watch?v=1&list=2"),
    "youtube.com/watch?list=2&v=1",
  );
});

test("buildStrictUrl strips trailing dots and control chars", () => {
  assert.equal(buildStrictUrl("youtube.com."), "youtube.com/");
});

test("buildStrictUrl returns null for garbage input", () => {
  assert.equal(buildStrictUrl("%%%"), null);
});

test("isMatchingSite matches exact normalized site", () => {
  assert.equal(isMatchingSite("https://youtube.com/watch", "youtube.com/watch"), true);
  assert.equal(isMatchingSite("https://youtube.com/watch", "youtube.com/feed"), false);
});

test("isEntryAllowed exact mode matches only the exact path", () => {
  const entry = { fullUrl: "https://example.com/page", mode: "exact" };
  assert.equal(isEntryAllowed("https://example.com/page", entry), true);
  assert.equal(isEntryAllowed("https://example.com/other", entry), false);
  assert.equal(isEntryAllowed("https://www.example.com/page", entry), true);
});

test("isEntryAllowed domain mode covers sub-paths and sub-domains", () => {
  const entry = { fullUrl: "https://example.com/some/page", mode: "domain" };
  assert.equal(isEntryAllowed("https://example.com/", entry), true);
  assert.equal(isEntryAllowed("https://example.com/watch?v=1", entry), true);
  assert.equal(isEntryAllowed("https://www.example.com/x/y", entry), true);
  assert.equal(isEntryAllowed("https://m.example.com/app", entry), true);
});

test("isEntryAllowed domain mode ignores ports and rejects other domains", () => {
  const entry = { fullUrl: "https://example.com/", mode: "domain" };
  assert.equal(isEntryAllowed("https://example.com:8443/a", entry), true);
  assert.equal(isEntryAllowed("https://other.com/a", entry), false);
  assert.equal(isEntryAllowed("https://notexample.com/a", entry), false);
});

test("isEntryAllowed backward compatible: entries without mode are exact", () => {
  const entry = { fullUrl: "https://example.com/page" };
  assert.equal(isEntryAllowed("https://example.com/page", entry), true);
  assert.equal(isEntryAllowed("https://example.com/other", entry), false);
});

test("resolveRedirectUrl unwraps Google redirect links", () => {
  const target = "https://example.com/safe";
  const url = `https://www.google.com/url?q=${encodeURIComponent(target)}`;
  assert.equal(resolveRedirectUrl(url), target);
});

test("isValidRedirectTarget only accepts http/https", () => {
  assert.equal(isValidRedirectTarget("https://example.com"), true);
  assert.equal(isValidRedirectTarget("file:///etc/passwd"), false);
});

test("normalizeUrl adds https scheme", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
});

test("migrateDailyLimit converts legacy layout", () => {
  const today = new Date().toDateString();
  const migrated = migrateDailyLimit({
    enabled: true,
    minutes: 30,
    targetSites: ["youtube.com"],
    usedTodaySeconds: 120,
    lastReset: today,
  });
  assert.equal(migrated.enabled, true);
  assert.equal(migrated.sites["youtube.com"].minutes, 30);
  assert.equal(migrated.sites["youtube.com"].usedTodaySeconds, 120);
});

test("isDailyLimitExceeded when quota used up", () => {
  const today = new Date().toDateString();
  const dl = {
    enabled: true,
    sites: {
      "youtube.com": { minutes: 1, usedTodaySeconds: 61, lastReset: today },
    },
  };
  assert.equal(isDailyLimitExceeded(dl, "https://youtube.com/"), true);
  assert.equal(isDailyLimitExceeded(dl, "https://other.com/"), false);
});

test("isWithinSchedule allows when disabled or corrupted", () => {
  assert.equal(isWithinSchedule(null), true);
  assert.equal(isWithinSchedule({ enabled: true }), true);
  assert.equal(
    isWithinSchedule({ enabled: true, days: [true, true, true, true, true, true, true], startTime: "bad", endTime: "bad" }),
    true,
  );
});

test("determineUrlStatus: emergency lock blocks", () => {
  const res = determineUrlStatus("https://example.com/", {
    emergencyLock: true,
  });
  assert.deepEqual(res, { status: "blocked", reason: "emergency" });
});

test("determineUrlStatus: time tampering blocks", () => {
  const res = determineUrlStatus("https://example.com/", { timeTampered: true });
  assert.deepEqual(res, { status: "blocked", reason: "tampered" });
});

test("determineUrlStatus: whitelisted allowed", () => {
  const res = determineUrlStatus("https://example.com/", {
    whitelist: [{ fullUrl: "https://example.com/" }],
  });
  assert.equal(res.status, "allowed");
});

test("determineUrlStatus: whole-domain whitelist allows sub-links", () => {
  const res = determineUrlStatus("https://example.com/any/deep/path", {
    whitelist: [{ fullUrl: "https://example.com/", mode: "domain" }],
  });
  assert.equal(res.status, "allowed");
});

test("determineUrlStatus: default blocked", () => {
  const res = determineUrlStatus("https://example.com/", {
    whitelist: [],
    schedule: { enabled: false },
  });
  assert.deepEqual(res, { status: "blocked", reason: "default" });
});

test("determineUrlStatus: exceeded daily limit blocked with reason limit", () => {
  const today = new Date().toDateString();
  const res = determineUrlStatus("https://youtube.com", {
    whitelist: [],
    schedule: { enabled: false },
    dailyLimit: {
      enabled: true,
      sites: {
        "youtube.com": { minutes: 1, usedTodaySeconds: 60, lastReset: today },
      },
    },
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, "limit");
});