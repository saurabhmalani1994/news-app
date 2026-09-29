// J13, J16: reading with Jev, the pure half (js/jev/read-view.js draws it in the reader).
// J16: Jev highlights a few key phrases (who, what happened, the number, where, when),
// picked from phrases the app finds in the article itself, instead of tinting whole
// sentences; the sentence tint stays only as the fallback when no phrase qualifies.
// Paragraph labels are sparing: only where Jev is sure, only the roles worth a label,
// each once, at most three per article.
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
/** J16: the roles worth a label, and the most labels an article gets. */
export const LABELLED = Object.freeze(new Set(["Main news", "New development", "Key number", "Quote"]));
export const MAX_LABELS = 3;
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

// --- J16: key phrases ---------------------------------------------------------------
// The app finds the candidates in the article's own words; Jev only picks among them.

export const NONE = "None of these";
export const PHRASE_SCOPE = 4; // the lede paragraphs candidates come from
const MAX_CANDIDATES = 30;

/** Words capitalised only because they start a sentence, or too general to mark. */
const NOT_A_NAME = new Set(("The A An And But Or So Yet For Nor In On At By To Of As If It Its This That These Those " +
  "He She They We I You His Her Their Our Your Who What When Where Why How After Before While During Since Until " +
  "Although Though Because Also Still Now Then Here There Some Many Most More Other Such Last Next Earlier Later " +
  "Meanwhile However Mr Mrs Ms Dr Sir").split(" "));
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const MONTH_WORD = new RegExp(`^${MONTH}$`);

/** News verbs worth highlighting as "what happened", by stem: each matches its forms
 * (approve, approves, approved, approving). */
const NEWS_VERBS = ("approv reject pass vot ban block sign announc launch releas arrest charg convict sentenc acquit " +
  "resign fir appoint elect win won lose lost defeat kill attack strik invad seiz captur rescu evacuat declar deni " +
  "admit confirm reveal warn threaten sanction sue su settl fin rais cut hik lower slash delay cancel scrap halt suspend " +
  "paus resum reopen clos shut collaps crash fall fell jump surg soar plung drop rose ris grow shrink merg acquir buy " +
  "bought sell sold invest fund spend hir laid lay layoff recall expand reduc end start begin began agre reach break " +
  "broke fail succeed discover found develop build built destroy damag flood burn die died injur hospitaliz " +
  "detain deport extradit indict investigat probe").split(" ");
const VERB_FORMS = /^(\w+?)(?:s|es|ed|d|ing|ment|ion)?$/;

function stemHit(word) {
  const w = word.toLowerCase();
  return NEWS_VERBS.find((stem) => w.startsWith(stem) && w.length - stem.length <= 4) || null;
}

/** Capitalised name runs ("Northfield Semiconductor", "President Xi", "U.S."), minus
 * sentence-start words and weekdays and months (those are "when"). */
export function nameCandidates(text) {
  const out = [];
  const re = /(?:[A-Z][a-z]+|[A-Z]{2,6}|(?:[A-Z]\.){2,4}|[A-Z][a-z]*[A-Z][a-z]+)(?:\s+(?:of|de|al|bin|van|von|the)?\s*(?:[A-Z][a-z]+|[A-Z]{2,6}|(?:[A-Z]\.){2,4}))*/g;
  for (const m of text.matchAll(re)) {
    let words = m[0].split(/\s+/);
    while (words.length && (NOT_A_NAME.has(words[0].replace(/\.$/, "")) || DAYS.includes(words[0]) || MONTH_WORD.test(words[0]))) words = words.slice(1);
    while (words.length && ["of", "de", "al", "bin", "van", "von", "the"].includes(words.at(-1))) words = words.slice(0, -1);
    const name = words.join(" ");
    if (name.length >= 2 && !DAYS.includes(name)) out.push(name);
  }
  return out;
}

/** Figures: money, percentages, and a count with its noun ("11 addresses"); a bare year
 * is left out. */
export function numberCandidates(text) {
  const out = [];
  const re = /(?:(?:US|S|A|HK)?[$£€¥]\s?\d[\d,.]*(?:\s?(?:million|billion|trillion|bn|m|k))?|\d[\d,.]*\s?(?:%|per ?cent)|\d[\d,.]*\s(?:million|billion|trillion)(?:\s[a-z]+)?|\b\d[\d,]*\s(?!(?:a\.m|p\.m|am|pm)\b)[a-z]{3,}(?:\s(?:of|in)\s[a-z]{3,})?)/g;
  for (const m of text.matchAll(re)) {
    const figure = m[0].trim().replace(/[.,]$/, "");
    if (/^(?:19|20)\d\d\s/.test(figure)) continue;
    out.push(figure);
  }
  return out;
}

/** Days and dates: weekdays, "today", "yesterday", "Sept. 28". */
export function whenCandidates(text) {
  const re = new RegExp(`\\b(?:${DAYS.join("|")}|today|yesterday|tomorrow|${MONTH}\\s\\d{1,2})\\b`, "g");
  return [...text.matchAll(re)].map((m) => m[0]);
}

/** Action words from the news verb list, the headline's own verbs first. */
export function actionCandidates(text, headline = "") {
  const headStems = new Set((headline.match(/[A-Za-z]+/g) || []).map(stemHit).filter(Boolean));
  const found = (text.match(/\b[a-z]{3,}\b/g) || []).filter((w) => stemHit(w));
  return [...new Set(found)].sort((a, b) => Number(headStems.has(stemHit(b))) - Number(headStems.has(stemHit(a))));
}

const uniq = (xs) => [...new Set(xs.filter((x) => x && x.length <= 60))].slice(0, MAX_CANDIDATES);

/** {names, numbers, whens, actions}: the candidates from the lede paragraphs. */
export function phraseCandidates(blocks, headline = "") {
  const text = blocks.paragraphs.slice(0, PHRASE_SCOPE).map((p) => p.sentences.map((x) => x.text).join(" ")).join(" ");
  return {
    names: uniq(nameCandidates(text)),
    numbers: uniq(numberCandidates(text)),
    whens: uniq(whenCandidates(text)),
    actions: uniq(actionCandidates(text, headline)),
  };
}

/** The phrase kinds: the question key, the reader's word, the candidate list it reads,
 * and the question, one positive claim each, "None of these" always allowed. */
export const PHRASE_KINDS = Object.freeze([
  ["who", "Who", "names", "Which person or organisation is this story's main news about?"],
  ["what", "What", "actions", "Which word says what happened in this story's main news?"],
  ["number", "Number", "numbers", "Which figure matters most to this story's main news?"],
  ["where", "Where", "names", "Which place is this story's main news about?"],
  ["when", "When", "whens", "Which day or date does this story's main news happen on?"],
]);

function phraseQuestions(candidates) {
  return PHRASE_KINDS.filter(([, , list]) => candidates[list].length)
    .map(([key, , list, instructions]) => [key, { type: "choice", instructions, criteria: [...candidates[list], NONE] }]);
}

/** The questions, split into calls of at most PER_CALL: the first carries the key
 * sentence and phrase questions. Each paragraph question names its paragraph. */
export function readingQuestions(blocks, headline = "") {
  const sentenceIds = blocks.paragraphs.flatMap((p) => p.sentences.map((x) => x.id));
  const all = [...phraseQuestions(phraseCandidates(blocks, headline))];
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
export function readingView(answers, blocks, headline = "") {
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
  // J16: labels only where Jev is sure, only the roles worth one, each once, at most three.
  const labels = {};
  const used = new Set();
  for (const p of blocks.paragraphs) {
    const role = roles[p.id];
    if (!role || role.status !== "sure" || !LABELLED.has(role.label) || used.has(role.label)) continue;
    if (used.size >= MAX_LABELS) break;
    labels[p.id] = role.label;
    used.add(role.label);
  }
  // J16: one phrase per kind where Jev picked one it was sure of or leaning to.
  const candidates = phraseCandidates(blocks, headline);
  const phrases = [];
  for (const [key, word, list] of PHRASE_KINDS) {
    const read = readChoice(answers[key], [...candidates[list], NONE]);
    if (!ACTIONABLE.has(read.status) || read.pick === NONE || !read.pick) continue;
    if (phrases.some((x) => x.text === read.pick)) continue;
    phrases.push({ kind: word, text: read.pick, confidence: read.confidence });
  }
  // The sentence tint only when no phrase qualified.
  return { roles, labels, keys: phrases.length ? [] : keys, phrases, skim };
}

/** A small per-device cache of reads, keyed by article id, oldest dropped past `cap`. */
export const READ_CACHE_KEY = "almanac.jev.read.v2"; // J16: new questions
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
