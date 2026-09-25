"""B7: the embedding bake-off. Standard library only (R30). Never runs in the publish path.

Run by .github/workflows/bakeoff.yml (workflow_dispatch only) with the pipeline token:

  plan    the account's Workers plan through the API (GET /accounts/{id}/subscriptions,
          which needs Billing Read), and the neurons Workers AI has charged today (GraphQL
          aiInferenceAdaptiveGroups, which needs Account Analytics Read). Tries each named
          token env var in turn. Exit 0 only when some token confirms no Workers Paid
          subscription; the workflow embeds nothing otherwise.
  embed   embeds every article of the gold fixtures (tests/fixtures/bundles/gold_*.json,
          which also hold the missed-pairs fixture's ids) with one model and writes the
          vectors, full width, signed 8-bit (fetcher.embed.quantize), to a JSON file.
  score   the metric table: B2's lexical score against lexical plus the embedding term at
          a few weights, the best floor for each, per fixture, plus missed pairs joined.

The fixtures are public test data, so embedding them is fine. Output is counts and
metrics only: never a token, an account id, or a headline.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from fetcher import cluster
from fetcher import embed
from fetcher.bundle_eval import load_fixture, score

ROOT = Path(__file__).resolve().parent.parent
BUNDLES = ROOT / "tests/fixtures/bundles"
MISSED = BUNDLES / "missed_pairs_2026-09-24.json"
CF = "https://api.cloudflare.com/client/v4"
WEIGHTS = (0.25, 0.5, 0.75, 1.0)
FLOORS = tuple(round(0.30 + 0.05 * k, 2) for k in range(12))  # 0.30 .. 0.85
MAX_BAKEOFF_NEURONS = 1000
QWEN_INSTRUCTION = ("Identify the specific news development this headline and summary "
                    "report, for grouping versions of one story")


def gold_paths():
    return sorted(BUNDLES.glob("gold_*.json"))


def fixture_articles():
    """{fixture name: articles} for every gold fixture."""
    return {p.name: load_fixture(p)["articles"] for p in gold_paths()}


def _get(url, token, timeout=20):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read())
        except (ValueError, OSError):
            return exc.code, {}
    except (urllib.error.URLError, OSError, ValueError):
        return 0, {}


def _post(url, token, payload, timeout=20):
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST",
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read())
        except (ValueError, OSError):
            return exc.code, {}
    except (urllib.error.URLError, OSError, ValueError):
        return 0, {}


def _codes(doc):
    return [e.get("code") for e in (doc.get("errors") or []) if isinstance(e, dict)]


def workers_plan(subscriptions):
    """paid when any subscription's rate plan is a Workers Paid one, else free."""
    for sub in subscriptions:
        rp = (sub or {}).get("rate_plan") or {}
        name = f"{rp.get('id', '')} {rp.get('public_name', '')}".lower()
        if "worker" in name and "free" not in name:
            return "paid"
    return "free"


def cmd_plan(args):
    account = os.environ.get(embed.ACCOUNT_ENV, "")
    if not account:
        print("plan: account id env var is empty")
        return 3
    verdict = None
    for env_name in args.token_env:
        token = os.environ.get(env_name, "")
        if not token:
            print(f"plan via {env_name}: token env var is empty")
            continue
        status, doc = _get(f"{CF}/accounts/{account}/subscriptions", token)
        if status == 200 and doc.get("success") and isinstance(doc.get("result"), list):
            subs = doc["result"]
            plan = workers_plan(subs)
            scopes = sorted({((s or {}).get("rate_plan") or {}).get("scope") or "?" for s in subs})
            print(f"plan via {env_name}: subscriptions={len(subs)} scopes={scopes} "
                  f"workers_plan={plan}")
            verdict = verdict or plan
        else:
            print(f"plan via {env_name}: subscriptions unreadable (http {status}, "
                  f"cf codes {_codes(doc)})")
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        q = ("query($a: String!, $d: Date!) { viewer { accounts(filter: {accountTag: $a}) { "
             "aiInferenceAdaptiveGroups(filter: {date_geq: $d, date_leq: $d}, limit: 1) "
             "{ sum { totalNeurons } } } } }")
        status, doc = _post(f"{CF}/graphql", token, {"query": q, "variables": {"a": account, "d": day}})
        try:
            groups = doc["data"]["viewer"]["accounts"][0]["aiInferenceAdaptiveGroups"]
            total = groups[0]["sum"]["totalNeurons"] if groups else 0
            print(f"neurons via {env_name}: workers_ai_neurons_today={total:.1f} (UTC {day})")
        except (KeyError, IndexError, TypeError, AttributeError):
            n = len(doc.get("errors") or []) if isinstance(doc, dict) else 0
            print(f"neurons via {env_name}: analytics unreadable (http {status}, {n} errors)")
    if verdict == "free":
        print("plan verdict: Workers Free confirmed (no Workers Paid subscription); calls past "
              "the daily allocation fail rather than bill")
        return 0
    if verdict == "paid":
        print("plan verdict: Workers Paid. Stop: calls past the free allocation would bill")
        return 3
    print("plan verdict: unconfirmed. No token could read the account's subscriptions")
    return 3


def cmd_embed(args):
    account = os.environ.get(embed.ACCOUNT_ENV, "")
    token = os.environ.get(embed.TOKEN_ENV, "")
    if not account or not token:
        print(f"embed: {embed.ACCOUNT_ENV} or {embed.TOKEN_ENV} is empty")
        return 3
    arts = {}
    for name, items in fixture_articles().items():
        for a in items:
            arts.setdefault(a["id"], a)
    items = sorted(arts.values(), key=lambda a: a["id"])
    client = embed.WorkersAI(account, token, model=args.model,
                             instruction=QWEN_INSTRUCTION if args.instruct else None)
    texts = [embed.embed_text(a) for a in items]
    est = sum(embed.estimate_tokens(t) for t in texts)
    if client.instruction:
        est += embed.estimate_tokens(client.instruction) * len(texts)
    if embed.neurons(est) > MAX_BAKEOFF_NEURONS:
        print(f"embed: refused, estimate {embed.neurons(est):.0f} neurons is over {MAX_BAKEOFF_NEURONS}")
        return 3
    out, reported, calls, seconds, width = {}, 0, 0, 0.0, None
    for k in range(0, len(items), client.batch):
        chunk = texts[k:k + client.batch]
        t0 = time.perf_counter()
        try:
            data, rep = client.embed(chunk)
        except embed.EmbedError as exc:
            print(f"embed {args.model}: failed at call {calls + 1}: {exc}")
            return 4
        seconds += time.perf_counter() - t0
        calls += 1
        reported += rep or 0
        width = len(data[0])
        for a, values in zip(items[k:k + client.batch], data):
            out[a["id"]] = embed.encode(embed.quantize(values, dims=len(values)))
    label = args.model + (" +instruction" if client.instruction else "")
    print(f"embed {label}: articles={len(items)} calls={calls} batch={client.batch} dims={width} "
          f"api_seconds={seconds:.2f} per_call={seconds / max(calls, 1):.2f}s "
          f"tokens_est={est} tokens_reported={reported or 'none'} "
          f"neurons_est={embed.neurons(est):.1f} neurons_reported={embed.neurons(reported):.1f}")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps({"model": args.model, "instruction": bool(client.instruction),
                                          "dims": width, "items": out}, separators=(",", ":")),
                              encoding="utf-8")
    return 0


def load_vectors(path, dims=None):
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    vecs = {}
    for k, v in doc["items"].items():
        vec = embed.decode(v)
        if dims and dims < len(vec):  # a Matryoshka cut: the first dims, renormalized later
            vec = vec[:dims]
        vecs[k] = vec
    return doc, vecs


def missed_joined(arts, clusters):
    pairs = json.loads(MISSED.read_text(encoding="utf-8"))["pairs"]
    of = {i: n for n, c in enumerate(clusters) for i in c}
    return sum(1 for p in pairs if p["ids"][0] in of and of[p["ids"][0]] == of.get(p["ids"][1])), len(pairs)


def evaluate(fixtures, vectors, weight=None, floor=None, term_min=0.0):
    """Metrics per fixture and missed pairs joined, with the term's settings applied."""
    saved = cluster.EMBED_WEIGHT, cluster.EMBED_FLOOR, cluster.EMBED_TERM_MIN
    try:
        if weight is not None:
            cluster.EMBED_WEIGHT, cluster.EMBED_FLOOR, cluster.EMBED_TERM_MIN = weight, floor, term_min
        rows = {}
        joined = None
        for name, arts in fixtures.items():
            clusters = [c["article_ids"] for c in cluster.cluster_items(arts, vectors=vectors)]
            rows[name] = score(arts, clusters)
            if name == json.loads(MISSED.read_text(encoding="utf-8"))["fixture"]:
                joined = missed_joined(arts, clusters)[0]
        return rows, joined
    finally:
        cluster.EMBED_WEIGHT, cluster.EMBED_FLOOR, cluster.EMBED_TERM_MIN = saved


def feasible(rows):
    return all(m["pair_precision"] >= 0.95 and m["purity"] >= 0.90 for m in rows.values())


def rank_key(rows, joined):
    recalls = [m["pair_recall"] for m in rows.values()]
    f1 = [m["bcubed_f1"] for m in rows.values()]
    return (feasible(rows), sum(recalls) / len(recalls), joined or 0, sum(f1) / len(f1))


def fmt_row(label, rows, joined):
    cells = []
    for name, m in rows.items():
        cells.append(f"P={m['pair_precision']:.3f} R={m['pair_recall']:.3f} "
                     f"pur={m['purity']:.3f} B3F1={m['bcubed_f1']:.3f}")
    return f"{label:<34} | " + " | ".join(cells) + f" | missed joined={joined}/21"


def cmd_score(args):
    fixtures = fixture_articles()
    print("fixtures: " + ", ".join(f"{n} ({len(a)} articles)" for n, a in fixtures.items()))
    t0 = time.perf_counter()
    rows, joined = evaluate(fixtures, None)
    print(fmt_row("lexical (B2)", rows, joined) + f" [{time.perf_counter() - t0:.1f}s]")
    for path in args.vectors:
        for dims in args.dims or [None]:
            doc, vecs = load_vectors(path, dims)
            tag = doc["model"].split("/")[-1] + ("+instr" if doc.get("instruction") else "")
            tag += f" d{dims or doc['dims']}"
            for term_min in args.term_min:
                for w in args.weights:
                    best = None
                    for fl in args.floors:
                        rows, joined = evaluate(fixtures, vecs, w, fl, term_min)
                        key = rank_key(rows, joined)
                        if best is None or key > best[0]:
                            best = (key, fl, rows, joined)
                    _, fl, rows, joined = best
                    label = f"{tag} w={w} floor={fl}" + (f" min={term_min}" if term_min else "")
                    print(fmt_row(label, rows, joined) + ("" if feasible(rows) else " (fails P or purity)"))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--token-env", nargs="+", default=[embed.TOKEN_ENV])
    e = sub.add_parser("embed")
    e.add_argument("--model", required=True)
    e.add_argument("--instruct", action="store_true")
    e.add_argument("--out", required=True)
    s = sub.add_parser("score")
    s.add_argument("--vectors", nargs="*", default=[])
    s.add_argument("--dims", nargs="*", type=int)
    s.add_argument("--weights", nargs="*", type=float, default=list(WEIGHTS))
    s.add_argument("--floors", nargs="*", type=float, default=list(FLOORS))
    s.add_argument("--term-min", nargs="*", type=float, default=[0.0])
    args = ap.parse_args(argv)
    return {"plan": cmd_plan, "embed": cmd_embed, "score": cmd_score}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
