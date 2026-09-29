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
export const MAX_BODY_BYTES = 98304; // J18: a whole article's state plus its questions
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

/** J7: the OpenRouter key as it should be sent: stray spaces, line breaks and wrapping
 * quotes from pasting it into the dashboard removed. "" when unset. */
export function openRouterKey(env) {
  return String(env.OPENROUTER_API_KEY || "").trim().replace(/^["']|["']$/g, "").trim();
}

/** Which route answers: "mock", "openrouter", "workers" or null (not set up). */
export function route(env, deps = {}) {
  if (env.JEV_MOCK === "1") return "mock";
  if (openRouterKey(env)) return "openrouter";
  if (deps.ai || env.AI) return "workers";
  return null;
}

/** J7: a failed call, with a short reason the phone can show: the upstream status and
 * the start of OpenRouter's own error message, never the key or the request. */
export class JevCallError extends Error {
  constructor(reason, status = null) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

const KEYISH = /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+\S+)/g;

/** OpenRouter's own error message, clipped and with anything key-like removed. */
async function upstreamMessage(response) {
  try {
    const body = await response.json();
    const message = typeof body?.error?.message === "string" ? body.error.message : "";
    return message.replace(KEYISH, "[hidden]").replace(/\s+/g, " ").trim().slice(0, 160);
  } catch {
    return "";
  }
}

/** One OpenRouter call. Throws a JevCallError on a non-2xx answer or a failed fetch. */
async function openRouter(env, input, deps, signal) {
  // J9: Workers refuses a fetch called detached from the global ("Illegal invocation"),
  // so the real one is always called as fetch(...), never pulled out into a value.
  const doFetch = deps.fetch || ((url, init) => fetch(url, init));
  let response;
  try {
    response = await doFetch(env.JEV_OPENROUTER_URL || OPENROUTER_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${openRouterKey(env)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: env.JEV_MODEL || OPENROUTER_MODEL, state: input.state, questions: toWire(input.questions) }),
      signal,
    });
  } catch (error) {
    throw new JevCallError(error?.name === "AbortError" ? "timeout" : `network: ${cleanMessage(error)}`);
  }
  if (!response.ok) {
    const message = await upstreamMessage(response);
    throw new JevCallError(`openrouter_${response.status}${message ? `: ${message}` : ""}`, response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new JevCallError("openrouter_unreadable_reply");
  }
}

/** J9: an unexpected error's name and message, clipped, with anything key-like removed. */
function cleanMessage(error) {
  const text = `${error?.name || "Error"}: ${error?.message || ""}`;
  return text.replace(KEYISH, "[hidden]").replace(/\s+/g, " ").trim().slice(0, 140);
}

/** The model call, or the local mock. Throws on a timeout or a model error. */
async function runJev(env, input, deps) {
  const which = route(env, deps);
  if (which === "mock") return mockJev(input);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, rejectRun) => {
    timer = setTimeout(() => { controller.abort(); rejectRun(new JevCallError("timeout")); }, deps.timeoutMs ?? TIMEOUT_MS);
  });
  const call = which === "openrouter"
    ? openRouter(env, input, deps, controller.signal)
    // J14: Workers AI refused the list form with 7003 (User Input Error), as OpenRouter
    // did with a 400: the same record form goes to both.
    : Promise.resolve().then(() => (deps.ai || env.AI).run(env.JEV_MODEL || JEV_MODEL, { state: input.state, questions: toWire(input.questions) }))
      .catch((error) => { throw new JevCallError(`workers_ai: ${cleanMessage(error)}`); });
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
  if (request.method === "GET") return status(request, env, deps);
  if (request.method !== "POST") return reply(405, { error: "GET or POST only" }, { allow: "GET, POST" });
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
  } catch (error) {
    const reason = error instanceof JevCallError ? error.reason : `model_error: ${cleanMessage(error)}`;
    return reply(502, { error: "Jev did not answer", reason });
  }
  const { answers, missing } = normalizeAnswers(data.questions, raw);
  const fallback = route(env, deps) === "openrouter" ? OPENROUTER_MODEL : JEV_MODEL;
  const model = isObject(raw) && typeof raw.model === "string" ? raw.model.slice(0, 64) : env.JEV_MODEL || fallback;
  return reply(200, { ok: true, model, answers, missing });
}

/** J7: GET /api/jev, behind the same Access check: how this site reaches Jev, with no
 * secret in it. key_set and key_trimmed say whether the OpenRouter secret is present and
 * whether pasting left spaces, line breaks or quotes around it (trimmed before use). */
async function status(request, env, deps) {
  const who = await accessIdentity(request, env, deps);
  if (!who.ok) return reply(who.status, { error: who.error });
  const raw = String(env.OPENROUTER_API_KEY || "");
  const which = route(env, deps);
  return reply(200, {
    route: which || "not_set_up",
    model: which === "openrouter" ? env.JEV_MODEL || OPENROUTER_MODEL : which === "workers" ? env.JEV_MODEL || JEV_MODEL : null,
    key_set: Boolean(raw),
    key_trimmed: Boolean(raw) && raw !== openRouterKey(env),
    key_prefix_ok: openRouterKey(env).startsWith("sk-or-"),
  });
}

/** Pages Functions entry: every method on /api/jev. */
export function onRequest(context) {
  return handle(context.request, context.env);
}
