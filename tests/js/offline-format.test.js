// S18 proof: the offline line's text and the honest, real-clock meta age it recomputes
// (D1: the built page's own ages are frozen at the pool's generated_at). Also checks
// js/offline.js's own inline copy of relativeAge (it cannot statically `import`, being a
// classic script that must run synchronously at a fixed point in the page, R34 zero
// layout shift) stays byte-for-byte identical to this tested one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { offlineLineText, refreshedMetaText, relativeAge } from "../../app/static/js/offline-format.js";

const T0 = Date.parse("2026-09-24T12:00:00Z");

test("relativeAge: minutes, hours and days, with a 1m floor for anything under a minute", () => {
  assert.equal(relativeAge("2026-09-24T11:59:30Z", T0), "1 min ago");
  assert.equal(relativeAge("2026-09-24T11:48:00Z", T0), "12 min ago");
  assert.equal(relativeAge("2026-09-24T09:00:00Z", T0), "3h ago");
  assert.equal(relativeAge("2026-09-21T12:00:00Z", T0), "3d ago");
});

test("relativeAge: an unparseable or missing time is the empty string, never NaN text", () => {
  assert.equal(relativeAge(undefined, T0), "");
  assert.equal(relativeAge("not a date", T0), "");
  assert.equal(relativeAge("2026-09-24T09:00:00Z", null), "");
});

test("offlineLineText: the quiet nameplate line, from the pool's own generated_at", () => {
  assert.equal(offlineLineText("2026-09-24T10:00:00Z", T0), "Offline. Showing news from 2h ago");
  assert.equal(offlineLineText("2026-09-24T11:59:00Z", T0), "Offline. Showing news from 1 min ago");
});

test("offlineLineText: a pool with no readable generated_at still says something quiet, not a NaN string", () => {
  assert.equal(offlineLineText(undefined, T0), "Offline. Showing cached news.");
});

test("refreshedMetaText: only the trailing age token is swapped, whatever led it is kept", () => {
  assert.equal(refreshedMetaText(" · 12 min ago", "3h ago"), " · 3h ago");
  assert.equal(refreshedMetaText(" · 4 sources · 5 min ago", "2d ago"), " · 4 sources · 2d ago");
  assert.equal(refreshedMetaText("12 min ago", "1h ago"), "1h ago");
});

test("refreshedMetaText: text with no trailing age, or no fresh age to give it, is left alone", () => {
  assert.equal(refreshedMetaText(" · 4 sources", "3h ago"), " · 4 sources");
  assert.equal(refreshedMetaText(" · 12 min ago", ""), " · 12 min ago");
});

test("js/offline.js keeps its own relativeAge identical to js/offline-format.js's, since it cannot import it", () => {
  const inlineSource = readFileSync(new URL("../../app/static/js/offline.js", import.meta.url), "utf8");
  const match = inlineSource.match(/function relativeAge\(publishedAt, now\) \{[\s\S]*?\n  \}/);
  assert.ok(match, "offline.js should still define its own relativeAge");
  // eslint-disable-next-line no-new-func
  const inlineRelativeAge = new Function("Date", "Number", "Math", `return (${match[0]});`)(Date, Number, Math);
  for (const [publishedAt, now] of [
    ["2026-09-24T11:59:30Z", T0],
    ["2026-09-24T09:00:00Z", T0],
    ["2026-09-21T12:00:00Z", T0],
    [undefined, T0],
  ]) {
    assert.equal(inlineRelativeAge(publishedAt, now), relativeAge(publishedAt, now));
  }
});

// D3: one relative-time convention everywhere, the captures' own: minutes spelled "min"
// (as in "5 MIN READ"), so the uppercase meta never reads "1M AGO", which looks like
// months; hours and days stay "3h ago", "2d ago" ("16H AGO" in the captures).
test("D3 relative time: never a bare 'm', every formatter agrees", () => {
  const cases = [["2026-09-24T11:59:59Z", "1 min ago"], ["2026-09-24T11:01:00Z", "59 min ago"],
    ["2026-09-24T11:00:00Z", "1h ago"], ["2026-09-22T12:01:00Z", "47h ago"], ["2026-09-22T12:00:00Z", "2d ago"]];
  for (const [at, want] of cases) {
    assert.equal(relativeAge(at, T0), want);
    assert.doesNotMatch(relativeAge(at, T0).toUpperCase(), /\dM AGO/);
  }
  // The two classic-script copies (offline.js, health-age.js) spell minutes the same way.
  for (const file of ["offline.js", "health-age.js"]) {
    const src = readFileSync(new URL(`../../app/static/js/${file}`, import.meta.url), "utf-8");
    assert.match(src, /\+ " min ago"/, file);
    assert.doesNotMatch(src, /"m ago"/, file);
  }
  // The offline refresh recognises the new token and swaps only it.
  assert.equal(refreshedMetaText("NPR · 59 min ago", "1h ago"), "NPR · 1h ago");
  assert.equal(refreshedMetaText("NPR · 3h ago", "2d ago"), "NPR · 2d ago");
});
