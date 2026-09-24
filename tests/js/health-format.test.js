// S17 proof: the pure logic behind the Health screen's pool-age line, and that
// js/health-age.js's inline copies (it cannot statically `import`, same reason as
// js/offline.js) stay byte-for-byte identical to the tested ones here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { STALE_THRESHOLD_MS, isStale, poolAgeText } from "../../app/static/js/health-format.js";

const T0 = Date.parse("2026-09-24T08:00:00Z");

test("isStale: false exactly at the threshold, true just past it", () => {
  assert.equal(isStale("2026-09-24T05:00:00Z", T0), false); // exactly 3h
  assert.equal(isStale(new Date(T0 - STALE_THRESHOLD_MS - 1).toISOString(), T0), true);
  assert.equal(isStale("2026-09-24T07:30:00Z", T0), false); // 30m old
});

test("isStale: an unparseable or missing generated_at is never stale", () => {
  assert.equal(isStale(undefined, T0), false);
  assert.equal(isStale("not a date", T0), false);
  assert.equal(isStale("2026-09-24T05:00:00Z", null), false);
});

test("poolAgeText: fresh pool reads 'Updated ... ago.'", () => {
  assert.equal(poolAgeText("2026-09-24T07:48:00Z", T0), "Updated 12m ago.");
});

test("poolAgeText: a pool older than the threshold leads with 'Stale.'", () => {
  assert.equal(poolAgeText("2026-09-24T04:00:00Z", T0), "Stale. Last updated 4h ago.");
});

test("poolAgeText: no readable generated_at says so without a NaN string", () => {
  assert.equal(poolAgeText(undefined, T0), "Pool age unknown.");
});

test("js/health-age.js keeps relativeAge, isStale and poolAgeText identical to js/health-format.js's own copies", () => {
  const norm = (s) => s.replace(/\r\n/g, "\n"); // line endings only, never content
  const inlineSource = norm(readFileSync(new URL("../../app/static/js/health-age.js", import.meta.url), "utf8"));

  const relMatch = inlineSource.match(/function relativeAge\(publishedAt, now\) \{[\s\S]*?\n  \}/);
  assert.ok(relMatch, "health-age.js should still define its own relativeAge");
  const offlineSource = norm(readFileSync(new URL("../../app/static/js/offline.js", import.meta.url), "utf8"));
  const offlineRelMatch = offlineSource.match(/function relativeAge\(publishedAt, now\) \{[\s\S]*?\n  \}/);
  assert.equal(relMatch[0], offlineRelMatch[0], "relativeAge should match js/offline.js's own copy too");

  const staleMatch = inlineSource.match(/function isStale\(generatedAt, now\) \{[\s\S]*?\n  \}/);
  assert.ok(staleMatch, "health-age.js should still define its own isStale");
  const thresholdMatch = inlineSource.match(/var STALE_THRESHOLD_MS = ([^;]+);/);
  assert.ok(thresholdMatch, "health-age.js should still define STALE_THRESHOLD_MS");
  // eslint-disable-next-line no-eval
  assert.equal(eval(thresholdMatch[1]), STALE_THRESHOLD_MS);

  const textMatch = inlineSource.match(/function poolAgeText\(generatedAt, now\) \{[\s\S]*?\n  \}/);
  assert.ok(textMatch, "health-age.js should still define its own poolAgeText");

  // eslint-disable-next-line no-new-func
  const build = (Number, Math, Date) => new Function(
    "Number", "Math", "Date",
    `${relMatch[0]}\n${thresholdMatch[0]}\n${staleMatch[0]}\n${textMatch[0]}\nreturn poolAgeText;`,
  )(Number, Math, Date);
  const inlinePoolAgeText = build(Number, Math, Date);

  for (const [generatedAt, now] of [
    ["2026-09-24T07:48:00Z", T0],
    ["2026-09-24T04:00:00Z", T0],
    [undefined, T0],
    ["2026-09-24T05:00:00Z", T0],
  ]) {
    assert.equal(inlinePoolAgeText(generatedAt, now), poolAgeText(generatedAt, now));
  }
});
