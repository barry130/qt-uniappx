// 全局字号缩放 codemod：把 <text> 上「写死在 class 里的 font-size」改成内联
// :style 绑定 qtFont / qtFontPx / qtFontDual*，从而跟随 stores/font-scale.ts 的倍率。
//
// 为什么只做「追加内联」而不动 <style>：
//   内联 :style 的优先级高于 class 规则，所以追加内联字号即生效，原 class 规则
//   留着无害（倍率 1.0 时两者字符串完全等价）。纯追加 = 可回滚、低风险。
//
// 用法：
//   node tools/font-scale-codemod.mjs            # dry-run，只打印计划
//   node tools/font-scale-codemod.mjs --apply    # 真正写盘
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APPLY = process.argv.includes("--apply");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);
const ROOT = process.cwd();

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "unpackage" || name.startsWith(".git")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith(".uvue")) files.push(p);
  }
})(ROOT);

const STATE_SUFFIX = /-(active|dark|light|on|off|danger|copy|muted|strong|selected|open|wide)$/;

// 这些 :style 表达式**自己就在拼 font-size**（歌词/桌面歌词预览的字号是运行时算的）。
// 再追加一个内联字号会变成同一条样式里两个 font-size —— 谁生效取决于解析顺序，
// 属于隐患；它们的字号必须在 JS 里乘倍率，所以这里整体跳过、留给人工。
const FONT_EMITTING_EXPR = /(lrcStyle|lrcTrStyle|lrcRomaStyle|karaokeWordStyle|karaokeLitStyle|previewMainStyle|previewTrStyle|previewLayerStyle|previewTrLayerStyle)\s*\(?/;

/** 扫描模板区里的 <text ...> 开标签（正确处理引号内的 '>'） */
function scanTextTags(tpl) {
  const out = [];
  const re = /<text\b/g;
  let m;
  while ((m = re.exec(tpl)) !== null) {
    let i = m.index + 5;
    let quote = "";
    while (i < tpl.length) {
      const ch = tpl[i];
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      i++;
    }
    out.push({ start: m.index, end: i + 1, raw: tpl.slice(m.index, i + 1) });
  }
  return out;
}

/** 解析 <style> 块：class -> {rpx, px} */
function parseStyleFontSizes(styleSrc) {
  const map = new Map();
  const ruleRe = /\.([A-Za-z][\w-]*)\s*\{([^}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(styleSrc)) !== null) {
    const fm = /font-size:\s*([\d.]+)(rpx|px)/.exec(m[2]);
    if (!fm) continue;
    const e = map.get(m[1]) || {};
    if (fm[2] === "rpx") e.rpx = Number(fm[1]); else e.px = Number(fm[1]);
    map.set(m[1], e);
  }
  return map;
}

const stats = {
  files: 0, touched: 0, tags: 0, applied: 0,
  skipNoFont: 0, skipInline: 0, skipVariant: 0, skipNoBase: 0, skipDone: 0,
  byHelper: {},
};
const skipped = [];
const samples = [];

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const rel = relative(ROOT, f);
  if (ONLY.length > 0 && !rel.replace(/\\/g, "/").includes(ONLY)) continue;
  const styleIdx = src.indexOf("<style");
  if (styleIdx < 0) continue;
  const styleSrc = src.slice(styleIdx);
  const fontMap = parseStyleFontSizes(styleSrc);
  if (fontMap.size === 0) continue;
  stats.files++;
  const tpl = src.slice(0, styleIdx);

  const edits = [];
  const used = new Set();

  for (const tag of scanTextTags(tpl)) {
    stats.tags++;
    const t = tag.raw;

    // 1) 已经自己拼了内联 font-size 的（player 歌词等）→ 留给人工，避免双写
    const styleProbe = /:style="([^"]*)"/.exec(t);
    if (styleProbe && (styleProbe[1].includes("font-size") || FONT_EMITTING_EXPR.test(styleProbe[1]))) {
      stats.skipInline++;
      skipped.push(rel + " :: INLINE-FONT :: " + t.slice(0, 110));
      continue;
    }
    // 幂等：已经注入过 qtFont* 的节点不能再追加一次（否则重跑 codemod 会叠两层）
    if (styleProbe && /qtFont/.test(styleProbe[1])) { stats.skipDone++; continue; }

    const staticM = /(?<!:)class="([^"]*)"/.exec(t);
    const dynM = /:class="([^"]*)"/.exec(t);
    const classes = staticM ? staticM[1].split(/\s+/).filter(Boolean) : [];

    // :class 表达式里的字符串字面量类名（含条件）
    const dynClasses = [];
    if (dynM) {
      for (const q of dynM[1].matchAll(/'([^']+)'|"([^"]+)"/g)) {
        for (const c of (q[1] || q[2]).split(/\s+/).filter(Boolean)) dynClasses.push(c);
      }
    }

    // 2) 状态变体类自身带 font-size（.x-active 比 .x 更大）→ 内联会抹平状态差异，人工处理
    const variantHit = dynClasses.some(
      (c) => !c.endsWith("-wide") && STATE_SUFFIX.test(c) && fontMap.has(c)
    );
    if (variantHit) {
      stats.skipVariant++;
      skipped.push(rel + " :: VARIANT :: " + t.slice(0, 110));
      continue;
    }

    // 基准字号：优先静态 class 里的非状态、非 -wide 类；否则取 :class 字面量
    let base = null;
    for (const c of classes) {
      if (STATE_SUFFIX.test(c)) continue;
      const e = fontMap.get(c);
      if (e) base = e;
    }
    if (base == null) {
      for (const c of dynClasses) {
        if (STATE_SUFFIX.test(c)) continue;
        const e = fontMap.get(c);
        if (e) base = e;
      }
    }

    // 宽屏覆盖：:class 里的 -wide 分支优先，其次静态 class 里写死的 -wide
    let wide = null;
    for (const c of dynClasses) {
      if (!c.endsWith("-wide")) continue;
      const e = fontMap.get(c);
      if (e) wide = e;
    }
    if (wide == null) {
      for (const c of classes) {
        if (!c.endsWith("-wide")) continue;
        const e = fontMap.get(c);
        if (e) wide = e;
      }
    }

    if (base == null && wide == null) { stats.skipNoFont++; continue; }
    if (base == null) {
      // 只有 -wide 有字号、基准字号在 JS 里算 → 人工
      stats.skipNoBase++;
      skipped.push(rel + " :: NO-BASE :: " + t.slice(0, 110));
      continue;
    }

    const bu = base.rpx != null ? "rpx" : "px";
    const wu = wide == null ? "-" : (wide.px != null ? "px" : "rpx");
    let helper;
    if (wide == null) helper = bu === "rpx" ? "qtFont(" + base.rpx + ")" : "qtFontPx(" + base.px + ")";
    else if (bu === "rpx" && wu === "px") helper = "qtFontDual(" + base.rpx + ", " + wide.px + ")";
    else if (bu === "px" && wu === "px") helper = "qtFontDualPx(" + base.px + ", " + wide.px + ")";
    else if (bu === "rpx" && wu === "rpx") helper = "qtFontDualRpx(" + base.rpx + ", " + wide.rpx + ")";
    else { skipped.push(rel + " :: COMBO " + bu + "/" + wu + " :: " + t.slice(0, 110)); continue; }

    used.add(helper.slice(0, helper.indexOf("(")));
    stats.byHelper[helper.slice(0, helper.indexOf("("))] = (stats.byHelper[helper.slice(0, helper.indexOf("("))] || 0) + 1;

    const styleM = /:style="([^"]*)"/.exec(t);
    let newTag;
    if (styleM) {
      const expr = styleM[1];
      const replaced = ':style="(' + expr + ') + ' + helper + '"';
      newTag = t.slice(0, styleM.index) + replaced + t.slice(styleM.index + styleM[0].length);
    } else {
      newTag = t.slice(0, t.length - 1) + ' :style="' + helper + '"' + t.slice(t.length - 1);
    }
    edits.push({ start: tag.start, end: tag.end, text: newTag });
    if (samples.length < 12) samples.push(rel + " :: " + helper + " :: " + t.slice(0, 90));
  }

  if (edits.length === 0) continue;
  stats.applied += edits.length;
  stats.touched++;

  // 从后往前替换，避免位移
  let out = src;
  for (let i = edits.length - 1; i >= 0; i--) {
    out = out.slice(0, edits[i].start) + edits[i].text + out.slice(edits[i].end);
  }

  // 补 import：插在 <script> 块最后一条 import 之后
  const scriptIdx = out.indexOf("<script");
  const need = [...used].filter((h) => h !== "qtFontRpx");
  if (scriptIdx >= 0 && need.length > 0) {
    const importRe = /import \{[^}]*\} from "@\/uni_modules\/qt-ui\/stores\/font-scale";/;
    if (importRe.test(out)) {
      out = out.replace(importRe, (line) => {
        const names = new Set(
          line.slice(line.indexOf("{") + 1, line.indexOf("}")).split(",").map((s) => s.trim()).filter(Boolean)
        );
        for (const n of need) names.add(n);
        return 'import { ' + [...names].join(", ") + ' } from "@/uni_modules/qt-ui/stores/font-scale";';
      });
    } else {
      const scriptEnd = out.indexOf("</script>", scriptIdx);
      const body = out.slice(scriptIdx, scriptEnd);
      // 注意：import 可能是多行的（`import {\n A,\n B,\n} from "..."`），
      // 按行找 `\nimport ` 会把新 import 插进上一条多行 import 的中间 —— 语法直接坏掉。
      // 用非贪婪跨行匹配「一条完整 import 语句」，插在最后一条的末尾之后。
      const importRe = /^import\b[\s\S]*?from\s*["'][^"']+["']\s*;?/gm;
      let last = null;
      let im;
      while ((im = importRe.exec(body)) !== null) last = im;
      const at = last != null
        ? scriptIdx + last.index + last[0].length
        : scriptIdx + body.indexOf("\n") + 1;
      const line = '\nimport { ' + need.join(", ") + ' } from "@/uni_modules/qt-ui/stores/font-scale";';
      out = out.slice(0, at) + line + out.slice(at);
    }
  }

  if (APPLY) writeFileSync(f, out, "utf8");
}

console.log("APPLY=" + APPLY);
console.log(JSON.stringify(stats, null, 2));
console.log("\n--- helper 分布 ---");
console.log(JSON.stringify(stats.byHelper, null, 2));
console.log("\n--- 改写样例 ---");
samples.forEach((s) => console.log("  " + s));
console.log("\n--- 需人工处理 (" + skipped.length + ") ---");
skipped.forEach((s) => console.log("  " + s));
