// J22: the order of Today, chosen by the reader with the switch at its top (app/build.py
// TODAY_ORDER). Kept on this phone (localStorage), never in the profile: it changes only
// the order of the stories the ranker already chose, never which ones.
//   for_you  the ranker's order (interests, how recent, how many outlets), as built.
//   latest   newest first, by the written time the card shows (its face, else its
//            lead), a time past the pool's own clamped to it (a feed's wrong zone).
//   urgent   the urgent stories of the last day first, then the rest as For you. A story
//            is urgent when the rules mark it must-know, or when Jev's hourly run reads
//            it as hard news (policy, conflict, the economy, science or public safety,
//            jev.hard at least URGENT_HARD) and at least URGENT_OUTLETS outlets cover it.
//            Must-know first, then the most outlets, then the newest.

export const ORDER_KEY = "almanac.today.order.v1";
export const ORDERS = Object.freeze(["for_you", "latest", "urgent"]);
export const URGENT_HARD = 0.7; // decide.js's "likely" band
export const URGENT_OUTLETS = 3;
export const URGENT_HOURS = 24;

/** The stored order, or "for_you". */
export function readOrder(storage) {
  try {
    const value = storage?.getItem(ORDER_KEY);
    return ORDERS.includes(value) ? value : "for_you";
  } catch {
    return "for_you";
  }
}

export function saveOrder(storage, order) {
  try {
    if (order === "for_you") storage?.removeItem(ORDER_KEY);
    else storage?.setItem(ORDER_KEY, order);
  } catch {
    // Storage blocked: the order holds until the page reloads.
  }
}

/** Why a story counts as urgent: "must_know", "jev", or null. */
export function urgentReason(story, pool, nowMs) {
  if (!story || nowMs - story.latest_ms > URGENT_HOURS * 3600 * 1000) return null;
  if (story.must_know) return "must_know";
  if ((story.independent_sources || 0) < URGENT_OUTLETS) return null;
  const members = (pool?.clusters || []).find((c) => c.id === story.id)?.article_ids || [story.id];
  const byId = new Map((pool?.articles || []).map((a) => [a.id, a]));
  const hard = members.some((id) => (byId.get(id)?.jev?.hard ?? 0) >= URGENT_HARD);
  return hard ? "jev" : null;
}

/** Today's stories in `order`. `faces` is {story id: article id} for a row fronted by
 * another version (passes.js). Stable: ties keep the For you order. */
export function orderToday(stories, order, pool, nowMs, faces = {}) {
  const index = new Map(stories.map((s, i) => [s.id, i]));
  const keep = (a, b) => index.get(a.id) - index.get(b.id);
  if (order === "latest") {
    const byId = new Map((pool?.articles || []).map((a) => [a.id, a]));
    const leads = new Map((pool?.clusters || []).map((c) => [c.id, c.lead]));
    const shown = (s) => {
      const t = Date.parse(byId.get(faces[s.id] || leads.get(s.id) || s.id)?.published_at);
      return Math.min(Number.isNaN(t) ? s.latest_ms : t, nowMs);
    };
    const at = new Map(stories.map((s) => [s.id, shown(s)]));
    return [...stories].sort((a, b) => at.get(b.id) - at.get(a.id) || keep(a, b));
  }
  if (order === "urgent") {
    const reason = new Map(stories.map((s) => [s.id, urgentReason(s, pool, nowMs)]));
    const urgent = stories.filter((s) => reason.get(s.id)).sort((a, b) =>
      (reason.get(a.id) === "must_know" ? 0 : 1) - (reason.get(b.id) === "must_know" ? 0 : 1)
      || (b.independent_sources || 0) - (a.independent_sources || 0)
      || b.latest_ms - a.latest_ms || keep(a, b));
    return [...urgent, ...stories.filter((s) => !reason.get(s.id))];
  }
  return stories;
}
