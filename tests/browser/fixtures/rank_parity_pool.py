"""R2: the pool tests/browser/rerank_cls.mjs and standing_cls.mjs need so the per-event
repeat cap (H4) always acts on Today's top 12. That cap is the pass the device re-rank
once skipped (it never passed the pool's events), and a real pool only exercises it on
days when one event holds three of the top 12.

Takes any built-from pool (a real fanout's, say), runs the default profile's ranker the
way the build does, and puts a new event first in the pool's events holding the 2nd,
3rd and 4th of Today's first twelve (taken out of any other event, so this one owns
them). It is neither eligible nor live, so the Live tab is left as it came. Every other
field is left as it came. Prints JSON to stdout:

    python tests/browser/fixtures/rank_parity_pool.py dist/pool.json > /tmp/rp_pool.json
    python -m app.build --pool /tmp/rp_pool.json --out /tmp/dist_rp
    node tests/browser/rerank_cls.mjs /tmp/dist_rp
    node tests/browser/standing_cls.mjs /tmp/dist_rp

Exits 1 when the ranker, run again, does not move a card for this event or leaves
Today's order as it was without it (a later pass can put a moved card back).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # the repo root, for app.*

from app.frontpage import run_ranker  # noqa: E402

EVENT = {"id": "e_r2_cap", "label": "R2 repeat cap", "hype": 0, "eligible": False, "live": False,
         "hold_state": "none", "live_since": None}


def main(path):
    with open(path, encoding="utf-8") as f:
        pool = json.load(f)
    blind = [r["id"] for r in run_ranker(pool)["ranked"]]
    held = blind[1:4]
    events = pool.get("events") or []
    for e in events:
        e["cluster_ids"] = [c for c in e["cluster_ids"] if c not in held]
    pool["events"] = [{**EVENT, "cluster_ids": held}, *events]
    ranked = run_ranker(pool)["ranked"]
    moved = [r["id"] for r in ranked
             if any(p["pass"] == "repeat-cap" and EVENT["label"] in p["text"] and p["text"].startswith("Moved down")
                    for p in r["passes"])]
    if not moved or [r["id"] for r in ranked] == blind:
        print(f"the repeat cap leaves Today's order as it was for {held} in {path}", file=sys.stderr)
        return 1
    print(f"event {EVENT['id']} holds {held}; the repeat cap moves {moved} down", file=sys.stderr)
    json.dump(pool, sys.stdout)  # ASCII, so any console encoding takes it
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
