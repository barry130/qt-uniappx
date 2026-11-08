/** Pure detail-page geometry. Inputs are the shared density flag and effective
 * qtContentWidth() (including page padding and any active frame cap).
 * No stores, viewport discovery, persistence or app services are imported here.
 */
export type DetailLayoutMetrics = {
  split: boolean;
  innerWidthPx: number;
  asideWidthPx: number;
  listWidthPx: number;
  coverSizePx: number;
};

export function detailLayoutMetrics(isWide: boolean, contentWidthPx: number): DetailLayoutMetrics {
  const innerWidthPx = Math.max(0, contentWidthPx - 40);
  const split = isWide && innerWidthPx >= 220 + 16 + 360;
  const asideWidthPx = split ? Math.max(220, Math.min(272, innerWidthPx - 16 - 360)) : 0;
  return {
    split,
    innerWidthPx,
    asideWidthPx,
    listWidthPx: split ? innerWidthPx - asideWidthPx - 16 : innerWidthPx,
    // Leave vertical room for title, description and actions on landscape tablets.
    coverSizePx: split ? Math.min(220, asideWidthPx - 34) : 0,
  };
}

/** Two settings columns may only use the same wide density as qtFontDual.
 * contentWidthPx includes the overview's gutters; inPane always stays single.
 */
export function settingsOverviewTwoColumn(isWide: boolean, inPane: boolean, contentWidthPx: number, gutterPx: number): boolean {
  return isWide && !inPane && contentWidthPx - gutterPx * 2 - 16 >= 700;
}
