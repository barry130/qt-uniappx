import { reactive } from "vue";
import { musicApi, isPlayUrlStale } from "@/services/music-api";
import { isEncryptedMediaUrl } from "@/services/music-api";
import type { Source } from "@/services/music-api";
import { parseJsonToUtso } from "@/services/http";
import { saveToPublicMedia, ensurePublicDirPermission, deleteMediaByPath } from "@/uni_modules/qt-app-native";
import { restoreCustomDir } from "@/services/app-native";
import type { Song } from "@/types/music";
import { logErrV } from "@/services/logger";
import { qtDiag } from "@/services/diag";
import { qtShowToast } from "@/services/toast";

const DOWNLOAD_KEY = "qt-downloads";
/** 未完成任务队列（pending/failed）的持久化键：重启后恢复队列（2026-10 用户反馈“退出重启后未完成任务全部丢失”） */
const DOWNLOAD_TASKS_KEY = "qt-download-tasks";

export type DownloadItem = {
  song: Song;
  path: string;
  time: number;
  /** 成品字节数（0 = 未知，老记录/兜底路径）。列表里显示「12.3 MB」用 */
  size: number;
};

export type DownloadTask = {
  song: Song;
  status: "pending" | "downloading" | "done" | "failed" | "paused";
  path: string;
  error: string;
  progress: number;
  /** 已写字节数（0 = 还没开始）。只由 noteBytes 写，不单独触发渲染 */
  doneBytes: number;
  /** 总字节数（0 = 未知，音源没报 Content-Length）。用于「1.2 GB / 1.8 GB」 */
  totalBytes: number;
  /** 速度采样（字节/秒），由 1s 采样器统一算；非在途恒为 0 */
  speed: number;
  /** 采样基准：上一次 tick 时的 doneBytes。不参与渲染 */
  lastBytes: number;
  /** 已自动重试次数（0 = 还没重试过）；队列重启后恢复，重试计数从头开始 */
  retryCount: number;
  /** 退避到期时间戳：findPending 跳过未到点的任务，避免退避期间被立刻重取 */
  retryAt: number;
  /** 被用户从队列移除的标记：在途任务靠它放弃落盘（uni.downloadFile 无法可靠 abort） */
  cancelled: boolean;
  /** 在途传输的代次：暂停后再继续会立刻开新传输，旧传输回来按代次不匹配丢弃 */
  runId: number;
  /** uni.downloadFile 的任务句柄：暂停时尽力 abort（部分平台空实现，靠 cancelled 兜底） */
  abortHandle: any;
};

/** 批量入队结果：added=真正入队数，skipped=已下载或已在队列而被跳过数 */
export type QtBatchEnqueueResult = {
  added: number;
  skipped: number;
};

/**
 * 批量删除结果：removed=删掉的下载记录数，filesDeleted=磁盘文件删除成功数，
 * filesFailed=文件未能删除数（记录已删、文件残留，由调用方提示去文件管理清理）
 */
export type QtBatchRemoveResult = {
  removed: number;
  filesDeleted: number;
  filesFailed: number;
};

/** 单个分块下载结果：temp=块临时文件；whole=true 表示服务器无视 Range、直接回了整个文件（temp 即成品） */
type QtChunkResult = {
  temp: string;
  whole: boolean;
};

/** 单个下载文件的整体限时：防底层挂起占死下载队列 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** 断点续传：单块字节数（2MB）。块越小暂停损失越小，但请求数越多 */
const DOWNLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
/** 断点续传：单块限时。块级卡死能更快归还并发名额 */
const DOWNLOAD_CHUNK_TIMEOUT_MS = 90 * 1000;
/**
 * 断点续传：总长探测限时。探测走 downloadFile（带 Range 只下 1 字节），
 * 正常都在首个进度回调里就结束；只有探测本身卡住才会走满这个超时。
 * 探测最多两轮（先不带 Range、再带 Range），所以最坏是 2× 这个值。
 */
const DOWNLOAD_HEAD_TIMEOUT_MS = 8 * 1000;
/**
 * 断点续传：可信的最小总长。206 部分响应（Range: bytes=0-0）下
 * totalBytesExpectedToWrite 有可能只报这 1 个字节，若当成总长就会把
 * 1 字节文件当成品落盘。音频不可能小于这个值，低于它一律视为探测失败。
 */
const DOWNLOAD_MIN_TOTAL_BYTES = 64 * 1024;

/** 自动重试上限与退避间隔（毫秒）：次数用尽才落到 failed 等用户手动重试 */
const DOWNLOAD_MAX_RETRY = 2;
const DOWNLOAD_RETRY_DELAYS: number[] = [1500, 4000];

const DOWNLOAD_QUALITY_KEY = "qt-download-quality";
/**
 * 无损档位（下载扩展名兜底用）。
 *
 * 只列**容器就是 FLAC** 的档位，不能写成「非数字即无损」：dolby / atmos 是
 * mp4/m4a 容器，落到 .flac 会让文件名与真实格式不符。与 PC 侧
 * `commands.rs::is_lossless_quality` 同一份契约，两边要一起改。
 */
const LOSSLESS_QUALITIES: string[] = ["flac", "flac24bit", "hires", "master"];

function isLosslessQuality(quality: string): boolean {
  return LOSSLESS_QUALITIES.indexOf(quality) >= 0;
}

/** 断点续传 .part 的存放目录名（应用私有目录下，重启仍在） */
const DOWNLOAD_PART_DIR_NAME = "qt-download-parts";

/** 续传 .part 的完整目录；拿不到私有目录返回 null（退回一次性整下） */
function partDirOf(): string | null {
  const base = uni.env.USER_DATA_PATH;
  if (base == null || base.length == 0) return null;
  return base + "/" + DOWNLOAD_PART_DIR_NAME;
}

/** 续传 .part 文件名用的歌曲键：platform__id，非文件名安全字符压成下划线 */
function partKey(song: Song): string {
  return (song.platform + "__" + song.id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 歌词落盘前的临时文件（私有目录，写完交给原生插件搬进公共目录） */
function lyricTempPath(song: Song): string | null {
  const base = uni.env.USER_DATA_PATH;
  if (base == null || base.length == 0) return null;
  return base + "/" + partKey(song) + ".lrc";
}

/**
 * 封面文件名扩展名：按图片地址推断（先砍掉 ?query，部分图床会拼参数），
 * 认不出就按 .jpg 处理——原生插件按扩展名定 MIME，猜错只影响相册归类。
 */
function coverExtOf(url: string): string {
  const lower = url.toLowerCase();
  const q = lower.indexOf("?");
  const path = q >= 0 ? lower.substring(0, q) : lower;
  if (path.endsWith(".png")) return ".png";
  if (path.endsWith(".webp")) return ".webp";
  if (path.endsWith(".jpeg")) return ".jpeg";
  return ".jpg";
}

/** 去掉 file:// 前缀：FS 同步接口在部分平台只认绝对路径 */
function plainPath(p: string): string {
  if (p.indexOf("file://") == 0) return p.substring(7);
  return p;
}

/**
 * 音频同 basename 的侧车候选路径（封面 + 歌词）。扩展名只能猜——封面按图床
 * 可能是 png/webp，歌词在旧原生层还留下过 `.lrc.txt` 双扩展名——所以这些
 * 路径**只用于尽力而为的删除**，不能按「删不掉」计数（见 deleteSidecars）。
 */
function sidecarPathsOf(path: string): string[] {
  const plain = plainPath(path);
  const slash = plain.lastIndexOf("/");
  const dot = plain.lastIndexOf(".");
  const base = dot > slash ? plain.substring(0, dot) : plain;
  return [
    base + ".jpg",
    base + ".jpeg",
    base + ".png",
    base + ".webp",
    base + ".lrc",
    base + ".lrc.txt",
  ];
}

/**
 * 是否网络地址。下载必须拿 http(s) 链接：歌曲上的 url 可能是**本地文件路径**
 * （这首歌此前从「已下载」列表播放过，播放器把落盘路径写回了 song.url），
 * 直接丢给 uni.downloadFile 只会得到 errCode 602001 "invalid URL"，
 * 用户看到的却是一句没有信息量的「下载失败」。
 */
function isRemoteUrl(url: string | null): boolean {
  if (url == null || url.length == 0) return false;
  const lower = url.toLowerCase();
  return lower.indexOf("http://") == 0 || lower.indexOf("https://") == 0;
}

/** 把底层网络失败翻成用户能懂的短句（下载列表失败行直接展示） */
function describeNetError(e: any): string {
  let raw = "";
  // uni 的失败对象把原因放在 errMsg 上，message 往往是空串（实测
  // {"errCode":602001,"errMsg":"invalid URL","message":""}），只读 message
  // 会把所有底层失败都糊成同一句废话，所以再兜一层 JSON 序列化取 errMsg
  try {
    const m = e != null ? (e as Error).message : null;
    if (m != null && m.length > 0) raw = m;
  } catch (_) {
    raw = "";
  }
  if (raw.length == 0) {
    try {
      const j = JSON.stringify(e);
      if (j != null && j.length > 0 && j != "{}") raw = j;
    } catch (_) {}
  }
  if (raw.length == 0) {
    try {
      raw = e != null ? e.toString() : "";
    } catch (_) {}
  }
  const text = raw.toLowerCase();
  if (raw.indexOf("超时") >= 0 || text.indexOf("timeout") >= 0 || text.indexOf("timed out") >= 0)
    return "网络超时（连接太慢或音源限速）";
  if (text.indexOf("invalid url") >= 0) return "下载地址无效（音源未返回可用链接）";
  if (
    text.indexOf("unknownhost") >= 0 ||
    text.indexOf("unable to resolve") >= 0 ||
    text.indexOf("enotfound") >= 0 ||
    text.indexOf("no address") >= 0
  )
    return "域名解析失败（请检查网络）";
  if (text.indexOf("econnrefused") >= 0 || text.indexOf("connection refused") >= 0)
    return "连接被音源拒绝";
  if (
    text.indexOf("econnreset") >= 0 ||
    text.indexOf("connection reset") >= 0 ||
    text.indexOf("broken pipe") >= 0
  )
    return "连接被重置（网络不稳定）";
  return "网络错误（请稍后重试）";
}

/** HTTP 状态码 → 失败原因短句（下载列表失败行直接展示） */
function describeHttpStatus(code: number): string {
  if (code == 401 || code == 403) return "链接被拒绝（" + code + "：防盗链或链接已过期）";
  if (code == 404) return "文件不存在（404：音源可能已下架）";
  if (code == 416) return "续传范围无效（416）";
  if (code >= 400 && code < 500) return "音源拒绝请求（HTTP " + code + "）";
  if (code >= 500) return "音源服务器出错（HTTP " + code + "）";
  return "下载失败（HTTP " + code + "）";
}
/**
 * 判断一次分块失败是不是 416（Range 不满足）。
 *
 * 416 的含义很明确：我们按 .part 现存量算出的 start 已经越过服务器上这个
 * 文件的实际末尾——也就是「侧车记的总长」和「这次新取到的 URL 的实际大小」
 * 对不上（链接重取后换了个不同长度的文件）。这不是网络抖动，重试同一段
 * 永远还是 416，必须把 .part 清掉重新探测，否则会一直空转到失败。
 *
 * uni.downloadFile 把非 2xx 当 fail 抛出（errCode 602001，errMsg 里是
 * 416 的 HTML），statusCode 路径则是我们自己的 describeHttpStatus 文案，
 * 两条路径都要认。
 */
function isRangeNotSatisfiable(e: any): boolean {
  if (e == null) return false;
  try {
    const text = e.toString();
    if (text != null && text.indexOf("416") >= 0) return true;
  } catch (_) {}
  try {
    const j = JSON.stringify(e);
    if (j != null && j.indexOf("416") >= 0) return true;
  } catch (_) {}
  return false;
}
/** 下载文件名格式（uni 存储键）：artist=歌手-歌名（默认），song=歌名-歌手 */
const DOWNLOAD_NAME_FORMAT_KEY = "qt-download-name-format";
/** 同时下载数（uni 存储键）：默认 3，范围 1~6 */
const DOWNLOAD_CONCURRENCY_KEY = "qt-download-concurrency";
export const DOWNLOAD_CONCURRENCY_MIN = 1;
export const DOWNLOAD_CONCURRENCY_MAX = 6;
export const DOWNLOAD_CONCURRENCY_DEFAULT = 3;
/**
 * 超过 3 并发就要提醒一次：音源 CDN 普遍按 IP 限流，一次放太多连接容易被判成
 * 爬虫而临时封 IP（LX Music 的默认上限也是 3）。这里只提醒，不禁止。
 */
export const DOWNLOAD_CONCURRENCY_WARN_ABOVE = 3;

/**
 * 下载同时保存封面 / 歌词（uni 存储键）。都默认关：额外请求会拖慢整批下载，
 * 也让原本只有音频的目录多出文件，因此交给用户逐项打开。
 */
const DOWNLOAD_COVER_KEY = "qt-download-cover";
const DOWNLOAD_LYRIC_KEY = "qt-download-lyric";

/**
 * 删除下载记录时是否连磁盘文件一起删（uni 存储键）。默认开：用户在下载管理里
 * 点删除，期望的是「这首歌从手机里没了」，只留一堆文件反而更糟。关掉则只清记录，
 * 文件留在原处给别的播放器用（设置 → 下载管理里可改）。
 * 注意存的语义是「关」才写 "0"，历史用户没这个键时按开处理。
 */
const DOWNLOAD_DELETE_FILE_KEY = "qt-download-delete-file";

export const DOWNLOAD_DIR_HINT = "/Download/QtDownload/Music";
export const DOWNLOAD_DIR_SUB = "QtDownload/Music";
/** 用户自定义下载目录的绝对路径（uni 存储键）；空串 = 用默认的 DOWNLOAD_DIR_SUB */
const DOWNLOAD_DIR_KEY = "qt-download-dir";

function songToJson(song: Song): string {
  const obj = new UTSJSONObject();
  obj.set("id", song.id);
  obj.set("name", song.name);
  obj.set("singer", song.singer);
  obj.set("album", song.album);
  obj.set("picUrl", song.picUrl);
  obj.set("platform", song.platform);
  if (song.url != null && song.url.length > 0) obj.set("url", song.url);
  if (song.duration != null && song.duration > 0)
    obj.set("duration", song.duration);
  if (song.musicId != null && song.musicId.length > 0)
    obj.set("musicId", song.musicId);
  return JSON.stringify(obj);
}

function songFromJson(text: string): Song | null {
  if (text.length == 0) return null;
  try {
    const obj = parseJsonToUtso(text);
    const id = obj.get("id") as string | null;
    if (id == null || id.length == 0) return null;
    const name = obj.get("name") as string | null;
    const singer = obj.get("singer") as string | null;
    const album = obj.get("album") as string | null;
    const picUrl = obj.get("picUrl") as string | null;
    const platform = obj.get("platform") as string | null;
    const url = obj.get("url") as string | null;
    const duration = obj.get("duration") as number | null;
    const musicId = obj.get("musicId") as string | null;
    return {
      id,
      name: name != null ? name : "",
      singer: singer != null ? singer : "",
      album: album != null ? album : "",
      picUrl: picUrl != null ? picUrl : "",
      platform: platform != null ? platform : "",
      url: url != null ? url : "",
      duration: duration != null ? duration : 0,
      musicId: musicId != null && musicId.length > 0 ? musicId : undefined,
    };
  } catch (_) {
    return null;
  }
}

class DownloadsStore {
  items: DownloadItem[] = [];
  tasks: DownloadTask[] = [];
  downloadQuality = "320";
  /** 下载文件名格式：artist=歌手-歌名（默认），song=歌名-歌手 */
  downloadNameFormat = "artist";
  /** 同时下载数：1~6，默认 3 */
  concurrency = DOWNLOAD_CONCURRENCY_DEFAULT;
  /** 下载时一并保存封面图（默认关） */
  downloadCover = false;
  /** 下载时一并保存歌词文件（默认关） */
  downloadLyric = false;
  /** 删除下载记录时连同磁盘文件一起删（默认开） */
  deleteFileOnRemove = true;
  /**
   * 用户自定义下载目录的绝对路径（空串 = 用默认 Download/QtDownload/Music）。
   * 只有 Android 能设置成功（需要「所有文件访问」），鸿蒙 / iOS 恒为空。
   */
  customDir = "";
  /**
   * 在途任务数。并发闸门就靠它 + findPending 的「只取一个」保证不超发：
   * 每个 pump 循环先把在途数补到 concurrency 为止。
   */
  private active = 0;
  /** 防重入：pump 自身是异步的，多个入口同时调只保留一个在跑 */
  private pumping = false;
  /** 队列是否已从磁盘恢复过：restore() 会被 App 启动 + 多页 onShow 反复调，只恢复一次 */
  private tasksRestored = false;
  /**
   * 速度采样定时器。**只在有在途任务时存在**（pump 里起、sampleSpeed 发现
   * 没有在途任务时自己停），空转的 1s 定时器没必要一直跑着。
   */
  private speedTimer = 0;
  /** 上一次采样时刻（毫秒），算 dt 用 */
  private lastTickAt = 0;
  /** 老记录字节数回填是否已跑过（restore 会被反复调，只跑一次） */
  private sizeBackfillDone = false;

  restore(): void {
    // 队列恢复只做一次；恢复内部会 pump，等待中的任务自动续传
    if (!this.tasksRestored) {
      this.tasksRestored = true;
      this.restoreTasks();
      // 顺带清扫孤儿续传残留：队列里已没有对应任务的 .part/.meta
      this.sweepStaleParts();
    }
    // 注意：下面解析「已下载列表」的 try 块**不能提前 return**。
    // DOWNLOAD_KEY 只在真正下载过东西后才写入，而下载设置（音质/文件名格式/并发数/
    // 封面/歌词/自定义目录）是各自独立的键 —— 用户完全可能装完就先去改设置、
    // 一首歌都还没下。老代码在这里 `if (raw.length == 0) return`，等于「没下过歌
    // 就丢掉全部下载设置」，重启后设置项全部打回默认。
    try {
      const raw = uni.getStorageSync(DOWNLOAD_KEY) as string;
      if (raw.length > 0) {
        const arr = JSON.parse(raw) as string[];
        const items: DownloadItem[] = [];
        for (let index = 0; index < arr.length; index++) {
          const text = arr[index] as string;
          const sep = text.indexOf("||");
          if (sep <= 0) continue;
          const songText = text.substring(0, sep);
          let rest = text.substring(sep + 2);
          // 第三段（字节数）是可选的：老记录只有 song||path。
          // 用 lastIndexOf 取尾段并校验是纯数字，路径里万一有 "||" 也不会误切。
          let size = 0;
          const tail = rest.lastIndexOf("||");
          if (tail > 0) {
            const maybe = rest.substring(tail + 2);
            let numeric = maybe.length > 0;
            for (let c = 0; c < maybe.length; c++) {
              const ch = maybe.charCodeAt(c);
              if (ch < 48 || ch > 57) {
                numeric = false;
                break;
              }
            }
            if (numeric) {
              size = parseInt(maybe);
              rest = rest.substring(0, tail);
            }
          }
          const path = rest;
          const song = songFromJson(songText);
          if (song != null && path.length > 0)
            items.push({ song, path, time: Date.now(), size });
        }
        this.items = items;
      }
    } catch (_) {
      this.items = [];
    }
    // 兜底：已完成的歌曲不再挂任务（items 先于 tasks 落盘，竞态窗口只有几毫秒，
    // 但出现了就剔掉，避免重启后把下完的歌再下一遍）
    if (this.tasks.length > 0) {
      const kept: DownloadTask[] = [];
      for (let i = 0; i < this.tasks.length; i++) {
        if (!this.isDownloaded(this.tasks[i].song)) kept.push(this.tasks[i]);
      }
      this.tasks = kept;
    }
    try {
      const dq = uni.getStorageSync(DOWNLOAD_QUALITY_KEY) as string;
      if (dq != null && dq.length > 0) this.downloadQuality = dq;
    } catch (_) {}
    try {
      const df = uni.getStorageSync(DOWNLOAD_NAME_FORMAT_KEY) as string;
      if (df == "song" || df == "artist") this.downloadNameFormat = df;
    } catch (_) {}
    try {
      const dc = uni.getStorageSync(DOWNLOAD_CONCURRENCY_KEY) as string;
      if (dc != null && dc.length > 0) {
        const n = parseInt(dc);
        if (n >= DOWNLOAD_CONCURRENCY_MIN && n <= DOWNLOAD_CONCURRENCY_MAX) this.concurrency = n;
      }
    } catch (_) {}
    try {
      this.downloadCover = uni.getStorageSync(DOWNLOAD_COVER_KEY) == "1";
    } catch (_) {}
    try {
      this.downloadLyric = uni.getStorageSync(DOWNLOAD_LYRIC_KEY) == "1";
    } catch (_) {}
    try {
      // 只有显式存过 "0" 才算关，没这个键（老用户）保持默认开
      this.deleteFileOnRemove = uni.getStorageSync(DOWNLOAD_DELETE_FILE_KEY) != "0";
    } catch (_) {}
    try {
      const dd = uni.getStorageSync(DOWNLOAD_DIR_KEY) as string;
      if (dd != null && dd.length > 0) this.customDir = dd;
    } catch (_) {}
    // 鸿蒙：自定义目录存的是**目录 URI**（picker + persistPermission 的产物），
    // 原生变量不跨进程，必须把 URI 喂回去并让原生侧 activatePermission 激活，
    // 否则每次重启后往公共目录写都会失败（Android 存的是真实路径，此调用是空实现）。
    restoreCustomDir(this.customDir);
    // 老记录（size == 0）回填：落盘格式加字节数之前下过的歌没有这一项，
    // 不回填的话「已下载」列表和顶部总大小都会缺一块。异步、不阻塞启动。
    this.backfillSizes();
  }

  /**
   * 回填已下载记录的字节数（只跑一次）。读磁盘是异步的，逐个补；
   * 补不到（文件被用户删了/路径失效）就保持 0，界面显示占位而不是假数字。
   */
  private backfillSizes(): void {
    if (this.sizeBackfillDone) return;
    this.sizeBackfillDone = true;
    const targets: DownloadItem[] = [];
    for (let index = 0; index < this.items.length; index++) {
      if (this.items[index].size <= 0) targets.push(this.items[index]);
    }
    if (targets.length == 0) return;
    const step = (i: number): void => {
      if (i >= targets.length) {
        this.save();
        // 采样器/页面都靠 items 的引用变化刷新，补完再推一次
        this.items = [...this.items];
        return;
      }
      const item = targets[i];
      this.fileSizeOf(item.path).then((size) => {
        if (size > 0) item.size = size;
        step(i + 1);
      }, () => {
        step(i + 1);
      });
    };
    step(0);
  }

  /** 下载目录提示：自定义目录优先，否则是默认的公共下载目录 */
  dirHint(): string {
    return this.customDir.length > 0 ? this.customDir : DOWNLOAD_DIR_HINT;
  }

  /** 是否在用自定义下载目录（设置页据此显示「恢复默认」） */
  hasCustomDir(): boolean {
    return this.customDir.length > 0;
  }

  /**
   * 设置自定义下载目录（Android=绝对路径 / 鸿蒙=目录 URI）。空串 = 恢复默认目录。
   * 只影响之后的新下载：已下载记录里的 path 是落盘时的真实路径，改目录不会让它们失效。
   *
   * 必须同时喂回原生层：鸿蒙的原生变量不跨进程也不读 storage，`pickDirectory` 里
   * 设过一次，但「恢复默认 → 再选同一个目录」或冷启动后都依赖这里同步。
   */
  setCustomDir(path: string): void {
    const next = path != null ? path : "";
    this.customDir = next;
    try {
      if (next.length > 0) uni.setStorageSync(DOWNLOAD_DIR_KEY, next);
      else uni.removeStorageSync(DOWNLOAD_DIR_KEY);
    } catch (_) {}
    restoreCustomDir(next);
  }

  /**
   * 把目录参数交给原生落盘：自定义目录非空时忽略 dirType/subDir（原生侧约定）。
   * 三个落盘点（音频 / 封面 / 歌词）共用，保证附属文件跟音频同目录。
   */
  private dirArgs(): string {
    return this.customDir;
  }

  setDownloadQuality(q: string): void {
    this.downloadQuality = q;
    try {
      uni.setStorageSync(DOWNLOAD_QUALITY_KEY, q);
    } catch (_) {}
  }

  setDownloadNameFormat(fmt: string): void {
    if (fmt != "song" && fmt != "artist") return;
    this.downloadNameFormat = fmt;
    try {
      uni.setStorageSync(DOWNLOAD_NAME_FORMAT_KEY, fmt);
    } catch (_) {}
  }

  /**
   * 设置同时下载数。调小不打断在途任务——已经发出去的请求硬断只会白费流量，
   * 让它们跑完，之后按新上限放行（pump 只补差额，不撤已发的）。
   */
  setConcurrency(value: number): void {
    let n = Math.round(value);
    if (n < DOWNLOAD_CONCURRENCY_MIN) n = DOWNLOAD_CONCURRENCY_MIN;
    if (n > DOWNLOAD_CONCURRENCY_MAX) n = DOWNLOAD_CONCURRENCY_MAX;
    this.concurrency = n;
    try {
      uni.setStorageSync(DOWNLOAD_CONCURRENCY_KEY, n.toString());
    } catch (_) {}
    // 调大后立刻补发排队中的任务
    this.pump();
  }

  concurrencyText(): string {
    return this.concurrency + " 个";
  }

  private save(): void {
    try {
      const arr: string[] = [];
      for (let index = 0; index < this.items.length; index++) {
        const item = this.items[index];
        // 第三段是字节数（老记录没有这一段，读的时候按 0 处理）
        arr.push(songToJson(item.song) + "||" + item.path + "||" + item.size);
      }
      uni.setStorageSync(DOWNLOAD_KEY, JSON.stringify(arr));
    } catch (_) {}
  }

  isDownloaded(song: Song): boolean {
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index];
      if (item.song.id == song.id && item.song.platform == song.platform)
        return true;
    }
    return false;
  }

  find(song: Song): DownloadItem | null {
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index];
      if (item.song.id == song.id && item.song.platform == song.platform)
        return item;
    }
    return null;
  }

  remove(song: Song): void {
    const next: DownloadItem[] = [];
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index];
      if (!(item.song.id == song.id && item.song.platform == song.platform))
        next.push(item);
    }
    this.items = next;
    this.save();
    qtShowToast({ title: "已删除下载", icon: "none" });
  }

  clear(): void {
    if (this.items.length == 0) return;
    this.items = [];
    this.save();
    qtShowToast({ title: "已清空下载", icon: "none" });
  }

  isQueued(song: Song): boolean {
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.song.id == song.id && task.song.platform == song.platform)
        return true;
    }
    return false;
  }

  has(song: Song): boolean {
    return this.isDownloaded(song) || this.isQueued(song);
  }

  /**
   * 入队一首。`silent = true` 时不弹「已在下载列表 / 已加入下载队列」：
   * 批量下载由调用方汇总成**一条**回执（与 PC BatchBar 同口径——动作回执走全局
   * 右上角轻提示，逐首弹会把屏幕刷满，且文案长短不一会推挤操作条）。
   * 返回是否真正入队（false = 已下载或已在队列）。
   */
  enqueue(song: Song, silent: boolean = false): boolean {
    // 本地歌曲（扫描/导入的手机文件）没有远端音源可下：提示后不入队
    if (song.platform == "local") {
      if (!silent) qtShowToast({ title: "本地歌曲已在手机里，无需下载", icon: "none" });
      return false;
    }
    if (this.has(song)) {
      if (!silent) qtShowToast({ title: "已在下载列表", icon: "none" });
      return false;
    }
    this.tasks = [
      ...this.tasks,
      {
        song,
        status: "pending",
        path: "",
        error: "",
        progress: 0,
        doneBytes: 0,
        totalBytes: 0,
        speed: 0,
        lastBytes: 0,
        retryCount: 0,
        retryAt: 0,
        cancelled: false,
        runId: 0,
        abortHandle: null,
      },
    ];
    if (!silent) qtShowToast({ title: "已加入下载队列", icon: "none" });
    this.saveTasks();
    this.pump();
    return true;
  }

  /**
   * 批量入队。并发数**不抬高**：音源 CDN 按 IP 限流，短时间发几十条连接会被当成
   * 爬虫（PC 侧同一条判断），所以仍走 concurrency 闸门，只是把任务一次性摆进队列。
   * `pump()` 自带 `pumping` 防重入，循环里逐首调也不会并发失控。
   * 返回实际入队数与跳过数（已下载 / 已在队列），由调用方拼回执文案。
   */
  enqueueMany(songs: Song[]): QtBatchEnqueueResult {
    let added = 0;
    for (let index = 0; index < songs.length; index++) {
      if (this.enqueue(songs[index], true)) added++;
    }
    return { added, skipped: songs.length - added };
  }

  retry(song: Song): void {
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.song.id == song.id && task.song.platform == song.platform) {
        task.status = "pending";
        task.error = "";
        // 手动重试视为重新开始：清零自动重试计数与退避，否则会被立刻判成超限
        task.retryCount = 0;
        task.retryAt = 0;
        task.cancelled = false;
        this.resetSpeed(task);
        // 手动重试＝**重新开始**：上一次的半截文件可能是换了音源（链接签了别的
        // 文件）、换了音质（320k 与无损的总长不同）或中途被打断的坏数据，接着
        // 续传只会把两种编码拼进同一个文件。用户 2026-10-20 明确要求「重试要
        // 删掉之前下载的部分」。暂停后的「继续」走 resume()，那条路保留断点。
        this.clearPart(task.song);
      }
    }
    this.saveTasks();
    this.pump();
  }

  /**
   * 从队列移除任务。在途任务没法可靠 abort（uni.downloadFile 的 abort 在部分
   * 平台是空实现），所以标记 cancelled：下载回来后在落盘前检查并丢弃，
   * 既不污染已下载列表，也不会让队列卡死。
   */
  removeTask(song: Song): void {
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.song.id == song.id && task.song.platform == song.platform) {
        if (task.status == "downloading") task.cancelled = true;
        // 取消即弃：续传半截文件一并删掉（保留只会白占空间，恢复也不该带回来）
        this.clearPart(task.song);
      }
    }
    this.tasks = this.tasks.filter(
      (t) => !(t.song.id == song.id && t.song.platform == song.platform)
    );
    this.saveTasks();
  }

  /**
   * 取下一个可启动的任务：跳过未到退避时间的、已取消的。
   * 找不到就返回 null（pump 据此结束本轮）。
   */
  private findPending(): DownloadTask | null {
    const now = Date.now();
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.status != "pending" || task.cancelled) continue;
      if (task.retryAt > now) continue;
      return task;
    }
    return null;
  }

  /** 退避期间还有等待中的任务：安排一次延迟 pump，否则队列会一直停着 */
  private scheduleRetryPump(): void {
    const now = Date.now();
    let earliest = 0;
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.status != "pending" || task.cancelled || task.retryAt <= now) continue;
      if (earliest == 0 || task.retryAt < earliest) earliest = task.retryAt;
    }
    if (earliest == 0) return;
    const delay = earliest - now + 50;
    setTimeout(() => {
      this.pump();
    }, delay > 0 ? delay : 50);
  }

  /**
   * 并发闸门：把在途任务补到 concurrency 为止。所有会让队列前进的事件
   * （入队 / 完成 / 失败 / 手动重试 / 并发数变更）都调它，自身防重入。
   */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active < this.concurrency) {
        const task = this.findPending();
        if (task == null) break;
        task.status = "downloading";
        this.active = this.active + 1;
        this.tasks = [...this.tasks];
        this.runTask(task);
      }
      this.scheduleRetryPump();
    } finally {
      this.pumping = false;
    }
    // 有在途任务就保证采样器在跑（幂等）；一个都没起就让它自己停
    if (this.active > 0) this.startSpeedTimer();
    else this.stopSpeedTimer();
  }

  /** 跑一个任务；无论成败都要归还闸门名额并再次 pump */
  private runTask(task: DownloadTask): void {
    // 代次 +1：本次传输的身份证。暂停后旧传输的进度/落盘检查都会因代次
    // 不匹配被丢弃，即使 abort 是空实现、旧传输拖到新传输开始后才回来
    task.runId = task.runId + 1;
    const myRun = task.runId;
    this.runTaskInner(task, myRun).then(
      () => {
        this.active = this.active - 1;
        this.pump();
      },
      () => {
        this.active = this.active - 1;
        this.pump();
      },
    );
  }

  private async runTaskInner(task: DownloadTask, myRun: number): Promise<void> {
    try {
      let url = task.song.url;
      // 歌曲上带的地址可能已过期（平台链接带时效签名），过期/为空就重新取址再下载。
      // 重新取址时把默认音质钳到该源声明可用的档位（v5 契约，如 B 站无真
      // 无损、想要 flac 会自动落到 320），不支持的档位不再发无效请求。
      const wanted = musicApi.clampQualityFor(task.song.platform, this.downloadQuality);
      // 只认 http(s)：歌曲上的 url 可能是本地落盘路径（这首歌从「已下载」列表
      // 播放过，播放器把文件路径写回了 song.url），而 isPlayUrlStale 对非网络
      // 地址一律返回 false（对播放是对的，对下载是错的），所以必须自己判一次，
      // 否则会把 /storage/... 当下载地址发给 uni.downloadFile → "invalid URL"
      if (!isRemoteUrl(url) || isPlayUrlStale(task.song)) {
        // playUrl 的异常是**播放口径**的（弱网「网络较慢，正在重试」、坏歌
        // 「该歌曲暂时无法播放」），直接透传到下载列表会让人以为点错了按钮
        // ——用户要的是「为什么没下下来」，所以这里换成下载口径的说明。
        try {
          url = await musicApi.playUrl(task.song, wanted);
        } catch (e) {
          // playUrl 只抛两种：弱网「网络较慢，正在重试」与坏歌
          // 「该歌曲暂时无法播放」。分别翻译成下载口径的原因。
          const why = e != null ? e.toString() : "";
          if (why.indexOf("网络") >= 0) {
            throw new Error("网络较慢，取址失败（请稍后重试）");
          }
          throw new Error("取不到下载地址（音源暂无该歌曲资源）");
        }
      }
      // 取址失败（音源没给链接/该档位无资源）就直接说清楚，别把空串丢给
      // uni.downloadFile——底层只会回一句 "invalid URL"，用户看不出原因
      if (!isRemoteUrl(url)) {
        throw new Error("下载地址无效（音源未返回可用链接）");
      }
      // 排查「invalid URL」用：底层只回错误码，不说是哪个地址不合法，
      // 这里把实际交给底层的地址留一行日志（截断，避免日志被长签名撑爆）
      qtDiag("[Download] 取址 " + task.song.platform + ":" + task.song.id + " len=" + url.length +
        " → " + (url.length > 160 ? url.substring(0, 160) + "…" : url));
      // 加密档兜底：老包会给加密地址（mflac/mgg/qmc），宿主无解密契约，不落盘
      if (isEncryptedMediaUrl(url)) {
        throw new Error("该歌曲是加密音频（宿主不支持解密），已跳过");
      }
      // 断点续传：探到总长就按 Range 分块下、逐块追加到私有目录的 .part
      //（暂停/退出重启都从断点继续）；探不到退回一次性整下——暂停即弃。
      // 有断点侧车（.part.meta）时直接采信它记的总长，不再探测：探测本身
      // 就得真起一次下载才读得到 totalBytesExpectedToWrite，abort 又不是
      // 瞬间生效（实测白下 9MB），续传路径必须绕开这笔开销。
      let tempPath = "";
      const dir = partDirOf();
      let total = 0;
      const cached = dir != null ? this.readPartTotal(task.song) : 0;
      if (cached > 0) {
        total = cached;
      } else if (dir != null) {
        total = await this.headTotal(url, task.song.platform);
      }
      // 排查续传是否真的生效：dir 为 null 说明 USER_DATA_PATH 拿不到（整下兜底），
      // total 为 0 说明探不到长度（音源不认 Range 且无断点，也是整下兜底）
      qtDiag("[Download] 续传探测 " + task.song.platform + ":" + task.song.id +
        " dir=" + (dir == null ? "null" : "ok") + " total=" + total +
        " cached=" + cached);
      if (total > 0 && dir != null) {
        this.noteBytes(task, cached, total);
        const assembled = await this.fetchResumable(url, task.song, total, dir, task, myRun);
        // 暂停/移除：.part 已保留在私有目录，静默退出（恢复时续传）
        if (assembled == null) return;
        tempPath = assembled;
      } else {
        task.progress = 0;
        tempPath = await this.fetchToTemp(url, task.song.platform, task, myRun, (progress: number, done: number, total: number) => {
          // 旧传输（暂停/移除后）不再刷进度：新传输在跑时它还在回调会打架
          if (task.cancelled || task.runId != myRun) return;
          this.noteBytes(task, done, total);
          this.setProgress(task, progress);
        });
      }
      // 下载期间被用户移除/暂停：直接丢弃，不落盘、不写已下载列表
      if (task.cancelled || task.runId != myRun) return;
      const savedPath = await this.saveToDisk(tempPath, task.song, url, wanted);
      if (task.cancelled || task.runId != myRun) return;
      // 成品已落盘：清掉续传残留（整下路径没有残留，调用幂等）。
      // **但绝不能删掉成品本身**：续传路径的 tempPath 就是 .part，若 saveFile
      // 在某个平台把文件原地留下、savedFilePath 又指回同一个路径，这里一刀就把
      // 刚下完的 150MB 删了，只留一条指向空文件的「已完成」。
      if (plainPath(savedPath) != plainPath(tempPath)) {
        this.clearPart(task.song);
      } else {
        qtDiag("[Download] 成品与断点同路径，跳过清残留 " + task.song.platform + ":" + task.song.id);
        try {
          uni.getFileSystemManager().unlinkSync(plainPath(tempPath) + ".meta");
        } catch (_) {}
      }
      const song = task.song;
      // 文件大小：先问磁盘（权威，MediaStore 落盘后的真实字节数），
      // 拿不到再用引擎报的字节数兜底（0 = 未知，列表显示占位）
      let size = await this.fileSizeOf(savedPath);
      if (size <= 0) size = task.totalBytes > 0 ? task.totalBytes : task.doneBytes;
      this.items = [
        { song, path: savedPath, time: Date.now(), size },
        ...this.items,
      ];
      this.save();
      task.status = "done";
      task.path = savedPath;
      task.progress = 100;
      // 完成前再刷新一次
      this.tasks = [...this.tasks];
      this.tasks = this.tasks.filter(
        (t) => !(t.song.id == song.id && t.song.platform == song.platform)
      );
      this.saveTasks();
    } catch (e) {
      // 移除/暂停标记或代次被顶掉：静默丢弃，不污染当前状态
      if (task.cancelled || task.runId != myRun) return;
      let message = e != null && (e as Error).message != null
        ? (e as Error).message
        : "";
      // 空信息（底层只给了错误码/异常对象）也要给用户一句能看懂的原因
      if (message.length == 0) message = describeNetError(e);
      // 自动重试：音源取链偶发失败 / 网络抖动居多，退避重试两次再落到 failed
      if (task.retryCount < DOWNLOAD_MAX_RETRY) {
        const delay = DOWNLOAD_RETRY_DELAYS[task.retryCount];
        task.retryCount = task.retryCount + 1;
        task.status = "pending";
        task.error = message;
        task.progress = 0;
        this.resetSpeed(task);
        task.retryAt = Date.now() + (delay != null ? delay : 4000);
        this.tasks = [...this.tasks];
        this.saveTasks();
        return;
      }
      task.status = "failed";
      task.error = message;
      task.progress = 0;
      this.resetSpeed(task);
      // 终态失败＝自动重试已经耗尽，这个断点不会再被自动用上了：留着只是白占
      // 空间（150MB 的无损能给用户存半首歌占着）。手动重试本来也会丢残留，
      // 索性在这里一并清掉，避免「下了一半再也没动静」的文件堆在私有目录里。
      this.clearPart(task.song);
      this.tasks = [...this.tasks];
      this.saveTasks();
    }
  }

  /**
   * 进度刷新：**百分比没变就不写**。
   *
   * 进度回调一秒能来几十次（整下路径的 onProgressUpdate、续传路径的每块回调），
   * 每次都 `this.tasks = [...this.tasks]` 会让页面的 taskCount / failedCount /
   * pausedCount / pausableCount / hasAny 五个 computed 和 allItems 全部作废，
   * 整个 list-view 跟着重渲染 —— 这是下载管理卡顿的根因；卡到触摸事件被丢时，
   * 「全部暂停 / 全部取消」看起来就是点了没反应。
   *
   * 只按整数百分比去重：界面显示的就是 Math.round(progress) + '%'，
   * 同一百分点内重复刷新对用户没有任何可见差别。
   */
  private setProgress(task: DownloadTask, percent: number): void {
    const next = Math.min(99, Math.floor(percent));
    if (next == task.progress) return;
    task.progress = next;
    this.tasks = [...this.tasks];
  }

  /**
   * 记字节数：**只写字段，不碰 this.tasks**。
   *
   * 进度回调一秒能来几十次，和 setProgress 同理——每来一次就 `[...this.tasks]`
   * 会把页面所有 computed 连同 list-view 全部作废（这正是之前卡顿的根因）。
   * 字节数只喂给 1s 采样器，界面上的「速度 / 已下载 / 总大小」由采样器统一刷。
   */
  private noteBytes(task: DownloadTask, done: number, total: number): void {
    if (done >= 0) task.doneBytes = done;
    if (total > 0) task.totalBytes = total;
  }

  /**
   * 速度采样（1s 一次）。**只采样在途任务**：doneBytes 的差就是这一秒的真实
   * 下载量（字节/秒），非在途一律归零——暂停/失败的任务挂着上一秒的速度会
   * 让列表看起来还在跑。
   *
   * 采样完发现没有在途任务就把定时器停掉：空转的 1s 定时器没必要一直跑着。
   */
  private sampleSpeed(): void {
    const now = Date.now();
    const dt = this.lastTickAt > 0 ? now - this.lastTickAt : 1000;
    this.lastTickAt = now;
    let inFlight = 0;
    let changed = false;
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.status == "downloading" && !task.cancelled) {
        inFlight++;
        const delta = task.doneBytes - task.lastBytes;
        const next = dt > 0 && delta > 0 ? Math.floor((delta * 1000) / dt) : 0;
        task.lastBytes = task.doneBytes;
        if (task.speed != next) {
          task.speed = next;
          changed = true;
        }
      } else if (task.speed != 0) {
        task.speed = 0;
        task.lastBytes = task.doneBytes;
        changed = true;
      } else {
        task.lastBytes = task.doneBytes;
      }
    }
    // 1s 一次的重渲染是可以接受的（进度百分比本身就比这更频繁）
    if (changed) this.tasks = [...this.tasks];
    if (inFlight == 0) this.stopSpeedTimer();
  }

  /** 起采样器（幂等）。只在有在途任务时调 */
  private startSpeedTimer(): void {
    if (this.speedTimer != 0) return;
    this.lastTickAt = Date.now();
    this.speedTimer = setInterval(() => {
      this.sampleSpeed();
    }, 1000) as number;
  }

  private stopSpeedTimer(): void {
    if (this.speedTimer == 0) return;
    try {
      clearInterval(this.speedTimer);
    } catch (_) {}
    this.speedTimer = 0;
    this.lastTickAt = 0;
  }

  /** 任务离开在途状态（暂停/移除/失败）时清掉速度与基准，别让列表停在旧速度 */
  private resetSpeed(task: DownloadTask): void {
    task.speed = 0;
    task.lastBytes = task.doneBytes;
  }

  async download(song: Song): Promise<void> {
    this.enqueue(song);
  }

  private fetchToTemp(url: string, platform: string, task: DownloadTask, myRun: number, onProgress?: (progress: number, done: number, total: number) => void): Promise<string> {
    // 并发消费（pump），单个底层挂起会白占一个名额：
    // 整体包一层限时，超时按失败处理让名额归还（runTaskInner 的 catch 会重试或置 failed）
    return new Promise<string>((outerResolve, outerReject) => {
      const timer = setTimeout(() => {
        outerReject(new Error("网络超时（连接太慢或音源限速）"));
      }, DOWNLOAD_TIMEOUT_MS) as number;
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };
      this.fetchToTempOnce(url, platform, task, myRun, onProgress).then(
        (path) => settle(() => outerResolve(path)),
        (err) => settle(() => outerReject(err)),
      );
    });
  }

  private async fetchToTempOnce(url: string, platform: string, task: DownloadTask, myRun: number, onProgress?: (progress: number, done: number, total: number) => void): Promise<string> {
    // 注册表是 Referer 的唯一来源：冷启动直接点下载时可能还没拉过注册表，
    // 先确保就绪再取头，否则会漏发本应带的 Referer（幂等、失败静默）。
    await musicApi.ensureRegistry();
    return new Promise<string>((resolve, reject) => {
      const header = new UTSJSONObject();
      // Referer 由数据包按源声明（music-api 的 refererOf 读注册表能力自述）。
      // 未声明就**不发**该头：老代码在这里给未知源兜底成网易云，等于冒充别的平台，
      // 新音源接入时会被 CDN 判成盗链或取到错内容。
      const referer = musicApi.refererOf(platform as Source);
      if (referer.length > 0) header.set("Referer", referer);
      const downloadTask = uni.downloadFile({
        url,
        header,
        success: (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res.tempFilePath);
          } else {
            reject(new Error(describeHttpStatus(res.statusCode)));
          }
        },
        fail: (error) => {
          logErrV("Download", "下载失败", error);
          reject(new Error(describeNetError(error)));
        },
      });
      // 使用 downloadTask 注册进度回调；句柄挂到任务上，暂停时尽力 abort
      task.abortHandle = downloadTask;
      if (downloadTask && downloadTask.onProgressUpdate) {
        downloadTask.onProgressUpdate((progress) => {
          if (onProgress) {
            // 整下路径拿得到真实字节数：totalBytesWritten / totalBytesExpectedToWrite。
            // 有的源不给 Content-Length（total 为 0），此时只报已写字节。
            const done = progress.totalBytesWritten;
            const total = progress.totalBytesExpectedToWrite;
            onProgress(progress.progress, done, total > 0 ? total : 0);
          }
        });
      }
    });
  }

  /**
   * 推断音频扩展名（含点）
   * 优先取播放直链里的真实后缀，其次按实测档位（actualQuality，链路只给到
   * 320 时不能把 mp3 存成 .flac），再次按下载音质设置推断，最后兜底 .mp3
   */
  private resolveExt(
    url: string,
    tempPath: string,
    song?: Song,
    quality?: string
  ): string {
    const known = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "ape", "wma"];
    const candidates = [url, tempPath];
    for (let i = 0; i < candidates.length; i++) {
      let text = candidates[i];
      if (text == null || text.length == 0) continue;
      // 去掉 query / hash
      const q = text.indexOf("?");
      if (q > 0) text = text.substring(0, q);
      const h = text.indexOf("#");
      if (h > 0) text = text.substring(0, h);
      const dot = text.lastIndexOf(".");
      if (dot < 0 || dot == text.length - 1) continue;
      const ext = text.substring(dot + 1).toLowerCase();
      for (let j = 0; j < known.length; j++) {
        if (known[j] == ext) return "." + ext;
      }
    }
    // 实测档位（v6 取链应答带回，只降不升）：比请求档位可信。
    // 老包/直链复用没带回时为空串，走下面的设置推断兜底。
    // 判无损要看**整组无损档位**（flac / flac24bit / hires / master）：只认
    // flac 会把 flac24bit 的下载存成 .mp3（QQ 等无后缀直链正是这条路径）。
    if (song != null && quality != null && quality.length > 0) {
      const measured = musicApi.actualQualityOf(song, quality);
      if (measured.length > 0) return isLosslessQuality(measured) ? ".flac" : ".mp3";
    }
    if (isLosslessQuality(this.downloadQuality)) return ".flac";
    return ".mp3";
  }

  private saveToDisk(
    tempPath: string,
    song?: Song,
    url?: string,
    quality?: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // 公共目录：通过 MediaStore 写入（Android 10+ 官方方式，Scoped Storage 兼容）
      // 目录固定为 Download/QtDownload/Music，不可修改
      const toPrivateDir = (): void => {
        // 私有目录：saveFile（兜底）
        uni.getFileSystemManager().saveFile({
          tempFilePath: tempPath,
          success: (res) => {
            resolve(res.savedFilePath);
          },
          fail: (error) => {
            logErrV("Download", "保存到私有目录失败", error);
            reject(new Error("保存失败"));
          },
        });
      };
      // 公共目录写入是异步的（要等权限弹窗），所以整条链路改成 Promise 串联。
      // Android 9- 首次下载会在这里弹存储权限；鸿蒙首次下载会弹下载目录权限。
      ensurePublicDirPermission().then((granted) => {
        let name = "music";
        if (song != null) {
          const base = (this.downloadNameFormat == "song"
              ? song.name + " - " + song.singer
              : song.singer + " - " + song.name).replace(/[\\/:*?"<>|]/g, "_");
          name = base.length > 0 ? base : song.id;
        }
        // 文件名必须带真实扩展名，不能写死 .mp3（无损为 .flac 等）
        const fileName = name + this.resolveExt(url != null ? url : "", tempPath, song, quality);
        if (!granted) {
          qtShowToast({ title: "未选择保存目录，已存私有目录", icon: "none" });
          toPrivateDir();
          return;
        }
        saveToPublicMedia(tempPath, "download", fileName, DOWNLOAD_DIR_SUB, this.dirArgs()).then((saved) => {
          if (saved != null && saved.length > 0) {
            qtShowToast({ title: "已保存到公共目录", icon: "none" });
            // 封面 / 歌词落在同一目录、同一基名下（不 await：附带资源失败不能影响
            // 歌曲本身已完成的落盘与「已下载」记录）
            this.saveSidecars(name, song);
            resolve(saved);
            return;
          }
          // 公共目录写入失败：回退私有目录
          qtShowToast({ title: "公共目录写入失败，已存私有目录", icon: "none" });
          toPrivateDir();
        }).catch((e) => {
          logErrV("Download", "保存到公共目录失败", e);
          qtShowToast({ title: "公共目录写入失败，已存私有目录", icon: "none" });
          toPrivateDir();
        });
      }).catch((e) => {
        logErrV("Download", "保存到公共目录失败", e);
        qtShowToast({ title: "公共目录写入失败，已存私有目录", icon: "none" });
        toPrivateDir();
      });
    });
  }

  /**
   * 批量取消全部任务（下载管理「全部取消」）。在途下载没法可靠 abort
   * （uni.downloadFile 的 abort 在部分平台是空实现），所以给在途任务打
   * cancelled 标记、回来后丢弃，与 removeTask 同一套语义。
   * 返回取消的任务数；提示由调用方统一拼，这里不弹 toast。
   */
  cancelAll(): number {
    const count = this.tasks.length;
    if (count == 0) return 0;
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.status == "downloading") task.cancelled = true;
      // 取消即弃：续传半截文件一并删掉
      this.clearPart(task.song);
    }
    this.tasks = [];
    this.saveTasks();
    return count;
  }

  /**
   * 全部重试：把 failed 任务整体复位成 pending（手动重试视为重新开始，
   * 清零退避计数，与 retry() 同口径）。返回重置的任务数；提示由调用方拼。
   */
  retryAllFailed(): number {
    let count = 0;
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.status != "failed") continue;
      task.status = "pending";
      task.error = "";
      task.retryCount = 0;
      task.retryAt = 0;
      task.cancelled = false;
      this.resetSpeed(task);
      // 与单首 retry() 同口径：全部重试也从头下，丢掉上次的半截文件
      this.clearPart(task.song);
      count++;
    }
    if (count > 0) {
      this.saveTasks();
      this.pump();
    }
    return count;
  }

  /**
   * 批量删除已下载记录（下载管理「批量删除」，单个也走这里）。
   * alsoDeleteFiles=true 时连同磁盘文件一起删：下载记录只持久化了绝对路径
   * （saveToPublicMedia 返回的就是 DATA 路径），走 qt-app-native 的按路径删除。
   * 文件删不掉不阻塞记录删除，由返回值分开计数，提示由调用方拼。
   */
  removeMany(songs: Song[], alsoDeleteFiles: boolean): QtBatchRemoveResult {
    const paths: string[] = [];
    const next: DownloadItem[] = [];
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index];
      let hit = false;
      for (let j = 0; j < songs.length; j++) {
        if (songs[j].id == item.song.id && songs[j].platform == item.song.platform) {
          hit = true;
          break;
        }
      }
      if (hit) {
        if (item.path != null && item.path.length > 0) paths.push(item.path);
      } else {
        next.push(item);
      }
    }
    const result: QtBatchRemoveResult = {
      removed: this.items.length - next.length,
      filesDeleted: 0,
      filesFailed: 0,
    };
    this.items = next;
    this.save();
    if (alsoDeleteFiles && paths.length > 0) {
      try {
        const r = deleteMediaByPath(paths);
        result.filesDeleted = r.deleted;
        result.filesFailed = r.failed;
      } catch (e) {
        logErrV("Download", "批量删除文件失败", e);
        result.filesFailed = paths.length;
      }
      // 侧车（封面/歌词）单独删，且不影响计数：没下过就什么都不做
      for (let i = 0; i < paths.length; i++) this.deleteSidecars(paths[i]);
    }
    return result;
  }

  /**
   * 未完成任务队列落盘（pending/failed；在途的按 pending 记）。progress 不记：
   * uni.downloadFile 没有断点续传，重启后只能从头下，进度归零才是真实状态。
   * 只在结构变化时写（入队/重试/移除/完成/失败/取消），进度回调不写。
   */
  private saveTasks(): void {
    try {
      const arr: string[] = [];
      for (let index = 0; index < this.tasks.length; index++) {
        const task = this.tasks[index];
        if (task.status == "done") continue;
        const status = task.status == "failed"
          ? "failed"
          : task.status == "paused"
            ? "paused"
            : "pending";
        let text = songToJson(task.song) + "||" + status;
        if (status == "failed" && task.error.length > 0) text = text + "||" + task.error;
        arr.push(text);
      }
      uni.setStorageSync(DOWNLOAD_TASKS_KEY, JSON.stringify(arr));
    } catch (_) {}
  }

  /**
   * 重启后恢复未完成任务队列。落盘时在途已归一成 pending：没有断点续传，
   * 恢复出来的任务一律从头下；failed 连同错误文案一起恢复，等用户手动重试。
   * **恢复后一律停着（paused），不自动续传**——「退出 App 就该暂停下载」是明确
   * 需求，硬杀后台时 onHide 不保证执行，所以这里才是那条硬保证。
   */
  private restoreTasks(): void {
    try {
      const raw = uni.getStorageSync(DOWNLOAD_TASKS_KEY) as string;
      if (raw.length == 0) return;
      const arr = JSON.parse(raw) as string[];
      const restored: DownloadTask[] = [];
      for (let index = 0; index < arr.length; index++) {
        const text = arr[index] as string;
        const sep = text.indexOf("||");
        if (sep <= 0) continue;
        const song = songFromJson(text.substring(0, sep));
        if (song == null) continue;
        let statusText = text.substring(sep + 2);
        let error = "";
        const sep2 = statusText.indexOf("||");
        if (sep2 >= 0) {
          error = statusText.substring(sep2 + 2);
          statusText = statusText.substring(0, sep2);
        }
        // 已下载/已在队列里的不重复恢复（旧数据兜底）
        if (this.isDownloaded(song) || this.isQueued(song)) continue;
        restored.push({
          song,
          // 除 failed 外一律恢复成 paused：**退出 App（含直接杀后台）必须暂停下载**。
          // 落盘时在途任务已被归一成 pending，而杀后台时 onHide 不保证执行，
          // 所以「恢复即 paused」是唯一能覆盖硬杀的兜底——重启后不会自己跑起来，
          // 要用户点「全部继续」才继续。
          status: statusText == "failed" ? "failed" : "paused",
          path: "",
          error,
          progress: 0,
          // 字节数不落盘（重启后要重新探测），恢复出来一律清零
          doneBytes: 0,
          totalBytes: 0,
          speed: 0,
          lastBytes: 0,
          retryCount: 0,
          retryAt: 0,
          cancelled: false,
          runId: 0,
          abortHandle: null,
        });
      }
      if (restored.length == 0) return;
      // 恢复后**不 pump**：退出 App（含杀后台）就该停着，等用户点「全部继续」。
      this.tasks = [...this.tasks, ...restored];
      this.saveTasks();
    } catch (_) {}
  }

  /**
   * 暂停一个任务（下载管理行的暂停按钮 / 全部暂停）。等待中的直接置 paused
   * （pump 只挑 pending，天然不会被再启动）；在途的打 cancelled + 尽力 abort：
   * Android 上 abort 生效即掐断，空实现平台等它自然下完再按标记丢弃。
   * 名额（active）不提前归还——旧传输 settle 时 runTask 的 then/both 会对账，
   * 提前归还会双扣。副作用：空实现平台上暂停后并发名额要等旧传输结束才空出。
   */
  pause(song: Song): void {
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.song.id == song.id && task.song.platform == song.platform) {
        if (task.status == "downloading") {
          task.cancelled = true;
          try {
            const handle = task.abortHandle;
            if (handle != null) {
              handle.abort();
              task.abortHandle = null;
            }
          } catch (_) {
            // abort 空实现/异常都按标记丢弃兜底
          }
        }
        task.status = "paused";
        task.error = "";
        this.resetSpeed(task);
      }
    }
    this.tasks = [...this.tasks];
    this.saveTasks();
  }

  /**
   * 继续一个已暂停的任务：**保留断点续传**（.part/.meta 一个都不动），只把状态、
   * 进度与重试计数复位，由 fetchResumable 接着已有字节发 Range。
   *
   * 与手动 retry() 的区别就在这里：retry 是「这次下的不对，从头再来」，会把
   * 半截文件丢掉；「暂停→继续」是「先歇会儿」，必须续传，否则一首 150MB 的
   * 无损每暂停一次就要重下 150MB。
   */
  resume(song: Song): void {
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.song.id == song.id && task.song.platform == song.platform) {
        if (task.status != "paused") continue;
        task.status = "pending";
        task.cancelled = false;
        task.error = "";
        task.progress = 0;
        task.retryCount = 0;
        task.retryAt = 0;
        this.resetSpeed(task);
      }
    }
    this.saveTasks();
    this.pump();
  }

  /**
   * 全部暂停：在途（abort + 标记）和等待中的一起置 paused；失败/已暂停的不动。
   * 返回本次暂停数，由调用方拼提示。
   */
  pauseAll(): number {
    let count = 0;
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.status == "downloading") {
        task.cancelled = true;
        try {
          const handle = task.abortHandle;
          if (handle != null) {
            handle.abort();
            task.abortHandle = null;
          }
        } catch (_) {}
        task.status = "paused";
        task.error = "";
        this.resetSpeed(task);
        count++;
      } else if (task.status == "pending") {
        task.status = "paused";
        task.error = "";
        count++;
      }
    }
    if (count > 0) {
      this.tasks = [...this.tasks];
      this.saveTasks();
    }
    return count;
  }

  /** 全部继续：已暂停的一起回到等待中并 pump；返回本次继续数 */
  resumeAll(): number {
    let count = 0;
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.status != "paused") continue;
      task.status = "pending";
      task.cancelled = false;
      task.error = "";
      task.progress = 0;
      task.retryCount = 0;
      task.retryAt = 0;
      count++;
    }
    if (count > 0) {
      this.saveTasks();
      this.pump();
    }
    return count;
  }

  /**
   * 读续传残留里记着的总长（.part.meta 的 total），拿不到返回 0。
   * 有它就不用再探总长：探测必须真起一次下载才能读到 totalBytesExpectedToWrite，
   * 而 abort 不是瞬间生效的（实测在模拟器上会白下 9MB 才停），所以续传路径
   * 必须靠这个侧车文件跳过探测，否则「暂停→继续」每首歌都要重下 9MB。
   *
   * **必须一并校验 .part 现存字节数**：返回值会被当成 total 用，若 .part 实际
   * 大小超过它（侧车与残留对不上、被别的路径改过），调用方会照 total 发 Range
   * 而被服务器回 416。这里对不上就返回 0，让调用方重新探测。
   */
  private readPartTotal(song: Song): number {
    const dir = partDirOf();
    if (dir == null) return 0;
    const partPath = dir + "/" + partKey(song) + ".part";
    // 判「.part 还在不在」而不是「.part 大不大」：fetchResumable 会在写第一块之前
    // 先落一个 0 字节的 .part，此时中断（切后台被杀）断点仍是有效的，
    // 用 partSizeOf <= 0 当守卫会把它当成没有断点，于是又白探一次 9MB。
    if (!this.partExists(partPath)) return 0;
    try {
      const meta = parseJsonToUtso(uni.getFileSystemManager().readFileSync(partPath + ".meta", "utf-8") as string);
      const total = meta.get("total") as number | null;
      if (total == null || total <= 0) return 0;
      const size = this.partSizeOf(partPath);
      if (size < 0 || size > total) return 0;
      return total;
    } catch (_) {}
    return 0;
  }

  /** .part 是否存在（0 字节也算存在，与 partSizeOf 的区别就在这里） */
  private partExists(partPath: string): boolean {
    try {
      const stats = uni.getFileSystemManager().statSync(partPath, false);
      return stats != null && stats.length == 1;
    } catch (_) {}
    return false;
  }

  /** .part 现存字节数；不存在/读不出返回 0（statSync：文件路径返回单元素数组） */
  private partSizeOf(partPath: string): number {
    try {
      const stats = uni.getFileSystemManager().statSync(partPath, false);
      if (stats != null && stats.length == 1) return stats[0].stats.size;
    } catch (_) {}
    return 0;
  }

  /**
   * 成品文件字节数（异步）。**必须异步**：公共目录（MediaStore）里的文件
   * statSync 有时读不到，而下载完成时刚写过一次盘，同步 stat 会卡在 IO 上。
   * 读不到返回 0，调用方用引擎报的字节数兜底。
   */
  private fileSizeOf(filePath: string): Promise<number> {
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
        fail: () => resolve(0),
      });
    });
  }

  /**
   * 清掉某首歌的续传残留（取消 / 完成 / 手动重试 / 终态失败时调用，幂等）。
   *
   * **删完必须复查**：unlinkSync 失败只会抛异常，而这里一贯的写法是
   * `catch (_) {}`（尽力而为，不能因为删不掉就打断落盘），于是「删失败了」
   * 和「本来就没有」完全看不出区别。2026-10-20 真机就出现过
   * 「下载管理显示已完成、私有目录里却留着 150MB .part」的现场——记录写了
   * 完成，残留却还在，用户只能手动去文件管理器清。
   * 所以这里同步删一遍后 statSync 复查：文件还在就改异步 unlink 再补一刀，
   * 并把结果写进诊断日志（是占用、权限还是路径不一致，一看日志就知道）。
   */
  private clearPart(song: Song): void {
    const dir = partDirOf();
    if (dir == null) return;
    const fs = uni.getFileSystemManager();
    const key = partKey(song);
    const partPath = dir + "/" + key + ".part";
    const metaPath = partPath + ".meta";
    try {
      fs.unlinkSync(partPath);
    } catch (_) {}
    // 复查放在删 .meta 之后：两步都不依赖顺序，但复查只盯 .part（占空间的是它）
    if (!this.partExists(partPath)) {
      try {
        fs.unlinkSync(metaPath);
      } catch (_) {}
      return;
    }
    qtDiag("[Download] 续传残留同步删除失败，改异步重试 " + song.platform + ":" + song.id);
    try {
      fs.unlink({
        filePath: partPath,
        success: () => {
          qtDiag("[Download] 续传残留异步删除成功 " + song.platform + ":" + song.id);
        },
        fail: (e) => {
          const why = e != null ? e.toString() : "unknown";
          qtDiag("[Download] 续传残留删除仍失败 " + song.platform + ":" + song.id +
            " 路径=" + partPath + " 原因=" + why);
        },
      });
    } catch (_) {}
    try {
      fs.unlinkSync(metaPath);
    } catch (_) {}
  }

  /**
   * 顺手删掉音频旁边的封面/歌词侧车。**尽力而为**：文件可能压根没下（用户没开
   * 同时下载封面/歌词）、也可能在公共目录里 FS 接口读不到（MediaStore 分区存储），
   * 所以删不掉不算失败，不计入 filesFailed——否则用户会看到「N 个文件未删除」
   * 却怎么删都删不掉。走原生按路径删除，它内部有 MediaStore 反查 + File 兜底。
   */
  private deleteSidecars(audioPath: string): void {
    try {
      deleteMediaByPath(sidecarPathsOf(audioPath));
    } catch (_) {}
  }

  /**
   * 启动清扫孤儿续传残留：目录里已没有对应任务（取消时没删成 / 异常退出）
   * 的 .part/.meta。在恢复队列之后调用，被恢复任务的断点不会误删。
   *
   * 注意：这里同样**不能只删不复查**。旧写法删不掉就静默跳过，于是「上次没删
   * 干净的 150MB」会一直躺在私有目录里、每次启动都试着删一次又静默失败。
   * 现在失败会走异步 unlink 补刀 + 写诊断日志。
   */
  private sweepStaleParts(): void {
    const dir = partDirOf();
    if (dir == null) return;
    try {
      const names = uni.getFileSystemManager().readdirSync(dir);
      if (names == null) return;
      const keys: string[] = [];
      for (let i = 0; i < this.tasks.length; i++) keys.push(partKey(this.tasks[i].song));
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        // 目录里只有我们的 .part / .part.meta；partKey 不含点，第一个 .part 前即键名
        const cut = name.indexOf(".part");
        if (cut <= 0) continue;
        if (keys.indexOf(name.substring(0, cut)) >= 0) continue;
        const target = dir + "/" + name;
        try {
          uni.getFileSystemManager().unlinkSync(target);
        } catch (_) {}
        if (!this.partExists(target)) continue;
        qtDiag("[Download] 清扫残留同步失败，改异步重试 " + name);
        try {
          uni.getFileSystemManager().unlink({
            filePath: target,
            success: () => {
              qtDiag("[Download] 清扫残留异步成功 " + name);
            },
            fail: (e) => {
              const why = e != null ? e.toString() : "unknown";
              qtDiag("[Download] 清扫残留仍失败 " + name + " 原因=" + why);
            },
          });
        } catch (_) {}
      }
    } catch (_) {}
  }

  /**
   * 探测文件总字节数；失败/拿不到返回 0（调用方退回一次性整下）。
   *
   * 只发**不带 Range** 的一次请求。曾经试过「先 Range: bytes=0-0 再兜底」，
   * 实测（2026-10-16 10:47:17 设备日志）服务器确实回了 206，
   * 但 1 字节的响应体根本不会触发 onProgressUpdate，
   * 于是 totalBytesExpectedToWrite 永远读不到、必然兜底到第二次请求——
   * 白多一次往返。而且带 Range 时 totalBytesExpectedToWrite 报的是
   * **本次范围的长度**而不是文件总长，所以 Range 探测在原理上就拿不到总长，已删除。
   */
  private headTotal(url: string, platform: string): Promise<number> {
    return this.probeTotalByDownload(url, platform);
  }

  /**
   * 总长探测。**不能用 uni.request**：实测 Android 上对音源 CDN 发的请求
   * 既不回 success 也不回 fail，只能干等满超时拿 0（每首歌白等 15 秒，
   * 续传因此从未生效）。改用已证实可用的 uni.downloadFile：
   * 不带 Range 时 totalBytesExpectedToWrite 就是完整 Content-Length，
   * 从首个进度回调读到长度后立刻 abort。
   * 代价：abort 不是瞬间生效，实测会白下约 9MB 才停——所以续传路径
   * 靠 .part.meta 侧车跳过探测（见 readPartTotal），每首歌只付一次。
   */
  private probeTotalByDownload(url: string, platform: string): Promise<number> {
    return new Promise<number>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(0);
        }
      }, DOWNLOAD_HEAD_TIMEOUT_MS) as number;
      const done = (n: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(n);
      };
      const header = new UTSJSONObject();
      const referer = musicApi.refererOf(platform as Source);
      if (referer.length > 0) header.set("Referer", referer);
      try {
        const dt = uni.downloadFile({
          url,
          header,
          success: (res) => {
            // 没经过进度回调就结束了：拿不到长度，按探不到处理
            qtDiag("[Download] 探测(下载) 无进度即结束 status=" + res.statusCode);
            done(0);
          },
          fail: (e) => {
            qtDiag("[Download] 探测(下载) 失败 " + describeNetError(e));
            done(0);
          },
        });
        if (dt && dt.onProgressUpdate) {
          dt.onProgressUpdate((p) => {
            // 已判定过就必须立刻返回。abort 不是瞬间生效：实测一次探测的进度回调
            // 能连来上千次（设备日志里出现过**一秒 1065 次**），而下面这行日志
            // 每次都会 console.log + 往日志队列里排一次原生同步写文件。一秒上千次
            // 同步 IO 把 JS 线程占满，下载管理页连按钮都点不动——这才是卡顿的根因。
            if (settled) return;
            const t = p.totalBytesExpectedToWrite;
            // 不带 Range，t 就是完整文件长度
            if (t >= DOWNLOAD_MIN_TOTAL_BYTES) {
              done(t);
              try {
                dt.abort();
              } catch (_) {}
            }
          });
        }
      } catch (e) {
        qtDiag("[Download] 探测(下载) 异常 " + describeNetError(e));
        done(0);
      }
    });
  }

  /**
   * 下一个分块（Range: bytes=start-end）。返回块临时文件；
   * whole=true 表示服务器无视 Range 直接回了整个文件（此时临时文件就是成品）。
   * 进度按「已完成字节 + 块内进度」折算成整体百分比。
   */
  private fetchChunk(
    url: string,
    platform: string,
    start: number,
    end: number,
    total: number,
    doneBytes: number,
    task: DownloadTask,
    myRun: number,
  ): Promise<QtChunkResult> {
    return new Promise<QtChunkResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("网络超时（连接太慢或音源限速）"));
      }, DOWNLOAD_CHUNK_TIMEOUT_MS) as number;
      const header = new UTSJSONObject();
      const referer = musicApi.refererOf(platform as Source);
      if (referer.length > 0) header.set("Referer", referer);
      header.set("Range", "bytes=" + start + "-" + end);
      const dt = uni.downloadFile({
        url,
        header,
        success: (res) => {
          clearTimeout(timer);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            // 200 且带 Range 起点说明服务器没按 Range 来，返回的是整个文件
            resolve({ temp: res.tempFilePath, whole: res.statusCode == 200 && start > 0 });
          } else {
            reject(new Error(describeHttpStatus(res.statusCode)));
          }
        },
        fail: (error) => {
          clearTimeout(timer);
          logErrV("Download", "分块下载失败", error);
          // 416 必须原样带出去：下面 describeNetError 会把它糊成「网络错误」，
          // 上层就认不出「该丢残留重来」和「网络抖动重试」的区别了。
          if (isRangeNotSatisfiable(error)) {
            reject(new Error("续传范围失效（416）"));
            return;
          }
          reject(new Error(describeNetError(error)));
        },
      });
      task.abortHandle = dt;
      if (dt && dt.onProgressUpdate) {
        dt.onProgressUpdate((p) => {
          // 旧代次（暂停/移除后）：立刻掐断，省流量也不刷进度
          if (task.cancelled || task.runId != myRun) {
            try {
              dt.abort();
            } catch (_) {}
            return;
          }
          const chunkBytes = end - start + 1;
          const written = Math.floor((chunkBytes * p.progress) / 100);
          // 字节数只写字段（noteBytes 不触发渲染），界面由 1s 采样器统一刷
          this.noteBytes(task, doneBytes + written, total);
          this.setProgress(task, ((doneBytes + written) * 100) / total);
        });
      }
    });
  }

  /**
   * 断点续传主循环：按 .part 现存量发 Range 分块，逐块追加落盘。
   * .part 旁的 .meta 侧车记 url+总长：URL 会过期重取（同一首歌换新链接很
   * 常见），所以只按总长校验是否同一个文件，对不上就整个重来。
   * 暂停/移除中途退出返回 null（.part 保留，恢复时续传）；
   * 正常走完返回成品文件路径（.part，或服务器无视 Range 时那块的临时文件）。
   */
  private async fetchResumable(
    url: string,
    song: Song,
    total: number,
    dir: string,
    task: DownloadTask,
    myRun: number,
  ): Promise<string | null> {
    const fs = uni.getFileSystemManager();
    const partPath = dir + "/" + partKey(song) + ".part";
    const metaPath = partPath + ".meta";
    try {
      fs.mkdirSync(dir, true);
    } catch (_) {}
    let partSize = 0;
    let metaOk = false;
    try {
      const meta = parseJsonToUtso(fs.readFileSync(metaPath, "utf-8") as string);
      const mTotal = meta.get("total") as number | null;
      if (mTotal != null && mTotal == total) metaOk = true;
    } catch (_) {}
    if (metaOk) partSize = this.partSizeOf(partPath);
    if (!metaOk || partSize > total) {
      // 新文件 / 换过音源 / 异常残留：清掉重来
      try {
        fs.unlinkSync(partPath);
      } catch (_) {}
      try {
        fs.unlinkSync(metaPath);
      } catch (_) {}
      partSize = 0;
    }
    if (partSize == 0) {
      // 建空 .part：appendFileSync 只能往已有文件里追加
      try {
        fs.writeFileSync(partPath, new ArrayBuffer(0));
      } catch (_) {}
    }
    try {
      const meta = new UTSJSONObject();
      meta.set("url", url);
      meta.set("total", total);
      fs.writeFileSync(metaPath, JSON.stringify(meta));
    } catch (_) {}
    // 继续时先把断点百分比刷回界面
    this.noteBytes(task, partSize, total);
    this.setProgress(task, (partSize * 100) / total);
    qtDiag("[Download] 续传开始 " + song.platform + ":" + song.id +
      " 已有=" + partSize + " 总长=" + total + " 块=" + DOWNLOAD_CHUNK_BYTES);
    while (partSize < total) {
      // 暂停/移除：带着已有 .part 静默退出（pause 的语义就是保留断点）
      if (task.cancelled || task.runId != myRun) return null;
      const start = partSize;
      const end = Math.min(start + DOWNLOAD_CHUNK_BYTES, total) - 1;
      let chunk: QtChunkResult;
      try {
        chunk = await this.fetchChunk(url, song.platform, start, end, total, partSize, task, myRun);
      } catch (e) {
        // 416：侧车记的总长与这次新链接的实际大小对不上，重试同一段永远是 416。
        // 清掉残留后**抛出去**（不能 return null——那是「暂停/已移除」的语义，
        // 会让任务静默消失）：runTaskInner 的 catch 会退避重排一次，重新取址
        // 重新探测总长，从头下。重试次数仍受 DOWNLOAD_MAX_RETRY 约束，不会死循环。
        if (isRangeNotSatisfiable(e)) {
          qtDiag("[Download] 续传范围失效(416) " + song.platform + ":" + song.id +
            " 断点=" + partSize + " 记的总长=" + total + " → 丢弃残留重新探测");
          try {
            fs.unlinkSync(partPath);
          } catch (_) {}
          try {
            fs.unlinkSync(metaPath);
          } catch (_) {}
          throw new Error("续传范围失效（416：链接换了文件，已重新开始）");
        }
        throw e;
      }
      if (task.cancelled || task.runId != myRun) {
        try {
          fs.unlinkSync(plainPath(chunk.temp));
        } catch (_) {}
        return null;
      }
      if (chunk.whole) {
        // 服务器不认 Range：这块临时文件就是完整成品，丢掉 .part 直接用
        try {
          fs.unlinkSync(partPath);
        } catch (_) {}
        try {
          fs.unlinkSync(metaPath);
        } catch (_) {}
        return chunk.temp;
      }
      const chunkPath = plainPath(chunk.temp);
      // 不传 encoding 读出 ArrayBuffer，再整体追加到 .part 尾部
      const wrote = await this.appendChunkToPart(chunkPath, partPath);
      try {
        fs.unlinkSync(chunkPath);
      } catch (_) {}
      if (wrote <= 0) throw new Error("分块写入失败");
      partSize = partSize + wrote;
      this.noteBytes(task, partSize, total);
      qtDiag("[Download] 分块落盘 " + song.platform + ":" + song.id +
        " 块字节=" + wrote + " 累计=" + partSize + "/" + total);
      this.setProgress(task, (partSize * 100) / total);
    }
    qtDiag("[Download] 续传完成 " + song.platform + ":" + song.id + " 总字节=" + partSize);
    return partPath;
  }

  /**
   * 把下载好的分块追加到 .part 尾部，返回写入字节数。
   *
   * **必须用异步 FS**：分块 2MB，readFileSync + appendFileSync 会把 JS 线程
   * 整个占住（真机实测单块 200～660ms），下载并发几路时界面就一卡一卡的。
   * 异步版本把这两步交给 IO 线程，await 期间界面照常刷新。
   */
  private appendChunkToPart(chunkPath: string, partPath: string): Promise<number> {
    return new Promise((resolve) => {
      const fs = uni.getFileSystemManager();
      fs.readFile({
        filePath: chunkPath,
        success: (res) => {
          const data = res.data as ArrayBuffer;
          fs.appendFile({
            filePath: partPath,
            data,
            success: () => resolve(data.byteLength),
            fail: () => resolve(0),
          });
        },
        fail: () => resolve(0),
      });
    });
  }

  /** 开关文案（设置页右侧） */
  downloadCoverText(): string {
    return this.downloadCover ? "已开启" : "已关闭";
  }

  downloadLyricText(): string {
    return this.downloadLyric ? "已开启" : "已关闭";
  }

  setDownloadCover(on: boolean): void {
    this.downloadCover = on;
    try {
      uni.setStorageSync(DOWNLOAD_COVER_KEY, on ? "1" : "0");
    } catch (_) {}
  }

  setDownloadLyric(on: boolean): void {
    this.downloadLyric = on;
    try {
      uni.setStorageSync(DOWNLOAD_LYRIC_KEY, on ? "1" : "0");
    } catch (_) {}
  }

  setDeleteFileOnRemove(on: boolean): void {
    this.deleteFileOnRemove = on;
    try {
      uni.setStorageSync(DOWNLOAD_DELETE_FILE_KEY, on ? "1" : "0");
    } catch (_) {}
  }

  /**
   * 歌曲落盘成功后的附带资源（封面 / 歌词）。baseName 与音频同一基名，
   * 落进同一公共子目录，这样文件管理器里「歌手 - 歌名.mp3/.lrc/.jpg」是挨着的。
   * 全程不抛：附带资源失败只记诊断日志，绝不回滚已完成的正片。
   */
  private saveSidecars(baseName: string, song?: Song): void {
    if (song == null) return;
    if (this.downloadCover) this.saveCoverSidecar(baseName, song).catch(() => {});
    if (this.downloadLyric) this.saveLyricSidecar(baseName, song).catch(() => {});
  }

  /** 封面：先下到临时文件再交给原生写公共目录（不改动 song.picUrl） */
  private async saveCoverSidecar(baseName: string, song: Song): Promise<void> {
    if (song.picUrl.length == 0) return;
    const temp = await new Promise<string>((resolve) => {
      uni.downloadFile({
        url: song.picUrl,
        success: (res) => {
          if (res.statusCode == 200 && res.tempFilePath.length > 0) resolve(res.tempFilePath);
          else resolve("");
        },
        fail: (e) => {
          qtDiag("[Download] 封面下载失败 " + song.platform + ":" + song.id + " " + describeNetError(e));
          resolve("");
        },
      });
    });
    if (temp.length == 0) return;
    try {
      await saveToPublicMedia(temp, "download", baseName + coverExtOf(song.picUrl), DOWNLOAD_DIR_SUB, this.dirArgs());
    } catch (e) {
      logErrV("Download", "封面写公共目录失败", e);
    }
  }

  /**
   * 歌词：bundle 返回的是文本，原生插件只吃文件路径，所以先写私有目录的临时
   * .lrc 再搬进公共目录，最后删掉临时文件。取不到歌词（纯音乐 / 音源没有资源）
   * 就静默跳过——这不该让用户看到一条失败。
   */
  private async saveLyricSidecar(baseName: string, song: Song): Promise<void> {
    const temp = lyricTempPath(song);
    if (temp == null) return;
    let text = "";
    try {
      text = await musicApi.lyrics(song);
    } catch (e) {
      qtDiag("[Download] 歌词获取失败 " + song.platform + ":" + song.id + " " + describeNetError(e));
      return;
    }
    if (text.length == 0) return;
    const fs = uni.getFileSystemManager();
    try {
      fs.writeFileSync(temp, text, "utf-8");
    } catch (e) {
      logErrV("Download", "写歌词临时文件失败", e);
      return;
    }
    try {
      const saved = await saveToPublicMedia(temp, "download", baseName + ".lrc", DOWNLOAD_DIR_SUB, this.dirArgs());
      // 成功也留一条：歌词侧车是「不 await 的附带资源」，失败只落日志，
      // 没有这条就没有任何证据能证明它真的落盘了（排查「歌词没生效」全靠它）。
      if (saved != null && saved.length > 0) {
        qtDiag("[Download] 歌词已保存 " + saved);
      } else {
        logErrV("Download", "歌词写公共目录返回空 " + baseName, null);
      }
    } catch (e) {
      logErrV("Download", "歌词写公共目录失败", e);
    }
    try {
      fs.unlinkSync(temp);
    } catch (_) {}
  }

}

const downloads = reactive(new DownloadsStore()) as DownloadsStore;

export function useDownloadsStore(): DownloadsStore {
  return downloads;
}
