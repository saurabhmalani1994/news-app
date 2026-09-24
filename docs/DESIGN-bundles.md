# DESIGN: Story bundles

Design only, 2026-09-24. Nothing here is built. It extends DESIGN-v1.1 and cites rulings (R1 to R40) by number.
**Status: approved 2026-09-24 with the owner's R40 amendments.** His answers are recorded in section 9; sections 2 to 8 are amended to match.

**The ask, in short.** Bundle the versions of one story from different outlets, including outlets the owner disagrees with (he named Fox News, Truth Social, Daily Wire, RedState) and local versus overseas outlets. Lead with the best version, mark that more versions exist, and let him swipe left and right through them. That needs a robust similarity metric. He marked it "maybe for later". R40 replaced "lead with the outlet he likes most" with a per-story best version (section 4a).
**Scope guard.** Bundles reuse S07 clusters, S14 grouping, the S24 sheet and the S25 reader. The new surfaces are one card mark, one carousel and one primary source link. Fact checks, bias scores and AI comparisons are out (R13).

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

**(b) Embeddings.** Lower priority and unqueued (R40 answer 1). If ever needed, a free route comes first.
Free candidates, to verify before any use: Cloudflare Workers AI gives 10,000 neurons a day on every plan (developers.cloudflare.com/workers-ai/platform/pricing, checked today). @cf/baai/bge-m3 and @cf/qwen/qwen3-embedding-0.6b cost 1,075 neurons per million input tokens, so the cached load below (about 280k tokens a day) is about 300 neurons, 3% of the allocation. Uncached, 5,000 items every hour is about 9,000 neurons a day, too close, so the cache is required. Still to verify: the account's Workers plan (on Free, calls past the allocation fail instead of billing), a cron-held token scoped to Workers AI, and batch limits. Second candidate: a hosted free tier such as Gemini's embedding API, after reading its data-use terms. Third: option (c).
Paid fallback, OpenRouter: 33 embedding models listed (api/v1/embeddings/models, checked today). Price per million input tokens: openai/text-embedding-3-small $0.02 ($0.01 batch), qwen/qwen3-embedding-8b $0.01, baai/bge-m3 $0.01, voyageai/voyage-4-lite $0.02. Its ":free" models are rate limited and unfit for a cron.
Tokens: title plus the first 60 dek words averages 271 characters in today's pool, about 70 tokens.
Cost: cached by article id (actions/cache), only new items are embedded; at about 4,000 new items a day that is 8.4M tokens a month, $0.17 a month on 3-small, $0.08 on qwen. Uncached, every item every hour: 5,000 items is 252M tokens, $5.04 a month; 9,600 items is $9.68. A key with a hard credit limit caps it.
Run time: 1 to 5 batched HTTPS calls, 2 to 10 s. Quality: best on paraphrase and differently framed headlines, but alone it merges same-topic stories, so it would be one term inside (a), behind the same gates.
Fit: R8 holds if the vector is only an input and the grouping stays local. R13: an embedding writes no text and nothing a model writes reaches the reader, so it is not an AI summary. It does strain v1.1 section 4 ("No embeddings") and section 1 ("the AI never ranks"), because cluster size feeds importance, R16 eligibility and Live hype. Either route needs a new cron-held key in Actions secrets, where today the only model key is device-held. R30: stdlib urllib, fine. With the key absent it must fall back to (a) byte for byte.

**(c) Small local model.** A MiniLM-class sentence transformer needs torch or onnxruntime from pip in the publish job, which breaks R30 and adds install time. The R30-safe variant is a static embedding table (Model2Vec "potion" class, about 30MB of MIT weights) with stdlib lookup and mean pooling: a few seconds per 5,000 items (estimate), $0, but 30MB in the repo, weaker than (b) on paraphrase, and still a model deciding groups. It earns a row in the B1 bake-off, not a plan.

**Recommendation: build (a), $0 a month.** The measured failures are algorithmic (chaining, splits, same-outlet merges, entity rules), embeddings would not fix those, and (a) keeps R8, R30 and AI-off intact. Pre-registered upgrade: if (a) misses the recall target on the gold set, add (b) as one term, free route first, with OpenRouter text-embedding-3-small (about $0.17 a month cached) as the paid fallback.

**Evaluation plan.**
- Gold set: start now. Fixture 1 is today's published pool (415 articles, 50 clusters), already judged by hand for section 1; B1 adds a story id and an event id per article. B1 then dumps the pre-cap candidate list (about 3,850 items) as a workflow artifact, never into pool.json, and labels at least 2 more dumps over the following two weeks, each added as it lands: members of the 20 largest candidate groups plus 50 random singletons, 150 to 200 articles a dump. Nothing waits for three dumps a week apart. Same story means the same development within 48 h; explainers pegged to it count, standalone analysis of a theme does not. The owner spot-checks 10% of the labels.
- Metrics: pair precision and recall over cross-outlet pairs, cluster purity (share of clusters that are one story), and B-cubed F1 to catch regressions.
- Targets: pair precision >= 0.95 (a wrong version in a carousel misleads more than a missing one), recall >= 0.80, purity >= 0.90.
- CI: pytest runs the clusterer on each gold fixture and asserts the floors, which only ratchet up as fixtures land. A synthetic 10,000-item benchmark must finish in under 15 s on the Actions runner.

## 3. Sources

No roles by lean (R40 answers 2, 3 and 7). Every source, old or new, is in feed by default: it can lead a bundle and can stand alone as a one-outlet card. The one control is the owner's own on and off per source, on the sources page being built now (U2), which writes `mutes.sources` in profile.json (R10). A muted source is gone everywhere: feed, bundles, carousel, the "+N" count and the other-side link. There is no compare-only role.
sources.json gains three facts. `roster` (core or perspective) is provenance only, why the feed was added; nothing reads it for ranking, leading or publishing, and a test asserts that. `country` feeds section 4. `paywall` (hand-entered: the outlet meters or blocks its articles) feeds section 4a.
Pool size: the old "perspective items only inside a core-led story" rule is gone. New feeds publish under the same caps as every source (5 items, plus 3 extras in multi-source clusters). With 71 feeds the worst case is 568 articles, about 352KB at the measured 620 bytes each, under R12's 400KB target; B4 reports the real figure.

Candidates, feeds checked live 2026-09-24, all HTTP 200 with fresh items:

| outlet | feed | lean | items | full text in feed |
|---|---|---|---|---|
| Fox News latest, world | moxie.foxnews.com/google-publisher/latest.xml, world.xml | right | 25 each | yes, 5.5k and 8.4k chars avg |
| Daily Wire | dailywire.com/feeds/rss.xml | right | 50 | yes, 7.1k avg |
| RedState | redstate.com/feed | right | 20 | no, teaser |
| Breitbart | breitbart.com/feed/ | right | 49 | no |
| The Federalist | thefederalist.com/feed/ | right | 20 | no |
| Jacobin | jacobin.com/feed/ | left | 20, newest 12 min old | yes, in Atom xhtml content |
| The Intercept | theintercept.com/feed/?rss | left | 20 | yes, 22k avg |
| Common Dreams | commondreams.org/feeds/feed.rss | left | 30 | no |
| The New Republic (R40 answer 6) | newrepublic.com/rss.xml | left | 100, 22 in the last 24 h | no, headline and dek |
| Democracy Now! (R40 answer 6) | democracynow.org/democracynow.rss | left | 40, 5 in the last 24 h | partial, about 1k chars, under the 2,000-char cutoff |

Leans use the existing buckets, each with a cited `lean_basis` as today. That is five right, five left. The New Republic already carries four pieces on today's media ban story, so it bundles at once. Democracy Now's daily "Headlines for <date>" item spans many stories; B4 drops it by a title rule so it never joins a bundle. Checked and not picked: Vox (Atom, full text, only 10 entries), Slate, Salon (its feed mixes in 2018 items), The Nation, Truthout.
**Atom, for Jacobin.** fetch.py reads RSS `item` only. B4 adds an Atom branch to the same stdlib parser: when the root is an Atom `feed`, each `entry` gives the title, the `link rel="alternate"` href (else the first link), `published` (else `updated`), `summary` as the dek, and `content` as the body. Type xhtml (Jacobin's case, text in a child div) is read with itertext; type html goes through the same stripping as content:encoded. Item checks, R9 leniency and the 2,000-char full-text cutoff are unchanged.

**Truth Social** is a social network, not an outlet. It has no official feed: truthsocial.com/@realDonaldTrump.rss returns the web app's HTML page, not RSS. Its Terms of Service (help.truthsocial.com/legal/terms-of-service) forbid automated use, robots, scrapers and data-mining tools, so it stays off as a source. A third-party archive, trumpstruth.org, publishes an RSS of the posts, unofficial and not run by Truth Social (checked today: HTTP 200, 100 items, each with the archive link and the original post id).
**Primary source link (R40 answer 4).** The cron reads the archive feed as a lookup table only; posts never enter the pool. A story gets the link only when all of these hold, else nothing:
1. A version's title, dek or body names "Truth Social".
2. That version quotes a span of 6 or more words inside quotation marks.
3. After folding case, curly quotes and punctuation, the span appears verbatim in exactly one archived post from the 72 h before that version. Two matching posts means no link.
4. The post is not a bare repost ("RT @...") and has 6 or more words of its own.
Today's example qualifies on length: "leave it exactly where it is", quoted by The Hill and LiveMint. The link reads "Primary source: the post, on trumpstruth.org, a third-party archive not run by Truth Social". It is a plain link out, never an embed, and the device never fetches the archive (CSP unchanged).

## 4. Local, intermediate and overseas

Two facts are needed. First, the outlet's home country: sources.json `country`, an ISO code, hand-entered. Second, the story's geography at country level: G1 gives only sg, asia, us and world, which is too coarse. So G1's gazetteer should also emit ISO countries per article (`countries`), from the same title and dek text under the same rule that the outlet is never a signal.
Story countries: those named by at least half of the story's versions, at most 2 (bilateral stories such as US and CN).
Three tiers, computed in the cron since they are facts: **local** when the outlet's country is a story country; **intermediate** when the pair (outlet country, story country) is in the table below; **overseas** otherwise. No label when the story has no country or more than 2; with two story countries the nearer tier wins. Text reads "Local, Singapore", "Regional, Hong Kong" or "Overseas, Japan", beside the existing ownership label (state-owned and so on).
The intermediate pairs are data in geo.json (`intermediate`), repo-owned and directional, so a new pair is one row plus a fixture:

| outlet country | story country | why |
|---|---|---|
| HK | CN | R40 answer 5: between mainland and other foreign outlets (SCMP, HKFP) |
| MO | CN | R42: same special administrative region status as Hong Kong; no Macau feed today |
| MY | SG | R42: Malaysian outlets on Singapore stories |
| SG | MY | R42: Singaporean outlets on Malaysian stories |

Taiwan outlets on China stories are **overseas**, the third tier (R42), so no row. Exile newsrooms are **intermediate** on the country they cover (R42): a source carries `country` (where it is based) and `exile_of` (the country it reports for), and the pair (outlet, `exile_of`) counts as intermediate. Radio Dabanga is NL with `exile_of: SD`; B4 sets `exile_of` for any other exile newsroom in sources.json with a cited reason.
Singapore today: scaffold netting (Straits Times, CNA: both Local) and the okapi birth (Straits Times, Mothership). Overseas coverage of Singapore stories is thin in today's feeds (VnExpress's fake S$10,000 notes piece stood alone), so the gold set must include Singapore stories to test it.

## 4a. Best version

R40 answers 2 and 3: the face of a story is its best version, picked per story, with no standing preference for an outlet or a lean. Lean and `roster` are not inputs. As in S11, the score is the exact sum of named integer terms, so the why-this sheet can list them and any pick replays from a pool and a profile.

| term | points | reason |
|---|---|---|
| original | 20, or 0 for a syndicated copy (S08 group names another outlet, or the item credits AP, Reuters or AFP) | A wire rewrite adds no reporting of its own |
| complete | 15 full text, 7 dek, 0 headline only | He can read the lead here instead of guessing from a headline |
| depth | 1 per 600 body chars, capped at 10 | More reporting, up to a point; the cap stops a long essay beating a tight report |
| headline | +2 per named entity (max 6), +2 per number of 3+ digits or money (max 4); -4 each for a question, "BREAKING" or all-caps words that are not acronyms, and a phrase on a fixed clickbait list; floor -10 | A headline that says who, what and how many beats one that teases |
| locality | 15 local, 8 intermediate, 0 overseas or unlabeled | The outlet on the ground usually has reporters there |
| first | 10 for the story's first report, falling linearly to 0 at 12 h later | The first report is usually the original; later ones often rewrite it |
| health | 0, or -5 with 3+ consecutive failed runs (S06) | A flaky feed is likelier to serve stale or broken links |
| paywall | -15 when `paywall` is true and there is no full text | A lead he cannot read is a dead end |
| trust | (trust - 1) x the sum above floored at 0, from profile (R10) | His own setting; the default 1.0 adds nothing and he still controls it |

The base maximum is 80. Ties go to the higher base without trust, then the earlier report, then source id. The clickbait list lives in a repo file, `headline_rules.json`, which the owner can read and edit.
Where it runs: every term but trust is a fact, computed in the fetcher (B8) and published per article as `bv`, a fixed-order integer array, only for stories with 2+ outlets (about 150 articles, under 5KB). The device adds the trust term, drops muted sources and picks (B5).
Plain words: the why-this sheet opens with the top three positive terms as fixed phrases, "Leads because: full text, local outlet, first to report", with the full term list under it as S12 shows ranking terms. The carousel orders versions by the same score, lead first.
With S11: ranking scores stories and is unchanged; best version only picks a story's face after ranking and never moves a card. S11's trust term already takes the highest trust among a story's sources, so trust shapes both, separately.
With S13 (R40 answer 7): the lean quota reads the face's lean (cardLean through ctx.leads, which B5 fills). The other-side link may use any unmuted source, and within the lean it picks, it takes the highest-scoring version instead of the newest. Passes never change the face.

## 5. UI

**A bundle** is a story cluster with 2+ independent unmuted outlets (syndicated copies fold into one).
**The card** is today's card, with headline and image from the best version (section 4a). The meta line's S14 "N sources" trigger becomes "+N versions", where N is distinct unmuted outlets minus one. Tapping the headline still opens the lead (reader or link out); tapping "+N versions" opens the carousel.
**The open view** is a full-screen layer like S25's reader, not inline: Home is already a horizontal scroll-snap pager (S27, tabs.js), and a nested swiper would fight tab swipes. Opening pushes a history entry (#bundle-<cluster id>), so back closes it and a "Read" inside returns to the same slide.
- Top bar: close, "Versions", "2 of 7", and the word-mark toggle.
- Index strip: one text chip per outlet, horizontally scrollable, active chip underlined with D3's ink. Tap to jump.
- Track: `scroll-snap-type: x mandatory`, slides 100% wide, `scroll-snap-stop: always`. Native scrolling, no JS drag.
- Slide: outlet name; lean label (S14's LEAN_LABELS) and ownership; Local, Regional or Overseas; relative time; headline in the hero type token; dek; "Read" (S25 reader when has_body) or "Open at <outlet>" (link out); "Also carried by" for syndicated copies; "More from this outlet" when an outlet has 2+ pieces in the story.
- Order: best-version score, lead first, ties as in section 4a.
- Footer: "All versions by lean" opens S14's coverage sheet for the same cluster, and the primary source link when section 3's rule matched.

**Word marks**, a non-AI aid, on by default (R40 answer 8): on bundles of 3+ versions, content words in a headline that appear in no other version's headline are marked, with stopwords dropped and plural s folded. Marks are `<mark>` nodes built with createElement and textContent (R26). Nothing is generated and nothing is scored as biased. No AI-written comparison text anywhere (R13).
Design sweep, required in B6 before a treatment ships: build the options behind a dev flag and compare them, for example a thin underline only on the differing words, a one-step weight change only on those words, marks that appear only after the first swipe, and a one-line key ("Underlined: words only this outlet used"). Never color alone (WCAG 1.4.1). The toggle stays in the top bar and persists in profile. B6 picks one with stated reasons, and the owner can overrule from the screenshots.
**Signals:** opening the carousel counts as opened for the lead's story (R17). Viewing another version records `compared` in local history, which feeds no ranking term, so reading a version to compare never trains his feed.
**Build constraints:** slide text is already in the page (rank-input), so nothing is fetched before paint. Slides are text only with fixed layout, CLS 0. No new connect-src, CSP unchanged (R26). prefers-reduced-motion jumps without smooth scrolling. The region carries aria-roledescription "carousel", slides "slide", and arrow keys move between them. Type and spacing reuse the NYT-measured tokens.

## 6. Rights and ethics

- Headlines, deks and links come from feeds publishers offer for aggregation, polled at the hourly cadence R30 already set.
- Full text only where the feed itself publishes it, and only through bodies/ (R12, S22). Fox, Daily Wire, The Intercept and Jacobin publish full text; RedState, Breitbart, The Federalist, Common Dreams, The New Republic and Democracy Now do not.
- The site is behind Cloudflare Access since R39, so full text in his reader is personal RSS use for every source (R40 answer 9): `full_text_ok` is true for every feed that carries full text, and the 2,000-char cutoff still decides per item. Access must also cover pool.json, bodies/ and preview deployment URLs, since a gap there would be republication; B4 proves it.
- Hotlinking: slides are text only. A new source that leads a card shows its feed-supplied https image under S38/S39's rule, like any source.
- Truth Social stays off under its own terms; the archive is linked, never republished (section 3).
- Leans are labels from published ratings, never scores. There is no "most biased" ranking. Bundle membership, the face and the version order never depend on lean; a test changes only a source's lean and asserts nothing moves.
- Gold fixtures hold real headlines, in the private repo, for testing only.

## 7. Build plan

| name | package | state | tier | deliverable | depends on |
|---|---|---|---|---|---|
| B1 bundle-gold-set | fetcher | PARKED | opus | fixture 1 from today's published pool, landed first; pre-cap candidate dump as a workflow artifact, 2+ more labeled dumps over the following two weeks; story and event id per article; pair precision and recall, purity and B-cubed scorer; CI test pinning today's S07 result as the floor | S07 |
| B2 similarity-v2 | fetcher | PARKED | opus | section 2(a): pairwise lexical score, average-link with blocking and a merge pass, cross-outlet story rule, story inside S32's event, method recorded per cluster | B1 |
| B3 bundle-contract | contract | PARKED | sonnet | pool.schema.json, additive: source `country`, `roster` and `paywall`; article `countries`, `locality` and `bv`; cluster `story_countries` and `primary_source` | S07 |
| B4 source-roster | fetcher | PARKED | sonnet | the section 3 feeds with The New Republic and Democracy Now; the Atom branch for Jacobin; `country`, `paywall` and `roster` for every source; the same per-source caps for all; `full_text_ok` true for every full-text feed; three-tier locality from G1 countries and geo.json `intermediate` | B2, B3 |
| B5 bundle-card | app | PARKED | opus | the face from `bv` plus the trust term, muted sources dropped; "+N versions" mark; "Leads because" in the why-this sheet; lean quota reads the face; other-side link from any unmuted source, best-scored within its lean; must-know unchanged | B8, S11, S13, U2 |
| B6 bundle-carousel | app | PARKED | sonnet | the full-screen versions layer of section 5: slides in score order, index strip, three-tier labels, reader or link out, primary source link, word marks on by default after the design sweep, toggle, S14 jump, compared signal | B5, S14, S25 |
| B8 best-version | fetcher | PARKED | opus | section 4a fact terms per version for stories with 2+ outlets, published as `bv`; `headline_rules.json`; lean and roster never read | B2, B3, B4 |
| B9 truth-archive-link | fetcher | PARKED | sonnet | read the trumpstruth.org feed each run as a lookup only; section 3's match rule; cluster `primary_source` with the archive URL; archive down means no links and a ledger note, never a failed run | B2, B3 |

Best version is its own slice, not inside B5: its fact terms need fetcher code (entity rules, syndication, S06 health, locality), B5 is app, and the queue allows one package per slice. B5 adds only the trust term and the pick. Numbers B1 to B6 are kept so earlier references hold.

What proves them:
- B1: the scorer on today's S07 output lands within 2 points of section 1 (purity 64%); breaking one known-good merge fails CI; floors ratchet as each new fixture lands.
- B2: across all gold fixtures, pair precision >= 0.95, recall >= 0.80, purity >= 0.90; the 21 misses of section 1, kept as a fixture, at least 16 joined; 10,000 synthetic items under 15 s; R29 acceptance tests still pass.
- B3: a pool without the new fields still validates; a `locality` outside local, intermediate and overseas fails; a `bv` of the wrong length fails.
- B4: a Fox-only story publishes like any source's, under the same caps; a saved Jacobin Atom fixture yields entries with title, link, date, dek and a body over 2,000 chars; HKFP on a CN story is intermediate, SCMP on an HK story local, Japan Times on a CN story overseas; a live run stays under 400KB and reports bodies skipped_cap; unauthenticated requests for pool.json, a bodies/ file and a preview deployment URL all get the Access challenge; the ledger invariant holds.
- B5: an NPR and Fox bundle leads with whichever scores higher, and swapping their leans changes nothing; with Fox muted, a Fox-only story never renders and Fox is absent from the carousel and the count; raising NPR's trust to 1.5 flips a close pick and the sheet names trust; "+N" counts unmuted outlets, not articles; listed terms sum to the score.
- B6: headless proof at 360dp: CLS 0 across open, swipe and close; back returns to the same feed scroll; a hostile headline renders as text; an 11-version strip scrolls its active chip into view; screenshots in light and dark of each swept word-mark option and of the chosen one, with the reason it won, and a grayscale capture showing the marks without color.
- B8: a PBS copy of an AP story scores below the AP original; a question headline scores 4 below the same words as a statement; a paywalled teaser scores below a free full-text version; changing only a source's lean or roster changes no term across the gold fixture; agreement with the owner's lead pick on 20 fixture-1 bundles is reported, not gated.
- B9: a fixture where The Hill names Truth Social and quotes 6 words of one archived post gets the link; a 5-word quote, a quote matching two posts, a repost, and a quote without Truth Social named get none.

Not queued: B7 embeddings-term (fetcher, sonnet), only if B2 misses recall; lower priority by R40, free route first (section 2(b)).

## 8. Risks

- Tighter stories split today's 13-outlet Trump-Xi cluster into several smaller ones, which lowers its importance term. Importance and R16 may need to read event breadth (S32) instead of story breadth. Decide in B2; the R29 tests guard it.
- 11 new feeds at about 64 items each add about 700 candidates a run, a small clustering cost. New full-text feeds compete for the bodies byte budget (MAX_TOTAL_BODY_BYTES), so B4 reports skipped_cap.
- Best-version weights are a first guess. Every pick shows its terms, the weights sit in one table, and B8 reports agreement with the owner's picks, so a bad weight is visible and cheap to change.
- Any outlet can now lead, so some fronts will show a Breitbart or Jacobin headline. That is the ruling (answer 2); the lean label on every slide keeps it visible, and U2 turns a source off.
- Word marks can overstate differences on short headlines, hence the 3+ versions rule, the toggle and the design sweep.

## 9. Owner rulings, R40

1. Embeddings: lower priority but possible, ideally free; B7 stays unqueued, free route first, OpenRouter about $0.17 a month as the paid fallback.
2. No source is compare-only: the best version leads, and a better one pushes the rest into the carousel, still valid sources.
3. No fixed bias: pick the best source per story (section 4a); fox_politics stays in feed.
4. Primary source link to the trumpstruth.org archive: yes, when the match is reliable (section 3).
5. Hong Kong outlets are an intermediate tier on mainland China stories (section 4).
6. Add two more left feeds: The New Republic and Democracy Now, plus Atom parsing for Jacobin.
7. The S13 other-side slot and lean quota may use any source.
8. Word marks on by default, after a design sweep for an unobtrusive treatment in B6.
9. Full text in the reader for all sources, now that Access is on (R39).

## 10. Owner rulings, R42

1. Taiwan outlets are the third tier (overseas) on China stories.
2. Malaysian and Singaporean outlets are intermediate on each other's stories.
3. Exile newsrooms are intermediate on the country they cover (`exile_of`).
4. Macau is intermediate on China stories, like Hong Kong.
