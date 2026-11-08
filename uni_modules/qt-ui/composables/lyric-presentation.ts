export type QtLyricFocus = { opacity: number; blurPx: number };

/** Native-compatible text paint; clearing a shadow is explicit on reused nodes. */
export function lyricTextFocusStyle(color: string, blurPx: number): string {
  const radius = isFinite(blurPx) ? Math.max(0, Math.min(4, blurPx)) : 0;
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
  const fade = Math.max(0, Math.min(1, (ratio - 0.22) / (0.86 - 0.22)));
  const opacity = 1 - fade * fade * (3 - 2 * fade);
  // Keep the adjacent lines sharp; blur only the more distant context.
  const softness = Math.max(0, Math.min(1, (ratio - 0.30) / (0.86 - 0.30)));
  const blurPx = 4 * softness * softness * (3 - 2 * softness);
  return { opacity: Math.round(opacity * 100) / 100, blurPx: Math.round(blurPx * 10) / 10 };
}
