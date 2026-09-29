// J1: /api/jev, a Cloudflare Pages Function deployed with the static site like
// /api/interests. The phone POSTs one question set about one state:
//   {"v":1, "state": {...}, "questions": {"key": {type, instructions, criteria}}}
// and gets back Jev's answers, cleaned (app/static/js/jev/contract.js):
//   {"ok":true, "model":"...", "answers": {...}, "missing": [...]}
//
// Two routes to Jev, both from here on the server, so no key ever sits on the phone or
// in the repo and the phone only ever talks to its own origin (the CSP's connect-src
// stays 'self'):
//   - OpenRouter (J4, used first when set): the secret OPENROUTER_API_KEY on the Pages
//     project, POST https://openrouter.ai/api/v1/systemone with {model, state,
//     questions}. The model is pinned (JEV_MODEL, default typesafe/jev-1.13) so tuned
//     thresholds do not drift when a newer Jev ships. JEV_OPENROUTER_URL overrides the
//     endpoint.
//   - Cloudflare Workers AI: the Pages project's AI binding (env.AI), model typesafe/jev.
//
// Same guard as /api/interests: a verified Cloudflare Access identity (accessIdentity),
// same origin only, JSON only, a size limit, and the question set and state checked in
// full before anything reaches the model. Nothing is stored and nothing is logged.
//
// Local testing (docs/JEV-SPIKE.md): JEV_MOCK=1 in .dev.vars answers from
// app/static/js/jev/mock.js instead of the model, so the whole path runs with no
// account and no key.

import { accessIdentity, readLimited } from "./interests.js";
import { validateQuestions, validateState, normalizeAnswers, toWire } from "../../app/static/js/jev/contract.js";
import { mockJev } from "../../app/static/js/jev/mock.js";

export const JEV_MODEL = "typesafe/jev";
export const OPENROUTER_MODEL = "typesafe/jev-1.13";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/systemone";
export const MAX_BODY_BYTES = 16384;
export const TIMEOUT_MS = 10_000;

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function reply(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Which route answers: "mock", "openrouter", "workers" or null (not set up). */
export function route(env, deps = {}) {
  if (env.JEV_MOCK === "1") return "mock";
  if (env.OPENROUTER_API_KEY) return "openrouter";
  if (deps.ai || env.AI) return "workers";
  return null;
}

/** One OpenRouter call. Throws on a non-2xx answer; the error never carries the key or
 * the body. */
async function openRouter(env, input, deps, signal) {
  const response = await (deps.fetch || fetch)(env.JEV_OPENROUTER_URL || OPENROUTER_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env.JEV_MODEL || OPENROUTER_MODEL, state: input.state, questions: toWire(input.questions) }),
    signal,
  });
  if (!response.ok) throw new Error(`openrouter ${response.status}`);
  return response.json();
}

/** The model call, or the local mock. Throws on a timeout or a model error. */
async function runJev(env, input, deps) {
  const which = route(env, deps);
  if (which === "mock") return mockJev(input);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, rejectRun) => {
    timer = setTimeout(() => { controller.abort(); rejectRun(new Error("timeout")); }, deps.timeoutMs ?? TIMEOUT_MS);
  });
  const call = which === "openrouter"
    ? openRouter(env, input, deps, controller.signal)
    : (deps.ai || env.AI).run(env.JEV_MODEL || JEV_MODEL, input);
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The function, with its outside world passed in so tests can drive it: env.AI (the
 * Workers AI binding), env.JEV_MODEL, env.JEV_MOCK, the Access overrides
 * accessIdentity reads; deps.ai (a stand-in binding), deps.getKeys, deps.now.
 */
export async function handle(request, env = {}, deps = {}) {
  if (request.method !== "POST") return reply(405, { error: "POST only" }, { allow: "POST" });
  const who = await accessIdentity(request, env, deps);
  if (!who.ok) return reply(who.status, { error: who.error });
  if (!route(env, deps)) return reply(503, { error: "Jev is not set up on this site yet" });

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return reply(403, { error: "same origin only" });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) return reply(415, { error: "JSON only" });
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return reply(413, { error: `at most ${MAX_BODY_BYTES} bytes` });
  const text = await readLimited(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, { error: `at most ${MAX_BODY_BYTES} bytes` });
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return reply(400, { error: "not JSON" });
  }
  if (!isObject(data) || data.v !== 1 || Object.keys(data).some((k) => !["v", "state", "questions"].includes(k))) {
    return reply(400, { error: "expected {v: 1, state, questions}" });
  }
  const questionsOk = validateQuestions(data.questions);
  if (!questionsOk.ok) return reply(400, { error: questionsOk.error });
  const stateOk = validateState(data.state);
  if (!stateOk.ok) return reply(400, { error: stateOk.error });

  let raw;
  try {
    raw = await runJev(env, { state: data.state, questions: data.questions }, deps);
  } catch {
    return reply(502, { error: "Jev did not answer" });
  }
  const { answers, missing } = normalizeAnswers(data.questions, raw);
  const fallback = route(env, deps) === "openrouter" ? OPENROUTER_MODEL : JEV_MODEL;
  const model = isObject(raw) && typeof raw.model === "string" ? raw.model.slice(0, 64) : env.JEV_MODEL || fallback;
  return reply(200, { ok: true, model, answers, missing });
}

/** Pages Functions entry: every method on /api/jev. */
export function onRequest(context) {
  return handle(context.request, context.env);
}
