# Changelog

All notable changes to Family Website Monitor are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [3.0.0] - 2026-10-10

### Added

- **Whole-day screen-time budget** — one allowance per day across *every*
  site (Limits tab), independent of the per-site limits. Sites on the
  whitelist and an active temporary allowance stay open; the blocked page
  gets its own reason and the popup shows what is left today.
- **Cross-device policy sync** — the whitelist, blocklist, schedule, limits,
  notification switch and screen-time configuration mirror through
  `chrome.storage.sync` (chunked, debounced, loop-guarded). The password, the
  PIN, sessions and every usage counter never sync.
- **"Ask a parent for more time"** on the blocked page — the child presses a
  button, the parent gets a desktop notification with *Allow 15 min / Not
  now*. Cooldown, single outstanding request, and approval only ever comes
  from the service worker. The button is hidden where approval could not
  help (emergency lock, tamper alarm, blocklist).
- **PIN quick unlock** — optional 4–8 digit PIN for the popup so a parent
  does not type a long password in front of a child. Stored as a PBKDF2
  spec, verified in the worker, sharing the password's brute-force lockout,
  never synced. Setting, changing and removing it all require the password.
- **Search in the white- and blocklists** with a live "Showing N of M"
  count, so a 1000-entry whitelist stays usable.
- **Report exports** — CSV (Excel-friendly, BOM so Arabic survives) and a
  CSS bar chart of the day's busiest sites next to the table.
- **Search bar on the new tab page** — Enter searches the web; typing
  offers the matching *allowed* sites first (mouse or ↑/↓ + Enter), so the
  safe destination is always the fastest one to reach. The grid below
  filters live while you type.
- **First-run wizard** — right after the password is created, one screen
  offers the block packs and the screen-time budget, so a fresh install
  leaves the panel already enforcing something.
- **Frame-aware enforcement** — every iframe is evaluated with its own URL;
  a blocked frame redirects the whole tab (an extension page cannot be
  framed).
- **Local preview harness** (`npm run preview`) — serves `dist/` with a
  `chrome.*` stub *and* the real service worker, so every page and flow
  (auth, rules, notifications, ask-more-time) can be exercised in a normal
  browser tab. `?noseed` previews the true first run.
- **ESLint** (flat config, `npm run lint`), lint in CI, and a tag-driven
  release workflow: `vX.Y.Z` is verified against the manifest version,
  zipped and published as a GitHub release.
- **Usage report tab** — time, visits and blocked attempts per site for each
  of the last 14 days, with a day picker, totals and a clear action.
- **Blocklist tab** — add, review and remove blocked domains/keywords. A
  block outranks every whitelist entry and every temporary allowance.
- **One-click packs** — curated block packs (social, video, gaming, shopping,
  streaming) and safe packs (learning, kids) that fill the lists in one click.
- **Time-warning notifications** — desktop warnings at 5 minutes and
  1 minute left, now with an on/off switch in Settings (the `notifications`
  permission was added).
- **WhatsApp Web observer** moved to its own content script
  (`content-whatsapp.js`, matched only on `web.whatsapp.com`) so no other site
  pays for its `MutationObserver`.
- Blocked page now explains *which* rule applied, including a dedicated
  message for blocklist hits.
- Unit tests for the blocklist matcher, rule precedence and the packs
  (`tests/blocklist.test.js`).

### Changed

- **Domain-level matching for limits and temporary allowances** — daily
  limits, the screen-time budget and temporary allowances match the site
  suffix (`youtube.com` covers `youtube.com/watch?v=…`). This fixes the
  serious bug where limits never applied to real URLs because the full path
  had to match exactly.
- **Rule order** is now: tamper alarm → emergency lock → blocklist →
  temporary allowance → whitelist → screen-time budget → daily limit →
  schedule → default. A blocklist entry is no longer lifted by a temporary
  allowance.
- **Password storage** — PBKDF2-SHA256 with 310,000 iterations, a random
  per-password salt and constant-time comparison. Legacy `sha256$` and
  plaintext specs are upgraded transparently on the next successful login.
  The password is no longer written to `chrome.storage.sync` (which uploads it
  to Google's servers); any copy that was synced is purged.
- **Verification moved to the service worker** — extension pages never read
  the stored hash; the lockout counter and failed-attempt log live with it.
- **Navigation rules** use `webNavigation.onBeforeNavigate` /
  `onHistoryStateUpdated` instead of intercepting clicks, which restores
  Ctrl/Cmd+click, middle-click, `target="_blank"` and `window.open()`.
- **Performance** — a 2-second policy cache invalidated by
  `storage.onChanged`, and write-behind time accounting (one flush per 15 s
  instead of a storage write per second per tab).
- Activity is now recorded on every page, not only on limited sites, so the
  report covers the whole browsing day. Counting requires a visible, focused
  tab.
- Session length raised to 15 minutes (auto-lock on hiding the panel remains).
- Icons are generated at build time by `tools/generate-icons.mjs`.
- Emoji replaced by inline SVG icons; new styles use logical properties so
  the Arabic RTL layout is correct.

### Fixed

- **Allowed sites bounced to the blocked page on load** — every modern page
  creates an `about:blank` (or `about:srcdoc` / `blob:` / `data:`) frame for
  a lazy embed, and frame-aware enforcement judged that empty box like a
  site, so an allowed page dragged the whole tab to
  `blocked.html?target=about:blank&reason=default`. Only real destinations
  (http/https/file) are judged now; a `data:` frame cannot smuggle a site
  in either, because any http(s) navigation inside it is still checked.
- Daily limits and temporary allowances matched the full URL path, so they
  never matched any real page (`youtube.com` vs `youtube.com/watch`).
- A page blocked inside an iframe could bounce the user into the settings
  page; the tab is now redirected to the blocked page instead.
- Hardcoded English strings (limits table headers/title, several toasts)
  and an emoji in the limits heading broke the Arabic build.
- `src/lib/backup.js` imported `BACKUP_SALT`, which no longer existed —
  backup export/import failed on load.
- Daily-limit migration wrote to `targetSites` instead of the migrated
  structure, so limits silently disappeared after the modular refactor.
- The limits table treated any site with recorded usage as "limited".
- The report's day filter, `decodeURIComponent` double-decoding of
  `URLSearchParams.get()`, and the same save listener being registered once
  per successful unlock on the blocked page.
- Notification de-duplication dropped *other* sites' stamps on every write.
- Toast accent colours and the toggle switch ignored the RTL direction
  because they were keyed on `body[dir]` while the translator sets
  `document.documentElement.dir`.
- Blocklist keyword matching no longer swallows look-alike hosts
  (`x.com` no longer matches `fox.com`).
- Missing translations for `targetSite`, `limitInMinutes`,
  `settingsGeneral`, `settingsLanguage` and `statusActive`.
- The `javascript:` redirect guard in `blocked.html`/`options.html` and
  message-source checks for `forceBlockRedirect`.

### Deferred

- `declarativeNetRequest` blocking before the request is made — a faulty rule
  set would break browsing for the whole profile, so it ships only with a
  tested rollback path.

## [2.2.0] - 2026-09-19

- Modular `src/` → `dist/` build with esbuild, generated icons and unit tests
  for the rules engine.
- Whole-domain allow mode (a per-site toggle in the whitelist, popup and
  blocked page).

## [2.1.0] and earlier

- Auto-update check against `version.json`, update banner and modal.
- Emergency lock, browsing schedule, per-site daily limits, activity log of
  failed parent-password attempts, English/Arabic interface.
