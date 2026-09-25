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
from app.frontpage import (CHARS_PER_LINE, DEK_LINES, ROW_DEK_LINES, clean_dek, dek_budget, dek_clamp, front_page,
                           pass_input, rank_input, run_ranker, source_countries, source_ownership,
                           version_bv, visible_source_count)
from app.images import THUMB_PX, credit_text, hero_box, hero_media, hero_worthy, image_url, media_for, thumb_ok
from app.lean import hit_html as lean_hit_html, marker_html as lean_marker_html
from app.serviceworker import write_service_worker
from app.source_catalog import write as write_source_catalog
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
<!-- S34: found by the History screen's own Behind Access proof (tests/browser/
     s34_check.mjs), an H3-class gap: a <link rel="manifest"> fetch carries no
     credentials by default, so behind Cloudflare Access it hit the login redirect and
     tripped manifest-src (CSP). crossorigin="use-credentials" sends the Access cookie
     like every other request already does. -->
<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="style.css">
<script src="js/offline-gate.js"></script>
<script src="js/rank-gate.js"></script>
<script type="module" src="js/tabs.js"></script>
<script type="module" src="js/reader.js"></script>
<script type="module" src="js/story-actions.js"></script>
<script type="module" src="js/coverage-view.js"></script>
<script type="module" src="js/versions-view.js"></script>
<script type="module" src="js/lean-view.js"></script>
<script type="module" src="js/history/observe.js"></script>
<script type="module" src="js/live-actions.js"></script>
<script type="module" src="js/saved-screen.js"></script>
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
{versions}
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
       'aria-selected="{selected}" tabindex="{tabindex}" data-section="{id}" data-label="{label_attr}"{hidden}>{label}</button>')
PANEL = ('<section class="panel" id="section-{id}" role="tabpanel" aria-labelledby="tab-{id}" '
         'data-section="{id}"{hidden}></section>')

# Bottom nav (R21): Home, Following, Saved, You. D3: one drawn set on a 24dp grid, one
# stroke weight (style.css .nav-icon), outlined when inactive; the current item fills its
# `nav-shape` parts, as NYT's bar does. Each glyph spans about 20dp of the 24dp box (the
# measured icon size). The label under each is text only. You opens the S10 profile
# screen, the entry NYT puts on its You tab (it left the masthead here). H1: links name the
# pretty URL Cloudflare Pages serves ("/profile"), never the file, which Pages 308s.
NAV_ICONS = {
    "home": '<path class="nav-shape" d="M3.6 10.1 12 3.3l8.4 6.8V20.9h-5.9v-6h-5v6H3.6z"></path>',
    "following": ('<path class="nav-shape" d="M12 3.2 20.9 8 12 12.8 3.1 8z"></path>'
                  '<path d="M3.1 12.3 12 17.1l8.9-4.8M3.1 16.4 12 21.2l8.9-4.8"></path>'),
    "saved": '<path class="nav-shape" d="M6.2 3.1h11.6v17.8L12 16.6l-5.8 4.3z"></path>',
    "you": ('<circle class="nav-shape" cx="12" cy="7.6" r="4.2"></circle>'
            '<path class="nav-shape" d="M4 20.9c0-4.3 3.6-6.6 8-6.6s8 2.3 8 6.6z"></path>'),
}
NAV_ITEMS = (("home", "Home", "#home"), ("following", "Following", "#following"),
             ("saved", "Saved", "#saved"), ("you", "You", "/profile"))
NAV_ITEM = ('<a class="nav-item" href="{href}" data-screen="{id}"{current}>'
            '<svg class="nav-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">'
            '{icon}</svg><span class="nav-label">{label}</span></a>')


def bottom_nav(current):
    """The four-item bottom nav with `current` marked, shared by the front page and the
    profile page (which links home by page, not by fragment)."""
    items = []
    for key, label, href in NAV_ITEMS:
        if current == "you" and href.startswith("#"):
            href = "/" + href
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

# V1: the story versions carousel (js/versions-view.js, docs/DESIGN-bundles.md section 5),
# one full-screen layer like the reader, under it in the stack so a "Read" inside opens
# the reader above it. Static chrome only: the top bar (close, "Versions", the "2 of 7"
# count, the word-mark switch), the empty index strip and track the device fills from
# #rank-input, the word-mark key, and the footer into S14's coverage sheet.
VERSIONS = """<div class="bv" id="bv" role="dialog" aria-modal="true" aria-labelledby="bv-title" hidden>
<header class="bv-bar">
<button class="bv-close" id="bv-close" type="button" aria-label="Close"><svg class="bv-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"></path></svg></button>
<h2 class="bv-title" id="bv-title">Versions</h2>
<p class="bv-count" id="bv-count"></p>
<button class="bv-marks" id="bv-marks" type="button" aria-pressed="true" aria-label="Word marks" aria-describedby="bv-key"><svg class="bv-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 16.5c3 0 5.5-2.5 5.5-5.5V3.5h-2.2V11a3.3 3.3 0 0 1-6.6 0V3.5H6.5V11c0 3 2.5 5.5 5.5 5.5z"></path><path class="bv-marks-bar" d="M5 19h14v2H5z"></path></svg></button>
</header>
<div class="bv-strip" id="bv-strip" role="tablist" aria-label="Versions"></div>
<p class="bv-key" id="bv-key"><span class="bv-key-mark">Underlined</span>: words only this outlet used</p>
<div class="bv-track" id="bv-track" role="region" aria-roledescription="carousel" aria-label="Versions of this story"></div>
<footer class="bv-foot">
<button class="bv-all" id="bv-all" type="button" aria-haspopup="dialog"><span>All versions by lean</span><svg class="bv-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9.4 5.6 8 7l5 5-5 5 1.4 1.4 6.4-6.4z"></path></svg></button>
<a class="bv-primary" id="bv-primary" target="_blank" rel="noopener noreferrer" aria-label="Primary source: the post, on trumpstruth.org, a third-party archive not run by Truth Social" hidden><span>Primary source</span><svg class="bv-icon bv-action-icon--out" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"></path></svg></a>
</footer>
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

# S25: an article opens in the reader only when it has a body file (S22 has_body) and a
# link out; the id is the contract's article id shape, so it can only ever name a file
# under bodies/.
BODY_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def body_id(article):
    """The article's id when the reader can open it, else None."""
    aid = article.get("id")
    if article.get("has_body") is True and isinstance(aid, str) and BODY_ID.match(aid) and _safe_url(article.get("url")):
        return aid
    return None


# U1: a story opens in the reader when ANY outlet in its cluster has full text, not only
# its lead. Each such member is a candidate [article_id, source_id, body_chars, url]; the
# build picks with the default profile (no trust set), the device re-picks at tap time
# with the stored profile's trust (js/reader/core.js bestMember, the same rule).
_TAGS = re.compile(r"<[^>]*>")


def body_chars(bodies_dir):
    """{article_id: characters of body text} for every body file the fetcher wrote, the
    tags stripped and whitespace folded; {} when there is no bodies directory."""
    chars = {}
    if not bodies_dir or not Path(bodies_dir).is_dir():
        return chars
    for path in sorted(Path(bodies_dir).glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        html, aid = record.get("body_html"), record.get("article_id")
        if isinstance(html, str) and isinstance(aid, str):
            chars[aid] = len(" ".join(_TAGS.sub(" ", html).split()))
    return chars


def body_candidates(story, by_id, chars):
    """The story's members the reader can open, as [id, source_id, body_chars, url],
    in id order so the page is byte-stable."""
    out = []
    for aid in story.article_ids:
        article = by_id.get(aid)
        if article and body_id(article):
            out.append([aid, article.get("source_id") or "", int(chars.get(aid, 0)), _safe_url(article.get("url"))])
    return out


def best_member(candidates, lead_id, trust=None):
    """Which candidate the reader opens: the lead when it has a body, else the member
    from the outlet the owner trusts most (profile trust, 1.0 when unset), else the
    longest body, then the lowest id so ties never depend on input order."""
    if not candidates:
        return None
    if any(c[0] == lead_id for c in candidates):
        return lead_id
    trust = trust or {}
    return min(candidates, key=lambda c: (-float(trust.get(c[1], 1.0)), -c[2], c[0]))[0]


def reader_bodies(stories, by_id, chars):
    """{story_id: candidates} for every shown story with at least one openable member."""
    out = {}
    for story in stories:
        candidates = body_candidates(story, by_id, chars)
        if candidates:
            out[story.id] = candidates
    return dict(sorted(out.items()))


def reader_photos(stories, by_id=None):
    """{article_id: [url, width, height, credit]} for each article the reader can open
    in a shown story (U1: any member, not only the lead) whose own photo is hero-worthy
    (S39): the article's own photo, never one borrowed from another outlet in its
    cluster, in the D2 hero box."""
    by_id = by_id or {}
    photos = {}
    for story in stories:
        members = [by_id[aid] for aid in story.article_ids if aid in by_id] or [story.lead]
        for article in members:
            aid = body_id(article)
            image = article.get("image")
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
    it shows.

    H6 item 3: `independent` is visible_source_count (empty mute set, the build's own
    default profile), the same fold-a-wire-copy-group-to-one definition the row's own
    "N sources" and V1's carousel use, not the cluster's `independent_sources` field
    (fanout.py's fetch-time syndication-table count, not this cluster's own detected
    duplicates), which could and did disagree on a wire copy."""
    article_ids = cluster.get("article_ids", [])
    outlets = coverage_outlet_count(article_ids, by_id)
    members = [by_id[aid] for aid in article_ids if aid in by_id]
    independent = visible_source_count(members, cluster.get("near_duplicates", []), ())
    leans = len(cluster.get("lean_buckets", []))
    lean_word = "lean" if leans == 1 else "leans"
    return f"{outlets} outlets, {independent} independent, across {leans} {lean_word}"


def version_deks(pool):
    """V1: {article_id: dek} for every article of a cluster of 2 or more independent
    sources that has a dek worth showing, fitted to the hero's budget (the slide sets
    its headline in the hero type), so the versions carousel paints every slide from the
    page itself, nothing fetched (docs/DESIGN-bundles.md section 5). Typeset as the
    build sets deks; sorted by id for a byte-stable page."""
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    ids = {aid for c in pool.get("clusters", []) if c.get("independent_sources", 0) > 1
           for aid in c.get("article_ids", [])}
    out = {}
    for aid in sorted(ids):
        article = by_id.get(aid)
        text = fit_dek(clean_dek(article), dek_budget("hero")) if article else ""
        if text:
            out[aid] = smart_quotes(text)
    return out


LOCALITY_TIERS = ("local", "intermediate", "overseas")


def version_locality(pool):
    """B4: {article_id: tier} for the same carousel members as version_deks, from each
    article's `locality` (local, intermediate or overseas, fetcher/locality.py), which
    versions.js localityLabel reads so each slide names its tier. An article the cron
    left unlabeled is absent; sorted by id for a byte-stable page."""
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    ids = {aid for c in pool.get("clusters", []) if c.get("independent_sources", 0) > 1
           for aid in c.get("article_ids", [])}
    return {aid: by_id[aid]["locality"] for aid in sorted(ids)
            if aid in by_id and by_id[aid].get("locality") in LOCALITY_TIERS}


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
)

# S26: the Saved screen. The device fills #saved-list from S24's savesStore
# (js/saved-screen.js), the same card the river uses (STORY below, reused verbatim), so
# the build only lays out static chrome here: nothing to hydrate, nothing that can ever
# mismatch.
#
# S34: #saved-segment, static chrome like the rest of this view (the seam S26 left
# empty and hidden), is now the Saved | History segmented control, in the section
# tabs' own quiet style (the shared .tab look, R34); saved-screen.js only toggles
# aria-selected and which panel shows. #history-panel is the History segment's own
# static chrome: a search field and the Seen filter's toggle, a river list grouped by
# day (saved-screen.js fills #history-groups), its own empty state, and Clear history
# at the bottom. Nothing here reads history (device-only, R23); the device fills every
# data-bearing part.
SAVED_VIEW = """<section class="screen screen--view" id="screen-saved" data-screen="saved" aria-labelledby="saved-title">
<div class="view view--saved">
<h1 class="view-title" id="saved-title">Saved</h1>
<div class="saved-segment" id="saved-segment" role="tablist" aria-label="Saved, History">
<button type="button" class="tab saved-segment-tab" id="segment-saved" role="tab" aria-selected="true" aria-controls="saved-panel">Saved</button>
<button type="button" class="tab saved-segment-tab" id="segment-history" role="tab" aria-selected="false" aria-controls="history-panel">History</button>
</div>
<div class="saved-panel" id="saved-panel" role="tabpanel" aria-labelledby="segment-saved">
<div class="empty" id="saved-empty">
<p class="empty-head">Nothing saved yet</p>
<p class="empty-text">Stories you save will wait here, and the ones with full text stay readable offline.</p>
</div>
<ol class="river river--top saved-list" id="saved-list" hidden></ol>
</div>
<div class="history-panel" id="history-panel" role="tabpanel" aria-labelledby="segment-history" hidden>
<div class="history-controls">
<input type="search" class="history-search" id="history-search" placeholder="Search history" aria-label="Search history">
<button type="button" class="history-seen" id="history-seen-toggle" role="switch" aria-checked="false">Seen</button>
</div>
<div class="empty" id="history-empty" hidden>
<p class="empty-head" id="history-empty-head">Nothing opened yet</p>
<p class="empty-text" id="history-empty-text">Stories you open will be grouped here by day, so one the algorithm quietly deprioritizes is never really gone.</p>
</div>
<div class="history-groups" id="history-groups" hidden></div>
<button type="button" class="history-clear" id="history-clear" hidden>Clear history</button>
</div>
</div>
</section>"""


def _chrome(sections):
    # S33: a slot section (only "live" today) starts hidden like any other until its
    # own slice fills it; once it can (an event is live or pinned, so rankPages gave it
    # ids) it renders shown from the first paint, deterministic at build, no client-side
    # toggle-after-paint and so no layout shift in the strip.
    tabs, panels = [], []
    for index, section in enumerate(sections):
        hidden = " hidden" if section.get("slot") and not section.get("ids") else ""
        tabs.append(TAB.format(id=escape(section["id"], quote=True), label=escape(section["label"], quote=False),
                               label_attr=escape(section["label"], quote=True),
                               selected="true" if index == 0 else "false", tabindex="0" if index == 0 else "-1",
                               hidden=hidden))
        if index:
            panels.append(PANEL.format(id=escape(section["id"], quote=True), hidden=hidden))
    views = "\n".join(VIEW.format(id=v, title=t, head=h, text=x) for v, t, h, x in VIEWS) + "\n" + SAVED_VIEW
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
# S14: the coverage view trigger; V1: it opens the versions carousel (js/versions-view.js),
# whose footer opens the coverage view. It never changes what the meta line shows (still
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
                   'aria-haspopup="dialog" aria-label="Compare versions: {label}"></button>')
# One row shape for every tier; the tier only changes classes, whether a dek shows and
# whether a photo shows. The photo goes first inside .story-body; its box is sized by
# width, height and aspect-ratio before a byte arrives (style.css), so text never moves.
STORY = (
    '<li class="story story--{tier}" data-sid="{sid}">{open}'
    '<span class="story-body">{media}<span class="headline{headline_mod}">{title}</span>{dek}'
    '<span class="meta">{meta}</span></span>{close}{lean_hit}' + STORY_OVERFLOW + "{coverage}{other}</li>"
)
# S13 other-side slot: one attached link under a many-outlet card, to the same story as
# an outlet of the lean least seen on this page tells it (app/static/js/passes.js says
# which and why). Its own link beside the card's, never inside it. tiers.js draws the
# same markup on the device. Built only for clusters of OTHER_SIDE_MIN_SOURCES or more
# independent sources, the design's floor, so the page carries link data for no others.
# U3: the label names the outlet and then its marker, the same one its rows show
# (app/lean.py), never the lean in words; the marker's tap target is a sibling after the
# link (lean-hit--other), as a row's is after the row's link.
OTHER_SIDE_MIN_SOURCES = 3  # passes.js OTHER_SIDE_MIN_SOURCES
OTHER = ('<{tag} class="other-side" data-aid="{aid}"{href}>'
         '<span class="other-side-label"><span class="other-side-kicker">Other side {dot} </span>'
         '<span class="other-side-source">{source}</span>{marker}</span>'
         '<span class="other-side-title">{title}</span></{tag}>{hit}')
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
# Dek line limits live with the lead rule in app.frontpage (D1); re-exported here. U1:
# every tier carries a dek; rank-gate.js hides the rows' for display.summaries "top".
DEK_TIERS = tuple(DEK_LINES) + tuple(ROW_DEK_LINES)
# U1: a quiet mark in the meta line on a row that opens in the app's reader. R43: the
# row names the outlet whose full text opens, the member best_member picks: the row's
# own source when that is the one (the name already leads the line), else after the
# mark, "Read here · Reuters". rerank.js re-picks before first paint for a stored
# profile's trust, and the reader opens exactly the row's data-body, so the row and the
# reader always agree.
READ_HERE = "Read here"


def _parse_time(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def relative_age(published_at, now):
    """'12 min ago', '3h ago', '2d ago' relative to the pool's generated_at."""
    then = _parse_time(published_at)
    if then is None or now is None:
        return ""
    minutes = max(0, int((now - then).total_seconds() // 60))
    if minutes < 60:
        return f"{max(minutes, 1)} min ago"
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


META_SEP = f'<span class="meta-sep"> {MIDDOT} </span>'


def _meta(story, source_names, now, read_from=None, lean=None, country=None, visible_sources=None):
    """U3 (R45): the meta as two lines, the second shown only when it has something.
    Line 1 is who and when: the source, its marker (L1, U3), the age. Line 2 is what the
    row offers: the quiet 'N sources' of a multi-outlet cluster (S14's coverage trigger
    lies over it), then (U1) 'Read here' when the row opens in the reader, and (R43) the
    other outlet's name when the text that opens is not the row's own (`read_from` is ''
    for the row's own outlet). Which line holds what is fixed by the content alone, never
    by width, so the build and every device redraw agree on the line count before first
    paint. Line 2 also carries the age as data-age: where the meta sits beside a river
    thumbnail, too narrow for the name and the age on one line, style.css leads line 2
    with it instead (every row there takes the second line). Only the outlet names may
    truncate (style.css); the source count and the age never do.

    H4 item 3: `visible_sources` (app.frontpage.visible_source_count) is the count the
    versions carousel would actually show, outlets the viewer muted left out; it falls
    back to story.independent_sources when the caller has none (build's own default
    profile mutes nothing, so the two agree there). The device re-rank (js/rerank.js)
    recomputes this per row for the stored profile's real mutes and rewrites the same
    span, so the row and the carousel never disagree."""
    article = story.lead
    source = source_names.get(article.get("source_id"), "")
    age = relative_age(article.get("published_at"), now)
    first = []
    if source:
        first.append(f'<span class="meta-source">{escape(source)}</span>')
        first.append(lean_marker_html(lean, country))
    if age:
        if source:
            first.append(META_SEP)
        first.append(f'<span class="meta-age">{escape(age)}</span>')
    second = []
    shown = story.independent_sources if visible_sources is None else visible_sources
    if shown > 1:
        second.append(META_SEP + f'<span class="meta-count">{shown} sources</span>')
    if read_from is not None:
        second.append(META_SEP + f'<span class="meta-read"><span class="meta-read-label">{READ_HERE}</span></span>')
        if read_from:
            second.append(f'<span class="meta-read-source">{escape(read_from)}</span>')
    data_age = f' data-age="{escape(age, quote=True)}"' if age else ""
    return (f'<span class="meta-line">{"".join(first)}</span>'
            f'<span class="meta-line meta-line--2"{data_age}>{"".join(second)}</span>')


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


def _other_side(record, links, source_names, leans, countries=None):
    """The attached other-side link for a row, or '' (see OTHER)."""
    if not record or record["article_id"] not in links:
        return ""
    url, title = links[record["article_id"]]
    sid = record["source_id"]
    lean = record.get("lean") or leans.get(sid)
    country = (countries or {}).get(sid)
    return OTHER.format(
        tag="a" if url else "span", aid=escape(record["article_id"], quote=True),
        href=OTHER_HREF.format(url=escape(url, quote=True)) if url else "", dot=MIDDOT,
        source=escape(source_names.get(sid, sid), quote=False), marker=lean_marker_html(lean, country),
        title=escape(title, quote=False), hit=lean_hit_html(sid, lean, country, "lean-hit--other"))


def _render_story(story, tier, source_names, now, by_id, other="", coverage="", chars=None, leans=None,
                  countries=None, visible_sources=None):
    article = story.lead
    source_id = article.get("source_id")
    lean = (leans or {}).get(source_id)
    country = (countries or {}).get(source_id)
    title = escape(smart_quotes(article["title"]), quote=False)
    dek = ""
    if tier in DEK_TIERS:
        text = fit_dek(clean_dek(article), dek_budget(tier), dek_clamp(tier))
        if text:
            dek = DEK.format(dek=escape(smart_quotes(text), quote=False))
    url = _safe_url(article.get("url"))
    aid = None
    read_from = None
    if url is None:
        open_, close = '<span class="story-link">', "</span>"
    else:
        # U1: the member the reader opens (lead first, then trust, then length).
        aid = best_member(body_candidates(story, by_id, chars or {}), article.get("id"))
        body = f' data-body="{escape(aid, quote=True)}"' if aid else ""
        if aid:
            member = (by_id.get(aid) or article).get("source_id")
            read_from = source_names.get(member, "") if member != source_id else ""
        open_ = (f'<a class="story-link" href="{escape(url, quote=True)}" '
                 f'target="_blank" rel="noopener noreferrer"{body}>')
        close = "</a>"
    return STORY.format(
        tier=tier.replace("_", "-"), sid=escape(story.id, quote=True), open=open_, close=close, headline_mod=HEADLINE_MOD[tier],
        title=title, dek=dek, meta=_meta(story, source_names, now, read_from=read_from, lean=lean, country=country,
                                          visible_sources=visible_sources),
        other=other, coverage=coverage,
        lean_hit=lean_hit_html(source_id, lean, country) if source_names.get(source_id) else "",
        media=_media(tier, hero_media(_members(story, by_id), article, source_names) if tier == "hero" else None,
                     article.get("image")),
    )


def _fitted_deks(article):
    """An article's fitted dek for the hero, a lead block and a row (river or text-only,
    U1), in that order, trailing repeats dropped ([hero] when all three agree); None when
    it has no dek worth showing."""
    dek = clean_dek(article)
    if not dek:
        return None
    fitted = [smart_quotes(fit_dek(dek, dek_budget(t), dek_clamp(t))) for t in ("hero", "secondary", "river")]
    while len(fitted) > 1 and fitted[-1] == fitted[-2]:
        fitted.pop()
    return fitted


def _dek_pairs(stories):
    """Each story's fitted deks (_fitted_deks of its lead), so the device can move any
    row to any tier without re-fitting text (js/tiers.js dekFor)."""
    pairs = {}
    for story in stories:
        fitted = _fitted_deks(story.lead)
        if fitted:
            pairs[story.id] = fitted
    return pairs


def face_records(stories, by_id, source_names, now, bv):
    """B5: {article_id: {t, a, d?, i?}} for every member of each shown scored story (one
    whose face is picked by best version, frontpage.face_of), so the device can front
    the row with any of them before first paint when the stored profile's trust or
    mutes pick another face (js/tiers.js placeFace): the headline typeset as the build
    sets it (t), the row's age (a), the fitted deks (d, as _dek_pairs) and the photo
    record (i, as _image_records: the hero may borrow another outlet's photo, D2). The
    same bytes the build would have written for that face. Sorted by id."""
    out = {}
    for story in stories:
        members = _members(story, by_id)
        if not any(a["id"] in bv for a in members):
            continue
        for article in members:
            record = {"t": smart_quotes(article.get("title", "")), "a": relative_age(article.get("published_at"), now)}
            deks = _fitted_deks(article)
            if deks:
                record["d"] = deks
            media = media_for(hero_media(members, article, source_names), article.get("image"))
            if media:
                record["i"] = media
            out[article["id"]] = record
    return dict(sorted(out.items()))


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


def _rank_input_json(pool, stories, by_id, source_names, links, chars=None, now=None):
    """The device's ranking input as template text. Only &, < and > are escaped, so no
    feed string can close the template or open a tag (R26); JSON quotes stay readable.
    S13: buckets, leans and names for the passes, and the other-side link data. S14:
    ownership labels and the url/has_body pair the coverage view needs, kept apart from
    the ranker's own compact article fields (rank_input) so that input never changes
    shape."""
    data = {"now": pool.get("generated_at"), "pool": rank_input(pool), "deks": _dek_pairs(stories),
            "images": _image_records(stories, by_id, source_names), **pass_input(pool), "links": links,
            "reader": reader_photos(stories, by_id), "bodies": reader_bodies(stories, by_id, chars or {}),
            "ownership": source_ownership(pool), "countries": source_countries(pool),
            "coverage": coverage_articles(pool), "vdeks": version_deks(pool),
            "locality": version_locality(pool),
            "fronts": face_records(stories, by_id, source_names, now, version_bv(pool))}
    return escape(json.dumps(data, ensure_ascii=False, separators=(",", ":")), quote=False)


def render(pool, ranking=None, chars=None):
    """The front page. `chars` is body_chars() of the run's bodies/ (U1: the longest
    body breaks a tie between members the reader could open); None reads as none."""
    now = _parse_time(pool.get("generated_at"))
    source_names = {s["id"]: s.get("name", "") for s in pool.get("sources", [])}
    by_id = {a["id"]: a for a in pool["articles"]}
    clusters_by_id = {c["id"]: c for c in pool.get("clusters", [])}
    ranking = ranking or run_ranker(pool)
    tiers = front_page(pool, ranking)
    shown_stories = [s for name in tiers for s in tiers[name]]
    links = other_side_links(pool, shown_stories)
    leans = pass_input(pool)["leans"]
    countries = source_countries(pool)
    others = {r["id"]: _other_side(r.get("other_side"), links, source_names, leans, countries)
              for r in ranking["ranked"]}
    coverages = {
        sid: STORY_COVERAGE.format(sid=escape(sid, quote=True),
                                    label=escape(coverage_summary_text(cluster, by_id), quote=True))
        for sid, cluster in clusters_by_id.items() if cluster.get("independent_sources", 0) > 1
    }

    def row(story, tier):
        # V1: the trigger lies over the row's own "N sources", so a row shows it only
        # when that count shows (two or more versions); a cluster whose members are all
        # one syndicated copy has one version and no carousel.
        # H4 item 3: the shown count is outlets the build's own (mute-free) default
        # profile would leave visible; a single-article story never has a cluster entry.
        cluster = clusters_by_id.get(story.id)
        visible = (visible_source_count(_members(story, by_id), cluster.get("near_duplicates", []), ())
                   if cluster is not None else 1)
        coverage = coverages.get(story.id, "") if story.independent_sources > 1 else ""
        return _render_story(story, tier, source_names, now, by_id, others.get(story.id, ""),
                              coverage, chars, leans, countries, visible_sources=visible)

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
        versions=VERSIONS,
        reader=READER,
        sheet=SHEET,
        toast=TOAST,
        rank_key=escape(ranking["key"], quote=True),
        notices=render_notices(ranking.get("notices", [])),
        rank_input=_rank_input_json(pool, shown_stories, by_id, source_names, links, chars, now),
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
    # U1: the fetcher writes bodies/ beside the pool (fetcher.fanout main).
    chars = body_chars(pool_path.parent / "bodies")
    (out / "index.html").write_text(render(pool, ranking, chars), encoding="utf-8")
    _copy_static(out)
    # S17: the Health screen, off the You tab, built the same way as the front page
    # (the pool's own ledger and source_health, embedded once, at build time).
    (out / "health.html").write_text(render_health(pool), encoding="utf-8")
    # U2: the You page's source picker reads names, groups, leans and health from here.
    write_source_catalog(pool, out)
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
    print(today_top_line(pool, ranking))
    return 0


def today_top_line(pool, ranking, n=12):
    """B7: Today's first n stories as ids only (the log is public): story id, articles in
    it, and its S32 event, plus how many of the n share the most common event. A story's
    headlines can be looked up by id in a candidate dump."""
    size = {c["id"]: len(c["article_ids"]) for c in pool.get("clusters", [])}
    event_of = {cid: e["id"] for e in pool.get("events", []) for cid in e["cluster_ids"]}
    top = [r["id"] for r in ranking["ranked"][:n]]
    rows = [[sid, size.get(sid, 1), event_of.get(sid)] for sid in top]
    counts = {}
    for _, _, ev in rows:
        if ev:
            counts[ev] = counts.get(ev, 0) + 1
    most = max(counts.values(), default=0)
    return f"today_top{n}: largest_event_share={most} stories={json.dumps(rows)}"


if __name__ == "__main__":
    sys.exit(main())
