"""F6: run-to-run state cache, standard library only (R30).

Cloudflare Access is about to block the fetcher's read of the previously published
pool.json (fetcher.health.fetch_previous_pool), the one read S06 (source health
counters) and S32 (event hold state) both depend on to carry state forward between
hourly runs. This module gives every run a second, Access-proof path for that same
state: a small state.json this run writes, restored by actions/cache at the start of
the next run's job (.github/workflows/publish.yml), read before the network is ever
touched.

state.json is a strict, closed subset of pool.json's own shape: schema_version,
generated_at, source_health, and only the parts of clusters/events S32's id matching
needs (id and article_ids for a cluster; id, cluster_ids and live for an event, plus
live_since when it is live). No article text, title, dek, url or count ever enters it.
Because that subset lines up with what fetcher.health.parse_previous_health and
fetcher.events.parse_previous_events already read out of a full pool document, a
validated state.json can be handed to both, unchanged.

Reading order, decided here since the brief leaves it to the fetcher:
1. The state.json actions/cache restored locally this job (load_state). Fastest, and
   the only path once Access blocks the live pool read.
2. Absent (first run, evicted cache) or corrupt (fails validate_state): fall back to
   the live pool.json read fetcher.health has always done.
3. That fallback unreachable, absent, or not a valid pool (an Access login page, for
   instance): every counter starts fresh, same as today, and the reason lands in
   counts.previous_pool_status, now with the extra value "cache" for path 1.
"""
import json
from pathlib import Path

from fetcher.health import HEALTH_ENTRY_FIELDS

SCHEMA_VERSION = 1
DEFAULT_STATE_PATH = ".cache/state.json"

STATE_FIELDS = frozenset({"schema_version", "generated_at", "source_health", "clusters", "events"})
CLUSTER_FIELDS = frozenset({"id", "article_ids"})
EVENT_REQUIRED_FIELDS = frozenset({"id", "cluster_ids", "live"})
EVENT_ALL_FIELDS = EVENT_REQUIRED_FIELDS | {"live_since"}


def _state_event(e):
    out = {"id": e["id"], "cluster_ids": list(e["cluster_ids"]), "live": bool(e["live"])}
    if e.get("live_since"):
        out["live_since"] = e["live_since"]
    return out


def build_state(pool):
    """The next run's input, built from this run's own freshly published pool.
    Pure: no network, no clock, no filesystem. Only what S06 and S32 read back
    (fetcher.health.parse_previous_health, fetcher.events.parse_previous_events)
    survives; everything else in pool.json is dropped."""
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": pool["generated_at"],
        "source_health": pool["source_health"],
        "clusters": [
            {"id": c["id"], "article_ids": list(c["article_ids"])} for c in pool["clusters"]
        ],
        "events": [_state_event(e) for e in pool["events"]],
    }


def dumps_state(state):
    return json.dumps(state, ensure_ascii=False, separators=(",", ":"))


def validate_state(doc):
    """Return a list of error strings; empty means valid. Never raises: a
    malformed doc (wrong type anywhere) is reported, not thrown, so a corrupt
    cache entry can always be turned into a clean "corrupt" status by the
    caller instead of crashing the run."""
    if not isinstance(doc, dict):
        return ["state: not an object"]
    errors = []
    unknown = set(doc) - STATE_FIELDS
    missing = STATE_FIELDS - set(doc)
    if unknown:
        errors.append(f"state: unknown field(s) {sorted(unknown)}")
    if missing:
        errors.append(f"state: missing field(s) {sorted(missing)}")
        return errors  # nothing further to check without the required shape

    if doc["schema_version"] != SCHEMA_VERSION:
        errors.append(f"state.schema_version: expected {SCHEMA_VERSION}")
    if not isinstance(doc["generated_at"], str) or not doc["generated_at"]:
        errors.append("state.generated_at: must be a non-empty string")

    health = doc["source_health"]
    if not isinstance(health, dict):
        errors.append("state.source_health: must be an object")
    else:
        for sid, entry in health.items():
            if not isinstance(entry, dict) or any(f not in entry for f in HEALTH_ENTRY_FIELDS):
                errors.append(f"state.source_health[{sid!r}]: missing a required field")

    clusters = doc["clusters"]
    if not isinstance(clusters, list):
        errors.append("state.clusters: must be an array")
    else:
        for i, c in enumerate(clusters):
            if not isinstance(c, dict) or not CLUSTER_FIELDS <= set(c):
                errors.append(f"state.clusters[{i}]: must have id and article_ids")

    events = doc["events"]
    if not isinstance(events, list):
        errors.append("state.events: must be an array")
    else:
        for i, e in enumerate(events):
            if not isinstance(e, dict) or not EVENT_REQUIRED_FIELDS <= set(e):
                errors.append(f"state.events[{i}]: must have id, cluster_ids and live")
            elif not set(e) <= EVENT_ALL_FIELDS:
                errors.append(f"state.events[{i}]: unknown field(s) {sorted(set(e) - EVENT_ALL_FIELDS)}")
    return errors


def load_state(path):
    """Read and validate the state.json actions/cache restored locally, if any.

    Returns (bytes_or_None, status): "hit" (valid, bytes returned), "absent" (no
    file: first run, or an evicted cache), or "corrupt" (a file is there but is not
    valid JSON, or fails validate_state). Never raises, the same tolerate-everything
    contract fetcher.health.fetch_previous_pool already has, so a bad cache entry
    can never fail the run, only fall through to the next source of state.
    """
    p = Path(path)
    if not p.exists():
        return None, "absent"
    try:
        data = p.read_bytes()
        doc = json.loads(data)
    except (OSError, ValueError, UnicodeDecodeError):
        return None, "corrupt"
    if validate_state(doc):
        return None, "corrupt"
    return data, "hit"


def write_state(pool, path=DEFAULT_STATE_PATH):
    """Write this run's state.json for actions/cache to pick up and restore ahead of
    the next run. Returns the bytes written."""
    body = dumps_state(build_state(pool)).encode("utf-8")
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(body)
    return body
