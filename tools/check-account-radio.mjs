// Agreed seams: complete production RadioStore, real recommendation choice/context
// facade and real PlayerStore queue/persistence methods. Only Vue/Pinia, owned
// storage/events/time, source-engine/auth and audio-play resource boundaries are synthetic.
// No networking, real credentials, native compilation or copied radio implementation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { sourcePolicyFixture } from './source-policy-fixture.mjs';
import { accountRecommendationFixture, drain as drainNative } from './check-account-recommendations.mjs';

export const readProduction = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
export const noop = () => {};
export const plain = value => JSON.parse(JSON.stringify(value));
export const track = (id, platform = 'wyy') => ({ id, platform, name: `Song ${id}`, singer: 'Fixture singer', album: '', picUrl: '', duration: 200 });
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function drain() { for (let n = 0; n < 80; n++) await Promise.resolve(); }
export class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return Object.hasOwn(this, key) ? this[key] : null; }
  getString(key) { return this.get(key); }
  getNumber(key) { return this.get(key); }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}
export function parseJsonToUtso(text) {
  const convert = value => Array.isArray(value) ? value.map(convert) : value != null && typeof value === 'object'
    ? new UTSJSONObject(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item)]))) : value;
  return convert(JSON.parse(text));
}
export function loadProduction(text, names, boundary = {}, filename = 'production.ts') {
  const script = text.includes('<script setup') ? text.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1] : text;
  const clean = script.replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, '');
  const js = stripTypeScriptTypes(clean, { mode: 'strip' }).replace(/^export\s+/gm, '');
  const context = vm.createContext({ console, UTSJSONObject, parseJsonToUtso, ...boundary });
  return vm.runInContext(js + `\n;({${names.join(',')}});`, context, { filename });
}
function classSource(path, start, end) {
  const text = readProduction(path), first = text.indexOf(start), last = text.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `real ${path} class must exist`);
  return text.slice(first, last);
}
export function ownedHost() {
  const storage = new Map(), writes = [], events = [], listeners = new Map(), intervals = new Map(), timeouts = new Map();
  let clock = 100000, nextTimer = 1;
  const uni = {
    getStorageSync: key => storage.get(key) ?? '',
    setStorageSync: (key, value) => { writes.push([key, value]); storage.set(key, value); },
    removeStorageSync: key => storage.delete(key),
    $on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
    $off: (event, fn) => listeners.get(event)?.delete(fn),
    $emit: (event, ...args) => { events.push([event, ...args]); for (const fn of [...(listeners.get(event) ?? [])]) fn(...args); },
  };
  const timers = {
    Date: class extends Date { static now() { return clock; } },
    setInterval: (fn, delay) => { const id = nextTimer++; intervals.set(id, { fn, delay }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, delay) => { const id = nextTimer++; timeouts.set(id, { fn, delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
  };
  return { storage, writes, events, listeners, intervals, timeouts, uni, timers,
    now: () => clock, advance: milliseconds => { clock += milliseconds; },
    pulse: async () => { for (const { fn } of [...intervals.values()]) fn(); await drain(); } };
}
export function choiceFixture(host) {
  const instances = new Map();
  return loadProduction(readProduction('stores/recommendation-source.ts'), [
    'readRecommendationChoice', 'writeRecommendationChoice', 'recommendationChoiceRevision',
    'recommendationChoiceCurrent', 'RECOMMENDATION_SOURCE_CHANGED_EVENT',
  ], {
    uni: host.uni, createPinia: () => ({}),
    defineStore: (id, options) => () => { if (!instances.has(id)) instances.set(id, options.state()); return instances.get(id); },
  }, 'stores/recommendation-source.ts');
}
export function environmentFixture(host) {
  const policy = sourcePolicyFixture(host.uni);
  const calls = [], requests = [], banned = new Set(), feedback = [];
  const settlement = { afterFacade: null };
  const state = { authRevision: 0, metaAuthRevision: 0, accountSession: 'owned-session-0', accountId: 'owned-account-A',
    nickname: 'Fixture A', useMeta: true, usePlay: false, loggedIn: true, acknowledged: true,
    epoch: 'owned-engine-0', pack: { id: 'owned-pack-A', versionCode: 1, updatedAt: 1 }, prepareGate: null };
  const metaRevision = () => JSON.stringify([state.epoch, state.pack]);
  const identity = sourceId => !state.loggedIn || !state.useMeta ? null : ({ sourceId, accountId: state.accountId,
    nickname: state.nickname, accountSession: state.accountSession, authRevision: state.authRevision, metaAuthRevision: state.metaAuthRevision });
  const identityCurrent = value => {
    const current = value == null ? null : identity(value.sourceId);
    return current != null && ['sourceId', 'accountId', 'accountSession', 'authRevision', 'metaAuthRevision'].every(key => value[key] === current[key]);
  };
  const catalog = [
    { id: 'wyy', accountRecommendations: { daily: true, fm: true } },
    { id: 'kg', accountRecommendations: { daily: true, fm: true } },
    { id: 'qq', accountRecommendations: { daily: false, fm: false } },
  ];
  const { SourceRegistryStore } = loadProduction(classSource('stores/source-registry.ts', 'class SourceRegistryStore {', '\nconst sourceRegistryStore ='), ['SourceRegistryStore'], {
    ...policy, sourceMetaCurrent: revision => revision === metaRevision(),
  }, 'stores/source-registry.ts');
  const registry = new SourceRegistryStore();
  Object.assign(registry, { catalog, sources: catalog, ready: true, accountMetaRevision: metaRevision() });
  const sourceBoundary = {
    ...policy, ...host.timers, uni: host.uni, useSourceRegistryStore: () => registry,
    activeMetaPack: () => state.pack, ensureLocalStateRestored: async () => { if (state.prepareGate) await state.prepareGate.promise; },
    ensureDataEngine: async () => true, sourceEngineEpoch: () => state.epoch,
    sourceMetaRevision: metaRevision, sourceMetaCurrent: revision => revision === metaRevision(),
    readSourceMetaAuthIdentity: identity, sourceMetaAuthCurrent: identityCurrent,
    sourceMetaAuthAcknowledged: value => identityCurrent(value) && state.acknowledged,
    ensureSourceMetaAuthInjected: async () => { calls.push(['inject']); },
    invokeSource: (action, args, timeout, current) => {
      calls.push([action, JSON.parse(args), timeout]);
      assert.equal(action, 'accountFmNext', 'account FM cannot call anonymous recommendation or official feedback actions');
      const d = deferred(); requests.push({ action, args: JSON.parse(args)[0], timeout, current, ...d }); return d.promise;
    },
  };
  const account = loadProduction(readProduction('services/account-recommendation.ts'), [
    'prepareAccountRecommendationContext', 'accountRecommendationContextCurrent', 'fetchAccountFmNext', 'accountRecommendationErrorMessage',
  ], sourceBoundary, 'services/account-recommendation.ts');
  function change(type, { emit = true } = {}) {
    let event = 'qt-source-auth-changed';
    if (type === 'relogin') { state.authRevision++; state.accountSession = `owned-session-${state.authRevision}`; }
    else if (type === 'account') { state.authRevision++; state.accountId = 'owned-account-B'; state.accountSession = 'owned-session-B'; }
    else if (type === 'logout') { state.loggedIn = false; state.authRevision++; }
    else if (type === 'meta') { state.useMeta = !state.useMeta; state.metaAuthRevision++; }
    else if (type === 'play') state.usePlay = !state.usePlay;
    else if (type === 'pack') { state.pack = { ...state.pack, updatedAt: state.pack.updatedAt + 1 }; registry.accountMetaRevision = metaRevision(); event = 'qt-source-packs-changed'; }
    else if (type === 'policy') { policy.toggleSource('wyy', ['wyy', 'kg', 'qq']); return; }
    else if (type === 'epoch') { state.epoch += '-next'; registry.accountMetaRevision = metaRevision(); event = 'qt-source-packs-changed'; }
    else throw new Error(`unknown fixture mutation ${type}`);
    if (emit) host.uni.$emit(event);
  }
  return { state, registry, policy, account, requests, calls, banned, feedback, change, metaRevision, settlement };
}
export function radioFixture({ choice = { origin: 'account', sourceId: 'wyy' }, ordinaryPlaying = false } = {}) {
  const host = ownedHost(), choices = choiceFixture(host), env = environmentFixture(host);
  choices.writeRecommendationChoice('fm', choice);
  const audioCalls = [], playerCalls = [], playRequests = [];
  const dislikes = { isDisliked: song => env.banned.has(`${song.platform}:${song.id}`),
    banSong: song => env.feedback.push(['ban', song.id]), hasRules: () => env.banned.size > 0 };
  const codecs = loadProduction(readProduction('stores/persist-codec.ts'), ['songToJson', 'songFromJson'], {}, 'stores/persist-codec.ts');
  const { PlayerStore } = loadProduction(classSource('stores/player.ts', 'class PlayerStore {', '\nconst player = reactive(new PlayerStore())'), ['PlayerStore'], {
    ...codecs, ...host.timers, uni: host.uni, collectionStorageKey: key => key, STATE_KEY: 'owned-state', PROGRESS_KEY: 'owned-progress', DEFAULT_FAV_KEY: 'owned-fav',
    useDislikesStore: () => dislikes, audioPlayer: { stop: () => audioCalls.push(['stop']), setRepeatMode: value => audioCalls.push(['repeat', value]) }, logMsg: noop, qtShowToast: noop,
  }, 'stores/player.ts');
  const ordinary = [track('ordinary-1'), track('ordinary-2')];
  const player = Object.assign(Object.create(PlayerStore.prototype), {
    radioActive: false, radioBackup: '', current: ordinary[1], queue: ordinary.slice(), mode: 'random', quality: '320', progress: 37.5, duration: 200,
    playing: ordinaryPlaying, playSeq: 0, lockedNextMid: 'wyy:ordinary-1', timelineIds: [], playCounts: new Map(),
    listenSession: { start: noop }, stopProgressClock: noop, markProgress(value) { this.progress = value; }, resume() { this.playing = true; },
    persist() { this.saveState(); }, pause() { playerCalls.push(['pause']); this.playing = false; },
    syncTimeline() { playerCalls.push(['timeline']); if (this.timelineError) throw this.timelineError; },
    // Audio/resource seam: commit the offered queue synchronously, as actual play does,
    // then optionally hold resource completion. Radio logic is never copied here.
    play(song, queue = [], restore = false, auto = false, radioRequest = false) {
      playerCalls.push(['play', song.id, queue.map(item => item.id), restore, auto, radioRequest]);
      if (this.radioActive && !radioRequest && queue.length > 0) this.endRadio(false);
      this.playSeq++;
      if (!this.rejectQueue && queue.length > 0) this.queue = queue.slice();
      if (!this.rejectQueue) { this.current = song; this.playing = true; this.progress = 0; }
      const task = this.playGate ? this.playGate.promise : Promise.resolve();
      playRequests.push({ song, queue, task }); return task;
    },
    next(...args) { playerCalls.push(['next']); return PlayerStore.prototype.next.apply(this, args); },
    enqueueMany(...args) { playerCalls.push(['enqueue', args[0].map(song => song.id), args[1], args[2]]); return this.rejectAppend ? 0 : PlayerStore.prototype.enqueueMany.apply(this, args); },
  });
  const queueApi = loadProduction(readProduction('services/radio-queue.ts'), ['RADIO_BATCH', 'RADIO_SEED_LANE', 'radioTrackKey', 'seedLane', 'markUsed', 'sessionVariant', 'shouldRefill', 'buildRadioBatch'], {
    ...host.timers, rankCandidates: () => { throw new Error('account mode must not rank local preference'); }, hashString: () => 1, deriveStyle: noop,
  }, 'services/radio-queue.ts');
  const radioApi = loadProduction(readProduction('stores/radio.ts'), ['useRadioStore'], {
    ...host.timers, ...choices, ...env.account, ...queueApi, uni: host.uni, reactive: value => value,
    fetchAccountFmNext: (...args) => env.account.fetchAccountFmNext(...args).then(batch => { env.settlement.afterFacade?.(); return batch; }),
    usePlayerStore: () => player, useDislikesStore: () => dislikes, useDownloadsStore: () => { throw new Error('account mode must not read local downloads'); },
    loadPreference: () => { throw new Error('account mode must not load app preference'); }, readTaste: () => 'heart', saveTaste: noop, logMsg: noop, logMsgWarn: noop,
    SOURCE_AUTH_CHANGED_EVENT: 'qt-source-auth-changed', SOURCE_PACKS_CHANGED_EVENT: 'qt-source-packs-changed', SOURCE_POLICY_CHANGED_EVENT: 'qt-source-policy-changed',
  }, 'stores/radio.ts');
  function respond(index, ids, extra = {}) {
    const request = env.requests[index]; assert.ok(request, `owned request ${index} exists`);
    request.resolve(JSON.stringify({ source: request.args.source, kind: 'fm', accountId: request.args.accountId,
      items: ids.map(id => ({ id, name: `Song ${id}`, singer: 'Fixture singer', album: '', picUrl: '', interval: 200 })), fetchedAt: host.now(), ...extra }));
  }
  return { ...host, ...env, choices, player, playerCalls, playRequests, audioCalls, ordinary, radio: radioApi.useRadioStore(), respond,
    ids: () => Array.from(player.queue, song => song.id), cleanup: () => radioApi.useRadioStore().stop(false) };
}
// Deep integration seam: core's fixture runs the real source-engine.uts,
// source-auth.ts, music-api.ts, registry and Pinia choice. Native.invoke is the
// final owned callback boundary, so cancellation is not faked by an invoke mock.
async function nativeRadioFixture({ holdStartDispatch = false } = {}) {
  const native = accountRecommendationFixture(); await native.ready(); await native.saveAccount();
  native.choice.writeRecommendationChoice('fm', { origin: 'account', sourceId: 'wyy' });
  const base = radioFixture(), facts = { context: null };
  const queue = loadProduction(readProduction('services/radio-queue.ts'), ['RADIO_BATCH', 'RADIO_SEED_LANE', 'radioTrackKey', 'seedLane', 'markUsed', 'sessionVariant', 'shouldRefill', 'buildRadioBatch'], {
    ...base.timers, rankCandidates: () => { throw new Error('native account FM cannot rank app candidates'); }, hashString: () => 1, deriveStyle: noop,
  }, 'services/radio-queue.ts');
  const { useRadioStore } = loadProduction(readProduction('stores/radio.ts'), ['useRadioStore'], {
    ...base.timers, ...native.choice, ...native.service, ...queue, uni: native.uni, reactive: value => value,
    Date: class extends Date { static now() { return native.state.now; } },
    usePlayerStore: () => base.player,
    useDislikesStore: () => ({ isDisliked: song => base.banned.has(`${song.platform}:${song.id}`), banSong: song => base.feedback.push(['ban', song.id]) }),
    useDownloadsStore: () => { throw new Error('native account FM cannot read app downloads'); },
    loadPreference: () => { throw new Error('native account FM cannot load app preference'); }, readTaste: () => 'heart', saveTaste: noop, logMsg: noop, logMsgWarn: noop,
    prepareAccountRecommendationContext: (...args) => native.service.prepareAccountRecommendationContext(...args).then(context => {
      facts.context = context; if (holdStartDispatch) native.state.restoreGate = deferred(); return context;
    }),
    SOURCE_AUTH_CHANGED_EVENT: native.auth.SOURCE_AUTH_CHANGED_EVENT, SOURCE_PACKS_CHANGED_EVENT: 'qt-source-packs-changed', SOURCE_POLICY_CHANGED_EVENT: native.policy.SOURCE_POLICY_CHANGED_EVENT,
  }, 'stores/radio.ts');
  return { native, facts, base, radio: useRadioStore(), calls: () => native.state.calls.filter(entry => entry.name === 'accountFmNext'),
    cleanup: () => useRadioStore().stop(false) };
}
let groups = 0;
const failures = [];
async function check(label, run) {
  try { await run(); groups++; console.log('PASS ' + label); }
  catch (error) { failures.push({ label, error }); console.error('RED ' + label + ': ' + error.message); }
}
async function startReady(b, ids = ['a', 'b'], extra = {}) {
  const start = b.radio.start(); await drain(); b.respond(b.requests.length - 1, ids, extra); await start;
  assert.equal(b.radio.queueClaimed, true, 'the real radio must accept the initial queue before this scenario');
  return b;
}
function mutateChoiceABA(b) {
  b.choices.writeRecommendationChoice('fm', { origin: 'account', sourceId: 'kg' });
  b.choices.writeRecommendationChoice('fm', { origin: 'account', sourceId: 'wyy' });
}
function radioPageFixture(b) {
  const key = loadProduction(readProduction('services/radio-queue.ts'), ['radioTrackKey'], {}, 'services/radio-queue.ts');
  const page = loadProduction(readProduction('pages/radio/index.uvue'), ['playInRadio', 'upcoming'], {
    ref: value => ({ value }), computed: get => ({ get value() { return get(); } }),
    ...key, useRadioStore: () => b.radio, usePlayerStore: () => b.player,
    useThemeStore: () => ({ skin: {} }), useQtLayout: () => ({ isWide: false }), qtFontDual: () => '', qtShowToast: noop,
    DAILY_TASTE_LABEL: { heart: '心动' }, DAILY_TASTE_HINT: { heart: '' }, DAILY_TASTE_ORDER: ['heart'],
    useSongSheet: () => ({ sheetVisible: { value: false }, sheetActions: { value: [] }, openSheet: noop, onSheetSelect: noop, sheetTitle: { value: '' } }),
  }, 'pages/radio/index.uvue');
  const queue = loadProduction(readProduction('uni_modules/qt-ui/composables/playback-queue.ts'), ['removePlaybackQueueItem', 'movePlaybackQueueItem'], {}, 'composables/playback-queue.ts');
  return { page, queue };
}
export async function runQueuedRowChecks() {
  await check('FM-30 owned present row remains playable through the complete production FM page (positive control)', async () => {
    const b = await startReady(radioFixture(), ['a', 'b', 'c']); const { page } = radioPageFixture(b);
    const selected = page.upcoming.value[0], before = b.playerCalls.filter(call => call[0] === 'play').length;
    page.playInRadio(selected); await drain();
    assert.equal(b.playerCalls.filter(call => call[0] === 'play').length - before, 1);
    assert.equal(b.player.current, selected); assert.equal(b.radio.active, true); assert.deepEqual(b.ids(), ['a', 'b', 'c']); b.cleanup();
  });
  for (const mutation of ['remove', 'reorder']) await check(`FM-31 actual queue ${mutation} before heartbeat makes a stale page row yield synchronously without playback or restore`, async () => {
    const b = await startReady(radioFixture(), ['a', 'b', 'c']); const { page, queue } = radioPageFixture(b);
    const staleRow = page.upcoming.value[mutation === 'remove' ? 0 : 1];
    const ended = [], endRadio = b.player.endRadio;
    b.player.endRadio = function(...args) { ended.push(args[0]); return endRadio.apply(this, args); };
    const current = b.player.current, before = b.playerCalls.filter(call => call[0] === 'play').length, clock = b.now();
    if (mutation === 'remove') queue.removePlaybackQueueItem(b.player, 1);
    else queue.movePlaybackQueueItem(b.player, 2, -1);
    const editedQueue = b.ids();
    assert.equal(b.player.current, current, 'the real helper edits a non-current row without playback');
    assert.equal(b.radio.active, true, 'the actual helper does not end FM, leaving the before-heartbeat gap');
    assert.equal(b.radio.queueClaimed, true); assert.equal(b.now(), clock); assert.equal(ended.length, 0);
    page.playInRadio(staleRow);
    // Capture immediately, before any microtask/timer: yielding must be synchronous.
    const observed = { plays: b.playerCalls.filter(call => call[0] === 'play').length - before, current: b.player.current?.id,
      queue: b.ids(), active: b.radio.active, claimed: b.radio.queueClaimed, ends: ended.slice(), timers: b.intervals.size };
    await drain();
    assert.deepEqual(observed, { plays: 0, current: 'a', queue: editedQueue, active: false, claimed: false, ends: [false], timers: 0 },
      'stale FM row must not call player.play, alter current/edited queue or restore the original snapshot; it must stop(false) before heartbeat');
    b.cleanup();
  });
}
export async function runAccountRadioChecks() {
  await check('FM-01 official source order, track-key dedupe and existing local dislikes; no app fallback', async () => {
    const b = radioFixture(); b.banned.add('wyy:blocked');
    const start = b.radio.start(track('ignored-seed')); await drain(); assert.equal(b.requests.length, 1);
    b.respond(0, ['z', 'a', 'z', 'blocked', 'b'], { cursor: 'opaque : / ? = 0', exhausted: false }); await start;
    assert.deepEqual(b.ids(), ['z', 'a', 'b']); assert.equal(b.radio.seed, null); assert.equal(b.radio.pref, null);
    assert.equal(b.radio.accountCursor, 'opaque : / ? = 0'); assert.equal(b.radio.queueClaimed, true);
    await b.radio.dislike(b.player.current); assert.equal(b.feedback.length, 0);
    const refill = b.radio.refill(); await drain(); assert.equal(b.requests[1].args.cursor, 'opaque : / ? = 0');
    b.respond(1, ['a', 'd', 'd', 'blocked', 'c'], { cursor: 'opaque-next', exhausted: false }); await refill;
    assert.deepEqual(b.ids(), ['z', 'a', 'b', 'd', 'c']); assert.equal(b.radio.accountCursor, 'opaque-next'); b.cleanup();
  });
  await check('FM-02 a current WYY response without cursor never invents a cursor', async () => {
    const b = radioFixture(); const start = b.radio.start(); await drain(); b.respond(0, ['a']); await start;
    assert.equal(b.radio.accountCursor, null);
    const refill = b.radio.refill(); await drain(); assert.equal(Object.hasOwn(b.requests[1].args, 'cursor'), false);
    b.respond(1, ['b']); await refill; assert.equal(b.radio.accountCursor, null); b.cleanup();
  });
  await check('FM-03 owned stop restores real original queue, mode, position and paused intent', async () => {
    const b = radioFixture(); const start = b.radio.start(); await drain(); b.respond(0, ['a', 'b']); await start;
    b.radio.stop(); assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2']); assert.equal(b.player.current.id, 'ordinary-2');
    assert.equal(b.player.mode, 'random'); assert.equal(b.player.progress, 37.5); assert.equal(b.player.playing, false);
    assert.equal(b.intervals.size, 0); assert.equal(b.player.radioActive, false);
  });
  await check('FM-04 next synchronously rejects silent context invalidation without waiting for heartbeat', async () => {
    const b = radioFixture(); const start = b.radio.start(); await drain(); b.respond(0, ['a', 'b']); await start;
    b.change('relogin', { emit: false }); await b.radio.next();
    assert.equal(b.playerCalls.filter(call => call[0] === 'next').length, 0, 'stale account next must never call player.next');
    assert.equal(b.radio.active, false); assert.notEqual(b.radio.error, ''); b.cleanup();
  });
  await check('FM-05 context invalidated after facade resolution cleans pending start with a visible error', async () => {
    const b = radioFixture(); const start = b.radio.start(); await drain();
    // The hook runs only after the genuine facade has parsed and accepted the raw response.
    b.settlement.afterFacade = () => b.change('meta', { emit: false }); b.respond(0, ['a']); await start;
    assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2']); assert.equal(b.radio.loading, false);
    assert.notEqual(b.radio.error, '', 'a silently invalidated supply must report stale environment, not an empty idle success'); b.cleanup();
  });
  await check('FM-06 an already expired official batch cannot claim the player or commit its cursor', async () => {
    const b = radioFixture(); const start = b.radio.start(); await drain();
    b.respond(0, ['expired'], { expiresAt: b.now() - 1, cursor: 'expired-cursor' }); await start;
    assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2'], 'expired official items must not replace the ordinary queue');
    assert.equal(b.playerCalls.filter(call => call[0] === 'play').length, 0);
    assert.equal(b.radio.accountCursor, null); assert.equal(b.radio.active, false); assert.notEqual(b.radio.error, ''); b.cleanup();
  });
  await check('FM-07 initial cursor is committed only after player resource acceptance', async () => {
    const b = radioFixture(); b.player.playGate = deferred(); const start = b.radio.start(); await drain();
    b.respond(0, ['a'], { cursor: '  opaque: /?=+\\u0000  ' }); await drain();
    assert.deepEqual(b.ids(), ['a']); assert.equal(b.radio.accountCursor, null); assert.equal(b.radio.queueClaimed, false);
    b.player.playGate.resolve(); await start; assert.equal(b.radio.accountCursor, '  opaque: /?=+\\u0000  '); b.cleanup();
  });
  await check('FM-08 an unaccepted initial queue never commits cursor or ownership', async () => {
    const b = radioFixture(); b.player.rejectQueue = true; const start = b.radio.start(); await drain();
    b.respond(0, ['a'], { cursor: 'unaccepted' }); await start;
    assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2']); assert.equal(b.radio.accountCursor, null);
    assert.equal(b.radio.queueClaimed, false); assert.equal(b.radio.active, false); assert.equal(b.intervals.size, 0);
  });
  await check('FM-09 empty start probes at most three times, preserves opaque probe cursor and never claims queue', async () => {
    const b = radioFixture(); const start = b.radio.start(); await drain();
    for (let index = 0; index < 3; index++) {
      assert.equal(b.requests.length, index + 1); assert.equal(b.radio.accountCursor, null);
      if (index > 0) assert.equal(b.requests[index].args.cursor, `probe ${index - 1} /?=+`);
      b.respond(index, [], { cursor: `probe ${index} /?=+` }); await drain();
    }
    await start; assert.equal(b.requests.length, 3); assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2']);
    assert.equal(b.radio.accountCursor, null); assert.equal(b.radio.exhausted, true); assert.equal(b.radio.active, false);
    await b.radio.refill(); await b.pulse(); assert.equal(b.requests.length, 3); assert.equal(b.intervals.size, 0);
  });
  await check('FM-10 three duplicate/disliked-only refill probes exhaust without committing cursor or polling again', async () => {
    const b = await startReady(radioFixture(), ['a'], { cursor: 'committed' }); b.banned.add('wyy:blocked');
    const refill = b.radio.refill(); await drain();
    for (let probe = 0; probe < 3; probe++) { b.respond(probe + 1, ['a', 'blocked', 'a'], { cursor: `not-admitted-${probe}` }); await drain(); }
    await refill; assert.equal(b.requests.length, 4); assert.deepEqual(b.ids(), ['a']); assert.equal(b.radio.accountCursor, 'committed');
    assert.equal(b.radio.exhausted, true); for (let index = 0; index < 5; index++) { await b.radio.refill(); await b.pulse(); }
    assert.equal(b.requests.length, 4); b.cleanup();
  });
  await check('FM-11 explicit exhausted response terminates probing early, and all next actions remain local', async () => {
    const b = await startReady(radioFixture(), ['a', 'b'], { exhausted: true });
    for (let index = 0; index < 5; index++) await b.pulse(); assert.equal(b.requests.length, 1);
    await b.radio.next(); assert.equal(b.player.current.id, 'b'); await b.radio.next();
    assert.equal(b.player.current.id, 'b'); assert.equal(b.player.playing, false); assert.equal(b.requests.length, 1); assert.equal(b.feedback.length, 0); b.cleanup();
  });
  await check('FM-12 zero player admissions do not commit cursor and terminate rather than spin', async () => {
    const b = await startReady(radioFixture(), ['a'], { cursor: 'old' }); b.player.rejectAppend = true;
    const refill = b.radio.refill(); await drain(); b.respond(1, ['b'], { cursor: 'not-accepted' }); await refill;
    assert.equal(b.radio.accountCursor, 'old'); assert.deepEqual(b.ids(), ['a']); assert.equal(b.radio.exhausted, true);
    await b.pulse(); assert.equal(b.requests.length, 2); b.cleanup();
  });
  for (const stage of ['prepare', 'supply', 'play']) await check(`FM-13 stop during ${stage} drops delayed start without reclaim/cursor/heartbeat`, async () => {
    const b = radioFixture(); if (stage === 'prepare') b.state.prepareGate = deferred();
    if (stage === 'play') b.player.playGate = deferred(); const start = b.radio.start(); await drain();
    if (stage === 'play') { b.respond(0, ['a'], { cursor: 'late' }); await drain(); assert.deepEqual(b.ids(), ['a']); }
    b.radio.stop();
    if (stage === 'prepare') b.state.prepareGate.resolve();
    else if (stage === 'supply') b.respond(0, ['a'], { cursor: 'late' });
    else b.player.playGate.resolve(); await start;
    assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2']); assert.equal(b.player.mode, 'random'); assert.equal(b.player.playing, false);
    assert.equal(b.radio.active, false); assert.equal(b.radio.loading, false); assert.equal(b.radio.accountCursor, null); assert.equal(b.intervals.size, 0);
    if (stage === 'prepare') assert.equal(b.requests.length, 0);
  });
  await check('FM-14 stop during refill restores its owned original queue, and late supply cannot append', async () => {
    const b = await startReady(radioFixture(), ['a'], { cursor: 'old' }); const refill = b.radio.refill(); await drain();
    b.radio.stop(); b.respond(1, ['late'], { cursor: 'late' }); await refill;
    assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2']); assert.equal(b.playerCalls.filter(call => call[0] === 'enqueue').length, 0);
    assert.equal(b.radio.accountCursor, null); assert.equal(b.radio.loading, false); assert.equal(b.intervals.size, 0);
  });
  for (const phase of ['start', 'refill']) for (const mutation of ['choice-ABA', 'account', 'relogin', 'meta-ABA', 'pack', 'policy-ABA', 'epoch']) {
    await check(`FM-15 ${phase} stale ${mutation} result cannot claim/append/revive the session`, async () => {
      const b = radioFixture(); if (phase === 'refill') await startReady(b, ['a'], { cursor: 'old' });
      const pending = phase === 'start' ? b.radio.start() : b.radio.refill(); await drain();
      const index = b.requests.length - 1;
      if (mutation === 'choice-ABA') mutateChoiceABA(b);
      else if (mutation === 'meta-ABA') { b.change('meta'); b.change('meta'); }
      else if (mutation === 'policy-ABA') { b.change('policy'); b.change('policy'); }
      else b.change(mutation);
      b.respond(index, ['late'], { cursor: 'late-cursor' }); await pending;
      assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2']); assert.equal(b.radio.active, false);
      assert.equal(b.radio.accountCursor, null); assert.equal(b.radio.loading, false); assert.equal(b.intervals.size, 0);
      assert.equal(b.playerCalls.filter(call => call[0] === 'enqueue').length, 0);
    });
  }
  for (const phase of ['start', 'refill']) await check(`FM-16 play-only login policy change leaves ${phase} account data supply current`, async () => {
    const b = radioFixture(); if (phase === 'refill') await startReady(b, ['a'], { cursor: 'old' });
    const pending = phase === 'start' ? b.radio.start() : b.radio.refill(); await drain(); b.change('play');
    b.respond(b.requests.length - 1, ['b'], { cursor: 'accepted' }); await pending;
    assert.deepEqual(b.ids(), phase === 'start' ? ['b'] : ['a', 'b']); assert.equal(b.radio.active, true);
    assert.equal(b.radio.accountCursor, 'accepted'); assert.equal(b.state.useMeta, true); b.cleanup();
  });
  await check('FM-17 paused/background ownership still handles an auth revocation immediately', async () => {
    const b = await startReady(radioFixture(), ['a']); b.player.playing = false; b.change('logout');
    assert.equal(b.radio.active, false); assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2']); assert.equal(b.intervals.size, 0);
  });
  for (const mutation of ['external', 'clear', 'remove', 'reorder']) await check(`FM-18 ${mutation} queue during refill wins; no append or original snapshot overwrite`, async () => {
    const b = await startReady(radioFixture(), ['a', 'b', 'c']); const refill = b.radio.refill(); await drain();
    if (mutation === 'external') await b.player.play(track('external'), [track('external')]);
    else if (mutation === 'clear') { b.player.queue = []; b.player.current = null; b.player.playSeq++; }
    else if (mutation === 'remove') b.player.queue = b.player.queue.filter(song => song.id !== 'b');
    else b.player.queue = [b.player.queue[2], b.player.queue[0], b.player.queue[1]];
    const expected = b.ids(); b.respond(1, ['late'], { cursor: 'late' }); await refill;
    assert.deepEqual(b.ids(), expected); assert.equal(b.radio.active, false);
    assert.equal(b.playerCalls.filter(call => call[0] === 'enqueue').length, 0); assert.equal(b.intervals.size, 0);
  });
  for (const mutation of ['external', 'clear', 'remove', 'reorder']) await check(`FM-19 ${mutation} queue while initial play awaits resources is never restored over user edits`, async () => {
    const b = radioFixture(); b.player.playGate = deferred(); const start = b.radio.start(); await drain();
    b.respond(0, ['a', 'b', 'c'], { cursor: 'uncommitted' }); await drain();
    if (mutation === 'external') { b.player.endRadio(false); b.player.queue = [track('external')]; b.player.current = b.player.queue[0]; b.player.playSeq++; }
    else if (mutation === 'clear') { b.player.queue = []; b.player.current = null; b.player.playSeq++; }
    else if (mutation === 'remove') b.player.queue = b.player.queue.filter(song => song.id !== 'b');
    else b.player.queue = [b.player.queue[2], b.player.queue[0], b.player.queue[1]];
    const expected = b.ids(); b.player.playGate.resolve(); await start;
    assert.deepEqual(b.ids(), expected); assert.equal(b.radio.active, false); assert.equal(b.radio.accountCursor, null); assert.equal(b.intervals.size, 0);
  });
  await check('FM-20 a tail next waits for bounded refill, and an external play wins over the late next', async () => {
    const b = await startReady(radioFixture(), ['a']); const next = b.radio.next(); await drain(); assert.equal(b.requests.length, 2);
    await b.player.play(track('external'), [track('external')]); b.respond(1, ['late']); await next;
    assert.equal(b.player.current.id, 'external'); assert.deepEqual(b.ids(), ['external']);
    assert.equal(b.playerCalls.filter(call => call[0] === 'next').length, 0); assert.equal(b.radio.active, false);
  });
  await check('FM-21 tail next admits one bounded refill then advances locally once', async () => {
    const b = await startReady(radioFixture(), ['a']); const next = b.radio.next(); await drain();
    assert.equal(b.player.current.id, 'a'); assert.equal(b.playerCalls.filter(call => call[0] === 'next').length, 0);
    b.respond(1, ['b'], { exhausted: true }); await next; assert.equal(b.player.current.id, 'b');
    assert.equal(b.playerCalls.filter(call => call[0] === 'next').length, 1); assert.equal(b.feedback.length, 0); b.cleanup();
  });
  for (const code of ['NETWORK', 'RATE_LIMIT', 'UPSTREAM']) await check(`FM-22 ${code} refill failures back off 5/10s, bounded to two retries then stop`, async () => {
    const b = await startReady(radioFixture(), ['a']); let refill = b.radio.refill(); await drain();
    b.requests[1].reject(new Error(`ACCOUNT_RECOMMENDATIONS_${code}`)); await refill; assert.equal(b.radio.active, true);
    b.advance(4999); await b.pulse(); await b.radio.refill(); assert.equal(b.requests.length, 2);
    b.advance(1); refill = b.radio.refill(); await drain(); assert.equal(b.requests.length, 3);
    b.requests[2].reject(new Error(`ACCOUNT_RECOMMENDATIONS_${code}`)); await refill;
    b.advance(9999); await b.pulse(); assert.equal(b.requests.length, 3);
    b.advance(1); refill = b.radio.refill(); await drain(); assert.equal(b.requests.length, 4);
    b.requests[3].reject(new Error(`ACCOUNT_RECOMMENDATIONS_${code}`)); await refill;
    assert.equal(b.radio.active, false); assert.equal(b.intervals.size, 0); assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2']);
    b.advance(60000); await b.pulse(); await b.radio.refill(); assert.equal(b.requests.length, 4);
  });
  for (const code of ['AUTH_EXPIRED', 'MALFORMED_RESPONSE', 'UNSUPPORTED', 'INVALID_ARGS', 'TIMEOUT']) await check(`FM-23 terminal ${code} refill failure stops without retries or fallback`, async () => {
    const b = await startReady(radioFixture(), ['a']); const refill = b.radio.refill(); await drain();
    b.requests[1].reject(new Error(`ACCOUNT_RECOMMENDATIONS_${code}`)); await refill;
    assert.equal(b.radio.active, false); assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2']); assert.equal(b.intervals.size, 0);
    b.advance(60000); await b.radio.refill(); assert.equal(b.requests.length, 2); assert.equal(b.feedback.length, 0);
  });
  await check('FM-24 uncertain append after actual queue mutation stops supply without retry or rollback', async () => {
    const b = await startReady(radioFixture(), ['a']); b.player.timelineError = new Error('owned timeline failure after mutation');
    const refill = b.radio.refill(); await drain(); b.respond(1, ['b'], { cursor: 'not-confirmed' }); await refill;
    assert.deepEqual(b.ids(), ['a', 'b']); assert.equal(b.player.current.id, 'a'); assert.equal(b.radio.active, false);
    assert.equal(b.radio.accountCursor, null); assert.match(b.radio.error, /补歌未能确认/); assert.equal(b.intervals.size, 0);
    b.advance(60000); await b.radio.refill(); assert.equal(b.requests.length, 2);
  });
  await check('FM-25 slow refill is single flight despite repeated heartbeat and user refill calls', async () => {
    const b = await startReady(radioFixture(), ['a']); const refill = b.radio.refill(); await drain();
    for (let index = 0; index < 6; index++) { await b.pulse(); await b.radio.refill(); }
    assert.equal(b.requests.length, 2); b.respond(1, ['b']); await refill; assert.deepEqual(b.ids(), ['a', 'b']); b.cleanup();
  });
  await check('FM-26 old refill finally cannot unlock or overwrite a newer account A session after choice ABA', async () => {
    const b = await startReady(radioFixture(), ['a']); const old = b.radio.refill(); await drain(); mutateChoiceABA(b);
    const fresh = b.radio.start(); await drain(); assert.equal(b.requests.length, 3);
    b.respond(1, ['stale'], { cursor: 'stale' }); await old; assert.equal(b.radio.loading, true); assert.equal(b.radio.queueClaimed, false);
    b.respond(2, ['fresh'], { cursor: 'fresh' }); await fresh; assert.deepEqual(b.ids(), ['fresh']); assert.equal(b.radio.accountCursor, 'fresh'); b.cleanup();
  });
  await check('FM-27 owned stop restores original playing intent, and repeated account start preserves original snapshot', async () => {
    const b = await startReady(radioFixture({ ordinaryPlaying: true }), ['a']); const restart = b.radio.start(); await drain(); b.respond(1, ['b']); await restart;
    b.radio.stop(); assert.deepEqual(b.ids(), ['ordinary-1', 'ordinary-2']); assert.equal(b.player.current.id, 'ordinary-2');
    assert.equal(b.player.playing, true); assert.equal(b.player.mode, 'random'); assert.equal(b.player.progress, 37.5);
  });
  await check('FM-28 expired refill batch is not enqueued/committed and a bounded retry may accept fresh supply', async () => {
    const b = await startReady(radioFixture(), ['a'], { cursor: 'old' }); const refill = b.radio.refill(); await drain();
    b.respond(1, ['expired'], { expiresAt: b.now(), cursor: 'expired' }); await refill;
    assert.deepEqual(b.ids(), ['a']); assert.equal(b.radio.accountCursor, 'old'); assert.equal(b.radio.active, true);
    assert.equal(b.playerCalls.filter(call => call[0] === 'enqueue').length, 0); b.advance(5000);
    const retry = b.radio.refill(); await drain(); assert.equal(b.requests[2].args.cursor, 'old');
    b.respond(2, ['fresh'], { expiresAt: b.now() + 1, cursor: 'fresh' }); await retry; assert.deepEqual(b.ids(), ['a', 'fresh']); b.cleanup();
  });
  for (const phase of ['start', 'refill']) for (const cancel of ['stop', 'choice-ABA']) await check(`FM-29 ${phase} ${cancel} during genuine engine readiness cannot reach owned native.invoke`, async () => {
    const f = await nativeRadioFixture({ holdStartDispatch: phase === 'start' });
    if (phase === 'refill') { await f.radio.start(); assert.equal(f.radio.queueClaimed, true); f.native.state.restoreGate = deferred(); }
    const before = f.calls().length; const pending = phase === 'start' ? f.radio.start() : f.radio.refill(); await drainNative();
    assert.equal(f.calls().length, before, 'the test really paused before native account dispatch');
    if (cancel === 'stop') f.radio.stop();
    else { f.native.choice.writeRecommendationChoice('fm', { origin: 'account', sourceId: 'kg' }); f.native.choice.writeRecommendationChoice('fm', { origin: 'account', sourceId: 'wyy' }); }
    assert.equal(f.native.service.accountRecommendationContextCurrent(f.facts.context), true, 'caller lifetime is distinct from the still-authorized account');
    f.native.state.restoreGate.resolve(); await pending; await drainNative();
    assert.equal(f.calls().length, before, 'canceled radio must never dispatch an account entry after actual engine readiness');
    assert.equal(f.radio.active, false); assert.equal(f.radio.accountCursor, null); f.cleanup();
  });
  await runQueuedRowChecks();
  console.log(`account FM: ${groups} groups passed, ${failures.length} failed (actual production; owned offline boundaries; Native/real-account NOT RUN)`);
  if (failures.length) throw new AggregateError(failures.map(({ label, error }) => new Error(label, { cause: error })), 'Production account FM gates failed');
  return groups;
}
if (process.argv[1] && fileURLToPath(import.meta.url).replaceAll('\\', '/').toLowerCase() === process.argv[1].replaceAll('\\', '/').toLowerCase()) {
  if (process.argv.includes('--queue-row-only')) {
    await runQueuedRowChecks();
    console.log(`FM queue-row tracer: ${groups} passed, ${failures.length} failed (complete page + real radio + real queue helpers; no heartbeat)`);
    if (failures.length) throw new AggregateError(failures.map(({ label, error }) => new Error(label, { cause: error })), 'Production FM queue-row gates failed');
  } else await runAccountRadioChecks();
}
