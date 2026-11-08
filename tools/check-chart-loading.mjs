// 排行榜行为回归：执行实际生产页面队列 / MusicApi / 包态 / TTL 实现。
// 只替换原生引擎网络、时间与存储边界。VM 不证明 Vapor 布局或设备耗时。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { ref, computed, reactive, watch, nextTick } from 'vue';
import * as VueRuntime from 'vue';
import { parse as parseSfc, compileScript, compileTemplate } from '@vue/compiler-sfc';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return Object.hasOwn(this, key) ? this[key] : null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}
function android(text) {
  const states = [true];
  return text.split('\n').filter((line) => {
    const begin = line.match(/^\s*\/\/\s*#(ifdef|ifndef)\s+(.+)$/);
    if (begin) {
      let enabled = begin[2].split(/\|\|/).some((flag) => ['APP-ANDROID', 'APP'].includes(flag.trim()));
      if (begin[1] === 'ifndef') enabled = !enabled;
      states.push(states.at(-1) && enabled);
      return false;
    }
    if (/^\s*\/\/\s*#endif\b/.test(line)) { states.pop(); return false; }
    return states.at(-1);
  }).join('\n');
}
function compile(text) {
  return stripTypeScriptTypes(android(text)
    .replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*/gm, ''), { mode: 'strip' })
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var))/g, '');
}
function exportsOf(text) {
  return [...text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)].map((m) => m[1]);
}
function load(text, scope, names = exportsOf(text), label = 'production') {
  const context = vm.createContext({ ...scope });
  vm.runInContext(compile(text) + `\n;globalThis.__api={${names.join(',')}};`, context, { filename: label });
  return context.__api;
}
function productionFunction(text, name) {
  const from = text.indexOf(`function ${name}(`);
  assert.ok(from >= 0, `production function ${name} exists`);
  let start = text.indexOf('{', from), depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}
const drain = async () => { for (let i = 0; i < 48; i++) await Promise.resolve(); await nextTick(); };
function makeRuntime() {
  const env = { requests: [], storage: new Map(), reads: [], writes: [], files: new Map(), time: 100000, timers: new Map(), timerId: 0 };
  env.advance = async (ms) => {
    await drain(); // JS当前turn的await/nextTick先跑完，不能把新80ms timer放到跳时之后。
    const target = env.time + ms;
    for (let turn = 0; turn < 1000; turn++) {
      const due = [...env.timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) { env.time = target; await drain(); return; }
      env.time = due[1].at;
      env.timers.delete(due[0]);
      if (due[1].repeat > 0) env.timers.set(due[0], { ...due[1], at: env.time + due[1].repeat });
      due[1].fn();
      await drain();
    }
    throw new Error('timer loop did not settle');
  };
  const root = '/chart-fixture/source-bundle';
  const meta = { id: 'meta-a', kind: 'meta', versionCode: 1, dir: `${root}/install/meta-a`, skipCodes: [] };
  env.files.set(`${root}/state.json`, JSON.stringify({ schema: 3, packs: [meta], activeMetaId: meta.id, activeId: '', lastCheckAt: 0 }));
  env.files.set(`${meta.dir}/meta-bundle.js`, 'fixture-artifact');
  class Clock extends Date {
    constructor(...values) { super(...(values.length > 0 ? values : [env.time])); }
    static now() { return env.time; }
  }
  const scope = {
    console, Date: Clock, UTSJSONObject, ref, computed, reactive, watch, nextTick,
    setTimeout: (fn, ms) => { const id = ++env.timerId; env.timers.set(id, { fn, at: env.time + ms }); return id; },
    clearTimeout: (id) => env.timers.delete(id),
    nativeDataDir: () => '/chart-fixture',
    nativeReadTextFile: (path, done) => done(env.files.has(path), env.files.get(path) ?? '', 'not found'),
    nativeWriteTextFile: (path, text, done) => { env.files.set(path, text); done(true, '', ''); },
    nativeExists: (path, done) => done(true, env.files.has(path) ? '1' : '0', ''),
    nativeListDir: (_path, done) => done(true, '[]', ''),
    nativeRemove: (path, done) => { env.files.delete(path); done(true, '', ''); },
    nativeMkdirs: (_path, done) => done(true, '', ''),
    nativeRenamePath: (from, to, done) => { env.files.set(to, env.files.get(from)); env.files.delete(from); done(true, '', ''); },
    invokeSource: (name, args) => new Promise((resolve, reject) => {
      const request = { name, args: JSON.parse(args)[0], done: false };
      if (name === 'chartDetail') {
        env.activeDetails = (env.activeDetails ?? 0) + 1;
        env.peakDetails = Math.max(env.peakDetails ?? 0, env.activeDetails);
      }
      const finish = () => {
        if (request.done) return false;
        request.done = true;
        if (name === 'chartDetail') env.activeDetails--;
        return true;
      };
      request.resolve = (value) => { if (finish()) resolve(JSON.stringify(value)); };
      request.reject = (error) => { if (finish()) reject(error); };
      env.requests.push(request);
    }),
    uni: {
      getStorageSync: (key) => { env.reads.push(key); return env.storage.get(key) ?? ''; },
      setStorageSync: (key, value) => {
        env.writes.push({ key, value });
        if (env.failWrites) throw new Error('fixture storage unavailable');
        env.storage.set(key, value);
      },
      removeStorageSync: (key) => env.storage.delete(key),
      getStorageInfoSync: () => ({ keys: [...env.storage.keys()] }),
      $on: () => {}, $off: () => {}, $emit: () => {},
    },
  };
  Object.assign(scope, load(read('services/http.ts'), scope));
  Object.assign(scope, load(read('services/source-bundle-fs.uts'), scope));
  Object.assign(scope, load(read('services/ttl-store.ts'), scope));
  Object.assign(scope, load(productionFunction(read('services/source-update.uts'), 'packsFingerprint'), scope, ['packsFingerprint']));
  Object.assign(scope, load(read('services/music-api.ts'), scope));
  return { env, scope };
}
function chart(i, platform = 'wyy') {
  return { id: `chart-${i}`, name: `榜单 ${i}`, platform, picUrl: `https://image.invalid/${i}.jpg`, description: '' };
}
function previewLoader(runtime) {
  return load(read('services/chart-loader.ts'), runtime.scope).createChartLoader();
}
async function finishDetailRequests(runtime) {
  let next = 0;
  for (let turn = 0; turn < 100; turn++) {
    await drain();
    const replies = runtime.env.requests.filter((r) => r.name === 'chartDetail');
    if (next >= replies.length) return;
    while (next < replies.length) {
      const request = replies[next++];
      request.resolve({ list: Array.from({ length: 100 }, (_, i) => ({
        id: `${request.args.chart.id}-song-${i}`, name: `歌曲 ${i}`, singer: '歌手', album: '专辑', interval: 180,
      })) });
    }
  }
  throw new Error('detail queue did not settle');
}
// 生产页面公开事件入口：生命周期/窗口/测量是合成宿主输入，不替换页面业务函数。
// 不构造与榜单加载无关的player singleton；播放行为留给真实设备验收。
function pageRuntime(runtime, host = {}, nativeWhole = false) {
  const { env, scope } = runtime;
  env.hooks = { mount: [], unmount: [], show: [], hide: [], load: [] };
  env.viewport = { windowWidth: 1100, windowHeight: 680, statusBarHeight: 20, safeAreaInsets: { bottom: 0 }, ...host.viewport };
  env.rect = Object.hasOwn(host, 'rect') ? host.rect : { width: 1020, height: 470 };
  const events = new Map();
  scope.onMounted = (fn) => env.hooks.mount.push(fn);
  scope.onUnmounted = (fn) => env.hooks.unmount.push(fn);
  scope.onShow = (fn) => env.hooks.show.push(fn);
  scope.onHide = (fn) => env.hooks.hide.push(fn);
  scope.onLoad = (fn) => env.hooks.load.push(fn);
  // New whole-SFC path keeps actual Vue hooks, including hooks in real composables.
  // The original 31 tests retain their agreed SDK/event-entry VM path unchanged.
  if (nativeWhole) { scope.onMounted = VueRuntime.onMounted; scope.onUnmounted = VueRuntime.onUnmounted; }
  scope.setInterval = (fn, ms) => { const id = ++env.timerId; env.timers.set(id, { fn, at: env.time + ms, repeat: ms }); return id; };
  scope.clearInterval = scope.clearTimeout;
  scope.setMetaAuthHook = (fn) => { env.metaAuthHook = fn; };
  scope.nativeAppendTextFile = (path, text, done) => { env.files.set(path, (env.files.get(path) ?? '') + text); done(true, '', ''); };
  Object.assign(scope.uni, {
    getWindowInfo: () => env.viewport,
    getSystemInfoSync: () => env.viewport,
    onWindowResize: (fn) => { env.resize = fn; },
    offWindowResize: () => {},
    navigateTo: (value) => { env.navigation = value; },
    showToast: (value) => { env.toast = value; },
    $on: (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    $off: (name, fn) => events.get(name)?.delete(fn),
    $emit: (name) => { for (const fn of events.get(name) ?? []) fn(); },
    createSelectorQuery: () => {
      let callback;
      const query = { select: () => query, boundingClientRect: (fn) => { callback = fn; return query; },
        exec: () => {
          if (env.deferRects) { if (!env.rectCallbacks) env.rectCallbacks = []; env.rectCallbacks.push(callback); }
          else callback?.(env.rect);
        } };
      return query;
    },
  });
  scope.SOURCE_PACKS_CHANGED_EVENT = read('services/source-update.uts').match(/export const SOURCE_PACKS_CHANGED_EVENT = ([^;]+);/)[1].slice(1, -1);
  for (const path of ['services/logger.uts', 'services/source-auth.ts', 'services/source-quality.ts',
    'stores/source.ts', 'stores/source-registry.ts', 'services/platform.ts',
    'uni_modules/qt-ui/composables/use-qt-layout.ts', 'uni_modules/qt-ui/composables/use-qt-widths.ts',
    'uni_modules/qt-ui/stores/theme.ts', 'uni_modules/qt-ui/stores/font-scale.ts',
    'uni_modules/qt-ui/composables/qt-option-metrics.ts',
    'uni_modules/qt-ui/composables/selection.ts',
    'uni_modules/qt-ui/composables/use-qt-selection-reveal.ts',
    'uni_modules/qt-ui/stores/toast.ts', 'services/toast.uts',
    'uni_modules/qt-ui/composables/use-qt-reveal.ts', 'services/chart-tabs.ts', 'services/chart-loader.ts']) {
    Object.assign(scope, load(read(path), scope, undefined, path));
  }
  env.fire = async (name, value) => { for (const fn of env.hooks[name]) fn(value); await drain(); };
  if (nativeWhole) return null; // Dependencies only; compile/mount the complete real SFC below.
  // 只去掉无关播放器的构造；所有chart事件及其调用的实际函数均保留。
  const pageSource = read('pages/chart/index.uvue');
  const descriptor = parseSfc(pageSource).descriptor;
  const metadata = compileScript(descriptor, { id: 'chart-native-bindings' });
  const templateBindings = Object.keys(metadata.bindings).filter((name) => !metadata.imports[name] && name !== 'player');
  const script = descriptor.scriptSetup.content.replace(/^const player = usePlayerStore\(\);\s*/m, '');
  const page = load(script, scope, [...templateBindings, 'loadAll', 'reloadChartsSafely', 'onChipTap', 'sourceIndex',
    'filteredCharts', 'loading', 'onListScroll', 'sourceRegistry', 'skeletonOn', 'chartLoader',
    'renderedCharts', 'coverSources', 'cardStride', 'columns', 'viewportHeight',
    'showNoSources', 'showEmptyList', 'showListError', 'sourceReveal', 'selectionIndex', 'activeSource',
    'pendingSourceIndex', 'openChart', 'rankCardStyle', 'sourceStripStyle', 'rankNameStyle',
    'previewLineStyle', 'previewNameStyle', 'rankBodyStyle', 'layout', 'cardHeight', 'headPx', 'linePx'], 'pages/chart/index.uvue');
  env.fire = async (name, value) => { for (const fn of env.hooks[name]) fn(value); await drain(); };
  return page;
}
// Full real page template + real QtOption setup/template. Only native element operations and
// the page-frame viewport shell are hosted here; no page binding, label metric or selection is mocked.
function vueImports(code) {
  return code.replace(/import\s*\{([\s\S]*?)\}\s*from\s*['"]vue['"];?/g,
    (_, names) => `const {${names.replace(/\bas\b/g, ':')}} = __vue;`)
    .replace(/^import[\s\S]*?\bfrom\s*['"][^'"]+['"];?\s*/gm, '');
}
function moduleRender(source, scope, id, nativeWhole = false) {
  const options = nativeWhole ? { templateParseOptions: { isCustomElement: (tag) => ['view', 'text', 'image', 'scroll-view'].includes(tag) } } : {};
  const parsed = parseSfc(source, options);
  assert.deepEqual(parsed.errors, []);
  const descriptor = parsed.descriptor;
  const code = compileScript(descriptor, { id, inlineTemplate: true,
    ...(nativeWhole ? { templateOptions: { compilerOptions: {
      isCustomElement: (tag) => ['view', 'text', 'image', 'scroll-view'].includes(tag),
    } } } : {}),
  }).content;
  const text = stripTypeScriptTypes(android(vueImports(code)).replace(/export default/, 'globalThis.__component ='), { mode: 'strip' });
  const context = vm.createContext({ ...scope, __vue: VueRuntime });
  vm.runInContext(text, context, { filename: id });
  return context.__component;
}
function renderNativePage(runtime, page) {
  const source = read('pages/chart/index.uvue');
  const descriptor = parseSfc(source).descriptor;
  const nativeWhole = page == null;
  // Keep the original 31's page stylesheet/proxy path; the new boundary also consumes
  // ALL real QtOption CSS (not just optionStyle), then actual Vue style fallthrough.
  const styleSources = nativeWhole ? [source, ...['qt-option', 'qt-button', 'qt-icon', 'qt-empty'].map((name) =>
    read('uni_modules/qt-ui/components/' + name + '/' + name + '.uvue'))] : [source];
  const stylesheet = styleSources.flatMap((text) => parseSfc(text).descriptor.styles.flatMap((style) =>
    [...style.content.matchAll(/\.([\w-]+)\s*\{([^}]+)\}/g)]
      .map((match) => ({ className: match[1], values: cssValues(match[2]) }))));
  const result = compileTemplate({ source: descriptor.template.content, filename: 'pages/chart/index.uvue', id: 'chart-template',
    compilerOptions: { isCustomElement: (tag) => !['QtPageFrame', 'QtOption'].includes(tag) } });
  assert.deepEqual(result.errors, []);
  const context = vm.createContext({ __vue: VueRuntime });
  vm.runInContext(vueImports(result.code).replace(/export function render/, 'function render') + '\n;globalThis.__render = render;', context);
  const root = { tag: 'native-root', props: {}, children: [], parent: null };
  const node = (tag, text = '') => ({ tag, text, props: {}, children: [], parent: null });
  const detach = (child) => { if (!child.parent) return; const index = child.parent.children.indexOf(child); if (index >= 0) child.parent.children.splice(index, 1); child.parent = null; };
  const renderer = VueRuntime.createRenderer({
    createElement: (tag) => node(tag), createText: (text) => node('#text', text), createComment: (text) => node('#comment', text),
    setText: (child, text) => { child.text = text; }, setElementText: (child, text) => { child.text = text; child.children = []; },
    patchProp: (child, key, _old, value) => { child.props[key] = value; },
    insert: (child, parent, anchor = null) => { detach(child); child.parent = parent; const index = anchor == null ? -1 : parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, child); },
    remove: detach, parentNode: (child) => child.parent,
    nextSibling: (child) => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
  });
  // QtPageFrame is the approved native-host slot/width shell, not another app.
  const frame = { setup: (_props, { slots }) => () => VueRuntime.h('view', { class: 'native-frame-host' }, slots.default?.()) };
  const option = moduleRender(read('uni_modules/qt-ui/components/qt-option/qt-option.uvue'), runtime.scope, 'actual-qt-option', nativeWhole);
  let app;
  if (nativeWhole) {
    const scope = { ...runtime.scope, QtPageFrame: frame, QtOption: option };
    Object.assign(scope, load(read('uni_modules/qt-ui/services/icons.ts'), scope));
    for (const [name, path] of [['QtIcon', 'qt-icon'], ['QtButton', 'qt-button'], ['QtEmpty', 'qt-empty']]) {
      scope[name] = moduleRender(read('uni_modules/qt-ui/components/' + path + '/' + path + '.uvue'), scope, 'actual-' + path, true);
    }
    // Lead-approved opaque playback boundary. Never simulate player/Pinia/business;
    // no playback operation or undeclared identity field may silently succeed.
    const playback = new Proxy({ playSingle() { throw new Error('Playback is outside the chip geometry boundary'); } }, {
      get(target, key) { if (Object.hasOwn(target, key)) return target[key]; throw new Error('Unsupported playback field: ' + String(key)); },
    });
    scope.usePlayerStore = () => playback;
    app = renderer.createApp(moduleRender(source, scope, 'whole-chart-native-SFC', true));
  } else {
    const bindings = VueRuntime.proxyRefs(page);
    app = renderer.createApp({ render: () => context.__render(bindings, []) });
    app.component('QtPageFrame', frame);
    app.component('QtOption', option);
  }
  app.mount(root);
  const styleOf = (element) => {
    const classes = new Set(String(element.props.class ?? '').split(/\s+/));
    const values = {};
    for (const rule of stylesheet) if (classes.has(rule.className)) Object.assign(values, rule.values);
    return Object.assign(values, cssValues(element.props.style));
  };
  return { app, root, styleOf, pixels(element, property) {
    const value = String(styleOf(element)[property]);
    const length = value.match(/^(-?\d+(?:\.\d+)?)(rpx|px)$/);
    assert.ok(length, `actual native style ${property} must have one supported length: ${value}`);
    return length[2] === 'rpx' ? runtime.scope.qtRpx(Number(length[1])) : Number(length[1]);
  }, probeOption(props) {
    assert.ok(nativeWhole, 'recorded Native calibration belongs only to the new whole-SFC path');
    const probeRoot = node('native-calibration-root');
    const probeApp = renderer.createApp({ render: () => VueRuntime.h(option, props) });
    probeApp.mount(probeRoot);
    const element = probeRoot.children.find((child) => String(child.props.class ?? '').split(/\s+/).includes('qo'));
    assert.ok(element, 'calibration mounts the unchanged real QtOption public root');
    return { app: probeApp, element };
  }, find(className) {
    const found = [];
    const visit = (parent) => { if (String(parent.props.class ?? '').split(/\s+/).includes(className)) found.push(parent); for (const child of parent.children) visit(child); };
    visit(root); return found;
  } };
}
function cssValues(value) {
  const style = VueRuntime.normalizeStyle(value);
  if (typeof style !== 'string') return style ?? {};
  return Object.fromEntries(style.split(';').filter((part) => part.includes(':')).map((part) => { const at = part.indexOf(':'); return [part.slice(0, at).trim(), part.slice(at + 1).trim()]; }));
}
// Literal foreground Chart receipt, NOT the Home underlay in the earlier tree:
// qa-output/hd-20261107/chip-bounds-native-before.utf8.log:930-975 + same-frame PNG
// PNG SHA256 6252ef96ac729967f23eb883e1acf00af4ab14d745fc7a81dcee8050e9b3d2fd.
// Physical coordinates, density 280/160. Actual root clips 10 PHYSICAL pixels;
// full row+padding exceeds the strip by 17 physical pixels (different budgets).
const nativeChipReceipt = Object.freeze({
  pixelRatio: 1.75, frame: [210, 42, 1880, 1200], strip: [0, 140, 1670, 228], row: [0, 0, 1201, 105],
  wrappers: [[28, 7, 236, 98], [250, 7, 410, 98], [424, 7, 600, 98], [614, 7, 791, 98], [805, 7, 982, 98], [996, 7, 1173, 98]],
  roots: [[0, 0, 208, 91], [0, 0, 159, 91], [0, 0, 177, 91], [0, 0, 177, 91], [0, 0, 177, 91], [0, 0, 177, 91]],
  labelTop: 25, labelBottom: 66, labelHeight: 41, explicitCardHeight: 259,
});
function nativeLength(runtime, value) {
  if (value == null) return 0;
  const match = String(value).match(/^(-?\d+(?:\.\d+)?)(rpx|px)?$/);
  assert.ok(match, 'supported native length must be literal px/rpx: ' + value);
  return match[2] === 'rpx' ? runtime.scope.qtRpx(Number(match[1])) : Number(match[1]);
}
function nativeEdges(runtime, style, property) {
  const shorthand = property === 'border' ? 'border-width' : property;
  const tokens = String(style[shorthand] ?? '0').trim().split(/\s+/).map((value) => nativeLength(runtime, value));
  const defaults = [tokens[0], tokens[1] ?? tokens[0], tokens[2] ?? tokens[0], tokens[3] ?? tokens[1] ?? tokens[0]];
  return Object.fromEntries(['top', 'right', 'bottom', 'left'].map((side, index) => {
    const key = property + '-' + side + (property === 'border' ? '-width' : '');
    return [side, style[key] == null ? defaults[index] : nativeLength(runtime, style[key])];
  }));
}
function chipBorderBox(native, runtime, element) {
  const style = native.styleOf(element);
  const body = element.children.find((child) => String(child.props.class ?? '').split(/\s+/).includes('qo-body'));
  assert.ok(body, 'real QtOption body exists under its actual root');
  const labels = body.children.filter((child) => String(child.props.class ?? '').split(/\s+/).includes('qo-label'));
  assert.equal(labels.length, 1, 'this calibrated boundary is label-only, not slot/description/card geometry');
  assert.equal(body.children.filter((child) => child.tag === 'text').length, 1);
  const labelStyle = native.styleOf(labels[0]);
  const font = nativeLength(runtime, labelStyle['font-size']);
  const line = String(labelStyle['line-height']);
  const lineHeight = /^\d+(?:\.\d+)?$/.test(line) ? font * Number(line) : nativeLength(runtime, line);
  const padding = nativeEdges(runtime, style, 'padding'), border = nativeEdges(runtime, style, 'border');
  const inset = padding.top + border.top + padding.bottom + border.bottom;
  const minimum = nativeLength(runtime, style['min-height']);
  // Recorded app-uvue label-only constraint boundary: default min-height is a
  // content floor PLUS the real CSS insets. It must reproduce literal 91/41,
  // rather than assume/copy M+14. Explicit height is a border-box control already
  // measured on the same ui.a Native class (rank card 148dp -> 259 physical px).
  // Applying that control to QtOption after this patch is a CALIBRATED PREDICTION,
  // not Native Yoga or a device-after certificate; Lead must rebuild and measure.
  const height = style.height == null ? Math.max(minimum, lineHeight) + inset :
    Math.max(nativeLength(runtime, style.height), minimum + inset);
  assert.equal(style['align-items'], 'center', 'actual QtOption CSS centers its single label');
  return { element, label: labels[0], width: nativeLength(runtime, style.width), height,
    lineHeight, labelTop: (height - lineHeight) / 2, padding, border };
}
function chipRowBounds(native, runtime, roots = native.find('qo')) {
  const row = native.find('source-options')[0], strip = native.find('source-strip')[0];
  assert.ok(row && strip, 'mounted public horizontal row and viewport exist');
  const wrappers = native.find('source-option');
  assert.equal(roots.length, wrappers.length);
  const rowStyle = native.styleOf(row), padding = nativeEdges(runtime, rowStyle, 'padding');
  assert.equal(rowStyle['flex-direction'], 'row');
  assert.equal(rowStyle['align-items'], 'center');
  const chips = roots.map((element, index) => {
    assert.equal(wrappers[index].parent, row, 'actual wrappers are direct row children, not an underlay tree');
    const chip = chipBorderBox(native, runtime, element), wrapperStyle = native.styleOf(wrappers[index]);
    return { ...chip, wrapper: wrappers[index], wrapperWidth: nativeLength(runtime, wrapperStyle.width),
      wrapperHeight: wrapperStyle.height == null ? chip.height : nativeLength(runtime, wrapperStyle.height),
      marginRight: nativeLength(runtime, wrapperStyle['margin-right']) };
  });
  const intrinsic = Math.max(0, ...chips.map((chip) => chip.wrapperHeight)) + padding.top + padding.bottom;
  const rowHeight = rowStyle.height == null ? intrinsic : nativeLength(runtime, rowStyle.height);
  let left = padding.left;
  for (const chip of chips) {
    chip.left = left;
    chip.top = padding.top + (rowHeight - padding.top - padding.bottom - chip.wrapperHeight) / 2;
    chip.bottom = chip.top + chip.height;
    left += chip.wrapperWidth + chip.marginRight;
  }
  return { strip, row, roots: chips, padding, rowHeight,
    width: nativeLength(runtime, rowStyle.width), stripHeight: nativeLength(runtime, native.styleOf(strip).height) };
}
function assertChipBoxesFit(bounds, context) {
  for (const [index, chip] of bounds.roots.entries()) {
    assert.ok(chip.top >= -1e-8, context + ': root ' + index + ' top must be in the strip');
    assert.ok(chip.bottom + bounds.padding.bottom <= bounds.stripHeight + 1e-8,
      context + ': actual QtOption root ' + index + ' plus row padding must fit the horizontal viewport');
    const topInset = chip.padding.top + chip.border.top, bottomInset = chip.padding.bottom + chip.border.bottom;
    assert.ok(chip.labelTop >= topInset - 1e-8 && chip.labelTop + chip.lineHeight <= chip.height - bottomInset + 1e-8,
      context + ': the real single-line label must fit inside its root padding/border');
  }
}
function registryResponse(ids) {
  return { sources: ids.map((id) => ({ id, name: id === 'wyy' ? '网易云音乐' : id, short: id,
    color: '#e5484d', features: { charts: true } })), qualities: [] };
}
let passes = 0;
async function check(name, fn) { await fn(); passes++; console.log(`  ✓ ${name}`); }
await check('首批预览最多占用两条原生引擎请求', async () => {
  const runtime = makeRuntime();
  await runtime.scope.ensureLocalStateRestored();
  const page = previewLoader(runtime);
  page.display('wyy', Array.from({ length: 25 }, (_, i) => chart(i)));
  page.setDemand(0, 3);
  await drain();
  assert.equal(runtime.env.requests.filter((r) => r.name === 'chartDetail').length, 2,
    '排行榜前三首不能六并发拉全量歌曲响应');
});
await check('前三首只为当前可视需求取详情，离屏22榜不发请求', async () => {
  const runtime = makeRuntime();
  await runtime.scope.ensureLocalStateRestored();
  const page = previewLoader(runtime);
  page.display('wyy', Array.from({ length: 25 }, (_, i) => chart(i)));
  page.setDemand(0, 3);
  await finishDetailRequests(runtime);
  assert.deepEqual(runtime.env.requests.filter((r) => r.name === 'chartDetail').map((r) => r.args.chart.id),
    ['chart-0', 'chart-1', 'chart-2'], '可视前三榜之外不能自动拉全量歌曲');
  assert.equal(page.previewSongs.value[0].length, 3);
  assert.equal(page.previewTotals.value[0], 100);
});
await check('120次滚动在内存即时可读，300ms只读写一次位置存档', async () => {
  const runtime = makeRuntime();
  const tabs = load(read('services/chart-tabs.ts'), runtime.scope);
  for (let i = 1; i <= 120; i++) tabs.saveChartScroll('wyy', i * 10);
  assert.equal(runtime.env.writes.filter((w) => w.key === 'qt-chart-scroll').length, 0,
    '滚动回调不能每帧同步序列化/写整个位置表');
  assert.equal(tabs.readChartScroll('wyy'), 1200);
  await runtime.env.advance(299);
  assert.equal(runtime.env.writes.filter((w) => w.key === 'qt-chart-scroll').length, 0);
  await runtime.env.advance(1);
  assert.equal(runtime.env.writes.filter((w) => w.key === 'qt-chart-scroll').length, 1);
  assert.equal(runtime.env.reads.filter((key) => key === 'qt-chart-scroll').length, 1);
  assert.equal(JSON.parse(runtime.env.storage.get('qt-chart-scroll')).wyy, 1200);
});
await check('onLoad普通路由对象与空参数可加载，合法si选源、无效si回退当前源', async () => {
  const cases = [
    [{}, 'qq'], [undefined, 'qq'], [null, 'qq'],
    [{ si: '0' }, 'wyy'], [{ si: '1' }, 'qq'],
    [{ si: null }, 'qq'], [{ si: '' }, 'qq'], [{ si: ' ' }, 'qq'],
    [{ si: '-1' }, 'qq'], [{ si: '0.5' }, 'qq'], [{ si: 'bad' }, 'qq'], [{ si: '99' }, 'qq'],
  ];
  for (const [options, expected] of cases) {
    const runtime = makeRuntime();
    const page = pageRuntime(runtime);
    runtime.scope.useSourceStore().setSource('qq');
    await runtime.env.fire('load', options);
    await runtime.env.fire('mount');
    runtime.env.requests.find((r) => r.name === 'sourceRegistry').resolve(registryResponse(['wyy', 'qq']));
    await drain();
    assert.equal(page.activeSource.value, expected, 'route options: ' + JSON.stringify(options));
    assert.deepEqual(runtime.env.requests.filter((r) => r.name === 'charts').map((r) => r.args.source), [expected]);
    await runtime.env.fire('unmount');
  }
});
await check('首次挂载等待真实异步注册表，然后只拉当前可用源', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await runtime.env.fire('mount');
  const registry = runtime.env.requests.find((r) => r.name === 'sourceRegistry');
  assert.ok(registry, '实际注册表经MusicApi发出engine请求');
  assert.equal(runtime.env.requests.filter((r) => r.name === 'charts').length, 0);
  registry.resolve(registryResponse(['wyy', 'qq']));
  await drain();
  assert.equal(page.sourceRegistry.ready, true, '实际注册表已完成生产解析');
  assert.deepEqual(runtime.env.requests.filter((r) => r.name === 'charts').map((r) => r.args.source), ['wyy'],
    '注册表异步到达后必须自动继续当前源榜单请求');
});
await check('页面卸载先使实际在飞列表失效，迟到结果不提交或拉详情', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await runtime.env.fire('mount');
  runtime.env.requests.find((r) => r.name === 'sourceRegistry').resolve(registryResponse(['wyy', 'qq']));
  await drain();
  const request = runtime.env.requests.find((r) => r.name === 'charts');
  assert.ok(request);
  await runtime.env.fire('unmount');
  request.resolve({ list: Array.from({ length: 25 }, (_, i) => chart(i)) });
  await drain();
  assert.equal(page.filteredCharts.value.length, 0, '卸载后不能把迟到列表重新提交到页面');
  assert.equal(runtime.env.requests.filter((r) => r.name === 'chartDetail').length, 0,
    '卸载后的列表响应不能复活preview队列');
});
await check('80ms安全切源窗口内A→B→A保留最后A意图', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await runtime.env.fire('mount');
  runtime.env.requests.find((r) => r.name === 'sourceRegistry').resolve(registryResponse(['wyy', 'qq']));
  await drain();
  runtime.env.requests.find((r) => r.name === 'charts').resolve({ list: [chart(0)] });
  await drain();
  assert.equal(page.sourceIndex.value, 0);
  page.onChipTap(1);
  page.onChipTap(0);
  await runtime.env.advance(80);
  assert.equal(page.sourceIndex.value, 0, '最终A点击不能被当前仍显示A的早退吞掉');
});
await check('初次列表网络失败结束骨架，不能永久假装仍在加载', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await runtime.env.fire('mount');
  runtime.env.requests.find((r) => r.name === 'sourceRegistry').resolve(registryResponse(['wyy']));
  await drain();
  runtime.env.requests.find((r) => r.name === 'charts').reject(new Error('fixture offline'));
  await drain();
  await runtime.env.advance(5000);
  assert.equal(page.loading.value, false, '实际catch已结束请求加载态');
  assert.equal(page.skeletonOn.value, false, '失败后必须展示可操作错误态，而非永久骨架');
});
await check('包事件等待重取注册表，即使可用源数量不变也不能沿用旧源', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await runtime.env.fire('mount');
  runtime.env.requests.find((r) => r.name === 'sourceRegistry').resolve(registryResponse(['wyy', 'qq']));
  await drain();
  runtime.env.requests.find((r) => r.name === 'charts').resolve({ list: [chart(0)] });
  await drain();
  await finishDetailRequests(runtime);
  await runtime.env.advance(160);
  runtime.scope.musicApi.clearPlayUrlCache(); // 实际公开epoch失效入口，不替换身份函数。
  runtime.scope.uni.$emit(runtime.scope.SOURCE_PACKS_CHANGED_EVENT);
  await runtime.env.advance(80);
  const registries = runtime.env.requests.filter((r) => r.name === 'sourceRegistry');
  assert.equal(registries.length, 2, '包事件不能按旧ready=true跳过当前包的注册表');
  assert.equal(runtime.env.requests.filter((r) => r.name === 'charts').length, 1,
    '新注册表未到达前不能发旧源请求');
  registries[1].resolve(registryResponse(['new-source', 'qq']));
  await drain();
  assert.equal(page.selectionIndex.value, -1, '旧活动ID消失时，不能把同下标的新ID标为已选择');
  await runtime.env.advance(80);
  assert.deepEqual(runtime.env.requests.filter((r) => r.name === 'charts').map((r) => r.args.source), ['wyy', 'new-source']);
});
await check('真实API身份失效后，迟到预览不能缓存或复活后续请求', async () => {
  const runtime = makeRuntime();
  await runtime.scope.ensureLocalStateRestored();
  const core = load(read('services/chart-loader.ts'), runtime.scope);
  const loader = core.createChartLoader();
  loader.display('wyy', Array.from({ length: 25 }, (_, i) => chart(i)));
  loader.setDemand(0, 6);
  await drain();
  const pending = runtime.env.requests.filter((r) => r.name === 'chartDetail');
  assert.equal(pending.length, 2);
  runtime.scope.musicApi.clearPlayUrlCache();
  for (const request of pending) request.resolve({ list: [{ id: request.args.chart.id + '-old', name: '旧包歌曲', singer: '歌手' }] });
  await drain();
  assert.equal(runtime.env.requests.filter((r) => r.name === 'chartDetail').length, 2,
    '旧身份finally不能用新API身份继续拉剩余榜单');
  assert.equal(loader.previewSongs.value[0].length, 0);
  const next = core.createChartLoader();
  next.display('wyy', [chart(0)]);
  assert.equal(next.previewStates.value[0], 0, '旧身份响应不能写新身份预览cache');
});
await check('空预览30秒到期必须穿透真实API旧空缓存', async () => {
  const runtime = makeRuntime();
  await runtime.scope.ensureLocalStateRestored();
  const core = load(read('services/chart-loader.ts'), runtime.scope);
  const first = core.createChartLoader();
  first.display('wyy', [chart(0)]);
  first.setDemand(0, 1);
  await drain();
  runtime.env.requests.find((r) => r.name === 'chartDetail').resolve({ list: [] });
  await drain();
  assert.equal(first.previewStates.value[0], 4);
  assert.equal(first.songLine(0, 0), '榜单暂无歌曲');
  runtime.env.time += 30001;
  const next = core.createChartLoader();
  next.display('wyy', [chart(0)]);
  next.setDemand(0, 1);
  await drain();
  const requests = runtime.env.requests.filter((r) => r.name === 'chartDetail');
  assert.equal(requests.length, 2, '不能把60s API旧空数组当作30秒后的新数据');
  requests[1].resolve({ list: [{ id: 'now-available', name: '已恢复歌曲', singer: '歌手' }] });
  await drain();
  assert.equal(next.previewStates.value[0], 1);
  assert.equal(next.previewSongs.value[0][0].id, 'now-available');
});
await check('空榜单清单30秒后重新显示页面会穿透真实API旧空缓存', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await runtime.env.fire('mount');
  runtime.env.requests.find((r) => r.name === 'sourceRegistry').resolve(registryResponse(['wyy']));
  await drain();
  runtime.env.requests.find((r) => r.name === 'charts').resolve({ list: [] });
  await drain();
  assert.equal(page.showEmptyList.value, true);
  assert.equal(page.skeletonOn.value, false);
  await runtime.env.advance(31000);
  await runtime.env.fire('hide');
  await runtime.env.fire('show');
  const requests = runtime.env.requests.filter((r) => r.name === 'charts');
  assert.equal(requests.length, 2, '短空缓存到期不能被API的60s旧空列表再次填回');
  requests[1].resolve({ list: [chart(0)] });
  await drain();
  assert.equal(page.showEmptyList.value, false);
  assert.equal(page.filteredCharts.value.length, 1);
});
async function bootCharts(runtime, page, ids = ['wyy', 'qq'], list = Array.from({ length: 25 }, (_, i) => chart(i))) {
  await runtime.env.fire('mount');
  runtime.env.requests.find((r) => r.name === 'sourceRegistry').resolve(registryResponse(ids));
  await drain();
  runtime.env.requests.find((r) => r.name === 'charts').resolve({ list });
  await drain();
  await runtime.env.advance(160);
}
function pxStyle(style, property, width = 1100) {
  const match = style.match(new RegExp(`${property}:([\\d.]+)(rpx|px);`));
  assert.ok(match, `${property} is a concrete pixel/rpx value: ${style}`);
  return Number(match[1]) * (match[2] === 'rpx' ? width / 750 : 1);
}
await check('手机首帧与异步测量后的卡片同宽，已经完整可见的QQ标签不被左拉', async () => {
  for (const width of [320, 384, 412]) {
    const runtime = makeRuntime();
    const page = pageRuntime(runtime, { viewport: { windowWidth: width, windowHeight: 850 }, rect: { width, height: 600 } });
    runtime.env.deferRects = true;
    await runtime.env.fire('load', { si: '1' });
    const first = pxStyle(page.rankCardStyle(0), 'width');
    assert.equal(first, Math.floor(width - runtime.scope.qtRpx(48)), '首帧不能多扣48px宽屏留白');
    await runtime.env.fire('mount');
    const response = registryResponse(['wyy', 'qq', 'kw', 'kg', 'bili']);
    for (const [i, label] of ['网易云音乐', 'QQ音乐', '酷我音乐', '酷狗音乐', '哔哩哔哩'].entries()) {
      response.sources[i].short = label; response.sources[i].name = label;
    }
    runtime.env.requests.find(r => r.name === 'sourceRegistry').resolve(response); await drain();
    runtime.env.requests.find(r => r.name === 'charts').resolve({ list: [chart(0, 'qq')] }); await drain();
    assert.equal(page.selectionIndex.value, 1);
    assert.equal(pxStyle(page.rankCardStyle(0), 'width'), first);
    for (const callback of runtime.env.rectCallbacks) callback(runtime.env.rect);
    await runtime.env.advance(300);
    assert.equal(pxStyle(page.rankCardStyle(0), 'width'), first, '原生测量回执不改变卡片宽度');
    assert.equal(page.sourceReveal.anchor.value, '', '已经可见的QQ不对齐到左缘');
    page.onChipTap(4); await runtime.env.advance(32);
    assert.equal(page.sourceReveal.anchor.value, page.sourceReveal.itemId(4), '末项仍会被揭示');
    page.onSourceScroll({ detail: { scrollLeft: 200 } });
    page.onChipTap(0); await runtime.env.advance(32);
    assert.equal(page.sourceReveal.anchor.value, page.sourceReveal.itemId(0), '手动横滑后左边不可见项仍能返回');
    await runtime.env.fire('unmount');
  }
});
await check('视口几何包含半行和上下overscan，非法几何不会扩大需求', async () => {
  const runtime = makeRuntime();
  const core = load(read('services/chart-loader.ts'), runtime.scope);
  assert.deepEqual({ ...core.chartDemandWindow(0, 300, 100, 1, 25) }, { start: 0, end: 4 });
  assert.deepEqual({ ...core.chartDemandWindow(450, 300, 100, 2, 25) }, { start: 6, end: 18 });
  assert.deepEqual({ ...core.chartDemandWindow(NaN, -1, Infinity, 0, 25) }, { start: 0, end: 2 });
  assert.deepEqual({ ...core.chartDemandWindow(99999, 300, 100, 2, 25) }, { start: 25, end: 25 });
});
await check('需求改变只挂当前图片且跳过中间离屏榜，所有在飞预览计入两slot', async () => {
  const runtime = makeRuntime();
  await runtime.scope.ensureLocalStateRestored();
  const loader = previewLoader(runtime);
  loader.display('wyy', Array.from({ length: 25 }, (_, i) => chart(i)));
  loader.setDemand(0, 3);
  await drain();
  loader.setDemand(5, 8);
  for (let i = 0; i < 100; i++) loader.setDemand(5, 8);
  assert.equal(runtime.env.requests.filter((r) => r.name === 'chartDetail').length, 2);
  assert.deepEqual(Array.from(loader.coverSources.value, (url, i) => url !== '' ? i : -1).filter((i) => i >= 0), [5, 6, 7]);
  await finishDetailRequests(runtime);
  assert.deepEqual(runtime.env.requests.filter((r) => r.name === 'chartDetail').map((r) => r.args.chart.id), ['chart-0', 'chart-1', 'chart-5', 'chart-6', 'chart-7']);
  assert.equal(runtime.env.peakDetails, 2);
});
await check('失败预览显式重试穿透旧成功API memo，重复点按不重复发请求', async () => {
  const runtime = makeRuntime();
  await runtime.scope.ensureLocalStateRestored();
  const old = runtime.scope.musicApi.chartDetail(chart(0));
  await drain();
  runtime.env.requests.find((r) => r.name === 'chartDetail').resolve({ list: [{ id: 'old', name: '旧缓存', singer: '歌手' }] });
  await old;
  const loader = previewLoader(runtime);
  loader.display('wyy', [chart(0)]);
  loader.setDemand(0, 1, true);
  await drain();
  runtime.env.requests.filter((r) => r.name === 'chartDetail').at(-1).reject(new Error('fixture preview failure'));
  await drain();
  assert.equal(loader.previewStates.value[0], 2);
  assert.match(loader.songLine(0, 0), /点按重试/);
  loader.retry(0);
  loader.retry(0);
  await drain();
  const requests = runtime.env.requests.filter((r) => r.name === 'chartDetail');
  assert.equal(requests.length, 3);
  requests[2].resolve({ list: [{ id: 'recovered', name: '已恢复', singer: '歌手' }] });
  await drain();
  assert.equal(loader.previewSongs.value[0][0].id, 'recovered');
});
await check('预览view cache最多80项，每项仅3首+总数，清除不复用旧预览', async () => {
  const runtime = makeRuntime();
  await runtime.scope.ensureLocalStateRestored();
  const core = load(read('services/chart-loader.ts'), runtime.scope);
  const list = Array.from({ length: 90 }, (_, i) => chart(i));
  const first = core.createChartLoader();
  first.display('wyy', list);
  first.setDemand(0, 90);
  await finishDetailRequests(runtime);
  const next = core.createChartLoader();
  next.display('wyy', list);
  assert.equal(next.previewStates.value.filter((value) => value === 1).length, 80);
  assert.equal(next.previewStates.value[9], 0);
  assert.equal(next.previewStates.value[10], 1);
  assert.equal(next.previewSongs.value[89].length, 3);
  assert.equal(next.previewTotals.value[89], 100);
  assert.equal(runtime.env.peakDetails, 2);
  core.clearChartViewCache();
  const cleared = core.createChartLoader();
  cleared.display('wyy', [chart(89)]);
  assert.equal(cleared.previewStates.value[0], 0);
});
await check('榜单快照12源上限、非空12h、旧身份拒写和同步清除', async () => {
  const runtime = makeRuntime();
  await runtime.scope.ensureLocalStateRestored();
  const core = load(read('services/chart-loader.ts'), runtime.scope);
  const identity = runtime.scope.musicApi.chartCacheIdentity();
  for (let i = 0; i < 13; i++) core.rememberChartList(`s${i}`, [chart(i)], identity);
  assert.equal(core.readChartListSnapshot('s0'), null);
  assert.ok(core.readChartListSnapshot('s1'));
  assert.ok(core.readChartListSnapshot('s12'));
  runtime.env.time += 12 * 60 * 60 * 1000;
  assert.equal(core.readChartListSnapshot('s12'), null);
  core.rememberChartList('empty', [], identity);
  runtime.env.time += 30001;
  assert.equal(core.readChartListSnapshot('empty'), null);
  assert.equal(core.chartListRequiresNetwork('empty'), true);
  runtime.scope.musicApi.clearPlayUrlCache();
  assert.equal(core.rememberChartList('old', [chart(1)], identity), null);
  assert.equal(core.chartListRequiresNetwork('empty'), false);
  core.clearChartViewCache();
  assert.equal(core.readChartListSnapshot('s1'), null);
});
await check('实际测量接首屏8图片/2slot；初始fallback前缀不超过10卡，深滚回顶不收缩树', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await bootCharts(runtime, page);
  assert.equal(page.viewportHeight.value, 470);
  assert.equal(page.columns.value, 2);
  assert.ok(page.renderedCharts.value.length >= 8 && page.renderedCharts.value.length <= 10);
  assert.equal(page.coverSources.value.filter((url) => url !== '').length, 8);
  page.onListScroll({ detail: { scrollTop: 800 } });
  assert.ok(page.renderedCharts.value.length > 10 && page.renderedCharts.value.length < 25);
  const grown = page.renderedCharts.value.length;
  page.onListScroll({ detail: { scrollTop: 0 } });
  assert.equal(page.renderedCharts.value.length, grown);
  assert.equal(page.coverSources.value.filter((url) => url !== '').length, 8);
  await finishDetailRequests(runtime);
  assert.equal(runtime.env.peakDetails, 2);
  assert.equal(runtime.env.requests.filter((r) => r.name === 'chartDetail').length, 8);
});
await check('热A→B→A立即复用原列表/前三首并恢复位置，不再请求A榜单或详情', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await bootCharts(runtime, page);
  page.onListScroll({ detail: { scrollTop: 800 } });
  await finishDetailRequests(runtime);
  page.onChipTap(1);
  await runtime.env.advance(80);
  runtime.env.requests.filter((r) => r.name === 'charts').at(-1).resolve({ list: Array.from({ length: 5 }, (_, i) => chart(i, 'qq')) });
  await drain();
  await finishDetailRequests(runtime);
  await runtime.env.advance(160);
  const before = runtime.env.requests.filter((r) => r.name === 'chartDetail').length;
  page.onChipTap(0);
  await runtime.env.advance(80);
  assert.equal(page.activeSource.value, 'wyy');
  assert.equal(page.filteredCharts.value.length, 25);
  assert.ok(page.renderedCharts.value.length > 8);
  assert.equal(runtime.scope.readChartListSnapshot('wyy').charts.length, 25);
  assert.deepEqual(runtime.env.requests.filter((r) => r.name === 'charts').map((r) => r.args.source), ['wyy', 'qq']);
  assert.equal(runtime.env.requests.filter((r) => r.name === 'chartDetail').length, before);
  assert.equal(runtime.scope.readChartScroll('wyy'), 800);
});
await check('强刷期间用户再深滚动，响应必须第二次回顶后才能整组替换，并强取预览', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await bootCharts(runtime, page);
  page.onListScroll({ detail: { scrollTop: 800 } });
  await finishDetailRequests(runtime);
  const identity = runtime.scope.musicApi.chartCacheIdentity();
  page.reloadChartsSafely();
  await runtime.env.advance(160);
  page.onListScroll({ detail: { scrollTop: 600 } });
  runtime.env.requests.filter((r) => r.name === 'charts').at(-1).resolve({ list: [chart(0), chart(1)] });
  await drain();
  assert.equal(page.filteredCharts.value.length, 25, '新响应不能在用户已再次深滚时直接换整组');
  assert.equal(runtime.scope.readChartScroll('wyy'), 600, '等待网络期间用户滚动不能被无限期屏蔽');
  await runtime.env.advance(80);
  await drain();
  assert.equal(page.filteredCharts.value.length, 2);
  assert.equal(runtime.scope.musicApi.chartCacheIdentity(), identity, '页面强刷不能清播放URL或递增全局epoch');
  const pending = runtime.env.requests.filter((r) => r.name === 'chartDetail' && !r.done);
  assert.equal(pending.length, 2, '强刷必须绕过之前成功预览的两层cache');
  for (const request of pending) request.resolve({ list: [{ id: 'fresh-' + request.args.chart.id, name: '新预览', singer: '歌手' }] });
  await drain();
  assert.match(page.chartLoader.previewSongs.value[0][0].id, /^fresh-/);
});
await check('热榜单刷新失败保留旧列表且提示失败，不回到永久骨架', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await bootCharts(runtime, page);
  await finishDetailRequests(runtime);
  page.reloadChartsSafely();
  await runtime.env.advance(80);
  runtime.env.requests.filter((r) => r.name === 'charts').at(-1).reject(new Error('fixture refresh offline'));
  await drain();
  await drain();
  assert.equal(page.filteredCharts.value.length, 25);
  assert.equal(page.skeletonOn.value, false);
  assert.equal(page.loading.value, false);
  assert.ok(runtime.scope.qtToastItems().some((item) => /刷新失败.*保留原榜单/.test(item.text)));
});
await check('隐藏同步flush/移除所有图片/使迟到预览失效，重新显示复用列表', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await bootCharts(runtime, page);
  page.onListScroll({ detail: { scrollTop: 100 } });
  await runtime.env.fire('hide');
  assert.ok(page.coverSources.value.every((url) => url === ''));
  assert.equal(JSON.parse(runtime.env.storage.get('qt-chart-scroll')).wyy, 100);
  for (const request of runtime.env.requests.filter((r) => r.name === 'chartDetail')) request.resolve({ list: [{ id: request.args.chart.id, name: '迟到', singer: '歌手' }] });
  await drain();
  assert.equal(runtime.env.requests.filter((r) => r.name === 'chartDetail').length, 2);
  assert.equal(page.chartLoader.previewSongs.value[0].length, 0);
  await runtime.env.fire('show');
  assert.equal(runtime.env.requests.filter((r) => r.name === 'charts').length, 1);
  assert.ok(page.coverSources.value.some((url) => url !== ''));
});
await check('真实共享字号/布局样式五字体×四窗口，卡名/三行预览/切源行不会被固定高度截断', async () => {
  for (const [width, height, rectWidth, rectHeight] of [[320, 700, 296, 490], [400, 800, 352, 560], [800, 450, 720, 290], [1100, 680, 1020, 470]]) {
    for (const tier of ['tiny', 'small', 'normal', 'large', 'huge']) {
      const runtime = makeRuntime();
      const page = pageRuntime(runtime, { viewport: { windowWidth: width, windowHeight: height }, rect: { width: rectWidth, height: rectHeight } });
      runtime.scope.fontScale.setTier(tier);
      await runtime.env.fire('mount');
      await runtime.env.advance(40);
      const nameFont = pxStyle(page.rankNameStyle.value, 'font-size', width);
      const songFont = pxStyle(page.previewNameStyle.value, 'font-size', width);
      assert.ok(page.headPx.value >= nameFont * 1.4 - 0.01, `${width}/${tier}: head`);
      assert.ok(page.linePx.value >= songFont * 1.4 - 0.01, `${width}/${tier}: song row`);
      assert.ok(page.cardHeight.value >= page.headPx.value + 3 * page.linePx.value, `${width}/${tier}: card`);
      assert.ok(pxStyle(page.sourceStripStyle.value, 'height', width) >= runtime.scope.qtOptionChipMinHeightPx(), `${width}/${tier}: source strip`);
      assert.ok(pxStyle(page.rankCardStyle(0), 'width', width) > 0);
      await runtime.env.fire('unmount');
    }
  }
});
await check('滚动存档损坏/身份/值校验、24源淘汰、失败flush重试与取消批次', async () => {
  const runtime = makeRuntime();
  runtime.env.storage.set('qt-chart-scroll', '{bad json');
  const tabs = load(read('services/chart-tabs.ts'), runtime.scope);
  assert.equal(tabs.readChartScroll('wyy'), 0);
  assert.equal(tabs.readChartScroll('qq'), 0);
  assert.equal(runtime.env.reads.filter((key) => key === 'qt-chart-scroll').length, 1);
  tabs.saveChartScroll('bad:id', 100);
  tabs.saveChartScroll('wyy', Infinity);
  tabs.saveChartScroll('wyy', 500001);
  assert.equal(tabs.readChartScroll('wyy'), 0);
  for (let i = 0; i < 25; i++) tabs.saveChartScroll(`s${i}`, 100 + i);
  assert.equal(tabs.readChartScroll('s0'), 0);
  assert.equal(tabs.readChartScroll('s24'), 124);
  runtime.env.failWrites = true;
  tabs.flushChartScroll();
  assert.equal(tabs.readChartScroll('s24'), 124);
  runtime.env.failWrites = false;
  tabs.flushChartScroll();
  assert.equal(Object.keys(JSON.parse(runtime.env.storage.get('qt-chart-scroll'))).length, 24);
  const count = runtime.env.writes.length;
  await runtime.env.advance(400);
  assert.equal(runtime.env.writes.length, count);
  tabs.saveChartScroll('s24', -1);
  assert.equal(tabs.readChartScroll('s24'), 0);
});
await check('切源reveal接真实共享helper，异步同ID标签改名/字体/窗口改变都会重新揭示选择', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  const ids = ['wyy', ...Array.from({ length: 11 }, (_, i) => `s${i + 1}`)];
  await bootCharts(runtime, page, ids, [chart(0)]);
  page.onChipTap(11);
  await runtime.env.advance(32);
  const target = page.sourceReveal.itemId(11);
  assert.equal(page.sourceReveal.anchor.value, target);
  await runtime.env.advance(80);
  const changed = page.sourceRegistry.refresh();
  await drain();
  const response = registryResponse(ids);
  response.sources[11].short = '同ID异步变长的新音源标签';
  response.sources[11].name = response.sources[11].short;
  runtime.env.requests.filter((r) => r.name === 'sourceRegistry').at(-1).resolve(response);
  await changed;
  await drain();
  assert.equal(page.sourceReveal.anchor.value, '', '标签宽度变化也必须reset/reveal，不能只watch ID数量或字符串');
  await runtime.env.advance(32);
  assert.equal(page.sourceReveal.anchor.value, target);
  runtime.scope.fontScale.setTier('huge');
  await drain();
  assert.equal(page.sourceReveal.anchor.value, '');
  await runtime.env.advance(32);
  assert.equal(page.sourceReveal.anchor.value, target);
  runtime.env.viewport.windowWidth = 1200;
  runtime.env.rect.width = 1120;
  const poll = [...runtime.env.timers.values()].find((timer) => timer.repeat === 1000);
  assert.ok(poll, 'Android真实QtLayout使用1000ms窗口轮询，而非虚构onWindowResize');
  await runtime.env.advance(poll.at - runtime.env.time);
  assert.equal(page.sourceReveal.anchor.value, '');
  await runtime.env.advance(32);
  assert.equal(page.sourceReveal.anchor.value, target);
});
await check('快速强刷响应即使落在程序滚动抑制窗口内，也必须第二次safe-top', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  await bootCharts(runtime, page);
  await finishDetailRequests(runtime);
  page.reloadChartsSafely();
  await runtime.env.advance(80);
  await runtime.env.advance(20);
  page.onListScroll({ detail: { scrollTop: 900 } });
  runtime.env.requests.filter((r) => r.name === 'charts').at(-1).resolve({ list: [chart(0), chart(1), chart(2)] });
  await drain();
  assert.equal(page.filteredCharts.value.length, 25);
  await runtime.env.advance(80);
  assert.equal(page.filteredCharts.value.length, 3);
});
await check('排行榜点击保留真实playlist chart路由全部编码字段', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime);
  const selected = { ...chart(0), id: '榜单/one & two', name: '中文 & / 名称',
    description: '说明 ? & =', picUrl: 'https://image.invalid/cover?v=1&a=2' };
  page.openChart(selected);
  const url = new URL(runtime.env.navigation.url, 'https://route.invalid');
  assert.equal(url.pathname, '/pages/playlist/index');
  assert.equal(url.searchParams.get('id'), selected.id);
  assert.equal(url.searchParams.get('platform'), 'wyy');
  assert.equal(url.searchParams.get('type'), 'chart');
  assert.equal(url.searchParams.get('name'), selected.name);
  assert.equal(url.searchParams.get('desc'), selected.description);
  assert.equal(url.searchParams.get('pic'), selected.picUrl);
});
await check('卸载取消原生测量/回顶/restore计时器，迟到rect和预览不能修改已销毁页面', async () => {
  const runtime = makeRuntime();
  runtime.env.deferRects = true;
  const page = pageRuntime(runtime);
  await bootCharts(runtime, page);
  const before = page.viewportHeight.value;
  assert.ok(runtime.env.rectCallbacks.length > 0);
  await runtime.env.fire('unmount');
  for (const callback of runtime.env.rectCallbacks) callback({ width: 500, height: 60 });
  for (const request of runtime.env.requests.filter((r) => r.name === 'chartDetail')) request.resolve({ list: [{ id: 'late', name: '迟到', singer: '歌手' }] });
  await runtime.env.advance(500);
  assert.equal(page.viewportHeight.value, before);
  assert.equal(runtime.env.requests.filter((r) => r.name === 'chartDetail').length, 2);
  assert.equal(page.chartLoader.previewSongs.value[0].length, 0);
});
await check('存档小于一像素的位置不占24源有效容量，非法身份和值不污染有效位置', async () => {
  const runtime = makeRuntime();
  const old = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`tiny${i}`, 0.1]));
  old.wyy = 501.9;
  old['bad:id'] = 99;
  old.qq = '600';
  old.negative = -10;
  runtime.env.storage.set('qt-chart-scroll', JSON.stringify(old));
  const tabs = load(read('services/chart-tabs.ts'), runtime.scope);
  assert.equal(tabs.readChartScroll('wyy'), 501, 'floor为0的旧条目不能挤掉真正可恢复的源');
  assert.equal(tabs.readChartScroll('bad:id'), 0);
  assert.equal(tabs.readChartScroll('qq'), 0);
  assert.equal(tabs.readChartScroll('negative'), 0);
  tabs.saveChartScroll('wyy', 700);
  tabs.flushChartScroll();
  assert.ok(Object.values(JSON.parse(runtime.env.storage.get('qt-chart-scroll'))).every((value) => Number.isInteger(value) && value > 0));
});
await check('首次异步进入QQ保持完整单行，切换不变宽，标题栏刷新防止重复请求', async () => {
  const runtime = makeRuntime();
  runtime.env.storage.set('qt-source', 'qq');
  pageRuntime(runtime, { viewport: { windowWidth: 393, windowHeight: 852 }, rect: { width: 393, height: 700 } }, true);
  const native = renderNativePage(runtime, null);
  await drain();
  const frame = native.find('native-frame-host')[0];
  assert.deepEqual(Array.from(frame.props['header-actions']), ['refresh']);
  assert.equal(frame.props['header-title-visible'], false);
  assert.equal(native.find('chart-toolbar').length, 0, '正文不再重复标题与缓存信息');
  assert.equal(native.find('chart-refresh').length, 0, '竖屏只在标题栏提供刷新');
  frame.props.onHeaderAction('refresh');
  const response = registryResponse(['wyy', 'qq', 'kw', 'kg', 'bili', 'mg']);
  const labels = ['网易云音乐', 'QQ音乐', '酷我音乐', '酷狗音乐', '哔哩哔哩', '咪咕音乐'];
  response.sources.forEach((source, index) => { source.name = labels[index]; source.short = labels[index]; });
  runtime.env.requests.find((request) => request.name === 'sourceRegistry').resolve(response);
  await drain();
  assert.deepEqual(native.find('qo-label').map((label) => label.text), labels);
  assert.equal(native.styleOf(native.find('qo-label')[1])['font-weight'], '600', 'QQ首帧已选中，不依赖手动切换触发布局');
  const widths = native.find('qo').map((chip) => native.pixels(chip, 'width'));
  function assertSingleRow() {
    assert.equal(native.styleOf(native.find('source-options')[0])['flex-direction'], 'row');
    assert.equal(native.find('source-strip')[0].props.direction, 'horizontal');
    assert.ok(native.pixels(native.find('source-options')[0], 'width') > native.pixels(native.find('source-strip')[0], 'width'));
    for (const label of native.find('qo-label')) assert.equal(native.styleOf(label)['white-space'], 'nowrap');
    for (const body of native.find('qo-body')) assert.equal(native.styleOf(body)['flex-shrink'], '0');
    assert.deepEqual(native.find('qo').map((chip) => native.pixels(chip, 'width')), widths, '选中与未选中的宽度预算相同');
    assertChipBoxesFit(chipRowBounds(native, runtime), 'cold selected QQ');
  }
  assertSingleRow();
  runtime.env.requests.find((request) => request.name === 'charts').resolve({ list: [chart(0, 'qq')] });
  await drain(); await finishDetailRequests(runtime); await runtime.env.advance(160);
  native.find('qo')[0].props.onClick({ stopPropagation() {} });
  await runtime.env.advance(80);
  assertSingleRow();
  runtime.env.requests.filter((request) => request.name === 'charts').at(-1).resolve({ list: [chart(0)] });
  await drain(); await finishDetailRequests(runtime); await runtime.env.advance(160);
  native.find('qo')[1].props.onClick({ stopPropagation() {} });
  await runtime.env.advance(160);
  assertSingleRow();
  assert.equal(native.styleOf(native.find('qo-label')[1])['font-weight'], '600');
  const requestsBefore = runtime.env.requests.filter((request) => request.name === 'charts').length;
  frame.props.onHeaderAction('refresh');
  frame.props.onHeaderAction('refresh');
  await runtime.env.advance(80);
  frame.props.onHeaderAction('refresh');
  await drain();
  const requests = runtime.env.requests.filter((request) => request.name === 'charts');
  assert.equal(requests.length, requestsBefore + 1, '标题栏连续刷新只发一条当前源请求');
  assert.equal(requests.at(-1).args.source, 'qq');
  requests.at(-1).reject(new Error('fixture refresh offline'));
  await drain();
  assert.equal(native.find('rank-card').length, 1, '刷新失败不清空已显示榜单');
  assert.ok(runtime.scope.qtToastItems().some((item) => /刷新失败.*保留原榜单/.test(item.text)));
  native.app.unmount();
  runtime.scope.pauseQtLayoutWatcher();
});
await check('实际完整模板六异步长音源/huge横滚行必须有完整px内容宽，anchor不替代几何', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime, { viewport: { windowWidth: 320, windowHeight: 720 }, rect: { width: 300, height: 500 } });
  runtime.scope.fontScale.setTier('huge');
  const native = renderNativePage(runtime, page);
  await drain();
  assert.equal(native.find('source-options').length, 0, '实际v-if在异步音源到货前不渲染横滚行');
  assert.equal(page.selectionIndex.value, -1);
  await runtime.env.fire('mount');
  const ids = ['wyy', 'qq', 'kg', 'bili', 'sony', 'spotify'];
  const labels = ['网易云音乐完整排行榜', 'QQ音乐长标签精选', '酷狗音乐经典新歌', '哔哩哔哩音乐与现场', '索尼精选古典WMWM', 'Spotify海外精选音源'];
  const response = registryResponse(ids);
  response.sources.forEach((source, index) => { source.name = labels[index]; source.short = labels[index]; });
  runtime.env.requests.find((request) => request.name === 'sourceRegistry').resolve(response);
  await drain();
  assert.equal(native.find('source-option').length, 6);
  assert.equal(native.find('qo').length, 6, 'QtOption实际setup/template而非私有替代组件');
  const row = native.find('source-options')[0];
  const rowStyle = cssValues(row.props.style);
  assert.match(String(rowStyle.width), /^\d+(?:\.\d+)?px$/, '原生横向内容行必须真实绑定px总宽');
  const widths = labels.map((label) => runtime.scope.qtOptionChipWidthPx(label, true));
  const required = Math.ceil(widths.reduce((sum, width) => sum + width, 0) + 5 * runtime.scope.qtRpx(16) + 2 * runtime.scope.qtRpx(24));
  assert.ok(parseFloat(rowStyle.width) >= required, '总宽必须包含完整六标签、gap和padding，而非仅viewport宽');
  function verifyRenderedRow() {
    const cells = native.find('source-option');
    const chips = native.find('qo');
    const texts = native.find('qo-label');
    assert.equal(cells.length, 6); assert.equal(chips.length, 6);
    assert.deepEqual(texts.map((text) => text.text), labels, '真实组件收到实际注册表长标签');
    const widths = labels.map((label) => runtime.scope.qtOptionChipWidthPx(label, true));
    const gap = page.layout.isWide ? 8 : runtime.scope.qtRpx(16);
    const pad = page.layout.isWide ? 16 : runtime.scope.qtRpx(24);
    const expected = Math.ceil(widths.reduce((sum, width) => sum + width, 0) + gap * 5 + pad * 2);
    const actual = cssValues(native.find('source-options')[0].props.style);
    assert.equal(parseFloat(actual.width), expected, '完整真实内容宽随live窗口/字号/标签重新计算');
    for (let index = 0; index < cells.length; index++) {
      const cellStyle = cssValues(cells[index].props.style);
      const chipStyle = cssValues(chips[index].props.style);
      assert.equal(parseFloat(cellStyle.width), widths[index], 'wrapper不截断共享border-box宽');
      assert.equal(parseFloat(chipStyle.width), widths[index], '实际QtOption root通过style fallthrough同宽');
      assert.equal(parseFloat(cellStyle['margin-right']), index < 5 ? gap : 0, '末项不留下未计入的gap');
      assert.equal(cssValues(texts[index].props.style)['font-weight'], index === page.selectionIndex.value ? '600' : '400');
      assert.equal(cssValues(texts[index].props.style)['white-space'], 'nowrap', '长音源名也不允许折行');
    }
    const strip = native.find('source-strip')[0];
    assert.equal(strip.props.direction, 'horizontal');
    assert.ok(parseFloat(cssValues(strip.props.style).height) >= runtime.scope.qtOptionChipMinHeightPx() + 8);
    return expected;
  }
  verifyRenderedRow();
  runtime.env.requests.find((request) => request.name === 'charts').resolve({ list: [chart(0)] });
  await drain(); await finishDetailRequests(runtime); await runtime.env.advance(160);
  native.find('qo')[5].props.onClick({ stopPropagation() {} }); // 真实QtOption pick/emit -> 原页面onChipTap。
  await runtime.env.advance(160);
  runtime.env.requests.filter((request) => request.name === 'charts').at(-1).resolve({ list: [chart(1, 'spotify')] });
  await drain(); await finishDetailRequests(runtime); await runtime.env.advance(160);
  const target = native.find('source-option')[5].props.id;
  assert.equal(page.selectionIndex.value, 5);
  assert.equal(native.find('source-strip')[0].props['scroll-into-view'], target);
  let vectors = 0;
  for (const [width, height] of [[320, 720], [800, 480], [1100, 680], [400, 800]]) {
    for (const tier of ['tiny', 'small', 'normal', 'large', 'huge']) {
      runtime.scope.fontScale.setTier(tier);
      await drain();
      assert.equal(native.find('source-strip')[0].props['scroll-into-view'], '');
      runtime.env.viewport.windowWidth = width; runtime.env.viewport.windowHeight = height;
      runtime.env.rect.width = width - 30;
      const poll = [...runtime.env.timers.values()].find((timer) => timer.repeat === 1000);
      assert.ok(poll);
      await runtime.env.advance(poll.at - runtime.env.time); // 真实QtLayout native poll，不直接改layout。
      await runtime.env.advance(32);
      assert.equal(page.layout.windowWidth, width);
      assert.equal(page.layout.windowHeight, height);
      verifyRenderedRow();
      assert.equal(native.find('source-strip')[0].props['scroll-into-view'], target);
      vectors++;
    }
  }
  const oldWidth = verifyRenderedRow();
  labels[5] += '·同ID异步新增最长标签WMWM';
  const renamed = page.sourceRegistry.refresh();
  await drain();
  const renameResponse = registryResponse(ids);
  renameResponse.sources.forEach((source, index) => { source.name = labels[index]; source.short = labels[index]; });
  runtime.env.requests.filter((request) => request.name === 'sourceRegistry').at(-1).resolve(renameResponse);
  await renamed; await drain();
  assert.equal(native.find('source-strip')[0].props['scroll-into-view'], '');
  assert.ok(verifyRenderedRow() > oldWidth, '同ID新标签到货扩宽，不能沿用旧内容尺寸');
  await runtime.env.advance(32);
  assert.equal(native.find('source-strip')[0].props['scroll-into-view'], target);
  const replaced = page.sourceRegistry.refresh();
  await drain();
  renameResponse.sources[5].id = 'replacement';
  runtime.env.requests.filter((request) => request.name === 'sourceRegistry').at(-1).resolve(renameResponse);
  await replaced; await drain();
  assert.equal(page.selectionIndex.value, -1, '旧活动ID消失但native旧榜树仍等待safe-top时没有错误选择');
  verifyRenderedRow();
  assert.equal(native.find('source-strip')[0].props['scroll-into-view'], '');
  assert.equal(native.find('qo-label').filter((text) => cssValues(text.props.style)['font-weight'] === '600').length, 0);
  console.log(`    source row: ${vectors} live real-template vectors + async same-ID resize + invalid-ID selection`);
  native.app.unmount();
  await runtime.env.fire('unmount');
});
await check('desktop真实模板/stylesheet的84px封面与12px卡内距必须配固定px圆角', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime, { viewport: { windowWidth: 2560, windowHeight: 1440 }, rect: { width: 1800, height: 600 } });
  const native = renderNativePage(runtime, page);
  await drain();
  const card = native.find('rank-card')[0];
  const placeholder = native.find('rank-cover-placeholder')[0];
  assert.equal(native.pixels(placeholder, 'width'), 84);
  assert.equal(native.pixels(card, 'padding'), 12);
  const radius = native.pixels(placeholder, 'border-radius');
  const cardRadius = native.pixels(card, 'border-radius');
  assert.equal(radius, 12, `2560px native stylesheet fallback cover radius ${radius}px不能跟随rpx膨胀`);
  assert.equal(cardRadius, 18, 'fixed px padding的desktop卡圆角固定18px');
  function verifyRadii(expectedCard, expectedCover) {
    const cards = native.find('rank-card');
    const covers = [...native.find('rank-cover'), ...native.find('rank-cover-placeholder')];
    assert.ok(cards.length > 0 && covers.length > 0);
    for (const element of cards) assert.ok(Math.abs(native.pixels(element, 'border-radius') - expectedCard) < 1e-9);
    for (const element of covers) assert.ok(Math.abs(native.pixels(element, 'border-radius') - expectedCover) < 1e-9);
    if (page.layout.isWide) {
      for (const element of cards) { assert.equal(native.styleOf(element)['border-radius'], '18px'); assert.equal(native.pixels(element, 'padding'), 12); }
      for (const element of covers) { assert.equal(native.styleOf(element)['border-radius'], '12px'); assert.equal(native.pixels(element, 'width'), 84); }
    }
  }
  verifyRadii(18, 12); // 实际初次骨架的card/placeholder，同样必须有wide覆盖。
  await bootCharts(runtime, page, ['wyy'], [chart(0), { ...chart(1), picUrl: '' }, chart(2)]);
  await finishDetailRequests(runtime);
  assert.equal(native.find('rank-cover').length, 2, '真实v-if使用两张已需求封面');
  assert.equal(native.find('rank-cover-placeholder').length, 1, '无封面榜使用真实v-else placeholder');
  verifyRadii(18, 12);
  const listRequests = runtime.env.requests.filter((request) => request.name === 'charts').length;
  const details = runtime.env.requests.filter((request) => request.name === 'chartDetail').length;
  let vectors = 0;
  // Expected compact logical pixels are legacy 18rpx/12rpx worked examples, not page-helper copies.
  for (const [width, height, cardExpected, coverExpected] of [
    [320, 720, 7.68, 5.12], [400, 800, 9.6, 6.4], [800, 480, 18, 12],
    [1100, 680, 18, 12], [1280, 720, 18, 12], [2560, 1440, 18, 12],
  ]) {
    for (const tier of ['tiny', 'small', 'normal', 'large', 'huge']) {
      runtime.scope.fontScale.setTier(tier);
      runtime.env.viewport.windowWidth = width; runtime.env.viewport.windowHeight = height;
      runtime.env.rect.width = Math.min(width - 30, 1800);
      const poll = [...runtime.env.timers.values()].find((timer) => timer.repeat === 1000);
      assert.ok(poll);
      await runtime.env.advance(poll.at - runtime.env.time);
      await runtime.env.advance(32);
      assert.equal(page.layout.windowWidth, width); assert.equal(page.layout.windowHeight, height);
      assert.equal(native.find('rank-cover').length, 2); assert.equal(native.find('rank-cover-placeholder').length, 1);
      verifyRadii(cardExpected, coverExpected);
      vectors++;
    }
  }
  assert.equal(runtime.env.requests.filter((request) => request.name === 'charts').length, listRequests, '只改圆角，不能重新请求榜单');
  assert.equal(runtime.env.requests.filter((request) => request.name === 'chartDetail').length, details, '窗口/字体圆角重排不丢已就绪预览');
  assert.equal(page.selectionIndex.value, 0);
  assert.equal(native.find('source-strip')[0].props['scroll-into-view'], '', '首项已可见时不发延迟滚动指令');
  console.log(`    radii: ${vectors} live actual stylesheet vectors + cold skeleton + demanded image/fallback`);
  native.app.unmount();
  await runtime.env.fire('unmount');
});
await check('骨架与真实深滚back-top全部radius有wide规则；圆形clamp不作为新像素RED', async () => {
  const runtime = makeRuntime();
  const page = pageRuntime(runtime, { viewport: { windowWidth: 2560, windowHeight: 1440 }, rect: { width: 1800, height: 600 } });
  const native = renderNativePage(runtime, page);
  const windows = [[320, 720, false], [400, 800, false], [800, 480, true], [1100, 680, true], [1280, 720, true], [2560, 1440, true]];
  async function setVector(width, height, tier, wide) {
    runtime.scope.fontScale.setTier(tier);
    runtime.env.viewport.windowWidth = width; runtime.env.viewport.windowHeight = height;
    runtime.env.rect.width = Math.min(width - 30, 1800);
    const poll = [...runtime.env.timers.values()].find((timer) => timer.repeat === 1000);
    assert.ok(poll);
    await runtime.env.advance(poll.at - runtime.env.time); await runtime.env.advance(32);
    assert.equal(page.layout.windowWidth, width); assert.equal(page.layout.windowHeight, height);
    assert.equal(page.layout.isWide, wide);
  }
  let coldVectors = 0;
  for (const [width, height, wide] of windows) {
    for (const tier of ['tiny', 'small', 'normal', 'large', 'huge']) {
      await setVector(width, height, tier, wide);
      const headings = native.find('skeleton-heading'); const lines = native.find('skeleton-line');
      assert.ok(headings.length > 0 && lines.length > 0);
      for (const heading of headings) assert.equal(native.styleOf(heading)['border-radius'], wide ? '8px' : '8rpx', '实际cold节点的源规范px覆盖，不宣称native half-height clip度量');
      for (const line of lines) assert.equal(native.styleOf(line)['border-radius'], wide ? '6px' : '6rpx');
      coldVectors++;
    }
  }
  await bootCharts(runtime, page, ['wyy']);
  await finishDetailRequests(runtime);
  // Increase the unkeyed prefix from legal near-end scrolls before reaching the deep button.
  const scroller = native.find('chart-scroll')[0];
  for (const top of [300, 450, 600, 800]) {
    const before = native.find('rank-card').length;
    const stride = native.pixels(native.find('rank-card')[0], 'height') + native.pixels(native.find('rank-card')[0], 'margin-bottom');
    assert.ok(top <= Math.ceil(before / 3) * stride - 600, '输入滚动量在已渲染行可达范围内');
    scroller.props.onScroll({ detail: { scrollTop: top } });
    await drain(); await finishDetailRequests(runtime);
    assert.ok(native.find('rank-card').length >= before, '几何修改不缩回稳定原生前缀');
  }
  assert.equal(native.find('rank-card').length, 25);
  assert.equal(native.find('back-top').length, 1, '实际原onListScroll与v-if显示back-top，而非注入showBackTop');
  const lists = runtime.env.requests.filter((request) => request.name === 'charts').length;
  const details = runtime.env.requests.filter((request) => request.name === 'chartDetail').length;
  let warmVectors = 0;
  for (const [width, height, wide] of windows) {
    for (const tier of ['tiny', 'small', 'normal', 'large', 'huge']) {
      await setVector(width, height, tier, wide);
      const button = native.find('back-top')[0];
      assert.ok(button);
      assert.equal(native.styleOf(button)['border-radius'], wide ? '22px' : '44rpx', '源规范固定px；旧超大radius可能已夹成相同圆形，不计新像素RED');
      const radius = native.pixels(button, 'border-radius');
      const size = native.pixels(button, 'width');
      assert.ok(Math.abs(size - radius * 2) < 1e-9);
      assert.equal(native.pixels(button, 'height'), size);
      assert.equal(native.find('rank-card').length, 25);
      warmVectors++;
    }
  }
  assert.equal(runtime.env.requests.filter((request) => request.name === 'charts').length, lists);
  assert.equal(runtime.env.requests.filter((request) => request.name === 'chartDetail').length, details, 'radius/font/window改动不重拉已完整就绪预览');
  native.find('back-top')[0].props.onClick();
  await drain(); await runtime.env.advance(160);
  assert.equal(native.find('back-top').length, 0);
  assert.equal(native.find('rank-card').length, 25, '真实backToTop点击后前缀也不收缩');
  assert.equal(runtime.env.requests.filter((request) => request.name === 'charts').length, lists);
  assert.equal(runtime.env.requests.filter((request) => request.name === 'chartDetail').length, details);
  console.log(`    radius rule protections: ${coldVectors} cold + ${warmVectors} deep-scroll vectors; no extra pixel RED claimed`);
  native.app.unmount(); await runtime.env.fire('unmount');
});
await check('whole SFC / QtOption 全CSS 校准 Native literal 后，六实根与行padding必须完整留在横向视口', async () => {
  const runtime = makeRuntime();
  pageRuntime(runtime, { viewport: { windowWidth: 1098, windowHeight: 686 },
    rect: { width: 1670 / nativeChipReceipt.pixelRatio, height: 930 / nativeChipReceipt.pixelRatio } }, true);
  const native = renderNativePage(runtime, null); // Actual complete compileScript/inlineTemplate + Vue lifecycle.
  await drain();
  assert.equal(native.find('source-options').length, 0, 'no synthetic row before actual async registry arrival');
  const ids = ['wyy', 'qq', 'kw', 'kg', 'bili', 'mg'];
  const labels = ['网易云音乐', 'QQ音乐', '酷我音乐', '酷狗音乐', '哔哩哔哩', '咪咕音乐'];
  const response = registryResponse(ids);
  response.sources.forEach((source, index) => { source.name = labels[index]; source.short = labels[index]; });
  runtime.env.requests.find((request) => request.name === 'sourceRegistry').resolve(response);
  await drain();
  runtime.env.requests.find((request) => request.name === 'charts').resolve({ list: Array.from({ length: 25 }, (_, index) => chart(index)) });
  await drain(); await finishDetailRequests(runtime); await runtime.env.advance(160);
  assert.deepEqual(native.find('qo-label').map((element) => element.text), labels);
  const listCount = runtime.env.requests.filter((request) => request.name === 'charts').length;
  native.find('qo')[5].props.onClick({ stopPropagation() {} }); // Public QtOption pick/emit -> actual complete page handler.
  await runtime.env.advance(80);
  assert.equal(runtime.env.requests.filter((request) => request.name === 'charts').length, listCount + 1);
  runtime.env.requests.filter((request) => request.name === 'charts').at(-1).resolve({ list: Array.from({ length: 9 }, (_, index) => chart(index, 'mg')) });
  await drain(); await finishDetailRequests(runtime); await runtime.env.advance(160);
  assert.equal(cssValues(native.find('qo-label')[5].props.style)['font-weight'], '600');
  assert.equal(native.find('rank-card').length, 9, 'foreground selected source/list matches the captured pane');

  // Independent default component calibration remains after the page-owned fix:
  // unchanged real QtOption, public width-only input, actual bound min-height/CSS.
  // No page source reversal, replacement QtOption, copied M+14, or Native-after claim.
  // Preserve the OLD device width receipts using the default metric. The chart's
  // new opt-in no-wrap budget is deliberately wider; these are not after measurements.
  const probes = labels.map((label, index) => native.probeOption({ label, kind: 'chip',
    selected: index === 5, style: 'width:' + runtime.scope.qtOptionChipWidthPx(label) + 'px;' }));
  await drain();
  const calibration = chipRowBounds(native, runtime, probes.map((probe) => probe.element));
  const px = (value) => Math.round(value * nativeChipReceipt.pixelRatio);
  assert.equal(px(calibration.stripHeight), nativeChipReceipt.strip[3] - nativeChipReceipt.strip[1]);
  assert.equal(px(calibration.rowHeight), nativeChipReceipt.row[3]);
  const legacyWidth = Math.ceil(calibration.padding.left + calibration.padding.right +
    calibration.roots.reduce((sum, chip) => sum + chip.width + chip.marginRight, 0));
  assert.equal(px(legacyWidth), nativeChipReceipt.row[2]);
  assert.equal(px(native.pixels(native.find('rank-card')[0], 'height')), nativeChipReceipt.explicitCardHeight,
    'same Native ui.a class independently measured an explicit border-box height including padding/border');
  let legacyLeft = calibration.padding.left;
  for (const [index, chip] of calibration.roots.entries()) {
    assert.equal(px(chip.height), nativeChipReceipt.roots[index][3], 'literal measured default QtOption root height');
    assert.equal(px(chip.width), nativeChipReceipt.roots[index][2], 'literal actual root width, not the wrapper rounding');
    assert.equal(px(chip.top), nativeChipReceipt.wrappers[index][1]);
    assert.equal(px(chip.bottom), nativeChipReceipt.wrappers[index][3]);
    assert.equal(px(chip.lineHeight), nativeChipReceipt.labelHeight);
    assert.equal(px(chip.labelTop), nativeChipReceipt.labelTop);
    assert.equal(px(chip.labelTop + chip.lineHeight), nativeChipReceipt.labelBottom);
    assert.ok(Math.abs(px(legacyLeft) - nativeChipReceipt.wrappers[index][0]) <= 1, 'position rounding is not glyph/Yoga certification');
    legacyLeft += chip.width + chip.marginRight;
  }
  probes.forEach((probe) => probe.app.unmount());
  const bounds = chipRowBounds(native, runtime);
  for (const chip of bounds.roots) assert.equal(chip.element.parent, chip.wrapper, 'real selected pane roots, not probe or Home-underlay nodes');
  const first = bounds.roots[0];
  console.log('    Native-calibrated whole-SFC observation:', JSON.stringify({
    literalPhysicalRootClip: 10, literalPhysicalRowBudgetOverflow: 17,
    strip: px(bounds.stripHeight), row: px(bounds.rowHeight), rootTop: px(first.top), root: px(first.height),
    rootBottom: px(first.bottom), rootPlusRowPadding: px(first.bottom + bounds.padding.bottom) }));
  assertChipBoxesFit(bounds, 'Native-calibrated complete production SFC'); // The one genuine new RED before production edits.

  // Post-GREEN protections: source/calibrated-domain vectors, not 20 Native runs.
  const target = native.find('source-option')[5].props.id;
  const stableIds = native.find('source-option').map((element) => element.props.id);
  const prefix = native.find('rank-card');
  const chartsBeforeVectors = runtime.env.requests.filter((request) => request.name === 'charts').length;
  let vectors = 0;
  for (const [width, height] of [[320, 720], [800, 480], [1100, 680], [400, 800]]) {
    for (const preset of runtime.scope.QT_FONT_TIERS) {
      runtime.scope.fontScale.setTier(preset.id); // Actual shared store; never assign scale/layout internals.
      await drain();
      runtime.env.viewport.windowWidth = width; runtime.env.viewport.windowHeight = height;
      runtime.env.rect.width = width - 30; runtime.env.rect.height = height - 200;
      const poll = [...runtime.env.timers.values()].find((timer) => timer.repeat === 1000);
      assert.ok(poll, 'actual shared layout Native poll owns window reflow');
      await runtime.env.advance(poll.at - runtime.env.time);
      await runtime.env.advance(32);
      const reflowed = chipRowBounds(native, runtime);
      assertChipBoxesFit(reflowed, width + '/' + preset.id + ' complete-SFC calibrated domain');
      assert.deepEqual(native.find('source-option').map((element) => element.props.id), stableIds);
      const selectedEnd = reflowed.padding.left + reflowed.roots.slice(0, 6).reduce((sum, chip, index) =>
        sum + chip.wrapperWidth + (index < 5 ? chip.marginRight : 0), 0);
      const needsReveal = selectedEnd > native.pixels(reflowed.strip, 'width') + 0.5;
      assert.equal(reflowed.strip.props['scroll-into-view'], needsReveal ? target : '', '字体/窗口变化后只揭示越界的选中标签');
      assert.equal(cssValues(native.find('qo-label')[5].props.style)['font-weight'], '600');
      for (const [index, element] of prefix.entries()) assert.equal(native.find('rank-card')[index], element, 'live reflow does not shrink/replace the rendered prefix');
      assert.equal(runtime.env.requests.filter((request) => request.name === 'charts').length, chartsBeforeVectors);
      vectors++;
    }
  }
  const registry = runtime.scope.useSourceRegistryStore(); // Real public store/API arrival, not a page-private call.
  const oldWidth = chipRowBounds(native, runtime).width;
  labels[5] += '·同ID异步新增长标签WMWM';
  const renamed = registry.refresh();
  await drain();
  const renamedResponse = registryResponse(ids);
  renamedResponse.sources.forEach((source, index) => { source.name = labels[index]; source.short = labels[index]; });
  runtime.env.requests.filter((request) => request.name === 'sourceRegistry').at(-1).resolve(renamedResponse);
  await renamed; await drain();
  assert.equal(native.find('source-strip')[0].props['scroll-into-view'], '', 'same-ID changed label resets the concrete reveal');
  assert.ok(chipRowBounds(native, runtime).width > oldWidth);
  assertChipBoxesFit(chipRowBounds(native, runtime), 'same-ID async longer label');
  await runtime.env.advance(32);
  assert.equal(native.find('source-strip')[0].props['scroll-into-view'], target);
  await runtime.env.advance(160);
  native.find('chart-scroll')[0].props.onScroll({ detail: { scrollTop: 1500 } }); // Public SDK scroll event.
  await drain();
  assert.equal(native.find('back-top').length, 1, 'deep scroll was accepted outside programmatic suppression');
  const deepPrefix = native.find('rank-card');
  const replaced = registry.refresh();
  await drain();
  renamedResponse.sources[5].id = 'replacement';
  runtime.env.requests.filter((request) => request.name === 'sourceRegistry').at(-1).resolve(renamedResponse);
  await replaced; await drain();
  assert.equal(native.find('source-strip')[0].props['scroll-into-view'], '', 'missing current ID has no stale/incorrect reveal');
  assert.equal(native.find('qo-label').filter((element) => cssValues(element.props.style)['font-weight'] === '600').length, 0);
  assertChipBoxesFit(chipRowBounds(native, runtime), 'invalid current source during real awaitTop');
  await runtime.env.advance(40);
  assert.equal(native.find('rank-card').length, deepPrefix.length, 'awaitTop must retain the old complete group before the 80ms boundary');
  for (const [index, element] of deepPrefix.entries()) assert.equal(native.find('rank-card')[index], element, 'safe-top pending keeps the stable prefix nodes');
  assert.equal(native.find('rank-card').length, 9, 'old selected-source list is not replaced early');
  await runtime.env.advance(160); await finishDetailRequests(runtime);
  assert.ok(native.find('rank-card').length > 0, 'after safe-top the warm source renders its visible prefix');
  native.find('rank-heading')[0].props.onClick();
  assert.match(runtime.env.navigation.url, /platform=wyy/, 'the new visible cards belong to the warm destination source');
  assert.equal(runtime.scope.readChartListSnapshot('wyy').charts.length, 25);
  assert.equal(runtime.env.requests.filter((request) => request.name === 'charts').length, chartsBeforeVectors, 'reflow/rename/invalid-ID warm handoff does not refetch lists');
  console.log('    whole-SFC protections:', vectors + ' live source/font vectors; same-ID async label; invalid ID; public sixth pick; awaitTop/stable prefix');
  native.app.unmount();
  runtime.scope.pauseQtLayoutWatcher(); // Synthetic App owns the real shared global watcher.
  await runtime.env.advance(500);
});
console.log(`\n${passes} passed (production-function, route lifecycle and whole-SFC Native-calibrated regressions; not device measurements)`);
