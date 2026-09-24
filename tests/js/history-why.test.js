// S15 proof: the why-this sheet's seen_penalty row (S12, DESIGN-v1.1 section 4). The
// row's label is the term's own per-story detail verbatim ("You opened this 2 hours
// ago"), and it still counts toward the sheet's own sum-equals-total invariant.
import { test } from "node:test";
import assert from "node:assert/strict";

import { rank } from "../../app/static/js/ranker.js";
import { explainStory } from "../../app/static/js/why-this.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { seenPenaltyTerm, emptyHistory } from "../../app/static/js/history/penalty.js";

const NOW = "2026-09-24T12:00:00Z";
const NOW_MS = Date.parse(NOW);
const iso = (hoursAgo) => new Date(NOW_MS - hoursAgo * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");

function pool() {
  return {
    schema_version: 1, generated_at: NOW, sources: [],
    articles: [{ id: "a0", source_id: "s0", url: "https://example.org/0", title: "Story 0", published_at: iso(1), topics: ["world"] }],
    clusters: [],
  };
}

test("a story with an opened entry shows the plain-words label as its seen_penalty row", () => {
  const history = emptyHistory();
  history.opened.set("a0", { time: iso(2) });
  const profile = buildDefaultProfile(NOW);
  const [story] = rank(pool(), profile, NOW, { terms: [seenPenaltyTerm(history)] });
  const { rows, total } = explainStory(story, profile, NOW_MS);
  const row = rows.at(-1);
  assert.equal(row.term, "seen_penalty");
  assert.equal(row.label, "You opened this 2 hours ago");
  assert.ok(row.points < 0);
  assert.equal(total, rows.reduce((sum, r) => sum + r.points, 0));
});

test("a story with no history shows an empty-detail fallback label, never crashes", () => {
  const profile = buildDefaultProfile(NOW);
  const [story] = rank(pool(), profile, NOW, { terms: [seenPenaltyTerm(emptyHistory())] });
  const row = explainStory(story, profile, NOW_MS).rows.at(-1);
  assert.equal(row.term, "seen_penalty");
  assert.equal(row.points, 0);
  assert.equal(row.label, "Seen before, on this device");
});
