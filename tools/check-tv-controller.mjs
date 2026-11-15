import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tvSettingsFixture } from './check-tv-settings.mjs';

// Public seam: the real shared controller/layout/font APIs, with only the
// device, native key/geometry bridge and SDK clock replaced at their boundary.
const UI = 'uni_modules/qt-ui/';
const candidate = (id, left = 0, top = 0) => ({ id, left, top, width: 56, height: 76,
  visible: true, enabled: true, input: false, longPress: true });
async function fixture({ width = 1920, height = 1080, mode = '', television = false,
  leanback = false, nativeAvailable = true } = {}) {
  const device = { television, leanback, nativeAvailable, uiModeType: television ? 4 : 1 };
  const bridge = { start: 0, stop: 0, callback: null, states: [], presentation: [],
    collections: [], activations: [], highlights: [], backs: 0, nodes: new Map() };
  const b = await tvSettingsFixture({ width, height, savedMode: mode, boundaryOverrides: {
    'services/tv-platform': {
      tvReadDevice: () => device,
      tvStartRemote(callback) { bridge.start++; bridge.callback = callback; },
      tvSetRemoteState: state => bridge.states.push({ ...state }),
      tvStopRemote() { bridge.stop++; }, tvPresent: enabled => bridge.presentation.push(enabled),
      tvCollect(root) { bridge.collections.push(root); return bridge.nodes.get(root) ?? []; },
      tvHighlight: (id, color) => bridge.highlights.push({ id, color }),
      tvActivate: (id, longPress) => bridge.activations.push({ id, longPress }),
      tvScroll: () => false, tvBack() { bridge.backs++; },
    },
  } });
  return { ...b, device, bridge, layout: b.load(UI + 'composables/use-qt-layout.ts') };
}
const cases = {};
cases['mode-detection'] = async () => {
  const b = await fixture();
  try {
    const initialFont = b.fonts.fontScale.scale;
    assert.equal(b.tv.useQtTv().enabled, false, 'a wide desktop/phone viewport is not television detection');
    assert.equal(b.layout.useQtLayout().isTv, false);
    assert.equal(b.layout.qtRailWidth(), 96, 'normal desktop keeps its original rail');
    b.device.leanback = true; b.tv.qtSetTvForeground(true); await b.flush();
    assert.equal(b.tv.useQtTv().detected, true, 'Leanback-only Android devices are automatically recognized');
    assert.equal(b.tv.useQtTv().enabled, true);
    assert.equal(b.layout.qtRailWidth(), 136);
    assert.equal(b.layout.qtPlayerBarHeightPx(), 104);
    assert.equal(b.fonts.qtFontValuePx(12), 20, 'TV output has a 20px text floor');
    assert.equal(b.fonts.fontScale.scale, initialFont, 'presentation never changes the persisted font tier');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.tv.useQtTv().enabled, false, 'explicit touch overrides detected television');
    assert.equal(b.layout.qtRailWidth(), 96);
    assert.equal(b.layout.qtPlayerBarHeightPx(), 84);
    b.device.leanback = false; b.tv.qtSetTvMode('tv'); await b.flush();
    assert.equal(b.tv.useQtTv().enabled, true, 'manual TV works even on a touch device');
    assert.equal(b.storage.get('qt-tv-presentation'), 'tv');
    b.tv.qtSetTvMode('auto'); await b.flush();
    assert.equal(b.tv.useQtTv().enabled, false, 'auto restores the actual device policy in the same window');
    assert.equal(b.fonts.fontScale.scale, initialFont);
    assert.equal(b.bridge.start, 1, 'mode changes reuse the one native remote subscription');
  } finally { await b.close(); }
};
cases['shared-polling'] = async () => {
  const b = await fixture({ television: true }); const root = {};
  b.bridge.nodes.set(root, [candidate('tv:app:page:custom:first')]);
  let dispose = null;
  try {
    dispose = b.tv.qtTvRegisterScope({ root, active: () => true, modal: false });
    assert.equal(b.clock.intervalCount(220), 1, 'all visible rows share one focus refresh timer');
    b.bridge.collections.length = 0;
    await b.clock.runTimers(220);
    assert.deepEqual(b.bridge.collections, [root], 'one interval scans the actual active root once');
    b.tv.qtSetTvForeground(false); await b.flush();
    assert.equal(b.clock.intervalCount(220), 0, 'backgrounding suspends native focus scans');
    assert.equal(b.tv.qtTvFocusedId(), '');
    const oldScans = b.bridge.collections.length; await b.clock.runTimers(660);
    assert.equal(b.bridge.collections.length, oldScans);
    b.tv.qtSetTvForeground(true); b.tv.qtSetTvForeground(true); await b.flush();
    assert.equal(b.clock.intervalCount(220), 1, 'repeated foreground callbacks do not multiply timers');
    b.device.nativeAvailable = false; b.tv.qtSetTvForeground(true);
    assert.equal(b.clock.intervalCount(220), 0, 'an old native base still supports presentation without polling');
    assert.equal(b.tv.useQtTv().enabled, true);
    b.device.nativeAvailable = true; b.tv.qtSetTvForeground(true);
    assert.equal(b.clock.intervalCount(220), 1);
    b.tv.qtSetTvMode('touch'); assert.equal(b.clock.intervalCount(220), 0);
    b.tv.qtSetTvMode('tv'); assert.equal(b.clock.intervalCount(220), 1);
    dispose(); dispose = null; await b.close();
    assert.equal(b.clock.intervalCount(220), 0, 'disposing the controller releases its shared timer');
    assert.equal(b.bridge.stop, 1); assert.equal(b.bridge.presentation.at(-1), false);
  } finally { dispose?.(); if (b.bridge.stop === 0) await b.close(); }
};
cases['native-delivery'] = async () => {
  const b = await fixture({ mode: 'tv' }); const root = {};
  b.bridge.nodes.set(root, [candidate('tv:app:page:custom:action')]);
  const dispose = b.tv.qtTvRegisterScope({ root, active: () => true, modal: false });
  try {
    assert.equal(b.tv.qtTvFocus('action'), true, 'public business focus resolves native prefixed IDs');
    b.bridge.callback({ key: 'ok', action: 'up', repeat: 0 });
    b.bridge.callback({ key: 'ok', action: 'down', repeat: 1 });
    assert.equal(b.bridge.activations.length, 0, 'owned UP/repeated OK never dispatch a second business click');
    b.bridge.callback({ key: 'ok', action: 'down', repeat: 0 });
    b.bridge.callback({ key: 'menu', action: 'down', repeat: 0 });
    assert.deepEqual(b.bridge.activations, [
      { id: 'tv:app:page:custom:action', longPress: false },
      { id: 'tv:app:page:custom:action', longPress: true },
    ]);
    assert.equal(b.tv.qtTvDispatchRemote({ key: 'volume-up', action: 'down', repeat: 0 }), false,
      'media/volume keys stay outside the app navigation policy');
    b.tv.qtSetTvForeground(false);
    b.bridge.callback({ key: 'back', action: 'down', repeat: 0 });
    assert.equal(b.bridge.backs, 0, 'background pages do not receive native Back');
  } finally { dispose(); await b.close(); }
};
export async function runTvControllerChecks(selected = 'all') {
  const entries = selected === 'all' ? Object.entries(cases) : [[selected, cases[selected]]];
  assert.ok(entries.every(([, test]) => typeof test === 'function'), 'known TV controller case');
  for (const [name, test] of entries) { await test(); console.log('PASS TV controller ' + name); }
  console.log('TV controller: ' + entries.length + ' public service groups passed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runTvControllerChecks(process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'all');
}
