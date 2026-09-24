"""S08: lean taxonomy for sources.json. Standard library only (R30).

R10: lean is a shared, repo-owned claim about a source (not trust, which is personal
and device-owned, per profile.json). The design doc is silent on the exact bucket set,
so this module is the one place it is defined, closed, and reused by both sources.json
validation and the pool schema.

Five buckets cover the US left-right frame the research was gathered against. Two more
handle what does not fit that frame, justified per source in sources.json's own
lean_basis field:
  - "state": the outlet's editorial line is documented as directly state-owned or
    state-funded with the state's interest visible in coverage (Al Jazeera, Mediacorp's
    CNA, Saudi-owned Arab News, Vietnam's licensed press). Distinct from ordinary
    government subsidy that leaves editorial independence intact.
  - "non-us": the outlet operates outside the US press environment and the research
    gives no US-style left/right rating for it (most of Singapore, Japan, Korea, Greater
    China, India, and Southeast Asia coverage in research/feeds-asia.md and
    research/feeds-interests.md). Forcing these onto a US axis would be a guess this
    codebase has no evidence for; non-us keeps that guess out while still giving R16's
    must-know spread check a real bucket to count.

Ownership is a separate, optional fact (R10 again: it is not lean). Only added when the
research names it explicitly, from a closed set so "state-owned" and "state-subsidized"
reach the UI as exact, stable strings rather than free text.
"""

LEAN_BUCKETS = (
    "left",
    "center-left",
    "center",
    "center-right",
    "right",
    "state",
    "non-us",
)

OWNERSHIP_LABELS = (
    "state-owned",
    "state-funded",
    "state-subsidized",
    "member-owned",
    "corporate-controlled",
)

REQUIRED_SOURCE_FIELDS = ("id", "name", "feed_url", "bucket", "lean", "lean_basis", "syndication_group")


class TaxonomyError(Exception):
    """A source's lean, ownership or syndication_group value breaks the closed shape."""


def validate_source_taxonomy(source):
    """Return a list of error strings for one source dict; empty means valid."""
    errors = []
    sid = source.get("id", "?")
    for field in REQUIRED_SOURCE_FIELDS:
        if not source.get(field):
            errors.append(f"source {sid!r}: missing {field!r}")
    lean = source.get("lean")
    if lean is not None and lean not in LEAN_BUCKETS:
        errors.append(f"source {sid!r}: lean {lean!r} not in {LEAN_BUCKETS}")
    ownership = source.get("ownership")
    if ownership is not None and ownership not in OWNERSHIP_LABELS:
        errors.append(f"source {sid!r}: ownership {ownership!r} not in {OWNERSHIP_LABELS}")
    return errors


def validate_sources_taxonomy(sources):
    """Return a list of error strings across every source; empty means all valid."""
    errors = []
    for source in sources:
        errors.extend(validate_source_taxonomy(source))
    return errors
