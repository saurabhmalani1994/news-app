"""B1: the bundle gold set, its scorer, the CI floor and the pre-cap candidate dump.

Scorer tests use tiny hand-made cases whose answers are worked out in the comments. The
floor tests run the current S07 clusterer on every gold fixture. No network.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from contract.validate import validate
from fetcher import fanout
from fetcher.bundle_eval import (
    METRICS,
    FixtureError,
    check_floors,
    floors_from,
    load_fixture_vectors,
    load_fixture,
    run_s07,
    sample_candidates,
    score,
    split_stories,
    spot_check_sample,
    stored_clusters,
    validate_fixture,
)
from fetcher.fanout import build_pool_fanout

ROOT = Path(__file__).resolve().parents[1]
BUNDLES = ROOT / "tests/fixtures/bundles"
FIXTURE_1 = BUNDLES / "gold_2026-09-24.json"
FIXTURE_2 = BUNDLES / "gold_2026-09-24b.json"
FLOORS = json.loads((BUNDLES / "floors.json").read_text(encoding="utf-8"))
GOLD = sorted(BUNDLES.glob("gold_*.json"))
VECTORS = load_fixture_vectors(BUNDLES)  # B7: the fixtures' committed embedding vectors


def _a(id_, source, story, event=None, hour=10):
    return {"id": id_, "source_id": source, "published_at": f"2026-09-24T{hour:02d}:00:00Z",
            "title": f"title {id_}", "dek": "", "s07_cluster": None, "story": story,
            "event": event or f"ev-{story}"}


# Story S: a1 (outlet x), a2 (y), a3 (z). Story T: b1 (x), b2 (y).
TINY = [_a("a1", "x", "S"), _a("a2", "y", "S"), _a("a3", "z", "S"),
        _a("b1", "x", "T"), _a("b2", "y", "T")]


# Scorer: tiny cases with known answers

def test_perfect_clustering_scores_one_everywhere():
    m = score(TINY, [["a1", "a2", "a3"], ["b1", "b2"]])
    assert all(m[k] == 1.0 for k in METRICS)
    assert (m["gold_pairs"], m["true_pairs"], m["missed_pairs"]) == (4, 4, 0)


def test_mixed_cluster_known_answers():
    # One predicted cluster {a1, a2, b1}; a3 and b2 stand alone.
    # Cross-outlet predicted pairs: a1-a2 (right), a2-b1 (wrong); a1-b1 is one outlet, not
    # counted. Gold cross-outlet pairs: a1-a2, a1-a3, a2-a3, b1-b2 = 4.
    m = score(TINY, [["a1", "a2", "b1"]])
    assert m["pair_precision"] == pytest.approx(1 / 2)
    assert m["pair_recall"] == pytest.approx(1 / 4)
    assert m["purity"] == 0.0 and m["clusters"] == 1
    # B-cubed per article (precision, recall): a1 and a2 (2/3, 2/3), b1 (1/3, 1/2),
    # a3 (1, 1/3), b2 (1, 1/2). Means: P = 11/15, R = 8/15, F1 = 176/285.
    assert m["bcubed_precision"] == pytest.approx(11 / 15)
    assert m["bcubed_recall"] == pytest.approx(8 / 15)
    assert m["bcubed_f1"] == pytest.approx(176 / 285)


def test_purity_counts_clusters_that_are_one_story():
    m = score(TINY, [["a1", "a2"], ["a3", "b1"], ["b2"]])  # a one-article list is no cluster
    assert (m["pure_clusters"], m["clusters"]) == (1, 2)
    assert m["purity"] == pytest.approx(0.5)


def test_same_outlet_pairs_never_count_as_pairs():
    arts = [_a("p", "x", "S"), _a("q", "x", "S")]
    together, apart = score(arts, [["p", "q"]]), score(arts, [])
    assert together["predicted_pairs"] == together["gold_pairs"] == 0
    assert together["pair_precision"] == together["pair_recall"] == 1.0  # nothing to score
    # B-cubed still sees the difference: apart, each article recalls half its story.
    assert together["bcubed_recall"] == 1.0 and apart["bcubed_recall"] == pytest.approx(0.5)


def test_clustering_nothing_scores_zero_recall_not_a_free_pass():
    m = score(TINY, [])
    assert m["pair_recall"] == 0.0 and m["clusters"] == 0
    assert m["pair_precision"] == 1.0 and m["purity"] == 1.0  # empty denominators
    assert m["bcubed_precision"] == 1.0 and m["bcubed_recall"] == pytest.approx(
        (1 / 3 + 1 / 3 + 1 / 3 + 1 / 2 + 1 / 2) / 5)


def test_bad_clusterings_are_refused():
    with pytest.raises(ValueError):
        score(TINY, [["a1", "zz"]])  # unknown article
    with pytest.raises(ValueError):
        score(TINY, [["a1", "a2"], ["a2", "a3"]])  # one article in two clusters


def test_floors_round_down_and_bite():
    m = score(TINY, [["a1", "a2", "b1"]])
    floors = floors_from(m)
    assert check_floors(m, floors) == []
    assert floors["bcubed_precision"] == 0.7333  # 11/15 rounded down, never up
    worse = score(TINY, [["a2", "b1"]])  # outlets y and x, two stories
    assert {name for name, _, _ in check_floors(worse, floors)} >= {"pair_precision", "pair_recall"}


def test_split_stories_names_articles_outside_the_main_cluster():
    split = split_stories(TINY, [["a1", "a2", "b1"]])
    # S: a1, a2 in the main cluster, a3 alone. T: b1 and b2 are one each; the tie keeps one.
    assert ("S", ["a3"], 1) in split
    assert len(split) == 2


# Fixture shape and the labeling rule

def test_validate_fixture_enforces_the_labeling_rule():
    ok = {"articles": [dict(a) for a in TINY]}
    validate_fixture(ok)
    late = {"articles": [dict(a) for a in TINY]}
    late["articles"][2]["published_at"] = "2026-09-26T11:00:00Z"  # 49 h after a1
    with pytest.raises(FixtureError, match="spans more than 48 h"):
        validate_fixture(late)
    split_event = {"articles": [dict(a) for a in TINY]}
    split_event["articles"][1]["event"] = "ev-other"
    with pytest.raises(FixtureError, match="two events"):
        validate_fixture(split_event)
    body = {"articles": [dict(TINY[0], body="full text")] + [dict(a) for a in TINY[1:]]}
    with pytest.raises(FixtureError, match="outside the fixture shape"):
        validate_fixture(body)
    unlabeled = {"articles": [dict(TINY[0], story="")] + [dict(a) for a in TINY[1:]]}
    with pytest.raises(FixtureError, match="no story"):
        validate_fixture(unlabeled)


@pytest.mark.parametrize("path", GOLD, ids=[p.name for p in GOLD])
def test_every_gold_fixture_is_valid_small_and_has_floors(path):
    fx = load_fixture(path)
    assert path.name in FLOORS, "a new gold fixture lands with its floors (README step 7)"
    assert set(FLOORS[path.name]) == set(METRICS)
    assert all(len(a.get("dek", "")) <= fanout.DUMP_DEK_CHARS for a in fx["articles"])
    assert path.stat().st_size < 400_000


def test_fixture_1_is_the_whole_published_pool_section_1_judged():
    fx = load_fixture(FIXTURE_1)
    arts = fx["articles"]
    assert fx["pool_generated_at"] == "2026-09-24T14:33:56Z"
    assert len(arts) == 415
    assert len(stored_clusters(arts)) == 50
    assert len({a["story"] for a in arts}) == 322  # 321 before R47 split the Xi summit story
    assert len({a["event"] for a in arts}) == 260


def test_spot_check_list_is_ten_percent_and_replays_from_its_seed():
    fx = load_fixture(FIXTURE_1)
    spot = fx["spot_check"]
    assert spot["ids"] == spot_check_sample(fx["articles"], spot["seed"])
    assert len(spot["ids"]) == 42  # 10% of 415
    size = {}
    for a in fx["articles"]:
        size[a["story"]] = size.get(a["story"], 0) + 1
    story = {a["id"]: a["story"] for a in fx["articles"]}
    grouped = sum(1 for i in spot["ids"] if size[story[i]] > 1)
    assert grouped == 21  # half checks a grouping call, half a stand-alone call


def test_fixture_2_is_a_pre_cap_dump_sampled_by_section_2():
    # B1b: 7 largest candidate groups (the 20 largest held 241 articles, README step 4)
    # plus 50 seeded singletons, then other versions of sampled stories from the dump.
    fx = load_fixture(FIXTURE_2)
    arts, sample = fx["articles"], fx["sample"]
    assert fx["pool_generated_at"] == "2026-09-24T23:12:25Z"
    assert fx["s07_cluster_scope"].startswith("pre-cap candidate groups")
    assert (sample["seed"], sample["largest_groups"], sample["singletons"]) == (20260924, 7, 50)
    added = set(sample["added_ids"])
    sampled = [a for a in arts if a["id"] not in added]
    assert (len(arts), len(sampled), len(added)) == (250, 200, 50)
    grouped = [a for a in sampled if a["s07_cluster"]]
    assert len(grouped) == 150 and len({a["s07_cluster"] for a in grouped}) == 7
    stories = {}
    for a in arts:
        stories.setdefault(a["story"], []).append(a)
    assert len(stories) == 84 and len({a["event"] for a in arts}) == 62
    assert sum(1 for m in stories.values() if len({a["source_id"] for a in m}) > 1) == 17
    # README step 5 adds only other versions of stories the sample already holds.
    sampled_stories = {a["story"] for a in sampled}
    assert {a["story"] for a in arts if a["id"] in added} <= sampled_stories


@pytest.mark.parametrize("path", GOLD, ids=[p.name for p in GOLD])
def test_every_spot_check_list_is_ten_percent_and_replays_from_its_seed(path):
    fx = load_fixture(path)
    spot = fx["spot_check"]
    assert spot["ids"] == spot_check_sample(fx["articles"], spot["seed"])
    assert len(spot["ids"]) == round(len(fx["articles"]) * 0.10)


@pytest.mark.parametrize("path", GOLD, ids=[p.name for p in GOLD])
def test_labeling_notes_name_articles_in_their_fixture(path):
    fx = load_fixture(path)
    assert set(fx.get("notes", {})) <= {a["id"] for a in fx["articles"]}


# The measured baseline and the CI floor

def test_published_s07_clusters_land_within_2_points_of_section_1():
    # DESIGN-bundles section 1 judged these 50 clusters at 64% one-story (32). The labels
    # here give 31 of 50 (62%); among them the F-35 cluster is split by the 48 h rule
    # (HKFP's piece runs 55 h before Kyodo's).
    arts = load_fixture(FIXTURE_1)["articles"]
    m = score(arts, stored_clusters(arts))
    assert abs(m["purity"] - 0.64) <= 0.02 + 1e-9
    assert (m["pure_clusters"], m["clusters"]) == (31, 50)


@pytest.mark.parametrize("path", GOLD, ids=[p.name for p in GOLD])
def test_current_clusterer_holds_the_floor_on_every_gold_fixture(path):
    arts = load_fixture(path)["articles"]
    assert all(a["id"] in VECTORS for a in arts), "a gold fixture lands with its vectors (B7)"
    m = score(arts, run_s07(arts, VECTORS))
    failures = check_floors(m, FLOORS[path.name])
    assert failures == [], f"below the floor on {path.name}: {failures}"


@pytest.mark.parametrize("path", GOLD, ids=[p.name for p in GOLD])
def test_lexical_fallback_holds_b2s_floor_on_every_gold_fixture(path):
    # B7: with no vectors (no token, an API failure, the budget) the clusterer is B2.
    arts = load_fixture(path)["articles"]
    failures = check_floors(score(arts, run_s07(arts)), FLOORS["lexical"][path.name])
    assert failures == [], f"lexical run below B2's floor on {path.name}: {failures}"
    assert all(FLOORS[path.name][m] >= FLOORS["lexical"][path.name][m] for m in METRICS)


NENE = {"7d7eb22e04cd5744", "7f9f8f76a02304d8", "9224d7d82b1e1b8f"}  # BBC, CNA, Bangkok Post


def test_breaking_one_known_good_merge_fails_the_floor():
    arts = load_fixture(FIXTURE_1)["articles"]
    clusters = run_s07(arts)
    good = next(c for c in clusters if set(c) == NENE)  # today S07 joins all three outlets
    broken = [c for c in clusters if c is not good]  # the three now stand alone
    failed = {name for name, _, _ in check_floors(score(arts, broken), FLOORS[FIXTURE_1.name])}
    assert {"pair_recall", "purity", "bcubed_recall", "bcubed_f1"} <= failed


# Pre-cap candidate dump (fanout), never in pool.json

def _item(title, url, hour):
    return (f"<item><title>{title}</title><link>{url}</link><description>{title} dek</description>"
            f"<pubDate>Thu, 24 Sep 2026 {hour:02d}:00:00 GMT</pubDate></item>")


def _source(sid):
    return {"id": sid, "name": sid, "feed_url": f"https://{sid}.example/feed", "bucket": "general",
            "lean": "center", "lean_basis": "test fixture, not a real rating", "syndication_group": sid}


NOON = datetime(2026, 9, 24, 12, tzinfo=timezone.utc)
QUAKE_A = "Magnitude 7.1 earthquake strikes off Chile, tsunami warning issued for Valparaiso"
QUAKE_B = "Chile earthquake: Valparaiso residents evacuate after tsunami warning for Chile"


def _feeds():
    a = [_item(QUAKE_A, "https://a.example/quake", 8)] + [
        _item(f"Unrelated local story number {k} about gardens {k}", f"https://a.example/{k}", 9)
        for k in range(3)]
    b = [_item(QUAKE_B, "https://b.example/quake", 9)]
    rss = lambda items: f'<rss version="2.0"><channel>{"".join(items)}</channel></rss>'.encode()
    return [_source("a"), _source("b")], {"a": (rss(a), None), "b": (rss(b), None)}


def test_candidate_dump_holds_every_pre_cap_item_and_the_pool_does_not():
    sources, results = _feeds()
    out = {}
    pool = build_pool_fanout(sources, results, NOON,
                             per_source_cap=1, cluster_extra_cap=0, candidates_out=out)
    dump = out["dump"]
    cands = {c["url"]: c for c in dump["candidates"]}
    assert len(cands) == 5 and dump["counts"]["candidates"] == 5
    assert len(pool["articles"]) == 2  # cap 1 per source
    assert sum(c["published"] for c in cands.values()) == 2
    assert cands["https://a.example/quake"]["s07_cluster"] == cands["https://b.example/quake"]["s07_cluster"]
    assert cands["https://a.example/0"]["s07_cluster"] is None
    assert set(cands["https://a.example/0"]) == {
        "id", "source_id", "url", "title", "dek", "published_at", "s07_cluster", "published"}
    assert "candidates" not in json.dumps(pool) and validate(pool) == []
    # The dump feeds the README's sampler directly.
    draft = sample_candidates(dump, seed=1, groups=1, singletons=2)
    assert len(draft) == 4 and all(a["story"] == "" for a in draft)


def test_no_dump_unless_asked():
    sources, results = _feeds()
    pool = build_pool_fanout(sources, results, NOON)
    assert "candidates" not in pool and "dump" not in pool


def _offline(monkeypatch, tmp_path):
    sources, results = _feeds()
    feeds = {s["feed_url"]: results[s["id"]][0] for s in sources}
    monkeypatch.setattr(fanout, "fetch_feed", lambda url, timeout=None: feeds[url])
    monkeypatch.delenv("DUMP_CANDIDATES_PATH", raising=False)
    src = tmp_path / "sources.json"
    src.write_text(json.dumps({"schema_version": 1, "sources": sources}), encoding="utf-8")
    return ["--sources", str(src), "--timeout", "1", "--previous-pool-url", "",
            "--state-path", str(tmp_path / "state.json")]


def test_main_writes_the_dump_beside_not_inside_the_deployed_dir(monkeypatch, tmp_path):
    args = _offline(monkeypatch, tmp_path)
    dist, dump = tmp_path / "dist", tmp_path / "candidates" / "candidates.json"
    assert fanout.main(args + ["--out", str(dist / "pool.json"), "--per-source-cap", "1",
                               "--dump-candidates", str(dump)]) == 0
    assert len(json.loads(dump.read_text(encoding="utf-8"))["candidates"]) == 5
    assert not list(dist.rglob("*candidates*"))
    assert "candidates" not in json.loads((dist / "pool.json").read_text(encoding="utf-8"))


def test_main_refuses_a_dump_inside_the_deployed_dir(monkeypatch, tmp_path):
    args = _offline(monkeypatch, tmp_path)
    dist = tmp_path / "dist"
    assert fanout.main(args + ["--out", str(dist / "pool.json"),
                               "--dump-candidates", str(dist / "c.json")]) == 1
    assert not (dist / "c.json").exists() and not (dist / "pool.json").exists()


def test_main_without_the_flag_writes_no_dump(monkeypatch, tmp_path):
    args = _offline(monkeypatch, tmp_path)
    assert fanout.main(args + ["--out", str(tmp_path / "dist" / "pool.json")]) == 0
    assert sorted(p.name for p in tmp_path.iterdir()) == ["dist", "sources.json", "state.json"]


# publish.yml: the dump is a dispatch-only artifact, never on the schedule or a push

def test_publish_uploads_the_dump_only_on_a_dispatch_that_asks():
    wf = (ROOT / ".github/workflows/publish.yml").read_text(encoding="utf-8")
    on = wf.split("\npermissions:")[0]
    assert re.search(r"workflow_dispatch:\n\s+inputs:\n\s+dump_candidates:\n", on)
    assert re.search(r"dump_candidates:[\s\S]*?type: boolean[\s\S]*?default: false", on)
    assert on.count("cron:") == 1  # the hourly schedule is unchanged, nothing added
    gate = "github.event_name == 'workflow_dispatch' && inputs.dump_candidates"
    upload = wf.split("uses: actions/upload-artifact@v4")
    assert len(upload) == 2, "exactly one upload step"
    step = upload[0].rsplit("- name:", 1)[1] + upload[1].split("- name:", 1)[0]
    assert f"if: ${{{{ !cancelled() && {gate} }}}}" in step
    # A refused upload (storage quota) must never block publishing: it is the last step
    # and it may fail without failing the run.
    assert "continue-on-error: true" in step
    assert "- name:" not in upload[1] and "pages deploy" in upload[0]
    assert "retention-days: 7" in step
    assert "path: candidates/candidates.json" in step
    assert f"DUMP_CANDIDATES_PATH: ${{{{ ({gate}) && 'candidates/candidates.json' || '' }}}}" in wf
    assert "dist/" not in step


# The labeler's command line, end to end on a small dump

def test_cli_sample_label_draw_and_score_round_trip(tmp_path, capsys):
    from fetcher import bundle_eval

    sources, results = _feeds()
    out = {}
    build_pool_fanout(sources, results, NOON, candidates_out=out)
    dump = tmp_path / "candidates.json"
    dump.write_text(json.dumps(out["dump"]), encoding="utf-8")
    draft = tmp_path / "gold_2026-10-01.json"
    assert bundle_eval.main(["sample", str(dump), "--out", str(draft), "--seed", "7",
                             "--groups", "1", "--singletons", "2"]) == 0
    fx = json.loads(draft.read_text(encoding="utf-8"))
    for a in fx["articles"]:  # the labeler's step: quake versions together, the rest alone
        a["story"] = "st-quake" if a["s07_cluster"] else f"st-solo-{a['id'][:8]}"
        a["event"] = a["story"].replace("st-", "ev-", 1)
    bundle_eval.save_fixture(fx, draft)
    assert bundle_eval.main(["spotcheck", str(draft), "--draw", "7"]) == 0
    assert load_fixture(draft)["spot_check"]["ids"]
    assert bundle_eval.main(["score", str(draft)]) == 0
    assert "S07 re-run on fixture: pair_precision=1.0000 pair_recall=1.0000" in capsys.readouterr().out
