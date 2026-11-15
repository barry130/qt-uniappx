import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tvSettingsFixture } from './check-tv-settings.mjs';
import { listFixture } from './check-tv-list-hosts.mjs';

// Public seams: actual compiled QtUI templates -> actual emit/model/state policies.
// Only window/storage/native data are fixture boundaries; no private handlers are invoked.
const UI = 'uni_modules/qt-ui/components/';
const cases = {};
function first(b, name) { return b.byClass(name)[0]; }
function px(b, node, property) { return Number.parseFloat(b.css(node)[property] ?? '0'); }

cases.button = async () => {
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720 });
  let clicked = 0;
  try {
    await b.mount(UI + 'qt-button/qt-button.uvue', { label: '继续播放', size: 'sm', onClick: () => clicked++ }, false);
    const target = first(b, 'qt-button');
    assert.equal(px(b, target, 'height'), 56, 'TV button has a ten-foot control target');
    assert.ok(px(b, first(b, 'qt-button-label'), 'font-size') >= 20, 'TV labels keep a readable floor');
    await b.dispatch(target);
    assert.equal(clicked, 1, 'actual QtButton activation emits exactly once');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(px(b, target, 'height'), 44, 'touch mode restores the unchanged wide button');
  } finally { await b.close(); }
};

cases.option = async () => {
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720 });
  let selected = 0;
  try {
    await b.mount(UI + 'qt-option/qt-option.uvue', { label: '列表循环', dense: true, selected: true, onSelect: () => selected++ }, false);
    const row = first(b, 'qo');
    assert.equal(px(b, row, 'min-height'), 76, 'TV dense options retain a readable row target');
    assert.ok(px(b, first(b, 'qo-label'), 'font-size') >= 20);
    assert.equal(b.css(first(b, 'qo-label')).color, '#d93c43', 'setting selection remains the established light red, not cyan focus');
    await b.dispatch(row); assert.equal(selected, 1);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(row)['min-height'], undefined, 'normal dense option keeps its existing CSS contract');
  } finally { await b.close(); }
};

cases.confirm = async () => {
  let nativeBacks = 0;
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720,
    boundaryOverrides: { 'services/confirm': undefined, 'services/tv-platform': {
      tvReadDevice: () => ({ television: true, nativeAvailable: true }), tvStartRemote() {}, tvSetRemoteState() {},
      tvStopRemote() {}, tvCollect: () => [], tvHighlight() {}, tvActivate() {}, tvScroll: () => false,
      tvPresent() {}, tvBack: () => nativeBacks++,
    } },
  });
  try {
    await b.mount(UI + 'qt-confirm-host/qt-confirm-host.uvue', {}, false);
    const service = b.load('services/confirm.ts');
    const pending = service.qtConfirm({ title: '清空队列', content: '保留当前播放，仅清空待播列表。', danger: true });
    await b.flush();
    assert.equal(b.tv.qtTvHasModal(), true, 'actual confirmation host owns the TV modal scope');
    assert.equal(b.tv.qtTvDispatchRemote({ key: 'back', code: 4, action: 'down', repeat: 0 }), true);
    assert.equal(await pending, false, 'Back resolves the real confirmation promise as cancel');
    await b.flush();
    assert.equal(b.tv.qtTvHasModal(), false, 'closed modal releases its scope');
    assert.equal(nativeBacks, 0, 'modal Back never exits the page');
    const next = service.qtConfirm({ title: '仅提示', showCancel: false }); await b.flush();
    assert.equal(b.tv.qtTvHasModal(), true, 'reopen registers a fresh active modal');
    await b.dispatch(b.byClass('qc-btn')[0]);
    assert.equal(await next, true, 'actual confirmation button keeps its acceptance meaning');
  } finally { await b.close(); }
};

cases.checkbox = async () => {
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720 });
  let values = [];
  try {
    await b.mount(UI + 'qt-checkbox/qt-checkbox.uvue', { checked: false, size: 'sm', onChange: v => values.push(v) }, false);
    const target = first(b, 'qt-checkbox');
    assert.equal(px(b, target, 'width'), 56, 'TV checkbox exposes a full remote target');
    assert.equal(px(b, target, 'height'), 56);
    await b.dispatch(target); assert.deepEqual(values, [true], 'checkbox emits one selection transition');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(target).width, undefined, 'touch checkbox keeps its existing class sizing');
  } finally { await b.close(); }
};

cases.switch = async () => {
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720 });
  const updates = [], changes = [];
  try {
    await b.mount(UI + 'qt-switch/qt-switch.uvue', { modelValue: false,
      'onUpdate:modelValue': v => updates.push(v), onChange: v => changes.push(v) }, false);
    const target = first(b, 'qsw');
    assert.equal(px(b, target, 'height'), 56, 'TV switch exposes a full remote target');
    assert.equal(px(b, target, 'width'), 96);
    await b.dispatch(target); assert.deepEqual(updates, [true]); assert.deepEqual(changes, [true]);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(target).height, undefined, 'normal switch preserves its class-only sizing');
  } finally { await b.close(); }
};

cases['disabled-controls'] = async () => {
  const changes = [];
  const targets = [
    ['qt-button', 'qt-button', { label: '更新', onClick: () => changes.push('button') }],
    ['qt-option', 'qo', { label: '选项', onSelect: () => changes.push('option') }],
    ['qt-checkbox', 'qt-checkbox', { checked: false, onChange: () => changes.push('checkbox') }],
    ['qt-switch', 'qsw', { modelValue: false, onChange: () => changes.push('switch') }],
  ];
  for (const [name, cls, props] of targets) {
    const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720 });
    try {
      await b.mount(UI + name + '/' + name + '.uvue', { ...props, disabled: true }, false);
      const target = first(b, cls);
      assert.ok(b.byClass('qt-tv-skip').includes(target), name + ' disabled target is excluded from native D-pad candidates');
      await b.dispatch(target);
    } finally { await b.close(); }
  }
  assert.deepEqual(changes, [], 'disabled controls emit no business action');
};

cases['confirm-layer'] = async () => {
  let underlyingBacks = 0;
  const underlying = { fixture: 'queue' };
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720,
    boundaryOverrides: { 'services/confirm': undefined, 'services/tv-platform': {
      tvReadDevice: () => ({ television: true, nativeAvailable: true }), tvStartRemote() {}, tvSetRemoteState() {},
      tvStopRemote() {}, tvCollect: () => [], tvHighlight() {}, tvActivate() {}, tvScroll: () => false,
      tvPresent() {}, tvBack() {},
    } },
  });
  let dispose = null;
  try {
    await b.mount(UI + 'qt-confirm-host/qt-confirm-host.uvue', {}, false);
    dispose = b.tv.qtTvRegisterScope({ root: underlying, active: () => true, modal: true,
      priority: 1400, onBack: () => underlyingBacks++ });
    const service = b.load('services/confirm.ts');
    const pending = service.qtConfirm({ title: '删除待播歌曲', content: '仅删除这一项，不影响当前播放。' });
    await b.flush();
    assert.equal(px(b, first(b, 'qc-mask'), 'z-index'), 3000, 'TV confirmation visually matches its highest modal priority');
    b.tv.qtTvDispatchRemote({ key: 'back', code: 4, action: 'down', repeat: 0 });
    assert.equal(underlyingBacks, 0, 'confirmation Back is handled above the existing queue layer');
    assert.equal(await pending, false, 'the actual confirmation resolves cancel above the queue');
    assert.equal(b.tv.qtTvHasModal(), true, 'the underlying queue remains open');
  } finally { dispose?.(); await b.close(); }
};

cases['icon-density'] = async () => {
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720 });
  try {
    await b.mount(UI + 'qt-icon/qt-icon.uvue', { name: 'more', size: 14 }, false);
    assert.equal(px(b, first(b, 'qt-icon'), 'width'), 24, 'small TV icons have a readable 24px visual floor');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(px(b, first(b, 'qt-icon'), 'width'), 14, 'normal wide icon uses its original public px size');
  } finally { await b.close(); }
};

cases['rich-text-density'] = async () => {
  const links = [];
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720,
    initialStorage: { 'qt-ui-font-scale': 'tiny' },
    boundaryOverrides: { 'services/notice': { openNoticeUrl: href => links.push(href) } },
  });
  const html = '<p>普通正文</p><h2>章节标题</h2><p><span style="font-size:12rpx">作者小字</span></p>'
    + '<ul><li>列表项目</li></ul><p><a href="https://fixture.test/detail">详情链接</a></p><img src="fixture://image">';
  try {
    b.fonts.useFontScaleStore().setTier('tiny');
    await b.mount(UI + 'qt-rich-text/qt-rich-text.uvue', { html, fontSize: 26, color: '#e4e8ec', lineHeight: 1.7 }, false);
    const blocks = b.byClass('qrt-block'), paragraphs = blocks.flatMap(n => n.children).filter(n => n.tag === 'text');
    assert.ok(px(b, paragraphs[0], 'font-size') >= 20, 'TV rich text has a readable floor even at the smallest saved tier');
    const runs = paragraphs.flatMap(n => n.children).filter(n => n.tag === 'text');
    assert.ok(runs.length >= 4, 'the real parser renders plain, heading, authored and linked runs');
    for (const run of [...runs, ...b.byClass('qrt-li-text').flatMap(n => n.children).filter(n => n.tag === 'text')]) {
      assert.ok(px(b, run, 'font-size') >= 20, 'each Vapor run carries its own TV font');
      assert.ok(px(b, run, 'line-height') >= 34, 'each run line follows the actual enlarged font');
    }
    assert.ok(b.byClass('qt-tv-skip').includes(paragraphs[0]), 'inert paragraph tap listeners are not remote business targets');
    const textOf = node => node.text + node.children.map(textOf).join('');
    const link = paragraphs.find(n => textOf(n).includes('详情链接'));
    assert.ok(!b.byClass('qt-tv-skip').includes(link), 'the real link remains reachable');
    await b.dispatch(link); assert.deepEqual(links, ['https://fixture.test/detail'], 'the real rich-text link activates once');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(px(b, paragraphs[0], 'font-size'), 15.3, 'touch restores the existing wide rich-text font');
    assert.equal(b.css(paragraphs[0].children[0])['font-size'], undefined, 'touch run markup remains unchanged');
  } finally { await b.close(); }
};

cases['option-chip-density'] = async () => {
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720 });
  const choices = [];
  try {
    await b.mount(UI + 'qt-option/qt-option.uvue', { label: '流行', kind: 'chip', singleLine: true,
      selected: true, onSelect: () => choices.push('流行') }, false);
    const chip = first(b, 'qo');
    assert.equal(px(b, chip, 'min-height'), 56, 'TV chips expose the same full remote target as buttons');
    const metrics = b.load('uni_modules/qt-ui/composables/qt-option-metrics.ts');
    assert.equal(metrics.qtOptionChipMinHeightPx(), 56, 'host chip rows use the actual TV target floor');
    assert.equal(metrics.qtOptionChipWidthPx('流行'), 90, 'ordinary wrapping chip width includes TV font, padding and border');
    assert.equal(metrics.qtOptionChipWidthPx('流行', true), 92, 'singleLine hosts reserve the same semibold glyph budget as rendered chips');
    await b.dispatch(chip); assert.deepEqual(choices, ['流行']);
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.ok(px(b, chip, 'min-height') >= 56);
    assert.equal(metrics.qtOptionChipWidthPx('流行'), 102, 'large TV fonts also increase ordinary host width estimates');
    assert.equal(metrics.qtOptionChipWidthPx('流行', true), 106, 'huge no-wrap hosts also budget semibold glyphs without clipping');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(metrics.qtOptionChipWidthPx('流行'), 77, 'touch restores the existing huge wide chip width');
    assert.equal(b.css(chip)['padding-left'], undefined);
  } finally { await b.close(); }
};

cases['option-card-density'] = async () => {
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720 });
  let selections = 0;
  try {
    await b.mount(UI + 'qt-option/qt-option.uvue', { label: '纯净歌词', description: '突出当前歌词',
      kind: 'card', onSelect: () => selections++ }, false);
    const card = first(b, 'qo');
    assert.equal(px(b, card, 'min-height'), 76, 'TV option cards budget two readable text lines');
    assert.ok(px(b, first(b, 'qo-label'), 'line-height') >= 27);
    assert.ok(px(b, first(b, 'qo-description'), 'line-height') >= 28);
    await b.dispatch(card); assert.equal(selections, 1);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(card)['min-height'], undefined, 'touch option cards preserve their content-driven size');
    assert.equal(b.css(first(b, 'qo-description'))['line-height'], undefined);
  } finally { await b.close(); }
};

cases['sheet-density'] = async () => {
  const b = await tvSettingsFixture({ savedMode: 'tv', width: 1280, height: 720 });
  let closed = 0;
  try {
    await b.mount(UI + 'qt-sheet/qt-sheet.uvue', { visible: true, title: '选择收藏歌单', subtitle: '点确定保存歌曲', onClose: () => closed++ }, false);
    const close = first(b, 'qs-close');
    assert.equal(px(b, close, 'width'), 56, 'TV sheet close has the common full remote target');
    assert.equal(px(b, close, 'height'), 56);
    assert.ok(px(b, first(b, 'qs-title'), 'line-height') >= 30);
    assert.ok(px(b, first(b, 'qs-subtitle'), 'line-height') >= 28);
    await b.dispatch(close); assert.equal(closed, 1, 'sheet close emits once despite its mask parent');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(close).height, undefined, 'touch restores original 36px class');
  } finally { await b.close(); }
};

cases['confirm-density'] = async () => {
  const b = await listFixture({ savedMode: 'tv', width: 1280, height: 720,
    boundaryOverrides: { 'services/confirm': undefined } });
  try {
    await b.mount(UI + 'qt-confirm-host/qt-confirm-host.uvue', {}, false);
    const pending = b.load('services/confirm.ts').qtConfirm({ title: '清空播放历史', content: '这是包含很长地址的完整详情。'.repeat(70) });
    await b.flush();
    assert.equal(px(b, first(b, 'qc-card'), 'width'), 560, 'TV confirmation has a readable dialog width, not the phone-sized 320px card');
    for (const button of b.byClass('qc-btn')) assert.equal(px(b, button, 'height'), 56);
    assert.ok(b.byClass('qt-tv-scroll').includes(first(b, 'qc-content-scroll')), 'long confirmation prose is a readonly remote scroll target');
    assert.ok(px(b, first(b, 'qc-content'), 'line-height') >= 29);
    b.fonts.useFontScaleStore().setTier('huge'); b.setWindow({ windowWidth: 480, windowHeight: 360 }); await b.clock.runTimers(1000); await b.flush();
    assert.equal(px(b, first(b, 'qc-card'), 'width'), 424, 'short TV window retains 28px horizontal dialog gutters');
    const viewport = px(b, first(b, 'qc-content-scroll'), 'max-height');
    assert.ok(viewport >= 80 && viewport <= 180, 'large short-window body stays readable and leaves the fixed buttons on screen');
    const title = first(b, 'qc-title'), body = first(b, 'qc-content-scroll'), buttons = first(b, 'qc-btns');
    const titleLine = px(b, title, 'line-height');
    assert.ok(titleLine >= 39, 'huge TV confirmation title has a real enlarged line box');
    const fixed = 2 * titleLine + (px(b, title, 'margin-top') || 22) + (px(b, body, 'margin-top') || 11)
      + (px(b, body, 'margin-bottom') || 20) + (px(b, buttons, 'margin-top') || 20) + 56 + 2;
    assert.ok(viewport + fixed <= 328, 'two-line title, full content viewport, fixed buttons and vertical gutters all fit the 360px TV window');
    await b.dispatch(b.byClass('qc-btn')[0]); assert.equal(await pending, false);
    b.tv.qtSetTvMode('touch'); await b.flush();
    const second = b.load('services/confirm.ts').qtConfirm({ title: '触控确认', content: '原有布局' }); await b.flush();
    assert.equal(px(b, first(b, 'qc-card'), 'width'), 384, 'narrow touch restores the original responsive 600rpx card');
    assert.equal(b.css(first(b, 'qc-btn')).height, undefined);
    b.load('services/confirm.ts').qtConfirmResolve(false); assert.equal(await second, false);
  } finally { await b.close(); }
};

cases['swatch-target'] = async () => {
  const b = await listFixture({ savedMode: 'tv', width: 1280, height: 720 });
  let selected = 0;
  try {
    await b.mount(UI + 'qt-option/qt-option.uvue', { label: '珊瑚红', kind: 'swatch', selected: true, indicator: true, onSelect: () => selected++ }, false);
    const target = first(b, 'qo');
    assert.equal(px(b, target, 'width'), 56, 'TV color swatch keeps the shared remote target');
    assert.equal(px(b, target, 'height'), 56);
    await b.dispatch(target); assert.equal(selected, 1);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(target).width, undefined, 'normal swatch retains its original 42px CSS');
  } finally { await b.close(); }
};

cases['action-sheet-target'] = async () => {
  const b = await listFixture({ savedMode: 'tv', width: 480, height: 360 });
  const picked = [], closed = [];
  try {
    await b.mount(UI + 'qt-action-sheet/qt-action-sheet.uvue', { visible: true, title: '选择操作',
      actions: [{ name: '播放' }, { name: '删除', disabled: true }], selectedIndex: 0,
      onSelect: (action, index) => picked.push(index), onClose: () => closed.push(true) }, false);
    const cancel = first(b, 'as-cancel');
    assert.equal(px(b, cancel, 'height'), 56, 'shared TV menu cancellation has a full-size remote target');
    assert.equal(cancel.props['data-qt-tv-id'], 'action-sheet-cancel');
    const options = b.byClass('qo');
    await b.dispatch(options[1]); assert.deepEqual(picked, [], 'disabled real options retain their business guard');
    await b.dispatch(options[0]); assert.deepEqual(picked, [0], 'menu selection emits once');
    await b.dispatch(cancel); assert.deepEqual(closed, [true]);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(first(b, 'as-cancel')).height, undefined, 'normal wide cancellation retains the original 48px CSS');
  } finally { await b.close(); }
};

cases['action-sheet-budget'] = async () => {
  const b = await listFixture({ savedMode: 'tv', width: 480, height: 720 });
  try {
    await b.mount(UI + 'qt-action-sheet/qt-action-sheet.uvue', { visible: true, title: '选择操作',
      actions: [{ name: '播放' }, { name: '收藏到歌单' }] }, false);
    assert.equal(px(b, first(b, 'as-list'), 'height'), 154, 'unmeasured TV menu budgets both actual 76px rows and divider pixels');
    b.fonts.useFontScaleStore().setTier('huge');
    b.setWindow({ windowWidth: 480, windowHeight: 360 }); await b.clock.runTimers(1000); await b.flush();
    const height = px(b, first(b, 'as-list'), 'height');
    assert.ok(height >= 80 && height <= 152, 'short huge TV menus retain scroll room after the actual header and full cancel');
    assert.equal(first(b, 'as-list').props['data-qt-tv-id'], 'action-sheet-list');
    const optionIds = b.byClass('qo').map(node => node.props['data-qt-tv-id']);
    assert.deepEqual(optionIds, ['action-sheet-item:0', 'action-sheet-item:1']);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(px(b, first(b, 'as-list'), 'height') < 154, true, 'ordinary menu restores its original wrapped estimates');
  } finally { await b.close(); }
};

cases['playlist-picker-fields'] = async () => {
  const created = [], saved = [], updates = [];
  const playlists = [{ id: 'mix-a', name: '常听', picUrl: '' }, { id: 'mix-b', name: '晚间', picUrl: '' }];
  const b = await listFixture({ savedMode: 'tv', width: 1280, height: 720 });
  try {
    await b.mount(UI + 'qt-playlist-picker/qt-playlist-picker.uvue', { visible: true, song: {}, playlists,
      selectedIds: ['mix-b'], createPlaylist: name => { created.push(name); return { id: 'new-mix', name, picUrl: '' }; },
      onConfirm: ids => saved.push(ids), 'onUpdate:visible': value => updates.push(value) }, false);
    const input = first(b, 'picker-new-input');
    assert.equal(px(b, input, 'height'), 56, 'TV playlist creation field is reachable at the common remote target size');
    assert.equal(input.props['data-qt-tv-id'], 'playlist-picker-name');
    assert.notEqual(input.props.focus, true, 'picker opens in navigation mode, not IME mode');
    await b.dispatch(input, 'input', { detail: { value: '常听' } });
    await b.dispatch(b.button('新建')); assert.deepEqual(created, [], 'duplicate-name guard remains real');
    assert.ok(b.text().includes('已有同名歌单'));
    await b.dispatch(input, 'input', { detail: { value: '  新歌单  ' } });
    await b.dispatch(b.button('新建')); assert.deepEqual(created, ['新歌单']);
    await b.dispatch(b.option('常听')); await b.dispatch(b.button('确定'));
    assert.deepEqual(b.plain(saved), [['mix-b', 'new-mix', 'mix-a']], 'ordinary picker only confirms its actual draft once');
    assert.deepEqual(updates, [false]);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(input).height, undefined, 'touch picker retains the original 44px class height');
  } finally { await b.close(); }
};

cases['playlist-picker-budget'] = async () => {
  const playlists = Array.from({ length: 12 }, (_, i) => ({ id: 'mix-' + i, name: '歌单 ' + i, picUrl: '' }));
  const b = await listFixture({ savedMode: 'tv', width: 480, height: 360 });
  try {
    await b.mount(UI + 'qt-playlist-picker/qt-playlist-picker.uvue', { visible: true, song: {}, playlists,
      selectedIds: ['mix-8'], createPlaylist: () => null }, false);
    const list = first(b, 'picker-list');
    assert.ok(px(b, list, 'height') >= 64, 'short TV picker retains a usable native scroll viewport after its header, create row and footer');
    assert.ok(px(b, list, 'height') <= 72, 'short TV picker reserves all actual fixed line and control boxes');
    assert.equal(list.props['data-qt-tv-id'], 'playlist-picker-list');
    assert.ok(String(list.props.class).includes('qt-tv-scroll'));
    await b.clock.runTimers(200); await b.flush();
    assert.ok(String(list.props['scroll-into-view']).length > 0, 'opening reveals the real selected playlist');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.ok(px(b, list, 'height') >= 32 && px(b, list, 'height') <= 64, 'huge text budgets both actual subtitle and title lines without consuming the viewport');
    b.setWindow({ windowWidth: 1280, windowHeight: 720 }); await b.clock.runTimers(1000); await b.flush();
    assert.equal(px(b, list, 'height'), 300, 'larger TV window restores the original preferred viewport cap');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.ok(Math.abs(px(b, list, 'height') - 259.2) < 0.001, 'same mounted normal wide picker keeps its original huge-font available budget');
  } finally { await b.close(); }
};

cases['button-line-budget'] = async () => {
  const b = await listFixture({ savedMode:'tv', width:480, height:360 });
  try {
    await b.mount(UI + 'qt-button/qt-button.uvue', { label:'保存配置', size:'sm' });
    const label = first(b, 'qt-button-label');
    assert.equal(px(b, label, 'line-height'), 27, 'TV small button line box follows the worked 20px font floor × 1.35 example');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(px(b, label, 'line-height'), 35, 'TV button huge font receives a matching line box inside 56px target');
    assert.equal(px(b, first(b, 'qt-button'), 'height'), 56);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(label)['line-height'], undefined, 'touch button text retains its original rendering contract');
  } finally { await b.close(); }
};

export async function runTvUiChecks(selected = 'all') {
  const entries = selected === 'all' ? Object.entries(cases) : [[selected, cases[selected]]];
  assert.ok(entries.every(([, run]) => typeof run === 'function'), 'known public TV UI case');
  for (const [name, run] of entries) { await run(); console.log('PASS TV UI ' + name); }
  console.log('TV UI: ' + entries.length + ' compiled-template groups passed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runTvUiChecks(process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'all');
}
