// Curated one-click packs for the options page. Keeping the data here (and
// not inline in HTML) means the same list is reused by the block and allow
// preset renderers and stays translatable through the label keys.

export const BLOCK_PRESETS = [
  {
    id: "social",
    labelKey: "presetSocial",
    domains: [
      "facebook.com",
      "instagram.com",
      "tiktok.com",
      "snapchat.com",
      "twitter.com",
      "x.com",
      "reddit.com",
      "pinterest.com",
      "threads.net",
    ],
  },
  {
    id: "video",
    labelKey: "presetVideo",
    domains: ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "twitch.tv"],
  },
  {
    id: "gaming",
    labelKey: "presetGaming",
    domains: ["roblox.com", "poki.com", "miniclip.com", "addictinggames.com", "friv.com"],
  },
  {
    id: "shopping",
    labelKey: "presetShopping",
    domains: ["amazon.com", "ebay.com", "aliexpress.com", "temu.com", "shein.com", "wish.com"],
  },
  {
    id: "streaming",
    labelKey: "presetStreaming",
    domains: [
      "netflix.com",
      "hulu.com",
      "disneyplus.com",
      "primevideo.com",
      "max.com",
      "crunchyroll.com",
    ],
  },
];

export const SAFE_PRESETS = [
  {
    id: "learning",
    labelKey: "safeLearning",
    domains: [
      "khanacademy.org",
      "wikipedia.org",
      "scratch.mit.edu",
      "code.org",
      "duolingo.com",
    ],
  },
  {
    id: "kids",
    labelKey: "safeKids",
    domains: [
      "pbskids.org",
      "starfall.com",
      "abcya.com",
      "ducksters.com",
      "nationalgeographickids.com",
    ],
  },
];

/** Merge a pack into a keyword list, ignoring duplicates. Returns true on change. */
export function mergeIntoKeywords(existing, domains) {
  const set = new Set((Array.isArray(existing) ? existing : []).map((k) => String(k).toLowerCase()));
  let changed = false;
  for (const domain of domains) {
    const token = String(domain).toLowerCase();
    if (set.has(token)) continue;
    set.add(token);
    changed = true;
  }
  if (!changed) return { changed: false, list: existing };
  return { changed: true, list: Array.from(set) };
}
