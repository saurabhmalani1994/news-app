"""J3: Jev in shadow mode, and the Jev report. Standard library only (R30).

Each hourly run asks Jev (TypeSafe's structured-decision model on Cloudflare Workers
AI) a fixed set of questions about the pool's new articles, and a same-event question
about pairs whose right answer is already known. Nothing it answers changes the page:
the answers and a report go to dist/jev.json, which the Health screen shows. The report
scores Jev without anyone labelling anything, against answer keys the pipeline already
has:

- Section and region vs each source's own bucket (sources.json): a Singapore feed's
  articles should mostly read Singapore. A bucket is a rough key, so this is reported
  as agreement, per bucket, never as accuracy.
- Same event on known pairs: syndicated copies (the clusterer's near-duplicate groups)
  must read same-event; articles from different stories that share no topic tag and
  were published at least a day apart must not.
- Contradictions: "about clinical medicine" and "about industrial biotech" are two
  separate questions, so both likely on one article is a detectable error.
- Rules vs Jev: the pool's keyword `ai` tag against Jev's own AI question, counted in
  four cells (both, rules only, Jev only, neither), with examples of each disagreement.

Every answer is cleaned as the phone cleans it (app/static/js/jev/contract.js): a choice
outside the question's criteria, a non-finite number or an unknown key is dropped. A
yes/no answer is read only as asked; 1 - p is never taken for the opposite.

Two routes, as functions/api/jev.js (J4):
- OpenRouter, first when OPENROUTER_API_KEY is set: POST /api/v1/systemone, the model
  pinned to typesafe/jev-1.13 (JEV_MODEL overrides). It bills in dollars, so the run
  keeps a daily dollar cap (JEV_DAILY_USD, default DAILY_USD_BUDGET), charging each call
  OpenRouter's own reported usage.cost, or a doubled estimate when it reports none.
- Cloudflare Workers AI, with the pipeline token: zero charges as fetcher/embed.py,
  calling only on a confirmed Workers Free plan, against a daily neuron cap of its own
  (DAILY_NEURON_BUDGET) inside the shared ceiling the embedding term also uses
  (SHARED_CEILING), checked against the account's measured neurons for the day.
Answers are cached by article, question-set version and model in .cache/jev.json, so
only new articles cost anything. JEV_MOCK=1 answers from a keyword stand-in for local
testing and marks the report as mock.

Nothing here prints or logs a key, the token or the account id.
"""
import argparse
import json
import math
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from fetcher import embed

WORKERS_MODEL = "typesafe/jev"
OPENROUTER_MODEL = "typesafe/jev-1.13"
OPENROUTER_URL = "https://openrouter.ai/api/v1/systemone"
OPENROUTER_ENV = "OPENROUTER_API_KEY"
USD_PER_M_TOKENS = 0.042 * 2  # OpenRouter's listed input price, doubled to err high
DAILY_USD_BUDGET = 0.10
QUESTIONS_VERSION = "shadow-v1"
CACHE_PATH = ".cache/jev.json"
CACHE_SCHEMA = 1
CACHE_KEEP_HOURS = 96
# Derived, to confirm on the first real run: $0.042 per million input tokens at Workers
# AI's $0.011 per 1,000 neurons is about 3,800 neurons per million tokens; doubled here
# so the estimate errs high.
NEURONS_PER_M_TOKENS = 7600
DAILY_NEURON_BUDGET = 1500
SHARED_CEILING = 8000  # fetcher/embed.py DAILY_NEURON_BUDGET: the account's own cap
MAX_ARTICLES = 150  # new articles asked per run, newest first
MAX_PAIRS = 20  # known pairs asked per run, positives and negatives each
MAX_SECONDS = 60
TIMEOUT = 20

SECTIONS = ["US politics", "World", "Singapore", "Asia", "AI and technology", "Industrial biotech",
            "Business and economy", "Science and health", "Climate and environment", "Sport",
            "Culture and entertainment", "Other"]
REGIONS = ["Singapore", "Southeast Asia", "East Asia", "South Asia", "United States", "Europe",
           "Middle East", "Africa", "Latin America", "Global"]
SENTIMENTS = ["Good news", "Bad news", "Both good and bad news", "Neither good nor bad news"]

# One claim per question, asked in the positive (the rules in app/static/js/jev/questions.js).
ARTICLE_QUESTIONS = {
    "section": {"type": "choice", "instructions": "Which one section of a news front page does this story belong in?",
                "criteria": SECTIONS},
    "region": {"type": "choice", "instructions": "Which one region is this story mainly about?", "criteria": REGIONS},
    "sentiment": {"type": "choice", "instructions": (
        "For the people and places this story is about, what are the events it reports? Judge the events "
        "themselves. How the headline is worded is a separate question."), "criteria": SENTIMENTS},
    "ai": {"type": "noul", "instructions": (
        "Is this story about artificial intelligence: AI models, AI companies, AI chips, or the rules that "
        "govern AI?"), "criteria": []},
    "clinical": {"type": "noul", "instructions": (
        "Is this story about clinical medicine: drug trials, drug approvals, hospitals or patient care?"),
        "criteria": []},
    "industrial_biotech": {"type": "noul", "instructions": (
        "Is this story about industrial biotechnology: fermentation, enzymes, biomanufacturing, or engineered "
        "microbes or cells that make materials, food, fuels or chemicals?"), "criteria": []},
    "hard_news": {"type": "noul", "instructions": (
        "Is this story about government policy, war or conflict, the economy, science, or public safety?"),
        "criteria": []},
}
PAIR_QUESTIONS = {
    "same_event": {"type": "noul", "instructions": (
        "Do these two headlines report the same news event?"), "criteria": []},
}

# Each source bucket's expected answers: a rough key, reported as agreement. A bucket
# missing here ("general") is not scored.
BUCKET_SECTIONS = {
    "singapore": {"Singapore"}, "us_politics": {"US politics"}, "ai": {"AI and technology"},
    "biotech": {"Industrial biotech", "Science and health"},
    "business": {"Business and economy"}, "science": {"Science and health", "Climate and environment"},
    "climate_food": {"Climate and environment", "Industrial biotech", "Business and economy"},
    "asia": {"Asia", "Singapore"},
    **{b: {"World"} for b in ("africa", "europe", "middle_east", "latin_america", "oceania", "israel_gaza", "sudan")},
}
BUCKET_REGIONS = {
    "singapore": {"Singapore"}, "asia": {"Southeast Asia", "East Asia", "South Asia", "Singapore"},
    "africa": {"Africa"}, "sudan": {"Africa"}, "middle_east": {"Middle East"}, "israel_gaza": {"Middle East"},
    "europe": {"Europe"}, "latin_america": {"Latin America"}, "us_politics": {"United States"},
}

# The same bands as app/static/js/jev/decide.js.
SURE, LEAN, MARGIN, LIKELY, POSSIBLE = 0.6, 0.4, 0.15, 0.7, 0.4


# Answers -------------------------------------------------------------------------------

def _unit(v):
    return min(1.0, max(0.0, float(v))) if isinstance(v, (int, float)) and math.isfinite(v) else None


def clean_answers(questions, raw):
    """{key: {t, v, c?, p?}} for the answers that fit their question (contract.js's rules):
    t the type, v the pick or the probability, c Jev's confidence, p its probabilities."""
    given = raw.get("answers") if isinstance(raw, dict) else None
    given = given if isinstance(given, dict) else {}
    out = {}
    for key, q in questions.items():
        a = given.get(key)
        if not isinstance(a, dict):
            continue
        criteria = q.get("criteria") or []
        if q["type"] == "noul":
            p = _unit(a.get("noul", a.get("value")))
            if p is not None:
                out[key] = {"t": "noul", "v": round(p, 3)}
                c = _unit(a.get("confidence"))
                if c is not None:
                    out[key]["c"] = round(c, 3)
            continue
        pick = a.get("choice", a.get("value"))
        if not isinstance(pick, str) or pick not in criteria:
            continue
        entry = {"t": "choice", "v": pick}
        probs = a.get("probabilities")
        if isinstance(probs, dict):
            kept = {c: round(_unit(probs[c]), 3) for c in criteria if _unit(probs.get(c)) is not None}
            if kept:
                entry["p"] = kept
        c = _unit(a.get("confidence"))
        if c is None and "p" in entry:
            c = entry["p"].get(pick)
        if c is not None:
            entry["c"] = round(c, 3)
        out[key] = entry
    return out


def choice_status(answer):
    """sure, lean, ambiguous, unsure, unrated, conflict or missing (decide.js readChoice)."""
    if not answer or answer.get("t") != "choice":
        return "missing"
    probs = sorted((answer.get("p") or {}).items(), key=lambda kv: -kv[1])
    if probs and probs[0][0] != answer["v"] and probs[0][1] > (answer.get("p") or {}).get(answer["v"], 0):
        return "conflict"
    c = answer.get("c")
    if c is None:
        return "unrated"
    if len(probs) > 1 and probs[0][1] - probs[1][1] < MARGIN:
        return "ambiguous"
    return "sure" if c >= SURE else "lean" if c >= LEAN else "unsure"


def band(answer):
    """likely, possible or unlikely for a yes/no answer as asked, or missing."""
    if not answer or answer.get("t") != "noul":
        return "missing"
    p = answer["v"]
    return "likely" if p >= LIKELY else "possible" if p >= POSSIBLE else "unlikely"


# State for Jev ----------------------------------------------------------------------------

def article_state(article, source_names):
    return {"headline": article.get("title", "")[:300], "summary": (article.get("dek") or "")[:600],
            "outlet": source_names.get(article.get("source_id"), article.get("source_id", ""))}


def pair_state(a, b):
    return {"headline_a": a.get("title", "")[:300], "summary_a": (a.get("dek") or "")[:300],
            "headline_b": b.get("title", "")[:300], "summary_b": (b.get("dek") or "")[:300]}


def known_pairs(pool, rng, limit=MAX_PAIRS):
    """(positives, negatives) as [(id_a, id_b)], sorted ids. Positives: syndicated copies
    in one near-duplicate group. Negatives: two articles from different stories with no
    topic tag in common, published at least 24 hours apart."""
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    positives = set()
    for cluster in pool.get("clusters", []):
        for group in cluster.get("near_duplicates") or []:
            ids = sorted(i for i in group if i in by_id)
            for i in range(len(ids) - 1):
                positives.add((ids[i], ids[i + 1]))
    story_of = {i: c["id"] for c in pool.get("clusters", []) for i in c.get("article_ids", [])}

    def hours(a):
        try:
            return datetime.fromisoformat(a["published_at"].replace("Z", "+00:00")).timestamp() / 3600
        except (KeyError, ValueError, AttributeError):
            return None

    arts = sorted(by_id.values(), key=lambda a: a["id"])
    negatives = set()
    tries = 0
    while len(negatives) < limit and tries < limit * 50 and len(arts) > 1:
        tries += 1
        a, b = rng.sample(arts, 2)
        ha, hb = hours(a), hours(b)
        if ha is None or hb is None or abs(ha - hb) < 24:
            continue
        if story_of.get(a["id"], a["id"]) == story_of.get(b["id"], b["id"]):
            continue
        if set(a.get("topics") or []) & set(b.get("topics") or []):
            continue
        negatives.add(tuple(sorted((a["id"], b["id"]))))
    return sorted(positives)[:limit], sorted(negatives)[:limit]


# Calling Jev ------------------------------------------------------------------------------

class JevError(Exception):
    """A call failed; the message is a short status, never a body, url or token."""


class WorkersJev:
    """Jev on the Workers AI REST API, with the pipeline token. ask() returns
    (answers document, reported input tokens or None, reported cost or None)."""

    def __init__(self, account, token, model=WORKERS_MODEL, timeout=TIMEOUT, post=embed._post_json):
        self.url = embed.API.format(account=account, model=model)
        self.token, self.timeout, self.post = token, timeout, post

    def ask(self, state, questions):
        try:
            doc = self.post(self.url, self.token, {"state": state, "questions": questions}, self.timeout)
        except (OSError, ValueError) as exc:
            raise JevError(embed._status(exc)) from None
        if not isinstance(doc, dict) or not doc.get("success", True):
            raise JevError("bad_response")
        res = doc.get("result", doc)
        if not isinstance(res, dict):
            raise JevError("bad_response")
        usage = res.get("usage") if isinstance(res.get("usage"), dict) else {}
        tokens = usage.get("input_tokens") if isinstance(usage.get("input_tokens"), int) else None
        return res, tokens, None


def to_wire(questions):
    """J6: questions as OpenRouter's System One endpoint validates them (contract.js
    toWire): a choice's criteria a record of option -> description, a yes/no question's
    an object (left out when empty), a score's the ordered list of levels."""
    out = {}
    for key, q in questions.items():
        criteria = list(q.get("criteria") or [])
        base = {"type": q["type"], "instructions": q["instructions"]}
        if q["type"] == "choice":
            out[key] = {**base, "criteria": {c: c for c in criteria}}
        elif q["type"] == "noul":
            out[key] = {**base, "criteria": {c: c for c in criteria}} if criteria else base
        else:
            out[key] = {**base, "criteria": criteria}
    return out


class OpenRouterJev:
    """Jev on OpenRouter's System One endpoint, with the pipeline's OpenRouter key."""

    def __init__(self, key, model=OPENROUTER_MODEL, url=OPENROUTER_URL, timeout=TIMEOUT, post=embed._post_json):
        self.key, self.model, self.url, self.timeout, self.post = key, model, url, timeout, post

    def ask(self, state, questions):
        try:
            doc = self.post(self.url, self.key, {"model": self.model, "state": state, "questions": to_wire(questions)},
                            self.timeout)
        except (OSError, ValueError) as exc:
            raise JevError(embed._status(exc)) from None
        if not isinstance(doc, dict) or not isinstance(doc.get("answers"), dict):
            raise JevError("bad_response")
        usage = doc.get("usage") if isinstance(doc.get("usage"), dict) else {}
        tokens = usage.get("input_tokens") if isinstance(usage.get("input_tokens"), int) else None
        cost = usage.get("cost") if isinstance(usage.get("cost"), (int, float)) and usage["cost"] >= 0 else None
        return doc, tokens, cost


class MockJev:
    """JEV_MOCK=1: keyword answers in Jev's shape, for local plumbing only."""

    WORDS = re.compile(r"[a-z0-9]+")

    def ask(self, state, questions):
        text = " ".join(str(v) for v in state.values()).lower()
        bag = set(self.WORDS.findall(text))
        answers = {}
        for key, q in questions.items():
            if q["type"] == "noul":
                words = set(self.WORDS.findall(q["instructions"].lower())) - {"is", "this", "story", "about", "or", "the"}
                hits = len(words & bag)
                if key == "same_event":
                    a = set(self.WORDS.findall(state.get("headline_a", "").lower()))
                    b = set(self.WORDS.findall(state.get("headline_b", "").lower()))
                    hits = int(10 * len(a & b) / max(1, len(a | b)))
                answers[key] = {"noul": min(0.95, 0.15 + 0.12 * hits)}
                continue
            scores = [(len(set(self.WORDS.findall(c.lower())) & bag), c) for c in q["criteria"]]
            best = max(scores)[1] if max(scores)[0] else q["criteria"][-1]
            rest = (1 - 0.7) / max(1, len(q["criteria"]) - 1)
            answers[key] = {"choice": best, "confidence": 0.7,
                            "probabilities": {c: (0.7 if c == best else rest) for c in q["criteria"]}}
        return {"model": "mock-jev", "answers": answers}, None, None


def estimate_tokens(state, questions):
    return len(json.dumps({"state": state, "questions": questions}).encode("utf-8")) // 3 + 8


def neurons(tokens):
    return tokens * NEURONS_PER_M_TOKENS / 1_000_000


def usd(tokens):
    return tokens * USD_PER_M_TOKENS / 1_000_000


# Cache ------------------------------------------------------------------------------------

def load_cache(path=CACHE_PATH, model=OPENROUTER_MODEL):
    """({"articles": {id: [answers, hour]}, "pairs": {key: [answers, hour]}}, status). A
    different question set or model starts over."""
    empty = {"articles": {}, "pairs": {}}
    p = Path(path)
    if not p.exists():
        return empty, "absent"
    try:
        doc = json.loads(p.read_bytes())
        if doc.get("schema_version") != CACHE_SCHEMA or doc.get("questions") != QUESTIONS_VERSION or doc.get("model") != model:
            return empty, "changed"
        return {"articles": dict(doc.get("articles") or {}), "pairs": dict(doc.get("pairs") or {})}, "hit"
    except (OSError, ValueError, TypeError, AttributeError):
        return empty, "corrupt"


def save_cache(cache, hour, budget, path=CACHE_PATH, model=OPENROUTER_MODEL):
    keep = {kind: {k: v for k, v in sorted(cache[kind].items()) if hour - v[1] <= CACHE_KEEP_HOURS}
            for kind in ("articles", "pairs")}
    body = json.dumps({"schema_version": CACHE_SCHEMA, "questions": QUESTIONS_VERSION, "model": model,
                       "budget": budget, **keep}, separators=(",", ":")).encode("utf-8")
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(body)
    return len(body)


def spent_today(path, day, unit):
    """What this route already spent today, from the cache's own budget record."""
    try:
        prev = json.loads(Path(path).read_bytes()).get("budget")
    except (OSError, ValueError, AttributeError):
        return 0.0
    if isinstance(prev, dict) and prev.get("day") == day and prev.get("unit") == unit:
        spent = prev.get("spent")
        return float(spent) if isinstance(spent, (int, float)) and spent >= 0 else 0.0
    return 0.0


# The run ----------------------------------------------------------------------------------

def ask_all(pool, client, cache, now, used, budget, ceiling_left, pairs, cost=neurons, max_seconds=MAX_SECONDS,
            max_articles=MAX_ARTICLES):
    """Asks the new articles (newest first) and the known pairs, within the budget and the
    time cap. `cost(tokens)` estimates a call in the route's unit (neurons or dollars);
    a call's own reported cost wins over the estimate. Returns stats; answers land in
    `cache` (every item seen gets this hour)."""
    hour = int(now.timestamp() // 3600)
    names = {s["id"]: s.get("name", s["id"]) for s in pool.get("sources", [])}
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    stats = {"state": "ok", "asked": 0, "cached": 0, "errors": 0, "spent": 0.0, "tokens": 0}
    # Known pairs first: few, and they carry the report's surest answer keys.
    todo = []
    positives, negatives = pairs
    for pair in positives + negatives:
        key = "|".join(pair)
        hit = cache["pairs"].get(key)
        if hit:
            hit[1] = hour
            stats["cached"] += 1
        else:
            todo.append(("pairs", key, pair_state(by_id[pair[0]], by_id[pair[1]]), PAIR_QUESTIONS))
    articles = []
    for a in pool.get("articles", []):
        hit = cache["articles"].get(a["id"])
        if hit:
            hit[1] = hour
            stats["cached"] += 1
        else:
            articles.append(("articles", a["id"], article_state(a, names), ARTICLE_QUESTIONS))
    articles.sort(key=lambda t: by_id[t[1]].get("published_at", ""), reverse=True)
    todo += articles[:max_articles]
    start = time.monotonic()
    latencies = []
    for kind, key, state, questions in todo:
        est = estimate_tokens(state, questions)
        if used + stats["spent"] + cost(est) > budget or stats["spent"] + cost(est) > ceiling_left:
            stats["state"] = "budget"
            break
        if time.monotonic() - start > max_seconds:
            stats["state"] = "time_cap"
            break
        t0 = time.monotonic()
        try:
            raw, reported, charged = client.ask(state, questions)
            latencies.append((time.monotonic() - t0) * 1000)
        except JevError:
            stats["errors"] += 1
            stats["spent"] += cost(est)  # a failed call may still be charged
            continue
        tokens = max(est, reported or 0)
        stats["spent"] += charged if charged is not None else cost(tokens)
        stats["tokens"] += tokens
        stats["asked"] += 1
        cache[kind][key] = [clean_answers(questions, raw), hour]
    if stats["errors"] and stats["state"] == "ok":
        stats["state"] = "api_errors"
    stats["latency_ms"] = _percentiles(latencies)
    return stats


def _percentiles(values):
    """{"p50", "p90", "n"} in whole milliseconds, or {"n": 0}."""
    if not values:
        return {"n": 0}
    ordered = sorted(values)
    pick = lambda q: round(ordered[min(len(ordered) - 1, int(q * len(ordered)))])
    return {"p50": pick(0.5), "p90": pick(0.9), "n": len(ordered)}


def load_buckets(path="sources.json"):
    """{source id: bucket} from the repo's sources.json (the pool carries no bucket)."""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    rows = doc.get("sources", doc) if isinstance(doc, dict) else doc
    return {r["id"]: r.get("bucket") for r in rows if isinstance(r, dict) and "id" in r}


def report(pool, cache, pairs, buckets=None):
    """The Jev report for the articles and known pairs in this pool (see the module doc)."""
    buckets = buckets if buckets is not None else load_buckets()
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    answered = {i: cache["articles"][i][0] for i in by_id if i in cache["articles"]}

    def agreement(expected_map, key):
        per = {}
        for i, ans in answered.items():
            bucket = buckets.get(by_id[i]["source_id"])
            want = expected_map.get(bucket)
            a = ans.get(key)
            if not want or choice_status(a) not in ("sure", "lean", "unrated"):
                continue
            row = per.setdefault(bucket, [0, 0])
            row[0] += a["v"] in want
            row[1] += 1
        total = [sum(r[0] for r in per.values()), sum(r[1] for r in per.values())]
        return {"agree": total[0], "scored": total[1],
                "by_bucket": {b: {"agree": r[0], "scored": r[1]} for b, r in sorted(per.items())}}

    statuses = {}
    for ans in answered.values():
        for key in ("section", "region", "sentiment"):
            s = choice_status(ans.get(key))
            statuses[s] = statuses.get(s, 0) + 1

    both = sum(1 for ans in answered.values() if band(ans.get("clinical")) == "likely"
               and band(ans.get("industrial_biotech")) == "likely")

    cells = {"both": 0, "rules_only": 0, "jev_only": 0, "neither": 0}
    examples = {"rules_only": [], "jev_only": []}
    for i, ans in answered.items():
        if "ai" not in ans:
            continue
        rule = "ai" in (by_id[i].get("topics") or [])
        jev = band(ans["ai"]) == "likely"
        cell = "both" if rule and jev else "rules_only" if rule else "jev_only" if jev else "neither"
        cells[cell] += 1
        if cell in examples and len(examples[cell]) < 5:
            examples[cell].append({"id": i, "title": by_id[i].get("title", "")[:140]})

    positives, negatives = pairs
    pos = [cache["pairs"].get("|".join(p), [{}])[0].get("same_event") for p in positives]
    neg = [cache["pairs"].get("|".join(p), [{}])[0].get("same_event") for p in negatives]
    pos = [a for a in pos if a]
    neg = [a for a in neg if a]

    return {
        "articles_answered": len(answered),
        "articles_in_pool": len(by_id),
        "section_vs_bucket": agreement(BUCKET_SECTIONS, "section"),
        "region_vs_bucket": agreement(BUCKET_REGIONS, "region"),
        "confidence": statuses,
        "clinical_and_industrial_both_likely": both,
        "ai_rules_vs_jev": {**cells, "examples": examples},
        "same_event_known": {
            "syndicated_pairs": len(pos), "syndicated_read_same": sum(band(a) == "likely" for a in pos),
            "unrelated_pairs": len(neg), "unrelated_read_different": sum(band(a) == "unlikely" for a in neg),
        },
    }


def run(pool, now, env=None, cache_path=CACHE_PATH, post=embed._post_json, get=embed._get_json,
        max_seconds=MAX_SECONDS, max_articles=MAX_ARTICLES, daily_usd=None):
    """The step's entry point: the jev.json document (report plus compact answers)."""
    env = os.environ if env is None else env
    pairs = known_pairs(pool, random.Random(pool.get("generated_at", "")))
    day = now.strftime("%Y-%m-%d")
    mock = env.get("JEV_MOCK") == "1"
    measured = None
    if mock:
        route, model, unit, budget, cost = "mock", "mock-jev", "neurons", DAILY_NEURON_BUDGET, neurons
        client, ceiling_left, plan = MockJev(), float("inf"), "mock"
    elif env.get(OPENROUTER_ENV):
        route, model, unit, cost = "openrouter", env.get("JEV_MODEL") or OPENROUTER_MODEL, "usd", usd
        try:
            budget = max(0.0, float(daily_usd if daily_usd is not None else env.get("JEV_DAILY_USD") or DAILY_USD_BUDGET))
        except ValueError:
            budget = DAILY_USD_BUDGET
        client = OpenRouterJev(env[OPENROUTER_ENV], model=model, post=post)
        ceiling_left, plan = float("inf"), "openrouter"
    else:
        route, model, unit, budget, cost = "workers", env.get("JEV_MODEL") or WORKERS_MODEL, "neurons", DAILY_NEURON_BUDGET, neurons
        token, account = env.get(embed.TOKEN_ENV, ""), env.get(embed.ACCOUNT_ENV, "")
        client, plan = None, "no_key" if not token else "no_account" if not account else None
        if plan is None:
            plan = embed.check_plan(account, token, get=get)
            if plan == "free":
                client = WorkersJev(account, token, model=model, post=post)
                measured = embed.measured_neurons(account, token, day, post=post)
        ceiling_left = SHARED_CEILING - (measured or 0.0)
    cache, cache_status = load_cache(cache_path, model)
    used = spent_today(cache_path, day, unit) if cache_status == "hit" else 0.0
    if client is None:
        stats = {"state": f"skipped_{plan}", "asked": 0, "cached": 0, "errors": 0, "spent": 0.0, "tokens": 0,
                 "latency_ms": {"n": 0}}
    else:
        stats = ask_all(pool, client, cache, now, used, budget, ceiling_left, pairs, cost=cost, max_seconds=max_seconds,
                        max_articles=max_articles)
    budget_state = {"day": day, "unit": unit, "spent": round(used + stats["spent"], 6)}
    cache_bytes = save_cache(cache, int(now.timestamp() // 3600), budget_state, cache_path, model) if client else 0
    ids = {a["id"] for a in pool.get("articles", [])}
    doc = {
        "schema_version": 1,
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": model,
        "route": route,
        "mock": mock,
        "questions": QUESTIONS_VERSION,
        "run": {**stats, "plan": plan, "cache": cache_status, "cache_bytes": cache_bytes, "unit": unit,
                "spent_day": budget_state["spent"], "budget_day": budget, "neurons_measured_before": measured},
        "report": report(pool, cache, pairs),
        "answers": {i: cache["articles"][i][0] for i in sorted(ids) if i in cache["articles"]},
    }
    doc["scorecard"] = scorecard(doc)
    return doc


# The scorecard ----------------------------------------------------------------------------
# Targets fixed before any real answers, so a result cannot move them. A check with fewer
# than `min` items reads "not enough data" rather than pass or fail. Each check belongs
# to the feature it would unlock; a feature is ready when every one of its checks passes.

STRONG_SECTION_BUCKETS = ("singapore", "us_politics", "ai")
REGIONAL_BUCKETS = ("singapore", "asia", "africa", "sudan", "middle_east", "israel_gaza", "europe", "latin_america")
CHECKS = (
    # key, label, feature, direction, target, minimum sample
    ("same_event", "Syndicated copies read as the same event", "Versions and other side", ">=", 0.90, 5),
    ("different_event", "Unrelated pairs read as different events", "Versions and other side", ">=", 0.95, 10),
    ("section", "Section matches single-topic feeds (Singapore, US politics, AI)", "Tabs and tags", ">=", 0.80, 20),
    ("region", "Region matches regional feeds", "Tabs and tags", ">=", 0.75, 20),
    ("contradictions", "Clinical and industrial biotech both likely", "Analysis sheet", "<=", 0.02, 50),
    ("sure", "Choice answers Jev was sure of", "Analysis sheet", ">=", 0.60, 50),
    ("ambiguous", "Choice answers too close to call", "Analysis sheet", "<=", 0.15, 50),
    ("latency", "Slowest 1 in 10 calls (ms)", "Ask bar", "<=", 1500, 20),
    ("cost", "Cost per 1,000 articles (USD)", "Hourly shadow run", "<=", 0.50, 20),
)


def _sums(by_bucket, names):
    rows = [by_bucket.get(b, {"agree": 0, "scored": 0}) for b in names]
    return sum(r["agree"] for r in rows), sum(r["scored"] for r in rows)


def scorecard(doc):
    """{"checks": [{key, label, feature, value, target, direction, n, status}],
    "features": {feature: ready | not_ready | not_enough_data}, "mock": bool}."""
    rep, run = doc["report"], doc.get("run") or {}
    same = rep["same_event_known"]
    conf = rep.get("confidence") or {}
    choice_n = sum(conf.values())
    sec = _sums(rep["section_vs_bucket"]["by_bucket"], STRONG_SECTION_BUCKETS)
    reg = _sums(rep["region_vs_bucket"]["by_bucket"], REGIONAL_BUCKETS)
    latency = run.get("latency_ms") or {"n": 0}
    asked = run.get("asked", 0)
    cost_known = run.get("unit") == "usd" and asked
    values = {
        "same_event": (same["syndicated_read_same"], same["syndicated_pairs"]),
        "different_event": (same["unrelated_read_different"], same["unrelated_pairs"]),
        "section": sec,
        "region": reg,
        "contradictions": (rep["clinical_and_industrial_both_likely"], rep["articles_answered"]),
        "sure": (conf.get("sure", 0), choice_n),
        "ambiguous": (conf.get("ambiguous", 0), choice_n),
        "latency": (latency.get("p90"), latency.get("n", 0)),
        "cost": ((run.get("spent", 0) / asked * 1000) if cost_known else None, asked if cost_known else 0),
    }
    checks = []
    for key, label, feature, direction, target, minimum in CHECKS:
        part, n = values[key]
        if key in ("latency", "cost"):
            value = part
        else:
            value = part / n if n else None
        if value is None or n < minimum:
            status = "not_enough_data"
        else:
            ok = value >= target if direction == ">=" else value <= target
            status = "pass" if ok else "fail"
        checks.append({"key": key, "label": label, "feature": feature, "value": value, "target": target,
                       "direction": direction, "n": n, "status": status})
    features = {}
    for c in checks:
        now = features.get(c["feature"], "ready")
        if c["status"] == "fail":
            features[c["feature"]] = "not_ready"
        elif c["status"] == "not_enough_data" and now != "not_ready":
            features[c["feature"]] = "not_enough_data"
        else:
            features.setdefault(c["feature"], now)
    return {"checks": checks, "features": features, "mock": bool(doc.get("mock"))}


def scorecard_text(card):
    """The scorecard as plain lines for a terminal."""
    def fmt(c):
        if c["value"] is None:
            return "n/a"
        if c["key"] == "latency":
            return f"{c['value']:.0f}"
        if c["key"] == "cost":
            return f"${c['value']:.3f}"
        return f"{100 * c['value']:.0f}%"

    def tgt(c):
        if c["key"] == "latency":
            return f"{c['direction']} {c['target']}"
        if c["key"] == "cost":
            return f"{c['direction']} ${c['target']:.2f}"
        return f"{c['direction']} {100 * c['target']:.0f}%"

    word = {"pass": "PASS", "fail": "FAIL", "not_enough_data": "NOT ENOUGH DATA"}
    lines = ["Jev scorecard" + (" (MOCK ANSWERS: plumbing only, not the real model)" if card["mock"] else "")]
    for c in card["checks"]:
        lines.append(f"  {word[c['status']]:<16} {c['label']}: {fmt(c)} (target {tgt(c)}, n={c['n']})")
    lines.append("Features:")
    ready = {"ready": "ready", "not_ready": "not ready", "not_enough_data": "not enough data yet"}
    for feature, state in card["features"].items():
        lines.append(f"  {feature}: {ready[state]}")
    return "\n".join(lines)


def log_line(doc):
    """One line for the public log: counts and statuses only."""
    r, rep = doc["run"], doc["report"]
    sec = rep["section_vs_bucket"]
    same = rep["same_event_known"]
    return (f"jev route={doc['route']} model={doc['model']} plan={r['plan']} state={r['state']} asked={r['asked']} "
            f"cached={r['cached']} errors={r['errors']} unit={r['unit']} spent_run={r['spent']:.4f} "
            f"spent_day={r['spent_day']:.4f} budget_day={r['budget_day']} "
            f"answered={rep['articles_answered']}/{rep['articles_in_pool']} "
            f"section_agree={sec['agree']}/{sec['scored']} "
            f"same_event={same['syndicated_read_same']}/{same['syndicated_pairs']} "
            f"different_event={same['unrelated_read_different']}/{same['unrelated_pairs']} "
            f"contradictions={rep['clinical_and_industrial_both_likely']}")


def main(argv=None):
    ap = argparse.ArgumentParser(description="J3: Jev shadow run and report")
    ap.add_argument("--pool", default="dist/pool.json")
    ap.add_argument("--out", default="dist/jev.json")
    ap.add_argument("--cache", default=CACHE_PATH, help="answers cache (a one-off evaluation can use its own)")
    ap.add_argument("--max-articles", type=int, default=MAX_ARTICLES, help="new articles asked this run")
    ap.add_argument("--daily-usd", type=float, default=None, help="OpenRouter dollar cap for today")
    ap.add_argument("--max-seconds", type=int, default=MAX_SECONDS)
    ap.add_argument("--scorecard", action="store_true", help="print the scorecard after the run")
    args = ap.parse_args(argv)
    pool = json.loads(Path(args.pool).read_text(encoding="utf-8"))
    doc = run(pool, datetime.now(timezone.utc), cache_path=args.cache, max_seconds=args.max_seconds,
              max_articles=args.max_articles, daily_usd=args.daily_usd)
    Path(args.out).write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(log_line(doc))
    if args.scorecard:
        print(scorecard_text(doc["scorecard"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
