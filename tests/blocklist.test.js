import test from "node:test";
import assert from "node:assert/strict";

import { matchesBlocklist, determineUrlStatus } from "../src/lib/rules.js";
import { mergeIntoKeywords, BLOCK_PRESETS, SAFE_PRESETS } from "../src/lib/presets.js";

// ─── matchesBlocklist ────────────────────────────────────────────────────────
test("matchesBlocklist: empty or malformed list never blocks", () => {
  assert.equal(matchesBlocklist("https://youtube.com/", []), false);
  assert.equal(matchesBlocklist("https://youtube.com/", null), false);
  assert.equal(matchesBlocklist("https://youtube.com/", "youtube.com"), false);
  assert.equal(matchesBlocklist("", ["youtube.com"]), false);
  assert.equal(matchesBlocklist("https://youtube.com/", ["", "  ", "!!"]), false);
});

test("matchesBlocklist: domain entry covers the domain and subdomains", () => {
  const list = ["youtube.com"];
  assert.equal(matchesBlocklist("https://youtube.com/watch", list), true);
  assert.equal(matchesBlocklist("https://music.youtube.com/", list), true);
  assert.equal(matchesBlocklist("https://www.youtube.com/feed", list), true);
});

test("matchesBlocklist: domain entry does not match look-alike hosts", () => {
  const list = ["youtube.com"];
  assert.equal(matchesBlocklist("https://notyoutube.com/", list), false);
  assert.equal(matchesBlocklist("https://youtube.com.evil.net/", list), false);
  assert.equal(matchesBlocklist("https://example.com/watch", list), false);
});

test("matchesBlocklist: a short domain does not swallow look-alike hosts", () => {
  // "x.com" used to substring-match every URL containing "x.com".
  assert.equal(matchesBlocklist("https://fox.com/", ["x.com"]), false);
  assert.equal(matchesBlocklist("https://max.com/", ["x.com"]), false);
  assert.equal(matchesBlocklist("https://x.com/", ["x.com"]), true);
  assert.equal(matchesBlocklist("https://cdn.x.com/", ["x.com"]), true);
});

test("matchesBlocklist: entry is normalized like a URL", () => {
  assert.equal(matchesBlocklist("https://youtube.com/", ["https://www.YouTube.com/"]), true);
  assert.equal(matchesBlocklist("https://youtube.com/", ["  youtube.com  "]), true);
});

test("matchesBlocklist: a keyword of 3+ characters matches anywhere in the URL", () => {
  assert.equal(matchesBlocklist("https://example.com/games/minecraft-guide", ["minecraft"]), true);
  assert.equal(matchesBlocklist("https://example.com/games/sudoku", ["minecraft"]), false);
});

test("matchesBlocklist: a 1-2 character token only matches the host exactly", () => {
  assert.equal(matchesBlocklist("https://ab.com/page", ["ab"]), true);
  assert.equal(matchesBlocklist("https://example.com/ab", ["ab"]), false);
});

test("matchesBlocklist: Arabic keywords are matched", () => {
  assert.equal(matchesBlocklist("https://example.com/ألعاب", ["ألعاب"]), true);
  assert.equal(matchesBlocklist("https://example.com/رياضة", ["ألعاب"]), false);
});

test("matchesBlocklist: a blocked path keyword still blocks behind a redirector", () => {
  const target = "https://example.com/minecraft";
  const googleLink = `https://www.google.com/url?q=${encodeURIComponent(target)}`;
  assert.equal(matchesBlocklist(googleLink, ["minecraft"]), true);
});

// ─── determineUrlStatus precedence ───────────────────────────────────────────
test("determineUrlStatus: blocklist reason wins over an empty whitelist", () => {
  const res = determineUrlStatus("https://youtube.com/watch", {
    blockedKeywords: ["youtube.com"],
    whitelist: [],
    schedule: { enabled: false },
  });
  assert.deepEqual(res, { status: "blocked", reason: "blocklist" });
});

test("determineUrlStatus: blocklist outranks the whitelist", () => {
  const res = determineUrlStatus("https://youtube.com/watch", {
    blockedKeywords: ["youtube.com"],
    whitelist: [{ fullUrl: "https://youtube.com/", mode: "domain" }],
  });
  assert.deepEqual(res, { status: "blocked", reason: "blocklist" });
});

test("determineUrlStatus: blocklist outranks a still-valid temporary allowance", () => {
  const res = determineUrlStatus("https://youtube.com/watch", {
    blockedKeywords: ["youtube.com"],
    // Exact key, so the temporary allowance genuinely matches the URL and
    // only the rule order can decide the outcome.
    tempAllowed: { "https://youtube.com": Date.now() + 60000 },
    whitelist: [],
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, "blocklist");
});

test("determineUrlStatus: schedule blocks with reason schedule", () => {
  const res = determineUrlStatus("https://example.com/", {
    whitelist: [],
    schedule: { enabled: true, days: [false, false, false, false, false, false, false] },
  });
  assert.deepEqual(res, { status: "blocked", reason: "schedule" });
});

test("determineUrlStatus: temporary allowance wins over the default block", () => {
  const res = determineUrlStatus("https://example.com/", {
    whitelist: [],
    tempAllowed: { "https://example.com/": Date.now() + 60000 },
  });
  assert.equal(res.status, "allowed");
});

// ─── One-click packs ─────────────────────────────────────────────────────────
test("presets: packs are non-empty and hold lowercase domains", () => {
  for (const preset of [...BLOCK_PRESETS, ...SAFE_PRESETS]) {
    assert.ok(preset.id && preset.labelKey, "preset needs id and labelKey");
    assert.ok(Array.isArray(preset.domains) && preset.domains.length > 0);
    for (const domain of preset.domains) {
      assert.equal(domain, domain.toLowerCase().trim());
      assert.ok(!domain.includes("://"), "domains must not carry a scheme");
    }
  }
});

test("presets: a safe pack can be added to a whitelist as whole domains", () => {
  for (const preset of SAFE_PRESETS) {
    for (const domain of preset.domains) {
      const res = determineUrlStatus(`https://${domain}/anything`, {
        blockedKeywords: [],
        whitelist: [{ fullUrl: `https://${domain}`, mode: "domain" }],
      });
      assert.equal(res.status, "allowed", `${domain} should be allowed`);
    }
  }
});

test("presets: a block pack really blocks every domain it lists", () => {
  for (const preset of BLOCK_PRESETS) {
    for (const domain of preset.domains) {
      const res = determineUrlStatus(`https://${domain}/x`, {
        blockedKeywords: preset.domains,
        whitelist: [{ fullUrl: `https://${domain}`, mode: "domain" }],
      });
      assert.equal(res.status, "blocked", `${domain} should be blocked`);
      assert.equal(res.reason, "blocklist");
    }
  }
});

test("mergeIntoKeywords adds only new entries", () => {
  const first = mergeIntoKeywords([], ["a.com", "b.com"]);
  assert.equal(first.changed, true);
  assert.deepEqual([...first.list].sort(), ["a.com", "b.com"]);

  const second = mergeIntoKeywords(first.list, ["B.com", "c.com"]);
  assert.equal(second.changed, true);
  assert.deepEqual([...second.list].sort(), ["a.com", "b.com", "c.com"]);

  const third = mergeIntoKeywords(second.list, ["a.com"]);
  assert.equal(third.changed, false);
  assert.equal(third.list, second.list);
});
