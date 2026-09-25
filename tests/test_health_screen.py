"""S17 proof: the Health screen off the You tab. Every source in the pool appears
exactly once, unhealthy sources sort first (then failing, then the rest grouped by
bucket), the stale marker follows the threshold, and every rendered string is text
only (R26), same discipline as tests/test_render.py."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.csp import scan
from app.health import (
    STALE_THRESHOLD_SECONDS, feed_rows, is_stale, ledger_sections, pool_age_seconds,
    render, sorted_feed_rows, watch_line,
)

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = json.loads((ROOT / "tests/fixtures/golden_pool.json").read_text(encoding="utf-8"))
NOW = datetime(2026, 9, 24, 8, 0, 0, tzinfo=timezone.utc)


def _health(state="ok", unhealthy=False, consecutive_empty=0, consecutive_error=0,
            last_ok_at="2026-09-24T07:30:00Z", last_item_at="2026-09-24T07:00:00Z", items_fetched=5):
    return {
        "state": state, "last_ok_at": last_ok_at, "last_item_at": last_item_at,
        "consecutive_empty": consecutive_empty, "consecutive_error": consecutive_error,
        "items_fetched": items_fetched, "unhealthy": unhealthy,
    }


def _source(id_, name, bucket="general"):
    return {"id": id_, "name": name, "feed_url": f"https://{id_}.example/feed.xml"}, {
        "id": id_, "name": name, "feed_url": f"https://{id_}.example/feed.xml",
        "bucket": bucket, "lean": "center", "syndication_group": id_,
    }


def _fixture_pool():
    """8 sources: two unhealthy, one failing this run but not yet unhealthy, one with
    no health entry at all (predates S06), the rest healthy across two buckets, so
    ordering, bucket grouping and the "unknown" fallback are all exercised at once."""
    specs = [
        ("z_ok_general", "Z General Source", "general", _health()),
        ("a_ok_world", "A World Source", "world", _health()),
        ("b_unhealthy", "B Unhealthy Source", "general", _health(state="http_error", unhealthy=True, consecutive_error=4)),
        ("c_failing", "C Failing Source", "world", _health(state="timeout", consecutive_error=1)),
        ("d_unhealthy_empty", "D Unhealthy Empty", "world", _health(state="empty", unhealthy=True, consecutive_empty=6)),
        ("e_ok_general", "E General Source", "general", _health()),
        ("f_unknown", "F No Health Yet", "general", None),
        ("g_ok_world", "G World Source", "world", _health()),
    ]
    pool_sources, repo_sources = [], []
    source_health = {}
    for sid, name, bucket, health in specs:
        ps, rs = _source(sid, name, bucket)
        pool_sources.append(ps)
        repo_sources.append(rs)
        if health is not None:
            source_health[sid] = health
    pool = {
        "schema_version": 1, "generated_at": "2026-09-24T07:45:00Z",
        "sources": pool_sources, "articles": [], "clusters": [],
        "counts": {
            "fetched": 40, "published": 30,
            "drops": {"no_title": 2, "over_cap": 8},
            "leniency": {"title_markup": 3, "link_from_guid": 1},
            "feed_states": {"ok": 6, "empty": 1, "http_error": 1, "timeout": 0, "parse_error": 0},
            "images": {
                "found": {"media_content": 5, "media_thumbnail": 1, "enclosure": 0, "content_img": 0},
                "rejected": {"not_https": 2, "data_uri": 0, "tiny_pixel": 1, "repeated_placeholder": 0},
            },
        },
        "source_health": source_health,
    }
    sources_doc = {"schema_version": 1, "sources": repo_sources}
    return pool, sources_doc


def _write_sources(tmp_path, sources_doc):
    path = tmp_path / "sources.json"
    path.write_text(json.dumps(sources_doc), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Every source appears exactly once.
# ---------------------------------------------------------------------------

def test_every_source_in_the_pool_appears_exactly_once(tmp_path):
    pool, sources_doc = _fixture_pool()
    sources_path = _write_sources(tmp_path, sources_doc)
    rows = sorted_feed_rows(pool, sources_path)
    ids = [r["id"] for r in rows]
    expected = [s["id"] for s in pool["sources"]]
    assert sorted(ids) == sorted(expected)
    assert len(ids) == len(set(ids)) == len(expected)


def test_a_pool_with_no_source_health_block_still_lists_every_source_once():
    # Predates S06 (golden_pool.json): every source falls back to "unknown", none
    # unhealthy or failing, none crash the row builder.
    rows = feed_rows(GOLDEN)
    assert [r["id"] for r in rows] == [s["id"] for s in GOLDEN["sources"]]
    assert all(r["state"] == "unknown" and not r["unhealthy"] and not r["failing"] for r in rows)


# ---------------------------------------------------------------------------
# Ordering: unhealthy first, then failing, then the rest grouped by bucket.
# ---------------------------------------------------------------------------

def test_unhealthy_sources_sort_first_then_failing_then_the_rest_by_bucket(tmp_path):
    pool, sources_doc = _fixture_pool()
    sources_path = _write_sources(tmp_path, sources_doc)
    rows = sorted_feed_rows(pool, sources_path)
    ids = [r["id"] for r in rows]

    unhealthy_ids = {"b_unhealthy", "d_unhealthy_empty"}
    failing_ids = {"c_failing"}
    rest_ids = {"z_ok_general", "a_ok_world", "e_ok_general", "f_unknown", "g_ok_world"}

    assert set(ids[:2]) == unhealthy_ids
    assert set(ids[2:3]) == failing_ids
    assert set(ids[3:]) == rest_ids

    # The rest is grouped by bucket (general before world, alphabetic), name breaking ties.
    rest_rows = rows[3:]
    assert [r["bucket"] for r in rest_rows] == sorted(r["bucket"] for r in rest_rows)
    general = [r["name"] for r in rest_rows if r["bucket"] == "general"]
    assert general == sorted(general)


def test_ordering_is_deterministic_regardless_of_input_order(tmp_path):
    pool, sources_doc = _fixture_pool()
    sources_path = _write_sources(tmp_path, sources_doc)
    forward = [r["id"] for r in sorted_feed_rows(pool, sources_path)]
    reversed_pool = dict(pool, sources=list(reversed(pool["sources"])))
    backward = [r["id"] for r in sorted_feed_rows(reversed_pool, sources_path)]
    assert forward == backward


# ---------------------------------------------------------------------------
# Stale marker follows the threshold.
# ---------------------------------------------------------------------------

def test_pool_age_seconds_matches_generated_at_to_now():
    pool = {"generated_at": "2026-09-24T07:00:00Z"}
    assert pool_age_seconds(pool, NOW) == 3600.0


def test_stale_marker_is_false_exactly_at_the_threshold_and_true_just_past_it():
    threshold_now = NOW
    at_threshold = threshold_now - timedelta(seconds=STALE_THRESHOLD_SECONDS)
    pool_at = {"generated_at": at_threshold.isoformat().replace("+00:00", "Z")}
    assert is_stale(pool_at, threshold_now) is False

    just_past = threshold_now - timedelta(seconds=STALE_THRESHOLD_SECONDS + 1)
    pool_past = {"generated_at": just_past.isoformat().replace("+00:00", "Z")}
    assert is_stale(pool_past, threshold_now) is True


def test_stale_marker_false_well_within_the_threshold():
    pool = {"generated_at": "2026-09-24T07:00:00Z"}  # 1h before NOW
    assert is_stale(pool, NOW) is False


def test_unreadable_generated_at_is_never_stale():
    assert is_stale({"generated_at": "not a date"}, NOW) is False
    assert is_stale({}, NOW) is False


# ---------------------------------------------------------------------------
# Ledger: fixed keys zero-filled, open leniency keys as reported, optional blocks
# appear only when the pool actually carries them.
# ---------------------------------------------------------------------------

def test_ledger_drop_reasons_are_zero_filled_for_reasons_that_did_not_fire():
    pool, _ = _fixture_pool()
    sections = dict(ledger_sections(pool["counts"]))
    drops = dict(sections["Drops"])
    assert drops["No title"] == 2
    assert drops["Over the per-source cap"] == 8
    assert drops["Bad URL"] == 0 and drops["No date"] == 0 and drops["Duplicate URL"] == 0


def test_ledger_omits_feed_states_and_images_when_the_pool_predates_them():
    sections = dict(ledger_sections(GOLDEN["counts"]))
    assert "Feed outcomes" not in sections
    assert "Images found" not in sections and "Images rejected" not in sections


def test_ledger_includes_feed_states_and_images_when_present():
    pool, _ = _fixture_pool()
    sections = dict(ledger_sections(pool["counts"]))
    assert dict(sections["Feed outcomes"])["Ok"] == 6
    assert dict(sections["Images found"])["media:content"] == 5
    assert dict(sections["Images rejected"])["Not https"] == 2


# ---------------------------------------------------------------------------
# H4 item 7: W2's watch ledger, one quiet counts-only line.
# ---------------------------------------------------------------------------

def test_watch_line_is_empty_when_the_run_carried_no_watch_block():
    pool, _ = _fixture_pool()
    assert watch_line(pool["counts"]) == ""
    assert watch_line(None) == ""


def test_watch_line_reports_counts_only_never_the_query_text():
    pool, _ = _fixture_pool()
    pool["counts"]["watch"] = {
        "kv": "ok", "queries": 3, "query_drops": {},
        "fetched": 12, "candidates": 9, "drops": {},
        "merged": 2, "published": 5, "over_budget": 1, "bytes": 900, "budget_bytes": 2000,
        "errors": {"timeout": 1},
    }
    line = watch_line(pool["counts"])
    assert line == "Watch: 3 queries, 5 published, 1 over budget, 1 error."


def test_watch_line_singular_query_and_zero_bits_omitted():
    pool, _ = _fixture_pool()
    pool["counts"]["watch"] = {
        "kv": "ok", "queries": 1, "query_drops": {}, "fetched": 4, "candidates": 4,
        "drops": {}, "merged": 0, "published": 0, "over_budget": 0, "bytes": 0,
        "budget_bytes": 500, "errors": {},
    }
    assert watch_line(pool["counts"]) == "Watch: 1 query."


def test_watch_line_appears_on_the_rendered_health_screen(tmp_path):
    pool, sources_doc = _fixture_pool()
    pool["counts"]["watch"] = {
        "kv": "ok", "queries": 2, "query_drops": {"budget": 1}, "fetched": 6,
        "candidates": 5, "drops": {}, "merged": 1, "published": 3, "over_budget": 0,
        "bytes": 400, "budget_bytes": 2000, "errors": {},
    }
    sources_path = _write_sources(tmp_path, sources_doc)
    html = render(pool, sources_path=sources_path, now=NOW)
    assert "Watch: 2 queries, 3 published." in html
    assert "watch-counts" in html


def test_golden_pool_predates_watch_and_renders_with_no_watch_line():
    # Golden pool has no counts.watch at all: the line must simply not appear, never
    # a crash or a stray empty paragraph.
    html = render(GOLDEN, now=NOW)
    assert "watch-counts" not in html
    assert watch_line(GOLDEN["counts"]) == ""


# ---------------------------------------------------------------------------
# Text only (R26): a hostile source name can never become markup on the page.
# ---------------------------------------------------------------------------

def test_every_rendered_string_is_text_only(tmp_path):
    pool, sources_doc = _fixture_pool()
    pool["sources"][0]["name"] = '<script>alert(1)</script>&"quote"'
    sources_doc["sources"][0]["name"] = pool["sources"][0]["name"]
    sources_path = _write_sources(tmp_path, sources_doc)

    html = render(pool, sources_path=sources_path, now=NOW)
    styles, problems = scan(html)
    assert problems == []
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html


def test_render_works_offline_from_a_pool_with_no_source_health_at_all():
    # No network, no extra fetch: rendering is a pure function of the pool already on
    # disk, so the page is exactly as available offline as any other cached page.
    html = render(GOLDEN, now=NOW)
    styles, problems = scan(html)
    assert problems == []
    assert "Feed health" in html
