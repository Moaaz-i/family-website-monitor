const normalizeNumerals = (str) =>
  str.replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 1584));

export function buildStrictUrl(urlString) {
  if (!urlString) return null;
  try {
    // Stripping control chars before parsing is the point — they must never
    // reach the address bar.
    // eslint-disable-next-line no-control-regex
    let cleanUrl = urlString.trim().replace(/[\x00-\x1F\x7F-\x9F]/g, "");
    cleanUrl = cleanUrl.replace(/\.+$|^\.+/, "");
    const urlObj = new URL(
      cleanUrl.includes("://") ? cleanUrl : `https://${cleanUrl}`,
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
}

export function getHostname(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch {
    if (urlString.startsWith("chrome://")) {
      const match = urlString.match(/^chrome:\/\/([^/]+)/);
      return match ? match[1] : null;
    }
    // Bare hosts ("youtube.com") are the most common form parents type.
    try {
      return new URL(`https://${urlString}`).hostname;
    } catch {
      return null;
    }
  }
}

export function resolveRedirectUrl(urlString) {
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
  } catch {
    // Not a URL at all — hand the raw string back to the caller.
  }
  return urlString;
}

export function isMatchingSite(urlString, targetSite) {
  if (!urlString || !targetSite) return false;
  const parsedUrl = buildStrictUrl(urlString);
  const parsedTarget = buildStrictUrl(targetSite);
  return Boolean(parsedUrl && parsedTarget && parsedUrl === parsedTarget);
}

// Site-level comparison used by temporary allowances and daily limits: the
// parent means "this site", so the host decides — never the path. Matching
// the full path silently disabled both features on every real URL
// (youtube.com/watch never equalled the configured "youtube.com").
// The key may be a bare host or a full URL; subdomains count too.
export function isSameSite(urlString, targetString) {
  if (!urlString || !targetString) return false;
  const host = (getHostname(urlString) || "").toLowerCase().replace(/^www\./, "");
  const target = (getHostname(targetString) || "").toLowerCase().replace(/^www\./, "");
  if (!host || !target) return false;
  return host === target || host.endsWith("." + target);
}

function cleanHostname(urlString) {
  try {
    const url = new URL(
      urlString.includes("://") ? urlString : `https://${urlString}`,
    );
    return url.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.+$/, "");
  } catch {
    return null;
  }
}

// Checks whether a whitelist entry covers a URL.
// mode === "domain" allows the whole domain (all sub-paths and sub-domains),
// otherwise the entry matches only the exact normalized URL.
export function isEntryAllowed(urlString, entry) {
  if (!urlString || !entry || !entry.fullUrl) return false;
  if (entry.mode && entry.mode === "domain") {
    const host = cleanHostname(urlString);
    const targetHost = cleanHostname(entry.fullUrl);
    if (!host || !targetHost) return false;
    return host === targetHost || host.endsWith("." + targetHost);
  }
  return isMatchingSite(urlString, entry.fullUrl);
}

export function normalizeUrl(url) {
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return u.href;
  } catch {
    return null;
  }
}

// Only real destinations are judged: http(s), plus file: (a local file the
// child opens in a tab must still be refused by a whitelist).
//
// A sub-frame's `about:blank` / `about:srcdoc` URL carries no content of its
// own — it is an empty box that the page which owns it fills later, and that
// page was already checked. `blob:` frames inherit the origin of the page
// that created them, and `data:` frames are opaque, so any http(s)
// navigation inside them still reaches the rule handlers.
//
// Treating these as sites is what made every modern page bounce to the
// blocked page the moment it created a lazy embed (the frame reported
// `about:blank` with reason "default").
export function isEnforceableUrl(urlString) {
  const value = String(urlString || "");
  return /^https?:\/\//i.test(value) || /^file:/i.test(value);
}

// The rules follow the *current path* — the URL in the address bar — and
// nothing else.
//
// A page's imports are the page's own business: scripts, images, and
// especially iframes such as
// https://ep2.adtrafficquality.google/sodar/sodar2/255/runner.html that ad,
// login and player widgets load on their own. Judging those files as sites
// stopped them from loading and yanked an allowed page to the blocked page
// for something the child never navigated to.
//
// So: main frame (frameId 0) only, and only a real destination there.
export function shouldEnforceNavigation(urlString, frameId) {
  if (Number(frameId || 0) !== 0) return false;
  return isEnforceableUrl(urlString);
}

export function isValidRedirectTarget(urlString) {
  if (!urlString) return false;
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}