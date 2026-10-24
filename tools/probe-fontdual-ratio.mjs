// 统计仓内既有 qtFontDual(baseRpx, widePx) 调用的 (base,wide) 分布，
// 得出「rpx 基准 → 宽屏 px」的经验换算比例，供把裸 qtFont(N) 批量转成 qtFontDual 时参考。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".uvue") || e.name.endsWith(".ts")) out.push(p);
  }
}

const files = [];
walk(path.join(root, "pages"), files);
walk(path.join(root, "uni_modules", "qt-ui"), files);

const byBase = new Map();
const re = /qtFontDual\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  let m;
  while ((m = re.exec(src)) != null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!byBase.has(a)) byBase.set(a, new Map());
    const c = byBase.get(a);
    c.set(b, (c.get(b) || 0) + 1);
  }
}

const bases = [...byBase.keys()].sort((x, y) => x - y);
const rows = [];
for (const a of bases) {
  const counts = byBase.get(a);
  const arr = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const total = arr.reduce((s, e) => s + e[1], 0);
  const weighted = arr.reduce((s, e) => s + e[0] * e[1], 0) / total;
  rows.push({ base: a, total, best: arr[0][0], weighted: Math.round(weighted * 100) / 100, dist: arr.map((e) => e[0] + "x" + e[1]).join(" ") });
}
rows.sort((x, y) => x.base - y.base);
console.log("base rpx | calls | most used px | weighted px | distribution");
for (const r of rows) {
  console.log(
    String(r.base).padStart(8) + " | " +
      String(r.total).padStart(5) + " | " +
      String(r.best).padStart(12) + " | " +
      String(r.weighted).padStart(11) + " | " + r.dist
  );
}
const overall = rows.reduce((s, r) => s + r.weighted * r.total, 0) / rows.reduce((s, r) => s + r.total, 0);
console.log("");
console.log("overall weighted ratio widePx/baseRpx = " + (Math.round(overall * 1000) / 1000));
