import { reactive, inject, getCurrentInstance, onUnmounted } from "vue";
import { createQtTvNavigation } from "./qt-tv-navigation";
import type { QtTvScope } from "./qt-tv-navigation";
import { QT_TV_TOKENS } from "./qt-tv-tokens";
import { applyQtTvLayout } from "./use-qt-layout";
import { setQtTvFontPresentation } from "../stores/font-scale";
import { tvReadDevice, tvStartRemote, tvSetRemoteState, tvStopRemote, tvCollect, tvHighlight, tvActivate, tvScroll, tvPresent, tvBack } from "@/services/tv-platform";
import type { QtTvRemoteEvent } from "@/services/tv-platform";
import { qtTopRoute } from "./qt-page-chrome";
import { qtWideToolActive, qtWideToolHostRoute, qtWideToolRoute } from "./qt-wide-workspace";

export type QtTvMode = "auto" | "tv" | "touch";
export type QtTvOwner = { active: () => boolean };
const STORAGE_KEY = "qt-tv-presentation";
const state = reactive({ enabled: false, detected: false, nativeAvailable: false, mode: "auto" as QtTvMode, foreground: true, focusedId: "" });
const navigation = createQtTvNavigation({
  collect: tvCollect,
  highlight: (id: string): void => { state.focusedId = id; tvHighlight(id, QT_TV_TOKENS.focusColor); },
  activate: tvActivate,
  scroll: tvScroll,
  back: tvBack,
  now: (): number => Date.now(),
});
type Handler = { id: number; owner: QtTvOwner | null; active: (() => boolean) | null; callback: (key: string, repeat: number) => boolean };
let handlers: Handler[] = [];
let handlerSequence = 1;
let initialized = false;
let pollingTimer = 0;

export function useQtTv() { return state; }
export function qtTvTokens() { return QT_TV_TOKENS; }
export function qtTvFocusedId(): string { return state.focusedId; }
export function qtTvFocus(id: string): boolean { return navigation.focus(id); }
export function qtTvHasModal(): boolean { return navigation.modalActive(); }
export function qtTvRefreshFocus(): void { if (state.enabled && state.foreground) navigation.refresh(); }

function syncRemote(): void {
  tvSetRemoteState({ enabled: state.enabled && state.foreground, captureBack: true, captureMenu: true, editing: false });
}
function updatePolling(): void {
  if (pollingTimer != 0) { clearInterval(pollingTimer); pollingTimer = 0; }
  if (state.enabled && state.foreground && state.nativeAvailable) {
    // One controller for the visible root, not one timer per row. This also discovers async/recycled items.
    pollingTimer = setInterval((): void => { qtTvRefreshFocus(); }, 220) as unknown as number;
  }
}
function syncMode(): void {
  const device = tvReadDevice();
  state.detected = device.television || device.leanback;
  state.nativeAvailable = device.nativeAvailable;
  state.enabled = state.mode == "tv" || (state.mode == "auto" && state.detected);
  applyQtTvLayout(state.enabled);
  setQtTvFontPresentation(state.enabled);
  tvPresent(state.enabled);
  navigation.setEnabled(state.enabled && state.foreground);
  syncRemote();
  updatePolling();
}
export function qtInitTv(): void {
  if (initialized) return;
  initialized = true;
  try {
    const saved = uni.getStorageSync(STORAGE_KEY) as string;
    if (saved == "tv" || saved == "touch") state.mode = saved as QtTvMode;
  } catch (_) { /* 静默：偏好存储不可用时沿用自动检测 */ }
  tvStartRemote((event: QtTvRemoteEvent): void => { qtTvDispatchRemote(event); });
  syncMode();
}
export function qtSetTvMode(mode: string): void {
  state.mode = mode == "tv" ? "tv" : mode == "touch" ? "touch" : "auto";
  try { uni.setStorageSync(STORAGE_KEY, state.mode); } catch (_) { /* 静默：偏好保存失败不阻断本次模式切换 */ }
  if (!initialized) qtInitTv();
  else syncMode();
}
export function qtSetTvForeground(foreground: boolean): void {
  state.foreground = foreground;
  if (!initialized) qtInitTv();
  if (foreground) syncMode();
  else { navigation.setEnabled(false); syncRemote(); updatePolling(); }
}
export function qtDisposeTv(): void {
  if (pollingTimer != 0) clearInterval(pollingTimer);
  pollingTimer = 0;
  navigation.setEnabled(false);
  tvStopRemote();
  tvPresent(false);
  initialized = false;
}

/** Called only from the async bridge; native consumption never depends on this boolean. */
export function qtTvDispatchRemote(event: QtTvRemoteEvent): boolean {
  if (!state.enabled || !state.foreground || event.action != "down") return false;
  const key = event.key;
  if (key != "up" && key != "down" && key != "left" && key != "right" && key != "ok" && key != "back" && key != "menu") return false;
  if ((key == "ok" || key == "back" || key == "menu") && event.repeat > 0) return true;
  // Highest modal contains focus and Back even when it is busy/non-dismissible.
  if (navigation.modalActive()) return navigation.dispatch(event);
  for (let i = handlers.length - 1; i >= 0; i--) {
    const handler = handlers[i];
    if (handler.owner == null || !handler.owner.active()) continue;
    if (handler.active != null && !handler.active()) continue;
    if (handler.callback(key, event.repeat)) return true;
  }
  return navigation.dispatch(event);
}
export function qtTvRegisterScope(scope: QtTvScope): () => void {
  const token = navigation.pushScope(scope);
  return (): void => { navigation.removeScope(token); };
}

/** Registers with the nearest visible page/workspace owner; inactive and unmounted pages never handle keys. */
export function useQtTvRemote(handler: (key: string, repeat: number) => boolean, active?: () => boolean): () => void {
  const injectedOwner = inject<QtTvOwner | null>("qt-tv-owner", null);
  // A business page is the parent of its frame, so it cannot inject the child's provider.
  // Capture this mounted page/workspace identity instead of following a later tab's route.
  const mountedTop = qtTopRoute();
  const mountedTool = qtWideToolActive() && qtWideToolHostRoute() == mountedTop ? qtWideToolRoute() : "";
  const owner: QtTvOwner | null = injectedOwner ?? (getCurrentInstance() != null ? {
    active: (): boolean => qtTopRoute() == mountedTop && (mountedTool.length > 0
      ? qtWideToolActive() && qtWideToolHostRoute() == mountedTop && qtWideToolRoute() == mountedTool
      : !(qtWideToolActive() && qtWideToolHostRoute() == mountedTop)),
  } : null);
  const id = handlerSequence++;
  handlers.push({ id, owner, active: active ?? null, callback: handler });
  let disposed = false;
  const dispose = (): void => { if (disposed) return; disposed = true; handlers = handlers.filter((entry): boolean => entry.id != id); };
  if (getCurrentInstance() != null) onUnmounted(dispose);
  return dispose;
}
