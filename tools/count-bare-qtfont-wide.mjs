// 统计「宽屏真的会渲染」的模板里，还有多少处裸 qtFont(N) 内联字号。
// 裸 qtFont 输出 rpx，在宽屏会被放大 ~1.7 倍（本机 rpx = windowWidth_dp / 750），
// 所以宽屏分支里应当用 qtFontPx 或 qtFontDual。
//
// 判定「宽屏会渲染」的方式走 tools/wide-scope.mjs：按元素树找出
// v-if="!layout.isWide" 的子树整段剔除，剩下的都算宽屏可见。
import fs from "node:fs";
import path from "node:path";
import { portraitRanges, inPortrait, splitTemplate } from "./wide-scope.mjs";

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
const rows = [];

for (const f of files) {
  const rel = path.relative(root, f);
  if (only != null && !rel.includes(only)) continue;
  const src = fs.readFileSync(f, "utf8");
  const tpl = splitTemplate(src);
  const ranges = portraitRanges(tpl);
  const bare = countOutside(tpl, ranges, /qtFont\(\d+\)/g);
  const dual = countOutside(tpl, ranges, /qtFontDual\(/g);
  const px = countOutside(tpl, ranges, /qtFontPx\(/g);
  const rpx = countOutside(tpl, ranges, /qtFontRpx\(/g);
  if (bare + dual + px + rpx == 0) continue;
  rows.push({ file: rel, bare, dual, px, rpx });
}

function countOutside(tpl, ranges, re) {
  let n = 0;
  let m;
  while ((m = re.exec(tpl)) != null) {
    if (!inPortrait(ranges, m.index)) n++;
  }
  return n;
}

rows.sort((a, b) => b.bare - a.bare);
const tot = rows.reduce((s, r) => s + r.bare, 0);
const totDual = rows.reduce((s, r) => s + r.dual, 0);
const totPx = rows.reduce((s, r) => s + r.px, 0);
console.log("wide-rendered inline fonts: qtFont(N)=" + tot + "  qtFontDual=" + totDual + "  qtFontPx=" + totPx);
console.log("");
for (const r of rows) {
  console.log(
    String(r.bare).padStart(4) + "  qtFont   " +
      String(r.dual).padStart(3) + " dual  " +
      String(r.px).padStart(3) + " px   " + r.file
  );
}
