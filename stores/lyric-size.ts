/**
 * 歌词字号（全站唯一来源）
 *
 * 为什么单独开一个 store 而不是塞进 pages/player：字号是**用户偏好**，
 * 播放页、沉浸式逐行视图（qt-focus-lyrics）以及后续任何歌词落点都要用同一档；
 * 页面内 ref 一旦被页面重建（切歌/返回再进）就会丢，用户每次都要重调。
 *
 * 口径与 stores/lyric-offset.ts 一致：
 * - 内存态是 reactive 单例，持久化在 KV 单键 `qt-lyric-size`；
 * - 值的语义是**倍率**而不是绝对字号：播放页的字号本身要跟
 *   `fontScale.scale`（系统/应用字号缩放）与宽屏 px / 竖屏 rpx 两套基准相乘，
 *   存倍率才能让三种缩放叠加而不互相覆盖；
 * - 倍率取 0.1 的整数档（70%~130%，默认 100%），避免出现 103% 这种没法复现的值。
 *
 * 注意：这里**只管字号倍率**，不碰行高与间距。歌词行高由
 * `pages/player/index.uvue` 的 `.lyric-line` padding 与 `qt-focus-lyrics` 的
 * 定行布局各自维护；倍率一变行高实际就变，所以播放页必须作废旧的行高缓存并重测
 * （几何 watcher 已带 lyricSize.scale），否则滚动与边缘渐隐会按旧行高算，后半首整屏错位。
 */

import { reactive } from "vue";
import { logWarn } from "@/services/logger";

/** 最小倍率（70%）：再小长句在窄屏会挤成一团 */
export const LYRIC_SIZE_MIN = 0.7;
/** 最大倍率（130%）：再大逐行歌词一屏只剩两行，失去跟唱价值 */
export const LYRIC_SIZE_MAX = 1.3;
/** 单次调整幅度（10%） */
export const LYRIC_SIZE_STEP = 0.1;
/** 默认倍率（100%）＝与历史版本完全一致 */
export const LYRIC_SIZE_DEFAULT = 1.0;

const LYRIC_SIZE_KEY = "qt-lyric-size";

/** 夹到 [MIN, MAX] 并按 0.1 档取整；非数字/非正数一律回默认 */
function clampScale(value: number): number {
  if (!(value > 0)) return LYRIC_SIZE_DEFAULT;
  // 先量化再夹：0.1 的浮点累加会漂成 1.0999999，显示成 109% 就露馅了
  const stepped = Math.round(value * 10) / 10;
  if (stepped < LYRIC_SIZE_MIN) return LYRIC_SIZE_MIN;
  if (stepped > LYRIC_SIZE_MAX) return LYRIC_SIZE_MAX;
  return stepped;
}

class LyricSizeStore {
  /** 当前字号倍率（1.0 = 默认） */
  scale: number = LYRIC_SIZE_DEFAULT;

  restore(): void {
    try {
      const raw = uni.getStorageSync(LYRIC_SIZE_KEY) as string;
      if (raw == null || raw.length == 0) return;
      const value = parseFloat(raw);
      this.scale = clampScale(value);
    } catch (_) {
      this.scale = LYRIC_SIZE_DEFAULT;
    }
  }

  private save(): void {
    try {
      // 存纯文本而不是 JSON：只有一个数字，解析失败的路径越少越好
      uni.setStorageSync(LYRIC_SIZE_KEY, "" + this.scale);
    } catch (_) {
      logWarn("LyricSize", "歌词字号持久化失败（本次已生效，重启后回默认）");
    }
  }

  /** 是否非默认档（工具行按钮据此着色，和歌词偏移的 accent 提示同口径） */
  isCustom(): boolean {
    return this.scale != LYRIC_SIZE_DEFAULT;
  }

  /** 百分比整数，用于「字号 110%」这类文案 */
  percent(): number {
    return Math.round(this.scale * 100);
  }

  /** 还能不能继续放大/缩小（按钮置灰用） */
  canGrow(): boolean {
    return this.scale < LYRIC_SIZE_MAX;
  }

  canShrink(): boolean {
    return this.scale > LYRIC_SIZE_MIN;
  }

  /** 直接设倍率（弹层里的档位按钮）；返回生效值 */
  setScale(value: number): number {
    this.scale = clampScale(value);
    this.save();
    return this.scale;
  }

  /** 按步进调整；返回生效值 */
  nudge(delta: number): number {
    return this.setScale(this.scale + delta);
  }

  /** 回到默认档 */
  reset(): number {
    return this.setScale(LYRIC_SIZE_DEFAULT);
  }

  /** 全量复位（「清除全部缓存与数据」用）：内存与持久化一起清 */
  resetAll(): void {
    this.scale = LYRIC_SIZE_DEFAULT;
    try {
      uni.removeStorageSync(LYRIC_SIZE_KEY);
    } catch (_) {
      logWarn("LyricSize", "清除持久化失败（内存已复位，重启后可能复活，可再次清除）");
    }
  }
}

const lyricSize = reactive(new LyricSizeStore()) as LyricSizeStore;

export function useLyricSizeStore(): LyricSizeStore {
  return lyricSize;
}
