import { ref, watch, nextTick, onMounted, onUnmounted, type Ref } from "vue";
import { useQtLayout } from "@/uni_modules/qt-ui/composables/use-qt-layout";
import { fontScale } from "@/uni_modules/qt-ui/stores/font-scale";

let nextScope = 0;
export type QtSelectionReveal = {
  anchor: Ref<string>;
  itemId: (index: number) => string;
};

/** Native scroll-into-view, scoped per instance; works for initial and asynchronous lists. */
export function useQtSelectionReveal(
  visible: () => boolean,
  selectedIndex: () => number,
  contentKey: () => string,
): QtSelectionReveal {
  nextScope += 1;
  const prefix = "qt-selection-" + nextScope + "-";
  const anchor = ref("");
  const layout = useQtLayout();
  let mounted = false;
  let disposed = false;
  let generation = 0;
  let timer = 0;

  function itemId(index: number): string { return prefix + index; }
  function cancel(): void {
    generation += 1;
    if (timer != 0) { clearTimeout(timer); timer = 0; }
    anchor.value = "";
  }
  function reveal(): void {
    cancel();
    if (!mounted || disposed || !visible() || selectedIndex() < 0) return;
    const token = generation;
    const target = itemId(selectedIndex());
    nextTick(() => {
      if (disposed || token != generation || !visible()) return;
      // Wait for the native scroll-view to lay out, not just the Vue render flush.
      timer = setTimeout(() => {
        if (disposed || token != generation || !visible()) return;
        timer = 0;
        anchor.value = target;
      }, 32) as number;
    });
  }
  watch((): string => String(visible()) + ":" + selectedIndex() + ":" + contentKey() + ":" + layout.sizeEpoch + ":" + fontScale.scale,
    (): void => reveal(), { immediate: true });
  onMounted((): void => { mounted = true; reveal(); });
  onUnmounted((): void => { disposed = true; mounted = false; cancel(); });
  return { anchor, itemId };
}
