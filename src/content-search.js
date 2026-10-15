// Search-result filtering — runs on every page but exits immediately unless
// the page is a known search engine. Two layers, both read-only over the
// markup the engine itself rendered:
//
//  1. Blocked results are hidden instead of being left for the child to click
//     and hit the blocked page: the snippet already gives away the content,
//     and the click loop is frustrating.
//  2. When the parent turns on "only allowed sites", every result outside the
//     whitelist is hidden as well. The search stays live — the query travels
//     from the address bar to the engine — and this script never reads that
//     query: it sees links, not what was typed, and it stores nothing.
//
// It only *hides* markup. It never navigates, never injects policy, and
// re-reads the policy whenever it changes.

import { matchesBlocklist, shouldShowSearchResult } from "./lib/rules.js";

const SEARCH_HOSTS = [
  "bing.com",
  "duckduckgo.com",
  "search.brave.com",
  "www.ecosia.org",
  "yandex.com",
  "www.startpage.com",
  "search.marginalia.nu",
  "www.qwant.com",
];

// Result containers per engine. A container is hidden when any link inside it
// points at a blocked site.
const CONTAINER_SELECTORS = [
  "div.g", // Google
  "li.b_algo", // Bing
  "article[data-testid='result']", // DuckDuckGo
  "#links .result", // DuckDuckGo (classic)
  ".snippet", // Brave Search
  ".result", // Ecosia / Startpage
  ".serp-item", // Yandex
  ".w-gl__result", // Startpage
];

// Whitelist mode cannot lean on per-engine card lists — engines rename their
// markup constantly. Instead a stray link takes its nearest card with it, but
// the walk stops at any ancestor that still holds an allowed link, so a
// shared block (sidebar, "people also ask", the page chrome) never drags an
// allowed result down with it. Three levels is the card's normal depth.
const MAX_WALK_LEVELS = 3;

const RECHECK_DELAY_MS = 400;

// ─── Strict SafeSearch ──────────────────────────────────────────────────────
// The parent's switch lives here, not in the address bar: whether the results
// page was opened from the new tab, the omnibox or a link, it reloads once
// with the engine's strict parameter and then stops touching the URL. The
// sessionStorage counter keeps an engine that strips the parameter from
// turning into a reload loop.
const SAFE_SEARCH_RULES = [
  { match: (h) => h === "google.com" || h.endsWith(".google.com") || h.includes("google."), param: "safe", value: "active" },
  { match: (h) => h === "bing.com" || h.endsWith(".bing.com"), param: "adlt", value: "strict" },
  { match: (h) => h === "duckduckgo.com" || h.endsWith(".duckduckgo.com"), param: "kp", value: "1" },
];
const SAFE_SEARCH_TRIES_KEY = "fwm-safe-search-tries";

function applyStrictSafeSearch() {
  try {
    const host = location.hostname.toLowerCase();
    const rule = SAFE_SEARCH_RULES.find((r) => r.match(host));
    if (!rule) return;
    const url = new URL(location.href);
    if (url.searchParams.get(rule.param) === rule.value) return;

    let tries = 0;
    try {
      tries = Number(sessionStorage.getItem(SAFE_SEARCH_TRIES_KEY)) || 0;
    } catch {
      tries = 0; // storage denied: fall through to the one-shot replace
    }
    if (tries >= 2) return;
    try {
      sessionStorage.setItem(SAFE_SEARCH_TRIES_KEY, String(tries + 1));
    } catch {
      /* one shot it is */
    }
    url.searchParams.set(rule.param, rule.value);
    location.replace(url.toString());
  } catch {
    /* a URL we cannot rewrite is a page we leave alone */
  }
}

function isSearchPage() {
  const host = location.hostname.toLowerCase();
  if (host === "google.com" || host.endsWith(".google.com")) {
    return location.pathname.startsWith("/search") || location.pathname === "/url";
  }
  if (host.includes("google.")) {
    // Every country Google (google.de, google.co.uk, …) shares the layout.
    return location.pathname.startsWith("/search");
  }
  const bare = host.replace(/^www\./, "");
  return SEARCH_HOSTS.includes(bare) || SEARCH_HOSTS.includes(host);
}

function loadPolicy() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {
        blockedKeywords: [],
        whitelist: [],
        whitelistResultsOnly: false,
        safeSearchEnforced: false,
      },
      (data) =>
        resolve({
          blockedKeywords: Array.isArray(data.blockedKeywords) ? data.blockedKeywords : [],
          whitelist: Array.isArray(data.whitelist) ? data.whitelist : [],
          whitelistOnly: data.whitelistResultsOnly === true,
          safeSearch: data.safeSearchEnforced === true,
        }),
    );
  });
}

let policy = { blockedKeywords: [], whitelist: [], whitelistOnly: false };
let observer = null;
let hiddenCount = 0;
let pill = null;

function isActive() {
  return policy.blockedKeywords.length > 0 || policy.whitelistOnly;
}

function ensurePill() {
  if (pill && pill.isConnected) return pill;
  pill = document.createElement("div");
  pill.id = "fwm-search-pill";
  pill.setAttribute("aria-hidden", "true");
  pill.style.cssText =
    "position:fixed;inset-inline-start:16px;bottom:16px;z-index:2147483647;" +
    "padding:7px 14px;border-radius:999px;font:600 12px/1 system-ui,sans-serif;" +
    "background:rgba(17,24,39,.88);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.3);" +
    "pointer-events:none;user-select:none;";
  (document.body || document.documentElement).appendChild(pill);
  return pill;
}

function renderPill() {
  if (hiddenCount <= 0) return;
  const node = ensurePill();
  const lang = document.documentElement.lang === "ar" ? "ar" : "en";
  node.textContent =
    lang === "ar"
      ? `تم إخفاء ${hiddenCount} نتيجة بواسطة العائلة`
      : `${hiddenCount} result${hiddenCount === 1 ? "" : "s"} hidden by Family Monitor`;
  node.dir = lang === "ar" ? "rtl" : "ltr";
}

function hide(node) {
  if (node.hasAttribute("data-fwm-hidden")) return; // rescans must not recount
  node.setAttribute("data-fwm-hidden", "1");
  node.style.display = "none";
  hiddenCount += 1;
  renderPill();
}

// A rule that was turned off must bring its results back — not leave them
// hidden behind yesterday's decision.
function revealAll() {
  document.querySelectorAll("[data-fwm-hidden]").forEach((el) => {
    el.removeAttribute("data-fwm-hidden");
    el.style.display = "";
  });
  hiddenCount = 0;
  if (pill) pill.remove();
  pill = null;
}

function scan() {
  // Verdicts are memoised per scan: a card and its sitelinks share URLs, and
  // the walk below asks about the same href over and over.
  const verdicts = new Map();
  const shown = (href) => {
    if (!verdicts.has(href)) verdicts.set(href, shouldShowSearchResult(href, policy));
    return verdicts.get(href);
  };

  // Layer 1 — one blocked link poisons its whole card.
  if (policy.blockedKeywords.length > 0) {
    for (const selector of CONTAINER_SELECTORS) {
      let containers;
      try {
        containers = document.querySelectorAll(selector);
      } catch {
        continue; // never let one bad selector kill the page
      }
      containers.forEach((container) => {
        if (container.hasAttribute("data-fwm-hidden")) return;
        for (const link of container.querySelectorAll('a[href^="http"]')) {
          if (matchesBlocklist(link.href, policy.blockedKeywords)) {
            hide(container);
            return;
          }
        }
      });
    }
  }

  // Layer 2 — whitelist-only: every link that is not allowed disappears
  // together with the card around it, without touching blocks that still
  // contain something allowed.
  if (policy.whitelistOnly) {
    document.querySelectorAll('a[href^="http"]').forEach((anchor) => {
      if (anchor.hasAttribute("data-fwm-hidden")) return;
      if (shown(anchor.href)) return;

      let candidate = null;
      let node = anchor.parentElement;
      for (let level = 0; level < MAX_WALK_LEVELS && node && node !== document.body; level++) {
        if (node.hasAttribute("data-fwm-hidden")) return; // an ancestor already hides it
        const hasAllowed = Array.from(node.querySelectorAll('a[href^="http"]')).some((link) =>
          shown(link.href),
        );
        if (hasAllowed) break; // this block must stay
        candidate = node;
        node = node.parentElement;
      }
      if (candidate) hide(candidate);
      else hide(anchor); // no safe ancestor — at least the link itself goes
    });
  }
}

function debounce(fn, delay) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, delay);
  };
}

function observe() {
  if (observer) return;
  // Infinite scroll and "next page" replace results without a navigation.
  const rescan = debounce(scan, RECHECK_DELAY_MS);
  observer = new MutationObserver(rescan);
  observer.observe(document.body, { childList: true, subtree: true });
}

async function init() {
  if (!isSearchPage()) return;

  policy = await loadPolicy();

  // Enforce strict SafeSearch before anything else; a reload re-runs init
  // with the parameter already in place.
  if (policy.safeSearch) applyStrictSafeSearch();

  // Nothing to hide — do not observe or scan at all.
  if (!isActive()) return;

  scan();
  observe();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    let touched = false;
    if (changes.blockedKeywords) {
      const next = changes.blockedKeywords.newValue;
      policy.blockedKeywords = Array.isArray(next) ? next : [];
      touched = true;
    }
    if (changes.whitelist) {
      const next = changes.whitelist.newValue;
      policy.whitelist = Array.isArray(next) ? next : [];
      touched = true;
    }
    if (changes.whitelistResultsOnly) {
      policy.whitelistOnly = changes.whitelistResultsOnly.newValue === true;
      touched = true;
    }
    if (changes.safeSearchEnforced) {
      policy.safeSearch = changes.safeSearchEnforced.newValue === true;
      if (policy.safeSearch) {
        applyStrictSafeSearch(); // may reload; the fresh load re-scans
        return;
      }
      touched = true;
    }
    if (!touched) return;

    revealAll();
    if (!isActive()) {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      return;
    }
    scan();
    observe();
  });
}

init();
