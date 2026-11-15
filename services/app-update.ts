/**
 * 应用更新弹窗的全局状态（qt-upgrade-popup 的调用口）。
 *
 * 为什么升级弹窗要脱离页面挂到框架层：
 * 升级弹窗此前挂在页面模板里（首页 / 关于页），而页面模板整体位于
 * qt-page-frame 的 `.qt-page-frame-shell` 内。shell 自己带 z-index:2，
 * 在 uni-app x 里那就是一个**层叠上下文**——遮罩写 z-index:999 也只是在
 * shell 内部排到最前，出不去。而播放条（z-index:940）、mini-player（998）、
 * tab-bar（900）都是 shell 的**兄弟节点**，于是必然画在遮罩上方：
 *  · 遮罩底部「直接下载」按钮被播放条压住，点击落到播放条 → 跳进播放页；
 *  · 「我的」tab 仍露在遮罩外，强制更新时还能点走。
 * 两个现象同一个根因。修法沿用仓内已有三次先例（qt-confirm-host /
 * qt-action-sheet-host / qt-pack-install-sheet / qt-first-run-disclaimer）：
 * 服务持全局状态 + 框架层挂一个宿主组件，浮层与底部栏同层，层级才真正生效。
 *
 * 弹窗不再由页面 `v-model:visible` 驱动：页面/服务只需 publishAppUpdate(info)，
 * 关闭时宿主回调 dismissAppUpdate()。首页原有的「公告 → 升级」排队时序
 * 仍然留在页面里（它要读公告状态），只是最后一步从「打开本地 ref」改成 publish。
 */
import { ref } from "vue";
import type { AppUpdateInfo } from "@/services/upgrade";

const visible = ref(false);
const info = ref<AppUpdateInfo | null>(null);

/** 发布一个待展示的更新。可见期间不替换任何版本，避免下载仍用旧 info 而界面已显示新版本。 */
export function publishAppUpdate(next: AppUpdateInfo): void {
  if (visible.value) return;
  info.value = next;
  visible.value = true;
}

/** 宿主组件关闭后收口：清掉状态，允许下一次更新再次弹出 */
export function dismissAppUpdate(): void {
  visible.value = false;
  info.value = null;
}

/** 宿主组件读取状态用 */
export function appUpdateState() {
  return { visible, info };
}
