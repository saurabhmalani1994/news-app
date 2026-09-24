"""Display-layer typography (S04). Applied only when a string is rendered, never to the
pool: the published titles stay byte-for-byte what the feed sent, so the S01 title
equality proof still compares against the pool, on the folded form below.
"""

LSQUO, RSQUO, LDQUO, RDQUO = "‘", "’", "“", "”"

# A quote after one of these (or at the start) opens; anywhere else it closes.
_OPENS_AFTER = set(" \t\n\r([{<-/–" + LSQUO + LDQUO)

_FOLD = str.maketrans({LSQUO: "'", RSQUO: "'", LDQUO: '"', RDQUO: '"'})


def smart_quotes(text):
    """Straight quotes and apostrophes to typographic ones, left to right.

    don't -> don’t, "Yes" -> “Yes”, 'Yes' -> ‘Yes’,
    students' -> students’, '90s -> ’90s. Nothing but the two straight
    quote characters is ever changed, so len(out) == len(text).
    """
    out = []
    n = len(text)
    for i, ch in enumerate(text):
        prev = out[-1] if out else ""
        opens = prev == "" or prev in _OPENS_AFTER
        if ch == "'":
            nxt = text[i + 1] if i + 1 < n else ""
            if not opens:
                out.append(RSQUO)  # apostrophe inside or after a word, or a closing quote
            elif nxt.isdigit() and text[i + 1:i + 3].isdigit() and not text[i + 3:i + 4].isdigit():
                out.append(RSQUO)  # elided century: '90s, '26
            else:
                out.append(LSQUO)
        elif ch == '"':
            out.append(LDQUO if opens else RDQUO)
        else:
            out.append(ch)
    return "".join(out)


def fold_quotes(text):
    """Map curly quotes back to straight ones, for comparing rendered text to the pool."""
    return text.translate(_FOLD)
