# J1: Jev spike, the Ask bar and "Analyse with Jev"

Branch `jev-spike-ask-bar`, 2026-09-29. Jev is TypeSafe's structured-decision model
(`typesafe/jev` on Cloudflare Workers AI). It answers fixed questions with typed values
(choice, score, noul) and never writes text.

## What is built

| Piece | File | What it does |
|---|---|---|
| `/api/jev` | `functions/api/jev.js` | POST `{v:1, state, questions}`. Checks the Access login (same check as `/api/interests`, now shared as `accessIdentity`), same origin, JSON, 16 KB, then validates the question set and state before calling `env.AI.run("typesafe/jev", {state, questions})`. Cleans the answers. No key on the phone, and `connect-src` stays `'self'`. |
| Contract | `app/static/js/jev/contract.js` | The one shape for questions and answers, shared by the function and the phone. A choice outside the question's own criteria, a non-finite number or an unknown key is dropped. |
| Questions | `app/static/js/jev/questions.js` | `STORY_QUESTIONS` (the story analysis) and `askQuestions(profile)` (the Ask bar). The rules for writing a question are in the file's header and are enforced by a test. |
| Ask bar | `app/static/js/jev/ask-bar.js`, `ask.js` | Top of Today. The request goes to Jev, which returns choices over your own sections. That becomes one S19 proposal, which the existing gate checks. A "Jev suggests" sheet offers Apply or Not now. Apply saves one profile version; Undo reverts it. |
| Analyse with Jev | `story.js`, `story-view.js`, the menu item in `story-actions.js` | Overall verdict (Positive, Negative, Mixed or Neutral, with Jev's probabilities), then section, region, kind of story, significance, headline tone, and three "About…" probabilities. Cached per story on the phone. |
| Mock | `app/static/js/jev/mock.js` | `JEV_MOCK=1`: keyword answers in Jev's response shape, for local testing only. |
| Tests | `tests/js/jev.test.js` | Function, contract, gate path, story state and view, question-wording guard. |

## What Jev reads

- **Ask bar:** your request, trimmed to 200 characters, and your section names. Nothing else.
- **Story analysis:**
  - every outlet's headline in the cluster, the summary, the outlet names and the pool's tags;
  - the first 4,000 characters of the article, when the source syndicates full text (the stories with "Read here", 181 of 681 in the pool fetched on 2026-09-29).
- **Never sent:** reading history, trust settings, work rules.

## Rules for writing a question

1. One claim per question. Never "X rather than Y": a low answer could mean "neither".
2. Ask in the positive. No negatives, no double negatives.
3. A noul answer `p` is the probability that the statement as asked is true. **1 − p is not
   the probability of the opposite.** The page shows `p` against the statement it asked and
   never turns it into Yes/No. Anything wanted the other way round gets its own question.
4. A choice lists every allowed answer as a plain description; the page may show a shorter
   name for it (`SENTIMENT_CHOICES`).
5. Only show probabilities Jev actually returned. Never fill in the missing ones.

To add a question: add it to `STORY_QUESTIONS`, give it a label in `STORY_LABELS`, and bump
`STORY_QUESTIONS_VERSION` so answers cached under the old set are asked again.

## Run it locally

Needs Node 22+ and Python 3.10+. From the repo root:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m fetcher.fanout --out dist/pool.json --sources sources.json
.venv/bin/python -m app.build --pool dist/pool.json --out dist
cp .dev.vars.example .dev.vars
npx wrangler@4.137.0 pages dev dist --port 8788 --kv INTERESTS --compatibility-date=2026-09-21
```

- **What the commands do:** the fetch takes about 40 seconds and reads the public feeds, as the hourly job does. For a quick look without it, build from `tests/fixtures/golden_pool.json` instead (5 stories).
- **Open http://localhost:8788:** use a phone-sized window, or Chrome DevTools' device toolbar.
- **Local stand-ins:** `.dev.vars` sets `ACCESS_DEV_EMAIL`, which stands in for the Access login on localhost only, and `JEV_MOCK=1`.
- **After changing code under `app/`:** rerun `app.build`. The service worker caches the old files, so reload twice, or clear site data in DevTools → Application.

**With the real Jev.** Run `npx wrangler login`, delete the `JEV_MOCK=1` line from `.dev.vars`, and add `--ai AI` to the `pages dev` command. Workers AI always runs remotely, so every call is billed to your account.

## Deploying

1. Cloudflare dashboard → Workers & Pages → almanac → Settings → Bindings → add **Workers AI**, variable name `AI`.
2. Merge the branch. `publish.yml` already deploys `functions/` with the site.
3. Leave `JEV_MOCK` and `ACCESS_DEV_EMAIL` unset on the project. `ACCESS_DEV_EMAIL` is ignored off localhost anyway.

## What the spike must still confirm against the real model

- **Noul criteria:** the exact `criteria` shape Jev wants for a noul (we send `[]`).
- **Score answers:** whether a score comes back as a 0..1 position, a 1..n rank, or with
  `probabilities`. `scoreIndex` accepts all three; keep whichever Jev actually sends.
- **Sentiment:** whether Jev returns a probability for every choice. Missing ones are not shown.
- **Latency and cost:** measure both on a real pool (vendor claims 70–500 ms).
- **Accuracy:** from the Jev report below. Nobody labels anything.

## J2: decision rules (`app/static/js/jev/decide.js`)

Every decision reads the whole answer: the pick, Jev's confidence, the probability
spread and the margin between the top two. A choice reads as sure (confidence ≥ 0.6,
top two ≥ 0.15 apart), lean (≥ 0.4), ambiguous (top two within 0.15), unsure, unrated
(no numbers), conflict (the pick is not its own top probability) or missing. The Ask
bar acts on sure picks, takes only the small step (0.05) on lean or unrated ones, asks
"Did you mean" when ambiguous, and weights the step by the whole strength spread. A
yes/no reads likely (≥ 0.7), possible (≥ 0.4) or unlikely for the statement as asked,
or uncertain when Jev's own confidence is under 0.5.

## J3: shadow mode and the Jev report (`fetcher/jev_shadow.py`)

The publish workflow runs it after Fetch. It asks Jev about new articles (newest first,
up to 150 a run) and about known pairs, writes `dist/jev.json`, and the Health screen
shows the report. It never changes the feed and never fails the publish.

- **No hand labels.** It scores against answer keys the pipeline already has:
  - section and region against each source's bucket in `sources.json`, as agreement;
  - syndicated copies (near-duplicate groups) should read same-event, and unrelated
    stories a day apart with no shared tag should not;
  - clinical and industrial biotech both likely is a contradiction;
  - the keyword `ai` tag against Jev's AI question, as four counts with examples.
- **Zero charges**, as the embeddings (B7): Workers Free only, the same pipeline token,
  its own 1,500-neuron daily cap inside the shared 8,000 ceiling, checked against the
  account's measured neurons. The neurons-per-token rate is an estimate, doubled to err
  high, until the first real run reports its tokens.
- **Cache:** `.cache/jev.json` by article and question-set version, kept 96 hours.
- **Local:** `JEV_MOCK=1 .venv/bin/python -m fetcher.jev_shadow --pool dist/pool.json
  --out dist/jev.json`, then rebuild; the report says it came from the stand-in.
- **To check on the first real run:** the model path on the Workers AI REST API
  (`JEV_MODEL`, default `typesafe/jev`), the answer shape, and the tokens it reports.

## J4: OpenRouter

Both the phone's `/api/jev` and the shadow run use OpenRouter first when its key is set,
and Cloudflare Workers AI otherwise (to be added later).

- **Endpoint:** `POST https://openrouter.ai/api/v1/systemone` with `{model, state,
  questions}` and `Authorization: Bearer <key>`. The model is pinned to
  `typesafe/jev-1.13` so tuned thresholds do not drift; `JEV_MODEL` overrides it.
- **Where the key goes (never in the repo, never on the phone):**
  - live site: Cloudflare → Workers & Pages → almanac → Settings → Variables and Secrets
    → Secret `OPENROUTER_API_KEY`, or
    `npx wrangler@4.137.0 pages secret put OPENROUTER_API_KEY --project-name almanac`;
  - hourly shadow run: GitHub → Settings → Secrets and variables → Actions → secret
    `OPENROUTER_API_KEY`; optional variable `JEV_DAILY_USD` (default 0.10);
  - local: `OPENROUTER_API_KEY=` in `.dev.vars` (git ignores it), with `JEV_MOCK` removed.
- **Spend:** the shadow run charges each call OpenRouter's own `usage.cost` against the
  daily dollar cap. Also set a credit limit on the key in OpenRouter's dashboard, so no
  bug can spend more than that.

## J6: confirmed on a real OpenRouter call (2026-09-29)

- `typesafe/jev-1.13` answers (as `typesafe/jev-1.13-20260917`); `typesafe/jev-router`
  does not exist on the System One endpoint.
- **Request:** a choice's `criteria` must be a record (option -> description); a yes/no
  question's must be an object or left out; a score's stay a list of levels. The app
  converts at the edge (`contract.js toWire`, `jev_shadow.to_wire`).
- **Choice answer:** `{choice, probabilities: {option: p, ...every option}, confidence}`.
- **Yes/no answer:** `{noul: p}`, no confidence.
- **Score answer:** `{score: 2.68, legend: {"0": "Minor", ...}, probabilities: {"0": p,
  ...}, confidence}`. The score is a 0-based position; probabilities are keyed by level
  index. The app reads them by index and names them from its own criteria.
- **Cost and speed:** 453 input tokens cost $0.000019 ($0.042 per million, as listed);
  0.58 s for three questions.
