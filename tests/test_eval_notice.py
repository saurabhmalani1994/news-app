"""J34: each hourly run publishes its Jev and keep-rule numbers as public notices
(scripts/eval_notice.py), and scripts/jev_eval.py reads them back into an evaluation."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


notice = _load("eval_notice")
ev = _load("jev_eval")

JEV = {
    "generated_at": "2026-10-06T17:20:00Z", "mock": False, "route": "openrouter", "model": "typesafe/jev-1.13",
    "run": {"state": "ok", "asked": 41, "cached": 650, "errors": 0, "unit": "usd", "spent_day": 0.0712, "budget_day": 0.25,
            "latency_ms": {"p50": 420, "p90": 910, "n": 41}, "triage": {"asked": 30, "cached": 170, "listed": 200, "spent_day": 0.02}},
    "report": {
        "articles_answered": 640, "articles_in_pool": 690,
        "same_event_known": {"syndicated_pairs": 12, "syndicated_read_same": 11, "unrelated_pairs": 20, "unrelated_read_different": 20,
                             "examples": {"same": {"hit": {"a": {"title": "SENTINEL headline"}}}}},
        "confidence": {"sure": 900, "lean": 150, "ambiguous": 80}, "clinical_and_industrial_both_likely": 1,
        "ai_rules_vs_jev": {"both": 20, "rules_only": 5, "jev_only": 9, "neither": 600, "examples": {"jev_only": [{"title": "SENTINEL"}]}},
        "groups": {"applied": True, "split": 6, "dissolved": 2, "annotated": 120, "examples": [{"title": "SENTINEL split"}]},
    },
    "scorecard": {"checks": [{"key": "section", "status": "pass", "value": 0.86, "n": 58},
                             {"key": "region", "status": "fail", "value": 0.61, "n": 111}]},
    "answers": {"a1": {"section": {"v": "SENTINEL"}}},
}
KEEP = {
    "state": "ok", "generated_at": "2026-10-06T17:18:00Z", "mode": "shadow",
    "rules": {"cap": {"kept": 700, "over_36h": 95, "corroborated": 240, "singapore": {"tag": 14, "outlets": 35}},
              "score": {"kept": 670, "over_36h": 72, "corroborated": 350, "singapore": {"tag": 17, "outlets": 33}}},
    "differ": {"only_score": 205, "only_cap": 235}, "missed": {"status": "ok", "cap": 4, "score": 3},
    "gate": {"pass": False, "days": 5.9, "runs": 140, "decided": "trial",
             "checks": [{"key": "week", "ok": False, "detail": "x"}, {"key": "missed", "ok": True, "detail": "y"}]},
    "jev": {"read": 300, "counting": False, "moved": 12, "split_off": 30, "check": {"agree": 9, "n": 14, "share": 0.64, "passed": False}},
    "examples": {"only_score": [{"title": "SENTINEL kept"}]},
}


def test_the_notices_carry_counts_only_and_stay_short():
    j, k = notice.jev_summary(JEV), notice.keep_summary(KEEP)
    lines = [notice.notice("almanac-eval-jev", j), notice.notice("almanac-eval-keep", k)]
    text = "\n".join(lines)
    assert "SENTINEL" not in text, "no headline or answer ever leaves in a notice"
    assert all(line.startswith("::notice title=almanac-eval-") and len(line) < 4000 and "\n" not in line for line in lines)
    assert j["same"] == [11, 12] and j["checks"]["section"] == ["pass", 0.86, 58] and j["groups"]["split"] == 6
    assert k["score"]["over_36h"] == 72 and k["missed"] == [4, 3] and k["gate"]["checks"] == {"week": False, "missed": True}
    assert notice.jev_summary(None) == {"v": 1, "state": "none"} and notice.keep_summary({"state": "error"})["state"] == "error"
    assert "%25" in notice.notice("t", {"a": "50%"}) and "too_long" in notice.notice("t", {"a": "x" * 5000})


def _row(at, jev=None, keep=None):
    def wrap(title, doc):
        return {"title": title, "message": notice.notice(title, doc).split("::", 2)[2]}
    found = ev.parse_annotations([wrap("almanac-eval-jev", jev or notice.jev_summary(JEV)),
                                  wrap("almanac-eval-keep", keep or notice.keep_summary(KEEP)),
                                  {"title": "", "message": "Node.js 20 is deprecated"}])
    return {"at": at, "run_id": 1, **found}


def test_the_evaluation_reads_the_notices_back_into_facts_and_verdicts():
    rows = [_row("2026-10-06T16:17:00Z"), _row("2026-10-06T17:17:00Z")]
    result = ev.evaluate(rows)
    verdicts = {job: (verdict, why) for job, verdict, why in result["verdicts"]}
    assert verdicts["Fixing story groups"][0] == "clear benefit" and "11/12" in verdicts["Fixing story groups"][1]
    assert verdicts["Sorting into sections"][0] == "works" and "86%" in verdicts["Sorting into sections"][1]
    assert verdicts["Sorting into regions"][0] == "not clear yet"
    assert verdicts["Jev helping choose what to keep"][0] == "not counting yet" and "9/14" in verdicts["Jev helping choose what to keep"][1]
    assert verdicts["New keep rule (rules, not Jev)"][0] == "clear benefit"
    assert verdicts["Cost and speed"][0] == "fine"
    text = ev.render(result, rows[0]["at"], rows[-1]["at"])
    assert text.startswith("Jev evaluation over 2 hourly runs") and "Facts" in text and "Verdicts" in text and "\u2014" not in text


def test_stand_in_runs_and_runs_before_the_notices_are_never_counted():
    mock = notice.jev_summary({**JEV, "mock": True})
    only_mock = ev.evaluate([_row("2026-10-06T17:17:00Z", jev=mock, keep={"v": 1, "state": "none"})])
    assert only_mock["verdicts"] == [] and "stand-in" in only_mock["facts"][0]
    none = ev.evaluate([{"at": "2026-10-06T17:17:00Z", "run_id": 2}])
    assert none["verdicts"] == [] and "first run after" in none["facts"][0]


def test_fetch_asks_github_for_runs_jobs_and_annotations_only():
    calls = []

    def get(url):
        calls.append(url)
        if "/workflows/publish.yml/runs" in url:
            return {"workflow_runs": [{"id": 7, "created_at": "2026-10-06T17:17:00Z"}]}
        if url.endswith("/actions/runs/7/jobs"):
            return {"jobs": [{"id": 70, "name": "test"}, {"id": 71, "name": "publish"}]}
        if url.endswith("/check-runs/71/annotations"):
            return [{"title": "almanac-eval-keep", "message": json.dumps(notice.keep_summary(KEEP))}]
        raise AssertionError(url)
    rows = ev.fetch(1, "o/r", get)
    assert len(calls) == 3 and rows[0]["keep"]["mode"] == "shadow" and "jev" not in rows[0]


# --- J35: the two trials reach the notice and the evaluation ---

def test_the_trials_are_published_as_counts_and_judged():
    doc = json.loads(json.dumps(JEV))
    doc["report"]["merge_trial"] = {"near_misses": 14, "pairs": 12, "same": 5, "different": 6, "unsure": 1,
                                    "examples": [{"a": {"title": "SENTINEL a"}, "b": {"title": "SENTINEL b"}, "p": 0.9}]}
    doc["report"]["topic_trial"] = {"ai": {"own": [44, 50], "other": [1, 120], "adds": 35, "drops": 0},
                                    "biotech": {"own": [3, 8], "other": [0, 120], "adds": 2, "drops": 1}}
    summary = notice.jev_summary(doc)
    assert summary["merge"] == {"near_misses": 14, "pairs": 12, "same": 5, "different": 6, "unsure": 1}
    assert summary["topics"]["ai"] == {"own": [44, 50], "other": [1, 120], "adds": 35, "drops": 0}
    line = notice.notice("almanac-eval-jev", summary)
    assert "SENTINEL" not in line and len(line) < 4000
    result = ev.evaluate([_row("2026-10-07T01:17:00Z", jev=summary)])
    verdicts = {job: (verdict, why) for job, verdict, why in result["verdicts"]}
    assert verdicts["Jev joining stories the rules left apart (trial)"] == ("would help", "across these runs Jev would join 5 of 12 look-alike pairs and keep 6 apart")
    assert verdicts["Jev tagging ai (trial)"][0] == "ready to try" and "88%" in verdicts["Jev tagging ai (trial)"][1]
    assert verdicts["Jev tagging biotech (trial)"][0] == "cannot tell yet"
    assert any(f.startswith("Merge trial: of 12 look-alike story pairs") for f in result["facts"])
    # A run from before the trials (no merge or topics in its notice) still evaluates.
    assert "Fixing story groups" in {job for job, *_ in ev.evaluate([_row("2026-10-06T17:17:00Z")])["verdicts"]}
