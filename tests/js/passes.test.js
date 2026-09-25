// S13 proof: each post-pass alone does exactly its job on a fixture built to trigger it
// and nothing else; the passes compose in the stated order; a muted source or topic
// never appears on any page; the other-side link comes from the lean least represented
// on the page and says so; must-know stories reach the floor per R16 however low they
// score; the pages are deterministic and order-blind; and every story a pass moved,
// removed or placed carries that pass's own named entry.
import { test } from "node:test";
import assert from "node:assert/strict";

import { rank } from "../../app/static/js/ranker.js";
import { rankPages, applyPasses, PASS_ORDER, TODAY_PASSES, SECTION_PASSES, PASS_DEFAULTS } from "../../app/static/js/passes.js";
import { SECTIONS, inSection } from "../../app/static/js/sections.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { validateProfile } from "../../app/static/js/profile/validate.js";
import { readFileSync } from "node:fs";

const NOW = "2026-09-24T12:00:00Z";
const SCHEMA = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));
const iso = (hoursAgo) => new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
const art = (id, source_id, hoursAgo, topics, title = `Headline for story ${id}`) => ({ id, source_id, title, published_at: iso(hoursAgo), topics });
const clu = (id, article_ids, independent_sources, lean_buckets, lead) => ({ id, article_ids, independent_sources, lean_buckets, ...(lead ? { lead } : {}) });
const poolOf = (articles, clusters = []) => ({ generated_at: NOW, articles, clusters });
const profile = (edit = () => {}) => { const p = buildDefaultProfile(NOW); edit(p); return p; };
const ids = (list) => list.map((s) => s.id);
const passNames = (list) => [...new Set(list.flatMap((s) => s.passes.map((e) => e.pass)))].sort();

// A story set that triggers nothing: three unclustered, non-hard-news stories from
// sources of no listed lean. Each fixture below adds exactly its own trigger.
const QUIET = [art("q1", "s1", 1, ["ai"]), art("q2", "s2", 2, ["ai"]), art("q3", "s3", 3, ["ai"])];

test("the stated order, and which pages run which passes", () => {
  assert.deepEqual(PASS_ORDER, ["mute", "dedup", "repeat-cap", "lean-quota", "exploration", "other-side", "must-know", "standing-story"]);
  assert.deepEqual(TODAY_PASSES, PASS_ORDER.slice(2));
  assert.deepEqual(SECTION_PASSES, ["lean-quota", "other-side"]);
  assert.deepEqual(PASS_DEFAULTS.lean_quota, { window: 10, max_share: 0.6 });
  assert.deepEqual([...PASS_DEFAULTS.exploration.positions], [4, 14, 24]);
});

test("a quiet fixture: no pass touches anything, the page is the score order", () => {
  const pages = rankPages(poolOf(QUIET), profile(), NOW);
  assert.deepEqual(ids(pages.today), ["q1", "q2", "q3"]);
  assert.deepEqual(passNames(pages.today), []);
  assert.deepEqual(pages.removed, []);
});

test("mute alone: a muted source and a muted topic are removed, each saying why, nothing else moves", () => {
  const pool = poolOf([...QUIET, art("m1", "loud", 0.5, ["ai"]), art("m2", "s4", 0.2, ["singapore", "asia"])]);
  const p = profile((x) => { x.mutes = { sources: ["loud"], topics: ["singapore"] }; });
  const pages = rankPages(pool, p, NOW, { names: { loud: "Loud Daily" } });
  assert.deepEqual(ids(pages.today), ["q1", "q2", "q3"]);
  // The stories below moved up two places, and say which pass did it.
  assert.deepEqual(pages.today.map((s) => s.passes.map((e) => e.text)), [1, 2, 3].map((n) => [`Moved up by mute: from ${n + 2} to ${n}, a muted story above it was removed`]));
  assert.deepEqual(passNames(pages.today), ["mute"]);
  const why = Object.fromEntries(pages.removed.map((s) => [s.id, s.passes.map((e) => e.text)]));
  assert.deepEqual(why, { m2: ["Removed by mute: the topic singapore is muted"], m1: ["Removed by mute: the source Loud Daily is muted"] });
  // The ranker scored them above q1: mute is a filter after scoring, not a score.
  assert.deepEqual(ids(rank(pool, p, NOW)).slice(0, 2), ["m2", "m1"]);
});

test("mute: a many-outlet story stays when one member is muted, goes when its lead is", () => {
  const arts = [art("x1", "a", 1, ["ai"]), art("x2", "muted", 1, ["ai"]), art("x3", "c", 1, ["ai"])];
  const keep = rankPages(poolOf(arts, [clu("c1", ["x1", "x2", "x3"], 3, [], "x1")]), profile((x) => { x.mutes.sources = ["muted"]; }), NOW);
  assert.deepEqual(ids(keep.today), ["c1"]);
  const drop = rankPages(poolOf(arts, [clu("c1", ["x1", "x2", "x3"], 3, [], "x2")]), profile((x) => { x.mutes.sources = ["muted"]; }), NOW);
  assert.deepEqual(ids(drop.today), []);
});

test("dedup alone: the same headline twice keeps the fuller story and names the twin", () => {
  const same = "Parliament passes the new budget after a long night";
  const pool = poolOf([...QUIET.slice(0, 2), art("d1", "s5", 0.1, ["ai"], same), art("d2", "s6", 0.2, ["ai"], same.toUpperCase() + "!")]);
  const pages = rankPages(pool, profile(), NOW);
  assert.deepEqual(ids(pages.today), ["d1", "q1", "q2"]);
  assert.deepEqual(pages.removed.map((s) => [s.id, s.passes.map((e) => e.pass)]), [["d2", ["dedup"]]]);
  assert.match(pages.removed[0].passes[0].text, /^Removed by dedup: .*story d1/);
  assert.deepEqual(pages.today.map((s) => s.passes.map((e) => e.text)), [[], ["Moved up by dedup: from 3 to 2, a duplicate above it was removed"], ["Moved up by dedup: from 4 to 3, a duplicate above it was removed"]]);
  assert.deepEqual(passNames(pages.today), ["dedup"]);
});

test("repeat cap alone: at most 2 cards per S32 event, and a headline twin, held to the top 12", () => {
  // 15 singleton stories, all the same topic, one hour apart so score order is exactly
  // creation order (s00 newest/highest through s14 oldest/lowest). s01/s02/s04 share one
  // S32 event (only 2 of the three may stay in the top 12); s05 and s06 are unrelated to
  // any event but their headlines share the same rare proper noun and topic word.
  const titles = {
    s01: "Wildfire crews reach the ridge by nightfall",
    s02: "State parks close ahead of the holiday weekend",
    s04: "Ferry service resumes after the harbor repair",
    s05: "Vaneswaran unveils a downtown stadium proposal",
    s06: "City council reviews Vaneswaran's stadium proposal",
  };
  const arts = [];
  for (let i = 0; i < 15; i++) {
    const id = `s${String(i).padStart(2, "0")}`;
    arts.push(art(id, `src${i}`, i * 2, ["ai"], titles[id] || `Regional report number ${i} filed overnight`));
  }
  const events = [{ id: "e1", label: "Ridge wildfire", cluster_ids: ["s01", "s02", "s04"] }];
  const { list } = applyPasses(["mute", "dedup", "repeat-cap"], poolOf(arts), profile(), NOW, { events });
  assert.deepEqual(ids(list), [
    "s00", "s01", "s02", "s03", "s05", "s07", "s08", "s09", "s10", "s11", "s12", "s13", "s04", "s06", "s14",
  ]);
  const by = Object.fromEntries(list.map((s) => [s.id, s.passes.filter((e) => e.pass === "repeat-cap")]));
  assert.equal(by.s04.length, 1);
  assert.match(by.s04[0].text, /^Moved down by repeat cap: from 5 to 13, 2 cards from this event \(Ridge wildfire\) already in the top 12$/);
  assert.equal(by.s06.length, 1);
  assert.match(by.s06[0].text, /^Moved down by repeat cap: from 7 to 14, shares most rare headline words with story s05 already in the top 12$/);
  // Collateral shifts (cards pulled up to fill the freed places) are named too, but not
  // as a repeat-cap move of their own.
  assert.match(list.find((s) => s.id === "s05").passes.find((e) => e.pass === "repeat-cap").text, /^Moved up by repeat cap: from 6 to 5/);
  // s14 never moves: it was last before the cap and stays last after it.
  assert.deepEqual(list.find((s) => s.id === "s14").passes.filter((e) => e.pass === "repeat-cap"), []);
});

test("repeat cap alone: a page of 12 or fewer never has anywhere to push a card down to", () => {
  const arts = [];
  for (let i = 0; i < 12; i++) arts.push(art(`s${i}`, `src${i}`, i, ["ai"]));
  const events = [{ id: "e1", label: "Test", cluster_ids: ["s0", "s1", "s2"] }];
  const { list } = applyPasses(["mute", "dedup", "repeat-cap"], poolOf(arts), profile(), NOW, { events });
  assert.deepEqual(ids(list), arts.map((a) => a.id));
  assert.deepEqual(passNames(list), []);
});

test("lean quota alone: a card is held back while its lean would pass the cap, both moves named", () => {
  const leans = { s1: "left", s2: "left", s3: "right" };
  const p = profile((x) => { x.passes.lean_quota = { window: 3, max_share: 0.34 }; });
  const pages = rankPages(poolOf(QUIET), p, NOW, { leans });
  assert.deepEqual(ids(pages.today), ["q1", "q3", "q2"]);
  const by = Object.fromEntries(pages.today.map((s) => [s.id, s.passes.map((e) => `${e.pass}: ${e.text}`)]));
  assert.deepEqual(by.q1, []);
  assert.match(by.q2[0], /^lean-quota: Moved down by lean quota: from 2 to 3, 1 of the 2 cards above its place were already left; at most 1 of any 3 from one lean$/);
  assert.match(by.q3[0], /^lean-quota: Moved up by lean quota: from 3 to 2/);
  assert.deepEqual(passNames(pages.today), ["lean-quota"]);
});

test("lean quota at the design default: no lean above 6 of any 10 cards while another lean can fill", () => {
  const arts = [];
  const leans = {};
  for (let i = 0; i < 30; i++) {
    const src = `src${i}`;
    leans[src] = i < 22 ? "right" : "left"; // 22 right-leaning cards score first
    arts.push(art(`r${String(i).padStart(2, "0")}`, src, i * 0.1, ["ai"]));
  }
  const { list } = applyPasses(["lean-quota"], poolOf(arts), profile(), NOW, { leans });
  const lean = list.map((s) => leans[s.source_ids[0]]);
  for (let i = 0; i + 10 <= 20; i++) {
    assert.ok(lean.slice(i, i + 10).filter((l) => l === "right").length <= 6, `window at ${i}`);
  }
});

test("exploration alone: slot 4 takes the best story below it on recency and importance only", () => {
  // Four followed-topic stories 6h old outscore a fresh story on an unfollowed topic;
  // with affinity zeroed the fresh one is best, so it takes slot 4.
  const arts = [art("f1", "s1", 6, ["ai"]), art("f2", "s2", 6.1, ["ai"]), art("f3", "s3", 6.2, ["ai"]), art("f4", "s4", 6.3, ["ai"]), art("fresh", "s5", 0, ["sports"])];
  const pages = rankPages(poolOf(arts), profile(), NOW);
  assert.deepEqual(ids(rank(poolOf(arts), profile(), NOW)), ["f1", "f2", "f3", "f4", "fresh"]);
  assert.deepEqual(ids(pages.today), ["f1", "f2", "f3", "fresh", "f4"]);
  const fresh = pages.today[3].passes;
  assert.equal(fresh.length, 1);
  assert.match(fresh[0].text, /^Placed by exploration in slot 4 from 5: best on recency and importance alone, affinity and boosts zeroed \(no followed topic\)$/);
  assert.match(pages.today[4].passes[0].text, /^Moved down by exploration: from 4 to 5/);
  assert.deepEqual(passNames(pages.today), ["exploration"]);
});

test("other side alone: the attached link comes from the lean least represented on the page, and says so", () => {
  const leans = { lead_l: "left", o_r: "right", o_c: "center", s4: "left", s6: "center" };
  const arts = [
    art("a1", "lead_l", 1, ["ai"]), art("a2", "o_r", 2, ["ai"]), art("a3", "o_c", 1.5, ["ai"]),
    art("b1", "s4", 0.5, ["ai"]), art("b2", "s6", 0.7, ["ai"]),
  ];
  const pool = poolOf(arts, [clu("c1", ["a1", "a2", "a3"], 3, ["center", "left", "right"], "a1")]);
  const pages = rankPages(pool, profile(), NOW, { leans, names: { o_r: "Right Review" } });
  // Page lean mix: left 2 (c1 leads with a left outlet, b1), center 1, right 0.
  const c1 = pages.today.find((s) => s.id === "c1");
  assert.deepEqual(c1.other_side, { article_id: "a2", source_id: "o_r", lean: "right" });
  assert.equal(c1.passes.length, 1);
  assert.match(c1.passes[0].text, /^Other side attached: Right Review \(right\) on this story, the least represented lean in this page's first 10 cards \(0 of 3\); the card itself leads with left$/);
  assert.deepEqual(ids(pages.today), ids(rank(pool, profile(), NOW)), "nothing moves");
  assert.deepEqual(passNames(pages.today), ["other-side"]);
  // A muted outlet is never the other side: the next least represented lean serves.
  const muted = rankPages(pool, profile((x) => { x.mutes.sources = ["o_r"]; }), NOW, { leans });
  assert.equal(muted.today.find((s) => s.id === "c1").other_side.source_id, "o_c");
  // Under 3 independent sources, no link.
  const thin = rankPages(poolOf(arts, [clu("c1", ["a1", "a2", "a3"], 2, ["center", "left", "right"], "a1")]), profile(), NOW, { leans });
  assert.equal(thin.today.find((s) => s.id === "c1").other_side, undefined);
});

test("must-know alone: an R16-eligible story reaches the floor however low it scores", () => {
  // Hard news (conflict) from a left and a right outlet, 20h old: it scores last.
  const leansOf = { l: "left", r: "right" };
  const arts = [art("q1", "s1", 1, ["ai"]), art("q2", "s2", 2, ["ai"]), art("m1", "l", 20, ["conflict"]), art("m2", "r", 21, ["conflict"])];
  const pool = poolOf(arts, [clu("mk", ["m1", "m2"], 2, ["left", "right"], "m1")]);
  const scored = rank(pool, profile(), NOW);
  assert.deepEqual(ids(scored), ["q1", "q2", "mk"]);
  assert.equal(scored[2].must_know, true);
  const pages = rankPages(pool, profile(), NOW, { leans: leansOf });
  assert.deepEqual(ids(pages.today), ["mk", "q1", "q2"]);
  assert.equal(pages.today[0].passes[0].text, "Placed by must-know from 3: conflict news from 2 outlets across left and right");
  assert.match(pages.today[1].passes[0].text, /^Moved down by must-know: from 1 to 2/);
  assert.deepEqual(passNames(pages.today), ["must-know"]);
  // Same story from one lean bucket (syndication breadth alone): not eligible, not placed.
  const oneLean = rankPages(poolOf(arts, [clu("mk", ["m1", "m2"], 2, ["left"], "m1")]), profile(), NOW);
  assert.deepEqual(ids(oneLean.today), ["q1", "q2", "mk"]);
  // Section tabs have no floor: the front page does.
  assert.deepEqual(passNames(pages.sections.flatMap((s) => s.stories)), []);
  // floor_slots 0 turns it off.
  const off = rankPages(pool, profile((x) => { x.topics.must_know.floor_slots = 0; }), NOW);
  assert.deepEqual(ids(off.today), ["q1", "q2", "mk"]);
});

// A pool that triggers every pass at once, for composition, mutes and determinism.
function busyPool() {
  const leans = {};
  const articles = [];
  const clusters = [];
  const LEANS = ["left", "right", "center", "non-us", "left", "left", "left"];
  const TAGS = [["ai"], ["world", "conflict"], ["singapore", "asia"], ["us_politics", "politics"], ["biotech"], ["sports"], ["economy"]];
  for (let i = 0; i < 70; i++) {
    const src = `s${i % 14}`;
    leans[src] = LEANS[i % LEANS.length];
    articles.push(art(`a${String(i).padStart(3, "0")}`, src, (i * 13) % 40, TAGS[i % TAGS.length], i === 69 ? "Headline for story a068" : undefined));
  }
  articles.push(art("dup", "s3", 1, ["ai"], "A duplicated wire headline, word for word"), art("dup2", "s5", 2, ["ai"], "A duplicated wire headline, word for word"));
  // S28: one old, single-outlet Sudan story from a source of no listed lean, scored far
  // below the top 15, so the standing-story floor has something to place.
  articles.push(art("sd1", "sdn", 39.5, ["world", "conflict"], "Sudan: aid convoy reaches El Fasher after months of siege"));
  for (let c = 0; c < 6; c++) {
    const members = [0, 1, 2, 3].map((k) => `a${String(c * 4 + k).padStart(3, "0")}`);
    const bucketSet = [...new Set(members.map((id) => leans[`s${Number(id.slice(1)) % 14}`]))].sort();
    clusters.push(clu(`c${c}`, members, 3 + (c % 2), bucketSet, members[0]));
  }
  // H4 item 1: an S32 event across 3 of the top-ranked clusters, so repeat-cap has a
  // third card to push down (the event's own cluster_ids, only 2 per event allowed).
  const events = [{ id: "e0", label: "Busy event", cluster_ids: ["c5", "c0", "c3"] }];
  return { pool: poolOf(articles, clusters), leans, buckets: { s2: "singapore", s3: "us_politics", s1: "general" }, events };
}

test("every pass runs on the busy fixture, and entries appear in the stated order", () => {
  const { pool, leans, buckets, events } = busyPool();
  const pages = rankPages(pool, profile((x) => { x.mutes.sources = ["s13"]; }), NOW, { leans, buckets, events });
  const seen = new Set([...pages.today, ...pages.removed].flatMap((s) => s.passes.map((e) => e.pass)));
  assert.deepEqual([...seen].sort(), [...PASS_ORDER].sort());
  for (const s of pages.today) {
    const order = s.passes.map((e) => PASS_ORDER.indexOf(e.pass));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), s.id);
  }
});

test("the passes compose in the stated order: rankPages equals running them one by one", () => {
  const { pool, leans, buckets } = busyPool();
  const p = profile((x) => { x.mutes.topics = ["industrial_biotech"]; });
  const pages = rankPages(pool, p, NOW, { leans, buckets });
  const oneByOne = applyPasses(PASS_ORDER, pool, p, NOW, { leans });
  assert.deepEqual(ids(pages.today), ids(oneByOne.list));
  assert.deepEqual(pages.today.map((s) => s.passes), oneByOne.list.map((s) => s.passes));
  // Order matters. Mute runs before dedup, so a muted story never takes its unmuted
  // twin with it: "dup" (newer, so the fuller twin) is muted and "dup2" stays. Dedup
  // first would drop dup2 as dup's twin, then mute would drop dup: both gone.
  const muteDup = profile((x) => { x.mutes.sources = ["s3"]; });
  assert.ok(ids(rankPages(pool, muteDup, NOW, { leans, buckets }).today).includes("dup2"));
  const swapped = applyPasses(["dedup", "mute", ...TODAY_PASSES], pool, muteDup, NOW, { leans });
  assert.ok(!ids(swapped.list).includes("dup2"));
});

test("a muted source or topic never appears, on any page or in any other-side link", () => {
  const { pool, leans, buckets } = busyPool();
  for (const [sources, topics] of [[["s0", "s7"], []], [[], ["ai"]], [["s2"], ["us_politics", "singapore"]]]) {
    const p = profile((x) => { x.mutes = { sources, topics }; });
    const pages = rankPages(pool, p, NOW, { leans, buckets });
    const byId = new Map(pool.articles.map((a) => [a.id, a]));
    const leadSource = (s) => byId.get(pool.clusters.find((c) => c.id === s.id)?.lead || s.article_ids[0]).source_id;
    const mapped = (t) => ({ politics: "us_politics", biotech: "industrial_biotech" })[t] || t;
    for (const page of [pages.today, ...pages.sections.map((s) => s.stories)]) {
      for (const s of page) {
        assert.ok(!sources.includes(leadSource(s)), `${s.id} fronted by a muted source`);
        assert.ok(!s.topics.some((t) => topics.includes(t) || topics.includes(mapped(t))), `${s.id} carries a muted topic`);
        if (s.other_side) assert.ok(!sources.includes(s.other_side.source_id), `${s.id} other side is muted`);
      }
    }
    assert.ok(pages.removed.length > 0);
    for (const r of pages.removed) assert.ok(r.passes.some((e) => e.to === null && e.text.startsWith("Removed by")), r.id);
  }
});

test("deterministic and order-blind: same input, same pages, byte for byte", () => {
  const { pool, leans, buckets } = busyPool();
  const p = profile((x) => { x.mutes.sources = ["s4"]; });
  const once = JSON.stringify(rankPages(pool, p, NOW, { leans, buckets }));
  assert.equal(JSON.stringify(rankPages(pool, p, NOW, { leans, buckets })), once);
  const shuffled = { ...pool, articles: [...pool.articles].reverse(), clusters: [...pool.clusters].reverse().map((c) => ({ ...c, article_ids: [...c.article_ids].reverse() })) };
  const leansShuffled = Object.fromEntries(Object.entries(leans).reverse());
  assert.equal(JSON.stringify(rankPages(shuffled, p, NOW, { leans: leansShuffled, buckets })), once);
});

test("every story whose place differs from its score order carries a pass entry, on every page", () => {
  const { pool, leans, buckets } = busyPool();
  for (const p of [profile(), profile((x) => { x.mutes.sources = ["s1"]; x.passes.lean_quota = { window: 5, max_share: 0.4 }; })]) {
    const scored = rank(pool, p, NOW);
    const pages = rankPages(pool, p, NOW, { leans, buckets });
    const check = (before, after) => {
      const was = new Map(before.map((id, i) => [id, i]));
      after.forEach((s, i) => { if (was.get(s.id) !== i) assert.ok(s.passes.length, `${s.id} moved ${was.get(s.id)} -> ${i} with no entry`); });
    };
    check(ids(scored), pages.today);
    for (const section of pages.sections) {
      const table = SECTIONS.find((s) => s.id === section.id);
      check(ids(scored.filter((s) => inSection(s, table, buckets))), section.stories);
    }
    const onPage = new Set(ids(pages.today));
    for (const s of scored) assert.ok(onPage.has(s.id) || pages.removed.some((r) => r.id === s.id), `${s.id} vanished unnamed`);
  }
});

test("section tabs: the same pool filtered, then that tab's own lean quota and other side", () => {
  const { pool, leans, buckets } = busyPool();
  const pages = rankPages(pool, profile(), NOW, { leans, buckets });
  for (const section of pages.sections) {
    const table = SECTIONS.find((s) => s.id === section.id);
    const kept = rank(pool, profile(), NOW).filter((s) => inSection(s, table, buckets) && !pages.removed.some((r) => r.id === s.id));
    assert.deepEqual(ids(section.stories).sort(), ids(kept).sort(), section.id);
    for (const s of section.stories) for (const e of s.passes) assert.ok(["lean-quota", "other-side", "mute", "dedup"].includes(e.pass), `${section.id} ${e.pass}`);
  }
  assert.deepEqual(pages.sections.find((s) => s.id === "live").stories, []);
});

test("the profile's passes block is optional, validated, and in the ranking key", async () => {
  const { profileKey } = await import("../../app/static/js/ranker.js");
  assert.deepEqual(validateProfile(profile(), SCHEMA), []);
  const bare = profile((x) => { delete x.passes; });
  assert.deepEqual(validateProfile(bare, SCHEMA), [], "a stored profile from before S13 stays valid");
  assert.deepEqual(ids(rankPages(busyPool().pool, bare, NOW).today), ids(rankPages(busyPool().pool, profile(), NOW).today), "absent means default");
  const bad = profile((x) => { x.passes.lean_quota.window = 1; x.passes.other = 1; });
  assert.equal(validateProfile(bad, SCHEMA).length, 2);
  assert.notEqual(profileKey(profile((x) => { x.passes.exploration.positions = [5]; })), profileKey(profile()));
});

test("the passes after the quota never undo it: the final page has no more over-quota windows than the quota left", () => {
  const { pool, leans, buckets } = busyPool();
  const over = (list, window = 10, cap = 6) => {
    let n = 0;
    for (let i = 0; i + window <= list.length; i++) {
      const c = {};
      for (const s of list.slice(i, i + window)) {
        const lead = pool.clusters.find((x) => x.id === s.id)?.lead || s.article_ids[0];
        const l = leans[pool.articles.find((a) => a.id === lead).source_id];
        if (l) c[l] = (c[l] || 0) + 1;
      }
      if (Object.values(c).some((v) => v > cap)) n += 1;
    }
    return n;
  };
  const afterQuota = applyPasses(["mute", "dedup", "lean-quota"], pool, profile(), NOW, { leans }).list;
  const final = rankPages(pool, profile(), NOW, { leans, buckets }).today;
  assert.ok(over(final) <= over(afterQuota), `${over(final)} > ${over(afterQuota)}`);
});
