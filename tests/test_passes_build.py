"""S13 build side: the page follows the post-passes' order, the cluster's lead and the
sources' leans reach the passes, the other-side link renders as text only beside its
card, and a story may leave the page only when a pass names it as removed."""
import html
import json
import re

import pytest

from app import frontpage
from app.build import OTHER_SIDE_MIN_SOURCES, render
from app.frontpage import build_stories, pass_input, rank_input, ranked_stories, run_ranker

NOW = "2026-09-24T12:00:00Z"
HOSTILE = '<img src=x onerror=alert(1)> "Right" take'


def _article(aid, source, hour, title=None, topics=("world", "conflict"), dek=""):
    a = {"id": aid, "source_id": source, "url": f"https://example.org/{aid}",
         "title": title or f"Headline number {aid} from {source}",
         "published_at": f"2026-09-24T{hour:02d}:00:00Z", "topics": list(topics)}
    if dek:
        a["dek"] = dek
    return a


def pool():
    """One three-outlet cluster across left, right and center, fronted by the left
    outlet (the only member with a dek), and five newer left and center-left singles,
    so the page's first screen holds no right-lean card at all. Source ids are real
    sources.json ids, so their leans come from the repo's own table."""
    arts = [
        _article("c1a", "guardian_world", 9, dek="The lead member carries the dek."),
        _article("c1b", "fox_politics", 8, title=HOSTILE),
        _article("c1c", "bbc_world", 7),
    ]
    for i, src in enumerate(["guardian_world", "npr", "guardian_us", "npr", "mother_jones"]):
        arts.append(_article(f"s{i}", src, 10 + i, topics=("ai",)))
    return {
        "schema_version": 1, "generated_at": NOW,
        "sources": [{"id": s, "name": n, "feed_url": f"https://example.org/{s}.xml"} for s, n in [
            ("guardian_world", "The Guardian"), ("fox_politics", "Fox News Politics"), ("bbc_world", "BBC News"),
            ("npr", "NPR"), ("guardian_us", "Guardian US"), ("mother_jones", "Mother Jones")]],
        "articles": arts,
        "clusters": [{"id": "c1", "method": "cosine_entity", "article_ids": ["c1a", "c1b", "c1c"],
                      "near_duplicates": [], "independent_sources": 3, "lean_buckets": ["center", "left", "right"]}],
        "counts": {"fetched": 8, "published": 8, "drops": {}, "leniency": {}},
    }


def test_rank_input_names_each_cluster_lead_and_the_passes_read_repo_leans():
    p = pool()
    leads = {c["id"]: c["lead"] for c in rank_input(p)["clusters"]}
    assert leads == {s.id: s.lead["id"] for s in build_stories(p) if s.id == "c1"} == {"c1": "c1a"}
    extra = pass_input(p)
    assert extra["leans"]["fox_politics"] == "right" and extra["leans"]["guardian_world"] == "left"
    assert extra["names"]["bbc_world"] == "BBC News"
    assert OTHER_SIDE_MIN_SOURCES == 3


def test_page_order_is_the_passes_order_and_every_move_is_named():
    p = pool()
    ranking = run_ranker(p)
    rows = re.findall(r'<li class="story story--[\w-]+" data-sid="([^"]+)">', render(p, ranking))
    assert rows == [r["id"] for r in ranking["ranked"]]
    # c1 is hard news across two leans: the must-know floor holds it at the top, and it
    # says so, even though five newer singles outscore it.
    assert rows[0] == "c1"
    first = ranking["ranked"][0]
    assert first["must_know"] is True
    assert any(e["pass"] == "must-know" and e["text"].startswith("Placed by must-know") for e in first["passes"])
    by_score = sorted(ranking["ranked"], key=lambda r: -r["score"])
    for i, r in enumerate(ranking["ranked"]):
        if by_score[i]["id"] != r["id"]:
            assert r["passes"], r["id"]
    for r in ranking["ranked"]:
        assert sum(t["value"] for t in r["explanation"]) == r["score"]


def test_other_side_link_renders_beside_its_card_as_text_only():
    p = pool()
    ranking = run_ranker(p)
    record = next(r for r in ranking["ranked"] if r["id"] == "c1")
    assert record["other_side"] == {"article_id": "c1b", "source_id": "fox_politics", "lean": "right"}
    text = next(e["text"] for e in record["passes"] if e["pass"] == "other-side")
    assert "Fox News Politics (right)" in text and "least represented" in text and "(0 of 6)" in text
    page = render(p, ranking)
    row = re.search(r'<li class="story[^"]*" data-sid="c1">(.*?)</li>', page, re.S).group(1)
    # The card's own link closes before the other-side link opens: never nested.
    card, other = row.split('<a class="other-side"', 1)
    assert card.count("<a ") == card.count("</a>") == 1
    assert 'href="https://example.org/c1b"' in other and 'rel="noopener noreferrer"' in other
    assert "Other side · right · Fox News Politics" in other
    assert "&lt;img src=x onerror=alert(1)&gt;" in other and "<img src=x" not in page
    # The device gets the same link data, as text, for clusters of 3 or more outlets.
    raw = re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)
    data = json.loads(html.unescape(raw))
    assert sorted(data["links"]) == ["c1a", "c1b", "c1c"]
    assert data["links"]["c1b"][0] == "https://example.org/c1b"
    assert data["leans"]["fox_politics"] == "right"


def test_a_story_leaves_the_page_only_when_a_pass_names_it_removed():
    p = pool()
    ranking = run_ranker(p)
    gone = ranking["ranked"][-1]["id"]
    unnamed = {**ranking, "ranked": ranking["ranked"][:-1], "removed": []}
    with pytest.raises(RuntimeError):
        ranked_stories(p, unnamed)
    named = {**unnamed, "removed": [{"id": gone, "passes": [{"pass": "mute", "text": "Removed by mute: test"}]}]}
    assert [s.id for s in ranked_stories(p, named)] == [r["id"] for r in unnamed["ranked"]]
    doubled = {**ranking, "ranked": ranking["ranked"] + ranking["ranked"][:1]}
    with pytest.raises(RuntimeError):
        frontpage.ranked_stories(p, doubled)
