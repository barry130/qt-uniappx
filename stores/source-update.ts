import { reactive } from "vue";
import { hasSourceUpdateBadge, SOURCE_UPDATE_BADGE_EVENT } from "@/services/source-update";
import { installedPackage } from "@/services/source-bundle-fs";

/**
 * 音源包状态的响应式镜像（两件事）：
 *   1. 「有新音源包」红点：真正的判定在 services/source-update.uts（非响应式单例），
 *      启动静默检查下载到新包、设置页「立即应用/卸载」后都会 uni.$emit 广播，
 *      这里统一接住刷新；供 QtTabBar / QtSideNav 的「我的」项与设置页「音源包」行、
 *      我的页「设置」行绑定。
 *   2. 「未安装音源包」：仓库不内置音源包，未安装时在线取链不可用，
 *      首页据此显示引导入口（本地音乐不受影响）。
 *
 * refresh() 依赖本地状态已从磁盘恢复：调用方先 await ensureLocalStateRestored()，
 * 否则可能读到空状态、把「已安装」误报成「未安装」。
 */
class SourceUpdateStore {
  updatePending = false;
  /** 本机没有已安装的音源包（在线播放不可用） */
  sourceMissing = false;

  refresh(): void {
    this.updatePending = hasSourceUpdateBadge();
    this.sourceMissing = installedPackage() == null;
  }
}

const sourceUpdateStore = reactive(new SourceUpdateStore()) as SourceUpdateStore;

try {
  uni.$on(SOURCE_UPDATE_BADGE_EVENT, () => {
    sourceUpdateStore.refresh();
  });
} catch (_) {}

export function useSourceUpdateStore(): SourceUpdateStore {
  return sourceUpdateStore;
}
