"""S28 build side: the silence alarm reaches the page as a notice under the nameplate,
text only, from the same function the device runs; source health in the pool decides
between "no coverage" and "sources failing"; the floor's placement is the page order;
and the page embeds what the device needs to draw the same notices."""
import html
import json
import re

from app.build import render
from app.frontpage import failing_sources, pass_input, run_ranker

NOW = "2026-09-24T12:00:00Z"


def _article(aid, source, hours_ago, title, topics):
    hour = 12 - hours_ago
    day = 24
    while hour < 0:
        hour += 24
        day -= 1
    return {"id": aid, "source_id": source, "url": f"https://example.org/{aid}", "title": title,
            "published_at": f"2026-09-{day:02d}T{hour:02d}:00:00Z", "topics": list(topics)}


def _health(state="ok", errors=0, unhealthy=False):
    return {"state": state, "last_ok_at": None if unhealthy else NOW, "last_item_at": None,
            "consecutive_empty": 0, "consecutive_error": errors, "items_fetched": 0 if unhealthy else 5,
            "unhealthy": unhealthy}


def pool(sudan_hours_ago=None, sudan_failing=False):
    """Twenty AI singles, one Gaza story from Haaretz, and optionally one Sudan story from
    Radio Dabanga (sources.json bucket sudan, beside AllAfrica Sudan)."""
    # The AI outlets are not in sources.json, so they have no lean and the lean quota
    # leaves the score order alone.
    arts = [_article(f"a{i:02d}", f"lab{i}", 1, f"Model release number {i} ships to developers", ("ai",))
            for i in range(20)]
    arts.append(_article("gz", "haaretz", 2, "Gaza ceasefire talks resume in Cairo", ("conflict", "world")))
    if sudan_hours_ago is not None:
        arts.append(_article("sd", "radio_dabanga", sudan_hours_ago,
                             "Civilians flee North Kordofan as fighting escalates", ("conflict",)))
    sources = [{"id": "techcrunch_ai", "name": "TechCrunch", "feed_url": "https://example.org/tc"},
               {"id": "haaretz", "name": "Haaretz", "feed_url": "https://example.org/hz"},
               {"id": "radio_dabanga", "name": "Radio Dabanga", "feed_url": "https://example.org/rd"},
               {"id": "allafrica_sudan", "name": "AllAfrica <Sudan>", "feed_url": "https://example.org/aa"}]
    bad = _health("http_error", 17, True)
    health = {"techcrunch_ai": _health(), "haaretz": _health(),
              "radio_dabanga": bad if sudan_failing else _health(),
              "allafrica_sudan": bad if sudan_failing else _health()}
    return {"schema_version": 1, "generated_at": NOW, "sources": sources, "articles": arts, "clusters": [],
            "source_health": health}


def _notices(page):
    box = re.search(r'<section class="notices" id="standing-notices"[^>]*>(.*?)</section>', page, re.S)
    assert box, "the notices container is always on the page"
    return box.group(1)


def test_failing_sources_reads_unhealthy_entries_only():
    p = pool(sudan_failing=True)
    assert failing_sources(p) == {"allafrica_sudan": {"state": "http_error", "runs": 17},
                                  "radio_dabanga": {"state": "http_error", "runs": 17}}
    assert failing_sources({"articles": []}) == {}
    assert pass_input(p)["health"] == failing_sources(p)


def test_floor_placement_is_the_page_order():
    ranking = run_ranker(pool(sudan_hours_ago=30))
    order = [r["id"] for r in ranking["ranked"]]
    assert order.index("sd") < 15
    entry = [e for e in ranking["ranked"][order.index("sd")]["passes"] if e["pass"] == "standing-story"]
    assert entry[0]["text"].startswith("Placed by standing story: Sudan, floor 1 in the top 15")
    assert ranking["notices"] == []
    page = render(pool(sudan_hours_ago=30), ranking)
    assert _notices(page) == ""


def test_silence_notice_no_coverage_renders_as_text():
    page = render(pool(sudan_hours_ago=40))
    box = _notices(page)
    assert box.count('class="notice"') == 1
    assert 'data-standing="sudan" data-kind="no-coverage"' in box
    assert "No new Sudan coverage in 40 hours" in box
    assert "Your 2 Sudan sources are answering, so this is a gap in coverage, not a broken feed." in box
    # It sits under the nameplate, above the first story.
    assert page.index('id="standing-notices"') < page.index('id="headlines"')


def test_silence_notice_sources_failing_names_them_escaped():
    page = render(pool(sudan_hours_ago=None, sudan_failing=True))
    box = _notices(page)
    assert 'data-kind="sources-failing"' in box
    assert "Your Sudan sources are failing" in box
    # A source name is a feed-side string: escaped, never markup (R26).
    assert "AllAfrica &lt;Sudan&gt; and Radio Dabanga (HTTP errors, 17 fetches in a row)." in box
    assert "<Sudan>" not in box
    # The device gets the same health to draw the same notice after a re-rank.
    data = json.loads(html.unescape(re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)))
    assert data["health"] == {"allafrica_sudan": {"state": "http_error", "runs": 17},
                              "radio_dabanga": {"state": "http_error", "runs": 17}}


def test_notices_are_deterministic():
    assert render(pool(sudan_hours_ago=40)) == render(pool(sudan_hours_ago=40))
