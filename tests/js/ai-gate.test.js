// S19 proof: the AI proposal gate, the rejection ledger, and apply-through-ProfileStore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  gateProposal, deriveWhitelist, MAX_PATHS, REASONS,
} from "../../app/static/js/ai/gate.js";
import { RejectionLedger, LEDGER_KEY, LEDGER_CAP } from "../../app/static/js/ai/ledger.js";
import { submitProposal, applyApprovedProposal } from "../../app/static/js/ai/review.js";
import { ProfileStore, MemoryStorage, STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { diffProfiles } from "../../app/static/js/profile/diff.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf-8");
const PROFILE_SCHEMA = JSON.parse(read("../../app/static/profile.schema.json"));
const PROPOSAL_SCHEMA = JSON.parse(read("../../app/static/proposal.schema.json"));
const SCHEMAS = { profileSchema: PROFILE_SCHEMA, proposalSchema: PROPOSAL_SCHEMA };

function seedProfile(timestamp = "2026-09-24T00:00:00Z") {
  const profile = buildDefaultProfile(timestamp);
  profile.trust = { bbc: 1.2 };
  profile.boosts = [
    { id: "sudan", label: "Sudan", match_type: "keyword", match_value: "Sudan", amount: 0.3 },
    { id: "mk", label: "Must-know lift", match_type: "topic", match_value: "must_know", amount: 0.1 },
  ];
  return profile;
}

function proposal(changes, extra = {}) {
  return {
    schema_version: 1,
    id: "prop-0001",
    changes: structuredClone(changes),
    rationale: "You opened most AI stories this week and skipped few.",
    evidence: [{ kind: "signal", ref: "topic:ai:opened", count: 14 }],
    ...extra,
  };
}

const VALID = [
  { path: "$.topics.ai.affinity", old_value: 0.6, new_value: 0.7 },
  { path: "$.topics.ai.half_life_hours", old_value: 48, new_value: 36 },
];

function makeLedger(storage = new MemoryStorage()) {
  let tick = 0;
  return new RejectionLedger({ storage, now: () => `2026-09-24T01:00:${String(tick++ % 60).padStart(2, "0")}Z` });
}

function makeStore(storage = new MemoryStorage()) {
  let tick = 0;
  return new ProfileStore({
    storage,
    schema: PROFILE_SCHEMA,
    seedDefault: seedProfile,
    now: () => `2026-09-24T00:00:${String(tick++ % 60).padStart(2, "0")}Z`,
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Every named violation, with the proposal that triggers it and the reason it must get.
const VIOLATIONS = [
  ["off-whitelist path", proposal([{ path: "$.topics.ai.enabled", old_value: true, new_value: false }]), REASONS.OFF_WHITELIST],
  ["off-whitelist path (not in the schema at all)", proposal([{ path: "$.ranker.weight", old_value: 1, new_value: 2 }]), REASONS.OFF_WHITELIST],
  ["over-cap delta", proposal([{ path: "$.topics.ai.affinity", old_value: 0.6, new_value: 0.75 }]), REASONS.OVER_CAP],
  ["over-cap half-life", proposal([{ path: "$.topics.ai.half_life_hours", old_value: 48, new_value: 24 }]), REASONS.OVER_CAP],
  ["wrong type", proposal([{ path: "$.topics.ai.affinity", old_value: 0.6, new_value: true }]), REASONS.WRONG_TYPE],
  ["out of range", proposal([{ path: "$.seen_penalty.opened", old_value: 1, new_value: 1.05 }]), REASONS.OUT_OF_RANGE],
  ["too many paths", proposal([
    ...VALID,
    { path: "$.topics.world.affinity", old_value: 0.7, new_value: 0.75 },
    { path: "$.topics.singapore.affinity", old_value: 0.9, new_value: 0.95 },
  ]), REASONS.TOO_MANY_PATHS],
  ["malformed: missing rationale", (() => { const p = proposal(VALID); delete p.rationale; return p; })(), REASONS.MALFORMED],
  ["malformed: extra field", proposal(VALID, { apply_now: true }), REASONS.MALFORMED],
  ["malformed: not an object", "set ai to 0.9", REASONS.MALFORMED],
  ["malformed: no changes", proposal([]), REASONS.MALFORMED],
  ["malformed: markup in rationale", proposal(VALID, { rationale: "<img src=x onerror=alert(1)>" }), REASONS.MALFORMED],
  ["malformed: free text as evidence", proposal(VALID, { evidence: [{ kind: "article", ref: "Breaking: markets fall" }] }), REASONS.MALFORMED],
  ["malformed: prototype key", JSON.parse(JSON.stringify(proposal(VALID)).replace('"schema_version"', '"constructor":{},"schema_version"')), REASONS.MALFORMED],
  ["summary text", proposal([{ path: "$.topics.ai.label", old_value: "AI", new_value: "Today in AI: a model shipped and markets reacted." }]), REASONS.SUMMARY_TEXT],
  ["reserved: must-know", proposal([{ path: "$.topics.must_know.affinity", old_value: 0, new_value: 0.1 }]), REASONS.RESERVED_PATH],
  ["reserved: must-know floor", proposal([{ path: "$.topics.must_know.floor_slots", old_value: 2, new_value: 1 }]), REASONS.RESERVED_PATH],
  ["reserved: trust", proposal([{ path: "$.trust.bbc", old_value: 1.2, new_value: 1.1 }]), REASONS.RESERVED_PATH],
  ["reserved: standing stories", proposal([{ path: "$.standing_stories[sudan].floor_hours", old_value: 24, new_value: 48 }]), REASONS.RESERVED_PATH],
  ["reserved: exploration", proposal([{ path: "$.exploration_slots", old_value: 2, new_value: 0 }]), REASONS.RESERVED_PATH],
  ["reserved: live overrides (S33, R22 owner only)", proposal([{ path: "$.live_overrides.pinned_event_id", old_value: false, new_value: true }]), REASONS.RESERVED_PATH],
  ["reserved: boost on must-know", proposal([{ path: "$.boosts[mk].amount", old_value: 0.1, new_value: 0 }]), REASONS.RESERVED_PATH],
  ["unknown topic", proposal([{ path: "$.topics.sports.affinity", old_value: 0.5, new_value: 0.6 }]), REASONS.UNKNOWN_TARGET],
  ["unknown boost", proposal([{ path: "$.boosts[nope].amount", old_value: 0.1, new_value: 0.2 }]), REASONS.UNKNOWN_TARGET],
  ["prototype path", proposal([{ path: "$.topics.__proto__.affinity", old_value: 0.5, new_value: 0.6 }]), REASONS.UNKNOWN_TARGET],
  ["stale old value", proposal([{ path: "$.topics.ai.affinity", old_value: 0.5, new_value: 0.6 }]), REASONS.STALE_OLD_VALUE],
  ["duplicate path", proposal([VALID[0], { ...VALID[0], new_value: 0.65 }]), REASONS.DUPLICATE_PATH],
  ["no change", proposal([{ path: "$.topics.ai.affinity", old_value: 0.6, new_value: 0.6 }]), REASONS.NO_CHANGE],
];

test("the whitelist is derived from profile.schema.json: exactly these paths, ranges from the schema", () => {
  assert.deepEqual(deriveWhitelist(PROFILE_SCHEMA), [
    { pattern: "$.topics.*.affinity", type: "number", minimum: 0, maximum: 1, cap: 0.1 },
    { pattern: "$.topics.*.half_life_hours", type: "number", minimum: 1, maximum: 168, cap: 12 },
    { pattern: "$.boosts[*].amount", type: "number", minimum: -1, maximum: 1, cap: 0.2 },
    { pattern: "$.seen_penalty.opened", type: "number", minimum: 0, maximum: 1, cap: 0.1 },
    { pattern: "$.seen_penalty.shown", type: "number", minimum: 0, maximum: 1, cap: 0.1 },
  ]);
  assert.equal(MAX_PATHS, 3);
});

test("a schema edit flows into the whitelist, and a whitelisted path missing from the schema throws", () => {
  const narrowed = structuredClone(PROFILE_SCHEMA);
  narrowed.$defs.topic_setting.properties.affinity.maximum = 0.5;
  assert.equal(deriveWhitelist(narrowed)[0].maximum, 0.5);
  const verdict = gateProposal(seedProfile(), proposal([{ path: "$.topics.ai.affinity", old_value: 0.6, new_value: 0.55 }]),
    { profileSchema: narrowed, proposalSchema: PROPOSAL_SCHEMA });
  assert.equal(verdict.reason, REASONS.OUT_OF_RANGE, "0.55 is inside the cap but above the narrowed maximum");

  const missing = structuredClone(PROFILE_SCHEMA);
  delete missing.properties.seen_penalty;
  assert.throws(() => deriveWhitelist(missing), /seen_penalty.opened is not a leaf/);
});

test("a valid in-whitelist, in-cap proposal is accepted for review, not applied, not ledgered", () => {
  const profile = seedProfile();
  const before = JSON.stringify(profile);
  const ledger = makeLedger();
  const verdict = submitProposal(profile, proposal(VALID), { schemas: SCHEMAS, ledger });
  assert.equal(verdict.decision, "review");
  assert.equal(verdict.review.proposal_id, "prop-0001");
  assert.equal(verdict.review.based_on_version, 1);
  assert.deepEqual(verdict.review.changes, [
    { path: "$.topics.ai.affinity", before: 0.6, after: 0.7, delta: 0.1 },
    { path: "$.topics.ai.half_life_hours", before: 48, after: 36, delta: -12 },
  ]);
  assert.equal(JSON.stringify(profile), before, "accepting applies nothing");
  assert.equal(ledger.totals().total, 0);
});

test("boundary: a delta of exactly the cap passes despite float error, and boost amounts are writable", () => {
  const profile = seedProfile();
  const atCap = gateProposal(profile, proposal([
    { path: "$.topics.world.affinity", old_value: 0.7, new_value: 0.8 }, // 0.10000000000000009
    { path: "$.boosts[sudan].amount", old_value: 0.3, new_value: 0.5 },
    { path: "$.seen_penalty.shown", old_value: 0.25, new_value: 0.15 },
  ]), SCHEMAS);
  assert.equal(atCap.decision, "review", JSON.stringify(atCap));
});

for (const [name, bad, reason] of VIOLATIONS) {
  test(`rejected and ledgered: ${name} -> ${reason}`, () => {
    const ledger = makeLedger();
    const verdict = submitProposal(seedProfile(), bad, { schemas: SCHEMAS, ledger });
    assert.equal(verdict.decision, "reject");
    assert.equal(verdict.reason, reason, verdict.detail);
    assert.ok(verdict.detail, "every rejection carries a detail");
    const [entry] = ledger.entries();
    assert.equal(entry.reason, reason);
    assert.deepEqual(ledger.totals(), { total: 1, by_reason: { [reason]: 1 } });
  });
}

test("invalid_result: the gate will not stage an edit against a profile that is itself invalid", () => {
  const broken = seedProfile();
  delete broken.mutes;
  const verdict = gateProposal(broken, proposal(VALID), SCHEMAS);
  assert.equal(verdict.reason, REASONS.INVALID_RESULT);
});

test("summary text is rejected as summary_text whatever field it targets", () => {
  const text = "In summary, three outlets reported the ceasefire held overnight.";
  const paths = [
    ["$.topics.ai.affinity", 0.6], ["$.topics.ai.label", "AI"], ["$.boosts[sudan].label", "Sudan"],
    ["$.boosts[sudan].match_value", "Sudan"], ["$.trust.bbc", 1.2], ["$.summary", ""],
    ["$.topics.must_know.label", "Must-know"],
  ];
  const ledger = makeLedger();
  for (const [path, old] of paths) {
    const verdict = submitProposal(seedProfile(), proposal([{ path, old_value: old, new_value: text }]), { schemas: SCHEMAS, ledger });
    assert.equal(verdict.reason, REASONS.SUMMARY_TEXT, path);
  }
  assert.deepEqual(ledger.totals(), { total: paths.length, by_reason: { summary_text: paths.length } });
});

test("the gate never mutates its inputs, on accept or on any reject", () => {
  const profile = deepFreeze(seedProfile());
  const schemas = deepFreeze(structuredClone(SCHEMAS));
  const snapshot = JSON.stringify(profile);
  for (const candidate of [proposal(VALID), ...VIOLATIONS.map(([, p]) => p)]) {
    const frozen = deepFreeze(structuredClone(candidate));
    const proposalSnapshot = JSON.stringify(frozen);
    gateProposal(profile, frozen, schemas); // strict-mode module: a write to a frozen object throws
    assert.equal(JSON.stringify(frozen), proposalSnapshot);
  }
  assert.equal(JSON.stringify(profile), snapshot);
});

test("the review item holds its own copy, so a later edit to the proposal cannot change what was approved", () => {
  const input = proposal(VALID);
  const { review } = gateProposal(seedProfile(), input, SCHEMAS);
  input.changes[0].new_value = 1;
  assert.equal(review.proposal.changes[0].new_value, 0.7);
});

test("applying an approved proposal creates exactly one new profile version, and revert restores the prior one", () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  const ledger = makeLedger(storage);
  const prior = store.current();
  assert.deepEqual(store.history().map((h) => h.version), [1]);

  const staged = submitProposal(prior, proposal(VALID), { schemas: SCHEMAS, ledger });
  assert.equal(staged.decision, "review", JSON.stringify(staged));
  const { review } = staged;
  assert.deepEqual(store.history().map((h) => h.version), [1], "staging for review saves nothing");

  const applied = applyApprovedProposal(store, review, { schemas: SCHEMAS, ledger });
  assert.equal(applied.ok, true, applied.detail);
  assert.equal(applied.version, 2);
  assert.equal(applied.previous_version, 1);
  assert.deepEqual(store.history().map((h) => h.version), [2, 1], "exactly one new version");
  assert.deepEqual(
    diffProfiles(store.getVersion(1), store.getVersion(2)).map((c) => [c.path, c.before, c.after]),
    [["$.topics.ai.affinity", 0.6, 0.7], ["$.topics.ai.half_life_hours", 48, 36]],
  );

  const reverted = store.revert(applied.previous_version);
  assert.equal(reverted.ok, true);
  assert.deepEqual(diffProfiles(prior, store.current()), [], "revert restores the prior content");
  assert.equal(ledger.totals().total, 0);
  // The ledger sits next to the profile in the same device storage.
  assert.ok(storage.getItem(STORAGE_KEY));
});

test("apply re-gates: if the owner edited the field since staging, the item is refused and ledgered, nothing saved", () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  const ledger = makeLedger(storage);
  const { review } = submitProposal(store.current(), proposal(VALID), { schemas: SCHEMAS, ledger });

  const draft = store.current();
  draft.topics.ai.affinity = 0.65;
  assert.equal(store.save(draft).ok, true);

  const applied = applyApprovedProposal(store, review, { schemas: SCHEMAS, ledger });
  assert.equal(applied.ok, false);
  assert.equal(applied.reason, REASONS.STALE_OLD_VALUE);
  assert.deepEqual(store.history().map((h) => h.version), [2, 1]);
  assert.equal(ledger.entries()[0].reason, REASONS.STALE_OLD_VALUE);
});

test(`the ledger keeps the newest ${LEDGER_CAP} entries and counts every rejection ever made`, () => {
  const storage = new MemoryStorage();
  const ledger = makeLedger(storage);
  const verdict = { decision: "reject", reason: REASONS.OVER_CAP, detail: "x", path: "$.topics.ai.affinity" };
  for (let i = 0; i < LEDGER_CAP + 5; i += 1) {
    ledger.record(proposal(VALID, { id: `prop-${String(i).padStart(4, "0")}` }), verdict);
  }
  const entries = ledger.entries();
  assert.equal(entries.length, LEDGER_CAP);
  assert.equal(entries[0].proposal_id, `prop-${String(LEDGER_CAP + 4).padStart(4, "0")}`, "newest first");
  assert.equal(entries[entries.length - 1].proposal_id, "prop-0005", "oldest five evicted");
  assert.deepEqual(ledger.totals(), { total: LEDGER_CAP + 5, by_reason: { over_cap: LEDGER_CAP + 5 } });
  assert.deepEqual(Object.keys(entries[0]).sort(), ["at", "detail", "path", "paths", "proposal_id", "reason"]);
});

test("the ledger stores no model text and bounds every field, even for a hostile malformed proposal", () => {
  const ledger = makeLedger();
  const hostile = { id: "x".repeat(5000), changes: [{ path: "y".repeat(5000) }], rationale: "z".repeat(5000) };
  submitProposal(seedProfile(), hostile, { schemas: SCHEMAS, ledger });
  const [entry] = ledger.entries();
  assert.equal(entry.reason, REASONS.MALFORMED);
  assert.ok(entry.proposal_id.length <= 64 && entry.paths[0].length <= 200 && entry.detail.length <= 300);
  assert.ok(!JSON.stringify(entry).includes("zzz"), "rationale is never stored");
});

test("a corrupt ledger in storage starts over instead of breaking the gate", () => {
  const storage = new MemoryStorage();
  storage.setItem(LEDGER_KEY, "{not json");
  const ledger = makeLedger(storage);
  submitProposal(seedProfile(), proposal([]), { schemas: SCHEMAS, ledger });
  assert.deepEqual(ledger.totals(), { total: 1, by_reason: { malformed_proposal: 1 } });
});

test("no network anywhere in the ai package", () => {
  for (const file of ["gate.js", "ledger.js", "review.js"]) {
    const source = read(`../../app/static/js/ai/${file}`);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\s*\(|https?:\/\//, file);
  }
});
