/**
 * 批量操作的业务出口（批量下载 / 批量收藏 / 批量取消收藏）。
 *
 * 与 PC `qt-pc/src/components/discovery/BatchBar.tsx` 同口径，理由也照抄：
 *
 * - **批量下载**走 `downloads.enqueueMany`（逐首 silent 入队，回执统一出一条）。
 *   不提高并发：音源 CDN 按 IP 限流，短时间发几十条取址连接会被当爬虫
 *   （PC 侧同一条判断，设置页的 downloadConcurrency 默认也 ≤3），
 *   enqueueMany 本身也仍走 store 的并发闸门。本地曲目没有播放地址可取，
 *   先剔掉再入队。
 * - **批量收藏**走 `player.importSongsToPlaylist`：已在目标歌单里的自动跳过，
 *   只加缺的那些，且 persist / saveLikeSync 各只做一次（逐首调是 O(N²) 次全量存储写）。
 * - **取消收藏**不是独立按钮：整批都已经在那个歌单里（全勾）时，再点一次那行
 *   就是批量取消收藏，和单曲红心「点一下加、再点一下取消」完全一样；
 *   走 `player.removeSongsFromPlaylist`（同样是批量的存储写）。
 *   批量语境下用户指的一定是「从这个歌单里去掉」，跨歌单连坐交给单曲红心。
 * - 加入前查「同名不同源」（`player.collectDupIn` → services/collect-dup.ts，
 *   与 PC 同口径）：有冲突先弹一次确认，确认了才写。收藏表按 (platform,id) 唯一，
 *   两首同名的能共存，界面上就是重复两行 —— 加之前提示比加完再删轻松得多。
 *
 * 回执**一律走 `qtToast`**（右上角浮层，3 秒自动消失），绝不写进页头那一行：
 * 文案长短会把右边的按钮推来推去，页头宽度一变整个标题也跟着抖（用户 m09470）。
 */
import { usePlayerStore } from "@/stores/player";
import { useDownloadsStore } from "@/stores/downloads";
import type { Playlist, Song } from "@/types/music";
import { collectDupMessage } from "@/services/collect-dup";
import { qtSongKey } from "@/uni_modules/qt-ui/composables/use-batch-select";
import { qtToast, qtToastError } from "@/uni_modules/qt-ui/stores/toast";
import { qtConfirm } from "@/services/confirm";

/** 本地曲目（拷贝/扫描进来的文件）没有播放地址，也不该被下载 */
const LOCAL_PLATFORM = "local";

export function useBatchActions() {
  const player = usePlayerStore();
  const downloads = useDownloadsStore();

  /**
   * 批量下载。回执分三种：全已在队列 / 部分新入队 / 全部新入队 ——
   * 说清「加了几首、跳过了几首」，用户才知道自己那 50 首为什么只动了 12 首。
   */
  function batchDownload(songs: Song[]): void {
    const remote: Song[] = [];
    let localCount = 0;
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      if (song == null) continue;
      if (song.platform == LOCAL_PLATFORM) localCount++;
      else remote.push(song);
    }
    if (remote.length == 0) {
      qtToastError("选中的歌曲都在本地，无需下载");
      return;
    }
    const localTail = localCount > 0 ? "，" + localCount + " 首本地歌曲已跳过" : "";
    const result = downloads.enqueueMany(remote);
    if (result.added == 0) {
      qtToast("选中的 " + remote.length + " 首已在下载列表" + localTail);
      return;
    }
    if (result.skipped > 0) {
      qtToast("已加入下载队列 " + result.added + " 首，其余 " + result.skipped + " 首已在列表" + localTail);
      return;
    }
    qtToast("已加入下载队列 " + result.added + " 首" + localTail);
  }

  /** 这批歌里有几首已经在这个歌单里（面板勾选态与「该加还是该删」都看它） */
  function memberCount(playlistId: string, songs: Song[]): number {
    let hit = 0;
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      if (song == null) continue;
      if (player.pickerSelectedIds(song).indexOf(playlistId) >= 0) hit++;
    }
    return hit;
  }

  /** 整批都已在里面 → 该歌单在面板里显示为「已勾」（再点一次就是批量取消收藏） */
  function isFullyCollected(playlistId: string, songs: Song[]): boolean {
    return songs.length > 0 && memberCount(playlistId, songs) == songs.length;
  }

  /** 这批歌里还没进这个歌单的那些（真正的待加入集合） */
  function pendingAdds(playlistId: string, songs: Song[]): Song[] {
    const out: Song[] = [];
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      if (song == null) continue;
      if (player.pickerSelectedIds(song).indexOf(playlistId) < 0) out.push(song);
    }
    return out;
  }

  /** 这批歌在该歌单里命中到的「同名不同源」冲突曲目（去重后交给确认框） */
  function dupSongsIn(playlistId: string, adds: Song[]): Song[] {
    const out: Song[] = [];
    for (let i = 0; i < adds.length; i++) {
      const dups = player.collectDupIn(adds[i], playlistId);
      for (let j = 0; j < dups.length; j++) {
        const dup = dups[j];
        const key = qtSongKey(dup);
        let seen = false;
        for (let k = 0; k < out.length; k++) {
          if (qtSongKey(out[k]) == key) {
            seen = true;
            break;
          }
        }
        if (!seen) out.push(dup);
      }
    }
    return out;
  }

  function addToPlaylist(playlist: Playlist, adds: Song[]): void {
    const added = player.importSongsToPlaylist(adds, playlist.id);
    const skipped = adds.length - added;
    if (added == 0) {
      qtToast("这 " + adds.length + " 首都已经在「" + playlist.name + "」里了");
      return;
    }
    if (skipped > 0) {
      qtToast("已收藏 " + added + " 首到「" + playlist.name + "」，其余 " + skipped + " 首已在里面");
      return;
    }
    qtToast("已收藏 " + added + " 首到「" + playlist.name + "」");
  }

  function removeFromPlaylist(playlist: Playlist, songs: Song[]): void {
    const removed = player.removeSongsFromPlaylist(songs, playlist.id);
    if (removed == 0) {
      qtToast("「" + playlist.name + "」里没有这批歌");
      return;
    }
    qtToast("已从「" + playlist.name + "」取消收藏 " + removed + " 首");
  }

  /**
   * 面板里点一行歌单：整批都已在里面 → 批量取消收藏；否则批量收藏（只加缺的那些）。
   * 有同名不同源冲突时先弹一次确认。
   *
   * @param onChanged 改动落到宿主歌单（歌单详情页自己的那个本地歌单）后重拉列表用；
   *                  在线歌单 / 每日新歌不归本地歌单管，传空即可。
   */
  function toggleCollect(playlist: Playlist, songs: Song[], onChanged?: () => void): void {
    if (songs.length == 0) return;
    if (isFullyCollected(playlist.id, songs)) {
      removeFromPlaylist(playlist, songs);
      if (onChanged != null) onChanged();
      return;
    }
    const adds = pendingAdds(playlist.id, songs);
    if (adds.length == 0) {
      // 走到这里说明选中集合是空的（上面已挡），保底不留静默失败
      qtToast("没有需要新增的歌曲");
      return;
    }
    const dups = dupSongsIn(playlist.id, adds);
    if (dups.length == 0) {
      addToPlaylist(playlist, adds);
      if (onChanged != null) onChanged();
      return;
    }
    qtConfirm({
      title: "同名歌曲提示",
      content: collectDupMessage(playlist.name, dups),
      confirmText: "继续收藏",
      cancelText: "取消",
    }).then((ok) => {
      if (!ok) return;
      addToPlaylist(playlist, adds);
      if (onChanged != null) onChanged();
    });
  }

  /**
   * 批量收藏到新建歌单（面板底部的「新建」）。歌单一个都没有时这是唯一出路 ——
   * 收藏不能脱离歌单（Rust / 后端侧没 pid 直接报参数错误）。
   */
  function createAndCollect(songs: Song[], name: string): boolean {
    const trimmed = name.trim();
    if (trimmed.length == 0) {
      qtToastError("歌单名称不能为空");
      return false;
    }
    if (songs.length == 0) return false;
    const created = player.createLocalPlaylist(trimmed);
    if (created == null) {
      qtToastError("已有同名歌单");
      return false;
    }
    const added = player.importSongsToPlaylist(songs, created.id);
    qtToast("已新建「" + created.name + "」并收藏 " + added + " 首");
    return true;
  }

  return {
    batchDownload,
    memberCount,
    isFullyCollected,
    pendingAdds,
    dupSongsIn,
    toggleCollect,
    createAndCollect,
  };
}