/**
 * 音源数据接口（安卓端）。
 *
 * 2026-09-19 起所有音源数据（搜索/歌单/专辑/歌手/榜单/歌词/封面/热词）全部
 * 从音源包（source-bundle.js，安卓侧跑在 WebView 的 V8 里）取，本文件不再保留任何平台 HTTP 实现——解析与模型
 * 映射在这里做，网络与平台逻辑都在 bundle（qt-pc/src/source-scripts，与 PC 同源）。
 * 换源修复只发新音源包，不再发版 APP。
 *
 * 仍走本端网关的只有账号/收藏/签到/公告/升级等后端接口（AccountApi / banners），
 * 以及纯本地逻辑（播放地址缓存、歌单分享链接解析）。
 */
import { apiRequest, parseJsonToUtso, resolveUrl } from "./http";
import { getPlayUrlByEngineResult, invokeSource } from "./source-engine";
import type { PlayUrlLine } from "./source-engine";
import { activeMetaPack, ensureLocalStateRestored } from "./source-bundle-fs";
import { isLoggedIn } from "./auth";
import { qtDiag } from "./diag";
import type { Playlist, Song, Artist, Album } from "@/types/music";

/**
 * 内容失败（音源没这首 / 未装播放包）的异常文案。弱网走另一句「网络较慢，正在重试」。
 *
 * 弱网修复（2026-10-03）的分流约定：player 的取链 catch 用 isContentFailError()
 * 判定 —— 内容失败 → stalled:false（坏歌，走重取/自动切歌路径），
 * 弱网/引擎异常 → stalled:true（环境问题，原地退避重试、不计熔断）。
 */
export const CONTENT_FAIL_MESSAGE = "该歌曲暂时无法播放";

/**
 * 该异常是否表示「内容失败」（而非弱网）。
 *
 * 判定随异常对象本身带回，**不能**用模块级标记 + 读后即清：取链在宿主侧是并发的
 * （播放页换音质重取、失败重取、熔断后的恢复探测、下载任务会同时进行），
 * 全局标记会被另一个调用方的结果串味 —— A 的弱网超时读到 B 置的内容失败标记，
 * 就被误判成坏歌并消耗熔断额度，连挂几首把自动切歌关死，正是用户反馈的
 * 「网络质量差一点就疯狂不可用」。异常自带性质则天然按调用隔离。
 */
export function isContentFailError(e: any): boolean {
  if (e == null) return false;
  // 先看 message 再看整体字符串化：异常经 UTS 边界传递时有的路径只留 message，
  // 有的 toString 会带类型前缀，两种都覆盖（写法与 services/upgrade.ts:103 一致）
  try {
    const message = (e as any).message as string;
    if (message != null && message.indexOf(CONTENT_FAIL_MESSAGE) >= 0) return true;
  } catch (_) {}
  return `${e}`.indexOf(CONTENT_FAIL_MESSAGE) >= 0;
}

/**
 * 播放地址缓存有效期（毫秒）。各平台返回的播放链接都带时效签名（QQ vkey、酷我 mobi、
 * 网易云代理链接等），过期后同一条 URL 会 403/404，导致「第二次播放同一首歌失败」。
 * 缓存与播放器（stores/player.ts）共用该阈值，超时即重新解析。
 */
export const PLAY_URL_TTL = 10 * 60 * 1000;
/**
 * 「已问过但结果为空」的歌词标记有效期。
 * bundle 内部会吞掉线路错误并返回空串，若把这个空结果永久记住，
 * 该首歌在当前进程里就再也取不到歌词（表现 = 进播放页不显示歌词）。
 */
export const LYRIC_EMPTY_TTL_MS = 60 * 1000;
/**
 * 「无词时搜索歌词」里用户手动选定的候选音源（KV，移动端无 SQLite）。
 *
 * 值是 JSON：{ "原歌 platform:id": 候选 Song }。
 * 存整个候选 Song 而不是只存 `platform:id`：酷我歌词入口要 musicId
 * （见 songArgsOf 的注释与包侧 fetchKwLyricText），只留一个 id 时下次
 * 回退到候选会取不到词。键名与 stores/lyric-offset.ts 的 `qt-lyric-offset`
 * 同一命名口径。
 */
const LYRIC_PICK_KEY = "qt-lyric-pick";


/** 是否为网络播放地址（本地下载文件不会过期，不参与失效判断） */
function isRemotePlayUrl(url: string | null): boolean {
  if (url == null || url.length == 0) return false;
  const lower = url.toLowerCase();
  return lower.indexOf("http://") == 0 || lower.indexOf("https://") == 0;
}

/**
 * 判断歌曲上已有的 url 是否需要重新获取：
 * 空地址、缺少取址时间（如从本地存储恢复的旧数据）或超过 PLAY_URL_TTL 都视为已过期。
 * 本地下载文件（file:// / 绝对路径）永久有效。
 */
export function isPlayUrlStale(song: Song): boolean {
  const url = song.url;
  if (url == null || url.length == 0) return true;
  if (!isRemotePlayUrl(url)) return false;
  const at = song.urlFetchedAt;
  if (at == null || at <= 0) return true;
  return Date.now() - at > PLAY_URL_TTL;
}

/**
 * 音源 id。清单不再内置：由数据包经 `__qtEntries.sourceRegistry()` 动态声明
 * （见 stores/source-registry.ts），新增/下线音源只发新数据包。这里保持 string
 * 别名是为了让存量代码继续以 Source 语义传递 id。
 */
export type Source = string;
/**
 * 数据包注册表里的一个音源（展示名沿用匿名口径，由包声明）。
 *
 * 后两个字段是包侧的**能力自述**（registry.ts 的 SourceCaps，v3 契约起下发），
 * 宿主不再写死「哪些源能翻页」「哪个源每页最多几条」「下载带哪个 Referer」：
 * - latestUsesOffset：latest() 的 offset 是否有分页语义（未声明按 false 处理）；
 * - searchPageMax：搜索/歌手类接口的每页条数上限（未声明按 50 兜底）；
 * - referer：音频 CDN 要求的来源头（未声明则不发该头，不冒充别的平台）。
 *
 * charts / playlists / artist / album / latest 是包侧的**功能面自述**（v4 契约
 * 起随 sourceRegistry 下发，见 source-registry.ts 的 supports()）：该源有没有
 * 排行榜/歌单载体/歌手页/专辑/新歌流，宿主据此显隐对应入口与源标签。
 * **未声明（旧版包没有这几项）一律按「支持」处理**——展示门控的保守方向与
 * 取链能力相反：错误地隐藏入口比多显示一个空区块伤害大得多。
 *
 * qualities / playlistSorts 是 v5 契约新增的自述：
 * - qualities：该源播放/下载可用的音质档位子集（如 B 站无真无损就不含
 *   flac）。未声明 = 全部档位（旧包行为不变）；
 * - playlistSorts：歌单广场的排序选项（空/未声明 = 不支持排序，不渲染选择器）。
 */
export type RegistrySource = {
  id: string;
  name: string;
  short: string;
  color: string;
  latestUsesOffset?: boolean;
  searchPageMax?: number;
  referer?: string;
  /** 功能面：该源有没有排行榜（v4 起下发；未声明 = 支持） */
  charts?: boolean;
  /** 功能面：该源有没有歌单载体（v4 起下发；未声明 = 支持） */
  playlists?: boolean;
  /** 功能面：该源有没有歌手页（v4 起下发；未声明 = 支持） */
  artist?: boolean;
  /** 功能面：该源有没有专辑（v4 起下发；未声明 = 支持） */
  album?: boolean;
  /** 功能面：该源有没有新歌流（v4 起下发；未声明 = 支持） */
  latest?: boolean;
  /** 播放/下载可用音质档位（v5 起下发；未声明 = 全部档位） */
  qualities?: string[];
  /** 歌单广场排序选项（v5 起下发；未声明 = 不支持排序） */
  playlistSorts?: RegistrySort[];
};
/** 数据包注册表里的歌单排序选项（v5 契约；id 原样透传给 recommendations） */
export type RegistrySort = { id: string; name: string };
/** 数据包注册表里的一个音质档位 */
export type RegistryQuality = { id: string; name: string };
/** 数据包注册表（音源清单 + 音质档位；宿主 UI 选项的唯一来源） */
export type SourceRegistry = { sources: RegistrySource[]; qualities: RegistryQuality[] };
/**
 * 搜索/歌手/专辑类接口的每页条数兜底上限。
 *
 * 包声明了 `searchPageMax` 就用包的值；未装包、旧版包没这一项时用 50。
 * 之所以不能随手放大：上游对超限的反馈各不相同（qq n≥100 返回 0 条、
 * kg pagesize 恒截成 30、wyy limit=200 返回 0 条），一旦页大小超过真实
 * 上限，分页会「首页有数据、后续页空」，列表误判到底。
 */
export const DEFAULT_SEARCH_PAGE_MAX = 50;
/**
 * 音质档位的高低序（数组序 = 高到低；与包侧 QUALITIES 的声明序一致）。
 * clampQualityFor 的「最接近一档」推断用它。
 */
const QUALITY_RANKS: string[] = ["flac", "320", "128"];
export type Banner = {
  id: string;
  picUrl: string;
  targetId: string;
  targetType: number;
  platform: Source;
};
export type Chart = {
  id: string;
  name: string;
  picUrl: string;
  platform: Source;
  description: string;
};

function sourceName(source: Source | null): Source {
  return source != null ? source : "wyy";
}

function gateway(
  path: string,
  data: UTSJSONObject = new UTSJSONObject(),
  method: "GET" | "POST" = "GET",
  auth = false
): Promise<any> {
  return apiRequest(path, data, method, auth) as Promise<any>;
}

export class MusicApi {
  // 播放地址与歌词的内存缓存，避免重复请求同一首歌
  private urlCache = new UTSJSONObject();
  /** 播放地址的取址时间（毫秒），配合 PLAY_URL_TTL 判断缓存是否过期 */
  private urlCacheAt = new Map<string, number>();
  /**
   * 每条播放地址是音源包里**哪条源**取到的（cacheKey 同 urlCache）。
   *
   * 与地址同生命周期：地址被缓存 10 分钟、被复用、被作废，这条记录跟着走，
   * 否则管理端「当前播放地址」只能显示最后一次取链的线路，命中缓存时就是错的。
   * 内存态即可——重启后 player 会重新取一次地址（恢复播放那条路径），届时重新记录。
   */
  private urlLine = new Map<string, string>();
  /**
   * 每条播放地址的**实测档位**（cacheKey 同 urlCache；空串 = 未测出/老包）。
   *
   * 这是「取链诚实性」（2026-10-06）在移动端的落点：请求 flac 但线路只给
   * 320k mp3 的情况真实存在，下载落盘名若照请求档写就是虚标（`.flac` 里装
   * mp3）。包侧按「实测字节 ÷ 时长」重标且只降不升，宿主只负责把它跟着
   * 地址一起记住 —— 地址会复用 10 分钟，档位必须跟着地址走，否则缓存命中
   * 时又退回请求档。
   */
  private urlActualQuality = new Map<string, string>();
  private lyricCache = new UTSJSONObject();
  /** 播放地址缓存的存活键 FIFO（容量上限见 URL_CACHE_CAP，写入序淘汰最旧） */
  private urlCacheKeys: string[] = [];
  /** urlCache 存活条目上限：与 dataCache 同量级，防长会话只增不清 */
  private static readonly URL_CACHE_CAP = 80;
  /**
   * 「这个 (platform,id) 的歌词入口已经问过了」的标记（不管结果有没有内容）。
   *
   * 必须单独记一份，原因有两层：
   * ① `lyricCache` 只在结果非空时写入，而 qq 国内歌的官方翻译（trans）绝大多数为空
   *    （见 qt-pc/src/source-scripts/platforms/qq.ts 的 lyricTranslation 注释），
   *    只靠 `lyricCache` 判断命中时，这类歌每次调用都会重新 invoke 一次歌词入口 ——
   *    真机表现就是「每次进播放页都重复请求一次 u.y.qq.com/cgi-bin/musicu.fcg」。
   * ② bundle 的 `lyric` 入口**一次就返回 lyric + translation**（内部发两条 HTTP），
   *    所以 `lyrics()` 与 `lyricTranslation()` 必须共用同一次 invoke（见 ensureLyric），
   *    `lyricAsked` 就是「这一次共用」的判据。
   * 注意只记「确实问过」，**取词异常不写**，避免把一次网络抖动记成「这首歌没歌词」。
   */
  private lyricAsked = new Map<string, number>();
  /**
   * 正在取词中的 (platform,id) → 该次调用的 Promise。
   *
   * 播放页与桌面歌词服务会在同一瞬间为同一首歌取词（真机日志实测：打开播放页时
   * `fcg_query_lyric_new`（len=1074）与 `musicu.fcg`（len=8327）各出现两次，相隔 180ms）。
   * 缓存与 `lyricAsked` 都要等 await 结束才写入，所以只靠它们挡不住「并发」这一路，
   * 必须再用一张「进行中」表让第二个调用方直接等第一个的结果。
   */
  private lyricInflight = new Map<string, Promise<void>>();
  /**
   * 最近一次成功取到的注册表音源清单（allLatest 逐源调用 / 每页上限查询用）。
   *
   * 与 stores/source-registry.ts 各存一份是有意的：store 面向 UI（响应式、可能被
   * 换包事件清空），这里面向数据调用（同一进程内缓存，失败不改写，避免瞬时空
   * 响应把正在跑的分页改成「零个源」）。取不到时为空数组，调用方自行兜底。
   */
  private registrySources: RegistrySource[] = [];
  /**
   * 清单是否已过期（音源包变更后由 clearPlayUrlCache 置位，成功重取后清位）。
   *
   * 只置位、不清空 registrySources：换包后引擎要重载，重取会有一段空窗，
   * 若那时把清单清成空数组，分页会当场退化成兜底值（每页 50、不发 Referer），
   * 而上游对超限请求返回 0 条，页面会把「取不到」误判成「没有更多」。
   * 保留旧值当兜底、同时记住「下次 ensureRegistry 必须真去重取」才是对的：
   * 此前没有这个标志，ensureRegistry 见数组非空就直接返回，换包后新包声明的
   * searchPageMax / referer / latestUsesOffset 要到进程重启才生效。
   */
  private registryStale = false;
  /** 进行中的注册表重取（并发 ensureRegistry 共享同一次请求） */
  private registryLoading: Promise<SourceRegistry | null> | null = null;

  // ==================== 数据列表缓存 ====================
  // 迁移到引擎直连后，列表数据由手机自己请求平台（迁移前走网关由服务器代取），
  // 移动网络下单请求就要 2-5s。给列表类结果加 60s 短缓存：音源来回切换、页面重进时秒开。
  private dataCache = new Map<string, any>();
  private dataCacheAt = new Map<string, number>();
  /** dataCache 容量上限：长会话刷列表不无限增长；超限时按写入顺序淘汰最旧条目 */
  private static readonly DATA_CACHE_CAP = 80;

  private dataGet(key: string): any | null {
    const at = this.dataCacheAt.get(key);
    if (at != null && Date.now() - at < 60000) {
      const v = this.dataCache.get(key);
      if (v != null) return v;
    }
    // 过期条目顺手清掉（TTL 已过、复用前先删，避免陈旧值长期占容量）
    if (at != null) {
      this.dataCache.delete(key);
      this.dataCacheAt.delete(key);
    }
    return null;
  }

  private dataSet(key: string, value: any): void {
    if (value == null) return;
    while (this.dataCache.size >= MusicApi.DATA_CACHE_CAP) {
      // Map 保持插入序，删除首个（最旧）条目
      const oldest = this.dataCache.keys().next();
      if (oldest.done) break;
      this.dataCache.delete(oldest.value);
      this.dataCacheAt.delete(oldest.value);
    }
    this.dataCache.set(key, value);
    this.dataCacheAt.set(key, Date.now());
  }

  private cacheGet(cache: UTSJSONObject, key: string): string {
    const value = cache.get(key);
    return value != null ? (value as string) : "";
  }

  private cacheSet(cache: UTSJSONObject, key: string, value: string): void {
    if (value.length > 0) cache.set(key, value);
  }

  /**
   * 作废单条歌词缓存（UTSJSONObject 无 delete，置空串等同未命中 —— 同 urlCacheRemove
   * 的做法，见本文件 :338 的注释；cacheGet 对空串返回 ""，消费端判的都是 length > 0）。
   *
   * 为什么歌词需要「能删」而其它缓存不需要：歌词是**四段一体的**（主词/译文/逐字/
   * 罗马音，分别落在 key、key:tr、key:wbw、key:roma）。cacheSet 只在非空时写入，
   * 所以换源取词时若新来源缺逐字或罗马音，旧来源留在同一批键上的值会原封不动保留，
   * 和新主词拼成一份「来源混合」的歌词 —— 播放页是逐字优先（wordByWord 非空就整篇
   * 按逐字渲染），表现就是整篇词都成了旧来源的文本（选了 A 显示 B）。
   *
   * 口径同 qt-pc `src-tauri/src/db/store/lyrics.rs` 的「空值照写」注释：宁可退化成
   * 无逐字染色，也不要让两个来源的时间轴叠在一起。
   */
  private lyricCacheRemove(key: string): void {
    this.lyricCache.set(key, "");
  }

  /** 读播放地址缓存：超过 PLAY_URL_TTL 视为未命中（链接带时效签名，过期会播放失败） */
  private urlCacheGet(key: string): string {
    const cached = this.cacheGet(this.urlCache, key);
    if (cached.length == 0) return "";
    const at = this.urlCacheAt.get(key);
    const ts = at != null ? at : 0;
    if (ts <= 0 || Date.now() - ts > PLAY_URL_TTL) {
      this.urlCacheRemove(key);
      return "";
    }
    return cached;
  }

  /** 写播放地址缓存并记录取址时间 */
  private urlCacheSet(key: string, value: string): void {
    if (value.length == 0) return;
    this.urlCache.set(key, value);
    this.urlCacheAt.set(key, Date.now());
    // 容量上限（与 dataCache 同口径）：长会话播过的每首歌每档音质都占一条，
    // 不设限就只增不清。urlCache（UTSJSONObject）删不掉条目，被淘汰的只是
    // 置空串墓碑（内存可忽略）；真正占内存的 urlCacheAt/urlLine 随淘汰清理
    const at = this.urlCacheKeys.indexOf(key);
    if (at >= 0) this.urlCacheKeys.splice(at, 1);
    this.urlCacheKeys.push(key);
    while (this.urlCacheKeys.length > MusicApi.URL_CACHE_CAP) {
      const oldest = this.urlCacheKeys.shift();
      if (oldest == null) break;
      this.urlCacheRemove(oldest);
    }
  }

  /** 作废单条播放地址缓存（UTSJSONObject 无 delete，置空串等同未命中） */
  private urlCacheRemove(key: string): void {
    this.urlCache.set(key, "");
    this.urlCacheAt.set(key, 0);
    this.urlLine.set(key, "");
    this.urlActualQuality.set(key, "");
    const at = this.urlCacheKeys.indexOf(key);
    if (at >= 0) this.urlCacheKeys.splice(at, 1);
  }

  /**
   * 清空全部播放地址缓存。音源包生效/回退后调用（方案 §2.4）：整条链路换了一套，
   * 旧地址在 10 分钟 TTL 内仍会被复用，会让人误以为新包没生效。
   *
   * 同时把注册表清单标记为过期：换包后新包声明的 searchPageMax / referer /
   * latestUsesOffset 可能与旧包不同，必须重取才生效（旧值先留着兜底，见 registryStale）。
   */
  clearPlayUrlCache(): void {
    this.urlCache = new UTSJSONObject();
    this.urlCacheAt = new Map<string, number>();
    this.urlLine = new Map<string, string>();
    this.urlActualQuality = new Map<string, string>();
    this.urlCacheKeys = [];
    // 列表短缓存一并清掉：未装数据包期间 engineInvoke 会给空应答，而 latest/
    // recommendations 等会把这份空列表 dataSet 进 60s 短缓存；不清的话用户装完包
    // 回到页面重拉，命中的仍是那份空值，表现成「装了包还是空的」。
    this.dataCache = new Map<string, any>();
    this.dataCacheAt = new Map<string, number>();
    this.registryStale = true;
  }

  /**
   * 主动作废某首歌的播放地址缓存。播放失败（链接已过期/被拒）时调用，
   * 使下一次 playUrl 重新向平台解析新链接，而不是复用坏 URL。
   */
  invalidatePlayUrl(song: Song, quality: string = "320"): void {
    const base = song.platform + ":" + song.id;
    this.urlCacheRemove(base + ":" + quality);
    this.urlCacheRemove(base + ":native:" + quality);
  }

  // ==================== 引擎调用与契约映射 ====================

  /**
   * 调 bundle 数据入口并解析应答。入参/出参都是 JSON 文本（引擎边界只走字符串），
   * 入口名与形状见 qt-pc/src/source-scripts/qt-entries.ts。网络失败/装载失败抛错。
   * 注意本文件是 .ts（编译后走原生 JSON.parse，产物无 .get），必须用 parseJsonToUtso
   * 把应答树重建为 UTSJSONObject；.uts 文件里的 JSON.parse 才会被编译成 UTS.JSON.parse。
   */
  private async engineInvoke(name: string, args: UTSJSONObject): Promise<UTSJSONObject> {
    // 未安装数据包时**根本不发请求**，直接给空应答。
    //
    // 为什么必须在这里挡：本方法是全部数据入口（搜索/歌单/榜单/歌手/歌词/封面）
    // 的唯一咽喉。数据包不内置，未装时 invokeSource 会抛「音源引擎未就绪：未安装
    // 数据包…」，各页面 catch 后无条件 showToast —— 启动时首页/榜单页自动挂载并
    // 拉数据，于是「什么都没装」反而先弹一个「加载失败」，用户看到的正是这个。
    // 抛错本身是引擎侧的设计（调用方要能区分），但调用方不该把「没装包」当成
    // 「加载失败」：没装就是没有数据面，空列表 + 各页既有空态 + 首页引导才是对的。
    //
    // 先 await 本地状态恢复再判定：恢复是异步的，页面 onMounted 完全可能赶在
    // 预热之前，此时 activeMetaPack() 还是 null —— 直接判定会把「已安装」误判成
    // 「未安装」，页面拿到空数据后又被指纹去重挡住不再重拉。ensureLocalStateRestored
    // 是进程内单飞，首次之后只是一个已兑现的 Promise，代价可忽略。
    //
    // 只在「确实没有生效中的数据包」时短路：数据包装了但引擎起不来（failure=engine）
    // 或包文件坏了（invalid）仍照常抛错，那种失败需要让用户看到。
    await ensureLocalStateRestored();
    if (activeMetaPack() == null) {
      return new UTSJSONObject();
    }
    const raw = await invokeSource(name, JSON.stringify([args]));
    return parseJsonToUtso(raw);
  }

  /**
   * 数据包注册表（音源清单 + 音质档位）。调用方：stores/source-registry.ts。
   * 未装数据包 / 旧版包（无 sourceRegistry 入口）/ 引擎未就绪 → null，
   * 调用方据此把音源列表置空并引导去设置页安装，本地音乐不受影响。
   */
  async sourceRegistry(): Promise<SourceRegistry | null> {
    try {
      const response = await this.engineInvoke("sourceRegistry", new UTSJSONObject());
      const rawSources = response.get("sources") as UTSJSONObject[] | null;
      const rawQualities = response.get("qualities") as UTSJSONObject[] | null;
      if (rawSources == null || rawQualities == null) return null;
      const sources: RegistrySource[] = [];
      for (let i = 0; i < rawSources.length; i++) {
        const item = rawSources[i];
        const src: RegistrySource = {
          id: this.strOf(item.get("id")),
          name: this.strOf(item.get("name")),
          short: this.strOf(item.get("short")),
          color: this.strOf(item.get("color")),
        };
        // 能力自述（v3 契约起下发）：旧包没有这几项，保持 undefined，
        // 调用方按「不翻页 / 每页 50 / 不发 Referer」兜底，不抛错也不静默改语义。
        const usesOffset = item.get("latestUsesOffset");
        if (usesOffset != null && usesOffset.toString() == "true") {
          src.latestUsesOffset = true;
        }
        const max = this.numOf(item.get("searchPageMax"));
        if (max > 0 && max <= 10000) src.searchPageMax = Math.floor(max);
        const referer = this.strOf(item.get("referer"));
        if (referer.length > 0) src.referer = referer;
        // 功能面自述（v4 契约起下发，嵌套对象 charts/playlists/artist/album/latest）：
        // 旧包没有 features 时五项保持 undefined，调用方按「支持」兜底（不隐藏入口）。
        const rawFeatures = item.get("features") as UTSJSONObject | null;
        if (rawFeatures != null) {
          const charts = rawFeatures.get("charts");
          if (charts != null) src.charts = charts.toString() == "true";
          const playlists = rawFeatures.get("playlists");
          if (playlists != null) src.playlists = playlists.toString() == "true";
          const artist = rawFeatures.get("artist");
          if (artist != null) src.artist = artist.toString() == "true";
          const album = rawFeatures.get("album");
          if (album != null) src.album = album.toString() == "true";
          const latest = rawFeatures.get("latest");
          if (latest != null) src.latest = latest.toString() == "true";
        }
        // 音质档位子集（v5 契约起下发，字符串数组按高到低）：旧包没有时保持
        // undefined，调用方按「全部档位」兜底（不隐藏选项）。
        const rawQualitiesOfSrc = item.get("qualities") as string[] | null;
        if (rawQualitiesOfSrc != null && rawQualitiesOfSrc.length > 0) {
          src.qualities = rawQualitiesOfSrc;
        }
        // 歌单排序选项（v5 契约，{id,name} 对象数组）：旧包没有/空数组时保持
        // undefined（= 不支持排序，不渲染选择器）。
        const rawSorts = item.get("playlistSorts") as UTSJSONObject[] | null;
        if (rawSorts != null) {
          const sorts: RegistrySort[] = [];
          for (let j = 0; j < rawSorts.length; j++) {
            const sortItem = rawSorts[j];
            const sortId = this.strOf(sortItem.get("id"));
            const sortName = this.strOf(sortItem.get("name"));
            if (sortId.length > 0) sorts.push({ id: sortId, name: sortName });
          }
          if (sorts.length > 0) src.playlistSorts = sorts;
        }
        sources.push(src);
      }
      const qualities: RegistryQuality[] = [];
      for (let i = 0; i < rawQualities.length; i++) {
        const item = rawQualities[i];
        qualities.push({ id: this.strOf(item.get("id")), name: this.strOf(item.get("name")) });
      }
      if (sources.length == 0) return null;
      // 只在成功时改写进程内缓存：失败/瞬态空响应不改写，正在跑的分页不会被改成零源
      this.registrySources = sources;
      // 重取成功才清脏位；失败（返回 null）保留脏位，下次 ensureRegistry 再试
      this.registryStale = false;
      return { sources, qualities };
    } catch (_) {
      return null;
    }
  }

  /**
   * 某音源每页条数上限（搜索/歌手/专辑类接口）。
   *
   * 数据包声明 `searchPageMax` 时用它，否则 `DEFAULT_SEARCH_PAGE_MAX`。
   * `local` 永远用兜底值——本地库没有上游翻页概念，不在注册表里。
   */
  searchPageMaxOf(source: Source): number {
    if (source == "local") return DEFAULT_SEARCH_PAGE_MAX;
    for (let i = 0; i < this.registrySources.length; i++) {
      const item = this.registrySources[i] as RegistrySource;
      if (item.id != source) continue;
      const max = item.searchPageMax;
      if (max != null && max > 0) return Math.floor(max);
      break;
    }
    return DEFAULT_SEARCH_PAGE_MAX;
  }

  /** 把请求页大小钳到该音源的真实上限（超限会让上游直接返回 0 条） */
  clampSearchPageSize(source: Source, size: number): number {
    const max = this.searchPageMaxOf(source);
    return size > max ? max : size;
  }

  /**
   * 该音源音频 CDN 要求的 Referer；数据包未声明时返回空串（调用方**不发该头**）。
   *
   * 下载落盘绕过数据面直接向 CDN 取字节，拿不到包侧 utils.ts 的 platformHeaders，
   * 原先只能在宿主编一张表、未知源兜底成网易云——那等于冒充别的平台。
   * 现在改成「包说了才带」：宁可少一个头，也不给新音源发别家的 Referer。
   */
  refererOf(source: Source): string {
    if (source == "local") return "";
    for (let i = 0; i < this.registrySources.length; i++) {
      const item = this.registrySources[i] as RegistrySource;
      if (item.id != source) continue;
      const referer = item.referer;
      if (referer != null && referer.length > 0) return referer;
      break;
    }
    return "";
  }

  /**
   * 该源播放/下载可用的音质档位（v5 契约；null = 未声明/不限 = 全部档位）。
   * `local` 不在注册表里，恒为不限。
   */
  supportedQualitiesOf(source: Source): string[] | null {
    if (source == "local") return null;
    for (let i = 0; i < this.registrySources.length; i++) {
      const item = this.registrySources[i] as RegistrySource;
      if (item.id != source) continue;
      if (item.qualities == null) return null;
      return item.qualities;
    }
    return null;
  }

  /**
   * 把期望音质钳到该源声明可用的档位（v5 契约）。不可用时取「最接近的一档」：
   * 先向下降（想要 flac 但该源只声明 320/128 → 320），降不到再取最接近的
   * 更高一档。未声明（旧包）原样返回，行为不变。
   *
   * 取链包侧线路另有逐级降档兜底，这里是让请求值一开始就在支持面内——
   * UI 展示的档位与实际请求一致，不再对不支持的档位发无效请求。
   */
  clampQualityFor(source: Source, wanted: string): string {
    const supported = this.supportedQualitiesOf(source);
    if (supported == null || supported.length == 0) return wanted;
    for (let i = 0; i < supported.length; i++) {
      if (supported[i] == wanted) return wanted;
    }
    const wantedRank = QUALITY_RANKS.indexOf(wanted);
    if (wantedRank < 0) return supported[0];
    // 向下降：可用档里取 ≤ 想要排名的最高一档
    let best = "";
    let bestRank = -1;
    for (let i = 0; i < supported.length; i++) {
      const rank = QUALITY_RANKS.indexOf(supported[i]);
      if (rank < 0) continue;
      if (rank <= wantedRank && rank > bestRank) {
        best = supported[i];
        bestRank = rank;
      }
    }
    if (bestRank >= 0) return best;
    // 想要的档位以下没有可用档 → 取最接近的更高一档
    let up = "";
    let upRank = QUALITY_RANKS.length;
    for (let i = 0; i < supported.length; i++) {
      const rank = QUALITY_RANKS.indexOf(supported[i]);
      if (rank < 0) continue;
      if (rank < upRank) {
        up = supported[i];
        upRank = rank;
      }
    }
    return up.length > 0 ? up : wanted;
  }

  private strOf(v: any): string {
    return v != null ? v.toString() : "";
  }

  private numOf(v: any): number {
    if (v == null) return 0;
    const n = parseFloat(v.toString());
    return isNaN(n) ? 0 : n;
  }

  /** 契约 MusicInfo 的 platform 不在条目里（单源调用按入参补） */
  private songFromContract(item: UTSJSONObject, platform: string): Song {
    const song: Song = {
      id: this.strOf(item.get("id")),
      name: this.strOf(item.get("name")),
      singer: this.strOf(item.get("singer")),
      album: this.strOf(item.get("album")),
      picUrl: this.strOf(item.get("picUrl")),
      platform,
      duration: this.numOf(item.get("interval")),
    };
    const musicId = item.get("musicId");
    if (musicId != null && (musicId as string).length > 0) song.musicId = musicId as string;
    return song;
  }

  /** {list: MusicInfo[]} → Song[]（单源入口通用） */
  private songsOf(response: UTSJSONObject, platform: string): Song[] {
    const raw = response.get("list") as UTSJSONObject[] | null;
    const songs: Song[] = [];
    if (raw == null) return songs;
    for (let i = 0; i < raw.length; i++) {
      songs.push(this.songFromContract(raw[i] as UTSJSONObject, platform));
    }
    return songs;
  }

  private playlistFromContract(item: UTSJSONObject, fallbackPlatform: string): Playlist {
    const description = item.get("description");
    const platform = this.strOf(item.get("platform"));
    return {
      id: this.strOf(item.get("id")),
      name: this.strOf(item.get("name")),
      picUrl: this.strOf(item.get("picUrl")),
      playCount: this.strOf(item.get("playCount")),
      platform: platform.length > 0 ? platform : fallbackPlatform,
      description: description != null ? this.strOf(description) : null,
    };
  }

  /** 歌单/专辑详情（ContractPlaylistDetail + tracks）→ Playlist */
  private playlistDetailFromContract(detail: UTSJSONObject, fallbackPlatform: string): Playlist {
    const playlist = this.playlistFromContract(detail, fallbackPlatform);
    const rawTracks = detail.get("tracks") as UTSJSONObject[] | null;
    const tracks: Song[] = [];
    if (rawTracks != null) {
      for (let i = 0; i < rawTracks.length; i++) {
        tracks.push(this.songFromContract(rawTracks[i] as UTSJSONObject, playlist.platform));
      }
    }
    playlist.tracks = tracks;
    return playlist;
  }

  private chartFromContract(item: UTSJSONObject): Chart {
    const desc = item.get("description");
    return {
      id: this.strOf(item.get("id")),
      name: this.strOf(item.get("name")),
      picUrl: this.strOf(item.get("picUrl")),
      platform: this.strOf(item.get("platform")) as Source,
      description: desc != null ? this.strOf(desc) : "",
    };
  }

  private artistFromContract(item: UTSJSONObject): Artist {
    return {
      id: this.strOf(item.get("id")),
      name: this.strOf(item.get("name")),
      picUrl: this.strOf(item.get("picUrl")),
      platform: this.strOf(item.get("platform")),
    };
  }

  private albumFromContract(item: UTSJSONObject): Album {
    return {
      id: this.strOf(item.get("id")),
      name: this.strOf(item.get("name")),
      artist: this.strOf(item.get("artist")),
      picUrl: this.strOf(item.get("picUrl")),
      platform: this.strOf(item.get("platform")),
    };
  }

  /** 歌词/封面入口入参里的歌曲（契约 QtSongArgs，kw 歌词需要 musicId） */
  private songArgsOf(song: Song): UTSJSONObject {
    const args = new UTSJSONObject();
    args.set("id", song.id);
    args.set("name", song.name);
    args.set("singer", song.singer);
    args.set("album", song.album);
    args.set("picUrl", song.picUrl);
    args.set("interval", song.duration != null ? song.duration : 0);
    if (song.musicId != null) args.set("musicId", song.musicId);
    return args;
  }

  // ==================== 歌单广场 ====================

  /**
   * 各平台自身的歌单分类。返回 { id, name, group } 列表，id 为该平台筛选歌单时使用的取值。
   */
  async playlistCategories(source: Source): Promise<UTSJSONObject[]> {
    const args = new UTSJSONObject();
    args.set("source", source);
    const response = await this.engineInvoke("playlistCategories", args);
    const raw = response.get("list") as UTSJSONObject[] | null;
    const categories: UTSJSONObject[] = [];
    if (raw == null) return categories;
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i] as UTSJSONObject;
      const category = new UTSJSONObject();
      category.set("id", this.strOf(item.get("id")));
      category.set("name", this.strOf(item.get("name")));
      const group = item.get("group");
      category.set("group", group != null ? this.strOf(group) : null);
      categories.push(category);
    }
    return categories;
  }

  /** 推荐歌单（category 为空时 bundle 取各平台默认分类；sort 为歌单广场排序——
   *  包侧 playlistSorts 声明的 id 原样透传，空串 = 各平台默认，v5 契约） */
  async recommendations(source: Source, category?: string, page?: number, sort?: string): Promise<Playlist[]> {
    const sortId = sort != null ? sort : "";
    const cacheKey = "rec:" + source + ":" + (category != null ? category : "") + ":" + (page != null ? page : 1) + ":" + sortId;
    const hit = this.dataGet(cacheKey);
    if (hit != null) return hit as Playlist[];
    const args = new UTSJSONObject();
    args.set("source", source);
    args.set("category", category != null && category.length > 0 ? category : null);
    args.set("page", page != null ? page : 1);
    args.set("sort", sortId.length > 0 ? sortId : null);
    const response = await this.engineInvoke("recommendations", args);
    const raw = response.get("list") as UTSJSONObject[] | null;
    const lists: Playlist[] = [];
    if (raw == null) return lists;
    for (let i = 0; i < raw.length; i++) {
      lists.push(this.playlistFromContract(raw[i] as UTSJSONObject, source));
    }
    this.dataSet(cacheKey, lists);
    return lists;
  }

  // ==================== 歌曲/榜单/热词 ====================

  async latest(source: Source, limit: number, offset: number): Promise<Song[]> {
    const cacheKey = "latest:" + source + ":" + limit + ":" + offset;
    const hit = this.dataGet(cacheKey);
    if (hit != null) return hit as Song[];
    const args = new UTSJSONObject();
    args.set("source", source);
    args.set("limit", limit);
    args.set("offset", offset);
    const response = await this.engineInvoke("latest", args);
    const songs = this.songsOf(response, source);
    this.dataSet(cacheKey, songs);
    return songs;
  }

  banners(): Promise<Banner[]> {
    return gateway("wyy/banner") as Promise<Banner[]>;
  }

  async charts(source?: Source): Promise<Chart[]> {
    const currentSource = sourceName(source);
    const cacheKey = "charts:" + currentSource;
    const hit = this.dataGet(cacheKey);
    if (hit != null) return hit as Chart[];
    const args = new UTSJSONObject();
    args.set("source", currentSource);
    const response = await this.engineInvoke("charts", args);
    const raw = response.get("list") as UTSJSONObject[] | null;
    const charts: Chart[] = [];
    if (raw == null) return charts;
    for (let i = 0; i < raw.length; i++) {
      charts.push(this.chartFromContract(raw[i] as UTSJSONObject));
    }
    this.dataSet(cacheKey, charts);
    return charts;
  }

  /** 四源榜单合并（单源失败 bundle 内跳过） */
  async allCharts(): Promise<Chart[]> {
    const response = await this.engineInvoke("allCharts", new UTSJSONObject());
    const raw = response.get("list") as UTSJSONObject[] | null;
    const charts: Chart[] = [];
    if (raw == null) return charts;
    for (let i = 0; i < raw.length; i++) {
      charts.push(this.chartFromContract(raw[i] as UTSJSONObject));
    }
    return charts;
  }

  /**
   * 全部在线音源的最新歌曲交错合并。
   *
   * 不用 bundle 的 allLatest 入口——它返回的 MusicInfo 不带 platform，合并后无法
   * 区分来源；这里保留逐源调用 + 交错逻辑。音源清单与「哪些源支持 offset 翻页」
   * 都来自数据包注册表（不再写死四源），顺序即注册表顺序，也是交错节奏。
   */
  async allLatest(limit: number, offset: number): Promise<Song[]> {
    const sources = await this.onlineRegistrySources();
    if (sources.length == 0) return [];
    const perSource = Math.ceil(limit / sources.length) + 1;
    const batches: Song[][] = [];
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i] as RegistrySource;
      // offset 是否透传由包自述（未声明 = 不支持翻页，恒取首页）
      const pageOffset = source.latestUsesOffset == true ? offset : 0;
      try {
        batches.push(await this.latest(source.id as Source, perSource, pageOffset));
      } catch (e) {
        console.error("[QT Latest] " + source.id, e);
        // 失败源保留空位，交错节奏不因个别源失败而错位
        batches.push([]);
      }
    }
    const all: Song[] = [];
    for (let index = 0; index < perSource && all.length < limit; index++) {
      for (let s = 0; s < batches.length; s++) {
        const batch = batches[s] as Song[];
        if (index < batch.length) all.push(batch[index] as Song);
        if (all.length >= limit) break;
      }
    }
    return all;
  }

  /**
   * 注册表里的在线音源（排除 local）。取不到注册表（未装包/引擎未就绪）返回空数组，
   * 调用方按「无在线源」处理，不再兜底成写死的四源。
   */
  private async onlineRegistrySources(): Promise<RegistrySource[]> {
    await this.ensureRegistry();
    return this.registrySources.filter((s) => s.id != "local");
  }

  /**
   * 确保注册表已就位（幂等、失败静默）。
   *
   * 页面在按能力自述算「每页几条」之前调它：否则首帧只能用兜底 50，
   * 若真实上限更低，上游会对超限请求返回 0 条，页面会把「取不到」
   * 误判成「没有更多」而停止翻页。
   *
   * 已取到但被换包标脏（registryStale）时**必须重取**：新包声明的能力自述
   * 可能与旧包不同，沿用旧值会让每页上限/Referer 用到进程重启为止。
   * 重取失败则继续用旧值（sourceRegistry 失败不改写缓存），脏位留到下次再试。
   */
  async ensureRegistry(): Promise<void> {
    if (this.registrySources.length > 0 && !this.registryStale) return;
    // 换包后多个页面会同时调进来：共享同一次重取，避免并发打引擎
    if (this.registryLoading != null) {
      await this.registryLoading;
      return;
    }
    const loading = this.sourceRegistry();
    this.registryLoading = loading;
    try {
      await loading;
    } finally {
      this.registryLoading = null;
    }
  }

  async hotWords(source?: Source): Promise<string[]> {
    const args = new UTSJSONObject();
    args.set("source", sourceName(source));
    const response = await this.engineInvoke("hotWords", args);
    return this.wordsOf(response);
  }

  /** 四源热词合并（封顶 30 条，bundle 内去重） */
  async allHotWords(): Promise<string[]> {
    const response = await this.engineInvoke("allHotWords", new UTSJSONObject());
    return this.wordsOf(response);
  }

  private wordsOf(response: UTSJSONObject): string[] {
    const raw = response.get("list") as string[] | null;
    const words: string[] = [];
    if (raw == null) return words;
    for (let i = 0; i < raw.length; i++) {
      const word = raw[i];
      if (word != null && (word as string).length > 0) words.push(word as string);
    }
    return words;
  }

  // ==================== 搜索 ====================

  /** 单源搜索歌曲（type 仅兼容旧签名，bundle 只实现 song 类型） */
  async search(
    keyword: string,
    source?: Source,
    type?: string,
    page?: number,
    size?: number
  ): Promise<Song[]> {
    const currentSource = sourceName(source);
    const args = new UTSJSONObject();
    args.set("source", currentSource);
    args.set("keyword", keyword);
    args.set("page", page != null ? page : 1);
    args.set("size", size != null ? size : 30);
    const response = await this.engineInvoke("search", args);
    return this.songsOf(response, currentSource);
  }

  /** 四源聚合搜索（batch 自带 source，单源失败跳过） */
  async allSearch(
    keyword: string,
    page: number,
    size: number
  ): Promise<Song[]> {
    const args = new UTSJSONObject();
    args.set("keyword", keyword);
    args.set("page", page);
    args.set("size", size);
    const response = await this.engineInvoke("searchAll", args);
    const batches = response.get("batches") as UTSJSONObject[] | null;
    const all: Song[] = [];
    if (batches == null) return all;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i] as UTSJSONObject;
      const platform = this.strOf(batch.get("source"));
      if (platform.length == 0) continue;
      const raw = batch.get("list") as UTSJSONObject[] | null;
      if (raw == null) continue;
      for (let c = 0; c < raw.length; c++) {
        all.push(this.songFromContract(raw[c] as UTSJSONObject, platform));
      }
    }
    return all;
  }

  async searchPlaylists(
    keyword: string,
    source?: Source,
    page?: number,
    size?: number
  ): Promise<Playlist[]> {
    const s = sourceName(source);
    const args = new UTSJSONObject();
    args.set("source", s);
    args.set("keyword", keyword);
    args.set("page", page != null ? page : 1);
    args.set("size", size != null ? size : 20);
    const response = await this.engineInvoke("searchPlaylists", args);
    const raw = response.get("list") as UTSJSONObject[] | null;
    const lists: Playlist[] = [];
    if (raw == null) return lists;
    for (let i = 0; i < raw.length; i++) {
      lists.push(this.playlistFromContract(raw[i] as UTSJSONObject, s));
    }
    return lists;
  }

  async searchArtists(
    keyword: string,
    source?: Source,
    page?: number,
    size?: number
  ): Promise<Artist[]> {
    const s = sourceName(source);
    const args = new UTSJSONObject();
    args.set("source", s);
    args.set("keyword", keyword);
    args.set("page", page != null ? page : 1);
    args.set("size", size != null ? size : 20);
    const response = await this.engineInvoke("searchArtists", args);
    const raw = response.get("list") as UTSJSONObject[] | null;
    const artists: Artist[] = [];
    if (raw == null) return artists;
    for (let i = 0; i < raw.length; i++) {
      artists.push(this.artistFromContract(raw[i] as UTSJSONObject));
    }
    return artists;
  }

  /**
   * 歌手歌曲（bundle 侧第一页附头像 picUrl，与旧实现语义一致）。
   * `artistId` 是歌手真实 id（2026-10-06 新增，可选）：给了 bundle 就走按 id 取作品，
   * 不给/取不到才退回歌手名搜索 —— 老调用方不传时行为完全不变。
   *
   * 2026-10-07：返回值新增 `hasMore`（本页之后是否还有）。走真 id 时它是平台模块
   * 算出的权威 isEnd —— 歌手作品是**过滤型**列表（按名搜一批再按 singer.mid 过滤），
   * 逐页条数天然不齐，宿主拿「本页条数 < 每页期望」去猜会在中途收尾（这正是
   * 「PC 768 首 / 移动 998 首」的成因）。包没给这个字段（旧包）时为 null，
   * 由调用方退回「本页非空 = 还有」。
   */
  async artistSongs(
    name: string,
    source: Source = "wyy",
    page: number = 1,
    size: number = 30,
    artistId: string = ""
  ): Promise<{ picUrl: string; songs: Song[]; hasMore: boolean | null }> {
    const s = sourceName(source);
    const args = new UTSJSONObject();
    args.set("source", s);
    args.set("name", name);
    args.set("page", page);
    args.set("size", size);
    if (artistId.length > 0) args.set("id", artistId);
    const response = await this.engineInvoke("artistSongs", args);
    // bundle 入口返回 {picUrl, songs: MusicInfo[]}——不是单源入口通用的 {list}，
    // 不能走 songsOf（键名不符会永远解析出空列表，歌手页只剩头像）
    const rawSongs = response.get("songs") as UTSJSONObject[] | null;
    const songs: Song[] = [];
    if (rawSongs != null) {
      for (let i = 0; i < rawSongs.length; i++) {
        songs.push(this.songFromContract(rawSongs[i] as UTSJSONObject, s));
      }
    }
    const hasMore = response.get("hasMore") as boolean | null;
    return { picUrl: this.strOf(response.get("picUrl")), songs, hasMore };
  }

  async searchAlbums(
    keyword: string,
    source?: Source,
    page?: number,
    size?: number
  ): Promise<Album[]> {
    const s = sourceName(source);
    const args = new UTSJSONObject();
    args.set("source", s);
    args.set("keyword", keyword);
    args.set("page", page != null ? page : 1);
    args.set("size", size != null ? size : 20);
    const response = await this.engineInvoke("searchAlbums", args);
    const raw = response.get("list") as UTSJSONObject[] | null;
    const albums: Album[] = [];
    if (raw == null) return albums;
    for (let i = 0; i < raw.length; i++) {
      albums.push(this.albumFromContract(raw[i] as UTSJSONObject));
    }
    return albums;
  }

  // ==================== 详情 ====================

  async albumDetail(id: string, source?: Source): Promise<Playlist> {
    const s = sourceName(source);
    const args = new UTSJSONObject();
    args.set("source", s);
    args.set("id", id);
    const response = await this.engineInvoke("albumDetail", args);
    const detail = response.get("detail") as UTSJSONObject | null;
    // 空应答有两种来源，必须分开说：未装数据包（engineInvoke 给了空对象，此时
    // 判成「专辑不存在」会把用户引到错误方向——换个专辑试还是打不开）与真的
    // 取不到该专辑。engineInvoke 已 await 过本地状态恢复，这里同步判定是准的。
    if (detail == null) throw new Error(this.detailMissingMessage("专辑"));
    return this.playlistDetailFromContract(detail, s);
  }

  /** 详情入口取不到数据时的文案：未装数据包给指路，其余保持原语义 */
  private detailMissingMessage(what: string): string {
    if (activeMetaPack() == null) {
      return `未安装数据包：在线${what}不可用，请在 设置 → 音源包管理 安装`;
    }
    return `${what}不存在`;
  }

  async chartDetail(chart: Chart): Promise<Song[]> {
    const s = chart.platform;
    const chartArg = new UTSJSONObject();
    chartArg.set("id", chart.id);
    chartArg.set("platform", chart.platform);
    chartArg.set("name", chart.name);
    chartArg.set("picUrl", chart.picUrl);
    chartArg.set("description", chart.description);
    const args = new UTSJSONObject();
    args.set("source", s);
    args.set("chart", chartArg);
    const response = await this.engineInvoke("chartDetail", args);
    return this.songsOf(response, s);
  }

  /**
   * 从用户输入解析出歌单平台和 id（**唯一对外入口**，异步）。
   *
   * 支持直接粘贴分享链接（按域名自动识别平台），也支持纯数字 id
   *（此时必须给 fallback 平台，否则无法判断归属）。返回 null 表示无法识别。
   *
   * 解析的权威实现已**下沉到音源包**（qt-sources/src/actions/sheet-import.ts，
   * 入口 `parseSheet`，包侧 27 入口起才有）：此前 PC 的 lib/playlist-link.ts 与本文件
   * 各写一份且已经漂移 —— 安卓这份缺 kg 原生 ID（collection_/gcid_）、缺显式 `?id=`
   * 提取、缺 kg `.html` 还原，且 `?chain=` 查询参数式酷狗短链会被 lastPathSegment
   * 误取路径词 `share` 当歌单 id。两端各修一份会继续漂移，因此统一由包侧实现。
   *
   * 本函数优先调包内 `parseSheet`，拿不到（老包 26 入口 / 引擎未就绪 / 调用失败 /
   * 超时）就地回退到本文件内联的 localParsePlaylistInput，保证老包环境下行为
   * **逐 case 与改前一致**。只解析、不发请求。
   *
   * **包明确返回 null 时不回退本地版**（与 PC 端 source-scripts/index.ts 的
   * parseSheetInput 同语义）：包是权威，它说「无法识别」就是无法识别；若再用本地
   * 旧逻辑覆盖，包侧刚修好的边界（如 `?chain=` 短链、kg 原生 ID）会被旧规则重新
   * 判成一个错误的 platform，反而比不回退更糟。只有「引擎不可用 / 入口不存在 /
   * 调用抛错 / 超时」这类**拿不到答案**的情况才回退本地版。
   */
  async parseSheetInput(
    text: string,
    fallback?: Source
  ): Promise<{ platform: Source; id: string } | null> {
    // 包入口是纯字符串解析，不该占满数据接口默认的 30s 超时：引擎没就绪时
    // 尽早回本地实现，避免用户点「解析」后干等（与 PC 端 3000ms 对齐）。
    try {
      const args = new UTSJSONObject();
      args.set("text", text);
      args.set("source", fallback != null ? fallback : "");
      const raw = await invokeSource("parseSheet", JSON.stringify([args]), 3000);
      // 入口应答是 JSON 文本：`null`（无法识别）或 `{platform,id}`
      const parsed = parseJsonToUtso(raw);
      if (parsed == null) return null; // 包明确说无法识别 → 不回退本地版
      const platform = this.strOf(parsed.get("platform"));
      const id = this.strOf(parsed.get("id"));
      if (platform.length > 0 && id.length > 0) {
        return { platform: platform, id: id };
      }
      // 形状不对（理论上不会）：按「无法识别」处理，同样不覆盖
      return null;
    } catch (_) {
      // 引擎未就绪 / 老包无此入口 / 调用超时 → 静默回退本地实现。
      // 解析失败绝不能让导入弹窗报错，这里绝不再往外抛。
    }
    return this.localParsePlaylistInput(text, fallback);
  }

  /**
   * `parseSheetInput` 的旧名入口，签名除「改为异步」外不变。
   *
   * 保留原因：pages/playlist-import/index.uvue:286-287 仍按名字调它，改名会让调用点
   * 静默拿到 Promise（`parsed == null` 判不住 → 拿 undefined 去拉歌单）。调用点应改为
   * `await musicApi.parseSheetInput(...)`，改完后本别名即可删。
   */
  async parsePlaylistInput(
    text: string,
    fallback?: Source
  ): Promise<{ platform: Source; id: string } | null> {
    return await this.parseSheetInput(text, fallback);
  }

  /**
   * **老包回退路径**：内联的旧解析实现，权威实现已下沉到音源包的 parseSheet 入口
   * （见上方 parseSheetInput）。只在「拿不到包的答案」时被调用，保持原样不动，
   * 以保证老包环境下解析结果逐 case 与下沉前一致。新逻辑请改包侧，不要在这里加。
   */
  localParsePlaylistInput(
    text: string,
    fallback?: Source
  ): { platform: Source; id: string } | null {
    if (text == null) return null;
    // 分享文案常是整段话（如「分享XX的歌单《名称》https://t1.kugou.com/xxx（@酷狗音乐）」），
    // 先抠出第一个 URL，再按 URL 解析
    const urlMatch = /https?:\/\/[^\s\u300A\u300B\uFF08\uFF09]+/.exec(text);
    const t = urlMatch != null && urlMatch.length > 0 ? urlMatch[0] : text.trim();
    if (t.length == 0) return null;
    const lower = t.toLowerCase();
    let platform: Source | null = null;
    if (
      lower.indexOf("music.163.com") >= 0 ||
      lower.indexOf("163cn.tv") >= 0 ||
      lower.indexOf("163.com") >= 0
    ) {
      platform = "wyy";
    } else if (
      lower.indexOf("y.qq.com") >= 0 ||
      lower.indexOf("c.y.qq.com") >= 0 ||
      lower.indexOf("qq.com") >= 0
    ) {
      platform = "qq";
    } else if (lower.indexOf("kugou.com") >= 0) {
      platform = "kg";
    } else if (
      lower.indexOf("kuwo.cn") >= 0 ||
      lower.indexOf("kuwo.com") >= 0
    ) {
      platform = "kw";
    }
    // 酷狗分享短链：t1.kugou.com/<code>，code 含字母、不是数字歌单 id，
    // 要交给 zlist/list?chain=<code> 解析，不能套「最长数字段」规则
    if (platform == "kg") {
      const seg = this.lastPathSegment(t);
      if (seg.length > 0 && /[a-zA-Z]/.test(seg)) {
        return { platform: "kg", id: seg };
      }
    }
    const id = this.extractLongestDigits(t);
    if (platform != null && id.length > 0) {
      return { platform: platform!, id };
    }
    // 纯数字 id 且整段就是数字：用 fallback 平台
    if (id.length > 0 && id == t && fallback != null) {
      return { platform: fallback, id };
    }
    return null;
  }

  /** 取 URL 最后一段路径（去掉协议/查询/锚点），如 https://t1.kugou.com/abc123 → abc123 */
  private lastPathSegment(text: string): string {
    let t = text.trim();
    const q = t.indexOf("?");
    if (q >= 0) t = t.substring(0, q);
    const h = t.indexOf("#");
    if (h >= 0) t = t.substring(0, h);
    while (t.length > 0 && t.charAt(t.length - 1) == "/") t = t.substring(0, t.length - 1);
    const lastSlash = t.lastIndexOf("/");
    if (lastSlash < 0 || lastSlash == t.length - 1) return "";
    // 只保留路径段开头连续的合法 token 字符（字母/数字/._-），
    // 分享文案里可能连着中文或标点（ defensive：tJnW20zxV3（@酷狗...）
    let seg = t.substring(lastSlash + 1);
    let end = seg.length;
    for (let i = 0; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      const ok =
        (c >= 48 && c <= 57) ||
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        c == 45 ||
        c == 46 ||
        c == 95;
      if (!ok) {
        end = i;
        break;
      }
    }
    seg = seg.substring(0, end);
    try {
      return decodeURIComponent(seg);
    } catch (_) {
      return seg;
    }
  }

  /** 从文本里提取最长的一段连续数字，作为歌单 id */
  private extractLongestDigits(text: string): string {
    let best = "";
    let cur = "";
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 48 && c <= 57) {
        cur += text.charAt(i);
      } else {
        if (cur.length > best.length) best = cur;
        cur = "";
      }
    }
    if (cur.length > best.length) best = cur;
    return best;
  }

  async playlist(id: string, source?: Source): Promise<Playlist> {
    const s = sourceName(source);
    const args = new UTSJSONObject();
    args.set("source", s);
    args.set("id", id);
    const response = await this.engineInvoke("playlistDetail", args);
    const detail = response.get("detail") as UTSJSONObject | null;
    if (detail == null) throw new Error(this.detailMissingMessage("歌单"));
    return this.playlistDetailFromContract(detail, s);
  }

  // ==================== 播放/歌词/封面地址 ====================

  /**
   * 获取可播放地址。命中内存缓存时直接返回（缓存有 PLAY_URL_TTL 时效），
   * 并把「该地址真正的取址时间」写回歌曲对象，供播放器判断 song.url 是否已过期。
   * 注意用缓存条目自身的时间戳而非当前时间，否则反复命中缓存会把有效期无限延长。
   */
  async playUrl(song: Song, quality: string = "320"): Promise<string> {
    const cacheKey = song.platform + ":" + song.id + ":" + quality;
    const resolved = await this.resolvePlayUrl(song, quality, cacheKey);
    const url = resolved.url;
    if (url.length > 0) {
      const at = this.urlCacheAt.get(cacheKey);
      const ts = at != null ? at : 0;
      song.urlFetchedAt = ts > 0 ? ts : Date.now();
      // 取到地址就把这首歌的歌词一起取好。默认「URL 哪个源就用哪个源的歌词」
      // （地址按 song.platform 取）；但跨源兜底命中时 URL 来自目标源（如 kw 救回
      // wyy 的歌），歌词必须跟随目标源重取，否则配的是原平台的词，很可能对不上。
      // 缓存键仍用原歌（播放页/桌面歌词读的都是原歌键）。
      // 目标歌随本次取链结果带回，不经全局字段：取链并发时全局字段会被别的调用清掉
      const crossTarget = resolved.crossTarget;
      if (crossTarget != null) {
        qtDiag(
          "[QT URL] 跨源命中 → 歌词跟随目标源 " + crossTarget.platform + ":" + crossTarget.id +
          " 重取（原歌 " + song.platform + ":" + song.id + "，缓存键不变）"
        );
        this.ensureCrossLyric(crossTarget, song).catch(() => {});
      } else {
        this.prefetchLyric(song);
      }
    }
    return url;
  }

  private async resolvePlayUrl(
    song: Song,
    quality: string,
    cacheKey: string
  ): Promise<{ url: string; crossTarget: Song | null }> {
    const cached = this.urlCacheGet(cacheKey);
    if (cached.length > 0) return { url: cached, crossTarget: null };
    // 取链只走音源引擎：仓库不内置任何音源包（数据包/播放包都由用户在设置页
    // 从链接或本地文件安装，已装包的更新走 manifest/自管探测）后启动预热装载；
    // 取不到（未安装/线路全灭/装载失败）就报错，不再回退 TS 原型链——两套实现难维护，
    // 且原型链会让「链路热更新失效」这类问题被旧实现掩盖（方案 §2.6）。
    // 失败性质、命中线路与跨源目标歌都随这次调用的返回值带回，不经全局标记：
    // 取链是并发的，全局标记会被别的调用串味（见 isContentFailError 的说明）。
    const result = await getPlayUrlByEngineResult(song, quality);
    if (result.url.length > 0) {
      this.urlCacheSet(cacheKey, result.url);
      // 实测档位与地址同生命周期（空串 = 未重标，保持原值不清空）
      if (result.actualQuality.length > 0) {
        this.urlActualQuality.set(cacheKey, result.actualQuality);
      }
      // 命中线路与地址一起记：管理端要看「这条地址是音源包里哪条源取到的」，
      // 而地址会被复用 10 分钟，线路必须跟着地址走
      const crossTarget = this.rememberUrlLine(cacheKey, result.line);
      return { url: result.url, crossTarget: crossTarget };
    }
    // 弱网（整链无响应）与「音源没这首」在此分流（2026-10-03 弱网修复）：
    // 弱网抛错（store 视作环境问题 → 原地重试、不计熔断），
    // 内容失败抛「该歌曲暂时无法播放」（store 视作坏歌 → 换下一首）。
    if (result.stalled) {
      throw new Error("网络较慢，正在重试");
    }
    throw new Error(CONTENT_FAIL_MESSAGE);
  }

  /**
   * 把本次取链回报的命中线路落进 urlLine（无回报 = 包内缓存命中/老包，保持原值），
   * 并返回跨源兜底命中的目标歌（如 kw 救回 wyy 的歌），供 playUrl 把歌词切到目标源。
   */
  private rememberUrlLine(cacheKey: string, line: PlayUrlLine | null): Song | null {
    if (line == null) return null;
    // 展示成「名称 · 机制 · 线路 id」（名称缺失时不留空档，只拼有的那几段）
    let text = line.id;
    if (line.kind.length > 0) text = line.kind + " · " + text;
    if (line.name.length > 0) text = line.name + " · " + text;
    this.urlLine.set(cacheKey, text);
    // 管理端弹窗只对 qt_admin 角色可见，排查期留一行日志：弹窗里那条文本就是它，
    // 非管理员账号（或没登录）也能从日志核对「这条地址走的是音源包里哪条源」
    qtDiag("[QT URL] 命中音源线路 " + text + "（" + cacheKey + "）");
    // 跨源兜底命中（如 kw 救回 wyy 的歌）：把目标歌交回调用方，由它跟着本次地址用
    return line.kind == "cross" && line.targetSong != null ? line.targetSong : null;
  }

  /**
   * 某首歌某个音质「最近一次取链命中的音源线路」展示文本（未知返回空串）。
   * 管理端「当前播放地址」用：显示这条地址是音源包里哪条源取到的。
   */
  playUrlLine(song: Song, quality: string = "320"): string {
    const v = this.urlLine.get(song.platform + ":" + song.id + ":" + quality);
    return v != null ? v : "";
  }

  /**
   * 某首歌某个音质「最近一次取链实测出的档位」（未知返回空串）。
   * 下载扩展名推断用：请求 flac 但实测只有 320k 时按真实档位落 .mp3，
   * 而不是把一个 mp3 存成 .flac（与地址同缓存同生命周期，见 urlActualQuality）。
   */
  actualQualityOf(song: Song, quality: string = "320"): string {
    const v = this.urlActualQuality.get(song.platform + ":" + song.id + ":" + quality);
    return v != null ? v : "";
  }

  /**
   * 取歌词。bundle 的 `lyric` 入口一次返回 {lyric, translation}，两个访问器共用
   * 同一次 invoke（见 ensureLyric），所以这里只读缓存。
   */
  async lyrics(song: Song): Promise<string> {
    await this.ensureLyric(song, false);
    const text = this.cacheGet(this.lyricCache, song.platform + ":" + song.id);
    qtDiag("[QT Lyric] lyrics() 返回 " + text.length + " 字符：" + song.name);
    return text;
  }

  /** 拿到空结果后的强制重取（桌面歌词服务用）：忽略「已问过」标记，重新 invoke 一次 */
  async retryLyrics(song: Song): Promise<string> {
    await this.ensureLyric(song, true);
    return this.cacheGet(this.lyricCache, song.platform + ":" + song.id);
  }

  /** 取翻译。与歌词共用同一次 invoke（见 ensureLyric），这里只读缓存。 */
  async lyricTranslation(song: Song): Promise<string> {
    await this.ensureLyric(song, false);
    return this.cacheGet(this.lyricCache, song.platform + ":" + song.id + ":tr");
  }

  /** 取逐字歌词（QRC 行内格式）。与歌词共用同一次 invoke，这里只读缓存；老包返回空串。 */
  async lyricWordByWord(song: Song): Promise<string> {
    await this.ensureLyric(song, false);
    return this.cacheGet(this.lyricCache, song.platform + ":" + song.id + ":wbw");
  }

  /** 取罗马音（普通 LRC）。与歌词共用同一次 invoke，这里只读缓存；中文歌/老包返回空串。 */
  async lyricRomanization(song: Song): Promise<string> {
    await this.ensureLyric(song, false);
    return this.cacheGet(this.lyricCache, song.platform + ":" + song.id + ":roma");
  }

  /**
   * 取址后顺手预热歌词（见 playUrl）。**不 await**：取链是播放的关键路径，
   * 不能被歌词那两次 HTTP 拖慢；失败静默——ensureLyric 内部已 catch，
   * 空结果由 LYRIC_EMPTY_TTL_MS 兜住，与播放页共用同一份缓存/并发去重/已问标记。
   */
  private prefetchLyric(song: Song): void {
    const key = song.platform + ":" + song.id;
    if (this.cacheGet(this.lyricCache, key).length > 0) return;
    this.ensureLyric(song, false).catch(() => {});
  }

  /**
   * 跨源兜底命中后的取词：按目标源歌（bundle 搜索匹配到的）取词，缓存键用原歌——
   * 播放页/桌面歌词都按原歌键读缓存。与 ensureLyric 同一套缓存/并发去重约定；
   * 不看「问过为空」标记（那是原平台取词的结果，不该拦跨源这次）。
   */
  private async ensureCrossLyric(targetSong: Song, original: Song): Promise<void> {
    const key = original.platform + ":" + original.id;
    const trKey = key + ":tr";
    if (this.cacheGet(this.lyricCache, key).length > 0) return;
    const running = this.lyricInflight.get(key);
    if (running != null) {
      await running;
      return;
    }
    const task = this.fetchLyricFor(targetSong, key, trKey);
    this.lyricInflight.set(key, task);
    try {
      await task;
    } finally {
      this.lyricInflight.delete(key);
    }
  }

  /**
   * 同步读已缓存的歌词（不触发请求）。播放页用它做「命中缓存就同步落地」，
   * 让首次打开播放页直接出词，而不是先空一拍再补上。
   */
  cachedLyric(song: Song): string {
    return this.cacheGet(this.lyricCache, song.platform + ":" + song.id);
  }

  /** 同步读已缓存的翻译（与 cachedLyric 配套，同一次 invoke 写入） */
  cachedLyricTranslation(song: Song): string {
    return this.cacheGet(this.lyricCache, song.platform + ":" + song.id + ":tr");
  }

  /**
   * 同步读已缓存的逐字歌词（音源包 `wordByWord`，QRC 行内格式）。
   * 与 cachedLyric 同款：只在非空时写入，老包没有这个字段时恒为空串 → 走普通 LRC 路径。
   */
  cachedLyricWordByWord(song: Song): string {
    return this.cacheGet(this.lyricCache, song.platform + ":" + song.id + ":wbw");
  }

  /**
   * 同步读已缓存的罗马音（普通 LRC 文本）。中文歌恒为空串。
   */
  cachedLyricRomanization(song: Song): string {
    return this.cacheGet(this.lyricCache, song.platform + ":" + song.id + ":roma");
  }

  /**
   * 取一次歌词入口，把 lyric 与 translation 一起写进缓存。
   *
   * bundle 的 `lyric` 入口**一次返回两样**（内部发两条 HTTP：官方歌词接口 + 翻译接口），
   * 所以歌词与翻译必须共用这一次调用——否则播放页每首歌都会把同样的两条 HTTP 发两遍。
   * 2026-09-23 真机日志实测到的就是这个：`c.y.qq.com/.../fcg_query_lyric_new.fcg`
   * 与 `u.y.qq.com/cgi-bin/musicu.fcg` 在同一秒内各出现两次，长度完全相同。
   *
   * `force` 为 true 时忽略「已问过」标记（供空结果重试），但仍然先看非空缓存。
   */
  private async ensureLyric(song: Song, force: boolean): Promise<void> {
    const key = song.platform + ":" + song.id;
    const trKey = key + ":tr";
    if (!force) {
      if (this.cacheGet(this.lyricCache, key).length > 0) return;
      // 「问过但为空」只挡一小段时间：bundle 内部会吞掉线路错误并返回空串，
      // 若永久记住，这首歌在当前进程里就再也取不到歌词（表现 = 歌词不出来）。
      const askedAt = this.lyricAsked.get(key);
      if (askedAt != null && Date.now() - askedAt! < LYRIC_EMPTY_TTL_MS) return;
    }
    // 并发去重：同一首歌已有一次取词在飞时，第二个调用方直接等它的结果，不再多发一次 invoke
    const running = this.lyricInflight.get(key);
    if (running != null) {
      await running;
      return;
    }
    // 「无词时搜索歌词」里用户手选的来源优先于原平台入口：命中就按选定来源取词。
    // 缓存键仍是原歌（播放页/桌面歌词都按原歌键读），所以消费方无需知道有手选这回事。
    // 没有手选时 picked == null，行为与改动前逐字一致。
    const picked = this.pickedLyricOf(song);
    const task = this.fetchLyricFor(picked != null ? picked : song, key, trKey);
    this.lyricInflight.set(key, task);
    try {
      await task;
    } finally {
      this.lyricInflight.delete(key);
    }
  }

  /** ensureLyric 的实际取词步骤（已被并发去重包住，同一时刻同一 key 只会有一份在跑） */
  private async fetchLyricFor(song: Song, key: string, trKey: string): Promise<void> {
    if (song.platform == "local") {
      // 本地歌曲没有平台 id：按旧实现顺序先酷我后网易云，关键词搜索命中后取歌词
      let text = await this.lyricByKeyword(song, "kw");
      if (text.length == 0) text = await this.lyricByKeyword(song, "wyy");
      if (text.length > 0) this.cacheSet(this.lyricCache, key, text);
      // 翻译：搜索网易云命中后用命中的平台 id 再取一次（官方 tlyric）
      let tr = "";
      try {
        const keyword =
          song.singer.length > 0 ? song.singer + " " + song.name : song.name;
        const hits = await this.search(keyword, "wyy", "song", 1, 1);
        if (hits.length > 0) {
          const hit = hits[0] as Song;
          const response = await this.engineInvoke("lyric", this.lyricArgs(hit));
          tr = this.strOf(response.get("translation"));
        }
      } catch (_) {}
      if (tr.length > 0) this.cacheSet(this.lyricCache, trKey, tr);
      this.lyricAsked.set(key, Date.now());
      return;
    }
    let lyric = "";
    let translation = "";
    // 新字段（音源包 2026-10 起）：逐字（QRC 行内格式）与罗马音（普通 LRC）。
    // 老包没有这两个字段 → strOf 返回空串 → 不写缓存 → 消费方走原来的普通 LRC 路径。
    let wordByWord = "";
    let romanization = "";
    let failed = false;
    let errText = "";
    try {
      const response = await this.engineInvoke("lyric", this.lyricArgs(song));
      lyric = this.strOf(response.get("lyric"));
      translation = this.strOf(response.get("translation"));
      wordByWord = this.strOf(response.get("wordByWord"));
      romanization = this.strOf(response.get("romanization"));
    } catch (e) {
      failed = true;
      errText = e != null ? e.toString() : "";
    }
    // 成功与失败都打：播放页/桌面歌词两处「歌词不出现、不跟随」的排查全靠这条
    qtDiag("[QT Lyric] 取词 " + key + " 歌词 " + lyric.length + " 字符 / 翻译 "
      + translation.length + " 字符 / 逐字 " + wordByWord.length + " 字符 / 罗马音 "
      + romanization.length + " 字符" + (failed ? " 异常：" + errText : ""));
    if (lyric.length > 0) this.cacheSet(this.lyricCache, key, lyric);
    if (translation.length > 0) this.cacheSet(this.lyricCache, trKey, translation);
    // 与歌词/翻译同口径：只在非空时写入（cacheSet 内部已判空），空串不占位
    if (wordByWord.length > 0) this.cacheSet(this.lyricCache, key + ":wbw", wordByWord);
    if (romanization.length > 0) this.cacheSet(this.lyricCache, key + ":roma", romanization);
    // 只有「确实问过且没抛异常」才记：一次网络抖动不能被记成「这首歌没歌词」
    if (!failed) this.lyricAsked.set(key, Date.now());
  }

  /** 歌词入口入参（source + song） */
  private lyricArgs(song: Song): UTSJSONObject {
    const args = new UTSJSONObject();
    args.set("source", song.platform);
    args.set("song", this.songArgsOf(song));
    return args;
  }

  /** 本地歌曲歌词：按「歌手 歌名」在某平台搜索首条命中，再走该平台歌词入口 */
  private async lyricByKeyword(song: Song, platform: Source): Promise<string> {
    const keyword =
      song.singer.length > 0 ? song.singer + " " + song.name : song.name;
    try {
      const hits = await this.search(keyword, platform, "song", 1, 1);
      if (hits.length == 0) return "";
      const hit = hits[0] as Song;
      const response = await this.engineInvoke("lyric", this.lyricArgs(hit));
      return this.strOf(response.get("lyric"));
    } catch (_) {
      return "";
    }
  }

  // ==================== 无词时「搜索歌词」 ====================

  /**
   * 按「歌名 歌手」列出可供取词的候选歌曲，供播放页在无词时让用户手选。
   *
   * 为什么不是新增一个「搜歌词」入口：包侧 `search` 入口**不读 type 参数**
   * （见 services/music-api.ts:860 的注释与 .tmp/live/source-bundle.js 的
   * `async search(args)`），bundle 里也没有任何「按关键词取词」的接口 ——
   * 取词只有 `lyric` 入口，且必须给一首具体的歌。所以候选只能是搜索结果，
   * 选中后再对那首候选走既有 `lyric` 入口（见 adoptLyricFor）。
   *
   * 用 allSearch（四源聚合，包侧 allSearchBatches 逐源 try/catch、单源失败跳过）
   * 而不是逐源 search：一次调用拿全，且与「换源」用的同一份能力，
   * 不新增任何包侧契约。
   *
   * 注意本方法在 services/music-api.ts 里**不能**复用 services/source-switch.ts 的
   * findSourceCandidates：那个文件反过来 import 了本文件的 musicApi，互相 import
   * 会成环。另外它按「排除当前平台 + 同名同歌手打分」过滤，口径是换源不是找词，
   * 这里要保留同平台的不同版本，所以自己按 platform:id 去重即可。
   */
  async searchLyricCandidates(song: Song, page: number = 1, size: number = 10): Promise<Song[]> {
    const out: Song[] = [];
    if (song == null) return out;
    // 与 lyricByKeyword 同一口径：有歌手就「歌手 歌名」，没有就只用歌名
    const keyword =
      song.singer.length > 0 ? song.singer + " " + song.name : song.name;
    if (keyword.trim().length == 0) return out;
    let all: Song[] = [];
    try {
      all = await this.allSearch(keyword, page, size);
    } catch (e) {
      qtDiag("[QT Lyric] 搜歌词候选异常：" + (e != null ? e.toString() : ""));
      return out;
    }
    // 按 platform:id 去重：同一首歌在四个源里会重复出现，不去重用户要在
    // 列表里反复看到同一行；同平台的不同版本（live/remix）id 不同，会各自保留
    const seen: string[] = [];
    for (let i = 0; i < all.length; i++) {
      const candidate = all[i];
      if (candidate == null) continue;
      if (candidate.id.length == 0) continue;
      const key = candidate.platform + ":" + candidate.id;
      if (seen.indexOf(key) >= 0) continue;
      seen.push(key);
      out.push(candidate);
    }
    qtDiag("[QT Lyric] 搜歌词候选「" + keyword + "」→ " + all.length + " 条去重后 " + out.length + " 条");
    return out;
  }

  /**
   * 把用户选定的候选歌曲的歌词接到原歌上。
   *
   * 缓存键**始终是原歌**（platform:id）：播放页、桌面歌词、prefetchLyric 读的
   * 都是原歌键，所以消费方完全不需要知道有「手选」这回事，切歌/重进页面照旧。
   * 写回的是整份四件套（词/译/逐字/罗马音），与自动取词走同一个 fetchLyricFor，
   * 保证两条路径落地的数据形状一致。
   *
   * 不复用 ensureLyric：它会先看「已问过」标记（lyricAsked），而无词场景下
   * 那个标记大概率刚写过，用户点完会看到「什么都没发生」。
   */
  async adoptLyricFor(original: Song, picked: Song): Promise<string> {
    if (original == null || picked == null) return "";
    const key = original.platform + ":" + original.id;
    const trKey = key + ":tr";
    // 先记选择再取词：即使这次取词失败（线路抖动），下次进来仍按用户选的源重试，
    // 不会退回原来那条「没词」的路
    this.rememberLyricPick(original, picked);
    qtDiag("[QT Lyric] 手选歌词来源：" + key + " → " + picked.platform + ":" + picked.id
      + "（" + picked.name + "）");
    // 换源取词前必须先把原来源的四段全清掉：cacheSet 只在非空时写入，若选中源缺
    // 逐字/罗马音/译文，旧来源留在同一批键上的值会原封不动保留，和新主词拼成一份
    // 「来源混合」的歌词。播放页是逐字优先（wordByWord 非空就整篇按逐字渲染），
    // 表现就是整篇词都成了旧来源的文本 —— 选了 A 却显示 B。
    // 宁可退化成无逐字染色的纯文本，也不要让两个来源的时间轴叠在一起：
    // 口径同 qt-pc src-tauri/src/db/store/lyrics.rs 的「空值照写」注释。
    this.lyricCacheRemove(key);
    this.lyricCacheRemove(trKey);
    this.lyricCacheRemove(key + ":wbw");
    this.lyricCacheRemove(key + ":roma");
    // 与自动取词共用同一张「进行中」表，键都是原歌：否则这里会和 prefetchLyric /
    // ensureLyric 对同一首歌同时发两次 invoke —— 正是 lyricInflight 要挡的那一路
    const running = this.lyricInflight.get(key);
    if (running != null) {
      await running;
    }
    const task = this.fetchLyricFor(picked, key, trKey);
    this.lyricInflight.set(key, task);
    try {
      await task;
    } finally {
      this.lyricInflight.delete(key);
    }
    // 返回**缓存里最终的值**而不是这次 invoke 的文本：无词场景下缓存本来是空的，
    // 两者等价；而取不到词时这里返回空串，页面据此提示「这首候选也没有歌词」，
    // 不会把上一次的旧词当成新结果。
    return this.cacheGet(this.lyricCache, key);
  }

  /** 用户是否给这首歌手选过歌词来源（播放页据此显示「已指定来源 / 恢复自动」） */
  hasPickedLyric(song: Song): boolean {
    if (song == null) return false;
    const key = song.platform + ":" + song.id;
    const pick = this.lyricPicks()[key];
    return pick != null;
  }

  /** 取消手选，回到「按原平台自动取词」 */
  clearLyricPick(song: Song): void {
    if (song == null) return;
    const key = song.platform + ":" + song.id;
    const current = this.lyricPicks();
    if (current[key] == null) return;
    const next: Record<string, Song> = {};
    const keys = Object.keys(current);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] != key) next[keys[i]] = current[keys[i]];
    }
    this.lyricPickCache = next;
    this.saveLyricPicks(next);
    // 只删选择记录是不够的：缓存里现在装的是**手选来源**的词，而 ensureLyric 第一行
    // 就是「非空缓存直接返回」。不把这四段清掉，用户点了「恢复自动」会看到歌词纹丝
    // 不动（页面读到的仍是手选源的词），以为按钮坏了。
    // 同理要清 lyricAsked：手选那次 fetchLyricFor 刚写过「已问过」标记，只清缓存的话
    // ensureLyric 会在 TTL（LYRIC_EMPTY_TTL_MS）内直接短路，依旧不会去重取原平台。
    this.lyricCacheRemove(key);
    this.lyricCacheRemove(key + ":tr");
    this.lyricCacheRemove(key + ":wbw");
    this.lyricCacheRemove(key + ":roma");
    this.lyricAsked.delete(key);
    qtDiag("[QT Lyric] 取消手选歌词来源：" + key);
  }

  /**
   * 手选结果的内存副本（懒加载，null = 还没读过存储）。
   *
   * 用普通对象而不是 Map：Map 的键遍历（keys()/forEach）在本仓库没有先例，
   * 而 Object.keys + 下标取值是 stores/lyric-offset.ts 与 stores/dislikes.ts
   * 已经在跑的写法，风险更低。
   */
  private lyricPickCache: Record<string, Song> | null = null;

  private lyricPicks(): Record<string, Song> {
    const cached = this.lyricPickCache;
    if (cached != null) return cached;
    const out: Record<string, Song> = {};
    try {
      const raw = uni.getStorageSync(LYRIC_PICK_KEY) as string;
      if (raw != null && raw.length > 0) {
        const parsed = JSON.parse(raw) as Record<string, Song>;
        if (parsed != null) {
          const keys = Object.keys(parsed);
          for (let i = 0; i < keys.length; i++) {
            const song = parsed[keys[i]];
            // 存储可能被旧版本/手工改坏：缺 platform 或 id 的条目直接丢，
            // 否则后面拼缓存键会得到 "undefined:undefined"
            if (song == null) continue;
            if (song.platform == null || song.platform.length == 0) continue;
            if (song.id == null || song.id.length == 0) continue;
            out[keys[i]] = song;
          }
        }
      }
    } catch (_) {
      // 解析失败按「没有手选」处理：清掉坏值，下次写入会覆盖
      this.lyricPickCache = {};
      return this.lyricPickCache!;
    }
    this.lyricPickCache = out;
    return out;
  }

  /** 取某首歌手选的歌词来源（没选过返回 null） */
  private pickedLyricOf(song: Song): Song | null {
    if (song == null) return null;
    const key = song.platform + ":" + song.id;
    const pick = this.lyricPicks()[key];
    return pick != null ? pick : null;
  }

  private rememberLyricPick(original: Song, picked: Song): void {
    const key = original.platform + ":" + original.id;
    const current = this.lyricPicks();
    const next: Record<string, Song> = {};
    const keys = Object.keys(current);
    for (let i = 0; i < keys.length; i++) next[keys[i]] = current[keys[i]];
    next[key] = picked;
    this.lyricPickCache = next;
    this.saveLyricPicks(next);
  }

  private saveLyricPicks(picks: Record<string, Song>): void {
    try {
      // 全程普通 JS 对象：UTSJSONObject 在 bytecode 运行时是原生注册实例，
      // 批量建实例有「UTS instance is not registered」的事故先例
      // （见 stores/lyric-offset.ts 的 save() 注释）。这里条目很少，但没必要冒险。
      const obj: any = {};
      const keys = Object.keys(picks);
      for (let i = 0; i < keys.length; i++) obj[keys[i]] = picks[keys[i]];
      uni.setStorageSync(LYRIC_PICK_KEY, JSON.stringify(obj));
    } catch (_) {}
  }

  /**
   * 按歌曲信息查询封面。给本地歌单里 picUrl 为空的歌曲（如服务器同步过来的收藏）补全封面。
   * local 歌曲按旧实现优先匹配酷我；其余走原平台搜索 + 网易云兜底（bundle 侧自带缓存）。
   * 返回 "" 表示未取到（不抛错，与旧实现一致）。
   */
  async songCover(song: Song): Promise<string> {
    if (song.picUrl != null && song.picUrl.length > 0) return song.picUrl;
    const source: Source = song.platform == "local" ? "kw" : (song.platform as Source);
    const args = new UTSJSONObject();
    args.set("source", source);
    args.set("song", this.songArgsOf(song));
    try {
      const response = await this.engineInvoke("cover", args);
      return this.strOf(response.get("url"));
    } catch (_) {
      return "";
    }
  }
}

export const musicApi = new MusicApi();

export class AccountApi {
  login(username: string, password: string): Promise<UTSJSONObject> {
    return gateway(
      "app/user/login",
      { username, password } as UTSJSONObject,
      "POST"
    ) as Promise<UTSJSONObject>;
  }
  register(data: UTSJSONObject): Promise<UTSJSONObject> {
    return gateway("app/user/register", data, "POST") as Promise<UTSJSONObject>;
  }
  logout(): Promise<UTSJSONObject> {
    return gateway(
      "app/user/logout",
      new UTSJSONObject(),
      "POST",
      true
    ) as Promise<UTSJSONObject>;
  }
  /** 获取当前用户信息（/me） */
  me(): Promise<UTSJSONObject> {
    return gateway("app/user/me", new UTSJSONObject(), "GET", true) as Promise<UTSJSONObject>;
  }
  /** 刷新 token（由 http.ts 内部调用，无需暴露） */
  refresh(): Promise<UTSJSONObject> {
    return gateway("app/user/refresh", new UTSJSONObject(), "POST", true) as Promise<UTSJSONObject>;
  }
  updateProfile(data: UTSJSONObject): Promise<UTSJSONObject> {
    return gateway("app/user/update", data, "POST", true) as Promise<UTSJSONObject>;
  }
  sendEmail(email: string, body: string): Promise<UTSJSONObject> {
    return gateway(
      "app/user/email",
      { email, body } as UTSJSONObject,
      "POST"
    ) as Promise<UTSJSONObject>;
  }
  changePassword(
    email: string,
    password: string,
    code: string
  ): Promise<UTSJSONObject> {
    return gateway(
      "app/user/changePass",
      { email, password, code } as UTSJSONObject,
      "POST"
    ) as Promise<UTSJSONObject>;
  }
  /** 签到 */
  daka(data: UTSJSONObject): Promise<UTSJSONObject> {
    return gateway("app/user/daka", data, "POST", true) as Promise<UTSJSONObject>;
  }
  /** 获取签到信息（连续天数和积分） */
  dakaInfo(): Promise<UTSJSONObject> {
    return gateway("app/user/dakaInfo", new UTSJSONObject(), "GET", true) as Promise<UTSJSONObject>;
  }
  /** 获取某月签到详情 */
  dakaInfoByMonth(time: string): Promise<UTSJSONObject> {
    return gateway("app/user/dakaInfoByMonth", { time } as UTSJSONObject, "GET", true) as Promise<UTSJSONObject>;
  }
  // channel 入参已随后端接口删除（测试人群识别改走 satoken 请求头）
  appUpdate(type: number, versionCode: number): Promise<UTSJSONObject> {
    return gateway("app/update", {
      type,
      version: versionCode.toString(),
    } as UTSJSONObject) as Promise<UTSJSONObject>;
  }

  /** 校验当前 APP 是否为官方发布版本（非官方时后端返回错误，Promise 会被 reject） */
  versionCheck(type: number, versionCode: number, versionName: string): Promise<UTSJSONObject> {
    return gateway("app/version/check", {
      type,
      version: versionCode.toString(),
      versionName,
    } as UTSJSONObject) as Promise<UTSJSONObject>;
  }
}

export const accountApi = new AccountApi();

/**
 * 解析 /me 或登录响应里的角色与权限列表并缓存到本地（按权限显示入口用）。
 * 2026-09-30 权限模型重构（V20260930001）后响应根层是两份：
 * `roles` = 角色名（如 TESTER/APP_USER），`permissions` = 分层权限码
 * （如 admin:qt:admin；超管角色合成 *:*:* 不落库）。两份都缓存。
 */
export function persistUserRoles(user: UTSJSONObject | null): void {
  if (user == null) {
    console.log("[Roles] persistUserRoles: user 为空");
    return;
  }
  const roles = user.get("roles");
  if (roles != null) {
    try {
      uni.setStorageSync("qt-roles", JSON.stringify(roles));
    } catch (_) {}
  }
  const permissions = user.get("permissions");
  if (permissions != null) {
    try {
      uni.setStorageSync("qt-permissions", JSON.stringify(permissions));
    } catch (_) {}
  }
}

/** 读本地缓存的字符串数组（JSON 文本），缺失/损坏返回空数组 */
function cachedStringList(key: string): string[] {
  const out: string[] = [];
  try {
    const raw = uni.getStorageSync(key) as string;
    if (raw == null || raw.length == 0) return out;
    const arr = JSON.parse(raw);
    if (arr == null) return out;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v != null) out.push(v.toString());
    }
  } catch (_) {}
  return out;
}

/** 一组已授予码是否满足轻听管理员：精确新码、超管、层级通配、旧扁平码兜底 */
function codesGrantQtAdmin(granted: string[]): boolean {
  const required = "admin:qt:admin";
  for (let i = 0; i < granted.length; i++) {
    const g = granted[i];
    if (g == required || g == "qt_admin" || g == "*:*:*") return true;
    // 层级通配对齐后端 PermissionChecker：admin:qt:* / admin:* 按段前缀覆盖
    if (g.length > 2 && g.substring(g.length - 2) == ":*") {
      const prefix = g.substring(0, g.length - 1);
      if (required.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * 轻听管理员判定（按权限显示入口用，如播放页「播放地址」调试入口）。
 * 权限来源以 qt-permissions（新分层码）为主，qt-roles 里的旧扁平码 qt_admin
 * 兜底未跑迁移的线上库。
 */
export function isQtAdmin(): boolean {
  // 权限缓存只代表「最后一次成功登录的账号」：qt-permissions / qt-roles 仅在
  // 手动退出登录时清理，token 过期/被服务端踢下线后会残留。不先验登录态的话，
  // 未登录也会按旧账号权限显示播放页「播放地址」等管理入口。
  if (!isLoggedIn()) return false;
  return (
    codesGrantQtAdmin(cachedStringList("qt-permissions")) ||
    codesGrantQtAdmin(cachedStringList("qt-roles"))
  );
}
