// J1: the story analysis's pure half: what Jev is shown about one story, and how its
// answers read on the sheet. Node-tested; js/jev/story-view.js draws it.
//
// Jev sees the story as the page already has it: its headlines from every outlet in the
// cluster, the lead's dek, the outlets' names and the pool's own topic tags. Nothing
// about the reader goes with it.

import { STORY_LABELS, STORY_QUESTIONS, STORY_QUESTIONS_VERSION, SENTIMENT_CHOICES } from "./questions.js";
import { readChoice, readNoul } from "./decide.js";

export const MAX_HEADLINES = 8;
export const CACHE_KEY = "almanac.jev.story.v1";
export const CACHE_CAP = 300;

const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");

/** The story's longest fitted dek: the hero fit, first in app/build.py _fitted_deks. */
function dekText(input, sid) {
  const d = input?.deks?.[sid];
  return Array.isArray(d) && typeof d[0] === "string" ? d[0] : "";
}

export const MAX_ARTICLE_CHARS = 4000;

/** What Jev reads about story `sid`: {headline, other_headlines, summary, outlets, tags},
 * plus `article_text`, the opening of the lead's own body, when the story is one the
 * in-app reader can show (its source syndicates full text, R12). Everything else is
 * judged from its headlines and summary alone. */
export function storyState(input, sid, headline = "", articleText = "") {
  const articles = input?.pool?.articles || [];
  const byId = new Map(articles.map((a) => [a.id, a]));
  const cluster = (input?.pool?.clusters || []).find((c) => c.id === sid);
  const members = (cluster ? cluster.article_ids : [sid]).map((id) => byId.get(id)).filter(Boolean);
  const lead = (cluster && byId.get(cluster.lead)) || members[0] || {};
  const names = input?.names || {};
  const titles = [...new Set(members.map((a) => a.title).filter(Boolean))];
  const first = clip(headline || lead.title || titles[0] || "", 300);
  return {
    headline: first,
    other_headlines: titles.filter((t) => t !== first).slice(0, MAX_HEADLINES - 1).map((t) => clip(t, 300)),
    summary: clip(dekText(input, sid), 600),
    outlets: [...new Set(members.map((a) => names[a.source_id] || a.source_id).filter(Boolean))].slice(0, 20),
    tags: [...new Set(members.flatMap((a) => a.topics || []))].slice(0, 20),
    ...(articleText ? { article_text: clip(articleText.replace(/\s+/g, " ").trim(), MAX_ARTICLE_CHARS) } : {}),
  };
}

const pct = (p) => `${Math.round(p * 100)}%`;

/**
 * The sheet's view of Jev's answers, every part of each answer read through the
 * decision rules (js/jev/decide.js):
 *   verdict: {label, status, confidence, bars: [{label, p}]} or null. label reads the
 *            status: "Negative" (sure), "Leaning negative", "Negative or mixed" (top two
 *            too close), "Unclear". Bars only for the probabilities Jev sent.
 *   rows:    [{key, label, value, status, confidence}] in STORY_LABELS order. A choice or
 *            score row reads its status the same way. A yes/no row is labelled with its
 *            statement and reads "Likely 82%", "Possible 45%", "Unlikely 20%" or
 *            "Uncertain 45%": p is the probability that the statement is true, as asked,
 *            and is never read backwards as 1 - p.
 *   missing: how many questions Jev left unanswered
 */
const shownSentiment = (asked) => SENTIMENT_CHOICES.find(([a]) => a === asked)?.[1] || asked;
const BAND_WORD = { likely: "Likely", possible: "Possible", unlikely: "Unlikely", uncertain: "Uncertain" };

function choiceText(read, name = (x) => x) {
  if (read.status === "sure" || read.status === "unrated") return name(read.pick);
  if (read.status === "lean") return `${name(read.pick)} (likely)`;
  if (read.status === "ambiguous" && read.runnerUp) return `${name(read.pick)} or ${name(read.runnerUp)}`;
  return "Unclear";
}

export function analysisView(answers, missing = []) {
  const s = answers.sentiment;
  let verdict = null;
  if (s) {
    const read = readChoice(s, STORY_QUESTIONS.sentiment.criteria);
    const pick = shownSentiment(read.pick);
    const label = read.status === "lean" ? `Leaning ${pick.toLowerCase()}`
      : read.status === "ambiguous" && read.runnerUp ? `${pick} or ${shownSentiment(read.runnerUp).toLowerCase()}`
        : read.status === "sure" || read.status === "unrated" ? pick : "Unclear";
    verdict = {
      label, status: read.status, confidence: read.confidence,
      bars: SENTIMENT_CHOICES
        .filter(([asked]) => typeof s.probabilities?.[asked] === "number")
        .map(([asked, shown]) => ({ label: shown, p: s.probabilities[asked] })),
    };
  }
  const rows = [];
  for (const [key, label] of STORY_LABELS) {
    const a = answers[key];
    if (!a) continue;
    if (a.type === "noul") {
      const read = readNoul(a);
      rows.push({ key, label, value: `${BAND_WORD[read.band]} ${pct(read.p)}`, status: read.band, confidence: null });
    } else {
      const read = readChoice(a, STORY_QUESTIONS[key]?.criteria || []);
      rows.push({ key, label, value: choiceText(read), status: read.status, confidence: read.confidence });
    }
  }
  return { verdict, rows, missing: missing.length };
}

export const confidenceText = (c) => (typeof c === "number" ? pct(c) : "");

/** A small per-device cache of analyses, keyed by story id and question set version,
 * oldest dropped first past CACHE_CAP. `storage` is localStorage or a test stand-in. */
export function analysisCache(storage) {
  const read = () => {
    try {
      const data = JSON.parse(storage.getItem(CACHE_KEY) || "{}");
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  const keyFor = (sid) => `${STORY_QUESTIONS_VERSION}|${sid}`;
  return {
    get(sid) {
      return read()[keyFor(sid)] || null;
    },
    put(sid, value) {
      const data = read();
      delete data[keyFor(sid)];
      data[keyFor(sid)] = value;
      const keys = Object.keys(data);
      for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_CAP))) delete data[k];
      try {
        storage.setItem(CACHE_KEY, JSON.stringify(data));
      } catch {
        // A full storage only loses the cache, never the analysis on screen.
      }
    },
  };
}

export { STORY_QUESTIONS };
