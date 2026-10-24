/**
 * 「聚合搜索只用哪几个音源」设置（对齐 qt-pc/src/lib/aggregate-sources.ts 语义）。
 *
 * 语义：
 * - 没配置 / 配置成空数组 → 返回 null，调用方按「全部音源」处理。一个都不选
 *   不应该变成「什么都搜不到」，空值统一归一成 null（UI 侧也禁止把最后一个关掉）。
 * - 配置过 → 返回去重后的 id 数组。可能包含当前数据包已不提供的 id，原样保留：
 *   过滤发生在数据包/门面侧，失效 id 自然匹配不到，重装包后旧选择自动恢复。
 *
 * 各入口（搜索页聚合、后续 AI 找歌等）共用这一个键，各存一份会互相打架。
 */

const AGGREGATE_SOURCES_KEY = "qt-search-aggregate-sources";

/** 音源包页改完聚合音源后广播；搜索页监听并刷新进行中的聚合结果 */
export const AGGREGATE_SOURCES_CHANGED_EVENT = "qt-aggregate-sources-changed";

/** id 形状校验：数据包下发的源 id 都是短标识（wyy/qq/kw/kg 这类），脏数据直接丢 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 上限：源数量是数据包声明的，留余量防止脏数据把设置撑爆 */
const MAX_SOURCES = 16;

/**
 * 解析设置原文（JSON 字符串数组）。任何解析失败都归一成 null（= 全部音源），
 * 不让一条坏设置把聚合搜索变成空的。
 */
export function parseAggregateSources(raw: string | null): string[] | null {
  const text = raw != null ? raw.trim() : "";
  if (text.length == 0) return null;
  const parsed = JSON.parse(text) as string[] | null;
  if (parsed == null) return null;
  const out: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const id = parsed[i] != null ? parsed[i].trim() : "";
    if (id.length == 0 || !ID_PATTERN.test(id)) continue;
    if (out.indexOf(id) >= 0) continue;
    out.push(id);
    if (out.length >= MAX_SOURCES) break;
  }
  return out.length > 0 ? out : null;
}

/** 读设置。读失败按「全部音源」处理：宁可多搜几个源，也不要因为一次读失败让搜索变空 */
export function readAggregateSources(): string[] | null {
  try {
    const raw = uni.getStorageSync(AGGREGATE_SOURCES_KEY);
    return parseAggregateSources(typeof raw == "string" ? raw as string : null);
  } catch (_) {
    return null;
  }
}

/** 保存设置（设置页每次勾选都调，立即生效）；空数组 = 清除设置 = 全部音源 */
export function saveAggregateSources(sources: string[]): void {
  const next = parseAggregateSources(JSON.stringify(sources));
  try {
    uni.setStorageSync(AGGREGATE_SOURCES_KEY, next == null ? "" : JSON.stringify(next));
  } catch (_) {
    // 存不进去时保持静默：本次会话内调用方已拿到返回值，重启后回到「全部音源」
  }
}
