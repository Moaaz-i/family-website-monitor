# Chrome Web Store listing — Family Website Monitor

Copy-paste source for the developer dashboard. Keep the English text as the
store primary language and attach the Arabic as a second locale
(`ar` — the extension ships both).

---

## 1. Name

```
Family Website Monitor — Parental Control
```

## 2. Summary (single line, max 132 characters)

English:

```
Whitelist parental control: blocked sites, schedules, daily limits, a daily screen-time budget and an emergency lock.
```

Arabic:

```
رقابة أبوية بقائمة بيضاء: مواقع محجوبة، جدول تصفح، حدود يومية، ميزانية وقت شاشة وقفل طوارئ.
```

## 3. Category

```
Parenting
```

## 4. Language

```
English (en), Arabic (ar) — full RTL layout
```

## 5. Long description (English)

```text
Family Website Monitor is a whitelist-first parental control extension: nothing opens unless you allow it, and everything you block stays blocked.

WHAT IT DOES
• Whitelist — only the sites you allow open. An entry can cover one exact URL or a whole domain with all its sub-pages.
• Blocklist — domains and keywords a child cannot open, even if they were added to the whitelist by mistake.
• Schedule — allowed days and a daily time window. Overnight windows such as 22:00 → 06:00 are supported.
• Daily limits — minutes per site per day, with a live countdown pill on the page and a hard stop when the time runs out.
• Screen-time budget — one allowance per day across every site. Whitelisted sites always stay open.
• Ask for more time — the blocked page has a button; you get a desktop notification with "Allow 15 min" or "Not now".
• Embeds — if an allowed site embeds a blocked one (a video, a login box), that frame is emptied in place; the page keeps working.
• Usage report — time, visits and blocked attempts per site for the last 14 days, with a bar chart and CSV export.
• Emergency lock — one click closes everything until you unlock it again.
• Optional PIN — unlock the panel with a short PIN instead of typing your password in front of your children.
• Devices — the lists, schedule and limits sync between your computers through Chrome sync.

BUILT FOR PRIVACY
No analytics, no tracking, no accounts, no servers. Everything stays on your device: the password is stored as a salted PBKDF2 hash, five wrong attempts lock the panel, and the panel locks itself when you hide the tab. Only the rule configuration is mirrored through Chrome's own sync, and only if you turn sync on.

WORKS IN YOUR LANGUAGE
English and Arabic, with a complete right-to-left layout.

Free, open source, and deliberately small: no remote code, no background services beyond what the rules need.
```

## 5b. Long description (Arabic)

```text
إضافة رقابة أبوية قائمة على القائمة البيضاء: لا يُفتح شيء إلا ما تسمح به، وكل ما تحظره يبقى محجوباً.

ما الذي تفعله؟
• القائمة البيضاء — لا يُفتح إلا المواقع التي تسمح بها، إما رابط محدد أو نطاق كامل بكل صفحاته.
• القائمة السوداء — نطاقات وكلمات لا يستطيع طفلك فتحها حتى لو أُضيفت للقائمة البيضاء بالخطأ.
• جدول التصفح — أيام وأوقات مسموح بها، مع دعم النوافذ الليلية مثل 22:00 ← 06:00.
• الحد اليومي — دقائق لكل موقع يومياً مع عدّاد تنازلي على الصفحة وإيقاف فوري عند انتهاء الوقت.
• ميزانية وقت الشاشة — مبلغ واحد ليوم كامل لكل المواقع، والمواقع المسموح بها تبقى مفتوحة دائماً.
• طلب وقت إضافي — في صفحة الحظر زر للطفل، وتصلك إشعار على سطح المكتب بزرّي «اسمح بـ 15 دقيقة» و«ليس الآن».
• العناصر المضمَّنة — إذا ضمَّن موقع مسموح موقعاً محجوباً (فيديو، تسجيل دخول) فُفرَّغ ذلك الإطار في مكانه وتبقى الصفحة تعمل.
• تقرير الاستخدام — الوقت والزيارات والمحاولات المحجوبة لكل موقع خلال 14 يوماً، مع رسم بياني وتصدير CSV.
• قفل الطوارئ — ضغطة واحدة تغلق كل شيء حتى تفتحها أنت.
• رمز PIN اختياري — افتح اللوحة برمز قصير بدلاً من كتابة كلمة المرور أمام طفلك.
• بين الأجهزة — تتم مزامنة القوائم والجدول والحدود بين أجهزتك عبر مزامنة كروم.

مصممة للخصوصية
لا تحليلات ولا تتبع ولا حسابات ولا خوادم. كل شيء يبقى على جهازك: كلمة المرور مخزّنة كبصمة PBKDF2 مُملَّحة، وخمس محاولات خاطئة تقفل اللوحة، وتُقفل اللوحة تلقائياً عند إخفاء التبويب. تُزامَن إعدادات القوائم فقط عبر مزامنة كروم نفسها، وعند تفعيلها فقط.

بلغتك
الإنجليزية والعربية بواجهة اتجاه من اليمين لليسار كاملة.

مجانية ومفتوحة المصدر وخفيفة: لا أكواد عن بُعد ولا خدمات خلفية تتجاوز ما تحتاجه القواعد.
```

## 6. Single purpose statement

```text
Parental control: allow, block, schedule and limit the websites a child can open, and report the time spent.
```

## 7. Permission justifications (dashboard form)

| Permission | Justification text |
| --- | --- |
| `storage` | Saves the parent's rules (whitelist, blocklist, schedule, limits) and the local usage counters on the device. |
| `tabs` | Reads the current tab's URL to apply the rules and to show the current site in the popup. |
| `webNavigation` | Applies the rules the moment the current page starts navigating, which is the only reliable point to allow or block it. Sub-frames and imported assets are not judged. |
| `alarms` | Periodic maintenance: expiring temporary allowances, rolling the daily counters at midnight, and checking for a new version. |
| `privacy` | An optional switch that reduces WebRTC IP leakage. It stays off until the parent enables it in Settings. |
| `notifications` | Warns the parent when a site is about to run out of time and when a child asks for more time. |
| `contextMenus` | Adds two right-click items, "Allow this site" and "Block this site", so a parent can add a site without copying URLs. The item only opens the settings panel with the field filled in; nothing is written until the parent presses Add while logged in. |
| `<all_urls>` host access | The content scripts show the countdown pill on limited sites, hide search results and YouTube titles that match the parent's blocked words, and — in every frame — empty an embed that points at a blocked site (the page itself is never redirected). |
| New tab override (`chrome_url_overrides.newtab`) | Replaces the new tab with a family dashboard (clock, time left, allowed sites). No data leaves the device. |

## 8. Privacy policy URL

Publish `docs/privacy-policy.md` and point the dashboard at it, e.g. the
GitHub Pages rendering of the repository copy:

```
https://moaaz-i.github.io/family-website-monitor/PRIVACY.html
```

(Enable Pages: **Settings → Pages → Deploy from a branch → `main` / root**.)

## 9. Screenshots (1280×800 or 640×400, up to 5)

1. Whitelist tab with the search box and a few entries.
2. Limits tab showing a daily limit and the whole-day screen-time card.
3. Report tab with the bar chart and the totals line.
4. Blocked page with the "Ask a parent for 15 more minutes" button.
5. The new-tab dashboard (clock + allowed-site tiles).

Do not include real browsing data in the screenshots.

## 10. Graphics

- Small promo tile: 440×280 PNG.
- Large promo tile: 1400×560 PNG (optional).
- 128×128 source icon (the build already generates 128/48/32/16).
