// 找出「模板里被 codemod 加了 qtFont*，但该节点的 :style 表达式还引用了会自己输出 font-size 的
// JS 函数/computed」的节点 —— 这类节点会出现两条 font-size，后者（qtFont*）覆盖前者，
// 从而压平 JS 侧的宽屏 px 覆盖或尺寸变体。必须人工处理。
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

function textTags(tpl) {
  const out = [];
  const re = /<text\b/g;
  let m;
  while ((m = re.exec(tpl)) !== null) {
    let i = m.index + m[0].length, quote = "";
    while (i < tpl.length) {
      const ch = tpl[i];
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      i++;
    }
    out.push({ start: m.index, tag: tpl.slice(m.index, i + 1) });
  }
  return out;
}

let conflicts = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const a = src.indexOf("<script"), b = src.indexOf("<style");
  const cuts = [a, b].filter((x) => x >= 0);
  const tpl = (cuts.length ? src.slice(0, Math.min(...cuts)) : src).replace(/<!--[\s\S]*?-->/g, "");
  const script = a < 0 ? "" : src.slice(a, b < 0 ? src.length : b);

  // 收集所有「返回串里含 font-size」的函数与 computed 名
  const emitters = new Set();
  for (const m of script.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
    if (/font-size/.test(m[2])) emitters.add(m[1]);
  }
  for (const m of script.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*computed(?:<[^>]*>)?\s*\(([\s\S]*?)\n\}\)/g)) {
    if (/font-size/.test(m[2])) emitters.add(m[1]);
  }
  if (emitters.size === 0) continue;

  for (const { start, tag } of textTags(tpl)) {
    if (!/qtFont/.test(tag)) continue;
    const sm = /:style="([^"]*)"/.exec(tag);
    if (!sm) continue;
    const expr = sm[1];
    for (const e of emitters) {
      if (new RegExp("\\b" + e + "\\b").test(expr)) {
        const line = tpl.slice(0, start).split("\n").length;
        console.log(relative(".", f) + ":" + line + "  conflicts with " + e + "()");
        console.log("    " + tag.replace(/\s+/g, " ").slice(0, 200));
        conflicts++;
      }
    }
  }
}
console.log("conflicts: " + conflicts);
if (conflicts > 0) process.exitCode = 1;
