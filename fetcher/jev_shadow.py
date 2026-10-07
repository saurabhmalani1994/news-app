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

J20: the same step also asks, for every story group (cluster), whether each member
reports the same event as the group's anchor (the member whose headline shares most
with the others) and how it frames it. With --apply it then rewrites the pool before
the build: a member Jev reads as a different event (same-event below SPLIT_BELOW) is
split out of its group to stand as its own story, and every answered member carries
`jev: {same, framing}` for the other-side pick (app/static/js/passes.js). The new pool
must pass contract.validate before it replaces the old one, written atomically, so this
step can never break a publish.

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
TOTAL_DAILY_USD = 0.30  # owner, 2026-09-30: every Jev use together
PHONE_DAILY_USD = 0.05  # functions/api/jev.js's lane: the Ask bar, Jev's read, Read with Jev
DAILY_USD_BUDGET = round(TOTAL_DAILY_USD - PHONE_DAILY_USD, 2)  # J25: the hourly run's lane
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
MAX_ARTICLES = 250  # new articles asked per run, newest first
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
# J28: Jev reads the articles near the keep rule's cut (fetcher/keep_rule.py
# triage_items, .cache/triage.json from the fetch step) and its answers feed the next
# hour's keep rule (keep_rule.jev_points), counted only once its opinion check passes.
TRIAGE_VERSION = "triage-v1"
TRIAGE_PATH = ".cache/triage.json"
# J35: 0.3, not 0.4: the first real day spent $0.14 of the main $0.15 by 18:00 UTC while the
# triage had used $0.04 of its $0.10, so the main share was stopping early with money left.
TRIAGE_SHARE = 0.3  # of the hourly lane; the story checks and article answers keep the rest
TRIAGE_PER_RUN = 100
TRIAGE_KINDS = ["Original news reporting", "Analysis or explainer", "Opinion or commentary",
                "A summary of other outlets' reporting", "A press release or company announcement", "None of these"]
TRIAGE_QUESTIONS = {
    "kind": {"type": "choice", "instructions": "What kind of article is this?", "criteria": TRIAGE_KINDS},
    "sourced": {"type": "noul", "instructions": (
        "Does the headline or summary name where its information comes from, such as an official, a document, "
        "a study or the outlet's own reporters?"), "criteria": []},
}
PAIR_QUESTIONS = {
    "same_event": {"type": "noul", "instructions": (
        "Do these two headlines report the same news event?"), "criteria": []},
}

# J20: a group member against its anchor: the same event, and how it frames it.
SPLIT_BELOW = 0.3
FRAMING_CHOICES = (
    ("Reports the same facts in the same way", "same"),
    ("Reports the same facts with a different emphasis", "emphasis"),
    ("Adds a fact the first headline leaves out", "adds"),
    ("Leaves out a fact the first headline has", "omits"),
    ("Reports a different event", "different"),
)
FRAMING_CODE = dict(FRAMING_CHOICES)
CLUSTER_PAIR_QUESTIONS = {
    "same_event": PAIR_QUESTIONS["same_event"],
    "framing": {"type": "choice", "instructions": "Compared with the first headline, what does the second headline do?",
                "criteria": [asked for asked, _ in FRAMING_CHOICES]},
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


# J35: two trials that only measure (owner, 2026-10-06, after the first real evaluation
# showed Jev's same-event answers right on every known pair and its yes/no AI answer
# agreeing with every rule tag while finding more).
#
# Merge trial: story pairs the rules left apart whose headlines share many words (near
# misses). Jev is asked whether each pair is one event; the report counts how many it
# would join. Nothing is joined.
MERGE_MIN_SHARED = 0.25  # share of headline words in common (Jaccard), at least 3 words
MERGE_WINDOW_H = 48
MERGE_PAIRS = 40  # near misses looked at each run
MERGE_NEW_PER_RUN = 20  # new ones asked each run, after everything else
#
# Topic trial: Jev's yes/no topic answers (already asked every hour) against outlets that
# cover one subject. own: of that subject's outlets' articles, how many Jev says are
# about it. other: of articles from outlets about something else entirely, how many Jev
# says are about it (false alarms). adds and drops: what would change if Jev's answer set
# the tag. No tag is changed.
TOPIC_TRIAL = {
    "ai": {"keys": ("ai",), "own": ("ai",), "tag": "ai"},
    "biotech": {"keys": ("industrial_biotech", "clinical"), "own": ("biotech",), "tag": "biotech"},
}
TOPIC_OTHER_BUCKETS = ("sudan", "israel_gaza", "africa", "latin_america", "middle_east", "oceania", "europe")


def _hours(article):
    try:
        return datetime.fromisoformat(article["published_at"].replace("Z", "+00:00")).timestamp() / 3600
    except (KeyError, ValueError, AttributeError):
        return None


def near_miss_pairs(pool, limit=MERGE_PAIRS):
    """[(cache key "m:<a>|<b>", id_a, id_b, shared)] for the story pairs the rules left
    apart whose headlines share the most words: one headline per story (a group's anchor,
    or the article itself), within MERGE_WINDOW_H of each other, most shared first."""
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    grouped = set()
    reps = []
    for c in pool.get("clusters", []):
        ids = [i for i in c.get("article_ids", []) if i in by_id]
        grouped.update(ids)
        if ids:
            reps.append(by_id[cluster_anchor({"article_ids": ids}, by_id)])
    reps += [a for a in by_id.values() if a["id"] not in grouped]
    words = {a["id"]: _title_words(a) for a in reps}
    index = {}
    for a in reps:
        for w in words[a["id"]]:
            index.setdefault(w, []).append(a["id"])
    seen, out = set(), []
    for ids in index.values():
        if len(ids) > 60:  # a word this common says nothing about one event
            continue
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = sorted((ids[i], ids[j]))
                if (a, b) in seen:
                    continue
                seen.add((a, b))
                wa, wb = words[a], words[b]
                shared = len(wa & wb) / max(1, len(wa | wb))
                if shared < MERGE_MIN_SHARED or len(wa & wb) < 3:
                    continue
                ha, hb = _hours(by_id[a]), _hours(by_id[b])
                if ha is None or hb is None or abs(ha - hb) > MERGE_WINDOW_H:
                    continue
                out.append((f"m:{a}|{b}", a, b, round(shared, 3)))
    out.sort(key=lambda t: (-t[3], t[0]))
    return out[:limit]


def merge_trial(pool, cache, merges):
    """How Jev reads this run's near misses: {"pairs", "same", "different", "unsure",
    "examples"}; same is same_event likely, the pairs Jev would join."""
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    names = {s["id"]: s.get("name", s["id"]) for s in pool.get("sources", [])}
    out = {"near_misses": len(merges), "pairs": 0, "same": 0, "different": 0, "unsure": 0, "examples": []}
    for key, a, b, shared in merges:
        ans = (cache["pairs"].get(key) or [{}])[0].get("same_event")
        if not ans:
            continue
        out["pairs"] += 1
        kind = band(ans)
        out["same" if kind == "likely" else "different" if kind == "unlikely" else "unsure"] += 1
        if kind == "likely" and len(out["examples"]) < 4:
            out["examples"].append({
                "a": {"id": a, "title": by_id[a].get("title", "")[:140], "source": names.get(by_id[a]["source_id"], by_id[a]["source_id"])},
                "b": {"id": b, "title": by_id[b].get("title", "")[:140], "source": names.get(by_id[b]["source_id"], by_id[b]["source_id"])},
                "p": ans["v"]})
    return out


def topic_trial(answered, by_id, buckets):
    """{topic: {"own": [hits, n], "other": [hits, n], "adds", "drops"}} (see TOPIC_TRIAL)."""
    out = {}
    for topic, spec in TOPIC_TRIAL.items():
        own, other, adds, drops = [0, 0], [0, 0], 0, 0
        for i, ans in answered.items():
            bands = [band(ans.get(k)) for k in spec["keys"] if k in ans]
            if not bands:
                continue
            says = "likely" in bands
            bucket = buckets.get(by_id[i]["source_id"])
            if bucket in spec["own"]:
                own[0] += says
                own[1] += 1
            elif bucket in TOPIC_OTHER_BUCKETS:
                other[0] += says
                other[1] += 1
            tagged = spec["tag"] in (by_id[i].get("topics") or [])
            adds += says and not tagged
            drops += tagged and all(b == "unlikely" for b in bands)
        out[topic] = {"own": own, "other": other, "adds": adds, "drops": drops}
    return out


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


_STOP = {"the", "and", "for", "with", "from", "that", "this", "after", "over", "says", "said", "into", "about", "its"}


def _title_words(article):
    return set(re.findall(r"[a-z0-9]{3,}", (article.get("title") or "").lower())) - _STOP


def cluster_anchor(cluster, by_id):
    """The member whose headline shares most words with the others' (ties: lowest id)."""
    members = [by_id[i] for i in cluster["article_ids"] if i in by_id]
    words = {a["id"]: _title_words(a) for a in members}

    def score(a):
        mine = words[a["id"]]
        return sum(len(mine & words[b["id"]]) / max(1, len(mine | words[b["id"]])) for b in members if b is not a)
    return max(members, key=lambda a: (score(a), [-ord(ch) for ch in a["id"]]))["id"]


def cluster_pairs(pool):
    """[(cache key, anchor id, member id)] for every non-anchor member of every group."""
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    out = []
    for c in pool.get("clusters", []):
        anchor = cluster_anchor(c, by_id)
        for m in c["article_ids"]:
            if m != anchor and m in by_id:
                out.append((f"c:{anchor}|{m}", anchor, m))
    return out


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


def openrouter_key(env):
    """J7: the OpenRouter key with pasted spaces, line breaks and wrapping quotes removed."""
    return str(env.get(OPENROUTER_ENV) or "").strip().strip("\"'").strip()


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
    empty = {"articles": {}, "pairs": {}, "triage": {}}
    p = Path(path)
    if not p.exists():
        return empty, "absent"
    try:
        doc = json.loads(p.read_bytes())
        if doc.get("schema_version") != CACHE_SCHEMA or doc.get("questions") != QUESTIONS_VERSION or doc.get("model") != model:
            return empty, "changed"
        # J28: the triage answers have their own question version.
        triage = dict(doc.get("triage") or {}) if doc.get("triage_questions") == TRIAGE_VERSION else {}
        return {"articles": dict(doc.get("articles") or {}), "pairs": dict(doc.get("pairs") or {}), "triage": triage}, "hit"
    except (OSError, ValueError, TypeError, AttributeError):
        return empty, "corrupt"


def save_cache(cache, hour, budget, path=CACHE_PATH, model=OPENROUTER_MODEL):
    keep = {kind: {k: v for k, v in sorted(cache.get(kind, {}).items()) if hour - v[1] <= CACHE_KEEP_HOURS}
            for kind in ("articles", "pairs", "triage")}
    body = json.dumps({"schema_version": CACHE_SCHEMA, "questions": QUESTIONS_VERSION, "triage_questions": TRIAGE_VERSION,
                       "model": model, "budget": budget, **keep}, separators=(",", ":")).encode("utf-8")
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(body)
    return len(body)


def spent_today(path, day, unit, field="spent"):
    """What this route already spent today, from the cache's own budget record (J28:
    field "triage_spent" for the triage share)."""
    try:
        prev = json.loads(Path(path).read_bytes()).get("budget")
    except (OSError, ValueError, AttributeError):
        return 0.0
    if isinstance(prev, dict) and prev.get("day") == day and prev.get("unit") == unit:
        spent = prev.get(field)
        return float(spent) if isinstance(spent, (int, float)) and spent >= 0 else 0.0
    return 0.0


def load_triage(path=TRIAGE_PATH):
    """J28: the fetch step's reading list, [{id, headline, summary, outlet}], or []."""
    try:
        items = json.loads(Path(path).read_text(encoding="utf-8")).get("items")
    except (OSError, ValueError, AttributeError):
        return []
    return [i for i in items if isinstance(i, dict) and isinstance(i.get("id"), str)] if isinstance(items, list) else []


def ask_triage(items, client, cache, now, used, budget, ceiling_left, cost, max_seconds=MAX_SECONDS, per_run=TRIAGE_PER_RUN):
    """J28: asks TRIAGE_QUESTIONS about up to per_run items Jev has not read, in the
    list's order, within the triage share of the budget. Answers land in cache["triage"]."""
    hour = int(now.timestamp() // 3600)
    stats = {"state": "ok", "asked": 0, "cached": 0, "errors": 0, "spent": 0.0, "tokens": 0}
    todo = []
    for item in items:
        hit = cache["triage"].get(item["id"])
        if hit:
            hit[1] = hour
            stats["cached"] += 1
        elif len(todo) < per_run:
            todo.append(item)
    start = time.monotonic()
    for item in todo:
        state = {"headline": str(item.get("headline", ""))[:300], "summary": str(item.get("summary", ""))[:300],
                 "outlet": str(item.get("outlet", ""))[:80]}
        est = estimate_tokens(state, TRIAGE_QUESTIONS)
        if used + stats["spent"] + cost(est) > budget or stats["spent"] + cost(est) > ceiling_left:
            stats["state"] = "budget"
            break
        if time.monotonic() - start > max_seconds:
            stats["state"] = "time_cap"
            break
        try:
            raw, reported, charged = client.ask(state, TRIAGE_QUESTIONS)
        except JevError as exc:
            stats["errors"] += 1
            stats.setdefault("first_error", str(exc))
            stats["spent"] += cost(est)
            continue
        tokens = max(est, reported or 0)
        stats["spent"] += charged if charged is not None else cost(tokens)
        stats["tokens"] += tokens
        stats["asked"] += 1
        cache["triage"][item["id"]] = [clean_answers(TRIAGE_QUESTIONS, raw), hour]
    if stats["errors"] and stats["state"] == "ok":
        stats["state"] = "api_errors"
    return stats


# The run ----------------------------------------------------------------------------------

def ask_all(pool, client, cache, now, used, budget, ceiling_left, pairs, cost=neurons, max_seconds=MAX_SECONDS,
            max_articles=MAX_ARTICLES, groups=(), merges=()):
    """Asks the new articles (newest first) and the known pairs, within the budget and the
    time cap. `cost(tokens)` estimates a call in the route's unit (neurons or dollars);
    a call's own reported cost wins over the estimate. Returns stats; answers land in
    `cache` (every item seen gets this hour)."""
    hour = int(now.timestamp() // 3600)
    names = {s["id"]: s.get("name", s["id"]) for s in pool.get("sources", [])}
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    stats = {"state": "ok", "asked": 0, "cached": 0, "errors": 0, "spent": 0.0, "tokens": 0}
    # J20: group members against their anchor first (they change what the page shows),
    # then the known pairs (the report's surest answer keys), then new articles.
    todo = []
    for key, anchor, member in groups:
        hit = cache["pairs"].get(key)
        if hit:
            hit[1] = hour
            stats["cached"] += 1
        else:
            todo.append(("pairs", key, pair_state(by_id[anchor], by_id[member]), CLUSTER_PAIR_QUESTIONS))
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
    # J35: the merge trial's near misses, last, so it only ever spends what is left.
    fresh = 0
    for key, a, b, _shared in merges:
        hit = cache["pairs"].get(key)
        if hit:
            hit[1] = hour
            stats["cached"] += 1
        elif fresh < MERGE_NEW_PER_RUN:
            fresh += 1
            todo.append(("pairs", key, pair_state(by_id[a], by_id[b]), PAIR_QUESTIONS))
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
        except JevError as exc:
            stats["errors"] += 1
            stats.setdefault("first_error", str(exc))  # a short status (http_401), never a body or key
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


def report(pool, cache, pairs, buckets=None, merges=None):
    """The Jev report for the articles and known pairs in this pool (see the module doc)."""
    buckets = buckets if buckets is not None else load_buckets()
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    answered = {i: cache["articles"][i][0] for i in by_id if i in cache["articles"]}

    names = {s["id"]: s.get("name", "") for s in pool.get("sources", [])}

    def article_ref(i):
        a = by_id[i]
        return {"id": i, "title": a.get("title", "")[:140], "source": names.get(a["source_id"], a["source_id"])}

    def agreement(expected_map, key):
        """J22: also one article it matched and one it missed per bucket, so Health can
        show a real example beside each number."""
        per, ex = {}, {}
        for i in sorted(answered):
            ans = answered[i]
            bucket = buckets.get(by_id[i]["source_id"])
            want = expected_map.get(bucket)
            a = ans.get(key)
            if not want or choice_status(a) not in ("sure", "lean", "unrated"):
                continue
            row = per.setdefault(bucket, [0, 0])
            hit = a["v"] in want
            row[0] += hit
            row[1] += 1
            slot = ex.setdefault(bucket, {})
            if ("hit" if hit else "miss") not in slot:
                slot["hit" if hit else "miss"] = {**article_ref(i), "expected": sorted(want)[0], "got": a["v"]}
        total = [sum(r[0] for r in per.values()), sum(r[1] for r in per.values())]
        return {"agree": total[0], "scored": total[1],
                "by_bucket": {b: {"agree": r[0], "scored": r[1], **({"examples": ex[b]} if b in ex else {})}
                              for b, r in sorted(per.items())}}

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
    def pair_examples(pairs_list, good):
        """J22: one pair Jev read as expected and one it did not, as titles."""
        out = {}
        for p in pairs_list:
            a = cache["pairs"].get("|".join(p), [{}])[0].get("same_event")
            if not a or not all(x in by_id for x in p):
                continue
            slot = "hit" if band(a) == good else "miss"
            if slot not in out:
                out[slot] = {"a": article_ref(p[0]), "b": article_ref(p[1]), "p": a["v"]}
            if len(out) == 2:
                break
        return out

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
        # J35: the two trials; they only measure.
        "merge_trial": merge_trial(pool, cache, merges if merges is not None else near_miss_pairs(pool)),
        "topic_trial": topic_trial(answered, by_id, buckets),
        "same_event_known": {
            "syndicated_pairs": len(pos), "syndicated_read_same": sum(band(a) == "likely" for a in pos),
            "unrelated_pairs": len(neg), "unrelated_read_different": sum(band(a) == "unlikely" for a in neg),
            "examples": {"same": pair_examples(positives, "likely"), "different": pair_examples(negatives, "unlikely")},
        },
    }


def run(pool, now, env=None, cache_path=CACHE_PATH, post=embed._post_json, get=embed._get_json,
        max_seconds=MAX_SECONDS, max_articles=MAX_ARTICLES, daily_usd=None, triage_path=None):
    """The step's entry point: the jev.json document (report plus compact answers)."""
    env = os.environ if env is None else env
    pairs = known_pairs(pool, random.Random(pool.get("generated_at", "")))
    day = now.strftime("%Y-%m-%d")
    mock = env.get("JEV_MOCK") == "1"
    measured = None
    if mock:
        route, model, unit, budget, cost = "mock", "mock-jev", "neurons", DAILY_NEURON_BUDGET, neurons
        client, ceiling_left, plan = MockJev(), float("inf"), "mock"
    elif openrouter_key(env):
        route, model, unit, cost = "openrouter", env.get("JEV_MODEL") or OPENROUTER_MODEL, "usd", usd
        try:
            # J25: never above the hourly lane, whatever JEV_DAILY_USD asks for, so the
            # hourly run and the phone together stay within TOTAL_DAILY_USD.
            budget = min(DAILY_USD_BUDGET, max(0.0, float(daily_usd if daily_usd is not None else env.get("JEV_DAILY_USD") or DAILY_USD_BUDGET)))
        except ValueError:
            budget = DAILY_USD_BUDGET
        client = OpenRouterJev(openrouter_key(env), model=model, post=post)
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
    # J28: with a reading list from the fetch step, TRIAGE_SHARE of today's budget is
    # the triage's own, tracked apart, so neither can spend the other's.
    merges = near_miss_pairs(pool)  # J35: the merge trial's pairs for this run
    triage_items = load_triage(triage_path) if triage_path else []
    triage_budget = budget * TRIAGE_SHARE if triage_items else 0.0
    main_budget = budget - triage_budget
    used_triage = spent_today(cache_path, day, unit, "triage_spent") if cache_status == "hit" else 0.0
    triage_stats = {"state": "no_list", "asked": 0, "cached": 0, "errors": 0, "spent": 0.0, "tokens": 0}
    if client is None:
        stats = {"state": f"skipped_{plan}", "asked": 0, "cached": 0, "errors": 0, "spent": 0.0, "tokens": 0,
                 "latency_ms": {"n": 0}}
    else:
        stats = ask_all(pool, client, cache, now, used, main_budget, ceiling_left, pairs, cost=cost, max_seconds=max_seconds,
                        max_articles=max_articles, groups=cluster_pairs(pool), merges=merges)
        if triage_items:
            triage_stats = ask_triage(triage_items, client, cache, now, used_triage, triage_budget,
                                      ceiling_left - stats["spent"], cost, max_seconds=max_seconds)
    budget_state = {"day": day, "unit": unit, "spent": round(used + stats["spent"], 6),
                    "triage_spent": round(used_triage + triage_stats["spent"], 6)}
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
                "spent_day": round(budget_state["spent"] + budget_state["triage_spent"], 6), "budget_day": budget,
                "neurons_measured_before": measured,
                "triage": {**triage_stats, "listed": len(triage_items), "spent_day": budget_state["triage_spent"],
                           "budget_day": round(triage_budget, 6)}},
        "report": report(pool, cache, pairs, merges=merges),
        "answers": {i: cache["articles"][i][0] for i in sorted(ids) if i in cache["articles"]},
    }
    doc["scorecard"] = scorecard(doc)
    doc["_cache"] = cache  # for apply_to_pool; dropped before jev.json is written
    return doc


# J20: applying the group answers to the pool --------------------------------------------

def load_source_facts(path="sources.json"):
    """{source id: (lean, syndication group)} from the repo's sources.json."""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    rows = doc.get("sources", doc) if isinstance(doc, dict) else doc
    return {r["id"]: (r.get("lean"), r.get("syndication_group") or r["id"]) for r in rows if isinstance(r, dict) and "id" in r}


def apply_to_pool(pool, cache, facts=None):
    """(new pool, summary): members Jev reads as a different event split out of their
    group (a group left with one member dissolves, unless a Live event holds it), and
    every answered member annotated with jev {same, framing}. The input is not changed."""
    from contract.validate import _cluster_method
    facts = facts if facts is not None else load_source_facts()
    new = json.loads(json.dumps(pool))
    by_id = {a["id"]: a for a in new["articles"]}
    in_events = {cid for e in new.get("events", []) for cid in e.get("cluster_ids", [])}
    splits, dissolved, annotated = [], [], 0
    kept = []
    for c in new["clusters"]:
        anchor = cluster_anchor(c, by_id)
        drop, notes = [], {}
        for m in c["article_ids"]:
            if m == anchor:
                continue
            ans = (cache["pairs"].get(f"c:{anchor}|{m}") or [{}])[0]
            same, framing = ans.get("same_event"), ans.get("framing")
            if same and same["v"] < SPLIT_BELOW:
                drop.append(m)
                continue
            rec = {}
            if same:
                rec["same"] = same["v"]
            if framing and FRAMING_CODE.get(framing["v"]):
                rec["framing"] = FRAMING_CODE[framing["v"]]
            if rec:
                notes[m] = rec
        keep = [m for m in c["article_ids"] if m not in drop]
        if drop and len(keep) < 2 and c["id"] in in_events:
            keep, drop = list(c["article_ids"]), []  # a Live event's group stays whole
        for m in drop:
            splits.append({"cluster": c["id"], "anchor": anchor, "article": m,
                           "same": cache["pairs"][f"c:{anchor}|{m}"][0]["same_event"]["v"]})
        if len(keep) < 2:
            dissolved.append(c["id"])
            continue
        for m, rec in notes.items():
            if m in keep:
                by_id[m]["jev"] = rec
                annotated += 1
        if drop:
            c["article_ids"] = keep
            c["near_duplicates"] = [g for g in ([i for i in grp if i in keep] for grp in c["near_duplicates"]) if len(g) > 1]
            srcs = {by_id[i]["source_id"] for i in keep}
            c["independent_sources"] = len({facts.get(sid, (None, sid))[1] for sid in srcs})
            c["lean_buckets"] = sorted({facts[sid][0] for sid in srcs if sid in facts and facts[sid][0]})
            in_dups = {i for g in c["near_duplicates"] for i in g}
            units = len(c["near_duplicates"]) + len(set(keep) - in_dups)
            base = _cluster_method(units, bool(c["near_duplicates"]))
            c["method"] = base + "+embedding" if c["method"].endswith("+embedding") and units > 1 else base
        kept.append(c)
    new["clusters"] = kept
    # J22: every answered article carries Jev's hard-news probability (jev.hard, the
    # yes/no answer as asked), for Today's Urgent order (app/static/js/today-order.js).
    for aid, a in by_id.items():
        hard = ((cache["articles"].get(aid) or [{}])[0] or {}).get("hard_news")
        if isinstance(hard, dict) and hard.get("t") == "noul" and isinstance(hard.get("v"), (int, float)):
            a.setdefault("jev", {})["hard"] = round(min(1.0, max(0.0, float(hard["v"]))), 3)
    return new, {"splits": splits, "dissolved": dissolved, "annotated": annotated}


def apply_and_write(pool_path, pool, cache, facts=None):
    """Applies the group answers and replaces the pool file, only if the new pool passes
    contract.validate; written to a temporary file, then renamed. Returns the summary
    with "applied": True, or "applied": False and the reason."""
    from contract.validate import validate
    try:
        new, summary = apply_to_pool(pool, cache, facts)
        errors = validate(new)
    except Exception as exc:  # never lose the report, never touch the pool
        return {"splits": [], "dissolved": [], "annotated": 0, "applied": False,
                "reason": f"{type(exc).__name__}: {str(exc)[:160]}"}
    if errors:
        return {**summary, "applied": False, "reason": errors[0][:200]}
    tmp = Path(str(pool_path) + ".jev-tmp")
    tmp.write_text(json.dumps(new, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, pool_path)
    return {**summary, "applied": True}


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
    def bucket_examples(by_bucket, names):
        """J22: the first article matched and the first missed across `names`."""
        out = {}
        for b in names:
            for slot, ex in ((by_bucket.get(b) or {}).get("examples") or {}).items():
                out.setdefault(slot, {**ex, "bucket": b})
        return out

    pair_ex = same.get("examples") or {}
    examples = {
        "same_event": pair_ex.get("same") or {},
        "different_event": pair_ex.get("different") or {},
        "section": bucket_examples(rep["section_vs_bucket"]["by_bucket"], STRONG_SECTION_BUCKETS),
        "region": bucket_examples(rep["region_vs_bucket"]["by_bucket"], REGIONAL_BUCKETS),
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
        check = {"key": key, "label": label, "feature": feature, "value": value, "target": target,
                 "direction": direction, "n": n, "status": status}
        if examples.get(key):
            check["examples"] = examples[key]
        checks.append(check)
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
    ap.add_argument("--apply", action="store_true", help="J20: split off-story group members and annotate the pool")
    ap.add_argument("--triage", default=os.environ.get("JEV_TRIAGE_PATH", TRIAGE_PATH),
                    help="J28: the fetch step's reading list for the keep rule")
    args = ap.parse_args(argv)
    pool = json.loads(Path(args.pool).read_text(encoding="utf-8"))
    doc = run(pool, datetime.now(timezone.utc), cache_path=args.cache, max_seconds=args.max_seconds,
              max_articles=args.max_articles, daily_usd=args.daily_usd, triage_path=args.triage)
    cache = doc.pop("_cache")
    if args.apply:
        applied = apply_and_write(args.pool, pool, cache)
        by_id = {a["id"]: a for a in pool["articles"]}
        doc["report"]["groups"] = {
            "applied": applied["applied"], "reason": applied.get("reason"), "annotated": applied["annotated"],
            "split": len(applied["splits"]), "dissolved": len(applied["dissolved"]),
            "examples": [{"title": by_id[x["article"]].get("title", "")[:140], "anchor": by_id[x["anchor"]].get("title", "")[:140],
                          "same": x["same"]} for x in applied["splits"][:8]],
        }
    Path(args.out).write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(log_line(doc))
    if "groups" in doc["report"]:
        g = doc["report"]["groups"]
        print(f"jev groups applied={g['applied']} annotated={g['annotated']} split={g['split']} dissolved={g['dissolved']}")
    if args.scorecard:
        print(scorecard_text(doc["scorecard"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
