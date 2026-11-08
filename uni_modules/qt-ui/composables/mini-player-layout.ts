import { qtLayout, qtRpx, qtTabBarHeightPx, qtPlayerBarHeightPx } from "./use-qt-layout";
import { fontScale } from "../stores/font-scale";

/** Two scaled text lines plus room for the progress track. */
export function qtMiniStripHeightPx(): number {
  return qtLayout().isWide
    ? Math.max(56, Math.ceil(37 * fontScale.scale + 16))
    : qtRpx(Math.max(112, Math.ceil(68 * fontScale.scale + 24)));
}

/** Fixed compact row uses a smaller text rhythm, with room for large fonts. */
export function qtMiniDockBarHeightPx(): number {
  return qtLayout().isWide ? qtPlayerBarHeightPx() : qtRpx(Math.max(112, Math.ceil(60 * fontScale.scale + 28)));
}

export function qtMiniDockBottomPx(aboveTab: boolean): number {
  const layout = qtLayout();
  if (layout.isWide) return 0;
  return aboveTab ? qtTabBarHeightPx(true) : layout.safeBottomPx + qtRpx(16);
}

/** Total reserved area, measured from the window bottom (safe area counted once). */
export function qtMiniDockReservePx(aboveTab: boolean): number {
  return qtMiniDockBottomPx(aboveTab) + qtMiniDockBarHeightPx();
}

/** 同一快照的 height - inset：新页面原生根先缩短时，不会再叠上一页的 bottom。 */
export function qtMiniDockTopPx(aboveTab: boolean): number {
  return Math.max(0, qtLayout().windowHeight - qtMiniDockReservePx(aboveTab));
}
