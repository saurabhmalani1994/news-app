"""B4: source roster, Atom bodies for Jacobin, three-tier locality. No network."""
import copy
import inspect
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.build import render, version_locality
from contract.validate import validate
from fetcher import fanout
from fetcher.bodies import FULL_TEXT_MIN_CHARS, extract_body_html
from fetcher.fanout import PER_SOURCE_CAP, PUBLISHED_DEK_CHARS, build_pool_fanout, load_sources
from fetcher.fetch import _plain, iter_feed_items, parse_xml
from fetcher.geo import load_geo, tag_countries
from fetcher.locality import annotate, story_countries, tier_for

ROOT = Path(__file__).resolve().parents[1]
SOURCES = load_sources(ROOT / "sources.json")
BY_ID = {s["id"]: s for s in SOURCES}
JACOBIN = (ROOT / "tests/fixtures/jacobin_atom.xml").read_bytes()
NOW = datetime(2026, 9, 25, 14, 0, 0, tzinfo=timezone.utc)
NEW_FEEDS = {"fox_latest", "fox_world", "daily_wire", "redstate", "breitbart", "the_federalist",
             "jacobin", "the_intercept", "common_dreams", "new_republic", "democracy_now"}
PENDING_OWNER = {"allafrica_sudan": "US", "allafrica_general": "US", "radio_dabanga": "NL",
                 "radio_tamazuj": "NL", "euronews_en": "BE", "asia_times": "HK", "green_queen": "HK"}


def _rss(items):
    body = "".join(
        f"<item><title>{title}</title><link>{link}</link>"
        f"<pubDate>Fri, 25 Sep 2026 {10 + i % 3:02d}:{i:02d}:00 GMT</pubDate>"
        f"<description>{dek}</description></item>"
        for i, (title, link, dek) in enumerate(items))
    return f'<rss version="2.0"><channel>{body}</channel></rss>'.encode("utf-8")


def _results(feeds):
    return {sid: (data, None) for sid, data in feeds.items()}


# --- sources.json: the roster facts --------------------------------------------------

def test_every_source_has_roster_paywall_country_and_a_lean_with_its_basis():
    assert len(SOURCES) == 108
    for s in SOURCES:
        assert s["roster"] in ("core", "perspective"), s["id"]
        assert isinstance(s["paywall"], bool), s["id"]
        assert re.fullmatch(r"[A-Z]{2}", s["country"]), s["id"]
        assert s["lean"] and s["lean_basis"], s["id"]
        assert isinstance(s["full_text_ok"], bool), s["id"]
    assert {s["id"] for s in SOURCES if s["roster"] == "perspective"} == NEW_FEEDS


def test_the_section_3_feeds_are_in_with_their_leans_and_jacobin_is_atom():
    leans = {sid: BY_ID[sid]["lean"] for sid in NEW_FEEDS}
    assert Counter(leans.values()) == {"right": 6, "left": 5}  # Fox counts twice: latest, world
    assert BY_ID["jacobin"]["feed_url"] == "https://jacobin.com/feed/"
    assert BY_ID["new_republic"]["paywall"] is True
    # Fox's three feeds are one outlet for independence (S08) and for the carousel.
    assert {BY_ID[s]["syndication_group"] for s in ("fox_politics", "fox_latest", "fox_world")} == {"fox_politics"}


def test_full_text_ok_follows_the_feeds_that_carry_full_text():
    for sid in ("fox_latest", "fox_world", "daily_wire", "jacobin", "the_intercept", "common_dreams",
                "new_republic", "hong_kong_free_press", "propublica", "global_voices", "mothership"):
        assert BY_ID[sid]["full_text_ok"] is True, sid
    for sid in ("redstate", "breitbart", "the_federalist", "democracy_now"):
        assert BY_ID[sid]["full_text_ok"] is False, sid


def test_u3_country_calls_still_awaiting_the_owner_and_the_exile_newsrooms():
    for sid, country in PENDING_OWNER.items():
        assert BY_ID[sid]["country"] == country, sid
    assert BY_ID["radio_dabanga"]["exile_of"] == "SD" and BY_ID["radio_dabanga"]["exile_basis"]
    assert BY_ID["radio_tamazuj"]["exile_of"] == "SS" and BY_ID["radio_tamazuj"]["exile_basis"]
    assert {s["id"] for s in SOURCES if "exile_of" in s} == {"radio_dabanga", "radio_tamazuj"}


def test_nothing_reads_roster_for_ranking_leading_or_publishing():
    # DESIGN-bundles section 3. In the fetcher only _pool_source (the pool record) and
    # main's log line name it; no app code does. The swap test below proves the behaviour.
    for path in [*ROOT.glob("app/**/*.py"), *ROOT.glob("app/static/js/*.js"), *ROOT.glob("fetcher/*.py")]:
        if path.name != "fanout.py":
            assert "roster" not in path.read_text(encoding="utf-8"), path
    for fn in (fanout.build_pool_fanout, fanout._extract_article, fanout._published_clusters):
        assert "roster" not in inspect.getsource(fn), fn.__name__


# --- the same caps for every source --------------------------------------------------

def _two_outlets(fox_roster, npr_roster):
    fox = {**BY_ID["fox_latest"], "roster": fox_roster}
    npr = {**BY_ID["npr"], "roster": npr_roster}
    feeds = {
        "fox_latest": _rss([(f"Fox only story number {i} about a county fair", f"https://fox.example/{i}", "A dek.")
                            for i in range(9)]),
        "npr": _rss([(f"NPR item {i} on a quiet library board vote", f"https://npr.example/{i}", "A dek.")
                     for i in range(9)]),
    }
    return build_pool_fanout([fox, npr], _results(feeds), NOW)


def test_a_fox_only_story_publishes_like_any_source_under_the_same_caps():
    pool = _two_outlets("perspective", "core")
    assert validate(pool) == []
    per_source = Counter(a["source_id"] for a in pool["articles"])
    assert per_source == {"fox_latest": PER_SOURCE_CAP, "npr": PER_SOURCE_CAP}
    assert pool["counts"]["drops"]["over_cap"] == 2 * (9 - PER_SOURCE_CAP)
    fox_only = [a for a in pool["articles"] if a["source_id"] == "fox_latest"]
    assert not any(a["id"] in c["article_ids"] for c in pool["clusters"] for a in fox_only)
    # The roster is provenance only: swapping it moves no article, cluster or count.
    swapped = _two_outlets("core", "perspective")
    strip = lambda p: {k: v for k, v in p.items() if k != "sources"}
    assert strip(swapped) == strip(pool)
    assert {s["id"]: s["roster"] for s in swapped["sources"]} == {"fox_latest": "core", "npr": "perspective"}


def test_pool_sources_carry_roster_paywall_and_exile_of_in_b3s_shape():
    pool = build_pool_fanout([BY_ID["radio_dabanga"], BY_ID["wsj_world"]], _results({
        "radio_dabanga": _rss([("Darfur talks resume", "https://d.example/1", "Sudan.")]),
        "wsj_world": _rss([("Markets slip", "https://w.example/1", "Stocks.")]),
    }), NOW)
    assert validate(pool) == []
    records = {s["id"]: s for s in pool["sources"]}
    assert records["radio_dabanga"] == {"id": "radio_dabanga", "name": "Radio Dabanga",
                                        "feed_url": BY_ID["radio_dabanga"]["feed_url"], "country": "NL",
                                        "roster": "core", "paywall": False, "exile_of": "SD"}
    assert records["wsj_world"]["paywall"] is True and "exile_of" not in records["wsj_world"]


def test_democracy_nows_daily_headlines_item_is_dropped_by_its_title_rule():
    feed = _rss([("Headlines for September 24, 2026", "https://dn.example/h", "Many stories."),
                 ("Nepali Activist at U.N. Rally Calls for Climate Justice", "https://dn.example/a", "Nepal."),
                 ("Headlines about headlines: a media critic speaks", "https://dn.example/b", "Media.")])
    pool = build_pool_fanout([BY_ID["democracy_now"]], _results({"democracy_now": feed}), NOW)
    assert validate(pool) == []
    c = pool["counts"]
    assert c["drops"] == {"title_rule": 1}
    assert c["fetched"] == c["published"] + sum(c["drops"].values()) == 3
    assert "https://dn.example/h" not in {a["url"] for a in pool["articles"]}


def test_a_published_dek_is_cut_on_a_word_boundary_after_clustering_reads_it_whole():
    long_dek = " ".join(["Tigray"] + ["word"] * 400)
    feed = _rss([("A long item", "https://long.example/1", long_dek),
                 ("A short item", "https://long.example/2", "Short dek.")])
    pool = build_pool_fanout([BY_ID["axios"]], _results({"axios": feed}), NOW)
    deks = {a["url"]: a["dek"] for a in pool["articles"]}
    assert len(deks["https://long.example/1"]) <= PUBLISHED_DEK_CHARS
    assert deks["https://long.example/1"].endswith("word") and long_dek.startswith(deks["https://long.example/1"])
    assert deks["https://long.example/2"] == "Short dek."


# --- Jacobin's Atom feed ----------------------------------------------------------------

def test_the_saved_jacobin_atom_fixture_yields_title_link_date_dek_and_a_full_body():
    root = parse_xml(JACOBIN, Counter())
    entries, kind = iter_feed_items(root)
    assert kind == "atom" and len(entries) == 3
    bodies = {}
    pool = build_pool_fanout([BY_ID["jacobin"]], _results({"jacobin": JACOBIN}), NOW, bodies_out=bodies)
    assert validate(pool) == []
    arts = pool["articles"]
    assert len(arts) == 3
    for a in arts:
        assert a["title"].startswith("Fixture Entry")
        assert a["url"].startswith("https://jacobin.com/2026/09/fixture-entry-")  # the id: no <link>
        assert re.fullmatch(r"2026-09-2[45]T\d\d:\d\d:\d\dZ", a["published_at"])
        assert a["dek"] and not a["dek"].startswith(("<", "The council met"))  # the summary, not the body
        assert a["has_body"] is True
    assert arts[0]["published_at"] == "2026-09-25T12:46:11Z"  # published wins over updated
    assert "Fixture Entry Two & the Long List of Demands" in {a["title"] for a in arts}
    for record in bodies["bodies"].values():
        html = record["body_html"]
        assert len(_plain(html)) > 2000
        assert html.startswith("<p>") and html.count("<p>") == 8  # paragraphs kept, not run together
        assert "xmlns" not in html and "<em>emphasis</em>" in html
    assert pool["counts"]["bodies"]["written"] == 3


def test_an_atom_text_content_is_still_read_as_before():
    feed = ('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><id>https://x.example/1</id>'
            '<published>2026-09-25T10:00:00Z</published><content type="html">'
            + ("&lt;p&gt;" + "word " * 500 + "&lt;/p&gt;") + "</content></entry></feed>").encode()
    entries, kind = iter_feed_items(parse_xml(feed, Counter()))
    body = extract_body_html(entries[0], kind)
    assert body.startswith("<p>") and len(_plain(body)) >= FULL_TEXT_MIN_CHARS


# --- countries per article ----------------------------------------------------------------

@pytest.mark.parametrize("title, want", [
    ("Trump meets Xi in Beijing", ["CN", "US"]),
    ("North Korea fires missile toward Japan", ["JP", "KP"]),
    ("Papua New Guinea quake", ["PG"]),
    ("Hong Kong court jails activist", ["HK"]),
    ("Macau casino revenue rises", ["MO"]),
    ("HDB resale prices in Punggol", ["SG"]),
    ("New Mexico governor signs bill", ["US"]),
    ("Latin American leaders meet", []),
    ("Chinese Americans rally in San Francisco", ["US"]),
    ("Ethiopian army repels Tigray rebels", ["ET"]),
    ("Kuala Lumpur and Singapore sign water deal", ["MY", "SG"]),
    ("Taiwanese president visits Paraguay", ["PY", "TW"]),
    ("Sudanese RSF shells El Fasher", ["SD"]),
    ("South Sudan's Kiir dissolves government", ["SS"]),
])
def test_tag_countries_reads_the_articles_own_text(title, want):
    assert tag_countries(title, "") == want


def test_an_outlet_name_is_never_a_country_signal():
    assert tag_countries("Water rates rise", "A Straits Times report; the Japan Times and Times of Israel agree.") == []


# --- three tiers ------------------------------------------------------------------------

PAIRS = load_geo()["intermediate"]


def _tier(sid, countries):
    return tier_for(BY_ID[sid], countries, PAIRS)


@pytest.mark.parametrize("sid, story, want", [
    ("hong_kong_free_press", ["CN"], "intermediate"),   # R40 answer 5
    ("scmp_china", ["CN"], "intermediate"),
    ("scmp_china", ["HK"], "local"),
    ("japan_times", ["CN"], "overseas"),
    ("focus_taiwan", ["CN"], "overseas"),               # R42: Taiwan is the third tier
    ("focus_taiwan", ["TW"], "local"),
    ("malay_mail", ["SG"], "intermediate"),             # R42: MY and SG on each other
    ("straits_times_sg", ["MY"], "intermediate"),
    ("cna_asia", ["MY"], "intermediate"),
    ("malay_mail", ["MY"], "local"),
    ("straits_times_sg", ["TH"], "overseas"),
    ("radio_dabanga", ["SD"], "intermediate"),          # R42: exile newsroom on its country
    ("radio_tamazuj", ["SS"], "intermediate"),
    ("radio_dabanga", ["SS"], "overseas"),
    ("radio_dabanga", ["NL"], "local"),
    ("japan_times", ["CN", "JP"], "local"),             # two story countries: the nearer wins
    ("hong_kong_free_press", ["US", "CN"], "intermediate"),
])
def test_the_three_tiers(sid, story, want):
    assert _tier(sid, story) == want


def test_a_source_or_story_without_a_country_gets_no_tier():
    assert tier_for({"id": "google_news"}, ["US"], PAIRS) is None
    assert _tier("npr", None) is None


def _art(aid, sid, countries):
    return {"id": aid, "source_id": sid, "countries": countries}


def test_story_countries_are_named_by_at_least_half_the_outlets_at_most_two():
    # Four outlets: CN named by all, US by two (half), JP by one.
    members = [_art("a", "npr", ["CN", "US"]), _art("b", "japan_times", ["CN", "JP"]),
               _art("c", "scmp_china", ["CN", "US"]), _art("d", "focus_taiwan", ["CN"])]
    assert story_countries(members) == ["CN", "US"]
    # One outlet's three pieces count once, so they cannot outvote the others.
    members = [_art("a", "npr", ["US"]), _art("b", "npr", ["US"]), _art("c", "npr", ["US"]),
               _art("d", "bbc_world", ["GB"]), _art("e", "japan_times", ["GB"])]
    assert story_countries(members) == ["GB"]
    assert story_countries([_art("a", "npr", ["CN", "US", "IR"])]) is None  # more than 2: no label
    assert story_countries([_art("a", "npr", [])]) is None


def test_annotate_writes_story_countries_and_every_members_tier_in_a_valid_pool():
    articles = [
        {"id": "hk1", "source_id": "hong_kong_free_press", "countries": ["CN"]},
        {"id": "sc1", "source_id": "scmp_china", "countries": ["CN"]},
        {"id": "jt1", "source_id": "japan_times", "countries": ["CN", "JP"]},
        {"id": "ft1", "source_id": "focus_taiwan", "countries": ["CN", "TW"]},
        {"id": "st1", "source_id": "straits_times_sg"},                         # names nothing
        {"id": "mm1", "source_id": "malay_mail", "countries": ["SG"]},           # alone
        {"id": "db1", "source_id": "radio_dabanga", "countries": ["SD", "US", "EG"]},  # alone, 3
    ]
    clusters = [{"id": "c_hk1", "article_ids": ["hk1", "sc1", "jt1", "ft1", "st1"]}]
    tiers = annotate(articles, clusters, SOURCES)
    by = {a["id"]: a.get("locality") for a in articles}
    assert clusters[0]["story_countries"] == ["CN"]
    assert by == {"hk1": "intermediate", "sc1": "intermediate", "jt1": "overseas", "ft1": "overseas",
                  "st1": "overseas", "mm1": "intermediate", "db1": None}
    assert tiers == {"intermediate": 3, "overseas": 3}


# --- a whole pool, then the page --------------------------------------------------------

def _cn_story_pool():
    sources = [BY_ID[s] for s in ("hong_kong_free_press", "japan_times", "scmp_china", "npr")]
    title = "Xi Jinping hosts summit in Beijing as China pushes trade talks"
    feeds = {
        "hong_kong_free_press": _rss([(title, "https://hkfp.example/1", "China's leader Xi Jinping hosted.")]),
        "japan_times": _rss([(title + " with Japan watching", "https://jt.example/1", "Beijing summit, China.")]),
        "scmp_china": _rss([("Hong Kong legislature passes budget", "https://scmp.example/1", "Hong Kong lawmakers.")]),
        "npr": _rss([(title, "https://npr.example/1", "China's Xi Jinping in Beijing.")]),
    }
    return build_pool_fanout(sources, _results(feeds), NOW)


def test_a_built_pool_carries_countries_story_countries_and_tiers_and_validates():
    pool = _cn_story_pool()
    assert validate(pool) == []
    by_source = {a["source_id"]: a for a in pool["articles"]}
    [cluster] = pool["clusters"]
    assert cluster["story_countries"] == ["CN"]
    assert by_source["hong_kong_free_press"]["locality"] == "intermediate"
    assert by_source["japan_times"]["locality"] == "overseas"
    assert by_source["npr"]["locality"] == "overseas"
    assert by_source["scmp_china"]["countries"] == ["HK"]
    assert by_source["scmp_china"]["locality"] == "local"  # alone, on an HK story
    bad = copy.deepcopy(pool)
    bad["articles"][0]["locality"] = "nearby"
    assert validate(bad), "the contract refuses a tier outside the three"


def test_the_build_embeds_each_carousel_members_tier_for_versions_js():
    pool = _cn_story_pool()
    [cluster] = pool["clusters"]
    want = {aid: next(a["locality"] for a in pool["articles"] if a["id"] == aid)
            for aid in sorted(cluster["article_ids"])}
    assert version_locality(pool) == want
    page = render(pool)
    data = json.loads(re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)
                      .replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    assert data["locality"] == want
    assert set(want.values()) == {"intermediate", "overseas"}
