"""S06: per-source health across runs, standard library only (R30).

DESIGN-v1.1 section 8 says stale pool and dead-feed states surface in Health, but it
does not say where run-to-run counters live between cron invocations, or what
threshold marks a source unhealthy. Both are settled here since the doc is silent.

Run-to-run state: nothing survives inside the fetcher between cron invocations (each
run is a fresh Actions container), so this module reads the previously PUBLISHED
pool.json back off the live site at the start of every run and carries its
source_health block forward. The URL comes from an env var or workflow input
(PREVIOUS_POOL_URL), never hard-coded here, so only the workflow decides where the
live site is. A missing URL, an unreachable site, a 404 (nothing published yet), or
a pool from before this slice (no source_health block, or one that does not parse
into today's shape) are all tolerated: counters simply start at zero for every
source, and the fact is recorded in counts.previous_pool_status so a bad read is
itself visible in the ledger, never a failed run.

Unhealthy threshold, stated plainly since the design doc gives no number: three
consecutive transport or parse errors, or five consecutive empty responses, marks a
source unhealthy. Cadence is 30 to 60 minutes (R30), so three errors means a feed has
actually been down for 1.5 to 3 hours, and five empties gives a legitimately
low-frequency feed some slack before it gets flagged.
"""
import json
import socket
import urllib.error
import urllib.request

from fetcher.fetch import USER_AGENT

MAX_BYTES = 5_000_000
FETCH_TIMEOUT = 10

ERROR_STATES = frozenset({"http_error", "timeout", "parse_error"})
UNHEALTHY_CONSECUTIVE_ERROR = 3
UNHEALTHY_CONSECUTIVE_EMPTY = 5

HEALTH_ENTRY_FIELDS = (
    "state", "last_ok_at", "last_item_at", "consecutive_empty",
    "consecutive_error", "items_fetched", "unhealthy",
)

PREVIOUS_POOL_STATUSES = ("ok", "absent", "unreachable", "old_schema")


def fetch_previous_pool(url, timeout=FETCH_TIMEOUT):
    """Return (bytes_or_None, status) for the previously published pool.json. status
    is "ok" when bytes came back, else absent or unreachable. Never raises. S32 reads
    the same bytes for event hold state (fetcher.events), so the pool is fetched once."""
    if not url:
        return None, "absent"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read(MAX_BYTES + 1), "ok"
    except urllib.error.HTTPError as exc:
        return None, "absent" if exc.code == 404 else "unreachable"
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError):
        return None, "unreachable"


def fetch_previous_health(url, timeout=FETCH_TIMEOUT):
    """Return (entries, status) for the previous run's published source_health.

    entries maps source_id -> previous health entry, empty when unusable. status is
    one of PREVIOUS_POOL_STATUSES. Never raises: every failure mode degrades to a
    tolerated status instead, so a bad or absent previous pool can never fail the run.
    """
    data, status = fetch_previous_pool(url, timeout)
    if data is None:
        return {}, status
    return parse_previous_health(data)


def parse_previous_health(data):
    """Pure half of fetch_previous_health, split out so tests can feed it fixed
    bytes instead of a fake network call. Never raises."""
    try:
        doc = json.loads(data)
        entries = doc["source_health"]
        if not isinstance(entries, dict):
            raise ValueError("source_health is not an object")
        for entry in entries.values():
            if not isinstance(entry, dict) or any(f not in entry for f in HEALTH_ENTRY_FIELDS):
                raise ValueError("source_health entry missing a field")
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        return {}, "old_schema"
    return entries, "ok"


def _next_entry(prev, state, items_fetched, item_time, generated_at):
    """One source's next health entry. prev is its previous entry, or None the
    first time a source is ever seen (or when the previous pool was unusable)."""
    prev = prev or {}
    consecutive_empty = prev.get("consecutive_empty", 0) + 1 if state == "empty" else 0
    consecutive_error = prev.get("consecutive_error", 0) + 1 if state in ERROR_STATES else 0
    last_ok_at = generated_at if state == "ok" else prev.get("last_ok_at")
    last_item_at = item_time if (state == "ok" and item_time) else prev.get("last_item_at")
    unhealthy = (
        consecutive_error >= UNHEALTHY_CONSECUTIVE_ERROR
        or consecutive_empty >= UNHEALTHY_CONSECUTIVE_EMPTY
    )
    return {
        "state": state,
        "last_ok_at": last_ok_at,
        "last_item_at": last_item_at,
        "consecutive_empty": consecutive_empty,
        "consecutive_error": consecutive_error,
        "items_fetched": items_fetched,
        "unhealthy": unhealthy,
    }


def compute_source_health(sources, run_states, previous_entries, generated_at):
    """Build this run's source_health block. Pure: no network, no clock.

    run_states maps source_id -> (state, items_fetched, item_time_or_None), one
    entry per configured source; fanout.build_pool_fanout collects it while it
    already walks every source's fetch result. previous_entries is whatever
    fetch_previous_health returned; a source missing from it (new source, or the
    previous pool was unusable) starts at zero, same as a brand new feed.
    """
    previous_entries = previous_entries or {}
    health = {}
    for source in sources:
        sid = source["id"]
        state, items_fetched, item_time = run_states[sid]
        health[sid] = _next_entry(
            previous_entries.get(sid), state, items_fetched, item_time, generated_at,
        )
    return health
