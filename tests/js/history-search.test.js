// S34 proof: the History segment's local search, headline or outlet, case-insensitive,
// substring only. Nothing here ever reaches a network call; the point of the test is the
// matching rule, not that (the module has no I/O to fake).
import { test } from "node:test";
import assert from "node:assert/strict";

import { searchHistory } from "../../app/static/js/history/search.js";

const RECORDS = [
  { id: "a", title: "Singapore raises the flood barrier budget", source: "The Straits Times" },
  { id: "b", title: "City council approves transit budget", source: "NPR" },
  { id: "c", title: "Markets steady after the rate decision", source: "Reuters" },
];

test("an empty query returns every record, order kept", () => {
  assert.deepEqual(searchHistory(RECORDS, ""), RECORDS);
  assert.deepEqual(searchHistory(RECORDS, "   "), RECORDS);
});

test("matches a headline substring, case-insensitive", () => {
  assert.deepEqual(searchHistory(RECORDS, "BUDGET").map((r) => r.id), ["a", "b"]);
});

test("matches the outlet name too", () => {
  assert.deepEqual(searchHistory(RECORDS, "reuters").map((r) => r.id), ["c"]);
});

test("no match is an empty list, not an error", () => {
  assert.deepEqual(searchHistory(RECORDS, "cricket"), []);
});

test("a record with no title or source never throws", () => {
  assert.deepEqual(searchHistory([{ id: "z" }], "anything"), []);
});
