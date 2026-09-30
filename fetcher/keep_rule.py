"""J24: the keep-rule trial (named keep_rule, not select, so it never shadows the stdlib module). Standard library only (R30).

Every hourly run keeps about 680 of about 5,300 fetched items. Today's rule
(fetcher.fanout's cap loop) keeps each source's first PER_SOURCE_CAP items in feed
order, plus a few that belong to multi-source stories. Feed order is not newest first,
so stale items often win, and nothing about how well a story is reported counts.

This module is a second rule, run beside the first in shadow: it scores every candidate
on facts alone and fills the same byte budget by score, under floors (every source, both
sides of a two-sided story, every bucket) and ceilings (per source, per syndication
group, per story, per lean). Each source bucket (sources.json: singapore, ai, biotech,
climate_food ...) keeps the same number of articles it keeps today (a byte share let
longer articles crowd out Singapore ones), so the mix of subjects the owner
chose when picking sources stays as it is: the new rule only picks better articles
inside each bucket. A first live run without that kept the pool fresher but moved space
from the owner's niche buckets (AI, biotech, climate and food, Singapore) to widely
covered hard news. Nothing about the owner enters it: the pool
stays opinion-free (DESIGN-v1.1 section 3) and trust stays on the phone (R10). The
published pool is exactly today's; only dist/select.json reports what the new rule would
have kept, for the Health page's "Keep rule trial" section.

Fact terms, whole points (the same style as fetcher/best_version.py):
  corroboration  12 x log2(independent outlets on the story), at most 36
  lean_span      8 when those outlets span two or more lean buckets
  original       10 unless the article is a wire rewrite (best_version.is_syndicated_copy)
  complete       6 with a full-text body of FULL_BODY_CHARS or more, else 3 with a dek
                 of DEK_CHARS or more
  health         -10 when the source failed 3 or more runs in a row
  paywall        -6 for a paywalled source without a full body
  hard           10 when any topic tag is hard news (topics.json hard_news)
  recency        20 x 2^(-age / 12 hours)
  incumbent      6 when the previous pool had it (steadier hour to hour)

Deterministic: no clock (now is passed in), no randomness, ties broken by
(score desc, published_at desc, id), so the same candidates in any order give the same
selection.
"""
import json
import math
from collections import Counter

from fetcher.best_version import failed_runs, is_syndicated_copy
from fetcher.fetch import _plain

SCHEMA_VERSION = 1
TERMS = ("corroboration", "lean_span", "original", "complete", "health", "paywall", "hard", "recency", "incumbent")

FLOOR_PER_SOURCE = 2
SOURCE_CEIL = 12
GROUP_CEIL = 12
CLUSTER_CEIL = 6
CLUSTER_EXTRA_PENALTY = 8
BUCKET_FLOOR = 8
LEAN_SHARE_MAX = 0.40
STORY_LEAN_FLOOR = 4
STALE_H = 36
MISSED_WINDOW_H = 12
MISSED_KEEP = 1500
EXAMPLES = 8
FULL_BODY_CHARS = 600
DEK_CHARS = 80
RECORD_OVERHEAD = 60
# J27: the keep rule keeps more multi-outlet stories, and each adds a cluster record the
# per-article estimate does not see; a live run came to 597KB of the ~600KB pool budget.
SIZE_MARGIN = 0.96
PUBLISHED_DEK_CHARS = 600  # fetcher.fanout's, kept equal by tests/test_select.py

WHY = ("floor_source", "floor_story", "floor_bucket", "fill")


def _epoch(ts):
    from datetime import datetime, timezone
    try:
        return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except (TypeError, ValueError):
        return None


def build_context(sources, candidates, all_clusters, body_candidates=None, previous_health=None,
                  previous_ids=frozenset(), now=None, hard_topics=()):
    """What the terms read, built once per run from the pre-cap candidates."""
    by_id = {a["id"]: a for a in candidates}
    sources_by_id = {s["id"]: s for s in sources}
    syndication = {s["id"]: s.get("syndication_group") or s["id"] for s in sources}
    lean = {s["id"]: s["lean"] for s in sources if s.get("lean")}
    cluster_of = {}
    for cl in all_clusters:
        ids = [i for i in cl["article_ids"] if i in by_id]
        srcs = {by_id[i]["source_id"] for i in ids}
        info = {"id": cl.get("id") or min(ids), "n": len({syndication.get(s, s) for s in srcs}),
                "leans": sorted({lean[s] for s in srcs if s in lean}), "size": len(ids)}
        for i in ids:
            cluster_of[i] = info
    body_chars = {i: len(_plain(h)) for i, h in (body_candidates or {}).items() if h}
    return {
        "by_id": by_id, "sources": sources_by_id, "syndication": syndication, "lean": lean,
        "cluster_of": cluster_of, "body_chars": body_chars, "previous_health": previous_health or {},
        "previous_ids": frozenset(previous_ids), "now": now.timestamp() if hasattr(now, "timestamp") else now,
        "hard": frozenset(hard_topics),
    }


def _cluster(article, ctx):
    return ctx["cluster_of"].get(article["id"]) or {"id": article["id"], "n": 1, "leans": [], "size": 1}


def age_hours(article, ctx):
    t = _epoch(article.get("published_at"))
    return max(0.0, (ctx["now"] - t) / 3600) if t is not None and ctx["now"] is not None else STALE_H * 2


def fact_terms(article, ctx):
    """{term: points} for one candidate, facts only."""
    source = ctx["sources"].get(article["source_id"]) or {"id": article["source_id"]}
    cl = _cluster(article, ctx)
    body = ctx["body_chars"].get(article["id"], 0)
    complete = 6 if body >= FULL_BODY_CHARS else 3 if len(article.get("dek") or "") >= DEK_CHARS else 0
    return {
        "corroboration": min(36, round(12 * math.log2(cl["n"]))) if cl["n"] >= 2 else 0,
        "lean_span": 8 if len(cl["leans"]) >= 2 else 0,
        "original": 0 if is_syndicated_copy(article, source) else 10,
        "complete": complete,
        "health": -10 if failed_runs(article["source_id"], None, ctx["previous_health"]) >= 3 else 0,
        "paywall": -6 if source.get("paywall") and complete < 6 else 0,
        "hard": 10 if any(t in ctx["hard"] for t in article.get("topics", ())) else 0,
        "recency": round(20 * 2 ** (-age_hours(article, ctx) / 12)),
        "incumbent": 6 if article["id"] in ctx["previous_ids"] else 0,
    }


def est_bytes(article):
    """About what the article adds to pool.json: its compact record with the dek cut as
    published, plus RECORD_OVERHEAD for fields added later (has_body, story tiers)."""
    public = {k: v for k, v in article.items() if not k.startswith("_")}
    if len(public.get("dek") or "") > PUBLISHED_DEK_CHARS:
        public["dek"] = public["dek"][:PUBLISHED_DEK_CHARS]
    return len(json.dumps(public, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + RECORD_OVERHEAD


def _bucket(article, ctx):
    return (ctx["sources"].get(article["source_id"]) or {}).get("bucket") or "none"


def select_pool(candidates, ctx, budget, bucket_budget=None):
    """(ids in selection order, {id: why}) within `budget` bytes, and within each
    bucket's article count (`bucket_budget`, {bucket: articles}) during the fill; room a
    bucket cannot use goes to a last fill across all buckets.

    Floors first, each by score: FLOOR_PER_SOURCE per source among items STALE_H old or
    newer (the newest one when a source has none that fresh); for every two-sided story
    (two or more independent outlets over two or more lean buckets), its best version
    per lean bucket, up to STORY_LEAN_FLOOR; BUCKET_FLOOR per source bucket. Then a
    greedy fill by score under the ceilings, an extra version of a story already kept
    losing CLUSTER_EXTRA_PENALTY points per version before it."""
    seen_urls, cands = set(), []
    for a in sorted(candidates, key=lambda a: a["id"]):
        if a["url"] not in seen_urls:
            seen_urls.add(a["url"])
            cands.append(a)
    score = {a["id"]: sum(fact_terms(a, ctx).values()) for a in cands}
    order = sorted(cands, key=lambda a: (-score[a["id"]], -(_epoch(a.get("published_at")) or 0), a["id"]))
    size = {a["id"]: est_bytes(a) for a in cands}

    chosen, why = [], {}
    used = {"bytes": 0}
    per_source, per_group, per_cluster, per_bucket, per_lean = Counter(), Counter(), Counter(), Counter(), Counter()

    def fits(a, ceilings="all"):
        """ceilings: "all" for the fill, "source" for the story and bucket floors (the
        per-source and per-group ceilings only), "none" for the source floor."""
        if a["id"] in why or used["bytes"] + size[a["id"]] > budget:
            return False
        if ceilings == "none":
            return True
        if (per_source[a["source_id"]] >= SOURCE_CEIL
                or per_group[ctx["syndication"].get(a["source_id"], a["source_id"])] >= GROUP_CEIL):
            return False
        if ceilings == "source":
            return True
        n = len(chosen) + 1
        lean = ctx["lean"].get(a["source_id"])
        b = _bucket(a, ctx)
        if bucket_budget is not None and per_bucket[b] + 1 > bucket_budget.get(b, 0):
            return False
        return (per_cluster[_cluster(a, ctx)["id"]] < CLUSTER_CEIL
                and (lean in (None, "non-us") or (per_lean[lean] + 1) <= max(20, LEAN_SHARE_MAX * n)))

    def take(a, reason):
        why[a["id"]] = reason
        chosen.append(a["id"])
        used["bytes"] += size[a["id"]]
        per_source[a["source_id"]] += 1
        per_group[ctx["syndication"].get(a["source_id"], a["source_id"])] += 1
        per_cluster[_cluster(a, ctx)["id"]] += 1
        per_bucket[_bucket(a, ctx)] += 1
        lean = ctx["lean"].get(a["source_id"])
        if lean:
            per_lean[lean] += 1

    # Floor 1: every source.
    by_source = {}
    for a in order:
        by_source.setdefault(a["source_id"], []).append(a)
    for sid in sorted(by_source):
        items = by_source[sid]
        fresh = [a for a in items if age_hours(a, ctx) <= STALE_H]
        picks = fresh[:FLOOR_PER_SOURCE] or sorted(items, key=lambda a: (-(_epoch(a.get("published_at")) or 0), a["id"]))[:1]
        for a in picks:
            if fits(a, ceilings="none"):
                take(a, "floor_source")
    # Floor 2: both sides of every two-sided story.
    stories = {}
    for a in order:
        cl = _cluster(a, ctx)
        if cl["n"] >= 2 and len(cl["leans"]) >= 2:
            stories.setdefault(cl["id"], []).append(a)
    for cid in sorted(stories):
        have = {ctx["lean"].get(a["source_id"]) for a in stories[cid] if a["id"] in why}
        for a in stories[cid]:
            lean = ctx["lean"].get(a["source_id"])
            if len(have) >= STORY_LEAN_FLOOR:
                break
            if lean and lean not in have and fits(a, ceilings="source"):
                take(a, "floor_story")
                have.add(lean)
    # Floor 3: every bucket.
    by_bucket = {}
    for a in order:
        by_bucket.setdefault(_bucket(a, ctx), []).append(a)
    for b in sorted(by_bucket):
        for a in by_bucket[b]:
            if per_bucket[b] >= BUCKET_FLOOR:
                break
            if fits(a, ceilings="source"):
                take(a, "floor_bucket")
    def best_of(pool_items):
        """The best remaining item by score, an extra version of a kept story paying
        CLUSTER_EXTRA_PENALTY per version before it (pool_items is in score order)."""
        best, best_score = None, None
        for a in pool_items:
            sc = score[a["id"]] - CLUSTER_EXTRA_PENALTY * per_cluster[_cluster(a, ctx)["id"]]
            if best is None or sc > best_score:
                best, best_score = a, sc
            if score[a["id"]] < best_score:
                break  # nothing later can beat it
        return best

    # Fill 1: round the buckets in turn, each taking its best remaining item until it
    # has its count, so a bucket of quieter stories (Singapore, biotech) is never left
    # short because louder buckets spent the bytes first.
    if bucket_budget is not None:
        queues = {}
        for a in order:
            if a["id"] not in why:
                queues.setdefault(_bucket(a, ctx), []).append(a)
        # The next pick always goes to the bucket furthest from its count (lowest share
        # filled), so when the bytes run out the shortfall is spread across buckets.
        while True:
            open_ = [b for b in sorted(queues) if queues[b] and per_bucket[b] < bucket_budget.get(b, 0)]
            if not open_:
                break
            b = min(open_, key=lambda k: (per_bucket[k] / bucket_budget[k], k))
            a = best_of(queues[b])
            queues[b].remove(a)
            if fits(a):
                take(a, "fill")
        bucket_budget = None
    # Fill 2: whatever room is left, by score across all buckets.
    remaining = [a for a in order if a["id"] not in why]
    while remaining:
        a = best_of(remaining)
        remaining.remove(a)
        if fits(a):
            take(a, "fill")
    return chosen, why


def missed_count(dropped, ctx):
    """How many of a rule's previously dropped fresh single-outlet items are now in a
    story two or more independent outlets carry: news the rule cut that turned out to
    matter. No labels: the next hour's clusters say so."""
    return sum(1 for i in dropped if _cluster({"id": i}, ctx)["n"] >= 2)


def fresh_singletons(dropped_ids, ctx):
    """The dropped items the next run checks: single-outlet, MISSED_WINDOW_H or newer."""
    out = [i for i in sorted(dropped_ids)
           if _cluster(ctx["by_id"][i], ctx)["n"] < 2 and age_hours(ctx["by_id"][i], ctx) <= MISSED_WINDOW_H]
    return out[:MISSED_KEEP]


def compare(cap_ids, score_ids, why, candidates, ctx, previous_dropped=None):
    """The dist/select.json document: both rules, side by side, in counts; examples
    leave out anything a watch search found (the reader's own searches)."""
    by_id = ctx["by_id"]
    cap, new = [i for i in cap_ids if i in by_id], [i for i in score_ids if i in by_id]
    cap_set, new_set = set(cap), set(new)
    all_ids = {a["id"] for a in candidates}

    def stats(ids):
        arts = [by_id[i] for i in ids]
        ages = sorted(age_hours(a, ctx) for a in arts)
        sg = sum(1 for a in arts if "singapore" in a.get("topics", ()))
        sg_outlets = sum(1 for a in arts if _bucket(a, ctx) == "singapore")
        return {
            "kept": len(arts), "bytes": sum(est_bytes(a) for a in arts),
            "over_36h": sum(1 for x in ages if x > STALE_H),
            "median_h": round(ages[len(ages) // 2], 1) if ages else None,
            "corroborated": sum(1 for a in arts if _cluster(a, ctx)["n"] >= 2),
            "singapore": {"tag": sg, "outlets": sg_outlets},
            "max_per_source": max(Counter(a["source_id"] for a in arts).values(), default=0),
        }

    def example(i):
        a = by_id[i]
        return {"id": i, "title": a.get("title", "")[:160], "source_id": a["source_id"],
                "age_h": round(age_hours(a, ctx), 1), "terms": fact_terms(a, ctx), "why": why.get(i, "")}

    only_new = sorted(new_set - cap_set, key=lambda i: -sum(fact_terms(by_id[i], ctx).values()))
    only_cap = sorted(cap_set - new_set, key=lambda i: sum(fact_terms(by_id[i], ctx).values()))
    buckets = sorted({_bucket(by_id[i], ctx) for i in cap_set | new_set})
    leans = sorted({ctx["lean"].get(by_id[i]["source_id"]) or "unrated" for i in cap_set | new_set})
    sources_total = len({a["source_id"] for a in candidates})
    prev = previous_dropped or {}
    missed = ({"status": "first_run"} if not prev else
              {"status": "ok", "checked": {k: len(prev.get(k, [])) for k in ("cap", "score")},
               "cap": missed_count(prev.get("cap", []), ctx), "score": missed_count(prev.get("score", []), ctx)})
    doc = {
        "schema_version": SCHEMA_VERSION,
        "mode": "shadow",
        "state": "ok",
        "candidates": len(all_ids),
        "rules": {"cap": stats(cap), "score": stats(new)},
        "differ": {"only_cap": len(cap_set - new_set), "only_score": len(new_set - cap_set)},
        "floors": {
            "sources_met": len({by_id[i]["source_id"] for i in new}), "sources_total": sources_total,
            "stories": sum(1 for i in new if why.get(i) == "floor_story"),
            "buckets_unmet": sorted(b for b in {_bucket(a, ctx) for a in candidates}
                                    if sum(1 for i in new if _bucket(by_id[i], ctx) == b)
                                    < min(BUCKET_FLOOR, sum(1 for a in candidates if _bucket(a, ctx) == b))),
        },
        "buckets": {b: [sum(1 for i in cap if _bucket(by_id[i], ctx) == b),
                        sum(1 for i in new if _bucket(by_id[i], ctx) == b)] for b in buckets},
        "lean": {l: [sum(1 for i in cap if (ctx["lean"].get(by_id[i]["source_id"]) or "unrated") == l),
                     sum(1 for i in new if (ctx["lean"].get(by_id[i]["source_id"]) or "unrated") == l)] for l in leans},
        "missed": missed,
        "examples": {
            "only_score": [example(i) for i in only_new if not by_id[i].get("watch")][:EXAMPLES],
            "only_cap": [example(i) for i in only_cap if not by_id[i].get("watch")][:EXAMPLES],
        },
    }
    return doc


def run_shadow(candidates, cap_ids, ctx, previous_dropped=None):
    """(doc, dropped) for this run: the trial's report, and the fresh single-outlet items
    each rule dropped, which the next run checks for the missed-stories count."""
    kept = [ctx["by_id"][i] for i in cap_ids if i in ctx["by_id"]]
    budget = int(sum(est_bytes(a) for a in kept) * SIZE_MARGIN)
    bucket_budget = Counter(_bucket(a, ctx) for a in kept)
    score_ids, why = select_pool(candidates, ctx, budget, dict(bucket_budget))
    doc = compare(cap_ids, score_ids, why, candidates, ctx, previous_dropped)
    doc["budget_bytes"] = budget
    doc["_score_ids"] = score_ids  # J27: taken out by the caller, never written
    all_ids = {a["id"] for a in candidates}
    dropped = {"cap": fresh_singletons(all_ids - set(cap_ids), ctx),
               "score": fresh_singletons(all_ids - set(score_ids), ctx)}
    return doc, dropped


def log_line(doc):
    """One line of counts for the public run log: nothing about the reader."""
    if doc.get("state") != "ok":
        return f"select shadow: state={doc.get('state')}"
    c, s = doc["rules"]["cap"], doc["rules"]["score"]
    m = doc["missed"]
    missed = f"{m['cap']}/{m['score']}" if m.get("status") == "ok" else "first_run"
    return (f"select shadow: kept={c['kept']}/{s['kept']} differ={doc['differ']['only_score']} "
            f"stale={c['over_36h']}/{s['over_36h']} corroborated={c['corroborated']}/{s['corroborated']} "
            f"missed={missed}")


# --- J26: the reserve ------------------------------------------------------------------
# The best articles the pool did not keep, from the last RESERVE_HOURS, written as one
# small file per topic tag beside the pool (dist/reserve/<tag>.json) with an index. The
# phone loads a topic's file when the owner raises that topic (a Boost, the Ask bar, the
# You tab), merges it into the page's own pool and re-ranks, so "more Singapore" can show
# Singapore stories the hourly cut left out, at once, with no new fetch. Facts only, as
# the keep rule: which ones the owner sees is decided on the phone by their own profile.
RESERVE_HOURS = 48
RESERVE_PER_SOURCE = 25
RESERVE_PER_SHARD = 300
RESERVE_DEK_CHARS = 160
RESERVE_FIELDS = ("id", "source_id", "title", "url", "published_at", "topics", "geo")


def _cut(text, n):
    text = " ".join(str(text or "").split())
    if len(text) <= n:
        return text
    cut = text[:n + 1]
    return (cut.rsplit(" ", 1)[0] if " " in cut else text[:n]).rstrip()


def reserve_shards(ctx, published_ids, published_urls=frozenset()):
    """{tag: [record, ...]} for the reserve: candidates not published (by id or url), no
    watch-only item, RESERVE_HOURS old or newer, at most RESERVE_PER_SOURCE per source,
    best fact score first, each in the shard of every topic tag it carries, at most
    RESERVE_PER_SHARD per shard."""
    pool = [a for a in ctx["by_id"].values()
            if a["id"] not in published_ids and a["url"] not in published_urls and not a.get("_watch_only")
            and a.get("topics") and age_hours(a, ctx) <= RESERVE_HOURS]
    score = {a["id"]: sum(fact_terms(a, ctx).values()) for a in pool}
    pool.sort(key=lambda a: (-score[a["id"]], -(_epoch(a.get("published_at")) or 0), a["id"]))
    per_source, shards, seen_urls = Counter(), {}, set()
    for a in pool:
        if per_source[a["source_id"]] >= RESERVE_PER_SOURCE or a["url"] in seen_urls:
            continue
        per_source[a["source_id"]] += 1
        seen_urls.add(a["url"])
        record = {k: a[k] for k in RESERVE_FIELDS if k in a}
        if a.get("dek"):
            record["dek"] = _cut(a["dek"], RESERVE_DEK_CHARS)
        for tag in sorted(set(a["topics"])):
            shard = shards.setdefault(tag, [])
            if len(shard) < RESERVE_PER_SHARD:
                shard.append(record)
    return shards


def write_reserve(shards, out_dir, generated_at):
    """Writes out_dir/reserve/<tag>.json and index.json; returns the index. A tag is a
    topics.json id (lowercase letters, digits, underscores), so it is a safe file name;
    anything else is skipped."""
    import re
    from pathlib import Path
    root = Path(out_dir) / "reserve"
    root.mkdir(parents=True, exist_ok=True)
    for old in root.glob("*.json"):
        old.unlink()
    counts = {}
    for tag, records in sorted(shards.items()):
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,40}", tag):
            continue
        (root / f"{tag}.json").write_text(json.dumps({"schema_version": 1, "generated_at": generated_at, "tag": tag,
                                                      "articles": records}, ensure_ascii=False, separators=(",", ":")),
                                          encoding="utf-8")
        counts[tag] = len(records)
    index = {"schema_version": 1, "generated_at": generated_at, "shards": counts}
    (root / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    return index


# --- J27: going live on its own --------------------------------------------------------
# The owner approved switching to the keep rule once a week of this trial shows it is at
# least as good. Every run adds one small summary to state.json (history_entry); each
# run then reads the last GATE_DAYS of them (gate) and the keep rule chooses the pool
# while they pass, the old rule while they do not. SELECT_MODE=cap (a repository
# variable) holds the old rule whatever the trial says; SELECT_MODE=score forces the new.
GATE_DAYS = 7
GATE_MIN_RUNS = 84  # half of a week's hourly runs; the scheduler sometimes skips hours
GATE_FLOORS_SHARE = 0.95
HISTORY_DAYS = 8
MODES = ("auto", "cap", "score")


def history_entry(doc):
    """This run's line for the gate, or None when the trial did not run."""
    if not isinstance(doc, dict) or doc.get("state") != "ok":
        return None
    cap, new = doc["rules"]["cap"], doc["rules"]["score"]
    m = doc.get("missed") or {}
    f = doc.get("floors") or {}
    return {
        "at": doc.get("generated_at", ""),
        "floors": f.get("sources_met", 0) >= f.get("sources_total", 0) and not f.get("buckets_unmet"),
        "missed": [m.get("cap"), m.get("score")] if m.get("status") == "ok" else None,
        "sg": [cap["singapore"]["tag"], new["singapore"]["tag"]],
        "stale": [cap["over_36h"], new["over_36h"]],
        "budget": new["bytes"] <= doc.get("budget_bytes", new["bytes"]),
    }


def trim_history(history, now_ts):
    return [h for h in history if (_epoch(h.get("at")) or 0) >= now_ts - HISTORY_DAYS * 86400]


def gate(history, now_ts):
    """{"pass", "days", "runs", "checks": [{key, label, detail, ok}]}: whether the last
    GATE_DAYS of the trial show the keep rule at least as good as the old one."""
    times = [t for t in (_epoch(h.get("at")) for h in history) if t is not None]
    window = [h for h in history if (_epoch(h.get("at")) or 0) >= now_ts - GATE_DAYS * 86400]
    days = round((now_ts - min(times)) / 86400, 1) if times else 0.0
    missed = [h["missed"] for h in window if h.get("missed") and None not in h["missed"]]
    floors_share = sum(1 for h in window if h.get("floors")) / len(window) if window else 0.0
    mean = lambda rows, i: sum(r[i] for r in rows) / len(rows) if rows else 0.0  # noqa: E731
    sg = [h["sg"] for h in window if h.get("sg")]
    stale = [h["stale"] for h in window if h.get("stale")]
    checks = [
        {"key": "week", "label": "A full week of trial runs",
         "detail": f"{days} of {GATE_DAYS} days, {len(window)} runs (at least {GATE_MIN_RUNS})",
         "ok": days >= GATE_DAYS and len(window) >= GATE_MIN_RUNS},
        {"key": "floors", "label": "Every outlet and outlet group kept",
         "detail": f"in {round(100 * floors_share)}% of runs (at least {round(100 * GATE_FLOORS_SHARE)}%)",
         "ok": floors_share >= GATE_FLOORS_SHARE},
        {"key": "budget", "label": "Never bigger than today's pool",
         "detail": "every run" if all(h.get("budget", True) for h in window) else "some runs went over",
         "ok": all(h.get("budget", True) for h in window)},
        {"key": "missed", "label": "Misses no more stories than today's rule",
         "detail": f"{sum(m[1] for m in missed)} vs {sum(m[0] for m in missed)} over {len(missed)} runs",
         "ok": bool(missed) and sum(m[1] for m in missed) <= sum(m[0] for m in missed)},
        {"key": "singapore", "label": "At least as many Singapore stories",
         "detail": f"{mean(sg, 1):.1f} vs {mean(sg, 0):.1f} a run", "ok": bool(sg) and mean(sg, 1) >= mean(sg, 0)},
        {"key": "fresh", "label": "No more old articles (over 36 hours)",
         "detail": f"{mean(stale, 1):.1f} vs {mean(stale, 0):.1f} a run", "ok": bool(stale) and mean(stale, 1) <= mean(stale, 0)},
    ]
    return {"pass": all(c["ok"] for c in checks), "days": days, "runs": len(window), "checks": checks}


def decide(mode, history, now_ts):
    """(live, why) for this run: SELECT_MODE, then the gate."""
    mode = mode if mode in MODES else "auto"
    if mode == "cap":
        return False, "held"
    if mode == "score":
        return True, "forced"
    return (True, "gate") if gate(history, now_ts)["pass"] else (False, "trial")
