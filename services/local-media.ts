import type { Song } from "@/types/music";
import { readEmbeddedTags, statLocalFile } from "@/uni_modules/qt-app-native";
import type { EmbeddedReadResult } from "@/uni_modules/qt-app-native";
import { localFileFor } from "@/services/local-first";

const tags = new Map<string, EmbeddedReadResult>();
const pending = new Map<string, Promise<EmbeddedReadResult | null>>();
const rejected = new Map<string, string>();
export function rejectLocalMedia(song: Song, path: string): void {
  const key = song.platform + ":" + song.id;
  if (rejected.size >= 128) rejected.clear();
  rejected.set(key, path);
  tags.delete(path);
}

/** 播放页、桌面歌词、车载歌词共用一次本地查找和标签读取，再决定是否联网。 */
export async function readSongEmbedded(song: Song): Promise<EmbeddedReadResult | null> {
  const path = await localFileFor(song, rejected.get(song.platform + ":" + song.id) ?? "");
  if (path == null) return null;
  const cached = tags.get(path);
  if (cached != null && (cached.coverPath.length == 0 || statLocalFile(cached.coverPath) >= 0)) return cached;
  const running = pending.get(path);
  if (running != null) return running;
  const task = new Promise<EmbeddedReadResult | null>((resolve) => {
    // 音频命令先下发，标签 IO 下一拍执行。
    setTimeout((): void => {
      let result: EmbeddedReadResult | null = null;
      try { result = readEmbeddedTags(path); } catch (_) {
        // 静默：无标签/读失败时允许联网补齐资源。
      }
      if (result != null) {
        if (tags.size >= 24) tags.clear();
        tags.set(path, result);
      }
      resolve(result);
    }, 0);
  });
  pending.set(path, task);
  try { return await task; } finally { pending.delete(path); }
}
