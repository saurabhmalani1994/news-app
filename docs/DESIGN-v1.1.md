# DESIGN v1.1: Almanac

Supersedes DESIGN-v1.md. Folds in owner rulings R1 through R31, taken 2026-09-23 and 2026-09-24, cited inline by number. Where a ruling changes a v1 decision, that is called out explicitly and the ruling wins. Implementation detail (schemas, field lists, exact algorithms) stays in research/ and future slice briefs; this document states the design, not the spec.

## 1. What it is

**Is:** a personal front page for one reader, named Almanac (R31). A cloud job gathers and cleans news, the phone ranks it with rules the owner can read and edit, tapping a story opens the source.
**For:** one owner, phone first, with a 360dp viewport measured from his own device (R14), installable, offline capable, portable to a native Android wrapper later.
**Is NOT:** a reader that stores article text beyond what publishers already syndicate in their own feeds, not a multi-user product, not an AI feed. The AI never ranks; it proposes config edits the owner approves. With AI off the app is fully functional, and that is a tested state.
**Acceptance test:** Singapore coverage (R4). No single outlet covers his geography today, and if the Singapore bucket is thin or stale, the source layer has failed at the one thing he most specifically asked for.

## 2. Architecture

```
[cron, every 30 or 60 min depending on measured run time, free tier, R30]
  fetcher (Python 3.10+, standard library only, R30) reads sources.json + feeds
    fetch -> normalize -> drop ledger -> dedup -> cluster -> attach lean/tags
    -> writes pool.json (+ manifest.json) as static files
                    |  HTTPS GET, ETag, gzip
                    v
[device: PWA, no server of its own]
  pool cache (IndexedDB)   profile.json (local, versioned)   history (IndexedDB)
    ranker.js (pure, deterministic) -> ordered feed + per-story explanation -> UI
    ai panel -> OpenRouter (key held on device) -> proposal -> gate -> owner approves
```

Two configs, two owners (R10). `sources.json`, repo owned, holds facts about a source: feed URL, lean bucket, syndication group. `profile.json`, device owned, holds opinions: weights, half-lives, trust per domain, boosts, mutes. Trust is personal, lean is shared, so the two never share a file. Reading history never leaves the phone.

**Hosting, settled (R1):** GitHub Actions cron in a private repo, published to Cloudflare Pages, which serves a private repo free where GitHub Pages does not. Repos created and verified private: `saurabhmalani1994/news-app` and, for backups, `saurabhmalani1994/news-app-backup` (R25, R31). This supersedes the recommendation in DESIGN-v1 section 9 item 4; the ruling wins.

**Source layer:** feed parsing is lenient by default, since real feeds are malformed often enough that tolerance is a requirement, and every leniency is counted in the ledger (R9). PBS NewsHour's headline RSS stands in for AP, which has no public feed (R11). World News API is a supplementary source class only, low frequency queries against thin buckets, never load bearing, with its free-plan backlink requirement honored in the app (R6, R7). NewsMesh was evaluated and rejected: real time access costs $79/mo, the free tier delays 24 hours (R5). Clustering and importance are always computed locally, never imported from a vendor; one vendor's own top five stories were four celebrity or crime items and an NFL injury (R8).

## 3. Data contract: the published pool

Owned by package `contract`. The pool (`pool.json`) is opinion-free: no score, no rank, no affinity, so the same static file serves the phone, a browser tab, and a future Capacitor build unchanged. It carries articles, clusters, sources, and a drop ledger (`counts`) where every dropped item names a reason and `fetched == published + sum(drops)` is asserted on every run.

**Body text is not in pool.json (R12).** Measured: 18 of 48 verified feeds publish complete article prose, the largest at 70,639 characters; inlined, a 1500-article pool would run 10 to 30MB against a 400KB target. Bodies are written to `bodies/<article_id>.json`, fetched lazily by the in-app reader and cached offline, only for sources with `full_text_ok`. Nothing is scraped.

An `events` array is planned for the Live tab (R22, section 6 below); its schema is a contract-package deliverable and is not specified here.

## 4. Ranking engine

Half-life recency, static trust table, keyword affinity with a cap, log-scaled independent-source importance, flat boosts, a seen penalty. No embeddings. Mute is a filter, not a score. The ranker is a pure function, and every score is the exact sum of its named terms, so any past order replays byte for byte from a pool and a profile version.

Two interaction signals feed the seen penalty, weighted differently: **opened** takes the full penalty, **shown** (on screen 2+ seconds, scrolled past) takes a small incremental one, so an ignored headline gradually yields its slot (R17). Proposed half-lives, editable in profile: 8h for world, US politics and must-know; 12h for Singapore; 48h for AI and industrial biotech, since work reading happens in batches (R18). Initial tuning is not a guess: the starter profile is written from the owner's own words and checked against acceptance tests run on real pools, for example Singapore in the Today top 20 when Singapore feeds published, zero clinical stories in Biotech, no lean bucket above 60% of any 10 (R29).

## 5. The AI layer

Three call shapes and one deterministic rejection gate, unchanged from v1: one-off filter, config diff, retune proposal. Every numeric delta is capped, every path is whitelisted, every rejection is counted. Article text is untrusted input, so the gate, not the prompt, is what makes a hostile headline harmless.

**No AI written summaries anywhere in the reading path (R13).** A headline-only item has no text to summarize, and a multi-outlet cluster is better served by the coverage view's real headlines side by side than by a model framing the news, which is the thing this app exists to avoid.

**The weekly retune is deterministic, not AI-driven (R20).** Counts over the week produce capped, owner-approved deltas without a model call; AI is needed only for free-text requests and an optional plain-language explanation. This supersedes DESIGN-v1 section 5 item 3, which named the weekly proposal as an AI call shape; the ruling wins, and the weekly review now works with AI off.

## 6. Standing stories, anti-narrowing, and the one number

**Standing stories are a v1 feature (R2).** The owner's complaint is omission, not slant: Israel and Gaza, Sudan. A standing story gets a floor. If nothing from it has been shown in N hours and the pool contains something, it is placed, and silence about a standing story is a reportable condition, the same class of defect as a dead feed. This supersedes the original anti-narrowing section, which only guarded against narrowing by preference and did not guard against a topic never appearing at all; the ruling wins.

**Must-know eligibility is not importance alone (R16).** A story is eligible only if its topic tags fall in a hard news set and its independent sources span at least two lean buckets; syndication breadth alone never qualifies. This supersedes the must-know derivation in OWNER-BRIEF.md, which would otherwise have seated a widely syndicated celebrity story in the slot.

**Live tab (R22, R21).** An event groups clusters sharing a key entity within 48 hours, scored by hype (distinct clusters times independent outlets over 24h), gated by the same R16 eligibility so a celebrity story can never go live, with hysteresis so an incumbent holds at least 12h. It is computed in the cloud; the device only applies the owner's pins and blocks.

Exploration slots, the lean quota, the coverage view, and the weekly Breadth number (topic entropy over shown articles) carry forward from v1 unchanged.

## 7. UI surfaces

**Dark mode is the primary theme (R3),** measured from the owner's own NYT app in dark mode on his Galaxy S23 (research/nyt-measured.md, which supersedes the earlier research/nyt-observed.md estimate). Background #121212, bottom nav surface #2A2A2A, headline text #F8F8F8, dek and meta text #BBBBBB, feed gutter 20dp on both sides. Dividers are a single hairline weight, about 1dp, #3C3C3C, inset 20dp between river stories and full bleed at masthead and module edges; there is no second, heavier near-white rule, the one earlier assumed was an ad creative's own border, not app chrome. River rows, whether they carry a thumbnail or not, carry no dek; dek is a hero-only element. Primary viewport is 360dp (R14).

Top tabs, settled with an owner amendment for one dynamic slot (R21): Today, Live, US Politics, World, Singapore, Asia, AI, Biotech. Bottom nav: Home, Following, Saved, You.

**Story actions** add thumbs up and down to the v1 set (R19). A thumb is recorded with the story's attributes, not applied as a direct weight change, and never lowers a standing-story floor, disables exploration, or affects must-know eligibility, so a thumbs-down on grim coverage cannot recreate the omission the app exists to fix.

**Saved becomes Saved and History (R23).** Every history entry keeps its own card snapshot so it outlives the 72h pool: opened kept 1 year, shown-but-not-opened kept 14 days behind a toggle, both local text searchable. This supersedes the shorter retention originally planned for the history store.

**Local state and backup.** `navigator.storage.persist()` on first run, plus a one-tap export and import of profile, saved, and history as one file; no cloud backup by default, since that would put reading history on a server (R24). The owner opted in to automatic backup to the separate `news-app-backup` repo, never the app repo, triggered on open, hourly while backgrounded, and right after every save, sharded by month, with the token owner-created and owner-pasted, never seen by Claude (R25). Backups are encrypted on device first, AES-GCM via WebCrypto with a PBKDF2-derived passphrase the owner writes down once (R27). One device only; this is backup, not sync (R28).

The PWA is tested in Chrome on the `moms_phone` emulator before every release, the same environment the future TWA wrapper ships into (R15).

## 8. Failure and health

Carried from v1: every drop carries a reason code, the ledger invariant fails the run, each ranking pass names itself in a story's own explanation, stale pool and dead-feed states surface in Health.

**Feed content is hostile input (R26).** The device holds two secrets, the backup token and the OpenRouter key, and injected feed HTML is the main path to both. Titles, deks, and every field except body render as text only, never innerHTML, from S01 onward. Bodies pass a strict allowlist sanitizer; a strict CSP in Cloudflare `_headers` blocks inline script and limits `connect-src` to the pool host, api.github.com, and openrouter.ai. A failed or stale backup shows its reason and last success in the You tab.

## 9. Open decisions

1. **Learning from behavior:** settled by R17, two weighted signals, both device only.
2. **Interests:** the six starter buckets in OWNER-BRIEF.md stand; adding a bucket is a settings action, not a code change.
3. **Framework:** unchanged from v1, vanilla ES modules, Preact as an escape hatch.
4. **Host:** SETTLED, see section 2 (R1).
5. **OpenRouter key:** device-held, entered in Settings, now scoped by the CSP in R26.
6. **Lean table:** unchanged from v1, hand-maintained JSON seeded from published ratings.

## 10. Rulings index

| R | Gist | Section |
|---|---|---|
| R1 | Host: Cloudflare Pages from a private repo, Actions cron | 2 Architecture |
| R2 | Standing stories: coverage floor and silence alarm | 6 Standing stories |
| R3 | Dark mode is the primary theme | 7 UI surfaces |
| R4 | Singapore coverage is the source-layer acceptance test | 1 What it is |
| R5 | NewsMesh rejected on cost and freshness delay | 2 Architecture |
| R6 | World News API: supplementary only, never load bearing | 2 Architecture |
| R7 | World News API backlink honored with in-app credit | 2 Architecture |
| R8 | Clustering and importance always computed locally | 2 Architecture |
| R9 | Feed parser lenient by default, leniency logged | 2 Architecture |
| R10 | Trust is device-owned, lean is repo-owned | 2 Architecture |
| R11 | PBS NewsHour RSS stands in for AP | 2 Architecture |
| R12 | Body text lives outside pool.json, fetched lazily | 3 Data contract |
| R13 | No AI written summaries in the reading path | 5 AI layer |
| R14 | Primary viewport is 360dp, measured | 1 What it is |
| R15 | Emulator test is a release gate | 7 UI surfaces |
| R16 | Must-know eligibility needs hard news and lean spread | 6 Standing stories |
| R17 | Opened and shown are separate, weighted seen signals | 4 Ranking engine |
| R18 | Proposed per-topic recency half-lives | 4 Ranking engine |
| R19 | Thumbs up/down, attributed to the item, not the topic | 7 UI surfaces |
| R20 | Weekly retune is deterministic, not an AI call | 5 AI layer |
| R21 | Top tabs and bottom nav settled, one dynamic slot | 7 UI surfaces |
| R22 | Live tab: event grouping, hype score, hysteresis | 6 Standing stories |
| R23 | Saved splits into Saved and History, longer retention | 7 UI surfaces |
| R24 | Local persistence plus manual export/import | 7 UI surfaces |
| R25 | Opt-in automatic backup to a separate private repo | 7 UI surfaces |
| R26 | Feed content is hostile input: sanitizer, CSP | 8 Failure and health |
| R27 | Backups encrypted on device before upload | 7 UI surfaces |
| R28 | One device: backup, not sync | 7 UI surfaces |
| R29 | Initial tuning verified against acceptance tests | 4 Ranking engine |
| R30 | Actions minutes budget sets the cron cadence | 2 Architecture |
| R31 | Repo names, app name Almanac, owner pre-authorizations | 1 What it is |
