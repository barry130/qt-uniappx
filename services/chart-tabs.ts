/**
 * 排行榜页「按音源记忆滚动位置」。
 *
 * 为什么需要这个：切音源 tab 是整页 `redirectTo` 重载（页内原地切换在
 * uni-app x 的 Vapor 渲染器下会丢渲染，详见 pages/chart/index.uvue 模板注释），
 * 页面重载后 scroll-view 天然从 0 开始，滚动位置只能靠存储跨实例记忆。
 *
 * 存储形态：一个 JSON 对象 { "<sourceId>": <scrollTop> }，值做取整并丢弃 <=0，
 * 避免给没滚过的音源留垃圾项。
 */
const CHART_SCROLL_KEY = "qt-chart-scroll";

type ScrollMap = Map<string, number>;

function readMap(): ScrollMap {
  const map: ScrollMap = new Map<string, number>();
  try {
    const raw = uni.getStorageSync(CHART_SCROLL_KEY);
    if (raw == null || raw === "") return map;
    const obj = JSON.parse(raw as string) as UTSJSONObject | null;
    if (obj == null) return map;
    // UTSJSONObject 取键用静态 keys()（全仓 8 处同款）；实例 .keys() 编译期不保证存在
    const keys = UTSJSONObject.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = obj.get(k) as number | null;
      if (v != null && v > 0) map.set(k, v);
    }
  } catch (e) {
    // 存储损坏就当作没有记忆，不影响页面
  }
  return map;
}

function writeMap(map: ScrollMap): void {
  try {
    const obj: UTSJSONObject = {};
    const ids = Array.from(map.keys());
    for (let i = 0; i < ids.length; i++) obj[ids[i]] = map.get(ids[i]) ?? 0;
    uni.setStorageSync(CHART_SCROLL_KEY, JSON.stringify(obj));
  } catch (e) {
    // 写失败只是丢记忆，不报错
  }
}

/** 读某音源上次的滚动位置（没有记录返回 0） */
export function readChartScroll(sourceId: string): number {
  if (sourceId == null || sourceId === "") return 0;
  return readMap().get(sourceId) ?? 0;
}

/** 记录某音源的滚动位置；值 <=0 时删除该键（回顶后不留脏项） */
export function saveChartScroll(sourceId: string, scrollTop: number): void {
  if (sourceId == null || sourceId === "") return;
  const v = Math.floor(Number(scrollTop));
  const map = readMap();
  const old = map.get(sourceId) ?? -1;
  if (v <= 0) {
    if (old < 0) return;
    map.delete(sourceId);
  } else {
    // 抖动过滤：来回 4px 内的变化不落盘，减少存储写入
    if (old >= 0 && Math.abs(old - v) < 4) return;
    map.set(sourceId, v);
  }
  writeMap(map);
}
