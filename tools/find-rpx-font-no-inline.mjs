// 进一步收敛风险：只报告「模板节点上既没有内联字号 helper、CSS 又只有 rpx」的类。
// 内联样式优先级高于类选择器，所以节点上有 qtFont*/qtFontDual* 时，CSS 里的 rpx 字号是死代码，
// 不会造成宽屏字号放大。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".uvue")) out.push(p);
  }
}

const files = [];
walk(path.join(root, "pages"), files);
walk(path.join(root, "uni_modules", "qt-ui", "components"), files);

const only = process.argv.slice(2).find((a) => !a.startsWith("--"));

// 把模板按「一个开始标签一块」切开，便于类名 -> 该标签内是否含内联字号。
// 必须按引号状态扫描：属性值里常有 `>`（如 v-if="a.length > 0"），
// 用 /<[A-Za-z][^<>]*>/ 这种正则会提前截断，导致内联样式被漏判。
function tagChunks(tpl) {
  const out = [];
  let i = 0;
  while (i < tpl.length) {
    const lt = tpl.indexOf("<", i);
    if (lt < 0) break;
    const next = tpl.charAt(lt + 1);
    if (!/[A-Za-z/]/.test(next)) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    let quote = "";
    while (j < tpl.length) {
      const ch = tpl.charAt(j);
      if (quote.length > 0) {
        if (ch == quote) quote = "";
      } else if (ch == '"' || ch == "'") {
        quote = ch;
      } else if (ch == ">") {
        break;
      }
      j++;
    }
    out.push(tpl.slice(lt, j + 1));
    i = j + 1;
  }
  return out;
}

const rows = [];
let cssDead = 0;

for (const f of files) {
  const rel = path.relative(root, f);
  if (only != null && !rel.includes(only)) continue;
  const src = fs.readFileSync(f, "utf8");
  const si = src.indexOf("<style");
  if (si < 0) continue;
  const style = src.slice(si);
  const scriptIdx = src.indexOf("<script");
  const tpl = scriptIdx < 0 ? "" : src.slice(0, scriptIdx);
  const chunks = tagChunks(tpl);

  const portraitChunks = [];
  const pre = /v-if="!layout\.isWide"/g;
  let m;
  while ((m = pre.exec(tpl)) != null) {
    const start = tpl.lastIndexOf("<", m.index);
    const els = tpl.indexOf("v-else", m.index);
    portraitChunks.push(tpl.slice(start < 0 ? 0 : start, els < 0 ? tpl.length : els));
  }
  const portraitText = portraitChunks.join("\n");

  const wideClasses = new Set();
  const wre = /^\.([A-Za-z0-9_-]+)-wide[^{]*\{/gm;
  while ((m = wre.exec(style)) != null) wideClasses.add(m[1]);

  const ruleRe = /^\.([A-Za-z0-9_-]+)([^{]*)\{([^}]*)\}/gm;
  while ((m = ruleRe.exec(style)) != null) {
    const cls = m[1];
    const body = m[3];
    if (!/font-size:\s*\d+rpx/.test(body) && !/line-height:\s*\d+rpx/.test(body)) continue;
    if (cls.endsWith("-wide")) continue;
    if (wideClasses.has(cls)) continue;
    if (!new RegExp("\\b" + cls + "\\b").test(tpl)) continue;
    if (new RegExp("\\b" + cls + "\\b").test(portraitText)) continue;

    const hit = chunks.filter((c) => new RegExp("class=\"[^\"]*\\b" + cls + "\\b").test(c));
    const hasInline = hit.some((c) => /qtFont|qtFontPx|qtFontRpx|qtFontDual/.test(c));
    if (hasInline) {
      cssDead++;
      continue;
    }
    rows.push({ file: rel, cls, body: body.replace(/\s+/g, " ").trim() });
  }
}

console.log("== rpx font on wide screens with NO inline font helper (real risk): " + rows.length + " ==");
for (const r of rows) console.log(r.file + "  ." + r.cls + "  { " + r.body + " }");
console.log("");
console.log("(skipped " + cssDead + " rules whose node already has an inline font helper -> CSS is dead code)");
