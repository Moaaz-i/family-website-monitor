# Family Website Monitor

A parental-control extension for Chrome (Manifest V3) that keeps children on
the sites you allow, limits how long they can stay there, and shows you what
they actually did with their time.

English · [العربية](#العربية)

---

## What it does

| Area | Behaviour |
| --- | --- |
| **Whitelist** | Only sites you allow open. Each entry can cover one exact URL or a whole domain (all sub-links). |
| **Blocklist** | Domains and keywords a parent blocks. A block always outranks the whitelist. |
| **Schedule** | Allowed days and a daily time window (overnight windows such as `22:00 → 06:00` are supported). |
| **Daily limits** | Per-site minutes per day, with a live countdown pill on the page and a hard stop when time runs out. |
| **Usage report** | Time, visits and blocked attempts per site, per day, kept for 14 days — with a bar chart and a CSV export. |
| **Screen-time budget** | One allowance per day across every site. Whitelisted sites and an active temporary allowance stay open. |
| **Ask for more time** | The blocked page offers a button; you get a desktop notification with *Allow 15 min / Not now*. |
| **Devices** | The lists, schedule, limits and screen-time configuration sync between your devices. The password, PIN and usage counters do not. |
| **Emergency lock** | One click closes everything until you unlock it again. |
| **PIN unlock** | Optional 4–8 digit PIN for the popup, verified with the same PBKDF2 work and the same lockout as the password. |
| **Parent login** | PBKDF2-SHA256 (310,000 iterations) with a per-password salt, constant-time comparison, a 5-attempt lockout, and a 15-minute rolling session. The hash never leaves the device and is never written to `chrome.storage.sync`. |
| **Incognito guard** | Warns when the extension is not allowed to run in Incognito windows — the easiest way around every rule. |
| **Search** | Both lists are filterable, with a live "showing N of M" count. |
| **Languages** | English and Arabic, with full RTL layout. |

## Install (release build)

```bash
npm ci
npm run package      # builds a minified dist/ and family-website-monitor.zip
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load
unpacked** and select the `dist/` folder.

> The icons are generated at build time. Loading `src/` directly will work
> except for the icons — always build first.

## Publish to the Chrome Web Store

Everything the store form needs is already in the repository:

| Store field | Source |
| --- | --- |
| Name, summary, long description (EN + AR), single purpose, permission justifications | [`docs/store-listing.md`](docs/store-listing.md) |
| Privacy policy | [`docs/privacy-policy.md`](docs/privacy-policy.md), served publicly as [`PRIVACY.md`](PRIVACY.md) |
| The package itself | the zip produced by the release workflow |

Steps:

1. Bump the version in **three** places (`src/manifest.json`,
   `package.json`, `version.json`) and add a `CHANGELOG.md` entry.
2. Publish the privacy policy: **Settings → Pages → Deploy from a branch →
   `main` / root**, then use
   `https://moaaz-i.github.io/family-website-monitor/PRIVACY.html` in the
   dashboard.
3. Tag and push: `git tag v3.1.0 && git push --tags`. The release workflow
   checks that the tag matches the manifest version, runs
   check + lint + tests, builds the minified package and attaches
   `family-website-monitor-vX.Y.Z.zip` to a GitHub release.
4. Upload that zip in the developer dashboard, paste the texts from
   `docs/store-listing.md`, add the screenshots listed there, and submit.

## Develop

```bash
npm run build        # fast, unminified build into dist/
npm run prod         # minified build (what the store gets)
npm run watch        # rebuild on change
npm test             # unit tests for the rules engine
npm run lint         # ESLint over src/, tests/ and tools/
npm run check        # manifest, locale parity and page-id sanity checks
npm run verify       # check + lint + tests + production build
npm run icons        # regenerate dist/icons/*.png only
npm run preview      # serve dist/ at http://127.0.0.1:4173 with a chrome.* stub
```

`npm run preview` is the fastest way to look at the UI: it serves the built
pages, injects a `chrome.*` implementation (storage, messages,
notifications) **and** the real service worker, so rules, auth, the
ask-for-more-time notification and screen time all behave as they do in the
browser. Add `?noseed` to the URL to preview the true first run (password
setup + wizard) instead of the seeded demo data. Content scripts are the one
thing a local server cannot show — those need the real extension.

## Layout

```
src/
  background.js          service worker: policy cache, navigation rules,
                         time accounting, auth, notifications, updates
  content.js             1 Hz heartbeat + "time remaining" pill
  content-whatsapp.js    WhatsApp Web DOM observer (kept separate so no other
                         site pays for it)
  options.html/.js       parent control panel (tabs: whitelist, blocklist,
                         schedule, limits, report, log, settings)
  popup.html/.js         quick status + unlock
  blocked.html/.js       the page a child sees, with a separate parent area
  lib/
    rules.js             decide allow/block and why (determineUrlStatus)
    url.js               strict URL normalisation, redirect unwrapping
    security.js          PBKDF2 password specs, session tokens
    presets.js           one-click block/allow packs
    constants.js         every tunable number in one place
    translator.js        EN/AR loading + DOM translation
  _locales/{en,ar}       UI strings
tests/                   node:test suites
tools/generate-icons.mjs icon generator (no design tooling required)
build.mjs                esbuild bundler + static copy
```

### How a navigation is decided

1. `webNavigation.onBeforeNavigate` / `onHistoryStateUpdated` and
   `tabs.onUpdated` all feed `checkAndApplyRules()`.
2. The URL is resolved (Google/DuckDuckGo redirect links are unwrapped) and
   `determineUrlStatus()` runs the ordered checks:
   time tampering → emergency lock → active temporary allowance →
   **blocklist** → whitelist → daily limit → schedule → default deny.
3. A block navigates the tab to `blocked.html?target=…&reason=…`; the reason
   drives the message the child sees.

### How time is counted

The content script sends one heartbeat per second on **every** page. The
service worker turns those into (a) seconds against a site's daily limit and
(b) the per-host activity bucket used by the report. Seconds are accumulated
in memory and flushed to storage at most every 15 seconds, so a dozen open
tabs cost a handful of writes per minute instead of thousands. Counting only
happens while the tab is visible **and** focused.

## Security notes

- Password verification happens exclusively in the service worker; no
  extension page reads the stored hash.
- Legacy `sha256$` and plaintext specs are upgraded to PBKDF2 automatically
  on the next successful login.
- `blocked.html?target=` is validated (`http:`/`https:` only) before any
  navigation, so a crafted link cannot run `javascript:` inside the
  extension origin.
- The blocked page is frame-busted, and messages that navigate a tab are only
  accepted from real web pages.
- No `eval`, no remote code, no inline scripts (`script-src 'self'`).

## Known limitations

- Chrome extensions cannot intercept `chrome://` pages, the Web Store, or
  PDFs; the extensions page is guarded, everything else in `chrome://` is
  beyond reach for any extension.
- `declarativeNetRequest` is deliberately not used yet: a rule-set bug would
  take down the whole browser session. It is the planned next step for
  blocking *before* the request is made.
- Time counting needs the tab to be visible and focused, which is the
  behaviour children quickly learn and parents usually want.
- Time is counted **per device**: each computer keeps its own screen-time
  and daily-limit counters, while the *configuration* (limits, budgets,
  lists) is what syncs.
- The new-tab dashboard is a manifest-level override: Chrome offers no API
  to restore the browser's own new tab, so the family page always replaces
  it once the extension is installed.

## العربية

إضافة كروم للرقابة الأبوية: قائمة بيضاء ومواقع محجوبة، جدول تصفح، حد يومي
لكل موقع، تقرير استخدام، وقفل طوارئ.

- **كلمة المرور:** تُخزَّن بصيغة PBKDF2 على الجهاز فقط، ولا تُرفع إلى سحابة
  جوجل، ولا تُقرأ من صفحات الإضافة.
- **الحجب أولاً:** أي موقع في القائمة السوداء يبقى محجوباً حتى لو أضفته
  للقائمة البيضاء.
- **التقرير:** الوقت والزيارات والمحاولات المحجوبة لكل موقع خلال 14 يوماً،
  مع رسم بياني وتصدير CSV.
- **وقت الشاشة:** حدّ إجمالي يومي لكل المواقع، والمواقع المسموح بها تبقى
  مفتوحة.
- **طلب وقت إضافي:** زر في صفحة الحظر يصلك إشعار على سطح المكتب مع زرّي
  «اسمح بـ 15 دقيقة» و«ليس الآن».
- **بين الأجهزة:** تتم مزامنة القوائم والقواعد، أما كلمة المرور ورمّز PIN
  وعدّادات الوقت فتبقى على الجهاز.
- الواجهة تدعم العربية والإنجليزية مع اتجاه RTL كامل.

للتشغيل:

```bash
npm ci
npm run package
```

ثم `chrome://extensions` ← **Developer mode** ← **Load unpacked** ← اختر مجلد
`dist/`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
