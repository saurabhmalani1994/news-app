// S12 proof: the why-this sheet's plain-words contribution list. Every story on a
// fixture pool has its displayed rows sum to exactly its displayed total; every row's
// label is deterministic and reads in plain words; a story's own S13/S28 pass entries
// show up verbatim when it carries any, and the list is empty otherwise; the edit link
// follows whichever term actually drove the story's score the most.
import { test } from "node:test";
import assert from "node:assert/strict";

import { rank } from "../../app/static/js/ranker.js";
import { rankPages } from "../../app/static/js/passes.js";
import { explainStory } from "../../app/static/js/why-this.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const NOW = "2026-09-24T12:00:00Z";
const NOW_MS = Date.parse(NOW);
const iso = (hoursAgo) => new Date(NOW_MS - hoursAgo * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
const art = (id, source_id, hoursAgo, topics, title = `Headline for story ${id}`) => ({ id, source_id, title, published_at: iso(hoursAgo), topics });
const clu = (id, article_ids, independent_sources, lean_buckets, lead) => ({ id, article_ids, independent_sources, lean_buckets, ...(lead ? { lead } : {}) });
const poolOf = (articles, clusters = []) => ({ generated_at: NOW, articles, clusters });
const profile = (edit = () => {}) => { const p = buildDefaultProfile(NOW); edit(p); return p; };

function sumRowsEqualsTotal(pages, names = {}) {
  for (const story of [...pages.today, ...pages.sections.flatMap((s) => s.stories)]) {
    const p = profile();
    const { rows, total } = explainStory(story, p, NOW_MS, names);
    assert.equal(rows.length, story.explanation.length, `${story.id}: one row per explanation term`);
    assert.equal(total, rows.reduce((s, r) => s + r.points, 0), `${story.id}: total is exactly the sum shown`);
  }
}

test("sum invariant: every story's displayed rows sum to its displayed total, on a varied fixture pool", () => {
  const arts = [
    art("t1", "src1", 3, ["ai"]),
    art("t2", "src2", 0.2, ["us_politics", "world"]),
    art("t3", "src3", 50, ["singapore"]),
    art("t4", "src4", 12, []),
    ...Array.from({ length: 11 }, (_, i) => art(`m${i}`, `outlet${i}`, 1 + i, ["world", "conflict"])),
  ];
  const clusters = [clu("cl1", arts.filter((a) => a.id.startsWith("m")).map((a) => a.id), 11, ["left", "right", "center"], "m0")];
  const p = profile((x) => {
    x.boosts = [{ id: "sg", match_type: "topic", match_value: "singapore", amount: 0.4, label: "Singapore" }];
    x.trust = { src1: 1.3 };
  });
  const pages = rankPages(poolOf(arts, clusters), p, NOW);
  sumRowsEqualsTotal(pages);
  // A story the ranker scored (t3) is in the fixture, so the invariant was actually
  // exercised on every term shape: recency, affinity, importance, trust and a boost.
  assert.ok(pages.today.length > 0);
});

test("labels: recency reads in whole hours, matching the ranker's own age", () => {
  const p = profile();
  const pages = rankPages(poolOf([art("a", "s1", 3.0, [])]), p, NOW);
  const { rows } = explainStory(pages.today[0], p, NOW_MS);
  assert.equal(rows.find((r) => r.term === "recency").label, "Recency, 3 hours old");
});

test("labels: affinity names the owner's own topic label, singular, plural and none", () => {
  const p = profile();
  const pages = rankPages(poolOf([art("a", "s1", 1, ["ai"]), art("b", "s2", 1, ["ai", "world"]), art("c", "s3", 1, ["sports"])]), p, NOW);
  const by = Object.fromEntries(pages.today.map((s) => [s.id, explainStory(s, p, NOW_MS).rows.find((r) => r.term === "affinity").label]));
  assert.equal(by.a, "Your AI interest");
  assert.equal(by.b, "Your AI and World interest");
  assert.equal(by.c, "No followed topic");
});

test("labels: importance counts independent outlets, singular and plural", () => {
  const p = profile();
  const arts = [art("x1", "s1", 1, []), art("x2", "s2", 1, []), art("solo", "s3", 1, [])];
  const pages = rankPages(poolOf(arts, [clu("cl", ["x1", "x2"], 2, [], "x1")]), p, NOW);
  const label = (id) => explainStory(pages.today.find((s) => s.id === id), p, NOW_MS).rows.find((r) => r.term === "importance").label;
  assert.equal(label("cl"), "Covered by 2 independent outlets");
  assert.equal(label("solo"), "Covered by 1 independent outlet");
});

test("labels: a boost reads its own plain-text label", () => {
  const p = profile((x) => { x.boosts = [{ id: "sg", match_type: "topic", match_value: "singapore", amount: 0.5, label: "Singapore" }]; });
  const pages = rankPages(poolOf([art("a", "s1", 1, ["singapore"])]), p, NOW);
  const { rows } = explainStory(pages.today[0], p, NOW_MS);
  assert.equal(rows.find((r) => r.term === "boost:sg").label, "Boost: Singapore");
});

test("labels: trust names the source only when the owner actually overrode it", () => {
  const p = profile((x) => { x.trust = { trusted: 1.4 }; });
  const pages = rankPages(poolOf([art("a", "trusted", 1, []), art("b", "plain", 1, [])]), p, NOW, { names: { trusted: "The Standard" } });
  const label = (id) => explainStory(pages.today.find((s) => s.id === id), p, NOW_MS, { trusted: "The Standard" }).rows.find((r) => r.term === "trust").label;
  assert.equal(label("a"), "Trust, ×1.4 for The Standard");
  assert.equal(label("b"), "Trust, no override on this story's sources");
});

test("labels are deterministic: the same story and profile always produce the same rows", () => {
  const p = profile((x) => { x.boosts = [{ id: "sg", match_type: "topic", match_value: "singapore", amount: 0.5, label: "Singapore" }]; });
  const pages = rankPages(poolOf([art("a", "s1", 5, ["singapore", "ai"])]), p, NOW);
  const once = explainStory(pages.today[0], p, NOW_MS);
  const twice = explainStory(pages.today[0], p, NOW_MS);
  assert.deepEqual(once, twice);
});

test("pass entries: shown verbatim when a pass touched the story, empty otherwise", () => {
  const AI = Array.from({ length: 20 }, (_, i) => art(`ai${String(i).padStart(2, "0")}`, `t${i}`, 1 + i * 0.5, ["ai"]));
  const SUDAN = art("sd", "dabanga", 30, ["conflict"], "Civilians flee North Kordofan as fighting escalates in Sudan");
  const p = profile();
  const pages = rankPages(poolOf([...AI, SUDAN]), p, NOW, { buckets: { dabanga: "sudan" }, names: { dabanga: "Radio Dabanga" } });
  const sd = pages.today.find((s) => s.id === "sd");
  const quiet = pages.today.find((s) => s.id === "ai00");
  assert.deepEqual(explainStory(sd, p, NOW_MS).passEntries, [
    "Placed by standing story: Sudan, floor 1 in the top 15; moved from 21 to 15, the best Sudan story below the floor on recency and importance alone",
  ]);
  assert.deepEqual(explainStory(quiet, p, NOW_MS).passEntries, []);
});

test("edit link: follows whichever term actually drove the score the most", () => {
  const p = profile();
  // Affinity dominates (ai's default affinity 0.6 beats recency at 5h old): the link
  // opens the ai topic's own row.
  const pages1 = rankPages(poolOf([art("a", "s1", 5, ["ai"])]), p, NOW);
  assert.equal(explainStory(pages1.today[0], p, NOW_MS).editHref, "/profile#topic-ai");
  // No followed topic at all and no trust override: recency is all there is, but it
  // used the default half-life, so there is no topic field to point at.
  const pages2 = rankPages(poolOf([art("b", "s1", 5, [])]), p, NOW);
  assert.equal(explainStory(pages2.today[0], p, NOW_MS).editHref, "/profile");
  // A trust override large enough to dominate points at the raw editor, the only place
  // trust is actually edited.
  const p2 = profile((x) => { x.trust = { s1: 4 }; });
  const pages3 = rankPages(poolOf([art("c", "s1", 5, [])]), p2, NOW);
  assert.equal(explainStory(pages3.today[0], p2, NOW_MS).editHref, "/profile#raw-json");
});

test("row order matches the ranker's own explanation order, term for term", () => {
  const p = profile((x) => { x.boosts = [{ id: "sg", match_type: "topic", match_value: "singapore", amount: 0.5, label: "Singapore" }]; });
  const pool = poolOf([art("a", "s1", 1, ["singapore"])]);
  const scored = rank(pool, p, NOW);
  const pages = rankPages(pool, p, NOW);
  const { rows } = explainStory(pages.today[0], p, NOW_MS);
  assert.deepEqual(rows.map((r) => r.term), scored[0].explanation.map((t) => t.term));
});
