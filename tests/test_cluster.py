"""S07: near-duplicate detection and clustering. Known-answer fixtures, no network."""
import copy
import random
import time
from datetime import datetime, timezone

import jsonschema

from contract.validate import load_schema, validate
from fetcher.cluster import METHODS, cluster_items
from fetcher.fanout import build_pool_fanout

NOW = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)
JS = jsonschema.Draft202012Validator(load_schema())


def _item(id_, source, title, dek, hour):
    return {
        "id": id_, "source_id": source, "url": f"https://{source}.example/{id_}",
        "title": title, "dek": dek, "published_at": f"2026-09-23T{hour:02d}:00:00Z",
    }


# Three outlets on one story, each written independently: different verbs, framing and
# sentence shape, sharing the key nouns, the way the live Australia and USS Lincoln
# clusters do.
QUAKE = [
    _item("quake-a", "outlet_a",
          "Magnitude 7.1 earthquake strikes off Chile, tsunami warning issued for Valparaiso",
          "The earthquake struck off central Chile on Wednesday and authorities issued a "
          "tsunami warning for the Valparaiso coast.", 8),
    _item("quake-b", "outlet_b",
          "Chile earthquake: Valparaiso residents evacuate after tsunami warning",
          "Thousands fled low-lying parts of Valparaiso after the magnitude 7.1 earthquake "
          "shook central Chile, officials said.", 9),
    _item("quake-c", "outlet_c",
          "Powerful earthquake rattles central Chile, prompting tsunami warning",
          "The emergency office in Chile said the 7.1 magnitude quake hit offshore near "
          "Valparaiso and a tsunami warning remained in effect.", 10),
]
# Two syndicated copies of one wire story: same copy, a source suffix, one trimmed dek.
WIRE = [
    _item("wire-x", "wire_x",
          "Norway's central bank holds rates steady, signals a cut in December - Reuters",
          "Norges Bank kept its policy rate unchanged at 4.0% on Thursday and said a reduction "
          "was likely before the end of the year as inflation eased faster than expected.", 11),
    _item("wire-y", "wire_y",
          "Norway's central bank holds rates steady, signals a cut in December",
          "Norges Bank kept its policy rate unchanged at 4.0% on Thursday and said a reduction "
          "was likely before the end of the year as inflation eased.", 12),
]
# Three unrelated stories. The first shares the entity Chile with the quake story, so it
# proves that a shared entity without similar wording does not merge.
LONE = [
    _item("lone-pension", "outlet_a",
          "Chile's senate passes pension overhaul after years of debate",
          "Lawmakers in Santiago approved the retirement bill by a narrow margin, sending it to "
          "President Boric to sign.", 9),
    _item("lone-reef", "outlet_b",
          "Scientists map coral bleaching across the Great Barrier Reef",
          "Researchers in Queensland used drone surveys to chart how far a marine heatwave "
          "has spread across the reef this summer.", 10),
    _item("lone-marathon", "outlet_c",
          "Kenyan runner sets course record at the Berlin Marathon",
          "The two-time Olympic medallist finished in two hours and one minute, beating the "
          "previous best on the flat German course.", 11),
]
FIXTURE = QUAKE + WIRE + LONE


def test_fixture_clusters_exactly_as_expected():
    clusters = cluster_items(FIXTURE)
    got = {frozenset(c["article_ids"]): c for c in clusters}
    assert set(got) == {
        frozenset({"quake-a", "quake-b", "quake-c"}),
        frozenset({"wire-x", "wire-y"}),
    }
    quake = got[frozenset({"quake-a", "quake-b", "quake-c"})]
    assert quake["method"] == "cosine_entity"
    assert quake["near_duplicates"] == []
    wire = got[frozenset({"wire-x", "wire-y"})]
    assert wire["method"] == "minhash"
    assert wire["near_duplicates"] == [["wire-x", "wire-y"]]
    clustered = [i for c in clusters for i in c["article_ids"]]
    assert not {"lone-pension", "lone-reef", "lone-marathon"} & set(clustered)
    assert len(clustered) == len(set(clustered))  # at most one cluster per article


def test_every_cluster_names_its_method():
    for c in cluster_items(FIXTURE):
        assert c["method"] in METHODS


def test_result_does_not_depend_on_input_order():
    shuffled = FIXTURE[:]
    random.Random(7).shuffle(shuffled)
    a = {frozenset(c["article_ids"]): c["method"] for c in cluster_items(FIXTURE)}
    b = {frozenset(c["article_ids"]): c["method"] for c in cluster_items(shuffled)}
    assert a == b


def test_syndicated_copy_joining_independent_coverage_is_marked_not_dropped():
    copy_of_a = dict(QUAKE[0], id="quake-a-copy", source_id="wire_x",
                     url="https://wire_x.example/quake-a-copy")
    clusters = cluster_items(FIXTURE + [copy_of_a])
    quake = next(c for c in clusters if "quake-a" in c["article_ids"])
    assert set(quake["article_ids"]) == {"quake-a", "quake-a-copy", "quake-b", "quake-c"}
    assert quake["near_duplicates"] == [["quake-a", "quake-a-copy"]]
    assert quake["method"] == "minhash+cosine_entity"


def test_similar_wording_outside_the_time_window_does_not_merge():
    late = dict(QUAKE[1], id="quake-late", published_at="2026-09-27T09:00:00Z")
    clusters = cluster_items(QUAKE[:1] + [late])
    assert clusters == []


# Pool level: the same fixture through the fanout, as RSS.

# S08: outlet_a and outlet_b share a lean bucket, outlet_c does not, so the quake
# cluster is the "three-outlet cluster spanning two lean buckets" proof fixture.
# wire_x and wire_y share one syndication_group (both carry the same AP-style wire
# story), so the wire cluster is the "two outlets, one independent source" proof.
SOURCE_META = {
    "outlet_a": {"lean": "center-left", "syndication_group": "outlet_a"},
    "outlet_b": {"lean": "center-left", "syndication_group": "outlet_b"},
    "outlet_c": {"lean": "center", "syndication_group": "outlet_c"},
    "wire_x": {"lean": "center", "syndication_group": "ap_wire"},
    "wire_y": {"lean": "center", "syndication_group": "ap_wire"},
}


def _source(sid):
    meta = SOURCE_META.get(sid, {"lean": "center", "syndication_group": sid})
    return {
        "id": sid, "name": sid, "feed_url": f"https://{sid}.example/feed", "bucket": "general",
        "lean": meta["lean"], "lean_basis": "test fixture, not a real rating",
        "syndication_group": meta["syndication_group"],
    }


def _rss(items):
    body = "".join(
        f"<item><title>{i['title']}</title><link>{i['url']}</link>"
        f"<description>{i['dek']}</description>"
        f"<pubDate>{datetime.strptime(i['published_at'], '%Y-%m-%dT%H:%M:%SZ').strftime('%a, %d %b %Y %H:%M:%S')} GMT</pubDate></item>"
        for i in items
    )
    return f'<rss version="2.0"><channel>{body}</channel></rss>'.encode("utf-8")


def _pool(extra_by_source=None, cap=5):
    by_source = {}
    for it in FIXTURE:
        by_source.setdefault(it["source_id"], []).append(it)
    for sid, its in (extra_by_source or {}).items():
        by_source.setdefault(sid, []).extend(its)
    sources = [_source(sid) for sid in by_source]
    results = {sid: (_rss(its), None) for sid, its in by_source.items()}
    return build_pool_fanout(sources, results, NOW, per_source_cap=cap)


def test_pool_carries_clusters_valid_under_both_validators():
    pool = _pool()
    assert validate(pool) == []
    JS.validate(pool)
    by_url = {a["id"]: a["url"] for a in pool["articles"]}
    got = {frozenset(by_url[i].rsplit("/", 1)[1] for i in c["article_ids"]): c["method"]
           for c in pool["clusters"]}
    assert got == {
        frozenset({"quake-a", "quake-b", "quake-c"}): "cosine_entity",
        frozenset({"wire-x", "wire-y"}): "minhash",
    }
    for c in pool["clusters"]:
        assert c["id"].startswith("c_")


def test_independent_sources_counts_syndication_groups_not_source_ids():
    # S08 proof: wire-x and wire-y are two different outlets (wire_x, wire_y) carrying
    # the same wire story, sharing one syndication_group ("ap_wire"), so the pair counts
    # as one independent source, not two. Fixes the S07 deferral.
    pool = _pool()
    by_url = {a["id"]: a["url"].rsplit("/", 1)[1] for a in pool["articles"]}
    wire = next(c for c in pool["clusters"]
                if {by_url[i] for i in c["article_ids"]} == {"wire-x", "wire-y"})
    assert wire["independent_sources"] == 1
    assert wire["lean_buckets"] == ["center"]


def test_three_outlet_cluster_spanning_two_lean_buckets_reports_both():
    # S08 proof: the quake cluster has three outlets (outlet_a, outlet_b, outlet_c),
    # each its own syndication group, but outlet_a and outlet_b share a lean bucket
    # while outlet_c does not, so the cluster spans exactly two lean buckets.
    pool = _pool()
    by_url = {a["id"]: a["url"].rsplit("/", 1)[1] for a in pool["articles"]}
    quake = next(c for c in pool["clusters"]
                 if {by_url[i] for i in c["article_ids"]} == {"quake-a", "quake-b", "quake-c"})
    assert quake["independent_sources"] == 3
    assert quake["lean_buckets"] == ["center", "center-left"]


def test_clustered_item_past_the_cap_still_publishes():
    # Push the quake story to the end of outlet_c's feed behind two unclustered items.
    items = [LONE[2], LONE[1]]  # marathon and reef, both unclustered
    reordered = [dict(i, source_id="outlet_c", url=i["url"].replace(i["source_id"], "outlet_c"))
                 for i in items]
    by_source = {"outlet_a": [QUAKE[0]], "outlet_b": [QUAKE[1]],
                 "outlet_c": reordered + [QUAKE[2]]}
    sources = [_source(s) for s in by_source]
    results = {s: (_rss(its), None) for s, its in by_source.items()}
    pool = build_pool_fanout(sources, results, NOW, per_source_cap=1, cluster_extra_cap=1)
    ids = {a["url"].rsplit("/", 1)[1] for a in pool["articles"]}
    assert "quake-c" in ids  # third in its feed, past cap 1, kept because it is in a story
    assert "lone-reef" not in ids  # second in its feed, past cap 1, unclustered
    assert pool["counts"]["drops"]["over_cap"] == 1
    assert len(pool["clusters"]) == 1 and len(pool["clusters"][0]["article_ids"]) == 3
    assert validate(pool) == []


def test_url_capped_in_one_feed_still_publishes_from_a_later_feed():
    # Same url in two feeds: capped out of the first, so the second copy publishes, and
    # nothing is counted twice. The pre-S07 behaviour, kept.
    reef, marathon = LONE[1], LONE[2]
    by_source = {"outlet_a": [reef, marathon], "outlet_b": [marathon]}
    sources = [_source(s) for s in by_source]
    results = {s: (_rss(its), None) for s, its in by_source.items()}
    pool = build_pool_fanout(sources, results, NOW, per_source_cap=1)
    published = {(a["source_id"], a["url"]) for a in pool["articles"]}
    assert published == {("outlet_a", reef["url"]), ("outlet_b", marathon["url"])}
    assert pool["counts"]["drops"] == {"over_cap": 1}
    assert validate(pool) == []


# Timing: synthetic items shaped like a live run.

CLUSTER_BUDGET_SECONDS = 8.0


def _synthetic(n, seed=24):
    rng = random.Random(seed)
    vocab = ["".join(rng.choice("bcdfghklmnprstvz") + rng.choice("aeiou") for _ in range(3))
             for _ in range(12000)]
    names = [w.capitalize() for w in vocab[:1500]]
    stories = [(rng.sample(vocab[1500:], 6), rng.sample(names, 2)) for _ in range(n // 4)]
    items = []
    for k in range(n):
        core, ents = stories[rng.randrange(len(stories))]
        title_words = rng.sample(core, 4) + rng.sample(vocab, 4)
        dek_words = rng.sample(core, 3) + rng.sample(vocab, 25)
        title = f"{ents[0]} " + " ".join(title_words) + f" {ents[1]}"
        dek = f"The {ents[0]} " + " ".join(dek_words) + "."
        items.append({"id": f"s{k}", "source_id": f"src{k % 60}", "title": title, "dek": dek,
                      "published_at": f"2026-09-2{rng.randrange(2, 4)}T{rng.randrange(24):02d}:00:00Z"})
    for k in range(0, n // 10):  # 10% syndicated copies
        src = items[k]
        items[n - 1 - k] = dict(src, id=f"s{n - 1 - k}", source_id=f"src{(k + 7) % 60}")
    return items


def test_clustering_4000_items_finishes_under_budget():
    items = _synthetic(4000)
    t0 = time.perf_counter()
    clusters = cluster_items(items)
    elapsed = time.perf_counter() - t0
    print(f"\ncluster_items(4000 synthetic): {elapsed:.2f}s, {len(clusters)} clusters")
    assert elapsed < CLUSTER_BUDGET_SECONDS
    ids = [i for c in clusters for i in c["article_ids"]]
    assert len(ids) == len(set(ids))
    assert any(c["near_duplicates"] for c in clusters)


# Contract: the cluster shape is closed and cross-checked.

def _valid_pool():
    pool = _pool()
    assert pool["clusters"]
    return pool


def _both_reject(pool):
    assert validate(pool), "stdlib validator accepted a bad pool"
    return pool


def test_unknown_method_rejected_by_both():
    pool = _valid_pool()
    pool["clusters"][0]["method"] = "vendor_import"
    assert not JS.is_valid(pool)
    _both_reject(pool)


def test_unknown_cluster_field_rejected_by_both():
    pool = _valid_pool()
    pool["clusters"][0]["score"] = 3
    assert not JS.is_valid(pool)
    _both_reject(pool)


def test_single_article_cluster_rejected_by_both():
    pool = _valid_pool()
    pool["clusters"][0]["article_ids"] = pool["clusters"][0]["article_ids"][:1]
    pool["clusters"][0]["near_duplicates"] = []
    assert not JS.is_valid(pool)
    _both_reject(pool)


def test_article_in_two_clusters_rejected():
    pool = _valid_pool()
    a, b = pool["clusters"][0], pool["clusters"][1]
    b["article_ids"] = b["article_ids"] + [a["article_ids"][0]]
    _both_reject(pool)


def test_near_duplicate_outside_its_cluster_rejected():
    pool = _valid_pool()
    wire = next(c for c in pool["clusters"] if c["near_duplicates"])
    other = next(c for c in pool["clusters"] if c is not wire)
    broken = copy.deepcopy(pool)
    target = next(c for c in broken["clusters"] if c["id"] == wire["id"])
    target["near_duplicates"] = [[wire["article_ids"][0], other["article_ids"][0]]]
    _both_reject(broken)


def test_method_that_contradicts_the_shape_rejected():
    pool = _valid_pool()
    wire = next(c for c in pool["clusters"] if c["near_duplicates"])
    wire["method"] = "cosine_entity"  # a pure near-duplicate group is minhash
    _both_reject(pool)
