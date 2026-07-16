function resolveRedirectUrl(urlString) {
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

function moveChatList() {
  const sidebar = document.querySelector(".sidebar-slider-item");
  const sidebarContent = document.querySelector(".sidebar-content");
  const chatListContainer = document.querySelector("#chatlist-container");
  const chatListPart = document.querySelector(".chatlist-parts");
  const chatList = document.querySelector(".chatlist-top");
  const chatListHeader = document.querySelectorAll(
    "[data-testid=chatlist-header]",
  );
  const searchbar = document.querySelector(
    "[data-testid=chat-list-search-container]",
  );
  const tablist = document.querySelector("[role=tablist]");

  if (tablist) tablist.remove();
  if (searchbar) searchbar.remove();
  if (chatListHeader) {
    chatListHeader.forEach((element) => {
      element.remove();
    });
  }

  if (
    chatList &&
    sidebar &&
    sidebarContent &&
    chatListPart &&
    chatListContainer
  ) {
    if (
      chatListPart.firstElementChild === chatList &&
      sidebarContent.firstElementChild === chatListContainer &&
      sidebar.firstElementChild === sidebarContent
    ) {
      return;
    }
    observer.disconnect();
    chatListPart.replaceChildren(chatList);
    sidebarContent.replaceChildren(chatListContainer);
    sidebar.replaceChildren(sidebarContent);
    startObserver();
  }
}

function startObserver() {
  observer.observe(document.body, { childList: true, subtree: true });
}

const observer = new MutationObserver(moveChatList);
moveChatList();
startObserver();

(function () {
  let timerInterval = null;
  let timerElement = null;

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  function createTimerUI(remainingSeconds, label) {
    if (timerElement) return;
    timerElement = document.createElement("div");
    timerElement.id = "family-website-monitor-timer";
    timerElement.style.cssText = `
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      z-index: 2147483647 !important;
      background: rgba(20, 20, 20, 0.85) !important;
      backdrop-filter: blur(8px) !important;
      -webkit-backdrop-filter: blur(8px) !important;
      color: #ffffff !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
      font-size: 14px !important;
      font-weight: 600 !important;
      padding: 10px 18px !important;
      border-radius: 30px !important;
      border: 1px solid rgba(255, 255, 255, 0.15) !important;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4) !important;
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      user-select: none !important;
      transition: opacity 0.2s ease !important;
      direction: ltr !important;
    `;

    timerElement.addEventListener("mouseenter", () => {
      timerElement.style.opacity = "0.2";
    });
    timerElement.addEventListener("mouseleave", () => {
      timerElement.style.opacity = "1";
    });

    const indicator = document.createElement("span");
    indicator.id = "family-website-monitor-timer-indicator";
    indicator.style.cssText = `
      width: 8px !important;
      height: 8px !important;
      border-radius: 50% !important;
      background: #4ade80 !important;
      display: inline-block !important;
      box-shadow: 0 0 8px #4ade80 !important;
    `;

    const text = document.createElement("span");
    text.id = "family-website-monitor-timer-text";
    text.textContent = formatTime(remainingSeconds);

    const typeLabel = document.createElement("small");
    typeLabel.id = "family-website-monitor-timer-label";
    typeLabel.style.cssText = `
      font-size: 10px !important;
      opacity: 0.7 !important;
      margin-left: 2px !important;
    `;
    typeLabel.textContent = `(${label})`;

    timerElement.appendChild(indicator);
    timerElement.appendChild(text);
    timerElement.appendChild(typeLabel);
    document.body.appendChild(timerElement);
  }

  function updateTimer(dlData, tempData) {
    let activeTime = 0;
    let activeLabel = "";
    if (tempData.isTemp && dlData.isTarget) {
      if (tempData.remainingSeconds < dlData.remainingSeconds) {
        activeTime = tempData.remainingSeconds;
        activeLabel = "temp";
      } else {
        activeTime = dlData.remainingSeconds;
        activeLabel = "daily";
      }
    } else if (tempData.isTemp) {
      activeTime = tempData.remainingSeconds;
      activeLabel = "temp";
    } else if (dlData.isTarget) {
      activeTime = dlData.remainingSeconds;
      activeLabel = "daily";
    }

    if (!timerElement) {
      createTimerUI(activeTime, activeLabel);
      return;
    }

    const textElem = document.getElementById(
      "family-website-monitor-timer-text",
    );
    if (textElem) textElem.textContent = formatTime(activeTime);

    const labelElem = document.getElementById(
      "family-website-monitor-timer-label",
    );
    if (labelElem) labelElem.textContent = `(${activeLabel})`;

    const indicator = document.getElementById(
      "family-website-monitor-timer-indicator",
    );
    if (indicator) {
      if (activeTime < 60) {
        indicator.style.background = "#f87171";
        indicator.style.boxShadow = "0 0 8px #f87171";
      } else if (activeTime < 300) {
        indicator.style.background = "#fbbf24";
        indicator.style.boxShadow = "0 0 8px #fbbf24";
      } else {
        indicator.style.background = "#4ade80";
        indicator.style.boxShadow = "0 0 8px #4ade80";
      }
    }
  }

  function checkAndStartTimer() {
    chrome.runtime.sendMessage({ type: "checkTimeStatus" }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      if (!response.dlData.isTarget && !response.tempData.isTemp) return;
      updateTimer(response.dlData, response.tempData);
      if (!timerInterval) {
        timerInterval = setInterval(() => {
          if (document.hasFocus() && document.visibilityState === "visible") {
            chrome.runtime.sendMessage({ type: "heartbeat" }, () => {
              chrome.runtime.sendMessage(
                { type: "checkTimeStatus" },
                (statusResp) => {
                  if (
                    chrome.runtime.lastError ||
                    !statusResp ||
                    (!statusResp.dlData.isTarget && !statusResp.tempData.isTemp)
                  ) {
                    if (timerElement) {
                      timerElement.remove();
                      timerElement = null;
                    }
                    clearInterval(timerInterval);
                    timerInterval = null;
                    return;
                  }
                  updateTimer(statusResp.dlData, statusResp.tempData);
                },
              );
            });
          }
        }, 1000);
      }
    });
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    checkAndStartTimer();
  } else {
    document.addEventListener("DOMContentLoaded", checkAndStartTimer);
  }
})();

(function () {
  document.addEventListener(
    "click",
    function (e) {
      const link = e.target.closest("a");
      if (!link || !link.href) return;
      if (
        link.href.startsWith("javascript:") ||
        link.href.startsWith("#") ||
        link.href.trim() === ""
      )
        return;

      const realUrl = resolveRedirectUrl(link.href);
      e.preventDefault();
      e.stopPropagation();

      chrome.runtime.sendMessage(
        { type: "checkLinkStatus", url: realUrl },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            window.location.href = realUrl;
            return;
          }
          if (response.status === "allowed") {
            if (link.target === "_blank") window.open(realUrl, "_blank");
            else window.location.href = realUrl;
          } else {
            chrome.runtime.sendMessage({
              type: "forceBlockRedirect",
              url: realUrl,
              reason: response.reason || "default",
              openInNewTab: link.target === "_blank",
            });
          }
        },
      );
    },
    true,
  );
})();

(function () {
  function checkSpaUrl(targetUrl) {
    try {
      const absoluteUrl = new URL(targetUrl, window.location.origin).href;
      const realUrl = resolveRedirectUrl(absoluteUrl);
      chrome.runtime.sendMessage(
        { type: "checkLinkStatus", url: realUrl },
        (response) => {
          if (chrome.runtime.lastError || !response) return;
          if (response.status !== "allowed") {
            chrome.runtime.sendMessage({
              type: "forceBlockRedirect",
              url: realUrl,
              reason: response.reason || "default",
              openInNewTab: false,
            });
          }
        },
      );
    } catch (e) {
      console.error("Error parsing SPA URL:", e);
    }
  }

  const patchHistory = function (type) {
    const orig = history[type];
    return function () {
      const result = orig.apply(this, arguments);
      const url = arguments[2];
      if (url) checkSpaUrl(url);
      return result;
    };
  };

  history.pushState = patchHistory("pushState");
  history.replaceState = patchHistory("replaceState");

  window.addEventListener("popstate", () => {
    checkSpaUrl(window.location.href);
  });
  window.addEventListener("hashchange", () => {
    checkSpaUrl(window.location.href);
  });
})();
