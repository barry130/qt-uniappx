/**
 * 问题反馈服务
 * 对齐 astral-plugin-feedback App 端接口（/api/v1/app/feedback/**，QtRestResp 包装，需登录）
 * 全部经 services/http.ts 的 apiRequest 收口；平台/版本/设备/系统四个头由
 * services/client-info.ts 统一注入（契约与接口统计共用），本文件不再自己拼头。
 */
import { apiRequest } from "./http";
import type { FeedbackItem, FeedbackPageResult, FeedbackReplyItem } from "@/types/feedback";

/** 分页默认条数 */
export const FEEDBACK_PAGE_SIZE = 10;

/** 反馈对象规整：null 字段补默认值，避免页面空判断 */
function normalizeFeedback(raw: UTSJSONObject): FeedbackItem {
  const id = raw.get("id") as number | null;
  const userId = raw.get("userId") as number | null;
  const type = raw.get("type") as string | null;
  const title = raw.get("title") as string | null;
  const content = raw.get("content") as string | null;
  const contact = raw.get("contact") as string | null;
  const status = raw.get("status") as string | null;
  const isPublic = raw.get("isPublic") as boolean | null;
  const device = raw.get("device") as string | null;
  const os = raw.get("os") as string | null;
  const appVersion = raw.get("appVersion") as string | null;
  const platform = raw.get("platform") as string | null;
  const createTime = raw.get("createTime") as string | null;
  const updateTime = raw.get("updateTime") as string | null;
  const item: FeedbackItem = {
    id: id ?? 0,
    userId: userId ?? 0,
    type: type ?? "issue",
    title: title ?? "",
    content: content ?? "",
    contact: contact ?? "",
    status: status ?? "pending",
    isPublic: isPublic != null ? isPublic : false,
    device: device ?? "",
    os: os ?? "",
    appVersion: appVersion ?? "",
    platform: platform ?? "",
    createTime: createTime ?? "",
    updateTime: updateTime ?? "",
  };
  return item;
}

/** 回复对象规整 */
function normalizeReply(raw: UTSJSONObject): FeedbackReplyItem {
  const id = raw.get("id") as number | null;
  const feedbackId = raw.get("feedbackId") as number | null;
  const userId = raw.get("userId") as number | null;
  const content = raw.get("content") as string | null;
  const replyTime = raw.get("replyTime") as string | null;
  const nickname = raw.get("nickname") as string | null;
  const userType = raw.get("userType") as string | null;
  const item: FeedbackReplyItem = {
    id: id ?? 0,
    feedbackId: feedbackId ?? 0,
    userId: userId ?? 0,
    content: content ?? "",
    replyTime: replyTime ?? "",
    nickname: nickname ?? "",
    userType: userType ?? "",
  };
  return item;
}

/** 分页对象解析（MyBatis-Plus Page 序列化：records/total/current/pages） */
function normalizePage(response: any): FeedbackPageResult {
  const result: FeedbackPageResult = { records: [], total: 0, current: 1, pages: 0 };
  const raw = response as UTSJSONObject;
  const recordsRaw = raw.get("records") as any;
  if (recordsRaw != null && Array.isArray(recordsRaw)) {
    const arr = recordsRaw as any[];
    for (let i = 0; i < arr.length; i++) {
      result.records.push(normalizeFeedback(arr[i] as UTSJSONObject));
    }
  }
  const total = raw.get("total") as number | null;
  const current = raw.get("current") as number | null;
  const pages = raw.get("pages") as number | null;
  result.total = total ?? 0;
  result.current = current ?? 1;
  result.pages = pages ?? 0;
  return result;
}

/** 从响应中解出 Feedback 对象（data 已被 apiRequest 解包） */
function feedbackFromResponse(response: any): FeedbackItem {
  return normalizeFeedback(response as UTSJSONObject);
}

/** 从响应中解出回复数组 */
function repliesFromResponse(response: any): FeedbackReplyItem[] {
  if (response != null && Array.isArray(response)) {
    const arr = response as any[];
    const out: FeedbackReplyItem[] = [];
    for (let i = 0; i < arr.length; i++) {
      out.push(normalizeReply(arr[i] as UTSJSONObject));
    }
    return out;
  }
  const raw = (response as UTSJSONObject).get("data") as any;
  if (raw != null && Array.isArray(raw)) {
    const arr = raw as any[];
    const out: FeedbackReplyItem[] = [];
    for (let i = 0; i < arr.length; i++) {
      out.push(normalizeReply(arr[i] as UTSJSONObject));
    }
    return out;
  }
  return [];
}

/**
 * 提交反馈
 * @param type issue 问题 | request 需求
 * @param title 标题（≤128）
 * @param content 内容（≤5000）
 * @param contact 联系方式（可空，≤64）
 */
export async function submitFeedback(
  type: string,
  title: string,
  content: string,
  contact: string
): Promise<FeedbackItem> {
  const body = new UTSJSONObject();
  body.set("type", type);
  body.set("title", title);
  body.set("content", content);
  if (contact.length > 0) body.set("contact", contact);
  const res = await apiRequest("app/feedback/submit", body, "POST", true);
  return feedbackFromResponse(res as any);
}

/** 我的反馈（分页，全部状态，按 create_time DESC） */
export async function fetchMyFeedback(pageNum: number, pageSize: number): Promise<FeedbackPageResult> {
  const data = new UTSJSONObject();
  data.set("pageNum", pageNum);
  data.set("pageSize", pageSize);
  const res = await apiRequest("app/feedback/my", data, "GET", true);
  return normalizePage(res as any);
}

/** 公开列表（status=published AND is_public=true，分页） */
export async function fetchPublicFeedback(pageNum: number, pageSize: number): Promise<FeedbackPageResult> {
  const data = new UTSJSONObject();
  data.set("pageNum", pageNum);
  data.set("pageSize", pageSize);
  const res = await apiRequest("app/feedback/public", data, "GET", true);
  return normalizePage(res as any);
}

/** 反馈详情（本人 或 published+public） */
export async function fetchFeedbackDetail(id: number): Promise<FeedbackItem> {
  const res = await apiRequest("app/feedback/" + id, new UTSJSONObject(), "GET", true);
  return feedbackFromResponse(res as any);
}

/** 回复列表（升序；带 nickname/userType/replyTime） */
export async function fetchReplies(id: number): Promise<FeedbackReplyItem[]> {
  const res = await apiRequest("app/feedback/" + id + "/replies", new UTSJSONObject(), "GET", true);
  return repliesFromResponse(res as any);
}

/** 用户回复（≤2000；同时给管理员侧生成一条 sys_notice） */
export async function replyFeedback(feedbackId: number, content: string): Promise<FeedbackReplyItem> {
  const body = new UTSJSONObject();
  body.set("feedbackId", feedbackId);
  body.set("content", content);
  const res = await apiRequest("app/feedback/reply", body, "POST", true);
  return normalizeReply(res as any);
}

/** 状态中文名 */
export function feedbackStatusLabel(status?: string): string {
  if (status == "received") return "已接收";
  if (status == "resolved") return "已解决";
  if (status == "published") return "已发布";
  if (status == "deprecated") return "已废弃";
  return "提出";
}

/** 状态标签底色 */
export function feedbackStatusColor(status?: string): string {
  if (status == "received") return "#4a7dff";
  if (status == "resolved") return "#4fb186";
  if (status == "published") return "#9b82d9";
  if (status == "deprecated") return "#c4c9d4";
  return "#d99b3f";
}

/** 类型标签文案：issue 问题 | request 需求 */
export function feedbackTypeLabel(type?: string): string {
  return type == "request" ? "需求" : "问题";
}

/** 类型标签底色 */
export function feedbackTypeColor(type?: string): string {
  return type == "request" ? "#e8890c" : "#4a7dff";
}
