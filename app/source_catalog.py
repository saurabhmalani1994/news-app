"""U2: the source catalog the You page's source picker reads (dist/source-catalog.json).

One record per source in the pool (the pool lists every configured source, whatever this
run's outcome), with the repo-owned facts from sources.json the picker shows: bucket
(its region group), lean and ownership (R10), plus a one-word health state from the
pool's own source_health (S06). Nothing personal: which sources are on or off lives in
the device profile's mutes.sources, never here.

L1: also each source's cited lean_basis, in a map of its own beside the rows (the rows
stay the picker's compact shape), for the lean sheet a tap on a lean marker opens, on
the front page and here. Only a source with a marker has a sheet, so only those carry
one. U3: every row carries its home country (sources.json `country`), and an outlet
outside the US scale shows it as its marker, so its sheet has a basis too.

Built once per build, precached with the app shell (app/serviceworker.py), so the
picker works offline.
"""
import json
from pathlib import Path

from app.frontpage import SOURCES_JSON
from app.lean import LEAN_SCALE, country_code

ERROR_STATES = ("http_error", "timeout", "parse_error")
# The leans a marker shows for (app/lean.py): the US scale and state media; any other
# source with a country shows that instead (U3).
SHEET_LEANS = LEAN_SCALE + ("state",)


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
        if country_code(extra.get("country")):
            row["country"] = extra["country"]
        rows.append(row)
    rows.sort(key=lambda r: (r["bucket"], r["name"].lower(), r["id"]))
    marked = [r for r in rows if r["lean"] in SHEET_LEANS or r.get("country")]
    basis = {r["id"]: meta[r["id"]]["lean_basis"] for r in marked
             if isinstance(meta.get(r["id"], {}).get("lean_basis"), str)}
    return {"generated_at": pool.get("generated_at"), "sources": rows, "lean_basis": dict(sorted(basis.items()))}


def write(pool, out: Path, sources_path=SOURCES_JSON) -> Path:
    path = out / "source-catalog.json"
    text = json.dumps(catalog(pool, sources_path), ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return path
