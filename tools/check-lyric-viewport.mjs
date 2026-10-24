// 执行播放页真实函数，复现首帧几何未完成、自动滚动和渐隐尾帧问题。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
const source = readFileSync(new URL('../pages/player/index.uvue', import.meta.url), 'utf8');
const names = ['lyricLineMetrics', 'computeLyricOpacity', 'lineOpacityStyle', 'lyricScrollValue',
  'lyricTargetFromScrollTop', 'setLyricScrollTop', 'onLyricUserScroll', 'measureLyricCenter'];
const code = stripTypeScriptTypes(names.map(name => {
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
    Date: { now: () => now }, Math, Number,
    layout: { isWide: wide }, lyricUnit: 0.5, pageAlive: true,
    lyricLines: box(Array.from({ length: 20 }, (_, i) => ({ text: 'line ' + i, time: i * 3 }))),
    lyricViewportHeightPx: box(600), lyricPadPx: box(300), lyricPadRpx: box(600),
    lyricLineHeightsPx: box(Array(20).fill(50)), lyricLineOpacity: box([]),
    LYRIC_FADE_FULL: 0.68, LYRIC_FADE_ZERO: 0.86,
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
