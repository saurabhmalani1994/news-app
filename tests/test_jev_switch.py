"""J40: one switch pauses Jev everywhere: the hourly step, the keep rule, the page."""
import json
import sys

from fetcher import jev_shadow as js
from fetcher.jev_switch import SWITCH, jev_paused


def test_the_repo_switch_reads_as_paused_and_the_environment_overrides_it(tmp_path):
    assert "export const JEV_PAUSED = true;" in SWITCH.read_text()
    assert jev_paused({}) is True
    assert jev_paused({"JEV_PAUSED": "0"}) is False and jev_paused({"JEV_PAUSED": "1"}) is True
    off = tmp_path / "switch.js"
    off.write_text("export const JEV_PAUSED = false;\n")
    assert jev_paused({}, off) is False
    assert jev_paused({}, tmp_path / "missing.js") is True, "unreadable reads as paused"


def test_a_paused_hourly_step_asks_nothing_and_leaves_the_pool_alone(tmp_path, monkeypatch):
    pool = tmp_path / "pool.json"
    pool.write_text('{"articles": [], "clusters": []}')
    before = pool.read_text()
    monkeypatch.setenv("JEV_PAUSED", "1")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-x")
    monkeypatch.setattr(js, "run", lambda *a, **k: (_ for _ in ()).throw(AssertionError("Jev was asked")))
    out = tmp_path / "jev.json"
    assert js.main(["--pool", str(pool), "--out", str(out), "--cache", str(tmp_path / "c.json"), "--apply"]) == 0
    assert json.loads(out.read_text())["paused"] is True and pool.read_text() == before
    assert not (tmp_path / "c.json").exists(), "the answers cache is kept as it was for when Jev resumes"


def test_health_the_page_and_the_eval_say_jev_is_paused():
    import importlib.util
    from pathlib import Path
    from app.build import ASK_BAR, ask_bar_html
    from app.health import render_jev
    html = render_jev({"paused": True})
    assert "Jev is paused" in html and "switch.js" in html
    assert 'id="ask-bar"' not in ask_bar_html(paused=True) and 'id="today-order"' in ask_bar_html(paused=True)
    assert ask_bar_html(paused=False) == ASK_BAR
    spec = importlib.util.spec_from_file_location("eval_notice", Path(__file__).resolve().parents[1] / "scripts" / "eval_notice.py")
    notice = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(notice)
    assert notice.jev_summary({"paused": True, "generated_at": "2026-11-16T01:17:00Z"})["state"] == "paused"
