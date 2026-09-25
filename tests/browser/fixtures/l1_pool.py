"""H4 item 6: the pool tests/browser/l1_check.mjs needs, since the repo's golden_pool.json
(tests/fixtures/golden_pool.json) has one source (NPR, center-left, no us_politics
bucket) and no cluster with full text at two outlets: the "Read here" check finds no
rows to look at, the color check has only one lean to compare, the R43 trust-flip check
prints "skipped" every time, and the You page's source picker crashes navigating to
#sources/us_politics, a group the pool never populates.

Unlike the other H4-added fixtures, this one needs real body files on disk too (U1: a
story opens in the reader only when some member has one), so this script writes a
directory, not just pool JSON to stdout:

    python tests/browser/fixtures/l1_pool.py /tmp/l1
    python -m app.build --pool /tmp/l1/pool.json --out /tmp/dist_l1
    cp -r /tmp/l1/bodies /tmp/dist_l1/bodies
    node tests/browser/l1_check.mjs /tmp/dist_l1

Real sources.json ids so app.frontpage/app.source_catalog (which read bucket/lean/country
by id from the repo file, not the pool) resolve every marker the checks look for:
politico and fox_politics (us_politics bucket, center-left and right, both full_text_ok,
so the You page's source-group walk reaches #sources/us_politics with a lean-hit to
tap), axios (center, for the three-way color check alongside those two), al_jazeera
(state media), straits_times_sg (a non-US country code), and npr for plain filler.

One cluster (the "flip" case R43 looks for): a lead from an uncatalogued source with no
body, given a dek so the lead rule (app/frontpage.py _lead, D1: a member with a dek that
fits wins first) always picks it regardless of publish time, and two members with real
body files from different outlets on opposite ends of the scale, so trust can flip which
one "Read here" names.
"""
import json
import sys
from pathlib import Path

NOW = "2026-09-24T12:00:00Z"

SOURCES = [
    {"id": "npr", "name": "NPR", "feed_url": "https://example.org/npr.xml"},
    {"id": "politico", "name": "Politico", "feed_url": "https://example.org/politico.xml"},
    {"id": "fox_politics", "name": "Fox News Politics", "feed_url": "https://example.org/fox.xml"},
    {"id": "axios", "name": "Axios", "feed_url": "https://example.org/axios.xml"},
    {"id": "al_jazeera", "name": "Al Jazeera", "feed_url": "https://example.org/aj.xml"},
    {"id": "straits_times_sg", "name": "The Straits Times", "feed_url": "https://example.org/st.xml"},
    {"id": "labx", "name": "Lab X Wire", "feed_url": "https://example.org/labx.xml"},
]

BODIES = {
    "fpol": {"schema_version": 1, "article_id": "fpol", "source_id": "politico", "source_name": "Politico",
              "url": "https://example.org/fpol", "body_html": "<p>The committee released its report after a closed session.</p>"
                      "<p>Members from both parties said the vote would come within the week.</p>"},
    "ffox": {"schema_version": 1, "article_id": "ffox", "source_id": "fox_politics", "source_name": "Fox News Politics",
              "url": "https://example.org/ffox", "body_html": "<p>The committee released its report late Tuesday.</p>"
                      "<p>Republicans on the panel called the process fair and the outcome expected.</p>"},
}


def _article(n, source, hours_ago, title, topics=(), geo=(), has_body=False, dek=None):
    a = {
        "id": f"a{n:03d}" if not isinstance(n, str) else n,
        "source_id": source,
        "url": f"https://example.org/{n}",
        "title": title,
        "published_at": f"2026-09-24T{max(0, 11 - hours_ago):02d}:00:00Z",
    }
    if topics:
        a["topics"] = list(topics)
    if geo:
        a["geo"] = list(geo)
    if has_body:
        a["has_body"] = True
    if dek:
        a["dek"] = dek
    return a


def build_pool():
    articles = [
        _article(0, "npr", 0, "City council approves new transit budget", topics=("world",)),
        _article(1, "politico", 1, "Senate advances a bipartisan spending deal", topics=("us_politics",)),
        _article(2, "fox_politics", 2, "Governor signs a border security measure", topics=("us_politics",)),
        _article(3, "axios", 3, "A midsize bank reports a surprise quarterly profit", topics=("world",)),
        _article(4, "al_jazeera", 4, "Regional talks resume after a week-long pause", topics=("world",)),
        _article(5, "straits_times_sg", 5, "Singapore raises its climate resilience budget", geo=("sg",)),
    ]
    for i in range(6, 14):
        articles.append(_article(i, "npr", i, f"World filler story number {i}", topics=("world",)))
    # The R43 flip fixture: a lead with no body (given a dek so app/frontpage.py's _lead
    # picks it over the two members below, neither of which carries one) and two
    # full-text members from outlets on opposite ends of the US scale.
    lead = _article("flead", "labx", 6, "Committee report expected within the week",
                     topics=("us_politics",), dek="A short recap while the full report is still under wraps.")
    m1 = _article("fpol", "politico", 6, "Panel report lands after a closed session", topics=("us_politics",), has_body=True)
    m2 = _article("ffox", "fox_politics", 6, "Panel report lands late Tuesday", topics=("us_politics",), has_body=True)
    articles += [lead, m1, m2]
    clusters = [
        {"id": "flead", "method": "cosine_entity", "article_ids": ["flead", "fpol", "ffox"], "near_duplicates": []},
    ]
    counts = {"fetched": len(articles), "published": len(articles), "drops": {}, "leniency": {}}
    return {"schema_version": 1, "generated_at": NOW, "sources": SOURCES, "articles": articles,
            "clusters": clusters, "counts": counts}


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/l1")
    out.mkdir(parents=True, exist_ok=True)
    (out / "pool.json").write_text(json.dumps(build_pool(), indent=2), encoding="utf-8")
    bodies_dir = out / "bodies"
    bodies_dir.mkdir(exist_ok=True)
    for aid, record in BODIES.items():
        (bodies_dir / f"{aid}.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    print(f"wrote {out / 'pool.json'} and {len(BODIES)} body file(s) under {bodies_dir}")
