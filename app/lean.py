"""L1: the lean marker's build-time markup, the same bytes app/static/js/lean.js builds
on the device (leanMarker, leanHit), so a row the build wrote and a row the device
redraws are one design. Five dots after the source name for a bucket on the US
left-right scale, "State" for state media, nothing for "non-us" or a source with no
lean. The source id is escaped as an attribute value; nothing else here comes from a
feed (R26).
"""
from html import escape

LEAN_SCALE = ("left", "center-left", "center", "center-right", "right")


def _mark(lean):
    if lean in LEAN_SCALE:
        return "scale", f"Lean: {lean}"
    if lean == "state":
        return "state", "Lean: state media"
    return None, None


def marker_html(lean):
    """The row's marker, aria-hidden (the row's .lean-hit button carries its name), or
    '' when the source gets none."""
    kind, _ = _mark(lean)
    if kind is None:
        return ""
    inner = '<span class="lean-state">State</span>' if kind == "state" else "<i></i>" * len(LEAN_SCALE)
    return f'<span class="lean lean--{lean}" aria-hidden="true">{inner}</span>'


def hit_html(source_id, lean):
    """The row's 48dp tap target for its marker, a sibling of the row's link (style.css
    .lean-hit lays it over the dots), or '' when the source gets no marker."""
    kind, label = _mark(lean)
    if kind is None or not isinstance(source_id, str) or not source_id:
        return ""
    return (f'<button class="lean-hit" type="button" data-lean-source="{escape(source_id, quote=True)}" '
            f'aria-haspopup="dialog" aria-label="{label}"></button>')
