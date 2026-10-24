/**
 * 推荐引擎的共享类型契约（与 qt-pc src/lib/recommend-types.ts 同一套，字段语义一致）。
 *
 * 链路三块：
 * - music-style.ts：把「播放记录 + 收藏 + 歌单」提炼成口味画像；
 * - recommend-rank.ts：按画像打分 + 多样性选择；
 * - daily-recommend.ts：接数据层、缓存、提示词，把三段串成一次生成。
 *
 * 与 qt-pc 的差异只有两点（UTS 约束）：
 * 1. 键值容器不用 Map：Map 的键遍历（keys()/forEach）在本仓库没有先例
 *    （见 services/music-api.ts 的 lyricPickCache 注释），统一用
 *    Record<string, number> + Object.keys + numAt() 下标取值（lyric-offset /
 *    dislikes 两个 store 已在跑的写法）；
 * 2. Track → 本项目的 Song（title → name），其余字段同名同义。
 */

import type { Song } from "@/types/music";

/** 推荐口味：决定怎么扩候选、怎么配色，与推荐模式（要不要叫模型）正交 */
export type DailyTaste = "heart" | "familiar" | "explore";

/** 语种/文字种类（没有元数据，靠字符集统计推断；und = 判不出来，不当语种推） */
export type MusicLang = "zh" | "ja" | "ko" | "en" | "und";

/** 时长带：把「4 分钟的歌」和「8 分钟的后摇」分开，弱特征但零成本 */
export type DurationBand = "short" | "normal" | "long" | "epic";

/** 界面上给人看的语种名（if 链而不是字典：UTS 里最稳的常量表） */
export function musicLangLabel(lang: string): string {
  if (lang === "zh") return "华语";
  if (lang === "ja") return "日语";
  if (lang === "ko") return "韩语";
  if (lang === "en") return "欧美";
  return "器乐/其它";
}

/** 界面上给人看的时长描述 */
export function durationBandLabel(band: string): string {
  if (band === "short") return "短歌";
  if (band === "normal") return "三四分钟";
  if (band === "long") return "四五分钟";
  return "长曲";
}

/** 语种的固定竞争顺序（同权重时 zh 优先，与产品默认受众一致） */
export const MUSIC_LANG_ORDER: string[] = ["zh", "ja", "ko", "en"];

/** 时长带的固定顺序 */
export const DURATION_BAND_ORDER: string[] = ["short", "normal", "long", "epic"];

/** Record<string, number> 的安全取值：缺键/undefined 一律 0（UTS 没有 ?? 惯例） */
export function numAt(record: Record<string, number>, key: string): number {
  const v = record[key];
  return typeof v === "number" ? v : 0;
}

/** Record<string, number> 的安全写入 */
export function numPut(record: Record<string, number>, key: string, value: number): void {
  record[key] = value;
}

/** Record<string, number> 求和（Object.keys 有 store 先例） */
export function numSum(record: Record<string, number>): number {
  let total = 0;
  const keys = Object.keys(record);
  for (let i = 0; i < keys.length; i++) total += numAt(record, keys[i]);
  return total;
}

/** Record<string, number> 最大值（不用展开参数：歌手多的用户会撑爆） */
export function numMax(record: Record<string, number>): number {
  let max = 0;
  const keys = Object.keys(record);
  for (let i = 0; i < keys.length; i++) {
    const v = numAt(record, keys[i]);
    if (v > max) max = v;
  }
  return max;
}

/** 单曲的「风格坐标」：全部由本地字段算出，零网络、可缓存 */
export type TrackStyle = {
  /** 归一化歌手键（同一歌手不同写法合并成一个） */
  singerKey: string;
  /** 归一化专辑键 `歌手键|专辑键`；无专辑信息时 ""（带歌手防「精选」撞名） */
  albumKey: string;
  lang: MusicLang;
  band: DurationBand;
};

/** 一首歌的累计收听统计（来自本地听歌统计） */
export type TrackStat = {
  playCount: number;
  totalPlayedMs: number;
  lastPlayedAt: number;
};

/** 行为质量（0..1 量纲统一）：把「反复点开就切」和「一遍遍听完」分开 */
export type TrackQuality = {
  /** 完播比 = totalPlayedMs ÷ (playCount × 曲长)，clamp 0..1 */
  completion: number;
  /** 沉迷度 = playCount ÷ 全库最大 playCount，0..1 */
  replay: number;
  /** 最近性：30 天内线性衰减到 0 */
  recency: number;
  /** 综合喜欢度 = 0.5×completion + 0.3×replay + 0.2×recency */
  affinity: number;
  /** 反复点开（≥3 次）但每次听不到四成 = 其实不喜欢（收藏不算，那是调用方的事） */
  skipped: boolean;
};

/** 口味画像：描述「喜欢什么风格」，而不是「听过哪些歌手」 */
export type StyleProfile = {
  /** 各语种权重 Σ=1（空画像为空对象） */
  langs: Record<string, number>;
  /** 各时长带权重 Σ=1 */
  bands: Record<string, number>;
  /** 权重最高的语种；低于 MIN_MAIN_SHARE 或为空给 "und"（不下结论） */
  mainLang: string;
  /** 权重最高的时长带；为空给 "normal" */
  mainBand: string;
  /** 歌手亲和：归一化歌手键 → 0..1（按行为质量加权，最强者为 1） */
  singers: Record<string, number>;
  /** 专辑亲和：归一化专辑键 → 0..1 */
  albums: Record<string, number>;
  /** 从用户自己歌单名里抽的风格词，按出现次数降序 */
  tags: string[];
  /** 参与画像的样本数（去过重），用来判断画像是否可信 */
  sampleSize: number;
};

/** 画像的一条输入：一首「有行为」的歌 */
export type StyleSample = {
  song: Song;
  /** 累计统计；null = 没听过（只是被收进歌单），saved 是唯一强弱信号 */
  stat: TrackStat | null;
  /** 是否在收藏（喜欢的单曲 / 收藏歌单 / 自建歌单）里 */
  saved: boolean;
};

/** buildStyleProfile 的入参 */
export type StyleProfileInput = {
  samples: StyleSample[];
  /** 用户自己的歌单名（抽风格词用；没有就传空数组） */
  playlistNames: string[];
  /** 当前时刻（毫秒），测试注入用 */
  now: number;
};

/** 打分命中的特征 —— 只为生成推荐理由服务，不参与算分 */
export type RankHit =
  | "saved"
  | "same-album"
  | "main-lang"
  | "other-lang"
  | "main-band"
  | "familiar-singer"
  /** 歌手只出现在收藏/歌单里，没有播放证据 —— 理由不能说「常听」 */
  | "saved-singer"
  | "new-singer"
  | "unplayed"
  | "replayed"
  | "skipped";

/** 打分后的候选 */
export type ScoredCandidate = {
  song: Song;
  style: TrackStyle;
  /** 绝对分（未归一化，越大越好） */
  score: number;
  /** 命中的特征（按命中顺序，给理由生成用） */
  hits: RankHit[];
};

/** 打分/选择的选项（可选字段用 null 表缺省，UTS 无 Optional 惯例） */
export type RankOptions = {
  taste: DailyTaste;
  /** 目标条数，默认 50 */
  target: number | null;
  /** 同歌手最多几条 */
  maxPerSinger: number | null;
  /** 同语种最多几条（0 = 不限；und 不计入上限） */
  maxPerLang: number | null;
  /** 多样性强度 λ（MMR 扣除的相似度权重），0=纯分数 1=只求不相似，经验 0.4~0.9 */
  diversity: number | null;
  /** 「换一批」的变体种子：同一天可复现 */
  variant: string | null;
  /** 日期键 YYYY-MM-DD（抖动种子的一部分） */
  dateKey: string | null;
  /** 最近几天推荐过的键（trackKey/songNameKey）：只降权不放逐 */
  historyKeys: Set<string> | null;
  /** 已经听过的键（trackKey） */
  playedKeys: Set<string> | null;
  /** 常听歌手键集合（画像权重优先、榜单权重减半合并） */
  familiarSingers: Set<string> | null;
  /** 与候选同序的屏蔽标记（true = 硬排除） */
  disliked: boolean[] | null;
  /** 行为质量（键 = trackKey；没统计的歌不要放进来） */
  quality: Record<string, TrackQuality> | null;
  /** 用户收藏/歌单里的键（trackKey 与 songNameKey 都可能命中） */
  savedKeys: Set<string> | null;
  /** 集成层已经排掉的键（trackKey/songNameKey）：打分层按硬排除处理 */
  excludeKeys: Set<string> | null;
  /** 曲目风格坐标缓存（键 = trackKey）：没有就由打分层自己推导 */
  styles: Map<string, TrackStyle> | null;
};
