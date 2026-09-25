"""V1 build side: the page carries the versions carousel's chrome once, hidden; the row
trigger renders only where the row's own "N sources" shows; and #rank-input carries each
multi-source member's fitted dek (`vdeks`) so every slide paints from the page itself,
with feed text escaped (R26)."""
import html
import json
import re

from app.build import render, version_deks
from app.frontpage import dek_budget

NOW = "2026-09-24T12:00:00Z"
LONG = ("Negotiators met again on Tuesday after a week of silence. They said the first round "
        "went well and a second is planned. Both sides named new envoys. A draft text is "
        "expected within days, officials said, though no date was set for signing it.")


def _article(aid, source, hour, title, dek=None):
    a = {"id": aid, "source_id": source, "url": f"https://example.org/{aid}", "title": title,
         "published_at": f"2026-09-24T{hour:02d}:00:00Z", "topics": ["world"]}
    if dek is not None:
        a["dek"] = dek
    return a


def pool(hostile_dek=None):
    arts = [
        _article("c1a", "al_jazeera", 9, "Ceasefire talks resume", dek=LONG),
        _article("c1b", "bbc_world", 8, "Ceasefire talks resume, officials say",
                 dek=hostile_dek or "Envoys say the 'first round' went well."),
        _article("c1c", "npr", 7, "Talks on ceasefire restart", dek="Talks on ceasefire restart"),
        _article("w1", "bbc_world", 6, "Storm nears the coast", dek="A wire story."),
        _article("w2", "npr", 6, "Storm nears the coast", dek="A wire story."),
        _article("solo", "npr", 10, "A single-source story", dek="Only one outlet has it."),
    ]
    return {
        "schema_version": 1, "generated_at": NOW,
        "sources": [{"id": s, "name": n, "feed_url": f"https://example.org/{s}.xml"} for s, n in [
            ("al_jazeera", "Al Jazeera"), ("bbc_world", "BBC World"), ("npr", "NPR")]],
        "articles": arts,
        "clusters": [
            {"id": "c1", "method": "cosine_entity", "article_ids": ["c1a", "c1b", "c1c"],
             "near_duplicates": [], "independent_sources": 3,
             "lean_buckets": ["state", "center", "center-left"]},
            # Two outlets ran one wire copy: the pool's field says 2, but the row counts
            # one voice and shows no "N sources", so it gets no carousel either.
            {"id": "w", "method": "cosine_entity", "article_ids": ["w1", "w2"],
             "near_duplicates": [["w1", "w2"]], "independent_sources": 2,
             "lean_buckets": ["center", "center-left"]},
        ],
        "counts": {"fetched": 6, "published": 6, "drops": {}, "leniency": {}},
    }


def _row(page, sid):
    return re.search(rf'<li class="story[^"]*" data-sid="{sid}">(.*?)</li>', page, re.S).group(1)


def _rank_input(page):
    raw = re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)
    return json.loads(html.unescape(raw))


def test_version_deks_cover_multi_source_members_fitted_typeset_and_sorted():
    deks = version_deks(pool())
    # c1c's dek repeats its headline, so it has none; the single-source story is out.
    assert list(deks) == ["c1a", "c1b", "w1", "w2"]
    assert len(deks["c1a"]) <= dek_budget("hero") and deks["c1a"].startswith("Negotiators met again")
    assert deks["c1b"] == "Envoys say the ‘first round’ went well."


def test_the_carousel_chrome_is_on_the_page_once_and_hidden():
    page = render(pool())
    assert page.count('id="bv"') == 1
    layer = re.search(r'<div class="bv" id="bv"[^>]*>', page).group(0)
    assert 'role="dialog"' in layer and 'aria-modal="true"' in layer and layer.endswith(" hidden>")
    for part in ('id="bv-strip" role="tablist"', 'aria-roledescription="carousel"', 'id="bv-all"',
                 'id="bv-marks" type="button" aria-pressed="true"'):
        assert page.count(part) == 1, part
    # Under the reader in the stack, so a "Read" inside opens above it.
    assert page.index('id="bv"') < page.index('id="reader"')
    assert page.count('<script type="module" src="js/versions-view.js"></script>') == 1


def test_the_trigger_renders_only_where_the_row_shows_n_sources():
    page = render(pool())
    c1 = _row(page, "c1")
    assert '<span class="meta-count">3 sources</span>' in c1
    assert '<button class="story-coverage" type="button" data-sid="c1"' in c1
    wire = _row(page, "w")
    assert "meta-count" not in wire and "story-coverage" not in wire
    assert "story-coverage" not in _row(page, "solo")


def test_rank_input_carries_the_version_deks():
    data = _rank_input(render(pool()))
    assert data["vdeks"] == version_deks(pool())


def test_a_hostile_dek_stays_text_in_the_page():
    evil = '</template><script>alert(1)</script><img src=x onerror="alert(2)">'
    page = render(pool(hostile_dek=evil))
    assert "<script>alert(1)" not in page and "<img src=x" not in page
    data = _rank_input(page)
    assert "<script>alert(1)</script>" in data["vdeks"]["c1b"]
