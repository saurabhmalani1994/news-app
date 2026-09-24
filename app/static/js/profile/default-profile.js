// S10: the shipped default profile, seeded from the owner's own words in
// docs/OWNER-BRIEF.md, not a generic template.
//
// Six starter buckets (OWNER-BRIEF "Interests"): us_politics, singapore, ai,
// industrial_biotech, world, must_know. must_know's affinity is zeroed by design
// (DESIGN-v1.1 section 9 item 2, OWNER-BRIEF derived): it is a guaranteed floor, not a
// subject the owner ranked highly, and its eligibility (R16, hard news plus a lean
// spread) is enforced by the ranker, not by this weight.
//
// Half-lives are DESIGN-v1.1 section 4's proposed values (R18): 8h for world, US
// politics and must-know; 12h for Singapore; 48h for AI and industrial biotech, since
// work reading happens in batches.
//
// Affinity is a 0 to 1 weight. Singapore is set highest: it is the source layer's own
// acceptance test (R4, "if the Singapore bucket is thin or stale, the app has failed at
// the thing he most specifically asked for"), so the starter profile should not bury it
// under a low weight while the fetcher side proves itself out.

import { nowIso } from "./time.js";
// S13 post-pass settings: passes.js PASS_DEFAULTS is the one source of the numbers.
import { PASS_DEFAULTS } from "../passes.js";

export const STARTER_TOPICS = Object.freeze({
  us_politics: { label: "US Politics", affinity: 0.8, half_life_hours: 8, enabled: true },
  singapore: { label: "Singapore", affinity: 0.9, half_life_hours: 12, enabled: true },
  ai: { label: "AI", affinity: 0.6, half_life_hours: 48, enabled: true },
  industrial_biotech: { label: "Industrial Biotech", affinity: 0.6, half_life_hours: 48, enabled: true },
  world: { label: "World", affinity: 0.7, half_life_hours: 8, enabled: true },
  must_know: { label: "Must-know", affinity: 0, half_life_hours: 8, enabled: true, floor_slots: 2 },
});

// R17: opened takes the full seen penalty, shown (on screen 2s+, scrolled past) a
// smaller incremental one.
export const STARTER_SEEN_PENALTY = Object.freeze({ opened: 1.0, shown: 0.25 });

/** A fresh default profile. Pass `timestamp` in tests for a deterministic value. */
export function buildDefaultProfile(timestamp = nowIso()) {
  return {
    schema_version: 1,
    profile_version: 1,
    updated_at: timestamp,
    topics: structuredClone(STARTER_TOPICS),
    trust: {},
    boosts: [],
    mutes: { sources: [], topics: [] },
    seen_penalty: structuredClone(STARTER_SEEN_PENALTY),
    passes: structuredClone(PASS_DEFAULTS),
  };
}
