/**
 * Token 管理模块
 * 负责 access token / refresh token 的存储、刷新和自动续期
 */

import { logWarn } from "@/services/logger";

const ACCESS_TOKEN_KEY = "qt-access-token";
const REFRESH_TOKEN_KEY = "qt-refresh-token";
const TOKEN_EXPIRY_KEY = "qt-token-expiry";
/** 当前登录用户 id（收藏缓存归属标记，退出登录不清除，供换号检测） */
const USER_ID_KEY = "qt-user-id";
let sessionEpoch = 0;

/** 登录、退出和换号会使所有旧异步提交失效；正常续期保留会话代次。 */
export function getSessionEpoch(): number { return sessionEpoch; }
export function sessionIsCurrent(epoch: number): boolean { return epoch == sessionEpoch; }

/** Token 信息 */
export interface TokenInfo {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // UNIX 时间戳（毫秒）
}

/** 异步续期开始时捕获的会话身份；提交时必须仍然匹配。 */
export interface AuthSessionSnapshot {
  epoch: number;
  accessToken: string;
  refreshToken: string;
  userId: string;
}

/** 保存 token 信息 */
export function saveTokens(tokens: TokenInfo, renewal = false): void {
  if (!renewal) sessionEpoch++;
  uni.setStorageSync(ACCESS_TOKEN_KEY, tokens.accessToken);
  uni.setStorageSync(REFRESH_TOKEN_KEY, tokens.refreshToken);
  uni.setStorageSync(TOKEN_EXPIRY_KEY, tokens.expiresAt);
}

/** 读取 access token */
export function getAccessToken(): string {
  return (uni.getStorageSync(ACCESS_TOKEN_KEY) as string) || "";
}

/** 读取 refresh token */
export function getRefreshToken(): string {
  return (uni.getStorageSync(REFRESH_TOKEN_KEY) as string) || "";
}

/** 获取 token 过期时间 */
export function getTokenExpiry(): number {
  return (uni.getStorageSync(TOKEN_EXPIRY_KEY) as number) || 0;
}

/** 判断 token 是否已过期 */
export function isTokenExpired(): boolean {
  const expiry = getTokenExpiry();
  if (expiry === 0) return true;
  // 提前 30 秒判断过期，避免边界情况
  return Date.now() + 30000 > expiry;
}

/** 判断 token 是否需要刷新（剩余时间小于 5 分钟） */
export function shouldRefreshToken(): boolean {
  const expiry = getTokenExpiry();
  if (expiry === 0) return true;
  return Date.now() + 5 * 60 * 1000 > expiry;
}

/** 清除所有 token 信息（登出） */
export function clearTokens(): void {
  sessionEpoch++;
  uni.removeStorageSync(ACCESS_TOKEN_KEY);
  uni.removeStorageSync(REFRESH_TOKEN_KEY);
  uni.removeStorageSync(TOKEN_EXPIRY_KEY);
}

/** 保存当前登录用户 id（收藏缓存归属标记） */
export function saveUserId(uid: string): void {
  try {
    uni.setStorageSync(USER_ID_KEY, uid);
  } catch (_) {
    // 登录路径：写不进会让换号检测失灵（收藏缓存可能串号），记日志排查
    logWarn("Auth", "saveUserId 写入失败（uid=" + uid + "）");
  }
}

/** 读取上次登录的用户 id（未登录过返回空串） */
export function getUserId(): string {
  try {
    return (uni.getStorageSync(USER_ID_KEY) as string) || "";
  } catch (_) {
    return "";
  }
}

/** 捕获一次异步认证操作所属的会话。 */
export function captureAuthSession(): AuthSessionSnapshot {
  return {
    epoch: sessionEpoch,
    accessToken: getAccessToken(),
    refreshToken: getRefreshToken(),
    userId: getUserId(),
  };
}

/** 仅当发起续期的会话仍是当前会话且 token 未被并发替换时提交新 token。 */
export function renewTokensIfCurrent(session: AuthSessionSnapshot, tokens: TokenInfo): boolean {
  if (!sessionIsCurrent(session.epoch)) return false;
  if (getAccessToken() != session.accessToken || getRefreshToken() != session.refreshToken) return false;
  saveTokens(tokens, true);
  return true;
}

/** 仅当发起刷新/失效处理的会话仍是当前会话且 token 未被并发替换时清除。 */
export function clearTokensIfCurrent(session: AuthSessionSnapshot): boolean {
  if (!sessionIsCurrent(session.epoch)) return false;
  if (getAccessToken() != session.accessToken || getRefreshToken() != session.refreshToken) return false;
  clearTokens();
  return true;
}

/** 检查是否已登录 */
export function isLoggedIn(): boolean {
  const accessToken = getAccessToken();
  return accessToken.length > 0 && !isTokenExpired();
}

/** 从登录/注册响应中提取 token 信息 */
export function parseTokenResponse(data: UTSJSONObject): TokenInfo | null {
  const token = data.get("token") as string | null;
  const refreshToken = data.get("refreshToken") as string | null;
  if (token == null || token.length === 0) return null;
  // 如果后端返回了 refresh token，使用它；否则用 access token 作为 refresh token（降级方案）
  const refresh = refreshToken != null && refreshToken.length > 0 ? refreshToken : token;
  // 默认 7 天过期（如果后端没有返回过期时间）
  const expiresIn = data.get("expiresIn") as number | null;
  const expiresAt = expiresIn != null ? Date.now() + expiresIn * 1000 : Date.now() + 7 * 24 * 60 * 60 * 1000;
  return {
    accessToken: token,
    refreshToken: refresh,
    expiresAt,
  };
}
