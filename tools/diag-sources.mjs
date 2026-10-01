/**
 * 多源逐线路失败归因诊断（无需真机，与线上 bundle 同源同链）。
 *
 * 对给定音源（默认 qq,kg）跑：
 *   Pass 0：真实 chain（跨源开）→ 按命中线路分类，确认现状；
 *   归因：crossSources 全关 + 每次只留一条该源线路 → 单独测出每条线在
 *          128/320/flac 下的 命中数 + 死因（空/超时/预检超时/死链/抛错/预算耗尽）。
 *
 * 用法：
 *   node --experimental-vm-modules diag-sources.mjs <bundle> <chain.json> [源,源] [歌曲数=20]
 * 例：
 *   node --experimental-vm-modules diag-sources.mjs ../static/source-bundle/source-bundle.js ../static/source-bundle/chain.json qq,kg 20
 */
import fs from "node:fs";
import vm from "node:vm";

const [bundlePath, chainPath, sourcesArg, songCountArg] = process.argv.slice(2);
const SOURCES = (sourcesArg || "qq,kg").split(",").filter(Boolean);
const SONG_COUNT = songCountArg ? Number(songCountArg) : 20;
const TIERS = ["128", "320", "flac"];

const bundleSrc = fs.readFileSync(bundlePath, "utf8");
const baseChain = JSON.parse(fs.readFileSync(chainPath, "utf8"));
const UA =
  "Mozilla/5.0 (Linux; Android 12; zh-CN) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

function extractPrelude(utsPath) {
  const s = fs.readFileSync(utsPath, "utf8");
  const i = s.indexOf("export const QT_JS_PRELUDE = `");
  const start = s.indexOf("`", i + "export const QT_JS_PRELUDE = ".length) + 1;
  return s.substring(start, s.indexOf("`;", start));
}
function extractBootstrap(utsPath) {
  const s = fs.readFileSync(utsPath, "utf8");
  const i = s.indexOf("const QT_V8_BOOTSTRAP = `");
  const start = s.indexOf("`", i + "const QT_V8_BOOTSTRAP = ".length) + 1;
  return s.substring(start, s.indexOf("`", start));
}
const PRELUDE = extractPrelude("F:/qtMusic/qt-uniappx/uni_modules/qt-js-engine/utssdk/app-android/prelude.uts");
const BOOTSTRAP = extractBootstrap("F:/qtMusic/qt-uniappx/uni_modules/qt-js-engine/utssdk/app-android/webview.uts");

function createHarness() {
  const ctx = vm.createContext({ console });
  ctx.__qtPlatform = 1101;
  const q = (s) => JSON.stringify(String(s));
  const expr = {
    call: (n, a) => `__qtEnvCall(${q(n)},${q(a)})`,
    pump: () => "__qtEnvPump()",
    http: (id, st, hd, b, e) => `__qtEnvResolveHttp(${q(id)},${st},${q(hd)},${q(b)},${q(e)})`,
    timer: (id) => `__qtEnvFireTimer(${q(id)})`,
    drop: (id) => `__qtEnvDropOp(${q(id)})`,
    probe: () => "__qtEnvProbe()",
  };
  let lastEvalError = "";
  function enc(v) {
    if (v === undefined || v === null) return "null";
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try { return JSON.stringify(v); } catch { return "null"; }
  }
  function evalJs(code) {
    return new Promise((res) => {
      setImmediate(() => {
        let v;
        try { v = vm.runInContext(code, ctx); } catch { v = undefined; }
        res(enc(v));
      });
    });
  }
  function unwrap(raw) {
    if (raw == null) return "";
    const outer = `${raw}`;
    if (outer.length === 0 || outer === "null") return "";
    let inner;
    try { inner = `${JSON.parse(outer)}`; } catch { return outer; }
    try {
      const o = JSON.parse(inner);
      if (o && typeof o === "object" && "ok" in o && String(o.ok) === "0") {
        lastEvalError = o.e == null ? "脚本执行异常" : `${o.e}`;
        return "";
      }
      return o == null || o.v == null ? "" : `${o.v}`;
    } catch { return inner; }
  }
  async function evalSync(code) { return unwrap(await evalJs(code)); }

  async function doHttp(task) {
    const headers = {};
    for (const line of String(task.headers || "").split("\n")) {
      if (!line) continue;
      const i = line.indexOf(":");
      if (i <= 0) continue;
      headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (!headers["User-Agent"] && !headers["user-agent"]) headers["User-Agent"] = UA;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), task.timeoutMs || 15000);
    try {
      const res = await fetch(task.url, {
        method: task.method || "GET", headers,
        body: task.body ? task.body : undefined,
        signal: ctrl.signal, redirect: "follow",
      });
      const text = await res.text();
      const out = {};
      res.headers.forEach((v2, k) => (out[k.toLowerCase()] = v2));
      return { status: res.status, headersJson: JSON.stringify(out), body: text, error: "" };
    } catch (e) {
      return { status: 0, headersJson: "{}", body: "", error: String(e?.message || e) };
    } finally { clearTimeout(timer); }
  }

  const waiters = [];
  let pumpScheduled = false, pumping = false;
  const pendingTimers = new Map();
  async function pumpOnce() {
    const out = await evalSync(expr.pump());
    if (out.length > 0) {
      for (const line of out.split("\n")) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.k === "H") {
          doHttp(o).then(async (r) => { await evalSync(expr.http(o.id, r.status, r.headersJson, r.body, r.error)); });
        } else if (o.k === "T") {
          const id = String(o.id);
          const h = setTimeout(async () => { pendingTimers.delete(id); await evalSync(expr.timer(id)); }, Number(o.ms) || 0);
          pendingTimers.set(id, h);
        } else if (o.k === "R") {
          const t = waiters.find((w) => w.opId === String(o.id));
          if (t) {
            waiters.splice(waiters.indexOf(t), 1);
            t.resolve({ ok: Number(o.ok) === 1, value: String(o.value ?? ""), error: String(o.error ?? "") });
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
      try { await pumpOnce(); } finally { pumping = false; }
      if (waiters.length > 0) startPump();
    }, 20);
  }
  async function invoke(name, argsObj, timeoutMs = 25000) {
    const argsJson = JSON.stringify([argsObj]);
    const opId = (await evalSync(expr.call(name, argsJson))).trim();
    if (!opId || opId === "0") throw new Error("未取得 opId" + (lastEvalError ? "：" + lastEvalError.slice(0, 200) : ""));
    return await new Promise((resolve) => {
      waiters.push({ opId, resolve });
      startPump();
      setTimeout(() => {
        const i = waiters.findIndex((w) => w.opId === opId);
        if (i >= 0) { waiters.splice(i, 1); evalSync(expr.drop(opId)); resolve({ ok: false, value: "", error: "timeout" }); }
      }, timeoutMs);
    });
  }
  return {
    async init() {
      vm.runInContext(PRELUDE, ctx);
      vm.runInContext(BOOTSTRAP, ctx);
      if ((await evalSync(expr.probe())) !== "2") throw new Error("prelude 探针失败");
      const mod = new vm.SourceTextModule(bundleSrc, { context: ctx, identifier: "qt-bundle.js" });
      await mod.link(() => { throw new Error("bundle 不应有外部 import"); });
      await mod.evaluate();
    },
    async loadChain(chainObj) {
      const r = await invoke("loadChain", JSON.stringify(chainObj), 15000);
      if (!r.ok) throw new Error("loadChain 失败：" + r.error);
    },
    async getPlayUrl(platform, song, quality) {
      return await invoke("getPlayUrl", {
        platform, id: song.id, name: song.name, singer: song.singer,
        quality, duration: song.duration ?? 0, album: song.album ?? "",
      }, 25000);
    },
    async search(source, keyword, page = 1, size = 30) {
      const r = await invoke("search", { source, keyword, page, size }, 20000);
      if (!r.ok) throw new Error("search 失败：" + r.error);
      return JSON.parse(r.value).list ?? [];
    },
  };
}

// ==================== 选曲 ====================

const KEYWORDS = [
  "周杰伦", "林俊杰", "陈奕迅", "邓紫棋", "薛之谦", "张杰", "李荣浩",
  "毛不易", "华晨宇", "五月天", "陈粒", "孙燕姿", "许嵩", "李健", "汪苏泷",
];
async function pickSongs(harness, source, count) {
  const seen = new Set();
  const pool = [];
  let total = 0;
  for (const kw of KEYWORDS) {
    if (pool.length >= count * 3) break;
    let list = [];
    try { list = await harness.search(source, kw, 1, 30); } catch { continue; }
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

function parseTrace(text) {
  let inner = String(text || "");
  inner = inner.replace(/^.*?未取到播放地址（/, "").replace(/）\s*$/, "");
  inner = inner.replace(/^(?:wyy|qq|kw|kg)\s*@\w+\s*/, "").replace(/^\[降级中\]\s*/, "");
  inner = inner.replace(/^\[降级中\]\s*/, "").replace(/^(?:wyy|qq|kw|kg)\s*@\w+\s*/, "");
  const reasons = [];
  for (const seg of inner.split("; ")) {
    const m = /^([a-z][a-z0-9-]*)=(.+)$/.exec(seg.trim());
    if (m) reasons.push({ line: m[1], reason: m[2].trim() });
  }
  return reasons;
}
function categorize(reason) {
  if (reason.startsWith("死链（Range 预检不过）")) return "死链(Range预检不过)";
  if (reason.startsWith("预检超时")) return "预检超时";
  if (reason.startsWith("超时未返回")) return "超时未返回";
  if (reason.startsWith("err:")) return "抛错:" + reason.slice(4).slice(0, 30);
  if (reason.startsWith("预算耗尽未跑")) return "预算耗尽未跑";
  if (reason.startsWith("空")) return "空";
  if (reason === "ok") return "ok(命中)";
  return "其他:" + reason.slice(0, 30);
}

// ==================== 单源诊断 ====================

const report = { bundle: bundlePath, chain: chainPath, chainRevision: baseChain.chainRevision, sources: {} };

async function runSource(src) {
  console.log(`\n==================== 音源 ${src} ====================`);
  const picker = createHarness();
  await picker.init();
  const { songs, total } = await pickSongs(picker, src, SONG_COUNT);
  console.log(`选曲：${src} 池 ${total} 首，取 ${songs.length} 首（id 去重）`);
  if (songs.length === 0) { console.log(`  ❌ ${src} 未选到歌，跳过`); return null; }

  const res = { songCount: songs.length, songs, pass0: {}, perLine: {} };

  // Pass 0：真实链
  console.log("\n── Pass 0：真实 chain（跨源开）──");
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
        const r = await h.getPlayUrl(src, song, quality);
        let hit = "";
        if (r.ok) {
          try { hit = String(JSON.parse(r.value).line?.id ?? ""); } catch { hit = ""; }
        }
        const kind = r.ok ? (hit.startsWith("cross:") ? hit : (!hit ? `${src}档内(无line)` : hit)) : "整链全灭";
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
    res.pass0 = { counter, rows, totalMiss };
  }

  // 归因：逐线路隔离（关跨源）
  console.log(`\n── 归因：${src} 每条线路单独测（关跨源兜底）──`);
  const perLine = {};
  const rawLines = baseChain.chains[src] ?? [];
  for (const line of rawLines) {
    const variant = {
      ...baseChain,
      crossSources: { wyy: [], qq: [], kw: [], kg: [] },
      chains: { [src]: [line] },
    };
    const h = createHarness();
    await h.init();
    await h.loadChain(variant);
    const perQuality = {};
    for (const quality of TIERS) {
      if (!(line.qualities ?? []).includes(quality)) { perQuality[quality] = { "n/a": true }; continue; }
      let hit = 0, miss = 0;
      const missReasons = {};
      const reasonSamples = {};
      for (const song of songs) {
        const r = await h.getPlayUrl(src, song, quality);
        if (r.ok) { hit++; continue; }
        miss++;
        const lines = parseTrace(r.error);
        if (lines.length === 0) {
          const k = "无trace:" + String(r.error || "error").slice(0, 60);
          missReasons[k] = (missReasons[k] ?? 0) + 1;
          if (!reasonSamples[k]) reasonSamples[k] = `${song.name} → ${String(r.error || "").slice(0, 120)}`;
        } else {
          for (const t of lines) {
            const cat = categorize(t.reason);
            missReasons[cat] = (missReasons[cat] ?? 0) + 1;
            if (!reasonSamples[cat]) reasonSamples[cat] = `${song.name} → ${t.reason}`;
          }
        }
      }
      perQuality[quality] = { hit, miss, reasons: missReasons, samples: reasonSamples };
      console.log(`   ${line.id.padEnd(20)} ${quality.padEnd(5)} 命中 ${String(hit).padStart(2)}/${songs.length}  死因:` +
        (Object.entries(missReasons).map(([k, n]) => `${k}×${n}`).join(" ") || "—"));
    }
    perLine[line.id] = { name: line.name, kind: line.kind, perQuality };
  }
  res.perLine = perLine;

  // 该源汇总
  console.log(`\n=== ${src} 各线路 × 音质 命中率 ===`);
  for (const line of rawLines) {
    const cols = [];
    for (const quality of TIERS) {
      const q = perLine[line.id].perQuality[quality];
      if (!q) continue;
      if (q["n/a"]) { cols.push(`${quality}: N/A`); continue; }
      cols.push(`${quality}: ${q.hit}/${q.hit + q.miss}`);
    }
    console.log(`  ${line.id.padEnd(22)} ${cols.join("   ")}`);
  }
  console.log("");
  for (const quality of TIERS) {
    const agg = {};
    for (const line of rawLines) {
      const q = perLine[line.id].perQuality[quality];
      if (!q || q["n/a"]) continue;
      for (const [k, n] of Object.entries(q.reasons)) agg[k] = (agg[k] ?? 0) + n;
    }
    const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
    console.log(`  ${quality}档 ${src} 死因TOP：` + (sorted.length ? sorted.slice(0, 5).map(([k, n]) => `${k}×${n}`).join("  ") : "（无失败）"));
  }
  report.sources[src] = res;
  return res;
}

// ==================== 主流程 ====================

console.log("=== 多源逐线路失败归因（全音质 128/320/flac）===");
console.log("bundle =", bundlePath, bundleSrc.length, "字符");
console.log("chain  =", chainPath, "（chainRevision", baseChain.chainRevision + "）", " 源：", SOURCES.join(","));

for (const src of SOURCES) {
  await runSource(src);
}

const outPath = `F:/qtMusic/qt-uniappx/.tmp/diag-sources-${SOURCES.join("-")}.json`;
fs.mkdirSync("F:/qtMusic/qt-uniappx/.tmp", { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
console.log(`\n原始数据 → ${outPath}`);
