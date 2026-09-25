// R2 proof: the build (app/rank_cli.mjs) and every device caller of rankPages read the
// same options from the page's embedded input (passes.js pageOptions), so the device
// re-rank of the default profile lands on the order the page was built in. The device
// re-rank once dropped `events`, so H4's per-event repeat cap ran at build and not on
// the phone: rerank_cls.mjs's finalMatchesRanker went false on a real pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { rankPages, pageOptions } from "../../app/static/js/passes.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const NOW = "2026-09-24T12:00:00Z";
const iso = (hoursAgo) => new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
const CLI = fileURLToPath(new URL("../../app/rank_cli.mjs", import.meta.url));
const ids = (list) => list.map((s) => s.id);

/** The shape app/frontpage.py hands rank_cli and embeds as #rank-input: 15 stories, the
 * first three of the top 12 in one event, so the cap moves the third one down. */
function input() {
  const articles = [];
  for (let i = 0; i < 15; i++) {
    const id = `s${String(i).padStart(2, "0")}`;
    articles.push({ id, source_id: `src${i}`, title: `Regional report number ${i} from desk ${"abcdefghijklmno"[i]}`, published_at: iso(i * 2), topics: ["ai"] });
  }
  return {
    pool: { generated_at: NOW, articles, clusters: [] }, now: NOW,
    buckets: {}, leans: {}, names: {}, health: {},
    events: [{ id: "e1", label: "Ridge wildfire", cluster_ids: ["s01", "s02", "s04"], live: false }],
  };
}

test("pageOptions carries every field the build ranks with, and adds the device's own", () => {
  const i = input();
  assert.deepEqual(Object.keys(pageOptions(i)).sort(), ["buckets", "bv", "events", "health", "leans", "names"]);
  assert.equal(pageOptions(i).events, i.events);
  assert.deepEqual(pageOptions({}), { buckets: {}, leans: {}, names: {}, health: {}, events: [], bv: {} });
  const terms = [() => 0];
  assert.equal(pageOptions(i, { terms }).terms, terms);
});

test("the build's order equals the device's for the default profile, the event cap included", () => {
  const i = input();
  const built = JSON.parse(execFileSync(process.execPath, [CLI], { input: JSON.stringify(i) }).toString("utf8"));
  const device = rankPages(i.pool, buildDefaultProfile(NOW), NOW, pageOptions(i)).today;
  assert.deepEqual(built.ranked.map((r) => r.id), ids(device));
  // B5: and each story's face, which app/frontpage.py holds its own pick to.
  assert.deepEqual(built.faces, rankPages(i.pool, buildDefaultProfile(NOW), NOW, pageOptions(i)).faces);
  // The fixture does exercise the cap: without events the order differs.
  const blind = rankPages(i.pool, buildDefaultProfile(NOW), NOW, { ...pageOptions(i), events: [] }).today;
  assert.notDeepEqual(ids(blind), ids(device));
  assert.ok(device.find((s) => s.id === "s04").passes.some((e) => e.pass === "repeat-cap"));
});

test("every rankPages caller on the device takes its options from pageOptions", () => {
  for (const file of ["rerank.js", "tabs.js", "live-actions.js", "story-actions.js"]) {
    const src = readFileSync(new URL(`../../app/static/js/${file}`, import.meta.url), "utf-8");
    const calls = [...src.matchAll(/rankPages\(([^;]*?)\);/gs)].map((m) => m[1]);
    assert.ok(calls.length > 0, file);
    for (const call of calls) assert.match(call, /pageOptions\(input/, `${file}: ${call}`);
  }
});
