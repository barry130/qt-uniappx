// 把「宽屏会渲染」的模板里裸 qtFont(N) 换成 qtFontDual(N, M)。
//
// 背景：qtFont(N) 输出 `font-size:Nrpx`，而 uni-app x 在 app-android 宽屏下
// 1rpx = windowWidth_dp / 750（本机 1280dp → 1rpx≈1.7067dp），于是 26rpx 会渲染成
// 约 44dp 的巨型字（source-pack 页真机实测「数据包」标题）。宽屏分支必须用 px 基准。
//
// M 的取法：优先沿用仓内已有 qtFontDual 调用的经验众数（tools/probe-fontdual-ratio.mjs），
// 没有先例的按 round(N * 0.55) 推、并夹到宽屏最小字号 11px（QT_MIN_WIDE_FONT_PX）。
import fs from "node:fs";
import path from "node:path";
import { portraitRanges, inPortrait as inPortraitAt, splitTemplate } from "./wide-scope.mjs";

const root = path.resolve(import.meta.dirname, "..");

const KNOWN = {
  16: 11, 18: 11, 19: 11, 20: 11, 21: 12, 22: 12, 23: 13, 24: 14,
  25: 14, 26: 14, 27: 15, 28: 17, 29: 16, 30: 16, 31: 20, 32: 20,
  34: 20, 35: 20, 36: 24, 38: 22, 40: 22, 46: 28, 56: 32, 58: 32, 60: 34,
};

function widePx(base) {
  if (KNOWN[base] != null) return KNOWN[base];
  const v = Math.round(base * 0.55);
  return v < 11 ? 11 : v;
}

const dryRun = process.argv.includes("--dry");
const only = process.argv.slice(2).find((a) => !a.startsWith("--"));

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

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*"@\/uni_modules\/qt-ui\/stores\/font-scale"/;
let changed = 0;

for (const f of files) {
  const rel = path.relative(root, f);
  if (only != null && !rel.includes(only)) continue;
  const src = fs.readFileSync(f, "utf8");
  const scriptIdx = src.indexOf("<script");
  const tpl = scriptIdx < 0 ? "" : src.slice(0, scriptIdx);

  const ranges = portraitRanges(tpl);
  const inPortrait = (pos) => inPortraitAt(ranges, pos);

  const hits = [];
  const re = /qtFont\((\d+)\)/g;
  let m;
  while ((m = re.exec(tpl)) != null) {
    if (inPortrait(m.index)) continue;
    hits.push({ index: m.index, len: m[0].length, base: Number(m[1]) });
  }
  if (hits.length == 0) continue;

  let out = src;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    out = out.slice(0, h.index) + "qtFontDual(" + h.base + ", " + widePx(h.base) + ")" + out.slice(h.index + h.len);
  }

  const im = out.match(IMPORT_RE);
  if (im != null) {
    const names = im[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    const stillUsed = /[^a-zA-Z]qtFont\(/.test(out);
    let next = names.filter((n) => n != "qtFont" || stillUsed);
    if (next.indexOf("qtFontDual") < 0) next.push("qtFontDual");
    out = out.replace(im[0], 'import { ' + next.join(", ") + ' } from "@/uni_modules/qt-ui/stores/font-scale"');
  }

  changed++;
  console.log(rel + "  ->  " + hits.length + " call(s)");
  if (!dryRun) {
    if (out.indexOf("\uFFFD") >= 0) throw new Error("replacement char in " + rel);
    fs.writeFileSync(f, out, "utf8");
  }
}

console.log("");
console.log((dryRun ? "[dry] would change " : "changed ") + changed + " file(s)");
