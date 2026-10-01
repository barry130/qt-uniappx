import { reactive } from "vue";
import { musicApi, isPlayUrlStale } from "@/services/music-api";
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
};

/** 单个下载文件的整体限时：防底层挂起占死串行下载队列 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const DOWNLOAD_QUALITY_KEY = "qt-download-quality";
/** 下载文件名格式（uni 存储键）：artist=歌手-歌名（默认），song=歌名-歌手 */
const DOWNLOAD_NAME_FORMAT_KEY = "qt-download-name-format";

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
  private processing = false;

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
      { song, status: "pending", path: "", error: "", progress: 0 },
    ];
    uni.showToast({ title: "已加入下载队列", icon: "none" });
    this.processQueue();
  }

  retry(song: Song): void {
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index];
      if (task.song.id == song.id && task.song.platform == song.platform) {
        task.status = "pending";
        task.error = "";
      }
    }
    this.processQueue();
  }

  removeTask(song: Song): void {
    this.tasks = this.tasks.filter(
      (t) => !(t.song.id == song.id && t.song.platform == song.platform)
    );
  }

  private findPending(): DownloadTask | null {
    for (let index = 0; index < this.tasks.length; index++) {
      if (this.tasks[index].status == "pending") return this.tasks[index];
    }
    return null;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (true) {
        const task = this.findPending();
        if (task == null) break;
        task.status = "downloading";
        try {
          let url = task.song.url;
          // 歌曲上带的地址可能已过期（平台链接带时效签名），过期/为空就重新取址再下载
          if (url == null || url.length == 0 || isPlayUrlStale(task.song)) {
            url = await musicApi.playUrl(task.song, this.downloadQuality);
          }
          // 重置进度
          task.progress = 0;
          const tempPath = await this.fetchToTemp(url, task.song.platform, (progress: number) => {
            task.progress = progress;
            // 强制触发响应式更新
            this.tasks = [...this.tasks];
          });
          const savedPath = await this.saveToDisk(tempPath, task.song, url);
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
          this.tasks = this.tasks.filter((t) => t !== task);
        } catch (e) {
          task.status = "failed";
          task.error = e != null && (e as Error).message != null
            ? (e as Error).message
            : "下载失败";
          task.progress = 0;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  async download(song: Song): Promise<void> {
    this.enqueue(song);
  }

  private fetchToTemp(url: string, platform: string, onProgress?: (progress: number) => void): Promise<string> {
    // 下载串行消费（processQueue），一次底层挂起就会占死整个队列：
    // 整体包一层限时，超时按失败处理让队列继续走（processQueue 的 catch 会置 failed）
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

  private fetchToTempOnce(url: string, platform: string, onProgress?: (progress: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const header = new UTSJSONObject();
      if (platform == "qq") header.set("Referer", "https://y.qq.com/");
      else if (platform == "kw") header.set("Referer", "https://www.kuwo.cn/");
      else if (platform == "kg") header.set("Referer", "https://www.kugou.com/");
      else header.set("Referer", "https://music.163.com/");
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
   * 优先取播放直链里的真实后缀，其次按下载音质推断，最后兜底 .mp3
   */
  private resolveExt(url: string, tempPath: string): string {
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
    if (this.downloadQuality == "flac") return ".flac";
    return ".mp3";
  }

  private saveToDisk(tempPath: string, song?: Song, url?: string): Promise<string> {
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
        const fileName = name + this.resolveExt(url != null ? url : "", tempPath);
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
