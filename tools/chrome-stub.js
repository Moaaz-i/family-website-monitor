/*
 * Preview-only `chrome.*` implementation.
 *
 * Served by `npm run preview` (see tools/preview.mjs) so the real extension
 * pages can be opened in a normal browser tab. Nothing here ships: it lives
 * in tools/, not in the build manifest.
 *
 * Design notes
 *  - storage.local / storage.sync persist to localStorage, so the popup,
 *    options and blocked pages share one state across tabs.
 *  - runtime.sendMessage dispatches to the *real* background worker, which
 *    preview.mjs imports into every page. The production code paths are the
 *    ones being previewed — the stub only supplies the platform.
 *  - notifications are drawn on screen with their action buttons, so flows
 *    like "ask a parent for more time" can be exercised end to end.
 */
(function () {
  "use strict";

  // Never shadow the real API when this file is somehow opened as an extension.
  if (window.chrome && window.chrome.storage && window.chrome.runtime && window.chrome.runtime.id) {
    return;
  }

  const ORIGIN = location.origin;
  const KEY_PREFIX = "fwm-preview-";
  const AREAS = ["local", "sync"];

  const storageData = { local: {}, sync: {} };
  const changedListeners = [];
  const messageListeners = [];
  const alarmListeners = [];
  const buttonListeners = [];
  const closedListeners = [];
  const tabUpdatedListeners = [];

  // ── persistence ──────────────────────────────────────────────────────────
  function readAreaFromDisk(name) {
    try {
      const raw = localStorage.getItem(KEY_PREFIX + name);
      if (raw) return JSON.parse(raw);
    } catch {
      /* corrupted preview state: start fresh */
    }
    return {};
  }

  function writeAreaToDisk(name) {
    try {
      localStorage.setItem(KEY_PREFIX + name, JSON.stringify(storageData[name]));
    } catch {
      /* quota — preview only */
    }
  }

  AREAS.forEach((name) => {
    storageData[name] = readAreaFromDisk(name);
  });

  function jsonOf(value) {
    try {
      return JSON.stringify(value === undefined ? "__undefined__" : value);
    } catch {
      return String(value);
    }
  }

  function emitChanged(area, changes) {
    if (!Object.keys(changes).length) return;
    setTimeout(() => {
      changedListeners.forEach((fn) => {
        try {
          fn(changes, area);
        } catch (e) {
          console.error("[preview] storage.onChanged listener threw:", e);
        }
      });
    }, 0);
  }

  // Another tab wrote: diff and notify this one, like Chrome does.
  window.addEventListener("storage", (event) => {
    if (!event.key || !event.key.startsWith(KEY_PREFIX)) return;
    const area = event.key.slice(KEY_PREFIX.length);
    if (AREAS.indexOf(area) === -1) return;
    const incoming = event.newValue ? safeParse(event.newValue) : {};
    const current = storageData[area];
    const changes = {};
    Object.keys(current).forEach((key) => {
      if (!(key in incoming)) changes[key] = { oldValue: current[key] };
    });
    Object.keys(incoming).forEach((key) => {
      if (jsonOf(current[key]) !== jsonOf(incoming[key])) {
        changes[key] = { newValue: incoming[key] };
        if (key in current) changes[key].oldValue = current[key];
      }
    });
    storageData[area] = incoming;
    emitChanged(area, changes);
  });

  function safeParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  // ── seeding ─────────────────────────────────────────────────────────────
  // A fresh preview starts with a plausible family setup so every screen has
  // something to show. It never overwrites state the visitor has edited.
  const SEED_READY = seedIfEmpty();

  async function seedIfEmpty() {
    // ?noseed lets you preview the true first-run flow (password setup +
    // wizard) without the demo data getting in the way.
    if (new URLSearchParams(location.search).has("noseed")) return;
    if (Object.keys(storageData.local).length > 0) return;

    const iterations = 5000; // preview speed; production uses the full count
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const password = "parent123";
    const hash = await pbkdf2(password, salt, iterations);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

    storageData.local = {
      password: `pbkdf2$${iterations}$${hash}$${salt}`,
      language: "en",
      whitelist: [
        { id: "p1", fullUrl: "https://www.khanacademy.org", mode: "domain", addedAt: 1 },
        { id: "p2", fullUrl: "https://kids.bbc.co.uk", mode: "domain", addedAt: 2 },
        { id: "p3", fullUrl: "https://en.wikipedia.org", mode: "exact", addedAt: 3 },
      ],
      blockedKeywords: ["youtube.com", "tiktok.com", "roblox.com", "discord", "x.com"],
      blockedSafeSites: [],
      schedule: {
        enabled: false,
        days: [true, true, true, true, true, false, false],
        startTime: "07:00",
        endTime: "20:00",
      },
      dailyLimit: {
        enabled: true,
        sites: {
          "youtube.com": {
            minutes: 45,
            usedTodaySeconds: 1500,
            lastReset: today.toDateString(),
          },
        },
      },
      screenTime: {
        enabled: true,
        minutes: 120,
        usedSeconds: 2700,
        lastReset: today.toDateString(),
      },
      notificationsEnabled: true,
      activity: {
        [dayKey(today)]: {
          "youtube.com": { seconds: 1500, visits: 12, blocked: 4 },
          "khanacademy.org": { seconds: 2400, visits: 5, blocked: 0 },
          "tiktok.com": { seconds: 300, visits: 3, blocked: 9 },
          "roblox.com": { seconds: 900, visits: 7, blocked: 2 },
        },
        [dayKey(yesterday)]: {
          "youtube.com": { seconds: 2100, visits: 15, blocked: 6 },
          "khanacademy.org": { seconds: 1800, visits: 4, blocked: 0 },
        },
      },
    };
    writeAreaToDisk("local");
  }

  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function pbkdf2(password, saltHex, iterations) {
    const enc = new TextEncoder();
    const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: hexToBytes(saltHex), iterations, hash: "SHA-256" },
      material,
      256,
    );
    return bytesToHex(new Uint8Array(bits));
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  // ── storage ─────────────────────────────────────────────────────────────
  function normalizeGet(area, keys) {
    const out = {};
    if (keys === null || keys === undefined) {
      Object.keys(area).forEach((key) => (out[key] = area[key]));
      return out;
    }
    if (typeof keys === "string") {
      if (keys in area) out[keys] = area[keys];
      return out;
    }
    if (Array.isArray(keys)) {
      keys.forEach((key) => {
        if (key in area) out[key] = area[key];
      });
      return out;
    }
    Object.keys(keys).forEach((key) => {
      out[key] = key in area ? area[key] : keys[key];
    });
    return out;
  }

  function makeArea(name) {
    // Always read through storageData[name]: seeding replaces/repaints the
    // backing object, and a captured reference would silently go stale.
    const disk = () => writeAreaToDisk(name);

    return {
      get(keys, callback) {
        SEED_READY.then(() => {
          const result = normalizeGet(storageData[name], keys);
          if (callback) callback(result);
        });
      },
      set(items, callback) {
        SEED_READY.then(() => {
          const area = storageData[name];
          const changes = {};
          Object.keys(items || {}).forEach((key) => {
            if (jsonOf(area[key]) === jsonOf(items[key])) return;
            changes[key] = { newValue: items[key] };
            if (key in area) changes[key].oldValue = area[key];
            area[key] = items[key];
          });
          disk();
          emitChanged(name, changes);
          if (callback) callback();
        });
      },
      remove(keys, callback) {
        SEED_READY.then(() => {
          const area = storageData[name];
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          list.forEach((key) => {
            if (!(key in area)) return;
            changes[key] = { oldValue: area[key] };
            delete area[key];
          });
          disk();
          emitChanged(name, changes);
          if (callback) callback();
        });
      },
      clear(callback) {
        SEED_READY.then(() => {
          const area = storageData[name];
          const changes = {};
          Object.keys(area).forEach((key) => (changes[key] = { oldValue: area[key] }));
          Object.keys(area).forEach((key) => delete area[key]);
          disk();
          emitChanged(name, changes);
          if (callback) callback();
        });
      },
    };
  }

  // ── notifications drawn on screen ───────────────────────────────────────
  const notificationEls = new Map();

  function injectStyles() {
    if (document.getElementById("preview-chrome-stub-styles")) return;
    const style = document.createElement("style");
    style.id = "preview-chrome-stub-styles";
    style.textContent = [
      ".preview-note{position:fixed;z-index:2147483647;top:16px;inset-inline-end:16px;",
      "width:min(340px,calc(100vw - 32px));background:#0f172a;color:#f8fafc;border-radius:14px;",
      "padding:14px 16px;box-shadow:0 18px 40px rgba(0,0,0,.35);font:500 13.5px/1.45 system-ui,sans-serif;",
      "border:1px solid rgba(148,163,184,.25);opacity:0;transform:translateY(-8px);",
      "transition:opacity .18s ease,transform .18s ease}",
      ".preview-note.show{opacity:1;transform:none}",
      ".preview-note-title{font-weight:700;margin-bottom:4px}",
      ".preview-note-msg{color:#cbd5e1;font-size:13px}",
      ".preview-note-actions{display:flex;gap:8px;margin-top:12px}",
      ".preview-note-actions button{flex:1;border:0;border-radius:9px;padding:8px 10px;",
      "font:600 12.5px/1 system-ui,sans-serif;cursor:pointer;background:#334155;color:#e2e8f0}",
      ".preview-note-actions button.primary{background:#6366f1;color:#fff}",
      ".preview-badge{position:fixed;z-index:2147483647;bottom:14px;inset-inline-start:14px;",
      "background:#6366f1;color:#fff;font:600 11px/1 system-ui,sans-serif;padding:6px 10px;",
      "border-radius:999px;opacity:.9;pointer-events:none;letter-spacing:.04em}",
    ].join("");
    document.head.appendChild(style);
  }

  function showBadge(text) {
    injectStyles();
    let badge = document.getElementById("preview-chrome-stub-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "preview-chrome-stub-badge";
      badge.className = "preview-badge";
      badge.textContent = text;
      (document.body || document.documentElement).appendChild(badge);
    } else {
      badge.textContent = text;
    }
  }

  function createNotification(id, options, callback) {
    injectStyles();
    removeNotification(id);

    const note = document.createElement("div");
    note.className = "preview-note";
    note.dataset.notificationId = id;

    const title = document.createElement("div");
    title.className = "preview-note-title";
    title.textContent = options && options.title ? options.title : "";
    note.appendChild(title);

    const message = document.createElement("div");
    message.className = "preview-note-msg";
    message.textContent = options && options.message ? options.message : "";
    note.appendChild(message);

    const actions = Array.isArray((options && options.buttons) || [])
      ? options.buttons
      : [];
    if (actions.length) {
      const row = document.createElement("div");
      row.className = "preview-note-actions";
      actions.forEach((button, index) => {
        const el = document.createElement("button");
        el.type = "button";
        el.textContent = button.title || "";
        if (index === 0) el.className = "primary";
        el.addEventListener("click", () => {
          removeNotification(id);
          buttonListeners.forEach((fn) => {
            try {
              fn(id, index);
            } catch (e) {
              console.error("[preview] onButtonClicked threw:", e);
            }
          });
        });
        row.appendChild(el);
      });
      note.appendChild(row);
    }

    document.body.appendChild(note);
    requestAnimationFrame(() => note.classList.add("show"));

    const timer = setTimeout(() => {
      if (!notificationEls.has(id)) return;
      removeNotification(id);
      closedListeners.forEach((fn) => {
        try {
          fn(id, "expired");
        } catch {
          /* ignore */
        }
      });
    }, 20000);

    notificationEls.set(id, { el: note, timer });
    if (callback) callback();
  }

  function removeNotification(id) {
    const entry = notificationEls.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.el.classList.remove("show");
    entry.el.remove();
    notificationEls.delete(id);
  }

  // ── tabs (the preview has exactly one) ──────────────────────────────────
  function currentTab() {
    return {
      id: 1,
      windowId: 1,
      active: true,
      url: location.href,
      title: document.title,
    };
  }

  function fakeTabs() {
    return [currentTab()];
  }

  // ── the chrome object ───────────────────────────────────────────────────
  const chrome = {
    runtime: {
      id: "family-website-monitor-preview",
      lastError: undefined,
      getURL(path) {
        return ORIGIN + "/" + String(path || "").replace(/^\//, "");
      },
      getManifest() {
        return { manifest_version: 3, name: "Family Website Monitor", version: "3.0.0" };
      },
      openOptionsPage() {
        location.href = "/options.html";
      },
      setUninstallURL() {},
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        },
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage(message, callback) {
        SEED_READY.then(() => {
          let responded = false;
          let wantsResponse = false;
          const sendResponse = (value) => {
            if (responded) return;
            responded = true;
            if (callback) callback(value);
          };
          const sender = {
            id: chrome.runtime.id,
            url: location.href,
            tab: currentTab(),
          };
          messageListeners.forEach((fn) => {
            let result;
            try {
              result = fn(message, sender, sendResponse);
            } catch (e) {
              console.error("[preview] onMessage listener threw:", e);
            }
            if (result === true) wantsResponse = true;
          });
          // Listeners that answered synchronously already called sendResponse.
          if (!wantsResponse && !responded) sendResponse(undefined);
        });
      },
    },

    storage: {
      local: makeArea("local"),
      sync: makeArea("sync"),
      onChanged: {
        addListener(fn) {
          changedListeners.push(fn);
        },
      },
    },

    tabs: {
      query(queryInfo, callback) {
        const tabs = fakeTabs().filter((tab) => {
          if (!queryInfo) return true;
          if (queryInfo.active !== undefined && queryInfo.active !== tab.active) return false;
          if (queryInfo.currentWindow !== undefined && queryInfo.currentWindow && tab.windowId !== 1)
            return false;
          return true;
        });
        if (callback) callback(tabs);
        return Promise.resolve(tabs);
      },
      get(tabId, callback) {
        const tab = tabId === 1 ? currentTab() : null;
        if (callback) callback(tab);
        return Promise.resolve(tab);
      },
      update(tabId, props, callback) {
        const tab = Object.assign(currentTab(), props || {});
        if (callback) callback(tab);
        if (props && props.url && props.url !== location.href) {
          location.href = props.url;
        }
        tabUpdatedListeners.forEach((fn) => {
          try {
            fn(tabId, { status: "complete" }, tab);
          } catch {
            /* ignore */
          }
        });
        return Promise.resolve(tab);
      },
      create(props, callback) {
        if (props && props.url) location.href = props.url;
        const tab = currentTab();
        if (callback) callback(tab);
        return Promise.resolve(tab);
      },
      onUpdated: {
        addListener(fn) {
          tabUpdatedListeners.push(fn);
        },
      },
      onRemoved: { addListener() {} },
    },

    webNavigation: {
      onBeforeNavigate: { addListener() {} },
      onHistoryStateUpdated: { addListener() {} },
      onCommitted: { addListener() {} },
    },

    alarms: {
      onAlarm: {
        addListener(fn) {
          alarmListeners.push(fn);
        },
      },
      create(name) {
        lastAlarmNames.add(name);
      },
      clear(name, callback) {
        lastAlarmNames.delete(name);
        if (callback) callback(true);
      },
      getAll(callback) {
        const alarms = Array.from(lastAlarmNames).map((name) => ({ name }));
        if (callback) callback(alarms);
        return Promise.resolve(alarms);
      },
    },

    notifications: {
      create(id, options, callback) {
        SEED_READY.then(() => createNotification(id, options, callback));
        return id;
      },
      clear(id, callback) {
        removeNotification(id);
        if (callback) callback(true);
      },
      onButtonClicked: {
        addListener(fn) {
          buttonListeners.push(fn);
        },
      },
      onClosed: {
        addListener(fn) {
          closedListeners.push(fn);
        },
      },
      onShown: { addListener() {} },
    },

    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setIcon() {},
      setTitle() {},
      disable() {},
    },

    commands: {
      getAll(callback) {
        if (callback) callback([]);
      },
    },

    extension: {
      isAllowedIncognitoAccess(callback) {
        if (callback) callback(false);
      },
    },

    privacy: {
      network: {
        webRTCIPHandlingPolicy: { set() {} },
      },
    },
  };

  const lastAlarmNames = new Set();

  window.chrome = chrome;

  // Platform events the worker expects.
  setTimeout(() => {
    // The real worker sets this at install; preview skips it deliberately.
    showBadge("preview · local server");
  }, 0);

  // Emulate the periodic "trackTime" alarm so write-behind flushes, day
  // rollovers and temporary-allowance expiry can be observed live.
  setInterval(() => {
    alarmListeners.forEach((fn) => {
      try {
        fn({ name: "trackTime", scheduledTime: Date.now() });
      } catch (e) {
        console.error("[preview] alarm listener threw:", e);
      }
    });
  }, 8000);
})();
