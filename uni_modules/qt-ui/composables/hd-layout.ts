/** HD presentation geometry. Inputs are the actual container width, never device pixels. */
export type QtHdHomeMetrics = {
  innerPx: number;
  cardPx: number;
  cardGapPx: number;
  songColumns: number;
  songPx: number;
  featurePx: number;
  shortcutPx: number;
  featureSplit: boolean;
};

export function qtHdHomeMetrics(contentPx: number, scale: number = 1): QtHdHomeMetrics {
  const inner = Math.max(0, Math.floor(contentPx) - 32);
  const gap = 12;
  // Keep covers modest: wider screens show more music, not oversized artwork.
  const minCard = 136;
  const columns = Math.max(1, Math.min(8, Math.floor((inner + gap) / (minCard + gap))));
  const card = Math.min(180, Math.floor((inner - gap * (columns - 1)) / columns));
  const minSong = Math.round(270 * Math.max(1, scale));
  const songColumns = Math.max(1, Math.min(3, Math.floor((inner + 24) / (minSong + 24))));
  const songPx = Math.floor((inner - 24 * (songColumns - 1)) / songColumns);
  const shortcut = Math.round(192 * Math.max(1, Math.min(1.5, scale)));
  const split = inner >= 440 + shortcut + 16;
  return {
    innerPx: inner, cardPx: Math.max(0, card), cardGapPx: gap,
    songColumns, songPx, featureSplit: split,
    featurePx: split ? inner - shortcut - 16 : inner,
    shortcutPx: split ? shortcut : inner,
  };
}

export type QtHdPlayerMetrics = {
  wingPx: number;
  centerPx: number;
  coverPx: number;
  copyPx: number;
  showLike: boolean;
  showVolume: boolean;
  showTimes: boolean;
  timePx: number;
};

export function qtHdPlayerMetrics(availablePx: number, scale: number = 1): QtHdPlayerMetrics {
  const inner = Math.max(0, Math.floor(availablePx) - 32);
  const wing = Math.min(300, Math.floor(inner * 0.28));
  const center = inner - wing * 2;
  const showLike = wing >= 230;
  const cover = wing >= 180 ? 48 : 40;
  const time = Math.ceil(42 * Math.max(1, scale));
  return {
    wingPx: wing, centerPx: center, coverPx: cover,
    copyPx: Math.max(0, wing - cover - 12 - (showLike ? 44 : 0)),
    showLike, showVolume: wing >= 216,
    showTimes: center >= time * 2 + 100, timePx: time,
  };
}
