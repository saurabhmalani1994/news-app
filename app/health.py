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
import re
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


def _quantity(n, word, plural=None):
    return f"{n} {word if n == 1 else (plural or word + 's')}"


def watch_line(counts):
    """H4 item 7: W2's watch ledger (fetcher/fanout.py counts["watch"]) as one quiet,
    counts-only line, '' when the run carried no watch block at all (an older pool, or
    one with no watch list configured). Never the query text itself (fetcher/watch.py's
    "queries" is already just a length, not the list) or the per-query drop reasons:
    the watch list is the owner's own private set of interests, not something this
    screen repeats back, even to itself."""
    watch = (counts or {}).get("watch")
    if not watch:
        return ""
    bits = [_quantity(watch.get("queries", 0), "query", "queries")]
    if watch.get("published"):
        bits.append(f"{watch['published']} published")
    if watch.get("over_budget"):
        bits.append(f"{watch['over_budget']} over budget")
    errors = sum((watch.get("errors") or {}).values())
    if errors:
        bits.append(_quantity(errors, "error"))
    return "Watch: " + ", ".join(bits) + "."


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
<!-- S34: crossorigin="use-credentials" so this fetch carries the Access cookie behind
     Cloudflare Access, same as build.py's own index.html link. -->
<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="style.css">
<link rel="stylesheet" href="profile.css">
<script src="js/sw-register.js" defer></script>
<script type="module" src="js/jev/read-stats-view.js"></script>
</head>
<body>
<header class="masthead">
<a class="masthead-back" href="/profile" aria-label="Back to profile">
<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg>
</a>
<h1 class="wordmark">Feed health</h1>
</header>
<main class="settings" id="health-root">
<section class="notice health-age-block" id="pool-age-block">
<p class="notice-kicker">Pool</p>
<p class="notice-head" id="pool-age" data-generated-at="{generated_at}">Updated {build_age}.</p>
<p class="notice-text">{summary_line}</p>{watch_line}
</section>
{ledger}
<section class="settings-section" aria-labelledby="sources-label">
<h2 class="settings-label" id="sources-label">Sources</h2>
<p class="settings-hint">Unhealthy and failing sources first, then the rest grouped by bucket.</p>
{sources}
</section>
{jev}
<section class="settings-section" aria-labelledby="jev-reading-label" id="jev-reading" hidden>
<h2 class="settings-label" id="jev-reading-label">Your reading with Jev</h2>
<p class="settings-hint">From your own Read with Jev use on this phone, never sent anywhere: how the marks spread, and whether you used Skim or Hide marks.</p>
<div id="jev-reading-rows"></div>
</section>
</main>
<footer class="colophon"><p class="colophon-text">Read from the pool generated <time datetime="{generated_at}">{generated_label}</time>.</p></footer>
<script src="js/health-age.js"></script>
<nav class="bottom-nav bottom-nav--fixed" aria-label="Primary">
<a class="nav-item" href="/#home" data-screen="home"><svg class="nav-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3.2 2.6 11.3h2.8v9.5h5.1v-6h3v6h5.1v-9.5h2.8z"></path></svg><span class="nav-label">Home</span></a>
<a class="nav-item" href="/#following" data-screen="following"><svg class="nav-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 2.6 2.4 7.8 12 13l9.6-5.2zM4.7 11.2l-2.3 1.3L12 17.7l9.6-5.2-2.3-1.3L12 15.1zM4.7 15.9l-2.3 1.3L12 22.4l9.6-5.2-2.3-1.3L12 19.8z"></path></svg><span class="nav-label">Following</span></a>
<a class="nav-item" href="/#saved" data-screen="saved"><svg class="nav-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6.2 2.6h11.6c.5 0 .9.4.9.9v18.1L12 17.1l-6.7 4.5V3.5c0-.5.4-.9.9-.9z"></path></svg><span class="nav-label">Saved</span></a>
<a class="nav-item" href="/profile" data-screen="you" aria-current="page"><svg class="nav-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 11.6a4.3 4.3 0 1 0 0-8.6 4.3 4.3 0 0 0 0 8.6zm0 2.1c-4.8 0-8.4 2.6-8.4 6.2v1.5h16.8v-1.5c0-3.6-3.6-6.2-8.4-6.2z"></path></svg><span class="nav-label">You</span></a>
</nav>
</body>
</html>"""


# J3: the Jev report (fetcher/jev_shadow.py, dist/jev.json beside the pool), when a
# shadow run wrote one. Every number is a count; every title is escaped text (R26).


LEDGER_ROW_STACKED = ('<div class="setting-row setting-row--stack jev-row-long"><div class="setting-row-text">'
                      '<span class="setting-label">{label}</span>'
                      '<span class="setting-sublabel">{value}</span></div></div>')


def _of(part, whole):
    pct = f" ({round(100 * part / whole)}%)" if whole else ""
    return f"{part} of {whole}{pct}"


# J8, J10: every article Jev read, in its own accordion (closed until tapped), grouped:
# where Jev and the rules disagree about AI first, then every article, newest first.
# Each headline opens the story inside Almanac (/#story-<id>: Home, scrolled to its card),
# never the publisher's page; a story with several versions also links to them
# (/#bundle-<id>). Each shows the rules' own tags beside Jev's answers, with how sure
# Jev was (the bands of app/static/js/jev/decide.js). Headlines and outlet names are
# feed text, escaped (R26). Static markup only, no script.
JEV_ARTICLES = """<details class="settings-section jev-accordion" id="jev-articles">
<summary class="settings-label jev-accordion-head">Articles Jev read ({count})</summary>
<p class="settings-hint">{hint}</p>
{groups}
</details>"""
JEV_GROUP = """<details class="jev-group"{open}>
<summary class="settings-hint jev-group-head">{title} ({count})</summary>
{rows}
</details>"""
JEV_ARTICLE_ROW = ('<div class="setting-row setting-row--stack jev-article" data-article="{id}">'
                   '<div class="setting-row-text">{title}'
                   '<span class="setting-sublabel">{meta}</span>'
                   '<span class="setting-sublabel jev-article-answers">{answers}</span>{about}{versions}'
                   '</div></div>')
ABOUT_LABELS = (("ai", "AI"), ("hard_news", "hard news"), ("clinical", "clinical medicine"),
                ("industrial_biotech", "industrial biotech"))
SENTIMENT_SHOWN = {"Good news": "Good news", "Bad news": "Bad news", "Both good and bad news": "Mixed",
                   "Neither good nor bad news": "Neutral"}
_SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,80}$")


def _sure_word(answer):
    """sure, leaning, split or unsure, from the pick, its confidence and the top-two gap."""
    probs = sorted((answer.get("p") or {}).values(), reverse=True)
    c = answer.get("c")
    if len(probs) > 1 and probs[0] - probs[1] < 0.15:
        return "split"
    if c is None:
        return ""
    return "sure" if c >= 0.6 else "leaning" if c >= 0.4 else "unsure"


def _choice_text(name, answer, shown=None):
    if not isinstance(answer, dict) or answer.get("t") != "choice":
        return ""
    pick = (shown or {}).get(answer["v"], answer["v"])
    word, c = _sure_word(answer), answer.get("c")
    detail = ", ".join(x for x in (word, f"{round(100 * c)}%" if isinstance(c, (int, float)) else "") if x)
    return f"{name} {pick}" + (f" ({detail})" if detail else "")


def _almanac_link(sid, text):
    """The headline as a link into Almanac's own front page, or plain text for an id
    the address rule would refuse."""
    if not _SAFE_ID.match(sid or ""):
        return f'<span class="setting-label">{_esc(text)}</span>'
    return f'<a class="setting-label jev-article-title" href="/#story-{sid}">{_esc(text)}</a>'


def _jev_likely(ans, key):
    a = ans.get(key)
    return isinstance(a, dict) and a.get("t") == "noul" and a["v"] >= 0.7


# J22: where an article's section comes from. The rules tag every article (fetcher
# topics); Jev answers one section per article. Each Jev section maps to the rule topics
# that mean the same thing (js/jev/sorted-by.js SECTION_TOPICS is the same map).
SECTION_TOPICS = {
    "US politics": ("us_politics", "politics"), "World": ("world", "conflict"), "Singapore": ("singapore",),
    "Asia": ("asia",), "AI and technology": ("ai",), "Industrial biotech": ("biotech", "foodtech", "climate_tech"),
    "Business and economy": ("economy",), "Science and health": ("science",), "Climate and environment": ("climate_tech",),
}
TOPIC_WORDS = {"world": "World", "politics": "Politics", "conflict": "Conflict", "asia": "Asia",
               "us_politics": "US politics", "climate_tech": "Climate tech", "foodtech": "Food tech",
               "science": "Science", "ai": "AI", "biotech": "Biotech", "economy": "Economy", "singapore": "Singapore"}
SORTED_BY = {"both": "Rules + Jev", "rules": "Rules only", "jev": "Jev suggests another section"}


def sorted_by(article, ans):
    """("both" | "rules" | "jev", sentence): whether the rules' tags and Jev's section
    agree. Jev counts only when it was sure or leaning; otherwise the rules stand alone."""
    rules = [t for t in (article.get("topics") or [])]
    rule_words = ", ".join(TOPIC_WORDS.get(t, t) for t in rules) or "none"
    a = (ans or {}).get("section")
    word = _sure_word(a) if isinstance(a, dict) and a.get("t") == "choice" else ""
    if word not in ("sure", "leaning"):
        why = "Jev was not sure" if word else "Jev has not answered"
        return "rules", f"Rules only: {rule_words}. {why}."
    if set(SECTION_TOPICS.get(a["v"], ())) & set(rules):
        return "both", f"Rules + Jev: both say {a['v']}."
    return "jev", f"Rules say {rule_words}. Jev says {a['v']} ({word})."


def render_jev_articles(doc, pool, now=None):
    """The "Articles Jev read" accordion, or '' when there are none."""
    answers = (doc or {}).get("answers") if isinstance(doc, dict) else None
    if not isinstance(answers, dict) or not answers:
        return ""
    names = source_names(pool)
    by_id = {a["id"]: a for a in pool.get("articles", [])}
    story_of, size = {}, {}
    for c in pool.get("clusters", []):
        for i in c.get("article_ids", []):
            story_of[i] = c["id"]
        size[c["id"]] = len(c.get("article_ids", []))
    read = sorted((by_id[i] for i in answers if i in by_id), key=lambda a: (a.get("published_at", ""), a["id"]), reverse=True)
    now = now or _parse_time(pool.get("generated_at", ""))

    def row(a):
        ans = answers[a["id"]]
        sid = story_of.get(a["id"], a["id"])
        published = _parse_time(a.get("published_at", ""))
        age = _relative_age((now - published).total_seconds()) if now and published else ""
        meta = _esc(" · ".join(x for x in (names.get(a.get("source_id"), a.get("source_id", "")), age) if x))
        kind, sentence = sorted_by(a, ans)
        meta += f' · <span class="jev-sorted jev-sorted--{kind}">{_esc(SORTED_BY[kind])}</span>'
        about_sort = f'<span class="setting-sublabel">{_esc(sentence)}</span>'
        parts = [_choice_text("Region", ans.get("region")),
                 _choice_text("", ans.get("sentiment"), SENTIMENT_SHOWN).strip()]
        likely = [f"{label} {round(100 * ans[key]['v'])}%" for key, label in ABOUT_LABELS if _jev_likely(ans, key)]
        about = f'<span class="setting-sublabel">Likely about: {_esc(", ".join(likely))}</span>' if likely else ""
        versions = (f'<a class="setting-sublabel jev-article-versions" href="/#bundle-{sid}">'
                    f'All {size[sid]} versions in Almanac</a>') if size.get(sid, 1) > 1 and _SAFE_ID.match(sid) else ""
        return JEV_ARTICLE_ROW.format(
            id=_html.escape(a["id"], quote=True), title=_almanac_link(sid, a.get("title", "")),
            meta=meta, answers=_esc(" · ".join(x for x in parts if x) or "No usable answers"),
            about=about_sort + about, versions=versions)

    jev_only = [a for a in read if _jev_likely(answers[a["id"]], "ai") and "ai" not in (a.get("topics") or [])]
    rules_only = [a for a in read if "ai" in (a.get("topics") or []) and "ai" in answers[a["id"]]
                  and not _jev_likely(answers[a["id"]], "ai")]
    groups = []
    kinds = {a["id"]: sorted_by(a, answers[a["id"]])[0] for a in read}
    for title, items, is_open in (("Rules + Jev agree on the section", [a for a in read if kinds[a["id"]] == "both"], False),
                                  ("Jev suggests another section", [a for a in read if kinds[a["id"]] == "jev"], False),
                                  ("Rules only (Jev not sure)", [a for a in read if kinds[a["id"]] == "rules"], False),
                                  ("Jev found AI the rules missed", jev_only, False),
                                  ("Rules tagged AI, Jev disagrees", rules_only, False),
                                  ("All articles, newest first", read, False)):
        if items:
            groups.append(JEV_GROUP.format(title=_esc(title), count=len(items), open=" open" if is_open else "",
                                           rows="\n".join(row(a) for a in items)))
    hint = ("Each article says where its section comes from: Rules + Jev (both agree), Rules only (Jev was not sure), "
            "or Jev suggests another section. Your tabs use the rules today. Tap a headline to open the story in Almanac.")
    if (doc or {}).get("mock"):
        hint += " These answers come from the local stand-in, not the real Jev."
    return JEV_ARTICLES.format(count=len(read), hint=_esc(hint), groups="\n".join(groups))


def _sorted_rows(doc):
    """J22: how many articles Jev read fall in each sorted-by group, when the report
    carries the articles' rule topics (Health's render passes the pool in)."""
    counts = doc.get("_sorted_counts")
    if not counts:
        return []
    return [(f"Sections: {SORTED_BY[k]}", str(counts.get(k, 0))) for k in ("both", "jev", "rules")]


def _budget_row(run):
    """Today's spend against the day's cap, in the route's own unit."""
    spent, cap = run.get("spent_day", 0) or 0, run.get("budget_day", 0) or 0
    if run.get("unit") == "usd":
        return ("Spent today (OpenRouter)", f"${spent:.3f} of ${cap:.2f}")
    return ("Free allowance used today", f"{spent:.0f} of {cap:.0f} neurons")


# J21: the owner found the one long list hard to read, so the Jev area is three parts:
# what Jev did today, each feature with the checks that decide it (every check says in
# plain words what it measures), and the other numbers, each with its meaning.
JEV_TODAY = """<section class="settings-section" aria-labelledby="jev-label" id="jev-report">
<h2 class="settings-label" id="jev-label">Jev today</h2>
<p class="settings-hint">{hint}</p>
{rows}
</section>"""
JEV_FEATURES = """<section class="settings-section" aria-labelledby="jev-features-label" id="jev-features">
<h2 class="settings-label" id="jev-features-label">How Jev is doing</h2>
<p class="settings-hint">How well Jev is doing at each job. A job is Good when all of its checks are Good. The aims were set before any results came in.</p>
{features}
</section>"""
JEV_FEATURE = """<div class="jev-feature">
<div class="setting-row"><div class="setting-row-text"><span class="setting-label">{name}</span><span class="setting-sublabel">{about}</span></div><span class="setting-value">{status}</span></div>
{checks}
</div>"""
JEV_CHECK = ('<div class="setting-row setting-row--stack jev-check"><div class="setting-row-text">'
             '<span class="setting-label">{label}</span>'
             '<span class="jev-verdict jev-verdict--{status}">{verdict}</span>'
             '<span class="setting-sublabel jev-check-result">{result}</span>'
             '<span class="setting-sublabel">{meaning}</span>{examples}</div></div>')
JEV_EXAMPLE = '<span class="setting-sublabel jev-example"><span class="jev-example-tag">{tag}</span> {text}</span>'
JEV_NUMBERS = """<details class="settings-section jev-accordion" id="jev-numbers">
<summary class="settings-label jev-accordion-head">More Jev numbers</summary>
{rows}
</details>"""
JEV_MEANING_ROW = ('<div class="setting-row setting-row--stack jev-row-long"><div class="setting-row-text">'
                   '<span class="setting-label">{label}: {value}</span>'
                   '<span class="setting-sublabel">{meaning}</span></div></div>')

# J22: each feature (fetcher/jev_shadow.py CHECKS) as the job it does for the reader.
FEATURE_NAMES = {
    "Versions and other side": "Grouping versions and the other side",
    "Tabs and tags": "Sorting articles into sections",
    "Analysis sheet": "Jev's read of a story",
    "Ask bar": "The Ask bar",
    "Hourly shadow run": "Reading every hour",
}
# What each feature is, in the order the page lists them.
FEATURE_ABOUT = {
    "Versions and other side": "Groups the same event from different outlets, and picks the other-side version.",
    "Tabs and tags": "Jev's own section and region for each article. For now the feed's sections still come from the rules.",
    "Analysis sheet": "Jev's read of one story, from a card's menu.",
    "Ask bar": "Changing your feed by typing a request.",
    "Hourly shadow run": "Jev reading the new articles every hour.",
}
# J22: each check in everyday words: a short name, how to count it, and why it matters.
# The owner found "syndicated copies" and "the feed's bucket" hard to follow.
CHECK_WORDS = {
    "same_event": ("Keeps copies of one story together", "copy pairs kept together",
                   "Why it matters: when two outlets run the same story, Almanac shows it as one card with versions."),
    "different_event": ("Keeps different stories apart", "unrelated pairs kept apart",
                        "Why it matters: two different stories never end up on one card."),
    "section": ("Puts articles in the right section", "articles put in their feed's section",
                "How it is checked: some feeds cover one thing only, like a Singapore news feed, so their articles should land in that section. No one labels anything by hand."),
    "region": ("Puts articles in the right region", "articles put in their feed's region",
               "How it is checked: articles from a feed that covers one region, like Europe, should land in that region."),
    "contradictions": ("Does not contradict itself", "articles with a contradiction",
                       "How it is checked: Jev is asked separately whether a story is clinical medicine and whether it is industrial biotech. Saying yes to both is a contradiction."),
    "sure": ("Is confident in most answers", "answers Jev was sure of",
             "Why it matters: the app acts only on answers Jev is sure of or leaning towards."),
    "ambiguous": ("Is rarely torn between two answers", "answers where Jev was torn",
                  "Why it matters: when Jev's top two answers are nearly tied, the app ignores that answer."),
    "latency": ("Answers quickly", "",
                "Why it matters: the Ask bar and Jev's read wait for this."),
    "cost": ("Stays cheap", "",
             "Dollars per 1,000 articles Jev reads."),
}
BUCKET_WORDS = {"singapore": "Singapore", "us_politics": "US politics", "ai": "AI", "asia": "Asia",
                "africa": "Africa", "sudan": "Sudan", "middle_east": "Middle East", "israel_gaza": "Israel and Gaza",
                "europe": "Europe", "latin_america": "Latin America"}
RUN_STATES = {"ok": "finished", "budget": "stopped at today's spending cap", "time_cap": "stopped at its time limit",
              "api_errors": "finished with errors"}
STATUS_WORD = {"pass": "Good", "fail": "Needs work", "not_enough_data": "Too early to tell"}
FEATURE_WORD = {"ready": "Good", "not_ready": "Needs work", "not_enough_data": "Too early to tell"}


def _check_result(c, counted):
    """A check's value against its aim, in everyday words: "10 of 11 copy pairs kept
    together. Aim: 90% or more." """
    more = c["direction"] == ">="
    if c["key"] == "latency":
        aim = f"Aim: {c['target'] / 1000:.1f} seconds or less."
        if c["value"] is None:
            return f"No timings yet. {aim}"
        return f"The slowest 1 in 10 answers took {c['value'] / 1000:.1f} seconds. {aim}"
    if c["key"] == "cost":
        aim = f"Aim: ${c['target']:.2f} or less."
        return f"${c['value']:.2f} per 1,000 articles. {aim}" if c["value"] is not None else f"No spending yet. {aim}"
    aim = f"Aim: {round(100 * c['target'])}% or {'more' if more else 'less'}."
    if c["value"] is None or not c["n"]:
        return f"Nothing to count yet. {aim}"
    part = round(c["value"] * c["n"])
    return f"{part} of {c['n']} {counted} ({round(100 * c['value'])}%). {aim}"


def _quote(ref):
    return f"“{ref.get('title', '')}” ({ref.get('source', '')})"


def _check_examples(c):
    """J22: a real article or pair Jev got right and one it missed, from this run."""
    ex = c.get("examples") or {}
    out = []
    for slot, tag in (("hit", "Got right:"), ("miss", "Missed:")):
        e = ex.get(slot)
        if not e:
            continue
        if c["key"] in ("same_event", "different_event"):
            text = f"{_quote(e['a'])} and {_quote(e['b'])}. Jev: {round(100 * e.get('p', 0))}% sure they are the same event."
        else:
            feed = BUCKET_WORDS.get(e.get("bucket"), e.get("bucket", ""))
            text = f"{_quote(e)}, from a {feed} feed. Jev said {e.get('got', '')}."
        out.append(JEV_EXAMPLE.format(tag=_esc(tag), text=_esc(text)))
    return "".join(out)


def _jev_features(card):
    """The features section: each feature, its status, then each of its checks."""
    checks = card.get("checks") or []
    if not checks:
        return ""
    order = []
    for c in checks:
        if c["feature"] not in order:
            order.append(c["feature"])
    out = []
    for feature in order:
        rows = []
        for c in (c for c in checks if c["feature"] == feature):
            label, counted, meaning = CHECK_WORDS.get(c["key"], (c["label"], "", ""))
            rows.append(JEV_CHECK.format(label=_esc(label), status=_esc(c["status"]).replace("_", "-"),
                                         verdict=_esc(STATUS_WORD.get(c["status"], "")),
                                         result=_esc(_check_result(c, counted)), meaning=_esc(meaning),
                                         examples=_check_examples(c)))
        out.append(JEV_FEATURE.format(name=_esc(FEATURE_NAMES.get(feature, feature)), about=_esc(FEATURE_ABOUT.get(feature, "")),
                                      status=_esc(FEATURE_WORD.get((card.get("features") or {}).get(feature), "")),
                                      checks="\n".join(rows)))
    return JEV_FEATURES.format(features="\n".join(out))


def render_jev(doc):
    """The Jev area of Health (today, features and checks, more numbers), or '' when
    there is no report to show."""
    if not isinstance(doc, dict) or not isinstance(doc.get("report"), dict):
        return ""
    r, run = doc["report"], doc.get("run") or {}
    ai = r["ai_rules_vs_jev"]
    ai_total = ai["both"] + ai["rules_only"] + ai["jev_only"] + ai["neither"]
    conf = r.get("confidence") or {}
    words = {"sure": "sure", "lean": "leaning", "ambiguous": "split", "unsure": "unsure", "unrated": "no confidence",
             "conflict": "self-contradicting", "missing": "unanswered"}
    conf_text = " · ".join(f"{v} {words.get(k, k)}" for k, v in sorted(conf.items(), key=lambda kv: -kv[1])) or "none yet"
    state = run.get("state", "")
    state_text = RUN_STATES.get(state) or (f"skipped ({state[8:].replace('_', ' ')})" if state.startswith("skipped_") else state)
    rows = [
        ("Model", "Local stand-in (mock)" if doc.get("mock") else doc.get("model", "")),
        ("Last hourly run", f"{state_text}: {run.get('asked', 0)} new articles read, {run.get('cached', 0)} answers reused"
                            + (f", first error {run['first_error']}" if run.get("first_error") else "")),
        ("Articles in your feed Jev has read", _of(r["articles_answered"], r["articles_in_pool"])),
        *_sorted_rows(doc),
        _budget_row(run),
    ]
    groups = r.get("groups")
    if isinstance(groups, dict):
        if groups.get("applied"):
            rows += [
                ("Story versions Jev split off as a different event", str(groups.get("split", 0))),
                ("Story groups dissolved (no two left on one event)", str(groups.get("dissolved", 0))),
                ("Versions marked for the other-side pick", str(groups.get("annotated", 0))),
            ]
        else:
            rows.append(("Story groups: not changed this run", groups.get("reason") or "no answers yet"))
    # C4: a long value (a run with its first error) wraps under its label instead of
    # running off a phone's screen.
    body = [(LEDGER_ROW_STACKED if len(value) > 28 else LEDGER_ROW).format(label=_esc(label), value=_esc(value))
            for label, value in rows]
    for ex in (groups or {}).get("examples", [])[:4] if isinstance(groups, dict) else []:
        body.append(LEDGER_ROW_STACKED.format(label=_esc(ex.get("title", "")),
                                              value=_esc(f"Split off from: {ex.get('anchor', '')} ({round(100 * ex.get('same', 0))}% the same event)")))
    hint = ("Every hour Jev reads the new articles and answers the same fixed questions about each one. "
            "Its answers change your feed in two places only: splitting a story group whose versions are not one event, "
            "and choosing the other-side version. Sections, tags and the order of your feed still come from the rules and your profile.")
    if doc.get("mock"):
        hint += " These answers come from the local stand-in, not the real Jev."
    numbers = [
        ("AI tag: rules and Jev agree", _of(ai["both"] + ai["neither"], ai_total),
         "Articles where the rules' AI tag and Jev's answer (AI likely or not) say the same thing."),
        ("AI tag: rules only", str(ai["rules_only"]),
         "The rules tagged AI, and Jev thinks it is unlikely to be about AI. Listed in Articles Jev read."),
        ("AI tag: Jev only", str(ai["jev_only"]),
         "Jev thinks it is likely about AI, and the rules missed it. Listed in Articles Jev read."),
        ("How sure Jev was", conf_text,
         "Every multiple-choice answer: sure (top pick clearly ahead), leaning (ahead, less clearly), split (top two nearly tied), unsure (no pick stands out)."),
    ]
    more = JEV_NUMBERS.format(rows="\n".join(JEV_MEANING_ROW.format(label=_esc(a), value=_esc(b), meaning=_esc(c))
                                              for a, b, c in numbers))
    return "\n".join(x for x in (JEV_TODAY.format(hint=_esc(hint), rows="\n".join(body)),
                                 _jev_features(doc.get("scorecard") or {}), more) if x)


def _relative_age(seconds):
    if seconds is None:
        return "recently"
    minutes = max(0, int(seconds // 60))
    if minutes < 60:
        return f"{max(minutes, 1)} min ago"
    if minutes < 48 * 60:
        return f"{minutes // 60}h ago"
    return f"{minutes // (24 * 60)}d ago"


def _with_sorted_counts(jev, pool):
    """The Jev doc with how many of its articles each sorted-by group holds."""
    if not isinstance(jev, dict) or not isinstance(jev.get("answers"), dict):
        return jev
    counts = {}
    for a in pool.get("articles", []):
        if a["id"] in jev["answers"]:
            kind = sorted_by(a, jev["answers"][a["id"]])[0]
            counts[kind] = counts.get(kind, 0) + 1
    return {**jev, "_sorted_counts": counts}


def render(pool, sources_path=None, now=None, jev=None):
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
    watch_text = watch_line(counts)
    return PAGE.format(
        generated_at=_esc(generated_at),
        generated_label=_esc(_fmt_time(generated_at)),
        build_age=_esc(_relative_age(age_seconds)),
        summary_line=_esc(", ".join(bits) + "."),
        watch_line=f'\n<p class="notice-text notice-text--watch" id="watch-counts">{_esc(watch_text)}</p>' if watch_text else "",
        ledger=_render_ledger(counts),
        sources=_render_sources(pool, sources_path),
        jev=render_jev(_with_sorted_counts(jev, pool)) + ("\n" + render_jev_articles(jev, pool) if jev else ""),
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
