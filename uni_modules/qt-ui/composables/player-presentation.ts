import { playingTrackMetrics } from "./playing-track-metrics";

/** Compact artwork yields to text, controls and safe areas, including narrow fold panes. */
export type PortraitPlayerMetrics = {
  discRpx: number;
  reservedRpx: number;
  artTopRpx: number;
  trackTopRpx: number;
  trackBottomRpx: number;
  padSidePx: number;
  padTopPx: number;
  padBottomPx: number;
  trackWidthPx: number;
  trackHeightPx: number;
  lyricRowPx: number;
  progressRowPx: number;
  metaRowPx: number;
  controlsRowPx: number;
  mainSizePx: number;
  mainWidthPx: number;
  toolRowPx: number;
  footerPx: number;
  focusHeightPx: number;
  headingHeightPx: number;
  contentHeightPx: number;
};

export function portraitPlayerMetrics(width: number, height: number, statusBar: number, safeBottom: number, scale: number, windowWidth: number = width, sourceLabel: string = "", style: string = "classic", name: string = "", artist: string = ""): PortraitPlayerMetrics {
  const unit = Math.max(windowWidth, 1) / 750;
  const padSidePx = Math.min(24, (style == "classic" ? 34 : 46) * unit, Math.max(0, width * 0.065));
  const padTopPx = Math.max(0, statusBar) + 52;
  const padBottomPx = 12;
  const trackWidthPx = Math.max(0, width - padSidePx * 2);
  const track = playingTrackMetrics(trackWidthPx, windowWidth, false, false, scale, sourceLabel, false, name, artist);
  const lyricRowPx = Math.max(36, Math.ceil(26 * unit * scale * 1.4 + 8));
  const progressRowPx = 36;
  const metaRowPx = Math.max(18, Math.ceil(20 * unit * scale * 1.4 + 4));
  const mainSizePx = style == "classic" ? 60 : 64;
  const mainWidthPx = style == "classic" ? 60 : Math.min(82, Math.max(60, trackWidthPx - 204));
  const controlsRowPx = mainSizePx;
  const toolRowPx = Math.max(44, Math.ceil(18 * unit * scale * 1.4 + 26));
  // Six-pixel gaps before transport and secondary tools; every tappable control is at least 44px.
  const footerPx = progressRowPx + metaRowPx + controlsRowPx + 6 + toolRowPx + 6;
  const baseReservedPx = padTopPx + padBottomPx + track.heightPx + lyricRowPx + 2 + 12 + 8 + footerPx;
  const availablePx = Math.max(0, height - Math.max(0, safeBottom) - baseReservedPx);
  // Gallery artwork follows the approved album proportions; the turntable retains its full canvas.
  const artLimitPx = style == "gallery" ? Math.min(300, width * 0.765, trackWidthPx) : Math.min(613 * unit, trackWidthPx * 0.9);
  const discRpx = Math.floor(Math.min(artLimitPx, availablePx) / unit);
  const extraPx = Math.max(0, availablePx - discRpx * unit);
  const artTopRpx = extraPx * 0.45 / unit;
  const trackTopRpx = (12 + Math.min(24, extraPx * 0.15)) / unit;
  const trackBottomRpx = (8 + extraPx - artTopRpx * unit - (trackTopRpx * unit - 12)) / unit;
  const reservedRpx = baseReservedPx / unit + extraPx / unit;
  // Expanded lyrics condense their heading while the footer stays in exactly the same position.
  const lyricToolsPx = Math.max(44, Math.ceil(22 * unit * scale * 1.4 + 12));
  const contentHeightPx = Math.max(0, height - Math.max(0, safeBottom) - padTopPx - padBottomPx - footerPx);
  const heading = playingTrackMetrics(trackWidthPx, windowWidth, false, false, scale, sourceLabel, true, name);
  const headingHeightPx = Math.min(heading.heightPx, Math.max(0, contentHeightPx - lyricToolsPx - 64));
  const focusHeightPx = Math.max(0, contentHeightPx - headingHeightPx - 8 - lyricToolsPx);
  return { discRpx, reservedRpx, artTopRpx, trackTopRpx, trackBottomRpx, padSidePx, padTopPx,
    padBottomPx, trackWidthPx, trackHeightPx: track.heightPx, lyricRowPx, progressRowPx,
    metaRowPx, controlsRowPx, mainSizePx, mainWidthPx, toolRowPx, footerPx, focusHeightPx, headingHeightPx, contentHeightPx };
}

/** Wide footer rows are also bound inline by the page: the budget and rendered sizes share one source. */
export function widePlayerMetrics(width: number, height: number, statusBar: number, safeBottom: number, short: boolean, toolCount: number, scale: number, trackHeightPx: number = 0) {
  const stageWidthPx = Math.max(0, width);
  // Stage padding 18*2, controls margin 8*2 and controls padding 8*2.
  const controlsWidthPx = Math.max(0, stageWidthPx - 68);
  const toolSizePx = 44;
  const toolGapPx = short ? 6 : 8;
  const toolsWidthPx = Math.max(0, toolCount) * toolSizePx + Math.max(0, toolCount - 1) * toolGapPx;
  const mainSizePx = short ? 48 : 60;
  const controlGapPx = short ? 8 : 12;
  // Five controls keep one order in portrait and landscape.
  const transportWidthPx = 44 * 4 + mainSizePx + controlGapPx * 4;
  const wingWidthPx = Math.max(0, (controlsWidthPx - transportWidthPx) / 2);
  // Keep every configured tool and the queue. An extra row is preferable to clipping or tiny hit targets.
  const stacked = toolsWidthPx > wingWidthPx;
  const controlsRowPx = mainSizePx;
  const toolsRowPx = stacked ? toolSizePx + 6 : 0;
  const controlsHeightPx = controlsRowPx + toolsRowPx;
  const controlsMarginPx = short ? 4 : 8;
  const lyricHeightPx = Math.max(44, Math.ceil(11 * scale * 1.4 + 12));
  const lyricMarginPx = short ? 2 : 6;
  const progressHeightPx = 32;
  const progressMarginPx = short ? 2 : 8;
  const footerPx = 11 + progressHeightPx + progressMarginPx + controlsHeightPx + controlsMarginPx;
  const padTopPx = Math.max(0, statusBar) + 52;
  const padBottomPx = (short ? 8 : 14) + Math.max(0, safeBottom);
  const bodyHeightPx = Math.max(0, height - padTopPx - padBottomPx - footerPx);
  // No minimum can consume reserved controls in an exceptionally short split window.
  const artColumnPx = Math.max(0, Math.min(484, (stageWidthPx - 36) * 0.42));
  const trackWidthPx = Math.max(0, artColumnPx - 16);
  const coverCardPx = Math.max(0, Math.min(420, trackWidthPx, bodyHeightPx - trackHeightPx - 20));
  // Native scroll containers must own an unshrunk content height. Centering a
  // taller metadata block in the viewport otherwise clips its first/last rows.
  const leftContentHeightPx = Math.max(bodyHeightPx, trackHeightPx + (coverCardPx > 0 ? coverCardPx + 16 : 0));
  return { stageWidthPx, controlsWidthPx, toolsWidthPx, transportWidthPx, wingWidthPx, stacked, controlsRowPx,
    mainSizePx, controlGapPx, toolSizePx, toolGapPx, toolsRowPx, controlsHeightPx, controlsMarginPx, lyricHeightPx,
    lyricMarginPx, progressHeightPx, progressMarginPx, footerPx, padTopPx, padBottomPx,
    trackHeightPx, trackWidthPx, artColumnPx, bodyHeightPx, coverCardPx, leftContentHeightPx };
}

/** Queue rows, spacer, scroll anchoring and window coverage use the same logical-pixel stride. */
export function playerQueueMetrics(width: number, height: number, wide: boolean, safeBottom: number, scale: number, windowWidth: number = width) {
  const unit = Math.max(1, windowWidth) / 750;
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
export function playerOffsetMetrics(width: number, height: number, wide: boolean, sheetWidth: number, safeBottom: number, scale: number, windowWidth: number = width) {
  const unit = Math.max(1, windowWidth) / 750;
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
