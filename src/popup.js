import { isSameSite, isEntryAllowed, isValidRedirectTarget } from "./lib/url.js";
import { migrateDailyLimit } from "./lib/rules.js";
import { generateSecureId } from "./lib/security.js";
import {
  showToast,
  startLockoutTimer,
  handleLockout,
  applyThemeClass,
} from "./lib/ui.js";
import { WHITELIST_MAX } from "./lib/constants.js";
import { t, onTranslationReady, initTranslations } from "./lib/translator.js";

// Security Feature #11: Anti-Clickjacking Frame Busting
if (window.self !== window.top) {
  document.body.style.display = "none";
  throw new Error("Embedding this page is forbidden for security reasons.");
}

applyThemeClass();

initTranslations();

onTranslationReady(() => {
  // ── Update UI ──────────────────────────────────────────────────────────────
  const updateBanner      = document.getElementById("updateBanner");
  const updateBannerVer   = document.getElementById("updateBannerVersion");
  const updateHowBtn      = document.getElementById("updateHowBtn");
  const updateDismissBtn  = document.getElementById("updateDismissBtn");
  const updateModal       = document.getElementById("updateModal");
  const modalVersionText  = document.getElementById("modalVersionText");
  const modalReleaseNotes = document.getElementById("modalReleaseNotes");
  const modalCloseBtn     = document.getElementById("modalCloseBtn");
  const checkForUpdatesBtn = document.getElementById("checkForUpdatesBtn");

  function showUpdateBanner(latestVersion, currentVersion) {
    updateBannerVer.textContent = `v${currentVersion} → v${latestVersion}`;
    updateBanner.classList.remove("hidden");
  }

  function showUpdateModal(latestVersion, currentVersion, releaseNotes) {
    modalVersionText.textContent =
      `Current: v${currentVersion}  →  Latest: v${latestVersion}`;
    modalReleaseNotes.textContent = releaseNotes || "";
    modalReleaseNotes.style.display = releaseNotes ? "block" : "none";
    updateModal.classList.remove("hidden");
  }

  // Check storage on popup open
  chrome.storage.local.get(
    ["updateAvailable", "latestVersion", "currentVersion", "releaseNotes"],
    (data) => {
      if (data.updateAvailable) {
        showUpdateBanner(data.latestVersion, data.currentVersion);
      }
    }
  );

  updateHowBtn && updateHowBtn.addEventListener("click", () => {
    chrome.storage.local.get(
      ["latestVersion", "currentVersion", "releaseNotes"],
      (data) => showUpdateModal(data.latestVersion, data.currentVersion, data.releaseNotes)
    );
  });

  updateDismissBtn && updateDismissBtn.addEventListener("click", () => {
    updateBanner.classList.add("hidden");
    chrome.runtime.sendMessage({ type: "dismissUpdate" });
  });

  modalCloseBtn && modalCloseBtn.addEventListener("click", () => {
    updateModal.classList.add("hidden");
  });

  updateModal && updateModal.addEventListener("click", (e) => {
    if (e.target === updateModal) updateModal.classList.add("hidden");
  });

  checkForUpdatesBtn && checkForUpdatesBtn.addEventListener("click", () => {
    checkForUpdatesBtn.textContent = 'Checking...';
    checkForUpdatesBtn.disabled = true;
    chrome.runtime.sendMessage({ type: "checkForUpdatesNow" }, (data) => {
      checkForUpdatesBtn.disabled = false;
      if (data && data.updateAvailable) {
        checkForUpdatesBtn.textContent = "Update available!";
        showUpdateBanner(data.latestVersion, data.currentVersion);
        showUpdateModal(data.latestVersion, data.currentVersion, data.releaseNotes);
      } else {
        checkForUpdatesBtn.textContent = "Up to date";
        setTimeout(() => {
          checkForUpdatesBtn.textContent = "Check for Updates";
        }, 3000);
      }
    });
  });
  // ──────────────────────────────────────────────────────────────────────────

  let activeTabUrl = "";

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs.length > 0) {
      const urlString = tabs[0].url || tabs[0].pendingUrl || "";
      try {
        const url = new URL(urlString);
        // searchParams.get() already percent-decoded — decoding again corrupts
        // URLs that legitimately contain "%".
        const fromQuery = url.searchParams.has("target")
          ? url.searchParams.get("target")
          : urlString;
        // Only http(s) targets may ever be whitelisted or displayed as the
        // current site.
        activeTabUrl = isValidRedirectTarget(fromQuery) ? fromQuery : "";
      } catch {
        activeTabUrl = isValidRedirectTarget(urlString) ? urlString : "";
      }
      try {
        document.getElementById("currentDomain").textContent =
          new URL(activeTabUrl).hostname || activeTabUrl;
      } catch {
        document.getElementById("currentDomain").textContent =
          activeTabUrl || "Unknown";
      }
    }
  });

  const unlockBtn = document.getElementById("unlockBtn");
  const popupPasswordInput = document.getElementById("popupPassword");
  const pinGroup = document.getElementById("pinGroup");
  const passwordGroup = document.getElementById("passwordGroup");
  const popupPinInput = document.getElementById("popupPin");
  const pinUnlockBtn = document.getElementById("pinUnlockBtn");
  const usePasswordBtn = document.getElementById("usePasswordBtn");
  const usePinBtn = document.getElementById("usePinBtn");
  const lockScreen = document.getElementById("lockScreen");
  const managementDashboard = document.getElementById("managementDashboard");

  // Initial brute force check
  handleLockout(popupPasswordInput, unlockBtn);
  if (pinUnlockBtn && popupPinInput) handleLockout(popupPinInput, pinUnlockBtn);

  // Load language selector state
  chrome.storage.local.get("language", (data) => {
    const selector = document.getElementById("popupLanguageSelector");
    if (selector) {
      selector.value = data.language || "en";
      selector.addEventListener("change", () => {
        chrome.storage.local.set({ language: selector.value }, () => {
          location.reload();
        });
      });
    }
  });

  // Dynamic Session token & auto-lock
  chrome.storage.local.get(["sessionToken", "sessionExpiry"], (data) => {
    const now = Date.now();
    if (data.sessionToken && data.sessionExpiry > now) {
      // Direct access if parent session is still active
      lockScreen.classList.add("hidden");
      managementDashboard.classList.remove("hidden");
      loadDashboardData();
    }
  });

  // ── Unlock: password and optional PIN share one code path ────────────────
  let hasPin = false;
  let authMode = "password";

  function setAuthMode(mode) {
    authMode = mode === "pin" && hasPin ? "pin" : "password";
    pinGroup.classList.toggle("hidden", authMode !== "pin");
    passwordGroup.classList.toggle("hidden", authMode === "pin");
    usePinBtn.classList.toggle("hidden", !hasPin || authMode === "pin");
  }

  function showDashboard() {
    lockScreen.classList.add("hidden");
    managementDashboard.classList.remove("hidden");
    loadDashboardData();
  }

  function handleAuthResult(res) {
    if (!res) return;
    const field = authMode === "pin" ? popupPinInput : popupPasswordInput;
    const button = authMode === "pin" ? pinUnlockBtn : unlockBtn;

    if (res.ok) {
      showDashboard();
      popupPasswordInput.value = "";
      popupPinInput.value = "";
      return;
    }

    if (res.reason === "not-configured") {
      showToast(t("setupRequired"), "warning");
      setTimeout(() => chrome.runtime.openOptionsPage(), 1500);
      return;
    }

    if (res.reason === "no-pin") {
      hasPin = false;
      setAuthMode("password");
      showToast(t("pinNotSet"), "warning");
      return;
    }

    if (res.lockoutExpiry && res.lockoutExpiry > Date.now()) {
      startLockoutTimer(field, button, res.lockoutExpiry);
    }
    showToast(t("passwordIncorrect"), "error");
    field.value = "";
    field.focus();
  }

  chrome.storage.local.get(["pinHash"], (data) => {
    hasPin = Boolean(data.pinHash);
    setAuthMode(hasPin ? "pin" : "password");
    const firstField = hasPin ? popupPinInput : popupPasswordInput;
    if (firstField) firstField.focus();
  });

  usePasswordBtn.addEventListener("click", () => {
    setAuthMode("password");
    popupPasswordInput.focus();
  });

  usePinBtn.addEventListener("click", () => {
    setAuthMode("pin");
    popupPinInput.focus();
  });

  pinUnlockBtn.addEventListener("click", () => {
    const pin = popupPinInput.value;
    if (!pin) return;
    // The service worker owns verification, lockout and the attempt log.
    chrome.runtime.sendMessage(
      { type: "verifyParentPin", pin, site: "popup" },
      handleAuthResult,
    );
  });

  popupPinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") pinUnlockBtn.click();
  });

  unlockBtn.addEventListener("click", () => {
    const enteredPassword = popupPasswordInput.value;
    if (!enteredPassword) return;

    // Verification happens in the service worker: the popup never reads the
    // stored password hash, and lockout/logging logic lives in one place.
    chrome.runtime.sendMessage(
      { type: "verifyParentPassword", password: enteredPassword, site: "popup" },
      handleAuthResult,
    );
  });

  popupPasswordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlockBtn.click();
  });

  function loadDashboardData() {
    chrome.storage.local.get(
      ["whitelist", "dailyLimit", "emergencyLock"],
      (data) => {
        const whitelist = data.whitelist || [];
        const matchedEntry = whitelist.find((e) => isEntryAllowed(activeTabUrl, e));
        const isWhitelisted = Boolean(matchedEntry);
        updateWhitelistButtonState(isWhitelisted);

        const domainToggle = document.getElementById("popupDomainWhitelist");
        if (domainToggle) {
          domainToggle.checked = isWhitelisted && matchedEntry.mode === "domain";
        }

        // The stored layout is { enabled, sites: { [site]: { minutes, ... } } }.
        // migrateDailyLimit() also converts the pre-3.0 { targetSites } shape,
        // which is what the popup previously read and got wrong.
        const dl = migrateDailyLimit(data.dailyLimit);
        const limitInput = document.getElementById("popupLimitMinutes");
        const siteKey = activeTabUrl
          ? Object.keys(dl.sites).find((site) => isSameSite(activeTabUrl, site))
          : null;
        const siteData = siteKey ? dl.sites[siteKey] : null;
        const hasLimit = Boolean(dl.enabled && siteData);

        limitInput.value = hasLimit ? String(siteData.minutes) : "";

        updateStatusTag(isWhitelisted, hasLimit);
        document.getElementById("popupEmergencyLock").checked =
          !!data.emergencyLock;
      },
    );

    // Whole-day budget, independent of the site currently open.
    chrome.runtime.sendMessage({ type: "checkTimeStatus" }, (res) => {
      const box = document.getElementById("screenTimeBox");
      const value = document.getElementById("screenTimeValue");
      if (!box || !value) return;
      const screen = res && res.screen;
      if (!screen || !screen.enabled) {
        box.classList.add("hidden");
        return;
      }
      box.classList.remove("hidden");
      value.textContent = screen.exhausted
        ? t("blockedReasonBudget")
        : formatClock(screen.remainingSeconds);
    });
  }

  // Compact "2h 5m" / "45s" label for the popup status box.
  function formatClock(totalSeconds) {
    const total = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  function updateWhitelistButtonState(isWhitelisted) {
    const toggleBtn = document.getElementById("toggleWhitelistBtn");
    if (isWhitelisted) {
      toggleBtn.textContent = t("removeFromWhitelist");
      toggleBtn.className = "btn btn-danger";
    } else {
      toggleBtn.textContent = t("alwaysAllowSite");
      toggleBtn.className = "btn btn-success";
    }
  }

  function updateStatusTag(isWhitelisted, hasLimit) {
    const tag = document.getElementById("currentStatusTag");
    tag.className = "status-tag";
    if (isWhitelisted) {
      tag.classList.add("status-whitelisted");
      tag.textContent = t("statusWhitelisted");
    } else if (hasLimit) {
      tag.classList.add("status-limited");
      tag.textContent = t("statusLimited");
    } else {
      tag.classList.add("status-restricted");
      tag.textContent = t("statusRestricted");
    }
  }

  document
    .getElementById("toggleWhitelistBtn")
    .addEventListener("click", () => {
      if (!activeTabUrl) return;

      // Verification of active session prior to whitelisting
      chrome.storage.local.get(["sessionExpiry", "whitelist"], (data) => {
        if (!data.sessionExpiry || data.sessionExpiry < Date.now()) {
          showToast(t("sessionExpiredError"), "error");
          location.reload();
          return;
        }

        const whitelist = data.whitelist || [];
        const index = whitelist.findIndex((e) =>
          isEntryAllowed(activeTabUrl, e),
        );
        if (index > -1) {
          whitelist.splice(index, 1);
          chrome.storage.local.set({ whitelist }, () => loadDashboardData());
        } else {
          // Whitelist size cap (Security Feature #18)
          if (whitelist.length >= WHITELIST_MAX) {
            showToast(t("whitelistCapacityError"), "error");
            return;
          }

          // Secure Cryptographic ID generation (Security Feature #7)
          const secureId = generateSecureId();
          const wholeDomain = document.getElementById("popupDomainWhitelist").checked;

          whitelist.push({
            id: secureId,
            fullUrl: activeTabUrl,
            addedAt: Date.now(),
            mode: wholeDomain ? "domain" : "exact",
          });
          chrome.storage.local.set({ whitelist }, () => loadDashboardData());
        }
      });
    });

  const presets = document.querySelectorAll(".preset-btn");
  presets.forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("popupLimitMinutes").value =
        btn.getAttribute("data-minutes");
    });
  });

  document
    .getElementById("savePopupSettingsBtn")
    .addEventListener("click", () => {
      if (!activeTabUrl) return;

      // Verification of active session prior to saving settings
      chrome.storage.local.get(["sessionExpiry", "dailyLimit"], (data) => {
        if (!data.sessionExpiry || data.sessionExpiry < Date.now()) {
          showToast(t("sessionExpiredError"), "error");
          location.reload();
          return;
        }

        const minutesVal = document.getElementById("popupLimitMinutes").value.trim();
        const parsed = parseInt(minutesVal, 10);
        const minutes = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1440) : 0;
        const emergencyLock =
          document.getElementById("popupEmergencyLock").checked;

        // Write straight into the { enabled, sites } layout that the service
        // worker and the control panel read. Mixing in the legacy
        // { minutes, targetSites } keys silently discarded the limit.
        const dl = migrateDailyLimit(data.dailyLimit);
        const today = new Date().toDateString();

        if (minutes > 0) {
          const current = dl.sites[activeTabUrl];
          dl.enabled = true;
          dl.sites[activeTabUrl] = {
            minutes,
            usedTodaySeconds: current ? current.usedTodaySeconds || 0 : 0,
            lastReset: (current && current.lastReset) || today,
          };
        } else {
          delete dl.sites[activeTabUrl];
          if (Object.keys(dl.sites).length === 0) dl.enabled = false;
        }

        chrome.storage.local.set(
          { dailyLimit: dl, emergencyLock: emergencyLock },
          () => {
            showToast(t("settingsSaved"), "success");
            loadDashboardData();
          },
        );
      });
    });

  const openOptionsButton = document.getElementById("openOptions");
  if (openOptionsButton) {
    openOptionsButton.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });
  }
});