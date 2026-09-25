# Browser proofs

These are hand-run headless-Chrome checks, not in `node --test`'s glob (`tests/js/*.test.js`).
Each needs a local Chrome (`CHROME` env var to point at a non-default install) and, unless
noted, a built `dist/` to serve. All of them use `tests/browser/cdp.mjs`'s bounded launch,
WebSocket connect and per-command timeouts (`CDP_LAUNCH_TIMEOUT_MS`, `CDP_CONNECT_TIMEOUT_MS`,
`CDP_COMMAND_TIMEOUT_MS` env vars override the defaults), so a wedged Chrome fails with a
clear message instead of hanging. Each script serves its own `dist/` (Cloudflare
Pages-shaped: pretty URLs, the build's own `_headers`) and exits 1 on any failure; none of
this needs a separate `serve` step.

## Building a dist to test against

Most proofs just need any current build:

```
python -m fetcher.fanout --out dist/pool.json --sources sources.json   # a real, current pool
python -m app.build --pool dist/pool.json --out dist
```

`why_check.mjs` and `saved_check.mjs` need specific scenarios (a standing-story floor
placement, a has_body story ranked first) that a random real pool will not reliably
produce, so they have their own fixture builders under `tests/browser/fixtures/`:

```
python tests/browser/fixtures/why_pool.py > /tmp/why_pool.json
python -m app.build --pool /tmp/why_pool.json --out /tmp/dist_why
node tests/browser/why_check.mjs /tmp/dist_why

python tests/browser/fixtures/saved_pool.py > /tmp/saved_pool.json
python -m app.build --pool /tmp/saved_pool.json --out /tmp/dist_saved
node tests/browser/saved_check.mjs /tmp/dist_saved sb1
```

`sw_pretty_urls.mjs` and `h2_you_check.mjs` build their own dist(s) internally from git
refs (including the working tree) and take no dist argument.

## The proofs

| Proof | Proves | Node command | Last passed |
|---|---|---|---|
| `sw_pretty_urls.mjs` (H1) | Pretty URLs survive a Pages-style 308, the shell never serves a redirected page, and an upgrade from the broken S18 worker heals by the second launch, all offline too. | `node tests/browser/sw_pretty_urls.mjs` | 2026-09-24 |
| `h2_you_check.mjs` (H2) | Stale assets across a deploy never run a mismatched build's script; old stored profiles migrate forward without error; You opens by every route including deep links, Back and offline; Today keeps its photos and bottom nav after the U1 deploy. | `node tests/browser/h2_you_check.mjs` | 2026-09-24 (27/27) |
| `h3_photos_check.mjs` (H3) | Behind an Access-like cookie gate, a phone holding a pre-Access worker gets this build's worker on the first launch after the deploy (its script request carries the cookie) and every Today and Asia photo loads; a fresh install behind Access and an upgrade from H2's module worker do too. Photos are stubbed unless `--real-photos`. | `node tests/browser/h3_photos_check.mjs --pool dist/pool.json` | 2026-09-24 (8/8) |
| `actions_check.mjs` (S24) | The overflow sheet opens/dismisses (close button, scrim, browser back), mute keeps scroll anchored at zero CLS, Undo restores the muted rows. | `node tests/browser/actions_check.mjs dist` | 2026-09-24 |
| `why_check.mjs` (S12) | Why-this rows sum to the shown total, the point scale is stated once, zero CLS opening it, dismiss by back, a standing-story pass reads in plain words, a quiet story shows no pass section. | `node tests/browser/why_check.mjs /tmp/dist_why` (see fixture above) | 2026-09-24 |
| `saved_check.mjs` (S26) | Saved's empty state, saving through the ordinary overflow-sheet path, newest-first listing with the river's own card, and the pinned has_body story opening offline from cache at zero CLS. | `node tests/browser/saved_check.mjs /tmp/dist_saved sb1` (see fixture above) | 2026-09-24 |
| `standing_cls.mjs` (S28) | The page's silence notices and standing-story placements agree with `standing.js` run again on the page's own embedded input (build and device agree), zero CLS, and switching standing stories off before paint drops the placements cleanly. | `node tests/browser/standing_cls.mjs dist` | 2026-09-24 |
| `csp_check.mjs` (S37) | The CSP header is served and enforced (zero violations on default/section-tab/profile views); the device re-rank loads `rerank.js` and lands on the same order the ranker itself computes; every hostile fixture is neutralized live under the CSP. | `node tests/browser/csp_check.mjs dist` | 2026-09-24 |
| `v1_check.mjs` (V1) | Behind an Access-like cookie gate with `_headers` applied: every multi-source row's "N sources" opens its versions carousel (lead first), CLS 0 across open, swipe and close, back restores the feed scroll and focus, arrow keys and ARIA roles, an 11-version strip keeps its active chip in view, reduced motion jumps, Read and back, the footer coverage sheet, the word-mark switch, mutes, `#bundle-` addresses, a hostile headline as text; sweep shots light, dark and grayscale. | `node tests/browser/v1_check.mjs dist <shots dir>` | 2026-09-24 |

## Other proofs in this directory

Not touched in T1 (not part of its brief); each has its own usage line at the top of the
file with the exact build/dist shape it expects:

`coverage_check.mjs` (S14), `d3_polish.mjs` (D3), `health_cls.mjs` (S17),
`history_check.mjs` (S15), `images_cls.mjs` (S39), `live_overrides_smoke.mjs` (S33, one-off),
`live_panel_shot.mjs` (S33, one-off), `pwa_cls.mjs` (S18), `reader_check.mjs` (S25),
`rerank_cls.mjs` (S11), `tabs_cls.mjs` (S27), `u1_check.mjs` (U1), `you_check.mjs` (U2).
