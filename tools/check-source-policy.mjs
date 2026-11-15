// Real preference, engine service and Android resolver code; storage/native I/O
// are owned adapters. This does not replace HBuilderX compilation or device QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { sourcePolicyFixture } from "./source-policy-fixture.mjs";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const compile = text => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const drain = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
async function check(name, run) { await run(); passed++; console.log("PASS " + name); }
function storage(initial = "") {
  let value = initial;
  const uni = { fail: false, getStorageSync: () => value,
    setStorageSync: (_key, next) => { if (uni.fail) throw Error("disk full"); value = next; } };
  return { uni, api: sourcePolicyFixture(uni), read: () => value };
}
class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return this[key] ?? null; }
  getString(key) { return this.get(key); }
  getNumber(key) { return this.get(key); }
}
function toUTS(value) {
  if (Array.isArray(value)) return value.map(toUTS);
  if (value && typeof value === "object") return new UTSJSONObject(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toUTS(v)])));
  return value;
}
const utsJSON = { parse: text => toUTS(JSON.parse(text)), stringify: JSON.stringify };
function module(path, imports, uni) {
  const exports = {};
  new Function("require", "exports", "JSON", "UTSJSONObject", "uni", compile(read(path)))(
    name => { if (name in imports) return imports[name]; throw Error("missing boundary: " + name); },
    exports, utsJSON, UTSJSONObject, uni,
  );
  return exports;
}

await check("default/all-off, ordering, absent IDs and new platforms keep distinct semantics", () => {
  const { api } = storage();
  assert.deepEqual(plain(api.orderedSourceIds(["wyy", "qq", "kw"])), ["wyy", "qq", "kw"]);
  api.moveSource("kw", ["wyy", "qq", "kw"], -1);
  assert.deepEqual(plain(api.orderedSourceIds(["wyy", "qq", "kw"])), ["wyy", "kw", "qq"]);
  assert.equal(api.sourceEnabled("new"), false);
  api.toggleSource("qq", ["wyy", "qq", "kw"]);
  api.toggleSource("new", ["kw", "new"]);
  assert.deepEqual(plain(api.sourcePolicySnapshot().enabled), ["wyy", "kw", "new"]);
  assert.deepEqual(plain(api.sourcePolicySnapshot().order), ["wyy", "kw", "qq", "new"]);
  api.saveSourcePolicy({ version: 1, enabled: [], order: [] });
  assert.deepEqual(plain(api.orderedSourceIds(["wyy", "new"])), []);
  assert.equal(api.sourceEnabled("local"), true);
  assert.equal(api.sourceEnabled("podcast"), true);
});
await check("storage failure cannot change live settings; snapshots cannot mutate them", () => {
  const { api, uni, read: saved } = storage();
  api.sourcePolicySnapshot(); uni.fail = true;
  assert.throws(() => api.toggleSource("qq", ["qq"]), /disk full/);
  assert.equal(api.sourceEnabled("qq"), true);
  assert.equal(api.sourcePolicyRevision(), 0);
  uni.fail = false; api.toggleSource("qq", ["qq"]);
  api.sourcePolicySnapshot().enabled.push("qq");
  assert.equal(api.sourceEnabled("qq"), false);
  assert.deepEqual(JSON.parse(saved()).enabled, []);
});
await check("corrupt storage closes online sources and ordinary save repairs it", () => {
  const { api } = storage("{broken");
  assert.equal(api.sourceEnabled("wyy"), false);
  assert.match(api.sourcePolicyError(), /无法读取/);
  api.saveSourcePolicy({ version: 1, enabled: ["wyy"], order: ["wyy"] });
  assert.equal(api.sourcePolicyError(), "");
  assert.equal(api.sourceEnabled("wyy"), true);
});

function engine(legacy = false) {
  const prefs = storage();
  const state = { legacy, running: false, context: null, requests: [], calls: [], holdPolicy: false, held: null };
  const finish = (cb, value) => cb({ ok: true, error: "", value: JSON.stringify(value) });
  const native = {
    start(_opts, cb) {
      state.running = true;
      state.context = vm.createContext({ __qtHost: {
        request: async url => { state.requests.push(url); return { statusCode: 200, body: {} }; },
      } });
      cb({ engine: "webview-v8", version: "fixture", hostApiVersion: 1, probe: "2" }, null);
    },
    stop(cb) { state.running = false; cb({ ok: true, error: "" }); },
    isRunning: () => state.running, isHealthy: () => state.running,
    evaluate(code, cb) {
      try { vm.runInContext(code, state.context); cb({ ok: true, value: "null", error: "" }); }
      catch (error) { cb({ ok: false, value: "", error: error.message }); }
    },
    loadBundle(_text, cb) {
      state.context.__qtEntries = state.legacy ? {} : { setSourcePolicy() {} };
      cb({ ok: true, error: "" });
    },
    loadPlayBundle() { throw Error("no playback package in fixture"); },
    invoke(name, args, _timeout, cb) {
      state.calls.push({ name, args: JSON.parse(args) });
      if (name === "bundleInfo") return finish(cb, { name: "meta-bundle", hostApiVersion: 1, sourcePolicyVersion: state.legacy ? 0 : 1 });
      if (name === "setSourcePolicy") {
        if (state.holdPolicy) {
          state.holdPolicy = false; state.held = cb; return;
        }
        return finish(cb, { ok: true, playSupported: null });
      }
      if (name === "sourceRegistry") return finish(cb, { sources: [{ id: "wyy" }, { id: "kw" }], qualities: [] });
      if (name === "search") {
        state.context.__qtHost.request("https://fixture.invalid/search").then(() => finish(cb, { list: [] }),
          error => cb({ ok: false, error: error.message, value: "" }));
        return;
      }
      throw Error("unexpected entry: " + name);
    },
  };
  const header = module("services/source-pack-header.uts", {}, prefs.uni);
  const imports = {
    "@/services/source-policy": prefs.api,
    "@/services/source-pack-header": header,
    "@/uni_modules/qt-js-engine": native,
    "@/services/logger": Object.fromEntries(["logErr", "logErrV", "logInfo", "logWarn", "logWarnV"].map(key => [key, () => {}])),
    "@/services/source-bundle-fs": {
      activePack: () => null, activeMetaPack: () => ({ id: "meta-fixture", kind: "meta", versionCode: 1 }),
      ensureLocalStateRestored: async () => {},
      readPackArtifact: async () => '/*__QT_PACK__{"kind":"meta","id":"meta-fixture","versionCode":1}*/\n//fixture',
      ARTIFACT_CHAIN: "chain.json", ARTIFACT_PLAY: "play-bundle.js", ARTIFACT_META: "meta-bundle.js", PACK_KIND_META: "meta",
    },
  };
  return { ...prefs, state, svc: module("services/source-engine.uts", imports, prefs.uni), finish };
}
await check("engine applies saved preferences before auth replay and blocks disabled data requests", async () => {
  const { api, svc, state } = engine();
  api.saveSourcePolicy({ version: 1, enabled: ["kw"], order: ["kw"] });
  let authSawPolicy = false;
  svc.setMetaAuthHook(() => { authSawPolicy = state.calls.some(call => call.name === "setSourcePolicy"); });
  assert.equal(await svc.ensureDataEngine(), true);
  assert.equal(authSawPolicy, true);
  await assert.rejects(svc.invokeSource("search", '[{"source":"wyy"}]'), /已关闭/);
  await svc.invokeSource("search", '[{"source":"kw"}]');
  assert.equal(state.requests.length, 1);
  api.saveSourcePolicy({ version: 1, enabled: [], order: [] });
  await assert.rejects(svc.invokeSource("search", '[{"source":"kw"}]'), /已关闭/);
  const catalog = JSON.parse(await svc.invokeSource("sourceRegistry", "[]"));
  assert.equal(catalog.sources.length, 2);
  assert.equal(state.requests.length, 1);
});
await check("legacy metadata defaults to all platforms enabled; custom preferences never block its native HTTP path", async () => {
  const { api, svc, state } = engine(true);
  await svc.invokeSource("search", '[{"source":"wyy"}]');
  assert.equal(state.requests.length, 1);
  api.saveSourcePolicy({ version: 1, enabled: ["wyy"], order: ["wyy"] });
  // 包不支持平台总开关：即使存了自定义偏好也按「默认全部开启」放行，不再抛升级错误。
  await svc.invokeSource("search", '[{"source":"wyy"}]');
  await svc.invokeSource("search", '[{"source":"kw"}]');
  await state.context.__qtHost.request("https://fixture.invalid/late");
  assert.equal(state.requests.length, 4);
  assert.equal(api.sourceEnabled("wyy"), true);
  assert.equal(api.sourceEnabled("kw"), true);
  assert.equal(JSON.parse(await svc.invokeSource("sourceRegistry", "[]")).sources.length, 2);
});
await check("old policy acknowledgement after same-package engine reload cannot overwrite new capability state", async () => {
  const { api, svc, state, finish } = engine();
  await svc.ensureDataEngine();
  state.holdPolicy = true;
  api.saveSourcePolicy({ version: 1, enabled: ["kw"], order: ["kw"] });
  await drain();
  const oldReply = state.held;
  assert.equal(typeof oldReply, "function");
  await svc.shutdownEngine();
  assert.equal(await svc.ensureDataEngine(), true);
  assert.equal(svc.sourcePolicyStatus().playSupported, null);
  finish(oldReply, { ok: true, playSupported: false });
  await drain();
  assert.equal(svc.sourcePolicyStatus().playSupported, null);
  assert.equal(svc.sourcePolicyStatus().message, "");
  await svc.invokeSource("search", '[{"source":"kw"}]');
  assert.equal(state.requests.length, 1);
});

function between(text, begin, end) {
  const start = text.indexOf(begin), finish = text.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, begin);
  return text.slice(start, finish);
}
await check("Android address memo rejects stale cross-thread writes without stopping audio", () => {
  const text = read("uni_modules/qt-audio-player/utssdk/app-android/index.uts");
  const code = between(text, "class PendingResolve", "// mediaId → 该条目的磁盘缓存 key") +
    between(text, "class QtResolveResolver", "// ==================== 无缝播放");
  class ConcurrentMap extends Map {
    get(key) { return super.get(key) ?? null; }
    put(key, value) { this.onPut?.(key, value); super.set(key, value); }
    remove(key) { this.delete(key); }
  }
  class Atomic { value = 0; get() { return this.value; } incrementAndGet() { return ++this.value; } }
  class Latch { ready = false; countDown() { this.ready = true; } await() { return this.ready; } }
  let api, resolutions = 0, stops = 0;
  const context = vm.createContext({
    exports: {}, console: { log() {} }, ConcurrentHashMap: ConcurrentMap, AtomicInteger: Atomic,
    CountDownLatch: Latch, IOException: Error, Uri: { parse: value => value },
    RESOLVE_SCHEME: "qt-resolve", RESOLVE_TIMEOUT_SECONDS: 15, TimeUnit: { SECONDS: 1 },
    nativeMediaUri: value => value, gCacheKeyByMid: new ConcurrentMap(), cbResolveRequest: null,
    gPlayer: { stop: () => stops++ },
    QtResolveFire: class { constructor(mid) { this.mid = mid; } },
    getHandler: () => ({ post: task => { resolutions++; api.audioResolveDone(task.mid, "https://fixture.invalid/" + resolutions); } }),
  });
  vm.runInContext(compile(code) + "\nglobalThis.api={...exports,QtResolveResolver,gResolvedUrls,gSourcePolicyGeneration,ResolvedAudioUrl};", context);
  api = context.api;
  const spec = { uri: { getScheme: () => "qt-resolve", getQueryParameter: () => "kw:1", toString: () => "qt-resolve://1" },
    position: 0, buildUpon: () => ({ setUri: url => ({ build: () => ({ url }) }) }) };
  const resolver = new api.QtResolveResolver();
  assert.equal(resolver.resolveDataSpec(spec).url, "https://fixture.invalid/1");
  assert.equal(resolver.resolveDataSpec(spec).url, "https://fixture.invalid/1");
  assert.equal(resolutions, 1);
  api.audioInvalidateSourcePolicy();
  assert.equal(resolver.resolveDataSpec(spec).url, "https://fixture.invalid/2");
  // Emulate a loader put racing with the main-thread clear. The real memo entry
  // keeps the old generation, so the following open must resolve again.
  api.audioInvalidateSourcePolicy();
  api.gResolvedUrls.onPut = () => { api.gResolvedUrls.onPut = null; api.audioInvalidateSourcePolicy(); };
  resolver.resolveDataSpec(spec);
  assert.equal(resolver.resolveDataSpec(spec).url, "https://fixture.invalid/4");
  assert.equal(stops, 0);
});
console.log(`${passed} platform-policy groups passed (production code, synthetic host boundaries)`);
