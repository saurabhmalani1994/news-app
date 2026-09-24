"""S04 proof: tiers are deterministic for a fixture pool, every cluster appears exactly
once as its lead, every rendered string is text only (R26), and the hero and river use
distinct type tokens. Plus the display-layer quote transform, on its own."""
import copy
import random
import re

import pytest

from app import frontpage
from app.build import render
from app.frontpage import (HERO_COUNT, RIVER_COUNT, SECONDARY_COUNT, build_stories,
                           clean_dek, front_page, independent_source_count, interim_order)
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


def test_interim_order_is_sources_then_recency():
    ordered = interim_order(build_stories(fixture_pool()))
    keys = [(-s.independent_sources, -frontpage._epoch(s.latest), s.id) for s in ordered]
    assert keys == sorted(keys)
    assert ordered[0].id == "a000" and ordered[0].independent_sources == 4


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

APP_TAGS = {"html", "head", "meta", "title", "link", "body", "header", "h1", "main", "ol", "li",
            "a", "span", "section", "h2", "footer", "p", "time"}


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
    assert "<script" not in page and "<img" not in page and "<iframe" not in page and "<b " not in page
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
    hero_rows = re.findall(r'<li class="story story--(\w[\w-]*)">.*?<span class="(headline[^"]*)"', page)
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
