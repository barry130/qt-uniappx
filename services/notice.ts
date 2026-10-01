/**
 * 统一通知服务
 * 负责从后端拉取通知（公告/反馈/需求）、分发到各展示位、消息中心本地已读/未读
 * 接口：astral-plugin-feedback /api/v1/app/message/**（QtRestResp 包装）
 */
import { apiRequest } from "./http";
import { getAccessToken, isLoggedIn } from "./auth";
import { openInBrowser } from "./app-native";
import type { Notice, NoticeDispatch } from "@/types/notice";
import { getCurrentVersionCode } from "@/services/app-version";

/**
 * 打开公告跳转目标
 * - http/https 链接：跳系统浏览器
 * - 其他：视为内部页面路由，尝试 navigateTo
 */
export function openNoticeUrl(url?: string): void {
  if (url == null || url.length == 0) return;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    openInBrowser(url);
    return;
  }
  uni.navigateTo({
    url,
    fail: () => {
      uni.showToast({ title: "链接无法打开", icon: "none" });
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
    console.log("[Notice] fetchActiveNotices raw:", response);
    return [];
  } catch (e) {
    console.log("[Notice] fetchActiveNotices error", e);
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
    console.log("[Notice] fetchMessageCenter error", e);
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
    console.log("[Notice] fetchUnreadCount error", e);
    return 0;
  }
}

// ============ 会话级状态 ============

/** 通告栏是否已在本会话关闭（内存标志） */
let noticeBarClosedInSession = false;

/** 重置通告栏会话状态（页面 onShow 可调用） */
export function resetNoticeBarSession(): void {
  // 不自动重置，保持会话级
}

/** 关闭通告栏（本次会话不再显示） */
export function closeNoticeBarSession(): void {
  noticeBarClosedInSession = true;
}

/** 检查通告栏是否在本会话已关闭 */
export function isNoticeBarClosedInSession(): boolean {
  return noticeBarClosedInSession;
}

/** 首次登录弹窗标记 key */
const FIRST_LOGIN_KEY = "qt-notice-first-login";

/**
 * 通知类型标签文案：announce 公告 | feedback 反馈 | request 需求
 */
export function noticeTypeLabel(noticeType?: string): string {
  if (noticeType == "feedback") return "反馈";
  if (noticeType == "request") return "需求";
  return "公告";
}

/**
 * 检查是否首次登录（用于 firstLoginOnly）
 * 登录后标记已弹过，后续不再弹
 */
export function isFirstLogin(): boolean {
  try {
    const flag = uni.getStorageSync(FIRST_LOGIN_KEY) as string;
    // 如果已登录且标记为已弹过，返回 false
    if (isLoggedIn() && flag === "shown") return false;
    // 未登录或未标记，视为首次
    return true;
  } catch (_) {
    return true;
  }
}

/**
 * 标记首次登录弹窗已展示
 */
export function markFirstLoginShown(): void {
  try {
    uni.setStorageSync(FIRST_LOGIN_KEY, "shown");
  } catch (_) {}
}