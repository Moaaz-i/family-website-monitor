import {
  buildStrictUrl,
  resolveRedirectUrl,
  isMatchingSite,
  isEntryAllowed,
} from "./url.js";

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
    if (isMatchingSite(resolved, site)) {
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

  const tempAllowed = data.tempAllowed || {};
  for (const key in tempAllowed) {
    if (isMatchingSite(resolvedUrl, key)) {
      if (Date.now() < tempAllowed[key]) {
        return { status: "allowed" };
      }
    }
  }

  if (isUrlAllowed(resolvedUrl, data)) {
    return { status: "allowed" };
  }

  const migratedDl = migrateDailyLimit(data.dailyLimit);
  if (migratedDl && migratedDl.enabled && migratedDl.sites) {
    let hasLimit = false;
    let limitExceeded = false;
    for (const site in migratedDl.sites) {
      if (isMatchingSite(resolvedUrl, site)) {
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