// W1 (R50): phrase interests, the owner's free-text interests ("i would want the free
// text interest to match things that aren't already on my phone, so maybe a mix of 1
// and 2"). Pure helpers shared by the ranker (at build time under Node and on the
// device), the You page and the interests sync. No DOM, no storage, no clock.
//
// Matching on the phone (option 1): a phrase matches a text when the text holds the
// phrase's words in order and next to each other, as whole words, any case, accents
// ignored, a plural folded ("heat pumps" holds "heat pump", "batteries" holds
// "battery"), a possessive "'s" dropped, and any run of spaces or punctuation between
// two words ("heat-pump" holds "heat pump").
//
// The hourly search (option 2, W2's fetcher): the phone sends each query `q` with a tag,
// "w:" plus the first 10 hex digits of SHA-256 over q normalized (trimmed, lowercased,
// spaces collapsed). The fetcher tags every item a query found with that tag, never the
// phrase, so the pool never names anyone's phrases. interests-sync.js computes the tags
// it sends with Web Crypto; the ranker is synchronous and also runs under Node at build
// time, so it uses sha256Hex below, the same digest (tests/js/phrase.test.js checks
// both against a fixed vector and against Node's own hash).

/** The longest phrase the You page takes: its query, the phrase in quotes, stays well
 * under QUERY_MAX, and it still fits one row of the interests list. */
export const PHRASE_MAX = 60;
/** The contract with the Pages Function and the fetcher (W2): at most QUERIES_MAX
 * queries, each at most QUERY_MAX characters. */
export const QUERY_MAX = 100;
export const QUERIES_MAX = 25;

const WORD = /[\p{L}\p{N}]+/gu;
const POSSESSIVE = /['’]s(?![\p{L}\p{N}])/gu;
const APOSTROPHE = /['’]/g;

/** One lowercased word with a plural folded: "pumps" and "pump" read the same, and so
 * do "batteries" and "battery" (a final "ie" left after the "s" reads as "y", on both
 * sides, so "movies" and "movie" still agree), while "gas", "glass" and "bus" are left
 * alone. */
export function foldWord(word) {
  const one = word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
  return one.length > 3 && one.endsWith("ie") ? `${one.slice(0, -2)}y` : one;
}

/** A text as folded words: accents stripped, lowercased, "'s" dropped, apostrophes
 * joined ("don't" is one word), every other non-letter, non-digit run a boundary. */
export function textWords(text) {
  const plain = String(text ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
    .replace(POSSESSIVE, "").replace(APOSTROPHE, "");
  return (plain.match(WORD) || []).map(foldWord);
}

/** Whether `hay` (folded words) holds `needle` (folded words) in order, adjacent. */
export function containsWords(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** A phrase as the owner typed it, cleaned for keeping: double quotes (straight or
 * curly) dropped, since the query wraps the phrase in them, and spaces collapsed. Case
 * is kept for display; matching folds it. Empty when nothing matchable is left. */
export function normalizePhrase(text) {
  const clean = String(text ?? "").replace(/["“”]/g, " ").trim().replace(/\s+/g, " ");
  return textWords(clean).length ? clean : "";
}

/** A topic setting that is a phrase interest (W1), not a pool tag bucket. */
export function isPhraseTopic(setting) {
  return !!setting && typeof setting.phrase === "string" && setting.phrase.trim() !== "";
}

/** The Google News query for a phrase interest: the phrase in quotes. */
export function phraseQuery(phrase) {
  const clean = normalizePhrase(phrase);
  return clean ? `"${clean}"` : "";
}

/** The Google News query for a standing story: its keywords as "a" OR "b" OR "c", in
 * the owner's order, repeats dropped, as many as fit in QUERY_MAX characters. */
export function storyQuery(keywords) {
  const seen = new Set();
  let q = "";
  for (const keyword of keywords || []) {
    const clean = normalizePhrase(keyword);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    const next = q ? `${q} OR "${clean}"` : `"${clean}"`;
    if (next.length > QUERY_MAX) break;
    seen.add(key);
    q = next;
  }
  return q;
}

/** A query as the tag hashes it: trimmed, lowercased, spaces collapsed. */
export function normalizeQuery(q) {
  return String(q ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// --- SHA-256 (FIPS 180-4), synchronous, over the UTF-8 bytes of a string. ---
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** SHA-256 of a string's UTF-8 bytes, as 64 lowercase hex digits. */
export function sha256Hex(message) {
  const bytes = new TextEncoder().encode(String(message));
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = bytes.length * 8;
  view.setUint32(total - 8, Math.floor(bits / 0x100000000));
  view.setUint32(total - 4, bits >>> 0);
  const h = new Uint32Array(H0);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** The watch tag for a query: "w:" and the first 10 hex digits of its SHA-256. */
export function watchTagSync(q) {
  return `w:${sha256Hex(normalizeQuery(q)).slice(0, 10)}`;
}

// A phrase's folded words and its tag, computed once per phrase (the ranker asks for
// every story). Pure in the phrase alone, so a module-level cache is safe.
const matchers = new Map();

/** {words, tag} for a phrase interest's phrase. */
export function phraseMatcher(phrase) {
  let m = matchers.get(phrase);
  if (!m) {
    m = { words: textWords(normalizePhrase(phrase)), tag: watchTagSync(phraseQuery(phrase)) };
    if (matchers.size > 500) matchers.clear();
    matchers.set(phrase, m);
  }
  return m;
}

/** Whether texts (each a list of folded words, one per headline or dek, so a match
 * never runs from one text into the next) or watch tags hold a phrase's matcher. */
export function matchesPhrase(texts, watch, matcher) {
  if (watch && watch.includes(matcher.tag)) return true;
  return texts.some((words) => containsWords(words, matcher.words));
}
