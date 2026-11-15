// Approved seam: full production UVue templates mounted with the Vue renderer.
// Public clicks flow through real QtButton/QtOption and real setting services.
// Owned boundaries: uni storage/window/measurements/lifecycle/clock, account data,
// the audio native bridge, and tv-platform. No page handler is exported or called.
// Offline template/service behavior only; Native Yoga, IME and remote hardware are separate gates.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as Vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const UI = 'uni_modules/qt-ui/';
const OVERVIEW = UI + 'components/qt-settings-overview/qt-settings-overview.uvue';
const raw = path => readFileSync(resolve(ROOT, path), 'utf8').replaceAll('\r\n', '\n');
const plain = value => JSON.parse(JSON.stringify(value));
const noop = () => {};
const unexpected = name => () => { throw new Error('unexpected fixture boundary: ' + name); };
// SDK dictionary boundary used by complete business modules, not extracted methods.
class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  set(key, value) { this[key] = value; }
  get(key) { return this[key] ?? null; }
  static keys(value) { return Object.keys(value); }
}
function platformSource(text, platform) {
  const symbols = new Set([platform, 'APP']);
  const stack = [], lines = [];
  let enabled = true;
  for (const line of text.split('\n')) {
    const directive = line.match(/^\s*(?:\/\/|<!--)\s*#(ifdef|ifndef|else|endif)\s*(.*?)\s*(?:-->)?\s*$/);
    if (!directive) { if (enabled) lines.push(line); continue; }
    const [, kind, expression] = directive;
    if (kind === 'ifdef' || kind === 'ifndef') {
      const matches = expression.split(/\|\|/).some(symbol => symbols.has(symbol.trim()));
      stack.push({ parent: enabled, matches: kind === 'ifdef' ? matches : !matches });
      enabled = enabled && stack.at(-1).matches;
    } else {
      const frame = stack.at(-1);
      assert.ok(frame, 'balanced SDK platform directives');
      if (kind === 'else') enabled = frame.parent && !frame.matches;
      else { stack.pop(); enabled = frame.parent; }
    }
  }
  assert.equal(stack.length, 0, 'balanced SDK platform directives');
  return lines.join('\n');
}
function nativeNode(tag, text = '') {
  return { tag, tagName: tag.toUpperCase(), text, props: {}, children: [], parent: null, listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== fn); },
    dispatchEvent(event) { for (const fn of this.listeners[event.type] ?? []) fn(event); },
  };
}
function detach(node) {
  if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
  node.parent = null;
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const classes = node => String(node.props.class ?? '').split(/\s+/);
const byClass = (root, name) => descendants(root).filter(node => classes(node).includes(name));
const textOf = node => node.text + node.children.map(textOf).join('');
function css(node) {
  const style = Vue.normalizeStyle(node.props.style);
  if (typeof style !== 'string') return style ?? {};
  return Object.fromEntries(style.split(';').filter(value => value.includes(':')).map(value => {
    const colon = value.indexOf(':'); return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
  }));
}
const renderer = Vue.createRenderer({
  createElement: tag => nativeNode(tag), createText: text => nativeNode('#text', text),
  createComment: text => nativeNode('#comment', text),
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.text = text; node.children = []; },
  insert(node, parent, before = null) {
    detach(node); const at = before ? parent.children.indexOf(before) : -1;
    if (at < 0) parent.children.push(node); else parent.children.splice(at, 0, node);
    node.parent = parent;
  },
  remove: detach, parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp(node, key, _old, value) { node.props[key] = value; if (key === 'value') node.value = value; },
});
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); await Vue.nextTick(); }
function cell(root, title) {
  return byClass(root, 'cell').find(row => byClass(row, 'cell-title').some(node => textOf(node) === title));
}
function option(root, label) {
  return byClass(root, 'qo').find(row => byClass(row, 'qo-label').some(node => textOf(node) === label));
}
function button(root, label) {
  return byClass(root, 'qt-button').find(row => byClass(row, 'qt-button-label').some(node => textOf(node) === label));
}

export async function tvSettingsFixture({ width = 375, height = 800, television = false,
  nativeAvailable = false, savedMode = '', platform = 'APP-ANDROID', initialStorage = {}, boundaryOverrides = {}, realFrame = false } = {}) {
  const root = nativeNode('fixture-root'), cache = new Map(), storage = new Map(Object.entries(initialStorage));
  if (savedMode.length > 0) storage.set('qt-tv-presentation', savedMode);
  const storageWrites = [], nativeCalls = [], routes = [], toastCalls = [], permissions = [], warnings = [];
  const lifecycle = { load: [], show: [], hide: [], unload: [], backPress: [], resize: [] }, timers = new Map(), measurements = [];
  let serial = 0, clockNow = 1000000;
  const delayMs = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  function addTimer(fn, value = 0, repeat = false) {
    const delay = repeat ? Math.max(1, delayMs(value)) : delayMs(value), id = ++serial;
    timers.set(id, { fn, delay, repeat, due: clockNow + delay }); return id;
  }
  const clock = {
    now: () => clockNow,
    // advance changes Date.now only; callbacks wait until runTimers is explicitly awaited.
    advance(ms) { assert.ok(Number.isFinite(ms) && ms >= 0, 'clock advances by finite nonnegative milliseconds'); clockNow += ms; return clockNow; },
    intervalCount: delay => [...timers.values()].filter(timer => timer.repeat && (delay == null || timer.delay === delay)).length,
    timeoutCount: delay => [...timers.values()].filter(timer => !timer.repeat && (delay == null || timer.delay === delay)).length,
    // runTimers moves through due callbacks up to now+ms, including overdue timers, and flushes Vue.
    // A hard callback budget and minimum interval delay avoid a zero-delay hanging loop.
    async runTimers(ms = 0) {
      assert.ok(Number.isFinite(ms) && ms >= 0, 'timer horizon is finite and nonnegative');
      const end = clockNow + ms; let executed = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (next == null) break;
        assert.ok(++executed <= 10000, 'bounded SDK timer callbacks');
        const [id, timer] = next; clockNow = Math.max(clockNow, timer.due);
        if (timer.repeat) timer.due = clockNow + timer.delay; else timers.delete(id);
        await timer.fn(); await flush();
      }
      clockNow = end; await flush(); return executed;
    },
  };
  const device = { television, leanback: false, uiModeType: television ? 4 : 1, nativeAvailable }, audioBoundary = { dlna: false, overlayPermission: true };
  const viewport = { windowWidth: width, windowHeight: height, screenWidth: width, screenHeight: height,
    screenTop: 0, windowTop: 0, statusBarHeight: 0, safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 } };
  const uni = {
    env: { USER_DATA_PATH: 'unifile://usr' },
    getWindowInfo: () => viewport, getSystemInfoSync: () => ({ ...viewport, osTheme: 'light', platform: 'android' }),
    getStorageSync: key => storage.get(key) ?? null,
    setStorageSync(key, value) { storage.set(key, value); storageWrites.push([key, value]); },
    removeStorageSync: key => storage.delete(key), onWindowResize: noop, offWindowResize: noop,
    onThemeChange: noop, setAppTheme: noop, setTabBarStyle: noop, $on: noop, $off: noop, $emit: noop,
    navigateTo: value => routes.push({ action: 'navigate', ...value }),
    redirectTo: value => routes.push({ action: 'redirect', ...value }), navigateBack: value => routes.push({ action: 'back', ...value }),
    createSelectorQuery() {
      let selector = ''; const requests = [];
      return { select(value) { selector = value; return this; },
        boundingClientRect(fn) { requests.push([selector, fn]); return this; },
        exec(fn) { measurements.push(() => {
          const values = requests.map(([query, reply]) => {
            const found = query.startsWith('.') ? byClass(root, query.slice(1))[0]
              : descendants(root).find(node => node.props.id === query.slice(1));
            const rectangle = found ? { left: 20, top: 40, width: 300, height: 100, bottom: 140, right: 320 } : null;
            reply?.(rectangle); return rectangle;
          }); fn?.(values);
        }); },
      };
    },
    getFileSystemManager: unexpected('filesystem'),
  };
  const native = new Proxy({}, { get(_target, name) {
    if (name === 'audioDlnaActive') return () => audioBoundary.dlna;
    if (name === 'audioEffectsSupported') return () => true;
    if (name === 'audioLyricHasOverlayPermission') return () => audioBoundary.overlayPermission;
    if (name === 'audioLyricRequestOverlayPermission') return () => { permissions.push('overlay'); return true; };
    if (name === 'audioLyricIsShowing') return () => false;
    return (...args) => { nativeCalls.push({ name: String(name), args }); return true; };
  } });
  const unrelatedPlayer = Vue.reactive({ sleepStopAfterCurrent: false, sleepEndTime: 0, sleepRequestedMinutes: 0,
    setSleep: unexpected('sleep is not selected in settings-mode'), refreshCarLyric: noop });
  const overrides = {
    'services/tv-platform': { tvReadDevice: () => device,
      tvStartRemote: noop, tvSetRemoteState: noop, tvStopRemote: noop, tvCollect: () => [], tvHighlight: noop,
      tvActivate: unexpected('native activation'), tvScroll: () => false, tvPresent: noop, tvBack: noop },
    'services/app-native': { supportsHomeBackMode: () => true, isHarmonyOs: () => platform === 'APP-HARMONY' },
    'services/logger': { logWarn: noop, logWarnV: noop, logErrV: noop, logInfo: noop, logMsgErr: noop,
      logSupported: () => false, logBytes: async () => 0 },
    'services/diag': { qtDiag: noop },
    'services/toast': { qtShowToast: value => toastCalls.push(value) },
    'services/confirm': { qtConfirm: unexpected('confirmation is not selected') },
    'services/media': { chooseImage: unexpected('gallery is not selected') },
    'services/music-api': { isQtAdmin: () => false, musicApi: {} },
    'services/platform': { platformLabel: value => value },
    'services/source-sheet': { SOURCE_SHEET_TITLE_DEFAULT: '默认音源', showSourceSheet: unexpected('source sheet is not selected') },
    'services/source-auth': { readSourceAuthEntries: () => [] },
    'services/ai-mode': { readAiMode: () => 'rule', AI_MODE_LABEL_RULE: '规则推荐', AI_MODE_LABEL_LOCAL: '本地', AI_MODE_LABEL_SERVER: '服务端' },
    'services/ai-providers': { readProviders: () => ({ profiles: [] }), activeProfile: () => null, activeModelOf: () => '' },
    'services/upgrade': { formatFileSize: value => String(value) },
    'stores/player': { usePlayerStore: () => unrelatedPlayer },
    'stores/downloads': { useDownloadsStore: () => Vue.reactive({ restore: noop, concurrency: 3, downloadCover: true, downloadLyric: false }) },
    'stores/dislikes': { useDislikesStore: () => ({ rules: [] }) },
    'stores/source': { useSourceStore: () => Vue.reactive({ restore: noop, current: 'local' }) },
    'stores/source-registry': { useSourceRegistryStore: () => ({ ensure: async () => {} }) },
    'stores/source-update': { useSourceUpdateStore: () => Vue.reactive({ refresh: noop, updatePending: false }) },
    'stores/player-bar': { PLAYER_BAR_MAX_VISIBLE: 4, playerBarCounted: () => true,
      usePlayerBarStore: () => ({ countVisible: () => 0, restore: noop }) },
    'uni_modules/qt-stat': { qtTrackPage: noop },
  };
  Object.assign(overrides, boundaryOverrides);
  const fixtureVue = { ...Vue };
  // Native input model delivery is an owned SDK boundary, not browser DOM behavior.
  fixtureVue.vModelText = { created(node, binding, vnode) {
    node.value = binding.value;
    node.addEventListener('input', event => vnode.props['onUpdate:modelValue']?.(event.detail?.value ?? node.value));
  }, beforeUpdate(node, binding) { node.value = binding.value; } };
  const context = { console, uni, UTSJSONObject, Date: class extends Date { static now() { return clockNow; } },
    getCurrentPages: () => [{ route: 'pages/settings/index' }],
    setTimeout: (fn, delay = 0) => addTimer(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => addTimer(fn, delay, true), clearInterval: id => timers.delete(id),
  };
  function load(request, from = resolve(ROOT, 'fixture.ts')) {
    if (request === 'vue') return fixtureVue;
    if (request === '@dcloudio/uni-app') return Object.fromEntries(Object.entries(lifecycle).map(([key, callbacks]) => ['on' + key[0].toUpperCase() + key.slice(1), fn => callbacks.push(fn)]));
    if (request === '@/uni_modules/qt-audio-player') return native;
    let path = request.startsWith('@/') ? resolve(ROOT, request.slice(2)) : request.startsWith('.') ? resolve(dirname(from), request) : resolve(ROOT, request);
    const key = relative(ROOT, path).replaceAll('\\', '/').replace(/\.(ts|uts|uvue)$/, '');
    if (overrides[key]) return overrides[key];
    if (!existsSync(path)) path = ['.ts', '.uts', '.uvue'].map(ext => path + ext).find(existsSync) ?? path;
    if (cache.has(path)) return cache.get(path).exports;
    const text = platformSource(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'), platform);
    let program = text;
    if (path.endsWith('.uvue')) {
      const custom = tag => ['view', 'text', 'image', 'scroll-view', 'input', 'slider'].includes(tag);
      const { descriptor, errors } = parse(text, { filename: path, templateParseOptions: { isCustomElement: custom } });
      assert.deepEqual(errors, [], 'complete production SFC parses: ' + relative(ROOT, path));
      program = compileScript(descriptor, { id: key, inlineTemplate: true,
        templateOptions: { compilerOptions: { isCustomElement: custom } } }).content;
    }
    const output = ts.transpileModule(program, { fileName: path.replace(/\.(uts|uvue)$/, '.ts'), compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } });
    const module = { exports: {} }; cache.set(path, module);
    vm.runInNewContext(output.outputText, { ...context, exports: module.exports, module,
      require: value => load(value, path) }, { filename: path });
    return module.exports;
  }
  const tv = load(UI + 'composables/use-qt-tv.ts');
  tv.qtInitTv();
  const audio = load('services/audio-player.uts');
  const theme = load(UI + 'stores/theme.ts');
  const fonts = load(UI + 'stores/font-scale.ts');
  const action = load('services/action-sheet.ts');
  const ActionHost = load(UI + 'components/qt-action-sheet-host/qt-action-sheet-host.uvue').default;
  const Frame = Vue.defineComponent({ inheritAttrs: false, setup(_props, { slots }) {
    return () => Vue.h('view', { class: 'fixture-frame' }, [slots.default?.(), Vue.h(ActionHost)]);
  } });
  if (!realFrame) overrides[UI + 'components/qt-page-frame/qt-page-frame'] = { __esModule: true, default: Frame };
  let app = null;
  async function mount(path = OVERVIEW, props = {}, withActionHost = path === OVERVIEW) {
    const Component = load(path).default;
    app = renderer.createApp({ setup: () => () => Vue.h('view', {}, [Vue.h(Component, props), withActionHost ? Vue.h(ActionHost) : null]) });
    app.config.warnHandler = message => warnings.push(message);
    app.mount(root); await flush();
  }
  async function dispatch(target, type = 'click', detail = {}) {
    assert.ok(target, 'user-visible target exists');
    let stopped = false;
    const event = { type, detail, target, currentTarget: target,
      stopPropagation() { stopped = true; }, preventDefault: noop, ...detail };
    for (let node = target; node && !stopped; node = node.parent) {
      event.currentTarget = node;
      const handler = node.props['on' + type[0].toUpperCase() + type.slice(1)];
      if (Array.isArray(handler)) handler.forEach(fn => fn(event)); else handler?.(event);
      for (const fn of node.listeners[type] ?? []) fn(event);
    }
    await flush();
  }
  async function close() { app?.unmount(); tv.qtDisposeTv(); timers.clear(); await flush(); }
  return { root, mount, dispatch, close, flush, tv, audio, theme, fonts, action, load, storage, storageWrites,
    nativeCalls, routes, toastCalls, permissions, device, audioBoundary, warnings, lifecycle, measurements, clock,
    byClass: name => byClass(root, name), text: () => textOf(root), cell: title => cell(root, title),
    option: label => option(root, label), button: label => button(root, label), css, plain,
  };
}

async function settingsModeCase() {
  const b = await tvSettingsFixture();
  try {
    await b.mount();
    assert.equal(b.tv.useQtTv().enabled, false, 'automatic phone detection retains the touch presentation');
    const title = '电视/遥控器展示设置';
    const row = b.cell(title);
    assert.ok(row, 'settings overview exposes television/remote display settings');
    assert.ok(textOf(row).includes('自动（识别为触控）'), 'automatic summary distinguishes phone detection');
    assert.ok(textOf(row).includes('原生遥控') && textOf(row).includes('展示'), 'presentation and native remote support are explained separately');
    await b.dispatch(row);
    assert.deepEqual(plain(b.action.qtActionSheetState().items.value), ['自动', '电视', '触控']);
    assert.equal(b.action.qtActionSheetState().selectedIndex.value, 0, 'shared sheet selects automatic mode');
    await b.dispatch(b.option('电视'));
    assert.equal(b.tv.useQtTv().mode, 'tv');
    assert.equal(b.tv.useQtTv().enabled, true, 'real public mode service enables TV presentation');
    assert.equal(b.storage.get('qt-tv-presentation'), 'tv', 'real service persists the selected mode');
    assert.ok(textOf(b.cell(title)).includes('电视'));
    await b.dispatch(b.cell(title));
    assert.equal(b.action.qtActionSheetState().selectedIndex.value, 1);
    await b.dispatch(b.option('触控'));
    assert.equal(b.tv.useQtTv().enabled, false, 'touch restores phone presentation');
    assert.equal(b.tv.useQtTv().mode, 'touch');
    await b.dispatch(b.cell(title));
    await b.dispatch(b.option('自动'));
    assert.equal(b.tv.useQtTv().enabled, false, 'automatic does not turn a phone into a TV');
    b.device.television = true;
    b.device.nativeAvailable = true;
    b.tv.qtSetTvForeground(true); await b.flush();
    assert.equal(b.tv.useQtTv().enabled, true, 'automatic presentation follows real device boundary');
    assert.ok(textOf(b.cell(title)).includes('自动（识别为电视）'));
    assert.ok(textOf(b.cell(title)).includes('已就绪'), 'native support text follows the actual public availability flag');
    await b.dispatch(b.cell(title));
    await b.dispatch(b.byClass('as-cancel')[0]);
    assert.equal(b.tv.useQtTv().mode, 'auto', 'cancel preserves mode');
    assert.equal(b.permissions.length, 0, 'display selection does not change permissions');
    assert.equal(b.routes.length, 0, 'the entry uses the shared sheet, not a duplicate route');
  } finally { await b.close(); }
}

async function equalizerControlsCase() {
  const frequencies = ['60Hz', '230Hz', '910Hz', '3.6kHz', '14kHz'];
  const band = (b, label) => b.byClass('band-row').find(row => byClass(row, 'band-label').some(node => textOf(node) === label));
  const readout = (b, label) => textOf(byClass(band(b, label), 'band-value')[0]);
  const writeCount = b => b.nativeCalls.filter(call => call.name === 'audioSetEqualizerBands').length;
  const b = await tvSettingsFixture({ width: 1920, height: 1080, television: true });
  try {
    await b.mount('pages/equalizer/index.uvue');
    assert.ok(button(band(b, frequencies[0]), '减少'), 'TV equalizer exposes an explicit decrease action instead of native slider focus');
    assert.equal(descendants(b.root).filter(node => node.tag === 'slider').length, 0, 'TV has no native slider pretending to be generic remote focus');
    assert.equal(b.byClass('band-row').length, 5, 'all five frequencies stay in the vertical scroll container');
    assert.equal(b.byClass('list')[0].props.direction, 'vertical', 'the accepted phone/tablet scroll structure survives');
    for (let i = 0; i < frequencies.length; i++) {
      const label = frequencies[i], row = band(b, label);
      assert.ok(button(row, '增加'), 'TV exposes an explicit increase action for ' + label);
      assert.equal(readout(b, label), '0 dB');
      const before = writeCount(b);
      await b.dispatch(button(row, '增加'));
      const expected = [0, 0, 0, 0, 0]; expected[i] = 1;
      assert.deepEqual(plain(b.audio.audioPlayer.eqBands), expected, 'public audio values follow one real button activation');
      assert.equal(writeCount(b), before + 1, 'one activation applies the five-band curve once');
      assert.equal(b.audio.audioPlayer.eqEnabled, false, 'numeric adjustment never implicitly enables EQ');
      assert.equal(readout(b, label), '+1 dB');
      await b.dispatch(button(band(b, label), '减少'));
      assert.deepEqual(plain(b.audio.audioPlayer.eqBands), [0, 0, 0, 0, 0]);
    }
    for (let i = 0; i < 15; i++) await b.dispatch(button(band(b, frequencies[0]), '增加'));
    assert.equal(readout(b, frequencies[0]), '+12 dB', 'remote actions clamp at the positive endpoint');
    assert.equal(b.audio.audioPlayer.eqBands[0], 12);
    const topCount = writeCount(b);
    await b.dispatch(button(band(b, frequencies[0]), '增加'));
    assert.equal(writeCount(b), topCount, 'disabled upper endpoint has no native apply');
    for (let i = 0; i < 26; i++) await b.dispatch(button(band(b, frequencies[0]), '减少'));
    assert.equal(readout(b, frequencies[0]), '-12 dB', 'remote actions clamp at the negative endpoint');
    assert.equal(b.storage.get('qt-eq-bands'), '-12,0,0,0,0');
    const bottomCount = writeCount(b);
    await b.dispatch(button(band(b, frequencies[0]), '减少'));
    assert.equal(writeCount(b), bottomCount, 'disabled lower endpoint has no native apply');
    await b.dispatch(b.option('流行'));
    assert.deepEqual(plain(b.audio.audioPlayer.eqBands), [-1, 2, 4, 2, -1], 'the established preset remains a real public option');
    await b.dispatch(b.byClass('qsw')[0]);
    assert.equal(b.audio.audioPlayer.eqEnabled, true);
    const enabledCount = writeCount(b);
    await b.dispatch(button(band(b, frequencies[4]), '增加'));
    assert.deepEqual(plain(b.audio.audioPlayer.eqBands), [-1, 2, 4, 2, 0]);
    assert.equal(writeCount(b), enabledCount + 1, 'enabled EQ also applies the changed curve once');
    b.audioBoundary.dlna = true;
    const beforeDisabled = writeCount(b), oldBands = plain(b.audio.audioPlayer.eqBands);
    await b.dispatch(button(band(b, frequencies[4]), '减少'));
    assert.deepEqual(plain(b.audio.audioPlayer.eqBands), oldBands, 'live audio capability recheck guards a stale visible action');
    assert.equal(writeCount(b), beforeDisabled);
    for (const label of frequencies) {
      assert.ok(classes(button(band(b, label), '减少')).includes('qt-button-disabled'), 'unsupported audio disables TV decrease');
      assert.ok(classes(button(band(b, label), '增加')).includes('qt-button-disabled'), 'unsupported audio disables TV increase');
    }
    assert.equal(b.permissions.length, 0);
  } finally { await b.close(); }
  const phone = await tvSettingsFixture();
  try {
    await phone.mount('pages/equalizer/index.uvue');
    const sliders = descendants(phone.root).filter(node => node.tag === 'slider');
    assert.equal(sliders.length, 5, 'automatic phone mode retains all five native sliders');
    assert.equal(phone.button('增加'), undefined, 'phone does not receive duplicate TV numeric controls');
    assert.equal(sliders[0].props.min, -12); assert.equal(sliders[0].props.max, 12); assert.equal(sliders[0].props.step, 1);
    const before = writeCount(phone);
    await phone.dispatch(sliders[0], 'change', { value: 4 });
    assert.deepEqual(plain(phone.audio.audioPlayer.eqBands), [4, 0, 0, 0, 0], 'native phone change still reaches the real business service');
    assert.equal(writeCount(phone), before + 1);
    assert.equal(phone.audio.audioPlayer.eqEnabled, false);
    phone.audioBoundary.dlna = true;
    await phone.dispatch(sliders[0], 'change', { value: -8 });
    assert.deepEqual(plain(phone.audio.audioPlayer.eqBands), [4, 0, 0, 0, 0], 'phone keeps the same audio capability guard');
  } finally { await phone.close(); }
}

async function themeControlsCase() {
  const block = (b, caption) => b.byClass('picker-block').find(row => byClass(row, 'picker-caption').some(node => textOf(node) === caption));
  const readout = (b, caption) => textOf(byClass(block(b, caption), 'picker-value')[0]);
  const field = (b, label) => b.byClass('custom-row').find(row => byClass(row, 'custom-label').some(node => textOf(node) === label));
  const hex = b => textOf(b.byClass('picker-hex')[0]);
  const show = async b => { b.lifecycle.show.forEach(fn => fn()); await b.flush(); };
  const typeHex = async (b, value) => {
    const input = b.byClass('picker-input')[0];
    await b.dispatch(input, 'input', { value }); await b.dispatch(input, 'confirm');
  };
  const segment = async (b, caption, index) => b.dispatch(byClass(block(b, caption), 'picker-seg')[index]);
  const disabledEndpoint = async (b, caption, label, expected) => {
    const target = button(block(b, caption), label), previousHex = hex(b), writes = b.storageWrites.length;
    assert.ok(classes(target).includes('qt-button-disabled'), 'TV endpoint is explicitly disabled: ' + caption + ' ' + label);
    await b.dispatch(target);
    assert.equal(readout(b, caption), expected, 'disabled endpoint keeps the displayed value');
    assert.equal(hex(b), previousHex, 'disabled endpoint leaves the preview unchanged');
    assert.equal(b.storageWrites.length, writes, 'disabled endpoint never commits a theme');
  };
  const b = await tvSettingsFixture({ width: 1920, height: 1080, television: true });
  try {
    await b.mount('pages/theme/index.uvue'); await show(b);
    await b.dispatch(field(b, '强调色'));
    assert.ok(button(block(b, '色相'), '减少'), 'TV theme picker exposes explicit decrease actions instead of native slider focus');
    assert.equal(descendants(b.root).filter(node => node.tag === 'slider').length, 0, 'TV theme picker replaces all three native sliders');
    for (const caption of ['色相', '饱和度', '明度']) {
      assert.ok(button(block(b, caption), '增加'), 'TV theme picker exposes an explicit increase for ' + caption);
      assert.ok(button(block(b, caption), '减少'), 'TV theme picker exposes an explicit decrease for ' + caption);
    }
    await typeHex(b, '#00aaff');
    assert.equal(hex(b), '#00aaff');
    assert.deepEqual(['色相', '饱和度', '明度'].map(caption => readout(b, caption)), ['200°', '100%', '100%']);
    const beforeAdjust = b.storageWrites.length, originalAccent = b.theme.useThemeStore().skin.accent;
    await b.dispatch(button(block(b, '色相'), '减少'));
    assert.equal(readout(b, '色相'), '199°', 'one real activation changes hue by exactly one unit');
    assert.equal(hex(b), '#00aeff', 'numeric hue changes the actual preview through the established HSV path');
    await b.dispatch(button(block(b, '色相'), '增加'));
    assert.equal(readout(b, '色相'), '200°'); assert.equal(hex(b), '#00aaff');
    await b.dispatch(button(block(b, '饱和度'), '减少'));
    assert.equal(readout(b, '饱和度'), '99%'); assert.equal(hex(b), '#03abff');
    await b.dispatch(button(block(b, '饱和度'), '增加'));
    assert.equal(readout(b, '饱和度'), '100%'); assert.equal(hex(b), '#00aaff');
    await b.dispatch(button(block(b, '明度'), '减少'));
    assert.equal(readout(b, '明度'), '99%'); assert.equal(hex(b), '#00a8fc');
    await b.dispatch(button(block(b, '明度'), '增加'));
    assert.equal(readout(b, '明度'), '100%'); assert.equal(hex(b), '#00aaff');
    assert.equal(b.storageWrites.length, beforeAdjust, 'numeric actions remain live previews until explicit apply');
    assert.equal(b.theme.useThemeStore().skin.accent, originalAccent, 'preview changes do not silently replace the active theme');
    await segment(b, '色相', 23);
    assert.equal(readout(b, '色相'), '345°', 'existing coarse color segment remains a public control');
    for (let i = 0; i < 20; i++) await b.dispatch(button(block(b, '色相'), '增加'));
    await disabledEndpoint(b, '色相', '增加', '359°');
    await segment(b, '色相', 0);
    await disabledEndpoint(b, '色相', '减少', '0°');
    await segment(b, '饱和度', 0);
    await disabledEndpoint(b, '饱和度', '减少', '0%');
    await b.dispatch(button(block(b, '饱和度'), '增加'));
    assert.equal(readout(b, '饱和度'), '1%');
    await segment(b, '饱和度', 15);
    await disabledEndpoint(b, '饱和度', '增加', '100%');
    await segment(b, '明度', 0);
    await disabledEndpoint(b, '明度', '减少', '0%');
    await b.dispatch(button(block(b, '色相'), '增加'));
    assert.equal(readout(b, '色相'), '1°');
    assert.equal(readout(b, '明度'), '100%', 'existing hue adjustment lifts a black preview to full value');
    await disabledEndpoint(b, '明度', '增加', '100%');
    await typeHex(b, '#3f6fd8');
    assert.equal(hex(b), '#3f6fd8', 'typed hex is not changed by integer HSV round trips');
    await b.dispatch(b.button('使用此颜色'));
    assert.equal(textOf(byClass(field(b, '强调色'), 'custom-hex')[0]), '#3f6fd8');
    assert.equal(b.theme.useThemeStore().skin.accent, originalAccent, 'applying a picker value still waits for apply-custom');
    const beforeApply = b.storageWrites.length;
    await b.dispatch(b.button('应用自定义'));
    assert.equal(b.theme.useThemeStore().skinId, 'custom');
    assert.equal(b.theme.useThemeStore().skin.accent, '#3f6fd8', 'real public theme value follows the complete apply flow');
    assert.equal(b.storageWrites.length, beforeApply + 1, 'one explicit apply-custom persists once without a wallpaper');
    assert.equal(b.toastCalls.filter(item => item.title === '已应用自定义皮肤').length, 1);
    const urlRow = b.byClass('url-row')[0];
    await b.dispatch(byClass(urlRow, 'url-input')[0], 'input', { value: '/static/tv-preserve.png' });
    await b.dispatch(button(urlRow, '应用'));
    await b.dispatch(b.byClass('wallpaper-image')[0], 'load');
    assert.equal(b.theme.useThemeStore().skin.backgroundImage, '/static/tv-preserve.png', 'wallpaper uses the existing preview-load commit');
    await b.dispatch(field(b, '强调色')); await typeHex(b, '#123456');
    await b.dispatch(b.button('使用此颜色')); await b.dispatch(b.button('应用自定义'));
    assert.equal(b.theme.useThemeStore().skin.accent, '#123456');
    assert.equal(b.theme.useThemeStore().skin.backgroundImage, '/static/tv-preserve.png', 'apply-custom preserves the current wallpaper');
    await b.dispatch(b.option('深色')); await b.dispatch(b.option('Linen')); await show(b);
    await b.dispatch(field(b, '卡片'));
    await b.dispatch(b.byClass('picker-preset')[0]);
    await b.dispatch(b.button('使用此颜色'));
    assert.equal(textOf(byClass(field(b, '卡片'), 'custom-hex')[0]), 'rgba(255,0,0,0.94)', 'ordinary picker colors preserve the existing surface alpha');
    await b.dispatch(b.button('应用自定义'));
    assert.equal(b.theme.useThemeStore().skin.surface, 'rgba(255,0,0,0.94)');
    assert.equal(b.theme.useThemeStore().skin.backgroundImage, '/static/tv-preserve.png');
    assert.equal(b.permissions.length, 0, 'numeric theme adjustment does not request unrelated permissions');
  } finally { await b.close(); }
  const phone = await tvSettingsFixture();
  try {
    await phone.mount('pages/theme/index.uvue'); await show(phone);
    await phone.dispatch(field(phone, '强调色'));
    const sliders = descendants(phone.root).filter(node => node.tag === 'slider');
    assert.equal(sliders.length, 3, 'automatic phone mode retains all three native HSV sliders');
    assert.equal(phone.button('增加'), undefined, 'phone has no duplicate TV numeric actions');
    assert.deepEqual(sliders.map(node => [node.props.min, node.props.max, node.props.step]), [[0, 359, 1], [0, 100, 1], [0, 100, 1]]);
    const before = phone.storageWrites.length;
    await phone.dispatch(sliders[0], 'changing', { value: 200 });
    await phone.dispatch(sliders[1], 'changing', { value: 100 });
    await phone.dispatch(sliders[2], 'change', { value: 100 });
    assert.equal(hex(phone), '#00aaff', 'phone native changing/change events retain live preview behavior');
    assert.equal(phone.storageWrites.length, before);
    await typeHex(phone, '#3f6fd8');
    await phone.dispatch(phone.button('使用此颜色')); await phone.dispatch(phone.button('应用自定义'));
    assert.equal(phone.theme.useThemeStore().skin.accent, '#3f6fd8', 'phone keeps exact typed hex and the real explicit apply flow');
  } finally { await phone.close(); }
}

async function desktopControlsCase() {
  const page = 'pages/desktop-lyric/index.uvue';
  const group = (b, title) => b.byClass('group').find(row => byClass(row, 'cell-title').some(node => textOf(node) === title));
  const control = (b, title) => byClass(group(b, title), 'lyric-tv-controls')[0];
  const readout = (b, title) => textOf(byClass(control(b, title), 'lyric-tv-value')[0]);
  const initialStorage = { 'qt-desktop-lyric-stroke-on': '0', 'qt-desktop-lyric-bg-mode': 'none', 'qt-desktop-lyric-bg-color': '#000000' };
  const specs = [
    { title: '字号', track: 'size-track', key: 'qt-desktop-lyric-font', getter: 'getFontSp', start: '18 sp', plus: '19 sp', value: 19, min: '6 sp', max: '60 sp', center: 33, native: 'audioLyricSetFontSp', args: [19, 15] },
    { title: '歌词窗宽度', track: 'width-track', key: 'qt-desktop-lyric-width', getter: 'getWidthPct', start: '80%', plus: '81%', value: 81, min: '50%', max: '95%', center: 73, native: 'audioLyricSetWidth', args: [81] },
    { title: '描边', track: 'stroke-track', key: 'qt-desktop-lyric-stroke-w', getter: 'getStrokeWidth', start: '1.0', plus: '1.1', value: 1.1, min: '0.5', max: '4.0', center: 2.3, native: 'audioLyricSetStroke', args: [false, 1.1] },
    { title: '背景', track: 'bgop-track', key: 'qt-desktop-lyric-bg-opacity', getter: 'getBackgroundOpacity', start: '0.60', plus: '0.61', value: 0.61, min: '0.00', max: '1.00', center: 0.5, native: 'audioLyricSetBackground', args: ['none', -16777216, 0.61] },
  ];
  const writes = (b, key) => b.storageWrites.filter(([name]) => name === key).length;
  const nativeCount = (b, name) => b.nativeCalls.filter(call => call.name === name).length;
  const b = await tvSettingsFixture({ width: 1920, height: 1080, television: true, initialStorage });
  try {
    await b.mount(page);
    const service = b.load('services/desktop-lyric.uts').desktopLyric;
    assert.ok(button(group(b, '字号'), '减少'), 'TV desktop lyric exposes explicit decrease actions instead of touch-track focus');
    assert.equal(b.byClass('cols').length, 1, 'desktop groups use the actual wide flow content');
    assert.equal(b.byClass('list')[0].props.direction, 'vertical', 'the original vertical scrolling survives');
    for (const spec of specs) {
      assert.equal(b.byClass(spec.track).length, 0, 'TV replaces the touch-only track: ' + spec.title);
      assert.equal(readout(b, spec.title), spec.start);
      assert.equal(css(control(b, spec.title))['min-height'], '76px', 'explicit controls have the shared TV row floor');
      assert.ok(parseFloat(css(byClass(control(b, spec.title), 'lyric-tv-value')[0])['font-size']) >= 20, 'TV numeric text uses shared readable font sizing');
      const before = writes(b, spec.key), nativeBefore = nativeCount(b, spec.native);
      await b.dispatch(button(group(b, spec.title), '增加'));
      assert.equal(service[spec.getter](), spec.value, 'one public activation reaches the existing real setter');
      assert.equal(readout(b, spec.title), spec.plus);
      assert.equal(writes(b, spec.key), before + 1, 'one activation persists once');
      assert.equal(nativeCount(b, spec.native), nativeBefore + 1, 'one activation applies natively once');
      assert.deepEqual(plain(b.nativeCalls.filter(call => call.name === spec.native).at(-1).args), spec.args);
      assert.equal(service.getStrokeEnabled(), false, 'numeric edits do not enable stroke');
      assert.equal(service.getBackgroundMode(), 'none', 'numeric edits do not enable a background');
      assert.equal(service.isEnabled(), false, 'numeric edits do not enable the lyric window');
      await b.dispatch(button(group(b, spec.title), '减少'));
      assert.equal(readout(b, spec.title), spec.start);
    }
    const widths = b.load(UI + 'composables/use-qt-widths.ts'), cap = widths.qtPushContentWidthCap(700);
    await b.flush();
    assert.equal(b.byClass('cols').length, 0, 'a narrow frame cap uses the existing single-column branch');
    assert.equal(b.byClass('lyric-tv-controls').length, 4, 'all four explicit controls also exist in the single-column branch');
    await b.dispatch(button(group(b, '字号'), '增加')); assert.equal(service.getFontSp(), 19);
    await b.dispatch(button(group(b, '字号'), '减少'));
    widths.qtClearContentWidthCap(cap); await b.flush();
    for (const spec of specs) {
      for (let i = 0; i < 110; i++) await b.dispatch(button(group(b, spec.title), '增加'));
      assert.equal(readout(b, spec.title), spec.max, 'remote steps clamp at the upper endpoint');
      const upperWrites = writes(b, spec.key), upperNative = nativeCount(b, spec.native);
      assert.ok(classes(button(group(b, spec.title), '增加')).includes('qt-button-disabled'));
      await b.dispatch(button(group(b, spec.title), '增加'));
      assert.equal(writes(b, spec.key), upperWrites); assert.equal(nativeCount(b, spec.native), upperNative);
      for (let i = 0; i < 110; i++) await b.dispatch(button(group(b, spec.title), '减少'));
      assert.equal(readout(b, spec.title), spec.min, 'remote steps clamp at the lower endpoint');
      const lowerWrites = writes(b, spec.key), lowerNative = nativeCount(b, spec.native);
      assert.ok(classes(button(group(b, spec.title), '减少')).includes('qt-button-disabled'));
      await b.dispatch(button(group(b, spec.title), '减少'));
      assert.equal(writes(b, spec.key), lowerWrites); assert.equal(nativeCount(b, spec.native), lowerNative);
    }
    assert.equal(service.getStrokeEnabled(), false); assert.equal(service.getBackgroundMode(), 'none');
    assert.equal(b.permissions.length, 0, 'numeric actions leave the original permission flow alone');
  } finally { await b.close(); }
  for (const width of [375, 1920]) {
    const phone = await tvSettingsFixture({ width, height: width === 375 ? 800 : 1080, initialStorage });
    try {
      await phone.mount(page);
      const service = phone.load('services/desktop-lyric.uts').desktopLyric;
      assert.equal(phone.byClass('lyric-tv-controls').length, 0, 'automatic touch mode receives no duplicate controls');
      for (const spec of specs) assert.equal(phone.byClass(spec.track).length, 1, 'touch mode keeps the existing track: ' + spec.title);
      const first = phone.byClass('size-track')[0], beforeMeasurement = service.getFontSp();
      await phone.dispatch(first, 'touchstart', { touches: [{ clientX: 170 }] });
      assert.equal(service.getFontSp(), beforeMeasurement, 'unmeasured touch geometry does not jump or persist');
      phone.measurements.splice(0).forEach(reply => reply()); await phone.flush();
      await phone.dispatch(first, 'touchcancel');
      for (const spec of specs) {
        const track = phone.byClass(spec.track)[0], before = writes(phone, spec.key);
        await phone.dispatch(track, 'touchstart', { touches: [{ clientX: 20 }] });
        await phone.dispatch(track, 'touchmove', { touches: [{ clientX: 170 }] });
        assert.equal(writes(phone, spec.key), before, 'phone preview retains deferred persistence');
        await phone.dispatch(track, 'touchcancel');
        assert.equal(service[spec.getter](), spec.center, 'existing geometry and rounding survive touch cancellation');
        assert.equal(writes(phone, spec.key), before + 1, 'phone touchcancel commits once');
        await phone.dispatch(track, 'touchend', { changedTouches: [{ clientX: 320 }] });
        assert.equal(writes(phone, spec.key), before + 1, 'late touchend after cancel does not commit again');
      }
      assert.equal(service.getStrokeEnabled(), false); assert.equal(service.getBackgroundMode(), 'none');
      assert.equal(phone.permissions.length, 0);
    } finally { await phone.close(); }
  }
  const harmony = await tvSettingsFixture({ width: 1920, height: 1080, television: true, platform: 'APP-HARMONY' });
  try {
    await harmony.mount(page);
    for (const spec of specs) assert.equal(group(harmony, spec.title), undefined, 'Harmony keeps unsupported style controls hidden');
    assert.equal(harmony.byClass('lyric-tv-controls').length, 0); assert.equal(harmony.permissions.length, 0);
  } finally { await harmony.close(); }
}

async function playbackFixture(options = {}) {
  const sdk = { publicDataDir: () => '', queryPermissionStates: () => [], statLocalFile: () => ({ exists: false }), readEmbeddedTags: (_path, reply) => reply?.(null) };
  const exits = [];
  const b = await tvSettingsFixture({ ...options, boundaryOverrides: {
    // Complete production PlayerStore imports and initialization; only owned platform/network SDKs vary.
    'stores/player': undefined,
    'services/music-api': { musicApi: { availableQualities: () => ['320'], lyric: async () => null }, isContentFailError: () => false },
    'services/media': { DEFAULT_PLAYLIST_COVER_ASSET: '/static/playlist.png' },
    'services/app-native': { exitApp: () => exits.push('exit'), supportsHomeBackMode: () => true, isHarmonyOs: () => false },
    'uni_modules/qt-js-engine': sdk, 'uni_modules/qt-app-native': sdk,
    ...options.boundaryOverrides,
  } });
  const player = b.load('stores/player.ts').usePlayerStore();
  await b.mount('pages/play-settings/index.uvue');
  return { ...b, player, exits };
}

async function playbackControlsCase() {
  const current = (b, title) => textOf(byClass(b.cell(title), 'cell-value')[0]);
  const optionLabels = b => b.byClass('qo-label').map(textOf);
  const selectedLabel = b => b.byClass('qo-label').filter(node => css(node)['font-weight'] === '600').map(textOf);
  const openCustom = async b => { await b.dispatch(b.cell('音乐缓存上限')); await b.dispatch(b.option('自定义…')); };
  const writes = (b, key) => b.storageWrites.filter(([name]) => name === key).length;
  const natives = (b, name) => b.nativeCalls.filter(call => call.name === name);
  const b = await playbackFixture({ width: 1920, height: 1080, television: true });
  try {
    await openCustom(b);
    assert.equal(b.byClass('cache-input')[0].props.focus, false, 'opening TV custom cache does not automatically request the IME');
    assert.ok(b.button('输入数值'), 'TV exposes an existing QtButton for explicit input activation');
    await b.dispatch(b.button('输入数值'));
    assert.equal(b.byClass('cache-input')[0].props.focus, true, 'explicit activation requests the native numeric input');
    assert.equal(css(b.byClass('cache-input')[0]).height, '56px');
    assert.ok(parseFloat(css(b.byClass('cache-input')[0])['font-size']) >= 20);
    let before = writes(b, 'qt-audio-cache-limit'), nativeBefore = natives(b, 'audioSetCacheLimit').length;
    await b.dispatch(b.byClass('cache-input')[0], 'input', { value: '255' });
    await b.dispatch(b.button('确定'));
    assert.ok(textOf(b.byClass('cache-error')[0]).includes('256'), 'validation keeps the sheet open with its exact minimum');
    assert.equal(writes(b, 'qt-audio-cache-limit'), before); assert.equal(natives(b, 'audioSetCacheLimit').length, nativeBefore);
    await b.dispatch(b.byClass('cache-input')[0], 'input', { value: '250000' });
    assert.equal(b.byClass('cache-error').length, 0, 'editing clears the original validation receipt');
    await b.dispatch(b.button('确定'));
    assert.equal(b.audio.audioPlayer.getCacheLimitMb(), 250000, 'custom numeric values have no imposed upper bound');
    assert.equal(current(b, '音乐缓存上限'), '250000 MB', 'confirmation displays the real service readback');
    assert.equal(writes(b, 'qt-audio-cache-limit'), before + 1);
    assert.equal(natives(b, 'audioSetCacheLimit').length, nativeBefore + 1);
    assert.deepEqual(plain(natives(b, 'audioSetCacheLimit').at(-1).args), [250000]);
    assert.equal(b.byClass('cache-input').length, 0);
    await openCustom(b);
    assert.equal(b.byClass('cache-input')[0].props.focus, false, 'reopening resets explicit activation');
    assert.equal(b.byClass('cache-input')[0].props.value, '', 'reopening keeps the original blank draft');
    await b.dispatch(b.button('取消'));
    assert.equal(writes(b, 'qt-audio-cache-limit'), before + 1, 'cancel never applies the draft');
    for (const preset of [{ label: '1 GB', mb: 1024 }, { label: '2 GB', mb: 2048 }, { label: '4 GB', mb: 4096 }]) {
      await b.dispatch(b.cell('音乐缓存上限'));
      await b.dispatch(b.option(preset.label));
      assert.equal(b.audio.audioPlayer.getCacheLimitMb(), preset.mb); assert.equal(current(b, '音乐缓存上限'), preset.label);
    }
    assert.equal(b.byClass('cols').length, 1);
    assert.equal(b.byClass('list')[0].props.direction, 'vertical');
    for (const row of b.byClass('cell')) assert.equal(css(row)['min-height'], '76px', 'TV playback rows use the shared density floor');
    await b.dispatch(b.cell('默认倍速'));
    assert.deepEqual(optionLabels(b), ['0.75x', '1x', '1.25x', '1.5x', '2x']);
    assert.deepEqual(selectedLabel(b), ['1x']);
    before = writes(b, 'qt-playback-rate'); nativeBefore = natives(b, 'audioSetSpeed').length;
    await b.dispatch(b.option('1.5x'));
    assert.equal(b.audio.audioPlayer.rate, 1.5); assert.equal(current(b, '默认倍速'), '1.5x');
    assert.equal(writes(b, 'qt-playback-rate'), before + 1); assert.equal(natives(b, 'audioSetSpeed').length, nativeBefore + 1);
    assert.deepEqual(plain(natives(b, 'audioSetSpeed').at(-1).args), [1.5]);
    await b.dispatch(b.cell('默认倍速')); assert.deepEqual(selectedLabel(b), ['1.5x']);
    await b.dispatch(b.byClass('as-cancel')[0]);
    await b.dispatch(b.cell('定时关闭'));
    assert.deepEqual(optionLabels(b), ['关闭定时', '10 分钟后', '20 分钟后', '30 分钟后', '45 分钟后', '60 分钟后', '播放完当前歌曲后', '120 分钟后']);
    await b.dispatch(b.option('30 分钟后'));
    assert.equal(b.player.sleepRequestedMinutes, 30); assert.equal(b.player.sleepEndTime, 2800000);
    assert.equal(b.player.sleepStopAfterCurrent, false); assert.equal(b.clock.timeoutCount(1800000), 1);
    b.clock.advance(600000); await b.flush();
    assert.equal(current(b, '定时关闭'), '30 分钟后', 'the displayed preset is not the changing countdown remainder');
    await b.dispatch(b.cell('定时关闭')); assert.deepEqual(selectedLabel(b), ['30 分钟后']);
    await b.dispatch(b.option('播放完当前歌曲后'));
    assert.equal(b.player.sleepRequestedMinutes, 90); assert.equal(b.player.sleepStopAfterCurrent, true); assert.equal(b.player.sleepEndTime, -1);
    assert.equal(b.clock.timeoutCount(1800000), 0, 'the actual store clears the old minute timer');
    assert.equal(b.clock.timeoutCount(5400000), 0, 'the stop-after-current sentinel never creates a 90-minute timer');
    await b.dispatch(b.cell('定时关闭')); assert.deepEqual(selectedLabel(b), ['播放完当前歌曲后']);
    await b.dispatch(b.option('关闭定时'));
    assert.equal(b.player.sleepRequestedMinutes, 0); assert.equal(b.player.sleepEndTime, 0); assert.equal(b.player.sleepStopAfterCurrent, false);
    assert.equal(current(b, '定时关闭'), '关闭');
    await b.dispatch(b.cell('定时关闭')); await b.dispatch(b.option('10 分钟后'));
    await b.clock.runTimers(599999); assert.equal(b.exits.length, 0, 'timer does not exit before its actual deadline');
    await b.clock.runTimers(1); assert.deepEqual(b.exits, ['exit'], 'the full store timer invokes the native app-exit boundary');
    assert.equal(b.player.playing, false); assert.equal(b.player.sleepEndTime, 0);
    assert.equal(natives(b, 'audioStop').length, 1, 'sleep expiry preserves actual stop and persist business');
    const widths = b.load(UI + 'composables/use-qt-widths.ts'), cap = widths.qtPushContentWidthCap(700);
    await b.flush(); assert.equal(b.byClass('cols').length, 0, 'actual pane width keeps the original single-column playback fallback');
    assert.equal(current(b, '默认倍速'), '1.5x'); assert.equal(current(b, '音乐缓存上限'), '4 GB');
    widths.qtClearContentWidthCap(cap); await b.flush();
    b.audioBoundary.dlna = true;
    before = writes(b, 'qt-playback-rate'); nativeBefore = natives(b, 'audioSetSpeed').length;
    await b.dispatch(b.cell('默认倍速')); await b.dispatch(b.option('2x'));
    assert.equal(b.audio.audioPlayer.rate, 1.5, 'the existing real service retains the DLNA rate capability guard');
    assert.equal(writes(b, 'qt-playback-rate'), before); assert.equal(natives(b, 'audioSetSpeed').length, nativeBefore);
    const effectsBefore = b.nativeCalls.length;
    for (const title of ['32bit 浮点输出', '软解优先', '音量增强']) await b.dispatch(b.cell(title));
    assert.equal(b.nativeCalls.length, effectsBefore, 'unsupported output actions retain their original capability guards');
  } finally { await b.close(); }
  for (const width of [375, 1920]) {
    const phone = await playbackFixture({ width, height: width === 375 ? 800 : 1080 });
    try {
      await openCustom(phone);
      assert.equal(phone.byClass('cache-input')[0].props.focus, true, 'touch presentation keeps the original automatic numeric input');
      assert.equal(phone.button('输入数值'), undefined, 'phone has no duplicate activation action');
      await phone.dispatch(phone.byClass('cache-input')[0], 'input', { value: '3072' }); await phone.dispatch(phone.button('确定'));
      assert.equal(phone.audio.audioPlayer.getCacheLimitMb(), 3072); assert.equal(current(phone, '音乐缓存上限'), '3 GB');
      assert.equal(css(phone.cell('默认倍速'))['min-height'], undefined, 'touch rows retain original CSS density');
      await phone.dispatch(phone.cell('定时关闭')); await phone.dispatch(phone.option('播放完当前歌曲后'));
      assert.equal(phone.player.sleepStopAfterCurrent, true); assert.equal(phone.clock.timeoutCount(5400000), 0);
      await phone.dispatch(phone.cell('定时关闭')); await phone.dispatch(phone.option('关闭定时'));
    } finally { await phone.close(); }
  }
}

async function overviewDensityCase() {
  const title = '电视/遥控器展示设置';
  const b = await tvSettingsFixture({ width: 1920, height: 1080, television: true });
  try {
    await b.mount();
    assert.equal(css(b.cell(title))['min-height'], '76px', 'TV settings navigation uses the shared row floor');
    assert.equal(css(b.cell(title)).height, 'auto', 'long TV mode summaries can grow instead of squeezing the title');
    assert.equal(b.byClass('cols').length, 1); assert.equal(b.byClass('list')[0].props.direction, 'vertical');
    const titles = b.byClass('cell-title').map(textOf);
    assert.equal(new Set(titles).size, titles.length, 'two columns keep every entry exactly once');
    for (const row of b.byClass('cell')) {
      assert.equal(css(row)['min-height'], '76px'); assert.equal(css(row).height, 'auto');
      assert.equal(byClass(row, 'cell-main').length, 1, 'TV summaries share a shrinking body below the title');
      assert.equal(byClass(row, 'cell-summary').length, 1);
      assert.equal(byClass(byClass(row, 'cell-right')[0], 'cell-value').length, 0, 'summary text does not steal a side column from the title');
      assert.ok(parseFloat(css(byClass(row, 'cell-title')[0])['font-size']) >= 20);
      assert.ok(parseFloat(css(byClass(row, 'cell-summary')[0])['font-size']) >= 20);
    }
    assert.ok(textOf(b.cell(title)).includes('自动（识别为电视）'));
    assert.ok(textOf(b.cell(title)).includes('原生遥控未接入，仅调整展示'));
    b.device.nativeAvailable = true; b.tv.qtSetTvForeground(true); await b.flush();
    assert.ok(textOf(b.cell(title)).includes('原生遥控已就绪，随电视展示启用'), 'availability summary reflects the actual public bridge flag');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(css(b.cell(title)).height, 'auto', 'saved large fonts do not restore a fixed row height');
    const widths = b.load(UI + 'composables/use-qt-widths.ts'), cap = widths.qtPushContentWidthCap(700);
    await b.flush(); assert.equal(b.byClass('cols').length, 0, 'the actual frame cap keeps overview single-column');
    assert.deepEqual(new Set(b.byClass('cell-title').map(textOf)), new Set(titles));
    await b.dispatch(b.cell(title)); assert.ok(b.option('触控'));
    await b.dispatch(b.option('触控')); assert.equal(b.tv.useQtTv().enabled, false);
    assert.equal(css(b.cell('播放设置'))['min-height'], undefined, 'switching to touch restores the old row density');
    assert.equal(byClass(b.cell('播放设置'), 'cell-main').length, 0, 'touch restores the original side-summary arrangement');
    assert.equal(css(b.cell(title)).height, 'auto', 'the new long mode entry also stays readable on a touch screen');
    widths.qtClearContentWidthCap(cap); await b.flush();
  } finally { await b.close(); }
  const pane = await tvSettingsFixture({ width: 1920, height: 1080, savedMode: 'tv' });
  try {
    await pane.mount(OVERVIEW, { inPane: true, activeRoute: '/pages/theme/index' });
    assert.equal(pane.byClass('cols').length, 0); assert.equal(pane.byClass('cell-summary').length, 0); assert.equal(pane.byClass('cell-value').length, 0);
    for (const row of pane.byClass('cell')) assert.equal(css(row)['min-height'], '76px', 'TV pane keeps its single-column row floor without summaries');
    assert.equal(css(pane.cell('外观与皮肤'))['background-color'], pane.theme.useThemeStore().skin.accentSoft, 'current-page navigation highlight survives');
    await pane.dispatch(pane.cell('播放设置'));
    assert.equal(pane.routes.at(-1).url, '/pages/play-settings/index', 'the public route business remains unchanged');
  } finally { await pane.close(); }
  for (const width of [375, 1920]) {
    const phone = await tvSettingsFixture({ width, height: width === 375 ? 800 : 1080 });
    try {
      await phone.mount();
      assert.equal(phone.byClass('cell-summary').length, 1, 'only the new long entry changes touch summary arrangement');
      assert.equal(byClass(phone.cell(title), 'cell-main').length, 1);
      assert.equal(css(phone.cell(title)).height, 'auto');
      assert.equal(css(phone.cell('播放设置'))['min-height'], undefined);
      assert.equal(byClass(phone.cell('播放设置'), 'cell-main').length, 0);
      assert.equal(byClass(phone.cell('播放设置'), 'cell-value').length, 1, 'existing phone settings retain their original summary');
    } finally { await phone.close(); }
  }
}

const cases = { 'settings-mode': settingsModeCase, 'equalizer-controls': equalizerControlsCase, 'theme-controls': themeControlsCase, 'desktop-controls': desktopControlsCase, 'playback-controls': playbackControlsCase, 'overview-density': overviewDensityCase };
export async function runTvSettingsChecks(selected = 'all') {
  const entries = selected === 'all' ? Object.entries(cases) : [[selected, cases[selected]]];
  assert.ok(entries.every(([, run]) => typeof run === 'function'), 'known focused TV settings case');
  for (const [name, run] of entries) { await run(); console.log('PASS TV settings ' + name); }
  console.log('TV settings: ' + entries.length + ' compiled-template/service groups passed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'all';
  await runTvSettingsChecks(selected);
}
