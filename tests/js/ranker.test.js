// S11 proof: the ranker is deterministic and order-blind, every score is the exact sum
// of its explanation, one topic weight moves only that topic's stories and in the
// expected direction, must-know eligibility follows R16, and the head gate re-ranks
// only for a profile whose ranking fields differ from the default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { rank, mustKnowEligible, storiesFromPool, profileKey, canonical, HARD_NEWS, SCALE } from "../../app/static/js/ranker.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const NOW = "2026-09-24T12:00:00Z";
const TAGS = [["world"], ["politics"], ["ai"], ["singapore", "asia"], ["biotech", "science"], ["conflict", "world"], ["economy"], ["ai", "world"]];
const LEANS = ["center", "center-left", "left", "non-us", "right", "state"];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function shuffle(xs, rand) {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function fixturePool() {
  const articles = [];
  for (let i = 0; i < 60; i++) {
    articles.push({
      id: `a${String(i).padStart(3, "0")}`,
      source_id: `s${i % 9}`,
      url: `https://example.org/${i}`,
      title: i % 7 === 0 ? `Tariff talks, part ${i}` : `Story ${i}`,
      published_at: new Date(Date.parse(NOW) - ((i * 37) % 60) * 3_600_000 / 2).toISOString().replace(/\.\d+Z$/, "Z"),
      topics: TAGS[i % TAGS.length],
    });
  }
  const clusters = [];
  for (let c = 0; c < 8; c++) {
    const ids = [0, 1, 2, 3].map((k) => articles[c * 5 + k].id).slice(0, 2 + (c % 3));
    clusters.push({
      id: `c${c}`, method: "cosine_entity", article_ids: ids, near_duplicates: [],
      independent_sources: 1 + (c % 4), lean_buckets: LEANS.slice(0, 1 + (c % 3)),
    });
  }
  return { schema_version: 1, generated_at: NOW, sources: [], articles, clusters };
}

const profile = () => buildDefaultProfile("2026-09-24T00:00:00Z");
const summary = (ranked) => ranked.map((s) => [s.id, s.score, s.explanation.map((t) => [t.term, t.value])]);

test("same inputs give byte-identical output", () => {
  const a = rank(fixturePool(), profile(), NOW);
  const b = rank(structuredClone(fixturePool()), structuredClone(profile()), NOW);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.length, storiesFromPool(fixturePool()).length);
});

test("input order never matters: arrays, member ids, tags, boosts, profile keys", () => {
  const p = profile();
  p.boosts = [
    { id: "tariffs", label: "Tariffs", match_type: "keyword", match_value: "tariff", amount: 0.4 },
    { id: "s3", label: "Source 3", match_type: "source", match_value: "s3", amount: -0.2 },
  ];
  p.trust = { s1: 1.5, s2: 0.5 };
  const expected = JSON.stringify(rank(fixturePool(), p, NOW));
  const rand = rng(11);
  for (let n = 0; n < 25; n++) {
    const pool = fixturePool();
    pool.articles = shuffle(pool.articles, rand).map((a) => ({ ...a, topics: shuffle(a.topics, rand) }));
    pool.clusters = shuffle(pool.clusters, rand).map((c) => ({ ...c, article_ids: shuffle(c.article_ids, rand), lean_buckets: shuffle(c.lean_buckets, rand) }));
    const q = structuredClone(p);
    q.boosts = shuffle(q.boosts, rand);
    q.topics = Object.fromEntries(shuffle(Object.entries(q.topics), rand));
    assert.equal(JSON.stringify(rank(pool, q, NOW)), expected);
  }
});

test("every score is the exact integer sum of its named terms", () => {
  const p = profile();
  p.trust = { s0: 0, s4: 1.7, s5: 0.3 };
  p.boosts = [{ id: "k", label: "K", match_type: "keyword", match_value: "tariff", amount: 0.35 },
    { id: "t", label: "T", match_type: "topic", match_value: "ai", amount: -0.15 }];
  let checked = 0;
  for (const prof of [profile(), p]) {
    for (const s of rank(fixturePool(), prof, NOW)) {
      assert.ok(Number.isInteger(s.score), s.id);
      for (const t of s.explanation) assert.ok(Number.isInteger(t.value) && typeof t.term === "string" && t.term, s.id);
      assert.equal(s.explanation.reduce((sum, t) => sum + t.value, 0), s.score, s.id);
      checked++;
    }
  }
  assert.ok(checked > 80);
  assert.equal(SCALE, 1_000_000);
});

test("the result is ordered by score, best first", () => {
  const ranked = rank(fixturePool(), profile(), NOW);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score);
});

function carries(story, topic) {
  return story.topics_matched.includes(topic);
}

for (const [topic, from, to] of [["ai", 0.6, 1], ["ai", 0.6, 0], ["singapore", 0.9, 0.2], ["us_politics", 0.8, 1]]) {
  test(`${topic} ${from} -> ${to} moves only ${topic} stories, ${to > from ? "up" : "down"}`, () => {
    const before = rank(fixturePool(), profile(), NOW);
    const p = profile();
    p.topics[topic].affinity = to;
    const after = rank(fixturePool(), p, NOW);
    const prev = new Map(before.map((s) => [s.id, s]));
    let moved = 0;
    for (const s of after) {
      const old = prev.get(s.id);
      if (!carries(old, topic)) {
        assert.equal(s.score, old.score, `${s.id} does not carry ${topic} and must not move`);
        continue;
      }
      if (to > from) assert.ok(s.score >= old.score, s.id);
      else assert.ok(s.score <= old.score, s.id);
      if (s.score !== old.score) moved++;
    }
    assert.ok(moved > 0, "the change reaches at least one story");
    // Stories without the topic keep their order among themselves, and every story
    // with it has no more (up) or no fewer (down) of them above it than before.
    const others = (list) => list.filter((s) => !carries(prev.get(s.id), topic)).map((s) => s.id);
    assert.deepEqual(others(after), others(before));
    const aboveCount = (list, id) => others(list.slice(0, list.findIndex((s) => s.id === id))).length;
    for (const s of after.filter((x) => carries(prev.get(x.id), topic))) {
      const [a, b] = [aboveCount(after, s.id), aboveCount(before, s.id)];
      assert.ok(to > from ? a <= b : a >= b, s.id);
    }
  });
}

test("must-know eligibility follows R16", () => {
  const story = (topics, independent, leans) => ({ topics, independent_sources: independent, lean_buckets: leans });
  assert.equal(mustKnowEligible(story(["world"], 2, ["center", "right"])), true);
  assert.equal(mustKnowEligible(story(["economy", "ai"], 5, ["left", "right", "state"])), true);
  // Not hard news: however wide the coverage, never eligible.
  assert.equal(mustKnowEligible(story(["ai", "asia", "singapore", "biotech"], 9, LEANS)), false);
  // One lean bucket: not enough spread.
  assert.equal(mustKnowEligible(story(["world", "conflict"], 6, ["center"])), false);
  // Syndication breadth alone: one piece of copy across leans is one independent source.
  assert.equal(mustKnowEligible(story(["politics"], 1, ["left", "right"])), false);
  // A single article is never eligible.
  const single = storiesFromPool({ articles: [{ id: "x", source_id: "s", title: "t", published_at: NOW, topics: ["world"] }] })[0];
  assert.equal(mustKnowEligible(single), false);
  assert.deepEqual([...HARD_NEWS].sort(), [...JSON.parse(readFileSync(new URL("../../topics.json", import.meta.url), "utf-8")).hard_news].sort());
  // In a ranking, eligible stories (and only they) carry the must_know topic.
  for (const s of rank(fixturePool(), profile(), NOW)) {
    assert.equal(s.must_know, mustKnowEligible(s));
    assert.equal(s.topics_matched.includes("must_know"), s.must_know);
  }
});

test("seams: extra terms join the sum, passes run in order and name themselves", () => {
  const seen = { name: "seen", fn: (s) => (s.id === "a059" ? -3 : 0) };
  const tag = { name: "noop", fn: (list) => list.map((s) => ({ ...s, passes: [...s.passes, "noop"] })) };
  const ranked = rank(fixturePool(), profile(), NOW, { terms: [seen], passes: [tag] });
  for (const s of ranked) {
    assert.equal(s.explanation.at(-1).term, "seen");
    assert.equal(s.explanation.reduce((sum, t) => sum + t.value, 0), s.score);
    assert.deepEqual(s.passes, ["noop"]);
  }
  assert.equal(ranked.find((s) => s.id === "a059").explanation.at(-1).value, -3 * SCALE);
});

function runGate(stored, key) {
  const classes = new Set();
  const appended = [];
  const root = { getAttribute: () => key, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } };
  const context = {
    localStorage: { getItem: () => (stored ? JSON.stringify({ history: [{ version: 1, profile: stored }] }) : null) },
    document: { documentElement: root, createElement: () => ({}), head: { appendChild: (el) => appended.push(el) } },
    window: {}, setTimeout: () => 0, JSON,
  };
  vm.runInNewContext(readFileSync(new URL("../../app/static/js/rank-gate.js", import.meta.url), "utf-8"), context);
  return { hidden: classes.has("rerank"), scripts: appended.map((s) => s.src), profile: context.window.almanacProfile };
}

test("head gate: default or missing profile paints as built; a changed one re-ranks", () => {
  const key = profileKey(profile());
  assert.deepEqual(runGate(null, key), { hidden: false, scripts: [], profile: undefined });
  const later = profile();
  later.profile_version = 7;
  later.updated_at = "2026-09-30T00:00:00Z";
  later.topics = Object.fromEntries(Object.entries(later.topics).reverse());
  assert.equal(runGate(later, key).hidden, false, "versions, timestamps and key order are not ranking changes");
  const changed = profile();
  changed.topics.ai.affinity = 1;
  const r = runGate(changed, key);
  assert.equal(r.hidden, true);
  assert.deepEqual(r.scripts, ["js/rerank.js"]);
  assert.equal(r.profile.topics.ai.affinity, 1);
  // The gate's canonical form is ranker.js's, byte for byte.
  const gate = readFileSync(new URL("../../app/static/js/rank-gate.js", import.meta.url), "utf-8");
  const ranker = readFileSync(new URL("../../app/static/js/ranker.js", import.meta.url), "utf-8");
  const body = (src) => src.match(/function canonical\(v\) \{[\s\S]*?\n\s*\}/)[0].split("\n").map((l) => l.trim()).join("\n");
  assert.equal(body(gate), body(ranker));
  assert.equal(canonical({ b: 1, a: [2, { d: 0, c: null }] }), '{"a":[2,{"c":null,"d":0}],"b":1}');
});
