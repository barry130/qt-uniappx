import { reactive } from "vue";
import { logWarn } from "@/services/logger";

export type QtMiniPlayerMode = "expandable" | "ball" | "bar" | "docked";
export const QT_MINI_PLAYER_MODES: { id: QtMiniPlayerMode; name: string; description: string }[] = [
  { id: "expandable", name: "悬浮球展开", description: "点击悬浮球展开长条，再点击进入播放页" },
  { id: "ball", name: "仅悬浮球", description: "始终显示悬浮球，点击进入播放页" },
  { id: "bar", name: "仅悬浮长条", description: "始终显示悬浮长条，点击进入播放页" },
  { id: "docked", name: "固定播放栏", description: "固定在底部导航上方，点击进入播放页" },
];
const STORAGE_KEY = "qt-mini-player-mode";

export function qtNormalizeMiniPlayerMode(value: string): QtMiniPlayerMode {
  if (value == "ball" || value == "bar" || value == "docked") return value;
  return "expandable";
}

// UI preference, shared by every page instance; restore before the first render.
function readMode(): QtMiniPlayerMode {
  try {
    return qtNormalizeMiniPlayerMode(uni.getStorageSync(STORAGE_KEY) as string);
  } catch (_) {
    return "expandable";
  }
}
const state = reactive({ mode: readMode() });
export function useMiniPlayerSettings() { return state; }

export function setMiniPlayerMode(value: string): void {
  state.mode = qtNormalizeMiniPlayerMode(value);
  try {
    uni.setStorageSync(STORAGE_KEY, state.mode);
  } catch (_) {
    logWarn("MiniPlayer", "播放器模式保存失败（本次已生效）");
  }
}
