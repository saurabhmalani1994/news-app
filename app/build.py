"""Build the Almanac static page: the front page in four tiers (S04), hero, secondary
lead blocks, river and text-only rows, styled with the design tokens (S03). Stories and
tiers come from app.frontpage; this module only turns them into markup.

Feed content is hostile input (R26): every field is HTML-escaped, so a title, dek,
source name or timestamp can only ever render as text, never a tag. A story link is
emitted only for an http or https url, so a javascript: or data: url never becomes an
href. Typographic quotes are applied here, at render time, never to the pool.
The stylesheet and fonts are app-owned static assets and carry no feed data.

Usage: python -m app.build --pool dist/pool.json --out dist
"""
import argparse
import json
import shutil
import sys
from datetime import datetime
from html import escape
from pathlib import Path
from urllib.parse import urlsplit

from app.dek import fit_dek
from app.frontpage import clean_dek, front_page
from app.typography import smart_quotes

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

# Preloaded because they paint above the fold: the headline serif and the meta sans.
# The dek's regular serif is not preloaded (40KB preload budget); its metric-matched
# fallback keeps the swap shift-free.
PRELOAD_FONTS = ("Newsreader-Bold-latin.woff2", "LibreFranklin-Medium-latin.woff2")

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121212">
<title>Almanac</title>
{preloads}
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="masthead"><h1 class="wordmark">Almanac</h1></header>
<main>
<ol class="river river--top" id="headlines">
{top}
</ol>
{more}
</main>
<footer class="colophon"><p class="colophon-text">{count} stories from {articles} articles. Updated <time datetime="{generated_at}">{updated}</time></p></footer>
</body>
</html>
"""

# Front page length (D1). The design doc sets no length, so the page ends the way NYT's
# Today does: a clear module break, a quiet label, a short run of text-only headlines,
# then an end. The rest of the pool stays one tap away in a native <details> (no
# script), laid out only when opened. Section tabs (S27) will split it further.
MORE_COUNT = 20

MORE = """<section class="module" aria-labelledby="more-label">
<h2 class="module-label" id="more-label">More headlines</h2>
<ol class="river river--text-only">
{items}
</ol>
{rest}</section>"""

REST = """<details class="more-rest">
<summary class="more-toggle">Show {count} more headlines</summary>
<ol class="river river--text-only">
{items}
</ol>
</details>
"""

# One row shape for every tier; the tier only changes classes and whether a dek shows.
# A later image slot goes first inside .story-body; its box is reserved in style.css
# (aspect-ratio), so adding images will not shift text.
STORY = (
    '<li class="story story--{tier}">{open}'
    '<span class="story-body"><span class="headline{headline_mod}">{title}</span>{dek}'
    '<span class="meta">{meta}</span></span>{close}</li>'
)
DEK = '<span class="dek">{dek}</span>'
HEADLINE_MOD = {"hero": " headline--hero", "secondary": " headline--river", "river": " headline--river",
                "text_only": ""}
# Dek line limits per tier (style.css clamps at the same counts). A dek ends on the last
# whole sentence inside the limit; CHARS_PER_LINE is a conservative fill of a 320px
# measure at the dek's 16.5px Newsreader, so a fitted dek never meets the clamp.
DEK_LINES = {"hero": 4, "secondary": 3}
CHARS_PER_LINE = 38
DEK_TIERS = tuple(DEK_LINES)


def _parse_time(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def relative_age(published_at, now):
    """'12m ago', '3h ago', '2d ago' relative to the pool's generated_at."""
    then = _parse_time(published_at)
    if then is None or now is None:
        return ""
    minutes = max(0, int((now - then).total_seconds() // 60))
    if minutes < 60:
        return f"{max(minutes, 1)}m ago"
    if minutes < 48 * 60:
        return f"{minutes // 60}h ago"
    return f"{minutes // (24 * 60)}d ago"


MIDDOT = chr(0x00B7)


def _safe_url(url):
    try:
        parts = urlsplit(url or "")
    except ValueError:
        return None
    if parts.scheme.lower() in ("http", "https") and parts.netloc:
        return url
    return None


def _meta(story, source_names, now):
    """Source, then the quiet 'N sources' for a multi-outlet cluster, then age. The
    source name alone may truncate; the rest never does."""
    article = story.lead
    source = source_names.get(article.get("source_id"), "")
    rest = []
    if story.independent_sources > 1:
        rest.append(f"{story.independent_sources} sources")
    age = relative_age(article.get("published_at"), now)
    if age:
        rest.append(age)
    parts = []
    if source:
        parts.append(f'<span class="meta-source">{escape(source)}</span>')
    tail = f" {MIDDOT} ".join(rest)
    if tail:
        lead_sep = f" {MIDDOT} " if source else ""
        parts.append(f'<span class="meta-rest">{escape(lead_sep + tail)}</span>')
    return "".join(parts)


def _render_story(story, tier, source_names, now):
    article = story.lead
    title = escape(smart_quotes(article["title"]), quote=False)
    dek = ""
    if tier in DEK_TIERS:
        text = fit_dek(clean_dek(article), DEK_LINES[tier] * CHARS_PER_LINE)
        if text:
            dek = DEK.format(dek=escape(smart_quotes(text), quote=False))
    url = _safe_url(article.get("url"))
    if url is None:
        open_, close = '<span class="story-link">', "</span>"
    else:
        open_ = (f'<a class="story-link" href="{escape(url, quote=True)}" '
                 'target="_blank" rel="noopener noreferrer">')
        close = "</a>"
    return STORY.format(
        tier=tier.replace("_", "-"), open=open_, close=close, headline_mod=HEADLINE_MOD[tier],
        title=title, dek=dek, meta=_meta(story, source_names, now),
    )


def render(pool):
    now = _parse_time(pool.get("generated_at"))
    source_names = {s["id"]: s.get("name", "") for s in pool.get("sources", [])}
    tiers = front_page(pool)

    def rows(names):
        return "\n".join(
            _render_story(story, tier, source_names, now) for tier in names for story in tiers[tier]
        )

    tail = tiers["text_only"]
    shown = "\n".join(_render_story(s, "text_only", source_names, now) for s in tail[:MORE_COUNT])
    rest = "\n".join(_render_story(s, "text_only", source_names, now) for s in tail[MORE_COUNT:])
    more = ""
    if shown:
        more = MORE.format(
            items=shown,
            rest=REST.format(count=len(tail) - MORE_COUNT, items=rest) if rest else "",
        )
    preloads = "\n".join(
        f'<link rel="preload" href="fonts/{f}" as="font" type="font/woff2" crossorigin>'
        for f in PRELOAD_FONTS
    )
    updated = now.strftime("%d %b %H:%M UTC") if now else ""
    return PAGE.format(
        preloads=preloads,
        top=rows(("hero", "secondary", "river")),
        more=more,
        count=sum(len(v) for v in tiers.values()),
        articles=len(pool["articles"]),
        generated_at=escape(pool["generated_at"]),
        updated=escape(updated),
    )


def _copy_static(out: Path):
    for src in STATIC.rglob("*"):
        if src.is_dir():
            continue
        rel = src.relative_to(STATIC)
        dest = out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pool", default="dist/pool.json")
    ap.add_argument("--out", default="dist")
    args = ap.parse_args(argv)

    pool_path, out = Path(args.pool), Path(args.out)
    pool = json.loads(pool_path.read_text(encoding="utf-8"))
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(render(pool), encoding="utf-8")
    _copy_static(out)
    if pool_path.resolve() != (out / "pool.json").resolve():
        shutil.copyfile(pool_path, out / "pool.json")
    tiers = front_page(pool)
    counts = ", ".join(f"{name} {len(tiers[name])}" for name in tiers)
    print(f"built {out / 'index.html'}: {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
