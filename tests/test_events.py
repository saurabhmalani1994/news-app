"""S31: the events field in pool.schema.json (R22). A closed shape: id, label,
cluster_ids, hype, eligible, live and hold_state, plus the cross-reference rules
JSON Schema cannot express (dangling cluster ids, a cluster in two events, live
without eligible), checked by contract.validate's stdlib engine."""
import copy
import json
from datetime import datetime, timezone
from pathlib import Path

import jsonschema
import pytest

from contract.validate import load_schema, validate
from fetcher.fanout import build_pool_fanout, fetch_all

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = json.loads((ROOT / "tests/fixtures/golden_pool_events.json").read_text(encoding="utf-8"))
SCHEMA = load_schema()
JS = jsonschema.Draft202012Validator(SCHEMA)

SAMPLE = (ROOT / "tests/fixtures/sample_feed.xml").read_bytes()
NOW = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)


def test_golden_events_fixture_has_two_events():
    assert len(GOLDEN["events"]) == 2


def test_golden_events_valid_under_jsonschema():
    JS.validate(GOLDEN)


def test_golden_events_valid_under_stdlib_validator():
    assert validate(GOLDEN) == []


def test_fanout_pool_events_field_is_empty_and_valid():
    # The fetcher's one-line change: it emits events: [] until S32 fills it in,
    # and that empty pool still clears both the schema and the cross-references.
    sources = [{"id": "npr", "name": "NPR", "feed_url": "https://npr.example/feed.xml"}]
    results = fetch_all(sources, fetch_fn=lambda url, timeout=None: SAMPLE, timeout=1, retries=1)
    pool = build_pool_fanout(sources, results, NOW)
    assert pool["events"] == []
    JS.validate(pool)
    assert validate(pool) == []


def _mutate_unknown_field(pool):
    pool["events"][0]["extra_field"] = "not in the contract"


def _mutate_dangling_cluster_id(pool):
    pool["events"][0]["cluster_ids"] = ["c-does-not-exist"]


def _mutate_cluster_in_two_events(pool):
    pool["events"][1]["cluster_ids"] = list(pool["events"][0]["cluster_ids"])


def _mutate_bad_hold_state(pool):
    pool["events"][0]["hold_state"] = "paused"


def _mutate_hype_out_of_range(pool):
    pool["events"][0]["hype"] = -1


def _mutate_live_without_eligible(pool):
    pool["events"][1]["live"] = True  # events[1] is eligible: false in the golden fixture


INVALID_VARIANTS = {
    "unknown_field": _mutate_unknown_field,
    "dangling_cluster_id": _mutate_dangling_cluster_id,
    "cluster_in_two_events": _mutate_cluster_in_two_events,
    "bad_hold_state": _mutate_bad_hold_state,
    "hype_out_of_range": _mutate_hype_out_of_range,
}


@pytest.mark.parametrize("name", sorted(INVALID_VARIANTS))
def test_invalid_event_variants_rejected(name):
    broken = copy.deepcopy(GOLDEN)
    INVALID_VARIANTS[name](broken)
    stdlib_errors = validate(broken)
    assert stdlib_errors, f"{name}: stdlib validator accepted an invalid pool"
    assert all(isinstance(e, str) and e for e in stdlib_errors)


@pytest.mark.parametrize("name", ["unknown_field", "bad_hold_state", "hype_out_of_range"])
def test_invalid_event_variants_schema_expressible_fail_jsonschema_too(name):
    # These three are pure shape violations (additionalProperties, enum, minimum),
    # so plain JSON Schema catches them without any cross-reference logic.
    broken = copy.deepcopy(GOLDEN)
    INVALID_VARIANTS[name](broken)
    assert not JS.is_valid(broken)


def test_live_without_eligible_rejected():
    broken = copy.deepcopy(GOLDEN)
    _mutate_live_without_eligible(broken)
    errors = validate(broken)
    assert errors
    assert any("live" in e and "eligible" in e for e in errors)
