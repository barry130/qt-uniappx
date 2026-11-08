// Confirmed public seams: actual MusicApi.charts/chartDetail/clearPlayUrlCache
// and chartCacheIdentity; package mutations use the actual source-bundle-fs API.
// The VM executes complete production modules, not extracted private methods.
// Only native I/O, engine transport, storage, time and unrelated native imports
// are adapters. These checks do not prove native compilation or device timings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const modules = new Map(['services/http.ts', 'services/source-bundle-fs.uts',
  'services/ttl-store.ts', 'services/music-api.ts'].map(path => [path,
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')]));

class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return Object.hasOwn(this, key) ? this[key] : null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}

function android(text) {
  const states = [true];
  return text.split('\n').filter(line => {
    const start = line.match(/^\s*\/\/\s*#(ifdef|ifndef)\s+(.+)$/);
    if (start) {
      let enabled = start[2].split(/\|\|/).some(flag => ['APP-ANDROID', 'APP'].includes(flag.trim()));
      if (start[1] === 'ifndef') enabled = !enabled;
      states.push(states.at(-1) && enabled);
      return false;
    }
    if (/^\s*\/\/\s*#endif\b/.test(line)) { states.pop(); return false; }
    return states.at(-1);
  }).join('\n');
}

function load(path, scope) {
  const source = modules.get(path);
  const names = [...source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)]
    .map(match => match[1]);
  const executable = stripTypeScriptTypes(android(source)
    .replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*/gm, ''), { mode: 'strip' })
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var))/g, '');
  const context = vm.createContext(scope);
  vm.runInContext(executable + `\n;globalThis.__module={${names.join(',')}};`, context, { filename: path });
  return context.__module;
}

const pack = (id, kind, versionCode = 1) => ({
  id, kind, versionCode, name: id, versionName: String(versionCode), updateUrl: '',
  dir: `/chart-fixture/source-bundle/install/${id}`, installedAt: 1000, updatedAt: 1000,
  skipCodes: [], lastProbeAt: 0, installSource: 'file', installRef: 'fixture.js',
  lastError: '', lastErrorAt: 0, signVerified: false,
});

function runtime(storage = new Map()) {
  const env = { storage, files: new Map(), requests: [], storageReads: [], storageWrites: [],
    time: 100000, playRequests: [] };
  const installed = [pack('meta-a', 'meta'), pack('meta-b', 'meta'), pack('play-a', 'play'), pack('play-b', 'play')];
  env.files.set('/chart-fixture/source-bundle/state.json', JSON.stringify({
    schema: 3, packs: installed, activeMetaId: 'meta-a', activeId: 'play-a', lastCheckAt: 0,
  }));
  for (const item of installed) env.files.set(`${item.dir}/${item.kind}-bundle.js`, 'fixture-artifact');
  class Clock extends Date { static now() { return env.time; } }
  const scope = {
    console, Date: Clock, UTSJSONObject,
    nativeDataDir: () => '/chart-fixture',
    nativeReadTextFile: (path, done) => done(env.files.has(path), env.files.get(path) ?? '', 'not found'),
    nativeWriteTextFile: (path, text, done) => { env.files.set(path, text); done(true, '', ''); },
    nativeExists: (path, done) => done(true, env.files.has(path) ? '1' : '0', ''),
    nativeListDir: (_path, done) => done(true, '[]', ''),
    nativeRemove: (path, done) => { env.files.delete(path); done(true, '', ''); },
    nativeMkdirs: (_path, done) => done(true, '', ''),
    nativeRenamePath: (from, to, done) => { env.files.set(to, env.files.get(from)); env.files.delete(from); done(true, '', ''); },
    invokeSource: (name, args) => new Promise((resolve, reject) => {
      env.requests.push({ name, args: JSON.parse(args)[0], resolve: value => resolve(JSON.stringify(value)), reject });
    }),
    getPlayUrlByEngineResult: async (song, quality) => {
      env.playRequests.push({ song, quality });
      return { url: 'https://audio.invalid/fixture.mp3', actualQuality: '320', size: 1000000, line: null, stalled: false };
    },
    isLoggedIn: () => false, qtDiag: () => {}, logInfo: () => {}, logErrV: () => {}, logWarn: () => {}, logWarnV: () => {},
    preferredSource: () => null, sourcePlayLoginActive: () => false, sourceVipTierOf: () => '',
    cachedQualityProfileOf: () => null, PROFILE_MODE_OFFICIAL: 'official', sourcePlayQualityOf: () => '',
    readSongEmbedded: async () => null, readLyricDisk: () => '', writeLyricDisk: () => {},
    removeLyricDisk: () => {}, clearLyricDisk: () => {}, mergeAggregateSongs: value => value,
    uni: {
      getStorageSync: key => { env.storageReads.push(key); return env.storage.get(key) ?? ''; },
      setStorageSync: (key, value) => { env.storage.set(key, value); env.storageWrites.push(key); },
      removeStorageSync: key => env.storage.delete(key),
      getStorageInfoSync: () => ({ keys: [...env.storage.keys()] }),
      $emit: () => {},
      request: () => { throw new Error('live network is forbidden in this regression'); },
    },
  };
  Object.assign(scope, load('services/http.ts', scope));
  const fs = load('services/source-bundle-fs.uts', scope);
  Object.assign(scope, fs);
  Object.assign(scope, load('services/ttl-store.ts', scope));
  const { MusicApi } = load('services/music-api.ts', scope);
  return { env, fs, MusicApi, api: new MusicApi() };
}

const chart = { id: 'chart-a', platform: 'wyy', name: '测试榜', picUrl: '', description: '' };
const song = id => ({ id, name: `榜单曲${id}`, singer: '测试歌手', album: '测试专辑', picUrl: '', interval: 200 });
const chartsResponse = id => ({ list: [{ ...chart, id, name: id }] });
const detailResponse = id => ({ list: [song(id)] });
const tick = async () => { for (let i = 0; i < 48; i++) await Promise.resolve(); };
let passes = 0;
async function check(name, run) { await run(); passes++; console.log(`  ✓ ${name}`); }

// First vertical slice: preview and detail callers share one actual engine request.
await check('same-chart preview + detail share one engine request', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const a = api.chartDetail(chart), b = api.chartDetail(chart);
  await tick();
  assert.equal(env.requests.length, 1, 'same-chart preview + detail must be singleflight');
  assert.equal(env.requests[0].name, 'chartDetail');
  env.requests[0].resolve(detailResponse('one'));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra[0].id, 'one');
  assert.equal(rb[0].id, 'one');
  const again = await api.chartDetail(chart);
  assert.equal(again[0].id, 'one');
  assert.equal(env.requests.length, 1);
});
await check('cache identity tracks active slots, all installed revisions and invalidation epoch', async () => {
  const { api, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const before = api.chartCacheIdentity();
  assert.equal(api.chartCacheIdentity(), before, 'unchanged package scope has a stable identity');
  assert.equal(await fs.setActiveMeta('meta-b'), true);
  const metaChanged = api.chartCacheIdentity();
  assert.notEqual(metaChanged, before, 'same-version active meta switch changes identity');
  assert.equal(await fs.setActive('play-b'), true);
  const playChanged = api.chartCacheIdentity();
  assert.notEqual(playChanged, metaChanged, 'same-version active play switch changes identity');
  assert.equal(await fs.putPack(pack('meta-a', 'meta', 2)), true);
  const installedChanged = api.chartCacheIdentity();
  assert.notEqual(installedChanged, playChanged, 'inactive installed revision changes identity without changing pack count');
  assert.equal(await fs.saveLocalState({ ...fs.localState(), packs: fs.packs().reverse() }), true);
  assert.equal(api.chartCacheIdentity(), installedChanged, 'presentation ordering is not a package identity change');
  api.clearPlayUrlCache();
  assert.notEqual(api.chartCacheIdentity(), installedChanged, 'explicit cache invalidation advances identity even with unchanged package versions');
});
await check('detail reuses parsed songs without re-reading persistent storage within memory TTL', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const pending = api.chartDetail(chart);
  await tick();
  env.requests[0].resolve(detailResponse('memo'));
  const first = await pending;
  const reads = env.storageReads.length;
  const second = await api.chartDetail(chart);
  assert.equal(second, first, 'preview and detail should reuse the parsed Song array');
  assert.equal(env.storageReads.length, reads, 'a hot detail must not parse the large TTL payload again');
  assert.equal(env.requests.length, 1);
});
await check('detail cache separates same-version active meta scopes in memory and persistent storage', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const a = api.chartDetail(chart);
  await tick();
  env.requests[0].resolve(detailResponse('meta-a-song'));
  await a;
  await fs.setActiveMeta('meta-b');
  const b = api.chartDetail(chart);
  await tick();
  assert.equal(env.requests.length, 2, 'switching only the active meta ID must miss the previous detail cache');
  env.requests[1].resolve(detailResponse('meta-b-song'));
  assert.equal((await b)[0].id, 'meta-b-song');
  const cold = runtime(env.storage);
  await cold.fs.ensureLocalStateRestored();
  await cold.fs.setActiveMeta('meta-b');
  const restored = await cold.api.chartDetail(chart);
  assert.equal(restored[0].id, 'meta-b-song', 'cross-start persistence must retain the selected package scope');
  assert.equal(cold.env.requests.length, 0);
});
await check('chart-list cache separates same-version active play scopes across starts', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const a = api.charts('wyy');
  await tick();
  env.requests[0].resolve(chartsResponse('play-a-chart'));
  await a;
  await fs.setActive('play-b');
  const b = api.charts('wyy');
  await tick();
  assert.equal(env.requests.length, 2, 'switching only the active play ID must miss the previous chart list');
  env.requests[1].resolve(chartsResponse('play-b-chart'));
  assert.equal((await b)[0].id, 'play-b-chart');
  const cold = runtime(env.storage);
  await cold.fs.ensureLocalStateRestored();
  await cold.fs.setActive('play-b');
  assert.equal((await cold.api.charts('wyy'))[0].id, 'play-b-chart');
  assert.equal(cold.env.requests.length, 0);
});
await check('forced detail refresh bypasses both hot memory and cross-start persistent caches', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const initial = api.chartDetail(chart);
  await tick();
  env.requests[0].resolve(detailResponse('cached'));
  await initial;
  const forced = api.chartDetail(chart, true);
  await tick();
  assert.equal(env.requests.length, 2, 'force=true must not return the hot detail');
  env.requests[1].resolve(detailResponse('fresh'));
  assert.equal((await forced)[0].id, 'fresh');
  assert.equal((await api.chartDetail(chart))[0].id, 'fresh');
  const cold = runtime(env.storage);
  const forceDisk = cold.api.chartDetail(chart, true);
  await tick();
  assert.equal(cold.env.requests.length, 1, 'force=true must not return a persistent detail either');
  cold.env.requests[0].resolve(detailResponse('fresh-after-start'));
  assert.equal((await forceDisk)[0].id, 'fresh-after-start');
});
await check('forced detail supersedes an older flight without old cleanup or writes stealing ownership', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const old = api.chartDetail(chart);
  await tick();
  const fresh = api.chartDetail(chart, true);
  await tick();
  assert.equal(env.requests.length, 2, 'force must start a new request rather than join the old flight');
  env.requests[0].resolve(detailResponse('superseded'));
  assert.equal((await old)[0].id, 'superseded', 'an old caller may finish without publishing its cache');
  assert.equal(env.storageWrites.length, 0, 'superseded responses must not persist old data');
  const joined = api.chartDetail(chart);
  await tick();
  assert.equal(env.requests.length, 2, 'old cleanup must not delete the replacement flight');
  env.requests[1].resolve(detailResponse('owner'));
  assert.equal((await fresh)[0].id, 'owner');
  assert.equal((await joined)[0].id, 'owner', 'new non-force callers join the replacement owner');
  assert.equal((await runtime(env.storage).api.chartDetail(chart))[0].id, 'owner');
});
await check('ordinary detail callers join an active refresh even when an older hot value exists', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const initial = api.chartDetail(chart);
  await tick();
  env.requests[0].resolve(detailResponse('hot-old'));
  await initial;
  const fresh = api.chartDetail(chart, true);
  await tick();
  let joinedValue = null;
  const joined = api.chartDetail(chart).then(value => { joinedValue = value; return value; });
  await tick();
  assert.equal(joinedValue, null, 'refresh ownership takes precedence over the older hot cache');
  assert.equal(env.requests.length, 2);
  env.requests[1].resolve(detailResponse('hot-fresh'));
  assert.equal((await fresh)[0].id, 'hot-fresh');
  assert.equal((await joined)[0].id, 'hot-fresh');
});
await check('forced chart-list refresh bypasses caches and supersedes flights for the default source', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const initial = api.charts();
  await tick();
  assert.equal(env.requests[0].args.source, 'wyy');
  env.requests[0].resolve(chartsResponse('cached-list'));
  await initial;
  const old = api.charts(undefined, true);
  await tick();
  assert.equal(env.requests.length, 2, 'force=true must bypass a hot chart list');
  const fresh = api.charts(undefined, true);
  await tick();
  assert.equal(env.requests.length, 3, 'a newer forced list request supersedes the older flight');
  const writes = env.storageWrites.length;
  env.requests[1].resolve(chartsResponse('old-list'));
  await old;
  assert.equal(env.storageWrites.length, writes, 'superseded list responses must not persist');
  let joinedValue = null;
  const joined = api.charts().then(value => { joinedValue = value; return value; });
  await tick();
  assert.equal(joinedValue, null, 'the replacement list flight outranks an older hot cache');
  assert.equal(env.requests.length, 3, 'old list cleanup must leave the replacement flight registered');
  env.requests[2].resolve(chartsResponse('fresh-list'));
  assert.equal((await fresh)[0].id, 'fresh-list');
  assert.equal((await joined)[0].id, 'fresh-list');
  const cold = runtime(env.storage);
  const forceDisk = cold.api.charts(undefined, true);
  await tick();
  assert.equal(cold.env.requests.length, 1, 'force=true also bypasses a cross-start chart list');
  cold.env.requests[0].resolve(chartsResponse('fresh-cold-list'));
  assert.equal((await forceDisk)[0].id, 'fresh-cold-list');
});
await check('late detail from a changed installed-package scope cannot publish either cache', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const old = api.chartDetail(chart);
  await tick();
  await fs.putPack(pack('meta-b', 'meta', 2));
  const fresh = api.chartDetail(chart);
  await tick();
  assert.equal(env.requests.length, 2, 'installed package revision changes isolate in-flight details too');
  env.requests[1].resolve(detailResponse('new-scope'));
  await fresh;
  const writes = env.storageWrites.length;
  env.requests[0].resolve(detailResponse('old-scope'));
  await old;
  assert.equal(env.storageWrites.length, writes, 'a late old package response must not be written under old or new package identity');
  assert.equal((await api.chartDetail(chart))[0].id, 'new-scope');
  await fs.putPack(pack('meta-b', 'meta', 1));
  const returned = api.chartDetail(chart);
  await tick();
  assert.equal(env.requests.length, 3, 'returning to the old scope must not expose its invalidated late response');
  env.requests[2].resolve(detailResponse('reloaded-scope'));
  assert.equal((await returned)[0].id, 'reloaded-scope');
});
await check('late chart list from a switched active meta scope cannot write a fresh package cache', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const old = api.charts('wyy');
  await tick();
  await fs.setActiveMeta('meta-b');
  const fresh = api.charts('wyy');
  await tick();
  assert.equal(env.requests.length, 2);
  env.requests[1].resolve(chartsResponse('selected-meta'));
  await fresh;
  const writes = env.storageWrites.length;
  env.requests[0].resolve(chartsResponse('deselected-meta'));
  await old;
  assert.equal(env.storageWrites.length, writes, 'late deselected meta must not write any chart-list cache');
  assert.equal((await api.charts('wyy'))[0].id, 'selected-meta');
  const cold = runtime(env.storage);
  await cold.fs.ensureLocalStateRestored();
  await cold.fs.setActiveMeta('meta-b');
  assert.equal((await cold.api.charts('wyy'))[0].id, 'selected-meta');
  assert.equal(cold.env.requests.length, 0);
});
await check('a successful empty forced detail does not resurrect the previous persistent songs after restart', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const initial = api.chartDetail(chart);
  await tick();
  env.requests[0].resolve(detailResponse('removed-song'));
  await initial;
  const fresh = api.chartDetail(chart, true);
  await tick();
  env.requests[1].resolve({ list: [] });
  assert.equal((await fresh).length, 0);
  const cold = runtime(env.storage);
  const next = cold.api.chartDetail(chart);
  await tick();
  assert.equal(cold.env.requests.length, 1, 'the previous twelve-hour payload must not reappear after an empty refresh');
  cold.env.requests[0].resolve(detailResponse('recovered-song'));
  assert.equal((await next)[0].id, 'recovered-song');
});
await check('a successful empty forced chart list invalidates the previous persistent list', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const initial = api.charts('wyy');
  await tick();
  env.requests[0].resolve(chartsResponse('removed-chart'));
  await initial;
  const fresh = api.charts('wyy', true);
  await tick();
  env.requests[1].resolve({ list: [] });
  assert.equal((await fresh).length, 0);
  const cold = runtime(env.storage);
  const next = cold.api.charts('wyy');
  await tick();
  assert.equal(cold.env.requests.length, 1, 'empty list refresh cannot resurrect an older persistent chart list');
  cold.env.requests[0].resolve(chartsResponse('recovered-chart'));
  assert.equal((await next)[0].id, 'recovered-chart');
});
await check('cache identity encodes accepted package IDs without delimiter collisions', async () => {
  const { api, fs } = runtime();
  await fs.ensureLocalStateRestored();
  await fs.putPack(pack('meta-a|slot', 'meta'));
  await fs.putPack(pack('slot|play-a', 'play'));
  await fs.setActiveMeta('meta-a|slot');
  await fs.setActive('play-a');
  assert.equal(fs.localState().activeMetaId, 'meta-a|slot');
  assert.equal(fs.localState().activeId, 'play-a');
  const left = api.chartCacheIdentity();
  await fs.setActiveMeta('meta-a');
  await fs.setActive('slot|play-a');
  assert.equal(fs.localState().activeMetaId, 'meta-a');
  assert.equal(fs.localState().activeId, 'slot|play-a');
  assert.notEqual(api.chartCacheIdentity(), left, 'distinct accepted active-slot tuples must not collide on an ID delimiter');
});
// The following checks protect unchanged limits and guard branches; their first
// PASS is supplemental evidence, not a claimed new production RED/GREEN slice.
await check('global cache invalidation blocks late old-epoch lists/details and keeps fresh persistence cross-start', async () => {
  for (const kind of ['detail', 'list']) {
    const { api, env, fs } = runtime();
    await fs.ensureLocalStateRestored();
    const request = () => kind === 'detail' ? api.chartDetail(chart) : api.charts('wyy');
    const response = kind === 'detail' ? detailResponse : chartsResponse;
    const old = request();
    await tick();
    const before = api.chartCacheIdentity();
    api.clearPlayUrlCache();
    assert.notEqual(api.chartCacheIdentity(), before);
    const fresh = request();
    await tick();
    assert.equal(env.requests.length, 2, 'clearing caches creates a new scope rather than joining the old flight');
    env.requests[1].resolve(response('new-epoch'));
    await fresh;
    const writes = env.storageWrites.length;
    env.requests[0].resolve(response('old-epoch'));
    await old;
    assert.equal(env.storageWrites.length, writes, 'late old-epoch data cannot overwrite the fresh persistent payload');
    assert.equal((await request())[0].id, 'new-epoch');
    const cold = runtime(env.storage);
    const restored = kind === 'detail' ? await cold.api.chartDetail(chart) : await cold.api.charts('wyy');
    assert.equal(restored[0].id, 'new-epoch', 'process epoch is not part of the persistent package key');
    assert.equal(cold.env.requests.length, 0);
  }
});
await check('flight rejection releases current ownership without deleting a replacement list/detail owner', async () => {
  for (const kind of ['detail', 'list']) {
    const { api, env, fs } = runtime();
    await fs.ensureLocalStateRestored();
    const request = force => kind === 'detail' ? api.chartDetail(chart, force) : api.charts('wyy', force);
    const response = kind === 'detail' ? detailResponse : chartsResponse;
    const old = request(false);
    const oldError = old.then(() => 'unexpected fulfillment', error => error.message);
    await tick();
    const fresh = request(true);
    await tick();
    assert.equal(env.requests.length, 2);
    env.requests[0].reject(new Error('superseded fixture failure'));
    assert.equal(await oldError, 'superseded fixture failure');
    let joinedValue = null;
    const joined = request(false).then(value => { joinedValue = value; return value; });
    await tick();
    assert.equal(joinedValue, null);
    assert.equal(env.requests.length, 2, 'old rejection cleanup must retain the replacement singleflight');
    env.requests[1].resolve(response('after-old-rejection'));
    assert.equal((await fresh)[0].id, 'after-old-rejection');
    assert.equal((await joined)[0].id, 'after-old-rejection');

    const empty = runtime();
    const emptyRequest = () => kind === 'detail' ? empty.api.chartDetail(chart) : empty.api.charts('wyy');
    const failed = emptyRequest();
    const rejected = assert.rejects(failed, /current fixture failure/);
    await tick();
    empty.env.requests[0].reject(new Error('current fixture failure'));
    await rejected;
    assert.equal(empty.env.storageWrites.length, 0, 'a rejected flight must not publish a TTL payload');
    const retry = emptyRequest();
    await tick();
    assert.equal(empty.env.requests.length, 2, 'current-owner failure must release its key for a normal retry');
    empty.env.requests[1].resolve(response('retry-success'));
    assert.equal((await retry)[0].id, 'retry-success');
  }
});
await check('chart memory expires at sixty seconds and persistence at twelve hours without sliding its timestamp', async () => {
  for (const kind of ['detail', 'list']) {
    const { api, env, fs } = runtime();
    await fs.ensureLocalStateRestored();
    const request = () => kind === 'detail' ? api.chartDetail(chart) : api.charts('wyy');
    const response = kind === 'detail' ? detailResponse : chartsResponse;
    const pending = request();
    await tick();
    env.requests[0].resolve(response('ttl-song'));
    const initial = await pending;
    const reads = env.storageReads.length;
    env.time += 59999;
    assert.equal(await request(), initial);
    assert.equal(env.storageReads.length, reads);
    env.time += 1;
    const restored = await request();
    assert.notEqual(restored, initial, 'the memory entry expires at the sixty-second boundary');
    assert.equal(env.storageReads.length, reads + 1, 'expired memory backfills once from persistent storage');
    assert.equal(env.requests.length, 1);
    assert.equal(await request(), restored);
    assert.equal(env.storageReads.length, reads + 1, 'the parsed persistent payload is then memoized');
    assert.equal(env.storageWrites.length, 1, 'memory backfill must not extend the twelve-hour persistent timestamp');
    env.time = 100000 + 12 * 60 * 60 * 1000;
    const expired = request();
    await tick();
    assert.equal(env.requests.length, 2, 'the twelve-hour boundary requires fresh engine data');
    env.requests[1].resolve(response('after-expiry'));
    assert.equal((await expired)[0].id, 'after-expiry');
  }
});
await check('the eighty-entry shared memory bound evicts old parsed details while preserving TTL backfill', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const results = [];
  for (let i = 0; i < 81; i++) {
    const pending = api.chartDetail({ ...chart, id: `capacity-${i}` });
    await tick();
    env.requests[i].resolve(detailResponse(`capacity-${i}`));
    results.push(await pending);
  }
  const reads = env.storageReads.length;
  assert.equal(await api.chartDetail({ ...chart, id: 'capacity-80' }), results[80]);
  assert.equal(env.storageReads.length, reads, 'the recent eighty-first detail remains in memory');
  const oldest = await api.chartDetail({ ...chart, id: 'capacity-0' });
  assert.notEqual(oldest, results[0], 'the oldest parsed detail was evicted at capacity eighty');
  assert.equal(oldest[0].id, 'capacity-0');
  assert.equal(env.storageReads.length, reads + 1, 'eviction does not discard the twelve-hour persistent cache');
  assert.equal(env.requests.length, 81, 'TTL backfill needs no extra engine request');
});
await check('single-chart and active-source refresh keep the playing URL cache and global epoch intact', async () => {
  const { api, env, fs } = runtime();
  await fs.ensureLocalStateRestored();
  const playable = { ...song('retained-play'), platform: 'wyy', duration: 200 };
  const firstUrl = await api.playUrl(playable, '320');
  await tick();
  for (const request of env.requests.filter(item => item.name === 'lyric')) {
    request.resolve({ lyric: '[00:00.00]缓存保留测试', translation: '', wordByWord: '', romanization: '' });
  }
  await tick();
  assert.equal(env.playRequests.length, 1);
  const identity = api.chartCacheIdentity();
  const detail = api.chartDetail(chart, true);
  await tick();
  env.requests.find(item => item.name === 'chartDetail').resolve(detailResponse('fresh-preview'));
  await detail;
  const list = api.charts('wyy', true);
  await tick();
  env.requests.find(item => item.name === 'charts').resolve(chartsResponse('fresh-active-list'));
  await list;
  assert.equal(await api.playUrl(playable, '320'), firstUrl);
  assert.equal(env.playRequests.length, 1, 'refresh must not force the current song to fetch another play URL');
  assert.equal(api.chartCacheIdentity(), identity, 'targeted refresh is not a global cache-clear epoch');
});
console.log(`\n${passes} passed (complete production-module VM; not device measurements)`);
