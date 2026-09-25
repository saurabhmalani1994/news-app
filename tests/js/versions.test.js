// V1: the versions carousel's pure logic (js/versions.js) and its compared signal
// (js/history/compared.js). Which versions a cluster shows and in what order, what folds
// into a slide ("Also carried by", "More from this outlet"), that a muted source is
// never shown or counted, that lean never moves anything, the word marks, the one
// profile setting, and that "compared" feeds no ranking input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BV_TERMS, LOCALITY_WORDS, MIN_MARK_VERSIONS, STOPWORDS, buildVersions, bvOf, localityLabel, markSegments, orderVersions,
  trustTerm, uniqueWords, versionScore, versionsContext, withWordMarks, wordKey, wordMarksOn,
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
  // B8: the cron's fact terms (original, complete, depth, headline, locality, first,
  // health, paywall). Reuters' own copy scores over the two outlets that reran it.
  bv: {
    lead: [20, 7, 0, 4, 0, 10, 0, 0], // 41
    wire1: [20, 7, 0, 4, 0, 8, 0, 0], // 39
    wire2: [0, 7, 0, 4, 0, 8, 0, 0], // 19
    wire3: [0, 7, 0, 4, 0, 9, 0, 0], // 20
    fox1: [20, 7, 0, 2, 0, 9, 0, 0], // 38
    fox2: [20, 7, 0, 0, 0, 6, 0, 0], // 33
    bbc: [20, 15, 3, 6, 0, 7, 0, 0], // 51
    kyodo: [20, 7, 0, 2, 0, 5, 0, -5], // 29
  },
};
const CTX = versionsContext(INPUT);
const OPTS = { leadId: "lead", nowMs: NOW_MS };

test("one slide per version: a syndicated group folds to one slide, an outlet's pieces to one", () => {
  const slides = buildVersions(CLUSTER, CTX, OPTS);
  assert.deepEqual(slides.map((s) => s.sourceId).sort(),
    ["bbc_world", "reuters_a", "fox_politics", "kyodo_news", "npr"].sort());
  const wire = slides.find((s) => s.also.length);
  assert.equal(wire.id, "wire1"); // the best-scored copy of the three, the wire's own, faces the group
  assert.deepEqual(wire.also.map((a) => a.sourceName), ["CNA Asia", "PBS NewsHour"]);
  const fox = slides.find((s) => s.sourceId === "fox_politics");
  assert.equal(fox.id, "fox1");
  assert.deepEqual(fox.more.map((m) => m.id), ["fox2"]);
  // Every member shows exactly once: as a face, in "also", or in "more".
  const shown = slides.flatMap((s) => [s.id, ...s.also.map((a) => a.id), ...s.more.map((m) => m.id)]);
  assert.deepEqual([...shown].sort(), ARTICLES.map((a) => a.id).sort());
});

test("the lead comes first, then the best-version score (B8); the facts come from the page", () => {
  const slides = buildVersions(CLUSTER, CTX, OPTS);
  assert.equal(slides[0].id, "lead");
  assert.deepEqual(slides.map((s) => s.id), ["lead", "bbc", "wire1", "fox1", "kyodo"]);
  assert.deepEqual(slides[1].bv, INPUT.bv.bbc);
  assert.equal(slides[0].dek, "The vote was 51 to 49.");
  assert.equal(slides[0].url, "https://example.org/lead");
  const bbc = slides.find((s) => s.id === "bbc");
  assert.equal(bbc.hasBody, true);
  assert.equal(bbc.headline, "US Senate passes $1.2tn spending bill");
  // B5's trust term: Kyodo at 2.0 doubles its 29 to 58 and passes the BBC's 51; the
  // lead stays first when it is forced, whatever its trust.
  const trusted = buildVersions(CLUSTER, CTX, { ...OPTS, trust: { kyodo_news: 2, npr: 0.1 } });
  assert.deepEqual(trusted.map((s) => s.id), ["lead", "kyodo", "bbc", "wire1", "fox1"]);
});

test("a muted source is never shown and never counted, even inside a syndicated group", () => {
  const all = buildVersions(CLUSTER, CTX, OPTS);
  const muted = buildVersions(CLUSTER, CTX, { ...OPTS, muted: ["kyodo_news", "pbs_newshour", "fox_politics"] });
  assert.equal(muted.length, all.length - 2);
  const names = JSON.stringify(muted);
  for (const id of ["kyodo", "wire2", "fox1", "fox2"]) assert.ok(!names.includes(`"${id}"`), id);
  assert.deepEqual(muted.find((s) => s.id === "wire1").also.map((a) => a.sourceName), ["CNA Asia"]);
});

test("an outlet that leads a syndicated group and ran its own piece shows once", () => {
  const cluster = { ...CLUSTER, article_ids: [...CLUSTER.article_ids, "cna_own"] };
  const ctx = versionsContext({ ...INPUT, bv: { ...INPUT.bv, wire3: [20, 7, 0, 4, 15, 9, 0, 0] },
    pool: { articles: [...ARTICLES, { id: "cna_own", source_id: "cna_asia", title: "Singapore watches the US budget", published_at: iso(1) }], clusters: [cluster] } });
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

test("orderVersions is the one ordering: lead, bv sum, earlier report, source id", () => {
  const v = (id, sourceId, hoursAgo, bv = null) => ({ id, sourceId, publishedAt: iso(hoursAgo), bv });
  const terms = (sum) => [20, 7, 0, 0, 0, sum - 27, 0, 0];
  const list = [v("b", "s2", 2, terms(30)), v("a", "s1", 2, terms(30)), v("e", "s0", 3, terms(30)),
    v("c", "s3", 1, terms(45)), v("n", "s5", 0), v("l", "s4", 9, terms(10))];
  // c scores most; a, b and e tie at 30, so the earlier report (e) goes first, then
  // source id; n, unscored, sums to 0; the lead is first whatever it scores.
  assert.deepEqual(orderVersions(list, { leadId: "l" }).map((x) => x.id), ["l", "c", "e", "a", "b", "n"]);
  assert.deepEqual(orderVersions([...list].reverse(), { leadId: "l" }).map((x) => x.id), ["l", "c", "e", "a", "b", "n"]);
  const s = versionScore(v("x", "s1", 12, [20, 15, 4, -4, 8, 10, -5, 0]), { trust: { s1: 1.5 } });
  assert.deepEqual(s, { base: 48, trust: 24, score: 72 }); // B5: (1.5 - 1) x 48
  assert.equal(trustTerm(v("x", "s1", 1), 48, { s1: 1.5 }), 24);
  assert.equal(versionScore(v("y", "s1", 1)).score, 0);
});

test("bvOf reads the page's eight integers and nothing else", () => {
  assert.equal(BV_TERMS.length, 8);
  assert.deepEqual(bvOf("bbc", CTX), INPUT.bv.bbc);
  assert.equal(bvOf("nope", CTX), null);
  const ctx = versionsContext({ ...INPUT, bv: { a: [1, 2, 3], b: [1, 2, 3, 4, 5, 6, 7, 8.5], c: "x" } });
  for (const id of ["a", "b", "c"]) assert.equal(bvOf(id, ctx), null, id);
  assert.equal(bvOf("lead", versionsContext({ ...INPUT, bv: undefined })), null);
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
