"""One-feed fetcher for the S01 walking skeleton. Standard library only (R30).

Reads the NPR feed, normalizes items, writes a schema-valid pool.json. Parsing is
lenient (R9): a strict parse is tried first, and only if it fails are repairs applied,
each one counted in counts.leniency. Bodies are never carried into the pool (R12).

F7: a feed is one of three formats, detected from the parsed root, not from the url
or content-type (hosts lie about both): RSS 2.0 (`<item>`, unnamespaced), Atom
(`<entry>`, `xmlns="http://www.w3.org/2005/Atom"`), or RSS 1.0 / RDF (`<item>`
namespaced under `http://purl.org/rss/1.0/`, listed as siblings of `<channel>` inside
an `<rdf:RDF>` root). iter_feed_items finds the right item elements for whichever
format the feed actually is; the four per-field getters below (_item_title_raw,
_item_link_raw, _item_date_raw, _item_dek_raw) read the right child elements for that
format, matched by local name so the feed's own namespace prefix (or lack of one)
never matters. RSS 2.0 extraction is byte-for-byte the same call shape as before this
change, so existing behavior for the other 92 sources is untouched. Every format
still runs through the same _clean/_plain/_published_at pipeline below, so R9
leniency (a non-RFC822 date, markup in a title...) is counted exactly as it always
was, whichever format produced the raw string.

Usage: python -m fetcher.fetch --out dist/pool.json [--limit 5]
"""
import argparse
import hashlib
import html
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.entities import name2codepoint
from pathlib import Path

from contract.validate import validate

SOURCE = {"id": "npr", "name": "NPR", "feed_url": "https://feeds.npr.org/1001/rss.xml"}
USER_AGENT = "AlmanacFetcher/0.1 (personal news reader)"
MAX_BYTES = 5_000_000
TITLE_MAX = 500
DEK_MAX = 2000
XML_ENTITIES = {"amp", "lt", "gt", "quot", "apos"}
TAG_RE = re.compile(r"<[^>]*>")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
BARE_AMP_RE = re.compile(r"&(?!#[0-9]+;|#x[0-9a-fA-F]+;|[A-Za-z][A-Za-z0-9]*;)")
NAMED_ENTITY_RE = re.compile(r"&([A-Za-z][A-Za-z0-9]*);")
DECL_ENCODING_RE = re.compile(rb"^\s*<\?xml[^>]*encoding=[\"']([A-Za-z0-9._-]+)[\"']")


class FeedError(Exception):
    pass


FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5"

ATOM_NS = "http://www.w3.org/2005/Atom"
RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"


def fetch_feed(url, timeout=20):
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": FEED_ACCEPT}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise FeedError(f"feed larger than {MAX_BYTES} bytes")
    return data


def _repair(data, leniency):
    """Apply counted repairs to a feed that failed a strict parse. Returns UTF-8 bytes."""
    m = DECL_ENCODING_RE.match(data)
    declared = m.group(1).decode("ascii") if m else "utf-8"
    try:
        text = data.decode(declared)
    except (LookupError, UnicodeDecodeError):
        text = data.decode("cp1252", errors="replace")
        leniency["encoding_fallback"] += 1
    text = text.lstrip(chr(0xFEFF))  # byte order mark
    start = text.find("<")
    if start > 0 and text[:start].strip():
        leniency["leading_junk"] += 1
    text = text[start:] if start >= 0 else text
    text, n = CONTROL_RE.subn("", text)
    if n:
        leniency["control_chars"] += n

    def named(match):
        name = match.group(1)
        if name in XML_ENTITIES or name not in name2codepoint:
            return match.group(0)
        leniency["html_entity"] += 1
        return f"&#{name2codepoint[name]};"

    text = NAMED_ENTITY_RE.sub(named, text)
    text, n = BARE_AMP_RE.subn("&amp;", text)
    if n:
        leniency["bare_ampersand"] += n
    text = re.sub(r"^<\?xml[^>]*\?>", "", text)
    return text.encode("utf-8")


def parse_xml(data, leniency):
    try:
        return ET.fromstring(data)
    except ET.ParseError:
        pass
    try:
        return ET.fromstring(_repair(data, leniency))
    except ET.ParseError as exc:
        raise FeedError(f"unparseable after repairs: {exc}") from exc


def _text(el, tag):
    child = el.find(tag)
    return "".join(child.itertext()) if child is not None else ""


def _local(tag):
    """The tag's own name, its namespace (if any) stripped: '{ns}item' -> 'item'."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find_local(el, name):
    """The first direct child whose tag, namespace ignored, is `name`."""
    for child in el:
        if _local(child.tag) == name:
            return child
    return None


def _text_local(el, name):
    child = _find_local(el, name)
    return "".join(child.itertext()) if child is not None else ""


def feed_kind(root):
    """Which of the three supported formats a parsed feed root is: 'atom' (a <feed>
    root in the Atom namespace), 'rdf' (an <rdf:RDF> root, RSS 1.0), or 'rss'
    (everything else, RSS 2.0 and its many near-variants)."""
    local = _local(root.tag)
    if local == "feed":
        return "atom"
    if local == "RDF":
        return "rdf"
    return "rss"


def iter_feed_items(root):
    """Return (items, kind): the entry/item elements to walk, and which format they
    came from. RSS 2.0's `root.iter("item")` call is unchanged from before this
    format ever mattered; Atom entries and RDF items are namespaced, so they are
    found by local name instead, wherever in the tree they sit."""
    kind = feed_kind(root)
    if kind == "atom":
        return [el for el in root.iter() if _local(el.tag) == "entry"], kind
    if kind == "rdf":
        return [el for el in root.iter() if _local(el.tag) == "item"], kind
    return list(root.iter("item")), kind


def _item_title_raw(item, kind):
    if kind == "rss":
        return _text(item, "title")
    return _text_local(item, "title")


def _atom_link_href(item):
    """The Atom entry's own article link: <link rel="alternate" href="...">, or,
    lacking an explicit rel (default is "alternate" per the Atom spec), the first
    <link> that carries an href at all. Falls back to the entry's <id> when it is
    itself an http(s) URL, the Atom analogue of the RSS guid fallback below."""
    alternate, first_href = None, None
    for child in item:
        if _local(child.tag) != "link":
            continue
        href = (child.get("href") or "").strip()
        if not href:
            continue
        rel = (child.get("rel") or "alternate").strip().lower()
        if rel == "alternate" and alternate is None:
            alternate = href
        if first_href is None:
            first_href = href
    if alternate or first_href:
        return alternate or first_href
    return _text_local(item, "id").strip()


def _item_link_raw(item, kind):
    if kind == "atom":
        return _atom_link_href(item)
    if kind == "rdf":
        link = _text_local(item, "link").strip()
        if link:
            return link
        return (item.get(f"{{{RDF_NS}}}about") or "").strip()
    return _text(item, "link")


def _item_date_raw(item, kind):
    if kind == "atom":
        return _text_local(item, "published") or _text_local(item, "updated")
    if kind == "rdf":
        return _text_local(item, "date")  # dc:date, matched by local name
    return _text(item, "pubDate")


def _item_dek_raw(item, kind):
    if kind == "atom":
        return _text_local(item, "summary") or _text_local(item, "content")
    if kind == "rdf":
        return _text_local(item, "description")
    return _text(item, "description")


def _clean(text):
    return " ".join(text.split())


def _plain(text):
    """Markup free text: tags stripped, entities decoded, whitespace collapsed."""
    return _clean(html.unescape(TAG_RE.sub(" ", text)))


def _published_at(raw, leniency):
    raw = raw.strip()
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
    except (TypeError, ValueError, IndexError):
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
        leniency["iso_date"] += 1
    if dt.tzinfo is None:
        leniency["naive_date"] += 1
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _utc(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _assert_ledger_invariant(counts):
    """R9/S02: fetched must equal published plus the sum of drops, every run."""
    total_drops = sum(counts["drops"].values())
    if counts["fetched"] != counts["published"] + total_drops:
        raise FeedError(
            "ledger invariant broken: fetched "
            f"{counts['fetched']} != published {counts['published']} + drops {total_drops}"
        )


def build_pool(data, now, source=SOURCE, limit=5):
    """Turn raw feed bytes into a pool dict. Pure: no network, no clock.

    F7: items is whichever of RSS 2.0 <item>, Atom <entry> or RDF <item> the feed
    actually carries (iter_feed_items); every per-item field below is read through
    the format-aware getters in this module, so this loop's own rules (title
    cleaning, url validation, duplicate and date drops, the cap) apply identically
    regardless of format.
    """
    leniency = Counter()
    drops = Counter()
    root = parse_xml(data, leniency)
    items, kind = iter_feed_items(root)
    articles, seen = [], set()
    for item in items:
        raw_title = _clean(_item_title_raw(item, kind))
        title = _plain(raw_title)
        if title != raw_title:
            leniency["title_markup"] += 1
        if not title:
            drops["no_title"] += 1
            continue
        url = _item_link_raw(item, kind).strip()
        if not url.startswith(("http://", "https://")):
            if kind == "rss":
                guid = item.find("guid")
                guid_url = _text(item, "guid").strip()
                permalink = guid is None or guid.get("isPermaLink", "true") != "false"
                if permalink and guid_url.startswith(("http://", "https://")):
                    url = guid_url
                    leniency["link_from_guid"] += 1
                else:
                    drops["bad_url"] += 1
                    continue
            else:
                drops["bad_url"] += 1
                continue
        if any(c.isspace() for c in url) or len(url) > 2048:
            drops["bad_url"] += 1
            continue
        if url in seen:
            drops["duplicate_url"] += 1
            continue
        published = _published_at(_item_date_raw(item, kind), leniency)
        if published is None:
            drops["no_date"] += 1
            continue
        if len(articles) >= limit:
            drops["over_cap"] += 1
            continue
        seen.add(url)
        article = {
            "id": hashlib.sha256(url.encode("utf-8")).hexdigest()[:16],
            "source_id": source["id"],
            "url": url,
            "title": title[:TITLE_MAX],
            "published_at": published,
        }
        dek = _plain(_item_dek_raw(item, kind))[:DEK_MAX]
        if dek:
            article["dek"] = dek
        articles.append(article)
    counts = {
        "fetched": len(items),
        "published": len(articles),
        "drops": dict(sorted(drops.items())),
        "leniency": dict(sorted(leniency.items())),
    }
    _assert_ledger_invariant(counts)
    return {
        "schema_version": 1,
        "generated_at": _utc(now),
        "sources": [dict(source)],
        "articles": articles,
        "clusters": [],
        "counts": counts,
    }


def dumps(pool):
    return json.dumps(pool, ensure_ascii=False, separators=(",", ":"))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="dist/pool.json")
    ap.add_argument("--limit", type=int, default=5)
    args = ap.parse_args(argv)

    t0 = time.monotonic()
    try:
        data = fetch_feed(SOURCE["feed_url"])
        pool = build_pool(data, datetime.now(timezone.utc), limit=args.limit)
    except (OSError, FeedError) as exc:
        print(f"FETCH FAILED: {exc}", file=sys.stderr)
        return 1
    errors = validate(pool)
    if errors:
        print(f"INVALID POOL, not written: {errors[:10]}", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    body = dumps(pool).encode("utf-8")
    out.write_bytes(body)
    c = pool["counts"]
    print(
        f"fetched={c['fetched']} published={c['published']} "
        f"leniency={sum(c['leniency'].values())} drops={json.dumps(c['drops'])} "
        f"bytes={len(body)} seconds={time.monotonic() - t0:.2f}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
