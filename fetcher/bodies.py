"""S22: per-article bodies, written to bodies/<article_id>.json for full_text_ok
sources only (R12, DESIGN-v1.1 section 3; S09's Guardian API text writes through this
module later). Standard library only (R30).

Body text is taken only from the feed's own item, never a fetched article page:
content:encoded when the feed carries one (Politico, Fox News Politics and Ars
Technica all put a short teaser in <description> and the real prose in
content:encoded, confirmed live in research/feeds-verified.md), otherwise
<description> itself (Axios and most of research/feeds-interests.md's "Yes, full
text" rows put prose directly in <description>). Nothing is scraped.

full_text_ok in sources.json is a source-level claim seeded from that research. It is
not trusted blindly here: FULL_TEXT_MIN_CHARS is the same >2000-stripped-chars cutoff
research/feeds-verified.md used to call a feed's content FULL TEXT rather than
SUMMARY or HEADLINE ONLY, and every candidate is measured against it again, live,
right before a body is written. A full_text_ok source that happens to publish one
short wire brief produces a teaser for that one item, skipped and counted in
counts.bodies, never written as a half-empty body file.

Bodies are also capped in total per run (MAX_TOTAL_BODY_BYTES) so one run can never
grow the deploy output without bound; once spent, further candidates are skipped and
counted too, walked in source-then-publish order (the same order sources.json and the
published articles list already carry).
"""
import json
import xml.etree.ElementTree as ET
from pathlib import Path

from fetcher.fetch import _find_local, _local, _plain, _text, _text_local

# RSS content module namespace (used by Politico, Fox, Ars Technica and others for
# the full-prose field alongside a teaser <description>).
CONTENT_ENCODED_TAG = "{http://purl.org/rss/1.0/modules/content/}encoded"

# Matches research/feeds-verified.md's own FULL TEXT tier boundary (>2000 stripped
# chars; SUMMARY is 150-2000, HEADLINE ONLY is <150), so "full text" means the same
# thing here as it did when full_text_ok was first decided from that research.
FULL_TEXT_MIN_CHARS = 2000

# Bound on the sum of this run's written body files. At PER_SOURCE_CAP=5 (+ up to
# CLUSTER_EXTRA_CAP=3 for multi-source clusters) across 14 full_text_ok sources, a
# worst case of roughly 112 articles at up to ~70,000 chars each (the largest body
# research measured, Mother Jones) stays under this bound with headroom; once it is
# spent, remaining candidates are skipped_cap rather than grown past it.
MAX_TOTAL_BODY_BYTES = 8_000_000

SCHEMA_VERSION = 1


def _content_encoded(item):
    child = item.find(CONTENT_ENCODED_TAG)
    return "".join(child.itertext()) if child is not None else ""


def _strip_ns(el):
    """A copy of an element tree with every tag's namespace dropped, so it serializes as
    plain HTML (<p>, not <html:p> or an xmlns attribute)."""
    copy = ET.Element(_local(el.tag), {k: v for k, v in el.attrib.items() if "}" not in k})
    copy.text, copy.tail = el.text, el.tail
    for child in el:
        copy.append(_strip_ns(child))
    return copy


def _atom_content(item):
    """B4: an Atom <content> as body HTML. type="xhtml" (Jacobin) carries real markup in
    a child <div>, so its children are serialized as HTML and the paragraphs survive;
    itertext would run them together. Other types are text or escaped HTML already."""
    content = _find_local(item, "content")
    if content is None:
        return ""
    if (content.get("type") or "").strip().lower() != "xhtml":
        return "".join(content.itertext())
    div = next(iter(content), None)
    root = div if div is not None and _local(div.tag) == "div" else content
    parts = [root.text or ""]
    for child in root:
        parts.append(ET.tostring(_strip_ns(child), encoding="unicode", method="html"))
    return "".join(parts).strip()


def extract_body_html(item, kind="rss"):
    """Return raw body HTML straight from one item/entry, or None when nothing on it
    clears FULL_TEXT_MIN_CHARS of stripped text.

    RSS 2.0 and RDF: content:encoded is preferred over description since every
    configured full_text_ok source that carries both puts the teaser in description
    and the real prose in content:encoded.

    F7 (kind="atom"): an Atom entry has no content:encoded; <content> is the field
    a full_text_ok Atom source (The Conversation, Creative Commons licensed) puts its
    full prose in, <summary> the fallback for one that does not.
    """
    if kind == "atom":
        content = _atom_content(item)
        if content and len(_plain(content)) >= FULL_TEXT_MIN_CHARS:
            return content
        summary = _text_local(item, "summary")
        if summary and len(_plain(summary)) >= FULL_TEXT_MIN_CHARS:
            return summary
        return None
    content = _content_encoded(item)
    if content and len(_plain(content)) >= FULL_TEXT_MIN_CHARS:
        return content
    desc = _text(item, "description") if kind == "rss" else _text_local(item, "description")
    if desc and len(_plain(desc)) >= FULL_TEXT_MIN_CHARS:
        return desc
    return None


def build_body(article, source, body_html):
    return {
        "schema_version": SCHEMA_VERSION,
        "article_id": article["id"],
        "source_id": source["id"],
        "source_name": source["name"],
        "url": article["url"],
        "body_html": body_html,
    }


def collect_bodies(sources, articles, body_candidates, max_total_bytes=MAX_TOTAL_BODY_BYTES):
    """articles: the final published article list (post-cap, post-dedup, in publish
    order). body_candidates: {article_id: body_html_or_None}, gathered by the caller
    while walking each source's raw feed items, already restricted to full_text_ok
    sources so a body can never come from anywhere else.

    Returns (bodies, counts). bodies maps article_id -> body dict, only for articles
    that got one; counts is the bodies ledger block (written/skipped_teaser/
    skipped_cap/bytes). Pure: no network, no filesystem.
    """
    sources_by_id = {s["id"]: s for s in sources}
    bodies = {}
    written = skipped_teaser = skipped_cap = 0
    total_bytes = 0
    for article in articles:
        source = sources_by_id.get(article["source_id"])
        if source is None or not source.get("full_text_ok"):
            continue
        body_html = body_candidates.get(article["id"])
        if not body_html:
            skipped_teaser += 1
            continue
        record = build_body(article, source, body_html)
        size = len(json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        if total_bytes + size > max_total_bytes:
            skipped_cap += 1
            continue
        bodies[article["id"]] = record
        total_bytes += size
        written += 1
    counts = {
        "written": written,
        "skipped_teaser": skipped_teaser,
        "skipped_cap": skipped_cap,
        "bytes": total_bytes,
    }
    return bodies, counts


def write_bodies(bodies, out_dir):
    """Write bodies/<article_id>.json for each body dict. Only ever writes files
    for the current run's published articles: a Cloudflare Pages direct upload
    (R1) is a full snapshot of dist/, so a body absent from this run's dist/bodies
    simply does not exist on the next deploy, and nothing extra needs deleting."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for article_id, record in bodies.items():
        (out_dir / f"{article_id}.json").write_text(
            json.dumps(record, ensure_ascii=False, separators=(",", ":")), encoding="utf-8",
        )
