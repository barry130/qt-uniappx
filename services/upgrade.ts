/**
 * APP 升级模块统一服务
 * 负责版本检查、升级弹窗触发、直链下载与浏览器跳转分发
 * 渠道：stable 正式版 / beta 测试版
 */
import { accountApi } from "@/services/music-api";
import { apiRequest } from "@/services/http";
import { getAccessToken } from "@/services/auth";
import { getCurrentVersionCode, getCurrentVersionName } from "@/services/app-version";

/** 升级弹窗状态标记（updateType=2 红点提示用） */
const UPGRADE_FLAG_KEY = "qt-upgrade-flag";

/** 更新信息类型（对齐后端 QtAppUpdate 字段，UPDATE_DESIGN.md §2.1①） */
export type AppUpdateInfo = {
  versionCode: number;
  versionName: string;
  versionInfo: string;
  updateType: string; // 1 弹窗 / 2 红点 / 3 无提示
  downloadUrl: string;
  /** 浏览器下载链接（双链接方案新增；可空） */
  browserUrl: string;
  /** 直链是否为 GitHub 链接：1=是（下载前参与加速探测），0=否 */
  isGithub: number;
  /** 废弃字段（downloadMode 已随双链接方案废弃），channel 保留用于 Beta 徽标 */
  channel: string; // stable / beta
  isForce: boolean;
  fileSize: number;
  md5: string;
};

/** 获取平台类型：1101 安卓 / 1102 iOS / 0 其他 */
export function getPlatformType(): number {
  // #ifdef APP-ANDROID
  return 1101;
  // #endif
  // #ifdef APP-IOS
  return 1102;
  // #endif
  return 0;
}

/** 检查是否有新版本（无更新或请求失败返回 null） */
export async function checkAppUpdate(): Promise<AppUpdateInfo | null> {
  const type = getPlatformType();
  if (type === 0) return null;
  try {
    const currentCode = getCurrentVersionCode();
    const data = await accountApi.appUpdate(type, currentCode);
    if (data == null) return null;
    const versionName = data.get("versionName") as string | null;
    if (versionName == null || versionName.length === 0) return null;
    const versionCode = (data.get("versionCode") as number) ?? 0;
    // 客户端再比较一次版本号：只有版本号确实大于当前这一版才算有更新，
    // 避免后端"始终返回最新版"或返回同版/旧版时也误弹更新提示。
    // currentCode 为 0 表示运行时读不到版本信息，此时不做本地拦截，交给后端判断。
    if (currentCode > 0 && versionCode <= currentCode) return null;
    const versionInfo = (data.get("versionInfo") as string) ?? "";
    const updateType = (data.get("updateType") as string) ?? "1";
    const downloadUrl = (data.get("downloadUrl") as string) ?? "";
    const channel = (data.get("channel") as string) ?? "stable";
    const isForceRaw = (data.get("isForce") as number) ?? 0;
    const fileSize = (data.get("fileSize") as number) ?? 0;
    const md5 = (data.get("md5") as string) ?? "";
    const browserUrl = (data.get("browserUrl") as string) ?? "";
    const isGithubRaw = (data.get("isGithub") as number) ?? 0;
    return {
      versionCode,
      versionName,
      versionInfo,
      updateType,
      downloadUrl,
      browserUrl,
      isGithub: isGithubRaw == 1 ? 1 : 0,
      channel,
      isForce: isForceRaw === 1,
      fileSize,
      md5,
    };
  } catch (e) {
    console.log("[Upgrade] 检查更新失败", e);
    return null;
  }
}

/**
 * 校验当前 APP 是否为官方发布版本
 * 调用 /api/v1/app/version/check：官方版本返回成功；非官方版本后端返回错误（如“非官方版本”）会被 reject。
 * 网络异常等不确定情况按“官方”处理，避免误杀正常用户。
 * @returns true=官方/可放行，false=非官方（应提示并退出）
 */
export async function checkOfficialVersion(): Promise<boolean> {
  const type = getPlatformType();
  if (type === 0) return true;
  const currentCode = getCurrentVersionCode();
  const currentName = getCurrentVersionName();
  // 读不到版本信息时按“官方”处理，不拿 0/空版本去校验，避免误杀正常用户
  if (currentCode <= 0 || currentName.length === 0) return true;
  try {
    await accountApi.versionCheck(type, currentCode, currentName);
    return true;
  } catch (e) {
    const msg = (e as any).message as string;
    console.log("[Upgrade] 官方版本校验结果", msg);
    if (msg != null && msg.indexOf("非官方") >= 0) {
      return false;
    }
    // 网络/其他异常：不误杀
    return true;
  }
}

/** 是否已登录（升级弹窗展示与否可依赖登录状态） */
export function isLoggedIn(): boolean {
  const token = getAccessToken();
  return token.length > 0;
}

/**
 * 待处理的升级信息（App.uvue 启动检查 → 首页弹出升级弹窗）。
 * 用 ref 承载：启动检查是异步网络请求，首页挂载早于检查完成，
 * 页面侧 watch 该状态即可在检查完成后弹出，避免竞态丢弹窗。
 */
import { ref } from "vue";
export const pendingUpdateRef = ref<AppUpdateInfo | null>(null);

/** 设置待处理的升级信息 */
export function setPendingUpdate(info: AppUpdateInfo | null): void {
  pendingUpdateRef.value = info;
}

/** 消费并清除待处理的升级信息 */
export function consumePendingUpdate(): AppUpdateInfo | null {
  const info = pendingUpdateRef.value;
  pendingUpdateRef.value = null;
  return info;
}

/** 写入红点/新版本标记 */
export function markUpgradeFlag(versionName: string): void {
  try {
    uni.setStorageSync(UPGRADE_FLAG_KEY, versionName);
  } catch (_) {}
}

/** 清除升级标记 */
export function clearUpgradeFlag(): void {
  try {
    uni.removeStorageSync(UPGRADE_FLAG_KEY);
  } catch (_) {}
}

/** 读取升级标记（关于页红点/新版本提示用） */
export function getUpgradeFlag(): string {
  try {
    const v = uni.getStorageSync(UPGRADE_FLAG_KEY) as string;
    return v != null ? v : "";
  } catch (_) {
    return "";
  }
}

/** 格式化文件大小（字节 -> 可读文本） */
export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

// ==================== GitHub 加速下载（UPDATE_DESIGN.md §3） ====================

/** GitHub 加速节点（GET /app/github/accels 返回项） */
export type GithubAccel = {
  id: number;
  name: string;
  prefixUrl: string;
};

/**
 * 拉取启用的加速前缀列表（前台不缓存：每次直链下载前直接请求，
 * 后台 Caffeine 缓存秒级返回）。请求失败或为空返回 []，不阻塞下载。
 */
export async function fetchGithubAccels(): Promise<GithubAccel[]> {
  try {
    const res = await apiRequest("app/github/accels", new UTSJSONObject(), "GET", false);
    if (res == null) return [];
    // apiRequest 返回的是已解包的 data：数组本体，或 { data: [...] } / { list: [...] } 包装
    let arr: any[] | null = null;
    const anyRes = res as any;
    if (Array.isArray(anyRes)) {
      arr = anyRes;
    } else {
      const inner = (res as UTSJSONObject).get("data") as any;
      if (Array.isArray(inner)) arr = inner;
      else {
        const list = (res as UTSJSONObject).get("list") as any;
        if (Array.isArray(list)) arr = list;
      }
    }
    if (arr == null) return [];
    const list: GithubAccel[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i] as UTSJSONObject;
      const prefixUrl = (item.get("prefixUrl") as string) ?? "";
      if (prefixUrl.length == 0) continue;
      const idRaw = (item.get("id") as number) ?? 0;
      const name = (item.get("name") as string) ?? "";
      list.push({ id: idRaw, name, prefixUrl });
    }
    return list;
  } catch (e) {
    console.log("[Upgrade] 拉取加速节点失败，按无加速处理", e);
    return [];
  }
}

/**
 * 单节点探测：Range 0-0 请求只收几百字节，200/206 视为可用。
 */
function probeOne(url: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    uni.request({
      url,
      method: "GET",
      timeout: timeoutMs,
      header: { Range: "bytes=0-0" } as UTSJSONObject,
      success: (res) => {
        resolve(res.statusCode == 200 || res.statusCode == 206);
      },
      fail: () => {
        resolve(false);
      },
    } as RequestOptions);
  });
}

/**
 * 并发探测所有加速前缀（前缀 + 原始 GitHub 链接），
 * 返回第一个可用前缀；全部不可用/列表为空返回 ""（调用方回退原始链接）。
 */
export async function pickAccelPrefix(
  githubUrl: string,
  prefixes: string[]
): Promise<string> {
  if (prefixes.length == 0) return "";
  return new Promise((resolve) => {
    let done = false;
    let settled = 0;
    for (let i = 0; i < prefixes.length; i++) {
      const p = prefixes[i];
      probeOne(p + githubUrl)
        .then((ok) => {
          if (done) return;
          settled++;
          if (ok) {
            done = true;
            resolve(p);
            return;
          }
          if (settled >= prefixes.length) {
            done = true;
            resolve("");
          }
        })
        .catch(() => {
          if (done) return;
          settled++;
          if (settled >= prefixes.length) {
            done = true;
            resolve("");
          }
        });
    }
  });
}

/**
 * 解析 GitHub 直链的最终下载地址（UPDATE_DESIGN.md §3.2）：
 * 非 GitHub 直链直接返回原地址；GitHub 直链先拉加速列表再并发探测，
 * 命中第一个可用节点则用「前缀+原链接」，全败回退原链接。
 * @param onProbing 探测开始回调（弹窗按钮切「测速中…」用）
 */
export async function resolveDownloadUrl(
  info: AppUpdateInfo,
  onProbing?: () => void
): Promise<string> {
  if (info.isGithub != 1 || info.downloadUrl.length == 0) {
    return info.downloadUrl;
  }
  const accels = await fetchGithubAccels();
  if (accels.length == 0) return info.downloadUrl;
  if (onProbing != null) onProbing();
  const prefixes: string[] = [];
  for (let i = 0; i < accels.length; i++) prefixes.push(accels[i].prefixUrl);
  const picked = await pickAccelPrefix(info.downloadUrl, prefixes);
  if (picked.length > 0) {
    console.log("[Upgrade] 命中加速节点：" + picked);
    return picked + info.downloadUrl;
  }
  console.log("[Upgrade] 加速节点全部不可用，回退原始链接");
  return info.downloadUrl;
}
