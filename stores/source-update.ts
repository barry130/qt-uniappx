import { reactive } from "vue";
import { hasSourceUpdateBadge, SOURCE_UPDATE_BADGE_EVENT } from "@/services/source-update";
import { activePack } from "@/services/source-bundle-fs";
import { PLAY_PACK_MISSING_EVENT } from "@/services/source-engine";

/**
 * 音源包状态的响应式镜像（两件事）：
 *   1. 「有可用更新」红点：更新发现（各包自管 updateUrl + astral manifest）拿到
 *      未应用的更新时置位；应用/卸载/拉黑后 services/source-update 广播
 *      SOURCE_UPDATE_BADGE_EVENT，这里统一接住刷新；供 QtTabBar / QtSideNav
 *      的「我的」项与设置页「音源包」行、我的页「设置」行绑定。
 *   2. 「未安装播放音源包」：数据包（搜索/歌单/歌词）内置基线开箱可用，但播放包
 *      不内置（版权风险，用户自行安装）——没有**生效中的播放包**时在线取链
 *      不可用，首页据此显示引导入口（本地音乐播放不受影响）。
 *
 * refresh() 依赖本地状态已从磁盘恢复：调用方先 await ensureLocalStateRestored()，
 * 否则可能读到空状态、把「已安装」误报成「未安装」。
 */
class SourceUpdateStore {
  updatePending = false;
  /** 没有生效中的播放音源包（在线播放不可用；搜索等数据功能不受影响） */
  sourceMissing = false;

  refresh(): void {
    this.updatePending = hasSourceUpdateBadge();
    this.sourceMissing = activePack() == null;
  }
}

const sourceUpdateStore = reactive(new SourceUpdateStore()) as SourceUpdateStore;

try {
  uni.$on(SOURCE_UPDATE_BADGE_EVENT, () => {
    sourceUpdateStore.refresh();
  });
  // 引擎在「要取链但没有生效播放包」时也会广播（见 source-engine 的节流逻辑），
  // 这里一并接住：用户在设置页装好并启用后，首页引导条即时消失
  uni.$on(PLAY_PACK_MISSING_EVENT, () => {
    sourceUpdateStore.refresh();
  });
} catch (_) {}

export function useSourceUpdateStore(): SourceUpdateStore {
  return sourceUpdateStore;
}
