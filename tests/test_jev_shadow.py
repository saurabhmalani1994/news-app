"""J3 proof: Jev shadow mode (fetcher/jev_shadow.py) and its Health report.

Answers are cleaned as the phone cleans them and never read as 1 - p; the run calls
Jev only on a confirmed Workers Free plan and inside its budget; answers are cached by
article; the report scores against the free answer keys; the log line and the page
never carry the token, the account id or markup from a feed."""
import json
from pathlib import Path
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
    sg = rep["section_vs_bucket"]["by_bucket"]["singapore"]
    assert (sg["agree"], sg["scored"]) == (1, 2)
    # J22: one real article it matched and one it missed, for Health's examples.
    assert sg["examples"]["hit"]["got"] == "Singapore" and sg["examples"]["miss"]["got"] != "Singapore"
    assert sg["examples"]["hit"]["source"] == "Straits Times"
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
    from app.health import render_jev_articles
    html = render_jev(doc) + render_jev_articles(doc, p)
    assert "Jev today" in html and "Jev scoreboard" in html and "&lt;b&gt;AI&lt;/b&gt; chips &amp; more" in html and "<b>" not in html
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
    wire = next(c[2]["questions"] for c in api.calls if "section" in c[2]["questions"])
    assert wire["section"]["criteria"] == {c: c for c in js.SECTIONS}, "J6: a choice's criteria go as a record"
    assert "criteria" not in wire["ai"], "J6: a yes/no question with no criteria goes bare"
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


def test_the_scorecard_passes_fails_and_waits_for_enough_data(tmp_path, monkeypatch):
    monkeypatch.setattr(js, "load_buckets", lambda path="sources.json": BUCKETS)
    api = FakeOpenRouter(good_answers)
    doc = js.run(pool(), NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=api.post)
    card = doc["scorecard"]
    by_key = {c["key"]: c for c in card["checks"]}
    assert set(by_key) == {c[0] for c in js.CHECKS}
    assert by_key["same_event"]["status"] == "not_enough_data", "one syndicated pair is below the minimum of 5"
    assert by_key["latency"]["n"] == doc["run"]["asked"]
    assert card["features"]["Versions and other side"] == "not_enough_data"
    assert card["mock"] is False
    text = js.scorecard_text(card)
    assert "Jev scorecard" in text and "MOCK" not in text and OR_KEY not in text


def test_a_failed_check_makes_its_feature_not_ready():
    doc = {"mock": False, "run": {"asked": 0, "latency_ms": {"n": 0}}, "report": {
        "same_event_known": {"syndicated_pairs": 10, "syndicated_read_same": 5, "unrelated_pairs": 20, "unrelated_read_different": 20},
        "confidence": {}, "section_vs_bucket": {"by_bucket": {}}, "region_vs_bucket": {"by_bucket": {}},
        "clinical_and_industrial_both_likely": 0, "articles_answered": 0}}
    card = js.scorecard(doc)
    assert {c["key"]: c["status"] for c in card["checks"]}["same_event"] == "fail"
    assert card["features"]["Versions and other side"] == "not_ready"


def test_known_pairs_are_asked_before_articles(tmp_path):
    api = FakeOpenRouter(good_answers)
    js.run(pool(), NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=api.post)
    kinds = ["pair" if "same_event" in c[2]["questions"] else "article" for c in api.calls]
    assert kinds[0] == "pair" and kinds.index("article") > kinds.index("pair")


def test_a_pasted_key_is_trimmed_and_the_first_error_is_named(tmp_path):
    api = FakeOpenRouter(good_answers)
    js.run(pool(), NOW, env={"OPENROUTER_API_KEY": f'  "{OR_KEY}"\n'}, cache_path=tmp_path / "a.json", post=api.post)
    assert {c[1] for c in api.calls} == {OR_KEY}

    def refuse(url, key, payload, timeout):
        import io
        import urllib.error
        raise urllib.error.HTTPError(url, 401, "no", {}, io.BytesIO(b'{"error":{"message":"User not found"}}'))
    doc = js.run(pool(), NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "b.json", post=refuse)
    assert doc["run"]["first_error"] == "http_401"
    assert "first error http_401" in render_jev(doc)


def test_health_lists_each_article_jev_read_beside_the_rules(tmp_path, monkeypatch):
    from app.health import render_jev_articles
    monkeypatch.setattr(js, "load_buckets", lambda path="sources.json": BUCKETS)
    p = pool()
    p["articles"][1]["title"] = "<i>Wire</i>: Ceasefire talks resume in Doha"
    p["articles"][4]["topics"] = ["ai"]  # rules call the Texas flood story AI; Jev does not
    api = FakeOpenRouter(good_answers)
    doc = js.run(p, NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=api.post)
    html = render_jev_articles(doc, p)
    assert html.startswith('<details class="settings-section jev-accordion"'), "its own accordion, closed"
    assert "Articles Jev read (5)" in html
    groups = html.split('<details class="jev-group"')[1:]
    heads = [g[g.index(">") + 1:].split("(")[0].strip().split("\n")[-1].split(">")[-1] for g in groups]
    assert heads[-2:] == ["Rules tagged AI, Jev disagrees", "All articles, newest first"]
    # J22: every article says where its section comes from.
    assert set(heads[:-2]) <= {"Rules + Jev agree on the section", "Jev suggests another section", "Rules only"}
    all_rows = groups[-1]
    assert all_rows.count('class="setting-row setting-row--stack jev-article"') == 5
    assert all_rows.index('data-article="a1"') < all_rows.index('data-article="a4"'), "newest first"
    assert 'href="/#story-a1"' in html, "an unclustered article opens as its own story"
    assert 'href="/#story-c1"' in html and 'href="/#bundle-c1"' in html, "a clustered one opens its story and versions"
    assert "http" not in html, "never the publisher's page"
    assert "&lt;i&gt;Wire&lt;/i&gt;" in html and "<i>" not in html
    assert "Both say Singapore." in html and "Rules + Jev</span>" in html
    assert "Rules + Jev:" not in html and "Rules only:" not in html, "the label is never repeated in its sentence"
    assert "Likely about: AI 90%" in html
    assert render_jev_articles(None, p) == ""


def test_a_long_report_value_wraps_under_its_label(tmp_path, monkeypatch):
    monkeypatch.setattr(js, "load_buckets", lambda path="sources.json": BUCKETS)
    doc = js.run(pool(), NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=FakeOpenRouter(good_answers).post)
    doc["report"]["confidence"] = {"sure": 971, "lean": 110, "ambiguous": 89, "unsure": 17, "conflict": 3}
    html = render_jev(doc)
    assert "971 sure · 110 leaning · 89 split · 17 unsure · 3 self-contradicting" in html
    # J23: the fact is short (the share Jev was sure of); the breakdown is the evidence.
    assert "Answers Jev was sure of</span></span><span class=\"setting-value\">82%" in html



# --- J20: story groups ---

def group_pool():
    arts = [
        _article("g1", "st", 1, "Council approves flood barrier for riverside district", ["singapore"]),
        _article("g2", "ap", 2, "Riverside flood barrier approved by council", ["world"]),
        _article("g3", "tc", 3, "Startup unveils new AI chip for phones", ["ai"]),
        _article("h1", "st", 1, "Minister opens new rail line in the east", ["singapore"]),
        _article("h2", "tc", 2, "Tech firm reports record quarterly profit", ["ai"]),
    ]
    return {"generated_at": "2026-09-30T12:00:00Z", "sources": pool()["sources"], "articles": arts,
            "clusters": [{"id": "c_g", "method": "cosine_entity", "article_ids": ["g1", "g2", "g3"], "near_duplicates": [],
                          "independent_sources": 3, "lean_buckets": ["center", "left"]},
                         {"id": "c_h", "method": "cosine_entity", "article_ids": ["h1", "h2"], "near_duplicates": [],
                          "independent_sources": 2, "lean_buckets": ["center"]}],
            "events": []}


FACTS = {"st": ("center", "st"), "ap": ("center", "ap"), "tc": ("left", "tc")}


def group_answers(payload):
    qs, st = payload["questions"], payload["state"]
    if "framing" in qs:
        a, b = set(st["headline_a"].lower().split()), set(st["headline_b"].lower().split())
        same = len(a & b) / len(a | b) > 0.25
        return {"same_event": {"noul": 0.9 if same else 0.05},
                "framing": {"choice": "Reports the same facts with a different emphasis" if same else "Reports a different event", "confidence": 0.8}}
    return good_answers(payload)


def test_group_members_are_asked_against_their_anchor(tmp_path):
    p = group_pool()
    assert js.cluster_anchor(p["clusters"][0], {a["id"]: a for a in p["articles"]}) in {"g1", "g2"}
    keys = [k for k, _, _ in js.cluster_pairs(p)]
    assert len(keys) == 3 and all(k.startswith("c:") for k in keys)
    api = FakeOpenRouter(group_answers)
    js.run(p, NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=api.post)
    first = api.calls[0][2]["questions"]
    assert set(first) == {"same_event", "framing"}, "group pairs are asked first"
    assert first["framing"]["criteria"]["Reports a different event"] == "Reports a different event"


def test_an_off_story_member_splits_out_and_a_lone_pair_dissolves(tmp_path):
    p = group_pool()
    api = FakeOpenRouter(group_answers)
    doc = js.run(p, NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=api.post)
    new, summary = js.apply_to_pool(p, doc["_cache"], FACTS)
    assert [c["id"] for c in new["clusters"]] == ["c_g"], "the rail/profit pair was two different events"
    g = new["clusters"][0]
    assert g["article_ids"] == ["g1", "g2"] and g["independent_sources"] == 2 and g["lean_buckets"] == ["center"]
    h_anchor = js.cluster_anchor(p["clusters"][1], {a["id"]: a for a in p["articles"]})
    assert {x["article"] for x in summary["splits"]} == {"g3"} | ({"h1", "h2"} - {h_anchor})
    assert summary["dissolved"] == ["c_h"]
    member = next(a for a in new["articles"] if a["id"] in ("g1", "g2") and "same" in a.get("jev", {}))
    assert {k: v for k, v in member["jev"].items() if k != "hard"} == {"same": 0.9, "framing": "emphasis"}
    # J22: every answered article carries Jev's hard-news probability for Urgent.
    assert all(0 <= a["jev"]["hard"] <= 1 for a in new["articles"] if "hard" in a.get("jev", {}))
    assert any("hard" in a.get("jev", {}) for a in new["articles"])
    assert len(new["articles"]) == len(p["articles"]), "a split article stays in the pool as its own story"
    assert p["clusters"][0]["article_ids"] == ["g1", "g2", "g3"], "the input pool is not changed"


def test_a_live_event_keeps_its_group_whole(tmp_path):
    p = group_pool()
    p["events"] = [{"cluster_ids": ["c_h"]}]
    api = FakeOpenRouter(group_answers)
    doc = js.run(p, NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=api.post)
    new, summary = js.apply_to_pool(p, doc["_cache"], FACTS)
    assert "c_h" in [c["id"] for c in new["clusters"]] and summary["dissolved"] == []


def test_the_pool_is_replaced_only_when_the_new_one_is_valid(tmp_path, monkeypatch):
    import contract.validate as cv
    p = group_pool()
    path = tmp_path / "pool.json"
    path.write_text(json.dumps(p))
    monkeypatch.setattr(cv, "validate", lambda pool: ["$.clusters: broken on purpose"])
    got = js.apply_and_write(path, p, {"articles": {}, "pairs": {}}, FACTS)
    assert got["applied"] is False and "broken on purpose" in got["reason"]
    assert json.loads(path.read_text()) == p, "an invalid result never replaces the pool"
    monkeypatch.setattr(cv, "validate", lambda pool: [])
    assert js.apply_and_write(path, p, {"articles": {}, "pairs": {}}, FACTS)["applied"] is True
    assert not (tmp_path / "pool.json.jev-tmp").exists()


def test_health_reports_the_splits(tmp_path):
    p = group_pool()
    doc = js.run(p, NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=FakeOpenRouter(group_answers).post)
    doc.pop("_cache")
    doc["report"]["groups"] = {"applied": True, "annotated": 1, "split": 2, "dissolved": 1,
                               "examples": [{"title": "Startup unveils <b>AI</b> chip", "anchor": "Council approves flood barrier", "same": 0.05}]}
    html = render_jev(doc)
    assert "Stories Jev moved to their own card" in html and "Was on the card for: Council approves flood barrier. Jev was 5% sure they are the same event" in html
    assert "&lt;b&gt;AI&lt;/b&gt;" in html
    doc["report"]["groups"] = {"applied": False, "reason": "$.clusters: bad", "annotated": 0, "split": 0, "dissolved": 0, "examples": []}
    assert "Jev did not change any cards this run" in render_jev(doc)


def test_health_groups_each_check_under_its_feature(tmp_path):
    """J21: features with their checks in plain words, value against target."""
    doc = js.run(pool(), NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=FakeOpenRouter(good_answers).post)
    doc["scorecard"] = js.scorecard(doc)
    html = render_jev(doc)
    assert html.index("Jev today") < html.index("Jev scoreboard") < html.index("More Jev numbers")
    feature = html.index("Grouping versions and the other side")
    assert feature < html.index("Keeps copies of one story together") < html.index("Sorting articles into sections")
    assert "Aim 90% or more" in html and "Aim 1.5 s or less." in html
    # J23: facts first, evidence one tap down: each check is a fold with its evidence.
    assert html.count('<details class="jev-fold jev-check">') == len(doc["scorecard"]["checks"])
    assert "Nothing needs your review." in html or 'id="jev-review"' in html
    assert "syndicated" not in html.lower() and "bucket" not in html.lower(), "no insider words (J22)"
    assert "Check: " not in html and "Feature: " not in html
    assert "nothing it says changes your feed" not in html


def test_health_and_the_phone_map_sections_to_rule_topics_alike():
    """J22: app/health.py and js/jev/sorted-by.js hold the same section map and words."""
    import shutil
    import subprocess
    from app.health import SECTION_TOPICS, TOPIC_WORDS
    node = shutil.which("node")
    if node is None:
        return
    out = subprocess.run([node, "--input-type=module", "-e",
                          'import * as m from "./app/static/js/jev/sorted-by.js";'
                          "console.log(JSON.stringify([m.SECTION_TOPICS, m.TOPIC_WORDS]))"],
                         capture_output=True, text=True, check=True, cwd=Path(__file__).resolve().parents[1])
    sections, words = json.loads(out.stdout)
    assert sections == {k: list(v) for k, v in SECTION_TOPICS.items()} and words == TOPIC_WORDS


def test_each_article_keeps_the_time_it_was_first_pulled():
    """J22: fetched_at is the first run an article appeared in, carried in state.json."""
    from fetcher.state import build_state, first_seen_from, stamp_first_seen, validate_state, dumps_state
    run1 = {"generated_at": "2026-09-30T01:17:00Z", "articles": [{"id": "a"}], "source_health": {}, "clusters": [], "events": []}
    stamp_first_seen(run1, {})
    assert run1["articles"][0]["fetched_at"] == "2026-09-30T01:17:00Z"
    state = build_state(run1)
    assert validate_state(state) == [] and state["first_seen"] == {"a": "2026-09-30T01:17:00Z"}
    run2 = {"generated_at": "2026-09-30T02:17:00Z", "articles": [{"id": "a"}, {"id": "b"}], "source_health": {}, "clusters": [], "events": []}
    stamp_first_seen(run2, first_seen_from(dumps_state(state).encode()))
    assert [a["fetched_at"] for a in run2["articles"]] == ["2026-09-30T01:17:00Z", "2026-09-30T02:17:00Z"]
    assert first_seen_from(json.dumps(run2).encode()) == {"a": "2026-09-30T01:17:00Z", "b": "2026-09-30T02:17:00Z"}, "a published pool works too"
    assert first_seen_from(b"<html>login</html>") == {}


def test_the_hourly_run_never_spends_the_phones_share(tmp_path):
    """J25: $0.30 a day in all; the phone keeps $0.05, so the hourly run gets at most
    $0.25 whatever JEV_DAILY_USD says."""
    assert js.DAILY_USD_BUDGET == 0.25 and js.TOTAL_DAILY_USD == 0.30
    doc = js.run(pool(), NOW, env={"OPENROUTER_API_KEY": OR_KEY, "JEV_DAILY_USD": "0.50"}, cache_path=tmp_path / "j.json",
                 post=FakeOpenRouter(good_answers).post)
    assert doc["run"]["budget_day"] == 0.25
    assert "Hourly run spent today" in render_jev(doc) and 'id="jev-phone-spend"' in render_jev(doc)


# --- J35: the two trials, which only measure ---

def trial_pool():
    p = pool()
    p["sources"] += [{"id": "bb", "name": "BBC"}, {"id": "af", "name": "AllAfrica"}]
    p["articles"] += [
        _article("m1", "bb", 3, "Supreme Court lets Trump resume third-country deportations", ["politics"]),
        _article("m2", "ap", 4, "Supreme Court allows third-country deportations to resume", ["politics"]),
        _article("m3", "bb", 5, "Spain bans evictions after protests over housing", ["world"]),
        _article("m4", "ap", 6, "Housing protests grow in Spain as evictions rise", ["world"]),
        _article("old", "bb", 200, "Supreme Court lets Trump resume third-country deportations plan", ["politics"]),
        _article("t1", "tc", 3, "New AI model beats benchmark", []),
        _article("t2", "tc", 4, "Chip maker ships AI accelerator", ["ai"]),
        _article("f1", "af", 5, "Floods displace thousands in Sudan", ["world"]),
    ]
    return p


def trial_answers(payload):
    qs = payload["questions"]
    if "same_event" in qs:
        a, b = payload["state"]["headline_a"], payload["state"]["headline_b"]
        return {"same_event": {"noul": 0.9 if a == b or ("Supreme Court" in a and "Supreme Court" in b) else 0.1}}
    text = payload["state"]["headline"]
    return {"section": {"choice": "World", "confidence": 0.8}, "region": {"choice": "Global", "confidence": 0.7},
            "sentiment": {"choice": "Bad news", "probabilities": {"Bad news": 0.7, "Good news": 0.2}},
            "ai": {"noul": 0.9 if ("AI" in text or "Chip" in text) else 0.05}, "clinical": {"noul": 0.05},
            "industrial_biotech": {"noul": 0.05}, "hard_news": {"noul": 0.6}}


def test_near_misses_are_look_alike_stories_the_rules_left_apart():
    pairs = js.near_miss_pairs(trial_pool())
    keys = [k for k, *_ in pairs]
    assert "m:m1|m2" in keys, "two outlets on one ruling, never grouped"
    assert not any("a2" in k and "a3" in k for k in keys), "a pair the rules already grouped is not a near miss"
    assert not any("old" in k for k in keys), "outside the 48 hour window"
    assert all(shared >= js.MERGE_MIN_SHARED for *_, shared in pairs) and pairs == sorted(pairs, key=lambda t: (-t[3], t[0]))


def test_the_merge_trial_counts_what_jev_would_join_and_joins_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(js, "load_buckets", lambda path="sources.json": {**BUCKETS, "bb": "general", "af": "africa"})
    p = trial_pool()
    before = json.dumps(p["clusters"])
    api = FakeOpenRouter(trial_answers)
    doc = js.run(p, NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=api.post)
    mt = doc["report"]["merge_trial"]
    assert mt["pairs"] >= 1 and mt["same"] >= 1 and mt["same"] + mt["different"] + mt["unsure"] == mt["pairs"]
    assert mt["examples"][0]["a"]["title"].startswith("Supreme Court") and mt["examples"][0]["p"] == 0.9
    assert json.dumps(p["clusters"]) == before, "the trial never changes a group"
    assert any(k.startswith("m:") for k in doc["_cache"]["pairs"]), "answers are cached, so a pair is asked once"
    by_id = {a["id"]: a for a in p["articles"]}
    near = {(by_id[a]["title"], by_id[b]["title"]) for _k, a, b, _s in js.near_miss_pairs(p)}
    states = [c[2]["state"] for c in api.calls]
    first_near = min(i for i, st in enumerate(states) if (st.get("headline_a"), st.get("headline_b")) in near)
    last_article = max(i for i, st in enumerate(states) if "headline" in st)
    assert last_article < first_near, "near misses are asked last, with whatever budget is left"


def test_the_topic_trial_checks_jevs_yes_or_no_against_single_subject_outlets(tmp_path, monkeypatch):
    monkeypatch.setattr(js, "load_buckets", lambda path="sources.json": {**BUCKETS, "bb": "general", "af": "africa"})
    doc = js.run(trial_pool(), NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=FakeOpenRouter(trial_answers).post)
    ai = doc["report"]["topic_trial"]["ai"]
    assert ai["own"] == [3, 3], "all three TechCrunch (AI outlet) articles read as AI"
    assert ai["other"] == [0, 1], "the Sudan flood story is not"
    assert ai["adds"] == 1 and ai["drops"] == 0, "one AI article the rules did not tag"
    html = render_jev({**doc, "scorecard": js.scorecard(doc)})
    assert "Trial: stories Jev would join" in html and "Trial: Jev tagging ai" in html and "No tag is changed yet." in html


def test_the_triage_share_leaves_the_main_lane_room():
    assert js.TRIAGE_SHARE == 0.3


# --- J36: joining stories and the AI tag, each behind its own check ---

def _cache_for(p, answers):
    cache = {"articles": {}, "pairs": {}, "triage": {}}
    for a in p["articles"]:
        cache["articles"][a["id"]] = [js.clean_answers(js.ARTICLE_QUESTIONS, {"answers": answers({"questions": js.ARTICLE_QUESTIONS,
                                                                                                 "state": {"headline": a["title"]}})}), 0]
    return cache


FACTS5 = {"st": ("center", "st"), "ap": ("center", "ap"), "tc": ("center", "tc"), "bb": ("left", "bb"), "af": ("center", "af")}


def test_jev_joins_two_stories_only_when_it_is_very_sure():
    p = trial_pool()
    merges = js.near_miss_pairs(p)
    key = next(k for k, a, b, _s in merges if {a, b} == {"m1", "m2"})
    other = next(k for k, a, b, _s in merges if {a, b} == {"m3", "m4"})
    cache = _cache_for(p, trial_answers)
    cache["pairs"][key] = [{"same_event": {"t": "noul", "v": 0.95}}, 0]
    cache["pairs"][other] = [{"same_event": {"t": "noul", "v": 0.8}}, 0]  # likely, not sure enough
    new, summary = js.apply_to_pool(p, cache, FACTS5, features=("split", "join"), merges=merges)
    joined = next(c for c in new["clusters"] if set(c["article_ids"]) == {"m1", "m2"})
    assert joined["id"] == "c_m2", "named for its earliest version, as every group is"
    assert joined["independent_sources"] == 2 and joined["lean_buckets"] == ["center", "left"] and joined["method"] == "cosine_entity"
    assert not any(set(c["article_ids"]) >= {"m3", "m4"} for c in new["clusters"]), "0.8 is not sure enough to join"
    assert summary["joined"] == [{"cluster": "c_m2", "members": 2, "a": "m1", "b": "m2", "p": 0.95}]
    by = {a["id"]: a for a in new["articles"]}
    assert sum(1 for i in ("m1", "m2") if by[i].get("jev", {}).get("joined")) == 1
    ids = [i for c in new["clusters"] for i in c["article_ids"]]
    assert len(ids) == len(set(ids)), "no version sits in two stories"
    plain, _ = js.apply_to_pool(p, cache, FACTS5, features=("split",), merges=merges)
    assert not any(set(c["article_ids"]) == {"m1", "m2"} for c in plain["clusters"]), "off unless asked for"


def test_a_live_events_group_and_an_oversized_group_are_never_joined():
    p = trial_pool()
    p["clusters"].append({"id": "c_m1", "article_ids": ["m1", "t1"], "near_duplicates": [], "method": "cosine_entity"})
    p["events"] = [{"id": "e1", "cluster_ids": ["c_m1"], "live": True}]
    merges = [("m:m1|m2", "m1", "m2", 0.5)]
    cache = _cache_for(p, trial_answers)
    cache["pairs"]["m:m1|m2"] = [{"same_event": {"t": "noul", "v": 0.99}}, 0]
    new, summary = js.apply_to_pool(p, cache, FACTS5, features=("join",), merges=merges)
    assert summary["joined"] == [] and any(c["id"] == "c_m1" and c["article_ids"] == ["m1", "t1"] for c in new["clusters"])


def test_jev_adds_the_ai_tag_and_never_removes_one():
    p = trial_pool()
    cache = _cache_for(p, trial_answers)
    new, summary = js.apply_to_pool(p, cache, FACTS5, features=("ai",), merges=[])
    by = {a["id"]: a for a in new["articles"]}
    assert summary["ai_tagged"] == ["t1"], "the one AI article the rules had not tagged"
    assert by["t1"]["topics"] == ["ai"] and by["t1"]["jev"]["tags"] == ["ai"]
    assert by["t2"]["topics"] == ["ai"] and "tags" not in by["t2"].get("jev", {}), "a rule tag is the rules', not Jev's"
    assert by["a4"]["topics"] == ["ai"], "the rules' AI tag stays even where Jev says no"
    off, _ = js.apply_to_pool(p, cache, FACTS5, features=("split",), merges=[])
    assert {a["id"]: a for a in off["articles"]}["t1"]["topics"] == []


def test_each_feature_needs_its_own_check_to_pass_this_run():
    doc = {"scorecard": {"checks": [{"key": "same_event", "status": "pass"}, {"key": "different_event", "status": "pass"}]},
           "report": {"topic_trial": {"ai": {"own": [25, 26], "other": [2, 141]}}}}
    assert js.allowed_features(doc) == {"split": "on", "join": "on", "ai": "on"}
    assert js.allowed_features(doc, ["split"]) == {"split": "on", "join": "off: setting", "ai": "off: setting"}
    doc["scorecard"]["checks"][0]["status"] = "fail"
    doc["report"]["topic_trial"]["ai"]["other"] = [20, 141]
    assert js.allowed_features(doc) == {"split": "on", "join": "off: check", "ai": "off: check"}
    doc["report"]["topic_trial"]["ai"] = {"own": [5, 5], "other": [0, 141]}
    assert js.allowed_features(doc)["ai"] == "off: check", "too few AI-outlet articles to judge"


def test_health_says_what_jev_joined_and_tagged_or_why_it_is_off(tmp_path, monkeypatch):
    monkeypatch.setattr(js, "load_buckets", lambda path="sources.json": BUCKETS)
    doc = js.run(pool(), NOW, env={"OPENROUTER_API_KEY": OR_KEY}, cache_path=tmp_path / "j.json", post=FakeOpenRouter(good_answers).post)
    doc.pop("_cache")
    doc["report"]["groups"] = {"applied": True, "annotated": 3, "split": 1, "dissolved": 0, "examples": [],
                               "features": {"split": "on", "join": "on", "ai": "off: check"}, "joined": 4, "ai_tagged": 0,
                               "join_examples": [{"a": "Court <b>rules</b>", "b": "Ruling lands", "p": 0.95}], "ai_examples": []}
    html = render_jev(doc)
    assert "Stories Jev joined" in html and ">4<" in html
    assert "AI tags Jev added" in html and "off this run: its check did not pass" in html
    assert "Joined: “Court &lt;b&gt;rules&lt;/b&gt;” and “Ruling lands” (95% sure they are one event)." in html
    assert "four places" in html
