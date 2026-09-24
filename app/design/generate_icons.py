"""S18: generate the app icons as PNG files, committed as static assets the same way
tokens.css is a committed generated file (see generate_tokens.py). No Pillow, no npm: a
small standard-library PNG encoder (zlib + struct), so nothing outside the venv is
needed to regenerate them.

The mark is an "A" monogram in the app's own colors (tokens.css): the headline color on
the app background, drawn as a hollow serif-flavored triangle (the two legs of an A)
with a crossbar and small foot serifs, built from filled polygons, no font rendering.

Four files, all square:
  icon-192.png            192x192, purpose "any"
  icon-512.png             512x512, purpose "any"
  icon-512-maskable.png     512x512, purpose "maskable" (mark kept inside the safe zone,
                            background full bleed, per the W3C maskable icon spec)
  apple-touch-icon.png     180x180, iOS's own size, opaque background (iOS ignores alpha)

Run: python -m app.design.generate_icons
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "static" / "icons"

# Tokens (app/static/tokens.css): dark background and headline text, R3.
BG = (0x12, 0x12, 0x12, 255)
FG = (0xF8, 0xF8, 0xF8, 255)


def _new_canvas(size, color):
    row = bytes(color) * size
    return [bytearray(row) for _ in range(size)]


def _set_px(canvas, x, y, color):
    size = len(canvas)
    if 0 <= x < size and 0 <= y < size:
        canvas[y][x * 4:x * 4 + 4] = bytes(color)


def _edges(points):
    """Edge list for a scanline polygon fill: (y0, y1, x_at_y0, dx/dy)."""
    edges = []
    for i in range(len(points)):
        (x0, y0), (x1, y1) = points[i], points[(i + 1) % len(points)]
        if y0 == y1:
            continue
        if y0 > y1:
            x0, y0, x1, y1 = x1, y1, x0, y0
        edges.append((y0, y1, x0, (x1 - x0) / (y1 - y0)))
    return edges


def fill_polygon(canvas, points, color):
    """Even-odd scanline fill, supersampled 4x on each axis by the caller for AA."""
    size = len(canvas)
    edges = _edges(points)
    ys = [p[1] for p in points]
    for y in range(max(0, int(min(ys))), min(size, int(max(ys)) + 1)):
        yc = y + 0.5
        xs = sorted(x0 + (yc - y0) * dxdy for (y0, y1, x0, dxdy) in edges if y0 <= yc < y1)
        for i in range(0, len(xs) - 1, 2):
            for x in range(max(0, int(round(xs[i]))), min(size, int(round(xs[i + 1])))):
                _set_px(canvas, x, y, color)


def _downsample(canvas, factor):
    size = len(canvas) // factor
    out = _new_canvas(size, (0, 0, 0, 0))
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for dy in range(factor):
                row = canvas[y * factor + dy]
                for dx in range(factor):
                    i = (x * factor + dx) * 4
                    r += row[i]; g += row[i + 1]; b += row[i + 2]; a += row[i + 3]
            n = factor * factor
            out[y][x * 4:x * 4 + 4] = bytes((r // n, g // n, b // n, a // n))
    return out


def _leg_x(t, outer):
    """x offset from center at parameter t (0 at the apex, 1 at the base) along a leg's
    outer or inner edge, both straight lines from the apex point."""
    return t * (0.32 if outer else 0.205)


def _mark_polygons(size):
    """The A drawn as a small union of simple, non-overlapping shapes (two leg
    triangles sharing the apex point, a crossbar, two foot flares) so no polygon
    subtraction is needed: every shape is filled once, in order, with no knockout."""
    apex_y, base_y = 0.06, 0.90
    apex = (0.5, apex_y)

    def leg(sign):
        outer = (0.5 + sign * _leg_x(1.0, True), base_y)
        inner = (0.5 + sign * _leg_x(1.0, False), base_y)
        return [apex, outer, inner] if sign > 0 else [apex, inner, outer]

    left_leg, right_leg = leg(-1), leg(1)

    bar_y0, bar_y1 = 0.60, 0.685
    t = (((bar_y0 + bar_y1) / 2) - apex_y) / (base_y - apex_y)
    half_w = _leg_x(t, True)
    bar = [(0.5 - half_w, bar_y0), (0.5 + half_w, bar_y0), (0.5 + half_w, bar_y1), (0.5 - half_w, bar_y1)]

    foot_y0, foot_y1 = base_y, base_y + 0.045
    foot_out, foot_in = _leg_x(1.0, True) + 0.02, _leg_x(1.0, False) - 0.02
    left_foot = [(0.5 - foot_out, foot_y0), (0.5 - foot_in, foot_y0), (0.5 - foot_in, foot_y1), (0.5 - foot_out, foot_y1)]
    right_foot = [(0.5 + foot_in, foot_y0), (0.5 + foot_out, foot_y0), (0.5 + foot_out, foot_y1), (0.5 + foot_in, foot_y1)]

    shapes = [left_leg, right_leg, bar, left_foot, right_foot]
    return [[(x * size, y * size) for x, y in shape] for shape in shapes]


def draw_icon(size, maskable=False, opaque=True):
    """An RGBA canvas of `size` px: full-bleed background, the A-mark centered, scaled
    down for maskable's safe zone so nothing is lost to a circular OS mask."""
    ss = 4  # supersample factor for antialiasing, then box-downsample
    big = size * ss
    canvas = _new_canvas(big, BG if opaque else (0, 0, 0, 0))
    scale = 0.56 if maskable else 0.80
    mark_size = big * scale
    offset_x = (big - mark_size) / 2
    offset_y = (big - mark_size) / 2
    for shape in _mark_polygons(mark_size):
        fill_polygon(canvas, [(x + offset_x, y + offset_y) for x, y in shape], FG)
    return _downsample(canvas, ss)


def _chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


def encode_png(canvas):
    size = len(canvas)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = bytearray()
    for row in canvas:
        raw.append(0)
        raw.extend(row)
    idat = zlib.compress(bytes(raw), 9)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")


ICONS = (
    ("icon-192.png", 192, False, True),
    ("icon-512.png", 512, False, True),
    ("icon-512-maskable.png", 512, True, True),
    ("apple-touch-icon.png", 180, False, True),
)


def generate(out_dir=OUT):
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for name, size, maskable, opaque in ICONS:
        png = encode_png(draw_icon(size, maskable=maskable, opaque=opaque))
        path = out_dir / name
        path.write_bytes(png)
        written.append(path)
    return written


if __name__ == "__main__":
    for path in generate():
        print(f"wrote {path} ({path.stat().st_size} bytes)")
