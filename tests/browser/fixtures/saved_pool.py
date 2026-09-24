"""T1: builds the pool tests/browser/saved_check.mjs needs, since the proof was
authored against a local pool that was never committed. Prints JSON to stdout:

    python tests/browser/fixtures/saved_pool.py > /tmp/saved_pool.json
    python -m app.build --pool /tmp/saved_pool.json --out /tmp/dist_saved
    node tests/browser/saved_check.mjs /tmp/dist_saved sb1

The proof takes the first two stories on Today as is (tests/browser/saved_check.mjs
line ~99) and later looks up the saved has_body story by the exact --bodyId CLI
argument (default b827ba1a90cf4138, from an older pool this repo no longer has). So
the pool must rank a has_body story first and a no-body story second, and the id
passed on the command line must match the has_body one: "sb1" here.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from tests.test_standing_build import _article, _health  # noqa: E402

NOW = "2026-09-24T12:00:00Z"


# A real, small, https image so the river card's own thumbnail renders (both saved
# rows need one for the proof's own "river card's own thumbnail" check).
IMAGE = {"url": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/"
                "Camponotus_flavomarginatus_ant.jpg/640px-Camponotus_flavomarginatus_ant.jpg",
         "width": 640, "height": 427}


def build_pool():
    has_body = _article("sb1", "haaretz", 1, "A has_body story that ranks first", ("world",))
    has_body["has_body"] = True
    has_body["image"] = IMAGE
    no_body = _article("sb2", "haaretz", 2, "An ordinary story with no body", ("world",))
    no_body["image"] = IMAGE
    articles = [has_body, no_body]
    sources = [{"id": "haaretz", "name": "Haaretz", "feed_url": "https://example.org/hz"}]
    health = {"haaretz": _health()}
    counts = {"fetched": len(articles), "published": len(articles), "drops": {}, "leniency": {}}
    return {"schema_version": 1, "generated_at": NOW, "sources": sources, "articles": articles,
            "clusters": [], "source_health": health, "counts": counts}


if __name__ == "__main__":
    json.dump(build_pool(), sys.stdout, indent=2)
