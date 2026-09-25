// W1 (R50): the /api/interests Pages Function (functions/api/interests.js), with a
// mocked KV and a mocked Access team: a real RS256 key made here signs the JWTs, and its
// public half is the "team certs". Good JWT (GET empty, PUT, GET back, keyed by the
// hashed email), bad JWT (another key, wrong audience, issuer, expiry, a mismatched
// email header), no JWT, and the PUT limits (size, count, length, tag, shape, type).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { handle, onRequest, validatePayload, userKey, watchTag, MAX_BODY_BYTES } from "../../functions/api/interests.js";
import { watchTagSync } from "../../app/static/js/phrase.js";

const TEAM = "team.example.cloudflareaccess.com";
const AUD = "aud-for-tests";
const ORIGIN = "https://almanac.example";
const EMAIL = "Reader@Example.com";
const NOW_MS = Date.parse("2026-09-24T12:00:00Z");
const ENV_BASE = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const enc = (obj) => b64url(Buffer.from(JSON.stringify(obj)));

async function keyPair(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e } };
}

const signer = await keyPair("k1");
const stranger = await keyPair("k1"); // same kid, another key: a forged token

async function jwt(claims = {}, key = signer, header = {}) {
  const now = NOW_MS / 1000;
  const head = enc({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const body = enc({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, iat: now, nbf: now, exp: now + 3600, sub: "u1", ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

function memoryKv() {
  const map = new Map();
  return { map, get: async (k) => (map.has(k) ? map.get(k) : null), put: async (k, v) => { map.set(k, v); } };
}

const deps = (keys = [signer.jwk]) => ({ now: () => NOW_MS, getKeys: async () => keys });

function request(method, { token, email = EMAIL, body, headers = {} } = {}) {
  const h = new Headers(headers);
  if (token) h.set("cf-access-jwt-assertion", token);
  if (email) h.set("cf-access-authenticated-user-email", email);
  if (body !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
  return new Request(`${ORIGIN}/api/interests`, { method, headers: h, body });
}

const payload = (qs) => ({ v: 1, queries: qs.map((q) => ({ q, tag: watchTagSync(q) })) });

test("good JWT: GET is empty at first, PUT stores under the hashed email, GET returns it", async () => {
  const env = { ...ENV_BASE, INTERESTS: memoryKv() };
  const token = await jwt();
  const first = await handle(request("GET", { token }), env, deps());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.deepEqual(await first.json(), { v: 1, queries: [] });

  const value = payload(["\"sodium battery\"", "\"gaza\" OR \"israel\""]);
  const put = await handle(request("PUT", { token, body: JSON.stringify(value), headers: { origin: ORIGIN } }), env, deps());
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { ok: true, count: 2 });
  const key = createHash("sha256").update(EMAIL.toLowerCase()).digest("hex");
  assert.equal(await userKey(EMAIL), key);
  assert.deepEqual([...env.INTERESTS.map.keys()], [key], "one key, the SHA-256 hex of the lowercased email");
  assert.equal(env.INTERESTS.map.get(key), JSON.stringify(value));

  const back = await handle(request("GET", { token }), env, deps());
  assert.deepEqual(await back.json(), value);
  const other = await handle(request("GET", { token: await jwt({ email: "other@example.com" }), email: "other@example.com" }), env, deps());
  assert.deepEqual(await other.json(), { v: 1, queries: [] }, "another reader sees only their own value");
});

test("no JWT is refused with 401, a bad one with 403, before storage is touched", async () => {
  const env = { ...ENV_BASE, INTERESTS: memoryKv() };
  const body = JSON.stringify(payload(["\"sodium battery\""]));
  assert.equal((await handle(request("PUT", { body }), env, deps())).status, 401);
  assert.equal((await handle(request("GET", {}), env, deps())).status, 401);
  const bad = {
    forged: await jwt({}, stranger),
    audience: await jwt({ aud: ["someone-else"] }),
    issuer: await jwt({ iss: "https://evil.cloudflareaccess.com" }),
    expired: await jwt({ exp: NOW_MS / 1000 - 3600 }),
    early: await jwt({ nbf: NOW_MS / 1000 + 3600 }),
    no_email: await jwt({ email: undefined }),
    alg_none: `${enc({ alg: "none", kid: "k1" })}.${enc({ iss: `https://${TEAM}`, aud: AUD, email: EMAIL, exp: NOW_MS / 1000 + 60 })}.`,
    hs256: await jwt({}, signer, { alg: "HS256" }),
    garbage: "not.a.jwt",
    unknown_kid: await jwt({}, { ...signer, kid: "k9" }),
  };
  for (const [name, token] of Object.entries(bad)) {
    const res = await handle(request("PUT", { token, body }), env, deps());
    assert.equal(res.status, 403, name);
  }
  const mismatched = await handle(request("PUT", { token: await jwt(), email: "someone@else.com", body }), env, deps());
  assert.equal(mismatched.status, 403, "the email header must be the verified token's own");
  assert.equal(env.INTERESTS.map.size, 0);
});

test("the team's keys: an unknown key id refetches once, so a rotated key still verifies", async () => {
  const env = { ...ENV_BASE, INTERESTS: memoryKv() };
  const calls = [];
  const rotating = { now: () => NOW_MS, getKeys: async (force) => { calls.push(force); return force ? [signer.jwk] : []; } };
  const res = await handle(request("GET", { token: await jwt() }), env, rotating);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [false, true]);
});

test("the certs come from the team's own /cdn-cgi/access/certs by default", async () => {
  const env = { ...ENV_BASE, INTERESTS: memoryKv() };
  const urls = [];
  const fetchCerts = async (url) => { urls.push(url); return new Response(JSON.stringify({ keys: [signer.jwk] })); };
  const res = await handle(request("GET", { token: await jwt() }), env, { now: () => NOW_MS, fetch: fetchCerts });
  assert.equal(res.status, 200);
  assert.deepEqual(urls, [`https://${TEAM}/cdn-cgi/access/certs`]);
});

test("PUT limits: size, count, length, tag, shape, type, origin; nothing bad is stored", async () => {
  const env = { ...ENV_BASE, INTERESTS: memoryKv() };
  const token = await jwt();
  const put = (body, headers = {}) => handle(request("PUT", { token, body, headers }), env, deps());
  const tooBig = JSON.stringify({ v: 1, queries: [], pad: "x".repeat(MAX_BODY_BYTES) });
  assert.equal((await put(tooBig)).status, 413);
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(tooBig)); c.close(); } });
  const chunked = new Request(`${ORIGIN}/api/interests`, { method: "PUT", body: stream, duplex: "half",
    headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" } });
  assert.equal((await handle(chunked, env, deps())).status, 413, "a body with no length is cut off at the limit too");
  const many = payload(Array.from({ length: 26 }, (_, i) => `"phrase ${i}"`));
  assert.equal((await put(JSON.stringify(many))).status, 400);
  assert.equal((await put(JSON.stringify(payload(Array.from({ length: 25 }, (_, i) => `"phrase ${i}"`))))).status, 200, "25 is fine");
  assert.equal((await put(JSON.stringify(payload([`"${"x".repeat(99)}"`])))).status, 400, "a q of 101 characters");
  assert.equal((await put(JSON.stringify(payload([`"${"x".repeat(98)}"`])))).status, 200, "a q of 100 characters");
  const wrongTag = { v: 1, queries: [{ q: "\"a phrase\"", tag: "w:0000000000" }] };
  assert.equal((await put(JSON.stringify(wrongTag))).status, 400);
  const twice = payload(["\"a phrase\"", "\"A  phrase\""]);
  assert.equal((await put(JSON.stringify(twice))).status, 400, "the same query twice");
  for (const shape of [[], { v: 2, queries: [] }, { v: 1 }, { v: 1, queries: [], extra: 1 }, { v: 1, queries: [{ q: "\"a\"" }] },
    { v: 1, queries: [{ q: "\"a\"", tag: watchTagSync("\"a\""), more: 1 }] }, { v: 1, queries: [{ q: "\u0007", tag: watchTagSync("\u0007") }] },
    { v: 1, queries: [{ q: "   ", tag: watchTagSync("   ") }] }]) {
    assert.equal((await put(JSON.stringify(shape))).status, 400, JSON.stringify(shape));
  }
  assert.equal((await put("{not json")).status, 400);
  assert.equal((await put(JSON.stringify(payload([])), { "content-type": "text/plain" })).status, 415);
  assert.equal((await put(JSON.stringify(payload([])), { origin: "https://evil.example" })).status, 403);
  const stored = [...env.INTERESTS.map.values()].map((v) => JSON.parse(v).queries.length);
  assert.deepEqual(stored, [1], "only the good PUTs were stored, the last one kept");
});

test("other methods are 405, and a missing KV binding is 503, never a crash", async () => {
  const token = await jwt();
  const res = await handle(request("POST", { token, body: "{}" }), { ...ENV_BASE, INTERESTS: memoryKv() }, deps());
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, PUT");
  assert.equal((await handle(request("GET", { token }), ENV_BASE, deps())).status, 503);
});

test("onRequest is the Pages entry, and an answer never repeats a query back", async () => {
  const res = await onRequest({ request: request("GET", {}), env: {} });
  assert.equal(res.status, 401);
  const checked = await validatePayload({ v: 1, queries: [{ q: "\"secret phrase\"", tag: "w:0000000000" }] });
  assert.ok(!checked.ok && !checked.error.includes("secret"));
  assert.equal(await watchTag("\"heat pump\""), "w:d8e4ee5a1b", "the same fixed vector as the phone");
});
