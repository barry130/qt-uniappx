/**
 * AI 音乐助手对话状态机（qt-uniappx）
 *
 * 页面只负责渲染；轮询、事件归并、动作执行都在这里。qt-pc 复用同一套语义
 * （事件名、动作白名单、终态判定完全一致），所以这里**不能出现平台特有逻辑**。
 *
 * 两条硬约束（来自后端实现，不是取舍）：
 *
 * 1. **App 端没有 SSE**。`AiAppController` 只提供 `GET /requests/{id}/events`，
 *    所以推进方式是短轮询 + 游标 `nextSequence`，收到 `terminal=true` 停止。
 *
 * 2. **模型看不到真实候选**。`MusicToolProvider` 的四个搜索工具返回
 *    `NEED_CLIENT` 计划，但 `AiChatOrchestrator.executeTools` 把 `isOk()==true`
 *    的结果按 SUCCEEDED 收尾、继续下一轮模型调用，既不挂起请求、也不把计划写进
 *    事件，更没有回传候选的端点。所以客户端必须在**提交之前**自己搜索，把候选
 *    放进 `context.musicCandidates`——这是 `prepareCandidates()` 存在的唯一原因。
 */
import { ref, computed } from "vue";
import { usePlayerStore } from "@/stores/player";
import { useSourceRegistryStore } from "@/stores/source-registry";
import { musicApi } from "@/services/music-api";
import { qtShowToast } from "@/services/toast";
import {
  AI_CANDIDATE_MAX,
  AI_MESSAGE_MAX_CHARS,
  actionLabel,
  cancelRequest,
  candidateFromSong,
  candidatesToJson,
  createConversation,
  deleteConversation,
  fetchAgents,
  fetchCapabilities,
  fetchConversations,
  fetchEvents,
  fetchMessages,
  normalizeAction,
  normalizeBlock,
  normalizeCitation,
  reportAction,
  sendFeedback,
  sendMessage,
  songFromCandidate,
} from "@/services/ai";
import type {
  AiAction,
  AiAgentCard,
  AiBlock,
  AiCapabilities,
  AiChatMessage,
  AiCitation,
  AiConversation,
  AiMusicCandidate,
  AiMessage,
} from "@/types/ai";
import type { Song } from "@/types/music";

/** 轮询间隔：后端事件是 300ms 落库节奏，700ms 足够且不浪费流量 */
const POLL_INTERVAL_MS = 700;

/** 单轮请求的最长轮询时长：兜底防止后端卡死把界面拖住 */
const POLL_MAX_MS = 180000;

/** 后台没配 entryConfig 时的兜底推荐问题 */
const DEFAULT_SUGGESTIONS: string[] = [
  "随便来点适合晚上写代码的歌",
  "推荐几首最近很火的国风",
  "我想听周杰伦，但不要情歌",
  "来点适合跑步的快歌",
];

/** 搜索词清洗用的意图词：留在关键词里只会拉低命中率 */
const FILLER_WORDS: string[] = [
  "帮我",
  "帮忙",
  "给我",
  "我要",
  "我想",
  "想听",
  "推荐",
  "来一首",
  "来几首",
  "来点",
  "几首",
  "一首",
  "播放",
  "放一首",
  "找一下",
  "找找",
  "搜索",
  "搜一下",
  "有没有",
  "什么歌",
  "的歌",
  "歌曲",
  "听听",
  "适合",
];

export function useAiChat() {
  const player = usePlayerStore();
  const registry = useSourceRegistryStore();

  /** 当前智能体（后端按客户端过滤后列表里的第一个 MUSIC 类型） */
  const agent = ref<AiAgentCard | null>(null);
  const capabilities = ref<AiCapabilities | null>(null);
  const conversations = ref<AiConversation[]>([]);
  const activeConversationId = ref(0);
  const messages = ref<AiChatMessage[]>([]);

  const loading = ref(false);
  const loadingMessages = ref(false);
  const sending = ref(false);
  const error = ref("");

  /** 正在跑的请求（0 表示空闲） */
  const runningRequestId = ref(0);
  let pollTimer: number | null = null;
  let pollStartedAt = 0;
  /** 读取序号：切会话时旧响应晚到不得写进新会话 */
  let loadSeq = 0;
  /** 上一轮候选搜索用的关键词与页码：追问（「再来点」）时沿用主题、往后翻页 */
  let lastSearchKeyword = "";
  let lastSearchPage = 1;

  const agentName = computed((): string => {
    const a = agent.value;
    return a != null ? a.name : "音乐助手";
  });

  const suggestions = computed((): string[] => {
    const a = agent.value;
    if (a == null || a.entryConfig == null) return DEFAULT_SUGGESTIONS;
    const raw = a.entryConfig.get("suggestions");
    if (raw == null) return DEFAULT_SUGGESTIONS;
    const list = raw as any[];
    if (!Array.isArray(list)) return DEFAULT_SUGGESTIONS;
    const out: string[] = [];
    for (let i = 0; i < list.length && i < 6; i++) {
      const v = list[i];
      if (v != null) out.push(v.toString());
    }
    return out.length > 0 ? out : DEFAULT_SUGGESTIONS;
  });

  const isEmpty = computed((): boolean => messages.value.length == 0);

  // ==================== 初始化 ====================

  /** 拉智能体与能力；失败原样展示后端错误（多半是未发布 / 无权限 / 未登录） */
  async function init(): Promise<boolean> {
    loading.value = true;
    error.value = "";
    try {
      const list = await fetchAgents();
      let picked: AiAgentCard | null = null;
      for (let i = 0; i < list.length; i++) {
        if (list[i].agentType == "MUSIC") {
          picked = list[i];
          break;
        }
      }
      if (picked == null && list.length > 0) picked = list[0];
      agent.value = picked;
      if (picked == null) {
        error.value = "后台还没有可用的音乐助手，请联系管理员在「AI 助手 → 智能体」里发布";
        return false;
      }
      capabilities.value = await fetchCapabilities(picked.agentCode);
      await loadConversations();
      return true;
    } catch (e) {
      error.value = errText(e);
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function loadConversations(): Promise<void> {
    const a = agent.value;
    if (a == null) return;
    try {
      conversations.value = await fetchConversations(a.agentCode);
    } catch (e) {
      // 会话列表失败不挡主流程：第一次进来本来就没有会话
      conversations.value = [];
    }
  }

  /**
   * 打开会话并载入最近消息。
   *
   * 传 0 表示「新对话」：只清空本地，等用户开口后再真正建会话，
   * 免得每进一次页面就在后台堆一堆空会话。
   */
  async function openConversation(id: number): Promise<void> {
    stopPolling();
    const seq = ++loadSeq;
    activeConversationId.value = id;
    messages.value = [];
    error.value = "";
    if (id <= 0) return;
    loadingMessages.value = true;
    try {
      const page = await fetchMessages(id, 0, 30);
      if (seq != loadSeq) return;
      const out: AiChatMessage[] = [];
      for (let i = 0; i < page.items.length; i++) {
        const m = page.items[i];
        if (m.role == "TOOL" || m.role == "SYSTEM") continue;
        out.push(toChatMessage(m));
      }
      messages.value = out;
    } catch (e) {
      if (seq == loadSeq) error.value = errText(e);
    } finally {
      if (seq == loadSeq) loadingMessages.value = false;
    }
  }

  /** 新建对话：本地清空，建会话推迟到首次发送 */
  function newConversation(): void {
    stopPolling();
    loadSeq++;
    activeConversationId.value = 0;
    messages.value = [];
    error.value = "";
    sending.value = false;
    runningRequestId.value = 0;
  }

  async function removeConversation(id: number): Promise<void> {
    try {
      await deleteConversation(id);
      if (activeConversationId.value == id) newConversation();
      await loadConversations();
      qtShowToast({ title: "已删除", icon: "none" });
    } catch (e) {
      qtShowToast({ title: errText(e), icon: "none" });
    }
  }

  // ==================== 发送 ====================

  /**
   * 发消息主流程：本地搜索候选 → 建会话（首次）→ 提交 → 轮询事件。
   *
   * 搜索必须发生在提交之前：`musicCandidates` 是请求上下文的一部分，
   * 后端在受理时就快照了上下文，提交后再补来不及。
   */
  async function send(text: string): Promise<void> {
    const content = text.trim();
    if (content.length == 0 || sending.value) return;
    if (content.length > AI_MESSAGE_MAX_CHARS) {
      qtShowToast({ title: "消息太长了，请分几次说", icon: "none" });
      return;
    }
    const a = agent.value;
    if (a == null) {
      qtShowToast({ title: "音乐助手还没准备好", icon: "none" });
      return;
    }

    sending.value = true;
    error.value = "";

    // 1) 先铺两条本地气泡：用户话 + 助手「思考中」
    const userBubble = emptyChatMessage("USER", content);
    userBubble.status = "COMPLETED";
    messages.value = messages.value.concat([userBubble]);
    const assistantBubble = emptyChatMessage("ASSISTANT", "");
    assistantBubble.streaming = true;
    assistantBubble.progress = "正在理解你的需求…";
    messages.value = messages.value.concat([assistantBubble]);
    const at = messages.value.length - 1;

    try {
      // 2) 本地多音源搜索（失败不阻断，只是模型少了候选）
      const candidates = await prepareCandidates(content);

      // 3) 首次发消息才建会话
      if (activeConversationId.value <= 0) {
        const conv = await createConversation(a.agentCode, titleOf(content));
        activeConversationId.value = conv.id;
        await loadConversations();
      }

      // 4) 提交
      const context = buildContext(candidates);
      const idem = "m" + Date.now() + "-" + at;
      const resp = await sendMessage(activeConversationId.value, content, context, idem);
      runningRequestId.value = resp.requestId;
      patchMessage(at, (m) => {
        m.requestId = resp.requestId;
        m.id = resp.assistantMessageId;
        m.progress = "正在生成回答…";
      });

      // 5) 开轮询
      startPolling(resp.requestId, at);
    } catch (e) {
      const msg = errText(e);
      error.value = msg;
      patchMessage(at, (m) => {
        m.status = "FAILED";
        m.streaming = false;
        m.progress = "";
        m.error = msg;
        m.content = "请求失败：" + msg;
      });
      sending.value = false;
    }
  }

  /** 中止当前请求（后端幂等，重复取消不报错） */
  async function stop(): Promise<void> {
    const rid = runningRequestId.value;
    if (rid <= 0) return;
    stopPolling();
    try {
      await cancelRequest(rid, "用户主动停止");
    } catch (e) {
      // 取消失败也照样停本地轮询，否则界面永远卡在「思考中」
    }
    const idx = indexOfRequest(rid);
    if (idx >= 0) {
      patchMessage(idx, (m) => {
        m.status = "CANCELLED";
        m.streaming = false;
        m.progress = "";
        if (m.content.length == 0) m.content = "已停止";
      });
    }
    runningRequestId.value = 0;
    sending.value = false;
  }

  // ==================== 轮询 ====================

  function startPolling(requestId: number, messageIndex: number): void {
    stopPolling();
    pollStartedAt = Date.now();
    let cursor = 0;
    let finished = false;

    const tick = async (): Promise<void> => {
      if (finished) return;
      if (Date.now() - pollStartedAt > POLL_MAX_MS) {
        finished = true;
        patchMessage(messageIndex, (m) => {
          m.streaming = false;
          m.status = "FAILED";
          m.progress = "";
          m.error = "等待超时，请稍后重试";
          if (m.content.length == 0) m.content = "等待超时，请稍后重试";
        });
        runningRequestId.value = 0;
        sending.value = false;
        return;
      }
      try {
        const batch = await fetchEvents(requestId, cursor, 100);
        if (batch.nextSequence > cursor) cursor = batch.nextSequence;
        for (let i = 0; i < batch.events.length; i++) {
          applyEvent(batch.events[i].type, batch.events[i].data, messageIndex);
        }
        if (batch.terminal) {
          finished = true;
          finalizeMessage(messageIndex, batch.status);
          // 终态后回读落库消息：万一终态事件没读到，本地还是半截 JSON
          const convId = activeConversationId.value;
          const msgId = messages.value[messageIndex].id;
          reconcileMessage(convId, msgId, messageIndex);
          runningRequestId.value = 0;
          sending.value = false;
          return;
        }
      } catch (e) {
        // 单次轮询失败不终止：网络抖一下就要用户重发太脆
        error.value = errText(e);
      }
      if (finished || disposed) return;
      pollTimer = setTimeout(() => {
        tick();
      }, POLL_INTERVAL_MS);
    };

    tick();
  }

  function stopPolling(): void {
    if (pollTimer != null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  /**
   * dispose 置位后轮询彻底停转：stopPolling 只能清「已排队的 timeout」，
   * 挡不住在途 fetchEvents 返回后重挂下一个 timeout（页面销毁后继续
   * 每 700ms 打后端直到兜底时长，还往已销毁页面写状态）。
   */
  let disposed = false;

  /**
   * 事件归并。
   *
   * 字段名严格照后端：`message.delta` 的增量是 `delta`（不是 content），
   * 只有 `message.completed` 才带完整 content / blocks / actions。
   */
  function applyEvent(type: string, data: UTSJSONObject | null, messageIndex: number): void {
    if (data == null) return;

    if (type == "message.started") {
      patchMessage(messageIndex, (m) => {
        m.streaming = true;
        m.status = "STREAMING";
      });
      return;
    }

    if (type == "message.delta") {
      const delta = strOf(data, "delta");
      if (delta.length == 0) return;
      patchMessage(messageIndex, (m) => {
        m.content = m.content + delta;
        m.streaming = true;
        m.status = "STREAMING";
        m.progress = "";
      });
      return;
    }

    if (type == "tool.planned" || type == "tool.started") {
      const code = strOf(data, "toolCode");
      patchMessage(messageIndex, (m) => {
        m.progress = toolProgressLabel(code);
      });
      return;
    }

    if (type == "tool.completed") {
      patchMessage(messageIndex, (m) => {
        m.progress = "";
      });
      return;
    }

    if (type == "message.citation") {
      const citations = citationList(data.get("citations"));
      if (citations.length == 0) return;
      patchMessage(messageIndex, (m) => {
        m.citations = citations;
      });
      return;
    }

    if (type == "recommendation.updated") {
      const actions = actionList(data.get("actions"));
      patchMessage(messageIndex, (m) => {
        m.actions = actions;
      });
      return;
    }

    if (type == "message.completed") {
      const content = strOf(data, "content");
      const blocks = blockList(data.get("blocks"));
      const actions = actionList(data.get("actions"));
      patchMessage(messageIndex, (m) => {
        if (content.length > 0) m.content = content;
        m.blocks = blocks;
        m.actions = actions;
        m.status = "COMPLETED";
        m.streaming = false;
        m.progress = "";
      });
      return;
    }

    if (type == "request.failed") {
      const msg = strOf(data, "message");
      patchMessage(messageIndex, (m) => {
        m.status = "FAILED";
        m.streaming = false;
        m.progress = "";
        m.error = msg.length > 0 ? msg : "请求失败";
        if (m.content.length == 0) m.content = "请求失败：" + m.error;
      });
      return;
    }

    if (type == "request.cancelled") {
      patchMessage(messageIndex, (m) => {
        m.status = "CANCELLED";
        m.streaming = false;
        m.progress = "";
        if (m.content.length == 0) m.content = "已停止";
      });
    }
  }

  /** 终态收尾：把仍空着的气泡补成可读文案，别留一个空气泡 */
  function finalizeMessage(index: number, status: string): void {
    patchMessage(index, (m) => {
      m.streaming = false;
      m.progress = "";
      if (m.status != "FAILED" && m.status != "CANCELLED") {
        m.status = status.length > 0 ? status : "SUCCEEDED";
      }
      if (m.content.length == 0 && m.blocks.length == 0) {
        if (m.status == "CANCELLED") {
          m.content = "已停止";
        } else if (m.status == "FAILED") {
          m.content = m.error.length > 0 ? m.error : "请求失败";
        } else {
          m.content = "没有拿到回答，换个说法再试试";
        }
      }
    });
  }

  /**
   * 终态兜底：用服务端落库的最终消息覆盖本地气泡。
   *
   * 事件是分批拉的，一旦终态事件没读到，气泡里剩下的就是流式增量拼出来的
   * 半截原始 JSON —— 文案与歌曲卡片全无。服务端 `ai_message` 存的一定是
   * 解析后的干净结果，所以终态后回读一次最保险。
   */
  async function reconcileMessage(
    conversationId: number,
    assistantMessageId: number,
    index: number
  ): Promise<void> {
    if (conversationId <= 0 || assistantMessageId <= 0) return;
    try {
      const page = await fetchMessages(conversationId, 0);
      let saved: AiMessage | null = null;
      for (let i = 0; i < page.items.length; i++) {
        if (page.items[i].id == assistantMessageId) {
          saved = page.items[i];
          break;
        }
      }
      if (saved === null) return;
      const found = saved as AiMessage;
      patchMessage(index, (m) => {
        if (found.content.length > 0) m.content = found.content;
        if (found.blocks.length > 0) m.blocks = found.blocks;
        if (found.citations.length > 0) m.citations = found.citations;
      });
    } catch (e) {
      // 回读失败不影响已经显示的内容
    }
  }

  // ==================== 请求上下文 ====================

  /**
   * 组装请求上下文。
   *
   * 只放后端白名单认的键（`AiConstants.ContextKey.musicKeys()`）：多余的键会被
   * `sanitizeContext` 静默丢弃，白拼一遍没意义。
   */
  function buildContext(candidates: AiMusicCandidate[]): UTSJSONObject {
    const ctx = new UTSJSONObject();

    const cur = player.current;
    if (cur != null) ctx.set("currentSong", songJson(cur));

    const queue = player.queue;
    if (queue.length > 0) {
      const list: any[] = [];
      const n = queue.length > 10 ? 10 : queue.length;
      for (let i = 0; i < n; i++) list.push(songJson(queue[i]));
      ctx.set("currentQueue", list);
    }

    const history = player.history;
    if (history.length > 0) {
      const recent: any[] = [];
      const n = history.length > 8 ? 8 : history.length;
      for (let i = 0; i < n; i++) recent.push(songJson(history[i]));
      ctx.set("recentlyPlayedSummary", recent);
    }

    const liked = player.likedSongs;
    if (liked.length > 0) {
      const pref = new UTSJSONObject();
      pref.set("likedCount", liked.length);
      const singers = topSingers(liked, 5);
      if (singers.length > 0) pref.set("topArtists", singers);
      ctx.set("userPreferenceSummary", pref);
    }

    const sources = registry.sources;
    if (sources.length > 0) {
      const ids: any[] = [];
      for (let i = 0; i < sources.length; i++) ids.push(sources[i].id);
      ctx.set("installedSourceRegistry", ids);
    }

    if (candidates.length > 0) ctx.set("musicCandidates", candidatesToJson(candidates));

    return ctx;
  }

  /**
   * 本地多音源搜索，把结果标准化为后端认识的候选。
   *
   * 未装音源包 / 引擎未就绪时 `allSearch` 会抛错或返回空——都按「没有候选」处理，
   * 绝不因为搜索失败挡住对话本身。
   */
  async function prepareCandidates(content: string): Promise<AiMusicCandidate[]> {
    const keyword = searchKeyword(content);
    // 「再来点/换一批」这类追问没有新主题词：用退化词（如「来20首」）重搜只会
    // 捞回与上一轮主题无关的垃圾候选。沿用上一轮搜索词，把候选池往前翻页。
    const isFollowUp = isFollowUpWithoutTopic(content, keyword);
    const effective = isFollowUp && lastSearchKeyword.length > 0 ? lastSearchKeyword : keyword;
    if (effective.length == 0) return [];
    const page = isFollowUp ? lastSearchPage + 1 : 1;
    if (!isFollowUp) {
      lastSearchKeyword = keyword;
    }
    lastSearchPage = page;
    let songs: Song[] = [];
    try {
      await registry.ensure();
      songs = await musicApi.allSearch(effective, page, AI_CANDIDATE_MAX);
    } catch (e) {
      return [];
    }
    const out: AiMusicCandidate[] = [];
    const seen: string[] = [];
    for (let i = 0; i < songs.length && out.length < AI_CANDIDATE_MAX; i++) {
      const s = songs[i];
      if (s == null) continue;
      const key = s.platform + "/" + s.id;
      if (seen.indexOf(key) >= 0) continue;
      seen.push(key);
      out.push(candidateFromSong(s));
    }
    // 翻页翻到底（没有新歌）：退回第 1 页补齐，宁多勿空
    if (out.length == 0 && page > 1) {
      lastSearchPage = 1;
      try {
        songs = await musicApi.allSearch(effective, 1, AI_CANDIDATE_MAX);
      } catch (e) {
        return out;
      }
      for (let i = 0; i < songs.length && out.length < AI_CANDIDATE_MAX; i++) {
        const s = songs[i];
        if (s == null) continue;
        const key = s.platform + "/" + s.id;
        if (seen.indexOf(key) >= 0) continue;
        seen.push(key);
        out.push(candidateFromSong(s));
      }
    }
    return out;
  }

  // ==================== 动作 ====================

  /**
   * 执行模型建议的动作。
   *
   * 只认后端 `AiConstants.ActionType` 那 9 个值，其余一律忽略——后台换 Prompt
   * 让模型吐出奇怪的 type 也不会被这里当成命令执行。
   */
  async function runAction(action: AiAction, messageIndex: number): Promise<void> {
    const type = action.type;
    const payload = action.payload;
    const songId = payload != null ? strOf(payload, "songId") : "";
    const sourceId = payload != null ? strOf(payload, "sourceId") : "";
    const keyword = payload != null ? strOf(payload, "keyword") : "";
    let ok = false;
    let note = "";

    if (type == "PLAY_SONG") {
      const song = findSong(songId, sourceId, messageIndex);
      if (song != null) {
        await player.playSingle(song);
        ok = true;
        note = "已开始播放";
      } else {
        note = "没找到这首歌，可能候选已过期";
      }
    } else if (type == "PLAY_LIST") {
      const songs = songsOfMessage(messageIndex);
      if (songs.length > 0) {
        await player.play(songs[0], songs);
        ok = true;
        note = "已按推荐顺序播放";
      } else {
        note = "这条消息里没有可播放的歌曲";
      }
    } else if (type == "ADD_TO_QUEUE") {
      const song = findSong(songId, sourceId, messageIndex);
      if (song != null) {
        player.addToQueue(song);
        ok = true;
        note = "已加入播放队列";
      } else {
        const songs = songsOfMessage(messageIndex);
        if (songs.length > 0) {
          player.enqueueMany(songs);
          ok = true;
          note = "已把推荐加入队列";
        } else {
          note = "没找到可加入的歌曲";
        }
      }
    } else if (type == "ADD_TO_FAVORITE") {
      const song = findSong(songId, sourceId, messageIndex);
      if (song != null) {
        // 复用播放器自带的歌单选择器，不另造一套收藏逻辑
        player.showPlaylistPickerFor(song);
        ok = true;
        note = "选一个歌单收藏";
      } else {
        note = "没找到这首歌";
      }
    } else if (type == "OPEN_SONG") {
      const song = findSong(songId, sourceId, messageIndex);
      if (song != null) {
        await player.playSingle(song);
        uni.navigateTo({ url: "/pages/player/index" });
        ok = true;
      } else {
        note = "没找到这首歌";
      }
    } else if (type == "OPEN_ARTIST") {
      const artist = payload != null ? strOf(payload, "artist") : "";
      if (artist.length > 0) {
        uni.navigateTo({ url: "/pages/artist/index?name=" + encodeURIComponent(artist) });
        ok = true;
      } else {
        note = "要打开的歌手是空的";
      }
    } else if (type == "OPEN_ALBUM" || type == "OPEN_PLAYLIST") {
      note = "这个动作暂不支持，可以让我播放或加入队列";
    } else if (type == "SEARCH_MUSIC") {
      const kw = keyword.length > 0 ? keyword : lastUserText();
      if (kw.length > 0) {
        uni.navigateTo({ url: "/pages/search/index?keyword=" + encodeURIComponent(kw) });
        ok = true;
      } else {
        note = "没有可以搜索的词";
      }
    } else {
      note = "不认识的动作：" + type;
    }

    if (note.length > 0) qtShowToast({ title: note, icon: "none" });

    // 真的执行过才回执，避免把「不支持」也算成采纳
    if (ok) {
      try {
        await reportAction(action.actionId, type, true, note);
      } catch (e) {
        // 回执失败不影响用户，后台只少一条采纳统计
      }
    }
  }

  /** 从某条消息的 song_list 块里取候选歌 */
  function songsOfMessage(messageIndex: number): Song[] {
    const out: Song[] = [];
    if (messageIndex < 0 || messageIndex >= messages.value.length) return out;
    const msg = messages.value[messageIndex];
    for (let i = 0; i < msg.blocks.length; i++) {
      const data = msg.blocks[i].data;
      if (data == null) continue;
      const items = data.get("items");
      if (items == null) continue;
      const arr = items as any[];
      if (!Array.isArray(arr)) continue;
      for (let j = 0; j < arr.length; j++) {
        const s = songOfItem(arr[j] as UTSJSONObject);
        if (s != null) out.push(s);
      }
    }
    return out;
  }

  /**
   * 找动作指向的歌：只在**本条消息**的候选里找。
   *
   * 拿历史会话里的旧对象去播会播到一个已经不存在的条码；模型给的 songId
   * 本来也只属于本轮候选。
   */
  function findSong(songId: string, sourceId: string, messageIndex: number): Song | null {
    if (songId.length == 0) return null;
    if (messageIndex < 0 || messageIndex >= messages.value.length) return null;
    const msg = messages.value[messageIndex];
    for (let i = 0; i < msg.blocks.length; i++) {
      const data = msg.blocks[i].data;
      if (data == null) continue;
      const items = data.get("items");
      if (items == null) continue;
      const arr = items as any[];
      if (!Array.isArray(arr)) continue;
      for (let j = 0; j < arr.length; j++) {
        const item = arr[j] as UTSJSONObject;
        const sid = strOf(item, "songId");
        const src = strOf(item, "sourceId");
        if (sid == songId && (sourceId.length == 0 || src == sourceId)) {
          return songOfItem(item);
        }
      }
    }
    return null;
  }

  // ==================== 反馈 ====================

  async function like(messageIndex: number, good: boolean): Promise<void> {
    if (messageIndex < 0 || messageIndex >= messages.value.length) return;
    const m = messages.value[messageIndex];
    if (m.id <= 0) return;
    try {
      await sendFeedback(m.id, good ? "LIKE" : "DISLIKE", "", "");
      qtShowToast({ title: good ? "谢谢，已记录" : "已记录，我会注意", icon: "none" });
    } catch (e) {
      qtShowToast({ title: errText(e), icon: "none" });
    }
  }

  // ==================== 内部 ====================

  /** 就地改一条消息（元素经 ref 深代理，改属性即触发重渲染） */
  function patchMessage(index: number, fn: (m: AiChatMessage) => void): void {
    if (index < 0 || index >= messages.value.length) return;
    fn(messages.value[index]);
  }

  function indexOfRequest(requestId: number): number {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i];
      if (m.requestId == requestId && m.role == "ASSISTANT") return i;
    }
    return -1;
  }

  function lastUserText(): string {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role == "USER") return messages.value[i].content;
    }
    return "";
  }

  function dispose(): void {
    disposed = true;
    stopPolling();
  }

  return {
    agent,
    capabilities,
    agentName,
    conversations,
    activeConversationId,
    messages,
    suggestions,
    isEmpty,
    loading,
    loadingMessages,
    sending,
    error,
    runningRequestId,
    init,
    loadConversations,
    openConversation,
    newConversation,
    removeConversation,
    send,
    stop,
    runAction,
    like,
    dispose,
  };
}

// ==================== 纯函数（页面与测试共用） ====================

/** 造一条本地消息壳 */
export function emptyChatMessage(role: string, content: string): AiChatMessage {
  const msg: AiChatMessage = {
    id: 0,
    role: role,
    content: content,
    status: "PENDING",
    blocks: [],
    citations: [],
    actions: [],
    streaming: false,
    progress: "",
    requestId: 0,
    createTime: "",
    error: "",
  };
  return msg;
}

/** 后端消息 → 本地消息 */
export function toChatMessage(m: AiMessage): AiChatMessage {
  const out = emptyChatMessage(m.role, m.content);
  out.id = m.id;
  out.status = m.status;
  out.blocks = m.blocks;
  out.citations = m.citations;
  out.requestId = m.requestId;
  out.createTime = m.createTime;
  return out;
}

/** 会话标题：用户第一句话的前 20 字 */
export function titleOf(content: string): string {
  const t = content.replace(/\s+/g, " ").trim();
  return t.length > 20 ? t.substring(0, 20) : t;
}

/**
 * 从自然语言里抽搜索词。
 *
 * 不做分词（UTS 侧没有可靠的中文分词）：先去标点，再摘掉常见意图词，
 * 剩下的是「歌手 / 风格 / 心情」这些真正进搜索引擎的词。
 * 全被摘空时回落原文——宁可搜得宽，也不能不搜。
 */
export function searchKeyword(content: string): string {
  let text = content.replace(/[，。！？、,.!?~～;；:：\-—()（）"“”'‘’]+/g, " ");
  for (let i = 0; i < FILLER_WORDS.length; i++) {
    text = text.split(FILLER_WORDS[i]).join(" ");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length == 0) text = content.replace(/\s+/g, " ").trim();
  if (text.length > 40) text = text.substring(0, 40);
  return text;
}

/** 追问短语：「再来点/换一批」这类话没有新主题词，应沿用上一轮搜索词而不是退化重搜 */
const FOLLOW_UP_PHRASES: string[] = [
  "再来点",
  "再来几首",
  "再找点",
  "再推荐",
  "换一批",
  "换一组",
  "还有吗",
  "多来点",
  "多来几首",
  "继续",
  "更多",
  "不够",
  "就这些吗",
  "还有别的吗",
];

/**
 * 追问检测：与 qt-pc `isFollowUpWithoutTopic` 语义一致。
 *
 * 用户这轮话很短且含追问短语，或抽出来的词只剩量词/数字（「来20首」→「20首」），
 * 就判定为没有新主题的追问，调用方应复用上一轮搜索词往后翻页。
 */
export function isFollowUpWithoutTopic(content: string, keyword: string): boolean {
  let original = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content.charAt(i);
    if (ch != " " && ch != "\t" && ch != "\n" && ch != "\r") original += ch;
  }
  if (original.length > 8) return false;
  for (let i = 0; i < FOLLOW_UP_PHRASES.length; i++) {
    if (original.indexOf(FOLLOW_UP_PHRASES[i]) >= 0) return true;
  }
  let stripped = "";
  for (let i = 0; i < keyword.length; i++) {
    const ch = keyword.charAt(i);
    const isDigit = (ch >= "0" && ch <= "9") || (ch >= "０" && ch <= "９");
    const isCountWord = ch == "首" || ch == "f" || ch == "d" || ch == "s" || ch == "b"
      || ch == "F" || ch == "D" || ch == "S" || ch == "B";
    if (!isDigit && !isCountWord) stripped += ch;
  }
  return stripped.trim().length == 0 && keyword.length > 0;
}

/** 工具编码 → 进行中的中文提示 */
export function toolProgressLabel(toolCode: string): string {
  if (
    toolCode == "search_music" ||
    toolCode == "search_artist" ||
    toolCode == "search_album" ||
    toolCode == "search_playlist"
  ) {
    return "正在搜索音乐…";
  }
  if (toolCode == "get_song_detail") return "正在看这首歌的详情…";
  if (toolCode == "get_current_song" || toolCode == "get_current_playlist") return "正在读当前播放…";
  if (toolCode == "get_user_likes" || toolCode == "get_play_history") return "正在参考你的口味…";
  return "正在处理…";
}

/** 动作按钮文案 */
export function actionText(action: AiAction): string {
  return actionLabel(action.type);
}

/** 请求状态的中文（只有非成功态会显示给人看） */
export function statusText(status: string): string {
  if (status == "CANCELLED") return "已停止";
  if (status == "FAILED") return "失败";
  return "";
}

// ==================== 派生辅助 ====================

/**
 * 把 `song_list` 块的 `data.items` 还原成 Song。
 *
 * 块的 data 是后端原样落库的候选对象（sourceId/songId/name/...），字段名与
 * `AiMusicCandidate` 一致；不认识的块类型返回空数组，页面就只显示标题。
 */
export function songsOfBlock(block: AiBlock): Song[] {
  const out: Song[] = [];
  const data = block.data;
  if (data == null) return out;
  const items = data.get("items");
  if (items == null) return out;
  const arr = items as any[];
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length; i++) {
    const s = songOfItem(arr[i] as UTSJSONObject);
    if (s != null) out.push(s);
  }
  return out;
}

function songOfItem(item: UTSJSONObject): Song | null {
  const songId = strOf(item, "songId");
  if (songId.length == 0) return null;
  const candidate: AiMusicCandidate = {
    sourceId: strOf(item, "sourceId"),
    songId: songId,
    name: strOf(item, "name"),
    artist: strOf(item, "artist"),
    album: strOf(item, "album"),
    duration: numOf(item, "duration"),
    coverUrl: strOf(item, "coverUrl"),
    quality: strOf(item, "quality"),
    extra: null,
  };
  return songFromCandidate(candidate);
}

function songJson(song: Song): UTSJSONObject {
  const o = new UTSJSONObject();
  o.set("id", song.id);
  o.set("name", song.name);
  o.set("singer", song.singer);
  o.set("album", song.album);
  o.set("platform", song.platform);
  const d = song.duration;
  if (d != null && d > 0) o.set("duration", d);
  return o;
}

/** 从收藏里挑出现最多的几位歌手（给模型一点口味线索） */
function topSingers(songs: Song[], limit: number): string[] {
  const names: string[] = [];
  const counts: number[] = [];
  for (let i = 0; i < songs.length; i++) {
    const s = songs[i].singer;
    if (s == null || s.length == 0) continue;
    const at = names.indexOf(s);
    if (at >= 0) {
      counts[at] = counts[at] + 1;
    } else {
      names.push(s);
      counts.push(1);
    }
  }
  // 候选通常只有几十个歌手，选择排序足够，不值得引依赖
  const picked: string[] = [];
  while (picked.length < limit && names.length > 0) {
    let best = 0;
    for (let i = 1; i < counts.length; i++) {
      if (counts[i] > counts[best]) best = i;
    }
    picked.push(names[best]);
    names.splice(best, 1);
    counts.splice(best, 1);
  }
  return picked;
}

function citationList(raw: any): AiCitation[] {
  const out: AiCitation[] = [];
  if (raw == null) return out;
  const arr = raw as any[];
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length; i++) out.push(normalizeCitation(arr[i] as UTSJSONObject));
  return out;
}

function actionList(raw: any): AiAction[] {
  const out: AiAction[] = [];
  if (raw == null) return out;
  const arr = raw as any[];
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length; i++) out.push(normalizeAction(arr[i] as UTSJSONObject));
  return out;
}

function blockList(raw: any): AiBlock[] {
  const out: AiBlock[] = [];
  if (raw == null) return out;
  const arr = raw as any[];
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length; i++) out.push(normalizeBlock(arr[i] as UTSJSONObject));
  return out;
}

function strOf(o: UTSJSONObject, key: string): string {
  const v = o.get(key);
  return v != null ? v.toString() : "";
}

function numOf(o: UTSJSONObject, key: string): number {
  const v = o.get(key);
  if (v == null) return 0;
  const n = parseFloat(v.toString());
  return isNaN(n) ? 0 : n;
}

function errText(e: any): string {
  if (e == null) return "操作失败";
  const msg = (e as Error).message;
  return msg != null && msg.length > 0 ? msg : "操作失败";
}
