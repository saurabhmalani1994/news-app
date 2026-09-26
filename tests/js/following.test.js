// W3 proof: what the owner follows, and the stories that match each right now. Two
// phrase interests at Normal and the hourly search's items carrying their watch tags
// (the W1/W2 rule: "w:" and 10 hex of SHA-256 over the quoted phrase, normalized), plus
// headline and dek matches and a decoy. Every match gets the affinity term and why-this
// names the phrase; followMatches lists exactly those stories, newest first, for each
// phrase and each standing story; a muted outlet's story is left out; a Google News item
// with no dek and no photo is listed; a standing story counts its own search's items
// even when the headline lacks a keyword, under its tag rule. The phrases are invented.
import { test } from "node:test";
import assert from "node:assert/strict";

import { rankPages } from "../../app/static/js/passes.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { withPhraseAdded } from "../../app/static/js/profile/you-edits.js";
import { phraseQuery, storyQuery, watchTagSync } from "../../app/static/js/phrase.js";
import { standingStories, qualifies } from "../../app/static/js/standing.js";
import { explainStory } from "../../app/static/js/why-this.js";
import { FOLLOW_PREVIEW, countWords, followFor, followList, followMatches } from "../../app/static/js/following.js";

const NOW = "2026-09-24T12:00:00Z";
const NOW_MS = Date.parse(NOW);
const iso = (hours) => new Date(NOW_MS - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
const art = (id, source_id, hours, title, extra = {}) => ({ id, source_id, title, published_at: iso(hours), topics: ["world"], ...extra });

const ONE = "Harbor Tunnel";
const TWO = "Copper Valley";
const TAG_ONE = watchTagSync(phraseQuery(ONE));
const TAG_TWO = watchTagSync(phraseQuery(TWO));

function withPhrases(profile = buildDefaultProfile(NOW)) {
  return withPhraseAdded(withPhraseAdded(profile, ONE), TWO);
}

// Twenty busy world stories outrank everything else, so the matches sit below the fold.
const FILLERS = Array.from({ length: 40 }, (_, i) => art(`f${String(i).padStart(2, "0")}`, `s${i}`, 0.5 + i * 0.1,
  `Busy world filler number ${i} about nothing in particular`, { topics: ["world", "us_politics"] }));

function pool() {
  return {
    generated_at: NOW,
    articles: [
      ...FILLERS,
      // Google News search items (W2): no dek, no photo, the watch tag only.
      art("g1", "google_news_search", 2, "Commuters face a long detour this week", { watch: [TAG_ONE] }),
      art("g2", "google_news_search", 5, "Mine reopens after a two-year pause", { watch: [TAG_TWO] }),
      art("g3", "google_news_search", 1, "Both projects win state money", { watch: [TAG_ONE, TAG_TWO] }),
      // A feed story whose headline holds the phrase, and one whose dek holds it.
      art("h1", "npr", 3, "Harbor tunnel repairs begin on Monday"),
      art("d1", "bbc", 4, "City council votes on transit", { dek: "The harbor tunnels will close at night." }),
      // Decoy: the words out of order.
      art("x1", "npr", 1, "Tunnel under the harbor floods again"),
      // A match from an outlet the owner muted.
      art("m1", "muted_outlet", 0.5, "Harbor Tunnel tolls rise"),
    ],
    clusters: [],
  };
}

const input = () => ({ now: NOW, pool: pool(), buckets: {}, leans: {}, names: { npr: "NPR", bbc: "BBC", google_news_search: "Google News" }, health: {}, events: [], bv: {} });
const muted = (p) => ({ ...p, mutes: { ...p.mutes, sources: ["muted_outlet"] } });

test("followList: phrases that are on, then standing stories, each with its own page", () => {
  const p = withPhrases();
  const list = followList(p);
  assert.deepEqual(list.map((f) => f.kind), ["phrase", "phrase", "story", "story"]);
  assert.deepEqual(list.slice(0, 2).map((f) => f.label), [`“${ONE}”`, `“${TWO}”`]);
  assert.match(list[0].href, /^\/profile#interest\/p_/);
  assert.deepEqual(list.slice(2).map((f) => f.href), ["/profile#story/israel_gaza", "/profile#story/sudan"]);
  const off = structuredClone(p);
  off.topics[list[1].id].enabled = false;
  assert.deepEqual(followList(off).filter((f) => f.kind === "phrase").map((f) => f.label), [`“${ONE}”`]);
});

test("every match gets the affinity term, and why-this names the phrase", () => {
  const p = withPhrases();
  const [one, two] = followList(p);
  const { today } = rankPages(pool(), p, NOW, { buckets: {}, leans: {}, names: {} });
  const at = (id) => today.findIndex((s) => s.id === id);
  for (const [sid, phrase] of [["g1", one.id], ["h1", one.id], ["d1", one.id], ["g2", two.id], ["g3", one.id], ["g3", two.id]]) {
    const story = today[at(sid)];
    assert.ok(story.topics_matched.includes(phrase), `${sid} matches ${phrase}`);
    const why = explainStory(story, p, NOW_MS);
    const affinity = why.rows.find((r) => r.term === "affinity");
    assert.ok(affinity.value > 0);
    assert.match(affinity.label, sid === "g2" ? /Copper Valley/ : /Harbor Tunnel/);
  }
  assert.ok(!today[at("x1")].topics_matched.includes(one.id), "words out of order do not match");
  // At Normal the phrase lifts a match above the same story without it, though the
  // busy world stories still lead: it is findable, not necessarily on top.
  const plain = rankPages(pool(), buildDefaultProfile(NOW), NOW, {}).today;
  assert.ok(at("g2") < plain.findIndex((s) => s.id === "g2"));
});

test("followMatches: each phrase's stories newest first, muted outlets left out", () => {
  const p = muted(withPhrases());
  const follows = followMatches(input(), p);
  const [one, two] = follows;
  assert.deepEqual(one.stories.map((s) => s.id), ["g3", "g1", "h1", "d1"]);
  assert.deepEqual(two.stories.map((s) => s.id), ["g3", "g2"]);
  // Unmuted, the muted outlet's match is listed, newest of all.
  assert.equal(followMatches(input(), withPhrases())[0].stories[0].id, "m1");
  assert.equal(followFor(input(), p, "phrase", two.id).stories.length, 2);
  assert.equal(followFor(input(), p, "phrase", "p_nothing"), null);
});

test("a standing story counts its own search's items, under its tag rule", () => {
  const p = withPhrases();
  p.standing_stories = [...p.standing_stories, {
    id: "ferry", label: "Ferry strike", enabled: true, keywords: ["ferry strike", "ferry workers"], tags: [],
    buckets: [], floor_slots: 0, floor_within: 15, silence_hours: 0,
  }];
  const tag = watchTagSync(storyQuery(["ferry strike", "ferry workers"]));
  const data = input();
  data.pool.articles.push(art("s1", "google_news_search", 2, "Crossings cancelled as talks stall", { watch: [tag] }));
  data.pool.articles.push(art("s2", "npr", 3, "Ferry workers walk out"));
  const ferry = followMatches(data, p).find((f) => f.id === "ferry");
  assert.deepEqual(ferry.stories.map((s) => s.id), ["s1", "s2"]);
  // The tag rule still gates a search hit: Sudan's search found it, but it carries
  // neither of Sudan's tags, so it does not count.
  const sudan = standingStories(p).find((d) => d.id === "sudan");
  assert.ok(sudan.watch.startsWith("w:"));
  assert.ok(!qualifies({ titles: ["A football result"], topics: ["sports"], watch: [sudan.watch] }, sudan));
  assert.ok(qualifies({ titles: ["A football result"], topics: ["world"], watch: [sudan.watch] }, sudan));
});

test("the words a follow's count reads as", () => {
  assert.equal(countWords(0), "No stories now");
  assert.equal(countWords(1), "1 story now");
  assert.equal(countWords(12), "12 stories now");
  assert.equal(FOLLOW_PREVIEW, 5);
});

test("an exploration entry names a phrase by its phrase, never its id", () => {
  const p = withPhrases();
  const { today } = rankPages(pool(), p, NOW, {});
  const texts = today.flatMap((s) => s.passes.filter((e) => e.pass === "exploration").map((e) => e.text));
  assert.ok(texts.length > 0);
  for (const text of texts) assert.ok(!/\bp_/.test(text), text);
});
