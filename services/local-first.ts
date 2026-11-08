/**
 * 全入口本地优先：显式文件 → 下载身份 → 本地曲库身份 → 元数据匹配。
 * 候选必须可读取；匹配保留歌名/歌手/时长护栏。缺失或已失败文件才回落在线。
 * LocalAudioLookup 每轮时间线共用索引与 stat 结果，不逐曲重读存储。
 * 不改变在线歌曲身份或收藏归属；旧版本关闭开关不再绕过本地资源。
 */
import { musicApi } from "@/services/music-api";
import { logMsg } from "@/services/logger";
import { useDownloadsStore } from "@/stores/downloads";
import type { Song } from "@/types/music";
import { statLocalFile } from "@/uni_modules/qt-app-native";
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
  // 所有入口统一本地优先；旧版保存的 false 不再让下载歌曲走在线。
  return true;
}

/** 开关写：设置页「本地优先播放」行用 */
export function setLocalFirst(on: boolean): void {
  try {
    uni.setStorageSync(LOCAL_FIRST_KEY, true);
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

/** 文件在不在（异步：公共目录同步 stat 会卡 IO，见 downloads.ts fileSizeOf 注释）
 *
 * uni.getFileSystemManager().getFileInfo 对安卓公共目录（MediaStore 落盘的下载
 * 成品）经常 fail——文件明明在盘上也报「不在盘」（2026-11-01 真机诊断弹窗复现，
 * /storage/emulated/0/Download/... stat 始终 false，本地优先整链被卡掉）。
 * 所以 fail 后再走原生 statLocalFile 兜底（java.io.File 直查，与
 * readEmbeddedTags 的 FileInputStream 直读同源，那条线实测能读到这些文件）。
 */
function fileExists(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (filePath == null || filePath.length == 0) {
      resolve(false);
      return;
    }
    uni.getFileSystemManager().getFileInfo({
      filePath,
      success: (_res) => resolve(true),
      fail: () => {
        // 静默：uni stat 公共目录经常 fail，交给原生兜底判定，不在这里报错
        const nativeSize = statLocalFile(filePath);
        resolve(nativeSize >= 0);
      },
    });
  });
}

/**
 * 文件字节数（异步，读不到 0）：本地优先命中后给播放页算真实 kbps 用
 * （本地文件不走在线取链，urlSize 永远量不到，只能 stat 磁盘文件）。
 * uni stat 失败时同样走原生 statLocalFile 兜底（同 fileExists 的公共目录问题）。
 */
export function localFileSizeOf(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    if (filePath == null || filePath.length == 0) {
      resolve(0);
      return;
    }
    uni.getFileSystemManager().getFileInfo({
      filePath,
      success: (res) => {
        const size = res.size;
        resolve(size != null && size > 0 ? size : 0);
      },
      fail: () => {
        // 静默：uni stat 失败不代表文件不在盘，原生兜底读真实字节数
        const nativeSize = statLocalFile(filePath);
        resolve(nativeSize > 0 ? nativeSize : 0);
      },
    });
  });
}

/** 本地曲库扫描存档（qt-local-audio-v1，与 playReportSongs 同源同口径解析） */
export function readLocalAudioItems(): LocalAudioItem[] {
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
export async function localFileFor(song: Song, rejectedPath = ""): Promise<string | null> {
  const explicit = song.url ?? "";
  if (explicit != rejectedPath && isLocalAudioPath(explicit)) {
    try { if (localAudioReadable(explicit)) return explicit; } catch (_) {
      // 静默：失效路径继续查询下载记录与曲库。
    }
  }
  return new LocalAudioLookup().find(song, rejectedPath);
}

/** 只接受本机资源，不能把过期 HTTP 地址当成本地文件。 */
export function isLocalAudioPath(path: string | null | undefined): boolean {
  if (path == null || path.length == 0) return false;
  const lower = path.toLowerCase();
  return path.indexOf("/") == 0 || lower.indexOf("content://") == 0 || lower.indexOf("file://") == 0 || lower.indexOf("unifile://") == 0;
}

export function localAudioReadable(path: string): boolean {
  if (!isLocalAudioPath(path)) return false;
  if (statLocalFile(path) >= 0) return true;
  // iOS/Web 与私有 unifile 路径由 uni 文件系统兜底，不能因原生空实现漏掉本地文件。
  try {
    const stats = uni.getFileSystemManager().statSync(path, false);
    return stats != null && stats.length == 1 && stats[0].stats.isFile();
  } catch (_) { return false; }
}

/** 一次时间线共用候选索引和 stat 结果，避免逐曲重读曲库、重复磁盘检查。 */
export class LocalAudioLookup {
  private exact = new Map<string, string[]>();
  private candidates = new Map<string, Song[]>();
  private available = new Map<string, boolean>();

  constructor() {
    const downloads = useDownloadsStore().items;
    for (let i = 0; i < downloads.length; i++) {
      const item = downloads[i];
      if (item == null || !isLocalAudioPath(item.path)) continue;
      this.add(item.song, item.path);
    }
    const local = readLocalAudioItems();
    for (let i = 0; i < local.length; i++) {
      const item = local[i];
      if (item == null || !isLocalAudioPath(item.uri)) continue;
      this.add(localItemToSong(item), item.uri);
    }
  }

  private add(song: Song, path: string): void {
    const key = song.platform + ":" + song.id;
    const paths = this.exact.get(key) ?? [];
    paths.push(path);
    this.exact.set(key, paths);
    const candidate = { ...song, url: path } as Song;
    const title = normalizeForMatch(song.name);
    const rows = this.candidates.get(title) ?? [];
    rows.push(candidate);
    this.candidates.set(title, rows);
    // 扫描文件名可能把歌名与歌手读反；仍需完整元数据护栏才能命中。
    if (song.platform == "local") {
      const reversed = normalizeForMatch(song.singer);
      if (reversed != title && reversed.length > 0) {
        const swapped = this.candidates.get(reversed) ?? [];
        swapped.push(candidate);
        this.candidates.set(reversed, swapped);
      }
    }
  }

  private usable(path: string, rejected: string): boolean {
    if (path == rejected || !isLocalAudioPath(path)) return false;
    const cached = this.available.get(path);
    if (cached != null) return cached;
    let valid = false;
    try { valid = localAudioReadable(path); } catch (_) {
      // 静默：文件或 URI 权限失效，继续查下一候选。
    }
    this.available.set(path, valid);
    return valid;
  }

  find(song: Song, rejectedPath = ""): string | null {
    const explicit = song.url ?? "";
    if (this.usable(explicit, rejectedPath)) return explicit;
    const paths = this.exact.get(song.platform + ":" + song.id) ?? [];
    for (let i = 0; i < paths.length; i++) if (this.usable(paths[i], rejectedPath)) return paths[i];
    const title = normalizeForMatch(song.name);
    if (title.length == 0) return null;
    const rows = this.candidates.get(title) ?? [];
    for (let i = 0; i < rows.length; i++) {
      const candidate = rows[i];
      const matches = candidate.platform == "local"
        ? metaMatchesEither(song.name, song.singer, song.duration, candidate.name, candidate.singer, candidate.duration)
        : metaMatches(song.name, song.singer, song.duration, candidate.name, candidate.singer, candidate.duration);
      if (!matches) continue;
      const path = candidate.url ?? "";
      if (this.usable(path, rejectedPath)) return path;
    }
    return null;
  }
}

/**
 * 本地优先诊断（管理端「当前播放地址」弹窗用，纯读、不改变任何行为）：
 * 把 localFileFor 的三段链对这首歌逐段复跑一遍，把「为什么没走本地」讲清楚。
 * 用户侧「下载了还是在线」不再靠猜——弹窗里直接看是 ①身份没记录、
 * ②元数据三关差哪关、⑤曲库有没有，还是文件不在盘。
 */
export async function localFirstDiagnose(song: Song): Promise<string> {
  const store = useDownloadsStore();
  const dls = store.items;
  if (!localFirstEnabled()) {
    return "本地优先: 关（下载账本 " + dls.length + " 条）";
  }
  let report = "本地优先: 开 · 下载账本 " + dls.length + " 条";
  // ① 身份级（与 localFileFor 同口径：find 精确 + 路径非空 + 文件在盘）
  const dl = store.find(song);
  if (dl == null) {
    report += "\n①身份: 无记录（" + song.platform + ":" + song.id + "）";
  } else if (dl.path == null || dl.path.length == 0) {
    report += "\n①身份: 有记录·无路径";
  } else {
    report += "\n①身份: 有记录" + ((await fileExists(dl.path)) ? "·文件在盘" : "·文件不在盘") + " " + dl.path;
  }
  // ② 元数据级跨源：逐条评三关，报告过关最多的候选与它挂在哪一关
  let bestGates = -1;
  let bestReason = "";
  for (let i = 0; i < dls.length; i++) {
    const item = dls[i];
    if (item == null) continue;
    const r = item.song;
    // 与 localFileFor 同口径：①已按身份试过的同一条不重复评
    if (r.platform == song.platform && r.id == song.id) continue;
    let gates = 0;
    let reason = "";
    if (normalizeForMatch(r.name) == normalizeForMatch(song.name)) gates++;
    else reason += "标题「" + song.name + "」vs「" + r.name + "」";
    if (singersOverlap(song.singer, r.singer)) gates++;
    else reason += (reason.length > 0 ? " " : "") + "歌手「" + song.singer + "」vs「" + r.singer + "」";
    if (durationClose(song.duration, r.duration)) gates++;
    else reason += (reason.length > 0 ? " " : "") + "时长" + (song.duration != null ? song.duration : 0) + "s vs " + (r.duration != null ? r.duration : 0) + "s";
    if (gates == 3) {
      if (item.path == null || item.path.length == 0) {
        report += "\n②元数据: 全匹配 " + r.platform + ":" + r.id + "·无路径";
      } else {
        report += "\n②元数据: 全匹配 " + r.platform + ":" + r.id + ((await fileExists(item.path)) ? "·文件在盘" : "·文件不在盘") + " " + item.path;
      }
      bestGates = 3;
      break;
    }
    if (gates > bestGates) {
      bestGates = gates;
      bestReason = r.platform + ":" + r.id + " 过" + gates + "/3关（" + reason + "）";
    }
  }
  if (bestGates < 3) {
    report += "\n②元数据: " + (bestGates >= 0 ? "无全匹配·最近 " + bestReason : "无候选");
  }
  // ⑤ 本地曲库（存档元数据级，content:// 不做存在性预检）
  const items = readLocalAudioItems();
  let libUri = "";
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item == null || item.uri == null || item.uri.length == 0) continue;
    if (metaMatchesEither(song.name, song.singer, song.duration, item.title, item.singer, item.duration)) {
      libUri = item.uri;
      break;
    }
  }
  report += "\n⑤曲库: " + (libUri.length > 0 ? "命中 " + libUri : "无匹配（存档 " + items.length + " 条）");
  return report;
}

/**
 * 本地歌替身链：本地歌文件不在了，找一首能顶上的（返回可直接 play 的 Song）。
 * A 本地曲库同元数据的另一条（排除自己——自己的扫描存档大概率一起过期了）
 *   → B 下载账本同曲文件（元数据级 + 文件在盘）
 *   → C 在线搜索（前 5 条里时长最接近的，护栏 ≤5s，都不接近取第 1 条兜底）。
 * 查不到 / 开关关 / 不是本地歌 → null（调用方走原失败路径）。
 */
export async function findSubstituteSong(song: Song, rejectedPath = ""): Promise<Song | null> {
  if (song.platform != "local") return null;
  const local = new LocalAudioLookup().find(song, rejectedPath);
  if (local != null) return { ...song, url: local } as Song;
  // A 本地曲库
  const items = readLocalAudioItems();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item == null || item.id == song.id) continue;
    if (item.uri == null || item.uri.length == 0 || item.uri == rejectedPath || !(await fileExists(item.uri))) continue;
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
    if (item.path == null || item.path.length == 0 || item.path == rejectedPath) continue;
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
