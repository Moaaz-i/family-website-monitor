import {
  resolveRedirectUrl,
  isMatchingSite,
  isValidRedirectTarget,
} from "./lib/url.js";
import {
  migrateDailyLimit,
  determineUrlStatus,
  isWithinSchedule,
} from "./lib/rules.js";
import { TIME_TAMPER_THRESHOLD_MS, EXTENSIONS_ACCESS_DURATION_MS, UPDATE_CHECK_PERIOD_MIN, VERSION_URL } from "./lib/constants.js";

function checkAndApplyRules(url, tabId) {
  const resolvedUrl = resolveRedirectUrl(url);

  // Security Feature #17: Block extensions page access to prevent extension disable
  if (
    resolvedUrl.startsWith("chrome://extensions") ||
    resolvedUrl.includes("chrome://extensions/") ||
    resolvedUrl.startsWith("chrome://settings/system") ||
    resolvedUrl.startsWith("chrome://settings/extensions")
  ) {
    chrome.storage.local.get(["extensionsAccessExpiry"], (store) => {
      const now = Date.now();
      const allowedUntil = store.extensionsAccessExpiry || 0;
      if (now >= allowedUntil) {
        chrome.tabs.update(tabId, {
          url: chrome.runtime.getURL("blocked-extensions.html"),
        });
      }
    });
    return;
  }

  if (
    resolvedUrl.startsWith("chrome://") ||
    resolvedUrl.startsWith("chrome-extension://")
  ) {
    return;
  }

  chrome.storage.local.get(
    [
      "password",
      "whitelist",
      "schedule",
      "dailyLimit",
      "emergencyLock",
      "tempAllowed",
      "timeTampered"
    ],
    (data) => {
      // Force setup if password not set
      if (!data.password) {
        chrome.storage.sync.get(["password"], (syncData) => {
          if (syncData && syncData.password) {
            chrome.storage.local.set({ password: syncData.password }, () => {
              checkAndApplyRules(url, tabId);
            });
          } else {
            chrome.tabs.update(tabId, {
              url: chrome.runtime.getURL("options.html?setup=true"),
            });
          }
        });
        return;
      }

      const encoded = encodeURIComponent(resolvedUrl);
      const result = determineUrlStatus(resolvedUrl, data);

      if (result.status === "blocked") {
        const reasonParam = result.reason ? `&reason=${result.reason}` : "";
        chrome.tabs.update(tabId, {
          url: chrome.runtime.getURL(`blocked.html?target=${encoded}${reasonParam}`),
        });
      }
    },
  );
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  checkAndApplyRules(details.url, details.tabId);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  checkAndApplyRules(details.url, details.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "loading") {
    const urlToCheck = changeInfo.url || tab.url;
    if (urlToCheck) {
      checkAndApplyRules(urlToCheck, tabId);
    }
  }
});

chrome.alarms.create("trackTime", { periodInMinutes: 1 });

// ── Auto-Update System ──────────────────────────────────────────────────────

function getCurrentVersion() {
  return chrome.runtime.getManifest().version;
}

function compareVersions(v1, v2) {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (b > a) return true;
    if (b < a) return false;
  }
  return false;
}

function setUpdateBadge(hasUpdate) {
  if (hasUpdate) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#f97316" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function fetchAndCheckUpdates() {
  try {
    const response = await fetch(VERSION_URL + "?t=" + Date.now());
    if (!response.ok) return;
    const data = await response.json();
    const latestVersion = data.version;
    const releaseNotes = data.releaseNotes || "";
    const currentVersion = getCurrentVersion();
    const updateAvailable = compareVersions(currentVersion, latestVersion);
    chrome.storage.local.set({
      updateAvailable,
      latestVersion,
      currentVersion,
      releaseNotes,
      lastUpdateCheck: Date.now(),
    });
    setUpdateBadge(updateAvailable);
  } catch (e) {
    // Network error — silently ignore
  }
}

function restorePasswordFromSync() {
  chrome.storage.sync.get(["password"], (syncData) => {
    if (chrome.runtime.lastError || !syncData || !syncData.password) return;
    chrome.storage.local.get(["password"], (localData) => {
      if (chrome.runtime.lastError) return;
      if (!localData || !localData.password) {
        chrome.storage.local.set({ password: syncData.password }, () => {
          console.log("Parent password successfully restored from sync backup.");
        });
      }
    });
  });
}

// Security Feature #13: Anti-Clock-Tampering (Time-Skew Defense)
function checkTimeTampering(callback) {
  chrome.storage.local.get(["lastActiveTime", "timeTampered"], (data) => {
    const now = Date.now();
    const lastActive = data.lastActiveTime || 0;

    if (lastActive > 0 && now < lastActive - TIME_TAMPER_THRESHOLD_MS) {
      chrome.storage.local.set({ timeTampered: true }, () => {
        if (callback) callback(true);
      });
    } else {
      if (now > lastActive) {
        chrome.storage.local.set({ lastActiveTime: now }, () => {
          if (callback) callback(false);
        });
      } else {
        if (callback) callback(false);
      }
    }
  });
}

// Security Feature #19: WebRTC & DNS Privacy Lock
function applyWebRTCSecurity() {
  if (chrome.privacy && chrome.privacy.network && chrome.privacy.network.webRTCIPHandlingPolicy) {
    chrome.privacy.network.webRTCIPHandlingPolicy.set({
      value: "disable_non_proxied_udp"
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn("Unable to set WebRTC IP Handling Policy:", chrome.runtime.lastError.message);
      }
    });
  }
}

// Security Feature #15: Uninstall Redirection Warning
chrome.runtime.onInstalled.addListener(() => {
  chrome.runtime.setUninstallURL("https://moaaz-i.github.io/family-website-monitor/uninstall.html");
  applyWebRTCSecurity();
  restorePasswordFromSync();
});

chrome.runtime.onStartup.addListener(() => {
  applyWebRTCSecurity();
  checkTimeTampering();
  restorePasswordFromSync();
});

// Check on startup
fetchAndCheckUpdates();

// Check every 6 hours
chrome.alarms.create("checkForUpdates", { periodInMinutes: UPDATE_CHECK_PERIOD_MIN });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkForUpdates") {
    fetchAndCheckUpdates();
    return;
  }
  if (alarm.name !== "trackTime") return;

  checkTimeTampering();

  // Security Feature #17: Auto-lock active extensions tab when parental window expires
  chrome.storage.local.get(["extensionsAccessExpiry"], (store) => {
    const now = Date.now();
    const allowedUntil = store.extensionsAccessExpiry || 0;
    if (now >= allowedUntil) {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError || !tabs) return;
        tabs.forEach((tab) => {
          const currentUrl = tab.url || tab.pendingUrl || "";
          const resolved = resolveRedirectUrl(currentUrl);
          if (
            resolved.startsWith("chrome://extensions") ||
            resolved.includes("chrome://extensions/") ||
            resolved.startsWith("chrome://settings/system") ||
            resolved.startsWith("chrome://settings/extensions")
          ) {
            chrome.tabs.update(tab.id, {
              url: chrome.runtime.getURL("blocked-extensions.html"),
            });
          }
        });
      });
    }
  });

  chrome.storage.local.get(["dailyLimit", "tempAllowed"], (data) => {
    const nowTime = new Date().getTime();
    let tempAllowed = data.tempAllowed || {};
    let tempStorageUpdated = false;
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError || !tabs) return;
      tabs.forEach((tab) => {
        const currentUrl = tab.url || tab.pendingUrl;
        if (!currentUrl) return;
        const resolved = resolveRedirectUrl(currentUrl);
        for (const key in tempAllowed) {
          if (isMatchingSite(resolved, key)) {
            if (nowTime >= tempAllowed[key]) {
              const encoded = encodeURIComponent(resolved);
              chrome.tabs.update(tab.id, {
                url: chrome.runtime.getURL(`blocked.html?target=${encoded}`),
              });
              delete tempAllowed[key];
              tempStorageUpdated = true;
            }
          }
        }
      });
      if (tempStorageUpdated) {
        chrome.storage.local.set({ tempAllowed });
      }
    });
    const dl = migrateDailyLimit(data.dailyLimit);
    if (!dl || !dl.enabled) return;
    const today = new Date().toDateString();
    let updated = false;
    for (const site in dl.sites) {
      if (dl.sites[site].lastReset !== today) {
        dl.sites[site].usedTodaySeconds = 0;
        dl.sites[site].lastReset = today;
        updated = true;
      }
    }
    if (updated) {
      chrome.storage.local.set({ dailyLimit: dl });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Security Feature #20: Message Source Verification
  if (sender.id && sender.id !== chrome.runtime.id) {
    console.warn("Rejected message from external sender:", sender.id);
    return false;
  }

  if (message.type === "checkForUpdatesNow") {
    fetchAndCheckUpdates().then(() => {
      chrome.storage.local.get(
        ["updateAvailable", "latestVersion", "currentVersion", "releaseNotes"],
        (data) => sendResponse(data),
      );
    });
    return true;
  }
  if (message.type === "dismissUpdate") {
    chrome.storage.local.set({ updateAvailable: false });
    setUpdateBadge(false);
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "checkTimeStatus") {
    chrome.storage.local.get(["dailyLimit", "tempAllowed"], (data) => {
      const tabUrl = sender.tab ? sender.tab.url : "";
      const resolvedTabUrl = resolveRedirectUrl(tabUrl);
      const dl = migrateDailyLimit(data.dailyLimit);
      let dlData = { isTarget: false, remainingSeconds: 0 };

      if (dl && dl.enabled && dl.sites && resolvedTabUrl) {
        let matchedSite = null;
        for (const site in dl.sites) {
          if (isMatchingSite(resolvedTabUrl, site)) {
            matchedSite = site;
            break;
          }
        }
        if (matchedSite) {
          const siteData = dl.sites[matchedSite];
          const today = new Date().toDateString();
          const usedTodaySeconds = siteData.lastReset === today ? siteData.usedTodaySeconds || 0 : 0;
          dlData = {
            isTarget: true,
            remainingSeconds: Math.max(0, siteData.minutes * 60 - usedTodaySeconds),
          };
        }
      }

      let tempData = { isTemp: false, remainingSeconds: 0 };
      if (resolvedTabUrl && data.tempAllowed) {
        for (const key in data.tempAllowed) {
          if (isMatchingSite(resolvedTabUrl, key)) {
            const expiry = data.tempAllowed[key];
            const now = new Date().getTime();
            if (expiry > now) {
              tempData = {
                isTemp: true,
                remainingSeconds: Math.floor((expiry - now) / 1000),
              };
              break;
            }
          }
        }
      }
      sendResponse({ dlData, tempData });
    });
    return true;
  }
  if (message.type === "checkLinkStatus") {
    chrome.storage.local.get(
      [
        "password",
        "whitelist",
        "schedule",
        "dailyLimit",
        "emergencyLock",
        "tempAllowed",
        "timeTampered"
      ],
      (data) => {
        const url = resolveRedirectUrl(message.url);
        const now = new Date().getTime();
        if (!data.password) {
          sendResponse({ status: "blocked", reason: "setup" });
          return;
        }

        const result = determineUrlStatus(url, data);
        sendResponse(result);
      },
    );
    return true;
  }
  if (message.type === "forceBlockRedirect") {
    const resolvedUrl = resolveRedirectUrl(message.url);

    // Security Feature #12: Safe Redirect Targets Validation
    if (!isValidRedirectTarget(resolvedUrl)) {
      console.warn("Unsafe redirect target blocked:", resolvedUrl);
      return false;
    }

    const encoded = encodeURIComponent(resolvedUrl);
    const redirectUrl = chrome.runtime.getURL(
      `blocked.html?target=${encoded}&reason=${message.reason}`,
    );
    if (message.openInNewTab && sender.tab) {
      chrome.tabs.create({ url: redirectUrl });
    } else if (sender.tab) {
      chrome.tabs.update(sender.tab.id, { url: redirectUrl });
    }
    return false;
  }
  if (message.type === "heartbeat") {
    if (!sender.tab || !sender.tab.id) return false;
    chrome.tabs.get(sender.tab.id, (tab) => {
      if (chrome.runtime.lastError || !tab || !tab.active) {
        sendResponse({ isTarget: false, remainingSeconds: 0 });
        return;
      }
      chrome.storage.local.get(["dailyLimit", "tempAllowed"], (data) => {
        const tabUrl = tab.url || "";
        const resolvedTabUrl = resolveRedirectUrl(tabUrl);
        const nowTime = new Date().getTime();
        let tempAllowed = data.tempAllowed || {};
        for (const key in tempAllowed) {
          if (isMatchingSite(resolvedTabUrl, key)) {
            if (nowTime >= tempAllowed[key]) {
              const encoded = encodeURIComponent(resolvedTabUrl);
              delete tempAllowed[key];
              chrome.storage.local.set({ tempAllowed }, () => {
                chrome.tabs.update(tab.id, {
                  url: chrome.runtime.getURL(`blocked.html?target=${encoded}`),
                });
              });
              sendResponse({ isTarget: false, remainingSeconds: 0 });
              return;
            }
          }
        }
        const dl = migrateDailyLimit(data.dailyLimit);
        if (!dl || !dl.enabled || !dl.sites) {
          sendResponse({ isTarget: false, remainingSeconds: 0 });
          return;
        }

        let targetSiteKey = null;
        for (const site in dl.sites) {
          if (isMatchingSite(resolvedTabUrl, site)) {
            targetSiteKey = site;
            break;
          }
        }

        if (!targetSiteKey) {
          sendResponse({ isTarget: false, remainingSeconds: 0 });
          return;
        }

        const siteData = dl.sites[targetSiteKey];
        const today = new Date().toDateString();
        if (siteData.lastReset !== today) {
          siteData.usedTodaySeconds = 0;
          siteData.lastReset = today;
        }

        siteData.usedTodaySeconds = (siteData.usedTodaySeconds || 0) + 1;
        const remainingSeconds = Math.max(0, siteData.minutes * 60 - siteData.usedTodaySeconds);

        chrome.storage.local.set({ dailyLimit: dl }, () => {
          if (remainingSeconds <= 0) {
            const encoded = encodeURIComponent(resolvedTabUrl);
            chrome.tabs.update(tab.id, {
              url: chrome.runtime.getURL(
                `blocked.html?target=${encoded}&reason=limit`,
              ),
            });
          }
          sendResponse({ isTarget: true, remainingSeconds });
        });
      });
    });
    return true;
  }
});