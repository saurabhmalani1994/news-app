// S28 proof: standing stories (R2). A low-scoring Sudan story is lifted into the floor
// and says so; a floor already met moves nothing; two floors never undo each other or
// the must-know and exploration placements; a mute wins over a floor (S13: a muted
// source or topic never appears; R19 exempts floors only from thumbs); the silence
// alarm names the right hours and tells "no coverage" apart from "its sources are
// failing"; the profile field is optional, validated, owner only and in the ranking
// key; and everything is deterministic and order-blind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { rankPages } from "../../app/static/js/passes.js";
import { profileKey, storiesFromPool } from "../../app/static/js/ranker.js";
import { STANDING_DEFAULTS, standingStories, qualifies, silenceNotices } from "../../app/static/js/standing.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { validateProfile } from "../../app/static/js/profile/validate.js";
import { gateProposal, REASONS } from "../../app/static/js/ai/gate.js";

const NOW = "2026-09-24T12:00:00Z";
const SCHEMA = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));
const PROPOSAL_SCHEMA = JSON.parse(readFileSync(new URL("../../app/static/proposal.schema.json", import.meta.url), "utf-8"));
const iso = (hoursAgo) => new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
const art = (id, source_id, hoursAgo, topics, title = `Headline for story ${id}`) => ({ id, source_id, title, published_at: iso(hoursAgo), topics });
const poolOf = (articles, clusters = []) => ({ generated_at: NOW, articles, clusters });
const profile = (edit = () => {}) => { const p = buildDefaultProfile(NOW); edit(p); return p; };
const ids = (list) => list.map((s) => s.id);
const entries = (story, pass = "standing-story") => story.passes.filter((e) => e.pass === pass).map((e) => e.text);

// Twenty recent AI stories from outlets of no listed lean: they outscore anything the
// owner does not follow, and trigger no other pass. Each fixture adds its own trigger.
const AI = Array.from({ length: 20 }, (_, i) => art(`ai${String(i).padStart(2, "0")}`, `t${i}`, 1 + i * 0.5, ["ai"]));
const BUCKETS = { dabanga: "sudan", reliefweb: "sudan", toi: "israel_gaza" };
const NAMES = { dabanga: "Radio Dabanga", reliefweb: "ReliefWeb Sudan", toi: "Times of Israel" };
// Low scoring: "conflict" is no profile topic, so it earns no affinity, only recency.
const SUDAN = art("sd", "dabanga", 30, ["conflict"], "Civilians flee North Kordofan as fighting escalates in Sudan");
const GAZA = (id, hoursAgo, extra = {}) => ({ ...art(id, "toi", hoursAgo, ["conflict"], "Gaza ceasefire talks resume in Cairo"), ...extra });

test("defaults come from the owner brief, and are owner only", () => {
  assert.deepEqual(STANDING_DEFAULTS.map((s) => s.label), ["Israel and Gaza", "Sudan"]);
  for (const s of STANDING_DEFAULTS) {
    assert.equal(s.floor_slots, 1);
    assert.equal(s.floor_within, 15);
  }
  assert.deepEqual(STANDING_DEFAULTS.map((s) => s.silence_hours), [24, 36]);
  const p = profile();
  assert.deepEqual(p.standing_stories, JSON.parse(JSON.stringify(STANDING_DEFAULTS)));
  assert.deepEqual(validateProfile(p, SCHEMA), []);
  // S19 keeps them reserved: an AI proposal naming a standing story is refused.
  for (const path of ["$.standing_stories[sudan].silence_hours", "$.standing_stories[sudan].floor_within"]) {
    const proposal = { schema_version: 1, id: "prop-0001", changes: [{ path, old_value: p.standing_stories[1][path.split(".").at(-1)], new_value: 48 }], rationale: "Quiet week.", evidence: [{ kind: "signal", ref: "topic:world:opened", count: 3 }] };
    const verdict = gateProposal(p, proposal, { profileSchema: SCHEMA, proposalSchema: PROPOSAL_SCHEMA });
    assert.equal(verdict.decision, "reject");
    assert.equal(verdict.reason, REASONS.RESERVED_PATH, path);
  }
});

test("matching: whole-word keywords, gated by tags; buckets alone never qualify", () => {
  const [gaza, sudan] = standingStories(profile());
  const story = (titles, topics) => ({ titles, topics });
  assert.ok(qualifies(story(["Sudan’s army retakes Omdurman bridge"], ["world"]), sudan));
  assert.ok(qualifies(story(["Aid reaches El Fasher"], ["conflict"]), sudan));
  assert.ok(!qualifies(story(["Sudanesque: a new album"], ["world"]), sudan), "whole words only");
  assert.ok(!qualifies(story(["Israel beat Norway in the qualifier"], ["sports"]), gaza), "a keyword counts only on a world or conflict story");
  assert.ok(!qualifies(story(["OECD cuts Turkish growth forecast"], ["world", "conflict"]), gaza), "an Israel-bucket outlet's other news does not count");
  const tagOnly = standingStories(profile((p) => { p.standing_stories[0].keywords = []; p.standing_stories[0].tags = ["climate"]; }))[0];
  assert.ok(qualifies(story(["Anything at all"], ["climate"]), tagOnly), "with no keywords, a tag alone qualifies");
});

test("floor: a low-scoring Sudan story is lifted into the top 15, and says so", () => {
  const pool = poolOf([...AI, SUDAN]);
  const off = rankPages(pool, profile((p) => { p.standing_stories = []; }), NOW);
  assert.equal(ids(off.today).indexOf("sd"), 20, "without the floor it is last, 21st");
  const pages = rankPages(pool, profile(), NOW, { buckets: BUCKETS, names: NAMES });
  assert.equal(ids(pages.today).indexOf("sd"), 14);
  const sd = pages.today[14];
  assert.deepEqual(entries(sd), ["Placed by standing story: Sudan, floor 1 in the top 15; moved from 21 to 15, the best Sudan story below the floor on recency and importance alone"]);
  assert.deepEqual(sd.passes.find((e) => e.pass === "standing-story").standing, "sudan");
  // One card left the zone, to the first place below it; the rest kept their places,
  // and every story that moved says why.
  assert.deepEqual(ids(pages.today), [...ids(off.today).slice(0, 14), "sd", ...ids(off.today).slice(14, 20)]);
  assert.deepEqual(entries(pages.today[15]), ["Moved down by standing story: from 15 to 16, a standing-story floor placed a card above it"]);
  // The score is untouched: a pass never changes a score.
  assert.equal(sd.score, off.today[20].score);
});

test("floor: already met moves nothing and writes nothing", () => {
  const recent = { ...SUDAN, id: "sd", published_at: iso(2), topics: ["world"] };
  const pool = poolOf([...AI, recent]);
  const off = rankPages(pool, profile((p) => { p.standing_stories = []; }), NOW);
  assert.ok(ids(off.today).indexOf("sd") < 15, "the fixture puts it in the zone by score");
  const on = rankPages(pool, profile(), NOW);
  assert.deepEqual(ids(on.today), ids(off.today));
  assert.deepEqual(on.today.flatMap((s) => entries(s)), []);
});

test("floor: two standing stories never push each other out, nor the must-know or exploration placements", () => {
  // Israel and Gaza already sits 15th by score; Sudan must be placed without pushing it to 16.
  const articles = [...AI.slice(0, 14), GAZA("gz", 1.2, { topics: ["ai", "conflict"] }), ...AI.slice(14), SUDAN];
  const pages = rankPages(poolOf(articles), profile(), NOW);
  const top = ids(pages.today).slice(0, 15);
  assert.ok(top.includes("gz") && top.includes("sd"), top.join(" "));
  // With exploration and must-know placements in the zone, neither is displaced.
  const eligible = [art("mk1", "l1", 20, ["world"]), art("mk2", "r1", 20, ["world"])];
  const clusters = [{ id: "mk", article_ids: ["mk1", "mk2"], independent_sources: 2, lean_buckets: ["left", "right"], lead: "mk1" }];
  const busyPool = poolOf([...AI, ...eligible, SUDAN], clusters);
  const before = rankPages(busyPool, profile((p) => { p.standing_stories = []; }), NOW).today;
  const busy = rankPages(busyPool, profile(), NOW).today;
  const placed = before.filter((s) => s.passes.some((e) => ["must-know", "exploration"].includes(e.pass) && e.text.startsWith("Placed")));
  assert.ok(placed.length >= 3, "the fixture has must-know and exploration placements in the zone");
  for (const s of placed) assert.equal(ids(busy).indexOf(s.id), ids(before).indexOf(s.id), `${s.id} kept its place`);
  assert.ok(ids(busy).indexOf("sd") < 15);
});

test("mute wins over the floor, and a mute never raises a false silence alarm", () => {
  const pool = poolOf([...AI, SUDAN]);
  for (const edit of [(p) => { p.mutes.sources = ["dabanga"]; }]) {
    const pages = rankPages(pool, profile(edit), NOW, { buckets: BUCKETS, names: NAMES });
    assert.ok(!ids(pages.today).includes("sd"));
    assert.deepEqual(pages.today.flatMap((s) => entries(s)), []);
    // The pool still has Sudan coverage 30h old, inside the 36h threshold: no notice.
    assert.deepEqual(pages.notices.filter((n) => n.id === "sudan"), []);
  }
});

test("silence alarm: no qualifying story within the threshold and healthy sources is a gap in coverage", () => {
  const old = { ...SUDAN, published_at: iso(40.6) };
  const pages = rankPages(poolOf([...AI, old]), profile(), NOW, { buckets: BUCKETS, names: NAMES, health: {} });
  const sudan = pages.notices.find((n) => n.id === "sudan");
  assert.deepEqual(sudan, {
    id: "sudan", label: "Sudan", kind: "no-coverage", hours: 40,
    kicker: "Standing story · Sudan",
    head: "No new Sudan coverage in 40 hours",
    text: "Your 2 Sudan sources are answering, so this is a gap in coverage, not a broken feed.",
  });
  // The old story is still the newest Sudan coverage, and the floor still shows it.
  assert.ok(ids(pages.today).indexOf("sd") < 15);
  // Nothing at all in the pool: the hours are the pool's own span.
  const none = rankPages(poolOf(AI), profile(), NOW, { buckets: BUCKETS, names: NAMES });
  const gaza = none.notices.find((n) => n.id === "israel_gaza");
  assert.equal(gaza.head, "No Israel and Gaza coverage in the last 10 hours");
  assert.equal(gaza.text, "Your 1 Israel and Gaza source is answering, so this is a gap in coverage, not a broken feed.");
  // Inside the threshold: no notice.
  const fresh = rankPages(poolOf([...AI, { ...SUDAN, published_at: iso(35.9) }]), profile(), NOW, { buckets: BUCKETS });
  assert.deepEqual(fresh.notices.filter((n) => n.id === "sudan"), []);
});

test("silence alarm: failing sources say so, and which", () => {
  const old = { ...SUDAN, published_at: iso(40) };
  const health = { dabanga: { state: "http_error", runs: 4 }, reliefweb: { state: "parse_error", runs: 17 } };
  const pages = rankPages(poolOf([...AI, old]), profile(), NOW, { buckets: BUCKETS, names: NAMES, health });
  const sudan = pages.notices.find((n) => n.id === "sudan");
  assert.equal(sudan.kind, "sources-failing");
  assert.equal(sudan.head, "Your Sudan sources are failing");
  assert.equal(sudan.text, "No new Sudan coverage in 40 hours, and every Sudan source is failing: Radio Dabanga (HTTP errors, 4 fetches in a row) and ReliefWeb Sudan (unreadable feed, 17 fetches in a row).");
  // Some failing, some answering: still a coverage gap, and it names both.
  const partly = rankPages(poolOf([...AI, old]), profile(), NOW, { buckets: BUCKETS, names: NAMES, health: { reliefweb: health.reliefweb } });
  const p = partly.notices.find((n) => n.id === "sudan");
  assert.equal(p.kind, "no-coverage");
  assert.equal(p.text, "Radio Dabanga is answering; ReliefWeb Sudan (unreadable feed, 17 fetches in a row) is failing. None of your sources has run a new Sudan story.");
});

test("the field is optional, validated, editable, and in the ranking key", () => {
  const pool = poolOf([...AI, SUDAN]);
  const bare = profile((p) => { delete p.standing_stories; });
  assert.deepEqual(validateProfile(bare, SCHEMA), [], "a profile stored before S28 stays valid");
  assert.deepEqual(ids(rankPages(pool, bare, NOW).today), ids(rankPages(pool, profile(), NOW).today), "absent means the defaults");
  const bad = profile((p) => { p.standing_stories[1].floor_slots = 9; p.standing_stories[1].colour = "red"; });
  assert.equal(validateProfile(bad, SCHEMA).length, 2);
  assert.notEqual(profileKey(profile((p) => { p.standing_stories[1].silence_hours = 48; })), profileKey(profile()));
  // The owner can add one and switch one off.
  const edited = profile((p) => {
    p.standing_stories[1].enabled = false;
    p.standing_stories.push({ id: "myanmar", label: "Myanmar", enabled: true, keywords: ["myanmar"], tags: [], buckets: [], floor_slots: 1, floor_within: 10, silence_hours: 0 });
  });
  assert.deepEqual(validateProfile(edited, SCHEMA), []);
  const pages = rankPages(poolOf([...AI, SUDAN, art("mm", "x", 30, ["conflict"], "Myanmar junta extends emergency rule")]), edited, NOW);
  assert.equal(ids(pages.today).indexOf("sd"), 21, "Sudan switched off: not placed");
  assert.deepEqual(entries(pages.today[9]), ["Placed by standing story: Myanmar, floor 1 in the top 10; moved from 21 to 10, the best Myanmar story below the floor on recency and importance alone"]);
  assert.deepEqual(pages.notices.map((n) => n.id), ["israel_gaza"], "silence_hours 0 turns the alarm off");
});

test("deterministic and order-blind, placements and notices alike", () => {
  const old = { ...SUDAN, published_at: iso(40) };
  const opts = { buckets: BUCKETS, names: NAMES, health: { reliefweb: { state: "timeout", runs: 3 } } };
  const pool = poolOf([...AI, old, GAZA("gz", 50)]);
  const a = rankPages(pool, profile(), NOW, opts);
  const b = rankPages(poolOf([...pool.articles].reverse()), profile(), NOW, { ...opts, buckets: Object.fromEntries(Object.entries(BUCKETS).reverse()) });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(a), JSON.stringify(rankPages(pool, profile(), NOW, opts)));
  assert.deepEqual(a.notices.map((n) => [n.id, n.kind, n.hours]), [["israel_gaza", "no-coverage", 50], ["sudan", "no-coverage", 40]]);
  // silenceNotices reads the pool as stories, whatever order they arrive in.
  const stories = storiesFromPool(pool);
  assert.deepEqual(silenceNotices([...stories].reverse(), profile(), Date.parse(NOW), opts), a.notices);
});
