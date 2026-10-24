/**
 * 找出 `<style>` 里「只在宽屏生效的类名（.xxx-wide）中写 font-size」的全部规则。
 *
 * 为什么这是问题：全仓字号统一由 stores/font-scale.ts 的 qtFontDual(baseRpx, widePx) /
 * qtFontPx 内联给出，用户能在设置里调 5 档字号；而 CSS 里的 `.xxx-wide { font-size: Npx }`
 * 完全不经过 font-scale —— 同一个节点既有内联字号又有 CSS 宽屏字号时，内联优先级更高，
 * 那条 CSS 就是死代码；没有内联字号的节点则会「用户调大字号它不变」。
 *
 * 本脚本只做**只读统计**，不修改任何文件。
 * 用法：node tools/find-wide-css-fontsize.mjs [--list]
 */
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SHOW_LIST = process.argv.includes("--list");

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "unpackage") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".uvue")) out.push(full);
  }
  return out;
}

/** 从 .uvue 里抠出所有 <style> 块并拼成一段字符串，返回 [text, baseLineOffsetList] 近似行号 */
function styleBlocks(source) {
  const out = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const before = source.slice(0, m.index + m[0].indexOf(">") + 1);
    const startLine = before.split("\n").length;
    out.push({ body: m[1], startLine });
  }
  return out;
}

/** 把一段 CSS 拆成规则：返回 [{ selector, body, line }] */
function parseRules(body, startLine) {
  const rules = [];
  const lines = body.split("\n");
  let buf = "";
  let bufStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (buf === "") bufStart = i;
    buf += line + "\n";
    // 一条规则以 } 结尾（本仓 CSS 全是单层、无嵌套 at-rule）
    let close = buf.indexOf("}");
    while (close >= 0) {
      const chunk = buf.slice(0, close + 1);
      const brace = chunk.indexOf("{");
      if (brace >= 0) {
        rules.push({
          selector: chunk.slice(0, brace).trim(),
          body: chunk.slice(brace + 1),
          line: startLine + bufStart,
        });
      }
      buf = buf.slice(close + 1);
      bufStart = bufStart + chunk.split("\n").length - 1;
      close = buf.indexOf("}");
    }
  }
  return rules;
}

const files = walk(ROOT, []).sort();
let totalRules = 0;
let wideRules = 0;
let wideFontRules = 0;
const hits = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const block of styleBlocks(src)) {
    for (const rule of parseRules(block.body, block.startLine)) {
      totalRules++;
      const sel = rule.selector.replace(/\s+/g, " ");
      if (!/(^|[\s,>])\.\S*-wide\b/.test(sel)) continue;
      wideRules++;
      const fs = rule.body.match(/font-size\s*:\s*([^;]+);/);
      if (fs === null) continue;
      wideFontRules++;
      hits.push(`${relative(ROOT, file).replace(/\\/g, "/")}:${rule.line}  ${sel}  → font-size: ${fs[1].trim()}`);
    }
  }
}

console.log(`rules total: ${totalRules}`);
console.log(`rules on .*-wide selectors: ${wideRules}`);
console.log(`rules on .*-wide with font-size: ${wideFontRules}`);
if (SHOW_LIST) {
  for (const h of hits) console.log("  " + h);
} else {
  const byFile = new Map();
  for (const h of hits) {
    const f = h.split(":")[0];
    byFile.set(f, (byFile.get(f) ?? 0) + 1);
  }
  for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}\t${f}`);
  }
}
