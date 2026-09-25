"""S38: per-article image, sourced only from the feed itself (R34). Standard library
only (R30). Never fetches an article page and never probes an image url; every field
comes from what the feed already states.

Priority order per item: media:content (medium image, or an image MIME type),
media:thumbnail, an enclosure with an image type, then, as a last resort, the first
<img src> inside the item's own description or content:encoded. That last one is
still the feed's own content, not page scraping, but it is counted under its own
method, content_img, so the ledger shows how much of the picture supply is that thin.
Within a method, when more than one candidate is offered (media:content commonly
repeats itself at several resolutions), the largest stated candidate wins.

Every candidate is checked before it is kept: https only, no data URIs, no 1x1 or
near-1x1 stated pixels (a tracking pixel, not content). A method that offers nothing
usable falls through to the next method, same item.

One more rejection needs the whole run to see: a source that gives the exact same
image url on every one of its own published items is an obvious logo placeholder, not
a photo. That check cannot run per item, so it runs as a second pass, over the final
published articles for one source, after every article already carries its (possibly
None) image; see filter_placeholder_logos.
"""
import re
from collections import Counter

MEDIA_NS = "http://search.yahoo.com/mrss/"
CONTENT_NS = "http://purl.org/rss/1.0/modules/content/"

METHODS = ("media_content", "media_thumbnail", "enclosure", "content_img")
REJECT_REASONS = ("not_https", "data_uri", "tiny_pixel", "repeated_placeholder")

CREDIT_MAX = 500
# Both stated dimensions at or under this are a tracking pixel, not content. Covers
# the classic 1x1 and the handful-of-pixels beacons some ad networks still ship.
TINY_DIMENSION = 10

IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
_ATTR = r'{name}\s*=\s*(?:"([^"]*)"|\'([^\']*)\')'
IMG_SRC_ATTR_RE = re.compile(_ATTR.format(name=r"\bsrc"), re.IGNORECASE)
IMG_WIDTH_ATTR_RE = re.compile(_ATTR.format(name=r"\bwidth"), re.IGNORECASE)
IMG_HEIGHT_ATTR_RE = re.compile(_ATTR.format(name=r"\bheight"), re.IGNORECASE)


def _unescape_amp(url):
    """Some feeds (i0.wp.com, The Conversation observed) double-escape the ampersand
    in an image query string: the source XML holds "&amp;amp;", so plain XML entity
    decoding (one pass, done by the parser before this module ever sees the value)
    leaves a literal "&amp;" sitting in the url text instead of the "&" it should be.
    That literal text breaks the query string the host reads, so it falls back to a
    thumbnail instead of the full-size original. Unescaping once more here recovers
    the real separator. A url that was escaped correctly the first time never has a
    literal "&amp;" left in it, so this is safe to apply to every url unconditionally."""
    return url.replace("&amp;", "&") if url else url


def _int_or_none(raw):
    if raw is None or raw == "":
        return None
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _area(candidate):
    w, h = candidate.get("width"), candidate.get("height")
    return w * h if w and h else 0


def _validate(url, width, height, rejected):
    """True if the candidate clears the universal checks; otherwise counts the
    reason in `rejected` and returns False. The data: check runs before the https
    check since a data URI never starts with https:// either, and it is the more
    specific, more useful reason."""
    if url and url.startswith("data:"):
        rejected["data_uri"] += 1
        return False
    if not url or not url.startswith("https://"):
        rejected["not_https"] += 1
        return False
    if width and height and width <= TINY_DIMENSION and height <= TINY_DIMENSION:
        rejected["tiny_pixel"] += 1
        return False
    return True


def _element_text(el):
    return (el.text or "").strip() if el is not None else ""


def _from_media_content(item, rejected):
    candidates = []
    for el in item.findall(f"{{{MEDIA_NS}}}content"):
        url = _unescape_amp((el.get("url") or "").strip())
        medium = (el.get("medium") or "").strip().lower()
        mime = (el.get("type") or "").strip().lower()
        if medium != "image" and not mime.startswith("image/"):
            continue  # not stated as an image: could be video, audio, unknown
        width = _int_or_none(el.get("width"))
        height = _int_or_none(el.get("height"))
        if not _validate(url, width, height, rejected):
            continue
        credit = _element_text(el.find(f"{{{MEDIA_NS}}}credit"))
        if not credit:
            credit = _element_text(el.find(f"{{{MEDIA_NS}}}description"))
        candidates.append({"url": url, "width": width, "height": height, "credit": credit})
    return candidates


def _from_media_thumbnail(item, rejected):
    candidates = []
    for el in item.findall(f"{{{MEDIA_NS}}}thumbnail"):
        url = _unescape_amp((el.get("url") or "").strip())
        width = _int_or_none(el.get("width"))
        height = _int_or_none(el.get("height"))
        if not _validate(url, width, height, rejected):
            continue
        candidates.append({"url": url, "width": width, "height": height, "credit": ""})
    return candidates


def _local(tag):
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _from_enclosure(item, rejected):
    candidates = []
    for el in item.findall("enclosure"):
        mime = (el.get("type") or "").strip().lower()
        if not mime.startswith("image/"):
            continue
        url = _unescape_amp((el.get("url") or "").strip())
        if not _validate(url, None, None, rejected):
            continue
        candidates.append({"url": url, "width": None, "height": None, "credit": ""})
    # F7: Atom has no <enclosure> tag; the same relationship is a <link rel="enclosure">
    # with an href instead of a url attribute (Atom spec section 4.2.7.2).
    for el in item:
        if _local(el.tag) != "link" or (el.get("rel") or "").strip().lower() != "enclosure":
            continue
        mime = (el.get("type") or "").strip().lower()
        if not mime.startswith("image/"):
            continue
        url = _unescape_amp((el.get("href") or "").strip())
        if not _validate(url, None, None, rejected):
            continue
        candidates.append({"url": url, "width": None, "height": None, "credit": ""})
    return candidates


def _dim(pattern, tag):
    m = pattern.search(tag)
    if not m:
        return None
    return _int_or_none(m.group(1) or m.group(2))


def _first_img_src(html_text, rejected):
    if not html_text:
        return None
    tag_match = IMG_TAG_RE.search(html_text)
    if not tag_match:
        return None
    tag = tag_match.group(0)
    src_match = IMG_SRC_ATTR_RE.search(tag)
    if not src_match:
        return None
    url = _unescape_amp((src_match.group(1) or src_match.group(2) or "").strip())
    width = _dim(IMG_WIDTH_ATTR_RE, tag)
    height = _dim(IMG_HEIGHT_ATTR_RE, tag)
    if not _validate(url, width, height, rejected):
        return None
    return {"url": url, "width": width, "height": height, "credit": ""}


def _from_content_img(item, rejected):
    # "the first <img src> inside the item's own description or content:encoded":
    # description is checked first since it is the field that comes first in the
    # item; content:encoded, the fuller body, is the fallback. F7: an RDF item's
    # description is namespaced and an Atom entry has neither tag, only <content>,
    # so both are looked up by local name and <content> is tried last.
    description_el = item.find("description")
    if description_el is None:
        for child in item:
            if _local(child.tag) == "description":
                description_el = child
                break
    description = "".join(description_el.itertext()) if description_el is not None else ""
    found = _first_img_src(description, rejected)
    if found:
        return found
    encoded_el = item.find(f"{{{CONTENT_NS}}}encoded")
    encoded = "".join(encoded_el.itertext()) if encoded_el is not None else ""
    found = _first_img_src(encoded, rejected)
    if found:
        return found
    content_el = None
    for child in item:
        if _local(child.tag) == "content":
            content_el = child
            break
    content = "".join(content_el.itertext()) if content_el is not None else ""
    return _first_img_src(content, rejected)


def _finalize(candidate):
    image = {"url": candidate["url"]}
    if candidate.get("width"):
        image["width"] = candidate["width"]
    if candidate.get("height"):
        image["height"] = candidate["height"]
    credit = (candidate.get("credit") or "").strip()
    if credit:
        image["credit"] = credit[:CREDIT_MAX]
    return image


def extract_image(item, rejected):
    """Return (image_dict, method) for the best candidate, or (None, None). Tries
    each source in priority order and keeps the first that yields anything usable;
    within a method, the largest stated candidate wins. `rejected` is a Counter that
    receives every universal rejection as it happens, regardless of which method
    (if any) eventually succeeds for this item.
    """
    candidates = _from_media_content(item, rejected)
    if candidates:
        return _finalize(max(candidates, key=_area)), "media_content"

    candidates = _from_media_thumbnail(item, rejected)
    if candidates:
        return _finalize(max(candidates, key=_area)), "media_thumbnail"

    candidates = _from_enclosure(item, rejected)
    if candidates:
        return _finalize(candidates[0]), "enclosure"

    found = _from_content_img(item, rejected)
    if found:
        return _finalize(found), "content_img"

    return None, None


def filter_placeholder_logos(articles, rejected):
    """Mutates `articles` in place: for each source, if every one of its published
    articles that carries an image carries the exact same image url (and there are
    at least two of them, so "repeats" is actually observed), that image is an
    obvious logo placeholder, not a photo. Its image is dropped from each of those
    articles and the removal is counted under repeated_placeholder.

    Every article that still has a "_image_method" scratch field, kept or dropped,
    has it removed here; nothing named with a leading underscore is written to the
    published pool.
    """
    by_source = {}
    for article in articles:
        if "image" in article:
            by_source.setdefault(article["source_id"], []).append(article)

    for group in by_source.values():
        urls = {a["image"]["url"] for a in group}
        if len(group) >= 2 and len(urls) == 1:
            for a in group:
                rejected["repeated_placeholder"] += 1
                del a["image"]
                a.pop("_image_method", None)


def tally_found(articles):
    """Pops the "_image_method" scratch field off every article and returns how many
    surviving images came from each method. Call after filter_placeholder_logos."""
    found = Counter()
    for article in articles:
        method = article.pop("_image_method", None)
        if "image" in article and method:
            found[method] += 1
    return found
