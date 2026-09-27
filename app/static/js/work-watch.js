// B11: the owner's work watch, private tiered keyword rules that feed the Biotech tab.
// Pure: no DOM, no storage, no clock. The ranker (on the device, and at build time
// under Node) and the You page use it here; fetcher/workwatch.py is its Python twin,
// and tests/fixtures/work_watch_parity.json holds cases both must answer the same (R2).
//
// A rule is {id, label, tier, terms, pair_any, exclude, exact}, kept in the profile's
// `work_watch` list. A text matches a rule when:
//   1. one of `terms` is in it as whole words, in order. With exact false (the usual
//      case) that is any case, accents ignored, a plural folded, like a phrase interest
//      (phrase.js). With exact true the words must carry the term's own capitals and no
//      plural is folded, for a name that is also an everyday word;
//   2. `pair_any` is empty, or one of its terms is in it too (any case, plural folded),
//      for a term that is too generic alone; and
//   3. none of `exclude` is in it (any case, plural folded).
// A story matches when its headlines and deks, taken together, do, or when a member
// carries the rule's watch tag, which the hourly run adds only to an item whose own
// headline and dek already passed the same test in fetcher/workwatch.py.
//
// Privacy: the rules leave the device only for this site's own /api/interests
// (interests-sync.js, behind Cloudflare Access), for the hourly search. The ranker names
// a rule by its label, and the pool carries only the rule's tag: "w:" and 10 hex digits
// of SHA-256 over "work:<id>", never a term.

import { containsWords, sha256Hex, textWords } from "./phrase.js";

export const WORK_RULES_MAX = 40;
export const WORK_TERMS_MAX = 30;
export const WORK_PAIR_MAX = 20;
export const WORK_EXCLUDE_MAX = 20;
export const WORK_TERM_MAX = 60;
export const WORK_LABEL_MAX = 60;
export const WORK_TIERS = Object.freeze([1, 2, 3, 4]);

/** The ranker's `work` term by tier, in points (1 is a term at full strength): tier 1
 * lifts a story about as much as a followed interest at Normal, tier 4 a little. */
export const WORK_TIER_POINTS = Object.freeze({ 1: 0.6, 2: 0.45, 3: 0.3, 4: 0.15 });

const MARKS = /\p{M}+/gu;
const WORD = /[\p{L}\p{N}]+/gu;
const POSSESSIVE = /['’][sS](?![\p{L}\p{N}])/gu;
const APOSTROPHE = /['’]/g;

/** A text as words with their capitals kept and nothing folded, for an exact rule:
 * accents stripped, "'s" dropped, apostrophes joined, every other non-letter,
 * non-digit run a boundary. */
export function exactWords(text) {
  const plain = String(text ?? "").normalize("NFKD").replace(MARKS, "").replace(POSSESSIVE, "").replace(APOSTROPHE, "");
  return plain.match(WORD) || [];
}

/** The watch tag of a rule, from its id alone: "w:" and 10 hex of SHA-256("work:<id>"). */
export function workTag(id) {
  return `w:${sha256Hex(`work:${String(id).trim().toLowerCase()}`).slice(0, 10)}`;
}

const list = (xs) => (Array.isArray(xs) ? xs : []);
const cleanTerm = (t) => String(t ?? "").replace(/["“”]/g, " ").trim().replace(/\s+/g, " ");

// A rule's word lists, computed once per rule value (the ranker asks for every story).
const matchers = new Map();

/** {terms, pair, exclude, exact, tag} for a rule: each term as its word list. */
export function ruleMatcher(rule) {
  const key = JSON.stringify([rule.id, rule.terms, rule.pair_any, rule.exclude, !!rule.exact]);
  let m = matchers.get(key);
  if (!m) {
    const exact = rule.exact === true;
    const words = (xs, keepCase) => list(xs).map((t) => (keepCase ? exactWords(cleanTerm(t)) : textWords(cleanTerm(t))))
      .filter((w) => w.length);
    m = { terms: words(rule.terms, exact), pair: words(rule.pair_any, false), exclude: words(rule.exclude, false), exact, tag: workTag(rule.id) };
    if (matchers.size > 500) matchers.clear();
    matchers.set(key, m);
  }
  return m;
}

const anyIn = (texts, needles) => needles.some((n) => texts.some((words) => containsWords(words, n)));

/** Texts as both word forms a rule may need, computed once for every rule. */
function textForms(texts) {
  const strings = list(texts).map((t) => String(t ?? ""));
  let exact = null;
  return { folded: strings.map(textWords), exact: () => (exact ||= strings.map(exactWords)) };
}

function matchForms(m, forms) {
  if (!m.terms.length) return false;
  if (!anyIn(m.exact ? forms.exact() : forms.folded, m.terms)) return false;
  if (m.pair.length && !anyIn(forms.folded, m.pair)) return false;
  return !anyIn(forms.folded, m.exclude);
}

/** Whether texts (plain strings: headlines and deks) match a rule. The same answer as
 * fetcher/workwatch.py rule_matches for the same rule and texts. */
export function matchRule(rule, texts) {
  return matchForms(ruleMatcher(rule), textForms(texts));
}

/** The rules a story matches, strongest first (tier, then id): by its headlines and
 * deks, or by a member's watch tag for the rule. */
export function storyWorkRules(story, rules) {
  const valid = list(rules).filter((r) => r && WORK_TIERS.includes(r.tier));
  if (!valid.length) return [];
  const forms = textForms([...list(story.titles), ...list(story.deks)]);
  const watch = list(story.watch);
  return valid
    .filter((r) => {
      const m = ruleMatcher(r);
      return watch.includes(m.tag) || matchForms(m, forms);
    })
    .sort((a, b) => a.tier - b.tier || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A profile's work rules, [] when it has none. */
export function workRules(profile) {
  return list(profile?.work_watch);
}

/** What the phone sends for the hourly search (functions/api/interests.js checks the
 * shape): each rule with its tag. The label goes too, so a phone that has no rules yet
 * can take seeded ones back (interests-sync.js); the fetcher never reads it. */
export function workPayloadRules(profile) {
  return workRules(profile).map((r) => ({
    id: r.id, label: r.label, tag: workTag(r.id), tier: r.tier, terms: list(r.terms), pair_any: list(r.pair_any),
    exclude: list(r.exclude), exact: r.exact === true,
  }));
}

/** The profile rules for payload rules (the server's stored `work`): the tag dropped. */
export function rulesFromPayload(work) {
  return list(work).map((r) => ({
    id: r.id, label: r.label, tier: r.tier, terms: list(r.terms), pair_any: list(r.pair_any),
    exclude: list(r.exclude), exact: r.exact === true,
  }));
}

/** "a, b; c" or one per line into a clean term list: trimmed, quotes dropped, no
 * blanks or repeats, each 2 to WORK_TERM_MAX characters, at most `max`. */
export function parseTerms(text, max = WORK_TERMS_MAX) {
  const seen = new Set();
  const out = [];
  const parts = Array.isArray(text) ? text : String(text ?? "").split(/[,;\n]/);
  for (const part of parts) {
    const term = cleanTerm(part);
    if (term.length < 2 || term.length > WORK_TERM_MAX || !textWords(term).length || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}
