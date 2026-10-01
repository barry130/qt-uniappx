import fs from "node:fs";
const p = "F:/qtMusic/qt-uniappx/uni_modules/qt-js-engine/utssdk/app-android/prelude.uts";
const s = fs.readFileSync(p, "utf8");
console.log("file length:", s.length, "hasBOM:", s.charCodeAt(0) === 0xfeff);
const i = s.indexOf("export const QT_JS_PRELUDE = `");
const start = s.indexOf("`", i + "export const QT_JS_PRELUDE = ".length) + 1;
console.log("marker at", i, "body start", start);
let idx = -1, n = 0;
while ((idx = s.indexOf("`;", idx + 1)) >= 0) {
  n++;
  console.log(`--- 第${n}处 \`; 位置 ${idx} 上下文:`, JSON.stringify(s.slice(Math.max(0, idx - 60), idx + 8)));
  if (n > 10) break;
}
const end = s.indexOf("`;", start);
console.log("first end after start:", end, "-> extracted length", end - start);
const extracted = s.substring(start, end);
console.log("extracted tail:", JSON.stringify(extracted.slice(-160)));
