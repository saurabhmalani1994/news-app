"""U2: the source catalog the You page's source picker reads (dist/source-catalog.json).

One record per source in the pool (the pool lists every configured source, whatever this
run's outcome), with the repo-owned facts from sources.json the picker shows: bucket
(its region group), lean and ownership (R10), plus a one-word health state from the
pool's own source_health (S06). Nothing personal: which sources are on or off lives in
the device profile's mutes.sources, never here.

Built once per build, precached with the app shell (app/serviceworker.py), so the
picker works offline.
"""
import json
from pathlib import Path

from app.frontpage import SOURCES_JSON

ERROR_STATES = ("http_error", "timeout", "parse_error")


def _meta(sources_path):
    try:
        data = json.loads(Path(sources_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {s["id"]: s for s in data.get("sources", []) if isinstance(s, dict) and s.get("id")}


def health_word(entry):
    """ok, empty, failing, down or unknown: the picker's small health state. down is
    the fetcher's own unhealthy flag (a persistent problem); failing is an error this
    run that has not yet reached it."""
    if not entry:
        return "unknown"
    if entry.get("unhealthy"):
        return "down"
    state = entry.get("state")
    if state in ERROR_STATES:
        return "failing"
    return state if state in ("ok", "empty") else "unknown"


def catalog(pool, sources_path=SOURCES_JSON):
    meta = _meta(sources_path)
    health = pool.get("source_health") or {}
    rows = []
    for source in pool.get("sources", []):
        sid = source["id"]
        extra = meta.get(sid, {})
        row = {"id": sid, "name": source.get("name") or extra.get("name") or sid,
               "bucket": extra.get("bucket", ""), "lean": extra.get("lean", ""),
               "health": health_word(health.get(sid))}
        if extra.get("ownership"):
            row["ownership"] = extra["ownership"]
        rows.append(row)
    rows.sort(key=lambda r: (r["bucket"], r["name"].lower(), r["id"]))
    return {"generated_at": pool.get("generated_at"), "sources": rows}


def write(pool, out: Path, sources_path=SOURCES_JSON) -> Path:
    path = out / "source-catalog.json"
    text = json.dumps(catalog(pool, sources_path), ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return path
