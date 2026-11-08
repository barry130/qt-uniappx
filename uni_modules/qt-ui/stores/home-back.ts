import { reactive } from "vue";
import { logWarn } from "@/services/logger";

export type QtHomeBackMode = "background" | "double-exit";
export const QT_HOME_BACK_OPTIONS: { id: QtHomeBackMode; name: string; summary: string }[] = [
  { id: "background", name: "返回一次回到后台", summary: "回到后台" },
  { id: "double-exit", name: "返回两次退出 APP", summary: "两次退出" },
];
const STORAGE_KEY = "qt-home-back-mode";

export function qtNormalizeHomeBackMode(value: string): QtHomeBackMode {
  return value == "background" ? "background" : "double-exit";
}

// 首页与设置共用一个 UI 偏好，首帧同步恢复；未配置时保持原有两次退出行为。
function readMode(): QtHomeBackMode {
  try {
    return qtNormalizeHomeBackMode(uni.getStorageSync(STORAGE_KEY) as string);
  } catch (_) {
    return "double-exit";
  }
}
const state = reactive({ mode: readMode() });
export function useHomeBackSettings() { return state; }

export function setHomeBackMode(value: string): void {
  state.mode = qtNormalizeHomeBackMode(value);
  try {
    uni.setStorageSync(STORAGE_KEY, state.mode);
  } catch (_) {
    logWarn("HomeBack", "首页返回按键设置保存失败（本次已生效）");
  }
}
