import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as Vue from 'vue';
import { compile } from '@vue/compiler-dom';
import ts from 'typescript';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const js = source => stripTypeScriptTypes(source.replace(/^import .*;$/gm, '').replace(/export /g, ''), { mode: 'strip' });
const math = runInNewContext(js(read('uni_modules/qt-ui/composables/player-presentation.ts')) + '\n({playerQueueMetrics,playerQueueWindow,playerQueueAnchorScroll})');
const actions = runInNewContext(js(read('uni_modules/qt-ui/composables/playback-queue.ts')) + '\n({removePlaybackQueueItem,movePlaybackQueueItem,playbackQueueMetrics})', math);
const { removePlaybackQueueItem: remove, movePlaybackQueueItem: move, playbackQueueMetrics: metrics } = actions;
const song = id => ({id,platform:'local',name:id,singer:'artist'});
function store(queue, current = queue[0]) {
  return {
    queue, current, effects: [], currentIndex() { return this.queue.indexOf(this.current); },
    play(item) { this.current = item; this.effects.push('play:' + item.id); return Promise.resolve(); },
    playbackRevision() { return this.effects.filter(effect => effect.startsWith('play:')).length; },
    syncTimeline() { this.effects.push('sync'); }, persist() { this.effects.push('persist'); },
    stop() { this.current = null; this.queue = []; this.effects.push('stop'); },
  };
}
const original = song('same'), duplicate = song('same'), next = song('next');
const p = store([original, duplicate, next]);
remove(p, 1);
assert.equal(p.current, original, 'removing a duplicate leaves current playback intact');
assert.deepEqual(p.effects, ['sync','persist']);
move(p, 0, 1);
assert.equal(p.current, original);
assert.equal(p.queue[1], original);
assert.deepEqual(p.effects.slice(2), ['sync','persist'], 'reorder must sync without restarting');
remove(p, 1);
assert.equal(p.current, next, 'removing current tail plays the remaining neighbour');
remove(p, 0);
assert.equal(p.current, null);
assert.equal(p.queue.length, 0);
assert.equal(p.effects.at(-1), 'stop', 'last item removal stops audio too');
const invalid = store([song('one')]);
for (const index of [-1,1,30]) remove(invalid, index);
move(invalid, 0, -1); move(invalid, 0, 1);
assert.deepEqual(invalid.effects, []);

for (const [width,height,wide] of [[320,568,false],[393,852,false],[600,360,true],[960,540,true],[1280,800,true],[1920,1080,true]]) {
  for (const scale of [0.8,1,1.3,1.5]) for (const count of [0,1,2,10000]) {
    const m = metrics(width,height,wide,24,16,76,scale,count);
    assert.ok(m.viewportPx >= 0);
    assert.ok(m.viewportPx + m.headerPx + m.insetBottomPx + m.panelBottomPx + 24 <= height);
    if (count <= 2) assert.ok(m.viewportPx <= m.stridePx * 2, 'short queues shrink to content');
    const w = math.playerQueueWindow(count,m.stridePx,m.viewportPx,500000,5);
    assert.ok(w.last - w.first < 30, 'large queues render a bounded window');
    assert.ok(w.scrollPx <= w.maxScrollPx);
  }
}

// Execute the real bar handler: only a local event is permitted, never route navigation.
const bar = read('uni_modules/qt-ui/components/qt-player-bar/qt-player-bar.uvue');
const open = bar.match(/function openQueue\(\): void \{[\s\S]*?\n\}/)[0];
const emitted = [];
runInNewContext(js(open) + '\nopenQueue()', { emit: e => emitted.push(e), uni: { navigateTo() { throw new Error('queue navigated'); } } });
assert.deepEqual(emitted, ['queue']);
for (const name of ['qt-page-frame','qt-wide-workspace']) {
  const owner = read(`uni_modules/qt-ui/components/${name}/${name}.uvue`);
  assert.match(owner, /<qt-player-bar[^>]+@queue="queueOpen = true"/);
  assert.match(owner, /<qt-playback-queue v-if="queueOpen" @close="queueOpen = false"/);
}
const overlay = runInNewContext(js(read('uni_modules/qt-ui/composables/playback-queue-overlay.ts')) + '\n({registerPlaybackQueueClose,unregisterPlaybackQueueClose,closePlaybackQueue})');
let closed = 0;
const old = () => { closed += 1; }, current = () => { closed += 10; };
overlay.registerPlaybackQueueClose(old); overlay.registerPlaybackQueueClose(current);
overlay.unregisterPlaybackQueueClose(old);
assert.equal(overlay.closePlaybackQueue(), true);
assert.equal(closed, 10, 'an old page unmount must not dismiss the newer queue');
assert.equal(overlay.closePlaybackQueue(), false, 'back is consumed exactly once');
// User-confirmed public seam: open the actual player sheet, deliver host layout/scroll
// replies, and inspect its rendered song rows. This models an early command being
// clamped before native layout; it is not a substitute for Vapor/device rendering.
const page = read('pages/player/index.uvue');
const script = page.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('player.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declared = name => ast.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(decl => decl.name.getText(ast) === name));
const queueStart = declared('queueMetrics').getStart(ast);
const queueEnd = declared('lyricViewportHeightPx').getStart(ast);
const stateNodes = ast.statements.filter(node => ts.isVariableStatement(node)
  && node.getStart(ast) < queueStart
  && node.declarationList.declarations.some(decl => /^(?:queue|QUEUE_)/.test(decl.name.getText(ast))));
// Retain the complete real occurrence dependencies added to the production
// sheet. The legacy public opening/scroll assertions are unchanged.
const handlers = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['openQueue', 'isCurrent', 'syncQueueOccurrences', 'currentQueueOccurrenceIndex',
    'queueRowIndex', 'isCurrentQueueRow'].includes(node.name?.text));
const publicProgram = ts.transpileModule(stateNodes.map(node => node.getText(ast)).join('\n')
  + '\n' + script.slice(queueStart, queueEnd) + '\n' + handlers.map(node => node.getText(ast)).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
function sheetTemplate(source) {
  const start = source.indexOf('<view v-if="queueOpen"');
  assert.ok(start >= 0, 'the actual player queue sheet must exist');
  const tokens = /<\/?view\b[^>]*>/g;
  tokens.lastIndex = start;
  let depth = 0, token;
  while ((token = tokens.exec(source))) {
    depth += token[0].startsWith('</') ? -1 : token[0].endsWith('/>') ? 0 : 1;
    if (depth === 0) return source.slice(start, tokens.lastIndex);
  }
  throw new Error('unclosed public queue sheet');
}
const renderSheet = new Function('Vue', compile(sheetTemplate(page), {
  mode: 'function', isCustomElement: () => true,
}).code)(Vue);
function descendants(node) {
  return node == null || typeof node !== 'object' ? [] : [node,
    ...(Array.isArray(node.children) ? node.children.flatMap(descendants) : [])];
}
const byClass = (node, name) => descendants(node).filter(item => (item.props?.class ?? '').split(' ').includes(name));
function paint(node) {
  const style = node.props?.style ?? {};
  return typeof style === 'string' ? Object.fromEntries(style.split(';').filter(Boolean).map(entry => {
    const colon = entry.indexOf(':');
    return [entry.slice(0, colon), entry.slice(colon + 1)];
  })) : style;
}
function playerView({ index = 30, count = 61, width = 375, height = 667, wide = false,
  initialReply = false, measurementHeights = [], batchTicks = false } = {}) {
  const ticks = [], replies = [], timers = new Map(), stops = [], commands = [];
  let timerId = 0, mounted = false, command, actualTop = 0;
  const tracks = Array.from({ length: count }, (_, i) => song('track-' + i));
  const player = Vue.reactive(store(tracks, tracks[index]));
  const layout = Vue.reactive({ paneWidth: width, windowWidth: width, paneHeight: height, isWide: wide, safeBottomPx: 0 });
  const fontScale = Vue.reactive({ scale: 1 });
  const metricsNow = () => math.playerQueueMetrics(layout.paneWidth, layout.paneHeight,
    layout.isWide, layout.safeBottomPx, fontScale.scale, layout.windowWidth);
  const viewportHeight = () => metricsNow().viewportPx;
  const stride = () => metricsNow().stridePx;
  const maxScroll = () => Math.max(0, Math.ceil(player.queue.length * stride()) - viewportHeight());
  const scope = {
    ...math, ref: Vue.ref, computed: Vue.computed, player, layout, fontScale, pageAlive: true,
    tv: { enabled: false },
    theme: { skin: { text: '#191d26', textMuted: '#737b8e', surfaceMuted: '#eeeeee', danger: '#e05050' } },
    qtFontDual: () => '', qtFixedPaneStyle: () => '', qtSheetWidth: () => 420,
    armSheet() {}, playAt() {}, queueActions() {}, moveUp() {}, moveDown() {}, removeAt() {}, clearQueue() {},
    sheetSlideStyle: '', queueDrawerWideStyle: '',
    watch(input, callback, options) { const stop = Vue.watch(input, callback, { ...options, flush: 'sync' }); stops.push(stop); return stop; },
    nextTick: fn => ticks.push(fn),
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    uni: { createSelectorQuery: () => ({ select() { return this; }, boundingClientRect(fn) { this.fn = fn; return this; },
      exec() { replies.push(() => this.fn({ height: measurementHeights.length ? measurementHeights.shift() : viewportHeight() })); } }) },
  };
  const api = runInNewContext(publicProgram + '\n({openQueue})', scope);
  const proxy = new Proxy(scope, { get(target, key) {
    if (typeof key === 'symbol') return target[key];
    try { return Vue.unref(runInNewContext(String(key), scope)); } catch { return target[key]; }
  }, has(target, key) {
    try { return runInNewContext('typeof ' + String(key) + ' !== "undefined"', scope); } catch { return key in target; }
  }, set(target, key, value) {
    try { const current = runInNewContext(String(key), scope); if (Vue.isRef(current)) { current.value = value; return true; } } catch {}
    target[key] = value; return true;
  } });
  const render = () => renderSheet(proxy, []);
  const viewport = () => byClass(render(), 'queue-list-viewport')[0];
  function commit() {
    const view = viewport();
    if (view == null) { mounted = false; command = undefined; return; }
    assert.equal(view.props['scroll-with-animation'], false, 'queue recovery must not start an animated jump');
    const next = view.props['scroll-top'];
    if (!mounted) {
      // The first property arrives before the host has committed content height.
      mounted = true; command = next; actualTop = 0;
      if (initialReply) view.props.onScroll({ detail: { scrollTop: 0 } });
    } else if (next !== command) {
      command = next; commands.push(next);
      actualTop = Math.max(0, Math.min(next, maxScroll()));
      view.props.onScroll({ detail: { scrollTop: actualTop } });
    }
  }
  function stepTick() {
    assert.ok(ticks.length, 'a host commit tick is pending');
    // Tasks queued during this batch belong to the following native content commit.
    const batch = batchTicks ? ticks.splice(0) : [ticks.shift()];
    batch.forEach(fn => fn());
    commit();
  }
  function stepReply() { assert.ok(replies.length, 'a layout response is pending'); replies.shift()(); commit(); }
  function settle() {
    for (let i = 0; i < 80 && (ticks.length || replies.length || timers.size); i++) {
      if (ticks.length) stepTick();
      else if (replies.length) stepReply();
      else { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); commit(); }
    }
    assert.equal(ticks.length + replies.length + timers.size, 0, 'host callbacks must settle within a bounded budget');
  }
  function visibleSongs() {
    return byClass(render(), 'queue-row').filter(row => {
      const style = paint(row), top = Number.parseFloat(style.top), rowHeight = Number.parseFloat(style.height);
      return top + rowHeight > actualTop && top < actualTop + viewportHeight();
    }).flatMap(row => byClass(row, 'queue-name').map(node => node.children));
  }
  return { open() { api.openQueue(); commit(); }, settle, stepTick, stepReply, commit, render,
    visibleSongs, actualTop: () => actualTop, stride,
    close() { byClass(render(), 'mask')[0]?.props.onClick(); commit(); },
    touch() { viewport().props.onTouchstart(); },
    scroll(top) { actualTop = Math.max(0, Math.min(top, maxScroll())); viewport().props.onScroll({ detail: { scrollTop: actualTop } }); },
    layout, fontScale, player, commands, dispose() { scope.pageAlive = false; stops.forEach(stop => stop()); } };
}
let viewCases = 0;
function revealed(view, index, message) {
  assert.ok(view.visibleSongs().includes('track-' + index), message);
  viewCases++;
}
for (const [width, height, wide] of [[375, 667, false], [960, 600, true]]) {
  for (const index of [0, 30, 60]) for (const initialReply of [false, true]) {
    const view = playerView({ width, height, wide, index, initialReply });
    view.open(); view.settle();
    revealed(view, index, 'first-open must reveal the playing song without a gesture, including clamped zero/last-row commands');
    view.touch(); view.scroll(5.25 * view.stride());
    view.close(); view.open(); view.settle();
    revealed(view, index, 'reopening the same sheet must reapply the current-song command');
    view.dispose();
  }
}
for (const count of [0, 1, 2, 5000]) {
  const index = Math.max(0, count - 1), view = playerView({ count, index });
  view.open(); view.settle();
  if (count === 0) assert.equal(byClass(view.render(), 'queue-row').length, 0);
  else revealed(view, index, 'empty/small/large queues preserve content and tail visibility');
  assert.ok(byClass(view.render(), 'queue-row').length < 40, 'recovery cannot defeat virtual-window bounds');
  view.dispose();
}
const retryView = playerView({ initialReply: true, measurementHeights: [0, 0] });
retryView.open(); retryView.settle();
revealed(retryView, 30, 'transient missing/zero measurements must retry and retain the opening intent');
retryView.dispose();

const resized = playerView();
resized.open(); resized.settle(); resized.touch(); resized.scroll(20.25 * resized.stride());
for (const change of [{ windowWidth: 500 }, { paneWidth: 960, paneHeight: 600, windowWidth: 960, isWide: true },
  { paneWidth: 375, paneHeight: 667, windowWidth: 375, isWide: false }]) {
  Object.assign(resized.layout, change); resized.settle();
  assert.ok(Math.abs(resized.actualTop() / resized.stride() - 20.25) < 0.00001,
    'window-only rpx changes and breakpoint changes retain the visible song plus fractional anchor');
  revealed(resized, 20, 'geometry changes must keep the browsing anchor, not jump back to the playing song');
}
resized.fontScale.scale = 1.5; resized.settle();
assert.ok(Math.abs(resized.actualTop() / resized.stride() - 20.25) < 0.00001);
resized.player.current = resized.player.queue[45]; resized.commit(); resized.settle();
revealed(resized, 45, 'an external playing-song change still reveals the new row');
resized.dispose();

for (const batchTicks of [false, true]) {
  const lateZero = playerView({ batchTicks });
  lateZero.open(); lateZero.stepTick(); lateZero.stepReply();
  lateZero.scroll(0); // A delayed native clamp reply arrives after positive layout but before replay.
  lateZero.settle();
  revealed(lateZero, 30, 'a late zero reply cannot replace the captured current-song target');
  lateZero.dispose();
  const batched = playerView({ batchTicks, initialReply: true });
  batched.open(); batched.player.current = batched.player.queue[45]; batched.commit();
  batched.scroll(0); batched.settle();
  revealed(batched, 45, 'a song change before first measurement preserves its intent through delayed zero replies and batched ticks');
  batched.dispose();
}
const reordered = playerView({ initialReply: true });
reordered.open(); reordered.scroll(0);
const reorderedCurrent = reordered.player.current;
reordered.player.queue = [...reordered.player.queue.filter(item => item !== reorderedCurrent), reorderedCurrent];
reordered.commit(); reordered.scroll(0); reordered.settle();
revealed(reordered, 30, 'a queue reorder before first measurement retains the actual playing song');
reordered.dispose();

for (const batchTicks of [false, true]) {
  const movedTail = playerView({ index: 60, batchTicks });
  movedTail.open(); movedTail.settle();
  const tailTarget = movedTail.actualTop();
  movedTail.touch(); movedTail.scroll(0);
  const nextQueue = [...movedTail.player.queue];
  [nextQueue[59], nextQueue[60]] = [nextQueue[60], nextQueue[59]];
  movedTail.player.queue = nextQueue; movedTail.commit(); movedTail.settle();
  assert.equal(movedTail.actualTop(), tailTarget, 'same-target tail reorder must not cancel a current-song replay in the same flush');
  revealed(movedTail, 60, 'tail reordering after manual browsing still reveals the actual playing song');
  movedTail.dispose();
}

const touchBeforeQuery = playerView();
touchBeforeQuery.open(); touchBeforeQuery.touch(); touchBeforeQuery.scroll(7.25 * touchBeforeQuery.stride());
const beforeQueryCommands = touchBeforeQuery.commands.length;
touchBeforeQuery.settle();
assert.equal(touchBeforeQuery.commands.length, beforeQueryCommands, 'touch before the query tick also cancels pending measurement positioning');
assert.equal(touchBeforeQuery.actualTop(), 7.25 * touchBeforeQuery.stride());
touchBeforeQuery.dispose(); viewCases++;

const touchBeforeReply = playerView();
touchBeforeReply.open(); touchBeforeReply.stepTick();
touchBeforeReply.touch(); touchBeforeReply.scroll(8.25 * touchBeforeReply.stride());
const commandCount = touchBeforeReply.commands.length;
touchBeforeReply.stepReply(); touchBeforeReply.settle();
assert.equal(touchBeforeReply.commands.length, commandCount, 'layout arriving after touch cannot issue a new programmatic command');
assert.equal(touchBeforeReply.actualTop(), 8.25 * touchBeforeReply.stride(), 'late layout must not seize an active gesture');
touchBeforeReply.dispose(); viewCases++;

const touchDuringReplay = playerView();
touchDuringReplay.open(); touchDuringReplay.stepTick(); touchDuringReplay.stepReply();
touchDuringReplay.touch(); touchDuringReplay.scroll(9.25 * touchDuringReplay.stride());
const beforeTouchTicks = touchDuringReplay.commands.length;
touchDuringReplay.settle();
assert.equal(touchDuringReplay.commands.length, beforeTouchTicks, 'touch invalidates already queued replays');
assert.equal(touchDuringReplay.actualTop(), 9.25 * touchDuringReplay.stride());
touchDuringReplay.dispose(); viewCases++;

const changedSong = playerView();
changedSong.open(); changedSong.stepTick(); changedSong.stepReply();
changedSong.player.current = changedSong.player.queue[45]; changedSong.commit(); changedSong.settle();
revealed(changedSong, 45, 'an old replay cannot overwrite a newer playing-song command');
changedSong.dispose();

const remounted = playerView();
remounted.open(); remounted.stepTick(); remounted.close();
remounted.player.current = remounted.player.queue[40]; remounted.open(); remounted.settle();
revealed(remounted, 40, 'a prior mount response cannot overwrite the reopened sheet');
remounted.dispose();
const disposed = playerView();
disposed.open(); disposed.stepTick(); const beforeDispose = disposed.commands.length;
disposed.dispose(); disposed.settle();
assert.equal(disposed.commands.length, beforeDispose, 'unmounted-page callbacks cannot publish scroll commands');
viewCases++;
console.log('playback queue: in-place opening, duplicate removal, native timeline, bounded windows and back dismissal passed');
console.log('player queue public view: ' + viewCases + ' first-open/reopen/tail/resize/gesture/lifecycle cases passed (synthetic host, not device drawing)');
