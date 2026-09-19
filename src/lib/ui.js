import { t } from "./translator.js";

export function showToast(message, type = "success") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("show");
  }, 10);

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

export function startLockoutTimer(inputEl, buttonEl, expiryTime, placeholderKey = "enterParentPassword") {
  inputEl.disabled = true;
  buttonEl.disabled = true;

  function updateTimer() {
    const remaining = Math.ceil((expiryTime - Date.now()) / 1000);
    if (remaining <= 0) {
      inputEl.disabled = false;
      buttonEl.disabled = false;
      inputEl.value = "";
      inputEl.placeholder = t(placeholderKey) || "Enter parent password";
      chrome.storage.local.set({ failedAttemptsCount: 0, lockoutExpiry: 0 });
    } else {
      inputEl.placeholder = `${t("lockedOut") || "Locked out"} (${remaining}s)`;
      setTimeout(updateTimer, 1000);
    }
  }
  updateTimer();
}

export function handleLockout(inputEl, buttonEl, placeholderKey = "enterParentPassword") {
  chrome.storage.local.get(["failedAttemptsCount", "lockoutExpiry"], (data) => {
    const now = Date.now();
    const expiry = data.lockoutExpiry || 0;
    if (expiry > now) {
      startLockoutTimer(inputEl, buttonEl, expiry, placeholderKey);
    }
  });
}

export function applyThemeClass() {
  chrome.storage.local.get("theme", (data) => {
    const savedTheme = data.theme;
    const theme = savedTheme || "light";
    document.body.classList.toggle("dark", theme === "dark");
  });
}