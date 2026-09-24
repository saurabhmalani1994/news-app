"""Generate app/static/tokens.css from app/design/nyt-design-values.json.

The JSON holds only measured numbers and role names (no NYT text, no screenshots),
copied from research/nyt-measured.md and its companion values file. Dark values come
straight from that JSON (MEASURED, Galaxy S23, R3). Light values have no source in the
research, since only the dark app was measured; LIGHT_COLOR below is this repo's own
palette on the same roles, checked against WCAG AA by tests/test_tokens.py.

Font sizes are fitted to the MEASURED cap heights (capDp) using the cap-height ratio of
the font we actually ship, not the 0.70 ratio the research assumed. That keeps the
visible size of each tier equal to the measurement. Line heights keep the MEASURED
leading ratio (line pitch over NYT's inferred size) at the fitted size: Newsreader sits
lower in its em than NYT's face, so the raw 23dp pitch under a 22.5px river headline
set descenders on the next line's ascenders (D1).

Fonts (all SIL OFL 1.1, self-hosted, Latin subset, hinting dropped):
  Newsreader Bold, instanced at wght 700 opsz 20 (headlines, wordmark)
  Newsreader Regular, instanced at wght 400 opsz 16 (dek, later slices)
  Libre Franklin Medium 500 (meta, labels, nav)
Built once with fontTools varLib.instancer plus subset to the Google Fonts "latin"
range; the woff2 files are committed, nothing is fetched at build or run time.
The fallback overrides below are computed from those files against Georgia and Noto
Serif (serif) and Arial and Roboto (sans), frequency-weighted English advance widths.

Usage: python -m app.design.generate_tokens > app/static/tokens.css
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VALUES = json.loads((ROOT / "app/design/nyt-design-values.json").read_text(encoding="utf-8"))

# Cap height / em of the shipped fonts (OS/2 sCapHeight / unitsPerEm).
CAP_RATIO = {"serif": 0.67, "sans": 0.742}

# Derived, not measured: same roles as VALUES["color"], AA checked in the test.
LIGHT_COLOR = {
    "bg": "#FFFFFF",
    "surface": "#F7F7F7",
    "text": "#121212",
    "textDek": "#4D4D4D",
    "textMeta": "#5A5A5A",
    "textMetaTertiary": "#6B6B6B",
    "ruleThin": "#E2E2E2",
    "tabActive": "#121212",
    "tabInactive": "#5A5A5A",
    "navInactive": "#6B6B6B",
    "pressed": "#F0F0F0",
    "imagePlaceholder": "#EEEEEE",
    "themeColor": "#FFFFFF",
    "liveDot": "#C4272C",
}
# Pressed row tint in dark: one step above the page, below the nav surface. An image box
# before (or instead of) its photo (S39): a quiet step above the pressed tint, still
# below the nav surface, so a slow or failed photo reads as an empty frame, not a panel.
# S33: liveDot is this repo's own choice too, not measured (no live/breaking indicator
# turned up in the granted reference captures): a calm, desaturated red, one value in
# both themes, used only as decoration (a small dot, never text), so it is not part of
# the AA text-contrast check below.
DARK_EXTRA = {"pressed": "#1E1E1E", "imagePlaceholder": "#222222", "themeColor": VALUES["color"]["bg"], "liveDot": "#C4272C"}

COLOR_ROLES = [
    # (token slug, JSON key)
    ("bg", "bg"),
    ("nav-surface", "surface"),
    ("headline", "text"),
    ("dek", "textDek"),
    ("meta", "textMeta"),
    ("meta-tertiary", "textMetaTertiary"),
    ("divider", "ruleThin"),
    ("tab-active", "tabActive"),
    ("tab-inactive", "tabInactive"),
    ("nav-inactive", "navInactive"),
    ("pressed", "pressed"),
    ("image-placeholder", "imagePlaceholder"),
    ("theme", "themeColor"),
    ("live-dot", "liveDot"),
]

WEIGHT_NUM = {"regular": 400, "medium": 500, "bold": 700, "bold-italic": 700}

TYPE_ROLES = [
    # (token slug, JSON key, family)
    ("hero-headline", "heroHeadline", "serif"),
    ("river-headline", "riverHeadline", "serif"),
    ("text-only-headline", "textOnlyHeadline", "serif"),
    ("dek", "dek", "serif"),
    ("meta", "meta", "sans"),
    ("tab-label", "tabLabel", "sans"),
    ("bottom-nav-label", "bottomNavLabel", "sans"),
    ("article-headline", "articleHeadline", "serif"),
    ("body", "bodyText", "serif"),
]

# The wordmark is Almanac's own; nothing about it was measured beyond the 56dp band.
WORDMARK = {"size": 28, "lineHeight": 32, "tracking": -0.01}

FONT_FACES = [
    # (family, file, weight)
    ("Newsreader", "Newsreader-Bold-latin.woff2", 700),
    ("Newsreader", "Newsreader-Regular-latin.woff2", 400),
    ("Libre Franklin", "LibreFranklin-Medium-latin.woff2", 500),
]

# Metric-matched local fallbacks, so the swap moves nothing. (family, local names,
# weight, size-adjust %, ascent %, descent %).
FALLBACK_FACES = [
    ("Newsreader Fallback", ["Georgia Bold", "Georgia-Bold"], 700, 85.53, 85.93, 30.98),
    ("Newsreader Fallback Android", ["Noto Serif Bold", "NotoSerif-Bold"], 700, 86.97, 84.51, 30.47),
    ("Newsreader Fallback", ["Georgia"], 400, 96.65, 76.05, 27.42),
    ("Newsreader Fallback Android", ["Noto Serif", "NotoSerif-Regular"], 400, 84.69, 86.79, 31.29),
    ("Libre Franklin Fallback", ["Arial"], 500, 105.1, 91.91, 23.41),
    ("Libre Franklin Fallback Android", ["Roboto Medium", "Roboto-Medium"], 500, 104.9, 92.09, 23.45),
]


def fitted_size(role, family):
    """Font size in px whose cap height equals the measured capDp, to 0.5px.

    The text-only headline is set at the dek's size (measured caps 10.7 and 10.9dp are
    one size within measurement error), bold where the dek is regular.
    """
    if role is VALUES["type"]["textOnlyHeadline"]:
        role = VALUES["type"]["dek"]
    cap = role.get("capDp")
    if cap is None:
        return role["sizeDp"]
    return round(cap / CAP_RATIO[family] * 2) / 2


def fitted_line_height(role, family):
    """Line height in whole px (so lines land on the 3x device grid): the measured
    pitch-to-size ratio times the fitted size.
    The text-only headline borrows the dek's pitch, as its size does."""
    size = fitted_size(role, family)
    if role is VALUES["type"]["textOnlyHeadline"]:
        role = VALUES["type"]["dek"]
    return int(size * role["lineHeightDp"] / role["sizeDp"] + 0.5)


def _num(x):
    return f"{x:g}"


def _color_block(palette, indent):
    pad = " " * indent
    return "\n".join(f"{pad}--color-{slug}: {palette[key]};" for slug, key in COLOR_ROLES)


def _type_block():
    t = VALUES["type"]
    lines = []
    for slug, key, family in TYPE_ROLES:
        role = t[key]
        lines.append(f"  --type-{slug}-family: var(--font-{family});")
        lines.append(f"  --type-{slug}-size: {_num(fitted_size(role, family))}px;")
        lines.append(f"  --type-{slug}-line-height: {_num(fitted_line_height(role, family))}px;")
        lines.append(f"  --type-{slug}-weight: {WEIGHT_NUM[role['weight']]};")
        lines.append(f"  --type-{slug}-tracking: {_num(role.get('trackingEm', 0))}em;")
        transform = "uppercase" if role.get("case") == "upper" else "none"
        lines.append(f"  --type-{slug}-transform: {transform};")
    lines.append(f"  --type-wordmark-size: {WORDMARK['size']}px;")
    lines.append(f"  --type-wordmark-line-height: {WORDMARK['lineHeight']}px;")
    lines.append(f"  --type-wordmark-tracking: {_num(WORDMARK['tracking'])}em;")
    return "\n".join(lines)


def _space_block():
    s, r, ch = VALUES["space"], VALUES["rule"], VALUES["chrome"]
    lines = [
        f"  --space-gutter: {s['gutterDp']}px;",
        f"  --space-headline-to-dek: {s['headlineToDekDp']}px;",
        f"  --space-dek-to-meta: {s['dekToMetaDp']}px;",
        f"  --space-block-gap: {s['blockGapDp']}px;",
        f"  --divider-weight: {r['thinPx']}px;",
        f"  --divider-inset: {r['thinInsetDp']}px;",
        f"  --chrome-masthead: {ch['mastheadDp']}px;",
        f"  --chrome-tab-bar: {ch['tabBarDp']}px;",
        f"  --chrome-bottom-nav: {ch['bottomNavDp']}px;",
        "  --touch-min: 48px;",
        "  --viewport-primary: 360px;",
        "  --motion-duration: 160ms;",
        "  --motion-ease: cubic-bezier(0, 0, 0.2, 1);",
    ]
    return "\n".join(lines)


def _font_faces():
    out = []
    for family, file, weight in FONT_FACES:
        out.append(
            "@font-face {\n"
            f"  font-family: '{family}';\n"
            f"  src: url('fonts/{file}') format('woff2');\n"
            f"  font-weight: {weight};\n"
            "  font-style: normal;\n"
            "  font-display: swap;\n"
            "}"
        )
    for family, names, weight, size, ascent, descent in FALLBACK_FACES:
        src = ", ".join(f"local('{n}')" for n in names)
        out.append(
            "@font-face {\n"
            f"  font-family: '{family}';\n"
            f"  src: {src};\n"
            f"  font-weight: {weight};\n"
            f"  size-adjust: {_num(size)}%;\n"
            f"  ascent-override: {_num(ascent)}%;\n"
            f"  descent-override: {_num(descent)}%;\n"
            "  line-gap-override: 0%;\n"
            "}"
        )
    return "\n\n".join(out)


TEMPLATE = """/* GENERATED FILE. Run `python -m app.design.generate_tokens` to rebuild.
   Source: app/design/nyt-design-values.json (measured, R3, R14) plus this repo's own
   light palette and font metrics (see generate_tokens.py). Do not hand edit. */

{font_faces}

:root {{
  color-scheme: dark light;
  --font-serif: 'Newsreader', 'Newsreader Fallback', 'Newsreader Fallback Android', Georgia, serif;
  --font-sans: 'Libre Franklin', 'Libre Franklin Fallback', 'Libre Franklin Fallback Android', Arial, sans-serif;

  /* Color: dark is the primary theme (R3). Overridden below only when the OS
     explicitly prefers light; no preference stays dark. */
{dark_color}

{type}
{space}
}}

@media (prefers-color-scheme: light) {{
  :root {{
{light_color}
  }}
}}
"""


def render():
    dark = {**VALUES["color"], **DARK_EXTRA}
    return TEMPLATE.format(
        font_faces=_font_faces(),
        dark_color=_color_block(dark, 2),
        light_color=_color_block(LIGHT_COLOR, 4),
        type=_type_block(),
        space=_space_block(),
    )


def main():
    print(render(), end="")


if __name__ == "__main__":
    main()
