import { isMatchingSite, isEntryAllowed } from "./lib/url.js";
import {
  verifyPasswordInput,
  generateSecureId,
} from "./lib/security.js";
import {
  showToast,
  startLockoutTimer,
  handleLockout,
  applyThemeClass,
} from "./lib/ui.js";
import {
  WHITELIST_MAX,
  SESSION_DURATION_MS,
  BRUTE_FORCE_THRESHOLD,
  BRUTE_FORCE_LOCKOUT_MS,
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
    checkForUpdatesBtn.innerHTML = '<span class="checking-spinner">⟳</span> Checking...';
    checkForUpdatesBtn.disabled = true;
    chrome.runtime.sendMessage({ type: "checkForUpdatesNow" }, (data) => {
      checkForUpdatesBtn.disabled = false;
      if (data && data.updateAvailable) {
        checkForUpdatesBtn.textContent = "🔔 Update available!";
        showUpdateBanner(data.latestVersion, data.currentVersion);
        showUpdateModal(data.latestVersion, data.currentVersion, data.releaseNotes);
      } else {
        checkForUpdatesBtn.textContent = "✅ Up to date";
        setTimeout(() => {
          checkForUpdatesBtn.textContent = "🔄 Check for Updates";
        }, 3000);
      }
    });
  });
  // ──────────────────────────────────────────────────────────────────────────

  let activeTabUrl = "";

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs.length > 0) {
      let urlString = tabs[0].url || tabs[0].pendingUrl || "";
      try {
        const url = new URL(urlString);
        if (url.searchParams.has("target")) {
          activeTabUrl = decodeURIComponent(url.searchParams.get("target"));
        } else {
          activeTabUrl = urlString;
        }
      } catch (e) {
        activeTabUrl = urlString;
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
  const lockScreen = document.getElementById("lockScreen");
  const managementDashboard = document.getElementById("managementDashboard");

  // Initial brute force check
  handleLockout(popupPasswordInput, unlockBtn);

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

  unlockBtn.addEventListener("click", async () => {
    const enteredPassword = popupPasswordInput.value;
    chrome.storage.local.get(["password", "failedAttemptsCount"], async (data) => {
      if (!data.password) {
        showToast(
          "Please set up a parent password in options page first.",
          "warning",
        );
        setTimeout(() => {
          chrome.runtime.openOptionsPage();
        }, 1500);
        return;
      }

      const correct = await verifyPasswordInput(enteredPassword, data.password);

      if (correct) {
        // Reset lockout tracking
        chrome.storage.local.set({ failedAttemptsCount: 0, lockoutExpiry: 0 });

        // Generate temporary session token (expires in 5 minutes)
        const sessionToken = Date.now().toString(36) + Math.random().toString(36);
        const sessionExpiry = Date.now() + SESSION_DURATION_MS;
        chrome.storage.local.set({ sessionToken, sessionExpiry });

        lockScreen.classList.add("hidden");
        managementDashboard.classList.remove("hidden");
        loadDashboardData();
      } else {
        const attemptsCount = (data.failedAttemptsCount || 0) + 1;
        const updates = { failedAttemptsCount: attemptsCount };

        if (attemptsCount >= BRUTE_FORCE_THRESHOLD) {
          const lockoutExpiryTime = Date.now() + BRUTE_FORCE_LOCKOUT_MS;
          updates.lockoutExpiry = lockoutExpiryTime;
          startLockoutTimer(popupPasswordInput, unlockBtn, lockoutExpiryTime);
        }

        chrome.storage.local.set(updates, () => {
          showToast(t("passwordIncorrect"), "error");
          popupPasswordInput.value = "";
          popupPasswordInput.focus();
        });
      }
    });
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

        const dl = data.dailyLimit || {
          enabled: false,
          minutes: 0,
          targetSites: [],
        };
        const hasLimit =
          dl.enabled &&
          dl.targetSites &&
          dl.targetSites.some((site) => isMatchingSite(site, activeTabUrl));
        const limitInput = document.getElementById("popupLimitMinutes");

        if (hasLimit) limitInput.value = dl.minutes;
        else limitInput.value = "";

        updateStatusTag(isWhitelisted, hasLimit);
        document.getElementById("popupEmergencyLock").checked =
          !!data.emergencyLock;
      },
    );
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
          showToast("Session expired. Please log in again.", "error");
          location.reload();
          return;
        }

        let whitelist = data.whitelist || [];
        const index = whitelist.findIndex((e) =>
          isEntryAllowed(activeTabUrl, e),
        );
        if (index > -1) {
          whitelist.splice(index, 1);
          chrome.storage.local.set({ whitelist }, () => loadDashboardData());
        } else {
          // Whitelist size cap (Security Feature #18)
          if (whitelist.length >= WHITELIST_MAX) {
            showToast("Whitelist storage capacity exceeded (max 1000 items)", "error");
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
          showToast("Session expired. Please log in again.", "error");
          location.reload();
          return;
        }

        const minutesVal = document.getElementById("popupLimitMinutes").value;
        const minutes = parseInt(minutesVal || "0");
        const emergencyLock =
          document.getElementById("popupEmergencyLock").checked;

        const existingDl = data.dailyLimit || {};
        let newDl = { ...existingDl };
        if (minutes > 0) {
          newDl.enabled = true;
          newDl.minutes = minutes;
          if (!newDl.targetSites) newDl.targetSites = [];
          if (
            !newDl.targetSites.some((site) =>
              isMatchingSite(site, activeTabUrl),
            )
          ) {
            newDl.targetSites = [activeTabUrl];
            if (newDl.usedToday === undefined) newDl.usedToday = 0;
            if (newDl.usedTodaySeconds === undefined)
              newDl.usedTodaySeconds = 0;
            if (!newDl.lastReset) newDl.lastReset = new Date().toDateString();
          }
        } else if (minutesVal === "0" || minutesVal === "") {
          newDl.enabled = false;
        }
        chrome.storage.local.set(
          { dailyLimit: newDl, emergencyLock: emergencyLock },
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