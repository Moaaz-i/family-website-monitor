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

/** The allowed sites, deduplicated by host and sorted — shared by the grid
 *  and by the search box's suggestions. */
function buildSites(entries) {
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
    links.push({ url, host, label: host.toLowerCase() });
  });
  return links.sort((a, b) => a.host.localeCompare(b.host));
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
  const noMatch = document.getElementById("newtabNoMatch");

  let siteLinks = buildSites([]);

  function renderTiles(links) {
    if (!tiles) return;
    tiles.textContent = "";

    const visible = links.slice(0, 12);
    if (empty) empty.hidden = siteLinks.length > 0;
    if (noMatch) noMatch.hidden = !(siteLinks.length > 0 && visible.length === 0);

    visible.forEach(({ url, host }) => {
      const link = document.createElement("a");
      link.className = "newtab-tile";
      link.href = url;
      link.textContent = host;
      tiles.appendChild(link);
    });
  }

  function applyFilter() {
    const query = (input ? input.value : "").trim().toLowerCase();
    const filtered = query
      ? siteLinks.filter((site) => site.label.includes(query))
      : siteLinks;
    renderTiles(filtered);
  }

  function loadTiles() {
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      siteLinks = buildSites(data.whitelist);
      applyFilter();
      renderSuggestions();
    });
  }

  // A parent adding a site while this tab is open should show up without a
  // reload — the list is the whole point of the page.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.whitelist) loadTiles();
  });

  // ── Search bar ──────────────────────────────────────────────────────────
  // Enter searches the web. Typing lists the allowed sites that match —
  // the safe destination is offered before the open web — and ↑/↓ picks one.
  const form = document.getElementById("newtabSearch");
  const input = document.getElementById("newtabSearchInput");
  const suggestionList = document.getElementById("newtabSuggestions");


  let matches = [];
  let activeIndex = -1;

  function hideSuggestions() {
    if (!suggestionList) return;
    suggestionList.hidden = true;
    suggestionList.textContent = "";
    if (input) input.setAttribute("aria-expanded", "false");
    matches = [];
    activeIndex = -1;
  }

  function renderSuggestions() {
    if (!suggestionList || !input) return;
    const query = input.value.trim().toLowerCase();
    if (!query) return hideSuggestions();

    matches = siteLinks.filter((site) => site.label.includes(query)).slice(0, 6);
    if (matches.length === 0) return hideSuggestions();

    suggestionList.textContent = "";
    activeIndex = -1;
    matches.forEach((site, index) => {
      const item = document.createElement("li");
      item.className = "newtab-suggestion";
      item.setAttribute("role", "option");
      item.id = `newtabSuggestion${index}`;
      item.dataset.url = site.url;

      const icon = document.createElement("span");
      icon.className = "newtab-suggestion-glyph";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = site.host.charAt(0).toUpperCase();

      const label = document.createElement("span");
      label.className = "newtab-suggestion-host";
      label.textContent = site.host;

      const hint = document.createElement("small");
      hint.className = "newtab-suggestion-hint";
      hint.textContent = t("newtabSearchOpenHint");

      item.append(icon, label, hint);
      item.addEventListener("click", () => navigate(site.url));
      suggestionList.appendChild(item);
    });

    suggestionList.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function setActive(index) {
    const items = suggestionList ? suggestionList.children : [];
    if (!items.length) return;
    activeIndex = (index + items.length) % items.length;
    Array.from(items).forEach((item, i) => {
      const active = i === activeIndex;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
      if (active) item.scrollIntoView({ block: "nearest" });
    });
    input.setAttribute("aria-activedescendant", items[activeIndex].id);
  }

  function navigate(url) {
    if (isValidRedirectTarget(url)) location.href = url;
  }

  if (form && input) {
    input.setAttribute("aria-expanded", "false");

    input.addEventListener("input", () => {
      applyFilter();
      renderSuggestions();
    });

    // The native clear button on type="search" must refresh both lists too.
    input.addEventListener("search", () => {
      applyFilter();
      renderSuggestions();
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && matches.length) {
        event.preventDefault();
        setActive(activeIndex + 1);
      } else if (event.key === "ArrowUp" && matches.length) {
        event.preventDefault();
        setActive(activeIndex - 1);
      } else if (event.key === "Escape") {
        hideSuggestions();
      }
    });

    // Keep focus in the field while a suggestion is clicked: a blur first
    // would hide the list before the click lands.
    if (suggestionList) {
      suggestionList.addEventListener("mousedown", (event) => event.preventDefault());
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (activeIndex >= 0 && matches[activeIndex]) {
        return navigate(matches[activeIndex].url);
      }
      const query = input.value.trim();
      if (!query) return;
      hideSuggestions();
      // A pasted address goes straight there; anything else is a web search.
      if (/^https?:\/\//i.test(query)) return navigate(query);
      // Read the parent's choice now, not at page load: a tab opened before
      // the switch was flipped must still obey it. The filter hides what is
      // not allowed; strict SafeSearch trims what is left.
      chrome.storage.local.get({ whitelistResultsOnly: false }, (data) => {
        const safe = data.whitelistResultsOnly === true ? "&safe=active" : "";
        navigate(`https://www.google.com/search?q=${encodeURIComponent(query)}${safe}`);
      });
    });

    document.addEventListener("click", (event) => {
      if (form.contains(event.target)) return;
      if (suggestionList && suggestionList.contains(event.target)) return;
      hideSuggestions();
    });
  }

  loadTiles();
});
