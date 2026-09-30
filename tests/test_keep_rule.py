"""J24: the keep-rule trial (fetcher/keep_rule.py). Shadow only: it scores candidates on
facts, keeps each outlet group's share, reports the difference, and never changes the
pool."""
import json
import random
from datetime import datetime, timezone

from fetcher import fanout, keep_rule
from fetcher.fanout import build_pool_fanout, fetch_all
from fetcher.state import build_state, select_dropped_from, validate_state, dumps_state

NOW = datetime(2026, 9, 30, 12, 0, 0, tzinfo=timezone.utc)
SOURCES = [
    {"id": "sg1", "name": "SG One", "bucket": "singapore", "lean": "non-us", "syndication_group": "sg1"},
    {"id": "sg2", "name": "SG Two", "bucket": "singapore", "lean": "non-us", "syndication_group": "sg2"},
    {"id": "left1", "name": "Left One", "bucket": "general", "lean": "left", "syndication_group": "left1"},
    {"id": "right1", "name": "Right One", "bucket": "general", "lean": "right", "syndication_group": "right1"},
    {"id": "wire_copy", "name": "Wire Copy", "bucket": "general", "lean": "center", "syndication_group": "ap_wire"},
    {"id": "ap", "name": "AP", "bucket": "general", "lean": "center", "syndication_group": "ap_wire"},
    {"id": "ai1", "name": "AI One", "bucket": "ai", "lean": "center", "syndication_group": "ai1", "paywall": True},
]


def ts(hours_ago):
    return datetime.fromtimestamp(NOW.timestamp() - hours_ago * 3600, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def art(id_, sid, hours_ago, topics=("world",), dek=""):
    return {"id": id_, "source_id": sid, "url": f"https://{sid}.example/{id_}", "title": f"Title {id_}",
            "published_at": ts(hours_ago), "topics": list(topics), "dek": dek}


def candidates():
    out = []
    for sid in ("sg1", "sg2", "left1", "right1", "wire_copy", "ai1"):
        for k in range(8):
            out.append(art(f"{sid}_{k}", sid, 2 + 7 * k, topics=("world",) if sid != "ai1" else ("ai",)))
    out.append(art("stale_only", "ap", 80))
    return out


CLUSTERS = [{"id": "c1", "article_ids": ["left1_0", "right1_0", "sg1_0"]}]


def ctx_for(cands, **kw):
    return keep_rule.build_context(SOURCES, cands, CLUSTERS, now=NOW, hard_topics=("world", "politics"), **kw)


def test_each_term_reads_one_fact():
    cands = candidates()
    ctx = ctx_for(cands, previous_health={"ai1": {"consecutive_error": 3}}, previous_ids={"sg2_0"})
    by = {a["id"]: a for a in cands}
    t = keep_rule.fact_terms(by["left1_0"], ctx)
    assert t["corroboration"] == round(12 * 1.585) and t["lean_span"] == 8 and t["hard"] == 10
    assert keep_rule.fact_terms(by["wire_copy_0"], ctx)["original"] == 0, "a wire rewrite is not original"
    assert keep_rule.fact_terms(by["left1_1"], ctx)["corroboration"] == 0
    fresh, day_old = keep_rule.fact_terms(art("x", "left1", 0), ctx)["recency"], keep_rule.fact_terms(art("y", "left1", 12), ctx)["recency"]
    assert fresh == 20 and day_old == 10, "freshness halves at 12 hours"
    ai = keep_rule.fact_terms(by["ai1_0"], ctx)
    assert ai["health"] == -10 and ai["paywall"] == -6 and ai["hard"] == 0
    assert keep_rule.fact_terms(by["sg2_0"], ctx)["incumbent"] == 6
    many = keep_rule.build_context(SOURCES + [{"id": f"s{i}", "bucket": "general"} for i in range(20)],
                                   [art(f"m{i}", f"s{i}", 1) for i in range(20)], [{"article_ids": [f"m{i}" for i in range(20)]}], now=NOW)
    assert keep_rule.fact_terms(art("m0", "s0", 1), many)["corroboration"] == 36, "capped at 36"


def test_the_rule_fills_the_same_bytes_keeps_every_outlet_and_each_groups_share():
    cands = candidates()
    ctx = ctx_for(cands)
    cap_ids = [a["id"] for a in cands if a["id"].endswith(("_0", "_1", "_2", "_3", "_4"))]
    doc, dropped = keep_rule.run_shadow(cands, cap_ids, ctx)
    ids, why = keep_rule.select_pool(cands, ctx, doc["budget_bytes"],
                                     {b: 10 ** 9 for b in ("singapore", "general", "ai")})
    kept = [a for a in cands if a["id"] in set(ids)]
    assert sum(keep_rule.est_bytes(a) for a in kept) <= doc["budget_bytes"]
    assert {a["source_id"] for a in kept} == {a["source_id"] for a in cands}, "every outlet keeps something"
    assert "stale_only" in ids and why["stale_only"] == "floor_source", "a source with only stale items keeps its newest"
    assert max(sum(1 for a in kept if a["source_id"] == s) for s in {a["source_id"] for a in kept}) <= keep_rule.SOURCE_CEIL
    assert doc["rules"]["score"]["bytes"] <= doc["budget_bytes"]
    assert doc["floors"]["sources_met"] == doc["floors"]["sources_total"]
    assert set(dropped) == {"cap", "score"}


def test_the_same_candidates_in_any_order_give_the_same_selection():
    cands = candidates()
    ctx = ctx_for(cands)
    first, _ = keep_rule.select_pool(cands, ctx, 40_000, {"singapore": 15_000, "general": 20_000, "ai": 5_000})
    shuffled = cands[:]
    random.Random(7).shuffle(shuffled)
    again, _ = keep_rule.select_pool(shuffled, ctx_for(shuffled), 40_000, {"singapore": 15_000, "general": 20_000, "ai": 5_000})
    assert first == again


def test_fresh_beats_stale_inside_a_group():
    cands = candidates()
    ctx = ctx_for(cands)
    sg_all = [a for a in cands if a["source_id"] in ("sg1", "sg2")]
    others = sum(keep_rule.est_bytes(a) for a in cands if a not in sg_all)
    ids, _ = keep_rule.select_pool(cands, ctx, others + sum(keep_rule.est_bytes(a) for a in sg_all),
                                   {"singapore": 10, "general": 10 ** 9, "ai": 10 ** 9})
    sg = [i for i in ids if i.startswith("sg")]
    ages = [int(i.split("_")[1]) for i in sg]
    assert len(sg) >= 10 and max(ages[:10]) <= 4, f"the freshest Singapore items fill its share first: {sg}"


def test_the_trial_never_changes_the_pool_and_an_error_only_marks_it():
    results = fetch_all(_sources(), fetch_fn=_fake_fetch, timeout=1, retries=1)
    plain = build_pool_fanout(_sources(), results, NOW)
    out = {}
    with_trial = build_pool_fanout(_sources(), fetch_all(_sources(), fetch_fn=_fake_fetch, timeout=1, retries=1), NOW,
                                   select_out=out, select_prev={"ids": set(), "dropped": None})
    assert json.dumps(plain, sort_keys=True) == json.dumps(with_trial, sort_keys=True)
    assert out["doc"]["state"] == "ok" and out["doc"]["mode"] == "shadow"

    def boom(*a, **k):
        raise RuntimeError("broken on purpose")
    original = keep_rule.run_shadow
    keep_rule.run_shadow = boom
    try:
        out = {}
        broken = build_pool_fanout(_sources(), fetch_all(_sources(), fetch_fn=_fake_fetch, timeout=1, retries=1), NOW,
                                   select_out=out)
    finally:
        keep_rule.run_shadow = original
    assert json.dumps(plain, sort_keys=True) == json.dumps(broken, sort_keys=True)
    assert out["doc"] == {"schema_version": 1, "mode": "shadow", "state": "error", "error": "RuntimeError"}
    assert keep_rule.log_line(out["doc"]) == "select shadow: state=error"


def test_missed_stories_carry_through_state_and_count_next_hour():
    cands = candidates()
    ctx = ctx_for(cands)
    doc, dropped = keep_rule.run_shadow(cands, [a["id"] for a in cands[:10]], ctx)
    assert doc["missed"] == {"status": "first_run"}
    state = build_state({"generated_at": ts(0), "source_health": {}, "clusters": [], "events": [], "articles": []},
                        select_dropped=dropped)
    assert validate_state(state) == []
    back = select_dropped_from(dumps_state(state).encode())
    lone = back["cap"][0]
    later = keep_rule.build_context(SOURCES, cands, CLUSTERS + [{"id": "c2", "article_ids": [lone, "right1_7"]}],
                                    now=NOW, hard_topics=("world",))
    doc2, _ = keep_rule.run_shadow(cands, [a["id"] for a in cands[:10]], later, back)
    assert doc2["missed"]["status"] == "ok" and doc2["missed"]["cap"] >= 1
    old = build_state({"generated_at": ts(0), "source_health": {}, "clusters": [], "events": [], "articles": []})
    assert "select_dropped" not in old and validate_state(old) == [], "an old state file still validates"
    assert validate_state({**old, "select_dropped": {"cap": [1]}}) != []


def test_the_report_and_log_carry_nothing_a_watch_search_found():
    cands = candidates()
    secret = art("w_secret", "left1", 1)
    secret["watch"] = ["w:0123456789"]
    secret["title"] = "SENTINEL private search"
    cands.append(secret)
    ctx = ctx_for(cands)
    doc, _ = keep_rule.run_shadow(cands, [a["id"] for a in cands[:12]], ctx)
    text = json.dumps(doc) + keep_rule.log_line(doc)
    assert "SENTINEL" not in text and "w:0123456789" not in text


def test_health_shows_facts_first_and_evidence_folded():
    from app.health import render_keep
    cands = candidates()
    doc, _ = keep_rule.run_shadow(cands, [a["id"] for a in cands[:20]], ctx_for(cands))
    html = render_keep(doc, {"sources": SOURCES})
    assert "Keep rule trial" in html and "Trial only: your feed still uses today's rule" in html
    assert "Older than 36 hours" in html and "→" in html
    assert html.count('<details class="jev-fold">') == 5
    assert "\u2014" not in html, "no em dashes in the page's own words"
    assert "could not run" in render_keep({"state": "error", "error": "RuntimeError"}, {})
    assert render_keep(None, {}) == ""


def test_the_published_dek_length_matches_the_fetcher():
    assert keep_rule.PUBLISHED_DEK_CHARS == fanout.PUBLISHED_DEK_CHARS


# --- a tiny offline run, as tests/test_fanout.py does ---
FEED = ('<rss version="2.0"><channel>' + "".join(
    f"<item><title>Item {i} from {{s}}</title><link>https://{{s}}.example/{i}</link>"
    f"<pubDate>Tue, 30 Sep 2026 {i:02d}:00:00 GMT</pubDate></item>" for i in range(9)) + "</channel></rss>")


def _sources():
    return [{"id": s, "name": s, "feed_url": f"https://{s}.example/feed.xml", "bucket": "general",
             "lean": "center", "lean_basis": "test", "syndication_group": s} for s in ("aa", "bb")]


def _fake_fetch(url, timeout=None):
    for s in ("aa", "bb"):
        if f"{s}.example" in url:
            return FEED.replace("{s}", s).encode()
    return b'<rss version="2.0"><channel></channel></rss>'


def test_the_reserve_holds_fresh_unkept_articles_by_topic_with_nothing_private(tmp_path):
    """J26: the best articles the pool did not keep, per topic tag, fresh only, no watch
    tags, a safe file per tag and an index the phone checks against its edition."""
    cands = candidates()
    secret = art("w1", "left1", 1)
    secret["watch"] = ["w:0123456789"]
    cands.append(secret)
    ctx = ctx_for(cands)
    published = {a["id"] for a in cands[:10]}
    shards = keep_rule.reserve_shards(ctx, published)
    ids = {r["id"] for v in shards.values() for r in v}
    assert not ids & published and "stale_only" not in ids, "nothing published, nothing older than 48 hours"
    assert all("watch" not in r for v in shards.values() for r in v)
    assert set(shards) <= {"world", "ai"}
    index = keep_rule.write_reserve({**shards, "../evil": [{"id": "x"}]}, tmp_path, "2026-09-30T12:00:00Z")
    assert index["generated_at"] == "2026-09-30T12:00:00Z" and "../evil" not in index["shards"]
    files = sorted(p.name for p in (tmp_path / "reserve").iterdir())
    assert files == sorted([f"{t}.json" for t in shards] + ["index.json"])
    doc = json.loads((tmp_path / "reserve" / "world.json").read_text())
    assert doc["tag"] == "world" and len(doc["articles"]) == index["shards"]["world"]


# --- J27: going live on its own ---

def _history(days, *, missed=(3, 2), sg=(10, 12), stale=(90, 70), floors=True, every_h=1):
    out = []
    t = NOW.timestamp() - days * 86400
    while t <= NOW.timestamp():
        at = datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out.append({"at": at, "floors": floors, "missed": list(missed), "sg": list(sg), "stale": list(stale), "budget": True})
        t += every_h * 3600
    return out


def test_the_rule_goes_live_only_after_a_week_that_passes_every_check():
    now = NOW.timestamp()
    assert not keep_rule.gate(_history(3), now)["pass"], "three days is not a week"
    good = keep_rule.gate(_history(7.5), now)
    assert good["pass"] and good["runs"] >= keep_rule.GATE_MIN_RUNS
    assert not keep_rule.gate(_history(7.5, missed=(2, 3)), now)["pass"], "misses more stories"
    assert not keep_rule.gate(_history(7.5, sg=(12, 10)), now)["pass"], "fewer Singapore stories"
    assert not keep_rule.gate(_history(7.5, stale=(70, 90)), now)["pass"], "more old articles"
    assert not keep_rule.gate(_history(7.5, floors=False), now)["pass"], "an outlet left out"
    assert not keep_rule.gate(_history(7.5, every_h=4), now)["pass"], "too few runs in the week"
    assert keep_rule.decide("auto", _history(7.5), now) == (True, "gate")
    assert keep_rule.decide("auto", _history(3), now) == (False, "trial")
    assert keep_rule.decide("cap", _history(7.5), now) == (False, "held"), "SELECT_MODE=cap always holds the old rule"
    assert keep_rule.decide("score", [], now) == (True, "forced")
    assert keep_rule.decide("nonsense", _history(3), now) == (False, "trial")
    assert len(keep_rule.trim_history(_history(12), now)) < len(_history(12))


def test_a_live_rule_publishes_its_own_picks_and_the_ledger_still_adds_up():
    def run(live):
        out = {}
        pool = build_pool_fanout(_sources(), fetch_all(_sources(), fetch_fn=_fake_fetch, timeout=1, retries=1), NOW,
                                 per_source_cap=3, select_out=out, select_prev={"ids": set(), "dropped": None, "live": live})
        return pool, out["doc"]
    old, doc_old = run(False)
    new, doc_new = run(True)
    assert doc_old["mode"] == "shadow" and doc_new["mode"] == "live"
    assert "_score_ids" not in doc_old and "_score_ids" not in doc_new
    for pool in (old, new):
        c = pool["counts"]
        assert c["fetched"] == c["published"] + sum(c["drops"].values())
    assert {a["id"] for a in old["articles"]} != {a["id"] for a in new["articles"]}, "the fixture's newest items differ from its first ones"
    assert {a["source_id"] for a in new["articles"]} == {"aa", "bb"}, "every outlet still kept"
    assert len(new["articles"]) <= len(old["articles"]) + 1


def test_state_carries_the_trial_history_and_health_says_where_it_stands():
    from app.health import render_keep
    state = build_state({"generated_at": ts(0), "source_health": {}, "clusters": [], "events": [], "articles": []},
                        select_history=_history(2))
    assert validate_state(state) == [] and len(state["select_history"]) == len(_history(2))
    assert validate_state({**state, "select_history": [{"no": "at"}]}) != []
    cands = candidates()
    doc, _ = keep_rule.run_shadow(cands, [a["id"] for a in cands[:20]], ctx_for(cands))
    doc["gate"] = {**keep_rule.gate(_history(2), NOW.timestamp()), "decided": "trial"}
    html = render_keep(doc, {"sources": SOURCES})
    assert "Going live" in html and "checks pass" in html and "Not yet: A full week of trial runs" in html
    doc["mode"], doc["gate"]["decided"] = "live", "gate"
    assert "Live: the new rule chose this edition" in render_keep(doc, {"sources": SOURCES})
    doc["mode"], doc["gate"]["decided"] = "shadow", "held"
    assert "SELECT_MODE to cap" in render_keep(doc, {"sources": SOURCES})
