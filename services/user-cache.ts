/**
 * /me 用户信息缓存
 *
 * app/user/me 以前由「我的」相关页面每次 onShow 各自请求，打开一次查一次。
 * 现在的约定：
 *   - 启动时（已登录）后台拉一次写入缓存；登录/注册成功后再拉一次
 *   - 页面展示一律走 meCached()：先读缓存，缓存缺失才联网补拉；
 *     在途去重保证冷启动时页面补拉与启动拉取合并为一次请求
 *   - 退出登录 / 改资料被强制下线 / 设置页清除数据时调 clearCachedMe()
 *
 * 缓存的是 /me 响应的 data 根（user 与 roles 同层，与页面原有消费方式一致）；
 * 持久化键 qt-user-me 存 JSON 串，设置页白名单式清除会连键一起删。
 */

import { accountApi } from "@/services/music-api";
import { getAccessToken, getSessionEpoch, getUserId, sessionIsCurrent } from "@/services/auth";
import { parseJsonToUtso } from "@/services/http";
import { cacheUserAvatar, seedCachedAvatar, clearCachedAvatar } from "@/services/avatar-cache";

const ME_CACHE_KEY = "qt-user-me";

let memoryMe: UTSJSONObject | null = null;
/** 在途请求：启动拉取与页面兜底拉取共用同一个 Promise，避免冷启动双请求 */
let inflight: Promise<UTSJSONObject | null> | null = null;
let cacheEpoch = -1;
let cacheRevision = 0;
let inflightEpoch = -1;
let inflightRevision = -1;
function cacheKey(): string { return ME_CACHE_KEY + ":" + getUserId(); }

export function getCachedMe(): UTSJSONObject | null {
  if (getAccessToken().length == 0) return null;
  if (cacheEpoch != getSessionEpoch()) memoryMe = null;
  if (memoryMe != null) return memoryMe;
  try {
    const raw = uni.getStorageSync(cacheKey()) as string;
    if (raw == null || raw.length === 0) return null;
    // R11/R15：App 端 JSON.parse 产物是普通对象、没有 .get 方法（真机已踩过
    // item.get is not a function）；消费方（qt-profile-overview 等）拿返回值
    // 调 res.get("user") 会抛 TypeError。parseJsonToUtso 全树转 UTSJSONObject。
    const obj = parseJsonToUtso(raw);
    if (obj != null) {
      memoryMe = obj;
      cacheEpoch = getSessionEpoch();
      const user = obj.get("user") as UTSJSONObject | null;
      if (user != null) seedCachedAvatar((user.get("avatar") as string | null) ?? "");
    }
    return obj;
  } catch (_) {
    return null;
  }
}

export function setCachedMe(res: UTSJSONObject): void {
  cacheEpoch = getSessionEpoch();
  memoryMe = res;
  const user = res.get("user") as UTSJSONObject | null;
  if (user != null) cacheUserAvatar((user.get("avatar") as string | null) ?? "");
  try {
    uni.setStorageSync(cacheKey(), JSON.stringify(res));
  } catch (_) {
    // 静默：内存缓存已生效，只丢跨启动缓存，下次刷新即恢复
  }
}

export function clearCachedMe(): void {
  cacheRevision++;
  inflight = null;
  memoryMe = null;
  clearCachedAvatar();
  try {
    uni.removeStorageSync(ME_CACHE_KEY);
    uni.removeStorageSync(cacheKey());
  } catch (_) {
    // 静默：删不掉只留陈旧缓存，重新登录刷新会覆盖
  }
}

/** 上传已改写服务器头像，作废更早的 /me 回执并同步本地资料，避免返回页面后回退旧图。 */
export function updateCachedMeAvatar(url: string): void {
  cacheRevision++;
  inflight = null;
  const cached = getCachedMe();
  const user = cached?.get("user") as UTSJSONObject | null;
  if (cached != null && user != null) {
    user.set("avatar", url);
    setCachedMe(cached);
  }
}

/** 联网拉一次 /me 并写缓存。未登录直接返回 null；失败不抛，返回 null 由调用方兜底 */
export async function refreshMe(): Promise<UTSJSONObject | null> {
  if (getAccessToken().length === 0) return null;
  const pending = inflight;
  const epoch = getSessionEpoch();
  const revision = cacheRevision;
  if (pending != null && inflightEpoch == epoch && inflightRevision == revision) return await pending;
  inflightEpoch = epoch;
  inflightRevision = revision;
  const task = doRefreshMe(epoch, revision);
  inflight = task;
  return await task;
}

async function doRefreshMe(epoch: number, revision: number): Promise<UTSJSONObject | null> {
  try {
    const res = await accountApi.me();
    if (!sessionIsCurrent(epoch) || revision != cacheRevision) return null;
    setCachedMe(res);
    return res;
  } catch (_) {
    return null;
  } finally {
    if (inflightEpoch == epoch && inflightRevision == revision) inflight = null;
  }
}

/** 页面取用户信息：缓存优先，没有才联网拉一次 */
export async function meCached(): Promise<UTSJSONObject | null> {
  const cached = getCachedMe();
  if (cached != null) return cached;
  return await refreshMe();
}
