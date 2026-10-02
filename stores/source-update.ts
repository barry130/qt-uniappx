import { reactive } from "vue";
import { hasSourceUpdateBadge, SOURCE_UPDATE_BADGE_EVENT } from "@/services/source-update";
import { activePack, activeMetaPack } from "@/services/source-bundle-fs";
import { PLAY_PACK_MISSING_EVENT } from "@/services/source-engine";

/**
 * 音源包状态的响应式镜像（三件事）：
 *   1. 「有可用更新」红点：更新发现（各包自管 updateUrl + astral manifest，仅对
 *      已装包提示）拿到未应用的更新时置位；应用/卸载/拉黑后
 *      services/source-update 广播 SOURCE_UPDATE_BADGE_EVENT，这里统一接住刷新；
 *      供 QtTabBar / QtSideNav 的「我的」项与设置页「音源包」行、我的页「设置」行绑定。
 *   2. 「未安装播放音源包」：播放包不内置（版权风险，用户自行安装）——没有
 *      **生效中的播放包**时在线取链不可用，首页据此显示引导条（本地音乐播放
 *      不受影响）。
 *   3. 「未安装数据包」：数据包同样不内置——没有生效中的数据包时在线搜索/
 *      歌单/歌词不可用，首页据此显示全屏引导（指路设置页，不带下载动作）。
 *
 * refresh() 依赖本地状态已从磁盘恢复：调用方先 await ensureLocalStateRestored()，
 * 否则可能读到空状态、把「已安装」误报成「未安装」。
 */
class SourceUpdateStore {
  updatePending = false;
  /** 没有生效中的播放音源包（在线播放不可用；数据功能是否可用取决于 metaMissing） */
  sourceMissing = false;
  /**
   * 没有生效中的数据包：在线搜索/歌单/歌词不可用，且在线播放同样不可用
   * （播放包注入走数据包的 installPlayPack 入口）；本地音乐不受影响。
   */
  metaMissing = false;

  refresh(): void {
    this.updatePending = hasSourceUpdateBadge();
    this.sourceMissing = activePack() == null;
    this.metaMissing = activeMetaPack() == null;
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
