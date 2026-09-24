// S12: the why-this sheet (S24 overflow menu, DESIGN-v1.1 section 4). Turns a story's
// exact ranker explanation (ranker.js scoreStory) into a plain-words, signed
// contribution list that sums to the same total shown on screen, followed by any S13
// or S28 pass entries for the story on the tab it was opened from, and a link to the
// profile field that drove the largest term. The story passed in is always a
// rankPages() record (story-actions.js recomputes with the device's own profile, the
// same call rerenderAfterProfileChange already makes), so a re-ranked device and the
// build agree: this module never re-derives a score, only reads `explanation` and
// `passes`, which ranker.js and passes.js guarantee are exact and deterministic.
//
// Two halves: explainStory (pure, Node-tested) and renderWhyContent (DOM, browser
// only). Every string reaches the page as text, never markup (R26); the only feed
// string here is a boost's own label and a source's own name, both already plain text
// from profile.json and the pool.

const HOUR_MS = 3_600_000;

// Micro-points -> points: ranker.js's WEIGHTS use 1 for a full-strength term (recency
// at this instant, affinity at its cap, a boost at its cap); this reads such a term as
// 100 so the numbers stay small and comparable at a glance. Importance and trust are
// not capped at 1 and can read higher on a very well covered or heavily trusted story.
// Stated once, in the sheet's own caption (renderWhyContent), never repeated per row.
const POINTS_PER_MICRO = 1 / 10_000;

const points = (micro) => Math.round(micro * POINTS_PER_MICRO);
const listWords = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const topicLabel = (profile, id) => (profile.topics && profile.topics[id] && profile.topics[id].label) || id;

function hoursText(ageHours) {
  const h = Math.round(ageHours);
  if (h < 1) return "under an hour old";
  return `${h} ${h === 1 ? "hour" : "hours"} old`;
}

/** The topic among `matched` whose profile `field` is largest (recency's half-life,
 * affinity's own weight), the same one ranker.js's own Math.max picks, ties broken on
 * the lower id so the choice is deterministic and stable across runs. Null when no
 * topic matched (the default half-life, or no followed topic at all). */
function strongestTopic(profile, matched, field) {
  if (!matched || !matched.length) return null;
  const topics = profile.topics || {};
  return [...matched].sort((a, b) => {
    const diff = (topics[b]?.[field] ?? 0) - (topics[a]?.[field] ?? 0);
    return diff !== 0 ? diff : (a < b ? -1 : 1);
  })[0];
}

/** The source id among a story's own that sets ranker.js's trust multiplier (the
 * highest trust value; ties broken on the lower id), the same Math.max ranker.js runs. */
function trustSource(profile, sourceIds) {
  const table = profile.trust || {};
  return [...sourceIds].sort((a, b) => {
    const diff = (table[b] ?? 1) - (table[a] ?? 1);
    return diff !== 0 ? diff : (a < b ? -1 : 1);
  })[0];
}

/** One ranker.js explanation term -> {label, editHref}: the plain-words row text, and
 * where "edit the field that drove this" would send the owner, if anywhere feasible. */
function describeTerm(term, story, profile, names) {
  if (term.term === "recency") {
    const topic = strongestTopic(profile, story.topics_matched, "half_life_hours");
    return { label: `Recency, ${hoursText(story.ageHours)}`, editHref: topic ? `/profile#topic-${topic}` : "/profile" };
  }
  if (term.term === "affinity") {
    const matched = story.topics_matched || [];
    const topic = strongestTopic(profile, matched, "affinity");
    const label = matched.length ? `Your ${listWords(matched.map((id) => topicLabel(profile, id)))} interest` : "No followed topic";
    return { label, editHref: topic ? `/profile#topic-${topic}` : "/profile" };
  }
  if (term.term === "importance") {
    const n = story.independent_sources;
    return { label: `Covered by ${n} independent ${n === 1 ? "outlet" : "outlets"}`, editHref: "/profile" };
  }
  if (term.term === "trust") {
    const source = trustSource(profile, story.source_ids);
    const value = (profile.trust || {})[source];
    const name = names[source] || source;
    const label = value && value !== 1 ? `Trust, ×${value} for ${name}` : "Trust, no override on this story's sources";
    return { label, editHref: "/profile#raw-json" };
  }
  // S15 seen penalty (R17): term.detail is already the finished plain-words label
  // ("You opened this 2 hours ago"), computed per story by history/penalty.js, since
  // only it knows which signal (or both) fired and how long ago.
  if (term.term === "seen_penalty") {
    return { label: term.detail || "Seen before, on this device", editHref: "/profile#raw-json" };
  }
  // boost:<id>: term.detail is the boost's own label, already plain text (S11).
  return { label: `Boost: ${term.detail}`, editHref: "/profile#raw-json" };
}

/**
 * A story's why-this data: {rows, total, passEntries, editHref}. `rows` is
 * `[{term, label, value, points}]` in explanation order; `total` is the exact sum of
 * every row's `points` (never independently rounded, so it can never disagree with
 * what is on screen); `passEntries` is the story's own S13/S28 pass sentences, in the
 * order they ran, empty when none touched it; `editHref` follows the row with the
 * largest raw (unrounded) value, ties broken by explanation order.
 *
 * `story` is a rankPages()/rank() record (`explanation`, `passes`, `topics_matched`,
 * `independent_sources`, `source_ids`, `latest_ms` all present). `nowMs` is the time
 * to age recency from (the page's own `now`, so build and device agree); `names` is
 * `{source_id: name}` from the page's rank input, for the trust row.
 */
export function explainStory(story, profile, nowMs, names = {}) {
  const ageHours = Math.max(0, (nowMs - story.latest_ms) / HOUR_MS);
  const withAge = { ...story, ageHours };
  const rows = story.explanation.map((term) => {
    const { label, editHref } = describeTerm(term, withAge, profile, names);
    return { term: term.term, label, value: term.value, points: points(term.value), editHref };
  });
  const total = rows.reduce((sum, r) => sum + r.points, 0);
  const passEntries = story.passes.map((p) => p.text);
  const largest = rows.reduce((best, r) => (best === null || r.value > best.value ? r : best), null);
  return { rows, total, passEntries, editHref: largest ? largest.editHref : "/profile" };
}

// --- DOM rendering (browser only). Every value reaches the DOM through textContent. ---

function row(text, value, maxAbs) {
  const node = document.createElement("div");
  node.className = "why-row";
  const label = document.createElement("span");
  label.className = "why-row-label";
  label.textContent = text;
  const val = document.createElement("span");
  val.className = "why-row-value" + (value < 0 ? " why-row-value--neg" : "");
  val.textContent = (value < 0 ? "−" : "+") + Math.abs(value);
  node.append(label, val);
  if (maxAbs > 0) {
    const track = document.createElement("div");
    track.className = "why-row-bar";
    const fill = document.createElement("div");
    fill.className = "why-row-bar-fill" + (value < 0 ? " why-row-bar-fill--neg" : "");
    fill.style.width = `${Math.round((Math.abs(value) / maxAbs) * 100)}%`;
    track.append(fill);
    node.append(track);
  }
  return node;
}

/** The sheet body for one story: the headline it was opened from, the scale note
 * (stated once), each term row with its bar, the total, any pass entries, and the
 * edit-the-driving-field link. `headline` is plain text already read off the card. */
export function renderWhyContent({ story, profile, nowMs, names = {}, headline = "" }) {
  const { rows, total, passEntries, editHref } = explainStory(story, profile, nowMs, names);
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.points)));
  const nodes = [];

  if (headline) {
    const h = document.createElement("p");
    h.className = "why-headline";
    h.textContent = headline;
    nodes.push(h);
  }

  const scale = document.createElement("p");
  scale.className = "why-scale-note";
  scale.textContent = "Points: 100 is a term at full strength.";
  nodes.push(scale);

  const list = document.createElement("div");
  list.className = "why-rows";
  for (const r of rows) list.append(row(r.label, r.points, maxAbs));
  nodes.push(list);

  const totalRow = document.createElement("div");
  totalRow.className = "why-total";
  const totalLabel = document.createElement("span");
  totalLabel.textContent = "Total";
  const totalValue = document.createElement("span");
  totalValue.textContent = (total < 0 ? "−" : "+") + Math.abs(total);
  totalRow.append(totalLabel, totalValue);
  nodes.push(totalRow);

  if (passEntries.length) {
    const passBox = document.createElement("div");
    passBox.className = "why-passes";
    for (const text of passEntries) {
      const p = document.createElement("p");
      p.className = "why-pass";
      p.textContent = text;
      passBox.append(p);
    }
    nodes.push(passBox);
  }

  const link = document.createElement("a");
  link.className = "why-edit-link";
  link.href = editHref;
  link.textContent = "Edit what drove this most";
  nodes.push(link);

  return nodes;
}
