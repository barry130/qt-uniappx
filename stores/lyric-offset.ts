/**
 * 歌词偏移（全局默认 + 按曲目覆盖）
 *
 * 与 qt-pc 同口径（`qt-pc/src-tauri/src/db/store/lyrics.rs` 的 MAX_OFFSET_MS /
 * clamp_offset、`hooks/useLyricOffset.ts`）：
 * - 单位毫秒，范围 ±10s，越界夹回边界；
 * - 正数 = 歌词延后出现（判定用 `progress - offset`，与 PC `PlayingPage.tsx:99-100`
 *   的 `findActiveIndex(lines, position - lyricOffset.offsetMs)` 一致）；
 * - 「按曲目保存」优先于全局默认；某曲目没设过就用全局值。
 *
 * 存储：单键 `qt-lyric-offset`，值是一份 JSON：
 *   { "global": 0, "songs": { "wyy:12345": 500 } }
 * 移动端无 SQLite（见 stores/dislikes.ts 头部说明），所以用 KV 而不是 PC 的
 * `lyric_settings` 表。
 *
 * 注意：这里**只负责偏移数值**，不碰歌词解析。偏移要加在「取当前行」的入参上
 * （`activeLyricIndex(lines, progress - offsetSec)`），绝不能改歌词行的
 * time 字段——PC 侧的注释写得很清楚，改数据会让拖动进度条时的高亮对不上。
 */

import { reactive } from "vue";
import type { Song } from "@/types/music";

/** 单曲 / 全局偏移上限（毫秒），与 PC 的 MAX_OFFSET_MS 一致 */
export const LYRIC_OFFSET_MAX_MS = 10000;
/** 步进粒度（毫秒）：UI 上的 ±100ms 按钮 */
export const LYRIC_OFFSET_STEP_MS = 100;

const LYRIC_OFFSET_KEY = "qt-lyric-offset";

type OffsetPayload = {
  global: number;
  songs: Record<string, number>;
};

/** 曲目键：跨源不通的 id 不能单独用（同 stores/dislikes.ts 的教训），必须带 platform */
export function lyricOffsetSongKey(song: Song | null): string {
  if (song == null) return "";
  return song.platform + ":" + song.id;
}

/** 夹到 ±LYRIC_OFFSET_MAX_MS 的整数毫秒；非数字一律归 0 */
function clampOffset(value: number): number {
  if (!(value >= -LYRIC_OFFSET_MAX_MS) && !(value <= LYRIC_OFFSET_MAX_MS)) return 0;
  let v = Math.round(value);
  if (!(v >= -LYRIC_OFFSET_MAX_MS)) v = -LYRIC_OFFSET_MAX_MS;
  if (v > LYRIC_OFFSET_MAX_MS) v = LYRIC_OFFSET_MAX_MS;
  return v;
}

class LyricOffsetStore {
  /** 全局默认偏移（毫秒） */
  globalMs: number = 0;
  /** 按曲目覆盖：key = platform:id */
  songs: Record<string, number> = {};
  /** 当前编辑上下文对应的曲目键（空串 = 只改全局） */
  activeKey: string = "";

  restore(): void {
    try {
      const raw = uni.getStorageSync(LYRIC_OFFSET_KEY) as string;
      if (raw == null || raw.length == 0) return;
      const obj = JSON.parse(raw) as OffsetPayload;
      if (obj == null) return;
      if (obj.global != null) this.globalMs = clampOffset(obj.global);
      const next: Record<string, number> = {};
      const songs = obj.songs;
      if (songs != null) {
        const keys = Object.keys(songs);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const value = songs[key];
          if (key == null || key.length == 0) continue;
          const clamped = clampOffset(value);
          // 归 0 的覆盖没有意义：留着只会让「恢复默认」多一步
          if (clamped != 0) next[key] = clamped;
        }
      }
      this.songs = next;
    } catch (_) {
      this.globalMs = 0;
      this.songs = {};
    }
  }

  private save(): void {
    try {
      // 全程普通 JS 对象：UTSJSONObject 在 bytecode 运行时是原生注册实例，
      // 曲目覆盖一多就整批建实例（player.ts 的 buildLikeOpBodyJson 注释记过
      // 「UTS instance is not registered」的事故）。这里只有几十条，但没必要冒风险。
      const obj: any = {};
      obj["global"] = this.globalMs;
      const songs: any = {};
      const keys = Object.keys(this.songs);
      for (let i = 0; i < keys.length; i++) {
        songs[keys[i]] = this.songs[keys[i]];
      }
      obj["songs"] = songs;
      uni.setStorageSync(LYRIC_OFFSET_KEY, JSON.stringify(obj));
    } catch (_) {}
  }

  /** 某曲目的生效偏移（毫秒）：有按曲目覆盖用覆盖值，否则用全局值 */
  offsetMsFor(song: Song | null): number {
    const key = lyricOffsetSongKey(song);
    if (key.length > 0) {
      const own = this.songs[key];
      if (own != null) return own;
    }
    return this.globalMs;
  }

  /** 生效偏移（秒）：给 activeLyricIndex / seek 换算用 */
  offsetSecFor(song: Song | null): number {
    return this.offsetMsFor(song) / 1000;
  }

  /** 该曲目是否已有独立覆盖（管理页用它区分「继承全局」与「本曲已设」） */
  hasSongOverride(song: Song | null): boolean {
    const key = lyricOffsetSongKey(song);
    if (key.length == 0) return false;
    return this.songs[key] != null;
  }

  /**
   * 设置当前编辑上下文的曲目。空串 = 编辑全局默认。
   * 页面 onShow 时调一次，切歌时再调一次。
   */
  setActive(song: Song | null): void {
    this.activeKey = lyricOffsetSongKey(song);
  }

  /** 当前编辑上下文下的值（毫秒） */
  activeMs(): number {
    if (this.activeKey.length == 0) return this.globalMs;
    const own = this.songs[this.activeKey];
    return own != null ? own : this.globalMs;
  }

  /** 写当前编辑上下文的值：空 key 写全局，否则写该曲目覆盖 */
  setActiveMs(ms: number): void {
    const clamped = clampOffset(ms);
    if (this.activeKey.length == 0) {
      this.globalMs = clamped;
    } else {
      if (clamped == 0) {
        // 归零 = 回到继承全局，删掉覆盖而不是存一个 0
        const next: Record<string, number> = {};
        const keys = Object.keys(this.songs);
        for (let i = 0; i < keys.length; i++) {
          if (keys[i] != this.activeKey) next[keys[i]] = this.songs[keys[i]];
        }
        this.songs = next;
      } else {
        const next: Record<string, number> = {};
        const keys = Object.keys(this.songs);
        for (let i = 0; i < keys.length; i++) next[keys[i]] = this.songs[keys[i]];
        next[this.activeKey] = clamped;
        this.songs = next;
      }
    }
    this.save();
  }

  /** 按步进调整（UI 的 ±100ms 按钮） */
  nudgeActive(deltaMs: number): number {
    const next = clampOffset(this.activeMs() + deltaMs);
    this.setActiveMs(next);
    return next;
  }

  /** 恢复默认：当前上下文归 0 */
  resetActive(): void {
    this.setActiveMs(0);
  }

  /** 全量复位（「清除全部缓存与数据」用） */
  reset(): void {
    this.globalMs = 0;
    this.songs = {};
    this.activeKey = "";
  }
}

const lyricOffset = reactive(new LyricOffsetStore()) as LyricOffsetStore;

export function useLyricOffsetStore(): LyricOffsetStore {
  return lyricOffset;
}
