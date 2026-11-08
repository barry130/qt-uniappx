import type { Song } from "@/types/music";
import { platformLabel } from "@/services/platform";
import { compareCollectMatch, prepareCollectMatch } from "./collect-match";

export type CollectDupConflict = {
  playlistId: string;
  playlistName: string;
  dups: Song[];
};

/** 跨音源收藏候选，与 qt-pc 同步按歌名、歌手、专辑相似度提示，由用户选版本。 */
export function findCrossSourceDup(song: Song, existing: Song[]): Song[] {
  const out: Song[] = [];
  if (song == null || existing == null) return out;
  const wanted = prepareCollectMatch(song.name, song.singer, song.album);
  for (const item of existing) {
    if (item == null || item.platform === song.platform) continue;
    if (compareCollectMatch(wanted, prepareCollectMatch(item.name, item.singer, item.album)).matches) out.push(item);
  }
  return out;
}

/**
 * 冲突提示文案（弹出确认框的 content）。
 *
 * 举例：「「我喜欢的歌曲」里已经有 1 首同名的网易云版本（周杰伦），仍要收藏？」
 * 只给一处冲突时把歌手也带上，帮用户确认是不是同一首；多处冲突只报数量，
 * 免得文案长到看不完。
 */
export function collectDupMessage(playlistName: string, dups: Song[]): string {
  if (dups.length == 0) return "";
  const first = dups[0];
  const from = platformLabel(first.platform);
  if (dups.length == 1 && first.singer.length > 0) {
    return "「" + playlistName + "」里已经有一首同名的" + from + "版本（" + first.singer + "），仍要收藏？";
  }
  if (dups.length == 1) {
    return "「" + playlistName + "」里已经有一首同名的" + from + "版本，仍要收藏？";
  }
  return "「" + playlistName + "」里已经有 " + dups.length + " 首同名歌曲（其他音源），仍要收藏？";
}
