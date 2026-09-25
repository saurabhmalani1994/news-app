// V1 (docs/DESIGN-bundles.md section 5, Signals): viewing a version other than the lead
// in the versions carousel records `compared` in local history. It feeds no ranking
// term: nothing in the ranker, the pre-paint re-rank (rank-gate.js, rerank.js) or the
// seen penalty (penalty.js) reads this key, so reading a version to compare never trains
// the feed. Local only (R23), never sent anywhere.
//
// A compact localStorage record, apart from history/summary.js's seen summary on
// purpose: {story_id: {time, ids: [article ids viewed]}}, capped at MAX_STORIES, the
// oldest dropped first. `storage` is anything shaped like Web Storage, so Node tests
// pass a stand-in.
export const COMPARED_KEY = "almanac.history.compared.v1";
export const MAX_STORIES = 200;
const MAX_IDS = 40;

export function readCompared(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(COMPARED_KEY) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Records that version `articleId` of story `storyId` was viewed at `time` (ISO). */
export function noteCompared(storage, storyId, articleId, time) {
  if (typeof storyId !== "string" || !storyId || typeof articleId !== "string" || !articleId) return;
  const all = readCompared(storage);
  const entry = all[storyId] && Array.isArray(all[storyId].ids) ? all[storyId] : { ids: [] };
  const ids = entry.ids.includes(articleId) ? entry.ids : [...entry.ids, articleId].slice(-MAX_IDS);
  delete all[storyId];
  all[storyId] = { time, ids };
  const keys = Object.keys(all);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_STORIES))) delete all[key];
  try {
    storage.setItem(COMPARED_KEY, JSON.stringify(all));
  } catch {
    // storage full or blocked: comparing still works, just unrecorded
  }
}
