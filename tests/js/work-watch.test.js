// B11: the work watch on the device. Rule matching (the parity cases shared with
// fetcher/workwatch.py), the ranker's tier term and the Biotech tab, the profile schema,
// the You-page edits, the interests sync (version 2, and taking seeded rules back), the
// Pages Function's version 2 and its keep-the-rules PUT, and the version 3 backup with
// its work-rules-only file. Every term here is an invented placeholder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { matchRule, storyWorkRules, workTag, workPayloadRules, rulesFromPayload, parseTerms, WORK_TIER_POINTS } from "../../app/static/js/work-watch.js";
import { rank, profileKey, canonical } from "../../app/static/js/ranker.js";
import { rankPages, pageOptions } from "../../app/static/js/passes.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { validateProfile } from "../../app/static/js/profile/validate.js";
import { MemoryStorage, ProfileStore, STORAGE_KEY } from "../../app/static/js/profile/store.js";
import {
  withWorkRuleAdded, withWorkRuleField, withWorkRuleRemoved, withWorkAdopted, workByTier, workStatus, commitEdit,
} from "../../app/static/js/profile/you-edits.js";
import { watchPayload, syncInterests, ENDPOINT } from "../../app/static/js/interests-sync.js";
import { validatePayload, storedValue, watchTag as fnWatchTag } from "../../functions/api/interests.js";
import { serializeBackup, serializeWorkBackup, BACKUP_VERSION } from "../../app/static/js/backup/serialize.js";
import { validateBackup } from "../../app/static/js/backup/validate.js";
import { withWorkImported, workImportMessage } from "../../app/static/js/backup/merge.js";
import { explainStory } from "../../app/static/js/why-this.js";

const NOW = "2026-09-27T12:00:00Z";
const ROOT = new URL("../../", import.meta.url);
const SCHEMA = JSON.parse(readFileSync(new URL("app/static/profile.schema.json", ROOT), "utf8"));
const PARITY = JSON.parse(readFileSync(new URL("tests/fixtures/work_watch_parity.json", ROOT), "utf8"));
const TERMS = ["zorbium", "quillase", "plovex", "vexamide", "blue quill"];

const rule = (id, tier, terms, extra = {}) => ({ id, label: `Label ${id}`, tier, terms, pair_any: [], exclude: [], exact: false, ...extra });
const RULES = [
  rule("w_one", 1, ["zorbium"]),
  rule("w_four", 4, ["vexamide"]),
  rule("w_pair", 2, ["fermentation"], { pair_any: ["precision"] }),
];
const withRules = (rules = RULES) => ({ ...buildDefaultProfile(NOW), work_watch: structuredClone(rules) });

// --- matching ---------------------------------------------------------------------

test("parity: every shared case answers as the fixture says (fetcher/workwatch.py runs the same file)", () => {
  assert.ok(PARITY.cases.length >= 20);
  for (const c of PARITY.cases) {
    assert.equal(matchRule(PARITY.rules[c.rule], c.texts), c.match, `${c.rule}: ${c.why}`);
  }
});

test("a rule's tag is w: and 10 hex of SHA-256 over work:<id>, as the function and the fetcher compute it", async () => {
  const want = `w:${createHash("sha256").update("work:w_one").digest("hex").slice(0, 10)}`;
  assert.equal(workTag("w_one"), want);
  assert.equal(await fnWatchTag("work:w_one"), want);
});

test("a story matches by its text or by the rule's tag, strongest tier first", () => {
  const story = { titles: ["Vexamide and zorbium news"], deks: [], watch: [] };
  assert.deepEqual(storyWorkRules(story, RULES).map((r) => r.id), ["w_one", "w_four"]);
  const tagged = { titles: ["A headline with no term"], deks: [], watch: [workTag("w_pair")] };
  assert.deepEqual(storyWorkRules(tagged, RULES).map((r) => r.id), ["w_pair"]);
  assert.deepEqual(storyWorkRules({ titles: ["Fermentation alone"], deks: [] }, RULES), []);
});

test("parseTerms: commas, semicolons and lines; quotes dropped; blanks, repeats and one-letter terms out", () => {
  assert.deepEqual(parseTerms('zorbium, "Blue Quill"; blue quill\n x ,, quillase'), ["zorbium", "Blue Quill", "quillase"]);
});

// --- ranker and the Biotech tab -------------------------------------------------------

function pool() {
  const art = (id, title, extra = {}) => ({
    id, source_id: "harbor", url: `https://harbor.example/${id}`, title, dek: "", published_at: "2026-09-27T10:00:00Z",
    topics: [], geo: [], ...extra,
  });
  return {
    articles: [
      art("a_one", "Zorbium plant opens in the north"),
      art("a_four", "Vexamide supply grows"),
      art("a_bio", "Yeast strain news", { topics: ["biotech"] }),
      art("a_none", "Harbor ferry timetable changes"),
      art("a_tag", "A quiet headline", { watch: [workTag("w_pair")] }),
    ],
    clusters: [],
  };
}

test("ranker: a work match adds one `work` term named by the rule's label, never its terms; tier 1 lifts most", () => {
  const ranked = rank(pool(), withRules(), NOW);
  const one = ranked.find((s) => s.id === "a_one");
  const four = ranked.find((s) => s.id === "a_four");
  const none = ranked.find((s) => s.id === "a_none");
  const term = one.explanation.find((t) => t.term === "work");
  assert.equal(term.value, WORK_TIER_POINTS[1] * 1_000_000);
  assert.equal(term.detail, "Label w_one");
  assert.equal(four.explanation.find((t) => t.term === "work").value, WORK_TIER_POINTS[4] * 1_000_000);
  assert.ok(!none.explanation.some((t) => t.term === "work"));
  for (const s of ranked) {
    assert.equal(s.score, s.explanation.reduce((a, t) => a + t.value, 0), "the score is still the exact sum");
    const details = JSON.stringify(s.explanation);
    for (const t of TERMS) assert.ok(!details.toLowerCase().includes(t), "no term in an explanation");
  }
  assert.ok(ranked.findIndex((s) => s.id === "a_one") < ranked.findIndex((s) => s.id === "a_four"));
});

test("Biotech tab: the biotech tag or any work rule match, ranked with the tier lift", () => {
  const pages = rankPages(pool(), withRules(), NOW, pageOptions({}));
  const biotech = pages.sections.find((s) => s.id === "biotech").stories.map((s) => s.id);
  assert.deepEqual([...biotech].sort(), ["a_bio", "a_four", "a_one", "a_tag"]);
  assert.equal(biotech[0], "a_one", "tier 1 first");
  const plain = rankPages(pool(), buildDefaultProfile(NOW), NOW, pageOptions({}));
  assert.deepEqual(plain.sections.find((s) => s.id === "biotech").stories.map((s) => s.id), ["a_bio"], "without rules, B10's tag alone");
});

test("profileKey: unchanged for a profile without rules (the page's key), changed by any rule edit", () => {
  const base = buildDefaultProfile(NOW);
  const legacy = canonical([base.topics, base.trust, base.boosts, base.mutes, base.seen_penalty, base.passes, base.standing_stories]);
  assert.equal(profileKey(base), legacy);
  assert.equal(profileKey({ ...base, work_watch: [] }), legacy);
  assert.notEqual(profileKey(withRules()), legacy);
  const gate = readFileSync(new URL("app/static/js/rank-gate.js", ROOT), "utf8");
  assert.ok(gate.includes("p.work_watch.length) fields.push(p.work_watch)"), "rank-gate.js keys work rules the same way");
});

test("why-this names the rule by its label", async () => {
  const { rows } = explainStory(rank(pool(), withRules(), NOW).find((s) => s.id === "a_one"), withRules(), Date.parse(NOW));
  const row = rows.find((r) => r.term === "work");
  assert.equal(row.label, "Work watch: Label w_one");
});

// --- schema and edits ----------------------------------------------------------------

test("schema: rules validate; a bad tier, an empty or quoted term and a repeated id are refused", () => {
  assert.deepEqual(validateProfile(withRules(), SCHEMA), []);
  const bad = (edit) => { const p = withRules(); edit(p.work_watch); return validateProfile(p, SCHEMA); };
  assert.ok(bad((w) => { w[0].tier = 5; }).length);
  assert.ok(bad((w) => { w[0].terms = []; }).length);
  assert.ok(bad((w) => { w[0].terms = ['a "quoted" term']; }).length);
  assert.ok(bad((w) => { w[1].id = "w_one"; }).some((e) => e.includes("duplicate rule id")));
  assert.ok(bad((w) => { w[0].terms = ["--"]; }).some((e) => e.includes("letter or digit")));
  assert.ok(bad((w) => { w[0].extra = 1; }).length);
});

test("edits: add at tier 2, change each field, remove; nothing-changes is null; adopt only into a profile without rules", () => {
  const base = buildDefaultProfile(NOW);
  assert.equal(workStatus(base, { label: "", terms: "zorbium" }).reason, "name");
  assert.equal(workStatus(base, { label: "Zed", terms: "" }).reason, "terms");
  const added = withWorkRuleAdded(base, { label: "Zed news", terms: "zorbium, blue quill" });
  assert.deepEqual(added.work_watch, [{ id: "w_zed_news", label: "Zed news", tier: 2, terms: ["zorbium", "blue quill"], pair_any: [], exclude: [], exact: false }]);
  assert.equal(workStatus(added, { label: "zed NEWS", terms: "x1" }).reason, "duplicate");
  let p = withWorkRuleField(added, "w_zed_news", "tier", "1");
  p = withWorkRuleField(p, "w_zed_news", "pair_any", "precision, industrial");
  p = withWorkRuleField(p, "w_zed_news", "exclude", "brewquor");
  p = withWorkRuleField(p, "w_zed_news", "exact", true);
  p = withWorkRuleField(p, "w_zed_news", "label", "Zed");
  assert.deepEqual(p.work_watch[0], { id: "w_zed_news", label: "Zed", tier: 1, terms: ["zorbium", "blue quill"], pair_any: ["precision", "industrial"], exclude: ["brewquor"], exact: true });
  assert.equal(withWorkRuleField(p, "w_zed_news", "tier", 1), null);
  assert.equal(withWorkRuleField(p, "w_zed_news", "tier", 9), null);
  assert.equal(withWorkRuleField(p, "nope", "tier", 2), null);
  assert.deepEqual(validateProfile({ ...p, profile_version: 2 }, SCHEMA), []);
  assert.deepEqual(workByTier(withRules()).map((g) => g.tier), [1, 2, 4]);
  assert.deepEqual(withWorkRuleRemoved(p, "w_zed_news").work_watch, []);
  assert.equal(withWorkAdopted(p, RULES), null, "the phone's own list wins");
  assert.deepEqual(withWorkAdopted(base, RULES).work_watch, RULES);
  assert.deepEqual(withWorkAdopted(base, RULES).topics, base.topics);
});

// --- the interests sync ------------------------------------------------------------------

test("sync payload: version 1 without a work_watch field, version 2 with one (even empty), each rule tagged", async () => {
  const base = buildDefaultProfile(NOW);
  assert.equal((await watchPayload(base)).v, 1);
  assert.deepEqual((await watchPayload({ ...base, work_watch: [] })).work, []);
  const body = await watchPayload(withRules());
  assert.equal(body.v, 2);
  assert.deepEqual(body.work.map((r) => r.tag), RULES.map((r) => workTag(r.id)));
  assert.deepEqual(body.work, workPayloadRules(withRules()));
  const checked = await validatePayload(body);
  assert.equal(checked.ok, true, checked.error);
  assert.deepEqual(rulesFromPayload(checked.value.work), RULES);
});

test("sync: a profile without rules takes seeded ones from the server, then sends them as its own", async () => {
  const storage = new MemoryStorage();
  const store = new ProfileStore({ storage, schema: SCHEMA, seedDefault: buildDefaultProfile, now: () => NOW });
  store.current();
  const seeded = await watchPayload(withRules());
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.method, init.body]);
    if (init.method === "GET") return { ok: true, json: async () => seeded };
    return { ok: true };
  };
  const adopt = (rules) => {
    const result = commitEdit(store, (p) => withWorkAdopted(p, rules));
    return result && result.ok ? result.profile : null;
  };
  assert.equal(await syncInterests({ storage, fetchImpl, adopt, now: () => 0 }), "sent");
  assert.deepEqual(store.current().work_watch, RULES);
  assert.deepEqual(calls.map((c) => c[1]), ["GET", "PUT"]);
  assert.equal(JSON.parse(calls[1][2]).v, 2);
  calls.length = 0;
  await syncInterests({ storage, fetchImpl, adopt, now: () => 1 });
  assert.ok(!calls.some((c) => c[1] === "GET"), "no more reads once the profile has its own list");
  assert.equal(calls.length, 0, "and nothing new to send");
  assert.equal(ENDPOINT, "/api/interests");
});

test("sync: a failed or empty server read changes nothing and still sends version 1", async () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ history: [{ version: 1, timestamp: NOW, profile: buildDefaultProfile(NOW) }] }));
  let adopted = 0;
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (init.method === "GET") return { ok: false, status: 302 };
    bodies.push(JSON.parse(init.body));
    return { ok: true };
  };
  await syncInterests({ storage, fetchImpl, adopt: () => { adopted++; return null; }, now: () => 0 });
  assert.equal(adopted, 0);
  assert.equal(bodies[0].v, 1);
});

// --- the Pages Function ------------------------------------------------------------------

test("function: version 2 is checked in full; version 1 keeps stored rules, version 2 replaces them", async () => {
  const body = await watchPayload(withRules());
  const ok = await validatePayload(body);
  assert.equal(ok.ok, true);
  const bad = async (edit) => { const b = structuredClone(body); edit(b); return (await validatePayload(b)).ok; };
  assert.equal(await bad((b) => { b.work[0].tag = b.work[1].tag; }), false, "a tag of another rule");
  assert.equal(await bad((b) => { b.work[0].tier = 0; }), false);
  assert.equal(await bad((b) => { b.work[0].terms = ["x"]; }), false);
  assert.equal(await bad((b) => { b.work[0].terms = ['say "hi"']; }), false);
  assert.equal(await bad((b) => { b.work[0].secret = 1; }), false);
  assert.equal(await bad((b) => { b.work = Array.from({ length: 41 }, () => b.work[0]); }), false);
  assert.equal(await bad((b) => { b.work.push(b.work[0]); }), false, "a rule twice");
  assert.equal(await bad((b) => { b.v = 1; }), false, "version 1 has no work field");
  const stored = JSON.stringify(ok.value);
  const v1 = { v: 1, queries: [] };
  assert.deepEqual(storedValue(stored, v1), { v: 2, queries: [], work: ok.value.work });
  assert.deepEqual(storedValue(null, v1), v1);
  assert.deepEqual(storedValue(stored, { v: 2, queries: [], work: [] }), { v: 2, queries: [], work: [] });
});

// --- backup version 3 ---------------------------------------------------------------------

test("backup: version 3 carries the rules; a work-only file replaces only the rules; versions 1 and 2 still import", () => {
  assert.equal(BACKUP_VERSION, 3);
  const mine = { ...withRules(), topics: { ...buildDefaultProfile(NOW).topics, p_harbor: { label: "harbor", phrase: "harbor", affinity: 0.6, half_life_hours: 24, enabled: true } } };
  const full = serializeBackup({ profile: mine, saved: [], history: { opened: [], shown: [] }, now: NOW });
  const back = validateBackup(JSON.parse(JSON.stringify(full)), SCHEMA);
  assert.equal(back.ok, true, back.errors?.[0]);
  assert.deepEqual(back.data.profile, mine, "a whole backup round-trips the rules");

  const incoming = [rule("w_new", 3, ["quillase"], { exact: true })];
  const file = JSON.parse(JSON.stringify(serializeWorkBackup({ rules: incoming, now: NOW })));
  assert.deepEqual(Object.keys(file).sort(), ["exported_at", "format_version", "profile", "scope"]);
  const checked = validateBackup(file, SCHEMA);
  assert.equal(checked.ok, true, checked.errors?.[0]);
  assert.equal(checked.data.scope, "work_watch");
  const after = withWorkImported(mine, checked.data.profile.work_watch);
  assert.deepEqual(after.work_watch, incoming);
  const { work_watch: _a, ...restAfter } = after;
  const { work_watch: _b, ...restBefore } = mine;
  assert.deepEqual(restAfter, restBefore, "every other interest stays exactly as it was");
  assert.equal(workImportMessage(mine, incoming), "Replace your 3 work watch rules with 1 from the file? Your other interests stay as they are.");

  const refuse = (edit) => { const f = structuredClone(file); edit(f); return validateBackup(f, SCHEMA).ok; };
  assert.equal(refuse((f) => { f.saved = []; }), false, "a work file carries nothing else");
  assert.equal(refuse((f) => { f.profile.topics = {}; }), false);
  assert.equal(refuse((f) => { f.profile.work_watch[0].tier = 7; }), false);
  assert.equal(refuse((f) => { f.scope = "other"; }), false);
  assert.equal(refuse((f) => { f.format_version = 2; }), false, "a scope needs version 3");

  for (const version of [1, 2]) {
    const old = { ...serializeBackup({ profile: buildDefaultProfile(NOW), saved: [], history: { opened: [], shown: [] }, now: NOW }), format_version: version };
    if (version === 1) delete old.archives;
    assert.equal(validateBackup(old, SCHEMA).ok, true, `version ${version} still imports`);
  }
});

test("backup: a work-only file with no rules clears them, and importing the same rules again changes nothing", () => {
  const mine = withRules();
  assert.deepEqual(withWorkImported(mine, []).work_watch, []);
  assert.equal(withWorkImported(mine, structuredClone(RULES)), null);
});
