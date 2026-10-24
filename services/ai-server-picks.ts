/**
 * 每日推荐的「服务端 AI」取数：借音乐助手的 astral 会话跑一次就扔。
 *
 * 与 qt-pc/src/lib/ai-server-picks.ts 同一套口径（为什么单独一个文件、会话
 * 用完即删、失败一律抛错不静默兜底，见那边的头注释）：
 * 1. `daily-recommend.ts` 只关心「候选池 → 挑中哪几首」，会话这个动作不是推荐逻辑；
 * 2. 这里只依赖 `services/ai.ts`，不反向 import 推荐模块（否则循环引用）。
 * 提示词与回执解析仍由 `daily-recommend.ts` 负责。
 */

import { Song } from "@/types/music";
import {
  fetchAgents,
  createConversation,
  deleteConversation,
  sendMessage,
  fetchEvents,
} from "@/services/ai";
import { songsOfBlock } from "@/composables/use-ai-chat";
import { getAccessToken } from "@/services/auth";
import type { AiBlock } from "@/types/ai";

/** 一次服务端精选最多等多久（服务端回答通常十几秒，留足余量） */
export const SERVER_PICK_TIMEOUT_MS = 90000;
/** 轮询间隔：与音乐助手保持一致 */
export const SERVER_PICK_POLL_MS = 600;

/** 候选上限：后端按白名单取候选，与 qt-pc 一致（不走 candidatesToJson 的 30 上限） */
const SERVER_PICK_CANDIDATE_MAX = 150;

export type ServerPickRequest = {
  /** 候选池：既回传给后端做上下文，也用于把 `song_list` 块还原成曲目 */
  pool: Song[];
  /** `buildPrompt()` 的产物（system + user），按顺序拼成一条消息发出去 */
  messages: { role: string; content: string }[];
  timeoutMs?: number | null;
};

export type ServerPickReply = {
  /** 助手终态正文（可能是 JSON，也可能是人话 —— 解析在调用方做） */
  content: string;
  /** 助手在 `song_list` 块里实际给出的曲目（正文解析失败时用） */
  tracks: Song[];
  /** 智能体名字，给页面显示「服务端 AI · xxx」 */
  model: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

/** 取一个可用的音乐助手（后台可能配了多个，列表顺序是运营意图，取第一个） */
async function pickAgent(): Promise<{ code: string; name: string }> {
  const agents = await fetchAgents();
  for (let i = 0; i < agents.length; i++) {
    if (agents[i].agentType == "MUSIC") return { code: agents[i].agentCode, name: agents[i].name };
  }
  for (let i = 0; i < agents.length; i++) {
    if (agents[i].agentCode == "music_assistant") return { code: agents[i].agentCode, name: agents[i].name };
  }
  throw new Error("后台没有可用的音乐助手");
}

/**
 * 跑一轮服务端精选。
 *
 * 失败一律抛错，由 `generateDailyRecommend` 决定是否退回规则 —— 这里不做静默兜底，
 * 否则「服务端 AI」到底有没有生效用户根本看不出来。
 */
export async function askServerForPicks(request: ServerPickRequest): Promise<ServerPickReply> {
  const token = getAccessToken();
  if (token.length == 0) {
    throw new Error("还没有登录服务端，请先登录再试");
  }

  const agent = await pickAgent();
  const created = await createConversation(agent.code, "每日推荐");
  if (created.id <= 0) throw new Error("会话创建失败");

  try {
    const parts: string[] = [];
    for (let i = 0; i < request.messages.length; i++) {
      const message = request.messages[i];
      parts.push(message.role == "system" ? "【系统设定】" + message.content : message.content);
    }
    const content = parts.join("\n\n");

    // 后端按白名单取候选（`MusicToolProvider.candidates()` 同款字段），
    // 与音乐助手 `candidateFromSong` 用同一个转换，别手搓字段名。
    const candidates: any[] = [];
    const n = request.pool.length > SERVER_PICK_CANDIDATE_MAX ? SERVER_PICK_CANDIDATE_MAX : request.pool.length;
    for (let i = 0; i < n; i++) {
      const song = request.pool[i];
      const item = new UTSJSONObject();
      item.set("sourceId", song.platform);
      item.set("songId", song.id);
      item.set("name", song.name);
      item.set("artist", song.singer);
      item.set("album", song.album);
      item.set("duration", song.duration != null ? song.duration! : 0);
      item.set("coverUrl", song.picUrl);
      candidates.push(item);
    }
    const context = new UTSJSONObject();
    context.set("musicCandidates", candidates);

    const nonce = "app-daily-" + Date.now() + "-" + created.id;
    const sent = await sendMessage(created.id, content, context, nonce);

    const timeoutMs = request.timeoutMs != null && request.timeoutMs! > 0 ? request.timeoutMs! : SERVER_PICK_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let cursor = 0;
    let reply = "";
    let tracks: Song[] = [];

    while (Date.now() < deadline) {
      const batch = await fetchEvents(sent.requestId, cursor, 100);
      if (batch.nextSequence > cursor) cursor = batch.nextSequence;
      for (let i = 0; i < batch.events.length; i++) {
        const event = batch.events[i];
        const data = event.data;
        if (event.type == "request.failed") {
          const message = data != null ? data.getString("message") : null;
          throw new Error(message != null && message.length > 0 ? message : "服务端处理失败");
        }
        if (event.type == "request.cancelled") throw new Error("服务端取消了这次请求");
        if (event.type == "message.completed") {
          if (data != null) {
            const contentText = data.getString("content");
            if (contentText != null && contentText.length > 0) reply = contentText;
            const blocksRaw = data.get("blocks");
            if (blocksRaw != null && Array.isArray(blocksRaw)) {
              const blocks = blocksRaw as any[];
              for (let b = 0; b < blocks.length; b++) {
                const blockSongs = songsOfBlock(blocks[b] as AiBlock);
                for (let s = 0; s < blockSongs.length; s++) tracks.push(blockSongs[s]);
              }
            }
          }
        } else if (event.type == "message.delta") {
          const delta = data != null ? data.getString("delta") : null;
          if (delta != null) reply += delta;
        }
      }
      if (batch.terminal) {
        if (batch.status == "FAILED") throw new Error("服务端处理失败");
        break;
      }
      await sleep(SERVER_PICK_POLL_MS);
    }

    if (reply.trim().length == 0 && tracks.length == 0) {
      throw new Error("服务端没有返回内容（可能超时）");
    }
    return {
      content: reply,
      tracks: tracks,
      model: agent.name.length > 0 ? agent.name : "服务端 AI",
    };
  } finally {
    // 会话是一次性的：不删会在用户的音乐助手会话列表里堆一坨「每日推荐」
    try {
      await deleteConversation(created.id);
    } catch (e) {
      // 删不掉就算了，别把正主的失败盖掉
    }
  }
}
