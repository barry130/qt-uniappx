// Actual production methods with delayed synthetic boundaries; no device/network IO.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { verify } from 'node:crypto';
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const noop = () => {};
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const compile = s => stripTypeScriptTypes(s.replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, ''), { mode: 'strip' }).replace(/^export /gm, '');
const between = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));
const playerSource = read('stores/player.ts');
const playerClass = between(playerSource, 'class PlayerStore {', '\nconst player = reactive(new PlayerStore())');
function load(s, names, extra = {}) {
  const ctx = vm.createContext({ console, logMsg: noop, logWarn: noop, logErrV: noop, logMsgWarn: noop, qtShowToast: noop, ...extra });
  vm.runInContext(compile(s) + '\n;globalThis.api={' + names.join(',') + '}', ctx);
  return ctx.api;
}
const song = (id, platform = 'wyy') => ({ id, platform, name: id, singer: '', album: '', picUrl: '' });
let passed = 0;
async function check(name, fn) { await fn(); console.log('  ok ' + name); passed++; }
for (const result of [song('sub'), null]) await check('stale local substitute cannot change the new selection: ' + (result?.id ?? 'failure'), async () => {
  const d = defer(), events = [];
  const { PlayerStore } = load(playerClass, ['PlayerStore'], { findSubstituteSong: () => d.promise });
  const host = Object.create(PlayerStore.prototype), a = song('a', 'local'), b = song('b');
  Object.assign(host, { current: a, playSeq: 1, pauseIntentAt: 0, localFirstFailed:new Map(), queue: [a, b], play: s => events.push(s), skipAfterFailure: () => events.push('skip') });
  host.substituteLocalSong(a); host.current = b; host.playSeq++;
  d.resolve(result); await drain(); assert.equal(events.length, 0);
});
await check('quality result after a new selection never writes quality or starts playback', async () => {
  const page = read('pages/player/index.uvue'), d = defer(), events = [];
  let choose; let revision = 1;
  const a = song('a'), b = song('b', 'qq');
  const player = { current: a, queue: [a, b], playbackRevision: () => revision, effQualityOf: () => '320', setSourceQuality: (...args) => events.push(args), play: (...args) => events.push(args) };
  const code = between(page, 'let qualityRequestSeq', '\nfunction onDiscTap()');
  const { switchQuality } = load(code, ['switchQuality'], { player, sourceRegistry: { sourceQualities: () => [{ id: 'flac', name: 'flac' }] }, musicApi: { playUrl: () => d.promise }, openActionSheet: (_t, _a, cb) => { choose = cb; } });
  await switchQuality(); const task = choose(null, 0); player.current = b; revision++;
  d.resolve('https://audio.invalid/a.flac'); await task; assert.equal(events.length, 0); assert.equal(a.url, undefined);
});
await check('failure advances in single-repeat mode and does not seek/resume the failed item', () => {
  const events = [], { PlayerStore } = load(playerClass, ['PlayerStore'], { useDislikesStore: () => ({ hasRules: () => false }), audioPlayer: { resume: () => events.push('resume') } });
  const host = Object.create(PlayerStore.prototype), a = song('a'), b = song('b');
  Object.assign(host, { current: a, queue: [a, b], autoNext: true, failStreak: 0, mode: 'single', lockedNextMid: '', sleepStopAfterCurrent: false, seek: () => events.push('seek'), play: s => events.push(s.id) });
  host.skipAfterFailure(); assert.deepEqual(events, ['b']);
});
await check('restored current is the exact saved queue occurrence', () => {
  const restore = between(playerSource, '      const queueArr = obj.get("queue")', '\n      const progress = obj.get("progress")');
  const { restoreCurrent } = load('function restoreCurrent(obj: any) {' + restore + '}', ['restoreCurrent'], { songFromJson: text => JSON.parse(text) });
  const a = JSON.stringify(song('a')), host = { queue: [], current: null };
  restoreCurrent.call(host, { get: k => ({ queue: [a, a], current: a, currentIndex: 1 })[k] });
  assert.equal(host.current, host.queue[1]); assert.notEqual(host.current, host.queue[0]);
});
await check('native media-key next is accepted immediately after a manual selection; stale event preserves locks', () => {
  let nativeId = 'wyy:b';
  const { PlayerStore } = load(playerClass, ['PlayerStore'], { audioPlayer: { currentMediaId: () => nativeId }, desktopLyric: { notifySongChanged: noop } });
  const host = Object.create(PlayerStore.prototype), a = song('a'), b = song('b');
  Object.assign(host, { current: a, history: [], explicitPlayAt: Date.now(), lockedNextMid: '', resolvedUrlMap: new Map(), findSongByMediaId: () => b,
    listenSession: { start: noop }, markProgress: noop, persist: noop, adoptLocalPathIfIndexed:noop, refreshNativeRating: noop, syncSongExtras: noop, preloadNextUrl: noop });
  host.onNativeTrackChanged('wyy:b', false);
  assert.equal(host.current, b);
  host.current = a; host.lockedNextMid = 'wyy:c'; nativeId = 'wyy:a';
  host.onNativeTrackChanged('wyy:b', false);
  assert.equal(host.current, a); assert.equal(host.lockedNextMid, 'wyy:c');
});
await check('Harmony retains seek position during initial resolution', () => {
  const src = read('uni_modules/qt-audio-player/utssdk/app-harmony/index.uts');
  const body = between(src, 'export function audioSeek(', '\n/**');
  assert.ok(body.indexOf('gPendingPositionSec = Math.max(0, seconds)') < body.indexOf('if (p == null) return'));
});
await check('unsupported audio effects are disabled in Harmony UI and do not claim success', () => {
  const source = read('services/audio-player.uts');
  const capabilities = between(source, 'export function audioCapabilities()', '\nexport class AudioPlayer');
  assert.ok(capabilities.includes('return { equalizer: false, outputEffects: false }'));
  const equalizer = read('pages/equalizer/index.uvue'), settings = read('pages/play-settings/index.uvue');
  assert.ok(equalizer.includes(':disabled="!effectsSupported"'));
  for (const action of ['toggleFloatOutput', 'togglePreferSw', 'toggleEnhance']) {
    const method = between(settings, 'function ' + action + '(): void {', '\n}');
    assert.ok(method.includes('if (!audioCapabilities().outputEffects)'));
  }
});
await check('official verification uses host crypto and rejects a forged signature', async () => {
  const src = read('services/pack-signature.uts');
  let calls = 0;
  const { verifyOfficialSignature } = load(src, ['verifyOfficialSignature'], {
    parseJsonToUtso: text => ({ get: k => JSON.parse(text)[k] }),
    verifyPackSignature: (content, sig, hex, callback) => {
      calls++;
      const key = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]);
      callback({ ok: true, value: verify(null, Buffer.from(content, 'utf8'), { key, format: 'der', type: 'spki' }, Buffer.from(sig, 'base64')) ? 'ok' : 'bad', error: '' });
    },
  });
  const signature = Buffer.alloc(64).toString('base64');
  assert.equal((await verifyOfficialSignature('tampered/*__QT_SIGN__' + JSON.stringify({ alg: 'ed25519', sig: signature }) + '*/')).ok, false);
  assert.equal(calls, 1, 'validly shaped signature reaches trusted host verification');
  assert.equal((await verifyOfficialSignature('tampered/*__QT_SIGN__' + JSON.stringify({ alg: 'ed25519', sig: 'invalid' }) + '*/')).ok, false);
  assert.equal(calls, 1, 'invalid signature encoding never enters the bridge');
  assert.ok(!src.includes('evalOnEngine('));
});
await check('fallback timeline starts local audio and resolves remote audio', () => {
  const src = read('services/audio-player.uts');
  // Select the non-native target exactly as the build preprocessor would.
  const lines = src.split('\n'), keep = [true], out = [];
  for (const line of lines) {
    if (/\/\/ #ifdef /.test(line)) { keep.push(false); continue; }
    if (/\/\/ #ifndef /.test(line)) { keep.push(true); continue; }
    if (/\/\/ #endif/.test(line)) { keep.pop(); continue; }
    if (keep.every(Boolean)) out.push(line);
  }
  let plays = 0, resolves = 0;
  const manager = { stop: noop, play: () => plays++, paused: false, src: '' };
  const { AudioPlayer } = load(out.join('\n'), ['AudioPlayer']);
  const audio = Object.create(AudioPlayer.prototype);
  Object.assign(audio, { fallbackRevision: 0, fallbackItems: [], getManager: () => manager, toPlayableUrl: x => x, resolveCb: () => resolves++ });
  audio.setPlaylist([{ mediaId: 'local:a', uri: '/a.mp3' }], 0, true, 0);
  assert.equal(plays, 1); assert.equal(manager.src, '/a.mp3'); assert.equal(audio.currentMediaId(), 'local:a');
  audio.setPlaylist([{ mediaId: 'qq:b', uri: 'qt-resolve://b' }], 0, true, 0);
  assert.equal(resolves, 1); audio.resolveDone('qq:b', 'https://audio.invalid/b'); assert.equal(plays, 2);
  audio.stop(); audio.resolveDone('qq:b', 'https://audio.invalid/stale');
  assert.equal(plays, 2); assert.equal(audio.currentMediaId(), '');
});
console.log('playback/signature: ' + passed + ' checks passed');
