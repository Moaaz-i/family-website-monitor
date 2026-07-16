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

function getHostname(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch {
    if (urlString.startsWith("chrome://")) {
      const match = urlString.match(/^chrome:\/\/([^\/]+)/);
      return match ? match[1] : null;
    }
    return null;
  }
}

function resolveRedirectUrl(urlString) {
  if (!urlString) return urlString;
  try {
    const urlObj = new URL(urlString);
    if (urlObj.hostname.includes("google.") && urlObj.pathname === "/url") {
      const target =
        urlObj.searchParams.get("q") || urlObj.searchParams.get("url");
      if (target) return target;
    }
    if (
      urlObj.hostname.includes("duckduckgo.com") &&
      (urlObj.pathname === "/y.js" || urlObj.pathname === "/l/")
    ) {
      const target =
        urlObj.searchParams.get("u") || urlObj.searchParams.get("uddg");
      if (target) return target;
    }
  } catch (e) {}
  return urlString;
}

function isMatchingSite(urlString, targetSite) {
  if (!urlString || !targetSite) return false;
  const parsedUrl = buildStrictUrl(urlString);
  const parsedTarget = buildStrictUrl(targetSite);
  return Boolean(parsedUrl && parsedTarget && parsedUrl === parsedTarget);
}

function isUrlAllowed(urlString, data) {
  if (!urlString || !data || !data.whitelist) return false;
  const resolved = resolveRedirectUrl(urlString);
  return data.whitelist.some((e) => isMatchingSite(resolved, e.fullUrl));
}

function isWithinSchedule(schedule) {
  if (!schedule || !schedule.enabled) return true;
  const now = new Date();
  const day = now.getDay();
  if (!schedule.days[day]) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = schedule.startTime.split(":").map(Number);
  const [eh, em] = schedule.endTime.split(":").map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function isDailyLimitExceeded(dl, urlString) {
  if (!dl || !dl.enabled || !dl.targetSites) return false;
  const today = new Date().toDateString();
  const usedToday = dl.lastReset === today ? dl.usedToday : 0;
  const resolved = resolveRedirectUrl(urlString);
  const isTarget = dl.targetSites.some((site) =>
    isMatchingSite(resolved, site),
  );
  if (isTarget) {
    return usedToday >= dl.minutes;
  }
  return false;
}

function checkAndApplyRules(url, tabId) {
  const resolvedUrl = resolveRedirectUrl(url);
  if (
    resolvedUrl.startsWith("chrome://extensions") ||
    resolvedUrl.includes("chrome://extensions/")
  ) {
    chrome.tabs.update(tabId, {
      url: chrome.runtime.getURL("blocked-extensions.html"),
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
    ],
    (data) => {
      if (!data.password) {
        chrome.tabs.update(tabId, {
          url: chrome.runtime.getURL("options.html?setup=true"),
        });
        return;
      }
      const tempAllowed = data.tempAllowed || {};
      let isTempActive = false;
      for (const key in tempAllowed) {
        if (isMatchingSite(resolvedUrl, key)) {
          if (new Date().getTime() < tempAllowed[key]) {
            isTempActive = true;
            break;
          } else {
            delete tempAllowed[key];
            chrome.storage.local.set({ tempAllowed });
          }
        }
      }
      if (isTempActive) return;
      const encoded = encodeURIComponent(resolvedUrl);
      if (data.emergencyLock) {
        chrome.tabs.update(tabId, {
          url: chrome.runtime.getURL(
            `blocked.html?target=${encoded}&reason=emergency`,
          ),
        });
        return;
      }
      if (!isWithinSchedule(data.schedule)) {
        chrome.tabs.update(tabId, {
          url: chrome.runtime.getURL(
            `blocked.html?target=${encoded}&reason=schedule`,
          ),
        });
        return;
      }
      if (isDailyLimitExceeded(data.dailyLimit, resolvedUrl)) {
        chrome.tabs.update(tabId, {
          url: chrome.runtime.getURL(
            `blocked.html?target=${encoded}&reason=limit`,
          ),
        });
        return;
      }
      const isTargetDailyLimitSite =
        data.dailyLimit &&
        data.dailyLimit.enabled &&
        data.dailyLimit.targetSites &&
        data.dailyLimit.targetSites.some((site) =>
          isMatchingSite(resolvedUrl, site),
        );
      if (isTargetDailyLimitSite) {
        return;
      }
      const allowed = isUrlAllowed(resolvedUrl, data);
      if (!allowed) {
        chrome.tabs.update(tabId, {
          url: chrome.runtime.getURL(`blocked.html?target=${encoded}`),
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
const VERSION_URL =
  "https://raw.githubusercontent.com/Moaaz-i/family-website-monitor/main/version.json";

function getCurrentVersion() {
  return chrome.runtime.getManifest().version;
}

function compareVersions(v1, v2) {
  // Returns true if v2 is newer than v1
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

// Check on startup
fetchAndCheckUpdates();

// Check every 6 hours
chrome.alarms.create("checkForUpdates", { periodInMinutes: 360 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkForUpdates") {
    fetchAndCheckUpdates();
    return;
  }
  if (alarm.name !== "trackTime") return;
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
    const dl = data.dailyLimit;
    if (!dl || !dl.enabled) return;
    const today = new Date().toDateString();
    if (dl.lastReset !== today) {
      dl.usedToday = 0;
      dl.usedTodaySeconds = 0;
      dl.lastReset = today;
      chrome.storage.local.set({ dailyLimit: dl });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      const dl = data.dailyLimit;
      let dlData = { isTarget: false, remainingSeconds: 0 };
      if (dl && dl.enabled && dl.targetSites && resolvedTabUrl) {
        const isTarget = dl.targetSites.some((site) =>
          isMatchingSite(resolvedTabUrl, site),
        );
        if (isTarget) {
          const today = new Date().toDateString();
          const usedTodaySeconds =
            dl.lastReset === today
              ? dl.usedTodaySeconds || dl.usedToday * 60 || 0
              : 0;
          dlData = {
            isTarget: true,
            remainingSeconds: Math.max(0, dl.minutes * 60 - usedTodaySeconds),
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
      ],
      (data) => {
        const url = resolveRedirectUrl(message.url);
        const now = new Date().getTime();
        if (!data.password) {
          sendResponse({ status: "blocked", reason: "setup" });
          return;
        }
        let isTempActive = false;
        if (data.tempAllowed) {
          for (const key in data.tempAllowed) {
            if (isMatchingSite(url, key)) {
              if (now < data.tempAllowed[key]) {
                isTempActive = true;
                break;
              }
            }
          }
        }
        if (isTempActive) {
          sendResponse({ status: "allowed" });
          return;
        }
        if (data.emergencyLock) {
          sendResponse({ status: "blocked", reason: "emergency" });
          return;
        }
        if (!isWithinSchedule(data.schedule)) {
          sendResponse({ status: "blocked", reason: "schedule" });
          return;
        }
        if (isDailyLimitExceeded(data.dailyLimit, url)) {
          sendResponse({ status: "blocked", reason: "limit" });
          return;
        }
        const isTargetDailyLimitSite =
          data.dailyLimit &&
          data.dailyLimit.enabled &&
          data.dailyLimit.targetSites &&
          data.dailyLimit.targetSites.some((site) => isMatchingSite(url, site));
        if (isTargetDailyLimitSite) {
          sendResponse({ status: "allowed" });
          return;
        }
        const allowed = isUrlAllowed(url, data);
        if (allowed) {
          sendResponse({ status: "allowed" });
        } else {
          sendResponse({ status: "blocked", reason: "default" });
        }
      },
    );
    return true;
  }
  if (message.type === "forceBlockRedirect") {
    const resolvedUrl = resolveRedirectUrl(message.url);
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
    chrome.storage.local.get(["dailyLimit", "tempAllowed"], (data) => {
      const tabUrl = sender.tab ? sender.tab.url : "";
      const resolvedTabUrl = resolveRedirectUrl(tabUrl);
      const nowTime = new Date().getTime();
      let tempAllowed = data.tempAllowed || {};
      for (const key in tempAllowed) {
        if (isMatchingSite(resolvedTabUrl, key)) {
          if (nowTime >= tempAllowed[key]) {
            const encoded = encodeURIComponent(resolvedTabUrl);
            delete tempAllowed[key];
            chrome.storage.local.set({ tempAllowed }, () => {
              chrome.tabs.update(sender.tab.id, {
                url: chrome.runtime.getURL(`blocked.html?target=${encoded}`),
              });
            });
            sendResponse({ isTarget: false, remainingSeconds: 0 });
            return;
          }
        }
      }
      const dl = data.dailyLimit;
      if (
        !dl ||
        !dl.enabled ||
        !dl.targetSites ||
        !sender.tab ||
        !sender.tab.url
      ) {
        sendResponse({ isTarget: false, remainingSeconds: 0 });
        return;
      }
      const isTarget = dl.targetSites.some((site) =>
        isMatchingSite(resolvedTabUrl, site),
      );
      if (!isTarget) {
        sendResponse({ isTarget: false, remainingSeconds: 0 });
        return;
      }
      const today = new Date().toDateString();
      if (dl.lastReset !== today) {
        dl.usedTodaySeconds = 0;
        dl.usedToday = 0;
        dl.lastReset = today;
      }
      if (dl.usedTodaySeconds === undefined || dl.usedTodaySeconds === null) {
        dl.usedTodaySeconds = dl.usedToday * 60 || 0;
      }
      dl.usedTodaySeconds += 1;
      dl.usedToday = Math.floor(dl.usedTodaySeconds / 60);
      const remainingSeconds = Math.max(
        0,
        dl.minutes * 60 - dl.usedTodaySeconds,
      );
      chrome.storage.local.set({ dailyLimit: dl }, () => {
        if (remainingSeconds <= 0) {
          const encoded = encodeURIComponent(resolvedTabUrl);
          chrome.tabs.update(sender.tab.id, {
            url: chrome.runtime.getURL(
              `blocked.html?target=${encoded}&reason=limit`,
            ),
          });
        }
        sendResponse({ isTarget: true, remainingSeconds });
      });
    });
    return true;
  }
});
