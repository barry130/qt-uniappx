// 校验 codemod 写入的 helper 参数是否与它替换掉的 class 字号逐位一致。
// 规则：
//   qtFont(N)         ← base class 的 rpx 字号必须等于 N
//   qtFontPx(N)       ← base class 的 px 字号必须等于 N
//   qtFontDual(B, W)  ← base class rpx == B 且 -wide class px == W
//   qtFontDualPx(B,W) ← base class px == B 且 -wide class px == W
// 标准档（scale=1.0）必须与改动前渲染完全一致，这个脚本就是那条不变量。
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

let checked = 0, bad = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const a = src.indexOf("<script"), b = src.indexOf("<style");
  const cuts = [a, b].filter((x) => x >= 0);
  const tpl = (cuts.length ? src.slice(0, Math.min(...cuts)) : src).replace(/<!--[\s\S]*?-->/g, "");
  const styleSrc = b < 0 ? "" : src.slice(b);

  // class -> {rpx, px}
  const sizes = new Map();
  for (const m of styleSrc.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
    const fs = /font-size\s*:\s*([\d.]+)\s*(rpx|px)/.exec(m[2]);
    if (fs) {
      const cur = sizes.get(m[1]) || {};
      cur[fs[2]] = Number(fs[1]);
      sizes.set(m[1], cur);
    }
  }

  for (const { start, tag } of textTags(tpl)) {
    const line = tpl.slice(0, start).split("\n").length;
    const where = relative(".", f) + ":" + line;
    const cm = /(?<!:)class="([^"]*)"/.exec(tag);
    const cls = cm ? cm[1].trim().split(/\s+/).filter(Boolean) : [];
    // 静态 class 里带 -wide 的（player 的 STATIC-WIDE）也在 class 列表里
    const base = cls.filter((c) => sizes.has(c) && !c.endsWith("-wide"));
    const wide = cls.filter((c) => sizes.has(c) && c.endsWith("-wide"));
    const baseRpx = base.map((c) => sizes.get(c).rpx).filter((v) => v != null)[0];
    const basePx = base.map((c) => sizes.get(c).px).filter((v) => v != null)[0];
    const widePx = wide.map((c) => sizes.get(c).px).filter((v) => v != null)[0];

    const m = /\bqtFontDualPx\((\d+),\s*(\d+)\)|\bqtFontDual\((\d+),\s*(\d+)\)|\bqtFontPx\((\d+)\)|\bqtFontRpx\((\d+)\)|\bqtFont\((\d+)\)/.exec(tag);
    if (!m) continue;
    checked++;

    const fail = (why) => { console.log("MISMATCH " + where + " :: " + why + " :: " + tag.replace(/\s+/g, " ").slice(0, 150)); bad++; };
    if (m[1] != null) { // qtFontDualPx(basePx, widePx)
      if (basePx != null && Number(m[1]) !== basePx) fail("DualPx base " + m[1] + " != class px " + basePx);
      if (widePx != null && Number(m[2]) !== widePx) fail("DualPx wide " + m[2] + " != class -wide px " + widePx);
    } else if (m[3] != null) { // qtFontDual(baseRpx, widePx)
      if (baseRpx != null && Number(m[3]) !== baseRpx) fail("Dual base " + m[3] + " != class rpx " + baseRpx);
      if (widePx != null && Number(m[4]) !== widePx) fail("Dual wide " + m[4] + " != class -wide px " + widePx);
    } else if (m[5] != null) {
      if (basePx != null && Number(m[5]) !== basePx) fail("Px " + m[5] + " != class px " + basePx);
    } else if (m[6] != null) {
      if (baseRpx != null && Number(m[6]) !== baseRpx) fail("Rpx " + m[6] + " != class rpx " + baseRpx);
    } else if (m[7] != null) {
      if (baseRpx != null && Number(m[7]) !== baseRpx) fail("Font " + m[7] + " != class rpx " + baseRpx);
    }
  }
}
console.log("verified inline helpers: " + checked + ", mismatches: " + bad);
if (bad > 0) process.exitCode = 1;
