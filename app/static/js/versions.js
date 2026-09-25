// V1 (B6 built early, docs/DESIGN-bundles.md section 5): the story versions carousel's
// pure logic. Given one cluster and the page's own embedded facts (#rank-input), it
// decides which versions the carousel shows, in what order, what folds into each slide,
// and which headline words are marked. No DOM, no storage, no clock: Node tests import
// it unchanged (tests/js/versions.test.js), and versions-view.js draws what it returns.
//
// A version is one voice on the story. The units are the row's own "N sources" count
// (app/frontpage.py independent_source_count): each S07 near-duplicate group (one piece
// of syndicated copy) is one version, with the other outlets that ran it listed as
// "Also carried by"; every other outlet is one version, its further pieces listed as
// "More from this outlet". When an outlet leads a syndicated group and also ran its own
// piece, the two share its one slide, so no outlet ever shows twice. A muted source
// (profile mutes.sources) never appears anywhere and is never counted.
//
// Order: the lead version first (the row's own article, the one the row opens), then
// the others by the best-version score (B8, DESIGN-bundles section 4a): the sum of the
// cron's fact terms, published per article as `bv` and embedded by the build, plus the
// device's trust term (trustTerm, B5's seam, 0 until then). Ties go to the higher sum
// without trust, then the earlier report, then source id and article id. A version the
// cron did not score (no `bv`) sums to 0. orderVersions is the one place that order is
// decided. Lean is never an input, nor is any source's provenance (R40).
//
// Word marks (section 5, R40 answer 8): on bundles of 3 or more versions, the content
// words of a version's headline that appear in no other version's headline, stopwords
// dropped and plural s folded. Nothing is generated and nothing is scored as biased; no
// AI text anywhere (R13). markSegments only splits the headline's own text, and the view
// sets every piece with textContent (R26).
import { smartQuotes } from "./reader/core.js";

export const MIN_MARK_VERSIONS = 3;
// fetcher/best_version.py TERMS: the order of an article's `bv` array.
export const BV_TERMS = Object.freeze(["original", "complete", "depth", "headline", "locality", "first", "health", "paywall"]);

const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const epochMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** The page's own embedded facts, shaped for buildVersions. `input` is the parsed
 * #rank-input JSON (app/build.py _rank_input_json): the compact pool, names, leans,
 * countries and ownership (L1, U3, S14), each member's url and has_body (S14's
 * `coverage`) and its fitted dek (`vdeks`, V1). `locality` is B4's seam: when the pool
 * carries each article's tier (local, intermediate, overseas), the build embeds it here
 * and every slide shows it; until then it is empty and slides show none. `bv` is B8's:
 * {article_id: the eight best-version fact terms} for the same carousel members. */
export function versionsContext(input) {
  return {
    articleById: new Map((input?.pool?.articles || []).map((a) => [a.id, a])),
    clusters: new Map((input?.pool?.clusters || []).map((c) => [c.id, c])),
    names: input?.names || {},
    leans: input?.leans || {},
    countries: input?.countries || {},
    ownership: input?.ownership || {},
    links: input?.coverage || {},
    deks: input?.vdeks || {},
    locality: input?.locality || {},
    bv: input?.bv || {},
  };
}

// B4 hook: plain words for a slide's locality tier (section 4). "intermediate" reads as
// "Regional" on the slide, as the design doc's own examples do.
export const LOCALITY_WORDS = Object.freeze({ local: "Local", intermediate: "Regional", overseas: "Overseas" });

/** The slide's tier label ("Local", "Regional", "Overseas") for an article, or "" while
 * the pool carries no tier (B4 not built). One function, so B4 changes nothing else. */
export function localityLabel(articleId, ctx) {
  const tier = ctx?.locality?.[articleId];
  return typeof tier === "string" && Object.hasOwn(LOCALITY_WORDS, tier) ? LOCALITY_WORDS[tier] : "";
}

function facts(id, ctx) {
  const article = ctx.articleById.get(id);
  if (!article) return null;
  const link = ctx.links[id] || {};
  const sourceId = article.source_id || "";
  return {
    id,
    sourceId,
    sourceName: ctx.names[sourceId] || sourceId,
    lean: ctx.leans[sourceId] || null,
    country: ctx.countries[sourceId] || null,
    ownership: ctx.ownership[sourceId] || "",
    headline: smartQuotes(article.title || ""),
    dek: typeof ctx.deks[id] === "string" ? ctx.deks[id] : "",
    publishedAt: article.published_at || "",
    url: typeof link.url === "string" ? link.url : "",
    hasBody: link.has_body === true,
    locality: localityLabel(id, ctx),
    bv: bvOf(id, ctx),
  };
}

/** The article's eight fact terms from the page, or null when the cron scored none. */
export function bvOf(articleId, ctx) {
  const bv = ctx?.bv?.[articleId];
  return Array.isArray(bv) && bv.length === BV_TERMS.length && bv.every(Number.isInteger) ? bv : null;
}

/**
 * B5's seam: section 4a's ninth term, the owner's trust in the version's outlet, added
 * on the device to the cron's base sum. Until B5 lands it adds nothing, whatever the
 * profile says; B5 makes it (trust - 1) x base, floored at 0, and nothing else here
 * changes.
 */
export function trustTerm(_version, _base, _trust = {}) {
  return 0;
}

/** One version's best-version score: `base`, the sum of its fact terms (0 when the
 * cron scored none), `trust`, the device's term, and `score`, their sum. */
export function versionScore(version, { trust = {} } = {}) {
  const base = (version?.bv || []).reduce((sum, term) => sum + term, 0);
  const t = trustTerm(version, base, trust);
  return { base, trust: t, score: base + t };
}

/**
 * The one ordering of versions: the lead first, then the higher best-version score,
 * then the higher sum without trust, then the earlier report, then source id and
 * article id, so the order never depends on input order. `nowMs` is accepted for the
 * callers' sake and read by nothing: no term depends on the clock.
 */
export function orderVersions(versions, { leadId = null, trust = {} } = {}) {
  const scored = versions.map((v) => ({ v, s: versionScore(v, { trust }) }));
  scored.sort((a, b) => {
    if (a.v.id === leadId) return -1;
    if (b.v.id === leadId) return 1;
    return b.s.score - a.s.score || b.s.base - a.s.base || epochMs(a.v.publishedAt) - epochMs(b.v.publishedAt)
      || byStr(a.v.sourceId, b.v.sourceId) || byStr(a.v.id, b.v.id);
  });
  return scored.map((x) => x.v);
}

/**
 * The carousel's slides for `cluster`: [{...face facts, also: [{id, sourceName}],
 * more: [facts]}], in orderVersions order. `leadId` is the row's own article (the
 * cluster's `lead`); `muted` the profile's mutes.sources; `trust` its trust map.
 */
export function buildVersions(cluster, ctx, { leadId = null, muted = [], trust = {}, nowMs = 0 } = {}) {
  if (!cluster) return [];
  const off = new Set(muted || []);
  const members = [...new Set(cluster.article_ids || [])].map((id) => facts(id, ctx))
    .filter((a) => a && !off.has(a.sourceId));
  const opts = { leadId, trust, nowMs };
  const present = new Set(members.map((a) => a.id));
  const groupOf = new Map();
  (cluster.near_duplicates || []).forEach((group, index) => {
    for (const id of group) if (present.has(id) && !groupOf.has(id)) groupOf.set(id, index);
  });
  const groups = new Map();
  const bySource = new Map();
  for (const a of members) {
    const g = groupOf.get(a.id);
    const [map, key] = g === undefined ? [bySource, a.sourceId] : [groups, g];
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }
  const slides = [];
  const slideOfSource = new Map();
  for (const list of groups.values()) {
    const [face] = orderVersions(list, opts);
    const also = [];
    const seen = new Set([face.sourceId]);
    for (const a of [...list].sort((x, y) => byStr(x.sourceName, y.sourceName) || byStr(x.id, y.id))) {
      if (seen.has(a.sourceId)) continue;
      seen.add(a.sourceId);
      also.push({ id: a.id, sourceId: a.sourceId, sourceName: a.sourceName });
    }
    const slide = { ...face, also, more: [] };
    slides.push(slide);
    if (!slideOfSource.has(face.sourceId)) slideOfSource.set(face.sourceId, slide);
  }
  for (const [sourceId, list] of bySource) {
    const ordered = orderVersions(list, opts);
    const home = slideOfSource.get(sourceId);
    if (home) {
      home.more = orderVersions([...home.more, ...ordered], { ...opts, leadId: null });
      continue;
    }
    const [face, ...rest] = ordered;
    slides.push({ ...face, also: [], more: rest });
  }
  // A lead folded into another slide's "more" still leads: its slide goes first.
  const leadSlide = slides.find((s) => s.id === leadId || s.more.some((m) => m.id === leadId));
  return orderVersions(slides, { ...opts, leadId: leadSlide ? leadSlide.id : null });
}

// --- Word marks ---------------------------------------------------------------------

// Function words and the headline verbs of attribution, which say nothing about how an
// outlet framed the story. Lower case, apostrophes dropped.
export const STOPWORDS = new Set(`
a about above after again against ago all also am amid an and any are as at be been before being below between
both but by can could did do does doing done down during each few for from further had has have having he her here
hers him his how i if in into is it its itself just me more most my new no nor not now of off on once only or other
our ours out over own same she should so some such than that the their theirs them then there these they this those
through to too under until up upon very via vs was we were what when where which while who whom whose why will with
would yet you your yours says said say saying tells told
`.trim().split(/\s+/));

// A number keeps its thousands and decimal separators and any unit run into it ("1.2tn",
// "10th"); a word keeps its apostrophes.
const TOKEN = /\p{N}+(?:[.,]\p{N}+)*\p{L}*|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** The comparison key for one headline word, or null for a stopword or a lone letter:
 * lower case, curly apostrophes folded, a possessive 's dropped, and a plural s folded
 * ("talks" and "talk" match, as do "parties" and "party"). */
export function wordKey(word) {
  if (typeof word !== "string" || !word) return null;
  let w = word.toLowerCase().replace(/’/g, "'");
  if (/^\p{N}/u.test(w)) return w.replace(/,/g, "");
  w = w.replace(/'s$/, "").replace(/'/g, "");
  if (w.length < 2 || STOPWORDS.has(w)) return null;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return w;
}

function keysOf(headline) {
  const keys = new Set();
  for (const m of String(headline || "").matchAll(TOKEN)) {
    const k = wordKey(m[0]);
    if (k) keys.add(k);
  }
  return keys;
}

/** For each headline, the keys found in no other headline; null for every headline
 * when there are fewer than MIN_MARK_VERSIONS (short bundles overstate differences). */
export function uniqueWords(headlines) {
  if (!Array.isArray(headlines) || headlines.length < MIN_MARK_VERSIONS) return headlines.map(() => null);
  const sets = headlines.map(keysOf);
  const count = new Map();
  for (const set of sets) for (const k of set) count.set(k, (count.get(k) || 0) + 1);
  return sets.map((set) => new Set([...set].filter((k) => count.get(k) === 1)));
}

/** The headline as [{text, mark}] pieces whose texts join back to it exactly: every
 * word whose key is in `unique` is marked, and marked words with only a space between
 * them join into one piece, so an underline runs unbroken across a phrase. */
export function markSegments(headline, unique) {
  const text = String(headline || "");
  if (!unique || !unique.size) return text ? [{ text, mark: false }] : [];
  const out = [];
  const push = (piece, mark) => {
    if (!piece) return;
    const last = out[out.length - 1];
    if (last && last.mark === mark) last.text += piece;
    else out.push({ text: piece, mark });
  };
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    const gap = text.slice(at, m.index);
    const mark = unique.has(wordKey(m[0]));
    const last = out[out.length - 1];
    if (mark && last?.mark && /^ +$/.test(gap)) push(gap, true);
    else push(gap, false);
    push(m[0], mark);
    at = m.index + m[0].length;
  }
  push(text.slice(at), false);
  return out;
}

// --- The one profile setting (R40 answer 8: on unless turned off) -------------------

/** Word marks are on unless the profile's display.word_marks is false; an absent field
 * reads as on, so no older profile needs a migration. */
export function wordMarksOn(profile) {
  return profile?.display?.word_marks !== false;
}

/** The next profile draft with word marks `on`, or null when nothing changes. */
export function withWordMarks(profile, on) {
  if (typeof on !== "boolean" || wordMarksOn(profile) === on) return null;
  return { ...profile, display: { ...(profile.display || {}), word_marks: on } };
}
