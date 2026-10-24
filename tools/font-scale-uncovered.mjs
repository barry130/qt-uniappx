// 列出未覆盖且既无 class、也无内联 font-size 的 <text> 节点（真正会回落到默认字号的节点）
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

for (const f of files) {
  const src = readFileSync(f, "utf8");
  // 模板 = <template> 开始到 <script 或 <style 之前；不切会扫到 <script> 注释里的 "<text>"
  const tEnd = (() => {
    const a = src.indexOf("<script");
    const b = src.indexOf("<style");
    const c = [a, b].filter((x) => x >= 0);
    return c.length ? Math.min(...c) : src.length;
  })();
  const tpl = src.slice(0, tEnd).replace(/<!--[\s\S]*?-->/g, "");
  const styleSrc = src.indexOf("<style") < 0 ? "" : src.slice(src.indexOf("<style"));
  const sizes = new Map();
  for (const m of styleSrc.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
    const fs = /font-size\s*:\s*([\d.]+)\s*(rpx|px)/.exec(m[2]);
    if (fs) sizes.set(m[1], fs[1] + fs[2]);
  }
  for (const { start, tag } of textTags(tpl)) {
    if (/qtFont/.test(tag)) continue;
    const cm = /(?<!:)class="([^"]*)"/.exec(tag);
    if (cm) {
      const cls = cm[1].trim().split(/\s+/);
      if (cls.some((c) => sizes.has(c))) continue; // class 有字号 → 已由 class 决定
      if (/:(?:style)="[^"]*font-size/.test(tag)) continue;
      // class 无字号但也未覆盖：也列出来
    }
    if (/:(?:style)="[^"]*font-size/.test(tag)) continue;
    const line = tpl.slice(0, start).split("\n").length;
    console.log(relative(".", f) + ":" + line + "  " + tag.replace(/\s+/g, " ").slice(0, 170));
  }
}
