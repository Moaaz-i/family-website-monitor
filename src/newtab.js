import { isValidRedirectTarget } from "./lib/url.js";
import { applyThemeClass } from "./lib/ui.js";
import { t, onTranslationReady, initTranslations } from "./lib/translator.js";

// Every extension page carries this guard: an extension page must never be
// embedded in a third-party frame.
if (window.self !== window.top) {
  document.body.style.display = "none";
  throw new Error("Embedding this page is forbidden for security reasons.");
}

applyThemeClass();
initTranslations();

// Compact "2h 5m" / "45s" label.
function formatClock(totalSeconds) {
  const total = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function entryToUrl(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.fullUrl === "string") return entry.fullUrl;
  if (entry && typeof entry.domain === "string") return `https://${entry.domain}`;
  return null;
}

onTranslationReady(() => {
  const clock = document.getElementById("newtabClock");
  const dateEl = document.getElementById("newtabDate");
  const statusEl = document.getElementById("newtabStatus");

  // ── Clock ────────────────────────────────────────────────────────────────
  function tick() {
    const now = new Date();
    if (clock) {
      clock.textContent = now.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
    }
  }
  tick();
  setInterval(tick, 15000);

  // ── Status line: only what is left, never the rules themselves ──────────
  // The worker answers this — the page never reads policy keys.
  chrome.runtime.sendMessage({ type: "checkTimeStatus" }, (res) => {
    if (!statusEl) return;
    if (chrome.runtime.lastError || !res) return;
    const screen = res.screen || {};
    if (!screen.enabled) {
      statusEl.textContent = t("newtabStatusActive");
      return;
    }
    statusEl.textContent = screen.exhausted
      ? t("newtabExhausted")
      : t("newtabTimeLeft", formatClock(screen.remainingSeconds));
  });

  // ── Allowed sites ───────────────────────────────────────────────────────
  const tiles = document.getElementById("newtabTiles");
  const empty = document.getElementById("newtabEmpty");

  function renderTiles(entries) {
    if (!tiles) return;
    tiles.textContent = "";

    const seen = new Set();
    const links = [];
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      const url = entryToUrl(entry);
      if (!url || !isValidRedirectTarget(url)) return;
      let host = url;
      try {
        host = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        // Leave the raw string; it is only a label.
      }
      if (!host || seen.has(host)) return;
      seen.add(host);
      links.push({ url, host });
    });

    if (empty) empty.hidden = links.length > 0;
    if (links.length === 0) return;

    links
      .sort((a, b) => a.host.localeCompare(b.host))
      .slice(0, 12)
      .forEach(({ url, host }) => {
        const link = document.createElement("a");
        link.className = "newtab-tile";
        link.href = url;
        link.textContent = host;
        tiles.appendChild(link);
      });
  }

  function loadTiles() {
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      renderTiles(data.whitelist);
    });
  }

  loadTiles();

  // A parent adding a site while this tab is open should show up without a
  // reload — the list is the whole point of the page.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.whitelist) loadTiles();
  });
});
