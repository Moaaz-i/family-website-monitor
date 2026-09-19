import { isEntryAllowed, normalizeUrl } from "./lib/url.js";
import { migrateDailyLimit } from "./lib/rules.js";
import {
  verifyPasswordInput,
  createPasswordSpec,
  generateSecureId,
} from "./lib/security.js";
import {
  showToast,
  startLockoutTimer,
  handleLockout,
  applyThemeClass,
} from "./lib/ui.js";
import { signPayload, verifySignature } from "./lib/backup.js";
import {
  WHITELIST_MAX,
  SESSION_DURATION_MS,
  BRUTE_FORCE_THRESHOLD,
  BRUTE_FORCE_LOCKOUT_MS,
  EXTENSIONS_ACCESS_DURATION_MS,
} from "./lib/constants.js";
import { t, onTranslationReady, initTranslations } from "./lib/translator.js";

// Security Feature #11: Anti-Clickjacking Frame Busting
if (window.self !== window.top) {
  document.body.style.display = "none";
  throw new Error("Embedding this page is forbidden for security reasons.");
}

function applyTheme(theme) {
  document.body.classList.toggle("dark", theme === "dark");
  const key = theme === "dark" ? "themeToggleLight" : "themeToggleDark";
  const themeToggleBtn = document.getElementById("themeToggleBtn");
  if (themeToggleBtn) themeToggleBtn.textContent = t(key);
  chrome.storage.local.set({ theme });
}

// Make Light Mode the default (always fallback to Light)
applyThemeClass();

initTranslations();

onTranslationReady(() => {
  const setupSection = document.getElementById("setupSection");
  const loginSection = document.getElementById("loginSection");
  const dashboardSection = document.getElementById("dashboardSection");
  const whitelistContainer = document.getElementById("whitelistContainer");

  const urlParams = new URLSearchParams(window.location.search);
  const targetParam = urlParams.get("target");

  function migrateWhitelist(list) {
    return list
      .map((entry) => {
        if (entry.fullUrl) return entry;
        if (entry.domain) {
          return {
            id: entry.id || generateSecureId(),
            fullUrl: `https://${entry.domain}`.replace(/\/+$/, ""),
            addedAt: entry.addedAt || Date.now(),
          };
        }
        if (typeof entry === "string") {
          const clean = normalizeUrl(entry);
          if (clean) {
            return {
              id: generateSecureId(),
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
      const exists = whitelist.some((e) => isEntryAllowed(cleanUrl, e));
      if (!exists) {
        if (whitelist.length >= WHITELIST_MAX) {
          showToast("Whitelist capacity limit (max 1000 items) exceeded", "error");
          return openDashboard();
        }
        whitelist.push({
          id: generateSecureId(),
          fullUrl: cleanUrl,
          addedAt: Date.now(),
        });
      }
      chrome.storage.local.set({ whitelist }, () => {
        window.location.replace(cleanUrl);
      });
    });
  }

  // Initial routing based on password existence and active session
  chrome.storage.local.get(["password", "sessionToken", "sessionExpiry"], (data) => {
    if (!data.password) {
      chrome.storage.sync.get(["password"], (syncData) => {
        if (syncData && syncData.password) {
          chrome.storage.local.set({ password: syncData.password }, () => {
            location.reload();
          });
        } else {
          setupSection.style.display = "block";
        }
      });
    } else {
      const now = Date.now();
      if (data.sessionToken && data.sessionExpiry > now) {
        // Direct access if parent session is active
        redirectToTarget();
      } else {
        loginSection.style.display = "block";
        const loginInput = document.getElementById("loginPassword");
        const loginButton = document.getElementById("loginBtn");
        handleLockout(loginInput, loginButton, "loginPasswordPlaceholder");
      }
    }
  });

  // Security Feature #4: Session Auto-Lock on tab hide / blur
  function reLockOnFocus() {
    if (dashboardSection.style.display === "flex" || dashboardSection.style.display === "block") {
      // Clear session from storage
      chrome.storage.local.set({ sessionToken: null, sessionExpiry: 0 }, () => {
        document.body.classList.remove("has-dashboard");
        dashboardSection.style.display = "none";
        loginSection.style.display = "block";
        const loginInput = document.getElementById("loginPassword");
        loginInput.value = "";
        loginInput.focus();
        handleLockout(loginInput, document.getElementById("loginBtn"), "loginPasswordPlaceholder");
      });
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      reLockOnFocus();
    }
  });

  // Setup password listener
  document.getElementById("saveSetupBtn").addEventListener("click", async () => {
    const p1 = document.getElementById("newPassword").value;
    const p2 = document.getElementById("confirmPassword").value;
    if (!p1 || !p2) return;
    if (p1 !== p2)
      return showToast(t("passwordsDontMatch"), "error");

    // Hash password before saving
    const passwordSpec = await createPasswordSpec(p1);

    chrome.storage.local.set({ password: passwordSpec, whitelist: [] }, () => {
      chrome.storage.sync.set({ password: passwordSpec }, () => {
        setupSection.style.display = "none";

        // Initialize parental session token
        const sessionToken = generateSecureId() + Date.now().toString(36);
        chrome.storage.local.set({ sessionToken, sessionExpiry: Date.now() + SESSION_DURATION_MS }, () => {
          redirectToTarget();
        });
      });
    });
  });

  // Login handler
  document.getElementById("loginBtn").addEventListener("click", async () => {
    const pass = document.getElementById("loginPassword").value;
    const loginInput = document.getElementById("loginPassword");
    const loginButton = document.getElementById("loginBtn");

    chrome.storage.local.get(["password", "failedAttemptsCount", "wrongAttempts"], async (data) => {
      const correct = await verifyPasswordInput(pass, data.password);
      if (correct) {
        // Reset brute-force tracking
        chrome.storage.local.set({ failedAttemptsCount: 0, lockoutExpiry: 0 });

        // Auto-upgrade password storage format if it was legacy plaintext
        if (!data.password.startsWith("sha256$")) {
          const upgradedSpec = await createPasswordSpec(pass);
          chrome.storage.local.set({ password: upgradedSpec });
        }

        // Save parenting session token
        const sessionToken = generateSecureId() + Date.now().toString(36);
        chrome.storage.local.set({ sessionToken, sessionExpiry: Date.now() + SESSION_DURATION_MS }, () => {
          loginSection.style.display = "none";
          redirectToTarget();
        });
      } else {
        const attemptsCount = (data.failedAttemptsCount || 0) + 1;
        const updates = { failedAttemptsCount: attemptsCount };

        if (attemptsCount >= BRUTE_FORCE_THRESHOLD) {
          const lockoutExpiryTime = Date.now() + BRUTE_FORCE_LOCKOUT_MS;
          updates.lockoutExpiry = lockoutExpiryTime;
          startLockoutTimer(loginInput, loginButton, lockoutExpiryTime, "loginPasswordPlaceholder");
        }

        const attempt = {
          site: "Control Panel Login",
          time: new Date().toLocaleString("en-US"),
        };
        const wrongAttempts = data.wrongAttempts || [];
        wrongAttempts.push(attempt);
        if (wrongAttempts.length > 100) wrongAttempts.shift();
        updates.wrongAttempts = wrongAttempts;

        chrome.storage.local.set(updates, () => {
          showToast(t("passwordIncorrect"), "error");
          loginInput.value = "";
          loginInput.focus();
        });
      }
    });
  });

  // Check and lock options inputs if session token has expired
  function verifyActiveSession(callback) {
    chrome.storage.local.get(["sessionExpiry"], (data) => {
      if (!data.sessionExpiry || data.sessionExpiry < Date.now()) {
        showToast("Session expired. Please log in again.", "error");
        reLockOnFocus();
      } else {
        // Refresh session expiry (rolling session)
        chrome.storage.local.set({ sessionExpiry: Date.now() + SESSION_DURATION_MS });
        if (callback) callback();
      }
    });
  }

  // Extensions settings access 20-minute countdown system
  let extensionsInterval = null;

  function updateExtensionsTimer() {
    chrome.storage.local.get(["extensionsAccessExpiry"], (data) => {
      const expiry = data.extensionsAccessExpiry || 0;
      const now = Date.now();
      const display = document.getElementById("extensionsTimerDisplay");
      const btn = document.getElementById("allowExtensionsBtn");

      if (expiry > now) {
        const diff = expiry - now;
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        const timeStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

        display.style.display = "block";
        display.textContent = t("timeLeft", timeStr);

        // Show as Lock button
        btn.textContent = t("lockExtensionsButton") || "Lock Access Now";
        btn.className = "btn btn-danger";

        if (!extensionsInterval) {
          extensionsInterval = setInterval(updateExtensionsTimer, 1000);
        }
      } else {
        display.style.display = "none";

        // Show as Allow button
        btn.textContent = t("allowExtensionsButton") || "Allow Access (20 Minutes)";
        btn.className = "btn btn-primary";

        if (extensionsInterval) {
          clearInterval(extensionsInterval);
          extensionsInterval = null;
        }
      }
    });
  }

  function openDashboard() {
    document.body.classList.add("has-dashboard");
    dashboardSection.style.display = "flex";
    loadSchedule();
    loadDailyLimit();
    loadEmergencyLock();
    renderWhitelist();
    renderWrongAttempts();
    renderLimitsTable();
    updateExtensionsTimer();

    // Security feature #9: Warn if Incognito mode access is not enabled
    chrome.extension.isAllowedIncognitoAccess((isAllowed) => {
      if (!isAllowed) {
        showToast("Warning: Extension is disabled in Incognito mode. Enable it in extension settings to prevent bypasses.", "warning");
      }
    });

    const languageSelector = document.getElementById("languageSelector");
    languageSelector.addEventListener("change", () => {
      verifyActiveSession(() => {
        const newLang = languageSelector.value;
        chrome.storage.local.set({ language: newLang }, () => {
          location.reload();
        });
      });
    });

    const themeToggleBtn = document.getElementById("themeToggleBtn");
    themeToggleBtn.addEventListener("click", () => {
      verifyActiveSession(() => {
        const currentTheme = document.body.classList.contains("dark")
          ? "dark"
          : "light";
        applyTheme(currentTheme === "dark" ? "light" : "dark");
      });
    });

    // Allow extensions access for 20 minutes / Lock access manually
    const allowExtensionsBtn = document.getElementById("allowExtensionsBtn");
    allowExtensionsBtn.addEventListener("click", () => {
      verifyActiveSession(() => {
        chrome.storage.local.get(["extensionsAccessExpiry"], (store) => {
          const now = Date.now();
          const expiry = store.extensionsAccessExpiry || 0;

          if (expiry > now) {
            // Lock access now
            chrome.storage.local.set({ extensionsAccessExpiry: 0 }, () => {
              showToast(t("accessLockedToast"), "success");
              updateExtensionsTimer();

              // Force block active extensions tab immediately
              chrome.tabs.query({}, (tabs) => {
                if (chrome.runtime.lastError || !tabs) return;
                tabs.forEach((tab) => {
                  const currentUrl = tab.url || tab.pendingUrl || "";
                  if (
                    currentUrl.startsWith("chrome://extensions") ||
                    currentUrl.includes("chrome://extensions/") ||
                    currentUrl.startsWith("chrome://settings/system") ||
                    currentUrl.startsWith("chrome://settings/extensions")
                  ) {
                    chrome.tabs.update(tab.id, {
                      url: chrome.runtime.getURL("blocked-extensions.html"),
                    });
                  }
                });
              });
            });
          } else {
            // Allow access for 20 minutes
            const accessExpiry = Date.now() + EXTENSIONS_ACCESS_DURATION_MS;
            chrome.storage.local.set({ extensionsAccessExpiry: accessExpiry }, () => {
              showToast(t("accessAllowedToast"), "success");
              updateExtensionsTimer();
            });
          }
        });
      });
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

  // Populate whitelist securely without innerHTML
  function renderWhitelist() {
    whitelistContainer.textContent = "";
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      let whitelist = migrateWhitelist(data.whitelist);
      chrome.storage.local.set({ whitelist });

      if (whitelist.length === 0) {
        const li = document.createElement("li");
        li.textContent = t("noSitesAdded");
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
        span.style.flex = "1";

        const domainToggle = createDomainToggle(entry);

        const button = document.createElement("button");
        button.textContent = t("deleteButton");
        button.className = "btn btn-danger";
        button.setAttribute("data-url", entry.fullUrl);

        li.append(span, domainToggle, button);
        whitelistContainer.appendChild(li);
      });
    });
  }

  // Whole-domain switch shown next to every whitelisted site
  function createDomainToggle(entry) {
    const label = document.createElement("label");
    label.className = "whole-domain-toggle";
    label.title = entry.fullUrl;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = entry.mode === "domain";
    checkbox.addEventListener("change", () => {
      entry.mode = checkbox.checked ? "domain" : "exact";
      chrome.storage.local.get({ whitelist: [] }, (data) => {
        let whitelist = migrateWhitelist(data.whitelist);
        const target = whitelist.find((e) => e.id === entry.id) || whitelist.find((e) => isEntryAllowed(entry.fullUrl, e));
        if (!target) return;
        target.mode = checkbox.checked ? "domain" : "exact";
        chrome.storage.local.set({ whitelist }, () => {
          renderWhitelist();
          showToast(
            checkbox.checked ? t("wholeDomainEnabled") : t("wholeDomainDisabled"),
            checkbox.checked ? "success" : "info",
          );
        });
      });
    });

    const slider = document.createElement("span");
    slider.className = "switch-slider";

    const text = document.createElement("span");
    text.textContent = t("wholeDomainLabel") || "Whole domain";

    label.append(checkbox, slider, text);
    return label;
  }

  document.addEventListener("click", (e) => {
    if (!e.target.classList.contains("btn-danger")) return;
    const url = e.target.getAttribute("data-url");
    if (url) {
      verifyActiveSession(() => {
        removeSite(url);
      });
    }
  });

  document.getElementById("addSiteBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      const input = document.getElementById("newSiteInput").value.trim();
      const cleanUrl = normalizeUrl(input);
      if (!cleanUrl)
        return showToast(t("invalidUrl"), "error");

      chrome.storage.local.get({ whitelist: [] }, (data) => {
        let whitelist = migrateWhitelist(data.whitelist);

        if (whitelist.some((e) => isEntryAllowed(cleanUrl, e))) {
          return showToast(t("siteAlreadyWhitelisted"), "error");
        }

        // Whitelist size cap (Security Feature #18)
        if (whitelist.length >= WHITELIST_MAX) {
          return showToast("Whitelist storage capacity exceeded (max 1000 items)", "error");
        }

        const wholeDomain = document.getElementById("domainWhitelistCheckbox").checked;
        whitelist.push({
          id: generateSecureId(),
          fullUrl: cleanUrl,
          addedAt: Date.now(),
          mode: wholeDomain ? "domain" : "exact",
        });
        chrome.storage.local.set({ whitelist }, () => {
          document.getElementById("newSiteInput").value = "";
          document.getElementById("domainWhitelistCheckbox").checked = false;
          renderWhitelist();
          showToast(t("siteAddedSuccess"), "success");
        });
      });
    });
  });

  function removeSite(url) {
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      let whitelist = migrateWhitelist(data.whitelist);
      whitelist = whitelist.filter((e) => !isEntryAllowed(url, e));
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

      const enabledCheckbox = document.getElementById("scheduleEnabledCheckbox");
      if (enabledCheckbox) enabledCheckbox.checked = schedule.enabled;

      schedule.days.forEach((v, i) => {
        const checkbox = document.getElementById("day" + i);
        if (checkbox) checkbox.checked = (v === true || v === "true");
      });
      document.getElementById("startTime").value = schedule.startTime;
      document.getElementById("endTime").value = schedule.endTime;
    });
  }

  document.getElementById("saveScheduleBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      const isEnabled = document.getElementById("scheduleEnabledCheckbox").checked;
      const days = [];
      for (let i = 0; i < 7; i++) {
        days.push(document.getElementById("day" + i).checked);
      }
      const startTimeInput = document.getElementById("startTime").value || "00:00";
      const endTimeInput = document.getElementById("endTime").value || "23:59";
      const schedule = {
        enabled: isEnabled,
        days,
        startTime: startTimeInput,
        endTime: endTimeInput,
      };
      chrome.storage.local.set({ schedule }, () => {
        showToast(t("scheduleSaved"));
      });
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

  // Populate limits table securely without innerHTML (Security Feature #5)
  function renderLimitsTable() {
    const tableBody = document.getElementById("limitsTableBody");
    tableBody.textContent = "";
    chrome.storage.local.get(["dailyLimit"], (data) => {
      const dl = migrateDailyLimit(data.dailyLimit);
      const sites = dl.sites || {};
      const siteKeys = Object.keys(sites);

      if (!dl.enabled || siteKeys.length === 0) {
        const row = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 6;
        td.style.textAlign = "center";
        td.textContent = "No sites with daily limits found.";
        row.appendChild(td);
        tableBody.appendChild(row);
        return;
      }

      const today = new Date().toDateString();

      siteKeys.forEach((site) => {
        const siteData = sites[site];
        const usedTodaySeconds = siteData.lastReset === today ? siteData.usedTodaySeconds || 0 : 0;
        const usedTodayMinutes = Math.floor(usedTodaySeconds / 60);
        const minutesLeft = Math.max(0, siteData.minutes - usedTodayMinutes);
        const statusText = minutesLeft > 0 ? "Allowed ✅" : "Blocked ❌";

        const row = document.createElement("tr");

        const tdSite = document.createElement("td");
        const strongSite = document.createElement("strong");
        strongSite.textContent = site;
        tdSite.appendChild(strongSite);

        const tdLimit = document.createElement("td");
        tdLimit.textContent = `${siteData.minutes} ${t("minutesPlaceholder") || "Minutes"}`;

        const tdUsed = document.createElement("td");
        tdUsed.textContent = `${usedTodayMinutes} ${t("minutesPlaceholder") || "Minutes"}`;

        const tdRemaining = document.createElement("td");
        const spanRem = document.createElement("span");
        spanRem.textContent = `${minutesLeft} ${t("minutesPlaceholder") || "Minutes"}`;
        spanRem.style.color = minutesLeft > 0 ? "green" : "red";
        spanRem.style.fontWeight = "bold";
        tdRemaining.appendChild(spanRem);

        const tdStatus = document.createElement("td");
        tdStatus.textContent = statusText;

        const tdAction = document.createElement("td");
        const btnDelete = document.createElement("button");
        btnDelete.className = "btn btn-danger btn-sm";
        btnDelete.style.padding = "4px 8px";
        btnDelete.style.fontSize = "12px";
        btnDelete.textContent = t("deleteButton") || "Delete";
        btnDelete.addEventListener("click", () => {
          verifyActiveSession(() => {
            chrome.storage.local.get(["dailyLimit"], (data) => {
              const currentDl = migrateDailyLimit(data.dailyLimit);
              if (currentDl.sites && currentDl.sites[site]) {
                delete currentDl.sites[site];
                chrome.storage.local.set({ dailyLimit: currentDl }, () => {
                  renderLimitsTable();
                  showToast("Limit removed for " + site, "success");
                });
              }
            });
          });
        });
        tdAction.appendChild(btnDelete);

        row.append(tdSite, tdLimit, tdUsed, tdRemaining, tdStatus, tdAction);
        tableBody.appendChild(row);
      });
    });
  }

  document.getElementById("saveDailyLimitBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      let isEnabled = document.getElementById("dailyLimitEnabledCheckbox").checked;
      const minutes = parseInt(document.getElementById("dailyLimitInput").value || "0", 10);
      const targetSite = document.getElementById("targetSiteInput").value.trim().toLowerCase();

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
        const dl = migrateDailyLimit(data.dailyLimit);
        dl.enabled = isEnabled;

        if (targetSite && minutes > 0) {
          dl.sites[targetSite] = {
            minutes: minutes,
            usedTodaySeconds: dl.sites[targetSite] ? dl.sites[targetSite].usedTodaySeconds || 0 : 0,
            lastReset: dl.sites[targetSite] ? dl.sites[targetSite].lastReset || new Date().toDateString() : new Date().toDateString()
          };
        }

        chrome.storage.local.set({ dailyLimit: dl }, () => {
          showToast(t("dailyLimitSaved"));
          renderLimitsTable();
          // Clear inputs
          document.getElementById("targetSiteInput").value = "";
          document.getElementById("dailyLimitInput").value = "";
        });
      });
    });
  });

  function loadEmergencyLock() {
    chrome.storage.local.get(["emergencyLock"], (data) => {});
  }

  document
    .getElementById("enableEmergencyBtn")
    .addEventListener("click", () => {
      verifyActiveSession(() => {
        chrome.storage.local.set({ emergencyLock: true }, () =>
          showToast(t("emergencyLockEnabled")),
        );
      });
    });

  document
    .getElementById("disableEmergencyBtn")
    .addEventListener("click", () => {
      verifyActiveSession(() => {
        chrome.storage.local.set({ emergencyLock: false }, () =>
          showToast(t("emergencyLockDisabled")),
        );
      });
    });

  // Populate logs safely without innerHTML
  function renderWrongAttempts() {
    const logContainer = document.getElementById("logContainer");
    logContainer.textContent = "";
    chrome.storage.local.get(["wrongAttempts"], (data) => {
      const attempts = data.wrongAttempts || [];
      if (attempts.length === 0) {
        const row = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 2;
        td.style.textAlign = "center";
        td.textContent = t("noFailedAttempts");
        row.appendChild(td);
        logContainer.appendChild(row);
        return;
      }
      attempts.slice().reverse().forEach((a) => {
        const row = document.createElement("tr");

        const tdSite = document.createElement("td");
        tdSite.textContent = a.site;

        const tdTime = document.createElement("td");
        tdTime.textContent = a.time;

        row.append(tdSite, tdTime);
        logContainer.appendChild(row);
      });
    });
  }

  document.getElementById("clearLogBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      chrome.storage.local.set({ wrongAttempts: [] }, () => {
        renderWrongAttempts();
      });
    });
  });

  document.getElementById("changePassBtn").addEventListener("click", () => {
    verifyActiveSession(async () => {
      const p1 = document.getElementById("newPassSetting").value;
      const p2 = document.getElementById("confirmPassSetting").value;
      if (!p1 || !p2)
        return showToast(t("fillAllFields"), "error");
      if (p1 !== p2)
        return showToast(t("passwordsDontMatch"), "error");

      const newHash = await createPasswordSpec(p1);
      chrome.storage.local.set({ password: newHash }, () => {
        chrome.storage.sync.set({ password: newHash }, () => {
          showToast(t("passwordChanged"));
          document.getElementById("newPassSetting").value = "";
          document.getElementById("confirmPassSetting").value = "";
        });
      });
    });
  });

  // Backup Export: Obfuscate & Sign Backup (Security Feature #10)
  document.getElementById("exportDataBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      chrome.storage.local.get(null, async (data) => {
        // Prevent session tokens and lockout status from leak in export
        const cleanData = { ...data };
        delete cleanData.sessionToken;
        delete cleanData.sessionExpiry;
        delete cleanData.failedAttemptsCount;
        delete cleanData.lockoutExpiry;

        const signature = await signPayload(cleanData);

        const exportObj = {
          payload: cleanData,
          signature: signature
        };

        const blob = new Blob([JSON.stringify(exportObj)], {
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
  });

  document.getElementById("importDataBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      document.getElementById("importDataInput").click();
    });
  });

  // Backup Import: Validate signatures and check strict schemas (Security Feature #9 & #10)
  document.getElementById("importDataInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataObj = JSON.parse(reader.result);
        let payload = null;
        if (dataObj && typeof dataObj === "object" && dataObj.payload && dataObj.signature) {
          const valid = await verifySignature(dataObj.payload, dataObj.signature);
          if (!valid) {
            throw new Error("Signature verification failed. Tampering detected.");
          }
          payload = dataObj.payload;
        } else if (dataObj && typeof dataObj === "object" && dataObj.password) {
          // Legacy backup import fallback
          payload = dataObj;
        } else {
          throw new Error("Invalid structure");
        }

        // Schema checks
        if (!payload.password) throw new Error("Missing password");
        if (payload.whitelist && !Array.isArray(payload.whitelist)) throw new Error("Invalid whitelist");

        chrome.storage.local.set(payload, () => {
          chrome.storage.sync.set({ password: payload.password }, () => {
            showToast(t("dataImported"));
            location.reload();
          });
        });
      } catch (err) {
        console.error("Settings import check failed:", err);
        showToast(t("invalidFile"), "error");
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("resetExtensionBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      if (!confirm(t("resetConfirm"))) return;
      chrome.storage.local.clear(() => {
        chrome.storage.sync.clear(() => {
          showToast(t("extensionReset"));
          location.reload();
        });
      });
    });
  });
});