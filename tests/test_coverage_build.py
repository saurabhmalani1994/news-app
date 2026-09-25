"""S14 build side: the coverage trigger renders only for a 2-or-more-independent-source
cluster, never nested inside the card's own link, and the device gets exactly the extra
facts js/coverage.js needs (ownership labels, each article's url and has_body), kept
apart from the ranker's own compact pool."""
import html
import json
import re

from app.build import coverage_articles, coverage_summary_text, render
from app.frontpage import source_ownership

NOW = "2026-09-24T12:00:00Z"


def _article(aid, source, hour, title=None, has_body=False, url=None):
    a = {"id": aid, "source_id": source, "url": url or f"https://example.org/{aid}",
         "title": title or f"Headline {aid} from {source}",
         "published_at": f"2026-09-24T{hour:02d}:00:00Z", "topics": ["world"]}
    if has_body:
        a["has_body"] = True
    return a


def pool():
    arts = [
        _article("c1a", "al_jazeera", 9, title="Ceasefire talks resume", has_body=True),
        _article("c1b", "bbc_world", 8, title="Ceasefire talks resume, officials say"),
        _article("c1c", "npr", 7, title="Talks on ceasefire restart"),
        _article("solo", "npr", 10, title="A single-source story"),
    ]
    return {
        "schema_version": 1, "generated_at": NOW,
        "sources": [{"id": s, "name": n, "feed_url": f"https://example.org/{s}.xml"} for s, n in [
            ("al_jazeera", "Al Jazeera"), ("bbc_world", "BBC World"), ("npr", "NPR")]],
        "articles": arts,
        "clusters": [{"id": "c1", "method": "cosine_entity", "article_ids": ["c1a", "c1b", "c1c"],
                      "near_duplicates": [], "independent_sources": 3,
                      "lean_buckets": ["state", "center", "center-left"]}],
        "counts": {"fetched": 4, "published": 4, "drops": {}, "leniency": {}},
    }


def test_source_ownership_reads_the_repo_sources_json():
    # al_jazeera is state-funded in the real sources.json; a source with no ownership
    # fact is simply absent, never a made-up empty string.
    ownership = source_ownership(pool())
    assert ownership.get("al_jazeera") == "state-funded"
    assert "npr" not in ownership


def test_coverage_articles_covers_only_multi_source_clusters_url_and_has_body():
    data = coverage_articles(pool())
    assert set(data) == {"c1a", "c1b", "c1c"}  # "solo" is a single-source story, excluded
    assert data["c1a"] == {"url": "https://example.org/c1a", "has_body": True}
    assert data["c1b"]["has_body"] is False


def test_coverage_summary_text_counts_outlets_independent_and_leans():
    p = pool()
    by_id = {a["id"]: a for a in p["articles"]}
    text = coverage_summary_text(p["clusters"][0], by_id)
    assert text == "3 outlets, 3 independent, across 3 leans"


def test_story_coverage_button_renders_for_the_cluster_and_never_for_a_single_source_story():
    page = render(pool())
    row = re.search(r'<li class="story[^"]*" data-sid="c1">(.*?)</li>', page, re.S).group(1)
    # The card's own link closes before the coverage button opens: never nested, the
    # same rule STORY_OVERFLOW and the other-side link already hold to.
    before_button = row.split('<button class="story-coverage"', 1)[0]
    assert before_button.count("<a ") == before_button.count("</a>") == 1
    button = re.search(r'<button class="story-coverage"[^>]*>', row).group(0)
    assert 'data-sid="c1"' in button
    # V1: the trigger opens the versions carousel, whose footer opens the coverage view.
    assert 'aria-label="Compare versions: 3 outlets, 3 independent, across 3 leans"' in button
    solo_row = re.search(r'<li class="story[^"]*" data-sid="solo">(.*?)</li>', page, re.S).group(1)
    assert "story-coverage" not in solo_row


def test_rank_input_carries_ownership_and_coverage_for_the_device():
    page = render(pool())
    raw = re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)
    data = json.loads(html.unescape(raw))
    assert data["ownership"]["al_jazeera"] == "state-funded"
    assert data["coverage"]["c1a"] == {"url": "https://example.org/c1a", "has_body": True}
    assert "solo" not in data["coverage"]
