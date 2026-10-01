# -*- coding: utf-8 -*-
"""由母版生成启动图 .9.png（PNG8 调色板编码，体积约为原 RGBA8 的 1/3）。

背景：启动图是全屏柔和渐变 + logo。母版 tools/splash-master.9.png 是无损 RGBA8，
1080x1920 一张就要 743KB；而启动图在安装包里要出现两份（www/static 里一份、
原生 res 一份），按密度分三桶时合计 5.5MB——占整包 13%。
柔和渐变用 PNG8（254 色调色板 + 1 个标记黑 + 1 个透明）重编码后只有 262KB，
肉眼无差别；母版留在 tools/ 下不进包，static/icon 里只放编码后的成品。

只生成 xxhdpi（1080x1920）一桶：这是官方文档推荐的最小配置（「可以只配置1张或
多张图片适配更多分辨率，减少apk的体积（推荐至少配置1080P高分屏启动图片）」）。
低密度屏由系统缩小（清晰），高密度屏（1440p / xxxhdpi）放大 1.33 倍，柔和渐变上
看不出差别。启动图在安装包里存两份（www/static 一份 + 原生 res 一份），每多一桶
就多这两份的体积，所以只留一桶是收包的主要手段。

启动图只在「会显示启动图」的设备上生效：Android 12 以下，以及 Android 12+ 中关闭了
系统 SplashScreen 的 Rom（文档说国内 Rom 大多关闭）。Android 12+ 且支持 SplashScreen
的设备走 manifest 的 splashScreens.android12（背景色 + 居中 Logo），与这里无关。

要恢复 xhdpi / xxxhdpi：把尺寸加回 DENSITIES，跑一次本脚本，再把生成的
static/icon/qt-start-<密度>.9.png 加回 manifest.json 的 splashScreens.default
（每加一桶约多 2.2MB）。

做法：裁掉 1px 标记边 -> LANCZOS 缩放到目标内容尺寸 -> PNG8 量化 ->
按原始比例重画四条标记边：
- 上/左边 = 可拉伸区（母版：x 231~361、y 1419~1464）
- 右/下边 = 内容区，拉满（uni-app x 文档要求，避免部分设备出现灰色区域）
- 四个角保持透明（aapt2 对 9patch 的要求）

运行：python tools/gen-start-9png.py
依赖：Pillow
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "splash-master.9.png")
OUT_DIR = os.path.join(ROOT, "static", "icon")

# 母版内容区 1080x1920；标记位置（内容坐标，含头不含尾）
SRC_W, SRC_H = 1080, 1920
STRETCH_X = (230, 361)   # 上边的拉伸区（内容列）
STRETCH_Y = (1418, 1464) # 左边的拉伸区（内容行）

# 目标密度 -> 内容尺寸（HBuilderX manifest 提示的建议分辨率）
# 文件名规则：xxhdpi 用 manifest 里既有的 qt-start.9.png，其余加密度后缀
DENSITIES = {
    "xxhdpi": (1080, 1920),
}
FILE_OF = {"xxhdpi": "qt-start.9.png"}

CONTENT_COLORS = 254     # 留给标记色和透明色各一个索引
MARKER_INDEX = 254       # 调色板 254 号：纯黑，9-patch 标记
TRANSPARENT_INDEX = 255  # 调色板 255 号：透明，四角与标记边的空白


def palette_image(content: Image.Image, wc: int, hc: int) -> Image.Image:
    """把内容量化成 PNG8 并补回 1px 标记边（P 模式 + tRNS 透明索引）。"""
    scaled = content.resize((wc, hc), Image.Resampling.LANCZOS)
    quantized = scaled.convert("RGB").quantize(colors=CONTENT_COLORS, dither=Image.Dither.NONE)

    palette = quantized.getpalette()[: CONTENT_COLORS * 3]
    out = Image.new("P", (wc + 2, hc + 2), TRANSPARENT_INDEX)
    out.putpalette(palette + [0, 0, 0] + [0, 0, 0])
    out.info["transparency"] = TRANSPARENT_INDEX
    out.paste(quantized, (1, 1))

    px = out.load()
    mx0 = round(STRETCH_X[0] / SRC_W * wc) + 1
    mx1 = round(STRETCH_X[1] / SRC_W * wc) + 1
    my0 = round(STRETCH_Y[0] / SRC_H * hc) + 1
    my1 = round(STRETCH_Y[1] / SRC_H * hc) + 1

    for x in range(mx0, mx1 + 1):
        px[x, 0] = MARKER_INDEX          # 上边：横向拉伸区
    for y in range(my0, my1 + 1):
        px[0, y] = MARKER_INDEX          # 左边：纵向拉伸区
    for y in range(1, hc + 1):
        px[wc + 1, y] = MARKER_INDEX     # 右边：内容区（拉满）
    for x in range(1, wc + 1):
        px[x, hc + 1] = MARKER_INDEX     # 下边：内容区（拉满）
    return out


def verify(im: Image.Image, wc: int, hc: int) -> None:
    """自检：四角必须透明，四条边只允许标记黑/透明，内容区不允许透明像素。"""
    px = im.load()
    w, h = wc + 2, hc + 2
    for cx, cy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        assert px[cx, cy] == TRANSPARENT_INDEX, f"角点({cx},{cy})不透明"
    for y in range(h):
        for x in (0, w - 1):
            p = px[x, y]
            assert p in (MARKER_INDEX, TRANSPARENT_INDEX), f"标记边({x},{y})非法 idx={p}"
    for x in range(w):
        for y in (0, h - 1):
            p = px[x, y]
            assert p in (MARKER_INDEX, TRANSPARENT_INDEX), f"标记边({x},{y})非法 idx={p}"
    for y in range(1, h - 1, 17):
        for x in range(1, w - 1, 17):
            assert px[x, y] != TRANSPARENT_INDEX, f"内容区({x},{y})含透明像素"


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    assert src.size == (SRC_W + 2, SRC_H + 2), f"母版尺寸变了: {src.size}"
    content = src.crop((1, 1, SRC_W + 1, SRC_H + 1))
    for density, (wc, hc) in DENSITIES.items():
        out = palette_image(content, wc, hc)
        verify(out, wc, hc)
        path = os.path.join(OUT_DIR, FILE_OF.get(density, f"qt-start-{density}.9.png"))
        out.save(path, optimize=True)
        print(f"ok {density}: {wc}x{hc} -> {os.path.basename(path)} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
