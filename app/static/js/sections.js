// S27: the section tabs (R21) as one mapping table. Every tab is the same ranked pool
// filtered to its section, in ranked order, with the same tiers and hero rules; only
// Today takes everything. A story belongs to a section when any member article carries
// one of the section's pool topic tags, or comes from a source in one of its source
// buckets (sources.json, repo owned). So US Politics works either way: the fetcher's
// US-specific `us_politics` tag when an article has it, the source bucket otherwise.
// G1: Singapore and Asia are geography, not outlets. They take a story when any member
// article's own title or dek names the region (the pool's per-article `geo` tags,
// fetcher/geo.py), never from the source bucket, so a Singapore outlet's White House
// story stays out of Singapore. Asia holds every Singapore story too (sg implies asia).
// Pure: the build runs it under Node (app/rank_cli.mjs) and the device runs it on the
// page's own embedded input (tabs.js), so both sides filter the same way.
//
// `slot: "live"` is the dynamic slot (R21, R22). S27 renders it hidden; S33 fills the
// panel and shows the tab only while an event is live.

export const SECTIONS = Object.freeze([
  { id: "today", label: "Today", all: true },
  { id: "live", label: "Live", slot: "live" },
  { id: "us-politics", label: "US Politics", tags: ["us_politics"], buckets: ["us_politics"] },
  { id: "world", label: "World", tags: ["world"], buckets: ["general", "israel_gaza", "sudan"] },
  { id: "singapore", label: "Singapore", geo: ["sg"] },
  { id: "asia", label: "Asia", geo: ["asia"] },
  { id: "ai", label: "AI", tags: ["ai"], buckets: ["ai"] },
  { id: "biotech", label: "Biotech", tags: ["biotech"], buckets: ["biotech"] },
].map((s) => Object.freeze(s)));

/** {source_id: bucket} from sources.json's sources array. */
export function bucketMap(sources) {
  return Object.fromEntries((sources || []).filter((s) => s && s.id && s.bucket).map((s) => [s.id, s.bucket]));
}

/** Whether a story ({topics, geo, source_ids}, as ranker.js storiesFromPool builds it)
 * belongs to a section. A slot section holds nothing until its own slice fills it. */
export function inSection(story, section, buckets) {
  if (section.all) return true;
  if (section.slot) return false;
  const tags = section.tags || [];
  const wanted = section.buckets || [];
  const geo = section.geo || [];
  return (story.topics || []).some((t) => tags.includes(t))
    || (story.geo || []).some((g) => geo.includes(g))
    || (story.source_ids || []).some((id) => Object.hasOwn(buckets || {}, id) && wanted.includes(buckets[id]));
}

/** The section's story ids in the given ranked order. `ranked` is ranker.js rank()
 * output (or any list of stories with id, topics and source_ids), best first. */
export function sectionIds(ranked, section, buckets) {
  return ranked.filter((story) => inSection(story, section, buckets)).map((story) => story.id);
}

/** Every section's ids in ranked order: [{id, label, slot, ids}]. */
export function sectionLists(ranked, buckets) {
  return SECTIONS.map((s) => ({ id: s.id, label: s.label, slot: s.slot || null, ids: sectionIds(ranked, s, buckets) }));
}
