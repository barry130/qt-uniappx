// Production daily entry points in Node VM; only device storage/events and the
// official account SDK boundary are owned fixtures. No network or credentials.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return Object.hasOwn(this, key) ? this[key] : null; }
  getString(key) { return typeof this[key] === "string" ? this[key] : null; }
  getNumber(key) { return typeof this[key] === "number" ? this[key] : null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}
function toUTS(value) { return Array.isArray(value) ? value.map(toUTS) : value != null && typeof value === "object" ? new UTSJSONObject(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toUTS(item)]))) : value; }
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const song = (id, source = "wyy") => ({ id, name: "Official " + id, singer: "Same singer", album: "Official album", picUrl: "", platform: source, duration: 0, durationReliable: false, musicId: "opaque:" + id, version: "", isrc: "" });
let passed = 0;
async function check(name, run) { await run(); passed++; console.log("PASS " + name); }

function fixture(options = {}) {
  const storage = options.core?.storage ?? new Map(), events = new Map(), logs = [];
  const state = {
    now: new Date(2026, 10, 12, 10, 0, 0).getTime(),
    choice: { daily: { origin: "account", sourceId: "wyy" }, fm: { origin: "app", sourceId: "" } },
    revision: { daily: 0, fm: 0 },
    context: { sourceId: "wyy", kind: "daily", accountId: "account-A", nickname: "Fixture listener", accountSession: "session-A", authRevision: 1, metaAuthRevision: 1, metaRevision: "meta-A", policyRevision: 0, engineEpoch: "engine-A" },
    current: true, official: [song("opaque-2"), song("opaque-1"), song("opaque-2")],
    fetchedAt: null, expiresAt: undefined, prepareGate: null, fetchGate: null, fetches: 0,
    prepareStarted: deferred(), fetchStarted: deferred(), fetchError: null, metaEnabled: true,
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [options.core?.state.now ?? state.now])); }
    static now() { return options.core?.state.now ?? state.now; }
  }
  const uni = options.core?.uni ?? {
    getStorageSync: key => { const value = storage.get(key) ?? ""; state.onStorageRead?.(key); return value; },
    setStorageSync: (key, value) => { state.onStorageWrite?.(key, value); storage.set(key, value); },
    removeStorageSync: key => storage.delete(key),
    $on: (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    $off: (name, fn) => events.get(name)?.delete(fn),
    $emit: (name, ...args) => { for (const fn of events.get(name) ?? []) fn(...args); },
  };
  let choiceApi; // Loaded from the production Pinia business store below.
  const accountApi = {
    prepareAccountRecommendationContext: async (sourceId, kind) => {
      const context = { ...state.context };
      state.prepareStarted.resolve();
      if (state.prepareGate) await state.prepareGate.promise;
      if (!state.current || !state.metaEnabled || sourceId !== context.sourceId || kind !== "daily") throw Error("fixture unavailable");
      return context;
    },
    accountRecommendationContextCurrent: context => {
      state.onContextCheck?.(); // Owned SDK/time boundary can model validation/read latency.
      return state.current && state.metaEnabled && ["sourceId", "kind", "accountId", "accountSession", "authRevision", "metaAuthRevision", "metaRevision", "policyRevision", "engineEpoch"].every(key => context[key] === state.context[key]);
    },
    fetchAccountDailySongs: async context => {
      state.fetches++;
      state.fetchStarted.resolve();
      if (state.fetchError) throw state.fetchError;
      if (state.fetchGate) return state.fetchGate.promise;
      return { source: context.sourceId, accountId: context.accountId, kind: "daily", items: plain(state.official), fetchedAt: state.fetchedAt ?? state.now, ...(state.expiresAt === undefined ? {} : { expiresAt: state.expiresAt }) };
    },
    accountRecommendationErrorMessage: () => "账号每日推荐暂时不可用，请重新登录或稍后重试。",
  };
  const forbidden = name => () => { throw Error("account path must not use " + name); };
  const boundary = names => Object.fromEntries(names.map(name => [name, forbidden(name)]));
  const mocks = {
    "services/account-recommendation.ts": accountApi,
    "services/http.ts": { parseJsonToUtso: text => toUTS(JSON.parse(text)) },
    "services/source-auth.ts": { SOURCE_AUTH_CHANGED_EVENT: "qt-source-auth-changed" },
    "services/source-update.ts": { SOURCE_PACKS_CHANGED_EVENT: "qt-source-packs-changed" },
    "services/music-api.ts": { musicApi: new Proxy({}, { get: (_target, key) => forbidden("musicApi." + String(key)) }) },
    "services/aggregate-sources.ts": boundary(["readAggregateSources"]),
    "services/recommend-dimensions.ts": boundary(["collectDimensionLanes", "interleaveByLanes", "laneCoverage"]),
    "services/music-style.ts": boundary(["buildStyleProfile", "describeProfile", "trackQuality", "trackStyle"]),
    "services/recommend-rank.ts": boundary(["reasonFor", "scoreCandidates", "selectDiverse"]),
    "services/ai-server-picks.ts": boundary(["askServerForPicks"]),
    "services/ai-providers.ts": { ...boundary(["aiLocalChat"]), activeProfile: () => null },
    "services/recommend-types.ts": boundary(["durationBandLabel", "musicLangLabel", "numAt"]),
    "stores/dislikes.ts": boundary(["useDislikesStore"]),
    "stores/listen-stats.ts": boundary(["useListenStatsStore"]),
    "stores/player.ts": boundary(["usePlayerStore"]),
    "stores/source-registry.ts": boundary(["useSourceRegistryStore"]),
    "stores/source.ts": boundary(["useSourceStore"]),
    vue: { ref: value => ({ value }) },
    pinia: { createPinia: () => ({}), defineStore: (_id, definition) => {
      const instances = new WeakMap();
      return pinia => { if (!instances.has(pinia)) instances.set(pinia, definition.state()); return instances.get(pinia); };
    } },
  };
  if (options.application) {
    // Real preference/ranking code; playback persistence and music SDK I/O are
    // system-boundary adapters, not replacements for the recommendation logic.
    for (const path of ["services/music-style.ts", "services/recommend-rank.ts", "services/recommend-types.ts", "services/recommend-dimensions.ts"]) delete mocks[path];
    state.applicationSongs = [song("app-1", "local"), song("app-2", "local"), song("app-1", "local")];
    const player = { history: [], likedSongs: [], localPlaylists: [], savedPlaylists: [] };
    mocks["stores/player.ts"] = { usePlayerStore: () => player };
    mocks["stores/dislikes.ts"] = { useDislikesStore: () => ({ rules: [], isDisliked: () => false }) };
    mocks["stores/listen-stats.ts"] = { useListenStatsStore: () => ({ songs: [] }) };
    mocks["stores/source.ts"] = { useSourceStore: () => ({ current: "local" }) };
    mocks["stores/source-registry.ts"] = { useSourceRegistryStore: () => ({ ensure: async () => {}, entries: [] }) };
    mocks["services/aggregate-sources.ts"] = { readAggregateSources: () => [] };
    mocks["services/music-api.ts"] = { musicApi: { allLatest: async () => plain(state.applicationSongs), playlistCategories: async () => [], searchPageMaxOf: () => 100 } };
  }
  if (options.core) {
    mocks["services/account-recommendation.ts"] = options.core.service;
    mocks["stores/recommendation-source.ts"] = options.core.choice;
  }
  const modules = new Map();
  function resolve(from, name) {
    if (name === "vue" || name === "pinia") return name;
    const path = name.startsWith("@/") ? name.slice(2) : new URL(name, "file:///" + from).pathname.slice(1);
    return /\.(?:ts|uts)$/.test(path) ? path : path + ".ts";
  }
  function load(path) {
    if (path in mocks) return mocks[path];
    if (modules.has(path)) return modules.get(path);
    const text = readFileSync(new URL("../" + path, import.meta.url), "utf8");
    let code = stripTypeScriptTypes(text, { mode: "strip", sourceUrl: path });
    const names = [...code.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/gm)].map(match => match[1]);
    const deps = [];
    code = code.replace(/^import\s+\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];?/gm, (_all, names, name) => {
      const index = deps.push(load(resolve(path, name))) - 1;
      return `const {${names.replace(/\bas\b/g, ":")}} = __deps[${index}];`;
    }).replace(/^export\s+/gm, "");
    const context = vm.createContext({ uni, Date: Clock, UTSJSONObject, __deps: deps, console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
    const api = vm.runInContext(code + `\n({${names.join(",")}})`, context, { filename: path });
    modules.set(path, api);
    return api;
  }
  choiceApi = load("stores/recommendation-source.ts");
  choiceApi.writeRecommendationChoice("daily", options.application ? { origin: "app", sourceId: "" } : { origin: "account", sourceId: "wyy" });
  const api = load("services/daily-recommend.ts");
  return { api, state, storage, uni, logs, choiceApi, accountApi, load, deferred };
}

await check("selected account daily preserves official order, duplicates and optional fields without app/AI supply", async () => {
  const f = fixture();
  const result = await f.api.generateDailyRecommend({ force: true, mode: "server", taste: "explore" });
  assert.equal(result.origin, "account");
  assert.equal(result.sourceId, "wyy");
  assert.equal(result.accountId, "account-A");
  assert.deepEqual(plain(result.items.map(item => item.song)), f.state.official);
  assert.equal(result.profileText, null);
  assert.equal(result.model, null);
  assert.equal(f.storage.has("dailyRecommend.cache"), false);
});
const ACCOUNT_CACHE = "accountDailyRecommend.cache";
const APP_CACHE = "dailyRecommend.cache";
const lateBatch = f => ({ source: "wyy", kind: "daily", accountId: "account-A", items: [song("late")], fetchedAt: f.state.now });
const legacyResult = () => ({ date: "2026-11-12", mode: "rule", requested: "local", taste: null, generatedAt: 1794450000000,
  title: "Legacy rule result", summary: "Legacy", items: [{ song: song("legacy"), reason: "legacy reason" }], notice: "Legacy local-model fallback",
  profileText: null, model: null, styleLanes: [], coldStart: false, styleOptions: [], styleSeeds: [] });

await check("account cache hits ignore app mode/taste and do not refetch or pollute the application history cache", async () => {
  const f = fixture(), app = JSON.stringify({ v: 10, days: [{ date: "2026-11-11", mode: "rule", keys: ["wyy:old"] }], today: legacyResult() });
  f.storage.set(APP_CACHE, app);
  await f.api.generateDailyRecommend({ force: true });
  const cached = await f.api.loadTodayResult("local", "explore");
  assert.equal(cached.origin, "account");
  assert.deepEqual(plain(cached.items.map(item => item.song.id)), ["opaque-2", "opaque-1", "opaque-2"]);
  await f.api.generateDailyRecommend({ mode: "server", taste: "familiar" });
  assert.equal(f.state.fetches, 1);
  assert.equal(f.storage.get(APP_CACHE), app);
});

await check("legacy app requested-mode/taste/version/date rules remain unchanged and cached app generation stays app", async () => {
  const f = fixture(); f.choiceApi.writeRecommendationChoice("daily", { origin: "app", sourceId: "" });
  const result = legacyResult(), cache = { v: 10, days: [], today: result };
  f.storage.set(APP_CACHE, JSON.stringify(cache));
  assert.deepEqual(plain(await f.api.loadTodayResult("local", "heart")), result);
  assert.deepEqual(plain(await f.api.generateDailyRecommend({ mode: "local", taste: "heart" })), result);
  assert.equal(await f.api.loadTodayResult("server", "heart"), null);
  assert.equal(await f.api.loadTodayResult("local", "explore"), null);
  f.storage.set(APP_CACHE, JSON.stringify({ ...cache, v: 9 }));
  assert.equal(await f.api.loadTodayResult(), null);
  f.storage.set(APP_CACHE, JSON.stringify({ ...cache, today: { ...result, date: "2026-11-11" } }));
  assert.equal(await f.api.loadTodayResult(), null);
  assert.equal(f.state.fetches, 0);
});

await check("clearTodayResult clears only the selected cache and retains application cross-day history", async () => {
  const f = fixture(), app = JSON.stringify({ v: 10, days: [{ date: "2026-11-11", mode: "rule", keys: ["wyy:old"] }], today: legacyResult() });
  f.storage.set(APP_CACHE, app);
  await f.api.generateDailyRecommend({ force: true });
  const account = f.storage.get(ACCOUNT_CACHE);
  await f.api.clearTodayResult();
  assert.equal(f.storage.has(ACCOUNT_CACHE), false);
  assert.equal(f.storage.get(APP_CACHE), app);
  f.choiceApi.writeRecommendationChoice("daily", { origin: "app", sourceId: "" });
  f.storage.set(ACCOUNT_CACHE, account);
  await f.api.clearTodayResult();
  assert.equal(f.storage.get(ACCOUNT_CACHE), account);
  assert.deepEqual(JSON.parse(f.storage.get(APP_CACHE)), { v: 10, days: [{ date: "2026-11-11", mode: "rule", keys: ["wyy:old"] }], today: null });
});

await check("expiry is strict at the boundary, absent expiry is day-scoped, and source precision is preserved", async () => {
  const f = fixture(); f.state.fetchedAt = 1794448800123.25; f.state.expiresAt = f.state.now + 1000.5;
  const fresh = await f.api.generateDailyRecommend({ force: true });
  assert.equal(fresh.generatedAt, 1794448800123.25);
  assert.equal(JSON.parse(f.storage.get(ACCOUNT_CACHE)).expiresAt, f.state.now + 1000.5);
  f.state.now += 1000.5;
  assert.equal(await f.api.loadTodayResult(), null);
  assert.equal(f.storage.has(ACCOUNT_CACHE), false);
  await assert.rejects(f.api.generateDailyRecommend({ force: true }), /过期|时间/);
  f.state.expiresAt = undefined;
  await f.api.generateDailyRecommend({ force: true });
  f.state.now = new Date(2026, 10, 13, 0, 0, 0).getTime();
  assert.equal(await f.api.loadTodayResult(), null);
});

await check("source, account, session, authorization, meta package, policy and engine identities independently invalidate cached results", async () => {
  const cases = [
    ["sourceId", "qq"], ["accountId", "account-B"], ["accountSession", "session-B"],
    ["authRevision", 2], ["metaAuthRevision", 2], ["metaRevision", "meta-B"],
    ["policyRevision", 1], ["engineEpoch", "engine-B"],
  ];
  for (const [key, next] of cases) {
    const f = fixture(); await f.api.generateDailyRecommend({ force: true });
    f.state.context[key] = next;
    assert.equal(await f.api.loadTodayResult(), null, key);
    assert.equal(f.storage.has(ACCOUNT_CACHE), false, key);
  }
});

await check("logout/meta-off/package/policy events purge invalid cache, but play-only and FM choice changes do not", async () => {
  for (const [event, change] of [
    ["qt-source-auth-changed", f => { f.state.current = false; }],
    ["qt-source-auth-changed", f => { f.state.metaEnabled = false; f.state.context.metaAuthRevision++; }],
    ["qt-source-packs-changed", f => { f.state.context.metaRevision = "meta-B"; }],
    ["qt-source-policy-changed", f => { f.state.context.policyRevision++; }],
  ]) {
    const f = fixture(); await f.api.generateDailyRecommend({ force: true }); change(f); f.uni.$emit(event);
    assert.equal(f.storage.has(ACCOUNT_CACHE), false, event);
  }
  const f = fixture(); await f.api.generateDailyRecommend({ force: true });
  const before = f.storage.get(ACCOUNT_CACHE);
  f.uni.$emit("qt-source-auth-changed"); // play-only: meta context is unchanged
  f.choiceApi.writeRecommendationChoice("fm", { origin: "account", sourceId: "qq" });
  assert.equal(f.storage.get(ACCOUNT_CACHE), before);
  assert.equal((await f.api.loadTodayResult()).origin, "account");
});

await check("daily A→B→A choice change rejects an older official response and cannot reuse its cache", async () => {
  const f = fixture(), gate = deferred(); f.state.fetchGate = gate;
  const pending = f.api.generateDailyRecommend({ force: true });
  const rejected = assert.rejects(pending, /来源|替代/);
  await f.state.fetchStarted.promise;
  f.choiceApi.writeRecommendationChoice("daily", { origin: "app", sourceId: "" });
  f.choiceApi.writeRecommendationChoice("daily", { origin: "account", sourceId: "wyy" });
  gate.resolve(lateBatch(f)); await rejected;
  assert.equal(await f.api.loadTodayResult(), null);
  assert.equal(f.storage.has(ACCOUNT_CACHE), false);
  assert.equal(f.storage.has(APP_CACHE), false);
});

await check("each changed context rejects a pending official response, including account/meta off→on A→B→A", async () => {
  for (const key of ["accountId", "accountSession", "authRevision", "metaAuthRevision", "metaRevision", "policyRevision", "engineEpoch"]) {
    const f = fixture(), gate = deferred(); f.state.fetchGate = gate;
    const pending = f.api.generateDailyRecommend({ force: true }), rejected = assert.rejects(pending, /账号|授权/);
    await f.state.fetchStarted.promise;
    f.state.context[key] = typeof f.state.context[key] === "number" ? f.state.context[key] + 1 : "changed";
    gate.resolve(lateBatch(f)); await rejected;
    assert.equal(f.storage.has(ACCOUNT_CACHE), false, key);
  }
  const f = fixture(), gate = deferred(); f.state.fetchGate = gate;
  const pending = f.api.generateDailyRecommend({ force: true }), rejected = assert.rejects(pending, /账号|授权/);
  await f.state.fetchStarted.promise;
  f.state.context.accountId = "account-B"; f.state.context.accountSession = "session-B"; f.state.context.authRevision++;
  f.state.context.accountId = "account-A"; f.state.context.accountSession = "session-A"; f.state.context.authRevision++;
  f.state.metaEnabled = false; f.state.context.metaAuthRevision++; f.state.metaEnabled = true; f.state.context.metaAuthRevision++;
  gate.resolve(lateBatch(f)); await rejected;
  assert.equal(f.storage.has(ACCOUNT_CACHE), false);
});

await check("prepare/ACK and local-day changes never allow stale official dispatch or cached return", async () => {
  const f = fixture(), gate = deferred(); f.state.prepareGate = gate;
  const pending = f.api.generateDailyRecommend({ force: true }), rejected = assert.rejects(pending, /来源|替代/);
  await f.state.prepareStarted.promise;
  f.choiceApi.writeRecommendationChoice("daily", { origin: "app", sourceId: "" });
  gate.resolve(); await rejected;
  assert.equal(f.state.fetches, 0);
  const g = fixture(), fetchGate = deferred(); g.state.fetchGate = fetchGate;
  const oldDay = g.api.generateDailyRecommend({ force: true }), rejectedDay = assert.rejects(oldDay, /日期/);
  await g.state.fetchStarted.promise;
  g.state.now = new Date(2026, 10, 13, 0, 0, 0).getTime();
  fetchGate.resolve(lateBatch(g)); await rejectedDay;
  assert.equal(g.storage.has(ACCOUNT_CACHE), false);
});

await check("clear/newer generation supersedes a pending account response without overwriting the new result", async () => {
  const f = fixture(), gate = deferred(); f.state.fetchGate = gate;
  const pending = f.api.generateDailyRecommend({ force: true }), rejected = assert.rejects(pending, /替代/);
  await f.state.fetchStarted.promise; await f.api.clearTodayResult(); gate.resolve(lateBatch(f)); await rejected;
  assert.equal(f.storage.has(ACCOUNT_CACHE), false);
  const g = fixture(), oldGate = deferred(); g.state.fetchGate = oldGate;
  const old = g.api.generateDailyRecommend({ force: true }), rejectedOld = assert.rejects(old, /替代/);
  await g.state.fetchStarted.promise;
  g.state.fetchGate = null; g.state.official = [song("new")];
  await g.api.generateDailyRecommend({ force: true }); oldGate.resolve(lateBatch(g)); await rejectedOld;
  assert.deepEqual(plain((await g.api.loadTodayResult()).items.map(item => item.song.id)), ["new"]);
});

await check("empty, unauthorized and SDK-error account supply never falls back to app or anonymous recommendations", async () => {
  const f = fixture(); f.state.official = [];
  const empty = await f.api.generateDailyRecommend({ force: true });
  assert.equal(empty.origin, "account"); assert.deepEqual(plain(empty.items), []); assert.match(empty.notice, /未切换/);
  assert.deepEqual(plain((await f.api.loadTodayResult()).items), []);
  f.state.current = false;
  await assert.rejects(f.api.generateDailyRecommend({ force: true }), /账号每日推荐暂时不可用/);
  assert.equal(await f.api.loadTodayResult(), null);
  const g = fixture(); g.state.fetchError = Error("untrusted Cookie=FORBIDDEN_RAW_FIELD_FIXTURE");
  await assert.rejects(g.api.generateDailyRecommend({ force: true }), error => !/FORBIDDEN_RAW_FIELD_FIXTURE|Cookie/.test(error.message));
  assert.equal(g.storage.has(APP_CACHE), false); assert.equal(g.storage.has(ACCOUNT_CACHE), false);
});

await check("cache stores only public song fields and independent identity tokens, never raw credential fields or errors", async () => {
  const f = fixture(); f.state.context.cookie = "FORBIDDEN_RAW_FIELD_FIXTURE";
  f.state.context.extrasJson = "FORBIDDEN_RAW_FIELD_FIXTURE";
  f.state.official[0].Cookie = "FORBIDDEN_RAW_FIELD_FIXTURE";
  const result = await f.api.generateDailyRecommend({ force: true });
  assert.equal("Cookie" in result.items[0].song, false);
  const raw = f.storage.get(ACCOUNT_CACHE);
  assert.equal(/cookie|extrasJson|nickname|FORBIDDEN_RAW_FIELD_FIXTURE/i.test(raw), false);
  assert.equal(JSON.stringify(f.logs).includes("FORBIDDEN_RAW_FIELD_FIXTURE"), false);
  assert.deepEqual(Object.keys(JSON.parse(raw).identity).sort(), ["accountId", "accountSession", "authRevision", "engineEpoch", "kind", "metaAuthRevision", "metaRevision", "policyRevision", "sourceId"].sort());
});

await check("corrupt cache is a miss and changing selection in onProgress blocks official dispatch", async () => {
  for (const bad of ["{broken", "[]", "null", JSON.stringify({ v: 1, identity: [], items: [] })]) {
    const f = fixture(); f.storage.set(ACCOUNT_CACHE, bad);
    assert.equal(await f.api.loadTodayResult(), null);
    assert.equal(f.storage.has(ACCOUNT_CACHE), false);
  }
  const f = fixture();
  await assert.rejects(f.api.generateDailyRecommend({ force: true, onProgress: () => f.choiceApi.writeRecommendationChoice("daily", { origin: "app", sourceId: "" }) }), /来源|替代/);
  assert.equal(f.state.fetches, 0);
});
await check("application force generation still runs its real cold-start/profile/ranking algorithm and writes only app cache", async () => {
  const f = fixture({ application: true });
  const result = await f.api.generateDailyRecommend({ force: true, mode: "server", taste: "heart" });
  assert.notEqual(result.origin, "account");
  assert.equal(result.coldStart, true);
  assert.equal(result.mode, "rule");
  assert.equal(result.requested, "server");
  assert.deepEqual(plain(result.items.map(item => item.song.id)).sort(), ["app-1", "app-2"]);
  assert.equal(f.state.fetches, 0);
  assert.equal(f.storage.has(ACCOUNT_CACHE), false);
  assert.deepEqual(JSON.parse(f.storage.get(APP_CACHE)).today.items.map(item => item.song.id).sort(), ["app-1", "app-2"]);
});

await check("application save read/write boundary rejects A→B→A selection changes and preserves old app cache", async () => {
  const f = fixture({ application: true }), before = JSON.stringify({ v: 10, days: [], today: legacyResult() });
  f.storage.set(APP_CACHE, before);
  let saving = false, changed = false;
  f.state.onStorageRead = key => {
    if (key !== APP_CACHE || !saving || changed) return;
    changed = true;
    queueMicrotask(() => {
      f.choiceApi.writeRecommendationChoice("daily", { origin: "account", sourceId: "wyy" });
      f.choiceApi.writeRecommendationChoice("daily", { origin: "app", sourceId: "" });
    });
  };
  await assert.rejects(f.api.generateDailyRecommend({ force: true, mode: "rule", taste: "heart", onProgress: text => { if (text === "正在排除屏蔽与重复…") saving = true; } }), /来源/);
  assert.equal(changed, true);
  assert.equal(f.storage.get(APP_CACHE), before);
  assert.equal(f.storage.has(ACCOUNT_CACHE), false);
});

await check("legacy application cache read cannot return through a changed selection after its await", async () => {
  const f = fixture({ application: true });
  f.storage.set(APP_CACHE, JSON.stringify({ v: 10, days: [], today: legacyResult() }));
  f.state.onStorageRead = key => { if (key === APP_CACHE) queueMicrotask(() => f.choiceApi.writeRecommendationChoice("daily", { origin: "account", sourceId: "wyy" })); };
  assert.equal(await f.api.loadTodayResult("local", "heart"), null);
});
await check("finite mapped source values and explicitly supplied musicId:null remain distinct from absence in fresh and cached results", async () => {
  const f = fixture(); f.state.fetchedAt = 0;
  f.state.official[0].musicId = null;
  f.state.official[1].duration = -1;
  delete f.state.official[2].musicId;
  const result = await f.api.generateDailyRecommend({ force: true });
  assert.equal(result.generatedAt, 0);
  assert.deepEqual(plain(result.items.map(item => item.song)), f.state.official);
  assert.deepEqual(plain((await f.api.loadTodayResult()).items.map(item => item.song)), f.state.official);
});
await check("account cache has a receiving-time TTL of at most 30 minutes even without upstream expiry", async () => {
  const f = fixture(); f.state.fetchedAt = f.state.now + 24 * 60 * 60 * 1000;
  await f.api.generateDailyRecommend({ force: true });
  f.state.now += 30 * 60 * 1000 - 0.25;
  assert.equal((await f.api.loadTodayResult()).origin, "account");
  f.state.now += 0.25;
  assert.equal(await f.api.loadTodayResult(), null);
  f.state.official = [song("refetched")];
  assert.deepEqual(plain((await f.api.generateDailyRecommend()).items.map(item => item.song.id)), ["refetched"]);
  assert.equal(f.state.fetches, 2);
  const g = fixture(); g.state.expiresAt = g.state.now + 6 * 60 * 60 * 1000 + 0.125;
  const expiry = g.state.expiresAt; await g.api.generateDailyRecommend({ force: true });
  assert.equal(JSON.parse(g.storage.get(ACCOUNT_CACHE)).expiresAt, expiry);
  g.state.now += 30 * 60 * 1000;
  assert.equal(await g.api.loadTodayResult(), null);
});

await check("unknown URL/playback extensions are stripped and invalid supplied mapped fields reject the whole batch", async () => {
  const f = fixture(); Object.assign(f.state.official[0], { url: "https://owned.invalid/track?token=FORBIDDEN_RAW_FIELD_FIXTURE", urlFetchedAt: 123, urlSourcePolicy: "raw", likeSeq: 4, pids: ["raw-playlist"] });
  const result = await f.api.generateDailyRecommend({ force: true });
  for (const field of ["url", "urlFetchedAt", "urlSourcePolicy", "likeSeq", "pids"]) assert.equal(field in result.items[0].song, false, field);
  assert.equal(f.storage.get(ACCOUNT_CACHE).includes("FORBIDDEN_RAW_FIELD_FIXTURE"), false);
  for (const [field, bad] of [["duration", "1"], ["duration", NaN], ["musicId", 1], ["version", false], ["isrc", null], ["durationReliable", "false"]]) {
    const g = fixture(); g.state.official[1][field] = bad;
    await assert.rejects(g.api.generateDailyRecommend({ force: true }), /数据无效/);
    assert.equal(g.storage.has(ACCOUNT_CACHE), false, field);
  }
});

await check("account context is guarded again at the public daily return boundary, not only inside the cache writer", async () => {
  const f = fixture();
  f.state.onStorageWrite = key => {
    if (key === ACCOUNT_CACHE) queueMicrotask(() => { f.state.metaEnabled = false; f.state.context.metaAuthRevision++; f.uni.$emit("qt-source-auth-changed"); });
  };
  await assert.rejects(f.api.generateDailyRecommend({ force: true }), /账号|授权/);
  assert.equal(f.storage.has(ACCOUNT_CACHE), false);
});
const { accountRecommendationFixture, rawSong, drain } = await import("./check-account-recommendations.mjs");
const officialCalls = core => core.state.calls.filter(call => call.name === "accountDailySongs");

await check("real auth/engine/registry/core/choice interoperate with public daily APIs, preserving official duplicates, null and finite values", async () => {
  for (const source of ["wyy", "kg"]) {
    const core = accountRecommendationFixture(); await core.ready(); await core.saveAccount(source, "listener-A");
    const raw = [{ ...rawSong("opaque:/2"), interval: -0.125, musicId: null, version: "", isrc: "", durationReliable: false }, rawSong("opaque:/1"), { ...rawSong("opaque:/2"), interval: 0 }];
    core.state.batch = (source, kind, accountId) => ({ source, kind, accountId, items: raw, fetchedAt: 0, cursor: "", exhausted: false });
    const f = fixture({ core }); f.choiceApi.writeRecommendationChoice("daily", { origin: "account", sourceId: source });
    const result = await f.api.generateDailyRecommend({ force: true, mode: "server", taste: "explore" });
    assert.equal(result.sourceId, source); assert.equal(result.accountId, "listener-A"); assert.equal(result.accountNickname, "用户listener-A"); assert.equal(result.generatedAt, 0);
    assert.deepEqual(plain(result.items.map(item => item.song.id)), ["opaque:/2", "opaque:/1", "opaque:/2"]);
    assert.equal(result.items[0].song.musicId, null); assert.equal(result.items[0].song.duration, -0.125); assert.equal("musicId" in result.items[1].song, false);
    assert.deepEqual(plain((await f.api.loadTodayResult("local", "heart")).items), plain(result.items)); assert.equal(officialCalls(core).length, 1);
    await core.auth.setSourceAuthToggle(source, "play", true); await core.auth.setSourceAuthToggle(source, "play", false);
    assert.equal((await f.api.loadTodayResult()).origin, "account"); assert.equal(officialCalls(core).length, 1);
    await core.auth.setSourceAuthToggle(source, "meta", false);
    assert.equal(await f.api.loadTodayResult(), null); assert.equal(f.storage.has(ACCOUNT_CACHE), false);
    assert.equal(f.storage.has(APP_CACHE), false); assert.equal((f.storage.get(ACCOUNT_CACHE) ?? "").includes("FIXTURE_META="), false);
  }
});

await check("known official auth/mismatch/network refresh failures invalidate prior account cache without app fallback", async () => {
  for (const code of ["AUTH_EXPIRED", "ACCOUNT_MISMATCH", "NETWORK"]) {
    const core = accountRecommendationFixture(); await core.ready(); await core.saveAccount();
    const f = fixture({ core }); await f.api.generateDailyRecommend({ force: true });
    const publicCache = JSON.stringify({ v: 10, days: [], today: legacyResult() }); f.storage.set(APP_CACHE, publicCache);
    core.hold("accountDailySongs");
    const rejected = assert.rejects(f.api.generateDailyRecommend({ force: true }), /账号|身份|平台|登录/);
    await drain(); const pending = core.pending("accountDailySongs"); assert.ok(pending, "fresh official refresh really dispatched");
    core.fail(pending, "ACCOUNT_RECOMMENDATIONS_" + code + ": owned-raw-error"); await rejected;
    assert.equal(await f.api.loadTodayResult(), null); assert.equal(f.storage.has(ACCOUNT_CACHE), false); assert.equal(f.storage.get(APP_CACHE), publicCache);
    assert.equal(officialCalls(core).length, 2);
  }
});

await check("daily choice/clear callbacks reach real engine readiness and policy pre-dispatch guards", async () => {
  for (const phase of ["ready-choice", "ready-clear", "policy-choice"]) {
    const core = accountRecommendationFixture(); await core.ready(); await core.saveAccount();
    const f = fixture({ core });
    if (phase === "policy-choice") { core.hold("setSourcePolicy"); core.policy.toggleSource("qq", ["wyy", "kg", "qq"]); await drain(); assert.ok(core.pending("setSourcePolicy")); }
    const rejected = assert.rejects(f.api.generateDailyRecommend({ force: true, onProgress: () => { if (phase !== "policy-choice") core.state.restoreGate = deferred(); } }), /来源|替代/);
    await drain(); assert.equal(officialCalls(core).length, 0);
    if (phase === "ready-clear") await f.api.clearTodayResult();
    else { f.choiceApi.writeRecommendationChoice("daily", { origin: "app", sourceId: "" }); f.choiceApi.writeRecommendationChoice("daily", { origin: "account", sourceId: "wyy" }); }
    if (phase === "policy-choice") core.finish(core.pending("setSourcePolicy")); else core.state.restoreGate.resolve();
    await rejected; await drain(); assert.equal(officialCalls(core).length, 0); assert.equal(f.storage.has(ACCOUNT_CACHE), false);
  }
});

await check("real core late A→B→A official result and unsupported account capability cannot write or fall back", async () => {
  const core = accountRecommendationFixture(); await core.ready(); await core.saveAccount();
  const f = fixture({ core }); core.hold("accountDailySongs");
  const rejected = assert.rejects(f.api.generateDailyRecommend({ force: true }), /来源/);
  await drain(); const pending = core.pending("accountDailySongs"); assert.ok(pending);
  f.choiceApi.writeRecommendationChoice("daily", { origin: "app", sourceId: "" }); f.choiceApi.writeRecommendationChoice("daily", { origin: "account", sourceId: "wyy" });
  core.finish(pending); await rejected; assert.equal(f.storage.has(ACCOUNT_CACHE), false);
  f.choiceApi.writeRecommendationChoice("daily", { origin: "account", sourceId: "qq" }); await core.saveAccount("qq", "listener-Q");
  await assert.rejects(f.api.generateDailyRecommend({ force: true }), /不支持/);
  assert.equal(officialCalls(core).length, 1); assert.equal(f.storage.has(APP_CACHE), false);
});
await check("cached public daily returns are re-guarded after the SDK ACK promise resolves", async () => {
  const f = fixture(); await f.api.generateDailyRecommend({ force: true });
  const gate = deferred(); f.state.prepareGate = gate;
  const reading = f.api.loadTodayResult();
  gate.promise.then(() => queueMicrotask(() => { f.state.metaEnabled = false; f.state.context.metaAuthRevision++; f.uni.$emit("qt-source-auth-changed"); }));
  gate.resolve();
  assert.equal(await reading, null); assert.equal(f.storage.has(ACCOUNT_CACHE), false);
});

await check("malformed cached mapped fields, foreign song platforms and received-time/version/expiry shapes are misses, never partial results", async () => {
  for (const corrupt of [cache => { cache.items[1].platform = "qq"; }, cache => { cache.items[1].version = false; }, cache => { cache.expiresAt = null; }, cache => { cache.receivedAt += 1; }, cache => { cache.v = String(cache.v); }]) {
    const f = fixture(); await f.api.generateDailyRecommend({ force: true });
    const cache = JSON.parse(f.storage.get(ACCOUNT_CACHE)); corrupt(cache); f.storage.set(ACCOUNT_CACHE, JSON.stringify(cache));
    assert.equal(await f.api.loadTodayResult(), null); assert.equal(f.storage.has(ACCOUNT_CACHE), false); assert.equal(f.state.fetches, 1);
  }
});

await check("an older real official auth failure cannot erase a newer successful account cache", async () => {
  const core = accountRecommendationFixture(); await core.ready(); await core.saveAccount();
  const f = fixture({ core }); core.hold("accountDailySongs");
  const rejected = assert.rejects(f.api.generateDailyRecommend({ force: true }), /替代/);
  await drain(); const old = core.pending("accountDailySongs"); assert.ok(old);
  core.state.batch = (source, kind, accountId) => ({ source, kind, accountId, items: [rawSong("new-success")], fetchedAt: 0 });
  await f.api.generateDailyRecommend({ force: true }); const raw = f.storage.get(ACCOUNT_CACHE);
  core.fail(old, "ACCOUNT_RECOMMENDATIONS_AUTH_EXPIRED: owned-old-error"); await rejected;
  assert.equal(f.storage.get(ACCOUNT_CACHE), raw);
  assert.deepEqual(plain((await f.api.loadTodayResult()).items.map(item => item.song.id)), ["new-success"]);
});
await check("known official auth failure cannot reveal a retired cache when storage deletion throws, and only verified fresh storage re-enables cache", async () => {
  const core = accountRecommendationFixture(); await core.ready(); await core.saveAccount();
  core.state.batch = (source, kind, accountId) => ({ source, kind, accountId, items: [rawSong("old-before-delete")], fetchedAt: 0 });
  const f = fixture({ core }); await f.api.generateDailyRecommend({ force: true });
  const old = f.storage.get(ACCOUNT_CACHE); const publicCache = JSON.stringify({ v: 10, days: [], today: legacyResult() }); f.storage.set(APP_CACHE, publicCache);
  const remove = core.uni.removeStorageSync;
  core.uni.removeStorageSync = key => { if (key === ACCOUNT_CACHE) throw Error("owned storage deletion unavailable"); return remove(key); };
  core.hold("accountDailySongs");
  const rejected = assert.rejects(f.api.generateDailyRecommend({ force: true }), /账号|登录/);
  await drain(); const pending = core.pending("accountDailySongs"); assert.ok(pending); core.fail(pending, "ACCOUNT_RECOMMENDATIONS_AUTH_EXPIRED: owned-error"); await rejected;
  assert.equal(f.storage.get(ACCOUNT_CACHE), old, "the failed native storage deletion really leaves the old bytes");
  assert.equal(await f.api.loadTodayResult(), null); assert.equal(officialCalls(core).length, 2);
  const set = core.uni.setStorageSync;
  core.uni.setStorageSync = (key, value) => { if (key !== ACCOUNT_CACHE) set(key, value); };
  core.state.batch = (source, kind, accountId) => ({ source, kind, accountId, items: [rawSong("new-after-delete")], fetchedAt: 0 });
  const fresh = await f.api.generateDailyRecommend({ force: true }); assert.equal(fresh.items[0].song.id, "new-after-delete");
  assert.equal(f.storage.get(ACCOUNT_CACHE), old); assert.equal(await f.api.loadTodayResult(), null, "an acknowledged write without matching readback cannot release retirement");
  core.uni.setStorageSync = set;
  await f.api.generateDailyRecommend({ force: true });
  assert.deepEqual(plain((await f.api.loadTodayResult()).items.map(item => item.song.id)), ["new-after-delete"]);
  assert.equal(f.storage.get(APP_CACHE), publicCache);
});
await check("post-receipt SDK validation latency cannot extend the 30-minute account cache lifetime", async () => {
  const f = fixture(), received = f.state.now; let delayed = false; f.state.fetchedAt = -0.25;
  f.state.onContextCheck = () => { if (!delayed && f.state.fetches > 0) { delayed = true; f.state.now += 1000; } };
  const fresh = await f.api.generateDailyRecommend({ force: true }); assert.equal(delayed, true); assert.equal(fresh.generatedAt, -0.25);
  f.state.now = received + 30 * 60 * 1000;
  assert.equal(await f.api.loadTodayResult(), null); assert.equal(f.state.fetches, 1);
});
console.log(`${passed} account daily groups passed (real entry points/choice/profile/ranking plus auth/engine/registry/core interoperability; owned SDK/device boundaries, no native/account acceptance)`);
