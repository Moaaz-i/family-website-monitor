# Privacy Policy

This repository's root copy exists so it can be served publicly (GitHub
Pages) and pointed at from the Chrome Web Store listing.

**Published copy:** <https://moaaz-i.github.io/family-website-monitor/PRIVACY.html>

**Full, dated policy:** [docs/privacy-policy.md](docs/privacy-policy.md)

## Summary

Family Website Monitor collects **nothing**. There is no analytics, no
tracking, no advertising, no account and no server of ours involved.

- Everything the extension stores — the password hash, the lists, the
  counters, the usage report — lives in `chrome.storage.local` on the
  device.
- If the parent enables Chrome sync, the rule *configuration* (lists,
  schedule, limits, screen-time budget) is mirrored through
  `chrome.storage.sync`, i.e. to Google under the user's own account. The
  password, the PIN, sessions and every usage counter are never synced.
- Search queries are never stored. The new-tab search opens the search
  engine's own results page directly, and the optional parent-enabled
  filter ("only allowed sites") only hides non-allowed results on that
  page — the query travels from the browser to the search engine and
  nowhere else.
- Uninstalling the extension clears its local settings and purges the
  synced mirror.
- The usage report keeps at most 14 days and can be cleared from the panel.

Contact and issue reports: <https://github.com/Moaaz-i/family-website-monitor/issues>
