// Task-29 seam: complete compiled production pages/QtUI -> public native events
// and remote keys -> real stores/services. Only SDK, native transport, network,
// files, clock/lifecycle and navigation boundaries vary. Sibling fixture is read-only.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { toRaw } from 'vue';
import { listFixture } from './check-tv-list-hosts.mjs';

const noop = () => {};
const walk = node => node == null ? [] : [node, ...(node.children ?? []).flatMap(walk)];
const hasClass = (node, name) => String(node.props.class ?? '').split(/\s+/).includes(name);
const text = node => node.text + (node.children ?? []).map(text).join('');
const plain = value => JSON.parse(JSON.stringify(value));
const song = (id, name = id) => ({ id, platform:'local', name, singer:'验证歌手', album:'验证专辑', picUrl:'', url:'file:///fixture/' + id + '.mp3', duration:180 });
const nativeId = node => 'tv:fixture:page:custom:' + (node.props['data-qt-tv-id'] ?? node.props.id ?? node.fixtureId);
const clickable = handler => typeof handler === 'function' || Array.isArray(handler);

async function secondaryFixture(options = {}) {
  let b;
  const ownedNativeCalls = [], scrollCalls = [], clipboard = [], snapshots = [], shareCalls = [], candidateCollections = [];
  const sdk = {
    publicDataDir:() => '', dataDir:() => '/owned-fixture', queryPermissionStates:ids => ids.map(id => ({ id, applicable:true, granted:true, unknown:false })),
    statLocalFile:() => -1, readEmbeddedTags:() => null,
    readTextFile:(_path, reply) => reply(false, '', 'owned file absent'),
    exists:(_path, reply) => reply(true, '0', ''), start:() => false, isRunning:() => false, isHealthy:() => false,
    restoreCustomDir:noop, setCustomDirUri:uri => ownedNativeCalls.push({ name:'customDir', uri }),
    pickDirectory(reply) { ownedNativeCalls.push({ name:'pickDirectory' }); reply(options.directory ?? { ok:true, path:'/public/selected', name:'已选目录', message:'' }); },
    queryPermissionStatesAsync(ids, reply) { reply(sdk.queryPermissionStates(ids)); },
    openPermissionSettings(id) { ownedNativeCalls.push({ name:'permissionSettings', id }); return options.settingsSupported !== false; },
    openExternalUrl(url) { ownedNativeCalls.push({ name:'external', url }); return true; },
    isIgnoringBatteryOptimizations:() => true,
    openBatteryOptimizationSettings() { ownedNativeCalls.push({ name:'battery' }); return true; },
    openAutoStartSettings() { ownedNativeCalls.push({ name:'autoStart' }); return true; },
    pickJsFile(reply) { ownedNativeCalls.push({ name:'pickJsFile' }); reply(options.pickedFile ?? { ok:false, name:'', content:'', message:'' }); },
    ...(options.nativeSdk ?? {}),
  };
  const collect = root => {
    // Native collectTvCandidates keeps the first element for each page+custom ID.
    // Preserve that SDK behavior so two rendered instances cannot hide a collision.
    const seen = new Set();
    const candidates = walk(toRaw(root)).filter(node => !hasClass(node, 'qt-tv-skip') &&
    (node.props['data-qt-tv-id'] || node.props.id || clickable(node.props.onClick) || clickable(node.props.onLongpress) || hasClass(node, 'qt-tv-scroll'))).map((node, index) => {
      node.fixtureId ??= 'sdk-' + index;
      let list = node; while (list && list.tag !== 'list-view' && list.tag !== 'scroll-view') list = list.parent;
      return { id:nativeId(node), left:30 + (index % 4) * 160, top:50 + Math.floor(index / 4) * 96, width:140, height:76,
        visible:true, enabled:true, input:node.tag === 'input', longPress:clickable(node.props.onLongpress), scrollGroup:list ? nativeId(list) : '' };
    }).filter(candidate => { if (seen.has(candidate.id)) return false; seen.add(candidate.id); return true; });
    candidateCollections.push(candidates);
    return candidates;
  };
  const tvPlatform = {
    tvReadDevice:() => ({ television:false, nativeAvailable:false, leanback:false }),
    tvStartRemote:noop, tvSetRemoteState:noop, tvStopRemote:noop, tvHighlight:noop, tvPresent:noop, tvBack:noop,
    tvCollect:collect,
    tvScroll(id, direction, amount) { scrollCalls.push({ id, direction, amount }); return true; },
    tvActivate(id, longPress) {
      const target = walk(b.root).find(node => nativeId(node) === id);
      assert.ok(target, 'public native focus target still exists');
      return b.dispatch(target, longPress ? 'longpress' : 'click');
    },
  };
  b = await listFixture({ ...options, realFrame:true, boundaryOverrides:{
    'uni_modules/qt-js-engine':sdk, 'uni_modules/qt-app-native':sdk,
    'services/tv-platform':tvPlatform, 'services/music-api':undefined,
    'services/diag':{ qtDiag:noop, qtDiagDebug:noop },
    ...(options.boundaryOverrides ?? {}),
  } });
  b.setSdk({ getClipboardData:({ success }) => success?.({ data:options.clipboard ?? '' }),
    setClipboardData:({ data, success }) => { clipboard.push(data); success?.({}); },
    getStorageInfoSync:() => ({ keys:[...b.storage.keys()] }),
    reLaunch:options => b.routes.push({ action:'reLaunch', ...options }),
    shareWithSystem:request => { shareCalls.push(request); request.success?.({}); },
    getElementById:id => { const node = walk(b.root).find(node => node.props.id === id); if (!node) return null;
      return { takeSnapshot(request) { snapshots.push({ id, request }); options.snapshotReply?.(request); } }; },
  });
  const restoredCompilerBindings = [];
  if (options.loggerUts === true) {
    // SDK compiler boundary only: the frozen Node loader leaves .uts JSON plain.
    // Keep the complete real logger/fsList/logBytes implementation and byte sum.
    const http = b.load('services/http.ts'), logger = b.load('services/logger.uts');
    const json = logger.isLogDebug.constructor('return JSON')();
    const descriptor = Object.getOwnPropertyDescriptor(json, 'parse');
    assert.notEqual(json, http.parseJsonToUtso.constructor('return JSON')(), 'logger-only UTS JSON realm is distinct from the real HTTP parser realm');
    assert.equal(typeof descriptor.value, 'function');
    Object.defineProperty(json, 'parse', { ...descriptor, value:value => http.parseJsonToUtso(value) });
    const sample = json.parse('[{"name":"native.log","size":4096,"dir":false,"nested":{"enabled":true}}]');
    assert.equal(Array.isArray(sample), true, 'UTS JSON compatibility preserves native arrays');
    assert.equal(sample[0].get('name'), 'native.log'); assert.equal(sample[0].get('size'), 4096);
    assert.equal(sample[0].get('dir'), false); assert.equal(sample[0].get('nested').get('enabled'), true);
    const close = b.close;
    b.close = async () => { try { await close(); } finally {
      Object.defineProperty(json, 'parse', descriptor);
      assert.deepEqual(Object.getOwnPropertyDescriptor(json, 'parse'), descriptor, 'exact original logger JSON.parse descriptor is restored even on test failure');
      restoredCompilerBindings.push('logger-json');
    } };
  }
  return { ...b, ownedNativeCalls, scrollCalls, clipboard, snapshots, shareCalls, candidateCollections, restoredCompilerBindings,
    downloads:b.load('stores/downloads.ts').useDownloadsStore(),
    focus:async node => { assert.ok(node, 'focused public node exists'); b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus(nativeId(node)), true); await b.flush(); },
    remote:async (key, repeat = 0) => { b.tv.qtTvDispatchRemote({ key, action:'down', repeat }); await b.flush(); },
  };
}

async function downloadSettingsCase() {
  const b = await secondaryFixture({ width:1920, height:1080 });
  try {
    await b.mount('pages/download-settings/index.uvue');
    const cells = b.byClass('cell');
    assert.equal(cells.length, 7, 'original seven download settings remain visible without a custom directory');
    assert.equal(b.css(cells[0])['min-height'], '76px', 'TV download settings reserve a readable remote row while allowing long labels to grow');
    assert.ok(b.byClass('list').some(node => hasClass(node, 'qt-tv-scroll')), 'settings scroll is an explicit public TV target');
    const nameCell = b.cell('下载文件名格式');
    assert.equal(nameCell.props['data-qt-tv-id'], 'download-settings:name', 'file-name control keeps a stable semantic identity');
    for (const [label, id] of [['保存位置','directory'],['同时下载数','concurrency'],['同时下载封面','cover'],['同时下载歌词','lyric'],['下载存储方式','storage'],['删除记录时同时删除文件','delete-file']]) {
      const cell = b.byClass('cell').find(node => walk(node).some(child => (hasClass(child, 'cell-title') || hasClass(child, 'directory-title')) && text(child) === label));
      assert.ok(cell, 'real original download action is rendered: ' + label);
      assert.equal(cell.props['data-qt-tv-id'], 'download-settings:' + id, 'original download action stable identity: ' + label);
    }
    for (const node of b.byClass('cell-title').concat(b.byClass('directory-title'))) assert.equal(b.css(node)['line-height'], '31px', 'original download setting label gets a native actual-font line');
    for (const node of b.byClass('cell-value').concat(b.byClass('directory-value'))) assert.equal(b.css(node)['line-height'], '26px');
    await b.focus(b.cell('同时下载数')); await b.remote('ok');
    assert.deepEqual(b.byClass('qo-label').map(text), ['1 个','2 个'], 'original concurrency selector retains only its existing one/two limits');
    await b.dispatch(b.option('2 个')); assert.equal(b.downloads.concurrency, 2);
    await b.focus(nameCell); await b.remote('ok');
    assert.ok(b.option('歌名 - 歌手'), 'remote OK opens the original QtActionSheet choices');
    await b.dispatch(b.option('歌名 - 歌手'));
    assert.equal(b.downloads.downloadNameFormat, 'song', 'public selection persists through the real download store');
    const cover = b.cell('同时下载封面');
    await b.focus(cover); const before = b.downloads.downloadCover;
    await b.remote('ok', 1); assert.equal(b.downloads.downloadCover, before, 'repeated OK performs no second toggle');
    await b.remote('ok'); assert.equal(b.downloads.downloadCover, !before, 'one remote row click toggles once');
    await b.dispatch(walk(cover).find(node => hasClass(node, 'qsw')));
    assert.equal(b.downloads.downloadCover, before, 'shared switch stops bubbling and calls the original handler once');
    const hint = b.byClass('hint-text')[0];
    assert.equal(b.css(hint)['line-height'], '26px', 'TV explanatory copy has an explicit 20px-font line box');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(b.css(b.byClass('hint-text')[0])['line-height'], '29px', 'largest font tier recomputes the explanatory line box');
    for (const node of b.byClass('cell-title').concat(b.byClass('directory-title'))) assert.equal(b.css(node)['line-height'], '40px');
    for (const node of b.byClass('cell-value')) assert.equal(b.css(node)['line-height'], '33px');
    for (const node of b.byClass('directory-value')) assert.equal(b.css(node)['line-height'], '31px');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush();
    assert.equal(b.css(b.byClass('cell')[0]).height, undefined, 'same mounted touch page restores original CSS row geometry');
    assert.equal(b.css(b.byClass('hint-text')[0])['line-height'], undefined, 'touch explanatory line box returns to original CSS');
    for (const cls of ['cell-title','cell-value','directory-title','directory-value']) for (const node of b.byClass(cls)) assert.equal(b.css(node)['line-height'], undefined, 'same-mounted touch download ' + cls + ' restores original CSS');
    await b.dispatch(b.cell('下载文件名格式'));
    await b.dispatch(b.option('歌手 - 歌名'));
    assert.equal(b.downloads.downloadNameFormat, 'artist', 'touch original selection still commits exactly the original value');
  } finally { await b.close(); }
}

async function playerBarCase() {
  const b = await secondaryFixture({ width:1920, height:1080 });
  try {
    await b.mount('pages/player-bar/index.uvue');
    const store = b.load('stores/player-bar.ts').usePlayerBarStore();
    const cell = b.byClass('cell').find(node => walk(node).some(child => hasClass(child, 'qsw')));
    assert.ok(cell, 'real player-bar settings render the original toggle controls');
    assert.equal(b.css(cell)['min-height'], '76px', 'TV player-bar settings reserve a readable growing row');
    assert.ok(String(cell.props['data-qt-tv-id']).startsWith('player-bar:tool:'), 'bar tool focus uses the real tool identity');
    const label = walk(cell).find(node => hasClass(node, 'cell-title'));
    assert.equal(b.css(label)['line-height'], '31px', 'TV setting labels receive actual-font line boxes');
    assert.equal(b.css(b.byClass('hint-text')[0])['line-height'], '26px', 'TV player-tool explanation reserves its actual 20px floor');
    assert.equal(b.css(b.byClass('cell-value')[0])['line-height'], '26px', 'TV long tool-count summary grows with a readable line box');
    assert.equal(b.cell('恢复默认展示').props['data-qt-tv-id'], 'player-bar:reset', 'reset remains the original action with a stable identity');
    const before = plain(store.visible);
    await b.focus(cell); await b.remote('ok');
    assert.notDeepEqual(plain(store.visible), before, 'remote OK uses the original real-store toggle');
    await b.remote('ok', 1);
    const after = plain(store.visible);
    await b.dispatch(walk(cell).find(node => hasClass(node, 'qsw')));
    assert.notDeepEqual(plain(store.visible), after, 'shared switch click remains exactly one isolated toggle');
    assert.equal(b.cell('播放链接'), undefined, 'non-admin page still excludes the original protected tool control while retaining its explanatory copy');
    await b.dispatch(b.cell('恢复默认展示'));
    assert.ok(b.toastCalls.some(call => call.title === '已恢复默认展示'), 'original reset feedback is retained');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(b.css(b.byClass('hint-text')[0])['line-height'], '29px', 'huge explanatory text reserves the actual enlarged line');
    assert.equal(b.css(b.byClass('cell-value')[0])['line-height'], '33px', 'huge tool-count summary receives its actual 25.2px-font line');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush();
    assert.equal(b.css(b.byClass('cell')[0])['min-height'], undefined, 'touch restores the original fixed CSS rows');
    assert.equal(b.css(b.byClass('cell-title')[0])['line-height'], undefined, 'touch restores the original text line boxes');
    assert.equal(b.css(b.byClass('hint-text')[0])['line-height'], undefined, 'touch preserves the original explanatory CSS line');
    assert.equal(b.css(b.byClass('cell-value')[0])['line-height'], undefined, 'touch preserves the original summary CSS line');
  } finally { await b.close(); }
}

async function sourcePackCase() {
  const b = await secondaryFixture({ width:1280, height:720 });
  try {
    await b.mount('pages/source-pack/index.uvue');
    assert.ok(b.byClass('pack-scroll').some(node => hasClass(node, 'qt-tv-scroll')), 'source management exposes its original readonly scrolling surface to the remote');
    assert.equal(b.byClass('guide-banner')[0].props['data-qt-tv-id'], 'source-pack:guide'); assert.equal(b.css(b.byClass('guide-banner')[0])['min-height'], '76px');
    for (const [label,id] of [['从链接安装','install-url'],['从本地文件安装','install-file'],['检查更新','check']]) assert.equal(b.button(label).props['data-qt-tv-id'], 'source-pack:' + id);
    for (const [cls,line] of [['guide-banner-title','27px'],['guide-banner-tag','26px'],['guide-banner-sub','26px'],['guide-banner-cta-text','26px'],['status-key','26px'],['status-value','26px'],['pack-empty-text','26px'],['check-hint','26px'],['install-hint','26px']]) for (const node of b.byClass(cls)) assert.equal(b.css(node)['line-height'],line,'original source ' + cls + ' actual glyphs reserve native lines');
    await b.focus(b.byClass('guide-banner')[0]); await b.remote('ok'); assert.deepEqual(b.ownedNativeCalls.filter(call => call.name === 'external').map(call => call.url), [b.load('services/official-site.ts').OFFICIAL_SOURCE_SETUP_URL], 'one original tutorial action still uses its existing system-browser SDK boundary');
    await b.dispatch(b.button('从链接安装'));
    const input = b.byClass('url-input')[0];
    assert.ok(input, 'the complete original URL sheet renders its real input');
    assert.equal(input.props.focus, false, 'TV opening a URL sheet does not automatically summon the system IME');
    assert.equal(input.props['data-qt-tv-id'], 'source-pack:url', 'source URL retains an explicit semantic native focus identity');
    assert.equal(b.css(input).height, '56px', 'TV URL input has the original capability in a 56px target');
    await b.dispatch(input, 'input', { value:'http://fixture.example/pack.js' });
    await b.dispatch(b.button('下载并校验'));
    assert.ok(b.text().includes('只支持 https://'), 'public input and submit retain the real original HTTPS validation');
    assert.equal(b.css(b.byClass('url-error')[0])['line-height'],'26px');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const [cls,line] of [['guide-banner-title','36px'],['guide-banner-tag','26px'],['guide-banner-sub','29px'],['guide-banner-cta-text','29px'],['status-key','33px'],['status-value','33px'],['pack-empty-text','33px'],['check-hint','29px'],['install-hint','29px'],['url-error','29px']]) for (const node of b.byClass(cls)) assert.equal(b.css(node)['line-height'],line,'huge source ' + cls + ' keeps the original copy legible');
    assert.equal(b.ownedNativeCalls.filter(call => call.name === 'pickJsFile').length, 0, 'URL validation does not fabricate local file access');
    await b.dispatch(b.button('取消')); assert.equal(b.byClass('url-input').length, 0, 'original cancel dismisses the sheet without an installation');
    await b.dispatch(b.button('从本地文件安装'));
    assert.equal(b.ownedNativeCalls.filter(call => call.name === 'pickJsFile').length, 1, 'file entry still invokes the real native picker adapter once');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush();
    await b.dispatch(b.button('从链接安装'));
    assert.equal(b.byClass('url-input')[0].props.focus, true, 'touch preserves original automatic input focus');
    assert.notEqual(b.css(b.byClass('url-input')[0]).height, '56px', 'touch input returns to its original native CSS geometry');
    assert.equal(b.css(b.byClass('guide-banner')[0])['min-height'],undefined);
    for (const cls of ['guide-banner-title','guide-banner-tag','guide-banner-sub','guide-banner-cta-text','status-key','status-value','pack-empty-text','check-hint','install-hint']) for (const node of b.byClass(cls)) assert.equal(b.css(node)['line-height'],undefined,'same-mounted touch source ' + cls + ' remains original');
    await b.dispatch(b.button('取消'));
  } finally { await b.close(); }
}

async function dislikesCase() {
  const b = await secondaryFixture({ width:1280, height:720 });
  try {
    const store = b.load('stores/dislikes.ts').useDislikesStore();
    store.banSong(song('one', '第一条屏蔽')); store.banSinger('独立歌手');
    await b.mount('pages/dislikes/index.uvue');
    const rows = b.byClass('rule'); assert.equal(rows.length, 2, 'real dislikes store exposes both original rule kinds');
    assert.equal(b.css(rows[0]).height, '76px', 'TV two-line dislike rules use the shared readable row budget');
    assert.ok(b.byClass('scroll').some(node => hasClass(node, 'qt-tv-scroll')), 'native dislike list is an explicit TV scroll target');
    const removal = walk(rows[0]).find(node => clickable(node.props.onClick));
    assert.ok(removal, 'the original public trash operation is present');
    assert.equal(b.css(removal).width, '56px', 'TV per-rule removal is a 56px target without changing its confirmation contract');
    assert.equal(removal.props['data-qt-tv-id'], 'dislikes:remove:' + store.rules[0].id, 'rule action focus uses the stable real rule identity');
    await b.focus(removal); await b.remote('ok', 1); assert.equal(store.rules.length, 2, 'held OK does not remove a rule');
    await b.remote('ok'); assert.equal(store.rules.length, 1, 'one public remote click directly removes one original rule');
    assert.equal(b.byClass('qc-panel').length, 0, 'single rule removal retains the original no-confirmation behavior');
    const clear = () => b.byClass('clear-link')[0];
    assert.equal(b.css(clear()).height, '56px', 'clear-all retains its text control with a full TV target');
    assert.equal(b.css(clear())['min-width'], '56px');
    assert.equal(clear().props['data-qt-tv-id'], 'dislikes:clear');
    assert.equal(b.css(b.byClass('kind-text')[0])['line-height'], '26px', 'TV rule-kind text has a readable line box');
    assert.equal(b.css(b.byClass('kind-badge')[0])['min-height'], '40px', 'kind badge stays above its 26px readable glyph budget');
    await b.dispatch(clear()); assert.equal(store.rules.length, 1, 'clear-all remains confirmation-gated');
    await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '取消')); assert.equal(store.rules.length, 1);
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(b.css(b.byClass('rule')[0]).height, '91px', 'huge TV rule rows keep both enlarged text lines');
    assert.equal(b.css(b.byClass('kind-badge')[0])['min-height'], '40px', 'kind badge stays above its 31px huge glyph budget');
    assert.equal(b.css(b.byClass('kind-text')[0])['line-height'], '31px');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush();
    assert.equal(b.css(b.byClass('rule')[0]).height, undefined, 'same-mounted touch rules restore original native CSS sizing');
    assert.equal(b.css(clear()).height, undefined); assert.equal(b.css(b.byClass('kind-badge')[0])['min-height'], undefined);
    await b.dispatch(clear()); await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '清空'));
    assert.equal(store.rules.length, 0, 'original touch clear-all confirmation still clears the real store');
    assert.ok(b.text().includes('还没有屏蔽任何歌曲或歌手'), 'original empty rule guidance remains');
  } finally { await b.close(); }
}

async function userCase() {
  const requests = [], uid = 'tv-user';
  const initialStorage = {
    'qt-access-token':'user-token', 'qt-refresh-token':'refresh-token', 'qt-token-expiry':9000000000, 'qt-user-id':uid,
    ['qt-user-me:' + uid]:JSON.stringify({ user:{ nickname:'电视用户', email:'tv@example.invalid', avatar:'' }, roles:['APP_USER'], permissions:[] }),
    ['qt-liked-songs:' + uid]:JSON.stringify([JSON.stringify({ ...song('kept', '保留收藏'), platform:'wyy' })]),
    ['qt-like-pending-ops:' + uid]:JSON.stringify([JSON.stringify({ type:'song', action:'add', dataJson:JSON.stringify({ sid:'kept', platform:'wyy', name:'保留收藏' }) })]),
    ['qt-like-cursor:' + uid]:'37', 'qt-downloads':'[]', 'qt-download-tasks':'[]',
  };
  const b = await secondaryFixture({ width:1920, height:1080, initialStorage, sdkOverrides:{
    request(request) { requests.push(request); if (request.url.endsWith('app/user/logout')) request.success?.({ statusCode:200, data:JSON.stringify({ code:200, data:{} }) });
      else request.fail?.({ errMsg:'offline owned transport' }); },
  } });
  try {
    b.player.restore(); await b.flush(); await b.mount('pages/user/index.uvue');
    assert.ok(b.text().includes('电视用户'), 'original actual cached account info is displayed');
    const ai = b.cell('AI 音乐助手'); assert.ok(ai, 'AI remains visible for the original ordinary logged-in account');
    assert.equal(b.css(ai)['min-height'], '76px', 'account entry TV rows retain readable remote height and can grow');
    assert.equal(ai.props['data-qt-tv-id'], 'user:ai', 'account route identity follows the original semantic action');
    assert.equal(b.css(b.byClass('logout-btn')[0]).height,'56px','TV original logout is an actual56px target'); assert.equal(b.byClass('logout-btn')[0].props['data-qt-tv-id'],'user:logout');
    for (const [cls,line] of [['name','40px'],['sub','27px'],['cell-title','31px'],['logout-text','29px']]) for (const node of b.byClass(cls)) assert.equal(b.css(node)['line-height'],line,'TV original account ' + cls + ' receives actual native lines');
    assert.ok(b.byClass('page-body').some(node => hasClass(node, 'qt-tv-scroll')), 'account content remains a public remote scroll surface');
    for (const [label, url] of [['修改个人资料','/pages/profile/edit/index'], ['我的收藏','/pages/collection/index'], ['听歌统计','/pages/stats/index'], ['AI 音乐助手','/pages/ai-assistant/index'], ['我的歌单','/pages/playlists/index'], ['最近播放','/pages/history/index']]) {
      const cell = b.cell(label); await b.focus(cell); const before = b.routes.length; await b.remote('ok', 1); assert.equal(b.routes.length, before);
      await b.remote('ok'); assert.equal(b.routes.at(-1).url, url, 'one public remote route uses its original destination: ' + label);
    }
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const [cls,line] of [['name','52px'],['sub','36px'],['cell-title','40px'],['logout-text','38px']]) for (const node of b.byClass(cls)) assert.equal(b.css(node)['line-height'],line,'huge original account ' + cls + ' reserves enlarged lines');
    b.setWindow({windowWidth:720,windowHeight:480}); await b.flush();
    for (const [label,id] of [['修改个人资料','edit'],['我的收藏','collection'],['听歌统计','stats'],['AI 音乐助手','ai']]) assert.equal(b.cell(label).props['data-qt-tv-id'],'user:' + id,'same-mounted one-column TV route still has its semantic identity');
    const kept = Object.entries(initialStorage).filter(([key]) => key.includes('liked-songs') || key.includes('pending-ops') || key.includes('cursor') || key.includes('download'));
    await b.dispatch(b.byClass('logout-btn')[0]); await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '取消'));
    assert.equal(b.load('services/auth.ts').getAccessToken(), 'user-token', 'logout cancel preserves actual auth');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush();
    assert.equal(b.css(b.cell('AI 音乐助手'))['min-height'], undefined, 'single-column touch AI entry restores original sizing');
    assert.equal(b.byClass('cell').length, 4, 'original touch account entry visibility stays unchanged');
    assert.equal(b.css(b.byClass('logout-btn')[0]).height,undefined);
    for (const cls of ['name','sub','cell-title','logout-text']) for (const node of b.byClass(cls)) assert.equal(b.css(node)['line-height'],undefined,'same-mounted touch account ' + cls + ' restores original CSS');
    await b.dispatch(b.byClass('logout-btn')[0]); await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '退出')); await b.flush();
    assert.equal(b.load('services/auth.ts').getAccessToken(), '', 'original real logout clears tokens');
    assert.equal(requests.filter(request => request.url.endsWith('app/user/logout')).length, 1, 'one original confirmation sends the real account logout request once');
    assert.ok(requests.some(request => request.url.includes('/like/')), 'original pending operation flush still runs before logout through real sync');
    for (const [key, value] of kept) assert.equal(b.storage.get(key), value, 'logout retains original offline/download data: ' + key);
  } finally { await b.close(); }
}

async function cacheCase() {
  const keptSong = song('download-kept', '保留下载歌曲');
  const initialStorage = {
    'qt-access-token':'cache-token', 'qt-refresh-token':'cache-refresh', 'qt-token-expiry':9000000000, 'qt-user-id':'cache-user',
    'qt-downloads':JSON.stringify({ version:2, items:[{ song:keptSong, path:'/fixture/kept.mp3', size:2048, time:1, sidecars:[] }] }),
    'qt-download-tasks':JSON.stringify({ version:2, tasks:[{ song:keptSong, status:'paused', error:'' }] }),
    'qt-liked-songs:cache-user':JSON.stringify([JSON.stringify({ ...keptSong, platform:'wyy' })]),
    'qt-like-pending-ops:cache-user':'[]', 'qt-like-cursor:cache-user':'51',
  };
  const b = await secondaryFixture({ width:1920, height:1080, initialStorage, files:{ '/fixture/kept.mp3':'download-bytes' } });
  const isChecked = cell => walk(cell).some(node => hasClass(node, 'qt-checkbox-dot'));
  try {
    b.player.restore(); b.downloads.restore(); await b.flush(); await b.mount('pages/cache/index.uvue');
    assert.equal(b.byClass('cell').length, 9, 'all original nine cache categories remain');
    assert.equal(b.byClass('cell').filter(isChecked).length, 5, 'exactly the five reacquirable caches are selected by default');
    const audio = b.cell('音乐播放缓存');
    assert.equal(b.css(audio)['min-height'], '76px', 'cache TV rows grow instead of clipping remote text and controls');
    assert.equal(audio.props['data-qt-tv-id'], 'cache:audio', 'cache semantic focus follows the real clear branch');
    assert.ok(b.byClass('list').some(node => hasClass(node, 'qt-tv-scroll')), 'cache page is a public native scroll surface');
    assert.equal(b.css(b.byClass('cell-desc')[0])['line-height'], '26px', '20px floor has a readable explicit descriptive line box');
    assert.equal(b.css(b.byClass('total-hint')[0])['line-height'], '26px', 'TV cache occupation summary has a line taller than its actual20px font');
    assert.equal(b.css(b.byClass('hint-text')[0])['line-height'], '26px', 'TV retain-download consequence has an actual-font line budget');
    assert.equal(b.css(b.byClass('cell-title')[0])['line-height'], '31px', 'TV cache category title reserves actual23.46px font');
    assert.equal(b.button('清除所选内容（5）').props['data-qt-tv-id'], 'cache:submit', 'destructive submit has a stable semantic identity');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(b.css(b.byClass('cell-desc')[0])['line-height'], '31px', 'largest tier grows cache description lines');
    assert.equal(b.css(b.byClass('total-hint')[0])['line-height'], '29px'); assert.equal(b.css(b.byClass('hint-text')[0])['line-height'], '29px');
    assert.equal(b.css(b.byClass('cell-title')[0])['line-height'], '40px', 'huge cache title grows without a fixed-height clipping row');
    await b.focus(audio); await b.remote('ok', 1); assert.equal(isChecked(audio), true);
    await b.remote('ok'); assert.equal(isChecked(audio), false, 'one original row activation toggles one checkbox');
    await b.dispatch(walk(audio).find(node => hasClass(node, 'qt-checkbox'))); assert.equal(isChecked(audio), true, 'public checkbox stops row bubbling');
    await b.dispatch(b.button('清除所选内容（5）')); await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '取消'));
    assert.equal(b.downloads.items.length, 1, 'original cache cancel leaves completed downloads');
    for (const cell of b.byClass('cell').filter(isChecked)) await b.dispatch(cell);
    const disabled = b.button('请选择要清除的内容'); assert.ok(disabled);
    await b.dispatch(disabled); assert.equal(b.byClass('qc-btn').length, 0, 'empty original selection disables destructive submit');
    await b.dispatch(b.cell('登录状态')); await b.dispatch(b.button('清除所选内容（1）'));
    assert.ok(b.text().includes('清理后将退出登录'), 'original selected-account consequence stays explicit');
    await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '清除')); await b.flush();
    assert.equal(b.load('services/auth.ts').getAccessToken(), '', 'original account-only clear uses real auth');
    for (const [key, value] of Object.entries(initialStorage).filter(([key]) => key.includes('download') || key.includes('liked-songs') || key.includes('pending-ops') || key.includes('cursor'))) {
      if (key.includes('download')) assert.deepEqual(JSON.parse(b.storage.get(key)), JSON.parse(value), 'account clearing retains original download data: ' + key);
      else assert.equal(b.storage.get(key), value, 'account clearing retains original data: ' + key);
    }
    assert.equal(b.fileData.get('/fixture/kept.mp3'), 'download-bytes', 'download file bytes are always retained');
    assert.equal(b.clock.timeoutCount(600), 1, 'original successful account clear schedules one delayed login route');
    for (const dispose of b.lifecycle.unload) await dispose(); await b.clock.runTimers(600);
    assert.equal(b.routes.some(route => route.action === 'reLaunch'), false, 'original page disposal cancels delayed navigation');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush();
    assert.equal(b.css(b.cell('音乐播放缓存'))['min-height'], undefined, 'touch cache cell sizing returns to original CSS');
    assert.equal(b.css(b.byClass('cell-desc')[0])['line-height'], undefined, 'touch descriptive lines return to original CSS');
    assert.equal(b.css(b.byClass('total-hint')[0])['line-height'], undefined); assert.equal(b.css(b.byClass('hint-text')[0])['line-height'], undefined);
  } finally { await b.close(); }
}

async function logsCase() {
  const path = '/owned-fixture/logs/quietmusic.log', body = '2026-11-15 I [Fixture] 保留原日志正文\n2026-11-15 W [Fixture] 第二行原警告\n2026-11-15 E [Fixture] 第三行原错误', io = [], files = new Map([[path, body]]);
  const b = await secondaryFixture({ width:1920, height:1080, loggerUts:true, initialStorage:{
    'qt-access-token':'admin-token', 'qt-refresh-token':'admin-refresh', 'qt-token-expiry':9000000000, 'qt-user-id':'admin-user',
    'qt-permissions':JSON.stringify(['admin:qt:admin']),
  }, boundaryOverrides:{ 'services/logger':undefined }, nativeSdk:{
    dataDir() { io.push(['dataDir']); return '/owned-fixture'; },
    listDir(dir, reply) { io.push(['list', dir]); reply(true, JSON.stringify(files.has(path) ? [{ name:'quietmusic.log', size:4096, dir:false }] : []), ''); },
    readTextFile(file, reply) { io.push(['read', file]); reply(true, files.get(file) ?? '', ''); },
    remove(file, reply) { io.push(['remove', file]); files.delete(file); reply(true, '', ''); },
    appendTextFile(file, value, reply) { io.push(['append', file]); files.set(file, (files.get(file) ?? '') + value); reply(true, '', ''); },
  } });
  try {
    await b.mount('pages/logs/index.uvue'); await b.flush();
    assert.ok(b.text().includes('保留原日志正文'), 'actual admin gate and real logger read show original native file data');
    const log = b.byClass('log')[0]; assert.ok(log, 'real populated log document is rendered');
    assert.equal(hasClass(log, 'qt-tv-scroll'), true, 'read-only log document is a public remote scroll target');
    assert.equal(log.props['data-qt-tv-id'], 'logs:document', 'log document has semantic identity without inventing an action');
    assert.equal(b.css(b.byClass('log-line')[0])['line-height'], '26px', 'TV log 20px floor retains a readable line box');
    assert.deepEqual(b.byClass('log-line').map(text), body.split('\n'), 'actual logger and original page preserve original multiline content');
    const debug = b.byClass('switch-row')[0];
    assert.equal(b.css(debug)['min-height'], '76px', 'TV debug control row grows for its two actual-font lines');
    assert.equal(debug.props['data-qt-tv-id'], 'logs:debug');
    for (const cls of ['head-path','switch-desc','hint-text']) assert.equal(b.css(b.byClass(cls)[0])['line-height'], '26px', 'TV ' + cls + ' actual20px line box');
    assert.equal(text(b.byClass('head-value')[0]), '4 KB', 'original native 4096-byte sum and file-size formatter remain reflected in the occupation summary');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(b.css(b.byClass('log-line')[0])['line-height'], '29px', 'largest tier grows actual log line boxes');
    assert.equal(b.css(b.byClass('switch-desc')[0])['line-height'], '31px');
    assert.equal(b.css(b.byClass('head-path')[0])['line-height'], '29px');
    assert.equal(b.css(b.byClass('hint-text')[0])['line-height'], '29px');
    await b.focus(log); await b.remote('down'); assert.equal(b.scrollCalls.at(-1).id, nativeId(log), 'remote direction scrolls the real read-only log surface');
    await b.focus(b.button('复制日志')); await b.remote('ok', 1); assert.equal(b.clipboard.length, 0);
    await b.remote('ok'); assert.equal(b.clipboard.at(-1), body, 'copy preserves original multiline logger content without changing its separator');
    await b.dispatch(b.button('复制路径')); assert.equal(b.clipboard.at(-1), path, 'original current-log path copy stays intact');
    await b.dispatch(debug);
    assert.equal(b.load('services/logger.uts').isLogDebug(), true, 'original public debug control changes real logger state');
    await b.dispatch(walk(debug).find(node => hasClass(node, 'qt-checkbox')));
    assert.equal(b.load('services/logger.uts').isLogDebug(), false, 'original shared checkbox remains isolated from parent toggling');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush();
    assert.equal(b.css(b.byClass('switch-row')[0])['min-height'], undefined, 'same mounted touch debug row retains its original stylesheet');
    for (const cls of ['head-path','switch-desc','hint-text','log-line']) assert.equal(b.css(b.byClass(cls)[0])['line-height'], undefined, 'touch ' + cls + ' returns to original CSS');
    await b.dispatch(b.button('复制日志')); assert.equal(b.clipboard.at(-1), body, 'original touch multiline copy remains intact');
    await b.dispatch(b.button('清除日志')); await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '取消'));
    assert.equal(files.has(path), true, 'original log clear cancellation retains the file');
    await b.dispatch(b.button('清除日志')); await b.dispatch(b.byClass('qc-btn').find(node => text(node) === '清除')); await b.flush();
    assert.equal(files.has(path), false, 'confirmed original clear runs real serialized logger removal');
    assert.equal(io.filter(([name]) => name === 'remove').length, 4, 'real clear removes current and original three rotated files');
    const before = io.length; b.load('services/auth.ts').clearTokens();
    for (const onShow of b.lifecycle.show) await onShow(); await b.flush();
    assert.ok(b.text().includes('当前账号没有查看运行日志的权限')); assert.equal(b.byClass('act').length, 0);
    assert.equal(io.length, before, 'non-admin re-entry performs no log path, byte or data read');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush();
  } finally { await b.close(); }
  assert.deepEqual(b.restoredCompilerBindings, ['logger-json'], 'actual real logger chain settles and restores its scoped UTS JSON compatibility');
  const after = await secondaryFixture({ boundaryOverrides:{ 'services/logger':undefined } });
  try {
    const json = after.load('services/logger.uts').isLogDebug.constructor('return JSON')();
    assert.equal(json.parse('{"name":"unpolluted"}').get, undefined, 'later original frozen fixture remains plain and unpolluted');
  } finally { await after.close(); }
}

async function permissionsCase() {
  let unknown = true;
  const b = await secondaryFixture({ width:1920, height:1080, nativeSdk:{
    queryPermissionStates:ids => ids.map(id => ({ id, applicable:id !== 'android.permission.READ_EXTERNAL_STORAGE', granted:true, unknown:unknown && id === 'android.permission.POST_NOTIFICATIONS' })),
  } });
  try {
    await b.mount('pages/permissions/index.uvue'); await b.flush();
    assert.deepEqual(b.byClass('cell-title').map(text).slice(1), ['网络访问','通知','读取音频文件','读取音频文件（旧版）','所有文件访问','安装应用','前台服务','媒体播放前台服务','唤醒锁定','悬浮窗','写入外部存储','电池优化白名单','自启动管理'], 'original Android permission and keepalive entries remain exact');
    const notifications = b.cell('通知');
    assert.equal(b.css(notifications)['min-height'], '76px', 'permission status rows reserve a growing readable TV target');
    assert.equal(notifications.props['data-qt-tv-id'], 'permissions:android.permission.POST_NOTIFICATIONS', 'semantic focus uses the exact native permission identifier');
    assert.equal(b.css(b.byClass('cell-desc')[0])['line-height'], '26px', 'TV permission descriptions have actual 20px-floor line budget');
    for (const desc of b.byClass('cell-desc')) assert.equal(b.css(desc)['line-height'], '26px', 'every native-capability and keepalive description reserves actual20px text');
    for (const chip of b.byClass('cell-chip')) assert.equal(b.css(chip)['line-height'], '26px', 'all read-only native status chips keep actual-font line boxes');
    for (const hint of b.byClass('hint-text')) assert.equal(b.css(hint)['line-height'], '26px', 'TV permission explanations remain readable');
    assert.equal(b.css(b.byClass('cell-title')[0])['line-height'], '31px');
    assert.equal(b.cell('电池优化白名单').props['data-qt-tv-id'], 'permissions:battery');
    assert.equal(b.cell('自启动管理').props['data-qt-tv-id'], 'permissions:auto-start');
    assert.ok(b.byClass('list').some(node => hasClass(node, 'qt-tv-scroll')), 'permission list is explicitly scrollable from remote');
    await b.focus(notifications); await b.remote('ok');
    assert.equal(b.ownedNativeCalls.filter(call => call.name === 'permissionSettings').length, 0, 'unknown state retains original informational-only action');
    await b.dispatch(b.cell('读取音频文件（旧版）')); await b.dispatch(b.cell('网络访问'));
    assert.equal(b.ownedNativeCalls.filter(call => call.name === 'permissionSettings').length, 0, 'not-applicable and normal permissions gain no system capability');
    unknown = false; for (const onShow of b.lifecycle.show) await onShow(); await b.flush();
    await b.focus(b.cell('通知')); await b.remote('ok', 1); assert.equal(b.ownedNativeCalls.length, 0);
    await b.remote('ok'); assert.deepEqual(b.ownedNativeCalls.filter(call => call.name === 'permissionSettings'), [{ name:'permissionSettings', id:'android.permission.POST_NOTIFICATIONS' }]);
    await b.dispatch(b.cell('悬浮窗')); assert.equal(b.nativeCalls.filter(call => call.name === 'audioLyricRequestOverlayPermission').length, 1, 'overlay reuses the actual desktop lyric service instead of a new request capability');
    await b.focus(b.cell('电池优化白名单')); await b.remote('ok', 1); await b.remote('ok');
    await b.focus(b.cell('自启动管理')); await b.remote('ok', 1); await b.remote('ok');
    assert.equal(b.ownedNativeCalls.filter(call => call.name === 'battery').length, 1); assert.equal(b.ownedNativeCalls.filter(call => call.name === 'autoStart').length, 1);
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const desc of b.byClass('cell-desc')) assert.equal(b.css(desc)['line-height'], '31px');
    for (const chip of b.byClass('cell-chip')) assert.equal(b.css(chip)['line-height'], '31px');
    for (const hint of b.byClass('hint-text')) assert.equal(b.css(hint)['line-height'], '29px');
    assert.equal(b.css(b.byClass('cell-title')[0])['line-height'], '40px');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush();
    assert.equal(b.css(b.cell('通知'))['min-height'], undefined); assert.equal(b.css(b.byClass('cell-desc')[0])['line-height'], undefined);
    for (const cls of ['cell-title','cell-chip','hint-text']) assert.equal(b.css(b.byClass(cls)[0])['line-height'], undefined, 'same mounted touch ' + cls + ' retains original CSS');
    await b.dispatch(b.cell('通知')); assert.equal(b.ownedNativeCalls.filter(call => call.name === 'permissionSettings').length, 2, 'touch retains its original system settings call');
  } finally { await b.close(); }
  const pending = [];
  const ios = await secondaryFixture({ platform:'APP-IOS', width:1920, height:1080, nativeSdk:{ queryPermissionStatesAsync(ids, reply) { pending.push({ ids, reply }); } } });
  try {
    await ios.mount('pages/permissions/index.uvue'); assert.equal(pending.length, 1);
    assert.equal(ios.css(ios.byClass('cell-chip')[0])['line-height'], '26px', 'iOS informational status remains readable without gaining a new permission action');
    assert.deepEqual(ios.byClass('cell-title').map(text).slice(1), ['通知','保存到相册','局域网','文件导入与下载目录','后台音频'], 'iOS original five capabilities do not acquire Android-only controls');
    for (const onShow of ios.lifecycle.show) await onShow(); assert.equal(pending.length, 2);
    pending[1].reply(pending[1].ids.map(id => ({ id, applicable:true, granted:true, unknown:id === 'ios.localNetwork' }))); await ios.flush();
    pending[0].reply(pending[0].ids.map(id => ({ id, applicable:true, granted:false, unknown:false }))); await ios.flush();
    assert.equal(text(ios.byClass('cell-chip')[0]), '暂无待处理', 'older native query never overwrites the fresh permission generation');
    await ios.dispatch(ios.cell('局域网')); assert.deepEqual(ios.ownedNativeCalls.filter(call => call.name === 'permissionSettings'), [{ name:'permissionSettings', id:'ios.localNetwork' }]);
    await ios.dispatch(ios.cell('文件导入与下载目录')); assert.equal(ios.ownedNativeCalls.length, 1, 'original iOS normal file selector row stays explanatory');
    for (const onShow of ios.lifecycle.show) await onShow(); for (const dispose of ios.lifecycle.unload) await dispose();
    pending[2].reply(pending[2].ids.map(id => ({ id, applicable:true, granted:false, unknown:false }))); await ios.flush();
    assert.equal(text(ios.byClass('cell-chip')[0]), '暂无待处理', 'unloaded original page ignores late permission results');
  } finally { await ios.close(); }
  const hm = await secondaryFixture({ platform:'APP-HARMONY', width:1920, height:1080, nativeSdk:{ queryPermissionStates:ids => ids.map(id => ({ id, applicable:false, granted:false, unknown:false })) } });
  try {
    await hm.mount('pages/permissions/index.uvue'); assert.equal(hm.cell('电池优化白名单'), undefined); assert.ok(hm.cell('自启动管理'));
    assert.equal(hm.cell('自启动管理').props['data-qt-tv-id'], 'permissions:auto-start');
    for (const desc of hm.byClass('cell-desc')) assert.equal(hm.css(desc)['line-height'], '26px');
    assert.deepEqual(hm.byClass('cell-title').map(text).slice(1), ['下载目录','文档目录','网络访问','网络状态','后台播放保活','运行锁','音频设置','车机音频','文件访问持久化','自启动管理'], 'Harmony retains exact two apply/seven system capabilities');
    await hm.dispatch(hm.cell('下载目录')); await hm.dispatch(hm.byClass('qc-btn').find(node => text(node) === '取消')); assert.equal(hm.routes.length, 0);
    await hm.dispatch(hm.cell('下载目录')); await hm.dispatch(hm.byClass('qc-btn').find(node => text(node) === '去设置'));
    assert.equal(hm.routes.at(-1).url, '/pages/download-settings/index'); assert.equal(hm.ownedNativeCalls.length, 0, 'original Harmony directory guidance uses the app picker route, not a new permission');
  } finally { await hm.close(); }
}

async function shareCardCase() {
  const exported = [], loading = [], target = song('share-song', '分享原歌曲');
  const b = await secondaryFixture({ width:1920, height:1080, nativeSdk:{
    statLocalFile:() => 2048,
    readEmbeddedTags:() => ({ title:target.name, artist:target.singer, album:target.album, coverPath:'', lrcText:'[00:01.00]第一行\n[00:02.00]第二行\n[00:03.00]第三行\n[00:04.00]第四行\n[00:05.00]第五行\n[00:06.00]第六行\n[00:07.00]第七行' }),
    async saveToPublicMedia(path, kind, name, directory) { exported.push({ path, kind, name, directory }); return '/public/share.png'; },
  } });
  b.setSdk({ showLoading:request => loading.push(request.title), hideLoading:() => loading.push('hide') });
  try {
    b.load('stores/share-card.ts').useShareCardStore().open(target); await b.mount('pages/share-card/index.uvue'); await b.clock.runTimers(0); await b.flush();
    assert.ok(b.text().includes('分享原歌曲')); assert.equal(b.css(b.byClass('card')[0]).width, '340px', 'original wide card cap stays intact');
    const scroll = b.byClass('scroll')[0];
    assert.equal(hasClass(scroll, 'qt-tv-scroll'), true, 'share card is readable through native remote scrolling');
    assert.equal(b.css(b.byClass('act-btn')[0]).height, '56px', 'original share action has a TV-sized target without a new capability');
    assert.equal(b.byClass('act-btn')[0].props['data-qt-tv-id'], 'share-card:share');
    assert.equal(b.byClass('footer-qr')[0].props.src, '/static/share/share-qr.png', 'original static client-download QR remains the only QR');
    await b.focus(b.byClass('act-btn')[1]); await b.remote('down'); assert.equal(b.scrollCalls.at(-1).id, nativeId(b.byClass('act-btn')[1]), 'at the final content action, remote reveals the enclosing card scroll before escaping');
    await b.dispatch(b.byClass('act-btn')[0]); assert.equal(b.snapshots.length, 0); assert.ok(b.toastCalls.at(-1).title.includes('封面还在加载'));
    await b.dispatch(b.byClass('cover')[0], 'error');
    await b.dispatch(b.byClass('seg-item')[1]); assert.deepEqual(b.byClass('lyric-line').map(text), ['第一行','第二行','第三行','第四行','第五行','第六行'], 'actual music API and parseLrc retain first original six nonempty lyrics');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(b.css(b.byClass('lyric-line')[0])['font-size'], '25.2px', 'actual huge exported lyric uses the real shared font store');
    assert.equal(b.css(b.byClass('lyric-line')[0])['line-height'] ?? '26px', '33px', 'huge exported lyric25.2px glyphs outgrow the original literal26px CSS line');
    b.fonts.useFontScaleStore().setTier('normal'); await b.flush();
    assert.equal(b.css(b.byClass('lyric-line')[0])['line-height'], '26px', 'TV exported lyrics use the actual20px-floor line box');
    for (const [cls, line] of [['song-name','33px'],['song-singer','26px'],['footer-brand','26px'],['footer-tip','26px'],['footer-sub','26px'],['act-text','26px'],['tip-text','26px']]) assert.equal(b.css(b.byClass(cls)[0])['line-height'], line, 'actual exported TV ' + cls + ' retains its readable line box');
    assert.equal(b.css(b.byClass('footer-left')[0]).width, '228px', '340px card reserves its original36px padding,64px QR and12px text gap');
    assert.equal(b.css(b.byClass('footer-qr')[0])['flex-shrink'], '0', 'original fixed QR is retained instead of squeezed by enlarged copy');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(b.css(b.byClass('lyric-line')[0])['line-height'], '33px', 'huge exported lyric25.2px glyphs fit the33px line rather than old26px CSS');
    assert.equal(b.css(b.byClass('song-name')[0])['line-height'], '43px');
    assert.equal(b.css(b.byClass('footer-brand')[0])['line-height'], '31px');
    assert.equal(b.css(b.byClass('act-text')[0])['line-height'], '33px');
    await b.focus(b.byClass('act-btn')[0]); await b.remote('ok', 1); assert.equal(b.clock.timeoutCount(320), 0);
    await b.remote('ok'); assert.equal(b.clock.timeoutCount(320), 1); assert.equal(b.clock.timeoutCount(12000), 1);
    await b.remote('ok'); assert.equal(b.clock.timeoutCount(320), 1, 'original working guard prevents overlapping export');
    assert.equal(scroll.props['scroll-into-view'], 'shareCard', 'original export reveals its real snapshot node before capture');
    await b.clock.runTimers(320); assert.equal(b.snapshots.length, 1); assert.equal(b.snapshots[0].id, 'shareCard');
    b.snapshots[0].request.success({ tempFilePath:'/fixture/share.png' }); await b.flush();
    b.snapshots[0].request.fail({ message:'late duplicate' }); await b.flush(); assert.equal(b.shareCalls.length, 1, 'original settle-once blocks duplicate snapshot completion');
    assert.equal(b.shareCalls[0].imageUrl, '/fixture/share.png'); assert.equal(b.clock.timeoutCount(12000), 0);
    await b.dispatch(b.byClass('act-btn')[1]); await b.clock.runTimers(320); b.snapshots[1].request.success({ tempFilePath:'/fixture/gallery.png' }); await b.flush();
    assert.equal(exported.length, 1); assert.equal(exported[0].kind, 'picture'); assert.equal(exported[0].directory, 'qtMusic'); assert.equal(exported[0].path, '/fixture/gallery.png');
    assert.match(exported[0].name, /^qt-share-[0-9]+\.png$/); assert.equal(b.toastCalls.at(-1).title, '已保存到相册');
    await b.dispatch(b.byClass('act-btn')[0]); await b.clock.runTimers(12000); assert.ok(b.toastCalls.at(-1).title.includes('生成图片超时')); assert.equal(b.clock.timeoutCount(320), 0);
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush();
    assert.equal(b.css(b.byClass('act-btn')[0]).height, undefined, 'touch retains original 44px stylesheet action'); assert.equal(b.css(b.byClass('card')[0]).width, '279px', 'original compact fit remains pane width minus 96');
    for (const cls of ['song-name','song-singer','footer-brand','footer-tip','footer-sub','act-text','tip-text','lyric-line']) assert.equal(b.css(b.byClass(cls)[0])['line-height'], undefined, 'same-mounted touch ' + cls + ' restores original inline/CSS typography');
    assert.equal(b.css(b.byClass('footer-left')[0]).width, undefined); assert.equal(b.css(b.byClass('footer-qr')[0])['flex-shrink'], undefined);
    await b.dispatch(b.byClass('act-btn')[0]); for (const dispose of b.lifecycle.unload) await dispose(); await b.clock.runTimers(320); await b.clock.runTimers(12000);
    assert.equal(b.load('stores/share-card.ts').useShareCardStore().song, null); assert.equal(b.snapshots.length, 3, 'original unload adds no capture after the two completed exports and the timed-out third capture');
    assert.ok(loading.includes('生成图片中...')); assert.ok(loading.includes('hide'));
  } finally { await b.close(); }
}

async function aboutCase() {
  const requests = [], accepted = JSON.stringify({ termsVersion:'read-v1', acceptedAt:'2026-11-01T00:00:00.000Z' });
  let updateMode = 'none', noticeMode = 'read';
  const b = await secondaryFixture({ width:1920, height:1080, initialStorage:{ 'qt-disclaimer-accepted':accepted },
    boundaryOverrides:{ 'services/logger':{ logWarn:noop, logWarnV:noop, logErrV:noop, logInfo:noop, logError:noop } }, sdkOverrides:{
      getAppBaseInfo:() => ({ appVersion:'4.2.0', appVersionCode:'420' }),
      request(request) {
        requests.push(request);
        if (request.url.includes('app/update')) {
          if (updateMode === 'fail') return request.fail?.({ errMsg:'offline version boundary' });
          const data = updateMode === 'new' ? { versionCode:421, versionName:'4.2.1', versionInfo:'原更新说明', updateType:'1', downloadUrl:'', browserUrl:'https://owned.invalid/update', isGithub:0, channel:'stable', isForce:0, fileSize:2048, md5:'' } : {};
          request.success?.({ statusCode:200, data:JSON.stringify({ code:200, data }) });
        } else if (request.url.includes('app/message/active')) {
          const data = noticeMode === 'read' ? [{ id:19, title:'原只读声明', content:'原服务条款正文', display:1, termsVersion:'read-v1', readSeconds:2, isTop:1 }] : [];
          request.success?.({ statusCode:200, data:JSON.stringify({ code:200, data }) });
        } else request.fail?.({ errMsg:'offline unrelated transport' });
      },
    } });
  try {
    await b.mount('pages/about/index.uvue'); assert.ok(b.text().includes('版本 4.2.0 (420)')); assert.ok(b.text().includes('构建 2026-11-04 10:35'));
    assert.deepEqual(b.byClass('cell-title').map(text), ['检查更新','用户协议','隐私政策','使用前请先阅读','项目介绍与开源地址','意见反馈'], 'original six about actions retain current business copy and order');
    const update = b.cell('检查更新');
    assert.equal(b.css(update)['min-height'], '76px', 'about actions reserve growing TV-readable rows');
    assert.equal(update.props['data-qt-tv-id'], 'about:update'); assert.ok(b.byClass('list').some(node => hasClass(node, 'qt-tv-scroll')));
    for (const [cls, line] of [['name','47px'],['version','26px'],['slogan','26px'],['section-label','26px'],['cell-title','29px'],['cell-value','26px'],['footer','26px']]) for (const node of b.byClass(cls)) assert.equal(b.css(node)['line-height'], line, 'TV about actual ' + cls + ' has a readable native line');
    const endpoints = [['用户协议','https://quietmusic.canace.cn/agreement'], ['隐私政策','https://quietmusic.canace.cn/privacy'], ['项目介绍与开源地址','https://quietmusic.canace.cn'], ['意见反馈','https://quietmusic.canace.cn/feedback']];
    for (const [label, url] of endpoints) {
      await b.focus(b.cell(label)); const before = b.ownedNativeCalls.length; await b.remote('ok', 1); assert.equal(b.ownedNativeCalls.length, before);
      await b.remote('ok'); assert.deepEqual(b.ownedNativeCalls.at(-1), { name:'external', url }, 'original official destination: ' + label);
    }
    await b.focus(update); await b.remote('ok', 1); assert.equal(requests.length, 0); await b.remote('ok');
    assert.equal(requests.filter(request => request.url.includes('app/update')).length, 1); assert.ok(b.text().includes('已是最新版本'));
    updateMode = 'new'; await b.remote('ok'); assert.ok(b.text().includes('原更新说明')); assert.ok(b.button('浏览器下载'));
    await b.remote('back', 1); assert.equal(b.byClass('up-card').length, 1, 'held Back preserves the original nonforce modal');
    await b.remote('back'); assert.equal(b.byClass('up-card').length, 0); assert.ok(b.text().includes('点击检查'), 'real popup closed event restores original update label');
    updateMode = 'fail'; await b.dispatch(b.cell('检查更新')); assert.ok(b.text().includes('已是最新版本'), 'original service returns null on offline update; no new blocking flow');
    await b.dispatch(b.cell('使用前请先阅读')); const disclaimer = b.load('stores/disclaimer.ts').useDisclaimerStore();
    assert.equal(disclaimer.reopened, true); assert.equal(disclaimer.notice.title, '原只读声明'); assert.equal(b.storage.get('qt-disclaimer-accepted'), accepted, 'reopening is view-only and never changes the original acceptance');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); assert.equal(b.css(b.cell('检查更新'))['min-height'], '76px');
    for (const [cls, line] of [['name','61px'],['version','33px'],['slogan','33px'],['section-label','29px'],['cell-title','38px'],['cell-value','31px'],['footer','29px']]) for (const node of b.byClass(cls)) assert.equal(b.css(node)['line-height'], line, 'huge about actual ' + cls + ' recomputes its line');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush(); assert.equal(b.css(b.cell('检查更新'))['min-height'], undefined);
    for (const cls of ['name','version','slogan','section-label','cell-title','cell-value','footer']) for (const node of b.byClass(cls)) assert.equal(b.css(node)['line-height'], undefined, 'same-mounted touch about ' + cls + ' remains original');
    await b.dispatch(b.cell('意见反馈')); assert.deepEqual(b.ownedNativeCalls.at(-1), { name:'external', url:'https://quietmusic.canace.cn/feedback' }, 'touch retains original official feedback destination');
  } finally { await b.close(); }
  const forced = await secondaryFixture({ width:1920, height:1080 });
  try {
    forced.load('services/upgrade.ts').setPendingUpdate({ versionCode:421, versionName:'4.2.1', versionInfo:'强制更新原正文', updateType:'1', downloadUrl:'', browserUrl:'https://owned.invalid/forced', isGithub:0, channel:'stable', isForce:true, fileSize:0, md5:'' });
    await forced.mount('pages/about/index.uvue'); assert.ok(forced.text().includes('强制更新原正文')); assert.equal(forced.button('以后再说'), undefined);
    await forced.remote('back'); assert.equal(forced.byClass('up-card').length, 1, 'forced upgrade retains original close permission');
    await forced.dispatch(forced.button('浏览器下载')); assert.equal(forced.byClass('up-card').length, 1, 'original forced browser update does not close when returning');
    assert.deepEqual(forced.ownedNativeCalls.at(-1), { name:'external', url:'https://owned.invalid/forced' });
  } finally { await forced.close(); }
  const offline = await secondaryFixture({ width:1920, height:1080 });
  try { await offline.mount('pages/about/index.uvue'); await offline.dispatch(offline.cell('使用前请先阅读')); assert.ok(offline.toastCalls.at(-1).title.includes('暂时取不到声明内容')); assert.equal(offline.storage.has('qt-disclaimer-accepted'), false); }
  finally { await offline.close(); }
}

async function statsCase() {
  const first = { ...song('local-first', '本地最多播放'), singer:'甲歌手', picUrl:'file:///fixture/cover.png' };
  const songs = [first, { ...song('wyy-second', '网易第二首'), platform:'wyy', singer:'乙歌手' }, { ...song('qq-third', 'QQ第三首'), platform:'qq', singer:'丙歌手' }, { ...song('kw-fourth', '酷我第四首'), platform:'kw', singer:'丁歌手' }, { ...song('bili-fifth', '哔哩第五首'), platform:'bili', singer:'戊歌手' }];
  const b = await secondaryFixture({ width:1920, height:1080, nativeSdk:{ statLocalFile:path => path === first.url ? 128000 : -1 }, initialStorage:{ 'qt-local-audio-v1':[{ id:first.id, uri:first.url, path:'/fixture/local-first.mp3', title:first.name, singer:first.singer, album:first.album, duration:first.duration }] } });
  try {
    b.clock.advance(Date.parse('2026-11-15T12:00:00+08:00') - b.clock.now());
    const stats = b.load('stores/listen-stats.ts').useListenStatsStore();
    for (const [index, at] of [[0,'2026-11-15T10:00:00+08:00'],[1,'2026-11-14T10:00:00+08:00'],[2,'2026-11-09T10:00:00+08:00'],[3,'2026-11-15T11:00:00+08:00'],[4,'2026-11-01T10:00:00+08:00']]) {
      for (let occurrence = 0; occurrence < 5 - index; occurrence++) await stats.recordProgress(songs[index], occurrence === 0 ? (5 - index) * 20 : 0, 1, 0, Date.parse(at) + occurrence);
    }
    await b.mount('pages/stats/index.uvue'); b.audio.audioPlayer.setGapless(false);
    const cards = b.byClass('top-card'); assert.equal(cards.length, 3, 'actual statistics produce five songs, five artists and five sources');
    assert.deepEqual(walk(cards[0]).filter(node => hasClass(node, 'song-name')).map(text), ['本地最多播放','网易第二首','QQ第三首','酷我第四首','哔哩第五首'], 'original cumulative Top 5 ranks actual report counts');
    assert.deepEqual(b.byClass('stat-num').map(text), ['15','0','5','5'], 'actual report totals remain count/collection/distinct-song/distinct-artist');
    assert.equal(stats.totalSeconds, 300); assert.equal(b.clock.timeoutCount(5000), 0, 'original onShow flush persists and clears the save timer');
    const scroll = b.byClass('scroll')[0]; assert.ok(hasClass(scroll, 'qt-tv-scroll'), 'complete statistics is a read-only remote vertical scroll surface');
    const topScroll = b.byClass('top-scroll')[0]; assert.ok(hasClass(topScroll, 'qt-tv-scroll'), 'horizontal native Top 5 remains independently reachable');
    assert.equal(b.css(topScroll).height, '538px', 'TV native horizontal host reserves five 76px rows, two 56px header actions, 8px gap, 36px padding and 2px border');
    for (const card of cards) {
      assert.equal(walk(card).filter(node => hasClass(node, 'song-row')).length, 5);
      for (const row of walk(card).filter(node => hasClass(node, 'song-row'))) assert.equal(b.css(row).height, '76px');
    }
    assert.equal(walk(cards[0]).find(node => hasClass(node, 'song-row')).props['data-qt-tv-id'], 'stats:song:local:local-first');
    const currentRows = () => walk(b.byClass('daily-card')[0]).filter(node => hasClass(node, 'song-name')).map(text);
    assert.deepEqual(currentRows(), ['本地最多播放','酷我第四首'], 'today includes only the two actual day buckets');
    const originalCounts = stats.songs.map(row => row.count);
    const help = b.byClass('report-help')[0];
    assert.equal(b.css(help).height, '56px', 'original statistics help action has a full TV target');
    assert.equal(help.props['data-qt-tv-id'], 'stats:help');
    assert.equal(b.css(b.byClass('storage-status')[0]).height, '56px');
    assert.equal(b.byClass('storage-status')[0].props['data-qt-tv-id'], 'stats:storage');
    for (const [cls, line] of [['hero-title','58px'],['hero-sub','26px'],['hero-tag-text','26px'],['duration-label','26px'],['duration-number','61px'],['duration-unit','26px'],['duration-note','26px'],['storage-text','26px'],['stat-label','26px'],['stat-num','40px'],['stat-note','26px'],['block-title','27px'],['daily-note','26px'],['daily-summary','26px']]) assert.equal(b.css(b.byClass(cls)[0])['line-height'], line, 'public TV report ' + cls + ' reserves actual-font lines');
    for (const link of b.byClass('report-link')) assert.equal(b.css(walk(link).find(node => node.tag === 'text'))['line-height'], '26px');
    await b.focus(help); await b.remote('ok', 1); assert.equal(b.byClass('detail-panel').length, 0);
    await b.remote('ok'); assert.ok(b.text().includes('怎样统计')); await b.remote('back'); assert.equal(b.byClass('detail-scroll').length, 0);
    const firstRow = walk(b.byClass('top-card')[0]).find(node => hasClass(node, 'song-row')); await b.focus(firstRow); await b.remote('ok', 1); assert.equal(b.byClass('detail-scroll').length, 0);
    await b.remote('ok'); assert.equal(text(b.byClass('detail-title')[0]), '歌曲详情'); assert.equal(text(b.byClass('detail-name')[0]), '本地最多播放'); assert.equal(b.byClass('detail-row').length, 0, 'original song target renders identity and direct play, not the all-ranking list');
    const play = b.byClass('detail-primary').find(node => text(node).includes('播放这首歌')); await b.focus(play); const beforePlay = b.player.playbackRevision();
    await b.remote('ok', 1); assert.equal(b.player.playbackRevision(), beforePlay);
    await b.remote('ok'); assert.equal(b.player.current.name, '本地最多播放'); assert.equal(b.player.playbackRevision(), beforePlay + 1, 'one public report play reaches the real player once'); assert.equal(b.nativeCalls.filter(call => call.name === 'audioSetPlaylist').length, 1, 'one report play pushes the real native timeline once');
    await b.remote('back'); assert.equal(text(b.byClass('detail-title')[0]), '歌曲排行', 'original detail Back returns to its ranking before closing');
    await b.remote('back'); assert.equal(b.byClass('detail-panel').length, 0); assert.deepEqual(stats.songs.map(row => row.count), originalCounts, 'opening/filtering/detail playback does not invent effective play counts');
    const day = label => walk(b.byClass('daily-seg')[0]).find(node => hasClass(node, 'seg-item') && text(node) === label);
    const kind = label => walk(b.byClass('daily-kinds')[0]).find(node => hasClass(node, 'seg-item') && text(node) === label);
    // Task-36: whole Stats SFC, real QtSegmented, native first-ID dedup and public
    // focus/remote OK. Both groups must change their own original report state.
    const segmentIds = () => ['daily-seg', 'daily-kinds'].flatMap(cls => walk(b.byClass(cls)[0]).filter(node => hasClass(node, 'seg-item')).map(nativeId));
    const mountedSegmentIds = segmentIds();
    await b.focus(day('近 7 天')); await b.remote('ok', 1); assert.deepEqual(currentRows(), ['本地最多播放','酷我第四首']);
    await b.remote('ok'); assert.deepEqual(currentRows(), ['本地最多播放','网易第二首','QQ第三首','酷我第四首']);
    await b.focus(kind('歌手')); await b.remote('ok', 1); assert.equal(text(b.byClass('block-title')[0]), '近 7 天最常播放');
    await b.remote('ok'); assert.equal(text(b.byClass('block-title')[0]), '近 7 天常听歌手', 'second segmented group survives native page+custom dedup and remote OK changes category, not date');
    assert.deepEqual(currentRows(), ['甲歌手','乙歌手','丙歌手','丁歌手']);
    assert.equal(new Set(mountedSegmentIds).size, 6, 'two real three-choice segmented instances retain all six independent identities');
    b.tv.qtTvRefreshFocus(); assert.deepEqual(b.candidateCollections.at(-1).filter(candidate => mountedSegmentIds.includes(candidate.id)).map(candidate => candidate.id), mountedSegmentIds, 'native first-ID dedup retains every date and category target');
    await b.focus(day('近 30 天')); await b.remote('ok'); assert.equal(text(b.byClass('block-title')[0]), '近 30 天最常播放'); assert.equal(currentRows().length, 5);
    await b.focus(kind('音源')); await b.remote('ok'); assert.equal(text(b.byClass('block-title')[0]), '近 30 天常听音源');
    await b.focus(day('今天')); await b.remote('ok'); assert.equal(text(b.byClass('block-title')[0]), '今天最常播放');
    await b.focus(day('近 7 天')); await b.remote('ok'); assert.equal(text(b.byClass('block-title')[0]), '近 7 天常听歌手', 'remote date change preserves the original independent seven-day category');
    await b.focus(day('近 30 天')); await b.remote('ok'); assert.equal(text(b.byClass('block-title')[0]), '近 30 天常听音源', 'remote monthly date restores only its own category');
    await b.focus(kind('音源')); const categoryFocusId = b.tv.qtTvFocusedId();
    await b.dispatch(help); assert.equal(b.tv.qtTvHasModal(), true); await b.remote('back');
    assert.equal(b.tv.qtTvFocusedId(), categoryFocusId, 'closing the original report modal restores the exact second-instance category focus');
    await b.remote('ok'); assert.equal(text(b.byClass('block-title')[0]), '近 30 天常听音源', 'restored OK still addresses the original category choice');
    // Restore the original starting selections through public controls; keep all
    // pre-existing direct-click assertions below without replacing their paths.
    await b.focus(kind('歌曲')); await b.remote('ok');
    await b.focus(day('近 7 天')); await b.remote('ok'); await b.focus(kind('歌曲')); await b.remote('ok');
    await b.focus(day('今天')); await b.remote('ok'); assert.deepEqual(currentRows(), ['本地最多播放','酷我第四首']);
    assert.deepEqual(segmentIds(), mountedSegmentIds, 'same-mounted report updates never regenerate either instance identity');
    assert.deepEqual(stats.songs.map(row => row.count), originalCounts, 'remote date/category controls do not invent play counts');
    assert.equal(b.player.playbackRevision(), beforePlay + 1, 'remote report filters do not start another playback');
    await b.dispatch(day('近 7 天')); assert.deepEqual(currentRows(), ['本地最多播放','网易第二首','QQ第三首','酷我第四首'], 'actual seven-day window reloads its day history');
    await b.dispatch(kind('歌手')); assert.equal(text(b.byClass('block-title')[0]), '近 7 天常听歌手');
    await b.dispatch(day('近 30 天')); assert.equal(text(b.byClass('block-title')[0]), '近 30 天最常播放'); assert.equal(currentRows().length, 5);
    await b.dispatch(kind('音源')); await b.dispatch(day('今天')); assert.equal(text(b.byClass('block-title')[0]), '今天最常播放');
    await b.dispatch(day('近 7 天')); assert.equal(text(b.byClass('block-title')[0]), '近 7 天常听歌手', 'original dailyKinds remembers the independent seven-day selection');
    await b.dispatch(day('近 30 天')); assert.equal(text(b.byClass('block-title')[0]), '近 30 天常听音源', 'original monthly kind remains independent');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); assert.equal(b.css(b.byClass('top-scroll')[0]).height, '613px');
    assert.deepEqual(segmentIds(), mountedSegmentIds, 'font changes retain both mounted component identity namespaces');
    for (const row of walk(b.byClass('top-card')[0]).filter(node => hasClass(node, 'song-row'))) assert.equal(b.css(row).height, '91px');
    for (const [cls, line] of [['hero-title','75px'],['hero-sub','31px'],['duration-number','80px'],['stat-num','52px'],['block-title','36px'],['daily-note','26px'],['daily-summary','29px']]) assert.equal(b.css(b.byClass(cls)[0])['line-height'], line, 'huge report ' + cls + ' recomputes actual-font lines');
    await b.focus(b.byClass('storage-status')[0]); await b.remote('ok'); assert.ok(b.text().includes('怎样统计')); await b.remote('back');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:375, windowHeight:812 }); await b.flush();
    const assertTouchTopHeaders = () => {
      for (const card of b.byClass('top-card')) {
        const header = walk(card).find(node => hasClass(node, 'block-head'));
        const siblings = header.children.filter(node => node.tag !== '#text' && node.tag !== '#comment');
        assert.deepEqual(siblings.map(node => ['qt-icon','block-title','block-fill','report-link'].find(cls => hasClass(node, cls)) ?? 'extra-flex-item'), ['qt-icon','block-title','block-fill','report-link'], 'touch Top 5 keeps the original icon, title, spacer and all-action as direct native flex siblings');
      }
    };
    assertTouchTopHeaders();
    assert.equal(b.css(b.byClass('top-scroll')[0]).height, '355px', 'original phone 710rpx / minimum340 native host height is retained');
    assert.equal(b.css(walk(b.byClass('top-card')[0]).find(node => hasClass(node, 'song-row'))).height, undefined, 'touch rows retain original rpx/CSS geometry');
    assert.equal(b.css(b.byClass('report-help')[0]).height, undefined); assert.equal(b.css(b.byClass('storage-status')[0]).height, undefined);
    assert.deepEqual(segmentIds(), mountedSegmentIds, 'same-mounted TV-to-touch and resize preserve all six public choice identities');
    for (const cls of ['hero-title','duration-number','stat-num','daily-summary']) assert.equal(b.css(b.byClass(cls)[0])['line-height'], undefined, 'same mounted touch report ' + cls + ' restores original typography');
    b.setWindow({ windowWidth:1280, windowHeight:720 }); await b.flush(); assertTouchTopHeaders(); assert.equal(b.css(b.byClass('top-scroll')[0]).height, '440px', 'original touch wide report height remains440');
  } finally { await b.close(); }
  const empty = await secondaryFixture({ width:1920, height:1080 });
  try { await empty.mount('pages/stats/index.uvue'); assert.ok(empty.text().includes('还没有听歌记录')); assert.equal(empty.byClass('top-scroll').length, 0); assert.ok(hasClass(empty.byClass('scroll')[0], 'qt-tv-scroll'), 'empty statistics still allows its read-only document to scroll'); }
  finally { await empty.close(); }
}

const cases = { 'download-settings':downloadSettingsCase, 'player-bar':playerBarCase, 'source-pack':sourcePackCase, dislikes:dislikesCase, user:userCase, cache:cacheCase, logs:logsCase, permissions:permissionsCase, 'share-card':shareCardCase, about:aboutCase, stats:statsCase };
export { secondaryFixture };
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const selected = process.argv.slice(2);
  for (const [name, run] of Object.entries(cases)) {
    if (selected.length && !selected.includes(name)) continue;
    try { await run(); console.log('PASS', name); }
    catch (error) { console.error('FAIL', name, error.stack ?? error); process.exitCode = 1; }
  }
}
