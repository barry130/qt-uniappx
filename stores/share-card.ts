import { reactive } from "vue";
import type { Song } from "@/types/music";

/**
 * 分享卡片状态：歌曲菜单/播放页的「分享」入口把目标歌挂进来后跳独立页面，
 * 页面侧读取 store.song 渲染卡片（歌曲卡片 / 歌词卡片两种模式）。
 * 不走 URL 传参：Song 对象字段多，且歌词模式还要按歌曲取词。
 */
class ShareCardStore {
  /** 待分享的目标歌曲 */
  song: Song | null = null;

  /** 打开分享卡片页（song 为空时忽略，避免跳到空页） */
  open(song: Song | null): void {
    if (song == null) return;
    this.song = song;
    uni.navigateTo({
      url: "/pages/share-card/index",
    });
  }
}

const shareCard = reactive(new ShareCardStore()) as ShareCardStore;

export function useShareCardStore(): ShareCardStore {
  return shareCard;
}
