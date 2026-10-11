import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStrictUrl,
  isMatchingSite,
  isEntryAllowed,
  isEnforceableUrl,
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

test("isEnforceableUrl judges only real destinations", () => {
  // Real sites: always judged.
  assert.equal(isEnforceableUrl("https://example.com"), true);
  assert.equal(isEnforceableUrl("http://example.com/watch?v=1"), true);
  // A local file opened in a tab is still refused by the whitelist.
  assert.equal(isEnforceableUrl("file:///etc/passwd"), true);

  // Empty or parent-owned boxes: the page that creates them was checked
  // already. This is the bug that bounced every allowed site to
  // blocked.html?target=about:blank&reason=default the moment it created a
  // lazy embed.
  assert.equal(isEnforceableUrl("about:blank"), false);
  assert.equal(isEnforceableUrl("about:srcdoc"), false);
  assert.equal(isEnforceableUrl("blob:https://example.com/uuid-1"), false);

  // Opaque or internal schemes: no whitelist can apply to them, and any
  // http(s) navigation inside a data: frame still reaches the handlers.
  assert.equal(isEnforceableUrl("data:text/html,<h1>hi</h1>"), false);
  assert.equal(isEnforceableUrl("javascript:alert(1)"), false);
  assert.equal(isEnforceableUrl("view-source:https://example.com"), false);
  assert.equal(isEnforceableUrl("chrome://extensions"), false);
  assert.equal(isEnforceableUrl("chrome-extension://abc/options.html"), false);
  assert.equal(isEnforceableUrl("devtools://devtools/b.html"), false);

  // Nothing to judge.
  assert.equal(isEnforceableUrl(""), false);
  assert.equal(isEnforceableUrl(null), false);
  assert.equal(isEnforceableUrl(undefined), false);
  assert.equal(isEnforceableUrl("not a url"), false);
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

// Regression: the limit used to match the *full* URL, so "youtube.com" never
// matched "youtube.com/watch?v=…" — the core feature did nothing on real pages.
test("determineUrlStatus: daily limit applies to any URL of the site", () => {
  const today = new Date().toDateString();
  const dailyLimit = {
    enabled: true,
    sites: {
      "youtube.com": { minutes: 1, usedTodaySeconds: 60, lastReset: today },
    },
  };
  for (const url of [
    "https://www.youtube.com/watch?v=abc",
    "https://m.youtube.com/feed",
    "https://youtube.com/",
    "youtube.com",
  ]) {
    const res = determineUrlStatus(url, { whitelist: [], schedule: { enabled: false }, dailyLimit });
    assert.equal(res.reason, "limit", `${url} should hit its limit`);
  }
  // …and never another site's limit.
  const other = determineUrlStatus("https://example.com/x", {
    whitelist: [],
    schedule: { enabled: false },
    dailyLimit,
  });
  assert.equal(other.reason, "default");
});

test("determineUrlStatus: a fresh daily limit leaves the site open", () => {
  const res = determineUrlStatus("https://www.youtube.com/watch?v=abc", {
    whitelist: [],
    schedule: { enabled: false },
    dailyLimit: {
      enabled: true,
      sites: {
        "youtube.com": { minutes: 60, usedTodaySeconds: 0, lastReset: new Date().toDateString() },
      },
    },
  });
  assert.equal(res.status, "allowed");
});

// Regression: a temporary allowance used to require the exact same path, so
// "allow 15 minutes" only unblocked the single URL that was open.
test("determineUrlStatus: temporary allowance covers the whole site", () => {
  const until = Date.now() + 60000;
  const base = { whitelist: [], schedule: { enabled: false }, tempAllowed: { "https://youtube.com/": until } };
  assert.equal(determineUrlStatus("https://www.youtube.com/watch?v=other", base).status, "allowed");
  assert.equal(determineUrlStatus("https://m.youtube.com/feed", base).status, "allowed");
  assert.equal(determineUrlStatus("https://evil.com/", base).status, "blocked");
});