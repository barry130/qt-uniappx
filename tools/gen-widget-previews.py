# -*- coding: utf-8 -*-
"""Generate Android AppWidget previewImage PNGs for qt-uniappx (API < 31 fallback).

Mimics the real widget look: #201F24 rounded background, accent #E5484D play
glyph, cover placeholder, title/artist text bars. Output: drawable-nodpi so
launchers show them unscaled per density.
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'nativeResources', 'android', 'res', 'drawable-nodpi')
os.makedirs(OUT, exist_ok=True)

BG = (32, 31, 36, 255)        # #201F24 solid (qt_widget_bg base)
FG = (255, 255, 255, 255)     # controls / title
MUTED = (189, 187, 196, 255)  # #BDBBC4 artist
ACCENT = (229, 72, 77, 255)   # #E5484D play glyph


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def note(draw, cx, cy, r, color):
    """Music note placeholder inside the cover block."""
    draw.ellipse([cx - r, cy + r * 0.1, cx + r, cy + r * 2.1], fill=color)
    draw.rectangle([cx + r * 0.55, cy - r * 1.5, cx + r * 0.95, cy + r * 1.1], fill=color)
    draw.polygon([(cx + r * 0.55, cy - r * 1.5), (cx - r * 0.6, cy - r * 1.05), (cx + r * 0.55, cy - r * 0.65)], fill=color)


def glyph_prev(draw, cx, cy, s, color):
    h = s * 0.28
    draw.rectangle([cx - s * 0.5, cy - h / 2, cx - s * 0.5 + h, cy + h / 2], fill=color)
    draw.polygon([(cx - s * 0.5 + h * 1.4, cy), (cx + s * 0.5, cy - s * 0.42), (cx + s * 0.5, cy + s * 0.42)], fill=color)


def glyph_play(draw, cx, cy, s, color, accent=False):
    draw.polygon([(cx - s * 0.28, cy - s * 0.5), (cx - s * 0.28, cy + s * 0.5), (cx + s * 0.55, cy)], fill=ACCENT if accent else color)


def glyph_next(draw, cx, cy, s, color):
    h = s * 0.28
    draw.polygon([(cx - s * 0.5, cy - s * 0.42), (cx - s * 0.5, cy + s * 0.42), (cx + s * 0.5 - h * 1.4, cy)], fill=color)
    draw.rectangle([cx + s * 0.5 - h, cy - h / 2, cx + s * 0.5, cy + h / 2], fill=color)


def bar(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_4x1():
    W, H = 480, 120
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rounded(d, [0, 0, W - 1, H - 1], 28, BG)
    # cover block 84x84 @ (22,18)
    rounded(d, [22, 18, 22 + 84, 18 + 84], 18, (48, 47, 55, 255))
    note(d, 22 + 42, 18 + 42, 12, FG)
    # text bars
    bar(d, [128, 34, 316, 52], 9, FG)
    bar(d, [128, 66, 250, 80], 7, MUTED)
    # controls right side
    cx = W - 168
    glyph_prev(d, cx, H // 2, 34, FG)
    glyph_play(d, cx + 56, H // 2, 40, FG)
    glyph_next(d, cx + 116, H // 2, 34, FG)
    return img


def make_4x2():
    W, H = 480, 240
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rounded(d, [0, 0, W - 1, H - 1], 28, BG)
    # cover block 124x124 @ (28,58)
    rounded(d, [28, 58, 28 + 124, 58 + 124], 22, (48, 47, 55, 255))
    note(d, 28 + 62, 58 + 62, 17, FG)
    # title / artist / lyric bars
    bar(d, [176, 44, 384, 64], 10, FG)
    bar(d, [176, 82, 268, 97], 8, MUTED)
    bar(d, [176, 116, 350, 134], 9, FG)
    # playlist link bar (accent tint)
    bar(d, [176, 154, 252, 172], 9, ACCENT)
    # controls bottom row
    cx = 176
    glyph_prev(d, cx + 17, 212 - 22, 30, FG)
    glyph_play(d, cx + 68, 212 - 22, 34, FG)
    glyph_next(d, cx + 122, 212 - 22, 30, FG)
    return img


def make_1x1():
    W, H = 120, 120
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rounded(d, [0, 0, W - 1, H - 1], 28, BG)
    glyph_play(d, W // 2, H // 2, 56, FG, accent=True)
    return img


make_4x1().save(os.path.join(OUT, 'qt_widget_preview.png'))
make_4x2().save(os.path.join(OUT, 'qt_widget_preview_large.png'))
make_1x1().save(os.path.join(OUT, 'qt_widget_preview_toggle.png'))
print('written to', os.path.abspath(OUT))
