/**
 * 排行榜按音源记忆滚动位置。
 * Android 页内切源、Harmony 重载及返回复用同一份小型内存表。
 * 滚动热路径不反复读盘/解析/序列化；每300ms合并落盘，隐藏/卸载显式flush。
 */
import { parseJsonToUtso } from "@/services/http";

const CHART_SCROLL_KEY = "qt-chart-scroll";
const CHART_SCROLL_BATCH_MS = 300;
const CHART_SCROLL_MAX = 500000;
const CHART_SCROLL_CAP = 24;
const SOURCE_ID = /^[A-Za-z0-9_-]{1,32}$/;
type ScrollMap = Map<string, number>;
let scrollMap: ScrollMap | null = null;
let persistTimer = 0;
let dirty = false;

function validSource(sourceId: string): boolean {
  return sourceId != null && SOURCE_ID.test(sourceId);
}

function validPosition(value: number): boolean {
  return typeof value == "number" && Number.isFinite(value) && value <= CHART_SCROLL_MAX;
}

function readMap(): ScrollMap {
  const map: ScrollMap = new Map<string, number>();
  try {
    const raw = uni.getStorageSync(CHART_SCROLL_KEY);
    if (typeof raw != "string" || raw.length == 0) return map;
    const obj = parseJsonToUtso(raw);
    const keys = UTSJSONObject.keys(obj);
    for (let i = 0; i < keys.length && map.size < CHART_SCROLL_CAP; i++) {
      const key = keys[i];
      const value = obj.get(key) as number | null;
      if (validSource(key) && value != null && validPosition(value) && value > 0) {
        const position = Math.floor(value);
        if (position > 0) map.set(key, position);
      }
    }
  } catch (_) {
    // 静默：损坏/不可用的存储不影响页面，也不重复读取。
  }
  return map;
}

function currentMap(): ScrollMap {
  if (scrollMap == null) scrollMap = readMap();
  return scrollMap as ScrollMap;
}

function writeMap(map: ScrollMap): boolean {
  try {
    const obj = new UTSJSONObject();
    const ids = Array.from(map.keys());
    for (let i = 0; i < ids.length; i++) obj.set(ids[i], map.get(ids[i]) ?? 0);
    uni.setStorageSync(CHART_SCROLL_KEY, JSON.stringify(obj));
    return true;
  } catch (_) {
    // 内存位置仍有效；下一次flush可重试，不弹toast或阻断导航。
    return false;
  }
}

/** 内存即时读；首次读取才访问存储。 */
export function readChartScroll(sourceId: string): number {
  if (!validSource(sourceId)) return 0;
  return currentMap().get(sourceId) ?? 0;
}

/** 记录位置：负值按回顶处理；非有限数或异常巨值不污染上一有效位置。 */
export function saveChartScroll(sourceId: string, scrollTop: number): void {
  if (!validSource(sourceId) || !validPosition(scrollTop)) return;
  const value = Math.max(0, Math.floor(scrollTop));
  const map = currentMap();
  const old = map.get(sourceId) ?? 0;
  if (old == value) return;
  if (value > 0 && Math.abs(old - value) < 4) return;
  if (value <= 0) {
    map.delete(sourceId);
  } else {
    // 更新项置后，以最近使用顺序保留少量音源，避免脏身份无限增长。
    map.delete(sourceId);
    map.set(sourceId, value);
    if (map.size > CHART_SCROLL_CAP) {
      const oldest = Array.from(map.keys())[0];
      map.delete(oldest);
    }
  }
  dirty = true;
  // 固定批次而非持续debounce：长时间滚动也每300ms保底保存一次。
  if (persistTimer == 0) {
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      flushChartScroll();
    }, CHART_SCROLL_BATCH_MS) as number;
  }
}

/** 切到后台/页面卸载必须调用；取消待落盘timer，保留最终位置。 */
export function flushChartScroll(): void {
  if (persistTimer != 0) {
    clearTimeout(persistTimer);
    persistTimer = 0;
  }
  if (!dirty) return;
  if (writeMap(currentMap())) dirty = false;
}
