"""J3 proof: Jev shadow mode (fetcher/jev_shadow.py) and its Health report.

Answers are cleaned as the phone cleans them and never read as 1 - p; the run calls
Jev only on a confirmed Workers Free plan and inside its budget; answers are cached by
article; the report scores against the free answer keys; the log line and the page
never carry the token, the account id or markup from a feed."""
import json
import random
import re
from datetime import datetime, timezone

from app.health import render_jev
from fetcher import jev_shadow as js

NOW = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)
TOKEN, ACCOUNT = "tok-SECRET-123", "acct-SECRET-456"
ENV = {"CF_PIPELINE_TOKEN": TOKEN, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT}


def _article(i, source, hours_ago, title, topics=()):
    stamp = datetime.fromtimestamp(NOW.timestamp() - hours_ago * 3600, timezone.utc)
    return {"id": i, "source_id": source, "title": title, "dek": f"About {title}.",
            "published_at": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"), "topics": list(topics)}


def pool():
    return {
        "generated_at": "2026-09-29T12:00:00Z",
        "sources": [{"id": "st", "name": "Straits Times"}, {"id": "ap", "name": "AP"}, {"id": "tc", "name": "TechCrunch"}],
        "articles": [
            _article("a1", "st", 1, "HDB flat prices rise again", ["singapore"]),
            _article("a2", "ap", 2, "Wire: Ceasefire talks resume in Doha", ["world"]),
            _article("a3", "st", 2, "Wire: Ceasefire talks resume in Doha", ["world"]),
            _article("a4", "tc", 40, "Startup raises funds for AI chips", ["ai"]),
            _article("a5", "ap", 45, "Flooding closes roads in Texas", ["us"]),
        ],
        "clusters": [{"id": "c1", "article_ids": ["a2", "a3"], "near_duplicates": [["a2", "a3"]]}],
    }


BUCKETS = {"st": "singapore", "ap": "general", "tc": "ai"}


class FakeApi:
    """Stands in for Cloudflare: the subscriptions list, the neuron count, and Jev."""

    def __init__(self, plan="free", answers=None, fail=False):
        self.plan, self.answers, self.fail = plan, answers, fail
        self.calls = []

    def get(self, url, token, timeout):
        name = "Workers Paid" if self.plan == "paid" else "Workers Free"
        return {"success": True, "result": [{"rate_plan": {"id": "workers", "public_name": name}}]}

    def post(self, url, token, payload, timeout):
        if url.endswith("/graphql"):
            return {"data": {"viewer": {"accounts": [{"aiInferenceAdaptiveGroups": [{"sum": {"totalNeurons": 100}}]}]}}}
        self.calls.append((url, payload))
        if self.fail:
            raise OSError("down")
        answers = self.answers(payload) if self.answers else {}
        return {"success": True, "result": {"answers": answers, "usage": {"input_tokens": 500}}}


def good_answers(payload):
    qs = payload["questions"]
    if "same_event" in qs:
        same = payload["state"]["headline_a"] == payload["state"]["headline_b"]
        return {"same_event": {"noul": 0.9 if same else 0.1}}
    text = payload["state"]["headline"]
    return {
        "section": {"choice": "Singapore" if "HDB" in text else "World", "confidence": 0.8},
        "region": {"choice": "Singapore" if "HDB" in text else "Global", "confidence": 0.7},
        "sentiment": {"choice": "Bad news", "probabilities": {"Bad news": 0.7, "Good news": 0.2}},
        "ai": {"noul": 0.9 if "AI" in text else 0.05},
        "clinical": {"noul": 0.1},
        "industrial_biotech": {"noul": 0.1},
        "hard_news": {"noul": 0.6},
    }


def test_answers_are_cleaned_and_never_read_backwards():
    raw = {"answers": {
        "section": {"choice": "Mars"},  # not an offered option
        "region": {"choice": "Europe", "probabilities": {"Europe": 0.8, "Moon": 0.9}},
        "ai": {"noul": 0.2},
        "clinical": {"noul": float("nan")},
        "extra": {"choice": "anything"},
    }}
    got = js.clean_answers(js.ARTICLE_QUESTIONS, raw)
    assert set(got) == {"region", "ai"}
    assert got["region"] == {"t": "choice", "v": "Europe", "p": {"Europe": 0.8}, "c": 0.8}
    assert got["ai"] == {"t": "noul", "v": 0.2}, "no confidence is made up from 1 - p"
    assert js.band(got["ai"]) == "unlikely"


def test_choice_status_uses_pick_confidence_and_spread():
    assert js.choice_status({"t": "choice", "v": "A", "c": 0.8, "p": {"A": 0.8, "B": 0.1}}) == "sure"
    assert js.choice_status({"t": "choice", "v": "A", "c": 0.5}) == "lean"
    assert js.choice_status({"t": "choice", "v": "A", "c": 0.45, "p": {"A": 0.45, "B": 0.4}}) == "ambiguous"
    assert js.choice_status({"t": "choice", "v": "A", "c": 0.2, "p": {"A": 0.2, "B": 0.7}}) == "conflict"
    assert js.choice_status({"t": "choice", "v": "A"}) == "unrated"
    assert js.choice_status(None) == "missing"


def test_known_pairs_are_syndicated_copies_and_far_apart_unrelated_stories():
    positives, negatives = js.known_pairs(pool(), random.Random(1))
    assert positives == [("a2", "a3")]
    assert negatives, "a1 (1h, singapore) and a4/a5 (40h+, other topics) qualify"
    for a, b in negatives:
        assert {a, b} != {"a2", "a3"}


def test_questions_are_one_positive_claim_each():
    for q in list(js.ARTICLE_QUESTIONS.values()) + list(js.PAIR_QUESTIONS.values()):
        assert not re.search(r"rather than|\bnot\b|n't\b|\bnever\b|\bneither\b", q["instructions"], re.I), q


def test_a_free_plan_run_asks_scores_and_caches(tmp_path, monkeypatch):
    monkeypatch.setattr(js, "load_buckets", lambda path="sources.json": BUCKETS)
    api = FakeApi(answers=good_answers)
    cache = tmp_path / "jev.json"
    doc = js.run(pool(), NOW, env=ENV, cache_path=cache, post=api.post, get=api.get)
    assert doc["run"]["plan"] == "free" and doc["run"]["state"] == "ok"
    urls = {u for u, _ in api.calls}
    assert urls == {js.embed.API.format(account=ACCOUNT, model=js.WORKERS_MODEL)}
    assert all(set(p) == {"state", "questions"} for _, p in api.calls)
    rep = doc["report"]
    assert rep["articles_answered"] == 5
    assert rep["same_event_known"]["syndicated_pairs"] == 1
    assert rep["same_event_known"]["syndicated_read_same"] == 1
    assert rep["same_event_known"]["unrelated_read_different"] == rep["same_event_known"]["unrelated_pairs"]
    assert rep["section_vs_bucket"]["by_bucket"]["singapore"] == {"agree": 1, "scored": 2}
    assert rep["ai_rules_vs_jev"]["both"] == 1
    # A second run the same hour asks nothing new.
    api2 = FakeApi(answers=good_answers)
    again = js.run(pool(), NOW, env=ENV, cache_path=cache, post=api2.post, get=api2.get)
    assert again["run"]["asked"] == 0 and api2.calls == []
    assert again["report"] == rep


def test_nothing_is_asked_without_a_token_or_on_a_paid_plan(tmp_path):
    api = FakeApi(plan="paid", answers=good_answers)
    doc = js.run(pool(), NOW, env=ENV, cache_path=tmp_path / "j.json", post=api.post, get=api.get)
    assert doc["run"]["state"] == "skipped_paid" and api.calls == []
    doc = js.run(pool(), NOW, env={}, cache_path=tmp_path / "j.json", post=api.post, get=api.get)
    assert doc["run"]["state"] == "skipped_no_key"


def test_the_budget_stops_the_run(tmp_path, monkeypatch):
    monkeypatch.setattr(js, "DAILY_NEURON_BUDGET", 5)  # about one call
    api = FakeApi(answers=good_answers)
    doc = js.run(pool(), NOW, env=ENV, cache_path=tmp_path / "j.json", post=api.post, get=api.get)
    assert doc["run"]["state"] == "budget"
    assert 0 < len(api.calls) < 5


def test_errors_are_counted_and_the_log_never_carries_secrets(tmp_path):
    api = FakeApi(fail=True)
    doc = js.run(pool(), NOW, env=ENV, cache_path=tmp_path / "j.json", post=api.post, get=api.get)
    assert doc["run"]["state"] == "api_errors" and doc["run"]["errors"] > 0
    line = js.log_line(doc)
    blob = json.dumps(doc)
    assert TOKEN not in line and ACCOUNT not in line and TOKEN not in blob and ACCOUNT not in blob


def test_the_health_section_escapes_feed_titles(tmp_path, monkeypatch):
    monkeypatch.setattr(js, "load_buckets", lambda path="sources.json": BUCKETS)
    p = pool()
    p["articles"][3]["title"] = "<b>AI</b> chips & more"
    p["articles"][3]["topics"] = []
    api = FakeApi(answers=good_answers)
    doc = js.run(p, NOW, env=ENV, cache_path=tmp_path / "j.json", post=api.post, get=api.get)
    html = render_jev(doc)
    assert "Jev, shadow mode" in html and "&lt;b&gt;AI&lt;/b&gt; chips &amp; more" in html and "<b>" not in html
    assert render_jev(None) == ""
    mock = js.run(pool(), NOW, env={"JEV_MOCK": "1"}, cache_path=tmp_path / "m.json")
    assert "local stand-in" in render_jev(mock)


class FakeOpenRouter:
    """Stands in for OpenRouter's System One endpoint."""

    def __init__(self, answers, cost=0.00002, status_error=False):
        self.answers, self.cost, self.status_error = answers, cost, status_error
        self.calls = []

    def post(self, url, key, payload, timeout):
        self.calls.append((url, key, payload))
        if self.status_error:
            raise OSError("401")
        return {"model": "typesafe/jev-1.13-20260917", "answers": self.answers(payload),
                "usage": {"input_tokens": 480, "output_tokens": 30, "cost": self.cost}, "provider": "TypeSafe"}


OR_KEY = "sk-or-v1-SECRET"


def test_openrouter_is_used_first_with_the_pinned_model_and_a_dollar_budget(tmp_path, monkeypatch):
    monkeypatch.setattr(js, "load_buckets", lambda path="sources.json": BUCKETS)
    api = FakeOpenRouter(good_answers)
    cf = FakeApi(answers=good_answers)
    env = {**ENV, "OPENROUTER_API_KEY": OR_KEY}
    doc = js.run(pool(), NOW, env=env, cache_path=tmp_path / "j.json", post=api.post, get=cf.get)
    assert doc["route"] == "openrouter" and doc["model"] == "typesafe/jev-1.13"
    assert cf.calls == [], "Workers AI is not called while OpenRouter is set"
    assert {c[0] for c in api.calls} == {js.OPENROUTER_URL} and {c[1] for c in api.calls} == {OR_KEY}
    assert all(c[2]["model"] == "typesafe/jev-1.13" and set(c[2]) == {"model", "state", "questions"} for c in api.calls)
    run = doc["run"]
    assert run["unit"] == "usd" and run["budget_day"] == js.DAILY_USD_BUDGET
    assert abs(run["spent"] - 0.00002 * run["asked"]) < 1e-9, "OpenRouter's own reported cost is what is charged"
    assert doc["report"]["articles_answered"] == 5
    blob = json.dumps(doc) + js.log_line(doc)
    assert OR_KEY not in blob


def test_the_dollar_cap_stops_the_run(tmp_path):
    api = FakeOpenRouter(good_answers, cost=0.04)
    env = {"OPENROUTER_API_KEY": OR_KEY, "JEV_DAILY_USD": "0.10"}
    doc = js.run(pool(), NOW, env=env, cache_path=tmp_path / "j.json", post=api.post)
    assert doc["run"]["state"] == "budget"
    assert doc["run"]["spent_day"] <= 0.10 + 0.04
    again = js.run(pool(), NOW, env=env, cache_path=tmp_path / "j.json", post=FakeOpenRouter(good_answers, cost=0.04).post)
    assert again["run"]["asked"] <= 1, "today's spend carries over between runs"


def test_openrouter_errors_are_counted_without_the_key(tmp_path):
    api = FakeOpenRouter(good_answers, status_error=True)
    doc = js.run(pool(), NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=api.post)
    assert doc["run"]["state"] == "api_errors"
    assert OR_KEY not in json.dumps(doc) + js.log_line(doc)
