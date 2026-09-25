// S14: the coverage view's pure grouping logic (DESIGN-v1 section 6, DESIGN-v1.1
// section 5, R13: real headlines side by side, never an AI summary). Node-testable
// without a page: given one cluster and the page's own embedded facts about its
// articles and sources, buildCoverage() is a deterministic function of that data alone,
// the same "pure given its input" shape as actions/context.js's storyAttributes.
//
// Every article in the cluster ends up exactly once: as its own row, or listed under
// some other row's "also carried by" (a near-duplicate group, S07's syndicated-copy
// marking, collapses to the one row with the lowest article id; the rest are "also
// carried by"). Rows group by lean bucket in this fixed order (fetcher/taxonomy.py
// LEAN_BUCKETS, the one place that order is defined), skipping any bucket with no row.
export const LEAN_ORDER = Object.freeze([
  "left", "center-left", "center", "center-right", "right", "state", "non-us",
]);

// Plain words for a lean bucket heading (R34: no jargon, no AI text). "state" and
// "non-us" are taxonomy.py's own escape hatches for outlets a US left-right frame does
// not fit; their per-outlet ownership label (state-owned, state-funded, and so on)
// carries the specific fact, so the group heading here only needs to read plainly.
export const LEAN_LABELS = Object.freeze({
  "left": "Left",
  "center-left": "Center-left",
  "center": "Center",
  "center-right": "Center-right",
  "right": "Right",
  "state": "State-affiliated",
  "non-us": "International",
});
const FALLBACK_LEAN = "non-us";

function articleFacts(id, ctx) {
  const article = ctx.articleById.get(id);
  if (!article) return null;
  const extra = ctx.coverage?.[id] || {};
  return {
    id,
    source_id: article.source_id,
    sourceName: ctx.names?.[article.source_id] || article.source_id || "",
    ownership: ctx.ownership?.[article.source_id] || "",
    lean: ctx.leans?.[article.source_id] || FALLBACK_LEAN,
    country: ctx.countries?.[article.source_id] || "",
    headline: article.title || "",
    publishedAt: article.published_at || "",
    url: extra.url || "",
    hasBody: Boolean(extra.has_body),
  };
}

/** {article_id: group index} for every id inside a near_duplicates group, S07's
 * syndicated-copy marking (one piece of wire copy, carried by more than one outlet). */
function groupIndexOf(nearDuplicates) {
  const of = new Map();
  (nearDuplicates || []).forEach((group, index) => {
    for (const id of group) of.set(id, index);
  });
  return of;
}

/** One row per near-duplicate group (its lowest article id is the row, deterministic
 * and content-independent) plus one row per article outside any group. A muted outlet's
 * article never forms or joins a row (H6 item 3: the sheet shows the same outlets the
 * row's "N sources" and V1's carousel count, so a mute never leaves it over-counted). */
function buildRows(cluster, ctx) {
  const muted = ctx.muted || new Set();
  const groupOf = groupIndexOf(cluster.near_duplicates);
  const groups = new Map(); // index -> ids[]
  const singles = [];
  for (const id of cluster.article_ids) {
    const article = ctx.articleById.get(id);
    if (article && muted.has(article.source_id)) continue;
    const g = groupOf.get(id);
    if (g === undefined) { singles.push(id); continue; }
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(id);
  }
  const rows = [];
  for (const ids of groups.values()) {
    const sorted = [...ids].sort();
    const primary = articleFacts(sorted[0], ctx);
    if (!primary) continue;
    const also = sorted.slice(1).map((id) => articleFacts(id, ctx)).filter(Boolean)
      .map((a) => ({ id: a.id, sourceName: a.sourceName }))
      .sort((a, b) => a.sourceName.localeCompare(b.sourceName) || a.id.localeCompare(b.id));
    rows.push({ ...primary, also });
  }
  for (const id of singles) {
    const facts = articleFacts(id, ctx);
    if (facts) rows.push({ ...facts, also: [] });
  }
  return rows;
}

/** Newest first within a lean group, ties broken by article id so the order never
 * depends on anything but the cluster's own data. ISO 8601 'Z' timestamps sort
 * correctly as plain strings, so no date parsing is needed. */
function rowOrder(a, b) {
  if (a.publishedAt !== b.publishedAt) return a.publishedAt > b.publishedAt ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** Distinct unmuted outlets that carried the story in any form, syndicated copies
 * included (the larger of the sheet's two numbers; "independent" below is the one that
 * folds a wire-copy group to one). */
function outletCount(cluster, ctx) {
  const muted = ctx.muted || new Set();
  const ids = new Set();
  for (const aid of cluster.article_ids) {
    const article = ctx.articleById.get(aid);
    if (article && !muted.has(article.source_id)) ids.add(article.source_id);
  }
  return ids.size;
}

/** Distinct unmuted outlets, a near-duplicate group (syndicated copies of one piece)
 * folded to one voice and one outlet counted once however many pieces it ran. The one
 * definition of "independent" (H6 item 3), shared with the row's "N sources"
 * (app/frontpage.py visible_source_count) and V1's carousel (versions.js buildVersions,
 * js/tiers.js visibleSourceCount): the same wire-copy story never shows a different
 * count in different places. Never reads the cluster's own `independent_sources` field,
 * which fanout.py sets from a fetch-time syndication table, not this cluster's own
 * detected duplicates, and is never mute-aware. */
function independentCount(cluster, ctx) {
  const muted = ctx.muted || new Set();
  const groupOf = groupIndexOf(cluster.near_duplicates);
  const units = new Set();
  for (const id of cluster.article_ids) {
    const article = ctx.articleById.get(id);
    if (!article || muted.has(article.source_id)) continue;
    const group = groupOf.get(id);
    units.add(group !== undefined ? `g${group}` : `s${article.source_id}`);
  }
  return units.size;
}

/** {summary: {outlets, independent, leans, text}, groups: [{bucket, label, rows}]} for
 * one cluster. Plain numbers only (R13): "N outlets, M independent, across K leans". */
export function buildCoverage(cluster, ctx) {
  const rows = buildRows(cluster, ctx);
  const byBucket = new Map();
  for (const row of rows) {
    const bucket = LEAN_ORDER.includes(row.lean) ? row.lean : FALLBACK_LEAN;
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket).push(row);
  }
  const groups = LEAN_ORDER
    .filter((bucket) => byBucket.has(bucket))
    .map((bucket) => ({ bucket, label: LEAN_LABELS[bucket], rows: [...byBucket.get(bucket)].sort(rowOrder) }));
  const outlets = outletCount(cluster, ctx);
  const independent = independentCount(cluster, ctx);
  const leans = (cluster.lean_buckets || []).length;
  const leanWord = leans === 1 ? "lean" : "leans";
  return {
    summary: { outlets, independent, leans, text: `${outlets} outlets, ${independent} independent, across ${leans} ${leanWord}` },
    groups,
  };
}

/** The page's own embedded facts, shaped for buildCoverage: input is the parsed
 * #rank-input JSON (app/build.py _rank_input_json). `muted` is the viewer's
 * profile.mutes.sources (H6 item 3), an array or Set; the shipped default has none. */
export function coverageContext(input, { muted = [] } = {}) {
  return {
    articleById: new Map((input.pool?.articles || []).map((a) => [a.id, a])),
    names: input.names || {},
    leans: input.leans || {},
    ownership: input.ownership || {},
    countries: input.countries || {},
    coverage: input.coverage || {},
    muted: new Set(muted),
  };
}
