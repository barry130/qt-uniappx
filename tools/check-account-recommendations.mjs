// Agreed seam: complete production prepare/fetch/choice APIs -> real auth/engine/registry/parser.
// Only native engine callbacks, installed-package facts, unrelated quality/profile I/O, storage and time are owned adapters.
// No HTTP, real credentials, native compile, source-package execution or device/account acceptance.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as Vue from 'vue';
import { createPinia, defineStore } from 'pinia';
import { sourcePolicyFixture } from './source-policy-fixture.mjs';

export const readProduction = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const noop = () => {};
export const plain = value => JSON.parse(JSON.stringify(value));
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export async function drain() { for (let i = 0; i < 150; i++) await Promise.resolve(); await Vue.nextTick(); }
class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return Object.hasOwn(this, key) ? this[key] : null; }
  getString(key) { return typeof this[key] === 'string' ? this[key] : null; }
  getNumber(key) { return typeof this[key] === 'number' ? this[key] : null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}
function toUTS(value) {
  if (Array.isArray(value)) return value.map(toUTS);
  return value != null && typeof value === 'object'
    ? new UTSJSONObject(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toUTS(item)]))) : value;
}
const parseJsonToUtso = text => toUTS(JSON.parse(text));
export function loadProduction(path, extra = {}, names = null) {
  const source = readProduction(path);
  const exported = names ?? [...source.matchAll(/^export\s+(?:(?:async\s+)?function|const|class)\s+(\w+)/gm)].map(match => match[1]);
  const stripped = source.replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, '');
  const code = stripTypeScriptTypes(stripped, { mode: 'strip' }).replace(/^export /gm, '');
  const JSONAdapter = path.endsWith('.uts') ? { parse: parseJsonToUtso, stringify: JSON.stringify } : JSON;
  return vm.runInNewContext(code + '\n;({' + exported.join(',') + '});',
    { console, UTSJSONObject, parseJsonToUtso, JSON: JSONAdapter, ...extra }, { filename: path });
}
export const rawSong = (id = 'opaque:id/%:A') => ({ id, name: '歌名', singer: '歌手', album: '', picUrl: '', interval: 100.125 });
export function accountRecommendationFixture() {
  const storage = new Map(), events = [], listeners = new Map(), timers = new Map(), logs = [];
  const state = {
    now: 1_000_000, running: false, healthy: true, sequence: 0,
    pack: { id: 'meta-fixture', kind: 'meta', versionCode: 1, updatedAt: 100 },
    restoreGate: null, holds: new Map(), pending: [], calls: [], ack: { ok: true },
    registryPayload: { sourcePolicyVersion: 1, sources: [
      { id: 'wyy', name: '网易云', short: '网', color: '#111111', accountRecommendations: { daily: true, fm: true } },
      { id: 'kg', name: '酷狗', short: '狗', color: '#222222', accountRecommendations: { daily: true } },
      { id: 'qq', name: 'QQ', short: 'Q', color: '#333333', auth: { methods: ['cookie'], domains: [] } },
    ], qualities: [] },
    batch: (source, kind, accountId) => ({ source, kind, accountId, items: [rawSong()], fetchedAt: 123456.25 }),
  };
  const uni = {
    getStorageSync: key => storage.get(key) ?? '', setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key), getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    $on(name, fn) { const group = listeners.get(name) ?? new Set(); group.add(fn); listeners.set(name, group); },
    $off(name, fn) { listeners.get(name)?.delete(fn); },
    $emit(name, ...args) { events.push([name, ...args]); for (const fn of listeners.get(name) ?? []) fn(...args); },
  };
  class Clock extends Date { static now() { return state.now; } }
  const setTimeout = (fn, delay = 0) => { const id = ++state.sequence; timers.set(id, { fn, at: state.now + delay }); return id; };
  const clearTimeout = id => timers.delete(id);
  const advance = async ms => {
    state.now += ms;
    for (let i = 0; i < 100; i++) {
      const task = [...timers.entries()].filter(([, value]) => value.at <= state.now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!task) break;
      timers.delete(task[0]); task[1].fn(); await drain();
    }
    await drain();
  };
  const policy = sourcePolicyFixture(uni);
  const host = { uni, Date: Clock, setTimeout, clearTimeout, ...policy };
  const fs = {
    activeMetaPack: () => state.pack, activePack: () => null,
    ensureLocalStateRestored: async () => { if (state.restoreGate) await state.restoreGate.promise; },
    readPackArtifact: async () => '/*__QT_PACK__' + JSON.stringify(state.pack) + '*/\n//owned fixture, never executed',
    ARTIFACT_META: 'meta-bundle.js', ARTIFACT_PLAY: 'play-bundle.js', ARTIFACT_CHAIN: 'chain.json', PACK_KIND_META: 'meta',
    packs: () => state.pack ? [state.pack] : [], localState: () => ({ packs: [], activeId: '', activeMetaId: state.pack?.id ?? '' }),
  };
  const finish = (entry, value) => {
    assert.ok(entry && !entry.finished, 'owned callback exists and is only completed once');
    entry.finished = true; entry.cb({ ok: true, error: '', value: JSON.stringify(value) });
  };
  const fail = (entry, message) => { entry.finished = true; entry.cb({ ok: false, error: message, value: '' }); };
  const defaultResult = entry => {
    if (entry.name === 'bundleInfo') return { name: 'meta-bundle', hostApiVersion: 1, sourcePolicyVersion: 1 };
    if (entry.name === 'setSourcePolicy') return { ok: true, playSupported: null };
    if (entry.name === 'setAuth') return state.ack;
    if (entry.name === 'clearAuth') return { ok: true };
    if (entry.name === 'sourceRegistry') return state.registryPayload;
    if (entry.name === 'accountDailySongs' || entry.name === 'accountFmNext') {
      return state.batch(entry.args.source, entry.name === 'accountDailySongs' ? 'daily' : 'fm', entry.args.accountId);
    }
    throw new Error('Unexpected owned native entry: ' + entry.name);
  };
  const native = {
    start(_options, cb) { state.running = true; state.healthy = true; cb({ engine: 'owned-v8', version: 'fixture', hostApiVersion: 1, probe: '2' }, null); },
    stop(cb) { state.running = false; cb({ ok: true, error: '' }); },
    isRunning: () => state.running, isHealthy: () => state.running && state.healthy,
    loadBundle(_code, cb) { cb({ ok: true, error: '' }); },
    loadPlayBundle() { throw new Error('No playback package in this fixture'); },
    evaluate(_code, cb) { cb({ ok: true, error: '', value: 'null' }); },
    invoke(name, argsJson, timeoutMs, cb) {
      const entry = { name, args: JSON.parse(argsJson)[0] ?? {}, timeoutMs, cb, finished: false };
      state.calls.push(entry);
      if ((state.holds.get(name) ?? 0) > 0) {
        state.holds.set(name, state.holds.get(name) - 1); state.pending.push(entry); return;
      }
      finish(entry, defaultResult(entry));
    },
  };
  const logger = Object.fromEntries(['logErr', 'logErrV', 'logInfo', 'logWarn', 'logWarnV'].map(name => [name, (...args) => logs.push(args)]));
  const header = loadProduction('services/source-pack-header.uts', host);
  const engine = loadProduction('services/source-engine.uts', { ...host, ...fs, ...native, ...logger, ...header });
  const auth = loadProduction('services/source-auth.ts', { ...host, ...engine });
  const profiles = new Map();
  const quality = {
    PROFILE_MODE_OFFICIAL: 'official', cachedQualityProfileOf: id => profiles.get(id) ?? null,
    clearQualityProfiles: () => profiles.clear(), storeQualityProfile: (id, value) => profiles.set(id, value),
    fetchSourceQualityProfile: async id => ({ source: id, mode: 'platform', qualities: [] }),
    sourcePlayQualityOf: (_source, fallback) => fallback, sourceDownloadQualityOf: (_source, fallback) => fallback, sourcePlayQualityForNetwork: (_source, fallback) => fallback, sourceDownloadQualityForNetwork: (_source, fallback) => fallback, setSourcePlayQualityForNetwork: noop, setSourceDownloadQualityForNetwork: noop, NETWORK_KIND_WIFI: 'wifi', NETWORK_KIND_CELLULAR: 'cellular',
    setSourcePlayQuality: noop, setSourceDownloadQuality: noop,
  };
  const { musicApi } = loadProduction('services/music-api.ts', { ...host, ...fs, ...engine, ...auth, ...quality, ...logger,
    qtDiag: noop, isLoggedIn: () => false, apiRequest: () => { throw new Error('Network is forbidden'); },
  }, ['musicApi']);
  const sourceStore = loadProduction('stores/source.ts', { ...host, ...logger, reactive: Vue.reactive });
  const { useSourceRegistryStore } = loadProduction('stores/source-registry.ts', {
    ...host, ...engine, ...auth, ...sourceStore, ...quality, musicApi, reactive: Vue.reactive,
    SOURCE_PACKS_CHANGED_EVENT: 'qt-source-packs-changed', usePlayerStore: () => ({ quality: '320' }),
    useDownloadsStore: () => ({ downloadQuality: '320' }),
  });
  const choice = loadProduction('stores/recommendation-source.ts', { ...host, createPinia, defineStore });
  const service = loadProduction('services/account-recommendation.ts', { ...host, ...fs, ...engine, ...auth, ...choice, useSourceRegistryStore });
  const hold = (name, count = 1) => state.holds.set(name, (state.holds.get(name) ?? 0) + count);
  const pending = name => state.pending.find(entry => entry.name === name && !entry.finished);
  const saveAccount = async (source = 'wyy', id = 'A') => {
    state.now++;
    await auth.saveSourceAuthAccount(source, 'FIXTURE_META=' + id + '; synthetic=only',
      { id, nickname: '用户' + id, avatar: '', vip: false, vipLabel: '' }, '');
    await drain();
  };
  const ready = async () => { assert.equal(await engine.ensureDataEngine(), true); await useSourceRegistryStore().ensure(); await drain(); };
  return { state, storage, events, timers, logs, uni, policy, engine, auth, musicApi, registry: useSourceRegistryStore(), choice, service,
    hold, pending, finish: (entry, value = defaultResult(entry)) => finish(entry, value), fail, ready, saveAccount, drain, advance };
}

async function runChecks() {
  let passed = 0;
  const check = async (name, run) => { await run(); passed++; console.log('PASS ' + name); };
  const accountCalls = f => f.state.calls.filter(entry => entry.name === 'accountDailySongs' || entry.name === 'accountFmNext');
  await check('prepare/fetch wait for the successful meta setAuth ACK and pass only source/accountId', async () => {
    const f = accountRecommendationFixture(); await f.ready(); f.hold('setAuth');
    const saving = f.saveAccount(); await drain();
    let prepared = false;
    const request = f.service.prepareAccountRecommendationContext('wyy', 'daily').then(context => { prepared = true; return context; });
    await drain(); assert.equal(prepared, false); assert.equal(accountCalls(f).length, 0);
    f.finish(f.pending('setAuth'), { ok: true }); await saving;
    const context = await request; assert.equal(f.service.accountRecommendationContextCurrent(context), true);
    assert.deepEqual(Object.keys(context).sort(), ['sourceId', 'kind', 'accountId', 'nickname', 'accountSession', 'authRevision', 'metaAuthRevision', 'metaRevision', 'policyRevision', 'engineEpoch'].sort());
    const batch = await f.service.fetchAccountDailySongs(context);
    assert.equal(batch.items.length, 1);
    assert.deepEqual(accountCalls(f).map(entry => entry.args), [{ source: 'wyy', accountId: 'A' }]);
    assert.equal(JSON.stringify(context).includes('FIXTURE_META'), false);
  });
  await check('transport success with ok:false is not a strict authorization ACK', async () => {
    for (const ack of [{ ok: false }, {}, { ok: 'true' }, { ok: 1 }, { ok: null }]) {
      const f = accountRecommendationFixture(); await f.ready(); f.state.ack = ack; await f.saveAccount();
      await assert.rejects(f.service.prepareAccountRecommendationContext('wyy', 'daily'), /ACCOUNT_RECOMMENDATIONS_AUTH_REQUIRED/);
      assert.equal(accountCalls(f).length, 0);
    }
  });
  await check('cold engine readiness does not revoke its first valid account context', async () => {
    const f = accountRecommendationFixture(), installed = f.state.pack;
    f.state.pack = null; await f.saveAccount(); f.state.pack = installed; await f.engine.shutdownEngine();
    const coldEpoch = f.engine.sourceEngineEpoch();
    const context = await f.service.prepareAccountRecommendationContext('wyy', 'daily');
    assert.equal(context.engineEpoch, coldEpoch); assert.equal(f.state.running, true);
    assert.equal(f.service.accountRecommendationContextCurrent(context), true);
    assert.equal((await f.service.fetchAccountDailySongs(context)).items.length, 1);
  });
  await check('WYY/KG daily/FM follow the explicit registry declarations and stay fail-closed without them', async () => {
    const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount(); await f.saveAccount('kg', 'K');
    assert.equal(f.registry.supportsAccountRecommendation('wyy', 'daily'), true);
    assert.equal(f.registry.supportsAccountRecommendation('wyy', 'fm'), true);
    assert.equal(f.registry.supportsAccountRecommendation('kg', 'daily'), true);
    // 2026-11-14 用户裁定对齐桌面四源口径：KG FM 不再被应用层单独禁用，
    // 但注册表未显式声明 fm:true 时仍 fail-closed。
    assert.equal(f.state.registryPayload.sources[1].accountRecommendations.fm, undefined);
    assert.equal(f.registry.supportsAccountRecommendation('kg', 'fm'), false);
    await assert.rejects(f.service.prepareAccountRecommendationContext('kg', 'fm'), /ACCOUNT_RECOMMENDATIONS_UNSUPPORTED/);
    const kg = await f.service.prepareAccountRecommendationContext('kg', 'daily');
    assert.equal((await f.service.fetchAccountDailySongs(kg)).source, 'kg');
    f.state.registryPayload.sources[1].accountRecommendations.fm = true; await f.registry.refresh();
    assert.equal(f.registry.supportsAccountRecommendation('kg', 'fm'), true);
    const kgFm = await f.service.prepareAccountRecommendationContext('kg', 'fm');
    const fmBatch = await f.service.fetchAccountFmNext(kgFm);
    assert.equal(fmBatch.source, 'kg'); assert.equal(fmBatch.kind, 'fm'); assert.equal(fmBatch.items.length, 1);
    // 账号 FM 只产生 accountFmNext 读取；应用层从不提交喜欢/跳过/播放进度反馈。
    assert.deepEqual(accountCalls(f).filter(entry => entry.name === 'accountFmNext').map(entry => entry.args), [{ source: 'kg', accountId: 'K' }]);
    for (const capability of [undefined, {}, { daily: 'true' }, { daily: 1 }, { daily: false }, { fm: true }, true, []]) {
      f.state.registryPayload.sources[0].accountRecommendations = capability; await f.registry.refresh();
      const parsed = await f.musicApi.sourceRegistry();
      assert.notEqual(parsed.sources[0].accountRecommendations?.daily, true);
      await assert.rejects(f.service.prepareAccountRecommendationContext('wyy', 'daily'), /ACCOUNT_RECOMMENDATIONS_UNSUPPORTED/);
    }
    assert.equal(accountCalls(f).filter(entry => entry.name !== 'accountDailySongs' && entry.name !== 'accountFmNext').length, 0, 'the app only ever calls the two read-only recommendation entries');
  });
  await check('no login, disabled meta and disabled platforms fail closed without enabling permissions', async () => {
    const f = accountRecommendationFixture(); await f.ready();
    await assert.rejects(f.service.prepareAccountRecommendationContext('wyy', 'daily'), /ACCOUNT_RECOMMENDATIONS_AUTH_REQUIRED/);
    await f.saveAccount(); await f.auth.setSourceAuthToggle('wyy', 'meta', false);
    await assert.rejects(f.service.prepareAccountRecommendationContext('wyy', 'daily'), /ACCOUNT_RECOMMENDATIONS_AUTH_REQUIRED/);
    assert.equal(f.auth.readSourceAuthTogglesFor('wyy').useMeta, false);
    f.policy.toggleSource('wyy', ['wyy', 'kg', 'qq']);
    await assert.rejects(f.service.prepareAccountRecommendationContext('wyy', 'daily'), /ACCOUNT_RECOMMENDATIONS_SOURCE_DISABLED/);
    assert.equal(accountCalls(f).length, 0);
  });
  await check('batch reconstruction preserves counts/order/duplicates/opaque data and all valid optionals', async () => {
    const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
    const context = await f.service.prepareAccountRecommendationContext('wyy', 'fm');
    const first = { ...rawSong('id:/?%=00'), interval: 0, musicId: null, version: '', isrc: '', durationReliable: false };
    const second = { ...rawSong('009999999999999999999'), interval: 321.125, musicId: 'hash:opaque/%', version: 'Live', isrc: 'CN-opaque', durationReliable: true };
    f.state.batch = (source, kind, accountId) => ({ source, kind, accountId, fetchedAt: 9007199254740991,
      expiresAt: 0.125, exhausted: false, cursor: '', items: [first, second, first], cookie: 'FIXTURE_META=untrusted' });
    const batch = await f.service.fetchAccountFmNext(context, ' cursor:/%+00 ');
    assert.deepEqual(plain(batch), { source: 'wyy', kind: 'fm', accountId: 'A', fetchedAt: 9007199254740991,
      expiresAt: 0.125, exhausted: false, cursor: '', items: [
        { id: 'id:/?%=00', name: '歌名', singer: '歌手', album: '', picUrl: '', platform: 'wyy', duration: 0, musicId: null, version: '', isrc: '', durationReliable: false },
        { id: '009999999999999999999', name: '歌名', singer: '歌手', album: '', picUrl: '', platform: 'wyy', duration: 321.125, musicId: 'hash:opaque/%', version: 'Live', isrc: 'CN-opaque', durationReliable: true },
        { id: 'id:/?%=00', name: '歌名', singer: '歌手', album: '', picUrl: '', platform: 'wyy', duration: 0, musicId: null, version: '', isrc: '', durationReliable: false },
      ] });
    assert.deepEqual(accountCalls(f)[0].args, { source: 'wyy', accountId: 'A', cursor: ' cursor:/%+00 ' });
    f.state.batch = (source, kind, accountId) => ({ source, kind, accountId, fetchedAt: 0, items: [] });
    const empty = await f.service.fetchAccountFmNext(context, '');
    assert.equal(empty.items.length, 0); assert.equal(Object.hasOwn(empty, 'exhausted'), false);
    assert.equal(Object.hasOwn(empty, 'cursor'), false); assert.equal(Object.hasOwn(empty, 'expiresAt'), false);
    assert.deepEqual(accountCalls(f)[1].args, { source: 'wyy', accountId: 'A', cursor: '' });
  });
  await check('malformed items/optionals reject the whole batch and wrong identity is never adopted', async () => {
    const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
    const context = await f.service.prepareAccountRecommendationContext('wyy', 'daily');
    const valid = { source: 'wyy', kind: 'daily', accountId: 'A', items: [rawSong()], fetchedAt: 1.25 };
    for (const invalid of [null, [], { ...valid, source: 'kg' }, { ...valid, kind: 'fm' }, { ...valid, accountId: 'B' },
      { ...valid, items: 'not-array' }, { ...valid, fetchedAt: '1.25' }, { ...valid, cursor: null }, { ...valid, exhausted: 0 },
      { ...valid, expiresAt: '2' }, { ...valid, items: [rawSong(), { ...rawSong(), interval: '3' }] },
      { ...valid, items: [{ ...rawSong(), id: 2 }] }, { ...valid, items: [{ ...rawSong(), name: null }] },
      { ...valid, items: [{ ...rawSong(), musicId: 1 }] }, { ...valid, items: [{ ...rawSong(), version: null }] },
      { ...valid, items: [{ ...rawSong(), isrc: false }] }, { ...valid, items: [{ ...rawSong(), durationReliable: 'false' }] }]) {
      f.state.batch = () => invalid;
      await assert.rejects(f.service.fetchAccountDailySongs(context), /ACCOUNT_RECOMMENDATIONS_(MALFORMED_RESPONSE|ACCOUNT_MISMATCH)/);
    }
  });
  await check('daily/FM Pinia choices persist independently, reject ABA and never mutate auth', async () => {
    const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount(); await f.auth.setSourceAuthToggle('wyy', 'meta', false);
    const authBefore = plain(f.auth.readSourceAuthEntries()), nativeCount = f.state.calls.length;
    const { choice } = f;
    assert.deepEqual(plain(choice.readRecommendationChoice('daily')), { origin: 'app', sourceId: '' });
    choice.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'wyy' });
    const owned = choice.readRecommendationChoice('daily'), revision = choice.recommendationChoiceRevision('daily');
    choice.writeRecommendationChoice('fm', { origin: 'account', sourceId: 'kg' });
    assert.equal(choice.recommendationChoiceCurrent('daily', owned, revision), true);
    choice.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'kg' });
    choice.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'wyy' });
    assert.equal(choice.recommendationChoiceCurrent('daily', owned, revision), false, 'A to B to A is not the original selection lifetime');
    const nextRevision = choice.recommendationChoiceRevision('daily');
    choice.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'wyy' });
    assert.equal(choice.recommendationChoiceRevision('daily'), nextRevision, 'same choice has no spurious invalidation');
    const reloaded = loadProduction('stores/recommendation-source.ts', { uni: f.uni, createPinia, defineStore });
    assert.deepEqual(plain(reloaded.readRecommendationChoice('daily')), { origin: 'account', sourceId: 'wyy' });
    assert.deepEqual(plain(reloaded.readRecommendationChoice('fm')), { origin: 'account', sourceId: 'kg' });
    assert.deepEqual(plain(f.auth.readSourceAuthEntries()), authBefore); assert.equal(f.state.calls.length, nativeCount);
    assert.equal(f.auth.readSourceAuthTogglesFor('wyy').useMeta, false);
    assert.deepEqual(f.events.filter(([name]) => name === choice.RECOMMENDATION_SOURCE_CHANGED_EVENT).map(([, value]) => plain(value)),
      [{ kind: 'daily' }, { kind: 'fm' }, { kind: 'daily' }, { kind: 'daily' }]);
    for (const invalid of [null, {}, { origin: 'account', sourceId: '' }, { origin: 'account', sourceId: 'bad/source' }]) {
      assert.throws(() => choice.writeRecommendationChoice('fm', invalid), /ACCOUNT_RECOMMENDATIONS_INVALID_ARGS/);
    }
  });
  await check('usePlay toggles neither revoke a held recommendation nor replace the meta credential snapshot', async () => {
    const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
    const context = await f.service.prepareAccountRecommendationContext('wyy', 'daily');
    const countMeta = () => f.state.calls.filter(entry => entry.name === 'setAuth' && entry.args.scope === 'meta').length;
    const before = countMeta(); f.hold('accountDailySongs'); const fetching = f.service.fetchAccountDailySongs(context); await drain();
    await f.auth.setSourceAuthToggle('wyy', 'play', true); await f.auth.setSourceAuthToggle('wyy', 'play', false);
    assert.equal(countMeta(), before); assert.equal(f.service.accountRecommendationContextCurrent(context), true);
    f.finish(f.pending('accountDailySongs')); assert.equal((await fetching).items.length, 1);
  });
  await check('caller cancellation after actual engine readiness waits prevents both account entry dispatches', async () => {
    for (const kind of ['daily', 'fm']) {
      const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
      const context = await f.service.prepareAccountRecommendationContext('wyy', kind); let alive = true;
      f.state.restoreGate = deferred();
      const fetching = kind === 'daily' ? f.service.fetchAccountDailySongs(context, () => alive)
        : f.service.fetchAccountFmNext(context, undefined, () => alive);
      const rejected = assert.rejects(fetching, /ACCOUNT_RECOMMENDATIONS_AUTH_CHANGED/);
      await drain(); assert.equal(accountCalls(f).length, 0); alive = false;
      f.state.restoreGate.resolve(); await rejected; await drain();
      assert.equal(accountCalls(f).length, 0); assert.equal(f.service.accountRecommendationContextCurrent(context), true);
    }
  });
  await check('caller cancellation after held native policy ACK prevents daily and FM pre-dispatch', async () => {
    for (const kind of ['daily', 'fm']) {
      const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
      f.hold('setSourcePolicy'); f.policy.toggleSource('qq', ['wyy', 'kg', 'qq']); await drain();
      assert.ok(f.pending('setSourcePolicy'), 'test actually holds native policy acknowledgement');
      const context = await f.service.prepareAccountRecommendationContext('wyy', kind); let alive = true;
      const fetching = kind === 'daily' ? f.service.fetchAccountDailySongs(context, () => alive)
        : f.service.fetchAccountFmNext(context, 'owned-cursor', () => alive);
      const rejected = assert.rejects(fetching, /ACCOUNT_RECOMMENDATIONS_AUTH_CHANGED/); await drain();
      assert.equal(accountCalls(f).length, 0); alive = false; f.finish(f.pending('setSourcePolicy'));
      await rejected; await drain(); assert.equal(accountCalls(f).length, 0);
      assert.equal(f.service.accountRecommendationContextCurrent(context), true, 'the separate caller lifetime is the revocation');
    }
  });
  await check('deletion/account ABA/meta ABA/policy ABA/package changes and engine reset revoke before dispatch', async () => {
    for (const reason of ['delete', 'same-account-relogin', 'account-aba', 'meta-aba', 'policy-aba', 'pack-id', 'pack-code', 'pack-updated-at', 'engine']) {
      const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
      const context = await f.service.prepareAccountRecommendationContext('wyy', 'daily');
      f.state.restoreGate = deferred(); const fetching = f.service.fetchAccountDailySongs(context);
      const rejected = assert.rejects(fetching, /ACCOUNT_RECOMMENDATIONS_AUTH_CHANGED/); await drain();
      const changes = [], originalTime = f.state.now;
      if (reason === 'delete' || reason === 'same-account-relogin') changes.push(f.auth.removeSourceAuthAccount('wyy'));
      if (reason === 'same-account-relogin') { f.state.now = originalTime - 1; changes.push(f.saveAccount()); }
      if (reason === 'account-aba') { changes.push(f.saveAccount('wyy', 'B')); f.state.now = originalTime - 1; changes.push(f.saveAccount()); }
      if (reason === 'meta-aba') { changes.push(f.auth.setSourceAuthToggle('wyy', 'meta', false)); changes.push(f.auth.setSourceAuthToggle('wyy', 'meta', true)); }
      if (reason === 'policy-aba') { f.policy.toggleSource('wyy', ['wyy', 'kg', 'qq']); f.policy.toggleSource('wyy', ['wyy', 'kg', 'qq']); }
      if (reason === 'pack-id') f.state.pack = { ...f.state.pack, id: 'meta-other' };
      if (reason === 'pack-code') f.state.pack = { ...f.state.pack, versionCode: 2 };
      if (reason === 'pack-updated-at') f.state.pack = { ...f.state.pack, updatedAt: 101 };
      if (reason === 'engine') changes.push(f.engine.shutdownEngine());
      assert.equal(f.service.accountRecommendationContextCurrent(context), false, reason + ' loses its original lifetime');
      f.state.restoreGate.resolve(); await Promise.all(changes); await rejected; await drain();
      assert.equal(accountCalls(f).length, 0, reason + ' cannot dispatch a late account action');
    }
  });
  await check('all lifetimes and caller cancellation reject already dispatched late daily/FM replies', async () => {
    for (const reason of ['delete', 'account-aba', 'meta-aba', 'policy-aba', 'pack-aba', 'engine', 'caller']) {
      const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
      const context = await f.service.prepareAccountRecommendationContext('wyy', 'fm'); let alive = true;
      f.hold('accountFmNext'); const fetching = f.service.fetchAccountFmNext(context, 'cursor-old', () => alive);
      const rejected = assert.rejects(fetching, /ACCOUNT_RECOMMENDATIONS_AUTH_CHANGED/); await drain();
      assert.equal(accountCalls(f).length, 1, 'test actually dispatches before revocation');
      if (reason === 'delete') await f.auth.removeSourceAuthAccount('wyy');
      if (reason === 'account-aba') { await f.saveAccount('wyy', 'B'); await f.saveAccount(); }
      if (reason === 'meta-aba') { await f.auth.setSourceAuthToggle('wyy', 'meta', false); await f.auth.setSourceAuthToggle('wyy', 'meta', true); }
      if (reason === 'policy-aba') { f.policy.toggleSource('wyy', ['wyy', 'kg', 'qq']); f.policy.toggleSource('wyy', ['wyy', 'kg', 'qq']); await drain(); }
      if (reason === 'pack-aba') {
        const original = f.state.pack; f.state.pack = { ...original, versionCode: 2, updatedAt: 102 };
        await f.engine.reloadEngineMeta(); f.state.pack = original; await f.engine.reloadEngineMeta();
      }
      if (reason === 'engine') { await f.engine.shutdownEngine(); await f.engine.ensureDataEngine(); }
      if (reason === 'caller') alive = false;
      f.finish(f.pending('accountFmNext')); await rejected; await drain();
      assert.equal(accountCalls(f).length, 1, reason + ' cannot create a replacement/public request');
    }
  });
  await check('late setAuth ACK from a replaced account cannot certify the older preparation', async () => {
    const f = accountRecommendationFixture(); await f.ready(); f.hold('setAuth');
    const oldSave = f.saveAccount(); await drain();
    const preparing = f.service.prepareAccountRecommendationContext('wyy', 'daily');
    const rejected = assert.rejects(preparing, /ACCOUNT_RECOMMENDATIONS_AUTH_CHANGED/); await drain();
    const newerSave = f.saveAccount('wyy', 'B'); f.finish(f.pending('setAuth'), { ok: true });
    await Promise.all([oldSave, newerSave]); await rejected;
    assert.equal(accountCalls(f).length, 0);
    const current = await f.service.prepareAccountRecommendationContext('wyy', 'daily');
    assert.equal(current.accountId, 'B'); assert.equal(f.service.accountRecommendationContextCurrent(current), true);
  });
  await check('timeouts during readiness/policy/native waits never allow a late dispatch or adopted reply', async () => {
    for (const phase of ['readiness', 'policy', 'native']) {
      const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
      if (phase === 'policy') { f.hold('setSourcePolicy'); f.policy.toggleSource('qq', ['wyy', 'kg', 'qq']); await drain(); }
      const context = await f.service.prepareAccountRecommendationContext('wyy', 'daily');
      if (phase === 'readiness') f.state.restoreGate = deferred();
      if (phase === 'native') f.hold('accountDailySongs');
      const fetching = f.service.fetchAccountDailySongs(context);
      const rejected = assert.rejects(fetching, /ACCOUNT_RECOMMENDATIONS_TIMEOUT/); await drain();
      assert.equal(accountCalls(f).length, phase === 'native' ? 1 : 0);
      await f.advance(30001); await rejected;
      if (phase === 'readiness') f.state.restoreGate.resolve();
      if (phase === 'policy') f.finish(f.pending('setSourcePolicy'));
      if (phase === 'native') f.finish(f.pending('accountDailySongs'));
      await drain(); assert.equal(accountCalls(f).length, phase === 'native' ? 1 : 0);
    }
  });
  await check('a strict preparation timeout includes time behind the existing auth reconciliation queue', async () => {
    const f = accountRecommendationFixture(); await f.ready(); f.hold('setAuth');
    const saving = f.saveAccount(); await drain();
    const preparing = f.service.prepareAccountRecommendationContext('wyy', 'daily');
    const observed = preparing.then(value => ({ ok: true, value }), error => ({ ok: false, error })); await drain();
    await f.advance(30001); const result = await observed;
    assert.equal(result.ok, false, 'total deadline must cover the auth queue, not restart after an earlier wait');
    assert.match(result.error.message, /ACCOUNT_RECOMMENDATIONS_TIMEOUT/);
    f.finish(f.pending('setAuth'), { ok: true }); await saving; await drain();
    assert.equal(accountCalls(f).length, 0);
  });
  await check('safe errors/context/args/batch/choice storage never expose credential or native exception suffixes', async () => {
    const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
    const context = await f.service.prepareAccountRecommendationContext('wyy', 'daily');
    for (const code of ['UNSUPPORTED', 'AUTH_REQUIRED', 'AUTH_EXPIRED', 'ACCOUNT_MISMATCH', 'AUTH_CHANGED', 'NETWORK', 'RATE_LIMIT', 'UPSTREAM', 'MALFORMED_RESPONSE', 'INVALID_ARGS', 'TIMEOUT', 'SOURCE_DISABLED', 'UNKNOWN']) {
      const unsafe = new Error('ACCOUNT_RECOMMENDATIONS_' + code + ': Cookie FIXTURE_META=A; https://fixture.invalid/private');
      assert.doesNotMatch(f.service.accountRecommendationErrorMessage(unsafe), /FIXTURE_META|Cookie|https:/);
    }
    assert.doesNotMatch(f.service.accountRecommendationErrorMessage(new Error('native private FIXTURE_META=A')), /FIXTURE_META|native private/);
    f.hold('accountDailySongs'); const fetching = f.service.fetchAccountDailySongs(context); await drain();
    f.fail(f.pending('accountDailySongs'), 'ACCOUNT_RECOMMENDATIONS_RATE_LIMIT: Cookie FIXTURE_META=A; https://fixture.invalid/private');
    await assert.rejects(fetching, error => error.message === 'ACCOUNT_RECOMMENDATIONS_RATE_LIMIT');
    assert.doesNotMatch(JSON.stringify(f.logs), /FIXTURE_META|Cookie|https:\/\/fixture.invalid\/private/);
    assert.doesNotMatch(JSON.stringify(context), /FIXTURE_META/);
    for (const entry of f.state.calls) if (entry.name !== 'setAuth') assert.doesNotMatch(JSON.stringify(entry.args), /FIXTURE_META|cookie/i);
    f.choice.writeRecommendationChoice('daily', { origin: 'account', sourceId: 'wyy' });
    for (const [key, value] of f.storage) if (key !== 'qt-source-auth-accounts') assert.doesNotMatch(String(value), /FIXTURE_META/);
    const cancelled = f.service.fetchAccountDailySongs(context, () => { throw new Error('private FIXTURE_META=A'); });
    await assert.rejects(cancelled, error => error.message === 'ACCOUNT_RECOMMENDATIONS_AUTH_CHANGED');
  });
  await check('direct strict meta authorization also times out behind the queue before delayed timer delivery', async () => {
    const f = accountRecommendationFixture(); await f.ready(); f.hold('setAuth'); const saving = f.saveAccount(); await drain();
    const identity = f.auth.readSourceMetaAuthIdentity('wyy');
    const request = f.auth.ensureSourceMetaAuthInjected(identity, () => true);
    const observed = request.then(() => ({ ok: true }), error => ({ ok: false, error })); await drain();
    await f.advance(30001); const result = await observed;
    assert.equal(result.ok, false); assert.equal(result.error.message, 'ACCOUNT_RECOMMENDATIONS_TIMEOUT');
    assert.equal(f.state.calls.filter(entry => entry.name === 'setAuth').length, 1, 'timed-out strict request does not start a new injection');
    f.finish(f.pending('setAuth')); await saving; await drain();
  });
  await check('a native account reply beyond its deadline is rejected even before its timer runs', async () => {
    const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
    const context = await f.service.prepareAccountRecommendationContext('wyy', 'daily'); f.hold('accountDailySongs');
    const fetching = f.service.fetchAccountDailySongs(context);
    const observed = fetching.then(value => ({ ok: true, value }), error => ({ ok: false, error })); await drain();
    f.state.now += 30001; f.finish(f.pending('accountDailySongs')); await drain();
    const result = await observed; assert.equal(result.ok, false, 'deadline is not merely a timer hint');
    assert.equal(result.error.message, 'ACCOUNT_RECOMMENDATIONS_TIMEOUT');
  });
  await check('an unavailable new registry may retain labels but cannot reuse old account capabilities', async () => {
    const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
    const old = await f.service.prepareAccountRecommendationContext('wyy', 'daily');
    f.state.pack = { ...f.state.pack, versionCode: 2, updatedAt: 102 }; await f.engine.reloadEngineMeta();
    f.state.registryPayload = null; await f.registry.refresh();
    assert.equal(f.registry.supportsAccountRecommendation('wyy', 'daily'), false);
    assert.equal(f.service.accountRecommendationContextCurrent(old), false);
    await assert.rejects(f.service.prepareAccountRecommendationContext('wyy', 'daily'), /ACCOUNT_RECOMMENDATIONS_UNSUPPORTED/);
    assert.equal(accountCalls(f).length, 0);
  });
  await check('daily/FM facade settlement cannot adopt a batch after the final engine clock sample expired', async () => {
    for (const kind of ['daily', 'fm']) {
      const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
      const context = await f.service.prepareAccountRecommendationContext('wyy', kind);
      const action = kind === 'daily' ? 'accountDailySongs' : 'accountFmNext'; f.hold(action);
      const fetching = kind === 'daily' ? f.service.fetchAccountDailySongs(context) : f.service.fetchAccountFmNext(context);
      const observed = fetching.then(value => ({ ok: true, value }), error => ({ ok: false, error })); await drain();
      // Advance the synthetic wall clock just after its second post-reply sample, without firing timers.
      let now = f.state.now, samples = 0;
      Object.defineProperty(f.state, 'now', { configurable: true, get() {
        const sample = now; if (++samples === 2) now += 30001; return sample;
      }, set(value) { now = value; } });
      f.finish(f.pending(action)); await drain(); const result = await observed;
      assert.ok(samples >= 2); assert.equal(result.ok, false, 'SDK facade also owns the total deadline at settlement');
      assert.equal(result.error.message, 'ACCOUNT_RECOMMENDATIONS_TIMEOUT');
    }
  });
  await check('same-id/code reimport reload pipeline admits a new context and ACK after updatedAt changes', async () => {
    const f = accountRecommendationFixture(); await f.ready(); await f.saveAccount();
    const old = await f.service.prepareAccountRecommendationContext('wyy', 'daily');
    const metaAcks = () => f.state.calls.filter(entry => entry.name === 'setAuth' && entry.args.scope === 'meta').length;
    const beforeAcks = metaAcks(), beforeBundles = f.state.calls.filter(entry => entry.name === 'bundleInfo').length;
    f.hold('accountDailySongs'); const late = f.service.fetchAccountDailySongs(old);
    const rejected = assert.rejects(late, /ACCOUNT_RECOMMENDATIONS_AUTH_CHANGED/); await drain();
    f.state.pack = { ...f.state.pack, updatedAt: f.state.pack.updatedAt + 1 };
    // Actual public installFromText → installPackTextLocked always calls reloadEngineMeta, even at the same code:
    // services/source-update.uts:536-548,634,681,743-755; switching uses the same engine pipeline at 891.
    assert.equal(await f.engine.reloadEngineMeta(), true);
    const fresh = await f.service.prepareAccountRecommendationContext('wyy', 'daily');
    assert.equal(f.service.accountRecommendationContextCurrent(old), false);
    assert.equal(f.service.accountRecommendationContextCurrent(fresh), true);
    assert.notEqual(fresh.metaRevision, old.metaRevision); assert.notEqual(fresh.engineEpoch, old.engineEpoch);
    assert.ok(metaAcks() > beforeAcks, 'the real meta-load auth hook obtains a new ACK');
    assert.ok(f.state.calls.filter(entry => entry.name === 'bundleInfo').length > beforeBundles, 'the real engine loads the replacement');
    f.finish(f.pending('accountDailySongs')); await rejected;
    assert.equal((await f.service.fetchAccountDailySongs(fresh)).accountId, 'A');
  });
  console.log(`Account recommendations: ${passed} production VM groups passed; no real HTTP/accounts/native build.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runChecks();
