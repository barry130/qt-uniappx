/**
 * 后端网关 HTTP（轻听 astral）：token 刷新、QtRestResp 解包、JSON 工具。
 *
 * 各音源平台的直连请求（酷我 Cookie/Secret 鉴权、酷狗移动端签名、directRequest 等）
 * 已于 2026-09-19 整体下沉到音源包（qt-pc/src/source-scripts 的 platforms/*.ts，
 * 经 qt-js-engine 的 __qtHost.request 发出），本文件不再保留任何平台实现。
 */
import { API_BASE_URL } from "@/services/config";
export { API_BASE_URL };

/**
 * 拼接口地址。三种形态：
 * - 完整 http(s):// URL：原样返回（预签名直传等第三方地址）。
 * - 以 / 开头的站点绝对路径（后端上传计划返回的 contentPath 形如 /api/v1/...）：
 *   只拼「协议+域名」，不能再拼 API_BASE_URL——否则出现 /api/v1//api/v1/... 双前缀，
 *   网关会当畸形路径拦截（真机实测回 200 纯文本「非法请求：…」）。
 * - 相对路径：拼完整 API_BASE_URL（常规接口走这条）。
 */
export function resolveUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  if (path.startsWith("/")) {
    const schemeEnd = API_BASE_URL.indexOf("//") + 2;
    const originEnd = API_BASE_URL.indexOf("/", schemeEnd);
    const origin = originEnd > 0 ? API_BASE_URL.substring(0, originEnd) : API_BASE_URL;
    return origin + path;
  }
  return API_BASE_URL + path;
}

/** 公共封面下载：不携带账号凭据或 astral 客户端头。 */
export function downloadPublicCover(url: string): Promise<string> {
  return new Promise((resolve) => {
    if (!url.startsWith("https://") && !url.startsWith("http://")) { resolve(""); return; }
    uni.downloadFile({ url, timeout: 15000,
      success: (res) => resolve(res.statusCode == 200 ? res.tempFilePath : ""),
      fail: () => resolve(""),
    });
  });
}

/**
 * 日志用的 URL：去掉 query（? 之后）。
 * 失败日志是 ERROR 级、必落盘且在日志页可见，query 里常带分页/筛选参数
 * （甚至会带搜索词），落盘只保留 path——排障要的路由形状和路径 ID 都在。
 */
function logUrl(url: string): string {
  const q = url.indexOf("?");
  return q >= 0 ? url.substring(0, q) : url;
}

import {
  captureAuthSession,
  clearTokensIfCurrent,
  getAccessToken,
  getRefreshToken,
  parseTokenResponse,
  renewTokensIfCurrent,
  sessionIsCurrent,
  shouldRefreshToken,
} from "./auth";
import type { AuthSessionSnapshot } from "./auth";
import { mergeClientHeaders } from "./client-info";
import { qtDiag } from "./diag";
import { logErrV } from "./logger";

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

// 刷新锁按会话代次生效：旧登录的刷新回调不能清理或驱动新登录的刷新。
let refreshPromise: Promise<RefreshResult> | null = null;
let refreshEpoch = -1;

/** 刷新结果：ok=新 token；invalid=后端明确拒绝；network=瞬时故障；stale=会话已切换 */
type RefreshResult = "ok" | "invalid" | "network" | "stale";
// 等待队列：当 token 刷新时，缓存的请求回调
let pendingRequests: Array<{
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  path: string;
  data: UTSJSONObject;
  method: "GET" | "POST" | "DELETE";
  auth: boolean;
  extraHeaders: UTSJSONObject | null;
  epoch: number;
}> = [];

/**
 * 尝试刷新 token
 * 调用后端 /user/refresh 接口获取新 token
 * 返回 ok（新 token）/ invalid（明确拒绝并清除登录态）/
 * network（瞬时故障，保留登录态）/ stale（旧会话已失效）
 */
function tryRefreshToken(): Promise<RefreshResult> {
  const session = captureAuthSession();
  // 仅复用同一会话的刷新；换号后的旧刷新必须隔离。
  if (refreshPromise !== null && refreshEpoch == session.epoch) {
    return refreshPromise;
  }
  const refreshToken = session.refreshToken;
  if (refreshToken.length === 0) {
    if (clearTokensIfCurrent(session)) {
      uni.removeStorageSync("qt-token");
      return Promise.resolve("invalid");
    }
    return Promise.resolve("stale");
  }
  // 获取当前 token 用于请求头
  const currentToken = session.accessToken;
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

  let task: Promise<RefreshResult>;
  const finish = (result: RefreshResult): void => {
    if (refreshPromise === task && refreshEpoch == session.epoch) {
      refreshPromise = null;
      refreshEpoch = -1;
    }
    resolve(result);
  };
  let resolve: (result: RefreshResult) => void = () => {};
  task = new Promise<RefreshResult>((done) => {
    resolve = done;
    uni.request({
      url,
      method: "POST",
      data: new UTSJSONObject(),
      header: headers,
      timeout: REFRESH_TIMEOUT_MS,
      // 鸿蒙默认 JSON 解析会在 success 前打印非 JSON 错误；在回调内判 HTTP 状态再解析。
      dataType: "text",
      success: (response) => {
        // 非 2xx 多为网关瞬时故障（5xx/502 等），refresh token 并未失效：
        // 保留登录态、报网络失败，下次再试；仅 2xx 里的业务拒绝才判定失效
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish("network");
          return;
        }
        try {
          const body = asUtso(response.data);
          const code = body.get("code");
          // 业务成功（后端 QtRestResp code=200，兼容网关 code=0）
          if (code != null && ((code as number) === 0 || (code as number) === 200)) {
            const data = body.get("data") as UTSJSONObject | null;
            if (data != null) {
              const tokenInfo = parseTokenResponse(data);
              if (tokenInfo != null) {
                if (!renewTokensIfCurrent(session, tokenInfo)) {
                  finish("stale");
                  return;
                }
                // 兼容旧存储；CAS 成功后当前 token 必然仍属于原会话。
                uni.setStorageSync("qt-token", tokenInfo.accessToken);
                finish("ok");
                return;
              }
            }
          }
          // 2xx 但业务拒绝：refresh token 确实无效/过期，清除登录态
          if (clearTokensIfCurrent(session)) {
            uni.removeStorageSync("qt-token");
            finish("invalid");
          } else {
            finish("stale");
          }
        } catch (_) {
          // 非 JSON 的 2xx 响应体（网关错误页等）：按瞬时故障处理，不清登录态
          finish("network");
        }
      },
      fail: () => {
        // 网络失败（弱网/飞行模式/网关抖动）：不清 token，保留登录态下次再试
        finish("network");
      },
    });
  });
  refreshPromise = task;
  refreshEpoch = session.epoch;
  return task;
}

/**
 * 刷新结束后的统一收尾：成功则重试主请求并「排水」等待队列；
 * 失效则清登录态并全队拒绝；网络故障则保留 token、全队按网络错误拒绝。
 * 401 触发的刷新与 apiRequest 主动续期共用，保证任何路径下队列都被排水，
 * 不会出现请求 Promise 永久挂起。
 */
function settleAfterRefresh(
  result: RefreshResult,
  epoch: number,
  retryNow: () => void,
  reject: (reason: Error) => void,
): void {
  const queue: Array<{
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    path: string;
    data: UTSJSONObject;
    method: "GET" | "POST" | "DELETE";
    auth: boolean;
    extraHeaders: UTSJSONObject | null;
    epoch: number;
  }> = [];
  const remaining: typeof pendingRequests = [];
  for (let i = 0; i < pendingRequests.length; i++) {
    const req = pendingRequests[i];
    (req.epoch == epoch ? queue : remaining).push(req);
  }
  pendingRequests = remaining;
  const invalidatedCurrentSession = result == "invalid" &&
    getAccessToken().length == 0 && getRefreshToken().length == 0;
  if (result == "stale" || (!sessionIsCurrent(epoch) && !invalidatedCurrentSession)) {
    for (const req of queue) {
      req.reject(new Error("登录状态已变更，请重试"));
    }
    reject(new Error("登录状态已变更，请重试"));
    return;
  }
  if (result === "ok") {
    retryNow();
    for (const req of queue) {
      requestWithRefresh(req.path, req.data, req.method, req.auth, req.resolve, req.reject, false, req.extraHeaders);
    }
  } else if (result === "invalid") {
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
  const requestSession = captureAuthSession();
  const requestEpoch = requestSession.epoch;
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
    // 保留原始文本到业务回调，避免运行时默认 JSON parse 抢先报错。
    dataType: "text",
    success: (response) => {
      // 整个 success 回调必须兜住异常：success 是 uni.request 的原生回调，
      // 回调里抛出的错误既不会转成 reject、也不会冒泡到任何地方，Promise 就永久悬空。
      // 真机症状就是「请求 200 之后一片安静、页面一直停在骨架」（消息中心即此案）。
      try {
        handleResponse(url, response, data, method, auth, resolve, reject, retry, extraHeaders, requestEpoch, requestSession);
      } catch (e) {
        logErrV("QT Music", "响应处理异常 " + logUrl(url), e);
        reject(new Error("响应处理异常"));
      }
    },
    fail: (error) => {
      // 网络层失败是用户报障里最高频的一类（「什么都刷不出来」），必须落盘：
      // errMsg 里带具体原因（超时 / 域名解析 / 连接被拒），比一句「请求失败」有用得多
      logErrV("QT Music", "请求失败 " + logUrl(url), error);
      reject(new Error("网络请求失败"));
    },
  });
}

// HTTP 响应须是 JSON 对象。文本在这里严格解析；兼容已解析的普通对象与 UTSJSONObject。
// null / 数组 / 标量不能伪装成成功的空对象，异常由各回调按 HTTP/刷新语义收口。
// 供 media.ts 等自定义 uni.request 调用点复用：任何平台下 dataType 的实际行为差异
// （text 不生效、运行时预解析成普通对象）都在这里归一化，调用方不要自己 `as string`。
export function asUtso(raw: any): UTSJSONObject {
  const parsed: any = typeof raw == "string" ? parseJsonToUtso(raw as string) : raw;
  if (parsed == null || typeof parsed != "object" || Array.isArray(parsed)) {
    throw new Error("响应数据格式异常");
  }
  if (typeof parsed.get == "function" && typeof parsed.set == "function") {
    return parsed as UTSJSONObject;
  }
  return jsonValueToUtso(parsed) as UTSJSONObject;
}

function handleResponse(
  url: string,
  response: any,
  data: UTSJSONObject,
  method: string,
  auth: boolean,
  resolve: (value: UTSJSONObject) => void,
  reject: (reason?: any) => void,
  retry: boolean,
  extraHeaders: UTSJSONObject | null,
  requestEpoch: number,
  requestSession: AuthSessionSnapshot,
): void {
  // astral 请求即使 caller 没传 auth，也会自动携带当前 satoken。只要响应
  // 属于旧会话，就不能把旧账号数据交给已切号的新上下文。
  if (isAstralUrl(url) && requestSession.accessToken.length > 0 && !sessionIsCurrent(requestEpoch)) {
    reject(new Error("登录状态已变更，请重试"));
    return;
  }
  // 响应体（含登录态/收藏等用户数据）只进诊断通道，不落常规日志：
  // 发布版全量打印响应体既是噪音也是信息面。这里只记 URL 与状态码——
  // 状态码就足以判断「是网络没通、还是后端 4xx/5xx」，而 URL 能定位到具体接口。
  qtDiag("[QT Music API] " + url + " → " + response.statusCode);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    // 尝试从响应体提取后端的具体错误信息（如参数校验失败）
    let serverMsg = "";
    try {
      const errBody = asUtso(response.data);
      const msg = errBody.get("msg") as string | null;
      const msgAlt = msg != null ? msg : (errBody.get("message") as string | null);
      if (msgAlt != null && msgAlt.length > 0) serverMsg = msgAlt;
    } catch (_) {
      // 静默：提不到后端 msg 就走 HTTP 状态码报错兜底
    }
    reject(new Error(serverMsg.length > 0 ? serverMsg : "HTTP " + response.statusCode));
    return;
  }
  let body = new UTSJSONObject();
  try {
    // 归一化：普通对象 → UTSJSONObject，否则下面每一次 body.get 都会抛错
    body = asUtso(response.data);
  } catch (_) {
    // 非 JSON 的 2xx 响应体（网关错误页等）：reject 而不是让回调抛错挂起 Promise
    reject(new Error("响应数据格式异常"));
    return;
  }
  const code = body.get("code");
  // 401 未授权：尝试刷新 token
  if (code != null && (code as number) === 401) {
    if (!sessionIsCurrent(requestEpoch)) {
      reject(new Error("登录状态已变更，请重试"));
      return;
    }
    // 同一会话的主动续期可能已经换了 token；旧请求直接用新 token 重试。
    if (getAccessToken() != requestSession.accessToken) {
      if (!retry) {
        reject(new Error("登录状态已失效"));
        return;
      }
      requestWithRefresh(url, data, method, auth, resolve, reject, false, extraHeaders);
      return;
    }
    if (!retry) {
      if (clearTokensIfCurrent(requestSession)) uni.removeStorageSync("qt-token");
      reject(new Error("登录状态已失效"));
      return;
    }
    // 检查是否有 refresh token
    const refreshToken = uni.getStorageSync("qt-refresh-token") as string;
    if (refreshToken.length === 0) {
      if (clearTokensIfCurrent(requestSession)) uni.removeStorageSync("qt-token");
      reject(new Error("登录状态已失效，请重新登录"));
      return;
    }
    // 如果已经在刷新，加入等待队列
    if (refreshPromise !== null && refreshEpoch == requestEpoch) {
      pendingRequests.push({ resolve, reject, path: url, data, method, auth, extraHeaders, epoch: requestEpoch });
      return;
    }
    // 开始刷新
    tryRefreshToken().then((result) => {
      settleAfterRefresh(
        result,
        requestEpoch,
        () => requestWithRefresh(url, data, method, auth, resolve, reject, false, extraHeaders),
        reject,
      );
    }).catch(() => {
      settleAfterRefresh("network", requestEpoch, () => {}, reject);
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
      const requestEpoch = captureAuthSession().epoch;
      return new Promise((resolve, reject) => {
        // 主动刷新：与 401 路径共用统一收尾，旧会话的刷新不会被复用。
        tryRefreshToken().then((result) => {
          const invalidatedCurrentSession = result == "invalid" &&
            getAccessToken().length == 0 && getRefreshToken().length == 0;
          if (!sessionIsCurrent(requestEpoch) && !invalidatedCurrentSession) {
            settleAfterRefresh(result, requestEpoch, () => {}, () => {});
            reject(new Error("登录状态已变更，请重试"));
            return;
          }
          if (result == "network") {
            // 瞬时故障不清登录态：当前主动请求仍用旧 token 继续；同时必须
            // 排干与它共享刷新锁的 401 请求，否则它们会永久挂起。
            settleAfterRefresh("network", requestEpoch, () => {}, () => {});
            requestWithRefresh(resolveUrl(path), data, method, auth, resolve, reject, true, extraHeaders);
            return;
          }
          settleAfterRefresh(
            result,
            requestEpoch,
            () => requestWithRefresh(resolveUrl(path), data, method, auth, resolve, reject, false, extraHeaders),
            reject,
          );
        }).catch(() => {
          settleAfterRefresh("network", requestEpoch, () => {}, reject);
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
