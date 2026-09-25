"""H5: the pool tests/browser/tabs_cls.mjs needs to check the Live panel's other-side
links every time, not only on the runs where the real pool happens to put Today's
other-side story inside the live event (H4 saw it once, as a "lists" failure).

Takes any built-from pool (a real fanout's, say), runs the default profile's ranker the
way the build does, and adds the cluster that carries Today's other-side link to the live
event's own clusters (the first live event, or the first eligible one, made live). Every
other field is left as it came. Prints JSON to stdout:

    python tests/browser/fixtures/live_other_side_pool.py dist/pool.json > /tmp/lo_pool.json
    python -m app.build --pool /tmp/lo_pool.json --out /tmp/dist_lo
    node tests/browser/tabs_cls.mjs /tmp/dist_lo

Exits 1 when the pool has no story with an other-side link or no event to hold it.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # the repo root, for app.*

from app.frontpage import run_ranker  # noqa: E402


def main(path):
    with open(path, encoding="utf-8") as f:
        pool = json.load(f)
    ranking = run_ranker(pool)
    other = next((r["id"] for r in ranking["ranked"] if r.get("other_side")), None)
    events = pool.get("events") or []
    event = next((e for e in events if e.get("live")), None) or next((e for e in events if e.get("eligible")), None)
    if other is None or event is None:
        print(f"no other-side story ({other}) or no event ({event and event['id']}) in {path}", file=sys.stderr)
        return 1
    event["live"] = True
    if other not in event["cluster_ids"]:
        event["cluster_ids"] = [*event["cluster_ids"], other]
    for e in events:
        if e is not event:
            e["live"] = False
    print(f"live event {event['id']} now holds {other}, Today's other-side story", file=sys.stderr)
    json.dump(pool, sys.stdout)  # ASCII, so any console encoding takes it
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
