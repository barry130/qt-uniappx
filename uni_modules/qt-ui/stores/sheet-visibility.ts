/**
 * 底部弹层可见计数 store（QT UI 库）。
 *
 * 所有 `QtSheet`（含 `QtActionSheet`、播放来源面板、收藏保留选择等包装组件）
 * 打开/关闭时在这里登记/注销。用途：qt-page-frame 挂的迷你播放栏渲染在框架层、
 * z 序高于页面内容，弹层打开时会浮在弹窗之上（2026-11-13 用户截图）——
 * 计数大于 0 期间迷你播放栏整体隐藏。
 *
 * 用计数而不是布尔：同一页面可以并存多个 sheet 状态（页面自带一个 + 框架宿主
 * 一个），必须等全部关闭才恢复播放栏，否则先关的那个会把另一个弹窗的遮罩
 * 重新戳出一个播放条。
 */
import { ref } from "vue";

/** 当前打开的 QtSheet 数量（只在 qt-sheet 组件里增减，别处只读）。 */
const openCount = ref(0);

/** 一个弹层从不可见变为可见时登记。 */
export function qtSheetOverlayOpen(): void {
  openCount.value += 1;
}

/** 一个登记过的弹层关闭（或宿主卸载）时注销；重复注销有下界保护。 */
export function qtSheetOverlayClose(): void {
  if (openCount.value > 0) openCount.value -= 1;
}

/** 读取计数；大于 0 表示有底部弹层打开。 */
export function qtSheetOverlayCount() {
  return openCount;
}
