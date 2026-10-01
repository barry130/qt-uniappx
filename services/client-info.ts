/**
 * 统一客户端系统头（单一来源）
 *
 * 凡请求 astral 后端的调用都必须携带下面 4 个头，服务端两条独立链路共用同一份：
 *   - 接口统计：ApiRequestMetricInterceptor → stat_api_hourly（ut / app_version）
 *   - 反馈提交：AppFeedbackController.submit → sys_feedback（platform / app_version / device / os）
 * 字段名、取值与长度上限的权威定义在 astral 后端 `astral-common` 的
 * `com.astral.common.util.ClientHeaders`，改这里必须同步改那边（以及 stat_platform 字典）。
 *
 * | 头名            | 取值                                        | 示例            |
 * | --------------- | ------------------------------------------- | --------------- |
 * | `X-App-Ut`      | app-android / app-ios / app-windows / web   | app-android     |
 * | `X-App-Version` | manifest.json 的 versionName（语义化版本）   | 3.0.1           |
 * | `X-Device`      | 设备型号                                     | Pixel 6         |
 * | `X-OS`          | 操作系统及版本                                | Android 14      |
 *
 * 三条红线：
 *   1. 只给 astral 网关请求加 —— 第三方直链/音源加速探测带上会泄露本机信息；
 *   2. 对象存储预签名上传（media.ts 的 PUT）**绝对不能**带 —— 自定义头会破坏签名校验，
 *      服务端会直接 403 SignatureDoesNotMatch；
 *   3. 空值宁可不写这个头，也不要写空字符串（后端按「未携带」归空串，语义一致）。
 */
import { getCurrentVersionName } from "@/services/app-version";

/** 平台头名 */
export const HEADER_UT = "X-App-Ut";
/** 版本头名 */
export const HEADER_VERSION = "X-App-Version";
/** 设备头名 */
export const HEADER_DEVICE = "X-Device";
/** 系统头名 */
export const HEADER_OS = "X-OS";

/** 平台取值：Android App */
export const CLIENT_UT_ANDROID = "app-android";
/** 平台取值：iOS App */
export const CLIENT_UT_IOS = "app-ios";
/** 平台取值：Windows 桌面端（qt-pc 用） */
export const CLIENT_UT_WINDOWS = "app-windows";
/** 平台取值：Web / H5（管理台用） */
export const CLIENT_UT_WEB = "web";

/** 设备型号长度上限（与 sys_feedback.device 列宽一致） */
const MAX_DEVICE = 128;
/** 系统描述长度上限（与 sys_feedback.os 列宽一致） */
const MAX_OS = 64;

/**
 * 当前客户端平台标识（ut）。
 * 与 upgrade.ts 的 getPlatformType() 同一套条件编译写法（.ts 走 uni-app x 条件编译）。
 */
export function getClientUt(): string {
  // #ifdef APP-ANDROID
  return CLIENT_UT_ANDROID;
  // #endif
  // #ifdef APP-IOS
  return CLIENT_UT_IOS;
  // #endif
  // #ifdef WEB
  return CLIENT_UT_WEB;
  // #endif
  return "";
}

/** 截断到上限（后端还会再截一次；这里截只是别把超长值发出去） */
function clip(value: string, max: number): string {
  return value.length > max ? value.substring(0, max) : value;
}

/** 设备型号（如 Pixel 6 / iPhone 15 Pro）；取不到返回空串 */
export function getClientDevice(): string {
  try {
    const info = uni.getDeviceInfo();
    const model = info.deviceModel;
    if (model != null && model.length > 0) {
      return clip(model, MAX_DEVICE);
    }
  } catch (_) {}
  return "";
}

/** 操作系统及版本（如 Android 14 / iOS 18.2）；取不到返回空串 */
export function getClientOs(): string {
  try {
    const info = uni.getDeviceInfo();
    const osName = info.osName;
    const osVersion = info.osVersion;
    let os = osName != null ? osName : "";
    if (osVersion != null && osVersion.length > 0) {
      os = os.length > 0 ? os + " " + osVersion : osVersion;
    }
    if (os.length > 0) {
      return clip(os, MAX_OS);
    }
  } catch (_) {}
  return "";
}

/**
 * 组装统一客户端系统头；取不到的字段不写（不发空字符串头）。
 * 仅用于 astral 网关请求，URL 归属由调用方判定。
 */
export function buildClientHeaders(): UTSJSONObject {
  const headers = new UTSJSONObject();
  const ut = getClientUt();
  if (ut.length > 0) headers.set(HEADER_UT, ut);
  const version = getCurrentVersionName();
  if (version.length > 0) headers.set(HEADER_VERSION, version);
  const device = getClientDevice();
  if (device.length > 0) headers.set(HEADER_DEVICE, device);
  const os = getClientOs();
  if (os.length > 0) headers.set(HEADER_OS, os);
  return headers;
}

/**
 * 把统一客户端系统头合并进已有 header 集合，已存在的不覆盖（留给调用方特例，如反馈）。
 * 各请求收口点（http.ts / source-update.uts / music-api.ts 的上传）统一调它。
 */
export function mergeClientHeaders(headers: UTSJSONObject): void {
  const client = buildClientHeaders();
  const keys = UTSJSONObject.keys(client);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    if (headers.get(key) != null) continue;
    const value = client.get(key);
    if (value != null) headers.set(key, value);
  }
}
