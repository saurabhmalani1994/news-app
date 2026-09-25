"""H4 item 6: the pool tests/browser/actions_check.mjs needs for its mute/scroll-anchor
check, since the repo's golden_pool.json (tests/fixtures/golden_pool.json) has only one
source, five articles: muting it wipes the whole page, so there is never an anchor row
left that is not itself being removed, and never enough content to scroll past one
screen in the first place. Prints JSON to stdout:

    python tests/browser/fixtures/actions_pool.py > /tmp/actions_pool.json
    python -m app.build --pool /tmp/actions_pool.json --out /tmp/dist_actions
    node tests/browser/actions_check.mjs /tmp/dist_actions

TARGET_COUNT rows from one source ("chatty"), spread across the ranked list well below
the hero/secondary/river cutoff (app/frontpage.py HERO_COUNT + SECONDARY_COUNT +
RIVER_COUNT = 15) so muting it never reclassifies an on-screen row from river to
text-only (a genuine height change, not the scroll-anchor bug the check means to
catch) and enough filler rows total that the page runs well past one 780px screen.
Every article is a plain "world" single (no cluster), so no other pass (lean quota,
exploration, must-know, standing story) reaches in and reorders things in a way that
would make the scenario flaky.
"""
import json
import sys

NOW = "2026-09-24T12:00:00Z"
TARGET_COUNT = 10
FILLER_COUNT = 60
# Ranks 1..TIER_SAFE_RANK are never touched: plenty of headroom past the hero/secondary/
# river cutoff (15) so the tier boundary itself never moves.
TIER_SAFE_RANK = 20


def _article(n, source, hours_ago, title):
    return {
        "id": f"a{n:03d}",
        "source_id": source,
        "url": f"https://example.org/{n}",
        "title": title,
        "published_at": f"2026-09-24T{max(0, 11 - hours_ago):02d}:00:00Z",
        "topics": ["world"],
    }


def build_pool():
    articles = []
    sources = [{"id": "chatty", "name": "Chatty Daily", "feed_url": "https://example.org/chatty.xml"}]
    n = 0
    # The first TIER_SAFE_RANK ranks are filler only, newest first, so they always sit
    # above the muted rows and never change tier.
    for i in range(TIER_SAFE_RANK):
        src = f"filler{i:02d}"
        sources.append({"id": src, "name": f"Filler {i}", "feed_url": f"https://example.org/{src}.xml"})
        articles.append(_article(n, src, i, f"World filler story number {i}"))
        n += 1
    # From there down, "chatty" rows interleaved with more filler, both comfortably in
    # the text-only tier before and after the mute.
    target_left = TARGET_COUNT
    for i in range(TIER_SAFE_RANK, FILLER_COUNT):
        if target_left and i % 4 == 0:
            articles.append(_article(n, "chatty", i, f"Chatty Daily story number {TARGET_COUNT - target_left}"))
            target_left -= 1
            n += 1
        src = f"filler{i:02d}"
        sources.append({"id": src, "name": f"Filler {i}", "feed_url": f"https://example.org/{src}.xml"})
        articles.append(_article(n, src, i, f"World filler story number {i}"))
        n += 1
    while target_left:
        articles.append(_article(n, "chatty", FILLER_COUNT, f"Chatty Daily story number {TARGET_COUNT - target_left}"))
        target_left -= 1
        n += 1
    counts = {"fetched": len(articles), "published": len(articles), "drops": {}, "leniency": {}}
    return {"schema_version": 1, "generated_at": NOW, "sources": sources, "articles": articles,
            "clusters": [], "counts": counts}


if __name__ == "__main__":
    json.dump(build_pool(), sys.stdout, indent=2)
