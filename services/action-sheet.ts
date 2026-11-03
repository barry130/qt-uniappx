/**
 * Application action-sheet service. QtActionSheetHost owns rendering;
 * selection is selectedIndex, never a check/current-use suffix or a custom color.
 * Calls capture a list snapshot. Replacing, cancelling or passing an empty list
 * settles the previous Promise with -1 and clears its visible state.
 */
import { ref } from "vue";
import { qtSelectionIndex } from "@/uni_modules/qt-ui/composables/selection";

export interface QtActionSheetOptions {
  itemList: string[];
  title?: string;
  /** -1 means no selection. Unknown/out-of-range indices remain unselected. */
  selectedIndex?: number;
  /** Non-selection action colors (e.g. destructive actions); selected red wins. */
  colors?: (string | null)[];
}
const visible = ref(false);
const items = ref<string[]>([]);
const title = ref("");
const selectedIndex = ref(-1);
const colors = ref<(string | null)[]>([]);
const requestId = ref(0);
let resolver: ((index: number) => void) | null = null;

function settleActionSheet(index: number): void {
  const settle = resolver;
  resolver = null;
  visible.value = false;
  items.value = [];
  title.value = "";
  selectedIndex.value = -1;
  colors.value = [];
  if (settle != null) settle(index);
}

export function qtShowActionSheet(options: QtActionSheetOptions): Promise<number> {
  settleActionSheet(-1);
  const list = options.itemList != null ? options.itemList.slice() : [];
  if (list.length == 0) return Promise.resolve(-1);
  items.value = list;
  title.value = options.title != null ? options.title : "";
  selectedIndex.value = qtSelectionIndex(options.selectedIndex != null ? options.selectedIndex : -1, list.length);
  colors.value = options.colors != null ? options.colors.slice() : [];
  requestId.value += 1;
  visible.value = true;
  return new Promise<number>((resolve) => { resolver = resolve; });
}

/** Close and settle only a valid item; stale/invalid native indices cancel safely. */
export function qtActionSheetPick(index: number): void {
  if (!visible.value) return;
  settleActionSheet(qtSelectionIndex(index, items.value.length));
}

export function qtActionSheetCancel(): void { settleActionSheet(-1); }

/** Request identity restarts native reveal even for two consecutive identical lists. */
export function qtActionSheetState() {
  return { visible, items, title, selectedIndex, colors, requestId };
}
