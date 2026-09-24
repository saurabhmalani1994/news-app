"""S04 proof: tiers are deterministic for a fixture pool, every cluster appears exactly
once as its lead, every rendered string is text only (R26), and the hero and river use
distinct type tokens. Plus the display-layer quote transform, on its own."""
import copy
import random
import re

import pytest

from app import frontpage
from app.build import render
from app.frontpage import (HERO_COUNT, RIVER_COUNT, SECONDARY_COUNT, _lead, build_stories,
                           clean_dek, front_page, independent_source_count, run_ranker)
from app.typography import fold_quotes, smart_quotes
from tests.test_render import _parse
from tests.test_tokens import DARK_TOKENS, STYLE_CSS, _block_after, _declarations, _resolve

SOURCES = [f"s{i:02d}" for i in range(12)]


def _article(n, source, hour, minute=0, title=None, dek=""):
    a = {
        "id": f"a{n:03d}",
        "source_id": source,
        "url": f"https://example.org/{n}",
        "title": title or f"Story number {n} from {source}",
        "published_at": f"2026-09-24T{hour:02d}:{minute:02d}:00Z",
    }
    if dek:
        a["dek"] = dek
    return a


def fixture_pool():
    """40 articles, 5 clusters (one with a syndicated near-duplicate group, one whose
    members all come from one outlet), the rest singletons at varied times."""
    arts = [_article(i, SOURCES[i % 12], hour=i % 20, minute=i % 60, dek=f"Dek for {i}.") for i in range(40)]
    clusters = [
        # 6 members, 5 outlets, two of them one syndicated copy: 4 independent sources.
        {"id": "a000", "method": "minhash+cosine_entity",
         "article_ids": ["a000", "a001", "a002", "a003", "a004", "a013"],
         "near_duplicates": [["a003", "a004"]]},
        {"id": "a005", "method": "cosine_entity", "article_ids": ["a005", "a006", "a007"], "near_duplicates": []},
        {"id": "a008", "method": "cosine_entity", "article_ids": ["a008", "a009"], "near_duplicates": []},
        {"id": "a010", "method": "minhash", "article_ids": ["a010", "a011"], "near_duplicates": [["a010", "a011"]]},
        # Same outlet twice: one independent source.
        {"id": "a012", "method": "cosine_entity", "article_ids": ["a012", "a024"], "near_duplicates": []},
    ]
    return {
        "schema_version": 1,
        "generated_at": "2026-09-24T21:00:00Z",
        "sources": [{"id": s, "name": f"Outlet {s}", "feed_url": f"https://example.org/{s}.xml"} for s in SOURCES],
        "articles": arts,
        "clusters": clusters,
        "counts": {"fetched": 40, "published": 40, "drops": {}, "leniency": {}},
    }


def _tier_ids(pool):
    return {name: [s.id for s in stories] for name, stories in front_page(pool).items()}


# Proof 1: tier assignment is deterministic.

def test_same_input_same_tiers():
    pool = fixture_pool()
    first = _tier_ids(pool)
    assert first == _tier_ids(copy.deepcopy(pool))
    assert render(pool) == render(copy.deepcopy(pool))


def test_tiers_do_not_depend_on_array_order():
    pool = fixture_pool()
    expected = _tier_ids(pool)
    rng = random.Random(4)
    for _ in range(20):
        shuffled = copy.deepcopy(pool)
        rng.shuffle(shuffled["articles"])
        rng.shuffle(shuffled["clusters"])
        for cluster in shuffled["clusters"]:
            rng.shuffle(cluster["article_ids"])
        assert _tier_ids(shuffled) == expected


def test_tier_sizes_follow_the_order():
    tiers = _tier_ids(fixture_pool())
    # 40 articles, 5 clusters holding 15 of them: 25 singletons + 5 stories = 30.
    assert [len(tiers[t]) for t in frontpage.TIERS] == [
        HERO_COUNT, SECONDARY_COUNT, RIVER_COUNT, 30 - HERO_COUNT - SECONDARY_COUNT - RIVER_COUNT]


def test_front_page_follows_the_one_ranker():
    """S11 replaced interim_order: the page's order is ranker.js's, best score first,
    over exactly the stories build_stories makes."""
    pool = fixture_pool()
    ranking = run_ranker(pool)
    flat = [s.id for name in frontpage.TIERS for s in front_page(pool)[name]]
    assert flat == [r["id"] for r in ranking["ranked"]]
    assert sorted(flat) == sorted(s.id for s in build_stories(pool))
    scores = [r["score"] for r in ranking["ranked"]]
    assert scores == sorted(scores, reverse=True)
    for r in ranking["ranked"]:
        assert sum(t["value"] for t in r["explanation"]) == r["score"]
    assert flat[0] == "a000"  # 4 independent sources and the newest member


def test_lead_prefers_a_dek_that_fits_without_an_ellipsis():
    """D1: among members with a dek, one that fits a lead block with no ellipsis fronts
    the cluster, even over a newer one that would need cutting; then the old rule."""
    long_dek = "An unbroken opening sentence that runs on and on well past what any lead block can hold " * 2
    newest_long = _article(1, "s01", hour=20, dek=long_dek.strip())
    older_fits = _article(2, "s02", hour=18, dek="A short dek that fits.")
    newest_no_dek = _article(3, "s03", hour=21)
    assert _lead([newest_long, older_fits, newest_no_dek])["id"] == "a002"
    also_fits = _article(4, "s04", hour=19, dek="Another short one.")
    assert _lead([older_fits, also_fits, newest_long])["id"] == "a004"  # then newest
    assert _lead([newest_long, newest_no_dek])["id"] == "a001"  # a dek still beats none


# Proof 2: every cluster appears exactly once.

def test_every_cluster_appears_exactly_once():
    pool = fixture_pool()
    stories = [s for stories in front_page(pool).values() for s in stories]
    ids = [s.id for s in stories]
    assert len(ids) == len(set(ids))
    members = [aid for s in stories for aid in s.article_ids]
    assert sorted(members) == sorted(a["id"] for a in pool["articles"])  # each article once
    parsed = _parse(render(pool))
    rendered_urls = set(parsed.hrefs)
    by_id = {a["id"]: a for a in pool["articles"]}
    for cluster in pool["clusters"]:
        shown = [aid for aid in cluster["article_ids"] if by_id[aid]["url"] in rendered_urls]
        assert len(shown) == 1, (cluster["id"], shown)
    assert len(parsed.items) == len(stories)


def test_independent_sources_collapse_syndicated_copies_and_repeat_outlets():
    pool = fixture_pool()
    counts = {s.id: s.independent_sources for s in build_stories(pool)}
    assert counts["a000"] == 4  # 5 outlets, one pair of them syndicated copies
    assert counts["a010"] == 1  # the whole cluster is one piece of copy
    assert counts["a012"] == 1  # one outlet twice
    assert independent_source_count([], []) == 0


def test_cluster_meta_names_its_source_count_quietly():
    pool = fixture_pool()
    parsed = _parse(render(pool))
    hero_meta = parsed.metas[0]
    assert "4 sources" in hero_meta
    singles = [m for m, tier in zip(parsed.metas, parsed.tiers) if tier == "text-only"]
    assert singles and not any("sources" in m for m in singles)


# Proof 3: every rendered string is text only (R26).

# S10: svg/circle/path are the app's own static masthead icon (the profile-screen
# entry point), authored in app/build.py's PAGE template, never built from a feed
# field, so allowing them here does not touch the R26 guarantee this test checks.
# S11: script is the app's own head gate (APP_SCRIPTS, an external file carrying no feed
# data) and template holds the device ranker's input as escaped text, never markup.
# S27: nav, div and button are the app's own tab strip, bottom nav and empty views, and
# tabs.js is the app's own module (no feed data); their labels are checked below.
# S25: article is the reader layer's empty container, filled on the device only with
# text nodes and S37-sanitized body markup; reader.js is the app's own module.
# S18: offline-gate.js/offline.js (the offline line) and sw-register.js (the service
# worker) are the app's own external files too, no feed data.
APP_TAGS = {"html", "head", "meta", "title", "link", "body", "header", "h1", "main", "ol", "li",
            "a", "span", "section", "h2", "footer", "p", "time", "svg", "circle", "path",
            "script", "template", "nav", "div", "button", "article"}
APP_SCRIPTS = ['<script src="js/offline-gate.js">', '<script src="js/rank-gate.js">',
               '<script type="module" src="js/tabs.js">', '<script type="module" src="js/reader.js">',
               '<script src="js/sw-register.js" defer>', '<script src="js/offline.js">']


def test_every_rendered_string_is_text_only():
    pool = fixture_pool()
    evil = '<script>alert(1)</script><img src=x onerror="alert(2)"><iframe srcdoc="x">'
    for article in pool["articles"]:
        article["title"] = evil + article["id"]
        article["dek"] = evil + " dek"
    for source in pool["sources"]:
        source["name"] = "<b onclick=alert(3)>" + source["id"]
    page = render(pool)
    parsed = _parse(page)
    assert set(parsed.tags) <= APP_TAGS
    assert re.findall(r"<script\b[^>]*>", page) == APP_SCRIPTS
    assert "<img" not in page and "<iframe" not in page and "<b " not in page
    for text in parsed.items:
        assert fold_quotes(text).startswith(evil)
    for dek in (d for d in parsed.deks if d is not None):
        assert fold_quotes(dek) == evil + " dek"
    for meta in parsed.metas:
        assert meta.startswith("<b onclick=alert(3)>")


# Proof 4: hero and river use distinct type tokens.

def test_hero_river_and_text_only_resolve_to_distinct_tokens():
    rules = {sel: _declarations(_block_after(STYLE_CSS, sel + " {"))
             for sel in (".headline--hero", ".headline--river", ".headline")}
    assert rules[".headline--hero"]["font-size"] == "var(--type-hero-headline-size)"
    assert rules[".headline--river"]["font-size"] == "var(--type-river-headline-size)"
    assert rules[".headline"]["font-size"] == "var(--type-text-only-headline-size)"
    for prop in ("font-size", "line-height"):
        px = [float(_resolve(DARK_TOKENS, rules[s][prop])[:-2]) for s in rules]
        assert px[0] > px[1] > px[2], (prop, px)


def test_tiers_render_with_their_own_headline_class():
    page = render(fixture_pool())
    parsed = _parse(page)
    assert parsed.tiers[:HERO_COUNT] == ["hero"]
    hero_rows = re.findall(r'<li class="story story--(\w[\w-]*)"[^>]*>.*?<span class="(headline[^"]*)"', page)
    classes = {tier: cls for tier, cls in hero_rows}
    assert classes == {"hero": "headline headline--hero", "secondary": "headline headline--river",
                       "river": "headline headline--river", "text-only": "headline"}


def test_deks_only_on_hero_and_lead_blocks():
    parsed = _parse(render(fixture_pool()))
    for dek, tier in zip(parsed.deks, parsed.tiers):
        if tier in ("hero", "secondary"):
            assert dek, tier
        else:
            assert dek is None, tier


def test_dek_repeating_the_title_is_dropped():
    assert clean_dek({"title": "Rain in Spain", "dek": "  Rain in   Spain, mostly on the plain"}) == ""
    assert clean_dek({"title": "Rain", "dek": ""}) == ""
    assert clean_dek({"title": "Rain", "dek": " Mostly  plains. "}) == "Mostly plains."


def test_image_slot_is_reserved_without_shift():
    media = _declarations(_block_after(STYLE_CSS, ".story-media {"))
    assert media["aspect-ratio"] == "1 / 1"
    river = _declarations(_block_after(STYLE_CSS, ".story--river .story-media {"))
    assert river["width"] == "88px"


# The display-layer quote transform, tested separately from the title proof.

@pytest.mark.parametrize("raw, shown", [
    ("Trump's ban", "Trump’s ban"),
    ('He said "no" today', "He said “no” today"),
    ("'Forever' weapons", "‘Forever’ weapons"),
    ("the students' union", "the students’ union"),
    ("Back to the '90s", "Back to the ’90s"),
    ('"\'Quoted\' inside"', "“‘Quoted’ inside”"),
    ("(\"Aside\")", "(“Aside”)"),
    ("No quotes at all", "No quotes at all"),
    ("Already ‘curly’", "Already ‘curly’"),
])
def test_smart_quotes(raw, shown):
    assert smart_quotes(raw) == shown
    assert fold_quotes(shown) == fold_quotes(raw)


def test_smart_quotes_changes_only_quote_characters():
    text = 'It\'s "fine" -- isn\'t it? 5\'10" and \'26 & <b>'
    out = smart_quotes(text)
    assert len(out) == len(text)
    for a, b in zip(text, out):
        assert a == b or (a in "'\"" and b in "‘’“”")


def test_front_page_ends_after_a_capped_tail_with_the_rest_one_tap_away():
    """D1 length rule: hero, lead blocks and river, then a labelled module of at most
    MORE_COUNT text-only rows; every other story sits in a closed native <details>,
    in order, still text only."""
    from app.build import MORE_COUNT
    arts = [_article(i, SOURCES[i % 12], hour=i % 24, minute=i % 60, dek=f"Dek {i}.") for i in range(80)]
    pool = {"generated_at": "2026-09-24T23:59:00Z", "articles": arts, "clusters": [],
            "sources": [{"id": s, "name": s.upper()} for s in SOURCES]}
    page = render(pool)
    top = HERO_COUNT + SECONDARY_COUNT + RIVER_COUNT
    shown, _, hidden = page.partition('<details class="more-rest">')
    assert shown.count('<li class="story') == top + MORE_COUNT
    assert hidden.count('<li class="story story--text-only') == 80 - top - MORE_COUNT
    assert f"Show {80 - top - MORE_COUNT} more headlines</summary>" in hidden
    assert "<details open" not in page  # closed until the reader asks
    parsed = _parse(page)
    assert len(parsed.items) == 80  # nothing dropped, order kept
    assert set(parsed.tags) <= APP_TAGS | {"details", "summary"}


def test_short_pool_has_no_rest_toggle():
    page = render(fixture_pool())
    assert "more-rest" not in page and "More headlines" in page


def test_device_rank_input_is_escaped_text_that_round_trips():
    """The embedded ranker input (S11) is template text: hostile titles stay text, and
    unescaped it is the same compact pool the build ranked."""
    import html
    import json
    from app.frontpage import rank_input
    pool = fixture_pool()
    pool["articles"][3]["title"] = '</template><script>alert(1)</script>'
    page = render(pool)
    raw = re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)
    assert "<" not in raw and ">" not in raw
    data = json.loads(html.unescape(raw))
    assert data["pool"] == rank_input(pool) and data["now"] == pool["generated_at"]
    assert re.findall(r"<script\b[^>]*>", page) == APP_SCRIPTS
    rows = re.findall(r'<li class="story story--[\w-]+" data-sid="([^"]+)">', page)
    assert rows == [r["id"] for r in run_ranker(pool)["ranked"]]
    assert re.search(r'<html lang="en" data-rank-key="[^"]+" data-generated-at="[^"]*">', page)


# S27: the section tabs and the bottom nav are the app's own text-only labels, in the
# owner's order, the Live slot rendered hidden for S33, and You reaches the profile.
def test_section_tabs_and_bottom_nav_are_text_only_labels():
    page = render(fixture_pool())
    tabs = re.findall(r'<button class="tab"[^>]*data-section="([^"]+)"([^>]*)>([^<]*)</button>', page)
    assert [label for _, _, label in tabs] == ["Today", "Live", "US Politics", "World", "Singapore", "Asia", "AI", "Biotech"]
    assert [sid for sid, rest, _ in tabs if "hidden" in rest] == ["live"]
    assert re.findall(r'<span class="nav-label">([^<]*)</span>', page) == ["Home", "Following", "Saved", "You"]
    assert '<a class="nav-item" href="profile.html" data-screen="you">' in page
    assert 'class="masthead-action"' not in page  # the gear moved to the You tab
    for view in ("following", "saved"):
        assert f'id="screen-{view}"' in page and "empty-head" in page
    panels = re.findall(r'<section class="panel" id="section-([^"]+)"', page)
    assert panels == ["today", "live", "us-politics", "world", "singapore", "asia", "ai", "biotech"]


def test_profile_page_carries_the_same_bottom_nav_with_you_current():
    from app.build import STATIC, bottom_nav
    profile = (STATIC / "profile.html").read_text(encoding="utf-8")
    assert bottom_nav("you").replace('class="bottom-nav"', 'class="bottom-nav bottom-nav--fixed"') in profile
    assert 'data-screen="you" aria-current="page"' in profile
