export type QtFold = { left: number; top: number; right: number; bottom: number; separating: boolean; tabletop: boolean };
export type QtPane = { left: number; top: number; width: number; height: number };

/** Use a complete unobstructed pane. Never infer a physical hinge from orientation. */
export function qtSafePane(width: number, height: number, fold: QtFold | null): QtPane {
  const full: QtPane = { left: 0, top: 0, width, height };
  if (fold == null || !fold.separating) return full;
  const l = Math.max(0, Math.min(width, fold.left)), r = Math.max(l, Math.min(width, fold.right));
  const t = Math.max(0, Math.min(height, fold.top)), b = Math.max(t, Math.min(height, fold.bottom));
  if (t <= 1 && b >= height - 1 && l > 0 && r < width) {
    return l >= width - r ? { left: 0, top: 0, width: l, height } : { left: r, top: 0, width: width - r, height };
  }
  if (l <= 1 && r >= width - 1 && t > 0 && b < height) {
    return fold.tabletop || t >= height - b ? { left: 0, top: 0, width, height: t } : { left: 0, top: b, width, height: height - b };
  }
  return full;
}
