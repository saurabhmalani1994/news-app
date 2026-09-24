"""Dek cleanup and fitting (D1), display layer only: the pool keeps what the feed sent.

Feed descriptions carry wire and CMS debris a front page never shows: a leading
dateline or credit ("WASHINGTON --", "LONDON (Reuters) -", "(AP) -", "[Dabanga]") and
a trailing CMS line ("Continue reading...", "The post X appeared first on Y.", "[...]").
`strip_wire_junk` removes both, deterministically, with fixed patterns and no guessing
beyond them. `fit_dek` then ends the dek on a whole sentence that fits the tier's line
budget, so the page never shows a dek cut mid thought; only when not even the first
sentence fits does it end on an ellipsis, at a clause break or a whole word.

Punctuation: a leftover ASCII "--" becomes a spaced en dash. Nothing here ever emits an
em dash; the em dash below is only ever matched, as a dateline separator, and removed.
"""
import re

EN_DASH = chr(0x2013)
EM_DASH = chr(0x2014)
ELLIPSIS = chr(0x2026)
RSQUO, LSQUO, LDQUO, RDQUO = chr(0x2019), chr(0x2018), chr(0x201C), chr(0x201D)

# Wire and syndication credits that sit in parentheses inside a dateline.
_AGENCIES = (
    "AP", "Reuters", "AFP", "UPI", "Bloomberg", "CNN", "dpa", "DPA", "Xinhua", "Yonhap",
    "Kyodo", "PTI", "IANS", "ANI", "Bernama", "CNA", "AAP", "Anadolu", "EFE", "ANSA",
    "TASS", "WAFA", "KCNA", "BBC", "NPR", "Al Jazeera", "Nikkei", "SCMP", "CNBC",
)
_AGENCY = "|".join(sorted((re.escape(a) for a in _AGENCIES), key=len, reverse=True))
_ONE_DASH = "[-" + EN_DASH + EM_DASH + "]"

# "[Dabanga] ", "[Unicef] ": a bracketed source tag before the text.
_SOURCE_TAG = re.compile(r"^\[[^\]\n]{1,30}\]\s*")

# "(AP) -", "LONDON (Reuters) -", "WASHINGTON, Sept 23 (Reuters) --": a place of at most
# 60 characters, then a known agency credit, then a dash or colon.
_CREDIT = re.compile(
    r"^(?:[^()\n]{0,60}?\s*)?\((?:" + _AGENCY + r")\)\s*(?:--|" + _ONE_DASH + r"|:)\s*"
)

# "WASHINGTON --", "New York --", "Eastern Chad / Darfur --": a place in capitalised
# words (slashes and commas between them), then the double hyphen wires use.
_PLACE_WORD = r"(?:[A-Z][\w.'" + RSQUO + r"&-]*|de|del|el|al|la|of)"
_DOUBLE_HYPHEN = re.compile(
    r"^" + _PLACE_WORD + r"(?:\s*[,/]?\s*" + _PLACE_WORD + r"){0,9}\s+--\s+"
)

# "GAZA CITY - ", "BEIRUT, Lebanon - " with any single dash: an all capitals place of at
# least two letters, an optional capitalised region, then the dash.
_CAPS_PLACE = re.compile(
    r"^[A-Z][A-Z.'" + RSQUO + r"-]+(?: [A-Z][A-Z.'" + RSQUO + r"-]+){0,3}"
    r"(?:, [A-Z][\w.]*(?: [A-Z][\w.]*){0,2})?\s+" + _ONE_DASH + r"\s+"
)

_TRAILERS = (
    # WordPress: "The post <title> appeared first on <site>."
    re.compile(r"\s*The post\b.{0,300}?\bappeared first on\b.{1,80}$", re.S),
    re.compile(r"\s*Continue reading\s*(?:\.\.\.|" + ELLIPSIS + r")?\s*$"),
    re.compile(r"\s*Read (?:the )?full (?:story|article)(?: here)?\.?\s*$", re.I),
    # A bracketed ellipsis is the feed saying it cut the text.
    re.compile(r"\s*\[(?:\.\.\.|" + ELLIPSIS + r")\]\s*$"),
)

_DOUBLE_DASH = re.compile(r"\s*(?<!-)--(?!-)\s*")
_THREE_DOTS = re.compile(r"(?<!\.)\.\.\.(?!\.)")
_EDGE = " -,;:" + EN_DASH + EM_DASH


def strip_wire_junk(text):
    """The dek without its leading dateline or credit and trailing CMS line, with
    spaces collapsed and a leftover '--' set as a spaced en dash."""
    text = " ".join((text or "").split())
    original = text
    changed = True
    while changed:  # "[Dabanga] New York -- ..." carries two leading layers
        before = text
        for pattern in (_SOURCE_TAG, _CREDIT, _DOUBLE_HYPHEN, _CAPS_PLACE):
            text = pattern.sub("", text, count=1)
        changed = text != before
    stripped_lead = text != original
    changed = True
    while changed:
        before = text
        for pattern in _TRAILERS:
            text = pattern.sub("", text)
        changed = text != before
    text = _DOUBLE_DASH.sub(f" {EN_DASH} ", text)
    text = _THREE_DOTS.sub(ELLIPSIS, text)
    text = text.strip(_EDGE)
    if stripped_lead and text[:1].islower():
        text = text[0].upper() + text[1:]
    return text


_CLOSERS = "\"')\\]" + RSQUO + RDQUO
_OPENERS = "\"'(\\[" + LSQUO + LDQUO
# A sentence ends at . ! or ? (optionally closed by a quote or bracket) before a space
# and a capital, digit or opening quote. Abbreviations and initials do not end one.
_BOUNDARY = re.compile(r"[.!?][" + _CLOSERS + r"]*(?=\s+[" + _OPENERS + r"]?[A-Z0-9])")
_NOT_AN_END = re.compile(
    r"(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sen|Rep|Gov|Gen|Lt|Col|Capt|Sgt|Adm|Brig|Maj|Cmdr|St|Jr|Sr|"
    r"No|Nos|vs|Inc|Corp|Co|Ltd|Jan|Feb|Mar|Apr|Aug|Sept|Sep|Oct|Nov|Dec|Mt|Ft|Pres|"
    r"approx|est|etc|Vol|Fig)\.|\b[A-Z]\.|\b(?:[A-Za-z]\.){2,})$"
)
_COMPLETE = re.compile(r"[.!?][" + _CLOSERS + r"]*$")


def sentences(text):
    """Split into sentences, keeping each one's closing punctuation."""
    out, start = [], 0
    for match in _BOUNDARY.finditer(text):
        if _NOT_AN_END.search(text[start:match.start() + 1]):
            continue
        out.append(text[start:match.end()].strip())
        start = match.end()
    tail = text[start:].strip()
    if tail:
        out.append(tail)
    return out


def _is_complete(sentence):
    return bool(_COMPLETE.search(sentence))


def fit_dek(text, max_chars):
    """The longest run of whole leading sentences within max_chars.

    max_chars is the tier's line budget in characters (lines times a conservative
    characters-per-line at 360dp). A trailing fragment the feed cut short never counts
    as a sentence. Only when no complete sentence fits does the dek end on an ellipsis,
    and then at a clause break or a word, never inside a word (see `_shorten`).
    """
    if not text:
        return ""
    parts = sentences(text)
    kept = ""
    for part in parts:
        candidate = f"{kept} {part}".strip()
        if len(candidate) > max_chars or not _is_complete(part):
            break
        kept = candidate
    return kept or _shorten(parts[0], max_chars)


_CLAUSE_BREAK = re.compile(r"[,;:]\s|\s" + EN_DASH + r"\s|\s" + EM_DASH + r"\s")
_TRAILING = " ,;:-" + EN_DASH + EM_DASH + ELLIPSIS + "."


def _shorten(sentence, max_chars):
    """A first sentence longer than the budget, cut to fit and closed with an ellipsis:
    at the last clause break (comma, semicolon, colon, dash) in the budget's back 40%,
    else at the last whole word. The CSS clamp stays only as a safety net."""
    if len(sentence) <= max_chars:
        return sentence
    room = max_chars - 1  # the ellipsis
    window = sentence[:room + 1]
    breaks = [m.start() for m in _CLAUSE_BREAK.finditer(window) if m.start() >= room * 0.6]
    if breaks:
        cut = sentence[:breaks[-1]]
    else:
        cut = window[:window.rfind(" ")] if " " in window else window[:room]
    return cut.rstrip(_TRAILING) + ELLIPSIS
