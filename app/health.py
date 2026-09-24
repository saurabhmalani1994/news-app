"""S17: the Health screen, reached from the You tab (profile.html). Renders the pool's
own ledger and per-source health as plain text, in the same static-HTML-at-build style
as app/build.py's front page: the data is embedded once, at build time, so the page
needs no runtime fetch and works offline exactly as well as any other cached page in
this app (there is no client pool cache yet, S18 covers the front page only).

Feed content is hostile input (R26): every source name is HTML-escaped, same as
app.build. The only number that must reflect the device's real clock rather than the
build's frozen one is the pool's own age (a stale cache is the whole point of this
screen), so that one line is finished by app/static/js/health-age.js, a classic,
synchronous script placed right where the line sits, the same zero-shift idiom
app/static/js/offline.js already uses for the front page (S18).

Stale threshold: the design doc names no number (DESIGN-v1.1 section 8 only says a
stale pool must surface). Cadence is 30 to 60 minutes (R30); fetcher/health.py already
settled on "3 times the cadence" as its own unhealthy threshold reasoning for a single
source. The same reasoning applied to the whole pool gives 3 hours: a legitimately
late run is not stale, a pool that has not moved in three cycles is.
"""
import html as _html
import json
import sys
from datetime import datetime
from pathlib import Path

from app.frontpage import source_buckets, source_names

STALE_THRESHOLD_SECONDS = 3 * 3600

# Fixed, closed key sets straight from contract/pool.schema.json, so a page renders
# every reason at zero rather than only the ones that happened to fire this run.
DROP_REASONS = ("no_title", "no_date", "bad_url", "duplicate_url", "over_cap")
FEED_STATE_KEYS = ("ok", "empty", "http_error", "timeout", "parse_error")
IMAGE_FOUND_KEYS = ("media_content", "media_thumbnail", "enclosure", "content_img")
IMAGE_REJECTED_KEYS = ("not_https", "data_uri", "tiny_pixel", "repeated_placeholder")
ERROR_STATES = ("http_error", "timeout", "parse_error")

# Mirrors app/static/js/standing.js's STATE_WORDS (S28), so the same state reads the
# same way whether it is named in a silence notice or on this screen.
STATE_WORDS = {
    "ok": "ok",
    "empty": "empty feed",
    "http_error": "HTTP errors",
    "timeout": "timing out",
    "parse_error": "unreadable feed",
    "unknown": "no health data yet",
}

DROP_LABELS = {
    "no_title": "No title",
    "no_date": "No date",
    "bad_url": "Bad URL",
    "duplicate_url": "Duplicate URL",
    "over_cap": "Over the per-source cap",
}
FEED_STATE_LABELS = {
    "ok": "Ok", "empty": "Empty", "http_error": "HTTP error",
    "timeout": "Timeout", "parse_error": "Parse error",
}
IMAGE_FOUND_LABELS = {
    "media_content": "media:content", "media_thumbnail": "media:thumbnail",
    "enclosure": "Enclosure", "content_img": "First <img> in content",
}
IMAGE_REJECTED_LABELS = {
    "not_https": "Not https", "data_uri": "Data URI",
    "tiny_pixel": "Tracking pixel", "repeated_placeholder": "Repeated placeholder",
}


def _parse_time(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def pool_age_seconds(pool, now):
    """Seconds between generated_at and now, or None when either is unreadable."""
    generated = _parse_time(pool.get("generated_at"))
    if generated is None or now is None:
        return None
    return (now - generated).total_seconds()


def is_stale(pool, now, threshold_seconds=STALE_THRESHOLD_SECONDS):
    age = pool_age_seconds(pool, now)
    return age is not None and age > threshold_seconds


def ledger_sections(counts):
    """The last run's ledger as (heading, [(label, value), ...]) sections, fixed-key
    blocks zero-filled so an absent reason still shows as 0, leniency left as whatever
    open keys the run actually reported (R9)."""
    counts = counts or {}
    drops = counts.get("drops") or {}
    sections = [
        ("Run totals", [("Fetched", counts.get("fetched", 0)), ("Published", counts.get("published", 0))]),
        ("Drops", [(DROP_LABELS[k], drops.get(k, 0)) for k in DROP_REASONS]),
    ]
    leniency = counts.get("leniency") or {}
    sections.append((
        "Leniency",
        [(k.replace("_", " ").capitalize(), v) for k, v in sorted(leniency.items())] or [("None applied", 0)],
    ))
    feed_states = counts.get("feed_states")
    if feed_states is not None:
        sections.append(("Feed outcomes", [(FEED_STATE_LABELS[k], feed_states.get(k, 0)) for k in FEED_STATE_KEYS]))
    images = counts.get("images")
    if images:
        found = images.get("found") or {}
        rejected = images.get("rejected") or {}
        sections.append(("Images found", [(IMAGE_FOUND_LABELS[k], found.get(k, 0)) for k in IMAGE_FOUND_KEYS]))
        sections.append(("Images rejected", [(IMAGE_REJECTED_LABELS[k], rejected.get(k, 0)) for k in IMAGE_REJECTED_KEYS]))
    return sections


def _fmt_time(value):
    parsed = _parse_time(value) if value else None
    return parsed.strftime("%d %b %H:%M UTC") if parsed else "never"


def feed_rows(pool, sources_path=None):
    """One row per source in the pool, every source exactly once (sources is the pool's
    own list, S05 writes one entry per configured source whatever its outcome). bucket
    comes from sources.json (repo owned, S08); an absent or unreadable file just leaves
    bucket blank rather than failing the page."""
    names = source_names(pool)
    kwargs = {} if sources_path is None else {"sources_path": sources_path}
    buckets = source_buckets(pool, **kwargs)
    health = pool.get("source_health") or {}
    rows = []
    for source in pool.get("sources", []):
        sid = source["id"]
        entry = health.get(sid)
        state = entry.get("state") if entry else "unknown"
        rows.append({
            "id": sid,
            "name": source.get("name") or names.get(sid, sid),
            "bucket": buckets.get(sid, ""),
            "state": state,
            "state_label": STATE_WORDS.get(state, state),
            "last_ok_at": _fmt_time(entry.get("last_ok_at") if entry else None),
            "last_item_at": _fmt_time(entry.get("last_item_at") if entry else None),
            "consecutive_empty": entry.get("consecutive_empty", 0) if entry else 0,
            "consecutive_error": entry.get("consecutive_error", 0) if entry else 0,
            "items_fetched": entry.get("items_fetched", 0) if entry else 0,
            "unhealthy": bool(entry and entry.get("unhealthy")),
            "failing": bool(entry and not entry.get("unhealthy") and state in ERROR_STATES),
        })
    return rows


def _sort_key(row):
    # 0: unhealthy (persistent problem), 1: failing this run but not yet unhealthy,
    # 2: everything else, grouped by bucket. Name breaks every tie so the order is the
    # same for the same pool every time.
    priority = 0 if row["unhealthy"] else 1 if row["failing"] else 2
    return (priority, row["bucket"] or "", row["name"].lower(), row["id"])


def sorted_feed_rows(pool, sources_path=None):
    """feed_rows, unhealthy first, then failing, then the rest grouped by bucket."""
    return sorted(feed_rows(pool, sources_path), key=_sort_key)


def _plural(n, word):
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def _counter_text(row):
    if row["consecutive_error"]:
        return f"{_plural(row['consecutive_error'], 'error')} in a row"
    if row["consecutive_empty"]:
        return f"{row['consecutive_empty']} empty in a row"
    if row["items_fetched"]:
        return f"{_plural(row['items_fetched'], 'item')} fetched"
    return ""


# ---------------------------------------------------------------------------
# Rendering. Same escape-everything discipline as app/build.py (R26): every source
# name, state word and label is plain text, never markup.
# ---------------------------------------------------------------------------

def _esc(value):
    return _html.escape(str(value), quote=False)


LEDGER_SECTION = """<section class="settings-section" aria-labelledby="ledger-{slug}-label">
<h2 class="settings-label" id="ledger-{slug}-label">{heading}</h2>
{rows}
</section>"""

LEDGER_ROW = ('<div class="setting-row"><div class="setting-row-text">'
              '<span class="setting-label">{label}</span></div>'
              '<span class="setting-value">{value}</span></div>')


def _render_ledger(counts):
    out = []
    for heading, rows in ledger_sections(counts):
        slug = heading.lower().replace(" ", "-")
        body = "\n".join(LEDGER_ROW.format(label=_esc(label), value=_esc(value)) for label, value in rows)
        out.append(LEDGER_SECTION.format(slug=slug, heading=_esc(heading), rows=body))
    return "\n".join(out)


SOURCE_ROW = ('<div class="setting-row health-source-row{mod}" data-source="{id}">'
              '<div class="setting-row-text">'
              '<span class="setting-label">{name}{badge}</span>'
              '<span class="setting-sublabel">{bucket_line}last ok {last_ok} {dot} last item {last_item}</span>'
              '</div>'
              '<div class="setting-row-text setting-row-text--end">'
              '<span class="setting-value">{state_label}</span>'
              '<span class="setting-sublabel">{counter}</span>'
              '</div></div>')

MIDDOT = chr(0x00B7)
BADGE = {"unhealthy": " · Unhealthy", "failing": " · Failing"}


def _render_sources(pool, sources_path=None):
    rows = sorted_feed_rows(pool, sources_path)
    out = []
    for row in rows:
        mod = " health-source-row--unhealthy" if row["unhealthy"] else " health-source-row--failing" if row["failing"] else ""
        badge = BADGE["unhealthy"] if row["unhealthy"] else BADGE["failing"] if row["failing"] else ""
        bucket_line = f"{_esc(row['bucket'])} {MIDDOT} " if row["bucket"] else ""
        out.append(SOURCE_ROW.format(
            mod=mod, id=_esc(row["id"]), name=_esc(row["name"]), badge=badge,
            bucket_line=bucket_line, last_ok=_esc(row["last_ok_at"]), dot=MIDDOT,
            last_item=_esc(row["last_item_at"]), state_label=_esc(row["state_label"]),
            counter=_esc(_counter_text(row)),
        ))
    return "\n".join(out)


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121212">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Almanac">
<title>Feed health - Almanac</title>
<link rel="preload" href="fonts/LibreFranklin-Medium-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="style.css">
<link rel="stylesheet" href="profile.css">
<script src="js/sw-register.js" defer></script>
</head>
<body>
<header class="masthead">
<a class="masthead-back" href="profile.html" aria-label="Back to profile">
<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg>
</a>
<h1 class="wordmark">Feed health</h1>
</header>
<main class="settings" id="health-root">
<section class="notice health-age-block" id="pool-age-block">
<p class="notice-kicker">Pool</p>
<p class="notice-head" id="pool-age" data-generated-at="{generated_at}">Updated {build_age}.</p>
<p class="notice-text">{summary_line}</p>
</section>
{ledger}
<section class="settings-section" aria-labelledby="sources-label">
<h2 class="settings-label" id="sources-label">Sources</h2>
<p class="settings-hint">Unhealthy and failing sources first, then the rest grouped by bucket.</p>
{sources}
</section>
</main>
<footer class="colophon"><p class="colophon-text">Read from the pool generated <time datetime="{generated_at}">{generated_label}</time>.</p></footer>
<script src="js/health-age.js"></script>
<nav class="bottom-nav bottom-nav--fixed" aria-label="Primary">
<a class="nav-item" href="index.html#home" data-screen="home"><svg class="nav-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3.2 2.6 11.3h2.8v9.5h5.1v-6h3v6h5.1v-9.5h2.8z"></path></svg><span class="nav-label">Home</span></a>
<a class="nav-item" href="index.html#following" data-screen="following"><svg class="nav-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 2.6 2.4 7.8 12 13l9.6-5.2zM4.7 11.2l-2.3 1.3L12 17.7l9.6-5.2-2.3-1.3L12 15.1zM4.7 15.9l-2.3 1.3L12 22.4l9.6-5.2-2.3-1.3L12 19.8z"></path></svg><span class="nav-label">Following</span></a>
<a class="nav-item" href="index.html#saved" data-screen="saved"><svg class="nav-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6.2 2.6h11.6c.5 0 .9.4.9.9v18.1L12 17.1l-6.7 4.5V3.5c0-.5.4-.9.9-.9z"></path></svg><span class="nav-label">Saved</span></a>
<a class="nav-item" href="profile.html" data-screen="you" aria-current="page"><svg class="nav-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 11.6a4.3 4.3 0 1 0 0-8.6 4.3 4.3 0 0 0 0 8.6zm0 2.1c-4.8 0-8.4 2.6-8.4 6.2v1.5h16.8v-1.5c0-3.6-3.6-6.2-8.4-6.2z"></path></svg><span class="nav-label">You</span></a>
</nav>
</body>
</html>"""


def _relative_age(seconds):
    if seconds is None:
        return "recently"
    minutes = max(0, int(seconds // 60))
    if minutes < 60:
        return f"{max(minutes, 1)}m ago"
    if minutes < 48 * 60:
        return f"{minutes // 60}h ago"
    return f"{minutes // (24 * 60)}d ago"


def render(pool, sources_path=None, now=None):
    """The Health screen for this pool. `now` defaults to the pool's own generated_at
    (build time has nothing else to compare against); js/health-age.js immediately
    replaces the age line with the device's real clock, before first paint, the same
    idiom js/offline.js uses (S18)."""
    generated_at = pool.get("generated_at", "")
    now = now or _parse_time(generated_at)
    age_seconds = pool_age_seconds(pool, now)
    counts = pool.get("counts") or {}
    unhealthy = sum(1 for r in feed_rows(pool, sources_path) if r["unhealthy"])
    failing = sum(1 for r in feed_rows(pool, sources_path) if r["failing"])
    total = len(pool.get("sources", []))
    bits = [f"{total} sources"]
    if unhealthy:
        bits.append(f"{unhealthy} unhealthy")
    if failing:
        bits.append(f"{failing} failing this run")
    previous_status = counts.get("previous_pool_status")
    if previous_status and previous_status != "ok":
        bits.append(f"previous pool {previous_status}")
    return PAGE.format(
        generated_at=_esc(generated_at),
        generated_label=_esc(_fmt_time(generated_at)),
        build_age=_esc(_relative_age(age_seconds)),
        summary_line=_esc(", ".join(bits) + "."),
        ledger=_render_ledger(counts),
        sources=_render_sources(pool, sources_path),
    )


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pool", default="dist/pool.json")
    ap.add_argument("--out", default="dist/health.html")
    args = ap.parse_args(argv)
    pool = json.loads(Path(args.pool).read_text(encoding="utf-8"))
    Path(args.out).write_text(render(pool), encoding="utf-8")
    print(f"built {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
