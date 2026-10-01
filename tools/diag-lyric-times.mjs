/**
 * 「只有某首歌歌词不定位」的数据侧体检（无需真机）。
 *
 * 复用 diag-v8-pump.mjs 的引擎等价物（独立 V8 context + prelude/bootstrap + 真 ESM bundle +
 * 泵协议），只做一件事：取指定关键词在四源的歌词原文，用 **逐字复制的 parseLrc** 解析，
 * 把每行时间、异常行、时间标签形态，以及「播放页那套 index 计算」在整首歌上的推进轨迹全打出来。
 *
 * 为什么需要它：播放页/桌面歌词的定位全靠 lines[i].time <= progress。只要某首歌的 LRC 里
 * 出现一个时间异常的早行（时间戳位数不对 → frac 缩放算错、或乱序、或第 2 行时间特别靠后），
 * index 就会被钉在很小的值上，表现就是「这首歌歌词不跟随」，而其他歌完全正常。
 *
 * 用法：node --experimental-vm-modules diag-lyric-times.mjs <bundle> <chain.json> [关键词] [源,源]
 *   例：node --experimental-vm-modules diag-lyric-times.mjs ../static/source-bundle/source-bundle.js ../static/source-bundle/chain.json 微光 qq,kw,kg,wyy
 */
import fs from "node:fs";
import vm from "node:vm";

const [bundlePath, chainPath, keywordArg, sourcesArg] = process.argv.slice(2);
if (!bundlePath || !chainPath) {
  console.error("用法：node --experimental-vm-modules diag-lyric-times.mjs <bundle> <chain.json> [关键词] [源,源]");
  process.exit(2);
}
const KEYWORD = keywordArg || "微光";
const SOURCES = sourcesArg ? sourcesArg.split(",") : ["qq", "kw", "kg", "wyy"];
const PLATFORM = 1101; // 安卓
const bundleSrc = fs.readFileSync(bundlePath, "utf8");
const chainJson = fs.readFileSync(chainPath, "utf8");

const UA =
  "Mozilla/5.0 (Linux; Android 12; zh-CN) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

// ==================== 解析：与 utils/lrc.uts 逐字一致 ====================

function numOrZero(text) {
  const parsed = parseInt(text);
  return parsed > 0 ? parsed : 0;
}

/** 与修复后的 utils/lrc.uts 一致：冒号前必须是纯数字，否则是元数据标签 */
function isAllDigits(text) {
  if (text.length === 0) return false;
  const digits = "0123456789";
  for (let i = 0; i < text.length; i++) {
    if (digits.indexOf(text.substring(i, i + 1)) < 0) return false;
  }
  return true;
}

/** 与 qt-uniappx/utils/lrc.uts 的 parseLrc 逐字一致（已含元数据标签过滤） */
function parseLrc(text, translationText = "") {
  const lines = [];
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    const start = line.indexOf("[");
    if (start < 0) continue;
    const end = line.indexOf("]", start);
    if (end < 0) continue;
    const tag = line.substring(start + 1, end);
    const colon = tag.indexOf(":");
    if (colon < 0) continue;
    const minText = tag.substring(0, colon);
    if (!isAllDigits(minText)) {
      skippedTags.push(tag);
      continue;
    }
    const min = numOrZero(minText);
    const rest = tag.substring(colon + 1);
    const dot = rest.indexOf(".");
    let secText = rest;
    let fracText = "";
    if (dot >= 0) {
      secText = rest.substring(0, dot);
      fracText = rest.substring(dot + 1);
    }
    const sec = numOrZero(secText);
    let frac = 0;
    if (fracText.length > 0) {
      if (fracText.length >= 3) frac = numOrZero(fracText.substring(0, 3)) / 1000;
      else if (fracText.length == 2) frac = numOrZero(fracText) / 100;
      else frac = numOrZero(fracText) / 10;
    }
    lines.push({ time: min * 60 + sec + frac, text: line.substring(end + 1) });
  }
  if (translationText.length > 0) {
    const trs = parseLrc(translationText, "");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < trs.length; j++) {
        const tr = trs[j];
        if (Math.abs(tr.time - line.time) < 0.05) {
          line.translation = tr.text;
          break;
        }
      }
    }
  }
  return lines;
}

/** 修复前的旧版 parseLrc（用于对比：证明它就是「只有这首歌」不跟随的原因） */
function parseLrcOld(text, translationText = "") {
  const lines = [];
  for (const line of text.split("\n")) {
    const start = line.indexOf("[");
    if (start < 0) continue;
    const end = line.indexOf("]", start);
    if (end < 0) continue;
    const tag = line.substring(start + 1, end);
    const colon = tag.indexOf(":");
    if (colon < 0) continue;
    const min = numOrZero(tag.substring(0, colon));
    const rest = tag.substring(colon + 1);
    const dot = rest.indexOf(".");
    let secText = rest;
    let fracText = "";
    if (dot >= 0) {
      secText = rest.substring(0, dot);
      fracText = rest.substring(dot + 1);
    }
    const sec = numOrZero(secText);
    let frac = 0;
    if (fracText.length > 0) {
      const f = numOrZero(fracText);
      if (fracText.length == 3) frac = f / 1000;
      else if (fracText.length == 2) frac = f / 100;
      else frac = f / 10;
    }
    lines.push({ time: min * 60 + sec + frac, text: line.substring(end + 1) });
  }
  return lines;
}

let skippedTags = [];

/** 与 pages/player/index.uvue 的 updateLyricScroll 逐字一致的 index 计算 */
function appIndex(lines, progress) {
  let index = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= progress) index = i;
    else break;
  }
  return index;
}

// ==================== 引擎等价物（复用 diag-v8-pump.mjs） ====================

const ctx = vm.createContext({ console });
ctx.__qtPlatform = PLATFORM;

function extractPrelude(utsPath) {
  const s = fs.readFileSync(utsPath, "utf8");
  const i = s.indexOf("export const QT_JS_PRELUDE = `");
  if (i < 0) throw new Error("找不到 QT_JS_PRELUDE");
  const start = s.indexOf("`", i + "export const QT_JS_PRELUDE = ".length) + 1;
  const end = s.indexOf("`;", start);
  return s.substring(start, end);
}
/**
 * 注意：不能再用「找 `\n」这种启发式 —— webview.uts 的 bootstrap 体内含 `${e}` 这类
 * 内层模板串，`\n 会命中它并把字符串截断（表现为 vm 报 Unexpected identifier '$'）。
 * 真正的收尾是 ` 后面紧跟 .replace('__QT_V8_BUNDLE_URL__', ...)，即 bootstrap 体里
 * 没有裸反引号，取「起始后的第一个反引号」就是收尾。
 */
function extractBootstrap(utsPath) {
  const s = fs.readFileSync(utsPath, "utf8");
  const i = s.indexOf("const QT_V8_BOOTSTRAP = `");
  if (i < 0) throw new Error("找不到 QT_V8_BOOTSTRAP");
  const start = s.indexOf("`", i + "const QT_V8_BOOTSTRAP = ".length) + 1;
  const end = s.indexOf("`", start);
  if (end < 0) throw new Error("找不到 QT_V8_BOOTSTRAP 收尾反引号");
  const body = s.substring(start, end);
  if (body.includes("`")) throw new Error("bootstrap 体里出现裸反引号，收尾判断需重新设计");
  return body;
}

const ENGINE_DIR = "F:/qtMusic/qt-uniappx/uni_modules/qt-js-engine/utssdk/app-android";
const PRELUDE = extractPrelude(`${ENGINE_DIR}/prelude.uts`);
const BOOTSTRAP = extractBootstrap(`${ENGINE_DIR}/webview.uts`);

function encodeEvalResult(v) {
  if (v === undefined || v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "null";
  }
}
function evaluateJavascript(code) {
  return new Promise((resolve) => {
    setImmediate(() => {
      let v;
      try {
        v = vm.runInContext(code, ctx);
      } catch (e) {
        v = undefined;
      }
      resolve(encodeEvalResult(v));
    });
  });
}
let lastEvalError = "";
function unwrapEval(raw) {
  if (raw == null) return "";
  const outer = `${raw}`;
  if (outer.length === 0 || outer === "null") return "";
  let inner;
  try {
    inner = `${JSON.parse(outer)}`;
  } catch {
    return outer;
  }
  try {
    const o = JSON.parse(inner);
    if (o && typeof o === "object" && "ok" in o && String(o.ok) === "0") {
      lastEvalError = o.e == null ? "脚本执行异常" : `${o.e}`;
      return "";
    }
    return o == null || o.v == null ? "" : `${o.v}`;
  } catch {
    return inner;
  }
}
async function evalSync(code) {
  return unwrapEval(await evaluateJavascript(code));
}

const q = (s) => JSON.stringify(String(s));
const exprCall = (name, argsJson) => `__qtEnvCall(${q(name)},${q(argsJson)})`;
const exprPump = () => "__qtEnvPump()";
const exprResolveHttp = (id, status, headers, body, error) =>
  `__qtEnvResolveHttp(${q(id)},${status},${q(headers)},${q(body)},${q(error)})`;
const exprFireTimer = (id) => `__qtEnvFireTimer(${q(id)})`;
const exprDropOp = (id) => `__qtEnvDropOp(${q(id)})`;
const exprEntries = () => "__qtEnvEntries()";
const exprProbe = () => "__qtEnvProbe()";

async function doHttp(task) {
  const headers = {};
  for (const line of String(task.headers || "").split("\n")) {
    if (!line) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!headers["User-Agent"] && !headers["user-agent"]) headers["User-Agent"] = UA;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), task.timeoutMs || 15000);
  try {
    const res = await fetch(task.url, {
      method: task.method || "GET",
      headers,
      body: task.body ? task.body : undefined,
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await res.text();
    const out = {};
    res.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
    return { status: res.status, headersJson: JSON.stringify(out), body: text, error: "" };
  } catch (e) {
    return { status: 0, headersJson: "{}", body: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const waiters = [];
let pumpScheduled = false;
let pumping = false;

async function pumpOnce() {
  const out = await evalSync(exprPump());
  if (lastEvalError) {
    console.log("   ⚠️ 泵求值出错:", lastEvalError.slice(0, 200));
    lastEvalError = "";
  }
  if (out.length > 0) {
    for (const line of out.split("\n")) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.k === "H") {
        doHttp(o).then(async (r) => {
          await evalSync(exprResolveHttp(o.id, r.status, r.headersJson, r.body, r.error));
        });
      } else if (o.k === "T") {
        const id = String(o.id);
        setTimeout(async () => {
          await evalSync(exprFireTimer(id));
        }, Number(o.ms) || 0);
      } else if (o.k === "R") {
        const target = waiters.find((w) => w.opId === String(o.id));
        if (target) {
          waiters.splice(waiters.indexOf(target), 1);
          target.resolve({ ok: Number(o.ok) === 1, value: String(o.value ?? ""), error: String(o.error ?? "") });
        }
      }
    }
  }
}

function startPump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  setTimeout(async () => {
    pumpScheduled = false;
    if (pumping) return;
    pumping = true;
    try {
      await pumpOnce();
    } finally {
      pumping = false;
    }
    if (waiters.length > 0) startPump();
  }, 20);
}

async function invoke(name, argsObj, timeoutMs = 20000) {
  const argsJson = JSON.stringify([argsObj]);
  const t0 = Date.now();
  const opId = (await evalSync(exprCall(name, argsJson))).trim();
  if (!opId || opId === "0") {
    throw new Error("未取得 opId" + (lastEvalError ? "：" + lastEvalError.slice(0, 200) : ""));
  }
  const result = await new Promise((resolve) => {
    waiters.push({ opId, resolve });
    startPump();
    setTimeout(() => {
      const i = waiters.findIndex((w) => w.opId === opId);
      if (i >= 0) {
        waiters.splice(i, 1);
        evalSync(exprDropOp(opId));
        resolve({ ok: false, value: "", error: "timeout" });
      }
    }, timeoutMs);
  });
  return { ...result, costMs: Date.now() - t0 };
}

// ==================== 时间标签形态统计 ====================

/**
 * 把 LRC 里所有 [..] 标签按形态归类：
 * 正常是 mm:ss.ff（2~3 位小数）。出现 1 位 / 4 位以上小数时 parseLrc 的 frac 缩放会算错
 * （1 位按 /10 对，4 位以上仍按 /10 → 时间被放大 10~1000 倍）。
 */
function tagShapes(text) {
  const shapes = new Map();
  const re = /\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text)) != null) {
    const tag = m[1];
    let key;
    if (!tag.includes(":")) key = "无冒号";
    else {
      const rest = tag.substring(tag.indexOf(":") + 1);
      const dot = rest.indexOf(".");
      if (dot < 0) key = "无小数点";
      else {
        const frac = rest.substring(dot + 1);
        key = `小数${frac.length}位` + (/^[0-9]+$/.test(frac) ? "" : "(含非数字)");
      }
    }
    if (!shapes.has(key)) shapes.set(key, { count: 0, sample: tag });
    shapes.get(key).count++;
  }
  return shapes;
}

// ==================== 主流程 ====================

console.log("=== 歌词定位数据体检（引擎等价物 + 逐字 parseLrc）===");
console.log(`bundle = ${bundlePath}（${bundleSrc.length} 字符）`);
console.log(`关键词 = 「${KEYWORD}」  源 = ${SOURCES.join(",")}`);

vm.runInContext(PRELUDE, ctx);
vm.runInContext(BOOTSTRAP, ctx);
const probe = await evalSync(exprProbe());
console.log(`探针 __qtEnvProbe() = "${probe}" ${probe === "2" ? "✅" : "❌"}`);

const mod = new vm.SourceTextModule(bundleSrc, { context: ctx, identifier: "qt-bundle.js" });
await mod.link(() => {
  throw new Error("bundle 不应有外部 import");
});
await mod.evaluate();
const entriesCount = await evalSync(exprEntries());
console.log(`入口数 = ${entriesCount}\n`);

const chainRes = await invoke("loadChain", chainJson, 15000);
console.log(`loadChain ${chainRes.ok ? "✅" : "❌"} ${chainRes.costMs}ms ${String(chainRes.value).slice(0, 80)}`);

const findings = [];

for (const source of SOURCES) {
  console.log("");
  console.log("=".repeat(78));
  console.log(`【${source}】搜索「${KEYWORD}」`);
  let hits = [];
  try {
    const raw = await invoke("search", { source, keyword: KEYWORD, page: 1, size: 20 }, 20000);
    if (!raw.ok) throw new Error(raw.error || "search 失败");
    hits = JSON.parse(raw.value).list ?? [];
  } catch (e) {
    console.log(`   ❌ 搜索失败：${String(e.message || e).slice(0, 160)}`);
    continue;
  }
  console.log(`   命中 ${hits.length} 首：${hits.slice(0, 6).map((s) => `${s.name}/${s.singer}`).join(" | ")}`);

  const exact = hits.filter((s) => String(s.name).trim() === KEYWORD);
  const targets = exact.length > 0 ? exact.slice(0, 2) : hits.slice(0, 1);
  if (targets.length === 0) {
    console.log("   ⚠️ 无可用命中");
    continue;
  }

  for (const hit of targets) {
    const song = {
      id: String(hit.id),
      name: String(hit.name ?? ""),
      singer: String(hit.singer ?? ""),
      album: String(hit.album ?? ""),
      picUrl: String(hit.picUrl ?? ""),
      interval: Number(hit.interval ?? 0),
    };
    if (hit.musicId != null) song.musicId = hit.musicId;
    console.log("");
    console.log(`── ${song.name} / ${song.singer} / ${song.album || "(无专辑)"}  id=${song.id} interval=${song.interval}s`);

    let lyricRes;
    try {
      lyricRes = await invoke("lyric", { source, song }, 25000);
    } catch (e) {
      console.log(`   ❌ lyric 异常：${String(e.message || e).slice(0, 200)}`);
      continue;
    }
    if (!lyricRes.ok) {
      console.log(`   ❌ lyric 返回失败：${lyricRes.error}（${lyricRes.costMs}ms）`);
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(lyricRes.value);
    } catch {
      console.log(`   ❌ 返回值不是 JSON：${lyricRes.value.slice(0, 200)}`);
      continue;
    }
    const text = String(obj.lyric ?? "");
    const tr = String(obj.translation ?? "");
    console.log(`   取词 ✅ ${lyricRes.costMs}ms  歌词 ${text.length} 字符 / 翻译 ${tr.length} 字符`);

    if (text.length === 0) {
      console.log("   ⚠️ 歌词文本为空 —— 这首歌在 app 里会显示「纯音乐，请欣赏」，不属于定位问题");
      findings.push({ source, song: song.id, kind: "空歌词" });
      continue;
    }

    // 换行形态
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/\n/g) || []).length;
    const crOnly = (text.match(/\r(?!\n)/g) || []).length;
    console.log(`   换行形态：\\n=${lf}  \\r\\n=${crlf}  单独\\r=${crOnly}`);

    // 标签形态
    const shapes = tagShapes(text);
    const shapeStr = [...shapes.entries()].map(([k, v]) => `${k}×${v.count}(如[${v.sample}])`).join("  ");
    console.log(`   标签形态：${shapeStr || "(无标签)"}`);

    // 原文前 400 字符（转义后）
    console.log(`   原文前 400 字符：${JSON.stringify(text.slice(0, 400))}`);

    // 解析（修复后的 parseLrc）
    skippedTags = [];
    const lines = parseLrc(text, tr);
    const oldLines = parseLrcOld(text, tr);
    const skipped = [...new Set(skippedTags)];
    if (skipped.length > 0) {
      console.log(`   跳过的元数据标签（修复后不再当成时间行）：${skipped.map((t) => `[${t}]`).join(" ")}`);
    }
    console.log(`   parseLrc(修复后) → ${lines.length} 行（翻译对齐后 translation 非空 ${lines.filter((l) => l.translation).length} 行）`);
    console.log(`   parseLrc(修复前) → ${oldLines.length} 行`);
    if (lines.length === 0) {
      console.log("   ❌ parseLrc 解析出 0 行 → app 里会显示「纯音乐，请欣赏」");
      findings.push({ source, song: song.id, kind: "解析 0 行" });
      continue;
    }

    const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));
    console.log("   前 12 行：");
    for (let i = 0; i < Math.min(12, lines.length); i++) {
      console.log(`      [${String(i).padStart(3)}] t=${fmt(lines[i].time).padStart(9)}  ${JSON.stringify(lines[i].text.slice(0, 46))}`);
    }
    console.log("   后 4 行：");
    for (let i = Math.max(0, lines.length - 4); i < lines.length; i++) {
      console.log(`      [${String(i).padStart(3)}] t=${fmt(lines[i].time).padStart(9)}  ${JSON.stringify(lines[i].text.slice(0, 46))}`);
    }

    // 异常检查
    const bad = [];
    let nonMono = 0;
    let zeroTime = 0;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].time;
      if (!Number.isFinite(t)) bad.push(`第 ${i} 行时间非数字：${t}`);
      if (t === 0) zeroTime++;
      if (i > 0 && lines[i].time < lines[i - 1].time) {
        if (nonMono < 4) bad.push(`第 ${i} 行时间倒退：${lines[i - 1].time} → ${lines[i].time}`);
        nonMono++;
      }
    }
    const times = lines.map((l) => l.time);
    const maxT = Math.max(...times);
    const lastT = times[times.length - 1];
    const interval = song.interval > 0 ? song.interval : 0;
    console.log(`   时间范围：min=${fmt(Math.min(...times))}  max=${fmt(maxT)}  末行=${fmt(lastT)}${interval > 0 ? `  歌曲时长=${interval}s` : ""}`);
    console.log(`   时间为 0 的行：${zeroTime}  时间倒退处：${nonMono}`);
    if (bad.length > 0) for (const b of bad) console.log(`   ⚠️ ${b}`);
    if (interval > 0 && lastT > interval + 5) {
      console.log(`   ⚠️ 末行时间（${fmt(lastT)}）超出歌曲时长（${interval}s）${fmt(lastT - interval)}s → 进度永远追不上最后几行`);
      findings.push({ source, song: song.id, kind: `末行超时长 ${fmt(lastT - interval)}s` });
    }

    // 首行到第二行的间隔：太大就说明开头很长一段只有一行
    if (lines.length > 1) {
      const gap = lines[1].time - lines[0].time;
      console.log(`   首行→第 2 行间隔：${fmt(gap)}s`);
      if (gap > 8) {
        console.log(`   ⚠️ 第 2 行来得太晚（${fmt(gap)}s）→ 开头这段进度条在走但高亮只能停在第 1 行`);
        findings.push({ source, song: song.id, kind: `首行间隔 ${fmt(gap)}s` });
      }
    }

    // index 推进轨迹（app 的算法）：修复前 / 修复后对照
    const dur = interval > 0 ? interval : lastT + 5;
    const traceOf = (ls) => {
      const out = [];
      for (let p = 0; p <= Math.ceil(dur); p += 5) out.push(`${p}s→${appIndex(ls, p)}`);
      return out;
    };
    const oldTrace = traceOf(oldLines);
    let trace = traceOf(lines);
    console.log(`   index 轨迹(修复前)：${oldTrace.join(" ")}`);
    console.log(`   index 轨迹(修复后)：${trace.join(" ")}`);
    const oldStuck = oldTrace.filter((x) => x.endsWith("→0")).length;
    if (oldStuck >= 3) {
      console.log(`   ⚠️ 修复前：前 ${oldStuck * 5}s 内 index 恒为 0（高亮完全不动）→ 这就是「这首歌歌词不跟随」`);
      findings.push({ source, song: song.id, kind: `修复前 index 恒为 0（${oldStuck * 5}s）` });
    }
    const stuck = trace.filter((x) => x.endsWith("→0")).length;
    if (stuck >= 3) {
      console.log(`   ⚠️ 修复后：仍有前 ${stuck * 5}s index 为 0 —— 属于正常前奏（首行时间 ${fmt(lines[0].time)}s，第 2 行 ${fmt(lines[1] ? lines[1].time : 0)}s）`);
    }
    if (oldStuck >= 3 && stuck < 3) {
      console.log("   ✅ 修复生效：该歌词的 index 已能随进度推进");
    }
  }
}

console.log("");
console.log("=".repeat(78));
console.log("=== 体检结论 ===");
if (findings.length === 0) {
  console.log("未发现异常：这些源的歌词时间轴都能正常推进 index（问题应在 UI 侧，不在数据）。");
} else {
  for (const f of findings) console.log(`⚠️ [${f.source}] id=${f.song}：${f.kind}`);
}
