/**
 * 收藏时的「同名不同源」查重（2026-10-07）—— 与 qt-pc 的 src/lib/collect-dup.ts 同口径
 * （人工保持同步）。
 *
 * 为什么需要：收藏表按 (platform, id) 唯一，同一首歌在不同音源上是**两条独立
 * 记录**（id 不同、platform 不同）。所以「稻香（QQ）」和「稻香（网易云）」能
 * 同时躺在一个歌单里，界面上看就是两行一模一样的歌。收藏前提示一次，让用户
 * 自己决定要不要继续，比收藏完再翻列表删掉轻松得多。
 *
 * 只做判定、不做 IO，也不依赖任何接口：归一化与包含判定取自
 * services/source-switch.ts 的 scoreCandidate 同款规则，但这里只关心「是不是
 * 同名」，不打分排序。
 */
import type { Song } from "@/types/music";
import { platformLabel } from "@/services/platform";

/** 一次查重的结果：某个歌单里已有的同名冲突曲（UI 拿它拼提示文案） */
export type CollectDupConflict = {
  /** 歌单 id（选择器用的那个） */
  playlistId: string;
  playlistName: string;
  /** 冲突曲目：与待收藏的歌同名、但来自别的音源 */
  dups: Song[];
};

/**
 * 歌手字段里常见的分隔符：各音源写法不一（`/`、`&`、`、`、`／`、`|`、`+`、
 * 中文「和」「与」等），而且「周杰伦 / 林妙可」和「周杰伦&林妙可」是同一批人。
 * 判定前统一替换成半角逗号，拆成集合再比对。
 */
const ARTIST_SEPARATORS = /[\/／\\|&、,，;；+＋]|\s*(?:和|与|feat\.?|ft\.?)\s*/gi;

/** 归一化匹配文本：小写 + 空白折叠 */
function normalizeForDup(text: string): string {
  if (text == null) return "";
  return text.toLowerCase().replace(/\s+/g, "");
}

/** 把歌手字段拆成集合（归一化后的每个名字） */
function splitArtists(text: string): string[] {
  const out: string[] = [];
  if (text == null) return out;
  const parts: string[] = text.split(ARTIST_SEPARATORS);
  for (let i = 0; i < parts.length; i++) {
    const name = normalizeForDup(parts[i]);
    if (name.length > 0) out.push(name);
  }
  return out;
}

/**
 * 歌名里的「版本修饰」：整块括号里说的只是版本/用途，不影响是不是同一首歌。
 * 剥掉它们再比，`稻香 (Live)` 与 `稻香`、「某某（伴奏）」与「某某」才算同名。
 */
const TITLE_NOISE =
  /[（(\[【][^)）\]】]*(?:live|remix|instrumental|acoustic|cover|demo|ost|mv|伴奏|翻唱|纯音乐|清唱|现场|原声|版)[^)）\]】]*[)）\]】]/gi;

/** 比对前连标点/括号一起剥掉：全角半角写法不同不该影响判定 */
const TITLE_PUNCT =
  /[()（）\[\]【】{}<>《》「」『』""''.,，。、:：;；!！?？~～_\-—…·|/\\]/g;

/** 歌名归一化：小写 → 剥版本修饰 → 折叠空白 → 剥标点 */
function normalizeTitle(text: string): string {
  if (text == null) return "";
  return text
    .toLowerCase()
    .replace(TITLE_NOISE, "")
    .replace(/\s+/g, "")
    .replace(TITLE_PUNCT, "");
}

/** 两首歌是否同名：归一化后相等或互相包含（一边带「(Live)」这类后缀仍算同名）。空名判否。 */
function sameName(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (x.length == 0 || y.length == 0) return false;
  return x == y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
}

/**
 * 歌手是否对得上：**拆成集合后只要有一个名字对得上就算**。
 *
 * 为什么要拆：各音源的合写符号完全不同（`/`、`&`、`&`、`、`、`／`、`|`、
 * `+`、`和`、`feat.`），「周杰伦 / 林妙可」与「周杰伦&林妙可」是同一批人，
 * 但整串比对（旧写法）互不包含，会被判成两首歌 —— 这正是要修的漏判。
 *
 * 两边都为空（纯音乐 / 元数据缺失）时不拦。
 */
function singerCompatible(a: string, b: string): boolean {
  const x = splitArtists(a);
  const y = splitArtists(b);
  if (x.length == 0 || y.length == 0) return true;
  for (let i = 0; i < x.length; i++) {
    for (let j = 0; j < y.length; j++) {
      const p = x[i];
      const q = y[j];
      if (p == q || p.indexOf(q) >= 0 || q.indexOf(p) >= 0) return true;
    }
  }
  return false;
}

/**
 * 在目标歌单现有的歌里找「同名不同源」的歌。
 *
 * @param song     准备收藏的歌
 * @param existing 目标歌单里已有的歌（调用方用 store 的 songsOfPid 取）
 * @returns 冲突曲目（platform 与 song 不同、但同名）；无冲突返回空数组
 *
 * 「同名同 id 同平台」不算冲突：那是同一首歌，收藏本身是幂等的。
 */
export function findCrossSourceDup(song: Song, existing: Song[]): Song[] {
  const out: Song[] = [];
  if (song == null || existing == null) return out;
  for (let i = 0; i < existing.length; i++) {
    const item = existing[i];
    if (item == null) continue;
    if (item.platform == song.platform) continue;
    if (!sameName(item.name, song.name)) continue;
    if (!singerCompatible(item.singer, song.singer)) continue;
    out.push(item);
  }
  return out;
}

/**
 * 冲突提示文案（弹出确认框的 content）。
 *
 * 举例：「「我喜欢的歌曲」里已经有 1 首同名的网易云版本（周杰伦），仍要收藏？」
 * 只给一处冲突时把歌手也带上，帮用户确认是不是同一首；多处冲突只报数量，
 * 免得文案长到看不完。
 */
export function collectDupMessage(playlistName: string, dups: Song[]): string {
  if (dups.length == 0) return "";
  const first = dups[0];
  const from = platformLabel(first.platform);
  if (dups.length == 1 && first.singer.length > 0) {
    return "「" + playlistName + "」里已经有一首同名的" + from + "版本（" + first.singer + "），仍要收藏？";
  }
  if (dups.length == 1) {
    return "「" + playlistName + "」里已经有一首同名的" + from + "版本，仍要收藏？";
  }
  return "「" + playlistName + "」里已经有 " + dups.length + " 首同名歌曲（其他音源），仍要收藏？";
}
