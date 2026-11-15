/**
 * 「聚合搜索只用哪几个音源」设置。
 *
 * 语义：
 * - 没配置 / 旧版空数组 → 返回 null，调用方按「全部音源」处理。
 * - 新保存的显式全关使用同键版本对象，返回 []，调用方不发起聚合请求。
 * - 配置过 → 返回去重后的 id 数组。可能包含当前数据包已不提供的 id，原样保留：
 *   过滤发生在数据包/门面侧，失效 id 自然匹配不到，重装包后旧选择自动恢复。
 *
 * 各入口（搜索页聚合、后续 AI 找歌等）共用这一个键，各存一份会互相打架。
 */

const AGGREGATE_SOURCES_KEY = "qt-search-aggregate-sources";

/** 音源平台管理页改完聚合音源后广播；搜索页监听并刷新进行中的聚合结果 */
export const AGGREGATE_SOURCES_CHANGED_EVENT = "qt-aggregate-sources-changed";

/** id 形状校验：数据包下发的源 id 都是短标识（wyy/qq/kw/kg 这类），脏数据直接丢 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 上限：源数量是数据包声明的，留余量防止脏数据把设置撑爆 */
const MAX_SOURCES = 16;

/**
 * 解析设置原文（旧 JSON 数组或 version=1 的 sources 对象）。解析失败归一成 null，
 * 不让一条坏设置把聚合搜索变成空的。
 */
export function parseAggregateSources(raw: string | null): string[] | null {
  const text = raw != null ? raw.trim() : "";
  if (text.length == 0) return null;
  try {
    const value = JSON.parse(text) as any;
    if (value == null) return null;
    const versioned = !Array.isArray(value);
    if (versioned && value.version !== 1) return null;
    const parsed = (versioned ? value.sources : value) as string[] | null;
    if (!Array.isArray(parsed)) return null;
    if (versioned && parsed.length == 0) return [];
    const out: string[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const id = typeof parsed[i] == "string" ? parsed[i].trim() : "";
      if (id.length == 0 || !ID_PATTERN.test(id)) continue;
      if (out.indexOf(id) >= 0) continue;
      out.push(id);
      if (out.length >= MAX_SOURCES) break;
    }
    return out.length > 0 ? out : null;
  } catch (_) {
    return null;
  }
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

/** 保存设置；null 恢复默认全部，空数组明确全关，非空白名单保留旧数组格式。 */
export function saveAggregateSources(sources: string[] | null): void {
  if (sources == null) {
    uni.setStorageSync(AGGREGATE_SOURCES_KEY, "");
    return;
  }
  if (sources.length == 0) {
    uni.setStorageSync(AGGREGATE_SOURCES_KEY, JSON.stringify({ version: 1, sources: [] as string[] }));
    return;
  }
  const next = parseAggregateSources(JSON.stringify(sources));
  // 持久化失败必须交给页面处理；未保存成功不能显示已生效。
  uni.setStorageSync(AGGREGATE_SOURCES_KEY, next == null ? "" : JSON.stringify(next));
}
