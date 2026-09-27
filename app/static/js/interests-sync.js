// W1 (R50): the phone side of the search sync. The owner's phrase interests and the
// standing stories he has on become Google News queries that W2's hourly run searches,
// so a phrase can find stories that are not on the phone yet ("a mix of 1 and 2").
//
// For each phrase interest that is on, q is the phrase in quotes; for each standing
// story that is on, q is its keywords as "a" OR "b" OR "c" (phrase.js). Each q carries
// its tag, "w:" plus the first 10 hex digits of SHA-256 over q normalized, computed here
// with Web Crypto. The phone PUTs {"v":1,"queries":[{"q","tag"}]} (at most 25 queries,
// each q at most 100 characters) to this site's own /api/interests (functions/, behind
// Cloudflare Access, keyed by the Access user), on every save through ProfileStore's
// onSave, debounced, and on every load, so an edit made offline goes out later. Nothing
// is sent when the value is what was last sent, unless that was a day ago (so a store
// that lost it is refilled). Only a digest of the last value sent is kept here.
//
// Pure where it can be (watchQueryStrings, watchPayload, syncInterests take everything
// they touch as arguments), so tests/js/interests-sync.test.js runs it under Node.
//
// B11: a profile with a work_watch list (work-watch.js) sends {"v":2,"queries","work"},
// the rules with their tags; one without the field sends version 1 as before, and the
// server keeps any work rules it already holds. While the profile has no work_watch
// field, each sync first reads the server's value, and when it holds work rules (seeded
// straight into KV from the owner's PC) hands them to `adopt`, which the page saves into
// the profile; from then on the phone's own list is the one sent.

import { STORAGE_KEY } from "./profile/store.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { STANDING_DEFAULTS } from "./standing.js";
import { QUERIES_MAX, QUERY_MAX, isPhraseTopic, normalizeQuery, phraseQuery, storyQuery } from "./phrase.js";
import { rulesFromPayload, workPayloadRules } from "./work-watch.js";

export const ENDPOINT = "/api/interests";
export const SYNC_KEY = "almanac.interests.sync.v1";
export const DEBOUNCE_MS = 1500;
export const REFRESH_MS = 24 * 3_600_000;
const RETRY_MS = [60_000, 300_000, 900_000];

/** The queries for a profile, phrases first (list order), then standing stories
 * (priority order), repeats dropped, capped at QUERIES_MAX and QUERY_MAX characters. */
export function watchQueryStrings(profile) {
  const out = [];
  const seen = new Set();
  const add = (q) => {
    const key = normalizeQuery(q);
    if (!key || q.length > QUERY_MAX || seen.has(key) || out.length >= QUERIES_MAX) return;
    seen.add(key);
    out.push(q);
  };
  for (const topic of Object.values(profile?.topics || {})) {
    if (isPhraseTopic(topic) && topic.enabled !== false) add(phraseQuery(topic.phrase));
  }
  const stories = Array.isArray(profile?.standing_stories) ? profile.standing_stories : STANDING_DEFAULTS;
  for (const story of stories) if (story && story.enabled !== false) add(storyQuery(story.keywords));
  return out;
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function digest(text, subtle) {
  return new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** A query's tag, with Web Crypto: "w:" and the first 10 hex digits of SHA-256(q normalized). */
export async function watchTag(q, subtle = globalThis.crypto.subtle) {
  return `w:${hex((await digest(normalizeQuery(q), subtle)).slice(0, 5))}`;
}

/** The exact value the phone PUTs: version 2 with the work rules when the profile has a
 * work_watch list (even an empty one, so removing the last rule clears the server's),
 * else version 1. */
export async function watchPayload(profile, subtle = globalThis.crypto.subtle) {
  const queries = [];
  for (const q of watchQueryStrings(profile)) queries.push({ q, tag: await watchTag(q, subtle) });
  if (!Array.isArray(profile?.work_watch)) return { v: 1, queries };
  const work = workPayloadRules(profile);
  for (const rule of work) rule.tag = await watchTag(`work:${rule.id}`, subtle);
  return { v: 2, queries, work };
}

/** B11: the server's stored work rules (as profile rules), or null when there are none
 * or the read failed. */
export async function serverWorkRules(fetchImpl) {
  try {
    const response = await fetchImpl(ENDPOINT, { method: "GET", credentials: "same-origin", redirect: "manual", cache: "no-store" });
    if (!response || !response.ok) return null;
    const value = await response.json();
    return value && value.v === 2 && Array.isArray(value.work) && value.work.length ? rulesFromPayload(value.work) : null;
  } catch {
    return null;
  }
}

function storedProfile(storage) {
  try {
    const history = JSON.parse(storage.getItem(STORAGE_KEY) || "null")?.history;
    return Array.isArray(history) && history.length ? history[history.length - 1].profile : null;
  } catch {
    return null;
  }
}

/**
 * One sync check, for the stored profile (or the default one, whose two standing
 * stories are on, when nothing is stored yet). Returns "same" (already sent),
 * "offline", "failed" (a network error, a non-2xx answer or an Access login redirect,
 * kept for a later try) or "sent".
 */
export async function syncInterests({ storage, fetchImpl, now = Date.now, online = true, subtle = globalThis.crypto.subtle, adopt = null }) {
  let profile = storedProfile(storage) || buildDefaultProfile();
  if (adopt && online && !Array.isArray(profile.work_watch)) {
    const rules = await serverWorkRules(fetchImpl);
    const adopted = rules ? await adopt(rules) : null;
    if (adopted) profile = adopted;
  }
  const body = JSON.stringify(await watchPayload(profile, subtle));
  const sum = hex(await digest(body, subtle));
  let state = {};
  try { state = JSON.parse(storage.getItem(SYNC_KEY) || "{}") || {}; } catch { state = {}; }
  if (state.sum === sum && now() - (Number(state.at) || 0) < REFRESH_MS) return "same";
  if (!online) return "offline";
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "PUT", body, credentials: "same-origin", redirect: "manual", cache: "no-store",
      headers: { "content-type": "application/json" },
    });
  } catch {
    return "failed";
  }
  if (!response || !response.ok) return "failed";
  try { storage.setItem(SYNC_KEY, JSON.stringify({ sum, at: now() })); } catch { /* sent anyway */ }
  return "sent";
}

// --- The browser's scheduler: debounced, one at a time, retried with a backoff. ---

let timer = 0;
let running = false;
let again = false;
let failures = 0;
let started = false;
let adoptFn = null;

async function run() {
  if (running) { again = true; return; }
  running = true;
  let result = "failed";
  try {
    result = await syncInterests({ storage: window.localStorage, fetchImpl: (...a) => fetch(...a), online: navigator.onLine !== false, adopt: adoptFn });
  } catch {
    result = "failed";
  } finally {
    running = false;
  }
  if (again) { again = false; scheduleSync(0); return; }
  if (result === "failed") scheduleSync(RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
  else if (result !== "offline") failures = 0;
}

/** Checks (and sends if needed) after `delay` ms; a later call restarts the wait. */
export function scheduleSync(delay = DEBOUNCE_MS) {
  if (typeof window === "undefined") return;
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

/** Once per page: a check shortly after load, and again whenever the phone comes back
 * online or the app comes back to the front. B11: `adopt(rules)` saves server-held work
 * rules into a profile that has none and returns the saved profile (or null). */
export function startSync(delay = 3000, { adopt = null } = {}) {
  if (adopt) adoptFn = adopt;
  if (typeof window === "undefined" || started) return;
  started = true;
  addEventListener("online", () => scheduleSync(0));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleSync(); });
  scheduleSync(delay);
}
