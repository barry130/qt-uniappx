import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { portraitPlayerMetrics } from '../uni_modules/qt-ui/composables/player-presentation.ts';
import { turntableMetrics } from '../uni_modules/qt-ui/composables/turntable-presentation.ts';
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
let cases = 0;
for (const [width, height, status, safe] of [[320,568,24,24],[360,640,24,24],[375,667,24,0],[391,695,24,0],[384,845,41,42],[430,932,54,34]]) {
  let previousDisc = Infinity;
  for (const scale of [0.85,1,1.15,1.3,1.5]) {
    const m = portraitPlayerMetrics(width,height,status,safe,scale);
    const available = (height-safe)/(width/750);
    // The turntable sits flush below the nav (stage padding-top 96) with no extra gap:
    // reserved = status + stage padding + track margin-top + rows + row gaps + track margin-bottom + footer + meta.
    const expectedReserved = status/(width/750) + stagePadding[0] + cssRpx('track-block', 'margin-top') + m.titleRowRpx + m.artistRowRpx + m.lyricRowRpx + cssRpx('track-row-artist', 'margin-top') + cssRpx('track-row-lyric', 'margin-top') + cssRpx('track-block', 'margin-bottom') + footer + m.metaRowRpx + m.artTopRpx;
    assert.ok(Math.abs(m.reservedRpx - expectedReserved) < 0.000001, 'geometry budget must agree with CSS');
    assert.ok(m.discRpx + m.reservedRpx <= available + 1, 'disc must not consume text/controls');
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
    previousDisc = m.discRpx;
    cases++;
  }
}
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
assert.ok(page.includes('watch(discSpinRef') && page.includes('watch(() => layout.isWide'));
assert.ok(page.includes('const portraitPlayerMode = computed((): boolean => !layout.isWide);'), 'phone cover and lyrics must share a palette independent of showLyric');
assert.ok(page.includes('portraitPlayerMode ? portraitPalette.surface : theme.skin.mediaScrim'));
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
