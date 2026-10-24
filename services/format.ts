/**
 * 面向用户展示的大数字格式化（全站统一口径）。
 *
 * 口径：大于等于 1 亿显示「x.x亿」，大于等于 1 万显示「x.x万」，其余原样。
 * 播放量、收藏数、听歌量等列表与统计数字一律走这里，不再各自换算。
 *
 * 背景：home 页与 stats 页各有一份同语义的本地 formatCount，搜索结果歌单卡的
 * 播放量则从未换算过（裸数字），三处口径已经漂移。2026-10-19 收口到本文件。
 */

/**
 * 大数字转「亿/万」。
 * @param value 数字或字符串（music-api 的 playCount 是 string），null 按缺省处理
 */
export function formatBigCount(value: string | number | null): string {
  const count = Number(value ?? "0");
  if (!isFinite(count) || count <= 0) return "0";
  if (count >= 100000000) return (count / 100000000).toFixed(1) + "亿";
  if (count >= 10000) return (count / 10000).toFixed(1) + "万";
  return count.toString();
}
