/**
 * 全局字号缩放 store（QT UI 库）。
 *
 * 背景（AGENTS.md 红线与 design.md §6.6 实测结论）：
 *  - Vapor 模式**禁 CSS 变量**，无法用根级变量做整页缩放；
 *  - app-uvue **文字样式不继承**，父 <view> 上的 font-size 不会传到子 <text>，
 *    且 render/inherit/unset 都不支持；
 *  - rpx = windowWidth / 750，是响应窗口宽度、**不响应**运行时状态。
 *
 * 因此全局字号只能走「每个 <text> 的内联 :style 绑定」。本 store 提供缩放开
 * （离散档位 很小/小/标准/大/很大），helper 把基准字号 x 倍率拼成内联字号样式串。
 *
 * 使用：页面 import { useFontScaleStore, qtFont }，把原本写死在类里的
 * font-size 改为内联绑定，例如：
 *   <text :style="'color:' + theme.skin.text + ';' + qtFont(25)">…</text>
 * 有 -wide px 覆盖的节点改用 qtFontDual（它内部按宽窄自动分支）：
 *   <text :style="qtFontDual(26, 15)">…</text>
 */
import { reactive } from "vue";
import { qtIsWide } from "@/uni_modules/qt-ui/composables/use-qt-layout";

const FONT_SCALE_KEY = "qt-ui-font-scale";

export type QtFontTier = "tiny" | "small" | "normal" | "large" | "huge";

export type QtFontTierPreset = {
  id: QtFontTier;
  name: string;
  description: string;
  scale: number;
};

/**
 * 离散档位（用户 2026-10-11 重定标：把原先的 1.15「大」提升为新的「标准」基准）。
 * 注意 scale = 1.0 已不再是标准档 —— 默认档是 normal(1.15)，所以
 * tools/verify-font-scale-args.mjs 那条「scale=1.0 与 class 原值逐位一致」的不变量
 * 仍然成立（helper 的数学没变），只是默认渲染相对改动前放大了 15%。
 */
export const QT_FONT_TIERS: QtFontTierPreset[] = [
  // description 固定 2 字：设置页 5 档平分一行，窄屏每格内容宽约 155px，
  // 「很大」档（1.5x）下 3 字描述（约 154px）会顶到换行，2 字留足余量
  { id: "tiny", name: "很小", description: "紧凑", scale: 0.85 },
  { id: "small", name: "小", description: "略小", scale: 1.0 },
  { id: "normal", name: "标准", description: "默认", scale: 1.15 },
  { id: "large", name: "大", description: "易读", scale: 1.3 },
  { id: "huge", name: "很大", description: "最大", scale: 1.5 },
];

/** 默认档位（normal = 1.15，用户重定标后的标准） */
const DEFAULT_TIER: QtFontTier = "normal";

function tierOf(id: string): QtFontTierPreset {
  for (let i = 0; i < QT_FONT_TIERS.length; i++) {
    if (QT_FONT_TIERS[i].id == id as QtFontTier) return QT_FONT_TIERS[i];
  }
  return defaultTier();
}

function defaultTier(): QtFontTierPreset {
  for (let i = 0; i < QT_FONT_TIERS.length; i++) {
    if (QT_FONT_TIERS[i].id == DEFAULT_TIER) return QT_FONT_TIERS[i];
  }
  return QT_FONT_TIERS[0];
}

class FontScaleStore {
  /** 当前档位 id */
  tier: QtFontTier = DEFAULT_TIER;
  /** 当前倍率（1.15 = 标准；随 setTier 联动更新） */
  scale: number = defaultTier().scale;

  init(): void {
    try {
      const saved = uni.getStorageSync(FONT_SCALE_KEY) as string | null;
      if (saved != null) this.setTier(saved as QtFontTier);
    } catch (_) {
      this.tier = DEFAULT_TIER;
      this.scale = defaultTier().scale;
    }
  }

  setTier(value: QtFontTier): void {
    const preset = tierOf(value as string);
    this.tier = preset.id;
    this.scale = preset.scale;
    this.persist();
  }

  private persist(): void {
    try {
      uni.setStorageSync(FONT_SCALE_KEY, this.tier);
    } catch (_) {}
  }
}

export const fontScale = reactive(new FontScaleStore());

export function useFontScaleStore(): FontScaleStore {
  return fontScale;
}

/**
 * 生成「rpx 基准字号 x 全局倍率」的内联字号样式串（Vapor 只能这样逐节点绑）。
 * 有 -wide px 覆盖的节点不要用这个，改用 qtFontPx / qtFontRpx 手动分支。
 * @param baseRpx 设计稿上该节点的基准字号（rpx）
 */
export function qtFont(baseRpx: number): string {
  return "font-size:" + scaledRpx(baseRpx) + "rpx;";
}

/** 生成「px 基准字号 x 全局倍率」的内联字号样式串（宽屏 -wide 覆盖用） */
export function qtFontPx(basePx: number): string {
  return "font-size:" + scaledPx(basePx) + "px;";
}
/** 生成「rpx 基准字号 x 全局倍率」的内联字号样式串（竖屏用，px 覆盖交给调用方分支） */
export function qtFontRpx(baseRpx: number): string {
  return qtFont(baseRpx);
}

/**
 * 宽屏双基准字号：紧凑用 rpx 基准、宽屏用 px 覆盖基准，各自乘全局倍率。
 *
 * 为什么必须有它：内联 :style 的优先级高于 class，一旦给 <text> 写了内联
 * font-size，原本靠 `-wide` class 做的宽屏 px 覆盖就整体失效了（宽屏会退回按
 * rpx 缩放的小字号，实测 40rpx 在宽屏只有 20px，而 -wide 要的是 28px）。
 * 所以凡是带 `-wide` 覆盖的节点，必须把两个基准一起交给本函数做分支。
 *
 * 为什么 isWide 不交给调用方传：布局对象是模块级单例（use-qt-layout.ts 的
 * `layout`），helper 内部直接读它与页面里的 `layout.isWide` 完全同源，还能让
 * 模板只写 `qtFontDual(30, 16)` —— 调用点不需要先 import 布局 composable，
 * 也不会出现「模板里那个 isWide 到底叫 layout 还是别的名字」的歧义。
 */
export function qtFontDual(baseRpx: number, widePx: number): string {
  return qtIsWide() ? qtFontPx(widePx) : qtFontRpx(baseRpx);
}

/** 宽屏双基准：两侧都用 px（宽屏 -wide 与紧凑基准同为 px 的节点） */
export function qtFontDualPx(basePx: number, widePx: number): string {
  return qtIsWide() ? qtFontPx(widePx) : qtFontPx(basePx);
}

/** 宽屏双基准：两侧都用 rpx（-wide 覆盖也是 rpx 的节点） */
export function qtFontDualRpx(baseRpx: number, wideRpx: number): string {
  return qtIsWide() ? qtFontRpx(wideRpx) : qtFontRpx(baseRpx);
}

function scaledRpx(baseRpx: number): number {
  return Math.round(baseRpx * fontScale.scale * 100) / 100;
}

/**
 * 宽屏最小字号（px）。
 *
 * 改造前宽屏有一批 9-10px 的辅助字号（平台角标、播放时间、角标数字），在 24 寸
 * 显示器上实测几乎不可读 —— 手机上 9px 能凑合是因为视距 25cm，桌面视距 60cm。
 * 这里做成**输出侧下限**而不是改每个调用点的参数：`-wide{font-size:10px}` 这类
 * class 里有几十处，逐个改参数会让 `tools/verify-font-scale-args.mjs`（它校验
 * helper 参数与 class 字号逐位一致）全线失败，而这个不变量本身是对的 —— 它保证的
 * 是「标准档渲染与改造前一致」，不该为了放宽字号被破坏。
 *
 * 只作用于 `qtIsWide()` 为真的分支：手机竖屏 9px 保持原样（那里的密度是真需求）。
 */
export const QT_MIN_WIDE_FONT_PX = 11;

function scaledPx(basePx: number): number {
  const v = Math.round(basePx * fontScale.scale * 100) / 100;
  if (qtIsWide() && v < QT_MIN_WIDE_FONT_PX) return QT_MIN_WIDE_FONT_PX;
  return v;
}