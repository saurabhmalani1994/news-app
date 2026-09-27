// S30: the Following page's own local history. The Following tab and the You page's
// per-follow "Stories now" (following.js, W3) only ever show the pool's current window,
// so a match that rotates out of the pool is gone from every screen with nothing to show
// it ever existed. Timeline (each follow's own page) needs "over time", so this keeps a
// small per-follow archive in IndexedDB (follow-archive-store.js): each time the page
// input is ranked on device (tabs.js buildSections, the same moment W3's matches are
// computed), every current match is recorded here, keyed by the follow.
//
// Cap: 200 items or 30 days per follow, whichever is smaller, pruned on every record.
// A standing story like Israel and Gaza can run many times a day; 200 items covers a
// couple of weeks of that pace, and 30 days covers a quiet phrase interest that gets a
// handful of hits a month, both comfortably inside DESIGN-v1.1's own "a personal record,
// not a full archive" shape (R23's history stores use the same reasoning: opened keeps a
// year, shown keeps 14 days, sized to what the screen that reads them needs). Kept small
// per follow (not a global cap) so one busy standing story never crowds out a quiet
// phrase's own record.
import { followMatches } from "./following.js";
import { coverageContext } from "./coverage.js";

export const ARCHIVE_MAX_ITEMS = 200;
export const ARCHIVE_MAX_DAYS = 30;
const DAY_MS = 86_400_000;

/** The archive's own key for one follow: "phrase:<id>" or "story:<id>", the same
 * `kind:id` shape following.js's own follow objects and the page hrefs already use. */
export function archiveKey(kind, id) {
  return `${kind}:${id}`;
}

/** One card snapshot for a match, from a ranker.js story record and a coverage.js
 * context (coverageContext(input, {muted})): id, title, outlet, time, markers (lean and
 * country, for the same lean.js marker the front page and the coverage sheet draw), and
 * url. The representative article is the story's lowest article id, deterministic and
 * content-independent, the same choice coverage.js's own row grouping makes for a
 * near-duplicate group's primary row. */
export function snapshotFromStory(story, ctx) {
  const ids = [...(story.article_ids || [])].sort();
  const primary = ids[0];
  const article = primary !== undefined ? ctx.articleById.get(primary) : null;
  const extra = (primary !== undefined && ctx.coverage?.[primary]) || {};
  const sourceId = article?.source_id;
  return {
    id: story.id,
    title: (story.titles && story.titles[0]) || article?.title || "",
    outlet: (sourceId && ctx.names?.[sourceId]) || sourceId || "",
    time: new Date(story.latest_ms).toISOString(),
    markers: {
      lean: (sourceId && ctx.leans?.[sourceId]) || "",
      country: (sourceId && ctx.countries?.[sourceId]) || "",
    },
    url: extra.url || "",
  };
}

/** `records`, newest first, older than `maxDays` dropped, then capped to `maxItems`. A
 * record with an unparsable `time` is dropped rather than kept forever. */
export function pruneFollowArchive(records, nowMs, { maxItems = ARCHIVE_MAX_ITEMS, maxDays = ARCHIVE_MAX_DAYS } = {}) {
  const cutoff = nowMs - maxDays * DAY_MS;
  const kept = (records || []).filter((r) => {
    const t = Date.parse(r?.time);
    return Number.isFinite(t) && t >= cutoff;
  });
  kept.sort((a, b) => (b.time > a.time ? 1 : b.time < a.time ? -1 : 0));
  return kept.slice(0, maxItems);
}

/** `existing` plus `incoming`, deduplicated by id (a story matched again keeps its
 * newest snapshot, since the same id can be seen on more than one rank in a row), then
 * pruned. Pure, so a test never needs a store. */
export function mergeFollowArchive(existing, incoming, nowMs, opts) {
  const byId = new Map((existing || []).map((r) => [r.id, r]));
  for (const rec of incoming || []) byId.set(rec.id, rec);
  return pruneFollowArchive([...byId.values()], nowMs, opts);
}

/** Records every current match for every follow, once per device rank. `store` is
 * follow-archive-store.js's followArchiveStore ({get(key), put(key, items)}) or a plain
 * stand-in in tests. Never throws: a follow whose read or write fails is skipped, since
 * the live "Stories now" list already works without this, and one follow's storage
 * trouble should never stop another's from being recorded. */
export async function recordFollowArchive(store, input, profile, nowMs) {
  if (!input?.pool) return;
  let follows;
  try {
    follows = followMatches(input, profile);
  } catch {
    return;
  }
  const ctx = coverageContext(input, { muted: profile?.mutes?.sources || [] });
  for (const follow of follows) {
    const key = archiveKey(follow.kind, follow.id);
    const incoming = follow.stories.map((s) => snapshotFromStory(s, ctx));
    try {
      const record = await store.get(key);
      const existing = Array.isArray(record?.items) ? record.items : [];
      const merged = mergeFollowArchive(existing, incoming, nowMs);
      await store.put(key, merged);
    } catch {
      // Storage blocked, full, or unavailable: skip this follow, try the rest.
    }
  }
}
