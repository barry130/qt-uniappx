// Actual production methods with delayed synthetic boundaries; no device/network IO.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { verify } from 'node:crypto';
import { preprocessPlatform } from './platform-preprocess.mjs';
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
  let revision = 1;
  const a = song('a'), b = song('b', 'qq');
  const player = { current: a, queue: [a, b], playbackRevision: () => revision, effQualityOf: () => '320', resolvedUrlOf: () => '',
    setSourceQuality: (...args) => events.push(args), play: (...args) => events.push(args) };
  const code = between(page, 'let qualityRequestSeq', '\nfunction onDiscTap()');
  const { switchQuality, onPlaybackQualityPicked } = load(code, ['switchQuality', 'onPlaybackQualityPicked'], {
    player, sourceRegistry: { sourceQualities: () => [{ id: 'flac', name: 'flac' }], has: () => true },
    musicApi: { playUrl: () => d.promise, playConfigEpoch: () => 1, playSourceOf: value => value,
      playbackInfoOf: value => ({ source: value, quality: '320', size: 0 }) },
    playbackInfo: { get value() { return { source: player.current }; } },
    playbackRequestedQuality: { value: '320' },
    pageAlive: true, pageVisible: { value: true }, playingLocalFile: { value: false }, playingPodcast: { value: false },
    playbackSourceSection: { value: '' }, playbackSourceOpen: { value: false }, beginLoading: () => 1, finishLoading: noop,
  });
  switchQuality(); onPlaybackQualityPicked('flac'); player.current = b; revision++;
  d.resolve('https://audio.invalid/a.flac'); await drain(); assert.equal(events.length, 0); assert.equal(a.url, undefined);
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
await check('native audio capabilities separate iOS DSP from Android decoder controls and disable effects during DLNA', () => {
  const source = read('services/audio-player.uts');
  const capabilities = (platform, casting, dsp = true) => {
    const body = between(preprocessPlatform(source, platform), 'export function audioCapabilities()', '\nexport class AudioPlayer');
    return load(body, ['audioCapabilities'], { audioDlnaActive: () => casting, audioEffectsSupported: () => dsp }).audioCapabilities();
  };
  assert.ok(Object.values(capabilities('APP-HARMONY', false)).every(value => value === false));
  assert.ok(Object.values(capabilities('APP-ANDROID', false)).every(value => value === true));
  assert.ok(Object.values(capabilities('APP-ANDROID', true)).every(value => value === false));
  const ios = capabilities('APP-IOS', false);
  assert.equal(ios.equalizer, true);
  assert.equal(ios.volumeEnhancement, true);
  assert.equal(ios.floatOutput, false);
  assert.equal(ios.softwareDecoder, false);
  assert.ok(Object.values(capabilities('APP-IOS', true)).every(value => value === false));
  assert.ok(Object.values(capabilities('APP-IOS', false, false)).every(value => value === false));
  const equalizer = read('pages/equalizer/index.uvue'), settings = read('pages/play-settings/index.uvue');
  assert.ok(equalizer.includes(':disabled="!effectsSupported"'));
  for (const [action, capability] of [['toggleFloatOutput', 'floatOutput'], ['togglePreferSw', 'softwareDecoder'], ['toggleEnhance', 'volumeEnhancement']]) {
    const method = between(settings, 'function ' + action + '(): void {', '\n}');
    assert.ok(method.includes('refreshAudioCapabilities()'));
    assert.ok(method.includes(`if (!capabilities.value.${capability})`));
    assert.ok(settings.includes(`:disabled="!capabilities.${capability}"`));
  }
});
await check('play-settings renders the actual capability hint after local / cast transitions without stale identifiers', () => {
  const settings = read('pages/play-settings/index.uvue');
  const hints = [...settings.matchAll(/<text\b[^>]*class="hint-text"[^>]*>([\s\S]*?)<\/text>/g)];
  const hint = hints.find(match => match[1].includes('浮点输出'));
  assert.ok(hint, 'missing audio capability hint');
  const expression = hint[1].match(/{{([\s\S]*?)}}/);
  assert.ok(expression, 'capability hint must react to the active audio backend');
  const { renderHint } = load('function renderHint(capabilities: any): string { return (' + expression[1] + '); }', ['renderHint']);
  let current = { floatOutput: true, softwareDecoder: true, volumeEnhancement: true };
  const listeners = new Map(), cleanups = [];
  const api = load(between(settings, 'const capabilities =', '\nfunction toggleFloatOutput'), [
    'capabilities', 'floatOutput', 'preferSw', 'enhanceOn',
  ], {
    ref: value => ({ value }), audioCapabilities: () => ({ ...current }),
    audioPlayer: { floatOutput: true, preferSoftwareDecoder: true, enhanceEnabled: true },
    PLAYER_CAPABILITIES_CHANGED_EVENT: 'capabilities',
    uni: { $on: (event, fn) => listeners.set(event, fn), $off: event => listeners.delete(event) },
    onUnload: fn => cleanups.push(fn), onUnmounted: fn => cleanups.push(fn),
  });
  for (const [capability, expected] of [
    [current, '下一首或停止后重播生效'],
    [{ floatOutput: false, softwareDecoder: false, volumeEnhancement: true }, '支持音量增强，暂不支持浮点输出'],
    [{ floatOutput: false, softwareDecoder: false, volumeEnhancement: false }, '暂不支持浮点输出、解码器选择和音量增强'],
    [current, '下一首或停止后重播生效'],
  ]) {
    current = capability;
    listeners.get('capabilities')();
    assert.ok(renderHint(api.capabilities.value).includes(expected));
    assert.equal(api.floatOutput.value, capability.floatOutput);
    assert.equal(api.preferSw.value, capability.softwareDecoder);
    assert.equal(api.enhanceOn.value, capability.volumeEnhancement);
  }
  for (const cleanup of cleanups) cleanup();
  assert.equal(listeners.size, 0);
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
    setTimeout, clearTimeout,
  });
  const signature = Buffer.alloc(64).toString('base64');
  assert.equal((await verifyOfficialSignature('tampered/*__QT_SIGN__' + JSON.stringify({ alg: 'ed25519', sig: signature }) + '*/')).ok, false);
  assert.equal(calls, 1, 'validly shaped signature reaches trusted host verification');
  assert.equal((await verifyOfficialSignature('tampered/*__QT_SIGN__' + JSON.stringify({ alg: 'ed25519', sig: 'invalid' }) + '*/')).ok, false);
  assert.equal(calls, 1, 'invalid signature encoding never enters the bridge');
  assert.ok(!src.includes('evalOnEngine('));
  const harmonyBridge = read('uni_modules/qt-js-engine/utssdk/app-harmony/index.uts');
  const harmonyNative = read('uni_modules/qt-js-engine/utssdk/app-harmony/builder.ets');
  assert.ok(harmonyBridge.includes('verifyPackSignatureNative(content, signatureBase64, publicKeyHex'), 'Harmony UTS delegates to the ArkTS native implementation');
  assert.ok(!harmonyBridge.includes("createAsyKeyGenerator('Ed25519')"), 'crypto calls stay out of the UTS lowering path');
  assert.ok(harmonyNative.includes("createVerify('Ed25519')"));
  assert.ok(harmonyNative.includes('convertKey({ data: bytes }, null)'), 'installed SDK requires separate public/private key arguments');
});
if (process.env.QT_HARMONY_DIST) await check('generated Harmony artifact contains the real native verifier', () => {
  const root = process.env.QT_HARMONY_DIST.replace(/[\\/]+$/, '') + '/uni_modules/qt-js-engine/utssdk/app-harmony/';
  const bridge = readFileSync(root + 'index.ets', 'utf8');
  const native = readFileSync(root + 'builder.ets', 'utf8');
  assert.ok(!/function verifyPackSignature\([^)]*\): void \{\}/.test(bridge), 'UTS lowering must not emit an empty exported verifier');
  assert.ok(!/verifyPackSignature[^=]*=\([^)]*\): void\s*=>\s*\{\s*\}/.test(bridge), 'typed verifier export must retain its body');
  assert.ok(bridge.includes('verifyPackSignatureNative(content, signatureBase64, publicKeyHex'), 'generated bridge calls native ArkTS');
  assert.ok(native.includes("createAsyKeyGenerator('Ed25519')"));
  assert.ok(native.includes('convertKey({ data: bytes }, null)'));
  assert.ok(native.includes("createVerify('Ed25519')"));
});
await check('verification settles even when the native bridge never calls back', async () => {
  // 模拟原生桥未执行或未回调导致 Promise 悬挂，调用方 await 与 loading 一直等待。
  // 这里验证服务侧超时收口；具体桥接故障原因由生成产物检查另行核对。
  const src = read('services/pack-signature.uts');
  const { verifyOfficialSignature } = load(src, ['verifyOfficialSignature'], {
    parseJsonToUtso: text => ({ get: k => JSON.parse(text)[k] }),
    verifyPackSignature: () => { /* 刻意永不回调 */ },
    setTimeout, clearTimeout,
  });
  const signature = Buffer.alloc(64).toString('base64');
  const pack = 'x/*__QT_SIGN__' + JSON.stringify({ alg: 'ed25519', sig: signature }) + '*/';
  const raced = await Promise.race([
    verifyOfficialSignature(pack),
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 12000)),
  ]);
  assert.notEqual(raced, 'still-pending', 'bridge silence must not hang the caller forever');
  assert.equal(raced.ok, false);
  assert.ok(String(raced.message).length > 0, 'timeout path still carries a user-facing reason');
  // 同步抛错的桥也必须收口，而不是把异常冒到页面
  const { verifyOfficialSignature: throwing } = load(src, ['verifyOfficialSignature'], {
    parseJsonToUtso: text => ({ get: k => JSON.parse(text)[k] }),
    verifyPackSignature: () => { throw new Error('bridge exploded'); },
    setTimeout, clearTimeout,
  });
  const thrown = await throwing(pack);
  assert.equal(thrown.ok, false);
  assert.ok(String(thrown.message).includes('bridge exploded'));
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
