#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成鸿蒙（HarmonyOS / app-harmony）分层图标与启动图标。

产出（写到 static/icon/harmony/，由 manifest.json 的 app-harmony.distribute 引用）：

    background.png   288x288 RGB   分层图标背景层：品牌黑满铺（无圆角、无透明，
                                   系统再按自己的形状遮罩裁切，所以这里不能自带圆角）
    foreground.png   288x288 RGBA  分层图标前景层：白色品牌图形，居中且落在安全区内
    startIcon.png    144x144 RGBA  启动窗口图标（startWindowIcon），与 Android 12
                                   启动 Logo 同一口径：深绿底 + 白色图形

素材来源与 tools/gen-app-logo.py 完全一致，都是 tools/qt-logo-src.png 提取出的两张母版：
brand-tile-master.png（完整 tile）/ brand-glyph-master.png（白色图形本体）。

    python tools/gen-harmony-icon.py            # 生成三张图
    python tools/gen-harmony-icon.py --check    # 只打印尺寸/安全区自检，不写盘

与 Android 的差异（别照抄 Android 的图标）：
- 鸿蒙用 **分层图标**（layered_image.json：background + foreground 两层），不是单张
  圆角方块；背景层必须满铺、不能带圆角透明，否则系统遮罩后会露出缺口。
- 前景层内容要留在中央安全区；官方模板（DevEco Studio 的
  plugins/harmony/lib/templates/ability/common/media）前景内容约占画布 46%，
  这里取 0.62——比官方模板略满，但和 Android 自适应图标的观感一致。
- 官方模板 startIcon.png 是 144x144（模板里那张 1x1 的占位是 HBuilderX 模板自带的，
  必须替换），这里同样用 144x144。
"""

import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS_DIR = os.path.join(ROOT, "tools")
OUT_DIR = os.path.join(ROOT, "static", "icon", "harmony")

BRAND_TILE_MASTER = os.path.join(TOOLS_DIR, "brand-tile-master.png")
BRAND_GLYPH_MASTER = os.path.join(TOOLS_DIR, "brand-glyph-master.png")

# 品牌底色：brand-tile-master.png 实测是纯黑方块 + 白色图形（gen-app-logo.py 里的
# 绿色渐变只用于未采用的候选方向），所以背景层直接取纯黑，跟桌面图标一致。
BRAND_BG = (0, 0, 0)

BG_SIZE = 288        # 分层图标背景 / 前景层边长（官方模板即 288）
START_SIZE = 144     # 启动图标边长（官方模板即 144）
SAFE_FRAC = 0.62     # 图形包围盒占画布的比例（安全区）


def load_master(path: str) -> Image.Image:
    if not os.path.exists(path):
        raise SystemExit(
            "缺少品牌母版 %s，先跑一次 `python tools/gen-app-logo.py` 生成" % path)
    return Image.open(path).convert("RGBA")


def load_glyph() -> Image.Image:
    """白色品牌图形，已裁到实际包围盒。"""
    g = load_master(BRAND_GLYPH_MASTER)
    return g.crop(g.getbbox())


def background_layer(size: int = BG_SIZE) -> Image.Image:
    """背景层：品牌底色满铺，不透明、不带圆角。"""
    return Image.new("RGB", (size, size), BRAND_BG)


def glyph_layer(size: int, frac: float = SAFE_FRAC) -> Image.Image:
    """白色图形居中放在透明画布上，包围盒占画布 frac。"""
    g = load_glyph()
    box = round(size * frac)
    k = min(box / g.size[0], box / g.size[1])
    g = g.resize((max(1, round(g.size[0] * k)), max(1, round(g.size[1] * k))),
                 Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    out.paste(g, ((size - g.size[0]) // 2, (size - g.size[1]) // 2), g)
    return out


def main() -> None:
    check = "--check" in sys.argv
    bg = background_layer(BG_SIZE)
    fg = glyph_layer(BG_SIZE, SAFE_FRAC)
    start = glyph_layer(START_SIZE, SAFE_FRAC)

    # 自检：背景层不能有透明（RGB 模式天然没有），前景/启动图必须真的有内容
    bbox = fg.getbbox()
    sbbox = start.getbbox()
    fill = (bbox[2] - bbox[0]) / BG_SIZE
    sfill = (sbbox[2] - sbbox[0]) / START_SIZE
    print("background %dx%d mode=%s" % (bg.size[0], bg.size[1], bg.mode))
    print("foreground %dx%d bbox=%s fill=%.2f" % (fg.size[0], fg.size[1], bbox, fill))
    print("startIcon  %dx%d bbox=%s fill=%.2f" % (start.size[0], start.size[1], sbbox, sfill))
    if fill <= 0 or sfill <= 0:
        raise SystemExit("图形层是空的，检查 brand-glyph-master.png")

    if check:
        print("(--check) 未写盘")
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    targets = [
        ("background.png", bg),
        ("foreground.png", fg),
        ("startIcon.png", start),
    ]
    for name, img in targets:
        p = os.path.join(OUT_DIR, name)
        img.save(p, optimize=True)
        print("ok %-15s %4dpx -> %s (%d bytes)"
              % (name, img.size[0], os.path.relpath(p, ROOT), os.path.getsize(p)))


if __name__ == "__main__":
    main()
