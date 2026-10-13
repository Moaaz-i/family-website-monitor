// Runs in every http(s) frame, at document_start.
//
// The rules follow the current path: the extension never redirects a tab
// because of something a page *embeds*. What it does instead is empty the
// embed itself — the page the parent allowed keeps loading, and only the
// blocked frame becomes a small "blocked" marker. That is the difference
// between stopping a site (wrong) and stopping a file it pulls in (right).
//
// Main frames are skipped on purpose: the background judges them the moment
// they navigate, and that is where the address bar is decided.

(function () {
  "use strict";

  const MARKER_CSS = [
    "html,body{margin:0!important;padding:0!important;height:100%!important;overflow:hidden!important;background:#f8fafc!important}",
    "body{display:flex!important;align-items:center!important;justify-content:center!important;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif!important}",
    ".fwm-embed{display:flex!important;flex-direction:column;align-items:center;gap:3px;padding:8px;text-align:center}",
    ".fwm-embed svg{width:22px;height:22px;color:#94a3b8}",
    ".fwm-embed strong{font-size:12px;font-weight:700;color:#475569}",
    ".fwm-embed small{font-size:10px;color:#94a3b8}",
    "@media (prefers-color-scheme:dark){html,body{background:#0f172a!important}",
    ".fwm-embed strong{color:#cbd5e1}.fwm-embed small{color:#64748b}.fwm-embed svg{color:#64748b}}",
  ].join("");

  const SHIELD_SVG =
    '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
    '<path d="M24 4 8 10v12c0 10.5 6.9 18.9 16 22 9.1-3.1 16-11.5 16-22V10L24 4Z"' +
    ' fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/>' +
    '<path d="M17 24h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>' +
    "</svg>";

  if (window.self === window.top) return;
  if (!/^https?:$/i.test(location.protocol)) return;

  chrome.runtime.sendMessage(
    { type: "checkLinkStatus", url: location.href, embed: true },
    (response) => {
      if (chrome.runtime.lastError) return;
      if (!response || response.status !== "blocked") return;
      neutralize();
    },
  );

  // Stop what the frame is still pulling in, then replace the whole
  // document: no content, no media, no listeners left on screen.
  function neutralize() {
    try {
      window.stop();
    } catch {
      // A frame may refuse; the page around it is unaffected either way.
    }

    const write = () => {
      try {
        const root = document.documentElement;
        if (!root) return;
        root.innerHTML = "";
        root.setAttribute("data-fwm-embed", "blocked");

        // Appended one piece at a time: a failure in the text must not cost
        // the frame its "blocked" appearance.
        const style = document.createElement("style");
        style.textContent = MARKER_CSS;
        root.appendChild(style);

        const box = document.createElement("div");
        box.className = "fwm-embed";
        box.setAttribute("role", "status");
        box.innerHTML = `${SHIELD_SVG}<strong></strong><small></small>`;
        const title = box.querySelector("strong");
        const hint = box.querySelector("small");
        if (title) title.textContent = message("embedBlockedTitle", "This embed is blocked");
        if (hint) hint.textContent = message("embedBlockedHint", "A parent blocked it.");
        root.appendChild(box);
      } catch {
        // Nothing else to do; the parent page keeps running.
      }
    };

    if (document.documentElement) write();
    else document.addEventListener("DOMContentLoaded", write, { once: true });
  }

  // chrome.i18n is available to content scripts; a missing or throwing
  // translator must not leave the frame empty without a message.
  function message(key, fallback) {
    try {
      return chrome.i18n.getMessage(key) || fallback;
    } catch {
      return fallback;
    }
  }
})();
