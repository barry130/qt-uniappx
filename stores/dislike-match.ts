/**
 * 屏蔽匹配的纯算法层（无 vue / uni / DOM 依赖，可被 node 直接 import 跑向量表）。
 *
 * 存在的唯一理由：**两端算法必须有同一个可执行的验收**。这里是 qt-uniappx 端，
 * 对端是 qt-pc 的 `src-tauri/src/db/store/dislikes.rs`；两边共用
 * `tests/fixtures/dislike-parity.json`（本端拷贝在 `tools/dislike-parity.json`）：
 *   - Rust：`cargo test --lib dislikes` → `parity_fixture_is_satisfied`
 *   - 本端：`npm run check:dislike` → tools/check-dislike-parity.mjs
 * 任何一边改了归一化 / 剥附注 / 拆歌手的语义而另一边没跟上，立刻有一边红。
 *
 * 改这里的算法，必须同时改 dislikes.rs（头注释「人工同步」的约定就是靠这张表兑现的）。
 */

/**
 * 字母数字判定（近似 Rust 的 char::is_alphanumeric）：
 * ASCII 字母数字 + 常用表意文字区间。近似处（如 × ÷ 误留）无伤大雅——
 * 匹配键只在本设备内部比对，不跨端同步，稳定即可。
 */
export function isWordChar(code: number): boolean {
  if (code >= 48 && code <= 57) return true; // 0-9
  if (code >= 65 && code <= 90) return true; // A-Z
  if (code >= 97 && code <= 122) return true; // a-z
  if (code >= 0xc0 && code <= 0x24f) return true; // 拉丁字母补充/扩展
  if (code >= 0x370 && code <= 0x3ff) return true; // 希腊
  if (code >= 0x400 && code <= 0x4ff) return true; // 西里尔
  if (code >= 0x3400 && code <= 0x4dbf) return true; // CJK 扩展 A
  if (code >= 0x4e00 && code <= 0x9fff) return true; // CJK 统一表意
  if (code >= 0x3040 && code <= 0x30ff) return true; // 平假名/片假名
  if (code >= 0xac00 && code <= 0xd7af) return true; // 韩文音节
  if (code >= 0xf900 && code <= 0xfaff) return true; // CJK 兼容
  if (code >= 0xff66 && code <= 0xff9f) return true; // 半角片假名
  return false;
}

/**
 * 归一化匹配键：全角空格丢弃、U+FF01-FF5E 折半角、小写、只留字母数字。
 * 与 Rust normalize_key 同序等价（先折后小写与先小写后折结果一致）。
 */
export function normalizeKey(raw: string): string {
  if (raw == null) return "";
  const lower = raw.toLowerCase();
  let out = "";
  for (let i = 0; i < lower.length; i++) {
    let code = lower.charCodeAt(i);
    if (code >= 0xff01 && code <= 0xff5e) code = code - 0xfee0;
    if (isWordChar(code)) out += String.fromCharCode(code);
  }
  return out;
}

/**
 * 剥掉括号附注段（现场版/Live/翻自 等）：`稻香 (Live)`→`稻香`、
 * `晴天（Live）`→`晴天`。整段括号内容丢弃，只删成对括号本身外的内容。
 * 与 Rust strip_note_segments 同语义；刻意不做 remix/伴奏 等关键词表——
 * 漏匹配的代价远小于误屏蔽。
 */
export function stripNoteSegments(raw: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (
      ch == "(" ||
      ch == "（" ||
      ch == "[" ||
      ch == "【" ||
      ch == "{" ||
      ch == "［"
    ) {
      depth++;
      continue;
    }
    if (
      ch == ")" ||
      ch == "）" ||
      ch == "]" ||
      ch == "】" ||
      ch == "}" ||
      ch == "］"
    ) {
      if (depth > 0) depth--;
      continue;
    }
    if (depth == 0) out += ch;
  }
  // 剥完括号会留下悬空空格（`稻香 (Live)`→`稻香 `），这里一并修掉：
  // 跨端向量表比对的是字面结果，不做 trim 两端就永远对不齐
  // （后续 normalizeKey 反正也会 trim，所以这里 trim 不改变匹配语义）。
  return out.trim();
}

const SINGER_SEPARATORS = [",", "，", "、", ";", "；", "/", "|", "&", "＆", "　"];

/** 歌手串拆词（**原文**，去空白、丢空段）。与 Rust split_singer_parts 同分隔符集合。 */
export function splitSingers(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (SINGER_SEPARATORS.indexOf(ch) >= 0) {
      if (cur.trim().length > 0) {
        out.push(cur.trim());
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}

/** 歌手串 → 归一化去重后的匹配词集合（`周杰伦、费玉清`→两个词）。与 Rust split_singers 同语义。 */
export function singerTokensOf(raw: string): string[] {
  const parts = splitSingers(raw);
  const tokens: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const key = normalizeKey(parts[i]);
    if (key.length == 0) continue;
    if (tokens.indexOf(key) < 0) tokens.push(key);
  }
  return tokens;
}

/** 曲目名 → 剥附注后的归一化歌名（空 = 无法按歌名匹配） */
export function songNameKeyOf(name: string): string {
  return normalizeKey(stripNoteSegments(name));
}

/** 两个词集合是否有交集 */
export function tokensIntersect(a: string[], b: string[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (b.indexOf(a[i]) >= 0) return true;
  }
  return false;
}