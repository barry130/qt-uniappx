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
  // 标题栏动作数组（如 pages/playlists 的 headerActions = ["grid"]）：
  // 图标名只出现在这个数组里，模板经 header-action 事件转发渲染
  for (const m of script.matchAll(/headerActions[^=]*=\s*\[([^\]]*)\]/g)) {
    for (const q of m[1].matchAll(/["']([a-z0-9-]+)["']/g)) if (defined.has(q[1])) names.add(q[1]);
  }
  return names;
}

/**
 * 元数据图标：部分图标名写在 .ts/.uts 的元数据数组里（如 stores/player-bar.ts 的
 * PLAYER_BAR_TOOLS[].icon），由模板 v-for 出来渲染，模板里看不到字面量。
 * 这类引用同样是真实引用，扫不到会把它们误报成 UNUSED。
 */
function metadataIcons(defined) {
  const names = new Set();
  for (const file of walkSources(ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bicon:\s*["']([a-z0-9-]+)["']/g)) {
      if (defined.has(m[1])) names.add(m[1]);
    }
  }
  return names;
}

/** 收集全仓 .ts/.uts 源文件（图标元数据的可能宿主） */
function walkSources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "unpackage" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSources(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".uts")) out.push(full);
  }
  return out;
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

// 元数据表里的图标名（如 stores/player-bar.ts 的 PLAYER_BAR_TOOLS[].icon）先计入已引用
for (const name of metadataIcons(defined)) used.add(name);

// ---- 模板标签白名单（2026-11-03，R17-C）----
// 编译器只认 Vue DOM 标签表：uni-app 内置组件（view/text/scroll-view/...）和
// 本仓自定义组件都不在表里，会报「Unknown custom element / not a valid HTML tag」。
// 旧实现一揽子按关键词过滤这两类告警——把组件名拼写错误（如 <QtButtn>）也吞了：
// uvue 运行时对未注册标签静默渲染成空节点，写错没有任何提示，只能靠这里兜。
// 现改为白名单口径：标签名（kebab 归一后）在「内置组件 ∪ script 里 import 的组件」
// 里才豁免，其余照常报错。宁多报不漏报——多报顶多让人改一下 import，漏报是线上静默丢 UI。
const BUILTIN_TAGS = new Set([
  // 本仓模板实际用到的 uni-app(x) 内置组件（grep 全量清点过）
  "view", "text", "image", "scroll-view", "input", "slider", "textarea",
  "web-view", "slot", "template", "list-item", "list-view",
  "sticky-section", "sticky-header",
  // uni-app(x) 其余内置：当前没用，但写模板时随时可能引入，提前豁免
  "swiper", "swiper-item", "video", "button", "switch", "checkbox",
  "checkbox-group", "radio", "radio-group", "picker", "picker-view",
  "picker-view-column", "form", "label", "navigator", "progress", "map",
  "canvas", "cover-view", "cover-image", "movable-area", "movable-view",
  "page-container", "root-portal", "match-media", "unicloud-db", "ad",
  "component", "block", "keep-alive", "teleport", "transition",
  "transition-group",
]);

/** kebab/Pascal 归一到小写驼峰再比对：<qt-button> ↔ QtButton 视为同名 */
function normalizeTag(tag) {
  return tag.replace(/-([a-z])/g, (_m, c) => c.toUpperCase()).toLowerCase();
}

/** 从编译告警里抠出涉及的标签名（抠不出来的返回 null：不豁免，宁多报） */
function tagFromTemplateWarning(msg) {
  let m = msg.match(/Unknown custom element:\s*<([\w-]+)/i);
  if (m != null) return m[1];
  m = msg.match(/<([\w-]+)[^>]*> is not a valid HTML tag/i)
    ?? msg.match(/([\w-]+) is not a valid HTML tag/i);
  if (m != null) return m[1];
  return null;
}

/** script 里 import 的标识符全集（组件注册来源；多算无害——多出来的只是豁免面） */
function importedIdentifiers(scriptContent) {
  const names = new Set();
  const re = /import\s+([A-Za-z_$][\w$]*)\s+from\s+["'][^"']+["']/g;
  let m;
  while ((m = re.exec(scriptContent)) != null) names.add(m[1]);
  return names;
}

/** 从编译 AST 收集全部元素标签名（v-if/v-for 的 branches 也要走）。
 *  走 AST 而不是正则扫模板文本：富文本字符串里的 <p>/<b> 之类不误伤，
 *  只看真正的元素节点。 */
function collectAstTags(node, out) {
  if (node == null || typeof node !== "object") return;
  if (typeof node.tag === "string" && node.type === 1) out.add(node.tag);
  if (Array.isArray(node.children)) for (const c of node.children) collectAstTags(c, out);
  if (Array.isArray(node.branches)) for (const b of node.branches) collectAstTags(b, out);
}

/** easycom 自动注册表：uni-app 约定 uni_modules/<模块>/components/<名>/<名>.uvue
 *  无需 import 即可在任何模板按 <名> 使用（本仓 qt-button/qt-sheet 等大量依赖此约定）。
 *  白名单必须把这一层也算进去，否则未 import 的 kebab 用法会误报。 */
function easycomComponentNames() {
  const names = new Set();
  const modulesDir = join(ROOT, "uni_modules");
  let modules = [];
  try {
    modules = readdirSync(modulesDir).filter((e) => statSync(join(modulesDir, e)).isDirectory());
  } catch (_e) {
    return names;
  }
  for (const mod of modules) {
    const compsDir = join(modulesDir, mod, "components");
    let comps = [];
    try {
      comps = readdirSync(compsDir).filter((e) => statSync(join(compsDir, e)).isDirectory());
    } catch (_e) {
      continue;
    }
    for (const comp of comps) {
      // 目录名即 easycom 组件名；顺手校验同名文件存在，防止目录空壳
      const file = join(compsDir, comp, comp + ".uvue");
      try {
        if (statSync(file).isFile()) names.add(comp);
      } catch (_e) {
        // 目录名与文件名不一致的组件不按 easycom 计入（实际无法免 import 使用）
      }
    }
  }
  return names;
}

const easycomNames = easycomComponentNames();

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
    // 白名单豁免（见上方 BUILTIN_TAGS 注释）：内置组件 + 本文件 import 的组件
    // + easycom 自动注册的组件（uni_modules/*/components/<名>/<名>.uvue）。
    // 两侧都过 normalizeTag：kebab ↔ Pascal 一致化后比对。
    const allowedTags = new Set();
    for (const builtin of BUILTIN_TAGS) allowedTags.add(normalizeTag(builtin));
    for (const name of importedIdentifiers(script)) allowedTags.add(normalizeTag(name));
    for (const name of easycomNames) allowedTags.add(normalizeTag(name));
    const real = result.errors.filter((e) => {
      const msg = typeof e === "string" ? e : e.message;
      // 与标签表无关的编译错误照常收集
      if (!/is not a valid HTML|Unknown custom element/i.test(msg)) return true;
      const tag = tagFromTemplateWarning(msg);
      if (tag == null) return true;
      return !allowedTags.has(normalizeTag(tag));
    });
    for (const e of real) problems.push("template: " + (typeof e === "string" ? e : e.message));

    // 未知标签主动检测（R17-C 的本体）：@vue/compiler-sfc 对未知组件并不报错
    // （上面那两条告警文案在现行版本里根本不出现），所以拼写错误在这里本来
    // 就是完全静默的——uvue 运行时把未注册标签渲染成空节点。拿 AST 里的元素
    // 标签对照白名单（内置组件 ∪ 本文件 import 的组件）补一道闸。
    if (result.ast != null) {
      const astTags = new Set();
      collectAstTags(result.ast, astTags);
      for (const tag of astTags) {
        if (!allowedTags.has(normalizeTag(tag))) {
          problems.push(
            "template: unknown tag <" + tag + "> — not a uni-app builtin and not imported in this file" +
            "（拼写错误/漏 import 都会静默渲染成空节点，请核对）"
          );
        }
      }
    }

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
