/** Home-notice-bar-style seamless marquee (user m21532/m21548): one measured copy-width
 *  per iteration, the loop boundary snaps back invisibly; no rewind, no holds. */

/** Overflow threshold: <=1 rect-px of slack means the text fits and stays completely still.
 *  false is also returned for invalid measurements (NaN/0/negative) — callers retry those. */
export function marqueeOverflows(textWidth: number, viewportWidth: number): boolean {
  if (!Number.isFinite(textWidth) || !Number.isFinite(viewportWidth) || textWidth <= 0 || viewportWidth <= 0) return false;
  return textWidth - viewportWidth > 1;
}

/** Loop duration from the measured copy offset (first copy's left edge → second copy's left edge,
 *  including the copy gap). Same pace as qt-notice-bar: 40 rect-px/s, one cycle at least 3000ms.
 *  Returns 0 for invalid distances so callers can retry instead of animating garbage. */
export function marqueeLoopDuration(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  return Math.max(3000, Math.round(distance / 40 * 1000));
}
