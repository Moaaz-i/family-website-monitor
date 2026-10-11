# Privacy Policy — Family Website Monitor

_Last updated: 2026-10-11_

This policy covers the Chrome extension **Family Website Monitor** (the
"extension"). It is written for the Chrome Web Store listing and for anyone
installing it for their family.

## Short version

The extension has **no analytics, no tracking, no advertising, no accounts
and no servers of its own**. Every piece of data it uses is stored on the
device it runs on. Nothing is uploaded anywhere by us.

## What it stores, and where

| Data | Where it lives | Leaves the device? |
| --- | --- | --- |
| Parent password (PBKDF2-SHA256 hash, salted) | `chrome.storage.local` | No |
| Optional PIN (same hashing) | `chrome.storage.local` | No |
| Whitelist, blocklist, schedule, daily limits, screen-time configuration | `chrome.storage.local` | Only if the parent enables Chrome sync (see below) |
| Time, visit and blocked-attempt counters; 14-day usage report | `chrome.storage.local` | No |
| Failed-login log, lockout and session token | `chrome.storage.local` | No |

**About Chrome sync.** The extension mirrors the *rule configuration*
(whitelists, blocklists, schedule, limits, screen-time settings) through
`chrome.storage.sync` so a family with two computers configures the lists
once. That data goes to Google under the user's own Chrome sync account, on
Google's terms — not to us. Passwords, PINs, sessions and all usage counters
are explicitly excluded from sync and never leave the device.

## What the extension does **not** do

- It does not collect, transmit or sell personal information of any kind.
- It has no telemetry, crash reporting, analytics SDKs or advertising.
- It downloads no remote code. Everything it runs is inside the package.
- It does not keep a browsing history anywhere except the local usage report
  on this device, which the parent can clear from the panel and which is
  pruned to the last 14 days automatically.
- It cannot read pages on `chrome://`, the Chrome Web Store, or PDFs, and
  makes no attempt to.

## Children's privacy

No data is collected from anyone, including children. Because the extension
collects nothing, no child's information is stored, processed or shared.

## Permissions and why they are needed

| Permission | Why |
| --- | --- |
| `storage` | Stores the rules, counters and settings on the device. |
| `tabs` | Reads the current tab's URL to enforce rules and to show the current site in the popup. |
| `webNavigation` | Applies the rules when a page (or an iframe inside it) starts loading, including cross-site redirects. |
| `alarms` | Periodic maintenance: expiring temporary allowances, rolling the daily counters over at midnight, checking for updates. |
| `privacy` | An optional switch that reduces WebRTC IP leakage. It is off until the parent turns it on. |
| `notifications` | Time warnings ("5 minutes left") and the "your child is asking for more time" alert. |
| `<all_urls>` (host access) | The content scripts that show the countdown pill on a limited site and enforce the rules on the page. |
| New tab override | Shows the family dashboard (clock, time left, allowed sites) instead of the browser's new tab. |

## Data retention and deletion

- The usage report keeps at most 14 days and is cleared by the parent from
  the panel at any time.
- Uninstalling the extension removes everything: the background worker
  clears its local settings and purges the synced mirror on uninstall.
- "Clear all data" from Chrome's extension page removes the rest.

## Security

- The parent password and PIN are stored only as PBKDF2-SHA256 hashes
  (310,000 iterations, random per-password salt, constant-time comparison).
  They are never readable in plaintext, never synced and never logged.
- Five wrong attempts lock the panel for a cooldown period.
- The panel locks itself automatically when its tab is hidden.

## Changes

Any change to this policy is published in this repository and dated above.
The extension's own history is in [CHANGELOG.md](CHANGELOG.md).

## Contact

Questions or reports: <https://github.com/Moaaz-i/family-website-monitor/issues>

This extension is distributed by an individual developer, not by Google.
