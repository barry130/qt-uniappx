/** Selection is a stable red semantic, independent of a skin's action/accent color. */
export const QT_SELECTION_LIGHT = "#d93c43";
export const QT_SELECTION_DARK = "#ff7378";

export function qtSelectionColor(dark: boolean): string {
  return dark ? QT_SELECTION_DARK : QT_SELECTION_LIGHT;
}

/** Invalid selections must not silently highlight/scroll to the first option. */
export function qtSelectionIndex(index: number, count: number): number {
  if (!Number.isFinite(count) || count < 0 || Math.floor(count) != count || !Number.isFinite(index) || index < 0 || index >= count || Math.floor(index) != index) return -1;
  return index;
}

/** Shared horizontal reveal math; keep the entire selected item inside the viewport. */
export function qtSelectionScrollOffset(start: number, end: number, viewport: number, current: number, content: number): number {
  if (!Number.isFinite(viewport) || !Number.isFinite(content) || viewport <= 0 || content <= 0) return 0;
  const max = Math.max(0, content - viewport);
  let next = Math.min(max, Math.max(0, Number.isFinite(current) ? current : 0));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return next;
  if (end - start > viewport) next = start;
  else if (start < next) next = start;
  else if (end > next + viewport) next = end - viewport;
  return Math.min(max, Math.max(0, next));
}
