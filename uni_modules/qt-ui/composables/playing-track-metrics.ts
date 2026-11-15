/** Mixed CJK/Latin package labels should not be measured as full-width glyphs throughout. */
function textWidth(text: string, font: number): number {
  let units = 0;
  for (const glyph of Array.from(text)) {
    units += /[^\u0000-\u007f]/.test(glyph) ? 1 : /[MW@]/.test(glyph) ? 0.9 : /[A-Z]/.test(glyph) ? 0.68 : /[ .,:;|!il]/.test(glyph) ? 0.32 : 0.58;
  }
  return units * font;
}

/** Cover metadata and the condensed lyric heading share touch-target and text budgets. */
export function playingTrackMetrics(width: number, windowWidth: number, wide: boolean, short: boolean, scale: number, sourceLabel: string, compact: boolean = false, name: string = "", artist: string = "") {
  const unit = Math.max(1, windowWidth) / 750;
  const titleFontPx = (compact ? 15 : wide ? (short ? 22 : 26) : 48 * unit) * scale;
  const metaFontPx = (wide ? 13 : 25 * unit) * scale;
  const sourceFontPx = (wide ? 12 : 22 * unit) * scale;
  const titleLinePx = Math.ceil(titleFontPx * 1.3);
  const hitPx = 44;
  const gapPx = wide ? 8 : 16 * unit;
  // 用户 2026-11-13 二次裁定：来源保持普通文字（无胶囊），但位置回到行尾最右——歌手 flex:1 撑行、
  // 来源贴右；三行（歌名/歌手·来源/词作）行距收紧：行间 margin 4→2、歌手与词作行触控底 44→36。
  const artistArrowPx = wide ? 14 : 24 * unit;
  const naturalArtistPx = Math.ceil(textWidth(artist, metaFontPx)) + artistArrowPx + 4;
  const naturalSourcePx = Math.max(hitPx, Math.ceil(textWidth(sourceLabel, sourceFontPx) + 8 + (wide ? 13 : 22 * unit)));
  const stacked = naturalSourcePx + naturalArtistPx + gapPx > width;
  const sourceWidthPx = Math.max(0, Math.min(width, naturalSourcePx));
  const artistWidthPx = Math.max(0, Math.min(naturalArtistPx, (stacked ? width : width - sourceWidthPx - gapPx) - artistArrowPx - 4));
  const metaRowPx = Math.max(36, Math.ceil(metaFontPx * 1.4 + 12));
  const titleLines = name.length == 0 ? 2 : Math.max(1, Math.min(2, Math.ceil(textWidth(name, titleFontPx) / Math.max(1, width - hitPx - gapPx))));
  const titleHeightPx = Math.max(hitPx, titleLinePx * titleLines);
  const metaHeightPx = stacked ? metaRowPx * 2 + 2 : metaRowPx;
  const contextCoverPx = 44;
  const contextCopyPx = Math.max(0, width - contextCoverPx - 10 - hitPx - gapPx);
  // 歌词页标题改两行紧排：首行歌名-歌手、次行平台·音质；整块高度与左侧封面 44px 对齐。
  const contextTitlePx = Math.ceil(titleFontPx * 1.4 + 4);
  const contextMetaPx = Math.max(16, Math.ceil(10 * scale * 1.4 + 2));
  const contextHeightPx = Math.max(contextCoverPx, contextTitlePx + contextMetaPx + 2);
  return {
    titleFontPx, titleLinePx, titleHeightPx, metaFontPx, sourceFontPx, hitPx, gapPx, stacked,
    sourceWidthPx, artistWidthPx, metaRowPx, metaHeightPx,
    contextCoverPx, contextCopyPx, contextTitlePx, contextMetaPx,
    heightPx: compact ? contextHeightPx : titleHeightPx + 2 + metaHeightPx,
  };
}

/** Sheet viewport accounts for both scaled heading lines and the native safe area. */
export function playbackSourceViewport(width: number, height: number, wide: boolean, safeBottom: number, scale: number, rows: number, windowWidth: number = width) {
  const unit = Math.max(1, windowWidth) / 750;
  const closePx = wide ? 36 : 64 * unit;
  const headingWidth = Math.max(1, width - (wide ? 40 + 46 : (64 + 80) * unit));
  const titlePx = (wide ? 16 : 30 * unit) * scale;
  const subtitlePx = (wide ? 12 : 23 * unit) * scale;
  // Header text can wrap on a physical fold pane even when its whole-window rpx is large.
  const titleLines = Math.max(1, Math.ceil("播放来源与音质".length * titlePx / headingWidth));
  const subtitleLines = Math.max(1, Math.ceil("调整正在播放的歌曲；首页浏览来源分别设置。".length * subtitlePx / headingWidth));
  const headingPx = (titleLines * titlePx + subtitleLines * subtitlePx) * 1.4 + (wide ? 3 : 6 * unit);
  const headerPx = (wide ? 29 : 49 * unit) + Math.max(closePx, Math.ceil(headingPx));
  const bottomPx = wide ? 12 : Math.max(8 * unit, safeBottom);
  const availablePx = Math.max(0, height * 0.86 - safeBottom - headerPx - bottomPx);
  const rowPx = Math.max(44, (wide ? 15 : 28 * unit) * scale * 1.35 + 16) + (wide ? 1 : unit);
  return Math.min(availablePx, rows * rowPx + (wide ? 100 : 180 * unit) * scale);
}
