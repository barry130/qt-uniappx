import { getAccessToken, getSessionEpoch, getUserId, sessionIsCurrent } from "./auth";
import { downloadPublicCover } from "./http";

export const AVATAR_CHANGED_EVENT = "qt-user-avatar-changed";
export const DEFAULT_AVATAR_ASSET = "/static/icon/xxxhdpi.png";
const KEY = "qt-user-avatar-cache-v1";
const RETRY_MS = 30000;
type AvatarRecord = { owner: string; url: string; fileUrl: string; file: string };
let record: AvatarRecord | null = null;
let restored = false;
let revision = 0;
let serial = 0;
let inflight: Promise<void> | null = null;
let inflightKey = "";
let failedKey = "";
let failedAt = 0;
let recoveryKey = "";
let recoveryAt = 0;
let temporarySource = "";

function remoteUrl(value: string): string {
  return /^https?:\/\//.test(value) ? value : "";
}
function filePrefix(): string {
  const root = uni.env.USER_DATA_PATH;
  return root + (root.endsWith("/") ? "" : "/") + "qt-user-avatar-";
}
function ownedFile(path: string): boolean {
  return path.startsWith(filePrefix()) && /^\d+-\d+\.img$/.test(path.substring(filePrefix().length));
}
function removeFile(path: string): void {
  try {
    if (path.length > 0 && ownedFile(path)) uni.getFileSystemManager().unlinkSync(path);
  } catch (_) {
    // 静默：私有缓存已被系统清理时无需重试，不删除外部选图或下载临时文件。
  }
}
function readable(path: string): boolean {
  if (path.length == 0) return false;
  try { uni.getFileSystemManager().accessSync(path); return true; } catch (_) { return false; }
}
function imageSource(path: string): string {
  return path.startsWith("/") ? "file://" + encodeURI(path) : path;
}
function restoreRecord(): void {
  if (restored) return;
  restored = true;
  try {
    const raw = uni.getStorageSync(KEY);
    if (typeof raw != "string" || raw.length == 0) return;
    const value = JSON.parse(raw);
    if (typeof value.owner != "string" || typeof value.url != "string") return;
    record = {
      owner: value.owner, url: remoteUrl(value.url),
      fileUrl: typeof value.fileUrl == "string" ? remoteUrl(value.fileUrl) : "",
      file: typeof value.file == "string" && ownedFile(value.file) ? value.file : "",
    };
  } catch (_) {
    // 静默：损坏或旧格式缓存由下一次 /me 成功后覆盖。
  }
}
function currentRecord(): AvatarRecord | null {
  restoreRecord();
  if (getAccessToken().length == 0 || getUserId().length == 0 || record?.owner != getUserId()) return null;
  return record;
}
function persist(): void {
  try {
    if (record == null) uni.removeStorageSync(KEY);
    else uni.setStorageSync(KEY, JSON.stringify(record));
  } catch (_) {
    // 静默：存储不可用时本次会话仍可显示，下次启动重新补齐。
  }
}
function changed(): void { uni.$emit(AVATAR_CHANGED_EVENT); }

/** 业务保存必须使用远程 URL，不能将头像展示用的 file/unifile 地址提交给服务器。 */
export function getCachedAvatarUrl(): string { return currentRecord()?.url ?? ""; }

/** 同步读取本机图片，首帧不等待 /me 或 CDN。 */
export function getAvatarSource(): string {
  const saved = currentRecord();
  if (saved == null || saved.url.length == 0) return DEFAULT_AVATAR_ASSET;
  if (temporarySource.length > 0) return temporarySource;
  if (readable(saved.file)) return imageSource(saved.file);
  return DEFAULT_AVATAR_ASSET;
}

/** 只从带账号归属的 /me 缓存迁移，旧 qt-avatar 单独一条网址不能证明属于当前账号。 */
export function seedCachedAvatar(url: string): void {
  if (currentRecord() == null) cacheUserAvatar(url);
  else prepareCachedAvatar();
}

/** /me 或上传成功后更新。相同账号先保留旧图片，直到新图片落盘后再切换。 */
export function cacheUserAvatar(url: string, localFile: string = ""): void {
  if (getAccessToken().length == 0 || getUserId().length == 0) return;
  const owner = getUserId();
  const nextUrl = remoteUrl(url);
  const previous = currentRecord();
  if (previous?.url == nextUrl && localFile.length == 0) { prepareCachedAvatar(); return; }
  revision++;
  temporarySource = "";
  if (record != null && (record.owner != owner || nextUrl.length == 0)) removeFile(record.file);
  record = { owner, url: nextUrl, fileUrl: previous?.fileUrl ?? "", file: previous?.file ?? "" };
  if (nextUrl.length == 0) { record.file = ""; record.fileUrl = ""; }
  // 上传完成的原图已在本机，无需为了回显再访问一次网络。
  if (nextUrl.length > 0 && localFile.length > 0) storeFile(localFile);
  persist();
  changed();
  prepareCachedAvatar();
}

function storeFile(source: string): void {
  if (record == null) return;
  let target = "";
  try {
    do {
      target = filePrefix() + Date.now() + "-" + (++serial) + ".img";
    } while (target == record.file || readable(target));
    uni.getFileSystemManager().copyFileSync(source, target);
    const old = record.file;
    record.file = target;
    record.fileUrl = record.url;
    temporarySource = "";
    removeFile(old);
  } catch (_) {
    removeFile(target);
    // 磁盘写入失败仍使用这次下载/选图的临时文件，不能留下空白头像。
    temporarySource = imageSource(source);
  }
}

/** 多页面和启动预热共用一个下载；已缓存的相同 URL 不再下载。 */
export function prepareCachedAvatar(): Promise<void> {
  const saved = currentRecord();
  if (saved == null || saved.url.length == 0) return Promise.resolve();
  if (saved.fileUrl == saved.url && readable(saved.file)) return Promise.resolve();
  if (temporarySource.length > 0) return Promise.resolve();
  const epoch = getSessionEpoch();
  const version = revision;
  const key = epoch + ":" + version + ":" + saved.owner + ":" + saved.url;
  if (inflight != null && inflightKey == key) return inflight;
  if (failedKey == key && Date.now() - failedAt < RETRY_MS) return Promise.resolve();
  inflightKey = key;
  const task = fetchAvatar(saved.owner, saved.url, epoch, version, key);
  inflight = task;
  return task;
}
async function fetchAvatar(owner: string, url: string, epoch: number, version: number, key: string): Promise<void> {
  try {
    const temp = await downloadPublicCover(url);
    if (!sessionIsCurrent(epoch) || version != revision || getUserId() != owner || getAccessToken().length == 0) return;
    if (temp.length == 0) { failedKey = key; failedAt = Date.now(); return; }
    storeFile(temp);
    persist();
    changed();
  } catch (_) {
    failedKey = key;
    failedAt = Date.now();
  } finally {
    if (inflightKey == key) { inflight = null; inflightKey = ""; }
  }
}

/** 解码失败时丢弃坏缓存；短时间只恢复一次，避免默认图和坏图来回闪烁。 */
export function recoverCachedAvatar(source: string): void {
  const saved = currentRecord();
  if (saved == null || source == DEFAULT_AVATAR_ASSET || source != getAvatarSource()) return;
  removeFile(saved.file);
  saved.file = "";
  saved.fileUrl = "";
  temporarySource = "";
  persist();
  changed();
  const key = getSessionEpoch() + ":" + saved.owner + ":" + saved.url;
  if (recoveryKey == key && Date.now() - recoveryAt < RETRY_MS) {
    // 页面 onShow / 多处头像刷新也必须遵守解码失败冷却，不能绕过此处再次下载。
    failedKey = getSessionEpoch() + ":" + revision + ":" + saved.owner + ":" + saved.url;
    failedAt = Date.now();
    return;
  }
  recoveryKey = key;
  recoveryAt = Date.now();
  prepareCachedAvatar();
}

export function clearCachedAvatar(): void {
  restoreRecord();
  revision++;
  if (record != null) removeFile(record.file);
  record = null;
  temporarySource = "";
  persist();
  changed();
}
