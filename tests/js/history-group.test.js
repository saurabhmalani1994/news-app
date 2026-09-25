// S34 proof: day grouping ("Today", "Yesterday", then dates, newest first) and the Seen
// filter's merge (opened always, shown only when asked, never duplicating a story that
// is both).
import { test } from "node:test";
import assert from "node:assert/strict";

import { DAY_MS, groupHistoryByDay, historyDayLabel, visibleHistory } from "../../app/static/js/history/group.js";

const NOW = Date.parse("2026-09-24T15:00:00Z"); // a Thursday, UTC
const TZ = { timeZone: "UTC" };

test("historyDayLabel: today, yesterday, then a plain date", () => {
  assert.equal(historyDayLabel(Date.parse("2026-09-24T02:00:00Z"), NOW, TZ), "Today");
  assert.equal(historyDayLabel(Date.parse("2026-09-23T23:00:00Z"), NOW, TZ), "Yesterday");
  assert.equal(historyDayLabel(Date.parse("2026-09-20T10:00:00Z"), NOW, TZ), "Sept. 20");
});

test("historyDayLabel names the year once it is not the current one", () => {
  assert.equal(historyDayLabel(Date.parse("2025-09-20T10:00:00Z"), NOW, TZ), "Sept. 20, 2025");
});

test("groupHistoryByDay: newest day first, newest record first within a day", () => {
  const records = [
    { id: "a", time: "2026-09-24T01:00:00Z" }, // today, earlier
    { id: "b", time: "2026-09-24T10:00:00Z" }, // today, later
    { id: "c", time: "2026-09-23T12:00:00Z" }, // yesterday
    { id: "d", time: "2026-09-20T12:00:00Z" }, // a plain date
  ];
  const groups = groupHistoryByDay(records, NOW, TZ);
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Yesterday", "Sept. 20"]);
  assert.deepEqual(groups[0].records.map((r) => r.id), ["b", "a"]);
  assert.deepEqual(groups[1].records.map((r) => r.id), ["c"]);
  assert.deepEqual(groups[2].records.map((r) => r.id), ["d"]);
});

test("groupHistoryByDay keeps a record with an unparsable time, under its own group", () => {
  const groups = groupHistoryByDay([{ id: "bad", time: "not a date" }], NOW, TZ);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Unknown");
  assert.deepEqual(groups[0].records.map((r) => r.id), ["bad"]);
});

test("a day boundary a full day's milliseconds wide is still Yesterday, not Today or older", () => {
  assert.equal(historyDayLabel(NOW - DAY_MS, NOW, TZ), "Yesterday");
});

test("visibleHistory: opened rows always show, tagged kind opened", () => {
  const opened = [{ id: "a", time: "t1" }];
  const rows = visibleHistory(opened, [{ id: "b", time: "t2" }], { seen: false });
  assert.deepEqual(rows, [{ id: "a", time: "t1", kind: "opened" }]);
});

test("visibleHistory: Seen on adds shown-but-never-opened rows, tagged kind shown", () => {
  const opened = [{ id: "a", time: "t1" }];
  const shown = [{ id: "a", time: "t0" }, { id: "b", time: "t2" }];
  const rows = visibleHistory(opened, shown, { seen: true });
  assert.deepEqual(rows.map((r) => [r.id, r.kind]), [["a", "opened"], ["b", "shown"]]);
});

test("visibleHistory: a story that is both opened and shown never appears twice", () => {
  const rows = visibleHistory([{ id: "a", time: "t1" }], [{ id: "a", time: "t0" }], { seen: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "opened");
});
