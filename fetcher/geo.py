"""G1: geography tags from an article's own text. Standard library only (R30).

The regional tabs used to follow the outlet: every Singapore-bucket item was tagged
`singapore`, so a Mothership piece on the White House media ban led the Singapore tab.
Here an article's `geo` tags come from its own title and dek (the dek's first
geo.json `dek_chars`, as some feeds put a whole body there), matched against the
plain-text gazetteer in geo.json (repo root):

  sg     Singapore: the name and demonyms, towns and estates, institutions and their
         acronyms (HDB, CPF, PAP...), and current officeholders by name, so a local
         story that never says "Singapore" still counts.
  asia   East, Southeast and South Asia (countries, demonyms, capitals, major cities,
         leaders). The Middle East is not Asia here; Central Asia is not either.
  us     the United States (names, institutions, states, cities, officeholders).
  world  anywhere outside the US, or an international body.

sg implies asia and asia implies world (geo.json `implies`), as NYT files Singapore
under Asia Pacific and Asia Pacific under World.

The outlet is never a signal on its own. A region's `weak` terms (MRT, MOE, SAF...,
ambiguous outside one country) count only when the article's source bucket is one of
that region's `weak_buckets`: a tie-break for a regional outlet's item that already has
a local-only signal, never a tag from the bucket alone.

B4 (DESIGN-bundles section 4): tag_countries gives the ISO 3166-1 alpha-2 countries the
same title and dek name, from geo.json `countries`, for the story's geography at country
level. Its `from_regions` reuses a strong hit on a G1 region as a country (sg is SG, us is
US), so those long lists live once. Weak terms never count here: they lean on the
outlet's bucket, and the outlet is never a signal. geo.json `intermediate` holds the
directional pairs fetcher/locality.py reads.

Pure and deterministic: no clock, no network, no randomness; the same bucket, title and
dek always give the same sorted list.
"""
import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

GEO_PATH = Path(__file__).resolve().parent.parent / "geo.json"
LIST_FIELDS = ("terms", "cased", "weak", "weak_cased", "weak_buckets", "exclude")
# Curly quotes to straight, en dash to hyphen, em dash and no-break space to a space.
QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
                        "\u2013": "-", "\u2014": " ", "\u00a0": " "})


class GeoError(Exception):
    """geo.json is missing a field or names a tag outside its own closed set."""


def _normalize(text):
    """Plain text for matching: accents folded (Turkiye, Tô Lâm), curly quotes and
    dashes made ASCII, whitespace collapsed."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.translate(QUOTES)
    return " ".join(text.split())


def _pattern(terms, cased):
    """One alternation, longest first. A term never matches inside a word: an edge that
    is a letter or digit must not touch another one (S$ may run into its digits).
    Lower-case terms also take a plural s or es (Singaporeans, Koreas)."""
    if not terms:
        return None
    word = "A-Za-z0-9" if cased else "a-z0-9"
    alts = []
    for term in sorted({_normalize(t) if cased else _normalize(t).lower() for t in terms},
                       key=lambda s: (-len(s), s)):
        head = f"(?<![{word}])" if term[0].isalnum() else ""
        tail = "" if not term[-1].isalnum() else ("" if cased else "(?:s|es)?") + f"(?![{word}])"
        alts.append(head + re.escape(term) + tail)
    return re.compile("|".join(alts))


def _strip_pattern(phrases, plural=False):
    """One case-insensitive alternation of whole phrases; with plural, each may also take
    a trailing s ("Chinese Americans" is stripped like "Chinese American")."""
    if not phrases:
        return None
    alts = sorted({re.escape(_normalize(p).lower()) for p in phrases}, key=lambda s: (-len(s), s))
    tail = "s?" if plural else ""
    return re.compile(rf"(?<![a-z0-9])(?:{'|'.join(alts)}){tail}(?![a-z0-9])", re.IGNORECASE)


def _check(doc):
    tags = doc.get("geo_tags")
    if not isinstance(tags, list) or not tags:
        raise GeoError("geo.json needs a non-empty geo_tags list")
    known = set(tags)
    for tag, implied in doc.get("implies", {}).items():
        for t in [tag, *implied]:
            if t not in known:
                raise GeoError(f"implies names unknown tag {t!r}")
    regions = doc.get("regions")
    if not isinstance(regions, dict) or set(regions) != known:
        raise GeoError("regions must name exactly the geo_tags")
    for name, region in regions.items():
        for field in LIST_FIELDS:
            values = region.get(field)
            if not isinstance(values, list) or not all(isinstance(v, str) and v.strip() for v in values):
                raise GeoError(f"regions[{name!r}].{field} must be a list of non-empty strings")


def load_geo(path=GEO_PATH):
    """The gazetteer, validated and compiled once per path."""
    return _compiled(str(Path(path).resolve()))


@lru_cache(maxsize=4)
def _compiled(path):
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    _check(doc)
    regions = {}
    for name in sorted(doc["regions"]):
        r = doc["regions"][name]
        regions[name] = {
            "strong": (_pattern(r["terms"], False), _pattern(r["cased"], True)),
            "weak": (_pattern(r["weak"], False), _pattern(r["weak_cased"], True)),
            "weak_buckets": frozenset(r["weak_buckets"]),
            "exclude": _strip_pattern(r["exclude"]),
        }
    countries = doc.get("countries") or {}
    country_map = countries.get("map") or {}
    lower_terms, cased_terms = {}, {}
    for code, entry in country_map.items():
        if not re.fullmatch(r"[A-Z]{2}", code):
            raise GeoError(f"countries.map key {code!r} is not an ISO 3166-1 alpha-2 code")
        for term in entry.get("terms", []):
            lower_terms[_normalize(term).lower()] = code
        for term in entry.get("cased", []):
            cased_terms[_normalize(term)] = code
    from_regions = countries.get("from_regions") or {}
    for code, region in from_regions.items():
        if region not in doc["regions"]:
            raise GeoError(f"countries.from_regions names unknown region {region!r}")
    pairs = set()
    for pair in (doc.get("intermediate") or {}).get("pairs", []):
        outlet, story = pair.get("outlet"), pair.get("story")
        if not (isinstance(outlet, str) and re.fullmatch(r"[A-Z]{2}", outlet)
                and isinstance(story, str) and re.fullmatch(r"[A-Z]{2}", story)):
            raise GeoError(f"intermediate pair {pair!r} needs two ISO 3166-1 alpha-2 codes")
        pairs.add((outlet, story))
    return {
        "country_terms": (lower_terms, cased_terms),
        "country_patterns": (_pattern(list(lower_terms), False), _pattern(list(cased_terms), True)),
        "country_strip": _strip_pattern(countries.get("strip", []), plural=True),
        "country_regions": dict(from_regions),
        "intermediate": frozenset(pairs),
        "dek_chars": int(doc.get("dek_chars", 300)),
        "tags": tuple(sorted(doc["geo_tags"])),
        "implies": {k: tuple(v) for k, v in doc.get("implies", {}).items()},
        "strip": _strip_pattern(doc.get("strip", [])),
        "regions": regions,
    }


def _first(patterns, text, lower):
    lower_pat, cased_pat = patterns
    hits = []
    if lower_pat is not None:
        m = lower_pat.search(lower)
        if m:
            hits.append((m.start(), m.group(0)))
    if cased_pat is not None:
        m = cased_pat.search(text)
        if m:
            hits.append((m.start(), m.group(0)))
    return min(hits)[1] if hits else None


def _lead(dek, limit):
    """The dek's first `limit` characters, ending on a whole word. Some feeds put the
    whole body in the dek; a place named in passing deep in it is not where the story is."""
    dek = dek or ""
    if len(dek) <= limit:
        return dek
    return dek[:limit].rsplit(" ", 1)[0]


def geo_signals(bucket, title, dek, geo=None):
    """{tag: the first term that qualified it} from the article's own text, before
    implication. A weak term is reported as "weak:<term>"."""
    geo = geo or load_geo()
    base = _normalize(f"{title or ''} . {_lead(dek, geo['dek_chars'])}")
    if geo["strip"] is not None:
        base = geo["strip"].sub(" ", base)
    found = {}
    for name, region in geo["regions"].items():
        text = region["exclude"].sub(" ", base) if region["exclude"] is not None else base
        lower = text.lower()
        hit = _first(region["strong"], text, lower)
        if hit is None and bucket in region["weak_buckets"]:
            weak = _first(region["weak"], text, lower)
            if weak is not None:
                hit = f"weak:{weak}"
        if hit is not None:
            found[name] = hit
    return found


def tag_geo(bucket, title, dek, geo=None):
    """Sorted geo tags for one article: its own text's regions plus what they imply
    (sg -> asia -> world)."""
    geo = geo or load_geo()
    tags = set(geo_signals(bucket, title, dek, geo))
    todo = list(tags)
    while todo:
        for implied in geo["implies"].get(todo.pop(), ()):
            if implied not in tags:
                tags.add(implied)
                todo.append(implied)
    return sorted(tags)


def _country_of(match, terms):
    """The country a matched lower-case term names, allowing the pattern's plural s or es."""
    for key in (match, match[:-1] if match.endswith("s") else None,
                match[:-2] if match.endswith("es") else None):
        if key and key in terms:
            return terms[key]
    return None


def tag_countries(title, dek, geo=None):
    """B4: sorted ISO 3166-1 alpha-2 codes the article's own title and dek lead name.
    Every country's terms form one longest-first alternation, scanned left to right, so a
    longer name ("papua new guinea", "north korea") is consumed before a shorter one inside
    it can match. A strong hit on a from_regions G1 region adds that country too."""
    geo = geo or load_geo()
    base = _normalize(f"{title or ''} . {_lead(dek, geo['dek_chars'])}")
    if geo["strip"] is not None:
        base = geo["strip"].sub(" ", base)
    found = set()
    for code, region_name in geo["country_regions"].items():
        region = geo["regions"][region_name]
        text = region["exclude"].sub(" ", base) if region["exclude"] is not None else base
        if _first(region["strong"], text, text.lower()) is not None:
            found.add(code)
    text = geo["country_strip"].sub(" ", base) if geo["country_strip"] is not None else base
    lower_terms, cased_terms = geo["country_terms"]
    lower_pat, cased_pat = geo["country_patterns"]
    if lower_pat is not None:
        for m in lower_pat.finditer(text.lower()):
            code = _country_of(m.group(0), lower_terms)
            if code:
                found.add(code)
    if cased_pat is not None:
        for m in cased_pat.finditer(text):
            code = cased_terms.get(m.group(0))
            if code:
                found.add(code)
    return sorted(found)
