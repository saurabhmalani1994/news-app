# Slice queue

Format: `name | package | state | tier | deliverable | depends on`
Rules: one package and one behaviour per slice. Two active packages at most. Two READY
slices per active package. S01 is deliberately small and crosses packages once, on purpose,
so the contract, the ledger, the publish step and the fetch step exist before they matter.

| name | package | state | tier | deliverable | depends on |
|---|---|---|---|---|---|
| S01 walking-skeleton | contract | READY | opus | pool.schema.json plus a one-feed job publishing a valid 5-article pool, and a static page listing those 5 headlines | - |
| S02 drop-ledger | contract | READY | sonnet | counts block with fixed reason keys and the fetched equals published plus drops invariant, asserted in CI | S01 |
| S03 design-tokens | app | READY | sonnet | free-font type scale, color tokens, hairline rules, light and dark, per research/nyt-design.md | S01 |
| S04 front-page-river | app | READY | opus | hero, secondary, river and text-only tiers rendering the real pool | S03 |
| S05 feed-fanout | fetcher | PARKED | sonnet | all confirmed feeds, per-feed timeout and retry, errors and empties into the ledger | S02 |
| S06 source-health | fetcher | PARKED | sonnet | per-source health block, consecutive empty and error run counters | S05 |
| S07 dedup-cluster | fetcher | PARKED | opus | minhash near-dup plus cosine-and-entity clustering, method recorded per cluster | S05 |
| S08 lean-taxonomy | fetcher | PARKED | sonnet | sources.json with lean buckets, syndication groups, topics.json tag mapping | S05 |
| S09 guardian-fulltext | fetcher | PARKED | sonnet | Guardian API body text for full_text_ok sources only, quota aware | S05 |
| S10 profile-config | app | PARKED | sonnet | local versioned profile.json, form plus raw editor, diff and revert | S04 |
| S11 ranker-core | app | PARKED | opus | scoring terms, explanation list, sum-equals-score invariant | S10, S07 |
| S12 why-this-sheet | app | PARKED | sonnet | the signed contribution list rendered per story | S11 |
| S13 post-passes | app | PARKED | opus | mute filter, cluster dedup, lean quota, exploration slots, other-side slot, each self-naming | S11 |
| S14 coverage-view | app | PARKED | sonnet | how outlets headlined the same story, grouped by lean | S07, S13 |
| S15 history-store | app | PARKED | sonnet | IndexedDB history with a card snapshot per entry, opened kept 1 year, shown kept 14 days, seen penalty from both signals per R17, never leaves device, per R23 | S11 |
| S16 breadth-number | app | PARKED | sonnet | weekly topic entropy, week-over-week delta, narrowing banner over 15% | S15 |
| S17 health-screen | app | PARKED | sonnet | per-feed health, last run ledger, pool age and stale marker | S06 |
| S18 pwa-offline | app | PARKED | sonnet | service worker, install, offline pool, no wrapper-hostile APIs | S04 |
| S19 ai-gate | ai | PARKED | opus | proposal.schema.json, path whitelist, delta caps, rejection ledger, no network | S10 |
| S20 ai-calls | ai | PARKED | sonnet | the three call shapes against OpenRouter with a device-held key | S19, S37 |
| S21 ai-off-suite | ai | PARKED | sonnet | full suite green with ai.enabled false and no key present | S20 |
| S22 bodies-store | fetcher | PARKED | sonnet | write bodies/<id>.json for full_text_ok sources only, has_body flag in the pool, per R12. S09 writes through this | S05 |
| S23 worldnews-supplement | fetcher | PARKED | sonnet | targeted World News API queries for thin buckets per R6, never load bearing, key-absent state tested | S05 |
| S24 story-actions | app | PARKED | sonnet | per-story overflow menu: open source, save, thumbs up, thumbs down, mute source, mute topic, boost topic, why this. Thumbs also at the end of the reader. Thumbs are recorded with the story's attributes and never change weights directly, per R19 | S04, S10 |
| S25 reader | app | PARKED | sonnet | in-app reader for has_body articles, lazy fetch and IndexedDB cache, source attribution and link out | S04, S22, S37 |
| S26 saved-screen | app | PARKED | sonnet | Saved list modeled on the NYT You tab structure in research/nyt-measured.md, saved bodies readable offline | S24, S25 |
| S27 section-tabs | app | PARKED | sonnet | scrolling section tabs built from the owner's topic buckets (Today, the Live slot from S33, US Politics, World, Singapore, Asia, AI, Biotech), same ranked pool filtered per tab, plus the four item bottom nav (Home, Following, Saved, You) | S11 |
| S29 weekly-proposal | app | PARKED | opus | deterministic weekly review: aggregates opens, shown passes and thumbs by attribute, proposes capped deltas with the attribute each pattern points at, owner approves, never touches standing stories, exploration or must-know. Works with AI off. Opus because the feedback loop is the top technical risk in research section 6 | S15, S24, S10 |
| S30 following-tab | app | PARKED | sonnet | Following tab: one page per standing story and per followed name, timeline plus coverage view | S28, S14 |
| S31 events-field | contract | PARKED | sonnet | `events` array in pool.schema.json: id, label, cluster_ids, hype, eligible, live flag and hold state, per R22. Contract package owns it | S07 |
| S32 event-detection | fetcher | PARKED | opus | group clusters into events by shared key entity, hype score, R16 eligibility, hysteresis across runs | S31 |
| S33 live-tab | app | PARKED | sonnet | the Live tab with a sub-strip of the event's stories, owner pin and block overrides | S27, S32 |
| S34 history-screen | app | PARKED | sonnet | History segment in the Saved tab: read and seen, grouped by day, local text search | S15, S26 |
| S35 persistence-export | app | PARKED | sonnet | storage.persist on first run, one-file export and import of profile, saved and history, per R24 | S10, S15, S26 |
| S36 backup-repo | app | PARKED | opus | automatic backup to the separate private repo per R25: scoped token entered by the owner, open/background/save triggers, monthly history shards, restore flow, visible failure state. Opus because it holds a secret | S35, S37 |
| S37 sanitizer-csp | app | PARKED | opus | allowlist HTML sanitizer for bodies, text-only rendering for every other field, strict CSP in `_headers`, tested with hostile fixtures (script tags, event handlers, javascript: links, srcdoc iframes), per R26 | S04 |

Security ordering, R26: S37 must land before S25 reader, S20 ai-calls and S36 backup-repo.
Text-only rendering of titles and deks is required from S01 onward, not deferred to S37.
| S28 standing-stories | app | PARKED | opus | coverage floor and silence alarm for named standing stories per R2, each placement self-naming in passes | S13 |

Added 2026-09-24 by the orchestrator. The planner's queue covered 21 slices but left seven
design surfaces and rulings with no slice to build them. Found when the owner asked for the
Saved screen and it had no row. Rule going forward: every UI surface in DESIGN-v1 section 7
and every ruling that implies code must map to at least one slice, checked at each queue
revision.

What proves the first three:
- S01: the golden fixture validates against pool.schema.json, and the rendered list equals
  the fixture's five titles in order. Breaking one required field fails CI.
- S02: a run seeded with a titleless item, a dateless item and a duplicate url ends with
  fetched equal to published plus the sum of drops, each of those three reasons exactly 1.
- S03: hero and list headlines resolve to two distinct type tokens, not one scaled clamp,
  and both pass contrast in light and dark.

## Status

Not started. Nothing is READY to spawn until the owner approves DESIGN-v1.md and the
repo exists. Blocking on: owner approval, GitHub account, feed verification result.
