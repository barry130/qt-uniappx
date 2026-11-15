// Execute the production UTS facade with controllable native receipts. This
// validates the JS/native contract on Windows without claiming an Apple build.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const native = resolve(root, 'uni_modules/qt-audio-player/utssdk/app-ios');
const source = readFileSync(resolve(native, 'index.uts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const track = (id, duration = 240) => ({
  mediaId: id, uri: 'qt-resolve://song/?mid=' + encodeURIComponent(id),
  title: id, artist: 'artist', album: 'album', coverUrl: '', duration,
});

function harness() {
  const calls = [];
  let listener = null;
  let remoteCommand = null;
  let local = { id: '', index: -1, position: 0, intending: false, items: [] };
  let remoteItems = [];
  let state = {
    target: 'local', sessionId: 0, generation: 0, deviceId: '', deviceName: '',
    phase: 'idle', mediaId: '', positionMs: 0, durationMs: 0, volume: 1,
    canSeek: false, canSetVolume: false, error: '', timelineIndex: -1,
  };
  let remoteIntent = false;
  let stateListener = null;
  let resolveListener = null;
  let trackListener = null;
  const receipts = [];
  const audio = {
    setEventListener(cb) { listener = cb; },
    setRemoteCommandListener(cb) { remoteCommand = cb; },
    setPlaylist(json, index, autoPlay, position) {
      const items = JSON.parse(json);
      calls.push(['localPlaylist', items, Number(index), autoPlay, Number(position)]);
      local = { items, id: items[Number(index)]?.mediaId ?? '', index: Number(index),
        position: Number(position), intending: autoPlay };
    },
    playTimelineIndex(index) {
      local.index = Number(index); local.id = local.items[local.index]?.mediaId ?? '';
      calls.push(['localIndex', local.index]);
      listener?.('trackchanged', local.id, '0', '0', false);
    },
    syncTimeline(json, id) {
      const items = JSON.parse(json);
      const ordinal = local.items.slice(0, local.index + 1).filter(item => item.mediaId === id).length;
      local.index = items.map((item, index) => ({ item, index })).filter(({ item }) => item.mediaId === id)[ordinal - 1]?.index ?? -1;
      local.items = items;
      calls.push(['localSync', items, id]);
    },
    play() {
      if (state.target === 'dlna') remoteCommand('play', '');
      else { local.intending = true; calls.push(['localPlay']); }
    },
    pause() {
      if (state.target === 'dlna') remoteCommand('pause', '');
      else { local.intending = false; calls.push(['localPause']); }
    },
    stop() {
      if (state.target === 'dlna') remoteCommand('stop', '');
      else { local.intending = false; calls.push(['localStop']); }
    },
    seek(value) {
      if (state.target === 'dlna') remoteCommand('seek', value);
      else { local.position = Number(value); calls.push(['localSeek', Number(value)]); }
    },
    currentTime() { return String(state.target === 'dlna' ? state.positionMs / 1000 : local.position); },
    currentMediaID() { return state.target === 'dlna' ? state.mediaId : local.id; },
    currentTimelineIndex() { return String(state.target === 'dlna' ? state.timelineIndex : local.index); },
    timelineSize() { return String(local.items.length); },
    isIntendingToPlay() { return local.intending; },
    setRepeatMode(value) { calls.push(['localRepeat', Number(value)]); },
    previous() { calls.push(['localPrevious']); },
    next() { calls.push(['localNext']); },
    effectsSupported() { return state.target !== 'dlna'; },
    resolveDone(id, url) { calls.push(['localResolve', id, url]); },
    resolveFailed(id) { calls.push(['localResolveFail', id]); },
    requestNotificationPermission(cb) { cb(false); },
    monotonicTime() { return '123456'; },
    clearCache() { return true; },
    cacheSize() { return '1048576'; },
    evictSongCache(id) { calls.push(['evict', id]); return true; },
    invalidateSourcePolicy() { calls.push(['invalidateLocalPolicy']); },
  };
  for (const name of ['setSource', 'setTitle', 'setArtist', 'setAlbum', 'setCover',
    'setCacheLimit', 'setConcurrentMode', 'setSpeed', 'postNotice',
    'setLiked', 'setTrackCover', 'preloadTrack', 'setEqualizerEnabled',
    'setEqualizerBands', 'setEnhanceEnabled', 'setEnhanceGain', 'setResolveReferer']) {
    audio[name] = (...args) => calls.push([name, ...args]);
  }
  audio.setVolume = value => {
    if (state.target === 'dlna') remoteCommand('volume', value);
    else calls.push(['setVolume', value]);
  };
  const dlna = {
    setListeners(onState, onResolve, onTrack) {
      stateListener = onState; resolveListener = onResolve; trackListener = onTrack;
    },
    isActive() { return state.target === 'dlna'; },
    isIntendingToPlay() { return remoteIntent; },
    state() { return JSON.stringify(state); },
    timelineSize() { return String(remoteItems.length); },
    currentTimelineIndex() { return String(state.timelineIndex); },
    discover(cb) { cb(JSON.stringify([{ id: 'tv', name: 'TV', canSeek: true, canSetVolume: false }]), ''); },
    connect(id) {
      calls.push(['connect', id]);
      if (id === 'missing') return false;
      state = { ...state, target: 'dlna', sessionId: state.sessionId + 1, deviceId: id, deviceName: id,
        mediaId: '', timelineIndex: -1, phase: 'connected' };
      return true;
    },
    setPlaylist(json, index, intending, position) {
      const items = JSON.parse(json);
      remoteItems = items;
      calls.push(['remotePlaylist', items, Number(index), intending, Number(position)]);
      remoteIntent = intending;
      state = { ...state, generation: state.generation + 1, mediaId: items[Number(index)]?.mediaId ?? '',
        positionMs: Number(position) * 1000, durationMs: (items[Number(index)]?.duration ?? 0) * 1000,
        phase: intending ? 'playing' : 'paused', canSeek: true, timelineIndex: Number(index) };
      stateListener?.(JSON.stringify(state));
    },
    syncTimeline(json, id) {
      const items = JSON.parse(json);
      const ordinal = remoteItems.slice(0, state.timelineIndex + 1).filter(item => item.mediaId === id).length;
      state.timelineIndex = items.map((item, index) => ({ item, index })).filter(({ item }) => item.mediaId === id)[ordinal - 1]?.index ?? -1;
      remoteItems = items;
      calls.push(['remoteSync', items, id]);
    },
    playTimelineIndex(index) {
      state = { ...state, timelineIndex: Number(index), mediaId: remoteItems[Number(index)]?.mediaId ?? '' };
      calls.push(['remoteIndex', Number(index)]);
      stateListener?.(JSON.stringify(state));
      trackListener?.(state.mediaId, false);
    },
    setRepeatMode(value) { calls.push(['remoteRepeat', Number(value)]); },
    play() { remoteIntent = true; calls.push(['remotePlay']); },
    pause() { remoteIntent = false; calls.push(['remotePause']); },
    stop() { remoteIntent = false; calls.push(['remoteStop']); },
    seek(value) { state.positionMs = Number(value) * 1000; calls.push(['remoteSeek', Number(value)]); },
    setVolume(value) { calls.push(['remoteVolume', Number(value)]); },
    resolveDone(...args) { calls.push(['remoteResolve', ...args]); },
    resolveFailed(...args) { calls.push(['remoteResolveFail', ...args]); },
    invalidateSourcePolicy() { calls.push(['invalidateRemotePolicy']); },
    disconnect(cb) {
      calls.push(['remoteDisconnect']);
      state = { ...state, target: 'local', mediaId: '', timelineIndex: -1, phase: 'idle' };
      local.intending = false;
      receipts.push(cb);
    },
  };
  const context = vm.createContext({ exports: {}, QtIOSAudio: { shared: audio }, QtIOSDLNA: { shared: dlna } });
  vm.runInContext(js, context, { filename: 'app-ios/index.uts' });
  return {
    api: context.exports, calls, receipts,
    event: (...args) => listener(...args),
    resolve: (...args) => resolveListener(...args),
    track: (...args) => trackListener(...args),
    command: (...args) => remoteCommand(...args),
    getState: () => structuredClone(state),
    setState: update => { state = { ...state, ...update }; stateListener?.(JSON.stringify(state)); },
    setLocal: update => { local = { ...local, ...update }; },
  };
}

let count = 0;
function test(name, run) {
  run(); count++; console.log(`PASS iOS audio ${name}`);
}
function playing(h, autoPlay = true) {
  h.api.audioSetPlaylist([track('a'), track('b')], 1, autoPlay, 45);
  assert.equal(h.api.audioDlnaConnect('tv'), true);
}

test('failed connection preserves local playback and position', () => {
  const h = harness();
  h.api.audioSetPlaylist([track('a')], 0, true, 33);
  assert.equal(h.api.audioDlnaConnect('missing'), false);
  assert.equal(h.api.audioGetCurrentTime(), 33);
  assert.equal(h.api.audioIsIntendingToPlay(), true);
  assert.equal(h.calls.filter(c => c[0] === 'localPause' || c[0] === 'localStop').length, 0);
});
test('connection passes current song, position and pause intention', () => {
  const h = harness(); playing(h, false);
  const push = h.calls.find(c => c[0] === 'remotePlaylist');
  assert.equal(push[2], 1); assert.equal(push[3], false); assert.equal(push[4], 45);
  assert.equal(h.api.audioGetCurrentTime(), 45);
  assert.equal(h.api.audioIsIntendingToPlay(), false);
});
test('casting the second occurrence of a song preserves its queue index', () => {
  const h = harness();
  h.api.audioSetPlaylist([track('a'), track('b'), track('a'), track('c')], 2, false, 19);
  h.api.audioDlnaConnect('tv');
  const remote = h.calls.find(c => c[0] === 'remotePlaylist');
  assert.equal(remote[2], 2); assert.equal(remote[3], false); assert.equal(remote[4], 19);
});
test('switching renderers captures the remote occurrence before native state resets', () => {
  const h = harness();
  h.api.audioSetPlaylist([track('a'), track('b'), track('a'), track('c')], 0, true, 0);
  h.api.audioDlnaConnect('tv');
  h.setState({ mediaId: 'a', timelineIndex: 2, positionMs: 73000 });
  h.api.audioDlnaConnect('tv2');
  const remote = h.calls.filter(c => c[0] === 'remotePlaylist').at(-1);
  assert.equal(remote[2], 2); assert.equal(remote[4], 73);
});
test('native local track callbacks remember the actual duplicate occurrence', () => {
  const h = harness();
  h.api.audioSetPlaylist([track('a'), track('b'), track('a'), track('c')], 1, true, 0);
  h.setLocal({ id: 'a', index: 2 });
  h.event('trackchanged', 'a', '0', '0', true);
  // A temporarily unavailable getter should still use the last native event.
  h.setLocal({ index: -1 });
  h.api.audioDlnaConnect('tv');
  assert.equal(h.calls.find(c => c[0] === 'remotePlaylist')[2], 2);
});
test('remote state advances the duplicate occurrence used by native Next', () => {
  const h = harness();
  h.api.audioSetPlaylist([track('a'), track('b'), track('a'), track('c')], 0, true, 0);
  h.api.audioDlnaConnect('tv');
  h.setState({ mediaId: 'a', timelineIndex: 2 });
  h.command('next', '');
  assert.deepEqual(h.calls.find(c => c[0] === 'remoteIndex'), ['remoteIndex', 3]);
});
test('inserting before a local duplicate preserves its occurrence during sync and casting', () => {
  const h = harness();
  const items = [track('a'), track('b'), track('a'), track('c')];
  h.api.audioSetPlaylist(items, 2, false, 31);
  h.api.audioSyncTimeline([track('x'), ...items], 'a');
  h.setLocal({ index: -1 });
  h.api.audioDlnaConnect('tv');
  const remote = h.calls.find(c => c[0] === 'remotePlaylist');
  assert.equal(remote[2], 3); assert.equal(remote[4], 31);
});
test('inserting before a remote duplicate preserves the Next and return positions', () => {
  const h = harness();
  const items = [track('a'), track('b'), track('a'), track('c')];
  h.api.audioSetPlaylist(items, 2, false, 42);
  h.api.audioDlnaConnect('tv');
  h.api.audioSyncTimeline([track('x'), ...items], 'a');
  h.api.audioDlnaDisconnect(true); h.receipts.shift()(true);
  const local = h.calls.filter(c => c[0] === 'localPlaylist').at(-1);
  assert.equal(local[2], 3); assert.equal(local[3], false); assert.equal(local[4], 42);
  h.api.audioDlnaConnect('tv');
  h.command('next', '');
  assert.deepEqual(h.calls.find(c => c[0] === 'remoteIndex'), ['remoteIndex', 4]);
});
test('remote queue changes do not load a local decoder', () => {
  const h = harness(); playing(h);
  h.api.audioSetPlaylist([track('c')], 0, true, 12);
  h.api.audioPlayTimelineIndex(0);
  assert.equal(h.calls.filter(c => c[0] === 'localPlaylist').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'localIndex').length, 0);
  assert.equal(h.calls.filter(c => c[0] === 'remotePlaylist').length, 2);
});
test('return to local waits for Stop and preserves paused position', () => {
  const h = harness(); playing(h, false);
  h.setState({ positionMs: 78900 });
  h.api.audioDlnaDisconnect(true);
  assert.equal(h.calls.filter(c => c[0] === 'localPlaylist').length, 1);
  h.receipts.shift()(true);
  const local = h.calls.filter(c => c[0] === 'localPlaylist').at(-1);
  assert.equal(local[2], 1); assert.equal(local[3], false); assert.equal(local[4], 78.9);
});
test('returning from a duplicate song keeps the selected occurrence after native disconnect clears it', () => {
  const h = harness();
  h.api.audioSetPlaylist([track('a'), track('b'), track('a'), track('c')], 2, true, 62);
  h.api.audioDlnaConnect('tv');
  h.api.audioDlnaDisconnect(true); h.receipts.shift()(true);
  const local = h.calls.filter(c => c[0] === 'localPlaylist').at(-1);
  assert.equal(local[2], 2); assert.equal(local[3], true); assert.equal(local[4], 62);
});
for (const [action, run] of [
  ['volume setter', h => h.api.audioSetVolume(0.4)],
  ['remote volume command', h => h.command('volume', '0.4')],
  ['source preference invalidation', h => h.api.audioInvalidateSourcePolicy()],
]) {
  test(`${action} is independent of a pending return-to-local receipt`, () => {
    const h = harness(); playing(h);
    h.api.audioDlnaDisconnect(true); run(h); h.receipts.shift()(true);
    const local = h.calls.filter(c => c[0] === 'localPlaylist');
    assert.equal(local.length, 2); assert.equal(local[1][2], 1);
  });
}
test('failed remote Stop never starts local playback', () => {
  const h = harness(); playing(h);
  h.api.audioDlnaDisconnect(true); h.receipts.shift()(false);
  assert.equal(h.calls.filter(c => c[0] === 'localPlaylist').length, 1);
});
for (const [action, run] of [
  ['pause', h => h.api.audioPause()],
  ['stop', h => h.api.audioStop()],
  ['seek', h => h.api.audioSeek(17)],
  ['source change', h => h.api.audioSetSrc('file:///new.mp3')],
  ['new queue', h => h.api.audioSetPlaylist([track('c')], 0, false, 9)],
]) {
  test(`${action} invalidates an old return-to-local receipt`, () => {
    const h = harness(); playing(h);
    h.api.audioDlnaDisconnect(true); run(h);
    const before = h.calls.filter(c => c[0] === 'localPlaylist').length;
    h.receipts.shift()(true);
    assert.equal(h.calls.filter(c => c[0] === 'localPlaylist').length, before);
  });
}
test('switching renderers cancels a previous return receipt', () => {
  const h = harness(); playing(h);
  h.api.audioDlnaDisconnect(true); h.api.audioDlnaConnect('tv2'); h.receipts.shift()(true);
  assert.equal(h.api.audioDlnaState().deviceId, 'tv2');
  assert.equal(h.calls.filter(c => c[0] === 'localPlaylist').length, 1);
});
test('notification denial is reported accurately', () => {
  const h = harness(); let permission = true;
  h.api.ensureNotificationPermission(value => { permission = value; });
  assert.equal(permission, false);
});
test('DLNA resolve generation uses unitless generation and millisecond state', () => {
  const h = harness(); playing(h);
  let resolved;
  h.api.audioDlnaOnResolveRequest((...args) => { resolved = args; });
  h.resolve('b', '7', true);
  assert.deepEqual(resolved, ['b', 7, true]);
  h.api.audioDlnaResolveDone('b', 'https://media/a.mp3', 'https://source/', 7);
  assert.deepEqual(h.calls.at(-1), ['remoteResolve', 'b', 'https://media/a.mp3', 'https://source/', '7']);
  assert.equal(h.api.audioDlnaState().positionMs, 45000);
});
test('metadata/EQ/gain setters reach native methods while decoder selectors stay unsupported', () => {
  const h = harness();
  h.api.audioSetEqualizerEnabled(true); h.api.audioSetEqualizerBands([1, 2, 3, 4, 5]);
  h.api.audioSetEnhanceEnabled(true); h.api.audioSetEnhanceGain(300);
  const before = h.calls.length;
  h.api.audioSetFloatOutput(true); h.api.audioSetPreferSoftwareDecoder(true);
  assert.equal(h.calls.length, before);
  assert.deepEqual(h.calls[0], ['setEqualizerEnabled', true]);
  assert.deepEqual(h.calls[1], ['setEqualizerBands', '[1,2,3,4,5]']);
  assert.deepEqual(h.calls[3], ['setEnhanceGain', '300']);
});
test('source policy invalidation reaches both native owners', () => {
  const h = harness();
  h.api.audioInvalidateSourcePolicy();
  assert.deepEqual(h.calls, [['invalidateLocalPolicy'], ['invalidateRemotePolicy']]);
});
test('resolved source Referer reaches the native loader before local resolution', () => {
  const h = harness();
  h.api.audioSetResolveReferer('a', 'https://source.example/');
  h.api.audioResolveDone('a', 'https://source.example/audio.mp3');
  assert.deepEqual(h.calls, [
    ['setResolveReferer', 'a', 'https://source.example/'],
    ['localResolve', 'a', 'https://source.example/audio.mp3'],
  ]);
});
test('native next/previous calls the registered store exactly once', () => {
  const h = harness(); let next = 0;
  h.api.audioOnNext(() => { next++; }); h.event('next', 'a', '0', '0', false);
  assert.equal(next, 1); assert.equal(h.calls.filter(c => c[0] === 'localNext').length, 0);
});
test('discovery maps native capability values without enabling absent volume', () => {
  const h = harness(); let devices;
  h.api.audioDlnaDiscover(found => { devices = found; });
  assert.equal(devices[0].canSeek, true);
  assert.equal(devices[0].canSetVolume, false);
});
test('synchronous remote Seek reaches transport with seconds', () => {
  const h = harness(); playing(h); h.api.audioSeek(67.5);
  assert.deepEqual(h.calls.at(-1), ['remoteSeek', 67.5]);
  assert.equal(h.api.audioGetCurrentTime(), 67.5);
});
test('effects are unavailable while a renderer owns playback', () => {
  const h = harness(); assert.equal(h.api.audioEffectsSupported(), true);
  playing(h); assert.equal(h.api.audioEffectsSupported(), false);
  assert.equal(h.api.audioLyricShow(), false);
  assert.equal(h.api.audioLyricHasOverlayPermission(), false);
});
test('every mixed Swift method called by UTS exists in the native source', () => {
  for (const [type, file] of [['QtIOSAudio', 'QtIOSAudio.swift'], ['QtIOSDLNA', 'QtIOSDLNA.swift']]) {
    const swift = readFileSync(resolve(native, file), 'utf8');
    const methods = new Set([...swift.matchAll(/public\s+func\s+(\w+)\s*\(/g)].map(m => m[1]));
    for (const match of source.matchAll(new RegExp(`${type}\\.shared\\.(\\w+)\\(`, 'g'))) {
      assert.ok(methods.has(match[1]), `${type}.${match[1]} has no native declaration`);
    }
  }
});
console.log(`PASS iOS audio: ${count} production-facade contract and delayed-receipt regressions`);
