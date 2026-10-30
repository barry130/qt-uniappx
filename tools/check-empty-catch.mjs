/**
 * 空 catch 门禁（check-empty-catch.mjs）
 *
 * 背景：全库曾有约 300 处 `catch (_) {}` 式的空体 catch，失败既无提示也无日志，
 * 是最大的错误处理盲区（「检测更新永远显示最新」的根因之一就是被吞掉的
 * JSON.parse 异常）。本门禁的目标不是消灭静默，而是让每一处静默都有明确归属。
 *
 * 判定：先扫描出所有 catch 语句的大括号体，体内去掉注释后只剩空白/孤立分号的算
 * 「空体」。每个空体必须满足其一，否则 ERROR（退出码 1）：
 *   ① 体内有实质语句（log/toast/计数等）——扫描器自动判定「非空体」，不管内容；
 *   ② 体内有一行理由注释，格式 `// 静默：<中文理由>`（块注释 /* 静默：… *\/ 也认）；
 *   ③ 文件路径+行号登记在 tools/empty-catch-allowlist.json（待治理存量，带 A/B/C 分级）。
 *
 * 扫描范围：.ts/.uts/.uvue（.uvue 只扫 <script> 段，模板内联表达式不管），排除
 * unpackage/、node_modules/、_tmp/、隐藏目录和 tools/ 自身。识别 `catch` /
 * `catch (e)` / `catch {`（可省参）后的大括号体；对多行体、嵌套花括号、字符串 /
 * 模板串 / 正则里的干扰字符稳健——字符级状态机（引用 check-toast.mjs 的无依赖
 * 风格 + audit-px-units.mjs 的括号深度思路），不做完整语法解析。
 *
 * 白名单 tools/empty-catch-allowlist.json 按文件分组，条目含 line/kind/note/anchor：
 *   - line   catch 关键字所在行号（1 起）
 *   - kind   A=用户动作路径 / B=后台清理类 / C=解析兜底；`?`=登记时未分类
 *   - anchor 该 catch 的归一化文本 + 紧邻下一行摘要，用于行号漂移时的兜底匹配
 * 行号精确匹配优先；只按 anchor 命中的算「漂移」，打 NOTE 提示更新行号（不失败）。
 * 失效条目（登记处已无空体 catch——多半是治理完了忘删）同样只打 NOTE，不失败：
 * 门禁只拦「新增的未登记静默」，账本维护靠 NOTE 提示，避免并行改动互相卡门禁。
 *
 * 维护：
 *   node tools/check-empty-catch.mjs                   # 门禁（npm run check 末尾自动跑）
 *   node tools/check-empty-catch.mjs --init-allowlist   # 把当前所有违规按现状登记进白名单，
 *                                                       # kind 记为 "?"，需人工改成 A/B/C 并写明理由
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS_DIR = join(ROOT, "tools");
const ALLOWLIST_PATH = join(TOOLS_DIR, "empty-catch-allowlist.json");
const ALLOWLIST_HINT = "存量先登记 tools/empty-catch-allowlist.json，治理后删除条目";
/** 理由注释：`// 静默：<非空理由>`（冒号全半角均可；块注释同样接受） */
const SILENT_RE = /(?:\/\/|\/\*)\s*静默\s*[:：]\s*\S/;

// ==================== 遍历 ====================

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "unpackage" || e === "_tmp" || e.startsWith(".")) continue;
    const full = join(dir, e);
    if (full === TOOLS_DIR) continue; // 门禁不扫 tools/ 自身
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(uvue|uts|ts)$/.test(e)) out.push(full);
  }
  return out;
}

// ==================== 字符级扫描 ====================

const ID_START = /[A-Za-z_$]/;
const ID_CHAR = /[A-Za-z0-9_$]/;
/** 这些有意义的 token 之后，`/` 按正则字面量处理；其余情况按除号 */
const PUNCT_BEFORE_REGEX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">"]);
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof", "do", "else", "await", "yield", "throw"]);

function regexAllowedAfter(prev) {
  if (prev === "" || PUNCT_BEFORE_REGEX.has(prev)) return true;
  if (prev === "str" || prev === "re" || prev === ")" || prev === "]") return false;
  return KEYWORDS_BEFORE_REGEX.has(prev); // 标识符/数字后是除号
}

/** 跳过单行注释（含换行符本身不吞） */
function skipLineComment(src, i, to) {
  while (i < to && src[i] !== "\n") i++;
  return i;
}

/** 跳过块注释 */
function skipBlockComment(src, i, to) {
  i += 2;
  while (i < to) {
    if (src[i] === "*" && src[i + 1] === "/") return i + 2;
    i++;
  }
  return to;
}

/** 跳过引号字符串（含转义；遇到换行按失配返回，防单只引号吃掉整个文件） */
function skipQString(src, i, to) {
  const q = src[i];
  i++;
  while (i < to) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    if (c === "\n") return i; // 未闭合：按普通文本处理，别吞掉后面的代码
    i++;
  }
  return to;
}

/** 跳过正则字面量（含 [字符类]；遇到换行按失配返回） */
function skipRegex(src, i, to) {
  i++;
  let inClass = false;
  while (i < to) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") return i; // 其实不是正则：止损返回
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (c === "/") {
      i++;
      while (i < to && /[a-z]/i.test(src[i])) i++; // 标志位
      return i;
    }
    i++;
  }
  return to;
}

/**
 * 扫描 [from,to) 内的所有 catch 语句，返回
 * { headStart, braceIdx, bodyEnd }：catch 关键字下标、体 `{` 下标、体 `}` 下标。
 * 栈帧：tpl=模板串文本、tplExpr=${} 表达式、brace=花括号（catchRec 挂体记录）、paren=圆括号。
 */
function scanCatches(src, from, to) {
  const out = [];
  const stack = [];
  let pendingCatch = null;
  let parenDepth = 0;
  let i = from;
  let prev = ""; // 上一个有意义的 token（词 / 单字符 / "str" / "re"），正则启发用
  while (i < to) {
    const c = src[i];
    const d = i + 1 < to ? src[i + 1] : "";
    const top = stack[stack.length - 1];
    // 模板串文本：只认 \ 转义、` 结束、${ 进表达式，其余全是字面量（含引号/斜杠/花括号）
    if (top && top.kind === "tpl") {
      if (c === "\\") i += 2;
      else if (c === "`") {
        stack.pop();
        i++;
        prev = "str";
      } else if (c === "$" && d === "{") {
        stack.push({ kind: "tplExpr" });
        i += 2;
        prev = "(";
      } else i++;
      continue;
    }
    if (c === "/" && d === "/") {
      i = skipLineComment(src, i, to);
      continue;
    }
    if (c === "/" && d === "*") {
      i = skipBlockComment(src, i, to);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQString(src, i, to);
      prev = "str";
      continue;
    }
    if (c === "`") {
      stack.push({ kind: "tpl" });
      i++;
      prev = "str";
      continue;
    }
    if (c === "/" && regexAllowedAfter(prev)) {
      i = skipRegex(src, i, to);
      prev = "re";
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < to && ID_CHAR.test(src[j])) j++;
      const word = src.slice(i, j);
      // `.catch(...)` 是 Promise 方法调用，不是 catch 语句；
      // parenBase 记下挂起时的圆括号深度：体内 `{` 必须回到同一深度
      // （catch 自己的 `(e)`、解构 `({x})` 都在更深层，不会被误认成体）
      if (word === "catch" && prev !== ".") pendingCatch = { headStart: i, braceIdx: -1, parenBase: parenDepth };
      prev = word;
      i = j;
      continue;
    }
    if (c === "{") {
      let rec = null;
      // 体 `{` 必须回到 pendingCatch 挂起时的圆括号深度：
      // 回调/IIFE/模板表达式里的 catch 常年处于外层括号内（全局深度 >0），
      // 用「相对深度」判断才不会漏；catch 参数解构 `{` 在更深层，自然不算
      if (pendingCatch && parenDepth === pendingCatch.parenBase) {
        rec = pendingCatch;
        pendingCatch = null;
        rec.braceIdx = i;
      }
      stack.push({ kind: "brace", catchRec: rec });
      i++;
      prev = "{";
      continue;
    }
    if (c === "}") {
      if (top && top.kind === "tplExpr") {
        stack.pop(); // 表达式结束，回到模板文本
        i++;
        prev = "}";
        continue;
      }
      if (top && top.kind === "brace") {
        stack.pop();
        if (top.catchRec) {
          top.catchRec.bodyEnd = i;
          out.push(top.catchRec);
        }
      }
      i++;
      prev = "}";
      continue;
    }
    if (c === "(") {
      stack.push({ kind: "paren" });
      parenDepth++;
      i++;
      prev = "(";
      continue;
    }
    if (c === ")") {
      if (top && top.kind === "paren") {
        stack.pop();
        parenDepth--;
      }
      i++;
      prev = ")";
      continue;
    }
    if (c === ";") pendingCatch = null; // 防御：无体 catch 不存在，别让挂起状态漂走
    i++;
    if (!/\s/.test(c)) prev = c; // 空白不更新 prev：`= /a{2}/` 的正则启发别被空格顶掉
  }
  return out;
}

/** catch 体内去掉注释后是否还有实质内容（非空白、非孤立分号） */
function bodyHasStatement(body) {
  const stack = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    const d = i + 1 < body.length ? body[i + 1] : "";
    const top = stack[stack.length - 1];
    if (top === "tpl") {
      if (c === "\\") i += 2;
      else if (c === "`") {
        stack.pop();
        i++;
      } else if (c === "$" && d === "{") {
        stack.push("expr");
        i += 2;
      } else return true; // 模板文本在表达式位置 = 体内有内容
      continue;
    }
    if (c === "/" && d === "/") {
      i = skipLineComment(body, i, body.length);
      continue;
    }
    if (c === "/" && d === "*") {
      i = skipBlockComment(body, i, body.length);
      continue;
    }
    if (c === '"' || c === "'" || c === "/") return true; // 字符串/正则字面量即内容
    if (c === "`") {
      stack.push("tpl");
      i++;
      continue;
    }
    if (top === "expr" && c === "}") {
      stack.pop();
      i++;
      continue;
    }
    if (!/\s/.test(c) && c !== ";") return true;
    i++;
  }
  return false;
}

/** .uvue 只扫 <script> 段，返回 [start,end) 列表 */
function scriptRanges(src) {
  const ranges = [];
  const re = /<script\b[^>]*>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const end = src.indexOf("</script>", start);
    if (end === -1) break;
    ranges.push([start, end]);
    re.lastIndex = end + 9;
  }
  return ranges;
}

function makeLineOf(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function collapse(s) {
  return s.replace(/\s+/g, " ").trim();
}

/** 归一化 catch 文本 + 紧邻下一行摘要（同形 catch 的区分度；允许行号漂移后兜底匹配） */
function anchorOf(src, rec) {
  const raw = collapse(src.slice(rec.headStart, rec.bodyEnd + 1));
  let j = rec.bodyEnd + 1;
  let next = "";
  while (j < src.length) {
    const nl = src.indexOf("\n", j);
    const seg = nl === -1 ? src.slice(j) : src.slice(j, nl);
    const t = collapse(seg);
    if (t.length > 0) {
      next = t.slice(0, 60);
      break;
    }
    if (nl === -1) break;
    j = nl + 1;
  }
  return (raw + " ∥ " + next).slice(0, 200);
}

// ==================== 单文件汇总 ====================

/**
 * 返回 { catchTotal, empties: [{ line, anchor, head, annotated }] }。
 * empties 只含「去注释后无实质内容」的空体 catch；annotated=已带 // 静默： 理由。
 */
function collectFile(full, rel) {
  const src = readFileSync(full, "utf8");
  const lineOf = makeLineOf(src);
  const ranges = rel.endsWith(".uvue") ? scriptRanges(src) : [[0, src.length]];
  let catchTotal = 0;
  const empties = [];
  for (const [a, b] of ranges) {
    for (const rec of scanCatches(src, a, b)) {
      catchTotal++;
      const body = src.slice(rec.braceIdx + 1, rec.bodyEnd);
      if (bodyHasStatement(body)) continue;
      empties.push({
        line: lineOf(rec.headStart),
        anchor: anchorOf(src, rec),
        head: collapse(src.slice(rec.headStart, rec.bodyEnd + 1)).slice(0, 120),
        annotated: SILENT_RE.test(body),
      });
    }
  }
  return { catchTotal, empties };
}

// ==================== 白名单 ====================

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return null;
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  if (raw == null || typeof raw.files !== "object" || Array.isArray(raw.files)) {
    console.log("ERROR tools/empty-catch-allowlist.json 格式不对：需要 { \"files\": { \"<相对路径>\": { \"note\": \"…\", \"items\": [{ \"line\": 1, \"kind\": \"B\", \"note\": \"…\", \"anchor\": \"…\" }] } } }");
    process.exit(1);
  }
  return raw;
}

// ==================== 主流程 ====================

/** 供测试与维护脚本复用；直接 node 运行时才执行门禁 */
export { scanCatches, bodyHasStatement, collectFile, loadAllowlist };

function main() {
  const initMode = process.argv.includes("--init-allowlist");
  const allowlist = loadAllowlist();
  const files = walk(ROOT);

  let catchTotal = 0;
  let nonEmpty = 0;
  let annotated = 0;
  let allowlisted = 0;
  const violations = [];
  const notes = [];
  const initFiles = {}; // --init-allowlist 用：rel -> 待登记条目

  for (const full of files) {
    const rel = relative(ROOT, full).replace(/\\/g, "/");
    const { catchTotal: ct, empties } = collectFile(full, rel);
    catchTotal += ct;
    nonEmpty += ct - empties.length;
    if (empties.length === 0) continue;

    const group = allowlist && allowlist.files ? allowlist.files[rel] : null;
    const items = group && Array.isArray(group.items) ? group.items.map((it) => ({ ...it, used: false })) : [];

    for (const em of empties) {
      if (em.annotated) {
        annotated++;
        continue;
      }
      // ① 行号精确匹配（同位置内容若与登记不符，打 NOTE 提示复核分级）
      let hit = items.find((it) => !it.used && it.line === em.line);
      if (hit && hit.anchor && em.anchor !== hit.anchor) {
        notes.push(`${rel}:${em.line} 白名单条目 anchor 与现状不一致，请复核 kind 归类（内容可能已被改动）`);
      }
      // ② anchor 兜底匹配（行号漂移：登记时记录的行上已无空体 catch）
      if (!hit) {
        hit = items.find((it) => !it.used && typeof it.anchor === "string" && it.anchor === em.anchor);
        if (hit) notes.push(`${rel}:${em.line} 白名单条目自登记行 ${hit.line} 漂移至此（anchor 匹配），建议更新行号`);
      }
      if (hit) {
        hit.used = true;
        allowlisted++;
      } else {
        violations.push({ rel, line: em.line, head: em.head });
        (initFiles[rel] = initFiles[rel] || []).push({ line: em.line, kind: "?", note: "待治理", anchor: em.anchor });
      }
    }
    for (const it of items) {
      if (!it.used) notes.push(`${rel}:${it.line} 白名单条目已失效（该处已无未登记空体 catch——治理完忘了删？或已带 // 静默： 理由），请从 allowlist 删除`);
    }
  }

  if (initMode) {
    // 把当前所有违规按现状登记进白名单：已有分组保留，只追加缺失条目
    const next = allowlist || { files: {} };
    if (!next.files) next.files = {};
    let added = 0;
    for (const rel of Object.keys(initFiles).sort()) {
      const group = next.files[rel] || { note: "待治理", items: [] };
      const known = new Set((group.items || []).map((it) => `${it.line}:${it.anchor}`));
      for (const item of initFiles[rel]) {
        const key = `${item.line}:${item.anchor}`;
        if (known.has(key)) continue;
        group.items.push(item);
        known.add(key);
        added++;
      }
      group.items.sort((a, b) => a.line - b.line);
      next.files[rel] = group;
    }
    writeFileSync(ALLOWLIST_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`[check-empty-catch] --init-allowlist：新增登记 ${added} 条 → tools/empty-catch-allowlist.json（kind 均为 "?"，请人工改为 A/B/C 并补 note 理由）`);
  }

  for (const v of violations) console.log(`ERROR ${v.rel}:${v.line} 空体 catch 未治理：${v.head}`);
  for (const n of notes) console.log(`NOTE ${n}`);
  console.log(
    `[check-empty-catch] 扫描 ${files.length} 个文件，catch 语句 ${catchTotal} 处；空体 ${annotated + allowlisted + violations.length} 处 = 静默注释 ${annotated} + 白名单 ${allowlisted} + 违规 ${violations.length}（非空体 ${nonEmpty} 处不拦）` +
      (violations.length > 0 ? `；处理方式：体内加实质语句或 // 静默：<理由>，${ALLOWLIST_HINT}` : ""),
  );
  if (violations.length > 0) process.exit(1);
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (isMain) main();
