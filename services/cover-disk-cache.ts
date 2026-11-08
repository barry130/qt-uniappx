import { downloadPublicCover } from "./http";

const inflight = new Map<string, Promise<string>>();
const COVER_INDEX = "qt-media-cover-index";
const COVER_LIMIT = 256;
function cachePath(key: string): string {
  // URI-safe, collision-free UTF-16 hex: native unifile decodes percent escapes.
  if (key.length > 160) return "";
  let encoded = "";
  for (let i = 0; i < key.length; i++) encoded += key.charCodeAt(i).toString(16).padStart(4, "0");
  const root = uni.env.USER_DATA_PATH;
  return root + (root.endsWith("/") ? "" : "/") + "media-cover-v2-" + encoded + ".img";
}
function legacyCachePath(key: string): string {
  return uni.env.USER_DATA_PATH + "/media-cover-" + encodeURIComponent(key) + ".img";
}
export function cachedCoverFile(key: string): string {
  const path = cachePath(key);
  if (path.length == 0) return "";
  const fs = uni.getFileSystemManager();
  try { fs.accessSync(path); return path; } catch (_) {
    // Migrate the former percent-encoded filename through the FS API (not image URI).
    try { fs.copyFileSync(legacyCachePath(key), path); rememberCover(path); return path; } catch (_) { return ""; }
  }
}
/** A decoder rejected this generated cache; keep external/embedded files untouched. */
export function invalidateCachedCover(key: string): void {
  const path = cachePath(key);
  if (path.length == 0) return;
  try { uni.getFileSystemManager().unlinkSync(path); } catch (_) {
    // 静默：缓存已经不存在时无需处理。
  }
  try { uni.getFileSystemManager().unlinkSync(legacyCachePath(key)); } catch (_) {
    // 静默：避免下次又迁回已经解码失败的旧缓存。
  }
}
export async function cacheCoverFile(key: string, url: string): Promise<string> {
  const hit = cachedCoverFile(key);
  if (hit.length > 0) return hit;
  const running = inflight.get(key);
  if (running != null) return running;
  const task = saveCover(key, url);
  inflight.set(key, task);
  try { return await task; } finally { inflight.delete(key); }
}
async function saveCover(key: string, url: string): Promise<string> {
  const path = cachePath(key);
  if (path.length == 0) return "";
  const temp = await downloadPublicCover(url);
  if (temp.length == 0) return "";
  try {
    uni.getFileSystemManager().copyFileSync(temp, path);
    rememberCover(path);
    return path;
  } catch (_) { return ""; }
}

function rememberCover(path: string): void {
  try {
    const raw = uni.getStorageSync(COVER_INDEX) as string;
    const paths = raw != null && raw.length > 0 ? raw.split("\n").filter((p: string): boolean => p != path) : [];
    paths.push(path);
    while (paths.length > COVER_LIMIT) {
      const old = paths.shift()!;
      // 仅清理由本模块生成的私有缓存，不能删除外部文件。
      const root = uni.env.USER_DATA_PATH;
      const prefix = root + (root.endsWith("/") ? "" : "/") + "media-cover-";
      if (old.indexOf(prefix) == 0 || old.indexOf(root + "/media-cover-") == 0) {
        try { uni.getFileSystemManager().unlinkSync(old); } catch (_) {
          // 静默：系统已清理的缓存无需重试。
        }
      }
    }
    uni.setStorageSync(COVER_INDEX, paths.join("\n"));
  } catch (_) {
    // 静默：索引写失败不影响本次封面。
  }
}
