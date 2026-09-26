"""B2: the pairwise story stage (DESIGN-bundles section 2(a)). Known answers, no network."""
import json
import math
import os
import random
import subprocess
import sys
import time
from pathlib import Path

from fetcher.bundle_eval import load_fixture
from fetcher.cluster import (
    STORY_SPAN_HOURS,
    _amounts,
    _prep,
    _Stories,
    _strip_outlet,
    _words,
    cluster_items,
)

ROOT = Path(__file__).resolve().parents[1]
BUNDLES = ROOT / "tests/fixtures/bundles"
MISSED = json.loads((BUNDLES / "missed_pairs_2026-09-24.json").read_text(encoding="utf-8"))
H = 3600


def _item(id_, source, title, dek, hour):
    day, hour = divmod(hour, 24)
    return {"id": id_, "source_id": source, "title": title, "dek": dek,
            "published_at": f"2026-09-{23 + day:02d}T{hour:02d}:00:00Z"}


# Normalizers

def test_demonyms_fold_to_their_country():
    assert _words(_prep("Ethiopian army repels attacks"))[:2] == ["ethiopia", "army"]
    assert _words("Chinese CEOs skip the trip")[0] == _words("China's CEOs")[0] == "china"
    assert _words("American CEOs")[0] == _words(_prep("U.S. CEOs"))[0] == "us"
    assert _words("United Nations General Assembly opens") == ["unga", "open"]


def test_dotted_acronyms_join_and_thousands_make_one_number():
    assert _words(_prep("U.N. envoys walk out")) == ["un", "envoy", "walk"]
    assert _words(_prep("Jobless claims fall to 197,000")) == ["jobless", "claim", "fall", "197000"]
    assert _words("Week 12 of the 2026 season") == ["2026", "season"]  # under 3 digits: dropped


def test_money_is_one_token_however_it_is_written():
    for text in ("A $2.45 billion deal", "A US$2,450 million deal", "A $2.45bn deal"):
        assert _amounts(_prep(text))[0] == ["$2.45e+09"], text
    assert _amounts("3.1 million jobs")[0] == ["#3.1e+06"]


def test_outlet_suffix_is_stripped_and_a_lower_case_tail_kept():
    assert _strip_outlet("Judge lifts ban on CNN - The Indian Express") == "Judge lifts ban on CNN"
    assert _strip_outlet("Xi lands | BBC News") == "Xi lands"
    assert _strip_outlet("Markets - the week ahead") == "Markets - the week ahead"


# Pair score and average link

def _stories(times_h, sources):
    n = len(times_h)
    return _Stories([{"x": 1.0}] * n, [t * H for t in times_h], sources, [set()] * n, {})


def test_pair_score_decays_with_time_and_stops_at_the_span():
    st = _stories([0, 1, 24, STORY_SPAN_HOURS + 1], ["a", "b", "c", "d"])
    assert math.isclose(st.score(0, 1), math.exp(-1 / 24))
    assert math.isclose(st.score(0, 2), math.exp(-1))
    assert st.score(0, 3) == 0.0


def test_a_story_never_spans_more_than_36_hours():
    # Identical wording every 12 to 16 hours: each neighbor clears the bar, but the chain
    # from first to last is 40 h, so it must stop at two stories.
    st = _stories([0, 12, 24, 40], ["a", "b", "c", "d"])
    members = st.agglomerate({i: [i] for i in range(4)},
                             {i: set(range(4)) - {i} for i in range(4)}, 0.3, 0.3)
    spans = [max(m) - min(m) for m in ([st.times[i] for i in ms] for ms in members.values())]
    assert sorted(sorted(m) for m in members.values()) == [[0, 1], [2, 3]]
    assert max(spans) <= STORY_SPAN_HOURS * H


# The cross-outlet rule

LEE_ARRIVES = _item("y1", "yonhap", "Lee arrives in Mexico for summit with President Sheinbaum",
                    "MEXICO CITY (Yonhap) South Korean President Lee Jae Myung arrived in Mexico "
                    "City on Wednesday for a summit with President Claudia Sheinbaum.", 1)
LEE_LANDS = _item("k1", "korea_herald", "President Lee lands in Mexico City ahead of Sheinbaum summit",
                  "South Korean President Lee Jae Myung arrived in Mexico City for a summit with "
                  "Mexican President Claudia Sheinbaum, his office said.", 3)
LEE_POW = _item("y2", "yonhap", "Lee says Ukraine disclosed transfer of two North Korean soldiers",
                "MEXICO CITY (Yonhap) South Korean President Lee Jae Myung said Ukraine broke a "
                "non-disclosure pledge on the transfer of two captured North Korean soldiers.", 4)


def test_one_outlets_pieces_alone_are_never_a_story():
    same_copy = dict(LEE_ARRIVES, id="y1b")
    assert cluster_items([LEE_ARRIVES, same_copy, LEE_POW]) == []


def test_same_outlet_piece_joins_only_through_its_own_cross_outlet_link():
    # LEE_POW shares Yonhap's dateline and byline words with LEE_ARRIVES, but the story
    # link only counts cross-outlet pairs, and LEE_POW has little in common with LEE_LANDS.
    clusters = cluster_items([LEE_ARRIVES, LEE_LANDS, LEE_POW])
    assert [c["article_ids"] for c in clusters] == [["y1", "k1"]]
    assert clusters[0]["method"] == "cosine_entity"


# Determinism

def _fixture_clusters(path):
    return sorted(sorted(c["article_ids"]) for c in cluster_items(load_fixture(path)["articles"]))


def test_gold_fixture_clusters_the_same_in_any_input_order():
    path = BUNDLES / "gold_2026-09-24b.json"
    arts = load_fixture(path)["articles"]
    shuffled = arts[:]
    random.Random(24).shuffle(shuffled)
    assert sorted(sorted(c["article_ids"]) for c in cluster_items(shuffled)) == _fixture_clusters(path)


def test_gold_fixture_clusters_the_same_under_any_hash_seed():
    # Set iteration order changes with PYTHONHASHSEED; float sums must not follow it.
    code = ("import json, sys; from fetcher.bundle_eval import load_fixture; "
            "from fetcher.cluster import cluster_items; "
            "a = load_fixture(sys.argv[1])['articles']; "
            "print(json.dumps(sorted(sorted(c['article_ids']) for c in cluster_items(a))))")
    path = str(BUNDLES / "gold_2026-09-24.json")
    outs = set()
    for seed in ("1", "2"):
        env = dict(os.environ, PYTHONHASHSEED=seed)
        outs.add(subprocess.run([sys.executable, "-c", code, path], cwd=ROOT, env=env,
                                capture_output=True, text=True, check=True).stdout)
    assert len(outs) == 1


# Section 1's 21 missed pairs

def _joined(arts, vectors=None):
    of = {i: n for n, c in enumerate(cluster_items(arts, vectors=vectors)) for i in c["article_ids"]}
    return sum(1 for p in MISSED["pairs"] if p["ids"][0] in of and of[p["ids"][0]] == of.get(p["ids"][1]))


def test_missed_pairs_hold_their_floor():
    # B7: the current clusterer has the embedding term (the committed fixture vectors);
    # the lexical fallback keeps B2's floor.
    from fetcher.bundle_eval import load_fixture_vectors
    arts = load_fixture(BUNDLES / MISSED["fixture"])["articles"]
    assert len(MISSED["pairs"]) == 21
    joined = _joined(arts, load_fixture_vectors(BUNDLES))
    assert joined >= MISSED["floor_joined"], f"{joined} of 21 joined"
    lexical = _joined(arts)
    assert lexical >= MISSED["floor_joined_lexical"], f"lexical: {lexical} of 21 joined"


# Timing: the design's benchmark, 10,000 synthetic items under 15 s on the runner
# (T2: test_cluster.best_time, wall clock there and CPU time on a loaded dev machine).

def test_clustering_10000_items_finishes_under_budget(capsys):
    from test_cluster import _synthetic, best_time, timing_budget
    items = _synthetic(10_000)
    best, clusters, clock = best_time(lambda: cluster_items(items))
    with capsys.disabled():
        print(f"\nB2 benchmark: cluster_items(10000 synthetic) {best:.2f}s {clock}, {len(clusters)} clusters")
    assert best < timing_budget()
    ids = [i for c in clusters for i in c["article_ids"]]
    assert len(ids) == len(set(ids))
