// J26: the reserve on the phone: which topics a profile change raised, which files to
// load, merging them into the ranking input once, and the toast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { raisedTopics, tagsFor, loadReserve, mergeReserve, addedMessage, relativeAge } from "../../app/static/js/reserve.js";

const topics = (o) => Object.fromEntries(Object.entries(o).map(([id, a]) => [id, { label: id, affinity: a, enabled: true }]));

test("a raised topic is a higher level, a new topic boost, or an unmuted topic; a mute wins", () => {
  const before = { topics: topics({ singapore: 0.5, ai: 0.6, world: 0.7 }), boosts: [], mutes: { topics: ["world"] } };
  const after = {
    topics: topics({ singapore: 0.8, ai: 0.6, world: 0.7, industrial_biotech: 0.5 }),
    boosts: [{ id: "boost-topic-ai", match_type: "topic", match_value: "ai" }], mutes: { topics: [] },
  };
  assert.deepEqual(raisedTopics(before, after), ["ai", "industrial_biotech", "singapore", "world"]);
  assert.deepEqual(raisedTopics(after, { ...after, mutes: { topics: ["ai"] } }), []);
  assert.deepEqual(raisedTopics(after, { ...after, topics: topics({ singapore: 0.6, ai: 0.6, world: 0.7, industrial_biotech: 0.5 }) }), [], "lower is not raised");
});

test("a topic reads its own file, else the tags the ranker maps to it", () => {
  assert.deepEqual(tagsFor("singapore", { singapore: 3, biotech: 2 }), ["singapore"]);
  assert.deepEqual(tagsFor("industrial_biotech", { biotech: 2 }), ["biotech"]);
  assert.deepEqual(tagsFor("sport", { biotech: 2 }), []);
});

function fakeFetch(files) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = files[url.split("?")[0]];
    return body ? { ok: true, redirected: false, json: async () => body } : { ok: false, redirected: false };
  };
  return { fetchImpl, calls };
}

test("the reserve loads only for the page's own edition, and only the raised topics' files", async () => {
  const rec = (id) => ({ id, source_id: "st", title: `T ${id}`, url: `https://st.example/${id}`, published_at: "2026-09-30T01:00:00Z", topics: ["singapore"], dek: "d" });
  const { fetchImpl, calls } = fakeFetch({
    "reserve/index.json": { generated_at: "E1", shards: { singapore: 2, world: 1 } },
    "reserve/singapore.json": { articles: [rec("r1"), rec("r2"), rec("r1")] },
  });
  const got = await loadReserve(["singapore"], "E1", { fetchImpl });
  assert.deepEqual(got.records.map((r) => r.id), ["r1", "r2"]);
  assert.deepEqual(calls, ["reserve/index.json", "reserve/singapore.json?v=E1"]);
  assert.deepEqual((await loadReserve(["singapore"], "E0", { fetchImpl })).records, [], "another edition's reserve is ignored");
  const input = { pool: { articles: [{ id: "r2" }], clusters: [] }, coverage: {} };
  assert.deepEqual(mergeReserve(input, got.records), ["r1"], "an article the page has is not added twice");
  assert.deepEqual(input.pool.articles[1], { id: "r1", source_id: "st", title: "T r1", published_at: "2026-09-30T01:00:00Z", topics: ["singapore"] });
  assert.deepEqual(input.deks.r1, ["d"]);
  assert.deepEqual(mergeReserve(input, got.records), [], "merging again adds nothing");
});

test("the toast and the age read as the build writes them", () => {
  assert.equal(addedMessage(6, ["Singapore"]), "Added 6 Singapore stories from earlier today.");
  assert.equal(addedMessage(1, ["AI", "World"]), "Added 1 story from earlier today.");
  assert.equal(relativeAge("2026-09-30T09:00:00Z", Date.parse("2026-09-30T12:00:00Z")), "3h ago");
});
