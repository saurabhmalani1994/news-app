// J1: the one shape a question to Jev, and an answer back from it, may take. Shared by
// the /api/jev Pages Function (functions/api/jev.js, which validates what the phone
// asks and cleans what Jev answers) and the phone (js/jev/*.js), so both read the same
// rules. Pure, no DOM, no network.
//
// Jev (TypeSafe's "System One" model, typesafe/jev on Cloudflare Workers AI) answers
// fixed questions about a `state` with typed values instead of prose:
//   noul   - a yes/no probability, 0 to 1
//   choice - one of the question's own criteria, with a confidence and probabilities
//   score  - a position on the question's own ordered criteria (a scale)
// Every answer is model output shaped by untrusted feed text (R26), so it is treated
// the way the proposal gate treats a proposal: a choice outside the question's own
// criteria, a number that is not finite or not in range, or an unknown key is dropped,
// never passed on. Because a choice can only ever be one of the app's own strings, no
// model-written text reaches the page (R13).

export const JEV_TYPES = Object.freeze(["noul", "choice", "score"]);
export const MAX_QUESTIONS = 12;
export const MAX_CRITERIA = 120; // a choice: J13 asks which of an article's numbered sentences
export const MAX_LEVELS = 10; // a score: Jev takes 2 to 10 ordered levels
export const MAX_CRITERION = 60;
export const MAX_INSTRUCTIONS = 400;
export const MAX_STATE_CHARS = 8000;

const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !CONTROL.test(v);
const unit = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

/** {ok: true} or {ok: false, error} for a question set: {key: {type, instructions, criteria}}.
 * choice and score need 2 to MAX_CRITERIA distinct criteria; noul takes 0 to 8 (what
 * counts as yes). */
export function validateQuestions(questions) {
  if (!isObject(questions)) return { ok: false, error: "questions must be an object" };
  const keys = Object.keys(questions);
  if (!keys.length || keys.length > MAX_QUESTIONS) return { ok: false, error: `1 to ${MAX_QUESTIONS} questions` };
  for (const key of keys) {
    const q = questions[key];
    if (!KEY.test(key)) return { ok: false, error: "a question key is a short lowercase slug" };
    if (!isObject(q) || Object.keys(q).some((k) => !["type", "instructions", "criteria"].includes(k))) {
      return { ok: false, error: `question ${key} is exactly {type, instructions, criteria}` };
    }
    if (!JEV_TYPES.includes(q.type)) return { ok: false, error: `question ${key} has an unknown type` };
    if (!text(q.instructions, MAX_INSTRUCTIONS)) return { ok: false, error: `question ${key} needs instructions of 1 to ${MAX_INSTRUCTIONS} characters` };
    const [low, high] = q.type === "noul" ? [0, 8] : q.type === "score" ? [2, MAX_LEVELS] : [2, MAX_CRITERIA];
    const criteria = q.criteria ?? [];
    if (!Array.isArray(criteria) || criteria.length < low || criteria.length > high
      || !criteria.every((c) => text(c, MAX_CRITERION)) || new Set(criteria).size !== criteria.length) {
      return { ok: false, error: `question ${key} needs ${low} to ${high} distinct criteria of 1 to ${MAX_CRITERION} characters` };
    }
  }
  return { ok: true };
}

/** {ok: true} or {ok: false, error} for the state Jev reads: a plain JSON object of at
 * most MAX_STATE_CHARS characters once serialized. */
export function validateState(state) {
  if (!isObject(state)) return { ok: false, error: "state must be an object" };
  let size;
  try {
    size = JSON.stringify(state).length;
  } catch {
    return { ok: false, error: "state must be plain JSON" };
  }
  if (size > MAX_STATE_CHARS) return { ok: false, error: `state is at most ${MAX_STATE_CHARS} characters` };
  return { ok: true };
}

/** A probability map kept to the question's own criteria, each value clamped to 0..1.
 * J6: Jev keys a score's probabilities by level index ("0", "1", ...), with a `legend`
 * naming each; a level's probability is read by its name or its index, so the map that
 * comes out is always keyed by the app's own criteria. */
function probabilitiesFor(raw, criteria) {
  if (!isObject(raw)) return null;
  const out = {};
  criteria.forEach((c, i) => {
    const p = unit(raw[c] ?? raw[String(i)]);
    if (p !== null) out[c] = p;
  });
  return Object.keys(out).length ? out : null;
}

/** The level a score answer sits on: the most probable one when Jev sends
 * probabilities, else the score itself. J6, confirmed on a real call: Jev's score is a
 * 0-based position on the scale (2.68 on Minor/Notable/Important/Major is between
 * Important and Major, nearest Major), matching its legend {"0": "Minor", ...}. */
export function scoreIndex(score, criteria, probabilities = null) {
  if (probabilities) {
    let best = -1;
    let bestP = -1;
    criteria.forEach((c, i) => {
      if (probabilities[c] !== undefined && probabilities[c] > bestP) { best = i; bestP = probabilities[c]; }
    });
    if (best >= 0) return best;
  }
  const n = criteria.length;
  if (score >= 0 && score <= n - 1) return Math.round(score);
  return null;
}

/**
 * Jev's raw answers, cleaned against the questions that were asked:
 *   {answers: {key: {type, value, label, confidence, probabilities}}, missing: [key]}
 * `value` is the noul probability, the chosen criterion, or the score as sent; `label`
 * is always one of the question's own criteria (or null for a noul). Anything that does
 * not fit is left out and its key listed in `missing`.
 */
export function normalizeAnswers(questions, raw) {
  const given = isObject(raw) && isObject(raw.answers) ? raw.answers : {};
  const answers = {};
  const missing = [];
  for (const [key, q] of Object.entries(questions)) {
    const a = Object.hasOwn(given, key) ? given[key] : null;
    const criteria = q.criteria || [];
    let cleaned = null;
    if (isObject(a) && q.type === "noul") {
      const p = unit(a.noul ?? a.value);
      // p is the probability that the question's statement is true, and only that:
      // 1 - p is not the probability of the opposite statement, so nothing is derived
      // from it. The confidence is Jev's own, or none.
      if (p !== null) cleaned = { type: "noul", value: p, label: null, confidence: unit(a.confidence), probabilities: null };
    } else if (isObject(a) && q.type === "choice") {
      const pick = a.choice ?? a.value;
      if (typeof pick === "string" && criteria.includes(pick)) {
        const probabilities = probabilitiesFor(a.probabilities, criteria);
        cleaned = { type: "choice", value: pick, label: pick, confidence: unit(a.confidence) ?? probabilities?.[pick] ?? null, probabilities };
      }
    } else if (isObject(a) && q.type === "score") {
      const score = a.score ?? a.value;
      if (typeof score === "number" && Number.isFinite(score)) {
        const probabilities = probabilitiesFor(a.probabilities, criteria);
        const index = scoreIndex(score, criteria, probabilities);
        if (index !== null) {
          cleaned = { type: "score", value: score, label: criteria[index], confidence: unit(a.confidence) ?? probabilities?.[criteria[index]] ?? null, probabilities };
        }
      }
    }
    if (cleaned) answers[key] = cleaned;
    else missing.push(key);
  }
  return { answers, missing };
}

/**
 * J6: the questions as OpenRouter's System One endpoint validates them (checked against
 * its own 400 answers): a choice's criteria are a record of option -> description, a
 * yes/no question's criteria an object (left out when there are none), a score's
 * criteria stay the ordered list of levels. The app keeps its own list form everywhere
 * else; only the request on the wire changes. Each option is its own description, so
 * the option names Jev answers with are exactly the app's criteria.
 */
export function toWire(questions) {
  const out = {};
  for (const [key, q] of Object.entries(questions)) {
    const criteria = q.criteria || [];
    if (q.type === "choice") {
      out[key] = { type: q.type, instructions: q.instructions, criteria: Object.fromEntries(criteria.map((c) => [c, c])) };
    } else if (q.type === "noul") {
      out[key] = criteria.length
        ? { type: q.type, instructions: q.instructions, criteria: Object.fromEntries(criteria.map((c) => [c, c])) }
        : { type: q.type, instructions: q.instructions };
    } else {
      out[key] = { type: q.type, instructions: q.instructions, criteria: [...criteria] };
    }
  }
  return out;
}
