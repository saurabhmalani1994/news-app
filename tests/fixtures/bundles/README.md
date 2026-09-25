# Bundle gold fixtures (B1)

The measuring stick for story bundles (docs/DESIGN-bundles.md, section 2). Real headlines,
private repo, testing only. No article bodies, no URLs, deks cut to 600 characters.

- `gold_2026-09-24.json`: fixture 1, the whole published pool of the run generated
  2026-09-24T14:33:56Z (415 articles, 50 S07 clusters), the pool section 1 judged by hand.
  322 stories (46 with 2+ articles, 42 across 2+ outlets), 260 events. R47 split its
  Xi summit story in two, Wednesday's arrival and Thursday's White House talks, as fixture 2
  labels them; the calls are in its `notes`.
- `gold_2026-09-24b.json`: fixture 2 (B1b), the first pre-cap dump: a local fetcher run
  generated 2026-09-24T23:12:25Z (5,118 candidates, 296 S07 groups). The 7 largest groups
  (the 20 largest held 241 articles) plus 50 singletons, seed 20260924, then 50 other
  versions found in the dump: 250 articles, 84 stories (20 with 2+ articles, 17 across 2+
  outlets), 62 events. Hard calls are in its `notes`, keyed by article id.
- `floors.json`: per fixture, the scores the current clusterer must reach. CI runs it.
  B2 raised both fixtures' floors to its own numbers.
- `missed_pairs_2026-09-24.json`: section 1's 21 same-story pairs S07 left apart in
  fixture 1, with `floor_joined`, how many the current clusterer must join (B2: 12; the
  design's target is 16). Tested in `tests/test_cluster_b2.py`.
- Scorer and tools: `fetcher/bundle_eval.py`. Tests: `tests/test_bundle_eval.py`.

**Labeling rule.** `story`: the same development within 48 h. An explainer pegged to it
counts; standalone analysis of a theme does not; a reaction from someone new (a senator's
criticism, a vox pop) is its own story. `event`: S32's umbrella, such as the Trump-Xi
summit or the Asian Games; a story with no wider umbrella is its own event. Ids
`st-solo-*` and `ev-solo-*` mark one-article stories and events. The fixture validator
rejects a story spanning more than 48 h. Fixture 2 also settled these: a live page is
labeled by its current title; a wire story's updates (LEAD, 2nd LD) are one story; analysis
of the development itself counts, opinion columns and whole-event analysis do not.

**Owner spot-check.** `spot_check.ids` in each fixture: 10% of the labels, half from
articles that share a story and half from articles that stand alone, drawn with a fixed
seed. Print them with their story-mates:

    python -m fetcher.bundle_eval spotcheck tests/fixtures/bundles/gold_2026-09-24.json

Record each verdict in `spot_check.owner_verdicts` as `"<id>": "ok"` or
`"<id>": "wrong: <why>"`, then fix the label.

## Next dumps

Section 2 wants 2 or more further labeled dumps in the two weeks after 2026-09-24, each
added as it lands. Work outside the repo for steps 1 to 5; the raw dump is never committed.

1. Dispatch a publish run with the dump on (it also publishes the site as usual):
   `gh workflow run publish.yml --ref main -f dump_candidates=true`
   Avoid the minutes around :17 past the hour. A push landing at the same moment can
   cancel the queued dispatch (one `publish` concurrency group); if the run shows
   cancelled, dispatch again after the other run finishes.
2. Wait for it: `gh run list --workflow publish.yml --event workflow_dispatch --limit 1`,
   then `gh run watch <run id> --exit-status`.
   The upload is the job's last step and may fail without failing the run, so check it:
   `gh api repos/saurabhmalani1994/news-app/actions/runs/<run id>/artifacts --jq '.artifacts[] | {name, size_in_bytes, expires_at}'`
   Empty means the upload was refused. On 2026-09-24 the account's Actions artifact
   storage quota was full ("Artifact storage quota has been hit", run 36070646825);
   GitHub recalculates usage every 6 to 12 hours. Retry later rather than raising a
   spending limit (the owner wants no charges beyond the free plan).
   Local route, used for fixture 2 while the quota was full (about a minute, writes
   nothing into the repo when every path points at the scratch folder):
   `python -m fetcher.fanout --out <scratch>/dist/pool.json --sources sources.json --previous-pool-url "" --state-path <scratch>/state.json --dump-candidates <scratch>/candidates.json`
3. Download within 7 days (the artifact's retention):
   `gh run download <run id> --name candidates --dir <scratch>`
   gives `<scratch>/candidates.json`: every pre-cap candidate (5,117 and 2.6MB on 2026-09-24) with id,
   source_id, url, title, dek, published_at, `s07_cluster` (its whole-run S07 group, null
   when alone) and `published`.
4. Sample the 20 largest candidate groups plus 50 random singletons:
   `python -m fetcher.bundle_eval sample <scratch>/candidates.json --out <scratch>/gold_<YYYY-MM-DD>.json --seed <YYYYMMDD>`
   Aim for 150 to 200 articles. If the groups alone pass 150, lower `--groups`; note it.
   A second dump on the same UTC date takes a letter: `gold_<YYYY-MM-DD>b.json`.
5. Label every article's `story` and `event` by the rule above. Then search the whole
   dump for each sampled story's other versions (names, places, numbers, the way section 1
   did) and add them with labels, copying the entry from the dump without `url` and
   `published`. Without this step, misses outside the sample go uncounted.
6. Move the file to `tests/fixtures/bundles/`, draw its spot-check list and score it:
   `python -m fetcher.bundle_eval spotcheck tests/fixtures/bundles/gold_<date>.json --draw <YYYYMMDD>`
   `python -m fetcher.bundle_eval score tests/fixtures/bundles/gold_<date>.json`
7. Ratchet the floors: add an entry for the new file in `floors.json` with the numbers
   from the "S07 re-run on fixture" line (it runs the current clusterer, B2's since B2),
   each rounded down to 4 decimals. Never lower an existing floor. The suite fails until a
   `gold_*.json` has its floors.
8. Run the full suite, then commit the fixture and floors together.
