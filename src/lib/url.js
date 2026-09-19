const normalizeNumerals = (str) =>
  str.replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 1584));

export function buildStrictUrl(urlString) {
  if (!urlString) return null;
  try {
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
      const match = urlString.match(/^chrome:\/\/([^\/]+)/);
      return match ? match[1] : null;
    }
    return null;
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
  } catch (e) {}
  return urlString;
}

export function isMatchingSite(urlString, targetSite) {
  if (!urlString || !targetSite) return false;
  const parsedUrl = buildStrictUrl(urlString);
  const parsedTarget = buildStrictUrl(targetSite);
  return Boolean(parsedUrl && parsedTarget && parsedUrl === parsedTarget);
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

export function isValidRedirectTarget(urlString) {
  if (!urlString) return false;
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}