/** Pure geometry for the compact player; values match its fixed CSS rows. */
export type PortraitPlayerMetrics = {
  discRpx: number;
  titleRowRpx: number;
  artistRowRpx: number;
  lyricRowRpx: number;
  metaRowRpx: number;
  reservedRpx: number;
  artTopRpx: number;
  trackTopRpx: number;
  trackBottomRpx: number;
};

export function portraitPlayerMetrics(width: number, height: number, statusBar: number, safeBottom: number, scale: number): PortraitPlayerMetrics {
  const unit = Math.max(width, 1) / 750;
  const titleRowRpx = Math.max(72, Math.ceil(38 * scale * 1.4 + 12));
  const artistRowRpx = Math.max(52, Math.ceil(28 * scale * 1.4 + 12));
  const lyricRowRpx = Math.max(56, Math.ceil(26 * scale * 1.4 + 12));
  const metaRowRpx = Math.max(40, Math.ceil(20 * scale * 1.4 + 8));
  // Minimum space: header 96; track gap 28 + three rows + two gaps 8 + trailing gap 16.
  // Footer: progress 64+4, metadata, controls 96+4, tools 88+0, bottom 28.
  const baseReserved = statusBar / unit + 96 + 28 + titleRowRpx + artistRowRpx + lyricRowRpx + 16 + 16 + 284 + metaRowRpx;
  const available = Math.max(0, (height - Math.max(0, safeBottom)) / unit - baseReserved);
  // Allocate the ENTIRE turntable canvas after reserving all three scaled text rows.
  const discRpx = Math.floor(Math.min(613, available));
  // Once width limits the artwork, distribute extra height around the artwork/info group.
  // Keep their own gap bounded instead of leaving all tall-screen space above the title.
  const extra = Math.max(0, available - discRpx);
  const artTopRpx = Math.floor(extra * 0.4);
  const trackTopRpx = 28 + Math.floor(Math.min(64, extra * 0.2));
  const trackBottomRpx = 16 + extra - artTopRpx - (trackTopRpx - 28);
  const reservedRpx = baseReserved + artTopRpx + (trackTopRpx - 28) + (trackBottomRpx - 16);
  return { discRpx, titleRowRpx, artistRowRpx, lyricRowRpx, metaRowRpx, reservedRpx, artTopRpx, trackTopRpx, trackBottomRpx };
}

/** Wide footer rows are also bound inline by the page: the budget and rendered sizes share one source. */
export function widePlayerMetrics(width: number, height: number, statusBar: number, safeBottom: number, short: boolean, toolCount: number, scale: number) {
  const stageWidthPx = Math.max(0, width);
  // Stage padding 18*2, controls margin 8*2 and controls padding 8*2.
  const controlsWidthPx = Math.max(0, stageWidthPx - 68);
  const toolSizePx = short ? 36 : 38;
  const toolGapPx = short ? 6 : 8;
  const toolsWidthPx = Math.max(0, toolCount) * (toolSizePx + toolGapPx);
  const transportWidthPx = 36 * 2 + (short ? 38 : 42) + 14 * 2;
  const wingWidthPx = Math.max(0, (controlsWidthPx - transportWidthPx) / 2);
  // Keep every configured tool and the queue. An extra row is preferable to clipping or tiny hit targets.
  const stacked = toolsWidthPx > wingWidthPx;
  const controlsRowPx = short ? 42 : 46;
  const toolsRowPx = stacked ? toolSizePx + 6 : 0;
  const controlsHeightPx = controlsRowPx + toolsRowPx;
  const controlsMarginPx = short ? 4 : 8;
  const lyricHeightPx = Math.max(34, Math.ceil(11 * scale * 1.4 + 8));
  const lyricMarginPx = short ? 2 : 6;
  const progressHeightPx = short ? 36 : 32;
  const progressMarginPx = short ? 6 : 12;
  const footerPx = 11 + progressHeightPx + progressMarginPx + controlsHeightPx + controlsMarginPx;
  const padTopPx = Math.max(short ? 44 : 60, Math.max(0, statusBar) + (short ? 44 : 52));
  const padBottomPx = (short ? 8 : 14) + Math.max(0, safeBottom);
  // Track title, platform row and their margins grow with the font tier, never with window rpx.
  const trackHeightPx = 0;
  const bodyHeightPx = Math.max(0, height - padTopPx - padBottomPx - footerPx);
  // No minimum can consume reserved controls in an exceptionally short split window.
  const coverCardPx = Math.max(0, Math.min(420, (stageWidthPx * 0.38) - 42, bodyHeightPx - 32));
  return { stageWidthPx, controlsWidthPx, toolsWidthPx, transportWidthPx, wingWidthPx, stacked, controlsRowPx, toolsRowPx, controlsHeightPx, controlsMarginPx, lyricHeightPx, lyricMarginPx, progressHeightPx, progressMarginPx, footerPx, padTopPx, padBottomPx, trackHeightPx, bodyHeightPx, coverCardPx };
}

/** Queue rows, spacer, scroll anchoring and window coverage use the same logical-pixel stride. */
export function playerQueueMetrics(width: number, height: number, wide: boolean, safeBottom: number, scale: number) {
  const unit = Math.max(1, width) / 750;
  const stridePx = wide ? Math.max(60, Math.ceil(26 * scale * 1.35 + 15)) : Math.max(104, Math.ceil(48 * scale * 1.35 + 20)) * unit;
  const panelHeightPx = Math.max(0, wide ? height : height * 0.7);
  const headerPx = wide ? 56 : 96 * unit;
  const handlePx = wide ? 0 : 36 * unit;
  const viewportPx = Math.max(0, panelHeightPx - Math.max(0, safeBottom) - headerPx - handlePx - 2);
  return { stridePx, panelHeightPx, viewportPx };
}

export function playerQueueWindow(length: number, stridePx: number, viewportPx: number, scrollTop: number, margin: number) {
  const stride = Math.max(1, stridePx);
  const contentHeightPx = Math.ceil(Math.max(0, length) * stride);
  const maxScrollPx = Math.max(0, contentHeightPx - Math.max(0, viewportPx));
  const scrollPx = Math.max(0, Math.min(maxScrollPx, scrollTop));
  const first = Math.max(0, Math.floor(scrollPx / stride) - margin);
  const last = Math.min(length - 1, Math.ceil((scrollPx + Math.max(0, viewportPx)) / stride) + margin);
  return { contentHeightPx, maxScrollPx, scrollPx, first, last };
}

/** Preserve the visible song and fractional row offset; removed songs fall back to the nearest index. */
export function playerQueueAnchorScroll(keys: string[], anchorKey: string, anchorIndex: number, fraction: number, stridePx: number, viewportPx: number): number {
  let index = Math.max(0, Math.min(keys.length - 1, anchorIndex));
  if (anchorKey.length > 0 && keys[index] != anchorKey) {
    const found = keys.indexOf(anchorKey);
    if (found >= 0) index = found;
  }
  const target = (index + Math.max(0, Math.min(1, fraction))) * stridePx;
  return playerQueueWindow(keys.length, stridePx, viewportPx, target, 0).scrollPx;
}

/** Offset sheet fallback and capped scroll viewport; wide dimensions are fixed px. */
export function playerOffsetMetrics(width: number, height: number, wide: boolean, sheetWidth: number, safeBottom: number, scale: number) {
  const unit = Math.max(1, width) / 750;
  const panelWidthPx = wide ? Math.min(width, sheetWidth) : width;
  const paddingPx = wide ? 28 : 40 * unit;
  const trackWidthPx = Math.max(0, panelWidthPx - paddingPx * 2);
  const trackLeftPx = (width - panelWidthPx) / 2 + paddingPx;
  const thumbSizePx = wide ? 22 : 36 * unit;
  // Match QtSheet title/subtitle, header padding, close target and its existing bottom inset.
  const headerPx = wide ? 29 + Math.max(36, Math.ceil(28 * scale * 1.4) + 3) : (48 + Math.max(64, Math.ceil(53 * scale * 1.4) + 6) + 1) * unit;
  const bottomPx = wide ? 12 : Math.max(8 * unit, safeBottom);
  const maxViewportPx = Math.max(0, height * 0.86 - safeBottom - headerPx - bottomPx);
  const viewportPx = Math.min(maxViewportPx, (wide ? 334 : 600 * unit) * Math.max(1, scale));
  return { trackWidthPx, trackLeftPx, thumbSizePx, viewportPx };
}

export function playerOffsetThumbLeft(ms: number, maxMs: number, widthPx: number, sizePx: number): number {
  if (widthPx <= 0 || maxMs <= 0) return 0;
  const frac = Math.max(0, Math.min(1, (ms + maxMs) / (maxMs * 2)));
  return Math.max(0, Math.min(widthPx - sizePx, frac * widthPx - sizePx / 2));
}
export function playerOffsetFromClientX(clientX: number, leftPx: number, widthPx: number, maxMs: number, snapMs: number, fallbackMs: number): number {
  if (widthPx <= 0 || maxMs <= 0 || snapMs <= 0) return fallbackMs;
  const frac = Math.max(0, Math.min(1, (clientX - leftPx) / widthPx));
  return Math.max(-maxMs, Math.min(maxMs, Math.round((frac * 2 - 1) * maxMs / snapMs) * snapMs));
}
