/**
 * 底部居中轻提示 store（QT UI 库）。
 *
 * 全项目的临时提示统一从这里进入，由 `qt-toast-host` 在屏幕**底部水平居中**渲染；
 * 页面、业务 store 与原生服务都不再直接调用平台原生 Toast，保证位置、颜色和停留
 * 行为一致。对外出口是 `services/toast.uts` 的 `qtShowToast()`。
 *
 * 这里**不缓存任何业务状态**，只放「刚发生的事」这类一句话文案；也不做合并去重 ——
 * 连着两次操作就是上下叠两条，各自计时。
 *
 * 生命周期也放在这里（push 即排两个定时器：到点先置 leaving 淡出、再移除），
 * 宿主组件 `qt-toast-host` 只负责渲染，避免每个宿主各维护一份定时器表。
 */
import { reactive } from "vue";

/** success = 动作成功回执（绿勾）；info = 中性提示；error = 出错（红字，停得更久） */
export type QtToastKind = "success" | "info" | "error";

export type QtToastItem = {
  id: number;
  text: string;
  kind: QtToastKind;
  /** 已进入淡出阶段：宿主把整条设成透明，淡完再移除 */
  leaving: boolean;
};

/** 同时最多叠几条：再多也会在几秒内刷掉，留着只是糊住屏幕底部 */
const QT_TOAST_MAX_ITEMS = 4;

/** 停留时长与淡出时长：普通/成功 3 秒，错误 6 秒（同 qt-pc 的 STAY_MS）。 */
const QT_TOAST_DURATION_MS = 3000;
const QT_TOAST_ERROR_DURATION_MS = 6000;
const QT_TOAST_FADE_MS = 180;

let seq = 0;

const state = reactive({
  items: [] as QtToastItem[],
});

/** 当前待显示的提示（宿主组件直接绑定它渲染） */
export function qtToastItems(): QtToastItem[] {
  return state.items;
}

function removeById(id: number): void {
  for (let i = 0; i < state.items.length; i++) {
    if (state.items[i].id == id) {
      state.items.splice(i, 1);
      return;
    }
  }
}

function markLeaving(id: number): void {
  for (let i = 0; i < state.items.length; i++) {
    if (state.items[i].id == id) {
      state.items[i].leaving = true;
      return;
    }
  }
}

function push(text: string, kind: QtToastKind): void {
  if (text.length == 0) return;
  seq += 1;
  const id = seq;
  state.items.push({ id: id, text: text, kind: kind, leaving: false });
  if (state.items.length > QT_TOAST_MAX_ITEMS) {
    state.items.splice(0, state.items.length - QT_TOAST_MAX_ITEMS);
  }
  const stayMs = kind == "error" ? QT_TOAST_ERROR_DURATION_MS : QT_TOAST_DURATION_MS;
  // 先透明再卸载，别让它“啪”地消失。被挤出上限的条子这两个回调自然变成空操作。
  setTimeout(() => markLeaving(id), stayMs);
  setTimeout(() => removeById(id), stayMs + QT_TOAST_FADE_MS);
}

/**
 * 按 kind 塞一条（字符串形态，给 `services/toast.uts` 这类跨语言出口用）。
 * 非法 kind 一律按普通档处理，不抛错 —— 提示本身不该成为新的失败点。
 */
export function qtShowToastByKind(text: string, kind: string): void {
  let k: QtToastKind = "info";
  if (kind == "success") {
    k = "success";
  } else if (kind == "error") {
    k = "error";
  }
  push(text, k);
}

/** 塞一条中性轻提示。事件回调、异步流程里直接调即可：`qtToast("已复制播放地址")` */
export function qtToast(text: string): void {
  push(text, "info");
}

/** 动作成功的回执（绿勾）：`qtToastSuccess("已收藏 3 首到「歌单名」")` */
export function qtToastSuccess(text: string): void {
  push(text, "success");
}

/**
 * 出错版（红字、停 6 秒）。需要用户动手处理的错误仍应写在页面里 —— 浮层几秒就走，
 * 只适合「知道一下就行」的那些。
 */
export function qtToastError(text: string): void {
  push(text, "error");
}
