// Search-result filtering — runs on every page but exits immediately unless
// the page is a known search engine. Blocked results are hidden instead of
// being left for the child to click and hit the blocked page: the snippet
// itself already gives away the content, and the click loop is frustrating.
//
// This script only *hides* markup. It never navigates, never injects policy,
// and re-reads the blocklist whenever it changes.

import { matchesBlocklist } from "./lib/rules.js";

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

const RECHECK_DELAY_MS = 400;

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

function loadKeywords() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ blockedKeywords: [] }, (data) => {
      resolve(Array.isArray(data.blockedKeywords) ? data.blockedKeywords : []);
    });
  });
}

let keywords = [];
let hiddenCount = 0;
let pill = null;

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

function scan() {
  if (keywords.length === 0) return;

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
        if (matchesBlocklist(link.href, keywords)) {
          container.setAttribute("data-fwm-hidden", "1");
          container.style.display = "none";
          hiddenCount += 1;
          renderPill();
          return;
        }
      }
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

async function init() {
  if (!isSearchPage()) return;

  keywords = await loadKeywords();
  // Nothing to hide — do not observe or scan at all.
  if (keywords.length === 0) return;

  scan();

  // Infinite scroll and "next page" replace results without a navigation.
  const rescan = debounce(scan, RECHECK_DELAY_MS);
  const observer = new MutationObserver(rescan);
  observer.observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.blockedKeywords) return;
    const next = changes.blockedKeywords.newValue;
    keywords = Array.isArray(next) ? next : [];
    if (keywords.length === 0) {
      // The parent unblocked everything: show the results again.
      document.querySelectorAll("[data-fwm-hidden]").forEach((el) => {
        el.removeAttribute("data-fwm-hidden");
        el.style.display = "";
      });
      hiddenCount = 0;
      if (pill) pill.remove();
      pill = null;
      observer.disconnect();
      return;
    }
    scan();
  });
}

init();
