/**
 * .uvue 结构自检 + 图标一致性自检
 *
 * 1. 使用项目已有的 @vue/compiler-sfc 解析每个页面/组件，校验 template /
 *    script / style 块能否被正确解析，捕获标签未闭合、属性语法错误等结构性问题。
 * 2. 校验模板中 QtIcon 引用的图标名都在 uni_modules/qt-ui/services/icons.ts 中有定义，
 *    并报告已定义但无人使用的图标。
 * 3. 扫描模板里是否残留“文字当图标”的符号字形（♥ ▶ × 等），
 *    确保全站图标只有一个来源。
 *
 * 注意：这不是 UniAppX 官方编译（UTS 类型检查需要 HBuilderX），
 * 只覆盖 SFC 与模板语法层面的错误。
 *
 * 运行：node tools/check-uvue.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dirname } from "node:path";
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

/** 读取 uni_modules/qt-ui/services/icons.ts 中定义的图标名 */
function definedIcons() {
  const src = readFileSync(join(ROOT, "uni_modules", "qt-ui", "services", "icons.ts"), "utf8");
  const start = src.indexOf("const ICON_BODIES");
  const block = src.slice(start, src.indexOf("\n};", start));
  const names = new Set();
  for (const m of block.matchAll(/^\s+"?([a-z0-9-]+)"?:\s*'/gm)) names.add(m[1]);
  return names;
}

/** 提取模板中 QtIcon 使用的图标名（含三元表达式两个分支） */
function usedIcons(template) {
  const names = new Set();
  for (const tag of template.matchAll(/<QtIcon[^>]*>/g)) {
    const t = tag[0];
    const literal = t.match(/\sname="([a-z0-9-]+)"/);
    if (literal) { names.add(literal[1]); continue; }
    const dynamic = t.match(/:name="([^"]+)"/);
    if (dynamic) for (const q of dynamic[1].matchAll(/'([a-z0-9-]+)'/g)) names.add(q[1]);
  }
  return names;
}

/** 提取 script 中以 return "xxx" 形式间接提供的图标名（如 modeIconName()） */
function indirectIcons(script, defined) {
  const names = new Set();
  for (const m of script.matchAll(/return "([a-z0-9-]+)"/g)) if (defined.has(m[1])) names.add(m[1]);
  return names;
}

// 疑似“文字当图标”的符号区间：箭头、几何、杂项、emoji、全角尖括号、乘号
const GLYPH_RE =
  /[\u2190-\u21FF\u2300-\u23FF\u2500-\u27BF\u2B00-\u2BFF\u00D7\u2039\u203A\uFF1C\uFF1E]|[\uD83C-\uDBFF][\uDC00-\uDFFF]/g;

// tabBar 图标只在 tools/gen-tab-icons.mjs 中按同一几何规范栅格化，
// 不会出现在任何 .uvue 模板里，因此不算“未使用”。
// loader 图标被 uni_modules/qt-ui/components/qt-loading/qt-loading.uvue 通过 iconSrc("loader") 直接使用
// （组件内部用 <image>+transform 驱动旋转，不走 <QtIcon>），check 静态扫描扫不到，
// 同样加入豁免集合。
const TAB_ICON_NAMES = new Set(["compass", "music", "user", "loader"]);

const files = walk(ROOT);
const defined = definedIcons();
const used = new Set();
let failed = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const source = readFileSync(file, "utf8");
  const { descriptor, errors } = parse(source, { filename: rel });
  if (errors.length > 0) {
    failed++;
    console.log("SFC ERROR " + rel);
    for (const e of errors) console.log("   " + (e.message ?? e));
    continue;
  }

  const problems = [];
  const script =
    (descriptor.scriptSetup?.content ?? "") + "\n" + (descriptor.script?.content ?? "");
  if (descriptor.template != null) {
    const tpl = descriptor.template.content;
    const result = compileTemplate({ source: tpl, filename: rel, id: rel });
    const real = result.errors.filter((e) => {
      const msg = typeof e === "string" ? e : e.message;
      // uni-app 内置组件不在 Vue DOM 标签表中，属于预期告警
      return !/is not a valid HTML|Unknown custom element/i.test(msg);
    });
    for (const e of real) problems.push("template: " + (typeof e === "string" ? e : e.message));

    for (const name of usedIcons(tpl)) {
      used.add(name);
      if (!defined.has(name)) problems.push('icon "' + name + '" not defined in uni_modules/qt-ui/services/icons.ts');
    }
    for (const name of indirectIcons(script, defined)) used.add(name);

    const glyphs = [...new Set(tpl.match(GLYPH_RE) ?? [])];
    if (glyphs.length > 0) problems.push("symbol glyph used as icon: " + glyphs.join(" "));

    if (tpl.includes("<QtIcon") && !/import QtIcon from "@\/(components\/qt-icon\.uvue|uni_modules\/qt-ui\/components\/qt-icon\/qt-icon\.uvue)"/.test(script)) {
      problems.push("uses QtIcon without importing it");
    }
  }

  if (problems.length > 0) {
    failed++;
    console.log("FAIL " + rel);
    for (const p of problems) console.log("   " + p);
  } else {
    console.log("ok " + rel);
  }
}

const unused = [...defined].filter((n) => !used.has(n) && !TAB_ICON_NAMES.has(n));
console.log("\nicons defined: " + defined.size + ", referenced: " + used.size);
if (unused.length > 0) {
  console.log("UNUSED icons: " + unused.join(" "));
  failed++;
}
console.log("checked " + files.length + " files, " + failed + " with errors");
if (failed > 0) process.exitCode = 1;
