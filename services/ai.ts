/**
 * AI 音乐助手服务
 * 对齐 astral-plugin 的 AI 模块 App 端接口（`/api/v1/app/ai/**`，QtRestResp 包装，需登录）
 *
 * 全部经 services/http.ts 的 apiRequest 收口；平台/版本/设备/系统四个头由
 * services/client-info.ts 统一注入（与反馈/通知同一套契约），本文件不自己拼头。
 *
 * 客户端类型：本端不传 `clientType`，后端 `AiAppController.resolveClient` 缺省按
 * QT_UNIAPPX 兜底（见后端该方法 javadoc）。qt-pc 才必须显式传 QT_PC。
 */
import { apiRequest, parseJsonToUtso } from "./http";
import type {
  AiAction,
  AiAgentCard,
  AiBlock,
  AiCapabilities,
  AiCitation,
  AiConversation,
  AiEvent,
  AiEventBatch,
  AiMessage,
  AiMessagePage,
  AiMusicCandidate,
  AiSendResult,
} from "@/types/ai";
import type { Song } from "@/types/music";

/** 默认拉取的历史消息条数（后端 AiConversationService.DEFAULT_PAGE_SIZE = 30） */
export const AI_MESSAGE_PAGE_SIZE = 30;

/** 单轮事件批量上限（后端 AiAppDtos.MAX_EVENT_BATCH = 500，太小会导致轮询次数暴涨） */
export const AI_EVENT_BATCH = 100;

/** 消息正文上限（后端 MAX_MESSAGE_CHARS 的软上限，超过直接报 AI007 更不友好） */
export const AI_MESSAGE_MAX_CHARS = 4000;

/** 回传候选上限（后端 MusicToolProvider.MAX_CANDIDATES_TO_MODEL = 30） */
export const AI_CANDIDATE_MAX = 30;

// ==================== 规整工具 ====================

function strOf(raw: UTSJSONObject, key: string): string {
  const v = raw.get(key);
  return v != null ? v.toString() : "";
}

function numOf(raw: UTSJSONObject, key: string): number {
  const v = raw.get(key);
  if (v == null) return 0;
  const n = parseFloat(v.toString());
  return isNaN(n) ? 0 : n;
}

function boolOf(raw: UTSJSONObject, key: string, def: boolean): boolean {
  const v = raw.get(key);
  if (v == null) return def;
  return v.toString() == "true";
}

function objOf(raw: UTSJSONObject, key: string): UTSJSONObject | null {
  const v = raw.get(key);
  if (v == null) return null;
  // 后台可能把配置存成 JSON 字符串（entryConfig 实测如此）：直接盲转 UTSJSONObject
  // 运行时还是 string，.get 直接崩（a.entryConfig.get is not a function）——先解析成真对象
  if (typeof v == "string") {
    const s = (v as string).trim();
    if (s.length > 0 && s.startsWith("{")) {
      try {
        return parseJsonToUtso(s);
      } catch (_) {
        return null;
      }
    }
    return null;
  }
  return v as UTSJSONObject;
}

function arrOf(raw: UTSJSONObject, key: string): any[] {
  const v = raw.get(key);
  if (v == null) return [];
  if (Array.isArray(v)) return v as any[];
  return [];
}

/** 响应可能是数组，也可能被包在 data 里（不同后端网关行为） */
function listOf(response: any): any[] {
  if (response != null && Array.isArray(response)) return response as any[];
  if (response != null) {
    const inner = (response as UTSJSONObject).get("data");
    if (inner != null && Array.isArray(inner)) return inner as any[];
  }
  return [];
}

// ==================== 规整函数 ====================

function normalizeCapabilities(raw: UTSJSONObject): AiCapabilities {
  return {
    conversationEnabled: boolOf(raw, "conversationEnabled", true),
    feedbackEnabled: boolOf(raw, "feedbackEnabled", false),
    fileContextEnabled: boolOf(raw, "fileContextEnabled", false),
    userContextEnabled: boolOf(raw, "userContextEnabled", true),
    citationRequired: boolOf(raw, "citationRequired", false),
    musicActionsEnabled: boolOf(raw, "musicActionsEnabled", false),
    clientType: strOf(raw, "clientType"),
  };
}

function emptyCapabilities(): AiCapabilities {
  return {
    conversationEnabled: true,
    feedbackEnabled: false,
    fileContextEnabled: false,
    userContextEnabled: true,
    citationRequired: false,
    musicActionsEnabled: false,
    clientType: "QT_UNIAPPX",
  };
}

function normalizeAgentCard(raw: UTSJSONObject): AiAgentCard {
  const capRaw = objOf(raw, "capabilities");
  return {
    agentCode: strOf(raw, "agentCode"),
    name: strOf(raw, "name"),
    agentType: strOf(raw, "agentType"),
    description: strOf(raw, "description"),
    icon: strOf(raw, "icon"),
    entryConfig: objOf(raw, "entryConfig"),
    capabilities: capRaw != null ? normalizeCapabilities(capRaw) : emptyCapabilities(),
  };
}

function normalizeConversation(raw: UTSJSONObject): AiConversation {
  return {
    id: numOf(raw, "id"),
    agentCode: strOf(raw, "agentCode"),
    agentName: strOf(raw, "agentName"),
    title: strOf(raw, "title"),
    status: strOf(raw, "status"),
    messageCount: numOf(raw, "messageCount"),
    pinned: boolOf(raw, "pinned", false),
    lastMessageTime: strOf(raw, "lastMessageTime"),
    createTime: strOf(raw, "createTime"),
  };
}

export function normalizeCitation(raw: UTSJSONObject): AiCitation {
  return {
    sourceId: numOf(raw, "sourceId"),
    sourceType: strOf(raw, "sourceType"),
    title: strOf(raw, "title"),
    path: strOf(raw, "path"),
    section: strOf(raw, "section"),
    version: strOf(raw, "version"),
    matchedText: strOf(raw, "matchedText"),
  };
}

export function normalizeBlock(raw: UTSJSONObject): AiBlock {
  return {
    type: strOf(raw, "type"),
    title: strOf(raw, "title"),
    data: objOf(raw, "data"),
  };
}

export function normalizeAction(raw: UTSJSONObject): AiAction {
  return {
    actionId: strOf(raw, "actionId"),
    type: strOf(raw, "type"),
    payload: objOf(raw, "payload"),
  };
}

export function normalizeMessage(raw: UTSJSONObject): AiMessage {
  const blocks: AiBlock[] = [];
  const rawBlocks = arrOf(raw, "blocks");
  for (let i = 0; i < rawBlocks.length; i++) {
    blocks.push(normalizeBlock(rawBlocks[i] as UTSJSONObject));
  }
  const citations: AiCitation[] = [];
  const rawCitations = arrOf(raw, "citations");
  for (let i = 0; i < rawCitations.length; i++) {
    citations.push(normalizeCitation(rawCitations[i] as UTSJSONObject));
  }
  return {
    id: numOf(raw, "id"),
    conversationId: numOf(raw, "conversationId"),
    requestId: numOf(raw, "requestId"),
    role: strOf(raw, "role"),
    content: strOf(raw, "content"),
    contentType: strOf(raw, "contentType"),
    status: strOf(raw, "status"),
    blocks: blocks,
    citations: citations,
    modelName: strOf(raw, "modelName"),
    createTime: strOf(raw, "createTime"),
  };
}

function normalizeEvent(raw: UTSJSONObject): AiEvent {
  return {
    requestId: numOf(raw, "requestId"),
    sequence: numOf(raw, "sequence"),
    type: strOf(raw, "type"),
    data: objOf(raw, "data"),
    createdAt: strOf(raw, "createdAt"),
  };
}

function normalizeEventBatch(raw: UTSJSONObject): AiEventBatch {
  const events: AiEvent[] = [];
  const list = arrOf(raw, "events");
  for (let i = 0; i < list.length; i++) {
    events.push(normalizeEvent(list[i] as UTSJSONObject));
  }
  return {
    requestId: numOf(raw, "requestId"),
    status: strOf(raw, "status"),
    events: events,
    nextSequence: numOf(raw, "nextSequence"),
    terminal: boolOf(raw, "terminal", false),
  };
}

// ==================== 智能体 ====================

/** 本端可用的智能体列表（后端已过滤未发布/停用/不支持本端/无权限的） */
export async function fetchAgents(): Promise<AiAgentCard[]> {
  const res = await apiRequest("app/ai/agents", new UTSJSONObject(), "GET", true);
  const list = listOf(res as any);
  const out: AiAgentCard[] = [];
  for (let i = 0; i < list.length; i++) {
    out.push(normalizeAgentCard(list[i] as UTSJSONObject));
  }
  return out;
}

/** 取指定智能体的能力（不存在或无权限时后端抛错） */
export async function fetchCapabilities(agentCode: string): Promise<AiCapabilities> {
  const data = new UTSJSONObject();
  data.set("agentCode", agentCode);
  const res = await apiRequest("app/ai/capabilities", data, "GET", true);
  return normalizeCapabilities(res as UTSJSONObject);
}

/** 当前用户在指定智能体下的会话列表（后端按更新时间倒序） */
export async function fetchConversations(agentCode: string): Promise<AiConversation[]> {
  const data = new UTSJSONObject();
  data.set("agentCode", agentCode);
  const res = await apiRequest("app/ai/conversations", data, "GET", true);
  const list = listOf(res as any);
  const out: AiConversation[] = [];
  for (let i = 0; i < list.length; i++) {
    out.push(normalizeConversation(list[i] as UTSJSONObject));
  }
  return out;
}

export async function createConversation(agentCode: string, title: string): Promise<AiConversation> {
  const body = new UTSJSONObject();
  body.set("agentCode", agentCode);
  if (title.length > 0) body.set("title", title);
  const res = await apiRequest("app/ai/conversations", body, "POST", true);
  return normalizeConversation(res as UTSJSONObject);
}

export async function deleteConversation(id: number): Promise<void> {
  await apiRequest("app/ai/conversations/" + id, new UTSJSONObject(), "DELETE", true);
}

/**
 * 历史消息（返回按时间升序，可直接铺进列表）。
 *
 * @param beforeId 翻旧消息时传当前最旧一条的 id，首页传 0
 */
export async function fetchMessages(
  conversationId: number,
  beforeId: number,
  limit: number = AI_MESSAGE_PAGE_SIZE
): Promise<AiMessagePage> {
  let path = "app/ai/conversations/" + conversationId + "/messages?limit=" + limit;
  if (beforeId > 0) path += "&beforeId=" + beforeId;
  const res = await apiRequest(path, new UTSJSONObject(), "GET", true);
  const raw = res as UTSJSONObject;
  const items: AiMessage[] = [];
  const list = arrOf(raw, "items");
  for (let i = 0; i < list.length; i++) {
    items.push(normalizeMessage(list[i] as UTSJSONObject));
  }
  return {
    items: items,
    nextCursor: numOf(raw, "nextCursor"),
    hasMore: boolOf(raw, "hasMore", false),
  };
}

// ==================== 发消息 / 事件 ====================

/**
 * 发一条消息，立即返回受理结果（真正的回答靠轮询事件推进）。
 *
 * `context` 必须带上客户端能提供的音乐上下文：`currentSong` / `currentQueue` /
 * `musicCandidates` / `installedSourceRegistry` 等（后端 `AiChatOrchestrator.sanitizeContext`
 * 只放行白名单键，其余键会被静默丢弃）。缺 `musicCandidates` 时模型无法排序推荐，
 * 只能空谈——所以调用方要先本地搜索再回传。
 */
export async function sendMessage(
  conversationId: number,
  content: string,
  context: UTSJSONObject | null,
  idempotencyKey: string
): Promise<AiSendResult> {
  const body = new UTSJSONObject();
  body.set("content", content);
  if (idempotencyKey.length > 0) body.set("idempotencyKey", idempotencyKey);
  if (context != null) body.set("context", context);
  const res = await apiRequest("app/ai/conversations/" + conversationId + "/messages", body, "POST", true);
  const raw = res as UTSJSONObject;
  return {
    requestId: numOf(raw, "requestId"),
    userMessageId: numOf(raw, "userMessageId"),
    assistantMessageId: numOf(raw, "assistantMessageId"),
    status: strOf(raw, "status"),
    stream: boolOf(raw, "stream", true),
  };
}

/**
 * 拉一轮事件（App 端无 SSE，只能这样轮询）。
 *
 * @param after 上一轮的 `nextSequence`，首轮传 0
 */
export async function fetchEvents(
  requestId: number,
  after: number,
  limit: number = AI_EVENT_BATCH
): Promise<AiEventBatch> {
  const path = "app/ai/requests/" + requestId + "/events?after=" + after + "&limit=" + limit;
  const res = await apiRequest(path, new UTSJSONObject(), "GET", true);
  return normalizeEventBatch(res as UTSJSONObject);
}

export async function cancelRequest(requestId: number, reason: string): Promise<void> {
  const body = new UTSJSONObject();
  if (reason.length > 0) body.set("reason", reason);
  await apiRequest("app/ai/requests/" + requestId + "/cancel", body, "POST", true);
}

/** 反馈（LIKE / DISLIKE / REGENERATE / REPORT） */
export async function sendFeedback(
  messageId: number,
  feedbackType: string,
  reasonCode: string,
  comment: string
): Promise<void> {
  const body = new UTSJSONObject();
  body.set("feedbackType", feedbackType);
  if (reasonCode.length > 0) body.set("reasonCode", reasonCode);
  if (comment.length > 0) body.set("comment", comment);
  await apiRequest("app/ai/messages/" + messageId + "/feedback", body, "POST", true);
}

/** 上报动作执行结果（客户端执行完播放/收藏后回执，供后台统计动作采纳率） */
export async function reportAction(
  actionId: string,
  actionType: string,
  success: boolean,
  message: string
): Promise<void> {
  const body = new UTSJSONObject();
  body.set("actionId", actionId);
  body.set("actionType", actionType);
  body.set("success", success);
  if (message.length > 0) body.set("message", message);
  await apiRequest("app/ai/actions/execute", body, "POST", true);
}

// ==================== 候选歌曲组装 ====================

/**
 * 把本端 `Song` 转成后端认识的候选结构。
 *
 * 字段名与后端 `MusicToolProvider.candidates()` 严格一致：
 * sourceId ← Song.platform，songId ← Song.id，duration 是**秒**（后端按数字取，
 * 不做单位换算；模型只看相对长短，不要把毫秒填进来）。
 */
export function candidateFromSong(song: Song, quality: string = ""): AiMusicCandidate {
  const candidate: AiMusicCandidate = {
    sourceId: song.platform,
    songId: song.id,
    name: song.name,
    artist: song.singer,
    album: song.album,
    duration: song.duration != null ? song.duration! : 0,
    coverUrl: song.picUrl,
    quality: quality,
    extra: null,
  };
  return candidate;
}

/** 候选转回本端 Song（动作里只带 songId/sourceId，播放时要还原成完整对象） */
export function songFromCandidate(candidate: AiMusicCandidate): Song {
  const song: Song = {
    id: candidate.songId,
    name: candidate.name,
    singer: candidate.artist,
    album: candidate.album,
    picUrl: candidate.coverUrl,
    platform: candidate.sourceId,
  };
  if (candidate.duration > 0) song.duration = candidate.duration;
  return song;
}

/** 候选数组转 JSON 数组（塞进请求上下文的 `musicCandidates`） */
export function candidatesToJson(candidates: AiMusicCandidate[]): any[] {
  const out: any[] = [];
  const n = candidates.length > AI_CANDIDATE_MAX ? AI_CANDIDATE_MAX : candidates.length;
  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    const item = new UTSJSONObject();
    item.set("sourceId", c.sourceId);
    item.set("songId", c.songId);
    item.set("name", c.name);
    item.set("artist", c.artist);
    item.set("album", c.album);
    item.set("duration", c.duration);
    item.set("coverUrl", c.coverUrl);
    if (c.quality.length > 0) item.set("quality", c.quality);
    if (c.extra != null) item.set("extra", c.extra);
    out.push(item);
  }
  return out;
}

// ==================== 文案 ====================

/** 动作类型中文（后端 AiConstants.ActionType 的 9 个白名单值） */
export function actionLabel(type?: string): string {
  if (type == "PLAY_SONG") return "播放";
  if (type == "PLAY_LIST") return "播放全部";
  if (type == "ADD_TO_QUEUE") return "加入队列";
  if (type == "ADD_TO_FAVORITE") return "收藏";
  if (type == "OPEN_SONG") return "查看歌曲";
  if (type == "OPEN_ARTIST") return "查看歌手";
  if (type == "OPEN_ALBUM") return "查看专辑";
  if (type == "OPEN_PLAYLIST") return "查看歌单";
  if (type == "SEARCH_MUSIC") return "换个搜索";
  return "操作";
}
