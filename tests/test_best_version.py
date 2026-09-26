"""B8: the best version's fact terms (DESIGN-bundles section 4a and section 7). No network."""
import copy
import inspect
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.build import render, version_bv
from contract.validate import validate
from fetcher import best_version as bvm
from fetcher.best_version import TERMS, annotate, headline_parts, load_rules, score_fixture
from fetcher.fanout import build_pool_fanout, load_sources
from fetcher.fetch import dumps
from app.page_input import decode_input

ROOT = Path(__file__).resolve().parents[1]
SOURCES = load_sources(ROOT / "sources.json")
BY_ID = {s["id"]: s for s in SOURCES}
RULES = load_rules()
NOW = datetime(2026, 9, 25, 14, 0, 0, tzinfo=timezone.utc)
FIXTURES = sorted((ROOT / "tests/fixtures/bundles").glob("gold_*.json"))
# A wire's own feed, as sources.json would list AP: its S08 group is the wire's group.
AP = {"id": "ap", "name": "AP News", "feed_url": "https://ap.example/feed", "bucket": "general",
      "country": "US", "lean": "center", "syndication_group": "ap_wire", "full_text_ok": False,
      "roster": "core", "paywall": False}
T = TERMS.index


def _art(aid, source_id, title="Senate passes the budget bill after a long night", hours=0, **extra):
    stamp = datetime(2026, 9, 25, 8 + hours, 0, 0, tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"id": aid, "source_id": source_id, "title": title, "published_at": stamp,
            "dek": "Lawmakers voted 51 to 49 before dawn.", **extra}


def _score(articles, sources, **kw):
    articles = copy.deepcopy(articles)
    annotate(articles, [{"id": "c1", "article_ids": [a["id"] for a in articles]}], sources, rules=RULES, **kw)
    return {a["id"]: a["bv"] for a in articles if "bv" in a}


# --- section 7's proofs ------------------------------------------------------------

def test_a_pbs_copy_of_an_ap_story_scores_below_the_ap_original():
    title = "Hurricane Delia makes landfall in Louisiana with 140 mph winds"
    arts = [_art("ap1", "ap", title), _art("pbs1", "pbs_newshour", title, hours=1),
            _art("npr1", "npr", "Delia hits Louisiana coast as a Category 4 storm", hours=2)]
    bv = _score(arts, [AP, BY_ID["pbs_newshour"], BY_ID["npr"]])
    assert bv["ap1"][T("original")] == 20
    assert bv["pbs1"][T("original")] == 0  # PBS NewsHour's S08 group is ap_wire
    assert sum(bv["pbs1"]) < sum(bv["ap1"])
    # Published at the same minute, the copy still scores lower: originality alone.
    same = _score([_art("ap1", "ap", title), _art("pbs1", "pbs_newshour", title), arts[2]],
                  [AP, BY_ID["pbs_newshour"], BY_ID["npr"]])
    assert sum(same["ap1"]) - sum(same["pbs1"]) == 20


def test_a_wire_credit_in_the_dek_or_body_marks_a_copy_but_a_mention_does_not():
    src = [BY_ID["al_monitor"], BY_ID["npr"]]
    credited = _art("a", "al_monitor", dek="RIYADH (Reuters) - Saudi Arabia said on Thursday...")
    mention = _art("b", "npr", dek="The minister told Reuters the talks would resume.")
    bv = _score([credited, mention], src)
    assert (bv["a"][T("original")], bv["b"][T("original")]) == (0, 20)
    assert bvm.is_syndicated_copy({"dek": ""}, BY_ID["npr"], "Associated Press writers Jane Doe contributed.")
    assert bvm.is_syndicated_copy({"dek": ""}, BY_ID["npr"], "Copyright 2026 The Associated Press.")
    assert not bvm.is_syndicated_copy({"dek": "AP Photo by Jane Doe"}, BY_ID["npr"])
    assert not bvm.is_syndicated_copy({"dek": "WASHINGTON (AP) - The Senate..."}, AP)  # the wire itself


@pytest.mark.parametrize("statement", [
    "Trump meets Xi in Beijing as trade talks begin",
    "Senate passes $1.2 billion budget bill",
    "Asian Games open in Nagoya with 12,000 athletes",
])
def test_a_question_headline_scores_4_below_the_same_words_as_a_statement(statement):
    question = statement + "?"
    arts = [_art("s", "npr", statement), _art("q", "bbc_world", question)]
    bv = _score(arts, [BY_ID["npr"], BY_ID["bbc_world"]])
    assert bv["s"][T("headline")] - bv["q"][T("headline")] == 4
    swapped = _score([_art("s", "bbc_world", statement), _art("q", "npr", question)], [BY_ID["npr"], BY_ID["bbc_world"]])
    assert sum(swapped["s"]) - sum(swapped["q"]) == 4  # the same outlet facts, only the ? differs


def test_a_paywalled_teaser_scores_below_a_free_full_text_version():
    wsj = BY_ID["wsj_world"]
    intercept = BY_ID["the_intercept"]
    assert wsj["paywall"] is True and intercept["paywall"] is False
    body = {"body_html": "<p>" + "Reporting from the ground. " * 150 + "</p>"}  # about 4,000 chars
    arts = [_art("teaser", "wsj_world"), _art("full", "the_intercept", hours=3, has_body=True)]
    bv = _score(arts, [wsj, intercept], bodies={"full": body})
    assert bv["teaser"][T("paywall")] == -15 and bv["teaser"][T("complete")] == 7
    assert bv["full"][T("complete")] == 15 and bv["full"][T("depth")] == 6 and bv["full"][T("paywall")] == 0
    assert sum(bv["teaser"]) < sum(bv["full"])
    # A paywalled outlet whose version carries full text takes no paywall term.
    both = _score([_art("t", "wsj_world", has_body=True), _art("f", "the_intercept")], [wsj, intercept],
                  bodies={"t": body})
    assert both["t"][T("paywall")] == 0


def _lean_and_roster_shuffled(sources):
    leans = sorted({s["lean"] for s in sources if s.get("lean")})
    out = []
    for i, s in enumerate(sources):
        s = dict(s)
        s["lean"] = leans[(leans.index(s["lean"]) + 1 + i) % len(leans)] if s.get("lean") else "right"
        s["roster"] = "core" if s.get("roster") == "perspective" else "perspective"
        out.append(s)
    return out


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.name)
def test_changing_only_lean_or_roster_changes_no_term_across_the_gold_fixtures(path):
    fixture = json.loads(path.read_text(encoding="utf-8"))
    base, _ = score_fixture(fixture, SOURCES)
    scored = {a["id"]: a["bv"] for a in base if "bv" in a}
    assert len(scored) >= 30, "the fixture's multi-outlet stories are scored"
    shuffled = _lean_and_roster_shuffled(SOURCES)
    assert all(a["lean"] != b["lean"] or a["roster"] != b["roster"] for a, b in zip(SOURCES, shuffled))
    for sources in (shuffled, [{k: v for k, v in s.items() if k not in ("lean", "roster")} for s in SOURCES]):
        again, _ = score_fixture(fixture, sources)
        assert {a["id"]: a["bv"] for a in again if "bv" in a} == scored


def test_no_term_reads_lean_or_roster():
    for fn in (bvm.annotate, bvm.version_terms, bvm.is_syndicated_copy, bvm.headline_parts,
               bvm.first_points, bvm.failed_runs):
        src = inspect.getsource(fn)
        assert not re.search(r"""["']lean|lean_buckets|roster""", src), fn.__name__


def test_the_20_bundle_review_list_is_written_for_the_owner():
    text, total = bvm.review_list(json.loads(FIXTURES[0].read_text(encoding="utf-8")), SOURCES)
    assert total == 42
    assert text.count("- Owner's pick:") == 20
    assert text.count("**Lead, ") == 20 and text.count("**Runner-up, ") == 20
    # docs/B8-LEAD-REVIEW.md is the list the code writes today; the owner's pick lines
    # are his to fill in.
    doc = (ROOT / "docs/B8-LEAD-REVIEW.md").read_text(encoding="utf-8").splitlines()
    want = [line for line in text.splitlines() if not line.startswith("- Owner's pick:")]
    got = [line for line in doc[doc.index(want[0]):] if not line.startswith("- Owner's pick:")]
    assert got[:len(want)] == want


# --- the terms one by one ---------------------------------------------------------

def test_headline_points_follow_headline_rules_json():
    proper = {"trump": 1.0, "xi": 1.0, "beijing": 1.0}
    assert headline_parts("Trump meets Xi in Beijing", RULES, proper)["entities"] == 3
    assert headline_parts("Donald Trump arrives", RULES, {"donald": 1.0, "trump": 1.0})["entities"] == 1
    assert headline_parts("Claims fall to 197,000 in 2026", RULES)["numbers"] == 2
    assert headline_parts("A $5bn deal, 300 jobs and 4,000 homes", RULES)["points"] == 4  # numbers cap at 4
    assert headline_parts("BREAKING: Quake strikes", RULES)["breaking"]
    assert headline_parts("Breaking: quake strikes", RULES)["breaking"]
    assert not headline_parts("Ice shelf breaking apart", RULES)["breaking"]
    assert headline_parts("Markets in TURMOIL as rates rise", RULES)["all_caps"]
    assert not headline_parts("NASDAQ and NATO and the IMF", RULES)["all_caps"]
    assert headline_parts("Here’s why rates are rising", RULES)["clickbait"]
    worst = headline_parts("BREAKING: Here's why MARKETS crashed?", RULES)
    assert worst["points"] == -10  # four penalties, floored
    assert headline_parts("Senate - The Times of Israel", RULES) == headline_parts("Senate", RULES)


def test_locality_first_health_and_complete():
    src = [BY_ID["straits_times_sg"], BY_ID["npr"]]
    arts = [_art("a", "straits_times_sg", locality="local"), _art("b", "npr", hours=6, locality="intermediate"),
            _art("c", "npr", hours=12, dek="")]
    bv = _score(arts, src)
    assert [bv[i][T("locality")] for i in "abc"] == [15, 8, 0]
    assert [bv[i][T("first")] for i in "abc"] == [10, 5, 0]
    assert [bv[i][T("complete")] for i in "abc"] == [7, 7, 0]
    prev = {"npr": {"consecutive_error": 3}, "straits_times_sg": {"consecutive_error": 2}}
    bv = _score(arts, src, previous_health=prev)
    assert [bv[i][T("health")] for i in "abc"] == [0, -5, -5]
    bv = _score(arts, src, source_health={"straits_times_sg": {"consecutive_error": 4}})
    assert bv["a"][T("health")] == -5


def test_only_stories_with_two_outlets_are_scored():
    fox = [BY_ID["fox_politics"], BY_ID["fox_latest"]]  # one outlet, one S08 group
    assert _score([_art("a", "fox_politics"), _art("b", "fox_latest")], fox) == {}
    ap_pbs = _score([_art("a", "ap"), _art("b", "pbs_newshour")], [AP, BY_ID["pbs_newshour"]])
    assert ap_pbs == {}  # PBS reruns AP: one outlet
    assert set(_score([_art("a", "fox_politics"), _art("b", "npr")], [BY_ID["fox_politics"], BY_ID["npr"]])) == {"a", "b"}


# --- the built pool and the page ----------------------------------------------------

def _rss(items):
    body = "".join(
        f"<item><title>{title}</title><link>{link}</link>"
        f"<pubDate>Fri, 25 Sep 2026 {10 + i:02d}:00:00 GMT</pubDate>"
        f"<description>{dek}</description></item>"
        for i, (title, link, dek) in enumerate(items))
    return f'<rss version="2.0"><channel>{body}</channel></rss>'.encode("utf-8")


def _story_pool(sources):
    title = "Hong Kong legislature approves Beijing security bill after marathon debate"
    dek = "Hong Kong lawmakers passed the national security bill backed by Beijing on Friday."
    feeds = {
        "hong_kong_free_press": _rss([(title, "https://hkfp.example/1", dek)]),
        "scmp_china": _rss([(title + " in Hong Kong", "https://scmp.example/1", dek)]),
        "npr": _rss([(title, "https://npr.example/1", dek),
                     ("A quiet library board vote in Ohio", "https://npr.example/2", "Nothing else.")]),
    }
    return build_pool_fanout(sources, {sid: (data, None) for sid, data in feeds.items()}, NOW)


def test_a_built_pool_carries_bv_on_multi_outlet_stories_and_validates():
    sources = [BY_ID[s] for s in ("hong_kong_free_press", "scmp_china", "npr")]
    pool = _story_pool(sources)
    assert validate(pool) == []
    [cluster] = pool["clusters"]
    scored = {a["id"] for a in pool["articles"] if "bv" in a}
    assert scored == set(cluster["article_ids"]) and len(scored) == 3
    for a in pool["articles"]:
        if "bv" in a:
            assert len(a["bv"]) == 8 and all(isinstance(x, int) for x in a["bv"])
    by_source = {a["source_id"]: a for a in pool["articles"] if "bv" in a}
    assert by_source["hong_kong_free_press"]["bv"][T("locality")] == 15
    assert by_source["scmp_china"]["bv"][T("paywall")] == -15
    # Lean and roster swapped on every source: the pool is byte for byte the same but
    # for the sources block that carries roster.
    again = _story_pool(_lean_and_roster_shuffled(sources))
    strip = lambda p: {k: v for k, v in p.items() if k != "sources"}
    assert dumps(strip(again)) == dumps(strip(pool))
    bad = copy.deepcopy(pool)
    next(a for a in bad["articles"] if "bv" in a)["bv"].append(0)
    assert validate(bad), "the contract refuses a bv of the wrong length"


def test_the_build_embeds_each_carousel_members_bv_for_versions_js():
    pool = _story_pool([BY_ID[s] for s in ("hong_kong_free_press", "scmp_china", "npr")])
    want = {a["id"]: a["bv"] for a in sorted(pool["articles"], key=lambda a: a["id"]) if "bv" in a}
    assert version_bv(pool) == want and want
    page = render(pool)
    data = decode_input(json.loads(re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)
                      .replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")))
    assert data["bv"] == want
    assert "bv" not in json.dumps(data["pool"]["articles"]), "the ranker's own input keeps its shape"


def test_bv_stays_inside_its_byte_share_of_the_pool():
    # Section 4a: about 150 scored articles, under 5KB. Fixture 1's 42 multi-outlet
    # stories are the measured case; each bv adds `,"bv":[...]` to one article.
    articles, _ = score_fixture(json.loads(FIXTURES[0].read_text(encoding="utf-8")), SOURCES)
    scored = [a for a in articles if "bv" in a]
    added = sum(len(dumps({"bv": a["bv"]})) - 1 for a in scored)
    assert added < 5_000, added
    assert max(len(dumps({"bv": a["bv"]})) - 1 for a in scored) <= 40
