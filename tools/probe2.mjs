import fs from "node:fs";
const p = "F:/qtMusic/qt-uniappx/uni_modules/qt-js-engine/utssdk/app-android/webview.uts";
const s = fs.readFileSync(p, "utf8");
const i = s.indexOf("const QT_V8_BOOTSTRAP = `");
const start = s.indexOf("`", i + "const QT_V8_BOOTSTRAP = ".length) + 1;
const end = s.indexOf("`\n", start);
const extracted = s.substring(start, end);
console.log("marker", i, "start", start, "end", end, "len", extracted.length);
console.log("tail:", JSON.stringify(extracted.slice(-200)));
console.log("--- 该起点之后所有 ` 的位置与上下文 ---");
let idx = start - 1, n = 0;
while ((idx = s.indexOf("`", idx + 1)) >= 0 && n < 8) {
  n++;
  console.log(`#${n} pos=${idx} next12=${JSON.stringify(s.slice(idx, idx + 12))} 前40=${JSON.stringify(s.slice(Math.max(0, idx - 40), idx))}`);
}
