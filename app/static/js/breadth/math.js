// S16: the breadth number (DESIGN-v1.1 section 6, "the weekly Breadth number, topic
// entropy over shown articles"), computed on the device only from the opened-history
// store (history/store.js's openedStore, S15). Pure functions, no IndexedDB, no Date.now
// default: every function here takes `records` ({topics, time} at least, the shape
// history/record.js's buildHistorySnapshot writes) and a `nowMs` it is told, so
// tests/js/breadth-math.test.js can hand it exact clocks.
//
// The score: normalized Shannon entropy of the topic distribution of stories opened in
// a rolling 7-day window, 0 to 100. A story with several topics splits its weight
// evenly across them (an opened story with two tags is half a data point for each),
// the same "spread the weight" idea actions/store.js already uses for per-topic boosts.
// Normalizing by log2(k), k the number of distinct topics actually opened, means a
// reader who only ever reads two topics can still hit 100 by reading both evenly: the
// number measures spread within what this reader reads, not coverage of every topic
// the app knows about.
export const DAY_MS = 86_400_000;
export const WINDOW_MS = 7 * DAY_MS;

// Below this many opens in either window, entropy is noise: a handful of stories can
// land in two or three topics purely by chance and swing the number by 30 or more
// points. Ten is a light week of reading (about one story a day) and the smallest
// sample where the topic spread says something about the reader rather than about
// which two stories happened to open. Chosen, not measured; revisit if the number
// reads jumpy in practice.
export const MIN_SAMPLE = 10;

// "Drops more than 15%" (the brief): a relative drop, not points, so the same 5-point
// slide reads as narrowing at breadth 20 but not at breadth 80.
export const NARROW_THRESHOLD_PCT = 15;

const TOP_TOPICS_LIMIT = 5;

function epochMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/** Records with a parseable `time` inside [startMs, endMs), the S34/S15 opened-store
 * shape or any plain object carrying the same two fields. */
export function recordsInWindow(records, startMs, endMs) {
  return records.filter((r) => {
    const t = epochMs(r.time);
    return Number.isFinite(t) && t >= startMs && t < endMs;
  });
}

/** Map<topicId, weight>: every record's weight of 1 split evenly across its topics. A
 * record with no topics contributes nothing to the distribution (it has no topic to
 * carry the weight) but still counts toward the sample size the caller tracks
 * separately (weekOverWeek's `count` is `records.length`, not the sum of weights). */
export function topicWeights(records) {
  const weights = new Map();
  for (const record of records) {
    const topics = Array.isArray(record.topics) ? record.topics.filter(Boolean) : [];
    if (!topics.length) continue;
    const share = 1 / topics.length;
    for (const topic of topics) weights.set(topic, (weights.get(topic) || 0) + share);
  }
  return weights;
}

/** Shannon entropy of `weights` (a Map or plain object of nonnegative numbers),
 * normalized to 0..1 by log2(k), k the count of topics with nonzero weight. Zero or
 * one topic carries no spread to measure, so both read as 0, not NaN or 1. */
export function normalizedEntropy(weights) {
  const values = (weights instanceof Map ? [...weights.values()] : Object.values(weights || {})).filter((v) => v > 0);
  const k = values.length;
  if (k <= 1) return 0;
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return 0;
  const h = -values.reduce((sum, v) => {
    const p = v / total;
    return sum + p * Math.log2(p);
  }, 0);
  return h / Math.log2(k);
}

/** The top `limit` topics by weight, ties broken by id so the order is stable and
 * testable. */
export function topTopics(weights, limit = TOP_TOPICS_LIMIT) {
  const entries = weights instanceof Map ? [...weights.entries()] : Object.entries(weights || {});
  return entries
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([id, weight]) => ({ id, weight }));
}

/** One window's stats: how many stories opened, the weight distribution, the top
 * topics, and the 0-100 score. `records` should already be filtered to the window
 * (recordsInWindow); this function does not filter by time itself, so it stays usable
 * on a plain array in tests without a clock. */
export function windowStats(records) {
  const weights = topicWeights(records);
  return {
    count: records.length,
    score: Math.round(normalizedEntropy(weights) * 100),
    topTopics: topTopics(weights),
  };
}

/**
 * Week over week: the current rolling 7-day window against the 7 days before it, both
 * ending at `nowMs`. Returns:
 *   { current: windowStats, previous: windowStats, sufficient,
 *     delta: current.score - previous.score or null,
 *     percentDrop: relative drop in score, 0..100+, or null,
 *     narrowed: sufficient && percentDrop > NARROW_THRESHOLD_PCT }
 * `sufficient` is false when either window has fewer than `minSample` opens (MIN_SAMPLE
 * by default); delta, percentDrop and narrowed are all null/false in that case, since a
 * number with too little data behind it is worse than none (the brief's "Not enough
 * reading yet to measure").
 */
export function weekOverWeek(records, nowMs, { windowMs = WINDOW_MS, minSample = MIN_SAMPLE } = {}) {
  const currentRecords = recordsInWindow(records, nowMs - windowMs, nowMs);
  const previousRecords = recordsInWindow(records, nowMs - 2 * windowMs, nowMs - windowMs);
  const current = windowStats(currentRecords);
  const previous = windowStats(previousRecords);
  const sufficient = current.count >= minSample && previous.count >= minSample;
  if (!sufficient) return { current, previous, sufficient, delta: null, percentDrop: null, narrowed: false };
  const delta = current.score - previous.score;
  const percentDrop = previous.score > 0 ? ((previous.score - current.score) / previous.score) * 100 : 0;
  return { current, previous, sufficient, delta, percentDrop, narrowed: percentDrop > NARROW_THRESHOLD_PCT };
}

/** "Breadth 71, down 9 from last week", or the brief's own line when there is not
 * enough history yet. */
export function formatWeekOverWeek(result) {
  if (!result.sufficient) return "Not enough reading yet to measure";
  if (result.delta === 0) return `Breadth ${result.current.score}, unchanged from last week`;
  const word = result.delta > 0 ? "up" : "down";
  return `Breadth ${result.current.score}, ${word} ${Math.abs(result.delta)} from last week`;
}

/** The narrowing banner's one line, or null when it should not show: insufficient
 * data, or the drop is 15% or less. */
export function formatNarrowingBanner(result) {
  if (!result.sufficient || !result.narrowed) return null;
  const pct = Math.round(result.percentDrop);
  return `Your reading narrowed this week: breadth ${result.current.score}, down ${pct}%. See You.`;
}
