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
import { getAccessToken } from "@/services/auth";

const ME_CACHE_KEY = "qt-user-me";

let memoryMe: UTSJSONObject | null = null;
/** 在途请求：启动拉取与页面兜底拉取共用同一个 Promise，避免冷启动双请求 */
let inflight: Promise<UTSJSONObject | null> | null = null;

export function getCachedMe(): UTSJSONObject | null {
  if (memoryMe != null) return memoryMe;
  try {
    const raw = uni.getStorageSync(ME_CACHE_KEY) as string;
    if (raw == null || raw.length === 0) return null;
    const obj = JSON.parse(raw) as UTSJSONObject | null;
    if (obj != null) memoryMe = obj;
    return obj;
  } catch (_) {
    return null;
  }
}

export function setCachedMe(res: UTSJSONObject): void {
  memoryMe = res;
  try {
    uni.setStorageSync(ME_CACHE_KEY, JSON.stringify(res));
  } catch (_) {}
}

export function clearCachedMe(): void {
  memoryMe = null;
  try {
    uni.removeStorageSync(ME_CACHE_KEY);
  } catch (_) {}
}

/** 联网拉一次 /me 并写缓存。未登录直接返回 null；失败不抛，返回 null 由调用方兜底 */
export async function refreshMe(): Promise<UTSJSONObject | null> {
  if (getAccessToken().length === 0) return null;
  const pending = inflight;
  if (pending != null) return await pending;
  const task = doRefreshMe();
  inflight = task;
  return await task;
}

async function doRefreshMe(): Promise<UTSJSONObject | null> {
  try {
    const res = await accountApi.me();
    setCachedMe(res);
    return res;
  } catch (_) {
    return null;
  } finally {
    inflight = null;
  }
}

/** 页面取用户信息：缓存优先，没有才联网拉一次 */
export async function meCached(): Promise<UTSJSONObject | null> {
  const cached = getCachedMe();
  if (cached != null) return cached;
  return await refreshMe();
}
