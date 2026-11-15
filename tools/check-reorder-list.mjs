// User-confirmed public seam: the complete production reorder SFC is compiled
// with its real template and mounted through Vue's renderer. A slotted consumer
// receives the public handle API, then emits real template touch events and reads
// reorder/active plus rendered following/preview styles. Only native rectangles,
// touch delivery, lifecycle, SDK storage/window and clock are owned boundaries.
// This is offline template behavior, NOT HBuilderX, Native Yoga or device proof.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';

const COMPONENT_PATH = 'uni_modules/qt-ui/components/qt-reorder-list/qt-reorder-list.uvue';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const source = read(COMPONENT_PATH);
// Keep SDK conditional compilation, including HTML conditional comments, at the
// real public source boundary; never substitute a drag algorithm in the fixture.
function platformSource(text, platform) {
  const symbols = new Set([platform]);
  if (platform.startsWith('APP-')) symbols.add('APP');
  const stack = [], out = [];
  let enabled = true;
  for (const line of text.split('\n')) {
    const directive = line.match(/^\s*(?:\/\/|<!--)\s*#(ifdef|ifndef|else|endif)\s*(.*?)\s*(?:-->)?\s*$/);
    if (!directive) { if (enabled) out.push(line); continue; }
    const [, kind, raw] = directive;
    if (kind === 'ifdef' || kind === 'ifndef') {
      const matches = raw.split(/\|\|/).some(value => symbols.has(value.trim()));
      stack.push({ parent: enabled, matches: kind === 'ifdef' ? matches : !matches });
      enabled = enabled && stack.at(-1).matches;
    } else {
      const frame = stack.at(-1);
      assert.ok(frame, 'platform source must have balanced directives');
      if (kind === 'else') enabled = frame.parent && !frame.matches;
      else { stack.pop(); enabled = frame.parent; }
    }
  }
  assert.equal(stack.length, 0);
  return out.join('\n');
}
function module(text, scope, platform) {
  const names = [...text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)].map(match => match[1]);
  const program = platformSource(text, platform).replace(/^import[\s\S]*?from\s*["'][^"']+["'];?\s*/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var))/g, '');
  return vm.runInNewContext(stripTypeScriptTypes(program, { mode: 'strip' }) + '\n;({' + names.join(',') + '})', scope);
}
export function compileReorderSfc(text, filename, scope, platform = 'APP-ANDROID') {
  const custom = tag => ['view', 'text', 'image', 'scroll-view'].includes(tag);
  const { descriptor, errors } = parse(platformSource(text, platform), { filename,
    templateParseOptions: { isCustomElement: custom } });
  assert.deepEqual(errors, [], 'the whole public SFC must parse');
  let program = compileScript(descriptor, { id: filename, inlineTemplate: true,
    templateOptions: { compilerOptions: { isCustomElement: custom } } }).content;
  program = program.replace(/import\s*\{([^}]+)\}\s*from\s*["']vue["'];?/g, (_all, imports) => {
    for (const entry of imports.split(',')) {
      const [original, alias = original] = entry.trim().split(/\s+as\s+/);
      scope[alias] = Vue[original];
    }
    return '';
  }).replace(/^import[\s\S]*?from\s*["'][^"']+["'];?\s*/gm, '')
    .replace('export default', 'const __component =');
  return vm.runInNewContext(stripTypeScriptTypes(program, { mode: 'strip' }) + '\n;__component;', { ...scope }, { filename });
}
function node(tag, text = '') { return { tag, text, props: {}, children: [], parent: null }; }
function detach(child) {
  if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}
function descendants(root) { return [root, ...root.children.flatMap(descendants)]; }
const classes = child => String(child.props.class ?? '').split(/\s+/);
const findClass = (root, name) => descendants(root).filter(child => classes(child).includes(name));
function css(value) {
  const style = Vue.normalizeStyle(value);
  if (typeof style !== 'string') return style ?? {};
  return Object.fromEntries(style.split(';').filter(entry => entry.includes(':')).map(entry => {
    const at = entry.indexOf(':'); return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()];
  }));
}
const renderer = Vue.createRenderer({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText(child, text) { child.text = text; }, setElementText(child, text) { child.text = text; child.children = []; },
  insert(child, parent, before = null) {
    detach(child); const at = before ? parent.children.indexOf(before) : -1;
    if (at < 0) parent.children.push(child); else parent.children.splice(at, 0, child);
    child.parent = parent;
  },
  remove: detach, parentNode: child => child.parent,
  nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
  patchProp(child, key, _old, value) { child.props[key] = value; },
});
const consumer = `<template>
<scroll-view :direction="scrollDirection">
  <QtReorderList :items="items" :disabled="disabled" @active="receiveActive" @reorder="receiveReorder">
    <template #default="{id,index,handle}">
      <view class="fixture-card" @click="expand(id)">
        <view class="fixture-title">
          <text class="fixture-label">{{ id }}</text><text class="fixture-index">{{ index }}</text>
          <view class="fixture-handle" :style="handle.style" @touchstart.stop="handle.start" @touchmove.stop="handle.move" @touchend.stop="handle.end" @touchcancel.stop="handle.cancel" @click.stop="handle.click">
            <text>Drag</text>
          </view>
        </view>
      </view>
    </template>
  </QtReorderList>
</scroll-view>
</template><script setup lang="ts">
import QtReorderList from "./qt-reorder-list.uvue";
const props = defineProps(["items","disabled","scrollDirection","receiveActive","receiveReorder","expand"]);
</script>`;
export async function reorderFixture({ items = [{id:'a'},{id:'b'},{id:'c'}], heights = {a:80,b:190,c:110},
  width = 375, height = 667, top = 50, gap = 12, platform = 'APP-ANDROID', fallback = false,
  consumerSource = consumer, consumerScope = {}, consumerProps = {}, rectangleOverride = null,
  consumerComponentFactory = null } = {}) {
  let time = 0, serial = 0;
  const timers = new Map(), replies = [], lifecycle = { show: [], hide: [], unload: [] };
  const records = { active: [], reorder: [], expand: [] }, storage = new Map();
  const root = node('fixture-root');
  const viewport = { windowWidth: width, windowHeight: height, screenWidth: width, screenHeight: height,
    screenTop: 0, windowTop: 0, statusBarHeight: 0, safeAreaInsets: { bottom: 0 } };
  const scope = { ...Vue, console, Date: class extends Date { static now() { return time; } },
    logWarn() {}, onShow: fn => lifecycle.show.push(fn), onHide: fn => lifecycle.hide.push(fn),
    onUnload: fn => lifecycle.unload.push(fn),
    setTimeout(fn, delay = 0) { const id = ++serial; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval(fn, delay) { const id = ++serial; timers.set(id, { fn, at: time + delay, repeat: delay }); return id; },
    clearInterval: id => timers.delete(id),
  };
  function rowLabel(row) { return findClass(row, 'fixture-label')[0]?.text ?? row.props.id; }
  function boxes() {
    let y = top;
    const result = new Map();
    for (const row of findClass(root, 'qrl-row')) {
      const size = heights[rowLabel(row)] ?? 80;
      result.set(row.props.id, { top: y, bottom: y + size, left: 16, right: width - 16, width: width - 32, height: size });
      y += size + gap;
    }
    for (const list of findClass(root, 'qrl')) result.set(list.props.id,
      { top, bottom: y - gap, left: 16, right: width - 16, width: width - 32, height: y - top - gap });
    return result;
  }
  scope.uni = {
    getWindowInfo: () => viewport,
    getStorageSync: key => storage.get(key) ?? null, setStorageSync: (key,value) => storage.set(key,value),
    createSelectorQuery() {
      const requests = [];
      return { selector: '', select(selector) { this.selector = selector; return this; },
        boundingClientRect(fn) { requests.push({ id: this.selector.slice(1), fn }); return this; },
        exec(fn) { replies.push(() => {
          const current = boxes(), values = requests.map((request, index) => rectangleOverride
            ? rectangleOverride(request.id, index, current.get(request.id) ?? null) : current.get(request.id) ?? null);
          requests.forEach((request,index) => request.fn(values[index])); if (fn) fn(values);
        }); },
      };
    },
  };
  for (const path of ['uni_modules/qt-ui/composables/fold-geometry.ts',
    'uni_modules/qt-ui/composables/use-qt-layout.ts', 'uni_modules/qt-ui/stores/theme.ts',
    'uni_modules/qt-ui/stores/font-scale.ts']) Object.assign(scope, module(read(path), scope, platform));
  Object.assign(scope, consumerScope);
  scope.QtReorderList = compileReorderSfc(source, COMPONENT_PATH, scope, platform);
  const props = Vue.reactive({ items, disabled: false, scrollDirection: 'vertical',
    receiveActive(value) { records.active.push(value); props.scrollDirection = value ? 'none' : 'vertical'; },
    receiveReorder(value) { records.reorder.push(Array.from(value)); }, expand: id => records.expand.push(id), ...consumerProps });
  const Consumer = fallback ? null : consumerComponentFactory
    ? consumerComponentFactory(scope) : compileReorderSfc(consumerSource, 'reorder-consumer.uvue', scope, platform);
  const app = renderer.createApp({ setup: () => () => fallback
    ? Vue.h(scope.QtReorderList, { items: props.items, disabled: props.disabled, onActive: props.receiveActive, onReorder: props.receiveReorder })
    : Vue.h(Consumer, props) });
  app.mount(root);
  async function flush() { await Vue.nextTick(); for (let i=0;i<8;i++) await Promise.resolve(); await Vue.nextTick(); }
  await flush();
  function handle(id) {
    const card = findClass(root, 'fixture-card').find(child => findClass(child, 'fixture-label')[0]?.text === id);
    return card ? findClass(card, 'fixture-handle')[0] : findClass(root, 'qrl-handle')[items.findIndex(item => item.id === id)];
  }
  async function dispatch(target, type, { y=80, identifier=7, touchCount=1, changedIdentifier=identifier }={}) {
    assert.ok(target, 'public handle must be rendered');
    let stopped = false, prevented = false;
    const ended = ['touchend','touchcancel'].includes(type);
    const event = { type, touches: ended ? [] : Array.from({length:touchCount}, (_v,index) => ({clientX:32,clientY:y,identifier:identifier+index})),
      changedTouches: [{clientX:32,clientY:y,identifier:changedIdentifier}],
      stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } };
    const key = 'on' + type[0].toUpperCase() + type.slice(1);
    for (let current=target;current;current=current.parent) {
      const callback = current.props[key]; if (Array.isArray(callback)) callback.forEach(fn => fn(event)); else callback?.(event);
      if (stopped) break;
    }
    await flush(); return { stopped, prevented };
  }
  async function reply() { assert.ok(replies.length, 'a real native rectangle request is pending'); replies.shift()(); await flush(); }
  async function advance(ms) {
    const target = time + ms; await flush();
    for (let i=0;i<100;i++) {
      const next = [...timers].filter(([,entry]) => entry.at <= target).sort((a,b) => a[1].at-b[1].at)[0];
      if (!next) { time=target; await flush(); return; }
      time=next[1].at; timers.delete(next[0]);
      if (next[1].repeat) timers.set(next[0], {...next[1],at:time+next[1].repeat});
      next[1].fn(); await flush();
    }
    throw new Error('owned native clock did not settle');
  }
  return { props, records, root, scope, lifecycle, heights, timers, replies, flush, handle, dispatch, reply, advance,
    rows: () => findClass(root, 'qrl-row'), preview: () => findClass(root, 'qrl-preview'),
    row: id => findClass(root, 'qrl-row').find(row => findClass(row, 'fixture-label')[0]?.text === id),
    style: child => css(child?.props.style),
    async unmount() { app.unmount(); scope.pauseQtLayoutWatcher(); await flush(); } };
}

export async function runReorderChecks() {
let cases = 0;
async function test(name, run) { await run(); cases++; console.log('PASS ' + name); }
await test('variable-height cards follow the real handle, preview the drop and emit once', async () => {
  const view = await reorderFixture();
  try {
    const handle = view.handle('a');
    assert.equal(view.style(handle).width, '44px'); assert.equal(view.style(handle).height, '44px');
    await view.dispatch(handle, 'touchstart', {y:80});
    assert.deepEqual(view.records.active, [true], 'pending native measurement locks the actual parent scroll-view');
    assert.equal(descendants(view.root).find(child => child.tag === 'scroll-view').props.direction, 'none');
    await view.reply();
    const event = await view.dispatch(handle, 'touchmove', {y:335});
    assert.equal(event.stopped, true);
    assert.equal(event.prevented, false, 'native drag uses parent direction none, not Web preventDefault');
    assert.equal(view.style(findClass(view.row('a'), 'qrl-body')[0]).transform, 'translateY(255px)', 'the actual slotted card follows the finger');
    assert.equal(view.preview().length, 1, 'an actual destination placeholder is rendered');
    assert.equal(view.style(view.preview()[0]).top, '202px', '190px neighbour + 12px measured gap determines the target');
    assert.equal(view.style(view.preview()[0]).height, '80px');
    assert.deepEqual(view.records.reorder, [], 'preview never persists before release');
    await view.dispatch(handle, 'touchend', {y:335});
    assert.deepEqual(view.records.reorder, [['b','a','c']]);
    assert.deepEqual(view.records.active, [true,false]);
    assert.equal(view.preview().length, 0);
    await view.dispatch(handle, 'touchend', {y:335}); await view.dispatch(handle, 'click');
    assert.equal(view.records.reorder.length, 1, 'repeat end cannot publish a second save');
    assert.deepEqual(view.records.expand, [], 'the handle click cannot expand the card');
  } finally { await view.unmount(); }
});
await test('external item changes cancel pending measurements and cannot replay an old order', async () => {
  const view = await reorderFixture();
  try {
    const handle = view.handle('a');
    await view.dispatch(handle, 'touchstart', {y:80});
    assert.deepEqual(view.records.active, [true]);
    view.props.items = [{id:'c'},{id:'a'},{id:'b'}];
    await view.flush();
    assert.deepEqual(view.records.active, [true,false], 'external data owns order and immediately unlocks parent');
    await view.reply();
    await view.dispatch(handle, 'touchmove', {y:500});
    await view.dispatch(handle, 'touchend', {y:500});
    assert.deepEqual(view.records.reorder, [], 'late rectangle response cannot resurrect the old gesture');
    assert.equal(view.preview().length, 0);
  } finally { await view.unmount(); }
});
await test('global disable cancels an active drop and disables new handle starts', async () => {
  const view = await reorderFixture();
  try {
    const handle = view.handle('a');
    await view.dispatch(handle, 'touchstart', {y:80}); await view.reply();
    await view.dispatch(handle, 'touchmove', {y:335});
    view.props.disabled = true; await view.flush();
    assert.deepEqual(view.records.active, [true,false], 'a saving parent must release and cancel the active gesture');
    await view.dispatch(handle, 'touchend', {y:335});
    await view.dispatch(view.handle('a'), 'touchstart', {y:80});
    assert.deepEqual(view.records.reorder, []);
    assert.equal(view.replies.length, 0, 'disabled handles never query native nodes');
  } finally { await view.unmount(); }
});
for (const lifecycle of ['hide', 'unload', 'unmount']) await test(lifecycle + ' cancels pending native queries and never publishes after return', async () => {
  const view = await reorderFixture();
  try {
    const handle = view.handle('a');
    await view.dispatch(handle, 'touchstart', {y:80});
    if (lifecycle === 'unmount') await view.unmount();
    else { view.lifecycle[lifecycle].forEach(callback => callback()); await view.flush(); }
    assert.deepEqual(view.records.active, [true,false], 'leaving the page must release the real parent lock');
    await view.reply();
    if (lifecycle !== 'unmount') { await view.dispatch(handle, 'touchend', {y:500}); }
    assert.deepEqual(view.records.reorder, []);
    assert.equal(view.preview().length, 0);
  } finally { if (lifecycle !== 'unmount') await view.unmount(); }
});
await test('a missing native measurement receipt releases the parent within a bounded interval', async () => {
  const view = await reorderFixture();
  try {
    const handle = view.handle('a'); await view.dispatch(handle, 'touchstart', {y:80});
    await view.advance(600);
    assert.deepEqual(view.records.active, [true,false], 'a silent native query must not leave scrolling locked');
    await view.reply(); await view.dispatch(handle, 'touchend', {y:500});
    assert.deepEqual(view.records.reorder, []); assert.equal(view.preview().length, 0);
  } finally { await view.unmount(); }
});
for (const change of ['font', 'window', 'item-disable']) await test(change + ' invalidates measured geometry before a drop', async () => {
  const view = await reorderFixture();
  try {
    const handle = view.handle('a'); await view.dispatch(handle, 'touchstart', {y:80}); await view.reply();
    await view.dispatch(handle, 'touchmove', {y:335});
    if (change === 'font') { view.heights.b = 330; view.scope.fontScale.scale = 1.5; }
    else if (change === 'window') { const layout = view.scope.qtLayout(); layout.windowWidth = 1100; layout.paneWidth = 1100; layout.sizeEpoch++; }
    else view.props.items[0].disabled = true;
    await view.flush();
    assert.deepEqual([...view.records.active], [true,false], 'stale row geometry must never commit after ' + change);
    await view.dispatch(handle, 'touchend', {y:335});
    assert.deepEqual(view.records.reorder, []); assert.equal(view.preview().length, 0);
    if (change === 'font') {
      await view.dispatch(view.handle('a'), 'touchstart', {y:80}); await view.reply();
      await view.dispatch(view.handle('a'), 'touchmove', {y:335});
      assert.equal(view.style(view.preview()[0]).top, '342px', 'new drag remeasures the actual taller card');
      await view.dispatch(view.handle('a'), 'touchcancel');
    }
  } finally { await view.unmount(); }
});
await test('disabled rows remain fixed anchors while an enabled-off platform can still move', async () => {
  const view = await reorderFixture({items:[{id:'a',enabled:false},{id:'b'},{id:'c',disabled:true}]});
  try {
    await view.dispatch(view.handle('c'), 'touchstart', {y:375});
    assert.deepEqual(view.records.active, [], 'unavailable anchor cannot start a gesture');
    const handle = view.handle('a'); await view.dispatch(handle, 'touchstart', {y:80}); await view.reply();
    await view.dispatch(handle, 'touchmove', {y:650});
    assert.equal(view.style(view.preview()[0]).top, '202px', 'drop is clamped before the disabled tail');
    await view.dispatch(handle, 'touchend', {y:650});
    assert.deepEqual(view.records.reorder, [['b','a','c']], 'anchor stays at the same final index');
  } finally { await view.unmount(); }
});
await test('a middle disabled row bounds drag in both directions without crossing it', async () => {
  const view = await reorderFixture({items:[{id:'a'},{id:'x',disabled:true},{id:'b'},{id:'c'}],heights:{a:80,x:60,b:190,c:110}});
  try {
    const handle = view.handle('c'); await view.dispatch(handle, 'touchstart', {y:460}); await view.reply();
    await view.dispatch(handle, 'touchmove', {y:-200}); await view.dispatch(handle, 'touchend', {y:-200});
    assert.deepEqual(view.records.reorder, [['a','x','c','b']]);
    const first = view.handle('a'); await view.dispatch(first,'touchstart',{y:80}); await view.reply();
    await view.dispatch(first,'touchmove',{y:900}); await view.dispatch(first,'touchend',{y:900});
    assert.equal(view.records.reorder.length,1, 'a bounded single-row segment emits no unchanged reorder');
  } finally { await view.unmount(); }
});
await test('only the initiating touch can move and end the drop; multi-touch cancels', async () => {
  const view = await reorderFixture();
  try {
    const handle = view.handle('a'); await view.dispatch(handle,'touchstart',{y:80,identifier:7}); await view.reply();
    await view.dispatch(handle,'touchmove',{y:335,identifier:7});
    await view.dispatch(handle,'touchend',{y:500,changedIdentifier:99});
    assert.deepEqual(view.records.reorder, [], 'a different finger release cannot commit the drag');
    assert.deepEqual([...view.records.active],[true]);
    await view.dispatch(handle,'touchmove',{y:500,identifier:7,touchCount:2});
    assert.deepEqual([...view.records.active],[true,false], 'adding a second touch abandons the gesture');
    await view.dispatch(handle,'touchend',{y:500,identifier:7});
    assert.deepEqual(view.records.reorder, []);
  } finally { await view.unmount(); }
});
for (const invalid of ['null','zero','infinite-height','nan-width','overlap']) await test('invalid native geometry ' + invalid + ' cancels without order publication', async () => {
  const view = await reorderFixture({rectangleOverride: (_id,index,rect) => {
    if (index !== 1) return rect;
    if (invalid === 'null') return null;
    if (invalid === 'zero') return {...rect,height:0};
    if (invalid === 'infinite-height') return {...rect,height:Infinity};
    if (invalid === 'nan-width') return {...rect,width:NaN};
    return {...rect,top:40};
  }});
  try {
    const handle=view.handle('a'); await view.dispatch(handle,'touchstart',{y:80}); await view.reply();
    assert.deepEqual([...view.records.active],[true,false]);
    await view.dispatch(handle,'touchmove',{y:500}); await view.dispatch(handle,'touchend',{y:500});
    assert.deepEqual(view.records.reorder, []); assert.equal(view.preview().length,0);
  } finally { await view.unmount(); }
});
for (const mode of ['tap','cancel','release-before-measure','empty-id','duplicate-id','nonfinite-start','nonfinite-move']) await test(mode + ' cannot save a drag order', async () => {
  const view = await reorderFixture({items: mode === 'empty-id' ? [{id:''},{id:'b'}] : mode === 'duplicate-id' ? [{id:'a'},{id:'a'},{id:'b'}] : undefined});
  try {
    const handle = view.handle(mode === 'empty-id' ? '' : 'a');
    await view.dispatch(handle,'touchstart',{y:mode === 'nonfinite-start' ? NaN : 80});
    if (['empty-id','duplicate-id','nonfinite-start'].includes(mode)) {
      assert.deepEqual(view.records.active, []); assert.equal(view.replies.length,0); return;
    }
    if (mode !== 'release-before-measure') await view.reply();
    if (mode !== 'tap') await view.dispatch(handle,'touchmove',{y:mode === 'nonfinite-move' ? NaN : 335});
    if (mode === 'cancel') await view.dispatch(handle,'touchcancel');
    await view.dispatch(handle,'touchend',{y:335});
    if (mode === 'release-before-measure') await view.reply();
    assert.deepEqual(view.records.reorder, [], 'only an actual valid moved release commits');
    assert.deepEqual([...view.records.active],[true,false]); assert.equal(view.preview().length,0);
  } finally { await view.unmount(); }
});
console.log(`reorder-list: ${cases} public template cases passed (owned native host; device/compiler NOT RUN)`);
return cases;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runReorderChecks();
