// J2: the decision rules applied to every answer Jev returns, in one place, so each
// decision uses everything Jev sends: the pick, Jev's confidence in it, and the full
// probability spread (the runner-up and the margin between the top two). Pure; the Ask
// bar (ask.js) and the analysis sheet (story.js) read answers only through these.
//
// A choice or score answer is read into one status:
//   sure       confidence >= SURE, and the top two are at least MARGIN apart
//   lean       confidence >= LEAN, and the top two are at least MARGIN apart
//   ambiguous  the top two probabilities are within MARGIN of each other
//   unsure     confidence below LEAN
//   unrated    Jev sent a pick but neither a confidence nor probabilities
//   conflict   Jev's pick is not the option its own probabilities rank first
//   missing    no usable answer at all
// A yes/no (noul) answer is read only as asked: p is the probability that the
// question's statement is true, banded likely / possible / unlikely. 1 - p is never
// read as the probability of the opposite statement (see questions.js).

export const RULES = Object.freeze({
  SURE: 0.6,
  LEAN: 0.4,
  MARGIN: 0.15,
  LIKELY: 0.7,
  POSSIBLE: 0.4,
  // A noul with its own confidence below this is shown as uncertain, whatever its p.
  NOUL_CONFIDENT: 0.5,
});

/** Jev's probabilities over `criteria`, highest first, as [[option, p]]; [] if none. */
export function ranked(answer, criteria = []) {
  const probs = answer?.probabilities;
  if (!probs) return [];
  return criteria.filter((c) => typeof probs[c] === "number").map((c) => [c, probs[c]]).sort((a, b) => b[1] - a[1]);
}

/**
 * A choice or score answer, read with everything it carries:
 *   {status, pick, confidence, runnerUp, runnerUpP, margin, spread}
 * `spread` is [[option, p]] highest first, empty when Jev sent no probabilities.
 */
export function readChoice(answer, criteria = []) {
  if (!answer || typeof answer.label !== "string") {
    return { status: "missing", pick: null, confidence: null, runnerUp: null, runnerUpP: null, margin: null, spread: [] };
  }
  const spread = ranked(answer, criteria);
  const pick = answer.label;
  const confidence = typeof answer.confidence === "number" ? answer.confidence
    : spread.find(([c]) => c === pick)?.[1] ?? null;
  const [top, second] = spread;
  const runner = top && top[0] !== pick ? top : second || null;
  const margin = top && second ? top[1] - second[1] : null;
  const base = { pick, confidence, runnerUp: runner ? runner[0] : null, runnerUpP: runner ? runner[1] : null, margin, spread };
  if (top && top[0] !== pick && top[1] > (spread.find(([c]) => c === pick)?.[1] ?? 0)) return { ...base, status: "conflict" };
  if (confidence === null) return { ...base, status: "unrated" };
  if (margin !== null && margin < RULES.MARGIN) return { ...base, status: "ambiguous" };
  if (confidence >= RULES.SURE) return { ...base, status: "sure" };
  if (confidence >= RULES.LEAN) return { ...base, status: "lean" };
  return { ...base, status: "unsure" };
}

/** A score answer's probability-weighted position on its scale, 0 (first option) to
 * n - 1 (last), or null without probabilities. */
export function expectedPosition(answer, criteria = []) {
  const spread = ranked(answer, criteria);
  const total = spread.reduce((s, [, p]) => s + p, 0);
  if (!total) return null;
  return spread.reduce((s, [c, p]) => s + criteria.indexOf(c) * p, 0) / total;
}

/** A yes/no answer: {p, band, confidence}. band is likely, possible or unlikely for the
 * statement as asked, or uncertain when Jev's own confidence is low, or missing. */
export function readNoul(answer) {
  if (!answer || typeof answer.value !== "number") return { p: null, band: "missing", confidence: null };
  const p = answer.value;
  const confidence = typeof answer.confidence === "number" ? answer.confidence : null;
  if (confidence !== null && confidence < RULES.NOUL_CONFIDENT) return { p, band: "uncertain", confidence };
  const band = p >= RULES.LIKELY ? "likely" : p >= RULES.POSSIBLE ? "possible" : "unlikely";
  return { p, band, confidence };
}

/** Statuses a decision may act on without asking the owner which option they meant. */
export const ACTIONABLE = Object.freeze(new Set(["sure", "lean", "unrated"]));
