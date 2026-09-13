#!/usr/bin/env python3
"""
Generate set avatar default untuk Uno Online (PNG 256x256).

14 karakter flat + 1 fallback, semua digambar deterministik supaya hasilnya
konsisten dan bisa di-regenerate kapan saja:

    python3 tools/generate_avatars.py                 # -> client/assets/avatars/
    python3 tools/generate_avatars.py --sheet av.png  # + kontak sheet
"""

import argparse
import os

from PIL import Image, ImageDraw, ImageFilter

SS = 3               # supersampling
SIZE = 256           # ukuran akhir
R = 64               # radius sudut

# (latar terang, latar gelap, warna kepala, warna garis)
PALETTES = [
    ((255, 224, 138), (247, 181, 56), (255, 252, 240), (74, 52, 12)),
    ((168, 224, 255), (74, 168, 240), (245, 253, 255), (12, 52, 84)),
    ((255, 189, 189), (238, 106, 106), (255, 248, 248), (92, 26, 26)),
    ((189, 240, 206), (72, 194, 128), (247, 255, 250), (16, 74, 46)),
    ((216, 199, 255), (142, 108, 240), (250, 247, 255), (48, 24, 104)),
    ((255, 214, 176), (238, 148, 76), (255, 250, 244), (96, 50, 8)),
    ((196, 232, 236), (86, 172, 182), (246, 253, 254), (14, 66, 74)),
    ((255, 236, 168), (240, 196, 64), (255, 253, 246), (86, 62, 10)),
    ((186, 214, 255), (94, 128, 240), (248, 250, 255), (22, 34, 96)),
    ((255, 200, 226), (232, 108, 172), (255, 249, 252), (98, 22, 60)),
    ((206, 240, 190), (134, 198, 74), (250, 255, 246), (40, 74, 14)),
    ((255, 214, 190), (236, 126, 96), (255, 250, 246), (94, 34, 16)),
    ((202, 226, 255), (110, 160, 236), (248, 251, 255), (20, 46, 92)),
    ((224, 214, 255), (150, 126, 232), (252, 250, 255), (48, 32, 100)),
]

TYPES = ["blob", "cat", "robot", "ghost", "bear", "alien", "fox"]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


_grad_cache = {}


def gradient(light, dark, size):
    key = (light, dark, size)
    if key in _grad_cache:
        return _grad_cache[key]
    g = Image.new("RGB", size)
    d = ImageDraw.Draw(g)
    for y in range(size[1]):
        d.line([(0, y), (size[0], y)], fill=lerp(light, dark, y / (size[1] - 1)))
    _grad_cache[key] = g
    return g


def rounded_mask(size, box, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=radius, fill=255)
    return m


# --- Fitur wajah -------------------------------------------------------------

def eyes(d, ink, cx, cy, spread, rx, ry, kind="dot", blush=None):
    for sign in (-1, 1):
        x = cx + sign * spread
        if kind == "dot":
            d.ellipse([x - rx, cy - ry, x + rx, cy + ry], fill=ink)
        elif kind == "ring":
            d.ellipse([x - rx, cy - ry, x + rx, cy + ry], fill=(255, 255, 255))
            d.ellipse([x - rx * 0.5, cy - ry * 0.5, x + rx * 0.5, cy + ry * 0.5], fill=ink)
        elif kind == "happy":
            d.arc([x - rx, cy - ry, x + rx, cy + ry], 200, 340, fill=ink, width=max(2, int(rx * 0.6)))
        elif kind == "square":
            d.rounded_rectangle([x - rx, cy - ry, x + rx, cy + ry], radius=rx * 0.35, fill=ink)
        elif kind == "cross":
            w = max(2, int(rx * 0.42))
            d.line([(x - rx, cy - ry), (x + rx, cy + ry)], fill=ink, width=w)
            d.line([(x + rx, cy - ry), (x - rx, cy + ry)], fill=ink, width=w)
    if blush:
        for sign in (-1, 1):
            x = cx + sign * (spread + rx * 1.5)
            d.ellipse([x - rx * 0.8, cy + ry * 1.4, x + rx * 0.8, cy + ry * 2.6], fill=blush)


def mouth(d, ink, cx, cy, w, kind="smile"):
    if kind == "smile":
        d.arc([cx - w, cy - w * 0.8, cx + w, cy + w * 0.8], 20, 160, fill=ink, width=max(2, int(w * 0.22)))
    elif kind == "o":
        r = w * 0.36
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ink)
    elif kind == "flat":
        d.line([(cx - w * 0.7, cy), (cx + w * 0.7, cy)], fill=ink, width=max(2, int(w * 0.2)))
    elif kind == "cat":
        d.arc([cx - w * 0.6, cy - w * 0.5, cx, cy + w * 0.4], 0, 150, fill=ink, width=max(2, int(w * 0.18)))
        d.arc([cx, cy - w * 0.5, cx + w * 0.6, cy + w * 0.4], 30, 180, fill=ink, width=max(2, int(w * 0.18)))


# --- Karakter ----------------------------------------------------------------

def draw_character(img, kind, pal):
    S = SS
    light, dark, head, ink = pal
    size = SIZE * S
    d = ImageDraw.Draw(img)
    cx, cy = size / 2, size / 2 + 8 * S

    hw = 62 * S   # setengah lebar kepala
    hh = 58 * S   # setengah tinggi kepala

    # Badan/bayangan lembut di bawah kepala
    d.ellipse([cx - hw * 1.05, cy + hh * 0.55, cx + hw * 1.05, cy + hh * 1.15],
              fill=tuple(int(c * 0.82) for c in dark))

    def head_shape():
        if kind == "blob":
            d.ellipse([cx - hw, cy - hh, cx + hw, cy + hh], fill=head)
        elif kind == "cat":
            d.polygon([(cx - hw * 0.86, cy - hh * 0.62), (cx - hw * 0.98, cy - hh * 1.62),
                       (cx - hw * 0.12, cy - hh * 0.96)], fill=head)
            d.polygon([(cx + hw * 0.86, cy - hh * 0.62), (cx + hw * 0.98, cy - hh * 1.62),
                       (cx + hw * 0.12, cy - hh * 0.96)], fill=head)
            d.ellipse([cx - hw, cy - hh, cx + hw, cy + hh], fill=head)
        elif kind == "robot":
            d.rounded_rectangle([cx - hw * 0.94, cy - hh, cx + hw * 0.94, cy + hh],
                                radius=22 * S, fill=head)
        elif kind == "ghost":
            d.rounded_rectangle([cx - hw, cy - hh, cx + hw, cy + hh * 0.85],
                                radius=int(hw * 0.9), corners=(True, True, False, False), fill=head)
            bumps = 4
            bw = (hw * 2) / bumps
            for i in range(bumps):
                bx = cx - hw + bw * i + bw / 2
                by = cy + hh * 0.85
                d.ellipse([bx - bw / 2, by - bw * 0.45, bx + bw / 2, by + bw * 0.45], fill=head)
        elif kind == "bear":
            d.ellipse([cx - hw * 1.08, cy - hh * 1.18, cx - hw * 0.34, cy - hh * 0.42], fill=head)
            d.ellipse([cx + hw * 0.34, cy - hh * 1.18, cx + hw * 1.08, cy - hh * 0.42], fill=head)
            d.ellipse([cx - hw, cy - hh, cx + hw, cy + hh], fill=head)
        elif kind == "alien":
            d.ellipse([cx - hw * 0.86, cy - hh * 1.18, cx + hw * 0.86, cy + hh * 1.05], fill=head)
        elif kind == "fox":
            d.polygon([(cx - hw * 0.9, cy - hh * 0.5), (cx - hw * 1.0, cy - hh * 1.7),
                       (cx - hw * 0.1, cy - hh * 0.94)], fill=head)
            d.polygon([(cx + hw * 0.9, cy - hh * 0.5), (cx + hw * 1.0, cy - hh * 1.7),
                       (cx + hw * 0.1, cy - hh * 0.94)], fill=head)
            d.rounded_rectangle([cx - hw * 0.9, cy - hh, cx + hw * 0.9, cy + hh],
                                radius=30 * S, fill=head)

    head_shape()

    # Aksesori khas per tipe
    if kind == "robot":
        d.line([(cx, cy - hh), (cx, cy - hh * 1.5)], fill=ink, width=5 * S)
        d.ellipse([cx - 9 * S, cy - hh * 1.5 - 9 * S, cx + 9 * S, cy - hh * 1.5 + 9 * S], fill=dark)
        eyes(d, ink, cx, cy - 12 * S, 26 * S, 11 * S, 11 * S, kind="square")
        mouth(d, ink, cx, cy + 24 * S, 20 * S, kind="flat")
    elif kind == "alien":
        eyes(d, ink, cx, cy - 34 * S, 26 * S, 12 * S, 15 * S, kind="ring")
        eyes(d, ink, cx, cy + 2 * S, 0, 13 * S, 16 * S, kind="ring")
        mouth(d, ink, cx, cy + 40 * S, 16 * S, kind="o")
    elif kind == "cat":
        eyes(d, ink, cx, cy - 6 * S, 26 * S, 12 * S, 14 * S, kind="dot")
        mouth(d, ink, cx, cy + 22 * S, 26 * S, kind="cat")
        d.line([(cx - 40 * S, cy + 8 * S), (cx - 70 * S, cy + 4 * S)], fill=ink, width=3 * S)
        d.line([(cx + 40 * S, cy + 8 * S), (cx + 70 * S, cy + 4 * S)], fill=ink, width=3 * S)
    elif kind == "bear":
        eyes(d, ink, cx, cy - 8 * S, 25 * S, 11 * S, 13 * S, kind="dot")
        d.ellipse([cx - 24 * S, cy + 8 * S, cx + 24 * S, cy + 40 * S], fill=(238, 220, 206))
        d.ellipse([cx - 9 * S, cy + 14 * S, cx + 9 * S, cy + 30 * S], fill=ink)
        mouth(d, ink, cx, cy + 30 * S, 16 * S, kind="smile")
    elif kind == "ghost":
        eyes(d, (30, 30, 45), cx, cy - 14 * S, 26 * S, 13 * S, 16 * S, kind="dot")
        mouth(d, (30, 30, 45), cx, cy + 26 * S, 22 * S, kind="o")
    elif kind == "fox":
        eyes(d, ink, cx, cy - 8 * S, 26 * S, 12 * S, 14 * S, kind="dot")
        d.ellipse([cx - 34 * S, cy + 8 * S, cx + 34 * S, cy + 50 * S], fill=(255, 255, 255))
        d.ellipse([cx - 9 * S, cy + 18 * S, cx + 9 * S, cy + 34 * S], fill=ink)
        mouth(d, ink, cx, cy + 34 * S, 20 * S, kind="smile")
    else:  # blob
        eyes(d, ink, cx, cy - 6 * S, 26 * S, 12 * S, 15 * S, kind="dot", blush=(255, 150, 150))
        mouth(d, ink, cx, cy + 24 * S, 24 * S, kind="smile")


def build(kind, pal):
    S = SS
    size = SIZE * S
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([6 * S, 9 * S, (SIZE - 6) * S, (SIZE - 6) * S],
                                         radius=R * S, fill=(0, 0, 0, 120))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(7 * S)))

    box = [5 * S, 5 * S, (SIZE - 5) * S, (SIZE - 5) * S]
    grad = gradient(pal[0], pal[1], img.size)
    img.paste(grad, (0, 0), rounded_mask(img.size, box, R * S))
    ImageDraw.Draw(img).rounded_rectangle(box, radius=R * S, outline=(0, 0, 0, 40), width=S)

    draw_character(img, kind, pal)
    return img.resize((SIZE, SIZE), Image.LANCZOS).convert("RGBA")


def build_fallback():
    size = SIZE * SS
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    box = [5 * SS, 5 * SS, (SIZE - 5) * SS, (SIZE - 5) * SS]
    img.paste(gradient((150, 156, 166), (98, 104, 116), img.size), (0, 0),
              rounded_mask(img.size, box, R * SS))
    d = ImageDraw.Draw(img)
    cx = cy = size / 2
    d.ellipse([cx - 40 * SS, cy - 62 * SS, cx + 40 * SS, cy + 18 * SS], fill=(235, 238, 242))
    d.ellipse([cx - 62 * SS, cy + 6 * SS, cx + 62 * SS, cy + 92 * SS], fill=(235, 238, 242))
    return img.resize((SIZE, SIZE), Image.LANCZOS).convert("RGBA")


def sheet(files, out):
    cols, pad = 7, 8
    cell = SIZE // 2
    rows = (len(files) + cols - 1) // cols
    im = Image.new("RGB", (cols * (cell + pad) + pad, rows * (cell + pad) + pad), (26, 28, 32))
    for i, f in enumerate(files):
        a = Image.open(f).convert("RGBA").resize((cell, cell), Image.LANCZOS)
        bg = Image.new("RGB", (cell, cell), (26, 28, 32))
        bg.paste(a, (0, 0), a)
        im.paste(bg, (pad + (i % cols) * (cell + pad), pad + (i // cols) * (cell + pad)))
    im.save(out, "PNG", optimize=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join("client", "assets", "avatars"))
    ap.add_argument("--sheet", default=None)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    files = []
    for i, pal in enumerate(PALETTES):
        kind = TYPES[i % len(TYPES)]
        name = f"a{i + 1:02d}.png"
        p = os.path.join(args.out, name)
        build(kind, pal).save(p, "PNG", optimize=True)
        files.append(p)
    fb = os.path.join(args.out, "fallback.png")
    build_fallback().save(fb, "PNG", optimize=True)
    files.append(fb)

    if args.sheet:
        os.makedirs(os.path.dirname(os.path.abspath(args.sheet)), exist_ok=True)
        sheet(files, args.sheet)

    print(f"{len(files)} avatar ditulis ke {args.out}")


if __name__ == "__main__":
    main()
