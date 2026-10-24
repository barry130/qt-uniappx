// 打印「宽屏会渲染」的模板区间里所有裸 qtFont(N) 调用所在的模板行，
// 供逐个判断该换成 qtFontDual(N, M) 还是 qtFontPx(M)。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rel = process.argv[2];
if (rel == null) {
  console.log("usage: node tools/list-bare-qtfont-lines.mjs <relative .uvue path>");
  process.exit(1);
}
const file = path.join(root, rel);
const src = fs.readFileSync(file, "utf8");
const scriptIdx = src.indexOf("<script");
const tpl = scriptIdx < 0 ? "" : src.slice(0, scriptIdx);

const ranges = [];
const pre = /v-if="!layout\.isWide"/g;
let m;
while ((m = pre.exec(tpl)) != null) {
  const start = tpl.lastIndexOf("<", m.index);
  const els = tpl.indexOf("v-else", m.index);
  ranges.push([start < 0 ? 0 : start, els < 0 ? tpl.length : els]);
}
ranges.sort((a, b) => a[0] - b[0]);

const lines = tpl.split("\n");
let offset = 0;
const lineStarts = [];
for (const ln of lines) {
  lineStarts.push(offset);
  offset += ln.length + 1;
}

let shown = 0;
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i];
  if (!/qtFont\(\d+\)/.test(ln)) continue;
  const pos = lineStarts[i];
  const inPortrait = ranges.some(([s, e]) => pos >= s && pos < e);
  if (inPortrait) continue;
  shown++;
  let t = ln.replace(/\s+/g, " ").trim();
  if (t.length > 150) t = t.slice(0, 150) + "…";
  console.log(String(i + 1).padStart(4) + "  " + t);
}
console.log("");
console.log("wide-rendered bare qtFont lines: " + shown);
