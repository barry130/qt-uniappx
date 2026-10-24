/**
 * 推荐排序引擎：按「口味画像」给候选打分，再做 MMR 多样性选择。
 * 与 qt-pc src/lib/recommend-rank.ts 同一套规则（权重表、配额放宽顺序、打散算法、
 * 推荐理由优先级全部一致；差异只有 UTS 适配：无 for-of 字符串 / 无 Infinity /
 * Map 只用 get&set 不遍历键）。
 *
 * 三路信号（相对旧版「只看常听歌手」的推倒重来）：
 * 1. 风格：语种、时长带、专辑亲和（本地能算，零网络）；
 * 2. 行为质量：完播/重播/「反复点开听 20 秒就切」；
 * 3. 歌手亲和：只是其中一路，探索口味下倒扣。
 *
 * 选择阶段不是按分数降序截断（会让同一个歌手霸屏），而是 MMR：
 * 每轮扣掉「和已选集合最像」的那部分分数，再叠歌手/语种硬配额；配额只约束前排，
 * 池子浅时逐级放宽（先语种后歌手），保证页面不空。
 */

import { durationBandOf } from "./music-style";
import { musicLangLabel, numAt } from "./recommend-types";
import type {
  DailyTaste,
  MusicLang,
  RankHit,
  RankOptions,
  ScoredCandidate,
  StyleProfile,
  TrackStyle,
} from "./recommend-types";
import { clamp01, jitter, localDateKey, normText, songNameKey, trackKeyOf, truncateChars } from "./recommend-text";
import type { Song } from "@/types/music";

/** 目标条数缺省值 */
const DEFAULT_TARGET = 50;

/** 配额放宽的上限倍数：严格配额撑不满时按 ×2 逐级放宽，到这里为止 */
const MAX_RELAX_FACTOR = 64;

/** UTS 没有 Infinity：用足够大的哨兵当「不限额」 */
const CAP_INF = 1000000000;
const SCORE_FLOOR = -1e18;

/** 每种口味「同一歌手最多几首」的缺省配额。探索是 1：宁可少推也不拿同人填满 */
export function tasteMaxPerSinger(taste: DailyTaste): number {
  if (taste === "heart") return 3;
  if (taste === "familiar") return 3;
  return 1;
}

/** 每种口味的 MMR λ 缺省值：越探索越强调「别跟已选的像」 */
export function tasteDiversity(taste: DailyTaste): number {
  if (taste === "heart") return 0.6;
  if (taste === "familiar") return 0.4;
  return 0.9;
}

/** 口味权重取值（if 链当查表；数值与 qt-pc 完全一致，改动前先读 qt-pc 注释） */
function wSaved(t: DailyTaste): number { return t === "heart" ? 9 : t === "familiar" ? 5 : 2; }
function wAlbum(t: DailyTaste): number { return t === "heart" ? 10 : t === "familiar" ? 6 : 3; }
function wMainLang(t: DailyTaste): number { return t === "heart" ? 7 : t === "familiar" ? 6 : 4; }
function wSecondLang(_t: DailyTaste): number { return 2; }
function wNewLang(t: DailyTaste): number { return t === "heart" ? -5 : t === "familiar" ? -4 : 6; }
function wMainBand(t: DailyTaste): number { return t === "heart" ? 2 : t === "familiar" ? 2 : 1; }
function wFamiliarSinger(t: DailyTaste): number { return t === "heart" ? 8 : t === "familiar" ? 10 : -4; }
function wNewSinger(t: DailyTaste): number { return t === "heart" ? 3 : t === "familiar" ? 1 : 9; }
function wUnplayed(t: DailyTaste): number { return t === "heart" ? 4 : t === "familiar" ? 2 : 6; }

/** 「只在歌手榜里见过、画像里没有」的折减系数：榜单覆盖广但粒度粗，只算一半 */
const FAMILIAR_SINGER_FALLBACK = 0.5;
/** 行为质量：affinity 换算成分数 */
const W_QUALITY_AFFINITY = 4;
/** 「反复点开但每次听不到一半」的惩罚 */
const W_SKIPPED = -8;
/** 最近几天推荐过：只降权不放逐（硬排除会让池子耗尽时页面空掉） */
const W_HISTORY = -20;
/** 稳定抖动：同一天同一批结果可复现，隔天有变化 */
const W_JITTER = 1.5;

/** similarity 各分量权重。四项加起来正好 1，同一首歌对自身得 1.0 */
const SIM_SINGER = 0.4;
const SIM_ALBUM = 0.2;
const SIM_LANG = 0.25;
const SIM_BAND = 0.15;

// ---------- 小工具 ----------

/**
 * 文字种类推断（打分侧口径，与画像侧 detectLanguage 略有差异是 qt-pc 原样）：
 * 假名 > 谚文 > 汉字 > 拉丁。拉丁要求至少两个 —— 单字母标题更像符号，判欧美是噪音。
 */
function detectLang(raw: string): MusicLang {
  const text = raw.toLowerCase();
  let kana = 0;
  let hangul = 0;
  let han = 0;
  let latin = 0;
  let i = 0;
  while (i < text.length) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        code = 0x10000 + (code - 0xd800) * 0x400 + (lo - 0xdc00);
        i += 2;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) {
      kana += 1;
    } else if (code >= 0xff66 && code <= 0xff9d) {
      kana += 1;
    } else if (
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    ) {
      hangul += 1;
    } else if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      han += 1;
    } else if ((code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)) {
      latin += 1;
    }
  }
  if (kana > 0) return "ja";
  if (hangul > 0) return "ko";
  if (han > 0) return "zh";
  if (latin >= 2) return "en";
  return "und";
}

/** 整首曲目的语种：标题优先，判不出来才退回歌手/专辑（中文歌手唱英文歌很常见） */
function detectTrackLang(song: Song): MusicLang {
  const fromTitle = detectLang(song.name);
  if (fromTitle !== "und") return fromTitle;
  return detectLang(`${song.singer} ${song.album}`);
}

/** 由 Song 推一份风格坐标（scoreCandidates 只收 Song[] 时的默认来源） */
export function deriveStyle(song: Song): TrackStyle {
  const singerKey = normText(song.singer);
  const albumName = normText(song.album);
  const dur = typeof song.duration === "number" ? (song.duration as number) : 0;
  const style: TrackStyle = {
    singerKey: singerKey,
    // 专辑键带上歌手：大量合辑/精选都叫「精选」，只按专辑名会把别人的精选算成同一张
    albumKey: albumName.length > 0 ? `${singerKey}|${albumName}` : "",
    lang: detectTrackLang(song),
    band: durationBandOf(dur),
  };
  return style;
}

/** 配额取值：≤0 视为「不限」 */
function asCap(value: number): number {
  return isFinite(value) && value > 0 ? Math.floor(value) : CAP_INF;
}

// ---------- similarity ----------

/**
 * 两首歌的「风格相似度」，0..1。只用于 MMR 去重（「别跟已选的像」），不参与打分。
 * 空歌手键不算同歌手（否则全库「未知歌手」互相 +0.4）；und 不是语种，两边 und 不算同语种。
 */
export function similarity(a: TrackStyle, b: TrackStyle): number {
  let score = 0;
  if (a.singerKey.length > 0 && a.singerKey === b.singerKey) score += SIM_SINGER;
  if (a.albumKey.length > 0 && a.albumKey === b.albumKey) score += SIM_ALBUM;
  if (a.lang !== "und" && a.lang === b.lang) score += SIM_LANG;
  if (a.band === b.band) score += SIM_BAND;
  return Math.min(1, score);
}

// ---------- 打分 ----------

/**
 * 给候选打分。硬排除（不进结果）：options.disliked[i] === true、excludeKeys 命中。
 * hits 按命中顺序记录，只为生成推荐理由服务，不参与算分。
 */
export function scoreCandidates(
  candidates: Song[],
  profile: StyleProfile,
  options: RankOptions,
): ScoredCandidate[] {
  const excludeKeys = options.excludeKeys != null ? options.excludeKeys : new Set<string>();
  const styles = options.styles;
  const historyKeys = options.historyKeys != null ? options.historyKeys : new Set<string>();
  const playedKeys = options.playedKeys != null ? options.playedKeys : new Set<string>();
  const savedKeys = options.savedKeys != null ? options.savedKeys : new Set<string>();
  const quality = options.quality;
  const disliked = options.disliked != null ? (options.disliked as boolean[]) : [];
  const taste = options.taste;
  const dateKey = options.dateKey != null ? (options.dateKey as string) : localDateKey(new Date());
  // 「换一批」的种子：同一天点多次能换出不同批次，同一天内又可复现（缓存要能命中）
  const seed = options.variant != null ? `${dateKey}|${options.variant as string}` : dateKey;

  const singerShare = profile.singers;
  const familiarSingers = options.familiarSingers != null ? options.familiarSingers : new Set<string>();
  const albumShare = profile.albums;
  const langShare = profile.langs;
  const mainLang = profile.mainLang;
  const mainBand = profile.mainBand;

  const scored: ScoredCandidate[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const song = candidates[index];
    if (index < disliked.length && disliked[index] === true) continue;
    const key = trackKeyOf(song.platform, song.id);
    const nameKey = songNameKey(song.name, song.singer);
    if (excludeKeys.has(key) || excludeKeys.has(nameKey)) continue;

    const style = styles != null && styles.has(key) ? (styles.get(key) as TrackStyle) : deriveStyle(song);
    const hits: RankHit[] = [];
    let score = 0;

    // 收藏：用户亲手收进来的，最硬的信号
    if (savedKeys.has(key) || savedKeys.has(nameKey)) {
      score += wSaved(taste);
      hits.push("saved");
    }

    // 同专辑：这张专辑你反复听，里面其它歌大概率也合口味
    if (style.albumKey.length > 0 && numAt(albumShare, style.albumKey) > 0) {
      const affinity = numAt(albumShare, style.albumKey);
      score += wAlbum(taste) * affinity;
      hits.push("same-album");
    }

    // 语种三态：主语种 / 画像里的次要语种 / 完全没出现过
    if (style.lang !== "und") {
      if (style.lang === mainLang) {
        score += wMainLang(taste);
        hits.push("main-lang");
      } else if (numAt(langShare, style.lang) > 0) {
        score += wSecondLang(taste);
        hits.push("other-lang");
      } else {
        score += wNewLang(taste);
        hits.push("other-lang");
      }
    }

    // 时长带：弱特征，只用一两点分做微调
    if (style.band === mainBand) {
      score += wMainBand(taste);
      hits.push("main-band");
    }

    // 歌手：常听 vs 新人，两档权重方向在 explore 下是反的（见权重注释）
    if (style.singerKey.length > 0 && numAt(singerShare, style.singerKey) > 0) {
      score += wFamiliarSinger(taste) * numAt(singerShare, style.singerKey);
      hits.push("familiar-singer");
    } else if (style.singerKey.length > 0 && familiarSingers.has(style.singerKey)) {
      // 画像里没有但歌手榜上有：仍算「熟悉」，只算一半分量（榜覆盖全史、画像只有 top 样本）
      score += wFamiliarSinger(taste) * FAMILIAR_SINGER_FALLBACK;
      hits.push("familiar-singer");
    } else {
      // 歌手未知（键为空）不算「新歌手」，不给高分 —— 会把无歌手信息的歌顶上来
      if (style.singerKey.length > 0) {
        score += wNewSinger(taste);
        hits.push("new-singer");
      }
    }

    // 行为质量：完播/重播/最近性；「反复点开却听不完」直接倒扣
    const q = quality != null ? (quality as Record<string, TrackQuality>)[key] : null;
    if (q != null) {
      score += W_QUALITY_AFFINITY * q.affinity;
      if (q.skipped) {
        score += W_SKIPPED;
        hits.push("skipped");
      }
    }

    if (!playedKeys.has(key)) {
      score += wUnplayed(taste);
      hits.push("unplayed");
    }

    // 最近几天推荐过：降权不放逐
    if (historyKeys.has(key) || historyKeys.has(nameKey)) {
      score += W_HISTORY;
      hits.push("replayed");
    }

    score += W_JITTER * jitter(seed, key);
    const sc: ScoredCandidate = { song: song, style: style, score: score, hits: hits };
    scored.push(sc);
  }
  return scored;
}

// ---------- MMR 多样性选择 ----------

/**
 * MMR 贪心选择 + 歌手/语种配额。配额放宽先语种后歌手（歌手配额是用户抱怨的那条，
 * 最后让步；反之华语库会连坐放宽歌手配额又霸屏）。探索口味不参与任何放宽：
 * 池子不够就少推，是对口味诚实。
 */
export function selectDiverse(
  scored: ScoredCandidate[],
  _profile: StyleProfile,
  options: RankOptions,
): ScoredCandidate[] {
  const target = Math.max(0, Math.floor(options.target != null ? (options.target as number) : DEFAULT_TARGET));
  if (target == 0 || scored.length == 0) return [];

  const taste = options.taste;
  const lambda =
    options.diversity != null ? clamp01(options.diversity as number) : tasteDiversity(taste);
  const singerCapBase = asCap(options.maxPerSinger != null ? (options.maxPerSinger as number) : tasteMaxPerSinger(taste));
  const langCapBase = asCap(
    options.maxPerLang != null ? (options.maxPerLang as number) : Math.max(2, Math.ceil(target * 0.6)),
  );

  // 归一化到 0..1：绝对分动辄 ±20，similarity 只有 0..1，不归一两项相减没有意义。
  // 全批最大分 ≤ 0（整池被历史降权压穿）时统一给 1：分数分不出好坏，只能靠相似度。
  let maxScore = SCORE_FLOOR;
  for (let i = 0; i < scored.length; i++) {
    if (scored[i].score > maxScore) maxScore = scored[i].score;
  }
  const norm: number[] = [];
  for (let i = 0; i < scored.length; i++) {
    norm.push(maxScore > 0 ? clamp01(scored[i].score / maxScore) : 1);
  }

  const chosen: ScoredCandidate[] = [];
  const used: Set<number> = new Set();
  const singerCount: Map<string, number> = new Map();
  const langCount: Map<string, number> = new Map();

  /** 与已选集合的最大相似度（第一轮为 0） */
  function maxSimilarityOf(index: number): number {
    if (chosen.length == 0) return 0;
    const style = scored[index].style;
    let best = 0;
    for (let i = 0; i < chosen.length; i++) {
      const sim = similarity(style, chosen[i].style);
      if (sim > best) best = sim;
    }
    return best;
  }

  /** 配额检查：空歌手键与 und 语种不计入配额（它们不是「某个歌手/某种语种」） */
  function withinQuota(index: number, singerCap: number, langCap: number): boolean {
    const style = scored[index].style;
    if (style.singerKey.length > 0) {
      const c = singerCount.get(style.singerKey);
      if (c != null && c >= singerCap) return false;
    }
    if (style.lang !== "und") {
      const c = langCount.get(style.lang as string);
      if (c != null && c >= langCap) return false;
    }
    return true;
  }

  function take(index: number): void {
    const candidate = scored[index];
    used.add(index);
    chosen.push(candidate);
    if (candidate.style.singerKey.length > 0) {
      singerCount.set(candidate.style.singerKey, (singerCount.get(candidate.style.singerKey) ?? 0) + 1);
    }
    if (candidate.style.lang !== "und") {
      langCount.set(candidate.style.lang as string, (langCount.get(candidate.style.lang as string) ?? 0) + 1);
    }
  }

  /** 在当前配额下一直选到 target 满、或者配额把剩下的全挡住 */
  function fill(singerCap: number, langCap: number): void {
    while (chosen.length < target) {
      let bestIndex = -1;
      let bestMmr = SCORE_FLOOR;
      for (let i = 0; i < scored.length; i++) {
        if (used.has(i)) continue;
        if (!withinQuota(i, singerCap, langCap)) continue;
        const mmr = norm[i] - lambda * maxSimilarityOf(i);
        // 并列时取绝对分更高、再并列取输入序靠前的：结果必须可复现（缓存按天算）
        const better =
          bestIndex < 0 ||
          mmr > bestMmr + 1e-12 ||
          (Math.abs(mmr - bestMmr) <= 1e-12 && scored[i].score > scored[bestIndex].score);
        if (better) {
          bestMmr = mmr;
          bestIndex = i;
        }
      }
      // 配额把剩下的全挡住了 —— 交给上一层的「放宽配额」循环
      if (bestIndex < 0) break;
      take(bestIndex);
    }
  }

  if (taste === "explore") {
    // 探索口味：只跑严格配额，不放宽、不兜底
    fill(singerCapBase, langCapBase);
  } else {
    // 先逐级放宽语种配额
    for (let factor = 1; factor <= MAX_RELAX_FACTOR && chosen.length < target; factor *= 2) {
      fill(singerCapBase, langCapBase * factor);
    }
    // 语种彻底放开后仍不够，才轮到歌手配额逐级放宽
    for (let factor = 2; factor <= MAX_RELAX_FACTOR && chosen.length < target; factor *= 2) {
      fill(singerCapBase * factor, CAP_INF);
    }
    // 歌手实在太少（整池一个人）时不再卡配额
    if (chosen.length < target) fill(CAP_INF, CAP_INF);
  }

  return spreadAdjacentSinger(chosen);
}

// ---------- 相邻打散 ----------

/**
 * 相邻打散：结果里不要出现连续两首同歌手（MMR 通常已保证，但兜底补齐阶段按分数
 * 直塞会破坏）。只调顺序不动集合。第一首是钉住的（MMR 最高分，用户第一眼看的），
 * 交换只在 i>=1 与 j>i 之间。交换做不到的形状退回 interleaveBySinger。
 */
function spreadAdjacentSinger(items: ScoredCandidate[]): ScoredCandidate[] {
  const out = items.slice();
  const n = out.length;
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (let i = 1; i < n; i++) {
      const prevSinger = out[i - 1].style.singerKey;
      if (out[i].style.singerKey !== prevSinger) continue;
      // 首选：换过来既不与前一格冲突、也不与后一格冲突
      let swapAt = -1;
      for (let j = i + 1; j < n; j++) {
        if (out[j].style.singerKey === prevSinger) continue;
        if (j + 1 < n && out[j + 1].style.singerKey === out[i].style.singerKey) continue;
        swapAt = j;
        break;
      }
      // 次选：只要换到 i 处不冲突（后面那格由下一轮扫描修）
      if (swapAt < 0) {
        for (let j = i + 1; j < n; j++) {
          if (out[j].style.singerKey !== prevSinger) {
            swapAt = j;
            break;
          }
        }
      }
      // 后面没有不同歌手可换 —— 分组轮流取兜底
      if (swapAt < 0) return interleaveBySinger(out);
      const tmp = out[i];
      out[i] = out[swapAt];
      out[swapAt] = tmp;
      changed = true;
    }
    if (!changed) return out;
  }
  return hasAdjacentSinger(out) ? interleaveBySinger(out) : out;
}

function hasAdjacentSinger(items: ScoredCandidate[]): boolean {
  for (let i = 1; i < items.length; i++) {
    if (items[i].style.singerKey === items[i - 1].style.singerKey) return true;
  }
  return false;
}

/**
 * 按歌手分组后轮流取（不动集合，只重排）。每步从「剩余最多、且与上一首不同歌手」
 * 的组里取一首（任务调度贪心，最大组 ≤ ceil(n/2) 必然排得开）。队首钉住：items[0]
 * 是 MMR 最高分，永远留在第一位，只对 slice(1) 轮流取。
 */
function interleaveBySinger(items: ScoredCandidate[]): ScoredCandidate[] {
  if (items.length <= 2) return items.slice();
  const head = items[0];
  const rest = items.slice(1);
  const groups: Map<string, ScoredCandidate[]> = new Map();
  const order: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index];
    // 未知歌手（空键）用序号当独立分组键，避免把无关的歌当成同一歌手
    const key = item.style.singerKey === "" ? `\u0000${index}` : item.style.singerKey;
    let bucket = groups.get(key);
    if (bucket == null) {
      bucket = [];
      groups.set(key, bucket);
      order.push(key);
    }
    bucket.push(item);
  }

  const cursor: Map<string, number> = new Map();
  for (let i = 0; i < order.length; i++) cursor.set(order[i], 0);
  const out: ScoredCandidate[] = [head];
  let lastKey = head.style.singerKey;
  while (out.length < items.length) {
    let pickKey = "";
    let pickRemaining = 0;
    for (let i = 0; i < order.length; i++) {
      const key = order[i];
      const bucket = groups.get(key);
      if (bucket == null) continue;
      const at = cursor.get(key) ?? 0;
      const remaining = bucket.length - at;
      if (remaining <= 0) continue;
      if (key === lastKey) continue;
      if (remaining > pickRemaining) {
        pickRemaining = remaining;
        pickKey = key;
      }
    }
    // 剩下的全是上一首那个歌手（最大组 > 一半）：无解，按原序接上
    if (pickKey === "") break;
    const bucket = groups.get(pickKey);
    const at = cursor.get(pickKey) ?? 0;
    if (bucket == null) break;
    out.push(bucket[at]);
    cursor.set(pickKey, at + 1);
    lastKey = pickKey;
  }
  // 兜底：理论上不会走到（除非最大组超过一半），接上没排进去的，保证不丢歌
  if (out.length < items.length) {
    const placed: Set<string> = new Set();
    for (let i = 0; i < out.length; i++) placed.add(`${out[i].song.platform}:${out[i].song.id}`);
    for (let i = 0; i < items.length; i++) {
      const k = `${items[i].song.platform}:${items[i].song.id}`;
      if (!placed.has(k)) out.push(items[i]);
    }
  }
  return out;
}

// ---------- 推荐理由 ----------

/**
 * 推荐理由：只陈述能验证的事实，不编故事。优先级越靠前信号越硬
 * （收藏 > 同专辑 > 常听歌手 > 收藏口味 > 新歌手+语种 > 语种 > 没听过）。
 * 「常听歌手」与「只收藏过这个歌手」必须分开：收藏 ≠ 听过，说「常听」就是编故事。
 */
export function reasonFor(
  candidate: ScoredCandidate,
  profile: StyleProfile,
  _taste: DailyTaste,
): string {
  const hits: Set<string> = new Set<string>(candidate.hits as string[]);
  const song = candidate.song;
  const style = candidate.style;

  if (hits.has("saved")) return "你收藏里的歌";

  if (hits.has("same-album")) {
    const album = truncateChars(song.album.trim(), 12);
    return album.length > 0 ? `同专辑《${album}》` : "和你常听的专辑相近";
  }

  if (hits.has("familiar-singer")) {
    const singer = truncateChars(song.singer.trim(), 12);
    if (singer.length > 0) return `你常听 ${singer}`;
  }

  // 歌手只在收藏/歌单里出现过：说「常听」就是编故事（可能一次都没播过）
  if (hits.has("saved-singer")) return "和你的收藏口味相近";

  // 语种名取「画像主语种」，画像没下结论（und）时退回候选自己的语种
  const langName = musicLangLabel(profile.mainLang !== "und" ? profile.mainLang : style.lang);

  if (hits.has("new-singer") && hits.has("main-lang")) {
    return `新歌手，和你的${langName}口味接近`;
  }

  if (hits.has("main-lang")) return `符合你常听的${langName}`;

  if (hits.has("unplayed")) return "你没听过，换个口味试试";

  return "换一批看看";
}
