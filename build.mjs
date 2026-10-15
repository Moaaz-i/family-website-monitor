import esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateIcons } from "./tools/generate-icons.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

const ENTRIES = [
  "background.js",
  "content-embed.js",
  "content.js",
  "content-search.js",
  "content-whatsapp.js",
  "content-youtube.js",
  "options.js",
  "popup.js",
  "blocked.js",
  "blocked-extensions.js",
  "newtab.js",
];

const STATIC_FILES = [
  "manifest.json",
  "options.html",
  "popup.html",
  "popup.css",
  "blocked.html",
  "blocked-extensions.html",
  "uninstall.html",
  "uninstall.css",
  "newtab.html",
  "newtab.css",
  "style.css",
];

const STATIC_DIRS = ["_locales"];

const minify = process.argv.includes("--minify");
const watch = process.argv.includes("--watch");

async function build() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // Icons are generated (not committed) so the mark can be tweaked in code.
  const icons = generateIcons(join(DIST, "icons"));
  console.log(`✔ Generated ${icons.length} icons`);

  const options = {
    entryPoints: ENTRIES.map((f) => join(SRC, f)),
    outdir: DIST,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome110"],
    minify,
    sourcemap: false,
    logLevel: "info",
    outbase: SRC,
  };

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("👀 Watching for changes... (Ctrl+C to stop)");
    return;
  }

  await esbuild.build(options);

  for (const file of STATIC_FILES) {
    cpSync(join(SRC, file), join(DIST, file));
  }
  for (const dir of STATIC_DIRS) {
    cpSync(join(SRC, dir), join(DIST, dir), { recursive: true });
  }

  console.log(`✔ Bundled ${ENTRIES.length} entries into dist/`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});