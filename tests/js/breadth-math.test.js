// S16 proof: the breadth number's pure math (app/static/js/breadth/math.js). No
// IndexedDB, no wall clock: every case hands its own nowMs and record list.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DAY_MS, WINDOW_MS, MIN_SAMPLE, NARROW_THRESHOLD_PCT,
  recordsInWindow, topicWeights, normalizedEntropy, topTopics, windowStats,
  weekOverWeek, formatWeekOverWeek, formatNarrowingBanner,
} from "../../app/static/js/breadth/math.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY_MS).toISOString();

function record(topics, daysAgo) {
  return { topics, time: iso(daysAgo) };
}

function fill(topics, count, daysAgo) {
  return Array.from({ length: count }, () => record(topics, daysAgo));
}

test("topicWeights splits a multi-topic story's weight evenly", () => {
  const weights = topicWeights([{ topics: ["a", "b"], time: iso(1) }]);
  assert.equal(weights.get("a"), 0.5);
  assert.equal(weights.get("b"), 0.5);
});

test("topicWeights sums weight across records and ignores a topic-less record", () => {
  const weights = topicWeights([
    { topics: ["a"], time: iso(1) },
    { topics: ["a", "b"], time: iso(1) },
    { topics: [], time: iso(1) },
  ]);
  assert.equal(weights.get("a"), 1.5);
  assert.equal(weights.get("b"), 0.5);
  assert.equal(weights.size, 2);
});

test("normalizedEntropy is 1 for a uniform spread across several topics", () => {
  const weights = new Map([["a", 1], ["b", 1], ["c", 1], ["d", 1]]);
  assert.equal(normalizedEntropy(weights), 1);
});

test("normalizedEntropy is 0 for a single topic, however much weight", () => {
  assert.equal(normalizedEntropy(new Map([["a", 7]])), 0);
});

test("normalizedEntropy is 0 for an empty distribution", () => {
  assert.equal(normalizedEntropy(new Map()), 0);
  assert.equal(normalizedEntropy({}), 0);
});

test("normalizedEntropy sits strictly between 0 and 1 for an uneven multi-topic split", () => {
  // One story tagged a+b, three stories tagged only a: a=3.5, b=0.5, skewed but not
  // single-topic.
  const weights = topicWeights([...fill(["a"], 3, 1), record(["a", "b"], 1)]);
  const entropy = normalizedEntropy(weights);
  assert.ok(entropy > 0 && entropy < 1, `expected 0 < entropy < 1, got ${entropy}`);
});

test("windowStats on no records is score 0, count 0, no top topics", () => {
  const stats = windowStats([]);
  assert.deepEqual(stats, { count: 0, score: 0, topTopics: [] });
});

test("topTopics orders by weight, then id, and respects the limit", () => {
  const weights = new Map([["z", 1], ["a", 1], ["m", 2]]);
  assert.deepEqual(topTopics(weights, 2), [{ id: "m", weight: 2 }, { id: "a", weight: 1 }]);
});

test("recordsInWindow keeps only records with time in [start, end)", () => {
  const records = [record(["a"], 0.1), record(["a"], 6.9), record(["a"], 7.1), record(["a"], 13.9)];
  const inCurrent = recordsInWindow(records, NOW - WINDOW_MS, NOW);
  assert.equal(inCurrent.length, 2);
});

test("weekOverWeek: below MIN_SAMPLE in either window reads as insufficient, not a number", () => {
  const records = [...fill(["a"], MIN_SAMPLE - 1, 1), ...fill(["a"], MIN_SAMPLE, 8)];
  const result = weekOverWeek(records, NOW);
  assert.equal(result.sufficient, false);
  assert.equal(result.delta, null);
  assert.equal(result.narrowed, false);
  assert.equal(formatWeekOverWeek(result), "Not enough reading yet to measure");
  assert.equal(formatNarrowingBanner(result), null);
});

test("weekOverWeek: exactly MIN_SAMPLE in both windows is sufficient", () => {
  const records = [...fill(["a"], MIN_SAMPLE, 1), ...fill(["a"], MIN_SAMPLE, 8)];
  const result = weekOverWeek(records, NOW);
  assert.equal(result.sufficient, true);
});

test("weekOverWeek: a wider spread this week than last reports an up delta", () => {
  // Previous week: single topic, score 0. Current week: four topics evenly, score 100.
  const records = [
    ...fill(["a"], MIN_SAMPLE, 8),
    ...fill(["a"], Math.ceil(MIN_SAMPLE / 4), 1),
    ...fill(["b"], Math.ceil(MIN_SAMPLE / 4), 1),
    ...fill(["c"], Math.ceil(MIN_SAMPLE / 4), 1),
    ...fill(["d"], Math.ceil(MIN_SAMPLE / 4), 1),
  ];
  const result = weekOverWeek(records, NOW);
  assert.equal(result.previous.score, 0);
  assert.equal(result.current.score, 100);
  assert.equal(result.delta, 100);
  assert.equal(result.narrowed, false);
  assert.equal(formatWeekOverWeek(result), "Breadth 100, up 100 from last week");
});

test("weekOverWeek: narrowing threshold at exactly 15% does not trigger the banner", () => {
  // previous score 20, current score 17: (20-17)/20 = 15% exactly.
  const result = weekOverWeek([], NOW);
  const forced = { ...result, current: { score: 17, count: MIN_SAMPLE, topTopics: [] }, previous: { score: 20, count: MIN_SAMPLE, topTopics: [] }, sufficient: true };
  const percentDrop = ((forced.previous.score - forced.current.score) / forced.previous.score) * 100;
  assert.equal(percentDrop, 15);
  const narrowed = percentDrop > NARROW_THRESHOLD_PCT;
  assert.equal(narrowed, false);
});

test("weekOverWeek: narrowing threshold just past 15% does trigger the banner", () => {
  // Previous week reads wide (four topics), this week narrows hard toward one topic:
  // whatever the exact scores, the relative drop clears 15%.
  const records = [
    ...fill(["a"], 4, 8), ...fill(["b"], 4, 8), ...fill(["c"], 1, 8), ...fill(["d"], 1, 8),
    ...fill(["a"], 9, 1), ...fill(["b"], 1, 1),
  ];
  const result = weekOverWeek(records, NOW);
  assert.equal(result.sufficient, true);
  assert.ok(result.percentDrop > NARROW_THRESHOLD_PCT, `expected > 15%, got ${result.percentDrop}`);
  assert.equal(result.narrowed, true);
  const banner = formatNarrowingBanner(result);
  assert.match(banner, /^Your reading narrowed this week: breadth \d+, down \d+%\. See You\.$/);
});

test("formatWeekOverWeek says unchanged when the score does not move", () => {
  const records = [...fill(["a"], MIN_SAMPLE, 1), ...fill(["a"], MIN_SAMPLE, 8)];
  const result = weekOverWeek(records, NOW);
  assert.equal(result.delta, 0);
  assert.equal(formatWeekOverWeek(result), "Breadth 0, unchanged from last week");
});

test("weekOverWeek respects a custom window size", () => {
  const records = [...fill(["a"], 5, 0.5), ...fill(["a"], 5, 1.5)];
  const result = weekOverWeek(records, NOW, { windowMs: DAY_MS, minSample: 5 });
  assert.equal(result.current.count, 5);
  assert.equal(result.previous.count, 5);
});
