// J1: the Ask bar's pure half. Jev's cleaned answers to askQuestions(profile) become one
// ordinary S19 proposal (proposal.schema.json), which then goes through the same
// deterministic gate every AI edit passes (js/ai/gate.js): the whitelist, the delta caps,
// the reserved paths. Jev never edits the profile; this file only builds the proposal,
// and only the owner's Apply saves it.
//
// J2: every part of each answer is used (js/jev/decide.js):
//   - "More of" and "less of" act only on a sure or leaning pick. A pick Jev is unsure
//     of, or whose own probabilities rank another option first, is ignored.
//   - When the top two sections are within the margin of each other, nothing is guessed:
//     the result is "ambiguous" with both options, and the owner picks one (Did you mean).
//   - The step size is the strength answer's probability-weighted step, so "a small
//     change" at 60% and "a clear change" at 40% moves 0.07, not a full 0.10.
//   - A leaning or unrated pick moves at most the small step.
//   - Each target carries Jev's confidence and runner-up for the review sheet.

import { askQuestions, askTargets, NONE, STRENGTH_CHOICES } from "./questions.js";
import { readChoice, ACTIONABLE } from "./decide.js";

export const STEP = Object.freeze({ Slightly: 0.05, Clearly: 0.1, "A lot": 0.1 });
export const SMALL_STEP = STEP.Slightly;
export const MAX_REQUEST = 200;

const CONTROL = /[\u0000-\u001f\u007f]/g;
const round2 = (x) => Math.round(x * 100) / 100;
const STRENGTH_ASKED = STRENGTH_CHOICES.map(([asked]) => asked);
const stepOf = (asked) => STEP[STRENGTH_CHOICES.find(([a]) => a === asked)?.[1]] ?? null;

/** The owner's request as the state Jev reads: trimmed, one line, no markup. */
export function cleanRequest(text) {
  return String(text || "").replace(CONTROL, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_REQUEST);
}

/** The Ask state: the request and the section names Jev may point at. */
export function askState(profile, request) {
  return { request: cleanRequest(request), sections: askTargets(profile).map((t) => t.label) };
}

/** The step the strength answer asks for: probability-weighted over the whole spread
 * when Jev sends one, else the pick's own step when it is actionable, else the small
 * step. Always within SMALL_STEP..0.10 and rounded to 0.01. */
export function strengthStep(answer) {
  const read = readChoice(answer, STRENGTH_ASKED);
  let step;
  if (read.spread.length) {
    const total = read.spread.reduce((s, [, p]) => s + p, 0);
    step = read.spread.reduce((s, [c, p]) => s + stepOf(c) * p, 0) / total;
  } else {
    step = ACTIONABLE.has(read.status) ? stepOf(read.pick) ?? SMALL_STEP : SMALL_STEP;
  }
  return { step: round2(Math.min(STEP.Clearly, Math.max(SMALL_STEP, step))), read };
}

/** One side (raise or lower) read into {target, options}: a section to act on, or the
 * two close options the owner must choose between. `chosen` is the owner's own pick. */
function side(answer, criteria, chosen) {
  if (chosen) return { pick: chosen, read: { status: "chosen", confidence: null, runnerUp: null, runnerUpP: null }, options: [] };
  const read = readChoice(answer, criteria);
  if (ACTIONABLE.has(read.status) && read.pick !== NONE) return { pick: read.pick, read, options: [] };
  if (read.status === "ambiguous") {
    const options = read.spread.map(([c]) => c).filter((c) => c !== NONE).slice(0, 2);
    return { pick: null, read, options };
  }
  return { pick: null, read, options: [] };
}

/**
 * {ok: true, proposal, targets, strength} or {ok: false, reason, options?, reads}.
 * reason:
 *   "no_match"   Jev pointed at no section it was sure or leaning about
 *   "ambiguous"  Jev's top two were too close: options {raise: [a, b], lower: [a, b]}
 *   "conflict"   the same section came back as both more and less
 *   "at_limit"   every change would push a section past 0 or 1
 * `chosen` ({raise?, lower?}: a section label) is the owner's own Did-you-mean pick.
 * targets: [{id, label, direction, status, confidence, runnerUp, runnerUpP, step}].
 */
export function proposalFromAsk(profile, answers, { request, id, chosen = {} }) {
  const byLabel = new Map(askTargets(profile).map((t) => [t.label, t]));
  const criteria = askQuestions(profile).raise.criteria;
  const up = side(answers.raise, criteria, chosen.raise);
  const down = side(answers.lower, criteria, chosen.lower);
  const reads = { raise: up.read, lower: down.read };
  if (!up.pick && !down.pick) {
    if (up.options.length || down.options.length) {
      return { ok: false, reason: "ambiguous", options: { raise: up.options, lower: down.options }, reads };
    }
    return { ok: false, reason: "no_match", reads };
  }
  if (up.pick && up.pick === down.pick) return { ok: false, reason: "conflict", reads };
  const strength = strengthStep(answers.strength);

  const changes = [];
  const targets = [];
  for (const [s, sign] of [[up, 1], [down, -1]]) {
    const target = s.pick && byLabel.get(s.pick);
    if (!target) continue;
    const confident = s.read.status === "sure" || s.read.status === "chosen";
    const step = confident ? strength.step : Math.min(strength.step, SMALL_STEP);
    const old = profile.topics[target.id].affinity;
    const next = round2(Math.min(1, Math.max(0, old + sign * step)));
    if (next === old) continue;
    changes.push({ path: `$.topics.${target.id}.affinity`, old_value: old, new_value: next });
    targets.push({
      id: target.id, label: target.label, direction: sign > 0 ? "more" : "less", status: s.read.status,
      confidence: s.read.confidence, runnerUp: s.read.runnerUp, runnerUpP: s.read.runnerUpP, step,
    });
  }
  if (!changes.length) return { ok: false, reason: "at_limit", reads };

  const said = cleanRequest(request);
  return {
    ok: true,
    targets,
    strength: { label: strength.read.pick, confidence: strength.read.confidence, step: strength.step },
    proposal: {
      schema_version: 1,
      id,
      changes,
      rationale: said ? `You asked: ${said}` : "Your request in the Ask bar.",
      evidence: [{ kind: "owner_request", ref: id }],
    },
  };
}

const pct = (p) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "");

/** J2: the one line under each suggested change saying how sure Jev was, from every
 * part of its answer: the status, its confidence, and the runner-up it considered. */
export function confidenceLine(target) {
  const next = target.runnerUp && target.runnerUpP !== null ? ` · next: ${target.runnerUp} ${pct(target.runnerUpP)}` : "";
  if (target.status === "chosen") return "You chose this";
  if (target.status === "sure") return `Jev ${pct(target.confidence)} sure${next}`;
  if (target.status === "lean") return `Jev leaning, ${pct(target.confidence)}${next} · small step`;
  return "Jev gave no confidence · small step";
}


/** J21: what the Ask bar shows under it on focus, so a first-time reader sees what Jev
 * can do: up to three ready requests built from the reader's own sections and today's
 * feed, no Jev call. `counts` is {topic id: articles on today's page}. "Less" names the
 * section filling today's page most; "More" names the two with the lowest setting that
 * have something to show, the second with a size word, so every shape of request
 * appears once. */
export function askSuggestions(profile, counts = {}) {
  const topics = profile?.topics || {};
  const rows = askTargets(profile)
    .map((t) => ({ ...t, affinity: topics[t.id]?.affinity ?? 0, count: counts[t.id] || 0 }))
    .filter((t) => t.count > 0);
  if (!rows.length) return [];
  const less = [...rows].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0];
  const more = rows.filter((t) => t !== less && t.affinity < 1)
    .sort((a, b) => a.affinity - b.affinity || b.count - a.count || a.label.localeCompare(b.label));
  const out = [];
  if (more[0]) out.push(`More ${more[0].label}`);
  if (less.affinity > 0) out.push(`Less ${less.label}`);
  if (more[1]) out.push(`A lot more ${more[1].label}`);
  return out;
}
