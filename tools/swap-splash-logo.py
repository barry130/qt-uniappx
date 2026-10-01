# -*- coding: utf-8 -*-
"""把启动图母版 tools/splash-master.9.png 里的旧 logo 换成品牌定稿 tile。

旧母版构图（见 extract-splash-logo.py 的分析）：y 500~1150 是白色旧 logo
（大圆环 + 波形条 + 散落音符），y 1470 以下是「轻听」标题与标语文字——
文字不动，只换 logo。

做法：
1. 局部自适应阈值找旧 logo（比 BoxBlur(40) 局部背景亮 >8 的白像素，与
   extract-splash-logo.py 同一套参数），膨胀 6px 得擦除区；
2. 扩散修补：迭代大核模糊，非擦除像素固定，擦除区被周围渐变平滑填满
   （背景是柔和渐变，修补后无痕）；
3. 贴上 brand-tile-master.png（gen-app-logo.py --apply brand 生成）：
   边长 440（1080 宽的 ~41%；黑 tile 视觉重量大，面积约为旧白色 logo 的一半），
   水平以旧 logo 核心中心对齐，垂直限制在旧 logo 带内、避开下方标题；
4. 旧母版先备份为 splash-master-old.9.png（该资产不在 git 里，覆盖前留底）。

之后跑 python tools/gen-start-9png.py 重出 static/icon/qt-start.9.png。
依赖：Pillow + numpy
"""
import os

import numpy as np
from PIL import Image

TOOLS = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(TOOLS, "splash-master.9.png")
BACKUP = os.path.join(TOOLS, "splash-master-old.9.png")
TILE = os.path.join(TOOLS, "brand-tile-master.png")

Y0, Y1 = 430, 1210      # 旧 logo 所在 y 带（上下留缓冲；y>1470 是标题文字，不动）
BLUR = 40               # 局部背景半径（与 extract-splash-logo.py 一致）
DIFF_THR = 8            # 比局部背景亮多少算旧 logo
CORE_THR = 25           # 强核心阈值（只用来定位中心）
DILATE = 6              # 擦除区再膨胀（盖住旧 logo 的软边缘）
INPAINT_ITERS = 60      # 扩散修补迭代次数
INPAINT_K = 31          # 修补模糊核
TILE_SIDE = 440         # 新 tile 边长


def box_blur(a: np.ndarray, k: int) -> np.ndarray:
    """积分图 box blur；窗口越出边缘时按实际宽度归一（a: HxW float）。"""
    ii = np.pad(a, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    h, w = a.shape
    ys0, ys1 = np.maximum(0, np.arange(h) - k // 2), np.minimum(h, np.arange(h) + k // 2 + 1)
    xs0, xs1 = np.maximum(0, np.arange(w) - k // 2), np.minimum(w, np.arange(w) + k // 2 + 1)
    return (ii[ys1][:, xs1] - ii[ys0][:, xs1] - ii[ys1][:, xs0] + ii[ys0][:, xs0]) \
        / ((ys1 - ys0)[:, None] * (xs1 - xs0)[None, :])


def dilate(m: np.ndarray, n: int) -> np.ndarray:
    out = m.copy()
    for _ in range(n):
        o = out.copy()
        o[1:, :] |= out[:-1, :]
        o[:-1, :] |= out[1:, :]
        o[:, 1:] |= out[:, :-1]
        o[:, :-1] |= out[:, 1:]
        out = o
    return out


def main() -> None:
    if not os.path.exists(TILE):
        raise SystemExit("缺 %s —— 先跑 python tools/gen-app-logo.py --apply brand" % TILE)
    master = Image.open(SRC).convert("RGBA")
    W, H = master.size
    content = master.crop((1, 1, W - 1, H - 1)).convert("RGB")
    cw, ch = content.size
    rgb = np.asarray(content).astype(np.float64)

    # 1) 旧 logo 蒙版（局部自适应阈值）
    white = np.asarray(content).min(axis=2).astype(np.float32)
    diff = white - box_blur(white, BLUR)
    band = np.zeros((ch, cw), bool)
    band[Y0:Y1, 20:cw - 20] = True        # 左右留 20px：BoxBlur 边缘伪影
    erase = dilate((diff > DIFF_THR) & band, DILATE)
    print("擦除区 %d px" % int(erase.sum()))

    # 旧 logo 核心中心（强阈值 + 行列密度，避免散落音符把中心拉偏）
    core = (diff > CORE_THR) & band
    rows = np.nonzero(core.sum(axis=1) > 10)[0]
    cols = np.nonzero(core.sum(axis=0) > 10)[0]
    cy = (rows.min() + rows.max()) / 2
    cx = (cols.min() + cols.max()) / 2
    print("旧 logo 核心 bbox=(%d,%d)-(%d,%d)  中心=(%.0f,%.0f)"
          % (cols.min(), rows.min(), cols.max(), rows.max(), cx, cy))

    # 2) 扩散修补：擦除区用周围渐变平滑填满
    for _ in range(INPAINT_ITERS):
        for c in range(3):
            rgb[..., c][erase] = box_blur(rgb[..., c], INPAINT_K)[erase]
    print("扩散修补 %d 次完成" % INPAINT_ITERS)

    # 2b) 残留清理：旧 logo 的淡色音符（diff<=8）第一轮会漏网——修补后再检
    #     一遍 |dev|>11 的块，继续抹，直到接近背景自然噪声（实测 ~800px）
    for rnd in range(4):
        lum2 = rgb.mean(axis=2).astype(np.float32)
        d2 = lum2 - box_blur(lum2, BLUR)
        frag = (np.abs(d2) > 11) & band
        n = int(frag.sum())
        if n < 1200:
            print("残留清理 %d 轮后剩 %d px（≈背景噪声），收工" % (rnd, n))
            break
        frag = dilate(frag, 8)
        print("残留清理第 %d 轮: %d px" % (rnd + 1, int(frag.sum())))
        for _ in range(30):
            for c in range(3):
                rgb[..., c][frag] = box_blur(rgb[..., c], INPAINT_K)[frag]
    else:
        print("警告：残留清理 4 轮后仍有较强残留")

    # 3) 贴品牌 tile
    S = TILE_SIDE
    x0 = int(round(min(max(cx - S / 2, 30), cw - S - 30)))
    y0 = int(round(min(max(cy - S / 2, 470), 1430 - S)))   # 避开 y>1470 的标题文字
    tile = Image.open(TILE).convert("RGBA").resize((S, S), Image.Resampling.LANCZOS)
    out = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    out.paste(tile, (x0, y0), tile)
    print("tile %dx%d 贴在 (%d,%d)" % (S, S, x0, y0))

    # 4) 备份旧母版（只在没有备份时；本资产不在 git 里）+ 覆盖保存
    if not os.path.exists(BACKUP):
        master.save(BACKUP, optimize=True)
        print("旧母版备份 -> %s (%d bytes)" % (os.path.basename(BACKUP), os.path.getsize(BACKUP)))
    new = master.copy()
    new.paste(out, (1, 1))                # 1px 标记边原样保留
    new.save(SRC, optimize=True)
    print("母版已更新 -> %s (%d bytes)" % (os.path.basename(SRC), os.path.getsize(SRC)))

    # ASCII 验证
    a = np.asarray(out.convert("L"))
    ys = np.linspace(0, ch - 1, 88).astype(int)
    xs = np.linspace(0, cw - 1, 30).astype(int)
    for y in ys:
        print("".join("#" if a[y, x] < 150 else ("+" if a[y, x] < 215 else ".") for x in xs))


if __name__ == "__main__":
    main()
