import { initTranslations } from "./lib/translator.js";

// Security Feature #11: Anti-Clickjacking Frame Busting
if (window.self !== window.top) {
  document.body.style.display = "none";
  throw new Error("Embedding this page is forbidden for security reasons.");
}

// Auto-translate the DOM (data-i18n attributes)
initTranslations();

function checkAndRedirect() {
  chrome.storage.local.get(["extensionsAccessExpiry"], (store) => {
    const now = Date.now();
    const allowedUntil = store.extensionsAccessExpiry || 0;
    if (now < allowedUntil) {
      // Use chrome.tabs.update with null tab ID to target the active tab of the current window
      chrome.tabs.update({ url: "chrome://extensions/" });
    }
  });
}

// Check immediately on load
checkAndRedirect();

// Auto-redirect if parent grants access from options dashboard in another window/tab
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.extensionsAccessExpiry) {
    const allowedUntil = changes.extensionsAccessExpiry.newValue || 0;
    if (Date.now() < allowedUntil) {
      chrome.tabs.update({ url: "chrome://extensions/" });
    }
  }
});