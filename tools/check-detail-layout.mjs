import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}
function cssRule(text, selector) {
  const match = text.match(new RegExp('\\.' + selector + '\\s*\\{([^}]*)\\}'));
  assert.ok(match, 'missing CSS rule: ' + selector);
  return new Map(match[1].split(';').filter(part => part.includes(':')).map(part => {
    const colon = part.indexOf(':');
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  }));
}
function wideDimensions(text, label) {
  const template = text.split('</template>')[0];
  const style = text.split('<style>')[1];
  let properties = 0;
  for (const match of style.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
    const name = match[1];
    const dimensions = [...cssRule(text, name)].filter(([key, value]) => key !== 'font-size' && value.includes('rpx'));
    if (dimensions.length === 0) continue;
    const wide = cssRule(text, name + '-wide');
    for (const [property] of dimensions) {
      assert.ok(wide.has(property), `${label} ${name}-wide must override ${property}`);
      assert.ok(!wide.get(property).includes('rpx'), `${label} ${name}-wide.${property} must not scale with window width`);
      assert.ok(/px/.test(wide.get(property)) || /^0(?:\s+0)*$/.test(wide.get(property)), `${label} ${name}-wide.${property} must use fixed px or zero`);
      properties++;
    }
    const nodes = [...template.matchAll(/<[\w-]+\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)].filter(([tag]) => {
      const classes = tag.match(/\bclass="([^"]*)"/);
      return classes && classes[1].split(/\s+/).includes(name);
    });
    assert.ok(nodes.length > 0, `${label} ${name} must be a real template target`);
    for (const [node] of nodes) {
      assert.ok(node.includes(`:class="layout.isWide ? '${name}-wide' : ''"`), `${label} every ${name} target must bind its wide class`);
    }
  }
  return properties;
}

const radio = source('pages/radio/index.uvue');
const radioProperties = wideDimensions(radio, 'FM');
assert.equal(cssRule(radio, 'hero-btn-wide').get('height'), '40px');
assert.equal(cssRule(radio, 'now-cover-wide').get('width'), '64px');
assert.equal(cssRule(radio, 'now-cover-wide').get('height'), '64px');
assert.equal(cssRule(radio, 'now-act-wide').get('height'), '36px');
assert.equal(cssRule(radio, 'now-acts-wide').get('flex-wrap'), 'wrap', 'FM actions may wrap rather than clip at large font scale');
const podcast = source('pages/podcast/index.uvue');
const podcastProperties = wideDimensions(podcast, 'podcast');
assert.equal(cssRule(podcast, 'sub-field-wide').get('height'), '40px');
assert.equal(cssRule(podcast, 'sub-input-wide').get('height'), '40px');
assert.equal(cssRule(podcast, 'show-cover-wide').get('width'), '52px');
assert.equal(cssRule(podcast, 'show-act-wide').get('width'), '36px');
assert.equal(cssRule(podcast, 'ep-play-wide').get('width'), '40px');
assert.match(podcast, /:placeholder-style="'color:' \+ themeStore\.skin\.placeholder \+ ';' \+ subscriptionFont/);
assert.match(podcast, /:style="'color:' \+ themeStore\.skin\.text \+ ';' \+ subscriptionFont/);
assert.match(podcast, /const subscriptionFont = computed\(\(\): string => qtFontDual\(25, 14\)\)/);
assert.ok(!podcast.includes(':placeholder-class='), 'placeholder and input share the scaled inline font, not divergent class defaults');
const playlist = source('pages/playlist/index.uvue');
assert.match(playlist, /const detailMetrics = computed\(\(\) => detailLayoutMetrics\(layout\.isWide, qtContentWidth\("detail"\)\)\)/);
assert.match(playlist, /<scroll-view v-if="detailSplit" class="wide-left"/);
assert.match(playlist, /<list-item v-if="!detailSplit" class="hero-item"/);
assert.match(playlist, /v-if="!loading && !detailSplit" id="pl-head"/);
assert.match(playlist, /v-if="layout\.isWide && !loading && tracks\.length > 0" class="track-toolbar"/);
assert.ok(!cssRule(playlist, 'wide-left').has('width'), 'Vapor class width must not override calculated aside width');
assert.ok(!cssRule(playlist, 'whero-cover').has('width'), 'Vapor class width must not override calculated cover width');
assert.ok(!cssRule(playlist, 'whero-cover').has('height'), 'cover height must follow the geometry');
assert.equal(cssRule(playlist, 'page-wide').get('padding'), '16px 20px 0', 'actual wide padding must match the pure helper subtraction');
assert.equal(cssRule(playlist, 'page-split').get('flex-direction'), 'row');
assert.ok(playlist.includes("detailSplit ? 'page-split' : ''"), 'split geometry must control the real flex direction');
assert.ok(playlist.includes('const wideAsideWidth = computed((): number => detailMetrics.value.asideWidthPx);'));
assert.ok(playlist.includes('const wideCoverSize = computed((): number => detailMetrics.value.coverSizePx);'));
assert.ok(playlist.includes(':style="wideAsideStyle"') && playlist.includes(':style="wideCoverStyle"'));
assert.ok(playlist.includes(':width="wideCoverPx" :height="wideCoverPx"'), 'loaded cover and skeleton must share geometry');
const listTools = playlist.match(/<sticky-header>([\s\S]*?)<\/sticky-header>/)?.[1] ?? '';
assert.ok(listTools.includes('@input="onSearchInput"') && listTools.includes('@click="openSortPanel"'), 'wide single/split layouts retain search and sorting in the sticky list header');
assert.ok(!playlist.includes('class="whero-tools"'), 'the cover column must not duplicate floating list controls');
assert.equal(cssRule(playlist, 'head-actions-wide').get('flex-wrap'), 'wrap', 'fallback toolbar must allow scaled labels to wrap');
const { detailLayoutMetrics } = await import('../uni_modules/qt-ui/composables/detail-layout.ts');
const geometryCases = [
  { wide: false, content: 2560, split: false, aside: 0, list: 2520, cover: 0 },
  { wide: true, content: 488, split: false, aside: 0, list: 448, cover: 0 },
  { wide: true, content: 635, split: false, aside: 0, list: 595, cover: 0 },
  { wide: true, content: 636, split: true, aside: 220, list: 360, cover: 186 },
  { wide: true, content: 637, split: true, aside: 221, list: 360, cover: 187 },
  { wide: true, content: 688, split: true, aside: 272, list: 360, cover: 220 },
  { wide: true, content: 689, split: true, aside: 272, list: 361, cover: 220 },
  { wide: true, content: 720, split: true, aside: 272, list: 392, cover: 220 },
  { wide: true, content: 1080, split: true, aside: 272, list: 752, cover: 220 },
  { wide: true, content: 2560, split: true, aside: 272, list: 2232, cover: 220 },
  { wide: true, content: 0, split: false, aside: 0, list: 0, cover: 0 },
];
for (const c of geometryCases) {
  const actual = detailLayoutMetrics(c.wide, c.content);
  assert.deepEqual(actual, { split: c.split, innerWidthPx: Math.max(0, c.content - 40), asideWidthPx: c.aside, listWidthPx: c.list, coverSizePx: c.cover }, `effective content width ${c.content}, shared wide ${c.wide}`);
  if (actual.split) {
    assert.ok(actual.listWidthPx >= 360);
    assert.ok(actual.asideWidthPx >= 220 && actual.asideWidthPx <= 272);
    assert.equal(actual.asideWidthPx + 16 + actual.listWidthPx, actual.innerWidthPx);
  }
}
// Simulates successive cap/rotation inputs, not a synthetic implementation of the helper.
assert.deepEqual([1080, 488, 636, 635, 720].map(width => detailLayoutMetrics(true, width).split), [true, false, true, false, true]);
const settings = source('uni_modules/qt-ui/components/qt-settings-overview/qt-settings-overview.uvue');
assert.ok(settings.includes('return settingsOverviewTwoColumn(layout.isWide, props.inPane == true, qtContentWidth("flow"), QT_GUTTER_PX);'), 'settings columns must share the wide font/density decision plus effective width and inPane guard');
assert.ok(settings.includes('qtFontDual(28, 17)') && settings.includes('qtFontDual(24, 14)'), 'settings text must retain globally scaled responsive fonts');
const { settingsOverviewTwoColumn } = await import('../uni_modules/qt-ui/composables/detail-layout.ts');
const settingsCases = [
  [false, false, 764, false],
  [false, false, 787, false],
  [false, false, 851, false],
  [true, false, 763, false],
  [true, false, 764, true],
  [true, false, 765, true],
  [true, false, 841, true],
  [true, true, 1440, false],
  [false, true, 1440, false],
  [true, false, 400, false],
];
for (const [wide, inPane, content, expected] of settingsCases) {
  assert.equal(settingsOverviewTwoColumn(wide, inPane, content, 24), expected, `settings: density ${wide}, inPane ${inPane}, effective content ${content}`);
}
console.log(`detail layout: FM ${radioProperties} + podcast ${podcastProperties} dimension contracts; ${geometryCases.length} detail + ${settingsCases.length} settings actual pure geometries passed (static only)`);
