import { resolveRedirectUrl, isSameSite, isValidRedirectTarget, isEnforceableUrl } from "./lib/url.js";
import { encodePolicy, decodePolicy, stableStringify, chunkKey, SYNC_META_KEY, SYNC_CHUNK_PREFIX } from "./lib/sync-codec.js";
import { normalizeSyncedPayload, planApplySync } from "./lib/sync-policy.js";
import {
  migrateDailyLimit,
  migrateScreenTime,
  isScreenTimeExhausted,
  screenTimeUsedSeconds,
  determineUrlStatus,
} from "./lib/rules.js";
import {
  verifyPasswordInput,
  createPasswordSpec,
  needsRehash,
  generateSessionToken,
} from "./lib/security.js";
import {
  TIME_TAMPER_THRESHOLD_MS,
  UPDATE_CHECK_PERIOD_MIN,
  VERSION_URL,
  SESSION_DURATION_MS,
  BRUTE_FORCE_THRESHOLD,
  BRUTE_FORCE_LOCKOUT_MS,
  WRONG_ATTEMPT_LOG_MAX,
  POLICY_CACHE_TTL_MS,
  USAGE_FLUSH_MS,
  REDIRECT_RATE_WINDOW_MS,
  REDIRECT_RATE_MAX,
  NOTIFY_MESSAGES,
  MORE_TIME_MINUTES,
  MORE_TIME_COOLDOWN_MS,
  MORE_TIME_REQUEST_TTL_MS,
} from "./lib/constants.js";

// ─── Small promise helpers around the callback Chrome APIs ───────────────────
function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => {
      if (chrome.runtime.lastError) return resolve({});
      resolve(data || {});
    });
  });
}

function storageSet(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => resolve());
  });
}

function queryTabs(query) {
  return new Promise((resolve) => {
    chrome.tabs.query(query, (tabs) => {
      if (chrome.runtime.lastError) return resolve([]);
      resolve(tabs || []);
    });
  });
}

function updateTab(tabId, props) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, props, () => resolve());
  });
}

// ─── Policy cache ────────────────────────────────────────────────────────────
// Every navigation used to trigger its own chrome.storage.local.get(). The
// rules are read through a short-lived cache instead, and any storage write
// invalidates it through storage.onChanged below.
const POLICY_KEYS = [
  "password",
  "whitelist",
  "blockedKeywords",
  "schedule",
  "dailyLimit",
  "emergencyLock",
  "tempAllowed",
  "timeTampered",
  "language",
  "screenTime",
  "notificationsEnabled",
];

let policyCache = null;
let policyCacheAt = 0;

function getPolicy(callback) {
  const now = Date.now();
  if (policyCache && now - policyCacheAt < POLICY_CACHE_TTL_MS) {
    callback(policyCache);
    return;
  }
  chrome.storage.local.get(POLICY_KEYS, (data) => {
    if (chrome.runtime.lastError) return callback({});
    policyCache = data || {};
    policyCacheAt = Date.now();
    callback(policyCache);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (POLICY_KEYS.some((key) => key in changes)) {
      policyCache = null;
      policyCacheAt = 0;
    }
    if (SYNCED_KEYS.some((key) => key in changes)) schedulePolicyPush();
    return;
  }

  if (area === "sync") {
    const touched =
      SYNC_META_KEY in changes ||
      Object.keys(changes).some((key) => key.startsWith(SYNC_CHUNK_PREFIX));
    if (touched) schedulePolicyApply();
  }
});

// ─── Cross-device policy mirror (chrome.storage.sync) ───────────────────────
// Rules are read from chrome.storage.local everywhere else. Sync only mirrors
// a copy, so a family with two devices configures the lists once. The parent
// password, sessions and every usage counter stay local: the password must
// never leave this device, and counters would churn the quota for nothing.
const SYNCED_KEYS = [
  "whitelist",
  "blockedKeywords",
  "schedule",
  "dailyLimit",
  "notificationsEnabled",
  "screenTime",
];
const SYNC_PUSH_DEBOUNCE_MS = 3000;
const SYNC_APPLY_DEBOUNCE_MS = 1500;

let lastSyncedJson = null; // content of the last copy we pushed or accepted
let syncPushTimer = null;
let syncApplyTimer = null;

function setSyncStatus(status) {
  storageSet({ policySyncStatus: status });
}

/** The policy document as it should travel — configuration, not counters. */
/** The policy document as it should travel — configuration, not counters. */
function readSyncedPolicy() {
  return storageGet(SYNCED_KEYS).then((data) => normalizeSyncedPayload(data, SYNCED_KEYS));
}

function pushPolicyToSync() {
  readSyncedPolicy().then((payload) => {
    const json = stableStringify(payload);
    // Identical content must never be written back: that is exactly how two
    // devices end up echoing each other forever.
    if (json === lastSyncedJson) return;

    const rev = Date.now();
    const encoded = encodePolicy(payload, rev);
    if (!encoded) {
      setSyncStatus("too-large");
      return;
    }

    const items = { [SYNC_META_KEY]: encoded.meta };
    encoded.chunks.forEach((chunk, index) => {
      items[chunkKey(index)] = chunk;
    });

    chrome.storage.sync.set(items, () => {
      if (chrome.runtime.lastError) {
        setSyncStatus("quota");
        return;
      }
      lastSyncedJson = json;
      setSyncStatus("ok");
      // Remember what we published so the echo of our own write is ignored.
      storageSet({ policySyncRev: rev });
    });
  });
}

function applyPolicyFromSync() {
  chrome.storage.sync.get([SYNC_META_KEY], (data) => {
    const meta = data[SYNC_META_KEY];
    if (chrome.runtime.lastError || !meta || typeof meta.chunks !== "number") {
      // Nothing mirrored yet (fresh device): publish what this device has so
      // the next device in the family finds it.
      schedulePolicyPush();
      return;
    }

    const keys = [];
    for (let i = 0; i < meta.chunks; i++) keys.push(chunkKey(i));

    chrome.storage.sync.get(keys, (stored) => {
      if (chrome.runtime.lastError) return;
      const decoded = decodePolicy(meta, keys.map((key) => stored[key]));
      if (!decoded) return;
      // Same content we already know — nothing to write.
      if (decoded.json === lastSyncedJson) return;

      storageGet(["policySyncRev", "screenTime"]).then((local) => {
        // The echo of our own push and any stale copy are refused here; a
        // device that was offline must not roll the policy back.
        const payload = planApplySync(decoded, local.policySyncRev, lastSyncedJson, local.screenTime);
        if (!payload) return;

        lastSyncedJson = decoded.json;
        storageSet({ ...payload, policySyncRev: decoded.rev });
      });
    });
  });
}

function schedulePolicyPush() {
  if (syncPushTimer) clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    syncPushTimer = null;
    pushPolicyToSync();
  }, SYNC_PUSH_DEBOUNCE_MS);
}

function schedulePolicyApply() {
  if (syncApplyTimer) clearTimeout(syncApplyTimer);
  syncApplyTimer = setTimeout(() => {
    syncApplyTimer = null;
    applyPolicyFromSync();
  }, SYNC_APPLY_DEBOUNCE_MS);
}

// Pull once when the worker comes up (install, browser start, wake), so a
// device that was off when the parent changed a rule catches up.
setTimeout(schedulePolicyApply, SYNC_APPLY_DEBOUNCE_MS);

// ─── Usage + activity accounting (write-behind) ────────────────────────────
// Seconds are accrued in memory and only flushed to storage every
// USAGE_FLUSH_MS (or when a limit runs out / the alarm fires). Previously the
// service worker wrote storage once per second, per open tab.
const pendingUsage = new Map(); // siteKey  -> seconds against a daily limit
const pendingActivity = new Map(); // host     -> { seconds, visits, blocked }
let pendingScreenSeconds = 0; // seconds against the whole-day budget
let pendingDay = new Date().toDateString();
let lastUsageFlush = 0;
let usageFlushInFlight = false;

const ACTIVITY_DAYS = 14;
const ACTIVITY_MAX_HOSTS_PER_DAY = 300;

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function recentDayKeys(days) {
  const keys = new Set();
  const cursor = new Date();
  for (let i = 0; i < days; i++) {
    keys.add(dayKey(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return keys;
}

function hostOf(urlString) {
  try {
    const host = new URL(urlString).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

function accrueSeconds(siteKey, seconds) {
  if (!siteKey || seconds <= 0) return;
  const today = new Date().toDateString();
  if (today !== pendingDay) {
    pendingUsage.clear();
    pendingActivity.clear();
    pendingScreenSeconds = 0;
    pendingDay = today;
  }
  pendingUsage.set(siteKey, (pendingUsage.get(siteKey) || 0) + seconds);
}

// The whole-day budget accrues alongside per-site usage, from the same beat.
function accrueScreenSeconds(seconds) {
  if (seconds <= 0) return;
  const today = new Date().toDateString();
  if (today !== pendingDay) {
    pendingUsage.clear();
    pendingActivity.clear();
    pendingScreenSeconds = 0;
    pendingDay = today;
  }
  pendingScreenSeconds += seconds;
}

/** Seconds of today's budget already spent, persisted + not yet flushed. */
function consumedScreenSeconds(stored) {
  return screenTimeUsedSeconds(stored.screenTime) + pendingScreenSeconds;
}

function queueActivity(host, fields) {
  if (!host) return;
  const entry = pendingActivity.get(host) || { seconds: 0, visits: 0, blocked: 0 };
  entry.seconds += fields.seconds || 0;
  entry.visits += fields.visits || 0;
  entry.blocked += fields.blocked || 0;
  pendingActivity.set(host, entry);
}

// tabs.onUpdated fires several times per navigation, so a raw "visit" counter
// would inflate by 3-4x. Deduplicate per host for a short window.
const visitDedupe = new Map();
const VISIT_DEDUPE_MS = 45000;

// tabId -> timestamp of that tab's most recent heartbeat.
const lastBeatAt = new Map();

function queueVisit(host, fields) {
  if (!host) return;
  const now = Date.now();
  const last = visitDedupe.get(host) || 0;
  if (now - last < VISIT_DEDUPE_MS) return;
  if (visitDedupe.size > 500) visitDedupe.clear();
  visitDedupe.set(host, now);
  queueActivity(host, { visits: 1, blocked: fields.blocked || 0 });
}

function consumedSeconds(siteData, siteKey) {
  if (!siteData) return 0;
  const today = new Date().toDateString();
  const persisted = siteData.lastReset === today ? siteData.usedTodaySeconds || 0 : 0;
  return persisted + (pendingUsage.get(siteKey) || 0);
}

function flushUsage(force = false) {
  const now = Date.now();
  if (!force && now - lastUsageFlush < USAGE_FLUSH_MS) return Promise.resolve();
  if (pendingUsage.size === 0 && pendingActivity.size === 0 && pendingScreenSeconds === 0) {
    return Promise.resolve();
  }
  if (usageFlushInFlight) return Promise.resolve();

  const usageBatch = new Map(pendingUsage);
  pendingUsage.clear();
  const activityBatch = new Map(pendingActivity);
  pendingActivity.clear();
  const screenBatch = pendingScreenSeconds;
  pendingScreenSeconds = 0;
  lastUsageFlush = now;
  usageFlushInFlight = true;

  return storageGet(["dailyLimit", "activity", "screenTime"])
    .then((stored) => {
      const out = {};
      const today = new Date().toDateString();

      if (usageBatch.size > 0) {
        const dl = migrateDailyLimit(stored.dailyLimit);
        let changed = false;
        for (const [siteKey, seconds] of usageBatch) {
          const site = dl.sites[siteKey];
          if (!site) continue;
          if (site.lastReset !== today) {
            site.usedTodaySeconds = 0;
            site.lastReset = today;
          }
          site.usedTodaySeconds = (site.usedTodaySeconds || 0) + seconds;
          changed = true;
        }
        if (changed) out.dailyLimit = dl;
      }

      if (screenBatch > 0) {
        // Written unconditionally: the budget must survive a worker restart,
        // and a parent may toggle it on mid-day with today's usage intact.
        const st = migrateScreenTime(stored.screenTime);
        if (st.lastReset !== today) {
          st.usedSeconds = 0;
          st.lastReset = today;
        }
        st.usedSeconds += screenBatch;
        out.screenTime = st;
      }

      if (activityBatch.size > 0) {
        const activity =
          stored.activity && typeof stored.activity === "object" ? stored.activity : {};
        const keep = recentDayKeys(ACTIVITY_DAYS);
        for (const key of Object.keys(activity)) {
          if (!keep.has(key)) delete activity[key];
        }
        const bucket = activity[dayKey()] || (activity[dayKey()] = {});
        for (const [host, fields] of activityBatch) {
          if (!bucket[host] && Object.keys(bucket).length >= ACTIVITY_MAX_HOSTS_PER_DAY) {
            continue;
          }
          const entry = bucket[host] || { seconds: 0, visits: 0, blocked: 0 };
          entry.seconds += fields.seconds;
          entry.visits += fields.visits;
          entry.blocked += fields.blocked;
          bucket[host] = entry;
        }
        out.activity = activity;
      }

      if (Object.keys(out).length === 0) return Promise.resolve();
      return storageSet(out);
    })
    .finally(() => {
      usageFlushInFlight = false;
    });
}

// ─── Navigation rules ───────────────────────────────────────────────────────
function isExtensionsUrl(url) {
  return (
    url.startsWith("chrome://extensions") ||
    url.includes("chrome://extensions/") ||
    url.startsWith("chrome://settings/system") ||
    url.startsWith("chrome://settings/extensions")
  );
}

async function enforceExtensionsGuard(tabId) {
  const store = await storageGet(["extensionsAccessExpiry"]);
  const allowedUntil = store.extensionsAccessExpiry || 0;
  if (Date.now() >= allowedUntil) {
    await updateTab(tabId, { url: chrome.runtime.getURL("blocked-extensions.html") });
  }
}

// Sub-frame navigations used to be ignored completely, which made every
// <iframe src="blocked-site"> a free bypass: the frame is not our top frame,
// so neither the content script nor the redirect ever touched it. The rules
// are now evaluated for every frame; a blocked sub-frame drags the whole tab
// to the blocked page (an extension page cannot be framed, so redirecting the
// frame itself would just leave a blank box).
//
// Only *destinations* are judged (see isEnforceableUrl): a frame whose URL is
// about:blank, about:srcdoc, data: or blob: is an empty or parent-owned box —
// every site creates them for lazy embeds — and blocking those bounced whole
// tabs to blocked.html?target=about:blank the moment an allowed page loaded.
const recentBlockRedirects = new Map(); // `${tabId}` -> { url, at }
const BLOCK_REDIRECT_COOLDOWN_MS = 4000;

function checkAndApplyRules(url, tabId, frameId = 0) {
  const resolvedUrl = resolveRedirectUrl(url);
  const isTopFrame = frameId === 0;

  // Security Feature #17: Block extensions page access to prevent extension disable
  if (isTopFrame && isExtensionsUrl(resolvedUrl)) {
    enforceExtensionsGuard(tabId);
    return;
  }

  if (resolvedUrl.startsWith("chrome://") || resolvedUrl.startsWith("chrome-extension://")) {
    return;
  }

  // `about:blank`, `about:srcdoc`, `data:` and `blob:` frames are not sites:
  // they are empty or parent-owned boxes inside a page that was checked
  // already. Every real http(s) destination — in any frame — is still
  // judged below. (Skipping them here is what stops an allowed site from
  // bouncing the whole tab the moment it creates a lazy embed.)
  if (!isEnforceableUrl(resolvedUrl)) {
    return;
  }

  getPolicy((data) => {
    if (!data.password) {
      // Only the top frame may bounce the tab into setup — a stray iframe
      // (analytics, embed) would otherwise reload the panel forever.
      if (isTopFrame) {
        chrome.tabs.update(tabId, { url: chrome.runtime.getURL("options.html?setup=true") });
      }
      return;
    }

    const result = determineUrlStatus(resolvedUrl, data);
    const host = hostOf(resolvedUrl);

    if (result.status !== "blocked") {
      if (isTopFrame) queueVisit(host, {});
      return;
    }

    queueVisit(host, { blocked: 1 });

    // One redirect per tab per URL: a page with several blocked frames fires
    // this once per frame.
    const recent = recentBlockRedirects.get(tabId);
    if (recent && recent.url === resolvedUrl && Date.now() - recent.at < BLOCK_REDIRECT_COOLDOWN_MS) {
      return;
    }
    recentBlockRedirects.set(tabId, { url: resolvedUrl, at: Date.now() });
    if (recentBlockRedirects.size > 200) recentBlockRedirects.clear();

    const encoded = encodeURIComponent(resolvedUrl);
    const reasonParam = result.reason ? `&reason=${result.reason}` : "";
    chrome.tabs.update(tabId, {
      url: chrome.runtime.getURL(`blocked.html?target=${encoded}${reasonParam}`),
    });
  });
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  checkAndApplyRules(details.url, details.tabId, details.frameId);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  checkAndApplyRules(details.url, details.tabId, details.frameId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "loading") {
    const urlToCheck = changeInfo.url || tab.url;
    if (urlToCheck) checkAndApplyRules(urlToCheck, tabId);
  }
});

// ─── Rate limiting for content-initiated redirects ──────────────────────────
const redirectWindow = [];

function allowRedirectBurst() {
  const now = Date.now();
  while (redirectWindow.length && now - redirectWindow[0] > REDIRECT_RATE_WINDOW_MS) {
    redirectWindow.shift();
  }
  if (redirectWindow.length >= REDIRECT_RATE_MAX) return false;
  redirectWindow.push(now);
  return true;
}

// ─── Parent authentication ───────────────────────────────────────────────────
// Verification lives here (service worker) so that no extension page ever
// reads the stored password hash: a page-context script could otherwise dump
// chrome.storage.local and crack the hash offline.
// ─── PIN quick unlock ─────────────────────────────────────────────────────
// The PIN exists so a parent does not have to type a long password in front
// of a child. It is shorter, so it deliberately shares the brute-force
// lockout counter and the failed-attempt log with the real password, and it
// only ever unlocks the popup — changing the rules still needs the password.
const PIN_MIN_LENGTH = 4;
const PIN_MAX_LENGTH = 8;

function isValidPin(pin) {
  return (
    typeof pin === "string" &&
    /^[0-9]+$/.test(pin) &&
    pin.length >= PIN_MIN_LENGTH &&
    pin.length <= PIN_MAX_LENGTH
  );
}

async function handleVerifyCredential(candidate, site, field) {
  const data = await storageGet([
    "password",
    field,
    "failedAttemptsCount",
    "lockoutExpiry",
    "wrongAttempts",
  ]);
  const now = Date.now();
  const lockoutExpiry = data.lockoutExpiry || 0;

  if (lockoutExpiry > now) {
    return { ok: false, reason: "locked", lockoutExpiry, attempts: data.failedAttemptsCount || 0 };
  }
  if (!data.password) {
    return { ok: false, reason: "not-configured" };
  }
  const spec = data[field];
  if (!spec) {
    return { ok: false, reason: field === "pinHash" ? "no-pin" : "not-configured" };
  }

  const text = typeof candidate === "string" ? candidate : "";
  const shaped = field === "pinHash" ? isValidPin(text) : text.length > 0;
  const correct = shaped && (await verifyPasswordInput(text, spec));

  if (correct) {
    const updates = {
      failedAttemptsCount: 0,
      lockoutExpiry: 0,
      sessionToken: generateSessionToken(),
      sessionExpiry: now + SESSION_DURATION_MS,
    };
    if (field === "password" && needsRehash(spec)) {
      // Transparent upgrade of legacy sha256$/plaintext specs.
      updates.password = await createPasswordSpec(text);
    }
    await storageSet(updates);
    return { ok: true, sessionToken: updates.sessionToken, sessionExpiry: updates.sessionExpiry };
  }

  const attempts = (data.failedAttemptsCount || 0) + 1;
  const updates = { failedAttemptsCount: attempts };
  if (attempts >= BRUTE_FORCE_THRESHOLD) {
    updates.lockoutExpiry = now + BRUTE_FORCE_LOCKOUT_MS;
  }

  const wrongAttempts = Array.isArray(data.wrongAttempts) ? data.wrongAttempts.slice() : [];
  wrongAttempts.push({
    site: site || "Unknown",
    time: new Date().toLocaleString("en-US"),
  });
  if (wrongAttempts.length > WRONG_ATTEMPT_LOG_MAX) wrongAttempts.shift();
  updates.wrongAttempts = wrongAttempts;

  await storageSet(updates);
  return { ok: false, reason: "wrong", lockoutExpiry: updates.lockoutExpiry || 0, attempts };
}

async function handleVerifyPassword({ password, site }) {
  return handleVerifyCredential(password, site, "password");
}

async function handleVerifyPin({ pin, site }) {
  return handleVerifyCredential(pin, site, "pinHash");
}

// ─── Time status snapshots ──────────────────────────────────────────────────
function resolveTempRemaining(data, resolvedUrl) {
  const tempAllowed = data.tempAllowed || {};
  const now = Date.now();
  for (const key in tempAllowed) {
    if (isSameSite(resolvedUrl, key)) {
      const expiry = tempAllowed[key];
      if (expiry > now) return Math.floor((expiry - now) / 1000);
      return -1; // expired, caller decides what to do
    }
  }
  return 0;
}

function findLimitSite(dl, resolvedUrl) {
  if (!dl || !dl.enabled || !dl.sites) return null;
  for (const site in dl.sites) {
    // Site-level match: a limit on "youtube.com" applies to every URL of the
    // site, not just to the bare host with an empty path.
    if (isSameSite(resolvedUrl, site)) return site;
  }
  return null;
}

function buildTimeSnapshot(data, resolvedUrl) {
  const dl = migrateDailyLimit(data.dailyLimit);
  const siteKey = findLimitSite(dl, resolvedUrl);

  let daily = { isTarget: false, remainingSeconds: 0, siteKey: null };
  if (siteKey) {
    const siteData = dl.sites[siteKey];
    daily = {
      isTarget: true,
      siteKey,
      remainingSeconds: Math.max(0, siteData.minutes * 60 - consumedSeconds(siteData, siteKey)),
    };
  }

  const tempRemaining = resolvedUrl ? resolveTempRemaining(data, resolvedUrl) : 0;
  const temp = {
    isTemp: tempRemaining > 0,
    remainingSeconds: Math.max(0, tempRemaining),
  };

  const st = migrateScreenTime(data.screenTime);
  const spent = consumedScreenSeconds(data);
  const screen = {
    enabled: Boolean(st.enabled) && st.minutes > 0,
    minutes: st.minutes,
    usedSeconds: spent,
    remainingSeconds: Math.max(0, st.minutes * 60 - spent),
    exhausted: isScreenTimeExhausted(data.screenTime),
  };

  return { dl, daily, temp, screen };
}

// ─── Advance warning ────────────────────────────────────────────────────────
// A parent would rather be told "5 minutes left" than discover it when the
// page goes dark. Fires at most twice per site per day.
async function maybeNotify(siteKey, remainingSeconds, policy) {
  if (!chrome.notifications || !chrome.notifications.create) return;
  if (remainingSeconds > 300) return;

  const threshold = remainingSeconds <= 60 ? 60 : 300;
  const stored = await storageGet(["lastNotified", "notificationsEnabled"]);
  if (stored.notificationsEnabled === false) return;

  const map =
    stored.lastNotified && typeof stored.lastNotified === "object" ? stored.lastNotified : {};
  const stamp = `${dayKey()}|${threshold}`;
  if (map[siteKey] === stamp) return;

  // Drop stamps from previous days so the map cannot grow forever. The day
  // lives in the value, so only genuinely stale entries are removed and one
  // site's warning never cancels another's.
  for (const key of Object.keys(map)) {
    if (!String(map[key] || "").startsWith(`${dayKey()}|`)) delete map[key];
  }
  map[siteKey] = stamp;
  await storageSet({ lastNotified: map });

  const lang = policy && policy.language === "ar" ? "ar" : "en";
  const strings = NOTIFY_MESSAGES[lang];
  const host = hostOf(siteKey) || siteKey;
  const body =
    threshold === 60
      ? strings.oneMinute(host)
      : strings.fiveMinutes(host, Math.max(1, Math.ceil(remainingSeconds / 60)));

  chrome.notifications.create(
    `time-${threshold}-${siteKey}`,
    {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: strings.title,
      message: body,
      priority: 1,
    },
    () => void chrome.runtime.lastError,
  );
}

// ─── "Ask a parent for more time" ───────────────────────────────────────────
// The child never grants itself time: the button on the blocked page only
// raises a notification with two buttons, and the allowance is written here,
// in the worker, by the parent's own tap.
const lastTimeAskAt = new Map(); // tabId -> timestamp of the last request
const pendingTimeAsks = new Map(); // notificationId -> { url, tabId, at }

function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(tab || null);
    });
  });
}

async function handleRequestMoreTime(message, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) return { ok: false, reason: "no-tab" };

  const url = resolveRedirectUrl(String(message.url || ""));
  if (!isValidRedirectTarget(url)) return { ok: false, reason: "bad-url" };

  const now = Date.now();
  const lastAsk = lastTimeAskAt.get(tabId) || 0;
  if (now - lastAsk < MORE_TIME_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown", retryInMs: MORE_TIME_COOLDOWN_MS - (now - lastAsk) };
  }

  const data = await storageGet(["language", "tempAllowed"]);
  if (resolveTempRemaining(data, url) > 0) {
    // Already open — asking again would only spam the parent.
    return { ok: false, reason: "already-allowed" };
  }

  if (!chrome.notifications || !chrome.notifications.create) {
    return { ok: false, reason: "notifications-unavailable" };
  }

  lastTimeAskAt.set(tabId, now);

  // Requests nobody answered expire instead of lingering forever.
  for (const [id, ask] of pendingTimeAsks) {
    if (now - ask.at > MORE_TIME_REQUEST_TTL_MS) pendingTimeAsks.delete(id);
  }

  const notificationId = `moretime-${tabId}-${now}`;
  pendingTimeAsks.set(notificationId, { url, tabId, at: now });

  const lang = data.language === "ar" ? "ar" : "en";
  const strings = NOTIFY_MESSAGES[lang];
  const host = hostOf(url) || url;

  chrome.notifications.create(
    notificationId,
    {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: strings.moreTimeTitle,
      message: strings.moreTimeBody(host, MORE_TIME_MINUTES),
      buttons: [
        { title: strings.moreTimeGive(MORE_TIME_MINUTES) },
        { title: strings.moreTimeDeny },
      ],
      priority: 2,
    },
    () => void chrome.runtime.lastError,
  );

  return { ok: true, minutes: MORE_TIME_MINUTES };
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  const ask = pendingTimeAsks.get(notificationId);
  if (!ask) return;
  pendingTimeAsks.delete(notificationId);
  chrome.notifications.clear(notificationId, () => void chrome.runtime.lastError);
  if (buttonIndex !== 0) return; // "Not now"
  grantTemporaryAllowance(ask).catch((e) => console.error("grant failed:", e));
});

chrome.notifications.onClosed.addListener((notificationId) => {
  pendingTimeAsks.delete(notificationId);
});

async function grantTemporaryAllowance({ url, tabId }) {
  const minutes = MORE_TIME_MINUTES;
  const data = await storageGet(["tempAllowed"]);
  const tempAllowed = { ...(data.tempAllowed || {}) };
  tempAllowed[url] = Date.now() + minutes * 60000;
  // The policy cache drops out through storage.onChanged.
  await storageSet({ tempAllowed });

  // Send the child straight back to the page they were blocked on, but only
  // if that tab is still sitting on our blocked page.
  const tab = await getTab(tabId);
  if (tab && tab.url && tab.url.startsWith(chrome.runtime.getURL("blocked.html"))) {
    await updateTab(tabId, { url });
  }
}

// ─── Auto-Update System ─────────────────────────────────────────────────────
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
  chrome.action.setBadgeText({ text: hasUpdate ? "!" : "" });
  if (hasUpdate) chrome.action.setBadgeBackgroundColor({ color: "#f97316" });
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
  } catch {
    // Network error — silently ignore
  }
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
    } else if (now > lastActive) {
      chrome.storage.local.set({ lastActiveTime: now }, () => {
        if (callback) callback(false);
      });
    } else if (callback) {
      callback(false);
    }
  });
}

// Security Feature #19: WebRTC & DNS Privacy Lock (opt-in from settings)
function applyWebRTCSecurity() {
  if (
    chrome.privacy &&
    chrome.privacy.network &&
    chrome.privacy.network.webRTCIPHandlingPolicy
  ) {
    chrome.privacy.network.webRTCIPHandlingPolicy.set(
      { value: "disable_non_proxied_udp" },
      () => {
        if (chrome.runtime.lastError) {
          console.warn(
            "Unable to set WebRTC IP Handling Policy:",
            chrome.runtime.lastError.message,
          );
        }
      },
    );
  }
}

// The parent password hash must never live in chrome.storage.sync: sync means
// it is uploaded to Google's servers and mirrored to every signed-in device.
function purgePasswordFromSync() {
  chrome.storage.sync.remove("password", () => {
    void chrome.runtime.lastError;
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.runtime.setUninstallURL(
    "https://moaaz-i.github.io/family-website-monitor/uninstall.html",
  );
  applyWebRTCSecurity();
  purgePasswordFromSync();
});

chrome.runtime.onStartup.addListener(() => {
  applyWebRTCSecurity();
  checkTimeTampering();
  purgePasswordFromSync();
});

fetchAndCheckUpdates();
chrome.alarms.create("checkForUpdates", { periodInMinutes: UPDATE_CHECK_PERIOD_MIN });
chrome.alarms.create("trackTime", { periodInMinutes: 1 });

async function closeExtensionsTabsIfExpired() {
  const store = await storageGet(["extensionsAccessExpiry"]);
  const allowedUntil = store.extensionsAccessExpiry || 0;
  if (Date.now() < allowedUntil) return;
  const tabs = await queryTabs({});
  for (const tab of tabs) {
    const currentUrl = tab.url || tab.pendingUrl || "";
    if (isExtensionsUrl(resolveRedirectUrl(currentUrl))) {
      await updateTab(tab.id, { url: chrome.runtime.getURL("blocked-extensions.html") });
    }
  }
}

async function expireTemporaries() {
  const data = await storageGet(["tempAllowed", "dailyLimit", "screenTime"]);
  const tempAllowed = data.tempAllowed || {};
  const now = Date.now();
  let changed = false;

  for (const key in tempAllowed) {
    if (now < tempAllowed[key]) continue;
    delete tempAllowed[key];
    changed = true;
    const tabs = await queryTabs({});
    for (const tab of tabs) {
      const currentUrl = tab.url || tab.pendingUrl;
      if (!currentUrl) continue;
      const resolved = resolveRedirectUrl(currentUrl);
      if (isSameSite(resolved, key)) {
        await updateTab(tab.id, {
          url: chrome.runtime.getURL(`blocked.html?target=${encodeURIComponent(resolved)}`),
        });
      }
    }
  }

  if (changed) await storageSet({ tempAllowed });

  const today = new Date().toDateString();

  // A new day starts the whole-day budget at zero — independent of whether
  // per-site limits are even enabled.
  const st = migrateScreenTime(data.screenTime);
  if (st.lastReset !== today) {
    st.usedSeconds = 0;
    st.lastReset = today;
    await storageSet({ screenTime: st });
  }

  const dl = migrateDailyLimit(data.dailyLimit);
  if (!dl.enabled) return;
  let updated = false;
  for (const site in dl.sites) {
    if (dl.sites[site].lastReset !== today) {
      dl.sites[site].usedTodaySeconds = 0;
      dl.sites[site].lastReset = today;
      updated = true;
    }
  }
  if (updated) await storageSet({ dailyLimit: dl });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkForUpdates") {
    fetchAndCheckUpdates();
    return;
  }
  if (alarm.name !== "trackTime") return;

  checkTimeTampering();
  closeExtensionsTabsIfExpired();
  // Guaranteed persistence point for accrued usage, even if the SW restarted.
  // Sequential: expireTemporaries() also writes dailyLimit (day rollover) and
  // must not read a stale copy while a flush is still in flight.
  flushUsage(true).then(expireTemporaries);
});

// ─── Message router ─────────────────────────────────────────────────────────
function isWebPageSender(sender) {
  const url = sender.url || (sender.tab && (sender.tab.url || sender.tab.pendingUrl)) || "";
  return /^https?:\/\//i.test(url);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Security Feature #20: Message Source Verification
  if (sender.id && sender.id !== chrome.runtime.id) {
    console.warn("Rejected message from external sender:", sender.id);
    return false;
  }

  // forceBlockRedirect is the only message that navigates a tab on the
  // caller's behalf, so it must come from a content script running on a real
  // web page. checkLinkStatus is read-only and is also asked by our own
  // extension pages, so it is intentionally allowed for senders.tab-less pages.
  if (message.type === "forceBlockRedirect" && !isWebPageSender(sender)) {
    console.warn("Rejected navigational message from non-web sender:", sender.url);
    return false;
  }

  // A child-facing page may only *ask* for more time; the grant happens here.
  if (message.type === "requestMoreTime") {
    const ownPagePrefix = chrome.runtime.getURL("");
    if (!sender.url || !sender.url.startsWith(ownPagePrefix)) {
      console.warn("Rejected requestMoreTime from foreign sender:", sender.url);
      return false;
    }
    handleRequestMoreTime(message, sender)
      .then(sendResponse)
      .catch((e) => {
        console.error("requestMoreTime failed:", e);
        sendResponse({ ok: false, reason: "error" });
      });
    return true;
  }

  if (message.type === "verifyParentPassword") {
    handleVerifyPassword(message)
      .then(sendResponse)
      .catch((e) => {
        console.error("verifyParentPassword failed:", e);
        sendResponse({ ok: false, reason: "error" });
      });
    return true;
  }

  if (message.type === "verifyParentPin") {
    handleVerifyPin(message)
      .then(sendResponse)
      .catch((e) => {
        console.error("verifyParentPin failed:", e);
        sendResponse({ ok: false, reason: "error" });
      });
    return true;
  }

  if (message.type === "getLockoutStatus") {
    storageGet(["lockoutExpiry", "failedAttemptsCount"]).then((data) =>
      sendResponse({
        lockoutExpiry: data.lockoutExpiry || 0,
        failedAttemptsCount: data.failedAttemptsCount || 0,
      }),
    );
    return true;
  }

  if (message.type === "checkForUpdatesNow") {
    fetchAndCheckUpdates().then(() => {
      storageGet(["updateAvailable", "latestVersion", "currentVersion", "releaseNotes"]).then(
        sendResponse,
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
    const tabUrl = sender.tab ? sender.tab.url : "";
    const resolvedTabUrl = resolveRedirectUrl(tabUrl);
    getPolicy((data) => {
      if (!data.password) {
        sendResponse({
          blocked: true,
          daily: { isTarget: false },
          temp: { isTemp: false },
          screen: { enabled: false },
        });
        return;
      }
      const snapshot = buildTimeSnapshot(data, resolvedTabUrl);
      sendResponse({
        daily: snapshot.daily,
        temp: snapshot.temp,
        screen: snapshot.screen,
      });
    });
    return true;
  }

  if (message.type === "checkLinkStatus") {
    getPolicy((data) => {
      const url = resolveRedirectUrl(message.url);
      if (!data.password) {
        sendResponse({ status: "blocked", reason: "setup" });
        return;
      }
      sendResponse(determineUrlStatus(url, data));
    });
    return true;
  }

  if (message.type === "forceBlockRedirect") {
    if (!allowRedirectBurst()) {
      console.warn("Redirect burst rate-limited");
      return false;
    }

    const resolvedUrl = resolveRedirectUrl(message.url);

    // Security Feature #12: Safe Redirect Targets Validation
    if (!isValidRedirectTarget(resolvedUrl)) {
      console.warn("Unsafe redirect target blocked:", resolvedUrl);
      return false;
    }

    const reason = /^[a-z]+$/.test(String(message.reason || "")) ? message.reason : "default";
    const encoded = encodeURIComponent(resolvedUrl);
    const redirectUrl = chrome.runtime.getURL(`blocked.html?target=${encoded}&reason=${reason}`);
    if (message.openInNewTab && sender.tab) {
      chrome.tabs.create({ url: redirectUrl });
    } else if (sender.tab) {
      chrome.tabs.update(sender.tab.id, { url: redirectUrl });
    }
    return false;
  }

  if (message.type === "heartbeat") {
    if (!sender.tab || !sender.tab.id) return false;
    const tabId = sender.tab.id;
    const resolvedTabUrl = resolveRedirectUrl(sender.tab.url || "");
    const host = hostOf(resolvedTabUrl);
    const focused = message.focused !== false;
    const now = Date.now();

    // Seconds elapsed since this tab's previous beat. Missed beats (service
    // worker restart, throttled background tab) simply accrue less time rather
    // than inflating or losing the count.
    const previous = lastBeatAt.get(tabId) || 0;
    lastBeatAt.set(tabId, now);
    const delta = previous
      ? Math.min(Math.max(Math.floor((now - previous) / 1000), 0), 15)
      : 1;

    getPolicy(async (data) => {
      try {
        if (!sender.tab || !sender.tab.active || !data.password) {
          lastBeatAt.delete(tabId);
          sendResponse({ isTarget: false, remainingSeconds: 0, tempSeconds: 0 });
          return;
        }

        if (!focused) {
          // The child is looking elsewhere: reset the clock, accrue nothing.
          lastBeatAt.delete(tabId);
        } else {
          if (delta > 0) queueActivity(host, { seconds: delta });
          // The whole-day budget is spent by simply *looking* at a page,
          // regardless of whether that page carries its own limit.
          const st = migrateScreenTime(data.screenTime);
          if (st.enabled && delta > 0) accrueScreenSeconds(delta);
        }

        const dl = migrateDailyLimit(data.dailyLimit);
        const siteKey = findLimitSite(dl, resolvedTabUrl);

        // Temporary allowance expiry
        const tempRemaining = resolveTempRemaining(data, resolvedTabUrl);
        if (tempRemaining < 0) {
          const tempAllowed = { ...(data.tempAllowed || {}) };
          for (const key in tempAllowed) {
            if (isSameSite(resolvedTabUrl, key) && tempAllowed[key] <= Date.now()) {
              delete tempAllowed[key];
            }
          }
          await storageSet({ tempAllowed });
          await flushUsage(true);
          await updateTab(tabId, {
            url: chrome.runtime.getURL(
              `blocked.html?target=${encodeURIComponent(resolvedTabUrl)}`,
            ),
          });
          sendResponse({ isTarget: false, remainingSeconds: 0, tempSeconds: 0 });
          return;
        }

        let remainingSeconds = 0;
        if (siteKey) {
          const siteData = dl.sites[siteKey];
          // Usage only accrues while the child is actually looking at the tab.
          if (focused) accrueSeconds(siteKey, delta);
          remainingSeconds = Math.max(
            0,
            siteData.minutes * 60 - consumedSeconds(siteData, siteKey),
          );

          if (remainingSeconds <= 0) {
            await flushUsage(true);
            await updateTab(tabId, {
              url: chrome.runtime.getURL(
                `blocked.html?target=${encodeURIComponent(resolvedTabUrl)}&reason=limit`,
              ),
            });
            sendResponse({ isTarget: true, remainingSeconds: 0, tempSeconds: 0 });
            return;
          }

          if (focused) await maybeNotify(siteKey, remainingSeconds, data);
        }

        // Whole-day screen-time budget. determineUrlStatus orders the rules,
        // so whitelist entries and an active temporary allowance have already
        // been allowed by the time "budget" can be the reason.
        if (isScreenTimeExhausted(data.screenTime)) {
          const status = determineUrlStatus(resolvedTabUrl, data);
          if (status.reason === "budget") {
            await flushUsage(true);
            await updateTab(tabId, {
              url: chrome.runtime.getURL(
                `blocked.html?target=${encodeURIComponent(resolvedTabUrl)}&reason=budget`,
              ),
            });
            sendResponse({
              isTarget: Boolean(siteKey),
              remainingSeconds: 0,
              tempSeconds: tempRemaining > 0 ? tempRemaining : 0,
              focused,
            });
            return;
          }
        }

        // Rate-limited internally to USAGE_FLUSH_MS, so this is a no-op for
        // all but one beat in fifteen.
        await flushUsage(false);

        sendResponse({
          isTarget: Boolean(siteKey),
          remainingSeconds,
          tempSeconds: tempRemaining > 0 ? tempRemaining : 0,
          focused,
        });
      } catch (e) {
        console.error("heartbeat failed:", e);
        sendResponse({ isTarget: false, remainingSeconds: 0, tempSeconds: 0 });
      }
    });
    return true;
  }
});
