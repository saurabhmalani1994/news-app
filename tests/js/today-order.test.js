// J22: Today's order switch: For you as ranked, Latest newest first, Urgent the last
// day's must-know and widely covered hard news first, then the rest as For you.
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderToday, urgentReason, readOrder, saveOrder, ORDER_KEY } from "../../app/static/js/today-order.js";

const H = 3600 * 1000;
const NOW = Date.parse("2026-09-30T12:00:00Z");
const story = (id, hoursAgo, extra = {}) => ({ id, latest_ms: NOW - hoursAgo * H, independent_sources: 1, must_know: false, ...extra });
const pool = {
  clusters: [{ id: "c_war", article_ids: ["w1", "w2"] }],
  articles: [{ id: "w1", jev: { hard: 0.9 } }, { id: "w2" }, { id: "soft", jev: { hard: 0.2 } }],
};
const stories = [
  story("fav", 10),
  story("new", 1),
  story("c_war", 5, { independent_sources: 6 }),
  story("mk", 20, { must_know: true }),
  story("old_mk", 30, { must_know: true }),
  story("soft", 2, { independent_sources: 5 }),
];

test("Latest follows the time the card shows, and a future date counts as now", () => {
  const pool2 = {
    clusters: [{ id: "c", lead: "c_lead", article_ids: ["c_lead", "c_new"] }],
    articles: [{ id: "c_lead", published_at: new Date(NOW - 9 * H).toISOString() }, { id: "c_new", published_at: new Date(NOW - H).toISOString() },
      { id: "x", published_at: new Date(NOW - 3 * H).toISOString() }, { id: "future", published_at: new Date(NOW + 5 * H).toISOString() }],
  };
  const list = [story("c", 1), story("x", 3), story("future", 0)];
  assert.deepEqual(orderToday(list, "latest", pool2, NOW).map((s) => s.id), ["future", "x", "c"], "the card shows c_lead, 9h old");
  assert.deepEqual(orderToday(list, "latest", pool2, NOW, { c: "c_new" }).map((s) => s.id), ["future", "c", "x"], "a re-fronted card");
});

test("For you keeps the ranker's order; Latest is newest first", () => {
  assert.deepEqual(orderToday(stories, "for_you", pool, NOW).map((s) => s.id), stories.map((s) => s.id));
  assert.deepEqual(orderToday(stories, "latest", pool, NOW).map((s) => s.id), ["new", "soft", "c_war", "fav", "mk", "old_mk"]);
});

test("Urgent puts the last day's must-know, then widely covered hard news, first", () => {
  assert.equal(urgentReason(stories[3], pool, NOW), "must_know");
  assert.equal(urgentReason(stories[2], pool, NOW), "jev", "Jev reads it as hard news and 6 outlets cover it");
  assert.equal(urgentReason(stories[4], pool, NOW), null, "older than a day");
  assert.equal(urgentReason(stories[5], pool, NOW), null, "Jev reads it as not hard news");
  assert.deepEqual(orderToday(stories, "urgent", pool, NOW).map((s) => s.id), ["mk", "c_war", "fav", "new", "old_mk", "soft"]);
});

test("the order is kept on this phone, and anything unknown reads as For you", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  assert.equal(readOrder(storage), "for_you");
  saveOrder(storage, "urgent");
  assert.equal(readOrder(storage), "urgent");
  mem.set(ORDER_KEY, "loudest");
  assert.equal(readOrder(storage), "for_you");
  saveOrder(storage, "for_you");
  assert.equal(mem.has(ORDER_KEY), false);
});
