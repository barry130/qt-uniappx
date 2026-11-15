// 执行播放页真实函数，复现首帧几何未完成、自动滚动和渐隐尾帧问题。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { compile } from '@vue/compiler-dom';
import * as Vue from 'vue';
import { lyricFocusAt, lyricTextFocusStyle } from '../uni_modules/qt-ui/composables/lyric-presentation.ts';
const source = readFileSync(new URL('../pages/player/index.uvue', import.meta.url), 'utf8');
const names = ['lyricLineMetrics', 'computeLyricOpacity', 'lineOpacityStyle', 'lyricScrollValue',
  'lyricTargetFromScrollTop', 'setLyricScrollTop', 'onLyricUserScroll', 'measureLyricCenter', 'measureLyricLineHeights',
  'lyricBlurPx', 'lrcStyle', 'lrcRomaStyle', 'lrcTrStyle', 'isKaraokeLine', 'karaokeWordStyle',
  'karaokeLitStyle', 'karaokeFillStyle', 'karaokeText', 'hasRoma', 'hasTr', 'format', 'onLyricScrollTouchStart'];
const fonts = source.match(/^const (?:WIDE_LYRIC_FONT|PORTRAIT_LYRIC_FONT) = .+;$/gm);
const karaokeFont = source.match(/const karaokeFontSize = computed\([^]*?\n\}\);/);
assert.equal(fonts?.length, 2);
assert.ok(karaokeFont);
const code = stripTypeScriptTypes(fonts.join('\n') + '\n' + karaokeFont[0] + '\n' + names.map(name => {
  const match = source.match(new RegExp('function ' + name + '\\([^]*?\\n\\}'));
  assert.ok(match, name);
  return match[0];
}).join('\n'));
function setup(wide = false) {
  let now = 10000;
  let timerId = 0;
  let updates = 0;
  const ticks = [];
  const timers = new Map();
  const box = value => ({ value });
  const context = vm.createContext({
    qtPerformance:{reduceMotion:false,expensiveEffects:true}, Date: { now: () => now }, Math, Number, lyricFocusAt, lyricTextFocusStyle,
    computed: fn => ({ get value() { return fn(); } }), fontScale: { scale: 1 },
    // 用户歌词字号倍率（stores/lyric-size.ts）：播放页三个渲染口径都读它，
    // 默认 1 才能保证与历史字号完全一致（下面的五档 fontScale 用例就是这个前提）
    lyricSize: { scale: 1 },
    playerInk: box('#ffffff'), playerMuted: box('#a0a0a0'), playerRail: box('#202020'),
    theme: { skin: { mediaText: '#ffffff', mediaControl: '#202020' } },
    playingStyle: { style: "classic" }, galleryLyrics: box(false), immersiveLyrics: box(false),
    showLyric: box(true), portraitLyricStyle: box('height:600px;'), lyricPadStyle: box('300px;'),
    lyricScrollAnimated: box(false), activeLyric: box(3), karaokeWordIndex: box(1), karaokeFillPct: box(50),
    touchFromLyricScroll: false, toggleLyric() {}, onLyricBackgroundTap() {}, copyLyric() {}, onLyricLineTap() {}, qtFontDual: () => '',
    layout: { isWide: wide }, lyricUnit: 0.5, pageAlive: true, pageVisible: box(true), lyricLoadGeneration: 0, lyricLinesKey: box('fixture'),
    tv: { enabled: false }, tvLyricBrowsing: box(false),
    lyricLines: box(Array.from({ length: 20 }, (_, i) => ({ text: 'line ' + i, time: i * 3 }))),
    lyricViewportHeightPx: box(600), lyricPadPx: box(300), lyricPadRpx: box(600),
    lyricLineHeightsPx: box(Array(20).fill(50)), lyricLineOpacity: box([]), lyricLineBlur: box([]),
    lyricActualScrollTop: 0, lyricOpacityTimer: null, lyricOpacityLastAt: 0,
    lyricProgrammaticUntil: 0, lyricLastTarget: 0, lyricScrollTop: box(0),
    lyricTouchAt: 0, lyricUserScrollAt: 0, lyricTimesVisible: box(false), lyricTargetIndex: box(-1),
    lyricTimesTimer: null, lyricVisible: box(true), lyricSeekable: box(true), lyricCenterRetry: 0, lyricCenterTimer: null,
    LYRIC_CENTER_MAX_RETRY: 4, qtRpx: () => 0.5, qtDiag() {},
    nextTick: fn => ticks.push(fn), updateLyricScroll: () => updates++,
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    uni: { createSelectorQuery: () => ({
      select() { return this; }, boundingClientRect(fn) { this.fn = fn; return this; },
      exec() { this.fn({ height: 600 }); },
    }) },
  });
  vm.runInContext(code, context);
  return {
    c: context, advance: ms => { now += ms; },
    event: top => context.onLyricUserScroll({ detail: { scrollTop: top } }),
    flushTicks: () => { while (ticks.length) ticks.shift()(); },
    flushTimers: () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); },
    updates: () => updates,
  };
}
const first = setup();
first.c.lyricLineHeightsPx.value = [];
first.c.computeLyricOpacity(500);
assert.equal(first.c.lineOpacityStyle(12), 'opacity:1.00;');
first.c.lyricLineHeightsPx.value = Array(20).fill(50);
first.c.lyricViewportHeightPx.value = 0;
first.c.computeLyricOpacity(500);
assert.equal(first.c.lineOpacityStyle(12), 'opacity:1.00;');
console.log('✓ 视口或行高未测量时，首帧歌词保持可见');

for (const wide of [false, true]) {
  const e = setup(wide);
  if (wide) { e.c.lyricViewportHeightPx.value = 240; e.c.lyricPadPx.value = 120; }
  e.c.setLyricScrollTop(500);
  assert.equal(e.c.lineOpacityStyle(10), 'opacity:0.00;');
  e.event(500); // 无触摸，且仍在程序化滚动窗口内
  assert.equal(e.c.lineOpacityStyle(10), 'opacity:1.00;');
  assert.equal(e.c.lyricTimesVisible.value, false);
  assert.equal(e.c.lyricUserScrollAt, 0);
  console.log('✓ ' + (wide ? '宽屏' : '竖屏') + '自动滚动按实际位置恢复歌词，保持手势门控');
}
const tail = setup();
tail.c.setLyricScrollTop(500);
tail.event(100);
tail.advance(20);
tail.event(500);
assert.equal(tail.c.lineOpacityStyle(10), 'opacity:0.00;');
tail.advance(60);
tail.flushTimers();
assert.equal(tail.c.lineOpacityStyle(10), 'opacity:1.00;');
console.log('✓ 滚动结束的最后一次位置不被限频丢弃');

const manual = setup();
manual.c.lyricTouchAt = 10000;
manual.event(500);
assert.equal(manual.c.lineOpacityStyle(10), 'opacity:1.00;');
assert.equal(manual.c.lyricTimesVisible.value, true);
assert.equal(manual.c.lyricTargetIndex.value, 10);
assert.equal(manual.c.lyricUserScrollAt, 10000);
console.log('✓ 手动滚动仍显示目标时间并暂停自动跟随');

const layout = setup();
layout.c.lyricPadPx.value = 120;
layout.c.measureLyricCenter();
assert.equal(layout.c.lyricPadPx.value, 300);
assert.equal(layout.updates(), 0);
layout.flushTicks();
assert.equal(layout.updates(), 1);
layout.c.pageAlive = false;
layout.c.measureLyricCenter();
layout.flushTicks();
assert.equal(layout.updates(), 1);
console.log('✓ 留白布局提交后才定位，离开页面后不再测量');
console.log('歌词视口回归检查通过（6 组）');

const hidden = setup();
hidden.c.lyricVisible.value = false;
hidden.c.uni.createSelectorQuery = () => { throw Error('non-scrollable style must not measure missing timeline nodes'); };
hidden.c.measureLyricCenter();
hidden.c.measureLyricLineHeights();
hidden.flushTimers();
assert.equal(hidden.updates(), 0);
console.log('✓ 封面与固定句歌词风格不测量未挂载的滚动歌词节点');

// Confirmed public view seam: compile the two actual lyric templates, dispatch their
// @touchstart/@scroll callbacks, and observe the rendered native text/row styles.
// Geometry and unrelated controls are synthetic host boundaries, not native drawing.
const templates = source.match(/<scroll-view[^>]*class="lyric lyric-viewport"[^]*?<\/scroll-view>/g);
assert.equal(templates?.length, 2, 'both public lyric viewports must be exercised');
const renders = templates.map(template => new Function('Vue', compile(template, {
  mode: 'function', isCustomElement: () => true,
}).code)(Vue));
function viewFixture(wide, measured = true) {
  const fixture = setup(wide);
  const ratio = wide ? 0.4 : 1;
  fixture.c.lyricViewportHeightPx.value = 600 * ratio;
  fixture.c.lyricPadPx.value = 300 * ratio;
  fixture.c.lyricPadStyle.value = 300 * ratio + 'px;';
  fixture.c.lyricLines.value = Array.from({ length: 6 }, (_, i) => ({
    text: 'line ' + i, time: i * 3, romanization: 'roman ' + i, translation: 'long translation ' + i,
    words: i === 3 ? [{ text: 'a ' }, { text: 'b ' }] : null,
  }));
  // Includes tall translated rows; a fixed row estimate or index-distance shortcut is wrong.
  fixture.c.lyricLineHeightsPx.value = measured ? [50, 150, 100, 50, 250, 50].map(px => px * ratio) : [];
  const ctx = new Proxy(fixture.c, { get(target, key) {
    const value = target[key];
    return value != null && typeof value === 'object' && 'value' in value ? value.value : value;
  } });
  return { ...fixture, ratio, render: () => renders[wide ? 0 : 1](ctx, []) };
}
function descendants(node) {
  if (node == null || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(descendants) : [])];
}
function classNodes(node, name) {
  return descendants(node).filter(vnode => (vnode.props?.class || '').split(' ').includes(name));
}
function paint(node) {
  const style = node.props?.style || {};
  return typeof style === 'string' ? Object.fromEntries(style.split(';').filter(Boolean).map(entry => {
    const colon = entry.indexOf(':');
    return [entry.slice(0, colon), entry.slice(colon + 1)];
  })) : style;
}
for (const wide of [false, true]) {
  const v = viewFixture(wide);
  let viewport = v.render();
  viewport.props.onTouchstart();
  viewport.props.onScroll({ detail: { scrollTop: 499 * v.ratio } });
  let rows = classNodes(v.render(), 'lyric-line');
  assert.equal(paint(rows[4]).opacity, '1.00', 'the actual center of a tall translated row stays readable');
  for (const name of ['lrc', 'lrc-roma', 'lrc-tr']) {
    assert.equal(paint(classNodes(rows[4], name)[0])['text-shadow'], 'none', 'every centered text node clears soft focus');
  }
  assert.equal(paint(rows[3]).opacity, '0.80', 'nearby upper context remains readable instead of becoming a blank band');
  for (const name of ['lrc-karaoke-word', 'lrc-roma', 'lrc-tr']) {
    for (const node of classNodes(rows[3], name)) {
      assert.equal(paint(node)['text-shadow'], 'none', 'the enlarged clear band reaches every nearby text layer');
      assert.notEqual(paint(node).color, 'transparent');
    }
  }
  v.advance(80);
  v.render().props.onScroll({ detail: { scrollTop: 559 * v.ratio } });
  rows = classNodes(v.render(), 'lyric-line');
  assert.equal(paint(rows[3]).opacity, '0.29', 'distant playing text still receives physical focus during manual browsing');
  const words = classNodes(rows[3], 'lrc-karaoke-word');
  assert.equal(words.length, 3, 'the word base and half-word overlay both remain mounted');
  for (const word of words) {
    assert.equal(paint(word).color, 'transparent');
    assert.match(paint(word)['text-shadow'], /^0px 0px 0\.6px /, 'both karaoke layers use the same light physical focus');
  }
  assert.equal(paint(words[0])['text-shadow'], '0px 0px 0.6px #ffffff', 'sung words retain highlight ink');
  assert.equal(paint(words[1])['text-shadow'], '0px 0px 0.6px #a0a0a0', 'unsung word base retains muted ink');
  assert.equal(paint(words[2])['text-shadow'], '0px 0px 0.6px #ffffff', 'half-word fill retains highlight ink');
  assert.equal(words[1].children, words[2].children, 'the overlay glyph exactly matches its base');
  assert.equal(paint(classNodes(rows[3], 'lrc-karaoke-fill')[0]).width, '50%', 'soft focus does not change half-word progress');
  for (const name of ['lrc-roma', 'lrc-tr']) {
    assert.equal(paint(classNodes(rows[3], name)[0]).color, 'transparent', 'secondary text also receives distant focus');
  }
  assert.equal(paint(classNodes(rows[3], 'lrc-roma')[0])['text-shadow'], '0px 0px 0.6px #ffffff');
  assert.equal(paint(classNodes(rows[3], 'lrc-tr')[0])['text-shadow'], '0px 0px 0.6px #a0a0a0');
  // A plain main lyric at the same physical distance gets the same mild focus.
  const ordinary = viewFixture(wide);
  ordinary.render().props.onScroll({ detail: { scrollTop: 484 * ordinary.ratio } });
  const ordinaryRow = classNodes(ordinary.render(), 'lyric-line')[2];
  assert.equal(paint(ordinaryRow).opacity, '0.29');
  assert.equal(paint(classNodes(ordinaryRow, 'lrc')[0])['text-shadow'], '0px 0px 0.6px #a0a0a0');
  const following = viewFixture(wide);
  for (const [top, opacity, shadow] of [[151, '0.80', 'none'], [91, '0.29', '0px 0px 0.6px #ffffff']]) {
    following.advance(80);
    following.render().props.onScroll({ detail: { scrollTop: top * following.ratio } });
    const lowerRow = classNodes(following.render(), 'lyric-line')[3];
    assert.equal(paint(lowerRow).opacity, opacity, 'lower context mirrors the upper context at the same actual viewport distance');
    assert.equal(paint(classNodes(lowerRow, 'lrc-karaoke-word')[0])['text-shadow'], shadow);
  }
  following.c.fontScale.scale = 1.5;
  following.advance(80);
  following.render().props.onScroll({ detail: { scrollTop: 31 * following.ratio } });
  const outerRow = classNodes(following.render(), 'lyric-line')[3];
  assert.equal(paint(outerRow).opacity, '0.00', 'the mathematical fade endpoint is not claimed as visible');
  assert.equal(paint(classNodes(outerRow, 'lrc-karaoke-word')[0])['text-shadow'], '0px 0px 1.5px #ffffff',
    'highest-font native paint clamps the 1.2px curve radius rather than producing a 1.8px haze');
  assert.equal(paint(classNodes(outerRow, 'lrc-tr')[0])['text-shadow'], '0px 0px 1.5px #a0a0a0');
  for (const scale of [0.85, 1, 1.15, 1.3, 1.5]) {
    v.c.fontScale.scale = scale; // synthetic public font-setting input
    rows = classNodes(v.render(), 'lyric-line');
    const font = Math.round((wide ? 27 * 0.7 : 44) * scale) + (wide ? 'px' : 'rpx');
    assert.equal(paint(classNodes(rows[4], 'lrc')[0])['font-size'], font);
    for (const word of classNodes(rows[3], 'lrc-karaoke-word')) assert.equal(paint(word)['font-size'], font);
    const shadow = '0px 0px ' + (0.6 * scale).toFixed(1) + 'px ';
    assert.equal(paint(classNodes(rows[3], 'lrc-karaoke-word')[0])['text-shadow'], shadow + '#ffffff');
    assert.equal(paint(classNodes(rows[3], 'lrc-tr')[0])['text-shadow'], shadow + '#a0a0a0');
  }
  // 用户自选歌词字号（stores/lyric-size.ts，2026-11-14）：主行 / 逐字 / 译文 / 罗马音
  // 四个渲染口径必须同乘一个倍率，且与全局 fontScale 相乘而不是互相覆盖。
  for (const size of [0.7, 1, 1.2, 1.3]) {
    for (const fontScale of [1, 1.5]) {
      v.c.lyricSize.scale = size;
      v.c.fontScale.scale = fontScale;
      rows = classNodes(v.render(), 'lyric-line');
      const mainBase = wide ? 27 * 0.7 : 44;
      const main = Math.round(mainBase * fontScale * size) + (wide ? 'px' : 'rpx');
      assert.equal(paint(classNodes(rows[4], 'lrc')[0])['font-size'], main,
        'user lyric size multiplies with the global font scale on main lines');
      for (const word of classNodes(rows[3], 'lrc-karaoke-word')) {
        assert.equal(paint(word)['font-size'], main, 'karaoke words share the main line size calculation');
      }
      const subBase = wide ? 27 - 12 : 44 - 12;
      const sub = Math.round(subBase * (wide ? 0.7 : 1) * fontScale * size) + (wide ? 'px' : 'rpx');
      assert.equal(paint(classNodes(rows[3], 'lrc-tr')[0])['font-size'], sub,
        'translation follows the same user size factor');
      assert.equal(paint(classNodes(rows[3], 'lrc-roma')[0])['font-size'], sub,
        'romanization follows the same user size factor');
    }
  }
  v.c.lyricSize.scale = 1;
  v.c.fontScale.scale = 1;
  v.advance(80);
  v.render().props.onScroll({ detail: { scrollTop: 325 * v.ratio } });
  rows = classNodes(v.render(), 'lyric-line');
  for (const word of classNodes(rows[3], 'lrc-karaoke-word')) {
    assert.equal(paint(word)['text-shadow'], 'none', 'returning to the center clears previously blurred karaoke nodes');
    assert.notEqual(paint(word).color, 'transparent', 'returning to the center restores visible glyph color');
  }
  const firstFrame = viewFixture(wide, false);
  firstFrame.render().props.onScroll({ detail: { scrollTop: 499 * firstFrame.ratio } });
  for (const row of classNodes(firstFrame.render(), 'lyric-line')) {
    assert.equal(paint(row).opacity, '1.00');
    for (const name of ['lrc', 'lrc-roma', 'lrc-tr', 'lrc-karaoke-word']) {
      for (const text of classNodes(row, name)) assert.equal(paint(text)['text-shadow'], 'none');
    }
  }
}
console.log('歌词公开模板检查通过：宽窄实际滚动 / 不等行高 / 主译读音柔焦 / 逐字双层与半词 / 五档字号 / 中心复位与首帧（模拟宿主，非设备绘制）');

// Same public view seam, now including the actual size controls, reactive page wiring,
// and progress gestures. Native layout/scroll delivery and audio are the host boundaries.
const sizeStoreSource = stripTypeScriptTypes(readFileSync(new URL('../stores/lyric-size.ts', import.meta.url), 'utf8')
  .replace(/^import .+;\r?$/gm, '').replace(/^export /gm, ''));
const sizeSheet = source.match(/<QtSheet v-model:visible="sizeOpen"[^]*?<\/QtSheet>/)[0];
const sizeControls = sizeSheet.match(/<view class="offset-steps"[^]*?<\/view>\s*<\/view>/)[0];
const progressTemplates = source.match(/<view class="prog-range"[^]*?<\/view>\s*<\/view>/g);
assert.equal(progressTemplates?.length, 2);
const controlRender = template => new Function('Vue', compile(template, { mode: 'function', isCustomElement: () => true }).code)(Vue);
const renderSizeControls = controlRender(sizeControls);
const renderProgress = progressTemplates.map(controlRender);
const gestureNames = ['cancelTvSeek', 'applyLyricSize', 'nudgeLyricSize', 'resetLyricSize', 'updateLyricScroll',
  'applyLyricPreview', 'previewBySeconds', 'progPct', 'progFromClientX', 'progTrackWidth',
  'progTrackLeft', 'progThumbLeft', 'onProgTouchStart', 'onProgTouchMove', 'onProgTouchEnd', 'onProgTouchCancel'];
const gestureCode = stripTypeScriptTypes(gestureNames.map(name => {
  const match = source.match(new RegExp('function ' + name + '\\([^]*?\\n\\}'));
  assert.ok(match, name);
  return match[0];
}).join('\n'));
const geometryWiring = source.match(/  const refreshPlayerGeometry = \(\): void => \{[^]*?\n  watch\(\(\) => playingStyle\.style,[^]*?\n  \}\);/);
assert.ok(geometryWiring, 'load the actual mounted geometry watchers, not a test-owned substitute');
function sizeSeekFixture(wide) {
  const v = viewFixture(wide);
  const c = v.c;
  const measurements = [];
  const stops = [];
  const seeks = [];
  const karaokeResets = [];
  const storage = new Map();
  Object.assign(c, {
    reactive: Vue.reactive, watch: (...args) => { const stop = Vue.watch(...args); stops.push(stop); return stop; },
    nextTick: Vue.nextTick, logWarn() {},
    layout: Vue.reactive({ isWide: wide, paneWidth: wide ? 960 : 360, paneHeight: 640 }),
    fontScale: Vue.reactive({ scale: 1 }), playingStyle: Vue.reactive({ style: 'classic' }),
    player: { duration: 223, progress: 148.4, seek(seconds) { this.progress = seconds; seeks.push(seconds); } },
    dragging: { value: false }, dragValue: { value: 148.4 }, lyricPreviewAt: 0, touchFromProg: false,
    lyricMeasureSeq: 0, lyricMeasureRetry: 0, lyricMeasureTimer: null, LYRIC_MEASURE_MAX_RETRY: 4,
    lyricScrollPending: false, lyricOffsetSec: () => 0, stepKaraoke() {}, resetKaraoke() { karaokeResets.push(c.lyricSize.scale); },
    stopDiscSpin() {}, syncDiscSpin() {}, refreshProgFallback() {},
    measureProgTrack() { c.progWidth.value = 223; },
    progWidth: { value: 223 }, progFallbackWidth: 223, progFallbackLeft: 0, progLeft: 0, progUnit: 0.48,
    portraitMetrics: { value: { progressRowPx: 36 } }, playerAccent: { value: '#ffffff' },
    castCanSeek: { value: true }, LYRIC_SIZE_STEP: 0.1,
    tvSeekEditing: { value: false }, tvSeekAvailable: { value: false },
    tvSeekTrackKey: '', tvSeekPresentationKey: '', tvSeekMoveAt: 0,
  });
  c.displayProgress = { get value() { return c.dragging.value ? c.dragValue.value : c.player.progress; } };
  c.uni = {
    getStorageSync: key => storage.get(key) ?? '', setStorageSync: (key, value) => storage.set(key, value),
    createSelectorQuery: () => ({
      select(selector) { this.selector = selector; return this; },
      selectAll(selector) { this.selector = selector; return this; },
      boundingClientRect(fn) { this.callback = fn; return this; },
      exec() {
        if (this.selector === '.lyric-viewport') { this.callback({ height: wide ? 240 : 278 }); return; }
        assert.equal(this.selector, '.lyric-line');
        // Deliberately independent, synthetic host geometry: increasing the font can wrap rows.
        const height = c.lyricSize.scale === 0.7 ? 52.25 : c.lyricSize.scale === 0.8 ? 56.25
          : c.lyricSize.scale === 0.9 ? 58.25 : c.lyricSize.scale === 1 ? 60.25 : 88.25;
        measurements.push({ deliver: () => this.callback(Array.from({ length: 37 }, () => ({ height }))) });
      },
    }),
  };
  c.lyricSize = vm.runInContext('(() => {\n' + sizeStoreSource + '\nreturn useLyricSizeStore();\n})()', c);
  c.lyricSize.setScale(0.7);
  c.lyricLines.value = Array.from({ length: 37 }, (_, i) => ({ text: 'line ' + i, time: i * 5.4 }));
  c.lyricLineHeightsPx.value = Array(37).fill(52.25);
  c.lyricViewportHeightPx.value = wide ? 240 : 278;
  c.lyricPadPx.value = wide ? 120 : 139;
  c.lyricPadStyle.value = c.lyricPadPx.value + 'px;';
  c.activeLyric.value = 27;
  c.lyricScrollTop.value = 1436.875;
  v.event(1436.875);
  vm.runInContext(gestureCode + '\n' + stripTypeScriptTypes(geometryWiring[0]), c);
  const ctx = new Proxy(c, { get(target, key) {
    const value = target[key];
    return value != null && typeof value === 'object' && 'value' in value ? value.value : value;
  } });
  return {
    ...v, measurements, seeks, karaokeResets,
    buttons: () => classNodes(renderSizeControls(ctx, []), 'offset-step'),
    progress: () => renderProgress[wide ? 0 : 1](ctx, []),
    async settleScroll() {
      // Drain the query/centering flush and the existing same-value 1px resend tick.
      await Vue.nextTick();
      await Vue.nextTick();
      await Vue.nextTick();
      v.advance(100);
      const viewport = v.render();
      viewport.props.onScroll({ detail: { scrollTop: viewport.props['scroll-top'] } });
    },
    dispose() { stops.forEach(stop => stop()); },
  };
}
for (const wide of [false, true]) {
  const v = sizeSeekFixture(wide);
  try {
    // Same track/position, 70% -> default 100%, without closing and reopening the lyric view.
    v.buttons()[1].props.onClick();
    await Vue.nextTick();
    for (const row of classNodes(v.render(), 'lyric-line')) {
      assert.equal(paint(row).opacity, '1.00', 'font reflow must not use stale heights to hide live rows');
    }
    // The watcher clears stale paint in this flush; its nextTick layout query runs next.
    await Vue.nextTick();
    assert.ok(v.measurements.length > 0, 'the actual size control must request fresh native row geometry');
    while (v.measurements.length) v.measurements.shift().deliver();
    await Vue.nextTick();
    await v.settleScroll();
    assert.equal(v.render().props['scroll-top'], 1656.875, 'row 27 centers using the new 60.25px rows');
    const row = classNodes(v.render(), 'lyric-line')[27];
    assert.equal(paint(row).opacity, '1.00');
    assert.equal(paint(classNodes(row, 'lrc')[0])['text-shadow'], 'none');
    // Seek in both directions through actual progress event bindings, then deliver native scroll.
    for (const [seconds, index, target] of [[48.7, 9, 572.375], [148.4, 27, 1656.875]]) {
      v.progress().props.onTouchstart({ touches: [{ clientX: seconds }] });
      v.progress().props.onTouchmove({ touches: [{ clientX: seconds }] });
      v.progress().props.onTouchend({ changedTouches: [{ clientX: seconds }] });
      await Vue.nextTick();
      await v.settleScroll();
      assert.equal(v.render().props['scroll-top'], target);
      assert.equal(v.seeks.at(-1), seconds, 'progress seek never adds the lyric offset');
      const active = classNodes(v.render(), 'lyric-line')[index];
      assert.equal(paint(active).opacity, '1.00');
      assert.equal(paint(classNodes(active, 'lrc')[0])['text-shadow'], 'none');
    }
  } finally { v.dispose(); }
}
console.log('✓ 宽窄真实字号按钮 70%→100%：原位重测后前后拖动进度，当前句保持居中可见');

for (const wide of [false, true]) {
  const v = sizeSeekFixture(wide);
  try {
    v.buttons()[2].props.onClick(); // A+: 80% -> 90%, query remains in flight.
    await Vue.nextTick(); await Vue.nextTick();
    const stale = v.measurements.shift();
    assert.ok(stale);
    v.buttons()[1].props.onClick(); // Reset: 90% -> 100%, before old native reply.
    await Vue.nextTick(); await Vue.nextTick();
    while (v.measurements.length) v.measurements.shift().deliver();
    await v.settleScroll();
    assert.equal(v.render().props['scroll-top'], 1656.875);
    stale.deliver();
    await v.settleScroll();
    assert.equal(v.render().props['scroll-top'], 1656.875, 'a late old-size reply must not restore stale row heights');
    assert.equal(paint(classNodes(v.render(), 'lyric-line')[27]).opacity, '1.00');
    v.buttons()[0].props.onClick(); // A-: also remeasure when the font shrinks.
    await Vue.nextTick(); await Vue.nextTick();
    while (v.measurements.length) v.measurements.shift().deliver();
    await v.settleScroll();
    assert.equal(v.render().props['scroll-top'], 1601.875, '90% rows shrink to 58.25px in the host fixture');
    assert.equal(paint(classNodes(v.render(), 'lyric-line')[27]).opacity, '1.00');
  } finally { v.dispose(); }
}
console.log('✓ 宽窄 A+/恢复默认/A- 连续操作：旧字号测量乱序返回不覆盖新布局');

for (const wide of [false, true]) {
  const v = sizeSeekFixture(wide);
  try {
    // 70% is the floor: A- changes nothing, so the paused karaoke fill must survive untouched.
    assert.equal(v.c.lyricSize.scale, 0.7);
    v.buttons()[0].props.onClick();
    await Vue.nextTick(); await Vue.nextTick();
    assert.equal(v.c.lyricSize.scale, 0.7, 'A- clamps at the 70% floor');
    assert.deepEqual(v.karaokeResets, [], 'a no-op size click must not clear paused karaoke fill');
    assert.deepEqual(v.measurements, [], 'a no-op size click must not re-query native geometry');

    // Walk up to the 130% ceiling, then confirm A+ is a no-op there too.
    for (let i = 0; i < 6; i++) {
      v.buttons()[2].props.onClick();
      await Vue.nextTick(); await Vue.nextTick();
      while (v.measurements.length) v.measurements.shift().deliver();
    }
    assert.equal(v.c.lyricSize.scale, 1.3, 'A+ stops at the 130% ceiling');
    assert.equal(v.karaokeResets.length, 6, 'each real size change resets karaoke once');
    v.buttons()[2].props.onClick();
    await Vue.nextTick(); await Vue.nextTick();
    assert.equal(v.c.lyricSize.scale, 1.3);
    assert.equal(v.karaokeResets.length, 6, 'A+ at the ceiling must not clear paused karaoke fill');
    assert.deepEqual(v.measurements, [], 'A+ at the ceiling must not re-query native geometry');

    // Same-value "restore default" at 100% is equally inert.
    v.buttons()[1].props.onClick();
    await Vue.nextTick(); await Vue.nextTick();
    while (v.measurements.length) v.measurements.shift().deliver();
    assert.equal(v.c.lyricSize.scale, 1);
    const resetsAtDefault = v.karaokeResets.length;
    v.buttons()[1].props.onClick();
    await Vue.nextTick(); await Vue.nextTick();
    assert.equal(v.karaokeResets.length, resetsAtDefault, 'restore-default at 100% must not clear paused karaoke fill');
    assert.deepEqual(v.measurements, []);
  } finally { v.dispose(); }
}
console.log('✓ 宽窄 70%/130% 边界与同值点击：不清暂停中的逐字填充、不重复查询原生布局');
