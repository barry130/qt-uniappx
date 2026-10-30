/**
 * 本地优先播放（qt-pc DESIGN §7.13 的 uni-app x 端移植）。
 *
 * 两条链共一把总开关（settings 存储 `qt-playback-local-first`，键不存在按**开**）：
 * 1. 在线歌解析链：每次懒解析取链之前先全本地查一遍——
 *    ① 下载账本（身份级：platform:id 精确，文件确实在盘上才命中）
 *    ⑤ 本地曲库（元数据级：标题归一化全等 + 歌手 token 相交 + 时长差 ≤3s）
 *    命中直接把本地文件交给原生层，跳过全部取链（断网/地址过期都不怕）。
 * 2. 本地歌替身链：本地歌文件不在了（被移动/删除，收藏死条目的主要来源）：
 *    A 本地曲库同元数据的另一条 → B 下载账本同曲文件 → C 在线搜索第一条
 *    （前 5 条里时长最接近的，护栏 ≤5s，都不接近取第 1 条兜底——qt-pc 口径）。
 *
 * 与 qt-pc 的差异：移动端没有应用侧文件账本孤儿索引（orphan_files），
 * 池 B 只有下载账本；content:// URI 无法低成本 stat，本地曲库命中不做
 * 存在性预检（真失效由原生 prepare 错误 → 替身链/失败路径兜住）。
 *
 * 替身链不改收藏（用户 2026-10-28 定案）：只决定本次播什么，
 * 收藏/歌单归属一律不动——收藏是用户自己落的选择，失效时自动顶播可以，
 * 替用户做主重链不行。
 */
import { musicApi } from "@/services/music-api";
import { logMsg } from "@/services/logger";
import { useDownloadsStore } from "@/stores/downloads";
import type { Song } from "@/types/music";
import type { LocalAudioItem } from "@/uni_modules/qt-app-native";

/** 总开关持久化键（对齐 audio-player.uts 的 GAPLESS_KEY 命名风格） */
const LOCAL_FIRST_KEY = "qt-playback-local-first";
/** 本地曲库扫描存档键（pages/local/index.uvue 写入，播放报告同源读取） */
const LOCAL_AUDIO_KEY = "qt-local-audio-v1";
/** 元数据匹配时长护栏（秒）：任一侧未知放行，双侧已知差值超过即拒绝 */
const DURATION_GUARD_S = 3;
/** 池 C 搜索替身时长护栏（秒） */
const SEARCH_GUARD_S = 5;
/** 池 C 只在前 5 条里挑（qt-pc 口径） */
const SEARCH_PICK_LIMIT = 5;

/** 开关读：键不存在按开（新功能默认生效，与 qt-pc play.localFirst 口径一致） */
export function localFirstEnabled(): boolean {
  try {
    return uni.getStorageSync(LOCAL_FIRST_KEY) !== false;
  } catch (_) {
    return true;
  }
}

/** 开关写：设置页「本地优先播放」行用 */
export function setLocalFirst(on: boolean): void {
  try {
    uni.setStorageSync(LOCAL_FIRST_KEY, on);
  } catch (_) {
    // 静默：写不进持久化本次会话内仍生效（内存行为每次现读）
  }
}

/**
 * 「参与匹配的字符」判定：对齐 qt-pc `local_first::normalize_text` 用的
 * `char::is_alphanumeric`（字母或数字，标点/空白/符号一律不算）。
 *
 * 为什么不用「排除标点区间」的写法：那样全角字母数字（ＡＢＣ / １２３，落在
 * 0xff01-0xff5e 里）会连同全角标点一起被丢掉，而 PC 侧 `is_alphanumeric`
 * 是认它们的——同一首歌两端归一化结果不同，就会一边命中一边不命中。
 * 这里改成白名单：只有明确是字母/数字的码位才保留。
 *
 * 覆盖范围按音乐标签的实际情况取：ASCII、拉丁补充与扩展、希腊、西里尔、
 * 希伯来、假名、注音、韩文、中日韩汉字（含扩展 A 与兼容表意）、全角字母
 * 数字，以及 UTF-16 代理对（扩展 B 及以后的汉字拆成两个码元，整对保留）。
 */
function isMatchChar(code: number): boolean {
  // 控制字符与空白（含全角空格）：PC 侧 is_alphanumeric 对它们为假
  if (code <= 0x20 || code == 0x3000) return false;
  // ASCII 数字与字母
  if (code >= 0x30 && code <= 0x39) return true;
  if (code >= 0x41 && code <= 0x5a) return true;
  if (code >= 0x61 && code <= 0x7a) return true;
  // 拉丁补充与扩展（é ø ā ł…），排掉 × ÷ 两个符号
  if (code >= 0xc0 && code <= 0x24f) return code != 0xd7 && code != 0xf7;
  // 序数词与微符号这类孤立的字母
  if (code == 0xaa || code == 0xb5 || code == 0xba) return true;
  // 希腊、西里尔、希伯来、阿拉伯、亚美尼亚、格鲁吉亚
  if (code >= 0x370 && code <= 0x4ff) return true;
  if (code >= 0x531 && code <= 0x58f) return true;
  if (code >= 0x5d0 && code <= 0x5ea) return true;
  if (code >= 0x620 && code <= 0x6ff) return true;
  // 假名、注音
  if (code >= 0x3040 && code <= 0x30ff) return true;
  if (code >= 0x3105 && code <= 0x312f) return true;
  // 韩文（字母区与音节区）
  if (code >= 0x1100 && code <= 0x11ff) return true;
  if (code >= 0xac00 && code <= 0xd7a3) return true;
  // 中日韩汉字：扩展 A、基本区、兼容表意
  if (code >= 0x3400 && code <= 0x4dbf) return true;
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  if (code >= 0xf900 && code <= 0xfaff) return true;
  // 代理对高位/低位（扩展 B 及以后的汉字与符号）
  if (code >= 0xd800 && code <= 0xdfff) return true;
  // 全角数字与字母（ＰＣ 侧认，不能当标点丢掉）
  if (code >= 0xff10 && code <= 0xff19) return true;
  if (code >= 0xff21 && code <= 0xff3a) return true;
  if (code >= 0xff41 && code <= 0xff5a) return true;
  return false;
}

/**
 * 标题归一化：小写 + 只留字母数字（对齐 qt-pc local_first::normalize_text）。
 * 「Canon (经典版)」与「canon经典版」归一化后相等——标点、空格、《》「」等
 * 装饰全部丢掉。手动 charCode 扫描，不依赖正则（仓库设备端代码的既定口径）。
 */
export function normalizeForMatch(input: string): string {
  const src = input.toLowerCase();
  let out = "";
  for (let i = 0; i < src.length; i++) {
    if (!isMatchChar(src.charCodeAt(i))) continue;
    out += src[i];
  }
  return out;
}

/**
 * 歌手拆 token：**任意非字母数字字符**都是分隔符，逐段归一化（对齐 qt-pc
 * local_first::singer_tokens 的 `split(|c| !c.is_alphanumeric())`）。
 *
 * 不是维护一张分隔符清单：`feat.` / `ft.` / `·` / 全角括号 / 各种连字符写法
 * 都能自然切开，清单式写法总会漏（漏了就把 `周杰伦 feat. 费玉清` 当成一个
 * token，跟 `周杰伦` 对不上——保守方向，但会少命中）。
 */
export function singerTokens(input: string): string[] {
  const tokens: string[] = [];
  const src = input.toLowerCase();
  let cur = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (isMatchChar(src.charCodeAt(i))) {
      cur += ch;
      continue;
    }
    if (cur.length > 0) tokens.push(cur);
    cur = "";
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

/**
 * 歌手相交判定：任一 token 相同即过（对齐 qt-pc `local_first::singers_overlap`）。
 *
 * 两侧都拆不出 token（纯音乐 / 标签缺歌手）时**视为通过**——标题 + 时长
 * 两道护栏还在，不靠歌手兜底就永远匹配不上纯音乐。只有一侧为空时判否
 * （空集合与任何集合都不相交）。
 */
export function singersOverlap(a: string, b: string): boolean {
  const ta = singerTokens(a);
  const tb = singerTokens(b);
  if (ta.length == 0 && tb.length == 0) return true;
  if (ta.length == 0 || tb.length == 0) return false;
  for (let i = 0; i < ta.length; i++) {
    for (let j = 0; j < tb.length; j++) {
      if (ta[i] == tb[j]) return true;
    }
  }
  return false;
}

/** 时长护栏：任一侧未知（≤0）放行，双侧已知差值 ≤3s 才算同一首（qt-pc 口径） */
export function durationClose(a: number | null, b: number | null): boolean {
  const av = a != null && a > 0 ? a : 0;
  const bv = b != null && b > 0 ? b : 0;
  if (av <= 0 || bv <= 0) return true;
  return Math.abs(av - bv) <= DURATION_GUARD_S;
}

/** K2 元数据级匹配（标题全等 + 歌手相交 + 时长护栏），三关都过才算命中 */
export function metaMatches(
  wantTitle: string,
  wantSinger: string,
  wantDuration: number | null,
  title: string,
  singer: string,
  duration: number | null
): boolean {
  if (normalizeForMatch(wantTitle) != normalizeForMatch(title)) return false;
  if (!singersOverlap(wantSinger, singer)) return false;
  return durationClose(wantDuration, duration);
}

/**
 * K2 元数据级匹配（**两种读法都算**）：文件名里的「歌手 - 歌名」和
 * 「歌名 - 歌手」从字符串本身判断不出来——`晴天 - 周杰伦.mp3` 与
 * `周杰伦 - 晴天.mp3` 是同一种形状。所以本地条目的 标题/歌手 按两种顺序
 * 各试一次，任一通过即命中；在线一方的标题/歌手来自接口，是权威的，不交换。
 *
 * 为什么不在解析时二选一：猜错方向就会「PC 命中、安卓不命中」，而且两种
 * 写法的存量文件都真实存在，宁可两种都认（标题全等 + 歌手相交 + 时长
 * 三道护栏在，认错的方向几乎不可能同时满足）。
 */
export function metaMatchesEither(
  wantTitle: string,
  wantSinger: string,
  wantDuration: number | null,
  title: string,
  singer: string,
  duration: number | null
): boolean {
  if (metaMatches(wantTitle, wantSinger, wantDuration, title, singer, duration)) return true;
  // 交换本地条目的标题与歌手：等价于把「歌名 - 歌手」读成「歌手 - 歌名」
  return metaMatches(wantTitle, wantSinger, wantDuration, singer, title, duration);
}

/** 文件在不在（异步：公共目录同步 stat 会卡 IO，见 downloads.ts fileSizeOf 注释） */
function fileExists(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (filePath == null || filePath.length == 0) {
      resolve(false);
      return;
    }
    uni.getFileSystemManager().getFileInfo({
      filePath,
      success: (_res) => resolve(true),
      fail: () => resolve(false),
    });
  });
}

/** 本地曲库扫描存档（qt-local-audio-v1，与 playReportSongs 同源同口径解析） */
function readLocalAudioItems(): LocalAudioItem[] {
  try {
    const raw = uni.getStorageSync(LOCAL_AUDIO_KEY);
    const items = raw as LocalAudioItem[];
    if (Array.isArray(items)) return items;
  } catch (_) {
    // 静默：存档损坏时按「本地曲库为空」处理，只影响命中机会不影响播放
  }
  return [];
}

/** LocalAudioItem → 播放用歌曲（pages/local/index.uvue toSong 同口径：content:// 直接播） */
function localItemToSong(item: LocalAudioItem): Song {
  return {
    id: item.id,
    name: item.title,
    singer: item.singer,
    album: item.album,
    picUrl: "",
    platform: "local",
    duration: item.duration,
    url: item.uri,
  } as Song;
}

/**
 * 在线歌解析链：给懒解析桥用。命中返回本地文件路径（下载成品绝对路径，
 * 或本地曲库 content:// URI），查不到返回 null 走原在线取链。
 * 全本地查询（+下载成品一次异步 stat），无网络。
 */
export async function localFileFor(song: Song): Promise<string | null> {
  if (!localFirstEnabled()) return null;
  // ① 下载账本：身份级（platform:id 精确命中，任务列表删了它也还在账上）
  const dl = useDownloadsStore().find(song);
  if (dl != null && dl.path != null && dl.path.length > 0 && await fileExists(dl.path)) {
    logMsg("[LocalFirst] 下载账本命中: " + song.platform + ":" + song.id + " -> " + dl.path);
    return dl.path;
  }
  // ⑤ 本地曲库：元数据级（K2 三关）。content:// 不做存在性预检（见文件头注释）
  const items = readLocalAudioItems();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item == null || item.uri == null || item.uri.length == 0) continue;
    if (metaMatchesEither(song.name, song.singer, song.duration, item.title, item.singer, item.duration)) {
      logMsg("[LocalFirst] 本地曲库命中: " + song.platform + ":" + song.id + " -> " + item.uri);
      return item.uri;
    }
  }
  return null;
}

/**
 * 本地歌替身链：本地歌文件不在了，找一首能顶上的（返回可直接 play 的 Song）。
 * A 本地曲库同元数据的另一条（排除自己——自己的扫描存档大概率一起过期了）
 *   → B 下载账本同曲文件（元数据级 + 文件在盘）
 *   → C 在线搜索（前 5 条里时长最接近的，护栏 ≤5s，都不接近取第 1 条兜底）。
 * 查不到 / 开关关 / 不是本地歌 → null（调用方走原失败路径）。
 */
export async function findSubstituteSong(song: Song): Promise<Song | null> {
  if (song.platform != "local") return null;
  if (!localFirstEnabled()) return null;
  // A 本地曲库
  const items = readLocalAudioItems();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item == null || item.id == song.id) continue;
    if (item.uri == null || item.uri.length == 0) continue;
    if (metaMatchesEither(song.name, song.singer, song.duration, item.title, item.singer, item.duration)) {
      logMsg("[LocalFirst] 替身链A·本地曲库: " + song.id + " -> local:" + item.id);
      return localItemToSong(item);
    }
  }
  // B 下载账本：命中后返回「在线身份 + 空 url」——走播放器在线分支时，
  // 本地优先解析链的身份级命中会把它接回这个文件，不会真的取链
  const dls = useDownloadsStore().items;
  for (let i = 0; i < dls.length; i++) {
    const item = dls[i];
    if (item.path == null || item.path.length == 0) continue;
    if (!metaMatches(song.name, song.singer, song.duration, item.song.name, item.song.singer, item.song.duration)) {
      continue;
    }
    if (await fileExists(item.path)) {
      logMsg("[LocalFirst] 替身链B·下载账本: " + song.id + " -> " + item.song.platform + ":" + item.song.id);
      return asFreshOnlineSong(item.song);
    }
  }
  // C 在线搜索
  try {
    const keyword = song.name + " " + song.singer;
    const res = await musicApi.searchMerged(keyword, 0, 8, null, "");
    const songs = res.songs;
    if (songs.length == 0) return null;
    let best: Song | null = null;
    let bestDiff = -1;
    const wantDur = song.duration != null ? song.duration : 0;
    for (let i = 0; i < songs.length && i < SEARCH_PICK_LIMIT; i++) {
      const cand = songs[i];
      const candDur = cand.duration != null ? cand.duration : 0;
      if (candDur <= 0) continue;
      const diff = Math.abs(candDur - wantDur);
      if (best == null || diff < bestDiff) {
        best = cand;
        bestDiff = diff;
      }
    }
    // 都不接近（或全都没有时长）取第 1 条兜底——qt-pc 口径：复核会把
    // 「现场版/重录版」这类真实存在的替身也拒掉
    if (best == null || (wantDur > 0 && bestDiff > SEARCH_GUARD_S)) {
      best = songs[0];
    }
    logMsg("[LocalFirst] 替身链C·在线搜索: " + song.id + " -> " + best.platform + ":" + best.id);
    return asFreshOnlineSong(best);
  } catch (_) {
    // 搜索失败（无网/引擎不可用）：没替身，调用方走原失败路径
    return null;
  }
}

/** 只留身份与展示元数据，url 清空交给懒解析（避免带着过期地址起播） */
function asFreshOnlineSong(src: Song): Song {
  return {
    id: src.id,
    name: src.name,
    singer: src.singer,
    album: src.album,
    picUrl: src.picUrl,
    platform: src.platform,
    duration: src.duration,
    musicId: src.musicId,
    url: "",
  } as Song;
}
