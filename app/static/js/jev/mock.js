// J1: a stand-in for Jev for local testing only (functions/api/jev.js uses it when
// JEV_MOCK=1 is set in the untracked .dev.vars). It answers in Jev's own response shape
// from plain word overlap, so the whole path (the phone, the function, the answer
// cleaning, the gate) runs on a laptop with no Cloudflare account and no cost. It is not
// a model and its answers mean nothing beyond "the plumbing works"; the deployed site
// never sets JEV_MOCK.

const NEGATIVE = ["attack", "war", "killed", "dead", "death", "crash", "collapse", "crisis", "fear", "fears", "fall", "falls",
  "loss", "lose", "collapses", "attacks", "fired", "ban", "banned", "fraud", "breach", "offensive", "fighting", "strike", "flood", "fire", "warn",
  "warns", "cut", "cuts", "layoffs", "recession", "sanctions", "protest", "arrest", "charged", "lawsuit", "decline", "slump"];
const POSITIVE = ["win", "wins", "won", "record", "breakthrough", "growth", "rise", "rises", "gain", "gains", "deal", "agree",
  "agreement", "peace", "truce", "approve", "approved", "recover", "recovery", "boost", "saved", "cure",
  "success", "celebrate", "award", "hope", "improve", "improves"];

const STOP = new Set(["of", "and", "the", "to", "in", "on", "or", "is", "it", "as", "at", "by", "an", "be", "for", "this", "that", "these", "with", "from", "about", "does", "reader"]);

const words = (text) => String(text).toLowerCase().match(/[a-z0-9]+/g) || [];

function stateText(state) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(state);
  return out.join(" ");
}

function overlap(bag, criterion) {
  return words(criterion).filter((w) => w.length > 1 && !STOP.has(w) && bag.has(w)).length;
}

function sentiment(bag) {
  const neg = NEGATIVE.filter((w) => bag.has(w)).length;
  const pos = POSITIVE.filter((w) => bag.has(w)).length;
  if (neg && pos) return "mixed";
  if (neg) return "negative";
  if (pos) return "positive";
  return "neutral";
}

function spread(criteria, pick, confidence) {
  const rest = (1 - confidence) / Math.max(1, criteria.length - 1);
  return Object.fromEntries(criteria.map((c) => [c, c === pick ? confidence : rest]));
}

/** Jev's response shape, {model, answers, usage}, for `questions` about `state`. */
export function mockJev({ state, questions }) {
  const request = typeof state?.request === "string" ? state.request : "";
  const text = stateText(state);
  const bag = new Set(words(text));
  const mood = sentiment(bag);
  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    const criteria = q.criteria || [];
    if (q.type === "noul") {
      const hits = overlap(bag, `${q.instructions} ${criteria.join(" ")}`);
      const p = Math.min(0.9, 0.3 + 0.15 * hits);
      answers[key] = { type: "noul", noul: p };
      continue;
    }
    let pick;
    const sentences = criteria.filter((c) => /^S\d+$/.test(c));
    if (sentences.length) {
      // J17: a sentence-number question; a stand-in spread over the article, and "None
      // of these" for the fourth kind so the empty case shows too.
      const slot = ["news", "why", "evidence", "other", "next"].indexOf(key);
      pick = slot === 3 ? criteria.at(-1) : sentences[Math.min(sentences.length - 1, Math.max(0, slot) * 3)];
    } else if (key === "sentiment") {
      const asked = { positive: "Good news", negative: "Bad news", mixed: "Both good and bad news", neutral: "Neither good nor bad news" }[mood];
      pick = criteria.includes(asked) ? asked : criteria[0];
    } else if (request && /\b(less|fewer)\b/i.test(request) && key === "lower") {
      pick = best(criteria, new Set(words(clause(request, /\b(?:less|fewer)\b/i, /\bmore\b/i))));
    } else if (request && /\bmore\b/i.test(request) && key === "raise") {
      pick = best(criteria, new Set(words(clause(request, /\bmore\b/i, /\b(?:less|fewer)\b/i))));
    } else if (request && (key === "raise" || key === "lower")) {
      pick = criteria.find((c) => /^none/i.test(c)) || criteria.at(-1);
    } else {
      pick = best(criteria, bag);
    }
    const confidence = 0.72;
    if (q.type === "choice") answers[key] = { type: "choice", choice: pick, confidence, probabilities: spread(criteria, pick, confidence) };
    else {
      // J6: the real shape, a 0-based position with a legend and index-keyed probabilities.
      const byName = spread(criteria, pick, confidence);
      answers[key] = {
        type: "score", score: criteria.indexOf(pick), confidence,
        legend: Object.fromEntries(criteria.map((c, i) => [String(i), c])),
        probabilities: Object.fromEntries(criteria.map((c, i) => [String(i), byName[c]])),
      };
    }
  }
  return { model: "mock-jev", answers, usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: 0 } };
}

/** The words after `start` in `request`, up to `stop` or the end. */
function clause(request, start, stop) {
  const after = request.split(start).slice(1).join(" ");
  return after.split(stop)[0];
}

/** The criterion sharing most words with `bag`; a "none"/"other" option, else the
 * middle of the list, when nothing overlaps. */
function best(criteria, bag) {
  let pick = null;
  let top = 0;
  for (const c of criteria) {
    const n = overlap(bag, c);
    if (n > top) { top = n; pick = c; }
  }
  return pick || criteria.find((c) => /^(none|other)/i.test(c)) || criteria[Math.floor((criteria.length - 1) / 2)];
}
