# -*- coding: utf-8 -*-
"""从启动图母版里抠出 logo 标记，存成 tools/splash-logo-master.png（不进包）。

母版 tools/splash-master.9.png 是 1082x1922 的浅绿->近白渐变图，logo（大圆环 +
内部波形条 + 左侧小弧）是白色的，周围还散落着白色音符。难点是母版底部渐变本身
就是近白（#fdfef6），固定阈值会把整片背景当成白色，所以这里用**局部自适应阈值**：
把图像做一次大半径模糊当作局部背景，只有比局部背景明显更亮的像素才算 logo。

产物只是 tools/ 下的中间件（和 splash-master.9.png 一样不进安装包），
真正进包的是 tools/gen-splash12-icon.py 按密度缩放出来的 static/icon/qt-splash12-*.png。

运行：python tools/extract-splash-logo.py
依赖：Pillow + numpy
"""
import os
from collections import deque

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "splash-master.9.png")
OUT = os.path.join(ROOT, "tools", "splash-logo-master.png")

# logo 所在的 y 区间（下方 y>1120 是母版自身近白的渐变，必须排除）
Y0, Y1 = 500, 1150
XM = 20               # 左右边距：BoxBlur 在图像边缘会产生「比局部背景亮」的伪影
BLUR_RADIUS = 40      # 局部背景的模糊半径
DIFF_THR = 8          # 比局部背景亮多少算 logo
ALPHA_SOFT = 26       # 软 alpha 的映射上界（diff 到该值即为全白）
MIN_AREA = 2000       # 小于此面积的连通域当噪声（散落音符）丢弃


def despeckle(mask: np.ndarray, min_area: int = 60) -> np.ndarray:
    """去掉面积过小的连通块（阈值留下的孤立碎片）。"""
    from collections import deque

    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = np.zeros_like(mask, dtype=bool)
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            q = deque([(sy, sx)])
            seen[sy, sx] = True
            pix = []
            while q:
                y, x = q.popleft()
                pix.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            if len(pix) >= min_area:
                for y, x in pix:
                    out[y, x] = True
    return out


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """填掉笔画内部的孔洞：从画布边界向外扩散，扩散不到的空白像素即孔洞。

    这一步专治「白色笔画里出现无缘无故的黑点」——软 alpha 会把笔画内部的细微
    明暗变成半透明小孔，合成到背景色上就是黑点。
    """
    free = ~mask
    outside = np.zeros_like(mask, dtype=bool)
    outside[0, :] = free[0, :]
    outside[-1, :] = free[-1, :]
    outside[:, 0] = free[:, 0]
    outside[:, -1] = free[:, -1]
    while True:
        grown = outside.copy()
        grown[1:, :] |= outside[:-1, :]
        grown[:-1, :] |= outside[1:, :]
        grown[:, 1:] |= outside[:, :-1]
        grown[:, :-1] |= outside[:, 1:]
        grown &= free
        if grown.sum() == outside.sum():
            break
        outside = grown
    return mask | (free & ~outside)


def clean_alpha(alpha: np.ndarray) -> np.ndarray:
    """把软 alpha 收拾成「干净的白 + 平滑边缘」，不再有内部黑点和碎片。"""
    mask = alpha > 110
    mask = despeckle(mask, MIN_AREA // 20)
    mask = fill_holes(mask)
    img = Image.fromarray((mask * 255).astype(np.uint8))
    k = 2 * 2 + 1
    img = img.filter(ImageFilter.MaxFilter(k)).filter(ImageFilter.MinFilter(k))  # 闭运算接断笔
    img = img.filter(ImageFilter.GaussianBlur(0.9))                              # 重建抗锯齿
    soft = img.point(lambda v: 255 if v > 176 else (0 if v < 80 else round((v - 80) * 255 / 96)))
    return np.asarray(soft).copy()


def main() -> None:
    im = Image.open(SRC).convert("RGB")
    # 裁掉 .9.png 的 1px 黑色标记边：它是白度 0，会被 BoxBlur 平均进局部背景，
    # 让左侧一整列误判成「比背景亮」的 logo 像素
    im = im.crop((1, 1, im.size[0] - 1, im.size[1] - 1))
    a = np.asarray(im).astype(np.int16)
    whiteness = a.min(axis=2).astype(np.float32)          # 白度 = 最小通道

    bg = np.asarray(
        Image.fromarray(whiteness.astype(np.uint8)).filter(ImageFilter.BoxBlur(BLUR_RADIUS))
    ).astype(np.float32)
    diff = whiteness - bg

    h, w = whiteness.shape
    band = np.zeros_like(diff, dtype=bool)
    band[Y0:Y1, XM:w - XM] = True
    binary = (diff > DIFF_THR) & band

    seen = np.zeros_like(binary, dtype=bool)
    comps = []
    for sy in range(Y0, Y1):
        for sx in range(XM, w - XM):
            if not binary[sy, sx] or seen[sy, sx]:
                continue
            q = deque([(sy, sx)])
            seen[sy, sx] = True
            pix = []
            while q:
                y, x = q.popleft()
                pix.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and binary[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            if len(pix) >= MIN_AREA:
                ys = [p[0] for p in pix]
                xs = [p[1] for p in pix]
                comps.append((len(pix), min(xs), min(ys), max(xs), max(ys)))

    comps.sort(reverse=True)
    print("连通域(面积>=%d): %d 个" % (MIN_AREA, len(comps)))
    for area, x0, y0, x1, y1 in comps[:8]:
        print("  area=%6d  bbox=(%d,%d)-(%d,%d)  %dx%d" % (area, x0, y0, x1, y1, x1 - x0 + 1, y1 - y0 + 1))

    area, cx0, cy0, cx1, cy1 = comps[0]
    keep = np.zeros_like(binary, dtype=bool)
    keep[cy0:cy1 + 1, cx0:cx1 + 1] = binary[cy0:cy1 + 1, cx0:cx1 + 1]
    for _ in range(4):                                     # 膨胀，保住抗锯齿边缘
        g = keep.copy()
        g[1:, :] |= keep[:-1, :]
        g[:-1, :] |= keep[1:, :]
        g[:, 1:] |= keep[:, :-1]
        g[:, :-1] |= keep[:, 1:]
        keep = g

    alpha = np.clip(diff / ALPHA_SOFT, 0, 1) * 255
    alpha = alpha.astype(np.uint8)
    alpha[~keep] = 0
    alpha = clean_alpha(alpha)          # 去碎片 + 填内部孔洞 + 重建抗锯齿

    # 用强 alpha 收紧包围盒：模糊伪影的 alpha 只有 ~80，logo 本体是 255
    ys, xs = np.nonzero(alpha > 140)
    pad = 4
    ox0, oy0 = max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad)
    ox1, oy1 = min(w, int(xs.max()) + 1 + pad), min(h, int(ys.max()) + 1 + pad)
    alpha = alpha[oy0:oy1, ox0:ox1]
    print("logo 收紧后 bbox=(%d,%d)-(%d,%d)  %dx%d" % (ox0, oy0, ox1, oy1, alpha.shape[1], alpha.shape[0]))

    rgba = np.zeros((alpha.shape[0], alpha.shape[1], 4), dtype=np.uint8)
    rgba[..., :3] = 255
    rgba[..., 3] = alpha
    Image.fromarray(rgba, "RGBA").save(OUT, optimize=True)
    print("saved %s  %dx%d  %d bytes" % (os.path.basename(OUT), alpha.shape[1], alpha.shape[0], os.path.getsize(OUT)))

    m = Image.fromarray(alpha, "L")
    cols = 72
    rows = max(1, int(cols * m.size[1] / m.size[0] * 0.5))
    small = m.resize((cols, rows), Image.Resampling.LANCZOS)
    px = small.load()
    print("--- extracted logo (ASCII) ---")
    for y in range(rows):
        print("".join("#" if px[x, y] > 110 else "." for x in range(cols)))


if __name__ == "__main__":
    main()
