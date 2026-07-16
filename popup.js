const normalizeNumerals = (str) =>
  str.replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 1584));

const buildStrictUrl = (urlString) => {
  if (!urlString) return null;
  try {
    const urlObj = new URL(
      urlString.includes("://") ? urlString : `https://${urlString}`,
    );
    const host = urlObj.hostname.toLowerCase().replace(/^www\./, "");
    const path = urlObj.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    const hash = normalizeNumerals(
      decodeURIComponent(urlObj.hash.toLowerCase()),
    );
    const params = new URLSearchParams(urlObj.search);
    params.sort();
    const search = params.toString() ? `?${params.toString()}` : "";
    return `${host}${path}${search}${hash}`;
  } catch {
    return null;
  }
};

function isMatchingSite(urlString, targetSite) {
  if (!urlString || !targetSite) return false;
  const parsedUrl = buildStrictUrl(urlString);
  const parsedTarget = buildStrictUrl(targetSite);
  return Boolean(parsedUrl && parsedTarget && parsedUrl === parsedTarget);
}

document.addEventListener("DOMContentLoaded", () => {
  let activeTabUrl = "";

  chrome.storage.local.get("language", (data) => {
    const lang = data.language || "en";
    document.documentElement.setAttribute("lang", lang);
    document.documentElement.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
    const elements = document.querySelectorAll("[data-i18n]");
    elements.forEach((el) => {
      const msgKey = el.getAttribute("data-i18n");
      const msg = chrome.i18n.getMessage(msgKey);
      if (msg) {
        el.textContent = msg;
        if (el.placeholder) el.setAttribute("placeholder", msg);
        if (el.hasAttribute("title")) el.setAttribute("title", msg);
      }
    });
    const placeholders = document.querySelectorAll("[data-i18n-placeholder]");
    placeholders.forEach((el) => {
      const msgKey = el.getAttribute("data-i18n-placeholder");
      const msg = chrome.i18n.getMessage(msgKey);
      if (msg) el.placeholder = msg;
    });
  });

  chrome.storage.local.get("theme", (data) => {
    const savedTheme = data.theme;
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const theme = savedTheme || (prefersDark ? "dark" : "light");
    document.body.classList.toggle("dark", theme === "dark");
  });

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

  unlockBtn.addEventListener("click", () => {
    const enteredPassword = popupPasswordInput.value;
    chrome.storage.local.get(["password"], (data) => {
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
      if (enteredPassword === data.password) {
        lockScreen.classList.add("hidden");
        managementDashboard.classList.remove("hidden");
        loadDashboardData();
      } else {
        showToast(chrome.i18n.getMessage("passwordIncorrect"), "error");
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
        const isWhitelisted = whitelist.some((e) =>
          isMatchingSite(e.fullUrl, activeTabUrl),
        );
        updateWhitelistButtonState(isWhitelisted);

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
      toggleBtn.textContent = chrome.i18n.getMessage("removeFromWhitelist");
      toggleBtn.className = "btn btn-danger";
    } else {
      toggleBtn.textContent = chrome.i18n.getMessage("alwaysAllowSite");
      toggleBtn.className = "btn btn-success";
    }
  }

  function updateStatusTag(isWhitelisted, hasLimit) {
    const tag = document.getElementById("currentStatusTag");
    tag.className = "status-tag";
    if (isWhitelisted) {
      tag.classList.add("status-whitelisted");
      tag.textContent = chrome.i18n.getMessage("statusWhitelisted");
    } else if (hasLimit) {
      tag.classList.add("status-limited");
      tag.textContent = chrome.i18n.getMessage("statusLimited");
    } else {
      tag.classList.add("status-restricted");
      tag.textContent = chrome.i18n.getMessage("statusRestricted");
    }
  }

  document
    .getElementById("toggleWhitelistBtn")
    .addEventListener("click", () => {
      if (!activeTabUrl) return;
      chrome.storage.local.get({ whitelist: [] }, (data) => {
        let whitelist = data.whitelist;
        const index = whitelist.findIndex((e) =>
          isMatchingSite(e.fullUrl, activeTabUrl),
        );
        if (index > -1) {
          whitelist.splice(index, 1);
          chrome.storage.local.set({ whitelist }, () => loadDashboardData());
        } else {
          whitelist.push({
            id: Date.now().toString(36),
            fullUrl: activeTabUrl,
            addedAt: Date.now(),
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
      const minutesVal = document.getElementById("popupLimitMinutes").value;
      const minutes = parseInt(minutesVal || "0");
      const emergencyLock =
        document.getElementById("popupEmergencyLock").checked;

      chrome.storage.local.get(["dailyLimit"], (data) => {
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
            showToast(chrome.i18n.getMessage("settingsSaved"), "success");
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
