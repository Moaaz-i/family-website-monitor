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

function applyTheme(theme) {
  document.body.classList.toggle("dark", theme === "dark");
  const key = theme === "dark" ? "themeToggleLight" : "themeToggleDark";
  themeToggleBtn.textContent = chrome.i18n.getMessage(key);
  chrome.storage.local.set({ theme });
}

chrome.storage.local.get("theme", (data) => {
  const savedTheme = data.theme;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = savedTheme || (prefersDark ? "dark" : "light");
  applyTheme(theme);
});

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get("language", (data) => {
    const lang = data.language || "en";
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.querySelectorAll("[data-i18n]").forEach((elem) => {
      elem.textContent = chrome.i18n.getMessage(elem.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((elem) => {
      elem.placeholder = chrome.i18n.getMessage(elem.dataset.i18nPlaceholder);
    });
    const langSelector = document.getElementById("languageSelector");
    if (langSelector) langSelector.value = lang;
  });

  const setupSection = document.getElementById("setupSection");
  const loginSection = document.getElementById("loginSection");
  const dashboardSection = document.getElementById("dashboardSection");
  const whitelistContainer = document.getElementById("whitelistContainer");

  const urlParams = new URLSearchParams(window.location.search);
  const targetParam = urlParams.get("target");

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url.includes("://") ? url : `https://${url}`);
      return u.href;
    } catch {
      return null;
    }
  }

  function migrateWhitelist(list) {
    return list
      .map((entry) => {
        if (entry.fullUrl) return entry;
        if (entry.domain) {
          return {
            id: entry.id || generateId(),
            fullUrl: `https://${entry.domain}`.replace(/\/+$/, ""),
            addedAt: entry.addedAt || Date.now(),
          };
        }
        if (typeof entry === "string") {
          const clean = normalizeUrl(entry);
          if (clean) {
            return {
              id: generateId(),
              fullUrl: clean,
              addedAt: Date.now(),
            };
          }
        }
        return null;
      })
      .filter(Boolean);
  }

  function redirectToTarget() {
    if (!targetParam) return openDashboard();
    const cleanUrl = normalizeUrl(decodeURIComponent(targetParam));
    if (!cleanUrl) return openDashboard();
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      let whitelist = migrateWhitelist(data.whitelist);
      const exists = whitelist.some((e) => isMatchingSite(e.fullUrl, cleanUrl));
      if (!exists) {
        whitelist.push({
          id: generateId(),
          fullUrl: cleanUrl,
          addedAt: Date.now(),
        });
      }
      chrome.storage.local.set({ whitelist }, () => {
        window.location.replace(cleanUrl);
      });
    });
  }

  chrome.storage.local.get(["password"], (data) => {
    if (!data.password) setupSection.style.display = "block";
    else loginSection.style.display = "block";
  });

  function reLockOnFocus() {
    if (dashboardSection.style.display === "block") {
      dashboardSection.style.display = "none";
      loginSection.style.display = "block";
      document.getElementById("loginPassword").value = "";
      document.getElementById("loginPassword").focus();
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reLockOnFocus();
  });
  window.addEventListener("focus", reLockOnFocus);

  document.getElementById("saveSetupBtn").addEventListener("click", () => {
    const p1 = document.getElementById("newPassword").value;
    const p2 = document.getElementById("confirmPassword").value;
    if (!p1 || !p2) return;
    if (p1 !== p2)
      return showToast(chrome.i18n.getMessage("passwordsDontMatch"), "error");
    chrome.storage.local.set({ password: p1, whitelist: [] }, () => {
      setupSection.style.display = "none";
      redirectToTarget();
    });
  });

  document.getElementById("loginBtn").addEventListener("click", () => {
    const pass = document.getElementById("loginPassword").value;
    chrome.storage.local.get(["password"], (data) => {
      if (pass === data.password) {
        loginSection.style.display = "none";
        redirectToTarget();
      } else showToast(chrome.i18n.getMessage("passwordIncorrect"), "error");
    });
  });

  function openDashboard() {
    dashboardSection.style.display = "block";
    loadSchedule();
    loadDailyLimit();
    loadEmergencyLock();
    renderWhitelist();
    renderWrongAttempts();
    renderLimitsTable();
    const languageSelector = document.getElementById("languageSelector");
    languageSelector.addEventListener("change", () => {
      const newLang = languageSelector.value;
      chrome.storage.local.set({ language: newLang });
      location.reload();
    });
    const themeToggleBtn = document.getElementById("themeToggleBtn");
    themeToggleBtn.addEventListener("click", () => {
      const currentTheme = document.body.classList.contains("dark")
        ? "dark"
        : "light";
      applyTheme(currentTheme === "dark" ? "light" : "dark");
    });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.classList.contains("tab-link")) return;
    const tabId = e.target.getAttribute("data-tab");
    document
      .querySelectorAll(".tab-link")
      .forEach((l) => l.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.remove("active"));
    e.target.classList.add("active");
    document.getElementById(tabId).classList.add("active");
  });

  function renderWhitelist() {
    whitelistContainer.innerHTML = "";
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      let whitelist = migrateWhitelist(data.whitelist);
      chrome.storage.local.set({ whitelist });
      if (whitelist.length === 0) {
        const li = document.createElement("li");
        li.textContent = chrome.i18n.getMessage("noSitesAdded");
        whitelistContainer.appendChild(li);
        return;
      }
      whitelist.forEach((entry) => {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.justifyContent = "space-between";
        li.style.alignItems = "center";
        li.style.gap = "1rem";
        const span = document.createElement("span");
        span.textContent = entry.fullUrl;
        span.title = entry.fullUrl;
        span.style.direction = "ltr";
        span.style.whiteSpace = "nowrap";
        span.style.overflow = "hidden";
        span.style.textOverflow = "ellipsis";
        const button = document.createElement("button");
        button.textContent = chrome.i18n.getMessage("deleteButton");
        button.className = "btn btn-danger";
        button.setAttribute("data-url", entry.fullUrl);
        li.append(span, button);
        whitelistContainer.appendChild(li);
      });
    });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.classList.contains("btn-danger")) return;
    const url = e.target.getAttribute("data-url");
    removeSite(url);
  });

  document.getElementById("addSiteBtn").addEventListener("click", () => {
    let input = document.getElementById("newSiteInput").value.trim();
    const cleanUrl = normalizeUrl(input);
    if (!cleanUrl)
      return showToast(chrome.i18n.getMessage("invalidUrl"), "error");
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      let whitelist = migrateWhitelist(data.whitelist);
      if (whitelist.some((e) => isMatchingSite(e.fullUrl, cleanUrl))) {
        return showToast(
          chrome.i18n.getMessage("siteAlreadyWhitelisted"),
          "error",
        );
      }
      whitelist.push({
        id: generateId(),
        fullUrl: cleanUrl,
        addedAt: Date.now(),
      });
      chrome.storage.local.set({ whitelist }, () => {
        document.getElementById("newSiteInput").value = "";
        renderWhitelist();
      });
    });
  });

  function removeSite(url) {
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      let whitelist = migrateWhitelist(data.whitelist);
      whitelist = whitelist.filter((e) => !isMatchingSite(e.fullUrl, url));
      chrome.storage.local.set({ whitelist }, () => {
        renderWhitelist();
      });
    });
  }

  function loadSchedule() {
    chrome.storage.local.get(["schedule"], (data) => {
      const schedule = data.schedule || {
        enabled: false,
        days: [false, false, false, false, false, false, false],
        startTime: "00:00",
        endTime: "23:59",
      };
      schedule.days.forEach((v, i) => {
        document.getElementById("day" + i).checked = v;
      });
      document.getElementById("startTime").value = schedule.startTime;
      document.getElementById("endTime").value = schedule.endTime;
    });
  }

  document.getElementById("saveScheduleBtn").addEventListener("click", () => {
    const days = [];
    for (let i = 0; i < 7; i++) {
      days.push(document.getElementById("day" + i).checked);
    }
    const schedule = {
      enabled: true,
      days,
      startTime: document.getElementById("startTime").value,
      endTime: document.getElementById("endTime").value,
    };
    chrome.storage.local.set({ schedule }, () => {
      showToast(chrome.i18n.getMessage("scheduleSaved"));
    });
  });

  function loadDailyLimit() {
    chrome.storage.local.get(["dailyLimit"], (data) => {
      const dl = data.dailyLimit || {
        enabled: false,
        minutes: 0,
        usedToday: 0,
        lastReset: "",
        targetSites: [],
      };
      document.getElementById("dailyLimitEnabledCheckbox").checked = dl.enabled;
      document.getElementById("dailyLimitInput").value = dl.minutes;
      if (dl.targetSites && dl.targetSites.length > 0) {
        document.getElementById("targetSiteInput").value = dl.targetSites[0];
      }
    });
  }

  function renderLimitsTable() {
    const tableBody = document.getElementById("limitsTableBody");
    tableBody.innerHTML = "";
    chrome.storage.local.get(["dailyLimit"], (data) => {
      const dl = data.dailyLimit;
      if (
        !dl ||
        !dl.enabled ||
        !dl.targetSites ||
        dl.targetSites.length === 0
      ) {
        tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;">No sites with daily limits found.</td></tr>`;
        return;
      }
      const today = new Date().toDateString();
      const usedToday = dl.lastReset === today ? dl.usedToday : 0;
      const minutesLeft = Math.max(0, dl.minutes - usedToday);
      let statusText = "Allowed ✅";
      if (minutesLeft === 0) statusText = "Blocked ❌";
      dl.targetSites.forEach((site) => {
        const row = document.createElement("tr");
        row.innerHTML = `
        <td><strong>${site}</strong></td>
        <td>${dl.minutes} minutes</td>
        <td>${usedToday} minutes</td>
        <td><span style="color: ${minutesLeft > 0 ? "green" : "red"}; font-weight: bold;">${minutesLeft} minutes</span></td>
        <td>${statusText}</td>
      `;
        tableBody.appendChild(row);
      });
    });
  }

  document.getElementById("saveDailyLimitBtn").addEventListener("click", () => {
    let isEnabled = document.getElementById(
      "dailyLimitEnabledCheckbox",
    ).checked;
    const minutes = parseInt(
      document.getElementById("dailyLimitInput").value || "0",
    );
    const targetSite = document
      .getElementById("targetSiteInput")
      .value.trim()
      .toLowerCase();
    if (minutes > 0 && targetSite) {
      isEnabled = true;
      document.getElementById("dailyLimitEnabledCheckbox").checked = true;
    }
    if (isEnabled && (!targetSite || minutes <= 0)) {
      return showToast(
        "Please enter the target site and a valid number of minutes (> 0) to enable the limit.",
        "error",
      );
    }
    chrome.storage.local.get(["dailyLimit"], (data) => {
      const existingDl = data.dailyLimit || {};
      const newDl = {
        enabled: isEnabled,
        minutes,
        usedToday: existingDl.usedToday || 0,
        usedTodaySeconds:
          existingDl.usedTodaySeconds !== undefined
            ? existingDl.usedTodaySeconds
            : existingDl.usedToday * 60 || 0,
        lastReset: existingDl.lastReset || new Date().toDateString(),
        targetSites: targetSite ? [targetSite] : existingDl.targetSites || [],
      };
      chrome.storage.local.set({ dailyLimit: newDl }, () => {
        showToast(chrome.i18n.getMessage("dailyLimitSaved"));
        renderLimitsTable();
      });
    });
  });

  function loadEmergencyLock() {
    chrome.storage.local.get(["emergencyLock"], (data) => {});
  }

  document
    .getElementById("enableEmergencyBtn")
    .addEventListener("click", () => {
      chrome.storage.local.set({ emergencyLock: true }, () =>
        showToast("Emergency Lock Enabled!"),
      );
    });

  document
    .getElementById("disableEmergencyBtn")
    .addEventListener("click", () => {
      chrome.storage.local.set({ emergencyLock: false }, () =>
        showToast("Emergency Lock Disabled!"),
      );
    });

  function renderWrongAttempts() {
    const logContainer = document.getElementById("logContainer");
    logContainer.innerHTML = "";
    chrome.storage.local.get(["wrongAttempts"], (data) => {
      const attempts = data.wrongAttempts || [];
      if (attempts.length === 0) {
        const message = chrome.i18n.getMessage("noFailedAttempts");
        logContainer.innerHTML = `<tr><td colspan='2' style='text-align:center;'>${message}</td></tr>`;
        return;
      }
      attempts.reverse().forEach((a) => {
        const row = document.createElement("tr");
        row.innerHTML = `<td>${a.site}</td><td>${a.time}</td>`;
        logContainer.appendChild(row);
      });
    });
  }

  document.getElementById("clearLogBtn").addEventListener("click", () => {
    chrome.storage.local.set({ wrongAttempts: [] }, () => {
      renderWrongAttempts();
    });
  });

  document.getElementById("changePassBtn").addEventListener("click", () => {
    const p1 = document.getElementById("newPassSetting").value;
    const p2 = document.getElementById("confirmPassSetting").value;
    if (!p1 || !p2)
      return showToast(chrome.i18n.getMessage("fillAllFields"), "error");
    if (p1 !== p2)
      return showToast(chrome.i18n.getMessage("passwordsDontMatch"), "error");
    chrome.storage.local.set({ password: p1 }, () =>
      showToast(chrome.i18n.getMessage("passwordChanged")),
    );
  });

  document.getElementById("exportDataBtn").addEventListener("click", () => {
    chrome.storage.local.get(null, (data) => {
      const blob = new Blob([JSON.stringify(data)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "parental-control-backup.json";
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  document.getElementById("importDataBtn").addEventListener("click", () => {
    document.getElementById("importDataInput").click();
  });

  document.getElementById("importDataInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        chrome.storage.local.set(data, () => {
          showToast(chrome.i18n.getMessage("dataImported"));
          location.reload();
        });
      } catch {
        showToast(chrome.i18n.getMessage("invalidFile"), "error");
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("resetExtensionBtn").addEventListener("click", () => {
    if (!confirm(chrome.i18n.getMessage("resetConfirm"))) return;
    chrome.storage.local.clear(() => {
      showToast(chrome.i18n.getMessage("extensionReset"));
      location.reload();
    });
  });
});
