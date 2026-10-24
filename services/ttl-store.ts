/**
 * 跨启动的本地 TTL 缓存（uni storage 封装）。
 *
 * 背景：列表类数据（排行榜、歌单广场、分类、通知）由手机端直连音源/后端请求，
 * 移动网络下单次 2-5s；music-api 里已有的 dataCache 只是 60 秒的**内存**缓存，
 * 杀进程即失效。这里补一层**持久**缓存：命中且未过期就直接返回、不再发请求。
 *
 * 存储格式：`"<写入时间ms>|<JSON>"`——前缀放时间戳是为了读路径上一个 indexOf
 * 就能判定新旧，不引入额外的信封对象序列化；过期条目读取时顺手删除。
 * 值侧沿用仓库惯例（dislikes.ts）：写入 JSON.stringify(对象)，读出按消费方选
 * ttlRead（普通对象，点访问）或 ttlReadUtso（UTSJSONObject，.get 访问）。
 *
 * 注意：**空结果不缓存**（由调用方保证）——拉取失败常表现为空列表，把失败
 * 缓存十几小时比不缓存更糟。键里要带上会影响内容的维度（音源包指纹、音源 id、
 * 翻页页码、登录态等），任何一维变化都应落到不同的键上，而不是覆盖。
 */
import { parseJsonToUtso } from "./http";

const PREFIX = "qt-ttl-";

/** 信封解析：命中且未过期返回 JSON 文本，否则 null（过期顺手删） */
function ttlText(key: string, ttlMs: number): string | null {
  try {
    const raw = uni.getStorageSync(PREFIX + key) as string;
    if (raw == null || raw.length == 0) return null;
    const sep = raw.indexOf("|");
    if (sep <= 0) return null;
    const at = parseInt(raw.substring(0, sep));
    if (!(at > 0) || Date.now() - at >= ttlMs) {
      // 过期条目顺手清掉，避免陈旧值长期占存储
      uni.removeStorageSync(PREFIX + key);
      return null;
    }
    return raw.substring(sep + 1);
  } catch (_) {
    return null;
  }
}

/**
 * 读持久缓存：命中且未过期返回 JSON.parse 的普通对象（调用方自行 as 具体类型）。
 * 注意：JS 运行时里 JSON.parse 出来的是**普通对象**——字段用点访问（song.name）没问题，
 * 但没有 .get() 方法；需要 .get 的消费方（UTSJSONObject 系）请用 ttlReadUtso。
 */
export function ttlRead(key: string, ttlMs: number): any | null {
  const text = ttlText(key, ttlMs);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/** 同 ttlRead，但把普通 JSON 对象递归重建为 UTSJSONObject（含嵌套数组元素，带 .get/.set） */
export function ttlReadUtso(key: string, ttlMs: number): any | null {
  const text = ttlText(key, ttlMs);
  if (text == null) return null;
  try {
    return parseJsonToUtso(text) as any;
  } catch (_) {
    return null;
  }
}

/** 写持久缓存（任何失败静默：存储写失败不应影响主流程） */
export function ttlWrite(key: string, value: any): void {
  try {
    uni.setStorageSync(PREFIX + key, Date.now().toString() + "|" + JSON.stringify(value));
  } catch (_) {
    // 忽略：容量满/IO 异常等
  }
}

/** 当前持久缓存的条目数（清除缓存页展示用） */
export function ttlCount(): number {
  try {
    const info = uni.getStorageInfoSync();
    const keys = info.keys;
    let n = 0;
    for (let i = 0; i < keys.length; i++) {
      if ((keys[i] as string).indexOf(PREFIX) == 0) n++;
    }
    return n;
  } catch (_) {
    return 0;
  }
}

/** 清空全部持久缓存（只动 qt-ttl- 前缀的键，返回清掉的条数） */
export function ttlClearAll(): number {
  let n = 0;
  try {
    const info = uni.getStorageInfoSync();
    const keys = info.keys;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string;
      if (key.indexOf(PREFIX) == 0) {
        uni.removeStorageSync(key);
        n++;
      }
    }
  } catch (_) {
    // 忽略：能清多少清多少
  }
  return n;
}
