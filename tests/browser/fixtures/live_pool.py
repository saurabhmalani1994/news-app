"""H8: a pool with a Live tab, every time, for tests/browser/h8_layout_check.mjs.

The owner's phone showed the layout regression on a morning with a live event, a chrome
state (a sixth tab, the red dot) that a pool with no live event never reaches. Takes any
real pool and makes one event live: the one the pool already marked live, else the first
eligible one, else the first. Every other event is set not live; nothing else changes.

    python tests/browser/fixtures/live_pool.py dist/pool.json > /tmp/live_pool.json
    python -m app.build --pool /tmp/live_pool.json --out /tmp/dist_live
    node tests/browser/h8_layout_check.mjs /tmp/dist_live

Exits 1 when the pool has no event at all.
"""
import json
import sys


def main(path):
    with open(path, encoding="utf-8") as f:
        pool = json.load(f)
    events = pool.get("events") or []
    event = (next((e for e in events if e.get("live")), None)
             or next((e for e in events if e.get("eligible")), None)
             or (events[0] if events else None))
    if event is None:
        print(f"no event in {path} to make live", file=sys.stderr)
        return 1
    for e in events:
        e["live"] = e is event
    event["eligible"] = True
    print(f"live event {event['id']} ({event.get('label')})", file=sys.stderr)
    json.dump(pool, sys.stdout)  # ASCII, so any console encoding takes it
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
