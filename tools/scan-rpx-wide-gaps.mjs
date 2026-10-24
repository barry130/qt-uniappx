// 扫描每个页面「用 rpx 却缺少 -wide px 覆盖」的规模。
//
// 为什么需要这个检查：Android App 端的 rpx 是「屏幕宽 / 750」，宽屏 1280dp 时
// 1rpx ≈ 1.71dp（约 3.4 倍于手机的 0.5dp）。因此任何只有 rpx、没有 -wide px
// 覆盖的尺寸/字号，在宽屏上都会被放大 3 倍多。theme 页就是因此把 25rpx 的标题
// 渲染成 ~53dp，三选一的窄格里一个字占一行（真机截图 th2.png 可见）。
//
// 用法：node tools/scan-rpx-wide-gaps.mjs [--list]
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const showList = process.argv.includes("--list");

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

const rows = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const i = src.indexOf("<style");
  if (i < 0) continue;
  const style = src.slice(i);

  // 只看类规则里的 rpx 声明
  const rpxDecls = [];
  const ruleRe = /^\.([A-Za-z0-9_-]+)[^{]*\{([^}]*)\}/gm;
  let m;
  while ((m = ruleRe.exec(style)) != null) {
    const cls = m[1];
    const body = m[2];
    const props = [...body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)]
      .filter(d => /\d+rpx/.test(d[2]))
      .map(d => d[1]);
    if (props.length > 0) rpxDecls.push({ cls, props });
  }

  const wideClasses = new Set();
  const wideRe = /^\.([A-Za-z0-9_-]+)-wide[^{]*\{/gm;
  while ((m = wideRe.exec(style)) != null) wideClasses.add(m[1]);

  const uncovered = rpxDecls.filter(r => {
    const base = r.cls.endsWith("-wide") ? r.cls.slice(0, -5) : r.cls;
    return !wideClasses.has(base) && !r.cls.endsWith("-wide");
  });

  if (uncovered.length > 0) {
    rows.push({
      file: path.relative(root, f),
      rpxRules: rpxDecls.length,
      wideRules: wideClasses.size,
      uncovered: uncovered.length,
      detail: uncovered,
    });
  }
}

rows.sort((a, b) => b.uncovered - a.uncovered);
console.log("files with rpx-only sizing: " + rows.length);
console.log("");
for (const r of rows.slice(0, 30)) {
  console.log(
    r.uncovered.toString().padStart(3) +
      "  " + r.file +
      "   (rpx rules " + r.rpxRules + ", -wide rules " + r.wideRules + ")"
  );
  if (showList) {
    for (const d of r.detail) console.log("        ." + d.cls + "  [" + d.props.join(",") + "]");
  }
}
