"""B9: the trumpstruth.org archive as a lookup table, and DESIGN-bundles.md
section 3's primary source match rule. Standard library only (R30).

The archive is a third-party, unofficial RSS of Truth Social posts (Truth Social
itself has no feed and forbids automated use, so it stays off as a source). This
module never lets an archive post enter the pool: load_archive returns plain
records used only to decide whether one cluster gets a `primary_source` link.

Section 3's rule, applied per cluster (find_primary_source runs it against one
article's own text): a version's title, dek or body names "Truth Social"; it
quotes a span of 6+ words inside quotation marks; after folding case, curly
quotes and punctuation, that span appears verbatim in exactly one archived post
from the 72h before the version; that post is not a bare repost and has 6+ words
of its own. Two matching posts, or no post, means no link.

The archive going unreachable or unparseable never fails the run (R9/R11's own
rule, applied here too): load_archive returns ([], status) and the caller
publishes with no links, noting the status in the pool's ledger (counts.primary_source).
"""
import re
import socket
import urllib.error
from collections import Counter
from datetime import timedelta

from fetcher.fetch import (
    FeedError,
    _clean,
    _item_date_raw,
    _item_dek_raw,
    _item_link_raw,
    _item_title_raw,
    _plain,
    _published_at,
    fetch_feed,
    iter_feed_items,
    parse_xml,
)

TRUTH_ARCHIVE_URL = "https://trumpstruth.org/feed"
ARCHIVE_STATES = ("ok", "http_error", "timeout", "parse_error", "disabled")

MIN_QUOTE_WORDS = 6
MATCH_WINDOW = timedelta(hours=72)

MENTION_RE = re.compile(r"truth social", re.IGNORECASE)
# Straight or curly double quotes, non-greedy so "a" and "b" in one string are two spans.
QUOTE_RE = re.compile(r'"([^"]+)"|“([^”]+)”')
REPOST_RE = re.compile(r"^\s*RT\b", re.IGNORECASE)
WORD_RE = re.compile(r"[^\W_]+(?:'[^\W_]+)*", re.UNICODE)
_PUNCT_RE = re.compile(r"[^\w\s']", re.UNICODE)


def _post_text(item, kind):
    """A post's own words: its title, or its description when the title is empty
    (some archive feeds put the post text in the description instead)."""
    title = _plain(_clean(_item_title_raw(item, kind)))
    if title:
        return title
    return _plain(_clean(_item_dek_raw(item, kind)))


def parse_archive(data):
    """Raw archive feed bytes -> a list of {url, text, published_at} post records.
    Reuses fetcher.fetch's lenient XML parsing and format-aware getters, so the
    archive feed is read exactly as any other RSS/Atom/RDF feed would be. Raises
    FeedError if the feed cannot be parsed at all, even after repairs."""
    leniency = Counter()
    root = parse_xml(data, leniency)
    items, kind = iter_feed_items(root)
    posts = []
    for item in items:
        text = _post_text(item, kind)
        if not text:
            continue
        url = _item_link_raw(item, kind).strip()
        if not url.startswith("https://"):
            continue
        published = _published_at(_item_date_raw(item, kind), Counter())
        posts.append({"url": url, "text": text, "published_at": published})
    return posts


def load_archive(fetch_fn=None, url=TRUTH_ARCHIVE_URL, timeout=20):
    """Fetch and parse the archive feed. Returns (posts, status); never raises.
    status is one of ARCHIVE_STATES (minus "disabled", which the caller uses when
    it chooses not to fetch at all). A failure of any kind returns ([], status),
    so a down or broken archive costs the run no links, never the run itself."""
    if fetch_fn is None:
        fetch_fn = fetch_feed
    try:
        data = fetch_fn(url, timeout=timeout)
    except FeedError:
        return [], "http_error"
    except urllib.error.HTTPError:
        return [], "http_error"
    except (socket.timeout, TimeoutError):
        return [], "timeout"
    except urllib.error.URLError as exc:
        return [], "timeout" if isinstance(exc.reason, (socket.timeout, TimeoutError)) else "http_error"
    except OSError:
        return [], "http_error"
    try:
        return parse_archive(data), "ok"
    except FeedError:
        return [], "parse_error"


def _fold(text):
    """Case, curly quotes and punctuation folded away, whitespace collapsed, so
    a quote and its archived source match regardless of how each renders them."""
    text = text.replace("’", "'").replace("‘", "'")
    text = text.lower()
    text = _PUNCT_RE.sub(" ", text)
    return " ".join(text.split())


def _word_count(folded_text):
    return len(WORD_RE.findall(folded_text))


def _quoted_spans(text):
    return [m.group(1) or m.group(2) for m in QUOTE_RE.finditer(text)]


def _in_window(post, version_published_at):
    """True when the post's own timestamp is known, no later than the version's,
    and within MATCH_WINDOW (72h) before it. Either timestamp missing excludes
    the post: an undated post can never be verified as the version's source."""
    post_at, version_at = post.get("published_at"), version_published_at
    if not post_at or not version_at:
        return False
    if post_at > version_at:
        return False
    from datetime import datetime, timezone
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    post_dt = datetime.strptime(post_at, fmt).replace(tzinfo=timezone.utc)
    version_dt = datetime.strptime(version_at, fmt).replace(tzinfo=timezone.utc)
    return version_dt - post_dt <= MATCH_WINDOW


def find_primary_source(version_text, version_published_at, posts):
    """Section 3's rule for one article version against the archive's posts.
    version_text is the version's title, dek and body (when available), joined.
    Returns the archive url of the one matching post, or None."""
    if not posts or not MENTION_RE.search(version_text):
        return None
    spans = [_fold(s) for s in _quoted_spans(version_text)]
    spans = [s for s in spans if _word_count(s) >= MIN_QUOTE_WORDS]
    if not spans:
        return None
    eligible = []
    for post in posts:
        raw = post.get("text", "")
        if REPOST_RE.match(raw.strip()):
            continue
        folded_post = _fold(raw)
        if _word_count(folded_post) < MIN_QUOTE_WORDS:
            continue
        if not _in_window(post, version_published_at):
            continue
        eligible.append((post["url"], folded_post))
    for span in spans:
        matches = {url for url, folded_post in eligible if span in folded_post}
        if len(matches) == 1:
            return next(iter(matches))
    return None


def _article_text(article, body_html=None):
    parts = [article.get("title", ""), article.get("dek", "")]
    if body_html:
        parts.append(_plain(body_html))
    return " ".join(p for p in parts if p)


def link_clusters(clusters, by_id, bodies, posts):
    """{cluster_id: archive_url} for every cluster with a matching version, tried
    in article_ids order so the earliest-published match wins when a cluster has
    more than one qualifying version. bodies: {article_id: body record}, only for
    full_text_ok sources (fetcher.bodies); article_ids without one use title/dek."""
    links = {}
    if not posts:
        return links
    for cluster in clusters:
        for aid in cluster["article_ids"]:
            article = by_id.get(aid)
            if article is None:
                continue
            body_html = (bodies or {}).get(aid, {}).get("body_html")
            text = _article_text(article, body_html)
            url = find_primary_source(text, article.get("published_at"), posts)
            if url:
                links[cluster["id"]] = url
                break
    return links
