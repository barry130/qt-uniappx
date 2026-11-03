import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { qtSelectionColor, qtSelectionIndex, qtSelectionScrollOffset } from '../uni_modules/qt-ui/composables/selection.ts';
const read = path => readFileSync(fileURLToPath(new URL('../' + path, import.meta.url)), 'utf8');
let cases = 0;
const eq = (actual, expected) => { assert.equal(actual, expected); cases++; };
eq(qtSelectionColor(false), '#d93c43');
eq(qtSelectionColor(true), '#ff7378');
for (const n of [-1, -10, 0.2, 3, NaN, Infinity, -Infinity]) eq(qtSelectionIndex(n, 3), -1);
for (const n of [0, 1, 2]) eq(qtSelectionIndex(n, 3), n);
eq(qtSelectionIndex(0, 0), -1);
for (const [start, end, viewport, current, content, expected] of [
  [0, 60, 200, 0, 800, 0], [400, 460, 200, 0, 800, 260],
  [400, 460, 200, 350, 800, 350], [50, 110, 200, 350, 800, 50],
  [740, 800, 200, 0, 800, 600], [0, 60, 200, 9999, 800, 0],
  [100, 400, 200, 0, 800, 100], [0, 60, 0, 0, 800, 0],
  [0, 60, 200, 0, 100, 0], [NaN, 60, 200, 50, 800, 50],
  [0, 60, NaN, 50, 800, 0], [0, 60, 200, NaN, 800, 0],
]) eq(qtSelectionScrollOffset(start, end, viewport, current, content), expected);
for (const viewport of [160, 320, 600]) {
  for (const count of [1, 5, 20]) {
    for (let selected = 0; selected < count; selected++) {
      const content = count * 92, start = selected * 92, end = start + 80;
      const offset = qtSelectionScrollOffset(start, end, viewport, 0, content);
      assert.ok(offset >= 0 && offset <= Math.max(0, content - viewport));
      assert.ok(start >= offset && end <= offset + viewport);
      cases++;
    }
  }
}
const base = 'uni_modules/qt-ui/';
const option = read(base + 'components/qt-option/qt-option.uvue');
const checkbox = read(base + 'components/qt-checkbox/qt-checkbox.uvue');
const sheet = read(base + 'components/qt-action-sheet/qt-action-sheet.uvue');
const reveal = read(base + 'composables/use-qt-selection-reveal.ts');
for (const source of [option, checkbox, sheet]) assert.ok(!/name=["']check["']|[✓✔☑]|当前使用/.test(source), 'selection controls must not add check/current-use labels');
assert.ok(option.includes('qtSelectionColor(theme.dark)') && checkbox.includes('qtSelectionColor(theme.dark)'));
assert.ok(option.indexOf('props.selected ? red.value') < option.indexOf('props.color.length > 0'), 'selected red outranks destructive/action overrides');
assert.ok(sheet.includes('QtSheet') && sheet.includes('QtOption') && sheet.includes('useQtSelectionReveal'));
assert.ok(sheet.includes('qtSelectionIndex(props.selectedIndex, props.actions.length)'));
assert.ok(sheet.includes('return "height:"') && sheet.includes('props.actions.length * rowHeight'), 'native option menus need an explicit bounded scroll viewport');
for (const token of ['nextScope += 1', 'generation += 1', 'clearTimeout(timer)', 'onMounted', 'onUnmounted', 'layout.sizeEpoch', 'fontScale.scale', 'contentKey()']) assert.ok(reveal.includes(token), 'missing reveal lifecycle trigger: ' + token);
assert.ok(reveal.includes('anchor.value = ""'), 'reopening must reset the native scroll anchor');
const sourceSheet = read('services/source-sheet.ts');
assert.ok(!sourceSheet.includes('theme.skin.accent') && !sourceSheet.includes('colors:'), 'source selection must use selectedIndex, not hand-written colors');
assert.ok(sourceSheet.includes('sourceIndex < 0 ? -1 : sourceIndex + 1'), 'unknown platform IDs must not highlight automatic');
// Exercise the real service functions with tiny ref stand-ins, not a separate state-machine copy.
const { runInNewContext } = await import('node:vm');
const { stripTypeScriptTypes } = await import('node:module');
const service = read('services/action-sheet.ts');
const runnable = stripTypeScriptTypes(service.replace(/^import .*;$/gm, '').replace(/\bexport\s+/g, ''), { mode: 'strip' });
const api = runInNewContext(runnable + '\n({ qtShowActionSheet, qtActionSheetPick, qtActionSheetCancel, qtActionSheetState });', { ref: value => ({ value }), qtSelectionIndex });
const state = api.qtActionSheetState();
const previous = api.qtShowActionSheet({ itemList: ['one', 'two'], selectedIndex: 1 });
eq(await api.qtShowActionSheet({ itemList: [] }), -1);
eq(await previous, -1);
eq(state.visible.value, false);
eq(state.items.value.length, 0);
eq(state.selectedIndex.value, -1);
eq(state.colors.value.length, 0);
const first = api.qtShowActionSheet({ itemList: ['one', 'two'], selectedIndex: 1, colors: ['red'] });
const firstRequest = state.requestId.value;
const replacement = api.qtShowActionSheet({ itemList: ['three'], selectedIndex: 99 });
eq(await first, -1);
eq(state.requestId.value, firstRequest + 1);
eq(state.selectedIndex.value, -1);
eq(state.colors.value.length, 0);
api.qtActionSheetPick(0);
eq(await replacement, 0);
eq(state.visible.value, false);
const invalid = api.qtShowActionSheet({ itemList: ['one'], selectedIndex: 0 });
api.qtActionSheetPick(5);
eq(await invalid, -1);
eq(state.visible.value, false);
const cancelled = api.qtShowActionSheet({ itemList: ['one'], selectedIndex: 0 });
api.qtActionSheetCancel();
api.qtActionSheetCancel();
eq(await cancelled, -1);
eq(state.items.value.length, 0);
const callerItems = ['one', 'two'], callerColors = ['red'];
const snapshot = api.qtShowActionSheet({ itemList: callerItems, colors: callerColors });
callerItems.length = 0; callerColors[0] = 'blue';
eq(state.items.value.length, 2); eq(state.colors.value[0], 'red');
api.qtActionSheetPick(1); eq(await snapshot, 1);
// Execute the actual reveal lifecycle with deterministic render/native-layout queues.
let mount, unmount, rerun;
let timerId = 0;
const ticks = [], timers = new Map();
const revealRuntime = stripTypeScriptTypes(reveal.replace(/^import .*;$/gm, '').replace(/\bexport\s+/g, ''), { mode: 'strip' });
const useReveal = runInNewContext(revealRuntime + '\nuseQtSelectionReveal;', {
  ref: value => ({ value }), useQtLayout: () => ({ sizeEpoch: 0 }), fontScale: { scale: 1 },
  watch: (_getter, callback, options) => { rerun = callback; if (options.immediate) callback(); },
  onMounted: callback => { mount = callback; }, onUnmounted: callback => { unmount = callback; },
  nextTick: callback => { ticks.push(callback); },
  setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
  clearTimeout: id => { timers.delete(id); },
});
const flushRender = () => { while (ticks.length) ticks.shift()(); };
const flushNative = () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } };
let revealVisible = true, revealSelected = 4;
const firstReveal = useReveal(() => revealVisible, () => revealSelected, () => 'list');
eq(firstReveal.anchor.value, ''); eq(timers.size, 0);
mount(); flushRender(); eq(timers.size, 1); flushNative();
eq(firstReveal.anchor.value, firstReveal.itemId(4));
revealSelected = 7; rerun(); flushRender();
const staleNative = [...timers.values()][0];
revealSelected = 8; rerun(); flushRender();
const pendingNative = [...timers.values()][0];
staleNative(); eq(firstReveal.anchor.value, ''); eq(timers.size, 1);
unmount(); eq(timers.size, 0); pendingNative(); eq(firstReveal.anchor.value, '');
const secondReveal = useReveal(() => revealVisible, () => revealSelected, () => 'list');
assert.notEqual(secondReveal.itemId(8), firstReveal.itemId(8)); cases++;
mount(); flushRender(); revealVisible = false; rerun();
eq(timers.size, 0); eq(secondReveal.anchor.value, '');
revealVisible = true; rerun(); flushRender(); flushNative();
eq(secondReveal.anchor.value, secondReveal.itemId(8));
revealSelected = -1; rerun(); flushRender(); eq(timers.size, 0); eq(secondReveal.anchor.value, '');
unmount();
assert.ok(read(base + 'components/qt-action-sheet-host/qt-action-sheet-host.uvue').includes(':key="st.requestId.value"'), 'each service request must restart reveal even for identical lists');
const shell = read(base + 'components/qt-sheet/qt-sheet.uvue');
assert.ok(shell.includes('if (!props.dismissible) return; emit("update:visible"'), 'busy sheets must block close before any model update');
for (const count of [NaN, Infinity, -1, 0.5]) eq(qtSelectionIndex(0, count), -1);
const { QT_SLEEP_OPTIONS, QT_PLAYBACK_RATES, qtSleepSelectedIndex } = await import('../services/player-setting-options.ts');
assert.deepEqual(QT_SLEEP_OPTIONS.map(option => option.minutes), [0, 10, 20, 30, 45, 60, 90, 120]);
assert.deepEqual(QT_PLAYBACK_RATES, [0.75, 1, 1.25, 1.5, 2]);
for (const [stop, end, preset, expected] of [[false, 0, 60, 0], [true, -1, 0, 6], [false, 1000, 20, 2], [false, 900, 20, 2], [false, 900, 19, -1], [false, 900, 0, -1], [false, 900, 90, -1], [false, Infinity, 10, -1]]) eq(qtSleepSelectedIndex(stop, end, preset), expected);
assert.ok(read('stores/player.ts').includes('this.sleepRequestedMinutes = minutes;'), 'both timer sheets must use the original preset');
const { readdirSync } = await import('node:fs');
const root = fileURLToPath(new URL('../', import.meta.url));
const componentDir = root + 'uni_modules/qt-ui/components/';
const actual = readdirSync(componentDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('qt-')).map(entry => entry.name).sort();
const catalog = read(base + 'docs/component-catalog.md');
const documented = [...catalog.matchAll(/\.\.\/components\/(qt-[a-z-]+)\/\1\.uvue/g)].map(match => match[1]).sort();
assert.deepEqual(documented, actual, 'add/remove/rename a component only with a catalog update');
const rules = read('AGENTS.md');
assert.ok(rules.includes('Before adding or changing UI, search') && rules.includes('Do not copy private option'), 'component-first reuse must remain a repository rule');
assert.ok(read(base + 'readme.md').includes('docs/component-catalog.md'), 'README must point developers to the searchable catalog');
function filesBelow(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.name.startsWith('.') ? [] : entry.isDirectory() ? filesBelow(path + '/' + entry.name) : entry.name.endsWith('.uvue') ? [path + '/' + entry.name] : []);
}
for (const path of filesBelow(root + 'pages')) {
  const source = readFileSync(path, 'utf8');
  // Commands/success/favorites are not radio selections. Reject only state suffixes and dedicated private indicators.
  assert.ok(!/["'`][^"'`\r\n]*(?:✓|✔|（当前）|当前使用)["'`]/.test(source), path + ': pass selectedIndex instead of appending a selected-state suffix');
  assert.ok(!/\}\}\s*(?:✓|✔|（当前）|当前使用)\s*<\/text>/.test(source), path + ': render selection with a shared control');
  const css = source.split('<style')[1] || '';
  assert.ok(!/\.(?:toggle-th|toggle-knob|toggle-thumb|radio-dot|radio-circle|check-box|cb-on|seg-radio|target-radio)(?:-wide)?\s*\{/.test(css), path + ': do not duplicate private selection indicators');
}
console.log(`ui selection: ${cases} color/index/reveal/service/sleep vectors; ${actual.length} catalog entries; shared-control/lifecycle/reuse guards passed`);
