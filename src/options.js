import { isEntryAllowed, normalizeUrl, isValidRedirectTarget } from "./lib/url.js";
import {
  migrateDailyLimit,
  migrateScreenTime,
  screenTimeUsedSeconds,
  isWithinSchedule,
  BLOCKLIST_MIN_KEYWORD,
} from "./lib/rules.js";
import { SYNC_MAX_CHUNKS, SYNC_CHUNK_SIZE } from "./lib/sync-codec.js";
import { BLOCK_PRESETS, SAFE_PRESETS, mergeIntoKeywords } from "./lib/presets.js";
import { createPasswordSpec, generateSecureId, generateSessionToken } from "./lib/security.js";
import { showToast, startLockoutTimer, handleLockout, applyThemeClass } from "./lib/ui.js";
import { signPayload, verifySignature } from "./lib/backup.js";
import { WHITELIST_MAX, SESSION_DURATION_MS, EXTENSIONS_ACCESS_DURATION_MS } from "./lib/constants.js";
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
  const intentParam = urlParams.get("intent");
  const intentUrlParam = urlParams.get("url");

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
    if (!targetParam) {
      openDashboard();
      handleContextIntent();
      return;
    }
    // URLSearchParams.get() already decoded once. Validate the scheme: an
    // options.html?target=javascript:... link would otherwise run arbitrary
    // script in the extension origin.
    const cleanUrl = isValidRedirectTarget(targetParam) ? normalizeUrl(targetParam) : null;
    if (!cleanUrl) return openDashboard();
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      const whitelist = migrateWhitelist(data.whitelist);
      const exists = whitelist.some((e) => isEntryAllowed(cleanUrl, e));
      if (!exists) {
        if (whitelist.length >= WHITELIST_MAX) {
          showToast(t("whitelistCapacityError"), "error");
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

  // Right-click -> "Allow this site" / "Block this site": the panel opens on
  // the right list with the field filled in. Nothing is written here — the
  // parent still presses Add, and none of this runs before the login screen.
  function handleContextIntent() {
    if (intentParam !== "allow" && intentParam !== "block") return;
    const raw = intentUrlParam || "";
    const clean = isValidRedirectTarget(raw) ? normalizeUrl(raw) : null;
    if (!clean) return;

    const isAllow = intentParam === "allow";
    const tabBtn = document.querySelector(
      `.tab-link[data-tab="${isAllow ? "tab-whitelist" : "tab-blocklist"}"]`,
    );
    if (tabBtn) tabBtn.click();

    const input = document.getElementById(isAllow ? "newSiteInput" : "newKeywordInput");
    if (input) {
      if (isAllow) {
        input.value = clean;
      } else {
        // The blocklist speaks keywords; the host is the one it means.
        try {
          input.value = new URL(clean).hostname.replace(/^www\./, "") || clean;
        } catch {
          input.value = clean;
        }
      }
      input.focus();
    }
    showToast(t(isAllow ? "intentAllowHint" : "intentBlockHint"), "info");
  }

  // Initial routing based on password existence and active session
  chrome.storage.local.get(["password", "sessionToken", "sessionExpiry"], (data) => {
    if (!data.password) {
      // The hash is intentionally NOT mirrored to chrome.storage.sync — sync
      // uploads it to Google's servers. If local storage is wiped, the parent
      // sets a new password instead of silently pulling one from the cloud.
      setupSection.style.display = "block";
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
    if (p1 !== p2) return showToast(t("passwordsDontMatch"), "error");
    if (p1.length < 6) return showToast(t("passwordTooShort"), "error");

    // Hash password before saving (PBKDF2 — local storage only)
    const passwordSpec = await createPasswordSpec(p1);

    chrome.storage.local.set({ password: passwordSpec, whitelist: [] }, () => {
      setupSection.style.display = "none";

      const sessionToken = generateSessionToken();
      chrome.storage.local.set(
        { sessionToken, sessionExpiry: Date.now() + SESSION_DURATION_MS },
        () => {
          // Fresh install: run the one-screen wizard first. Repeat setups
          // (password reset) go straight to the panel.
          chrome.storage.local.get(["onboardingDone"], (state) => {
            if (state.onboardingDone) return redirectToTarget();
            showOnboarding();
          });
        },
      );
    });
  });

  // Login handler — verification, lockout and the attempt log all live in the
  // service worker so this page never touches the stored hash.
  document.getElementById("loginBtn").addEventListener("click", () => {
    const loginInput = document.getElementById("loginPassword");
    const loginButton = document.getElementById("loginBtn");
    const pass = loginInput.value;
    if (!pass) return;

    chrome.runtime.sendMessage(
      { type: "verifyParentPassword", password: pass, site: "Control Panel Login" },
      (res) => {
        if (!res) return;

        if (res.ok) {
          loginSection.style.display = "none";
          loginInput.value = "";
          redirectToTarget();
          return;
        }

        if (res.lockoutExpiry && res.lockoutExpiry > Date.now()) {
          startLockoutTimer(loginInput, loginButton, res.lockoutExpiry, "loginPasswordPlaceholder");
        }

        showToast(t("passwordIncorrect"), "error");
        loginInput.value = "";
        loginInput.focus();
      },
    );
  });

  // Check and lock options inputs if session token has expired
  function verifyActiveSession(callback) {
    chrome.storage.local.get(["sessionExpiry"], (data) => {
      if (!data.sessionExpiry || data.sessionExpiry < Date.now()) {
        showToast(t("sessionExpiredError"), "error");
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

  // ── Incognito bypass protection ──────────────────────────────────────────
  // Chrome never runs an extension in Incognito windows unless the parent
  // flips "Allow in Incognito". This surfaces that state and opens the exact
  // settings page (with our own 20-minute extension-page access granted, so
  // the guard does not bounce the parent straight back out).
  function updateIncognitoStatus() {
    const statusEl = document.getElementById("incognitoStatus");
    const btn = document.getElementById("enableIncognitoBtn");
    if (!statusEl || !btn || !chrome.extension.isAllowedIncognitoAccess) return;

    chrome.extension.isAllowedIncognitoAccess((isAllowed) => {
      statusEl.textContent = isAllowed ? t("incognitoOn") : t("incognitoOff");
      statusEl.style.color = isAllowed ? "var(--success-solid)" : "var(--danger-solid)";
      btn.textContent = isAllowed ? t("incognitoRecheck") : t("incognitoButton");
      btn.className = isAllowed ? "btn btn-secondary" : "btn btn-primary";
    });
  }

  document.getElementById("enableIncognitoBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      chrome.storage.local.get(["extensionsAccessExpiry"], (store) => {
        const now = Date.now();
        const expiry = store.extensionsAccessExpiry || 0;
        const grant = expiry > now ? expiry : now + EXTENSIONS_ACCESS_DURATION_MS;
        chrome.storage.local.set({ extensionsAccessExpiry: grant }, () => {
          updateExtensionsTimer();
          chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
        });
      });
    });
  });

  // ── First-run wizard ─────────────────────────────────────────────────────
  // One screen, three decisions (what to block, how much time, done). It runs
  // once — `onboardingDone` is a local flag — and never blocks access to the
  // full panel: "Skip" applies nothing and still opens the dashboard.
  function showOnboarding() {
    const section = document.getElementById("onboardingSection");
    if (!section) return redirectToTarget();
    setupSection.style.display = "none";
    section.style.display = "block";
    renderOnboardingPacks();
  }

  function renderOnboardingPacks() {
    const container = document.getElementById("onboardingPackContainer");
    container.textContent = "";

    BLOCK_PRESETS.forEach((preset) => {
      const row = document.createElement("label");
      row.className = "onboarding-pack";
      row.title = preset.domains.join(", ");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = preset.id;
      // Pre-ticked for the two categories parents block first; the rest stay
      // off so nothing is enforced that nobody asked for.
      checkbox.checked = preset.id === "social" || preset.id === "video";

      const label = document.createElement("span");
      label.textContent = t(preset.labelKey);

      const count = document.createElement("small");
      count.textContent = String(preset.domains.length);

      row.append(checkbox, label, count);
      container.appendChild(row);
    });
  }

  function finishOnboarding(applyChoices) {
    const minutesInput = document.getElementById("onboardingMinutes");
    const minutes = parseInt(minutesInput ? minutesInput.value || "0" : "0", 10);
    const validMinutes = Number.isFinite(minutes) && minutes >= 5 && minutes <= 1440;

    const domains = applyChoices
      ? Array.from(
          document.querySelectorAll("#onboardingPackContainer input:checked"),
        ).flatMap((checkbox) => {
          const preset = BLOCK_PRESETS.find((p) => p.id === checkbox.value);
          return preset ? preset.domains : [];
        })
      : [];

    chrome.storage.local.get(["blockedKeywords"], (data) => {
      const base = Array.isArray(data.blockedKeywords) ? data.blockedKeywords : [];
      const merged = domains.length ? mergeIntoKeywords(base, domains) : { changed: false, list: base };
      const updates = { blockedKeywords: merged.list, onboardingDone: true };

      if (applyChoices && validMinutes) {
        updates.screenTime = {
          enabled: true,
          minutes,
          usedSeconds: 0,
          lastReset: new Date().toDateString(),
        };
      }

      chrome.storage.local.set(updates, () => {
        const section = document.getElementById("onboardingSection");
        if (section) section.style.display = "none";
        if (applyChoices) showToast(t("onboardingSaved"), "success");
        redirectToTarget();
      });
    });
  }

  document.getElementById("onboardingFinishBtn").addEventListener("click", () => {
    finishOnboarding(true);
  });

  document.getElementById("onboardingSkipBtn").addEventListener("click", () => {
    finishOnboarding(false);
  });

  function openDashboard() {
    document.body.classList.add("has-dashboard");
    dashboardSection.style.display = "flex";
    loadSchedule();
    loadDailyLimit();
    loadScreenTime();
    loadSyncStatus();
    loadPinStatus();
    loadEmergencyLock();
    renderWhitelist();
    renderBlocklist();
    renderStatusStrip();
    renderPresets();
    loadReport();
    loadNotifications();
    loadEmbedGuard();
    loadSearchFilter();
    loadSafeSearch();
    loadBlockedMessage();
    loadDigest();
    updatePauseStatus();
    renderWrongAttempts();
    renderLimitsTable();
    updateExtensionsTimer();
    updateIncognitoStatus();

    // Security feature #9: Warn if Incognito mode access is not enabled
    chrome.extension.isAllowedIncognitoAccess((isAllowed) => {
      if (!isAllowed) {
        showToast(t("incognitoWarning"), "warning");
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

  // Tab switching is a roving-tabindex tablist: arrow keys move between tabs,
  // Enter/Space activate, and the active tab is the only one in the tab order.
  function activateTab(selected) {
    const tabId = selected.getAttribute("data-tab");
    document.querySelectorAll(".tab-link").forEach((link) => {
      const isActive = link === selected;
      link.classList.toggle("active", isActive);
      link.setAttribute("aria-selected", String(isActive));
      link.setAttribute("tabindex", isActive ? "0" : "-1");
    });
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    const panel = document.getElementById(tabId);
    if (panel) panel.classList.add("active");
    renderStatusStrip();
  }

  document.addEventListener("click", (e) => {
    const link = e.target.closest && e.target.closest(".tab-link");
    if (link) activateTab(link);
  });

  document.addEventListener("keydown", (e) => {
    const link = e.target.closest && e.target.closest(".tab-link");
    if (!link) return;

    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      activateTab(link);
      return;
    }

    const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
    const backward = e.key === "ArrowUp" || e.key === "ArrowLeft";
    if (!forward && !backward) return;

    e.preventDefault();
    const links = Array.from(document.querySelectorAll(".tab-link"));
    const index = links.indexOf(link);
    const next = links[(index + (forward ? 1 : -1) + links.length) % links.length];
    activateTab(next);
    next.focus();
  });

  // Populate whitelist securely without innerHTML
  // Filtering: typing narrows the visible rows without touching storage.
  document.getElementById("whitelistSearch").addEventListener(
    "input",
    debounce((e) => {
      whitelistQuery = String(e.target.value || "").trim().toLowerCase();
      renderWhitelist();
    }, 150),
  );

  document.getElementById("blocklistSearch").addEventListener(
    "input",
    debounce((e) => {
      blocklistQuery = String(e.target.value || "").trim().toLowerCase();
      renderBlocklist();
    }, 150),
  );

  // Long lists are filtered client-side: a 1000-entry whitelist has to stay
  // usable without pagination round-trips through storage.
  let whitelistQuery = "";
  let blocklistQuery = "";

  function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function matchesQuery(value, query) {
    if (!query) return true;
    return String(value).toLowerCase().includes(query);
  }

  function renderCount(elId, shown, total) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = total === 0 ? "" : t("listCount", String(shown), String(total));
  }

  function renderWhitelist() {
    whitelistContainer.textContent = "";
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      const whitelist = migrateWhitelist(data.whitelist);
      chrome.storage.local.set({ whitelist });

      const visible = whitelist.filter((entry) => matchesQuery(entry.fullUrl, whitelistQuery));
      renderCount("whitelistCount", visible.length, whitelist.length);

      if (whitelist.length === 0) {
        const li = document.createElement("li");
        li.textContent = t("noSitesAdded");
        whitelistContainer.appendChild(li);
        return;
      }
      if (visible.length === 0) {
        const li = document.createElement("li");
        li.className = "empty-state";
        li.textContent = t("noMatches");
        whitelistContainer.appendChild(li);
        return;
      }
      visible.forEach((entry) => {
        const li = document.createElement("li");
        li.className = "list-row";

        // The domain is the headline a parent scans; the path drops to a
        // footnote, because nobody reads a full URL in a list.
        const { host, path } = splitUrlForDisplay(entry.fullUrl);
        const main = document.createElement("div");
        main.className = "list-main";

        const label = document.createElement("span");
        label.className = "list-label";
        label.textContent = host;
        label.title = entry.fullUrl;
        main.appendChild(label);

        if (path) {
          const sub = document.createElement("span");
          sub.className = "list-sub";
          sub.textContent = path;
          sub.title = entry.fullUrl;
          main.appendChild(sub);
        }

        const badge = createModeBadge(entry);

        const button = document.createElement("button");
        button.textContent = t("deleteButton");
        button.className = "btn-remove";
        button.title = t("deleteButton");
        button.setAttribute("data-url", entry.fullUrl);

        li.append(main, badge, button);
        whitelistContainer.appendChild(li);
      });
    });
  }

  // Scope shown as a chip instead of a switch: one click flips it, and the
  // colour answers "is the whole site open?" without reading a sentence.
  function createModeBadge(entry) {
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "mode-badge";
    badge.title = entry.fullUrl;

    const paint = () => {
      const domain = entry.mode === "domain";
      badge.dataset.mode = domain ? "domain" : "exact";
      badge.textContent = domain ? t("wholeDomainLabel") : t("modeExact");
      badge.setAttribute("aria-pressed", String(domain));
    };
    paint();

    badge.addEventListener("click", () => {
      const next = entry.mode === "domain" ? "exact" : "domain";
      chrome.storage.local.get({ whitelist: [] }, (data) => {
        const whitelist = migrateWhitelist(data.whitelist);
        const target = whitelist.find((e) => e.id === entry.id) || whitelist.find((e) => isEntryAllowed(entry.fullUrl, e));
        if (!target) return;
        target.mode = next;
        chrome.storage.local.set({ whitelist }, () => {
          entry.mode = next;
          renderWhitelist();
          showToast(
            next === "domain" ? t("wholeDomainEnabled") : t("wholeDomainDisabled"),
            next === "domain" ? "success" : "info",
          );
        });
      });
    });
    return badge;
  }

  function splitUrlForDisplay(fullUrl) {
    try {
      const u = new URL(fullUrl.includes("://") ? fullUrl : `https://${fullUrl}`);
      const path = `${u.pathname}${u.search}${u.hash}`;
      const host = u.host || u.pathname || fullUrl;
      return { host, path: u.host && path !== "/" ? path : "" };
    } catch {
      return { host: fullUrl, path: "" };
    }
  }

  document.addEventListener("click", (e) => {
    if (!e.target.classList.contains("btn-remove")) return;
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
        const whitelist = migrateWhitelist(data.whitelist);

        if (whitelist.some((e) => isEntryAllowed(cleanUrl, e))) {
          return showToast(t("siteAlreadyWhitelisted"), "error");
        }

        // Whitelist size cap (Security Feature #18)
        if (whitelist.length >= WHITELIST_MAX) {
          return showToast(t("whitelistCapacityError"), "error");
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

  // Removal is never silent and never final: the rows come back for eight
  // seconds if a hand slipped.
  function restoreWhitelistEntries(index, removed) {
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      const list = migrateWhitelist(data.whitelist);
      const missing = removed.filter((e) => !list.some((x) => x.id === e.id));
      // Back to where it stood — a list that reorders itself on undo feels
      // like it lost something else too.
      list.splice(Math.min(Math.max(index, 0), list.length), 0, ...missing);
      chrome.storage.local.set({ whitelist: list }, () => renderWhitelist());
    });
  }

  function removeSite(url) {
    chrome.storage.local.get({ whitelist: [] }, (data) => {
      const whitelist = migrateWhitelist(data.whitelist);
      const at = whitelist.findIndex((e) => isEntryAllowed(url, e));
      const removed = whitelist.filter((e) => isEntryAllowed(url, e));
      const remaining = whitelist.filter((e) => !isEntryAllowed(url, e));
      chrome.storage.local.set({ whitelist: remaining }, () => {
        renderWhitelist();
        if (removed.length === 0) return;
        showToast(t("removedFromWhitelist", removed.map((e) => e.fullUrl).join(", ")), "info", {
          label: t("undoButton"),
          onClick: () => restoreWhitelistEntries(at, removed),
        });
      });
    });
  }

  // ── Blocklist ────────────────────────────────────────────────────────────
  // A parent block always outranks the whitelist, so this list is the first
  // place to reach when something must stay closed.
  const KEYWORD_MAX = 500;

  // ── Status strip ─────────────────────────────────────────────────────────
  // Is protection on, what is allowed, what is blocked, how much time is
  // left — readable before any tab is opened.
  function renderStatusStrip() {
    const strip = document.getElementById("statusStrip");
    if (!strip) return;
    strip.textContent = "";

    const addChip = (text, tone, dot) => {
      const chip = document.createElement("span");
      chip.className = "status-chip" + (tone ? ` status-chip-${tone}` : "");
      if (dot) {
        const d = document.createElement("i");
        d.className = "status-dot";
        chip.appendChild(d);
      }
      chip.appendChild(document.createTextNode(text));
      strip.appendChild(chip);
    };

    chrome.storage.local.get(
      {
        whitelist: [],
        blockedKeywords: [],
        schedule: null,
        dailyLimit: null,
        emergencyLock: false,
        pausedUntil: 0,
      },
      (data) => {
        const locked = Boolean(data.emergencyLock);
        const pausedUntil = Number(data.pausedUntil) || 0;
        const paused = !locked && pausedUntil > Date.now();
        const schedule = data.schedule || { enabled: false, days: [], startTime: "", endTime: "" };
        const outside = Boolean(schedule.enabled) && !isWithinSchedule(schedule);

        if (locked) addChip(t("statusLocked"), "danger", true);
        else if (paused) {
          addChip(
            t("statusPaused", formatDuration(Math.round((pausedUntil - Date.now()) / 1000))),
            "warn",
            true,
          );
        } else if (outside) addChip(t("statusOutsideSchedule"), "warn", true);
        else addChip(t("statusProtectionOn"), "ok", true);

        addChip(t("statusAllowedCount", String(migrateWhitelist(data.whitelist).length)));
        addChip(t("statusBlockedCount", String((data.blockedKeywords || []).length)));
        if (schedule.enabled) addChip(t("statusScheduleOn"), outside ? "warn" : null);

        const dl = migrateDailyLimit(data.dailyLimit);
        const limited = Object.keys(dl.sites || {}).length;
        if (limited > 0) addChip(t("statusLimitsCount", String(limited)));

        // The budget itself lives in the worker, so ask it like the popup does.
        chrome.runtime.sendMessage({ type: "checkTimeStatus" }, (res) => {
          if (chrome.runtime.lastError || !strip.isConnected) return;
          const screen = res && res.screen;
          if (!screen || !screen.enabled) return;
          if (screen.exhausted) {
            addChip(t("blockedReasonBudget"), "danger", true);
            return;
          }
          // Same thresholds as the budget bar: calm, then amber, then red.
          const ratio = screen.minutes > 0 ? screen.remainingSeconds / (screen.minutes * 60) : 1;
          addChip(
            t("statusTimeLeft", formatDuration(screen.remainingSeconds)),
            ratio <= 0.15 ? "danger" : ratio <= 0.4 ? "warn" : null,
            true,
          );
        });
      },
    );
  }

  function renderBlocklist() {
    const container = document.getElementById("blocklistContainer");
    container.textContent = "";
    chrome.storage.local.get({ blockedKeywords: [] }, (data) => {
      const keywords = Array.isArray(data.blockedKeywords) ? data.blockedKeywords : [];
      const visible = keywords.filter((keyword) => matchesQuery(keyword, blocklistQuery));
      renderCount("blocklistCount", visible.length, keywords.length);

      if (keywords.length === 0) {
        const li = document.createElement("li");
        li.className = "empty-state";
        li.textContent = t("noKeywords");
        container.appendChild(li);
        return;
      }

      if (visible.length === 0) {
        const li = document.createElement("li");
        li.className = "empty-state";
        li.textContent = t("noMatches");
        container.appendChild(li);
        return;
      }

      visible.forEach((keyword) => {
        const li = document.createElement("li");
        li.className = "list-row";

        const span = document.createElement("span");
        span.className = "list-label";
        span.textContent = keyword;
        span.title = keyword;

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = t("deleteButton");
        button.className = "btn-remove";
        button.setAttribute("data-keyword", keyword);
        button.addEventListener("click", () => {
          verifyActiveSession(() => removeKeyword(keyword));
        });

        li.append(span, button);
        container.appendChild(li);
      });
    });
  }

  function removeKeyword(keyword) {
    chrome.storage.local.get({ blockedKeywords: [] }, (data) => {
      const all = Array.isArray(data.blockedKeywords) ? data.blockedKeywords : [];
      const at = all.findIndex((k) => String(k).toLowerCase() === String(keyword).toLowerCase());
      const list = all.filter((k) => String(k).toLowerCase() !== String(keyword).toLowerCase());
      chrome.storage.local.set({ blockedKeywords: list }, () => {
        renderBlocklist();
        showToast(t("keywordRemoved"), "info", {
          label: t("undoButton"),
          onClick: () => {
            chrome.storage.local.get({ blockedKeywords: [] }, (d2) => {
              const restored = (Array.isArray(d2.blockedKeywords) ? d2.blockedKeywords : []).slice();
              if (!restored.some((k) => String(k).toLowerCase() === String(keyword).toLowerCase())) {
                restored.splice(Math.min(Math.max(at, 0), restored.length), 0, keyword);
              }
              chrome.storage.local.set({ blockedKeywords: restored }, () => renderBlocklist());
            });
          },
        });
      });
    });
  }

  document.getElementById("addKeywordBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      const input = document.getElementById("newKeywordInput");
      // Strip scheme and path: parents mean "this site", not "https://…/x".
      const value = (input.value || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/.*$/, "")
        .trim();

      if (value.length < BLOCKLIST_MIN_KEYWORD) {
        return showToast(t("keywordInvalid"), "error");
      }

      chrome.storage.local.get({ blockedKeywords: [] }, (data) => {
        const list = Array.isArray(data.blockedKeywords) ? data.blockedKeywords : [];
        if (list.some((k) => String(k).toLowerCase() === value)) {
          return showToast(t("keywordDuplicate"), "error");
        }
        if (list.length >= KEYWORD_MAX) {
          return showToast(t("keywordLimit"), "error");
        }
        chrome.storage.local.set({ blockedKeywords: [...list, value] }, () => {
          input.value = "";
          renderBlocklist();
          showToast(t("keywordAdded"), "success");
        });
      });
    });
  });

  // ── One-click packs ──────────────────────────────────────────────────────
  function renderPresets() {
    const blockContainer = document.getElementById("presetContainer");
    const safeContainer = document.getElementById("safePresetContainer");
    if (!blockContainer || !safeContainer) return;
    blockContainer.textContent = "";
    safeContainer.textContent = "";

    BLOCK_PRESETS.forEach((preset) =>
      blockContainer.appendChild(createPresetButton(preset, "block")),
    );
    SAFE_PRESETS.forEach((preset) =>
      safeContainer.appendChild(createPresetButton(preset, "allow")),
    );
  }

  function createPresetButton(preset, kind) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      kind === "block" ? "btn btn-secondary preset-chip" : "btn btn-success preset-chip";
    button.textContent = t(preset.labelKey);
    button.title = preset.domains.join(", ");
    button.addEventListener("click", () => {
      verifyActiveSession(() => applyPreset(preset, kind));
    });
    return button;
  }

  function applyPreset(preset, kind) {
    if (kind === "block") {
      chrome.storage.local.get({ blockedKeywords: [] }, (data) => {
        const merged = mergeIntoKeywords(data.blockedKeywords, preset.domains);
        if (!merged.changed) return showToast(t("presetAlready"), "info");
        if (merged.list.length > KEYWORD_MAX) return showToast(t("keywordLimit"), "error");
        chrome.storage.local.set({ blockedKeywords: merged.list }, () => {
          renderBlocklist();
          showToast(t("presetApplied"), "success");
        });
      });
      return;
    }

    chrome.storage.local.get({ whitelist: [] }, (data) => {
      const whitelist = migrateWhitelist(data.whitelist);
      let added = 0;
      for (const domain of preset.domains) {
        const cleanUrl = normalizeUrl(`https://${domain}`);
        if (!cleanUrl) continue;
        if (whitelist.some((e) => isEntryAllowed(cleanUrl, e))) continue;
        if (whitelist.length >= WHITELIST_MAX) {
          showToast(t("whitelistCapacityError"), "error");
          break;
        }
        whitelist.push({
          id: generateSecureId(),
          fullUrl: cleanUrl,
          addedAt: Date.now(),
          mode: "domain",
        });
        added += 1;
      }
      if (added === 0) return showToast(t("presetAlready"), "info");
      chrome.storage.local.set({ whitelist }, () => {
        renderWhitelist();
        showToast(t("presetApplied"), "success");
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
      const dl = migrateDailyLimit(data.dailyLimit);
      document.getElementById("dailyLimitEnabledCheckbox").checked = !!dl.enabled;
      // These inputs add a NEW limit; configured ones are listed in the table
      // below, so they stay blank instead of echoing the legacy layout.
      document.getElementById("targetSiteInput").value = "";
      document.getElementById("dailyLimitInput").value = "";
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
        const statusText = minutesLeft > 0 ? t("statusAllowed") : t("statusBlocked");

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
        tdStatus.className = minutesLeft > 0 ? "status-ok" : "status-blocked";

        const tdAction = document.createElement("td");
        const btnDelete = document.createElement("button");
        btnDelete.className = "btn-remove";
        btnDelete.textContent = t("deleteButton") || "Delete";
        btnDelete.addEventListener("click", () => {
          verifyActiveSession(() => {
            chrome.storage.local.get(["dailyLimit"], (data) => {
              const currentDl = migrateDailyLimit(data.dailyLimit);
              if (currentDl.sites && currentDl.sites[site]) {
                const saved = currentDl.sites[site];
                const at = Object.keys(currentDl.sites).indexOf(site);
                delete currentDl.sites[site];
                chrome.storage.local.set({ dailyLimit: currentDl }, () => {
                  renderLimitsTable();
                  showToast(t("limitRemoved", site), "info", {
                    label: t("undoButton"),
                    onClick: () => {
                      chrome.storage.local.get({ dailyLimit: null }, (d2) => {
                        const dl = migrateDailyLimit(d2.dailyLimit);
                        const sites = dl.sites || {};
                        // Key order is row order: put the site back in line.
                        const keys = Object.keys(sites).filter((k) => k !== site);
                        keys.splice(Math.min(Math.max(at, 0), keys.length), 0, site);
                        const rebuilt = {};
                        keys.forEach((k) => {
                          rebuilt[k] = k === site ? saved : sites[k];
                        });
                        dl.sites = rebuilt;
                        chrome.storage.local.set({ dailyLimit: dl }, () => renderLimitsTable());
                      });
                    },
                  });
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
        return showToast(t("dailyLimitError"), "error");
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

  // ── Whole-day screen-time budget ─────────────────────────────────────────
  function loadScreenTime() {
    chrome.storage.local.get(["screenTime"], (data) => {
      const st = migrateScreenTime(data.screenTime);
      document.getElementById("screenTimeEnabledCheckbox").checked = st.enabled;
      document.getElementById("screenTimeMinutesInput").value =
        st.minutes > 0 ? String(st.minutes) : "";
      renderScreenTimeUsage(st);
    });
  }

  // Counts the service worker's persisted value; the very last few seconds of
  // a session may still be buffered there, which is fine for a status line.
  function renderScreenTimeUsage(st) {
    const usedEl = document.getElementById("screenTimeUsedText");
    const leftEl = document.getElementById("screenTimeRemainingText");
    if (!usedEl || !leftEl) return;
    const used = screenTimeUsedSeconds(st);
    const total = st.minutes * 60;
    usedEl.value = formatDuration(used);
    leftEl.value = st.minutes > 0 ? formatDuration(Math.max(0, total - used)) : "—";

    // One bar beats three fields: how much of today's budget is still there.
    const bar = document.getElementById("screenTimeBar");
    const fill = document.getElementById("screenTimeFill");
    if (bar && fill) {
      const active = st.enabled && st.minutes > 0;
      bar.hidden = !active;
      if (active) {
        const ratio = Math.max(0, Math.min(1, (total - used) / total));
        fill.style.width = `${Math.round(ratio * 100)}%`;
        fill.className = "screen-time-fill" + (ratio <= 0.15 ? " danger" : ratio <= 0.4 ? " warn" : "");
      }
    }
  }

  document.getElementById("saveScreenTimeBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      const enabled = document.getElementById("screenTimeEnabledCheckbox").checked;
      const minutes = parseInt(document.getElementById("screenTimeMinutesInput").value || "0", 10);

      if (enabled && (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440)) {
        showToast(t("screenTimeError"), "error");
        return;
      }

      chrome.storage.local.get(["screenTime"], (data) => {
        const st = migrateScreenTime(data.screenTime);
        const today = new Date().toDateString();
        st.enabled = enabled;
        st.minutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
        if (st.lastReset !== today) {
          st.usedSeconds = 0;
          st.lastReset = today;
        }
        chrome.storage.local.set({ screenTime: st }, () => {
          showToast(t("screenTimeSaved"));
          renderScreenTimeUsage(st);
        });
      });
    });
  });

  // ── Cross-device sync status ─────────────────────────────────────────────
  // Written by the service worker after every push attempt; purely informational.
  function loadSyncStatus() {
    chrome.storage.local.get(["policySyncStatus"], (data) => {
      renderSyncStatus(data.policySyncStatus || "");
    });
  }

  function renderSyncStatus(status) {
    const line = document.getElementById("syncStatusLine");
    if (!line) return;
    const quotaKb = Math.floor((SYNC_MAX_CHUNKS * SYNC_CHUNK_SIZE) / 1000);
    if (status === "ok") line.textContent = t("syncStatusOk");
    else if (status === "quota") line.textContent = t("syncStatusQuota");
    else if (status === "too-large") line.textContent = t("syncStatusTooLarge", String(quotaKb));
    else line.textContent = t("syncStatusOff");
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.policySyncStatus) renderSyncStatus(changes.policySyncStatus.newValue || "");
    if (changes.screenTime) renderScreenTimeUsage(migrateScreenTime(changes.screenTime.newValue));
    if (
      changes.whitelist ||
      changes.blockedKeywords ||
      changes.schedule ||
      changes.dailyLimit ||
      changes.emergencyLock ||
      changes.pausedUntil
    ) {
      renderStatusStrip();
    }
    if (changes.pausedUntil) updatePauseStatus();
  });

  // ── PIN quick unlock ─────────────────────────────────────────────────────
  // Only a PBKDF2 spec is stored (never the digits), it never reaches sync,
  // and verification happens in the worker under the same lockout as the
  // password — a PIN shortens typing, not the security model.
  const PIN_PATTERN = /^[0-9]{4,8}$/;

  function loadPinStatus() {
    chrome.storage.local.get(["pinHash"], (data) => {
      const has = Boolean(data.pinHash);
      const status = document.getElementById("pinStatus");
      const removeBtn = document.getElementById("removePinBtn");
      if (status) {
        status.textContent = has ? t("pinSet") : t("pinNotSet");
        status.style.color = has ? "var(--success-solid)" : "var(--text-muted)";
      }
      if (removeBtn) removeBtn.disabled = !has;
    });
  }

  document.getElementById("savePinBtn").addEventListener("click", () => {
    verifyActiveSession(async () => {
      const pin = document.getElementById("pinInput").value;
      const confirmPin = document.getElementById("pinConfirmInput").value;

      if (!PIN_PATTERN.test(pin)) return showToast(t("pinInvalid"), "error");
      if (pin !== confirmPin) return showToast(t("pinMismatch"), "error");

      const spec = await createPasswordSpec(pin);
      chrome.storage.local.set({ pinHash: spec }, () => {
        document.getElementById("pinInput").value = "";
        document.getElementById("pinConfirmInput").value = "";
        showToast(t("pinSaved"), "success");
        loadPinStatus();
      });
    });
  });

  document.getElementById("removePinBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      chrome.storage.local.remove("pinHash", () => {
        showToast(t("pinRemoved"), "info");
        loadPinStatus();
      });
    });
  });

  function loadEmergencyLock() {
    chrome.storage.local.get(["emergencyLock"], (data) => {
      const isLocked = !!data.emergencyLock;
      const enableBtn = document.getElementById("enableEmergencyBtn");
      const disableBtn = document.getElementById("disableEmergencyBtn");
      // Disabled state is the status indicator: the inactive action greys out.
      enableBtn.disabled = isLocked;
      disableBtn.disabled = !isLocked;
      enableBtn.setAttribute("aria-pressed", String(isLocked));
      disableBtn.setAttribute("aria-pressed", String(!isLocked));
    });
  }

  document
    .getElementById("enableEmergencyBtn")
    .addEventListener("click", () => {
      verifyActiveSession(() => {
        chrome.storage.local.set({ emergencyLock: true }, () => {
          showToast(t("emergencyLockEnabled"));
          loadEmergencyLock();
        });
      });
    });

  document
    .getElementById("disableEmergencyBtn")
    .addEventListener("click", () => {
      verifyActiveSession(() => {
        chrome.storage.local.set({ emergencyLock: false }, () => {
          showToast(t("emergencyLockDisabled"));
          loadEmergencyLock();
        });
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

  // ── Usage report ─────────────────────────────────────────────────────────
  // storage.local.activity: { "YYYY-M-D": { host: { seconds, visits, blocked } } }
  // The service worker trims it to the last 14 days, so this view is cheap.
  let reportActivity = {};

  function formatDuration(totalSeconds) {
    const total = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  function parseDayKey(key) {
    const parts = String(key).split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => !n)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function loadReport() {
    chrome.storage.local.get({ activity: {} }, (data) => {
      reportActivity =
        data.activity && typeof data.activity === "object" ? data.activity : {};

      const select = document.getElementById("reportDaySelect");
      const previous = select.value;
      const keys = Object.keys(reportActivity).sort((a, b) => {
        const da = parseDayKey(a);
        const db = parseDayKey(b);
        return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
      });

      select.textContent = "";

      if (keys.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = t("reportNoData");
        select.appendChild(option);
        renderReportDay("");
        return;
      }

      keys.forEach((key) => {
        const date = parseDayKey(key);
        const option = document.createElement("option");
        option.value = key;
        option.textContent = date
          ? date.toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            })
          : key;
        select.appendChild(option);
      });

      select.value = keys.includes(previous) ? previous : keys[0];
      renderReportDay(select.value);
    });
  }

  function addReportRow(tbody, cells) {
    const row = document.createElement("tr");
    cells.forEach((text) => {
      const td = document.createElement("td");
      td.textContent = text;
      row.appendChild(td);
    });
    tbody.appendChild(row);
    return row;
  }

  function renderReportDay(dayKey) {
    const tbody = document.getElementById("reportTableBody");
    const totals = document.getElementById("reportTotals");
    const chart = document.getElementById("reportChart");
    tbody.textContent = "";
    totals.textContent = "";
    if (chart) chart.textContent = "";

    const bucket = dayKey && reportActivity[dayKey] ? reportActivity[dayKey] : null;
    const hosts = bucket ? Object.keys(bucket) : [];

    if (hosts.length === 0) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "empty-state";
      td.textContent = t("reportNoData");
      row.appendChild(td);
      tbody.appendChild(row);
      return;
    }

    hosts.sort((a, b) => (bucket[b].seconds || 0) - (bucket[a].seconds || 0));

    let totalSeconds = 0;
    let totalVisits = 0;
    let totalBlocked = 0;

    hosts.forEach((host) => {
      const entry = bucket[host] || {};
      const seconds = Number(entry.seconds) || 0;
      const visits = Number(entry.visits) || 0;
      const blocked = Number(entry.blocked) || 0;
      totalSeconds += seconds;
      totalVisits += visits;
      totalBlocked += blocked;
      addReportRow(tbody, [host, formatDuration(seconds), String(visits), String(blocked)]);
    });

    totals.textContent = t("reportTotals", formatDuration(totalSeconds), String(totalVisits), String(totalBlocked));
    renderReportChart(bucket, hosts);
  }

  // Bar chart of the busiest sites of the selected day. CSS-only, no chart
  // library; it is decorative, the table above already says the same numbers.
  function renderReportChart(bucket, hosts) {
    const chart = document.getElementById("reportChart");
    if (!chart) return;
    chart.textContent = "";

    const top = hosts.slice(0, 8);
    if (top.length === 0) return;
    const maxSeconds = Math.max(
      1,
      ...top.map((host) => Number((bucket[host] || {}).seconds) || 0),
    );

    top.forEach((host) => {
      const entry = bucket[host] || {};
      const seconds = Number(entry.seconds) || 0;

      const row = document.createElement("div");
      row.className = "chart-row";

      const label = document.createElement("span");
      label.className = "chart-label";
      label.textContent = host;
      label.title = host;

      const track = document.createElement("div");
      track.className = "chart-track";
      const bar = document.createElement("div");
      bar.className = "chart-bar";
      bar.style.width = `${Math.max(3, Math.round((seconds / maxSeconds) * 100))}%`;
      track.appendChild(bar);

      const value = document.createElement("span");
      value.className = "chart-value";
      value.textContent = formatDuration(seconds);

      row.append(label, track, value);
      chart.appendChild(row);
    });
  }

  function csvCell(value) {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  // The report is the artefact a parent keeps: export the selected day as a
  // spreadsheet-friendly CSV (BOM included so Arabic stays readable in Excel).
  document.getElementById("exportReportBtn").addEventListener("click", () => {
    const dayKey = document.getElementById("reportDaySelect").value;
    const bucket = dayKey && reportActivity[dayKey] ? reportActivity[dayKey] : null;
    const hosts = bucket ? Object.keys(bucket) : [];

    if (hosts.length === 0) {
      showToast(t("reportNoData"), "info");
      return;
    }

    hosts.sort((a, b) => (Number(bucket[b].seconds) || 0) - (Number(bucket[a].seconds) || 0));

    const rows = [["site", "seconds", "minutes", "visits", "blocked"].map(csvCell).join(",")];
    hosts.forEach((host) => {
      const entry = bucket[host] || {};
      const seconds = Number(entry.seconds) || 0;
      rows.push(
        [
          host,
          seconds,
          (seconds / 60).toFixed(1),
          Number(entry.visits) || 0,
          Number(entry.blocked) || 0,
        ]
          .map(csvCell)
          .join(","),
      );
    });

    const blob = new Blob(["\uFEFF" + rows.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `family-monitor-${dayKey}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast(t("reportExported"), "success");
  });

  document.getElementById("reportDaySelect").addEventListener("change", (e) => {
    renderReportDay(e.target.value);
  });

  document.getElementById("clearReportBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      chrome.storage.local.set({ activity: {} }, () => {
        loadReport();
        showToast(t("reportCleared"), "success");
      });
    });
  });

  // ── Advance-warning notifications ────────────────────────────────────────
  function loadNotifications() {
    const checkbox = document.getElementById("notificationsEnabledCheckbox");
    const status = document.getElementById("notificationsStatus");
    if (!checkbox || !status) return;

    chrome.storage.local.get({ notificationsEnabled: true }, (data) => {
      const enabled = data.notificationsEnabled !== false;
      checkbox.checked = enabled;
      status.textContent = enabled ? t("notificationsOn") : t("notificationsOff");
      status.style.color = enabled ? "var(--success-solid)" : "var(--text-muted)";
    });
  }

  document
    .getElementById("notificationsEnabledCheckbox")
    .addEventListener("change", (e) => {
      const enabled = e.target.checked;
      verifyActiveSession(() => {
        chrome.storage.local.set({ notificationsEnabled: enabled }, () => {
          showToast(enabled ? t("notificationsOn") : t("notificationsOff"), "info");
          loadNotifications();
        });
      });
    });

  // ── Embed guard ──────────────────────────────────────────────────────────
  // Off means "the current path only": a page's iframes are left exactly as
  // the page wrote them, and nothing is emptied.
  function loadEmbedGuard() {
    const checkbox = document.getElementById("embedGuardCheckbox");
    const status = document.getElementById("embedGuardStatus");
    if (!checkbox || !status) return;

    chrome.storage.local.get({ embedGuardEnabled: true }, (data) => {
      const enabled = data.embedGuardEnabled !== false;
      checkbox.checked = enabled;
      status.textContent = enabled ? t("embedGuardOn") : t("embedGuardOff");
      status.style.color = enabled ? "var(--success-solid)" : "var(--text-muted)";
    });
  }

  document
    .getElementById("embedGuardCheckbox")
    .addEventListener("change", (e) => {
      const enabled = e.target.checked;
      verifyActiveSession(() => {
        chrome.storage.local.set({ embedGuardEnabled: enabled }, () => {
          showToast(enabled ? t("embedGuardOn") : t("embedGuardOff"), "info");
          loadEmbedGuard();
        });
      });
    });

  // ── Whitelist-only search results ────────────────────────────────────────
  // Off (the default) means today's behaviour: the engine's results appear
  // as the engine rendered them, with only blocked matches hidden.
  function loadSearchFilter() {
    const checkbox = document.getElementById("searchFilterCheckbox");
    const status = document.getElementById("searchFilterStatus");
    if (!checkbox || !status) return;

    chrome.storage.local.get({ whitelistResultsOnly: false }, (data) => {
      const enabled = data.whitelistResultsOnly === true;
      checkbox.checked = enabled;
      status.textContent = enabled ? t("searchFilterOn") : t("searchFilterOff");
      status.style.color = enabled ? "var(--success-solid)" : "var(--text-muted)";
    });
  }

  document
    .getElementById("searchFilterCheckbox")
    .addEventListener("change", (e) => {
      const enabled = e.target.checked;
      verifyActiveSession(() => {
        chrome.storage.local.set({ whitelistResultsOnly: enabled }, () => {
          showToast(enabled ? t("searchFilterOn") : t("searchFilterOff"), "info");
          loadSearchFilter();
        });
      });
    });

  // ── Strict SafeSearch ─────────────────────────────────────────────────────
  // Off (the default) leaves every engine's own setting alone; on, every
  // results page reloads once with the engine's strict parameter.
  function loadSafeSearch() {
    const checkbox = document.getElementById("safeSearchCheckbox");
    const status = document.getElementById("safeSearchStatus");
    if (!checkbox || !status) return;

    chrome.storage.local.get({ safeSearchEnforced: false }, (data) => {
      const enabled = data.safeSearchEnforced === true;
      checkbox.checked = enabled;
      status.textContent = enabled ? t("safeSearchOn") : t("safeSearchOff");
      status.style.color = enabled ? "var(--success-solid)" : "var(--text-muted)";
    });
  }

  document
    .getElementById("safeSearchCheckbox")
    .addEventListener("change", (e) => {
      const enabled = e.target.checked;
      verifyActiveSession(() => {
        chrome.storage.local.set({ safeSearchEnforced: enabled }, () => {
          showToast(enabled ? t("safeSearchOn") : t("safeSearchOff"), "info");
          loadSafeSearch();
        });
      });
    });

  // ── A note on the blocked page ────────────────────────────────────────────
  // Parent-authored, synced as configuration, and rendered as plain text on
  // the blocked page — never as markup.
  function loadBlockedMessage() {
    const input = document.getElementById("blockedMsgInput");
    if (!input) return;
    chrome.storage.local.get({ blockedMessage: "" }, (data) => {
      input.value = typeof data.blockedMessage === "string" ? data.blockedMessage : "";
    });
  }

  document.getElementById("saveBlockedMsgBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      const input = document.getElementById("blockedMsgInput");
      if (!input) return;
      const message = (input.value || "").trim().slice(0, 140);
      chrome.storage.local.set({ blockedMessage: message }, () => {
        showToast(t("blockedMsgSaved"), "success");
        loadBlockedMessage();
      });
    });
  });

  // ── Evening digest ────────────────────────────────────────────────────────
  // The worker owns the 8 p.m. alarm; this only flips the switch.
  function loadDigest() {
    const checkbox = document.getElementById("digestCheckbox");
    const status = document.getElementById("digestStatus");
    if (!checkbox || !status) return;

    chrome.storage.local.get({ dailyDigestEnabled: false }, (data) => {
      const enabled = data.dailyDigestEnabled === true;
      checkbox.checked = enabled;
      status.textContent = enabled ? t("digestOn") : t("digestOff");
      status.style.color = enabled ? "var(--success-solid)" : "var(--text-muted)";
    });
  }

  document
    .getElementById("digestCheckbox")
    .addEventListener("change", (e) => {
      const enabled = e.target.checked;
      verifyActiveSession(() => {
        chrome.storage.local.set({ dailyDigestEnabled: enabled }, () => {
          showToast(enabled ? t("digestOn") : t("digestOff"), "info");
          loadDigest();
        });
      });
    });

  // ── Timed pause ───────────────────────────────────────────────────────────
  // The emergency lock's gentler sibling: the same stop, but it expires by
  // itself — nobody has to remember to unlock at 7 a.m.
  let pauseTimer = null;

  function morningTarget() {
    const at = new Date();
    at.setHours(7, 0, 0, 0);
    if (Date.now() >= at.getTime()) at.setDate(at.getDate() + 1);
    return at.getTime();
  }

  function updatePauseStatus() {
    const status = document.getElementById("pauseStatus");
    const resumeBtn = document.getElementById("resumeNowBtn");
    if (!status || !resumeBtn) return;

    chrome.storage.local.get({ pausedUntil: 0 }, (data) => {
      const until = Number(data.pausedUntil) || 0;
      const remaining = until - Date.now();
      const active = remaining > 0;
      resumeBtn.hidden = !active;

      if (!active) {
        status.textContent = "";
        if (pauseTimer) {
          clearInterval(pauseTimer);
          pauseTimer = null;
        }
        return;
      }
      status.textContent = t("pauseActive", formatDuration(Math.round(remaining / 1000)));
      status.style.color = "var(--warning-solid)";
      renderStatusStrip(); // the strip shows the same countdown chip
      if (!pauseTimer) pauseTimer = setInterval(updatePauseStatus, 20000);
    });
  }

  function startPause(untilMs) {
    verifyActiveSession(() => {
      chrome.storage.local.set({ pausedUntil: untilMs }, () => {
        showToast(t("pauseStarted"), "info");
        updatePauseStatus();
        renderStatusStrip();
      });
    });
  }

  document
    .getElementById("pause1hBtn")
    .addEventListener("click", () => startPause(Date.now() + 60 * 60 * 1000));
  document
    .getElementById("pause3hBtn")
    .addEventListener("click", () => startPause(Date.now() + 3 * 60 * 60 * 1000));
  document
    .getElementById("pauseMorningBtn")
    .addEventListener("click", () => startPause(morningTarget()));
  document.getElementById("resumeNowBtn").addEventListener("click", () => {
    verifyActiveSession(() => {
      chrome.storage.local.set({ pausedUntil: 0 }, () => {
        showToast(t("pauseResumed"), "success");
        updatePauseStatus();
        renderStatusStrip();
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
      chrome.storage.local.set(
        { password: newHash, failedAttemptsCount: 0, lockoutExpiry: 0 },
        () => {
        // Purge any older copy that a previous version synced to the cloud.
        chrome.storage.sync.remove("password", () => {
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
          chrome.storage.sync.remove("password", () => {
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