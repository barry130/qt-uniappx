/**
 * 每日推荐（uni-app x 移植版）：根据播放历史生成当天的一批歌。
 * 与 qt-pc src/lib/daily-recommend.ts（2026-10-24 版）同一套逻辑与文案，
 * 差异只有平台适配，全部列在下面「与 qt-pc 的差异」一节。
 *
 * ## 三种模式（`mode`：要不要叫模型）
 * - `rule`：纯规则，不联网调模型。任何情况下都能出结果，是另外两种的兜底。
 * - `local`：qt-pc 走用户自配的 OpenAI 兼容接口；**uniappx 还没有本地模型通道**，
 *   运行时直接走失败兜底（退回规则 + notice，见 askModelForPicks）。
 * - `server`：借 astral 的「音乐助手」跑一轮（ai-server-picks.ts）。需要登录；
 *   拿不到结果才退回规则并写 `notice`。
 * 三种模式是**全局**设置（ai-mode.ts）：音乐助手与每日推荐读同一个开关。
 *
 * ## 三种口味（`taste`：候选怎么搜、怎么排）与 mode 正交
 * - `heart` 心动：从收藏出发 —— 喜欢的单曲 + 在线收藏歌单 + 本地自建歌单里的歌
 *   直接入池，它们的歌手再作为种子去扩；
 * - `familiar` 常听：以常听歌手为主轴，同歌手配额放到最大；
 * - `explore` 探索：主力是全部音源的「最新音乐」里没听过的歌手，常听歌手倒扣。
 * 候选来自**全部已装音源**（跨源按名字搜 + 全源最新音乐），不再只看当前音源。
 *
 * ## 为什么按歌手轮流取（round-robin）
 * 「按分数降序截断」会让同一个歌手连着排满最前面；现在按歌手分组轮流取，
 * 同歌手在结果里天然摊开；「换一批」带 `variant` 种子轮转起手歌手。模型精选
 * 只做**最小必要**的歌手摊开：相邻撞歌手才交换，第一首永远不动。
 *
 * ## AI 精选：求贴合，不求「风格齐全」（v8）
 * 提示词要求「清单已按贴合度排好，优先挑靠前的和有本地证据的」；行尾括号带
 * 时长带与「已收藏/常听歌手/听过/非主语种」证据；结果还要过 `filterAiPicks`
 * 的「画像依据」校验，没依据的尾部歌退回规则补位。
 *
 * ## 与 qt-pc 的差异（平台强制，其余逻辑/文案/常量保持一致）
 * 1. `ipc.*` 数据源 → uniappx stores：播放历史 `player.history`（最新在前）、
 *    收藏 `player.likedSongs`、本地自建歌单 `player.localPlaylists`、在线收藏
 *    `player.savedPlaylists`、屏蔽 `useDislikesStore().isDisliked(song)`、
 *    收听统计 `useListenStatsStore().songs`（ListenSong，按 effectiveCount 排序），
 *    top 歌手由本模块按 normText(singer) 聚合 effectiveCount 得出
 *    （qt-pc 是 ipc.getTopSingers/getTopTracks）。
 * 2. 歌单排序：uniappx Playlist 没有 updatedAt/createdAt，qt-pc 的「按更新时间
 *    取最近 6 个」改为 localPlaylists 在前、savedPlaylists 在后，合计取前 6。
 * 3. 本地自建歌单的曲目 = `player.likedSongs` 里 `pids` 含该歌单 id 的歌；
 *    在线收藏歌单曲目走 `musicApi.playlist(id, platform)`。
 * 4. 聚合搜索：qt-pc `searchManyBatches`（保留批次结构）在 uniappx 没有门面，
 *    改为逐歌手 `musicApi.searchMerged(keyword, 1, 20, sources, source)` 拿
 *    跨源合并列表（去重口径不变）。
 * 5. `getAllLatestSongs` → `musicApi.allLatest`（同名同参）。
 * 6. `getPlaylistCategories` 返回 `UTSJSONObject[]`（{id,name,group}，用 .get 读），
 *    不是 qt-pc 的 PlaylistCategory 类型。
 * 7. 设置读写：qt-pc 走 ipc settings，这里用 uni.getStorageSync/uni.setStorageSync，
 *    键名与 qt-pc storageKeys 一致（本文件底部镜像导出）；readTaste/saveTaste/
 *    readStyleSeeds/saveStyleSeeds 由异步改同步。
 * 8. 本地模型（`local` 模式）：uniappx 没有本地模型聊天接口，askModelForPicks
 *    直接抛「本地模型接口还没有接入」，由 generateDailyRecommend 的 catch 退回
 *    规则并写 notice（与 qt-pc 本地失败分支同文案）。
 * 9. 搜索历史：`uni.getStorageSync("qt-search-history")` 的 JSON string[]
 *    （qt-pc 是 lib/search-history 的 getSearchHistory）。
 * 10. `LOCAL_PLATFORM` 从 ipc 导入 → 本模块内常量 `"local"`（uniappx 全库一致）。
 * 11. Track.title → Song.name；MUSIC_LANG_LABEL/DURATION_BAND_LABEL 字典 →
 *     musicLangLabel()/durationBandLabel() 函数（recommend-types.ts）。
 * 12. `DAILY_MODE_LABEL`：uniappx ai-mode.ts 没有单一 AI_MODE_LABEL 映射，
 *     这里用三个 AI_MODE_LABEL_* 常量就地拼。
 * 13. `laneCoverage` 多一个 max 形参（传 5，与 qt-pc 内部上限一致）。
 * 14. 缓存读写用 `JSON.parse(text) as DailyCacheStore`（纯对象，不用 .get）。
 * 15. `checkDisliked` 批量接口 → 逐首 `dislikes.isDisliked(song)`（同步 store）。
 * 16. `useMusicSourceStore.getState().activeSourceId` → `useSourceStore().current`；
 *     `useSourceRegistryStore.getState().ensure()` → `useSourceRegistryStore().ensure()`。
 */

import { musicApi } from "./music-api";
import { readAggregateSources } from "./aggregate-sources";
import { collectDimensionLanes, interleaveByLanes, laneCoverage } from "./recommend-dimensions";
import type { DimensionLanes } from "./recommend-dimensions";
import { buildStyleProfile, describeProfile, trackQuality, trackStyle } from "./music-style";
import { reasonFor, scoreCandidates, selectDiverse } from "./recommend-rank";
import { askServerForPicks } from "./ai-server-picks";
import { aiLocalChat } from "./ai-providers";
import type { AiLocalMessage } from "./ai-providers";
import {
  AI_MODE_LABEL_LOCAL,
  AI_MODE_LABEL_RULE,
  AI_MODE_LABEL_SERVER,
  parseAiMode,
  readAiMode,
  saveAiMode,
} from "./ai-mode";
import type { AiEngineMode } from "./ai-mode";
import { hashString, localDateKey, normText, trackKeyOf, songNameKey } from "./recommend-text";
import { durationBandLabel, musicLangLabel, numAt } from "./recommend-types";
import type { DailyTaste, RankHit, RankOptions, ScoredCandidate, StyleProfile, StyleSample, TrackQuality, TrackStat } from "./recommend-types";
import { useDislikesStore } from "@/stores/dislikes";
import { useListenStatsStore } from "@/stores/listen-stats";
import { usePlayerStore } from "@/stores/player";
import { useSourceRegistryStore } from "@/stores/source-registry";
import { useSourceStore } from "@/stores/source";
import type { Playlist, Song } from "@/types/music";
import type { ListenSong } from "@/stores/listen-stats";

export type { DailyTaste };

/** uniappx 的本地平台 id（qt-pc 从 @/services/ipc 导入 LOCAL_PLATFORM） */
const LOCAL_PLATFORM = "local";

// ---------- 常量 ----------

/**
 * 规则版本：改筛选/排序逻辑时 +1，缓存里的旧结果会失效重算。
 *
 * v6（2026-10-23）：冷启动不再返回空页面，改成「平台新歌垫底 + 风格 chip 引导」，
 * 结果多了 `coldStart/styleOptions/styleSeeds` 字段 —— 旧缓存 today 没这些字段，
 * 整体作废重算。
 *
 * v7（2026-10-23）：AI 候选池 60 → 150 并加尾巴轮转，模型才真的在挑而不是在删；
 * 回执解析加了修复与兜底。旧缓存里「AI 失败退回规则」的结果要重算。
 *
 * v8（2026-10-24）：用户反馈「AI 推荐怎么那么像随机选」。病灶是 v7 提示词要求
 * 「求分散」—— 模型凑出了风格拼盘（四首无关英文歌）。这一版把提示词改成
 * 「求贴合」，首次温度 0.8→0.4，模型结果再过一道「有没有本地依据」的校验
 * （buildPrompt / filterAiPicks）。旧缓存的 AI 结果必须重算。
 *
 * v9（2026-10-24）：用户反馈「风格能再多样一点、推荐维度再多一点」。v8 之后
 * 50 首几乎全落在一两条线上 —— 不是提示词错，是候选池只有那几条线可挑。这一版
 * 从**取数侧**扩维度：榜单路、风格/情绪/场景/年代关键词的跨源搜索、风格歌单、
 * 搜索历史；每首歌带「来自哪条风格线」的 provenance，排序按线交织，提示词要求
 * 覆盖 3–5 条线。池子/排序/提示词全变，当天旧缓存作废重算。
 */
export const DAILY_RULE_VERSION = 9;

/** 目标条数 */
export const DAILY_TARGET = 50;

/**
 * 交给模型的候选池上限（2026-10-23 从 60 放到 150）：池子必须比目标大出一截
 * （3 倍），模型才有富余按风格取舍；数错号由 parsePicks 硬校验兜住。
 */
export const DAILY_AI_POOL_MAX = 150;

/** 候选池里「规则排序的前 N 首」必进池，其余名额从尾巴按 variant 轮转取样 */
export const DAILY_AI_CORE = 90;

/**
 * 模型最多可以从「规则前 DAILY_TARGET 首之外」挑多少首（12/50 ≈ 1/4）：
 * 换进来的仍要过 filterAiPicks 的「画像依据」校验。
 */
export const DAILY_AI_OFF_CORE_MAX = 12;

/**
 * 提示词里规则条的编号。不能用 `1. 2. 3.`：候选清单本身就是「序号. 歌名」，
 * 数字编号会被模型当成候选行。编号按最终条数现排。
 */
const RULE_MARKS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

/**
 * 画像里某个语种的占比达到这个数，就承认「这是他听的语种」（口味边缘，
 * 不该被当作越界剔掉）。
 */
const LANG_AFFINITY_MIN = 0.05;

/** 提示词里要求覆盖的风格线数量上限（候选池里真有这么多条时才这么要求） */
const LANE_GOAL_MAX = 5;

/** 排序结果里最多掺几条风格线、以及掺多少（每条线占 LANE_QUOTA_SHARE 的份额） */
const LANE_DIVERSITY_MAX = 5;
const LANE_QUOTA_SHARE = 0.3;

/** 模型至少给出几条才认为「它真的干活了」；不够就用规则补齐 */
export const DAILY_AI_MIN_PICKS = 3;

/** 同一歌手最多占几条（避免整屏都是一个歌手；50 首需要更多歌手参与） */
export const DAILY_MAX_PER_SINGER = 3;

/** 保留最近几天的已推荐记录做跨天降权 */
export const DAILY_HISTORY_DAYS = 7;

/** 搜索并发上限：移动网络 + 多个音源，放开会互相拖慢 */
const SEARCH_CONCURRENCY = 3;

/** 每个种子歌手在**当前音源**最多取多少首 */
const SONGS_PER_SINGER = 20;

/** 每个种子歌手在**全部音源**按名字搜时最多取多少首 */
const CROSS_SOURCE_PER_SINGER = 20;

/** 用几个歌手做种子 */
const SEED_SINGER_MAX = 8;

/** 读多少条最近播放做「最近在听」种子 */
const RECENT_SEED_MAX = 12;

/** 「最新音乐」这一路最多取多少首（全部音源交错合并后） */
const EXPLORE_LATEST_MAX = 120;

/** 最多展开几张「同专辑」（每张要发 2 次音源请求：搜专辑 + 取详情） */
const ALBUM_SEED_MAX = 4;

/** 单张专辑最多取多少首（专辑本来就不长，30 首覆盖九成） */
const ALBUM_TRACKS_MAX = 30;

/** 最多进几个「风格歌单」分类（每个分类要发 1 次推荐 + N 次详情） */
const STYLE_CATEGORY_MAX = 2;

/** 单个风格分类取几张歌单做详情 */
const STYLE_PLAYLIST_MAX = 2;

/** 单张风格歌单最多取多少首 */
const STYLE_PLAYLIST_TRACKS_MAX = 40;

/** 页面一侧的硬上限（与生成的 STYLE_SEED_MAX 必须一致，导出给 UI 用） */
export const DAILY_STYLE_SEED_MAX = 4;

/** 冷启动最多让用户选几个风格（3~4 个能把口味框住，再多就「什么都想要」） */
const STYLE_SEED_MAX = DAILY_STYLE_SEED_MAX;

/** 冷启动页面上最多摆几个风格 chip（分类接口一般返回十几到几十个） */
const STYLE_OPTION_MAX = 12;

/**
 * 最多读几个收藏歌单（在线收藏 + 本地自建合计）。qt-pc 按更新时间取最近的，
 * uniappx 没有 updatedAt：localPlaylists 在前、savedPlaylists 在后合计取前 6。
 */
const PLAYLIST_SEED_MAX = 6;

/** 单个收藏歌单最多取多少首进候选池（歌单动辄上百首，全收会把池子灌爆） */
const PLAYLIST_TRACKS_MAX = 80;

// ---------- 模式 ----------

/** 模式的唯一真源在 ai-mode.ts（音乐助手与每日推荐共用同一个设置）。 */
export type DailyRecommendMode = AiEngineMode;

/** qt-pc 直接再导出 AI_MODE_LABEL；uniappx ai-mode 只有三个分段常量，就地拼 */
export const DAILY_MODE_LABEL: Record<DailyRecommendMode, string> = {
  rule: AI_MODE_LABEL_RULE,
  local: AI_MODE_LABEL_LOCAL,
  server: AI_MODE_LABEL_SERVER,
};

// ---------- 口味（推荐场景） ----------

export const DAILY_TASTE_LABEL: Record<DailyTaste, string> = {
  heart: "心动",
  familiar: "常听",
  explore: "探索",
};

/** 页面上口味按钮的固定顺序（对象 key 顺序不可靠，显式列出来） */
export const DAILY_TASTE_ORDER: DailyTaste[] = ["heart", "familiar", "explore"];

/** 口味对应的挑歌方向（写进模型提示词） */
const TASTE_PROMPT: Record<DailyTaste, string> = {
  heart:
    "用户想要「心动」：优先挑和他口味画像（语种、风格标签、常听专辑）最接近的歌，收藏过的同款最优先；但不要连着好几首都来自同一个歌手。",
  familiar:
    "用户想要「常听」：在用户已经熟悉的风格里挑（同语种、同专辑、风格标签对得上），熟悉感优先，别跳到完全陌生的风格去。",
  explore:
    "用户想要「探索」：挑用户没听过的歌手，也挑他没怎么听过的风格（语种或风格标签与画像不同），别老是那几个人、那几种味道。",
};

/** 把库里读出来的字符串收敛成合法口味（未知值按心动处理） */
export function parseDailyTaste(raw: string | null): DailyTaste {
  return raw === "familiar" || raw === "explore" ? raw : "heart";
}

/** 读当前设置的口味（uniappx：同步 storage，键名与 qt-pc 一致） */
export function readTaste(): DailyTaste {
  try {
    return parseDailyTaste(uni.getStorageSync(DAILY_RECOMMEND_TASTE_KEY) as string);
  } catch {
    return "heart";
  }
}

/** 保存口味 */
export function saveTaste(taste: DailyTaste): void {
  try {
    uni.setStorageSync(DAILY_RECOMMEND_TASTE_KEY, taste);
  } catch {}
}

/**
 * 把设置里读出来的风格种子收敛成干净的字符串数组。
 *
 * 存的是 JSON 数组，但要容忍三件脏事：老版本没有这个键、手工改坏了 JSON、
 * 早期版本写过的逗号分隔串 —— 都按「尽力还原」处理，错了不崩，只是画像少几个词。
 */
export function parseStyleSeeds(raw: string | null): string[] {
  if (raw == null || raw.length == 0) return [];
  let list: string[] = [];
  const text = raw.trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as any | null;
      if (parsed != null && Array.isArray(parsed)) {
        for (let i = 0; i < parsed.length; i++) {
          if (typeof parsed[i] === "string") list.push(parsed[i] as string);
        }
      }
    } catch {
      list = [];
    }
  }
  // 不是数组（老格式/手改坏）：按分隔符硬拆，能救一个算一个
  if (list.length == 0) {
    const parts = text.replace(/^\[|\]$/g, "").split(/[,，、/]+/);
    for (let i = 0; i < parts.length; i++) list.push(parts[i]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const name = list[i].trim();
    if (name.length == 0) continue;
    // 风格名里不可能出现 JSON 标点：出现了就是被写坏的残渣，别让它进画像
    if (/[{}[\]"\\]/.test(name)) continue;
    const key = normText(name);
    if (key.length == 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= STYLE_SEED_MAX) break;
  }
  return out;
}

/** 读用户选的风格种子（冷启动时点的那几个风格名） */
export function readStyleSeeds(): string[] {
  try {
    return parseStyleSeeds(uni.getStorageSync(DAILY_RECOMMEND_SEEDS_KEY) as string);
  } catch {
    return [];
  }
}

/** 保存风格种子；传空数组等于清空（下次生成又会回到冷启动） */
export function saveStyleSeeds(names: string[]): void {
  try {
    uni.setStorageSync(DAILY_RECOMMEND_SEEDS_KEY, JSON.stringify(parseStyleSeeds(JSON.stringify(names))));
  } catch {}
}

/** 冷启动时给用户点的风格选项（来自平台分类，名字就是风格名） */
export interface DailyStyleOption {
  id: string;
  name: string;
  /** 平台给的分类分组（「语种」「风格」「场景」「情感」…），只用于展示 */
  group: string;
}

// ---------- 类型 ----------

/** 一条推荐 + 推荐理由（理由可能来自模型，也可能是规则生成的） */
export interface DailyRecommendItem {
  song: Song;
  reason: string;
}

/** 一次生成的结果 */
export interface DailyRecommendResult {
  /** 本地日期 `YYYY-MM-DD` */
  date: string;
  /** 实际生效的模式（`server`/`local` 会被降级成 `rule`，看 `notice`） */
  mode: DailyRecommendMode;
  /**
   * 用户**要求**的模式。缓存命中按这个字段判断而不是按 `mode`：本地模型调不通时
   * 结果落成 `rule`，若按 `mode` 比对，下次进页面又会「模式不符」重新搜一遍。
   * 老缓存没有这个字段，读的时候回落 `mode`（见 loadTodayResult）。
   */
  requested: DailyRecommendMode;
  /** 这次用的口味（心动/常听/探索）；老缓存没这个字段，读时按 heart 归一 */
  taste: DailyTaste | null;
  generatedAt: number;
  /** 一句话主题（模型给的，规则模式是固定文案） */
  title: string;
  summary: string;
  items: DailyRecommendItem[];
  /** 给用户看的提示：降级、模型失败、候选不足等 */
  notice: string | null;
  /** 这次按什么口味挑的（画像的人话描述）；老缓存没有 */
  profileText: string | null;
  /** 这次真正干活的模型名（AI 模式才有）；老缓存没有 */
  model: string | null;
  /**
   * 本期覆盖到的**风格线**（按条数降序，最多 5 条；没有线证据时为空数组）。
   * 让用户看见这张歌单覆盖了哪几条线。
   */
  styleLanes: { label: string; count: number }[];
  /** 这次是**冷启动**结果（无播放历史、无收藏、也没选过风格） */
  coldStart: boolean;
  /** 冷启动时可选的风格（来自音乐源分类；音源不支持时为空数组） */
  styleOptions: DailyStyleOption[];
  /** 这次生效的风格种子（用户之前选过的话会带上） */
  styleSeeds: string[];
}

/** 从本地库提炼出的偏好 */
export interface DailyPreference {
  /** 常听歌手（按播放次数降序） */
  topSingers: string[];
  /** 最近在听（新的在前） */
  recentTracks: Song[];
  /** 收藏里的歌（喜欢的单曲） */
  favoriteTracks: Song[];
  /** 收藏歌单里的歌（在线收藏 + 本地自建），心动模式的主力来源 */
  playlistTracks: Song[];
  /** 已屏蔽规则数（只用于文案展示） */
  dislikeCount: number;
  /**
   * 播放次数最多的那批歌的完整收听统计（uniappx：listen-stats 按
   * effectiveCount 排序取前 200）。有 totalPlayedMs 才能算完播比。
   */
  topTracks: { song: Song; stat: TrackStat }[] | null;
  /** 口味画像：语种/时长带/常听歌手/常听专辑/歌单名里的风格词 */
  style: StyleProfile | null;
  /** `trackKey` → 收听质量（完播/重播/新鲜度/综合亲和度） */
  qualities: Map<string, TrackQuality> | null;
  /** 收藏歌单的名字（用户亲手写的风格自述，参与风格词提取） */
  playlistNames: string[] | null;
  /** 用户自己选的风格种子（与 playlistNames 分开存，便于展示与调试区分） */
  styleSeeds: string[] | null;
}

/** 缓存里存的一天 */
interface DailyCacheDay {
  date: string;
  mode: string;
  keys: string[];
}

/** `dailyRecommend.cache` 的完整结构 */
interface DailyCacheStore {
  v: number;
  /** 最近若干天推荐过的歌（跨天去重用） */
  days: DailyCacheDay[];
  /** 当天结果（生成过才有） */
  today: DailyRecommendResult | null;
}

function emptyCache(): DailyCacheStore {
  return { v: DAILY_RULE_VERSION, days: [], today: null };
}

// ---------- 小工具 ----------
// 日期键 / 曲目键 / 同名键 / 归一化 / FNV-1a 哈希都在 recommend-text.ts（全仓唯一实现）。
// qt-pc 调用方从本模块 import `todayKey` / `trackKey` / `songNameKey`，这里保留同名/近名出口：
// - todayKey()：包一层 localDateKey(new Date())；
// - trackKey(song)：trackKeyOf(platform, id) 的按歌包装；
// - songNameKey 在 recommend-text 是 (name, singer) 两参原语，这里导出 songNameKeyOf(song)
//   作为按歌取键的包装（UTS 不做同名重载导出）。

export function todayKey(): string {
  return localDateKey(new Date());
}

/** 曲目键：`${platform}:${id}`（对应 qt-pc 的 trackKey(Track)） */
export function trackKey(song: Song): string {
  return trackKeyOf(song.platform, song.id);
}

/** 同名键：normText(name)|normText(singer)（对应 qt-pc 的 songNameKey(Track)） */
export function songNameKeyOf(song: Song): string {
  return songNameKey(song.name, song.singer);
}

/** 纯数字串判定（qt-pc 的 /^\d+$/，UTS 里不依赖正则实现） */
function isDigitString(raw: string): boolean {
  if (raw.length == 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** "YYYY-MM-DD" → 本地当天 0 点时间戳；格式坏返回 -1（视作「无法判定」，与 qt-pc 的非有限值同待遇） */
function dayStartMs(date: string): number {
  const parts = date.split("-");
  if (parts.length != 3) return -1;
  if (parts[0].length != 4 || parts[1].length != 2 || parts[2].length != 2) return -1;
  if (!isDigitString(parts[0]) || !isDigitString(parts[1]) || !isDigitString(parts[2])) return -1;
  return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)).getTime();
}

/** 并发受限的 map（保持输入顺序；写法与 recommend-dimensions 的 worker 池一致） */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  const width = Math.min(Math.max(1, Math.trunc(limit) || 1), Math.max(1, items.length));
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < width; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= items.length) return;
          out[index] = await fn(items[index], index);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

/** 剥掉 markdown 围栏（```json … ```）；没有围栏就原样返回 */
function stripFence(trimmed: string): string {
  const open = trimmed.indexOf("```");
  if (open < 0) return trimmed;
  const lineEnd = trimmed.indexOf("\n", open + 3);
  if (lineEnd < 0) return trimmed;
  const close = trimmed.indexOf("```", lineEnd + 1);
  if (close < 0) return trimmed;
  return trimmed.substring(lineEnd + 1, close);
}

/** 从一段可能带 markdown 围栏/前后废话的文本里抠出第一个 JSON 对象 */
export function extractJsonObject(text: string): string | null {
  return extractBracketed(stripFence(text.trim()), "{", "}");
}

/**
 * 抠出第一个 JSON **数组**（模型偶尔直接回 `[3,7,9]`，把序号摆一排）。
 *
 * 只在拿不到对象时才用：正常回执是 `{"title":…,"picks":[…]}`，先按对象解析能拿到
 * title/summary；这里只兜底「模型偷懒只回了序号」这一种。
 */
export function extractJsonArray(text: string): string | null {
  return extractBracketed(stripFence(text.trim()), "[", "]");
}

/** 括号深度扫描（跳过字符串字面量里的括号），返回第一段配平的 open…close 文本 */
function extractBracketed(body: string, open: string, close: string): string | null {
  const start = body.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch == "\\") escaped = true;
      else if (ch == '"') inString = false;
      continue;
    }
    if (ch == '"') inString = true;
    else if (ch == open) depth += 1;
    else if (ch == close) {
      depth -= 1;
      if (depth == 0) return body.substring(start, i + 1);
    }
  }
  return null;
}

// ---------- 缓存读写 ----------

function normalizeCache(raw: string | null): DailyCacheStore {
  if (raw == null || raw.length == 0) return emptyCache();
  try {
    const parsed = JSON.parse(raw) as any | null;
    if (parsed == null || typeof parsed != "object") return emptyCache();
    const days: DailyCacheDay[] = [];
    if (Array.isArray(parsed.days)) {
      const rawDays = parsed.days as any[];
      for (let i = 0; i < rawDays.length; i++) {
        const day = rawDays[i];
        if (day == null || typeof day.date != "string" || !Array.isArray(day.keys)) continue;
        const keys: string[] = [];
        const rawKeys = day.keys as any[];
        for (let k = 0; k < rawKeys.length; k++) {
          if (typeof rawKeys[k] == "string") keys.push(rawKeys[k]);
        }
        days.push({
          date: day.date,
          mode: typeof day.mode == "string" ? day.mode : "",
          keys,
        });
      }
    }
    return {
      v: typeof parsed.v == "number" ? parsed.v : DAILY_RULE_VERSION,
      days,
      today: parsed.today != null ? (parsed.today as DailyRecommendResult) : null,
    };
  } catch {
    return emptyCache();
  }
}

/** 读缓存（坏数据一律当空，不能让一条脏记录把页面卡死） */
export async function readDailyCache(): Promise<DailyCacheStore> {
  let raw: string | null = null;
  try {
    raw = uni.getStorageSync(DAILY_RECOMMEND_CACHE_KEY) as string;
  } catch {
    raw = null;
  }
  return normalizeCache(raw);
}

function writeDailyCache(store: DailyCacheStore): void {
  try {
    uni.setStorageSync(DAILY_RECOMMEND_CACHE_KEY, JSON.stringify(store));
  } catch {
    // 存储失败只能放弃：页面仍能拿到本次结果，只是下次进页面要重算
  }
}

/**
 * 今天已生成过的结果（同一天 + 同模式 + 同口味 + 同规则版本才算命中）。
 *
 * 比对用 `requested` 而不是生效的 `mode`：本地模型调不通时结果落成 `rule`，
 * 若按 `mode` 比对，下次进页面又算「模式不符」→ 重新搜全部音源再超时一次。
 * `taste` 同理：换了口味（心动 → 探索）必须重算，否则用户点了没反应。
 */
export async function loadTodayResult(
  mode?: DailyRecommendMode,
  taste?: DailyTaste,
): Promise<DailyRecommendResult | null> {
  const cache = await readDailyCache();
  const today = cache.today;
  if (today == null) return null;
  if (today.date != todayKey()) return null;
  if (cache.v != DAILY_RULE_VERSION) return null;
  if (today.items == null || today.items.length == 0) return null;
  if (mode != null) {
    const stored = today.requested != null ? today.requested : today.mode;
    if (stored != mode) return null;
  }
  if (taste != null && parseDailyTaste(today.taste != null ? today.taste : "heart") != taste) return null;
  return today;
}

/** 清掉当天缓存（「换一批」用；历史记录保留，仍然参与跨天去重） */
export async function clearTodayResult(): Promise<void> {
  const cache = await readDailyCache();
  writeDailyCache({ v: cache.v, days: cache.days, today: null });
}

/**
 * 最近若干天推荐过的歌。
 *
 * 同时收 `trackKey` 和 `songNameKey`：同一首歌换音源 id 不同，只按 `trackKey` 去重
 * 会让它绕过历史检查又推一遍（「一直是那几首」的一个成因）。
 */
function recentRecommendedKeys(cache: DailyCacheStore, includeToday: boolean): Set<string> {
  const keys = new Set<string>();
  const cutoff = Date.now() - DAILY_HISTORY_DAYS * 24 * 3600 * 1000;
  for (let i = 0; i < cache.days.length; i++) {
    const day = cache.days[i];
    const at = dayStartMs(day.date);
    if (at >= 0 && at < cutoff) continue;
    for (let k = 0; k < day.keys.length; k++) keys.add(day.keys[k]);
  }
  if (includeToday && cache.today != null && cache.today.items != null) {
    const items = cache.today.items;
    for (let i = 0; i < items.length; i++) {
      keys.add(trackKey(items[i].song));
      keys.add(songNameKeyOf(items[i].song));
    }
  }
  return keys;
}

async function saveResult(result: DailyRecommendResult, replaceToday: boolean): Promise<void> {
  const cache = await readDailyCache();
  // 每首同时存 id 键和同名键：跨源换 id 的歌也要能被下一次去重认出来。
  // 同一天点了多次「换一批」时**合并**当天的键，不能覆盖：覆盖会让上一批的歌从
  // 「已推荐过」里消失，第三次「换一批」就可能把第一批原样捞回来。
  let sameDay: DailyCacheDay | null = null;
  for (let i = 0; i < cache.days.length; i++) {
    if (cache.days[i].date == result.date) {
      sameDay = cache.days[i];
      break;
    }
  }
  const mergedKeys: string[] = [];
  if (sameDay != null) {
    for (let k = 0; k < sameDay.keys.length; k++) {
      if (mergedKeys.indexOf(sameDay.keys[k]) < 0) mergedKeys.push(sameDay.keys[k]);
    }
  }
  for (let i = 0; i < result.items.length; i++) {
    const idKey = trackKey(result.items[i].song);
    const nameKey = songNameKeyOf(result.items[i].song);
    if (mergedKeys.indexOf(idKey) < 0) mergedKeys.push(idKey);
    if (mergedKeys.indexOf(nameKey) < 0) mergedKeys.push(nameKey);
  }
  const days: DailyCacheDay[] = [];
  for (let i = 0; i < cache.days.length; i++) {
    if (cache.days[i].date != result.date) days.push(cache.days[i]);
  }
  days.push({ date: result.date, mode: result.mode, keys: mergedKeys });
  days.sort((a, b): number => (a.date < b.date ? 1 : -1));
  const trimmed = days.slice(0, DAILY_HISTORY_DAYS);
  writeDailyCache({
    v: DAILY_RULE_VERSION,
    days: trimmed,
    today: replaceToday ? result : cache.today,
  });
}

/** 搜索历史（qt-pc lib/search-history 的 getSearchHistory）：最多 3 个、每个 ≤16 字 */
function readSearchHistory(): string[] {
  try {
    const raw = uni.getStorageSync("qt-search-history") as string;
    if (raw == null || raw.length == 0) return [];
    const parsed = JSON.parse(raw) as any | null;
    const out: string[] = [];
    if (parsed != null && Array.isArray(parsed)) {
      const list = parsed as any[];
      for (let i = 0; i < list.length && out.length < 3; i++) {
        if (typeof list[i] != "string") continue;
        const word = (list[i] as string).trim();
        if (word.length == 0 || word.length > 16) continue;
        out.push(word);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------- 偏好提取 ----------

/** loadPlaylistTracks 的返回形状 */
interface PlaylistTracksResult {
  tracks: Song[];
  names: string[];
}

/**
 * 读收藏歌单里的歌。uniappx 差异（见文件头 2/3）：歌单没有 updatedAt，取
 * 「本地自建在前、在线收藏在后」合计前 `PLAYLIST_SEED_MAX` 个；本地歌单曲目按
 * `pids` 会员关系从收藏里筛，在线歌单走 `musicApi.playlist(id, platform)`。
 * 任何一路失败都只是少几首，不影响整体。
 */
async function loadPlaylistTracks(): Promise<PlaylistTracksResult> {
  const player = usePlayerStore();
  const localSeeds: Playlist[] = [];
  const seeds: Playlist[] = [];
  for (let i = 0; i < player.localPlaylists.length && localSeeds.length < PLAYLIST_SEED_MAX; i++) {
    localSeeds.push(player.localPlaylists[i]);
  }
  for (let i = 0; i < localSeeds.length; i++) seeds.push(localSeeds[i]);
  for (let i = 0; i < player.savedPlaylists.length && seeds.length < PLAYLIST_SEED_MAX; i++) {
    seeds.push(player.savedPlaylists[i]);
  }
  if (seeds.length == 0) return { tracks: [], names: [] };
  const localCount = localSeeds.length;
  const rows = await mapLimit(
    seeds,
    SEARCH_CONCURRENCY,
    async (playlist: Playlist, index: number): Promise<Song[]> => {
      try {
        if (index < localCount) {
          // 本地自建歌单：成员关系记在歌的 pids 里
          const out: Song[] = [];
          const liked = usePlayerStore().likedSongs;
          for (let i = 0; i < liked.length && out.length < PLAYLIST_TRACKS_MAX; i++) {
            const song = liked[i];
            const pids = song.pids;
            if (pids == null) continue;
            if (pids.indexOf(playlist.id) >= 0) out.push(song);
          }
          return out;
        }
        const detail = await musicApi.playlist(playlist.id, playlist.platform);
        const tracks = detail.tracks != null ? (detail.tracks as Song[]) : [];
        const out: Song[] = [];
        for (let i = 0; i < tracks.length && i < PLAYLIST_TRACKS_MAX; i++) out.push(tracks[i]);
        return out;
      } catch {
        return [];
      }
    },
  );

  const out: Song[] = [];
  const seen = new Set<string>();
  for (let r = 0; r < rows.length; r++) {
    const tracks = rows[r];
    for (let i = 0; i < tracks.length; i++) {
      const song = tracks[i];
      if (song == null || !song.id || !song.name) continue;
      const key = trackKey(song);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(song);
    }
  }
  // 歌单名一起带出去：用户亲手写的名字（「周二夜里的后摇」「女声民谣」）是唯一
  // 由人给出的风格自述，比任何算法推断都可靠，交给画像去提风格词。
  const names: string[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const name = seeds[i].name.trim();
    if (name.length > 0) names.push(name);
  }
  return { tracks: out, names };
}

/**
 * 读本地偏好。qt-pc 是 7 路 Promise.all；uniappx 里 6 路是同步 store 读
 * （历史/收藏/屏蔽/统计/风格种子），只有收藏歌单一路要等网络 —— 行为等价。
 * 任何一路失败都不影响其它路：新用户可能什么都没有，返回空偏好，
 * 后面靠「搜索兜底」也能出一批歌。
 */
export async function loadPreference(): Promise<DailyPreference> {
  const playlists = await loadPlaylistTracks();
  const playlistTracks = playlists.tracks;
  const recent = usePlayerStore().history;
  const favorites = usePlayerStore().likedSongs;
  const dislikeCount = useDislikesStore().rules.length;

  // 播放统计：按 effectiveCount 降序取 200（qt-pc 是 Rust 侧 list_top_tracks 的硬上限，
  // 也是「够看清口味」的量级；再往上都是播放一两次的长尾，反而把画像搅浑）
  const stats = useListenStatsStore().songs;
  const sorted: ListenSong[] = [];
  for (let i = 0; i < stats.length; i++) sorted.push(stats[i]);
  sorted.sort((a, b): number => b.effectiveCount - a.effectiveCount);
  const topSongs: ListenSong[] = [];
  for (let i = 0; i < sorted.length && i < 200; i++) topSongs.push(sorted[i]);
  const topTracks: { song: Song; stat: TrackStat }[] = [];
  for (let i = 0; i < topSongs.length; i++) {
    const item = topSongs[i];
    topTracks.push({
      song: item.song,
      stat: {
        playCount: item.effectiveCount,
        totalPlayedMs: item.seconds * 1000,
        lastPlayedAt: item.lastPlayedAt,
      },
    });
  }

  // top 歌手（qt-pc ipc.getTopSingers(12)）：按 normText(singer) 聚合 effectiveCount，
  // 首次出现的名字当展示名（列表已降序，首现即该歌手最高名次）
  const singerScore = new Map<string, number>();
  const singerName = new Map<string, string>();
  for (let i = 0; i < topSongs.length; i++) {
    const display = topSongs[i].song.singer;
    const key = normText(display);
    if (key.length == 0) continue;
    const prev = singerScore.get(key);
    singerScore.set(key, (prev != null ? prev : 0) + topSongs[i].effectiveCount);
    if (!singerName.has(key)) singerName.set(key, display);
  }
  const rankedSingers: { name: string; score: number }[] = [];
  const singerKeys = Array.from(singerScore.keys());
  for (let i = 0; i < singerKeys.length; i++) {
    const key = singerKeys[i];
    const name = singerName.get(key);
    const score = singerScore.get(key);
    rankedSingers.push({ name: name != null ? name : key, score: score != null ? score : 0 });
  }
  rankedSingers.sort((a, b): number => b.score - a.score);
  const singers: string[] = [];
  for (let i = 0; i < rankedSingers.length && i < 12; i++) singers.push(rankedSingers[i].name);

  const topSingers: string[] = [];
  const seenSinger = new Set<string>();
  const pushSinger = (raw: string): void => {
    // 歌手串可能是「周杰伦/费玉清」，拆开逐个人入种子
    const parts = raw.split(/[/、,，&＆;；]+/);
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i].trim();
      if (name.length == 0) continue;
      const key = normText(name);
      if (key.length == 0 || seenSinger.has(key)) continue;
      seenSinger.add(key);
      topSingers.push(name);
    }
  };
  for (let i = 0; i < singers.length; i++) pushSinger(singers[i]);
  for (let i = 0; i < favorites.length && i < 10; i++) pushSinger(favorites[i].singer);
  // 收藏歌单里的歌手也是口味信号：心动模式要按它们扩
  for (let i = 0; i < playlistTracks.length && i < 20; i++) pushSinger(playlistTracks[i].singer);

  const recentTracks: Song[] = [];
  for (let i = 0; i < recent.length && i < RECENT_SEED_MAX; i++) recentTracks.push(recent[i]);
  for (let i = 0; i < recentTracks.length; i++) pushSinger(recentTracks[i].singer);

  // ---- 收听质量 + 风格画像 ----
  // 这两块是 2026-10-23 反馈的正解：旧实现只按「歌手排名」推，等于把用户锁死在
  // 那几个名字里；画像把语种/时长带/专辑/风格词也算进来。
  let maxPlayCount = 0;
  for (let i = 0; i < topTracks.length; i++) {
    if (topTracks[i].stat.playCount > maxPlayCount) maxPlayCount = topTracks[i].stat.playCount;
  }
  const now = Date.now();
  const qualities = new Map<string, TrackQuality>();
  for (let i = 0; i < topTracks.length; i++) {
    const item = topTracks[i];
    qualities.set(
      trackKey(item.song),
      trackQuality(item.stat, item.song.duration != null ? item.song.duration : 0, maxPlayCount, now),
    );
  }

  const samples: StyleSample[] = [];
  const seenSample = new Set<string>();
  const addSample = (song: Song, saved: boolean, stat: TrackStat | null): void => {
    if (song == null || !song.name) return;
    const key = trackKey(song);
    if (key.length == 0 || seenSample.has(key)) return;
    seenSample.add(key);
    samples.push({ song, stat, saved });
  };
  // 先放有统计的（权重最高），再放收藏与歌单 —— 顺序即重要度
  for (let i = 0; i < topTracks.length; i++) addSample(topTracks[i].song, false, topTracks[i].stat);
  for (let i = 0; i < favorites.length; i++) addSample(favorites[i], true, null);
  for (let i = 0; i < playlistTracks.length; i++) addSample(playlistTracks[i], true, null);
  for (let i = 0; i < recentTracks.length; i++) addSample(recentTracks[i], false, null);

  const styleSeeds = readStyleSeeds();
  // 风格种子并入画像的来源名：buildStyleProfile 从这个字段抽风格词，用户手选的
  // 名字与歌单名走同一条提取逻辑，画像里的 tags 就自然带上了它们。
  const profileNames: string[] = [];
  for (let i = 0; i < playlists.names.length; i++) profileNames.push(playlists.names[i]);
  for (let i = 0; i < styleSeeds.length; i++) profileNames.push(styleSeeds[i]);
  return {
    topSingers: topSingers.slice(0, SEED_SINGER_MAX),
    recentTracks,
    favoriteTracks: favorites,
    playlistTracks,
    dislikeCount,
    topTracks,
    playlistNames: playlists.names,
    styleSeeds,
    qualities,
    style: buildStyleProfile({ samples, playlistNames: profileNames, now }),
  };
}

// ---------- 候选池 ----------

/** 候选池的可选参数（分类是 musicApi.playlistCategories 的 UTSJSONObject 项） */
export interface CandidatePoolOptions {
  /** 推荐口味，决定要不要额外捞「最新音乐」 */
  taste?: DailyTaste;
  /**
   * 冷启动：没有任何播放历史/收藏/风格种子时，走「平台热门 + 风格歌单」垫底。
   * 与口味无关 —— 冷启动时三种口味都得先给出内容来，否则新用户永远看到空页面。
   */
  coldStart?: boolean;
  /** 已经取到的平台分类（冷启动时页面要显示同一批；传进来省一次请求） */
  categories?: UTSJSONObject[];
  /** 进度回调（已完成的搜索路数 / 总路数） */
  onProgress?: (done: number, total: number) => void;
  /**
   * 「换一批」的变体种子：维度搜索的兜底词条按它轮换 —— 没有这个，
   * 用户点十次「换一批」看到的风格维度永远是同一批。
   */
  variant?: string;
}

/** UTSJSONObject 字段安全读字符串 */
function catText(item: UTSJSONObject, field: string): string {
  const value = item.get(field);
  return typeof value == "string" ? value : "";
}

/**
 * 从平台分类里挑出**和口味对得上**的几个，用来取风格歌单。
 *
 * 平台分类的名字就是风格名（「华语」「摇滚」「民谣」「纯音乐」…），这是整条链路上
 * 唯一拿得到的平台侧风格标签。三种口味的挑法不同：
 * - `heart`：优先命中画像里的风格词，其次命中主语种 —— 找「你已经喜欢的同款」；
 * - `explore`：**避开**画像里的风格词和主语种，专门挑权重最低的那类 ——
 *   探索不是「在熟悉的风格里找新歌手」，而是「换个风格」；
 * - `familiar`：不走这一路（靠同专辑 + 常听歌手就够了，风格歌单反而会掺进陌生人）。
 *
 * 分类名与画像对不上时按顺序兜底取前几个，保证这一路不会因为匹配不上而空手。
 */
function pickStyleCategories(
  categories: UTSJSONObject[],
  pref: DailyPreference,
  taste: DailyTaste,
): UTSJSONObject[] {
  const list: UTSJSONObject[] = [];
  for (let i = 0; i < categories.length; i++) {
    const item = categories[i];
    if (item == null) continue;
    if (catText(item, "id").length > 0 && catText(item, "name").length > 0) list.push(item);
  }
  if (list.length == 0) return [];
  const profile = pref.style;
  const tags: string[] = [];
  if (profile != null) {
    for (let i = 0; i < profile.tags.length; i++) tags.push(normText(profile.tags[i]));
  }
  const mainLangLabel = profile != null && profile.mainLang != "und" ? musicLangLabel(profile.mainLang) : "";
  const langKey = normText(mainLangLabel);
  const matches = (item: UTSJSONObject): boolean => {
    const name = normText(catText(item, "name"));
    if (name.length == 0) return false;
    if (tags.indexOf(name) >= 0) return true;
    // 分类名常是「华语流行」「欧美摇滚」这种组合词，用包含判断而不是相等
    if (langKey.length > 0 && (name.includes(langKey) || langKey.includes(name))) return true;
    for (let t = 0; t < tags.length; t++) {
      if (tags[t].length >= 2 && name.includes(tags[t])) return true;
    }
    return false;
  };
  if (taste == "explore") {
    const others: UTSJSONObject[] = [];
    for (let i = 0; i < list.length; i++) {
      if (!matches(list[i])) others.push(list[i]);
    }
    // 一个都匹配不上说明画像太空（新用户），此时「避开」没有意义，按平台顺序取
    const source = others.length > 0 ? others : list;
    return source.slice(0, STYLE_CATEGORY_MAX);
  }
  const hit: UTSJSONObject[] = [];
  const rest: UTSJSONObject[] = [];
  for (let i = 0; i < list.length; i++) {
    if (matches(list[i])) hit.push(list[i]);
    else rest.push(list[i]);
  }
  const ordered: UTSJSONObject[] = [];
  for (let i = 0; i < hit.length; i++) ordered.push(hit[i]);
  for (let i = 0; i < rest.length; i++) ordered.push(rest[i]);
  return ordered.slice(0, STYLE_CATEGORY_MAX);
}

/**
 * 冷启动页面上摆哪些风格 chip。
 *
 * 平台分类会同时返回「语种」「风格」「场景」「情感」四组，几十个名字摆满一屏反而
 * 没法选。这里只做三件事：去掉脏数据、按名字去重、截断到一屏放得下的数量。
 * **不改顺序** —— 平台把「华语」「欧美」这些大分类排在前面，那是它自己的推荐顺序。
 */
function pickStyleOptions(categories: UTSJSONObject[]): DailyStyleOption[] {
  const out: DailyStyleOption[] = [];
  const seen: string[] = [];
  for (let i = 0; i < categories.length; i++) {
    const item = categories[i];
    if (item == null) continue;
    const id = catText(item, "id");
    const name = catText(item, "name");
    if (id.length == 0 || name.length == 0) continue;
    const key = normText(name);
    if (key.length == 0 || seen.indexOf(key) >= 0) continue;
    seen.push(key);
    out.push({ id, name: name.trim(), group: catText(item, "group").trim() });
    if (out.length >= STYLE_OPTION_MAX) break;
  }
  return out;
}

/**
 * 多路搜候选，**覆盖全部已装音源**。
 *
 * ⓪ 收藏里的歌（喜欢的单曲 + 收藏歌单，心动模式的主力）—— 本来就是用户明确
 *    喜欢的，直接入池，不用再搜；
 * ① 常听/收藏歌手的其它歌（`musicApi.artistSongs`，当前音源，负责「深」）；
 * ② 按歌手名跨源搜（`musicApi.searchMerged` 聚合，全部音源，负责「广」）；
 * ③ 全部音源的最新音乐（`musicApi.allLatest`，探索模式主力/冷启动垫底）；
 * ④ 同专辑兄弟（专辑是「风格」最硬的代理）；
 * ⑤ 风格歌单（平台自己归类的「摇滚/华语/民谣」）。
 *
 * 已经在本地听过的歌也留在池里（规则排序会给没听过的加分），只是不额外扩。
 */
export async function buildCandidatePool(
  pref: DailyPreference,
  source: string,
  options: CandidatePoolOptions = {},
): Promise<Song[]> {
  const taste = options.taste != null ? options.taste : "heart";
  const onProgress = options.onProgress;
  const coldStart = options.coldStart == true;
  const singers = pref.topSingers.slice(0, SEED_SINGER_MAX);
  // 探索模式靠「最新音乐」也能出结果；其它口味没有种子歌手就诚实返回空，
  // 由调用方提示「先去听几首」。冷启动是例外：必须用最新音乐 + 风格歌单垫住。
  const wantLatest =
    taste == "explore" ||
    coldStart ||
    // 只选过风格、没有播放量的用户：种子歌手和收藏都是空的，最新音乐是兜底内容
    (singers.length == 0 && pref.favoriteTracks.length == 0 && pref.playlistTracks.length == 0);
  // 心动模式从收藏出发：收藏里已经有歌就直接入池，不需要种子歌手
  const favorites: Song[] = [];
  if (taste == "heart") {
    for (let i = 0; i < pref.favoriteTracks.length; i++) favorites.push(pref.favoriteTracks[i]);
    for (let i = 0; i < pref.playlistTracks.length; i++) favorites.push(pref.playlistTracks[i]);
  }
  if (singers.length == 0 && !wantLatest && favorites.length == 0) return [];

  let done = 0;
  const wantAlbum = taste == "heart" || taste == "familiar";
  const wantStylePlaylist = taste == "heart" || taste == "explore" || coldStart;
  const total =
    singers.length * 2 + (wantLatest ? 1 : 0) + (wantAlbum ? 1 : 0) + (wantStylePlaylist ? 1 : 0);
  const tick = (): void => {
    done += 1;
    if (onProgress != null) onProgress(done, total);
  };

  // ① 常听/收藏歌手的其它歌（当前音源）
  const byArtist: Song[][] =
    singers.length == 0
      ? []
      : await mapLimit(singers, SEARCH_CONCURRENCY, async (singer: string): Promise<Song[]> => {
          try {
            const pageSize = Math.min(musicApi.searchPageMaxOf(source), SONGS_PER_SINGER);
            const page = await musicApi.artistSongs(singer, source, 1, pageSize);
            tick();
            return page.songs != null ? page.songs : [];
          } catch {
            tick();
            return [];
          }
        });

  // ② 按歌手名跨源搜（全部音源，负责「广」）。qt-pc 把扇出交给数据包的 searchManyBatches；
  //    uniappx 没有那个门面，逐歌手调 searchMerged（聚合合并），并发由 mapLimit 限制。
  const aggSources = readAggregateSources();
  const bySearch: Song[][] = await mapLimit(
    singers,
    SEARCH_CONCURRENCY,
    async (singer: string): Promise<Song[]> => {
      try {
        const merged = await musicApi.searchMerged(singer, 1, CROSS_SOURCE_PER_SINGER, aggSources, source);
        tick();
        return merged.songs != null ? merged.songs : [];
      } catch {
        // 单个歌手搜索失败（音源超时/未装载）按空结果处理，其它歌手照常
        tick();
        return [];
      }
    },
  );

  // ③ 全部音源的最新音乐
  const latest: Song[] = [];
  if (wantLatest) {
    try {
      const songs = await musicApi.allLatest(EXPLORE_LATEST_MAX, 0);
      for (let i = 0; i < songs.length; i++) latest.push(songs[i]);
    } catch {
      // 全部音源都失败时这一路为空，不影响其它路
    }
    tick();
  }

  // ④ 同专辑兄弟：专辑 id 拿不到（Song 没有 albumId），按「歌手 专辑名」搜专辑，
  //    再挑名字对得上的那张 —— 宁可少一张专辑，也不猜错专辑。
  const byAlbum: Song[] = [];
  if (wantAlbum) {
    const albumKeyToSong = new Map<string, Song>();
    const albumSeeds: Song[] = [];
    for (let i = 0; i < pref.favoriteTracks.length; i++) albumSeeds.push(pref.favoriteTracks[i]);
    for (let i = 0; i < pref.playlistTracks.length; i++) albumSeeds.push(pref.playlistTracks[i]);
    for (let i = 0; i < pref.recentTracks.length; i++) albumSeeds.push(pref.recentTracks[i]);
    for (let i = 0; i < albumSeeds.length; i++) {
      const song = albumSeeds[i];
      if (song == null || !song.name || !song.album) continue;
      const key = trackStyle(song).albumKey;
      if (key.length == 0 || albumKeyToSong.has(key)) continue;
      albumKeyToSong.set(key, song);
    }
    const albums = Array.from(albumKeyToSong.values()).slice(0, ALBUM_SEED_MAX);
    const rows = await mapLimit(albums, SEARCH_CONCURRENCY, async (track: Song): Promise<Song[]> => {
      try {
        const found = await musicApi.searchAlbums(track.singer + " " + track.album, source, 1, 10);
        let hitId = "";
        for (let a = 0; a < found.length; a++) {
          if (normText(found[a].name) == normText(track.album)) {
            hitId = found[a].id;
            break;
          }
        }
        if (hitId.length == 0) return [];
        const detail = await musicApi.albumDetail(hitId, source);
        const tracks = detail.tracks != null ? (detail.tracks as Song[]) : [];
        const out: Song[] = [];
        for (let i = 0; i < tracks.length && i < ALBUM_TRACKS_MAX; i++) out.push(tracks[i]);
        return out;
      } catch {
        return [];
      }
    });
    for (let r = 0; r < rows.length; r++) {
      for (let i = 0; i < rows[r].length; i++) byAlbum.push(rows[r][i]);
    }
    tick();
  }

  // ⑤ 风格歌单：唯一能拿到**平台侧风格标签**的入口，分类名就是风格名。
  //    心动模式按画像主语种找同款；探索模式反过来，专挑用户权重最低的分类。
  const byStylePlaylist: Song[] = [];
  if (wantStylePlaylist) {
    try {
      // 冷启动时调用方已经取过分类（页面要拿同一批给用户点），别重复请求
      const categories =
        options.categories != null ? options.categories : await musicApi.playlistCategories(source);
      const picked = pickStyleCategories(categories, pref, taste);
      const rows = await mapLimit(
        picked,
        2,
        async (category: UTSJSONObject): Promise<Song[]> => {
          try {
            const playlists = await musicApi.recommendations(source, catText(category, "id"), 1, "");
            // 取两张：一张可能刚好是「猜你喜欢」这种大杂烩，两张互相兜底
            const targets = playlists.slice(0, STYLE_PLAYLIST_MAX);
            const details = await mapLimit(
              targets,
              2,
              async (playlist: Playlist): Promise<Song[]> => {
                try {
                  const detail = await musicApi.playlist(playlist.id, source);
                  const tracks = detail.tracks != null ? (detail.tracks as Song[]) : [];
                  const out: Song[] = [];
                  for (let i = 0; i < tracks.length && i < STYLE_PLAYLIST_TRACKS_MAX; i++) {
                    out.push(tracks[i]);
                  }
                  return out;
                } catch {
                  return [];
                }
              },
            );
            const out: Song[] = [];
            for (let r = 0; r < details.length; r++) {
              for (let i = 0; i < details[r].length; i++) out.push(details[r][i]);
            }
            return out;
          } catch {
            return [];
          }
        },
      );
      for (let r = 0; r < rows.length; r++) {
        for (let i = 0; i < rows[r].length; i++) byStylePlaylist.push(rows[r][i]);
      }
    } catch {
      // 整条风格歌单路失败（分类接口挂了）：按空处理
    }
    tick();
  }

  // 合并去重（顺序即优先级：收藏 → 歌手 → 跨源 → 最新 → 专辑 → 风格歌单）
  const pool: Song[] = [];
  const seen = new Set<string>();
  const push = (song: Song): void => {
    if (song == null || !song.id || !song.name) return;
    const key = trackKey(song);
    if (seen.has(key)) return;
    seen.add(key);
    pool.push(song);
  };
  for (let i = 0; i < favorites.length; i++) push(favorites[i]);
  for (let r = 0; r < byArtist.length; r++) {
    for (let i = 0; i < byArtist[r].length; i++) push(byArtist[r][i]);
  }
  for (let r = 0; r < bySearch.length; r++) {
    for (let i = 0; i < bySearch[r].length; i++) push(bySearch[r][i]);
  }
  for (let i = 0; i < latest.length; i++) push(latest[i]);
  for (let i = 0; i < byAlbum.length; i++) push(byAlbum[i]);
  for (let i = 0; i < byStylePlaylist.length; i++) push(byStylePlaylist[i]);
  return pool;
}

/** 候选池 + 风格线：`tracks` 是去重合并后的全部候选，`laneOf` 是维度路带回来的 provenance */
export interface CandidatePoolResult {
  tracks: Song[];
  /** trackKey → 这条曲目来自哪几条风格线（第一条是主线） */
  laneOf: Map<string, string[]>;
  /** 由画像/搜索历史推出来的线（tag / 语种 / 相邻风格 / 搜索词）；榜单线不在内 */
  affinityLanes: Set<string>;
}

/**
 * 候选池 + 「更多维度」（v9 核心）。
 *
 * v8 及以前的 6 条取数路都从「常听歌手 / 收藏 / 专辑 / 风格歌单」出发，拿到的几乎
 * 是同一批风格 —— 用户 2026-10-24 的原话是「风格能再多样一点，而不是只有那么一
 * 两个」。这里在原有 6 路之外并行跑一遍维度路（榜单 / 风格关键词 / 风格歌单 /
 * 搜索历史），每首维度歌带上「它来自哪条线」的标签，交给 interleaveByLanes 与
 * 提示词使用。两路并行而不是串行：维度路是加分项，并行时哪怕维度路整体失败，
 * 基础池照常返回 —— 推荐页不能因为一个榜单接口超时就空着。
 */
export async function buildCandidatePoolWithLanes(
  pref: DailyPreference,
  source: string,
  options: CandidatePoolOptions = {},
): Promise<CandidatePoolResult> {
  const taste = options.taste != null ? options.taste : "heart";
  const profile =
    pref.style != null
      ? pref.style
      : buildStyleProfile({ samples: samplesFromPreference(pref), playlistNames: [], now: Date.now() });
  const searchHistory = readSearchHistory();
  const aggSources = readAggregateSources();
  const dimensionPromise = (async (): Promise<DimensionLanes> => {
    // 本地音乐源没有榜单/在线搜索接口，维度路只会白跑一轮网络请求
    if (source == "local") return { lanes: [], laneOf: new Map<string, string[]>() };
    try {
      return await collectDimensionLanes({
        profile,
        playlistNames: pref.playlistNames != null ? pref.playlistNames : [],
        searchHistory,
        taste,
        variant: options.variant != null ? options.variant : null,
        source,
        sources: aggSources,
        onProgress: () => {
          if (options.onProgress != null) options.onProgress(1, 1);
        },
      });
    } catch {
      return { lanes: [], laneOf: new Map<string, string[]>() };
    }
  })();
  const basePoolPromise = buildCandidatePool(pref, source, options);
  const basePool = await basePoolPromise;
  const lanes = await dimensionPromise;

  const laneOf = new Map<string, string[]>();
  const laneKeys = Array.from(lanes.laneOf.keys());
  for (let i = 0; i < laneKeys.length; i++) {
    const labels = lanes.laneOf.get(laneKeys[i]);
    laneOf.set(laneKeys[i], labels != null ? labels : []);
  }
  const tracks: Song[] = [];
  const seen = new Set<string>();
  const push = (song: Song): void => {
    if (song == null || !song.id || !song.name) return;
    const key = trackKey(song);
    if (seen.has(key)) return;
    seen.add(key);
    tracks.push(song);
  };
  for (let i = 0; i < basePool.length; i++) push(basePool[i]);
  for (let l = 0; l < lanes.lanes.length; l++) {
    const lane = lanes.lanes[l];
    for (let i = 0; i < lane.songs.length; i++) push(lane.songs[i]);
  }
  const affinityLanes = new Set<string>();
  for (let l = 0; l < lanes.lanes.length; l++) {
    if (lanes.lanes[l].kind != "chart") affinityLanes.add(lanes.lanes[l].label);
  }
  return { tracks, laneOf, affinityLanes };
}

/**
 * 按「风格线配额」把维度路的新歌补进规则排序结果（v9）。
 *
 * 维度歌大多歌手陌生、没有播放证据，rankCandidates 会把它们压到 150 名之后；
 * 可用户要的是「前 50 首里能听见几种不同的风格」。所以先保住底盘 —— 规则排序
 * 前 70% 原样收下，再给每条风格线补 `perLane` 首（线顺序 = 该线在排序里第一次
 * 出现的顺序，即越贴合越优先），最后按原序补满。
 *
 * `laneOf` 只认主线（`[0]`）：一首歌同时属于两条线时按更贴切的那条算，避免重复
 * 占额度。没有线标签的歌走 `ranked` 原序，不计额度。
 */
export function diversifyByLanes(
  ranked: Song[],
  laneOf: Map<string, string[]>,
  target: number,
): Song[] {
  if (target <= 0 || ranked.length == 0) return [];
  const byLane = new Map<string, Song[]>();
  for (let i = 0; i < ranked.length; i++) {
    const track = ranked[i];
    const labels = laneOf.get(trackKey(track));
    const label = labels != null && labels.length > 0 ? labels[0] : "";
    if (label.length == 0) continue;
    const list = byLane.get(label);
    if (list != null) list.push(track);
    else byLane.set(label, [track]);
  }
  if (byLane.size == 0) return ranked.slice(0, target);

  const laneCount = Math.min(LANE_DIVERSITY_MAX, byLane.size);
  const laneSlots = Math.min(Math.round(target * LANE_QUOTA_SHARE), target);
  const perLane = Math.max(1, Math.floor(laneSlots / laneCount));

  const chosen: Song[] = [];
  const taken = new Set<string>();
  const push = (track: Song): void => {
    const key = trackKey(track);
    if (taken.has(key) || chosen.length >= target) return;
    taken.add(key);
    chosen.push(track);
  };

  // 1) 底盘：规则排序最靠前的那批，保证「七成还是最像他的」
  const coreSize = Math.max(1, target - laneSlots);
  const core = ranked.slice(0, coreSize);
  for (let i = 0; i < core.length; i++) push(core[i]);

  // 2) 每条线按排序补到 perLane（已经进底盘的算在额度里）
  const laneLists = Array.from(byLane.values());
  for (let li = 0; li < laneLists.length && li < laneCount; li++) {
    const tracks = laneLists[li];
    let added = 0;
    for (let i = 0; i < tracks.length; i++) {
      if (taken.has(trackKey(tracks[i]))) added += 1;
    }
    for (let i = 0; i < tracks.length; i++) {
      if (added >= perLane) break;
      const key = trackKey(tracks[i]);
      if (taken.has(key)) continue;
      push(tracks[i]);
      added += 1;
    }
  }

  // 3) 不够（维度歌总数或线数不足）就用原序补满
  for (let i = 0; i < ranked.length; i++) push(ranked[i]);
  return chosen.slice(0, target);
}

// ---------- 规则筛选与排序 ----------

/** 每种口味最多让同一歌手占几条（50 首需要更多人参与，探索模式尤其要散） */
const TASTE_MAX_PER_SINGER: Record<DailyTaste, number> = {
  heart: DAILY_MAX_PER_SINGER,
  familiar: DAILY_MAX_PER_SINGER + 2,
  explore: 1,
};

/** Map<string, TrackQuality> → RankOptions 要的 Record（引擎按属性键读） */
function qualityRecord(qualities: Map<string, TrackQuality>): Record<string, TrackQuality> {
  const out: Record<string, TrackQuality> = {};
  const keys = Array.from(qualities.keys());
  for (let i = 0; i < keys.length; i++) {
    const value = qualities.get(keys[i]);
    if (value != null) out[keys[i]] = value;
  }
  return out;
}

/** 从偏好里重建画像（正常路径直接用 pref.style；这里兜底空画像的防御路径） */
function samplesFromPreference(pref: DailyPreference): StyleSample[] {
  const samples: StyleSample[] = [];
  const seen = new Set<string>();
  const push = (song: Song, saved: boolean, stat: TrackStat | null): void => {
    if (song == null || !song.name) return;
    const key = trackKey(song);
    if (key.length == 0 || seen.has(key)) return;
    seen.add(key);
    samples.push({ song, stat, saved });
  };
  const top = pref.topTracks != null ? pref.topTracks : [];
  for (let i = 0; i < top.length; i++) push(top[i].song, false, top[i].stat);
  for (let i = 0; i < pref.favoriteTracks.length; i++) push(pref.favoriteTracks[i], true, null);
  for (let i = 0; i < pref.playlistTracks.length; i++) push(pref.playlistTracks[i], true, null);
  for (let i = 0; i < pref.recentTracks.length; i++) push(pref.recentTracks[i], false, null);
  return samples;
}

/** 收藏键集合：`trackKey` 与 `songNameKey` 都收（跨源同歌换 id 也认得出） */
function savedKeySet(pref: DailyPreference): Set<string> {
  const keys = new Set<string>();
  const all: Song[] = [];
  for (let i = 0; i < pref.favoriteTracks.length; i++) all.push(pref.favoriteTracks[i]);
  for (let i = 0; i < pref.playlistTracks.length; i++) all.push(pref.playlistTracks[i]);
  for (let i = 0; i < all.length; i++) {
    keys.add(trackKey(all[i]));
    keys.add(songNameKeyOf(all[i]));
  }
  return keys;
}

/**
 * 「换一批」时轮转起手歌手。
 *
 * MMR 选出来的第一首永远是分数最高的那首，同一天点多少次「换一批」第一位都不变。
 * 把同一件事做在选完之后：按歌手分块、轮转块的顺序、再贪心打散（第一首因此换成
 * 另一个歌手），集合不变、只改先后。
 */
function rotateLeaderByVariant(tracks: Song[], variant: string): Song[] {
  if (tracks.length <= 2) return tracks.slice();
  const groups = new Map<string, Song[]>();
  for (let i = 0; i < tracks.length; i++) {
    const key = normText(tracks[i].singer) || "?";
    const bucket = groups.get(key);
    if (bucket != null) bucket.push(tracks[i]);
    else groups.set(key, [tracks[i]]);
  }
  const keys = Array.from(groups.keys());
  if (keys.length <= 1) return tracks.slice();
  const rotate = hashString(variant) % keys.length;
  const orderedKeys: string[] = [];
  for (let i = rotate; i < keys.length; i++) orderedKeys.push(keys[i]);
  for (let i = 0; i < rotate; i++) orderedKeys.push(keys[i]);
  const ordered: Song[] = [];
  for (let i = 0; i < orderedKeys.length; i++) {
    const bucket = groups.get(orderedKeys[i]);
    if (bucket != null) {
      for (let k = 0; k < bucket.length; k++) ordered.push(bucket[k]);
    }
  }
  return spreadItemsBySinger(ordered, (track: Song): string => track.singer);
}

/** rankCandidates 的可选参数 */
export interface RankCandidatesOptions {
  /** 硬排除键（`trackKey` / `songNameKey` 都会比对） */
  excludeKeys?: Set<string>;
  /** 最近推荐过的键：只降权，池子耗尽时仍会兜底出歌 */
  historyKeys?: Set<string>;
  playedKeys?: Set<string>;
  dislikedFlags?: boolean[];
  dateKey?: string;
  target?: number;
  /** 口味（缺省心动，与旧行为最接近） */
  taste?: DailyTaste;
  /** 「换一批」用的变体种子：同一天点换一批能换出不同顺序，但不影响缓存复现 */
  variant?: string;
}

/**
 * 规则排序。
 *
 * **2026-10-23 重写**：用户反馈「不应该根据你听过的歌手去推荐，应该根据你之前听过
 * 歌曲的风格等等各方面综合一起去推荐」。旧版把打分完全压在「歌手排名」上，导致
 * 推荐永远在那几个名字里打转，而且「点开听 20 秒就切」和「一遍遍听完」同分。
 *
 * 真正的打分手在 recommend-rank.ts：它同时看**语种 / 时长带 / 专辑 / 收藏 /
 * 播放质量（完播比、重播、新鲜度）/ 是否听过 / 历史推荐**，再用 MMR 保证结果
 * 不聚成一团。本函数只负责把本地偏好翻译成引擎参数。
 *
 * 取歌方式也不是「按分数降序截断」：MMR + 每歌手/每语种配额双保险，同一个歌手
 * 在结果里天然被摊开（降序截断会让一个人连排最前面，用户实测「每次都是这个歌手」）。
 */
export function rankCandidates(
  pool: Song[],
  pref: DailyPreference,
  options: RankCandidatesOptions = {},
): Song[] {
  const excludeKeys = options.excludeKeys != null ? options.excludeKeys : new Set<string>();
  const dislikedFlags = options.dislikedFlags != null ? options.dislikedFlags : [];
  const target = options.target != null ? options.target : DAILY_TARGET;
  const taste = options.taste != null ? options.taste : "heart";
  const dateKey = options.dateKey != null ? options.dateKey : todayKey();

  // 去重（跨源同名同歌只留一首）+ 硬排除。引擎的 `disliked` 是按下标对齐的，
  // 所以过滤和标记必须在同一轮里做完。
  const input: Song[] = [];
  const flags: boolean[] = [];
  const seenName = new Set<string>();
  for (let index = 0; index < pool.length; index++) {
    const song = pool[index];
    if (song == null || !song.id || !song.name) continue;
    const nameKey = songNameKeyOf(song);
    if (excludeKeys.has(trackKey(song)) || excludeKeys.has(nameKey)) continue;
    if (seenName.has(nameKey)) continue;
    seenName.add(nameKey);
    input.push(song);
    flags.push(index < dislikedFlags.length && dislikedFlags[index] == true);
  }

  const profile =
    pref.style != null
      ? pref.style
      : buildStyleProfile({ samples: samplesFromPreference(pref), playlistNames: [], now: Date.now() });
  const engineOptions: RankOptions = {
    taste,
    target,
    maxPerSinger: TASTE_MAX_PER_SINGER[taste],
    maxPerLang: null,
    diversity: null,
    variant: options.variant != null ? options.variant : null,
    dateKey,
    historyKeys: options.historyKeys != null ? options.historyKeys : null,
    playedKeys: options.playedKeys != null ? options.playedKeys : null,
    // 歌手榜是一手统计，但画像会因样本权重为 0 丢掉一部分歌 —— 两边合并才不会漏
    familiarSingers: familiarSingerKeys(pref),
    disliked: flags,
    quality: pref.qualities != null ? qualityRecord(pref.qualities) : null,
    savedKeys: savedKeySet(pref),
    excludeKeys: null,
    styles: null,
  };
  const picked = selectDiverse(scoreCandidates(input, profile, engineOptions), profile, engineOptions);
  const tracks: Song[] = [];
  for (let i = 0; i < picked.length; i++) tracks.push(picked[i].song);
  return options.variant != null ? rotateLeaderByVariant(tracks, options.variant) : tracks;
}

/** 规则模式的推荐理由：只陈述能验证的事实，不编故事 */
export function ruleReason(song: Song, pref: DailyPreference): string {
  const profile =
    pref.style != null
      ? pref.style
      : buildStyleProfile({ samples: samplesFromPreference(pref), playlistNames: [], now: Date.now() });
  const style = trackStyle(song);
  const key = trackKey(song);
  const nameKey = songNameKeyOf(song);
  const savedKeys = savedKeySet(pref);
  const hits: RankHit[] = [];
  if (savedKeys.has(key) || savedKeys.has(nameKey)) hits.push("saved");
  const albumWeight = style.albumKey.length > 0 ? numAt(profile.albums, style.albumKey) : 0;
  if (albumWeight > 0) hits.push("same-album");
  // 歌手熟悉度有三个来源，必须分开判断，因为**理由文案不同**：
  // 1. 有播放证据（歌手榜 / 播放统计 / 最近在听）→ 可以说「你常听 X」；
  // 2. 只在收藏/歌单里 → 只能说「和你的收藏口味相近」（收藏 ≠ 听过）；
  // 3. 画像 `singers` 有权重但上面两处都查不到 → 仍在画像里，算熟悉（防御式兜底）。
  if (isPlayedSinger(style.singerKey, pref)) {
    hits.push("familiar-singer");
  } else if (isSavedSinger(style.singerKey, pref)) {
    hits.push("saved-singer");
  } else if (style.singerKey.length > 0 && numAt(profile.singers, style.singerKey) > 0) {
    hits.push("familiar-singer");
  } else {
    hits.push("new-singer");
  }
  if (style.lang != "und") {
    hits.push(style.lang == profile.mainLang ? "main-lang" : "other-lang");
  }
  if (style.band == profile.mainBand) hits.push("main-band");
  // 没听过要单独说出来：空画像时所有歌都落到兜底文案，理由就没有信息量了。
  if (!isPlayed(song, pref)) hits.push("unplayed");
  const candidate: ScoredCandidate = { song, style, score: 0, hits };
  return reasonFor(candidate, profile, "heart");
}

/**
 * 「有播放证据」的歌手键集合。
 *
 * 三个来源都要收：topSingers（本模块聚合的常听榜，覆盖全部历史）、topTracks
 * （带完整统计的前 200 首）、recentTracks（最近在听）。**收藏/歌单里的歌手不算**：
 * 收藏 ≠ 听过。键的构造与 trackStyle().singerKey 一致（整串 normText，不拆分），
 * 否则合唱曲「甲/乙」永远匹配不上。
 */
function familiarSingerKeys(pref: DailyPreference): Set<string> {
  const keys = new Set<string>();
  const add = (raw: string): void => {
    const key = normText(raw != null ? raw : "");
    if (key.length > 0) keys.add(key);
  };
  for (let i = 0; i < pref.topSingers.length; i++) add(pref.topSingers[i]);
  const top = pref.topTracks != null ? pref.topTracks : [];
  for (let i = 0; i < top.length; i++) add(top[i].song.singer);
  for (let i = 0; i < pref.recentTracks.length; i++) add(pref.recentTracks[i].singer);
  return keys;
}

/** 该歌手是否有播放证据（常听榜 / 播放统计 / 最近播放） */
function isPlayedSinger(singerKey: string, pref: DailyPreference): boolean {
  if (singerKey.length == 0) return false;
  return familiarSingerKeys(pref).has(singerKey);
}

/** 该歌手是否只在收藏/歌单里出现过（没有任何播放证据） */
function isSavedSinger(singerKey: string, pref: DailyPreference): boolean {
  if (singerKey.length == 0) return false;
  for (let i = 0; i < pref.favoriteTracks.length; i++) {
    if (normText(pref.favoriteTracks[i].singer) == singerKey) return true;
  }
  for (let i = 0; i < pref.playlistTracks.length; i++) {
    if (normText(pref.playlistTracks[i].singer) == singerKey) return true;
  }
  return false;
}

/** 这首歌用户是否听过（播放统计 + 最近播放；收藏不算听过） */
function isPlayed(song: Song, pref: DailyPreference): boolean {
  const key = trackKey(song);
  const nameKey = songNameKeyOf(song);
  const top = pref.topTracks != null ? pref.topTracks : [];
  for (let i = 0; i < top.length; i++) {
    if (trackKey(top[i].song) == key || songNameKeyOf(top[i].song) == nameKey) return true;
  }
  for (let i = 0; i < pref.recentTracks.length; i++) {
    if (trackKey(pref.recentTracks[i]) == key || songNameKeyOf(pref.recentTracks[i]) == nameKey) {
      return true;
    }
  }
  return false;
}

/**
 * 把一批已选好的歌做**最小必要**的歌手摊开：相邻两首撞歌手才换位置。
 *
 * 模型回的是它自己排的序，偶尔会把同一个歌手连着排。这里只做一次顺扫：发现相邻
 * 撞歌手，就往**后**找最近的一首不同歌手交换。第一首永远不动（那是模型最看好的）。
 * 只调顺序、不增删歌；歌手太少时允许残留重复（那是数学上躲不掉的）。
 */
export function spreadItemsBySinger<T>(items: T[], singerOf: (item: T) => string): T[] {
  if (items.length <= 2) return items.slice();
  const result = items.slice();
  const key = (item: T): string => normText(singerOf(item));
  for (let i = 1; i < result.length; i++) {
    const duplicate = key(result[i]);
    if (duplicate != key(result[i - 1])) continue;
    for (let j = i + 1; j < result.length; j++) {
      if (key(result[j]) == duplicate) continue;
      const tmp = result[i];
      result[i] = result[j];
      result[j] = tmp;
      break;
    }
  }
  return result;
}

// ---------- 候选歌的「本地证据」 ----------

/**
 * 给提示词和校验共用的证据快照：一次算好，逐首查。
 *
 * 为什么要证据：模型只看到歌名/歌手/专辑/语种/时长，它能判断「风格像不像」，但
 * 判断不了「这首对你意味着什么」。给它「已收藏 / 听过 12 次 / 常听歌手 / 常听专辑」
 * 这类本地事实，它才有东西可抓，推荐理由也才落得到实处。
 */
interface EvidenceSnapshot {
  profile: StyleProfile;
  /** 收藏 + 歌单里的曲目键（trackKey 与 songNameKey 都算命中） */
  savedKeys: Set<string>;
  /** 有效播放次数：trackKey / songNameKey → 次数（播放统计的前 N 首） */
  playedCounts: Map<string, number>;
  /** 有播放证据的歌手（常听榜 / 播放统计 / 最近在听） */
  familiarSingers: Set<string>;
  /** 只在收藏/歌单里出现过的歌手 */
  savedSingers: Set<string>;
}

function evidenceSnapshot(pref: DailyPreference): EvidenceSnapshot {
  const profile =
    pref.style != null
      ? pref.style
      : buildStyleProfile({ samples: samplesFromPreference(pref), playlistNames: [], now: Date.now() });
  const playedCounts = new Map<string, number>();
  const top = pref.topTracks != null ? pref.topTracks : [];
  for (let i = 0; i < top.length; i++) {
    const count = Math.max(1, Math.round(top[i].stat.playCount));
    playedCounts.set(trackKey(top[i].song), count);
    playedCounts.set(songNameKeyOf(top[i].song), count);
  }
  const savedSingers = new Set<string>();
  const all: Song[] = [];
  for (let i = 0; i < pref.favoriteTracks.length; i++) all.push(pref.favoriteTracks[i]);
  for (let i = 0; i < pref.playlistTracks.length; i++) all.push(pref.playlistTracks[i]);
  for (let i = 0; i < all.length; i++) {
    const key = normText(all[i].singer != null ? all[i].singer : "");
    if (key.length > 0) savedSingers.add(key);
  }
  return {
    profile,
    savedKeys: savedKeySet(pref),
    playedCounts,
    familiarSingers: familiarSingerKeys(pref),
    savedSingers,
  };
}

/** 单首候选在本地数据里的依据 */
interface TrackEvidence {
  saved: boolean;
  /** 有效播放次数，0 表示没听过 */
  plays: number;
  familiarSinger: boolean;
  savedSinger: boolean;
  sameAlbum: boolean;
  /** 语种与画像主语种一致（画像定不下语种时为 false） */
  mainLang: boolean;
  /** 语种检测得出来、且这个语种在画像里的占比够（≥ LANG_AFFINITY_MIN） */
  langAffinity: boolean;
  /** 语种检测得出来、但画像里几乎没有这个语种 —— 只有这种才值得提醒模型 */
  otherLang: boolean;
  mainBand: boolean;
}

function trackEvidence(song: Song, snapshot: EvidenceSnapshot): TrackEvidence {
  const style = trackStyle(song);
  const key = trackKey(song);
  const nameKey = songNameKeyOf(song);
  const profile = snapshot.profile;
  const singer = style.singerKey;
  const langKnown = style.lang != "und" && profile.mainLang != "und";
  const langAffinity =
    style.lang != "und" && profile.sampleSize > 0 && numAt(profile.langs, style.lang) >= LANG_AFFINITY_MIN;
  const playedByKey = snapshot.playedCounts.get(key);
  const playedByName = snapshot.playedCounts.get(nameKey);
  const plays = Math.max(playedByKey != null ? playedByKey : 0, playedByName != null ? playedByName : 0);
  return {
    saved: snapshot.savedKeys.has(key) || snapshot.savedKeys.has(nameKey),
    plays,
    familiarSinger:
      singer.length > 0 && (snapshot.familiarSingers.has(singer) || numAt(profile.singers, singer) > 0),
    savedSinger: singer.length > 0 && snapshot.savedSingers.has(singer),
    sameAlbum: style.albumKey.length > 0 && numAt(profile.albums, style.albumKey) > 0,
    mainLang: langKnown && style.lang == profile.mainLang,
    langAffinity,
    otherLang: langKnown && style.lang != profile.mainLang && !langAffinity,
    mainBand: style.band == profile.mainBand,
  };
}

/** 拼成行尾括号里那截证据文字（最多 3 条，按可信度排） */
function evidenceText(evidence: TrackEvidence): string[] {
  const marks: string[] = [];
  if (evidence.saved) marks.push("已收藏");
  if (evidence.plays > 0) marks.push(`听过${evidence.plays}次`);
  if (evidence.familiarSinger) marks.push("常听歌手");
  else if (evidence.savedSinger) marks.push("收藏歌手");
  if (evidence.sameAlbum) marks.push("常听专辑");
  // 和画像里所有语种都对不上 —— 这是模型最需要知道的一条，用来防「为了凑风格塞首英文歌」
  if (evidence.otherLang) marks.push("非主语种");
  return marks.slice(0, 3);
}

/**
 * 这首歌在本地数据里「有没有依据」。
 *
 * 语种/时长带属于**画像级**证据：只要语种对得上就算贴合；歌手/专辑/收藏/播放属于
 * **单曲级**证据，有就更能说明「这首真的是他的」。时长带单独不算依据 ——
 * 三四分钟的歌满大街都是，它解释不了「为什么是这首」。
 *
 * v9 起多认两条：①画像里次要语种（≥5%）也算语种依据 —— 用户明确要「风格多变」，
 * 不能一边扩候选池一边把画像边缘的语种全剔掉；②来自**画像相关维度线**的歌
 * （`laneGrounded`）也算依据，它们本来就是「从用户的搜索维度里搜出来的」，
 * 不是随机尾巴。榜单里的通用热歌不算。
 */
function hasProfileGrounding(evidence: TrackEvidence, laneGrounded: boolean = false): boolean {
  return (
    evidence.saved ||
    evidence.plays > 0 ||
    evidence.familiarSinger ||
    evidence.savedSinger ||
    evidence.sameAlbum ||
    evidence.mainLang ||
    evidence.langAffinity ||
    laneGrounded
  );
}

// ---------- 提示词 ----------

/**
 * 组装发给模型的 messages；候选池就是编号清单，模型只能回序号。
 *
 * `taste` 决定「按什么方向挑」，写进 user 段；缺省心动模式。
 *
 * v8（2026-10-24）：用户反馈结果「像随机选」。清单已按贴合度排序要告诉模型；
 * 每行括号里补时长带与本地行为证据；显式给出语种下限；删掉「求分散」措辞，
 * 改成「求主题一致 + 覆盖多条风格线」。中段（51–90）换 6–10 首，超额由
 * `limitAiPicks` 封顶，不指望小模型自觉。
 *
 * v9（2026-10-24）：候选池扩维度后，每行标出这首歌来自哪条风格线，画像里补
 * 语种分布，「主风格约一半、相邻线各 4–10 首」，语种下限保留并把「剩下的 N 首」
 * 明确指给画像里出现过的其它语种。
 */
export function buildPrompt(
  pool: Song[],
  pref: DailyPreference,
  pickCount: number,
  taste: DailyTaste = "heart",
  laneOf?: Map<string, string[]>,
): { role: string; content: string }[] {
  const snapshot = evidenceSnapshot(pref);
  const profile = pref.style != null ? pref.style : snapshot.profile;
  // 候选池里出现了哪些风格线、每条线几首 —— 用来给模型可对账的「线清单」
  const laneCountMap = new Map<string, number>();
  for (let i = 0; i < pool.length; i++) {
    const labels = laneOf != null ? laneOf.get(trackKey(pool[i])) : null;
    const label = labels != null && labels.length > 0 ? labels[0] : "";
    if (label.length == 0) continue;
    const prev = laneCountMap.get(label);
    laneCountMap.set(label, (prev != null ? prev : 0) + 1);
  }
  const laneRank: { label: string; count: number }[] = [];
  const laneMapKeys = Array.from(laneCountMap.keys());
  for (let i = 0; i < laneMapKeys.length; i++) {
    const count = laneCountMap.get(laneMapKeys[i]);
    laneRank.push({ label: laneMapKeys[i], count: count != null ? count : 0 });
  }
  laneRank.sort((a, b): number => b.count - a.count);
  const lines: string[] = [];
  for (let i = 0; i < pool.length; i++) {
    const song = pool[i];
    const style = trackStyle(song);
    const marks: string[] = [];
    const labels = laneOf != null ? laneOf.get(trackKey(song)) : null;
    const lane = labels != null && labels.length > 0 ? labels[0] : "";
    if (lane.length > 0) marks.push(`风格线：${lane}`);
    if (song.album != null && song.album.length > 0) marks.push(song.album);
    if (style.lang != "und") marks.push(musicLangLabel(style.lang));
    marks.push(durationBandLabel(style.band));
    const evidence = evidenceText(trackEvidence(song, snapshot));
    const markText = marks.join(" / ");
    const evidenceStr = evidence.join("·");
    const detail =
      markText.length > 0 && evidenceStr.length > 0
        ? markText + "；" + evidenceStr
        : markText.length > 0
          ? markText
          : evidenceStr;
    lines.push(`${i + 1}. ${song.name} - ${song.singer}（${detail}）`);
  }
  const profileText = pref.style != null ? describeProfile(profile) : "口味还不明显";
  const tagText = profile.tags.length > 0 ? profile.tags.slice(0, 4).join("、") : "（暂无）";
  const singerList = pref.topSingers.slice(0, 6);
  const singerText = singerList.length > 0 ? singerList.join("、") : "（暂无）";
  const recentList = pref.recentTracks.slice(0, 5);
  let recentText = "";
  for (let i = 0; i < recentList.length; i++) {
    if (i > 0) recentText += "、";
    recentText += `${recentList[i].name}-${recentList[i].singer}`;
  }
  if (recentText.length == 0) recentText = "（暂无）";
  const system = [
    "你是音乐推荐助手。你会收到一份客户端已经搜索好的候选歌曲清单，",
    "你只能从清单里挑选，绝不能编造清单之外的歌曲，也不能输出歌曲 ID。",
    "你的目标是让这份歌单听起来像同一个人按同一套口味挑出来的，",
    "同时要覆盖他常听的几种风格线，而不是只挑一条线、也不是随机抽样拼盘。",
    "只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏。",
  ].join("");
  // 语种分布：v9 要告诉模型「他不是只听华语」，画像里的次要语种也允许上桌
  const langEntries: { lang: string; share: number }[] = [];
  const langKeys = Object.keys(profile.langs);
  for (let i = 0; i < langKeys.length; i++) {
    const share = numAt(profile.langs, langKeys[i]);
    if (share >= LANG_AFFINITY_MIN) langEntries.push({ lang: langKeys[i], share });
  }
  langEntries.sort((a, b): number => b.share - a.share);
  const langTop = langEntries.slice(0, 3);
  let langDistText: string | null = null;
  if (langTop.length > 1) {
    let parts = "";
    for (let i = 0; i < langTop.length; i++) {
      if (i > 0) parts += "、";
      parts += `${musicLangLabel(langTop[i].lang)} ${Math.round(langTop[i].share * 100)}%`;
    }
    langDistText = `画像里的语种分布：${parts}`;
  }
  const mainLangLabel = profile.mainLang != "und" ? musicLangLabel(profile.mainLang) : "";
  const otherLangLabels: string[] = [];
  for (let i = 0; i < langTop.length; i++) {
    if (langTop[i].lang != profile.mainLang) otherLangLabels.push(musicLangLabel(langTop[i].lang));
  }
  // 语种下限：画像主语种定得下来时，给小模型一个能对账的数字。
  // v9 起给「剩下的 N 首」一条明路：可以从画像里出现过的其它语种里挑。
  let langLine: string | null = null;
  if (profile.mainLang != "und") {
    if (taste == "explore") {
      langLine = `他平时主要听${mainLangLabel}：这次可以换歌手换风格、多碰几条线，但主语种别整体放弃（${pickCount} 首里至少 ${Math.round(pickCount * 0.5)} 首是${mainLangLabel}）。`;
    } else {
      const mainCount = Math.round(pickCount * 0.8);
      let tail = "";
      if (otherLangLabels.length > 0) {
        tail = `；剩下的 ${pickCount - mainCount} 首可以从画像里的其它语种里挑（${otherLangLabels.join(" / ")}），但别选画像里完全没出现过的语种`;
      }
      langLine = `他平时主要听${mainLangLabel}：${pickCount} 首里请至少有 ${mainCount} 首是${mainLangLabel}${tail}。`;
    }
  }
  const mainBandLabel = durationBandLabel(profile.mainBand);
  // 风格线：候选池里真有几条线，就按实际条数给目标；线数 ≤3 时直接说「覆盖 N 条」
  const laneGoalMax = Math.min(LANE_GOAL_MAX, Math.max(1, laneRank.length));
  const laneGoal = laneRank.length >= 4 ? `3–${laneGoalMax}` : `${laneRank.length}`;
  let laneListText = "";
  const laneTop = laneRank.slice(0, 6);
  for (let i = 0; i < laneTop.length; i++) {
    if (i > 0) laneListText += "、";
    laneListText += `${laneTop[i].label}（${laneTop[i].count} 首）`;
  }
  const mainLaneLabel = laneRank.length > 0 ? laneRank[0].label : "";
  const laneRule =
    laneRank.length > 0
      ? `这张歌单要覆盖 ${laneGoal} 条不同的「风格线」（每行括号里标了这首歌来自哪条线；候选里一共 ${
          laneRank.length
        } 条：${laneListText}）：${
          mainLaneLabel.length > 0 ? `「${mainLaneLabel}」` : "主风格线"
        }占一半左右（约 ${Math.round(
          pickCount / 2,
        )} 首），再从里面挑 2–4 条相邻的线各 4–10 首。同一条线内部要连贯，线跟线之间要听得出区别（语种 / 风格 / 情绪 / 场景 / 年代都算一条线）。`
      : `这张歌单要有 2–3 种明显不同的风格（语种 / 风格 / 情绪 / 场景 / 年代都算），不要 50 首都是同一种；同一类内部要连贯。`;
  // 中段穿插：只有池子确实比 pickCount 长、且中段还有歌时才写这条
  const midFrom = pickCount + 1;
  const midTo = Math.min(DAILY_AI_CORE, pool.length);
  const midCount = midTo - midFrom + 1;
  let midRule: string | null = null;
  if (midCount >= 6) {
    midRule = `别把清单前 ${pickCount} 首整份照抄：第 ${midFrom}–${midTo} 首里也有风格贴合、只是播放次数不高的歌，请从中挑 6–${Math.min(10, midCount)} 首换进来（换进来的一定要带证据）；播放顺序按「开场 → 沉浸 → 收束」自己排，不要照抄清单顺序。`;
  } else if (midCount >= 1) {
    midRule = `别把清单前 ${pickCount} 首整份照抄：第 ${midFrom}–${midTo} 首里也有风格贴合、只是播放次数不高的歌，可以挑 ${midCount} 首换进来；播放顺序按「开场 → 沉浸 → 收束」自己排，不要照抄清单顺序。`;
  }
  // 用 ①②③ 而不是 1. 2. 3.：候选清单本身就是「序号. 歌名」的格式，再用数字
  // 编号规则会被模型当成候选行。编号不写死（中段那条可能整体不出现）。
  const rules: string[] =
    taste == "explore"
      ? [
          "清单已经按「和画像的贴合度」从高到低排好，越靠前越贴合；这次用户想探索，优先挑靠前、歌手陌生、但风格仍在他接受范围内的歌。",
          laneRank.length > 0
            ? `这张歌单要覆盖 ${laneGoal} 条风格线，其中至少 2 条是他平时不常听的（新风格 / 新语种 / 新年代）；每条线至少要 3 首，否则听不出一条线。`
            : "这张歌单要覆盖 2–3 种明显不同的风格，其中至少 2 种是他平时不常听的。",
          "括号里标了「非主语种」的歌可以挑，但要有风格线支撑（属于某条相邻的线），别整张歌单变成随机拼盘。",
          `同一位歌手最多 ${DAILY_MAX_PER_SINGER} 首；不要重复挑同一首。`,
          "每首理由写清「哪里不一样」（新歌手 / 新风格 / 新语种 / 新的年代），不要写「值得一听」这种空话。",
          "title 和 summary 要写出这张歌单的多风格结构（例如「古风打底，掺几首粤语和纯音乐」），不要只写一个主题。",
        ]
      : [
          "清单已经按「和画像的贴合度」从高到低排好，越靠前越贴合：优先挑靠前的歌，以及括号里带「已收藏 / 听过 / 常听歌手 / 常听专辑」证据的歌。",
          laneRule,
          "但别为了「看起来多样」去挑和画像无关的歌：每条线都要能说出它为什么适合他（来自他的收藏 / 常听歌手 / 主语种 / 搜索过的词）；括号里标了「非主语种」、又不在任何一条线里的歌不要选。",
          `同一位歌手最多 ${DAILY_MAX_PER_SINGER} 首；不要重复挑同一首；清单最前面几首明显贴合的歌不要漏掉。`,
          ...(midRule != null ? [midRule] : []),
          "每首理由必须点出「这条风格线 + 和画像的对应」（例如「古风线里最接近你的收藏」「粤语线，和你常听的陈奕迅同语种」），不要写「值得一听」「很有感觉」这种空话。",
          "title 和 summary 要写出这张歌单的多风格结构（例如「古风打底，掺几首粤语和纯音乐」），不要只写一个主题。",
        ];
  const numberedRules: string[] = [];
  for (let i = 0; i < rules.length; i++) {
    const mark = i < RULE_MARKS.length ? RULE_MARKS[i] : `${i + 1}.`;
    numberedRules.push(`${mark} ${rules[i]}`);
  }
  const userParts: string[] = [
    `候选歌曲（共 ${pool.length} 首）：`,
    ...lines,
    "",
    `用户的音乐口味画像：${profileText}`,
    `画像里的风格标签：${tagText}`,
    ...(langDistText != null ? [langDistText] : []),
    `画像的主时长带：${mainBandLabel}`,
    `用户的常听歌手：${singerText}`,
    `用户最近在听：${recentText}`,
    "",
    TASTE_PROMPT[taste],
    ...(langLine != null ? [langLine] : []),
    `请从上面挑 ${pickCount} 首，按「你希望他今天按什么顺序听」排好（第 1 首是开场），并覆盖上面说的几条风格线；每首给一句不超过 20 字的中文推荐理由。`,
    "括号里依次是：风格线（如果这首歌来自额外维度的搜索）/ 专辑 / 语种 / 时长带，以及本地收听证据（已收藏 / 听过 N 次 / 常听歌手 / 常听专辑 / 非主语种）；挑选时优先用有证据、有线可归的歌。",
    ...numberedRules,
    "输出格式：",
    '{"title":"今天歌单的一句话主题","summary":"一句话说明","picks":[{"index":1,"reason":"理由"}]}',
    "index 必须是上面清单里的序号。",
  ];
  return [
    { role: "system", content: system },
    { role: "user", content: userParts.join("\n") },
  ];
}

// ---------- 模型回执解析 ----------

/** 单条挑选：候选清单里的序号 + 一句理由 */
export interface AiPick {
  index: number;
  reason: string;
}

/** 模型回执解析结果 */
export interface ParsedPicks {
  title: string;
  summary: string;
  picks: AiPick[];
  /** 解析失败原因（成功为 null） */
  error: string | null;
}

function isWs(ch: string): boolean {
  return ch == " " || ch == "\t" || ch == "\n" || ch == "\r";
}

/**
 * 把小模型常见「差一点就是合法 JSON」的输出修回来：理由里的裸控制字符、
 * 数组/对象最后一个元素后面的多余逗号。这两种都不改变模型的意思，修回来
 * 是还原、不是编造；真正的语义问题（越界、重复）仍由硬校验拦。
 */
function repairJsonText(text: string): string {
  let repaired = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    repaired += code < 0x20 ? " " : text[i];
  }
  // 尾逗号：`, \s* [}\]]` → 丢掉逗号（手动扫描，不依赖带回引用的正则替换）
  let out = "";
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (ch == ",") {
      let j = i + 1;
      while (j < repaired.length && isWs(repaired[j])) j += 1;
      if (j < repaired.length && (repaired[j] == "}" || repaired[j] == "]")) continue;
    }
    out += ch;
  }
  return out;
}

/** 从坏了但还能看出结构的回执里捞序号（JSON 彻底解析不了时的最后一手） */
function salvagePicks(raw: string, poolSize: number): AiPick[] {
  const picks: AiPick[] = [];
  const used: number[] = [];
  const push = (index: number, reason: string): void => {
    if (Math.floor(index) != index || index < 1 || index > poolSize || used.indexOf(index) >= 0) return;
    used.push(index);
    picks.push({ index, reason: reason.slice(0, 30) });
  };
  // 形态 A：`{"picks":[{"index":3,"reason":"…"}, …]}` —— 逐个 `"index":` 段捞
  let cursor = raw.indexOf("\"index\"");
  while (cursor >= 0) {
    let p = cursor + 7;
    while (p < raw.length && isWs(raw[p])) p += 1;
    if (p < raw.length && raw[p] == ":") {
      p += 1;
      while (p < raw.length && isWs(raw[p])) p += 1;
      if (p < raw.length && raw[p] == "\"") p += 1;
      let digits = "";
      while (
        p < raw.length &&
        digits.length < 4 &&
        raw.charCodeAt(p) >= 48 &&
        raw.charCodeAt(p) <= 57
      ) {
        digits += raw[p];
        p += 1;
      }
      if (digits.length > 0) {
        // 同一段里的 `"reason":"…"`：取到第一个引号/反斜杠为止，最多 60 字
        let reason = "";
        const rest = raw.substring(p, Math.min(raw.length, p + 200));
        const reasonAt = rest.indexOf("\"reason\"");
        if (reasonAt >= 0) {
          let q = reasonAt + 8;
          while (q < rest.length && isWs(rest[q])) q += 1;
          if (q < rest.length && rest[q] == ":") {
            q += 1;
            while (q < rest.length && isWs(rest[q])) q += 1;
            if (q < rest.length && rest[q] == "\"") {
              q += 1;
              while (
                q < rest.length &&
                reason.length < 60 &&
                rest[q] != "\"" &&
                rest[q] != "\\"
              ) {
                reason += rest[q];
                q += 1;
              }
            }
          }
        }
        push(parseInt(digits, 10), reason.trim());
      }
    }
    cursor = raw.indexOf("\"index\"", cursor + 7);
  }
  // 形态 B：`{"picks":[3,17,42]}` —— 小模型偷懒只给序号数组
  if (picks.length == 0) {
    const at = raw.indexOf("\"picks\"");
    if (at >= 0) {
      let p = at + 7;
      while (p < raw.length && isWs(raw[p])) p += 1;
      let ok = p < raw.length && raw[p] == ":";
      if (ok) {
        p += 1;
        while (p < raw.length && isWs(raw[p])) p += 1;
        ok = p < raw.length && raw[p] == "[";
        if (ok) {
          p += 1;
          let seg = "";
          while (p < raw.length && raw[p] != "]") {
            const ch = raw[p];
            if (isWs(ch) || ch == "," || (ch.charCodeAt(0) >= 48 && ch.charCodeAt(0) <= 57)) {
              seg += ch;
            } else {
              ok = false;
              break;
            }
            p += 1;
          }
          if (ok && seg.trim().length > 0) {
            const parts = seg.split(",");
            for (let i = 0; i < parts.length; i++) {
              const t = parts[i].trim();
              if (isDigitString(t)) push(parseInt(t, 10), "");
            }
          }
        }
      }
    }
  }
  return picks;
}

/** 从回执文本里捞一个字符串字段（title/summary 兜底用） */
function salvageField(raw: string, field: string, max: number): string {
  const at = raw.indexOf("\"" + field + "\"");
  if (at < 0) return "";
  let p = at + field.length + 2;
  while (p < raw.length && isWs(raw[p])) p += 1;
  if (p >= raw.length || raw[p] != ":") return "";
  p += 1;
  while (p < raw.length && isWs(raw[p])) p += 1;
  if (p >= raw.length || raw[p] != "\"") return "";
  p += 1;
  let text = "";
  const limit = max * 2;
  while (p < raw.length && text.length < limit && raw[p] != "\"" && raw[p] != "\\") {
    text += raw[p];
    p += 1;
  }
  return text.trim().slice(0, max);
}

/** 硬校验：序号必须在 1..poolSize 内、不能重复；`Number(true)` 那类「看似合法」的值不收 */
function normalizePicks(rawPicks: any[], poolSize: number): AiPick[] {
  const picks: AiPick[] = [];
  const used: number[] = [];
  for (let i = 0; i < rawPicks.length; i++) {
    const item = rawPicks[i];
    // 允许 `[3, 17, 42]` 这种纯序号写法（同样的越界/重复规则）
    if (typeof item == "number") {
      const index = item as number;
      if (Math.floor(index) != index || index < 1 || index > poolSize || used.indexOf(index) >= 0) {
        continue;
      }
      used.push(index);
      picks.push({ index, reason: "" });
      continue;
    }
    if (typeof item == "string") {
      const trimmed = (item as string).trim();
      if (!isDigitString(trimmed)) continue;
      const index = parseInt(trimmed, 10);
      if (index < 1 || index > poolSize || used.indexOf(index) >= 0) continue;
      used.push(index);
      picks.push({ index, reason: "" });
      continue;
    }
    if (item == null || typeof item != "object") continue;
    const entry = item as any;
    // 只接受数字或纯数字字符串：放过布尔值等于接受一个模型根本没给的序号
    const rawIndex = entry.index;
    let index: number = -1;
    if (typeof rawIndex == "number") {
      index = rawIndex as number;
    } else if (typeof rawIndex == "string" && isDigitString((rawIndex as string).trim())) {
      index = parseInt((rawIndex as string).trim(), 10);
    }
    if (Math.floor(index) != index) continue;
    if (index < 1 || index > poolSize) continue;
    if (used.indexOf(index) >= 0) continue;
    used.push(index);
    const rawReason = entry.reason;
    const reason = typeof rawReason == "string" ? (rawReason as string).trim().slice(0, 30) : "";
    picks.push({ index, reason });
  }
  return picks;
}

/**
 * 解析模型输出并做**硬校验**：序号必须在 1..pool.length 内、不能重复。
 *
 * 越界/重复的条目直接丢（不是纠正成别的歌 —— 纠正等于替模型编造）。整段解析
 * 不出来才返回 error，调用方退回规则结果。按「先修后捞」三级降级：
 * 原样解析 → 修复后解析（裸换行/尾逗号）→ 扫描捞序号。
 */
export function parsePicks(raw: string, poolSize: number): ParsedPicks {
  const json = extractJsonObject(raw);
  if (json == null) {
    // 模型偷懒只回了一排序号：`[3,7,9]`
    const arrayText = extractJsonArray(raw);
    if (arrayText != null) {
      try {
        const parsedArray = JSON.parse(arrayText) as any | null;
        if (parsedArray != null && Array.isArray(parsedArray)) {
          const picks = normalizePicks(parsedArray as any[], poolSize);
          if (picks.length > 0) return { title: "", summary: "", picks, error: null };
        }
      } catch {
        // 数组也坏了，继续用扫描捞
      }
    }
    const picks = salvagePicks(raw, poolSize);
    if (picks.length == 0) {
      return { title: "", summary: "", picks: [], error: "模型没有返回 JSON" };
    }
    return {
      title: salvageField(raw, "title", 40),
      summary: salvageField(raw, "summary", 120),
      picks,
      error: null,
    };
  }
  let data: any | null = null;
  try {
    data = JSON.parse(json) as any | null;
  } catch {
    try {
      data = JSON.parse(repairJsonText(json)) as any | null;
    } catch {
      // 结构都读不出来（例如理由里没转义的引号把字符串截断了）：捞序号总比整批作废强
      const picks = salvagePicks(raw, poolSize);
      if (picks.length == 0) {
        return { title: "", summary: "", picks: [], error: "模型返回的 JSON 无法解析" };
      }
      return {
        title: salvageField(raw, "title", 40),
        summary: salvageField(raw, "summary", 120),
        picks,
        error: null,
      };
    }
  }
  if (data == null || typeof data != "object") {
    return { title: "", summary: "", picks: [], error: "模型返回的不是对象" };
  }
  const obj = data as any;
  const title = typeof obj.title == "string" ? (obj.title as string).trim().slice(0, 40) : "";
  const summary = typeof obj.summary == "string" ? (obj.summary as string).trim().slice(0, 120) : "";
  const picks = Array.isArray(obj.picks) ? normalizePicks(obj.picks as any[], poolSize) : [];
  if (picks.length == 0) {
    return { title, summary, picks, error: "模型没有给出有效的候选序号" };
  }
  return { title, summary, picks, error: null };
}

// ---------- 主流程 ----------

/**
 * 从规则结果里挑出交给模型的候选池。
 *
 * 规则前 `DAILY_AI_CORE` 首必进（它们是最符合口味的那批，模型不该被剥夺选择权），
 * 其余名额从尾巴里按 `variant` 轮转取样 —— 不这么做的话，「换一批」之后模型看到
 * 的还是同一批歌，AI 模式就退化成「给规则歌单换个顺序」。
 */
export function pickAiPool(picked: Song[], variant?: string): Song[] {
  if (picked.length <= DAILY_AI_POOL_MAX) return picked.slice();
  const coreSize = Math.min(DAILY_AI_CORE, picked.length);
  const core = picked.slice(0, coreSize);
  const rest = picked.slice(coreSize);
  if (rest.length == 0) return core;
  const tail: Song[] = [];
  const want = DAILY_AI_POOL_MAX - core.length;
  const offset = variant != null ? hashString(variant) % rest.length : 0;
  for (let i = 0; i < rest.length && tail.length < want; i++) {
    tail.push(rest[(offset + i) % rest.length]);
  }
  const out: Song[] = [];
  for (let i = 0; i < core.length; i++) out.push(core[i]);
  for (let i = 0; i < tail.length; i++) out.push(tail[i]);
  return out;
}

/**
 * 风格线信息：只给「有没有依据」这道闸用。
 *
 * `laneOf` 是维度搜索带回来的 provenance（`trackKey` → 这条歌来自哪几条风格线），
 * `affinityLanes` 是其中**由画像/搜索历史推出来**的线（tag/语种/相邻风格/搜索词），
 * 榜单线（热歌榜/飙升榜）不算 —— 榜单上的歌谁都能看见，不能当「他的依据」。
 */
export interface AiLaneOptions {
  laneOf?: Map<string, string[]>;
  affinityLanes?: Set<string>;
}

/** 这首歌是不是来自一条「和画像有关」的风格线 */
function laneGrounded(song: Song, lanes: AiLaneOptions | null): boolean {
  if (lanes == null) return false;
  const laneMap = lanes.laneOf;
  const affinity = lanes.affinityLanes;
  if (laneMap == null || affinity == null || affinity.size == 0) return false;
  const labels = laneMap.get(trackKey(song));
  if (labels == null) return false;
  for (let i = 0; i < labels.length; i++) {
    if (affinity.has(labels[i])) return true;
  }
  return false;
}

/**
 * 模型挑好的歌，再过一道「本地有没有依据」的校验。
 *
 * 为什么要这道闸：提示词再怎么改，小模型偶尔还是会「为了不一样」从 150 首候选的
 * 尾部摸几首凑数，用户看不出模型为什么选它，只能得出「像随机选」的结论。
 *
 * 校验只用本地事实：收藏、听过、常听歌手、收藏歌手、常听专辑、主语种一致。
 * 一条都不占的歌直接丢掉，由调用方用规则结果补位（规则结果本身就能给出理由）。
 * `explore` 口味**不校验** —— 探索本来就要推陌生歌，拿画像去筛会把它筛空。
 */
export function filterAiPicks(
  items: DailyRecommendItem[],
  pref: DailyPreference,
  taste: DailyTaste,
  lanes?: AiLaneOptions,
): DailyRecommendItem[] {
  if (taste == "explore") return items.slice();
  const snapshot = evidenceSnapshot(pref);
  if (snapshot.profile.mainLang == "und" && snapshot.profile.sampleSize == 0) {
    // 画像还没成形时无从判断「有没有依据」，硬筛等于随机砍一刀
    return items.slice();
  }
  const out: DailyRecommendItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const evidence = trackEvidence(items[i].song, snapshot);
    if (hasProfileGrounding(evidence, laneGrounded(items[i].song, lanes != null ? lanes : null))) {
      out.push(items[i]);
    }
  }
  return out;
}

/**
 * 把模型回的序号翻成歌，并给「规则前 50 首之外」的挑选封顶。
 *
 * 提示词管不住的部分就用代码管：中段最多留 `DAILY_AI_OFF_CORE_MAX` 首（约 1/4），
 * 而且每首都必须过「画像依据」校验。主干仍是规则前 50 首，所以结果既不会和规则
 * 推荐一模一样，也不会像随机抽样。`explore` 口味不封顶：探索本来就要推清单后面的
 * 陌生歌。
 */
export function limitAiPicks(
  picks: AiPick[],
  pool: Song[],
  pref: DailyPreference,
  taste: DailyTaste,
  lanes?: AiLaneOptions,
): DailyRecommendItem[] {
  const items: DailyRecommendItem[] = [];
  const explore = taste == "explore";
  const snapshot = evidenceSnapshot(pref);
  let offCore = 0;
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    const song = pool[pick.index - 1];
    if (song == null) continue;
    if (!explore && pick.index > DAILY_TARGET) {
      if (offCore >= DAILY_AI_OFF_CORE_MAX) continue;
      if (!hasProfileGrounding(trackEvidence(song, snapshot), laneGrounded(song, lanes != null ? lanes : null))) {
        continue;
      }
      offCore += 1;
    }
    const reason = pick.reason.length > 0 ? pick.reason : ruleReason(song, pref);
    items.push({ song, reason });
  }
  return items;
}

/** 模型挑选最多问几次：第一次被截断/写坏，再问一次通常就好了（qt-pc 语义保留） */
const AI_PICK_ATTEMPTS = 2;

/** 第一次调模型的温度（推荐不是写诗：0.4 留一点措辞变化，「挑哪几首」由清单顺序决定） */
const AI_PICK_TEMPERATURE = 0.4;

/** 重试温度：这次只要格式，不要再换一批歌 */
const AI_PICK_RETRY_TEMPERATURE = 0.2;

/**
 * 让模型从候选池里挑，带一次重试（qt-pc：ipc.aiLocalChat + 低温重试）。
 *
 * 2026-10-24 起接入 uniappx 的 services/ai-providers（设置 · AI · 接口配置）：
 * buildPrompt 组装完整对话，aiLocalChat 只是哑管道；解析走 parsePicks 的
 * 三级兜底。第一轮 0.4，解析失败时追加一条「上一次不是合法 JSON」的纠正
 * 消息再试一轮 0.2 —— 两轮都失败就抛给 generateDailyRecommend 退回规则。
 */
async function askModelForPicks(
  pool: Song[],
  pref: DailyPreference,
  pickCount: number,
  taste: DailyTaste,
  laneOf?: Map<string, string[]>,
): Promise<{ parsed: ParsedPicks; model: string }> {
  const baseMessages = buildPrompt(pool, pref, pickCount, taste, laneOf);
  const minPicks = Math.min(DAILY_AI_MIN_PICKS, pool.length);
  const messages: AiLocalMessage[] = [];
  for (let i = 0; i < baseMessages.length; i++) {
    const m = baseMessages[i];
    messages.push({ role: m.role as "system" | "user" | "assistant", content: m.content });
  }
  let lastRaw = "";
  for (let attempt = 0; attempt < AI_PICK_ATTEMPTS; attempt++) {
    const temperature = attempt == 0 ? AI_PICK_TEMPERATURE : AI_PICK_RETRY_TEMPERATURE;
    if (attempt > 0) {
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({
        role: "user",
        content: "上一次的回复不是合法 JSON，请只输出一个 JSON 对象，格式：{\"title\":\"...\",\"summary\":\"...\",\"picks\":[{\"index\":1,\"reason\":\"...\"}]}，不要加任何其它文字。",
      });
    }
    const reply = await aiLocalChat(messages, temperature);
    lastRaw = reply.content;
    const parsed = parsePicks(reply.content, pool.length);
    if (parsed.picks.length >= minPicks) {
      return { parsed, model: reply.model };
    }
  }
  throw new Error("模型没有按清单给出可用的选择");
}

/**
 * 服务端 AI 精选：借音乐助手跑一轮，把回执解析成 picks。
 *
 * 两段容错：先按每日推荐的契约（`{"title","summary","picks":[{"index"}]}`）解析；
 * 解析不出来（服务端助手往往直接说人话 + 给曲目块）就把回执里的曲目按
 * `trackKey` 对回候选池序号，理由用规则文案垫上 —— 宁可理由是模板的，也别
 * 因为格式不同就整批退回规则。
 */
async function pickByServer(
  pool: Song[],
  pref: DailyPreference,
  pickCount: number,
  taste: DailyTaste,
  laneOf: Map<string, string[]> | undefined,
): Promise<{ parsed: ParsedPicks; model: string }> {
  const reply = await askServerForPicks({
    pool,
    messages: buildPrompt(pool, pref, pickCount, taste, laneOf),
  });
  const parsed = parsePicks(reply.content, pool.length);
  if (parsed.error == null && parsed.picks.length >= DAILY_AI_MIN_PICKS) {
    return { parsed, model: reply.model };
  }

  const indexOf = new Map<string, number>();
  for (let i = 0; i < pool.length; i++) indexOf.set(trackKey(pool[i]), i + 1);
  const picks: AiPick[] = [];
  for (let i = 0; i < reply.tracks.length; i++) {
    const song = reply.tracks[i];
    const index = indexOf.get(trackKey(song));
    if (index == null) continue;
    let dup = false;
    for (let k = 0; k < picks.length; k++) {
      if (picks[k].index == index) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    picks.push({ index, reason: ruleReason(song, pref) });
  }
  if (picks.length == 0) {
    throw new Error(parsed.error != null ? parsed.error : "服务端没挑出可用的歌");
  }
  return { parsed: { title: "", summary: "", picks, error: null }, model: reply.model };
}

export interface GenerateOptions {
  /** 强制重算（「换一批」）；默认命中当天缓存就直接返回 */
  force?: boolean;
  /** 指定模式；不传读设置 */
  mode?: DailyRecommendMode;
  /** 指定口味；不传读设置 */
  taste?: DailyTaste;
  onProgress?: (text: string) => void;
}

/** 读当前设置的 AI 模式（全局，音乐助手共用） */
export async function readMode(): Promise<DailyRecommendMode> {
  return readAiMode();
}

/** 保存 AI 模式（全局，音乐助手共用） */
export async function saveMode(mode: DailyRecommendMode): Promise<void> {
  saveAiMode(mode);
}

/**
 * 生成当天推荐。命中缓存直接返回（除非 `force`）。
 *
 * 流程：读偏好 → 多路搜候选（全部音源）→ 批量查屏蔽 → 按口味规则排序
 * → 可选交给模型精选 → 落缓存。
 */
export async function generateDailyRecommend(
  options: GenerateOptions = {},
): Promise<DailyRecommendResult> {
  const requested = options.mode != null ? options.mode : await readMode();
  // 三种模式都真实执行（`server` 见 ai-server-picks.ts）；降级只发生在运行时失败。
  const mode = requested;
  const taste = options.taste != null ? options.taste : readTaste();
  if (options.force != true) {
    const cached = await loadTodayResult(mode, taste);
    if (cached != null) return cached;
  }

  const report = (text: string): void => {
    if (options.onProgress != null) options.onProgress(text);
  };
  const cache = await readDailyCache();
  // 最近推荐过的**只降权不硬排除**：50 首 × 7 天足够把候选池掏空，硬排除会让
  // 页面直接空掉；降权保证没推过的先上，池子耗尽时仍能兜底。
  const historyKeys = recentRecommendedKeys(cache, true);

  report("正在读取播放记录…");
  const pref = await loadPreference();
  // 冷启动 = 三条输入全空：没听过、没收藏、也没自己选过风格（新装、换设备、清过统计）。
  // 不空着：给一批平台侧的最新/热门垫底，同时在页面上摆风格 chip 让用户点。
  const hasSaved = pref.favoriteTracks.length > 0 || pref.playlistTracks.length > 0;
  const seeds = pref.styleSeeds != null ? pref.styleSeeds : [];
  const hasSeeds = seeds.length > 0;
  const coldStart = pref.topSingers.length == 0 && !hasSaved && !hasSeeds;

  await useSourceRegistryStore().ensure();
  const source = useSourceStore().current;

  // 冷启动要先拿平台分类：一给页面摆 chip，二给候选池挑风格歌单（同一批数据，只请求一次）
  let styleOptions: DailyStyleOption[] = [];
  let categories: UTSJSONObject[] | null = null;
  if (coldStart) {
    report("正在读取平台风格分类…");
    try {
      categories = await musicApi.playlistCategories(source);
    } catch {
      categories = [];
    }
    styleOptions = pickStyleOptions(categories);
  }
  const styleSeeds = seeds;

  // 「换一批」换个变体种子，同一天多点几次才会换出不同顺序；维度路的兜底词也按它轮换
  const variant = options.force == true ? `${Date.now()}` : null;

  report("正在搜索候选歌曲（含榜单与风格维度）…");
  const poolResult = await buildCandidatePoolWithLanes(pref, source, {
    taste,
    coldStart,
    categories: categories != null ? categories : undefined,
    variant: variant != null ? variant : undefined,
    onProgress: () => {
      report("正在搜索候选歌曲（含榜单与风格维度）…");
    },
  });
  const pool = poolResult.tracks;
  const laneOf = poolResult.laneOf;
  const affinityLanes = poolResult.affinityLanes;
  if (pool.length == 0) {
    return {
      date: todayKey(),
      mode: "rule",
      requested,
      taste,
      generatedAt: Date.now(),
      title: coldStart ? "先挑几个你爱听的风格" : "这次没搜到候选",
      summary: coldStart
        ? "音源这次没返回内容，先选几个风格我再试一次。"
        : "音源没有返回结果，稍后再试一次。",
      items: [],
      notice: coldStart
        ? "音源没有返回内容：点上面的风格标签试试，或稍后重试。"
        : "音源搜索没有结果，检查一下音源包是否正常。",
      profileText: null,
      model: null,
      styleLanes: [],
      coldStart,
      styleOptions,
      styleSeeds,
    };
  }

  report("正在排除屏蔽与重复…");
  const dislikes = useDislikesStore();
  const dislikedFlags: boolean[] = [];
  for (let i = 0; i < pool.length; i++) dislikedFlags.push(dislikes.isDisliked(pool[i]));
  const historyAll = usePlayerStore().history;
  const playedKeys = new Set<string>();
  for (let i = 0; i < historyAll.length && i < 500; i++) playedKeys.add(trackKey(historyAll[i]));

  // 两种 AI 模式都要多排一批：rankCandidates 只按目标条数返回，只要 50 首、再让
  // 模型从这 50 首里挑 50 首，结果必然和规则模式逐首相同（用户看不出 AI 和规则的区别）。
  const rankTarget =
    mode != "rule" && !coldStart ? Math.max(DAILY_TARGET, DAILY_AI_POOL_MAX) : DAILY_TARGET;
  const ranked = rankCandidates(pool, pref, {
    historyKeys,
    playedKeys,
    dislikedFlags,
    taste,
    variant: variant != null ? variant : undefined,
    target: rankTarget,
  });
  // 按风格线配额补维度歌（v9），再按线交织排列：规则排序只看「和画像的贴合度」，
  // 维度路搜到的粤语/纯音乐/日系哪怕很贴合也会因为歌手陌生被压到 150 名之后 ——
  // 先按配额把它们拉进前 50（七成底盘 + 三成风格线），再交织。没有线标签的歌归
  // 「常规」线，保证主干仍是规则认为最贴合的那批；展示用的 laneOf 不掺合成标签。
  const CORE_LANE = "常规";
  const diverse = diversifyByLanes(ranked, laneOf, rankTarget);
  const interleaveLaneOf = new Map<string, string[]>();
  const laneSourceKeys = Array.from(laneOf.keys());
  for (let i = 0; i < laneSourceKeys.length; i++) {
    const labels = laneOf.get(laneSourceKeys[i]);
    interleaveLaneOf.set(laneSourceKeys[i], labels != null ? labels : []);
  }
  for (let i = 0; i < diverse.length; i++) {
    const key = trackKey(diverse[i]);
    if (!interleaveLaneOf.has(key)) interleaveLaneOf.set(key, [CORE_LANE]);
  }
  const rulePicked = interleaveByLanes(diverse, interleaveLaneOf, rankTarget);
  // 本期覆盖了哪几条线：给页面显示（老缓存/纯歌手路径为空数组）
  const laneStatsOf = (list: DailyRecommendItem[]): { label: string; count: number }[] => {
    const songs: Song[] = [];
    for (let i = 0; i < list.length; i++) songs.push(list[i].song);
    return laneCoverage(songs, laneOf, 5);
  };
  // 规则结果永远只取前 DAILY_TARGET 首（降级与补齐都用它）
  const ruleItems: DailyRecommendItem[] = [];
  const ruleTop = rulePicked.slice(0, DAILY_TARGET);
  for (let i = 0; i < ruleTop.length; i++) {
    ruleItems.push({ song: ruleTop[i], reason: ruleReason(ruleTop[i], pref) });
  }
  // 画像的人话描述：页面上要显示「系统认为你是什么口味」。冷启动时画像一定是空的，
  // 显示「口味还不明显」不如直接让他去选风格。
  const profileText = coldStart || pref.style == null ? null : describeProfile(pref.style);

  // 规则模式直接返回规则结果。冷启动也走这里：没有画像时让模型挑等于让它瞎猜，
  // 还不如把选择权交给用户。两种 AI 模式（local / server）才往下走。
  if (mode == "rule" || coldStart) {
    const result: DailyRecommendResult = {
      date: todayKey(),
      mode: "rule",
      requested,
      taste,
      generatedAt: Date.now(),
      title: coldStart ? "先挑几个你爱听的风格" : "根据你的播放记录挑的",
      summary: coldStart
        ? styleOptions.length > 0
          ? "点上面的风格标签，我按你选的风格来挑；不选也行，先听这批新歌。"
          : "还没有你的口味数据，先听几首新歌，明天这里就会像你了。"
        : `${DAILY_TASTE_LABEL[taste]}：共 ${ruleItems.length} 首，来自全部已装音源。`,
      items: ruleItems,
      notice: null,
      profileText,
      model: null,
      styleLanes: laneStatsOf(ruleItems),
      coldStart,
      styleOptions,
      styleSeeds,
    };
    await saveResult(result, true);
    return result;
  }

  if (ruleItems.length == 0) {
    const result: DailyRecommendResult = {
      date: todayKey(),
      mode: "rule",
      requested,
      taste,
      generatedAt: Date.now(),
      title: "这批候选都推荐过了",
      summary: "把屏蔽或收藏调一下，或者明天再来看看。",
      items: [],
      notice: "候选池里的歌最近都推荐过（或被屏蔽），已无新歌可推。",
      profileText,
      model: null,
      styleLanes: [],
      coldStart,
      styleOptions,
      styleSeeds,
    };
    await saveResult(result, true);
    return result;
  }

  // 候选池要比目标大出一截模型才有得挑（150 挑 50）；尾巴按 variant 轮转，
  // 「换一批」时模型看到的是不同的候选，而不是同一批歌换个顺序。
  const aiPool = pickAiPool(rulePicked, variant != null ? variant : undefined);
  const pickCount = Math.min(DAILY_TARGET, aiPool.length);
  report(mode == "server" ? "正在让服务端 AI 挑选…" : "正在让模型挑选…");
  try {
    const outcome =
      mode == "server"
        ? await pickByServer(aiPool, pref, pickCount, taste, laneOf)
        : await askModelForPicks(aiPool, pref, pickCount, taste, laneOf);
    const parsed = outcome.parsed;
    const model = outcome.model;
    // 实测模型偶尔会多给一两首（要 50 给 51），按目标条数截住，别让页面多出一行
    const targetPicks = parsed.picks.slice(0, DAILY_TARGET);
    // 中段穿插封顶 + 「有没有本地依据」两道闸；`used` 用**模型挑过的全部歌**
    // （含被闸门丢掉的），免得丢掉的那首又被规则补回来。
    const laneOptions: AiLaneOptions = { laneOf, affinityLanes };
    const items = filterAiPicks(
      limitAiPicks(targetPicks, aiPool, pref, taste, laneOptions),
      pref,
      taste,
      laneOptions,
    );
    const used = new Set<string>();
    for (let i = 0; i < targetPicks.length; i++) {
      const song = aiPool[targetPicks[i].index - 1];
      if (song != null) used.add(trackKey(song));
    }
    let filled = 0;
    for (let i = 0; i < rulePicked.length; i++) {
      if (items.length >= DAILY_TARGET) break;
      const song = rulePicked[i];
      if (used.has(trackKey(song))) continue;
      used.add(trackKey(song));
      items.push({ song, reason: ruleReason(song, pref) });
      filled += 1;
    }
    // 模型给的是它自己的顺序，可能把同一个歌手连着排 —— 只做最小相邻交换，
    // 尽量保留模型排出来的叙事。
    const spread = spreadItemsBySinger(items, (item: DailyRecommendItem): string => item.song.singer);
    const result: DailyRecommendResult = {
      date: todayKey(),
      mode,
      requested,
      taste,
      generatedAt: Date.now(),
      title: parsed.title.length > 0 ? parsed.title : "今天为你挑的",
      summary:
        parsed.summary.length > 0
          ? parsed.summary
          : `模型从 ${aiPool.length} 首候选里挑了 ${parsed.picks.length} 首${filled > 0 ? "，其余按规则补齐" : ""}。`,
      items: spread,
      notice: null,
      profileText,
      model: model.length > 0 ? model : null,
      styleLanes: laneStatsOf(spread),
      coldStart,
      styleOptions,
      styleSeeds,
    };
    await saveResult(result, true);
    return result;
  } catch (err) {
    // 模型挂了不能让页面空着：退回规则结果，并把原因如实写出来
    const reason = err instanceof Error ? err.message : String(err);
    const result: DailyRecommendResult = {
      date: todayKey(),
      mode: "rule",
      requested,
      taste,
      generatedAt: Date.now(),
      title: "根据你的播放记录挑的",
      summary: "模型这次没帮上忙，先用规则给你挑了一批。",
      items: ruleItems,
      notice:
        mode == "server"
          ? `服务端 AI 调用失败（${reason}），已退回规则推荐。`
          : `本地模型调用失败（${reason}），已退回规则推荐。`,
      profileText,
      model: null,
      styleLanes: [],
      coldStart,
      styleOptions,
      styleSeeds,
    };
    await saveResult(result, true);
    return result;
  }
}

export const DAILY_RECOMMEND_CACHE_KEY = "dailyRecommend.cache";
export const DAILY_RECOMMEND_TASTE_KEY = "dailyRecommend.taste";
export const DAILY_RECOMMEND_SEEDS_KEY = "dailyRecommend.styleSeeds";
