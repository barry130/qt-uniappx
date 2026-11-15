import { inject, onUnmounted, watch } from "vue";
import type { Ref } from "vue";
import { qtTvRegisterScope, qtTvRefreshFocus } from "./use-qt-tv";
import type { QtTvOwner } from "./use-qt-tv";
import { qtTopRoute } from "./qt-page-chrome";
import { qtWideToolActive, qtWideToolHostRoute, qtWideToolRoute } from "./qt-wide-workspace";

/** Scope is the actual panel, not its no-op mask. Closing returns to the previous business identity. */
export function useQtTvModal(element: Ref<UniElement | null>, visible: () => boolean, onBack: () => void, priority: number = 999): void {
  const inherited = inject<QtTvOwner | null>("qt-tv-owner", null);
  const topAtMount = qtTopRoute();
  const toolAtMount = qtWideToolActive() && qtWideToolHostRoute() == topAtMount ? qtWideToolRoute() : "";
  const active = (): boolean => visible() && (inherited != null ? inherited.active()
    : qtTopRoute() == topAtMount && (toolAtMount.length > 0
      ? qtWideToolHostRoute() == topAtMount && qtWideToolRoute() == toolAtMount
      : !(qtWideToolActive() && qtWideToolHostRoute() == topAtMount)));
  let dispose: (() => void) | null = null;
  watch(visible, (open: boolean): void => {
    if (dispose != null) { dispose(); dispose = null; }
    if (open) dispose = qtTvRegisterScope({ root: null, getRoot: (): UniElement | null => element.value, active, modal: true, priority, onBack });
    qtTvRefreshFocus();
  }, { immediate: true });
  onUnmounted((): void => { if (dispose != null) dispose(); dispose = null; });
}
