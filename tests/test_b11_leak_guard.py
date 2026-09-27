"""B11: scripts/private_leak_guard.py with invented lists only. It skips (and passes)
without a list, finds a list term that is in the repo, lets a term the repo already had
at its baseline through, never prints a term, and refuses a list kept inside the repo."""
import importlib.util
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("private_leak_guard", ROOT / "scripts" / "private_leak_guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

# A shallow checkout (CI clones one commit) has no baseline to compare against; the guard
# is a local tool, so the tests that run it against the repo need the baseline present.
HAS_BASELINE = subprocess.run(["git", "-C", str(ROOT), "cat-file", "-e", f"{guard.BASELINE}^{{commit}}"],
                              capture_output=True).returncode == 0
needs_baseline = pytest.mark.skipif(not HAS_BASELINE, reason="the baseline commit is not in this checkout")

LIST = """# a comment line, never a term
Tier 1: a heading, never a term
* zorbiumxq program, quillasexq (partner), vexa / plovexqq
Noise traps
* "brewquor": pair with something.
"""


def test_extract_terms_takes_bullets_parts_quotes_and_long_words():
    terms = guard.extract_terms(LIST)
    assert {"zorbiumxq program", "zorbiumxq", "quillasexq", "partner", "vexa", "plovexqq", "brewquor"} <= terms
    assert not any("comment" in t or "heading" in t for t in terms)


def test_skips_and_passes_without_a_list(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv(guard.ENV_NAME, str(tmp_path / "missing.md"))
    assert guard.main([]) == 0
    assert "skipped" in capsys.readouterr().out


@needs_baseline
def test_finds_a_term_in_the_repo_and_never_prints_it(tmp_path, monkeypatch, capsys):
    source = tmp_path / "list.md"
    source.write_text("* brewquor, zorbiumxq\n", encoding="utf-8")  # the first is in this slice's tests
    monkeypatch.setenv(guard.ENV_NAME, str(source))
    assert guard.main(["--base", "HEAD"]) == 1
    out = capsys.readouterr().out
    assert "FAILED" in out and "tests/fixtures/work_watch_parity.json" in out
    assert "brewquor" not in out and "zorbiumxq" not in out


@needs_baseline
def test_a_term_the_repo_had_at_its_baseline_is_not_private(tmp_path, monkeypatch, capsys):
    source = tmp_path / "list.md"
    absent = "qqz" + "ntv"  # built here, so no file in the repo holds it whole
    source.write_text(f"* fermentation, {absent}\n", encoding="utf-8")
    monkeypatch.setenv(guard.ENV_NAME, str(source))
    assert guard.main(["--base", "HEAD"]) == 0
    assert "clean (1 private terms" in capsys.readouterr().out


def test_refuses_a_list_inside_the_repo(monkeypatch):
    monkeypatch.setenv(guard.ENV_NAME, str(ROOT / "README.md"))
    assert guard.main([]) == 2
