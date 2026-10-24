/**
 * 每日推荐的「维度」层：把候选池从窄路扩成多维度。
 * 与 qt-pc src/lib/recommend-dimensions.ts 同一套词表与流程（qt-pc 2026-10-24 版），
 * 差异只有 UTS 适配（Map 不遍历键 → 键序数组 / regex 换手工 endsWith /
 * 聚合搜索没有 searchManyBatches 门面 → 逐关键词 searchMerged + 并发 3）。
 *
 * 三条采集路（每路独立兜底，任何一路挂掉只损失那一维，绝不 throw）：
 * 1. 榜单路：质量最稳，最多 5 张榜（名字带风格词的优先，最多 3 张）；
 * 2. 关键词路：所有维度词逐个丢给聚合搜索（跨源打平 + 并发 3）；
 * 3. 风格歌单路：整张歌单一次带来几十首，但请求重，只给前两条风格查询。
 *
 * 边界：本模块只做候选池，不打分不排序（打分在 recommend-rank.ts，串流程在
 * daily-recommend.ts）；只 import 叶子模块，不 import daily-recommend（防成环）。
 */

import { musicApi } from "./music-api";
import type { Chart } from "./music-api";
import type { Playlist, Song } from "@/types/music";
import type { DailyTaste, StyleProfile } from "./recommend-types";
import { hashString, normText, trackKeyOf } from "./recommend-text";
import { readAggregateSources } from "./aggregate-sources";

/** 一条维度线的种类。前端「风格线」标签按它分组展示 */
export type LaneKind =
  | "tag"
  | "lang"
  | "adjacent"
  | "genre"
  | "mood"
  | "scene"
  | "era"
  | "chart"
  | "search";

/** 一条维度查询：lane 是展示名，keyword 是真正丢给搜索的字符串 */
export interface LaneQuery {
  lane: string;
  keyword: string;
  kind: LaneKind;
}

// ---------- 词表 ----------
// 音源搜索接口没有 genre/年代/语种元数据（见 recommend-types.ts 顶部说明），风格只能靠
// 「用风格词去搜」反推 —— 词表本身就是本模块的能力上限，加一个词 = 多一条可搜维度。

export const GENRE_WORDS: string[] = [
  "古风", "国风", "民谣", "摇滚", "电子", "说唱", "爵士", "蓝调", "R&B", "朋克",
  "金属", "后摇", "独立", "ACG", "二次元", "纯音乐", "轻音乐", "原声", "世界音乐",
  "民乐", "戏腔", "lo-fi", "citypop",
];

export const MOOD_WORDS: string[] = ["治愈", "热血", "伤感", "轻快", "安静", "温柔", "梦幻", "燃"];

export const SCENE_WORDS: string[] = ["助眠", "学习", "通勤", "运动", "咖啡厅", "雨天", "深夜", "驾车", "旅行"];

export const ERA_WORDS: string[] = ["经典老歌", "怀旧", "80年代", "90年代", "千禧", "00年代"];

/** 语种维度词。华语是默认口味不作维度词（否则每次都搜华语等于没扩维），zh 只放少数派 */
export const LANG_WORDS: Record<string, string[]> = {
  zh: ["粤语"],
  ja: ["日语", "日系"],
  ko: ["韩语", "韩系"],
  en: ["欧美", "英文歌"],
  und: ["纯音乐", "器乐"],
};

/**
 * 相邻风格：从一个风格往「像但不同」走一步。同义词搜回来的是同一批歌（浪费请求），
 * 相邻风格才真正扩池 —— 爱听古风的人大概率不排斥戏腔，但戏腔搜回来的歌不一样。
 */
export const ADJACENT_WORDS: Record<string, string[]> = {
  古风: ["国风", "戏腔", "民乐"],
  国风: ["古风", "民乐"],
  民谣: ["独立", "原声"],
  摇滚: ["朋克", "金属", "后摇"],
  电子: ["lo-fi", "citypop", "纯音乐"],
  说唱: ["R&B", "电子"],
  爵士: ["蓝调", "原声"],
  纯音乐: ["轻音乐", "器乐", "lo-fi"],
  ACG: ["二次元", "日语"],
  轻音乐: ["纯音乐", "助眠"],
  独立: ["民谣", "后摇"],
  原声: ["轻音乐", "纯音乐"],
  "R&B": ["爵士", "citypop"],
  流行: ["citypop", "抒情"],
};

// ---------- 内部常量 ----------

const DEFAULT_MAX_QUERIES = 10;
const DEFAULT_PER_CHART = 60;
const DEFAULT_PER_KEYWORD = 24;
const DEFAULT_PER_PLAYLIST = 20;

/** 非主语种占比到 5% 才算「真实存在的一小撮口味」，1~4% 多是误判（一两首歌） */
const MIN_SECONDARY_LANG_SHARE = 0.05;
/** 搜索历史词长度上限：再长基本是整句粘贴，搜出来必是噪声 */
const MAX_SEARCH_WORD_LEN = 16;

const CHART_MAX = 5;
/** 名字里带风格词的榜优先，但最多 3 张：全是风格榜会挤掉「飙升/热歌」这类大盘榜 */
const CHART_STYLE_MAX = 3;
const CHART_FILL_MAX = 2;
const CHART_CONCURRENCY = 3;
const KEYWORD_CONCURRENCY = 3;
const PLAYLIST_MAX_QUERIES = 2;
const PLAYLIST_PICK_SIZE = 4;

/** 内部线：没有命中任何维度的歌归到这里，只在交织的最后兜底，权重 0 */
const OTHER_LANE = "__其他";

const LANG_KEYS: string[] = ["zh", "ja", "ko", "en", "und"];

function langWordList(): string[] {
  const out: string[] = [];
  for (let i = 0; i < LANG_KEYS.length; i++) {
    const words = LANG_WORDS[LANG_KEYS[i]];
    if (words != null) {
      for (let j = 0; j < words.length; j++) out.push(words[j]);
    }
  }
  return out;
}

/** 名字找词的词表顺序 = 优先级：先流派、再情绪、再场景、再年代、最后语种 */
const NAME_VOCAB: string[] = []
  .concat(GENRE_WORDS, MOOD_WORDS, SCENE_WORDS, ERA_WORDS, langWordList());

interface NormWord {
  word: string;
  key: string;
}

function buildNormVocab(): NormWord[] {
  const out: NormWord[] = [];
  for (let i = 0; i < NAME_VOCAB.length; i++) {
    out.push({ word: NAME_VOCAB[i], key: normText(NAME_VOCAB[i]) });
  }
  return out;
}
const NAME_VOCAB_NORM: NormWord[] = buildNormVocab();

/** 相邻风格键表：归一化键 → 词表（手工建，不用 Object.entries） */
const ADJACENT_KEYS: string[] = [];
const ADJACENT_LISTS: string[][] = [];
(function buildAdjacent(): void {
  // IIFE 建表（模块级立即执行一次；UTS 允许顶层顺序调用，这里包一层避免类型推断问题）
  const keys = ["古风", "国风", "民谣", "摇滚", "电子", "说唱", "爵士", "纯音乐", "ACG", "轻音乐", "独立", "原声", "R&B", "流行"];
  for (let i = 0; i < keys.length; i++) {
    const list = ADJACENT_WORDS[keys[i]];
    if (list != null) {
      ADJACENT_KEYS.push(normText(keys[i]));
      ADJACENT_LISTS.push(list);
    }
  }
})();

interface BreadthEntry {
  word: string;
  kind: LaneKind;
}

const BREADTH_POOL: BreadthEntry[] = []
  .concat(toBreadthEntries(GENRE_WORDS, "genre"))
  .concat(toBreadthEntries(MOOD_WORDS, "mood"))
  .concat(toBreadthEntries(SCENE_WORDS, "scene"))
  .concat(toBreadthEntries(ERA_WORDS, "era"));

function toBreadthEntries(words: string[], kind: LaneKind): BreadthEntry[] {
  const out: BreadthEntry[] = [];
  for (let i = 0; i < words.length; i++) out.push({ word: words[i], kind: kind });
  return out;
}

// ---------- 小工具 ----------

function hashStringOf(text: string): number {
  return hashString(text);
}

/** 缺省/非法数值兜底；负数按 0 处理 */
function countOr(value: number | null, fallback: number): number {
  if (typeof value !== "number" || !isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

/** 并发受限的顺序保持 map（UTS：不用泛型数组容器，调用点各自落具体类型） */
async function mapLimitSongs(
  items: Chart[],
  limit: number,
  fn: (item: Chart, index: number) => Promise<Song[]>,
): Promise<Song[][]> {
  const out: Song[][] = [];
  for (let i = 0; i < items.length; i++) out.push([]);
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

async function mapLimitKeyword(
  items: LaneQuery[],
  limit: number,
  fn: (item: LaneQuery, index: number) => Promise<Song[]>,
): Promise<Song[][]> {
  const out: Song[][] = [];
  for (let i = 0; i < items.length; i++) out.push([]);
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

/** 网络调用统一兜底：数据包没装载时门面会在调用表达式上同步抛，catch 才兜得住 */
async function safeSongs(fn: () => Promise<Song[]>): Promise<Song[]> {
  try {
    const value = await fn();
    return value != null ? value : [];
  } catch (e) {
    return [];
  }
}

async function safeCharts(fn: () => Promise<Chart[]>): Promise<Chart[]> {
  try {
    const value = await fn();
    return value != null ? value : [];
  } catch (e) {
    return [];
  }
}

/** 按 trackKey 去重（保留首次出现）再截断 —— 跨源聚合后同一首歌会重复出现 */
function dedupeSongs(songs: Song[], limit: number): Song[] {
  const out: Song[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < songs.length; i++) {
    if (out.length >= limit) break;
    const key = trackKeyOf(songs[i].platform, songs[i].id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(songs[i]);
  }
  return out;
}

/** 词表里第一个「被 text 包含」的词（保留原始大小写写法，如 R&B） */
function findVocabWord(text: string): string | null {
  const key = normText(text);
  if (key.length == 0) return null;
  for (let i = 0; i < NAME_VOCAB_NORM.length; i++) {
    const entry = NAME_VOCAB_NORM[i];
    if (entry.key.length > 0 && key.includes(entry.key)) return entry.word;
  }
  return null;
}

/** 相邻风格词：按归一化键查，容忍「R&B / r&b」写法差异 */
function adjacentWords(lane: string): string[] {
  const key = normText(lane);
  for (let i = 0; i < ADJACENT_KEYS.length; i++) {
    if (ADJACENT_KEYS[i] === key) return ADJACENT_LISTS[i];
  }
  return [];
}

/** 手工剥「榜」壳（UTS 不用 /u regex，按 endsWith 逐个试） */
function stripChartSuffix(raw: string): string {
  if (raw.endsWith("排行榜")) return raw.slice(0, raw.length - 3);
  if (raw.endsWith("榜单")) return raw.slice(0, raw.length - 2);
  if (raw.endsWith("榜")) return raw.slice(0, raw.length - 1);
  return raw;
}

/**
 * 榜单名 → 风格线标签：「国风榜」命中词表直接用「国风」（榜单曲目与关键词线合并到
 * 同一条风格线）；命中不了剥「榜」壳（「飙升榜」→「飙升」），实在没内容叫「榜单」。
 */
export function chartLane(name: string): string {
  const raw = name.trim();
  const key = normText(raw);
  if (key.length > 0) {
    for (let i = 0; i < NAME_VOCAB_NORM.length; i++) {
      const entry = NAME_VOCAB_NORM[i];
      if (entry.key.length > 0 && key.includes(entry.key)) return entry.word;
    }
  }
  const stripped = stripChartSuffix(raw).trim();
  return stripped.length > 0 ? stripped : "榜单";
}

// ---------- 维度规划 ----------

export interface DimensionPlanInput {
  profile: StyleProfile;
  /** 用户自己的歌单名（用户亲手写的风格自述，比任何推断都直接） */
  playlistNames: string[] | null;
  /** 搜索历史，最近优先 */
  searchHistory: string[] | null;
  taste: DailyTaste | null;
  /** 「换一批」种子或日期；用来轮换兜底维度词 */
  variant: string | null;
  /** 缺省 10：再多请求数就压不住了 */
  maxQueries: number | null;
}

/**
 * 把口味信号翻成一批搜索词，按「越靠前越贴合用户」排序。
 * 顺序即规则：自述风格 → 歌单名命中 → 少数派语种 → 相邻风格 → 兜底广度 → 搜索历史
 * （历史是过去某次意图，时效最弱，只当补位维度）。
 */
export function planDimensionQueries(input: DimensionPlanInput): LaneQuery[] {
  const profile = input.profile;
  const playlistNames = input.playlistNames != null ? (input.playlistNames as string[]) : [];
  const searchHistory = input.searchHistory != null ? (input.searchHistory as string[]) : [];
  const variant = input.variant != null ? (input.variant as string) : "";
  const taste = input.taste;
  const maxQueries = countOr(input.maxQueries, DEFAULT_MAX_QUERIES);

  const out: LaneQuery[] = [];
  const seen = new Set<string>();

  /** 落线成功才占名额（去重掉的不占） */
  function push(rawLane: string, kind: LaneKind): boolean {
    const lane = rawLane.trim();
    const key = normText(lane);
    if (key.length == 0 || seen.has(key)) return false;
    seen.add(key);
    out.push({ lane: lane, keyword: lane, kind: kind });
    return true;
  }

  // 1) 画像自述风格词，优先级最高
  let tagCount = 0;
  for (let i = 0; i < profile.tags.length && tagCount < 3; i++) {
    const tag = profile.tags[i];
    if (normText(tag).length > 0) {
      if (push(tag, "tag")) tagCount += 1;
    }
  }

  // 2) 歌单名命中词表：画像 tags 只覆盖「被 STYLE_TAGS 认识的词」，再按同一套
  //    词表扫一遍原始歌单名，捞回画像没抽到的维度（tags 空时尤其重要）
  let playlistHits = 0;
  for (let i = 0; i < playlistNames.length && playlistHits < 2; i++) {
    const word = findVocabWord(playlistNames[i]);
    if (word == null) continue;
    if (push(word, "tag")) playlistHits += 1;
  }

  // 3) 非主语种：≥5% 才当维度。Record 键序不稳定，先收集再按份额降序取前 2
  const secondaryLangs: string[] = [];
  const secondaryShares: number[] = [];
  for (let i = 0; i < LANG_KEYS.length; i++) {
    const lang = LANG_KEYS[i];
    if (lang === profile.mainLang) continue;
    const share = langShareOf(profile, lang);
    if (share < MIN_SECONDARY_LANG_SHARE) continue;
    // 插入排序（最多 4 个元素，不值得 sort 比较器）
    let at = secondaryLangs.length;
    for (let j = 0; j < secondaryLangs.length; j++) {
      if (share > secondaryShares[j]) {
        at = j;
        break;
      }
    }
    secondaryLangs.splice(at, 0, lang);
    secondaryShares.splice(at, 0, share);
  }
  for (let i = 0; i < secondaryLangs.length && i < 2; i++) {
    const words = LANG_WORDS[secondaryLangs[i]];
    if (words != null && words.length > 0) push(words[0], "lang");
  }

  // 4) 相邻风格：每个自述风格走一步，保证「像但不同」的维度进来
  let tagLaneCount = 0;
  for (let i = 0; i < out.length && tagLaneCount < 2; i++) {
    if (out[i].kind != "tag") continue;
    tagLaneCount += 1;
    const words = adjacentWords(out[i].lane);
    for (let j = 0; j < words.length; j++) {
      if (push(words[j], "adjacent")) break;
    }
  }

  // 5) 兜底广度词：tags 为空说明画像不可信，取 4 个；explore 多给一个维度。
  //    起点由 variant 哈希轮换 —— 否则「换一批」只换歌、不换风格。
  const breadthWant = tagCount == 0 || taste === "explore" ? 4 : 3;
  if (BREADTH_POOL.length > 0) {
    const start = hashStringOf(variant) % BREADTH_POOL.length;
    let added = 0;
    for (let i = 0; i < BREADTH_POOL.length && added < breadthWant; i++) {
      const entry = BREADTH_POOL[(start + i) % BREADTH_POOL.length];
      if (push(entry.word, entry.kind)) added += 1;
    }
  }

  // 6) 搜索历史：最近优先；超长词（整句粘贴）直接丢
  let searchAdded = 0;
  for (let i = 0; i < searchHistory.length && searchAdded < 3; i++) {
    const word = searchHistory[i].trim();
    if (word.length < 1 || Array.from(word).length > MAX_SEARCH_WORD_LEN) continue;
    if (push(word, "search")) searchAdded += 1;
  }

  return out.slice(0, maxQueries);
}

function langShareOf(profile: StyleProfile, lang: string): number {
  return numAtOf(profile.langs, lang);
}

function numAtOf(record: Record<string, number>, key: string): number {
  const v = record[key];
  return typeof v === "number" ? v : 0;
}

// ---------- 维度采集中 ----------

export interface DimensionCollectInput {
  profile: StyleProfile;
  playlistNames: string[] | null;
  searchHistory: string[] | null;
  taste: DailyTaste | null;
  variant: string | null;
  source: string;
  /** 聚合音源白名单；null = 全部 */
  sources: string[] | null;
  perChart: number | null;
  perKeyword: number | null;
  perPlaylist: number | null;
  onProgress: (() => void) | null;
}

export interface DimensionLane {
  label: string;
  kind: LaneKind;
  songs: Song[];
}

export interface DimensionLanes {
  /** 按优先级排序：榜单线在前，其后按查询顺序 */
  lanes: DimensionLane[];
  /** trackKey → 来自哪些线（去重、按线顺序；只 get 不遍历键） */
  laneOf: Map<string, string[]>;
}

interface LaneSlot {
  label: string;
  kind: LaneKind;
  order: number;
  seq: number;
  songs: Song[];
}

/** 榜单候选：按名字去重，再按「名字是否带风格词」分优先/补位（uniappx 的 Chart
 *  契约没有 contentType 字段，节目榜过滤下沉在包侧；这里只做名字去重与风格优先） */
function pickCharts(charts: Chart[], styleKeys: string[]): Chart[] {
  const unique: Chart[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < charts.length; i++) {
    const chart = charts[i];
    if (chart.id == null || chart.id.length == 0) continue;
    const nameKey = normText(chart.name);
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    unique.push(chart);
  }

  const priority: Chart[] = [];
  const rest: Chart[] = [];
  for (let i = 0; i < unique.length; i++) {
    const key = normText(unique[i].name);
    let matched = false;
    if (key.length > 0) {
      for (let j = 0; j < styleKeys.length; j++) {
        if (styleKeys[j].length > 0 && key.includes(styleKeys[j])) {
          matched = true;
          break;
        }
      }
    }
    if (matched && priority.length < CHART_STYLE_MAX) priority.push(unique[i]);
    else rest.push(unique[i]);
  }
  // 风格榜优先，非风格榜最多补 2 张，总共封顶 5 张
  const picked: Chart[] = [];
  for (let i = 0; i < priority.length && picked.length < CHART_MAX; i++) picked.push(priority[i]);
  for (let i = 0; i < rest.length && picked.length < CHART_MAX; i++) {
    if (i >= CHART_FILL_MAX) break;
    picked.push(rest[i]);
  }
  return picked;
}

/**
 * 跑完三条采集路，产出风格线。每一路独立兜底：一路挂了其它路照跑 ——
 * 生成失败比推荐窄更糟。
 */
export async function collectDimensionLanes(input: DimensionCollectInput): Promise<DimensionLanes> {
  const queries = planDimensionQueries({
    profile: input.profile,
    playlistNames: input.playlistNames,
    searchHistory: input.searchHistory,
    taste: input.taste,
    variant: input.variant,
    maxQueries: null,
  });
  if (input.onProgress != null) (input.onProgress as () => void)();

  const perChart = countOr(input.perChart, DEFAULT_PER_CHART);
  const perKeyword = countOr(input.perKeyword, DEFAULT_PER_KEYWORD);
  const perPlaylist = countOr(input.perPlaylist, DEFAULT_PER_PLAYLIST);

  // 线槽：键序数组 + 键→下标 Map（Map 只 get/set）
  const slotKeys: string[] = [];
  const slots: LaneSlot[] = [];
  const slotIndex = new Map<string, number>();
  let seq = 0;

  /** 追加一条线。同 label 同一条线（榜单「国风榜」与关键词「国风」拼成一条） */
  function append(label: string, kind: LaneKind, songs: Song[], order: number): void {
    const key = normText(label);
    if (key.length == 0) return;
    let at = slotIndex.get(key);
    if (at == null) {
      if (songs.length == 0) return;
      const slot: LaneSlot = { label: label, kind: kind, order: order, seq: seq, songs: [] };
      seq += 1;
      slotKeys.push(key);
      slots.push(slot);
      at = slots.length - 1;
      slotIndex.set(key, at);
    }
    const slot = slots[at];
    const have = new Set<string>();
    for (let i = 0; i < slot.songs.length; i++) have.add(trackKeyOf(slot.songs[i].platform, slot.songs[i].id));
    for (let i = 0; i < songs.length; i++) {
      const k = trackKeyOf(songs[i].platform, songs[i].id);
      if (have.has(k)) continue;
      have.add(k);
      slot.songs.push(songs[i]);
    }
  }

  function queryOrder(query: LaneQuery): number {
    for (let i = 0; i < queries.length; i++) {
      if (queries[i] === query) return 100 + i;
    }
    return 100 + queries.length;
  }

  // ---- 1) 榜单路：质量最稳的一路，优先跑（哪怕后面全挂，也有它兜着） ----
  try {
    const charts = await safeCharts(() => musicApi.charts(input.source));
    const styleKeys: string[] = [];
    for (let i = 0; i < queries.length; i++) {
      if (queries[i].kind == "tag" || queries[i].kind == "lang") styleKeys.push(normText(queries[i].lane));
    }
    const genreMood: string[] = []
      .concat(GENRE_WORDS, MOOD_WORDS, langWordList());
    for (let i = 0; i < genreMood.length; i++) styleKeys.push(normText(genreMood[i]));
    const picked = pickCharts(charts, styleKeys);
    const rows = await mapLimitSongs(picked, CHART_CONCURRENCY, async (chart): Promise<Song[]> => {
      const songs = await safeSongs(() => musicApi.chartDetail(chart));
      return dedupeSongs(songs, perChart);
    });
    for (let i = 0; i < rows.length; i++) {
      append(chartLane(picked[i].name), "chart", rows[i], i);
    }
  } catch (e) {
    // 榜单这一路整体不可用：候选池还有关键词与歌单两路
  }
  if (input.onProgress != null) (input.onProgress as () => void)();

  // ---- 2) 关键词路：所有维度词逐个丢给聚合搜索（跨源打平 + 并发 3） ----
  try {
    const keywordQueries: LaneQuery[] = [];
    for (let i = 0; i < queries.length; i++) {
      if (queries[i].kind != "chart" && queries[i].keyword.trim().length > 0) keywordQueries.push(queries[i]);
    }
    if (keywordQueries.length > 0) {
      const sources = input.sources != null ? (input.sources as string[]) : readAggregateSources();
      const rows = await mapLimitKeyword(keywordQueries, KEYWORD_CONCURRENCY, async (query): Promise<Song[]> => {
        const merged = await musicApi.searchMerged(query.keyword, 1, perKeyword, sources, null);
        return dedupeSongs(merged.songs, perKeyword);
      });
      for (let i = 0; i < keywordQueries.length; i++) {
        append(keywordQueries[i].lane, keywordQueries[i].kind, rows[i], queryOrder(keywordQueries[i]));
      }
    }
  } catch (e) {
    // 聚合搜索失败只损失关键词这一路
  }
  if (input.onProgress != null) (input.onProgress as () => void)();

  // ---- 3) 风格歌单路：整张歌单一次带来几十首，但请求重，只给前两条风格查询 ----
  try {
    const styleQueries: LaneQuery[] = [];
    for (let i = 0; i < queries.length && styleQueries.length < PLAYLIST_MAX_QUERIES; i++) {
      const kind = queries[i].kind;
      if (kind == "tag" || kind == "genre" || kind == "adjacent") styleQueries.push(queries[i]);
    }
    for (let i = 0; i < styleQueries.length; i++) {
      const query = styleQueries[i];
      let playlists: Playlist[] = [];
      try {
        playlists = await musicApi.searchPlaylists(query.keyword, input.source, 1, PLAYLIST_PICK_SIZE);
      } catch (e) {
        continue;
      }
      if (playlists.length == 0) continue;
      const first = playlists[0];
      if (first.id == null || first.id.length == 0) continue;
      let tracks: Song[] = [];
      try {
        const detail = await musicApi.playlist(first.id, input.source);
        if (detail.tracks != null) tracks = detail.tracks as Song[];
      } catch (e) {
        tracks = [];
      }
      const songs = dedupeSongs(tracks, perPlaylist);
      if (songs.length == 0) continue;
      append(query.lane, query.kind, songs, queryOrder(query));
    }
  } catch (e) {
    // 歌单这一路失败不影响其它维度
  }
  if (input.onProgress != null) (input.onProgress as () => void)();

  // 排序：order 不同按 order，相同按 seq（稳定）
  const order: number[] = [];
  for (let i = 0; i < slots.length; i++) order.push(i);
  order.sort((a: number, b: number): number => {
    const sa = slots[a];
    const sb = slots[b];
    if (sa.order != sb.order) return sa.order - sb.order;
    return sa.seq - sb.seq;
  });

  const lanes: DimensionLane[] = [];
  for (let i = 0; i < order.length; i++) {
    const slot = slots[order[i]];
    lanes.push({ label: slot.label, kind: slot.kind, songs: slot.songs });
  }

  // laneOf：同一首歌跨线时数组顺序 = 线优先级（第一条即主线）
  const laneOf = new Map<string, string[]>();
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i];
    for (let j = 0; j < lane.songs.length; j++) {
      const key = trackKeyOf(lane.songs[j].platform, lane.songs[j].id);
      const labels = laneOf.get(key);
      if (labels == null) {
        laneOf.set(key, [lane.label]);
      } else {
        let has = false;
        for (let k = 0; k < labels.length; k++) {
          if (labels[k] === lane.label) {
            has = true;
            break;
          }
        }
        if (!has) labels.push(lane.label);
      }
    }
  }

  return { lanes: lanes, laneOf: laneOf };
}

// ---------- 交织与覆盖统计 ----------

/**
 * 按风格线交织（平滑加权轮询 SWRR）。朴素轮询会在小线耗尽后退化成大盘榜顺序，
 * SWRR 用权重 4/2/2/1 让前三条线在前几轮轮流坐庄。没线的歌归 __其他，只兜底。
 */
export function interleaveByLanes(items: Song[], laneOf: Map<string, string[]>, target: number): Song[] {
  if (target <= 0 || items.length == 0) return [];
  if (laneOf.size == 0) return items.slice(0, target);

  const groups = new Map<string, Song[]>();
  const lineOrder: string[] = [];
  const seenKeys = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const key = trackKeyOf(items[i].platform, items[i].id);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const labels = laneOf.get(key);
    const line = labels != null && labels.length > 0 ? labels[0] : OTHER_LANE;
    let group = groups.get(line);
    if (group == null) {
      group = [];
      groups.set(line, group);
      lineOrder.push(line);
    }
    group.push(items[i]);
  }

  const weighted: string[] = [];
  for (let i = 0; i < lineOrder.length; i++) {
    if (lineOrder[i] !== OTHER_LANE) weighted.push(lineOrder[i]);
  }
  function weightOf(line: string): number {
    for (let i = 0; i < weighted.length; i++) {
      if (weighted[i] === line) {
        if (i == 0) return 4;
        if (i == 1 || i == 2) return 2;
        return 1;
      }
    }
    return 0;
  }

  const current = new Map<string, number>();
  const cursor = new Map<string, number>();
  for (let i = 0; i < weighted.length; i++) {
    current.set(weighted[i], 0);
    cursor.set(weighted[i], 0);
  }

  const picked: Song[] = [];
  const pickedKeys = new Set<string>();
  while (picked.length < target) {
    const active: string[] = [];
    for (let i = 0; i < weighted.length; i++) {
      const cur = cursor.get(weighted[i]) ?? 0;
      const group = groups.get(weighted[i]);
      if (cur < (group != null ? group.length : 0)) active.push(weighted[i]);
    }
    if (active.length == 0) break;
    let total = 0;
    for (let i = 0; i < active.length; i++) {
      const w = weightOf(active[i]);
      current.set(active[i], (current.get(active[i]) ?? 0) + w);
      total += w;
    }
    let best = active[0];
    let bestValue = current.get(best) ?? 0;
    for (let i = 0; i < active.length; i++) {
      const value = current.get(active[i]) ?? 0;
      // 严格大于 + active 保持线顺序 = 同分取先出现的线
      if (value > bestValue) {
        best = active[i];
        bestValue = value;
      }
    }
    current.set(best, bestValue - total);
    const index = cursor.get(best) ?? 0;
    cursor.set(best, index + 1);
    const group = groups.get(best);
    const track = group != null && index < group.length ? group[index] : null;
    if (track == null) continue;
    picked.push(track);
    pickedKeys.add(trackKeyOf(track.platform, track.id));
  }

  // 兜底补位：__其他 与漏网曲目按原顺序补
  for (let i = 0; i < items.length && picked.length < target; i++) {
    const key = trackKeyOf(items[i].platform, items[i].id);
    if (pickedKeys.has(key)) continue;
    pickedKeys.add(key);
    picked.push(items[i]);
  }
  return picked.slice(0, target);
}

export interface LaneCoverageItem {
  label: string;
  count: number;
}

/** 结果风格线统计（给界面展示「这次推荐覆盖了哪几条线」）。只统计主线 laneOf[0] */
export function laneCoverage(items: Song[], laneOf: Map<string, string[]>, max: number): LaneCoverageItem[] {
  const limit = countOr(max, 5);
  if (limit == 0) return [];
  const counts: Record<string, number> = {};
  const labels: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const list = laneOf.get(trackKeyOf(items[i].platform, items[i].id));
    const label = list != null && list.length > 0 ? list[0] : "";
    if (label.length == 0 || label.startsWith("__")) continue;
    if (counts[label] == null) {
      counts[label] = 1;
      labels.push(label);
    } else {
      counts[label] = (counts[label] as number) + 1;
    }
  }
  const items2: LaneCoverageItem[] = [];
  for (let i = 0; i < labels.length; i++) {
    items2.push({ label: labels[i], count: counts[labels[i]] as number });
  }
  items2.sort((a: LaneCoverageItem, b: LaneCoverageItem): number => {
    if (a.count != b.count) return b.count - a.count;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
  return items2.slice(0, limit);
}
