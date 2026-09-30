// J1 proof: /api/jev (functions/api/jev.js) and the phone's Jev modules (js/jev/*).
// The function: Access required (the local dev stand-in only on this machine's own
// host), POST, same origin, JSON, size, question and state checks, the AI binding
// called with exactly {state, questions}, its answers cleaned, 503 with no binding, 502
// on a model error, the mock. The contract: a choice outside the criteria, an unknown
// key, a non-finite number are dropped. The Ask bar: Jev's answers become a proposal the
// real S19 gate accepts, and a proposal the gate refuses is never built into one that
// passes. The analysis: the state holds the story's own headlines only, and the view
// reads the verdict and rows in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handle, onRequest, route, openRouterKey, MAX_BODY_BYTES, OPENROUTER_URL, OPENROUTER_MODEL, callCost, USD_PER_TOKEN } from "../../functions/api/jev.js";
import { validateQuestions, validateState, normalizeAnswers, scoreIndex, MAX_QUESTIONS, toWire } from "../../app/static/js/jev/contract.js";
import { mockJev } from "../../app/static/js/jev/mock.js";
import { STORY_QUESTIONS, askQuestions, askTargets, NONE } from "../../app/static/js/jev/questions.js";
import { proposalFromAsk, askState, cleanRequest, strengthStep, confidenceLine, askSuggestions } from "../../app/static/js/jev/ask.js";
import { readChoice, readNoul, expectedPosition, RULES } from "../../app/static/js/jev/decide.js";
import { storyState, analysisView, analysisCache, CACHE_CAP, hourlyAnswers, questionsLeft, fromCompact } from "../../app/static/js/jev/story.js";
import { askJev, JevError } from "../../app/static/js/jev/client.js";
import { splitSentences, readingBlocks, readingQuestions, readingView, readingDensity, readingSections, readCache, TAKEAWAYS, NONE as READ_NONE } from "../../app/static/js/jev/read.js";
import { gateProposal } from "../../app/static/js/ai/gate.js";
import { recordRead, recordEvent, readingSummary, STATS_KEY, MIN_READS, RECENT_CAP } from "../../app/static/js/jev/read-stats.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { MemoryStorage } from "../../app/static/js/profile/store.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf-8");
const SCHEMAS = {
  profileSchema: JSON.parse(read("../../app/static/profile.schema.json")),
  proposalSchema: JSON.parse(read("../../app/static/proposal.schema.json")),
};

const LOCAL = "http://localhost:8788";
const DEV_ENV = { ACCESS_DEV_EMAIL: "dev@example.com" };

function post(body, { origin = LOCAL, headers = {}, raw = false } = {}) {
  const text = raw ? body : JSON.stringify(body);
  return new Request(`${origin}/api/jev`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: text,
  });
}

const QUESTIONS = {
  mood: { type: "choice", instructions: "Good or bad news?", criteria: ["Positive", "Negative"] },
  big: { type: "score", instructions: "How big?", criteria: ["Small", "Medium", "Large"] },
  hard: { type: "noul", instructions: "Is it hard news?", criteria: [] },
};
const STATE = { headline: "Ceasefire collapses as fighting resumes" };

function fakeAi(answers) {
  const calls = [];
  return { calls, run: async (model, input) => { calls.push({ model, input }); return { model, answers }; } };
}

// --- the function ---

test("needs an Access identity; the dev stand-in works only on this machine's host", async () => {
  const ai = fakeAi({});
  assert.equal((await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), {}, { ai })).status, 401);
  // The dev email set on a real host opens nothing.
  const remote = post({ v: 1, state: STATE, questions: QUESTIONS }, { origin: "https://almanac-dt5.pages.dev" });
  assert.equal((await handle(remote, DEV_ENV, { ai })).status, 401);
  const local = await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), DEV_ENV, { ai });
  assert.equal(local.status, 200);
});

test("POST only, same origin, JSON only, size limit", async () => {
  const ai = fakeAi({});
  const put = new Request(`${LOCAL}/api/jev`, { method: "PUT" });
  assert.equal((await handle(put, DEV_ENV, { ai })).status, 405);
  assert.equal((await handle(post({ v: 1, state: STATE, questions: QUESTIONS }, { headers: { origin: "https://evil.example" } }), DEV_ENV, { ai })).status, 403);
  assert.equal((await handle(post("x", { raw: true, headers: { "content-type": "text/plain" } }), DEV_ENV, { ai })).status, 415);
  assert.equal((await handle(post("{", { raw: true }), DEV_ENV, { ai })).status, 400);
  const big = { v: 1, state: { headline: "x".repeat(MAX_BODY_BYTES) }, questions: QUESTIONS };
  assert.equal((await handle(post(big), DEV_ENV, { ai })).status, 413);
  assert.equal(ai.calls.length, 0);
});

test("the request shape and question set are checked before the model is called", async () => {
  const ai = fakeAi({});
  const bad = [
    { v: 2, state: STATE, questions: QUESTIONS },
    { v: 1, state: STATE, questions: QUESTIONS, extra: 1 },
    { v: 1, state: "text", questions: QUESTIONS },
    { v: 1, state: STATE, questions: { Bad_Key: QUESTIONS.mood } },
    { v: 1, state: STATE, questions: { q: { type: "essay", instructions: "Write", criteria: [] } } },
    { v: 1, state: STATE, questions: { q: { type: "choice", instructions: "One?", criteria: ["only"] } } },
    { v: 1, state: STATE, questions: { q: { type: "choice", instructions: "x", criteria: ["a", "a"] } } },
  ];
  for (const body of bad) assert.equal((await handle(post(body), DEV_ENV, { ai })).status, 400, JSON.stringify(body));
  assert.equal(ai.calls.length, 0);
});

test("calls the binding with exactly {state, questions} and returns cleaned answers", async () => {
  const ai = fakeAi({
    mood: { type: "choice", choice: "Negative", confidence: 0.83, probabilities: { Positive: 0.17, Negative: 0.83, Evil: 1 } },
    big: { type: "score", score: 3, probabilities: { Small: 0.1, Medium: 0.2, Large: 0.7 } },
    hard: { type: "noul", noul: 0.91 },
    injected: { type: "choice", choice: "<script>" },
  });
  const res = await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), { ...DEV_ENV, JEV_MODEL: "typesafe/jev" }, { ai });
  assert.equal(res.status, 200);
  assert.deepEqual(ai.calls, [{ model: "typesafe/jev", input: { state: STATE, questions: {
    mood: { type: "choice", instructions: "Good or bad news?", criteria: { Positive: "Positive", Negative: "Negative" } },
    big: { type: "score", instructions: "How big?", criteria: ["Small", "Medium", "Large"] },
    hard: { type: "noul", instructions: "Is it hard news?" },
  } } }], "J14: Workers AI gets the same record form as OpenRouter");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.answers).sort(), ["big", "hard", "mood"]);
  assert.equal(body.answers.mood.label, "Negative");
  assert.deepEqual(body.answers.mood.probabilities, { Positive: 0.17, Negative: 0.83 });
  assert.equal(body.answers.big.label, "Large");
  assert.equal(body.answers.hard.value, 0.91);
  assert.deepEqual(body.missing, []);
});

test("no binding is 503, a model error or timeout is 502", async () => {
  assert.equal((await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), DEV_ENV)).status, 503);
  const broken = { run: async () => { throw new Error("boom"); } };
  assert.equal((await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), DEV_ENV, { ai: broken })).status, 502);
  const slow = { run: () => new Promise(() => {}) };
  assert.equal((await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), DEV_ENV, { ai: slow, timeoutMs: 20 })).status, 502);
});

test("JEV_MOCK answers every question without a binding", async () => {
  const res = await onRequest({ request: post({ v: 1, state: STATE, questions: STORY_QUESTIONS }), env: { ...DEV_ENV, JEV_MOCK: "1" } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, "mock-jev");
  assert.deepEqual(body.missing, []);
  assert.equal(body.answers.sentiment.label, "Bad news");
});

// --- the contract ---

test("validateQuestions and validateState limits", () => {
  assert.equal(validateQuestions(STORY_QUESTIONS).ok, true);
  const many = Object.fromEntries(Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => [`q${i}`, QUESTIONS.hard]));
  assert.equal(validateQuestions(many).ok, false);
  assert.equal(validateQuestions({ q: { ...QUESTIONS.hard, instructions: "bad\u0001" } }).ok, false);
  assert.equal(validateState({ a: "x".repeat(40000) }).ok, true, "J18: a whole article fits");
  assert.equal(validateState({ a: "x".repeat(50000) }).ok, false);
  assert.equal(validateState([]).ok, false);
});

test("normalizeAnswers drops what does not fit the question", () => {
  const { answers, missing } = normalizeAnswers(QUESTIONS, {
    answers: {
      mood: { choice: "Terrible" },
      big: { score: Number.NaN },
      hard: { noul: 7 },
    },
  });
  assert.deepEqual(Object.keys(answers), ["hard"]);
  assert.equal(answers.hard.value, 1);
  assert.deepEqual(missing, ["mood", "big"]);
  assert.deepEqual(normalizeAnswers(QUESTIONS, null).missing, ["mood", "big", "hard"]);
});

test("scoreIndex reads probabilities first, else Jev's 0-based position", () => {
  const c = ["a", "b", "c", "d", "e"];
  assert.equal(scoreIndex(0.1, c, { a: 0.1, d: 0.6 }), 3);
  assert.equal(scoreIndex(2.4, c), 2);
  assert.equal(scoreIndex(3.6, c), 4);
  assert.equal(scoreIndex(9, c), null);
});

test("J6: a real score answer (0-based score, legend, index-keyed probabilities) reads as its top level", () => {
  const questions = { size: { type: "score", instructions: "How significant?", criteria: ["Minor", "Notable", "Important", "Major"] } };
  const real = { answers: { size: { type: "score", score: 2.68, legend: { 0: "Minor", 1: "Notable", 2: "Important", 3: "Major" },
    probabilities: { 0: 0, 1: 0.01, 2: 0.31, 3: 0.6799999999999999 }, confidence: 0.68 } } };
  const { answers } = normalizeAnswers(questions, real);
  assert.equal(answers.size.label, "Major", "Jev's top level, not the 1-based misreading 'Important'");
  assert.deepEqual(answers.size.probabilities, { Minor: 0, Notable: 0.01, Important: 0.31, Major: 0.6799999999999999 });
  assert.equal(answers.size.confidence, 0.68);
});

test("J6: a real choice and yes/no answer read as they came", () => {
  const questions = {
    mood: { type: "choice", instructions: "x", criteria: ["Good news", "Bad news", "Both good and bad news", "Neither good nor bad news"] },
    hard: { type: "noul", instructions: "y", criteria: [] },
  };
  const real = { model: "typesafe/jev-1.13-20260917", answers: {
    mood: { type: "choice", choice: "Bad news", probabilities: { "Bad news": 1, "Good news": 0, "Neither good nor bad news": 0, "Both good and bad news": 0 }, confidence: 0.99 },
    hard: { type: "noul", noul: 0.99 } } };
  const { answers, missing } = normalizeAnswers(questions, real);
  assert.deepEqual(missing, []);
  assert.equal(answers.mood.label, "Bad news");
  assert.equal(readChoice(answers.mood, questions.mood.criteria).status, "sure");
  assert.equal(readNoul(answers.hard).band, "likely");
});

// --- the Ask bar ---

const profile = () => buildDefaultProfile("2026-09-29T00:00:00Z");
const choice = (label, confidence = 0.9) => ({ type: "choice", value: label, label, confidence, probabilities: null });

test("Ask targets are the owner's sections, never must-know", () => {
  const labels = askTargets(profile()).map((t) => t.label);
  assert.ok(labels.includes("Singapore"));
  assert.ok(!labels.includes("Must-know"));
  assert.deepEqual(askQuestions(profile()).raise.criteria.at(-1), NONE);
  assert.equal(validateQuestions(askQuestions(profile())).ok, true);
});

test("more of one section and less of another becomes one proposal the real gate accepts", () => {
  const p = profile();
  const answers = { raise: choice("AI"), lower: choice("US Politics"), strength: { type: "score", label: "A clear change", confidence: 0.8, probabilities: null } };
  const built = proposalFromAsk(p, answers, { request: "less US politics, more AI", id: "ask-test01" });
  assert.equal(built.ok, true);
  assert.deepEqual(built.proposal.changes, [
    { path: "$.topics.ai.affinity", old_value: 0.6, new_value: 0.7 },
    { path: "$.topics.us_politics.affinity", old_value: 0.8, new_value: 0.7 },
  ]);
  const verdict = gateProposal(p, built.proposal, SCHEMAS);
  assert.equal(verdict.decision, "review", JSON.stringify(verdict));
});

test("a vague, conflicting or maxed-out request builds no proposal", () => {
  const p = profile();
  assert.equal(proposalFromAsk(p, { raise: choice("AI", RULES.LEAN - 0.01) }, { request: "hm", id: "ask-test02" }).reason, "no_match");
  assert.equal(proposalFromAsk(p, { raise: choice(NONE), lower: choice(NONE) }, { request: "hm", id: "ask-test03" }).reason, "no_match");
  assert.equal(proposalFromAsk(p, { raise: choice("AI"), lower: choice("AI") }, { request: "hm", id: "ask-test04" }).reason, "conflict");
  p.topics.singapore.affinity = 1;
  assert.equal(proposalFromAsk(p, { raise: choice("Singapore") }, { request: "more sg", id: "ask-test05" }).reason, "at_limit");
});

test("the request is cleaned before Jev or the review sheet sees it", () => {
  assert.equal(cleanRequest("  more <b>AI</b>\n\tplease "), "more bAI/b please");
  assert.equal(askState(profile(), "x".repeat(500)).request.length, 200);
});

test("the mock maps a plain request onto the owner's sections, end to end", () => {
  const p = profile();
  const questions = askQuestions(p);
  const raw = mockJev({ state: askState(p, "less US politics, more Singapore"), questions });
  const { answers } = normalizeAnswers(questions, raw);
  assert.equal(answers.raise.label, "Singapore");
  assert.equal(answers.lower.label, "US Politics");
});

// --- the story analysis ---

const INPUT = {
  names: { bbc: "BBC", wsj: "WSJ" },
  deks: { c1: ["Government forces said they repelled attacks.", "short"] },
  pool: {
    articles: [
      { id: "a1", title: "Tigray rebels launch offensive", source_id: "bbc", topics: ["world"] },
      { id: "a2", title: "Ethiopia fighting kills dozens", source_id: "wsj", topics: ["world", "africa"] },
      { id: "a3", title: "Unrelated", source_id: "bbc", topics: [] },
    ],
    clusters: [{ id: "c1", lead: "a1", article_ids: ["a1", "a2"] }],
  },
};

test("storyState holds only the story's own headlines, dek, outlets and tags", () => {
  assert.deepEqual(storyState(INPUT, "c1"), {
    headline: "Tigray rebels launch offensive",
    other_headlines: ["Ethiopia fighting kills dozens"],
    summary: "Government forces said they repelled attacks.",
    outlets: ["BBC", "WSJ"],
    tags: ["world", "africa"],
  });
  assert.equal(storyState(INPUT, "a3").headline, "Unrelated");
  assert.equal(validateState(storyState(INPUT, "c1")).ok, true);
});

test("analysisView leads with the verdict and reads rows in label order", () => {
  const { answers, missing } = normalizeAnswers(STORY_QUESTIONS, mockJev({ state: storyState(INPUT, "c1"), questions: STORY_QUESTIONS }));
  const view = analysisView(answers, missing);
  assert.equal(view.verdict.label, "Negative");
  assert.equal(view.verdict.bars.length, 4);
  assert.deepEqual(view.rows.map((r) => r.key), ["section", "region", "story_type", "significance", "tone", "hard_news", "clinical", "industrial_biotech"]);
  assert.equal(STORY_QUESTIONS.ai, undefined, "About AI comes only from the hourly run");
});

test("a yes/no answer shows p as asked, never 1 - p, and never becomes Yes or No", () => {
  const view = analysisView({ clinical: { type: "noul", value: 0.2, label: null, confidence: null, probabilities: null } });
  assert.deepEqual(view.rows, [{ key: "clinical", label: "About clinical medicine", value: "Unlikely 20%", status: "unlikely", confidence: null }]);
  const { answers } = normalizeAnswers(STORY_QUESTIONS, { answers: { clinical: { noul: 0.2 } } });
  assert.equal(answers.clinical.confidence, null);
});

test("verdict bars show only the probabilities Jev sent", () => {
  const view = analysisView({ sentiment: { type: "choice", value: "Bad news", label: "Bad news", confidence: 0.7, probabilities: { "Bad news": 0.7, "Good news": 0.1 } } });
  assert.equal(view.verdict.label, "Negative");
  assert.deepEqual(view.verdict.bars, [{ label: "Positive", p: 0.1 }, { label: "Negative", p: 0.7 }]);
  const bare = analysisView({ sentiment: { type: "choice", value: "Good news", label: "Good news", confidence: 0.6, probabilities: null } });
  assert.deepEqual(bare.verdict.bars, []);
});

test("every question is one positive claim: no 'rather than', no negatives", () => {
  const all = [...Object.values(STORY_QUESTIONS), ...Object.values(askQuestions(profile()))];
  for (const q of all) {
    assert.doesNotMatch(q.instructions, /rather than|\bnot\b|n't\b|\bnever\b|\bneither\b/i, q.instructions);
  }
});

test("the analysis cache is keyed by question set and capped", () => {
  const cache = analysisCache(new MemoryStorage());
  cache.put("c1", { answers: {}, missing: [] });
  assert.deepEqual(cache.get("c1"), { answers: {}, missing: [] });
  for (let i = 0; i < CACHE_CAP + 5; i += 1) cache.put(`s${i}`, { i });
  assert.equal(cache.get("c1"), null);
  assert.deepEqual(cache.get(`s${CACHE_CAP + 4}`), { i: CACHE_CAP + 4 });
});

// --- the phone's client ---

test("askJev names each failure and cleans answers again on the phone", async () => {
  const respond = (status, body, extra = {}) => async () => ({ status, ok: status < 300, redirected: false, json: async () => body, ...extra });
  await assert.rejects(askJev(STATE, QUESTIONS, { online: false }), (e) => e instanceof JevError && e.kind === "offline");
  await assert.rejects(askJev(STATE, QUESTIONS, { fetchImpl: respond(503, {}) }), (e) => e.kind === "not_set_up");
  await assert.rejects(askJev(STATE, QUESTIONS, { fetchImpl: respond(200, {}, { redirected: true }) }), (e) => e.kind === "signed_out");
  await assert.rejects(askJev(STATE, QUESTIONS, { fetchImpl: respond(502, {}) }), (e) => e.kind === "no_answer");
  const ok = await askJev(STATE, QUESTIONS, { fetchImpl: respond(200, { model: "m", answers: { mood: { type: "choice", value: "Positive", label: "Positive" }, big: { value: "x" } } }) });
  assert.deepEqual(Object.keys(ok.answers), ["mood"]);
  assert.deepEqual(ok.missing, ["big", "hard"]);
});

test("storyState carries the opening of the article text when the reader has it", () => {
  const long = "Word ".repeat(2000);
  const state = storyState(INPUT, "c1", "", `  ${long}`);
  assert.equal(state.article_text.length, 4000);
  assert.ok(state.article_text.startsWith("Word Word"));
  assert.equal(validateState(state).ok, true);
  assert.equal("article_text" in storyState(INPUT, "c1"), false);
});


// --- J2: the decision rules use every part of each answer ---

const spreadChoice = (label, probabilities, confidence = null) => ({ type: "choice", value: label, label, confidence, probabilities });
const SECTIONS = ["US Politics", "Singapore", "AI", "Industrial Biotech", "World", "None of these"];

test("readChoice reads pick, confidence, runner-up and margin into one status", () => {
  const sure = readChoice(spreadChoice("Singapore", { Singapore: 0.8, World: 0.1 }), SECTIONS);
  assert.equal(sure.status, "sure");
  assert.equal(sure.confidence, 0.8);
  assert.deepEqual([sure.runnerUp, sure.runnerUpP], ["World", 0.1]);
  assert.equal(readChoice(spreadChoice("Singapore", { Singapore: 0.5, World: 0.2 }), SECTIONS).status, "lean");
  assert.equal(readChoice(spreadChoice("Singapore", { Singapore: 0.45, World: 0.4 }), SECTIONS).status, "ambiguous");
  assert.equal(readChoice(spreadChoice("Singapore", { Singapore: 0.3, World: 0.1 }), SECTIONS).status, "unsure");
  assert.equal(readChoice(spreadChoice("Singapore", { Singapore: 0.2, World: 0.7 }), SECTIONS).status, "conflict");
  assert.equal(readChoice(spreadChoice("Singapore", null), SECTIONS).status, "unrated");
  assert.equal(readChoice(undefined, SECTIONS).status, "missing");
});

test("readNoul bands p for the statement as asked, and a low confidence reads uncertain", () => {
  assert.equal(readNoul({ value: 0.82 }).band, "likely");
  assert.equal(readNoul({ value: 0.5 }).band, "possible");
  assert.equal(readNoul({ value: 0.2 }).band, "unlikely");
  assert.equal(readNoul({ value: 0.9, confidence: 0.3 }).band, "uncertain");
  assert.equal(readNoul(null).band, "missing");
});

test("expectedPosition weights the whole scale", () => {
  const c = ["a", "b", "c"];
  assert.equal(expectedPosition({ probabilities: { a: 0.5, c: 0.5 } }, c), 1);
  assert.equal(expectedPosition({ probabilities: null }, c), null);
});

test("the step is the strength answer's probability-weighted step", () => {
  const small = "A small change";
  const clear = "A clear change";
  assert.equal(strengthStep(spreadChoice(small, { [small]: 0.6, [clear]: 0.4 })).step, 0.07);
  assert.equal(strengthStep(spreadChoice(clear, null, 0.9)).step, 0.1);
  assert.equal(strengthStep(undefined).step, 0.05, "no strength answer: the small step");
});

test("two close sections ask the owner instead of guessing, and the pick then applies", () => {
  const p = profile();
  const answers = { raise: spreadChoice("Singapore", { Singapore: 0.42, World: 0.38, "None of these": 0.2 }) };
  const split = proposalFromAsk(p, answers, { request: "more local news", id: "ask-test06" });
  assert.equal(split.reason, "ambiguous");
  assert.deepEqual(split.options.raise, ["Singapore", "World"]);
  const chosen = proposalFromAsk(p, answers, { request: "more local news", id: "ask-test07", chosen: { raise: "World" } });
  assert.equal(chosen.ok, true);
  assert.deepEqual(chosen.proposal.changes, [{ path: "$.topics.world.affinity", old_value: 0.7, new_value: 0.75 }]);
  assert.equal(chosen.targets[0].status, "chosen");
  assert.equal(gateProposal(p, chosen.proposal, SCHEMAS).decision, "review");
});

test("a leaning pick moves only the small step; a pick its own probabilities contradict is ignored", () => {
  const p = profile();
  const lean = proposalFromAsk(p, { raise: spreadChoice("AI", { AI: 0.5, World: 0.2 }), strength: spreadChoice("A large change", null, 0.9) },
    { request: "more ai", id: "ask-test08" });
  assert.deepEqual(lean.proposal.changes, [{ path: "$.topics.ai.affinity", old_value: 0.6, new_value: 0.65 }]);
  assert.equal(lean.targets[0].status, "lean");
  const contradicted = proposalFromAsk(p, { raise: spreadChoice("AI", { AI: 0.1, World: 0.8 }) }, { request: "more ai", id: "ask-test09" });
  assert.equal(contradicted.reason, "no_match");
});

test("the review line states Jev's confidence and runner-up", () => {
  assert.equal(confidenceLine({ status: "sure", confidence: 0.88, runnerUp: "World", runnerUpP: 0.06 }), "Jev 88% sure · next: World 6%");
  assert.equal(confidenceLine({ status: "lean", confidence: 0.52, runnerUp: null, runnerUpP: null }), "Jev leaning, 52% · small step");
  assert.equal(confidenceLine({ status: "chosen" }), "You chose this");
});

test("the analysis reads a split verdict as two options, never a guess", () => {
  const view = analysisView({ sentiment: spreadChoice("Bad news", { "Bad news": 0.44, "Both good and bad news": 0.4, "Good news": 0.16 }) });
  assert.equal(view.verdict.label, "Negative or mixed");
  assert.equal(view.verdict.status, "ambiguous");
});


// --- J4: the OpenRouter route ---

function fakeFetch(body, status = 200) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status, json: async () => body }; };
  return { calls, impl };
}

test("OpenRouter answers first when its key is set, with the pinned model and a bearer key", async () => {
  const or = fakeFetch({ model: "typesafe/jev-1.13-20260917", answers: { mood: { type: "choice", choice: "Negative", probabilities: { Negative: 0.9, Positive: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 120, cost: 0.000005 } });
  const ai = fakeAi({});
  const env = { ...DEV_ENV, OPENROUTER_API_KEY: "sk-or-test" };
  assert.equal(route(env, { ai }), "openrouter");
  const res = await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), env, { ai, fetch: or.impl });
  assert.equal(res.status, 200);
  assert.equal(ai.calls.length, 0, "the Workers AI binding is not used while OpenRouter is set");
  assert.equal(or.calls[0].url, OPENROUTER_URL);
  assert.equal(or.calls[0].init.headers.authorization, "Bearer sk-or-test");
  assert.deepEqual(JSON.parse(or.calls[0].init.body), {
    model: OPENROUTER_MODEL,
    state: STATE,
    questions: {
      mood: { type: "choice", instructions: "Good or bad news?", criteria: { Positive: "Positive", Negative: "Negative" } },
      big: { type: "score", instructions: "How big?", criteria: ["Small", "Medium", "Large"] },
      hard: { type: "noul", instructions: "Is it hard news?" },
    },
  }, "J6: choice criteria as a record, a bare yes/no question, score levels as a list");
  const body = await res.json();
  assert.equal(body.model, "typesafe/jev-1.13-20260917");
  assert.equal(body.answers.mood.label, "Negative");
  assert.deepEqual(body.missing, ["big", "hard"]);
  assert.ok(!JSON.stringify(body).includes("sk-or-test"));
});

test("an OpenRouter error is a 502 that never echoes the key", async () => {
  const or = fakeFetch({ error: { message: "bad key sk-or-test" } }, 401);
  const res = await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), { ...DEV_ENV, OPENROUTER_API_KEY: "sk-or-test" }, { fetch: or.impl });
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes("sk-or-test"));
});

test("route order: mock, then OpenRouter, then Workers AI, else not set up", () => {
  assert.equal(route({ JEV_MOCK: "1", OPENROUTER_API_KEY: "k" }), "mock");
  assert.equal(route({ AI: {} }), "workers");
  assert.equal(route({}), null);
});


// --- J7: a failure says why, and the key is trimmed ---

test("a pasted key with spaces, a line break or quotes is trimmed before use", async () => {
  assert.equal(openRouterKey({ OPENROUTER_API_KEY: '  "sk-or-v1-abc"\n' }), "sk-or-v1-abc");
  const or = fakeFetch({ answers: {} });
  await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), { ...DEV_ENV, OPENROUTER_API_KEY: " sk-or-v1-abc\n" }, { fetch: or.impl });
  assert.equal(or.calls[0].init.headers.authorization, "Bearer sk-or-v1-abc");
});

test("a refused call says why, without the key", async () => {
  const or = fakeFetch({ error: { message: "User not found. key sk-or-v1-abcdef123 invalid" } }, 401);
  const res = await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), { ...DEV_ENV, OPENROUTER_API_KEY: "sk-or-v1-abcdef123" }, { fetch: or.impl });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.match(body.reason, /^openrouter_401: User not found/);
  assert.ok(!JSON.stringify(body).includes("sk-or-v1-abcdef123"));
  const broken = { impl: async () => { throw new TypeError("fetch failed"); } };
  const net = await (await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), { ...DEV_ENV, OPENROUTER_API_KEY: "k" }, { fetch: broken.impl })).json();
  assert.equal(net.reason, "network: TypeError: fetch failed");
});

test("the phone shows the reason after its message", async () => {
  const res = async () => ({ status: 502, ok: false, redirected: false, json: async () => ({ error: "Jev did not answer", reason: "openrouter_401: User not found" }) });
  await assert.rejects(askJev(STATE, QUESTIONS, { fetchImpl: res }),
    (e) => e.kind === "no_answer" && e.message === "Jev didn't answer. Try again in a moment. (openrouter_401: User not found)");
});

test("GET /api/jev reports the route and whether the key is set, never the key", async () => {
  const env = { ...DEV_ENV, OPENROUTER_API_KEY: " sk-or-v1-secret\n" };
  const res = await handle(new Request(`${LOCAL}/api/jev`, { method: "GET" }), env);
  const body = await res.json();
  assert.deepEqual(body, { route: "openrouter", model: OPENROUTER_MODEL, key_set: true, key_trimmed: true, key_prefix_ok: true,
    phone_budget: { cap_usd: 0.05, unenforced: true } });
  assert.ok(!JSON.stringify(body).includes("secret"));
  const none = await (await handle(new Request(`${LOCAL}/api/jev`, { method: "GET" }), DEV_ENV)).json();
  assert.equal(none.route, "not_set_up");
  assert.equal((await handle(new Request("https://almanac-dt5.pages.dev/api/jev", { method: "GET" }), env)).status, 401, "Access still required");
});


// --- J9: the real fetch is called bound; every failure names itself ---

test("with no stand-in, the global fetch is called as fetch(), not detached", async () => {
  const real = globalThis.fetch;
  let self = "unset";
  globalThis.fetch = function (url, init) { self = this; return Promise.resolve({ ok: true, status: 200, json: async () => ({ answers: {} }) }); };
  try {
    const res = await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), { ...DEV_ENV, OPENROUTER_API_KEY: "k" });
    assert.equal(res.status, 200);
    assert.ok(self === undefined || self === globalThis, "called as a plain function call on the global");
  } finally {
    globalThis.fetch = real;
  }
});

test("a Workers AI failure and an unreadable reply each name themselves", async () => {
  const broken = { run: async () => { throw new Error("5007: No such model typesafe/jev"); } };
  const w = await (await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), DEV_ENV, { ai: broken })).json();
  assert.match(w.reason, /^workers_ai: Error: 5007: No such model/);
  const garbled = { impl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }) };
  const g = await (await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), { ...DEV_ENV, OPENROUTER_API_KEY: "k" }, { fetch: garbled.impl })).json();
  assert.equal(g.reason, "openrouter_unreadable_reply");
});


// --- J11: the hourly run's answers show in the sheet, and only the rest is asked live ---

const HOURLY = { answers: {
  a2: { section: { t: "choice", v: "World", c: 0.9, p: { World: 0.9, Asia: 0.1 } }, ai: { t: "noul", v: 0.05 },
    sentiment: { t: "choice", v: "Bad news", c: 0.8 }, region: { t: "choice", v: "Africa", c: 0.95 },
    hard_news: { t: "noul", v: 0.9 }, clinical: { t: "noul", v: 0.02 }, industrial_biotech: { t: "noul", v: 0.01 },
    stray: { t: "choice", v: "x" } },
} };

test("hourly answers for a story come from its first answered member, in the sheet's shape", () => {
  const got = hourlyAnswers(HOURLY, ["a1", "a2"]);
  assert.equal(got.id, "a2");
  assert.deepEqual(got.answers.section, { type: "choice", value: "World", label: "World", confidence: 0.9, probabilities: { World: 0.9, Asia: 0.1 } });
  assert.deepEqual(got.answers.ai, { type: "noul", value: 0.05, label: null, confidence: null, probabilities: null });
  assert.equal(got.answers.stray, undefined, "a key the sheet does not show is dropped");
  assert.equal(hourlyAnswers(HOURLY, ["zz"]), null);
  assert.equal(hourlyAnswers(null, ["a2"]), null);
  assert.equal(fromCompact({ t: "choice", v: 3 }), null);
});

test("only the questions the hourly run left are asked live", () => {
  const { answers } = hourlyAnswers(HOURLY, ["a2"]);
  assert.deepEqual(Object.keys(questionsLeft(answers)).sort(), ["significance", "story_type", "tone"]);
  const view = analysisView(answers);
  assert.equal(view.verdict.label, "Negative");
  assert.ok(view.rows.some((r) => r.key === "ai" && r.value === "Unlikely 5%"));
});


// --- J13, J17: reading with Jev: takeaways ---

const ARTICLE = [
  "The city council approved a $40 million flood barrier on Tuesday. The vote passed 7 to 2.",
  "About 3,000 homes in the riverside district would be protected from the next major flood.",
  "Two members voted against it, arguing the city could not afford the cost.",
  "Construction will begin in January and take about three years, officials said.",
];

test("sentences split at their ends, keeping quotes and numbers", () => {
  assert.deepEqual(splitSentences("One here. Two there! 3 more? \u201cQuoted.\u201d Last"), ["One here.", "Two there!", "3 more?", "\u201cQuoted.\u201d", "Last"]);
  assert.deepEqual(splitSentences("  "), []);
  assert.deepEqual(splitSentences("Mr. Smith said so. Done."), ["Mr. Smith said so.", "Done."]);
  assert.deepEqual(splitSentences("U.S. Ambassador Perdue spoke on Sept. 28. China replied."),
    ["U.S. Ambassador Perdue spoke on Sept. 28.", "China replied."], "initials and months never end a sentence");
  assert.deepEqual(splitSentences("The U.N. met. Talks ended."), ["The U.N. met.", "Talks ended."]);
  assert.deepEqual(splitSentences("Talks were held in the U.S. Officials said so."), ["Talks were held in the U.S. Officials said so."],
    "a known limit: initials ending a real sentence join the next");
});

test("the article is numbered for Jev and the five takeaways go in one call", () => {
  const blocks = readingBlocks(ARTICLE, { headline: "Council approves flood barrier", outlet: "Local Times" });
  assert.deepEqual(blocks.paragraphs.map((p) => p.id), ["P1", "P2", "P3", "P4"]);
  assert.equal(blocks.state.paragraphs.P1, "[S1] The city council approved a $40 million flood barrier on Tuesday. [S2] The vote passed 7 to 2.");
  assert.equal(validateState(blocks.state).ok, true);
  const calls = readingQuestions(blocks);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]), ["news", "why", "evidence", "other", "next"]);
  assert.deepEqual(calls[0].news.criteria, ["S1", "S2", "S3", "S4", "S5", READ_NONE]);
  assert.equal(validateQuestions(calls[0]).ok, true);
  const wire = toWire(calls[0]);
  assert.deepEqual(Object.keys(wire.news.criteria).slice(0, 2), ["S1", "S2"], "sent to Jev as a record of sentence numbers");
  const long = readingBlocks(Array.from({ length: 40 }, (_, i) => `Paragraph ${i} says something. It ends here.`));
  assert.equal(long.paragraphs.length, 40, "J18: the whole article, not its top");
  assert.ok(readingQuestions(long).every((q) => validateQuestions(q).ok && Object.keys(q).length <= 12));
  assert.deepEqual(readingQuestions(readingBlocks(["Only one sentence."])), []);
});

// A 12-paragraph article: sections P1-P5, P6-P10, P11-P12; sentence Sn is paragraph n.
const TWELVE = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} makes its point clearly.`);
const pick = (id, confidence = 0.9, probabilities = null) => ({ type: "choice", value: id, label: id, confidence, probabilities });

test("takeaways come from Jev's sentence numbers, in article order, each sentence once", () => {
  const blocks = readingBlocks(TWELVE);
  const view = readingView({
    next: pick("S11", 0.8),
    news: pick("S1"),
    why: pick("S3", 0.55),
    evidence: pick("S1", 0.7),
    other: pick(READ_NONE),
  }, blocks);
  assert.deepEqual(view.takeaways.map((t) => `${t.name}:${t.id}`), ["The news:S1", "Why it matters:S3", "What's next:S11"],
    "article order; the evidence pick repeats S1 so it is dropped; None of these leaves the other side out");
  assert.equal(view.takeaways[0].text, "Paragraph 1 makes its point clearly.");
});

test("J18: a short article gets at most one takeaway per three paragraphs", () => {
  const four = readingBlocks(ARTICLE);
  const view = readingView({ news: pick("S1"), why: pick("S3"), next: pick("S5") }, four);
  assert.deepEqual(view.takeaways.map((t) => t.key), ["news"], "4 paragraphs: 1, kept in priority order");
  assert.deepEqual(view.points, [], "a single section has no key point question");
});

test("J18: long articles get a key point per section, spread and never crowded", () => {
  const blocks = readingBlocks(TWELVE);
  const sections = readingSections(blocks);
  assert.deepEqual(sections.map((x) => `${x.key}:${x.from}-${x.to}`), ["k1:P1-P5", "k2:P6-P10", "k3:P11-P12"]);
  const calls = readingQuestions(blocks);
  assert.deepEqual(Object.keys(calls[0]), ["news", "why", "evidence", "other", "next", "k1", "k2", "k3"]);
  assert.equal(calls[0].k2.instructions, "Which sentence in paragraphs P6 to P10 carries that part's main point? Sentences are marked [S1], [S2] and so on.");
  assert.deepEqual(calls[0].k2.criteria, ["S6", "S7", "S8", "S9", "S10", READ_NONE]);
  const view = readingView({
    news: pick("S2"),
    k1: pick("S4"), // section 1 already holds a named takeaway: no point
    k2: pick("S8"),
    k3: pick("S9", 0.5), // not its own section's sentence? S9 is in section 2: still a valid number, taken once
  }, blocks);
  assert.deepEqual(view.points.map((x) => x.id), ["S8"], "S9 sits next to S8 and Jev only leaned, so it is left out");
  assert.deepEqual([...view.skim], ["P2", "P8"]);
  const d = readingDensity(view, blocks);
  assert.deepEqual(d, { marked: 2, paragraphs: 12, share: 2 / 12, longestGap: 5 });
  const sure = readingView({ news: pick("S2"), k2: pick("S8"), k3: pick("S11") }, blocks);
  assert.deepEqual(sure.points.map((x) => x.id), ["S8", "S11"]);
});

test("J18: the longest article in the pool is read whole, in calls of at most 12", () => {
  const huge = readingBlocks(Array.from({ length: 164 }, (_, i) => `Paragraph ${i + 1} has a sentence. It has a second one too.`));
  assert.equal(huge.paragraphs.length, 164);
  const calls = readingQuestions(huge);
  const keys = calls.flatMap((q) => Object.keys(q));
  assert.equal(keys.filter((k) => /^k\d+$/.test(k)).length, 33, "one key point question per five paragraphs");
  assert.ok(calls.every((q) => Object.keys(q).length <= 12 && validateQuestions(q).ok));
  assert.equal(calls[0].news.criteria.length, 251, "named questions: the first 250 sentences and None of these");
  assert.ok(validateState(huge.state).ok);
});

test("a split or unsure pick is left out, and with no takeaway nothing is skimmed", () => {
  const blocks = readingBlocks(ARTICLE);
  const view = readingView({
    news: { type: "choice", value: "S1", label: "S1", confidence: 0.45, probabilities: { S1: 0.45, S2: 0.4 } },
    why: { type: "choice", value: "S3", label: "S3", confidence: 0.2, probabilities: null },
    other: { type: "choice", value: "S9", label: "S9", confidence: 0.9, probabilities: null },
  }, blocks);
  assert.deepEqual(view.takeaways, [], "a split, an unsure pick and an unknown number all count for nothing");
  assert.equal(view.skim, null);
});

test("every takeaway question is one positive claim", () => {
  for (const [, , instructions] of TAKEAWAYS) {
    assert.doesNotMatch(instructions, /rather than|\bnot\b|n't\b|\bnever\b|\bneither\b/i, instructions);
  }
});

test("the read cache keeps the newest reads", () => {
  const c = readCache(new MemoryStorage(), 2);
  c.put("a", { answers: {} });
  c.put("b", { answers: {} });
  c.put("c", { answers: {} });
  assert.equal(c.get("a"), null);
  assert.ok(c.get("c"));
});


// --- J19: your reading with Jev ---

test("reads and Skim/Hide use are recorded, and the checks wait for enough reads", () => {
  const store = new MemoryStorage();
  recordRead(store, { marked: 4, paragraphs: 20, share: 0.2, longestGap: 6 }, "2026-09-29T00:00:00Z");
  recordEvent(store, "skim");
  let s = readingSummary(store);
  assert.equal(s.reads, 1);
  assert.equal(s.skimRate, 1);
  assert.ok(s.checks.every((c) => c.status === "not_enough_data"));
  for (let i = 0; i < MIN_READS; i += 1) recordRead(store, { marked: 3, paragraphs: 30, share: 0.1, longestGap: 12 });
  recordRead(store, { marked: 0, paragraphs: 8, share: 0, longestGap: 8 });
  recordEvent(store, "hide");
  recordEvent(store, "error");
  s = readingSummary(store);
  assert.equal(s.reads, MIN_READS + 2);
  assert.equal(s.errors, 1);
  const status = Object.fromEntries(s.checks.map((c) => [c.key, c.status]));
  assert.deepEqual(status, { share_low: "fail", share_high: "pass", gap: "fail", hide: "pass", empty: "pass" },
    "a 0.1 share is too thin and a 12-paragraph gap too long; the empty read is excluded from the averages");
  assert.ok(Math.abs(s.avgShare - (0.2 + 0.1 * MIN_READS) / (MIN_READS + 1)) < 1e-9);
});

test("the record keeps only recent reads and survives a corrupt value", () => {
  const store = new MemoryStorage();
  for (let i = 0; i < RECENT_CAP + 5; i += 1) recordRead(store, { marked: 1, paragraphs: 5, share: 0.2, longestGap: 2 });
  assert.equal(JSON.parse(store.getItem(STATS_KEY)).recent.length, RECENT_CAP);
  store.setItem(STATS_KEY, "{broken");
  assert.equal(readingSummary(store).reads, 0);
});

test("the Ask bar suggests requests from the reader's own sections and today's feed", () => {
  const profile = { topics: {
    us_politics: { label: "US Politics", affinity: 0.8, enabled: true },
    singapore: { label: "Singapore", affinity: 0.9, enabled: true },
    ai: { label: "AI", affinity: 0.6, enabled: true },
    world: { label: "World", affinity: 0.7, enabled: true },
    biotech: { label: "Industrial Biotech", affinity: 0.3, enabled: false },
    must_know: { label: "Must-know", affinity: 0, enabled: true },
  } };
  const counts = { us_politics: 40, singapore: 12, ai: 9, world: 20, biotech: 30, must_know: 50 };
  assert.deepEqual(askSuggestions(profile, counts), ["More AI", "Less US Politics", "A lot more World"]);
  assert.deepEqual(askSuggestions(profile, {}), [], "nothing on the page, nothing suggested");
  assert.deepEqual(askSuggestions(profile, { ai: 3 }), ["Less AI"]);
  for (const text of askSuggestions(profile, counts)) assert.ok(!/not|n't|rather/i.test(text), "each suggestion asks in the positive");
});

test("Jev's read says whether the section comes from the rules, Jev, or both (J22)", async () => {
  const { sortedBy } = await import("../../app/static/js/jev/sorted-by.js");
  const sure = (label) => ({ label, confidence: 0.8 });
  assert.equal(sortedBy(["singapore", "asia"], sure("Singapore")).kind, "both");
  assert.equal(sortedBy(["world"], sure("Singapore")).kind, "jev");
  assert.match(sortedBy(["world"], sure("Singapore")).sentence, /Rules say World\. Jev says Singapore \(sure\)\./);
  assert.equal(sortedBy(["world"], { label: "Singapore", confidence: 0.2 }).kind, "rules");
  assert.equal(sortedBy(["world"], undefined).sentence, "Rules only: World. Jev has not answered.");
});


// --- J25: one daily budget for the phone's Jev calls ---

function memoryKV() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
}

test("the phone's Jev calls share one daily budget, charged by each call's cost", async () => {
  const kv = memoryKV();
  const env = { ...DEV_ENV, OPENROUTER_API_KEY: "sk-or-v1-x", INTERESTS: kv };
  const now = () => Date.parse("2026-09-30T10:00:00Z");
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ answers: {}, usage: { cost: 0.02 } }) });
  const ask = () => handle(post({ v: 1, state: STATE, questions: QUESTIONS }), env, { fetch, now });
  assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 200);
  assert.deepEqual(JSON.parse(kv.m.get("jev-spend:phone:2026-09-30")), { usd: 0.04, calls: 2 });
  assert.equal((await ask()).status, 200, "0.04 is under 0.05, so one more goes");
  const over = await ask();
  assert.equal(over.status, 429);
  assert.equal((await over.json()).reason, "daily_budget");
  const nextDay = await handle(post({ v: 1, state: STATE, questions: QUESTIONS }), env, { fetch, now: () => Date.parse("2026-10-01T00:05:00Z") });
  assert.equal(nextDay.status, 200, "a new UTC day starts a new budget");
  const status = await (await handle(new Request(`${LOCAL}/api/jev`, { method: "GET" }), env, { now })).json();
  assert.deepEqual(status.phone_budget, { cap_usd: 0.05, usd: 0.06, calls: 3 });
});

test("a call with no reported cost is charged a doubled estimate", () => {
  assert.equal(callCost({ usage: { input_tokens: 1000 } }, 0), 1000 * USD_PER_TOKEN);
  assert.ok(callCost({}, 3000) > 1000 * USD_PER_TOKEN);
  assert.equal(callCost({ usage: { cost: 0.001 } }, 99999), 0.001);
});

test("a spent budget reads as its own plain message on the phone", async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, redirected: false, json: async () => ({ reason: "daily_budget" }) });
  await assert.rejects(askJev({}, {}, { fetchImpl, online: true }), (e) => e.kind === "budget" && /used up/.test(e.message));
});
