"""Which pool image a story may show, and where (S39, D2, R34).

The pool's optional article `image` (S38) is feed-stated: an https url, maybe a width
and height, maybe a credit. Nothing here fetches or probes an image; every rule reads
only what the feed stated.

- Only an https url with a host reaches an `src`; anything else is no image at all, so
  the row renders its text-only variant.
- Hero: full bleed. An image is hero-worthy only when the feed states a width of at
  least HERO_MIN_WIDTH; with no stated width the size is unknown, so it never fronts the
  page rather than risk a blurred or tiny photo.
- Hero box (D2): the photo's own stated width / height, clamped to [1:1, 4:3]. NYT's
  hero is 1:1 (nyt-measured 1080x1080 px, and every reference capture viewed for D2
  shows 1:1), so a square or portrait photo gets the NYT square, a photo between 1:1
  and 4:3 keeps its own shape uncropped, and a wide photo is never cropped narrower than
  4:3. A photo with a side unstated gets the NYT square. The box is known at build time,
  so it is reserved before a byte arrives.
- Hero photo choice (D2): any hero-worthy image in the story's cluster, never changing
  the lead or its headline. Likely video or graphic thumbnails go last; then photos
  whose crop to the hero box keeps at least WELL_SHAPED_KEEP of them; then a stated
  shape over an unstated one; then the largest stated width, counted up to SHARP_PX
  (the box's physical width at 3x, beyond which more pixels show nothing); then the
  lead's own photo; then the ratio closest to 1:1; then the lowest article id. A photo from another outlet than the headline's is
  credited "Photo via <outlet>", so nothing is misattributed.
- River thumbnail: 88dp square (nyt-measured, n=3). The lead's own image only (a
  thumbnail carries no credit line), unless a stated side is below the box itself,
  which would be upscaled into mush.
- Credit: shown under the hero only, as NYT does, one line of text. A feed "credit" that
  is really a caption keeps only its "Photo: ..." tail, and one still longer than
  CREDIT_MAX_CHARS is dropped as a caption, not a credit.

The lead article choice (S11, app.frontpage) never looks at images.
"""
import math
import re
from urllib.parse import urlsplit

HERO_MIN_WIDTH = 600
THUMB_PX = 88
HERO_PX = 360
CREDIT_MAX_CHARS = 60
NYT_HERO_RATIO = 1.0
WIDE_CROP_FLOOR = 4 / 3
WELL_SHAPED_KEEP = 0.85
SHARP_PX = HERO_PX * 3
# Stated sizes that are exact video frames, and url words that mark a video or graphic
# still (YouTube's maxresdefault and kin, video hosts, chart and graphic paths). These
# often carry burned-in captions or play buttons, so they front the page only when a
# story has nothing better. Words are whole host and path tokens, never the query.
VIDEO_FRAMES = {(640, 360), (854, 480), (1280, 720), (1920, 1080), (3840, 2160)}
VIDEO_OR_GRAPHIC_WORDS = {
    "video", "videos", "clip", "clips", "livestream", "maxresdefault", "hqdefault", "sddefault",
    "mqdefault", "hq720", "ytimg", "youtube", "vimeo", "vimeocdn", "jwplayer", "jwplatform",
    "brightcove", "graphic", "graphics", "infographic", "infographics", "chart", "charts",
}

_CREDIT_MARK = re.compile(r"\b(?:Photo(?:graph)?s?|Illustration|Image|Credit)\s*:", re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x20\x7f]")
_WORD = re.compile(r"[a-z0-9]+")


def image_url(image):
    """The image's url when it is a plain https url with a host, else None."""
    if not isinstance(image, dict):
        return None
    url = image.get("url")
    if not isinstance(url, str) or _CONTROL.search(url):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme.lower() != "https" or not parts.hostname:
        return None
    return url


def _side(image, key):
    value = image.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def hero_worthy(image):
    width = _side(image, "width") if image_url(image) else None
    return width is not None and width >= HERO_MIN_WIDTH


def thumb_ok(image):
    if not image_url(image):
        return False
    return all((side := _side(image, key)) is None or side >= THUMB_PX for key in ("width", "height"))


def credit_text(image):
    """The one-line credit to show under a hero photo, or ''."""
    raw = image.get("credit") if isinstance(image, dict) else None
    if not isinstance(raw, str):
        return ""
    text = " ".join(raw.split())
    mark = _CREDIT_MARK.search(text)
    if mark and mark.start() > 0:
        text = text[mark.start():]
    return text if 0 < len(text) <= CREDIT_MAX_CHARS else ""


def stated_ratio(image):
    """The feed-stated width / height, or None when either side is unstated."""
    width, height = _side(image, "width"), _side(image, "height")
    return width / height if width and height else None


def hero_ratio(image):
    """The hero box's width / height: the stated ratio clamped to [1:1, 4:3], or 1:1."""
    ratio = stated_ratio(image)
    if ratio is None:
        return NYT_HERO_RATIO
    return min(max(ratio, NYT_HERO_RATIO), WIDE_CROP_FLOOR)


def hero_box(image):
    """The hero frame and img size in CSS px: the full width, and the height of the box."""
    return HERO_PX, round(HERO_PX / hero_ratio(image))


def likely_video_or_graphic(image):
    url = image_url(image)
    if url is None:
        return False
    if (_side(image, "width"), _side(image, "height")) in VIDEO_FRAMES:
        return True
    parts = urlsplit(url)
    words = _WORD.findall(f"{parts.hostname} {parts.path}".lower())
    return any(word in VIDEO_OR_GRAPHIC_WORDS for word in words)


def _well_shaped(image):
    ratio = stated_ratio(image)
    if ratio is None:
        return False
    box = hero_ratio(image)
    return min(ratio, box) / max(ratio, box) >= WELL_SHAPED_KEEP


def hero_pick(members, lead):
    """The article whose image the hero shows, or None (text-only hero). `members` are
    the story's articles, `lead` the one whose headline fronts it (unchanged here)."""
    candidates = [a for a in members if hero_worthy(a.get("image"))]
    if not candidates:
        return None

    def key(article):
        image = article["image"]
        ratio = stated_ratio(image)
        return (likely_video_or_graphic(image), not _well_shaped(image), ratio is None,
                -min(_side(image, "width"), SHARP_PX), article is not lead,
                abs(math.log(ratio / NYT_HERO_RATIO)) if ratio else math.inf, article["id"])
    return min(candidates, key=key)


def hero_media(members, lead, source_names):
    """(image, credit) for the hero photo, or None. A photo from another outlet than the
    lead's is credited to that outlet by name; one with no known name is not borrowed."""
    named = [a for a in members if a is lead or a.get("source_id") == lead.get("source_id")
             or source_names.get(a.get("source_id"))]
    pick = hero_pick(named, lead)
    if pick is None:
        return None
    if pick.get("source_id") == lead.get("source_id"):
        return pick["image"], credit_text(pick["image"])
    return pick["image"], f"Photo via {source_names[pick['source_id']]}"


def media_for(hero, thumb_image):
    """The compact per-story image record the page embeds for a device re-rank, or None
    when the story shows no image in any tier: {"hero": [url, width, height, credit]}
    from hero_media's (image, credit), and {"thumb": url} from the lead's own image. The
    device applies the same tier rule the build does."""
    record = {}
    if hero is not None:
        image, credit = hero
        record["hero"] = [image_url(image), *hero_box(image), credit]
    if thumb_ok(thumb_image):
        record["thumb"] = image_url(thumb_image)
    return record or None
