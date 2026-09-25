// W1 (R50): phrase interests on the phone. The match rule (whole words, in order, any
// case, plural "s" folded), the watch tag against a fixed vector and against both
// SHA-256s (the ranker's own and Web Crypto's), and the ranker counting a phrase match
// in affinity at the interest's level, exactly like a topic, with why-this naming it.
// The phrases here are made up for the test; no owner phrase is ever in the repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  textWords, containsWords, normalizePhrase, phraseQuery, storyQuery, normalizeQuery, sha256Hex,
  watchTagSync, phraseMatcher, matchesPhrase, isPhraseTopic, QUERY_MAX,
} from "../../app/static/js/phrase.js";
import { watchTag } from "../../app/static/js/interests-sync.js";
import { rank, storiesFromPool, profileKey } from "../../app/static/js/ranker.js";
import { explainStory } from "../../app/static/js/why-this.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { levelOf } from "../../app/static/js/profile/you-edits.js";

const matches = (phrase, text) => matchesPhrase([textWords(text)], [], phraseMatcher(phrase));

test("match: whole words, in order, adjacent, any case", () => {
  assert.ok(matches("heat pump", "Heat pump sales double in Norway"));
  assert.ok(matches("heat pump", "Why the HEAT PUMP is winning"));
  assert.ok(matches("Heat Pump", "cheap heat pump subsidies"));
  assert.ok(!matches("heat pump", "Pump heat into the grid"), "order matters");
  assert.ok(!matches("heat pump", "Heat wave strains the pump network"), "the words must be next to each other");
  assert.ok(!matches("heat pump", "Heatpump makers merge"), "a run-together word is another word");
  assert.ok(!matches("pump", "Pumpkin prices rise"), "a word boundary: pump is not pumpkin");
  assert.ok(!matches("ion", "Nation celebrates"), "a word boundary inside a word");
  assert.ok(!matches("sodium battery", "Sodium-ion battery plant opens"), "an extra word in between breaks the phrase");
});

test("match: a plural s folds both ways, a possessive drops, punctuation and accents are boundaries", () => {
  assert.ok(matches("heat pump", "Heat pumps are selling"));
  assert.ok(matches("heat pumps", "A heat pump for every home"));
  assert.ok(matches("battery plant", "Battery plants face delays"));
  assert.ok(matches("sodium battery", "Sodium batteries get cheaper"), "an -ies plural folds too");
  assert.ok(matches("movie", "Movies return to cinemas"), "and a plain -s plural of an -ie word still agrees");
  assert.ok(matches("tesla", "Tesla's quarter beats forecasts"));
  assert.ok(matches("heat pump", "Heat-pump maker raises prices"));
  assert.ok(matches("heat pump", "the heat/pump debate"));
  assert.ok(matches("cafe culture", "Café culture returns"));
  assert.ok(!matches("glass", "Glasses of wine"), "only a plain plural s folds; glass stays glass");
  assert.ok(matches("gas", "Gas prices fall"), "a short word keeps its s");
  assert.deepEqual(textWords("Tesla's heat-pumps: DON'T"), ["tesla", "heat", "pump", "dont"]);
});

test("match: a watch tag alone is a match, and a phrase never runs from one text into the next", () => {
  const m = phraseMatcher("sodium battery");
  assert.ok(matchesPhrase([textWords("Grid storage news")], [m.tag], m));
  assert.ok(!matchesPhrase([textWords("A new sodium"), textWords("Battery makers merge")], [], m));
  assert.ok(!containsWords(["a"], []), "an empty phrase matches nothing");
});

test("tag: a fixed vector, the ranker's SHA-256, Node's and Web Crypto's all agree", async () => {
  assert.equal(phraseQuery("heat pump"), "\"heat pump\"");
  assert.equal(watchTagSync("\"heat pump\""), "w:d8e4ee5a1b");
  assert.equal(watchTagSync("  \"HEAT   pump\" "), "w:d8e4ee5a1b", "normalized: trimmed, lowercased, spaces collapsed");
  assert.equal(await watchTag("\"heat pump\""), "w:d8e4ee5a1b");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  for (const text of ["a", "x".repeat(55), "x".repeat(56), "x".repeat(64), "café 漢字 🙂", "y".repeat(1000)]) {
    assert.equal(sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"), `length ${text.length}`);
  }
  const story = storyQuery(["gaza", "israel", "west bank"]);
  assert.equal(story, "\"gaza\" OR \"israel\" OR \"west bank\"");
  assert.equal(await watchTag(story), watchTagSync(story));
  assert.equal(normalizeQuery(" A  b "), "a b");
});

test("queries: a phrase loses its quotes, a story keeps whole keywords within 100 characters", () => {
  assert.equal(normalizePhrase("  “heat   pump” "), "heat pump");
  assert.equal(normalizePhrase("\"\"  "), "");
  assert.equal(normalizePhrase("!!"), "", "nothing matchable");
  const long = storyQuery(Array.from({ length: 30 }, (_, i) => `keyword number ${i}`));
  assert.ok(long.length <= QUERY_MAX && long.endsWith("\""), long);
  assert.equal(storyQuery(["Sudan", "sudan", " "]), "\"Sudan\"", "repeats and blanks dropped");
});

// --- The ranker. ---
const NOW = "2026-09-24T12:00:00Z";
const NOW_MS = Date.parse(NOW);
const iso = (h) => new Date(NOW_MS - h * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
const pool = {
  generated_at: NOW,
  articles: [
    { id: "a1", source_id: "s1", title: "Heat pumps outsell gas boilers", published_at: iso(2), topics: ["economy"] },
    { id: "a2", source_id: "s2", title: "Grid news of the day", dek: "A cheap heat pump for flats arrives", published_at: iso(2), topics: ["economy"] },
    { id: "a3", source_id: "s3", title: "Storage makers merge", published_at: iso(2), topics: ["economy"], watch: ["w:d8e4ee5a1b"] },
    { id: "a4", source_id: "s4", title: "Pump prices and heat waves", published_at: iso(2), topics: ["economy"] },
  ],
  clusters: [],
};
const withPhrase = (edit = {}) => {
  const p = buildDefaultProfile(NOW);
  p.topics.p_heat_pump = { label: "heat pump", phrase: "heat pump", affinity: 0.9, half_life_hours: 24, enabled: true, ...edit };
  return p;
};

test("ranker: a phrase matches a headline, a dek or a watch tag, and earns affinity at its level", () => {
  const ranked = rank(pool, withPhrase(), NOW);
  const by = Object.fromEntries(ranked.map((s) => [s.id, s]));
  for (const id of ["a1", "a2", "a3"]) {
    assert.deepEqual(by[id].topics_matched, ["p_heat_pump"], id);
    const affinity = by[id].explanation.find((t) => t.term === "affinity");
    assert.equal(affinity.value, 900_000, `${id}: affinity is the phrase interest's own 0.9`);
    const recency = by[id].explanation.find((t) => t.term === "recency");
    assert.match(recency.detail, /24h half-life/, `${id}: its half-life counts like a topic's`);
  }
  assert.deepEqual(by.a4.topics_matched, [], "the words in another order do not match");
  assert.equal(by.a4.explanation.find((t) => t.term === "affinity").value, 0);
  assert.ok(ranked.findIndex((s) => s.id === "a4") > 2, "the matches rank above the one that does not");
  assert.equal(levelOf(withPhrase().topics.p_heat_pump), "more");
});

test("ranker: a phrase that is off, or a topic without a phrase, never matches by phrase", () => {
  const off = rank(pool, withPhrase({ enabled: false }), NOW);
  assert.ok(off.every((s) => !s.topics_matched.includes("p_heat_pump")));
  const p = withPhrase();
  p.topics.economy = { label: "Economy", phrase: "heat pump", affinity: 0.5, half_life_hours: 12, enabled: true };
  const tagged = rank(pool, p, NOW).find((s) => s.id === "a4");
  assert.ok(!tagged.topics_matched.includes("economy"), "a phrase topic does not match by its id as a pool tag");
  assert.ok(isPhraseTopic(p.topics.economy) && !isPhraseTopic(p.topics.world));
});

test("ranker: stories carry deks and watch tags; the score still sums; the key sees phrases", () => {
  const [a2] = storiesFromPool({ articles: [pool.articles[1]], clusters: [] });
  assert.deepEqual(a2.deks, ["A cheap heat pump for flats arrives"]);
  const [a3] = storiesFromPool({ articles: [pool.articles[2]], clusters: [] });
  assert.deepEqual(a3.watch, ["w:d8e4ee5a1b"]);
  for (const s of rank(pool, withPhrase(), NOW)) assert.equal(s.score, s.explanation.reduce((t, x) => t + x.value, 0));
  assert.notEqual(profileKey(withPhrase()), profileKey(buildDefaultProfile(NOW)), "the device re-ranks for a phrase");
});

test("why this names the phrase, alone and beside a topic", () => {
  const p = withPhrase();
  const [story] = rank({ ...pool, articles: [pool.articles[0]] }, p, NOW);
  const row = explainStory(story, p, NOW_MS).rows.find((r) => r.term === "affinity");
  assert.equal(row.label, "Your phrase “heat pump”");
  assert.equal(row.editHref, "/profile#topic-p_heat_pump");
  const both = { ...story, topics_matched: ["economy", "p_heat_pump"] };
  const p2 = withPhrase();
  p2.topics.economy = { label: "Economy", affinity: 0.5, half_life_hours: 12, enabled: true };
  assert.equal(explainStory(both, p2, NOW_MS).rows.find((r) => r.term === "affinity").label,
    "Your Economy interest and phrase “heat pump”");
});
