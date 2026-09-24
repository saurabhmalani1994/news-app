// S25: the reader's decisions under Node: which tap opens the reader and which links
// out, body loading (cache hit, cache miss, offline, a missing file, a fetch error, a
// bad file), and the small text rules around the body. The DOM view is proven in
// headless Chrome under the live CSP by tests/browser/reader_check.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BODY_ID, NOTES, TRAILER, bodyPath, checkBody, formatPublished, imageStem, loadBody, readerChoice, sameText, smartQuotes, tinyImage,
} from "../../app/static/js/reader/core.js";

const ID = "d04ffbf62ba22807";
const RECORD = {
  schema_version: 1, article_id: ID, source_id: "reason", source_name: "Reason",
  url: "https://reason.com/2026/09/23/story/", body_html: "<p>Almost exactly a decade ago.</p>",
};

function link(attrs) {
  return { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
}

function memoryCache(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store, gets: 0, puts: 0,
    async get(id) { this.gets++; return store.get(id) ?? null; },
    async put(id, body) { this.puts++; store.set(id, body); },
  };
}

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return respond(url);
  };
  fn.calls = calls;
  return fn;
}
const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test("a story marked data-body opens the reader; any other links out", () => {
  assert.equal(readerChoice(link({ "data-body": ID, href: "https://x.example/a" })), ID);
  assert.equal(readerChoice(link({ href: "https://x.example/a" })), null);
  assert.equal(readerChoice(null), null);
});

test("a modified or middle click keeps the browser's own link behaviour", () => {
  const a = link({ "data-body": ID });
  for (const event of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { defaultPrevented: true }]) {
    assert.equal(readerChoice(a, event), null, JSON.stringify(event));
  }
  assert.equal(readerChoice(a, { button: 0 }), ID);
});

test("a data-body that is not an article id never becomes a path", () => {
  for (const bad of ["../pool", "a/b", "", "A1", "x".repeat(65), "id.json", "javascript:alert(1)", " id"]) {
    assert.equal(readerChoice(link({ "data-body": bad })), null, bad);
    assert.equal(BODY_ID.test(bad), false);
  }
  assert.throws(() => bodyPath("../pool"));
  assert.equal(bodyPath(ID), `bodies/${ID}.json`);
});

test("cache miss: fetched from the app's own origin, checked, then cached", async () => {
  const cache = memoryCache();
  const fetchFn = fakeFetch(() => json(RECORD));
  const result = await loadBody(ID, { cache, fetchFn, online: () => true });
  assert.equal(result.state, "ready");
  assert.equal(result.from, "network");
  assert.equal(result.body.body_html, RECORD.body_html);
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, `bodies/${ID}.json`);
  assert.equal(fetchFn.calls[0].init.credentials, "same-origin");
  assert.equal(cache.puts, 1);
  assert.deepEqual(cache.store.get(ID), checkBody(RECORD, ID));
});

test("cache hit: no request at all, even offline", async () => {
  const cache = memoryCache({ [ID]: checkBody(RECORD, ID) });
  const fetchFn = fakeFetch(() => { throw new Error("must not fetch"); });
  for (const online of [true, false]) {
    const result = await loadBody(ID, { cache, fetchFn, online: () => online });
    assert.equal(result.state, "ready");
    assert.equal(result.from, "cache");
  }
  assert.equal(fetchFn.calls.length, 0);
});

test("offline with nothing cached says offline without trying the network", async () => {
  const fetchFn = fakeFetch(() => json(RECORD));
  const result = await loadBody(ID, { cache: memoryCache(), fetchFn, online: () => false });
  assert.deepEqual(result, { state: "offline" });
  assert.equal(fetchFn.calls.length, 0);
});

test("a missing body file (404, 410) is 'missing', not an error", async () => {
  for (const status of [404, 410]) {
    const result = await loadBody(ID, { cache: memoryCache(), fetchFn: fakeFetch(() => json(null, status)), online: () => true });
    assert.deepEqual(result, { state: "missing" });
  }
});

test("server errors, network failures, bad JSON and wrong records are 'error' and never cached", async () => {
  const cases = [
    () => json(null, 500),
    () => json(null, 503),
    () => { throw new TypeError("Failed to fetch"); },
    () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }),
    () => json({ ...RECORD, article_id: "someoneelse" }),
    () => json({ ...RECORD, schema_version: 2 }),
    () => json({ ...RECORD, body_html: "   " }),
    () => json({ ...RECORD, source_name: "" }),
    () => json([RECORD]),
  ];
  for (const respond of cases) {
    const cache = memoryCache();
    const result = await loadBody(ID, { cache, fetchFn: fakeFetch(respond), online: () => true });
    assert.deepEqual(result, { state: "error" }, respond.toString());
    assert.equal(cache.puts, 0);
  }
});

test("a network failure while the phone went offline reads as offline", async () => {
  let online = true;
  const fetchFn = fakeFetch(() => { online = false; throw new TypeError("Failed to fetch"); });
  assert.deepEqual(await loadBody(ID, { fetchFn, online: () => online }), { state: "offline" });
});

test("a broken cache is a miss, and a cache that cannot store still reads", async () => {
  const broken = { get: async () => { throw new Error("blocked"); }, put: async () => { throw new Error("quota"); } };
  const result = await loadBody(ID, { cache: broken, fetchFn: fakeFetch(() => json(RECORD)), online: () => true });
  assert.equal(result.state, "ready");
  assert.equal(result.from, "network");
});

test("a stale or foreign cache entry is ignored and refetched", async () => {
  const cache = memoryCache({ [ID]: { ...RECORD, article_id: "other" } });
  const fetchFn = fakeFetch(() => json(RECORD));
  const result = await loadBody(ID, { cache, fetchFn, online: () => true });
  assert.equal(result.from, "network");
  assert.equal(fetchFn.calls.length, 1);
});

test("an id that is not an article id loads nothing", async () => {
  const fetchFn = fakeFetch(() => json(RECORD));
  assert.deepEqual(await loadBody("../pool", { fetchFn }), { state: "missing" });
  assert.equal(fetchFn.calls.length, 0);
});

test("checkBody keeps only an http(s) link out", () => {
  assert.equal(checkBody({ ...RECORD, url: "javascript:alert(1)" }, ID).url, "");
  assert.equal(checkBody({ ...RECORD, url: "https://reason.com/a" }, ID).url, "https://reason.com/a");
  assert.deepEqual(Object.keys(checkBody({ ...RECORD, extra: "x" }, ID)).sort(),
    ["article_id", "body_html", "schema_version", "source_id", "source_name", "url"]);
});

test("every note is calm, short and has no em dash", () => {
  for (const [state, note] of Object.entries(NOTES)) {
    assert.ok(note.head.length <= 40 && note.text.length <= 100, state);
    assert.doesNotMatch(note.head + note.text, /[\u2014!]/);
  }
  assert.equal(NOTES.missing.retry, false);
  assert.equal(NOTES.error.retry, true);
  assert.equal(NOTES.offline.retry, true);
});

test("publish time is set the newspaper way", () => {
  assert.equal(formatPublished("2026-09-23T14:40:00Z", { timeZone: "America/New_York" }), "Sept. 23, 2026, 10:40 a.m.");
  assert.equal(formatPublished("2026-05-01T20:05:00Z", { timeZone: "UTC" }), "May 1, 2026, 8:05 p.m.");
  assert.equal(formatPublished("not a time"), "");
  assert.equal(formatPublished(undefined), "");
});

test("a dek that is the body's own first paragraph is recognised", () => {
  assert.ok(sameText("The “plan” failed.", "the \"plan\" failed"));
  assert.ok(!sameText("The plan failed.", "The plan failed. Then it worked."));
  assert.ok(!sameText("", ""));
});

test("feed trailers and tracking pixels are recognised", () => {
  assert.match("The post Big Story appeared first on Reason.com.", TRAILER);
  assert.doesNotMatch("The post office closed early.", TRAILER);
  assert.ok(tinyImage("1", "1"));
  assert.ok(tinyImage("", "20"));
  assert.ok(!tinyImage("800", "450"));
  assert.ok(!tinyImage(null, null));
});

test("the body's copy of the hero photo is found across CMS sizes", () => {
  const hero = "https://cdn.example/img/q60/uploads/2026/09/Nikole-1200x675.jpg";
  assert.equal(imageStem(hero), imageStem("https://cdn.example/img/c800x450-w800-q60/uploads/2026/09/Nikole-800x450.jpg?w=800"));
  assert.notEqual(imageStem(hero), imageStem("https://cdn.example/uploads/2026/09/Other-1200x675.jpg"));
  assert.equal(imageStem("not a url"), "");
  assert.equal(imageStem("https://cdn.example/%E0.jpg"), "cdn.example/%e0");
});

test("body quotes turn the way the headlines do (app/typography.py)", () => {
  assert.equal(smartQuotes(`"Yes," she said. 'No.' don't students' '90s`), "“Yes,” she said. ‘No.’ don’t students’ ’90s");
  assert.equal(smartQuotes(`" and more`, "d"), "” and more"); // closes a quote opened in an earlier tag
  assert.equal(smartQuotes(`"quoted"`, " "), "“quoted”");
  assert.equal(smartQuotes("no quotes here"), "no quotes here");
  assert.equal(smartQuotes(`a--"b"`).length, 6);
});
