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

function isMatchingSite(urlString, targetSite) {
  if (!urlString || !targetSite) return false;
  const parsedUrl = buildStrictUrl(urlString);
  const parsedTarget = buildStrictUrl(targetSite);
  return Boolean(parsedUrl && parsedTarget && parsedUrl === parsedTarget);
}

document.addEventListener("DOMContentLoaded", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const targetParam = urlParams.get("target");

  const navType = performance.getEntriesByType("navigation")[0]?.type;
  if (navType === "back_forward" && targetParam) {
    chrome.runtime.sendMessage(
      { type: "checkLinkStatus", url: decodeURIComponent(targetParam) },
      (response) => {
        if (response && response.status === "allowed") {
          history.back();
        }
      },
    );
  }

  const actionType = document.getElementById("actionType");
  const durationInput = document.getElementById("duration");
  const reasonMessage = document.getElementById("reasonMessage");

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url.includes("://") ? url : `https://${url}`);
      return u.href;
    } catch {
      return null;
    }
  }

  function getHostname(urlString) {
    try {
      if (urlString.startsWith("http")) return new URL(urlString).hostname;
      const match = urlString.match(/^chrome:\/\/([^\/]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  const reason = urlParams.get("reason");
  const target = urlParams.get("target");

  if (reasonMessage) {
    let messageKey = "blockedReasonDefault";
    if (reason === "schedule") messageKey = "blockedReasonSchedule";
    else if (reason === "limit") messageKey = "blockedReasonLimit";
    else if (reason === "emergency") messageKey = "blockedReasonEmergency";
    reasonMessage.textContent = chrome.i18n.getMessage(messageKey);
  }

  document.getElementById("blockedUrl").textContent = decodeURIComponent(
    target || "Unknown Site",
  );

  actionType.addEventListener("change", () => {
    durationInput.style.display =
      actionType.value === "temp" ? "inline-block" : "none";
  });

  document.getElementById("unlockBtn").addEventListener("click", () => {
    const passwordField = document.getElementById("password");
    const passwordInput = passwordField.value;
    let currentHostname = "Unknown Site";

    if (targetParam) {
      currentHostname =
        getHostname(decodeURIComponent(targetParam)) || "Unknown Site";
    }

    chrome.storage.local.get(["password", "wrongAttempts"], (data) => {
      if (passwordInput === data.password) {
        document.getElementById("optionsSection").style.display = "block";
        passwordField.style.display = "none";
        document.getElementById("unlockBtn").style.display = "none";

        document.getElementById("saveBtn").addEventListener("click", () => {
          const action = actionType.value;
          if (action === "always") {
            chrome.storage.local.get({ whitelist: [] }, (storageData) => {
              const whitelist = storageData.whitelist;
              const decodedUrl = targetParam
                ? decodeURIComponent(targetParam)
                : null;
              if (!decodedUrl) return;

              const cleanUrl = normalizeUrl(decodedUrl);
              if (!cleanUrl) return;

              const siteExists = whitelist.some((entry) =>
                isMatchingSite(entry.fullUrl, cleanUrl),
              );
              if (!siteExists) {
                whitelist.push({
                  id: generateId(),
                  fullUrl: cleanUrl,
                  addedAt: Date.now(),
                });
              }
              chrome.storage.local.set({ whitelist: whitelist }, () => {
                if (decodedUrl) window.location.replace(decodedUrl);
                else
                  showToast(
                    chrome.i18n.getMessage("siteAddedSuccess"),
                    "success",
                  );
              });
            });
          } else if (action === "temp") {
            const minutes = parseInt(durationInput.value, 10);
            if (!minutes || minutes <= 0) {
              showToast(chrome.i18n.getMessage("invalidMinutes"), "error");
              return;
            }
            const expiry = new Date().getTime() + minutes * 60 * 1000;
            chrome.storage.local.get(["tempAllowed"], (storageData) => {
              let tempAllowed = storageData.tempAllowed || {};
              if (targetParam) {
                const decodedUrl = decodeURIComponent(targetParam);
                const cleanUrl = normalizeUrl(decodedUrl);
                if (cleanUrl) tempAllowed[cleanUrl] = expiry;
              }
              chrome.storage.local.set({ tempAllowed }, () => {
                if (targetParam)
                  window.location.replace(decodeURIComponent(targetParam));
                else
                  showToast(
                    chrome.i18n.getMessage("tempAllowSuccess", String(minutes)),
                    "success",
                  );
              });
            });
          }
        });
      } else {
        const attempt = {
          site: currentHostname,
          time: new Date().toLocaleString("en-US"),
        };
        const wrongAttempts = data.wrongAttempts || [];
        wrongAttempts.push(attempt);
        chrome.storage.local.set({ wrongAttempts }, () => {
          showToast(chrome.i18n.getMessage("passwordIncorrect"), "error");
          passwordField.value = "";
          passwordField.focus();
        });
      }
    });
  });
});
