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
import re
import shutil
import sys
from datetime import datetime
from html import escape
from pathlib import Path
from urllib.parse import urlsplit

from app.csp import headers_file
from app.health import render as render_health
from app.dek import fit_dek
from app.frontpage import (CHARS_PER_LINE, DEK_LINES, clean_dek, front_page, pass_input, rank_input,
                           run_ranker, source_ownership)
from app.images import THUMB_PX, credit_text, hero_box, hero_media, hero_worthy, image_url, media_for, thumb_ok
from app.serviceworker import write_service_worker
from app.typography import smart_quotes

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

# Preloaded because they paint above the fold: the headline serif and the meta sans.
# The dek's regular serif is not preloaded (40KB preload budget); its metric-matched
# fallback keeps the swap shift-free.
PRELOAD_FONTS = ("Newsreader-Bold-latin.woff2", "LibreFranklin-Medium-latin.woff2")

PAGE = """<!doctype html>
<html lang="en" data-rank-key="{rank_key}" data-generated-at="{generated_at}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121212">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Almanac">
<title>Almanac</title>
{preloads}
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="style.css">
<script src="js/offline-gate.js"></script>
<script src="js/rank-gate.js"></script>
<script type="module" src="js/tabs.js"></script>
<script type="module" src="js/reader.js"></script>
<script type="module" src="js/story-actions.js"></script>
<script type="module" src="js/coverage-view.js"></script>
<script type="module" src="js/history/observe.js"></script>
<script type="module" src="js/live-actions.js"></script>
<script src="js/sw-register.js" defer></script>
</head>
<body class="app">
<div class="screens">
<div class="screen screen--home is-current" id="screen-home" data-screen="home">
<nav class="tabs" aria-label="Sections">
<div class="tabs-scroll" role="tablist">
{tabs}
</div>
</nav>
<main class="pager" id="pager">
<section class="panel" id="section-today" role="tabpanel" aria-labelledby="tab-today" data-section="today">
<header class="masthead masthead--nameplate">
<h1 class="wordmark">Almanac</h1>
</header>
<p class="offline-line" id="offline-line" data-generated-at="{generated_at}" hidden></p>
<script src="js/offline.js"></script>
{notices}
<ol class="river river--top" id="headlines">
{top}
</ol>
{more}
<footer class="colophon"><p class="colophon-text">{count} stories from {articles} articles. Updated <time datetime="{generated_at}">{updated}</time></p></footer>
</section>
{panels}
</main>
</div>
{views}
</div>
{nav}
{reader}
{sheet}
{toast}
<template id="rank-input">{rank_input}</template>
</body>
</html>
"""

# S27 app chrome. The tab strip, bottom nav and empty views are the app's own static
# markup; every label is plain text from the one section table (app/static/js/sections.js)
# or this file, never a feed string. Section panels start empty: tabs.js fills each from
# Today's own rows, filtered by the same table, so the page carries no second copy.
TAB = ('<button class="tab" type="button" role="tab" id="tab-{id}" aria-controls="section-{id}" '
       'aria-selected="{selected}" tabindex="{tabindex}" data-section="{id}"{hidden}>{label}</button>')
PANEL = ('<section class="panel" id="section-{id}" role="tabpanel" aria-labelledby="tab-{id}" '
         'data-section="{id}"{hidden}></section>')

# Bottom nav (R21): Home, Following, Saved, You. Icons are the app's own simple filled
# glyphs, 20dp, one path each; the label under each is text only. You opens the S10
# profile screen, the entry NYT puts on its You tab (it left the masthead here).
NAV_ICONS = {
    "home": "M12 3.2 2.6 11.3h2.8v9.5h5.1v-6h3v6h5.1v-9.5h2.8z",
    "following": "M12 2.6 2.4 7.8 12 13l9.6-5.2zM4.7 11.2l-2.3 1.3L12 17.7l9.6-5.2-2.3-1.3L12 15.1zM4.7 15.9l-2.3 1.3L12 22.4l9.6-5.2-2.3-1.3L12 19.8z",
    "saved": "M6.2 2.6h11.6c.5 0 .9.4.9.9v18.1L12 17.1l-6.7 4.5V3.5c0-.5.4-.9.9-.9z",
    "you": "M12 11.6a4.3 4.3 0 1 0 0-8.6 4.3 4.3 0 0 0 0 8.6zm0 2.1c-4.8 0-8.4 2.6-8.4 6.2v1.5h16.8v-1.5c0-3.6-3.6-6.2-8.4-6.2z",
}
NAV_ITEMS = (("home", "Home", "#home"), ("following", "Following", "#following"),
             ("saved", "Saved", "#saved"), ("you", "You", "profile.html"))
NAV_ITEM = ('<a class="nav-item" href="{href}" data-screen="{id}"{current}>'
            '<svg class="nav-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">'
            '<path d="{icon}"></path></svg><span class="nav-label">{label}</span></a>')


def bottom_nav(current):
    """The four-item bottom nav with `current` marked, shared by the front page and the
    profile page (which links home by page, not by fragment)."""
    items = []
    for key, label, href in NAV_ITEMS:
        if current == "you" and href.startswith("#"):
            href = "index.html" + href
        items.append(NAV_ITEM.format(href=href, id=key, icon=NAV_ICONS[key], label=label,
                                     current=' aria-current="page"' if key == current else ""))
    return '<nav class="bottom-nav" aria-label="Primary">\n' + "\n".join(items) + "\n</nav>"


# S25 reader: one layer over the app, filled by js/reader.js when a story with a body
# file is tapped. Static chrome only: the scroller, an empty article, and NYT's bottom
# story bar in the bottom nav's place (back on the left, the source link on the right).
READER = """<div class="reader" id="reader" role="dialog" aria-modal="true" aria-labelledby="reader-title" hidden>
<div class="reader-scroll" id="reader-scroll">
<article class="reader-article" id="reader-article"></article>
</div>
<nav class="reader-bar" aria-label="Story">
<button class="reader-back" id="reader-back" type="button" aria-label="Back"><svg class="reader-bar-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z"></path></svg></button>
<a class="reader-out" id="reader-out" target="_blank" rel="noopener noreferrer" aria-label="Read at the source" hidden><svg class="reader-bar-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3zM19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2z"></path></svg></a>
</nav>
</div>"""

# S24: the reusable bottom sheet (js/sheet.js), an NYT-style overflow/share sheet.
# Static chrome only, empty and hidden until a caller opens it: this slice's own
# story-actions menu, and S12's why-this sheet and S14's coverage view after it, each
# filling #sheet-body with their own content through the same open/close API.
SHEET = """<div class="sheet-root" id="sheet-root" hidden>
<div class="sheet-scrim" id="sheet-scrim"></div>
<div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-label">
<div class="sheet-drag" id="sheet-drag">
<span class="sheet-grabber" aria-hidden="true"></span>
<h2 class="sheet-label" id="sheet-label"></h2>
<button class="sheet-close" id="sheet-close" type="button" aria-label="Close">
<svg class="sheet-close-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"></path></svg>
</button>
</div>
<div class="sheet-body" id="sheet-body"></div>
</div>
</div>"""

# S24: the shared quiet confirmation with an optional Undo (js/toast.js), for Save,
# thumbs, Mute source, Mute topic and Boost topic alike.
TOAST = """<div class="toast" id="toast" role="status" aria-live="polite" hidden>
<p class="toast-text" id="toast-text"></p>
<button class="toast-action" id="toast-action" type="button" hidden></button>
</div>"""

# S25: a story opens in the reader only when its lead article has a body file (S22
# has_body) and a link out; the id is the contract's article id shape, so it can only
# ever name a file under bodies/.
BODY_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def body_id(article):
    """The lead's article id when the reader can open it, else None."""
    aid = article.get("id")
    if article.get("has_body") is True and isinstance(aid, str) and BODY_ID.match(aid) and _safe_url(article.get("url")):
        return aid
    return None


def reader_photos(stories):
    """{article_id: [url, width, height, credit]} for each shown story whose lead the
    reader can open and whose own photo is hero-worthy (S39): the article's own photo,
    never one borrowed from another outlet in its cluster, in the D2 hero box."""
    photos = {}
    for story in stories:
        aid = body_id(story.lead)
        image = story.lead.get("image")
        if aid and hero_worthy(image):
            photos[aid] = [image_url(image), *hero_box(image), credit_text(image)]
    return dict(sorted(photos.items()))


# S14: the coverage view, on any cluster with 2 or more independent sources (DESIGN-v1
# section 6, carried into DESIGN-v1.1 section 5 unchanged: real headlines side by side,
# never an AI summary, R13).

def coverage_outlet_count(article_ids, by_id):
    """Distinct outlets that carried the story in any form, syndicated copies included
    (unlike independent_sources, which folds one wire-copy group down to one voice)."""
    return len({by_id[aid]["source_id"] for aid in article_ids if aid in by_id})


def coverage_summary_text(cluster, by_id):
    """'N outlets, M independent, across K leans', plain numbers only (no AI text, R13):
    the sheet's own header (js/coverage.js summarize()) shows the same three numbers
    from the same cluster fields, so the button's accessible name matches what opening
    it shows."""
    outlets = coverage_outlet_count(cluster.get("article_ids", []), by_id)
    independent = cluster.get("independent_sources", 0)
    leans = len(cluster.get("lean_buckets", []))
    lean_word = "lean" if leans == 1 else "leans"
    return f"{outlets} outlets, {independent} independent, across {leans} {lean_word}"


def coverage_articles(pool):
    """{article_id: {url, has_body}} for every article belonging to a cluster of 2 or
    more independent sources, kept apart from rank_input's compact fields (S14) so the
    ranker's own input never changes shape: url and has_body already exist in the pool
    (R12), just not carried into the ranker's compact view. Sorted by id for a
    byte-stable page."""
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    ids = {aid for c in pool.get("clusters", []) if c.get("independent_sources", 0) > 1
           for aid in c.get("article_ids", [])}
    out = {}
    for aid in sorted(ids):
        article = by_id.get(aid)
        if not article:
            continue
        out[aid] = {"url": _safe_url(article.get("url")) or "", "has_body": body_id(article) is not None}
    return out


# Following (S30) and Saved (S26) are later slices; until then each is a calm view with
# its title and one quiet line about what will live there, set like NYT's You tab.
VIEW = """<section class="screen screen--view" id="screen-{id}" data-screen="{id}" aria-labelledby="{id}-title">
<div class="view">
<h1 class="view-title" id="{id}-title">{title}</h1>
<div class="empty">
<p class="empty-head">{head}</p>
<p class="empty-text">{text}</p>
</div>
</div>
</section>"""
VIEWS = (
    ("following", "Following", "Nothing followed yet",
     "Standing stories and the names you follow will each get a page here, with a timeline and how every outlet covered it."),
    ("saved", "Saved", "Nothing saved yet",
     "Stories you save will wait here, and the ones with full text stay readable offline."),
)


def _chrome(sections):
    # S33: a slot section (only "live" today) starts hidden like any other until its
    # own slice fills it; once it can (an event is live or pinned, so rankPages gave it
    # ids) it renders shown from the first paint, deterministic at build, no client-side
    # toggle-after-paint and so no layout shift in the strip.
    tabs, panels = [], []
    for index, section in enumerate(sections):
        hidden = " hidden" if section.get("slot") and not section.get("ids") else ""
        tabs.append(TAB.format(id=escape(section["id"], quote=True), label=escape(section["label"], quote=False),
                               selected="true" if index == 0 else "false", tabindex="0" if index == 0 else "-1",
                               hidden=hidden))
        if index:
            panels.append(PANEL.format(id=escape(section["id"], quote=True), hidden=hidden))
    views = "\n".join(VIEW.format(id=v, title=t, head=h, text=x) for v, t, h, x in VIEWS)
    return "\n".join(tabs), "\n".join(panels), views


# S28 silence alarm (R2): one quiet notice per standing story with no recent coverage,
# under the nameplate and above the hero, set in the sans so it never reads as a news
# card: a kicker naming the standing story, one line saying what is missing, one line
# saying whether that is a gap in coverage or failing sources. Every word comes from
# app/static/js/standing.js (the same function the device runs); source names are the
# only feed strings, escaped here and set as text on the device (R26). rerank.js draws
# the same markup. The container is always present, empty when all is well, so the
# device can fill or clear it before the page is shown.
NOTICES = '<section class="notices" id="standing-notices" aria-label="Standing stories">{items}</section>'
NOTICE = ('<div class="notice" data-standing="{id}" data-kind="{kind}">'
          '<p class="notice-kicker">{kicker}</p><p class="notice-head">{head}</p>'
          '<p class="notice-text">{text}</p></div>')


def render_notices(notices):
    return NOTICES.format(items="".join(
        NOTICE.format(id=escape(n["id"], quote=True), kind=escape(n["kind"], quote=True),
                      kicker=escape(n["kicker"], quote=False), head=escape(n["head"], quote=False),
                      text=escape(n["text"], quote=False))
        for n in notices))


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

# S24: the per-story overflow control (js/story-actions.js), a sibling of the row's
# own link, never nested inside it (a button inside an <a> would fire both on a tap).
# A quiet 48dp target, the three-dot glyph NYT's own article bar uses; CSS reserves a
# matching gutter on the headline, dek and meta so the icon is never fought for room.
STORY_OVERFLOW = (
    '<button class="story-overflow" type="button" aria-label="Story actions" aria-haspopup="dialog">'
    '<svg class="story-overflow-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">'
    '<path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"></path>'
    "</svg></button>"
)
# S14: the coverage view trigger. It never changes what the meta line shows (still
# reads as quiet meta, R34): it is an invisible sibling button laid over the meta
# line's own rendered position with a negative top margin sized to the tier's own fixed
# padding-bottom plus the meta line-height (both design tokens, never content-length
# dependent), so it lines up under "N sources" without moving anything and without ever
# nesting a button inside the row's own <a> (same rule as STORY_OVERFLOW above: a tap on
# it must never also navigate). min-height brings the target to 48dp; style.css raises
# it a little further into the row's own whitespace above the meta line to get there
# without pushing the next row down (the design bar's steady rhythm, R34). Built only
# for clusters of 2 or more independent sources, the same floor DESIGN-v1 sets for the
# coverage view itself.
STORY_COVERAGE = ('<button class="story-coverage" type="button" data-sid="{sid}" '
                   'aria-haspopup="dialog" aria-label="See coverage: {label}"></button>')
# One row shape for every tier; the tier only changes classes, whether a dek shows and
# whether a photo shows. The photo goes first inside .story-body; its box is sized by
# width, height and aspect-ratio before a byte arrives (style.css), so text never moves.
STORY = (
    '<li class="story story--{tier}" data-sid="{sid}">{open}'
    '<span class="story-body">{media}<span class="headline{headline_mod}">{title}</span>{dek}'
    '<span class="meta">{meta}</span></span>{close}' + STORY_OVERFLOW + "{coverage}{other}</li>"
)
# S13 other-side slot: one attached link under a many-outlet card, to the same story as
# an outlet of the lean least seen on this page tells it (app/static/js/passes.js says
# which and why). Its own link beside the card's, never inside it. tiers.js draws the
# same markup on the device. Built only for clusters of OTHER_SIDE_MIN_SOURCES or more
# independent sources, the design's floor, so the page carries link data for no others.
OTHER_SIDE_MIN_SOURCES = 3  # passes.js OTHER_SIDE_MIN_SOURCES
OTHER = ('<{tag} class="other-side" data-aid="{aid}"{href}>'
         '<span class="other-side-label">Other side {dot} {lean} {dot} {source}</span>'
         '<span class="other-side-title">{title}</span></{tag}>')
OTHER_HREF = ' href="{url}" target="_blank" rel="noopener noreferrer"'
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


def other_side_links(pool, stories):
    """{article_id: [url, title]} for every article of a story with enough independent
    outlets for an other-side link: the url only if http(s), the title typeset as the
    build sets it. The device draws an other-side link from this alone."""
    by_id = {a["id"]: a for a in pool["articles"]}
    links = {}
    for story in stories:
        if story.independent_sources < OTHER_SIDE_MIN_SOURCES:
            continue
        for aid in story.article_ids:
            article = by_id[aid]
            links[aid] = [_safe_url(article.get("url")) or "", smart_quotes(article.get("title", ""))]
    return dict(sorted(links.items()))


def _other_side(record, links, source_names, leans):
    """The attached other-side link for a row, or '' (see OTHER)."""
    if not record or record["article_id"] not in links:
        return ""
    url, title = links[record["article_id"]]
    return OTHER.format(
        tag="a" if url else "span", aid=escape(record["article_id"], quote=True),
        href=OTHER_HREF.format(url=escape(url, quote=True)) if url else "", dot=MIDDOT,
        lean=escape(record.get("lean") or leans.get(record["source_id"], ""), quote=False),
        source=escape(source_names.get(record["source_id"], record["source_id"]), quote=False),
        title=escape(title, quote=False))


def _render_story(story, tier, source_names, now, by_id, other="", coverage=""):
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
        aid = body_id(article)
        body = f' data-body="{escape(aid, quote=True)}"' if aid else ""
        open_ = (f'<a class="story-link" href="{escape(url, quote=True)}" '
                 f'target="_blank" rel="noopener noreferrer"{body}>')
        close = "</a>"
    return STORY.format(
        tier=tier.replace("_", "-"), sid=escape(story.id, quote=True), open=open_, close=close, headline_mod=HEADLINE_MOD[tier],
        title=title, dek=dek, meta=_meta(story, source_names, now), other=other, coverage=coverage,
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


def _rank_input_json(pool, stories, by_id, source_names, links):
    """The device's ranking input as template text. Only &, < and > are escaped, so no
    feed string can close the template or open a tag (R26); JSON quotes stay readable.
    S13: buckets, leans and names for the passes, and the other-side link data. S14:
    ownership labels and the url/has_body pair the coverage view needs, kept apart from
    the ranker's own compact article fields (rank_input) so that input never changes
    shape."""
    data = {"now": pool.get("generated_at"), "pool": rank_input(pool), "deks": _dek_pairs(stories),
            "images": _image_records(stories, by_id, source_names), **pass_input(pool), "links": links,
            "reader": reader_photos(stories), "ownership": source_ownership(pool),
            "coverage": coverage_articles(pool)}
    return escape(json.dumps(data, ensure_ascii=False, separators=(",", ":")), quote=False)


def render(pool, ranking=None):
    now = _parse_time(pool.get("generated_at"))
    source_names = {s["id"]: s.get("name", "") for s in pool.get("sources", [])}
    by_id = {a["id"]: a for a in pool["articles"]}
    clusters_by_id = {c["id"]: c for c in pool.get("clusters", [])}
    ranking = ranking or run_ranker(pool)
    tiers = front_page(pool, ranking)
    shown_stories = [s for name in tiers for s in tiers[name]]
    links = other_side_links(pool, shown_stories)
    leans = pass_input(pool)["leans"]
    others = {r["id"]: _other_side(r.get("other_side"), links, source_names, leans) for r in ranking["ranked"]}
    coverages = {
        sid: STORY_COVERAGE.format(sid=escape(sid, quote=True),
                                    label=escape(coverage_summary_text(cluster, by_id), quote=True))
        for sid, cluster in clusters_by_id.items() if cluster.get("independent_sources", 0) > 1
    }

    def row(story, tier):
        return _render_story(story, tier, source_names, now, by_id, others.get(story.id, ""),
                              coverages.get(story.id, ""))

    def rows(names):
        return "\n".join(row(story, tier) for tier in names for story in tiers[tier])

    tail = tiers["text_only"]
    shown = "\n".join(row(s, "text_only") for s in tail[:MORE_COUNT])
    rest = "\n".join(row(s, "text_only") for s in tail[MORE_COUNT:])
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
    tabs, panels, views = _chrome(ranking["sections"])
    return PAGE.format(
        tabs=tabs,
        panels=panels,
        views=views,
        nav=bottom_nav("home"),
        reader=READER,
        sheet=SHEET,
        toast=TOAST,
        rank_key=escape(ranking["key"], quote=True),
        notices=render_notices(ranking.get("notices", [])),
        rank_input=_rank_input_json(pool, shown_stories, by_id, source_names, links),
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
    # S17: the Health screen, off the You tab, built the same way as the front page
    # (the pool's own ledger and source_health, embedded once, at build time).
    (out / "health.html").write_text(render_health(pool), encoding="utf-8")
    # S37: the CSP and other security headers, for the pages just written (app.csp).
    pages = {page.name: page.read_text(encoding="utf-8") for page in sorted(out.glob("*.html"))}
    (out / "_headers").write_text(headers_file(pages), encoding="utf-8")
    if pool_path.resolve() != (out / "pool.json").resolve():
        shutil.copyfile(pool_path, out / "pool.json")
    # S18: the service worker precaches the shell just written above (HTML, CSS, JS,
    # fonts, manifest, icons), under a cache name hashed from those exact bytes.
    write_service_worker(out)
    tiers = front_page(pool, ranking)
    counts = ", ".join(f"{name} {len(tiers[name])}" for name in tiers)
    print(f"built {out / 'index.html'}: {counts}")
    print("sections: " + ", ".join(f"{s['label']} {len(s['ids'])}" for s in ranking["sections"] if not s.get("slot")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
