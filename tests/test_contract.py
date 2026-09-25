"""The contract: golden pool valid under both validators; any break fails both."""
import copy
import json
import subprocess
import sys
from pathlib import Path

import jsonschema
import pytest

from contract.validate import SchemaError, load_schema, validate

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = json.loads((ROOT / "tests/fixtures/golden_pool.json").read_text(encoding="utf-8"))
SCHEMA = load_schema()
JS = jsonschema.Draft202012Validator(SCHEMA)


def _required_paths():
    defs = SCHEMA["$defs"]
    paths = [((), k) for k in SCHEMA["required"]]
    paths += [(("articles", 0), k) for k in defs["article"]["required"]]
    paths += [(("sources", 0), k) for k in defs["source"]["required"]]
    paths += [(("counts",), k) for k in defs["counts"]["required"]]
    return paths


def _at(pool, path):
    node = pool
    for p in path:
        node = node[p]
    return node


def test_schema_is_valid_draft_2020_12():
    jsonschema.Draft202012Validator.check_schema(SCHEMA)


def test_golden_is_five_articles():
    assert len(GOLDEN["articles"]) == 5


def test_golden_valid_under_jsonschema():
    JS.validate(GOLDEN)


def test_golden_valid_under_stdlib_validator():
    assert validate(GOLDEN) == []


@pytest.mark.parametrize("path,field", _required_paths(), ids=lambda v: str(v))
def test_missing_required_field_fails_both(path, field):
    broken = copy.deepcopy(GOLDEN)
    del _at(broken, path)[field]
    assert not JS.is_valid(broken)
    errors = validate(broken)
    assert any(repr(field) in e for e in errors), errors


@pytest.mark.parametrize("field", ["score", "rank", "affinity", "body"])
def test_opinion_and_body_fields_rejected(field):
    # The pool is opinion free, and bodies live outside it (R12).
    broken = copy.deepcopy(GOLDEN)
    broken["articles"][0][field] = 1
    assert not JS.is_valid(broken)
    assert validate(broken)


@pytest.mark.parametrize("mutate", [
    lambda p: p["articles"][0].update(title=""),
    lambda p: p["articles"][0].update(url="javascript:alert(1)"),
    lambda p: p["articles"][0].update(published_at="2026-09-23 23:19"),
    lambda p: p["articles"][0].update(id="../etc/passwd"),
    lambda p: p["counts"].update(fetched=True),
    lambda p: p.update(schema_version=2),
])
def test_bad_values_fail_both(mutate):
    broken = copy.deepcopy(GOLDEN)
    mutate(broken)
    assert not JS.is_valid(broken)
    assert validate(broken)


def test_integrity_unknown_source_rejected():
    broken = copy.deepcopy(GOLDEN)
    broken["articles"][0]["source_id"] = "nobody"
    assert validate(broken)


def test_unknown_drop_reason_key_rejected():
    # S02: drops has a fixed, closed set of reason keys.
    broken = copy.deepcopy(GOLDEN)
    broken["counts"]["drops"]["mystery_reason"] = 1
    assert not JS.is_valid(broken)
    assert validate(broken)


def test_fixed_drop_reason_keys_accepted():
    ok = copy.deepcopy(GOLDEN)
    ok["counts"]["drops"] = {
        "no_title": 1, "no_date": 1, "bad_url": 1, "duplicate_url": 1, "over_cap": 1,
    }
    ok["counts"]["fetched"] = ok["counts"]["published"] + 5
    assert JS.is_valid(ok)
    assert validate(ok) == []


def test_integrity_fetched_must_equal_published_plus_drops():
    broken = copy.deepcopy(GOLDEN)
    broken["counts"]["fetched"] = broken["counts"]["published"] + 99
    assert validate(broken)


def test_stdlib_validator_refuses_unsupported_keywords():
    schema = copy.deepcopy(SCHEMA)
    schema["$defs"]["article"]["properties"]["title"]["format"] = "uri"
    with pytest.raises(SchemaError):
        validate(GOLDEN, schema)


def _cli(pool, tmp_path):
    path = tmp_path / "pool.json"
    path.write_text(json.dumps(pool), encoding="utf-8")
    return subprocess.run([sys.executable, "-m", "contract.validate", str(path)],
                          cwd=ROOT, capture_output=True, text=True).returncode


def test_cli_gate_passes_golden(tmp_path):
    assert _cli(GOLDEN, tmp_path) == 0


def test_cli_gate_fails_broken_pool(tmp_path):
    # This is the command CI runs before deploy; exit 1 stops the workflow.
    broken = copy.deepcopy(GOLDEN)
    del broken["articles"][2]["title"]
    assert _cli(broken, tmp_path) == 1


# B3: bundle-contract additive fields (DESIGN-bundles.md sections 3, 4, 4a, 7).
# Nothing below writes these fields at runtime; that is B4, B8 and B9's job.
# The golden pool carries none of them, and test_golden_valid_under_jsonschema
# / test_golden_valid_under_stdlib_validator already prove a pool without the
# new fields still validates under both engines.


def _pool_with_cluster():
    """A copy of GOLDEN with one valid two-article cluster, so cluster-level
    bundle fields (story_countries, primary_source) have somewhere to live."""
    pool = copy.deepcopy(GOLDEN)
    a0, a1 = pool["articles"][0]["id"], pool["articles"][1]["id"]
    pool["clusters"] = [{
        "id": "cluster1",
        "method": "cosine_entity",
        "article_ids": [a0, a1],
        "near_duplicates": [],
        "independent_sources": 2,
        "lean_buckets": ["center-left"],
    }]
    return pool


def test_bundle_fields_accept_valid_values():
    # source: country, roster, paywall, exile_of; article: countries, locality,
    # bv; cluster: story_countries, primary_source. All at once, both engines.
    pool = _pool_with_cluster()
    pool["sources"][0].update(
        country="US", roster="core", paywall=False, exile_of="SD",
    )
    pool["articles"][0].update(
        countries=["US", "CN"],
        locality="local",
        bv=[20, 15, 10, 20, 15, 10, 0, 0],
    )
    pool["clusters"][0].update(
        story_countries=["US", "CN"],
        primary_source={"url": "https://trumpstruth.org/posts/12345"},
    )
    assert JS.is_valid(pool)
    assert validate(pool) == []


@pytest.mark.parametrize("bad_locality", ["regional", "Local", "LOCAL", "", "domestic"])
def test_locality_outside_enum_fails_both(bad_locality):
    pool = copy.deepcopy(GOLDEN)
    pool["articles"][0]["locality"] = bad_locality
    assert not JS.is_valid(pool)
    assert validate(pool)


@pytest.mark.parametrize("length", [0, 1, 7, 9, 12])
def test_bv_wrong_length_fails_both(length):
    pool = copy.deepcopy(GOLDEN)
    pool["articles"][0]["bv"] = [0] * length
    assert not JS.is_valid(pool)
    assert validate(pool)


def test_bv_right_length_accepted():
    pool = copy.deepcopy(GOLDEN)
    pool["articles"][0]["bv"] = [10, -5, 3, -10, 15, 10, -5, -15]
    assert JS.is_valid(pool)
    assert validate(pool) == []


@pytest.mark.parametrize("bad_url", [
    "http://trumpstruth.org/posts/12345",
    "trumpstruth.org/posts/12345",
    "ftp://trumpstruth.org/posts/12345",
])
def test_primary_source_non_https_fails_both(bad_url):
    pool = _pool_with_cluster()
    pool["clusters"][0]["primary_source"] = {"url": bad_url}
    assert not JS.is_valid(pool)
    assert validate(pool)


def test_primary_source_missing_url_fails_both():
    pool = _pool_with_cluster()
    pool["clusters"][0]["primary_source"] = {}
    assert not JS.is_valid(pool)
    assert validate(pool)


# B9: counts.primary_source, the archive lookup's own run ledger.

def _primary_source_counts(**over):
    counts = {"status": "ok", "posts": 12, "linked": 1}
    counts.update(over)
    return counts


def test_primary_source_counts_field_is_optional():
    assert "primary_source" not in GOLDEN["counts"]
    assert JS.is_valid(GOLDEN) and validate(GOLDEN) == []


def test_primary_source_counts_accepted_by_both():
    pool = copy.deepcopy(GOLDEN)
    pool["counts"]["primary_source"] = _primary_source_counts()
    assert JS.is_valid(pool)
    assert validate(pool) == []


@pytest.mark.parametrize("status", ["ok", "http_error", "timeout", "parse_error", "disabled"])
def test_primary_source_counts_statuses_accepted_by_both(status):
    pool = copy.deepcopy(GOLDEN)
    pool["counts"]["primary_source"] = _primary_source_counts(status=status)
    assert JS.is_valid(pool)
    assert validate(pool) == []


@pytest.mark.parametrize("mutate", [
    lambda c: c.update(status="down"),
    lambda c: c.update(posts=-1),
    lambda c: c.update(linked=-1),
    lambda c: c.update(extra="not a field"),
    lambda c: c.pop("posts"),
], ids=["bad-status", "negative-posts", "negative-linked", "extra-field", "missing-posts"])
def test_primary_source_counts_shape_enforced_by_both(mutate):
    pool = copy.deepcopy(GOLDEN)
    pool["counts"]["primary_source"] = _primary_source_counts()
    mutate(pool["counts"]["primary_source"])
    assert not JS.is_valid(pool)
    assert validate(pool)


@pytest.mark.parametrize("bad_code", ["us", "USA", "U", "sg", "hk ", "C1"])
def test_country_code_bad_shape_fails_both(bad_code):
    pool = copy.deepcopy(GOLDEN)
    pool["sources"][0]["country"] = bad_code
    assert not JS.is_valid(pool)
    assert validate(pool)


@pytest.mark.parametrize("field", ["country", "exile_of"])
def test_source_country_fields_accept_valid_code(field):
    pool = copy.deepcopy(GOLDEN)
    pool["sources"][0][field] = "HK"
    assert JS.is_valid(pool)
    assert validate(pool) == []


def test_roster_outside_enum_fails_both():
    pool = copy.deepcopy(GOLDEN)
    pool["sources"][0]["roster"] = "wire"
    assert not JS.is_valid(pool)
    assert validate(pool)


def test_story_countries_over_two_fails_both():
    pool = _pool_with_cluster()
    pool["clusters"][0]["story_countries"] = ["US", "CN", "SG"]
    assert not JS.is_valid(pool)
    assert validate(pool)


def test_story_countries_empty_fails_both():
    pool = _pool_with_cluster()
    pool["clusters"][0]["story_countries"] = []
    assert not JS.is_valid(pool)
    assert validate(pool)


def test_article_countries_accepts_more_than_two():
    # Unlike cluster.story_countries, one article's own raw extraction is not
    # capped at 2 (section 4): only the derived story_countries is.
    pool = copy.deepcopy(GOLDEN)
    pool["articles"][0]["countries"] = ["US", "CN", "SG", "HK"]
    assert JS.is_valid(pool)
    assert validate(pool) == []


# W2 (R50): the optional article `watch` field (hashed query tags) and counts.watch.

TAG_A, TAG_B = "w:0123456789", "w:abcdef0123"


def _watch_counts(**over):
    counts = {"kv": "ok", "queries": 2, "query_drops": {"bad_tag": 1}, "fetched": 5,
              "candidates": 3, "drops": {"stale": 1, "duplicate": 1}, "merged": 1,
              "published": 2, "over_budget": 0, "bytes": 900, "budget_bytes": 60000,
              "errors": {"http_503": 1}}
    counts.update(over)
    return counts


def test_watch_field_is_optional():
    assert not any("watch" in a for a in GOLDEN["articles"])
    assert "watch" not in GOLDEN["counts"]
    assert JS.is_valid(GOLDEN) and validate(GOLDEN) == []


def test_watch_tags_and_counts_accepted_by_both():
    pool = copy.deepcopy(GOLDEN)
    pool["articles"][0]["watch"] = [TAG_A, TAG_B]
    pool["articles"][1]["watch"] = [TAG_B]
    pool["counts"]["watch"] = _watch_counts()
    assert JS.is_valid(pool)
    assert validate(pool) == []


@pytest.mark.parametrize("bad", [
    ["w:ABCDEF0123"],       # upper-case hex
    ["w:012345678"],        # 9 hex
    ["w:0123456789a"],      # 11 hex
    ["x:0123456789"],       # wrong prefix
    ["w0123456789"],        # no colon
    [" w:0123456789"],      # leading space
    ["w:0123456789", "w:0123456789"],  # a tag twice
    [],                     # present but empty
    "w:0123456789",         # not an array
    [123],                  # not a string
], ids=repr)
def test_watch_pattern_enforced_by_both(bad):
    pool = copy.deepcopy(GOLDEN)
    pool["articles"][0]["watch"] = bad
    assert not JS.is_valid(pool)
    assert validate(pool)


@pytest.mark.parametrize("mutate", [
    lambda w: w.update(kv="maybe"),
    lambda w: w.update(kv="http_40"),
    lambda w: w["drops"].update(mystery=1),
    lambda w: w["query_drops"].update(mystery=1),
    lambda w: w.update(queries=-1),
    lambda w: w.update(q="not a field"),
    lambda w: w.pop("budget_bytes"),
], ids=["kv-word", "kv-code", "drop-key", "query-drop-key", "negative", "extra-field", "missing"])
def test_watch_counts_shape_enforced_by_both(mutate):
    pool = copy.deepcopy(GOLDEN)
    pool["counts"]["watch"] = _watch_counts()
    mutate(pool["counts"]["watch"])
    assert not JS.is_valid(pool)
    assert validate(pool)


@pytest.mark.parametrize("kv", ["ok", "no_token", "no_namespace", "http_403", "timeout", "error"])
def test_watch_kv_statuses_accepted_by_both(kv):
    pool = copy.deepcopy(GOLDEN)
    pool["counts"]["watch"] = _watch_counts(kv=kv)
    assert JS.is_valid(pool)
    assert validate(pool) == []


def test_watch_ledger_invariant_checked_by_the_stdlib_gate():
    pool = copy.deepcopy(GOLDEN)
    pool["counts"]["watch"] = _watch_counts(fetched=99)
    assert JS.is_valid(pool)  # a cross-count JSON Schema cannot express
    assert any("counts.watch" in e for e in validate(pool))


def test_cluster_with_no_listed_lean_accepted_by_both():
    # W2: a cluster made only of Google News source items claims no lean.
    pool = _pool_with_cluster()
    pool["clusters"][0]["lean_buckets"] = []
    assert JS.is_valid(pool)
    assert validate(pool) == []
