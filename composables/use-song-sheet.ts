/**
 * 统一的歌曲更多菜单（qt-action-sheet）逻辑
 * 供每日推荐 / 歌单详情 / 排行榜详情 / 搜索 / 歌手等页面复用，
 * 避免每个页面重复维护 sheet 状态与动作处理。
 */
import { ref, computed } from "vue";
import type { Song } from "@/types/music";
import { usePlayerStore } from "@/stores/player";
import { useShareCardStore } from "@/stores/share-card";
import { useDownloadsStore } from "@/stores/downloads";
import { useDislikesStore } from "@/stores/dislikes";
import { useThemeStore } from "@/uni_modules/qt-ui/stores/theme";
import type { SheetAction } from "@/uni_modules/qt-ui/components/qt-action-sheet/qt-action-sheet.uvue";

export function useSongSheet() {
  const player = usePlayerStore();
  const shareCard = useShareCardStore();
  const downloads = useDownloadsStore();
  const dislikes = useDislikesStore();
  const theme = useThemeStore();

  const sheetSong = ref<Song | null>(null);
  const sheetVisible = ref(false);

  const sheetActions = computed<SheetAction[]>(() => {
    const song = sheetSong.value;
    if (song == null) return [];
    const liked = player.isLiked(song);
    const downloaded = downloads.has(song);
    // 屏蔽按钮显隐：歌曲按钮看 hasSongRule（不含歌手规则——歌手规则命中的歌，
    // 取歌按钮必须独立于歌手按钮可单独解除）；歌手按钮只在串非空时给
    const songBanned = dislikes.hasSongRule(song);
    const hasSinger = song.singer != null && song.singer.length > 0;
    const singerBanned = hasSinger && dislikes.hasSingerRule(song.singer);
    const actions: SheetAction[] = [
      { name: "下一首播放" },
      { name: liked ? "取消收藏" : "加入歌单", color: liked ? theme.skin.danger : undefined },
      { name: "加入播放队列" },
      {
        name: downloaded ? "已在下载列表" : "下载到本地",
        disabled: downloaded,
      },
      { name: "分享" },
      { name: "查看歌手" },
      {
        name: songBanned ? "取消屏蔽这首歌" : "屏蔽这首歌",
        color: songBanned ? theme.skin.accent : undefined,
      },
    ];
    if (hasSinger) {
      actions.push({
        name: singerBanned ? "取消屏蔽该歌手" : "屏蔽该歌手",
        color: singerBanned ? theme.skin.accent : undefined,
      });
    }
    return actions;
  });

  function openSheet(song: Song): void {
    sheetSong.value = song;
    sheetVisible.value = true;
  }

  function onSheetSelect(_action: SheetAction, index: number): void {
    const song = sheetSong.value;
    if (song == null) return;
    if (index == 0) {
      player.playNext(song);
    } else if (index == 1) {
      player.showPlaylistPickerFor(song);
    } else if (index == 2) {
      player.addToQueue(song);
    } else if (index == 3) {
      if (!downloads.has(song)) {
        downloads.download(song);
      }
    } else if (index == 4) {
      shareCard.open(song);
    } else if (index == 5) {
      uni.navigateTo({
        url:
          "/pages/artist/index?name=" +
          encodeURIComponent(song.singer) +
          "&platform=" +
          song.platform,
      });
    } else if (index == 6) {
      const songBanned = dislikes.hasSongRule(song);
      if (songBanned) {
        dislikes.unbanSong(song);
        uni.showToast({ title: "已取消屏蔽", icon: "none" });
      } else if (dislikes.banSong(song)) {
        uni.showToast({ title: "已屏蔽，不再自动播放", icon: "none" });
      } else {
        uni.showToast({ title: "这首歌无法按歌名屏蔽", icon: "none" });
      }
    } else if (index == 7) {
      const singer = song.singer != null ? song.singer : "";
      if (singer.length == 0) return;
      if (dislikes.hasSingerRule(singer)) {
        dislikes.unbanSinger(singer);
        uni.showToast({ title: "已取消屏蔽该歌手", icon: "none" });
      } else {
        dislikes.banSinger(singer);
        uni.showToast({ title: "已屏蔽该歌手", icon: "none" });
      }
    }
  }

  function sheetTitle(): string {
    const song = sheetSong.value;
    if (song == null) return "";
    return song.name + " - " + song.singer;
  }

  return { sheetVisible, sheetActions, openSheet, onSheetSelect, sheetTitle };
}
