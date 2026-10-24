import type { Song } from "@/types/music";

/**
 * 聚合搜索的合并 / 去重 / 排序（app 侧降级实现）。
 *
 * 数据包 v7 起自带 `searchMerged` 入口（唯一真源在 qt-sources/src/actions/merge-search.ts，
 * 服务端合并）；本文件只服务「装在旧包上」的降级路径——入口缺失/调用抛错时，
 * app 用 searchAll 拿到各源批次后在这里自己合。规则必须与数据包侧逐字一致，
 * 否则换个数据包同一句搜索的排序就变（qt-pc/src/lib/aggregate-merge.ts 是同一套镜像）。
 *
 * 纯函数：不读时间、不随机、不缓存、不发请求。同样的输入永远同样的输出。
 */

/** 一个音源的一次搜索结果。`source` 是音源 id（如 wyy/qq），用于 preferSource 与稳定排序 */
export type AggregateSongBatch = {
  source: string;
  songs: Song[];
};

// ---------- 归一化 ----------

/** 成对括号定界符：中日文歌名四种都会出现，且常混用 */
const BRACKET_OPENERS: string[] = ["（", "(", "[", "【"];
const BRACKET_CLOSERS: string[] = ["）", ")", "]", "】"];

/**
 * 括号段里装的是版本信息而不是歌名本体（`晴天 (Live)`、`告白气球（片段）`），
 * 归一化时整段丢掉。用深度扫描而不是正则，因为括号会嵌套；不闭合时一路丢到结尾。
 */
function stripBracketSegments(text: string): string {
  let out = "";
  let depth = 0;
  const closers: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (depth == 0) {
      const openIdx = BRACKET_OPENERS.indexOf(ch);
      if (openIdx >= 0) {
        closers.push(BRACKET_CLOSERS[openIdx]);
        depth += 1;
        continue;
      }
      out += ch;
      continue;
    }
    const last = closers.length > 0 ? closers[closers.length - 1] : "";
    if (ch == last) {
      closers.pop();
      depth -= 1;
      continue;
    }
    const nestedIdx = BRACKET_OPENERS.indexOf(ch);
    if (nestedIdx >= 0) {
      closers.push(BRACKET_CLOSERS[nestedIdx]);
      depth += 1;
    }
  }
  return out;
}

/**
 * 归一化（去空白、去括号段、去标点、小写）。与数据包 merge-search.ts 同口径。
 */
export function aggregateNormText(text: string | null): string {
  const src = text != null ? text : "";
  return stripBracketSegments(src)
    .replace(/[\s\u3000]+/g, "")
    .replace(/[·・.,，、\-—_/\\'"“”‘’!！?？:：;；~～()（）[\]【】《》〈〉「」『』]/g, "")
    .toLowerCase();
}

// ---------- 同一首歌的键 ----------

/** 歌手串拆成单个歌手名（各平台分隔符五花八门，先统一拆开再各自归一化） */
function splitSingers(singer: string | null): string[] {
  const src = singer != null ? singer : "";
  const parts = src.split(/[、,，/&＆;；|]+|[\s\u3000]+/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const norm = aggregateNormText(parts[i]);
    if (norm.length > 0) out.push(norm);
  }
  return out;
}

/**
 * 同一首歌的键：`归一化标题|排序后的歌手集合`。
 * 歌手排序是关键（`A/B` 和 `B/A` 是同一首歌）；标题为空退回 `platform:id`，
 * 免得无标题脏数据互相互相并掉。
 */
export function aggregateSongKey(song: Song): string {
  const title = aggregateNormText(song.name);
  if (title.length == 0) return song.platform + ":" + song.id;
  const singers = splitSingers(song.singer).sort().join("/");
  return title + "|" + singers;
}

// ---------- 垃圾版本识别 ----------

/** 明显不是「用户想听的那首歌」的版本（匹配原始标题，不能用归一化标题——括号段已被丢掉） */
const JUNK_WORDS: string[] = [
  "伴奏",
  "消音",
  "纯伴奏",
  "instrumental",
  "offvocal",
  "karaoke",
  "铃声",
  "彩铃",
  "片段",
  "试听",
  "抢听",
  "喊麦",
  "dj版",
  "广场舞",
  "慢速",
  "加速",
  "升调",
  "降调",
  "8d版",
  "ai翻唱",
  "ai孙燕姿",
];

function matchedJunkWords(title: string): string[] {
  const lower = title.toLowerCase();
  const out: string[] = [];
  for (let i = 0; i < JUNK_WORDS.length; i++) {
    if (lower.indexOf(JUNK_WORDS[i]) >= 0) out.push(JUNK_WORDS[i]);
  }
  return out;
}

/**
 * 是否是明显不该出现的版本。**关键词豁免**：用户搜「告白气球 伴奏」时伴奏正是他要的；
 * 判断口径是「标题和关键词命中同一个 junk 词」，搜「伴奏」不该顺带放过一条「铃声」。
 */
export function isJunkSong(song: Song, keyword: string): boolean {
  const titleJunk = matchedJunkWords(song.name);
  if (titleJunk.length == 0) return false;
  const keywordJunk = matchedJunkWords(keyword);
  if (keywordJunk.length == 0) return true;
  for (let i = 0; i < titleJunk.length; i++) {
    if (keywordJunk.indexOf(titleJunk[i]) >= 0) return false;
  }
  return true;
}

// ---------- 打分 ----------

/** 软降级版本：还能听但不如录音室原版。只扣分、不丢弃——冷门歌的 Live 版可能是唯一能播的 */
const SOFT_VERSION_RE = /(live|演唱会|remix|cover|翻唱|片段|串烧)/i;

/** 各权重量级与数据包 merge-search.ts 逐字一致，改一个数字都会让新旧包排序分叉 */
const SCORE_BASE = 200;
const SCORE_TITLE_EQUAL = 60;
const SCORE_TITLE_PREFIX = 45;
const SCORE_TITLE_CONTAINS = 30;
const SCORE_SINGER_EQUAL = 55;
const SCORE_SINGER_CONTAINS = 35;
const SCORE_ALBUM_CONTAINS = 10;
const SCORE_SOFT_VERSION = -25;
const SCORE_PREFER_SOURCE = 8;
const SCORE_HAS_COVER = 3;
const SCORE_HAS_DURATION = 2;

type AggregateCandidate = {
  song: Song;
  score: number;
  /** 展平顺序：先按批次，再按批次内原始顺序 */
  order: number;
};

function scoreSong(
  song: Song,
  keywordNorm: string,
  preferSource: string,
  batchSource: string
): number {
  let score = SCORE_BASE;

  // 关键词为空时不做任何匹配加分：空串的「包含」对每个字符串都成立
  if (keywordNorm.length > 0) {
    const titleNorm = aggregateNormText(song.name);
    if (titleNorm == keywordNorm) {
      score += SCORE_TITLE_EQUAL;
    } else if (titleNorm.startsWith(keywordNorm)) {
      score += SCORE_TITLE_PREFIX;
    } else if (titleNorm.indexOf(keywordNorm) >= 0) {
      score += SCORE_TITLE_CONTAINS;
    }

    const singers = splitSingers(song.singer);
    let singerEqual = false;
    let singerContains = false;
    for (let i = 0; i < singers.length; i++) {
      if (singers[i] == keywordNorm) singerEqual = true;
      else if (singers[i].indexOf(keywordNorm) >= 0) singerContains = true;
    }
    if (singerEqual) score += SCORE_SINGER_EQUAL;
    else if (singerContains) score += SCORE_SINGER_CONTAINS;

    if (aggregateNormText(song.album).indexOf(keywordNorm) >= 0) score += SCORE_ALBUM_CONTAINS;
  }

  // 用原始标题判断版本降级（括号段已被 normText 丢掉）
  if (SOFT_VERSION_RE.test(song.name)) score += SCORE_SOFT_VERSION;

  // 音源归属同时看 song.platform 和批次 source：本地库这类来源的 platform 可能是别的值
  if (preferSource.length > 0) {
    if (song.platform == preferSource || batchSource == preferSource) {
      score += SCORE_PREFER_SOURCE;
    }
  }

  if (song.picUrl.length > 0) score += SCORE_HAS_COVER;
  if (song.duration != null && song.duration > 0) score += SCORE_HAS_DURATION;

  return score;
}

// ---------- 合并入口 ----------

/**
 * 合并多源批次 → 去重排序后的单列表。
 * 四步顺序不能换：丢垃圾 → 算键去重（同键保留分数最高、同分保留展平序靠前）→
 * 按分数降序、展平序升序排序 → limit 在排序之后生效。
 * 结果元素是原始 Song 引用（播放/收藏依赖 platform + id 定位）。
 */
export function mergeAggregateSongs(
  batches: AggregateSongBatch[],
  keyword: string,
  preferSource: string,
  limit: number = -1
): Song[] {
  const keywordNorm = aggregateNormText(keyword);

  const candidates: AggregateCandidate[] = [];
  let order = 0;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (batch == null || batch.songs == null) continue;
    for (let i = 0; i < batch.songs.length; i++) {
      const song = batch.songs[i];
      if (song == null) continue;
      const current = order;
      order += 1;
      // 垃圾版本先丢，别让它占掉同一首歌的去重名额
      if (isJunkSong(song, keyword)) continue;
      candidates.push({
        song,
        score: scoreSong(song, keywordNorm, preferSource, batch.source),
        order: current,
      });
    }
  }

  // 按 aggregateSongKey 去重，保留分数最高的；严格大于比较天然实现「同分先到的赢」
  const bestKeys: string[] = [];
  const bestScores: number[] = [];
  const bestIdx: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const key = aggregateSongKey(candidates[i].song);
    const existing = bestKeys.indexOf(key);
    if (existing < 0) {
      bestKeys.push(key);
      bestScores.push(candidates[i].score);
      bestIdx.push(i);
    } else if (candidates[i].score > bestScores[existing]) {
      bestScores[existing] = candidates[i].score;
      bestIdx[existing] = i;
    }
  }

  const merged: AggregateCandidate[] = [];
  for (let i = 0; i < bestIdx.length; i++) {
    merged.push(candidates[bestIdx[i]]);
  }
  merged.sort((a, b) => {
    if (b.score != a.score) return b.score - a.score;
    return a.order - b.order;
  });

  const songs: Song[] = [];
  for (let i = 0; i < merged.length; i++) {
    songs.push(merged[i].song);
  }
  // limit 生效在排序之后：先选出「最合适的 N 首」，而不是先截断再排序。-1 = 不限
  if (limit >= 0 && songs.length > limit) {
    return songs.slice(0, limit);
  }
  return songs;
}
