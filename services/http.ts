/**
 * 后端网关 HTTP（轻听 astral）：token 刷新、QtRestResp 解包、JSON 工具。
 *
 * 各音源平台的直连请求（酷我 Cookie/Secret 鉴权、酷狗移动端签名、directRequest 等）
 * 已于 2026-09-19 整体下沉到音源包（qt-pc/src/source-scripts 的 platforms/*.ts，
 * 经 qt-js-engine 的 __qtHost.request 发出），本文件不再保留任何平台实现。
 */
import { API_BASE_URL } from "@/services/config";
export { API_BASE_URL };

export function resolveUrl(path: string): string {
  return path.startsWith("http://") || path.startsWith("https://")
    ? path
    : API_BASE_URL + path;
}

import { getAccessToken, saveTokens, clearTokens, parseTokenResponse, isTokenExpired, shouldRefreshToken } from "./auth";
import { mergeClientHeaders } from "./client-info";

/**
 * 是否为本机配置的 astral 网关请求。
 * 只有这类请求才带 satoken 与统一客户端系统头：外部绝对地址（音源直链、
 * 对象存储预签名 URL、更新包加速地址）带上既有泄露本机信息的风险，
 * 也会让预签名校验失败。
 */
function isAstralUrl(url: string): boolean {
  return API_BASE_URL.length > 0 && url.startsWith(API_BASE_URL);
}

/** 刷新/网关请求显式超时：不依赖平台默认（约 60s），避免刷新挂起期间排队请求一起挂 */
const REFRESH_TIMEOUT_MS = 15000;

// 刷新锁
let isRefreshing = false;
let refreshPromise: Promise<RefreshResult> | null = null;

/** 刷新结果三态：ok=拿到新 token；invalid=后端明确拒绝（refresh token 失效）；
 *  network=网络/网关瞬时故障（token 可能仍有效，不清登录态） */
type RefreshResult = "ok" | "invalid" | "network";
// 等待队列：当 token 刷新时，缓存的请求回调
let pendingRequests: Array<{
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  path: string;
  data: UTSJSONObject;
  method: "GET" | "POST" | "DELETE";
  auth: boolean;
  extraHeaders: UTSJSONObject | null;
}> = [];

/**
 * 尝试刷新 token
 * 调用后端 /user/refresh 接口获取新 token
 * 返回三态：ok（拿到新 token）/ invalid（后端明确拒绝，清除登录态）/
 * network（网络或网关瞬时故障，保留登录态下次再试）
 */
function tryRefreshToken(): Promise<RefreshResult> {
  // 如果已经有刷新中的 promise，复用
  if (refreshPromise !== null) {
    return refreshPromise;
  }
  const refreshToken = uni.getStorageSync("qt-refresh-token") as string;
  if (refreshToken.length === 0) {
    clearTokens();
    uni.removeStorageSync("qt-token");
    return Promise.resolve("invalid");
  }
  // 获取当前 token 用于请求头
  const currentToken = getAccessToken();
  const url = resolveUrl("app/user/refresh");
  const headers = new UTSJSONObject();
  headers.set("Content-Type", "application/json");
  if (currentToken.length > 0) {
    headers.set("satoken", currentToken);
  }
  // 统一客户端系统头：刷新请求也是 astral 请求，同样要带上（否则这段时间的
  // stat_api_hourly 会落成「未携带平台/版本」，在报表里变成一个空洞）。
  if (isAstralUrl(url)) {
    mergeClientHeaders(headers);
  }

  refreshPromise = new Promise<RefreshResult>((resolve) => {
    uni.request({
      url,
      method: "POST",
      data: new UTSJSONObject(),
      header: headers,
      timeout: REFRESH_TIMEOUT_MS,
      success: (response) => {
        // 非 2xx 多为网关瞬时故障（5xx/502 等），refresh token 并未失效：
        // 保留登录态、报网络失败，下次再试；仅 2xx 里的业务拒绝才判定失效
        if (response.statusCode < 200 || response.statusCode >= 300) {
          resolve("network");
          refreshPromise = null;
          return;
        }
        try {
          const body = response.data as UTSJSONObject;
          const code = body.get("code");
          // 业务成功（后端 QtRestResp code=200，兼容网关 code=0）
          if (code != null && ((code as number) === 0 || (code as number) === 200)) {
            const data = body.get("data") as UTSJSONObject | null;
            if (data != null) {
              const tokenInfo = parseTokenResponse(data);
              if (tokenInfo != null) {
                saveTokens(tokenInfo);
                // 兼容旧存储
                uni.setStorageSync("qt-token", tokenInfo.accessToken);
                resolve("ok");
                refreshPromise = null;
                return;
              }
            }
          }
          // 2xx 但业务拒绝：refresh token 确实无效/过期，清除登录态
          clearTokens();
          uni.removeStorageSync("qt-token");
          resolve("invalid");
          refreshPromise = null;
        } catch (_) {
          // 非 JSON 的 2xx 响应体（网关错误页等）：按瞬时故障处理，不清登录态
          resolve("network");
          refreshPromise = null;
        }
      },
      fail: () => {
        // 网络失败（弱网/飞行模式/网关抖动）：不清 token，保留登录态下次再试
        resolve("network");
        refreshPromise = null;
      },
    });
  });
  return refreshPromise;
}

/**
 * 刷新结束后的统一收尾：成功则重试主请求并「排水」等待队列；
 * 失效则清登录态并全队拒绝；网络故障则保留 token、全队按网络错误拒绝。
 * 401 触发的刷新与 apiRequest 主动续期共用，保证任何路径下队列都被排水，
 * 不会出现请求 Promise 永久挂起。
 */
function settleAfterRefresh(
  result: RefreshResult,
  retryNow: () => void,
  reject: (reason: Error) => void,
): void {
  isRefreshing = false;
  const queue = pendingRequests.slice();
  pendingRequests = [];
  if (result === "ok") {
    retryNow();
    for (const req of queue) {
      requestWithRefresh(req.path, req.data, req.method, req.auth, req.resolve, req.reject, false, req.extraHeaders);
    }
  } else if (result === "invalid") {
    clearTokens();
    uni.removeStorageSync("qt-token");
    for (const req of queue) {
      req.reject(new Error("登录状态已失效，请重新登录"));
    }
    reject(new Error("登录状态已失效，请重新登录"));
  } else {
    for (const req of queue) {
      req.reject(new Error("网络请求失败"));
    }
    reject(new Error("网络请求失败"));
  }
}

/**
 * 执行请求，支持 token 自动刷新
 * 当遇到 401 且存在 refreshToken 时，自动刷新后重试
 */
function requestWithRefresh(
  url: string,
  data: UTSJSONObject,
  method: "GET" | "POST" | "DELETE",
  auth: boolean,
  resolve: (value: any) => void,
  reject: (reason: any) => void,
  retry = true,
  extraHeaders: UTSJSONObject | null = null
): void {
  const token = getAccessToken();
  const headers = new UTSJSONObject();
  headers.set("Content-Type", "application/json");
  const astral = isAstralUrl(url);
  // 所有 astral 请求：本地有 satoken 就携带（后端据此识别测试人群、过滤登录可见内容），
  // 不再要求调用方传 auth=true；auth 仅保留「401 自动刷新 + 主动续期」的语义。
  // 外部绝对地址（非 astral 网关）不带，避免把登录态发给第三方。
  if (token.length > 0 && astral) {
    headers.set("satoken", token);
  }
  // 统一客户端系统头（X-App-Ut / X-App-Version / X-Device / X-OS）：凡是 astral 请求
  // 一律上送，反馈与统计共用（契约见 services/client-info.ts）。
  if (astral) {
    mergeClientHeaders(headers);
  }
  // 附加业务自定义头（如反馈提交的扩展字段）；同名可覆盖上面的默认值
  if (extraHeaders != null) {
    const extraKeys = UTSJSONObject.keys(extraHeaders);
    for (let i = 0; i < extraKeys.length; i++) {
      const k = extraKeys[i] as string;
      const v = extraHeaders.get(k);
      if (v != null) headers.set(k, v);
    }
  }

  uni.request({
    url,
    method,
    data,
    header: headers,
    timeout: REFRESH_TIMEOUT_MS,
    success: (response) => {
      console.log("[QT Music API]", url, response.statusCode, response.data);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        // 尝试从响应体提取后端的具体错误信息（如参数校验失败）
        let serverMsg = "";
        try {
          const errBody = response.data as UTSJSONObject;
          const msg = errBody.get("msg") as string | null;
          const msgAlt = msg != null ? msg : (errBody.get("message") as string | null);
          if (msgAlt != null && msgAlt.length > 0) serverMsg = msgAlt;
        } catch (_) {}
        reject(new Error(serverMsg.length > 0 ? serverMsg : "HTTP " + response.statusCode));
        return;
      }
      let body = new UTSJSONObject();
      try {
        body = response.data as UTSJSONObject;
      } catch (_) {
        // 非 JSON 的 2xx 响应体（网关错误页等）：reject 而不是让回调抛错挂起 Promise
        reject(new Error("响应数据格式异常"));
        return;
      }
      const code = body.get("code");
      // 401 未授权：尝试刷新 token
      if (code != null && (code as number) === 401) {
        if (!retry) {
          clearTokens();
          uni.removeStorageSync("qt-token");
          reject(new Error("登录状态已失效"));
          return;
        }
        // 检查是否有 refresh token
        const refreshToken = uni.getStorageSync("qt-refresh-token") as string;
        if (refreshToken.length === 0) {
          clearTokens();
          uni.removeStorageSync("qt-token");
          reject(new Error("登录状态已失效，请重新登录"));
          return;
        }
        // 如果已经在刷新，加入等待队列
        if (isRefreshing) {
          pendingRequests.push({ resolve, reject, path: url, data, method, auth, extraHeaders });
          return;
        }
        // 开始刷新
        isRefreshing = true;
        tryRefreshToken().then((result) => {
          settleAfterRefresh(
            result,
            () => requestWithRefresh(url, data, method, auth, resolve, reject, false, extraHeaders),
            reject,
          );
        }).catch(() => {
          settleAfterRefresh("network", () => {}, reject);
        });
        return;
      }
      // 其他业务错误（后端 QtRestResp：200 成功，300/401 等失败；兼容网关 code=0 约定）
      const codeNum = code != null ? (code as number) : 200;
      if (codeNum !== 0 && codeNum !== 200) {
        // 非 0/200 code 视为业务错误，不触发刷新
        const message = body.get("msg") as string | null;
        const messageAlt = message != null ? message : (body.get("message") as string | null);
        reject(new Error(messageAlt != null ? messageAlt : "请求失败"));
        return;
      }
      const responseData = body.get("data");
      resolve((responseData != null ? responseData : body) as UTSJSONObject);
    },
    fail: (error) => {
      console.log("[QT Music Request Failed]", error);
      reject(new Error("网络请求失败"));
    },
  });
}

export function apiRequest(
  path: string,
  data: UTSJSONObject = new UTSJSONObject(),
  method: "GET" | "POST" | "DELETE" = "GET",
  auth = false,
  extraHeaders: UTSJSONObject | null = null
): Promise<UTSJSONObject> {
  // 如果 token 即将过期，且存在 refresh token，尝试先刷新
  if (auth && shouldRefreshToken()) {
    const refreshToken = uni.getStorageSync("qt-refresh-token") as string;
    if (refreshToken.length > 0) {
      return new Promise((resolve, reject) => {
        // 如果已经在刷新，等待刷新完成后再发起请求
        if (isRefreshing) {
          if (refreshPromise !== null) {
            refreshPromise.then((result) => {
              if (result === "ok") {
                requestWithRefresh(resolveUrl(path), data, method, auth, resolve, reject, false, extraHeaders);
              } else if (result === "network") {
                // 瞬时故障不清登录态：现有 token 可能仍有效，照常发请求
                requestWithRefresh(resolveUrl(path), data, method, auth, resolve, reject, true, extraHeaders);
              } else {
                reject(new Error("登录状态已失效，请重新登录"));
              }
            });
          } else {
            // 没有刷新 promise 但 isRefreshing 为 true，可能是异常状态，直接请求
            requestWithRefresh(resolveUrl(path), data, method, auth, resolve, reject, true, extraHeaders);
          }
          return;
        }
        // 主动刷新：与 401 路径共用统一收尾，保证在途的 401 等待队列被排水
        isRefreshing = true;
        tryRefreshToken().then((result) => {
          settleAfterRefresh(
            result,
            () => requestWithRefresh(resolveUrl(path), data, method, auth, resolve, reject, false, extraHeaders),
            reject,
          );
        }).catch(() => {
          settleAfterRefresh("network", () => {}, reject);
        });
      });
    }
  }
  return new Promise((resolve, reject) => {
    requestWithRefresh(resolveUrl(path), data, method, auth, resolve, reject, true, extraHeaders);
  });
}

// ==================== JSON 工具 ====================
// 将 JSON.parse 返回的普通 JS 对象递归转换为真正的 UTSJSONObject（含 .get/.set）
// 说明：uni-app x 的 JS 运行时中 JSON.parse 返回普通对象（无 .get 方法），
// 但下标访问 obj[key] 在普通对象与 UTSJSONObject 上均可用，此处用下标读取 + set 重建。
function jsonValueToUtso(value: any): any {
  if (value == null) return null;
  if (typeof value == "object") {
    if (Array.isArray(value)) {
      const arr: any[] = [];
      for (let index = 0; index < value.length; index++) {
        arr.push(jsonValueToUtso(value[index]));
      }
      return arr;
    }
    const result = new UTSJSONObject();
    const keys = Object.keys(value);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string;
      result.set(key, jsonValueToUtso(value[key]));
    }
    return result;
  }
  return value;
}

export function parseJsonToUtso(text: string): UTSJSONObject {
  const raw = JSON.parse(text);
  return jsonValueToUtso(raw) as UTSJSONObject;
}
