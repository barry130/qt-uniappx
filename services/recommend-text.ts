/**
 * 推荐链路的文本工具（与 qt-pc src/lib/text.ts 同一套规则）。
 *
 * 为什么不直接复用 services/aggregate-merge.ts 的 aggregateNormText：
 * 那边是**搜索跨页去重**专用的更激进归一化（剥全部括号族 + 剥歌名号），
 * 且与 qt-sources/src/actions/merge-search.ts 逐字镜像；这边是口味画像/打分用
 * 的温和归一化（只剥圆括号 + 常见标点）。两套语义不同，qt-pc 里也是刻意分两份。
 *
 * UTS 注意：Math.imul 在 UTS 里不存在，这里用拆位乘法手写 imul，
 * 结果与 JS 的 Math.imul 完全一致（32 位溢出语义）。
 */

/** clamp 到 0..1（qt-pc 的 clamp01） */
export function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 归一化文本：去空白（含全角空格）、去圆括号内容、去标点、转小写。
 * 用途：风格画像的歌手键/专辑键、「同名不同源」判重、抖动种子。
 */
export function normText(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(/[\s\u3000]+/g, "");
  s = s.replace(/[（(][^）)]*[）)]/g, "");
  s = s.replace(/[·・.,，、\-—_/\\'"“”‘’!！?？:：;；]/g, "");
  return s;
}

/** 曲目唯一键：平台:原始id */
export function trackKeyOf(platform: string, id: string): string {
  return `${platform}:${id}`;
}

/** 同名同歌手键：同一首歌跨源 id 不同，靠它认成一首（播放历史降权/跨源去重用） */
export function songNameKey(name: string, singer: string): string {
  return `${normText(name)}|${normText(singer)}`;
}

/**
 * 本地日期键 YYYY-MM-DD。不能用 toISOString()（UTC 会把东八区早八点前的
 * 「今天」算成昨天）；每日推荐的当天缓存、抖动种子都靠它。
 */
export function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const mm = m < 10 ? `0${m}` : `${m}`;
  const dd = d < 10 ? `0${d}` : `${d}`;
  return `${y}-${mm}-${dd}`;
}

/** 32 位乘法（等价 JS Math.imul；UTS 没有这个 API，手动拆位实现） */
function imul32(a: number, b: number): number {
  const ah = Math.floor(a / 65536);
  const al = a - ah * 65536;
  const bh = Math.floor(b / 65536);
  const bl = b - bh * 65536;
  // 高×低要 << 16，普通 number 的 << 是 32 位语义，够用
  return (((ah * bl + al * bh) * 65536) + al * bl) | 0;
}

/** FNV-1a 32 位哈希（确定性）：jitter 的根基，同输入永远同值 */
export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = imul32(h, 16777619);
  }
  return h >>> 0;
}

/** 稳定抖动 [0,1)：同一天同一首永远同值，缓存才有意义 */
export function jitter(seed: string, key: string): number {
  return (hashString(`${seed}|${key}`) % 1000) / 1000;
}

/** 按码点取字符（避免把代理对劈成半个；显示层截断用） */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}
