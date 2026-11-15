// Agreed seams: complete compiled aggregate parse/save/read APIs and MusicApi
// aggregate methods. Only device storage and native/HTTP/package I/O are owned.
// Offline checks do not claim real accounts, network, bundles or native builds.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { read, load, host } from './check-source-auth-session.mjs';

const KEY = 'qt-search-aggregate-sources';
const plain = value => JSON.parse(JSON.stringify(value));
const actual = (path, names, scope) => load(read(path), names, scope);
function preferences(initial = '') {
  const boundary = host();
  if (initial !== '') boundary.storage.set(KEY, initial);
  const api = actual('services/aggregate-sources.ts', [
    'parseAggregateSources', 'readAggregateSources', 'saveAggregateSources',
  ], { uni: boundary.uni });
  return { ...boundary, api };
}

function musicRuntime({ legacy = false, installed = true, initial = '' } = {}) {
  const b = preferences(initial);
  const state = { calls: [], restoreCalls: 0, packageReads: 0, httpCalls: [] };
  const song = { id: 'owned-song', name: 'Owned song', singer: 'Fixture singer',
    album: 'Fixture album', picUrl: 'owned:cover', interval: 201 };
  const forbiddenHttp = (...args) => { state.httpCalls.push(args); throw new Error('live HTTP is forbidden in aggregate checks'); };
  const invokeSource = async (name, text) => {
    const args = JSON.parse(text)[0];
    state.calls.push({ name, args });
    if (name === 'allHotWords') return JSON.stringify({ list: ['Owned hot word'] });
    if (name === 'searchAll') return JSON.stringify({ batches: [{ source: 'qq', list: [song] }] });
    if (name === 'searchMerged' && legacy) throw new Error('owned old bundle has no searchMerged entry');
    if (name === 'searchMerged') return JSON.stringify({ list: [{ source: 'qq', song }], full: true });
    throw new Error('unexpected native aggregate entry: ' + name);
  };
  const merge = actual('services/aggregate-merge.ts', ['mergeAggregateSongs'], {});
  const { MusicApi } = actual('services/music-api.ts', ['MusicApi'], {
    uni: b.uni, ...b.api, ...merge, invokeSource,
    ensureLocalStateRestored: async () => { state.restoreCalls++; },
    activeMetaPack: () => { state.packageReads++; return installed ? { id: 'owned-meta', kind: 'meta', versionCode: 1 } : null; },
    apiRequest: forbiddenHttp, resolveUrl: value => value,
    qtDiag: () => {}, logErrV: () => {}, logWarn: () => {}, isLoggedIn: () => false,
  });
  return { ...b, music: new MusicApi(), state };
}

export async function runAggregateChecks() {
  let passed = 0;
  const check = async (name, run) => { await run(); passed++; console.log('  PASS ' + name); };

  await check('AG-01 saving explicit none survives reload while legacy empty remains default', () => {
    const b = preferences();
    assert.equal(b.api.readAggregateSources(), null);
    b.api.saveAggregateSources([]);
    assert.deepEqual(plain(b.api.readAggregateSources()), [], 'turning the last source off must not reactivate all sources');
    assert.deepEqual(plain(preferences(b.storage.get(KEY)).api.readAggregateSources()), [], 'explicit none must survive a fresh service');
    assert.equal(preferences('[]').api.readAggregateSources(), null, 'old empty arrays are still default/all');
    assert.deepEqual(JSON.parse(b.storage.get(KEY)), { version: 1, sources: [] });
    assert.deepEqual([...b.storage.keys()].filter(key => key.startsWith('qt-search-aggregate')), [KEY]);
  });

  await check('AG-02 reset restores default/all without losing legacy whitelist compatibility', () => {
    const b = preferences('["qq","orphan-pack"]');
    assert.deepEqual(plain(b.api.readAggregateSources()), ['qq', 'orphan-pack']);
    b.api.saveAggregateSources([]);
    b.api.saveAggregateSources(null);
    assert.equal(b.api.readAggregateSources(), null, 'reset must restore default/all rather than explicit none');
    assert.equal(preferences(b.storage.get(KEY)).api.readAggregateSources(), null);
    b.api.saveAggregateSources([' qq ', 'orphan-pack', 'qq', 'bad id']);
    assert.deepEqual(plain(b.api.readAggregateSources()), ['qq', 'orphan-pack']);
    assert.deepEqual(JSON.parse(b.storage.get(KEY)), ['qq', 'orphan-pack'], 'nonempty selections retain the legacy array format');
  });

  await check('AG-03 rejected storage write throws and preserves the last durable selection', () => {
    const b = preferences('["qq","orphan-pack"]');
    const rejected = new Error('owned storage write rejected');
    b.uni.setStorageSync = () => { throw rejected; };
    for (const selection of [['wyy'], [], null]) {
      assert.throws(() => b.api.saveAggregateSources(selection), error => error === rejected, 'a failed save must reach the page receipt');
      assert.deepEqual(plain(b.api.readAggregateSources()), ['qq', 'orphan-pack']);
      assert.equal(b.storage.get(KEY), '["qq","orphan-pack"]');
    }
    assert.deepEqual(b.events, [], 'failed service writes must not publish success');
  });

  await check('AG-04 malformed preferences remain default and valid orphan IDs remain selected', () => {
    const b = preferences();
    const defaults = [null, '', '  ', 'null', '[]', '{broken', '"qq"', '{}',
      '{"version":2,"sources":[]}', '{"version":"1","sources":[]}', '{"version":1,"sources":{}}'];
    for (const raw of defaults) assert.equal(b.api.parseAggregateSources(raw), null, 'bad or legacy empty input is default: ' + raw);
    assert.deepEqual(plain(b.api.parseAggregateSources('[null,27,{},true," qq ","qq","orphan-pack","bad id"]')), ['qq', 'orphan-pack']);
    assert.deepEqual(plain(b.api.parseAggregateSources('{"version":1,"sources":["qq","orphan-pack"]}')), ['qq', 'orphan-pack']);
    b.storage.set(KEY, '{broken');
    assert.equal(b.api.readAggregateSources(), null);
    b.storage.set(KEY, ['qq']);
    assert.equal(b.api.readAggregateSources(), null, 'non-string native storage is not a valid serialized setting');
    b.uni.getStorageSync = () => { throw new Error('owned storage read rejected'); };
    assert.equal(b.api.readAggregateSources(), null);
  });

  await check('AG-05 explicit none merged search never reaches current or old bundles', async () => {
    for (const options of [{}, { legacy: true }, { installed: false }]) {
      const b = musicRuntime(options);
      assert.deepEqual(plain(await b.music.searchMerged('Owned song', 1, 1, [], 'qq')), { songs: [], full: false });
      assert.deepEqual(b.state.calls, [], 'explicit none must not invoke searchMerged or its old-bundle fallback');
      assert.equal(b.state.restoreCalls, 0);
      assert.equal(b.state.packageReads, 0, 'none must be decided before querying bundle availability');
      assert.deepEqual(b.state.httpCalls, []);
    }
  });

  await check('AG-06 explicit or saved none batches never invoke legacy all-source search', async () => {
    for (const options of [{}, { legacy: true }, { installed: false }]) {
      const b = musicRuntime(options);
      assert.deepEqual(plain(await b.music.allSearchBatches('Owned song', 1, 1, [])), []);
      b.api.saveAggregateSources([]);
      assert.deepEqual(plain(await b.music.allSearchBatches('Owned song', 1, 1)), [], 'default argument must honor saved none');
      assert.deepEqual(b.state.calls, []);
      assert.equal(b.state.restoreCalls, 0);
      assert.equal(b.state.packageReads, 0);
      assert.deepEqual(b.state.httpCalls, []);
    }
  });

  await check('AG-07 explicit none hot words cannot be ignored by an old bundle', async () => {
    for (const options of [{}, { legacy: true }, { installed: false }]) {
      const b = musicRuntime(options);
      assert.deepEqual(plain(await b.music.allHotWords([])), []);
      assert.deepEqual(b.state.calls, []);
      assert.equal(b.state.restoreCalls, 0);
      assert.equal(b.state.packageReads, 0);
      assert.deepEqual(b.state.httpCalls, []);
    }
  });

  await check('AG-08 flat aggregate search accepts explicit none and honors saved none', async () => {
    for (const options of [{}, { legacy: true }, { installed: false }]) {
      const b = musicRuntime(options);
      assert.deepEqual(plain(await b.music.allSearch('Owned song', 1, 1, [])), [], 'direct flat-search callers may explicitly choose none');
      b.api.saveAggregateSources([]);
      assert.deepEqual(plain(await b.music.allSearch('Owned song', 1, 1)), [], 'existing three-argument callers honor saved none');
      assert.deepEqual(b.state.calls, []);
      assert.equal(b.state.restoreCalls, 0);
      assert.equal(b.state.packageReads, 0);
      assert.deepEqual(b.state.httpCalls, []);
    }
  });

  await check('AG-09 null/list paths keep native arguments, mapping and old-bundle fallback', async () => {
    const expectedSong = { id: 'owned-song', name: 'Owned song', singer: 'Fixture singer',
      album: 'Fixture album', picUrl: 'owned:cover', platform: 'qq', duration: 201 };
    for (const legacy of [false, true]) {
      for (const sources of [null, ['qq', 'orphan-pack']]) {
        const b = musicRuntime({ legacy });
        const searchArgs = { keyword: 'Owned song', page: 2, size: 1 };
        const sourceArgs = sources == null ? {} : { sources };
        assert.deepEqual(plain(await b.music.searchMerged('Owned song', 2, 1, sources, 'qq')), { songs: [expectedSong], full: true });
        assert.deepEqual(b.state.calls, legacy
          ? [{ name: 'searchMerged', args: { ...searchArgs, ...sourceArgs, preferSource: 'qq' } },
            { name: 'searchAll', args: { ...searchArgs, ...sourceArgs } }]
          : [{ name: 'searchMerged', args: { ...searchArgs, ...sourceArgs, preferSource: 'qq' } }]);
        b.state.calls.length = 0;
        assert.deepEqual(plain(await b.music.allSearchBatches('Owned song', 2, 1, sources)), [{ source: 'qq', songs: [expectedSong] }]);
        assert.deepEqual(b.state.calls, [{ name: 'searchAll', args: { ...searchArgs, ...sourceArgs } }]);
        b.state.calls.length = 0;
        assert.deepEqual(plain(await b.music.allSearch('Owned song', 2, 1, sources)), [expectedSong]);
        assert.deepEqual(b.state.calls, [{ name: 'searchAll', args: { ...searchArgs, ...sourceArgs } }]);
        b.state.calls.length = 0;
        assert.deepEqual(plain(await b.music.allHotWords(sources)), ['Owned hot word']);
        assert.deepEqual(b.state.calls, [{ name: 'allHotWords', args: sourceArgs }]);
        assert.deepEqual(b.state.httpCalls, []);
      }
    }
    const b = musicRuntime({ initial: '[]' });
    assert.deepEqual(plain(await b.music.allSearch('Owned song', 2, 1)), [expectedSong], 'old empty settings still search default/all');
    assert.deepEqual(b.state.calls, [{ name: 'searchAll', args: { keyword: 'Owned song', page: 2, size: 1 } }]);
    b.state.calls.length = 0;
    b.api.saveAggregateSources(['qq', 'orphan-pack']);
    assert.deepEqual(plain(await b.music.allSearchBatches('Owned song', 2, 1)), [{ source: 'qq', songs: [expectedSong] }]);
    assert.deepEqual(b.state.calls, [{ name: 'searchAll', args: { keyword: 'Owned song', page: 2, size: 1, sources: ['qq', 'orphan-pack'] } }]);
  });

  console.log('aggregate-sources: ' + passed + ' passed; owned offline seams only');
  return passed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runAggregateChecks();
