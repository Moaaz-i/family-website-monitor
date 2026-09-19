let currentTranslations = {};
let fallbackTranslations = {};
let translationLoaded = false;
const translationCallbacks = [];

export function t(key, ...args) {
  const transObj = currentTranslations[key] || fallbackTranslations[key];
  if (!transObj) return key;
  let msg = transObj.message || key;

  if (args.length > 0) {
    if (transObj.placeholders) {
      for (const phName in transObj.placeholders) {
        const ph = transObj.placeholders[phName];
        const content = ph.content;
        const index = parseInt(content.replace("$", ""), 10) - 1;
        if (!isNaN(index) && args[index] !== undefined) {
          msg = msg.replaceAll(`$${phName.toUpperCase()}$`, args[index]);
          msg = msg.replaceAll(content, args[index]);
        }
      }
    }
    args.forEach((val, idx) => {
      msg = msg.replaceAll(`$${idx + 1}`, val);
    });
  }
  return msg;
}

export function translateDOM() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const val = t(key);
    if (val && val !== key) {
      el.textContent = val;
    }
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    const val = t(key);
    if (val && val !== key) {
      el.placeholder = val;
    }
  });
}

export async function loadTranslations() {
  return new Promise((resolve) => {
    chrome.storage.local.get("language", async (data) => {
      const lang = data.language || "en";

      try {
        const fallbackUrl = chrome.runtime.getURL("_locales/en/messages.json");
        const fallbackRes = await fetch(fallbackUrl);
        fallbackTranslations = await fallbackRes.json();
      } catch (e) {
        console.error("Failed to load fallback translations:", e);
      }

      if (lang !== "en") {
        try {
          const langUrl = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
          const langRes = await fetch(langUrl);
          currentTranslations = await langRes.json();
        } catch (e) {
          console.error(`Failed to load translations for ${lang}:`, e);
          currentTranslations = fallbackTranslations;
        }
      } else {
        currentTranslations = fallbackTranslations;
      }

      document.documentElement.lang = lang;
      document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";

      translateDOM();

      translationLoaded = true;
      resolve();

      while (translationCallbacks.length > 0) {
        const callback = translationCallbacks.shift();
        try {
          callback();
        } catch (e) {
          console.error("Error in translation callback:", e);
        }
      }
    });
  });
}

export function onTranslationReady(callback) {
  if (translationLoaded) {
    callback();
  } else {
    translationCallbacks.push(callback);
  }
}

export async function initTranslations() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadTranslations, { once: true });
  } else {
    loadTranslations();
  }
}