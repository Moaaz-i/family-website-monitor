// YouTube keyword filtering — injected on YouTube only.
//
// The blocklist is URL-shaped, so on an allowed site like youtube.com it
// would still leave every video the parent means to hide sitting right there
// in the feed. This script applies the *keyword* half of the same list to
// what a card actually shows — its title — and hides matching cards, the
// same way the search filter hides matching results.
//
// It only hides markup: no navigation, no policy, nothing stored, and it
// re-reads the word list whenever the parent changes it. The main frame only
// — a YouTube embed inside another site is the embed guard's business.

import { matchesKeywordInText } from "./lib/rules.js";

const CARD_SELECTORS = [
  "ytd-rich-item-renderer", // home feed, subscriptions, shelf items
  "ytd-video-renderer", // search results
  "ytd-compact-video-renderer", // sidebar suggestions
  "ytd-grid-video-renderer", // older grid layouts
  "ytd-playlist-video-renderer", // playlist rows
  "ytd-reel-item-renderer", // shorts carousels
];

// The title, not the thumbnail: alt text and lazy attributes churn, while
// the link text is exactly what the child reads before clicking.
const TITLE_SELECTOR = "#video-title, h3 a";

const RECHECK_DELAY_MS = 400;

let keywords = [];
let observer = null;
let hiddenCount = 0;
let pill = null;

function loadKeywords() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ blockedKeywords: [] }, (data) => {
      resolve(Array.isArray(data.blockedKeywords) ? data.blockedKeywords : []);
    });
  });
}

function ensurePill() {
  if (pill && pill.isConnected) return pill;
  pill = document.createElement("div");
  pill.id = "fwm-yt-pill";
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
      ? `تم إخفاء ${hiddenCount} فيديو بواسطة العائلة`
      : `${hiddenCount} video${hiddenCount === 1 ? "" : "s"} hidden by Family Monitor`;
  node.dir = lang === "ar" ? "rtl" : "ltr";
}

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
  if (keywords.length === 0) return;
  // Titles repeat (search rows, sidebar, playlists) — decide once per text.
  const verdicts = new Map();

  for (const selector of CARD_SELECTORS) {
    let cards;
    try {
      cards = document.querySelectorAll(selector);
    } catch {
      continue; // never let one bad selector kill the page
    }
    for (const card of cards) {
      if (card.hasAttribute("data-fwm-hidden")) continue;
      const title = card.querySelector(TITLE_SELECTOR);
      if (!title) continue;

      const text = `${title.getAttribute("aria-label") || ""} ${title.textContent || ""}`;
      let visible = verdicts.get(text);
      if (visible === undefined) {
        visible = !matchesKeywordInText(text, keywords);
        verdicts.set(text, visible);
      }
      if (visible) continue;

      card.setAttribute("data-fwm-hidden", "1");
      card.style.display = "none";
      hiddenCount += 1;
      renderPill();
    }
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
  // The feed is one long document: every navigation mutates, never reloads.
  const rescan = debounce(scan, RECHECK_DELAY_MS);
  observer = new MutationObserver(rescan);
  observer.observe(document.body, { childList: true, subtree: true });
}

async function init() {
  if (location.hostname !== "www.youtube.com" && location.hostname !== "m.youtube.com") return;

  keywords = await loadKeywords();
  // No words — no observer, no scan: the page stays exactly as YouTube built it.
  if (keywords.length === 0) return;

  scan();
  observe();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.blockedKeywords) return;
    const next = changes.blockedKeywords.newValue;
    keywords = Array.isArray(next) ? next : [];

    revealAll();
    if (keywords.length === 0) {
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
