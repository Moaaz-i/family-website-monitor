#!/usr/bin/env node
/**
 * Local preview server for the extension UI.
 *
 *   npm run preview            # serve dist/ on http://127.0.0.1:4173
 *   npm run preview -- 8080    # custom port
 *
 * What it does:
 *  1. serves the built files from dist/ (run `npm run build` first),
 *  2. injects tools/chrome-stub.js into every HTML page, which provides the
 *     chrome.* APIs the pages expect,
 *  3. injects a module import of the real dist/background.js, so message
 *     routing, policy rules, auth and notifications are the production code
 *     and not a mock.
 *
 * Content scripts are intentionally not previewed: they need real pages.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = normalize(join(here, ".."));
const distDir = join(root, "dist");
const port = Number(process.argv[2]) || 4173;

if (!existsSync(join(distDir, "manifest.json"))) {
  console.error("dist/manifest.json is missing — run `npm run build` first.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webmanifest": "application/manifest+json",
};

const INJECT = [
  '<script src="/chrome-stub.js"></script>',
  '<script type="module">import "/background.js";</script>',
].join("");

function injectIntoHtml(html) {
  if (html.includes("chrome-stub.js")) return html;
  if (html.includes("</head>")) return html.replace("</head>", `${INJECT}</head>`);
  return `${INJECT}${html}`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/options.html";

    // The stub is a dev tool, not part of the build.
    if (pathname === "/chrome-stub.js") {
      const body = await readFile(join(here, "chrome-stub.js"));
      res.writeHead(200, { "content-type": MIME[".js"] });
      res.end(body);
      return;
    }

    // Never escape dist/.
    const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(distDir, relative);
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(302, { location: "/options.html" }).end();
      return;
    }

    const ext = extname(filePath);
    let body = await readFile(filePath);
    if (ext === ".html") body = Buffer.from(injectIntoHtml(body.toString("utf-8")), "utf-8");

    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    console.error(e);
    res.writeHead(500).end("server error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Preview: http://127.0.0.1:${port}/`);
  console.log(`  control panel  http://127.0.0.1:${port}/options.html`);
  console.log(`  popup          http://127.0.0.1:${port}/popup.html`);
  console.log(`  blocked page   http://127.0.0.1:${port}/blocked.html?target=${encodeURIComponent("https://www.youtube.com/watch?v=demo")}&reason=limit`);
  console.log("\nDemo parent password: parent123   (state persists in this browser's localStorage)");
  console.log("Press Ctrl+C to stop.");
});
