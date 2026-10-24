// 校验每个 import 自 font-scale 的名字在文件其余部分是否真的被使用（全文件范围，不只模板），
// 以及模板里用到的 qtFont* 是否都已 import。前者防止 codemod 留下死 import，后者防止漏 import。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (n === "node_modules" || n === "unpackage" || n.startsWith(".git")) continue;
    const p = join(d, n);
    statSync(p).isDirectory() ? walk(p) : n.endsWith(".uvue") && files.push(p);
  }
})(".");

const HELPERS = ["qtFont", "qtFontPx", "qtFontRpx", "qtFontDual", "qtFontDualPx"];
let problems = 0;

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const re = /import\s*\{([^}]*)\}\s*from\s*["']@\/uni_modules\/qt-ui\/stores\/font-scale["']\s*;?/g;
  const imported = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "");
      if (name) imported.push({ name, raw: raw.trim(), at: m.index });
    }
  }
  const body = src.replace(re, "");

  for (const { name, raw, at } of imported) {
    const uses = (body.match(new RegExp("\\b" + name.replace(/\$/g, "\\$") + "\\b", "g")) || []).length;
    if (uses === 0) {
      const line = src.slice(0, at).split("\n").length;
      console.log("UNUSED " + relative(".", f) + ":" + line + " :: " + raw);
      problems++;
    }
  }

  // 模板里出现的 qtFont* 必须已 import（跳过注释与字符串里的说明文字）
  const a = src.indexOf("<script"), b = src.indexOf("<style");
  const cuts = [a, b].filter((x) => x >= 0);
  let tpl = cuts.length ? src.slice(0, Math.min(...cuts)) : src;
  tpl = tpl.replace(/<!--[\s\S]*?-->/g, "");
  const used = new Set();
  for (const h of HELPERS) if (new RegExp("\\b" + h + "\\(").test(tpl)) used.add(h);
  for (const h of used) {
    if (!imported.some((i) => i.name === h)) {
      console.log("NOT-IMPORTED " + relative(".", f) + " :: " + h);
      problems++;
    }
  }
}
console.log("problems: " + problems);
if (problems > 0) process.exitCode = 1;
