// S25: the reader's decisions, free of the DOM so Node can test them. Which tap opens
// the in-app reader and which links out, how a body file is loaded (cache first, then
// the network, then a calm note), what a body record must look like before any of it
// is used, and the small text rules the page applies around it.
//
// A body file is bodies/<article_id>.json (S22, contract/body.schema.json), fetched from
// the app's own origin only (connect-src 'self'), lazily, when its story is opened
// (R12). Its body_html is raw feed HTML: nothing here reads it as markup. The view hands
// it to S37's sanitizeBody, which returns a DocumentFragment (R26).

/** The article id shape the contract allows; anything else never reaches a URL. */
export const BODY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WEB_URL = /^https?:\/\/[^\s]+$/i;
export const FETCH_TIMEOUT_MS = 15000;

/**
 * The article id a tap on `link` opens in the reader, or null to follow the link out to
 * the source as before. Only a story link the build marked data-body (its lead article
 * has a body file) opens the reader, and only for a plain primary click: a middle click
 * or a modified click keeps the browser's own new-tab behaviour.
 */
export function readerChoice(link, event = {}) {
  if (!link || event.defaultPrevented) return null;
  if ((event.button ?? 0) !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;
  const id = typeof link.getAttribute === "function" ? link.getAttribute("data-body") : link.dataset?.body;
  return typeof id === "string" && BODY_ID.test(id) ? id : null;
}

/** The body file's path, relative to the page (same origin). */
export function bodyPath(id) {
  if (!BODY_ID.test(id)) throw new Error("not an article id");
  return `bodies/${id}.json`;
}

/**
 * A body record checked against the contract's shape, reduced to the fields the reader
 * uses, or null. A record for another article, an empty body or a missing source name
 * is not a body. The link out keeps only an http(s) url.
 */
export function checkBody(record, id) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.schema_version !== 1 || record.article_id !== id) return null;
  if (typeof record.body_html !== "string" || record.body_html.trim() === "") return null;
  const name = typeof record.source_name === "string" ? record.source_name.trim() : "";
  if (!name) return null;
  return {
    schema_version: 1,
    article_id: id,
    source_id: typeof record.source_id === "string" ? record.source_id : "",
    source_name: name,
    url: typeof record.url === "string" && WEB_URL.test(record.url) ? record.url : "",
    body_html: record.body_html,
  };
}

const isOnline = () => globalThis.navigator?.onLine !== false;

/**
 * Loads article `id`'s body: the device cache first (IndexedDB in the page, anything
 * with get and put in tests), then the network, caching what it fetched. Never throws.
 * Resolves to {state: "ready", body, from: "cache" | "network"} or {state} with state
 * one of "offline" (no copy on the phone and no network), "missing" (no body file for
 * this story, 404) or "error" (anything else: a server error, a timeout, a bad file).
 */
export async function loadBody(id, { fetchFn = globalThis.fetch, cache = null, online = isOnline, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (typeof id !== "string" || !BODY_ID.test(id)) return { state: "missing" };
  if (cache) {
    try {
      const hit = checkBody(await cache.get(id), id);
      if (hit) return { state: "ready", body: hit, from: "cache" };
    } catch {
      // an unreadable cache is a miss, never a failure
    }
  }
  if (!online()) return { state: "offline" };
  let response;
  try {
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    response = await fetchFn(bodyPath(id), { credentials: "same-origin", signal });
  } catch {
    return { state: online() ? "error" : "offline" };
  }
  if (response.status === 404 || response.status === 410) return { state: "missing" };
  if (!response.ok) return { state: "error" };
  let data;
  try {
    data = await response.json();
  } catch {
    return { state: "error" };
  }
  const body = checkBody(data, id);
  if (!body) return { state: "error" };
  if (cache) {
    try {
      await cache.put(id, body);
    } catch {
      // storage full or blocked: the story still reads, it just is not kept
    }
  }
  return { state: "ready", body, from: "network" };
}

/** What the reader says when there is no body to show, in the app's calm voice. */
export const NOTES = Object.freeze({
  offline: Object.freeze({
    head: "You are offline",
    text: "This story is not saved on this phone yet. It will open here when you are back online.",
    retry: true,
  }),
  missing: Object.freeze({
    head: "The full text is not here anymore",
    text: "This story has left the latest edition. It is still at the source.",
    retry: false,
  }),
  error: Object.freeze({
    head: "This story did not load",
    text: "Try again in a moment, or read it at the source.",
    retry: true,
  }),
});

const MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

/** A publish time the way a newspaper sets it, in the phone's own time zone:
 * "Sept. 24, 2026, 3:50 a.m.". Empty for anything that is not a time. */
export function formatPublished(iso, { timeZone } = {}) {
  const when = new Date(typeof iso === "string" ? iso : NaN);
  if (Number.isNaN(when.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(when).map((p) => [p.type, p.value]));
  const period = String(parts.dayPeriod || "").toLowerCase().startsWith("p") ? "p.m." : "a.m.";
  return `${MONTHS[Number(parts.month) - 1]} ${parts.day}, ${parts.year}, ${parts.hour}:${parts.minute} ${period}`;
}

const fold = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** True when two strings say the same words, ignoring case, quotes and punctuation:
 * a dek that is the body's own first paragraph (many feeds send it as the
 * description), so the reader shows it once. */
export function sameText(a, b) {
  const x = fold(a);
  return x !== "" && x === fold(b);
}

/** The WordPress feed trailer ("The post X appeared first on Y.") that is not part of
 * the story. */
export const TRAILER = /^\s*the post\b[\s\S]*\bappeared first on\b/i;

/** Images too small to be a photo: tracking pixels and icons (stated sides only). */
export const MIN_BODY_IMAGE_PX = 60;
export function tinyImage(width, height) {
  const w = Number(width);
  const h = Number(height);
  return (w > 0 && w < MIN_BODY_IMAGE_PX) || (h > 0 && h < MIN_BODY_IMAGE_PX);
}

/** A photo's identity across the sizes a CMS serves it at: host plus the file name
 * without its extension and a trailing "-800x450" size, so the body's own copy of the
 * hero photo is recognised. Empty for anything that is not a URL. */
export function imageStem(src) {
  let url;
  try {
    url = new URL(src);
  } catch {
    return "";
  }
  let name = url.pathname.split("/").pop() || "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // a malformed escape: compare the raw name
  }
  name = name.toLowerCase();
  const stem = name.replace(/\.[a-z0-9]{2,5}$/, "").replace(/-\d{2,5}x\d{2,5}$/, "");
  return stem ? `${url.hostname.replace(/^www\./, "")}/${stem}` : "";
}

/** WordPress swaps emoji for small images; the reader keeps the character instead. */
export const EMOJI_IMAGE = /\/images\/core\/emoji\//;

// Typographic quotes for body text, the rule app/typography.py applies to headlines:
// a quote at the start or after a space, bracket or dash opens; anywhere else it
// closes; '90s keeps its apostrophe. `prev` is the character before `text` (the end of
// the previous text node in the same paragraph), so a quote split across tags still
// turns the right way. Only the two straight quote characters ever change.
const OPENS_AFTER = new Set([..." \t\n\r([{<-/\u2013\u2014\u00a0\u2018\u201c"]);

export function smartQuotes(text, prev = "") {
  let out = "";
  let last = prev;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const opens = last === "" || OPENS_AFTER.has(last);
    let next = ch;
    if (ch === "'") {
      if (!opens) next = "\u2019";
      else if (/^\d\d(?!\d)/.test(text.slice(i + 1, i + 4))) next = "\u2019";
      else next = "\u2018";
    } else if (ch === '"') {
      next = opens ? "\u201c" : "\u201d";
    }
    out += next;
    last = next;
  }
  return out;
}

/**
 * U1: which member of a story the reader opens when any outlet in its cluster has full
 * text. `candidates` is the build's list for the story ([article_id, source_id,
 * body_chars, url], app/build.py body_candidates); the lead wins when it has a body,
 * else the member from the outlet the owner trusts most (`trust`, the profile's own
 * map, 1.0 when unset), else the longest body, then the lowest id. The same rule as
 * app/build.py best_member, so the build's pick and the device's agree for the default
 * profile. Returns an article id, or null.
 */
export function bestMember(candidates, leadId, trust = {}) {
  const valid = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => Array.isArray(c) && typeof c[0] === "string" && BODY_ID.test(c[0]));
  if (!valid.length) return null;
  if (valid.some((c) => c[0] === leadId)) return leadId;
  const weight = (c) => {
    const t = trust && typeof trust === "object" ? trust[c[1]] : undefined;
    return typeof t === "number" && Number.isFinite(t) ? t : 1;
  };
  const chars = (c) => (Number.isFinite(c[2]) ? c[2] : 0);
  return valid.reduce((best, c) => {
    const d = weight(c) - weight(best) || chars(c) - chars(best) || (c[0] < best[0] ? 1 : -1);
    return d > 0 ? c : best;
  })[0];
}

/**
 * R43: the one choice a "Read here" row names and the reader opens, so the two always
 * agree: bestMember over the story's candidates with the profile's trust, returned with
 * that member's source id ({id, source_id}, or null). The build makes it for the
 * default profile (app/build.py best_member, the row's data-body and "Read here ·
 * <outlet>"), rerank.js remakes it before first paint for a stored profile's trust, and
 * the reader opens the row's data-body as is. `tried` (a Set of ids) leaves out members
 * whose body file turned out missing, for the reader's fallback to the next one.
 */
export function readChoice(candidates, leadId, trust = {}, tried = null) {
  const left = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => Array.isArray(c) && !(tried && tried.has(c[0])));
  const id = bestMember(left, leadId, trust);
  if (!id) return null;
  const member = left.find((c) => c[0] === id);
  return { id, source_id: typeof member[1] === "string" ? member[1] : "" };
}

/**
 * U1: the quiet credit line the reader shows when the text it opened comes from an
 * outlet other than the one the card named ("Full text from Axios"), else "".
 */
export function creditLine(memberSource, cardSource, sourceName) {
  if (!memberSource || !cardSource || memberSource === cardSource) return "";
  return sourceName ? `Full text from ${sourceName}` : "";
}
