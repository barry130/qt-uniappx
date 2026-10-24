// 列出「宽屏会渲染、却没有 -wide 覆盖」的 rpx 类规则里到底写了哪些属性，
// 并按「字号 rpx」（视觉风险最高，会放大 1.7 倍）与「几何 rpx」（padding/width/height，风险中等）分档。
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
const rows = [];

for (const f of files) {
  const rel = path.relative(root, f);
  if (only != null && !rel.includes(only)) continue;
  const src = fs.readFileSync(f, "utf8");
  const si = src.indexOf("<style");
  if (si < 0) continue;
  const style = src.slice(si);
  const scriptIdx = src.indexOf("<script");
  const tpl = scriptIdx < 0 ? "" : src.slice(0, scriptIdx);

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
    if (!/\d+rpx/.test(body)) continue;
    if (cls.endsWith("-wide")) continue;
    if (wideClasses.has(cls)) continue;
    if (!new RegExp("\\b" + cls + "\\b").test(tpl)) continue;
    if (new RegExp("\\b" + cls + "\\b").test(portraitText)) continue;

    const props = [];
    for (const line of body.split(";")) {
      if (!/\d+rpx/.test(line)) continue;
      props.push(line.trim());
    }
    if (props.length == 0) continue;

    const font = props.filter((p) => p.startsWith("font-size") || p.startsWith("line-height"));
    const geo = props.filter((p) => !font.includes(p));
    rows.push({ file: rel, cls, font, geo });
  }
}

const withFont = rows.filter((r) => r.font.length > 0);
console.log("== font-size / line-height in rpx (highest risk) : " + withFont.length + " rules ==");
for (const r of withFont) {
  console.log(r.file + "  ." + r.cls + "  " + r.font.join(" "));
}
console.log("");
console.log("== geometry only (medium risk) : " + (rows.length - withFont.length) + " rules ==");
if (process.argv.includes("--geo")) {
  for (const r of rows) {
    if (r.font.length > 0) continue;
    console.log(r.file + "  ." + r.cls + "  " + r.geo.join(" "));
  }
}
