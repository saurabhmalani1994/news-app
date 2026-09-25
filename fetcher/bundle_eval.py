"""B1: the measuring stick for story bundles. Standard library only (R30).

Scores a clustering against a hand-labeled gold fixture (tests/fixtures/bundles/). Each
fixture article carries a `story` (the same development within 48 h; an explainer pegged
to it counts, standalone analysis of a theme does not) and an `event` (S32's umbrella, such
as the Trump-Xi summit). A clustering is a list of article-id lists, as
fetcher.cluster.cluster_items returns them; an article in no cluster stands alone.

Metrics (DESIGN-bundles section 2, "Evaluation plan"):
- pair_precision, pair_recall: over cross-outlet pairs only (two different source_ids).
  Precision is the share of co-clustered cross-outlet pairs that are one story; recall is
  the share of same-story cross-outlet pairs that were co-clustered.
- purity: the share of clusters (2+ articles) whose articles are all one story.
- bcubed_precision, bcubed_recall, bcubed_f1: per-article B-cubed, averaged over every
  article, singletons included, so a regression anywhere moves it.
An empty denominator scores 1.0 (nothing claimed, nothing wrong); the counts beside each
metric show when that happened.

Nothing here runs in the publish path; it is read by tests and by the labeler.

B7: the current clusterer includes the embedding term, so run_s07 takes the fixtures'
committed vectors (tests/fixtures/bundles/embeddings_*.json, load_fixture_vectors);
without them it is B2's lexical clusterer, byte for byte.

Usage:
  python -m fetcher.bundle_eval score tests/fixtures/bundles/gold_2026-09-24.json
  python -m fetcher.bundle_eval spotcheck tests/fixtures/bundles/gold_2026-09-24.json
  python -m fetcher.bundle_eval sample candidates.json --out draft.json [--seed N]
"""
import argparse
import json
import random
import sys
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path

from fetcher.cluster import cluster_items
from fetcher.embed import decode

METRICS = ("pair_precision", "pair_recall", "purity",
           "bcubed_precision", "bcubed_recall", "bcubed_f1")
STORY_SPAN_HOURS = 48
FLOOR_DECIMALS = 4
SAMPLE_GROUPS = 20
SAMPLE_SINGLETONS = 50
SPOT_CHECK_SHARE = 0.10
ARTICLE_FIELDS = ("id", "source_id", "published_at", "title", "dek", "s07_cluster",
                  "story", "event")


class FixtureError(ValueError):
    """A gold fixture breaks its own shape or the labeling rule."""


def _ratio(num, den):
    return num / den if den else 1.0


def _clusters_by_article(article_ids, clusters):
    """{article id: frozenset of its cluster}, singletons for unclustered articles."""
    known = set(article_ids)
    member_of = {}
    for cl in clusters:
        group = frozenset(cl)
        if len(group) != len(cl):
            raise ValueError(f"cluster lists an article twice: {sorted(cl)}")
        for i in group:
            if i not in known:
                raise ValueError(f"cluster names an article not in the fixture: {i}")
            if i in member_of:
                raise ValueError(f"article {i} is in two clusters")
            member_of[i] = group
    for i in article_ids:
        member_of.setdefault(i, frozenset([i]))
    return member_of


def score(articles, clusters):
    """Score `clusters` (lists of article ids) against the `story` labels of `articles`.

    Returns every name in METRICS plus the raw counts behind them.
    """
    ids = [a["id"] for a in articles]
    source = {a["id"]: a["source_id"] for a in articles}
    story = {a["id"]: a["story"] for a in articles}
    member_of = _clusters_by_article(ids, clusters)

    stories = {}
    for i in ids:
        stories.setdefault(story[i], set()).add(i)

    predicted = true_pos = 0
    multi = [c for c in clusters if len(c) >= 2]
    pure = 0
    for cl in multi:
        if len({story[i] for i in cl}) == 1:
            pure += 1
        for a, b in combinations(sorted(cl), 2):
            if source[a] != source[b]:
                predicted += 1
                true_pos += story[a] == story[b]
    gold = 0
    for members in stories.values():
        for a, b in combinations(sorted(members), 2):
            gold += source[a] != source[b]

    bp = br = 0.0
    for i in ids:
        mine = member_of[i]
        overlap = len(mine & stories[story[i]])
        bp += overlap / len(mine)
        br += overlap / len(stories[story[i]])
    n = len(ids)
    b_prec = bp / n if n else 1.0
    b_rec = br / n if n else 1.0
    b_f1 = 2 * b_prec * b_rec / (b_prec + b_rec) if b_prec + b_rec else 0.0
    return {
        "pair_precision": _ratio(true_pos, predicted),
        "pair_recall": _ratio(true_pos, gold),
        "purity": _ratio(pure, len(multi)),
        "bcubed_precision": b_prec,
        "bcubed_recall": b_rec,
        "bcubed_f1": b_f1,
        "articles": n,
        "stories": len(stories),
        "clusters": len(multi),
        "pure_clusters": pure,
        "predicted_pairs": predicted,
        "true_pairs": true_pos,
        "gold_pairs": gold,
        "missed_pairs": gold - true_pos,
    }


def split_stories(articles, clusters):
    """Misses, story by story, in section 1's terms: for each story with 2+ outlets, the
    articles outside the cluster that holds most of it, as (story, outside ids, how many of
    those stand alone). Stories held whole by one cluster are left out."""
    member_of = _clusters_by_article([a["id"] for a in articles], clusters)
    stories = {}
    for a in articles:
        stories.setdefault(a["story"], []).append(a)
    out = []
    for st, members in sorted(stories.items()):
        if len({a["source_id"] for a in members}) < 2:
            continue
        counts = {}
        for a in members:
            counts[member_of[a["id"]]] = counts.get(member_of[a["id"]], 0) + 1
        main = max(counts, key=lambda c: (counts[c], sorted(c)))
        outside = sorted(a["id"] for a in members if member_of[a["id"]] != main)
        if outside:
            alone = sum(1 for i in outside if len(member_of[i]) == 1)
            out.append((st, outside, alone))
    return out


def run_s07(articles, vectors=None):
    """The current S07 clusterer on the fixture's articles, as article-id lists. B7:
    vectors (load_fixture_vectors) add the embedding term; None is B2's lexical run."""
    return [cl["article_ids"] for cl in cluster_items(articles, vectors=vectors)]


VECTORS_GLOB = "embeddings_*.json"


def load_fixture_vectors(directory=None):
    """{article id: vector} from every committed embeddings file beside the fixtures, or
    {} when there is none."""
    directory = Path(directory) if directory else Path(__file__).resolve().parent.parent / "tests/fixtures/bundles"
    out = {}
    for p in sorted(directory.glob(VECTORS_GLOB)):
        doc = json.loads(p.read_text(encoding="utf-8"))
        out.update({k: decode(v) for k, v in doc["items"].items()})
    return out


def stored_clusters(articles):
    """The clustering recorded in the fixture itself (`s07_cluster`, as the run published it)."""
    groups = {}
    for a in articles:
        if a.get("s07_cluster"):
            groups.setdefault(a["s07_cluster"], []).append(a["id"])
    return list(groups.values())


def floors_from(metrics):
    """Today's numbers rounded down, so the same clusterer always passes its own floor."""
    step = 10 ** FLOOR_DECIMALS
    return {m: int(metrics[m] * step) / step for m in METRICS}


def check_floors(metrics, floors):
    """Return (metric, value, floor) for every metric below its floor; empty means pass."""
    return [(m, metrics[m], floors[m]) for m in METRICS if m in floors and metrics[m] < floors[m]]


def _epoch(ts):
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def validate_fixture(fx):
    """Raise FixtureError when a fixture breaks its shape or the labeling rule."""
    arts = fx.get("articles")
    if not isinstance(arts, list) or not arts:
        raise FixtureError("fixture has no articles")
    seen, event_of, times = set(), {}, {}
    for a in arts:
        for f in ("id", "source_id", "published_at", "title", "story", "event"):
            if not isinstance(a.get(f), str) or not a[f]:
                raise FixtureError(f"article {a.get('id')!r} has no {f}")
        extra = set(a) - set(ARTICLE_FIELDS)
        if extra:
            raise FixtureError(f"article {a['id']} carries fields outside the fixture shape: {sorted(extra)}")
        if a["id"] in seen:
            raise FixtureError(f"duplicate article id {a['id']}")
        seen.add(a["id"])
        if event_of.setdefault(a["story"], a["event"]) != a["event"]:
            raise FixtureError(f"story {a['story']} sits in two events")
        times.setdefault(a["story"], []).append(_epoch(a["published_at"]))
    for st, ts in times.items():
        if max(ts) - min(ts) > STORY_SPAN_HOURS * 3600:
            raise FixtureError(f"story {st} spans more than {STORY_SPAN_HOURS} h")
    spot = fx.get("spot_check", {}).get("ids", [])
    missing = [i for i in spot if i not in seen]
    if missing:
        raise FixtureError(f"spot_check names unknown ids: {missing}")


def load_fixture(path):
    fx = json.loads(Path(path).read_text(encoding="utf-8"))
    validate_fixture(fx)
    return fx


def save_fixture(fx, path):
    """Write a fixture with one article per line, so a relabel reads as a small diff.
    Headlines stay verbatim; an em dash in one is stored as its JSON escape, so the file
    itself holds none."""
    lines = [f" {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}," for k, v in fx.items()
             if k != "articles"]
    arts = ",\n".join("  " + json.dumps(a, ensure_ascii=False) for a in fx["articles"])
    text = "{\n" + "\n".join(lines) + '\n "articles": [\n' + arts + "\n ]\n}\n"
    Path(path).write_text(text.replace("—", "\\u2014"), encoding="utf-8", newline="\n")


def spot_check_sample(articles, seed, share=SPOT_CHECK_SHARE):
    """The owner's spot-check list: `share` of the labels, half from articles that share a
    story with another article and half from articles that stand alone (so the check sees
    both kinds of call), each drawn with random.Random(seed) from id-sorted lists."""
    k = max(1, round(len(articles) * share))
    size = {}
    for a in articles:
        size[a["story"]] = size.get(a["story"], 0) + 1
    grouped = sorted(a["id"] for a in articles if size[a["story"]] > 1)
    alone = sorted(a["id"] for a in articles if size[a["story"]] == 1)
    rng = random.Random(seed)
    take_grouped = min(len(grouped), (k + 1) // 2)
    picked = rng.sample(grouped, take_grouped)
    picked += rng.sample(alone, min(len(alone), k - take_grouped))
    return sorted(picked)


def sample_candidates(dump, seed, groups=SAMPLE_GROUPS, singletons=SAMPLE_SINGLETONS):
    """From a candidate dump, every member of the `groups` largest S07 candidate groups plus
    `singletons` random unclustered candidates. Returns the draft fixture's article list,
    with story and event left empty for the labeler."""
    cands = dump["candidates"]
    by_group = {}
    for c in cands:
        if c.get("s07_cluster"):
            by_group.setdefault(c["s07_cluster"], []).append(c)
    largest = sorted(by_group, key=lambda g: (-len(by_group[g]), g))[:groups]
    picked = [c for g in largest for c in by_group[g]]
    alone = sorted((c for c in cands if not c.get("s07_cluster")), key=lambda c: c["id"])
    picked += random.Random(seed).sample(alone, min(singletons, len(alone)))
    return [{
        "id": c["id"], "source_id": c["source_id"], "published_at": c["published_at"],
        "title": c["title"], "dek": c.get("dek", ""), "s07_cluster": c.get("s07_cluster"),
        "story": "", "event": "",
    } for c in picked]


def _fmt(metrics):
    return (f"pair_precision={metrics['pair_precision']:.4f} pair_recall={metrics['pair_recall']:.4f} "
            f"purity={metrics['purity']:.4f} ({metrics['pure_clusters']}/{metrics['clusters']}) "
            f"bcubed P/R/F1={metrics['bcubed_precision']:.4f}/{metrics['bcubed_recall']:.4f}/"
            f"{metrics['bcubed_f1']:.4f} pairs predicted={metrics['predicted_pairs']} "
            f"true={metrics['true_pairs']} gold={metrics['gold_pairs']} missed={metrics['missed_pairs']}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("score", help="score the stored S07 clusters and a fresh S07 run")
    s.add_argument("fixture")
    c = sub.add_parser("spotcheck", help="print the owner's spot-check list")
    c.add_argument("fixture")
    c.add_argument("--draw", type=int, metavar="SEED",
                   help="first draw a fresh list with this seed and save it into the fixture")
    d = sub.add_parser("sample", help="draw a draft fixture from a candidate dump")
    d.add_argument("dump")
    d.add_argument("--out", required=True)
    d.add_argument("--seed", type=int, default=int(datetime.now(timezone.utc).strftime("%Y%m%d")))
    d.add_argument("--groups", type=int, default=SAMPLE_GROUPS)
    d.add_argument("--singletons", type=int, default=SAMPLE_SINGLETONS)
    args = ap.parse_args(argv)

    if args.cmd == "sample":
        dump = json.loads(Path(args.dump).read_text(encoding="utf-8"))
        arts = sample_candidates(dump, args.seed, args.groups, args.singletons)
        draft = {
            "fixture": Path(args.out).stem,
            "pool_generated_at": dump.get("generated_at"),
            "s07_cluster_scope": "pre-cap candidate groups (the whole run, before the per-source cap)",
            "sample": {"seed": args.seed, "largest_groups": args.groups,
                       "singletons": args.singletons},
            "articles": arts,
        }
        save_fixture(draft, args.out)
        print(f"wrote {len(arts)} articles to {args.out} (seed {args.seed})")
        return 0

    if args.cmd == "spotcheck" and args.draw is not None:
        fx = json.loads(Path(args.fixture).read_text(encoding="utf-8"))
        fx["spot_check"] = {"seed": args.draw, "method": "fetcher.bundle_eval.spot_check_sample",
                            "ids": spot_check_sample(fx["articles"], args.draw),
                            "owner_verdicts": {}}
        save_fixture(fx, args.fixture)
    fx = load_fixture(args.fixture)
    arts = fx["articles"]
    if args.cmd == "spotcheck":
        by_story = {}
        for a in arts:
            by_story.setdefault(a["story"], []).append(a)
        for i in fx["spot_check"]["ids"]:
            a = next(x for x in arts if x["id"] == i)
            mates = [m for m in by_story[a["story"]] if m["id"] != i]
            print(f"{a['id']} {a['source_id']}: {a['title']}")
            print(f"    story={a['story']} event={a['event']} with {len(mates)} other(s)")
            for m in mates:
                print(f"      - {m['source_id']}: {m['title']}")
        return 0

    runs = [("S07 re-run on fixture", run_s07(arts))]
    vectors = load_fixture_vectors(Path(args.fixture).parent)
    if any(a["id"] in vectors for a in arts):
        runs.append(("S07 re-run with the B7 embedding term", run_s07(arts, vectors)))
    stored = stored_clusters(arts)
    if stored:
        runs.insert(0, ("stored S07 clusters", stored))
    for name, clusters in runs:
        print(f"{name}: {_fmt(score(arts, clusters))}")
        split = split_stories(arts, clusters)
        outside = sum(len(o) for _, o, _ in split)
        alone = sum(n for _, _, n in split)
        print(f"    stories split {len(split)}; articles outside their story's main cluster "
              f"{outside} (alone {alone}, in another cluster {outside - alone})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
