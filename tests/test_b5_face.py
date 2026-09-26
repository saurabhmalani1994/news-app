"""B5: the face of a scored story is its best version (DESIGN-bundles section 4a), picked
by app/frontpage.py face_of at build and by app/static/js/versions.js faceOf on the
device; they must be one choice (R2 parity). No network."""
import json
import random
import re
import shutil
import subprocess
from html import unescape
from pathlib import Path

import pytest

from app.page_input import decode_input
from app.build import render
from app.frontpage import build_stories, face_of, ranked_stories, run_ranker, version_bv
from fetcher.best_version import score_fixture
from fetcher.fanout import load_sources

ROOT = Path(__file__).resolve().parents[1]
SOURCES = load_sources(ROOT / "sources.json")
FIXTURES = sorted((ROOT / "tests/fixtures/bundles").glob("gold_*.json"))
NODE = shutil.which("node")
VERSIONS = (ROOT / "app/static/js/versions.js").as_uri()

JS_FACES = """
import { faceOf, versionsContext } from %s;
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { pool, bv, cases } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const ctx = versionsContext({ pool, bv });
const out = cases.map(({ muted, trust }) => Object.fromEntries(pool.clusters.map((c) => [c.id, faceOf(c, ctx, { muted, trust })])));
process.stdout.write(JSON.stringify(out));
"""


def _fixture_pool(path):
    """A gold fixture scored as the cron would, shaped as a pool: each labeled story a
    cluster; every third cluster of 3+ articles given a near-duplicate group so the
    fold of syndicated copy is exercised too."""
    articles, clusters = score_fixture(json.loads(path.read_text(encoding="utf-8")), SOURCES)
    by_id = {a["id"]: a for a in articles}
    out = []
    for i, c in enumerate(clusters):
        record = {"id": c["id"], "article_ids": c["article_ids"],
                  "independent_sources": len({by_id[a]["source_id"] for a in c["article_ids"]}),
                  "near_duplicates": [c["article_ids"][:2]] if i % 3 == 0 and len(c["article_ids"]) > 2 else []}
        out.append(record)
    return {"generated_at": "2026-09-24T12:00:00Z", "articles": articles, "clusters": out}


@pytest.mark.skipif(NODE is None, reason="needs Node")
@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.name)
def test_build_and_device_pick_the_same_face_for_any_trust_and_mutes(path):
    pool = _fixture_pool(path)
    bv = version_bv(pool)
    assert len(bv) >= 30
    by_id = {a["id"]: a for a in pool["articles"]}
    sources = sorted({a["source_id"] for a in pool["articles"]})
    rng = random.Random(5)
    cases = [{"muted": [], "trust": {}}]
    for _ in range(12):
        cases.append({"muted": rng.sample(sources, 3),
                      "trust": {s: rng.choice([0.5, 0.8, 1.2, 1.5, 2.0]) for s in rng.sample(sources, 8)}})
    for c in pool["clusters"]:
        c["lead"] = c["article_ids"][0]  # the unscored fallback; every cluster here is scored
    script = JS_FACES % json.dumps(VERSIONS)
    done = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, check=True,
                          input=json.dumps({"pool": pool, "bv": bv, "cases": cases}).encode("utf-8"))
    device = json.loads(done.stdout)
    compared = changed = 0
    for case, faces in zip(cases, device):
        for c in pool["clusters"]:
            members = [by_id[a] for a in c["article_ids"]]
            if not any(a["id"] in bv for a in members):
                continue
            face = face_of(members, c["near_duplicates"], bv, case["trust"], case["muted"])
            want = face["id"] if face else c["lead"]
            assert faces[c["id"]] == want, (c["id"], case)
            compared += 1
            changed += want != device[0][c["id"]]
    assert compared > 100 and changed > 0, "the cases do move some faces"


def _pool():
    """An NPR and Fox bundle, Fox ahead by 2, plus a BBC version, with deks for the D1
    lead rule to prefer NPR, so the face differs from what the old rule would pick."""
    def art(aid, source, hour, title, dek, bv):
        return {"id": aid, "source_id": source, "title": title, "url": f"https://example.org/{aid}",
                "published_at": f"2026-09-25T{hour:02d}:00:00Z", "dek": dek, "topics": ["us_politics"], "bv": bv}
    articles = [
        art("npr1", "npr", 9, "Senate passes the budget bill 51 to 49", "Lawmakers voted before dawn.", [20, 7, 0, 4, 0, 10, 0, 0]),
        art("fox1", "fox_news", 10, "GOP claims a win as the budget bill passes", "", [20, 15, 3, 2, 0, 3, 0, 0]),
        art("bbc1", "bbc_world", 8, "US Senate passes $1.2tn spending bill", "The bill now goes to the House.",
            [20, 7, 0, 6, 0, 5, 0, 0]),
    ]
    sources = [{"id": "npr", "name": "NPR"}, {"id": "fox_news", "name": "Fox News"}, {"id": "bbc_world", "name": "BBC World"}]
    clusters = [{"id": "c1", "article_ids": ["bbc1", "fox1", "npr1"], "independent_sources": 3, "near_duplicates": [],
                 "lean_buckets": ["center", "center-left", "right"]}]
    return {"generated_at": "2026-09-25T12:00:00Z", "sources": sources, "articles": articles, "clusters": clusters}


def _embedded(page):
    return decode_input(json.loads(unescape(re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1))))


@pytest.mark.skipif(NODE is None, reason="needs Node")
def test_the_page_is_built_with_the_best_version_and_embeds_every_other_face():
    pool = _pool()
    [story] = [s for s in build_stories(pool) if s.id == "c1"]
    assert story.lead["id"] == "fox1", "the best version, not the D1 dek rule's NPR"
    ranking = run_ranker(pool)
    assert ranking["faces"]["c1"] == "fox1"
    page = render(pool, ranking)
    row = re.search(r'<li class="story story--hero" data-sid="c1">.*?</li>', page, re.S).group(0)
    assert "GOP claims a win" in row and '<span class="meta-source">Fox News</span>' in row
    data = _embedded(page)
    assert [c["lead"] for c in data["pool"]["clusters"] if c["id"] == "c1"] == ["fox1"]
    assert data["bv"] == version_bv(pool)
    fronts = data["fronts"]
    assert sorted(fronts) == ["bbc1", "fox1", "npr1"]
    assert fronts["npr1"]["t"] == "Senate passes the budget bill 51 to 49"
    assert fronts["npr1"]["d"][0] == "Lawmakers voted before dawn."
    assert fronts["npr1"]["a"] == "3h ago"
    assert "d" not in fronts["fox1"], "no dek worth showing, none carried"


@pytest.mark.skipif(NODE is None, reason="needs Node")
def test_a_face_the_ranker_disagrees_with_fails_the_build():
    pool = _pool()
    ranking = run_ranker(pool)
    ranking["faces"]["c1"] = "npr1"
    with pytest.raises(RuntimeError, match="face mismatch on c1"):
        ranked_stories(pool, ranking)


def test_an_unscored_story_keeps_the_d1_lead_and_lean_never_moves_the_face():
    pool = _pool()
    for a in pool["articles"]:
        a.pop("bv")
    [story] = [s for s in build_stories(pool) if s.id == "c1"]
    assert story.lead["id"] == "npr1", "no bv: the D1 rule (a dek that fits, then the newest)"
    members = _pool()["articles"]
    bv = {a["id"]: a["bv"] for a in members}
    assert face_of(members, [], bv)["id"] == "fox1"
    assert face_of(members, [], bv, trust={"npr": 1.5})["id"] == "npr1"
    assert face_of(members, [], bv, muted=["fox_news"])["id"] == "npr1"
    assert face_of(members, [], bv, muted=["fox_news", "npr", "bbc_world"]) is None
