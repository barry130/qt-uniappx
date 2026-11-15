import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tvSettingsFixture } from './check-tv-settings.mjs';
import { listFixture } from './check-tv-list-hosts.mjs';
// Agreed public seam: complete compiled QtUI templates/user click -> live layout/navigation policies.
// Native viewport/route/registration data are boundaries, never page private-handler oracles.
const UI = 'uni_modules/qt-ui/components/';
const cases = {};
const px = (b,n,p) => Number.parseFloat(b.css(n)[p] ?? '0');
const first = (b,c) => b.byClass(c)[0];
cases.rail = async () => {
  const destinations=[];
  const b=await tvSettingsFixture({savedMode:'tv',width:800,height:600,boundaryOverrides:{
    'stores/source-registry':{useSourceRegistryStore:()=>({supports:()=>true,anySupports:()=>true})},
    'uni_modules/qt-ui/composables/qt-nav':{qtRailNavigate:p=>destinations.push(p),qtRailSwitchTab:p=>destinations.push(p)},
  }});
  try {
    await b.mount(UI+'qt-side-nav/qt-side-nav.uvue',{current:'/pages/home/index'},false);
    const rail=first(b,'qsn'), items=b.byClass('qsn-item');
    assert.equal(px(b,rail,'width'),136,'manual TV at medium width uses the TV rail, not the icon-only tablet rail');
    assert.equal(px(b,items[0],'height'),76);
    assert.ok(b.byClass('qsn-label').length>=2,'TV retains named navigation');
    assert.ok(px(b,first(b,'qsn-label'),'font-size')>=20);
    assert.equal(items[0].props['data-qt-tv-id'],'nav:/pages/home/index');
    const search=items.find(n=>n.props['data-qt-tv-id']==='nav:/pages/search/index');
    await b.dispatch(search); assert.deepEqual(destinations,['/pages/search/index'],'one action routes exactly once');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.byClass('qsn-label').length,0,'tablet medium returns to its existing icon rail');
    assert.equal(px(b,items[0],'height'),44);
  } finally {await b.close();}
};
cases['frame-chips'] = async () => {
  const taps = [];
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720, realFrame: true,
    boundaryOverrides: {
      'services/confirm': undefined,
      'stores/source-registry': { useSourceRegistryStore: () => ({ supports: () => true, anySupports: () => true, ensure: async () => {} }) },
      // Inactive frame business hosts still import their native SDK. Keep the real
      // UI/services, but expose an empty native filesystem and no permission grants.
      'uni_modules/qt-js-engine': new Proxy({ __esModule: true, dataDir: () => 'fixture://data',
        readTextFile: () => '', exists: () => false, listDir: () => [] }, {
        get: (target, key) => key in target ? target[key] : () => { throw new Error('unexpected frame SDK call: ' + String(key)); },
      }),
      'uni_modules/qt-app-native': new Proxy({ __esModule: true }, {
        get: (target, key) => key in target ? target[key] : () => { throw new Error('unexpected frame native call: ' + String(key)); },
      }),
    },
  });
  try {
    await b.mount(UI + 'qt-page-frame/qt-page-frame.uvue', {
      current: '/pages/search/index', headerChipTexts: ['网易云', '聚合搜索'],
      headerChipActives: [true, false], onHeaderChipTap: index => taps.push(index),
    }, false);
    const chips = b.byClass('qt-page-frame-barchip');
    const row = first(b, 'qt-page-frame-chip-row');
    assert.equal(px(b, chips[0], 'height'), 56, 'TV top source tabs have full-size remote targets');
    assert.ok(px(b, first(b, 'qt-page-frame-chip-text'), 'font-size') >= 20, 'TV top tabs use the actual ten-foot font floor');
    assert.equal(px(b, row, 'height'), 72, 'the containing scroll viewport does not clip TV chips');
    assert.equal(chips[0].props['data-qt-tv-id'], 'header-chip:0', 'top tabs expose stable business focus IDs');
    await b.dispatch(chips[1]); assert.deepEqual(taps, [1], 'one actual frame tab activation reaches the public page event once');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(px(b, row, 'height'), 40, 'same-window touch restores the established wide chip viewport');
    assert.equal(px(b, first(b, 'qt-page-frame-barchip'), 'height'), 30);
    assert.equal(px(b, first(b, 'qt-page-frame-chip-text'), 'font-size'), 16.1);
  } finally { await b.close(); }
};
cases['song-lite'] = async () => {
  const events = [], song = { id: 'opaque:id', platform: 'netease', name: '遥远的歌', singer: '歌手', album: '专辑', picUrl: '' };
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720, boundaryOverrides: {
    'stores/player': { usePlayerStore: () => ({ isLiked: () => false, showPlaylistPickerFor() { events.push('picker'); } }) },
    'stores/dislikes': { useDislikesStore: () => ({ isDisliked: () => false }) },
    'services/platform': { platformShort: () => '网易', platformColor: () => '#d93c43' },
  } });
  try {
    await b.mount(UI + 'qt-song-row-lite/qt-song-row-lite.uvue', { song, tvId: 'search-result:occurrence-2', usePicker: true,
      onPlay: () => events.push('play'), onMore: value => events.push(['more', value.id]),
      onPick: value => events.push(['pick', value.id]) }, false);
    const row = first(b, 'lite-row'), targets = b.byClass('lite-hit');
    assert.equal(px(b, row, 'height'), 76, 'TV virtual song rows use the shared ten-foot row height');
    assert.equal(px(b, targets[0], 'width'), 56, 'TV row actions have 56px remote targets');
    assert.equal(targets[0].props['data-qt-tv-id'], 'search-result:occurrence-2:pick');
    assert.equal(row.props['data-qt-tv-id'], 'search-result:occurrence-2', 'virtual rows accept an occurrence ID instead of merging duplicate songs');
    assert.ok(px(b, first(b, 'lite-meta'), 'font-size') >= 20);
    assert.ok(px(b, first(b, 'lite-meta'), 'line-height') >= 26, 'second-line height follows the actual enlarged font');
    await b.dispatch(row); await b.dispatch(targets[1]); await b.dispatch(targets[0]);
    assert.deepEqual(events, ['play', ['more', 'opaque:id'], ['pick', 'opaque:id']], 'stopped row actions never also play the song');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(px(b, row, 'height'), 0, 'touch restores original class-driven 82px virtual row geometry');
    assert.equal(px(b, targets[0], 'width'), 0);
  } finally { await b.close(); }
  const selecting = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720, boundaryOverrides: {
    'stores/player': { usePlayerStore: () => ({ isLiked: () => false }) },
    'stores/dislikes': { useDislikesStore: () => ({ isDisliked: () => false }) },
    'services/platform': { platformShort: () => '网易', platformColor: () => '#d93c43' },
  } });
  const selection = [];
  try {
    await selecting.mount(UI + 'qt-song-row-lite/qt-song-row-lite.uvue', { song, selecting: true, selected: false,
      onPlay: () => selection.push('play'), onSelect: () => selection.push('select') }, false);
    assert.equal(selecting.byClass('lite-hit').length, 0, 'selection mode keeps more/favorite actions hidden');
    await selecting.dispatch(first(selecting, 'qt-checkbox')); await selecting.dispatch(first(selecting, 'lite-row'));
    assert.deepEqual(selection, ['select', 'select'], 'checkbox and whole-row selection each emit once, without playback');
  } finally { await selecting.close(); }
};

cases['local-row'] = async () => {
  const events = [];
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720 });
  try {
    await b.mount(UI + 'qt-local-row/qt-local-row.uvue', {
      title: '本地歌曲', meta: '独立歌手', durationText: '3:42', selecting: false, selected: false, current: true,
      tvId: 'local-file:occurrence-3', onTap: () => events.push('tap'), onMore: () => events.push('more'),
    }, false);
    const row = first(b, 'row'), more = first(b, 'row-more');
    assert.equal(px(b, row, 'height'), 76, 'local row and its virtual host share TV geometry');
    assert.equal(row.props['data-qt-tv-id'], 'local-file:occurrence-3');
    assert.equal(px(b, more, 'width'), 56, 'local more has a full remote target');
    assert.equal(more.props['data-qt-tv-id'], 'local-file:occurrence-3:more');
    assert.ok(px(b, first(b, 'meta'), 'line-height') >= 26);
    await b.dispatch(more); await b.dispatch(row);
    assert.deepEqual(events, ['more', 'tap'], 'more does not bubble into local playback');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(px(b, row, 'height'), 91, 'large TV fonts expand the shared virtual-row budget');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(px(b, row, 'height'), 0, 'normal local rows retain their original content-driven height');
    assert.equal(px(b, more, 'width'), 0);
  } finally { await b.close(); }
};

cases['song-row'] = async () => {
  const events = [];
  const song = { id: 'track', platform: 'wyy', name: '收藏歌曲', singer: '歌手', album: '专辑', picUrl: '' };
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720, boundaryOverrides: {
    'stores/player': { usePlayerStore: () => ({ isLiked: () => false, showPlaylistPickerFor: () => events.push('picker') }) },
    'stores/downloads': { useDownloadsStore: () => ({ has: () => false }) },
    'stores/dislikes': { useDislikesStore: () => ({ isDisliked: () => false, hasSongRule: () => false, hasSingerRule: () => false }) },
    'services/platform': { platformShort: () => '网易', platformColor: () => '#d93c43' },
  } });
  try {
    await b.mount(UI + 'qt-song-row/qt-song-row.uvue', { song, tvId: 'history:occurrence-4', showBadge: true,
      onPlay: () => events.push('play') }, false);
    const row = first(b, 'row'), targets = b.byClass('act-hit');
    assert.equal(px(b, row, 'height'), 76, 'full song row uses shared TV height');
    assert.equal(row.props['data-qt-tv-id'], 'history:occurrence-4');
    assert.equal(px(b, targets[0], 'width'), 56);
    assert.ok(px(b, first(b, 'meta'), 'line-height') >= 26);
    await b.dispatch(targets[0]); await b.dispatch(targets[1]);
    assert.deepEqual(events, ['picker'], 'more and collection do not also emit playback');
    assert.equal(b.action.qtActionSheetState().visible.value, true, 'actual more opens the shared action service');
    b.action.qtActionSheetCancel(); await b.flush();
    await b.dispatch(row); assert.deepEqual(events, ['picker', 'play']);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(px(b, row, 'height'), 0);
    assert.equal(px(b, targets[0], 'width'), 0);
  } finally { await b.close(); }
};

cases['platform-tags'] = async () => {
  const song = { id: 'track', platform: 'wyy', name: '歌曲', singer: '歌手', album: '', picUrl: '' };
  for (const [component, cls] of [['qt-song-row-lite', 'lite-tag'], ['qt-song-row', 'pbadge']]) {
    const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720, boundaryOverrides: {
      'stores/player': { usePlayerStore: () => ({ isLiked: () => false }) },
      'stores/downloads': { useDownloadsStore: () => ({ has: () => false }) },
      'stores/dislikes': { useDislikesStore: () => ({ isDisliked: () => false, hasSongRule: () => false, hasSingerRule: () => false }) },
      'services/platform': { platformShort: () => '网易', platformColor: () => '#d93c43' },
    } });
    try {
      await b.mount(UI + component + '/' + component + '.uvue', { song, showBadge: true }, false);
      const tag = first(b, cls);
      const label = cls === 'pbadge' ? first(b, 'pbadge-text') : tag;
      assert.ok(px(b, label, 'line-height') >= 26, 'TV platform tag line follows its actual 20px font');
      assert.ok(px(b, tag, 'height') >= 32, 'TV tag border box contains its enlarged font');
      b.tv.qtSetTvMode('touch'); await b.flush();
      assert.equal(b.css(tag).height, undefined, 'touch platform tags keep original class-driven geometry');
    } finally { await b.close(); }
  }
};

cases['frame-single-content'] = async () => {
  for (const current of ['/pages/play-settings/index', '/pages/user/index']) {
    const b = await listFixture({ savedMode: 'tv', width: 1280, height: 720, realFrame: true,
      boundaryOverrides: { 'services/music-api': undefined } });
    try {
      await b.mount(UI + 'qt-page-frame/qt-page-frame.uvue', { current }, false);
      const widths = b.load('uni_modules/qt-ui/composables/use-qt-widths.ts');
      assert.equal(b.byClass('qt-page-frame-snav').length, 0, 'TV family pages have one main pane, not two competing overview areas');
      assert.equal(widths.qtSplitActive(true), false, 'page hubs and their frame share TV single-content policy');
      assert.equal(widths.qtContentWidthRaw('flow'), 1088, 'TV content width leaves 28px outer gutters beside the 136px rail');
      assert.equal(widths.qtColumnCount(1024, 168, 12), 4, 'TV album grids preserve readable 208px minimum cards');
      b.tv.qtSetTvMode('touch'); await b.flush();
      assert.equal(b.byClass('qt-page-frame-snav').length, 1, 'ordinary desktop settings/profile retain their original family overview');
      assert.equal(widths.qtSplitActive(true), true);
      assert.equal(widths.qtContentWidthRaw('flow'), 1136, 'ordinary desktop restores 96px rail and 24px gutters');
      assert.equal(widths.qtColumnCount(1024, 168, 12), 5);
    } finally { await b.close(); }
  }
};

cases['frame-pane-action'] = async () => {
  const taps = [];
  const b = await listFixture({ savedMode: 'tv', width: 1280, height: 720, realFrame: true,
    boundaryOverrides: { 'services/music-api': undefined } });
  try {
    await b.mount(UI + 'qt-page-frame/qt-page-frame.uvue', { current: '/pages/search/index',
      headerChipTexts: ['网易云', '聚合搜索'], headerChipActives: [true, false],
      paneHeadText: '播放全部', paneHeadCount: 61, onPaneHeadTap: () => taps.push(true) }, false);
    const button = first(b, 'qt-page-frame-pane-btn');
    assert.ok(button, 'actual wide pane action is visible');
    assert.equal(px(b, button, 'height'), 56, 'TV pane action matches the shared remote target');
    assert.equal(button.props['data-qt-tv-id'], 'pane-head-action');
    assert.ok(px(b, first(b, 'qt-page-frame-pane-btn-text'), 'line-height') >= 28);
    await b.dispatch(button); assert.deepEqual(taps, [true], 'pane action emits once');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(first(b, 'qt-page-frame-pane-btn')).height, undefined, 'ordinary desktop retains the existing class-only pane action');
  } finally { await b.close(); }
};

cases['song-selection-box'] = async () => {
  const song = { id: 'track', platform: 'wyy', name: '歌曲', singer: '歌手', album: '', picUrl: '' };
  const b = await listFixture({ savedMode: 'tv', width: 1280, height: 720 });
  try {
    await b.mount(UI + 'qt-song-row/qt-song-row.uvue', { song, selecting: true, selected: true }, false);
    const mark = first(b, 'select-mark');
    assert.equal(px(b, mark, 'width'), 56, 'TV selection wrapper contains the actual 56px checkbox without clipping');
    assert.equal(px(b, mark, 'height'), 56);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(mark).width, undefined, 'touch selection overlay keeps its original class dimensions');
  } finally { await b.close(); }
};

export async function runTvDensityChecks(selected='all') {
  const entries=selected==='all'?Object.entries(cases):[[selected,cases[selected]]];
  assert.ok(entries.every(([,fn])=>typeof fn==='function'),'known TV density group');
  for(const [name,fn] of entries){await fn();console.log('PASS TV density '+name);}
  console.log('TV density: '+entries.length+' compiled-template groups passed');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await runTvDensityChecks(process.argv.find(arg=>arg.startsWith('--case='))?.slice(7)??'all');
}
