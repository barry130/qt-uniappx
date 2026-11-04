/**
 * 私人 FM 的选曲逻辑（2026-11-03 移植自 qt-pc src/lib/radio-queue.ts）。
 *
 * ## 为什么不另写一套打分
 * `recommend-rank.ts` 已经把「口味画像 + 行为质量 + 歌手配额 + MMR 多样性」都算完了，
 * 每日推荐和 FM 的差别只在于**取多少**与**要不要去重历史**：
 * - 每日推荐一次出 50 首、同一天可复现；
 * - FM 每次补一小批（`RADIO_BATCH`），跨批次不重复、听一首补一首。
 * 所以这里只做「把池子按已排过的键剪一遍 → 交给引擎打分选择 → 按种子补一条同歌手车道」。
 *
 * ## 为什么跨批次去重要在本模块做
 * 引擎的 `historyKeys` 只是降权，池子深的时候压不住同一首歌反复冒头。FM 是
 * 「一直听下去」的形态，同一首歌在一轮里出现两次是硬伤，所以这里用 `usedKeys`
 * 做**硬排除**（交给 `rankCandidates` 的 `excludeKeys`，引擎连分都不给）。
 *
 * ## 种子（当前曲目 / 歌手）
 * 用户按「以这首歌为种子开始 FM」时，下一首却是别的歌手，主观上就是「没接上」，
 * 所以 `seedLane` 先把同专辑 / 同歌手的歌排在最前。
 *
 * ## 会话轮换（为什么不能只靠 variant）
 * `variant` 进引擎后只改抖动一项，而候选之间的分数差动辄十几分（收藏、同专辑、
 * 历史降权），MMR 又把分数归一化，抖动的影响被压到零点几分 —— 排在前面的十来首
 * 几乎不变。用户反馈「每次重新打开 FM 播放的歌曲全都一模一样」就是这个。所以这里
 * 改成**先从引擎取一个宽窗口，再在窗口里按会话种子换一批**：质量下限由窗口兜住，
 * 具体是哪几首、第一首是谁，每次会话都不一样。
 *
 * ## UTS 约束
 * - T = Song 具体化，不写泛型函数（同仓没有泛型工具函数的先例）；
 * - 洗牌不用 `Math.imul`（Android/iOS 两端都没有该内建），用 xorshift32 只做
 *   位运算，种子来自 `hashString`（与画像抖动同一套哈希，确定性且可测试）；
 * - 集合成员判定一律用键集合（`trackKey`），不依赖对象引用相等（跨端行为不一致）。
 */

import type { Song } from "@/types/music";
import { hashString } from "@/services/recommend-text";
import { deriveStyle } from "@/services/recommend-rank";
import { rankCandidates } from "@/services/daily-recommend";
import type { DailyPreference } from "@/services/daily-recommend";
import type { DailyTaste, TrackStyle } from "@/services/recommend-types";

/** 一次补多少首：太短会频繁补（每次都要重排），太长会让「不喜欢」的反馈滞后 */
export const RADIO_BATCH = 12;

/** 同一歌手在一批里最多几首 —— 与每日推荐的心动档一致 */
export const RADIO_MAX_PER_SINGER = 3;

/** 种子车道的容量：开头的同专辑 / 同歌手歌 */
export const RADIO_SEED_LANE = 3;

/** 播放器队列剩余多少首时开始补 */
export const RADIO_REFILL_THRESHOLD = 3;

/**
 * 会话轮换的候选窗口倍数：引擎先按「分数 + 配额 + MMR」挑出一个比 `count`
 * 宽得多的窗口，FM 再从窗口里换一批（见文件头「会话轮换」）。
 */
const ROTATION_WINDOW_FACTOR = 3;

/** 曲目键：`${platform}:${id}`（与推荐引擎同一口径） */
export function radioTrackKey(song: Song): string {
  return song.platform + ":" + song.id;
}

/** 同名键（歌名 + 歌手）：跨源同名同歌也算排过 */
export function radioNameKey(song: Song): string {
  return song.name + "\u0000" + song.singer;
}

export type RadioBatchInput = {
  /** 候选池（本地库 + 收藏 + 歌单 + 最近播放，调用方去重好） */
  pool: Song[];
  /** 收听偏好（loadPreference 的产物：画像 + 质量 + 收藏键都在里面） */
  pref: DailyPreference;
  /** 用户选的口味档 */
  taste: DailyTaste;
  /** 本轮 FM 已经排过的键（`radioTrackKey` / `radioNameKey` 都算） */
  usedKeys: Set<string>;
  /** 与 `pool` **同序**的屏蔽标记 */
  disliked: boolean[];
  count?: number;
  /** 会话 / 「换一批」的变体种子 */
  variant?: string;
  /**
   * 上一轮 FM 会话排过的键：够 `count` 首时整批避开它们，不够就退回整窗。
   * 引擎排序是确定性的，只换种子不足以让两次会话真正不同（见文件头「会话轮换」）。
   */
  avoidKeys?: string[];
};

function isUsed(song: Song, usedKeys: Set<string>): boolean {
  return usedKeys.has(radioTrackKey(song)) || usedKeys.has(radioNameKey(song));
}

/** xorshift32：确定性的 32 位位运算，够用来洗牌（不引第三方、不用 Math.imul） */
function xorshift32(seed: number): number {
  let x = seed;
  if (x == 0) x = 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

/** 洗牌（不改输入）：同一 seed 得到同一顺序，不同 seed 得到不同顺序 */
function seededShuffle(items: Song[], seed: number): Song[] {
  const out: Song[] = [];
  for (let i = 0; i < items.length; i++) out.push(items[i]);
  let state = seed == 0 ? 0x9e3779b9 : seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = xorshift32(state + i);
    const j = state % (i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * 从窗口里取 `count` 首，同时守住歌手 / 语种两个配额。
 *
 * 窗口是引擎按 `target = 窗口大小` 选出来的：配额递进放宽可能让窗口尾部出现超过
 * `RADIO_MAX_PER_SINGER` 首同歌手。窗口整体守规矩，但从中取子集也得自己再守一遍。
 * 第一趟严格守配额，取不满就第二趟只放开语种，最后放开歌手补齐 —— 池子太浅时
 * 宁可有歌可听，也不要因为配额卡着不出声。
 */
function pickWithinCaps(
  window: Song[],
  count: number,
  maxPerSinger: number,
  maxPerLang: number,
): Song[] {
  const out: Song[] = [];
  const picked = new Set<string>();
  const singers: Map<string, number> = new Map<string, number>();
  const langs: Map<string, number> = new Map<string, number>();
  // 「不限」用一个大整数哨兵，不用 Number.POSITIVE_INFINITY（UTS 各端内建面不同，避开）
  const CAP_NONE = 1000000;

  const takePass = (singerCap: number, langCap: number): void => {
    for (let i = 0; i < window.length; i++) {
      if (out.length >= count) return;
      const song = window[i];
      const key = radioTrackKey(song);
      if (picked.has(key)) continue;
      const style: TrackStyle = deriveStyle(song);
      const singerCount = singers.get(style.singerKey);
      if (
        style.singerKey.length > 0 &&
        singerCap < CAP_NONE &&
        singerCount != null &&
        singerCount >= singerCap
      ) continue;
      const langCount = langs.get(style.lang);
      if (
        style.lang != "und" &&
        langCap < CAP_NONE &&
        langCount != null &&
        langCount >= langCap
      ) continue;
      picked.add(key);
      out.push(song);
      if (style.singerKey.length > 0) {
        singers.set(style.singerKey, (singerCount != null ? singerCount : 0) + 1);
      }
      if (style.lang != "und") langs.set(style.lang, (langCount != null ? langCount : 0) + 1);
    }
  };

  takePass(maxPerSinger, maxPerLang);
  if (out.length < count) takePass(maxPerSinger, CAP_NONE);
  if (out.length < count) takePass(CAP_NONE, CAP_NONE);
  return out;
}

/** 相邻打散：轮换打乱了引擎排好的顺序，尽量别让同歌手的歌挨着（只调顺序，不动集合） */
function spreadAdjacentSinger(items: Song[]): Song[] {
  const out: Song[] = [];
  for (let i = 0; i < items.length; i++) out.push(items[i]);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 1; i < out.length; i++) {
      const key = deriveStyle(out[i]).singerKey;
      if (key.length == 0 || key != deriveStyle(out[i - 1]).singerKey) continue;
      let j = -1;
      for (let k = i + 1; k < out.length; k++) {
        if (deriveStyle(out[k]).singerKey == key) continue;
        // 换过来以后不能把「新位置的下一位」又弄成同歌手，否则等于没换
        if (k + 1 < out.length && deriveStyle(out[k + 1]).singerKey == key) continue;
        j = k;
        break;
      }
      if (j < 0) continue;
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
      changed = true;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * 从池子里挑出下一批。
 *
 * 返回值可能少于 `count`（池子被排空 / 全被屏蔽）——调用方要接受这个事实并停下来，
 * 而不是拿重复的歌把队列填满。
 */
export function buildRadioBatch(input: RadioBatchInput): Song[] {
  const rawCount = input.count != null ? (input.count as number) : RADIO_BATCH;
  const count = Math.max(0, Math.floor(rawCount));
  if (count == 0 || input.pool.length == 0) return [];

  // 窗口目标：先多打一些再让选择阶段砍到 count，MMR 的多样性要靠候选之间比较才成立
  const windowSize = Math.max(count, count * ROTATION_WINDOW_FACTOR);
  const seed = input.variant != null ? (input.variant as string) : "";
  const engine = rankCandidates(input.pool, input.pref, {
    excludeKeys: input.usedKeys,
    playedKeys: radioPlayedKeys(input.pref),
    dislikedFlags: input.disliked,
    target: windowSize,
    taste: input.taste,
    variant: seed,
  });
  if (engine.length == 0) return [];

  // 上一轮会话排过的歌优先让位：够 count 首才硬排除，不够就退回整窗（宁可能撞，也别没歌）
  const avoid = new Set<string>();
  const avoidList = input.avoidKeys != null ? (input.avoidKeys as string[]) : [];
  for (let i = 0; i < avoidList.length; i++) avoid.add(avoidList[i]);
  let usable: Song[] = engine;
  if (avoid.size > 0) {
    const fresh: Song[] = [];
    for (let i = 0; i < engine.length; i++) {
      if (!avoid.has(radioTrackKey(engine[i]))) fresh.push(engine[i]);
    }
    if (fresh.length >= count) usable = fresh;
  }

  // 会话轮换：没有种子（可复现用法）就保持引擎顺序取前 count 首
  const rotated = seed.length == 0 ? usable : seededShuffle(usable, hashString(seed));
  const picked = pickWithinCaps(
    rotated,
    count,
    RADIO_MAX_PER_SINGER,
    Math.max(2, Math.ceil(count * 0.6)),
  );
  return spreadAdjacentSinger(picked);
}

/** 与池子同序的屏蔽标记取不到时的兜底：全 false（宁可漏屏蔽一首，也不整批不出声） */
function radioPlayedKeys(pref: DailyPreference): Set<string> | null {
  const top = pref.topTracks;
  if (top == null) return null;
  const keys = new Set<string>();
  for (let i = 0; i < top.length; i++) keys.add(radioTrackKey(top[i].song));
  return keys;
}

/**
 * 种子车道：以当前曲目为种子时，先接上它的同歌手 / 同专辑。
 *
 * 只取 `lane` 首，且不放回池子里已排过的；不够就安静地少给，剩下的名额由常规批次补
 * —— 「接得顺」比「必须凑满 3 首同歌手」重要。
 */
export function seedLane(pool: Song[], seed: Song | null, lane = RADIO_SEED_LANE, usedKeys: Set<string> | null = null): Song[] {
  if (seed == null || lane <= 0) return [];
  const singer = seed.singer.trim();
  const album = seed.album.trim();
  const seedKey = radioTrackKey(seed);
  const sameAlbum: Song[] = [];
  const sameSinger: Song[] = [];
  for (let i = 0; i < pool.length; i++) {
    const song = pool[i];
    if (song == null || song.name.length == 0) continue;
    if (radioTrackKey(song) == seedKey) continue;
    if (usedKeys != null && isUsed(song, usedKeys)) continue;
    if (album.length > 0 && song.album.trim() == album) {
      sameAlbum.push(song);
    } else if (singer.length > 0 && song.singer.trim() == singer) {
      sameSinger.push(song);
    }
  }
  // 同专辑比同歌手更「近」，先排专辑里的其它歌
  const laneOut: Song[] = [];
  for (let i = 0; i < sameAlbum.length && laneOut.length < lane; i++) laneOut.push(sameAlbum[i]);
  for (let i = 0; i < sameSinger.length && laneOut.length < lane; i++) laneOut.push(sameSinger[i]);
  return laneOut;
}

/** 播放器队列快见底了：该补了 */
export function shouldRefill(remaining: number): boolean {
  return remaining <= RADIO_REFILL_THRESHOLD;
}

/** 把一批曲目里已经出现过的键收进 `usedKeys`（就地改，FM store 直接用） */
export function markUsed(usedKeys: Set<string>, songs: Song[]): void {
  for (let i = 0; i < songs.length; i++) {
    const key = radioTrackKey(songs[i]);
    if (key.length > 0) usedKeys.add(key);
    usedKeys.add(radioNameKey(songs[i]));
  }
}

/**
 * 开始一次 FM 会话时的变体种子。
 *
 * 选曲是**确定性**的：同一份画像 + 同一个池子 + 没有 `variant` 时，引擎的抖动种子
 * 固定，于是每次进 FM 都会挑出一模一样的第一首和同一批队列 —— 用户反馈「每次开始
 * 播放都是这一首歌，播放队列是一模一样的内容」就是这个原因。
 *
 * 这个种子有两个用处：一是引擎的抖动（作用有限），二是 `buildRadioBatch` 的
 * **窗口洗牌**（真正让两次会话不同的那一步）。「换一批」按钮用时间戳当种子，
 * 开始新会话用毫秒时间戳 + 自增计数器兜底（同一毫秒内连续开始两次也不会撞）。
 */
let radioSessionSeq = 0;

export function sessionVariant(): string {
  radioSessionSeq = radioSessionSeq + 1;
  return Date.now().toString(36) + "-" + radioSessionSeq;
}
