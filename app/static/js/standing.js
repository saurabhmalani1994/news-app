// S28: standing stories (R2, DESIGN-v1.1 section 6). The owner's complaint is omission,
// not slant: "news sources don't tell me about the things happening in Israel or Gaza,
// or in Sudan" (OWNER-BRIEF). A standing story is a named subject the front page may
// not go quiet on. Two mechanisms answer it:
//   - a coverage floor (the "standing-story" pass in passes.js): on Today, at least
//     floor_slots qualifying cards in the first floor_within places whenever the pool
//     holds one, each placement naming itself;
//   - a silence alarm (silenceNotices below): when the newest qualifying story is older
//     than silence_hours, or there is none, Today carries a plain notice saying so, and
//     source health (S06) tells "nobody covered it" apart from "its sources are failing".
//
// A standing story is defined in the profile (owner editable, never AI writable: the S19
// gate reserves standing_stories). Matching, from the fields:
//   keywords  a story qualifies when one of its headlines holds a keyword as a whole
//             word or phrase, any case;
//   tags      when set, a keyword match counts only on a story carrying one of these
//             pool topic tags, so "Israel" in a sports headline does not count; with no
//             keywords, a tag match alone qualifies;
//   buckets   the story's own sources (sources.json buckets). They do not qualify an
//             article by themselves, because an outlet like the Jerusalem Post runs far
//             more than the conflict; they are the sources the silence alarm checks.
// Pure and deterministic: the same pool, profile, health and time give the same
// placements and the same notices at build under Node and on the device.

// Defaults from the owner brief: Israel and Gaza, and Sudan. The floor is one card in
// the first 15, which is the whole top module (hero, two lead blocks and twelve river
// rows, app/build.py tiers) and so never below "More headlines". Silence thresholds
// follow each story's volume in the live pool: Israel and Gaza runs many times a day,
// so a quiet day is already a signal; the Sudan feeds publish a few items a day, so the
// alarm waits a day and a half.
export const STANDING_DEFAULTS = Object.freeze([
  Object.freeze({
    id: "israel_gaza",
    label: "Israel and Gaza",
    enabled: true,
    keywords: Object.freeze(["gaza", "israel", "israeli", "israelis", "hamas", "west bank", "palestinian", "palestinians", "palestine", "netanyahu", "rafah"]),
    tags: Object.freeze(["world", "conflict"]),
    buckets: Object.freeze(["israel_gaza"]),
    floor_slots: 1,
    floor_within: 15,
    silence_hours: 24,
  }),
  Object.freeze({
    id: "sudan",
    label: "Sudan",
    enabled: true,
    keywords: Object.freeze(["sudan", "sudanese", "darfur", "khartoum", "kordofan", "el fasher", "el-fasher", "omdurman", "rapid support forces", "burhan", "hemedti"]),
    tags: Object.freeze(["world", "conflict"]),
    buckets: Object.freeze(["sudan"]),
    floor_slots: 1,
    floor_within: 15,
    silence_hours: 36,
  }),
]);

const HOUR_MS = 3_600_000;
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const listWords = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The profile's standing stories that are switched on, in the profile's own order
 * (its order is the owner's priority when two floors compete for one place). An absent
 * field means the defaults, so a profile stored before S28 still gets them; an empty
 * list means the owner removed them all. */
export function standingStories(profile) {
  const list = profile && Array.isArray(profile.standing_stories) ? profile.standing_stories : STANDING_DEFAULTS;
  return list.filter((s) => s && s.enabled !== false).map(compile);
}

function compile(def) {
  const words = (def.keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean);
  const re = words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "iu") : null;
  return {
    id: def.id,
    label: def.label || def.id,
    re,
    tags: [...(def.tags || [])],
    buckets: [...(def.buckets || [])],
    floor_slots: Number.isInteger(def.floor_slots) ? def.floor_slots : 0,
    floor_within: Number.isInteger(def.floor_within) ? def.floor_within : 0,
    silence_hours: typeof def.silence_hours === "number" ? def.silence_hours : 0,
  };
}

/** Whether a story ({titles, topics}, ranker.js storiesFromPool) belongs to a compiled
 * standing story. */
export function qualifies(story, def) {
  const tagged = def.tags.length > 0 && (story.topics || []).some((t) => def.tags.includes(t));
  if (!def.re) return tagged;
  if (def.tags.length && !tagged) return false;
  return (story.titles || []).some((t) => def.re.test(t));
}

const STATE_WORDS = { http_error: "HTTP errors", parse_error: "unreadable feed", timeout: "timing out", empty: "empty feed" };

/**
 * The silence alarm: one notice per standing story whose newest qualifying story is
 * older than its silence_hours, or that has none in the pool. `stories` is the whole
 * pool as stories, before mute and dedup: silence is a fact about coverage, so a mute
 * never makes the app claim nobody wrote about it.
 * opts: {buckets: {source_id: bucket}, names: {source_id: name},
 *        health: {source_id: {state, runs}} for the sources S06 marks unhealthy}.
 * Returns [{id, label, kind, hours, kicker, head, text}], kind "no-coverage" or
 * "sources-failing". Every word is the app's own; nothing comes from a feed but
 * source names, which render as text only (R26).
 */
export function silenceNotices(stories, profile, nowMs, opts = {}) {
  const buckets = opts.buckets || {};
  const names = opts.names || {};
  const health = opts.health || {};
  const name = (id) => names[id] || id;
  const oldest = stories.length ? Math.min(...stories.map((s) => s.latest_ms)) : nowMs;
  const span = Math.max(0, Math.floor((nowMs - oldest) / HOUR_MS));
  const notices = [];
  for (const def of standingStories(profile)) {
    if (!(def.silence_hours > 0)) continue;
    const newest = stories.filter((s) => qualifies(s, def)).reduce((m, s) => Math.max(m, s.latest_ms), -Infinity);
    const age = Number.isFinite(newest) ? Math.max(0, nowMs - newest) : null;
    if (age !== null && age <= def.silence_hours * HOUR_MS) continue;
    const hours = age === null ? span : Math.floor(age / HOUR_MS);
    const own = Object.keys(buckets).filter((id) => def.buckets.includes(buckets[id])).sort((a, b) => byStr(name(a), name(b)) || byStr(a, b));
    const failing = own.filter((id) => Object.hasOwn(health, id));
    const answering = own.filter((id) => !Object.hasOwn(health, id));
    const how = (id) => {
      const h = health[id];
      const runs = Number.isInteger(h.runs) && h.runs > 0 ? `, ${h.runs} fetches in a row` : "";
      return `${name(id)} (${STATE_WORDS[h.state] || "failing"}${runs})`;
    };
    const gap = age === null ? `No ${def.label} coverage in the last ${plural(hours, "hour", "hours")}` : `No new ${def.label} coverage in ${plural(hours, "hour", "hours")}`;
    let kind = "no-coverage";
    let head = gap;
    let text;
    if (own.length && !answering.length) {
      kind = "sources-failing";
      head = `Your ${def.label} sources are failing`;
      text = `${gap}, and every ${def.label} source is failing: ${listWords(failing.map(how))}.`;
    } else if (failing.length) {
      text = `${listWords(answering.map(name))} ${answering.length === 1 ? "is" : "are"} answering; ${listWords(failing.map(how))} ${failing.length === 1 ? "is" : "are"} failing. None of your sources has run a new ${def.label} story.`;
    } else if (own.length) {
      text = `Your ${plural(own.length, `${def.label} source is`, `${def.label} sources are`)} answering, so this is a gap in coverage, not a broken feed.`;
    } else {
      text = `None of your sources has run a ${def.label} story.`;
    }
    notices.push({ id: def.id, label: def.label, kind, hours, kicker: `Standing story · ${def.label}`, head, text });
  }
  return notices;
}
