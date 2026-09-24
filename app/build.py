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
from app.frontpage import CHARS_PER_LINE, DEK_LINES, clean_dek, front_page, rank_input, run_ranker
from app.images import THUMB_PX, hero_box, hero_media, image_url, media_for, thumb_ok
from app.typography import smart_quotes

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

# Preloaded because they paint above the fold: the headline serif and the meta sans.
# The dek's regular serif is not preloaded (40KB preload budget); its metric-matched
# fallback keeps the swap shift-free.
PRELOAD_FONTS = ("Newsreader-Bold-latin.woff2", "LibreFranklin-Medium-latin.woff2")

PAGE = """<!doctype html>
<html lang="en" data-rank-key="{rank_key}">
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
<script src="js/rank-gate.js"></script>
</head>
<body>
<header class="masthead">
<h1 class="wordmark">Almanac</h1>
<a class="masthead-action" href="profile.html" aria-label="Profile settings">
<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"></circle><path d="M19.4 13.5a1.6 1.6 0 0 0 .3 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.3 1.6 1.6 0 0 0-1 1.47V19.5a2 2 0 1 1-4 0v-.09a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.3l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .3-1.77 1.6 1.6 0 0 0-1.47-1H4.5a2 2 0 1 1 0-4h.09a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.3-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.3H10.5a1.6 1.6 0 0 0 1-1.47V4.5a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.3l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.3 1.77V10.5a1.6 1.6 0 0 0 1.47 1H19.5a2 2 0 1 1 0 4h-.09a1.6 1.6 0 0 0-1.01 1z"></path></svg>
</a>
</header>
<main>
<ol class="river river--top" id="headlines">
{top}
</ol>
{more}
</main>
<template id="rank-input">{rank_input}</template>
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
<ol class="river river--text-only" id="more-list">
{items}
</ol>
{rest}</section>"""

REST = """<details class="more-rest">
<summary class="more-toggle">Show {count} more headlines</summary>
<ol class="river river--text-only" id="rest-list">
{items}
</ol>
</details>
"""

# One row shape for every tier; the tier only changes classes, whether a dek shows and
# whether a photo shows. The photo goes first inside .story-body; its box is sized by
# width, height and aspect-ratio before a byte arrives (style.css), so text never moves.
STORY = (
    '<li class="story story--{tier}" data-sid="{sid}">{open}'
    '<span class="story-body">{media}<span class="headline{headline_mod}">{title}</span>{dek}'
    '<span class="meta">{meta}</span></span>{close}</li>'
)
# S39 photos (app.images decides which). The url is an attribute value, escaped; alt is
# empty because the headline beside it carries the meaning. Only the hero loads eagerly.
# D2: the hero box follows the photo's stated shape (app.images.hero_box), so the frame
# carries its ratio as --box, two integers the build computed, never a feed string.
IMG = ('<span class="story-media story-media--{kind}"{box}><img class="story-img" src="{src}" '
       'width="{width}" height="{height}" alt="" {load} decoding="async" referrerpolicy="no-referrer"></span>')
BOX = ' style="--box: {width} / {height}"'
LOAD = {"hero": 'fetchpriority="high"', "thumb": 'loading="lazy"'}
CREDIT = '<span class="story-credit">{credit}</span>'

DEK = '<span class="dek">{dek}</span>'
HEADLINE_MOD = {"hero": " headline--hero", "secondary": " headline--river", "river": " headline--river",
                "text_only": ""}
# Dek line limits live with the lead rule in app.frontpage (D1); re-exported here.
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


def _media(tier, hero, thumb_image):
    """The photo markup for a row of this tier, or '' for the text-only variant. `hero`
    is app.images.hero_media's (image, credit) or None; a thumbnail is the lead's own."""
    if tier == "hero" and hero is not None:
        image, credit = hero
        width, height = hero_box(image)
        box = BOX.format(width=width, height=height)
        html = IMG.format(kind="hero", box=box, src=escape(image_url(image), quote=True),
                          width=width, height=height, load=LOAD["hero"])
        if credit:
            html += CREDIT.format(credit=escape(credit, quote=False))
        return html
    if tier == "river" and thumb_ok(thumb_image):
        return IMG.format(kind="thumb", box="", src=escape(image_url(thumb_image), quote=True),
                          width=THUMB_PX, height=THUMB_PX, load=LOAD["thumb"])
    return ""


def _members(story, by_id):
    return [by_id[i] for i in story.article_ids if i in by_id]


def _render_story(story, tier, source_names, now, by_id):
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
        tier=tier.replace("_", "-"), sid=escape(story.id, quote=True), open=open_, close=close, headline_mod=HEADLINE_MOD[tier],
        title=title, dek=dek, meta=_meta(story, source_names, now),
        media=_media(tier, hero_media(_members(story, by_id), article, source_names) if tier == "hero" else None,
                     article.get("image")),
    )


def _dek_pairs(stories):
    """Each story's fitted dek for the hero and a lead block, one entry when they agree,
    so the device can promote any row into a dek tier without re-fitting text."""
    pairs = {}
    for story in stories:
        dek = clean_dek(story.lead)
        if dek:
            fitted = [smart_quotes(fit_dek(dek, DEK_LINES[t] * CHARS_PER_LINE)) for t in DEK_TIERS]
            pairs[story.id] = fitted[:1] if fitted[0] == fitted[1] else fitted
    return pairs


def _image_records(stories, by_id, source_names):
    """Each story's photo record (app.images.media_for), so a device re-rank can give a
    promoted row its photo box and take it from a demoted one, by the build's own rule."""
    records = {}
    for story in stories:
        hero = hero_media(_members(story, by_id), story.lead, source_names)
        record = media_for(hero, story.lead.get("image"))
        if record:
            records[story.id] = record
    return records


def _rank_input_json(pool, stories, by_id, source_names):
    """The device's ranking input as template text. Only &, < and > are escaped, so no
    feed string can close the template or open a tag (R26); JSON quotes stay readable."""
    data = {"now": pool.get("generated_at"), "pool": rank_input(pool), "deks": _dek_pairs(stories),
            "images": _image_records(stories, by_id, source_names)}
    return escape(json.dumps(data, ensure_ascii=False, separators=(",", ":")), quote=False)


def render(pool, ranking=None):
    now = _parse_time(pool.get("generated_at"))
    source_names = {s["id"]: s.get("name", "") for s in pool.get("sources", [])}
    by_id = {a["id"]: a for a in pool["articles"]}
    ranking = ranking or run_ranker(pool)
    tiers = front_page(pool, ranking)

    def rows(names):
        return "\n".join(
            _render_story(story, tier, source_names, now, by_id) for tier in names for story in tiers[tier]
        )

    tail = tiers["text_only"]
    shown = "\n".join(_render_story(s, "text_only", source_names, now, by_id) for s in tail[:MORE_COUNT])
    rest = "\n".join(_render_story(s, "text_only", source_names, now, by_id) for s in tail[MORE_COUNT:])
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
        rank_key=escape(ranking["key"], quote=True),
        rank_input=_rank_input_json(pool, [s for name in tiers for s in tiers[name]], by_id, source_names),
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
    ranking = run_ranker(pool)
    (out / "index.html").write_text(render(pool, ranking), encoding="utf-8")
    _copy_static(out)
    if pool_path.resolve() != (out / "pool.json").resolve():
        shutil.copyfile(pool_path, out / "pool.json")
    tiers = front_page(pool, ranking)
    counts = ", ".join(f"{name} {len(tiers[name])}" for name in tiers)
    print(f"built {out / 'index.html'}: {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
