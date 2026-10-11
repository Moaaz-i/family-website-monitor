import js from "@eslint/js";

// Globals available to extension pages, content scripts and the preview tools.
// chrome is the extension API; the rest are standard browser/node builtins.
const globals = {
  chrome: "readonly",
  window: "readonly",
  document: "readonly",
  location: "readonly",
  history: "readonly",
  navigator: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  queueMicrotask: "readonly",
  requestAnimationFrame: "readonly",
  fetch: "readonly",
  crypto: "readonly",
  performance: "readonly",
  structuredClone: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  Blob: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  MutationObserver: "readonly",
  AbortController: "readonly",
  FileReader: "readonly",
  XMLHttpRequest: "readonly",
  Image: "readonly",
  Node: "readonly",
  HTMLElement: "readonly",
  atob: "readonly",
  btoa: "readonly",
  alert: "readonly",
  confirm: "readonly",
  prompt: "readonly",
  Promise: "readonly",
  process: "readonly",
  Buffer: "readonly",
  globalThis: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
};

export default [
  {
    ignores: ["dist/**", "node_modules/**", "*.zip"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals,
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
      "no-implicit-globals": "off",
    },
  },
  {
    // The preview harness is a classic script that defines window.chrome.
    files: ["tools/chrome-stub.js"],
    languageOptions: {
      sourceType: "script",
    },
  },
];
