// task-25 agreed seam: full production list host SFC + real QtUI row + public clicks.
// Independent renderer/loader mechanics. Owned substitutions below are
// network response data, native files/audio and SDK viewport/lifecycle/clock.
// Full Player/Dislikes/Downloads/selection/sheet services run unchanged.
// No private page handler/export, copied business calculation or page mock.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as Vue from 'vue';
import * as Pinia from 'pinia';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import vm from 'node:vm';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';

const noop = () => {};
const UI = 'uni_modules/qt-ui/';
const walk = node => [node, ...node.children.flatMap(walk)];
const hasClass = (node, name) => String(node.props.class ?? '').split(/\s+/).includes(name);
const textOf = node => node.text + node.children.map(textOf).join('');
const plain = value => JSON.parse(JSON.stringify(value));
// Independent task-owned SDK mechanics; frozen settings helper is never edited.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return this[key] ?? null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}
function platformSource(text, platform) {
  const symbols = new Set([platform, 'APP']), stack = [], lines = [];
  let enabled = true;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:\/\/|<!--)\s*#(ifdef|ifndef|else|endif)\s*(.*?)\s*(?:-->)?\s*$/);
    if (!match) { if (enabled) lines.push(line); continue; }
    const [, kind, expression] = match;
    if (kind === 'ifdef' || kind === 'ifndef') {
      const found = expression.split(/\|\|/).some(value => symbols.has(value.trim()));
      stack.push({ parent:enabled, matches:kind === 'ifdef' ? found : !found }); enabled = enabled && stack.at(-1).matches;
    } else {
      const frame = stack.at(-1); assert.ok(frame, 'balanced platform directive');
      if (kind === 'else') enabled = frame.parent && !frame.matches;
      else { stack.pop(); enabled = frame.parent; }
    }
  }
  assert.equal(stack.length, 0); return lines.join('\n');
}
function node(tag, text = '') {
  return { tag, tagName:tag.toUpperCase(), text, props:{}, children:[], parent:null, listeners:{},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== fn); },
    dispatchEvent(event) { (this.listeners[event.type] ?? []).forEach(fn => fn(event)); },
    querySelectorAll(selector) { return walk(this).slice(1).filter(n => selector.startsWith('.') ? hasClass(n, selector.slice(1)) : selector.startsWith('#') ? n.props.id === selector.slice(1) : n.tag === selector); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    getBoundingClientRect() { return { left:20, top:40, width:300, height:100, right:320, bottom:140 }; } };
}
function detach(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; }
const renderer = Vue.createRenderer({ createElement:tag => node(tag), createText:text => node('#text', text), createComment:text => node('#comment', text),
  setText(n, text) { n.text = text; }, setElementText(n, text) { n.text = text; n.children = []; },
  insert(n, parent, before = null) { detach(n); const index = before ? parent.children.indexOf(before) : -1;
    if (index < 0) parent.children.push(n); else parent.children.splice(index, 0, n); n.parent = parent; },
  remove:detach, parentNode:n => n.parent, nextSibling:n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
  patchProp(n, key, _old, value) { n.props[key] = value; if (key === 'value') n.value = value; } });
function css(n) {
  const style = Vue.normalizeStyle(n.props.style); if (typeof style !== 'string') return style ?? {};
  return Object.fromEntries(style.split(';').filter(value => value.includes(':')).map(value => {
    const colon = value.indexOf(':'); return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()]; }));
}
async function flushVue() { for (let i = 0; i < 20; i++) await Promise.resolve(); await Vue.nextTick(); }
export async function tvListHostFixture({ width = 1280, height = 720, platform = 'APP-ANDROID', savedMode = 'tv',
  initialStorage = {}, boundaryOverrides = {}, realFrame = false, routeOptions = {}, nativeAvailable = false,
  television = false, files = {}, sdkOverrides = {} } = {}) {
  const root = node('fixture-root'), cache = new Map(), storage = new Map(Object.entries(initialStorage));
  if (savedMode) storage.set('qt-tv-presentation', savedMode);
  const storageWrites = [], nativeCalls = [], routes = [], toastCalls = [], warnings = [], measurements = [], titles = [], ioCalls = [];
  const lifecycle = { load:[], show:[], hide:[], unload:[], backPress:[], resize:[] }, timers = new Map(), eventBus = new Map();
  const fileData = new Map(Object.entries(files)), runtimeErrors = [], resizeListeners = new Set();
  async function flush() { await flushVue(); if (runtimeErrors.length) throw runtimeErrors[0]; }
  let serial = 0, clockNow = 1000000, app = null, currentRoute = '';
  const viewport = { windowWidth:width, windowHeight:height, screenWidth:width, screenHeight:height,
    screenTop:0, windowTop:0, statusBarHeight:0, safeAreaInsets:{ top:0, bottom:0, left:0, right:0 } };
  const device = { television, nativeAvailable, leanback:false, uiModeType:television ? 4 : 1 }, audioBoundary = { dlna:false, overlayPermission:true };
  function addTimer(fn, value = 0, repeat = false) {
    const delay = Math.max(repeat ? 1 : 0, Number(value) || 0), id = ++serial; timers.set(id, { fn, delay, repeat, due:clockNow + delay }); return id;
  }
  const clock = { now:() => clockNow, advance(ms) { assert.ok(ms >= 0); clockNow += ms; return clockNow; },
    intervalCount:delay => [...timers.values()].filter(t => t.repeat && (delay == null || t.delay === delay)).length,
    timeoutCount:delay => [...timers.values()].filter(t => !t.repeat && (delay == null || t.delay === delay)).length,
    async runTimers(ms = 0) {
      const end = clockNow + ms; let count = 0;
      while (true) {
        const entry = [...timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!entry) break; assert.ok(++count <= 10000, 'bounded SDK timer delivery');
        const [id, timer] = entry; clockNow = Math.max(clockNow, timer.due);
        if (timer.repeat) timer.due = clockNow + timer.delay; else timers.delete(id);
        await timer.fn(); await flush();
      } clockNow = end; await flush(); return count;
    } };
  const missing = path => { throw new Error('owned fixture file absent: ' + path); };
  const fs = {
    accessSync(path) { ioCalls.push({ name:'access', path }); if (!fileData.has(path)) missing(path); },
    readFileSync(path) { if (!fileData.has(path)) missing(path); return fileData.get(path); },
    writeFileSync(path, value) { fileData.set(path, value); },
    copyFileSync(src, dst) { if (!fileData.has(src)) missing(src); fileData.set(dst, fileData.get(src)); },
    unlinkSync(path) { if (!fileData.delete(path)) missing(path); },
    readdirSync:() => [], mkdirSync:noop,
    readFile({ filePath, success, fail }) { fileData.has(filePath) ? success?.({ data:fileData.get(filePath) }) : fail?.({ errMsg:'owned file absent' }); },
    writeFile({ filePath, data, success }) { fileData.set(filePath, data); success?.({}); },
  };
  const uni = { env:{ USER_DATA_PATH:'unifile://usr' },
    getWindowInfo:() => viewport, getSystemInfoSync:() => ({ ...viewport, osTheme:'light', platform:'android' }),
    getStorageSync:key => storage.get(key) ?? null,
    setStorageSync(key, value) { storage.set(key, value); storageWrites.push([key, value]); }, removeStorageSync:key => storage.delete(key),
    getNetworkType:({ success }) => success?.({ networkType:'4g' }), onNetworkStatusChange:noop,
    setNavigationBarTitle:({ title }) => titles.push(title), onWindowResize:fn => resizeListeners.add(fn), offWindowResize:fn => resizeListeners.delete(fn),
    onThemeChange:noop, setAppTheme:noop, setTabBarStyle:noop,
    $on(name, fn) { (eventBus.get(name) ?? (eventBus.set(name, []), eventBus.get(name))).push(fn); },
    $off(name, fn) { eventBus.set(name, (eventBus.get(name) ?? []).filter(item => item !== fn)); },
    $emit(name, ...args) { [...(eventBus.get(name) ?? [])].forEach(fn => fn(...args)); },
    navigateTo:value => routes.push({ action:'navigate', ...value }), redirectTo:value => routes.push({ action:'redirect', ...value }),
    navigateBack:value => routes.push({ action:'back', ...value }), getFileSystemManager:() => fs,
    request:options => { ioCalls.push({ name:'request', url:options.url }); options.fail?.({ errMsg:'owned network response not configured' }); options.complete?.({}); },
    downloadFile:options => { ioCalls.push({ name:'download', url:options.url }); options.fail?.({ errMsg:'owned file absent' }); },
    showToast:value => toastCalls.push(value), hideKeyboard:noop,
    createSelectorQuery() {
      let selector = ''; const requests = [];
      return { in() { return this; }, select(value) { selector = value; return this; },
        boundingClientRect(fn) { requests.push([selector, fn]); return this; },
        exec(fn) { measurements.push(() => {
          const values = requests.map(([query, reply]) => {
            const found = query.startsWith('.') ? walk(root).find(n => hasClass(n, query.slice(1))) : walk(root).find(n => n.props.id === query.slice(1));
            const rectangle = found ? { left:20, top:40, width:300, height:100, bottom:140, right:320 } : null; reply?.(rectangle); return rectangle;
          }); fn?.(values);
        }); } };
    }, ...sdkOverrides };
  const native = new Proxy({}, { get(_target, name) {
    return (...args) => {
      nativeCalls.push({ name:String(name), args });
      if (name === 'audioDlnaActive') return audioBoundary.dlna;
      if (name === 'audioEffectsSupported' || name === 'audioLyricHasOverlayPermission') return true;
      if (name === 'audioCurrentMediaId') return '';
      if (name === 'audioGetCurrentTime' || name === 'audioCacheSize' || name === 'audioCarLyricToken') return 0;
      if (name === 'audioIsIntendingToPlay' || name === 'audioLyricIsShowing') return false;
      return true;
    };
  } });
  const overrides = {
    'services/tv-platform': { tvReadDevice:() => device, tvStartRemote:noop, tvSetRemoteState:noop, tvStopRemote:noop,
      tvCollect:() => [], tvHighlight:noop, tvActivate:noop, tvScroll:() => false, tvPresent:noop, tvBack:noop },
    'services/logger': { logWarn:noop, logWarnV:noop, logErrV:noop, logInfo:noop, logMsg:noop, logMsgErr:noop, logMsgWarn:noop, logSupported:() => false, logBytes:async () => 0 },
    'services/diag':{ qtDiag:noop }, 'services/toast':{ qtShowToast:value => toastCalls.push(value) },
    'uni_modules/qt-stat':{ qtTrackPage:noop }, ...boundaryOverrides,
  };
  const fixtureVue = { ...Vue, vModelText:{ created(n, binding, vnode) { n.value = binding.value;
    n.addEventListener('input', event => vnode.props['onUpdate:modelValue']?.(event.detail?.value ?? n.value)); },
    beforeUpdate(n, binding) { n.value = binding.value; } } };
  const context = { console, uni, UTSJSONObject, Date:class extends Date { static now() { return clockNow; } },
    getCurrentPages:() => [{ route:currentRoute, options:routeOptions }],
    setTimeout:(fn, delay) => addTimer(fn, delay), clearTimeout:id => timers.delete(id),
    setInterval:(fn, delay) => addTimer(fn, delay, true), clearInterval:id => timers.delete(id),
    requestAnimationFrame:fn => addTimer(() => fn(clockNow), 16), cancelAnimationFrame:id => timers.delete(id),
  };
  function load(request, from = resolve(ROOT, 'fixture.ts')) {
    if (request === 'vue') return fixtureVue;
    if (request === 'pinia') return Pinia;
    if (request === '@dcloudio/uni-app') return Object.fromEntries(Object.entries(lifecycle).map(([key, callbacks]) => [
      'on' + key[0].toUpperCase() + key.slice(1), fn => { callbacks.push(fn); if (key === 'load') fn(routeOptions); } ]));
    if (request === '@/uni_modules/qt-audio-player') return native;
    let path = request.startsWith('@/') ? resolve(ROOT, request.slice(2)) : request.startsWith('.') ? resolve(dirname(from), request) : resolve(ROOT, request);
    const key = relative(ROOT, path).replaceAll('\\', '/').replace(/\.(ts|uts|uvue)$/, '');
    if (overrides[key]) return overrides[key];
    if (!existsSync(path)) path = ['.ts', '.uts', '.uvue'].map(ext => path + ext).find(existsSync) ?? path;
    if (cache.has(path)) return cache.get(path).exports;
    const text = platformSource(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'), platform);
    let program = text;
    if (path.endsWith('.uvue')) {
      const custom = tag => ['view', 'text', 'image', 'scroll-view', 'list-view', 'list-item', 'sticky-section', 'sticky-header', 'input', 'textarea', 'slider', 'video', 'web-view'].includes(tag);
      const { descriptor, errors } = parse(text, { filename:path, templateParseOptions:{ isCustomElement:custom } });
      assert.deepEqual(errors, [], 'full production SFC parse: ' + key);
      program = compileScript(descriptor, { id:key, inlineTemplate:true, templateOptions:{ compilerOptions:{ isCustomElement:custom } } }).content;
    }
    const result = ts.transpileModule(program, { fileName:path.replace(/\.(uts|uvue)$/, '.ts'), compilerOptions:{ target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS, esModuleInterop:true } });
    const module = { exports:{} }; cache.set(path, module);
    vm.runInNewContext(result.outputText, { ...context, module, exports:module.exports, require:request => load(request, path) }, { filename:path });
    return module.exports;
  }
  const tv = load(UI + 'composables/use-qt-tv.ts'); tv.qtInitTv();
  const audio = load('services/audio-player.uts'), theme = load(UI + 'stores/theme.ts'), fonts = load(UI + 'stores/font-scale.ts'), action = load('services/action-sheet.ts');
  const ActionHost = load(UI + 'components/qt-action-sheet-host/qt-action-sheet-host.uvue').default;
  if (!realFrame) overrides[UI + 'components/qt-page-frame/qt-page-frame'] = { __esModule:true, default:Vue.defineComponent({ inheritAttrs:false,
    setup(_props, { slots }) { return () => Vue.h('view', { class:'fixture-frame' }, [slots.default?.(), Vue.h(ActionHost)]); } }) };
  async function mount(path, props = {}, withActionHost = false) {
    currentRoute = path.replace(/\.uvue$/, ''); const showFrom = lifecycle.show.length;
    const Component = load(path).default;
    app = renderer.createApp({ setup:() => () => Vue.h('view', {}, [Vue.h(Component, props), withActionHost ? Vue.h(ActionHost) : null]) });
    app.config.warnHandler = message => warnings.push(message);
    app.config.errorHandler = error => runtimeErrors.push(error);
    app.mount(root); await flush();
    for (const show of lifecycle.show.slice(showFrom)) await show(); await flush();
  }
  async function dispatch(target, type = 'click', detail = {}) {
    assert.ok(target, 'public native target exists'); let stopped = false;
    const event = { type, detail, target, currentTarget:target, stopPropagation() { stopped = true; }, preventDefault:noop, ...detail };
    for (let n = target; n && !stopped; n = n.parent) {
      event.currentTarget = n; const handler = n.props['on' + type[0].toUpperCase() + type.slice(1)];
      if (Array.isArray(handler)) handler.forEach(fn => fn(event)); else handler?.(event);
      (n.listeners[type] ?? []).forEach(fn => fn(event));
    } await flush();
  }
  async function close() { app?.unmount(); tv.qtDisposeTv(); timers.clear(); await flush(); }
  const byClass = name => walk(root).filter(n => hasClass(n, name));
  const labeled = (className, labelClass, label) => byClass(className).find(n => walk(n).some(child => hasClass(child, labelClass) && textOf(child) === label));
  return { root, mount, dispatch, close, flush, load, tv, audio, theme, fonts, action, storage, storageWrites, nativeCalls, routes, toastCalls,
    warnings, runtimeErrors, measurements, lifecycle, clock, device, viewport, audioBoundary, titles, ioCalls, fileData, uni, byClass, css, plain, text:() => textOf(root),
    button:label => labeled('qt-button', 'qt-button-label', label), option:label => labeled('qo', 'qo-label', label), cell:label => labeled('cell', 'cell-title', label),
    setWindow(value) { Object.assign(viewport, value); const size = { windowWidth:viewport.windowWidth, windowHeight:viewport.windowHeight };
      [...resizeListeners].forEach(fn => fn({ size })); lifecycle.resize.forEach(fn => fn({ size })); },
    setSdk(value) { Object.assign(uni, value); },
  };
}

const track = (id, name = id) => ({ id, platform:'owned', name, singer:'验证歌手', album:'验证专辑', picUrl:'https://owned.invalid/cover.png', duration:180 });
const first = track('duplicate', '第一出现项');
const second = track('duplicate', '第二出现项');
const last = track('last', '末项');

export async function listFixture({ width = 1280, height = 720, platform = 'APP-ANDROID', savedMode = 'tv', data = [first, second, last], apiOverrides = {}, ...options } = {}) {
  const network = [];
  // Native SDK: no host files or engine/network are consulted.
  const sdk = { publicDataDir: () => '', dataDir: () => '/owned-fixture',
    queryPermissionStates: () => [], statLocalFile: () => -1,
    readEmbeddedTags: () => null,
    readTextFile: (_path, reply) => reply(false, '', 'fixture file absent'),
    exists: (_path, reply) => reply(true, '0', ''),
    start: () => false, isRunning: () => false, isHealthy: () => false };
  const api = { availableQualities: () => ['320'], lyric: async () => null,
    lyrics: async () => null, cachedLyricWordByWord: () => '',
    latest: async (...args) => { network.push({ name:'latest', args }); return data; },
    playlist: async (...args) => { network.push({ name:'playlist', args }); return { id:'owned-playlist', platform:'wyy', name:'验证歌单', picUrl:'', tracks:data, playCount:'0' }; },
    ...apiOverrides }; 
  const b = await tvListHostFixture({ width, height, platform, savedMode, ...options, boundaryOverrides: {
    'stores/player': undefined, 'stores/dislikes': undefined, 'stores/downloads': undefined,
    'stores/source': undefined, 'stores/source-registry': undefined,
    'services/platform': undefined,
    'services/music-api': { musicApi:api, isContentFailError: () => false },
    'services/logger': { logWarn:noop, logWarnV:noop, logErrV:noop, logInfo:noop, logMsg:noop, logMsgErr:noop, logMsgWarn:noop, logSupported: () => false, logBytes:async () => 0 },
    'uni_modules/qt-js-engine':sdk, 'uni_modules/qt-app-native':sdk,
    ...options.boundaryOverrides,
  } });
  return { ...b, data, network, player:b.load('stores/player.ts').usePlayerStore() };
}

function rows(b, outerClass = 'song-item') {
  return b.byClass(outerClass).filter(node => walk(node).some(child => hasClass(child, 'lite-row')));
}
function geometry(b, outerClass, px, count = 3) {
  const hosts = rows(b, outerClass);
  assert.equal(hosts.length, count, 'actual public data renders each host occurrence');
  for (const host of hosts) {
    const row = walk(host).find(node => hasClass(node, 'lite-row'));
    assert.equal(b.css(host).height, px + 'px', 'native list host reserves the same TV height as its visible QtUI row');
    assert.equal(b.css(row).height, px + 'px', 'visible row follows shared TV font geometry');
  }
}
function identities(b, outerClass) {
  const visible = rows(b, outerClass).map(host => walk(host).find(node => hasClass(node, 'lite-row')));
  const ids = visible.map(node => node.props['data-qt-tv-id']);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0), 'host supplies nonempty occurrence identity');
  assert.equal(new Set(ids).size, ids.length, 'duplicate Song business keys still have distinct focus identities');
  return visible;
}

async function publicMoreEnqueue(b, row, expectedId, added = 1) {
  const before = b.player.playbackRevision(), queueCount = b.player.queue.length;
  await b.dispatch(walk(row).find(node => node.props['data-qt-tv-id']?.endsWith(':more')));
  assert.equal(b.player.playbackRevision(), before, 'More remains isolated from native row bubbling');
  await b.dispatch(b.option('加入播放队列'));
  assert.equal(b.player.queue.length, queueCount + added, 'public action sheet preserves real queue deduplication');
  const matching = b.player.queue.filter(song => song.id === expectedId);
  assert.equal(matching.length, 1, 'public action keeps exactly one selected business song');
  if (added) assert.equal(b.player.queue.at(-1).id, expectedId, 'new public action applies the selected row song');
  assert.equal(b.player.playbackRevision(), before, 'enqueue keeps playback separate');
}
function publicFocusBoundary() {
  let fixture = null, pending = null;
  const platform = {
    tvReadDevice:() => ({ television:true, leanback:true, uiModeType:4, nativeAvailable:true }),
    tvStartRemote:noop, tvSetRemoteState:noop, tvStopRemote:noop, tvPresent:noop, tvBack:noop, tvScroll:() => false,
    // Native collection/rectangle/activation substitute only. Scope choice, focus
    // restoration and the clicked production event/services remain entirely real.
    tvCollect:root => root == null ? [] : walk(root).filter(n => n.props['data-qt-tv-id']).map((n, i) => ({
      id:n.props['data-qt-tv-id'], left:20, top:40 + i * 100, width:300, height:76,
      visible:true, enabled:true, input:false, longPress:false,
    })),
    tvHighlight:noop, tvActivate:(id, longPress) => {
      assert.equal(longPress, false);
      pending = fixture.dispatch(walk(fixture.root).find(n => n.props['data-qt-tv-id'] === id));
    },
  };
  return { options:{ realFrame:true, nativeAvailable:true, television:true, boundaryOverrides:{ 'services/tv-platform':platform } },
    attach(b) { fixture = b; }, async ok() {
      pending = null;
      assert.equal(fixture.tv.qtTvDispatchRemote({ key:'ok', code:23, action:'down', repeat:0 }), true);
      assert.ok(pending, 'real native activation is delivered'); await pending; await fixture.flush();
    } };
}
async function publicSortFocusCase(page, sameReference = false) {
  const bridge = publicFocusBoundary(), data = sameReference ? [first, first, second, last] : [first, second, last];
  const b = page === 'daily-recommend' ? await recommendFixture(data, bridge.options)
    : await listFixture({ ...bridge.options, data,
      routeOptions:page === 'artist' ? { name:'验证歌手', id:'artist-fixture', platform:'wyy' } : { id:'owned-playlist', platform:'wyy', type:'playlist', name:'验证歌单' },
      apiOverrides:page === 'artist' ? { ensureRegistry:async () => {}, clampSearchPageSize:(_source, size) => size, artistSongs:async () => ({ songs:data, picUrl:'', hasMore:false }) } : {},
    });
  const outerClass = page === 'daily-recommend' ? 'rc-item' : 'song-item';
  bridge.attach(b);
  try {
    await b.mount('pages/' + page + '/index.uvue'); b.audio.audioPlayer.setGapless(false);
    const count = page === 'artist' ? 2 : sameReference ? 4 : 3;
    geometry(b, outerClass, 76, count); const all = identities(b, outerClass);
    if (sameReference) assert.notEqual(all[0].props['data-qt-tv-id'], all[1].props['data-qt-tv-id'], 'same source reference still has separate occurrences');
    const focused = page === 'artist' ? all[0] : all[1], originalId = focused.props['data-qt-tv-id'], expectedName = page === 'artist' || sameReference ? '第一出现项' : '第二出现项';
    assert.equal(b.tv.qtTvFocus(originalId), true, 'complete real Frame scope resolves focused occurrence');
    if (page === 'artist') { await b.dispatch(b.byClass('whero-tool')[1]); await b.dispatch(b.option('更改歌曲排序方式')); }
    else await b.dispatch(b.button('排序'));
    await b.dispatch(b.option('按歌曲名')); await b.dispatch(b.option('倒序')); await b.dispatch(b.byClass('qs-close').at(-1));
    geometry(b, outerClass, 76, count); identities(b, outerClass); b.tv.qtTvRefreshFocus();
    assert.equal(b.tv.qtTvFocusedId(), originalId, 'sort keeps a still-existing source occurrence focused');
    const current = walk(b.root).find(n => n.props['data-qt-tv-id'] === originalId);
    assert.equal(textOf(walk(current).find(n => hasClass(n, 'lite-name'))), expectedName, 'sort focus remains the exact original song name');
    const before = b.player.playbackRevision(); await bridge.ok();
    assert.equal(b.player.current.name, expectedName, 'remote OK plays the original focused occurrence after public sorting');
    assert.equal(b.player.playbackRevision() - before, 1, 'one native remote OK requests one real play');
  } finally { await b.close(); }
}
async function publicSelection(b) {
  const enter = b.byClass('head-batch')[0] ?? b.byClass('whero-act').find(n => textOf(n) === '批量') ?? b.button('批量');
  await b.dispatch(enter); assert.equal(b.byClass('lite-actions').length, 0, 'batch state hides row actions');
  const before = b.player.playbackRevision(); await b.dispatch(b.byClass('lite-row').at(-1));
  assert.equal(b.player.playbackRevision(), before, 'batch selection remains separate from playback');
  assert.match(b.text(), /已选\s*1/, 'one bubbling click selects once');
  await b.dispatch([...b.byClass('qt-batch-bar-btn'), ...b.byClass('qt-batch-bar-col-btn')].find(n => textOf(n) === '取消') ?? b.button('完成'));
  assert.ok(b.byClass('lite-actions').length > 0, 'public batch exit restores row actions');
}
async function publicFilterSort(b, { outerClass = 'song-item', count = 3, artist = false } = {}) {
  const list = b.byClass('scroll').find(n => n.tag === 'list-view');
  if (artist) await b.dispatch(b.byClass('whero-tool')[0]);
  const input = b.byClass(artist ? 'search-input' : 'track-search-input')[0];
  await b.dispatch(list, 'scroll', { scrollTop:900 }); const before = list.props['scroll-top'];
  await b.dispatch(input, 'input', { value:'末项 验证歌手' });
  assert.equal(rows(b, outerClass).length, 1, 'real track search preserves multi-word AND');
  assert.ok(textOf(rows(b, outerClass)[0]).includes('末项'));
  assert.notEqual(list.props['scroll-top'], before, 'filter change issues native scroll-top transition before replacing rows');
  await b.dispatch(b.byClass(artist ? 'search-clear' : 'track-search-clear')[0]);
  geometry(b, outerClass, 76, count); identities(b, outerClass);
  if (artist) { await b.dispatch(b.byClass('whero-tool')[1]); await b.dispatch(b.option('更改歌曲排序方式')); }
  else await b.dispatch(b.button('排序'));
  await b.dispatch(b.option('按歌曲名')); await b.dispatch(b.option('倒序'));
  geometry(b, outerClass, 76, count); identities(b, outerClass);
  await b.dispatch(b.option('按歌曲名')); await b.dispatch(b.byClass('qs-close').at(-1));
  assert.ok(textOf(rows(b, outerClass)[0]).includes('第一出现项'), 'canceling sort restores service order');
}

async function dailyCase() {
  const b = await listFixture();
  try {
    await b.mount('pages/daily/index.uvue'); await b.flush();
    assert.deepEqual(b.network, [{ name:'latest', args:['wyy', 40, 0] }], 'full production page loads at its public network seam');
    geometry(b, 'song-item', 76);
    const visible = identities(b, 'song-item');
    b.audio.audioPlayer.setGapless(false);
    const pushes = () => b.player.playbackRevision();
    const beforePlay = pushes();
    await b.dispatch(visible[2]); await b.flush();
    assert.equal(b.player.current.id, 'last', 'public row click reaches real PlayerStore playback');
    assert.equal(pushes() - beforePlay, 1, 'one bubbling row click produces exactly one real playback request');
    const beforeMore = pushes();
    await b.dispatch(walk(visible[0]).find(node => node.props['data-qt-tv-id']?.endsWith(':more')));
    assert.equal(pushes(), beforeMore, 'More is isolated from row play');
    await b.dispatch(b.option('加入播放队列'));
    assert.deepEqual(plain(b.player.queue.map(song => song.id)), ['last', 'duplicate'], 'public More selection reaches real queue business once');
    await b.dispatch(walk(visible[1]).find(node => node.props['data-qt-tv-id']?.endsWith(':pick')));
    assert.equal(b.byClass('picker-create').length, 1, 'public heart event opens exactly one real host picker');
    assert.equal(pushes(), beforeMore, 'picker does not bubble to row play');
    await b.dispatch(b.button('取消'));
    const batch = b.byClass('head-batch')[0] ?? b.button('批量');
    await b.dispatch(batch);
    const selecting = b.byClass('lite-row');
    assert.equal(b.byClass('lite-actions').length, 0, 'selection hides single-song actions');
    await b.dispatch(selecting[2]);
    assert.equal(pushes(), beforeMore, 'selection row click does not play');
    assert.match(b.text(), /已选\s*1/, 'one row click selects once rather than toggling twice');
    const finish = b.byClass('qt-batch-bar-btn').find(node => textOf(node) === '取消') ?? b.button('完成');
    await b.dispatch(finish);
    await publicFilterSort(b);
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    geometry(b, 'song-item', 91);
    b.tv.qtSetTvMode('touch'); await b.flush();
    for (const host of rows(b, 'song-item')) assert.equal(b.css(host).height, undefined, 'switching to touch restores original host CSS rather than TV px');
    assert.equal(b.css(b.byClass('lite-row')[0]).height, undefined, 'switching to touch restores original rendered row CSS');
  } finally { await b.close(); }
  await publicSortFocusCase('daily'); await publicSortFocusCase('daily', true);
}

async function playlistCase() {
  const b = await listFixture({ routeOptions:{ id:'owned-playlist', platform:'wyy', type:'playlist', name:'验证歌单' } });
  try {
    await b.mount('pages/playlist/index.uvue'); await b.flush();
    await b.flush();
    assert.equal(b.network[0].name, 'playlist', 'actual playlist mount loads public network tracks');
    geometry(b, 'song-item', 76);
    const visible = identities(b, 'song-item');
    const before = b.player.playbackRevision();
    b.audio.audioPlayer.setGapless(false);
    await b.dispatch(visible[2]);
    assert.equal(b.player.current.id, 'last');
    assert.equal(b.player.playbackRevision() - before, 1, 'playlist single click reaches real play once');
    await publicMoreEnqueue(b, visible[0], 'duplicate'); await publicSelection(b); await publicFilterSort(b);
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); geometry(b, 'song-item', 91);
    b.tv.qtSetTvMode('touch'); await b.flush();
    for (const host of rows(b, 'song-item')) assert.equal(b.css(host).height, undefined);
  } finally { await b.close(); }
  // Sorting is checked with unique response keys too. Task-start duplicate-key
  // reorder behavior is separately reproduced without changing business keys.
  const sorted = await listFixture({ data:[track('unique-first', '第一出现项'), track('unique-second', '第二出现项'), last], routeOptions:{ id:'owned-playlist', platform:'wyy', type:'playlist', name:'验证歌单' } });
  try { await sorted.mount('pages/playlist/index.uvue'); await publicFilterSort(sorted); }
  finally { await sorted.close(); }
  await publicSortFocusCase('playlist'); await publicSortFocusCase('playlist', true);
}
async function searchCase() {
  const calls = [];
  const b = await listFixture({ apiOverrides:{
    allHotWords:async () => [], searchPageMaxOf:() => 30,
    search:async (...args) => { calls.push({ name:'search', args }); return [first, second, last]; },
    searchPlaylists:async () => [{ id:'pl', platform:'wyy', name:'结果歌单', picUrl:'', playCount:'0' }],
    searchArtists:async () => [{ id:'artist', platform:'wyy', name:'结果歌手', picUrl:'' }],
    searchAlbums:async () => [{ id:'album', platform:'wyy', name:'结果专辑', artist:'验证歌手', singer:'验证歌手', picUrl:'' }],
  } });
  const tab = label => b.byClass('seg-item').find(n => textOf(n) === label);
  try {
    await b.mount('pages/search/index.uvue');
    await b.dispatch(b.byClass('input')[0], 'input', { value:'验证搜索' });
    await b.dispatch(b.byClass('input')[0], 'confirm'); await b.flush();
    assert.equal(calls[0].args[0], '验证搜索', 'public native input/confirm reaches actual search flow');
    if (b.byClass('lite-row').length !== 2) console.log('SEARCH SDK settle diagnostics', JSON.stringify({ text:b.text(), calls, warnings:b.warnings, toasts:b.toastCalls }));
    assert.equal(b.byClass('lite-row').length, 2, 'real search deduplicates repeated song keys');
    b.audio.audioPlayer.setGapless(false);
    let before = b.player.playbackRevision();
    await b.dispatch(b.byClass('lite-row')[1]);
    assert.equal(b.player.current.id, 'last');
    assert.equal(b.player.playbackRevision() - before, 1, 'aggregate preview single public click requests play once');
    await b.dispatch(tab('歌曲'));
    before = b.player.playbackRevision();
    await b.dispatch(b.byClass('lite-row')[0]);
    assert.equal(b.player.current.id, 'duplicate');
    assert.equal(b.player.playbackRevision() - before, 1, 'song-result host plus row must not double play one bubbling click');
    await publicMoreEnqueue(b, b.byClass('lite-row')[1], 'last', 0);
    assert.deepEqual(plain(b.player.queue.map(song => song.id)), ['last', 'duplicate'], 'existing search queue member is not re-added');
    geometry(b, 'row-item', 76, 2); identities(b, 'row-item');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); geometry(b, 'row-item', 91, 2);
    await b.dispatch(tab('全部')); geometry(b, 'all-row', 91, 2); identities(b, 'all-row');
    for (const [label, route] of [['歌单', '/pages/playlist/index'], ['歌手', '/pages/artist/index'], ['专辑', '/pages/playlist/index']]) {
      await b.dispatch(tab(label)); const routeCount = b.routes.length;
      await b.dispatch(b.byClass('row-item')[0]);
      assert.equal(b.routes.length - routeCount, 1, 'other result opens exactly once: ' + label);
      assert.ok(b.routes.at(-1).url.startsWith(route), 'original navigation remains: ' + label);
    }
    await b.dispatch(tab('歌曲')); b.tv.qtSetTvMode('touch'); await b.flush();
    for (const host of rows(b, 'row-item')) assert.equal(b.css(host).height, undefined, 'touch keeps original song-host CSS');
    before = b.player.playbackRevision(); await b.dispatch(b.byClass('lite-row')[1]);
    assert.equal(b.player.playbackRevision() - before, 1, 'touch click also plays once');
  } finally { await b.close(); }
}
async function artistCase() {
  const calls = [];
  const b = await listFixture({ routeOptions:{ name:'验证歌手', id:'artist-fixture', platform:'wyy' }, apiOverrides:{
    ensureRegistry:async () => {}, clampSearchPageSize:(_source, size) => size,
    artistSongs:async (...args) => { calls.push(args); return { songs:[first, second, last], picUrl:'', hasMore:false }; },
  } });
  try {
    await b.mount('pages/artist/index.uvue'); await b.flush();
    assert.equal(calls.length, 1, 'artist real paged job has one mounted/show subscription');
    assert.equal(calls[0][0], '验证歌手'); assert.equal(calls[0][4], 'artist-fixture');
    geometry(b, 'song-item', 76, 2); const visible = identities(b, 'song-item');
    b.audio.audioPlayer.setGapless(false); const before = b.player.playbackRevision();
    await b.dispatch(visible[1]); assert.equal(b.player.current.id, 'last');
    assert.equal(b.player.playbackRevision() - before, 1, 'artist public row requests play once');
    await publicMoreEnqueue(b, visible[0], 'duplicate'); await publicSelection(b); await publicFilterSort(b, { count:2, artist:true });
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); geometry(b, 'song-item', 91, 2);
    b.tv.qtSetTvMode('touch'); await b.flush(); for (const host of rows(b, 'song-item')) assert.equal(b.css(host).height, undefined);
  } finally { await b.close(); }
  await publicSortFocusCase('artist');
}
async function localSortFocusCase() {
  const localData = ['A','B','C','D'].map((title, index) => ({ id:'local-' + title, title:title + '本地', singer:'本地歌手', album:'本地专辑', duration:180 + index, uri:'file:///owned/' + title + '.mp3', path:'/owned/' + title + '.mp3' }));
  const bridge = publicFocusBoundary(), b = await listFixture({ ...bridge.options, initialStorage:{ 'qt-local-audio-v1':localData } }); bridge.attach(b);
  const localRows = () => b.byClass('row').filter(n => walk(n).some(child => hasClass(child, 'row-dur')));
  try {
    await b.mount('pages/local/index.uvue'); b.audio.audioPlayer.setGapless(false); assert.equal(localRows().length, 4);
    const focused = localRows().find(n => textOf(n).includes('B本地')), originalId = focused.props['data-qt-tv-id'];
    assert.equal(b.tv.qtTvFocus(originalId), true);
    await b.dispatch(b.byClass('sort-act')[0]); assert.match(textOf(localRows()[0]), /D本地/); b.tv.qtTvRefreshFocus();
    assert.equal(b.tv.qtTvFocusedId(), originalId, 'pair column/position changes keep the original local song focused');
    assert.match(textOf(walk(b.root).find(n => n.props['data-qt-tv-id'] === originalId)), /B本地/);
    const before = b.player.playbackRevision(); await bridge.ok(); assert.equal(b.player.current.name, 'B本地'); assert.equal(b.player.playbackRevision() - before, 1);
  } finally { await b.close(); }
}
async function localCase() {
  const localData = [
    { id:'local-a', title:'A本地', singer:'本地歌手', album:'本地专辑', duration:180, uri:'file:///owned/A.mp3', path:'/owned/A.mp3' },
    { id:'local-b', title:'B本地', singer:'本地歌手', album:'本地专辑', duration:181, uri:'file:///owned/B.mp3', path:'/owned/B.mp3' },
    { id:'local-c', title:'C本地', singer:'另一歌手', album:'另一专辑', duration:182, uri:'file:///owned/C.mp3', path:'/owned/C.mp3' },
  ];
  const b = await listFixture({ initialStorage:{ 'qt-local-audio-v1':localData } });
  const localRows = () => b.byClass('row').filter(n => walk(n).some(child => hasClass(child, 'row-dur')));
  const localGeometry = (px, count) => {
    assert.equal(localRows().length, 3, 'real stored LocalAudioItem input renders all songs');
    assert.equal(b.byClass('litem').length, count, 'original two-column policy determines native occupancy');
    for (const host of b.byClass('litem')) assert.equal(b.css(host).height, px + 'px', 'local native host height matches TV row');
    for (const row of localRows()) assert.equal(b.css(row).height, px + 'px');
  };
  const localIdentity = () => {
    const ids = localRows().map(n => n.props['data-qt-tv-id']);
    assert.ok(ids.every(id => typeof id === 'string' && id.length > 0), 'local host supplies occurrence IDs');
    assert.equal(new Set(ids).size, ids.length); return ids;
  };
  try {
    await b.mount('pages/local/index.uvue'); localGeometry(76, 2); localIdentity();
    b.audio.audioPlayer.setGapless(false); let before = b.player.playbackRevision();
    await b.dispatch(localRows()[1]); assert.equal(b.player.current.id, 'local-b');
    assert.equal(b.player.playbackRevision() - before, 1, 'local row maps to real Song once');
    before = b.player.playbackRevision(); await b.dispatch(walk(localRows()[0]).find(n => hasClass(n, 'row-more')));
    assert.equal(b.player.playbackRevision(), before, 'local More stops native bubbling');
    await b.dispatch(b.option('播放')); assert.equal(b.player.current.id, 'local-a');
    assert.equal(b.player.playbackRevision() - before, 1, 'local More action reaches real play once');
    await b.dispatch(b.byClass('sort-act')[0]); assert.match(textOf(localRows()[0]), /C本地/, 'public sort reverses existing list'); localIdentity();
    await b.dispatch(b.byClass('seg-item').find(n => textOf(n) === '歌手')); assert.equal(localRows().length, 3); localIdentity();
    await b.dispatch(b.byClass('seg-item').find(n => textOf(n) === '歌曲'));
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); localGeometry(91, 2);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.byClass('litem').length, 2, 'touch wide keeps original paired native cells');
    for (const host of b.byClass('litem')) assert.equal(b.css(host).height, undefined);
    for (const row of localRows()) assert.equal(b.css(row).height, undefined);
    b.setWindow({ windowWidth:390, windowHeight:844 }); await b.clock.runTimers(1000); await b.flush();
    assert.equal(b.byClass('litem').length, 3, 'same mounted touch native snapshot responds through real layout watcher');
  } finally { await b.close(); }
  await localSortFocusCase();
}
async function recommendFixture(data = [first, second, last], options = {}) {
  const date = new Date(); const day = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  const cached = { date:day, mode:'rule', requested:'rule', taste:'heart', generatedAt:1000000,
    title:'缓存推荐', summary:'真实缓存读取', items:data.map(song => ({ song, reason:'已有缓存条目' })),
    notice:null, profileText:null, model:null, styleLanes:[], coldStart:false, styleOptions:[], styleSeeds:[] };
  return listFixture({ ...options, initialStorage:{ ...options.initialStorage, 'dailyRecommend.cache':JSON.stringify({ v:10, days:[], today:cached }) }, boundaryOverrides:{ 'services/music-api':undefined, ...options.boundaryOverrides } });
}
async function recommendCase() {
  const b = await recommendFixture();
  try {
    await b.mount('pages/daily-recommend/index.uvue'); await b.flush();
    assert.ok(b.text().includes('缓存推荐'), 'real loadTodayResult accepts persisted current-day rule cache');
    geometry(b, 'rc-item', 76); const visible = identities(b, 'rc-item');
    b.audio.audioPlayer.setGapless(false); const before = b.player.playbackRevision();
    await b.dispatch(visible[2]); assert.equal(b.player.current.id, 'last');
    assert.equal(b.player.playbackRevision() - before, 1, 'recommendation row plays real cached song once');
    await publicMoreEnqueue(b, visible[0], 'duplicate'); await publicSelection(b); await publicFilterSort(b, { outerClass:'rc-item' });
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); geometry(b, 'rc-item', 91);
    b.tv.qtSetTvMode('touch'); await b.flush(); for (const host of rows(b, 'rc-item')) assert.equal(b.css(host).height, undefined);
  } finally { await b.close(); }
  const sorted = await recommendFixture([track('unique-first', '第一出现项'), track('unique-second', '第二出现项'), last]);
  try { await sorted.mount('pages/daily-recommend/index.uvue'); await publicFilterSort(sorted, { outerClass:'rc-item' }); }
  finally { await sorted.close(); }
  await publicSortFocusCase('daily-recommend');
}
async function radioCase() {
  const supply = Array.from({ length:8 }, (_, i) => ({ ...track('fm-' + i, 'FM歌曲' + i), singer:'FM歌手' + i }));
  const history = JSON.stringify([...supply, supply[0]].map(song => JSON.stringify(song)));
  const b = await listFixture({ initialStorage:{ 'qt-history-songs':history }, boundaryOverrides:{ 'services/music-api':undefined } });
  try {
    b.player.restore(); await b.mount('pages/radio/index.uvue'); b.audio.audioPlayer.setGapless(false);
    assert.equal(b.player.history.length, 9, 'real player restores persisted preference data including duplicated song');
    await b.dispatch(b.byClass('hero-btn').find(n => textOf(n).includes('开始收听'))); await b.flush();
    assert.equal(b.player.radioActive, true, 'public start uses real radio engine and claims player queue');
    assert.equal(new Set(b.player.queue.map(song => song.platform + ':' + song.id)).size, b.player.queue.length, 'real FM engine retains hard deduplication');
    const moreBefore = b.player.playbackRevision();
    await b.dispatch(walk(identities(b, 'song-item')[0]).find(n => n.props['data-qt-tv-id']?.endsWith(':more')));
    assert.equal(b.player.playbackRevision(), moreBefore, 'FM More keeps current queue ownership and does not play');
    await b.dispatch(b.byClass('as-cancel').at(-1));
    geometry(b, 'song-item', 76, 5); identities(b, 'song-item');
    const targetId = b.player.queue[b.player.currentIndex() + 2].id, before = b.player.playbackRevision();
    await b.dispatch(identities(b, 'song-item')[1]); assert.equal(b.player.current.id, targetId);
    assert.equal(b.player.playbackRevision() - before, 1, 'public upcoming row plays within actual FM queue once');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); geometry(b, 'song-item', 91, rows(b, 'song-item').length);
    b.tv.qtSetTvMode('touch'); await b.flush(); for (const host of rows(b, 'song-item')) assert.equal(b.css(host).height, undefined);
    await b.dispatch(b.byClass('hero-btn').find(n => textOf(n).includes('停止'))); assert.equal(b.player.radioActive, false);
    assert.equal(rows(b, 'song-item').length, 0, 'public stop leaves FM view and restores pre-session queue');
  } finally { await b.close(); }
}
async function aiCase() {
  const candidates = [first, second, last].map(song => ({ sourceId:song.platform, songId:song.id, name:song.name, artist:song.singer, album:song.album, duration:180, coverUrl:song.picUrl, quality:'320' }));
  const history = { convs:[{ id:101, title:'缓存对话', updatedAt:1000000, turns:[
    { role:'ASSISTANT', content:'第一回复', status:'COMPLETED', createTime:'', candidates },
    { role:'ASSISTANT', content:'重复候选回复', status:'COMPLETED', createTime:'', candidates:[candidates[0]] } ] }] };
  const b = await listFixture({ initialStorage:{ 'qt-ai-assistant.local':JSON.stringify(history) }, boundaryOverrides:{ 'services/music-api':undefined } });
  try {
    await b.mount('pages/ai-assistant/index.uvue'); assert.equal(b.byClass('lite-row').length, 0);
    await b.dispatch(b.byClass('icon-btn')[0], 'tap'); await b.dispatch(b.option('缓存对话'));
    assert.equal(b.byClass('lite-row').length, 4, 'public history choice loads complete real message/block/candidate parser');
    const ids = b.byClass('lite-row').map(n => n.props['data-qt-tv-id']);
    assert.ok(ids.every(id => typeof id === 'string' && id.length > 0), 'AI host supplies message/block/song occurrence identity');
    assert.equal(new Set(ids).size, 4, 'duplicated business songs across replies retain distinct focus identity');
    for (const row of b.byClass('lite-row')) assert.equal(b.css(row).height, '76px');
    b.audio.audioPlayer.setGapless(false); const before = b.player.playbackRevision();
    await b.dispatch(b.byClass('lite-row')[2]); assert.equal(b.player.current.id, 'last'); assert.equal(b.player.playbackRevision() - before, 1);
    await publicMoreEnqueue(b, b.byClass('lite-row')[0], 'duplicate');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); for (const row of b.byClass('lite-row')) assert.equal(b.css(row).height, '91px');
    b.tv.qtSetTvMode('touch'); await b.flush(); for (const row of b.byClass('lite-row')) assert.equal(b.css(row).height, undefined);
    const touchBefore = b.player.playbackRevision(); await b.dispatch(b.byClass('lite-row')[0]); assert.equal(b.player.playbackRevision() - touchBefore, 1);
  } finally { await b.close(); }
}
const cases = { daily:dailyCase, playlist:playlistCase, search:searchCase, artist:artistCase, local:localCase, recommend:recommendCase, radio:radioCase, ai:aiCase };
export async function runTvListHostsChecks(selected = 'all') {
  const names = selected === 'all' ? Object.keys(cases) : [selected];
  for (const name of names) { assert.ok(cases[name], 'known host case'); await cases[name](); console.log('PASS tv-list-hosts ' + name); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL('file:' + process.argv[1].replaceAll('\\', '/')))) {
  await runTvListHostsChecks(process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'all');
}
