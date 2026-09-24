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
