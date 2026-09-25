"""S34 browser proof fixture: a pool with two has_body stories from real, catalogued
sources (one on the US left-right scale, Haaretz; one outside it, the Straits Times,
U3's country marker) and a third, no-body story from an uncatalogued source (no marker,
the graceful "nothing to show" case). All three rank at the top of Today, newest first,
so tests/browser/s34_check.mjs can open the first two (recording "opened") and scroll
the third into view without opening it (recording "shown", for the Seen filter).

    python tests/browser/fixtures/s34_pool.py > /tmp/s34_pool.json
    python -m app.build --pool /tmp/s34_pool.json --out /tmp/dist_s34
    node tests/browser/s34_check.mjs /tmp/dist_s34
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from tests.test_standing_build import _article, _health  # noqa: E402

NOW = "2026-09-24T12:00:00Z"

IMAGE = {"url": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/"
                "Camponotus_flavomarginatus_ant.jpg/640px-Camponotus_flavomarginatus_ant.jpg",
         "width": 640, "height": 427}


def build_pool():
    h1 = _article("h34a", "haaretz", 1, "Ceasefire talks resume after overnight strikes", ("world",))
    h1["has_body"] = True
    h1["image"] = IMAGE
    h2 = _article("h34b", "straits_times_sg", 2, "Transit budget approved after long debate", ("singapore",))
    h2["has_body"] = True
    h2["image"] = IMAGE
    h3 = _article("h34c", "labx", 3, "A quiet story nobody opens, only scrolls past", ("world",))
    articles = [h1, h2, h3]
    sources = [
        {"id": "haaretz", "name": "Haaretz", "feed_url": "https://example.org/hz"},
        {"id": "straits_times_sg", "name": "The Straits Times", "feed_url": "https://example.org/st"},
        {"id": "labx", "name": "Lab X", "feed_url": "https://example.org/lx"},
    ]
    health = {s["id"]: _health() for s in sources}
    counts = {"fetched": len(articles), "published": len(articles), "drops": {}, "leniency": {}}
    return {"schema_version": 1, "generated_at": NOW, "sources": sources, "articles": articles,
            "clusters": [], "source_health": health, "counts": counts}


if __name__ == "__main__":
    json.dump(build_pool(), sys.stdout, indent=2)
