// task-30 agreed seam: complete production pages/QtUI + public native events + real services.
// Read-only import of the frozen task-25 loader. Network, native collection/rectangles,
// scrolling/activation/navigation, files, viewport/lifecycle and clock are boundary fixtures.
// No private handlers/setup exports, copied business computations or mocked pages/stores.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { listFixture } from './check-tv-list-hosts.mjs';
import { toRaw } from 'vue';

const noop = () => {};
function installNativeElementBoundary(root) {
  // The frozen renderer's native node lacks UniElement.animate. Decorate SDK nodes on
  // insertion, before the real component's nextTick callback, including recycled children.
  const seen = new WeakSet(), animations = [];
  function decorate(node) {
    node = toRaw(node); if (seen.has(node)) return; seen.add(node);
    // UniElement public SDK properties used by the real hosted Frame ancestor walk.
    Object.defineProperty(node, 'classList', { configurable:true, get:() => String(node.props.class ?? '').split(/\s+/).filter(Boolean) });
    Object.defineProperty(node, 'parentElement', { configurable:true, get:() => node.parent });
    if (!node.animate) node.animate = (frames, options) => {
      const receipt = { node, frames, options, cancelled:false }; animations.push(receipt);
      return { cancel() { receipt.cancelled = true; } };
    };
    const children = node.children, push = children.push, splice = children.splice;
    Object.defineProperty(children, 'push', { configurable:true, value(...items) { items.forEach(decorate); return push.apply(this, items); } });
    Object.defineProperty(children, 'splice', { configurable:true, value(...args) { args.slice(2).forEach(decorate); return splice.apply(this, args); } });
    children.forEach(decorate);
  }
  decorate(root); return animations;
}
function installUtsCompilerBoundary(b) {
  // SDK/compile semantics only: the frozen JS loader does not implement UTS typed accessors
  // or the .uts-only JSON.parse -> UTS.JSON.parse transform. No service is replaced.
  const http = b.load('services/http.ts'), proto = Object.getPrototypeOf(http.parseJsonToUtso('{}'));
  const old = Object.fromEntries(['getString', 'getNumber', 'getBoolean'].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)]));
  for (const [key, type] of [['getString', 'string'], ['getNumber', 'number'], ['getBoolean', 'boolean']]) {
    Object.defineProperty(proto, key, { configurable:true, value(name) { const value = this.get(name); return typeof value === type ? value : null; } });
  }
  const realms = [['services/source-pack-header.uts', 'parsePackHeader'], ['services/source-engine.uts', 'sourceEngineEpoch']].map(([path, key]) => {
    const exported = b.load(path)[key];
    const json = exported.constructor('return JSON')(), parse = json.parse;
    json.parse = text => http.parseJsonToUtso(text);
    return { json, parse };
  });
  return () => {
    for (const { json, parse } of realms) json.parse = parse;
    for (const [key, descriptor] of Object.entries(old)) { if (descriptor) Object.defineProperty(proto, key, descriptor); else delete proto[key]; }
  };
}
function installedDataBoundary({ responses = {}, failures = {} } = {}) {
  const calls = [], files = new Map(), id = 'meta-fixture';
  const pack = { id, kind:'meta', name:'测试数据包', versionCode:1, versionName:'1.0', updateUrl:'', installedAt:1, updatedAt:1, skipCodes:[] };
  files.set('/owned-fixture/source-bundle/state.json', JSON.stringify({ schema:3, packs:[pack], activeId:'', activeMetaId:id, lastCheckAt:0 }));
  files.set('/owned-fixture/source-bundle/install/' + id + '/meta-bundle.js', '/*__QT_PACK__' + JSON.stringify(pack) + '*/\nexport default {};');
  const response = (name, args) => {
    if (Object.hasOwn(responses, name)) return responses[name];
    if (name === 'bundleInfo') return { name:'meta-bundle', hostApiVersion:1, metaRevision:1, sourcePolicyVersion:1 };
    if (name === 'setSourcePolicy') return { ok:true, playSupported:true };
    if (name === 'sourceRegistry') return { sourcePolicyVersion:1, sources:[{ id:'wyy', name:'验证音源', short:'验', color:'#248A58', features:{ playlists:true, charts:true, latest:true }, playlistSorts:[{ id:'hot', name:'热门' }, { id:'new', name:'最新' }] }], qualities:[{ id:'320', name:'标准' }] };
    if (name === 'getSourceQualities') return { source:'wyy', mode:'platform', qualities:[{ id:'320', name:'标准' }] };
    if (name === 'playlistCategories') return { list:[{ id:'pop', name:'流行' }, { id:'rnb', name:'R&amp;B' }] };
    if (name === 'recommendations') return { list:args.page > 1 ? [] : Array.from({ length:7 }, (_, i) => ({ id:'list-' + i, platform:'wyy', name:'真实契约歌单' + (i + 1), picUrl:'https://data.fixture.invalid/' + i + '.png', playCount:'23000' })) };
    if (name === 'charts' || name === 'allCharts') return { list:Array.from({ length:6 }, (_, i) => ({ id:'chart-' + i, platform:'wyy', name:'真实榜单' + (i + 1), picUrl:'https://data.fixture.invalid/chart-' + i + '.png', description:'榜单原描述' })) };
    if (name === 'chartDetail') return { list:Array.from({ length:3 }, (_, i) => ({ id:args.chart.id + '-song-' + i, name:'榜单公开歌曲' + (i + 1), singer:'原歌手', album:'原专辑', picUrl:'', interval:180 })) };
    if (name === 'latest') return { list:Array.from({ length:8 }, (_, i) => ({ id:'latest-' + i, name:'首页公开新歌' + (i + 1), singer:'原新歌歌手', album:'原新歌专辑', picUrl:'', interval:180 })) };
    return {};
  };
  const sdk = { dataDir:() => '/owned-fixture',
    readTextFile(path, reply) { calls.push({ name:'readTextFile', path }); files.has(path) ? reply(true, files.get(path), '') : reply(false, '', 'fixture file absent'); },
    exists:(path, reply) => reply(true, files.has(path) ? '1' : '0', ''),
    start:(_options, reply) => reply({ engine:'Fixture Native Engine', version:'1', hostApiVersion:1, probe:'native callback' }, null),
    stop:reply => reply({ ok:true, error:'' }), isRunning:() => true, isHealthy:() => true,
    loadBundle(code, reply) { calls.push({ name:'loadBundle', code }); reply({ ok:true, error:'' }); },
    evaluate:(_code, reply) => reply({ ok:true, value:'null', error:'' }),
    invoke(name, argsJson, _timeout, reply) { const args = JSON.parse(argsJson)[0] ?? {}; calls.push({ name, args }); if (Object.hasOwn(failures, name)) reply({ ok:false, value:'', error:failures[name] }); else reply({ ok:true, value:JSON.stringify(response(name, args)), error:'' }); },
  };
  return { sdk, calls, files };
}
const walk = node => { node = toRaw(node); return [node, ...node.children.flatMap(walk)]; };
const hasClass = (node, name) => String(node.props.class ?? '').split(/\s+/).includes(name);
const textOf = node => node.text + node.children.map(textOf).join('');
const nativeScrollable = node => ['scroll-view', 'list-view'].includes(node.tag);
function nativeBoundary() {
  let b = null, serial = 0, registry = new Map(), pending = [];
  const ids = new WeakMap(), scrollOffsets = new WeakMap(), scrollExtents = new Map();
  const collected = [], scrollCalls = [], highlights = [], activations = [];
  function id(node) {
    if (node.props['data-qt-tv-id']) return node.props['data-qt-tv-id'];
    if (!ids.has(node)) ids.set(node, 'native-node:' + ++serial);
    return ids.get(node);
  }
  function scrollParent(node) {
    for (let n = hasClass(node, 'qt-tv-scroll') ? node : node.parent; n; n = n.parent) if (nativeScrollable(n)) return n;
    return null;
  }
  function hidden(node) {
    for (let n = node; n; n = n.parent) {
      const style = b.css(n);
      if (style.display === 'none' || style.visibility === 'hidden' || String(style.opacity) === '0') return true;
    }
    return false;
  }
  const platform = {
    tvReadDevice:() => ({ television:true, leanback:true, uiModeType:4, nativeAvailable:true }),
    tvStartRemote:noop, tvSetRemoteState:noop, tvStopRemote:noop, tvPresent:noop,
    tvBack() {
      // performTvBack uses Activity.onBackPressed, which dispatches the public page lifecycle.
      for (const handler of [...b.lifecycle.backPress].reverse()) if (handler({ from:'backbutton' })) return;
      b.routes.push({ action:'native-back' });
    },
    tvCollect(root) {
      registry = new Map();
      const candidates = root == null ? [] : walk(root).filter(n => !hasClass(n, 'qt-tv-skip') && !hidden(n) &&
        (n.props.onClick || n.props.onTap || n.props.onLongpress || ['input', 'textarea'].includes(n.tag) || (hasClass(n, 'qt-tv-scroll') && nativeScrollable(n))));
      const result = candidates.map((n, i) => {
        const key = id(n), group = scrollParent(n); registry.set(key, n);
        return { id:key, left:20, top:40 + i * 100, width:300, height:56,
          visible:true, enabled:n.props.disabled !== true && n.props.disabled !== 'true',
          input:['input', 'textarea'].includes(n.tag), longPress:!!n.props.onLongpress, scrollGroup:group ? id(group) : '' };
      });
      collected.push({ root, result }); return result;
    },
    tvHighlight:(key, color) => highlights.push({ key, color }),
    tvActivate(key, longPress) {
      const n = registry.get(key); assert.ok(n, 'native activation uses the currently collected rendered node');
      activations.push({ key, longPress });
      if (hasClass(n, 'qt-tv-scroll') && nativeScrollable(n)) return;
      pending.push(b.dispatch(n, longPress ? 'longpress' : n.props.onTap ? 'tap' : 'click'));
    },
    tvScroll(key, direction) {
      const n = registry.get(key), target = n && scrollParent(n);
      if (!target || (direction !== 'up' && direction !== 'down')) return false;
      const entry = [...scrollExtents].find(([name]) => hasClass(target, name));
      const extent = entry?.[1] ?? 0, before = scrollOffsets.get(target) ?? 0;
      const after = Math.max(0, Math.min(extent, before + (direction === 'down' ? 280 : -280)));
      scrollCalls.push({ key, direction, target, before, after });
      scrollOffsets.set(target, after); return after !== before;
    },
  };
  return { platform, collected, scrollCalls, highlights, activations,
    bind(value) { b = value; }, id, scrollExtent:(name, px) => scrollExtents.set(name, px),
    offset:node => scrollOffsets.get(node) ?? 0,
    async drain() { for (const job of pending.splice(0)) await job; await b.flush(); },
  };
}
async function fixture({ notices = [], center = notices, savedMode = 'tv', width = 1280, height = 720,
  routeOptions = {}, realFrame = true, rectangles = {}, ...options } = {}) {
  const boundary = nativeBoundary(), requests = [], external = [], taskMoves = [];
  const sdk = { publicDataDir:() => '', dataDir:() => '/owned-fixture', queryPermissionStates:() => [],
    statLocalFile:() => -1, readEmbeddedTags:() => null,
    readTextFile:(_path, reply) => reply(false, '', 'fixture file absent'), exists:(_path, reply) => reply(true, '0', ''),
    start:() => false, isRunning:() => false, isHealthy:() => false,
    openExternalUrl:url => { external.push(url); return true; },
    exitAppNative:() => { taskMoves.push('exit'); return true; },
    moveAppToBackgroundNative:async () => { taskMoves.push('background'); return true; } };
  const b = await listFixture({ width, height, savedMode, routeOptions, realFrame, ...options,
    boundaryOverrides:{ 'services/music-api':undefined, 'services/tv-platform':boundary.platform, 'uni_modules/qt-app-native':sdk, ...options.boundaryOverrides },
    sdkOverrides:{ request(request) {
      requests.push({ url:request.url, method:request.method, headers:request.header, data:request.data });
      const data = request.url.includes('/message/active') ? notices : request.url.includes('/message/center') ? center : request.url.includes('/message/unread') ? 0 : [];
      request.success?.({ statusCode:200, data:JSON.stringify({ code:200, data }) });
    }, getDeviceInfo:() => ({ deviceBrand:'Fixture', deviceModel:'TV', osName:'Android', osVersion:'13' }),
    getAppBaseInfo:() => ({ appVersionCode:300, appVersion:'3.0.0' }), ...options.sdkOverrides },
  });
  boundary.bind(b);
  const animations = installNativeElementBoundary(b.root);
  const restoreCompiler = installUtsCompilerBoundary(b);
  const navSdk = {};
  for (const [name, action] of [['switchTab', 'switch-tab'], ['reLaunch', 'relaunch'], ['navigateTo', 'navigate'], ['redirectTo', 'redirect'], ['navigateBack', 'back']]) {
    if (!options.sdkOverrides?.[name]) navSdk[name] = value => { b.routes.push({ action, ...value }); value.success?.({}); value.complete?.({}); };
  }
  b.setSdk(navSdk);
  const nativeRectangles = new Map(Object.entries(rectangles));
  b.setSdk({ createSelectorQuery() {
    let selector = ''; const queries = [];
    return { in() { return this; }, select(value) { selector = value; return this; },
      boundingClientRect(reply) { queries.push({ selector, reply }); return this; },
      exec(done) { b.measurements.push(() => { const values = queries.map(({ selector, reply }) => {
        const node = walk(b.root).find(n => selector.startsWith('#') ? n.props.id === selector.slice(1) : selector.startsWith('.') ? hasClass(n, selector.slice(1)) : n.tag === selector);
        const rect = node ? nativeRectangles.get(selector) ?? { left:20, top:40, width:300, height:100, right:320, bottom:140 } : null;
        reply?.(rect); return rect;
      }); done?.(values); }); } };
  } });
  return { ...b, boundary, requests, external, taskMoves, animations, setRectangle:(selector, rect) => nativeRectangles.set(selector, rect),
    async flushMeasurements() { for (let batch = 0; b.measurements.length; batch++) { assert.ok(batch < 20, 'bounded native selector callback delivery'); for (const reply of b.measurements.splice(0)) reply(); await b.flush(); } },
    async close() { try { await b.close(); } finally { restoreCompiler(); } } };
}
async function remote(b, key, repeat = 0) {
  const handled = b.tv.qtTvDispatchRemote({ key, code:0, action:'down', repeat });
  await b.boundary.drain(); return handled;
}
async function nativeAudioEvent(b, name, ...args) {
  const registration = b.nativeCalls.filter(receipt => receipt.name === name).at(-1);
  assert.equal(typeof registration?.args[0], 'function', 'real AudioPlayer registered the public native callback: ' + name);
  registration.args[0](...args); await b.flush();
}
const publicNotice = { id:410, title:'公开长公告', display:4, audience:'ALL', content:Array.from({ length:30 }, (_, i) => '<p>公告第' + (i + 1) + '段：正文保留原阅读顺序。</p>').join(''), createTime:'2026-11-14 12:00:00' };
async function noticeDetailCase() {
  const b = await fixture({ notices:[publicNotice], routeOptions:{ id:'410' } });
  try {
    await b.load('stores/notice.ts').useNoticeStore().load();
    await b.mount('pages/notice/detail/index.uvue');
    assert.ok(b.text().includes('公开长公告') && b.text().includes('公告第30段'), 'guest notice loads complete actual NoticeStore/HTTP/rich-text content');
    assert.equal(b.requests.filter(n => n.url.includes('/message/center')).length, 0, 'complete publicly dispatched notice needs no account message request');
    const scroll = b.byClass('scroll')[0]; assert.ok(scroll, 'rendered document viewport exists');
    assert.ok(hasClass(scroll, 'qt-tv-scroll'), 'TV readonly notice viewport participates in native directional scrolling');
    b.boundary.scrollExtent('scroll', 1500);
    b.tv.qtTvRefreshFocus();
    assert.ok(b.tv.qtTvFocus(b.boundary.id(scroll)), 'actual Frame public scope can focus the readonly document: ' + JSON.stringify(b.boundary.collected.map(n => ({ root:n.root?.tag, ids:n.result.map(v => v.id) }))) + ' current=' + b.tv.qtTvFocusedId() + ' enabled=' + b.tv.useQtTv().enabled);
    assert.equal(await remote(b, 'down'), true);
    assert.equal(b.boundary.offset(scroll), 280, 'public remote Down scrolls the focused document instead of navigating away');
    assert.equal(await remote(b, 'up'), true);
    assert.equal(b.boundary.offset(scroll), 0, 'public remote Up returns to the start of the long notice');
    await remote(b, 'ok');
    assert.equal(b.external.length + b.routes.length, 0, 'OK on readonly content never opens a business action');
    const title = b.byClass('title')[0], time = b.byClass('time')[0];
    assert.equal(b.css(title)['font-size'], '27.6px');
    assert.equal(b.css(title)['line-height'], '39px', 'TV title line box uses the same rendered font');
    assert.equal(b.css(time)['font-size'], '20px');
    assert.equal(b.css(time)['line-height'], '28px', 'TV secondary text has an explicit same-source line box');
  } finally { await b.close(); }
  console.log('PASS notice-detail full production guest long-content/Frame/public-remote/font contracts');
}
async function noticeActionCase() {
  const url = 'https://notice.fixture.invalid/detail/410';
  const b = await fixture({ notices:[{ ...publicNotice, url }], routeOptions:{ id:'410' } });
  try {
    await b.load('stores/notice.ts').useNoticeStore().load(); await b.mount('pages/notice/detail/index.uvue');
    const action = b.byClass('action')[0]; assert.ok(action, 'actual notice action is rendered');
    assert.equal(b.css(action).height, '56px', 'TV notice action has a 56px explicit target');
    assert.equal(b.css(b.byClass('action-text')[0])['line-height'], '31px');
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(action))); await remote(b, 'ok');
    assert.deepEqual(b.external, [url], 'one public native remote activation executes real openNoticeUrl/browser once');
    await remote(b, 'ok', 1); assert.deepEqual(b.external, [url], 'held OK never reopens the external action');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(b.css(b.byClass('title')[0])['font-size'], '36px');
    assert.equal(b.css(b.byClass('title')[0])['line-height'], '50px');
    assert.equal(b.css(b.byClass('action-text')[0])['line-height'], '40px');
    assert.equal(b.css(b.byClass('action')[0]).height, '56px');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(b.byClass('action')[0]).height, undefined, 'same-mounted touch recovers original native action CSS');
    assert.equal(b.css(b.byClass('title')[0])['line-height'], undefined, 'same-mounted touch removes TV-only text line boxes');
    await b.dispatch(b.byClass('action')[0], 'tap'); assert.deepEqual(b.external, [url, url], 'original touch action still executes once');
    assert.equal(b.byClass('qt-tv-scroll').length, 0, 'touch viewport restores its original native scroll behavior');
  } finally { await b.close(); }
  console.log('PASS notice-action real service/public remote once/huge/touch recovery');
}
async function noticeListCase() {
  const notices = [publicNotice, { ...publicNotice, id:411, title:'打开外链公告', url:'https://notice.fixture.invalid/open' },
    { ...publicNotice, id:412, title:'原反馈通知入口', feedbackId:77, noticeType:'feedback' }];
  const b = await fixture({ notices });
  try {
    await b.mount('pages/notice/list/index.uvue');
    assert.equal(b.byClass('n-item').length, 3, 'guest sees the actual publicly dispatched notice list');
    assert.equal(b.requests.filter(n => n.url.includes('/message/center')).length, 0, 'guest notice list never requests private message center');
    assert.equal(b.byClass('readall-btn').length, 0, 'guest has no read-state actions');
    assert.equal(b.byClass('cell-right').length, 2, 'paired native hosts retain a constant empty right cell for odd data');
    for (const card of b.byClass('n-item')) {
      assert.ok(Number.parseFloat(b.css(card)['min-height']) >= 56, 'shared QtNoticeCard is an explicit TV target of at least 56px');
      const title = walk(card).find(n => hasClass(n, 'n-title'));
      assert.equal(b.css(title)['font-size'], '22.08px');
      assert.equal(b.css(title)['line-height'], '31px', 'shared notice title has a same-source TV line box');
    }
    for (const [name, url] of [['公开长公告', '/pages/notice/detail/index?id=410'], ['原反馈通知入口', '/pages/feedback/detail?id=77']]) {
      const card = b.byClass('n-item').find(n => textOf(n).includes(name));
      b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(card))); const before = b.routes.length;
      await remote(b, 'ok'); assert.equal(b.routes.length - before, 1, 'one native remote activation opens one original notice route');
      assert.equal(b.routes.at(-1).url, url);
    }
    const external = b.byClass('n-item').find(n => textOf(n).includes('打开外链公告'));
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(external))); await remote(b, 'ok');
    assert.deepEqual(b.external, ['https://notice.fixture.invalid/open'], 'notice external action still runs real service once');
    assert.equal(b.storageWrites.filter(([key]) => key.includes('notice-read')).length, 0, 'guest navigation never writes read markers');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const title of b.byClass('n-title')) { assert.equal(b.css(title)['font-size'], '28.8px'); assert.equal(b.css(title)['line-height'], '40px'); }
    b.tv.qtSetTvMode('touch'); await b.flush();
    for (const card of b.byClass('n-item')) assert.equal(b.css(card)['min-height'], undefined, 'touch keeps shared original native notice card dimensions');
    for (const title of b.byClass('n-title')) assert.equal(b.css(title)['line-height'], undefined, 'touch keeps original notice text CSS');
    b.setWindow({ windowWidth:390, windowHeight:844, screenWidth:390, screenHeight:844 }); await b.clock.runTimers(1000);
    assert.equal(b.byClass('n-row').length, 3); assert.equal(b.byClass('cell-right').length, 0, 'same-mounted narrow touch keeps original single column');
    const before = b.routes.length; await b.dispatch(b.byClass('n-item').find(n => textOf(n).includes('公开长公告')), 'tap');
    assert.equal(b.routes.length - before, 1, 'original phone tap opens one detail');
  } finally { await b.close(); }
  console.log('PASS notice-list real guest dispatch/pair topology/shared target/remote once/huge/touch');
}
async function noticeLoggedCase() {
  const center = [{ ...publicNotice, id:610, title:'登录未读详情通知' }, { ...publicNotice, id:611, title:'已读反馈入口', feedbackId:77, noticeType:'feedback' }, { ...publicNotice, id:612, title:'登录未读外链', url:'https://notice.fixture.invalid/logged-open' }];
  const b = await fixture({ notices:[], center, initialStorage:{ 'qt-notice-read-ids':'[611]' } });
  try {
    b.load('services/auth.ts').saveTokens({ accessToken:'fixture-notice-token', refreshToken:'fixture-refresh-token', expiresAt:5000000 });
    await b.mount('pages/notice/list/index.uvue'); await b.flushMeasurements();
    assert.equal(b.byClass('n-item').length, 3); assert.ok(b.text().includes('2 条未读'), 'logged list reads the original persisted read snapshot');
    const requests = b.requests.filter(n => n.url.includes('/message/center')); assert.equal(requests.length, 1, 'original logged list avoids an extra unread-count/center roundtrip');
    assert.equal(requests[0].headers.satoken, 'fixture-notice-token', 'real HTTP carries the public saved account token');
    assert.equal(b.load('stores/notice.ts').useNoticeStore().unreadCount, 2);
    const readAll = b.byClass('readall-btn')[0]; assert.ok(readAll, 'original logged read-all action stays visible');
    assert.ok(parseFloat(b.css(readAll).height ?? b.css(readAll)['min-height'] ?? '0') >= 56, 'TV logged read-all is an explicit56px remote action');
    for (const cls of ['toolbar-text', 'readall-btn-text']) { const node = b.byClass(cls)[0]; assert.ok(node); assert.equal(b.css(node)['font-size'], '20px'); assert.equal(b.css(node)['line-height'], '28px', 'logged notice toolbar uses the actual TV reading font line'); }
    const card = b.byClass('n-item').find(n => textOf(n).includes('登录未读详情通知')); b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(card)));
    const beforeRoutes = b.routes.length, beforeWrites = b.storageWrites.filter(([key]) => key === 'qt-notice-read-ids').length;
    await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(b.routes.length - beforeRoutes, 1); assert.equal(b.routes.at(-1).url, '/pages/notice/detail/index?id=610');
    assert.equal(b.storageWrites.filter(([key]) => key === 'qt-notice-read-ids').length - beforeWrites, 1, 'remote held OK marks the original item once');
    assert.deepEqual(JSON.parse(b.storage.get('qt-notice-read-ids')).slice().sort(), [610,611]); assert.equal(b.load('stores/notice.ts').useNoticeStore().unreadCount, 1); assert.ok(b.text().includes('1 条未读'));
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(b.byClass('readall-btn')[0]))); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.deepEqual(JSON.parse(b.storage.get('qt-notice-read-ids')).slice().sort(), [610,611,612]); assert.equal(b.load('stores/notice.ts').useNoticeStore().unreadCount, 0); assert.ok(b.text().includes('全部已读')); assert.equal(b.byClass('readall-btn').length, 0);
    assert.equal(b.requests.filter(n => n.url.includes('/message/center')).length, 1, 'mark-one/read-all reuse the real local read cache and issue no network request');
    const feedback = b.byClass('n-item').find(n => textOf(n).includes('已读反馈入口')); b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(feedback))); await remote(b, 'ok'); assert.equal(b.routes.at(-1).url, '/pages/feedback/detail?id=77');
    const external = b.byClass('n-item').find(n => textOf(n).includes('登录未读外链')); b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(external))); await remote(b, 'ok'); assert.deepEqual(b.external, ['https://notice.fixture.invalid/logged-open']);
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); assert.equal(b.css(b.byClass('toolbar-text')[0])['font-size'], '25.2px'); assert.equal(b.css(b.byClass('toolbar-text')[0])['line-height'], '35px');
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(b.byClass('toolbar-text')[0])['line-height'], undefined, 'touch recovers original notice toolbar CSS');
  } finally { await b.close(); }
  console.log('PASS logged notice original token/center/read snapshot/mark-one/read-all/local cache and TV action');
}
async function noticeEmptyCase() {
  const b = await fixture({ notices:[] });
  try {
    await b.mount('pages/notice/list/index.uvue'); await b.flushMeasurements();
    assert.equal(b.byClass('n-item').length, 0); assert.ok(b.text().includes('暂无消息')); assert.equal(b.byClass('toolbar').length, 0); assert.equal(b.requests.filter(n => n.url.includes('/message/center')).length, 0, 'original empty guest notices stay public without a private center request');
    const login = b.byClass('login-btn')[0]; assert.ok(login, 'original empty notice login action remains visible');
    assert.ok(parseFloat(b.css(login).height ?? b.css(login)['min-height'] ?? '0') >= 56, 'TV guest empty login is an explicit56px action');
    for (const cls of ['empty-text', 'login-btn-text']) { const node = b.byClass(cls)[0]; assert.ok(node); assert.equal(b.css(node)['font-size'], '20px'); assert.equal(b.css(node)['line-height'], '28px', 'guest empty notice copy fits its actual TV line box'); }
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(login))); const routes = b.routes.length; await remote(b, 'ok'); await remote(b, 'ok', 1); assert.equal(b.routes.length - routes, 1); assert.equal(b.routes.at(-1).url, '/pages/login/index'); assert.equal(b.storageWrites.filter(([key]) => key === 'qt-notice-read-ids').length, 0);
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); for (const cls of ['empty-text','login-btn-text']) { assert.equal(b.css(b.byClass(cls)[0])['font-size'], '25.2px'); assert.equal(b.css(b.byClass(cls)[0])['line-height'], '35px'); }
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(b.byClass('login-btn')[0])['min-height'], undefined); assert.equal(b.css(b.byClass('login-btn-text')[0])['line-height'], undefined);
    b.setWindow({ windowWidth:390, windowHeight:844 }); await b.flush(); const phoneRoutes = b.routes.length; await b.dispatch(b.byClass('login-btn')[0], 'tap'); assert.equal(b.routes.length - phoneRoutes, 1); assert.equal(b.routes.at(-1).url, '/pages/login/index', 'original narrow phone tap is retained');
  } finally { await b.close(); }
  console.log('PASS empty guest notice original public login once/huge/touch/phone and TV reading boxes');
}
async function feedbackCase() {
  const b = await fixture();
  try {
    await b.mount('pages/feedback/index.uvue');
    assert.equal(b.byClass('channel').length, 2, 'guest feedback exposes only the two real Issue channels');
    assert.equal(b.byClass('submit-btn').length + b.byClass('tabs').length, 0, 'retired native feedback list/submission stays retired');
    const official = b.load('services/official-site.ts');
    for (const [name, url] of [['CNB', official.OFFICIAL_ISSUE_CNB_URL], ['GitHub', official.OFFICIAL_ISSUE_GITHUB_URL]]) {
      const channel = b.byClass('channel').find(n => textOf(n).includes(name));
      b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(channel)), 'real owner Frame focuses the public Issue channel');
      const before = b.external.length; await remote(b, 'ok'); assert.equal(b.external.length - before, 1);
      assert.equal(b.external.at(-1), url, 'public Issue activation executes the unchanged official URL through real browser service');
      assert.ok(Number.parseFloat(b.css(channel)['min-height']) >= 56, 'TV feedback channel is an explicit target of at least 56px');
    }
    assert.equal(b.css(b.byClass('head-title')[0])['font-size'], '31.74px');
    assert.equal(b.css(b.byClass('head-title')[0])['line-height'], '44px', 'TV feedback title line box follows the actual font');
    for (const n of [...b.byClass('head-sub'), ...b.byClass('ch-desc'), ...b.byClass('tip')]) {
      assert.equal(b.css(n)['font-size'], '20px'); assert.equal(b.css(n)['line-height'], '28px', 'TV secondary Issue copy has an explicit line box');
    }
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.equal(b.css(b.byClass('head-title')[0])['font-size'], '41.4px'); assert.equal(b.css(b.byClass('head-title')[0])['line-height'], '58px');
    b.tv.qtSetTvMode('touch'); await b.flush();
    for (const n of b.byClass('channel')) assert.equal(b.css(n)['min-height'], undefined, 'touch recovers original Issue-card box');
    assert.equal(b.css(b.byClass('head-title')[0])['line-height'], undefined, 'touch recovers original Issue text CSS');
    const before = b.external.length; await b.dispatch(b.byClass('channel')[0]); assert.equal(b.external.length - before, 1, 'original phone Issue click is still exactly once');
    assert.equal(b.routes.length, 0, 'Issue-only feedback adds no native login/list/submission navigation');
  } finally { await b.close(); }
  console.log('PASS feedback guest actual Issue-only/public remote once/line boxes/huge/touch');
}
async function profileCase() {
  const b = await fixture();
  try {
    await b.mount('pages/profile/index.uvue');
    assert.equal(b.byClass('profile').length, 1, 'TV profile renders one actual overview, not Frame and page duplicates');
    assert.equal(b.byClass('qt-page-frame-snav').length, 0, 'TV shared single-pane policy removes the secondary sidebar');
    assert.equal(b.byClass('tile').length, 5, 'all original profile tiles exist in the actual overview');
    const name = b.byClass('name')[0]; assert.equal(b.css(name)['font-size'], '30.36px');
    assert.equal(b.css(name)['line-height'], '43px', 'actual shared profile title line follows its TV reading font');
    const login = b.byClass('profile')[0]; b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(login)));
    await remote(b, 'ok'); assert.equal(b.routes.at(-1).url, '/pages/login/index', 'guest profile card keeps real original login route');
    const feedback = b.cell('意见反馈'); assert.ok(feedback); b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(feedback)));
    const before = b.routes.length; await remote(b, 'ok'); assert.equal(b.routes.length - before, 1); assert.equal(b.routes.at(-1).url, '/pages/feedback/index');
    assert.equal(await remote(b, 'back'), true); assert.equal(b.routes.at(-1).action, 'switch-tab', 'remote Profile Back returns through the actual original tab navigation');
    assert.equal(b.routes.at(-1).url, '/pages/home/index');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); assert.equal(b.byClass('profile').length, 1);
    assert.equal(b.css(b.byClass('name')[0])['font-size'], '39.6px');
    b.tv.qtSetTvMode('touch'); await b.flush(); b.setWindow({ windowWidth:390, windowHeight:844, screenWidth:390, screenHeight:844 }); await b.clock.runTimers(1000);
    assert.equal(b.byClass('profile').length, 1); assert.equal(b.byClass('tile').length, 5);
    const tapBefore = b.routes.length; await b.dispatch(b.cell('意见反馈')); assert.equal(b.routes.length - tapBefore, 1);
  } finally { await b.close(); }
  console.log('PASS profile single actual overview/public guest routes/remote Back/huge/touch');
}
async function settingsCase() {
  const b = await fixture({ boundaryOverrides:{ 'services/music-api':undefined } });
  try {
    await b.mount('pages/settings/index.uvue');
    assert.equal(b.byClass('list').length, 1, 'TV settings mounts one real overview scroll container');
    assert.equal(b.byClass('qt-page-frame-snav').length, 0, 'TV settings follows the shared single-pane policy');
    assert.equal(b.cell('播放设置') != null, true, 'actual shared settings overview retains the original playback entry');
    const playback = b.cell('播放设置'); b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(playback)));
    const before = b.routes.length; await remote(b, 'ok'); assert.equal(b.routes.length - before, 1); assert.equal(b.routes.at(-1).url, '/pages/play-settings/index');
    assert.equal(parseFloat(b.css(playback)['min-height']) >= 56, true, 'real shared settings overview has an explicit TV target');
    const title = walk(playback).find(n => hasClass(n, 'cell-title'));
    assert.equal(b.css(title)['font-size'], '23.46px');
    assert.equal(b.css(title)['line-height'], '33px', 'shared settings title line box follows the actual TV font');
    assert.equal(b.byClass('cell').length, b.byClass('cell-main').length, 'TV summaries use the shared vertically stacked setting cells');
    for (const summary of b.byClass('cell-value')) { assert.equal(b.css(summary)['font-size'], '20px'); assert.equal(b.css(summary)['line-height'], '28px'); }
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); assert.equal(b.byClass('list').length, 1);
    assert.equal(b.css(title)['font-size'], '30.6px'); assert.equal(b.css(title)['line-height'], '43px');
    for (const summary of b.byClass('cell-value')) { assert.equal(b.css(summary)['font-size'], '25.2px'); assert.equal(b.css(summary)['line-height'], '35px'); }
    b.tv.qtSetTvMode('touch'); await b.flush(); b.setWindow({ windowWidth:390, windowHeight:844, screenWidth:390, screenHeight:844 }); await b.clock.runTimers(1000);
    assert.equal(b.byClass('list').length, 1); assert.equal(b.byClass('cell-main').length, 1, 'phone keeps only the original long TV-mode summary stacked');
    const tapBefore = b.routes.length; await b.dispatch(b.cell('播放设置')); assert.equal(b.routes.length - tapBefore, 1);
  } finally { await b.close(); }
  console.log('PASS settings one actual shared overview/public route/TV stack/huge/touch');
}
async function playlistsCase() {
  const data = installedDataBoundary();
  const b = await fixture({ boundaryOverrides:{ 'uni_modules/qt-js-engine':data.sdk } });
  try {
    await b.mount('pages/playlists/index.uvue'); await b.clock.runTimers(1000); await b.flush();
    assert.equal(b.load('stores/source-registry.ts').useSourceRegistryStore().ready, true, 'real source registry is initialized through the real engine/FS services: ' + JSON.stringify({ calls:data.calls, error:b.load('services/source-engine.uts').lastEngineError(), text:b.text() }));
    assert.equal(data.calls.filter(call => call.name === 'loadBundle').length, 1, 'real engine installs metadata once');
    assert.equal(b.byClass('name').length, 7, 'real response contracts pass through music-api into the production list host');
    assert.equal(b.byClass('sk-layer').length, 0, 'original skeleton disappears after actual service data');
    const cards = b.byClass('card').filter(n => n.props.onClick);
    assert.ok(cards.every(n => parseFloat(b.css(n).width) >= 208), 'TV playlist cards honor the 208px reading floor in the real content pane');
    for (const name of b.byClass('name')) {
      assert.equal(b.css(name)['font-size'], '20.7px');
      assert.equal(b.css(name)['line-height'], '29px', 'TV playlist title line follows its actual reading font');
    }
    for (const badge of b.byClass('cover-badge-text')) { assert.equal(b.css(badge)['font-size'], '20px'); assert.equal(b.css(badge)['line-height'], '28px'); }
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(cards[0])));
    const routeBefore = b.routes.length; await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(b.routes.length - routeBefore, 1, 'one playlist remote OK/repeat produces one original business route');
    assert.equal(b.routes.at(-1).url, '/pages/playlist/index?id=list-0&platform=wyy');
    const more = b.byClass('cat-more')[0];
    assert.ok(more && textOf(more).includes('全部分类'), 'TV retains an explicit visible More action');
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(more))); await remote(b, 'ok');
    assert.equal(b.byClass('cat-panel').length, 1, 'public More opens the original actual category popup');
    await remote(b, 'back');
    assert.equal(b.byClass('cat-panel').length, 0, 'Back closes the visible TV category popup before page navigation');
    assert.equal(b.tv.qtTvFocusedId(), b.boundary.id(more), 'closing popup restores the original More focus identity');
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(more))); await remote(b, 'ok');
    const panel = b.byClass('cat-panel')[0];
    assert.equal(b.tv.qtTvHasModal(), true, 'category overlay traps public focus in the actual original panel');
    assert.equal(b.tv.qtTvFocus(b.boundary.id(cards[0])), false, 'background playlist card is excluded while category popup is visible');
    const rnb = walk(panel).find(n => hasClass(n, 'qo') && textOf(n).includes('R&B')); assert.ok(rnb, 'real category service keeps HTML entity decoding');
    const beforeCategory = data.calls.filter(n => n.name === 'recommendations').length;
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(rnb))); await remote(b, 'ok'); await remote(b, 'ok', 1); await b.clock.runTimers(0);
    assert.equal(b.byClass('cat-panel').length, 0, 'selection closes the existing popup');
    assert.equal(data.calls.filter(n => n.name === 'recommendations').length - beforeCategory, 1, 'one real category selection makes one fresh business request');
    assert.equal(data.calls.filter(n => n.name === 'recommendations').at(-1).args.category, 'rnb');
    const sort = walk(b.byClass('sort-bar')[0]).find(n => hasClass(n, 'qo') && textOf(n).includes('最新')); assert.ok(sort);
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(sort))); await remote(b, 'ok'); await b.clock.runTimers(0);
    assert.equal(data.calls.filter(n => n.name === 'recommendations').at(-1).args.sort, 'new', 'public source-declared sort id passes through the actual music-api');
    const list = b.byClass('scroll')[0]; await b.dispatch(list, 'scrolltolower'); await b.clock.runTimers(0);
    assert.equal(data.calls.filter(n => n.name === 'recommendations').at(-1).args.page, 2, 'public native lower requests original next page');
    assert.equal(b.byClass('name').length, 7, 'original head/tail host retains all data after short next page');
    const afterLower = data.calls.length; await b.dispatch(list, 'scrolltolower'); await b.clock.runTimers(0);
    assert.equal(data.calls.length, afterLower, 'real exhausted service result suppresses duplicate lower requests');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const name of b.byClass('name')) { assert.equal(b.css(name)['font-size'], '27px'); assert.equal(b.css(name)['line-height'], '38px'); }
    b.tv.qtSetTvMode('touch'); await b.flush();
    for (const name of b.byClass('name')) assert.equal(b.css(name)['line-height'], undefined, 'touch restores original playlist text CSS');
    for (const card of b.byClass('card').filter(n => n.props.onClick)) assert.ok(parseFloat(b.css(card).width) <= 200, 'touch wide retains original max200 cards');
    b.setWindow({ windowWidth:390, windowHeight:844, screenWidth:390, screenHeight:844 }); await b.clock.runTimers(1000);
    assert.equal(b.byClass('name').length, 7, 'same mounted narrow touch preserves actual service list');
    const firstCard = b.byClass('card').filter(n => n.props.onClick)[0], tapBefore = b.routes.length;
    await b.dispatch(firstCard); assert.equal(b.routes.length - tapBefore, 1, 'original phone playlist click stays single');
  } finally { await b.close(); }
  console.log('PASS playlists full real engine/registry/FS/music-api/data and TV cards');
}
async function chartCase() {
  const data = installedDataBoundary();
  const b = await fixture({ boundaryOverrides:{ 'uni_modules/qt-js-engine':data.sdk }, rectangles:{ '#chart-scroll':{ left:0, top:100, width:960, height:520, right:960, bottom:620 } } });
  try {
    await b.mount('pages/chart/index.uvue'); await b.clock.runTimers(1000); await b.flushMeasurements(); await b.flush();
    assert.equal(b.load('stores/source-registry.ts').useSourceRegistryStore().ready, true, 'real chart registry initialization succeeds');
    assert.ok(b.byClass('rank-name').length > 0 && b.text().includes('真实榜单1'), 'real chart contracts reach the actual production page');
    const preview = b.byClass('preview-line').find(n => textOf(n).includes('榜单公开歌曲1'));
    assert.ok(preview, 'actual original preview service has real chart songs: ' + JSON.stringify({ calls:data.calls, text:b.text() }));
    const player = b.load('stores/player.ts').usePlayerStore();
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(preview))); const before = player.playbackRevision(), navBefore = b.routes.length;
    await remote(b, 'ok'); await remote(b, 'ok', 1); await b.clock.runTimers(0);
    assert.equal(player.playbackRevision() - before, 1, 'remote preview OK requests original playback exactly once');
    assert.equal(b.routes.length, navBefore, 'preview click.stop never opens chart route');
    assert.equal(player.current?.name, '榜单公开歌曲1', 'real preview public activation keeps exact business song');
    assert.ok(parseFloat(b.css(preview).height) >= 56, 'actual TV chart preview is a target of at least 56px');
    const title = b.byClass('rank-name')[0], heading = b.byClass('rank-heading')[0];
    assert.equal(b.css(title)['font-size'], '23.46px', 'original TV chart title has the actual shared font');
    assert.equal(b.css(title)['line-height'], '33px', 'chart title line is sourced from that actual TV font');
    assert.ok(parseFloat(b.css(heading).height) >= 56, 'original chart heading is a full remote target');
    for (const cls of ['rank-meta', 'preview-number', 'preview-name', 'chart-end-text']) for (const node of b.byClass(cls)) {
      assert.ok(parseFloat(b.css(node)['font-size']) >= 20, 'actual secondary chart text has the 20px floor');
      assert.equal(b.css(node)['line-height'], '28px', 'secondary chart text line box follows the actual 20px TV font');
    }
    const refresh = b.byClass('chart-refresh')[0]; assert.ok(refresh, 'original visible chart refresh exists');
    assert.equal(b.css(refresh).height, '56px', 'actual TV refresh is a full native target');
    assert.equal(b.css(refresh).width, '56px', 'actual TV refresh has the horizontal target floor');
    const firstCard = b.byClass('rank-card')[0], chartScroll = b.byClass('chart-scroll')[0];
    assert.ok(parseFloat(b.css(firstCard).width) >= 208, 'real measured chart card consumes shared minimum-column policy');
    const prefix = b.byClass('rank-card');
    await b.dispatch(chartScroll, 'scroll', { scrollTop:900 });
    assert.equal(b.load('services/chart-tabs.ts').readChartScroll('wyy'), 900, 'public scroll retains the original source scroll memory');
    assert.equal(b.byClass('rank-card')[0], prefix[0], 'deep scrolling retains the original growing-prefix card identity');
    const backTop = b.byClass('back-top')[0]; assert.ok(backTop, 'original deep-scroll back-to-top becomes visible');
    assert.equal(b.css(backTop).height, '56px', 'TV back-to-top is an explicit full target');
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(backTop))); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(b.load('services/chart-tabs.ts').readChartScroll('wyy'), 0, 'remote back-to-top invokes the original source-scroll reset');
    assert.equal(b.byClass('back-top').length, 0); assert.equal(b.byClass('rank-card')[0], prefix[0], 'back-to-top does not rebuild the growing prefix');
    await b.clock.runTimers(1000);
    const fetchBefore = data.calls.filter(n => n.name === 'charts').length;
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(refresh))); await remote(b, 'ok'); await remote(b, 'ok', 1); await b.clock.runTimers(1000);
    assert.equal(data.calls.filter(n => n.name === 'charts').length - fetchBefore, 1, 'visible refresh follows the original force contract exactly once');
    const headingNow = b.byClass('rank-heading')[0], routeCount = b.routes.length;
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(headingNow))); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(b.routes.length - routeCount, 1, 'chart heading keeps single original detail navigation');
    assert.match(b.routes.at(-1).url, /id=chart-0&platform=wyy&type=chart/);
    b.fonts.useFontScaleStore().setTier('huge'); await b.clock.runTimers(1000);
    assert.equal(b.css(b.byClass('rank-name')[0])['font-size'], '30.6px'); assert.equal(b.css(b.byClass('rank-name')[0])['line-height'], '43px');
    assert.equal(b.css(b.byClass('preview-name')[0])['font-size'], '23.4px'); assert.equal(b.css(b.byClass('preview-name')[0])['line-height'], '33px');
    assert.equal(b.css(b.byClass('preview-line')[0]).height, '56px');
    b.setRectangle('#chart-scroll', { left:0, top:100, width:620, height:520, right:620, bottom:620 });
    b.setWindow({ windowWidth:1100, windowHeight:720, screenWidth:1100, screenHeight:720 }); await b.clock.runTimers(1000); await b.flushMeasurements();
    assert.equal(b.css(b.byClass('rank-card')[0]).width, '588px', 'actual 620px native chart viewport selects one original column independently of wide window');
    b.tv.qtSetTvMode('touch'); await b.clock.runTimers(1000);
    assert.equal(b.css(b.byClass('rank-name')[0])['line-height'], undefined, 'touch restores original chart CSS line boxes');
    assert.equal(b.css(b.byClass('chart-refresh')[0]).height, undefined, 'touch restores original CSS44 refresh');
    const touchHeading = b.byClass('rank-heading')[0], touchNav = b.routes.length;
    await b.dispatch(touchHeading); assert.equal(b.routes.length - touchNav, 1, 'original touch chart heading remains single');
    b.setRectangle('#chart-scroll', { left:0, top:100, width:390, height:644, right:390, bottom:744 });
    b.setWindow({ windowWidth:390, windowHeight:844, screenWidth:390, screenHeight:844 }); await b.clock.runTimers(1000); await b.flushMeasurements();
    assert.equal(b.byClass('chart-refresh').length, 0, 'original phone uses only its original header refresh');
    assert.ok(b.byClass('rank-card').length > 0 && b.byClass('chart-scroll').length === 1, 'phone retains one native chart scroll and real data');
    const phonePreview = b.byClass('preview-line').find(n => textOf(n).includes('榜单公开歌曲1')), phonePlay = player.playbackRevision(), phoneRoutes = b.routes.length;
    await b.dispatch(phonePreview); await b.clock.runTimers(0);
    assert.equal(player.playbackRevision() - phonePlay, 1, 'original phone preview still requests playback once');
    assert.equal(b.routes.length, phoneRoutes, 'original phone preview retains click.stop');
  } finally { await b.close(); }
  console.log('PASS chart real engine/loader/public preview playback once and TV target');
}
async function homeCase() {
  const data = installedDataBoundary();
  const b = await fixture({ boundaryOverrides:{ 'uni_modules/qt-js-engine':data.sdk } });
  try {
    await b.mount('pages/home/index.uvue'); await b.clock.runTimers(1000); await b.flushMeasurements();
    assert.equal(b.load('stores/source-registry.ts').useSourceRegistryStore().ready, true, 'actual Home uses the real restored registry');
    assert.ok(b.byClass('wide-playlist-card').length === 7 && b.byClass('wide-song-row').length > 0 && b.byClass('wide-chart-row').length > 0, 'actual Home renders original source recommendation/latest/chart contracts: ' + JSON.stringify({ calls:data.calls, text:b.text() }));
    assert.equal(data.calls.filter(n => n.name === 'recommendations').length, 1, 'real onMounted/onShow load coalescing preserves one recommendations request');
    assert.equal(data.calls.filter(n => n.name === 'latest').length, 1, 'original latest data path stays single');
    const song = b.byClass('wide-song-row')[0], player = b.load('stores/player.ts').usePlayerStore(), rev = player.playbackRevision();
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(song))); await remote(b, 'ok'); await remote(b, 'ok', 1); await b.clock.runTimers(0);
    assert.equal(player.playbackRevision() - rev, 1, 'Home public remote song row keeps one real playback request');
    assert.equal(player.current?.name, '首页公开新歌1', 'Home keeps the exact original latest song');
    const card = b.byClass('wide-playlist-card')[0];
    assert.ok(parseFloat(b.css(card).width) >= 208, 'TV Home recommendation cards use shared minimum208-column policy');
    const homeTextIssues = [];
    for (const [cls, font, line] of [['wide-feature-title','31.74px','44px'], ['wide-panel-title','27.6px','39px'], ['wide-feature-kicker','20px','28px'], ['wide-feature-desc','20px','28px'], ['wide-primary-text','20px','28px'], ['wide-secondary-text','20px','28px'], ['wide-shortcut-title','20px','28px'], ['wide-shortcut-desc','20px','28px'], ['wide-more-text','20px','28px'], ['wide-playlist-name','20px','28px'], ['wide-playlist-count','20px','28px'], ['wide-song-name','20px','28px'], ['wide-song-meta','20px','28px'], ['wide-chart-name','20px','28px'], ['wide-chart-meta','20px','28px'], ['home-search-text','20px','28px']]) {
      assert.ok(b.byClass(cls).length > 0 || cls === 'wide-shortcut-desc', 'original Home visible text binding remains: ' + cls);
      for (const node of b.byClass(cls)) { if (b.css(node)['font-size'] !== font || b.css(node)['line-height'] !== line) homeTextIssues.push({ cls, actual:b.css(node), expected:{ font, line } }); }
    }
    assert.deepEqual(homeTextIssues, [], 'actual whole Home TV secondary fonts retain their actual same-source line boxes');
    assert.ok(parseFloat(b.css(b.byClass('wide-feature')[0])['min-height']) >= 338, 'Home TV hero reserves normal kicker28/title44x2/description28/both56 wrapped actions/original82 padding and margins');
    for (const cls of ['home-search', 'home-bell', 'wide-primary', 'wide-secondary', 'section-more']) {
      assert.ok(b.byClass(cls).length > 0, 'original visible Home action remains: ' + cls);
      for (const node of b.byClass(cls)) assert.ok(parseFloat(b.css(node).height ?? b.css(node)['min-height'] ?? '0') >= 56, 'Home original TV target56: ' + cls);
    }
    const shelf = b.byClass('wide-playlist-scroll')[0], cover = b.byClass('wide-playlist-cover')[0];
    const shelfNameLine = parseFloat(b.css(b.byClass('wide-playlist-name')[0])['line-height']), shelfCountLine = parseFloat(b.css(b.byClass('wide-playlist-count')[0])['line-height']);
    assert.ok(parseFloat(b.css(shelf).height) >= parseFloat(b.css(cover).height) + shelfNameLine * 2 + shelfCountLine + 13, 'fixed native Home shelf fits original two-line name and count after actual TV font growth');
    for (const node of b.byClass('wide-chart-row')) assert.ok(parseFloat(b.css(node)['min-height']) >= 78, 'TV Home chart row fits28 name/5 margin/28 metadata plus original16 padding and1 border');
    for (const node of b.byClass('wide-song-row')) assert.ok(parseFloat(b.css(node)['min-height']) >= 76, 'TV Home song row retains shared76 and both actual line boxes');
    assert.equal(b.byClass('wide-shortcut').length, 3, 'all three original shortcuts remain');
    for (const node of b.byClass('wide-shortcut')) assert.ok(parseFloat(b.css(node)['min-height']) >= (String(node.props.class).includes('wide-shortcut-inline') ? 92 : 80), 'normal TV shortcut fits actual inline36+8+28+20 or stacked28+4+28+20 content');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const [cls, font, line] of [['wide-feature-title','41.4px','58px'], ['wide-panel-title','36px','50px'], ['wide-primary-text','23.4px','33px'], ['wide-playlist-name','25.2px','35px'], ['wide-playlist-count','21.6px','30px'], ['wide-song-name','25.2px','35px'], ['wide-song-meta','21.6px','30px'], ['home-search-text','23.4px','33px']]) for (const node of b.byClass(cls)) { assert.equal(b.css(node)['font-size'], font, 'actual Home huge font: ' + cls); assert.equal(b.css(node)['line-height'], line, 'actual Home huge line: ' + cls); }
    assert.ok(parseFloat(b.css(shelf).height) >= parseFloat(b.css(cover).height) + 35 * 2 + 30 + 13, 'actual huge Home shelf still fits both title lines and count');
    assert.ok(parseFloat(b.css(b.byClass('wide-feature')[0])['min-height']) >= 373, 'Home huge hero reserves30/58x2/33/both56 actions plus original82 padding and margins');
    for (const node of b.byClass('wide-shortcut')) assert.ok(parseFloat(b.css(node)['min-height']) >= (String(node.props.class).includes('wide-shortcut-inline') ? 99 : 89), 'huge TV shortcut fits actual inline36+8+35+20 or stacked35+4+30+20 content');
    for (const node of [...b.byClass('wide-chart-row'), ...b.byClass('wide-song-row')]) assert.ok(parseFloat(b.css(node)['min-height']) >= 87, 'huge Home rows fit35/5/30 and the larger original17 padding-border budget');
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(b.byClass('wide-feature-title')[0])['font-size'], '34.5px');
    assert.equal(b.css(b.byClass('wide-primary')[0]).height, undefined, 'same-mounted touch returns original stylesheet button height');
    assert.ok(parseFloat(b.css(b.byClass('wide-playlist-card')[0]).width) <= 180, 'touch retains original shared HD cap180');
    const touchRev = player.playbackRevision(); await b.dispatch(b.byClass('wide-song-row')[1]); assert.equal(player.playbackRevision() - touchRev, 1); assert.equal(player.current?.name, '首页公开新歌2');
    b.setWindow({ windowWidth:390, windowHeight:844 }); await b.flush(); await b.flushMeasurements();
    assert.equal(b.byClass('wide-home').length, 0); assert.equal(b.byClass('portrait-home').length, 1, 'original phone layout remains after same-mounted mode and breakpoint change');
    const phoneRev = player.playbackRevision(); assert.equal(b.byClass('song-row').length, 8); assert.equal(b.byClass('play-hit').length, 8, 'original phone play hit zones remain, row itself is non-interactive'); await b.dispatch(b.byClass('play-hit')[0]); assert.equal(player.playbackRevision() - phoneRev, 1); assert.equal(player.current?.name, '首页公开新歌1');
    const routesBefore = b.routes.length; await b.dispatch(b.byClass('quick-pill').find(n => textOf(n).includes('播客'))); assert.equal(b.routes.length - routesBefore, 1); assert.equal(b.routes.at(-1).url, '/pages/podcast/index', 'original phone podcast entry is retained');
  } finally { await b.close(); }
  console.log('PASS home actual real source contracts and public remote original actions');
}
async function homeFailureCase() {
  const failures = { recommendations:'fixture upstream response failed' }, data = installedDataBoundary({ failures });
  const b = await fixture({ boundaryOverrides:{ 'uni_modules/qt-js-engine':data.sdk } });
  try {
    await b.mount('pages/home/index.uvue'); await b.clock.runTimers(1000); await b.flushMeasurements();
    assert.equal(b.load('stores/source-registry.ts').useSourceRegistryStore().ready, true); assert.equal(b.byClass('home-fail').length, 1, 'real native upstream failure reaches original Home retry banner'); assert.equal(textOf(b.byClass('home-fail-text')[0]), '部分内容没加载出来，可能是网络或音源包的问题');
    assert.equal(data.calls.filter(n => n.name === 'recommendations').length, 1); assert.equal(data.calls.filter(n => n.name === 'latest').length, 1); assert.ok(b.byClass('wide-song-row').length > 0 && b.byClass('wide-chart-row').length > 0, 'one failed original data branch leaves the independent arrived latest/charts visible');
    const retry = b.byClass('home-fail-btn')[0]; assert.equal(b.css(retry).height, '56px', 'TV original Home retry uses explicit56px control, not native whole-window rpx'); assert.equal(b.css(retry)['min-width'], '56px');
    for (const cls of ['home-fail-text','home-fail-btn-text']) { assert.equal(b.css(b.byClass(cls)[0])['font-size'], '20px'); assert.equal(b.css(b.byClass(cls)[0])['line-height'], '28px', 'original Home failure copy uses the actual TV font line box'); }
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); assert.equal(b.css(b.byClass('home-fail-text')[0])['line-height'], '33px'); assert.equal(b.css(b.byClass('home-fail-btn-text')[0])['line-height'], '30px');
    b.tv.qtSetTvMode('touch'); await b.flush(); for (const cls of ['home-fail-text','home-fail-btn-text']) assert.equal(b.css(b.byClass(cls)[0])['line-height'], undefined, 'original touch failure text styles are recovered'); assert.equal(b.css(b.byClass('home-fail-btn')[0]).height, undefined);
    b.tv.qtSetTvMode('tv'); b.fonts.useFontScaleStore().setTier('normal'); await b.flush();
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(retry))); const before = b.boundary.activations.length; await remote(b,'ok'); await remote(b,'ok',1); await b.clock.runTimers(0);
    assert.equal(b.boundary.activations.length - before, 1); assert.equal(data.calls.filter(n => n.name === 'recommendations').length, 2, 'original retry sends exactly one fresh failed recommendation request'); assert.equal(data.calls.filter(n => n.name === 'latest').length, 1, 'original retry keeps the already cached latest result'); assert.equal(b.byClass('home-fail').length, 1);
    delete failures.recommendations; await b.dispatch(b.byClass('home-fail-btn')[0]); await b.clock.runTimers(0); await b.flush(); assert.equal(data.calls.filter(n => n.name === 'recommendations').length, 3); assert.equal(b.byClass('home-fail').length, 0); assert.equal(b.byClass('wide-playlist-card').length, 7, 'original successful retry replaces only failed content and removes retry banner');
  } finally { await b.close(); }
  console.log('PASS home original partial upstream failure/retry once/cache and explicit TV action');
}
async function homeSourceTipCase() {
  const data = installedDataBoundary(), requests = [], loading = [], b = await fixture({ boundaryOverrides:{ 'uni_modules/qt-js-engine':data.sdk }, sdkOverrides:{ showLoading:value => loading.push({ action:'show', ...value }), hideLoading:() => loading.push({ action:'hide' }), request(request) { requests.push({ url:request.url, timeout:request.timeout }); request.success?.({ statusCode:200, data:JSON.stringify({ code:200, data:request.url.includes('/source/manifest') ? { schema:1, generatedAt:'fixture', release:null } : [] }) }); } } });
  try {
    await b.mount('pages/home/index.uvue'); await b.clock.runTimers(1000); await b.flushMeasurements();
    assert.equal(b.load('stores/source-update.ts').useSourceUpdateStore().sourceMissing, true, 'original active-meta/no-play-pack boundary renders source installation action');
    const tip = b.byClass('source-tip')[0]; assert.ok(tip); assert.equal(textOf(b.byClass('source-tip-title')[0]), '未安装播放音源包');
    assert.ok(parseFloat(b.css(tip)['min-height'] ?? '0') >= 56, 'TV original source-tip is an explicit56px public installation action');
    assert.equal(b.css(b.byClass('source-tip-title')[0])['font-size'], '20.7px'); assert.equal(b.css(b.byClass('source-tip-title')[0])['line-height'], '29px', 'TV original source-tip title has the actual same-source font line'); assert.equal(b.css(b.byClass('source-tip-desc')[0])['font-size'], '20px'); assert.equal(b.css(b.byClass('source-tip-desc')[0])['line-height'], '28px');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); assert.equal(b.css(b.byClass('source-tip-title')[0])['line-height'], '38px'); assert.equal(b.css(b.byClass('source-tip-desc')[0])['line-height'], '30px'); b.fonts.useFontScaleStore().setTier('normal'); await b.flush();
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(tip))); const before = b.boundary.activations.length, routes = b.routes.length; await remote(b,'ok'); await remote(b,'ok',1); await b.clock.runTimers(0); await b.flush();
    assert.equal(b.boundary.activations.length - before, 1); for (let batch = 0; batch < 10 && b.routes.length === routes; batch++) await b.flush(); assert.equal(b.routes.length - routes, 1, 'original source-tip settles the public empty-release HTTP outcome: ' + JSON.stringify(requests)); assert.equal(b.routes.at(-1).url, '/pages/source-pack/index', 'original unavailable official offer falls back to the original source-pack route once');
    assert.equal(requests.filter(n => n.url.includes('/source/manifest')).length, 1, 'one public source-tip activation requests one real manifest'); assert.deepEqual(loading.map(n => n.action), ['show','hide'], 'original loading service pairs the real native SDK receipts');
    assert.equal(b.load('services/pack-install-sheet.ts').packInstallSheetState().visible.value, false);
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(b.byClass('source-tip')[0])['min-height'], undefined, 'same-mounted touch preserves the original source-tip stylesheet'); for (const cls of ['source-tip-title','source-tip-desc']) assert.equal(b.css(b.byClass(cls)[0])['line-height'], undefined, 'touch returns to original source-tip text CSS');
  } finally { await b.close(); }
  console.log('PASS home original source-tip real offer fallback/public action once/TV56/touch');
}
async function homeUnreadCase() {
  const center = Array.from({ length:100 }, (_, i) => ({ ...publicNotice, id:800 + i, title:'未读原通知' + (i + 1) })), data = installedDataBoundary(), requests = [];
  const b = await fixture({ boundaryOverrides:{ 'uni_modules/qt-js-engine':data.sdk }, sdkOverrides:{ request(request) { requests.push({ url:request.url, headers:request.header }); const data = request.url.includes('/message/unread-count') ? 100 : request.url.includes('/message/center') ? center : []; request.success?.({ statusCode:200, data:JSON.stringify({ code:200, data }) }); } } });
  try {
    b.load('services/auth.ts').saveTokens({ accessToken:'fixture-notice-token', refreshToken:'fixture-refresh-token', expiresAt:5000000 }); await b.load('stores/notice.ts').useNoticeStore().refreshUnread();
    assert.equal(b.load('stores/notice.ts').useNoticeStore().unreadCount, 100); assert.equal(requests.filter(n => n.url.includes('/message/unread-count')).length, 1); assert.equal(requests.filter(n => n.url.includes('/message/center')).length, 1, 'real original unread refresh resolves backend candidates against local read state');
    await b.mount('pages/home/index.uvue'); await b.clock.runTimers(1000); await b.flushMeasurements();
    const label = b.byClass('home-bell-dot-text')[0], badge = b.byClass('home-bell-dot')[0]; assert.equal(textOf(label), '99+', 'original Home caps public unread count at99+'); assert.equal(b.css(label)['font-size'], '20px'); assert.equal(b.css(label)['line-height'], '28px', 'TV original unread badge uses the actual20px reading line'); assert.equal(b.css(badge).height, '28px', 'badge box grows to contain its actual TV reading line'); assert.equal(b.css(badge)['min-width'], '28px');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); assert.equal(b.css(b.byClass('home-bell-dot-text')[0])['font-size'], '20px'); assert.equal(b.css(b.byClass('home-bell-dot-text')[0])['line-height'], '28px'); assert.equal(b.css(b.byClass('home-bell-dot')[0]).height, '28px');
    const bell = b.byClass('home-bell')[0]; b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(bell))); const before = b.routes.length; await remote(b,'ok'); await remote(b,'ok',1); assert.equal(b.routes.length - before, 1); assert.equal(b.routes.at(-1).url, '/pages/notice/list/index'); assert.equal(b.load('stores/notice.ts').useNoticeStore().unreadCount, 100, 'original bell action preserves unread state');
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(b.byClass('home-bell-dot-text')[0])['line-height'], undefined); assert.equal(b.css(b.byClass('home-bell-dot')[0]).height, undefined, 'touch recovers original badge dimensions');
  } finally { await b.close(); }
  console.log('PASS home original public unread/count99+/real bell route once/TV badge line box/huge/touch');
}
async function homeEmptyCase() {
  const data = installedDataBoundary({ responses:{ recommendations:{ list:[] }, latest:{ list:[] }, charts:{ list:[] }, allCharts:{ list:[] } } });
  const b = await fixture({ boundaryOverrides:{ 'uni_modules/qt-js-engine':data.sdk } });
  try {
    await b.mount('pages/home/index.uvue'); await b.clock.runTimers(1000); await b.flushMeasurements();
    assert.equal(b.load('stores/source-registry.ts').useSourceRegistryStore().ready, true); assert.equal(data.calls.filter(n => n.name === 'recommendations').length, 1); assert.equal(data.calls.filter(n => n.name === 'latest').length, 1);
    const empty = b.byClass('wide-empty-text'); assert.deepEqual(empty.map(textOf), ['暂无推荐内容','暂无新歌','暂无榜单']); assert.equal(b.byClass('home-fail').length, 0, 'successful empty source data preserves the original non-failure state');
    for (const n of empty) { assert.equal(b.css(n)['font-size'], '20px'); assert.equal(b.css(n)['line-height'], '28px', 'TV original Home empty notices use actual20px same-source28px line boxes'); }
    assert.equal(b.byClass('section-more').length, 3, 'all original More actions remain available in empty content');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); for (const n of b.byClass('wide-empty-text')) { assert.equal(b.css(n)['font-size'], '21.6px'); assert.equal(b.css(n)['line-height'], '30px'); }
    b.tv.qtSetTvMode('touch'); await b.flush(); for (const n of b.byClass('wide-empty-text')) { assert.equal(b.css(n)['font-size'], '18px'); assert.equal(b.css(n)['line-height'], undefined); }
    b.setWindow({ windowWidth:390, windowHeight:844 }); await b.flush(); assert.deepEqual(b.byClass('home-empty-text').map(textOf), ['暂无推荐内容','暂无榜单','暂无新歌']);
  } finally { await b.close(); }
  console.log('PASS home real empty source data/original three empty notices/More/TV line/huge/touch/phone');
}
async function homeInlineCase() {
  const data = installedDataBoundary(), b = await fixture({ width:900, boundaryOverrides:{ 'uni_modules/qt-js-engine':data.sdk } });
  try {
    await b.mount('pages/home/index.uvue'); await b.clock.runTimers(1000); await b.flushMeasurements();
    assert.equal(b.css(b.byClass('wide-home')[0]).width, '708px', 'Home derives geometry from the actual708px TV pane, not the900px whole window');
    const shortcuts = b.byClass('wide-shortcut'); assert.equal(shortcuts.length, 3); assert.ok(shortcuts.every(n => hasClass(n,'wide-shortcut-inline')), 'the real compound-class inline branch is exercised');
    assert.equal(b.byClass('wide-shortcut-desc').length, 0); assert.equal(b.byClass('wide-playlist-card').length, 7);
    for (const n of b.byClass('wide-playlist-card')) assert.equal(b.css(n).width, '217px', 'actual708px pane keeps three217px TV cards rather than sub208 cards');
    for (const n of shortcuts) { assert.ok(n.classList.includes('wide-shortcut-inline')); assert.ok(parseFloat(b.css(n)['min-height']) >= 92, 'normal inline shortcut reserves36px icon/8px gap/28px title/original20px padding'); }
    b.tv.qtTvRefreshFocus(); const podcast = shortcuts.find(n => textOf(n).includes('播客')); assert.ok(b.boundary.collected.at(-1).result.some(n => n.id === b.boundary.id(podcast)), 'native compound-class target remains in the real current-owner collection'); assert.ok(b.tv.qtTvFocus(b.boundary.id(podcast)));
    const before = b.boundary.activations.length; await remote(b,'ok'); await remote(b,'ok',1); assert.equal(b.boundary.activations.length - before, 1); assert.equal(b.load('uni_modules/qt-ui/composables/qt-wide-workspace.ts').qtWideToolRoute(), '/pages/podcast/index', 'inline shortcut preserves its original hosted Podcast action');
    await remote(b,'back'); assert.equal(b.load('uni_modules/qt-ui/composables/qt-wide-workspace.ts').qtWideToolRoute(), '');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); for (const n of b.byClass('wide-shortcut')) { assert.ok(hasClass(n,'wide-shortcut-inline')); assert.ok(parseFloat(b.css(n)['min-height']) >= 99); }
    b.tv.qtSetTvMode('touch'); await b.flush(); for (const n of b.byClass('wide-shortcut')) assert.equal(b.css(n)['min-height'], '90px', 'touch recovers original huge60x1.5 shortcut policy');
  } finally { await b.close(); }
  console.log('PASS home actual-pane inline compound classes/card208/normal huge/hosted public action once');
}
async function homeBackCase() {
  const data = installedDataBoundary(), splash = { ...publicNotice, id:511, display:1, dialogClosable:1, title:'首页公开可关闭公告' };
  const b = await fixture({ notices:[splash], boundaryOverrides:{ 'uni_modules/qt-js-engine':data.sdk } });
  try {
    const notices = b.load('stores/notice.ts').useNoticeStore(); await notices.load();
    await b.mount('pages/home/index.uvue'); await b.clock.runTimers(1000); await b.flushMeasurements();
    assert.equal(b.byClass('nts-card').length, 1, 'original Home public notice has the highest startup popup');
    const confirms = b.load('services/confirm.ts'), confirmation = confirms.qtConfirm({ title:'公开最高优先级确认', content:'公开对话正文' }); await b.flush();
    assert.equal(b.tv.qtTvHasModal(), true); await remote(b, 'back'); assert.equal(await confirmation, false);
    assert.equal(b.byClass('qc-card').length, 0); assert.equal(b.byClass('nts-card').length, 1, 'highest modal Back leaves the underlying original notice intact');
    assert.equal(b.taskMoves.length, 0); assert.equal(b.toastCalls.filter(n => n.title === '再按一次退出应用').length, 0);
    const document = b.byClass('nts-content')[0]; b.boundary.scrollExtent('nts-content', 1600); b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(document))); await remote(b, 'down'); assert.equal(b.boundary.offset(document), 280); await remote(b, 'up'); assert.equal(b.boundary.offset(document), 0);
    await remote(b, 'back'); assert.equal(notices.splashNotice, null); assert.equal(b.byClass('nts-card').length, 0); assert.equal(b.toastCalls.filter(n => n.title === '再按一次退出应用').length, 0);
    const action = b.action.qtShowActionSheet({ title:'公开首页动作', itemList:['保留动作'] }); await b.flush(); await remote(b, 'back'); assert.equal(await action, -1); assert.equal(b.action.qtActionSheetState().visible.value, false);
    const player = b.load('stores/player.ts').usePlayerStore(); await b.dispatch(b.byClass('wide-song-row')[0]); await b.flush();
    const queueButton = b.byClass('pbar-right')[0].children.filter(n => hasClass(n, 'pbar-btn')).at(-1); b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(queueButton))); await remote(b, 'ok'); assert.equal(b.byClass('qpq-panel').length, 1, 'original public player-bar action mounts the real queue');
    const current = player.current, revision = player.playbackRevision(); await remote(b, 'back'); assert.equal(b.byClass('qpq-panel').length, 0); assert.equal(player.current, current); assert.equal(player.playbackRevision(), revision);
    const ws = b.load('uni_modules/qt-ui/composables/qt-wide-workspace.ts');
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus('nav:/pages/settings/index')); await remote(b, 'ok'); await b.clock.runTimers(1000); await b.flushMeasurements();
    assert.equal(ws.qtWideToolRoute(), '/pages/settings/index'); assert.equal(b.byClass('qt-wide-workspace').length, 1); assert.equal(b.byClass('list').length, 1, 'actual Home mounts a single real Settings overview');
    const settingsRoot = b.byClass('list')[0], playback = walk(settingsRoot).find(n => hasClass(n, 'cell') && textOf(n).includes('播放设置'));
    b.tv.qtTvRefreshFocus(); const activeRoot = b.boundary.collected.at(-1).root; assert.ok(walk(activeRoot).includes(playback)); assert.ok(!walk(activeRoot).includes(b.byClass('home-search')[0]), 'active tool focus scope excludes background Home actions');
    await remote(b, 'back'); assert.equal(ws.qtWideToolRoute(), ''); assert.equal(b.byClass('list').length, 0, 'tool Back unmounts the original single active pane');
    b.tv.qtTvRefreshFocus(); assert.ok(!walk(b.boundary.collected.at(-1).root).includes(settingsRoot)); assert.equal(b.toastCalls.filter(n => n.title === '再按一次退出应用').length, 0, 'overlay/action/queue/tool dismissals do not count as a Home exit press');
    const back = b.load('uni_modules/qt-ui/stores/home-back.ts'); back.setHomeBackMode('background'); await b.flush();
    const stopBefore = b.nativeCalls.filter(n => n.name === 'audioStop').length; await remote(b, 'back'); assert.deepEqual(b.taskMoves, ['background']); assert.equal(player.current, current); assert.equal(b.nativeCalls.filter(n => n.name === 'audioStop').length, stopBefore, 'background keeps actual playback and queue');
    back.setHomeBackMode('double-exit'); await b.flush(); await remote(b, 'back'); assert.deepEqual(b.taskMoves, ['background']);
    const promptCount = b.toastCalls.filter(n => n.title === '再按一次退出应用').length; assert.equal(promptCount, 1); await remote(b, 'back', 1); assert.equal(b.taskMoves.length, 1, 'held Back repeat never counts as the second exit');
    await b.clock.runTimers(2001); await remote(b, 'back'); assert.equal(b.toastCalls.filter(n => n.title === '再按一次退出应用').length, 2, 'expired original two-second guard starts a fresh first press');
    await b.clock.runTimers(500); await remote(b, 'back'); assert.deepEqual(b.taskMoves, ['background','exit']); assert.ok(b.nativeCalls.filter(n => n.name === 'audioStop').length > stopBefore, 'original second Back stops for exit through real PlayerStore');
    assert.ok(b.storage.has('qt-player-state'), 'original exit preserves player state rather than clearing storage');
  } finally { await b.close(); }
  console.log('PASS home highest modal/public action/queue/active tool/back-background/original double-exit guard');
}
async function podcastCase() {
  const rssCalls = [];
  const b = await fixture({ sdkOverrides:{ request(request) { rssCalls.push(request); } } });
  const feed = (title = '公开RSS节目') => '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>' + title + '</title><description>原节目简介</description><itunes:author>原节目作者</itunes:author>' + Array.from({ length:30 }, (_, i) => '<item><title>公开单集' + (i + 1) + '</title><description>原单集简介</description><enclosure url="https://rss.fixture.invalid/audio-' + i + '.mp3" type="audio/mpeg"/><itunes:duration>03:00</itunes:duration><pubDate>Thu, 01 Jan 1970 00:' + String(10 + i).padStart(2, '0') + ':00 GMT</pubDate></item>').join('') + '</channel></rss>';
  try {
    // App.onLaunch calls this public initializer; the frozen page loader does not mount App.
    b.player.restore(); await b.flush();
    await b.mount('pages/podcast/index.uvue'); await b.clock.runTimers(50); await b.flushMeasurements();
    assert.ok(b.text().includes('还没有订阅任何播客'), 'whole original Podcast mounts empty through real storage');
    await b.dispatch(b.byClass('sub-input')[0], 'input', { value:'  https://rss.fixture.invalid/feed.xml  ' });
    const subscribe = b.byClass('sub-btn')[0]; b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(subscribe))); await remote(b, 'ok'); await remote(b, 'ok', 1);
    await b.dispatch(b.byClass('sub-input')[0], 'confirm');
    assert.equal(rssCalls.length, 1, 'busy and held-key/confirm preserve one original RSS fetch');
    assert.equal(rssCalls[0].url, 'https://rss.fixture.invalid/feed.xml'); assert.equal(rssCalls[0].dataType, 'text'); assert.equal(rssCalls[0].timeout, 20000);
    assert.ok(b.text().includes('订阅中'), 'original pending state stays visible');
    rssCalls[0].success({ statusCode:200, data:feed() }); await b.flush(); await b.clock.runTimers(1000);
    const service = b.load('services/podcast.ts'), shows = service.listPodcastShows();
    assert.equal(shows.length, 1, 'real addPodcastShow persists one normalized feed'); assert.equal(shows[0].title, '公开RSS节目');
    assert.equal(service.listPodcastEpisodes(shows[0].id).length, 30, 'real RSS parser retains original audio enclosures');
    assert.equal(b.byClass('ep-item').length, 25, 'original24 episode rows plus visible More');
    assert.equal(rssCalls.length, 1, 'freshly subscribed feed avoids auto-refresh');
    const ep = b.byClass('ep-play')[0], expectedTitle = textOf(b.byClass('ep-name')[0]), player = b.load('stores/player.ts').usePlayerStore(), revision = player.playbackRevision();
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(ep))); await remote(b, 'ok'); await remote(b, 'ok', 1); await b.clock.runTimers(0);
    assert.equal(player.playbackRevision() - revision, 1, 'public Podcast play requests the exact enclosure only once');
    assert.equal(player.current?.name, expectedTitle); assert.equal(player.current?.platform, 'podcast'); assert.equal(player.current?.id, 'https://rss.fixture.invalid/audio-29.mp3', 'latest actual episode retains its exact RSS enclosure'); assert.equal(player.queue.length, 1, 'original single-episode queue');
    assert.equal(b.css(ep).height, '56px', 'actual TV episode play is full native target');
    const podcastTextIssues = [];
    for (const [cls, font, line] of [['hero-title','30.36px','43px'], ['hero-desc','20px','28px'], ['sub-input','20px','28px'], ['sub-btn-text','20px','28px'], ['notice-text','20px','28px'], ['sec-title','22.08px','31px'], ['sec-sub','20px','28px'], ['show-name','22.08px','31px'], ['show-meta','20px','28px'], ['detail-title','24.84px','35px'], ['detail-desc','20px','28px'], ['detail-meta','20px','28px'], ['ep-name','20.7px','29px'], ['ep-meta','20px','28px'], ['ep-flag','20px','28px']]) {
      assert.ok(b.byClass(cls).length > 0, 'whole Podcast retains original visible text: ' + cls);
      for (const node of b.byClass(cls)) if (b.css(node)['font-size'] !== font || b.css(node)['line-height'] !== line) podcastTextIssues.push({ cls, font:b.css(node)['font-size'], line:b.css(node)['line-height'], expected:{ font, line } });
    }
    assert.deepEqual(podcastTextIssues, [], 'whole Podcast actual TV text and line boxes stay same-source');
    for (const cls of ['sub-field', 'sub-input', 'sub-btn', 'show-act', 'ep-info']) {
      assert.ok(b.byClass(cls).length > 0, 'original Podcast input/action is rendered: ' + cls);
      for (const node of b.byClass(cls)) assert.ok(parseFloat(b.css(node).height ?? b.css(node)['min-height'] ?? '0') >= 56, 'Podcast actual TV target56: ' + cls);
    }
    const more = b.button('加载更多单集'); assert.ok(more, 'original explicit More remains public'); assert.equal(b.css(more).height, '56px');
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(more))); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(b.byClass('ep-item').length, 30); assert.equal(b.byClass('ep-name').length, 30); assert.equal(b.button('加载更多单集'), undefined, 'all30 actual episodes replace the24+More viewport');
    await b.dispatch(b.byClass('scroll')[0], 'scrolltolower'); assert.equal(b.byClass('ep-name').length, 30, 'native lower-bound callback stays idempotent after the original last batch');
    assert.equal(player.playbackRevision(), revision + 1, 'pagination never requests another playback');
    await nativeAudioEvent(b, 'audioOnResolveRequest', 'podcast:https://rss.fixture.invalid/audio-29.mp3');
    const resolved = b.nativeCalls.filter(n => n.name === 'audioResolveDone');
    assert.ok(resolved.some(n => n.args[0] === 'podcast:https://rss.fixture.invalid/audio-29.mp3' && n.args[1] === 'https://rss.fixture.invalid/audio-29.mp3'), 'real native lazy resolve receives the exact original RSS enclosure');
    assert.equal(player.current.url, 'https://rss.fixture.invalid/audio-29.mp3'); assert.equal(rssCalls.length, 1, 'podcast URL uses the original music-api direct branch, no extra RSS request');
    b.clock.advance(801); await nativeAudioEvent(b, 'audioOnTimeUpdate', 45, 180);
    assert.equal(player.progress, 45, 'real native audio callback reaches PlayerStore through the unchanged AudioPlayer');
    assert.equal(service.listPodcastEpisodes(shows[0].id).find(n => n.audioUrl === player.current.id).positionMs, 0, 'original Podcast avoids a write until pause or heartbeat');
    await nativeAudioEvent(b, 'audioOnPause'); assert.equal(player.playing, false);
    const saved = service.listPodcastEpisodes(shows[0].id).find(n => n.audioUrl === player.current.id);
    assert.equal(saved.positionMs, 45000); assert.equal(saved.played, false, 'native pause forces original precise unfinished episode progress to storage');
    assert.ok(b.text().includes('继续播放 0:45') && b.text().includes('已暂停'), 'original episode status and resume copy update from actual saved progress');
    await b.dispatch(b.byClass('ep-play')[0]); assert.equal(player.current.id, 'https://rss.fixture.invalid/audio-29.mp3');
    const continued = b.nativeCalls.filter(n => n.name === 'audioSetPlaylist').at(-1);
    assert.equal(continued.args[3], 45, 'original same-episode resume pushes the saved45s through the actual audio timeline');
    assert.equal(player.playbackRevision(), revision + 2, 'empty native media ID takes the original single cold-resume rebuild, rather than double activating');
    const resumedRevision = player.playbackRevision();
    await nativeAudioEvent(b, 'audioOnPause');
    const refresh = b.byClass('show-act')[0]; b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(refresh)));
    await remote(b, 'ok'); await remote(b, 'ok', 1); await remote(b, 'ok');
    assert.equal(rssCalls.length, 2, 'held and repeated public refresh requests coalesce in the original refreshing guard');
    rssCalls[1].success({ statusCode:200, data:feed('更新后的公开RSS节目') }); await b.flush();
    assert.ok(b.text().includes('更新后的公开RSS节目') && b.text().includes('已更新'), 'real refresh updates the original selected show and visible result');
    assert.equal(service.listPodcastEpisodes(shows[0].id).find(n => n.audioUrl === player.current.id).positionMs, 45000, 'real refresh retains enclosure-matched progress');
    assert.equal(b.byClass('ep-name').length, 30, 'refresh of the same selected show retains expanded original pagination');
    assert.equal(player.playbackRevision(), resumedRevision, 'refresh never steals the current playback or requests a new episode');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    for (const [cls, font, line] of [['hero-title','39.6px','55px'], ['hero-desc','25.2px','35px'], ['sub-input','25.2px','35px'], ['show-name','28.8px','40px'], ['show-meta','21.6px','30px'], ['detail-title','32.4px','45px'], ['detail-desc','23.4px','33px'], ['ep-name','27px','38px'], ['ep-meta','21.6px','30px'], ['ep-flag','20px','28px']]) {
      for (const node of b.byClass(cls)) { assert.equal(b.css(node)['font-size'], font); assert.equal(b.css(node)['line-height'], line, 'huge Podcast exact actual font line: ' + cls); }
    }
    const remove = b.byClass('show-act')[1]; b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(remove))); await remote(b, 'ok');
    assert.equal(b.tv.qtTvHasModal(), true); assert.ok(b.text().includes('音频缓存不会一起删')); assert.equal(b.tv.qtTvFocus(b.boundary.id(b.byClass('ep-play')[0])), false, 'real removal confirmation excludes background playback actions');
    await remote(b, 'back'); assert.equal(service.listPodcastShows().length, 1, 'public Back cancels the original danger confirmation before business removal');
    b.tv.qtTvRefreshFocus(); assert.ok(b.tv.qtTvFocus(b.boundary.id(remove))); await remote(b, 'ok'); assert.ok(b.tv.qtTvFocus('confirm-accept')); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(service.listPodcastShows().length, 0); assert.equal(service.listPodcastEpisodes(shows[0].id).length, 0, 'public confirm removes only the original show and episode storage');
    assert.equal(player.playbackRevision(), resumedRevision); assert.equal(player.current.id, 'https://rss.fixture.invalid/audio-29.mp3', 'removing the subscription preserves the original current audio and queue');
    assert.ok(b.text().includes('已取消订阅') && b.text().includes('还没有订阅任何播客'));
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(b.byClass('sub-btn')[0]).height, undefined); assert.equal(b.css(b.byClass('hero-title')[0])['line-height'], undefined, 'touch restores original dual-font CSS and subscription box');
    b.setWindow({ windowWidth:390, windowHeight:844, screenWidth:390, screenHeight:844 }); await b.clock.runTimers(500);
    await b.dispatch(b.byClass('sub-input')[0], 'input', { value:'https://rss.fixture.invalid/phone.xml' }); await b.dispatch(b.byClass('sub-btn')[0]);
    assert.equal(rssCalls.length, 3); assert.equal(rssCalls[2].url, 'https://rss.fixture.invalid/phone.xml', 'original narrow-phone subscription click is retained exactly once');
    rssCalls[2].success({ statusCode:200, data:feed('手机原节目') }); await b.flush(); assert.ok(b.text().includes('手机原节目'));
  } finally { await b.close(); }
  console.log('PASS podcast real RSS busy/parser/storage/public playback/More/native URL/progress/pause and TV target');
}
export async function runTvPrimaryChecks(which = '') {
  if (!which || which === 'notice-detail') await noticeDetailCase();
  if (!which || which === 'notice-action') await noticeActionCase();
  if (!which || which === 'notice-list') await noticeListCase();
  if (!which || which === 'notice-list' || which === 'notice-logged') await noticeLoggedCase();
  if (!which || which === 'notice-list' || which === 'notice-empty') await noticeEmptyCase();
  if (!which || which === 'feedback') await feedbackCase();
  if (!which || which === 'profile') await profileCase();
  if (!which || which === 'settings') await settingsCase();
  if (!which || which === 'playlists') await playlistsCase();
  if (!which || which === 'chart') await chartCase();
  if (!which || which === 'home') await homeCase();
  if (!which || which === 'home' || which === 'home-inline') await homeInlineCase();
  if (!which || which === 'home' || which === 'home-empty') await homeEmptyCase();
  if (!which || which === 'home' || which === 'home-failure') await homeFailureCase();
  if (!which || which === 'home' || which === 'home-source-tip') await homeSourceTipCase();
  if (!which || which === 'home' || which === 'home-unread') await homeUnreadCase();
  if (!which || which === 'home' || which === 'home-back') await homeBackCase();
  if (!which || which === 'podcast') await podcastCase();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runTvPrimaryChecks(process.argv.find(value => value.startsWith('--case='))?.slice(7) ?? '');
}
