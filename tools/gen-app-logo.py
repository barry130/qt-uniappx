# -*- coding: utf-8 -*-
"""生成「轻听」App 的 Logo（启动界面居中 Logo + 可选桌面图标）。

设计依据（参考主流音乐 App 图标的共同规律）：
  1. 圆角方块 + 单一品牌色（或同色系渐变）+ 居中纯白图形；
  2. 图形只用三类母题：音符 / 声波 / 耳机；
  3. 笔画粗、留白足，缩到 48px 仍可辨认——不做细线稿、不做多元素堆叠；
  4. 白与底色强对比（启动界面背景是品牌绿 #bfedc7，暗色模式 #15171d，白色都成立）。

定稿（brand）：采用 AI 出的「黑色圆角方块 + 白色 Q+尾巴波浪」设计。源图
tools/qt-logo-src.png（2048x2048；右下角「豆包AI生成」水印在黑 tile 包围盒
之外，按暗色包围盒裁剪即被整体排除）。桌面图标 = tile 整体缩放（保真圆角
比例与留白）；Android 12 启动 Logo = 白色图形本体（系统把内容裁进 192dp
圆内，整个 tile 会被切角，所以只用图形）。母版提取见 build_brand_masters()。
其余几何候选（bars/headphone/note/qwave/ring-wave）保留作备选。

本脚本有两种用法：
  python tools/gen-app-logo.py                    只出候选对比图（splash12-preview.png）
  python tools/gen-app-logo.py --apply brand      写出启动 Logo：
        static/icon/qt-splash12-{xhdpi,xxhdpi,xxxhdpi}.png  （Android 12 居中 Logo）
  加 --launcher 连带写桌面图标（会覆盖 static/icon/{mdpi..xxxhdpi}.png）：
  python tools/gen-app-logo.py --apply brand --launcher
  加 --notif 连带写通知栏小图标（图形从 static/icon 里那份 logo 抽出，
  写 nativeResources/android/res/drawable-*/ic_qt_notification_glyph.png，
  并删掉已弃用的手绘兜底矢量 drawable/ic_qt_notification.xml）：
  python tools/gen-app-logo.py --apply brand --launcher --notif

依赖：Pillow
"""
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "static", "icon")
PREVIEW = os.path.join(os.path.dirname(ROOT), "splash12-preview.png")

SS = 4                       # 超采样倍数
WHITE = (255, 255, 255)
BG_LIGHT = (191, 237, 199)   # manifest 的 background（品牌绿）
BG_DARK = (21, 23, 29)       # manifest 的 background@night
TILE_TOP = (226, 250, 235)   # 桌面图标底牌渐变（取自现有应用图标）
TILE_BOT = (152, 215, 190)
CIRCLE_FRAC = 192 / 288      # Android 12 Logo：内容须落在直径 192dp 的圆内

# 桌面图标各密度边长（与现有 static/icon/*.png 一致）
LAUNCHER = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
SPLASH12 = {"xhdpi": 576, "xxhdpi": 864, "xxxhdpi": 1152}
# Android 通知栏小图标各密度边长（状态栏 / 媒体通知左侧）
NOTIF = {"mdpi": 24, "hdpi": 36, "xhdpi": 48, "xxhdpi": 72, "xxxhdpi": 96}
# 通知小图标的图形占比：留一圈安全边距，避免顶满 24dp 显得发闷、贴边
NOTIF_FILL = 0.86


# ---------------------------------------------------------------- 品牌母版（AI 定稿 Logo）

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
BRAND_SRC = os.path.join(TOOLS_DIR, "qt-logo-src.png")           # AI 定稿源图
BRAND_TILE_MASTER = os.path.join(TOOLS_DIR, "brand-tile-master.png")   # 完整图标 tile
BRAND_GLYPH_MASTER = os.path.join(TOOLS_DIR, "brand-glyph-master.png")  # 白色图形本体

# 通知栏小图标的源图：以「仓库里现成的那套 logo 文件」为准，即 static/icon/{密度}.png
# （桌面图标，也就是用户认的那份文件），取其中最大的一档。而不是另存的 tools/ 母版——
# 这样图标一定和用户看到的 logo 一致。
LOGO_TILE_DENSITIES = ("xxxhdpi", "xxhdpi", "xhdpi", "hdpi", "mdpi")
NOTIF_DIR = os.path.join(ROOT, "nativeResources", "android", "res")
NOTIF_PNG_NAME = "ic_qt_notification_glyph.png"
# 早期放进来的手绘兜底矢量：正式位图生成后就没用了，脚本顺手删掉，避免两版图形并存
NOTIF_STALE_VECTOR = os.path.join(NOTIF_DIR, "drawable", "ic_qt_notification.xml")


def build_brand_masters() -> None:
    """从 AI 定稿源图提取两张母版（只在 tools/ 下，不进安装包）。

    - brand-tile-master.png：完整图标 = 黑色圆角方块 + 白色「Q+尾巴波浪」图形。
      圆角半径从源图暗色蒙版逐行扫描拟合，alpha 用 SS 超采样重画（比信任源图
      JPEG 级噪点更干净）；透明区 RGB 置黑，避免缩放时白边渗色。
    - brand-glyph-master.png：白色图形本体（RGB=白，alpha=源图灰度），供
      splash12（背景色 + 居中图形）使用。

    水印：源图右下角水印在黑 tile 包围盒之外（tile 内灰色像素只有 9368 个
    抗锯齿级噪点、无文字形状），按暗色包围盒裁剪即被整体排除。
    """
    im = Image.open(BRAND_SRC).convert("RGB")
    a = np.asarray(im)
    dark = a.sum(axis=2) < 90
    rows = np.nonzero(dark.any(axis=1))[0]
    cols = np.nonzero(dark.any(axis=0))[0]
    crop = im.crop((int(cols.min()), int(rows.min()),
                    int(cols.max()) + 1, int(rows.max()) + 1))
    W, H = crop.size

    # 圆角半径：暗蒙版逐行最左暗列，拟合 r - sqrt(r^2 - (r-k)^2)
    dm = np.asarray(crop).sum(axis=2) < 90
    ks = np.arange(1, min(H // 2, 640))
    left = np.array([int(np.nonzero(dm[k])[0][0]) for k in ks])
    radius, best = 330, None
    for r in range(180, 700):
        m = np.where(ks < r,
                     r - np.sqrt(np.maximum(r * r - (r - ks) ** 2, 0.0)),
                     0.0)
        e = float(((left - m) ** 2).mean())
        if best is None or e < best:
            radius, best = r, e

    # 圆角 alpha：SS 超采样重画再 BOX 缩回，边缘平滑
    mask = Image.new("L", (W * SS, H * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, W * SS - 1, H * SS - 1), radius=round(radius * SS), fill=255)
    alpha = mask.resize((W, H), Image.Resampling.BOX)
    al = np.asarray(alpha)

    # tile 母版
    arr = np.asarray(crop.convert("RGBA")).copy()
    arr[..., :3][al == 0] = 0
    tile = Image.fromarray(arr, "RGBA")
    tile.putalpha(alpha)
    tile.save(BRAND_TILE_MASTER, optimize=True)

    # glyph 母版：圆角蒙版收缩 8px——源图 tile 边缘有 1~2px 抗锯齿过渡
    # （灰度 8~30），不收缩会在图形外围留一圈暗框（真图形离边缘 >200px，安全）。
    # 腐蚀必须把数组边框一并压掉：贴边的整行/整列四邻域全是 True，普通写法腐蚀不掉。
    e = al > 128
    for _ in range(8):
        e2 = np.zeros_like(e)
        e2[1:-1, 1:-1] = (e[1:-1, 1:-1] & e[:-2, 1:-1] & e[2:, 1:-1]
                          & e[1:-1, :-2] & e[1:-1, 2:])
        e = e2
    g = np.asarray(crop.convert("L"))
    gm = np.zeros((H, W, 4), dtype=np.uint8)
    gm[..., :3] = 255
    gm[..., 3] = np.where(e, g, 0)
    Image.fromarray(gm, "RGBA").save(BRAND_GLYPH_MASTER, optimize=True)

    gy, gx = np.nonzero(gm[..., 3] > 8)
    print("ok brand masters: tile %dx%d radius=%d (%d bytes)"
          % (W, H, radius, os.path.getsize(BRAND_TILE_MASTER)))
    print("   glyph bbox=(%d,%d)-(%d,%d) (%d bytes)"
          % (int(gx.min()), int(gy.min()), int(gx.max()), int(gy.max()),
             os.path.getsize(BRAND_GLYPH_MASTER)))


def _brand_fresh(path: str) -> bool:
    return os.path.exists(path) and \
        os.path.getmtime(path) >= os.path.getmtime(BRAND_SRC)


def load_brand_tile() -> Image.Image:
    if not _brand_fresh(BRAND_TILE_MASTER):
        build_brand_masters()
    return Image.open(BRAND_TILE_MASTER).convert("RGBA")


def load_brand_glyph() -> Image.Image:
    if not _brand_fresh(BRAND_GLYPH_MASTER):
        build_brand_masters()
    return Image.open(BRAND_GLYPH_MASTER).convert("RGBA")


# ---------------------------------------------------------------- 通知栏小图标

def load_logo_tile() -> Image.Image:
    """取 static/icon 里最大的一档桌面图标当 logo 源图。"""
    for density in LOGO_TILE_DENSITIES:
        p = os.path.join(ICON_DIR, "%s.png" % density)
        if os.path.exists(p):
            return Image.open(p).convert("RGBA")
    raise SystemExit("找不到 static/icon/{xxxhdpi..mdpi}.png，无法生成通知栏小图标")


def logo_glyph() -> Image.Image:
    """从 logo 文件里抽出图形本体（黑底 tile → 透明，亮部 → alpha），裁到内容包围盒。

    和 build_brand_masters() 里 glyph 母版同一套做法：按 tile 自身 alpha 裁到圆角方块，
    再把蒙版向内腐蚀几像素（源图 tile 边缘有 1~2px 抗锯齿过渡，不腐蚀会在图形外圈
    留一圈暗框），最后用灰度当 alpha。腐蚀步数按边长缩放（母版固定 8，这里随密度走）。
    """
    t = load_logo_tile()
    box = t.getchannel("A").getbbox()
    if box is not None:
        t = t.crop(box)
    e = np.asarray(t.getchannel("A")) > 128
    for _ in range(max(1, round(min(t.size) * 0.04))):
        e2 = np.zeros_like(e)
        e2[1:-1, 1:-1] = (e[1:-1, 1:-1] & e[:-2, 1:-1] & e[2:, 1:-1]
                          & e[1:-1, :-2] & e[1:-1, 2:])
        e = e2
    g = np.asarray(t.convert("L"))
    out = np.zeros((t.size[1], t.size[0], 4), dtype=np.uint8)
    out[..., :3] = 255
    out[..., 3] = np.where(e, g, 0)
    img = Image.fromarray(out, "RGBA")
    bbox = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    return img.crop(bbox) if bbox is not None else img


# ---------------------------------------------------------------- 图形（0~1 归一化坐标）

def _cap(d, p, r):
    """圆头端点。"""
    d.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=255)


def draw_bars(d, s):
    """声波条：5 根圆头竖条，高低起伏——最简洁的「音频」母题。"""
    hs = [0.34, 0.62, 1.00, 0.70, 0.42]
    bw, gap = 0.115, 0.075
    total = len(hs) * bw + (len(hs) - 1) * gap
    x = (1 - total) / 2
    for h in hs:
        d.rounded_rectangle(
            (x * s, (0.5 - h / 2) * s, (x + bw) * s, (0.5 + h / 2) * s),
            radius=bw / 2 * s, fill=255,
        )
        x += bw + gap


def draw_headphone(d, s):
    """耳机：听歌最直接的语义，也是「轻听」的字面表达。"""
    cx, cy, R, w = 0.5, 0.66, 0.335, 0.11
    d.arc((cx * s - R * s, cy * s - R * s, cx * s + R * s, cy * s + R * s), 180, 360,
          fill=255, width=round(w * s))
    for ang in (180, 360):
        _cap(d, ((cx + R * math.cos(math.radians(ang))) * s,
                 (cy + R * math.sin(math.radians(ang))) * s), w / 2 * s)
    for sx in (-1, 1):
        ex = cx + sx * R
        d.rounded_rectangle((ex * s - 0.105 * s, (cy - 0.055) * s,
                             ex * s + 0.105 * s, (cy + 0.235) * s),
                            radius=0.10 * s, fill=255)


def draw_note(d, s):
    """音符 + 旗帜：音符头（实心圆）+ 符干（实心矩形）+ 旗帜（重叠圆曲线）。
    三个元素都是实心填充块，重叠后视觉上一个整体——对比 QQ音乐/网易云/酷狗
    的图标风格：粗笔画实心图形，不是细线稿。

    旗帜用 7 个重叠实心圆构建平滑曲线，从符干顶部延伸到右上方。
    """
    u = s / 1024.0

    # 音符头（实心圆）
    hx, hy, hr = 474 * u, 646 * u, 130 * u
    d.ellipse((hx - hr, hy - hr, hx + hr, hy + hr), fill=255)

    # 符干（实心矩形）
    sw = 120 * u
    d.rectangle((hx - sw / 2, 516 * u, hx + sw / 2, 350 * u), fill=255)

    # 旗帜：7 个重叠实心圆，构建平滑曲线
    r = sw / 2  # 60*u
    flag_points = [
        (474, 350),   # 顶部（与符干重叠）
        (495, 338),
        (520, 325),
        (548, 313),
        (575, 302),
        (600, 290),
        (620, 280),   # 末端
    ]
    for x, y in flag_points:
        d.ellipse((x * u - r, y * u - r, x * u + r, y * u + r), fill=255)


def draw_qwave(d, s):
    """Q + 波浪：Q 代表"轻"，波浪代表"听"。
    Q 的尾巴直接延伸成波浪——一个连通的实心曲线，不是 AI 设计里分开的两个元素。
    对比 AI 生成图：Q 和 WiFi 波浪是独立的两个形状；这里让 Q 的尾巴流进波浪，
    视觉上是一个整体，粗笔画实心填充，符合"不做多元素堆叠"的原则。
    """
    u = s / 1024.0

    # Q 主体（实心圆）
    qcx, qcy, qr = 360 * u, 560 * u, 130 * u
    d.ellipse((qcx - qr, qcy - qr, qcx + qr, qcy + qr), fill=255)

    # Q 尾巴 → 波浪：12 个重叠实心圆，构建从 Q 底部到右上方的平滑曲线
    r = 55 * u
    points = [
        (455, 650),   # Q 底部（与 Q 体重叠）
        (495, 630),
        (535, 595),
        (570, 555),
        (600, 515),
        (625, 475),   # 尾巴弯折点
        (650, 440),
        (675, 410),
        (695, 385),
        (710, 365),
        (720, 350),
        (725, 340),   # 波浪末端
    ]
    for x, y in points:
        d.ellipse((x * u - r, y * u - r, x * u + r, y * u + r), fill=255)

    # 声波终点（小圆点）
    dotx, doty, dotr = 700 * u, 555 * u, 40 * u
    d.ellipse((dotx - dotr, doty - dotr, dotx + dotr, doty + dotr), fill=255)


def draw_ring_wave(d, s):
    """圆环 + 声波：你原标记的简化版，只留「粗圆环 + 3 根声波条」。"""
    R, stroke = 0.40, 0.085
    d.ellipse(((0.5 - R) * s, (0.5 - R) * s, (0.5 + R) * s, (0.5 + R) * s),
              outline=255, width=round(stroke * s))
    hs = [0.24, 0.42, 0.30]
    bw = 0.075
    for i, h in enumerate(hs):
        x = 0.5 + (i - 1) * 0.13
        d.rounded_rectangle(((x - bw / 2) * s, (0.5 - h / 2) * s,
                             (x + bw / 2) * s, (0.5 + h / 2) * s),
                            radius=bw / 2 * s, fill=255)


DESIGNS = {
    "brand": ("F 品牌定稿", "F brand", None),   # 位图路径，无绘制函数
    "bars": ("A 声波条", "A bars", draw_bars),
    "headphone": ("B 耳机", "B headphone", draw_headphone),
    "note": ("C 双音符", "C note", draw_note),
    "qwave": ("E Q+波浪", "E q+wave", draw_qwave),
    "ring-wave": ("D 圆环+声波", "D ring+wave", draw_ring_wave),
}


def _font(size: int = 15):
    """中文字体：拿不到就退回默认字体（此时标签用英文，避免编码报错）。"""
    for p in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf",
              "/System/Library/Fonts/PingFang.ttc"):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size), True
            except Exception:
                pass
    return ImageFont.load_default(), False


FONT, HAS_CJK = _font()


def label(name: str) -> str:
    """有中文字体就用中文标签，否则退回英文（默认字体编码不了中文）。"""
    return DESIGNS[name][0] if HAS_CJK else DESIGNS[name][1]


# ---------------------------------------------------------------- 渲染

def glyph(name: str, size: int, fill_frac: float = 1.0) -> Image.Image:
    """白色图形 + 透明底；fill_frac 控制图形在画布中的占比。"""
    if name == "brand":      # 位图路径：品牌 glyph 母版等比缩放（源 1875px，足够高清）
        g0 = load_brand_glyph()
        g = g0.crop(g0.getbbox())
        k = min(size / g.size[0], size / g.size[1])
        g = g.resize((max(1, round(g.size[0] * k)), max(1, round(g.size[1] * k))),
                     Image.Resampling.LANCZOS)
        base = Image.new("RGBA", (size, size), WHITE + (0,))
        base.paste(g, ((size - g.size[0]) // 2, (size - g.size[1]) // 2), g)
        if fill_frac == 1.0:
            return base
        inner = round(size * fill_frac)
        out = Image.new("RGBA", (size, size), WHITE + (0,))
        out.paste(base.resize((inner, inner), Image.Resampling.LANCZOS),
                  ((size - inner) // 2, (size - inner) // 2))
        return out
    s = size * SS
    mask = Image.new("L", (s, s), 0)
    DESIGNS[name][2](ImageDraw.Draw(mask), s)
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    if fill_frac != 1.0:
        inner = round(size * fill_frac)
        m2 = Image.new("L", (size, size), 0)
        m2.paste(mask.resize((inner, inner), Image.Resampling.LANCZOS),
                 ((size - inner) // 2, (size - inner) // 2))
        mask = m2
    out = Image.new("RGBA", (size, size), WHITE + (0,))
    out.putalpha(mask)
    out.paste(Image.new("RGBA", (size, size), WHITE + (255,)), (0, 0), mask)
    return out


def fit_circle(g: Image.Image, canvas: int, margin: float = 0.94) -> Image.Image:
    """把图形缩到 canvas 画布中央，保证图形整体落在 192dp 安全圆内。

    按**蒙版实际像素到圆心的最大距离**缩放，而不是按包围盒对角线——像声波条、
    音符这类图形，包围盒的四个角本来就是空的，按对角线算会把图形白白压小一圈。
    """
    bb = g.getbbox()
    m = g.crop(bb)
    a = np.asarray(m.getchannel("A"))
    ys, xs = np.nonzero(a > 8)
    cx, cy = (m.size[0] - 1) / 2, (m.size[1] - 1) / 2
    maxd = float(np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2).max())
    k = (canvas * CIRCLE_FRAC / 2 * margin) / maxd
    m = m.resize((max(1, round(m.size[0] * k)), max(1, round(m.size[1] * k))),
                 Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (canvas, canvas), WHITE + (0,))
    out.paste(m, ((canvas - m.size[0]) // 2, (canvas - m.size[1]) // 2), m)
    return out


def tile(size: int) -> Image.Image:
    """品牌绿渐变圆角方块（桌面图标底牌）。"""
    grad = Image.new("RGBA", (size, size))
    px = grad.load()
    for y in range(size):
        f = y / max(1, size - 1)
        c = tuple(round(TILE_TOP[i] + (TILE_BOT[i] - TILE_TOP[i]) * f) for i in range(3))
        for x in range(size):
            px[x, y] = c + (255,)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1),
                                          radius=round(size * 0.22), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def launcher_icon(name: str, size: int) -> Image.Image:
    """桌面图标：brand = AI 定稿 tile 整体缩放（保真圆角比例与留白）；
    其余方向 = 绿底牌 + 白色图形（图形占底牌约 58%）。"""
    if name == "brand":
        return load_brand_tile().resize((size, size), Image.Resampling.LANCZOS)
    t = tile(size)
    g = glyph(name, round(size * 0.58))
    t.paste(g, ((size - g.size[0]) // 2, (size - g.size[1]) // 2), g)
    return t


# ---------------------------------------------------------------- 对比图

CELL, PAD, LABEL_H = 380, 16, 34


def cell_splash(name: str, bg) -> Image.Image:
    c = Image.new("RGB", (CELL, CELL + LABEL_H), bg)
    d = ImageDraw.Draw(c)
    cx = cy = CELL // 2
    r = round(CELL * CIRCLE_FRAC / 2)
    for a in range(0, 360, 6):      # 192dp 裁切边界
        d.arc((cx - r, cy - r, cx + r, cy + r), a, a + 3,
              fill=(255, 255, 255) if sum(bg) < 300 else (120, 150, 130), width=1)
    g = fit_circle(glyph(name, 1024), CELL)
    c.paste(g, (cx - g.size[0] // 2, cy - g.size[1] // 2), g)
    d.text((PAD, CELL + 8), label(name) + " / splash", fill=(30, 40, 35), font=FONT)
    return c


def cell_launcher(name: str) -> Image.Image:
    c = Image.new("RGB", (CELL, CELL + LABEL_H), (245, 246, 248))
    ts = round(CELL * 0.62)
    ic = launcher_icon(name, ts)
    c.paste(ic, ((CELL - ts) // 2, (CELL - ts) // 2), ic)
    ImageDraw.Draw(c).text((PAD, CELL + 8), label(name) + " / launcher",
                           fill=(30, 40, 35), font=FONT)
    return c


def notif_icon(size: int) -> Image.Image:
    """Android 通知栏小图标：纯 alpha 通道（白色图形 + 透明底，系统按通知主题色上色）。

    图形来自 static/icon 里那份 logo（见 logo_glyph()），按画布 NOTIF_FILL 缩放——
    状态栏按 24dp 排版，图形顶满整格会显得发闷、贴边，所以要留一圈安全边距。"""
    g = logo_glyph()
    box = size * NOTIF_FILL
    k = min(box / g.size[0], box / g.size[1])
    g = g.resize((max(1, round(g.size[0] * k)), max(1, round(g.size[1] * k))),
                 Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(g, ((size - g.size[0]) // 2, (size - g.size[1]) // 2), g)
    return out


def main() -> None:
    names = list(DESIGNS)
    if "--apply" in sys.argv:
        name = sys.argv[sys.argv.index("--apply") + 1]
        if name not in DESIGNS:
            raise SystemExit("未知方向: %s（可选 %s）" % (name, ", ".join(DESIGNS)))
        for density, size in SPLASH12.items():
            p = os.path.join(ICON_DIR, "qt-splash12-%s.png" % density)
            fit_circle(glyph(name, 1024), size).save(p, optimize=True)
            print("ok splash12 %-8s %4dpx -> %s (%d bytes)" % (density, size, os.path.basename(p), os.path.getsize(p)))
        if "--launcher" in sys.argv:
            for density, size in LAUNCHER.items():
                p = os.path.join(ICON_DIR, "%s.png" % density)
                launcher_icon(name, size).save(p, optimize=True)
                print("ok launcher %-8s %4dpx -> %s (%d bytes)" % (density, size, os.path.basename(p), os.path.getsize(p)))
        else:
            print("（未加 --launcher，不动桌面图标 static/icon/{mdpi..xxxhdpi}.png）")
        if "--notif" in sys.argv:
            for density, size in NOTIF.items():
                dd = os.path.join(NOTIF_DIR, "drawable-%s" % density)
                os.makedirs(dd, exist_ok=True)
                p = os.path.join(dd, NOTIF_PNG_NAME)
                notif_icon(size).save(p, optimize=True)
                print("ok notif %-8s %4dpx -> %s (%d bytes)" % (density, size, p, os.path.getsize(p)))
            # 手绘兜底矢量到此退休：正式位图已就位，留着会让人误以为有两版图形
            if os.path.exists(NOTIF_STALE_VECTOR):
                os.remove(NOTIF_STALE_VECTOR)
                print("rm 过期兜底矢量 %s" % NOTIF_STALE_VECTOR)
        else:
            print("（未加 --notif，不生成通知栏小图标 %s/drawable-*/%s）" % (NOTIF_DIR, NOTIF_PNG_NAME))
        print("选定方向:", name)
        return

    w = CELL * len(names) + PAD * (len(names) + 1)
    h = (CELL + LABEL_H) * 2 + PAD * 3
    sheet = Image.new("RGB", (w, h), (245, 246, 248))
    for i, n in enumerate(names):
        x = PAD + i * (CELL + PAD)
        sheet.paste(cell_splash(n, BG_LIGHT), (x, PAD))
        sheet.paste(cell_launcher(n), (x, PAD * 2 + CELL + LABEL_H))
    sheet.save(PREVIEW)
    print("saved", PREVIEW, sheet.size)


if __name__ == "__main__":
    main()
