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
    Date: { now: () => now }, Math, Number, lyricFocusAt, lyricTextFocusStyle,
    computed: fn => ({ get value() { return fn(); } }), fontScale: { scale: 1 },
    playerInk: box('#ffffff'), playerMuted: box('#a0a0a0'), playerRail: box('#202020'),
    theme: { skin: { mediaText: '#ffffff', mediaControl: '#202020' } },
    playingStyle: { style: "classic" }, showLyric: box(true), portraitLyricStyle: box('height:600px;'), lyricPadStyle: box('300px;'),
    lyricScrollAnimated: box(false), activeLyric: box(3), karaokeWordIndex: box(1), karaokeFillPct: box(50),
    touchFromLyricScroll: false, toggleLyric() {}, copyLyric() {}, onLyricLineTap() {}, qtFontDual: () => '',
    layout: { isWide: wide }, lyricUnit: 0.5, pageAlive: true,
    lyricLines: box(Array.from({ length: 20 }, (_, i) => ({ text: 'line ' + i, time: i * 3 }))),
    lyricViewportHeightPx: box(600), lyricPadPx: box(300), lyricPadRpx: box(600),
    lyricLineHeightsPx: box(Array(20).fill(50)), lyricLineOpacity: box([]), lyricLineBlur: box([]),
    lyricActualScrollTop: 0, lyricOpacityTimer: null, lyricOpacityLastAt: 0,
    lyricProgrammaticUntil: 0, lyricLastTarget: 0, lyricScrollTop: box(0),
    lyricTouchAt: 0, lyricUserScrollAt: 0, lyricTimesVisible: box(false), lyricTargetIndex: box(-1),
    lyricTimesTimer: null, lyricVisible: box(true), lyricCenterRetry: 0, lyricCenterTimer: null,
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
  assert.equal(paint(rows[3]).opacity, '0.41', 'manual browsing does not exempt the distant playing row');
  const words = classNodes(rows[3], 'lrc-karaoke-word');
  assert.equal(words.length, 3, 'the word base and half-word overlay both remain mounted');
  for (const word of words) {
    assert.equal(paint(word).color, 'transparent');
    assert.match(paint(word)['text-shadow'], /^0px 0px 2\.0px /, 'both karaoke layers use the same physical focus');
  }
  assert.equal(paint(words[0])['text-shadow'], '0px 0px 2.0px #ffffff', 'sung words retain highlight ink');
  assert.equal(paint(words[1])['text-shadow'], '0px 0px 2.0px #a0a0a0', 'unsung word base retains muted ink');
  assert.equal(paint(words[2])['text-shadow'], '0px 0px 2.0px #ffffff', 'half-word fill retains highlight ink');
  assert.equal(words[1].children, words[2].children, 'the overlay glyph exactly matches its base');
  assert.equal(paint(classNodes(rows[3], 'lrc-karaoke-fill')[0]).width, '50%', 'soft focus does not change half-word progress');
  for (const name of ['lrc-roma', 'lrc-tr']) {
    assert.equal(paint(classNodes(rows[3], name)[0]).color, 'transparent', 'secondary text also receives distant focus');
  }
  for (const scale of [0.85, 1, 1.15, 1.3, 1.5]) {
    v.c.fontScale.scale = scale; // synthetic public font-setting input
    rows = classNodes(v.render(), 'lyric-line');
    const font = Math.round((wide ? 27 * 0.7 : 44) * scale) + (wide ? 'px' : 'rpx');
    assert.equal(paint(classNodes(rows[4], 'lrc')[0])['font-size'], font);
    for (const word of classNodes(rows[3], 'lrc-karaoke-word')) assert.equal(paint(word)['font-size'], font);
  }
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
