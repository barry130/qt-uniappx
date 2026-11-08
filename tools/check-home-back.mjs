// Run production preference, settings picker and Home's back handler. Only storage,
// lifecycle, navigation and native activity boundaries are adapted; no device required.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
function js(source) {
  return stripTypeScriptTypes(source.replace(/^import[\s\S]*?from\s*["'][^"']+["'];?\s*/gm, '')
    .replace(/^export\s+/gm, ''), { mode: 'strip' });
}
function fn(source, name) {
  const start = source.search(new RegExp('(?:export )?(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name + ' must exist');
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function preference(initial, { readFails = false, writeFails = false } = {}) {
  const storage = new Map(initial == null ? [] : [['qt-home-back-mode', initial]]);
  const warnings = [], writes = [];
  const api = runInNewContext(js(read('uni_modules/qt-ui/stores/home-back.ts')) +
    '\n({useHomeBackSettings,setHomeBackMode,QT_HOME_BACK_OPTIONS});', {
    reactive: value => value, logWarn: (...args) => warnings.push(args),
    uni: {
      getStorageSync: key => { if (readFails) throw Error('storage read'); return storage.get(key); },
      setStorageSync: (key, value) => { if (writeFails) throw Error('storage write'); storage.set(key, value); writes.push([key, value]); },
    },
  });
  return { ...api, storage, warnings, writes };
}
const homeSource = read('pages/home/index.uvue');
const settingsSource = read('uni_modules/qt-ui/components/qt-settings-overview/qt-settings-overview.uvue');
const homeHandler = homeSource.slice(homeSource.indexOf('let lastBackAt ='), homeSource.indexOf('\nasync function play('));
function home(mode = 'double-exit') {
  let now = 10000, back, shown, hidden;
  const effects = [], watchers = [], settings = { mode }, overlays = { queue: false, tool: false };
  const sheet = { visible: { value: false } };
  const scope = {
    homeBackSettings: settings, homeActionSheet: sheet,
    onBackPress: cb => { back = cb; }, onHide: cb => { hidden = cb; }, onShow: cb => { shown = cb; },
    watch: (getter, cb) => watchers.push({ getter, cb, value: getter() }),
    Date: { now: () => now },
    qtActionSheetCancel: () => { sheet.visible.value = false; effects.push('sheet'); },
    closePlaybackQueue: () => { if (!overlays.queue) return false; overlays.queue = false; effects.push('queue'); return true; },
    qtCloseWideTool: () => { if (!overlays.tool) return false; overlays.tool = false; effects.push('tool'); return true; },
    moveAppToBackground: () => { effects.push('background'); return Promise.resolve(); },
    player: { stopForExit: () => effects.push('stopForExit') }, exitApp: () => effects.push('exit'),
    qtShowToast: options => effects.push(options.title),
    qtTrackPage() {}, qtWideWorkspaceRefresh() {}, sourceStore: { restore() {} }, ensureLoad() {},
    refreshSourcePackState() {}, applyNoticeBar() {}, loadLocalMixes() {},
  };
  runInNewContext(js(homeHandler + '\n' + homeSource.match(/onShow\(\(\) => \{[\s\S]*?\n\}\);/)[0]), scope);
  return {
    effects, overlays, sheet, press: (from = 'backbutton') => back({ from }),
    advance: ms => { now += ms; }, show: () => shown(), hide: () => hidden(),
    setMode(value) {
      settings.mode = value;
      for (const watcher of watchers) {
        const next = watcher.getter();
        if (next !== watcher.value) { watcher.value = next; watcher.cb(); }
      }
    },
  };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS home-back: ' + name); }

await test('default, invalid storage, both persistent choices and storage failures', () => {
  for (const invalid of [undefined, '', 'old-mode', false, 7, {}]) {
    assert.equal(preference(invalid).useHomeBackSettings().mode, 'double-exit');
  }
  for (const mode of ['background', 'double-exit']) {
    const p = preference();
    assert.equal(p.useHomeBackSettings(), p.useHomeBackSettings(), 'Home and Settings share the same state');
    p.setHomeBackMode(mode);
    assert.equal(p.useHomeBackSettings().mode, mode);
    assert.equal(p.storage.get('qt-home-back-mode'), mode);
    assert.equal(preference(p.storage.get('qt-home-back-mode')).useHomeBackSettings().mode, mode, 'cold restart restores choice');
    assert.equal(p.writes.length, 1);
  }
  assert.equal(preference('background', { readFails: true }).useHomeBackSettings().mode, 'double-exit');
  const broken = preference(null, { writeFails: true });
  broken.setHomeBackMode('background');
  assert.equal(broken.useHomeBackSettings().mode, 'background');
  assert.equal(broken.warnings.length, 1);
});

await test('settings uses the shared picker, one selection, cancellation and current-value summary', async () => {
  const p = preference();
  const selection = runInNewContext(js(read('uni_modules/qt-ui/composables/selection.ts')) + '\n({qtSelectionIndex});');
  const sheet = runInNewContext(js(read('services/action-sheet.ts')) +
    '\n({qtShowActionSheet,qtActionSheetState,qtActionSheetPick,qtActionSheetCancel});', { ref: value => ({ value }), ...selection });
  const api = runInNewContext(js(fn(settingsSource, 'showHomeBackMode') + '\n' + fn(settingsSource, 'homeBackSummary')) +
    '\n({showHomeBackMode,homeBackSummary});', { ...p, ...sheet, homeBackSettings: p.useHomeBackSettings() });
  const st = sheet.qtActionSheetState();
  api.showHomeBackMode();
  assert.equal(st.selectedIndex.value, 1);
  assert.equal(st.items.value.length, 2);
  sheet.qtActionSheetPick(0); await Promise.resolve();
  assert.equal(p.useHomeBackSettings().mode, 'background');
  assert.equal(api.homeBackSummary(), '回到后台');
  api.showHomeBackMode(); assert.equal(st.selectedIndex.value, 0);
  sheet.qtActionSheetCancel(); await Promise.resolve();
  assert.equal(p.writes.length, 1, 'cancel never changes or saves the preference');
  api.showHomeBackMode(); sheet.qtActionSheetPick(1); await Promise.resolve();
  assert.equal(p.useHomeBackSettings().mode, 'double-exit');
  assert.equal(api.homeBackSummary(), '两次退出');
  api.showHomeBackMode(); sheet.qtActionSheetPick(8); await Promise.resolve();
  assert.equal(p.writes.length, 2, 'invalid selection is cancelled');
  assert.match(settingsSource, /key: "home-back"[^\n]*go: showHomeBackMode/);
});

await test('one press backgrounds without stopping playback or exiting, including repeated presses', () => {
  const h = home('background');
  assert.equal(h.press(), true); h.advance(200); assert.equal(h.press(), true);
  assert.deepEqual(h.effects, ['background', 'background']);
  h.hide(); h.show(); h.press();
  assert.deepEqual(h.effects, ['background', 'background', 'background']);
});

await test('double press exits within two seconds; timeout, clock rollback and lifecycle re-arm', () => {
  const h = home();
  assert.equal(h.press(), true);
  assert.deepEqual(h.effects, ['再按一次退出应用']);
  h.advance(1999); h.press();
  assert.deepEqual(h.effects, ['再按一次退出应用', 'stopForExit', 'exit']);
  for (const interrupt of [h => h.advance(2000), h => h.advance(-1), h => h.hide(), h => h.show()]) {
    const other = home(); other.press(); interrupt(other); other.press();
    assert.deepEqual(other.effects, ['再按一次退出应用', '再按一次退出应用']);
  }
});

await test('programmatic back, picker, queue and wide tool never count as exit presses', () => {
  for (const mode of ['background', 'double-exit']) {
    const h = home(mode);
    assert.equal(h.press('navigateBack'), false); assert.deepEqual(h.effects, []);
    h.overlays.queue = true; h.overlays.tool = true; h.sheet.visible.value = true;
    h.press(); h.press(); h.press();
    assert.deepEqual(h.effects, ['sheet', 'queue', 'tool']);
    h.press();
    assert.equal(h.effects.at(-1), mode === 'background' ? 'background' : '再按一次退出应用');
  }
  for (const overlay of ['sheet', 'queue', 'tool']) {
    const h = home(); h.press();
    if (overlay === 'sheet') h.sheet.visible.value = true;
    else h.overlays[overlay] = true;
    h.press(); h.advance(50); h.press();
    assert.deepEqual(h.effects, ['再按一次退出应用', overlay, '再按一次退出应用']);
  }
});

await test('changing the setting resets a pending double-back attempt immediately', () => {
  const h = home(); h.press(); h.setMode('background'); h.setMode('double-exit'); h.press();
  assert.deepEqual(h.effects, ['再按一次退出应用', '再按一次退出应用']);
  h.setMode('background'); h.press(); assert.equal(h.effects.at(-1), 'background');
});

await test('Android moves the task, reports native failures, never finishes an activity', async () => {
  let activity, throws = false;
  const calls = [];
  const move = runInNewContext(js(fn(read('uni_modules/qt-app-native/utssdk/app-android/index.uts'), 'moveAppToBackgroundNative')) +
    '\nmoveAppToBackgroundNative;', {
    UTSAndroid: { getUniActivity: () => { if (throws) throw Error('activity unavailable'); return activity; } },
    console: { log() {} },
  });
  assert.equal(await move(), false);
  activity = { moveTaskToBack: nonRoot => { calls.push(nonRoot); return true; }, finishAffinity: () => assert.fail('background must not finish') };
  assert.equal(await move(), true); assert.deepEqual(calls, [true]);
  activity.moveTaskToBack = () => false; assert.equal(await move(), false);
  throws = true; assert.equal(await move(), false);
});

await test('Harmony waits for background result and iOS reports unsupported', async () => {
  let context = null, resolveMove;
  const move = runInNewContext(js(fn(read('uni_modules/qt-app-native/utssdk/app-harmony/index.uts'), 'moveAppToBackgroundNative')) +
    '\nmoveAppToBackgroundNative;', { UTSHarmony: { getUIAbilityContext: () => context }, console: { log() {} } });
  assert.equal(await move(), false);
  context = { moveAbilityToBackground: () => new Promise(resolve => { resolveMove = resolve; }), terminateSelf: () => assert.fail('must not terminate') };
  let settled = false;
  const pending = move().then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false);
  resolveMove(); assert.equal(await pending, true);
  context.moveAbilityToBackground = () => Promise.reject(Error('native rejection'));
  assert.equal(await move(), false);
  const iosMove = runInNewContext(js(fn(read('uni_modules/qt-app-native/utssdk/app-ios/index.uts'), 'moveAppToBackgroundNative')) + '\nmoveAppToBackgroundNative;');
  assert.equal(await iosMove(), false);
});

await test('service handles rejected requests with feedback, never falls back to app exit', async () => {
  const source = read('services/app-native.uts');
  for (const outcome of ['ok', 'false', 'throw']) {
    const calls = [];
    const move = runInNewContext(js(fn(source, 'moveAppToBackground')) + '\nmoveAppToBackground;', {
      moveAppToBackgroundNative: async () => { if (outcome === 'throw') throw Error('bridge failed'); return outcome === 'ok'; },
      qtShowToast: options => calls.push(options.title), logErrV: () => calls.push('error'),
      exitApp: () => assert.fail('failed background must not exit'),
    });
    await move();
    assert.equal(calls.length, outcome === 'ok' ? 0 : outcome === 'false' ? 1 : 2);
  }
  for (const platform of ['android', 'harmony', 'ios', 'web']) {
    const supported = runInNewContext(js(fn(source, 'supportsHomeBackMode')) + '\nsupportsHomeBackMode;', {
      isAndroidOs: () => platform === 'android', isHarmonyOs: () => platform === 'harmony',
    });
    assert.equal(supported(), platform === 'android' || platform === 'harmony');
  }
});

console.log('home-back: ' + passed + ' behavior cases passed');
