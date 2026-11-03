/** Pure geometry for the compact player; values match its fixed CSS rows. */
export type PortraitPlayerMetrics = {
  discRpx: number;
  titleRowRpx: number;
  artistRowRpx: number;
  lyricRowRpx: number;
  metaRowRpx: number;
  reservedRpx: number;
  artTopRpx: number;
};

export function portraitPlayerMetrics(width: number, height: number, statusBar: number, safeBottom: number, scale: number): PortraitPlayerMetrics {
  const unit = Math.max(width, 1) / 750;
  const titleRowRpx = Math.max(72, Math.ceil(38 * scale * 1.4 + 12));
  const artistRowRpx = Math.max(52, Math.ceil(28 * scale * 1.4 + 12));
  const lyricRowRpx = Math.max(56, Math.ceil(26 * scale * 1.4 + 12));
  const metaRowRpx = Math.max(40, Math.ceil(20 * scale * 1.4 + 8));
  // Header 96, no extra gap above the turntable. Text: gap 28 + three rows + two gaps 8 + trailing gap 16.
  // Footer: progress 64+4, metadata, controls 96+4, tools 88+0, bottom 28.
  const baseReserved = statusBar / unit + 96 + 28 + titleRowRpx + artistRowRpx + lyricRowRpx + 16 + 16 + 284 + metaRowRpx;
  const available = Math.max(0, (height - Math.max(0, safeBottom)) / unit - baseReserved);
  // Allocate the ENTIRE turntable canvas after reserving all three scaled text rows.
  const discRpx = Math.floor(Math.min(613, available));
  // Keep the assembly immediately below the nav, rather than adding tall-screen whitespace above it.
  const artTopRpx = 0;
  const reservedRpx = baseReserved + artTopRpx;
  return { discRpx, titleRowRpx, artistRowRpx, lyricRowRpx, metaRowRpx, reservedRpx, artTopRpx };
}
