# -*- coding: utf-8 -*-
"""生成 Android 12 启动界面中部 Logo 图标（static/icon/qt-splash12-*.png）。

背景：Android 12（API 31）起系统强制使用 SplashScreen，它**不是静态图片**，
只能配置「背景色 + 居中 Logo + 底部品牌图」三样；不配置就在官方 Rom 上显示
白底 + 应用图标（见 uni-app x 文档 collocation/manifest-android.md 的
「Google SplashScreen 配置」，以及其中一句：
「如果不配置SplashScreen……默认会显示白色背景+居中的应用图标，不会显示配置的
splash启动图」）。所以全屏渐变启动图在 Android 12+ 上无法生效，只能用这里
生成的 Logo + manifest 里的背景色去贴合启动图的观感。

规格（文档 161-170 行「无图标背景的Logo图标」）：
  Logo 图 288x288 dp，内容必须在直径 192 dp 的圆内，圆外会被裁掉
  （文档 Tips 又说明「部分设备会被裁剪成圆形，部分设备不会裁剪」，
   所以这里按「全部内容都落进圆内」来做，两种设备都不会出问题）。
  xhdpi 576 / xxhdpi 864 / xxxhdpi 1152 px，圆直径 384 / 576 / 768 px。

图形来源：tools/splash-logo-master.png —— 由 tools/extract-splash-logo.py 从
启动图母版里抠出的白色标记（与应用桌面图标上的标记同源），白色 + 透明底，
配 manifest 的绿色背景。

运行：先 python tools/extract-splash-logo.py，再 python tools/gen-splash12-icon.py
依赖：Pillow
"""
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "splash-logo-master.png")
OUT_DIR = os.path.join(ROOT, "static", "icon")

# 无图标背景的 Logo：图 288dp、内容在 192dp 圆内
DENSITIES = {
    "xhdpi": 576,
    "xxhdpi": 864,
    "xxxhdpi": 1152,
}
CIRCLE_FRAC = 192 / 288   # 圆直径占画布比例
FIT = 0.94                # 内容包围盒的对角线占圆直径的比例（留一点余量）
WHITE = (255, 255, 255)


def render(logo: Image.Image, size: int) -> Image.Image:
    """把 logo 缩放到 size x size 画布中央，保证整体落在 192dp 圆内。"""
    bb = logo.getbbox()
    if bb is None:
        raise ValueError("logo 母版是空图")
    mark = logo.crop(bb)
    mw, mh = mark.size
    diag = (mw ** 2 + mh ** 2) ** 0.5
    circle = size * CIRCLE_FRAC
    scale = (circle * FIT) / diag
    tw, th = max(1, round(mw * scale)), max(1, round(mh * scale))
    mark = mark.resize((tw, th), Image.Resampling.LANCZOS)

    out = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    out.paste(mark, ((size - tw) // 2, (size - th) // 2), mark)
    return out


def verify(im: Image.Image) -> None:
    """自检：不透明像素必须全部落在 192dp 圆内，且四角透明、中心有内容。"""
    size = im.size[0]
    px = im.getchannel("A").load()
    cx = cy = size / 2
    r = size * CIRCLE_FRAC / 2
    for y in range(size):
        for x in range(size):
            if px[x, y] > 8 and ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 > r:
                raise AssertionError(f"内容超出 192dp 圆: ({x},{y})")
    assert px[0, 0] == 0 and px[size - 1, size - 1] == 0, "四角应透明"
    assert max(px[x, size // 2] for x in range(size)) > 200, "水平中线应有实心内容"


def main() -> None:
    logo = Image.open(SRC).convert("RGBA")
    os.makedirs(OUT_DIR, exist_ok=True)
    for density, size in DENSITIES.items():
        im = render(logo, size)
        verify(im)
        path = os.path.join(OUT_DIR, f"qt-splash12-{density}.png")
        im.save(path, optimize=True)
        bb = im.getbbox()
        print(
            "ok %-8s %4dx%-4d -> %-26s %6d bytes  内容 %dx%d"
            % (density, size, size, os.path.basename(path), os.path.getsize(path), bb[2] - bb[0], bb[3] - bb[1])
        )


if __name__ == "__main__":
    main()
