/**
 * 手机档写死 px 审计（AST 版）
 *
 * 判定逻辑：对每条 `font-size: Npx` 的样式规则，找到模板里用到该类的节点，
 * 判断该节点是否「只可能出现在宽屏」。宽屏判定沿祖先链累积：
 *   1. 祖先带 v-if / v-else-if / v-show，表达式含 isWide 且是肯定形态
 *      （layout.isWide、layout.isWide === true、三元里的宽屏分支）
 *   2. 祖先带 v-else / 三元 else 分支，且其前面的兄弟节点是 isWide
 * 若一个类既出现在宽屏链里、也出现在非宽屏链里，按「有问题」处理（手机档会吃到 px）。
 *
 * 报告四类缺陷：
 *   A. 手机档会吃到 px 字号（真缺陷；祖先链判定不出「只在某个 prop 为真时渲染」的档位，
 *      这类属已知误报，见 WHITELIST）
 *   B. `-wide` 类被 :class 引用但 <style> 无定义（宽屏档静默失效）
 *   D. `-wide` 类已定义但模板从不引用（宽屏拿不到覆盖，base 的 rpx 顶上来）
 *   C. class 写 px 但节点已被内联 qtFont* 覆盖（死代码，仅提示）
 *
 * 规格：`uni_modules/qt-ui/docs/design.md` §「页面骨架模式」的 px/rpx 成对写法。
 *
 * 运行：node tools/audit-px-units.mjs          # 报告，永远 exit 0
 *       node tools/audit-px-units.mjs --strict # A/B/D 非空即 exit 1（CI 用）
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, compileTemplate } from "@vue/compiler-sfc";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "unpackage" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".uvue")) out.push(full);
  }
  return out;
}

/** 解析 <style> 块为 { selector, decls } 列表 */
function styleRules(sfc) {
  const out = [];
  for (const blk of sfc.styles) {
    const clean = blk.content.replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0,
      sel = "",
      buf = "";
    for (const ch of clean) {
      if (ch === "{") {
        if (depth === 0) {
          sel = buf.trim();
          buf = "";
        }
        depth++;
        continue;
      }
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          out.push({ selector: sel, decls: buf });
          buf = "";
        } else buf += ch;
        continue;
      }
      if (depth === 0) buf += ch;
      else buf += ch;
    }
  }
  return out;
}

/** 条件表达式是否「宽屏成立」；返回 true/false/null(与宽屏无关) */
function condWide(expr) {
  const e = expr.replace(/\s+/g, "");
  if (!e.includes("isWide")) return null;
  if (/!\s*[\w.]*isWide/.test(e)) return false;
  if (/isWide===true|isWide==true/.test(e)) return true;
  if (/isWide===false|isWide==false/.test(e)) return false;
  return true;
}

/** 顶层（不在括号/引号里的）某个字符切分 */
function splitTop(expr, sep) {
  const out = [];
  let depth = 0,
    quote = "",
    buf = "";
  for (const ch of expr) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

const CLS_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

/**
 * 已知误报：祖先链只能看到 v-if / v-show，看不到「这个组件挂在某个 prop 为真时才渲染的档位」。
 * 白名单条目必须写明为什么手机档到不了，否则不许加。
 * 键 = 相对路径，值 = { 类名: 理由 }。
 */
const WHITELIST = {
  "uni_modules/qt-ui/components/qt-batch-bar/qt-batch-bar.uvue": {
    "qt-batch-bar-col-label":
      "column 档只在 layout=\"column\" 时渲染（模板 v-if=\"column\"），两处调用都在宽屏左栏的 v-if=\"layout.isWide\" 内",
    "qt-batch-bar-col-btn-text": "同上，column 档专用的宽屏左栏封面块",
  },
};

/** 抽字符串字面量里的类名（一个字面量里可能有多类，按空白切） */
function literalTokens(text) {
  const out = [];
  for (const m of text.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    for (const tok of v.split(/[\s,]+/)) if (CLS_RE.test(tok)) out.push(tok);
  }
  return out;
}

/**
 * 把 :class 表达式拆成 [{cls, wide}]，按三元分支判定每个类名落在宽屏还是手机档。
 * 支持：'a' / "a b" / layout.isWide ? 'a-wide' : 'a' /
 *      [layout.isWide ? 'a-wide' : '', cond ? 'b' : 'c'] / !layout.isWide ? ... : ...
 */
function classTokens(expr, inheritedWide, depth = 0) {
  const out = [];
  if (depth > 6) return out;
  let body = expr.trim();
  // 递归剥掉外层方括号（嵌套数组写法 [ [..], .. ] 很常见）
  for (;;) {
    if (!(body.startsWith("[") && body.endsWith("]"))) break;
    const inner = body.slice(1, -1);
    // 确认这对括号是配对的整体，而不是 [a],[b] 这种
    let nest = 0,
      matched = true;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === "[") nest++;
      else if (ch === "]") {
        nest--;
        if (nest === 0) {
          if (i !== body.length - 1) matched = false;
          break;
        }
      }
    }
    if (!matched) break;
    body = inner.trim();
  }
  for (const rawItem of splitTop(body, ",")) {
    const item = rawItem.trim();
    if (!item) continue;
    // 嵌套数组项（[[a],[b]] 这种）递归进去；剥不掉外层括号就按普通表达式处理，避免自递归
    if (item.startsWith("[") && item.endsWith("]")) {
      const nested = classTokens(item, inheritedWide, depth + 1);
      if (nested.length > 0) {
        out.push(...nested);
        continue;
      }
    }
    const q = splitTop(item, "?");
    if (q.length >= 2) {
      const cond = q[0];
      const branches = splitTop(q.slice(1).join("?"), ":");
      const cw = condWide(cond);
      const thenPart = branches[0] ?? "";
      const elsePart = branches.slice(1).join(":") ?? "";
      // cond 与宽屏相关时按分支定档；否则两个分支继承外层档位
      const thenWide = cw === null ? inheritedWide : cw;
      const elseWide = cw === null ? inheritedWide : !cw;
      for (const c of literalTokens(thenPart)) out.push({ cls: c, wide: thenWide });
      for (const c of literalTokens(elsePart)) out.push({ cls: c, wide: elseWide });
      continue;
    }
    for (const c of literalTokens(item)) out.push({ cls: c, wide: inheritedWide });
  }
  return out;
}

function directiveOf(node) {
  for (const p of node.props || []) {
    if (p.type !== 7) continue;
    if (p.name === "if") return { kind: "if", expr: p.exp ? p.exp.content : "" };
    if (p.name === "else-if") return { kind: "else-if", expr: p.exp ? p.exp.content : "" };
    if (p.name === "else") return { kind: "else", expr: "" };
    if (p.name === "show") return { kind: "show", expr: p.exp ? p.exp.content : "" };
  }
  return null;
}

/**
 * 递归收集「类名 -> 出现上下文」。
 *
 * 宽屏判定只在「兄弟链」层面做，节点自身的 v-if 由父级处理：
 * v-if="!isWide" → 后续 v-else 就是宽屏；v-if="isWide" → 本支宽屏。
 */
function collect(node, inheritedWide, acc, tpl) {
  const children = node.children || [];
  let prevCond = null; // 上一条 v-if / v-else-if 的 condWide
  for (const child of children) {
    if (typeof child !== "object" || !child.type || child.type !== 1) continue;
    let wide = inheritedWide;
    const d = directiveOf(child);
    if (d && d.kind === "if") {
      prevCond = condWide(d.expr);
      if (prevCond === true) wide = true;
    } else if (d && d.kind === "else-if") {
      const c = condWide(d.expr);
      if (prevCond === false || c === true) wide = true;
      prevCond = c;
    } else if (d && d.kind === "else") {
      if (prevCond === false) wide = true;
      prevCond = null;
    } else if (d && d.kind === "show") {
      if (condWide(d.expr) === true) wide = true;
    } else {
      prevCond = null;
    }

      const line = lineOf(tpl, child.loc.start.offset);
    // 该节点是否带内联字号：内联优先级高于 class，带内联时 class 里的 px 是死代码
    let inlineFont = false;
    for (const p of child.props) {
      if (p.type === 7 && p.arg && p.arg.content === "style" && p.exp) {
        if (/qtFont/.test(p.exp.content) || /font-size/.test(p.exp.content)) inlineFont = true;
      }
    }
    for (const p of child.props) {
      let expr = null;
      if (p.type === 6 && (p.name === "class" || p.name === "placeholder-class") && p.value)
        expr = '"' + p.value.content + '"';
      else if (p.type === 7 && p.arg && (p.arg.content === "class" || p.arg.content === "placeholder-class") && p.exp)
        expr = p.exp.content;
      if (expr == null) continue;
      for (const t of classTokens(expr, wide)) {
        if (!acc.has(t.cls)) acc.set(t.cls, []);
        acc.get(t.cls).push({ wide: t.wide, line, inlineFont });
      }
    }
    collect(child, wide, acc, tpl);
  }
}
function lineOf(tpl, offset) {
  return tpl.slice(0, offset).split("\n").length;
}

const files = walk(ROOT);
const problemsA = [];
const problemsB = [];
const problemsD = [];
const deadInline = [];
let totalPxRules = 0;
let wideOnlyPxRules = 0;

for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, "/");
  const src = readFileSync(f, "utf8");
  const sfc = parse(src, { filename: f }).descriptor;
  if (!sfc.template) continue;
  const rules = styleRules(sfc);

  const defined = new Set();
  for (const r of rules)
    for (const s of r.selector.split(","))
      for (const m of s.matchAll(/\.([A-Za-z0-9_-]+)/g)) defined.add(m[1]);

  const tpl = sfc.template.content;
  const acc = new Map();
  collect(sfc.template.ast, false, acc, tpl);

  const pxClasses = new Map();
  for (const r of rules) {
    for (const m of r.decls.matchAll(/font-size\s*:\s*([\d.]+)px/g)) {
      totalPxRules++;
      for (const s of r.selector.split(",")) {
        for (const cm of s.trim().matchAll(/\.([A-Za-z0-9_-]+)/g)) {
          const cls = cm[1];
          if (!pxClasses.has(cls)) pxClasses.set(cls, { px: m[1], selector: r.selector.trim() });
        }
      }
    }
  }

  for (const [cls, info] of pxClasses) {
    const uses = acc.get(cls) || [];
    if (uses.length === 0) {
      // 未被引用的 -wide 类统一由下面的 D 段处理
      continue;
    }
    // 只有「手机档生效 且 未被内联字号覆盖」才是真缺陷
    const effective = uses.filter((u) => !u.wide && !u.inlineFont);
    if (effective.length === 0) {
      if (uses.some((u) => !u.wide)) deadInline.push({ rel, cls, px: info.px, lines: [...new Set(uses.map((u) => u.line))] });
      else wideOnlyPxRules++;
      continue;
    }
    problemsA.push({
      rel,
      cls,
      px: info.px,
      lines: [...new Set(effective.map((u) => u.line))],
      mix: uses.some((u) => u.wide),
      whitelist: (WHITELIST[rel] || {})[cls] || null,
    });
  }

  // B: -wide 类被引用但没定义
  for (const [cls, uses] of acc) {
    if (!/-wide$/.test(cls)) continue;
    if (defined.has(cls)) continue;
    problemsB.push({ rel, cls, base: cls.replace(/-wide$/, ""), uses });
  }

  // D: -wide 定义了但模板从不引用 —— 宽屏拿不到覆盖，base 的 rpx 会顶上来
  //    注意：大量组件用 computed 拼接类名（`wide.value ? "x-wide" : "x"`），
  //    模板里只有 :class="computed"。这类类名在源码文本里除样式定义处还会出现，
  //    所以「全文只出现 1 次」才是真的没人引用。骨骼屏组件还用前缀拼接
  //    （"qt-skl-" + name + "-wide"），整串从不出现，用 hasConcat 整体跳过。
  const hasConcat = /["'`]-wide["'`]/.test(src);
  for (const cls of defined) {
    if (!/-wide$/.test(cls)) continue;
    if (acc.has(cls)) continue;
    if (hasConcat) continue;
    const occurrences = src.split(cls).length - 1;
    if (occurrences > 1) continue; // 脚本拼接，宽屏能拿到
    const base = cls.replace(/-wide$/, "");
    const baseRule = rules.find((r) => r.selector.split(",").some((s) => s.trim() === "." + base));
    const baseUses = acc.get(base) || [];
    // base 只在宽屏链里用到、或 base 根本没在模板出现，都不算缺陷
    if (baseRule == null) continue;
    if (baseUses.length > 0 && baseUses.every((u) => u.wide)) continue;
    problemsD.push({
      rel,
      cls,
      base,
      rpx: (baseRule.decls.match(/[\d.]+rpx/g) || []).join(","),
      px: (baseRule.decls.match(/[\d.]+px/g) || []).join(","),
    });
  }
}

console.log("=== A. 手机档会吃到 px 字号的类（真问题）===");
const realA = problemsA.filter((p) => p.whitelist == null);
const knownA = problemsA.filter((p) => p.whitelist != null);
const byFile = new Map();
for (const p of realA) {
  if (!byFile.has(p.rel)) byFile.set(p.rel, []);
  byFile.get(p.rel).push(p);
}
for (const [rel, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n## ${rel}  (${list.length} 类)`);
  for (const p of list)
    console.log(`   .${p.cls} = ${p.px}px   模板L${[...new Set(p.lines)].join("/")}${p.mix ? "  ← 同时也在宽屏用，需双档" : ""}`);
}
console.log(`\n小计 ${realA.length} 个类 / ${byFile.size} 个文件`);
for (const p of knownA)
  console.log(`\n（白名单 ${problemsA.length - realA.length} 类）${p.rel}  .${p.cls} = ${p.px}px —— ${p.whitelist}`);

console.log("\n=== B. -wide 类被模板引用但无定义（宽屏档静默失效）===");
for (const p of problemsB) console.log(`  ${p.rel}  .${p.cls}  模板 L${p.uses.map((u) => u.line).join(",")} 引用`);
console.log(`\n小计 ${problemsB.length} 处`);

console.log("\n=== D. -wide 类已定义但模板从不引用（宽屏拿不到覆盖）===");
const dByFile = new Map();
for (const p of problemsD) {
  if (!dByFile.has(p.rel)) dByFile.set(p.rel, []);
  dByFile.get(p.rel).push(p);
}
for (const [rel, list] of dByFile) console.log(`  ${rel}: ${list.map((p) => `.${p.cls}  (base ${p.base} rpx=[${p.rpx}] px=[${p.px}])`).join("; ")}`);
console.log(`\n小计 ${problemsD.length} 个类`);

console.log("\n=== C. class 写 px 但节点已被内联字号覆盖（死代码，非缺陷）===");
const deadByFile = new Map();
for (const d of deadInline) {
  if (!deadByFile.has(d.rel)) deadByFile.set(d.rel, []);
  deadByFile.get(d.rel).push(d);
}
for (const [rel, list] of deadByFile) console.log(`  ${rel}: ${list.map((d) => `${d.cls}(${d.px}px)`).join(", ")}`);
console.log(`\n小计 ${deadInline.length} 个类（可不改，但 class 里的 px 应与内联基准一致）`);

console.log(`\n=== 统计 ===`);
console.log(`  px 字号规则总数: ${totalPxRules}`);
console.log(`  仅宽屏使用（正常）: ${wideOnlyPxRules}`);
console.log(`  手机档会吃到（需修）: ${realA.length}${knownA.length > 0 ? `（另有 ${knownA.length} 类在白名单）` : ""}`);
console.log(`  被内联覆盖（死代码）: ${deadInline.length}`);

if (process.argv.includes("--strict")) {
  const fails = [];
  if (realA.length > 0) fails.push(`A 段 ${realA.length} 类手机档会吃到 px 字号`);
  if (problemsB.length > 0) fails.push(`B 段 ${problemsB.length} 处 -wide 类被引用但无定义`);
  if (problemsD.length > 0) fails.push(`D 段 ${problemsD.length} 个 -wide 类定义了但从不引用`);
  if (fails.length > 0) {
    console.error(`\n[audit-px-units] 失败：${fails.join("；")}`);
    console.error("规格见 uni_modules/qt-ui/docs/design.md「页面骨架模式」：手机档写 rpx，宽屏用成对 -wide px。");
    process.exit(1);
  }
  console.log("\n[audit-px-units] 通过：A/B/D 段均无缺陷");
}
