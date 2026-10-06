"""J34: how is Jev doing? Read the hourly runs' public notices and say so.

    python3 scripts/jev_eval.py            # the last 12 hourly runs
    python3 scripts/jev_eval.py --runs 24

No sign-in, no phone and no key: each hourly run publishes its Jev and keep-rule numbers
as two workflow notices (scripts/eval_notice.py), and GitHub serves a public run's
annotations to anyone. Without a token GitHub allows about 60 requests an hour, and this
uses two per run plus one, so 24 runs is the practical most in one go (set GITHUB_TOKEN in
the environment yourself to lift that; this script never looks for one anywhere else).

It prints facts first (what Jev did), then a verdict per job Jev has: clear benefit, not
clear yet, or cannot tell yet, each with the numbers it rests on. A run that used the
local stand-in (mock) is never counted. Standard library only.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

REPO = "saurabhmalani1994/news-app"
API = "https://api.github.com"
TITLES = {"almanac-eval-jev": "jev", "almanac-eval-keep": "keep"}


def _get(url, opener=urllib.request.urlopen):
    headers = {"accept": "application/vnd.github+json", "user-agent": "almanac-jev-eval"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    with opener(urllib.request.Request(url, headers=headers), timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_annotations(annotations):
    """{"jev": summary, "keep": summary} from one job's annotations."""
    out = {}
    for a in annotations or []:
        kind = TITLES.get((a or {}).get("title"))
        if not kind:
            continue
        try:
            doc = json.loads(a.get("message") or "")
        except ValueError:
            continue
        if isinstance(doc, dict):
            out[kind] = doc
    return out


def fetch(runs=12, repo=REPO, get=_get):
    """[{at, run_id, jev?, keep?}] for the newest completed publish runs, oldest first."""
    listing = get(f"{API}/repos/{repo}/actions/workflows/publish.yml/runs?per_page={runs}&status=completed")
    out = []
    for run in listing.get("workflow_runs", []):
        jobs = get(f"{API}/repos/{repo}/actions/runs/{run['id']}/jobs").get("jobs", [])
        job = next((j for j in jobs if j.get("name") == "publish"), None)
        if not job:
            continue
        found = parse_annotations(get(f"{API}/repos/{repo}/check-runs/{job['id']}/annotations"))
        out.append({"at": run.get("created_at"), "run_id": run["id"], **found})
    return sorted(out, key=lambda r: r["at"] or "")


def _avg(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return sum(xs) / len(xs) if xs else None


def _pct(part, whole):
    return f"{round(100 * part / whole)}%" if whole else "n/a"


def evaluate(rows):
    """{"facts": [...], "verdicts": [(job, verdict, why)], "runs": n} from fetched rows."""
    jev = [r["jev"] for r in rows if r.get("jev", {}).get("state") == "ok" and not r["jev"].get("mock")]
    keep = [r["keep"] for r in rows if r.get("keep", {}).get("state") == "ok"]
    mock = sum(1 for r in rows if r.get("jev", {}).get("mock"))
    facts, verdicts = [], []
    if not jev and not keep:
        why = ("these runs used the stand-in, not the real Jev" if mock else
               "no almanac-eval notices in these runs: they start with the first run after J34 is merged")
        return {"runs": len(rows), "facts": [f"Nothing to evaluate: {why}."], "verdicts": []}

    if jev:
        last = jev[-1]
        run = last["run"]
        facts.append(f"Runs with real Jev answers: {len(jev)} of {len(rows)} (route {last.get('route')}, model {last.get('model')}).")
        facts.append(f"Latest run: {run.get('state')}, {run.get('asked')} new questions, {run.get('cached')} reused, "
                     f"{run.get('errors')} errors; spent today {run.get('spent_day')} of {run.get('budget_day')} {run.get('unit')}.")
        facts.append(f"Articles in the feed Jev has read: {last['read'][0]} of {last['read'][1]}.")
        splits = _avg([j["groups"]["split"] for j in jev if j["groups"].get("applied")])
        marked = _avg([j["groups"]["annotated"] for j in jev if j["groups"].get("applied")])
        same, diff = last["same"], last["diff"]
        facts.append(f"Story groups: {'%.1f' % splits if splits is not None else 'n/a'} versions moved to their own card per run, "
                     f"{'%.0f' % marked if marked is not None else 'n/a'} compared for the other side.")
        ok_same = same[1] >= 5 and same[0] / same[1] >= 0.9
        ok_diff = diff[1] >= 10 and diff[0] / diff[1] >= 0.95
        if same[1] < 5 or diff[1] < 10:
            verdicts.append(("Fixing story groups", "cannot tell yet", f"too few known pairs ({same[1]} same, {diff[1]} different)"))
        else:
            verdicts.append(("Fixing story groups", "clear benefit" if ok_same and ok_diff and (splits or 0) > 0 else "not clear yet",
                             f"same story kept together {same[0]}/{same[1]} ({_pct(*same)}), different kept apart {diff[0]}/{diff[1]} "
                             f"({_pct(*diff)}), {'%.1f' % (splits or 0)} wrong groupings fixed per run"))
        for key, name in (("section", "Sorting into sections"), ("region", "Sorting into regions")):
            status, value, n = (last["checks"].get(key) or [None, None, 0])
            if status in (None, "not_enough_data") or value is None:
                verdicts.append((name, "cannot tell yet", f"only {n} articles to check against"))
            else:
                verdicts.append((name, "works" if status == "pass" else "not clear yet",
                                 f"matches single-subject feeds {round(100 * value)}% of the time over {n} articles "
                                 "(measured only: tabs still use the rules)"))
        # J35: the two trials. Each sums over the fetched runs (a pair or an article can
        # recur across runs, so these are run totals, not distinct counts).
        mt = [j["merge"] for j in jev if isinstance(j.get("merge"), dict)]
        if mt:
            pairs, same, diff = (sum(m.get(k, 0) for m in mt) for k in ("pairs", "same", "different"))
            latest = mt[-1]
            facts.append(f"Merge trial: of {latest.get('pairs', 0)} look-alike story pairs the rules left apart this run, "
                         f"Jev reads {latest.get('same', 0)} as the same event and {latest.get('different', 0)} as different.")
            if pairs < 10:
                verdicts.append(("Jev joining stories the rules left apart (trial)", "cannot tell yet", f"only {pairs} pairs answered so far"))
            else:
                verdicts.append(("Jev joining stories the rules left apart (trial)", "would help" if same else "little to add",
                                 f"across these runs Jev would join {same} of {pairs} look-alike pairs and keep {diff} apart"))
        tt = last.get("topics") or {}
        for topic, v in sorted(tt.items()):
            own, other = v.get("own") or [0, 0], v.get("other") or [0, 0]
            facts.append(f"Topic trial, {topic}: Jev says yes for {own[0]} of {own[1]} articles from {topic} outlets, and for "
                         f"{other[0]} of {other[1]} from unrelated outlets; it would add the tag to {v.get('adds', 0)} articles and drop it from {v.get('drops', 0)}.")
            if own[1] < 20 or other[1] < 20:
                verdicts.append((f"Jev tagging {topic} (trial)", "cannot tell yet", f"only {own[1]} articles from {topic} outlets this run"))
            else:
                good = own[0] / own[1] >= 0.8 and other[0] / other[1] <= 0.05
                verdicts.append((f"Jev tagging {topic} (trial)", "ready to try" if good else "not clear yet",
                                 f"finds it in {_pct(*own)} of {topic} outlets' articles (aim 80%), false alarms {_pct(*other)} (aim 5% or less)"))
        conf = last.get("conf") or {}
        total = sum(conf.values())
        facts.append(f"How sure Jev was: {_pct(conf.get('sure', 0), total)} sure, {_pct(conf.get('ambiguous', 0), total)} split, over {total} answers.")
        lat = run.get("p90")
        spent, budget = run.get("spent_day") or 0, run.get("budget_day") or 0
        verdicts.append(("Cost and speed", "fine" if budget and spent <= budget and (lat is None or lat <= 1500) else "watch",
                         f"spent {spent} of {budget} {run.get('unit')} today, slowest 1 in 10 answers {lat if lat is not None else 'n/a'} ms"))

    if keep:
        last = keep[-1]
        stale = (_avg([k["cap"]["over_36h"] for k in keep]), _avg([k["score"]["over_36h"] for k in keep]))
        corr = (_avg([k["cap"]["corroborated"] for k in keep]), _avg([k["score"]["corroborated"] for k in keep]))
        missed = [k["missed"] for k in keep if k.get("missed") and None not in k["missed"]]
        mc, ms = sum(m[0] for m in missed), sum(m[1] for m in missed)
        g = last["gate"]
        facts.append(f"Keep rule ({last.get('mode')}): older than 36h {stale[0]:.0f} -> {stale[1]:.0f}, in stories 2+ outlets cover "
                     f"{corr[0]:.0f} -> {corr[1]:.0f}, missed stories {mc} -> {ms} over {len(missed)} runs (old rule -> new rule).")
        failing = sorted(k for k, ok in (g.get("checks") or {}).items() if not ok)
        facts.append(f"Going live: {'passes' if g.get('pass') else 'not yet'}; {g.get('days')} days, {g.get('runs')} runs"
                     + (f"; still failing: {', '.join(failing)}." if failing else "."))
        better = stale[1] <= stale[0] and corr[1] >= corr[0]
        verdicts.append(("New keep rule (rules, not Jev)", "clear benefit" if better and missed and ms <= mc else "not clear yet",
                         f"fresher and better covered: {'yes' if better else 'no'}; missed stories {ms} vs {mc}"))
        j = last["jev"]
        agree, n = j["check"]
        if not j.get("read"):
            verdicts.append(("Jev helping choose what to keep", "cannot tell yet", "Jev has not read any articles near the cut"))
        elif not j.get("counting"):
            verdicts.append(("Jev helping choose what to keep", "not counting yet",
                             f"read {j['read']} articles, would move {j['moved']}; its opinion check is {agree}/{n} (needs 80% of at least 20)"))
        else:
            verdicts.append(("Jev helping choose what to keep", "counting", f"read {j['read']} articles, moves {j['moved']}; opinion check {agree}/{n}"))
    return {"runs": len(rows), "facts": facts, "verdicts": verdicts}


def render(result, first="", last=""):
    lines = [f"Jev evaluation over {result['runs']} hourly runs" + (f" ({first} to {last})" if first else ""), "", "Facts"]
    lines += [f"  - {f}" for f in result["facts"]]
    if result["verdicts"]:
        lines += ["", "Verdicts"]
        lines += [f"  - {job}: {verdict.upper()}. {why}." for job, verdict, why in result["verdicts"]]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--runs", type=int, default=12)
    ap.add_argument("--repo", default=REPO)
    ap.add_argument("--json", action="store_true", help="print the fetched rows as JSON instead")
    args = ap.parse_args(argv)
    try:
        rows = fetch(args.runs, args.repo)
    except urllib.error.HTTPError as exc:
        print(f"GitHub answered {exc.code}: wait for the hourly request limit to reset, or ask for fewer --runs.", file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError):
        print("Could not reach GitHub.", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(rows, indent=1))
        return 0
    print(render(evaluate(rows), rows[0]["at"] if rows else "", rows[-1]["at"] if rows else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
