import { qtLayout } from "./use-qt-layout";
import { qtSheetWidth } from "./use-qt-widths";
import { qtFontValuePx } from "../stores/font-scale";

/** First-frame text estimate; native content measurements remain authoritative. */
export function qtSheetTextLinesPx(text: string, fontPx: number, widthPx: number): number {
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    let span = 0;
    for (const glyph of Array.from(paragraph)) span += (glyph.charCodeAt(0) > 255 ? 1 : 0.58) * fontPx;
    lines += Math.max(1, Math.ceil(span / Math.max(1, widthPx)));
  }
  return lines;
}

export type QtTvSheetBodyBudget = {
  title: string;
  subtitle?: string;
  fixedBodyPx?: number;
  footerPx?: number;
  footerFlush?: boolean;
  dismissible?: boolean;
};

/** TV native viewport after the actual QtSheet header, fixed body controls and footer. */
export function qtTvSheetBodyHeightPx(budget: QtTvSheetBodyBudget): number {
  const layout = qtLayout();
  const width = qtSheetWidth("drawer") - 40 - (budget.dismissible != false ? 68 : 0);
  let header = 0;
  if (budget.title.length > 0) {
    const title = qtSheetTextLinesPx(budget.title, qtFontValuePx(16), width) * Math.ceil(qtFontValuePx(16) * 1.35);
    const subtitle = budget.subtitle ?? "";
    const description = subtitle.length > 0
      ? qtSheetTextLinesPx(subtitle, qtFontValuePx(12), width) * Math.ceil(qtFontValuePx(12) * 1.4) + 3 : 0;
    header = 28 + Math.max(budget.dismissible != false ? 56 : 0, title + description) + 1;
  }
  const bottom = budget.footerFlush == true ? 0 : 12;
  return Math.max(0, Math.floor(layout.paneHeight * 0.86 - layout.safeBottomPx
    - header - (budget.fixedBodyPx ?? 0) - (budget.footerPx ?? 0) - bottom - 2));
}
