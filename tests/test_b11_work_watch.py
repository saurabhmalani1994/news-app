"""B11: the work watch in the pipeline (fetcher/workwatch.py and its use in
fetcher/fanout.py). Rule matching against the parity cases the phone also runs, the
KV rules union, the search queries and the tier cadence, the pool build (checked
results, tagged feed candidates, the separate byte budget) and a whole run's log,
pool and candidate dump, which must never carry a rule's terms. Every term here is an
invented placeholder."""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import fetcher.fanout as fanout
import fetcher.watch as watch
import fetcher.workwatch as ww
from contract.validate import validate
from fetcher.fanout import build_pool_fanout
from tests.test_watch import (ENV, FakeKV, HARBOR, NOW, _gn, _item, _rss, _variants, _write_sources)

ROOT = Path(__file__).resolve().parents[1]
PARITY = json.loads((ROOT / "tests" / "fixtures" / "work_watch_parity.json").read_text(encoding="utf-8"))


def rule(rid, tier, terms, **extra):
    return {"id": rid, "label": f"Label {rid}", "tag": ww.work_tag(rid), "tier": tier, "terms": terms,
            "pair_any": [], "exclude": [], "exact": False, **extra}


def value(*rules, queries=()):
    return {"v": 2, "queries": [{"q": q, "tag": watch.tag_for(q)} for q in queries], "work": list(rules)}


# --- matching ------------------------------------------------------------------------

def test_parity_cases_match_the_phone():
    assert len(PARITY["cases"]) >= 20
    for case in PARITY["cases"]:
        assert ww.rule_matches(PARITY["rules"][case["rule"]], case["texts"]) is case["match"], case["why"]


def test_tag_is_the_watch_tag_of_work_and_the_id():
    assert ww.work_tag("w_one") == watch.tag_for("work:w_one")
    assert re.fullmatch(r"w:[0-9a-f]{10}", ww.work_tag("w_one"))


# --- rules from KV ------------------------------------------------------------------------

def test_union_keeps_good_rules_drops_bad_ones_and_never_keeps_a_label():
    good = rule("w_one", 1, ["zorbium"])
    values = [
        value(good, rule("w_bad_tier", 5, ["quillase"]), rule("w_empty", 2, []),
              {**rule("w_tag", 2, ["quillase"]), "tag": ww.work_tag("w_other")},
              rule("w_quote", 2, ['say "zorbium"'])),
        value({**good}),                                   # the same rule from another user
        {"v": 1, "queries": []},                           # no work field: nothing to read
        None,
    ]
    rules, drops = ww.union_rules(values)
    assert [r["id"] for r in rules] == ["w_one"]
    assert "label" not in rules[0]
    assert dict(drops) == {"bad_rule": 3, "bad_tag": 1, "duplicate": 1}


def test_union_caps_rules_per_value_and_per_run():
    many = [rule(f"w_r{i}", 1, ["zorbium"]) for i in range(45)]
    rules, drops = ww.union_rules([value(*many)])
    assert len(rules) == ww.MAX_RULES_PER_VALUE and drops["over_value_cap"] == 5
    users = [value(*[rule(f"w_u{u}_{i}", 1, ["zorbium"]) for i in range(40)]) for u in range(2)]
    rules, drops = ww.union_rules(users)
    assert len(rules) == ww.MAX_RULES and drops["over_cap"] == 20


def test_watch_union_reads_phrase_queries_from_version_2_values():
    queries, drops = watch.union_queries([value(rule("w_one", 1, ["zorbium"]), queries=["harbor ferry"])])
    assert [q["q"] for q in queries] == ["harbor ferry"] and not drops


# --- searches and cadence ----------------------------------------------------------------

def test_queries_or_terms_add_the_pair_group_and_excludes_and_split_to_fit():
    r = rule("w_pair", 1, ["fermentation", "zorbium broth"], pair_any=["precision", "industrial"], exclude=["brewquor"])
    assert ww.rule_queries(r) == ['"fermentation" OR "zorbium broth" ("precision" OR "industrial") -"brewquor"']
    long_terms = [f"zorbium variant {i:02d}" for i in range(30)]
    qs = ww.rule_queries(rule("w_long", 1, long_terms, exclude=["brewquor"]))
    assert len(qs) > 1 and all(len(q) <= ww.MAX_Q_CHARS for q in qs)
    assert all(q.endswith(' -"brewquor"') for q in qs)
    joined = " ".join(qs)
    assert all(f'"{t}"' in joined for t in long_terms), "every term is searched"


def test_a_pair_group_too_long_for_the_query_is_left_to_the_local_check():
    pair = [f"qualifier number {i:02d}" for i in range(20)]
    (q,) = ww.rule_queries(rule("w_wide", 1, ["zorbium"], pair_any=pair))
    assert q == '"zorbium"'


def test_tiers_1_and_2_search_every_run_3_and_4_every_third_hour():
    at = lambda h: NOW.replace(hour=h)  # noqa: E731
    assert [ww.due(t, at(1)) for t in (1, 2, 3, 4)] == [True, True, False, False]
    assert [ww.due(t, at(3)) for t in (1, 2, 3, 4)] == [True, True, True, True]
    rules = [rule("w_a", 3, ["zorbium"]), rule("w_b", 1, ["quillase"]), rule("w_c", 4, ["vexamide"])]
    queries, deferred, over = ww.plan(rules, at(4))
    assert [q["tier"] for q in queries] == [1] and deferred == 2 and over == 0
    queries, deferred, _ = ww.plan(rules, at(6))
    assert [q["tier"] for q in queries] == [1, 3, 4] and deferred == 0
    # eight slow runs a day: the slow tiers cost a third of the requests
    assert sum(ww.due(3, at(h)) for h in range(24)) == 8


def test_at_most_max_queries_a_run():
    rules = [rule(f"w_r{i}", 1, ["zorbium"]) for i in range(ww.MAX_QUERIES + 5)]
    queries, _, over = ww.plan(rules, NOW)
    assert len(queries) == ww.MAX_QUERIES and over == 5


# --- the pool build -----------------------------------------------------------------------

ZRULE = {k: v for k, v in rule("w_zorb", 1, ["zorbium"], pair_any=["plant", "output"]).items() if k != "label"}
QRULE = {k: v for k, v in rule("w_quill", 3, ["Quillase"], exact=True).items() if k != "label"}


def _work(results, rules=(ZRULE, QRULE)):
    return {"rules": list(rules), "queries": len(results), "deferred": 0, "over_cap_queries": 0,
            "rule_drops": {}, "results": [{"tag": t, "data": d, "error": None} for t, d in results]}


def _watch(work, phrase_results=()):
    return {"kv": "ok", "token": "CF_PIPELINE_TOKEN", "queries": len(phrase_results), "query_drops": {},
            "results": [{"tag": t, "data": d, "error": None} for t, d in phrase_results], "work": work}


FEED = _rss([
    ("Quillase opens a new line in the north", "https://www.harborherald.example/q1", NOW - timedelta(hours=2)),
    ("quillase is only a word here", "https://www.harborherald.example/q2", NOW - timedelta(hours=2)),
    ("Harbor ferry timetable changes", "https://www.harborherald.example/f1", NOW - timedelta(hours=3)),
])


def test_search_results_publish_only_when_their_own_text_passes_the_rule():
    search = _gn([_item("Zorbium plant expands", "z1"), _item("Zorbium in a cooking show", "z2"),
                  _item("A headline naming nothing", "z3")])
    pool = build_pool_fanout([HARBOR], {"harbor": (FEED, None)}, NOW, watch=_watch(_work([(ZRULE["tag"], search)])))
    assert validate(pool) == []
    titles = {a["title"]: a.get("watch") for a in pool["articles"]}
    assert titles["Zorbium plant expands"] == [ZRULE["tag"]]
    assert "Zorbium in a cooking show" not in titles and "A headline naming nothing" not in titles
    work = pool["counts"]["watch"]["work"]
    assert (work["fetched"], work["candidates"], work["no_match"]) == (3, 1, 2)
    # a feed candidate the exact rule matches carries its tag; the wrong capitals do not
    assert titles["Quillase opens a new line in the north"] == [QRULE["tag"]]
    assert titles["quillase is only a word here"] is None
    assert work["tagged"] == 1 and work["rules"] == 2


def test_work_items_use_their_own_budget_and_leave_the_phrase_budget_alone():
    search = _gn([_item(f"Zorbium plant news number {i}", f"b{i}") for i in range(6)])
    phrase = _gn([_item("Harbor pilots train on a new tug", "p1")])
    pool = build_pool_fanout([HARBOR], {"harbor": (FEED, None)}, NOW,
                             watch=_watch(_work([(ZRULE["tag"], search)]), [(watch.tag_for("harbor pilots"), phrase)]),
                             work_budget=900)
    assert validate(pool) == []
    counts = pool["counts"]["watch"]
    assert counts["published"] == 1 and counts["over_budget"] == 0, "the phrase item still publishes"
    assert counts["budget_bytes"] == watch.BUDGET_BYTES
    assert counts["work"]["budget_bytes"] == 900 and counts["work"]["over_budget"] > 0
    assert counts["work"]["bytes"] <= 900
    assert counts["bytes"] < 900, "work bytes never count against the phrase budget"


def test_without_rules_there_are_no_work_counts_and_nothing_changes():
    pool = build_pool_fanout([HARBOR], {"harbor": (FEED, None)}, NOW, watch=_watch(ww.empty_work()))
    assert "work" not in pool["counts"]["watch"]
    assert not any(a.get("watch") for a in pool["articles"])


def test_the_candidate_dump_hides_work_results_and_work_matched_feed_items():
    search = _gn([_item("Zorbium plant expands", "z1")])
    out = {}
    build_pool_fanout([HARBOR], {"harbor": (FEED, None)}, NOW, watch=_watch(_work([(ZRULE["tag"], search)])),
                      candidates_out=out)
    dump = json.dumps(out["dump"])
    assert "Zorbium" not in dump and "Quillase opens" not in dump
    assert "Harbor ferry timetable changes" in dump


# --- a whole run: the log, the pool and the dump never carry a term ------------------------

WORK_TERMS = ["zorbium broth", "Quillase", "vexamide", "precision", "brewquor"]


def _run(tmp_path, monkeypatch, kv, fetch, hour):
    for name, val in ENV.items():
        monkeypatch.setenv(name, val)
    monkeypatch.delenv("CLOUDFLARE_ACCOUNTID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_WORKERS_TOKEN", raising=False)
    monkeypatch.setattr(watch, "_http_get", kv)
    monkeypatch.setattr(watch, "RETRY_PAUSE", 0)
    monkeypatch.setattr(fanout, "fetch_feed", fetch)
    real_collect = watch.collect
    monkeypatch.setattr(fanout.wsearch, "collect",
                        lambda **kw: real_collect(now=datetime(2026, 9, 27, hour, 5, tzinfo=timezone.utc), **kw))
    out = tmp_path / "dist" / "pool.json"
    dump = tmp_path / "candidates" / "candidates.json"
    rc = fanout.main(["--out", str(out), "--sources", str(_write_sources(tmp_path)),
                      "--state-path", str(tmp_path / "state.json"), "--timeout", "1",
                      "--dump-candidates", str(dump)])
    return rc, out, dump


def test_a_run_with_work_rules_logs_counts_only(tmp_path, monkeypatch, capsys):
    rules = [rule("w_broth", 1, ["zorbium broth"], pair_any=["precision"], exclude=["brewquor"]),
             rule("w_quill", 2, ["Quillase"], exact=True), rule("w_vex", 4, ["vexamide"])]
    kv = FakeKV(values={"user:owner": json.dumps(value(*rules)).encode()})
    searched = []

    def fetch(url, timeout=None):
        now = datetime.now(timezone.utc)
        if "news.google.com" in url:
            q = parse_qs(urlsplit(url).query)["q"][0]
            searched.append(q)
            if "vexamide" in q:
                raise fanout.wsearch.urllib.error.HTTPError(url, 503, f"down for {url}", {}, None)
            return _gn([_item("Precision zorbium broth plant opens", "w1", now=now),
                        _item("Quillase signs a supply deal", "w2", now=now)])
        return _rss([("Harbor towns sign the tidal energy compact", "https://www.harborherald.example/a1",
                      now - timedelta(hours=1))])

    rc, out, dump = _run(tmp_path, monkeypatch, kv, fetch, hour=3)
    captured = capsys.readouterr()
    log = captured.out + captured.err
    assert rc == 0
    assert " work: rules=3 " in log and "deferred=0" in log
    assert len(searched) == 4, "tiers 1, 2 and 4 at a slow hour, the failed one retried once"
    for term in WORK_TERMS + [r["label"] for r in rules] + [r["tag"] for r in rules]:
        for v in _variants(term):
            assert v not in log, "a work term, label or tag reached the log"
    dumped = dump.read_text(encoding="utf-8")
    for term in WORK_TERMS:
        for v in _variants(term):
            assert v not in dumped, "a work term reached the public candidate dump"
    pool = json.loads(out.read_text(encoding="utf-8"))
    assert validate(pool) == []
    body = out.read_text(encoding="utf-8")
    for r in rules:
        assert r["label"] not in body, "a label never reaches the pool"
    work = pool["counts"]["watch"]["work"]
    assert work["queries"] == 3 and work["errors"] == {"http_503": 1}
    tagged = {a["title"]: a.get("watch") for a in pool["articles"]}
    assert tagged["Precision zorbium broth plant opens"] == [ww.work_tag("w_broth")]
    assert tagged["Quillase signs a supply deal"] == [ww.work_tag("w_quill")]


def test_a_run_at_a_fast_hour_defers_the_slow_tiers(tmp_path, monkeypatch, capsys):
    rules = [rule("w_one", 1, ["zorbium"]), rule("w_three", 3, ["quillase"])]
    kv = FakeKV(values={"user:owner": json.dumps(value(*rules)).encode()})
    searched = []

    def fetch(url, timeout=None):
        if "news.google.com" in url:
            searched.append(url)
            return _gn([])
        return _rss([])

    rc, out, _ = _run(tmp_path, monkeypatch, kv, fetch, hour=4)
    assert rc == 0
    assert len(searched) == 1
    work = json.loads(out.read_text(encoding="utf-8"))["counts"]["watch"]["work"]
    assert work["deferred"] == 1 and work["queries"] == 1
    assert "quillase" not in capsys.readouterr().out.lower()


def test_contract_checks_the_work_ledger():
    search = _gn([_item("Zorbium plant expands", "z1")])
    pool = build_pool_fanout([HARBOR], {"harbor": (FEED, None)}, NOW, watch=_watch(_work([(ZRULE["tag"], search)])))
    pool["counts"]["watch"]["work"]["no_match"] += 1
    assert any("counts.watch.work" in e for e in validate(pool))
