import type { Song } from "@/types/music";
import { songFromJson, songToJson } from "@/stores/persist-codec";

const KEY = "qt-song-source-choice-v1";
const REVISION_KEY = KEY + ":revision";
type Entry = { key: string; song: Song };
let cachedRevision: string | null = null;
let cachedEntries: Entry[] = [];
let cachedIndex = new Map<string, Song>();
function keyOf(song: Song): string { return song.platform + ":" + song.id; }
function clean(song: Song): Song {
  return { id: song.id, platform: song.platform, name: song.name, singer: song.singer, album: song.album, picUrl: song.picUrl, duration: song.duration, musicId: song.musicId };
}
function publishCache(entries: Entry[], revision: string): void {
  cachedEntries = entries;
  cachedIndex = new Map<string, Song>();
  for (const entry of entries) cachedIndex.set(entry.key, entry.song);
  cachedRevision = revision;
}
function read(): Entry[] {
  try {
    const storedRevision = uni.getStorageSync(REVISION_KEY) as string;
    const revision = storedRevision != null ? storedRevision : "";
    if (cachedRevision != null && revision == cachedRevision) return cachedEntries;
    const raw = uni.getStorageSync(KEY) as string;
    if (raw == null || raw.length == 0) {
      publishCache([], revision);
      return [];
    }
    const rows = JSON.parse(raw) as string[];
    if (!Array.isArray(rows)) { publishCache([], revision); return []; }
    const out: Entry[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (typeof row != "string") continue;
      const sep = row.indexOf("\n");
      if (sep <= 0) continue;
      const song = songFromJson(row.substring(sep + 1));
      if (song != null && song.id != null && song.id.length > 0 && song.platform != null && song.platform.length > 0 && song.platform != "local" && song.platform != "podcast") out.push({ key: row.substring(0, sep), song: clean(song) });
    }
    publishCache(out, revision);
    return out;
  } catch (_) { return cachedEntries; }
}
/** 偏好是长期用户数据，不按播放缓存容量淘汰；不持久化临时 URL 或收藏归属。 */
export function savePreferredSource(original: Song, candidate: Song): void {
  if (candidate.id.length == 0 || candidate.platform.length == 0 || candidate.platform == "local" || candidate.platform == "podcast") throw new Error("这个音源不能保存为播放偏好");
  const song = clean(candidate);
  const from = keyOf(original), to = keyOf(song);
  const entries = read();
  const previous = entries.find((entry: Entry): boolean => entry.key == from);
  const family = previous != null ? keyOf(previous.song) : from;
  const next: Entry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.key == from || entry.key == to) continue;
    const destination = keyOf(entry.song);
    next.push({ key: entry.key, song: destination == from || destination == family ? song : entry.song });
  }
  next.push({ key: from, song });
  if (to != from) next.push({ key: to, song });
  const rows: string[] = [];
  for (let i = 0; i < next.length; i++) rows.push(next[i].key + "\n" + songToJson(next[i].song));
  uni.setStorageSync(KEY, JSON.stringify(rows));
  const revision = Date.now().toString() + ":" + Math.random().toString();
  // 主记录已成功保存；修订号只用于其他上下文的缓存失效，写失败不能误报偏好丢失。
  try {
    uni.setStorageSync(REVISION_KEY, revision);
    publishCache(next, revision);
  } catch (_) {
    publishCache(next, cachedRevision != null ? cachedRevision : "");
  }
}
export function preferredSource(song: Song): Song | null {
  if (song.platform == "local" || song.platform == "podcast") return null;
  read();
  const key = keyOf(song), target = cachedIndex.get(key);
  return target != null && keyOf(target) != key ? clean(target) : null;
}
