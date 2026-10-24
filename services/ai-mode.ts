/**
 * 全局 AI 模式：每日推荐与音乐助手共用一套（与 qt-pc src/lib/ai-mode.ts 同口径）。
 *
 * 三种模式对两个功能都是同一个意思：
 * - rule：不联网、不调模型。每日推荐按口味规则排；音乐助手按关键词规则选歌。永远可用。
 * - local：调用配置的 OpenAI 兼容接口，只让模型在已搜好的候选里挑；模型挂了退回规则。
 * - server：走登录后的 astral 音乐助手（服务端会话）。每日推荐用一次会话换回精选；
 *   没登录或调用失败时退回规则并说明原因。
 *
 * 展示口径（用户 2026-10-24 m04364 的要求）：
 * - 音乐助手入口对**全部用户**展示（不再要求 user:ai:music:use 权限）；
 * - 「服务端 AI」模式只对**管理员**（qt_admin / admin:qt:admin）展示，
 *   非管理员看不到这个选项，服务端取数入口也按同一口径把关。
 *
 * 存储键与 qt-pc 一致用 dailyRecommend.mode（uni storage 同步读写，无迁移问题）。
 *
 * 响应式：readAiMode 走模块级 ref（初值来自 storage），saveAiMode 同时写 ref 与
 * storage。之前 readAiMode 每次直读 storage，页面 computed 依赖不到任何响应式源，
 * 首次求值后永久缓存——用户切了模式，弹窗高亮/吸顶条文案仍停在旧值（审查实测）。
 * storage 仍是唯一持久层；ref 只在本进程内存活，写入口收敛在 saveAiMode 一处。
 */

import { ref } from "vue";

export type AiEngineMode = "rule" | "local" | "server";

export const AI_MODE_LABEL_RULE = "纯规则";
export const AI_MODE_LABEL_LOCAL = "本地模型精选";
export const AI_MODE_LABEL_SERVER = "服务端 AI";

export const AI_MODE_HINT_RULE = "不联网、不调模型：每日推荐按口味规则排，音乐助手按关键词规则选歌。永远可用。";
export const AI_MODE_HINT_LOCAL = "调用配置的接口，只让模型在已搜好的候选里挑；模型挂了自动退回规则。";
export const AI_MODE_HINT_SERVER = "走登录后的 astral 音乐助手：每日推荐与音乐助手都按服务端会话生成，需要登录。";

const AI_MODE_KEY = "dailyRecommend.mode";

/** 把库里读出来的字符串收敛成合法模式（未知值按规则处理，不报错） */
export function parseAiMode(raw: string | null): AiEngineMode {
  return raw === "local" || raw === "server" ? raw : "rule";
}

function readAiModeFromStorage(): AiEngineMode {
  try {
    const raw = uni.getStorageSync(AI_MODE_KEY);
    if (typeof raw === "string") return parseAiMode(raw as string);
    return "rule";
  } catch (e) {
    return "rule";
  }
}

/** 全局模式的响应式单源（初值 = storage 里的持久化值） */
const aiModeRef = ref<AiEngineMode>(readAiModeFromStorage());

/** 读全局 AI 模式（响应式：computed 依赖它会随 saveAiMode 联动失效） */
export function readAiMode(): AiEngineMode {
  return aiModeRef.value;
}

/** 保存全局 AI 模式（ref 与 storage 同步写，读方依赖 ref） */
export function saveAiMode(mode: AiEngineMode): void {
  aiModeRef.value = mode;
  try {
    uni.setStorageSync(AI_MODE_KEY, mode);
  } catch (e) {
    // 静默：设置写失败不打断操作流程（内存态仍生效到本次运行）
  }
}
