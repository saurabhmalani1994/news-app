// U1: the device side of summaries on every row and of the reader opening any cluster
// member with full text: which member (lead, then trust, then length), the credit line,
// the dek each tier takes, and the display.summaries profile field.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { bestMember, creditLine } from "../../app/static/js/reader/core.js";
import { dekFor } from "../../app/static/js/tiers.js";
import { STARTER_DISPLAY, buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { validateProfile } from "../../app/static/js/profile/validate.js";

const schema = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));
const CANDS = [["a1", "npr", 900, "https://x/1"], ["a2", "axios", 3000, "https://x/2"], ["a3", "bbc", 5000, "https://x/3"]];

test("bestMember opens the lead when it has a body, whatever else is longer or trusted", () => {
  assert.equal(bestMember(CANDS, "a1", { bbc: 2 }), "a1");
});

test("bestMember without the lead prefers the most trusted outlet, then the longest body", () => {
  assert.equal(bestMember(CANDS, "zz"), "a3");
  assert.equal(bestMember(CANDS, "zz", {}), "a3");
  assert.equal(bestMember(CANDS, "zz", { axios: 1.6 }), "a2");
  assert.equal(bestMember(CANDS, "zz", { bbc: 0.4, axios: 0.9 }), "a1"); // unset trust reads as 1.0
  assert.equal(bestMember(CANDS, "zz", { npr: 2 }), "a1");
});

test("bestMember breaks a full tie on the lowest id and matches the build's rule", () => {
  assert.equal(bestMember([["b2", "s", 10, "u"], ["b1", "t", 10, "u"]], "zz"), "b1");
  assert.equal(bestMember([], "a1"), null);
  assert.equal(bestMember(undefined, "a1"), null);
  assert.equal(bestMember([["../etc", "s", 10, "u"]], "zz"), null); // never an unsafe id
});

test("creditLine names the other outlet only when it differs from the card's", () => {
  assert.equal(creditLine("axios", "npr", "Axios"), "Full text from Axios");
  assert.equal(creditLine("npr", "npr", "NPR"), "");
  assert.equal(creditLine("axios", "", "Axios"), "");
  assert.equal(creditLine("axios", "npr", ""), "");
});

test("dekFor gives every tier its fitted dek from [hero, lead block, row]", () => {
  assert.equal(dekFor(["H.", "L.", "R."], "hero"), "H.");
  assert.equal(dekFor(["H.", "L.", "R."], "secondary"), "L.");
  assert.equal(dekFor(["H.", "L.", "R."], "river"), "R.");
  assert.equal(dekFor(["H.", "L.", "R."], "text-only"), "R.");
  assert.equal(dekFor(["H.", "L."], "river"), "L."); // trailing repeat dropped by the build
  assert.equal(dekFor(["Same."], "text-only"), "Same.");
  assert.equal(dekFor(undefined, "river"), "");
});

test("display.summaries defaults to all, accepts top, refuses anything else", () => {
  assert.deepEqual(STARTER_DISPLAY, { summaries: "all" });
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.deepEqual(profile.display, { summaries: "all" });
  assert.equal(validateProfile(profile, schema).length, 0);
  assert.equal(validateProfile({ ...profile, display: { summaries: "top" } }, schema).length, 0);
  const { display, ...older } = profile;
  assert.equal(validateProfile(older, schema).length, 0); // optional: stored profiles stay valid
  assert.equal(validateProfile({ ...profile, display: { summaries: "some" } }, schema).length > 0, true);
  assert.equal(validateProfile({ ...profile, display: { summaries: "all", extra: 1 } }, schema).length > 0, true);
});
