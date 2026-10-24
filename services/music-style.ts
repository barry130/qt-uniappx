/**
 * 口味画像：把「播放记录 + 收藏 + 歌单」提炼成「你喜欢什么风格」。
 * 与 qt-pc src/lib/music-style.ts 同一套规则（常量、阈值、口径注释一致）。
 *
 * 纯函数：只接收已取到的样本，now 由调用方注入 —— 画像进缓存后同一天两次生成
 * 必须得到同一个结果。信号全部零网络可算：文字种类/时长带/歌手专辑亲和/歌单风格词。
 *
 * 容器口径：Record<string, number> + Object.keys + numAt/numPut
 * （Map 键遍历在 UTS 无先例，见 recommend-types.ts 头注释）。
 */

import { clamp01, normText } from "./recommend-text";
import {
  DURATION_BAND_ORDER,
  MUSIC_LANG_ORDER,
  durationBandLabel,
  musicLangLabel,
  numAt,
  numMax,
  numPut,
  numSum,
} from "./recommend-types";
import type {
  DurationBand,
  MusicLang,
  StyleProfile,
  StyleProfileInput,
  StyleSample,
  TrackQuality,
  TrackStat,
  TrackStyle,
} from "./recommend-types";
import type { Song } from "@/types/music";

/** 主语种的最低占比：低于它不下结论（mainLang = und）。卡在两强相争与三足鼎立之间 */
export const MIN_MAIN_SHARE = 0.34;

/** 30 天：最近性线性衰减的窗口 */
const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** 只有收藏、没有播放统计时的权重：亲手收的比「没听过」硬，比真听过的弱 */
const SAVED_ONLY_WEIGHT = 0.5;

// ---------- 文字种类 ----------

type CharCounts = {
  kana: number;
  hangul: number;
  han: number;
  latin: number;
};

/** 逐码点统计四类文字（手动处理代理对，UTS 没有 codePointAt） */
function countScripts(text: string): CharCounts {
  const counts: CharCounts = { kana: 0, hangul: 0, han: 0, latin: 0 };
  let i = 0;
  while (i < text.length) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + (cp - 0xd800) * 0x400 + (lo - 0xdc00);
        i += 2;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
    if ((cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff)) {
      // ひらがな / カタカナ
      counts.kana += 1;
    } else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) {
      // 谚文音节 / 谚文字母
      counts.hangul += 1;
    } else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) {
      // 康熙部首区 + 扩展 A（生僻字、人名用字常落在这里）
      counts.han += 1;
    } else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      counts.latin += 1;
    }
  }
  return counts;
}

/**
 * 去掉括号内容（半角/全角圆括号、方括号、书名号）。中文歌常见的
 * 「中文名（英文别名）」里括号是副标题，参与「汉字 vs 拉丁」对比会把中文歌判成英文。
 */
function stripBrackets(raw: string): string {
  return raw.replace(/(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]|《[^》]*》)/g, "");
}

/**
 * 判断语种。优先级不可调换：
 * 1. 假名 → ja（只要出现假名就一定是日语；日文歌大量用汉字，只看汉字会全判成华语）；
 * 2. 谚文 → ko；3. 汉字 → zh，条件 汉字×2 ≥ 拉丁（去括号后比；1:2 容忍英文副标题）；
 * 4. 拉丁 → en（未去括号计数）；5. 其它 → und（判不出来，不是一种语种）。
 */
export function detectLanguage(text: string): MusicLang {
  const whole = countScripts(text);
  if (whole.kana > 0) return "ja";
  if (whole.hangul > 0) return "ko";
  const bare = countScripts(stripBrackets(text));
  if (bare.han > 0 && bare.han * 2 >= bare.latin) return "zh";
  if (whole.latin > 0) return "en";
  return "und";
}

/**
 * 时长带。未知时长给 normal 而不是 short：未知必须中性，
 * 否则画像会把用户描述成「爱听短歌」，给所有及格线的歌加错分。
 */
export function durationBandOf(seconds: number): DurationBand {
  if (!isFinite(seconds) || seconds <= 0) return "normal";
  if (seconds < 150) return "short";
  if (seconds < 240) return "normal";
  if (seconds < 330) return "long";
  return "epic";
}

/** 「等于没有专辑」的专辑名：缺元数据不是一张真专辑，不能参与专辑亲和 */
const UNKNOWN_ALBUM_KEYS: string[] = ["", "未知专辑", "未知", "unknown", "noalbum", "unknownalbum"];

function isUnknownAlbum(albumKey: string): boolean {
  for (let i = 0; i < UNKNOWN_ALBUM_KEYS.length; i++) {
    if (UNKNOWN_ALBUM_KEYS[i] === albumKey) return true;
  }
  return false;
}

/** 单曲的风格坐标：歌手键 / 专辑键 / 语种 / 时长带 */
export function trackStyle(song: Song): TrackStyle {
  const singerKey = normText(song.singer);
  const albumKey = normText(song.album);
  const albumKnown = !isUnknownAlbum(albumKey);
  const dur = typeof song.duration === "number" ? (song.duration as number) : 0;
  const style: TrackStyle = {
    singerKey: singerKey,
    // 带上歌手：一堆「精选」「Greatest Hits」同名不同人，只按专辑名会算成同一张
    albumKey: albumKnown ? `${singerKey}|${albumKey}` : "",
    lang: detectLanguage(`${song.name} ${song.singer} ${song.album}`),
    band: durationBandOf(dur),
  };
  return style;
}

/**
 * 行为质量。completion 是最有用的一个：totalPlayedMs ÷ (playCount×曲长) 把
 * 「反复点开听 20 秒就切」和「一遍遍听完」分开。两种未知都给 0.5（不冤枉不奖赏）。
 * skipped 只看行为不看 saved：收藏是调用方的事（收藏但听得少是「想听还没听」）。
 */
export function trackQuality(
  stat: TrackStat,
  durationSeconds: number,
  maxPlayCount: number,
  now: number,
): TrackQuality {
  const playCount = isFinite(stat.playCount) && stat.playCount > 0 ? stat.playCount : 0;
  const durationKnown = isFinite(durationSeconds) && durationSeconds > 0;

  const completion =
    playCount > 0 && durationKnown
      ? clamp01(stat.totalPlayedMs / (playCount * durationSeconds * 1000))
      : 0.5;

  const replay = maxPlayCount > 0 ? clamp01(playCount / maxPlayCount) : 0;

  // lastPlayedAt <= 0 = 没听过：最近性给 0（而不是 1），免得没听过的歌靠 recency 冒头
  const recency =
    stat.lastPlayedAt > 0 ? 1 - clamp01((now - stat.lastPlayedAt) / RECENCY_WINDOW_MS) : 0;

  const affinity = 0.5 * completion + 0.3 * replay + 0.2 * recency;

  const skipped = playCount >= 3 && completion < 0.4;

  const q: TrackQuality = {
    completion: completion,
    replay: replay,
    recency: recency,
    affinity: affinity,
    skipped: skipped,
  };
  return q;
}

// ---------- 风格词表 ----------

/**
 * 歌单名里的风格词 → 规范标签。只收语种与大曲风（不收心情/场景，没有区分度）；
 * 同一概念的俗称并成一档；不收复合词（拆开才能跨歌单合流计票）。
 */
type StyleTagEntry = { tag: string; aliases: string[] };

const STYLE_TAGS: StyleTagEntry[] = [
  { tag: "华语", aliases: ["华语", "国语", "中文"] },
  { tag: "粤语", aliases: ["粤语"] },
  { tag: "日语", aliases: ["日语", "日系", "二次元"] },
  { tag: "韩语", aliases: ["韩语", "韩系"] },
  { tag: "欧美", aliases: ["欧美", "英文"] },
  { tag: "流行", aliases: ["流行"] },
  { tag: "摇滚", aliases: ["摇滚"] },
  { tag: "民谣", aliases: ["民谣"] },
  { tag: "说唱", aliases: ["说唱", "嘻哈", "rap"] },
  { tag: "电子", aliases: ["电子", "电音"] },
  { tag: "古风", aliases: ["古风", "国风"] },
  { tag: "器乐", aliases: ["纯音乐", "器乐", "轻音乐"] },
  { tag: "爵士", aliases: ["爵士"] },
  { tag: "古典", aliases: ["古典"] },
  { tag: "怀旧", aliases: ["怀旧", "经典", "老歌"] },
  { tag: "治愈", aliases: ["治愈", "安静"] },
  { tag: "伤感", aliases: ["伤感"] },
  { tag: "燃", aliases: ["燃", "热血"] },
  { tag: "影视原声", aliases: ["影视", "ost", "原声"] },
  { tag: "儿歌", aliases: ["儿歌"] },
  { tag: "舞曲", aliases: ["dj", "舞曲"] },
  { tag: "乡村", aliases: ["乡村"] },
  { tag: "金属", aliases: ["金属"] },
];

/**
 * 从歌单名抽风格词：子串匹配 + 大小写不敏感；每个歌单名对同一 tag 最多一票
 * （「摇滚合集（摇滚）」不会因自己名字出现两次就压过三个歌单各提一次的「民谣」）。
 * 排序：次数降序，同次数按首次出现顺序（同输入同输出，画像要缓存）。
 */
function extractTags(names: string[]): string[] {
  const counts: Record<string, number> = {};
  const firstSeen: Record<string, number> = {};
  let order = 0;
  for (let n = 0; n < names.length; n++) {
    const lower = names[n].toLowerCase();
    if (lower.length == 0) continue;
    // 布尔表去重：同一歌单名里多个别名命中同一 tag 只算一次（Set 遍历无先例）
    const hit: Record<string, boolean> = {};
    for (let i = 0; i < STYLE_TAGS.length; i++) {
      const entry = STYLE_TAGS[i];
      for (let a = 0; a < entry.aliases.length; a++) {
        if (lower.includes(entry.aliases[a])) {
          hit[entry.tag] = true;
          break;
        }
      }
    }
    const hitTags = Object.keys(hit);
    for (let h = 0; h < hitTags.length; h++) {
      const tag = hitTags[h];
      if (firstSeen[tag] == undefined) firstSeen[tag] = order;
      counts[tag] = numAt(counts, tag) + 1;
      order += 1;
    }
  }
  const tags: string[] = Object.keys(counts);
  // 稳定排序：次数降序，同次数按 firstSeen 升序（UTS sort 无稳定保证，手动比两键）
  tags.sort((a, b) => {
    const diff = numAt(counts, b) - numAt(counts, a);
    if (diff != 0) return diff;
    return numAt(firstSeen, a) - numAt(firstSeen, b);
  });
  return tags;
}

// ---------- 画像 ----------

/** 样本权重：有统计看行为综合分；只有收藏给 0.5；两者都没有直接丢弃 */
function sampleWeight(sample: StyleSample, maxPlayCount: number, now: number): number {
  if (sample.stat != null) {
    const dur = typeof sample.song.duration === "number" ? (sample.song.duration as number) : 0;
    return trackQuality(sample.stat as TrackStat, dur, maxPlayCount, now).affinity;
  }
  return sample.saved ? SAVED_ONLY_WEIGHT : 0;
}

/**
 * 构造口味画像。归一化口径（两个不一样，别统一）：
 * - langs/bands 归一到 Σ=1：它们是「占比」；
 * - singers/albums 归一到最大值=1：打分要「相对最强者的比例」，按 Σ=1 会把
 *   只听一个歌手的用户的铁杆偏好抹平成小数。
 */
export function buildStyleProfile(input: StyleProfileInput): StyleProfile {
  const now = input.now;
  let maxPlayCount = 0;
  for (let i = 0; i < input.samples.length; i++) {
    const s = input.samples[i].stat;
    if (s != null && (s as TrackStat).playCount > maxPlayCount) {
      maxPlayCount = (s as TrackStat).playCount;
    }
  }

  const langs: Record<string, number> = {};
  const bands: Record<string, number> = {};
  const singers: Record<string, number> = {};
  const albums: Record<string, number> = {};

  const seen: Set<string> = new Set();
  let sampleSize = 0;

  for (let i = 0; i < input.samples.length; i++) {
    const sample = input.samples[i];
    // 同一首歌可能同时出现在播放记录和收藏里：按 trackKey 去重只算一次
    const key = `${sample.song.platform}:${sample.song.id}`;
    if (seen.has(key)) continue;
    const weight = sampleWeight(sample, maxPlayCount, now);
    // 既没听过又没收藏的歌不代表口味，权重 0 会把画像稀释成「什么都听一点」
    if (weight <= 0) continue;
    seen.add(key);
    sampleSize += 1;

    const style = trackStyle(sample.song);
    numPut(langs, style.lang, numAt(langs, style.lang) + weight);
    numPut(bands, style.band, numAt(bands, style.band) + weight);
    // 空歌手键（缺元数据）会聚成假歌手，把「常听 N 位歌手」撑大，丢掉
    if (style.singerKey.length > 0) {
      numPut(singers, style.singerKey, numAt(singers, style.singerKey) + weight);
    }
    if (style.albumKey.length > 0) {
      numPut(albums, style.albumKey, numAt(albums, style.albumKey) + weight);
    }
  }

  const langsTotal = numSum(langs);
  if (langsTotal > 0) {
    const keys = Object.keys(langs);
    for (let i = 0; i < keys.length; i++) numPut(langs, keys[i], numAt(langs, keys[i]) / langsTotal);
  }
  const bandsTotal = numSum(bands);
  if (bandsTotal > 0) {
    const keys = Object.keys(bands);
    for (let i = 0; i < keys.length; i++) numPut(bands, keys[i], numAt(bands, keys[i]) / bandsTotal);
  }
  const maxSinger = numMax(singers);
  if (maxSinger > 0) {
    const keys = Object.keys(singers);
    for (let i = 0; i < keys.length; i++) numPut(singers, keys[i], numAt(singers, keys[i]) / maxSinger);
  }
  const maxAlbum = numMax(albums);
  if (maxAlbum > 0) {
    const keys = Object.keys(albums);
    for (let i = 0; i < keys.length; i++) numPut(albums, keys[i], numAt(albums, keys[i]) / maxAlbum);
  }

  // 主语种：und 不参与竞争；同权重按 zh/ja/ko/en 顺序取（两强相争时华语优先）
  let mainLang = "und";
  let bestShare = 0;
  for (let i = 0; i < MUSIC_LANG_ORDER.length; i++) {
    const share = numAt(langs, MUSIC_LANG_ORDER[i]);
    if (share > bestShare) {
      bestShare = share;
      mainLang = MUSIC_LANG_ORDER[i];
    }
  }
  if (bestShare < MIN_MAIN_SHARE) mainLang = "und";

  let mainBand = "normal";
  let bestBand = 0;
  for (let i = 0; i < DURATION_BAND_ORDER.length; i++) {
    const share = numAt(bands, DURATION_BAND_ORDER[i]);
    if (share > bestBand) {
      bestBand = share;
      mainBand = DURATION_BAND_ORDER[i];
    }
  }

  const profile: StyleProfile = {
    langs: langs,
    bands: bands,
    mainLang: mainLang,
    mainBand: mainBand,
    singers: singers,
    albums: albums,
    tags: extractTags(input.playlistNames),
    sampleSize: sampleSize,
  };
  return profile;
}

/**
 * 一行中文描述，给 UI 和模型提示词共用。不列数字权重，只说结论；
 * 画像空时明说不知道（或念回用户亲手选的风格），不编默认口味。
 */
export function describeProfile(profile: StyleProfile): string {
  if (profile.sampleSize <= 0) {
    if (profile.tags.length > 0) {
      return `你选的风格：${profile.tags.slice(0, 2).join(" · ")}`;
    }
    return "口味还不明显";
  }
  const parts: string[] = [];
  // und 是「判不出来」，说出来只会让用户困惑，省略语种段
  if (profile.mainLang !== "und") parts.push(musicLangLabel(profile.mainLang));
  parts.push(durationBandLabel(profile.mainBand));
  const singerCount = Object.keys(profile.singers).length;
  if (singerCount > 0) parts.push(`常听 ${singerCount} 位歌手`);
  // 最多带一个 tag，且与主语种同名的跳过（说了两遍「华语」是纯重复）
  const mainLangLabel = profile.mainLang === "und" ? "" : musicLangLabel(profile.mainLang);
  let tag = "";
  for (let i = 0; i < profile.tags.length; i++) {
    if (profile.tags[i] !== mainLangLabel) {
      tag = profile.tags[i];
      break;
    }
  }
  if (tag.length > 0) parts.push(`常听${tag}`);
  return parts.join(" · ");
}

/**
 * 把 tags 摊成带权重的列表供打分复用：权重 = (n - index) / n，
 * 第一位（次数最多）为 1。把「排序」翻译成「分数」的最省事口径。
 */
export type TagWeight = { tag: string; weight: number };
