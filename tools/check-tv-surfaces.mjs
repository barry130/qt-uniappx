// Approved seam: actual UVue setup/template user actions and remote key input.
// Vue/uni host, clock, native measurements and account/network boundaries are owned.
// Business handlers are loaded from production pages; no copied sort/seek/upload logic.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as Vue from 'vue';
import { compile } from '@vue/compiler-dom';
import ts from 'typescript';
import { read, load, host, drain } from './check-source-auth-session.mjs';
import { sourcePolicyFixture } from './source-policy-fixture.mjs';
import { tvListHostFixture } from './check-tv-list-hosts.mjs';
import * as mediaCodecs from '../uni_modules/qt-ui/services/vendor/media-codecs.js';

const noop = () => {};
const blocked = () => { throw new Error('unexpected real network/native request'); };
const plain = value => JSON.parse(JSON.stringify(value));
function pageHost(path, scope) {
  const source = read(path);
  const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
  const ast = ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true);
  const names = [];
  for (const node of ast.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) names.push(node.name.text);
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
    }
  }
  const page = load(source, [...new Set(names)], scope);
  const template = source.slice(source.indexOf('<template>') + 10, source.lastIndexOf('</template>', source.indexOf('<script setup')));
  const render = new Function('Vue', compile(template, { mode: 'function', isCustomElement: tag => !/^(Qt|qt-)/.test(tag) }).code)({ ...Vue, resolveComponent: name => ({ name }) });
  const context = new Proxy({ ...scope, ...page }, {
    get: (target, key) => Vue.unref(target[key]),
    set: (target, key, value) => { if (Vue.isRef(target[key]) && !Vue.isRef(value)) target[key].value = value; else target[key] = value; return true; },
  });
  return { page, render: () => render(context, []) };
}
const descendants = node => node == null || typeof node !== 'object' ? [] : [node,
  ...(Array.isArray(node.children) ? node.children.flatMap(descendants) :
    node.type?.name !== 'qt-reorder-list' && node.props?.visible !== false && node.children && typeof node.children === 'object' ? Object.entries(node.children).filter(([key, value]) => key !== '_' && typeof value === 'function').flatMap(([, slot]) => slot().flatMap(descendants)) : [])];
const byClass = (root, name) => descendants(root).filter(node => String(node.props?.class ?? '').split(' ').includes(name));
const button = (root, label) => descendants(root).find(node => ['QtButton', 'qt-button'].includes(node.type?.name ?? node.type) && node.props?.label === label);
const event = () => ({ stopPropagation: noop, preventDefault: noop });
const styleText = node => typeof node.props?.style === 'string' ? node.props.style : Object.entries(node.props?.style ?? {}).map(([key, value]) => key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()) + ':' + value).join(';');

function collectionFixture(enabled = true) {
  const b = host();
  const tv = Vue.reactive({ enabled });
  const sheets = [], defaultChanges = [];
  const player = Vue.reactive({
    localPlaylists: [{ id: 'local-a', platform: 'local', name: '本地列表', picUrl: '' }],
    savedPlaylists: [{ id: 'online-a', platform: 'wyy', name: '在线列表', picUrl: '' }],
    defaultFavPlaylistId: '', playlistDisplayPic: playlist => playlist.picUrl,
    defaultFavPlaylist: () => null, setDefaultFavPlaylist: id => defaultChanges.push(id),
    playlistCoverOf: () => '', editablePlaylistPidOf: id => id,
    renameLocalPlaylist: blocked, createLocalPlaylist: blocked, setPlaylistCover: blocked,
  });
  const compiled = pageHost('pages/collection/index.uvue', {
    ...b.vue, uni: b.uni, ref: Vue.ref, computed: Vue.computed, useQtTv: () => tv,
    usePlayerStore: () => player, useThemeStore: () => ({ skin: {} }),
    useQtLayout: () => ({ isWide: true, paneWidth: 1280 }), qtContentWidth: () => 1000,
    qtColumnCount: () => 4, QT_MIN_COLUMN_WIDTH: { card: 200 }, qtFontDual: () => '',
    platformShort: id => id, platformColor: () => '#667788', DEFAULT_PLAYLIST_COVER_ASSET: '/cover.png',
    chooseImage: blocked, uploadPlaylistCover: blocked, clearPlaylistCover: blocked,
    beginLoading: blocked, finishLoading: blocked, qtSwitchTab: blocked,
    qtShowActionSheet: options => new Promise(resolve => sheets.push({ ...options, resolve })),
  });
  return { ...b, ...compiled, tv, player, sheets, defaultChanges };
}
function platformFixture(enabled = true) {
  const b = host();
  const tv = Vue.reactive({ enabled });
  const entries = [{ source: 'orphan', account: { cookie: 'owned', user: { id: 'account', nickname: '残留账号' } } }];
  const registry = Vue.reactive({ generation: 1, ready: true, catalog: ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase(), auth: { methods: ['qrcode'] } })),
    sourceQualities: () => [], ensure: async () => {}, label: id => id, sourceIds: () => ['a', 'b', 'c'] });
  const applies = [], engine = { hold: false, fail: false, releases: [] };
  const authSource = read('services/source-auth.ts');
  const qrCalls = [];
  const auth = load(authSource, [...authSource.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map(match => match[1]), {
    uni: b.uni, setMetaAuthHook: noop,
    invokeSource: async (name, args) => {
      qrCalls.push({ name, args: JSON.parse(args) });
      if (name === 'authQrCreate') return JSON.stringify({ key: 'owned-qr-key', image: 'data:image/png;base64,cG5n', expiresInSec: 180 });
      if (name === 'authQrPoll') return JSON.stringify({ status: 'waiting' });
      throw new Error('unexpected QR engine entry: ' + name);
    },
  });
  const compiled = pageHost('pages/source-auth/index.uvue', {
    ...b.vue, uni: b.uni, ref: Vue.ref, computed: Vue.computed, nextTick: Vue.nextTick, useQtTv: () => tv,
    usePlayerStore: () => ({ quality: '128' }), useDownloadsStore: () => ({ downloadQuality: '128' }),
    useSourceRegistryStore: () => registry, useThemeStore: () => ({ skin: {} }),
    useQtLayout: () => ({ isWide: true, paneHeight: 720, windowHeight: 720, windowWidth: 1280, safeBottomPx: 0 }),
    readSourceAuthEntries: () => entries, readSourceAuthTogglesFor: () => ({ useMeta: true, usePlay: false }),
    readAggregateSources: () => null, sourcePolicyStatus: () => ({ message: '' }),
    sourceDownloadQualityForNetwork: () => '128', sourcePlayQualityForNetwork: () => '128',
    NETWORK_KIND_WIFI: 'wifi', NETWORK_KIND_CELLULAR: 'cellular', supportsNativeAuthWebView: () => true,
    qtFontDual: () => '', qtTvTokens: () => ({ qrPx: 280, controlPx: 56 }),
    applyEngineSourcePolicy: async () => { applies.push('apply'); if (engine.hold) await new Promise(resolve => engine.releases.push(resolve)); if (engine.fail) throw new Error('owned engine ack failed'); },
    useQtSelectionReveal: () => ({ anchor: Vue.ref(''), itemId: index => 'item-' + index }),
    authQrCreate: auth.authQrCreate, authQrPoll: auth.authQrPoll, sourceAuthRevision: auth.sourceAuthRevision, saveImageToGallery: blocked,
    WEB_LOGIN_DONE_EVENT: 'web-done', AGGREGATE_SOURCES_CHANGED_EVENT: 'aggregate',
  });
  return { ...b, ...compiled, tv, entries, registry, applies, engine, qrCalls };
}
function platformCard(b, id) {
  const list = descendants(b.render()).find(node => node.type?.name === 'qt-reorder-list');
  const index = list.props.items.findIndex(item => item.id === id);
  assert.ok(index >= 0, 'registered platform card exists');
  const handle = { style: '', start: noop, move: noop, end: noop, cancel: noop, click: noop };
  return { children: list.children.default({ id, index, handle }) };
}
const publicModule = (path, scope = {}) => {
  const source = read(path);
  const names = [...source.matchAll(/^export\s+(?:(?:async\s+)?function|const|let)\s+(\w+)/gm)].map(match => match[1]);
  return load(source, names, scope);
};
function playerFixture({ enabled = true, wide = true, style = 'classic', queue = [], deferQueuePlay = false } = {}) {
  const b = host();
  const hide = [], mounted = [], watchStops = [], clipboard = [], seeks = [], plays = [], persistence = [];
  const native = { highlights: [], activations: [], render: () => null };
  let clock = 1000000, playRevision = 1;
  const playReleases = [];
  const owner = { active: true, route: 'pages/player/index' };
  const window = Vue.reactive({ isWide: wide, isShort: false, paneWidth: wide ? 1280 : 375, paneHeight: wide ? 720 : 800,
    windowWidth: wide ? 1280 : 375, windowHeight: wide ? 720 : 800, safeBottomPx: 0, paneTop: 0 });
  const song = { id: 'song-a', platform: 'owned', name: '测试曲', singer: '测试歌手', picUrl: '/fixture/cover.png', duration: 180 };
  const player = Vue.reactive({ current: song, queue: queue.length > 0 ? queue : [song], duration: 180, progress: 4, playing: false,
    quality: '128', localFirstTick: 0, embeddedLyric: '', sleepEndTime: 0, sleepStopAfterCurrent: false, sleepRequestedMinutes: 0,
    coverOf: value => value.picUrl ?? '', mode: 'loop', isDisliked: () => false,
    playbackRevision: () => playRevision, currentIndex: () => player.queue.indexOf(player.current), isLiked: () => false,
    effQualityOf: () => '128', resolvedUrlOf: () => 'https://fixture.invalid/audio', localFirstPathOf: () => '',
    lyricsForSong: async () => '', embeddedLyricOf: () => '', syncProgressNow: noop,
    seek: value => { seeks.push(value); player.progress = value; },
    play: value => {
      const revision = ++playRevision; plays.push(value);
      if (!deferQueuePlay) { player.current = value; return Promise.resolve(); }
      return new Promise(resolve => playReleases.push(() => { if (revision === playRevision) player.current = value; resolve(); }));
    },
    syncTimeline: () => persistence.push('timeline'), persist: () => persistence.push('persist'), stop: () => persistence.push('stop'),
    pickerPlaylists: () => [], pickerSelectedIds: () => [], isInPlaylist: () => false,
  });
  const playingStyle = Vue.reactive({ style, background: 'auto' });
  const lifecycle = { ...b.vue, onMounted: fn => mounted.push(fn), onHide: fn => hide.push(fn),
    watch: (...args) => { const stop = Vue.watch(...args); watchStops.push(stop); return stop; },
    getCurrentInstance: () => ({ proxy: {} }), inject: (_key, fallback) => fallback,
    reactive: Vue.reactive, ref: Vue.ref, computed: Vue.computed, nextTick: Vue.nextTick,
    requestAnimationFrame: fn => b.vue.setTimeout(fn), cancelAnimationFrame: b.vue.clearTimeout,
    Date: class extends Date { static now() { return clock; } },
  };
  const measure = { select: '', callbacks: [] };
  Object.assign(b.uni, {
    getWindowInfo: () => ({ ...window, statusBarHeight: 0 }), setNavigationBarColor: noop,
    setClipboardData: options => { clipboard.push(options.data); options.success?.(); },
    previewImage: options => native.activations.push({ type: 'preview', ...options }),
    createSelectorQuery: () => {
      const query = { in: () => query, select(value) { measure.select = value; return query; },
        selectAll(value) { measure.select = value; return query; }, boundingClientRect(fn) { measure.callbacks.push([measure.select, fn]); return query; },
        exec(fn) { const values = measure.callbacks.splice(0).map(([selector, reply]) => {
          const value = selector === '.lyric-line' ? Array.from({ length: 4 }, (_, index) => ({ left: 0, top: 240 + index * 76, width: 500, height: 76 }))
            : { left: 0, top: 0, width: 500, height: selector === '.lyric-viewport' ? 480 : 500, bottom: 500, right: 500 };
          reply?.(value); return value;
        }); fn?.(values); },
      }; return query;
    },
  });
  const navigation = publicModule('uni_modules/qt-ui/composables/qt-tv-navigation.ts');
  const tokens = publicModule('uni_modules/qt-ui/composables/qt-tv-tokens.ts');
  const candidateNodes = () => descendants(native.render()).filter(node => node.props?.['data-qt-tv-id'] && typeof node.props.onClick === 'function');
  const tvApi = publicModule('uni_modules/qt-ui/composables/use-qt-tv.ts', {
    ...lifecycle, ...navigation, ...tokens, uni: b.uni,
    qtTopRoute: () => owner.route, qtWideToolActive: () => false, qtWideToolHostRoute: () => '', qtWideToolRoute: () => '',
    applyQtTvLayout: noop, setQtTvFontPresentation: noop, tvReadDevice: () => ({ television: enabled, nativeAvailable: false }),
    tvStartRemote: noop, tvSetRemoteState: noop, tvStopRemote: noop, tvPresent: noop,
    tvCollect: () => candidateNodes().map((node, index) => ({ id: 'tv:app:page:custom:' + node.props['data-qt-tv-id'],
      left: 0, top: index * 76, width: 500, height: 56, visible: true, enabled: node.props.disabled !== true, input: false, longPress: typeof node.props.onLongpress === 'function' })),
    tvHighlight: id => native.highlights.push(id), tvScroll: () => false, tvBack: () => b.routes.push({ back: true }),
    tvActivate: (id, longPress) => { const node = candidateNodes().find(node => id.endsWith(':custom:' + node.props['data-qt-tv-id'])); node?.props[longPress ? 'onLongpress' : 'onClick']?.(event()); },
  });
  const track = publicModule('uni_modules/qt-ui/composables/playing-track-metrics.ts');
  const presentation = publicModule('uni_modules/qt-ui/composables/player-presentation.ts', track);
  const turntable = publicModule('uni_modules/qt-ui/composables/turntable-presentation.ts');
  const lyricPresentation = publicModule('uni_modules/qt-ui/composables/lyric-presentation.ts');
  const backgrounds = publicModule('uni_modules/qt-ui/composables/playing-style.ts');
  const lrc = publicModule('utils/lrc.uts');
  const settings = publicModule('services/player-setting-options.ts');
  const modal = publicModule('uni_modules/qt-ui/composables/use-qt-tv-modal.ts', { ...lifecycle, ...tvApi,
    qtTopRoute: () => owner.route, qtWideToolActive: () => false, qtWideToolHostRoute: () => '', qtWideToolRoute: () => '' });
  const scope = { ...lifecycle, ...tvApi, ...tokens, ...modal, ...track, ...presentation, ...turntable, ...lyricPresentation, ...backgrounds, ...lrc, ...settings, uni: b.uni,
    qtTopRoute: () => owner.route,
    useQtLayout: () => window, qtRpx: value => value * window.windowWidth / 750, qtSheetWidth: () => 680,
    qtFixedPaneStyle: () => '', qtFontDual: () => '', qtFontPx: () => '', qtFont: () => '',
    useFontScaleStore: () => ({ scale: 1 }), usePlayingStyle: () => playingStyle, useCoverPalette: () => Vue.ref(null),
    usePlayerStore: () => player, useDownloadsStore: () => ({ has: () => false }), useDislikesStore: () => ({ isDisliked: () => false }),
    usePlayerBarStore: () => ({ isVisible: () => false, restore: noop }), PLAYER_BAR_TOOLS: [], PLAYER_BAR_MAX_VISIBLE: 4,
    playerBarFixed: () => false, playerBarCountedShared: () => false, useShareCardStore: () => ({ open: blocked }),
    useSourceRegistryStore: () => ({ generation: 1, qualityGeneration: 1, qualities: [], sourceQualities: () => [], ensure: async () => {} }),
    useThemeStore: () => ({ dark: false, skin: { text: '#18242c', textMuted: '#526572', background: '#ffffff', surfaceMuted: '#e6eef4', danger: '#d93c43', accent: '#57bdd0' } }),
    useLyricOffsetStore: () => ({ offsetMsFor: () => 500, offsetSecFor: () => 0.5, setActive: noop, activeOffsetMs: 500 }),
    useLyricSizeStore: () => ({ scale: 1, isCustom: () => false, percent: () => 100 }), LYRIC_SIZE_STEP: 0.1, LYRIC_SIZE_MIN: 0.8, LYRIC_SIZE_MAX: 1.8,
    LYRIC_OFFSET_MAX_MS: 10000, LYRIC_OFFSET_STEP_MS: 50,
    qtPerformance: Vue.reactive({ reduceMotion: true, expensiveEffects: false }), qtDiag: message => native.activations.push({ diagnostic: message }),
    qtTrackPage: noop, beginLoading: blocked, finishLoading: blocked,
    dlnaUiState: () => ({ state: Vue.ref(null) }), dlnaSupported: () => false, openDlna: blocked,
    desktopLyric: { isEnabled: () => false }, audioPlayer: { rate: 1, setCarLyricOffset: noop },
    musicApi: { hasPickedLyric: () => false, cachedLyric: () => '[00:00.00]第一句\n[00:10.00]第二句\n[00:20.00]第三句\n[00:30.00]末句', cachedLyricTranslation: () => '[00:10.00]译文', cachedLyricWordByWord: () => '', cachedLyricRomanization: () => '',
      playbackInfoOf: () => ({ source: song, quality: '128', size: 0 }), playConfigEpoch: () => 1 },
    isQtAdmin: () => false, MusicApi: class {}, isHarmonyOs: () => false,
    platformLabel: id => id, platformShort: id => id, platformColor: () => '#667788', localFileSizeOf: blocked,
    SOURCE_QUALITIES_CHANGED_EVENT: 'quality-changed', qtConfirm: blocked,
  };
  const compiled = pageHost('pages/player/index.uvue', scope);
  native.render = compiled.render;
  tvApi.qtInitTv();
  const removeScope = tvApi.qtTvRegisterScope({ root: {}, active: () => owner.active, modal: false });
  return { ...b, ...compiled, player, playingStyle, window, tvApi, native, owner, clipboard, seeks, plays, persistence, playReleases,
    mount: async () => { mounted.forEach(fn => fn()); await drain(); await Vue.nextTick(); await drain(); },
    key: async (key, repeat = 0) => { clock += 100; const consumed = tvApi.qtTvDispatchRemote({ key, repeat, action: 'down' }); await Vue.nextTick(); await drain(); return consumed; },
    dispose: () => { b.hooks.unload.forEach(fn => fn()); b.hooks.unmounted.forEach(fn => fn()); watchStops.forEach(stop => stop()); removeScope(); tvApi.qtDisposeTv(); },
    hide: () => hide.forEach(fn => fn()),
  };
}
let cases = 0;
// task38 agreed seam: complete production Player + Frame + QtUI, real PlayerStore,
// music-api/audio/DLNA/offset services, and public remote/native event dispatch.
// Reuse only the frozen complete-SFC loader, not its listFixture business API mock.
const PLAYER_PAGE = 'pages/player/index.uvue';
const nativeTree = node => { node = Vue.toRaw(node); return [node, ...node.children.flatMap(nativeTree)]; };
const nativeClass = (node, name) => String(node.props.class ?? '').split(/\s+/).includes(name);
const nativeText = node => node.text + node.children.map(nativeText).join('');
function playerNativeElements(root) {
  const seen = new WeakSet();
  function decorate(node) {
    node = Vue.toRaw(node); if (seen.has(node)) return; seen.add(node);
    Object.defineProperty(node, 'classList', { configurable:true, get:() => String(node.props.class ?? '').split(/\s+/).filter(Boolean) });
    Object.defineProperty(node, 'parentElement', { configurable:true, get:() => node.parent });
    node.animate = () => ({ cancel:noop });
    const children = node.children, push = children.push, splice = children.splice;
    Object.defineProperty(children, 'push', { configurable:true, value(...items) { items.forEach(decorate); return push.apply(this, items); } });
    Object.defineProperty(children, 'splice', { configurable:true, value(...args) { args.slice(2).forEach(decorate); return splice.apply(this, args); } });
    children.forEach(decorate);
  }
  decorate(root);
}
function playerNativeRemote() {
  let b, serial = 0, registry = new Map();
  const ids = new WeakMap(), pending = [], collections = [], activations = [];
  const id = node => 'tv:fixture:player:' + (node.props['data-qt-tv-id'] ? 'custom:' + node.props['data-qt-tv-id']
    : 'node:' + (ids.get(node) ?? (ids.set(node, ++serial), serial)));
  function hidden(node) {
    for (let current = node; current; current = current.parent) {
      const style = b.css(current);
      if (style.display === 'none' || style.visibility === 'hidden' || String(style.opacity) === '0') return true;
    }
    return false;
  }
  const platform = {
    tvReadDevice:() => ({ television:true, nativeAvailable:true, leanback:true, uiModeType:4 }),
    tvStartRemote:noop, tvSetRemoteState:noop, tvStopRemote:noop, tvHighlight:noop, tvPresent:noop,
    tvBack() { for (const handler of [...b.lifecycle.backPress].reverse()) if (handler({ from:'backbutton' })) return; b.routes.push({ action:'native-back' }); },
    tvCollect(root) {
      registry = new Map(); const result = [];
      for (const node of root == null ? [] : nativeTree(root)) {
        if (nativeClass(node, 'qt-tv-skip') || hidden(node) || !(node.props.onClick || node.props.onTap || node.props.onLongpress
          || ['input','textarea'].includes(node.tag) || (nativeClass(node, 'qt-tv-scroll') && ['scroll-view','list-view'].includes(node.tag)))) continue;
        const key = id(node); if (registry.has(key)) continue; // Android collector keeps the first full ID.
        registry.set(key, node);
        const index = result.length;
        result.push({ id:key, left:30, top:40 + index * 76, width:300, height:56, visible:true,
          enabled:node.props.disabled !== true && node.props.disabled !== 'true', input:['input','textarea'].includes(node.tag),
          longPress:!!node.props.onLongpress, scrollGroup:'' });
      }
      collections.push(result); return result;
    },
    tvActivate(key, longPress) {
      const target = registry.get(key); assert.ok(target, 'public native activation uses the current collected rendered node');
      activations.push({ key, longPress });
      pending.push(b.dispatch(target, longPress ? 'longpress' : target.props.onTap ? 'tap' : 'click'));
    },
    tvScroll:() => false,
  };
  return { platform, collections, activations, bind:value => { b = value; },
    async key(key, repeat = 0, elapsed = 100) { b.clock.advance(elapsed); const handled = b.tv.qtTvDispatchRemote({ key, action:'down', repeat });
      for (const job of pending.splice(0)) await job; await b.flush(); return handled; } };
}
async function fullPlayerFixture({ width = 1280, height = 720, savedMode = 'tv', initialProgress = 60, initialDuration = 180 } = {}) {
  const boundary = playerNativeRemote(), sdkCalls = [], requests = [];
  const song = { id:'seek-song', platform:'owned', name:'无歌词进度测试', singer:'原歌手', album:'原专辑', picUrl:'', duration:initialDuration };
  // Files/engine/native metadata response data only. No business module is replaced.
  const sdk = new Proxy({ publicDataDir:() => '', dataDir:() => '/fixture-player', statLocalFile:() => -1,
    queryPermissionStates:() => [], readEmbeddedTags:() => null,
    readTextFile:(path, reply) => { sdkCalls.push({ name:'readTextFile', path }); reply(false, '', 'fixture file absent'); },
    exists:(_path, reply) => reply(true, '0', ''), listFiles:(_path, reply) => reply(true, '[]', ''),
    start:(_options, reply) => reply(null, 'fixture has no installed data pack'), isRunning:() => false, isHealthy:() => false,
  }, { get(target, name) { return target[name] ?? ((...args) => { sdkCalls.push({ name:String(name), args }); }); } });
  const b = await tvListHostFixture({ width, height, savedMode, realFrame:true,
    initialStorage:{ 'qt-player-state':JSON.stringify({ queue:[JSON.stringify(song)], current:JSON.stringify(song), currentIndex:0,
      progress:initialProgress, duration:initialDuration, mode:'sequence', quality:'320', playCounts:{} }),
      'qt-lyric-offset':JSON.stringify({ global:500, songs:{} }) },
    boundaryOverrides:{ 'services/tv-platform':boundary.platform, 'uni_modules/qt-app-native':sdk, 'uni_modules/qt-js-engine':sdk,
      // Frozen loader resolves .ts/.uts/.uvue only. Node loads this actual full .js vendor;
      // this is module resolution, not a mocked image/business implementation.
      'uni_modules/qt-ui/services/vendor/media-codecs':mediaCodecs,
      // Complete the loader's permitted diagnostic/logging boundary for real engine failures.
      'services/logger':{ logWarn:noop, logWarnV:noop, logErr:noop, logErrV:noop, logInfo:noop, logMsg:noop,
        logMsgErr:noop, logMsgWarn:noop, logSupported:() => false, logBytes:async () => 0 } },
    sdkOverrides:{ setNavigationBarColor:noop, getDeviceInfo:() => ({ deviceBrand:'Fixture', deviceModel:'TV', osName:'Android', osVersion:'13' }),
      getAppBaseInfo:() => ({ appVersionCode:300, appVersion:'3.0.0' }),
      request(value) { requests.push(value); value.success?.({ statusCode:200, data:JSON.stringify({ code:200, data:[] }) }); value.complete?.({}); } },
  });
  boundary.bind(b); playerNativeElements(b.root);
  // Full Player measures native selectAll lyric rows as well as individual tracks.
  b.uni.createSelectorQuery = () => {
    let selector = '', all = false; const requests = [];
    const query = { in:() => query,
      select(value) { selector = value; all = false; return query; },
      selectAll(value) { selector = value; all = true; return query; },
      boundingClientRect(reply) { requests.push({ selector, all, reply }); return query; },
      exec(reply) { b.measurements.push(() => {
        const values = requests.map(request => {
          const nodes = b.root.querySelectorAll(request.selector);
          const rectangles = Array.from(nodes).map(node => node.getBoundingClientRect());
          const value = request.all ? rectangles : rectangles[0] ?? null;
          request.reply?.(value); return value;
        }); reply?.(values);
      }); },
    }; return query;
  };
  const player = b.load('stores/player.ts').usePlayerStore(); player.restore();
  b.load('stores/lyric-offset.ts').useLyricOffsetStore().restore();
  await b.mount(PLAYER_PAGE); await b.clock.runTimers(0);
  for (let batch = 0; b.measurements.length; batch++) {
    assert.ok(batch < 20, 'bounded native selector callbacks');
    for (const reply of b.measurements.splice(0)) reply(); await b.flush();
  }
  // The SDK reports time zero on onShow. Public real seek establishes the known test
  // position; all feature assertions count native operations after this setup call.
  player.seek(initialProgress); await b.flush();
  const seeks = () => b.nativeCalls.filter(call => call.name === 'audioSeek');
  assert.equal(player.current?.id, song.id, 'actual public restore reaches the real PlayerStore');
  assert.equal(player.progress, initialProgress); assert.equal(player.duration, initialDuration);
  assert.equal(b.byClass('qt-page-frame').length, 1, 'complete production Frame is mounted');
  assert.equal(b.byClass('pbar-tv-seek').length, 0, 'full-width Player hides the dock seek editor');
  return { ...b, player, boundary, sdkCalls, requests, seeks,
    key:(key, repeat = 0, elapsed = 100) => boundary.key(key, repeat, elapsed),
    focus:id => b.tv.qtTvFocus(id) };
}
async function fullPlayerSeekCapabilityModalCase() {
  const b = await fullPlayerFixture();
  const picks = []; let picked = null;
  try {
    const before = b.seeks().length;
    assert.equal(b.focus('player-progress-seek'), true); await b.key('ok'); await b.key('right');
    const staleCast = b.byClass('qt-button').find(node => node.props['data-qt-tv-id'] === 'player-progress-confirm');
    b.load('services/dlna.uts').initDlna();
    const state = b.nativeCalls.filter(call => call.name === 'audioDlnaOnState').at(-1)?.args[0];
    assert.equal(typeof state, 'function', 'real DLNA service registered its native state callback');
    b.audioBoundary.dlna = true;
    state({ target:'dlna', sessionId:1, generation:1, deviceId:'receiver', deviceName:'投屏设备', phase:'playing',
      mediaId:'owned:seek-song', positionMs:60000, durationMs:180000, volume:50, canSeek:false, canSetVolume:false, error:'' });
    await b.flush();
    assert.equal(b.byClass('player-tv-seek-editor').length, 0, 'native unsupported casting state invalidates the draft');
    assert.equal(b.focus('player-progress-seek'), false, 'unsupported casting disables the actual QtButton remote entry');
    await b.dispatch(staleCast); assert.equal(b.seeks().length, before);
    b.audioBoundary.dlna = false;
    state({ target:'local', sessionId:2, generation:2, deviceId:'', deviceName:'', phase:'paused', mediaId:'owned:seek-song',
      positionMs:60000, durationMs:180000, volume:50, canSeek:true, canSetVolume:true, error:'' }); await b.flush();
    assert.equal(b.focus('player-progress-seek'), true); await b.key('ok'); await b.key('right');
    const staleModal = b.byClass('qt-button').find(node => node.props['data-qt-tv-id'] === 'player-progress-confirm');
    const confirm = b.load('services/confirm.ts').qtConfirm({ title:'确认操作', content:'真实全局弹窗', showCancel:true });
    await b.flush(); assert.equal(b.tv.qtTvHasModal(), true);
    assert.equal(b.byClass('player-tv-seek-editor').length, 0, 'highest actual confirmation modal invalidates the remote draft');
    assert.equal(b.focus('player-progress-seek'), false, 'modal keeps focus out of the Player progress entry');
    await b.dispatch(staleModal); await b.key('right'); await b.key('ok', 1);
    assert.equal(b.seeks().length, before, 'direction/held OK/late rendered confirmation never seek beneath a modal');
    await b.key('back'); assert.equal(await confirm, false); assert.equal(b.tv.qtTvHasModal(), false);
    assert.equal(b.focus('player-progress-seek'), true); await b.key('ok'); await b.key('right');
    const staleBusy = b.byClass('qt-button').find(node => node.props['data-qt-tv-id'] === 'player-progress-confirm');
    await b.dispatch(b.byClass('nav-btn').find(node => nativeText(node).includes('风格')));
    assert.equal(b.tv.qtTvHasModal(), true); assert.equal(b.byClass('player-tv-seek-editor').length, 0);
    b.uni.chooseImage = options => { picked = options; picks.push(options); };
    assert.equal(b.focus('playing-background:image'), true); await b.key('ok');
    assert.equal(picks.length, 1, 'real media chooseImage is pending once inside the actual style sheet');
    await b.key('ok', 1); await b.key('ok', 2); await b.key('right');
    await b.dispatch(staleBusy);
    assert.equal(picks.length, 1); assert.equal(b.seeks().length, before, 'busy sheet still owns remote keys and leaves the cancelled progress draft inert');
    assert.equal(b.focus('player-progress-seek'), false); assert.equal(b.tv.qtTvHasModal(), true);
    picked.fail({ errMsg:'fixture picker cancelled' }); picked = null; await b.flush();
    await b.key('back'); assert.equal(b.tv.qtTvHasModal(), false);
    assert.equal(b.byClass('player-tv-seek-editor').length, 0, 'closing the busy sheet does not restore an old draft');
    assert.deepEqual(b.runtimeErrors, []);
  } finally { if (picked) picked.fail({ errMsg:'fixture cleanup' }); await b.close(); }
}
async function fullPlayerSeekBoundsCase() {
  const b = await fullPlayerFixture();
  try {
    const before = b.seeks().length;
    assert.equal(b.focus('player-progress-seek'), true); await b.key('ok');
    await b.key('right', 0, 0);
    assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('1:10'));
    await b.key('right', 1, 84);
    assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('1:10'), 'held direction within 85ms is throttled');
    await b.key('right', 2, 1);
    assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('1:20'), '85ms boundary accepts the next held direction');
    await b.key('right', 3, 85); await b.key('right', 4, 85); await b.key('right', 5, 85);
    assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('1:50'), 'continuous held direction accumulates every accepted repeat');
    assert.equal(b.seeks().length, before); assert.equal(b.player.progress, 60);
    for (let repeat = 6; repeat < 20; repeat++) await b.key('right', repeat, 85);
    assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('3:00 / 3:00'), 'upper preview clamps at exact duration');
    assert.equal(b.seeks().length, before); await b.key('ok');
    assert.deepEqual(Array.from(b.seeks().at(-1).args), [180]);
    assert.equal(b.seeks().length, before + 1); assert.equal(b.player.progress, 180);
    await b.key('ok');
    for (let repeat = 0; repeat < 22; repeat++) await b.key('left', repeat, 85);
    assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('0:00 / 3:00'), 'lower preview clamps at zero');
    assert.equal(b.player.progress, 180); assert.equal(b.seeks().length, before + 1);
    await b.key('ok'); assert.equal(b.player.progress, 0);
    assert.deepEqual(Array.from(b.seeks().at(-1).args), [0]); assert.equal(b.seeks().length, before + 2);
    b.player.seek(60); await b.flush();
    assert.equal(b.focus('player-progress-seek'), true); await b.key('ok');
    for (let repeat = 0; repeat < 9; repeat++) await b.key('right', repeat);
    assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('2:30 / 3:00'));
    // Feed the actual registered native time callback; real audio/PlayerStore own duration changes.
    const time = b.nativeCalls.filter(call => call.name === 'audioOnTimeUpdate').at(-1)?.args[0];
    assert.equal(typeof time, 'function'); b.clock.advance(1000); time(60, 100); await b.flush();
    assert.equal(b.player.duration, 100); assert.equal(b.player.progress, 60);
    assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('1:40 / 1:40'), 'duration shrink re-clamps the live draft without a seek');
    const shortened = b.seeks().length; await b.key('ok');
    assert.equal(b.seeks().length, shortened + 1); assert.deepEqual(Array.from(b.seeks().at(-1).args), [100]);
    assert.deepEqual(b.runtimeErrors, []);
  } finally { await b.close(); }
}
async function fullPlayerSeekContextCase() {
  const b = await fullPlayerFixture();
  try {
    assert.equal(b.focus('player-progress-seek'), true); await b.key('ok'); await b.key('right');
    const staleSameTrack = b.byClass('qt-button').find(node => node.props['data-qt-tv-id'] === 'player-progress-confirm');
    assert.ok(staleSameTrack);
    const sameSong = b.player.current, revision = b.player.playbackRevision();
    await b.player.play(sameSong); await b.flush();
    assert.ok(b.player.playbackRevision() > revision, 'public real same-ID replay advances playback revision');
    assert.equal(b.player.current.id, 'seek-song');
    assert.equal(b.byClass('player-tv-seek-editor').length, 0, 'same-ID new playback discards the old preview');
    let before = b.seeks().length;
    await b.dispatch(staleSameTrack);
    assert.equal(b.seeks().length, before, 'late rendered confirm from the old generation does not seek same-ID replay');
    b.player.seek(60); await b.flush();
    assert.equal(b.focus('player-progress-seek'), true); await b.key('ok'); await b.key('right');
    const staleOtherTrack = b.byClass('qt-button').find(node => node.props['data-qt-tv-id'] === 'player-progress-confirm');
    await b.player.play({ ...plain(sameSong), id:'seek-new-song', name:'换曲后的歌曲' }); await b.flush();
    assert.equal(b.player.current.id, 'seek-new-song');
    assert.equal(b.byClass('player-tv-seek-editor').length, 0, 'track identity change discards preview instead of applying to the new song');
    before = b.seeks().length; await b.dispatch(staleOtherTrack);
    assert.equal(b.seeks().length, before, 'late old-track public native activation is ignored');
    b.player.seek(40); await b.flush();
    assert.equal(b.focus('player-progress-seek'), true); await b.key('ok'); await b.key('right');
    const staleHidden = b.byClass('qt-button').find(node => node.props['data-qt-tv-id'] === 'player-progress-confirm');
    for (const hide of b.lifecycle.hide) hide(); await b.flush();
    assert.equal(b.byClass('player-tv-seek-editor').length, 0, 'public page-hide cancels the preview');
    before = b.seeks().length; await b.dispatch(staleHidden);
    assert.equal(b.seeks().length, before);
    for (const show of b.lifecycle.show) show(); await b.flush();
    assert.equal(b.byClass('player-tv-seek-editor').length, 0, 'returning to foreground never resurrects a draft');
    b.player.seek(40); await b.flush();
    assert.equal(b.focus('player-progress-seek'), true); await b.key('ok'); await b.key('left');
    const staleBackground = b.byClass('qt-button').find(node => node.props['data-qt-tv-id'] === 'player-progress-confirm');
    b.tv.qtSetTvForeground(false); await b.flush();
    assert.equal(b.byClass('player-tv-seek-editor').length, 0, 'app-background invalidates pending remote preview');
    before = b.seeks().length; await b.dispatch(staleBackground); await b.key('ok');
    assert.equal(b.seeks().length, before);
    b.tv.qtSetTvForeground(true); await b.flush();
    assert.equal(b.byClass('player-tv-seek-editor').length, 0);
    assert.deepEqual(b.runtimeErrors, [], 'full SFC/real-service context flow has no swallowed runtime errors');
  } finally { await b.close(); }
}
async function fullPlayerSeekCase() {
  const b = await fullPlayerFixture();
  try {
    const before = b.seeks().length, history = plain(b.player.history), counts = plain([...b.player.playCounts]);
    assert.ok(b.text().includes('暂无歌词') || b.text().includes('纯音乐') || b.byClass('lyric-empty').length > 0,
      'the complete production page reached its no-lyrics state before the feature assertion');
    assert.equal(b.focus('player-progress-seek'), true,
      'full-width Player exposes an independent public remote seek entry even when no lyrics exist');
    await b.key('ok');
    assert.equal(b.byClass('player-tv-seek-editor').length, 1);
    assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('1:00'));
    await b.key('ok', 1);
    assert.equal(b.byClass('player-tv-seek-editor').length, 1, 'held entry OK does not immediately commit');
    await b.key('right'); await b.key('right', 1); await b.key('left', 2);
    assert.equal(b.player.progress, 60); assert.equal(b.seeks().length, before, 'direction repeats only preview');
    assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('1:10'));
    await b.key('ok');
    assert.equal(b.player.progress, 70); assert.equal(b.seeks().length, before + 1);
    assert.deepEqual(Array.from(b.seeks().at(-1).args), [70], 'ordinary progress commit excludes the saved lyric half-second offset');
    await b.key('ok', 1); await b.key('ok', 2);
    assert.equal(b.seeks().length, before + 1, 'held commit OK reaches native seek exactly once');
    assert.equal(b.byClass('player-tv-seek-editor').length, 0);
    assert.ok(b.tv.qtTvFocusedId().endsWith(':custom:player-progress-seek'), 'commit restores original seek entry focus');
    await b.key('ok'); await b.key('left'); await b.key('back');
    assert.equal(b.player.progress, 70); assert.equal(b.seeks().length, before + 1);
    assert.equal(b.byClass('player-tv-seek-editor').length, 0, 'Back cancels the candidate without seeking');
    assert.ok(b.tv.qtTvFocusedId().endsWith(':custom:player-progress-seek'));
    assert.deepEqual(plain(b.player.history), history); assert.deepEqual(plain([...b.player.playCounts]), counts,
      'ordinary preview/commit/cancel do not create a playback/history action');
  } finally { await b.close(); }
}

export async function runTvPlayerTouchTakeoverChecks() {
  for (const viewport of [{ width:1280, height:720 }, { width:390, height:844 }]) {
    const b = await fullPlayerFixture(viewport);
    try {
      const before = b.seeks().length, history = plain(b.player.history), counts = plain([...b.player.playCounts]);
      const entry = b.byClass('qt-button').find(node => node.props['data-qt-tv-id'] === 'player-progress-seek');
      assert.equal(b.focus('player-progress-seek'), true); await b.key('ok'); await b.key('right');
      const staleConfirm = b.byClass('qt-button').find(node => node.props['data-qt-tv-id'] === 'player-progress-confirm');
      assert.ok(staleConfirm); assert.equal(b.player.progress, 60); assert.equal(b.seeks().length, before);
      const track = b.byClass('prog-range')[0]; assert.ok(track);
      // Native rectangle is left=20/width=300: x95 is 45s, x170 is 90s of the known 180s track.
      await b.dispatch(track, 'touchstart', { touches:[{ clientX:95, clientY:60 }] });
      const editorAfterStart = b.byClass('player-tv-seek-editor').length;
      assert.equal(nativeText(b.byClass('prog-time')[0]), '0:45', 'the first valid touch previews immediately rather than being swallowed');
      assert.equal(b.player.progress, 60); assert.equal(b.seeks().length, before);
      await b.dispatch(entry); await b.key('ok', 1);
      assert.equal(b.seeks().length, before, 'a stale remote entry and held OK never commit an active touch gesture');
      await b.dispatch(track, 'touchmove', { touches:[{ clientX:170, clientY:60 }] });
      assert.equal(nativeText(b.byClass('prog-time')[0]), '1:30');
      assert.equal(b.player.progress, 60); assert.equal(b.seeks().length, before, 'touch move preserves the existing preview-only flow');
      await b.dispatch(track, 'touchend', { touches:[], changedTouches:[{ clientX:170, clientY:60 }] });
      assert.equal(b.player.progress, 90); assert.equal(b.seeks().length, before + 1);
      assert.deepEqual(Array.from(b.seeks().at(-1).args), [90], 'first touch release seeks once without lyric offset');
      await b.dispatch(staleConfirm); await b.key('ok', 1); await b.key('ok', 2);
      assert.equal(b.seeks().length, before + 1, 'late remote confirmation after touch takeover must not seek a second time');
      assert.equal(editorAfterStart, 0, 'touchstart discards the remote draft before taking over its preview');
      assert.equal(b.byClass('player-tv-seek-editor').length, 0, 'touch completion leaves no stranded remote editor');
      assert.equal(b.focus('player-progress-seek'), true); await b.key('ok');
      assert.equal(b.byClass('player-tv-seek-editor').length, 1, 'touch completion releases dragging for the next deliberate remote edit');
      await b.key('back'); assert.equal(b.seeks().length, before + 1);
      await b.dispatch(track, 'touchstart', { touches:[{ clientX:95, clientY:60 }] });
      await b.dispatch(track, 'touchmove', { touches:[{ clientX:170, clientY:60 }] });
      await b.dispatch(track, 'touchcancel', { touches:[] });
      assert.equal(b.player.progress, 90); assert.equal(b.seeks().length, before + 1, 'original touchcancel never commits the cancelled gesture');
      assert.equal(b.focus('player-progress-seek'), true); await b.key('ok'); await b.key('back');
      assert.deepEqual(plain(b.player.history), history); assert.deepEqual(plain([...b.player.playCounts]), counts);
      assert.deepEqual(b.runtimeErrors, []);
    } finally { await b.close(); }
  }
  console.log('TV Player touch takeover: 1 focused full-production group / wide+compact passed');
}
export async function runTvPlayerTouchModeSwitchChecks() {
  for (const viewport of [{ width:1280, height:720 }, { width:390, height:844 }]) {
    const b = await fullPlayerFixture(viewport);
    try {
      const frame = b.byClass('qt-page-frame')[0], before = b.seeks().length;
      assert.equal(b.focus('player-progress-seek'), true); await b.key('ok'); await b.key('right');
      assert.equal(b.byClass('player-tv-seek-editor').length, 1);
      assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('1:10'));
      const staleConfirm = b.byClass('qt-button').find(node => node.props['data-qt-tv-id'] === 'player-progress-confirm');
      b.tv.qtSetTvMode('touch'); await b.flush();
      assert.equal(b.tv.useQtTv().enabled, false, 'public touch presentation disables the real TV controller');
      assert.equal(b.storage.get('qt-tv-presentation'), 'touch');
      assert.equal(b.byClass('qt-page-frame')[0], frame, 'mode switching preserves the same mounted full production Frame');
      assert.equal(b.byClass('player-tv-tools').length, 0); assert.equal(b.byClass('player-tv-seek-editor').length, 0);
      assert.equal(nativeText(b.byClass('prog-time')[0]), '1:00', 'mode switch cancels the draft and restores actual progress presentation');
      assert.equal(b.player.progress, 60); assert.equal(b.seeks().length, before);
      await b.dispatch(staleConfirm);
      assert.equal(await b.key('ok'), false); assert.equal(await b.key('right', 1), false);
      assert.equal(b.seeks().length, before, 'stale rendered confirmation and remote input in touch mode never commit the old preview');
      // Presentation/font changes invalidate measured geometry: deliver the queued native rectangles before a new gesture.
      for (let batch = 0; b.measurements.length; batch++) {
        assert.ok(batch < 20, 'bounded native geometry delivery after presentation change');
        for (const reply of b.measurements.splice(0)) reply(); await b.flush();
      }
      const track = b.byClass('prog-range')[0];
      await b.dispatch(track, 'touchstart', { touches:[{ clientX:95, clientY:60 }] });
      assert.equal(nativeText(b.byClass('prog-time')[0]), '0:45', 'first touch after presentation switch immediately owns the native progress gesture');
      await b.dispatch(track, 'touchmove', { touches:[{ clientX:170, clientY:60 }] });
      assert.equal(b.player.progress, 60); assert.equal(b.seeks().length, before);
      await b.dispatch(track, 'touchend', { touches:[], changedTouches:[{ clientX:170, clientY:60 }] });
      assert.equal(b.player.progress, 90); assert.equal(b.seeks().length, before + 1);
      assert.deepEqual(Array.from(b.seeks().at(-1).args), [90]);
      b.tv.qtSetTvMode('tv'); await b.flush();
      assert.equal(b.tv.useQtTv().enabled, true); assert.equal(b.storage.get('qt-tv-presentation'), 'tv');
      assert.equal(b.byClass('qt-page-frame')[0], frame); assert.equal(b.byClass('player-tv-seek-editor').length, 0,
        'returning to TV never revives the cancelled preview');
      assert.equal(b.focus('player-progress-seek'), true); await b.key('ok');
      assert.ok(nativeText(b.byClass('player-tv-seek-value')[0]).includes('1:30'), 'the next deliberate remote edit starts from the touch-committed position');
      await b.key('left'); await b.key('back');
      assert.equal(b.player.progress, 90); assert.equal(b.seeks().length, before + 1);
      assert.deepEqual(b.runtimeErrors, []);
    } finally { await b.close(); }
  }
  console.log('TV Player touch mode switch: 1 focused full-production group / same-mounted wide+compact passed');
}
export async function runTvSurfaceChecks() {
  {
    const b = collectionFixture();
    const cards = byClass(b.render(), 'pl-item');
    assert.equal(cards.length, 2);
    const more = button(cards[0], '更多');
    assert.ok(more, 'TV user can see More on a local outer collection card');
    assert.equal(button(cards[1], '更多'), undefined, 'online collection card has no local editing action');
    more.props.onClick(event());
    assert.equal(b.sheets.length, 1, 'one click dispatches one existing sheet');
    assert.deepEqual(plain(b.sheets[0].itemList), ['修改歌单信息', '设为默认收藏歌单']);
    b.sheets[0].resolve(0); await drain();
    assert.deepEqual(plain(b.sheets[1].itemList), ['编辑歌单名称', '编辑歌单封面']);
    b.sheets[1].resolve(0); await drain();
    const input = descendants(b.render()).find(node => node.type === 'input' && node.props?.placeholder === '请输入歌单名称');
    assert.equal(input.props.value, '本地列表', 'existing rename draft uses the selected playlist');
    assert.equal(input.props.focus, false, 'TV navigation does not summon the IME before OK');
    assert.equal(b.routes.length, 0, 'local More does not open the card detail route');
    b.tv.enabled = false;
    const phoneCards = byClass(b.render(), 'pl-item');
    assert.equal(button(phoneCards[0], '更多'), undefined, 'phone visual path is preserved');
    phoneCards[0].props.onLongpress(event());
    assert.equal(b.sheets.length, 3, 'phone retains the original longpress menu');
    cases++;
  }
  {
    const b = platformFixture();
    const down = button(platformCard(b, 'a'), '下移');
    assert.ok(down, 'TV user can reorder a real source card without touch dragging');
    assert.equal(button(platformCard(b, 'a'), '上移').props.disabled, true, 'first card has no previous installed slot');
    assert.equal(button(platformCard(b, 'c'), '下移').props.disabled, true, 'last installed card does not displace an orphan');
    assert.equal(button(platformCard(b, 'orphan'), '下移'), undefined, 'orphan has no reorder action');
    await down.props.onClick(event()); await drain();
    const list = descendants(b.render()).find(node => node.type?.name === 'qt-reorder-list');
    assert.deepEqual(plain(list.props.items.map(item => item.id)), ['b', 'a', 'c', 'orphan']);
    assert.equal(b.applies.length, 1, 'one remote click uses one original engine application');
    assert.equal(b.events.filter(([name]) => name === 'qt-source-policy-changed').length, 1, 'one remote click persists one source-policy event');
    b.tv.enabled = false;
    assert.equal(button(platformCard(b, 'a'), '下移'), undefined, 'phone retains its drag-only presentation');
    list.props.onActive(true);
    await list.props.onReorder(['c', 'b', 'a', 'orphan']); await drain();
    list.props.onActive(false);
    assert.equal(b.applies.length, 2, 'phone drag still applies through the shared transaction');
    cases++;
  }
  {
    for (const invalid of [['a', 'a', 'c', 'orphan'], ['a', 'b', 'orphan', 'c'], ['a', 'b'], ['a', 'b', 'c', 'missing']]) {
      const b = platformFixture(false);
      const list = descendants(b.render()).find(node => node.type?.name === 'qt-reorder-list');
      list.props.onActive(true); await list.props.onReorder(invalid); await drain();
      assert.equal(b.applies.length, 0, 'invalid complete order never reaches engine');
      assert.equal(b.events.length, 0, 'invalid complete order never persists');
      list.props.onActive(false);
    }
    for (const mutation of ['policy', 'registry', 'orphan', 'unload']) {
      const b = platformFixture(false);
      const list = descendants(b.render()).find(node => node.type?.name === 'qt-reorder-list');
      list.props.onActive(true);
      if (mutation === 'policy') sourcePolicyFixture(b.uni).toggleSource('a', b.registry.catalog.map(source => source.id));
      if (mutation === 'registry') b.registry.generation++;
      if (mutation === 'orphan') b.entries.length = 0;
      if (mutation === 'unload') b.hooks.unload.forEach(hook => hook());
      const before = b.events.length;
      await list.props.onReorder(['b', 'a', 'c', 'orphan']); await drain();
      assert.equal(b.applies.length, 0, mutation + ' mutation cancels a stale drag commit');
      assert.equal(b.events.length, before, mutation + ' mutation never adds an order write');
    }
    cases++;
  }
  {
    const b = platformFixture();
    b.engine.hold = true;
    const down = button(platformCard(b, 'a'), '下移');
    const pending = down.props.onClick(event()); await drain();
    assert.equal(button(platformCard(b, 'a'), '下移').props.disabled, true, 'pending source application locks remote order actions');
    await down.props.onClick(event()); await drain();
    assert.equal(b.applies.length, 1, 'key repetition while engine is pending dispatches exactly once');
    assert.equal(b.events.filter(([name]) => name === 'qt-source-policy-changed').length, 1);
    b.engine.releases.shift()(); await pending; await drain();
    assert.equal(button(platformCard(b, 'a'), '下移').props.disabled, false, 'engine completion releases pending UI');
    b.engine.hold = false; b.engine.fail = true;
    await button(platformCard(b, 'a'), '上移').props.onClick(event()); await drain();
    assert.ok(b.toasts.some(message => String(message.title).includes('owned engine ack failed')), 'original policy failure stays visible');
    cases++;
  }
  {
    const b = platformFixture();
    byClass(platformCard(b, 'a'), 'src-title')[0].props.onClick(event());
    const qr = button(platformCard(b, 'a'), '扫码登录');
    assert.ok(qr, 'TV QR entry comes from a real declared source capability');
    qr.props.onClick(event()); await drain();
    const image = byClass(b.render(), 'qr-img')[0];
    assert.ok(image.props.src.startsWith('/fixture/cache/qt-qr-'), 'QR displays the genuine source session as a cached image');
    assert.ok(styleText(image).includes('width:280px') && styleText(image).includes('height:280px'), 'TV QR uses the shared logical-pixel size');
    assert.deepEqual(plain(b.qrCalls[0]), { name: 'authQrCreate', args: [{ source: 'a' }] });
    const wrap = byClass(b.render(), 'qr-wrap')[0];
    assert.ok(styleText(wrap).includes('padding:20px'), 'TV code retains a white quiet zone');
    b.hooks.unload.forEach(hook => hook());
    assert.equal(b.intervals.size, 0, 'unload closes the original QR polling session');
    cases++;
  }
  {
    const b = playerFixture({ style: 'focus' });
    await b.mount();
    const browse = button(b.render(), '浏览歌词');
    assert.ok(browse, 'TV player exposes full-song browsing without changing the accepted three-line style');
    browse.props.onClick(event()); await Vue.nextTick(); await drain();
    assert.equal(byClass(b.render(), 'lyric-viewport').length, 1, 'explicit TV browsing reveals the real full-song timeline');
    assert.equal(b.playingStyle.style, 'focus', 'browsing leaves the saved playing style unchanged');
    assert.equal(await b.key('down'), true);
    await b.key('ok');
    assert.deepEqual(b.seeks, [10.5], 'remote OK seeks the selected real lyric time plus the saved half-second offset');
    b.dispose();
    cases++;
  }
  {
    const b = playerFixture({ style: 'focus' }); await b.mount();
    const cover = button(b.render(), '封面');
    assert.ok(cover, 'TV exposes an explicit cover/lyrics switch, independent of phone-only background taps');
    cover.props.onClick(event()); await Vue.nextTick(); await drain();
    assert.equal(byClass(b.render(), 'gallery-art').length, 1, 'cover mode presents the actual cover without rewriting style');
    assert.equal(descendants(b.render()).filter(node => node.type?.name === 'QtFocusLyrics').length, 0);
    assert.equal(b.playingStyle.style, 'focus');
    const preview = button(b.render(), '预览封面'); assert.ok(preview);
    preview.props.onClick(event());
    assert.ok(b.native.activations.some(receipt => receipt.type === 'preview' && receipt.urls[0] === '/fixture/cover.png'));
    button(b.render(), '歌词').props.onClick(event()); await Vue.nextTick(); await drain();
    assert.equal(descendants(b.render()).filter(node => node.type?.name === 'QtFocusLyrics').length, 1);
    button(b.render(), '浏览歌词').props.onClick(event()); await Vue.nextTick(); await drain();
    await b.key('down'); button(b.render(), '复制歌词').props.onClick(event());
    assert.deepEqual(b.clipboard, ['[0:10] 第二句（译文）（《测试曲》 - 测试歌手，来自轻听音乐）']);
    b.dispose(); cases++;
  }
  {
    const first = { id: 'duplicate', platform: 'owned', name: '重复曲', singer: '测试歌手', duration: 180 };
    const second = { ...first };
    const b = playerFixture({ queue: [first, second] }); await b.mount();
    byClass(b.render(), 'control-side').find(node => descendants(node).some(child => child.props?.name === 'list')).props.onClick(event());
    await Vue.nextTick(); await drain();
    const rows = byClass(b.render(), 'queue-row');
    assert.equal(rows.length, 2);
    const more = button(rows[1], '更多');
    assert.ok(more, 'TV inner queue offers visible More for the selected duplicate occurrence');
    more.props.onClick(event()); await Vue.nextTick(); await drain();
    const sheet = descendants(b.render()).find(node => ['QtActionSheet', 'qt-action-sheet'].includes(node.type?.name));
    assert.ok(sheet?.props.visible);
    sheet.props.onSelect(sheet.props.actions[2], 2); await Vue.nextTick(); await drain();
    assert.deepEqual(plain(b.player.queue), [first], 'visible More removes the selected occurrence, not the first matching song ID');
    assert.deepEqual(b.persistence, ['timeline', 'persist']);
    b.dispose(); cases++;
  }
  {
    const b = playerFixture(); await b.mount();
    byClass(b.render(), 'control-side').find(node => descendants(node).some(child => child.props?.name === 'list')).props.onClick(event());
    await Vue.nextTick(); await drain(); b.render();
    assert.equal(byClass(b.render(), 'queue-list-viewport').length, 1);
    await b.key('back');
    assert.equal(byClass(b.render(), 'queue-list-viewport').length, 0, 'real remote Back closes the actual inner queue before navigating the page');
    assert.deepEqual(b.routes, []);
    b.dispose(); cases++;
  }
  {
    const b = playerFixture({ wide: false, style: 'focus' }); await b.mount();
    button(b.render(), '封面').props.onClick(event()); await Vue.nextTick(); await drain();
    assert.equal(byClass(b.render(), 'gallery-art').length, 1, 'compact TV cover entry displays the genuine album image, including immersive styles');
    button(b.render(), '歌词').props.onClick(event()); await Vue.nextTick(); await drain();
    assert.ok(Number(styleText(byClass(b.render(), 'lyric-tools-row')[0]).match(/height:([\d.]+)px/)[1]) >= 56, 'TV lyric tool row reserves the actual 56px remote control height');
    assert.ok(Number(styleText(byClass(b.render(), 'nav')[0]).match(/height:([\d.]+)px/)[1]) >= 56);
    assert.equal(b.playingStyle.style, 'focus');
    b.dispose(); cases++;
  }
  {
    for (const wide of [true, false]) {
      const b = playerFixture({ wide, style: 'focus' }); await b.mount();
      button(b.render(), '浏览歌词').props.onClick(event()); await Vue.nextTick(); await drain();
      await b.key('down');
      assert.ok(b.native.highlights.some(id => id.endsWith(':custom:player-lyric:song-a:owned:1')), 'reveal precedes real business-ID focus in both layouts');
      b.player.progress = 26; await Vue.nextTick(); await drain();
      assert.equal(byClass(b.render(), 'lrc-scroll-hint').length, 1, 'playback progression leaves the explicit browsing target separate from playing state');
      await b.key('menu');
      assert.deepEqual(b.clipboard, ['[0:10] 第二句（译文）（《测试曲》 - 测试歌手，来自轻听音乐）']);
      await b.key('right', 1); await b.key('right', 2); await b.key('ok');
      assert.deepEqual(b.seeks, [30.5], 'direction repeats clamp to the last lyric rather than wrapping');
      assert.equal(descendants(b.render()).filter(node => node.type?.name === 'QtFocusLyrics').length, 1, 'confirm restores accepted three-line presentation');
      b.dispose();
    }
    cases++;
  }
  {
    const b = playerFixture({ style: 'focus' }); await b.mount();
    const begin = async () => { button(b.render(), '浏览歌词').props.onClick(event()); await Vue.nextTick(); await drain(); };
    await begin(); await b.key('down'); await b.key('back');
    assert.equal(byClass(b.render(), 'lyric-viewport').length, 0, 'Back resumes following before any route exit');
    assert.deepEqual(b.routes, []); assert.deepEqual(b.seeks, []);
    await begin(); b.owner.active = false; b.owner.route = 'pages/other/index'; await b.key('ok');
    assert.deepEqual(b.seeks, [], 'inactive page ownership blocks held lyric actions');
    b.owner.active = true; b.owner.route = 'pages/player/index';
    b.tvApi.useQtTv().foreground = false; await Vue.nextTick(); await drain();
    assert.equal(button(b.render(), '恢复跟随'), undefined, 'background transition cancels explicit browsing');
    b.tvApi.useQtTv().foreground = true; await begin();
    b.player.current = { ...b.player.current, id: 'song-b' }; await b.key('ok');
    assert.deepEqual(b.seeks, [], 'track change invalidates the previous lyric target before delivery');
    await begin(); b.hide(); await b.key('ok');
    assert.deepEqual(b.seeks, [], 'hidden player consumes no lyric seek');
    b.dispose(); cases++;
  }
  {
    const shared = { id: 'same', platform: 'owned', name: '同引用重复', singer: '测试歌手', duration: 180 };
    const b = playerFixture({ queue: [shared, shared] }); await b.mount();
    const open = () => byClass(b.render(), 'control-side').find(node => descendants(node).some(child => child.props?.name === 'list')).props.onClick(event());
    open(); await Vue.nextTick(); await drain();
    let rows = byClass(b.render(), 'queue-row');
    const ids = rows.map(row => row.props['data-qt-tv-id']); assert.notEqual(ids[0], ids[1]);
    rows[1].props.onClick(event()); await Vue.nextTick(); await drain();
    rows = byClass(b.render(), 'queue-row');
    assert.equal(byClass(b.render(), 'queue-row-active').length, 1, 'only the explicitly chosen occurrence is playing');
    assert.equal(byClass(b.render(), 'queue-row-active')[0].props['data-qt-tv-id'], ids[1]);
    byClass(rows[1], 'queue-move').find(node => node.props.name === 'arrow-up').props.onClick(event()); await Vue.nextTick(); await drain();
    rows = byClass(b.render(), 'queue-row');
    assert.deepEqual(rows.map(row => row.props['data-qt-tv-id']), [ids[1], ids[0]], 'same-reference occurrences retain identity during a known in-page move');
    byClass(rows[1], 'queue-move').find(node => node.props.name === 'close').props.onClick(event()); await Vue.nextTick(); await drain();
    assert.equal(b.plays.length, 1, 'removing the other identical-reference occurrence keeps current playback');
    assert.equal(byClass(b.render(), 'queue-row')[0].props['data-qt-tv-id'], ids[1]);
    assert.deepEqual(b.persistence, ['timeline', 'persist', 'timeline', 'persist']);
    b.dispose(); cases++;
  }
  {
    const b = playerFixture({ enabled: false, wide: false, style: 'classic' }); await b.mount();
    assert.equal(button(b.render(), '浏览歌词'), undefined); assert.equal(button(b.render(), '封面'), undefined);
    byClass(b.render(), 'disc-plate')[0].props.onClick(event()); await Vue.nextTick(); await drain();
    assert.equal(byClass(b.render(), 'lyric-viewport').length, 1, 'phone retains the original cover tap lyric transition');
    const progress = byClass(b.render(), 'prog-range')[0];
    progress.props.onTouchstart({ touches: [{ clientX: 250 }] }); progress.props.onTouchend({ changedTouches: [{ clientX: 250 }] });
    assert.deepEqual(b.seeks, [90], 'ordinary progress seeking does not add lyric offset');
    b.dispose(); cases++;
  }
  {
    for (const wide of [true, false]) {
      const b = playerFixture({ wide, style: 'classic' }); await b.mount();
      if (!wide) byClass(b.render(), 'disc-plate')[0].props.onClick(event());
      button(b.render(), '封面').props.onClick(event()); await Vue.nextTick(); await drain();
      assert.equal(byClass(b.render(), 'gallery-art').length, 1, 'explicit TV cover shows one album image in the saved classic style');
      assert.equal(byClass(b.render(), wide ? 'wide-vinyl' : 'disc-wrap').length, 0, 'TV cover override does not stack the phone turntable and gallery');
      button(b.render(), '歌词').props.onClick(event()); await Vue.nextTick(); await drain();
      assert.equal(byClass(b.render(), 'lyric-viewport').length, 1);
      assert.equal(b.playingStyle.style, 'classic'); b.dispose();
    }
    cases++;
  }
  {
    const b = playerFixture({ wide: false, style: 'classic' }); await b.mount();
    const lyrics = button(b.render(), '歌词');
    assert.ok(lyrics, 'compact classic TV first action names the lyrics destination, not the cover already displayed');
    lyrics.props.onClick(event()); await Vue.nextTick(); await drain();
    assert.equal(byClass(b.render(), 'lyric-viewport').length, 1);
    button(b.render(), '封面').props.onClick(event()); await Vue.nextTick(); await drain();
    assert.equal(byClass(b.render(), 'gallery-art').length, 1);
    assert.equal(b.playingStyle.style, 'classic'); b.dispose(); cases++;
  }
  {
    for (const change of ['remove', 'identity', 'hide', 'close', 'unload', 'ambiguous']) {
      const first = { id: 'dup', platform: 'owned', name: '重复曲', singer: '测试歌手', duration: 180 };
      const second = change === 'ambiguous' ? first : { ...first };
      const b = playerFixture({ queue: [first, second] }); await b.mount();
      byClass(b.render(), 'control-side').find(node => descendants(node).some(child => child.props?.name === 'list')).props.onClick(event());
      await Vue.nextTick(); await drain();
      const oldRow = byClass(b.render(), 'queue-row')[1];
      button(oldRow, '更多').props.onClick(event()); await Vue.nextTick(); await drain();
      const sheet = descendants(b.render()).find(node => ['QtActionSheet', 'qt-action-sheet'].includes(node.type?.name));
      if (change === 'remove' || change === 'ambiguous') b.player.queue = [b.player.queue[0]];
      else if (change === 'identity') b.player.queue[1].id = 'replaced';
      else if (change === 'hide') b.hide();
      else if (change === 'close') byClass(b.render(), 'sheet-act').find(node => node.props?.name === 'close').props.onClick(event());
      else b.dispose();
      const expected = plain(b.player.queue);
      sheet.props.onSelect(sheet.props.actions[2], 2); oldRow.props.onClick(event());
      await Vue.nextTick(); await drain();
      assert.deepEqual(plain(b.player.queue), expected, change + ' invalidates old occurrence actions rather than removing or playing a replacement');
      assert.deepEqual(b.plays, []); assert.deepEqual(b.persistence, []);
      if (change !== 'unload') b.dispose();
    }
    cases++;
  }
  {
    const shared = { id: 'same', platform: 'owned', name: '异步重复', singer: '测试歌手', duration: 180 };
    const b = playerFixture({ queue: [shared, shared], deferQueuePlay: true }); await b.mount();
    byClass(b.render(), 'control-side').find(node => descendants(node).some(child => child.props?.name === 'list')).props.onClick(event());
    await Vue.nextTick(); await drain();
    const rows = byClass(b.render(), 'queue-row'); const id = rows[1].props['data-qt-tv-id'];
    rows[1].props.onClick(event()); b.playReleases.shift()(); await Vue.nextTick(); await drain();
    assert.equal(byClass(b.render(), 'queue-row-active')[0].props['data-qt-tv-id'], id, 'awaited public play completion keeps the chosen repeated-reference occurrence, not currentIndex first-match');
    b.dispose(); cases++;
  }
  await fullPlayerSeekCase(); cases++;
  await fullPlayerSeekContextCase(); cases++;
  await fullPlayerSeekBoundsCase(); cases++;
  await fullPlayerSeekCapabilityModalCase(); cases++;
  await runTvPlayerTouchTakeoverChecks(); cases++;
  await runTvPlayerTouchModeSwitchChecks(); cases++;
  console.log('TV surfaces: ' + cases + ' approved public-page groups passed');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runTvSurfaceChecks();
