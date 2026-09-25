// V1: the versions carousel's pure logic (js/versions.js) and its compared signal
// (js/history/compared.js). Which versions a cluster shows and in what order, what folds
// into a slide ("Also carried by", "More from this outlet"), that a muted source is
// never shown or counted, that lean never moves anything, the word marks, the one
// profile setting, and that "compared" feeds no ranking input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LOCALITY_WORDS, MIN_MARK_VERSIONS, STOPWORDS, buildVersions, localityLabel, markSegments, orderVersions,
  uniqueWords, versionScore, versionsContext, withWordMarks, wordKey, wordMarksOn,
} from "../../app/static/js/versions.js";
import { COMPARED_KEY, MAX_STORIES, noteCompared, readCompared } from "../../app/static/js/history/compared.js";
import { SUMMARY_KEY, readSummary } from "../../app/static/js/history/summary.js";
import { MemoryStorage } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { validateProfile } from "../../app/static/js/profile/validate.js";
import { profileKey } from "../../app/static/js/ranker.js";

const schema = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));
const NOW = "2026-09-24T12:00:00Z";
const NOW_MS = Date.parse(NOW);
const iso = (hoursAgo) => new Date(NOW_MS - hoursAgo * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");

// Eight members: the lead (npr); one piece of wire copy carried by three outlets
// (reuters_a, pbs_newshour, cna_asia: an S07 near-duplicate group); fox with two pieces
// of its own; bbc; and kyodo, alone, the one the mute tests take away.
const ARTICLES = [
  { id: "lead", source_id: "npr", title: "Senate passes the budget bill", published_at: iso(1) },
  { id: "wire1", source_id: "reuters_a", title: "Senate approves budget bill after all-night session", published_at: iso(3) },
  { id: "wire2", source_id: "pbs_newshour", title: "Senate approves budget bill after all-night session", published_at: iso(3) },
  { id: "wire3", source_id: "cna_asia", title: "Senate approves budget bill after all-night session", published_at: iso(2) },
  { id: "fox1", source_id: "fox_politics", title: "GOP claims a win as the budget bill passes", published_at: iso(2) },
  { id: "fox2", source_id: "fox_politics", title: "What the budget bill means for your taxes", published_at: iso(5) },
  { id: "bbc", source_id: "bbc_world", title: "US Senate passes $1.2tn spending bill", published_at: iso(4) },
  { id: "kyodo", source_id: "kyodo_news", title: "US Senate passes budget", published_at: iso(6) },
];
const CLUSTER = {
  id: "c_lead", lead: "lead", independent_sources: 6,
  article_ids: ARTICLES.map((a) => a.id),
  near_duplicates: [["wire1", "wire2", "wire3"]],
};
const INPUT = {
  pool: { articles: ARTICLES, clusters: [CLUSTER] },
  names: { npr: "NPR", reuters_a: "Reuters", pbs_newshour: "PBS NewsHour", cna_asia: "CNA Asia", fox_politics: "Fox News Politics",
    bbc_world: "BBC World", kyodo_news: "Kyodo News" },
  leans: { npr: "center-left", reuters_a: "center", pbs_newshour: "center-left", cna_asia: "state", fox_politics: "right",
    bbc_world: "center", kyodo_news: "non-us" },
  countries: { kyodo_news: "JP" },
  ownership: { cna_asia: "state-owned" },
  coverage: Object.fromEntries(ARTICLES.map((a) => [a.id, { url: `https://example.org/${a.id}`, has_body: a.id === "bbc" }])),
  vdeks: { lead: "The vote was 51 to 49.", bbc: "Lawmakers worked through the night." },
};
const CTX = versionsContext(INPUT);
const OPTS = { leadId: "lead", nowMs: NOW_MS };

test("one slide per version: a syndicated group folds to one slide, an outlet's pieces to one", () => {
  const slides = buildVersions(CLUSTER, CTX, OPTS);
  assert.deepEqual(slides.map((s) => s.sourceId).sort(),
    ["bbc_world", "cna_asia", "fox_politics", "kyodo_news", "npr"].sort());
  const wire = slides.find((s) => s.also.length);
  assert.equal(wire.id, "wire3"); // the freshest copy of the three faces the group
  assert.deepEqual(wire.also.map((a) => a.sourceName), ["PBS NewsHour", "Reuters"]);
  const fox = slides.find((s) => s.sourceId === "fox_politics");
  assert.equal(fox.id, "fox1");
  assert.deepEqual(fox.more.map((m) => m.id), ["fox2"]);
  // Every member shows exactly once: as a face, in "also", or in "more".
  const shown = slides.flatMap((s) => [s.id, ...s.also.map((a) => a.id), ...s.more.map((m) => m.id)]);
  assert.deepEqual([...shown].sort(), ARTICLES.map((a) => a.id).sort());
});

test("the lead comes first, then trust times recency; the facts come from the page", () => {
  const slides = buildVersions(CLUSTER, CTX, OPTS);
  assert.equal(slides[0].id, "lead");
  assert.deepEqual(slides.map((s) => s.id), ["lead", "wire3", "fox1", "bbc", "kyodo"]);
  assert.equal(slides[0].dek, "The vote was 51 to 49.");
  assert.equal(slides[0].url, "https://example.org/lead");
  const bbc = slides.find((s) => s.id === "bbc");
  assert.equal(bbc.hasBody, true);
  assert.equal(bbc.headline, "US Senate passes $1.2tn spending bill");
  // Trust in an outlet moves its version up, never ahead of the lead.
  const trusted = buildVersions(CLUSTER, CTX, { ...OPTS, trust: { kyodo_news: 2, npr: 0.1 } });
  assert.deepEqual(trusted.map((s) => s.id).slice(0, 2), ["lead", "kyodo"]);
});

test("a muted source is never shown and never counted, even inside a syndicated group", () => {
  const all = buildVersions(CLUSTER, CTX, OPTS);
  const muted = buildVersions(CLUSTER, CTX, { ...OPTS, muted: ["kyodo_news", "pbs_newshour", "fox_politics"] });
  assert.equal(muted.length, all.length - 2);
  const names = JSON.stringify(muted);
  for (const id of ["kyodo", "wire2", "fox1", "fox2"]) assert.ok(!names.includes(`"${id}"`), id);
  assert.deepEqual(muted.find((s) => s.id === "wire3").also.map((a) => a.sourceName), ["Reuters"]);
});

test("an outlet that leads a syndicated group and ran its own piece shows once", () => {
  const cluster = { ...CLUSTER, article_ids: [...CLUSTER.article_ids, "cna_own"] };
  const ctx = versionsContext({ ...INPUT, pool: { articles: [...ARTICLES, { id: "cna_own", source_id: "cna_asia", title: "Singapore watches the US budget", published_at: iso(1) }], clusters: [cluster] } });
  const slides = buildVersions(cluster, ctx, OPTS);
  assert.equal(slides.filter((s) => s.sourceId === "cna_asia").length, 1);
  assert.deepEqual(slides.find((s) => s.sourceId === "cna_asia").more.map((m) => m.id), ["cna_own"]);
});

test("order never depends on input order, and changing only a lean moves nothing", () => {
  const base = buildVersions(CLUSTER, CTX, OPTS).map((s) => s.id);
  const shuffled = { ...CLUSTER, article_ids: [...CLUSTER.article_ids].reverse() };
  assert.deepEqual(buildVersions(shuffled, versionsContext({ ...INPUT, pool: { ...INPUT.pool, articles: [...ARTICLES].reverse() } }), OPTS).map((s) => s.id), base);
  const swapped = versionsContext({ ...INPUT, leans: { ...INPUT.leans, fox_politics: "left", npr: "right", bbc_world: "state" } });
  assert.deepEqual(buildVersions(CLUSTER, swapped, OPTS).map((s) => s.id), base);
});

test("orderVersions is the one ordering: lead, score, recency, source id", () => {
  const v = (id, sourceId, hoursAgo) => ({ id, sourceId, publishedAt: iso(hoursAgo) });
  const list = [v("b", "s2", 2), v("a", "s1", 2), v("c", "s3", 1), v("l", "s4", 9)];
  assert.deepEqual(orderVersions(list, { leadId: "l", nowMs: NOW_MS }).map((x) => x.id), ["l", "c", "a", "b"]);
  const s = versionScore(v("x", "s1", 12), { trust: { s1: 1.5 }, nowMs: NOW_MS });
  assert.equal(s.recency, 0.5);
  assert.equal(s.score, 0.75);
});

test("localityLabel is B4's seam: nothing until the page carries a tier", () => {
  assert.equal(localityLabel("lead", CTX), "");
  assert.equal(buildVersions(CLUSTER, CTX, OPTS)[0].locality, "");
  const ctx = versionsContext({ ...INPUT, locality: { lead: "local", bbc: "intermediate", kyodo: "overseas", wire3: "nearby" } });
  assert.equal(localityLabel("lead", ctx), "Local");
  assert.equal(localityLabel("bbc", ctx), LOCALITY_WORDS.intermediate);
  assert.equal(localityLabel("kyodo", ctx), "Overseas");
  assert.equal(localityLabel("wire3", ctx), "");
});

test("wordKey drops stopwords and lone letters, folds plurals, possessives and case", () => {
  assert.equal(wordKey("The"), null);
  assert.equal(wordKey("says"), null);
  assert.equal(wordKey("U"), null);
  assert.equal(wordKey("Talks"), "talk");
  assert.equal(wordKey("talk"), "talk");
  assert.equal(wordKey("parties"), "party");
  assert.equal(wordKey("Trump’s"), "trump");
  assert.equal(wordKey("Trump's"), "trump");
  assert.equal(wordKey("crisis"), "crisis");
  assert.equal(wordKey("Congress"), "congress");
  assert.equal(wordKey("197,000"), "197000");
  assert.ok(STOPWORDS.has("amid") && !STOPWORDS.has("us"));
});

test("word marks: only on 3 or more versions, only words no other headline used", () => {
  assert.deepEqual(uniqueWords(["Senate passes bill", "Senate approves bill"]), [null, null]);
  assert.equal(MIN_MARK_VERSIONS, 3);
  const marks = uniqueWords(["Senate passes the budget bill", "Senate approves budget bill", "US Senate passes $1.2tn spending bills"]);
  assert.deepEqual(marks.map((m) => [...m].sort()), [[], ["approve"], ["1.2tn", "spending", "us"]]);
});

test("markSegments splits the headline's own text, joins back exactly, and runs marks together", () => {
  const text = 'Xi’s "talks" with Trump end <b>in</b> a deal';
  const segs = markSegments(text, new Set(["talk", "trump", "end", "deal"]));
  assert.equal(segs.map((s) => s.text).join(""), text);
  assert.deepEqual(segs.filter((s) => s.mark).map((s) => s.text), ["talks", "Trump end", "deal"]);
  assert.deepEqual(markSegments("Plain", null), [{ text: "Plain", mark: false }]);
  assert.deepEqual(markSegments("", new Set(["x"])), []);
});

test("the word-mark switch: on by default, one profile field, valid, never a ranking input", () => {
  const profile = buildDefaultProfile(NOW);
  assert.equal(wordMarksOn(profile), true);
  assert.equal(withWordMarks(profile, true), null);
  const off = withWordMarks(profile, false);
  assert.equal(off.display.word_marks, false);
  assert.equal(wordMarksOn(off), false);
  assert.deepEqual(validateProfile({ ...off, profile_version: 2 }, schema), []);
  assert.notDeepEqual(validateProfile({ ...off, display: { word_marks: "no" } }, schema), []);
  assert.equal(profileKey(off), profileKey(profile));
  assert.equal(withWordMarks(off, "yes"), null);
});

test("compared is recorded apart from the seen summary, capped, and read back", () => {
  const storage = new MemoryStorage();
  noteCompared(storage, "c_lead", "bbc", NOW);
  noteCompared(storage, "c_lead", "bbc", NOW);
  noteCompared(storage, "c_lead", "kyodo", NOW);
  assert.deepEqual(readCompared(storage).c_lead, { time: NOW, ids: ["bbc", "kyodo"] });
  assert.equal(storage.getItem(SUMMARY_KEY), null);
  assert.deepEqual(readSummary(storage), { opened: {}, shown: {} });
  for (let i = 0; i < MAX_STORIES + 5; i++) noteCompared(storage, `c_${i}`, "a", NOW);
  const all = readCompared(storage);
  assert.equal(Object.keys(all).length, MAX_STORIES);
  assert.ok(!("c_lead" in all) && "c_204" in all);
  noteCompared(storage, "", "a", NOW);
  storage.setItem(COMPARED_KEY, "not json");
  assert.deepEqual(readCompared(storage), {});
});

test("no ranking input reads the compared record", () => {
  for (const file of ["ranker.js", "passes.js", "rank-gate.js", "rerank.js", "history/penalty.js", "history/summary.js"]) {
    const text = readFileSync(new URL(`../../app/static/js/${file}`, import.meta.url), "utf-8");
    assert.ok(!text.includes("compared"), file);
  }
});
