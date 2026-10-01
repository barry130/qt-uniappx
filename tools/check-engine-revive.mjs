/**
 * 验证 services/source-engine.uts 的「引擎被隔离后自动重建」逻辑。
 *
 * 做法：用 TypeScript 把**真实源文件**转成 CJS，注入假的插件/文件服务，然后驱动
 * ensurePackageLoaded / ensureEngine，观察 stop/start/装载 的调用序列。
 *
 * 用法：node tools/check-engine-revive.mjs
 * 依赖：本仓库未安装 typescript，默认借 qt-pc/node_modules 里的那份。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");
const repoRoot = path.join(appRoot, "..");

/** 依次在 qt-uniappx / qt-pc 里找 typescript（本仓库未安装，qt-pc 有） */
function loadTypeScript() {
  for (const base of [appRoot, path.join(repoRoot, "qt-pc")]) {
    const p = path.join(base, "node_modules", "typescript", "lib", "typescript.js");
    if (fs.existsSync(p)) return createRequire(path.join(base, "noop.js"))(p);
  }
  throw new Error("找不到 typescript：请在 qt-pc 或本仓库安装依赖后再跑本检查");
}
const ts = loadTypeScript();
const FILE = path.join(appRoot, "services", "source-engine.uts");
const src = fs.readFileSync(FILE, "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

// UTSJSONObject.get 的等价物：给 JSON.parse 的结果挂一个 get()
const origParse = JSON.parse;
JSON.parse = (s, ...rest) => {
  const v = origParse(s, ...rest);
  if (v && typeof v === "object" && !Array.isArray(v) && typeof v.get !== "function") {
    Object.defineProperty(v, "get", { value: (k) => (k in v ? v[k] : null), enumerable: false });
  }
  return v;
};

let healthy = true;
const calls = { start: 0, stop: 0, loadBundle: 0, invoke: 0 };

const mods = {
  "@/uni_modules/qt-js-engine": {
    start: (options, cb) => {
      calls.start++;
      healthy = true; // 新引擎是健康的
      cb({ engine: "webview-v8", version: "110.0.5481.154", hostApiVersion: 1, probe: "2" }, null);
    },
    stop: (cb) => {
      calls.stop++;
      cb({ ok: true, error: "" });
    },
    loadBundle: (code, cb) => {
      calls.loadBundle++;
      cb({ ok: true, error: "" });
    },
    invoke: (name, argsJson, timeoutMs, cb) => {
      calls.invoke++;
      cb({ ok: true, value: '{"lines":3}', error: "" });
    },
    isRunning: () => true,
    isHealthy: () => healthy,
  },
  "@/services/source-bundle-fs": {
    installedPackage: () => ({ versionCode: 2026092101, versionName: "2026.09.21.1" }),
    readArtifact: async () => "stub-artifact",
    ensureLocalStateRestored: async () => {},
    ARTIFACT_CHAIN: "chain.json",
    ARTIFACT_BUNDLE: "source-bundle.js",
  },
};

const mod = { exports: {} };
new Function("require", "module", "exports", js)(
  (id) => {
    if (mods[id]) return mods[id];
    throw new Error("未预料的 import：" + id);
  },
  mod,
  mod.exports,
);
const svc = mod.exports;

// 可控时钟
let fakeNow = 1_000_000;
Date.now = () => fakeNow;
const advance = (ms) => {
  fakeNow += ms;
};

const snap = () => `start=${calls.start} stop=${calls.stop} loadBundle=${calls.loadBundle}`;
let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`  ${cond ? "OK  " : "FAIL"} ${label}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

console.log("=".repeat(70));
console.log("场景 1：冷启动 → 装载");
console.log("=".repeat(70));
let r = await svc.ensurePackageLoaded();
check("首次装载成功", r === true, snap());
check("启动 1 次 / 未 stop", calls.start === 1 && calls.stop === 0);
check("引擎状态 ready", svc.engineStatus() === "ready");

console.log("");
console.log("=".repeat(70));
console.log("场景 2：健康态重复调用 → 不重启");
console.log("=".repeat(70));
const before = snap();
r = await svc.ensurePackageLoaded();
check("仍然可用", r === true, snap());
check("无额外 start/stop", snap() === before, `${before} → ${snap()}`);

console.log("");
console.log("=".repeat(70));
console.log("场景 3：引擎被 poison → 自动重建 + 重新装载");
console.log("=".repeat(70));
healthy = false; // 模拟插件侧 poison
advance(60_000); // 越过最小重建间隔
r = await svc.ensurePackageLoaded();
check("重建后恢复可用", r === true, snap());
check("stop 1 次 + start 2 次", calls.stop === 1 && calls.start === 2, snap());
check("bundle 被重新装载", calls.loadBundle === 2, snap());
check("引擎状态 ready", svc.engineStatus() === "ready");
check("isHealthy 已恢复（假插件在新引擎上置 true）", svc.engineUsable() === true);

console.log("");
console.log("=".repeat(70));
console.log("场景 4：短时间内再次 poison → 被最小间隔拦住（不重建风暴）");
console.log("=".repeat(70));
healthy = false;
advance(5_000); // < MIN_REVIVE_INTERVAL_MS(20s)
const b4 = snap();
r = await svc.ensurePackageLoaded();
check("本次拒绝重建（返回 false）", r === false, snap());
check("未发生 stop/start", snap() === b4, `${b4} → ${snap()}`);

console.log("");
console.log("=".repeat(70));
console.log("场景 5：滑动窗口限流（10 分钟内最多 3 次重建）");
console.log("=".repeat(70));
for (let i = 0; i < 3; i++) {
  healthy = false;
  advance(60_000);
  r = await svc.ensurePackageLoaded();
  console.log(`     第 ${i + 2} 次重建尝试 → ${r ? "重建成功" : "被限流"}  ${snap()}`);
}
check("窗口内重建次数封顶在 3", calls.stop === 3, `stop=${calls.stop}`);
check("限流后不再无限重建", calls.start === 4, `start=${calls.start}`);
check("限流时给出可读原因", svc.lastEngineError().includes("已暂停自动重建"), svc.lastEngineError());
console.log("");
console.log("=".repeat(70));
console.log("场景 6：手动重启引擎 → 限流窗口清零，恢复自动重建");
console.log("=".repeat(70));
await svc.shutdownEngine();
healthy = false;
advance(1_000);
r = await svc.ensurePackageLoaded();
check("手动重启后可再次自动重建", r === true, snap());
check("stop 4 次 + start 5 次", calls.stop === 4 && calls.start === 5, snap());

console.log("");
console.log("=".repeat(70));
console.log(fails === 0 ? "全部通过 ✅" : `有 ${fails} 项失败 ❌`);
console.log("=".repeat(70));
process.exit(fails === 0 ? 0 : 1);
