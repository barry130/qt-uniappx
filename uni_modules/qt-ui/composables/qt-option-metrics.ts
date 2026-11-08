import { useQtLayout, qtRpx } from "@/uni_modules/qt-ui/composables/use-qt-layout";
import { fontScale } from "@/uni_modules/qt-ui/stores/font-scale";

/** Label-only chip border-box width in logical px, matching QtOption typography and padding.
 * Read the live window/font state so a page's computed rows reflow on both changes.
 * Leading/default slots need their own additional width; fixed-grid labels can use ellipsis.
 */
export function qtOptionChipWidthPx(label: string, singleLine: boolean = false): number {
  const layout = useQtLayout();
  const unit = layout.isWide ? 1 : qtRpx(1);
  const font = (layout.isWide ? 15 : 28 * unit) * fontScale.scale;
  const padding = layout.isWide ? 14 : 24 * unit;
  const border = unit;
  let units = 0;
  for (let i = 0; i < label.length; i++) {
    const ch = label.charAt(i);
    // Conservative Latin width covers uppercase category names (ACG/R&B), not just average letters.
    const glyph = label.charCodeAt(i) > 127 || ch == "W" || ch == "M" ? 1 : 0.7;
    // No-wrap source tabs reserve semibold/OEM font variation from their very first frame.
    // In particular a selected Q is wider than the old 0.7em Latin estimate.
    units += singleLine ? Math.max(glyph, 0.85) * 1.06 : glyph;
  }
  return Math.ceil(units * font + padding * 2 + border * 2 + 2);
}

/** A font-scaled single-line chip cannot be squeezed below its line box by a page height. */
export function qtOptionChipMinHeightPx(): number {
  const layout = useQtLayout();
  const unit = layout.isWide ? 1 : qtRpx(1);
  const font = (layout.isWide ? 15 : 28 * unit) * fontScale.scale;
  const paddingY = layout.isWide ? 6 : 12 * unit;
  const border = unit;
  const minimum = layout.isWide ? 36 : 64 * unit;
  return Math.ceil(Math.max(minimum, font * 1.35 + paddingY * 2 + border * 2));
}

export type QtChipCell = { id: string; name: string; width: number };

/** Content-sized, ordered rows for compact previews and scrollable chip panels. */
export function qtOptionChipRows(items: { id: string; name: string }[], available: number, gap: number): QtChipCell[][] {
  const width = Math.max(1, available);
  const rows: QtChipCell[][] = [];
  let row: QtChipCell[] = [];
  let used = 0;
  for (const item of items) {
    const cell = { id: item.id, name: item.name, width: Math.min(width, qtOptionChipWidthPx(item.name)) };
    const next = used + (row.length > 0 ? gap : 0) + cell.width;
    if (row.length > 0 && next > width) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += (row.length > 0 ? gap : 0) + cell.width;
    row.push(cell);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}
