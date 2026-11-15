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
assert.ok(!/name=["']check["']|[✓✔☑]|当前使用/.test(sheet), 'ordinary option menus keep their existing selection presentation');
assert.ok(option.includes('indicator: false') && option.includes('indicator && selected'), 'visual option checks are opt-in; ordinary options keep their current appearance');
assert.ok(!/[✓✔☑]|当前使用/.test(option), 'never append selection symbols to option labels');
assert.ok(checkbox.includes('indicator: "dot"') && checkbox.includes('checked && indicator == \'check\''), 'playlist check indicator is opt-in; existing checkbox defaults stay unchanged');
assert.ok(option.includes('qtSelectionColor(theme.dark)') && checkbox.includes('qtSelectionColor(theme.dark)'));
assert.ok(option.indexOf('props.selected ? red.value') < option.indexOf('props.color.length > 0'), 'selected red outranks destructive/action overrides');
assert.ok(sheet.includes('QtSheet') && sheet.includes('QtOption') && sheet.includes('useQtSelectionReveal'));
assert.ok(sheet.includes('qtSelectionIndex(props.selectedIndex, props.actions.length)'));
assert.ok(sheet.includes('return "height:"') && sheet.includes('Math.min(Math.ceil(contentHeight.value), availableHeight.value)'), 'native option menus bound the viewport using wrapped content height');
for (const token of ['nextScope += 1', 'generation += 1', 'clearTimeout(timer)', 'onMounted', 'onUnmounted', 'layout.sizeEpoch', 'fontScale.scale', 'contentKey()']) assert.ok(reveal.includes(token), 'missing reveal lifecycle trigger: ' + token);
assert.ok(reveal.includes('anchor.value = ""'), 'reopening must reset the native scroll anchor');
const sourceSheet = read('services/source-sheet.ts');
assert.ok(!sourceSheet.includes('theme.skin.accent') && !sourceSheet.includes('colors:'), 'source selection must use selectedIndex, not hand-written colors');
assert.ok(sourceSheet.includes('sourceIndex < 0 ? -1 : sourceIndex + 1'), 'unknown platform IDs must not highlight automatic');
// Exercise the real service functions with tiny ref stand-ins, not a separate state-machine copy.
const { runInNewContext } = await import('node:vm');
const { stripTypeScriptTypes } = await import('node:module');
// Native wrapping is asynchronous. The real component must fit measured rows,
// remeasure on font/window changes and discard results from a closed sheet.
{
  const props = { visible: true, title: '换源', selectedIndex: -1, actions: [
    { name: '사랑을 했다 (LOVE SCENARIO)', description: 'iKON · 酷狗音乐 · 3:29' },
    { name: '사랑을 했다 (LOVE SCENARIO) (iKON JAPAN TOUR 2018)', description: 'iKON · 酷狗音乐 · 4:01\n现场专辑' },
  ] };
  const layout = { isWide: false, paneWidth: 360, windowWidth: 360, paneHeight: 800, safeBottomPx: 0, sizeEpoch: 0 };
  const fonts = { scale: 1.15 }, ticks = [], timers = new Map(), queries = [];
  let mount, unmount, refresh, timerId = 0;
  const script = sheet.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const runtime = stripTypeScriptTypes(script.replace(/^import .*;$/gm, '').replace(/^export /gm, ''), { mode: 'strip' });
  const view = runInNewContext(runtime + '\n({listStyle,contentHeight,availableHeight,measuredHeight,cancelInsetPx});', {
    defineProps: () => props, withDefaults: value => value, defineEmits: () => () => {},
    ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }),
    useQtLayout: () => layout, useThemeStore: () => ({ skin: {} }), fontScale: fonts, qtFontDual: () => '',
    qtSelectionIndex, qtSheetWidth: () => 520,
    useQtSelectionReveal: () => ({ anchor: { value: '' }, itemId: index => 'test-option-' + index }),
    onMounted: fn => { mount = fn; }, onUnmounted: fn => { unmount = fn; },
    watch: (_get, fn) => { refresh = fn; }, nextTick: fn => ticks.push(fn),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    uni: { createSelectorQuery: () => ({
      select() { return this; }, boundingClientRect(fn) { queries.push(fn); return this; }, exec() {},
    }) },
  });
  const flush = () => {
    while (ticks.length) ticks.shift()();
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
  };
  // Compact cancel has no decorative trailing spacer; only a genuine remaining system inset is consumed.
  eq(view.cancelInsetPx.value, 0);
  for (const inset of [24, 42, 0]) { layout.safeBottomPx = inset; eq(view.cancelInsetPx.value, inset); }
  const estimate = view.contentHeight.value;
  mount(); flush(); queries.shift()({ height: 226 });
  eq(view.listStyle.value, 'height:226px;');
  fonts.scale = 1.5; refresh();
  assert.ok(view.contentHeight.value > estimate, 'font growth must include wrapped title and description lines');
  flush(); queries.shift()({ height: 340 });
  eq(view.listStyle.value, 'height:340px;');
  layout.isWide = true; layout.paneWidth = 600; layout.windowWidth = 600; layout.paneHeight = 360; layout.sizeEpoch++;
  refresh(); flush();
  queries.shift()({ height: 900 });
  eq(Number.parseFloat(view.listStyle.value.slice(7)), view.availableHeight.value);
  assert.ok(view.availableHeight.value > 0 && view.availableHeight.value < 360 - 100, 'short panes reserve the header and cancel footer');
  refresh(); flush();
  const stale = queries.shift();
  props.visible = false; refresh(); stale({ height: 999 });
  eq(view.measuredHeight.value, 0);
  props.visible = true; refresh(); flush();
  const afterDispose = queries.shift();
  unmount(); afterDispose({ height: 888 });
  eq(view.measuredHeight.value, 0);
  eq(timers.size, 0);
}
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
// 用户 2026-11-13：取消键下不再留一整行空白——动作条贴弹层底边，安全区由同色垫条补齐；确认弹窗压过迷你播放栏。
assert.ok(sheet.includes(':footer-flush="true"') && sheet.includes('as-cancel-inset') && sheet.includes('cancelInsetPx'), 'action-sheet cancel sits flush with the panel bottom and pads the safe area itself');
assert.ok(shell.includes('props.footerFlush ? 0 : bottom'), 'qt-sheet drops its own bottom padding when the footer owns the safe inset');
// Execute the actual mask computed binding: a padded/shortened list parent must not determine the compact footer edge.
{
  const layout = { isWide: false, paneLeft: 0, paneTop: 0, paneWidth: 360, paneHeight: 640 };
  const binding = shell.match(/const maskStyle = computed\([\s\S]*?\n\}\);/);
  assert.ok(binding, 'qt-sheet exposes explicit compact viewport positioning');
  let fixedReads = 0;
  const style = runInNewContext(stripTypeScriptTypes(binding[0]) + '\nmaskStyle;', {
    layout, inWorkspace: false, computed: fn => ({ get value() { return fn(); } }), theme: { skin: { scrim: '#888' } },
    qtFixedPaneStyle: () => { fixedReads++; return `left:${layout.paneLeft}px;top:${layout.paneTop}px;right:auto;bottom:auto;width:${layout.paneWidth}px;height:${layout.paneHeight}px;`; },
  });
  assert.ok(shell.includes(':style="maskStyle"'), 'the actual visible mask uses the tested binding');
  assert.match(style.value, /^position:fixed;left:0px;top:0px;/);
  assert.ok(style.value.includes('height:640px;'), '61.44px dock parent padding cannot shorten the viewport mask');
  layout.paneLeft = 12; layout.paneTop = 32; layout.paneWidth = 340; layout.paneHeight = 588;
  assert.ok(style.value.includes('left:12px;top:32px;') && style.value.includes('width:340px;height:588px;'), 'compact mask follows the live fold/resize pane');
  const reads = fixedReads;
  layout.isWide = true;
  eq(style.value, 'background-color:#888;');
  eq(fixedReads, reads);
  assert.match(shell, /\.qs-mask \{ position: absolute;/, 'wide sheets retain local host positioning and stacking');
  assert.ok(sheet.includes('const bottom = cancelInsetPx.value;'), 'scroll budget and rendered cancel inset use one value');
  const hostedLayout = { ...layout, isWide: false };
  const hosted = runInNewContext(stripTypeScriptTypes(binding[0]) + '\nmaskStyle;', {
    layout: hostedLayout, inWorkspace: true, computed: fn => ({ get value() { return fn(); } }), theme: { skin: { scrim: '#888' } },
    qtFixedPaneStyle: () => { throw new Error('hosted sheet must never escape fixed workspace'); },
  });
  for (const wide of [false, true, false]) { hostedLayout.isWide = wide; eq(hosted.value, 'background-color:#888;'); }
  const frame = read(base + 'components/qt-page-frame/qt-page-frame.uvue');
  assert.ok(frame.includes('provide("qt-sheet-in-workspace", hostedRoute.length > 0);') && shell.includes('inject<boolean>("qt-sheet-in-workspace", false)'), 'exact instance context survives rotation and deep-page coverage');
}
const confirmHost = read(base + 'components/qt-confirm-host/qt-confirm-host.uvue');
const miniPlayer = read(base + 'components/qt-mini-player/qt-mini-player.uvue');
assert.ok(/\.qc-mask \{[^}]*z-index: 1200/.test(confirmHost) && /z-index: 998/.test(miniPlayer), 'confirm dialogs stack above the docked player bar instead of being covered by it');
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
