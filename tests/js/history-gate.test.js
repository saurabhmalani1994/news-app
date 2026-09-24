// S15 proof: rank-gate.js also re-ranks before first paint when the device has any
// read history at all, even with the default profile (the build never scores with
// history), and hands rerank.js the compact summary it read. Same vm harness as
// ranker.test.js's own head-gate test, extended with a localStorage double that
// answers each key on its own instead of one fixed value for every key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { profileKey } from "../../app/static/js/ranker.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const profile = () => buildDefaultProfile("2026-09-24T00:00:00Z");
const SOURCE = readFileSync(new URL("../../app/static/js/rank-gate.js", import.meta.url), "utf-8");

function runGate({ storedProfile, key, historySummary } = {}) {
  const classes = new Set();
  const appended = [];
  const root = {
    getAttribute: () => key,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
  };
  const values = {
    "almanac.profile.store.v1": storedProfile ? JSON.stringify({ history: [{ version: 1, profile: storedProfile }] }) : null,
    "almanac.history.summary.v1": historySummary ? JSON.stringify(historySummary) : null,
  };
  const context = {
    localStorage: { getItem: (k) => (Object.hasOwn(values, k) ? values[k] : null) },
    document: { documentElement: root, createElement: () => ({}), head: { appendChild: (el) => appended.push(el) } },
    window: {}, setTimeout: () => 0, JSON,
  };
  vm.runInNewContext(SOURCE, context);
  return { hidden: classes.has("rerank"), scripts: appended.map((s) => s.src), profile: context.window.almanacProfile, summary: context.window.almanacHistorySummary };
}

test("no profile, no history: paints as built", () => {
  const key = profileKey(profile());
  const r = runGate({ key });
  assert.deepEqual(r, { hidden: false, scripts: [], profile: undefined, summary: undefined });
});

test("no stored profile but a non-empty history summary: re-ranks with the default profile", () => {
  const key = profileKey(profile());
  const summary = { opened: { c1: "2026-09-24T10:00:00Z" }, shown: {} };
  const r = runGate({ key, historySummary: summary });
  assert.equal(r.hidden, true);
  assert.deepEqual(r.scripts, ["js/rerank.js"]);
  assert.equal(r.profile, null, "no stored profile: rerank.js falls back to the default");
  assert.deepEqual(r.summary, summary);
});

test("a default-matching stored profile and an empty history summary: paints as built", () => {
  const key = profileKey(profile());
  const r = runGate({ key, storedProfile: profile(), historySummary: { opened: {}, shown: {} } });
  assert.equal(r.hidden, false);
});

test("a default-matching stored profile plus a shown-only history entry: re-ranks", () => {
  const key = profileKey(profile());
  const summary = { opened: {}, shown: { c9: "2026-09-24T11:00:00Z" } };
  const r = runGate({ key, storedProfile: profile(), historySummary: summary });
  assert.equal(r.hidden, true);
  assert.deepEqual(r.summary, summary);
});

test("a changed profile still re-ranks regardless of history", () => {
  const key = profileKey(profile());
  const changed = profile();
  changed.topics.ai.affinity = 1;
  const r = runGate({ key, storedProfile: changed });
  assert.equal(r.hidden, true);
  assert.deepEqual(r.scripts, ["js/rerank.js"]);
});
