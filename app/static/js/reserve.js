// J26: the reserve on the phone. Each hourly run writes the best articles the pool did
// not keep, one small file per topic tag (fetcher/keep_rule.py write_reserve:
// reserve/<tag>.json and reserve/index.json). When the owner raises a topic (a Boost,
// the Ask bar's "more X", the You tab), story-actions.js asks pullReserve for that
// topic's file, merges its articles into the page's own ranking input as single-article
// stories, and re-ranks: the owner's own profile then decides where, if anywhere, each
// one lands, exactly as for the pool's own stories. Nothing is sent anywhere; the files
// are the site's own, like pool.json. Every feed string is set as text (R26).

import { TAG_TO_TOPIC } from "./ranker.js";

export const TIMEOUT_MS = 4000;
const RANK_FIELDS = ["id", "source_id", "title", "published_at", "topics", "geo"];
const SAFE_TAG = /^[a-z][a-z0-9_]{0,40}$/;
const WEB = /^https?:\/\/[^\s]+$/i;

/** The profile topics the owner raised from `before` to `after`: a higher affinity, a
 * topic switched on, a topic unmuted, or a new topic boost. */
export function raisedTopics(before, after) {
  const was = before?.topics || {};
  const now = after?.topics || {};
  const out = new Set();
  for (const [id, t] of Object.entries(now)) {
    if (id === "must_know" || t?.enabled === false) continue;
    const old = was[id];
    if (!old || old.enabled === false || (typeof t.affinity === "number" && t.affinity > (old.affinity ?? 0) + 1e-9)) out.add(id);
  }
  const mutedBefore = new Set(before?.mutes?.topics || []);
  for (const id of mutedBefore) if (!(after?.mutes?.topics || []).includes(id)) out.add(id);
  const boostsBefore = new Set((before?.boosts || []).map((b) => b.id));
  for (const b of after?.boosts || []) {
    if (b.match_type === "topic" && !boostsBefore.has(b.id)) out.add(String(b.match_value));
  }
  for (const id of after?.mutes?.topics || []) out.delete(id);
  return [...out].sort();
}

/** The reserve files for a profile topic: its own tag when the reserve has one, else
 * the pool tags the ranker reads as that topic (ranker.js TAG_TO_TOPIC). */
export function tagsFor(topicId, shards = {}) {
  if (shards[topicId]) return [topicId];
  return Object.entries(TAG_TO_TOPIC).filter(([tag, topic]) => topic === topicId && shards[tag]).map(([tag]) => tag);
}

async function getJSON(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { credentials: "same-origin", signal: controller.signal });
    if (!res.ok || res.redirected) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The reserve's articles for `topics` (profile topic ids), newest file only: {records,
 * tags}, or {records: [], tags: []} when there is no reserve or it is from another
 * edition than the page's (`generatedAt`, the pool's own). */
export async function loadReserve(topics, generatedAt, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const index = await getJSON("reserve/index.json", fetchImpl, timeoutMs);
  if (!index || typeof index.shards !== "object" || (generatedAt && index.generated_at !== generatedAt)) return { records: [], tags: [] };
  const tags = [...new Set(topics.flatMap((t) => tagsFor(t, index.shards)))].filter((t) => SAFE_TAG.test(t));
  const docs = await Promise.all(tags.map((t) => getJSON(`reserve/${t}.json?v=${encodeURIComponent(index.generated_at)}`, fetchImpl, timeoutMs)));
  const seen = new Set();
  const records = [];
  for (const doc of docs) {
    for (const r of Array.isArray(doc?.articles) ? doc.articles : []) {
      if (!r || typeof r.id !== "string" || typeof r.title !== "string" || seen.has(r.id)) continue;
      seen.add(r.id);
      records.push(r);
    }
  }
  return { records, tags };
}

/** Adds reserve records the page does not already hold to `input` (the page's ranking
 * input, js/page-input.js): each as a pool article with the ranker's fields, its dek
 * for the row, and its url and outlet for reserveRow. Returns the ids added. */
export function mergeReserve(input, records) {
  const pool = input.pool || (input.pool = { articles: [], clusters: [] });
  const have = new Set((pool.articles || []).map((a) => a.id));
  const urls = new Set(Object.values(input.coverage || {}).map((c) => c?.url).filter(Boolean));
  input.reserve = input.reserve || {};
  input.deks = input.deks || {};
  const added = [];
  for (const r of records) {
    if (have.has(r.id) || (r.url && urls.has(r.url))) continue;
    const article = {};
    for (const k of RANK_FIELDS) if (r[k] !== undefined) article[k] = r[k];
    article.topics = Array.isArray(r.topics) ? r.topics : [];
    pool.articles.push(article);
    input.reserve[r.id] = { url: typeof r.url === "string" ? r.url : "", source_id: r.source_id, published_at: r.published_at };
    if (typeof r.dek === "string" && r.dek) input.deks[r.id] = [r.dek];
    have.add(r.id);
    added.push(r.id);
  }
  return added;
}

/** "12 min ago", "3h ago", "2d ago", as the build writes a row's age (app/build.py). */
export function relativeAge(iso, nowMs) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((nowMs - then) / 60000));
  if (minutes < 60) return `${Math.max(minutes, 1)} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

/** A card for reserve story `id`, cloned from one of the page's own cards (`template`)
 * so it carries the same structure, classes and action row, then rewritten: its
 * headline, outlet and age, a link to the publisher's page (the reserve holds no full
 * text, so its open button says Open site), and none of the template's photo, dek,
 * versions button, lean target or other side. Returns null without a template. */
export function reserveRow(id, input, template, nowMs = Date.now()) {
  const info = input.reserve?.[id];
  const article = (input.pool?.articles || []).find((a) => a.id === id);
  if (!template || !info || !article) return null;
  const li = template.cloneNode(true);
  li.dataset.sid = id;
  delete li.dataset.face;
  li.dataset.reserve = "1";
  li.querySelectorAll(".story-media, .story-credit, .dek, .other-side, .lean-hit, .story-coverage, .lean, .meta-read-source, .story-marks").forEach((n) => n.remove());
  li.querySelector(".headline").textContent = article.title;
  const link = li.querySelector(".story-link");
  if (link) {
    delete link.dataset.body;
    if (WEB.test(info.url)) {
      link.setAttribute("href", info.url);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } else {
      link.removeAttribute("href");
    }
  }
  const meta = li.querySelector(".meta");
  if (meta) {
    const line = li.ownerDocument.createElement("span");
    line.className = "meta-line";
    const source = li.ownerDocument.createElement("span");
    source.className = "meta-source";
    source.textContent = (input.names || {})[article.source_id] || article.source_id || "";
    const age = li.ownerDocument.createElement("span");
    age.className = "meta-age";
    age.textContent = relativeAge(article.published_at, nowMs);
    line.append(source, " · ", age);
    meta.replaceChildren(line);
  }
  const times = li.querySelector(".story-times");
  if (times) {
    times.setAttribute("data-written", article.published_at || "");
    times.setAttribute("data-pulled", "");
    globalThis.window?.almanacFillTimes?.(li);
  }
  return li;
}

/** "Added 6 Singapore stories from earlier today." */
export function addedMessage(count, labels) {
  const what = labels.length === 1 ? `${labels[0]} ` : "";
  return `Added ${count} ${what}${count === 1 ? "story" : "stories"} from earlier today.`;
}
