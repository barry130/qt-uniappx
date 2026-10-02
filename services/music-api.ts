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
import { getPlayUrlByEngine, invokeSource, consumePlayUrlLine } from "./source-engine";
import type { PlayUrlLine } from "./source-engine";
import { qtDiag } from "./diag";
import type { Playlist, Song, Artist, Album } from "@/types/music";

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
/** 数据包注册表里的一个音源（展示名沿用匿名口径，由包声明） */
export type RegistrySource = { id: string; name: string; short: string; color: string };
/** 数据包注册表里的一个音质档位 */
export type RegistryQuality = { id: string; name: string };
/** 数据包注册表（音源清单 + 音质档位；宿主 UI 选项的唯一来源） */
export type SourceRegistry = { sources: RegistrySource[]; qualities: RegistryQuality[] };
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
  private lyricCache = new UTSJSONObject();
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
  /** 最近一次跨源兜底命中的目标歌（rememberUrlLine 记录，playUrl 消费后清空） */
  private lastCrossTarget: Song | null = null;

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
  }

  /** 作废单条播放地址缓存（UTSJSONObject 无 delete，置空串等同未命中） */
  private urlCacheRemove(key: string): void {
    this.urlCache.set(key, "");
    this.urlCacheAt.set(key, 0);
    this.urlLine.set(key, "");
  }

  /**
   * 清空全部播放地址缓存。音源包生效/回退后调用（方案 §2.4）：整条链路换了一套，
   * 旧地址在 10 分钟 TTL 内仍会被复用，会让人误以为新包没生效。
   */
  clearPlayUrlCache(): void {
    this.urlCache = new UTSJSONObject();
    this.urlCacheAt = new Map<string, number>();
    this.urlLine = new Map<string, string>();
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
        sources.push({
          id: this.strOf(item.get("id")),
          name: this.strOf(item.get("name")),
          short: this.strOf(item.get("short")),
          color: this.strOf(item.get("color")),
        });
      }
      const qualities: RegistryQuality[] = [];
      for (let i = 0; i < rawQualities.length; i++) {
        const item = rawQualities[i];
        qualities.push({ id: this.strOf(item.get("id")), name: this.strOf(item.get("name")) });
      }
      if (sources.length == 0) return null;
      return { sources, qualities };
    } catch (_) {
      return null;
    }
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

  /** 推荐歌单（category 为空时 bundle 取各平台默认分类） */
  async recommendations(source: Source, category?: string, page?: number): Promise<Playlist[]> {
    const cacheKey = "rec:" + source + ":" + (category != null ? category : "") + ":" + (page != null ? page : 1);
    const hit = this.dataGet(cacheKey);
    if (hit != null) return hit as Playlist[];
    const args = new UTSJSONObject();
    args.set("source", source);
    args.set("category", category != null && category.length > 0 ? category : null);
    args.set("page", page != null ? page : 1);
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
   * 四源最新歌曲交错合并。不用 bundle 的 allLatest 入口——它返回的 MusicInfo
   * 不带 platform，合并后无法区分来源；这里保留旧的逐源调用 + 交错逻辑。
   */
  async allLatest(limit: number, offset: number): Promise<Song[]> {
    const perSource = Math.ceil(limit / 4) + 1;
    let wyy: Song[] = [];
    let qq: Song[] = [];
    let kw: Song[] = [];
    let kg: Song[] = [];
    try { wyy = await this.latest("wyy", perSource, offset); } catch (e) { console.error("[QT Latest] wyy", e); }
    try { qq = await this.latest("qq", perSource, 0); } catch (e) { console.error("[QT Latest] qq", e); }
    try { kw = await this.latest("kw", perSource, 0); } catch (e) { console.error("[QT Latest] kw", e); }
    try { kg = await this.latest("kg", perSource, offset); } catch (e) { console.error("[QT Latest] kg", e); }
    const all: Song[] = [];
    for (let index = 0; index < perSource && all.length < limit; index++) {
      if (index < wyy.length) all.push(wyy[index] as Song);
      if (all.length >= limit) break;
      if (index < qq.length) all.push(qq[index] as Song);
      if (all.length >= limit) break;
      if (index < kw.length) all.push(kw[index] as Song);
      if (all.length >= limit) break;
      if (index < kg.length) all.push(kg[index] as Song);
    }
    return all;
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

  /** 歌手歌曲（bundle 侧第一页附头像 picUrl，与旧实现语义一致） */
  async artistSongs(
    name: string,
    source: Source = "wyy",
    page: number = 1,
    size: number = 30
  ): Promise<{ picUrl: string; songs: Song[] }> {
    const s = sourceName(source);
    const args = new UTSJSONObject();
    args.set("source", s);
    args.set("name", name);
    args.set("page", page);
    args.set("size", size);
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
    return { picUrl: this.strOf(response.get("picUrl")), songs };
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
    if (detail == null) throw new Error("专辑不存在");
    return this.playlistDetailFromContract(detail, s);
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
   * 从用户输入解析出歌单平台和 id。
   *
   * 支持直接粘贴分享链接（按域名自动识别平台），也支持纯数字 id
   *（此时必须给 fallback 平台，否则无法判断归属）。返回 null 表示无法识别。
   */
  parsePlaylistInput(
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
    if (detail == null) throw new Error("歌单不存在");
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
    const url = await this.resolvePlayUrl(song, quality, cacheKey);
    if (url.length > 0) {
      const at = this.urlCacheAt.get(cacheKey);
      const ts = at != null ? at : 0;
      song.urlFetchedAt = ts > 0 ? ts : Date.now();
      // 取到地址就把这首歌的歌词一起取好。默认「URL 哪个源就用哪个源的歌词」
      // （地址按 song.platform 取）；但跨源兜底命中时 URL 来自目标源（如 kw 救回
      // wyy 的歌），歌词必须跟随目标源重取，否则配的是原平台的词，很可能对不上。
      // 缓存键仍用原歌（播放页/桌面歌词读的都是原歌键）。
      const crossTarget = this.lastCrossTarget;
      this.lastCrossTarget = null;
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
  ): Promise<string> {
    const cached = this.urlCacheGet(cacheKey);
    if (cached.length > 0) return cached;
    // 取链只走音源引擎：仓库不内置任何音源包（数据包/播放包都由用户在设置页
    // 从链接或本地文件安装，已装包的更新走 manifest/自管探测）后启动预热装载；
    // 取不到（未安装/线路全灭/装载失败）就报错，不再回退 TS 原型链——两套实现难维护，
    // 且原型链会让「链路热更新失效」这类问题被旧实现掩盖（方案 §2.6）。
    const engineUrl = await getPlayUrlByEngine(song, quality);
    if (engineUrl.length > 0) {
      this.urlCacheSet(cacheKey, engineUrl);
      // 命中线路与地址一起记（引擎侧读后即清）：管理端要看「这条地址是音源包里
      // 哪条源取到的」，而地址会被复用 10 分钟，线路必须跟着地址走
      this.rememberUrlLine(cacheKey);
      return engineUrl;
    }
    throw new Error("该歌曲暂时无法播放");
  }

  /** 把引擎刚回报的命中线路落进 urlLine（无回报 = 包内缓存命中/老包，保持原值） */
  private rememberUrlLine(cacheKey: string): void {
    const line = consumePlayUrlLine();
    if (line == null) return;
    // 展示成「名称 · 机制 · 线路 id」（名称缺失时不留空档，只拼有的那几段）
    let text = line.id;
    if (line.kind.length > 0) text = line.kind + " · " + text;
    if (line.name.length > 0) text = line.name + " · " + text;
    this.urlLine.set(cacheKey, text);
    // 管理端弹窗只对 qt_admin 角色可见，排查期留一行日志：弹窗里那条文本就是它，
    // 非管理员账号（或没登录）也能从日志核对「这条地址走的是音源包里哪条源」
    qtDiag("[QT URL] 命中音源线路 " + text + "（" + cacheKey + "）");
    // 跨源兜底命中（如 kw 救回 wyy 的歌）：记住目标歌，playUrl 用它把歌词切到目标源
    this.lastCrossTarget =
      line.kind == "cross" && line.targetSong != null ? line.targetSong : null;
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
    const task = this.fetchLyricFor(song, key, trKey);
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
    let failed = false;
    let errText = "";
    try {
      const response = await this.engineInvoke("lyric", this.lyricArgs(song));
      lyric = this.strOf(response.get("lyric"));
      translation = this.strOf(response.get("translation"));
    } catch (e) {
      failed = true;
      errText = e != null ? e.toString() : "";
    }
    // 成功与失败都打：播放页/桌面歌词两处「歌词不出现、不跟随」的排查全靠这条
    qtDiag("[QT Lyric] 取词 " + key + " 歌词 " + lyric.length + " 字符 / 翻译 "
      + translation.length + " 字符" + (failed ? " 异常：" + errText : ""));
    if (lyric.length > 0) this.cacheSet(this.lyricCache, key, lyric);
    if (translation.length > 0) this.cacheSet(this.lyricCache, trKey, translation);
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
  /** 获取收藏歌单+歌曲 */
  getLikeList(): Promise<UTSJSONObject> {
    return gateway(
      "app/user/getLikeList",
      new UTSJSONObject(),
      "GET",
      true
    ) as Promise<UTSJSONObject>;
  }
  /** 同步收藏歌单+歌曲 */
  uploadLikeList(data: UTSJSONObject): Promise<UTSJSONObject> {
    return gateway("app/user/uploadLikeList", data, "POST", true) as Promise<UTSJSONObject>;
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
  appNotice(): Promise<UTSJSONObject> {
    return gateway("app/notice") as Promise<UTSJSONObject>;
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
  return (
    codesGrantQtAdmin(cachedStringList("qt-permissions")) ||
    codesGrantQtAdmin(cachedStringList("qt-roles"))
  );
}
