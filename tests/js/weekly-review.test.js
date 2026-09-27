// S29: the deterministic weekly review. Aggregation, thresholds, caps, exclusions, the
// breadth guard, the S19 gate on every proposal, apply and undo through ProfileStore,
// and determinism (same history in, same proposals out).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  weeklyReview, aggregate, evidence, weekKey, topicFor, summaryLine,
  SAMPLE_FLOOR, MIN_LIFT, THUMBS_FLOOR, MAX_PER_WEEK, AFFINITY_STEP, BOOST_STEP, AFFINITY_FLOOR, WINDOW_MS, DAY_MS,
} from "../../app/static/js/weekly/review.js";
import { readWeekly, markAccepted, markSkipped, markUndone, undoDraft, WEEKLY_KEY } from "../../app/static/js/weekly/state.js";
import { gateProposal, AI_WRITABLE } from "../../app/static/js/ai/gate.js";
import { applyApprovedProposal } from "../../app/static/js/ai/review.js";
import { RejectionLedger } from "../../app/static/js/ai/ledger.js";
import { ProfileStore, MemoryStorage } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { commitEdit } from "../../app/static/js/profile/you-edits.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf-8");
const SCHEMAS = {
  profileSchema: JSON.parse(read("../../app/static/profile.schema.json")),
  proposalSchema: JSON.parse(read("../../app/static/proposal.schema.json")),
};
const NOW = Date.parse("2026-09-27T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

const CATALOG = {
  reuters: { name: "Reuters", lean: "center", country: "GB", bucket: "general" },
  cna: { name: "CNA", lean: "non-us", country: "SG", bucket: "singapore" },
  toi: { name: "Times of Israel", lean: "non-us", country: "IL", bucket: "israel_gaza" },
  lefty: { name: "Lefty Daily", lean: "left", country: "US", bucket: "us_politics" },
};

function profile() {
  return buildDefaultProfile("2026-09-20T00:00:00Z");
}

/** Records for one attribute block: `shown` stories, the first `opened` of them opened. */
function block(prefix, { topics = [], source = "reuters", shown, opened, daysAgo = 1 }) {
  const s = [];
  const o = [];
  for (let i = 0; i < shown; i++) {
    const rec = { id: `${prefix}-${i}`, topics, source_id: source, time: iso(NOW - daysAgo * DAY_MS - i * 60_000) };
    s.push(rec);
    if (i < opened) o.push({ ...rec, time: iso(NOW - daysAgo * DAY_MS - i * 60_000 + 30_000) });
  }
  return { shown: s, opened: o };
}

function history(...blocks) {
  return { shown: blocks.flatMap((b) => b.shown), opened: blocks.flatMap((b) => b.opened) };
}

function thumb(id, direction, topics, source = "reuters", daysAgo = 1) {
  return { id, direction, topics, source, lean: CATALOG[source]?.lean || null, time: iso(NOW - daysAgo * DAY_MS) };
}

function review(h, extra = {}) {
  return weeklyReview({ thumbs: [], profile: profile(), catalog: CATALOG, nowMs: NOW, schemas: SCHEMAS, ...h, ...extra });
}

test("the chosen numbers stay inside the gate's own caps", () => {
  assert.equal(AFFINITY_STEP, AI_WRITABLE["$.topics.*.affinity"].cap);
  assert.ok(BOOST_STEP <= AI_WRITABLE["$.boosts[*].amount"].cap);
  assert.equal(SAMPLE_FLOOR, 8);
  assert.equal(MIN_LIFT, 0.25);
  assert.equal(THUMBS_FLOOR, 3);
  assert.equal(MAX_PER_WEEK, 5);
  assert.equal(AFFINITY_FLOOR, 0.2);
});

test("aggregate: shown and opened union, window edges, tag mapping, catalog attributes, thumbs", () => {
  const p = profile();
  const opened = [
    { id: "a", topics: ["ai"], source_id: "reuters", time: iso(NOW - DAY_MS) },
    // opened without a shown record (from search): still counts as shown once
    { id: "b", topics: ["politics"], source_id: "lefty", time: iso(NOW - 2 * DAY_MS) },
    // outside the window
    { id: "old", topics: ["ai"], source_id: "reuters", time: iso(NOW - WINDOW_MS - 1) },
  ];
  const shown = [
    { id: "a", topics: ["ai"], source_id: "reuters", time: iso(NOW - DAY_MS - 5000) },
    { id: "c", topics: ["ai", "biotech"], source_id: "cna", time: iso(NOW - 3 * DAY_MS) },
    { id: "future", topics: ["ai"], source_id: "reuters", time: iso(NOW + 1000) },
    { id: "bad", topics: ["ai"], time: "not a time" },
  ];
  const thumbs = [thumb("a", "up", ["ai"]), thumb("x", "down", ["science"], "cna"), thumb("y", "sideways", ["ai"])];
  const { total, attributes } = aggregate({ opened, shown, thumbs, profile: p, catalog: CATALOG, nowMs: NOW });
  assert.deepEqual(total, { shown: 3, opened: 2 });
  assert.deepEqual(attributes.get("topic:ai"), { shown: 2, opened: 1, up: 1, down: 0 });
  // politics maps to us_politics (ranker TAG_TO_TOPIC), biotech to industrial_biotech
  assert.deepEqual(attributes.get("topic:us_politics"), { shown: 1, opened: 1, up: 0, down: 0 });
  assert.deepEqual(attributes.get("topic:industrial_biotech"), { shown: 1, opened: 0, up: 0, down: 0 });
  assert.deepEqual(attributes.get("topic:science"), { shown: 0, opened: 0, up: 0, down: 1 });
  assert.deepEqual(attributes.get("source:reuters"), { shown: 1, opened: 1, up: 1, down: 0 });
  assert.deepEqual(attributes.get("lean:left"), { shown: 1, opened: 1, up: 0, down: 0 });
  assert.deepEqual(attributes.get("country:SG"), { shown: 1, opened: 0, up: 0, down: 1 });
  assert.equal(attributes.has("lean:non-us"), false, "non-us is not a lean; country covers it");
  assert.equal(topicFor("politics", p), "us_politics");
  assert.equal(topicFor("science", p), "science");
});

test("evidence: sample floor, effect size, thumbs floor, mixed evidence", () => {
  const total = (s, o) => ({ shown: s, opened: o });
  // 7 shown is under the floor, 8 is not (rest: 20 shown, 4 opened = 20%)
  assert.equal(evidence({ shown: 7, opened: 7, up: 0, down: 0 }, total(27, 11)), null);
  assert.equal(evidence({ shown: 8, opened: 8, up: 0, down: 0 }, total(28, 12)).direction, "up");
  // the rest needs a sample too
  assert.equal(evidence({ shown: 10, opened: 10, up: 0, down: 0 }, total(17, 11)), null);
  // lift of exactly 0.25 clears; 0.2 does not (rest 10 shown, 2 opened = 20%)
  assert.equal(evidence({ shown: 20, opened: 9, up: 0, down: 0 }, total(30, 11)).direction, "up");
  assert.equal(evidence({ shown: 20, opened: 8, up: 0, down: 0 }, total(30, 10)), null);
  // lowering needs the same effect size the other way
  assert.equal(evidence({ shown: 10, opened: 0, up: 0, down: 0 }, total(20, 5)).direction, "down");
  // thumbs alone: 3 net clears, 2 does not
  assert.equal(evidence({ shown: 1, opened: 1, up: 3, down: 0 }, total(30, 10)).direction, "up");
  assert.equal(evidence({ shown: 1, opened: 1, up: 3, down: 1 }, total(30, 10)), null);
  assert.equal(evidence({ shown: 0, opened: 0, up: 0, down: 3 }, total(30, 10)).direction, "down");
  // mixed: opens say up, thumbs say down
  assert.equal(evidence({ shown: 10, opened: 10, up: 0, down: 3 }, total(30, 10)), null);
  // mixed: thumbs up, but opened far less than the rest
  assert.equal(evidence({ shown: 10, opened: 0, up: 4, down: 0 }, total(30, 15)), null);
});

test("a clear pattern becomes one gated proposal with a plain sentence", () => {
  const h = history(
    block("ai", { topics: ["ai"], shown: 11, opened: 9 }),
    block("misc", { topics: ["economy"], shown: 20, opened: 6 }),
  );
  const r = review(h);
  const ai = r.proposals.find((x) => x.key === "topic:ai");
  assert.ok(ai, JSON.stringify(r));
  assert.equal(ai.path, "$.topics.ai.affinity");
  assert.equal(ai.old_value, 0.6);
  assert.equal(ai.new_value, 0.7);
  assert.equal(ai.sentence, "You opened 9 of 11 AI stories shown, against 30% of the rest; raise AI a notch within Normal?");
  assert.equal(gateProposal(profile(), ai.proposal, SCHEMAS).decision, "review");
  // economy is not an interest: noticed, never proposed
  assert.ok(r.noticed.some((n) => n.key === "topic:economy" && n.sentence.includes("Not one of your interests")));
  assert.ok(!r.proposals.some((x) => x.key === "topic:economy"));
  assert.equal(summaryLine(r), `${r.proposals.length} suggestion${r.proposals.length === 1 ? "" : "s"}`);
});

test("level words: a step that crosses a level says so", () => {
  const p = profile();
  p.topics.world.affinity = 0.7;
  const h = history(block("w", { topics: ["world"], shown: 10, opened: 10 }), block("e", { topics: ["economy"], shown: 10, opened: 1 }));
  const r = review(h, { profile: p });
  const w = r.proposals.find((x) => x.key === "topic:world");
  assert.equal(w.new_value, 0.8);
  assert.match(w.sentence, /raise World from Normal to More\?$/);
});

test("at most MAX_PER_WEEK proposals, minus what is already accepted, never a decided path", () => {
  const p = profile();
  const topics = ["ai", "asia", "climate_tech", "conflict", "economy", "foodtech", "science"];
  for (const id of topics) p.topics[id] = { label: id.toUpperCase(), affinity: 0.5, half_life_hours: 24, enabled: true };
  const blocks = topics.map((t, i) => block(t, { topics: [t], shown: 10, opened: 10 - (i % 2) }));
  blocks.push(block("filler", { topics: ["world"], shown: 30, opened: 0 }));
  const h = history(...blocks);
  const full = review(h, { profile: p });
  assert.equal(full.proposals.length, MAX_PER_WEEK);
  for (const x of full.proposals) {
    assert.ok(Math.abs(x.new_value - x.old_value) <= AFFINITY_STEP + 1e-9);
    assert.equal(x.proposal.changes.length, 1);
  }
  const later = review(h, { profile: p, acceptedCount: 3, decided: { [full.proposals[0].path]: "accepted" } });
  assert.equal(later.proposals.length, 2);
  assert.ok(!later.proposals.some((x) => x.path === full.proposals[0].path));
  const done = review(h, { profile: p, acceptedCount: MAX_PER_WEEK });
  assert.equal(done.proposals.length, 0);
  assert.equal(summaryLine(done), "No suggestions this week");
});

test("exclusions: must-know, Off, muted, standing stories, mutes, lean and country", () => {
  const p = profile();
  p.topics.ai.enabled = false;
  p.mutes.topics = ["singapore"];
  p.mutes.sources = ["reuters"];
  p.boosts = [
    { id: "reuters-lift", label: "Reuters", match_type: "source", match_value: "reuters", amount: 0.2 },
    { id: "toi-lift", label: "ToI", match_type: "source", match_value: "toi", amount: 0.2 },
  ];
  p.standing_stories[0].tags = ["world"];
  const h = history(
    block("mk", { topics: ["must_know", "world"], source: "toi", shown: 12, opened: 0 }),
    block("ai", { topics: ["ai"], source: "reuters", shown: 10, opened: 10 }),
    block("sg", { topics: ["singapore"], source: "lefty", shown: 10, opened: 10 }),
    block("x", { topics: ["us_politics"], source: "cna", shown: 12, opened: 3 }),
  );
  const r = review(h, { profile: p });
  const paths = r.proposals.map((x) => x.path);
  assert.ok(!paths.some((x) => /must_know|standing|exploration|mutes|trust|passes/.test(x)), paths.join());
  assert.ok(!paths.includes("$.topics.ai.affinity"), "Off topic never proposed");
  assert.ok(!paths.includes("$.topics.singapore.affinity"), "muted topic never proposed");
  assert.ok(!paths.includes("$.topics.world.affinity"), "a standing story's tag is never lowered");
  assert.ok(!paths.includes("$.boosts[reuters-lift].amount"), "muted source never proposed");
  assert.ok(!paths.includes("$.boosts[toi-lift].amount"), "a standing story's source is never lowered");
  assert.ok(r.noticed.every((n) => !n.path));
  assert.ok(r.noticed.some((n) => n.kind === "lean" || n.kind === "country"), JSON.stringify(r.noticed));
});

test("a source boost moves by a small step, within the gate cap", () => {
  const p = profile();
  p.boosts = [{ id: "cna-lift", label: "CNA", match_type: "source", match_value: "cna", amount: 0.3 }];
  const h = history(block("c", { topics: [], source: "cna", shown: 10, opened: 9 }), block("r", { topics: [], source: "reuters", shown: 12, opened: 1 }));
  const r = review(h, { profile: p });
  const c = r.proposals.find((x) => x.key === "source:cna");
  assert.equal(c.path, "$.boosts[cna-lift].amount");
  assert.equal(c.new_value, 0.4);
  assert.match(c.sentence, /raise your CNA boost from \+0\.30 to \+0\.40\?$/);
  // Reuters has no boost: noticed with its reason
  assert.ok(r.noticed.some((n) => n.key === "source:reuters" && n.sentence.endsWith("There is no boost for this outlet to adjust.")));
});

test("rarely shown is never a reason to lower; the floor is Less", () => {
  const p = profile();
  // AI shown 3 times, never opened: under the sample floor, so no proposal at all
  const h = history(block("ai", { topics: ["ai"], shown: 3, opened: 0 }), block("w", { topics: ["world"], shown: 20, opened: 10 }));
  const r = review(h, { profile: p });
  assert.ok(!r.proposals.some((x) => x.key === "topic:ai"));
  // At Less already (0.2), a clear lowering pattern proposes nothing further
  p.topics.ai.affinity = 0.2;
  const h2 = history(block("ai", { topics: ["ai"], shown: 12, opened: 0 }), block("w", { topics: ["world"], shown: 20, opened: 10 }));
  assert.ok(!review(h2, { profile: p }).proposals.some((x) => x.key === "topic:ai"));
  p.topics.ai.affinity = 0.25;
  const low = review(h2, { profile: p }).proposals.find((x) => x.key === "topic:ai");
  assert.equal(low.new_value, 0.2);
});

test("breadth guard: while breadth is falling, narrowing proposals are held back", () => {
  const p = profile();
  const h = history(
    block("ai", { topics: ["ai"], shown: 12, opened: 12 }),
    block("w", { topics: ["us_politics"], shown: 12, opened: 0 }),
  );
  const steady = review(h, { profile: p });
  assert.equal(steady.breadthFalling, false);
  assert.ok(steady.proposals.some((x) => x.key === "topic:us_politics" && x.direction === "down"));
  assert.ok(steady.proposals.some((x) => x.key === "topic:ai" && x.direction === "up"));

  // Last week spread across four topics; this week's opens all AI: breadth falls.
  const lastWeek = ["ai", "world", "singapore", "us_politics"].flatMap((t, ti) =>
    [0, 1, 2].map((k) => ({ id: `lw-${ti}-${k}`, topics: [t], source_id: "reuters", time: iso(NOW - 9 * DAY_MS) })));
  const falling = review({ shown: h.shown, opened: [...h.opened, ...lastWeek] }, { profile: p });
  assert.equal(falling.breadthFalling, true);
  assert.ok(!falling.proposals.some((x) => x.direction === "down"), JSON.stringify(falling.proposals));
  assert.ok(!falling.proposals.some((x) => x.key === "topic:ai"), "the week's top topic is not raised further");
  assert.ok(falling.held.some((x) => x.key === "topic:us_politics"));
  assert.ok(falling.held.some((x) => x.key === "topic:ai"));
});

test("every proposal passes the S19 gate; a stale profile is refused on apply", () => {
  const p = profile();
  const h = history(block("ai", { topics: ["ai"], shown: 11, opened: 9 }), block("e", { topics: ["world"], shown: 20, opened: 2 }));
  const r = review(h, { profile: p });
  assert.ok(r.proposals.length >= 1);
  for (const x of r.proposals) assert.equal(gateProposal(p, x.proposal, SCHEMAS).decision, "review");

  const storage = new MemoryStorage();
  let synced = 0;
  const store = new ProfileStore({ storage, schema: SCHEMAS.profileSchema, seedDefault: () => profile(), now: () => "2026-09-27T12:00:00Z", onSave: () => { synced++; } });
  const ledger = new RejectionLedger({ storage, now: () => "2026-09-27T12:00:00Z" });
  // The owner edits AI by hand first: the staged proposal's old value is now stale.
  commitEdit(store, (cur) => ({ ...cur, topics: { ...cur.topics, ai: { ...cur.topics.ai, affinity: 0.65 } } }));
  const ai = r.proposals.find((x) => x.key === "topic:ai");
  const stale = applyApprovedProposal(store, { proposal: ai.proposal }, { schemas: SCHEMAS, ledger });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale_old_value");
  assert.equal(store.current().topics.ai.affinity, 0.65);
  assert.equal(synced, 1);
});

test("accept, then undo, through ProfileStore; decisions persist for the week", () => {
  const storage = new MemoryStorage();
  let synced = 0;
  const store = new ProfileStore({ storage, schema: SCHEMAS.profileSchema, seedDefault: () => profile(), now: () => "2026-09-27T12:00:00Z", onSave: () => { synced++; } });
  const ledger = new RejectionLedger({ storage, now: () => "2026-09-27T12:00:00Z" });
  const h = history(block("ai", { topics: ["ai"], shown: 11, opened: 9 }), block("w", { topics: ["us_politics"], shown: 20, opened: 2 }));
  const week = weekKey(NOW);
  const r1 = review(h, { profile: store.current() });
  const [first, second] = r1.proposals;
  assert.ok(first && second, JSON.stringify(r1.proposals));

  const applied = applyApprovedProposal(store, { proposal: first.proposal }, { schemas: SCHEMAS, ledger });
  assert.equal(applied.ok, true);
  assert.equal(synced, 1, "accept goes through store.save, so interests sync is scheduled");
  markAccepted(storage, week, first, applied.version);
  markSkipped(storage, week, second.path);
  const state = readWeekly(storage, week);
  assert.deepEqual(Object.keys(state.decided).sort(), [first.path, second.path].sort());

  // The same history, re-reviewed after the accept: neither decided path comes back.
  const r2 = review(h, { profile: store.current(), decided: state.decided, acceptedCount: state.accepted.length });
  assert.ok(!r2.proposals.some((x) => x.path === first.path || x.path === second.path));

  // Undo restores the old value as one new version.
  const { draft, paths } = undoDraft(store.current(), state.accepted);
  assert.deepEqual(paths, [first.path]);
  const before = store.current().profile_version;
  const res = commitEdit(store, () => draft);
  assert.equal(res.ok, true);
  assert.equal(store.current().profile_version, before + 1);
  assert.equal(synced, 2);
  const after = markUndone(storage, week);
  assert.equal(after.accepted.length, 0);
  assert.equal(after.decided[first.path], "undone");
  // Nothing left to undo, and an owner edit since the accept is never overwritten.
  assert.equal(undoDraft(store.current(), state.accepted).draft, null);

  // A new week starts empty.
  assert.deepEqual(readWeekly(storage, weekKey(NOW + 7 * DAY_MS)).decided, {});
  storage.setItem(WEEKLY_KEY, "{not json");
  assert.deepEqual(readWeekly(storage, week), { week, decided: {}, accepted: [] });
});

test("deterministic: same history in, same proposals out, whatever the input order", () => {
  const p = profile();
  p.boosts = [{ id: "cna-lift", label: "CNA", match_type: "source", match_value: "cna", amount: 0 }];
  const h = history(
    block("ai", { topics: ["ai"], source: "cna", shown: 11, opened: 9 }),
    block("w", { topics: ["world"], source: "reuters", shown: 20, opened: 2 }),
    block("sg", { topics: ["singapore"], source: "lefty", shown: 9, opened: 7 }),
  );
  const thumbs = [thumb("t1", "up", ["us_politics"]), thumb("t2", "up", ["us_politics"]), thumb("t3", "up", ["us_politics"])];
  const a = review({ ...h, thumbs }, { profile: p });
  const rev = (xs) => [...xs].reverse();
  const b = review({ shown: rev(h.shown), opened: rev(h.opened), thumbs: rev(thumbs) }, { profile: structuredClone(p) });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(a.proposals.some((x) => x.key === "topic:us_politics" && x.sentence.startsWith("You gave US Politics stories 3 thumbs up and 0 down")));
});

test("weekKey: ISO weeks, Monday start, UTC", () => {
  assert.equal(weekKey(Date.parse("2026-09-27T12:00:00Z")), "2026W39");
  assert.equal(weekKey(Date.parse("2026-09-28T00:00:00Z")), "2026W40");
  assert.equal(weekKey(Date.parse("2026-01-01T00:00:00Z")), "2026W01");
  assert.equal(weekKey(Date.parse("2027-01-01T00:00:00Z")), "2026W53");
  assert.equal(weekKey(Date.parse("2024-12-30T00:00:00Z")), "2025W01");
});
