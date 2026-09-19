import { normalizeUrl, getHostname, isEntryAllowed } from "./lib/url.js";
import { verifyPasswordInput, generateSecureId } from "./lib/security.js";
import {
  showToast,
  startLockoutTimer,
  handleLockout,
  applyThemeClass,
} from "./lib/ui.js";
import {
  WHITELIST_MAX,
  BRUTE_FORCE_THRESHOLD,
  BRUTE_FORCE_LOCKOUT_MS,
  WRONG_ATTEMPT_LOG_MAX,
} from "./lib/constants.js";
import { t, onTranslationReady, initTranslations } from "./lib/translator.js";

// Security Feature #11: Anti-Clickjacking Frame Busting
if (window.self !== window.top) {
  document.body.style.display = "none";
  throw new Error("Embedding this page is forbidden for security reasons.");
}

applyThemeClass();

initTranslations();

onTranslationReady(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const targetParam = urlParams.get("target");
  const reason = urlParams.get("reason");
  const target = urlParams.get("target");

  const navType = performance.getEntriesByType("navigation")[0]?.type;
  if (navType === "back_forward" && targetParam) {
    chrome.runtime.sendMessage(
      { type: "checkLinkStatus", url: decodeURIComponent(targetParam) },
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

  // Initial check for brute-force lockout
  handleLockout(passwordField, unlockBtn);

  if (reasonMessage) {
    let messageKey = "blockedReasonDefault";
    if (reason === "schedule") messageKey = "blockedReasonSchedule";
    else if (reason === "limit") messageKey = "blockedReasonLimit";
    else if (reason === "emergency") messageKey = "blockedReasonEmergency";
    else if (reason === "tampered") messageKey = "blockedReasonTampered";
    reasonMessage.textContent = t(messageKey);
  }

  document.getElementById("blockedUrl").textContent = decodeURIComponent(
    target || "Unknown Site",
  );

  actionType.addEventListener("change", () => {
    durationInput.style.display =
      actionType.value === "temp" ? "inline-block" : "none";
  });

  unlockBtn.addEventListener("click", async () => {
    const passwordInput = passwordField.value;
    let currentHostname = "Unknown Site";

    if (targetParam) {
      currentHostname =
        getHostname(decodeURIComponent(targetParam)) || "Unknown Site";
    }

    chrome.storage.local.get(["password", "wrongAttempts", "failedAttemptsCount"], async (data) => {
      const correct = await verifyPasswordInput(passwordInput, data.password);

      if (correct) {
        // Reset brute-force lockout tracking
        chrome.storage.local.set({ failedAttemptsCount: 0, lockoutExpiry: 0 });

        document.getElementById("optionsSection").style.display = "block";
        passwordField.style.display = "none";
        unlockBtn.style.display = "none";

        document.getElementById("saveBtn").addEventListener("click", () => {
          const action = actionType.value;
          if (action === "always") {
            chrome.storage.local.get({ whitelist: [] }, (storageData) => {
              const whitelist = storageData.whitelist;
              const decodedUrl = targetParam
                ? decodeURIComponent(targetParam)
                : null;
              if (!decodedUrl) return;

              const cleanUrl = normalizeUrl(decodedUrl);
              if (!cleanUrl) return;

              const siteExists = whitelist.some((entry) =>
                isEntryAllowed(cleanUrl, entry),
              );

              // Whitelist size cap (Security Feature #18)
              if (!siteExists) {
                if (whitelist.length >= WHITELIST_MAX) {
                  showToast("Whitelist storage capacity exceeded (max 1000 items)", "error");
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

              // Clear timeTampered if we bypass/unlock
              chrome.storage.local.set({ whitelist: whitelist, timeTampered: false, lastActiveTime: Date.now() }, () => {
                if (decodedUrl) window.location.replace(decodedUrl);
                else showToast(t("siteAddedSuccess"), "success");
              });
            });
          } else if (action === "temp") {
            const minutes = parseInt(durationInput.value, 10);
            if (!minutes || minutes <= 0) {
              showToast(t("invalidMinutes"), "error");
              return;
            }
            const expiry = new Date().getTime() + minutes * 60 * 1000;
            chrome.storage.local.get(["tempAllowed"], (storageData) => {
              let tempAllowed = storageData.tempAllowed || {};
              if (targetParam) {
                const decodedUrl = decodeURIComponent(targetParam);
                const cleanUrl = normalizeUrl(decodedUrl);
                if (cleanUrl) tempAllowed[cleanUrl] = expiry;
              }

              // Clear timeTampered if we bypass/unlock
              chrome.storage.local.set({ tempAllowed, timeTampered: false, lastActiveTime: Date.now() }, () => {
                if (targetParam)
                  window.location.replace(decodeURIComponent(targetParam));
                else
                  showToast(t("tempAllowSuccess", String(minutes)), "success");
              });
            });
          }
        });
      } else {
        // Increment fail counter for Brute-force lockout
        const attemptsCount = (data.failedAttemptsCount || 0) + 1;
        const updates = { failedAttemptsCount: attemptsCount };

        if (attemptsCount >= BRUTE_FORCE_THRESHOLD) {
          const lockoutExpiryTime = Date.now() + BRUTE_FORCE_LOCKOUT_MS;
          updates.lockoutExpiry = lockoutExpiryTime;
          startLockoutTimer(passwordField, unlockBtn, lockoutExpiryTime);
        }

        const attempt = {
          site: currentHostname,
          time: new Date().toLocaleString("en-US"),
        };
        const wrongAttempts = data.wrongAttempts || [];
        wrongAttempts.push(attempt);

        // Log Cap limit to 100 entries (Security Feature #18)
        if (wrongAttempts.length > WRONG_ATTEMPT_LOG_MAX) {
          wrongAttempts.shift();
        }

        updates.wrongAttempts = wrongAttempts;

        chrome.storage.local.set(updates, () => {
          showToast(t("passwordIncorrect"), "error");
          passwordField.value = "";
          passwordField.focus();
        });
      }
    });
  });
});