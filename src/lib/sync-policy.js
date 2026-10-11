// Pure decision logic for the cross-device policy mirror.
//
// The worker owns storage, timers and the chunk codec; everything that
// decides *what* to publish or *whether* an incoming copy may be applied
// lives here, so the rules that stop two devices from fighting over the same
// lists are testable without chrome.*.
import { migrateScreenTime } from "./rules.js";

/**
 * The policy document as it should travel: configuration, not counters.
 * Usage counters would churn the sync quota for nothing, and a budget read
 * from another device would silently swallow today's minutes here.
 */
export function normalizeSyncedPayload(data, syncedKeys) {
  const payload = {};
  for (const key of syncedKeys) {
    if (data[key] === undefined || data[key] === null) continue;
    if (key === "screenTime") {
      const st = migrateScreenTime(data.screenTime);
      payload.screenTime = { enabled: st.enabled, minutes: st.minutes };
    } else {
      payload[key] = data[key];
    }
  }
  return payload;
}

/**
 * Decide whether an incoming copy may be written to local storage.
 *
 * Returns the payload to write, or null when the copy must be ignored:
 *  - the exact content we already know (the echo of our own push) — writing
 *    it back is how two devices end up echoing each other forever;
 *  - a copy that is not newer than the revision this device last accepted,
 *    so a device that was offline cannot roll the policy back.
 *
 * The parent's screen-time *configuration* is adopted; this device's usage
 * counters are kept.
 */
export function planApplySync(decoded, knownRev, lastSyncedJson, localScreenTime) {
  if (!decoded || typeof decoded.rev !== "number" || !decoded.payload) return null;
  if (decoded.json === lastSyncedJson) return null;
  if (decoded.rev <= (Number(knownRev) || 0)) return null;

  const payload = { ...decoded.payload };
  if (payload.screenTime) {
    const st = migrateScreenTime(localScreenTime);
    payload.screenTime = {
      ...payload.screenTime,
      usedSeconds: st.usedSeconds,
      lastReset: st.lastReset,
    };
  }
  return payload;
}
