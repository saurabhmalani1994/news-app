// S19: the deterministic gate every AI-proposed profile edit passes through
// (DESIGN-v1.1 section 5). The AI only proposes; this gate either accepts a proposal
// for the owner's review or rejects it with one named reason. Nothing here applies a
// change, touches storage or the network. It is a pure function of (profile, proposal,
// schemas): inputs are never mutated, and the same inputs always give the same verdict.
//
// Article text is untrusted input, so the gate, not the prompt, is what makes a hostile
// headline harmless. Four rules do that:
//   1. Path whitelist: only the paths in AI_WRITABLE, and only those that exist as
//      leaves in profile.schema.json. Type and range come from the schema, so there is
//      one source of truth; the cap is the only number this file adds.
//   2. Reserved paths are refused outright even if a whitelist pattern would match:
//      must-know (R16), standing stories (R2), exploration and trust (R10, personal,
//      and the design never lets the AI touch it).
//   3. Delta caps: each numeric field moves at most its cap per proposal.
//   4. No text values anywhere (R13): an AI may not write a string into any field, so
//      there is no route for a model-written summary into the reading path.

import { validateSchema, validateProfile } from "../profile/validate.js";

/** At most this many paths per proposal. */
export const MAX_PATHS = 3;

/**
 * The only profile fields an AI proposal may touch, as schema leaf patterns, each with
 * its per-proposal delta cap. `*` is any key of an open object, `[*]` any id in an
 * id-keyed array (the form js/profile/diff.js already uses).
 */
export const AI_WRITABLE = Object.freeze({
  "$.topics.*.affinity": Object.freeze({ cap: 0.1 }),
  "$.topics.*.half_life_hours": Object.freeze({ cap: 12 }),
  "$.boosts[*].amount": Object.freeze({ cap: 0.2 }),
  "$.seen_penalty.opened": Object.freeze({ cap: 0.1 }),
  "$.seen_penalty.shown": Object.freeze({ cap: 0.1 }),
});

/**
 * Path segments no proposal may name, whatever else matches: the must-know topic and
 * its floor (R16), standing stories (R2), exploration slots, trust (R10), and the S33
 * Live tab overrides (R22, "the device only applies the owner's pins and blocks").
 * Standing stories and exploration are not in profile.schema.json yet; naming them
 * here means they are refused the day a later slice adds them, without anyone
 * remembering to.
 */
const RESERVED_SEGMENT = /^(must_know|floor_slots|trust|standing_stor(y|ies)|exploration(_[a-z_]+)?|live_overrides)$/;
const RESERVED_TOPICS = new Set(["must_know"]);

/** Keys that are never legitimate data and could reach a prototype. */
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

// Floating point slack for the cap compare only: 0.7 -> 0.8 is 0.10000000000000009.
const EPSILON = 1e-9;

export const REASONS = Object.freeze({
  MALFORMED: "malformed_proposal",
  TOO_MANY_PATHS: "too_many_paths",
  DUPLICATE_PATH: "duplicate_path",
  SUMMARY_TEXT: "summary_text",
  RESERVED_PATH: "reserved_path",
  OFF_WHITELIST: "off_whitelist_path",
  UNKNOWN_TARGET: "unknown_target",
  STALE_OLD_VALUE: "stale_old_value",
  WRONG_TYPE: "wrong_type",
  OUT_OF_RANGE: "out_of_range",
  NO_CHANGE: "no_change",
  OVER_CAP: "over_cap",
  INVALID_RESULT: "invalid_result",
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRef(root, node) {
  let current = node;
  while (isPlainObject(current) && typeof current.$ref === "string") {
    if (!current.$ref.startsWith("#/")) throw new Error(`only local refs are supported: ${current.$ref}`);
    let target = root;
    for (const part of current.$ref.slice(2).split("/")) target = target[part];
    current = target;
  }
  return current;
}

/** Every leaf of a schema as {pattern: node}, walking properties, open maps and items. */
function schemaLeaves(root) {
  const leaves = new Map();
  const walk = (node, pattern) => {
    const schema = resolveRef(root, node);
    if (!isPlainObject(schema)) return;
    let branched = false;
    if (isPlainObject(schema.properties)) {
      branched = true;
      for (const [key, child] of Object.entries(schema.properties)) walk(child, `${pattern}.${key}`);
    }
    if (isPlainObject(schema.additionalProperties)) {
      branched = true;
      walk(schema.additionalProperties, `${pattern}.*`);
    }
    if (isPlainObject(schema.items)) {
      branched = true;
      walk(schema.items, `${pattern}[*]`);
    }
    if (!branched) leaves.set(pattern, schema);
  };
  walk(root, "$");
  return leaves;
}

/**
 * The whitelist as rules, built from profile.schema.json: each AI_WRITABLE pattern must
 * be a numeric leaf in the schema, and takes its type, minimum and maximum from there.
 * Throws if the schema and AI_WRITABLE disagree, so a schema edit cannot quietly leave a
 * cap pointing at nothing or widen a range without the gate seeing it.
 */
export function deriveWhitelist(profileSchema) {
  const leaves = schemaLeaves(profileSchema);
  return Object.entries(AI_WRITABLE).map(([pattern, { cap }]) => {
    const leaf = leaves.get(pattern);
    if (!leaf) throw new Error(`AI_WRITABLE path ${pattern} is not a leaf in profile.schema.json`);
    if (leaf.type !== "number" && leaf.type !== "integer") {
      throw new Error(`AI_WRITABLE path ${pattern} must be numeric in profile.schema.json, is ${JSON.stringify(leaf.type)}`);
    }
    if (typeof leaf.minimum !== "number" || typeof leaf.maximum !== "number") {
      throw new Error(`AI_WRITABLE path ${pattern} needs a schema minimum and maximum`);
    }
    return Object.freeze({ pattern, type: leaf.type, minimum: leaf.minimum, maximum: leaf.maximum, cap });
  });
}

/** "$.boosts[x].amount" -> [{key: "boosts"}, {id: "x"}, {key: "amount"}]. */
export function parsePath(path) {
  const segments = [];
  const re = /\.([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)\]/g;
  let match;
  while ((match = re.exec(path)) !== null) {
    segments.push(match[1] !== undefined ? { key: match[1] } : { id: match[2] });
  }
  return segments;
}

function segmentName(segment) {
  return segment.key !== undefined ? segment.key : segment.id;
}

function matchesPattern(segments, pattern) {
  const want = parsePattern(pattern);
  if (want.length !== segments.length) return false;
  return want.every((w, i) => {
    const s = segments[i];
    if (w.key !== undefined) return s.key !== undefined && (w.key === "*" || w.key === s.key);
    return s.id !== undefined && (w.id === "*" || w.id === s.id);
  });
}

function parsePattern(pattern) {
  const segments = [];
  const re = /\.([A-Za-z0-9_*-]+)|\[([A-Za-z0-9_*-]+)\]/g;
  let match;
  while ((match = re.exec(pattern)) !== null) {
    segments.push(match[1] !== undefined ? { key: match[1] } : { id: match[2] });
  }
  return segments;
}

/** Walks own properties only, and arrays by their items' id field. Undefined if absent. */
export function readPath(root, segments) {
  let node = root;
  for (const segment of segments) {
    if (segment.id !== undefined) {
      if (!Array.isArray(node)) return undefined;
      node = node.find((item) => isPlainObject(item) && item.id === segment.id);
    } else {
      if (!isPlainObject(node) || !Object.hasOwn(node, segment.key)) return undefined;
      node = node[segment.key];
    }
    if (node === undefined) return undefined;
  }
  return node;
}

/** A deep copy of `profile` with each change's new_value written in. Never mutates input. */
export function applyChanges(profile, changes) {
  const next = structuredClone(profile);
  for (const change of changes) {
    const segments = parsePath(change.path);
    const parent = readPath(next, segments.slice(0, -1));
    const last = segments[segments.length - 1];
    if (!isPlainObject(parent) || last.key === undefined || !Object.hasOwn(parent, last.key)) {
      throw new Error(`cannot apply ${change.path}: target does not exist`);
    }
    parent[last.key] = change.new_value;
  }
  return next;
}

function hasForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (!isPlainObject(value)) return false;
  return Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key) || hasForbiddenKey(value[key]));
}

function typeOk(value, type) {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === "number" && Number.isFinite(value);
}

function roundDelta(value) {
  return Math.round(value * 1e9) / 1e9;
}

function reject(reason, detail, path = null) {
  return { decision: "reject", reason, detail, path };
}

/**
 * The gate. Returns either
 *   {decision: "review", review: {proposal_id, based_on_version, changes, proposal}}
 * where changes are display rows {path, before, after, delta} and proposal is a deep
 * copy, or
 *   {decision: "reject", reason, detail, path}
 * with reason one of REASONS. A "review" verdict applies nothing: it is a pending item
 * for the owner, saved only through review.js's applyApprovedProposal.
 *
 * @param {object} profile - the current profile (ProfileStore.current())
 * @param {unknown} proposal - untrusted; anything at all
 * @param {{profileSchema: object, proposalSchema: object}} schemas
 */
export function gateProposal(profile, proposal, { profileSchema, proposalSchema }) {
  if (!profileSchema || !proposalSchema) throw new Error("gateProposal needs both schemas");

  // Checked before the schema: validate.js resolves property names with `in`, which
  // sees Object.prototype, so a key named constructor would slip past a closed object.
  if (hasForbiddenKey(proposal)) {
    return reject(REASONS.MALFORMED, "proposal uses a reserved JavaScript key name");
  }
  const shapeErrors = validateSchema(proposal, proposalSchema);
  if (shapeErrors.length) return reject(REASONS.MALFORMED, shapeErrors.slice(0, 3).join("; "));

  const { changes } = proposal;
  if (changes.length > MAX_PATHS) {
    return reject(REASONS.TOO_MANY_PATHS, `${changes.length} paths, at most ${MAX_PATHS} per proposal`);
  }
  const seen = new Set();
  for (const change of changes) {
    if (seen.has(change.path)) return reject(REASONS.DUPLICATE_PATH, "a path may appear once per proposal", change.path);
    seen.add(change.path);
  }

  const whitelist = deriveWhitelist(profileSchema);
  const rows = [];
  for (const change of changes) {
    const { path, old_value: oldValue, new_value: newValue } = change;
    if (typeof newValue === "string") {
      return reject(REASONS.SUMMARY_TEXT, "a proposal may not write text into any field (R13)", path);
    }
    const segments = parsePath(path);
    if (segments.some((s) => RESERVED_SEGMENT.test(segmentName(s)))) {
      return reject(REASONS.RESERVED_PATH, "must-know, standing stories, exploration and trust are owner only", path);
    }
    const rule = whitelist.find((r) => matchesPattern(segments, r.pattern));
    if (!rule) return reject(REASONS.OFF_WHITELIST, "path is not on the AI whitelist", path);

    const current = readPath(profile, segments);
    if (current === undefined) return reject(REASONS.UNKNOWN_TARGET, "path does not exist in the current profile", path);
    if (segments[0].key === "boosts") {
      const boost = readPath(profile, segments.slice(0, 2));
      if (boost.match_type === "topic" && RESERVED_TOPICS.has(boost.match_value)) {
        return reject(REASONS.RESERVED_PATH, "a boost on the must-know topic is owner only", path);
      }
    }
    if (oldValue !== current) {
      return reject(REASONS.STALE_OLD_VALUE, `proposal saw ${JSON.stringify(oldValue)}, profile has ${JSON.stringify(current)}`, path);
    }
    if (!typeOk(newValue, rule.type)) {
      return reject(REASONS.WRONG_TYPE, `expected ${rule.type}, got ${typeof newValue}`, path);
    }
    if (newValue < rule.minimum || newValue > rule.maximum) {
      return reject(REASONS.OUT_OF_RANGE, `${newValue} is outside ${rule.minimum} to ${rule.maximum}`, path);
    }
    const delta = newValue - current;
    if (delta === 0) return reject(REASONS.NO_CHANGE, "new value equals the current value", path);
    if (Math.abs(delta) > rule.cap + EPSILON) {
      return reject(REASONS.OVER_CAP, `moves ${roundDelta(Math.abs(delta))}, cap is ${rule.cap} per proposal`, path);
    }
    rows.push({ path, before: current, after: newValue, delta: roundDelta(delta) });
  }

  // Defense in depth: the edited profile must still be a valid profile as a whole.
  const resultErrors = validateProfile(applyChanges(profile, changes), profileSchema);
  if (resultErrors.length) return reject(REASONS.INVALID_RESULT, resultErrors.slice(0, 3).join("; "));

  return {
    decision: "review",
    review: {
      proposal_id: proposal.id,
      based_on_version: profile.profile_version,
      changes: rows,
      proposal: structuredClone(proposal),
    },
  };
}
