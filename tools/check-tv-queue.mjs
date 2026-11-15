// Approved seam: actual compiled QtPlaybackQueue/QtPlayerBar templates -> public QtUI services.
// This first vertical slice supplies only empty player data and native collection/back boundaries.
// No queue action or private component handler is mocked/exported/called.
import assert from 'node:assert/strict';
import { dirname, relative, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as Vue from 'vue';
import { toRaw } from 'vue';
import ts from 'typescript';
import { tvSettingsFixture } from './check-tv-settings.mjs';

const UI = 'uni_modules/qt-ui/';
const QUEUE = UI + 'components/qt-playback-queue/qt-playback-queue.uvue';
const BAR = UI + 'components/qt-player-bar/qt-player-bar.uvue';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const noop = () => {};

// The SDK object/storage/timer/audio/network interfaces are synthetic; every loaded
// business module is the complete production module, including the full PlayerStore.
class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  set(key, value) { this[key] = value; }
  get(key) { return this[key] ?? null; }
  static keys(value) { return Object.keys(value); }
}
function androidSource(text) {
  const stack = [], lines = []; let enabled = true;
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const match = line.match(/^\s*\/\/\s*#(ifdef|ifndef|else|endif)\s*(.*?)\s*$/);
    if (!match) { if (enabled) lines.push(line); continue; }
    const [, kind, expression] = match;
    if (kind === 'ifdef' || kind === 'ifndef') {
      const matches = expression.split(/\|\|/).some(symbol => ['APP', 'APP-ANDROID'].includes(symbol.trim()));
      stack.push({ parent: enabled, matches: kind === 'ifdef' ? matches : !matches });
      enabled = enabled && stack.at(-1).matches;
    } else {
      const frame = stack.at(-1); assert.ok(frame, 'balanced native directives');
      if (kind === 'else') enabled = frame.parent && !frame.matches;
      else { stack.pop(); enabled = frame.parent; }
    }
  }
  assert.equal(stack.length, 0, 'balanced native directives'); return lines.join('\n');
}
function realPlayerModules(b) {
  const cache = new Map(), timers = new Map(); let timerId = 0;
  const uni = { getStorageSync: key => b.storage.get(key) ?? null,
    setStorageSync(key, value) { b.storage.set(key, value); b.storageWrites.push([key, value]); },
    removeStorageSync: key => b.storage.delete(key), $on: noop, $off: noop, $emit: noop,
    getSystemInfoSync: () => ({ platform: 'android' }), getDeviceInfo: () => ({ osName: 'Android', osVersion: 'fixture' }),
    getNetworkType: value => value.success?.({ networkType: 'wifi' }), onNetworkStatusChange: noop,
    getFileSystemManager: () => ({ access: value => value.fail?.({ errMsg: 'ENOENT' }) }),
  };
  const native = { publicDataDir: () => '', queryPermissionStates: () => [],
    statLocalFile: () => ({ exists: false }), readEmbeddedTags: (_path, reply) => reply?.(null) };
  const logger = Object.fromEntries(['logWarn','logWarnV','logErrV','logInfo','logMsg','logMsgErr','logMsgWarn'].map(key => [key, noop]));
  const overrides = {
    'services/audio-player': b.audio, 'services/logger': logger,
    'services/music-api': { musicApi: { availableQualities: () => ['320'], lyric: async () => null }, isContentFailError: () => false },
    'services/diag': { qtDiag: noop }, 'services/app-native': { exitApp: noop, supportsHomeBackMode: () => true },
    'services/media': { DEFAULT_PLAYLIST_COVER_ASSET: '/static/playlist.png' },
    'services/toast': { qtShowToast: value => b.toastCalls.push(value) },
    'services/confirm': { qtConfirm: () => { throw new Error('unexpected confirm'); } },
    'services/action-sheet': b.action, 'stores/downloads': { useDownloadsStore: () => ({ items: [], downloadQuality: '320', restore: noop }) },
    'uni_modules/qt-js-engine': native, 'uni_modules/qt-app-native': native,
    'uni_modules/qt-audio-player': new Proxy({}, { get: () => noop }),
  };
  function load(request, from = resolve(ROOT, 'fixture.ts')) {
    if (request === 'vue') return Vue;
    let path = request.startsWith('@/') ? resolve(ROOT, request.slice(2)) : request.startsWith('.') ? resolve(dirname(from), request) : resolve(ROOT, request);
    const key = relative(ROOT, path).replaceAll('\\', '/').replace(/\.(ts|uts)$/, '');
    if (overrides[key]) return overrides[key];
    if (!existsSync(path)) path = ['.ts', '.uts'].map(ext => path + ext).find(existsSync) ?? path;
    if (cache.has(path)) return cache.get(path).exports;
    const code = ts.transpileModule(androidSource(readFileSync(path, 'utf8')), { fileName: path.replace(/\.uts$/, '.ts'), compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const module = { exports: {} }; cache.set(path, module);
    vm.runInNewContext(code, { console, uni, UTSJSONObject, exports: module.exports, module, require: value => load(value, path),
      setInterval(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearInterval: id => timers.delete(id),
      setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    }, { filename: path });
    return module.exports;
  }
  return { load, close: () => timers.clear() };
}
const descendants = node => node == null ? [] : [node, ...node.children.flatMap(descendants)];
async function queueFixture({ savedMode = 'tv', width = 1280, height = 720, withConfirm = false } = {}) {
  let player, b;
  const confirmHost = withConfirm ? {
    'services/confirm': null,
    'fixture-queue-confirm': { __esModule: true, default: Vue.defineComponent({ setup: () => () => Vue.h('view', {}, [
      Vue.h(b.load(QUEUE).default), Vue.h(b.load(UI + 'components/qt-confirm-host/qt-confirm-host.uvue').default),
    ]) }) },
  } : {};
  b = await tvSettingsFixture({ savedMode, width, height,
    boundaryOverrides: { ...confirmHost, 'stores/player': { usePlayerStore: () => player },
      'services/tv-platform': { tvReadDevice: () => ({ television: false, nativeAvailable: false }),
        tvStartRemote: noop, tvSetRemoteState: noop, tvStopRemote: noop, tvHighlight: noop, tvPresent: noop, tvBack: noop,
        tvCollect: root => descendants(toRaw(root)).filter(node => node.props.id && !String(node.props.class).split(/\s+/).includes('qt-tv-skip')).map((node, index) => ({
          id: 'tv:fixture:page:custom:' + node.props.id, left: 30 + (index % 4) * 64, top: 50 + Math.floor(index / 4) * 76,
          width: 56, height: 56, visible: true, enabled: true, input: false, longPress: false, scrollGroup: 'queue-list',
        })),
        tvActivate: () => { throw new Error('unexpected activation boundary'); }, tvScroll: () => false,
      },
    },
  });
  const modules = realPlayerModules(b); player = modules.load('stores/player.ts').usePlayerStore();
  return { b, player, close: async () => { modules.close(); await b.close(); } };
}

async function queueActionsCase() {
  const f = await queueFixture(), { b, player } = f;
  try {
    const song = (id, name) => ({ id, platform: 'local', name, singer: '歌手', album: '', picUrl: '', url: 'file:///sample.mp3', duration: 200 });
    player.queue = [song('same', '同曲第一次'), song('same', '同曲第二次'), song('third', '第三首')];
    player.current = player.queue[1];
    const originals = Array.from(player.queue), playing = player.current;
    await b.mount(QUEUE, {}, false);
    const row = b.byClass('qpq-row')[1];
    assert.ok(row.props.id, 'queue occurrences expose stable public native focus IDs');
    const id = row.props.id;
    const up = row.children.find(node => String(node.props.class).split(/\s+/).includes('qpq-move-up'));
    assert.ok(up, 'TV queue exposes an explicit single-step move-up action');
    assert.equal(Number.parseFloat(b.css(up).width), 56); assert.equal(Number.parseFloat(b.css(up).height), 56);
    await b.dispatch(up);
    assert.deepEqual(Array.from(player.queue), [originals[1], originals[0], originals[2]], 'one public click moves one occurrence only');
    assert.equal(player.current, playing, 'queue editing retains the exact playing object');
    assert.equal(b.byClass('qpq-row')[0].props.id, id, 'focus identity follows the moved occurrence, not its old index');
    assert.ok(b.storageWrites.some(([key]) => key === 'qt-player-state'), 'actual player persistence follows the queue action');
  } finally { await f.close(); }
}

async function queueRestoreCase() {
  const f = await queueFixture(), { b, player } = f;
  try {
    const song = id => ({ id, platform: 'local', name: id, singer: '', album: '', picUrl: '', url: 'file:///sample.mp3', duration: 200 });
    const duplicate = song('same-object');
    player.queue = Array.from({ length: 30 }, (_, i) => i === 6 || i === 7 ? duplicate : song('track-' + i));
    player.current = player.queue[0]; const current = player.current;
    await b.mount(QUEUE, {}, false);
    await b.dispatch(b.byClass('qpq-list')[0], 'scroll', { scrollTop: 420 });
    const visible = b.byClass('qpq-row'), copies = visible.filter(row => descendants(row).some(node => node.text === 'same-object'));
    assert.equal(copies.length, 2); const [first, second] = copies, firstId = first.props.id, secondId = second.props.id;
    await b.dispatch(second.children.find(node => String(node.props.class).includes('qpq-move-up')));
    assert.equal(b.byClass('qpq-row').find(row => Number.parseFloat(b.css(row).top) === 6 * Number.parseFloat(b.css(row).height)).props.id, secondId,
      'moving identical object occurrences still moves their separate identities');
    assert.ok(b.tv.qtTvFocusedId().endsWith(':custom:' + secondId), 'move restores actual public TV focus to the moved occurrence');
    const firstNow = b.byClass('qpq-row').find(row => row.props.id === firstId);
    await b.dispatch(firstNow.children.find(node => String(node.props.class).includes('qpq-remove')));
    assert.equal(player.current, current); assert.equal(player.queue.length, 29);
    assert.ok(b.byClass('qpq-row').some(row => row.props.id === secondId), 'surviving identical occurrence retains its ID after sibling removal');
    assert.ok(b.tv.qtTvFocusedId().endsWith(':custom:' + b.byClass('qpq-row').find(row => descendants(row).some(node => node.text === 'track-8')).props.id), 'remove restores focus to the nearest surviving row');
  } finally { await f.close(); }
}

async function queueDensityCase() {
  const f = await queueFixture(), { b, player } = f;
  try {
    player.queue = [{ id: 'a', platform: 'local', name: '标题', singer: '歌手', album: '', picUrl: '' }];
    player.current = player.queue[0];
    await b.mount(QUEUE, {}, false);
    assert.equal(Number.parseFloat(b.css(b.byClass('qpq-row')[0]).height), 76, 'TV queue has a readable 76px song stride');
    assert.equal(Number.parseFloat(b.css(b.byClass('qpq-header')[0]).height), 76, 'TV queue header fits visible 56px actions');
    for (const control of b.byClass('qpq-action')) {
      assert.equal(Number.parseFloat(b.css(control).width), 56); assert.equal(Number.parseFloat(b.css(control).height), 56);
    }
    assert.ok(b.text().includes('清空') && b.text().includes('关闭'), 'destructive and dismiss actions have visible TV labels');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(Number.parseFloat(b.css(b.byClass('qpq-row')[0]).height), 60, 'ordinary tablet queue retains its previous row size');
  } finally { await f.close(); }
}

async function dockSeekCase() {
  const f = await queueFixture(), { b, player } = f;
  try {
    player.queue = [{ id: 'dock', platform: 'local', name: '播放栏测试', singer: '歌手', album: '', picUrl: '', url: 'file:///sample.mp3', duration: 200 }];
    player.current = player.queue[0]; player.progress = 60; player.duration = 200;
    await b.mount(BAR, {}, false);
    const start = b.byClass('pbar-tv-seek')[0];
    assert.ok(start, 'TV dock exposes a readable explicit seek action, not a native slider');
    const seeks = () => b.nativeCalls.filter(call => call.name === 'audioSeek');
    const before = seeks().length;
    await b.dispatch(start);
    assert.ok(b.byClass('pbar-tv-editor')[0]);
    assert.ok(b.text().includes('1:00') && b.text().includes('预览'), 'TV dock edit starts from current progress with visible preview');
    b.tv.qtTvDispatchRemote({ key: 'right', action: 'down', repeat: 0 }); await b.flush();
    assert.equal(player.progress, 60); assert.equal(seeks().length, before, 'direction previews without touching real playback');
    assert.ok(b.text().includes('1:10'));
    b.tv.qtTvDispatchRemote({ key: 'ok', action: 'down', repeat: 0 }); await b.flush();
    assert.equal(player.progress, 70); assert.equal(seeks().length, before + 1);
    assert.deepEqual(Array.from(seeks().at(-1).args), [70], 'one public OK reaches the real PlayerStore and native audio seek once');
    b.tv.qtTvDispatchRemote({ key: 'ok', action: 'down', repeat: 1 }); await b.flush();
    assert.equal(seeks().length, before + 1, 'held OK does not duplicate the commit');
    await b.dispatch(b.byClass('pbar-tv-seek')[0]);
    b.tv.qtTvDispatchRemote({ key: 'left', action: 'down', repeat: 0 });
    b.tv.qtTvDispatchRemote({ key: 'back', action: 'down', repeat: 0 }); await b.flush();
    assert.equal(player.progress, 70); assert.equal(seeks().length, before + 1);
    assert.equal(b.byClass('pbar-tv-editor').length, 0, 'Back discards the seek preview and restores the dock');
  } finally { await f.close(); }
}

async function dockVolumeCase() {
  const f = await queueFixture(), { b, player } = f;
  try {
    player.queue = [{ id: 'dock', platform: 'local', name: '音量测试', singer: '', album: '', picUrl: '' }];
    player.current = player.queue[0]; player.duration = 200;
    b.audio.audioPlayer.setVolume(0.5);
    await b.mount(BAR, {}, false);
    const volume = b.byClass('pbar-tv-volume')[0];
    assert.ok(volume, 'TV dock exposes an explicit volume preview instead of a touch slider');
    const writes = () => b.storageWrites.filter(([key]) => key === 'qt-playback-volume').length;
    const before = writes();
    await b.dispatch(volume);
    b.tv.qtTvDispatchRemote({ key: 'right', action: 'down', repeat: 0 }); await b.flush();
    assert.ok(b.text().includes('55%') && b.text().includes('音量预览'));
    assert.equal(b.audio.audioPlayer.getVolume(), 0.5); assert.equal(writes(), before, 'volume preview has no persistence/audio side effect');
    b.tv.qtTvDispatchRemote({ key: 'ok', action: 'down', repeat: 0 }); await b.flush();
    assert.equal(b.audio.audioPlayer.getVolume(), 0.55); assert.equal(writes(), before + 1, 'single OK applies and persists volume once');
    b.tv.qtTvDispatchRemote({ key: 'ok', action: 'down', repeat: 1 }); await b.flush();
    assert.equal(writes(), before + 1);
    await b.dispatch(b.byClass('pbar-tv-volume')[0]);
    b.tv.qtTvDispatchRemote({ key: 'left', action: 'down', repeat: 0 });
    b.tv.qtTvDispatchRemote({ key: 'back', action: 'down', repeat: 0 }); await b.flush();
    assert.equal(b.audio.audioPlayer.getVolume(), 0.55); assert.equal(writes(), before + 1);
    assert.equal(b.byClass('pbar-tv-editor').length, 0, 'Back cancels volume edit without writing');
    assert.equal(descendants(b.root).filter(node => node.tag === 'slider').length, 0, 'TV has no native slider requiring touch input');
  } finally { await f.close(); }
}

async function dockRevisionCase() {
  const f = await queueFixture(), { b, player } = f;
  try {
    player.queue = [{ id: 'dock', platform: 'local', name: '同曲重播', singer: '', album: '', picUrl: '', url: 'file:///sample.mp3', duration: 200 }];
    player.current = player.queue[0]; player.progress = 60; player.duration = 200;
    b.audio.audioPlayer.setVolume(0.5);
    await b.mount(BAR, {}, false);
    await b.dispatch(b.byClass('pbar-tv-seek')[0]);
    b.tv.qtTvDispatchRemote({ key: 'right', action: 'down', repeat: 0 }); await b.flush();
    const staleSeekConfirm = b.button('确定'), revision = player.playbackRevision();
    await player.play(player.current); await b.flush();
    assert.ok(player.playbackRevision() > revision, 'same-ID playback restart increments the actual public revision');
    assert.equal(b.byClass('pbar-tv-editor').length, 0, 'same-ID playback restart discards the visible seek preview');
    const seeks = b.nativeCalls.filter(call => call.name === 'audioSeek').length;
    await b.dispatch(staleSeekConfirm);
    assert.equal(b.nativeCalls.filter(call => call.name === 'audioSeek').length, seeks, 'late editor activation cannot seek a new playback revision');
    await b.dispatch(b.byClass('pbar-tv-volume')[0]);
    b.tv.qtTvDispatchRemote({ key: 'right', action: 'down', repeat: 0 }); await b.flush();
    const staleVolumeConfirm = b.button('确定');
    await player.play(player.current); await b.flush();
    assert.equal(b.byClass('pbar-tv-editor').length, 0, 'same-ID playback restart also discards the volume preview');
    const writes = b.storageWrites.filter(([key]) => key === 'qt-playback-volume').length;
    await b.dispatch(staleVolumeConfirm);
    assert.equal(b.storageWrites.filter(([key]) => key === 'qt-playback-volume').length, writes);
    assert.equal(b.audio.audioPlayer.getVolume(), 0.5);
    b.load(UI + 'stores/mini-player.ts').setMiniPlayerMode('docked');
    await b.dispatch(b.byClass('pbar-tv-seek')[0]);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.byClass('pbar-tv-editor').length, 0, 'switching to touch presentation discards TV-only editing');
    assert.equal(descendants(b.root).filter(node => node.tag === 'slider').length, 2, 'ordinary dock restores both native touch sliders');
  } finally { await f.close(); }
}

async function dockTouchCase() {
  const f = await queueFixture({ savedMode: 'touch' }), { b, player } = f;
  try {
    const song = id => ({ id, platform: 'local', name: id, singer: '', album: '', picUrl: '', url: 'file:///sample.mp3', duration: 200 });
    player.queue = [song('first'), song('second')]; player.current = player.queue[0]; player.progress = 60; player.duration = 200;
    b.audio.audioPlayer.setVolume(0.5);
    b.load(UI + 'stores/mini-player.ts').setMiniPlayerMode('docked');
    await b.mount(BAR, {}, false);
    const seek = b.byClass('pbar-seek')[0], volume = b.byClass('pbar-vol-slider')[0];
    assert.ok(seek && volume, 'ordinary dock keeps both real native slider templates');
    const seeks = () => b.nativeCalls.filter(call => call.name === 'audioSeek').length;
    const writes = () => b.storageWrites.filter(([key]) => key === 'qt-playback-volume').length;
    let before = seeks();
    await b.dispatch(seek, 'touchstart'); await b.dispatch(seek, 'changing', { value: 400 });
    assert.equal(player.progress, 60); assert.equal(seeks(), before);
    await b.dispatch(seek, 'change', { value: 400 });
    assert.equal(player.progress, 80); assert.equal(seeks(), before + 1, 'touch seek commits the actual public playback once');
    await b.dispatch(volume, 'touchstart'); await b.dispatch(volume, 'changing', { value: 65 });
    const count = writes(); assert.equal(b.audio.audioPlayer.getVolume(), 0.5);
    await b.dispatch(volume, 'touchcancel'); await b.dispatch(volume, 'change', { value: 65 });
    assert.equal(writes(), count, 'a cancelled native volume drag rejects its late release');
    assert.equal(b.audio.audioPlayer.getVolume(), 0.5);
    await b.dispatch(volume, 'touchstart'); await b.dispatch(volume, 'changing', { value: 70 });
    await player.play(player.current); await b.flush();
    before = writes(); await b.dispatch(volume, 'change', { value: 70 });
    assert.equal(writes(), before, 'same-ID playback restart rejects an old native volume release');
    await b.dispatch(volume, 'touchstart'); await b.dispatch(volume, 'changing', { value: 60 });
    await b.dispatch(volume, 'change', { value: 60 });
    assert.equal(b.audio.audioPlayer.getVolume(), 0.6); assert.equal(writes(), before + 1, 'a fresh touch volume drag still commits once');
    await b.dispatch(seek, 'touchstart'); await b.dispatch(seek, 'changing', { value: 800 });
    await player.play(player.queue[1]); await b.flush(); before = seeks();
    await b.dispatch(seek, 'change', { value: 800 });
    assert.equal(seeks(), before, 'different-track transition rejects stale native seek');
    await b.dispatch(seek, 'touchstart'); await b.dispatch(seek, 'changing', { value: 200 });
    await b.dispatch(seek, 'touchcancel'); before = seeks();
    await b.dispatch(seek, 'change', { value: 200 }); assert.equal(seeks(), before);
  } finally { await f.close(); }
}

async function dockDensityCase() {
  const f = await queueFixture(), { b, player } = f;
  try {
    player.queue = [{ id: 'dock', platform: 'local', name: '播放栏密度', singer: '歌手', album: '', picUrl: '', duration: 200 }];
    player.current = player.queue[0]; player.duration = 200;
    b.load(UI + 'stores/mini-player.ts').setMiniPlayerMode('docked');
    await b.mount(BAR, {}, false);
    assert.equal(Number.parseFloat(b.css(b.byClass('pbar')[0]).height), 104, 'TV player dock keeps its shared 104px safe-area budget');
    for (const control of [...b.byClass('pbar-btn'), ...b.byClass('pbar-main')]) {
      assert.equal(Number.parseFloat(b.css(control).width), 56, 'TV dock transport and utility controls have 56px focusable targets');
      assert.equal(Number.parseFloat(b.css(control).height), 56);
    }
    assert.equal(b.css(b.byClass('pbar-center')[0])['flex-direction'], 'row', '56px transport and seek fit side-by-side inside the 104px dock');
    assert.equal(Number.parseFloat(b.css(b.byClass('pbar-progress')[0]).height), 56);
    const left = Number.parseFloat(b.css(b.byClass('pbar-left')[0]).width), center = Number.parseFloat(b.css(b.byClass('pbar-center')[0]).width), right = Number.parseFloat(b.css(b.byClass('pbar-right')[0]).width);
    assert.ok(left + center + right <= 1112, 'TV content stays inside the 1280px pane minus 136px rail and 32px gutters');
    assert.ok(right >= 328, 'visible cast, mode, mute, volume and queue fit without utility overlap');
    assert.equal(b.text().includes('播放栏密度'), true);
    b.tv.qtTvRegisterScope({ id: 'dock', root: b.root, modal: false, priority: 1, active: () => true, onBack: () => {} });
    b.tv.qtTvRefreshFocus(); b.tv.qtTvFocus('pbar-tv-seek');
    await b.dispatch(b.byClass('pbar-tv-seek')[0]);
    assert.ok(b.tv.qtTvFocusedId().endsWith(':custom:pbar-tv-confirm'), 'editing reveals and focuses the explicit commit action');
    b.tv.qtTvDispatchRemote({ key: 'back', action: 'down', repeat: 0 }); await b.flush();
    assert.ok(b.tv.qtTvFocusedId().endsWith(':custom:pbar-tv-seek'), 'Back restores focus to the original seek control');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(b.byClass('pbar-center')[0])['flex-direction'] ?? '', '', 'ordinary dock retains its previous stacked layout');
    assert.equal(b.css(b.byClass('pbar-main')[0]).width ?? '', '', 'ordinary 40px transport stylesheet remains in charge');
  } finally { await f.close(); }
}

async function dockNarrowCase() {
  const f = await queueFixture({ width: 960, height: 540 }), { b, player } = f;
  try {
    player.queue = [{ id: 'dock', platform: 'local', name: '客厅播放', singer: '歌手', album: '', picUrl: '', duration: 200 }];
    player.current = player.queue[0]; player.duration = 200;
    await b.mount(BAR, {}, false);
    assert.ok(b.byClass('pbar-tv-volume')[0], '960px TV keeps explicit volume control instead of dropping it to preserve equal wings');
    assert.ok(b.text().includes('进度'), 'narrow TV uses a short progress entry and puts complete time in the full-row editor');
    for (const tier of ['tiny', 'normal', 'huge']) {
      b.fonts.fontScale.setTier(tier); await b.flush();
      const left = Number.parseFloat(b.css(b.byClass('pbar-left')[0]).width), center = Number.parseFloat(b.css(b.byClass('pbar-center')[0]).width), right = Number.parseFloat(b.css(b.byClass('pbar-right')[0]).width);
      assert.ok(left + center + right <= 792, 'narrow TV three regions fit at font tier ' + tier);
      assert.ok(right >= 224 + Number.parseFloat(b.css(b.byClass('pbar-tv-volume')[0]).width));
      assert.ok(center >= 196 + Number.parseFloat(b.css(b.byClass('pbar-tv-seek')[0]).width));
    }
    await b.dispatch(b.byClass('pbar-tv-seek')[0]);
    assert.ok(b.text().includes('0:00 / 3:20'), 'progress editor retains the full actual timeline on narrow television');
  } finally { await f.close(); }
}

async function dockModalCase() {
  const f = await queueFixture(), { b, player } = f;
  let dispose = noop;
  try {
    player.queue = [{ id: 'modal', platform: 'local', name: '弹层优先', singer: '', album: '', picUrl: '', url: 'file:///sample.mp3', duration: 200 }];
    player.current = player.queue[0]; player.progress = 60; player.duration = 200;
    await b.mount(BAR, {}, true);
    const workspace = b.load(UI + 'composables/qt-wide-workspace.ts');
    dispose = b.tv.qtTvRegisterScope({ root: b.root, active: () => !(workspace.qtWideToolActive() && workspace.qtWideToolHostRoute() === '/pages/settings/index'), modal: false });
    await b.dispatch(b.byClass('pbar-tv-seek')[0]);
    b.tv.qtTvDispatchRemote({ key: 'right', action: 'down', repeat: 0 }); await b.flush();
    assert.ok(b.text().includes('1:10 / 3:20'));
    const before = b.nativeCalls.filter(call => call.name === 'audioSeek').length;
    const selected = b.action.qtShowActionSheet({ title: '优先弹层', itemList: ['只操作弹层'] }); await b.flush();
    assert.equal(b.tv.qtTvHasModal(), true, 'actual action-sheet panel wins over dock editor remote handler');
    b.tv.qtTvDispatchRemote({ key: 'right', action: 'down', repeat: 0 }); await b.flush();
    assert.ok(b.text().includes('1:10 / 3:20'), 'highest modal navigation does not mutate the background seek preview');
    b.tv.qtTvDispatchRemote({ key: 'back', action: 'down', repeat: 0 }); await b.flush();
    assert.equal(await selected, -1, 'Back settles the actual modal service, not the background dock');
    assert.equal(b.byClass('pbar-tv-editor').length, 1);
    assert.equal(b.nativeCalls.filter(call => call.name === 'audioSeek').length, before);
    b.tv.qtTvDispatchRemote({ key: 'back', action: 'down', repeat: 0 }); await b.flush();
    assert.equal(b.byClass('pbar-tv-editor').length, 0, 'next Back cancels only the resumed editor');
    assert.ok(b.tv.qtTvFocusedId().endsWith(':custom:pbar-tv-seek'));
    await b.dispatch(b.byClass('pbar-tv-volume')[0]);
    const ws = b.load(UI + 'composables/qt-wide-workspace.ts').qtWideWorkspace();
    ws.hostRoute = '/pages/settings/index'; ws.route = '/pages/search/index'; await b.flush();
    const volumeWrites = b.storageWrites.filter(([key]) => key === 'qt-playback-volume').length;
    b.tv.qtTvDispatchRemote({ key: 'ok', action: 'down', repeat: 0 }); await b.flush();
    assert.equal(b.storageWrites.filter(([key]) => key === 'qt-playback-volume').length, volumeWrites, 'inactive host ignores its retained dock editing handler');
    assert.equal(b.byClass('pbar-tv-editor').length, 1);
    ws.route = ''; ws.hostRoute = ''; await b.flush();
    b.tv.qtTvDispatchRemote({ key: 'back', action: 'down', repeat: 0 }); await b.flush();
    assert.equal(b.byClass('pbar-tv-editor').length, 0);
  } finally { dispose(); await f.close(); }
}

async function queueConfirmCase() {
  const f = await queueFixture({ withConfirm: true }), { b, player } = f;
  try {
    player.queue = [{ id: 'confirm', platform: 'local', name: '确认优先', singer: '', album: '', picUrl: '' }]; player.current = player.queue[0];
    await b.mount('fixture-queue-confirm', {}, false);
    assert.equal(b.tv.qtTvHasModal(), true);
    const service = b.load('services/confirm.ts');
    const answered = service.qtConfirm({ title: '确认层优先', content: '返回只关闭确认层' }); await b.flush();
    assert.equal(b.byClass('qc-card').length, 1);
    assert.equal(b.css(b.byClass('qc-mask')[0])['z-index'], '3000');
    b.tv.qtTvDispatchRemote({ key: 'back', action: 'down', repeat: 0 }); await b.flush();
    assert.equal(await answered, false, 'actual confirmation Promise settles before lower queue modal');
    assert.equal(b.byClass('qpq-mask').length, 1); assert.equal(player.queue.length, 1); assert.equal(b.tv.qtTvHasModal(), true);
    b.tv.qtTvDispatchRemote({ key: 'back', action: 'down', repeat: 0 }); await b.flush();
    assert.equal(b.byClass('qpq-mask').length, 0); assert.equal(b.tv.qtTvHasModal(), false);
  } finally { await f.close(); }
}

async function queueRemovalCase() {
  const f = await queueFixture(), { b, player } = f;
  try {
    const song = id => ({ id, platform: 'local', name: id, singer: '', album: '', picUrl: '', url: 'file:///sample.mp3', duration: 200 });
    player.queue = [song('first'), song('middle'), song('last')]; player.current = player.queue[1];
    await b.mount(QUEUE, {}, false);
    const starts = () => b.nativeCalls.filter(call => call.name === 'audioSetPlaylist').length;
    const initial = starts(), writes = b.storageWrites.length;
    await b.dispatch(b.byClass('qpq-move-up')[0]);
    await b.dispatch(b.byClass('qpq-move-down').at(-1));
    assert.equal(b.storageWrites.length, writes, 'disabled first/last move is a service no-op');
    assert.equal(starts(), initial);
    const playing = player.current, id = b.byClass('qpq-row')[1].props.id;
    await b.dispatch(b.byClass('qpq-move-down')[1]);
    assert.equal(player.current, playing, 'moving down keeps exact current song object');
    assert.equal(b.byClass('qpq-row')[2].props.id, id); assert.equal(starts(), initial);
    await b.dispatch(b.byClass('qpq-remove')[2]);
    assert.equal(player.current, player.queue[1], 'removing current selects the nearest actual surviving song');
    assert.equal(player.current.id, 'last'); assert.equal(starts(), initial + 1);
    await b.dispatch(b.byClass('qpq-remove')[0]);
    assert.equal(player.queue.length, 1); assert.equal(starts(), initial + 1, 'removing a noncurrent song does not replay');
    await b.dispatch(b.byClass('qpq-remove')[0]);
    assert.equal(player.queue.length, 0); assert.equal(player.current, null);
    assert.ok(b.text().includes('队列为空')); assert.equal(b.tv.qtTvHasModal(), true, 'empty queue remains dismissible');
    player.queue = [song('clear')]; player.current = player.queue[0]; await b.flush();
    await b.dispatch(b.byClass('qpq-action').find(node => node.props.id === 'qpq-clear'));
    assert.equal(player.current, null); assert.equal(player.queue.length, 0); assert.equal(b.tv.qtTvHasModal(), false);
    assert.equal(b.byClass('qpq-mask').length, 0, 'clear stops actual playback and closes its queue owner');
  } finally { await f.close(); }
}

async function queueModalCase() {
  const emptyPlayerData = { queue: [], currentIndex: () => -1 };
  const collectedRoots = [], nativeBacks = [];
  const noop = () => {};
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720,
    boundaryOverrides: {
      'stores/player': { usePlayerStore: () => emptyPlayerData },
      'services/tv-platform': {
        tvReadDevice: () => ({ television: false, nativeAvailable: false }),
        tvStartRemote: noop, tvSetRemoteState: noop, tvStopRemote: noop,
        tvCollect: root => { collectedRoots.push(root); return []; },
        tvHighlight: noop, tvActivate: noop, tvScroll: () => false,
        tvPresent: noop, tvBack: () => nativeBacks.push('back'),
      },
    },
  });
  let closed = 0;
  try {
    await b.mount(QUEUE, { onClose: () => { closed++; } }, false);
    assert.ok(b.byClass('qpq-panel')[0], 'the complete production queue panel is mounted');
    assert.equal(b.tv.qtTvHasModal(), true, 'the visible playback queue is a real TV modal');
    b.tv.qtTvRefreshFocus();
    assert.equal(toRaw(collectedRoots.at(-1)), b.byClass('qpq-panel')[0], 'native collection uses the actual panel, not its mask');
    assert.ok(String(b.byClass('qpq-mask')[0].props.class).split(/\s+/).includes('qt-tv-skip'), 'the backdrop is excluded from TV actions');
    assert.equal(b.tv.qtTvDispatchRemote({ key: 'back', action: 'down', repeat: 0 }), true);
    await b.flush();
    assert.equal(closed, 1, 'public remote Back emits one visible queue close');
    assert.equal(nativeBacks.length, 0, 'queue Back does not leave the current page');
    assert.equal(b.tv.qtTvHasModal(), false, 'a dismissed queue releases its modal before parent unmount');
    b.tv.qtTvDispatchRemote({ key: 'back', action: 'down', repeat: 1 });
    assert.equal(closed, 1, 'held Back does not close twice');
  } finally { await b.close(); }
}

const cases = { 'queue-modal': queueModalCase, 'queue-actions': queueActionsCase, 'queue-restore': queueRestoreCase, 'queue-density': queueDensityCase, 'dock-seek': dockSeekCase, 'dock-volume': dockVolumeCase, 'dock-revision': dockRevisionCase, 'dock-touch': dockTouchCase, 'dock-density': dockDensityCase, 'dock-narrow': dockNarrowCase, 'dock-modal': dockModalCase, 'queue-removal': queueRemovalCase, 'queue-confirm': queueConfirmCase };
export async function runTvQueueChecks(selected = 'all') {
  const entries = selected === 'all' ? Object.entries(cases) : [[selected, cases[selected]]];
  assert.ok(entries.every(([, run]) => typeof run === 'function'), 'known focused TV queue case');
  for (const [name, run] of entries) { await run(); console.log('PASS TV queue ' + name); }
  console.log('TV queue: ' + entries.length + ' compiled-template/public-service groups passed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runTvQueueChecks(process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'all');
}
