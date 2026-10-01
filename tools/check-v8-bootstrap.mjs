/**
 * V8 引擎 bootstrap / prelude 语法守卫。
 *
 * 为什么需要：webview.uts 里的 QT_V8_BOOTSTRAP 和 prelude.uts 里的 QT_JS_PRELUDE
 * 都是**运行时注入 WebView 的 JS 字符串**。UTS 编译器不会解析字符串里的 JS，
 * 所以字符串里写错一个括号，HBuilderX 编译照样通过，装到真机上才炸——
 * 而且 evaluateJavascript 不回传异常，现场只剩「引擎就绪但入口数为 0」这类二手现象。
 * 本脚本把它们抽出来交给 V8 解析一遍，把这类错误提前到命令行。
 *
 * 用法：node tools/check-v8-bootstrap.mjs
 * 退出码 0 = 全部通过；1 = 有语法错或占位符没被替换。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** 从源码里抽出「const NAME = `...`.replace(a, b)」形式或「const NAME = `...`」形式的模板串 */
function extractTemplate(file, constName) {
  const src = fs.readFileSync(file, "utf8");
  const marker = `const ${constName} = \``;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`${path.relative(ROOT, file)} 里找不到 ${constName}`);
  const bodyStart = start + marker.length;
  const end = src.indexOf("`", bodyStart);
  if (end < 0) throw new Error(`${constName} 的模板串没有闭合反引号`);
  const body = src.slice(bodyStart, end);
  // 模板串后面若跟着 .replace('X', CONST)，按常量名把它解析出来并替换
  const tail = src.slice(end + 1, end + 120);
  const m = tail.match(/^\.replace\('([^']+)',\s*([A-Za-z_][A-Za-z0-9_]*)\)/);
  if (!m) return { body, replaced: null, placeholder: null };
  const [, placeholder, constRef] = m;
  const cm = src.match(new RegExp(`const ${constRef} = ([^\\n]+)`));
  if (!cm) throw new Error(`找不到常量 ${constRef}`);
  // 常量形如 'https://qt.local' + V8_BUNDLE_PATH —— 逐段求值拼接
  const value = cm[1]
    .split("+")
    .map((part) => {
      const t = part.trim();
      const lit = t.match(/^'([^']*)'$/);
      if (lit) return lit[1];
      const ref = t.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
      if (ref) {
        const rm = src.match(new RegExp(`const ${ref[1]} = '([^']*)'`));
        if (!rm) throw new Error(`找不到常量 ${ref[1]}`);
        return rm[1];
      }
      throw new Error(`无法求值 ${constRef} 的片段：${t}`);
    })
    .join("");
  return { body: body.split(placeholder).join(value), replaced: value, placeholder };
}

const TARGETS = [
  {
    file: path.join(ROOT, "uni_modules/qt-js-engine/utssdk/app-android/webview.uts"),
    name: "QT_V8_BOOTSTRAP",
    mustContain: ["__qtEnvProbe", "__qtImportBundle", "__qtEnvLoadStatus", "__qtEntries"],
  },
  {
    file: path.join(ROOT, "uni_modules/qt-js-engine/utssdk/app-android/prelude.uts"),
    name: "QT_JS_PRELUDE",
    mustContain: ["__qtPump", "__qtCall", "__qtResolveHttp", "__qtFireTimer"],
  },
];

let bad = 0;
for (const t of TARGETS) {
  const rel = path.relative(ROOT, t.file);
  let got;
  try {
    got = extractTemplate(t.file, t.name);
  } catch (e) {
    console.log(`❌ ${rel}  ${t.name}：抽取失败 —— ${e.message}`);
    bad++;
    continue;
  }
  const { body, replaced, placeholder } = got;

  const missing = t.mustContain.filter((k) => !body.includes(k));
  if (missing.length > 0) {
    console.log(`❌ ${rel}  ${t.name}：缺少约定标识符 ${missing.join(", ")}`);
    bad++;
    continue;
  }

  // 占位符必须已被替换干净（残留会让 import 拿到一个不存在的模块说明符）
  if (placeholder != null) {
    if (body.includes(placeholder)) {
      console.log(`❌ ${rel}  ${t.name}：占位符 ${placeholder} 未被替换`);
      bad++;
      continue;
    }
    if (!/^https?:\/\//.test(replaced)) {
      console.log(`❌ ${rel}  ${t.name}：替换后的 import 说明符不是绝对 URL：${replaced}`);
      bad++;
      continue;
    }
  }

  try {
    new vm.Script(body, { filename: t.name + ".js" });
  } catch (e) {
    console.log(`❌ ${rel}  ${t.name}：JS 语法错误 —— ${e.message}`);
    bad++;
    continue;
  }

  const extra = placeholder != null ? `，占位符 ${placeholder} → ${replaced}` : "";
  console.log(`✅ ${rel}  ${t.name}  ${body.length} 字符，解析通过${extra}`);
}

if (bad > 0) {
  console.log(`\n[check-v8-bootstrap] 失败 ${bad} 项`);
  process.exit(1);
}
console.log("\n[check-v8-bootstrap] 通过：bootstrap / prelude 均可解析");
