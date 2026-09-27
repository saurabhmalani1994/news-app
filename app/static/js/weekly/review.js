// S29: the weekly review (DESIGN-v1.1 section 5, R20: "counts over the week produce
// capped, owner-approved deltas without a model call"). A pure, deterministic function
// of the device's own history, thumbs, profile and a clock it is told: no Date.now, no
// storage, no network, no randomness, and every list is sorted by a total order, so the
// same history in always gives the same proposals out. It works with AI off; nothing
// here calls a model.
//
// Signals, all already on the device:
//   shown   history/store.js's `shown` store (S15, R17): a card on screen about 1s.
//           This is the impression record; it already carries each story's topics and
//           source id, so no new store was needed.
//   opened  history/store.js's `opened` store (S15/S34).
//   thumbs  actions/store.js's `thumbs` store (S24, R19: a thumb never moves a weight
//           by itself; this review is the only place it is counted, and only an Accept
//           applies anything).
//
// Attributes: topic (the ranker's own tag to profile-topic mapping), source (outlet
// id), lean and country (from the source catalog). Of these only two have a ranker
// weight the S19 gate lets a proposal touch: a topic's affinity and a source boost's
// amount (ranker.js; gate.js AI_WRITABLE). Lean and country carry no weight by design
// (the lean quota and exploration are owner only), and a topic that is not one of the
// owner's interests has no affinity to move, so a pattern pointing at one of those is
// reported as "noticed", never proposed. seen_penalty and half-lives are ranker weights
// too, but no per-attribute pattern points at them, so this review leaves them alone.
//
// Research section 6's feedback loop is the risk this file exists to contain. Guards:
//   - batched weekly, never per click; at most MAX_PER_WEEK accepted changes a week;
//   - every delta is a small step inside the gate's own cap, and every proposal is run
//     through gate.js's gateProposal, the same gate an AI proposal passes;
//   - never lowers a topic below Less (the owner turns things Off, the review does not);
//   - a pattern needs a sample floor and an effect size, so a topic that was rarely
//     shown never qualifies for lowering on its open rate: rarely shown is not evidence;
//   - when S16's breadth is falling, every proposal that would narrow reading (any
//     lowering, or raising the week's top topic) is held back, not shown;
//   - never proposes on must-know, standing stories (their tags and source buckets
//     included), exploration, mutes, or a topic that is Off.

import { gateProposal, AI_WRITABLE } from "../ai/gate.js";
import { TAG_TO_TOPIC } from "../ranker.js";
import { weekOverWeek } from "../breadth/math.js";
import { levelForAffinity, levelWord, affinityForLevel, isPhraseTopic } from "../profile/you-edits.js";

export const DAY_MS = 86_400_000;
export const WINDOW_MS = 7 * DAY_MS;

// Sample floor: an attribute needs at least this many stories shown in the week before
// its open rate counts. Eight is about one a day plus one; below it a single open
// swings the rate by more than 12 points, which is noise, not a pattern.
export const SAMPLE_FLOOR = 8;

// Effect size: the attribute's open rate must differ from the rest of the week's by at
// least 25 percentage points. A reader who opens 30% of everything and 55% of AI is
// showing a preference; 30% against 40% is within what one busy morning explains.
export const MIN_LIFT = 0.25;

// Thumbs are deliberate, so fewer of them count: a net balance of three (three up and
// none down, or four and one) is a stated preference on its own, provided the open rate
// does not point the other way.
export const THUMBS_FLOOR = 3;

// At most this many accepted changes per week. Five is enough to follow a real shift
// (a new beat, a source gone bad) and small enough that one week can never re-tune the
// whole profile; with steps of 0.1 the week's largest possible swing on any one topic is
// a single step, since a path is proposed at most once a week.
export const MAX_PER_WEEK = 5;

// Step sizes: the gate's own affinity cap (0.1, one tenth of the 0 to 1 range), and
// half the boost cap for boosts, so the review's boost moves are smaller than an AI
// proposal's could be.
export const AFFINITY_STEP = AI_WRITABLE["$.topics.*.affinity"].cap;
export const BOOST_STEP = AI_WRITABLE["$.boosts[*].amount"].cap / 2;

// The review never lowers an interest below Less; switching one off is the owner's.
export const AFFINITY_FLOOR = affinityForLevel("less");

const MUST_KNOW = "must_know";
const LEAN_WORDS = Object.freeze({
  left: "left", "center-left": "center-left", center: "center", "center-right": "center-right",
  right: "right", state: "state media",
});

const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round = (x, places = 2) => Math.round(x * 10 ** places) / 10 ** places;
const epochMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
};
/** Profile labels are the owner's text, catalog names the repo's; either way the
 * rationale schema forbids markup and control characters, so they are dropped here. */
const clean = (text) => String(text ?? "").replace(/[<>\u0000-\u001F\u007F]/g, "").trim();
const pct = (x) => `${Math.round(x * 100)}%`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2026W39": the ISO week (Monday start, UTC) of `nowMs`. Decisions are kept per week. */
export function weekKey(nowMs) {
  const d = new Date(nowMs);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1Thursday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS + 3 * DAY_MS;
  const week = 1 + Math.round((thursday - week1Thursday) / (7 * DAY_MS));
  return `${year}W${String(week).padStart(2, "0")}`;
}

/** The profile topic a pool tag counts toward, the ranker's own rule (matchedTopics):
 * the tag itself when it is a profile topic, else its TAG_TO_TOPIC bucket, else the
 * bare tag (a topic the owner does not follow, still worth noticing). */
export function topicFor(tag, profile) {
  const topics = profile.topics || {};
  if (Object.hasOwn(topics, tag)) return tag;
  const mapped = TAG_TO_TOPIC[tag];
  return mapped && Object.hasOwn(topics, mapped) ? mapped : tag;
}

/** Attribute keys ("topic:ai", "source:reuters", "lean:left", "country:SG") for one
 * record, deduplicated and sorted. `catalog` maps source id to {lean, country}. */
export function attributeKeys(record, profile, catalog) {
  const keys = new Set();
  for (const tag of Array.isArray(record.topics) ? record.topics : []) {
    if (typeof tag === "string" && tag) keys.add(`topic:${topicFor(tag, profile)}`);
  }
  const sid = record.source_id || record.source || null;
  if (typeof sid === "string" && sid && Object.hasOwn(catalog, sid)) {
    keys.add(`source:${sid}`);
    const { lean, country } = catalog[sid] || {};
    const recordLean = record.lean || lean;
    if (recordLean && Object.hasOwn(LEAN_WORDS, recordLean)) keys.add(`lean:${recordLean}`);
    if (country) keys.add(`country:${country}`);
  }
  return [...keys].sort(byStr);
}

const inWindow = (records, startMs, endMs) => (records || []).filter((r) => {
  const t = epochMs(r && r.time);
  return r && typeof r.id === "string" && Number.isFinite(t) && t >= startMs && t < endMs;
});

/**
 * The week's counts: every story shown or opened in the 7 days before `nowMs` counts
 * once as shown (an open implies it was in front of the reader, even from search), and
 * once as opened if it was opened in the window. Thumbs in the window add up/down.
 * Returns {total: {shown, opened}, attributes: Map<key, {shown, opened, up, down}>}.
 */
export function aggregate({ opened, shown, thumbs, profile, catalog = {}, nowMs }) {
  const start = nowMs - WINDOW_MS;
  const openedIn = inWindow(opened, start, nowMs);
  const shownIn = inWindow(shown, start, nowMs);
  const openedIds = new Set(openedIn.map((r) => r.id));
  const stories = new Map();
  // Shown first, then opened, both in id order: the opened record wins as the
  // attribute source for a story in both, and the result never depends on input order.
  for (const r of [...shownIn].sort((a, b) => byStr(a.id, b.id))) stories.set(r.id, r);
  for (const r of [...openedIn].sort((a, b) => byStr(a.id, b.id))) stories.set(r.id, r);

  const attributes = new Map();
  const slot = (key) => {
    if (!attributes.has(key)) attributes.set(key, { shown: 0, opened: 0, up: 0, down: 0 });
    return attributes.get(key);
  };
  for (const [id, record] of stories) {
    for (const key of attributeKeys(record, profile, catalog)) {
      const s = slot(key);
      s.shown += 1;
      if (openedIds.has(id)) s.opened += 1;
    }
  }
  for (const thumb of inWindow(thumbs, start, nowMs)) {
    if (thumb.direction !== "up" && thumb.direction !== "down") continue;
    for (const key of attributeKeys(thumb, profile, catalog)) slot(key)[thumb.direction] += 1;
  }
  const sorted = new Map([...attributes.entries()].sort((a, b) => byStr(a[0], b[0])));
  return { total: { shown: stories.size, opened: openedIds.size }, attributes: sorted };
}

/**
 * Whether one attribute's week clears the evidence bar, and which way.
 * Open-rate evidence: at least SAMPLE_FLOOR shown, at least SAMPLE_FLOOR shown in the
 * rest of the week (the baseline needs a sample too), and |rate - rest rate| >= MIN_LIFT.
 * The baseline is the rest of the week, not all of it, so a dominant attribute is not
 * compared mostly with itself. Thumbs evidence: net balance of THUMBS_FLOOR or more.
 * The two must not disagree: a thumbs-up pattern with a below-baseline open rate is
 * mixed evidence and proposes nothing. Returns null or {direction, lift, rate,
 * restRate, net, strength, byRate}.
 */
export function evidence(stats, total) {
  const net = stats.up - stats.down;
  const restShown = total.shown - stats.shown;
  const rateReady = stats.shown >= SAMPLE_FLOOR && restShown >= SAMPLE_FLOOR;
  const rate = stats.shown ? stats.opened / stats.shown : 0;
  const restRate = restShown > 0 ? (total.opened - stats.opened) / restShown : 0;
  const lift = rateReady ? rate - restRate : 0;
  const rateUp = rateReady && lift >= MIN_LIFT - 1e-9;
  const rateDown = rateReady && lift <= -MIN_LIFT + 1e-9;
  const thumbsUp = net >= THUMBS_FLOOR;
  const thumbsDown = net <= -THUMBS_FLOOR;
  let direction = null;
  if ((rateUp && net >= 0) || (thumbsUp && lift >= 0)) direction = "up";
  else if ((rateDown && net <= 0) || (thumbsDown && lift <= 0)) direction = "down";
  if (!direction) return null;
  // Ranking only (which proposals fill the week's slots): the rate gap weighted by the
  // square root of its sample, plus the thumbs balance. No threshold depends on it.
  const strength = round(Math.abs(lift) * Math.sqrt(stats.shown) + Math.abs(net) * 0.5, 6);
  return { direction, lift, rate, restRate, net, strength, byRate: rateUp || rateDown };
}

function standingGuards(profile) {
  const tags = new Set();
  const buckets = new Set();
  for (const s of profile.standing_stories || []) {
    if (!s) continue;
    for (const t of s.tags || []) tags.add(t);
    for (const b of s.buckets || []) buckets.add(b);
  }
  return { tags, buckets };
}

/** The attribute's display noun and its plain name. */
function describe(kind, value, profile, catalog) {
  if (kind === "topic") {
    const t = profile.topics?.[value];
    const name = clean(t ? (isPhraseTopic(t) ? t.phrase : t.label) : value.replace(/_/g, " ")) || value;
    return { name, noun: `${name} stories` };
  }
  if (kind === "source") {
    const name = clean(catalog[value]?.name) || value;
    return { name, noun: `stories from ${name}` };
  }
  if (kind === "lean") {
    const name = LEAN_WORDS[value] || value;
    return { name, noun: `stories from ${name} outlets` };
  }
  return { name: value, noun: `stories from ${value} outlets` };
}

function evidenceClause(stats, ev, noun) {
  const thumbs = stats.up || stats.down ? `${plural(stats.up, "thumb")} up and ${stats.down} down` : "";
  if (ev.byRate) {
    const base = `You opened ${stats.opened} of ${stats.shown} ${noun} shown, against ${pct(ev.restRate)} of the rest`;
    return thumbs ? `${base}, with ${thumbs}` : base;
  }
  return `You gave ${noun} ${thumbs}`;
}

/** The change a pattern points at, or {none: reason} when it points at nothing the
 * review may touch. */
function target(kind, value, direction, profile, catalog, guards) {
  if (kind === "topic") {
    if (value === MUST_KNOW) return { skip: "must_know" };
    const t = profile.topics?.[value];
    if (!t) return { none: "Not one of your interests, so there is nothing to change. Add it on You to follow it." };
    if (t.enabled === false) return { skip: "off" };
    if ((profile.mutes?.topics || []).includes(value)) return { skip: "muted" };
    if (direction === "down" && guards.tags.has(value)) return { skip: "standing" };
    const old = t.affinity;
    const next = direction === "up"
      ? round(Math.min(1, old + AFFINITY_STEP))
      : round(Math.max(AFFINITY_FLOOR, old - AFFINITY_STEP));
    if (next === old || (direction === "down" && old <= AFFINITY_FLOOR)) return { skip: "at_limit" };
    return { path: `$.topics.${value}.affinity`, old, next, field: "affinity" };
  }
  if (kind === "source") {
    if ((profile.mutes?.sources || []).includes(value)) return { skip: "muted" };
    if (guards.buckets.has(catalog[value]?.bucket)) return { skip: "standing" };
    const boost = [...(profile.boosts || [])].sort((a, b) => byStr(a.id, b.id))
      .find((b) => b.match_type === "source" && b.match_value === value);
    if (!boost) return { none: "There is no boost for this outlet to adjust." };
    const old = boost.amount;
    const next = round(Math.max(-1, Math.min(1, old + (direction === "up" ? BOOST_STEP : -BOOST_STEP))));
    if (next === old) return { skip: "at_limit" };
    return { path: `$.boosts[${boost.id}].amount`, old, next, field: "boost", boost };
  }
  if (kind === "lean") return { none: "Lean is never weighted, so there is nothing to change." };
  return { none: "Where an outlet is based is not weighted, so there is nothing to change." };
}

const signed = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

function question(kind, name, direction, t) {
  const verb = direction === "up" ? "raise" : "lower";
  if (t.field === "affinity") {
    const from = levelWord(levelForAffinity(t.old));
    const to = levelWord(levelForAffinity(t.next));
    return from === to ? `${verb} ${name} a notch within ${from}?` : `${verb} ${name} from ${from} to ${to}?`;
  }
  return `${verb} your ${name} boost from ${signed(t.old)} to ${signed(t.next)}?`;
}

/** Proposal ids must match proposal.schema.json's id pattern (64 characters at most). */
function proposalId(week, path) {
  const tail = path.replace(/^\$\./, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+$/g, "");
  let hash = 0;
  for (const ch of path) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return `weekly-${week}-${tail}`.slice(0, 54) + `-${hash.toString(36)}`;
}

/**
 * The week's review.
 * @param {object} input
 *   opened, shown, thumbs  record arrays (the stores' own shapes)
 *   profile                ProfileStore.current()
 *   catalog                {sourceId: {name, lean, country, bucket}}
 *   nowMs                  the clock, told
 *   schemas                {profileSchema, proposalSchema} for the S19 gate
 *   decided                {path: "accepted"|"skipped"|"undone"} this week (state.js)
 *   acceptedCount          changes already accepted this week
 * @returns {{week, total, proposals, noticed, held, rejected, breadthFalling, slots}}
 *   proposals: [{id, key, kind, value, name, direction, path, old_value, new_value, sentence,
 *   proposal}] where `proposal` is the gate-ready object, already gated to "review".
 */
export function weeklyReview({ opened = [], shown = [], thumbs = [], profile, catalog = {}, nowMs, schemas, decided = {}, acceptedCount = 0 }) {
  if (!schemas) throw new Error("weeklyReview needs the gate's schemas");
  const week = weekKey(nowMs);
  const { total, attributes } = aggregate({ opened, shown, thumbs, profile, catalog, nowMs });
  const guards = standingGuards(profile);

  const breadth = weekOverWeek(opened || [], nowMs);
  const breadthFalling = Boolean(breadth.sufficient && breadth.delta < 0);
  const topTopic = breadth.current.topTopics[0] ? topicFor(breadth.current.topTopics[0].id, profile) : null;

  const candidates = [];
  const noticed = [];
  const held = [];
  for (const [key, stats] of attributes) {
    const ev = evidence(stats, total);
    if (!ev) continue;
    const colon = key.indexOf(":");
    const kind = key.slice(0, colon);
    const value = key.slice(colon + 1);
    const { name, noun } = describe(kind, value, profile, catalog);
    const clause = evidenceClause(stats, ev, noun);
    const t = target(kind, value, ev.direction, profile, catalog, guards);
    if (t.skip) continue;
    if (t.none) {
      noticed.push({ key, kind, value, direction: ev.direction, strength: ev.strength, sentence: `${clause}. ${t.none}` });
      continue;
    }
    const narrowing = ev.direction === "down" || (kind === "topic" && value === topTopic);
    const sentence = `${clause}; ${question(kind, name, ev.direction, t)}`;
    const item = { key, kind, value, name, direction: ev.direction, strength: ev.strength, path: t.path, old_value: t.old, new_value: t.next, sentence, stats: { ...stats } };
    if (breadthFalling && narrowing) held.push(item);
    else candidates.push(item);
  }

  const order = (a, b) => b.strength - a.strength || byStr(a.key, b.key);
  candidates.sort(order);
  noticed.sort(order);
  held.sort(order);

  const slots = Math.max(0, MAX_PER_WEEK - acceptedCount);
  const proposals = [];
  const rejected = [];
  for (const c of candidates) {
    if (proposals.length >= slots) break;
    if (Object.hasOwn(decided, c.path)) continue;
    const proposal = {
      schema_version: 1,
      id: proposalId(week, c.path),
      changes: [{ path: c.path, old_value: c.old_value, new_value: c.new_value }],
      rationale: c.sentence.slice(0, 600),
      evidence: [
        { kind: "signal", ref: `${c.key}:shown`, count: c.stats.shown },
        { kind: "signal", ref: `${c.key}:opened`, count: c.stats.opened },
        { kind: "signal", ref: `${c.key}:thumbs_up`, count: c.stats.up },
        { kind: "signal", ref: `${c.key}:thumbs_down`, count: c.stats.down },
      ].map((e) => ({ ...e, ref: e.ref.replace(/[^A-Za-z0-9:_.-]/g, "_").slice(0, 120) })),
    };
    const verdict = gateProposal(profile, proposal, schemas);
    if (verdict.decision !== "review") {
      rejected.push({ path: c.path, reason: verdict.reason });
      continue;
    }
    proposals.push({ id: proposal.id, key: c.key, kind: c.kind, value: c.value, name: c.name, direction: c.direction, path: c.path,
      old_value: c.old_value, new_value: c.new_value, sentence: c.sentence, proposal });
  }

  return {
    week,
    total,
    proposals,
    noticed: noticed.slice(0, MAX_PER_WEEK).map(({ key, kind, value, direction, sentence }) => ({ key, kind, value, direction, sentence })),
    held: held.map(({ key, path, direction, sentence }) => ({ key, path, direction, sentence })),
    rejected,
    breadthFalling,
    slots,
  };
}

/** The You row's one line: "3 suggestions", "No suggestions this week". */
export function summaryLine(review) {
  const n = review.proposals.length;
  return n ? plural(n, "suggestion") : "No suggestions this week";
}
