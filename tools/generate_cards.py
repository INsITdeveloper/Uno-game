#!/usr/bin/env python3
"""
Generate aset gambar kartu UNO (54 muka kartu + 1 punggung kartu) sebagai PNG.

Semua kartu digambar secara vektor/deterministik dengan Pillow, lalu di-render
dengan supersampling 3x agar tepinya halus. Jalankan ulang kapan saja:

    python3 tools/generate_cards.py                 # -> client/assets/cards/
    python3 tools/generate_cards.py --out /tmp/x --sheet preview.png

Nama file:
    RED_0.png ... RED_9.png, RED_SKIP.png, RED_REVERSE.png, RED_DRAW_TWO.png
    (idem untuk YELLOW, GREEN, BLUE)
    WILD.png, WILD_DRAW_FOUR.png, BACK.png
"""

import argparse
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# --- Konfigurasi dasar -------------------------------------------------------
SS = 3              # faktor supersampling
W, H = 400, 620     # ukuran akhir kartu (perbandingan ~2.25 : 3.5 seperti kartu UNO)
CORNER_R = 40
MARGIN = 7

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

INK = (24, 24, 24)          # garis tepi / outline
PAPER = (255, 255, 255)

# (terang, gelap) untuk gradasi badan kartu
PALETTE = {
    "RED":    ((238, 72, 62),  (183, 26, 22)),
    "YELLOW": ((253, 214, 60), (226, 168, 12)),
    "GREEN":  ((86, 191, 84),  (28, 128, 56)),
    "BLUE":   ((62, 150, 236), (20, 88, 178)),
    "WILD":   ((58, 58, 58),   (16, 16, 16)),
}
WHEEL = ["RED", "YELLOW", "GREEN", "BLUE"]
COLORS = ["RED", "YELLOW", "GREEN", "BLUE"]
NUMBERS = [str(i) for i in range(10)]
ACTIONS = ["SKIP", "REVERSE", "DRAW_TWO"]

_font_cache = {}


def font(size):
    if size not in _font_cache:
        _font_cache[size] = ImageFont.truetype(FONT_PATH, size)
    return _font_cache[size]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


_grad_cache = {}


def gradient(color_key, size):
    """Gradasi vertikal terang->gelap, di-cache per warna."""
    key = (color_key, size)
    if key in _grad_cache:
        return _grad_cache[key]
    light, dark = PALETTE[color_key]
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


def text_sprite(text, size, fill, stroke=INK, stroke_w=0):
    """Render teks ke sprite RGBA (agar bisa diputar)."""
    f = font(size)
    bbox = f.getbbox(text, stroke_width=stroke_w)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad = stroke_w + 4
    im = Image.new("RGBA", (tw + pad * 2, th + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(im).text(
        (pad - bbox[0], pad - bbox[1]), text, font=f, fill=fill,
        stroke_width=stroke_w, stroke_fill=stroke
    )
    return im


def paste_center(base, sprite, cx, cy, rotate=0):
    s = sprite.rotate(rotate, resample=Image.BICUBIC, expand=True) if rotate else sprite
    base.alpha_composite(s, (int(cx - s.width / 2), int(cy - s.height / 2)))


# --- Bentuk glyph ------------------------------------------------------------

def draw_skip(d, cx, cy, r, color, ink_w, col_w):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=INK, width=ink_w)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=col_w)
    k = r * 0.70
    d.line([(cx - k, cy - k), (cx + k, cy + k)], fill=INK, width=ink_w + 4)
    d.line([(cx - k, cy - k), (cx + k, cy + k)], fill=color, width=col_w + 4)


def draw_arrow(d, cx, cy, half_len, direction, color, ink_w, col_w):
    """Satu panah horizontal; direction +1 ke kanan, -1 ke kiri."""
    x0 = cx - direction * half_len
    x1 = cx + direction * half_len
    head = half_len * 0.62
    shaft_end = x1 - direction * head
    d.line([(x0, cy), (shaft_end, cy)], fill=INK, width=ink_w)
    d.line([(x0, cy), (shaft_end, cy)], fill=color, width=col_w)

    hs = half_len * 0.52
    d.polygon([(x1, cy), (shaft_end, cy - hs), (shaft_end, cy + hs)], fill=INK)
    inset = col_w * 0.5
    d.polygon([
        (x1 - direction * inset, cy),
        (shaft_end + direction * inset, cy - hs + inset * 1.2),
        (shaft_end + direction * inset, cy + hs - inset * 1.2),
    ], fill=color)


def draw_reverse(d, cx, cy, half_len, color, ink_w, col_w):
    gap = half_len * 0.46
    draw_arrow(d, cx, cy - gap, half_len, +1, color, ink_w, col_w)
    draw_arrow(d, cx, cy + gap, half_len, -1, color, ink_w, col_w)


def draw_wheel(d, cx, cy, r):
    """Lingkaran 4 warna khas kartu Wild."""
    order = [PALETTE[k][0] for k in WHEEL]
    for i, col in enumerate(order):
        d.pieslice([cx - r, cy - r, cx + r, cy + r],
                   start=-135 + 90 * i, end=-45 + 90 * i, fill=col)
    ring = max(2, int(r * 0.05))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=INK, width=ring)


# --- Badan kartu -------------------------------------------------------------

def base_card(color_key, body=True):
    S = SS
    img = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))

    # Bayangan jatuh
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        [(MARGIN + 5) * S, (MARGIN + 9) * S, (W - MARGIN) * S, (H - MARGIN) * S],
        radius=CORNER_R * S, fill=(0, 0, 0, 130))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(9 * S)))

    d = ImageDraw.Draw(img)
    # Bingkai putih
    d.rounded_rectangle([MARGIN * S, MARGIN * S, (W - MARGIN) * S, (H - MARGIN) * S],
                        radius=CORNER_R * S, fill=PAPER)

    if body:
        inset = (MARGIN + 11) * S
        box = [inset, inset, (W - MARGIN - 11) * S, (H - MARGIN - 11) * S]
        radius = (CORNER_R - 10) * S
        grad = gradient(color_key, (W * S, H * S))
        img.paste(grad, (0, 0), rounded_mask(img.size, box, radius))
        d.rounded_rectangle(box, radius=radius, outline=(0, 0, 0, 45), width=max(1, S))

    return img


def white_ellipse(img):
    """Elips putih miring khas kartu UNO."""
    S = SS
    cx, cy = W * S / 2, H * S / 2
    a, b = 168 * S, 97 * S
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dl = ImageDraw.Draw(layer)
    dl.ellipse([cx - a - 5 * S, cy - b - 5 * S, cx + a + 5 * S, cy + b + 5 * S], fill=(0, 0, 0, 40))
    dl.ellipse([cx - a, cy - b, cx + a, cy + b], fill=PAPER)
    layer = layer.rotate(-30, resample=Image.BICUBIC, center=(cx, cy))
    img.alpha_composite(layer)
    return cx, cy


def corner_index(img, kind, color_key, dark=True):
    """Indeks di sudut kiri-atas & kanan-bawah."""
    S = SS
    cx_tl = (MARGIN + 34) * S
    cy_tl = (MARGIN + 32) * S
    body = PALETTE[color_key][0]
    if color_key == "WILD":
        fill, stroke = PAPER, INK
    else:
        fill, stroke = PAPER, INK

    size = 48 * S
    if kind in NUMBERS or kind == "DRAW_TWO":
        txt = kind if kind != "DRAW_TWO" else "+2"
        sprite = text_sprite(txt, size, fill, stroke, max(2, 3 * S))
    elif kind == "SKIP":
        sprite = Image.new("RGBA", (74 * S, 74 * S), (0, 0, 0, 0))
        ds = ImageDraw.Draw(sprite)
        c = sprite.width / 2
        draw_skip(ds, c, c, 30 * S, fill, max(3, 7 * S), max(2, 4 * S))
    elif kind == "REVERSE":
        sprite = Image.new("RGBA", (74 * S, 74 * S), (0, 0, 0, 0))
        ds = ImageDraw.Draw(sprite)
        draw_reverse(ds, sprite.width / 2, sprite.height / 2, 30 * S, fill,
                     max(3, 6 * S), max(2, 4 * S))
    elif kind == "WILD":
        sprite = Image.new("RGBA", (74 * S, 74 * S), (0, 0, 0, 0))
        draw_wheel(ImageDraw.Draw(sprite), 37 * S, 37 * S, 31 * S)
    elif kind == "WILD_DRAW_FOUR":
        sprite = text_sprite("+4", size, fill, stroke, max(2, 3 * S))
    else:
        sprite = text_sprite(kind, size, fill, stroke, max(2, 3 * S))

    img.alpha_composite(sprite, (int(cx_tl - sprite.width / 2), int(cy_tl - sprite.height / 2)))
    rot = sprite.rotate(180, resample=Image.BICUBIC, expand=True)
    img.alpha_composite(rot, (int(W * S - cx_tl - rot.width / 2), int(H * S - cy_tl - rot.height / 2)))


def build_colored(color_key, kind):
    img = base_card(color_key)
    cx, cy = white_ellipse(img)
    d = ImageDraw.Draw(img)
    body = PALETTE[color_key][0]
    ink_w = max(4, 13 * SS)
    col_w = max(3, 8 * SS)

    if kind in NUMBERS:
        sprite = text_sprite(kind, 190 * SS, body, INK, max(4, 7 * SS))
        paste_center(img, sprite, cx, cy)
    elif kind == "DRAW_TWO":
        sprite = text_sprite("+2", 165 * SS, body, INK, max(4, 7 * SS))
        paste_center(img, sprite, cx, cy)
    elif kind == "SKIP":
        draw_skip(d, cx, cy, 78 * SS, body, ink_w, col_w)
    elif kind == "REVERSE":
        draw_reverse(d, cx, cy, 92 * SS, body, ink_w, col_w)

    corner_index(img, kind, color_key)
    return img


def build_wild(draw_four):
    img = base_card("WILD")
    cx, cy = W * SS / 2, H * SS / 2
    d = ImageDraw.Draw(img)
    r = 132 * SS

    wheel = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw_wheel(ImageDraw.Draw(wheel), cx, cy, r)
    wheel = wheel.rotate(-30, resample=Image.BICUBIC, center=(cx, cy))
    img.alpha_composite(wheel)

    if draw_four:
        sprite = text_sprite("+4", 168 * SS, PAPER, INK, max(6, 14 * SS))
        paste_center(img, sprite, cx, cy)

    corner_index(img, "WILD_DRAW_FOUR" if draw_four else "WILD", "WILD")
    return img


def build_back():
    """Punggung kartu: pola geometris + label UNO."""
    img = base_card("WILD")
    cx, cy = W * SS / 2, H * SS / 2
    d = ImageDraw.Draw(img)

    # Pola diagonal
    step = 34 * SS
    for x in range(-H * SS, W * SS, step):
        d.line([(x, 0), (x + H * SS, H * SS)], fill=(255, 255, 255, 22), width=max(2, 9 * SS))

    # Elips putih miring
    a, b = 150 * SS, 168 * SS
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dl = ImageDraw.Draw(layer)
    dl.ellipse([cx - a - 6 * SS, cy - b - 6 * SS, cx + a + 6 * SS, cy + b + 6 * SS], fill=(0, 0, 0, 60))
    dl.ellipse([cx - a, cy - b, cx + a, cy + b], fill=PAPER)
    layer = layer.rotate(-30, resample=Image.BICUBIC, center=(cx, cy))
    img.alpha_composite(layer)

    # Cincin 4 warna
    ring = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dr = ImageDraw.Draw(ring)
    dr.ellipse([cx - 96 * SS, cy - 96 * SS, cx + 96 * SS, cy + 96 * SS], outline=(0, 0, 0, 0))
    for i, key in enumerate(WHEEL):
        dr.pieslice([cx - 92 * SS, cy - 92 * SS, cx + 92 * SS, cy + 92 * SS],
                    start=-135 + 90 * i, end=-45 + 90 * i, fill=PALETTE[key][0])
    dr.ellipse([cx - 58 * SS, cy - 58 * SS, cx + 58 * SS, cy + 58 * SS], fill=PAPER)
    dr.ellipse([cx - 92 * SS, cy - 92 * SS, cx + 92 * SS, cy + 92 * SS], outline=INK, width=max(3, 7 * SS))
    img.alpha_composite(ring)

    sprite = text_sprite("UNO", 86 * SS, INK, (255, 255, 255, 0), 0)
    paste_center(img, sprite, cx, cy)
    return img


def finalize(img):
    return img.resize((W, H), Image.LANCZOS).convert("RGBA")


# --- Kontak sheet ------------------------------------------------------------

def build_sheet(files):
    cols, pad, label_h = 10, 10, 0
    cw, ch = W // 3, H // 3
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (cw + pad) + pad, rows * (ch + pad + label_h) + pad), (28, 30, 34))
    for i, f in enumerate(files):
        im = Image.open(f).convert("RGBA").resize((cw, ch), Image.LANCZOS)
        bg = Image.new("RGB", (cw, ch), (28, 30, 34))
        bg.paste(im, (0, 0), im)
        x = pad + (i % cols) * (cw + pad)
        y = pad + (i // cols) * (ch + pad + label_h)
        sheet.paste(bg, (x, y))
    return sheet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join("client", "assets", "cards"))
    ap.add_argument("--sheet", default=None, help="simpan kontak sheet ke path ini")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    written = []

    def save(img, name):
        p = os.path.join(args.out, name)
        finalize(img).save(p, "PNG", optimize=True)
        written.append(p)

    for c in COLORS:
        for n in NUMBERS:
            save(build_colored(c, n), f"{c}_{n}.png")
        for a in ACTIONS:
            save(build_colored(c, a), f"{c}_{a}.png")
    save(build_wild(False), "WILD.png")
    save(build_wild(True), "WILD_DRAW_FOUR.png")
    save(build_back(), "BACK.png")

    if args.sheet:
        os.makedirs(os.path.dirname(os.path.abspath(args.sheet)), exist_ok=True)
        build_sheet(written).save(args.sheet, "PNG", optimize=True)

    print(f"{len(written)} kartu ditulis ke {args.out}")
    for p in written:
        print("  ", os.path.basename(p))


if __name__ == "__main__":
    main()
