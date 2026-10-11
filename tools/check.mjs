// Static checks that catch the mistakes a unit test cannot: a missing
// translation, an element id the script expects but the page never renders,
// mismatched version numbers, or a locale file that is not valid JSON.
//
//   node tools/check.mjs        (or: npm run check)

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/tools$/, "");
const SRC = join(ROOT, "src");
const problems = [];
const fail = (msg) => problems.push(msg);

const read = (p) => readFileSync(p, "utf8");
const readJson = (p) => {
  try {
    return JSON.parse(read(p));
  } catch (e) {
    fail(`invalid JSON: ${p} (${e.message})`);
    return null;
  }
};

// ─── 1. JSON documents ───────────────────────────────────────────────────────
const manifest = readJson(join(SRC, "manifest.json"));
const pkg = readJson(join(ROOT, "package.json"));
const version = readJson(join(ROOT, "version.json"));
const en = readJson(join(SRC, "_locales/en/messages.json")) || {};
const ar = readJson(join(SRC, "_locales/ar/messages.json")) || {};

if (manifest && pkg && manifest.version !== pkg.version) {
  fail(`version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`);
}
if (version && pkg && version.version !== pkg.version) {
  fail(`version mismatch: version.json ${version.version} vs package.json ${pkg.version}`);
}

// ─── 2. Locale parity ────────────────────────────────────────────────────────
for (const key of Object.keys(en)) if (!ar[key]) fail(`locale "ar" is missing "${key}"`);
for (const key of Object.keys(ar)) if (!en[key]) fail(`locale "en" is missing "${key}"`);
for (const [lang, dict] of [
  ["en", en],
  ["ar", ar],
]) {
  for (const [key, value] of Object.entries(dict)) {
    if (!value || typeof value.message !== "string" || !value.message.trim()) {
      fail(`locale "${lang}" entry "${key}" has no message`);
    }
  }
}

// ─── 3. Referenced translation keys exist ────────────────────────────────────
const htmlFiles = readdirSync(SRC).filter((f) => f.endsWith(".html"));
const jsFiles = readdirSync(SRC).filter((f) => f.endsWith(".js"));

for (const file of htmlFiles) {
  const html = read(join(SRC, file));
  const keys = [...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  for (const key of new Set(keys)) {
    if (!en[key]) fail(`${file}: data-i18n "${key}" missing in en`);
    if (!ar[key]) fail(`${file}: data-i18n "${key}" missing in ar`);
  }
}
for (const file of jsFiles) {
  const js = read(join(SRC, file));
  const keys = [...js.matchAll(/\bt\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  for (const key of new Set(keys)) {
    if (!en[key]) fail(`${file}: t("${key}") missing in en`);
    if (!ar[key]) fail(`${file}: t("${key}") missing in ar`);
  }
}

// ─── 4. Every getElementById() target exists in its page ─────────────────────
const pairs = [
  ["options.js", "options.html"],
  ["popup.js", "popup.html"],
  ["blocked.js", "blocked.html"],
  ["blocked-extensions.js", "blocked-extensions.html"],
];
for (const [script, page] of pairs) {
  const js = read(join(SRC, script));
  const html = read(join(SRC, page));
  const ids = [...js.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  for (const id of new Set(ids)) {
    if (!html.includes(`id="${id}"`)) fail(`${script}: no element id="${id}" in ${page}`);
  }
}

// ─── 5. Stylesheet stays balanced ────────────────────────────────────────────
const css = read(join(SRC, "style.css"));
let depth = 0;
for (const ch of css) {
  if (ch === "{") depth++;
  if (ch === "}") depth--;
  if (depth < 0) break;
}
if (depth !== 0) fail(`style.css: unbalanced braces (depth ${depth})`);

// ─── 6. Content scripts referenced by the manifest exist ─────────────────────
if (manifest) {
  for (const group of manifest.content_scripts || []) {
    for (const file of group.js || []) {
      if (!readdirSync(SRC).includes(file)) fail(`manifest references missing content script ${file}`);
    }
  }
  if (manifest.background?.service_worker) {
    const sw = manifest.background.service_worker;
    if (!readdirSync(SRC).includes(sw)) fail(`manifest references missing service worker ${sw}`);
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`✓ checks passed (${Object.keys(en).length} keys, ${htmlFiles.length} pages)`);
