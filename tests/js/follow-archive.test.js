// S30 proof: the Following page's own local archive (Timeline). A card snapshot per
// match, deduplicated by id (a story matched again keeps its newest snapshot), pruned to
// the smaller of 30 days and 200 items per follow, and recorded once per device rank for
// every followed phrase and standing story (the same following.js fixture W3 already
// uses, so the archive agrees with what the Following tab and each follow's own page
// show as "now").
import { test } from "node:test";
import assert from "node:assert/strict";

import { coverageContext } from "../../app/static/js/coverage.js";
import {
  ARCHIVE_MAX_DAYS, ARCHIVE_MAX_ITEMS, archiveKey, mergeFollowArchive, pruneFollowArchive,
  recordFollowArchive, snapshotFromStory,
} from "../../app/static/js/follow-archive.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { withPhraseAdded } from "../../app/static/js/profile/you-edits.js";
import { phraseQuery, watchTagSync } from "../../app/static/js/phrase.js";

const NOW = "2026-09-24T12:00:00Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86_400_000;
const iso = (hours) => new Date(NOW_MS - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
const art = (id, source_id, hours, title, extra = {}) => ({ id, source_id, title, published_at: iso(hours), topics: ["world"], ...extra });

test("archiveKey: kind and id, the same shape following.js's own follow objects use", () => {
  assert.equal(archiveKey("phrase", "p_abc"), "phrase:p_abc");
  assert.equal(archiveKey("story", "sudan"), "story:sudan");
});

test("snapshotFromStory: id, title, outlet, time, markers and url from the lowest article id", () => {
  const ctx = coverageContext({
    pool: { articles: [art("a2", "npr", 1, "Second piece"), art("a1", "bbc", 2, "First piece")] },
    names: { npr: "NPR", bbc: "BBC" },
    leans: { npr: "center-left", bbc: "center" },
    countries: { bbc: "GB" },
    coverage: { a1: { url: "https://bbc.example/a1" }, a2: { url: "https://npr.example/a2" } },
  });
  const story = { id: "c1", article_ids: ["a2", "a1"], titles: ["First piece", "Second piece"], latest_ms: NOW_MS - 1 * 3_600_000 };
  const snap = snapshotFromStory(story, ctx);
  assert.equal(snap.id, "c1");
  assert.equal(snap.title, "First piece"); // titles[0], not the primary article's own
  assert.equal(snap.outlet, "BBC"); // a1 (the lower id) is the representative article
  assert.equal(snap.url, "https://bbc.example/a1");
  assert.equal(snap.markers.lean, "center");
  assert.equal(snap.markers.country, "GB");
  assert.equal(snap.time, new Date(story.latest_ms).toISOString());
});

test("pruneFollowArchive: newest first, older than maxDays dropped, capped to maxItems", () => {
  const records = [
    { id: "old", time: new Date(NOW_MS - 40 * DAY_MS).toISOString() },
    { id: "mid", time: new Date(NOW_MS - 2 * DAY_MS).toISOString() },
    { id: "new", time: new Date(NOW_MS - 1 * DAY_MS).toISOString() },
    { id: "bad", time: "not a date" },
  ];
  const kept = pruneFollowArchive(records, NOW_MS, { maxDays: 30, maxItems: 200 });
  assert.deepEqual(kept.map((r) => r.id), ["new", "mid"]);
});

test("pruneFollowArchive caps to maxItems, newest kept", () => {
  const records = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, time: new Date(NOW_MS - i * 3_600_000).toISOString() }));
  const kept = pruneFollowArchive(records, NOW_MS, { maxItems: 2, maxDays: 30 });
  assert.deepEqual(kept.map((r) => r.id), ["r0", "r1"]);
});

test("the shipped caps: 200 items, 30 days per follow", () => {
  assert.equal(ARCHIVE_MAX_ITEMS, 200);
  assert.equal(ARCHIVE_MAX_DAYS, 30);
});

test("mergeFollowArchive: a story matched again keeps its newest snapshot, not a duplicate", () => {
  const existing = [{ id: "a", title: "Old headline", time: new Date(NOW_MS - 2 * 3_600_000).toISOString() }];
  const incoming = [{ id: "a", title: "Updated headline", time: new Date(NOW_MS - 2 * 3_600_000).toISOString() }];
  const merged = mergeFollowArchive(existing, incoming, NOW_MS);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "Updated headline");
});

test("mergeFollowArchive: existing plus incoming, newest first", () => {
  const existing = [{ id: "old", time: new Date(NOW_MS - 3 * 3_600_000).toISOString() }];
  const incoming = [{ id: "new", time: new Date(NOW_MS - 1 * 3_600_000).toISOString() }];
  const merged = mergeFollowArchive(existing, incoming, NOW_MS);
  assert.deepEqual(merged.map((r) => r.id), ["new", "old"]);
});

// A tiny Map-backed stand-in for follow-archive-store.js's {get, put}, the same shape
// history/record.test.js-style tests already use for their own store.
function fakeStore() {
  const rows = new Map();
  return {
    rows,
    async get(key) { return rows.has(key) ? { follow: key, items: rows.get(key) } : null; },
    async put(key, items) { rows.set(key, items); },
  };
}

const ONE = "Harbor Tunnel";
function pool() {
  return {
    generated_at: NOW,
    articles: [
      art("g1", "google_news_search", 2, "Commuters face a long detour this week", { watch: [watchTagSync(phraseQuery(ONE))] }),
      art("h1", "npr", 3, "Harbor tunnel repairs begin on Monday"),
    ],
    clusters: [],
  };
}
const input = () => ({ now: NOW, pool: pool(), buckets: {}, leans: {}, names: { npr: "NPR", google_news_search: "Google News" }, health: {}, events: [], bv: {} });

test("recordFollowArchive: records every current match, keyed by follow", async () => {
  const profile = withPhraseAdded(buildDefaultProfile(NOW), ONE);
  const phraseId = Object.keys(profile.topics).find((id) => profile.topics[id].phrase);
  const store = fakeStore();
  await recordFollowArchive(store, input(), profile, NOW_MS);
  const key = archiveKey("phrase", phraseId);
  assert.ok(store.rows.has(key));
  assert.deepEqual(store.rows.get(key).map((r) => r.id).sort(), ["g1", "h1"].sort());
});

test("recordFollowArchive: a second, later rank keeps both matches, deduplicated", async () => {
  const profile = withPhraseAdded(buildDefaultProfile(NOW), ONE);
  const phraseId = Object.keys(profile.topics).find((id) => profile.topics[id].phrase);
  const store = fakeStore();
  await recordFollowArchive(store, input(), profile, NOW_MS);
  await recordFollowArchive(store, input(), profile, NOW_MS + 3_600_000);
  const items = store.rows.get(archiveKey("phrase", phraseId));
  assert.equal(items.length, 2, "the same two matches recorded twice do not duplicate");
});

test("recordFollowArchive: never throws when the store fails", async () => {
  const profile = withPhraseAdded(buildDefaultProfile(NOW), ONE);
  const failing = { get: async () => { throw new Error("blocked"); }, put: async () => { throw new Error("blocked"); } };
  await assert.doesNotReject(recordFollowArchive(failing, input(), profile, NOW_MS));
});
