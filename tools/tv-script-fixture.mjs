// Import binding for legacy page-script regressions. The production TV controller,
// navigation, layout, font store and owner modules run unchanged. Only the existing
// Vue/uni/native/clock host boundaries are supplied here; no TV policy is reimplemented.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as Vue from 'vue';
import ts from 'typescript';
import { preprocessPlatform } from './platform-preprocess.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const instances = new WeakMap();
const noop = () => {};
export function tvScriptFixture(host, options = {}) {
  // Existing callers keep their exact default bindings; lifecycle/modal adapters are opt-in.
  const custom = Object.keys(options).length > 0;
  if (!custom && instances.has(host.uni)) return instances.get(host.uni);
  const vue = options.vueOverrides == null ? Vue : { ...Vue, ...options.vueOverrides };
  const cache = new Map();
  const native = {
    tvReadDevice: () => ({ television: false, leanback: false, nativeAvailable: false, uiModeType: 1 }),
    tvStartRemote: noop, tvSetRemoteState: noop, tvStopRemote: noop, tvPresent: noop,
    tvCollect: () => [], tvHighlight: noop, tvActivate: noop, tvScroll: () => false, tvBack: noop,
  };
  // Layout polling belongs to the UI host clock, separate from the legacy
  // authentication polling clock whose exact counts those regressions assert.
  const uiTimers = new Map(); let serial = 0;
  const viewport = { windowWidth: 390, windowHeight: 844, screenHeight: 844, safeAreaInsets: { bottom: 0 } };
  const context = { ...host, console, getCurrentPages: options.getCurrentPages ?? (() => []),
    uni: { getWindowInfo: () => viewport, getSystemInfoSync: () => viewport, ...host.uni },
    setInterval: fn => { const id = ++serial; uiTimers.set(id, fn); return id; },
    clearInterval: id => uiTimers.delete(id),
    setTimeout: fn => { const id = ++serial; uiTimers.set(id, fn); return id; },
    clearTimeout: id => uiTimers.delete(id) };
  // These timer records never schedule host work; their lifetime is the weakly
  // cached UI fixture. Do not add a lifecycle hook to the business-only host.
  function load(request, from = resolve(root, 'fixture.ts')) {
    if (request === 'vue') return vue;
    if (request === '@/services/tv-platform') return native;
    // The legacy host already owns diagnostic delivery; these cases do not assert logs.
    if (request === '@/services/logger') return { logWarn: host.logWarn ?? noop };
    let path = request.startsWith('@/') ? resolve(root, request.slice(2)) : resolve(dirname(from), request);
    if (!existsSync(path)) path += '.ts';
    if (cache.has(path)) return cache.get(path).exports;
    const source = preprocessPlatform(readFileSync(path, 'utf8'), 'APP-ANDROID');
    const output = ts.transpileModule(source, { fileName: path, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } });
    const module = { exports: {} }; cache.set(path, module);
    vm.runInNewContext(output.outputText, { ...context, exports: module.exports, module,
      require: value => load(value, path) }, { filename: path });
    return module.exports;
  }
  const api = { ...load('@/uni_modules/qt-ui/composables/use-qt-tv'),
    ...load('@/uni_modules/qt-ui/composables/use-qt-layout'),
    ...load('@/uni_modules/qt-ui/composables/use-qt-widths'),
    ...load('@/uni_modules/qt-ui/stores/font-scale') };
  if (options.ownerModules) Object.assign(api, load('@/uni_modules/qt-ui/composables/qt-page-chrome'),
    load('@/uni_modules/qt-ui/composables/qt-wide-workspace'));
  if (options.modal) Object.assign(api, load('@/uni_modules/qt-ui/composables/use-qt-tv-modal'));
  // Preserve the original phone-only regression setup. No app lifecycle or remote
  // subscription is invented for a page-script test that never ran App.onShow.
  if (!custom) instances.set(host.uni, api);
  return api;
}
