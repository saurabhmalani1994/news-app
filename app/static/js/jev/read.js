// J13, J17: reading with Jev, the pure half (js/jev/read-view.js draws it in the reader).
// The owner taps "Read with Jev" on a full-text article. Jev is shown the article with
// every sentence numbered ([S1], [S2] ...) and asked five takeaway questions, each a
// choice among those numbers or "None of these": the news, why it matters, the
// evidence, the other side, what's next. Jev answers with a number (choice), never with
// text; the app looks the number up in its own numbering and tints that sentence, and
// the Takeaways block quotes it. J17 replaces J16's word picks (who, what, when) and
// the paragraph labels, which the owner found too generic.
//
// J18: two layers scaled to the article's length, for reading the article itself. The
// named takeaways (at most one per third of the article's paragraphs) are listed in the
// block and tinted strongly; key points, one per section of about SECTION_SIZE
// paragraphs, are tinted lightly through the rest of the article so a long piece keeps
// its signposts. Jev reads the whole article (up to MAX_ARTICLE_CHARS), not its top.
//
// R13, amended by the owner on 2026-09-29: AI may point at the publisher's text, never
// write it. Every word shown is the publisher's; the only words the app adds are the
// fixed takeaway names below.

import { readChoice, ACTIONABLE } from "./decide.js";

export const MAX_PARAGRAPHS = 200;
export const MAX_ARTICLE_CHARS = 45000; // every full-text article in the pool measured 2026-09-29
export const SECTION_SIZE = 5;
export const MAX_NAMED_OPTIONS = 250; // Jev's choice takes up to 255 options
const PER_CALL = 12; // the most questions one call may carry (contract.js MAX_QUESTIONS)
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

/** The article's sections: runs of SECTION_SIZE paragraphs, [{key, from, to, ids}]. */
export function readingSections(blocks) {
  const out = [];
  for (let i = 0; i < blocks.paragraphs.length; i += SECTION_SIZE) {
    const part = blocks.paragraphs.slice(i, i + SECTION_SIZE);
    const ids = part.flatMap((p) => p.sentences.map((x) => x.id));
    if (ids.length) out.push({ key: `k${out.length + 1}`, from: part[0].id, to: part.at(-1).id, ids, paragraphs: part.map((p) => p.id) });
  }
  return out;
}

/** The questions, in calls of at most PER_CALL: the five named takeaways (over the first
 * MAX_NAMED_OPTIONS sentences), then one key point question per section, each a choice
 * among that section's own sentence numbers. None when the article has fewer than two
 * sentences. Every call carries the whole article as its state. */
export function readingQuestions(blocks) {
  const ids = blocks.paragraphs.flatMap((p) => p.sentences.map((x) => x.id));
  if (ids.length < 2) return [];
  const named = ids.slice(0, MAX_NAMED_OPTIONS);
  const all = TAKEAWAYS.map(([key, , instructions]) => [key, { type: "choice", instructions, criteria: [...named, NONE] }]);
  const sections = readingSections(blocks);
  if (sections.length > 1) {
    for (const sec of sections) {
      const span = sec.from === sec.to ? `paragraph ${sec.from}` : `paragraphs ${sec.from} to ${sec.to}`;
      all.push([sec.key, {
        type: "choice",
        instructions: `Which sentence in ${span} carries that part's main point? ${MARKED}`,
        criteria: [...sec.ids, NONE],
      }]);
    }
  }
  const calls = [];
  for (let i = 0; i < all.length; i += PER_CALL) calls.push(Object.fromEntries(all.slice(i, i + PER_CALL)));
  return calls;
}

/**
 * Jev's answers read through the decision rules (decide.js) and J18's density rules:
 *   takeaways: named picks [{key, name, id, text, paragraph, confidence}] in article
 *              order, at most one per three paragraphs (never fewer than one), kept in
 *              TAKEAWAYS priority order when capped. A pick counts only when Jev is sure,
 *              leaning or gave no confidence; a split, "None of these" or a sentence
 *              already used leaves it out.
 *   points:    key points [{key, id, text, paragraph, confidence}], one per section
 *              without a named takeaway, and never in a paragraph next to another marked
 *              one unless Jev was sure of it.
 *   skim:      paragraph ids holding any mark, or null when nothing is marked.
 */
export function readingView(answers, blocks) {
  const byId = new Map();
  const paraIndex = new Map(blocks.paragraphs.map((p, i) => [p.id, i]));
  for (const p of blocks.paragraphs) for (const x of p.sentences) byId.set(x.id, { text: x.text, paragraph: p.id });
  const ids = [...byId.keys()];
  const order = (id) => ids.indexOf(id);
  const taken = new Set();
  const cap = Math.max(1, Math.min(TAKEAWAYS.length, Math.floor(blocks.paragraphs.length / 3)));
  const takeaways = [];
  for (const [key, name] of TAKEAWAYS) {
    if (takeaways.length >= cap) break;
    const read = readChoice(answers[key], [...ids.slice(0, MAX_NAMED_OPTIONS), NONE]);
    if (!ACTIONABLE.has(read.status) || !byId.has(read.pick) || taken.has(read.pick)) continue;
    taken.add(read.pick);
    takeaways.push({ key, name, id: read.pick, ...byId.get(read.pick), confidence: read.confidence });
  }
  takeaways.sort((a, b) => order(a.id) - order(b.id));

  const marked = new Set(takeaways.map((t) => paraIndex.get(t.paragraph)));
  const points = [];
  const sections = readingSections(blocks);
  if (sections.length > 1) {
    for (const sec of sections) {
      if (sec.paragraphs.some((pid) => takeaways.some((t) => t.paragraph === pid))) continue;
      const read = readChoice(answers[sec.key], [...sec.ids, NONE]);
      if (!ACTIONABLE.has(read.status) || !byId.has(read.pick) || taken.has(read.pick)) continue;
      const at = paraIndex.get(byId.get(read.pick).paragraph);
      const crowded = marked.has(at - 1) || marked.has(at + 1);
      if (crowded && read.status !== "sure") continue;
      taken.add(read.pick);
      marked.add(at);
      points.push({ key: sec.key, id: read.pick, ...byId.get(read.pick), confidence: read.confidence });
    }
  }
  points.sort((a, b) => order(a.id) - order(b.id));
  const all = [...takeaways, ...points];
  const skim = all.length ? new Set(all.map((t) => t.paragraph)) : null;
  return { takeaways, points, skim };
}

/** J18: how a reading spreads through the article: marked paragraphs, their share, and
 * the longest run of paragraphs with no mark (the reader's longest stretch unguided). */
export function readingDensity(view, blocks) {
  const marked = new Set([...view.takeaways, ...view.points].map((t) => t.paragraph));
  let gap = 0;
  let run = 0;
  for (const p of blocks.paragraphs) {
    run = marked.has(p.id) ? 0 : run + 1;
    gap = Math.max(gap, run);
  }
  const n = blocks.paragraphs.length;
  return { marked: marked.size, paragraphs: n, share: n ? marked.size / n : 0, longestGap: gap };
}

/** A small per-device cache of reads, keyed by article id, oldest dropped past `cap`. */
export const READ_CACHE_KEY = "almanac.jev.read.v4"; // J18: section key points
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
