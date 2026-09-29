// J13: reading with Jev, the pure half (js/jev/read-view.js draws it in the reader).
// The owner taps "Read with Jev" on a full-text article; Jev is shown the article as
// numbered paragraphs with numbered sentences and asked, for each paragraph, what it is
// mainly doing, and which sentence states the main news. The reader then labels each
// paragraph with the app's own words and highlights the key sentences in place.
//
// R13, amended by the owner on 2026-09-29: AI may point at the publisher's text, never
// write it. Every word on the page stays the publisher's; Jev only picks paragraph roles
// from ROLE_CHOICES and sentence numbers from the article's own, and a pick is used only
// when the decision rules (decide.js) say Jev was sure enough.

import { readChoice, ACTIONABLE } from "./decide.js";

export const MAX_PARAGRAPHS = 22;
export const MAX_ARTICLE_CHARS = 6500;
export const MAX_KEY_SENTENCES = 3;
export const KEY_MIN_P = 0.25;
const PER_CALL = 12; // the most questions one call may carry (contract.js MAX_QUESTIONS)

/** What each paragraph can be doing: as Jev is asked, and as the reader labels it. */
export const ROLE_CHOICES = Object.freeze([
  ["Reports the main news", "Main news"],
  ["Reports a new development", "New development"],
  ["Gives a key number or figure", "Key number"],
  ["Quotes someone directly", "Quote"],
  ["Gives background or context", "Background"],
  ["Reports a reaction", "Reaction"],
  ["Offers analysis or opinion", "Analysis"],
]);
/** The roles Skim keeps; the rest fold away. */
export const SKIM_KEEPS = Object.freeze(new Set(["Main news", "New development", "Key number", "Quote"]));

const ROLES_ASKED = ROLE_CHOICES.map(([asked]) => asked);
const shownRole = (asked) => ROLE_CHOICES.find(([a]) => a === asked)?.[1] || null;

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

/** The questions, split into calls of at most PER_CALL: the first carries the key
 * sentence question. Each paragraph question names its paragraph. */
export function readingQuestions(blocks) {
  const sentenceIds = blocks.paragraphs.flatMap((p) => p.sentences.map((x) => x.id));
  const all = [];
  if (sentenceIds.length >= 2) {
    all.push(["key", {
      type: "choice",
      instructions: "Which one sentence states this article's main news most directly? Sentences are marked [S1], [S2] and so on.",
      criteria: sentenceIds,
    }]);
  }
  for (const p of blocks.paragraphs) {
    all.push([p.id.toLowerCase(), {
      type: "choice",
      instructions: `What is paragraph ${p.id} of this article mainly doing? Paragraphs are the keys P1, P2 and so on.`,
      criteria: [...ROLES_ASKED],
    }]);
  }
  const calls = [];
  for (let i = 0; i < all.length; i += PER_CALL) calls.push(Object.fromEntries(all.slice(i, i + PER_CALL)));
  return calls;
}

/**
 * Jev's answers read through the decision rules:
 *   roles: {P1: {label, status, confidence}} only where Jev was sure, leaning or gave no
 *          confidence; a split or unsure paragraph gets no label
 *   keys:  sentence ids to highlight: Jev's pick, then any other sentence it gave at
 *          least KEY_MIN_P, at most MAX_KEY_SENTENCES; none when Jev was unsure
 *   skim:  paragraph ids Skim keeps: the SKIM_KEEPS roles, any paragraph holding a key
 *          sentence, and any paragraph Jev gave no usable role (never hidden on a guess)
 */
export function readingView(answers, blocks) {
  const roles = {};
  for (const p of blocks.paragraphs) {
    const read = readChoice(answers[p.id.toLowerCase()], ROLES_ASKED);
    if (ACTIONABLE.has(read.status)) roles[p.id] = { label: shownRole(read.pick), status: read.status, confidence: read.confidence };
  }
  const sentenceIds = blocks.paragraphs.flatMap((p) => p.sentences.map((x) => x.id));
  const key = readChoice(answers.key, sentenceIds);
  let keys = [];
  if (ACTIONABLE.has(key.status) || key.status === "ambiguous") {
    keys = [key.pick, ...key.spread.filter(([id, p]) => id !== key.pick && p >= KEY_MIN_P).map(([id]) => id)];
    if (key.status === "ambiguous" && key.runnerUp && !keys.includes(key.runnerUp)) keys.push(key.runnerUp);
    keys = keys.slice(0, MAX_KEY_SENTENCES);
  }
  const holdsKey = (p) => p.sentences.some((x) => keys.includes(x.id));
  const skim = new Set(blocks.paragraphs
    .filter((p) => !roles[p.id] || SKIM_KEEPS.has(roles[p.id].label) || holdsKey(p))
    .map((p) => p.id));
  return { roles, keys, skim };
}

/** A small per-device cache of reads, keyed by article id, oldest dropped past `cap`. */
export const READ_CACHE_KEY = "almanac.jev.read.v1";
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
