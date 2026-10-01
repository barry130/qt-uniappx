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
import { useThemeStore } from "@/uni_modules/qt-ui/stores/theme";
import type { SheetAction } from "@/uni_modules/qt-ui/components/qt-action-sheet/qt-action-sheet.uvue";

export function useSongSheet() {
  const player = usePlayerStore();
  const shareCard = useShareCardStore();
  const downloads = useDownloadsStore();
  const theme = useThemeStore();

  const sheetSong = ref<Song | null>(null);
  const sheetVisible = ref(false);

  const sheetActions = computed<SheetAction[]>(() => {
    const song = sheetSong.value;
    if (song == null) return [];
    const liked = player.isLiked(song);
    const downloaded = downloads.has(song);
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
    ];
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
    }
  }

  function sheetTitle(): string {
    const song = sheetSong.value;
    if (song == null) return "";
    return song.name + " - " + song.singer;
  }

  return { sheetVisible, sheetActions, openSheet, onSheetSelect, sheetTitle };
}
