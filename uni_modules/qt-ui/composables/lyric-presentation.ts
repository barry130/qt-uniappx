export type QtLyricFocus = { opacity: number; blurPx: number };

/** Native-compatible text paint; clearing a shadow is explicit on reused nodes. */
export function lyricTextFocusStyle(color: string, blurPx: number): string {
  const radius = isFinite(blurPx) ? Math.max(0, Math.min(1.5, blurPx)) : 0;
  if (radius < 0.1) return "color:" + color + ";text-shadow:none;";
  // text-shadow is supported by Vapor; filter:blur is not. Its color must be explicit:
  // the shadow cannot inherit the transparent glyph color used to hide the sharp body.
  return "color:transparent;text-shadow:0px 0px " + radius.toFixed(1) + "px " + color + ";";
}

/** Distance is measured from the actual scroll viewport, never from a lyric index. */
export function lyricFocusAt(distancePx: number, viewportPx: number): QtLyricFocus {
  if (!isFinite(distancePx) || !isFinite(viewportPx) || viewportPx <= 0) {
    return { opacity: 1, blurPx: 0 };
  }
  const ratio = Math.abs(distancePx) / (viewportPx / 2);
  // Use the upper/lower viewport instead of fading whole lines near the center.
  const fade = Math.max(0, Math.min(1, (ratio - 0.42) / (0.98 - 0.42)));
  const opacity = 1 - fade * fade * (3 - 2 * fade);
  // A larger clear band and light edge softness keep surrounding verses readable.
  const softness = Math.max(0, Math.min(1, (ratio - 0.56) / (0.98 - 0.56)));
  const blurPx = 1.2 * softness * softness * (3 - 2 * softness);
  return { opacity: Math.round(opacity * 100) / 100, blurPx: Math.round(blurPx * 10) / 10 };
}
