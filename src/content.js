// Content script — lightweight by design.
//
// Navigation enforcement does NOT happen here. The service worker already
// listens to webNavigation.onBeforeNavigate / onHistoryStateUpdated and
// tabs.onUpdated, so intercepting clicks with preventDefault() only broke
// Ctrl/Cmd+click, middle-click, target="_blank" and window.open().
//
// This file has exactly two jobs:
//   1. Beat once per second on EVERY page so the service worker can build the
//      activity report (time per host per day) — not only on limited sites.
//   2. Render the "time remaining" pill when the current page is limited.

function safeSendMessage(message, callback) {
  if (typeof chrome !== "undefined" && chrome && chrome.runtime && chrome.runtime.id) {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) return;
        if (callback) callback(response);
      });
    } catch {
      // Context invalidated during an extension reload — ignore.
    }
  }
}

(function () {
  const FOCUSED_BEAT_MS = 1000;
  const IDLE_BEAT_MS = 5000;

  let intervalId = null;
  let host = null;
  let hostRoot = null;

  const formatTime = (totalSeconds) => {
    const seconds = Math.max(0, totalSeconds);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  function buildPill() {
    const shadowHost = document.createElement("div");
    shadowHost.id = "family-website-monitor-timer";
    shadowHost.style.cssText =
      "position:fixed !important;bottom:20px !important;right:20px !important;z-index:2147483647 !important;";

    const root = shadowHost.attachShadow({ mode: "closed" });
    hostRoot = root;
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .pill {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 9px 16px;
          border-radius: 999px;
          background: rgba(17, 24, 39, 0.92);
          color: #fff;
          font: 600 14px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          border: 1px solid rgba(255, 255, 255, 0.14);
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
          user-select: none;
          direction: ltr;
          transition: opacity 0.2s ease;
        }
        .pill.idle { opacity: 0.45; }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #4ade80;
          box-shadow: 0 0 8px #4ade80;
        }
        .dot.warn { background: #fbbf24; box-shadow: 0 0 8px #fbbf24; }
        .dot.crit { background: #f87171; box-shadow: 0 0 8px #f87171; }
        .label { font-size: 10px; opacity: 0.72; }
      </style>
      <div class="pill" part="pill">
        <span class="dot"></span>
        <span class="time">00:00</span>
        <span class="label"></span>
      </div>
    `;
    return shadowHost;
  }

  function ensurePill() {
    if (host && host.isConnected) return;
    host = buildPill();
    (document.body || document.documentElement).appendChild(host);
  }

  function removePill() {
    if (host) host.remove();
    host = null;
    hostRoot = null;
  }

  function render(seconds, label, focused) {
    ensurePill();
    const root = hostRoot;
    if (!root) return;
    const pill = root.querySelector(".pill");
    const timeEl = root.querySelector(".time");
    const dot = root.querySelector(".dot");
    const labelEl = root.querySelector(".label");

    timeEl.textContent = formatTime(seconds);
    labelEl.textContent = label ? `(${label})` : "";
    pill.classList.toggle("idle", !focused);

    dot.classList.remove("warn", "crit");
    if (seconds < 60) dot.classList.add("crit");
    else if (seconds < 300) dot.classList.add("warn");
  }

  function isVisible() {
    return document.visibilityState === "visible";
  }

  function isFocused() {
    return isVisible() && document.hasFocus();
  }

  function beat() {
    const focused = isFocused();
    safeSendMessage({ type: "heartbeat", focused }, (response) => {
      if (!response) return;
      // The pill only exists on limited/temporarily-allowed pages.
      if (!response.isTarget && !response.tempSeconds) {
        removePill();
        return;
      }
      const active = pickActive(
        { isTarget: response.isTarget, remainingSeconds: response.remainingSeconds },
        {
          isTemp: response.tempSeconds > 0,
          remainingSeconds: response.tempSeconds,
        },
      );
      if (!active) {
        removePill();
        return;
      }
      render(active.seconds, active.label, response.focused !== false && focused);
    });
  }

  function pickActive(dl, temp) {
    if (dl.isTarget && temp.isTemp) {
      return temp.remainingSeconds < dl.remainingSeconds
        ? { seconds: temp.remainingSeconds, label: "temp" }
        : { seconds: dl.remainingSeconds, label: "daily" };
    }
    if (temp.isTemp) return { seconds: temp.remainingSeconds, label: "temp" };
    if (dl.isTarget) return { seconds: dl.remainingSeconds, label: "daily" };
    return null;
  }

  function schedule() {
    const period = isFocused() ? FOCUSED_BEAT_MS : IDLE_BEAT_MS;
    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(beat, period);
  }

  function start() {
    if (!intervalId) schedule();
    beat();
  }

  // Hidden tab: send one last unfocused beat so the service worker resets its
  // clock, then go fully silent — a background tab would only waste messages.
  function suspend() {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    safeSendMessage({ type: "heartbeat", focused: false });
    removePill();
  }

  function init() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", init, { once: true });
      return;
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") suspend();
      else start();
    });

    // The window can lose focus while the page stays visible; slow the beat
    // down and tell the worker to stop accruing seconds.
    window.addEventListener("blur", () => {
      if (!isVisible()) return;
      schedule();
      safeSendMessage({ type: "heartbeat", focused: false });
    });
    window.addEventListener("focus", () => {
      if (!isVisible()) return;
      schedule();
      beat();
    });

    start();
  }

  init();
})();
