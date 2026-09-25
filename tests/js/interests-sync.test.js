// W1 (R50): the phone side of the search sync. Which queries a profile makes (phrases
// that are on, then standing stories that are on, capped at 25 and 100 characters), the
// exact value PUT to /api/interests, and when a check sends: a changed value, a day-old
// one, never an unchanged one, and a failed or offline try is kept for later.
import { test } from "node:test";
import assert from "node:assert/strict";

import { watchQueryStrings, watchPayload, syncInterests, ENDPOINT, SYNC_KEY, REFRESH_MS } from "../../app/static/js/interests-sync.js";
import { watchTagSync } from "../../app/static/js/phrase.js";
import { MemoryStorage, STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const NOW = "2026-09-24T12:00:00Z";
const phrase = (text, enabled = true) => ({ label: text, phrase: text, affinity: 0.6, half_life_hours: 24, enabled });

function profileWith(edit) {
  const p = buildDefaultProfile(NOW);
  edit(p);
  return p;
}

function storeProfile(storage, profile) {
  storage.setItem(STORAGE_KEY, JSON.stringify({ history: [{ version: 1, timestamp: NOW, profile }] }));
}

test("queries: phrases that are on first, then standing stories that are on, as OR of their keywords", () => {
  const p = profileWith((x) => {
    x.topics.p_sodium_battery = phrase("sodium battery");
    x.topics.p_grid_storage = phrase("grid storage", false);
    x.standing_stories[1].enabled = false;
  });
  const qs = watchQueryStrings(p);
  assert.equal(qs[0], "\"sodium battery\"");
  assert.equal(qs.length, 2, "the phrase that is off and the story that is off are not searched");
  assert.ok(qs[1].startsWith("\"gaza\" OR \"israel\" OR "), qs[1]);
  assert.ok(qs.every((q) => q.length <= 100));
});

test("queries: at most 25, repeats dropped, and an absent standing_stories means the two defaults", () => {
  const p = profileWith((x) => {
    for (let i = 0; i < 30; i++) x.topics[`p_t${i}`] = phrase(`test phrase ${i}`);
    x.topics.p_dup = phrase("Test   Phrase 0");
  });
  const qs = watchQueryStrings(p);
  assert.equal(qs.length, 25);
  assert.equal(new Set(qs.map((q) => q.toLowerCase().replace(/\s+/g, " "))).size, 25);
  const bare = buildDefaultProfile(NOW);
  delete bare.standing_stories;
  assert.equal(watchQueryStrings(bare).length, 2);
});

test("payload: exactly {v: 1, queries: [{q, tag}]}, each tag the query's own", async () => {
  const p = profileWith((x) => { x.topics.p_sodium_battery = phrase("sodium battery"); });
  const payload = await watchPayload(p);
  assert.deepEqual(Object.keys(payload), ["v", "queries"]);
  assert.equal(payload.v, 1);
  for (const item of payload.queries) {
    assert.deepEqual(Object.keys(item), ["q", "tag"]);
    assert.match(item.tag, /^w:[0-9a-f]{10}$/);
    assert.equal(item.tag, watchTagSync(item.q), "Web Crypto and the ranker agree");
  }
});

function fakeFetch(answer = () => ({ ok: true, status: 200 })) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const a = answer(calls.length);
    if (a instanceof Error) throw a;
    return a;
  };
  fn.calls = calls;
  return fn;
}

test("sync: sends once, then not again until the value changes or a day passes", async () => {
  const storage = new MemoryStorage();
  let clock = 1_000_000;
  const now = () => clock;
  const p = profileWith((x) => { x.topics.p_sodium_battery = phrase("sodium battery"); });
  storeProfile(storage, p);
  const fetchImpl = fakeFetch();
  assert.equal(await syncInterests({ storage, fetchImpl, now }), "sent");
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, ENDPOINT);
  assert.equal(init.method, "PUT");
  assert.equal(init.redirect, "manual", "an Access login redirect is a failure, never followed");
  assert.equal(init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), await watchPayload(p));
  assert.ok(!storage.getItem(SYNC_KEY).includes("sodium"), "only a digest of what was sent is kept");

  assert.equal(await syncInterests({ storage, fetchImpl, now }), "same");
  assert.equal(fetchImpl.calls.length, 1);

  storeProfile(storage, profileWith((x) => { x.topics.p_grid_storage = phrase("grid storage"); }));
  assert.equal(await syncInterests({ storage, fetchImpl, now }), "sent", "an edit is a new value");
  assert.equal(fetchImpl.calls.length, 2);

  clock += REFRESH_MS + 1;
  assert.equal(await syncInterests({ storage, fetchImpl, now }), "sent", "a day later it is sent again");
});

test("sync: offline waits, a failure or redirect is not recorded, and the next try sends", async () => {
  const storage = new MemoryStorage();
  storeProfile(storage, profileWith((x) => { x.topics.p_sodium_battery = phrase("sodium battery"); }));
  const none = fakeFetch();
  assert.equal(await syncInterests({ storage, fetchImpl: none, online: false }), "offline");
  assert.equal(none.calls.length, 0);
  for (const answer of [new TypeError("network"), { ok: false, status: 503 }, { ok: false, status: 0, type: "opaqueredirect" }]) {
    assert.equal(await syncInterests({ storage, fetchImpl: fakeFetch(() => answer) }), "failed");
    assert.equal(storage.getItem(SYNC_KEY), null);
  }
  assert.equal(await syncInterests({ storage, fetchImpl: fakeFetch() }), "sent");
});

test("sync: with nothing stored yet, the default profile's two standing stories are sent", async () => {
  const storage = new MemoryStorage();
  const fetchImpl = fakeFetch();
  assert.equal(await syncInterests({ storage, fetchImpl }), "sent");
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).queries.length, 2);
});

test("the service worker never answers /api/interests from a cache", async () => {
  const { strategyFor, STRATEGY } = await import("../../app/static/js/sw-routes.js");
  const origin = "https://almanac.example";
  assert.equal(strategyFor({ url: `${origin}/api/interests`, destination: "", mode: "cors" }, origin), STRATEGY.BYPASS);
  assert.equal(strategyFor({ url: `${origin}/js/phrase.js`, destination: "script", mode: "cors" }, origin), STRATEGY.SHELL);
});
