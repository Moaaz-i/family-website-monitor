chrome.storage.local.get("theme", (data) => {
  const savedTheme = data.theme;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = savedTheme || (prefersDark ? "dark" : "light");
  document.body.classList.toggle("dark", theme === "dark");
});
