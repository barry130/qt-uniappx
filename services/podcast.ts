/**
 * 播客 / 有声书订阅（RSS / Atom）与单集播放。
 *
 * 与桌面端 qt-pc 一一对应（`src-tauri/src/podcast.rs` 解析 + `src/components/
 * podcast/PodcastPage.tsx` 交互），只把「SQLite + reqwest」换成「uni storage +
 * uni.request」：
 *
 * - **不引 XML 库**：RSS/Atom 的实际写法比规范窄得多，30 行标签扫描就够，
 *   还能顺手把 `<description>` 里的 HTML 剥干净（见 cleanText）。
 * - **单集不进曲库**：音频直链直接进播放引擎（`platform = "podcast"`），由
 *   `services/music-api.ts` 的播客短路交付地址；否则未装音源包时会报「无法播放」。
 * - **刷新只动元信息**：`played` / `positionMs` 绝不参与覆盖，用户听了一半的
 *   一集不能因为点了一次刷新就回到开头（见 mergeEpisodes 的注释）。
 * - **进度存得勤**：播客动辄一小时，崩一次丢进度就等于让用户重听半集，
 *   页面每 5s 写一次、状态变化（暂停/切集/听完）时立刻再写一次。
 *
 * 存储两个键：`qt-podcast-shows`（订阅列表）与 `qt-podcast-eps-<showId>`
 * （该订阅的单集）。单集按订阅分键是为了刷新一个订阅时不重写其它订阅的
 * 上百集数据。
 */
import { parseJsonToUtso } from "@/services/http";
import { logErrV, logWarn } from "@/services/logger";
import { numAt } from "@/services/recommend-types";
import type { Song } from "@/types/music";

/** 平台标识：播放器/取链/展示三处都要认这个串（对照 qt-pc 的 PODCAST_PLATFORM） */
export const PODCAST_PLATFORM = "podcast";
/**
 * 每个订阅最多保留多少集。
 * 老播客动辄上千集，全存下来一次刷新就是上百 KB 的 JSON，而用户几乎不会
 * 往回翻到第 301 集；按发布时间倒序保留最近的（与 qt-pc 的 MAX_EPISODES 一致）。
 */
export const PODCAST_MAX_EPISODES = 300;
/** 单次拉取订阅的超时：播客服务器普遍慢，20s 与桌面端一致 */
const FETCH_TIMEOUT_MS = 20000;
/** 订阅源体积上限（字符数，UTF-8 下约等于字节数）：超过 8MB 基本不是 RSS */
const MAX_BODY_CHARS = 8 * 1024 * 1024;
const SHOWS_KEY = "qt-podcast-shows";
const EPISODES_KEY_PREFIX = "qt-podcast-eps-";

export type PodcastShow = {
  id: string;
  url: string;
  title: string;
  author: string;
  description: string;
  image: string;
  lastFetchedAt: number;
  episodeCount: number;
};

export type PodcastEpisode = {
  id: string;
  showId: string;
  title: string;
  description: string;
  /** 音频直链（RSS 里的 enclosure 地址），也是播放器曲目的 id */
  audioUrl: string;
  /** 单集时长（毫秒，0 = 订阅源没写） */
  durationMs: number;
  /** 发布时间（毫秒，0 = 认不出） */
  publishedAt: number;
  /** 听到 ≥95% 记为已听完（结尾口播听不到很正常，见 PodcastPage 的 FINISH_RATIO） */
  played: boolean;
  /** 上次听到的位置（毫秒），续播用 */
  positionMs: number;
};

/** 解析出来的原始单集（还没有 id / played / positionMs） */
type ParsedEpisode = {
  title: string;
  description: string;
  audioUrl: string;
  durationMs: number;
  publishedAt: number;
};

type ParsedFeed = {
  title: string;
  author: string;
  description: string;
  image: string;
  episodes: ParsedEpisode[];
};

// ==================== 标签扫描（不引 XML 库） ====================

/**
 * ASCII 小写化。**必须长度不变**：调用方拿小写副本做 indexOf，再用同一个
 * 下标去切原始字符串；标签名全是 ASCII，中文正文不会被改到。
 */
function asciiLower(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text.charAt(i);
  }
  return out;
}

/** 严格数字串转整数（有一位不是数字就当整段无效，与 Rust 的 parse 口径一致） */
function digitsToInt(text: string): number {
  if (text.length == 0) return 0;
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return 0;
    value = value * 10 + (code - 48);
  }
  return value;
}

function hexToInt(text: string): number {
  if (text.length == 0) return 0;
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let digit = -1;
    if (code >= 48 && code <= 57) digit = code - 48;
    else if (code >= 97 && code <= 102) digit = code - 87;
    else if (code >= 65 && code <= 70) digit = code - 55;
    if (digit < 0) return 0;
    value = value * 16 + digit;
  }
  return value;
}

/** 单个实体（不含 `&` 与 `;`）→ 字符；认不出返回空串（调用方原样保留） */
function decodeEntity(entity: string): string {
  if (entity == "amp") return "&";
  if (entity == "lt") return "<";
  if (entity == "gt") return ">";
  if (entity == "quot") return "\"";
  if (entity == "apos") return "'";
  if (entity == "nbsp") return " ";
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    const value = hexToInt(entity.substring(2));
    return value > 0 ? String.fromCharCode(value) : "";
  }
  if (entity.startsWith("#")) {
    const value = digitsToInt(entity.substring(1));
    return value > 0 ? String.fromCharCode(value) : "";
  }
  return "";
}

/**
 * 实体解码。只认 `&…;` 里 ≤10 字符的实体：正文里写「Tom & Jerry; 1970」
 * 这种正常句子不能被当成实体吞字（认不出的原样保留）。
 */
function decodeEntities(raw: string): string {
  if (raw.indexOf("&") < 0) return raw;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw.charCodeAt(i) == 38) {
      const semi = raw.indexOf(";", i + 1);
      if (semi > i + 1 && semi - i - 1 <= 10) {
        const decoded = decodeEntity(raw.substring(i + 1, semi));
        if (decoded.length > 0) {
          out += decoded;
          i = semi + 1;
          continue;
        }
      }
    }
    out += raw.charAt(i);
    i++;
  }
  return out;
}

/** 空白压缩：标题/摘要里的换行与连续空格都收成一个空格 */
function collapseSpaces(text: string): string {
  let out = "";
  let lastSpace = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isSpace = code == 32 || code == 9 || code == 10 || code == 13;
    if (isSpace) {
      if (!lastSpace && out.length > 0) out += " ";
      lastSpace = true;
    } else {
      out += text.charAt(i);
      lastSpace = false;
    }
  }
  return out.trim();
}

/**
 * 文本清洗：去 CDATA 包装、剥 HTML 标签、解实体、压空白。
 * 描述里常混 `<p>` / `<br>` / `<a>`：标题与摘要都不该把它们显示出来。
 */
function cleanText(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("<![CDATA[") && text.endsWith("]]>")) {
    text = text.substring(9, text.length - 3);
  }
  let plain = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code == 60) {
      depth++;
    } else if (code == 62 && depth > 0) {
      depth--;
    } else if (depth == 0) {
      plain += text.charAt(i);
    }
  }
  return collapseSpaces(decodeEntities(plain));
}

/** 取标签文本：`<name …>正文</name>`。自闭合或没闭合时返回 null */
function tagText(xml: string, name: string): string | null {
  const lower = asciiLower(xml);
  const open = "<" + asciiLower(name);
  const start = lower.indexOf(open);
  if (start < 0) return null;
  const afterIndex = start + open.length;
  if (afterIndex >= lower.length) return null;
  // 必须确认是完整标签名（避免 `<title` 命中 `<titleSort`）
  const after = lower.charCodeAt(afterIndex);
  if (
    !(after == 62 || after == 32 || after == 9 || after == 13 || after == 10 || after == 47)
  ) {
    return null;
  }
  const gt = lower.indexOf(">", start);
  if (gt < 0) return null;
  const textStart = gt + 1;
  const close = "</" + asciiLower(name) + ">";
  const end = lower.indexOf(close, textStart);
  if (end < 0) return null;
  return cleanText(xml.substring(textStart, end));
}

/** 取标签属性：`<name attr="v">`。属性值支持单/双引号 */
function tagAttr(xml: string, name: string, attr: string): string | null {
  const lower = asciiLower(xml);
  const open = "<" + asciiLower(name);
  const start = lower.indexOf(open);
  if (start < 0) return null;
  const insideEnd = lower.indexOf(">", start);
  if (insideEnd < 0) return null;
  const needle = asciiLower(attr) + "=";
  const at = lower.indexOf(needle, start);
  if (at < 0 || at >= insideEnd) return null;
  const valueStart = at + needle.length;
  if (valueStart >= xml.length) return null;
  const quoteCode = xml.charCodeAt(valueStart);
  let quote = "";
  if (quoteCode == 34) quote = "\"";
  else if (quoteCode == 39) quote = "'";
  else return null;
  const valueEnd = xml.indexOf(quote, valueStart + 1);
  if (valueEnd < 0) return null;
  return decodeEntities(xml.substring(valueStart + 1, valueEnd)).trim();
}

/** Atom 的 `<link rel="enclosure" href="…">`（RSS 那边走 enclosure 的 url 属性） */
function atomEnclosureHref(block: string): string {
  const lower = asciiLower(block);
  const relAt = lower.indexOf("rel=\"enclosure\"");
  const relAt2 = lower.indexOf("rel='enclosure'");
  let from = relAt;
  if (from < 0) from = relAt2;
  if (from < 0) return "";
  const tail = asciiLower(block.substring(from));
  let quote = "\"";
  let hrefAt = tail.indexOf("href=\"");
  if (hrefAt < 0) {
    hrefAt = tail.indexOf("href='");
    quote = "'";
  }
  if (hrefAt < 0) return "";
  const rest = block.substring(from + hrefAt + 6);
  const end = rest.indexOf(quote);
  if (end < 0) return "";
  return decodeEntities(rest.substring(0, end)).trim();
}

/** 时长：`3723` / `62:03` / `1:02:03`（iTunes 三种写法都见过）→ 毫秒 */
function parseDuration(raw: string): number {
  const text = raw.trim();
  if (text.length == 0) return 0;
  const parts = text.split(":");
  let secs = 0;
  if (parts.length == 1) {
    secs = digitsToInt(parts[0].trim());
  } else if (parts.length == 2) {
    secs = digitsToInt(parts[0].trim()) * 60 + digitsToInt(parts[1].trim());
  } else if (parts.length == 3) {
    secs =
      digitsToInt(parts[0].trim()) * 3600 +
      digitsToInt(parts[1].trim()) * 60 +
      digitsToInt(parts[2].trim());
  }
  return secs > 0 ? secs * 1000 : 0;
}

/** Hinnant 的 days_from_civil：公历日期 → 1970-01-01 起的天数 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const MONTH_NAMES: string[] = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/** 时区：`+0800` / `-05:00` / `GMT` / `UTC`（默认 0）→ 相对 UTC 的秒数 */
function parseZone(zone: string): number {
  const z = zone.trim();
  if (z.length == 0) return 0;
  const first = z.charCodeAt(0);
  if (first != 43 && first != 45) return 0;
  const sign = first == 43 ? 1 : -1;
  let digits = "";
  for (let i = 1; i < z.length; i++) {
    const code = z.charCodeAt(i);
    if (code >= 48 && code <= 57) digits += z.charAt(i);
  }
  if (digits.length != 4) return 0;
  const hours = digitsToInt(digits.substring(0, 2));
  const minutes = digitsToInt(digits.substring(2, 4));
  return sign * (hours * 3600 + minutes * 60);
}

/** RFC 2822 / ISO 8601 发布时间 → epoch ms；认不出的返回 0（按「不知道」处理，不猜） */
function parsePublished(raw: string): number {
  const text = raw.trim();
  if (text.length == 0) return 0;
  // ISO 8601：2025-11-01T12:00:00Z / +08:00（Atom 用这个）
  if (text.length >= 19 && text.charCodeAt(4) == 45) {
    const year = digitsToInt(text.substring(0, 4));
    const month = digitsToInt(text.substring(5, 7));
    const day = digitsToInt(text.substring(8, 10));
    const hour = digitsToInt(text.substring(11, 13));
    const minute = digitsToInt(text.substring(14, 16));
    const second = digitsToInt(text.substring(17, 19));
    if (year <= 0 || month <= 0 || day <= 0) return 0;
    const utc =
      daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second;
    // 末尾的 Z / ±hh:mm 时区：有就减掉
    let offset = 0;
    if (text.length > 19) {
      const tail = text.substring(19);
      const plus = tail.indexOf("+");
      const minus = tail.indexOf("-");
      if (plus >= 0) offset = parseZone(tail.substring(plus));
      else if (minus >= 0) offset = parseZone(tail.substring(minus));
    }
    return (utc - offset) * 1000;
  }
  // RFC 2822：`Wed, 01 Nov 2025 12:00:00 +0800`（星期与偏移都可省）
  const parts = text.split(" ");
  const words: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const one = parts[i].trim();
    if (one.length > 0) words.push(one);
  }
  let idx = 0;
  if (words.length > 0) {
    const first = words[0];
    // 星期几可带逗号（`Wed,`）也可不带（`Wed`）：3 个字母且不是数字就跳过
    if (first.endsWith(",") || (first.length == 3 && digitsToInt(first) == 0)) idx = 1;
  }
  if (words.length < idx + 4) return 0;
  const day = digitsToInt(words[idx]);
  const monthName = asciiLower(words[idx + 1]);
  let month = 0;
  for (let m = 0; m < MONTH_NAMES.length; m++) {
    if (monthName.startsWith(MONTH_NAMES[m])) {
      month = m + 1;
      break;
    }
  }
  if (month == 0 || day <= 0) return 0;
  const year = digitsToInt(words[idx + 2]);
  if (year <= 0) return 0;
  const clock = words[idx + 3].split(":");
  if (clock.length < 2) return 0;
  const hour = digitsToInt(clock[0]);
  const minute = digitsToInt(clock[1]);
  const second = clock.length > 2 ? digitsToInt(clock[2]) : 0;
  let offset = 0;
  if (words.length > idx + 4) offset = parseZone(words[idx + 4]);
  const local = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second;
  return (local - offset) * 1000;
}

/**
 * 解析订阅源文本。失败抛错（错误文案直接给用户看）。
 *
 * 两个「不能静默」的判据（与桌面端一致）：
 * - 频道标题为空 → 这不是订阅源（验证码页 / 404 / 登录墙都会返回 200 + HTML）；
 * - 一集都解析不出 → 没有 enclosure 地址（纯文字博客），播不了就不该存进列表。
 */
function parseFeed(xml: string): ParsedFeed {
  if (xml.trim().length == 0) throw new Error("订阅源是空的");
  const lower = asciiLower(xml);
  // 频道信息只取第一个条目前面的部分：条目自己的 <title> 更不能当频道名
  let headEnd = lower.indexOf("<item");
  const entryAt = lower.indexOf("<entry");
  if (headEnd < 0 || (entryAt >= 0 && entryAt < headEnd)) headEnd = entryAt;
  if (headEnd < 0) headEnd = xml.length;
  const head = xml.substring(0, headEnd);

  let title = tagText(head, "title");
  const feedTitle = title != null ? title : "";
  if (feedTitle.trim().length == 0) {
    throw new Error("这个地址不像是播客订阅源（没找到频道标题）");
  }
  let author = tagText(head, "itunes:author");
  if (author == null) author = tagText(head, "author");
  let description = tagText(head, "description");
  if (description == null) description = tagText(head, "itunes:summary");
  let image = tagAttr(head, "itunes:image", "href");
  if (image == null) image = tagText(head, "url");

  const episodes: ParsedEpisode[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const itemAt = lower.indexOf("<item", cursor);
    const entryStart = lower.indexOf("<entry", cursor);
    let open = -1;
    let closeTag = "</item>";
    if (itemAt >= 0 && (entryStart < 0 || itemAt < entryStart)) {
      open = itemAt;
      closeTag = "</item>";
    } else if (entryStart >= 0) {
      open = entryStart;
      closeTag = "</entry>";
    }
    if (open < 0) break;
    const closeAt = lower.indexOf(closeTag, open);
    if (closeAt < 0) break;
    const block = xml.substring(open, closeAt);
    cursor = closeAt + closeTag.length;

    let audioUrl = tagAttr(block, "enclosure", "url");
    if (audioUrl == null) audioUrl = tagAttr(block, "media:content", "url");
    if (audioUrl == null) audioUrl = atomEnclosureHref(block);
    const audio = audioUrl != null ? audioUrl : "";
    if (!audio.startsWith("http")) continue;

    let epTitle = tagText(block, "title");
    if (epTitle == null) epTitle = "未命名单集";
    let durationRaw = tagText(block, "itunes:duration");
    if (durationRaw == null) durationRaw = tagText(block, "media:duration");
    const durationMs = durationRaw != null ? parseDuration(durationRaw) : 0;
    let publishedRaw = tagText(block, "pubdate");
    if (publishedRaw == null) publishedRaw = tagText(block, "published");
    if (publishedRaw == null) publishedRaw = tagText(block, "updated");
    const publishedAt = publishedRaw != null ? parsePublished(publishedRaw) : 0;
    let epDesc = tagText(block, "description");
    if (epDesc == null) epDesc = tagText(block, "itunes:summary");
    if (epDesc == null) epDesc = tagText(block, "content:encoded");

    episodes.push({
      title: epTitle,
      description: epDesc != null ? epDesc : "",
      audioUrl: audio,
      durationMs: durationMs,
      publishedAt: publishedAt,
    });
  }
  if (episodes.length == 0) {
    throw new Error("订阅源里没有可播放的单集（没找到 enclosure 地址）");
  }
  episodes.sort((a: ParsedEpisode, b: ParsedEpisode): number => {
    if (a.publishedAt == b.publishedAt) return 0;
    return a.publishedAt > b.publishedAt ? -1 : 1;
  });
  const kept =
    episodes.length > PODCAST_MAX_EPISODES
      ? episodes.slice(0, PODCAST_MAX_EPISODES)
      : episodes;
  return {
    title: feedTitle,
    author: author != null ? author : "",
    description: description != null ? description : "",
    image: image != null ? image : "",
    episodes: kept,
  };
}

// ==================== 网络 ====================

/** 只接受 http(s)：`file://` 之类的本地路径不该从订阅入口进（否则是个任意文件读取面） */
function normalizeFeedUrl(raw: string): string {
  const url = raw.trim();
  if (url.length == 0) throw new Error("请先填写订阅地址");
  const lower = asciiLower(url);
  if (!(lower.startsWith("http://") || lower.startsWith("https://"))) {
    throw new Error("订阅地址要以 http:// 或 https:// 开头");
  }
  return url;
}

function fetchFeedText(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    uni.request({
      url: url,
      method: "GET",
      timeout: FETCH_TIMEOUT_MS,
      sslVerify: true,
      header: {
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        // 一部分播客主机（尤其国内 CDN）对空 UA 直接 403
        "User-Agent": "QtMusic/1.0 (uni-app x; podcast)",
      },
      success: (res) => {
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
          reject(new Error("订阅源返回 HTTP " + status));
          return;
        }
        const bodyText =
          typeof res.data == "string" ? (res.data as string) : JSON.stringify(res.data);
        if (bodyText.length > MAX_BODY_CHARS) {
          reject(new Error("订阅源太大（超过 8MB），不像是 RSS"));
          return;
        }
        resolve(bodyText);
      },
      fail: (err) => {
        reject(new Error("订阅源拉取失败：" + (err.errMsg != null ? err.errMsg : "网络请求失败")));
      },
    });
  });
}

async function fetchParsedFeed(url: string): Promise<ParsedFeed> {
  const text = await fetchFeedText(url);
  return parseFeed(text);
}

// ==================== 标识 ====================

/** FNV-1a 32 位（UTS 没有 crypto：订阅 id 只要「同一 URL 稳定、不同 URL 不同」） */
function fnv1a(text: string, salt: number): number {
  let hash = salt;
  for (let i = 0; i < text.length; i++) {
    hash = (hash ^ text.charCodeAt(i)) >>> 0;
    // h * 16777619 用位移拆开：直接乘会丢精度（32 位整数乘法在 UTS 里不安全）
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash >>> 0;
}

function intToHex(value: number): string {
  const digits = "0123456789abcdef";
  let out = "";
  let v = value >>> 0;
  for (let i = 0; i < 8; i++) {
    out = digits.charAt(v & 15) + out;
    v = v >>> 4;
  }
  return out;
}

/** 16 位十六进制短哈希：同一个地址重启后仍是同一个 id */
function shortHash(text: string): string {
  return intToHex(fnv1a(text, 2166136261)) + intToHex(fnv1a(text, 2166136261 ^ 1540483477));
}

function episodeIdOf(showId: string, audioUrl: string): string {
  return showId + ":" + shortHash(audioUrl);
}

// ==================== 存储 ====================

function strOf(obj: UTSJSONObject | null, key: string): string {
  if (obj == null) return "";
  const value = obj.get(key) as string | null;
  return value != null ? value : "";
}

function numOf(obj: UTSJSONObject | null, key: string): number {
  if (obj == null) return 0;
  const value = obj.get(key) as number | null;
  return value != null ? value : 0;
}

function boolOf(obj: UTSJSONObject | null, key: string): boolean {
  if (obj == null) return false;
  const value = obj.get(key) as boolean | null;
  return value != null && value;
}

function showFromJson(obj: UTSJSONObject | null): PodcastShow | null {
  if (obj == null) return null;
  const id = strOf(obj, "id");
  if (id.length == 0) return null;
  return {
    id: id,
    url: strOf(obj, "url"),
    title: strOf(obj, "title"),
    author: strOf(obj, "author"),
    description: strOf(obj, "description"),
    image: strOf(obj, "image"),
    lastFetchedAt: numOf(obj, "lastFetchedAt"),
    episodeCount: numOf(obj, "episodeCount"),
  };
}

function showToJson(show: PodcastShow): UTSJSONObject {
  const obj = new UTSJSONObject();
  obj.set("id", show.id);
  obj.set("url", show.url);
  obj.set("title", show.title);
  obj.set("author", show.author);
  obj.set("description", show.description);
  obj.set("image", show.image);
  obj.set("lastFetchedAt", show.lastFetchedAt);
  obj.set("episodeCount", show.episodeCount);
  return obj;
}

function episodeFromJson(obj: UTSJSONObject | null): PodcastEpisode | null {
  if (obj == null) return null;
  const id = strOf(obj, "id");
  const audioUrl = strOf(obj, "audioUrl");
  if (id.length == 0 || audioUrl.length == 0) return null;
  return {
    id: id,
    showId: strOf(obj, "showId"),
    title: strOf(obj, "title"),
    description: strOf(obj, "description"),
    audioUrl: audioUrl,
    durationMs: numOf(obj, "durationMs"),
    publishedAt: numOf(obj, "publishedAt"),
    played: boolOf(obj, "played"),
    positionMs: numOf(obj, "positionMs"),
  };
}

function episodeToJson(ep: PodcastEpisode): UTSJSONObject {
  const obj = new UTSJSONObject();
  obj.set("id", ep.id);
  obj.set("showId", ep.showId);
  obj.set("title", ep.title);
  obj.set("description", ep.description);
  obj.set("audioUrl", ep.audioUrl);
  obj.set("durationMs", ep.durationMs);
  obj.set("publishedAt", ep.publishedAt);
  obj.set("played", ep.played);
  obj.set("positionMs", ep.positionMs);
  return obj;
}

function readShows(): PodcastShow[] {
  try {
    const raw = uni.getStorageSync(SHOWS_KEY);
    if (typeof raw != "string") return [];
    const text = raw as string;
    if (text.length == 0) return [];
    // 必须走 parseJsonToUtso：App 端 JSON.parse 的产物是普通对象、没有 .get
    //（见 services/http.ts 与 services/ai-assistant-history.ts 的同款说明）
    const parsed = parseJsonToUtso(text);
    const listRaw = parsed.get("shows");
    if (listRaw == null) return [];
    const arr = listRaw as any[];
    if (!Array.isArray(arr)) return [];
    const out: PodcastShow[] = [];
    for (let i = 0; i < arr.length; i++) {
      const one = showFromJson(arr[i] as UTSJSONObject);
      if (one != null) out.push(one);
    }
    return out;
  } catch (e) {
    // 存储损坏（升级/写一半断电）按「没有订阅」处理：宁可重新订阅，
    // 也不能因为这个页面打不开
    logWarn("[PODCAST] 读取订阅失败，按空处理");
    return [];
  }
}

function writeShows(list: PodcastShow[]): void {
  try {
    const arr: UTSJSONObject[] = [];
    for (let i = 0; i < list.length; i++) arr.push(showToJson(list[i]));
    const root = new UTSJSONObject();
    root.set("shows", arr);
    uni.setStorageSync(SHOWS_KEY, JSON.stringify(root));
  } catch (e) {
    logErrV("[PODCAST] 保存订阅失败", e);
  }
}

function episodesKeyOf(showId: string): string {
  return EPISODES_KEY_PREFIX + showId;
}

/** 读某个订阅的单集（已按发布时间倒序） */
export function listPodcastEpisodes(showId: string): PodcastEpisode[] {
  try {
    const raw = uni.getStorageSync(episodesKeyOf(showId));
    if (typeof raw != "string") return [];
    const text = raw as string;
    if (text.length == 0) return [];
    const parsed = parseJsonToUtso(text);
    const listRaw = parsed.get("eps");
    if (listRaw == null) return [];
    const arr = listRaw as any[];
    if (!Array.isArray(arr)) return [];
    const out: PodcastEpisode[] = [];
    for (let i = 0; i < arr.length; i++) {
      const one = episodeFromJson(arr[i] as UTSJSONObject);
      if (one != null) out.push(one);
    }
    return out;
  } catch (e) {
    logWarn("[PODCAST] 读取单集失败，按空处理");
    return [];
  }
}

function writeEpisodes(showId: string, list: PodcastEpisode[]): void {
  try {
    const arr: UTSJSONObject[] = [];
    for (let i = 0; i < list.length; i++) arr.push(episodeToJson(list[i]));
    const root = new UTSJSONObject();
    root.set("eps", arr);
    uni.setStorageSync(episodesKeyOf(showId), JSON.stringify(root));
  } catch (e) {
    logErrV("[PODCAST] 保存单集失败", e);
  }
}

/**
 * 把新解析出的单集合并进已有列表：**只更新元信息，不动 played / positionMs**。
 *
 * 这条约束是刷新的全部意义所在——用户听了一半的一集，点一次刷新就回到
 * 开头是绝对不能接受的事（qt-pc 的 SQLite upsert 同样刻意把这两列排除在
 * DO UPDATE 之外）。
 */
function mergeEpisodes(showId: string, incoming: ParsedEpisode[]): PodcastEpisode[] {
  const prev = listPodcastEpisodes(showId);
  // 用 number 表存布尔（1 = 已听完）：Record<string, boolean> 的缺省判定在
  // App/Harmony 两端的类型口径不一致，numAt 是仓库里已验证的读法
  const playedBy: Record<string, number> = {};
  const posBy: Record<string, number> = {};
  for (let i = 0; i < prev.length; i++) {
    playedBy[prev[i].audioUrl] = prev[i].played ? 1 : 0;
    posBy[prev[i].audioUrl] = prev[i].positionMs;
  }
  const out: PodcastEpisode[] = [];
  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i];
    out.push({
      id: episodeIdOf(showId, raw.audioUrl),
      showId: showId,
      title: raw.title,
      description: raw.description,
      audioUrl: raw.audioUrl,
      durationMs: raw.durationMs,
      publishedAt: raw.publishedAt,
      played: numAt(playedBy, raw.audioUrl) == 1,
      positionMs: numAt(posBy, raw.audioUrl),
    });
  }
  return out;
}

// ==================== 订阅操作 ====================

/** 订阅列表（新订阅排最前，与桌面端 created_at DESC 一致） */
export function listPodcastShows(): PodcastShow[] {
  return readShows();
}

function findShowIndex(shows: PodcastShow[], showId: string): number {
  for (let i = 0; i < shows.length; i++) {
    if (shows[i].id == showId) return i;
  }
  return -1;
}

/**
 * 订阅一个 RSS / Atom 地址。已订阅过的地址按「重新拉取并更新元信息」处理，
 * 不会产生第二份订阅。
 */
export async function addPodcastShow(rawUrl: string): Promise<PodcastShow> {
  const url = normalizeFeedUrl(rawUrl);
  const feed = await fetchParsedFeed(url);
  const id = PODCAST_PLATFORM + ":" + shortHash(url);
  const shows = readShows();
  const at = findShowIndex(shows, id);
  const episodes = mergeEpisodes(id, feed.episodes);
  const show: PodcastShow = {
    id: id,
    url: url,
    title: feed.title.length > 0 ? feed.title : url,
    author: feed.author,
    description: feed.description,
    image: feed.image,
    lastFetchedAt: Date.now(),
    episodeCount: episodes.length,
  };
  if (at >= 0) shows[at] = show;
  else shows.unshift(show);
  writeEpisodes(id, episodes);
  writeShows(shows);
  return show;
}

/** 刷新某个订阅（拉最新单集）。进度与「已听完」标记不受影响 */
export async function refreshPodcastShow(showId: string): Promise<PodcastShow> {
  const shows = readShows();
  const at = findShowIndex(shows, showId);
  if (at < 0) throw new Error("这个订阅已经不在了");
  const feed = await fetchParsedFeed(shows[at].url);
  const episodes = mergeEpisodes(showId, feed.episodes);
  const show = shows[at];
  if (feed.title.length > 0) show.title = feed.title;
  show.author = feed.author;
  show.description = feed.description;
  show.image = feed.image;
  show.lastFetchedAt = Date.now();
  show.episodeCount = episodes.length;
  writeEpisodes(showId, episodes);
  writeShows(shows);
  return show;
}

/** 取消订阅：连同该订阅的单集一起去掉（音频不落盘，无需清理文件） */
export function removePodcastShow(showId: string): void {
  const shows = readShows();
  const kept: PodcastShow[] = [];
  for (let i = 0; i < shows.length; i++) {
    if (shows[i].id != showId) kept.push(shows[i]);
  }
  writeShows(kept);
  try {
    uni.removeStorageSync(episodesKeyOf(showId));
  } catch (e) {
    logWarn("[PODCAST] 清理单集存储失败");
  }
}

/**
 * 写单集进度。页面每 5s 调一次、状态变化时再调一次。
 *
 * `played` 由调用方按「≥95% 时长」判定（单集时长可能为 0：那就只存位置，
 * 不标已听完——没有时长就没有「听完」这个事实）。
 */
export function savePodcastProgress(
  showId: string,
  episodeId: string,
  positionMs: number,
  played: boolean
): void {
  const episodes = listPodcastEpisodes(showId);
  let hit = false;
  for (let i = 0; i < episodes.length; i++) {
    if (episodes[i].id == episodeId) {
      episodes[i].positionMs = positionMs > 0 ? Math.round(positionMs) : 0;
      episodes[i].played = played;
      hit = true;
      break;
    }
  }
  if (!hit) return;
  writeEpisodes(showId, episodes);
}

/**
 * 单集 → 播放器曲目。
 * `id` 就是音频直链：引擎（music-api 的播客短路）据此直接交付地址，不做取链。
 */
export function podcastEpisodeToSong(episode: PodcastEpisode, show: PodcastShow): Song {
  const song: Song = {
    id: episode.audioUrl,
    name: episode.title,
    singer: show.author.length > 0 ? show.author : show.title,
    album: show.title,
    picUrl: show.image,
    platform: PODCAST_PLATFORM,
    // 播放器要秒；RSS 里没写时长时给 0（引擎按解码结果补，进度条仍可用）
    duration: Math.max(0, Math.round(episode.durationMs / 1000)),
  };
  return song;
}
