/**
 * 通知跳转链接解析（宿主「可点通知」的自定义协议）。
 *
 * 宿主把跳转目标写进 `sys_notice.url`：站内目标用 `astral://<目标>/<id>`（如
 * `astral://feedback/1000003`），外链存 http(s) 地址。浏览器/WebView 不认识 `astral://`，
 * 直接 `navigateTo(url)` 会失败并弹「链接无法打开」，所以必须先解析成本地页面路由。
 *
 * 与桌面端 `qt-pc/src/lib/notice-link.ts`、管理端 `astral-front/src/lib/notice-link.ts`
 * 保持同一套协议语义；新增目标类型时三端一起加。
 */
import { qtShowToast } from "@/services/toast";

/** 站内目标 */
export type NoticeTargetKind = "feedback" | "notice";

export type NoticeLink =
  | { kind: "feedback"; id: string }
  | { kind: "notice"; id: string }
  | { kind: "external"; url: string }
  | { kind: "unsupported"; raw: string };

/** `astral://<目标>/<id>`，目标段只允许字母数字和连字符 */
const ASTRAL_PROTOCOL = /^astral:\/\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)$/i;

/**
 * 解析通知链接。
 * @returns 空值返回 null；解析不了的一律落到 unsupported，由调用方决定提示
 */
export function parseNoticeLink(raw?: string | null): NoticeLink | null {
  if (raw == null || raw.length == 0) return null;
  const value = raw.trim();
  if (value.length == 0) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return { kind: "external", url: value };
  }
  const matched = ASTRAL_PROTOCOL.exec(value);
  if (matched == null) {
    return { kind: "unsupported", raw: value };
  }
  const target = matched[1].toLowerCase();
  const id = matched[2];
  if (target === "feedback") return { kind: "feedback", id };
  if (target === "notice") return { kind: "notice", id };
  return { kind: "unsupported", raw: value };
}

/** 站内目标对应的页面路由 */
function targetPage(link: NoticeLink): string {
  if (link == null) return "";
  if (link.kind === "feedback") return "/pages/feedback/detail?id=" + link.id;
  if (link.kind === "notice") return "/pages/notice/detail/index?id=" + link.id;
  return "";
}

/**
 * 尝试打开 `astral://` 站内链接。
 * @returns true 表示这条 url 已按协议处理（成功跳转或已提示）；false 表示不是宿主协议，交给调用方
 */
export function openAstralLink(url?: string | null): boolean {
  const link = parseNoticeLink(url);
  if (link == null || link.kind === "external") return false;
  if (link.kind === "unsupported") {
    // 认得出是宿主协议但目标还不支持：不跳转、不报「链接无法打开」，静默忽略
    return true;
  }
  const page = targetPage(link);
  if (page.length == 0) return true;
  uni.navigateTo({
    url: page,
    fail: () => {
      qtShowToast({ title: "链接无法打开", icon: "none" });
    },
  });
  return true;
}
