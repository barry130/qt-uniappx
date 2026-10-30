/**
 * 音乐助手的「本地引擎」：`rule` / `local` 两种模式在这里把一句话变成一屏歌。
 * （移植自 qt-pc src/lib/ai-assistant-local.ts，UTS 约束下的写法见下。）
 *
 * ## 为什么不走服务端
 * 服务端会话（services/ai.ts 的 /ai/conversations）每句话都要登录 + 联网 + 远端推理；
 * 这两个模式要的恰恰是「永远能用」：断网、没登录、接口没配好时，助手仍然能回答
 * 「来点古风」这种明确请求。所以本模块不建服务端会话、不碰 astral 命令、不自己搜歌
 * —— 候选由调用方搜好后传进来（桌面端的 ipc 依赖在这里全部去掉）。
 *
 * ## rule 与 local 的分工
 * `rule` 全程本地、同步、可解释：关键词/画像/点名各加多少分，reply 里说得你能对上账。
 * `local` 多一次本机 OpenAI 兼容接口调用，模型只负责在编号候选里挑序号 —— 判断哪首
 * 合适仍是本地算，越界/重复/编造的序号一律丢，模型没机会自己写歌名。
 *
 * ## 解析失败为什么只降级不抛错
 * 助手页的主任务是「听到歌」。小模型会回 markdown 围栏、只回一串数字、或直接说
 * 「我也不知道」——这些都不该变成错误气泡。解析走「整段 JSON → 抠数组 → 正则捞序号
 * → 规则挑歌」的降级链：engine 回落 "rule"、note 写明原因、reply 换规则文案。用户
 * 最多觉得「这次回答朴素了点」，而不是「助手坏了」。
 */

import type { Song } from "@/types/music";
import { aiLocalChat } from "@/services/ai-providers";
import type { AiLocalMessage } from "@/services/ai-providers";
import { extractJsonArray } from "@/services/daily-recommend";
import { describeProfile, trackStyle } from "@/services/music-style";
import {
  ADJACENT_WORDS,
  ERA_WORDS,
  GENRE_WORDS,
  LANG_WORDS,
  MOOD_WORDS,
  SCENE_WORDS,
} from "@/services/recommend-dimensions";
import { similarity } from "@/services/recommend-rank";
import { normText, trackKeyOf, truncateChars } from "@/services/recommend-text";
import { numAt } from "@/services/recommend-types";
import type { DurationBand, MusicLang, StyleProfile, TrackStyle } from "@/services/recommend-types";

/** 本模块只处理两种本地模式（server 模式走 services/ai.ts 的服务端会话） */
export type LocalAssistantMode = "rule" | "local";

export interface AssistantTurnInput {
  mode: LocalAssistantMode;
  /** 用户这句话 */
  text: string;
  /** 最近几轮对话（旧的在前，只取最后 6 条用；assistant 的 content 已是纯文本） */
  history: { role: string; content: string }[];
  /** 调用方已经搜好的候选（10~30 首，可能为空） */
  candidates: Song[];
  /** 可选的听歌画像（daily-recommend 的 loadPreference().style）；没有就 null */
  profile: StyleProfile | null;
}

export interface AssistantTurnResult {
  /** 给用户看的一句中文回答（local 失败时用规则文案兜底） */
  reply: string;
  /** 按顺序挑中的歌（默认 12 首、可按用户要求变，去重；候选为空时是空数组） */
  songs: Song[];
  /** rule 模式 / local 解析失败都报 "rule"，local 成功报 "local" */
  engine: string;
  /** 降级原因（成功为空串）：页面用它提示「模型不可用，已用规则挑」 */
  note: string;
}

/** rule 模式的 engine 值（集成层靠它区分「这句话是不是规则给的」） */
const RULE_ENGINE = "rule";

/** local 模式模型挑成功时的 engine 值 */
const LOCAL_ENGINE = "local";

/**
 * 一次最多交付几首：与 qt-pc 一致封顶 20 —— 再多就成了整张歌单，不是「立刻能听」的入口。
 */
const MAX_SONGS = 20;

/**
 * 用户没说数量时给几首：12（qt-pc 是 20）。移动端一屏放不下 20 首，先给一屏能听完的量，
 * 用户说「来二十首」时仍按上限给满。
 */
const DEFAULT_SONG_COUNT = 12;

/** 同一歌手最多几首：和每日推荐的配额同口径，避免一个人连排 */
const MAX_PER_SINGER = 2;

/** 同歌手第 2 首起的降权：只降权不淘汰（淘汰交给 MAX_PER_SINGER 硬配额） */
const SAME_SINGER_PENALTY = 2;

/** 每个命中的关键词、每个字段（name/singer/album）加分 */
const KEYWORD_FIELD_SCORE = 3;

/** 歌名或歌手被用户点名时的加分（比关键词强一档） */
const NAMED_SCORE = 6;

/** 画像相似度的最大加分（similarity 0..1 映射到 0..4） */
const PROFILE_SCORE_MAX = 4;

/** 本地模型温度：0.6 = 有点表达自由，但别改写成诗 */
const LOCAL_TEMPERATURE = 0.6;

/** 本地模型回复正文的上限（字）：助手气泡只放得下一句话 */
const LOCAL_REPLY_MAX_CHARS = 80;

/** note 的上限（字）：页面提示条只有一行，异常原文可能很长 */
const NOTE_MAX_CHARS = 60;

/** prompt 里最多带几条最近对话（更早的上下文只会稀释这句话的意图） */
const PROMPT_HISTORY_MAX = 4;

/** 入参 history 的截断上限（契约说只取最后 6 条） */
const INPUT_HISTORY_MAX = 6;

/** 名字匹配的最小归一化长度：单字歌名（「雨」）太容易把普通句子误判成点名 */
const MIN_NAME_MATCH_LEN = 2;

/** 候选为空时的固定文案：说清「为什么没有歌」和「下一步能做什么」 */
const EMPTY_CANDIDATE_REPLY = "这次没搜到合适的歌，换个歌手、风格或场景再说一遍，或先装音源包试试。";

/** 候选都在但一首都没选出来时（全是重复/都被过滤）的文案：同样要给下一步动作 */
const NO_PICK_REPLY = "这次没挑出能放的歌，换个说法或换个歌手名再试一次。";

/** 正则兜底捞序号：「picks: [1, 3, 5]」/「picks：[1,3,5]」/「Picks:[1]」都认 */
const PICKS_PATTERN = /picks\s*[:：]\s*\[([0-9,\s]+)\]/i;

/** 「来 10 首」里的阿拉伯数字数量 */
const ARABIC_COUNT = /^[0-9]{1,3}$/;

/** 「二十首」里的中文数字（只覆盖到 99，够用了） */
const CHINESE_COUNT = /^[一二两三四五六七八九十]{1,3}$/;

/** 用户话里的阿拉伯数字数量词 */
const ARABIC_SONG_COUNT = /([0-9]{1,3})\s*首/;

/** 用户话里的中文数字数量词 */
const CHINESE_SONG_COUNT = /([一二两三四五六七八九十]{1,3})\s*首/;

/** 纯数字串（模型回 "3" 这种字符串序号时用） */
const PURE_DIGITS = /^[0-9]+$/;

/** 句子切分：模型把话写在 JSON 外面时取第一句当 reply */
const SENTENCE_SPLIT = /[。！？!?\n\r]+/;

/** 首句两端的标点要剥掉（「。 回答」这类脏边角） */
const LEAD_PUNCT = /^[\s:：,，、;；。]+/;

const TAIL_PUNCT = /[\s:：,，、;；。]+$/;

/** 中文数字单字 → 数字（只到 9，十位由 chineseNumber 组合） */
const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

// ---------- 数量词 ----------

/**
 * 「20」/「二十」/「两」这类写法换成数字；认不出来返回 -1。
 *
 * 为什么返回 -1 而不是 NaN：UTS 侧 NaN 的比较/判断在各端行为不一致，
 * -1 这种「不可能的数量」作哨兵最稳，调用方 `<= 0` 一并当没说数量。
 */
function countOf(text: string): number {
  if (ARABIC_COUNT.test(text)) return parseInt(text, 10);
  if (!CHINESE_COUNT.test(text)) return -1;
  const at = text.indexOf("十");
  if (at < 0) {
    const single = numAt(CHINESE_DIGITS, text);
    return single > 0 ? single : -1;
  }
  const highText = text.substring(0, at);
  const lowText = text.substring(at + 1);
  const high = highText.length == 0 ? 1 : numAt(CHINESE_DIGITS, highText);
  const low = lowText.length == 0 ? 0 : numAt(CHINESE_DIGITS, lowText);
  return high * 10 + low;
}

/**
 * 这一次要交付几首：话里点了数量就按他说的，夹紧到 1..MAX_SONGS；没说就给默认值。
 *
 * 识别三种写法：「来 20 首」「来二十首」「来两首」。识别失败时**不能**退化成少给几首
 * —— 用户说过一次 20 首，下次不说也不该掉回默认值。
 */
function requestedSongCount(text: string): number {
  let spoken = -1;
  const arabic = ARABIC_SONG_COUNT.exec(text);
  if (arabic != null) {
    const hold = arabic[1];
    spoken = hold != null ? countOf(hold) : -1;
  } else {
    const chinese = CHINESE_SONG_COUNT.exec(text);
    if (chinese != null) {
      const hold = chinese[1];
      spoken = hold != null ? countOf(hold) : -1;
    }
  }
  if (spoken <= 0) return DEFAULT_SONG_COUNT;
  return Math.max(1, Math.min(MAX_SONGS, spoken));
}

// ---------- 词表 ----------

/**
 * 语种词打平成一维：命中哪个都算语种维度。
 *
 * 与 qt-pc 的差异：uniappx 的 LANG_WORDS 是 `Record<string, string[]>`（无法确认键一定
 * 存在），所以按 Object.keys 取值并判空，而不是 qt-pc 的 `(Object.keys(...) as MusicLang[])`
 * + flatMap。
 */
const LANG_WORD_LIST: string[] = [];
(function buildLangWords(): void {
  const keys = Object.keys(LANG_WORDS);
  for (let i = 0; i < keys.length; i++) {
    const words = LANG_WORDS[keys[i]];
    if (words == null) continue;
    for (let j = 0; j < words.length; j++) LANG_WORD_LIST.push(words[j]);
  }
})();

/**
 * 关键词识别的词表顺序：流派 → 情绪 → 场景 → 年代 → 语种 → 相邻词表的键。
 *
 * 顺序即 reply 的说话优先级（先说用户原话里最像的那类词）。相邻词表（ADJACENT_WORDS）
 * 的键里有「流行」这种不在前几张表、但用户真会说的词，所以键本身也当命中词。
 */
const KEYWORD_WORDS: string[] = [];
(function buildKeywordWords(): void {
  const seen = new Set<string>();
  const buckets: string[][] = [
    GENRE_WORDS,
    MOOD_WORDS,
    SCENE_WORDS,
    ERA_WORDS,
    LANG_WORD_LIST,
    Object.keys(ADJACENT_WORDS),
  ];
  for (let b = 0; b < buckets.length; b++) {
    const words = buckets[b];
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const key = normText(word);
      if (key.length == 0 || seen.has(key)) continue;
      seen.add(key);
      KEYWORD_WORDS.push(word);
    }
  }
})();

// ---------- rule：关键词 / 点名 ----------

/** 用户话里点名到的名字（歌手/歌名/专辑） */
interface NamedHits {
  /** 出现在用户话里的名字（去重、按候选顺序）；reply 只用第一条 */
  labels: string[];
  /** 歌名或歌手被点名的候选下标（参与 +NAMED_SCORE 加分） */
  indexes: number[];
}

/**
 * 从用户这句话里收风格/情绪/场景/年代/语种关键词，并展开相邻风格。
 *
 * 相邻词表的意义：用户说「古风」时，国风/戏腔/民乐也是他大概率想听的 —— 不展开的话只有
 * name/singer/album 里带「古风」两个字的歌能得分，命中面太窄。展开只走一步（不做传递
 * 闭包）：再往外走就离用户原意太远了。
 */
function collectKeywords(text: string): string[] {
  const out: string[] = [];
  const textKey = normText(text);
  if (textKey.length == 0) return out;

  const seen = new Set<string>();
  const matched: string[] = [];
  for (let i = 0; i < KEYWORD_WORDS.length; i++) {
    const word = KEYWORD_WORDS[i];
    const key = normText(word);
    if (key.length == 0 || !textKey.includes(key)) continue;
    matched.push(word);
    out.push(word);
    seen.add(key);
  }
  // 相邻词统一追加在真实命中之后：reply 取前 3 个时，先念用户原话里的词
  for (let i = 0; i < matched.length; i++) {
    const adjacent = ADJACENT_WORDS[matched[i]];
    if (adjacent == null) continue;
    for (let j = 0; j < adjacent.length; j++) {
      const word = adjacent[j];
      const key = normText(word);
      if (key.length == 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(word);
    }
  }
  return out;
}

/** 单个字段（歌名/歌手/专辑）是否被点名；命中就记进 labels */
function nameHit(field: string, textKey: string, labels: string[]): boolean {
  const key = normText(field);
  if (key.length < MIN_NAME_MATCH_LEN || !textKey.includes(key)) return false;
  const label = field.trim();
  if (label.length > 0 && labels.indexOf(label) < 0) labels.push(label);
  return true;
}

/**
 * 从候选里找「用户话里点到的名字」。
 *
 * 用归一化后的 includes 而不是精确相等：用户写「周杰伦的晴天」「jay」这类带修饰的说法，
 * 精确匹配会全漏。名字归一化后长度 < 2 的不算（单字太容易误判）。
 */
function findNamed(candidates: Song[], text: string): NamedHits {
  const labels: string[] = [];
  const indexes: number[] = [];
  const textKey = normText(text);
  if (textKey.length == 0) return { labels: labels, indexes: indexes };

  for (let i = 0; i < candidates.length; i++) {
    const song = candidates[i];
    // 歌名/歌手被点名才加 NAMED_SCORE（专辑名只进 reply 文案，不参与打分）
    const titleHit = nameHit(song.name, textKey, labels);
    const singerHit = nameHit(song.singer, textKey, labels);
    nameHit(song.album, textKey, labels);
    if (titleHit || singerHit) indexes.push(i);
  }
  return { labels: labels, indexes: indexes };
}

/**
 * 用户点名的歌手集合（归一化后）。
 *
 * 规则里「同一歌手最多 2 首」是为了避免硬塞一个人的歌；但用户自己说「我想听周杰伦」时，
 * 这条规则正好挡在他要的东西前面 —— 点名的歌手不受配额限制。
 *
 * 用数组而不是 Set：这里要遍历，UTS 侧 Set 遍历没有先例（Array.from(Set) 虽有先例，
 * 但调用点都是 Map 的 values），数组 + indexOf 在 20 首的量级上毫无成本。
 */
function namedSingers(candidates: Song[], named: NamedHits): string[] {
  const singers: string[] = [];
  for (let i = 0; i < named.indexes.length; i++) {
    const song = candidates[named.indexes[i]];
    if (song == null) continue;
    const key = normText(song.singer);
    if (key.length == 0 || singers.indexOf(key) >= 0) continue;
    singers.push(key);
  }
  return singers;
}

// ---------- rule：画像相似度 ----------

/**
 * 画像里权重最高的键（没有就空串）。
 *
 * 不按出现次数而按权重：singers/albums 已按行为质量加权过（见 buildStyleProfile），
 * 权重最高才是「最像他的那个」。qt-pc 用 Object.entries，这里按项目惯例改成
 * Object.keys + numAt（不用 Object.entries，全库仅 recommend-dimensions 注释里提过原因）。
 */
function topAffinityKey(map: Record<string, number>): string {
  let bestKey = "";
  let bestValue = 0;
  const keys = Object.keys(map);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = numAt(map, key);
    if (key.length == 0 || value <= bestValue) continue;
    bestKey = key;
    bestValue = value;
  }
  return bestKey;
}

/** 画像里的语种字符串 → 词汇表语种（StyleProfile.mainLang 是 string，TrackStyle.lang 是联合类型） */
function langOfProfile(raw: string): MusicLang {
  if (raw == "zh") return "zh";
  if (raw == "ja") return "ja";
  if (raw == "ko") return "ko";
  if (raw == "en") return "en";
  return "und";
}

/** 画像里的时长带字符串 → 词汇表时长带（同上：StyleProfile.mainBand 是 string） */
function bandOfProfile(raw: string): DurationBand {
  if (raw == "short") return "short";
  if (raw == "long") return "long";
  if (raw == "epic") return "epic";
  return "normal";
}

/**
 * 把画像压成一份「风格坐标」，供 similarity(trackStyle(song), ...) 比较。
 *
 * 仓库里没有现成的这个函数（music-style.ts 只有单曲的 trackStyle），但相似度需要两个
 * 同形状的对象。画像里能落到 TrackStyle 上的只有四件事：最强的歌手亲和、最强的专辑亲和、
 * 主语种、主要时长带。取「最强」而不是摊开整张亲和表，是因为 similarity 的语义是
 * 「和这个坐标像不像」，不是对亲和权重求期望。
 */
function trackStyleOfProfile(profile: StyleProfile): TrackStyle {
  const style: TrackStyle = {
    singerKey: topAffinityKey(profile.singers),
    albumKey: topAffinityKey(profile.albums),
    lang: langOfProfile(profile.mainLang),
    band: bandOfProfile(profile.mainBand),
  };
  return style;
}

/**
 * 画像是否存在可用信号。
 *
 * buildStyleProfile 在没有任何样本时返回 sampleSize = 0、tags = [] 的空画像；拿它算
 * 相似度只会给「三四分钟」这种默认值加分，等于无依据地抬一手候选，所以跳过。
 */
function profileHasSignal(profile: StyleProfile | null): boolean {
  if (profile == null) return false;
  return profile.sampleSize > 0 || profile.tags.length > 0;
}

// ---------- rule：排序 ----------

/** 一首候选的规则打分结果 */
interface ScoredRuleSong {
  song: Song;
  /** 候选原顺序：同分时保持搜索结果的原始相关度 */
  index: number;
  /** 关键词 + 点名 + 画像相似度，未扣同歌手分 */
  baseScore: number;
  /** 扣完同歌手分后的最终分 */
  score: number;
  /** 归一化歌手键（去重用；空歌手键视为互不相同） */
  singerKey: string;
}

/**
 * 给每首候选打分：
 * - 关键词命中 name/singer/album，每个字段 +3；
 * - 被点名（歌名或歌手出现在用户话里）+6；
 * - 有画像时加 round(similarity × 4)（画像为空跳过）；
 * - 同一歌手第 2 首起每首 -2（只降权，最终还有 MAX_PER_SINGER 硬配额）。
 *
 * 打的是**绝对分**而不是归一化分：分数本身不给用户看，只用来排序和解释。
 *
 * 同歌手分组用「键数组 + 组数组」而不是 Map：qt-pc 遍历 Map.values()，而 UTS 侧 Map
 * 不遍历键是全库既有约定（recommend-types.ts 顶部说明），候选只有 10~30 首，indexOf 足够。
 */
function scoreRuleCandidates(
  input: AssistantTurnInput,
  keywords: string[],
  named: NamedHits,
): ScoredRuleSong[] {
  const keywordKeys: string[] = [];
  for (let i = 0; i < keywords.length; i++) {
    const key = normText(keywords[i]);
    if (key.length > 0) keywordKeys.push(key);
  }

  let profileStyle: TrackStyle | null = null;
  const profile = input.profile;
  if (profile != null && profileHasSignal(profile)) profileStyle = trackStyleOfProfile(profile);

  const scored: ScoredRuleSong[] = [];
  for (let i = 0; i < input.candidates.length; i++) {
    const song = input.candidates[i];
    const fields: string[] = [];
    const nameKey = normText(song.name);
    if (nameKey.length > 0) fields.push(nameKey);
    const singerKey = normText(song.singer);
    if (singerKey.length > 0) fields.push(singerKey);
    const albumKey = normText(song.album);
    if (albumKey.length > 0) fields.push(albumKey);

    let baseScore = 0;
    for (let k = 0; k < keywordKeys.length; k++) {
      for (let f = 0; f < fields.length; f++) {
        if (fields[f].includes(keywordKeys[k])) baseScore += KEYWORD_FIELD_SCORE;
      }
    }
    if (named.indexes.indexOf(i) >= 0) baseScore += NAMED_SCORE;

    const style = trackStyle(song);
    if (profileStyle != null) {
      baseScore += Math.round(similarity(style, profileStyle) * PROFILE_SCORE_MAX);
    }
    scored.push({
      song: song,
      index: i,
      baseScore: baseScore,
      score: baseScore,
      singerKey: style.singerKey,
    });
  }

  // 同歌手降权：在每个歌手组内按分数排，第 2 首起扣分 —— 这样扣的是「同一个人里较差的
  // 那几首」，而不是候选里碰巧排在后面的那几首（后者会把好歌误伤）。
  const groupKeys: string[] = [];
  const groups: ScoredRuleSong[][] = [];
  for (let i = 0; i < scored.length; i++) {
    const item = scored[i];
    const key =
      item.singerKey.length > 0
        ? item.singerKey
        : "__track:" + trackKeyOf(item.song.platform, item.song.id);
    const at = groupKeys.indexOf(key);
    if (at >= 0) groups[at].push(item);
    else {
      groupKeys.push(key);
      const group: ScoredRuleSong[] = [];
      group.push(item);
      groups.push(group);
    }
  }
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (group.length < 2) continue;
    group.sort((a, b): number => {
      const diff = b.baseScore - a.baseScore;
      if (diff != 0) return diff;
      return a.index - b.index;
    });
    for (let i = 1; i < group.length; i++) group[i].score = group[i].score - SAME_SINGER_PENALTY;
  }
  return scored;
}

/**
 * 按分数降序取歌：同分保持候选原顺序，同一歌手最多 2 首（用户点名的歌手不限），
 * 按 trackKey 去重，最多 count 首。
 *
 * 为什么「先排序再筛配额」而不是反过来：筛完再排会让候选原顺序的权重过大，
 * 用户搜出来的第一页顺序不该压过他自己说出来的风格。
 */
function pickRuleSongs(
  scored: ScoredRuleSong[],
  count: number,
  relaxedSingers: string[],
): Song[] {
  const ordered = scored.slice();
  ordered.sort((a, b): number => {
    const diff = b.score - a.score;
    if (diff != 0) return diff;
    return a.index - b.index;
  });

  const picked: Song[] = [];
  const usedKeys = new Set<string>();
  const singerKeys: string[] = [];
  const singerNums: number[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (picked.length >= count) break;
    const item = ordered[i];
    const key = trackKeyOf(item.song.platform, item.song.id);
    if (usedKeys.has(key)) continue;
    const singerKey =
      item.singerKey.length > 0 ? item.singerKey : "__track:" + key;
    const relaxed = relaxedSingers.indexOf(normText(item.song.singer)) >= 0;
    const at = singerKeys.indexOf(singerKey);
    const taken = at >= 0 ? singerNums[at] : 0;
    if (!relaxed && taken >= MAX_PER_SINGER) continue;

    usedKeys.add(key);
    if (at >= 0) singerNums[at] = taken + 1;
    else {
      singerKeys.push(singerKey);
      singerNums.push(1);
    }
    picked.push(item.song);
  }
  return picked;
}

// ---------- rule：reply ----------

/**
 * 规则模式的 reply：把「按什么理解你的话」说出来。
 *
 * 四档优先级（关键词 > 点名 > 画像 > 兜底）和实际打分的优先级一致，用户才能对上账：
 * 说了「古风」就先提古风，只说「周杰伦」就提周杰伦。没有依据时**明说**是「刚搜到的歌」，
 * 不要假装懂口味 —— 那会让用户以为之后能靠这句话继续收敛。
 */
function ruleReply(
  input: AssistantTurnInput,
  keywords: string[],
  named: string[],
  songs: Song[],
): string {
  if (keywords.length > 0) {
    const spoken: string[] = [];
    for (let i = 0; i < keywords.length && spoken.length < 3; i++) spoken.push(keywords[i]);
    return "按你说的「" + spoken.join("、") + "」挑了 " + songs.length + " 首，先从最贴近的开始听。";
  }
  if (named.length > 0) {
    return "按你点到的「" + named[0] + "」找了 " + songs.length + " 首。";
  }
  if (profileHasSignal(input.profile)) {
    return "按你最近的听歌口味挑了 " + songs.length + " 首。";
  }
  return "先从刚搜到的歌里挑了 " + songs.length + " 首，说个歌手或风格我再收敛。";
}

/** 规则回合的中间产物：local 回退时直接复用，不再算第二遍 */
interface RulePlan {
  keywords: string[];
  named: string[];
  songs: Song[];
  reply: string;
}

/** 跑一遍规则：关键词/画像排序 + 规则文案 */
function planRuleTurn(input: AssistantTurnInput): RulePlan {
  if (input.candidates.length == 0) {
    return { keywords: [], named: [], songs: [], reply: EMPTY_CANDIDATE_REPLY };
  }
  const keywords = collectKeywords(input.text);
  const named = findNamed(input.candidates, input.text);
  const count = requestedSongCount(input.text);
  const songs = pickRuleSongs(
    scoreRuleCandidates(input, keywords, named),
    count,
    namedSingers(input.candidates, named),
  );
  if (songs.length == 0) {
    return { keywords: keywords, named: named.labels, songs: [], reply: NO_PICK_REPLY };
  }
  return {
    keywords: keywords,
    named: named.labels,
    songs: songs,
    reply: ruleReply(input, keywords, named.labels, songs),
  };
}

// ---------- local：prompt ----------

/** 候选行：`1. 晴天 - 周杰伦（叶惠美）`。缺专辑时给「未知专辑」，避免出现空括号 */
function candidateLine(song: Song, index: number): string {
  const album = song.album.trim();
  const albumText = album.length > 0 ? album : "未知专辑";
  return (index + 1) + ". " + song.name + " - " + song.singer + "（" + albumText + "）";
}

/**
 * 组本地模型的 messages：一条 system（角色 + 输出契约）+ 一条 user（这句话 + 上下文）。
 *
 * 为什么把输出契约写死在系统消息里：本地小模型对「结构化输出」的服从度取决于提示词有多
 * 具体。给 JSON 形状 + 序号含义 + 禁止事项三件套，配合 parseLocalReply 的硬校验
 * （越界/重复序号丢弃），模型就没有编造歌名的空间。
 *
 * 历史只取最后 4 条：再往前是上一轮的话题，很容易把「这句话」的意图淹没。负下标 slice
 * 在 UTS 侧没有先例，这里改成算起点下标。
 */
function buildLocalMessages(input: AssistantTurnInput, count: number): AiLocalMessage[] {
  const system =
    "你是轻听内置的音乐助手，只从用户给的候选歌曲里挑，绝不编造歌名或歌手。\n\n" +
    "输出要求：只输出一个 JSON 对象，形如 {\"reply\":\"一句中文回答（不超过60字）\",\"picks\":[1,2,3]}；" +
    "picks 是候选序号（1 起）按推荐顺序，最多 " + count + " 个；不能输出任何解释、代码块围栏或其它文字。";

  const sections: string[] = [];
  sections.push("用户这句话：" + input.text.trim());

  const total = input.history.length;
  let from = total - INPUT_HISTORY_MAX;
  if (from < 0) from = 0;
  const promptFrom = total - PROMPT_HISTORY_MAX;
  if (promptFrom > from) from = promptFrom;
  const historyLines: string[] = [];
  for (let i = from; i < total; i++) {
    const turn = input.history[i];
    const content = turn.content.trim();
    if (content.length == 0) continue;
    historyLines.push((turn.role == "user" ? "用户" : "你") + "：" + content);
  }
  if (historyLines.length > 0) {
    sections.push("最近对话：\n" + historyLines.join("\n"));
  }

  const lines: string[] = [];
  lines.push("候选歌曲（共 " + input.candidates.length + " 首）：");
  for (let i = 0; i < input.candidates.length; i++) {
    lines.push(candidateLine(input.candidates[i], i));
  }
  sections.push(lines.join("\n"));

  const profile = input.profile;
  if (profile != null && profileHasSignal(profile)) {
    sections.push("用户的听歌画像：" + describeProfile(profile));
  }

  const messages: AiLocalMessage[] = [];
  messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: sections.join("\n\n") });
  return messages;
}

// ---------- local：解析 ----------

/** 本地模型输出解析结果 */
interface ParsedLocalReply {
  reply: string;
  songs: Song[];
  /** 解析到的问题（成功为空串）：调用方据此写 note 并决定是否回退规则 */
  problem: string;
}

/**
 * 剥掉 markdown 代码围栏（模型最常见的「多余装饰」）。
 *
 * 手写而不是用 `/```(?:json)?\s*([\s\S]*?)```/i`：lazy 量词与 [\s\S] 在本仓库没有先例
 * （.match(/) 也是 0 处，正则一律用常量 + exec），indexOf 版本在各端行为完全可预期。
 */
function stripCodeFence(raw: string): string {
  const start = raw.indexOf("```");
  if (start < 0) return raw.trim();
  let body = raw.substring(start + 3);
  const end = body.indexOf("```");
  if (end >= 0) body = body.substring(0, end);
  body = body.trim();
  // 紧跟围栏的语言标记（json / JSON）要去掉，剩下的才是正文
  const head = body.substring(0, 4).toLowerCase();
  if (head == "json") body = body.substring(4).trim();
  return body.length > 0 ? body : raw.trim();
}

/** 序号容错：接受数字与纯数字字符串，其它一律 -1（当作无效丢弃） */
function toPickIndex(raw: any): number {
  if (typeof raw == "number") return raw as number;
  if (typeof raw == "string") {
    const text = (raw as string).trim();
    if (!PURE_DIGITS.test(text)) return -1;
    return parseInt(text, 10);
  }
  return -1;
}

/**
 * 序号 → 歌曲：越界、重复序号、重复曲目直接丢（不是纠正成别的歌 —— 纠正等于替模型编造）。
 * 最多 count 首。
 *
 * qt-pc 用 NaN 表示无效序号，这里用 -1（理由同 countOf 的哨兵说明）。
 */
function mapPicks(rawPicks: any[], candidates: Song[], count: number): Song[] {
  const picked: Song[] = [];
  const usedIndexes: number[] = [];
  const usedKeys = new Set<string>();
  for (let i = 0; i < rawPicks.length; i++) {
    if (picked.length >= count) break;
    const index = toPickIndex(rawPicks[i]);
    if (index < 1 || index > candidates.length) continue;
    if (usedIndexes.indexOf(index) >= 0) continue;
    const song = candidates[index - 1];
    if (song == null) continue;
    const key = trackKeyOf(song.platform, song.id);
    if (usedKeys.has(key)) continue;
    usedIndexes.push(index);
    usedKeys.add(key);
    picked.push(song);
  }
  return picked;
}

/** 从解析结果里取出序号数组：整段数组，或对象里的 picks 字段 */
function rawPicksOf(value: any): any[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value as any[];
  if (typeof value != "object") return null;
  const picks = (value as any).picks;
  if (picks == null || !Array.isArray(picks)) return null;
  return picks as any[];
}

/** JSON 里的 reply 字段（没有/不是字符串就空串） */
function jsonReplyOf(value: any): string {
  if (value == null || typeof value != "object") return "";
  const raw = (value as any).reply;
  if (raw == null || typeof raw != "string") return "";
  const text = (raw as string).trim();
  return truncateChars(text, LOCAL_REPLY_MAX_CHARS);
}

/**
 * 去掉 JSON / 围栏片段后的正文（模型把话写在 JSON 外面时取首句用）。
 *
 * 手写扫描而不是 `/\{[\s\S]*\}/g` + `/\[[^\]]*\]/g`：见 stripCodeFence 的理由。
 * 花括号/方括号只剥「成对出现」的整段，JSON 里套数组也不会把正文吃光。
 */
function stripJsonFragments(raw: string): string {
  let out = "";
  let braces = 0;
  let brackets = 0;
  let inFence = false;
  for (let i = 0; i < raw.length; i++) {
    if (i + 2 < raw.length && raw.substring(i, i + 3) == "```") {
      inFence = !inFence;
      i += 2;
      continue;
    }
    // UTS 侧字符串按位取字符统一用 charAt（见 aggregate-merge.ts），别用 raw[i]
    const ch = raw.charAt(i);
    if (inFence) continue;
    if (ch == "{") {
      braces += 1;
      continue;
    }
    if (ch == "}") {
      if (braces > 0) braces -= 1;
      continue;
    }
    if (ch == "[") {
      brackets += 1;
      continue;
    }
    if (ch == "]") {
      if (brackets > 0) brackets -= 1;
      continue;
    }
    if (braces > 0 || brackets > 0) continue;
    out += ch;
  }
  return out;
}

/** 去掉 JSON/围栏片段后的正文首句（截断 80 字）：模型把话写在 JSON 外面时的兜底 */
function firstSentenceOf(raw: string): string {
  const body = stripJsonFragments(raw);
  const parts = body.split(SENTENCE_SPLIT);
  const first = parts.length > 0 ? parts[0] : "";
  const trimmed = first.replace(LEAD_PUNCT, "").replace(TAIL_PUNCT, "");
  return truncateChars(trimmed, LOCAL_REPLY_MAX_CHARS);
}

/**
 * 解析本地模型的输出，**永不 throw**。
 *
 * 三级降级：整段 JSON（含剥围栏）→ extractJsonArray 抠第一个数组 → 正则捞
 * `picks: [...]`。reply 优先取 JSON 的 reply 字段，其次取去掉 JSON 片段后的正文首句。
 * 都解析不出来就返回 problem，交给调用方回退规则 —— 这里不决定「失败」，只负责
 * 「能读出什么就读什么」。
 */
function parseLocalReply(raw: string, candidates: Song[], count: number): ParsedLocalReply {
  const content = raw.trim();
  if (content.length == 0) return { reply: "", songs: [], problem: "本机模型没有返回内容" };

  // 1) 整段 JSON：先剥围栏，模型「```json {...}```」是最常见的合法但带壳输出
  let value: any = null;
  let parsed = false;
  try {
    value = JSON.parse(stripCodeFence(content)) as any;
    parsed = value != null;
  } catch {
    // 静默：带壳/半截 JSON 是最常见情况，交给下一级「抠数组」，这里不必知道原因
    parsed = false;
  }

  // 2) 抠第一个 JSON 数组（模型偷懒只回 [3,1,5]）
  let textForReply = content;
  if (!parsed) {
    const arrayText = extractJsonArray(content);
    if (arrayText != null) {
      try {
        value = JSON.parse(arrayText) as any;
        parsed = value != null;
        if (parsed) textForReply = content.split(arrayText).join(" ");
      } catch {
        // 静默：数组也坏了，下一级还会用正则捞序号，这里吞掉即可
        parsed = false;
      }
    }
  }

  // 3) 正则捞 picks：JSON 坏了但序号还在
  if (!parsed) {
    const matched = PICKS_PATTERN.exec(content);
    if (matched == null) {
      return { reply: "", songs: [], problem: "模型回复里没有可用的 JSON 或序号" };
    }
    const body = matched[1];
    const songs = body != null ? mapPicks(body.split(","), candidates, count) : [];
    const sentence = firstSentenceOf(content.split(matched[0]).join(" "));
    if (songs.length == 0) return { reply: sentence, songs: [], problem: "模型没给出有效的候选序号" };
    if (sentence.length == 0) {
      return { reply: "", songs: songs, problem: "模型只回了序号，没有回答文案" };
    }
    return { reply: sentence, songs: songs, problem: "" };
  }

  const rawPicks = rawPicksOf(value);
  const songs = rawPicks != null ? mapPicks(rawPicks, candidates, count) : [];
  const jsonReply = jsonReplyOf(value);
  const reply = jsonReply.length > 0 ? jsonReply : firstSentenceOf(textForReply);
  if (songs.length == 0) return { reply: reply, songs: [], problem: "模型没给出有效的候选序号" };
  if (reply.length == 0) return { reply: "", songs: songs, problem: "模型只回了序号，没有回答文案" };
  return { reply: reply, songs: songs, problem: "" };
}

// ---------- local：调用 ----------

/** 异常 → 一句话原因（note 用）：只认 Error.message，其它一律「未说明原因」 */
function reasonOf(e: any): string {
  if (e instanceof Error) {
    const message = e.message.trim();
    return truncateChars(message.length > 0 ? message : "未说明原因", NOTE_MAX_CHARS);
  }
  return "未说明原因";
}

/**
 * 叫本机配置的模型挑歌；任何失败（没配置/超时/回废话）都回退规则结果，不 throw。
 *
 * engine 是集成层和用户都能读的「这次是谁挑的」：规则回退时必须是 "rule"，
 * 免得用户以为模型挂了还在算 AI 结果。note 则是给页面提示条的一句话原因。
 */
async function runLocalTurn(input: AssistantTurnInput, rule: RulePlan): Promise<AssistantTurnResult> {
  if (input.candidates.length == 0) {
    return {
      reply: rule.reply,
      songs: rule.songs,
      engine: RULE_ENGINE,
      note: "候选为空，直接用规则挑",
    };
  }

  const count = requestedSongCount(input.text);
  let raw = "";
  try {
    const messages = buildLocalMessages(input, count);
    const reply = await aiLocalChat(messages, LOCAL_TEMPERATURE);
    raw = reply.content;
  } catch (e) {
    // 静默：没配接口/断网/超时/响应体坏都在这里。助手的任务是「听到歌」，退回规则
    // 并写 note 就够，不该把网络异常当错误气泡弹给用户。
    return {
      reply: rule.reply,
      songs: rule.songs,
      engine: RULE_ENGINE,
      note: "本机模型不可用，已用规则挑：" + reasonOf(e),
    };
  }

  const parsed = parseLocalReply(raw, input.candidates, count);
  if (parsed.problem.length > 0) {
    // 解析失败：reply 用规则文案（不把模型的半句话混进来，否则用户以为这次是模型给的）
    return { reply: rule.reply, songs: rule.songs, engine: RULE_ENGINE, note: parsed.problem };
  }
  return { reply: parsed.reply, songs: parsed.songs, engine: LOCAL_ENGINE, note: "" };
}

// ---------- 对外入口 ----------

/**
 * 跑一次音乐助手的本地回合（`rule` / `local`）。
 *
 * `rule`：纯本地排序 + 规则文案，engine 恒为 "rule"、note 为空。
 * `local`：候选为空直接走规则；否则调本机模型，解析失败/调用失败/序号无效都退回规则
 * 结果（engine 记为 "rule"、note 写原因）。本函数**不会 throw** —— 助手页不该因为
 * 一句话没说清就没响应；连规则打分意外崩了也给一句话而不是白屏。
 */
export async function runAssistantTurn(input: AssistantTurnInput): Promise<AssistantTurnResult> {
  let rule: RulePlan;
  try {
    rule = planRuleTurn(input);
  } catch (e) {
    // 静默：规则打分是纯本地计算，理论上不该失败；真崩了也要给用户一句话而不是白屏，
    // 所以这里兜成空结果 + note，让页面还能提示换句话再说。
    return {
      reply: EMPTY_CANDIDATE_REPLY,
      songs: [],
      engine: RULE_ENGINE,
      note: "规则打分异常：" + reasonOf(e),
    };
  }
  if (input.mode == "rule") {
    return { reply: rule.reply, songs: rule.songs, engine: RULE_ENGINE, note: "" };
  }
  return runLocalTurn(input, rule);
}
