// 判断某个 rpx 类是否只出现在「竖屏分支」里。
// 竖屏分支（v-if="!layout.isWide"）在宽屏根本不渲染，所以这些类的 rpx 放大风险是零，
// scan-rpx-wide-gaps.mjs 把它们算成「缺口」是误报。
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

let totalRpx = 0;
let risky = 0;
const rows = [];

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const i = src.indexOf("<script");
  const tpl = i < 0 ? "" : src.slice(0, i);
  const si = src.indexOf("<style");
  if (si < 0) continue;
  const style = src.slice(si);

  // 竖屏专属块：从 v-if="!layout.isWide" 起，到对应的 v-else 之前
  const portraitChunks = [];
  const re = /v-if="!layout\.isWide"/g;
  let m;
  while ((m = re.exec(tpl)) != null) {
    // 向前找回该节点的开始标签，向后找到 v-else 或脚本末尾
    const start = tpl.lastIndexOf("<", m.index);
    const els = tpl.indexOf("v-else", m.index);
    portraitChunks.push(tpl.slice(start < 0 ? 0 : start, els < 0 ? tpl.length : els));
  }
  const portraitText = portraitChunks.join("\n");

  const ruleRe = /^\.([A-Za-z0-9_-]+)[^{]*\{([^}]*)\}/gm;
  const rpxClasses = [];
  while ((m = ruleRe.exec(style)) != null) {
    if (!/\d+rpx/.test(m[2])) continue;
    const cls = m[1];
    if (cls.endsWith("-wide")) continue;
    rpxClasses.push(cls);
  }
  const wideClasses = new Set();
  const wideRe = /^\.([A-Za-z0-9_-]+)-wide[^{]*\{/gm;
  while ((m = wideRe.exec(style)) != null) wideClasses.add(m[1]);

  const uncovered = rpxClasses.filter((c) => !wideClasses.has(c));
  totalRpx += uncovered.length;

  const unrendered = uncovered.filter((c) => {
    const inPortrait = new RegExp("\\b" + c + "\\b").test(portraitText);
    const inTpl = new RegExp("\\b" + c + "\\b").test(tpl);
    // 只在竖屏块出现、或者模板里根本不出现 → 宽屏无风险
    return inPortrait || !inTpl;
  });
  risky += uncovered.length - unrendered.length;

  if (uncovered.length - unrendered.length > 0) {
    rows.push({
      file: path.relative(root, f),
      risky: uncovered.length - unrendered.length,
      safe: unrendered.length,
      detail: uncovered.filter((c) => !unrendered.includes(c)),
    });
  }
}

rows.sort((a, b) => b.risky - a.risky);
console.log("rpx classes without -wide coverage: " + totalRpx);
console.log("  only in portrait branch / unused in template (safe): " + (totalRpx - risky));
console.log("  actually rendered on wide screens (risky): " + risky);
console.log("");
for (const r of rows) {
  console.log(
    r.risky.toString().padStart(3) +
      " risky, " + r.safe.toString().padStart(3) + " safe   " + r.file
  );
  if (process.argv.includes("--list")) {
    console.log("        " + r.detail.map((c) => "." + c).join(" "));
  }
}
