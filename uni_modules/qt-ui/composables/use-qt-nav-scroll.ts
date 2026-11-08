import { ref, watch, nextTick, onMounted, onUnmounted, type Ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { useQtLayout } from "./use-qt-layout";
import { qtSelectionScrollOffset } from "./selection";
import { fontScale } from "../stores/font-scale";
import { qtWideWorkspaceRefreshTick } from "./qt-wide-workspace";

// One session position across fixed tab rails and the workspace's docked rail.
// Do not keep hidden native ScrollViews mounted just to retain their position.
let savedTop = 0;
let nextScope = 0;

/** Navigation keeps visible entries in place; offscreen entries move only into view. */
export function useQtNavScroll(
  root: Ref<UniElement | null>,
  active: () => boolean,
  selectedIndex: () => number,
  contentKey: () => string,
) {
  const layout = useQtLayout();
  const top = ref(savedTop);
  let actualTop = savedTop;
  const prefix = "qt-nav-" + (++nextScope) + "-";
  let mounted = false;
  let ready = false;
  let generation = 0;
  let timer = 0;

  function itemId(index: number): string { return prefix + index; }
  function cancel(): void {
    generation++;
    if (timer != 0) { clearTimeout(timer); timer = 0; }
  }
  function measure(token: number, attempt: number): void {
    if (!mounted || token != generation || !active()) return;
    const element = root.value;
    const viewport = element != null ? element.querySelector(".qsn-scroll") : null;
    const content = element != null ? element.querySelector(".qsn-tools") : null;
    const viewportRect = viewport != null ? viewport.getBoundingClientRect() : null;
    const contentRect = content != null ? content.getBoundingClientRect() : null;
    if (viewportRect == null || contentRect == null || viewportRect.height <= 0 || contentRect.height <= 0) {
      if (attempt < 3) {
        timer = setTimeout(() => { timer = 0; measure(token, attempt + 1); }, 80) as number;
      }
      return;
    }
    const index = selectedIndex();
    const target = index >= 0 && element != null ? element.querySelector("#" + itemId(index)) : null;
    const targetRect = target != null ? target.getBoundingClientRect() : null;
    // Subtract content coordinates, not a potentially delayed @scroll receipt.
    const start = targetRect != null ? targetRect.top - contentRect.top : NaN;
    const end = targetRect != null ? targetRect.bottom - contentRect.top : NaN;
    const offset = qtSelectionScrollOffset(start, end, viewportRect.height, savedTop, contentRect.height);
    top.value = offset;
    savedTop = offset;
    ready = true;
  }
  function restore(): void {
    cancel();
    ready = false;
    if (!mounted || !active()) return;
    const token = generation;
    // Rebase the command to the actual position so a later command with the
    // same old numeric value still reaches native after the user has dragged.
    top.value = actualTop;
    nextTick(() => {
      if (!mounted || token != generation || !active()) return;
      // Native geometry settles after Vue has committed the new rail/content.
      timer = setTimeout(() => { timer = 0; measure(token, 0); }, 32) as number;
    });
  }
  function onScroll(event: any): void {
    if (!mounted || !active() || event.detail == null) return;
    const value = Number(event.detail.scrollTop);
    if (!Number.isFinite(value)) return;
    actualTop = Math.max(0, value);
    // Mount/layout can report a temporary zero before the saved offset applies.
    // Do not echo each gesture receipt into scroll-top: native treats that as a
    // fresh programmatic scroll and interrupts the finger/inertial movement.
    if (ready) savedTop = actualTop;
  }

  watch((): string => String(active()) + ":" + selectedIndex() + ":" + contentKey()
    + ":" + layout.sizeEpoch + ":" + layout.safeBottomPx + ":" + fontScale.scale
    + ":" + qtWideWorkspaceRefreshTick(), restore);
  onMounted(() => { mounted = true; restore(); });
  // Native tab/pages may be retained: returning must restore the latest session position.
  onShow(restore);
  onUnmounted(() => { mounted = false; ready = false; cancel(); });
  return { top, itemId, onScroll };
}
