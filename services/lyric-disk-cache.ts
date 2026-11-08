/** 有界的跨启动歌词缓存；不保存临时播放 URL。 */
const PREFIX = "qt-media-lyric-";
const INDEX = "qt-media-lyric-index";
const LIMIT = 512;

function keys(): string[] {
  try {
    const raw = uni.getStorageSync(INDEX) as string;
    return raw != null && raw.length > 0 ? raw.split("\n") : [];
  } catch (_) { return []; }
}
export function readLyricDisk(key: string): string {
  try {
    const text = uni.getStorageSync(PREFIX + key) as string;
    return text != null ? text : "";
  } catch (_) { return ""; }
}
export function writeLyricDisk(key: string, value: string): void {
  if (value.length == 0 || value.length > 262144) return;
  try {
    const next = keys().filter((k: string): boolean => k != key);
    next.push(key);
    while (next.length > LIMIT) uni.removeStorageSync(PREFIX + next.shift()!);
    uni.setStorageSync(INDEX, next.join("\n"));
    uni.setStorageSync(PREFIX + key, value);
  } catch (_) {
    // 静默：缓存写失败不影响当前歌词。
  }
}
export function removeLyricDisk(key: string): void {
  try { uni.removeStorageSync(PREFIX + key); } catch (_) {
    // 静默：换词源时尽力移除旧缓存。
  }
}
export function clearLyricDisk(): void {
  const list = keys();
  for (let i = 0; i < list.length; i++) removeLyricDisk(list[i]);
  try { uni.removeStorageSync(INDEX); } catch (_) {
    // 静默：下次清理可继续尝试。
  }
}
