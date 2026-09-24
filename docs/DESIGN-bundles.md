# DESIGN: Story bundles

Design only, 2026-09-24. Nothing here is built. It extends DESIGN-v1.1 and cites its rulings (R1 to R31) by number. Owner decisions are collected in section 9.

**The ask, in short.** Bundle the versions of one story from different outlets, including outlets the owner disagrees with (he named Fox News, Truth Social, Daily Wire, RedState) and local versus overseas outlets. Lead with the outlet he likes most, mark that more versions exist, and let him swipe left and right through them. That needs a robust similarity metric. He marked it "maybe for later".
**Scope guard.** Bundles reuse S07 clusters, S14 grouping, the S24 sheet and the S25 reader. The only new surfaces are one card mark and one carousel. Fact checks, bias scores and AI comparisons are out (R13).

## 1. Baseline, measured

Live pool generated 2026-09-24T14:33:56Z: 415 published articles, 50 clusters. That run clustered 3,841 candidates in 2.18 s (publish run 36014206250; whole fetch step 22.6 s), then capped each source at 5 items plus 3 cluster extras. I judged all 50 published clusters by hand, then searched the pool for unclustered same-story pairs three ways: token-overlap ranking of every cross-outlet pair, keyword sweeps over about 90 names and places, and pairs sharing three or more rare words.

**Precision (all 50 clusters)**

| verdict | clusters | share |
|---|---|---|
| One story | 32 | 64% |
| One event, several stories (Trump-Xi: 24 articles, 13 outlets, from the tarmac welcome to the banquet guest list) | 12 | 24% |
| Contains an unrelated article (Taiwan esports with India's athletics; Japan's table tennis gold with its badminton loss) | 6 | 12% |

Multi-outlet clusters only (43): 31 are one story (72%), 8 event-level, 4 mixed. The other 7 hold one outlet's own articles (Labiotech's Sweden, China and AstraZeneca pieces; two different Rappler basketball games), which are useless as bundles.

**Misses: 21 same-story pairs across outlets were not clustered, spread over 8 stories.** In 16 of them one article was left alone; 5 are one story split across two clusters.

| story | missed pairs | what happened |
|---|---|---|
| White House media ban ruling | 5 | Reason and Washington Examiner sat in C4 with an unrelated Indian Express "Trump TV" piece, while 11 outlets were in C26; Reason's second piece and NPR's were left alone |
| Xi's arrival, summit day one | 6 | Al Jazeera's and CNA's pieces were left alone; NPR landed in a two-item cluster with The Diplomat |
| Netanyahu at the UN | 3 | WSJ and Jerusalem Post left alone; LiveMint and The Hill in different clusters |
| Ethiopia fighting | 3 | BBC, Guardian and WSJ all left alone: "army repelled attacks", "Tigray rebels launch offensive", "truce collapses" |
| Iran's president at the UN | 1 | BBC left alone, PBS inside the UNGA cluster |
| El-Sayed questioned on Iran | 1 | Fox and Jerusalem Post, both left alone |
| US jobless claims | 1 | PBS left alone; "197,000" is shared but never counts as an entity |
| Israel election panel | 1 | Times of Israel left alone |

**Causes**, read from fetcher/cluster.py against these cases:
1. Greedy single pass onto a rolling centroid. Each unit joins the best centroid at cosine >= 0.35. A big cluster's centroid drifts toward the whole event (chaining), and a true member that matches one article but not the diluted centroid is refused (Iran's president, Al Jazeera's live page).
2. Order dependence. The first article to seed a cluster sets its path, which is how the media ban story split in two.
3. The entity gate is one shared capitalized word, so "Asian Games" or "Meta" joins different stories. Meanwhile numbers never count, demonyms do not fold ("Ethiopian" is not "Ethiopia"), and "U.N." tokenizes to "u" and "n".
4. No cross-outlet rule, so one outlet's related pieces cluster with each other.

Limits: one pool, published articles only (the cap hid about 3,400 items), one labeler. B1 fixes all three.

## 2. Similarity metric

Scale: the brief assumes 100 to 150 sources and 3,000 to 5,000 items a run. Today 60 feeds give 3,850 items, 64 per feed, so 150 feeds could reach 9,600. Costs below cover both.

**(a) Improved lexical.** Score pairs, not unit against centroid. Title words weigh twice the dek (kept), title bigrams added. Entities weighted by rarity in the run, so "Tigray" counts far more than "Trump". Entities widened to numbers of 3+ digits and money amounts, demonyms folded to countries from geo.json, dotted acronyms joined. A time decay multiplies the score by exp(-hours apart / 24). Average-link clustering with blocking (candidate pairs only from shared rare tokens), then a merge pass that joins two clusters whose average link clears the threshold. A story needs 2+ outlets, and same-outlet pieces attach only through a cross-outlet link. Story span capped at 36 h. The umbrella stays S32's event, so a story sits inside an event.
Quality: this targets all four causes. My estimate: 16 to 19 of the 21 misses caught (Ethiopia's paraphrase only where deks share the noun) and purity from 64% to about 90%. These are estimates until B1 measures them.
Cost $0 a month. Run time: 2.2 s today at 3,841 items; average-link with blocking, estimated 3 to 10 s at 5,000 to 9,600, stdlib only. Fit: R8 yes, R30 yes, and v1.1 section 4's "No embeddings" is untouched.

**(b) Embeddings via OpenRouter.** OpenRouter lists 33 embedding models (api/v1/embeddings/models, checked today). Candidates, price per million input tokens: openai/text-embedding-3-small $0.02 ($0.01 batch), qwen/qwen3-embedding-8b $0.01, baai/bge-m3 $0.01, voyageai/voyage-4-lite $0.02. Free models exist (nvidia/nemotron-3-embed-1b:free), but free tiers are rate limited and unfit for a cron.
Tokens: title plus the first 60 dek words averages 271 characters in today's pool, about 70 tokens.
Cost: cached by article id (actions/cache), only new items are embedded; at about 4,000 new items a day that is 8.4M tokens, $0.17 a month on 3-small, $0.08 on qwen. Uncached, every item every hour: 5,000 items is 252M tokens, $5.04 a month; 9,600 items is $9.68. A key with a hard credit limit caps it.
Run time: 1 to 5 batched HTTPS calls, 2 to 10 s. Quality: best on paraphrase and differently framed headlines, but alone it merges same-topic stories, so it would be one term inside (a), behind the same gates.
Fit: R8 holds if the vector is only an input and the grouping stays local. R13: an embedding writes no text and nothing a model writes reaches the reader, so it is not an AI summary. It does strain v1.1 section 4 ("No embeddings") and section 1 ("the AI never ranks"), because cluster size feeds importance, R16 eligibility and Live hype. It also needs a new cron-held OpenRouter key in Actions secrets, where today the only key is device-held. R30: stdlib urllib, fine. With the key absent it must fall back to (a) byte for byte.

**(c) Small local model.** A MiniLM-class sentence transformer needs torch or onnxruntime from pip in the publish job, which breaks R30 and adds install time. The R30-safe variant is a static embedding table (Model2Vec "potion" class, about 30MB of MIT weights) with stdlib lookup and mean pooling: a few seconds per 5,000 items (estimate), $0, but 30MB in the repo, weaker than (b) on paraphrase, and still a model deciding groups. It earns a row in the B1 bake-off, not a plan.

**Recommendation: build (a), $0 a month.** The measured failures are algorithmic (chaining, splits, same-outlet merges, entity rules), embeddings would not fix those, and (a) keeps R8, R30 and AI-off intact. Pre-registered upgrade: if (a) misses the recall target on the gold set, add (b) with text-embedding-3-small as one term (about $0.17 a month cached), after the owner rules on Q1.

**Evaluation plan.**
- Gold set: B1 dumps the pre-cap candidate list (about 3,850 items) as a workflow artifact on 3 days a week apart, never into pool.json. From each dump, label 150 to 200 articles: members of the 20 largest candidate groups plus 50 random singletons, each given a story id and an event id. Same story means the same development within 48 h; explainers pegged to it count, standalone analysis of a theme does not. The owner spot-checks 10% of the labels.
- Metrics: pair precision and recall over cross-outlet pairs, cluster purity (share of clusters that are one story), and B-cubed F1 to catch regressions.
- Targets: pair precision >= 0.95 (a wrong version in a carousel misleads more than a missing one), recall >= 0.80, purity >= 0.90.
- CI: pytest runs the clusterer on each gold fixture and asserts the floors, which only ratchet up. A synthetic 10,000-item benchmark must finish in under 15 s on the Actions runner.

## 3. Source roles

Every source gets one role: **in feed** (can lead and appear alone), **only in comparisons** (appears only as a version inside a bundle an in-feed outlet leads), or **off** (never shown).
A role is an opinion, so it lives on the device in profile.json as `source_roles` (R10), never in the repo or the public pool. sources.json gains two facts: `roster` (core or perspective, meaning why the feed was added) and `country`. The cron publishes a perspective item only when it sits in a multi-outlet story with a core item, so perspective sources add bytes only where they are compared (estimate: under 60 articles, about 40KB).
Defaults: perspective roster is only in comparisons. fox_politics is core and in feed today; by the owner's words it moves to only in comparisons (Q3).

Candidates, feeds checked live 2026-09-24, all HTTP 200 with fresh items:

| outlet | feed | lean | items | full text in feed |
|---|---|---|---|---|
| Fox News latest, world | moxie.foxnews.com/google-publisher/latest.xml, world.xml | right | 25 each | yes, 5.5k and 8.4k chars avg |
| Daily Wire | dailywire.com/feeds/rss.xml | right | 50 | yes, 7.1k avg |
| RedState | redstate.com/feed | right | 20 | no, teaser |
| Breitbart | breitbart.com/feed/ | right | 49 | no |
| The Federalist | thefederalist.com/feed/ | right | 20 | no |
| Jacobin | jacobin.com/feed/ | left | 20 | yes, but Atom; the fetcher reads RSS items only |
| The Intercept | theintercept.com/feed/?rss | left | 20 | yes, 22k avg |
| Common Dreams | commondreams.org/feeds/feed.rss | left | 30 | no |

Leans use the existing buckets, each with a cited `lean_basis` as today. That is five right, three left (Q6).

**Truth Social** is a social network, not an outlet. It has no official feed: truthsocial.com/@realDonaldTrump.rss returns the web app's HTML page, not RSS. Its Mastodon-style API answers an unauthenticated account lookup, but its Terms of Service (help.truthsocial.com/legal/terms-of-service) forbid automated use, robots, scrapers and data-mining tools. So there is no terms-compliant direct feed. A third-party archive, trumpstruth.org, publishes an RSS of the posts (100 items today), unofficial and not run by Truth Social. **Recommendation: off.** A post is a primary source, not a version of coverage, and outlets already carry the posts: today's post on the Xi talks ("leave it exactly where it is") was quoted in headlines by The Hill and LiveMint, both in C0. If he wants the posts themselves, a later "primary source" link to the archive on bundles that quote one is the honest route (Q4).

## 4. Local versus overseas

Two facts are needed. First, the outlet's home country: sources.json `country`, an ISO code, hand-entered. Second, the story's geography at country level: G1 gives only sg, asia, us and world, which is too coarse. So G1's gazetteer should also emit ISO countries per article (`countries`), from the same title and dek text under the same rule that the outlet is never a signal.
Story countries: those named by at least half of the story's versions, at most 2 (bilateral stories such as US and CN).
The label per version is computed in the cron, since it is a fact: **Local** when the outlet's country is a story country, **Overseas** otherwise, and no label when the story has no country or more than 2. Text reads "Local, Singapore" or "Overseas, Japan", beside the existing ownership label (state-owned and so on).
Singapore today: scaffold netting (Straits Times, CNA: both Local) and the okapi birth (Straits Times, Mothership). Overseas coverage of Singapore stories is thin in today's feeds (VnExpress's fake S$10,000 notes piece stood alone), so the gold set must include Singapore stories to test it.
Edge cases: Hong Kong outlets (SCMP, HKFP) on mainland China stories, and exile newsrooms (Radio Dabanga, based in the Netherlands, covering Sudan). Proposal: `country` is the country a newsroom reports for, so Dabanga is SD, and HK stays HK, which makes it Overseas on CN stories unless the owner rules otherwise (Q5).

## 5. UI

**A bundle** is a story cluster with 2+ independent outlets (syndicated copies fold into one) and at least one in-feed outlet.
**The card** is today's card, with headline and image from the lead. The lead is the in-feed outlet with the highest trust in profile (R10), ties broken by his opens of that outlet in history (S15), then recency. The meta line's S14 "N sources" trigger becomes "+N versions", where N is distinct outlets minus one. Tapping the headline still opens the lead (reader or link out); tapping "+N versions" opens the carousel.
**The open view** is a full-screen layer like S25's reader, not inline: Home is already a horizontal scroll-snap pager (S27, tabs.js), and a nested swiper would fight tab swipes. Opening pushes a history entry (#bundle-<cluster id>), so back closes it and a "Read" inside returns to the same slide.
- Top bar: close, "Versions", "2 of 7", and the word-mark toggle.
- Index strip: one text chip per outlet, horizontally scrollable, active chip underlined with D3's ink. Tap to jump.
- Track: `scroll-snap-type: x mandatory`, slides 100% wide, `scroll-snap-stop: always`. Native scrolling, no JS drag.
- Slide: outlet name; lean label (S14's LEAN_LABELS) and ownership; Local or Overseas; relative time; headline in the hero type token; dek; "Read" (S25 reader when has_body) or "Open at <outlet>" (link out); "Also carried by" for syndicated copies; "More from this outlet" when an outlet has 2+ pieces in the story.
- Order: lead first, then local before overseas, then S14's lean order.
- Footer: "All versions by lean" opens S14's coverage sheet for the same cluster.

**Word marks**, a non-AI aid: on bundles of 3+ versions, content words in a headline that appear in no other version's headline are marked, with stopwords dropped and plural s folded. Marks are `<mark>` nodes built with createElement and textContent (R26). Nothing is generated and nothing is scored as biased. No AI-written comparison text anywhere (R13).
**Signals:** opening the carousel counts as opened for the lead's story (R17). Viewing another version records `compared` in local history, which feeds no ranking term. There are no thumbs on only-in-comparisons versions, so reading an outlet he disagrees with never trains his feed.
**Build constraints:** slide text is already in the page (rank-input), so nothing is fetched before paint. Slides are text only with fixed layout, CLS 0. No new connect-src, CSP unchanged (R26). prefers-reduced-motion jumps without smooth scrolling. The region carries aria-roledescription "carousel", slides "slide", and arrow keys move between them. Type and spacing reuse the NYT-measured tokens.

## 6. Rights and ethics

- Headlines, deks and links come from feeds publishers offer for aggregation, polled at the hourly cadence R30 already set.
- Full text only where the feed itself publishes it, and only through bodies/ (R12, S22). Fox, Daily Wire, The Intercept and Jacobin publish full text; RedState, Breitbart, The Federalist and Common Dreams do not.
- The public site matters. almanac-dt5.pages.dev serves pool.json without auth today (fetched for this doc). Full text in a personal reader is ordinary RSS use; the same text at a public URL is republication. So perspective sources get `full_text_ok: false` until Cloudflare Access is on, and link out. After Access, the owner may flip them per source (Q9).
- Hotlinking: slides are text only, so perspective sources add no hotlinked images. The lead card keeps S38/S39's rule: feed-supplied https images only.
- Truth Social stays off under its own terms (section 3).
- Leans are labels from published ratings, never scores. There is no "most biased" ranking. Bundle membership and order never depend on lean. That a perspective outlet never leads is the owner's own setting, visible in profile, not hidden.
- Gold fixtures hold real headlines, in the private repo, for testing only.

## 7. Build plan

| name | package | state | tier | deliverable | depends on |
|---|---|---|---|---|---|
| B1 bundle-gold-set | fetcher | PARKED | opus | pre-cap candidate dump as a workflow artifact; 3 hand-labeled gold fixtures (story and event id per article); pair precision and recall, purity and B-cubed scorer; CI test pinning today's S07 result as the floor | S07 |
| B2 similarity-v2 | fetcher | PARKED | opus | section 2(a): pairwise lexical score, average-link with blocking and a merge pass, cross-outlet story rule, story inside S32's event, method recorded per cluster | B1 |
| B3 bundle-contract | contract | PARKED | sonnet | pool.schema.json, additive: source `country` and `roster`, article `countries` and `locality`, cluster `story_countries` | S07 |
| B4 perspective-roster | fetcher | PARKED | sonnet | the section 3 feeds (Jacobin once Atom parses), `country` for all sources, perspective items published only inside a core-led story, `full_text_ok` false for them until Access, locality labels from G1 countries | B2, B3 |
| B5 bundle-card | app | PARKED | opus | profile `source_roles` with defaults and a settings list; lead by trust then opens; only-in-comparisons never leads or stands alone; "+N versions" mark; passes and must-know unchanged | B4, S11, S13 |
| B6 bundle-carousel | app | PARKED | sonnet | the full-screen versions layer of section 5: slides, index strip, labels, reader or link out, word marks, S14 jump, compared signal | B5, S14, S25 |

What proves them:
- B1: the scorer on today's S07 output lands within 2 points of section 1 (purity 64%); breaking one known-good merge fails CI.
- B2: across all gold fixtures, pair precision >= 0.95, recall >= 0.80, purity >= 0.90; the 21 misses of section 1, kept as a fixture, at least 16 joined; 10,000 synthetic items under 15 s; R29 acceptance tests still pass.
- B3: a pool without the new fields still validates; a `locality` outside local and overseas fails.
- B4: a run where a Fox item stands alone publishes 0 Fox articles; one where it joins an NPR-led story publishes it with locality set; the ledger invariant holds with a new drop reason `perspective_unbundled`.
- B5: with Fox trusted highest but only in comparisons, an NPR and Fox bundle leads with NPR; a Fox-only story never renders; "+N" counts outlets, not articles.
- B6: headless proof at 360dp: CLS 0 across open, swipe and close; back returns to the same feed scroll; a hostile headline renders as text; an 11-version strip scrolls its active chip into view.

Not queued: B7 embeddings-term (fetcher, sonnet), only if B2 misses recall and the owner says yes to Q1.

## 8. Risks

- Tighter stories split today's 13-outlet Trump-Xi cluster into several smaller ones, which lowers its importance term. Importance and R16 may need to read event breadth (S32) instead of story breadth. Decide in B2; the R29 tests guard it.
- 8 to 9 perspective feeds at about 64 items each add about 550 candidates a run, a small clustering cost.
- Word marks can overstate differences on short headlines, hence the 3+ versions rule and the toggle.

## 9. Open questions for the owner

1. Embeddings: may they become a clustering input later if lexical misses its target? That needs a cron-held, capped OpenRouter key, and v1.1 section 4 says no embeddings.
2. Which existing sources move to only in comparisons besides Fox: Washington Examiner, National Review, Reason, The Dispatch, the state-affiliated outlets?
3. fox_politics is in feed today. Confirm the move to only in comparisons.
4. Truth Social stays off. Do you want a "primary source" link to the third-party archive on bundles that quote a post?
5. Hong Kong outlets on mainland China stories: Local or Overseas? Exile newsrooms by the country they cover?
6. Symmetry: add two more left perspective feeds to match the five on the right?
7. May the S13 other-side slot and lean quota use a bundle's perspective version, or only in-feed sources?
8. Word marks on or off by default?
9. After Cloudflare Access, may perspective sources show full text in the reader?
