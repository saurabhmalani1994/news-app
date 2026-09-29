// J13, J17: reading with Jev, the pure half (js/jev/read-view.js draws it in the reader).
// The owner taps "Read with Jev" on a full-text article. Jev is shown the article with
// every sentence numbered ([S1], [S2] ...) and asked five takeaway questions, each a
// choice among those numbers or "None of these": the news, why it matters, the
// evidence, the other side, what's next. Jev answers with a number (choice), never with
// text; the app looks the number up in its own numbering and tints that sentence, and
// the Takeaways block quotes it. J17 replaces J16's word picks (who, what, when) and
// the paragraph labels, which the owner found too generic.
//
// R13, amended by the owner on 2026-09-29: AI may point at the publisher's text, never
// write it. Every word shown is the publisher's; the only words the app adds are the
// fixed takeaway names below.

import { readChoice, ACTIONABLE } from "./decide.js";

export const MAX_PARAGRAPHS = 22;
export const MAX_ARTICLE_CHARS = 6500;
export const NONE = "None of these";
const MARKED = "Sentences are marked [S1], [S2] and so on.";

/** The takeaways, in the order they are asked and tie-broken: key, the name the reader
 * shows, and the question (one positive claim each). */
export const TAKEAWAYS = Object.freeze([
  ["news", "The news", `Which sentence states this article's main news most directly? ${MARKED}`],
  ["why", "Why it matters", `Which sentence explains why this news matters or who it affects? ${MARKED}`],
  ["evidence", "The evidence", `Which sentence gives the strongest evidence or the most important figure? ${MARKED}`],
  ["other", "The other side", `Which sentence gives a response or an opposing view? ${MARKED}`],
  ["next", "What's next", `Which sentence says what happens next? ${MARKED}`],
]);

// A piece ending in one of these is not a sentence end: initials (U.S., U.N.), titles
// and the usual shortenings of names, months and companies.
const ABBREVIATION = /(?:^|[\s(“"‘])(?:(?:[A-Z]\.){1,4}|(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|Gen|Sen|Rep|Gov|Lt|Col|Capt|Sgt|Rev|No|Inc|Co|Corp|Ltd|vs|etc|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.)$/;

/** A paragraph's sentences: split after . ! or ? (and a closing quote or bracket) where
 * the next sentence starts with a capital, a digit or an opening quote, then joined back
 * where the split fell after an abbreviation ("U.S. officials", "Mr. Smith"). */
export function splitSentences(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const pieces = clean.split(/(?<=[.!?][”"’)\]]?)\s+(?=[A-Z0-9“"‘(\[])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const piece of pieces) {
    if (out.length && ABBREVIATION.test(out[out.length - 1])) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out;
}

/**
 * The article as Jev reads it. `texts` are the reader's paragraphs, in order. Returns
 * {paragraphs: [{id: "P1", index, sentences: [{id: "S1", text}]}], state}, kept to
 * MAX_PARAGRAPHS and about MAX_ARTICLE_CHARS; `index` is the paragraph's position in
 * `texts`, so the view can find its element again.
 */
export function readingBlocks(texts, { headline = "", outlet = "" } = {}) {
  const paragraphs = [];
  const shown = {};
  let chars = 0;
  let s = 0;
  texts.forEach((text, index) => {
    if (paragraphs.length >= MAX_PARAGRAPHS || chars >= MAX_ARTICLE_CHARS) return;
    const sentences = splitSentences(text);
    if (!sentences.length) return;
    const id = `P${paragraphs.length + 1}`;
    const numbered = sentences.map((t) => ({ id: `S${++s}`, text: t }));
    paragraphs.push({ id, index, sentences: numbered });
    const line = numbered.map((x) => `[${x.id}] ${x.text}`).join(" ");
    shown[id] = line;
    chars += line.length;
  });
  return { paragraphs, state: { headline: String(headline).slice(0, 300), outlet: String(outlet).slice(0, 80), paragraphs: shown } };
}

/** The five takeaway questions, in one call: each a choice among the article's own
 * sentence numbers, "None of these" always allowed. None when the article has fewer
 * than two sentences. */
export function readingQuestions(blocks) {
  const ids = blocks.paragraphs.flatMap((p) => p.sentences.map((x) => x.id));
  if (ids.length < 2) return [];
  return [Object.fromEntries(TAKEAWAYS.map(([key, , instructions]) => [key, { type: "choice", instructions, criteria: [...ids, NONE] }]))];
}

/**
 * Jev's answers read through the decision rules (decide.js):
 *   takeaways: [{key, name, id, text, paragraph, confidence}] in article order. A pick
 *              counts only when Jev is sure, leaning or gave no confidence; a split (top
 *              two too close) or "None of these" leaves that takeaway out; a sentence is
 *              used once, by the first takeaway that picked it.
 *   skim:      paragraph ids Skim keeps (those holding a takeaway), or null when there
 *              is nothing to skim to.
 */
export function readingView(answers, blocks) {
  const byId = new Map();
  for (const p of blocks.paragraphs) for (const x of p.sentences) byId.set(x.id, { text: x.text, paragraph: p.id });
  const ids = [...byId.keys()];
  const taken = new Set();
  const takeaways = [];
  for (const [key, name] of TAKEAWAYS) {
    const read = readChoice(answers[key], [...ids, NONE]);
    if (!ACTIONABLE.has(read.status) || !byId.has(read.pick) || taken.has(read.pick)) continue;
    taken.add(read.pick);
    takeaways.push({ key, name, id: read.pick, ...byId.get(read.pick), confidence: read.confidence });
  }
  const order = (id) => ids.indexOf(id);
  takeaways.sort((a, b) => order(a.id) - order(b.id));
  const skim = takeaways.length ? new Set(takeaways.map((t) => t.paragraph)) : null;
  return { takeaways, skim };
}

/** A small per-device cache of reads, keyed by article id, oldest dropped past `cap`. */
export const READ_CACHE_KEY = "almanac.jev.read.v3"; // J17: takeaway questions
export function readCache(storage, cap = 100) {
  const read = () => {
    try {
      const data = JSON.parse(storage.getItem(READ_CACHE_KEY) || "{}");
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  return {
    get: (id) => read()[id] || null,
    put(id, value) {
      const data = read();
      delete data[id];
      data[id] = value;
      const keys = Object.keys(data);
      for (const k of keys.slice(0, Math.max(0, keys.length - cap))) delete data[k];
      try {
        storage.setItem(READ_CACHE_KEY, JSON.stringify(data));
      } catch {
        // A full storage only loses the cache.
      }
    },
  };
}
