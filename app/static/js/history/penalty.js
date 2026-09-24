// S15: the seen penalty (DESIGN-v1.1 section 4, R17), an opts.terms entry for the one
// ranker (ranker.js). Two device-only signals, weighted by the profile's own
// `seen_penalty.opened` and `.shown` (S10, profile.schema.json), each on the same 0 to
// 1 scale ranker.js's WEIGHTS use elsewhere: 1 is a term at full strength. Opened is
// the full-strength signal; shown is deliberately the smaller one (STARTER_SEEN_PENALTY:
// opened 1.0, shown 0.25), so a story merely scrolled past yields far less of its slot
// than one actually opened.
//
// Each signal decays with the story's own age since that event, the same half-life
// shape ranker.js's recency term uses (2^(-age/half-life)), so a story opened five
// minutes ago is pushed hard down the page and one opened three days ago has nearly
// recovered its place: "an ignored headline gradually yields its slot" (DESIGN section
// 4) applies in reverse to one the owner has already read. The half-life is fixed, not
// profile-editable (the schema only exposes the two weights): the pool itself turns
// over in about 72h, so a slower or faster forgetting rate would either never matter
// (too fast) or barely matter (too slow) inside a story's own lifetime on the page.
export const SEEN_PENALTY_HALF_LIFE_HOURS = 24;

const HOUR_MS = 3_600_000;
const decay = (ageHours, halfLife) => 2 ** (-Math.max(0, ageHours) / halfLife);

function ageText(ageHours) {
  if (ageHours < 1) return "under an hour ago";
  if (ageHours < 48) {
    const h = Math.round(ageHours);
    return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  }
  const d = Math.round(ageHours / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** The why-this label (S12): "You opened this 2 hours ago" takes priority over shown,
 * since opened is the stronger, more specific signal; "You saw this go by" when only
 * shown fired. Empty when history carries nothing for this story (the term is 0 and
 * ranker.js drops a detail-less row into an empty string, same as any other term). */
function seenDetail(opened, shown, nowMs) {
  if (opened) return `You opened this ${ageText((nowMs - Date.parse(opened.time)) / HOUR_MS)}`;
  if (shown) return `You saw this go by ${ageText((nowMs - Date.parse(shown.time)) / HOUR_MS)}`;
  return "";
}

/**
 * `history` is {opened: Map<storyId, {time}>, shown: Map<storyId, {time}>} (the shape
 * history/summary.js's summaryToHistory builds from the compact localStorage summary,
 * or history/store.js's rows keyed the same way). Returns the ranker.js opts.terms
 * entry: {name: "seen_penalty", fn(story, ctx) -> {value, detail}}. `ctx.profile` and
 * `ctx.nowMs` are what ranker.js's rank() already threads through; no extra context is
 * needed. Never positive: a story with no history entry scores exactly 0 here, so the
 * sum-equals-score invariant holds trivially for every story history has not touched.
 */
export function seenPenaltyTerm(history, halfLifeHours = SEEN_PENALTY_HALF_LIFE_HOURS) {
  return {
    name: "seen_penalty",
    fn: (story, ctx) => {
      const weights = (ctx.profile && ctx.profile.seen_penalty) || { opened: 0, shown: 0 };
      const opened = history.opened.get(story.id) || null;
      const shown = history.shown.get(story.id) || null;
      let value = 0;
      if (opened) value -= weights.opened * decay((ctx.nowMs - Date.parse(opened.time)) / HOUR_MS, halfLifeHours);
      if (shown) value -= weights.shown * decay((ctx.nowMs - Date.parse(shown.time)) / HOUR_MS, halfLifeHours);
      return { value, detail: seenDetail(opened, shown, ctx.nowMs) };
    },
  };
}

/** {opened: new Map(), shown: new Map()}: no history, the term is 0 for every story. */
export function emptyHistory() {
  return { opened: new Map(), shown: new Map() };
}
