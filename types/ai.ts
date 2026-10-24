/**
 * AI 音乐助手类型定义
 *
 * 对齐 astral-plugin 的 AI 模块 App 端契约（`/api/v1/app/ai/**`，QtRestResp 包装，需登录）。
 * 所有枚举值都是后端 `AiConstants` 的字面量，**不要在前端另立一套**：
 * 智能体编码、客户端、请求状态、消息状态、动作类型都由后台配置与后端常量决定。
 */

/**
 * 智能体能力开关（后端按智能体已发布版本实时计算，不是前端猜的）。
 */
export type AiCapabilities = {
  conversationEnabled: boolean;
  feedbackEnabled: boolean;
  /** 允许携带文件内容（音乐助手关闭，后台配置决定） */
  fileContextEnabled: boolean;
  /** 允许携带用户上下文（当前歌曲 / 播放队列等） */
  userContextEnabled: boolean;
  /** 回答必须带引用（答疑类智能体为 true） */
  citationRequired: boolean;
  /** 允许下发音乐动作（PLAY_SONG 等） */
  musicActionsEnabled: boolean;
  /** 本次请求实际采用的客户端类型 */
  clientType: string;
};

/**
 * 入口卡片：客户端据此渲染入口，**不能写死标题/图标**。
 */
export type AiAgentCard = {
  agentCode: string;
  name: string;
  /** MUSIC | ADMIN | QA | CUSTOM */
  agentType: string;
  description: string;
  /** 图标名（管理端配置，可能不在本端图标库里） */
  icon: string;
  /** 入口配置 JSON（文案、推荐问题等，形状由后台决定） */
  entryConfig: UTSJSONObject | null;
  capabilities: AiCapabilities;
};

/** 会话摘要 */
export type AiConversation = {
  id: number;
  agentCode: string;
  agentName: string;
  title: string;
  /** ACTIVE | CLOSED | DELETED */
  status: string;
  messageCount: number;
  pinned: boolean;
  lastMessageTime: string;
  createTime: string;
};

/** 引用来源（答疑/文档类回答用） */
export type AiCitation = {
  sourceId: number;
  sourceType: string;
  title: string;
  path: string;
  section: string;
  version: string;
  matchedText: string;
};

/**
 * 结构化数据块。
 *
 * `data` 的形状由智能体版本的 responseSchema 决定，客户端不能假设固定字段——
 * 渲染时按「认识就美化、不认识就原样列出」处理，后台换 schema 也不会白屏。
 */
export type AiBlock = {
  type: string;
  title: string;
  data: UTSJSONObject | null;
};

/** 可点动作（白名单，后端已过滤） */
export type AiAction = {
  actionId: string;
  /** PLAY_SONG / PLAY_LIST / ADD_TO_QUEUE / ADD_TO_FAVORITE / OPEN_SONG / ... */
  type: string;
  payload: UTSJSONObject | null;
};

/** 一条消息 */
export type AiMessage = {
  id: number;
  conversationId: number;
  requestId: number;
  /** USER | ASSISTANT | SYSTEM | TOOL */
  role: string;
  content: string;
  /** TEXT | STRUCTURED | TOOL_RESULT */
  contentType: string;
  /** PENDING | STREAMING | COMPLETED | FAILED | CANCELLED */
  status: string;
  blocks: AiBlock[];
  citations: AiCitation[];
  modelName: string;
  createTime: string;
};

/** 历史消息分页（向上翻旧消息，游标是 beforeId） */
export type AiMessagePage = {
  items: AiMessage[];
  nextCursor: number;
  hasMore: boolean;
};

/** 发送消息的受理结果 */
export type AiSendResult = {
  requestId: number;
  userMessageId: number;
  assistantMessageId: number;
  /** QUEUED 起步，后续靠轮询事件推进 */
  status: string;
  /** App 端恒为 true（后端异步跑），仅为对齐管理端契约保留 */
  stream: boolean;
};

/**
 * 事件（App 端没有 SSE，只能轮询 `/requests/{id}/events`）。
 *
 * 事件类型见后端 `AiConstants.EventType`：
 * request.created / message.started / message.delta / message.metadata /
 * tool.planned / tool.started / tool.progress / tool.approval_required /
 * tool.completed / recommendation.updated / message.citation /
 * message.completed / request.cancelled / request.failed
 */
export type AiEvent = {
  requestId: number;
  sequence: number;
  type: string;
  data: UTSJSONObject | null;
  createdAt: string;
};

/** 一轮轮询的返回 */
export type AiEventBatch = {
  requestId: number;
  status: string;
  events: AiEvent[];
  nextSequence: number;
  /** 请求已进入终态，可以停止轮询 */
  terminal: boolean;
};

/**
 * 客户端回传给模型的音乐候选。
 *
 * 后端 `MusicToolProvider.candidates()` 按 `sourceId/songId/name/artist/album/duration/coverUrl/quality/extra`
 * 逐字段解析，字段名必须完全一致，否则模型看到的是空候选。
 */
export type AiMusicCandidate = {
  sourceId: string;
  songId: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string;
  quality: string;
  extra: UTSJSONObject | null;
};

/** 本地保存的候选歌（把后端动作映射回真实 Song，播放/收藏都要它） */
export type AiCandidateSong = {
  candidate: AiMusicCandidate;
  /** 展示用的推荐理由（模型给的那句） */
  reason: string;
};

/** 会话内正在展示的一条消息（含流式中间态） */
export type AiChatMessage = {
  id: number;
  role: string;
  content: string;
  status: string;
  blocks: AiBlock[];
  citations: AiCitation[];
  actions: AiAction[];
  /** 正在流式接收（内容还在增长） */
  streaming: boolean;
  /** 本轮执行到哪一步（"正在搜索音乐…"） */
  progress: string;
  requestId: number;
  createTime: string;
  /** 失败原因（status=FAILED 时） */
  error: string;
};
