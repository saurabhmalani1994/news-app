"""B11: scripts/seed_work_watch.py with invented rules. It merges only the work rules into
the stored value (phrase queries kept), checks the result with the site's own function,
prints labels and counts but never a term, writes nothing on a dry run, and with
--write-file prints a put command that passes the value by file."""
import hashlib
import importlib.util
import json
import re
import shutil
from pathlib import Path

import pytest

import fetcher.watch as watch
import fetcher.workwatch as ww

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("seed_work_watch", ROOT / "scripts" / "seed_work_watch.py")
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="the site's check runs under Node")

RULES = [
    {"id": "w_one", "label": "First rule", "tier": 1, "terms": ["zorbium"], "pair_any": [], "exclude": [], "exact": False},
    {"id": "w_two", "label": "Second rule", "tier": 3, "terms": ["Quillase"], "pair_any": ["plant"], "exclude": ["brewquor"], "exact": True},
]
KEY = "a" * 64


def _files(tmp_path, current):
    rules = tmp_path / "rules.json"
    rules.write_text(json.dumps({"format_version": 3, "exported_at": "2026-09-27T00:00:00Z", "scope": "work_watch",
                                 "profile": {"work_watch": RULES}}), encoding="utf-8")
    cur = tmp_path / "current.json"
    cur.write_text(json.dumps(current) if current is not None else "", encoding="utf-8")
    return str(rules), str(cur)


def test_key_and_tags_match_the_site():
    assert seed.user_key("  Reader@Example.com ") == hashlib.sha256(b"reader@example.com").hexdigest()
    assert seed.work_tag("w_one") == ww.work_tag("w_one")


def test_dry_run_prints_labels_and_counts_only(tmp_path, capsys):
    phrase = {"q": '"harbor ferry"', "tag": watch.tag_for('"harbor ferry"')}
    rules, cur = _files(tmp_path, {"v": 1, "queries": [phrase]})
    assert seed.main([rules, "--key", KEY, "--namespace-id", "ns", "--current-file", cur]) == 0
    out = capsys.readouterr().out
    assert "1 queries kept" in out and "2 rules (tier 1: 1, 2: 0, 3: 1, 4: 0)" in out
    assert "First rule" in out and "dry run" in out and "kv key put" not in out
    for term in ("zorbium", "Quillase", "plant", "brewquor"):
        assert term not in out


def test_write_file_merges_only_the_rules_and_passes_the_value_by_path(tmp_path, capsys):
    phrase = {"q": '"harbor ferry"', "tag": watch.tag_for('"harbor ferry"')}
    old = {"id": "w_old", "label": "Old", "tag": ww.work_tag("w_old"), "tier": 2, "terms": ["vexamide"],
           "pair_any": [], "exclude": [], "exact": False}
    rules, cur = _files(tmp_path, {"v": 2, "queries": [phrase], "work": [old]})
    assert seed.main([rules, "--key", KEY, "--namespace-id", "ns", "--current-file", cur, "--write-file"]) == 0
    out = capsys.readouterr().out
    m = re.search(r'kv key put (\w+) --namespace-id ns --path "([^"]+)" --remote', out)
    assert m and m.group(1) == KEY
    value = json.loads(Path(m.group(2)).read_text(encoding="utf-8"))
    Path(m.group(2)).unlink()
    assert value["v"] == 2 and value["queries"] == [phrase]
    assert [r["id"] for r in value["work"]] == ["w_one", "w_two"]
    assert value["work"][1]["tag"] == ww.work_tag("w_two")
    assert "zorbium" not in out


def test_a_rule_the_site_refuses_is_refused_here(tmp_path, capsys):
    rules, cur = _files(tmp_path, None)
    doc = json.loads(Path(rules).read_text(encoding="utf-8"))
    doc["profile"]["work_watch"][0]["tier"] = 9
    Path(rules).write_text(json.dumps(doc), encoding="utf-8")
    assert seed.main([rules, "--email", "reader@example.com", "--namespace-id", "ns", "--current-file", cur]) == 1
    assert "refuses" in capsys.readouterr().err


def test_a_key_must_be_64_hex(tmp_path):
    rules, cur = _files(tmp_path, None)
    assert seed.main([rules, "--key", "nothex", "--namespace-id", "ns", "--current-file", cur]) == 2
