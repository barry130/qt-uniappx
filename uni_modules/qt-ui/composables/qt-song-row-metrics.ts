import { qtLayout, qtRpx } from "./use-qt-layout";
import { qtFontValuePx } from "../stores/font-scale";
import { QT_TV_TOKENS } from "./qt-tv-tokens";

/** Virtual item and its rendered row must share one height, including large TV font tiers. */
export function qtSongRowHeightPx(): number {
  const layout = qtLayout();
  if (!layout.isTv) return layout.isWide ? 82 : qtRpx(128);
  const title = Math.ceil(qtFontValuePx(17) * 1.3);
  const meta = Math.ceil(qtFontValuePx(14) * 1.3);
  return Math.max(QT_TV_TOKENS.rowPx, title + meta + 18);
}
/** Empty in touch mode: existing component and list-item CSS remain authoritative. */
export function qtTvSongRowStyle(): string {
  return qtLayout().isTv ? "height:" + qtSongRowHeightPx() + "px;" : "";
}
export function qtTvSongLineStyle(basePx: number): string {
  return qtLayout().isTv ? "line-height:" + Math.ceil(qtFontValuePx(basePx) * 1.3) + "px;" : "";
}
