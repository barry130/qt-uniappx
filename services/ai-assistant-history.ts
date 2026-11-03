/**
 * 音乐助手的**本机会话存储**（rule / local 模式用）。
 *
 * ## 为什么本地模式不能复用服务端会话
 * 服务端会话（`/api/v1/app/ai/conversations`）的每一次读写都要登录态与网络：本地模式的
 * 全部意义就是「不登录也能用、断网也能用」。如果本地模式还去调会话接口，那用户切到
 * 「纯规则」之后助手就只剩空页面了——这恰好是我们这次要修掉的问题。
 *
 * ## 存的是什么
 * 只存**可重建的最小集**：每条消息的角色、正文、状态、时间，以及推荐歌单的候选数组
 * （`AiMusicCandidate[]`，字段与后端候选完全一致）。不存 `AiBlock` 本身，因为块里的
 * `data` 是 `UTSJSONObject`——它在安卓侧不是普通对象，`JSON.stringify` 出去再读回来
 * 会丢结构。读的时候按候选重建 `song_list` 块，展示与播放都不受影响。
 *
 * ## 容量与顺序
 * 只留最近 `MAX_CONVERSATIONS` 个会话、每个会话最近 `MAX_TURNS` 条消息：本地存储
 * 是所有 App 数据共用的，助手历史不能无限膨胀（一首歌的候选几十个字段，涨得很快）。
 * 最新会话永远排在最前（`unshift` 语义），历史浮层的顺序就与「最近说过什么」一致。
 */

import type { AiBlock, AiChatMessage, AiConversation, AiMusicCandidate } from "@/types/ai";
import { parseJsonToUtso } from "@/services/http";

/** 本地历史存储键（与服务端会话完全分离，卸载重装/清缓存才会丢） */
const LOCAL_HISTORY_KEY = "qt-ai-assistant.local";

/** 最多保留多少个本地会话 */
const MAX_CONVERSATIONS = 20;

/** 每个会话最多保留多少条消息（超出的从最旧的丢） */
const MAX_TURNS = 40;

/** 本地会话 id 的基数：日期时间戳，正整数，不会与服务端（数据库自增）冲突 */
export function newLocalConversationId(): number {
  return Date.now();
}

/** 落盘的一条消息（不含块，块由候选重建） */
type StoredTurn = {
  role: string;
  content: string;
  status: string;
  createTime: string;
  candidates: AiMusicCandidate[];
};

/** 落盘的一个会话 */
type StoredConversation = {
  id: number;
  title: string;
  updatedAt: number;
  turns: StoredTurn[];
};

type StoredRoot = {
  convs: StoredConversation[];
};

function readRoot(): StoredRoot {
  const empty: StoredRoot = { convs: [] };
  try {
    const raw = uni.getStorageSync(LOCAL_HISTORY_KEY);
    if (typeof raw != "string") return empty;
    const text = raw as string;
    if (text.length == 0) return empty;
    // 必须走 parseJsonToUtso：App 端 JSON.parse 的产物是普通对象、没有 .get
    //（见 services/http.ts 的 parseJsonToUtso 与 ttl-store.ts 同款说明），
    // 旧写法第一句就抛异常 → 每次读历史都按「空」处理，而写路径整 root 覆盖，
    // 存量会话就这样被一轮一轮销毁（2026-11-03）
    const parsed = parseJsonToUtso(text);
    const convs = parsed.get("convs");
    if (convs == null) return empty;
    const arr = convs as any[];
    if (!Array.isArray(arr)) return empty;
    const out: StoredConversation[] = [];
    for (let i = 0; i < arr.length; i++) {
      const c = normalizeConversation(arr[i] as UTSJSONObject);
      if (c != null) out.push(c);
    }
    return { convs: out };
  } catch (e) {
    // 存储损坏（升级/手工改库/写一半断电）时按「没有历史」处理：
    // 历史是附加价值，绝不能让助手因为读不出旧会话而打不开。
    return empty;
  }
}

function normalizeConversation(raw: UTSJSONObject | null): StoredConversation | null {
  if (raw == null) return null;
  const id = numOf(raw, "id");
  if (id <= 0) return null;
  const conv: StoredConversation = {
    id: id,
    title: strOf(raw, "title"),
    updatedAt: numOf(raw, "updatedAt"),
    turns: [],
  };
  const turnsRaw = raw.get("turns");
  if (turnsRaw == null) return conv;
  const arr = turnsRaw as any[];
  if (!Array.isArray(arr)) return conv;
  for (let i = 0; i < arr.length; i++) {
    const t = normalizeTurn(arr[i] as UTSJSONObject);
    if (t != null) conv.turns.push(t);
  }
  return conv;
}

function normalizeTurn(raw: UTSJSONObject | null): StoredTurn | null {
  if (raw == null) return null;
  const role = strOf(raw, "role");
  if (role.length == 0) return null;
  const turn: StoredTurn = {
    role: role,
    content: strOf(raw, "content"),
    status: strOf(raw, "status"),
    createTime: strOf(raw, "createTime"),
    candidates: [],
  };
  const cRaw = raw.get("candidates");
  if (cRaw == null) return turn;
  const arr = cRaw as any[];
  if (!Array.isArray(arr)) return turn;
  for (let i = 0; i < arr.length; i++) {
    const c = normalizeCandidate(arr[i] as UTSJSONObject);
    if (c != null) turn.candidates.push(c);
  }
  return turn;
}

function normalizeCandidate(raw: UTSJSONObject | null): AiMusicCandidate | null {
  if (raw == null) return null;
  const songId = strOf(raw, "songId");
  if (songId.length == 0) return null;
  const c: AiMusicCandidate = {
    sourceId: strOf(raw, "sourceId"),
    songId: songId,
    name: strOf(raw, "name"),
    artist: strOf(raw, "artist"),
    album: strOf(raw, "album"),
    duration: numOf(raw, "duration"),
    coverUrl: strOf(raw, "coverUrl"),
    quality: strOf(raw, "quality"),
    extra: null,
  };
  return c;
}

function writeRoot(root: StoredRoot): void {
  try {
    const convs: any[] = [];
    for (let i = 0; i < root.convs.length && i < MAX_CONVERSATIONS; i++) {
      const c = root.convs[i];
      const turns: any[] = [];
      const from = c.turns.length > MAX_TURNS ? c.turns.length - MAX_TURNS : 0;
      for (let j = from; j < c.turns.length; j++) {
        const t = c.turns[j];
        const items: any[] = [];
        for (let k = 0; k < t.candidates.length; k++) items.push(candidateJson(t.candidates[k]));
        const o = new UTSJSONObject();
        o.set("role", t.role);
        o.set("content", t.content);
        o.set("status", t.status);
        o.set("createTime", t.createTime);
        o.set("candidates", items);
        turns.push(o);
      }
      const o = new UTSJSONObject();
      o.set("id", c.id);
      o.set("title", c.title);
      o.set("updatedAt", c.updatedAt);
      o.set("turns", turns);
      convs.push(o);
    }
    const root2 = new UTSJSONObject();
    root2.set("convs", convs);
    uni.setStorageSync(LOCAL_HISTORY_KEY, JSON.stringify(root2));
  } catch (e) {
    // 静默：写失败不打断「发送消息」——本地历史是附加价值，内存里的消息照常显示，
    // 只是下次进来看不到这一轮。
  }
}

/** 本地历史浮层要的会话摘要（形状与服务端一致，页面不用分叉） */
export function listLocalConversations(): AiConversation[] {
  const root = readRoot();
  const out: AiConversation[] = [];
  for (let i = 0; i < root.convs.length; i++) {
    const c = root.convs[i];
    const conv: AiConversation = {
      id: c.id,
      agentCode: "local",
      agentName: "音乐助手",
      title: c.title,
      status: "ACTIVE",
      messageCount: c.turns.length,
      pinned: false,
      lastMessageTime: timeText(c.updatedAt),
      createTime: timeText(c.updatedAt),
    };
    out.push(conv);
  }
  return out;
}

/** 读一个本地会话的消息（块按候选重建） */
export function loadLocalMessages(id: number): AiChatMessage[] {
  const root = readRoot();
  const conv = findConversation(root, id);
  if (conv == null) return [];
  const out: AiChatMessage[] = [];
  for (let i = 0; i < conv.turns.length; i++) {
    const t = conv.turns[i];
    const m = newMessage(t.role, t.content);
    m.status = t.status.length > 0 ? t.status : "COMPLETED";
    m.createTime = t.createTime;
    if (t.candidates.length > 0) m.blocks.push(songListBlock(t.candidates));
    out.push(m);
  }
  return out;
}

/**
 * 落盘一个会话；`id <= 0` 时新分配一个并返回。
 *
 * 每次发送完都整段重写该会话：本地会话只有几十条消息，重写成本远低于维护
 * 「增量追加 + 恢复序号」的复杂度，而且天然幂等（重试不会写出重复轮次）。
 */
export function saveLocalConversation(id: number, title: string, messages: AiChatMessage[]): number {
  const root = readRoot();
  const realId = id > 0 ? id : newLocalConversationId();
  const turns: StoredTurn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const t: StoredTurn = {
      role: m.role,
      content: m.content,
      status: m.status,
      createTime: m.createTime,
      candidates: candidatesOfMessage(m),
    };
    turns.push(t);
  }
  const old = findConversation(root, realId);
  const conv: StoredConversation = {
    id: realId,
    title: title,
    updatedAt: Date.now(),
    turns: turns,
  };
  if (old != null) {
    // 原地替换但保持它在最前：重写一条旧会话也当作「最近用过」
    const at = indexOfConversation(root, realId);
    if (at >= 0) root.convs.splice(at, 1);
  }
  root.convs.unshift(conv);
  writeRoot(root);
  return realId;
}

/** 删一个本地会话（不存在也不报错：并发删除/重复点击都安全） */
export function deleteLocalConversation(id: number): void {
  const root = readRoot();
  const at = indexOfConversation(root, id);
  if (at < 0) return;
  root.convs.splice(at, 1);
  writeRoot(root);
}

/** 清空全部本地会话（调试/隐私开关用，暂时没有 UI 入口） */
export function clearLocalHistory(): void {
  writeRoot({ convs: [] });
}

// ==================== 内部工具 ====================

/**
 * 构造一条「已完成」的消息气泡。
 *
 * 刻意不从 `use-ai-chat` 借 `emptyChatMessage`：composable 反过来要 import 本模块，
 * 互相 import 在 UTS 打包时容易变成运行时 undefined（安卓侧首次取值报 null）。
 * 这里只有十几个字段，重复一次比跨层依赖安全。
 */
function newMessage(role: string, content: string): AiChatMessage {
  const m: AiChatMessage = {
    id: 0,
    role: role,
    content: content,
    status: "COMPLETED",
    blocks: [],
    citations: [],
    actions: [],
    streaming: false,
    progress: "",
    requestId: 0,
    createTime: timeText(Date.now()),
    error: "",
  };
  return m;
}

function findConversation(root: StoredRoot, id: number): StoredConversation | null {
  const at = indexOfConversation(root, id);
  return at >= 0 ? root.convs[at] : null;
}

function indexOfConversation(root: StoredRoot, id: number): number {
  for (let i = 0; i < root.convs.length; i++) {
    if (root.convs[i].id == id) return i;
  }
  return -1;
}

/** 从消息的 song_list 块里取回候选（与服务端块形状同源，页面渲染不分叉） */
function candidatesOfMessage(m: AiChatMessage): AiMusicCandidate[] {
  const out: AiMusicCandidate[] = [];
  for (let i = 0; i < m.blocks.length; i++) {
    const block = m.blocks[i];
    if (block.type != "song_list") continue;
    const data = block.data;
    if (data == null) continue;
    const items = data.get("items");
    if (items == null) continue;
    const arr = items as any[];
    if (!Array.isArray(arr)) continue;
    for (let j = 0; j < arr.length; j++) {
      const c = normalizeCandidate(arr[j] as UTSJSONObject);
      if (c != null) out.push(c);
    }
  }
  return out;
}

function songListBlock(candidates: AiMusicCandidate[]): AiBlock {
  const items: any[] = [];
  for (let i = 0; i < candidates.length; i++) items.push(candidateJson(candidates[i]));
  const data = new UTSJSONObject();
  data.set("items", items);
  const block: AiBlock = { type: "song_list", title: "", data: data };
  return block;
}

function candidateJson(c: AiMusicCandidate): UTSJSONObject {
  const o = new UTSJSONObject();
  o.set("sourceId", c.sourceId);
  o.set("songId", c.songId);
  o.set("name", c.name);
  o.set("artist", c.artist);
  o.set("album", c.album);
  o.set("duration", c.duration);
  o.set("coverUrl", c.coverUrl);
  if (c.quality.length > 0) o.set("quality", c.quality);
  return o;
}

function strOf(o: UTSJSONObject, key: string): string {
  const v = o.get(key);
  if (v == null) return "";
  return v.toString();
}

function numOf(o: UTSJSONObject, key: string): number {
  const v = o.get(key);
  if (v == null) return 0;
  if (typeof v == "number") return v as number;
  const n = parseFloat(v.toString());
  return isNaN(n) ? 0 : n;
}

/** 毫秒时间戳 → 「2026-10-30 13:35」；只用于历史列表展示 */
function timeText(ms: number): string {
  if (ms <= 0) return "";
  const d = new Date(ms);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = d.getHours();
  const mi = d.getMinutes();
  return d.getFullYear() + "-" + pad2(mm) + "-" + pad2(dd) + " " + pad2(hh) + ":" + pad2(mi);
}

function pad2(n: number): string {
  return n < 10 ? "0" + n.toString() : n.toString();
}
