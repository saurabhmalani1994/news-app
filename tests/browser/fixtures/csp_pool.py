"""H4 item 6: the pool tests/browser/csp_check.mjs needs for its "every section tab"
check, since the repo's golden_pool.json (tests/fixtures/golden_pool.json) has one
source and no topic or geo tags: every section but Today and World reads 0 rows there,
which the check refuses (every tab must show at least one row). Prints JSON to stdout:

    python tests/browser/fixtures/csp_pool.py > /tmp/csp_pool.json
    python -m app.build --pool /tmp/csp_pool.json --out /tmp/dist_csp
    node tests/browser/csp_check.mjs /tmp/dist_csp

One article per section tab (app/static/js/sections.js SECTIONS), each from a real
sources.json id so app.frontpage.source_buckets (which reads bucket by id from the repo
file, not the pool) actually resolves it: politico for US Politics, npr (bucket
"general") for World, techcrunch_ai for AI, labiotech for Biotech, and two geo-tagged
articles (no bucket needed) for Singapore and Asia. Plus a few filler singles so Today
holds more than a handful of rows.
"""
import json
import sys

NOW = "2026-09-24T12:00:00Z"

SOURCES = [
    {"id": "npr", "name": "NPR", "feed_url": "https://example.org/npr.xml"},
    {"id": "politico", "name": "Politico", "feed_url": "https://example.org/politico.xml"},
    {"id": "techcrunch_ai", "name": "TechCrunch", "feed_url": "https://example.org/tc.xml"},
    {"id": "labiotech", "name": "Labiotech", "feed_url": "https://example.org/labiotech.xml"},
    {"id": "straits_times_sg", "name": "Straits Times", "feed_url": "https://example.org/st.xml"},
    {"id": "japan_times", "name": "Japan Times", "feed_url": "https://example.org/jt.xml"},
]


def _article(n, source, hours_ago, title, topics=(), geo=()):
    a = {
        "id": f"a{n:03d}",
        "source_id": source,
        "url": f"https://example.org/{n}",
        "title": title,
        "published_at": f"2026-09-24T{max(0, 11 - hours_ago):02d}:00:00Z",
    }
    if topics:
        a["topics"] = list(topics)
    if geo:
        a["geo"] = list(geo)
    return a


def build_pool():
    articles = [
        _article(0, "npr", 0, "City council approves new transit budget", topics=("world",)),
        _article(1, "politico", 1, "Senate advances a bipartisan spending deal", topics=("us_politics",)),
        _article(2, "techcrunch_ai", 2, "A new model claims a coding benchmark record", topics=("ai",)),
        _article(3, "labiotech", 3, "A biotech startup raises a Series B for gene therapy", topics=("biotech",)),
        _article(4, "straits_times_sg", 4, "Singapore raises its climate resilience budget", geo=("sg",)),
        _article(5, "japan_times", 5, "Tokyo and Seoul agree on a new trade framework", geo=("asia",)),
    ]
    for i in range(6, 12):
        articles.append(_article(i, "npr", i, f"World filler story number {i}", topics=("world",)))
    counts = {"fetched": len(articles), "published": len(articles), "drops": {}, "leniency": {}}
    return {"schema_version": 1, "generated_at": NOW, "sources": SOURCES, "articles": articles,
            "clusters": [], "counts": counts}


if __name__ == "__main__":
    json.dump(build_pool(), sys.stdout, indent=2)
