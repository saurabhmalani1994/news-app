// S15: the compact history summary kept in localStorage, so the pre-paint device
// re-rank (rank-gate.js, rerank.js) can read "what has this owner seen" synchronously,
// before first paint, the same way it already reads the stored profile synchronously.
// IndexedDB (history/store.js) is async and cannot be read before the first frame
// without holding the page hidden past CLS budget; this is the "compact summary kept
// in localStorage" the brief names as the way around that. It carries only what the
// seen-penalty term needs to score a story: id -> event time, nothing else (no title,
// no url), so it stays small even with a year of opened ids. It is a derived index,
// not the record of truth: history/store.js's IndexedDB rows are, and a summary entry
// with no matching IndexedDB row (a very old private-mode write, a storage clear that
// missed one) only ever costs one story a penalty it should not have, never a crash.
export const SUMMARY_KEY = "almanac.history.summary.v1";

function safeParse(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** {opened: {id: isoTime}, shown: {id: isoTime}}, always both keys present. */
export function readSummary(storage) {
  const parsed = safeParse(storage.getItem(SUMMARY_KEY));
  return { opened: (parsed && parsed.opened) || {}, shown: (parsed && parsed.shown) || {} };
}

function writeSummary(storage, summary) {
  storage.setItem(SUMMARY_KEY, JSON.stringify(summary));
}

/** Records one id's event time in the summary (write-through from record.js's
 * `onWrite`), overwriting any earlier time for the same id and signal. */
export function noteSeen(storage, signal, id, time) {
  const summary = readSummary(storage);
  summary[signal] = { ...summary[signal], [id]: time };
  writeSummary(storage, summary);
}

/** Drops ids the IndexedDB-side prune (history/prune.js) already removed, so the two
 * never drift apart for long. */
export function pruneSummary(storage, prunedIds) {
  const summary = readSummary(storage);
  for (const signal of ["opened", "shown"]) {
    for (const id of prunedIds[signal] || []) delete summary[signal][id];
  }
  writeSummary(storage, summary);
}

/** The summary as the {opened: Map<id, {time}>, shown: Map<id, {time}>} shape
 * history/penalty.js's seenPenaltyTerm reads. */
export function summaryToHistory(summary) {
  const toMap = (obj) => new Map(Object.entries(obj || {}).map(([id, time]) => [id, { time }]));
  return { opened: toMap(summary.opened), shown: toMap(summary.shown) };
}

/** True when the summary holds nothing yet: the fast path rank-gate.js and rerank.js
 * take to skip a re-rank a build already matches. */
export function isEmptySummary(summary) {
  return !summary || (!Object.keys(summary.opened || {}).length && !Object.keys(summary.shown || {}).length);
}
