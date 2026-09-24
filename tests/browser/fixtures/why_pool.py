"""T1: builds the pool tests/browser/why_check.mjs needs, since the proof was authored
against a local pool that was never committed. Prints JSON to stdout:

    python tests/browser/fixtures/why_pool.py > /tmp/why_pool.json
    python -m app.build --pool /tmp/why_pool.json --out /tmp/dist_why
    node tests/browser/why_check.mjs /tmp/dist_why

Reuses S28's own _article/_health helpers (tests/test_standing_build.py) so the Sudan
story keeps producing that pass's exact wording ("Placed by standing story: Sudan,
floor 1 in the top 15"), the same scenario S28's own pytest suite already covers.

Three things the proof's hardcoded ids need, worked out by trial runs against this
scenario (a standing-story floor inserts one item into the ranked list, and every
article ranked below the insertion point shifts down by one and is annotated, all the
way to the end of the list, not just the ones next to it; a topic's single best-ranked
story can also be claimed by the exploration pass):
  - a hero: whichever story ranks highest (read from the page, not hardcoded).
  - "sd1": the Sudan story a coverage gap should place, deliberately older than
    everything else so it would not organically place in the top 15.
  - "a00": genuinely untouched by any pass, so it needs to rank BETTER than the
    floor's own landing spot (top 15) to dodge the insertion cascade, worse than the
    hero, and not be the best-ranked story of its own topic (else exploration claims
    it) -- an ordinary "world" story a few ranks below the hero fits all three.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from tests.test_standing_build import _article, _health  # noqa: E402

NOW = "2026-09-24T12:00:00Z"


def build_pool():
    a00 = _article("a00", "bbc", 6, "An ordinary world story with nothing special about it", ("world",))
    fillers = [_article(f"w{i:02d}", "bbc", i + 1, f"World filler story number {i}", ("world",)) for i in range(1, 40)]
    # Old and low-ranked on purpose: never the hero, never the best of topic ai, so
    # exploration has no reason to touch them either.
    ai_singles = [_article(f"a{i:02d}", f"lab{i}", 60 + i, f"Model release number {i} ships to developers", ("ai",))
                  for i in range(1, 20)]
    gz = _article("gz", "haaretz", 2, "Gaza ceasefire talks resume in Cairo", ("conflict", "world"))
    # Deliberately older than everything else: no organic coverage in the ranked
    # window, which is what makes the standing-story floor place it.
    sd1 = _article("sd1", "radio_dabanga", 30, "Civilians flee North Kordofan as fighting escalates", ("conflict",))

    articles = [a00, *ai_singles, gz, sd1, *fillers]
    sources = [
        {"id": "techcrunch_ai", "name": "TechCrunch", "feed_url": "https://example.org/tc"},
        {"id": "haaretz", "name": "Haaretz", "feed_url": "https://example.org/hz"},
        {"id": "radio_dabanga", "name": "Radio Dabanga", "feed_url": "https://example.org/rd"},
        {"id": "allafrica_sudan", "name": "AllAfrica <Sudan>", "feed_url": "https://example.org/aa"},
        {"id": "bbc", "name": "BBC", "feed_url": "https://example.org/bbc"},
    ]
    health = {s["id"]: _health() for s in sources}
    counts = {"fetched": len(articles), "published": len(articles), "drops": {}, "leniency": {}}
    return {"schema_version": 1, "generated_at": NOW, "sources": sources, "articles": articles,
            "clusters": [], "source_health": health, "counts": counts}


if __name__ == "__main__":
    json.dump(build_pool(), sys.stdout, indent=2)
