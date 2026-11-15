// Complete production Android UTS + complete QtPlaylistPicker template.
// Only Android SDK, DOM geometry, event delivery and the host are substituted.
// These assertions establish collector behavior, not device/IME/Yoga acceptance.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { tvSettingsFixture } from './check-tv-settings.mjs';

const nativeUrl = new URL('../uni_modules/qt-tv-native/utssdk/app-android/index.uts', import.meta.url);
const source = readFileSync(nativeUrl, 'utf8');
class Base {}
class NativeMap extends Map {
  put(key, value) { this.set(key, value); }
  containsKey(key) { return this.has(key); }
}
class Rect {
  constructor(left = 0, top = 0, width = 0, height = 0) {
    Object.assign(this, { left, top, width, height, right: left + width, bottom: top + height });
  }
}
class TouchEvent { constructor(type) { this.type = type; } }
const walk = node => [node, ...node.children.flatMap(walk)];
const eventName = name => 'on' + name[0].toUpperCase() + name.slice(1);
function collector() {
  const android = { getUniActivity: () => null, getAppContext: () => null };
  const dependencies = {
    'io.dcloud.uts': { UTSAndroid: android },
    'android.os.Handler': class { post(task) { task.run(); } },
    'android.os.Looper': { getMainLooper: () => 1, myLooper: () => 1 },
    'java.util.concurrent.ConcurrentHashMap': NativeMap,
    'io.dcloud.uniappxv.bridge.CEventManager': {
      hasElementEventListener: (node, name) => typeof node.original.props[eventName(name)] === 'function',
    },
  };
  const module = { exports: {} };
  const compiled = ts.transpileModule(source.replace(/^@UTSJS\.keepAlive\s*$/m, '').replace(/^@Suppress\([^\n]*\)\s*$/gm, ''), {
    fileName: 'index.ts', compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(compiled, { module, exports: module.exports, console, DOMRect: Rect, UniTouchEvent: TouchEvent,
    UniActivityWindowCallback: Base, UniActivityLifeCycleCallback: Base, require: name => dependencies[name] ?? Base }, { filename: nativeUrl.pathname });
  return module.exports;
}
function sdkTree(b, panel, list, count) {
  const all = walk(panel), nodes = new Map(), rowIndex = new Map(); let serial = 0;
  const state = { start: count - 3, geometryReads: 0, taps: [] };
  const activity = {
    getResources: () => ({ getDisplayMetrics: () => ({ density: { toDouble: () => 1 } }) }),
    getWindow: () => ({ getDecorView: () => ({ getWidth: () => ({ toDouble: () => 1280 }), getHeight: () => ({ toDouble: () => 720 }) }) }),
  };
  for (const node of all) {
    const id = node.props['data-qt-tv-id'];
    if (typeof id !== 'string' || !id.startsWith('playlist-picker-item:')) continue;
    const index = Number(id.split(':p')[1]);
    for (const child of walk(node)) rowIndex.set(child, index);
    if (node.parent) rowIndex.set(node.parent, index);
  }
  for (const original of all) {
    if (original.tag.startsWith('#')) continue;
    const id = ++serial;
    nodes.set(original, {
      original, tagName: original.tagName, isConnected: true, uniPage: { appId: 'app', pageId: 'picker' },
      classList: String(original.props.class ?? '').split(/\s+/),
      style: { getPropertyValue: key => b.css(original)[key] ?? '' },
      dataset: { get: key => original.props['data-' + key.replace(/[A-Z]/g, x => '-' + x.toLowerCase())] ?? null },
      getNodeId: () => id, getAnyAttribute: key => original.props[key] ?? null,
      getAndroidView: () => null, getAndroidActivity: () => activity,
      dispatchEvent: event => { state.taps.push(original.props['data-qt-tv-id']); original.props[eventName(event.type)]?.({ stopPropagation() {} }); },
      getBoundingClientRect: () => {
        state.geometryReads++;
        return original === panel ? new Rect(0, 0, 560, 600) : original === list ? new Rect(20, 100, 520, 230)
          : rowIndex.has(original) ? new Rect(20, 100 + (rowIndex.get(original) - state.start) * 77, 520, 76) : new Rect(20, 20, 500, 56);
      },
    });
  }
  for (const [original, node] of nodes) {
    node.children = original.children.map(child => nodes.get(child)).filter(Boolean);
    node.parentElement = nodes.get(original.parent) ?? null;
  }
  return { root: nodes.get(panel), nodes, state };
}
const rowIds = rows => rows.filter(row => row.id.includes(':custom:playlist-picker-item:')).map(row => row.id);
const expectedRows = start => Array.from({ length: 3 }, (_, index) => 'tv:app:picker:custom:playlist-picker-item:p' + (start + index));
for (const count of [20, 120, 300, 600]) {
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720 });
  try {
    await b.mount('uni_modules/qt-ui/components/qt-playlist-picker/qt-playlist-picker.uvue', {
      visible: true, song: null, playlists: Array.from({ length: count }, (_, index) => ({ id: 'p' + index, name: 'Playlist ' + index, picUrl: '', tracks: [] })),
      selectedIds: [], createPlaylist: () => null,
    }, false);
    const sdk = sdkTree(b, b.byClass('qs-panel')[0], b.byClass('picker-list')[0], count), api = collector();
    const expected = expectedRows(count - 3); let rows = [];
    // Refresh is the public poll/scroll seam. A bounded traversal may continue on
    // later refreshes, but visible tail actions must converge, never starve.
    for (let pass = 0; pass < 24; pass++) rows = api.collectTvCandidates(sdk.root);
    assert.deepEqual([...new Set(rowIds(rows))].sort(), expected.sort(), count + ' playlists: all visible tail rows are focusable');
    api.activateTvElement(expected[1]);
    assert.deepEqual(sdk.state.taps, ['playlist-picker-item:p' + (count - 2)], 'one native OK delivers one original picker action');
    sdk.state.start = 0;
    rows = api.collectTvCandidates(sdk.root);
    assert.equal(rowIds(rows).some(id => expected.includes(id)), false, 'offscreen retained candidates disappear immediately');
    for (let pass = 0; pass < 24; pass++) rows = api.collectTvCandidates(sdk.root);
    assert.deepEqual([...new Set(rowIds(rows))].sort(), expectedRows(0).sort(), 'scrolling back finds the first three rows');
    api.collectTvCandidates(null);
    const before = sdk.state.taps.length; api.activateTvElement(expectedRows(0)[0]);
    assert.equal(sdk.state.taps.length, before, 'old-scope IDs never activate after scope removal');
    console.log('PASS native collector: ' + count + ' playlist tail/head, single activation, stale visibility and scope release');
  } finally { await b.close(); }
}
console.log('TV native collector: 4 groups passed (actual production module/template; SDK/geometry host boundaries).');
