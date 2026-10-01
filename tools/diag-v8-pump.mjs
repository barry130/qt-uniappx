/**
 * WebView(V8) 引擎的**协议等价性验证**（无需真机）。
 *
 * 用 node:vm 造一个「WebView 等价物」：
 *   - 独立的 V8 context（相当于页面的 globalThis），所以 prelude 覆盖 setTimeout 不会污染宿主；
 *   - evaluateJavascript(code) 模拟真机行为：**异步回调** + Chromium 的返回值编码规则
 *     （字符串带 JSON 引号、undefined/null 都回 "null"、异常不回传只给 "null"）；
 *   - bundle 用 vm.SourceTextModule 以**真正的 ESM** 载入同一 context
 *     （等价于 WebView 里 import('/qt-bundle.js')，顶层 export + 注册 globalThis.__qtEntries）。
 *
 * 然后完全按 index.uts 的泵协议驱动：__qtEnvCall → __qtEnvPump → 原生发 HTTP → __qtEnvResolveHttp
 * → 直到 R 行结算。表达式字符串与 webview.uts 里的 v8Expr* 完全一致。
 *
 * 这一步验证的东西（真机上也只需再验 WebView 本身）：
 *   ① 信封 + 两层 JSON 解包对不对
 *   ② 泵必须用**同步版** __qtPump()（V8 下 Promise 表达式拿不到返回值）
 *   ③ V8 的微任务检查点是否真的把 await 续跑推进（不依赖 QuickJS 的 Promise 包装）
 *   ④ 真实取链能不能跑通、init 到底多快
 *
 * 用法：node --experimental-vm-modules diag-v8-pump.mjs <bundle> <chain.json> [platform] [每源歌曲数] [源,源]
 *   例：node --experimental-vm-modules diag-v8-pump.mjs <bundle> <chain> 1101 12 qq,kg
 */
import fs from "node:fs";
import vm from "node:vm";

const [bundlePath, chainPath, platformArg, perSourceArg, sourcesArg] = process.argv.slice(2);
const PLATFORM = platformArg ? Number(platformArg) : 1101;
const PER_SOURCE = perSourceArg ? Number(perSourceArg) : 12;
const SOURCES = sourcesArg ? sourcesArg.split(",") : ["qq", "kg"];
const TIERS = ["128", "320", "flac"];
const bundleSrc = fs.readFileSync(bundlePath, "utf8");
const chainJson = fs.readFileSync(chainPath, "utf8");

const UA =
  "Mozilla/5.0 (Linux; Android 12; zh-CN) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

// ==================== 页面 context（独立 V8 context） ====================

const ctx = vm.createContext({ console });
ctx.__qtPlatform = PLATFORM;

/** prelude 与 bootstrap 的源码：直接从 .uts 里抠出来，保证测的是真货 */
function extractPrelude(utsPath) {
  const s = fs.readFileSync(utsPath, "utf8");
  const i = s.indexOf("export const QT_JS_PRELUDE = `");
  if (i < 0) throw new Error("找不到 QT_JS_PRELUDE");
  const start = s.indexOf("`", i + "export const QT_JS_PRELUDE = ".length) + 1;
  const end = s.indexOf("`;", start);
  return s.substring(start, end);
}
/**
 * 注意：原先「找 `\n」的启发式已被 prelude/bootstrap 改写打破 —— bootstrap 体内含
 * `${e}` 这种内层模板串，`\n 会命中它，把字符串截断（vm 报 Unexpected identifier '$'）。
 * 真正的收尾是 ` 后紧跟 .replace('__QT_V8_BUNDLE_URL__', ...)，bootstrap 体里没有裸反引号，
 * 所以取「起始后的第一个反引号」即收尾。
 */
function extractBootstrap(utsPath) {
  const s = fs.readFileSync(utsPath, "utf8");
  const i = s.indexOf("const QT_V8_BOOTSTRAP = `");
  if (i < 0) throw new Error("找不到 QT_V8_BOOTSTRAP");
  const start = s.indexOf("`", i + "const QT_V8_BOOTSTRAP = ".length) + 1;
  const end = s.indexOf("`", start);
  if (end < 0) throw new Error("找不到 QT_V8_BOOTSTRAP 收尾反引号");
  return s.substring(start, end);
}

const PRELUDE = extractPrelude(
  "F:/qtMusic/qt-uniappx/uni_modules/qt-js-engine/utssdk/app-android/prelude.uts",
);
const BOOTSTRAP = extractBootstrap(
  "F:/qtMusic/qt-uniappx/uni_modules/qt-js-engine/utssdk/app-android/webview.uts",
);
// 页面里没有宿主 request 的注入，prelude 的 __qtHost.request 就是队列版，不需要改

// ==================== 模拟 WebView 的 evaluateJavascript ====================

/** Chromium 的返回值编码：字符串带引号、undefined/null 都回 "null"、异常不回传 */
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

/** 真机行为：异常只在 logcat 可见，回调拿到的就是 "null" */
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

/** 逐字对照 webview.uts 的 unwrapEval */
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

let lastEvalError = "";
let evalCount = 0;
/** v8EvalSync 的等价物：引擎线程阻塞等结果 */
async function evalSync(code) {
  evalCount++;
  return unwrapEval(await evaluateJavascript(code));
}

// ==================== 表达式（逐字对照 index.uts 的 expr* / webview.uts 的 v8Expr*） ====================

const q = (s) => JSON.stringify(String(s)); // 等价于 quoteAscii（此处允许非 ASCII，真机也安全）
const exprCall = (name, argsJson) => `__qtEnvCall(${q(name)},${q(argsJson)})`;
const exprPump = () => "__qtEnvPump()";
const exprResolveHttp = (id, status, headers, body, error) =>
  `__qtEnvResolveHttp(${q(id)},${status},${q(headers)},${q(body)},${q(error)})`;
const exprFireTimer = (id) => `__qtEnvFireTimer(${q(id)})`;
const exprDropOp = (id) => `__qtEnvDropOp(${q(id)})`;
const exprEntries = () => "__qtEnvEntries()";
const exprProbe = () => "__qtEnvProbe()";

// ==================== 原生侧 HTTP（对照 HttpTask） ====================

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

// ==================== 泵（对照 PumpTask / dispatchLines / InvokeTask） ====================

const waiters = [];
let pumpScheduled = false;
let pumping = false;
let pumpCount = 0;
const pendingTimers = new Map();
let timerSeq = 0;

async function pumpOnce() {
  const out = await evalSync(exprPump());
  pumpCount++;
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
        const h = setTimeout(async () => {
          pendingTimers.delete(id);
          await evalSync(exprFireTimer(id));
        }, Number(o.ms) || 0);
        pendingTimers.set(id, h);
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

// ==================== 主流程 ====================

console.log("=== WebView(V8) 协议等价性验证（node:vm 模拟）===");
console.log("platform =", PLATFORM, " bundle =", bundleSrc.length, "字符");

// ① 注入 prelude（对应 v8Start 的 v8EvalRaw(QT_JS_PRELUDE)）
const tPrelude = Date.now();
vm.runInContext(PRELUDE, ctx);
console.log(`① prelude 注入完成 ${Date.now() - tPrelude}ms`);
vm.runInContext(BOOTSTRAP, ctx);
console.log("② bootstrap 注入完成");

// ③ 探针：必须拿到 "2"（这一步同时验证「字符串结果要解两层 JSON」）
const probe = await evalSync(exprProbe());
console.log(`③ 探针 __qtEnvProbe() = "${probe}"  ${probe === "2" ? "✅" : "❌ 信封/解包有问题"}`);

// ④ 以真 ESM 载入 bundle（等价于 import('/qt-bundle.js')）
const tLoad = Date.now();
const mod = new vm.SourceTextModule(bundleSrc, { context: ctx, identifier: "qt-bundle.js" });
await mod.link(() => {
  throw new Error("bundle 不应有外部 import");
});
await mod.evaluate();
const loadMs = Date.now() - tLoad;
console.log(`④ bundle 以 ESM 载入并执行：${loadMs}ms`);
const entriesCount = await evalSync(exprEntries());
console.log(`   __qtEntries 入口数 = ${entriesCount}  ${Number(entriesCount) > 0 ? "✅" : "❌"}`);

// ⑤ 语法闸门：坏包必须被拦下，且顶层零执行
try {
  const broken = new vm.SourceTextModule(bundleSrc + "\n\nfunction ( {", { context: ctx });
  await broken.link(() => {});
  await broken.evaluate();
  console.log("⑤ 坏包闸门：❌ 竟然没报错");
} catch (e) {
  console.log(`⑤ 坏包闸门：✅ ${e?.constructor?.name}: ${String(e?.message || e).split("\n")[0].slice(0, 70)}`);
}

// ⑥ 白名单可用性对照：这条平台过滤就是「kg 在安卓 0/36」的直接原因
const chainObj = JSON.parse(chainJson);
console.log("");
console.log(`⑥ 线路可用性（平台 ${PLATFORM}）—— platforms 字段就是 rev 7 加的安卓白名单`);
function lineAvailable(line) {
  const p = line.platforms;
  if (p == null) return true;
  if (!Array.isArray(p) || p.length === 0) return true;
  return p.includes(PLATFORM);
}
for (const src of SOURCES) {
  const lines = chainObj.chains[src] ?? [];
  const av = lines.filter((l) => lineAvailable(l));
  console.log(
    `   ${src}: ${av.length}/${lines.length} 条可用` +
      (av.length < lines.length
        ? `  ← 被挡：${lines.filter((l) => !lineAvailable(l)).map((l) => `${l.id}[${l.platforms}]`).join(", ")}`
        : ""),
  );
}

// ⑦ 全量取链回归：每源挑 Live 歌 → 3 档 → 真发 Range 预检
const chainRes = await invoke("loadChain", chainJson, 15000);
console.log("");
console.log(`⑦ loadChain ${chainRes.ok ? "✅" : "❌"} ${chainRes.costMs}ms ${String(chainRes.value).slice(0, 80)}`);

const LIVE_RE = /live|演唱会|现场|音乐会|巡演|concert/i;
const KEYWORDS = [
  "live",
  "演唱会",
  "周杰伦 live",
  "林俊杰 live",
  "五月天 live",
  "陈奕迅 live",
  "邓紫棋 live",
  "薛之谦 live",
  "张杰 live",
  "李荣浩 live",
  "毛不易 live",
  "华晨宇 live",
];

async function pickSongs(source) {
  const seen = new Set();
  const live = [];
  const pool = [];
  for (const kw of KEYWORDS) {
    let list = [];
    try {
      const raw = await invoke("search", { source, keyword: kw, page: 1, size: 30 }, 20000);
      if (!raw.ok) continue;
      list = JSON.parse(raw.value).list ?? [];
    } catch {
      continue;
    }
    for (const s of list) {
      const id = String(s.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const rec = { id, name: String(s.name), singer: String(s.singer), album: String(s.album ?? "") };
      pool.push(rec);
      if (LIVE_RE.test(rec.name) || LIVE_RE.test(rec.album)) live.push(rec);
    }
  }
  const bySinger = new Map();
  for (const s of live) {
    const key = s.singer.split(/[;；,，]/)[0].trim();
    if (!bySinger.has(key)) bySinger.set(key, []);
    bySinger.get(key).push(s);
  }
  const out = [];
  const nameSeen = new Set();
  for (let round = 0; out.length < PER_SOURCE; round++) {
    let progressed = false;
    for (const [, arr] of bySinger) {
      if (out.length >= PER_SOURCE) break;
      const s = arr[round];
      if (!s) continue;
      progressed = true;
      const nk = s.name + "|" + s.singer;
      if (nameSeen.has(nk)) continue;
      nameSeen.add(nk);
      out.push(s);
    }
    if (!progressed) break;
  }
  if (out.length < PER_SOURCE) {
    for (const s of pool) {
      if (out.length >= PER_SOURCE) break;
      const nk = s.name + "|" + s.singer;
      if (nameSeen.has(nk)) continue;
      nameSeen.add(nk);
      out.push({ ...s, live: false });
    }
  }
  return { songs: out.slice(0, PER_SOURCE), livePool: live.length, totalPool: pool.length };
}

const median = (a) => {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : Math.round((b[m - 1] + b[m]) / 2);
};
const domainOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return "?";
  }
};

const report = { platform: PLATFORM, bundle: bundlePath, chain: chainPath, loadMs, sources: {} };
let totalOk = 0;
let totalFail = 0;

for (const src of SOURCES) {
  const pick = await pickSongs(src);
  console.log("");
  console.log(`【选曲】${src}：Live 候选 ${pick.livePool} 首 / 池 ${pick.totalPool} 首，取 ${pick.songs.length} 首`);
  const rows = [];
  const domains = new Map();
  let selfHit = 0;
  let okN = 0;
  let failN = 0;
  const costs = [];
  for (const song of pick.songs) {
    const marks = [];
    for (const quality of TIERS) {
      const r = await invoke(
        "getPlayUrl",
        { platform: src, id: song.id, name: song.name, singer: song.singer, quality },
        20000,
      );
      if (!r.ok) {
        failN++;
        marks.push(`${quality}:✗`);
        continue;
      }
      let url = "";
      try {
        url = JSON.parse(r.value).url;
      } catch {
        url = "";
      }
      let playable = false;
      let status = 0;
      try {
        const pr = await fetch(url, { headers: { Range: "bytes=0-1", "User-Agent": UA } });
        status = pr.status;
        await pr.arrayBuffer();
        playable = pr.status === 206 || pr.status === 200 || pr.status === 403 || pr.status === 416;
      } catch {
        playable = false;
      }
      if (playable) {
        okN++;
        costs.push(r.costMs);
        const d = domainOf(url);
        domains.set(d, (domains.get(d) ?? 0) + 1);
        if (url.includes(song.id)) selfHit++;
        marks.push(`${quality}:✓${status}`);
      } else {
        failN++;
        marks.push(`${quality}:✗HTTP${status}`);
      }
    }
    rows.push({ ...song, marks: marks.join(" ") });
    console.log(`   ${song.name.slice(0, 26).padEnd(26)} ${song.singer.slice(0, 10).padEnd(10)} ${rows[rows.length - 1].marks}`);
  }
  console.log(
    `   ── ${src} 合计：可播 ${okN}/${pick.songs.length * TIERS.length}，中位 ${median(costs)}ms，` +
      `self-hit ${selfHit}，域名 ${[...domains.entries()].map(([d, n]) => `${d}×${n}`).join(" ") || "无"}`,
  );
  report.sources[src] = {
    livePool: pick.livePool,
    songs: pick.songs.length,
    ok: okN,
    fail: failN,
    medianMs: median(costs),
    selfHit,
    domains: Object.fromEntries(domains),
    rows,
  };
  totalOk += okN;
  totalFail += failN;
}

console.log("");
console.log("=== 汇总 ===");
console.log(`平台 ${PLATFORM}：可播 ${totalOk} / 失败 ${totalFail}`);
console.log(`bundle ESM 装载 ${loadMs}ms（QuickJS 上这一步是 compileModule+execute）`);
console.log(`evaluate 次数 ${evalCount}，泵次数 ${pumpCount}，残留 waiters ${waiters.length}`);
if (lastEvalError) console.log("最后错误:", lastEvalError.slice(0, 300));

const outPath = `F:/qtMusic/qt-uniappx/.tmp/diag-v8-pump-${PLATFORM}.json`;
fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
console.log(`原始数据 → ${outPath}`);
process.exitCode = totalOk > 0 ? 0 : 1;
