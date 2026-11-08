import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { portraitPlayerMetrics, widePlayerMetrics, playerQueueMetrics, playerQueueWindow, playerQueueAnchorScroll, playerOffsetMetrics, playerOffsetThumbLeft, playerOffsetFromClientX } from '../uni_modules/qt-ui/composables/player-presentation.ts';
import { turntableMetrics, turntableStyles } from '../uni_modules/qt-ui/composables/turntable-presentation.ts';
import { marqueeOverflows, marqueeLoopDuration } from '../uni_modules/qt-ui/composables/marquee-motion.ts';

const page = readFileSync(new URL('../pages/player/index.uvue', import.meta.url), 'utf8');
const mq = readFileSync(new URL('../uni_modules/qt-ui/components/qt-marquee/qt-marquee.uvue', import.meta.url), 'utf8');
function cssValue(selector, property) {
  const start = page.indexOf(`.${selector} {`);
  assert.ok(start >= 0, `missing CSS rule: ${selector}`);
  const block = page.slice(page.indexOf('{', start) + 1, page.indexOf('}', start));
  const declaration = block.split(';').map(part => part.trim()).find(part => part.startsWith(`${property}:`));
  assert.ok(declaration, `missing CSS property: ${selector}.${property}`);
  return declaration.slice(declaration.indexOf(':') + 1).trim();
}
function cssRpx(selector, property) {
  const value = cssValue(selector, property);
  assert.ok(value.endsWith('rpx'), `${selector}.${property} must use rpx`);
  return Number(value.slice(0, -3));
}
const stagePadding = cssValue('portrait-stage', 'padding').split(/\s+/).map(value => Number(value.replace('rpx', '')));
const footer = ['progress-row', 'controls', 'bar-row'].reduce((sum, selector) => sum + cssRpx(selector, 'height') + cssRpx(selector, 'margin-top'), stagePadding[2]);
assert.equal(footer, 284, 'compact footer budget must match the actual CSS');
// Tighten row spacing without reducing the drag surface or button hit targets.
assert.equal(cssRpx('progress-row', 'margin-top'), 4);
assert.equal(cssRpx('controls', 'margin-top'), 4);
assert.equal(cssRpx('bar-row', 'margin-top'), 0);
assert.equal(cssRpx('prog-range', 'height'), 64);
assert.equal(cssRpx('control-hit', 'width'), 80);
assert.equal(cssRpx('control-hit', 'height'), 88);
assert.equal(cssRpx('icon-main', 'width'), 96);
assert.equal(cssRpx('icon-main', 'height'), 96);
assert.equal(cssRpx('bar-hit', 'height'), 88);
assert.ok(cssRpx('controls', 'height') >= cssRpx('icon-main', 'height'), 'play hit target must fit its row');
assert.ok(cssRpx('controls', 'height') >= cssRpx('control-hit', 'height'), 'side hit targets must fit their row');
assert.ok(cssRpx('bar-row', 'height') >= cssRpx('bar-hit', 'height'), 'tool hit targets must fit their row');
// The actual short-screen CSS occupies 124px, not the former 116px script estimate.
function cssPx(selector, property) {
  const value = cssValue(selector, property);
  assert.ok(value.endsWith('px') && !value.endsWith('rpx'), `${selector}.${property} must use fixed px`);
  return Number(value.slice(0, -2));
}
// Lyric tools now live above lyrics; footer = separator/margin 11 + progress 42 + transport 46.
assert.equal(widePlayerMetrics(1280,480,0,0,true,7,1).footerPx, 99);
function cssWithout(selector, properties) {
  const block = page.match(new RegExp(`\\.${selector} \\{([^}]*)\\}`))?.[1];
  assert.ok(block != null, `missing CSS rule: ${selector}`);
  for (const property of properties) assert.ok(!new RegExp(`(?:^|;)\\s*${property}:`).test(block), `${selector} must not override its bound ${property}`);
}
for (const s of ['lyric-tools-row-wide','lyric-tools-row-short','progress-row-wide','progress-row-short','controls-wide','controls-short']) cssWithout(s, ['height','margin-top']);
for (const s of ['queue-row','queue-row-wide']) cssWithout(s, ['height']);
assert.ok(!page.includes('class="controls controls-wide"') && !page.includes('class="progress-row progress-row-wide"') && !page.includes('class="lyric-tools-row lyric-tools-row-wide"'), 'wide bound geometry must not inherit compact CSS heights');
assert.match(page, /portraitStageStyle = computed\(\(\): string => "margin-bottom:" \+ layout.safeBottomPx/);
assert.ok(!page.includes('const WIDE_SHORT_BOTTOM_ROWS_PX = 116;'), 'short-screen stage must reserve all 124px of actual fixed rows');
let cases = 0;
for (const [width, height, status, safe] of [[320,568,24,24],[360,640,24,24],[375,667,24,0],[391,695,24,0],[384,845,41,42],[430,932,54,34],[393,864,36,24],[412,1000,32,24],[800,1280,24,24]]) {
  let previousDisc = Infinity;
  for (const scale of [0.85,1,1.15,1.3,1.5]) {
    const m = portraitPlayerMetrics(width,height,status,safe,scale);
    const available = (height-safe)/(width/750);
    const expectedReserved = status/(width/750) + stagePadding[0] + m.trackTopRpx + m.titleRowRpx + m.artistRowRpx + m.lyricRowRpx + cssRpx('track-row-artist', 'margin-top') + cssRpx('track-row-lyric', 'margin-top') + m.trackBottomRpx + footer + m.metaRowRpx + m.artTopRpx;
    assert.ok(Math.abs(m.reservedRpx - expectedReserved) < 0.000001, 'geometry budget must agree with CSS');
    assert.ok(m.discRpx + m.reservedRpx <= available + 1, 'disc must not consume text/controls');
    assert.ok(Math.abs(m.discRpx + m.reservedRpx - available) < 0.000001, 'height changes must not leave unallocated space above the title');
    assert.ok(m.trackTopRpx >= 28 && m.trackTopRpx <= 92, 'artwork and its title remain one group, even on very tall phones');
    if (m.discRpx < 613) {
      assert.ok(m.artTopRpx < 1 && m.trackBottomRpx < 17, 'short screens prioritize artwork, text and touch targets over extra spacing');
    } else {
      const spare = m.artTopRpx + m.trackTopRpx - 28 + m.trackBottomRpx - 16;
      const gaps = [m.artTopRpx, m.trackTopRpx - 28, m.trackBottomRpx - 16];
      assert.ok(Math.max(...gaps) <= spare * 0.65 + 1, 'surplus height must not accumulate in a single empty gap');
    }
    assert.ok(m.titleRowRpx >= 38*scale*1.4 + 8);
    assert.ok(m.artistRowRpx >= 28*scale*1.4 + 8);
    assert.ok(m.discRpx <= previousDisc, 'larger type shrinks disc instead of rows');
    const scene = turntableMetrics(m.discRpx);
    assert.ok(scene.widthRpx <= 682 && scene.heightRpx <= m.discRpx + 0.00001);
    assert.ok(scene.recordLeftRpx >= 0 && scene.recordTopRpx >= 0);
    assert.ok(scene.recordLeftRpx + scene.recordRpx <= scene.widthRpx);
    assert.ok(scene.recordTopRpx + scene.recordRpx <= scene.heightRpx);
    assert.equal(scene.coverRpx, scene.recordRpx * 0.46);
    assert.ok(scene.coverRpx < scene.recordRpx);
    const layers = turntableStyles(scene, width / 750);
    const values = (style) => Object.fromEntries(style.split(';').filter(Boolean).map(decl => {
      const [key, value] = decl.split(':');
      return [key, value.endsWith('px') ? Number.parseFloat(value) : value];
    }));
    const canvas = values(layers.canvasSize), record = values(layers.recordSize);
    const plate = values(layers.plate), cover = values(layers.cover);
    assert.ok(!Object.values(layers).some(value => value.includes('%')), 'native material layers must not resolve percentage heights before their absolute parent is measured');
    assert.ok(Math.abs(canvas.height - m.discRpx * width / 750) < 0.011, 'canvas shares the portrait artwork budget');
    assert.equal(record.width, record.height, 'vinyl texture and rotating layer remain square');
    assert.equal(plate.width, record.width, 'plate and rotating layer share one explicit size');
    assert.ok(plate.left + record.width <= canvas.width + 0.02 && plate.top + record.height <= canvas.height + 0.02, 'whole record fits its deck at every screen/font size');
    assert.ok(Math.abs(cover.left + cover.width / 2 - record.width / 2) < 0.02 && Math.abs(cover.top - cover.left) < 0.02, 'album remains centered in the actual pixel-sized record');
    previousDisc = m.discRpx;
    cases++;
  }
}
cssWithout('track-block', ['flex', 'flex-grow', 'justify-content']);
assert.match(page, /portraitTrackStyle = computed[^\n]*portraitMetrics\.value\.trackTopRpx[^\n]*portraitMetrics\.value\.trackBottomRpx/);
assert.match(page, /portraitGalleryStyle = computed[^\n]*portraitMetrics\.value\.artTopRpx/, 'gallery must consume the same shared portrait spacing budget');
// Geometry seam: known narrow landscape windows retain every tool in a separate row;
// broad windows retain the centered transport with equal wings. Expectations come from CSS.
for (const width of [600, 640, 700, 899, 900, 1280, 1600]) {
  for (const height of [360, 480, 720]) {
    for (const scale of [0.85, 1, 1.15, 1.3, 1.5]) {
      const short = height < 520;
      const m = widePlayerMetrics(width, height, 24, 20, short, 8, scale);
      assert.ok(m.stacked ? m.toolsWidthPx <= m.controlsWidthPx : m.toolsWidthPx <= m.wingWidthPx, 'all configured tools must fit their actual available width');
      if (width <= 700) assert.equal(m.stacked, true, '600–700px must not squeeze tools into the right half');
      if (width >= 1280) assert.equal(m.stacked, false, 'broad windows retain the original centered equal-wing design');
      assert.equal(m.footerPx, (short ? 99 : 109) + m.toolsRowPx, 'footer agrees with the reviewed fixed-row contract plus visible overflow tools');
      assert.ok(m.padTopPx >= 24 + (short ? 44 : 52), 'content must clear its real nav');
      assert.equal(m.padBottomPx, (short ? 8 : 14) + 20, 'safe bottom is consumed exactly once in the stage');
      assert.ok(m.coverCardPx + m.trackHeightPx <= m.bodyHeightPx + 0.001, 'cover never invades its text or controls');
      cases++;
    }
  }
}
assert.match(page, /:style="wideLyricToolsStyle"/);
assert.match(page, /:style="wideProgressStyle"/);
assert.match(page, /:style="wideControlsStyle"/);
assert.ok(page.includes('wideControlsStacked') && page.includes('.control-wing-right-stacked {'));
assert.ok(!page.includes('const QUEUE_VIEWPORT_ESTIMATE = 800;'), 'the virtual queue must cover its real or window-derived viewport, not a fixed 800px estimate');
for (const [width, height, wide, safe] of [[375,667,false,0],[500,800,false,24],[599,1000,false,0],[640,360,true,20],[700,480,true,0],[900,1600,true,32],[1280,2000,true,0]]) {
  for (const scale of [1, 1.15, 1.5]) {
    const m = playerQueueMetrics(width, height, wide, safe, scale);
    const baselineRow = wide ? 60 : 104 * width / 750; // Existing row density; no competing class height.
    assert.ok(m.stridePx + 0.000001 >= baselineRow, 'font growth must never shrink the existing queue row');
    const measured = wide ? height - 56 - safe - 2 : height * 0.7 - (cssRpx('sheet-head','height') + cssRpx('sheet-handle','height') + cssRpx('sheet-handle','margin-top') + cssRpx('sheet-handle','margin-bottom')) * width / 750 - safe - 2;
    assert.ok(Math.abs(m.viewportPx - measured) < 0.00001, 'first-frame estimate must subtract the actual fixed header, handle, border and safe area');
    const q = playerQueueWindow(5000, m.stridePx, m.viewportPx, 1200.5, 10);
    assert.ok(q.first * m.stridePx <= q.scrollPx);
    assert.ok((q.last + 1) * m.stridePx >= q.scrollPx + m.viewportPx, 'window must cover the whole current viewport even above 800px');
    assert.ok(q.last - q.first + 1 <= Math.ceil(m.viewportPx / m.stridePx) + 23, 'virtualization must remain bounded');
    assert.equal(q.contentHeightPx, Math.ceil(5000 * m.stridePx));
    const tail = playerQueueWindow(5000, m.stridePx, m.viewportPx, Infinity, 10);
    assert.equal(tail.last, 4999);
    assert.equal(tail.scrollPx, tail.maxScrollPx);
    cases++;
  }
}
assert.equal(playerQueueMetrics(375,667,false,0,1).stridePx, 52);
assert.ok(playerQueueMetrics(500,667,false,0,1).stridePx > 69, 'same compact branch resize must refresh stride');
assert.equal(playerQueueWindow(5000,60,1942,0,10).last, 43, 'tall drawer must render beyond the old fixed-800 window');
const keys = Array.from({length: 100}, (_, index) => `local:${index}`);
assert.equal(playerQueueAnchorScroll(keys,'local:30',30,0.25,60,300),1815, 'compact→wide retains visible song and sub-row position');
assert.equal(playerQueueAnchorScroll(keys,'local:30',30,0.25,52,300),1573, 'wide→compact retains the same anchor');
const moved = ['local:30', ...keys.filter(k => k != 'local:30')];
assert.equal(playerQueueAnchorScroll(moved,'local:30',30,0.25,60,300),15, 'reordered anchor follows song identity');
assert.equal(playerQueueAnchorScroll(keys.filter(k => k != 'local:30'),'local:30',30,0.25,60,300),1815, 'removed anchor falls back to nearest valid index');
assert.equal(playerQueueAnchorScroll([], 'gone', 100, 0.5, 60, 300),0);
assert.equal(playerQueueAnchorScroll(keys, 'local:99', 99, 0.5, 60, 300),5700, 'bottom anchor is clamped to the real viewport');
assert.match(page, /queueRowStyle \+ \(isCurrent\(row.song\)/);
assert.ok(page.includes('queueMetrics.value.stridePx') && page.includes('layout.safeBottomPx + ":" + fontScale.scale'));
assert.ok(page.includes('.select(".queue-list-viewport")') && page.includes('seq != queueMeasureSeq'));
assert.ok(page.includes('queueMeasureSeq++;') && page.includes('clearTimeout(queueMeasureTimer)'));
assert.ok(page.includes('playerQueueAnchorScroll(keys, queueAnchorKey, queueAnchorIndex, queueAnchorFraction'));
cases += 9;
assert.equal(cssPx('offset-track-wide','height'),36, 'wide offset track must not inherit window-amplified rpx');
for (const [selector, props] of Object.entries({
  'offset-track-wide':['height','margin-top'], 'offset-rail-wide':['top','height','border-radius'],
  'offset-thumb-wide':['top','width','height','border-radius'], 'offset-scale-wide':['margin-top'],
  'offset-steps-wide':['margin-top'], 'offset-step-wide':['height','border-radius'],
  'offset-note-wide':['margin-top','line-height']
})) {
  for (const prop of props) cssPx(selector,prop);
  assert.ok(page.includes(`'${selector}'`), `${selector} must be bound directly on its target node`);
}
assert.equal(cssValue('offset-step-wide','margin'),'0 6px');
assert.equal(cssValue('offset-step-wide','padding'),'0 12px');
for (const [width,height,wide,safe] of [[375,667,false,34],[500,720,false,0],[640,360,true,20],[700,480,true,0],[900,720,true,32],[1280,800,true,0],[1600,1000,true,0]]) {
  for (const scale of [0.85,1,1.15,1.3,1.5]) {
    const m = playerOffsetMetrics(width,height,wide,420,safe,scale);
    assert.equal(m.thumbSizePx, wide ? cssPx('offset-thumb-wide','width') : cssRpx('offset-thumb','width') * (width / 750));
    if (wide) assert.equal(m.trackWidthPx,364, '420px sheet body remains 364px at every wide width/font tier');
    assert.ok(m.viewportPx > 0 && m.viewportPx < height * 0.86 - safe, 'short offset sheet body must scroll rather than cover the header/safe area');
    assert.equal(playerOffsetThumbLeft(-10000,10000,m.trackWidthPx,m.thumbSizePx),0);
    assert.equal(playerOffsetThumbLeft(10000,10000,m.trackWidthPx,m.thumbSizePx),m.trackWidthPx-m.thumbSizePx);
    assert.equal(playerOffsetFromClientX(m.trackLeftPx, m.trackLeftPx,m.trackWidthPx,10000,50,10),-10000);
    assert.equal(playerOffsetFromClientX(m.trackLeftPx + m.trackWidthPx/2, m.trackLeftPx,m.trackWidthPx,10000,50,10),0);
    assert.equal(playerOffsetFromClientX(m.trackLeftPx + m.trackWidthPx, m.trackLeftPx,m.trackWidthPx,10000,50,10),10000);
    cases++;
  }
}
assert.equal(playerOffsetThumbLeft(0,10000,364,22),171);
assert.equal(playerOffsetFromClientX(374,192,364,10000,50,0),0);
assert.equal(playerOffsetFromClientX(1,0,400,10000,50,0),-9950, 'drag snaps to50ms');
assert.equal(playerOffsetFromClientX(0,0,0,10000,50,250),250, 'unmeasured zero-width track preserves the draft');
assert.equal(playerOffsetThumbLeft(10000,10000,10,22),0, 'tiny track never produces negative thumb coordinates');
assert.ok(page.includes('seq != offsetTrackSeq') && page.includes('!offsetOpen.value'), 'stale/closed offset measurements must be ignored');
assert.ok(page.includes('offsetGeometry.value.trackWidthPx') && !page.includes('let offsetFallbackWidth'), 'fallback is reactive rather than plain cached geometry');
assert.ok(page.includes('class="offset-scroll"') && page.includes(':style="offsetViewportStyle"'));
const offsetDrag = page.slice(page.indexOf('function onOffsetTouchStart'),page.indexOf('function onOffsetTouchEnd'));
assert.ok(!offsetDrag.includes('commitOffset(') && !offsetDrag.includes('setActiveMs('), 'moves only edit the draft');
assert.ok(page.slice(page.indexOf('function onOffsetTouchEnd'),page.indexOf('function onOffsetTouchCancel')).includes('commitOffset(value)'), 'release still commits once');
cases += 5;
// Seamless notice-bar loop (m21532/m21548): overflow at a 1px threshold, then one measured
// copy-width per iteration at 40px/s with a 3000ms floor; no holds, no rewind.
for (const [text, view, scrolls] of [[40,240,false],[240,240,false],[240.5,240,false],[600,240,true],[1800,100,true]]) {
  assert.equal(marqueeOverflows(text, view), scrolls, 'overflow threshold must be 1px');
  if (scrolls) {
    const duration = marqueeLoopDuration(text - view);
    assert.ok(Math.abs(duration - Math.max(3000, Math.round((text - view) / 40 * 1000))) < 0.001, 'loop pace must be 40px/s with a 3000ms floor');
  }
  cases++;
}
for (const bad of [0, -5, NaN, Infinity]) {
  assert.equal(marqueeLoopDuration(bad), 0, 'invalid distance must not animate');
  assert.equal(marqueeOverflows(bad, 100), false);
  assert.equal(marqueeOverflows(100, bad), false);
  cases++;
}
assert.match(page, /<QtMarquee[^>]*:text="name\(\)"[^>]*:active="pageVisible"/);
assert.match(page, /<QtMarquee[^>]*:text="artistText\(\)"[^>]*:active="pageVisible"/);
// Seamless loop needs exactly two copies of one text; the copy mounts only when overflowing,
// the slide distance is the measured copy offset fed straight to translateX (no pixelRatio
// inflation — the old round-trip implementation multiplied it and overshot past the text tail).
assert.equal((mq.split('</template>')[0].match(/<text\b/g)||[]).length,2,'seamless loop needs the copy text');
assert.match(mq, /v-if="overflowing"[^>]*ref="copyRef"/,'the copy must mount only when the text overflows');
assert.ok(mq.includes('"translateX(-" + distance + "px)"'),'the track must slide exactly one measured copy-width per iteration');
assert.ok(!mq.includes('pixelRatio'),'the measured offset must feed translateX without pixelRatio scaling');
assert.ok(mq.includes('easing: "linear"') && mq.includes('iterations: Infinity'),'the loop must be a seamless linear infinite cycle');
assert.match(page, /onHide\(\(\) => \{\s*pageVisible\.value = false/);
assert.match(mq, /token != generation/);
// Measurement/restart must not resize the viewport and pull sibling badges/arrows sideways.
const rootStyleStart = mq.indexOf('const rootStyle =');
const rootStyleEnd = mq.indexOf('const textStyle =', rootStyleStart);
assert.ok(rootStyleStart >= 0 && rootStyleEnd > rootStyleStart);
const rootStyleSource = mq.slice(rootStyleStart, rootStyleEnd);
assert.ok(rootStyleSource.includes('"max-width:"'), 'short text must hug its content; widthPx is only a ceiling');
assert.ok(!rootStyleSource.includes('"width:"'), 'the viewport must not reserve the full line for short text');
assert.ok(!mq.includes('naturalWidth'), 'measurement/restart must not write a content-sized layout width');
const viewportCssStart = mq.indexOf('.mq {');
const viewportCss = mq.slice(viewportCssStart, mq.indexOf('}', viewportCssStart));
assert.ok(viewportCss.includes('flex-grow: 0;'), 'short text must not grow and push badges/arrows to the right');
assert.ok(viewportCss.includes('flex-shrink: 1;'), 'long text must yield room to sibling badges/arrows');
assert.ok(viewportCss.includes('min-width: 0;'), 'the viewport must permit long text to be clipped');
assert.ok(mq.includes('anim = track.animate('), 'only the inner text track may animate');
assert.ok(!mq.includes('viewport.animate('), 'the viewport must not animate sibling layout');
const discTemplate = page.slice(page.indexOf('class="disc-wrap"'),page.indexOf('class="track-block"'));
const spinStart = discTemplate.indexOf('ref="discSpinRef"');
const spinEnd = discTemplate.indexOf('</view>',spinStart);
const spin = discTemplate.slice(spinStart,spinEnd);
assert.ok(spin.includes('record.png') && spin.includes(':src="art()"'));
assert.ok(!spin.includes('deck.png') && !spin.includes('arm.png'),'only record and actual album may rotate');
assert.ok(discTemplate.includes('@click="onDiscTap"') && discTemplate.includes('@longpress="previewCover"'));
assert.ok(!discTemplate.includes('disc-hole'),'album must not be obscured by a spindle');
assert.ok(cssValue('turntable-layer','pointer-events') === 'none','decorative images must not intercept album taps');
assert.equal((discTemplate.match(/:style="portraitTurntableStyles.canvasSize"/g) || []).length, 2, 'deck and tonearm receive the same explicit canvas size');
assert.match(spin, /:style="portraitTurntableStyles.recordSize \+ discSpinStyle"/, 'rotation wrapper must use explicit record dimensions');
assert.match(spin, /class="turntable-record" :style="portraitTurntableStyles.recordSize"/, 'vinyl image must use the same explicit dimensions as its wrapper');
assert.match(page, /portraitTurntableStyles = computed\(\(\) => turntableStyles\(portraitTurntable.value, portraitUnit.value\)\)/);
cssWithout('turntable-layer', ['width', 'height']);
cssWithout('turntable-record', ['width', 'height']);
assert.ok(page.includes('watch(discSpinRef') && page.includes('watch(() => layout.isWide'));
assert.ok(page.includes('const playerSurface = computed') && page.includes('resolvePlayingBackground(playingStyle.style, playingStyle.background)'), 'both orientations resolve the same persisted player background');
assert.ok(page.includes("'background-color:' + playerSurface"));
assert.ok(!page.includes('shade-deep'), 'lyrics must not add a second dark background overlay');
for (const [name, colors] of [
  ['lrcStyle', ['playerInk.value', 'playerMuted.value']],
  ['lrcTrStyle', ['playerMuted.value']],
  ['lrcRomaStyle', ['playerInk.value', 'playerMuted.value']],
  ['karaokeWordStyle', ['playerInk.value', 'playerMuted.value']],
  ['karaokeLitStyle', ['playerInk.value']],
]) {
  const start = page.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing lyric style: ' + name);
  const style = page.slice(start, page.indexOf('\n}', start));
  for (const color of colors) assert.ok(style.includes(color), name + ' must use shared foreground: ' + color);
}
const phoneStart = page.indexOf('<view v-else class="portrait-stage');
const phoneEnd = page.indexOf('<!-- 「三个点」弹层', phoneStart);
assert.ok(phoneStart >= 0 && phoneEnd > phoneStart);
const phoneTemplate = page.slice(phoneStart, phoneEnd);
assert.ok(!phoneTemplate.includes('theme.skin.mediaText') && !phoneTemplate.includes('theme.skin.mediaMuted'), 'phone lyric tools and empty state must not leave white-on-light text');
assert.ok(page.includes(':color="playerInk"') && !page.includes("rgba(255,255,255,0.62)"));
for (const [name,w,h] of [['deck',1500,1350],['arm',1500,1350],['record',1170,1170]]) {
  const png = readFileSync(new URL('../uni_modules/qt-ui/static/player-turntable/'+name+'.png',import.meta.url));
  assert.equal(png.subarray(1,4).toString(),'PNG');
  assert.equal(png.readUInt32BE(16),w); assert.equal(png.readUInt32BE(20),h);
  assert.equal(png[25],6,'materials must retain true RGBA transparency');
}
console.log(`player presentation: ${cases} geometry/motion cases passed; full-scene/PNG/static-arm/rotation/two-row/content-hugging/seamless-loop/shared-background/lyric-colors guards passed`);
