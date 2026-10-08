import { reactive } from "vue";
import { musicApi, isPlayUrlStale } from "@/services/music-api";
import type { Source } from "@/services/music-api";
import { parseJsonToUtso } from "@/services/http";
import { saveToPublicMedia, ensurePublicDirPermission } from "@/uni_modules/qt-app-native";
import type { Song } from "@/types/music";

const DOWNLOAD_KEY = "qt-downloads";

export type DownloadItem = {
  song: Song;
  path: string;
  time: number;
};

export type DownloadTask = {
  song: Song;
  status: "pending" | "downloading" | "done" | "failed";
  path: string;
  error: string;
  progress: number;
  /** 已自动重试次数（0 = 还没重试过）；任务不持久化，旧数据无兼容问题 */
  retryCount: number;
  /** 退避到期时间戳：findPending 跳过未到点的任务，避免退避期间被立刻重取 */
  retryAt: number;
  /** 被用户从队列移除的标记：在途任务靠它放弃落盘（uni.downloadFile 无法可靠 abort） */
  cancelled: boolean;
};

/** 单个下载文件的整体限时：防底层挂起占死下载队列 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** 自动重试上限与退避间隔（毫秒）：次数用尽才落到 failed 等用户手动重试 */
const DOWNLOAD_MAX_RETRY = 2;
const DOWNLOAD_RETRY_DELAYS: number[] = [1500, 4000];

const DOWNLOAD_QUALITY_KEY = "qt-download-quality";
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
 * 音乐下载目录（固定，不可修改）：公共 Download/QtDownload/Music
 * 插件 dirType="download" + subDir="QtDownload/Music"
 */
export const DOWNLOAD_DIR_NAME = "公共下载目录";
export const DOWNLOAD_DIR_HINT = "/Download/QtDownload/Music";
export const DOWNLOAD_DIR_SUB = "QtDownload/Music";

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
  /**
   * 在途任务数。并发闸门就靠它 + findPending 的「只取一个」保证不超发：
   * 每个 pump 循环先把在途数补到 concurrency 为止。
   */
  private active = 0;
  /** 防重入：pump 自身是异步的，多个入口同时调只保留一个在跑 */
  private pumping = false;

  restore(): void {
    try {
      const raw = uni.getStorageSync(DOWNLOAD_KEY) as string;
      if (raw.length == 0) return;
      const arr = JSON.parse(raw) as string[];
      const items: DownloadItem[] = [];
      for (let index = 0; index < arr.length; index++) {
        const text = arr[index] as string;
        const sep = text.indexOf("||");
        if (sep <= 0) continue;
        const songText = text.substring(0, sep);
        const path = text.substring(sep + 2);
        const song = songFromJson(songText);
        if (song != null && path.length > 0)
          items.push({ song, path, time: Date.now() });
      }
      this.items = items;
    } catch (_) {
      this.items = [];
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
  }

  /** 下载目录提示（固定） */
  dirHint(): string {
    return DOWNLOAD_DIR_HINT;
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
        arr.push(songToJson(item.song) + "||" + item.path);
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
    uni.showToast({ title: "已删除下载", icon: "none" });
  }

  clear(): void {
    if (this.items.length == 0) return;
    this.items = [];
    this.save();
    uni.showToast({ title: "已清空下载", icon: "none" });
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

  enqueue(song: Song): void {
    if (this.has(song)) {
      uni.showToast({ title: "已在下载列表", icon: "none" });
      return;
    }
    this.tasks = [
      ...this.tasks,
      {
        song,
        status: "pending",
        path: "",
        error: "",
        progress: 0,
        retryCount: 0,
        retryAt: 0,
        cancelled: false,
      },
    ];
    uni.showToast({ title: "已加入下载队列", icon: "none" });
    this.pump();
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
      }
    }
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
      }
    }
    this.tasks = this.tasks.filter(
      (t) => !(t.song.id == song.id && t.song.platform == song.platform)
    );
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
  }

  /** 跑一个任务；无论成败都要归还闸门名额并再次 pump */
  private runTask(task: DownloadTask): void {
    this.runTaskInner(task).then(
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

  private async runTaskInner(task: DownloadTask): Promise<void> {
    try {
      let url = task.song.url;
      // 歌曲上带的地址可能已过期（平台链接带时效签名），过期/为空就重新取址再下载。
      // 重新取址时把默认音质钳到该源声明可用的档位（v5 契约，如 B 站无真
      // 无损、想要 flac 会自动落到 320），不支持的档位不再发无效请求。
      const wanted = musicApi.clampQualityFor(task.song.platform, this.downloadQuality);
      if (url == null || url.length == 0 || isPlayUrlStale(task.song)) {
        url = await musicApi.playUrl(task.song, wanted);
      }
      // 重置进度
      task.progress = 0;
      const tempPath = await this.fetchToTemp(url, task.song.platform, (progress: number) => {
        task.progress = progress;
        // 强制触发响应式更新
        this.tasks = [...this.tasks];
      });
      // 下载期间被用户移除：直接丢弃，不落盘、不写已下载列表
      if (task.cancelled) return;
      const savedPath = await this.saveToDisk(tempPath, task.song, url, wanted);
      if (task.cancelled) return;
      const song = task.song;
      this.items = [
        { song, path: savedPath, time: Date.now() },
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
    } catch (e) {
      if (task.cancelled) return;
      const message = e != null && (e as Error).message != null
        ? (e as Error).message
        : "下载失败";
      // 自动重试：音源取链偶发失败 / 网络抖动居多，退避重试两次再落到 failed
      if (task.retryCount < DOWNLOAD_MAX_RETRY) {
        const delay = DOWNLOAD_RETRY_DELAYS[task.retryCount];
        task.retryCount = task.retryCount + 1;
        task.status = "pending";
        task.error = message;
        task.progress = 0;
        task.retryAt = Date.now() + (delay != null ? delay : 4000);
        this.tasks = [...this.tasks];
        return;
      }
      task.status = "failed";
      task.error = message;
      task.progress = 0;
      this.tasks = [...this.tasks];
    }
  }

  async download(song: Song): Promise<void> {
    this.enqueue(song);
  }

  private fetchToTemp(url: string, platform: string, onProgress?: (progress: number) => void): Promise<string> {
    // 并发消费（pump），单个底层挂起会白占一个名额：
    // 整体包一层限时，超时按失败处理让名额归还（runTaskInner 的 catch 会重试或置 failed）
    return new Promise<string>((outerResolve, outerReject) => {
      const timer = setTimeout(() => {
        outerReject(new Error("下载超时"));
      }, DOWNLOAD_TIMEOUT_MS) as number;
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };
      this.fetchToTempOnce(url, platform, onProgress).then(
        (path) => settle(() => outerResolve(path)),
        (err) => settle(() => outerReject(err)),
      );
    });
  }

  private async fetchToTempOnce(url: string, platform: string, onProgress?: (progress: number) => void): Promise<string> {
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
            reject(new Error("HTTP " + res.statusCode));
          }
        },
        fail: (error) => {
          console.log("[QT Music Download Failed]", error);
          reject(new Error("下载失败"));
        },
      });
      // 使用 downloadTask 注册进度回调
      if (downloadTask && downloadTask.onProgressUpdate) {
        downloadTask.onProgressUpdate((progress) => {
          if (onProgress) {
            onProgress(progress.progress);
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
    // 老包/直链复用没带回时为空串，走下面的设置推断兜底
    if (song != null && quality != null && quality.length > 0) {
      const measured = musicApi.actualQualityOf(song, quality);
      if (measured.length > 0) return measured == "flac" ? ".flac" : ".mp3";
    }
    if (this.downloadQuality == "flac") return ".flac";
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
      try {
        // Android 9- 需要存储权限；未授权时会弹窗，本次先落私有目录
        ensurePublicDirPermission();
        let name = "music";
        if (song != null) {
          const base = (this.downloadNameFormat == "song"
              ? song.name + " - " + song.singer
              : song.singer + " - " + song.name).replace(/[\\/:*?"<>|]/g, "_");
          name = base.length > 0 ? base : song.id;
        }
        // 文件名必须带真实扩展名，不能写死 .mp3（无损为 .flac 等）
        const fileName = name + this.resolveExt(url != null ? url : "", tempPath, song, quality);
        const saved = saveToPublicMedia(tempPath, "download", fileName, DOWNLOAD_DIR_SUB);
        if (saved != null && saved.length > 0) {
          uni.showToast({ title: "已保存到公共目录", icon: "none" });
          resolve(saved);
          return;
        }
        // MediaStore 写入失败：回退私有目录
        uni.showToast({ title: "公共目录写入失败，已存私有目录", icon: "none" });
      } catch (e) {
        console.log("[QT Music SaveToPublicDir Failed]", e != null ? e.toString() : "unknown");
        uni.showToast({ title: "公共目录写入失败，已存私有目录", icon: "none" });
      }
      // 私有目录：saveFile（兜底）
      uni.getFileSystemManager().saveFile({
        tempFilePath: tempPath,
        success: (res) => {
          resolve(res.savedFilePath);
        },
        fail: (error) => {
          console.log("[QT Music SaveFile Failed]", error);
          reject(new Error("保存失败"));
        },
      });
    });
  }
}

const downloads = reactive(new DownloadsStore()) as DownloadsStore;

export function useDownloadsStore(): DownloadsStore {
  return downloads;
}
