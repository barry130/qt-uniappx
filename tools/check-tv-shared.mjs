import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Vue from 'vue';
import { tvListHostFixture } from './check-tv-list-hosts.mjs';

// Agreed public seam: full production QtUI SFCs, native public events and real policies.
// The frozen fixture replaces only native/SDK/network/clock/navigation boundaries.
const UI = 'uni_modules/qt-ui/components/';
const cases = {};
const walk = n => [n, ...n.children.flatMap(walk)];
const text = n => n.text + n.children.map(text).join('');
const px = (b, n, p) => Number.parseFloat(b.css(n)[p] ?? '0');
const first = (b, name) => b.byClass(name)[0];

cases['batch-targets'] = async () => {
  const b = await tvListHostFixture({ savedMode:'tv', width:1280, height:720 });
  const props = Vue.reactive({ count:0, total:3, layout:'column' });
  const events = [];
  Object.assign(props, { onToggle:() => events.push('toggle'), onDownload:() => events.push('download'),
    onCollect:() => events.push('collect'), onCancel:() => events.push('cancel') });
  try {
    await b.mount(UI + 'qt-batch-bar/qt-batch-bar.uvue', props);
    assert.equal(px(b, first(b, 'qt-batch-bar-col-head'), 'height'), 56, 'TV batch column header fits its actual 56px checkbox');
    const buttons = b.byClass('qt-batch-bar-col-btn');
    assert.equal(buttons.length, 3);
    for (const node of buttons) assert.equal(px(b, node, 'height'), 56, 'TV batch actions have full remote targets');
    assert.equal(buttons[0].props['data-qt-tv-id'], 'batch-download');
    assert.ok(String(buttons[0].props.class).includes('qt-tv-skip'), 'empty batch has no actionable download candidate');
    assert.ok(String(buttons[1].props.class).includes('qt-tv-skip'));
    await b.dispatch(buttons[0]); await b.dispatch(buttons[1]); assert.deepEqual(events, [], 'real empty guards retain the original business meaning');
    await b.dispatch(first(b, 'qt-checkbox')); assert.deepEqual(events, ['toggle'], 'checkbox click.stop toggles exactly once');
    await b.dispatch(first(b, 'qt-batch-bar-col-head')); assert.deepEqual(events, ['toggle', 'toggle']);
    props.count = 2; await b.flush();
    assert.ok(!String(buttons[0].props.class).includes('qt-tv-skip'));
    await b.dispatch(buttons[0]); await b.dispatch(buttons[1]); await b.dispatch(buttons[2]);
    assert.deepEqual(events.slice(2), ['download', 'collect', 'cancel']);
    assert.ok(px(b, first(b, 'qt-batch-bar-col-btn-text'), 'line-height') >= 27, 'TV batch text uses its actual readable line box');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(buttons[0]).height, undefined, 'same mounted touch column retains its original 40px CSS');
  } finally { await b.close(); }
};

cases['batch-bar-targets'] = async () => {
  const b = await tvListHostFixture({ savedMode:'tv', width:1280, height:720 });
  const events = [];
  try {
    await b.mount(UI + 'qt-batch-bar/qt-batch-bar.uvue', { count:2, total:3, size:'md',
      onToggle:() => events.push('toggle'), onDownload:() => events.push('download'),
      onCollect:() => events.push('collect'), onCancel:() => events.push('cancel') });
    const bar = first(b, 'qt-batch-bar');
    assert.equal(px(b, bar, 'height'), 76, 'TV horizontal batch bar fits the original native header owner');
    const buttons = b.byClass('qt-batch-bar-btn');
    for (const target of buttons) assert.equal(px(b, target, 'height'), 56, 'TV horizontal batch actions retain full targets');
    assert.equal(buttons[0].props['data-qt-tv-id'], 'batch-download');
    assert.equal(buttons[1].props['data-qt-tv-id'], 'batch-collect');
    assert.equal(buttons[2].props['data-qt-tv-id'], 'batch-cancel');
    await b.dispatch(first(b, 'qt-checkbox')); assert.deepEqual(events, ['toggle']);
    for (const target of buttons) await b.dispatch(target);
    assert.deepEqual(events, ['toggle', 'download', 'collect', 'cancel']);
    assert.ok(px(b, first(b, 'qt-batch-bar-count'), 'line-height') >= 28);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(bar).height, undefined, 'touch uses its unchanged 60px md CSS host contract');
    assert.equal(b.css(buttons[0]).height, undefined);
  } finally { await b.close(); }
};

cases['segmented-targets'] = async () => {
  const b = await tvListHostFixture({ savedMode:'tv', width:1280, height:720 });
  const props = Vue.reactive({ list:['次数', '时长'], modelValue:0 });
  const changed = [], updates = [];
  Object.assign(props, { onChange:value => changed.push(value), 'onUpdate:modelValue':value => { updates.push(value); props.modelValue = value; } });
  try {
    await b.mount(UI + 'qt-segmented/qt-segmented.uvue', props);
    const targets = b.byClass('seg-item');
    assert.equal(targets.length, 2);
    assert.equal(px(b, targets[0], 'height'), 56, 'TV equal-width segmented choices have full remote targets');
    const mountedIds = targets.map(node => node.props['data-qt-tv-id']);
    assert.match(mountedIds[0], /^segment:[0-9]+:0$/, 'public segmented identity includes its mounted instance and choice');
    assert.match(mountedIds[1], /^segment:[0-9]+:1$/); assert.equal(new Set(mountedIds).size, 2);
    const labels = b.byClass('seg-text');
    assert.equal(px(b, labels[0], 'line-height'), 27, 'TV segment label follows actual 20px floor × 1.35');
    assert.equal(b.css(labels[0]).color, '#d93c43', 'segmented selection stays red, independent of focus');
    await b.dispatch(targets[0]); assert.deepEqual(changed, []);
    await b.dispatch(targets[1]); assert.deepEqual(changed, [1]); assert.deepEqual(updates, [1]);
    assert.equal(b.css(labels[1]).color, '#d93c43');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); assert.equal(px(b, labels[1], 'line-height'), 35);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(targets[0]).height, undefined, 'touch still uses its original 36px wide segment CSS');
    assert.equal(b.css(labels[1])['line-height'], undefined);
    assert.deepEqual(b.byClass('seg-item').map(node => node.props['data-qt-tv-id']), mountedIds, 'model/font/TV-to-touch updates preserve both mounted choice identities');
  } finally { await b.close(); }
};

// Native element/event/geometry boundary only. No production component, store or
// reporting policy is substituted. These rectangles are not a Yoga/device proof.
function nativeUiBoundary() {
  let b, serial = 0, registry = new Map();
  const ids = new WeakMap(), offsets = new WeakMap(), pending = [], scrollCalls = [], activations = [];
  let backs = 0;
  const rawWalk = n => { n = Vue.toRaw(n); return [n, ...n.children.flatMap(rawWalk)]; };
  const has = (n, name) => String(n.props.class ?? '').split(' ').includes(name);
  const id = n => {
    n = Vue.toRaw(n);
    if (n.props['data-qt-tv-id']) return 'tv:fixture:page:custom:' + n.props['data-qt-tv-id'];
    if (!ids.has(n)) ids.set(n, 'tv:fixture:page:node:' + ++serial);
    return ids.get(n);
  };
  const scrollParent = node => {
    for (let n = Vue.toRaw(node); n; n = Vue.toRaw(n.parent))
      if (['scroll-view', 'list-view'].includes(n.tag)) return n;
    return null;
  };
  const platform = {
    tvReadDevice:() => ({ television:true, leanback:true, uiModeType:4, nativeAvailable:true }),
    tvStartRemote() {}, tvSetRemoteState() {}, tvStopRemote() {}, tvPresent() {}, tvHighlight() {},
    tvBack:() => backs++,
    tvCollect(root) {
      registry = new Map();
      const nodes = root == null ? [] : rawWalk(root).filter(n => !has(n, 'qt-tv-skip') &&
        (n.props.onTap || n.props.onClick || n.props.onLongpress || (['scroll-view', 'list-view'].includes(n.tag) && has(n, 'qt-tv-scroll'))) &&
        b.css(n).display !== 'none');
      return nodes.map((n, i) => {
        const key = id(n), group = scrollParent(n); registry.set(key, n);
        return { id:key, left:20, top:40 + i * 100, width:300, height:56,
          enabled:n.props.disabled !== true, visible:true, input:false,
          longPress:!!n.props.onLongpress, scrollGroup:group ? id(group) : '' };
      });
    },
    tvActivate(key, longPress) {
      const n = registry.get(key); assert.ok(n, 'activation uses an actual collected production node');
      activations.push(key);
      if (has(n, 'qt-tv-scroll')) return;
      pending.push(b.dispatch(n, longPress ? 'longpress' : n.props.onTap ? 'tap' : 'click'));
    },
    tvScroll(key, direction) {
      const n = registry.get(key), owner = n && scrollParent(n);
      if (!owner || !['up', 'down'].includes(direction)) return false;
      const before = offsets.get(owner) ?? 0, after = Math.max(0, Math.min(1120, before + (direction === 'down' ? 280 : -280)));
      offsets.set(owner, after); scrollCalls.push({ owner, before, after }); return after !== before;
    },
  };
  return { platform, bind:value => { b = value; }, id, scrollCalls, activations, backs:() => backs,
    async remote(key, repeat = 0) {
      assert.equal(b.tv.qtTvDispatchRemote({ key, code:key === 'ok' ? 23 : key === 'back' ? 4 : 20, action:'down', repeat }), true);
      for (const job of pending.splice(0)) await job;
      await b.flush(); await b.clock.runTimers(100);
    } };
}
async function listenFixture(options = {}) {
  const boundary = nativeUiBoundary();
  const overrides = options.boundaryOverrides ?? {};
  const b = await tvListHostFixture({ width:480, height:360, nativeAvailable:true, television:true, ...options, boundaryOverrides:{
    'services/tv-platform':boundary.platform,
    'uni_modules/qt-js-engine':{ publicDataDir:() => '', dataDir:() => '/owned-fixture',
      readTextFile:(_path, done) => done(false, '', 'ENOENT'), writeTextFile:(_path, _text, done) => done(true, ''),
      renamePath:(_old, _next, done) => done(true, ''), remove:(_path, done) => done(true, '') },
    'uni_modules/qt-app-native':{ queryPermissionStates:() => [] },
    ...overrides,
  } });
  boundary.bind(b); return { ...b, boundary };
}
cases['listen-readonly-modal'] = async () => {
  const b = await listenFixture(); let closes = 0;
  try {
    await b.mount(UI + 'qt-listen-detail/qt-listen-detail.uvue', { kind:'info', target:'', loadingKey:'', onClose:() => closes++ });
    assert.ok(b.text().includes('怎样统计') && b.text().includes('成功保存到公共目录后'), 'the complete existing statistics document is rendered');
    assert.equal(b.tv.qtTvHasModal(), true, 'the actual detail drawer owns a modal before background navigation');
    const document = first(b, 'detail-scroll');
    assert.ok(String(document.props.class).includes('qt-tv-scroll'), 'read-only information remains a reachable native scroll target');
    assert.equal(document.props['data-qt-tv-id'], 'listen-document');
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus('listen-document'));
    await b.boundary.remote('ok'); assert.equal(closes, 0, 'readonly OK does not run drawer or business actions');
    await b.boundary.remote('down'); assert.equal(b.boundary.scrollCalls.at(-1).after, 280);
    await b.boundary.remote('up'); assert.equal(b.boundary.scrollCalls.at(-1).after, 0);
    await b.boundary.remote('back'); assert.equal(closes, 1); assert.equal(b.boundary.backs(), 0, 'modal Back never exits the native page');
    await b.boundary.remote('back', 1); assert.equal(closes, 1, 'owned repeat never closes twice');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.ok(!String(document.props.class).includes('qt-tv-scroll'), 'same mounted touch document restores its original native scroll contract');
  } finally { await b.close(); }
};

cases['listen-drawer-budget'] = async () => {
  const b = await listenFixture();
  try {
    await b.mount(UI + 'qt-listen-detail/qt-listen-detail.uvue', { kind:'info', target:'', loadingKey:'' });
    const panel = first(b, 'detail-panel');
    assert.equal(px(b, panel, 'width'), 424, 'short TV uses the shared drawer width, not 75 percent of the window');
    assert.equal(px(b, panel, 'padding-bottom'), 0, 'TV padding does not add native safe area after the whole drawer height');
    assert.equal(px(b, first(b, 'detail-header'), 'min-height'), 81, 'header reserves a 56px close control, 24px padding and divider');
    assert.equal(first(b, 'detail-scroll').tag, 'scroll-view', 'original flex:1/min-height:0 native document remains the scroll owner');
    assert.equal(px(b, panel, 'height'), 360, 'the side drawer owns one pane height');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(px(b, first(b, 'detail-header'), 'min-height'), 81);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(px(b, panel, 'width'), 480, 'compact touch keeps its original full-width bottom drawer');
    assert.equal(b.css(first(b, 'detail-header'))['min-height'], undefined);
    assert.equal(b.css(panel)['padding-bottom'], undefined);
  } finally { await b.close(); }
};

cases['listen-controls-density'] = async () => {
  const b = await listenFixture();
  const props = Vue.reactive({ kind:'songs', target:'', loadingKey:'' });
  const played = [];
  props.onPlay = song => played.push(song);
  try {
    const stats = b.load('stores/listen-stats.ts').useListenStatsStore();
    const one = { platform:'wyy', id:'one', name:'远山第一曲', singer:'甲', album:'山', picUrl:'' };
    const two = { platform:'qq', id:'two', name:'海面第二曲', singer:'乙', album:'海', picUrl:'' };
    await stats.recordProgress(one, 90, 1, 0, 1000000);
    await stats.recordProgress(one, 20, 1, 0, 1000001);
    await stats.recordProgress(two, 200, 1, 0, 1000002);
    await b.mount(UI + 'qt-listen-detail/qt-listen-detail.uvue', props);
    assert.deepEqual(b.byClass('detail-row').map(n => text(n).includes('远山第一曲')), [true, false], 'actual reportEntries defaults to count order');
    const close = first(b, 'detail-icon-button');
    assert.equal(px(b, close, 'width'), 56, 'header close is a full TV control');
    assert.equal(px(b, close, 'height'), 56);
    assert.equal(close.props['data-qt-tv-id'], 'listen-close');
    const rows = b.byClass('detail-row');
    assert.ok(px(b, rows[0], 'min-height') >= 110, 'three actual TV lines and original subline margins fit the growing row');
    assert.equal(rows[0].props['data-qt-tv-id'], 'listen-row:songs:wyy:one');
    const icon = first(b, 'detail-row-icon');
    assert.equal(px(b, icon, 'width'), 56); assert.equal(px(b, icon, 'height'), 56);
    assert.equal(icon.props['data-qt-tv-id'], 'listen-play:wyy:one');
    assert.equal(px(b, first(b, 'detail-row-name'), 'line-height'), 29);
    assert.equal(px(b, first(b, 'detail-row-sub'), 'line-height'), 28);
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus('listen-play:wyy:one'));
    await b.boundary.remote('ok'); assert.deepEqual(played.map(s => s.name), ['远山第一曲']);
    assert.equal(text(first(b, 'detail-title')), '歌曲排行', 'stopped play action does not bubble into details');
    props.loadingKey = 'wyy:one'; await b.flush();
    assert.equal(b.tv.qtTvFocus('listen-play:wyy:one'), false, 'busy playback is no longer a remote target');
    await b.dispatch(icon); assert.equal(played.length, 1, 'the rendered control retains the original loading guard');
    props.loadingKey = ''; await b.flush();
    const seconds = b.byClass('seg-item')[1]; await b.dispatch(seconds);
    assert.ok(text(b.byClass('detail-row')[0]).includes('海面第二曲'), 'real report service changes to duration order');
    assert.ok(b.tv.qtTvFocus('listen-play:wyy:one'), 'focus still addresses the original song after sorting');
    await b.boundary.remote('ok'); assert.deepEqual(played.map(s => s.name), ['远山第一曲', '远山第一曲']);
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(px(b, first(b, 'detail-row-name'), 'line-height'), 38);
    assert.equal(px(b, first(b, 'detail-row-sub'), 'line-height'), 33);
    assert.ok(px(b, b.byClass('detail-row')[0], 'min-height') >= 129);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(first(b, 'detail-row-icon')).width, undefined, 'touch restores its 30px CSS control');
    assert.equal(b.css(first(b, 'detail-row-name'))['line-height'], undefined);
  } finally { await b.close(); }
};

cases['profile-group-targets'] = async () => {
  // The real Profile host supplies its actual captured TV scope. Standalone
  // overview mounting has no page scope and does not prove remote activation.
  const b = await listenFixture({ realFrame:true });
  try {
    await b.mount('pages/profile/index.uvue');
    assert.equal(b.byClass('tile').length, 5, 'all existing account/local/library actions remain');
    const entries = b.byClass('cell'); assert.equal(entries.length, 5);
    for (const entry of entries) assert.equal(px(b, entry, 'min-height'), 76, 'TV profile group entries have the shared 76px row target');
    const assistant = b.cell('音乐助手'); assert.ok(assistant);
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(assistant)));
    const before = b.routes.length; await b.boundary.remote('ok'); await b.boundary.remote('ok', 1);
    assert.equal(b.routes.length - before, 1); assert.equal(b.routes.at(-1).url, '/pages/ai-assistant/index');
    b.tv.qtSetTvMode('touch'); await b.flush();
    for (const entry of entries) assert.equal(b.css(entry)['min-height'], undefined, 'touch recovers original group row geometry');
  } finally { await b.close(); }
};

cases['profile-scroll-budget'] = async () => {
  const b = await listenFixture({ realFrame:true, width:1280, height:720 });
  try {
    await b.mount('pages/profile/index.uvue');
    const document = first(b, 'body');
    assert.equal(px(b, document, 'padding-bottom'), 28, 'TV profile uses one gutter after its groups, not 220 uncapped rpx of empty space');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(px(b, document, 'padding-bottom'), 28, 'font tier never duplicates Frame dock reservation');
    assert.equal(b.byClass('tile').length, 5); assert.equal(b.byClass('cell').length, 5);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(first(b, 'body'))['padding-bottom'], undefined, 'live touch overview retains its original bottom rpx contract after Frame remount');
  } finally { await b.close(); }
};

cases['profile-summary-capacity'] = async () => {
  const b = await listenFixture({ realFrame:true });
  try {
    await b.mount('pages/profile/index.uvue');
    const summaries = b.byClass('cell-value'); assert.equal(summaries.length, 2);
    for (const summary of summaries) {
      assert.ok(String(summary.parent.props.class).split(' ').includes('cell-main'), 'narrow TV stacks the real history/assistant summary below its title');
      assert.equal(px(b, summary.parent, 'padding-top'), 8); assert.equal(px(b, summary.parent, 'padding-bottom'), 8);
    }
    assert.ok(b.text().includes('说出想听的') && b.text().includes('首记录'), 'the original summary text is retained, not hidden for TV');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const summary of b.byClass('cell-value')) assert.equal(px(b, summary, 'line-height'), 33);
    const assistant = b.byClass('cell').find(n => text(n).includes('音乐助手'));
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(assistant)));
    const before = b.routes.length; await b.boundary.remote('ok'); await b.boundary.remote('ok', 1);
    assert.equal(b.routes.length - before, 1); assert.equal(b.routes.at(-1).url, '/pages/ai-assistant/index');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.byClass('cell-main').length, 0, 'ordinary profile summaries remain in their original trailing positions');
  } finally { await b.close(); }
};

cases['profile-tile-capacity'] = async () => {
  const b = await listenFixture({ realFrame:true, width:1280, height:720 });
  try {
    await b.mount('pages/profile/index.uvue');
    const tiles = b.byClass('tile'); assert.equal(tiles.length, 5);
    for (const tile of tiles) assert.ok(px(b, tile, 'width') >= 99, 'all TV tiles reserve the four-glyph recent title plus horizontal breathing room');
    const collection = tiles.find(n => walk(n).some(child => String(child.props.class ?? '').split(' ').includes('tile-label') && text(child) === '收藏'));
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(collection)));
    const before = b.routes.length; await b.boundary.remote('ok'); await b.boundary.remote('ok', 1);
    assert.equal(b.routes.length - before, 1); assert.equal(b.routes.at(-1).url, '/pages/collection/index');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const tile of tiles) assert.ok(px(b, tile, 'width') >= 124, 'huge type never packs five 108px titles into 102px columns');
    const icon = first(b, 'tile-icon'); assert.equal(px(b, icon, 'width'), 56); assert.equal(px(b, icon, 'height'), 56);
    assert.equal(b.css(first(b, 'tiles'))['flex-wrap'], 'wrap', 'TV tile group wraps real existing actions instead of clipping labels');
    b.setWindow({ windowWidth:480, windowHeight:360, screenWidth:480, screenHeight:360 }); await b.clock.runTimers(1000);
    for (const tile of tiles) assert.ok(px(b, tile, 'width') >= 124);
    assert.ok(!String(first(b, 'cols').props.class).includes('cols-2'), 'narrow TV uses one original group column');
    b.tv.qtSetTvMode('touch'); await b.flush();
    for (const tile of tiles) assert.equal(b.css(tile).width, undefined, 'touch retains original equal fifths without TV width override');
    assert.equal(b.css(first(b, 'tiles'))['flex-wrap'], undefined);
    assert.equal(b.css(icon).width, undefined, 'touch keeps the original icon CSS');
  } finally { await b.close(); }
};

cases['profile-scroll-target'] = async () => {
  const b = await listenFixture({ realFrame:true });
  try {
    await b.mount('pages/profile/index.uvue');
    const document = first(b, 'body'); assert.ok(document && document.tag === 'scroll-view');
    assert.ok(String(document.props.class).includes('qt-tv-scroll'), 'short TV profile remains a readonly document target');
    assert.equal(document.props['data-qt-tv-id'], 'profile-document');
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus('profile-document'));
    const before = b.routes.length; await b.boundary.remote('ok'); await b.boundary.remote('ok', 1);
    assert.equal(b.routes.length, before, 'readonly profile OK does not invoke any account/library action');
    // This real page has account/tile/group actions within the same scroll
    // owner. Directional traversal reaches those before its scroll edge.
    for (let i = 0; i < 32 && b.boundary.scrollCalls.length === 0; i++) await b.boundary.remote('down');
    assert.equal(b.boundary.scrollCalls.at(-1)?.after, 280, 'the group edge scrolls the actual native document');
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus('profile-document'));
    for (let i = 0; i < 32 && b.boundary.scrollCalls.at(-1)?.after !== 0; i++) await b.boundary.remote('up');
    assert.equal(b.boundary.scrollCalls.at(-1)?.after, 0, 'the document remains reachable for upward scrolling');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.ok(!String(document.props.class).includes('qt-tv-scroll'), 'touch restores the original native profile scroll');
  } finally { await b.close(); }
};

cases['profile-readable-lines'] = async () => {
  const b = await listenFixture({ realFrame:true, width:1280, height:720 });
  try {
    await b.mount('pages/profile/index.uvue');
    const sets = [['sub', 29, 38], ['tile-label', 29, 38], ['tile-count', 28, 30], ['cell-title', 33, 43], ['cell-value', 28, 33]];
    for (const [name, line] of sets) {
      const nodes = b.byClass(name); assert.ok(nodes.length > 0, 'the original profile ' + name + ' is rendered');
      for (const n of nodes) assert.equal(px(b, n, 'line-height'), line, name + ' has the line box of its actual TV font');
    }
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const [name, , line] of sets) for (const n of b.byClass(name)) assert.equal(px(b, n, 'line-height'), line);
    b.tv.qtSetTvMode('touch'); await b.flush();
    for (const [name] of sets) for (const n of b.byClass(name)) assert.equal(b.css(n)['line-height'], undefined, name + ' returns to original touch CSS');
  } finally { await b.close(); }
};

cases['listen-sort-header-budget'] = async () => {
  const b = await listenFixture(); const played = [];
  try {
    const stats = b.load('stores/listen-stats.ts').useListenStatsStore();
    const counted = { platform:'wyy', id:'counted', name:'次数多的原歌曲', singer:'江河', album:'原排序', picUrl:'' };
    await stats.recordProgress(counted, 30, 1, 0, 1000000);
    await stats.recordProgress(counted, 30, 1, 0, 1000001);
    await stats.recordProgress({ platform:'wyy', id:'longer', name:'时长多的原歌曲', singer:'江河', album:'原排序', picUrl:'' }, 120, 1, 0, 1000001);
    await b.mount(UI + 'qt-listen-detail/qt-listen-detail.uvue', { kind:'songs', target:'', loadingKey:'', onPlay:song => played.push(song) });
    const header = first(b, 'detail-list-head'), sort = first(b, 'detail-sort');
    assert.equal(b.css(header)['flex-direction'], 'column', 'short TV puts the full ranking title and sort targets in separate lanes');
    assert.equal(b.css(header)['align-items'], 'stretch');
    assert.equal(b.css(sort).width, 'auto', 'TV sort shell grows to the actual shared segmented minimum, not a fixed 144px');
    assert.equal(b.css(sort)['align-self'], 'flex-end');
    assert.ok(px(b, first(b, 'seg'), 'min-width') <= 376, 'short drawer inner width can contain the whole sort control');
    assert.equal(b.byClass('seg-item').length, 2); assert.equal(px(b, b.byClass('seg-item')[1], 'height'), 56);
    assert.ok(text(b.byClass('detail-row')[0]).includes('次数多的原歌曲'));
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(b.byClass('seg-item')[1])));
    await b.boundary.remote('ok'); await b.boundary.remote('ok', 1);
    assert.ok(text(b.byClass('detail-row')[0]).includes('时长多的原歌曲'), 'native OK keeps real duration ranking');
    assert.equal(played.length, 0);
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.ok(px(b, first(b, 'seg'), 'min-width') <= 376);
    assert.equal(px(b, first(b, 'detail-list-title'), 'line-height'), 38);
    assert.equal(b.css(sort).width, 'auto');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(first(b, 'detail-list-head'))['flex-direction'], undefined, 'touch recovers the original horizontal header CSS');
    assert.equal(b.css(first(b, 'detail-sort')).width, undefined, 'touch keeps its original 144px CSS rule without TV override');
  } finally { await b.close(); }
};

cases['listen-load-more-action'] = async () => {
  const b = await listenFixture(); const played = [];
  try {
    const stats = b.load('stores/listen-stats.ts').useListenStatsStore();
    for (let i = 0; i < 101; i++) await stats.recordProgress({ platform:'wyy', id:'page-' + i, name:'实际排行歌曲' + i, singer:'远方', album:'原排行', picUrl:'' }, 90 + i, 1, 0, 1000000 + i);
    await b.mount(UI + 'qt-listen-detail/qt-listen-detail.uvue', { kind:'songs', target:'', loadingKey:'', onPlay:song => played.push(song) });
    assert.equal(b.byClass('detail-row').length, 50, 'original report page starts with fifty actual rows');
    const more = first(b, 'detail-more');
    assert.equal(more.props['data-qt-tv-id'], 'listen-more', 'more action is a stable remote target');
    assert.ok(px(b, more, 'min-height') >= 56);
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('listen-more'), true);
    await b.boundary.remote('ok'); await b.boundary.remote('ok', 1);
    assert.equal(b.byClass('detail-row').length, 100, 'one OK retains the original plus-fifty page, repeat does not add another');
    assert.ok(text(first(b, 'detail-more')).includes('100 / 101'));
    assert.equal(played.length, 0, 'pagination does not start a song');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.ok(px(b, first(b, 'detail-more'), 'min-height') >= 56);
    assert.equal(px(b, first(b, 'detail-more').children[0], 'line-height'), 35);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(first(b, 'detail-more'))['min-height'], undefined);
    await b.dispatch(first(b, 'detail-more')); assert.equal(b.byClass('detail-row').length, 101);
    assert.equal(b.byClass('detail-more').length, 0, 'original final page removes more action');
  } finally { await b.close(); }
};

cases['listen-permissions-action'] = async () => {
  const writes = [], routes = [];
  const b = await listenFixture({ boundaryOverrides:{
    'uni_modules/qt-js-engine':{ publicDataDir:() => '/owned-report', dataDir:() => '/owned-fixture',
      readTextFile:(_path, done) => done(false, '', 'ENOENT'),
      writeTextFile:(path, value, done) => { writes.push({ path, value }); done(true, ''); },
      renamePath:(_old, _next, done) => done(true, ''), remove:(_path, done) => done(true, '') },
    'uni_modules/qt-app-native':{ queryPermissionStates:() => [{ applicable:true, unknown:false, granted:false }] },
  } });
  try {
    b.setSdk({ navigateTo:options => routes.push(options.url) });
    const stats = b.load('stores/listen-stats.ts').useListenStatsStore(); await stats.load();
    await b.mount(UI + 'qt-listen-detail/qt-listen-detail.uvue', { kind:'info', target:'', loadingKey:'' });
    assert.ok(b.text().includes('/owned-report/listen-stats.json') && b.text().includes('暂存应用目录，请检查所有文件访问权限'));
    assert.equal(writes.length, 0, 'original unavailable permission never writes a public report file');
    const action = first(b, 'detail-primary');
    assert.equal(action.props['data-qt-tv-id'], 'listen-permissions', 'original permission route has a stable remote target');
    assert.ok(px(b, action, 'min-height') >= 56);
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('listen-permissions'), true);
    await b.boundary.remote('ok'); await b.boundary.remote('ok', 1);
    assert.deepEqual(routes, ['/pages/permissions/index'], 'remote permission action keeps exactly one original route');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(px(b, first(b, 'detail-settings-label'), 'line-height'), 35);
    assert.ok(px(b, action, 'min-height') >= 56);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(action)['min-height'], undefined, 'touch preserves the original permission primary padding');
  } finally { await b.close(); }
};

cases['listen-row-busy-focus'] = async () => {
  const b = await listenFixture(); const played = [];
  const props = Vue.reactive({ kind:'songs', target:'', loadingKey:'', onPlay:song => played.push(song) });
  try {
    const stats = b.load('stores/listen-stats.ts').useListenStatsStore();
    for (const id of ['first', 'second']) await stats.recordProgress({ platform:'wyy', id, name:id, singer:'原歌手', album:'原专辑', picUrl:'' }, 90, 1, 0, 1000000);
    await b.mount(UI + 'qt-listen-detail/qt-listen-detail.uvue', props);
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('listen-play:wyy:first'), true);
    await b.boundary.remote('ok'); assert.deepEqual(played.map(song => song.id), ['first']);
    props.loadingKey = 'wyy:first'; await b.flush(); b.tv.qtTvRefreshFocus();
    assert.equal(b.tv.qtTvFocus('listen-play:wyy:first'), false, 'loading playback is excluded from remote focus');
    assert.equal(b.tv.qtTvFocus('listen-play:wyy:second'), false, 'the original global busy guard also excludes other play actions');
    for (const action of b.byClass('detail-row-icon')) await b.dispatch(action);
    assert.equal(played.length, 1, 'touch dispatch retains the original global playback guard');
    assert.equal(b.tv.qtTvFocus('listen-row:songs:wyy:second'), true, 'busy playback does not prevent browsing the report');
    await b.boundary.remote('ok'); assert.equal(text(first(b, 'detail-title')), '歌曲详情');
    await b.boundary.remote('back'); props.loadingKey = ''; await b.flush();
    assert.equal(b.tv.qtTvFocus('listen-play:wyy:second'), true);
    await b.boundary.remote('ok'); await b.boundary.remote('ok', 1);
    assert.deepEqual(played.map(song => song.id), ['first', 'second']);
    b.tv.qtSetTvMode('touch'); props.loadingKey = 'wyy:second'; await b.flush();
    assert.ok(b.byClass('detail-row-icon').every(node => !String(node.props.class).includes('qt-tv-skip')), 'touch keeps its original rendered controls');
  } finally { await b.close(); }
};

cases['listen-selected-action'] = async () => {
  const b = await listenFixture(); const played = [];
  const props = Vue.reactive({ kind:'songs', target:'wyy:selected', loadingKey:'', onPlay:song => played.push(song) });
  try {
    const stats = b.load('stores/listen-stats.ts').useListenStatsStore();
    await stats.recordProgress({ platform:'wyy', id:'selected', name:'选中的原歌曲', singer:'长河', album:'远方', picUrl:'' }, 90, 1, 0, 1000000);
    await b.mount(UI + 'qt-listen-detail/qt-listen-detail.uvue', props);
    const action = first(b, 'detail-primary');
    assert.equal(action.props['data-qt-tv-id'], 'listen-selected-play', 'selected song keeps a stable explicit primary play target');
    assert.ok(px(b, action, 'min-height') >= 56);
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus('listen-selected-play'));
    await b.boundary.remote('ok'); await b.boundary.remote('ok', 1);
    assert.deepEqual(played.map(song => song.name), ['选中的原歌曲']);
    props.loadingKey = 'wyy:selected'; await b.flush(); b.tv.qtTvRefreshFocus();
    assert.equal(b.tv.qtTvFocus('listen-selected-play'), false, 'busy native primary is excluded without weakening the original play guard');
    await b.dispatch(action); assert.equal(played.length, 1);
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(px(b, first(b, 'detail-play-label'), 'line-height'), 35);
    assert.ok(px(b, action, 'min-height') >= 56);
    props.loadingKey = ''; await b.flush(); b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(action)['min-height'], undefined, 'touch restores the original padded primary action');
  } finally { await b.close(); }
};

cases['listen-body-lines'] = async () => {
  const b = await listenFixture();
  try {
    const stats = b.load('stores/listen-stats.ts').useListenStatsStore();
    const song = { platform:'wyy', id:'body', name:'可浏览的歌曲信息', singer:'长河', album:'远方', picUrl:'' };
    await stats.recordProgress(song, 180, 4, 0, 1000000);
    await b.mount(UI + 'qt-listen-detail/qt-listen-detail.uvue', { kind:'songs', target:'wyy:body', loadingKey:'' });
    const copies = b.byClass('detail-copy'); assert.ok(copies.length >= 6, 'the full actual detail and metrics remain visible');
    for (const copy of copies) {
      assert.equal(px(b, copy, 'font-size'), 20);
      assert.equal(px(b, copy, 'line-height'), 28, 'body lines use the readable TV floor, not the old compact CSS estimate');
    }
    assert.equal(px(b, first(b, 'detail-play-label'), 'line-height'), 28, 'primary action label has its actual TV line box');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const copy of copies) assert.equal(px(b, copy, 'line-height'), 33);
    assert.equal(px(b, first(b, 'detail-play-label'), 'line-height'), 35);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(copies[0])['line-height'], undefined);
    assert.equal(b.css(first(b, 'detail-play-label'))['line-height'], undefined);
  } finally { await b.close(); }
};

cases['listen-trail-pagination'] = async () => {
  const b = await listenFixture(); const played = [];
  try {
    const stats = b.load('stores/listen-stats.ts').useListenStatsStore();
    for (let i = 0; i < 65; i++) await stats.recordProgress({ platform:'wyy', id:'trail-' + i, name:'返回目标' + i, singer:'原歌手', album:'原专辑', picUrl:'' }, 90 + i, 1, 0, 1000000 + i);
    await b.mount(UI + 'qt-listen-detail/qt-listen-detail.uvue', { kind:'songs', target:'', loadingKey:'', onPlay:song => played.push(song) });
    await b.dispatch(b.byClass('seg-item')[1]);
    await b.dispatch(first(b, 'detail-more'));
    assert.equal(b.byClass('detail-row').length, 65);
    const original = b.byClass('detail-row').map(text);
    const lastRow = b.byClass('detail-row').at(-1), focusId = lastRow.props['data-qt-tv-id'];
    assert.equal(b.tv.qtTvFocus(focusId), true); await b.boundary.remote('ok');
    assert.equal(text(first(b, 'detail-title')), '歌曲详情');
    await b.boundary.remote('back');
    assert.equal(b.byClass('detail-row').length, 65, 'TV Back restores the expanded report page containing the focused row');
    assert.deepEqual(b.byClass('detail-row').map(text), original, 'TV Back retains the chosen duration ranking');
    assert.equal(b.tv.qtTvFocusedId(), 'tv:fixture:page:custom:' + focusId);
    const returned = b.byClass('detail-row').find(node => node.props['data-qt-tv-id'] === focusId);
    assert.ok(returned.props.id, 'native reveal has an actual row anchor');
    assert.equal(first(b, 'detail-scroll').props['scroll-into-view'], returned.props.id, 'native viewport reveals the returning row before focus');
    assert.equal(played.length, 0);
    b.tv.qtSetTvMode('touch'); await b.flush();
    await b.dispatch(b.byClass('detail-row')[0]);
    await b.dispatch(b.byClass('detail-icon-button')[0]);
    assert.equal(b.byClass('detail-row').length, 50, 'touch retains the original reset-to-first-page behavior');
    assert.equal(first(b, 'detail-scroll').props['scroll-into-view'] ?? '', '');
  } finally { await b.close(); }
};

cases['listen-detail-history'] = async () => {
  const b = await listenFixture(); let closes = 0;
  const played = [];
  try {
    const stats = b.load('stores/listen-stats.ts').useListenStatsStore();
    const song = { platform:'wyy', id:'nested', name:'同歌手的真实听歌明细', singer:'长河', album:'远方', picUrl:'' };
    await stats.recordProgress(song, 180, 3, 0, 1000000);
    await b.mount(UI + 'qt-listen-detail/qt-listen-detail.uvue', { kind:'artists', target:'', loadingKey:'', onClose:() => closes++, onPlay:s => played.push(s) });
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus('listen-row:artists:长河'));
    await b.boundary.remote('ok'); assert.equal(text(first(b, 'detail-title')), '歌手详情');
    assert.ok(text(first(b, 'detail-identity')).includes('长河'));
    assert.equal(b.byClass('detail-row').length, 1, 'actual reportTracks resolves artist membership');
    assert.ok(b.tv.qtTvFocus('listen-row:songs:wyy:nested')); await b.boundary.remote('ok');
    assert.equal(text(first(b, 'detail-title')), '歌曲详情'); assert.ok(b.text().includes('专辑：远方'));
    await b.boundary.remote('back');
    assert.equal(closes, 0, 'remote Back first follows the existing detail trail rather than closing the report');
    assert.equal(text(first(b, 'detail-title')), '歌手详情');
    assert.equal(b.byClass('detail-row').length, 1);
    assert.equal(b.tv.qtTvFocusedId(), 'tv:fixture:page:custom:listen-row:songs:wyy:nested', 'Back restores the exact song row in the artist report');
    await b.boundary.remote('back'); assert.equal(closes, 0); assert.equal(text(first(b, 'detail-title')), '歌手排行');
    assert.equal(b.tv.qtTvFocusedId(), 'tv:fixture:page:custom:listen-row:artists:长河', 'the second Back restores the artist row');
    await b.boundary.remote('back'); assert.equal(closes, 1); assert.equal(b.boundary.backs(), 0);
    await b.boundary.remote('back', 1); assert.equal(closes, 1);
    assert.equal(played.length, 0, 'browsing and Back never start playback');
  } finally { await b.close(); }
};

export async function runTvSharedChecks(selected = 'all') {
  const entries = selected === 'all' ? Object.entries(cases) : [[selected, cases[selected]]];
  assert.ok(entries.every(([, run]) => typeof run === 'function'));
  for (const [name, run] of entries) { await run(); console.log('PASS TV shared ' + name); }
  console.log('TV shared: ' + entries.length + ' compiled-template groups passed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runTvSharedChecks(process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'all');
