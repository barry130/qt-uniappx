/**
 * QQ 单线路失败归因诊断（无需真机，与线上 bundle 同源同链）。
 *
 * 目标：回答「QQ 20 首 19 首最后都走 kw 兜底」，到底是因为 QQ 档内四条线路各自的
 * 哪个死因（死链 / 超时 / 空 / 抛错 / 预算耗尽），并且**全音质**（128/320/flac）都测。
 *
 * 思路（核心）：
 *   ① 用 node:vm 起一个与 diag-v8-pump.mjs 完全相同的 WebView 等价物，以真 ESM 载入
 *      source-bundle.js，按真实泵协议驱动（__qtEnvCall → __qtEnvPump → 原生发 HTTP → …）。
 *   ② Pass 0（真实 chain.json，跨源开着）：逐首 × 3 档取链，按返回的命中线路分类
 *      确认当前现象——命中是 qq 档内某条线 / cross:kw / cross:wyy / 整链全灭。
 *   ③ 归因（核心）：把 crossSources 全部关掉，并且每次**只保留 QQ 一条线路**，其余摘掉，
 *      得到一个「只有这条线、且无跨源救场」的链。此时 getPlayUrl 若命中 → 该线成功；
 *      若失败 → 抛错文本里就是这条线自己的死因（bundle 的消费 lastMissTrace 上抛）。
 *      这样每条 QQ 线在 128/320/flac 下的 命中数 + 死因分布 就单独拿到了。
 *
 * 为什么要关跨源：真实链里 QQ 档内全灭会被 kw 救回，getPlayUrl 返回成功（line=cross:kw），
 * QQ 四条线各自失败的死因根本不会上抛——因此必须先摘掉跨源，让失败真正落到"整链全灭"，
 * trace 才带得上逐线路原因。
 *
 * 用法：
 *   node --experimental-vm-modules diag-qq-lines.mjs <bundle> <chain.json> [歌曲数=20] [歌曲列表JSON可选]
 * 例：
 *   node --experimental-vm-modules diag-qq-lines.mjs ../static/source-bundle/source-bundle.js ../static/source-bundle/chain.json 20
 * 结果写 .tmp/diag-qq-lines.json，控制台出汇总表。
 */
import fs from "node:fs";
import vm from "node:vm";

const [bundlePath, chainPath, songCountArg, songsJsonArg] = process.argv.slice(2);
const SONG_COUNT = songCountArg ? Number(songCountArg) : 20;
const TIERS = ["128", "320", "flac"];

const bundleSrc = fs.readFileSync(bundlePath, "utf8");
const baseChain = JSON.parse(fs.readFileSync(chainPath, "utf8"));

const UA =
  "Mozilla/5.0 (Linux; Android 12; zh-CN) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

// ==================== 从 .uts 抠出 prelude / bootstrap（保证测的是真货） ====================

function extractPrelude(utsPath) {
  const s = fs.readFileSync(utsPath, "utf8");
  const i = s.indexOf("export const QT_JS_PRELUDE = `");
  if (i < 0) throw new Error("找不到 QT_JS_PRELUDE");
  const start = s.indexOf("`", i + "export const QT_JS_PRELUDE = ".length) + 1;
  const end = s.indexOf("`;", start);
  return s.substring(start, end);
}
function extractBootstrap(utsPath) {
  const s = fs.readFileSync(utsPath, "utf8");
  const i = s.indexOf("const QT_V8_BOOTSTRAP = `");
  if (i < 0) throw new Error("找不到 QT_V8_BOOTSTRAP");
  const start = s.indexOf("`", i + "const QT_V8_BOOTSTRAP = ".length) + 1;
  const end = s.indexOf("`", start);
  return s.substring(start, end);
}
const PRELUDE = extractPrelude(
  "F:/qtMusic/qt-uniappx/uni_modules/qt-js-engine/utssdk/app-android/prelude.uts",
);
const BOOTSTRAP = extractBootstrap(
  "F:/qtMusic/qt-uniappx/uni_modules/qt-js-engine/utssdk/app-android/webview.uts",
);

// ==================== 每套 harness 独立 context（避免 URL 缓存/状态跨 pass 串扰） ====================

function createHarness() {
  const ctx = vm.createContext({ console });
  ctx.__qtPlatform = 1101;

  const q = (s) => JSON.stringify(String(s));
  const exprCall = (name, argsJson) => `__qtEnvCall(${q(name)},${q(argsJson)})`;
  const exprPump = () => "__qtEnvPump()";
  const exprResolveHttp = (id, status, headers, body, error) =>
    `__qtEnvResolveHttp(${q(id)},${status},${q(headers)},${q(body)},${q(error)})`;
  const exprFireTimer = (id) => `__qtEnvFireTimer(${q(id)})`;
  const exprDropOp = (id) => `__qtEnvDropOp(${q(id)})`;
  const exprProbe = () => "__qtEnvProbe()";

  let lastEvalError = "";
  let evalCount = 0;
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
    evalCount++;
    return unwrapEval(await evaluateJavascript(code));
  }

  // 原生侧 HTTP
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

  // 泵
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

  async function invoke(name, argsObj, timeoutMs = 25000) {
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

  // 装载：prelude → bootstrap → probe → bundle ESM → 探针入口
  return {
    async init() {
      vm.runInContext(PRELUDE, ctx);
      vm.runInContext(BOOTSTRAP, ctx);
      const probe = await evalSync(exprProbe());
      if (probe !== "2") throw new Error("预检信封失败 probe=" + probe);
      const mod = new vm.SourceTextModule(bundleSrc, { context: ctx, identifier: "qt-bundle.js" });
      await mod.link(() => {
        throw new Error("bundle 不应有外部 import");
      });
      await mod.evaluate();
    },
    async loadChain(chainObj) {
      const r = await invoke("loadChain", JSON.stringify(chainObj), 15000);
      if (!r.ok) throw new Error("loadChain 失败：" + r.error);
      return r.value;
    },
    async getPlayUrl(platform, song, quality) {
      return await invoke("getPlayUrl", {
        platform,
        id: song.id,
        name: song.name,
        singer: song.singer,
        quality,
        duration: song.duration ?? 0,
      }, 25000);
    },
    async search(source, keyword, page = 1, size = 30) {
      const r = await invoke("search", { source, keyword, page, size }, 20000);
      if (!r.ok) throw new Error("search 失败：" + r.error);
      const o = JSON.parse(r.value);
      return o.list ?? [];
    },
    _stats: { evals: () => evalCount },
  };
}

// ==================== 选曲：真实 QQ 搜索，凑 SONG_COUNT 首（与线上同源） ====================

const KEYWORDS = [
  "周杰伦", "林俊杰", "陈奕迅", "邓紫棋", "薛之谦", "张杰", "李荣浩",
  "毛不易", "华晨宇", "五月天", "陈粒", "孙燕姿", "许嵩", "李健", "汪苏泷",
];
async function pickSongs(harness, count) {
  const seen = new Set();
  const pool = [];
  let total = 0;
  for (const kw of KEYWORDS) {
    if (pool.length >= count * 3) break;
    let list = [];
    try {
      list = await harness.search("qq", kw, 1, 30);
    } catch {
      continue;
    }
    for (const s of list) {
      total++;
      const id = String(s.id);
      if (seen.has(id)) continue;
      seen.add(id);
      pool.push({ id, name: String(s.name), singer: String(s.singer), album: String(s.album ?? ""), duration: Number(s.duration || 0) });
    }
  }
  return { songs: pool.slice(0, count), total };
}

// ==================== 归因解析 ====================

// 单条 trace：`<lineId>=<reason>`；多条用 "; " 连接，整串包在 `未取到播放地址（` 里、
// 前置 `qq@<quality>`（可能带 `[降级中]`）。先把外壳与平台标记剥掉再逐条解析。
function parseTrace(text) {
  let inner = String(text || "");
  inner = inner.replace(/^.*?未取到播放地址（/, "").replace(/）\s*$/, "");
  inner = inner.replace(/^(qq\s*@\w+\s*)/, "").replace(/^\[降级中\]\s*/, "");
  inner = inner.replace(/^\[降级中\]\s*/, "").replace(/^(qq\s*@\w+\s*)/, "");
  const reasons = [];
  for (const seg of inner.split("; ")) {
    const m = /^(qq-[\w-]+)=(.+)$/.exec(seg.trim());
    if (m) reasons.push({ line: m[1], reason: m[2].trim() });
  }
  return reasons;
}
function categorize(reason) {
  if (reason.startsWith("死链（Range 预检不过）")) return "死链(Range预检不过)";
  if (reason.startsWith("预检超时")) return "预检超时";
  if (reason.startsWith("超时未返回")) return "超时未返回";
  if (reason.startsWith("err:")) return "抛错:" + reason.slice(4).slice(0, 32);
  if (reason.startsWith("预算耗尽未跑")) return "预算耗尽未跑";
  if (reason.startsWith("空")) return "空";
  if (reason === "ok") return "ok(命中)";
  return "其他:" + reason.slice(0, 32);
}

// ==================== 主流程 ====================

console.log("=== QQ 单线路失败归因（全音质 128/320/flac）===");
console.log("bundle =", bundlePath, bundleSrc.length, "字符");
console.log("chain  =", chainPath, "（chainRevision", baseChain.chainRevision + "）");

// 选曲（用一个[真实链]的 harness，搜索不依赖链）
const picker = createHarness();
await picker.init();
const { songs, total } = await pickSongs(picker, SONG_COUNT);
console.log(`选曲：QQ 池 ${total} 首，取 ${songs.length} 首（id 去重）`);
if (songs.length === 0) {
  console.log("❌ 未选到任何 QQ 歌，终止");
  process.exit(2);
}
spread(songs);

function spread(list) {
  for (const s of list) console.log(`   [${s.id}] ${s.name} — ${s.singer}`);
}

// ---- 记录结果容器 ----
const report = { bundle: bundlePath, chain: chainPath, songCount: songs.length, songs, pass0: {}, perLine: {} };
const qqLines = (baseChain.chains.qq ?? []).map((l) => ({ id: l.id, name: l.name, kind: l.kind, qualities: l.qualities }));

// ==================== Pass 0：真实链（跨源开），确认现状 ====================

console.log("\n── Pass 0：真实 chain.json（跨源开着）──");
{
  const h = createHarness();
  await h.init();
  await h.loadChain(baseChain);
  const counter = {};
  let totalMiss = 0;
  const rows = [];
  for (const song of songs) {
    const marks = [];
    for (const quality of TIERS) {
      const r = await h.getPlayUrl("qq", song, quality);
      let hit = "";
      if (r.ok) {
        try {
          const o = JSON.parse(r.value);
          hit = String(o.line?.id ?? "");
        } catch {
          hit = "";
        }
      }
      const kind = r.ok ? (hit.startsWith("cross:") ? hit : (!hit ? "qq档内(无line)" : hit)) : "整链全灭";
      counter[kind] = (counter[kind] ?? 0) + 1;
      if (!r.ok) totalMiss++;
      marks.push(`${quality}:${r.ok ? (hit || "hit") : "✗"}`);
    }
    rows.push({ ...song, marks: marks.join(" ") });
    console.log(`   ${song.name.slice(0, 22).padEnd(22)} ${rows[rows.length - 1].marks}`);
  }
  console.log("   ── Pass 0 命中线路分布：");
  for (const [k, n] of Object.entries(counter).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${k}: ${n}/${songs.length * TIERS.length}`);
  }
  console.log(`      整链全灭 ${totalMiss}/${songs.length * TIERS.length}`);
  report.pass0 = { counter, rows, totalMiss };
}

// ==================== 归因：逐线路隔离（关跨源） ====================

console.log("\n── 归因：每条 QQ 线路单独测（关跨源兜底）──");
const perLine = {};
const rawQqLines = baseChain.chains.qq ?? [];
for (const line of rawQqLines) {
  const variant = { ...baseChain, crossSources: { wyy: [], qq: [], kw: [], kg: [] }, chains: { qq: [line] } };
  const h = createHarness();
  await h.init();
  await h.loadChain(variant);
  const perQuality = {};
  for (const quality of TIERS) {
    if (!(line.qualities ?? []).includes(quality)) {
      perQuality[quality] = { "n/a": true };
      continue;
    }
    let hit = 0;
    let miss = 0;
    const missReasons = {};
    const reasonSamples = {};
    for (const song of songs) {
      const r = await h.getPlayUrl("qq", song, quality);
      if (r.ok) {
        hit++;
      } else {
        miss++;
        const lines = parseTrace(r.error);
        if (lines.length === 0) {
          const k = "无trace:" + String(r.error || "error").slice(0, 60);
          missReasons[k] = (missReasons[k] ?? 0) + 1;
          if (!reasonSamples[k]) reasonSamples[k] = `${song.name} → ${String(r.error || "").slice(0, 120)}`;
        } else {
          for (const [i, t] of lines.entries()) {
            const cat = categorize(t.reason);
            missReasons[cat] = (missReasons[cat] ?? 0) + 1;
            if (!reasonSamples[cat]) reasonSamples[cat] = `${song.name} → ${t.reason}`;
          }
        }
      }
    }
    perQuality[quality] = { hit, miss, reasons: missReasons, samples: reasonSamples };
    console.log(`   ${line.id.padEnd(20)} ${quality.padEnd(5)} 命中 ${String(hit).padStart(2)}/${songs.length}  死因:` +
      Object.entries(missReasons).map(([k, n]) => `${k}×${n}`).join(" ") || "—");
  }
  perLine[line.id] = { name: line.name, kind: line.kind, perQuality };
}
report.perLine = perLine;

// ==================== 汇总表 ====================

console.log("\n=== 汇总：QQ 各线路 × 音质 命中率 ===\n");
for (const line of qqLines) {
  const cols = [];
  for (const quality of TIERS) {
    const q = perLine[line.id].perQuality[quality];
    if (!q) continue;
    if (q["n/a"]) { cols.push(`${quality}: N/A(不提供此档)`); continue; }
    cols.push(`${quality}: ${q.hit}/${q.hit + q.miss}`);
  }
  console.log(`  ${line.id.padEnd(20)} ${cols.join("   ")}`);
}
console.log("");
// 每档主导死因
for (const quality of TIERS) {
  const agg = {};
  for (const line of qqLines) {
    const q = perLine[line.id].perQuality[quality];
    if (!q || q["n/a"]) continue;
    for (const [k, n] of Object.entries(q.reasons)) agg[k] = (agg[k] ?? 0) + n;
  }
  const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
  console.log(`  ${quality}档 全线路死因TOP：` + (sorted.length ? sorted.slice(0, 5).map(([k, n]) => `${k}×${n}`).join("  ") : "（无失败）"));
}

const outPath = `F:/qtMusic/qt-uniappx/.tmp/diag-qq-lines.json`;
fs.mkdirSync("F:/qtMusic/qt-uniappx/.tmp", { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
console.log(`\n原始数据 → ${outPath}`);
