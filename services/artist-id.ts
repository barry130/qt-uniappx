/**
 * 歌手名 → 歌手真实 id（进程内缓存；2026-10-07，与 qt-pc 的 src/lib/artist-id.ts 同口径）。
 *
 * 为什么需要它：`Song` 只带 `singer` 名字、不带歌手 id，所以从歌单/播放页/最近播放
 * 点歌手名进页时，URL 上都没有 `id=`。包里拿不到 id 就会**退回纯歌手名搜索**
 * （bundle 的 artistSongs 兜底），那等于把歌手名当关键词做全局搜索、无任何过滤 ——
 * 第 1 页相关度最高，越往后越跑偏（翻唱、合作、同名歌手），用户看到的就是
 * 「后面那些都和歌手没关系」。
 *
 * 这里在宿主侧先按名字查一次歌手（searchArtists），拿到真 id 再交给取作品接口，
 * 让所有入口都对准。一次额外请求，且结果按 `平台:名字` 缓存到退出，
 * 第二次进同一个歌手页连这次请求都省了。
 *
 * UTS 约束：不写自定义泛型；缓存用平行数组 + indexOf（与 services/source-switch.ts 同招）。
 */
import { musicApi } from "@/services/music-api";
import type { Source } from "@/services/music-api";
import type { Artist } from "@/types/music";

const CACHE_CAP = 64;

/** 在飞的解析：`平台:名字` → Promise；同一歌手并发进页只查一次 */
const pendingKeys: string[] = [];
const pendingValues: Promise<string>[] = [];
/** 已落定的结果，同步可读 */
const settledKeys: string[] = [];
const settledValues: string[] = [];

function keyOf(platform: Source, name: string): string {
  return platform + ":" + name;
}

/** 名字归一：比对该忽略大小写与空白（上游偶尔带全角空格/多余空格） */
function normalize(s: string): string {
  return s.trim().toLowerCase().split(" ").join("");
}

/**
 * 挑最像的那个歌手。
 *
 * 名字完全对上就用它（同名歌手有多条时不能随便取第一条）；
 * 对不上就取第一条 —— 搜索接口本身已按相关度排，比返回空让整页退回模糊搜索强。
 */
function pickBest(list: Artist[], name: string): string {
  const want = normalize(name);
  for (let i = 0; i < list.length; i++) {
    const a = list[i] as Artist;
    if (a.id.length > 0 && normalize(a.name) == want) return a.id;
  }
  for (let i = 0; i < list.length; i++) {
    const a = list[i] as Artist;
    if (a.id.length > 0) return a.id;
  }
  return "";
}

/** 记下结果（LRU） */
function remember(key: string, id: string): void {
  const at = settledKeys.indexOf(key);
  if (at >= 0) {
    settledKeys.splice(at, 1);
    settledValues.splice(at, 1);
  }
  settledKeys.push(key);
  settledValues.push(id);
  while (settledKeys.length > CACHE_CAP) {
    settledKeys.splice(0, 1);
    settledValues.splice(0, 1);
  }
}

async function query(key: string, platform: Source, name: string): Promise<string> {
  let id = "";
  try {
    const list = await musicApi.searchArtists(name, platform, 1, 5);
    id = pickBest(list, name);
  } catch (_) {
    // 查不到歌手就按老路走：不能因为一次查询失败让歌手页空掉
    id = "";
  }
  remember(key, id);
  return id;
}

/**
 * 解析歌手 id。拿不到（接口没实现 / 风控 / 真没有）返回空串 ——
 * 调用方拿到空串就按老路走名字搜索，不会白屏。
 */
export function resolveArtistId(platform: Source, name: string): Promise<string> {
  if (platform == "local" || name.length == 0) return Promise.resolve("");
  const key = keyOf(platform, name);
  const at = pendingKeys.indexOf(key);
  if (at >= 0) return pendingValues[at] as Promise<string>;
  const task = query(key, platform, name);
  pendingKeys.push(key);
  pendingValues.push(task);
  while (pendingKeys.length > CACHE_CAP) {
    pendingKeys.splice(0, 1);
    pendingValues.splice(0, 1);
  }
  return task;
}

/** 已解析过的 id（同步）；没解析过返回 "" */
export function peekArtistId(platform: Source, name: string): string {
  const key = keyOf(platform, name);
  const at = settledKeys.indexOf(key);
  if (at >= 0) return settledValues[at] as string;
  return "";
}

/** 清空缓存（切音源包等场景） */
export function clearArtistIdCache(): void {
  pendingKeys.splice(0, pendingKeys.length);
  pendingValues.splice(0, pendingValues.length);
  settledKeys.splice(0, settledKeys.length);
  settledValues.splice(0, settledValues.length);
}
