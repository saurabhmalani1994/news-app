"""U2: the source catalog the You page's picker reads, and its place in the precache."""
import json
from pathlib import Path

from app.build import main as build_main
from app.serviceworker import precache_files
from app.source_catalog import catalog, health_word

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "tests" / "fixtures" / "golden_pool.json"


def test_catalog_carries_every_pool_source_with_repo_facts_and_health():
    pool = {
        "generated_at": "2026-09-24T00:00:00Z",
        "sources": [{"id": "cna_asia", "name": "CNA Asia", "feed_url": "https://x"},
                    {"id": "npr", "name": "NPR", "feed_url": "https://y"},
                    {"id": "not_in_repo", "name": "Elsewhere", "feed_url": "https://z"}],
        "source_health": {"npr": {"state": "timeout", "unhealthy": True},
                          "cna_asia": {"state": "ok", "unhealthy": False}},
    }
    rows = {r["id"]: r for r in catalog(pool)["sources"]}
    assert set(rows) == {"cna_asia", "npr", "not_in_repo"}
    assert rows["cna_asia"] == {"id": "cna_asia", "name": "CNA Asia", "bucket": "asia", "lean": "state",
                                "health": "ok", "ownership": "state-owned", "country": "SG"}
    assert rows["npr"]["health"] == "down" and "ownership" not in rows["npr"]
    assert rows["not_in_repo"]["bucket"] == "" and rows["not_in_repo"]["health"] == "unknown"


def test_health_words():
    assert health_word(None) == "unknown"
    assert health_word({"state": "http_error", "unhealthy": False}) == "failing"
    assert health_word({"state": "empty", "unhealthy": False}) == "empty"


def test_build_writes_the_catalog_and_precaches_it(tmp_path):
    build_main(["--pool", str(GOLDEN), "--out", str(tmp_path)])
    data = json.loads((tmp_path / "source-catalog.json").read_text(encoding="utf-8"))
    pool = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert sorted(s["id"] for s in data["sources"]) == sorted(s["id"] for s in pool["sources"])
    assert "source-catalog.json" in precache_files(tmp_path)
