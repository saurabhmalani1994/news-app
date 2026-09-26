# Browser proofs

These are hand-run headless-Chrome checks, not in `node --test`'s glob (`tests/js/*.test.js`).
Each needs a local Chrome (`CHROME` env var to point at a non-default install) and, unless
noted, a built `dist/` to serve. All of them use `tests/browser/cdp.mjs`'s bounded launch,
WebSocket connect and per-command timeouts (`CDP_LAUNCH_TIMEOUT_MS`, `CDP_CONNECT_TIMEOUT_MS`,
`CDP_COMMAND_TIMEOUT_MS` env vars override the defaults), so a wedged Chrome fails with a
clear message instead of hanging. Each script serves its own `dist/` (Cloudflare
Pages-shaped: pretty URLs, the build's own `_headers`) and exits 1 on any failure; none of
this needs a separate `serve` step.

H5: every proof runs behind a simulated Cloudflare Access gate. `cdp.mjs`'s `serve()`
answers any request without the `CF_Authorization` cookie with a 302 to a login origin,
as the live site does, and `launch()` gives its browser that cookie for 127.0.0.1 (a
cookie ignores the port). A Node-side fetch sends `ACCESS_HEADERS`. `images_cls`,
`rerank_cls`, `standing_cls` and `tabs_cls` used to run their own bare server with no
`_headers`; they now use `serve()`, so they also run under the live CSP. `h3_photos_check`,
`s34_check`, `u5_check`, `v1_check` and `w1_check` keep their own gates, which were
already there.

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

H4 added three more, for the same reason: `tests/fixtures/golden_pool.json` (one
source, five articles) is too small for what these three need to look at.

```
python tests/browser/fixtures/actions_pool.py > /tmp/actions_pool.json
python -m app.build --pool /tmp/actions_pool.json --out /tmp/dist_actions
node tests/browser/actions_check.mjs /tmp/dist_actions

python tests/browser/fixtures/csp_pool.py > /tmp/csp_pool.json
python -m app.build --pool /tmp/csp_pool.json --out /tmp/dist_csp
node tests/browser/csp_check.mjs /tmp/dist_csp

python tests/browser/fixtures/l1_pool.py /tmp/l1
python -m app.build --pool /tmp/l1/pool.json --out /tmp/dist_l1
cp -r /tmp/l1/bodies /tmp/dist_l1/bodies
node tests/browser/l1_check.mjs /tmp/dist_l1
```

H5 added one more, for `tabs_cls.mjs`'s Live panel: it takes a real pool and puts the
story carrying Today's other-side link inside the live event, so the check that no Live
row carries an other-side link runs every time, not only when the news lines up.

```
python tests/browser/fixtures/live_other_side_pool.py dist/pool.json > /tmp/lo_pool.json
python -m app.build --pool /tmp/lo_pool.json --out /tmp/dist_lo
node tests/browser/tabs_cls.mjs /tmp/dist_lo
```

`standing_cls.mjs` still runs fine against golden_pool.json's plain `dist` (its own
fixed conditional-clear bug, not a size problem; see H4 item 6 below).

R2 added two more, both taking a real pool. `rank_parity_pool.py` puts three of Today's
top 12 into one event, so H4's per-event repeat cap always moves a card (the pass the
device re-rank used to skip, see R2 below). `v1_pool.py` grows the largest cluster to 12
versions from the pool's own single stories; `v1_check.mjs` runs it itself when the
dist it is given has no 12-version cluster (B8: forced every time), so a fresh pool's dist is enough.

```
python tests/browser/fixtures/rank_parity_pool.py dist/pool.json > /tmp/rp_pool.json
python -m app.build --pool /tmp/rp_pool.json --out /tmp/dist_rp
node tests/browser/rerank_cls.mjs /tmp/dist_rp
node tests/browser/standing_cls.mjs /tmp/dist_rp
```

`standing_cls.mjs` also runs on why_check's `/tmp/dist_why`, whose default profile
places a Sudan card at build. Its own fourth visit ("probe-dark") needs no fixture: a
stored standing story keyed to a word from a card below the floor, and one keyed to a
word nothing carries, so the device always places a card and raises a notice.

`tests/browser/dek_widths.mjs <dist>` is a tool, not a proof: it measures the dek
face's advance widths and the narrowest dek measure and prints `app/dek_widths.py`.
Rerun it when the dek font, its size or the gutters change.

`sw_pretty_urls.mjs` and `h2_you_check.mjs` build their own dist(s) internally from git
refs (including the working tree) and take no dist argument.

## The proofs

| Proof | Proves | Node command | Last passed |
|---|---|---|---|
| `sw_pretty_urls.mjs` (H1) | Pretty URLs survive a Pages-style 308, the shell never serves a redirected page, and an upgrade from the broken S18 worker heals by the second launch, all offline too. | `node tests/browser/sw_pretty_urls.mjs` | 2026-09-25 |
| `h2_you_check.mjs` (H2) | Stale assets across a deploy never run a mismatched build's script; old stored profiles migrate forward without error; You opens by every route including deep links, Back and offline; Today keeps its photos and bottom nav after the U1 deploy. | `node tests/browser/h2_you_check.mjs` | 2026-09-25 (27/27) |
| `h3_photos_check.mjs` (H3) | Behind an Access-like cookie gate, a phone holding a pre-Access worker gets this build's worker on the first launch after the deploy (its script request carries the cookie) and every Today and Asia photo loads; a fresh install behind Access and an upgrade from H2's module worker do too. Photos are stubbed unless `--real-photos`. | `node tests/browser/h3_photos_check.mjs --pool dist/pool.json` | 2026-09-25 (8/8) |
| `actions_check.mjs` (S24) | The overflow sheet opens/dismisses (close button, scrim, browser back), mute keeps scroll anchored at zero CLS, Undo restores the muted rows. | `node tests/browser/actions_check.mjs /tmp/dist_actions` (H4: own fixture, see above) | 2026-09-25 (9/9) |
| `why_check.mjs` (S12) | Why-this rows sum to the shown total, the point scale is stated once, zero CLS opening it, dismiss by back, a standing-story pass reads in plain words, a quiet story shows no pass section. | `node tests/browser/why_check.mjs /tmp/dist_why` (see fixture above) | 2026-09-25 (10/10) |
| `saved_check.mjs` (S26) | Saved's empty state, saving through the ordinary overflow-sheet path, newest-first listing with the river's own card, and the pinned has_body story opening offline from cache at zero CLS. | `node tests/browser/saved_check.mjs /tmp/dist_saved sb1` (see fixture above) | 2026-09-25 (6/6) |
| `standing_cls.mjs` (S28) | The page's silence notices and standing-story placements agree with `standing.js` run again on the page's own embedded input (build and device agree), zero CLS, and switching standing stories off before paint drops the placements cleanly. | `node tests/browser/standing_cls.mjs dist` | 2026-09-25 (R2: 4/4 scenarios on a fresh pool, `/tmp/dist_rp` and `/tmp/dist_why`; the fourth is a probe profile that always places a card and raises a notice) |
| `csp_check.mjs` (S37) | The CSP header is served and enforced (zero violations on default/section-tab/profile views); the device re-rank loads `rerank.js` and lands on the same order the ranker itself computes; every hostile fixture is neutralized live under the CSP. | `node tests/browser/csp_check.mjs /tmp/dist_csp` (H4: own fixture, see above) | 2026-09-25 (8/8) |
| `l1_check.mjs` (L1) | Every US-scale row's lean marker (five dots, its own bucket filled), state media and non-US country codes, a centred 48dp tap target that wins over the headline, the lean sheet's cited basis, markers off/color-on in Display, "Read here · outlet" naming the right member with a trust flip and a missing-body fallback, the You page's source picker and its own sheet, zero CLS and CSP violations. | `node tests/browser/l1_check.mjs /tmp/dist_l1` (H4: own fixture, see above, needs real `bodies/`) | 2026-09-25 (all passed) |
| `v1_check.mjs` (V1) | Behind an Access-like cookie gate with `_headers` applied: every multi-source row's "N sources" opens its versions carousel (lead first), CLS 0 across open, swipe and close, back restores the feed scroll and focus, arrow keys and ARIA roles, an 11-version strip keeps its active chip in view, reduced motion jumps, Read and back, the footer coverage sheet, the word-mark switch, mutes, `#bundle-` addresses, a hostile headline as text; sweep shots light, dark and grayscale. | `node tests/browser/v1_check.mjs dist <shots dir>` | 2026-09-25 (R2: grows a pool without an 11-version cluster through `fixtures/v1_pool.py` itself, so any fresh pool's dist runs) |
| `b4_locality_check.mjs` (B4) | Behind an Access-like cookie gate with `_headers` applied: unauthenticated `pool.json`, a `bodies/` file and the page all get the 302; the page embeds `locality` for carousel members; on a Today carousel spanning two tiers every slide names its own tier (Local, Regional, Overseas) and an unlabeled one none; shots dark and light. | `node tests/browser/b4_locality_check.mjs dist <shots dir>` | 2026-09-25 |
| `b5_face_check.mjs` (B5) | Behind an Access-like cookie gate with `_headers` applied: every scored Today row shows its best version (headline, outlet) and its carousel opens on it; "Read here" and Today's order agree with the page's own modules; a trust of 1.5 on a close pick's runner-up re-fronts the row before first paint (CLS 0) and the why-this sheet opens with "Leads because" naming trust, its terms summing to the score; with Fox muted no Fox-only story renders and Fox leaves every carousel and "N sources"; shots of the re-fronted row and the sheet, dark and light. | `node tests/browser/b5_face_check.mjs dist <shots dir>` (any fresh pool's dist) | 2026-09-25 |

## Pass counts (T2, 2026-09-26)

Every proof, run behind the simulated Access gate against a fresh real pool (97 sources,
697 articles) and the fixtures above. A count is checks passed out of checks run.

| Proof | Dist | Result |
|---|---|---|
| `sw_pretty_urls` | own builds | 13/13 |
| `h2_you_check` | own builds | 27/27 |
| `h3_photos_check` | `--pool dist/pool.json` | 8/8 |
| `actions_check` | `/tmp/dist_actions` | 9/9 |
| `why_check` | `/tmp/dist_why` | 10/10 |
| `saved_check` | `/tmp/dist_saved sb1` | 6/6 |
| `standing_cls` | `dist`, `/tmp/dist_rp`, `/tmp/dist_why` | 4/4 each |
| `csp_check` | `/tmp/dist_csp` | 8/8 |
| `l1_check` | `/tmp/dist_l1` | 39/39 |
| `v1_check` | `dist` | 24/24 |
| `b4_locality_check` | `dist` | 8/8 |
| `b5_face_check` | `dist` | 35/35 |
| `coverage_check` | `dist` | 9/9 |
| `d3_polish` | `dist` | 8/8 |
| `health_cls` | `dist` | 6/6 |
| `history_check` | `dist` | 10/10 |
| `images_cls` | `dist` | 6/6 |
| `pwa_cls` | own builds | 5/5, repeated 8/8 (H7 fixed the flake below) |
| `reader_check` | `dist` (with `bodies/`) | 10/10 |
| `rerank_cls` | `/tmp/dist_rp`, `dist` | 4/4 each |
| `tabs_cls` | `/tmp/dist_lo` | 6/6 |
| `u1_check` | `dist` (with `bodies/`) | 20/20 |
| `u3_check` | `dist` | 32/32 |
| `u4_check` | own builds | 14/14 |
| `u5_check` | own builds | 12/12 |
| `w1_check` | own builds | 21/21 |
| `you_check` | `dist` | 21/21 |
| `s34_check` | `/tmp/dist_s34` | 12/12 across repeated runs (H7 found the proof stale, see below) |

H7: `s34_check`'s "the reader never opens for h34a within 8s" was the proof, not History's
reopen. It clicked the first story right after a fixed 900ms post-navigate sleep; on a cold
first Chrome launch under load, that click could land before reader.js (a module script,
so it attaches its listener once parsing finishes, not on a clock) was listening, and the
click on Today's own card silently did nothing, well before History ever entered the run.
13 local runs on main reproduced this once (a Today-open, not a History reopen); 12 further
runs, and every one after swapping the fixed sleep for a bounded `document.readyState ===
"complete"` wait, were green. History's own reopen path (`resolveReopen`,
`history/reopen.js`, `saved-screen.js`) was not touched: it already prefers the device's
own cache (populated the moment a story is first opened) with the live pool as a fallback,
and nothing B5, R2 or T2 changed alters that. `pwa_cls`'s "once in three" flake was the
same shape: a fixed 1500ms sleep raced the new service worker's own activate-time cache
cleanup (`sw_template.js`) instead of waiting for it, so `redeploy()` now polls for the
shell-cache count to actually settle at 2, bounded, rather than guessing a delay.

T2 changed two things every proof sees. `coverage_check` (failing on main since B5) was
two findings. The product was wrong: the row trigger and the carousel's data followed
the pool's `independent_sources` (syndication groups), while the row's "N sources"
counts sources, so two feeds of one owner (TechCrunch AI and TechCrunch Climate) showed
"2 sources" with no trigger over it; the trigger now follows the row's own count. The
proof was stale: it held the sheet's "M independent" to the pool's field, which H6
replaced with the page's count. And `#rank-input` is now written compact
(`app/page_input.py`): a proof reads it through `cdp.mjs`'s `decodeInput` (Node side)
or `PAGE_INPUT` (inside a page-side evaluate), never with a bare `JSON.parse`.

## Other proofs in this directory

Not touched in T1 (not part of its brief); each has its own usage line at the top of the
file with the exact build/dist shape it expects:

`coverage_check.mjs` (S14), `d3_polish.mjs` (D3), `health_cls.mjs` (S17),
`history_check.mjs` (S15), `images_cls.mjs` (S39), `live_overrides_smoke.mjs` (S33, one-off),
`live_panel_shot.mjs` (S33, one-off), `pwa_cls.mjs` (S18), `reader_check.mjs` (S25),
`rerank_cls.mjs` (S11), `tabs_cls.mjs` (S27), `u1_check.mjs` (U1), `u3_check.mjs` (U3),
`u4_check.mjs` (U4), `w1_check.mjs` (W1), `you_check.mjs` (U2).

All ran green on 2026-09-25 against a fresh real pool (`python -m fetcher.fanout`, 97
sources, 642 articles) except three pre-existing findings, none touched by H4's diff
(confirmed by rerunning each with H4's changed files swapped back to `origin/main`,
same result either way) and none of them item 1-7's own subject, so left as found and
reported rather than fixed in this batch:

- `tabs_cls.mjs`'s "lists" check: the Live section's other-side link disagrees between
  the build and `passes.js` run standalone on the same input (`others` mismatch on the
  live-event slot only, every other section's list and other-side links agree).
  **H5: a product bug, fixed.** The Live panel is filled with clones of Today's rows, and
  `fillLivePanel` never cleared the other-side link a clone brought along; `passes.js`
  gives Live rows none. It showed only when Today's other-side story was also in the live
  event. `fixtures/live_other_side_pool.py` now forces that case.
- `reader_check.mjs`: a missing-body-file note never appears within its 3s wait
  ("missing file and fetch error"), and one hostile-body handler attribute survives
  sanitization uncounted-for by the check's own tally ("hostile body executes
  nothing", `handlerAttrs: 1`). **H5: both were the check, not the reader.** The row it
  404ed had two members with bodies, so the reader opened the other one (R43, as
  `l1_check` proves); the note does show for a one-body row and once every member is
  missing, both now checked. The counted attribute was the reader's own hero photo
  `style="--box: W / H"` (H4 item 4), not feed markup: the count now covers the sanitized
  body, and the reader's other markup is held to the same rule with that one style allowed.
  The hostile story is now always one with a hero. H5 did find and fix one real sanitizer
  gap: a body opening with `<noscript>` was parsed in the head, where its first `<p>` or
  `<img>` broke out into the body and showed (sanitized, never live).
- `u1_check.mjs`: 4 of 515 real Today summaries on the current live pool still meet the
  line clamp (`fitted summaries never meet the line clamp`), all long AP-style dateline
  openings ("WASHINGTON, Sept 25 - ...").

H5 reran every proof behind the Access gate on 2026-09-25 against a fresh real pool (97
sources, 641 articles). All green but five, and those five fail the same way on
unmodified main with the same pool (same failing checks, same numbers), so they are not
H5's and were left as found: `coverage_check` (the `.story-coverage` trigger it clicks is
missing for the story it picked), `rerank_cls` (`finalMatchesRanker: false` on the
default and custom profiles), `standing_cls` (default dark and light: the placements
disagree), `u1_check` (3 clamped summaries, as above) and `v1_check` (no cluster with 11
or more versions in this pool, its stated caveat). `sw_pretty_urls` session B and
`h2_you_check`'s old-build phases replay history from before Access, so the gate is
open for those phases only; see the comments there.

R2 (2026-09-25) found the root cause of each of those five and reran them on a fresh
real pool (97 sources, 645 articles) and on their fixtures, all green:

- `rerank_cls` and `standing_cls`: **a product bug.** H4's repeat cap reads the pool's
  events, which the build passes to the ranker and `rerank.js` did not, so the order
  after the device re-rank (any stored profile or any read history, the owner's usual
  case) lost the per-event cap and disagreed with the page as built. Both proofs were
  event-blind the same way, which is why the default-profile visits failed and the
  re-ranked ones "passed". One `pageOptions()` in `passes.js` now feeds every caller;
  `tests/js/rank-parity.test.js` holds rank_cli and the device to one order.
  `rerank_cls` also cleared localStorage only when no profile was stored, so a seen
  summary left by the previous visit re-ranked the next one (the custom-light
  `othersMatch` miss); it now clears first, as `standing_cls` does.
- `coverage_check`: stale. It picked the biggest cluster by the pool's own
  `independent_sources` (outlets by syndication group), but a row carries the trigger by
  the page's count (copies, a near-duplicate group once, V1). A pair of outlets running
  one wire copy is 2 in the pool and one version on the page, rightly with no trigger.
  It now picks by the page's rule and holds every Today row to it.
- `u1_check`: **a product bug.** Deks were fitted by character count alone, so wide
  words and CJK text (one em a character) met the CSS clamp. `fit_dek` now also wraps
  the dek in Newsreader's measured widths at the narrowest dek measure (280px).
- `v1_check`: the day's news; `fixtures/v1_pool.py` makes the 11-version strip from any
  pool, and v1_check applies it itself.
