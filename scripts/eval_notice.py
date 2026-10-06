"""J34: publish each hourly run's Jev and keep-rule numbers as two workflow notices.

The site, and so dist/jev.json and dist/select.json, sits behind Cloudflare Access, and a
run's log needs a GitHub sign-in. A workflow notice does not: anyone can read a public
run's annotations. So after the Jev step the workflow runs this, which prints

    ::notice title=almanac-eval-jev::{...compact JSON...}
    ::notice title=almanac-eval-keep::{...compact JSON...}

and scripts/jev_eval.py reads them back, with no sign-in and no phone, to say how Jev is
doing. Counts and statuses only (the run log already prints the same kind of line): no
headline, no url, no watch tag, nothing about the reader. Standard library only.
"""
import json
import sys
from pathlib import Path

VERSION = 1
MAX_CHARS = 3500  # a notice's message is cut somewhere above this; these stay well under


def _load(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _r(x, n=3):
    return round(x, n) if isinstance(x, (int, float)) and not isinstance(x, bool) else x


def jev_summary(doc):
    """The Jev report as counts, or {"state": "none"} without one."""
    if not isinstance(doc, dict) or not isinstance(doc.get("report"), dict):
        return {"v": VERSION, "state": "none"}
    run, rep = doc.get("run") or {}, doc["report"]
    lat = run.get("latency_ms") or {}
    tri = run.get("triage") or {}
    same = rep.get("same_event_known") or {}
    ai = rep.get("ai_rules_vs_jev") or {}
    groups = rep.get("groups") or {}
    checks = {c["key"]: [c.get("status"), _r(c.get("value")), c.get("n")]
              for c in (doc.get("scorecard") or {}).get("checks", []) if isinstance(c, dict) and "key" in c}
    return {
        "v": VERSION, "state": "ok", "at": doc.get("generated_at"), "mock": bool(doc.get("mock")),
        "route": doc.get("route"), "model": doc.get("model"),
        "run": {"state": run.get("state"), "asked": run.get("asked", 0), "cached": run.get("cached", 0),
                "errors": run.get("errors", 0), "unit": run.get("unit"), "spent_day": _r(run.get("spent_day"), 4),
                "budget_day": _r(run.get("budget_day"), 4), "p50": lat.get("p50"), "p90": lat.get("p90"),
                "triage": {"asked": tri.get("asked", 0), "cached": tri.get("cached", 0), "listed": tri.get("listed", 0),
                           "spent_day": _r(tri.get("spent_day"), 4)}},
        "read": [rep.get("articles_answered", 0), rep.get("articles_in_pool", 0)],
        "same": [same.get("syndicated_read_same", 0), same.get("syndicated_pairs", 0)],
        "diff": [same.get("unrelated_read_different", 0), same.get("unrelated_pairs", 0)],
        "conf": rep.get("confidence") or {},
        "contra": rep.get("clinical_and_industrial_both_likely", 0),
        "ai": {k: ai.get(k, 0) for k in ("both", "rules_only", "jev_only", "neither")},
        "groups": {"applied": bool(groups.get("applied")), "split": groups.get("split", 0),
                   "dissolved": groups.get("dissolved", 0), "annotated": groups.get("annotated", 0)},
        "checks": checks,
    }


def keep_summary(doc):
    """The keep-rule trial as counts, or {"state": ...} when it did not run."""
    if not isinstance(doc, dict):
        return {"v": VERSION, "state": "none"}
    if doc.get("state") != "ok":
        return {"v": VERSION, "state": doc.get("state", "error")}

    def side(r):
        return {"kept": r.get("kept"), "over_36h": r.get("over_36h"), "corroborated": r.get("corroborated"),
                "sg": (r.get("singapore") or {}).get("tag"), "sg_outlets": (r.get("singapore") or {}).get("outlets")}
    m, g, j = doc.get("missed") or {}, doc.get("gate") or {}, doc.get("jev") or {}
    c = j.get("check") or {}
    return {
        "v": VERSION, "state": "ok", "at": doc.get("generated_at"), "mode": doc.get("mode"),
        "cap": side(doc["rules"]["cap"]), "score": side(doc["rules"]["score"]),
        "differ": (doc.get("differ") or {}).get("only_score"),
        "missed": [m.get("cap"), m.get("score")] if m.get("status") == "ok" else None,
        "gate": {"pass": bool(g.get("pass")), "days": g.get("days"), "runs": g.get("runs"), "decided": g.get("decided"),
                 "checks": {x["key"]: bool(x.get("ok")) for x in g.get("checks", []) if isinstance(x, dict) and "key" in x}},
        "jev": {"read": j.get("read", 0), "counting": bool(j.get("counting")), "moved": j.get("moved", 0),
                "split_off": j.get("split_off", 0), "check": [c.get("agree", 0), c.get("n", 0)]},
    }


def notice(title, summary):
    """One workflow notice line: the message escaped as workflow commands require."""
    body = json.dumps(summary, separators=(",", ":"), sort_keys=True)
    if len(body) > MAX_CHARS:
        body = json.dumps({"v": VERSION, "state": "too_long"}, separators=(",", ":"))
    body = body.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    return f"::notice title={title}::{body}"


def main(argv=None):
    dist = Path((argv or sys.argv[1:] or ["dist"])[0])
    print(notice("almanac-eval-jev", jev_summary(_load(dist / "jev.json"))))
    print(notice("almanac-eval-keep", keep_summary(_load(dist / "select.json"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
