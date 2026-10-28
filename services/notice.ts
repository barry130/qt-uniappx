/**
 * 统一通知服务
 * 负责从后端拉取通知（公告/反馈/需求）、分发到各展示位、消息中心本地已读/未读
 * 接口：astral-plugin-feedback /api/v1/app/message/**（QtRestResp 包装）
 */
import { apiRequest } from "./http";
import { getAccessToken, isLoggedIn } from "./auth";
import { openInBrowser } from "./app-native";
import { logErrV, logWarnV } from "./logger";
import type { Notice, NoticeDispatch } from "@/types/notice";
import { getCurrentVersionCode } from "@/services/app-version";
import { qtShowToast } from "@/services/toast";
import { openAstralLink } from "@/services/notice-link";

/**
 * 打开公告跳转目标
 * - `astral://<目标>/<id>`：宿主自定义协议，解析成本地页面路由（反馈详情 / 通知详情）
 * - http/https 链接：跳系统浏览器
 * - 其他：视为内部页面路由，尝试 navigateTo
 */
export function openNoticeUrl(url?: string): void {
  if (url == null || url.length == 0) return;
  // 宿主协议必须先解析：直接 navigateTo("astral://...") 必失败并弹「链接无法打开」
  if (openAstralLink(url)) return;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    openInBrowser(url);
    return;
  }
  uni.navigateTo({
    url,
    fail: () => {
      qtShowToast({ title: "链接无法打开", icon: "none" });
    },
  });
}

/**
 * 去 HTML 标签，得到纯文本（用于列表预览、通告栏等紧凑场景）
 */
export function stripHtml(html?: string): string {
  if (html == null || html.length == 0) return "";
  let s = html;
  // 常见块级/换行标签转成换行
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(p|div|li|h[1-6])[^>]*>/gi, "\n");
  // 去掉其余标签
  s = s.replace(/<[^>]+>/g, "");
  // 反转义常用实体
  s = s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  return s;
}

/**
 * 检查通知是否包含指定展示位（位掩码）
 */
export function hasChannel(display: number | undefined, channel: number): boolean {
  if (display == null) return false;
  return (display & channel) === channel;
}

/** 通知的展示位掩码（优先新字段 display，兼容旧 type） */
export function noticeDisplay(n: Notice): number {
  if (n.display != null) return n.display;
  return n.type ?? 0;
}

/**
 * 拉取当前生效通知列表（公开接口；已登录时携带 satoken，后端据此过滤登录可见与点对点通知）
 */
export async function fetchActiveNotices(versionCode?: number): Promise<Notice[]> {
  try {
    const code = versionCode ?? getCurrentVersionCode();
    // 不做本地缓存：反馈回复等点对点通知靠这里下发，缓存 1 小时会让用户
    // 半天看不到新回复（用户实测反馈过）。请求本身很轻，每次进首页拉一次可接受。
    const extra = new UTSJSONObject();
    if (isLoggedIn()) {
      const token = getAccessToken();
      if (token.length > 0) extra.set("satoken", token);
    }
    const response = await apiRequest(
      "app/message/active?versionCode=" + encodeURIComponent(code.toString()),
      new UTSJSONObject(),
      "GET",
      false,
      extra
    );
    // 后端返回 QtRestResp<List<SysNotice>>，data 是数组
    const data = response as any;
    if (Array.isArray(data)) {
      return data as Notice[];
    }
    // 兼容 UTSJSONObject 包装的情况
    const raw = (response as UTSJSONObject).get("data") as any;
    if (raw != null && Array.isArray(raw)) {
      return raw as Notice[];
    }
    logWarnV("Notice", "fetchActiveNotices 响应不是数组", response);
    return [];
  } catch (e) {
    logErrV("Notice", "fetchActiveNotices 失败", e);
    return [];
  }
}

/**
 * 分发通知到各展示位
 * 按 display 位掩码分组
 */
/** 按置顶优先、创建时间由近及远排序（消息中心/开屏/通告栏等通用） */
export function sortNotices(notices: Notice[]): Notice[] {
  return notices.slice().sort((a, b) => {
    const atop = a.isTop ?? 0;
    const btop = b.isTop ?? 0;
    if (atop !== btop) return btop - atop;
    const at = a.createTime ?? "";
    const bt = b.createTime ?? "";
    return bt.localeCompare(at);
  });
}

export function dispatchNotices(notices: Notice[]): NoticeDispatch {
  const result: NoticeDispatch = {
    splash: [],
    noticeBar: [],
    messageCenter: [],
  };
  for (const n of notices) {
    const display = noticeDisplay(n);
    if (hasChannel(display, 1)) result.splash.push(n);
    if (hasChannel(display, 2)) result.noticeBar.push(n);
    if (hasChannel(display, 4)) result.messageCenter.push(n);
  }
  // 各渠道内按置顶优先、创建时间由近及远排序
  result.splash = sortNotices(result.splash);
  result.noticeBar = sortNotices(result.noticeBar);
  result.messageCenter = sortNotices(result.messageCenter);
  return result;
}

/**
 * 检查公告是否对当前用户可见（基于 audience）
 * 未登录时：仅可见 ALL 或 NOT_LOGGED_IN
 * 已登录时：仅可见 ALL 或 LOGGED_IN
 */
export function isNoticeVisibleForUser(notice: Notice): boolean {
  const audience = notice.audience ?? "ALL";
  const loggedIn = isLoggedIn();
  if (audience === "ALL") return true;
  if (audience === "LOGGED_IN") return loggedIn;
  if (audience === "NOT_LOGGED_IN") return !loggedIn;
  return true;
}

/**
 * 检查公告是否在有效时间窗口内
 */
export function isNoticeEffective(notice: Notice): boolean {
  const now = new Date();
  if (notice.effectiveStart != null) {
    const start = new Date(notice.effectiveStart);
    if (now < start) return false;
  }
  if (notice.effectiveEnd != null) {
    const end = new Date(notice.effectiveEnd);
    if (now > end) return false;
  }
  return true;
}

/**
 * 检查通知是否对当前 APP 版本码有效
 * 后端 version_min/version_max 为 BIGINT 版本码（如 300 对应 3.0.0），做数值区间比较
 */
export function isNoticeVersionMatch(notice: Notice, versionCode?: number): boolean {
  // 版本码未知（0）时不按版本区间过滤，避免整批公告被误判为不匹配
  const code = versionCode ?? getCurrentVersionCode();
  const min = notice.versionMin;
  const max = notice.versionMax;
  if (code <= 0) return true;
  if (min != null && code < min) return false;
  if (max != null && code > max) return false;
  return true;
}

// ============ 消息中心（需登录） ============

/**
 * 获取消息中心列表（公告 + 反馈/需求通知；已读状态由前端缓存判断，后端不返回）
 */
export async function fetchMessageCenter(): Promise<Notice[]> {
  try {
    const response = await apiRequest(
      "app/message/center",
      new UTSJSONObject(),
      "GET",
      true // 需登录
    );
    const data = response as any;
    if (Array.isArray(data)) {
      return data as Notice[];
    }
    const raw = (response as UTSJSONObject).get("data") as any;
    if (raw != null && Array.isArray(raw)) {
      return raw as Notice[];
    }
    return [];
  } catch (e) {
    logErrV("Notice", "fetchMessageCenter 失败", e);
    return [];
  }
}

/**
 * 获取消息中心候选总数（后端不判已读；已读判定在前端缓存）
 */
export async function fetchUnreadCount(): Promise<number> {
  try {
    const response = await apiRequest(
      "app/message/unread-count",
      new UTSJSONObject(),
      "GET",
      true // 需登录
    );
    const data = response as any;
    if (typeof data === "number") return data;
    const raw = (response as UTSJSONObject).get("data") as any;
    if (typeof raw === "number") return raw;
    return 0;
  } catch (e) {
    logErrV("Notice", "fetchUnreadCount 失败", e);
    return 0;
  }
}

// ============ 会话级状态 ============

/** 通告栏是否已在本会话关闭（内存标志） */
let noticeBarClosedInSession = false;

/** 关闭通告栏（本次会话不再显示） */
export function closeNoticeBarSession(): void {
  noticeBarClosedInSession = true;
}

/** 检查通告栏是否在本会话已关闭 */
export function isNoticeBarClosedInSession(): boolean {
  return noticeBarClosedInSession;
}

/** 「仅首次登录弹出」的已弹标记：按公告 id 各记一条 */
const LEGACY_FIRST_LOGIN_KEY = "qt-notice-first-login";
const FIRST_LOGIN_KEY_PREFIX = "qt-notice-first-login-";

function firstLoginKey(noticeId: number): string {
  return FIRST_LOGIN_KEY_PREFIX + noticeId;
}

/**
 * 通知类型标签文案：announce 公告 | feedback 反馈 | request 需求
 */
export function noticeTypeLabel(noticeType?: string): string {
  if (noticeType == "feedback") return "反馈";
  if (noticeType == "request") return "需求";
  return "公告";
}

/**
 * 这条公告是否已经弹过（仅对 firstLoginOnly 有意义）。
 * 按公告 id 记：用户看过了旧公告，后台新发布的「仅首次登录」公告仍会弹。
 */
export function isFirstLoginShown(noticeId: number): boolean {
  try {
    return (uni.getStorageSync(firstLoginKey(noticeId)) as string) == "shown";
  } catch (_) {
    return false;
  }
}

/**
 * 标记这条「仅首次登录」公告已展示。
 */
export function markFirstLoginShown(noticeId: number): void {
  try {
    uni.setStorageSync(firstLoginKey(noticeId), "shown");
  } catch (_) {
    // 静默：写不进只让这条公告下次再弹一次，不影响功能
  }
}

/**
 * 老版本用一个全局标记（`qt-notice-first-login = "shown"`）表示「弹过首次登录公告」。
 * 升级后把它一次性迁移成按条标记：当前已下发的这些公告都算已弹，再删掉老键。
 * 不迁移的话，老用户会因为老标记而永远看不到新公告。
 */
export function migrateLegacyFirstLogin(noticeIds: readonly number[]): void {
  try {
    if ((uni.getStorageSync(LEGACY_FIRST_LOGIN_KEY) as string) != "shown") return;
    for (const id of noticeIds) uni.setStorageSync(firstLoginKey(id), "shown");
    uni.removeStorageSync(LEGACY_FIRST_LOGIN_KEY);
  } catch (_) {
    // 静默：迁移失败就保持原状，老键还在，下次启动再试
  }
}