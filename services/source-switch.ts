/**
 * 换源（qt-uniappx 端）：当前源不支持该歌曲时，搜索其他源里同一首歌并展示。
 *
 * 与 qt-pc 的 src/lib/source-switch.ts 同口径（人工保持同步）：
 * - 聚合搜索（musicApi.allSearch，batch 自带 source、单源失败跳过），
 *   不动 qt-sources 数据包、不重建 pack —— 只消费包注册表已有的源；
 * - 评分取自 store/player.ts 的 pickBestMatch：歌名相同 +10 / 包含 +5，
 *   歌手相同 +6 / 包含 +3，≤0 视为不是同一首歌直接丢弃；
 * - 排除当前平台；按 platform:id 去重；分数降序；最多留 20 条。
 */
import type { Song } from "@/types/music";
import { musicApi } from "@/services/music-api";

/** 候选上限：够滑又不至于一次渲染太多行 */
export const MAX_CANDIDATES = 20;

/** 归一化匹配文本：小写 + 空白折叠，与 PC 端 normalizeMatchText 同序等价 */
export function normalizeMatchText(text: string): string {
  if (text == null) return "";
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 候选匹配分（与 pickBestMatch 同规则）：
 * title 相同 +10 / contains +5；singer 相同 +6 / contains +3；≤0 = 不是同一首歌。
 */
export function scoreCandidate(candidate: Song, want: { title: string; singer: string }): number {
  if (candidate == null) return 0;
  let score = 0;
  const wantTitle = normalizeMatchText(want.title);
  const candTitle = normalizeMatchText(candidate.name);
  const wantSinger = normalizeMatchText(want.singer);
  const candSinger = normalizeMatchText(candidate.singer);
  if (wantTitle.length > 0 && wantTitle == candTitle) score += 10;
  else if (wantTitle.length > 0 && candTitle.indexOf(wantTitle) >= 0) score += 5;
  if (wantSinger.length > 0 && wantSinger == candSinger) score += 6;
  else if (wantSinger.length > 0 && candSinger.indexOf(wantSinger) >= 0) score += 3;
  return score;
}

/**
 * 换源结果的**进程内临时缓存**（与 qt-pc 同口径）：关掉弹层再打开直接用，
 * 不再打一轮聚合搜索。
 *
 * 只做内存缓存不做持久化：候选是「此刻各源能不能播」的快照，落库后下次打开
 * 拿到的可能是已失效的源，反而误导；一次会话里反复开同一个换源弹层才是痛点。
 *
 * 用两个平行数组而不是 Map：UTS 容器的键序/API 在两端实现有差异，
 * 数组 + indexOf 的行为在 uvue/uts 里是确定的（项目内去重也用这招）。
 */
const CACHE_MAX_ENTRIES = 32;
/** 缓存有效期 10 分钟 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cacheKeys: string[] = [];
const cacheAt: number[] = [];
const cacheItems: Song[][] = [];

function cacheKeyOf(song: Song, page: number, size: number): string {
  return song.platform + ":" + song.id + ":" + page + ":" + size;
}

/** 取缓存（过期/缺失返回 null）；命中就把该条挪到队尾，维持 FIFO */
function cacheGet(key: string): Song[] | null {
  const at = cacheKeys.indexOf(key);
  if (at < 0) return null;
  if (Date.now() - cacheAt[at] > CACHE_TTL_MS) {
    cacheKeys.splice(at, 1);
    cacheAt.splice(at, 1);
    cacheItems.splice(at, 1);
    return null;
  }
  // 挪到队尾：先取出再追加
  const items = cacheItems[at];
  const stamp = cacheAt[at];
  cacheKeys.splice(at, 1);
  cacheAt.splice(at, 1);
  cacheItems.splice(at, 1);
  cacheKeys.push(key);
  cacheAt.push(stamp);
  cacheItems.push(items);
  return items;
}

function cacheSet(key: string, items: Song[]): void {
  const at = cacheKeys.indexOf(key);
  if (at >= 0) {
    cacheAt[at] = Date.now();
    cacheItems[at] = items;
    return;
  }
  cacheKeys.push(key);
  cacheAt.push(Date.now());
  cacheItems.push(items);
  while (cacheKeys.length > CACHE_MAX_ENTRIES) {
    cacheKeys.splice(0, 1);
    cacheAt.splice(0, 1);
    cacheItems.splice(0, 1);
  }
}

/** 清空换源缓存（换包/手动刷新时用） */
export function clearSourceSwitchCache(): void {
  cacheKeys.splice(0, cacheKeys.length);
  cacheAt.splice(0, cacheAt.length);
  cacheItems.splice(0, cacheItems.length);
}

/** 同步窥一眼首页缓存（未命中返回 null）：面板用它决定要不要先显示 loading */
export function peekSourceCandidates(song: Song): Song[] | null {
  if (song == null) return null;
  return cacheGet(cacheKeyOf(song, 1, 5));
}

/**
 * 聚合搜索其他源里同一首歌：keyword = 「歌名 歌手」，排除当前平台，
 * 按 platform:id 去重，丢掉 ≤0 分，分数降序，最多 MAX_CANDIDATES 条。
 * 歌名歌手都为空（脏数据）→ 不打搜索直接返回空。
 *
 * 结果按「歌曲 + 页码」缓存；force = 忽略并覆盖缓存（手动「重新搜索」）。
 */
export async function findSourceCandidates(
  song: Song,
  page = 1,
  size = 5,
  force: boolean = false,
): Promise<Song[]> {
  if (song == null) return [];
  const keyword = [song.name, song.singer].filter((part) => part != null && part.length > 0).join(" ").trim();
  if (keyword.length == 0) return [];
  const key = cacheKeyOf(song, page, size);
  if (!force) {
    const cached = cacheGet(key);
    if (cached != null) return cached;
  }
  const all = await musicApi.allSearch(keyword, page, size);
  const seen: string[] = [];
  const picked: { song: Song; score: number }[] = [];
  for (let i = 0; i < all.length; i++) {
    const candidate = all[i];
    if (candidate == null) continue;
    if (candidate.platform == song.platform) continue;
    const dedupKey = candidate.platform + ":" + candidate.id;
    if (seen.indexOf(dedupKey) >= 0) continue;
    seen.push(dedupKey);
    const score = scoreCandidate(candidate, { title: song.name, singer: song.singer });
    if (score <= 0) continue;
    picked.push({ song: candidate, score });
  }
  picked.sort((a, b) => b.score - a.score);
  const out: Song[] = [];
  for (let i = 0; i < picked.length && out.length < MAX_CANDIDATES; i++) {
    out.push(picked[i].song);
  }
  cacheSet(key, out);
  return out;
}
