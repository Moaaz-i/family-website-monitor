import {
  resolveRedirectUrl,
  isSameSite,
  isEntryAllowed,
  getHostname,
} from "./url.js";

export const BLOCKLIST_MIN_KEYWORD = 3;

/**
 * Parent-managed blocklist. A domain entry ("youtube.com") blocks the domain
 * and every subdomain; a longer token is also matched anywhere in the URL so
 * a path keyword works too.
 *
 * The blocklist deliberately outranks the whitelist: if a parent blocks
 * something, no "always allow" entry may resurrect it.
 */
export function matchesBlocklist(urlString, list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  if (!urlString) return false;

  const resolved = resolveRedirectUrl(urlString);
  const lower = String(resolved || "").toLowerCase();
  const host = (getHostname(resolved) || "").toLowerCase().replace(/^www\./, "");

  for (const raw of list) {
    const token = String(raw || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "")
      .replace(/[^a-z0-9\u0600-\u06ff.\- ]/g, "")
      .trim();
    if (!token) continue;

    // Domain-shaped entries ("youtube.com") match the host only, by exact
    // name or subdomain. Substring matching would make a short domain like
    // "x.com" swallow every host ending in "x.com" (fox.com, max.com …).
    if (host === token || host.endsWith("." + token)) return true;
    // A bare token also claims the host label it names: "ab" matches ab.com
    // (but never notab.com), even when it is too short for keyword matching.
    if (host.split(".").includes(token)) return true;
    if (token.includes(".")) continue;

    // Bare keywords ("minecraft") also match anywhere in the URL, so a path
    // or a query parameter cannot smuggle the blocked topic past us.
    if (token.length >= BLOCKLIST_MIN_KEYWORD && lower.includes(token)) return true;
  }
  return false;
}

// ─── Whole-day screen-time budget ──────────────────────────────────────────
// One allowance for the entire day, no matter how it is split across sites.
// Whitelisted sites stay open after the budget is spent — they are the
// parent's explicit exception list.
export function migrateScreenTime(st) {
  if (!st || typeof st !== "object" || Array.isArray(st)) {
    return { enabled: false, minutes: 0, usedSeconds: 0, lastReset: "" };
  }
  return {
    enabled: Boolean(st.enabled),
    minutes: Math.max(0, Number(st.minutes) || 0),
    usedSeconds: Math.max(0, Number(st.usedSeconds) || 0),
    lastReset: typeof st.lastReset === "string" ? st.lastReset : "",
  };
}

/** Seconds of today's budget already spent (a new day starts at zero). */
export function screenTimeUsedSeconds(st) {
  const migrated = migrateScreenTime(st);
  return migrated.lastReset === new Date().toDateString() ? migrated.usedSeconds : 0;
}

export function screenTimeRemainingSeconds(st) {
  const migrated = migrateScreenTime(st);
  return Math.max(0, migrated.minutes * 60 - screenTimeUsedSeconds(migrated));
}

export function isScreenTimeExhausted(st) {
  const migrated = migrateScreenTime(st);
  return migrated.enabled && migrated.minutes > 0 && screenTimeUsedSeconds(migrated) >= migrated.minutes * 60;
}

export function migrateDailyLimit(dl) {
  if (!dl) return { enabled: false, sites: {} };
  if (dl.sites && typeof dl.sites === "object" && !Array.isArray(dl.sites)) {
    return dl;
  }
  const newDl = {
    enabled: dl.enabled || false,
    sites: {}
  };
  if (dl.targetSites && Array.isArray(dl.targetSites)) {
    const today = new Date().toDateString();
    const used = dl.lastReset === today ? dl.usedTodaySeconds || 0 : 0;
    dl.targetSites.forEach((site) => {
      newDl.sites[site] = {
        minutes: dl.minutes || 0,
        usedTodaySeconds: used,
        lastReset: dl.lastReset || today
      };
    });
  }
  return newDl;
}

export function isDailyLimitExceeded(dl, urlString) {
  if (!dl || !dl.enabled) return false;
  const migrated = migrateDailyLimit(dl);
  const resolved = resolveRedirectUrl(urlString);

  for (const site in migrated.sites) {
    if (isSameSite(resolved, site)) {
      const siteData = migrated.sites[site];
      const today = new Date().toDateString();
      const usedTodaySeconds = siteData.lastReset === today ? siteData.usedTodaySeconds || 0 : 0;
      return usedTodaySeconds >= siteData.minutes * 60;
    }
  }
  return false;
}

export function isWithinSchedule(schedule) {
  if (!schedule || !schedule.enabled) return true;

  const now = new Date();
  const day = now.getDay();

  if (!schedule.days || !Array.isArray(schedule.days) || schedule.days[day] === undefined) {
    return true;
  }

  const dayVal = schedule.days[day];
  if (dayVal !== true && dayVal !== "true") return false;

  if (
    typeof schedule.startTime !== "string" ||
    typeof schedule.endTime !== "string" ||
    !schedule.startTime ||
    !schedule.endTime
  ) {
    return true;
  }

  try {
    const current = now.getHours() * 60 + now.getMinutes();
    const partsStart = schedule.startTime.split(":");
    const partsEnd = schedule.endTime.split(":");

    if (partsStart.length < 2 || partsEnd.length < 2) {
      return true;
    }

    const sh = parseInt(partsStart[0], 10);
    const sm = parseInt(partsStart[1], 10);
    const eh = parseInt(partsEnd[0], 10);
    const em = parseInt(partsEnd[1], 10);

    if (isNaN(sh) || isNaN(sm) || isNaN(eh) || isNaN(em)) {
      return true;
    }

    const start = sh * 60 + sm;
    const end = eh * 60 + em;

    if (start <= end) {
      return current >= start && current <= end;
    } else {
      return current >= start || current <= end;
    }
  } catch (e) {
    console.error("isWithinSchedule parsing crash prevented:", e);
    return true;
  }
}

export function determineUrlStatus(resolvedUrl, data) {
  if (data.timeTampered) {
    return { status: "blocked", reason: "tampered" };
  }

  if (data.emergencyLock) {
    return { status: "blocked", reason: "emergency" };
  }

  // Blocklist outranks everything a child (or a stale setting) could allow:
  // no whitelist entry and no temporary allowance may resurrect a blocked
  // site. The parent removes the entry to unblock it.
  if (matchesBlocklist(resolvedUrl, data.blockedKeywords)) {
    return { status: "blocked", reason: "blocklist" };
  }

  const tempAllowed = data.tempAllowed || {};
  for (const key in tempAllowed) {
    // Site-level: one approval covers every URL of that host for its window.
    if (isSameSite(resolvedUrl, key)) {
      if (Date.now() < tempAllowed[key]) {
        return { status: "allowed" };
      }
    }
  }

  if (isUrlAllowed(resolvedUrl, data)) {
    return { status: "allowed" };
  }

  // Whole-day screen-time budget. Checked after the whitelist, so the sites
  // the parent explicitly allowed keep working once the budget is spent.
  if (isScreenTimeExhausted(data.screenTime)) {
    return { status: "blocked", reason: "budget" };
  }

  const migratedDl = migrateDailyLimit(data.dailyLimit);
  if (migratedDl && migratedDl.enabled && migratedDl.sites) {
    let hasLimit = false;
    let limitExceeded = false;
    for (const site in migratedDl.sites) {
      // Site-level: "youtube.com" must cover /watch?v=… as well.
      if (isSameSite(resolvedUrl, site)) {
        hasLimit = true;
        const siteData = migratedDl.sites[site];
        const today = new Date().toDateString();
        const usedTodaySeconds = siteData.lastReset === today ? siteData.usedTodaySeconds || 0 : 0;
        if (usedTodaySeconds >= siteData.minutes * 60) {
          limitExceeded = true;
        }
        break;
      }
    }

    if (hasLimit) {
      if (limitExceeded) {
        return { status: "blocked", reason: "limit" };
      }
      return { status: "allowed" };
    }
  }

  if (data.schedule && data.schedule.enabled) {
    if (isWithinSchedule(data.schedule)) {
      return { status: "allowed" };
    }
    return { status: "blocked", reason: "schedule" };
  }

  return { status: "blocked", reason: "default" };
}

export function isUrlAllowed(urlString, data) {
  if (!urlString || !data || !data.whitelist) return false;
  const resolved = resolveRedirectUrl(urlString);
  return data.whitelist.some((e) => isEntryAllowed(resolved, e));
}