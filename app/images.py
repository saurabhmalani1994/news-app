"""Which pool image a story may show, and where (S39, R34).

The pool's optional article `image` (S38) is feed-stated: an https url, maybe a width
and height, maybe a credit. Nothing here fetches or probes an image; every rule reads
only what the feed stated.

- Only an https url with a host reaches an `src`; anything else is no image at all, so
  the row renders its text-only variant.
- Hero: full bleed and square (nyt-measured: 1080x1080 px at 3x, 360dp). The lead's image
  is hero-worthy only when the feed states a width of at least HERO_MIN_WIDTH. With no
  stated width the size is unknown, so the hero stays text-only rather than risk a
  blurred or tiny photo at the top of the page.
- River thumbnail: 88dp square (nyt-measured, n=3). Any usable image, unless a stated
  side is below the box itself, which would be upscaled into mush.
- Credit: shown under the hero only, as NYT does, one line of text. A feed "credit" that
  is really a caption keeps only its "Photo: ..." tail, and one still longer than
  CREDIT_MAX_CHARS is dropped as a caption, not a credit.

The lead article choice (S11, app.frontpage) never looks at images.
"""
import re
from urllib.parse import urlsplit

HERO_MIN_WIDTH = 600
THUMB_PX = 88
HERO_PX = 360
CREDIT_MAX_CHARS = 60

_CREDIT_MARK = re.compile(r"\b(?:Photo(?:graph)?s?|Illustration|Image|Credit)\s*:", re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x20\x7f]")


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


def media_for(image):
    """The compact per-story image record the page embeds for a device re-rank:
    [url, hero (1 or 0), thumb (1 or 0), credit], or None when the story shows no image
    in any tier. The device applies the same tier rule the build does."""
    url = image_url(image)
    hero, thumb = hero_worthy(image), thumb_ok(image)
    if url is None or not (hero or thumb):
        return None
    return [url, int(hero), int(thumb), credit_text(image) if hero else ""]
