import assert from 'node:assert/strict';
import { lyricFocusAt, lyricTextFocusStyle } from '../uni_modules/qt-ui/composables/lyric-presentation.ts';

// User-confirmed public seam: distance/viewport -> the lyric's visual focus.
// Native scrolling and drawing are validated separately, not simulated by this helper test.
assert.equal(lyricFocusAt(174, 600).opacity, 0.8,
  'upper/lower context that was mostly hidden must now remain readable');
assert.equal(lyricFocusAt(174, 600).blurPx, 0,
  'nearby context that previously requested 2px blur must now stay sharp');
assert.equal(lyricFocusAt(210, 600).opacity, 0.5,
  'the wider fade band still keeps outer lines quieter than the centered lyric');
assert.equal(lyricTextFocusStyle('#ffffff', 0.6), 'color:transparent;text-shadow:0px 0px 0.6px #ffffff;',
  'the distant glyph retains a lightly softened shadow in its explicit original color');
for (const [distance, opacity, blurPx] of [[0, 1, 0], [126, 1, 0], [168, 0.84, 0], [174, 0.8, 0], [210, 0.5, 0.3], [231, 0.32, 0.6], [294, 0, 1.2]]) {
  assert.deepEqual(lyricFocusAt(distance, 600), { opacity, blurPx }, 'reference focus stop at ' + distance + 'px');
}
let previous = { opacity: 1, blurPx: 0 };
for (let distance = 0; distance <= 360; distance += 3) {
  const focus = lyricFocusAt(distance, 600);
  assert.ok(focus.opacity >= 0 && focus.opacity <= previous.opacity, 'fading must be monotone and bounded');
  assert.ok(focus.blurPx >= previous.blurPx && focus.blurPx <= 1.2, 'softness must be monotone and bounded');
  assert.deepEqual(lyricFocusAt(-distance, 600), focus, 'above and below the center have symmetric focus');
  assert.deepEqual(lyricFocusAt(distance * 0.4, 240), focus, 'compact-height wide viewports retain the same focus profile');
  previous = focus;
}
for (const [distance, viewport] of [[0, 0], [90, -1], [NaN, 600], [Infinity, 600], [0, Infinity], [0, NaN]]) {
  assert.deepEqual(lyricFocusAt(distance, viewport), { opacity: 1, blurPx: 0 }, 'invalid first-frame geometry must stay visible and sharp');
}
for (const color of ['#ffffff', '#535c68', 'rgba(255,255,255,0.70)']) {
  assert.equal(lyricTextFocusStyle(color, 0), 'color:' + color + ';text-shadow:none;', 'a reused centered text node clears its old shadow');
  assert.equal(lyricTextFocusStyle(color, 0.6), 'color:transparent;text-shadow:0px 0px 0.6px ' + color + ';', 'shadow retains the complete explicit theme color');
}
for (const radius of [-2, NaN, Infinity]) {
  assert.equal(lyricTextFocusStyle('#535c68', radius), 'color:#535c68;text-shadow:none;', 'invalid radius restores readable foreground');
}
assert.equal(lyricTextFocusStyle('#ffffff', 20), 'color:transparent;text-shadow:0px 0px 1.5px #ffffff;', 'large font tiers cannot request an unbounded native blur');
console.log('lyric presentation: 121 distance/height/symmetry cases, 7 reference stops, first-frame safety and native text paint passed');
