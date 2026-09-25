"""L1: the lean marker's build-time markup, the same bytes app/static/js/lean.js builds
on the device (leanMarker, leanHit), so a row the build wrote and a row the device
redraws are one design. U3: one marker family for every source. Five dots after the
source name for a bucket on the US left-right scale, "State" for state media, and for
an outlet outside the US axis ("non-us") the two-letter code of its home country
(sources.json `country`, ISO 3166-1 alpha-2), the angle it writes from. A source with no
lean and no country gets nothing. The source id is escaped as an attribute value;
nothing else here comes from a feed (R26), and a country is used only when it is two
upper-case letters.
"""
import re
from html import escape

LEAN_SCALE = ("left", "center-left", "center", "center-right", "right")
COUNTRY = re.compile(r"[A-Z]{2}")


def country_code(value):
    """`value` when it is an ISO 3166-1 alpha-2 shape (two upper-case letters), else None."""
    return value if isinstance(value, str) and COUNTRY.fullmatch(value) else None


def _mark(lean, country=None):
    if lean in LEAN_SCALE:
        return "scale", f"Lean: {lean}"
    if lean == "state":
        return "state", "Lean: state media"
    code = country_code(country)
    if code:
        return "country", f"Country: {code}"
    return None, None


def marker_html(lean, country=None):
    """The row's marker, aria-hidden (the row's .lean-hit button carries its name), or
    '' when the source gets none."""
    kind, _ = _mark(lean, country)
    if kind is None:
        return ""
    if kind == "state":
        return '<span class="lean lean--state" aria-hidden="true"><span class="lean-state">State</span></span>'
    if kind == "country":
        return f'<span class="lean lean--country" aria-hidden="true"><span class="lean-code">{country}</span></span>'
    return f'<span class="lean lean--{lean}" aria-hidden="true">' + "<i></i>" * len(LEAN_SCALE) + "</span>"


def hit_html(source_id, lean, country=None, extra_class=""):
    """The 48dp tap target for a marker, a sibling of the link it sits in (style.css
    .lean-hit lays it over the marker), or '' when the source gets no marker.
    `extra_class` names a second target in the same row (U3: the other-side line's)."""
    kind, label = _mark(lean, country)
    if kind is None or not isinstance(source_id, str) or not source_id:
        return ""
    cls = f"lean-hit {extra_class}" if extra_class else "lean-hit"
    return (f'<button class="{cls}" type="button" data-lean-source="{escape(source_id, quote=True)}" '
            f'aria-haspopup="dialog" aria-label="{label}"></button>')
