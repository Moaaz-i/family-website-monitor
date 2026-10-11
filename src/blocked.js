import { normalizeUrl, getHostname, isEntryAllowed, isValidRedirectTarget } from "./lib/url.js";
import { generateSecureId } from "./lib/security.js";
import { showToast, startLockoutTimer, handleLockout, applyThemeClass } from "./lib/ui.js";
import { WHITELIST_MAX } from "./lib/constants.js";
import { t, onTranslationReady, initTranslations } from "./lib/translator.js";
import { MORE_TIME_MINUTES } from "./lib/constants.js";

// Security Feature #11: Anti-Clickjacking Frame Busting
if (window.self !== window.top) {
  document.body.style.display = "none";
  throw new Error("Embedding this page is forbidden for security reasons.");
}

applyThemeClass();

initTranslations();

onTranslationReady(() => {
  const urlParams = new URLSearchParams(window.location.search);
  // `target` arrives in the address bar, so anyone can craft a link such as
  // blocked.html?target=javascript:...  Never hand an unchecked value to
  // location.replace() — that would execute script inside the extension
  // origin, which has access to storage and every permission we hold.
  // Note: URLSearchParams.get() has already percent-decoded once, so we must
  // NOT decode a second time (the previous version did, corrupting URLs that
  // legitimately contain "%").
  const targetParam = urlParams.get("target");
  const reason = urlParams.get("reason");
  const decodedTarget =
    targetParam && isValidRedirectTarget(targetParam) ? targetParam : null;

  const navType = performance.getEntriesByType("navigation")[0]?.type;
  if (navType === "back_forward" && targetParam) {
    chrome.runtime.sendMessage(
      { type: "checkLinkStatus", url: targetParam },
      (response) => {
        if (response && response.status === "allowed") {
          history.back();
        }
      },
    );
  }

  const actionType = document.getElementById("actionType");
  const durationInput = document.getElementById("duration");
  const reasonMessage = document.getElementById("reasonMessage");
  const passwordField = document.getElementById("password");
  const unlockBtn = document.getElementById("unlockBtn");
  const optionsSection = document.getElementById("optionsSection");
  const saveBtn = document.getElementById("saveBtn");

  // Initial check for brute-force lockout
  handleLockout(passwordField, unlockBtn);

  if (reasonMessage) {
    let messageKey = "blockedReasonDefault";
    if (reason === "schedule") messageKey = "blockedReasonSchedule";
    else if (reason === "limit") messageKey = "blockedReasonLimit";
    else if (reason === "emergency") messageKey = "blockedReasonEmergency";
    else if (reason === "tampered") messageKey = "blockedReasonTampered";
    else if (reason === "blocklist") messageKey = "blockedReasonBlocklist";
    else if (reason === "budget") messageKey = "blockedReasonBudget";
    reasonMessage.textContent = t(messageKey);
  }

  document.getElementById("blockedUrl").textContent = decodedTarget || "Unknown Site";

  // ── "Ask a parent for more time" ─────────────────────────────────────────
  // The button only raises a request; the service worker owns the cooldown
  // and the parent's decision, so a curious child cannot script its way to
  // extra minutes.
  //
  // It is shown only where an approval would actually open the page. A
  // temporary allowance cannot lift an emergency lock, a tamper alarm or a
  // blocklist entry — offering it there would be a promise that does nothing.
  const askResolvableReasons = [null, "", "default", "schedule", "limit", "budget"];
  const askAllowed = askResolvableReasons.includes(reason);
  const askMoreTimeBtn = document.getElementById("askMoreTimeBtn");
  const askStatus = document.getElementById("askStatus");

  if (askMoreTimeBtn && decodedTarget && askAllowed) {
    askMoreTimeBtn.textContent = t("askMoreTimeButton", String(MORE_TIME_MINUTES));
    askMoreTimeBtn.addEventListener("click", () => {
      askMoreTimeBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "requestMoreTime", url: decodedTarget }, (res) => {
        if (!res) {
          askMoreTimeBtn.disabled = false;
          return;
        }
        if (res.ok) {
          askStatus.textContent = t("askMoreTimeSent", String(res.minutes || MORE_TIME_MINUTES));
          return;
        }
        if (res.reason === "cooldown") {
          const waitMs = Math.max(1000, res.retryInMs || 0);
          askStatus.textContent = t("askMoreTimeCooldown", String(Math.ceil(waitMs / 1000)));
          setTimeout(() => {
            askStatus.textContent = "";
            askMoreTimeBtn.disabled = false;
          }, waitMs + 200);
          return;
        }
        if (res.reason === "already-allowed") {
          askStatus.textContent = t("askMoreTimeAlready");
          return;
        }
        askMoreTimeBtn.disabled = false;
        showToast(t("askMoreTimeFailed"), "error");
      });
    });
  } else if (askMoreTimeBtn) {
    askMoreTimeBtn.hidden = true;
  }

  actionType.addEventListener("change", () => {
    durationInput.style.display = actionType.value === "temp" ? "inline-block" : "none";
  });

  let parentUnlocked = false;

  function revealActions() {
    if (parentUnlocked) return;
    parentUnlocked = true;
    optionsSection.style.display = "block";
    passwordField.style.display = "none";
    unlockBtn.style.display = "none";
  }

  unlockBtn.addEventListener("click", () => {
    const passwordInput = passwordField.value;
    if (!passwordInput) return;

    const currentHostname = decodedTarget
      ? getHostname(decodedTarget) || "Unknown Site"
      : "Unknown Site";

    // The hash never leaves the service worker; it also owns the lockout
    // counter and the failed-attempt log.
    chrome.runtime.sendMessage(
      {
        type: "verifyParentPassword",
        password: passwordInput,
        site: currentHostname,
      },
      (res) => {
        if (!res) return;

        if (res.ok) {
          revealActions();
          passwordField.value = "";
          return;
        }

        if (res.lockoutExpiry && res.lockoutExpiry > Date.now()) {
          startLockoutTimer(passwordField, unlockBtn, res.lockoutExpiry);
        }
        showToast(t("passwordIncorrect"), "error");
        passwordField.value = "";
        passwordField.focus();
      },
    );
  });

  // Registered exactly once — the previous version added a fresh listener on
  // every successful unlock, so one click could save the same entry N times.
  saveBtn.addEventListener("click", () => {
    if (!parentUnlocked) return;
    const action = actionType.value;

    if (action === "always") {
      chrome.storage.local.get({ whitelist: [] }, (storageData) => {
        const whitelist = storageData.whitelist;
        if (!decodedTarget) return;

        const cleanUrl = normalizeUrl(decodedTarget);
        if (!cleanUrl) return;

        const siteExists = whitelist.some((entry) => isEntryAllowed(cleanUrl, entry));

        if (!siteExists) {
          // Whitelist size cap (Security Feature #18)
          if (whitelist.length >= WHITELIST_MAX) {
            showToast(t("whitelistCapacityError"), "error");
            return;
          }
          const wholeDomain = document.getElementById("blockedDomainWhitelist").checked;
          whitelist.push({
            id: generateSecureId(),
            fullUrl: cleanUrl,
            addedAt: Date.now(),
            mode: wholeDomain ? "domain" : "exact",
          });
        }

        chrome.storage.local.set(
          { whitelist: whitelist, timeTampered: false, lastActiveTime: Date.now() },
          () => {
            if (decodedTarget) window.location.replace(decodedTarget);
            else showToast(t("siteAddedSuccess"), "success");
          },
        );
      });
      return;
    }

    const minutes = parseInt(durationInput.value, 10);
    if (!minutes || minutes <= 0) {
      showToast(t("invalidMinutes"), "error");
      return;
    }
    const expiry = Date.now() + minutes * 60 * 1000;
    chrome.storage.local.get(["tempAllowed"], (storageData) => {
      const tempAllowed = storageData.tempAllowed || {};
      if (decodedTarget) {
        const cleanUrl = normalizeUrl(decodedTarget);
        if (cleanUrl) tempAllowed[cleanUrl] = expiry;
      }

      chrome.storage.local.set(
        { tempAllowed, timeTampered: false, lastActiveTime: Date.now() },
        () => {
          if (decodedTarget) window.location.replace(decodedTarget);
          else showToast(t("tempAllowSuccess", String(minutes)), "success");
        },
      );
    });
  });
});
