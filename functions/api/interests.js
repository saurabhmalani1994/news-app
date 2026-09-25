// W1 (R50): /api/interests, a Cloudflare Pages Function deployed with the static site
// (publish.yml's `wrangler pages deploy` picks up this functions/ directory). It holds
// each reader's search list for W2's hourly run: the phone PUTs
//   {"v":1,"queries":[{"q":"\"heat pump\"","tag":"w:0123456789"}]}
// (app/static/js/interests-sync.js), and GET returns the caller's own value. Stored in
// Workers KV (namespace "almanac-interests", bound as INTERESTS) under the SHA-256 hex
// of the caller's lowercased Access email, so no key names anyone.
//
// The whole site sits behind Cloudflare Access, which answers a request without its
// login cookie with a 302 and adds a signed JWT (Cf-Access-Jwt-Assertion) to every
// request it lets through. This function trusts neither alone: it verifies that JWT's
// RS256 signature against the Access team's own certs, its issuer, audience and time,
// and refuses (401 with no JWT, 403 with a bad one) before touching storage. The email
// comes from Cf-Access-Authenticated-User-Email and must equal the verified token's own
// (the token's alone when Access sends no such header).
//
// A PUT is checked in full before it is stored: at most 8 KB, JSON, exactly v 1 and a
// queries list of at most 25 {q, tag}, each q 1 to 100 characters with no control
// characters, each tag "w:" and 10 hex digits that must equal SHA-256(q normalized), no
// tag twice. Nothing here logs, and no answer repeats a query back.

// The Access application in front of this site. Neither value is a secret: Access puts
// both in every login redirect it sends (the team host, and the audience as `kid`).
// ACCESS_TEAM_DOMAIN and ACCESS_AUD environment variables override them.
export const ACCESS_TEAM_DOMAIN = "almanac-dt5-pages.cloudflareaccess.com";
export const ACCESS_AUD = "3940188317cc7fb06aea6cae0af45c5b12ca215ab0f2224104c5fcf6061bda79";

export const MAX_BODY_BYTES = 8192;
export const MAX_QUERIES = 25;
export const MAX_Q = 100;
const TAG = /^w:[0-9a-f]{10}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const EMPTY = JSON.stringify({ v: 1, queries: [] });
const SKEW_S = 60;
const KEYS_TTL_MS = 3_600_000;

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function reply(status, body, extra = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** The watch tag the phone and the fetcher use: "w:" and 10 hex of SHA-256(q normalized). */
export async function watchTag(q) {
  const normalized = String(q).trim().toLowerCase().replace(/\s+/g, " ");
  return `w:${hex((await sha256(normalized)).slice(0, 5))}`;
}

/** The KV key for an Access email: SHA-256 hex of it, trimmed and lowercased. */
export async function userKey(email) {
  return hex(await sha256(String(email).trim().toLowerCase()));
}

function base64url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const decodeJson = (part) => JSON.parse(new TextDecoder().decode(base64url(part)));

// The team's signing keys, kept for an hour per isolate; an unknown key id refetches
// once, since Access rotates its keys.
let certs = { url: "", at: 0, keys: null };

async function teamKeys(teamDomain, fetchImpl, nowMs, force) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (!force && certs.keys && certs.url === url && nowMs - certs.at < KEYS_TTL_MS) return certs.keys;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`certs ${response.status}`);
  const data = await response.json();
  certs = { url, at: nowMs, keys: Array.isArray(data?.keys) ? data.keys : [] };
  return certs.keys;
}

/**
 * The verified claims of an Access JWT, or null. `getKeys(force)` returns the team's
 * JWKS keys (force: refetch). Checks the RS256 signature, the issuer (the team), the
 * audience (this Access application), expiry and not-before (60 s skew), and an email.
 */
export async function verifyAccessJwt(token, { teamDomain, aud, getKeys, nowMs }) {
  const parts = String(token).split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  let header;
  let claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return null;
  }
  if (header?.alg !== "RS256" || typeof header.kid !== "string" || !claims || typeof claims !== "object") return null;
  let jwk = (await getKeys(false)).find((k) => k?.kid === header.kid);
  if (!jwk) jwk = (await getKeys(true)).find((k) => k?.kid === header.kid);
  if (!jwk || jwk.kty !== "RSA") return null;
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(parts[2]), signed))) return null;
  const now = nowMs / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://${teamDomain}` || !audiences.includes(aud)) return null;
  if (typeof claims.exp !== "number" || now > claims.exp + SKEW_S) return null;
  if (typeof claims.nbf === "number" && now + SKEW_S < claims.nbf) return null;
  if (typeof claims.email !== "string" || !claims.email.includes("@")) return null;
  return claims;
}

/** A request body as text, or null once it passes `limit` bytes. */
async function readLimited(request, limit) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** {ok: true, value} with exactly the stored shape, or {ok: false, error}. */
export async function validatePayload(data) {
  if (!isObject(data) || !onlyKeys(data, ["v", "queries"]) || data.v !== 1) return { ok: false, error: "expected {v: 1, queries}" };
  if (!Array.isArray(data.queries)) return { ok: false, error: "queries must be a list" };
  if (data.queries.length > MAX_QUERIES) return { ok: false, error: `at most ${MAX_QUERIES} queries` };
  const tags = new Set();
  const queries = [];
  for (const item of data.queries) {
    if (!isObject(item) || !onlyKeys(item, ["q", "tag"])) return { ok: false, error: "each query is exactly {q, tag}" };
    const { q, tag } = item;
    if (typeof q !== "string" || !q.trim() || q.length > MAX_Q || CONTROL.test(q)) {
      return { ok: false, error: `each q is 1 to ${MAX_Q} characters of text` };
    }
    if (typeof tag !== "string" || !TAG.test(tag) || tag !== (await watchTag(q))) return { ok: false, error: "a tag does not match its query" };
    if (tags.has(tag)) return { ok: false, error: "a query appears twice" };
    tags.add(tag);
    queries.push({ q, tag });
  }
  return { ok: true, value: { v: 1, queries } };
}

/**
 * The function itself, with its outside world passed in so tests can drive it:
 * env.INTERESTS (KV), env.ACCESS_TEAM_DOMAIN and env.ACCESS_AUD (optional overrides);
 * deps.getKeys(force) (the team's JWKS keys), deps.fetch (for the certs), deps.now.
 */
export async function handle(request, env = {}, deps = {}) {
  const method = request.method;
  if (method !== "GET" && method !== "PUT") return reply(405, { error: "GET or PUT only" }, { allow: "GET, PUT" });
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return reply(401, { error: "no Access token" });
  const nowMs = (deps.now || Date.now)();
  const teamDomain = env.ACCESS_TEAM_DOMAIN || ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD || ACCESS_AUD;
  const getKeys = deps.getKeys || ((force) => teamKeys(teamDomain, deps.fetch || fetch, nowMs, force));
  let claims = null;
  try {
    claims = await verifyAccessJwt(token, { teamDomain, aud, getKeys, nowMs });
  } catch {
    claims = null;
  }
  if (!claims) return reply(403, { error: "Access token refused" });
  const verified = claims.email.trim().toLowerCase();
  const email = String(request.headers.get("cf-access-authenticated-user-email") || verified).trim().toLowerCase();
  if (email !== verified) return reply(403, { error: "Access identity refused" });
  const kv = env.INTERESTS;
  if (!kv) return reply(503, { error: "storage is not bound yet" });
  const key = await userKey(email);

  if (method === "GET") return reply(200, (await kv.get(key)) || EMPTY);

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return reply(403, { error: "same origin only" });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) return reply(415, { error: "JSON only" });
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return reply(413, { error: `at most ${MAX_BODY_BYTES} bytes` });
  const text = await readLimited(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, { error: `at most ${MAX_BODY_BYTES} bytes` });
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return reply(400, { error: "not JSON" });
  }
  const checked = await validatePayload(data);
  if (!checked.ok) return reply(400, { error: checked.error });
  await kv.put(key, JSON.stringify(checked.value));
  return reply(200, { ok: true, count: checked.value.queries.length });
}

/** Pages Functions entry: every method on /api/interests. */
export function onRequest(context) {
  return handle(context.request, context.env);
}
