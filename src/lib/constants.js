export const WHITELIST_MAX = 1000;
export const WRONG_ATTEMPT_LOG_MAX = 100;
export const SESSION_DURATION_MS = 15 * 60 * 1000;
export const BRUTE_FORCE_THRESHOLD = 5;
export const BRUTE_FORCE_LOCKOUT_MS = 60 * 1000;
export const EXTENSIONS_ACCESS_DURATION_MS = 20 * 60 * 1000;
export const TIME_TAMPER_THRESHOLD_MS = 120000;
// Domain-separation salt for the backup file checksum (lib/backup.js). The
// value must stay stable: changing it invalidates every exported backup.
export const BACKUP_SALT = "family-website-monitor-secure-salt-2026";
export const UPDATE_CHECK_PERIOD_MIN = 360;
export const VERSION_URL =
  "https://raw.githubusercontent.com/Moaaz-i/family-website-monitor/main/version.json";

// ─── Performance tuning ─────────────────────────────────────────────────────
// How long a freshly-read policy snapshot may be reused before re-reading
// storage. Storage writes invalidate it immediately via storage.onChanged.
export const POLICY_CACHE_TTL_MS = 2000;
// Usage seconds are accumulated in memory and persisted at most this often,
// instead of one storage write per heartbeat (which used to be 1 write/second
// per open tab).
export const USAGE_FLUSH_MS = 15000;
// Minimum gap between two evaluations of a single URL by the content script.
export const LINK_CHECK_DEBOUNCE_MS = 750;
// Brute-force style protection for forceBlockRedirect: a rogue page must not
// be able to spawn thousands of redirect messages.
export const REDIRECT_RATE_WINDOW_MS = 10000;
export const REDIRECT_RATE_MAX = 30;

// ─── Advance-warning notifications ──────────────────────────────────────────
export const NOTIFY_MESSAGES = {
  en: {
    title: "Time is almost up",
    fiveMinutes: (host, minutes) =>
      `${host}: ${minutes} minute${minutes === 1 ? "" : "s"} left today.`,
    oneMinute: (host) => `${host}: less than a minute left today.`,
    moreTimeTitle: "Your child is asking for more time",
    moreTimeBody: (host, minutes) => `Allow ${host} for ${minutes} more minutes?`,
    moreTimeGive: (minutes) => `Allow ${minutes} min`,
    moreTimeDeny: "Not now",
    moreTimeApplied: (host, minutes) => `${host} is allowed for ${minutes} minutes.`,
    digestTitle: "Today\u2019s summary",
    digestBody: (seconds, topHost, blocked) => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const time = h > 0 ? `${h}h ${m}m` : `${m}m`;
      const parts = [`Screen time: ${time}.`];
      if (topHost) parts.push(`Top site: ${topHost}.`);
      if (blocked > 0) parts.push(`${blocked} blocked attempt${blocked === 1 ? "" : "s"}.`);
      return parts.join(" ");
    },
  },
  ar: {
    title: "الوقت على وشك الانتهاء",
    fiveMinutes: (host, minutes) =>
      `بقي لـ${host} ${minutes} ${minutes === 1 ? "دقيقة" : "دقائق"} اليوم.`,
    oneMinute: (host) => `بقي لـ${host} أقل من دقيقة اليوم.`,
    moreTimeTitle: "طفلك يطلب وقتاً إضافياً",
    moreTimeBody: (host, minutes) => `السماح بـ${host} لمدة ${minutes} دقيقة إضافية؟`,
    moreTimeGive: (minutes) => `السماح ${minutes} د`,
    moreTimeDeny: "ليس الآن",
    moreTimeApplied: (host, minutes) => `تم السماح بـ${host} لمدة ${minutes} دقيقة.`,
    digestTitle: "ملخّص اليوم",
    digestBody: (seconds, topHost, blocked) => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const time = h > 0 ? `${h} س ${m} د` : `${m} د`;
      const parts = [`وقت الشاشة: ${time}.`];
      if (topHost) parts.push(`الأعلى استخداماً: ${topHost}.`);
      if (blocked > 0) parts.push(`${blocked} محاولة محجوبة.`);
      return parts.join(" ");
    },
  },
};

// ─── "Ask a parent for more time" ───────────────────────────────────────────
// How long a child gets when the parent taps "Allow", how often a child may
// ask again, and how long a pending request stays valid.
export const MORE_TIME_MINUTES = 15;
export const MORE_TIME_COOLDOWN_MS = 45 * 1000;
export const MORE_TIME_REQUEST_TTL_MS = 5 * 60 * 1000;
