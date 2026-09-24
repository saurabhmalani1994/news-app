// S15 proof: the seen penalty (R17) as a ranker.js opts.terms entry. Sum-equals-score
// holds with the extra term present, the term's sign and size follow the profile's own
// seen_penalty weights and decay with age, and a story the owner opened recently drops
// in rank against the same pool scored with no history at all.
import { test } from "node:test";
import assert from "node:assert/strict";

import { rank, SCALE } from "../../app/static/js/ranker.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { seenPenaltyTerm, emptyHistory, SEEN_PENALTY_HALF_LIFE_HOURS } from "../../app/static/js/history/penalty.js";

const NOW = "2026-09-24T12:00:00Z";
const NOW_MS = Date.parse(NOW);
const iso = (hoursAgo) => new Date(NOW_MS - hoursAgo * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");

function pool(n = 10) {
  const articles = [];
  for (let i = 0; i < n; i++) {
    articles.push({
      id: `a${i}`, source_id: `s${i % 3}`, url: `https://example.org/${i}`,
      title: `Story ${i}`, published_at: iso(1), topics: ["world"],
    });
  }
  return { schema_version: 1, generated_at: NOW, sources: [], articles, clusters: [] };
}

const profile = () => buildDefaultProfile(NOW);

test("no history: seen_penalty is 0 for every story, invariant still holds", () => {
  const ranked = rank(pool(), profile(), NOW, { terms: [seenPenaltyTerm(emptyHistory())] });
  for (const s of ranked) {
    const term = s.explanation.at(-1);
    assert.equal(term.term, "seen_penalty");
    assert.equal(term.value, 0);
    assert.equal(term.detail, "");
    assert.equal(s.explanation.reduce((sum, t) => sum + t.value, 0), s.score);
  }
});

test("an opened story carries a negative seen_penalty sized by the profile's weight", () => {
  const history = emptyHistory();
  history.opened.set("a0", { time: iso(0) }); // just now: no decay yet
  const ranked = rank(pool(), profile(), NOW, { terms: [seenPenaltyTerm(history)] });
  const a0 = ranked.find((s) => s.id === "a0");
  const term = a0.explanation.at(-1);
  assert.equal(term.term, "seen_penalty");
  assert.ok(term.value < 0, "opened pushes the score down, never up");
  // STARTER_SEEN_PENALTY.opened is 1.0, the same "1 = full strength" scale ranker.js's
  // own WEIGHTS use, so at age 0 the term is exactly -1 * SCALE.
  assert.equal(term.value, -1 * SCALE);
  assert.equal(term.detail, "You opened this under an hour ago");
  assert.equal(a0.explanation.reduce((sum, t) => sum + t.value, 0), a0.score);
});

test("a shown-only story carries the smaller shown weight, not the opened weight", () => {
  const history = emptyHistory();
  history.shown.set("a1", { time: iso(0) });
  const ranked = rank(pool(), profile(), NOW, { terms: [seenPenaltyTerm(history)] });
  const term = ranked.find((s) => s.id === "a1").explanation.at(-1);
  assert.equal(term.value, Math.round(-0.25 * SCALE)); // STARTER_SEEN_PENALTY.shown
  assert.equal(term.detail, "You saw this go by under an hour ago");
});

test("the penalty decays with age, one half-life halves it", () => {
  const history = emptyHistory();
  history.opened.set("a2", { time: iso(SEEN_PENALTY_HALF_LIFE_HOURS) });
  const ranked = rank(pool(), profile(), NOW, { terms: [seenPenaltyTerm(history)] });
  const term = ranked.find((s) => s.id === "a2").explanation.at(-1);
  assert.equal(term.value, Math.round(-0.5 * SCALE));
});

test("opened and shown both contribute when both fired; opened's label wins", () => {
  const history = emptyHistory();
  history.opened.set("a3", { time: iso(0) });
  history.shown.set("a3", { time: iso(0) });
  const ranked = rank(pool(), profile(), NOW, { terms: [seenPenaltyTerm(history)] });
  const term = ranked.find((s) => s.id === "a3").explanation.at(-1);
  assert.equal(term.value, Math.round(-1.25 * SCALE));
  assert.equal(term.detail, "You opened this under an hour ago");
});

test("a story opened recently drops in rank versus the same pool with no history", () => {
  const p = pool(10);
  const withoutHistory = rank(p, profile(), NOW, { terms: [seenPenaltyTerm(emptyHistory())] });
  const before = withoutHistory.findIndex((s) => s.id === "a0");
  const history = emptyHistory();
  history.opened.set("a0", { time: iso(0.1) });
  const withHistory = rank(p, profile(), NOW, { terms: [seenPenaltyTerm(history)] });
  const after = withHistory.findIndex((s) => s.id === "a0");
  assert.ok(after > before, `a0 should drop (was ${before}, now ${after})`);
  const scoreBefore = withoutHistory.find((s) => s.id === "a0").score;
  const scoreAfter = withHistory.find((s) => s.id === "a0").score;
  assert.ok(scoreAfter < scoreBefore);
});
