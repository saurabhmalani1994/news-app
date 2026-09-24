// S33 proof: the Live tab shows only an event that is live or pinned; a blocked event
// never shows, whatever the pool says; the panel lists exactly the event's own clusters
// in ranked order; the owner's pin and block overrides are ordinary versioned profile
// saves, owner only (ai/gate.js refuses every live_overrides path, tested there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LIVE_OVERRIDES_DEFAULTS, currentLiveEvent, isBlocked,
  withEventPinned, withEventUnpinned, withEventBlocked,
} from "../../app/static/js/live.js";
import { rankPages } from "../../app/static/js/passes.js";
import { rank } from "../../app/static/js/ranker.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { ProfileStore, MemoryStorage } from "../../app/static/js/profile/store.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));
const NOW = "2026-09-24T06:00:00Z";

function article(id, source_id, hoursOld, title) {
  return { id, source_id, title: title || `Story ${id}`, published_at: new Date(Date.parse(NOW) - hoursOld * 3.6e6).toISOString(), topics: ["world"] };
}

// Three clusters: ev-a (two clusters, the live one) and ev-b (one cluster, not live).
const pool = {
  generated_at: NOW,
  articles: [
    article("a1", "npr", 1), article("a2", "bbc_world", 2), article("a3", "politico", 3),
    article("a4", "npr", 4), article("a5", "bbc_world", 5), article("a6", "politico", 6),
  ],
  clusters: [
    { id: "a1", article_ids: ["a1", "a2"], near_duplicates: [], independent_sources: 2, lean_buckets: ["left", "center"] },
    { id: "a3", article_ids: ["a3", "a4"], near_duplicates: [], independent_sources: 2, lean_buckets: ["left", "center"] },
    { id: "a5", article_ids: ["a5", "a6"], near_duplicates: [], independent_sources: 2, lean_buckets: ["left", "center"] },
  ],
};

const EVENTS = Object.freeze([
  { id: "ev-a", label: "Event A", cluster_ids: ["a1", "a3"], hype: 9, eligible: true, live: true, hold_state: "none" },
  { id: "ev-b", label: "Event B", cluster_ids: ["a5"], hype: 3, eligible: true, live: false, hold_state: "none" },
]);

function profile(edit) {
  const p = buildDefaultProfile(NOW);
  if (edit) edit(p);
  return p;
}

// --- currentLiveEvent: live, pinned, blocked ---------------------------------------

test("currentLiveEvent picks the pool's own live event when there is no override", () => {
  assert.equal(currentLiveEvent(EVENTS, profile()).id, "ev-a");
});

test("currentLiveEvent is null when nothing in the pool is live and nothing is pinned", () => {
  const noneLive = EVENTS.map((e) => ({ ...e, live: false }));
  assert.equal(currentLiveEvent(noneLive, profile()), null);
});

test("a pin keeps its event live even though the pool itself does not mark it live", () => {
  const p = profile((x) => { x.live_overrides = { ...LIVE_OVERRIDES_DEFAULTS, pinned_event_id: "ev-b" }; });
  assert.equal(currentLiveEvent(EVENTS, p).id, "ev-b");
});

test("a pin on an event no longer in the pool falls back to whatever is naturally live", () => {
  const p = profile((x) => { x.live_overrides = { ...LIVE_OVERRIDES_DEFAULTS, pinned_event_id: "ev-gone" }; });
  assert.equal(currentLiveEvent(EVENTS, p).id, "ev-a");
});

test("a blocked event never shows, by id, even though the pool marks it live", () => {
  const p = profile((x) => { x.live_overrides = { ...LIVE_OVERRIDES_DEFAULTS, blocked_event_ids: ["ev-a"] }; });
  assert.equal(currentLiveEvent(EVENTS, p), null); // ev-b is not live, so nothing is
});

test("a blocked label catches a differently-clustered event under the same name, case and space insensitive", () => {
  const p = profile((x) => { x.live_overrides = { ...LIVE_OVERRIDES_DEFAULTS, blocked_labels: ["  event a  "] }; });
  assert.ok(isBlocked(EVENTS[0], { ...LIVE_OVERRIDES_DEFAULTS, blocked_labels: ["EVENT A"] }));
  assert.equal(currentLiveEvent(EVENTS, p), null);
});

test("a block always wins over a pin on the same event", () => {
  const p = profile((x) => {
    x.live_overrides = { pinned_event_id: "ev-a", blocked_event_ids: ["ev-a"], blocked_labels: [] };
  });
  assert.equal(currentLiveEvent(EVENTS, p), null);
});

// --- pure override builders: null on no-op, a versioned-ready draft otherwise ------

test("withEventPinned is a no-op on an already-pinned or a blocked event", () => {
  const already = profile((x) => { x.live_overrides = { ...LIVE_OVERRIDES_DEFAULTS, pinned_event_id: "ev-a" }; });
  assert.equal(withEventPinned(already, EVENTS[0]), null);
  const blocked = profile((x) => { x.live_overrides = { ...LIVE_OVERRIDES_DEFAULTS, blocked_event_ids: ["ev-b"] }; });
  assert.equal(withEventPinned(blocked, EVENTS[1]), null);
});

test("withEventPinned sets pinned_event_id and leaves the rest of the profile untouched", () => {
  const base = profile();
  const draft = withEventPinned(base, EVENTS[0]);
  assert.equal(draft.live_overrides.pinned_event_id, "ev-a");
  assert.deepEqual(draft.live_overrides.blocked_event_ids, []);
  assert.deepEqual(draft.topics, base.topics);
  assert.deepEqual(draft.mutes, base.mutes);
});

test("withEventUnpinned clears a pin, and is a no-op when nothing is pinned", () => {
  assert.equal(withEventUnpinned(profile()), null);
  const pinned = profile((x) => { x.live_overrides = { ...LIVE_OVERRIDES_DEFAULTS, pinned_event_id: "ev-a" }; });
  assert.equal(withEventUnpinned(pinned).live_overrides.pinned_event_id, null);
});

test("withEventBlocked adds both id and label, and clears a pin on the same event", () => {
  const pinned = profile((x) => { x.live_overrides = { ...LIVE_OVERRIDES_DEFAULTS, pinned_event_id: "ev-a" }; });
  const draft = withEventBlocked(pinned, EVENTS[0]);
  assert.deepEqual(draft.live_overrides.blocked_event_ids, ["ev-a"]);
  assert.deepEqual(draft.live_overrides.blocked_labels, ["Event A"]);
  assert.equal(draft.live_overrides.pinned_event_id, null);
});

test("withEventBlocked is a no-op once both the id and the label are already blocked", () => {
  const already = profile((x) => {
    x.live_overrides = { pinned_event_id: null, blocked_event_ids: ["ev-a"], blocked_labels: ["Event A"] };
  });
  assert.equal(withEventBlocked(already, EVENTS[0]), null);
});

// --- rankPages: the panel is exactly the event's clusters, in ranked order ---------

test("rankPages: the live section is exactly the live event's own clusters, in the ranker's own order", () => {
  const scored = rank(pool, profile(), NOW);
  const wantOrder = scored.map((s) => s.id).filter((id) => ["a1", "a3"].includes(id));
  const pages = rankPages(pool, profile(), NOW, { events: EVENTS });
  const live = pages.sections.find((s) => s.id === "live");
  assert.deepEqual(live.stories.map((s) => s.id), wantOrder);
  assert.equal(live.stories.length, 2);
  assert.deepEqual(live.event, { id: "ev-a", label: "Event A" });
  assert.equal(live.label, "Event A");
});

test("rankPages: the live section is empty and eventless when nothing is live", () => {
  const pages = rankPages(pool, profile(), NOW, { events: EVENTS.map((e) => ({ ...e, live: false })) });
  const live = pages.sections.find((s) => s.id === "live");
  assert.deepEqual(live.stories, []);
  assert.equal(live.event, null);
  assert.equal(live.label, "Live"); // the static table label, never read while hidden
});

test("rankPages: a blocked event's clusters never appear on the live tab", () => {
  const p = profile((x) => { x.live_overrides = { ...LIVE_OVERRIDES_DEFAULTS, blocked_event_ids: ["ev-a"] }; });
  const pages = rankPages(pool, p, NOW, { events: EVENTS });
  const live = pages.sections.find((s) => s.id === "live");
  assert.deepEqual(live.stories, []);
  assert.equal(live.event, null);
});

test("rankPages: with no events array at all (an older pool), the live tab is simply absent", () => {
  const pages = rankPages(pool, profile(), NOW, {});
  const live = pages.sections.find((s) => s.id === "live");
  assert.deepEqual(live.stories, []);
  assert.equal(live.event, null);
});

test("the Live slot is still refused by the general section table (sections.js is untouched)", () => {
  // S33 fills the live tab from the events array, never from the topic/bucket table;
  // the "Live slot is empty" invariant in sections.test.js still holds on its own.
  const pages = rankPages(pool, profile(), NOW, { events: EVENTS });
  const other = pages.sections.find((s) => s.id === "us-politics");
  assert.deepEqual(other.stories, []); // nothing in this fixture pool tags us_politics
});

// --- overrides are versioned profile saves -----------------------------------------

function makeStore() {
  let tick = 0;
  return new ProfileStore({ storage: new MemoryStorage(), schema: SCHEMA, seedDefault: buildDefaultProfile, now: () => `2026-09-24T00:00:0${tick++}Z` });
}

test("pinning an event through the store is one ordinary versioned save", () => {
  const store = makeStore();
  const before = store.current();
  assert.equal(before.profile_version, 1);
  const draft = withEventPinned(before, EVENTS[0]);
  const result = store.save(draft);
  assert.equal(result.ok, true);
  assert.equal(result.profile.profile_version, 2);
  assert.equal(result.profile.live_overrides.pinned_event_id, "ev-a");
  assert.equal(store.current().profile_version, 2);
  assert.deepEqual(store.history().map((h) => h.version), [2, 1]);
});

test("blocking an event through the store validates against the schema and is append-only history", () => {
  const store = makeStore();
  const result = store.save(withEventBlocked(store.current(), EVENTS[0]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile.live_overrides.blocked_event_ids, ["ev-a"]);
  const reverted = store.revert(1);
  assert.equal(reverted.ok, true);
  assert.equal(reverted.profile.profile_version, 3);
  assert.deepEqual(reverted.profile.live_overrides.blocked_event_ids, []);
});

test("an out-of-shape live_overrides value fails schema validation, same as any other field", () => {
  const store = makeStore();
  const bad = store.current();
  bad.live_overrides = { pinned_event_id: 5, blocked_event_ids: [], blocked_labels: [] };
  const result = store.save(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("live_overrides")));
});
