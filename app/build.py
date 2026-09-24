"""Build the Almanac static page: the pool as a text-only list styled with the design
tokens (S03). One tier for now; S04 builds the hero and river tiers on these tokens.

Feed content is hostile input (R26): every field is HTML-escaped, so a title, source
name or timestamp can only ever render as text, never a tag. A story link is emitted
only for an http or https url, so a javascript: or data: url never becomes an href.
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

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

# Preloaded because they paint above the fold: the headline serif and the meta sans.
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
<ol class="river" id="headlines">
{items}
</ol>
</main>
<footer class="colophon"><p class="colophon-text">{count} stories. Updated <time datetime="{generated_at}">{updated}</time></p></footer>
</body>
</html>
"""

STORY_LINK = (
    '<li class="story"><a class="story-link" href="{url}" target="_blank" rel="noopener noreferrer">'
    '<span class="story-body"><span class="headline">{title}</span>'
    '<span class="meta">{meta}</span></span></a></li>'
)
STORY_PLAIN = (
    '<li class="story"><span class="story-link">'
    '<span class="story-body"><span class="headline">{title}</span>'
    '<span class="meta">{meta}</span></span></span></li>'
)


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


def _render_item(article, source_names, now):
    source = source_names.get(article.get("source_id"), "")
    age = relative_age(article.get("published_at"), now)
    meta = escape(f" {MIDDOT} ".join(p for p in (source, age) if p))
    title = escape(article["title"])
    url = _safe_url(article.get("url"))
    if url is None:
        return STORY_PLAIN.format(title=title, meta=meta)
    return STORY_LINK.format(url=escape(url, quote=True), title=title, meta=meta)


def render(pool):
    now = _parse_time(pool.get("generated_at"))
    source_names = {s["id"]: s.get("name", "") for s in pool.get("sources", [])}
    items = "\n".join(_render_item(a, source_names, now) for a in pool["articles"])
    preloads = "\n".join(
        f'<link rel="preload" href="fonts/{f}" as="font" type="font/woff2" crossorigin>'
        for f in PRELOAD_FONTS
    )
    updated = now.strftime("%d %b %H:%M UTC") if now else ""
    return PAGE.format(
        preloads=preloads,
        items=items,
        count=len(pool["articles"]),
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
    print(f"built {out / 'index.html'} with {len(pool['articles'])} headlines")
    return 0


if __name__ == "__main__":
    sys.exit(main())
