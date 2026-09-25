// W1: "Follow this story" (a row's overflow menu, story-actions.js) prefills a new
// standing story's name and keywords from the story's own headlines, for the owner to
// check and edit before he follows it. Candidates are the headlines' entities (runs of
// capitalized words, "El Fasher", "RSF") and their words; each scores by how many of the
// story's headlines hold it times how rare it is across every headline in the pool
// (inverse document frequency), so "Sudan" beats "army" and "talks" beats nothing. An
// entity counts a little more than a plain word, and a word most of the pool uses is
// never offered. Pure and deterministic, Node tested (tests/js/story-keywords.test.js).

import { containsWords, textWords } from "./phrase.js";

export const SUGGEST_KEYWORDS = 5;
const MIN_KEYWORDS = 3;
const LABEL_MAX = 40;

// English function words and headline filler: never a name, never a keyword.
const STOP = new Set(`a an the and or but nor of in on at to for from by with as is are was were be been being am
it its it's this that these those there here after before over under about into onto amid against between during
through than then not no yes new says say said tells told will would could can may might should must has have had
do does did done up down out off more most less least how why what when where who whom which while his her hers their
theirs our ours your yours my mine he she they we you i me us him them all any some each every both one two three four
five first last next year years day days week weeks month months today tonight yesterday tomorrow just also now still
back set get gets got make makes made take takes took via per vs report reports reported live latest update updates
news so if as s t very much many few other others another again since until because though although whether its
like near amid top big small ahead behind why how watch video photos opinion analysis explainer exclusive breaking
first second third`.split(/\s+/));

// Lowercase words that sit inside a name: "Bank of England", "Gulf of Aden".
const CONNECTORS = new Set(["of", "de", "del", "da", "al", "el", "la", "le", "bin", "van", "von", "du"]);

const TOKEN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const isUpper = (t) => /^\p{Lu}/u.test(t);
const isAcronym = (t) => t.length >= 2 && /^[\p{Lu}\p{N}]+$/u.test(t) && /\p{Lu}/u.test(t);
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A headline's tokens, with the one capital a sentence-case headline always has (its
 * first word) not read as a name unless the same word is capitalized mid-headline in
 * another of the story's headlines, and nothing read as a name in a Title Case
 * headline, where every word is capitalized. */
function tokensOf(title, midCaps) {
  const tokens = (String(title || "").match(TOKEN) || []).map((t) => t.replace(/['’]s$/u, "")).filter(Boolean);
  const long = tokens.filter((t) => t.length >= 4 && !STOP.has(t.toLowerCase()));
  const titleCase = long.length >= 3 && long.filter(isUpper).length / long.length >= 0.6;
  // A capitalized first word is a name when a capitalized word follows it, directly or
  // after a connector: "Donald Trump says", "Bank of England holds", not "Army retakes".
  const nextCap = (i) => {
    const next = tokens[i + 1];
    if (next && CONNECTORS.has(next.toLowerCase())) return !!tokens[i + 2] && isUpper(tokens[i + 2]);
    return !!next && isUpper(next);
  };
  return tokens.map((t, i) => {
    const cap = !titleCase && (isAcronym(t) || (isUpper(t) && (i > 0 || midCaps.has(t) || nextCap(i))));
    return { text: t, key: t.toLowerCase(), cap };
  });
}

/** Every candidate in one headline: each non-stop word, and each run of capitalized
 * words (trimmed of stop words at either end) as one entity. */
function candidatesOf(tokens) {
  const out = [];
  for (const t of tokens) {
    if (STOP.has(t.key) || /^\p{N}+$/u.test(t.key)) continue;
    if (t.key.length < 3 && !isAcronym(t.text)) continue;
    out.push({ key: t.key, text: t.text, entity: t.cap });
  }
  let run = [];
  const flush = () => {
    while (run.length && (!run[0].cap || STOP.has(run[0].key))) run.shift();
    while (run.length && (!run[run.length - 1].cap || STOP.has(run[run.length - 1].key))) run.pop();
    if (run.length >= 2) out.push({ key: run.map((t) => t.key).join(" "), text: run.map((t) => t.text).join(" "), entity: true });
    run = [];
  };
  for (const t of tokens) {
    if (t.cap || (run.length && CONNECTORS.has(t.key))) run.push(t);
    else flush();
  }
  flush();
  return out;
}

/**
 * Suggests {label, keywords} for following a story as a standing story. `titles` are
 * the story's own headlines; `poolTitles` every headline in the pool (the story's
 * included), for rarity. `keywords` are lowercased, best first, at most
 * SUGGEST_KEYWORDS, none inside another; `label` is the best entity as written, else
 * the best word capitalized, else "" (the owner names it).
 */
export function suggestStanding(titles, poolTitles = []) {
  const own = (titles || []).filter(Boolean);
  const midCaps = new Set(own.flatMap((t) => (String(t).match(TOKEN) || []).slice(1).filter(isUpper)));
  const found = new Map();
  own.forEach((title, index) => {
    for (const c of candidatesOf(tokensOf(title, midCaps))) {
      const entry = found.get(c.key) || { key: c.key, forms: new Map(), entity: false, in: new Set() };
      entry.forms.set(c.text, (entry.forms.get(c.text) || 0) + 1);
      entry.entity ||= c.entity;
      entry.in.add(index);
      found.set(c.key, entry);
    }
  });
  const pool = [...new Set([...poolTitles, ...own].filter(Boolean))].map(textWords);
  const n = pool.length;
  const scored = [...found.values()].map((e) => {
    const words = textWords(e.key);
    const df = pool.filter((w) => containsWords(w, words)).length;
    const idf = Math.log((n + 1) / (df + 0.5));
    const form = [...e.forms.entries()].sort((a, b) => b[1] - a[1] || byStr(a[0], b[0]))[0][0];
    const score = e.in.size * idf * (e.entity ? 1.5 : 1) * (words.length > 1 ? 1.2 : 1);
    return { key: e.key, words, form, entity: e.entity, df, score };
  }).filter((c) => c.words.length && c.score > 0 && !(n >= 20 && c.df / n > 0.2))
    .sort((a, b) => b.score - a.score || byStr(a.key, b.key));

  // Names first: a standing story is a place, a group or a person far more often than
  // a verb, and a plain word joins only while fewer than MIN_KEYWORDS names were found.
  const chosen = [];
  const take = (list, limit) => {
    for (const c of list) {
      if (chosen.length >= limit) break;
      if (chosen.some((k) => containsWords(k.words, c.words) || containsWords(c.words, k.words))) continue;
      chosen.push(c);
    }
  };
  take(scored.filter((c) => c.entity), SUGGEST_KEYWORDS);
  take(scored.filter((c) => !c.entity), Math.max(chosen.length, MIN_KEYWORDS));
  const lead = chosen.find((c) => c.entity) || chosen[0];
  let label = lead ? lead.form : "";
  if (label && !lead.entity) label = label.charAt(0).toUpperCase() + label.slice(1);
  if (label.length > LABEL_MAX) label = label.slice(0, LABEL_MAX).replace(/\s+\S*$/, "") || label.slice(0, LABEL_MAX);
  return { label, keywords: chosen.map((c) => c.key) };
}
