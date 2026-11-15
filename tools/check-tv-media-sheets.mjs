// Task35 agreed seam: complete production SFC/QtUI -> public native events/remote
// -> unchanged DLNA, media/style, collect-choice, registry and local-mixes/player.
// Frozen list-hosts is imported read-only; only compiler/native SDK, transport,
// file/storage, network, clock and navigation boundaries are substituted.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { toRaw, reactive } from 'vue';
import vm from 'node:vm';
import { listFixture } from './check-tv-list-hosts.mjs';
import { installNativeBoundary } from './check-tv-documents.mjs';
const UI = 'uni_modules/qt-ui/';
const component = name => UI + 'components/' + name + '/' + name + '.uvue';
const noop = () => {};
const walk = node => node == null ? [] : [toRaw(node), ...(node.children ?? []).flatMap(walk)];
const hasClass = (node, name) => String(node.props.class ?? '').split(/\s+/).includes(name);
const text = node => node.text + (node.children ?? []).map(text).join('');
const plain = value => JSON.parse(JSON.stringify(value));
const callable = value => typeof value === 'function' || Array.isArray(value);
const nativeId = node => 'tv:media:page:custom:' + (node.props['data-qt-tv-id'] ?? node.props.id ?? node.sdkId);
async function mediaFixture(options = {}) {
  let b, pending = null;
  const transport = { calls:[], discovery:[], stateListeners:new Set(), connectResult:true, state:null };
  const nativeResponse = {
    audioDlnaDiscover(reply) { transport.calls.push(['discover']); transport.discovery.push(reply); },
    audioDlnaOnState(reply) { transport.calls.push(['state-listener']); transport.stateListeners.add(reply); if (transport.state) reply(transport.state); },
    audioDlnaConnect(id) { transport.calls.push(['connect', id]); return transport.connectResult; },
    audioDlnaActive:() => transport.state?.target === 'dlna', audioDlnaState:() => transport.state,
    audioDlnaDisconnect(local) { transport.calls.push(['disconnect', local]); },
  };
  const descriptor = Object.getOwnPropertyDescriptor(vm, 'runInNewContext');
  const originalRun = descriptor.value;
  // Native/compiler adapter only. The complete production modules still run,
  // and their original require remains authoritative for every other import.
  Object.defineProperty(vm, 'runInNewContext', { ...descriptor, value(program, context, config) {
    const originalRequire = context.require;
    return originalRun.call(vm, program, { ...context, require(request) {
      const value = originalRequire(request);
      return request === '@/uni_modules/qt-audio-player' ? new Proxy(value, { get(target, key) {
        return Object.hasOwn(nativeResponse, key) ? nativeResponse[key] : Reflect.get(target, key);
      } }) : value;
    } }, config);
  } });
  const scrollCalls = [], highlights = [];
  const platform = {
    tvReadDevice:() => ({ television:true, leanback:true, uiModeType:4, nativeAvailable:true }),
    tvStartRemote:noop, tvSetRemoteState:noop, tvStopRemote:noop, tvPresent:noop, tvBack:noop,
    tvCollect:root => walk(root).filter(node => !hasClass(node, 'qt-tv-skip') &&
      (node.props['data-qt-tv-id'] || callable(node.props.onClick) || callable(node.props.onLongpress) || hasClass(node, 'qt-tv-scroll'))).map((node, index) => {
      node.sdkId ??= 'sdk-' + index;
      let list = node; while (list && list.tag !== 'scroll-view' && list.tag !== 'list-view') list = list.parent;
      return { id:nativeId(node), left:30 + (index % 3) * 140, top:40 + Math.floor(index / 3) * 96, width:128, height:76,
        visible:true, enabled:true, input:false, longPress:callable(node.props.onLongpress), scrollGroup:list ? nativeId(list) : '' };
    }),
    tvHighlight:id => highlights.push(id),
    tvScroll(id, direction) { scrollCalls.push({ id, direction }); return true; },
    tvActivate(id, longPress) {
      const target = walk(b.root).find(node => nativeId(node) === id);
      assert.ok(target, 'native activation resolves the live public target');
      pending = b.dispatch(target, longPress ? 'longpress' : 'click');
    },
  };
  try {
    b = await listFixture({ ...options, realFrame:true, boundaryOverrides:{
      'services/music-api':undefined, 'services/tv-platform':platform,
      'services/diag':{ qtDiag:noop, qtDiagDebug:noop }, ...(options.boundaryOverrides ?? {}),
    } });
  } catch (error) { Object.defineProperty(vm, 'runInNewContext', descriptor); throw error; }
  const close = b.close;
  b.close = async () => { try { await close(); } finally {
    Object.defineProperty(vm, 'runInNewContext', descriptor);
    assert.deepEqual(Object.getOwnPropertyDescriptor(vm, 'runInNewContext'), descriptor, 'original compiler boundary restored on every exit');
  } };
  return { ...b, transport, scrollCalls, highlights,
    publishDlna(snapshot) { transport.state = snapshot; for (const reply of transport.stateListeners) reply(snapshot); },
    async focus(node) { assert.ok(node, 'focused public target exists'); b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus(nativeId(node)), true); await b.flush(); },
    async remote(key, repeat = 0) { pending = null; const consumed = b.tv.qtTvDispatchRemote({ key, action:'down', repeat }); if (pending) await pending; await b.flush(); return consumed; },
  };
}
const dlnaDevice = index => ({ id:'udn-' + index, name:'客厅接收器 ' + index, canSeek:true, canSetVolume:true });
const dlnaSnapshot = (deviceId = 'udn-19', error = '') => ({ target:'dlna', deviceId, deviceName:'客厅接收器', mediaId:'', position:12, duration:180, playing:false, volume:0.5, error });
function tvFonts(b, classNames) {
  for (const name of classNames) for (const node of b.byClass(name)) {
    assert.ok(parseFloat(b.css(node)['font-size']) >= 20, name + ' binds actual TV font floor on the native text');
    assert.ok(parseFloat(b.css(node)['line-height']) >= parseFloat(b.css(node)['font-size']), name + ' actual line covers its glyph height');
  }
}
async function dlnaCase() {
  const b = await mediaFixture({ width:480, height:360 });
  const service = b.load('services/dlna.uts');
  try {
    b.fonts.fontScale.setTier('huge');
    await b.mount(component('qt-dlna-sheet'));
    service.openDlna(); await b.flush();
    assert.equal(b.transport.discovery.length, 1, 'real open starts one native discovery');
    b.publishDlna(dlnaSnapshot());
    b.transport.discovery[0](Array.from({ length:20 }, (_, index) => dlnaDevice(index)), '');
    await b.flush(); await b.clock.runTimers(32);
    assert.equal(b.byClass('qo').length, 20, 'real native discovery arrives in the complete production list');
    assert.equal(b.css(walk(b.option('客厅接收器 19')).find(node => hasClass(node, 'qo-label'))).color, '#d93c43', 'UDN current selection is fixed-red, not accent');
    console.log('SETUP PASS dlna complete SFC/native discovery/current selection');
    const list = b.byClass('cast-list')[0];
    // Independent 480x360 huge budget: title39 + subtitle31 + gap3 fit
    // 316px header text width; padding28/border1; footer56+28; inset12/borders2.
    // Any status outside the scroll additionally consumes at least 93px.
    const outside = b.byClass('cast-status').some(node => node.parent !== list) ? 93 : 0;
    const whole = 102 + 84 + 12 + 2 + outside + parseFloat(b.css(list).height);
    assert.ok(whole <= 309.6, '480x360 huge DLNA header/close/footer/status/body fit the actual whole Sheet budget');
    assert.ok(parseFloat(b.css(list).height) >= 76, 'short-screen body still exposes a useful scrollable option viewport');
    assert.ok(hasClass(list, 'qt-tv-scroll'), 'readonly native device scroll is an explicit remote target');
    tvFonts(b, ['cast-status-text', 'qs-title', 'qs-subtitle', 'qo-label', 'qo-description']);
    assert.ok(list.props['scroll-into-view'].endsWith('-19'), 'open and asynchronous device arrival reveal the actual current UDN');
    const current = b.option('客厅接收器 19');
    assert.equal(current.props['data-qt-tv-id'], 'dlna:udn-19', 'native focus identity is the stable device business UDN');
    await b.focus(current); const calls = b.transport.calls.length;
    await b.remote('menu'); assert.equal(b.transport.calls.length, calls, 'Menu on an ordinary device remains a no-op');
    await b.remote('ok', 1); assert.equal(b.transport.calls.length, calls, 'repeated OK does not connect');
    b.transport.connectResult = false; await b.remote('ok');
    assert.equal(service.dlnaUiState().visible.value, true, 'failed native connect retains the real dialog');
    assert.ok(b.text().includes('设备已失效，请刷新设备列表'), 'real connect failure stays visible');
    b.transport.connectResult = true; await b.remote('ok');
    assert.equal(service.dlnaUiState().visible.value, false, 'successful public connect closes via the real service');
    service.openDlna(); b.transport.discovery.at(-1)([], '搜索失败'); await b.flush();
    assert.ok(b.text().includes('搜索失败'), 'native discovery failure follows original error presentation');
    await b.focus(b.button('切回本机')); await b.remote('ok');
    assert.deepEqual(b.transport.calls.at(-1), ['disconnect', true], 'return-to-local keeps the original true native argument');
    service.openDlna(); b.transport.discovery.at(-1)([], ''); await b.flush();
    await b.focus(b.button('断开')); await b.remote('ok');
    assert.deepEqual(b.transport.calls.at(-1), ['disconnect', false], 'disconnect does not silently start local playback');
    service.openDlna(); await b.flush(); await b.remote('back');
    assert.equal(service.dlnaUiState().visible.value, false, 'Back closes the highest real QtSheet owner');
    service.openDlna(); b.transport.discovery.at(-1)([dlnaDevice(1)], ''); await b.flush();
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:390, windowHeight:844 }); await b.clock.runTimers(1000); await b.flush();
    assert.equal(b.css(b.byClass('cast-list')[0]).height, '360px', 'same-mounted phone returns to original list height policy');
    assert.equal(b.byClass('cast-status')[0].parent === b.byClass('cast-list')[0], false, 'same-mounted touch retains original fixed status outside the list');
  } finally { await b.close(); }
}
async function styleCase() {
  const b = await mediaFixture({ width:480, height:360, initialStorage:{ 'qt-playing-style-v1':JSON.stringify({ style:'focus', background:'forest', image:'' }) } });
  const prefs = b.load(UI + 'stores/playing-style.ts');
  const closeEvents = [], props = reactive({ visible:true, cover:'', 'onUpdate:visible':value => closeEvents.push(value) });
  const picks = [], saves = [];
  b.setSdk({ chooseImage(request) { picks.push(request); }, getFileSystemManager:() => ({ saveFile(request) { saves.push(request); } }) });
  try {
    b.fonts.fontScale.setTier('huge'); await b.mount(component('qt-playing-style-sheet'), props);
    assert.equal(b.byClass('ps-card').length, 4, 'all four real preference styles render through the full SFC');
    assert.equal(prefs.usePlayingStyle().style, 'focus', 'real store restores the original style key');
    console.log('SETUP PASS style complete SFC/real saved preference');
    const scroll = walk(b.root).find(node => node.tag === 'scroll-view');
    assert.ok(85 + 12 + 2 + parseFloat(b.css(scroll).height) <= 309.6, '480x360 huge style viewport shares the actual title/close and whole Sheet budget');
    assert.ok(hasClass(scroll, 'qt-tv-scroll'), 'style sheet readonly vertical viewport is a native remote scroll target');
    assert.equal(scroll.props['scroll-into-view'], 'playing-style-focus', 'initial visible mount reveals the actual persisted style card');
    for (const node of b.byClass('qo-swatch')) {
      assert.ok(parseFloat(b.css(node).width) >= 56 && parseFloat(b.css(node).height) >= 56, 'every real background swatch retains a 56px native target');
    }
    assert.equal(b.css(b.byClass('ps-backgrounds')[0])['flex-wrap'], 'wrap', 'seven TV swatches wrap instead of becoming undersized');
    tvFonts(b, ['ps-word', 'ps-note', 'ps-bg-title', 'ps-bg-value', 'qo-label', 'qo-description']);
    const before = b.storageWrites.filter(([key]) => key === 'qt-playing-style-v1').length;
    await b.focus(b.option('歌词律动')); await b.remote('menu'); await b.remote('ok', 1);
    assert.equal(b.storageWrites.filter(([key]) => key === 'qt-playing-style-v1').length, before, 'Menu and repeated OK do not persist a style');
    await b.remote('ok');
    assert.equal(prefs.usePlayingStyle().style, 'rhythm');
    assert.equal(b.storageWrites.filter(([key]) => key === 'qt-playing-style-v1').length, before + 1, 'public remote style selection persists once via the real store');
    prefs.selectPlayingStyle('gallery'); await b.flush();
    assert.equal(scroll.props['scroll-into-view'], 'playing-style-gallery', 'external real style changes reveal their card');
    const image = walk(walk(b.root).find(node => node.props.id === 'playing-bg-image')).find(node => hasClass(node, 'qo'));
    assert.equal(image.props['data-qt-tv-id'], 'playing-background:image', 'image swatch owns a stable native business identity');
    await b.focus(image); await b.remote('ok'); await b.remote('ok');
    assert.equal(picks.length, 1, 'busy gallery selection does not open a second native picker');
    assert.deepEqual(plain(picks[0].sizeType), ['compressed']); assert.equal(picks[0].count, 1);
    picks[0].fail({ errMsg:'cancel' }); await b.flush();
    assert.equal(prefs.usePlayingStyle().background, 'forest', 'gallery cancellation preserves the original background');
    await b.focus(image); await b.remote('ok'); picks.at(-1).success({ tempFilePaths:['unifile://tmp/photo.jpg', 'unifile://tmp/ignored.jpg'] }); await b.flush();
    assert.equal(saves.at(-1).tempFilePath, 'unifile://tmp/photo.jpg', 'real media chooser sends only its first temp file to the original native save');
    saves.at(-1).fail({ errMsg:'disk-full' }); await b.flush();
    assert.equal(prefs.usePlayingStyle().background, 'forest'); assert.equal(prefs.usePlayingStyle().image, '');
    assert.ok(b.toastCalls.some(item => item.title === '背景图片保存失败，请重试'), 'native file failure produces the original toast without persisting a temp path');
    await b.focus(image); await b.remote('ok'); picks.at(-1).success({ tempFilePaths:['unifile://tmp/photo.jpg'] }); await b.flush();
    saves.at(-1).success({ savedFilePath:'unifile://usr/background.jpg' }); await b.flush();
    const saved = JSON.parse(b.storage.get('qt-playing-style-v1'));
    assert.equal(saved.background, 'image'); assert.equal(saved.image, 'unifile://usr/background.jpg');
    assert.equal(scroll.props['scroll-into-view'], 'playing-bg-image', 'real successfully saved image reveals its selected background');
    await b.remote('back'); assert.deepEqual(closeEvents, [false], 'Back emits the original controlled close exactly once'); assert.equal(props.visible, true, 'component emits close rather than rewriting parent input');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:390, windowHeight:844 }); await b.clock.runTimers(1000);
    const touch = b.byClass('qo-swatch'); assert.ok(touch.every(node => parseFloat(b.css(node).width) <= 48), 'same-mounted touch restores original seven swatch dimensions');
    assert.notEqual(b.css(b.byClass('ps-backgrounds')[0])['flex-wrap'], 'wrap', 'phone returns to the original swatch row');
  } finally { await b.close(); }
  const touch = await mediaFixture({ width:390, height:844, savedMode:'touch' }), touchProps = reactive({ visible:true, cover:'' });
  try {
    await touch.mount(component('qt-playing-style-sheet'), touchProps);
    const scroll = touch.byClass('ps-scroll')[0];
    assert.equal(scroll.props['scroll-into-view'], '', 'initial visible touch mount preserves the original non-immediate selection watcher');
    touchProps.visible = false; await touch.flush(); touchProps.visible = true; await touch.flush();
    assert.equal(touch.byClass('ps-scroll')[0].props['scroll-into-view'], 'playing-styles', 'subsequent touch open retains the original two-column reveal anchor');
  } finally { await touch.close(); }
}
const collectionSong = (platform, id, name = '测试同名曲') => ({ platform, id, name, singer:'原歌手', album:'原专辑', duration:180, picUrl:'' });
async function collectCase() {
  const b = await mediaFixture({ width:480, height:360 }), service = b.load('services/collect-choice.ts');
  const existing = collectionSong('wyy', 'old'), incoming = collectionSong('qq', 'new'), free = collectionSong('qq', 'free', '独立新增曲');
  try {
    b.fonts.fontScale.setTier('huge'); await b.mount(component('qt-collect-choice-host'));
    const pending = service.chooseCollectSongs('原歌单', [existing], [incoming, incoming, free]); await b.flush(); await b.clock.runTimers(32);
    assert.equal(service.collectChoiceState().groups.value.length, 1, 'real cross-source matcher creates one group from original title/singer/album');
    assert.equal(b.byClass('qo').length, 2, 'real duplicate policy deduplicates repeated incoming IDs');
    assert.deepEqual(plain(service.collectChoiceState().selected.value), ['wyy:old'], 'real choice defaults to the existing song, not the incoming first candidate');
    console.log('SETUP PASS collect complete SFC/real duplicate grouping/default selection');
    const scroll = b.byClass('choice-list')[0];
    const head = 28 + 1 + Math.max(56, 39 + 2 * 31 + 3);
    const footer = 28 + 56;
    assert.ok(head + footer + 12 + 2 + parseFloat(b.css(scroll).height) <= 309.6, '480x360 huge duplicate selection budgets actual long subtitle/header/close/footer/body together');
    assert.ok(parseFloat(b.css(scroll).height) >= 76, 'short duplicate choice keeps a useful native option viewport');
    assert.ok(hasClass(scroll, 'qt-tv-scroll'), 'choice scroll participates in native directional navigation');
    assert.ok(scroll.props['scroll-into-view'].endsWith('-1'), 'initial choice reveals the existing second candidate');
    tvFonts(b, ['choice-group-title', 'qo-label', 'qo-description']);
    const originalAnchor = scroll.props['scroll-into-view'], boxes = b.byClass('qt-checkbox');
    assert.ok(boxes.every(node => parseFloat(b.css(node).width) >= 56 && parseFloat(b.css(node).height) >= 56));
    assert.equal(boxes[1].props['data-qt-tv-id'], 'collect-check:wyy:old', 'checkbox identity uses the stable platform/song key');
    await b.focus(boxes[1]); await b.remote('menu'); await b.remote('ok', 1);
    assert.deepEqual(plain(service.collectChoiceState().selected.value), ['wyy:old'], 'Menu/repeated OK leave multiselection unchanged');
    await b.remote('ok');
    assert.deepEqual(plain(service.collectChoiceState().selected.value), [], 'public checkbox click toggles once and stops the surrounding Option event');
    assert.equal(scroll.props['scroll-into-view'], originalAnchor, 'user toggle never steals scroll back to the initial existing candidate');
    assert.ok(b.text().includes('每组至少保留一个版本'));
    const save = b.button('保存选择'); assert.ok(hasClass(save, 'qt-tv-skip'), 'invalid save is not focusable');
    await b.dispatch(save); assert.equal(service.collectChoiceState().visible.value, true, 'disabled save keeps the actual pending Promise open');
    const invalidHead = head, invalidFooter = 28 + 56 + 30 + 8;
    assert.ok(invalidHead + invalidFooter + 12 + 2 + parseFloat(b.css(scroll).height) <= 309.6, 'real validation feedback grows footer and shrinks the same native viewport');
    await b.focus(boxes[0]); await b.remote('ok');
    assert.deepEqual(plain(service.collectChoiceState().selected.value), ['qq:new']);
    await b.focus(b.button('保存选择')); await b.remote('ok'); const plan = await pending;
    assert.deepEqual(plain(plan.adds.map(service.collectKey)), ['qq:new', 'qq:free'], 'original chosen new version and independent incoming song are added in policy order');
    assert.deepEqual(plain(plan.removes.map(service.collectKey)), ['wyy:old'], 'only the deselected preexisting duplicate is removed');
    const first = service.chooseCollectSongs('旧请求', [existing], [incoming]); await b.flush();
    const second = service.chooseCollectSongs('新请求', [existing], [incoming]); await b.flush();
    assert.equal(await first, null, 'opening another real request cancels the previous pending Promise');
    await b.remote('back'); assert.equal(await second, null, 'highest QtSheet Back returns the original null cancellation contract');
    const third = service.chooseCollectSongs('触摸恢复', [], [existing, incoming]); await b.flush();
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:390, windowHeight:844 }); await b.clock.runTimers(1000);
    assert.equal(parseFloat(b.css(b.byClass('choice-list')[0]).height), 420, 'same-mounted phone restores original 420px duplicate viewport cap');
    await b.dispatch(b.button('取消')); assert.equal(await third, null);
  } finally { service.finishCollectChoice(false); await b.close(); }
}
// Exact UTS realm adapter: Node loader mechanics only, with descriptor cleanup.
function installCompilerBoundary(b) {
  const http = b.load('services/http.ts'), prototype = Object.getPrototypeOf(http.parseJsonToUtso('{}'));
  const accessors = [['getString','string'], ['getNumber','number'], ['getBoolean','boolean']];
  const descriptors = accessors.map(([name]) => [name, Object.getOwnPropertyDescriptor(prototype, name)]);
  const realms = [], close = b.close;
  const restore = () => {
    for (const { json, parse } of realms) { json.parse = parse; assert.equal(json.parse, parse, 'original exact UTS JSON parser restored'); }
    for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(prototype, name, descriptor); else delete prototype[name]; assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, name), descriptor, 'original typed UTS accessor restored'); }
  };
  // Register cleanup before the first descriptor/parser mutation, including partial setup failure.
  b.close = async () => { try { await close(); } finally { restore(); } };
  try {
    for (const [name, type] of accessors) Object.defineProperty(prototype, name, { configurable:true, value(key) { const value = this.get(key); return typeof value === type ? value : null; } });
    for (const [path, name] of [['services/source-pack-header.uts','parsePackHeader'], ['services/source-engine.uts','sourceEngineEpoch']]) {
      const json = b.load(path)[name].constructor('return JSON')(), parse = json.parse;
      realms.push({ json, parse }); json.parse = input => http.parseJsonToUtso(input);
    }
  } catch (error) { restore(); throw error; }
}
const registryData = { sourcePolicyVersion:1, sources:[
  { id:'wyy', name:'包侧网易云', short:'网', color:'#c73044', qualities:['320','flac'] },
  { id:'qq', name:'包侧QQ音乐', short:'Q', color:'#248a58', qualities:['128','320','flac'] },
  { id:'kg', name:'原已关闭平台', short:'酷', color:'#2778ca', qualities:['320'] },
], qualities:[{ id:'128', name:'基本音质' }, { id:'320', name:'标准音质' }, { id:'flac', name:'无损音质' }] };
async function sourceCase() {
  const native = installNativeBoundary({ engineReply(name) {
    if (name === 'sourceRegistry') return registryData;
    if (name === 'getSourceQualities') return { mode:'platform', qualities:[], aliases:{} };
  } });
  const b = await mediaFixture({ width:480, height:360, initialStorage:{ 'source.platformPolicy.v1':JSON.stringify({ version:1, enabled:['wyy','qq'], order:['qq','wyy'] }) },
    boundaryOverrides:{ 'uni_modules/qt-app-native':native.sdk, 'uni_modules/qt-js-engine':native.sdk } });
  try {
    installCompilerBoundary(b);
    const registry = b.load('stores/source-registry.ts').useSourceRegistryStore();
    const playbackBefore = b.player.playbackRevision(), events = [], props = reactive({ visible:true, source:'wyy', quality:'flac', local:false, podcast:false,
      'onUpdate:visible':value => events.push(['visible', value]), onSource:id => events.push(['source', id]), onQuality:id => events.push(['quality', id]) });
    await registry.ensure(); await b.flush();
    assert.equal(registry.ready, true, 'original native state/header/meta engine boots and real registry becomes ready');
    assert.deepEqual(plain(registry.sources.map(item => item.id)), ['qq','wyy'], 'real persisted source policy preserves priority and excludes the disabled source');
    assert.ok(native.calls.some(call => call.name === 'loadBundle') && native.calls.some(call => call.name === 'getSourceQualities'), 'real boot and quality-profile orchestration cross only the SDK callback boundary');
    b.fonts.fontScale.setTier('huge'); await b.mount(component('qt-playback-source-sheet'), props); await b.clock.runTimers(32);
    assert.equal(b.byClass('qo').length, 4, 'original two enabled sources and current source subset render without a fake business registry');
    console.log('SETUP PASS source complete SFC/real native meta registry/policy/quality');
    const body = b.byClass('pso-body')[0];
    assert.ok(28 + 39 + 62 + 3 + 1 + 12 + 2 + parseFloat(b.css(body).height) <= 309.6, '480x360 huge source sheet reserves actual two-line subtitle/header/close and body in one budget');
    for (const heading of b.byClass('pso-heading')) assert.ok(parseFloat(b.css(heading).height) >= 36, 'huge actual23.4px headings own their full line rather than fixed28px');
    const lists = b.byClass('pso-list');
    assert.ok(lists.every(node => hasClass(node, 'qt-tv-scroll')), 'source and quality columns are independent native remote scroll targets');
    assert.ok(lists.every(node => parseFloat(b.css(node).height) >= 76), 'short whole-Sheet budget retains useful option viewports');
    assert.ok(lists[0].props['scroll-into-view'].endsWith('-1') && lists[1].props['scroll-into-view'].endsWith('-1'), 'opening reveals the actual current source and quality in independent lists');
    tvFonts(b, ['pso-heading', 'qo-label']);
    assert.equal(b.option('包侧QQ音乐').props['data-qt-tv-id'], 'playback-source:qq');
    assert.equal(b.option('无损音质').props['data-qt-tv-id'], 'playback-quality:flac');
    await b.focus(b.option('包侧QQ音乐')); await b.remote('menu'); await b.remote('ok', 1); assert.deepEqual(events, []);
    await b.remote('ok'); assert.deepEqual(events, [['visible', false], ['source', 'qq']], 'native source selection emits original platform ID once and closes without playing or mutating browsing source');
    assert.equal(b.player.playbackRevision(), playbackBefore, 'source choice never issues a real player playback request');
    assert.equal(b.nativeCalls.filter(call => call.name === 'audioSetPlaylist').length, 0, 'source choice never pushes a native audio timeline');
    events.length = 0; props.source = 'qq'; props.quality = '128'; await b.flush(); await b.clock.runTimers(32);
    assert.ok(lists[0].props['scroll-into-view'].endsWith('-0') && lists[1].props['scroll-into-view'].endsWith('-0'), 'external source/quality changes reveal their live native rows');
    await b.focus(b.option('标准音质')); await b.remote('ok'); assert.deepEqual(events, [['visible', false], ['quality', '320']], 'quality selection emits the exact package ID once');
    events.length = 0; props.source = 'missing'; props.quality = 'missing'; await b.flush(); await b.clock.runTimers(32);
    assert.equal(lists[0].props['scroll-into-view'], ''); assert.equal(lists[1].props['scroll-into-view'], '');
    assert.equal(b.byClass('qo-selected').length, 0, 'invalid IDs mean no selected source or quality');
    await b.remote('back'); assert.deepEqual(events, [['visible', false]], 'Back closes only the highest source Sheet and emits no source/quality command');
    events.length = 0; props.local = true; props.fileText = 'FLAC 44.1kHz'; await b.flush(); await b.clock.runTimers(32);
    assert.ok(b.option('本地文件')); assert.equal(b.option('包侧QQ音乐').props.onClick != null, true);
    await b.dispatch(b.option('包侧QQ音乐')); assert.deepEqual(events, [], 'local-file capability still disables source switching');
    props.local = false; props.podcast = true; await b.flush(); await b.clock.runTimers(32);
    assert.equal(b.byClass('pso-list').length, 1); assert.ok(b.option('播客音频'));
    tvFonts(b, ['pso-note']);
    await b.focus(b.option('播客音频')); await b.remote('ok'); assert.deepEqual(events, [['visible', false]], 'podcast special option only closes, preserving supplied-audio semantics');
    b.tv.qtSetTvMode('touch'); b.setWindow({ windowWidth:390, windowHeight:844 }); await b.clock.runTimers(1000);
    assert.equal(hasClass(b.byClass('pso-list')[0], 'qt-tv-scroll'), false, 'same-mounted phone returns to original independent scroll layout');
    assert.equal(b.player.playbackRevision(), playbackBefore); assert.equal(b.nativeCalls.filter(call => call.name === 'audioSetPlaylist').length, 0, 'all source/quality/Back/special choices leave playback untouched');
  } finally { await b.close(); }
}
async function localMixesCase() {
  const now = Date.parse('2026-11-15T01:00:00+08:00'), recent = Date.parse('2026-11-14T23:00:00+08:00'), old = Date.parse('2026-09-01T23:00:00+08:00');
  const songs = Array.from({ length:12 }, (_, index) => ({ platform:'local', id:'mix-' + index, name:'原本地合辑歌曲' + index, singer:'原歌手' + index, album:'原专辑', duration:180,
    picUrl:index === 0 ? '/storage/emulated/0/bare-cover.jpg' : index === 1 ? 'content://owned-art/1' : index === 2 ? 'unifile://usr/art.jpg' : index === 3 ? '/static/cover.png' : 'https://owned-cover.invalid/' + index + '.png' }));
  const stats = songs.map((song, index) => ({ song, count:16-index, effectiveCount:16-index, legacyCount:0, seconds:360, completed:2, firstPlayedAt:old-1000,
    lastPlayedAt:(index < 6 ? recent : old) - index * 1000 }));
  const liked = songs.slice(0, 6).map(song => ({ ...song, pids:['kept-list'] })); liked.push({ ...songs[6], pids:['removed-list'] });
  const localItems = songs.slice(1).map(song => ({ id:song.id, title:song.name, singer:song.singer, album:song.album, duration:song.duration,
    uri:'content://owned-audio/' + song.id, path:'/owned-media/' + song.id + '.flac' }));
  const native = installNativeBoundary(), sdk = { ...native.sdk, statLocalFile:path => localItems.some(item => item.uri === path) ? 1 : -1 };
  const b = await mediaFixture({ width:480, height:360, initialStorage:{ 'qt-local-audio-v1':localItems },
    boundaryOverrides:{ 'uni_modules/qt-app-native':sdk, 'uni_modules/qt-js-engine':sdk } });
  const business = b.load('services/local-mixes.ts'), player = b.load('stores/player.ts').usePlayerStore();
  const mixes = business.buildLocalMixes(stats.concat(stats[0]), liked, ['kept-list'], now);
  const props = reactive({ mixes, cardWidth:156, contentWidth:288 });
  try {
    assert.deepEqual(plain(mixes.map(mix => mix.key)), ['recent','most_played','favorite_picks','late_night','nostalgic'], 'real builder keeps original fixed five-category order and input-key dedup');
    assert.deepEqual(plain(mixes[0].songs.map(song => song.id)), ['mix-0','mix-1','mix-2','mix-3','mix-4','mix-5'], 'real recent mix retains newest-first order');
    assert.deepEqual(plain(mixes[2].songs.map(song => song.id)), ['mix-0','mix-1','mix-2','mix-3','mix-4','mix-5'], 'only songs intersecting existing favorite playlists enter the original favorite mix');
    assert.equal(business.buildLocalMixes(stats, liked, [], now).some(mix => mix.key === 'favorite_picks'), false, 'deleted-playlist likes do not reappear as favorite recommendations');
    assert.equal(business.shouldShowLocalMixes(false, mixes), false); assert.equal(business.shouldShowLocalMixes(true, mixes.slice(0,1)), false); assert.equal(business.shouldShowLocalMixes(true, mixes.slice(0,2)), true);
    assert.deepEqual(plain(mixes[0].coverUrls), ['content://owned-art/1','unifile://usr/art.jpg','/static/cover.png','https://owned-cover.invalid/4.png'], 'real builder skips bare native paths and retains four accepted cover URIs');
    b.fonts.fontScale.setTier('huge'); await b.mount('F:/qtMusic/_tmp/tv-media-sheets/local-mixes-host.uvue', props); b.audio.audioPlayer.setGapless(false);
    assert.equal(b.byClass('local-mix-card').length,5, 'actual QtPageFrame mounts the full original local-mixes SFC');
    const rail = b.byClass('local-mixes-rail')[0], cards = b.byClass('local-mix-card');
    assert.equal(b.css(rail).width,'288px'); assert.ok(cards.every(node => b.css(node).width === '156px'), 'consumer-provided widths remain authoritative in a narrow TV pane');
    assert.equal(b.byClass('local-mix-cover-cell').length,20); assert.equal(b.byClass('local-mix-cover').length,20);
    console.log('SETUP PASS localmixes complete SFC/real Frame/real fixed-order builder');
    assert.ok(parseFloat(b.css(rail).height) >= 275 && b.byClass('local-mix-name').every(node => parseFloat(b.css(node)['line-height']) >= 38) && b.byClass('local-mix-subtitle').every(node => parseFloat(b.css(node)['line-height']) >= 33), '480px huge native shelf budgets two actual title lines and one subtitle below its consumer cover');
    tvFonts(b,['local-mixes-title','local-mixes-hint','local-mix-name','local-mix-subtitle']);
    assert.ok(hasClass(rail,'qt-tv-scroll')); assert.equal(cards[0].props['data-qt-tv-id'],'local-mix:recent', 'shelf card owns its original category business identity');
    await b.focus(cards[0]); const before = player.playbackRevision(); await b.remote('menu'); await b.remote('ok',1); assert.equal(b.byClass('local-mix-sheet').length,0);
    await b.remote('ok'); assert.equal(b.byClass('local-mix-sheet').length,1); assert.equal(player.playbackRevision(),before, 'opening a recommendation never starts playback');
    assert.equal(b.tv.qtTvHasModal(),true,'special drawer registers its actual panel as the highest native modal owner');
    const panel=b.byClass('local-mix-sheet')[0], mask=b.byClass('local-mix-mask')[0];
    assert.equal(hasClass(mask,'local-mix-mask-wide'),true,'wide drawer remains right-docked by its original native class rather than a newly centered ordinary sheet'); assert.ok(parseFloat(b.css(panel).height)<=360);
    assert.ok(hasClass(panel,'qt-tv-skip') && hasClass(mask,'qt-tv-skip'), 'non-action drawer and mask nodes do not consume native OK');
    const close = walk(panel).find(node => node.props['data-qt-tv-id'] === 'local-mix:close');
    assert.ok(close && parseFloat(b.css(close).width)>=56 && parseFloat(b.css(close).height)>=56,'close owns a genuine 56px native target');
    const playAll=b.byClass('local-mix-play-all')[0]; assert.ok(parseFloat(b.css(playAll).height)>=56,'original play-all target remains 56px on TV');
    const list=b.byClass('local-mix-song-list')[0]; assert.ok(hasClass(list,'qt-tv-scroll'),'special drawer song viewport is a native remote scroll group');
    const row=b.byClass('local-mix-song-row')[2]; assert.equal(row.props['data-qt-tv-id'],'local-mix-song:recent:local:mix-2');
    assert.ok(b.byClass('local-mix-song-row').every(node=>parseFloat(b.css(node).height)>=91),'huge songs keep shared actual-font row budget');
    tvFonts(b,['local-mix-sheet-title','local-mix-sheet-subtitle','local-mix-play-all-text','local-mix-song-index','local-mix-song-name','local-mix-song-singer']);
    // Independent huge typography: title46 + subtitle33 + gap4; header padding28/border1 =112.
    // The56px close is shorter than that83px text stack; play-all56 + margins12/8 =76.
    assert.ok(112+76+parseFloat(b.css(list).height)<=parseFloat(b.css(panel).height),'360px drawer budgets actual header/close plus play-all margins and list together');
    assert.ok(parseFloat(b.css(list).height)>=76, 'short drawer retains at least one useful remote song viewport');
    b.fonts.fontScale.setTier('normal'); await b.flush(); assert.equal(b.css(row).height,'76px','same-mounted standard TV font returns to the shared76px row');
    b.fonts.fontScale.setTier('huge'); await b.flush();
    await b.focus(row); await b.remote('menu'); await b.remote('ok',1); assert.equal(player.playbackRevision(),before);
    await b.remote('ok'); assert.equal(player.playbackRevision(),before+1,'one public native song activation requests real report playback once'); assert.equal(player.current.id,'mix-2'); assert.equal(player.current.url,'content://owned-audio/mix-2');
    assert.deepEqual(plain(player.queue.map(song=>song.id)),['mix-1','mix-2','mix-3','mix-4','mix-5'],'real report player skips missing local URI but retains original remaining order');
    const pushed=b.nativeCalls.filter(call=>call.name==='audioSetPlaylist').at(-1); assert.ok(pushed, 'real timeline native calls=' + b.nativeCalls.map(call=>call.name).join(',') + '; public errors=' + JSON.stringify(plain(b.toastCalls))); assert.equal(pushed.args[1],1,'native timeline start index follows the exact selected song after original URI restoration/filtering');
    assert.equal(plain(pushed.args[0])[1].uri,'content://owned-audio/mix-2'); assert.equal(b.byClass('local-mix-sheet').length,0,'original song activation closes the drawer');
    await b.focus(b.byClass('local-mix-card')[0]); await b.remote('ok'); await b.focus(b.byClass('local-mix-play-all')[0]); await b.remote('ok'); assert.equal(player.current.id,'mix-1','original play-all starts at the first actually playable URI'); assert.equal(player.playbackRevision(),before+2);
    await b.focus(b.byClass('local-mix-card')[0]); await b.remote('ok'); await b.remote('back'); assert.equal(b.byClass('local-mix-sheet').length,0); assert.equal(player.playbackRevision(),before+2,'Back closes the drawer without activating a song'); assert.equal(b.tv.qtTvHasModal(),false);
    await b.focus(b.byClass('local-mix-card')[0]); await b.remote('ok'); b.tv.qtSetTvMode('touch'); b.setWindow({windowWidth:390,windowHeight:844}); await b.clock.runTimers(1000);
    assert.equal(b.css(b.byClass('local-mix-mask')[0])['flex-direction'],undefined,'same-mounted phone restores original bottom drawer placement'); assert.equal(b.css(b.byClass('local-mix-song-row')[0]).height,undefined,'phone drops the TV inline height and restores the original116rpx row class'); assert.equal(hasClass(b.byClass('local-mix-song-row')[0],'local-mix-song-row-wide'),false); assert.equal(hasClass(b.byClass('local-mix-song-list')[0],'qt-tv-scroll'),false);
    assert.equal(b.css(b.byClass('local-mix-card')[0]).width,'156px','touch preserves the same consumer cardWidth contract');
  } finally { await b.close(); }
}
async function compilerCleanupCheck() {
  const originalVm = Object.getOwnPropertyDescriptor(vm, 'runInNewContext'), native = installNativeBoundary();
  const b = await mediaFixture({ boundaryOverrides:{ 'uni_modules/qt-app-native':native.sdk, 'uni_modules/qt-js-engine':native.sdk } });
  let adapted = b;
  try {
    const prototype = Object.getPrototypeOf(b.load('services/http.ts').parseJsonToUtso('{}'));
    const before = ['getString','getNumber','getBoolean'].map(name => [name, Object.getOwnPropertyDescriptor(prototype, name)]);
    const json = b.load('services/source-pack-header.uts').parsePackHeader.constructor('return JSON')(), originalParse = json.parse;
    const failed = new Error('owned compiler second-realm setup failure');
    // Compiler-loader fault only; no production business service or handler is replaced.
    adapted = { ...b, load(path) { if (path === 'services/source-engine.uts') throw failed; return b.load(path); } };
    assert.throws(() => installCompilerBoundary(adapted), error => error === failed, 'partial compiler setup preserves its original error');
    assert.equal(json.parse, originalParse, 'partial compiler failure restores the already-modified first JSON realm');
    for (const [name, descriptor] of before) assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, name), descriptor, 'partial compiler failure restores every original accessor');
  } finally { await adapted.close(); }
  assert.deepEqual(Object.getOwnPropertyDescriptor(vm, 'runInNewContext'), originalVm, 'partial compiler setup also restores the outer VM boundary');
  console.log('PASS compiler boundary partial-failure cleanup');
}
const cases = { dlna:dlnaCase, style:styleCase, collect:collectCase, source:sourceCase, localmixes:localMixesCase };
export async function runTvMediaSheetsChecks(selected = 'all') {
  if (selected === 'all' || selected === 'source') await compilerCleanupCheck();
  for (const [name, run] of Object.entries(cases)) if (selected === 'all' || selected === name) { await run(); console.log('PASS ' + name); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await runTvMediaSheetsChecks(process.argv[2] ?? 'all'); } catch (error) { console.error(error); process.exitCode = 1; }
}
