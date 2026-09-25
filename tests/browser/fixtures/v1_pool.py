"""R2: the pool tests/browser/v1_check.mjs needs for its 11-or-more-version strip, which
a real fetch only sometimes holds (H5's pool of 641 articles topped out at fewer).

Takes any built-from pool (a real fanout's, say) and, unless a cluster already has 11
or more, grows the largest cluster (by versions: one per outlet, a near-duplicate
group once, js/versions.js) to 12 versions by moving in single-article stories from
outlets it does not already have, newest first. Those articles leave the events that held them as stories of their own. The
cluster's independent_sources and lean_buckets are worked out again the fetcher's way
(fetcher/fanout.py _published_clusters, from sources.json). Every other field is left
as it came. Prints JSON to stdout:

    python tests/browser/fixtures/v1_pool.py dist/pool.json > /tmp/v1_pool.json
    python -m app.build --pool /tmp/v1_pool.json --out /tmp/dist_v1
    cp -r dist/bodies /tmp/dist_v1/bodies
    node tests/browser/v1_check.mjs /tmp/dist_v1

v1_check.mjs runs this itself on the dist it is given, so the steps above are only for
looking at the grown pool by hand.

Exits 1 when the pool has no multi-outlet cluster or too few outlets to reach 12.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))  # the repo root, for app.*

from app.frontpage import independent_source_count  # noqa: E402

VERSIONS = 12
WIDE = 11  # v1_check's "11-or-more-version strip"


def main(path):
    with open(path, encoding="utf-8") as f:
        pool = json.load(f)
    by_id = {a["id"]: a for a in pool["articles"]}
    sources = {s["id"]: s for s in json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))["sources"]}

    def versions(cluster):
        return independent_source_count([by_id[i] for i in cluster["article_ids"]], cluster.get("near_duplicates", []))

    clusters = [c for c in pool.get("clusters", []) if versions(c) > 1]
    if not clusters:
        print(f"no multi-outlet cluster in {path}", file=sys.stderr)
        return 1
    target = max(clusters, key=lambda c: (versions(c), len(c["article_ids"]), c["id"]))
    if versions(target) >= WIDE:
        print(f"unchanged: {target['id']} already has {versions(target)} versions", file=sys.stderr)
        json.dump(pool, sys.stdout)
        return 0
    clustered = {i for c in pool["clusters"] for i in c["article_ids"]}
    have = {by_id[i]["source_id"] for i in target["article_ids"]}
    singles = sorted((a for a in pool["articles"] if a["id"] not in clustered and a["source_id"] not in have),
                     key=lambda a: (a.get("published_at") or "", a["id"]), reverse=True)
    added = []
    for article in singles:
        if versions(target) >= VERSIONS:
            break
        if article["source_id"] in have:
            continue
        target["article_ids"].append(article["id"])
        have.add(article["source_id"])
        added.append(article["id"])
    if versions(target) < VERSIONS:
        print(f"only {versions(target)} versions reachable for {target['id']} in {path}", file=sys.stderr)
        return 1
    target["independent_sources"] = len({sources.get(s, {}).get("syndication_group") or s for s in have})
    target["lean_buckets"] = sorted({sources[s]["lean"] for s in have if s in sources and sources[s].get("lean")})
    moved = set(added)
    for event in pool.get("events") or []:
        event["cluster_ids"] = [c for c in event["cluster_ids"] if c not in moved]
    print(f"{target['id']} now has {versions(target)} versions ({len(added)} moved in)", file=sys.stderr)
    json.dump(pool, sys.stdout)  # ASCII, so any console encoding takes it
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
