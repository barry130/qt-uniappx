// task-28 agreed seam: whole production form SFC + real QtUI + public native
// input/click/remote + unchanged business services. Only SDK viewport/clock,
// native files/cookies/navigation and HTTP responses are fixture boundaries.
// Native rectangles are synthetic, not Yoga, IME or device acceptance.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as Vue from 'vue';
import { tvListHostFixture } from './check-tv-list-hosts.mjs';

const noop = () => {};
const cases = {};
const walk = node => node == null ? [] : [node, ...node.children.flatMap(walk)];
const classes = node => String(node.props.class ?? '').split(/\s+/);
const textOf = node => node.text + node.children.map(textOf).join('');
const idOf = (b, id) => walk(b.root).find(node => node.props['data-qt-tv-id'] === id);
const px = (b, node, name) => Number.parseFloat(b.css(node)[name] ?? '0');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const remote = async (b, key, repeat = 0) => {
  const code = { up:19, down:20, left:21, right:22, ok:23, back:4, menu:82 }[key];
  const result = b.tv.qtTvDispatchRemote({ key, code, action:'down', repeat }); await b.flush(); return result;
};

async function formFixture({ width = 1280, height = 720, savedMode = 'tv', initialStorage = {}, routeOptions = {},
  requestHandler = null, sdkOverrides = {}, nativeOverrides = {}, engineOverrides = {}, compilerUts = false, files = {} } = {}) {
  const network = [], routes = [], candidates = new Map(), highlights = [], activations = [], scrolls = [], nativeCalls = [], restoredCompilerBindings = [];
  const elementIds = new WeakMap(); let serial = 0, b;
  function collect(root) {
    root = Vue.toRaw(root); candidates.clear();
    return walk(root).flatMap((node, index) => {
      let visible = true;
      for (let ancestor = node; ancestor; ancestor = ancestor.parent) if (b?.css(ancestor).display === 'none') visible = false;
      if (!visible || classes(node).includes('qt-tv-skip')) return [];
      const input = node.tag === 'input' || node.tag === 'textarea', scroll = (node.tag === 'scroll-view' || node.tag === 'list-view') && classes(node).includes('qt-tv-scroll');
      if (!input && !scroll && typeof node.props.onClick !== 'function' && !Array.isArray(node.props.onClick) && typeof node.props.onTap !== 'function') return [];
      let id = elementIds.get(node);
      if (!id) { id = 'native:custom:' + (node.props['data-qt-tv-id'] || 'node-' + ++serial); elementIds.set(node, id); }
      candidates.set(id, node);
      return [{ id, left:28, top:28 + index * 60, width:300, height:56,
        visible:true, enabled:node.props.disabled !== true, input, longPress:false, scrollGroup:scroll ? id : '' }];
    });
  }
  const sdk = { publicDataDir:() => '', dataDir:() => '/owned-fixture', queryPermissionStates:() => [], statLocalFile:() => -1,
    readEmbeddedTags:() => null, readTextFile:(_path, reply) => reply(false, '', 'fixture file absent'),
    exists:(_path, reply) => reply(true, '0', ''), start:() => false, isRunning:() => false, isHealthy:() => false,
    ...engineOverrides };
  const native = { supportsHomeBackMode:() => true, isHarmonyOs:() => false, openInBrowser:url => nativeCalls.push(['browser', url]),
    exitApp:() => nativeCalls.push(['exit']), supportsNativeAuthWebView:() => false, closeAuthWebView:noop,
    ...nativeOverrides };
  b = await tvListHostFixture({ width, height, savedMode, initialStorage, routeOptions, files, realFrame:true,
    boundaryOverrides:{ 'services/music-api':undefined, 'services/http':undefined,
      'services/config':{ API_BASE_URL:'https://owned.invalid/api/' },
      'services/app-version':{ getCurrentVersionCode:() => 1, getCurrentVersionName:() => 'fixture' },
      'services/app-native':native, 'uni_modules/qt-app-native':sdk, 'uni_modules/qt-js-engine':sdk,
      'services/tv-platform':{ tvReadDevice:() => ({ television:false, nativeAvailable:false }), tvStartRemote:noop, tvSetRemoteState:noop, tvStopRemote:noop,
        tvCollect:collect, tvHighlight:(...args) => highlights.push(args), tvActivate:(id, action) => {
          activations.push([id, action]); const target = candidates.get(id);
          if (target && target.tag !== 'input' && target.tag !== 'textarea') void b.dispatch(target, typeof target.props.onTap === 'function' ? 'tap' : 'click');
        }, tvScroll:(id, direction) => { scrolls.push([id, direction]); return true; }, tvPresent:noop,
        tvBack:() => { const consumed = b.lifecycle.backPress.some(fn => fn({ from:'backbutton' }) === true); if (!consumed) routes.push({ action:'native-back' }); } } },
    sdkOverrides:{ getDeviceInfo:() => ({ deviceModel:'TV fixture', osName:'Android', osVersion:'14' }),
      showLoading:value => nativeCalls.push(['loading-show', value]), hideLoading:() => nativeCalls.push(['loading-hide']),
      reLaunch:value => routes.push({ action:'relaunch', ...value }),
      switchTab:value => { routes.push({ action:'tab', ...value }); value.success?.({}); },
      request:options => {
        network.push({ url:options.url, method:options.method, data:options.data, header:options.header, options });
        if (requestHandler) requestHandler(options, network); else options.fail?.({ errMsg:'owned network response not selected' });
      }, ...sdkOverrides } });
  if (compilerUts) {
    // Frozen Node loader is not the UTS compiler. Scope typed accessors and
    // .uts JSON semantics to this fixture and restore every descriptor on close.
    const http = b.load('services/http.ts'), proto = Object.getPrototypeOf(http.parseJsonToUtso('{}'));
    const names = [['getString','string'],['getNumber','number'],['getBoolean','boolean']];
    const old = names.map(([name]) => [name, Object.getOwnPropertyDescriptor(proto, name)]);
    for (const [name, type] of names) Object.defineProperty(proto, name, { configurable:true, value(key) { const value = this.get(key); return typeof value === type ? value : null; } });
    const realms = [['services/source-pack-header.uts','parsePackHeader'],['services/source-engine.uts','sourceEngineEpoch']].map(([path, name]) => {
      const exported = b.load(path)[name];
      const json = exported.constructor('return JSON')(), parse = json.parse; json.parse = text => http.parseJsonToUtso(text); return { json, parse };
    });
    const close = b.close; b.close = async () => { try { await close(); } finally {
      for (const { json, parse } of realms) { json.parse = parse; assert.equal(json.parse, parse, 'exact original .uts JSON realm parser restored'); restoredCompilerBindings.push('uts-json'); }
      for (const [name, descriptor] of old) { if (descriptor) Object.defineProperty(proto, name, descriptor); else delete proto[name]; assert.deepEqual(Object.getOwnPropertyDescriptor(proto, name), descriptor, 'exact typed-accessor descriptor restored'); restoredCompilerBindings.push(name); }
    } };
  }
  // Original QtLoading still owns props/render/startSpin/cancellation; this
  // fixture supplies only its native UniElement.animate return interface.
  const animations = [], Loading = b.load('uni_modules/qt-ui/components/qt-loading/qt-loading.uvue').default;
  function attachAnimate(root) {
    for (const node of walk(root)) if (!node.animate) node.animate = (keyframes, options) => {
      const receipt = { node, keyframes, options, cancelled:0 }; animations.push(receipt);
      return { cancel:() => { receipt.cancelled++; } };
    };
  }
  Loading.mixins = [{ mounted() { attachAnimate(this.$el); }, updated() { attachAnimate(this.$el); } }];
  // Complete only the native node interface needed by Vue's original v-show.
  // Keep production directive hooks, expressions and node lifetime unchanged.
  const css = b.css, mount = b.mount, autoImports = [];
  b.css = node => ({ ...css(node), ...(node.style?.display != null ? { display:node.style.display } : {}) });
  b.mount = async (...args) => {
    if (args[0] === 'pages/web-login/index.uvue') {
      // UniAppX auto-imports these symbols. The frozen Node compiler does not;
      // supply only original Vue/SDK bindings in this compiled SFC's VM realm.
      const setup = b.load(args[0]).default.setup, realm = setup.constructor('return globalThis')();
      const lifecycle = b.load('@dcloudio/uni-app'), bindings = { ref:Vue.ref, computed:Vue.computed,
        onLoad:lifecycle.onLoad, onShow:lifecycle.onShow, onUnload:lifecycle.onUnload };
      for (const [name, value] of Object.entries(bindings)) {
        autoImports.push({ realm, name, descriptor:Object.getOwnPropertyDescriptor(realm, name) });
        Object.defineProperty(realm, name, { configurable:true, writable:true, value });
      }
    }
    const beforeMount = Vue.vShow.beforeMount;
    Vue.vShow.beforeMount = (node, binding, vnode) => { node.style ??= { display:'' }; return beforeMount(node, binding, vnode); };
    try { await mount(...args); } finally { Vue.vShow.beforeMount = beforeMount; }
  };
  const closeWithCompiler = b.close;
  b.close = async () => { try { await closeWithCompiler(); } finally {
    for (const { realm, name, descriptor } of autoImports.reverse()) { if (descriptor) Object.defineProperty(realm, name, descriptor); else delete realm[name]; assert.deepEqual(Object.getOwnPropertyDescriptor(realm, name), descriptor, 'exact web compiler auto-import descriptor restored'); restoredCompilerBindings.push('web:' + name); }
  } };
  return { ...b, network, routes:[...b.routes], nativeRoutes:routes, candidates, highlights, activations, scrolls, nativeCalls, animations,
    restoredCompilerBindings, routeEvents:() => [...b.routes, ...routes], id:id => idOf(b, id), inputs:() => walk(b.root).filter(node => node.tag === 'input' || node.tag === 'textarea') };
}

function installedMetaBoundary(answer = null) {
  // Native engine/FS callback transport only; original boot/header/registry,
  // policy/parser/detail/source-auth/store orchestration remains production.
  const calls = [], files = new Map(), id = 'meta-forms-fixture'; let running = false;
  const pack = { id, kind:'meta', name:'表单契约数据包', versionCode:1, versionName:'1.0', updateUrl:'', installedAt:1, updatedAt:1, skipCodes:[] };
  files.set('/owned-fixture/source-bundle/state.json', JSON.stringify({ schema:3, packs:[pack], activeId:'', activeMetaId:id, lastCheckAt:0 }));
  files.set('/owned-fixture/source-bundle/install/' + id + '/meta-bundle.js', '/*__QT_PACK__' + JSON.stringify(pack) + '*/\nexport default {};');
  const sources = [
    { id:'wyy', name:'契约网易云', short:'网', color:'#248A58', features:{ playlists:true }, auth:{ methods:['cookie'], domains:['owned-web.invalid'], webLogin:{ url:'https://owned-web.invalid/login', cookieMarkers:['MUSIC_U'], captureUrls:['https://owned-web.invalid/'], note:'原包登录说明' } } },
    { id:'qq', name:'契约QQ音乐', short:'Q', color:'#248A58', features:{ playlists:true }, auth:{ methods:['cookie'], domains:['y.qq.com'], webLogin:{ url:'https://y.qq.com/n/ryqq/profile/login', cookieMarkers:['qm_keyst'], captureUrls:['https://y.qq.com/'], note:'原QQ登录说明' } } },
  ];
  const defaults = name => {
    if (name === 'bundleInfo') return { name:'meta-bundle', hostApiVersion:1, metaRevision:1, sourcePolicyVersion:1 };
    if (name === 'setSourcePolicy') return { ok:true, playSupported:true };
    if (name === 'sourceRegistry') return { sourcePolicyVersion:1, sources, qualities:[{ id:'320', name:'标准' }] };
    if (name === 'getSourceQualities') return { source:'wyy', mode:'platform', qualities:[{ id:'320', name:'标准' }] };
    if (name === 'parseSheet') return { platform:'wyy', id:'remote-list-1' };
    if (name === 'playlistDetail') return { detail:{ id:'remote-list-1', platform:'wyy', name:'原始远程歌单', picUrl:'https://owned-cover.invalid/list.png', complete:true,
      tracks:[{ id:'remote-song-1', name:'第一首原曲', singer:'原歌手', interval:181 },{ id:'remote-song-2', name:'第二首原曲', singer:'原歌手', interval:202 },{ id:'remote-song-1', name:'第一首原曲', singer:'原歌手', interval:181 }] } };
    if (name === 'authImportCookie') return { ok:true, user:{ id:'owned-source-user', nickname:'原音源账号', avatar:'https://owned-cover.invalid/user.png', vip:true, vipLabel:'原会员' } };
    return { ok:true };
  };
  const sdk = {
    dataDir:() => '/owned-fixture', isRunning:() => running, isHealthy:() => true,
    start(options, reply) { calls.push({ name:'start', options }); running = true; reply({ engine:'Native callback fixture', version:'1', hostApiVersion:1, probe:'2' }, null); },
    stop(reply) { running = false; calls.push({ name:'stop' }); reply({ ok:true, error:'' }); },
    readTextFile(path, reply) { calls.push({ name:'readTextFile', path }); files.has(path) ? reply(true, files.get(path), '') : reply(false, '', 'fixture file absent'); },
    exists:(path, reply) => reply(true, files.has(path) ? '1' : '0', ''),
    writeTextFile(path, value, reply) { files.set(path, value); reply(true, '', ''); },
    appendTextFile(path, value, reply) { files.set(path, (files.get(path) ?? '') + value); reply(true, '', ''); },
    mkdirs:(_path, reply) => reply(true, '', ''), remove:(path, reply) => { files.delete(path); reply(true, '', ''); },
    loadBundle(code, reply) { calls.push({ name:'loadBundle', code }); reply({ ok:true, error:'' }); },
    evaluate(code, reply) { calls.push({ name:'evaluate', code }); reply({ ok:true, value:'null', error:'' }); },
    invoke(name, argsJson, timeout, reply) {
      const args = JSON.parse(argsJson)[0] ?? {}, call = { name, args, argsJson, timeout }; calls.push(call);
      const value = answer?.(name, args, reply, call); if (value === 'HELD') return;
      reply({ ok:true, value:JSON.stringify(value === undefined ? defaults(name) : value), error:'' });
    },
  };
  return { sdk, calls, files, sources };
}

function fieldGeometry(b, node, label) {
  assert.ok(node, label + ' actual native input is mounted');
  assert.ok(px(b, node, 'height') >= 56, label + ' native input has a 56px TV target');
  assert.ok(px(b, node, 'font-size') >= 20, label + ' native input respects TV font floor');
  assert.ok(px(b, node, 'line-height') >= Math.ceil(px(b, node, 'font-size') * 1.35), label + ' line tracks its actual TV font');
  assert.ok(node.props.focus !== true, label + ' navigation never auto-opens IME');
  assert.ok(String(node.props['data-qt-tv-id'] ?? '').length > 0, label + ' focus identity is stable');
}
function textLine(b, node, label) {
  assert.ok(px(b, node, 'font-size') >= 20, label + ' TV font floor');
  assert.ok(px(b, node, 'line-height') >= Math.ceil(px(b, node, 'font-size') * 1.35), label + ' actual-font line');
}

cases['login-fields'] = async () => {
  const b = await formFixture({ width:800, height:360 });
  try {
    await b.mount('pages/login/index.uvue');
    assert.equal(b.runtimeErrors.length, 0, 'whole SFC setup and render succeeds before feature assertions');
    assert.equal(b.byClass('qt-page-frame').length, 1, 'actual QtPageFrame is used');
    assert.equal(b.byClass('field-input').length, 2, 'original login has account and password');
    const account = b.byClass('field-input')[0], password = b.byClass('field-input')[1];
    fieldGeometry(b, account, 'login account'); fieldGeometry(b, password, 'login password');
    assert.equal(account.props.maxlength, 50); assert.equal(password.props.maxlength, 18); assert.equal(password.props.type, 'password');
    const scroll = b.byClass('login-scroll')[0]; assert.ok(classes(scroll).includes('qt-tv-scroll'), 'short form keeps original scroll reachable by remote');
    const eye = b.byClass('eye')[0]; assert.ok(px(b, eye, 'width') >= 56 && px(b, eye, 'height') >= 56, 'visible password eye gets its own 56px target');
    await b.dispatch(eye); assert.equal(password.props.type, 'text', 'public eye click reveals original password input');
    await b.dispatch(eye); assert.equal(password.props.type, 'password', 'second click hides password once');
    await b.dispatch(account, 'input', { value:'用户 abc+123@test.com' }); assert.equal(account.props.value, 'abc123@test.com', 'original ASCII/email filter is preserved');
    await b.dispatch(password, 'input', { value:'pass123' });
    await b.dispatch(b.button('登 录')); assert.equal(b.network.filter(n => n.url.endsWith('/app/user/login')).length, 1, 'public QtButton reaches real AccountApi and HTTP once');
    assert.deepEqual(JSON.parse(JSON.stringify(b.network.at(-1).data)), { username:'abc123@test.com', password:'pass123' });
    assert.ok(b.toastCalls.some(value => value.title === '网络请求失败'), 'actual failed HTTP keeps original error feedback');
    await b.dispatch(b.byClass('seg-item')[1]);
    assert.equal(b.byClass('field-input').length, 4, 'existing register branch renders username/email/password/confirm');
    b.byClass('field-input').forEach((node, index) => fieldGeometry(b, node, 'register field ' + index));
    assert.deepEqual(b.byClass('field-input').map(node => node.props.maxlength), [30, 50, 18, 18]);
    assert.equal(new Set(b.byClass('field-input').map(node => node.props['data-qt-tv-id'])).size, 4);
    await b.dispatch(b.id('login:password-eye')); await b.dispatch(b.id('login:confirm-eye'));
    assert.equal(b.id('login:password').props.type, 'text'); assert.equal(b.id('login:confirm').props.type, 'text');
    await b.dispatch(b.byClass('seg-item')[0]); await b.dispatch(b.byClass('seg-item')[1]);
    assert.equal(b.id('login:password').props.type, 'password'); assert.equal(b.id('login:confirm').props.type, 'password');
    await b.dispatch(b.id('login:username'), 'input', { value:'用户 abc+12' }); assert.equal(b.id('login:username').props.value, 'abc12');
    await b.dispatch(b.id('login:account'), 'input', { value:'tv@example.com' });
    await b.dispatch(b.id('login:confirm'), 'input', { value:'pass123' });
    await b.dispatch(b.button('注册并登录'));
    assert.equal(b.network.filter(n => n.url.endsWith('/app/user/register')).length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(b.network.at(-1).data)), { username:'abc12', password:'pass123', passwordConfirm:'pass123', email:'tv@example.com' });
  } finally { await b.close(); }
};

cases['login-remote-budget'] = async () => {
  const b = await formFixture({ width:480, height:360 });
  try {
    await b.mount('pages/login/index.uvue');
    const card = b.byClass('card')[0], page = b.byClass('page')[0];
    assert.equal(px(b, card, 'width'), b.load('uni_modules/qt-ui/composables/use-qt-widths.ts').qtContentWidth('form'), 'TV card uses real form content width, including narrow rail/gutter');
    assert.equal(px(b, page, 'padding-left'), 0); assert.equal(px(b, page, 'padding-right'), 0);
    const forget = b.id('login:forget'); assert.ok(forget && px(b, forget, 'min-height') >= 56, 'forgot-password remains a reachable original 56px action');
    b.byClass('logo-sub').forEach(node => textLine(b, node, 'music tagline'));
    b.byClass('forget-text').forEach(node => textLine(b, node, 'forgot label'));
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('login:account'), true);
    await remote(b, 'down'); assert.ok(b.inputs().every(node => node.props.focus !== true), 'spatial navigation leaves native fields in navigation mode');
    assert.equal(b.activations.length, 0, 'directional key never activates IME');
    b.tv.qtTvFocus('login:password-eye'); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(b.id('login:password').props.type, 'text', 'repeat OK does not toggle a password eye twice');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); b.inputs().forEach(node => fieldGeometry(b, node, 'huge TV input'));
    assert.ok(px(b, b.id('login:password-eye'), 'height') >= px(b, b.id('login:password'), 'height'));
    b.tv.qtTvFocus('login:forget'); await remote(b, 'ok'); assert.ok(b.routeEvents().some(e => e.url === '/pages/forget-password/index'));
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(b.css(b.id('login:password'))['height'], undefined, 'same mount returns desktop input geometry to original CSS');
    assert.equal(b.css(b.id('login:password-eye')).width, undefined); assert.equal(b.css(card).width, undefined, 'original card CSS is retained outside TV');
  } finally { await b.close(); }
};

cases['forget-fields'] = async () => {
  const b = await formFixture({ width:480, height:360 });
  try {
    await b.mount('pages/forget-password/index.uvue');
    assert.equal(b.byClass('field-input').length, 4, 'existing email/code/new-password/confirm fields mount before assertions');
    b.inputs().forEach((node, index) => fieldGeometry(b, node, 'reset field ' + index));
    assert.deepEqual(b.inputs().map(node => node.props.maxlength), [50, 6, 18, 18]);
    assert.equal(b.byClass('form-scroll').length, 1); assert.ok(classes(b.byClass('form-scroll')[0]).includes('qt-tv-scroll'), 'short reset form has a reachable scrolling surface');
    const card = b.byClass('card')[0]; assert.equal(px(b, card, 'width'), 288, '480px TV reset card stays within actual frame content');
    for (const eye of b.byClass('eye')) { assert.ok(px(b, eye, 'width') >= 56 && px(b, eye, 'height') >= 56); await b.dispatch(eye); }
    assert.equal(b.id('forget:password').props.type, 'text'); assert.equal(b.id('forget:confirm').props.type, 'text');
    const send = b.id('forget:send-code'); assert.ok(send && px(b, send, 'height') >= 56 && px(b, send, 'min-width') >= 56);
    const sendText = b.byClass('code-btn-text')[0]; textLine(b, sendText, 'send code label');
    assert.ok(px(b, send, 'width') >= Math.ceil(5 * px(b, sendText, 'font-size')) + 32, 'whole five-character code label and original padding are budgeted');
    assert.equal(b.css(send)['flex-shrink'], '0', 'send code control stays visible next to native code field');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); b.inputs().forEach(node => fieldGeometry(b, node, 'huge reset field'));
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('forget:email'), true); await remote(b, 'down'); assert.equal(b.activations.length, 0);
    assert.ok(b.inputs().every(node => node.props.focus !== true));
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(b.inputs()[0]).height, undefined); assert.equal(b.css(card).width, undefined);
  } finally { await b.close(); }
};

cases['account-busy-lifecycle'] = async () => {
  const pending = [];
  const requestHandler = options => {
    if (options.url.endsWith('/app/user/login') || options.url.endsWith('/app/user/email') || options.url.endsWith('/app/user/changePass')) pending.push(options);
    else options.fail?.({ errMsg:'fixture background network' });
  };
  const login = await formFixture({ requestHandler });
  try {
    await login.mount('pages/login/index.uvue');
    await login.dispatch(login.id('login:account'), 'input', { value:'tvuser' }); await login.dispatch(login.id('login:password'), 'input', { value:'pass123' });
    login.tv.qtTvRefreshFocus(); assert.equal(login.tv.qtTvFocus('login:submit'), true);
    await remote(login, 'ok'); await remote(login, 'ok', 1);
    await login.dispatch(login.button('登 录')); assert.equal(pending.length, 1, 'original disabled QtButton preserves busy request single-flight');
    pending[0].fail({ errMsg:'owned failed login' }); await login.flush(); assert.ok(login.toastCalls.some(t => t.title === '网络请求失败'));
  } finally { await login.close(); }
  const b = await formFixture({ requestHandler });
  try {
    await b.mount('pages/forget-password/index.uvue');
    b.load('uni_modules/qt-ui/composables/use-qt-layout.ts').resumeQtLayoutWatcher();
    const clockBaseline = b.clock.intervalCount(1000);
    await b.dispatch(b.id('forget:email'), 'input', { value:'中文 tv+test@example.com' }); assert.equal(b.id('forget:email').props.value, 'tvtest@example.com');
    await b.dispatch(b.id('forget:send-code')); await b.dispatch(b.id('forget:send-code'));
    assert.equal(pending.filter(p => p.url.endsWith('/app/user/email')).length, 1, 'original sending guard works through native clicks');
    assert.ok(classes(b.id('forget:send-code')).includes('qt-tv-skip'), 'busy code action is excluded from remote focus');
    const codeRequest = pending.find(p => p.url.endsWith('/app/user/email'));
    assert.deepEqual(JSON.parse(JSON.stringify(codeRequest.data)), { email:'tvtest@example.com', body:'changePasswordByEmail' });
    codeRequest.success({ statusCode:200, data:JSON.stringify({ code:200, data:{} }) }); await b.flush();
    assert.equal(b.byClass('code-btn-text')[0].text, '60s'); assert.equal(b.clock.intervalCount(1000), clockBaseline + 1);
    await b.dispatch(b.id('forget:send-code')); assert.equal(pending.filter(p => p.url.endsWith('/app/user/email')).length, 1);
    await b.clock.runTimers(1000); assert.equal(b.byClass('code-btn-text')[0].text, '59s');
    await b.dispatch(b.id('forget:code'), 'input', { value:'a12b3456' }); assert.equal(b.id('forget:code').props.value, '123456');
    await b.dispatch(b.id('forget:password'), 'input', { value:'pass123' }); await b.dispatch(b.id('forget:confirm'), 'input', { value:'different' });
    await b.dispatch(b.button('确认重置')); assert.ok(b.toastCalls.some(t => t.title === '两次输入的密码不一致'));
    assert.equal(pending.filter(p => p.url.endsWith('/app/user/changePass')).length, 0);
    await b.dispatch(b.id('forget:confirm'), 'input', { value:'pass123' }); await b.dispatch(b.button('确认重置')); await b.dispatch(b.button('确认重置'));
    const reset = pending.filter(p => p.url.endsWith('/app/user/changePass')); assert.equal(reset.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(reset[0].data)), { email:'tvtest@example.com', password:'pass123', code:'123456' });
    reset[0].success({ statusCode:200, data:JSON.stringify({ code:200, data:{} }) }); await b.flush(); assert.equal(b.clock.timeoutCount(600), 1);
    for (const unload of b.lifecycle.unload) unload(); await b.flush(); assert.equal(b.clock.intervalCount(1000), clockBaseline); assert.equal(b.clock.timeoutCount(600), 0);
    await b.clock.runTimers(600); assert.equal(b.routeEvents().length, 0, 'unloaded original reset form never schedules stale navigation');
  } finally { await b.close(); }
};

cases['profile-fields'] = async () => {
  const b = await formFixture({ width:480, height:360 });
  try {
    await b.mount('pages/profile/edit/index.uvue');
    assert.equal(b.inputs().length, 3, 'original nickname/email/optional password fields render');
    b.inputs().forEach((node, index) => fieldGeometry(b, node, 'profile field ' + index));
    assert.deepEqual(b.inputs().map(node => node.props.maxlength), [30, 50, 18]);
    const card = b.byClass('card')[0]; assert.equal(px(b, card, 'width'), 288);
    assert.ok(classes(b.byClass('form-scroll')[0]).includes('qt-tv-scroll'));
    const eye = b.id('profile:password-eye'); assert.ok(px(b, eye, 'width') >= 56 && px(b, eye, 'height') >= 56);
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('profile:password-eye'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(b.id('profile:password').props.type, 'text');
    await b.dispatch(b.id('profile:nickname'), 'input', { value:'电视用户' }); await b.dispatch(b.id('profile:email'), 'input', { value:'测试 tv+user@example.com' });
    assert.equal(b.id('profile:email').props.value, 'tvuser@example.com');
    await b.dispatch(b.id('profile:password'), 'input', { value:'123' }); await b.dispatch(b.button('保存修改'));
    assert.ok(b.toastCalls.some(t => t.title === '密码长度为 6-18 位')); assert.equal(b.network.filter(n => n.url.endsWith('/app/user/update')).length, 0);
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); b.inputs().forEach(node => fieldGeometry(b, node, 'huge profile field'));
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(card).width, undefined); assert.equal(b.css(b.id('profile:password')).height, undefined);
  } finally { await b.close(); }
};

cases['profile-preview'] = async () => {
  const b = await formFixture({ width:480, height:360 });
  try {
    await b.mount('pages/profile/edit/index.uvue');
    assert.equal(b.byClass('avatar').length, 1, 'existing avatar entry mounts');
    await b.dispatch(b.byClass('avatar')[0]); b.tv.qtTvRefreshFocus();
    assert.equal(b.byClass('avatar-preview-body').length, 1, 'original preview is open');
    assert.equal(b.tv.qtTvHasModal(), true, 'existing avatar preview owns a real modal panel');
    assert.equal(b.tv.qtTvFocus('profile:nickname'), false, 'preview suppresses background fields');
    const close = b.id('profile:preview-close'); assert.ok(close && px(b, close, 'width') >= 56 && px(b, close, 'height') >= 56);
    for (const action of b.byClass('avatar-preview-btn')) {
      assert.ok(px(b, action, 'height') >= 56); assert.equal(b.css(action)['flex-shrink'], '0');
      textLine(b, walk(action).find(node => classes(node).includes('avatar-preview-btn-text')), 'preview full-label action');
    }
    assert.equal(b.css(b.byClass('avatar-preview-actions')[0]).position, 'relative', 'short TV preview actions participate in normal flow, not overlay on image');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    assert.ok(px(b, b.byClass('avatar-preview-img')[0], 'height') + px(b, b.byClass('avatar-preview-actions')[0], 'height') + 88 <= 360, 'huge preview image and action rows reserve close and gap budget');
    await remote(b, 'back'); await remote(b, 'back', 1);
    assert.equal(b.byClass('avatar-preview-body').length, 0); assert.equal(b.routeEvents().length, 0, 'Back closes only the preview');
    assert.equal(b.tv.qtTvFocus('profile:password'), true, 'background input returns to navigation without editing');
  } finally { await b.close(); }
};

cases['profile-business'] = async () => {
  const chosen = '/owned-fixture/avatar.png', bytes = new Uint8Array([137,80,78,71]).buffer, nativeSaved = [], picked = [];
  let holdUpdate = null, remoteAvatar = '';
  const b = await formFixture({ width:800, height:360, files:{ [chosen]:bytes }, requestHandler:options => {
    if (options.url.endsWith('/app/user/me')) return options.success({ statusCode:200, data:JSON.stringify({ code:200, data:{ user:{ id:28, nickname:'原昵称', email:'original@example.com', avatar:remoteAvatar }, roles:[] } }) });
    if (options.url.endsWith('/app/user/avatar/upload-plan')) return options.success({ statusCode:200, data:JSON.stringify({ code:200, data:{ mode:'DIRECT', ticket:{ uploadId:'owned-upload', uploadUrl:'https://owned.invalid/storage/put', method:'PUT' } } }) });
    if (options.url === 'https://owned.invalid/storage/put') return options.success({ statusCode:204, data:'' });
    if (options.url.endsWith('/app/user/avatar/complete')) { remoteAvatar = 'https://owned.invalid/avatar/new.png'; return options.success({ statusCode:200, data:JSON.stringify({ code:200, data:{ url:remoteAvatar } }) }); }
    if (options.url.endsWith('/app/user/update')) { holdUpdate = options; return; }
    options.fail?.({ errMsg:'owned route absent' });
  }, sdkOverrides:{ chooseImage:options => { picked.push(options); options.success({ tempFilePaths:[chosen,'/ignored.png'] }); } },
    nativeOverrides:{ saveImageToGallery:async (...args) => { nativeSaved.push(args); return 'owned-gallery-image'; } } });
  try {
    const auth = b.load('services/auth.ts'); auth.saveUserId('28'); auth.saveTokens({ accessToken:'owned-access', refreshToken:'owned-refresh', expiresAt:b.clock.now()+3600000 });
    const fs = b.uni.getFileSystemManager(); b.setSdk({ getFileSystemManager:() => ({ ...fs, getFileInfo:options => options.success({ size:4 }) }) });
    await b.mount('pages/profile/edit/index.uvue');
    assert.equal(b.id('profile:nickname').props.value, '原昵称'); assert.equal(b.id('profile:email').props.value, 'original@example.com');
    assert.equal(b.network.filter(n => n.url.endsWith('/app/user/me')).length, 1, 'real meCached/HTTP loads actual response');
    await b.dispatch(b.id('profile:avatar')); b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('profile:preview-change'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(picked.length, 1); assert.equal(picked[0].count, 1); assert.deepEqual(Array.from(picked[0].sizeType), ['compressed']);
    const plan = b.network.find(n => n.url.endsWith('/app/user/avatar/upload-plan'));
    assert.ok(plan, 'real media uploadFlow reaches plan: ' + JSON.stringify({ network:b.network.map(n => n.url), toast:b.toastCalls, runtime:b.runtimeErrors.map(e => e.message) })); assert.equal(plan.data.fileName, 'avatar.png'); assert.equal(plan.data.sizeBytes, 4); assert.equal(plan.data.contentType, 'image/png');
    const put = b.network.find(n => n.url === 'https://owned.invalid/storage/put'); assert.equal(put.method, 'PUT'); assert.equal(put.data.byteLength, 4);
    assert.equal(b.network.find(n => n.url.endsWith('/app/user/avatar/complete')).data.uploadId, 'owned-upload');
    assert.ok(b.toastCalls.some(t => t.title === '头像已更新')); assert.equal(auth.getAccessToken(), 'owned-access', 'avatar upload does not force account logout');
    assert.equal(b.load('services/avatar-cache.ts').getCachedAvatarUrl(), 'https://owned.invalid/avatar/new.png');
    await b.dispatch(b.id('profile:avatar')); b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('profile:preview-save'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(nativeSaved.length, 1); assert.ok(nativeSaved[0][0].startsWith('unifile://usr/qt-user-avatar-')); assert.ok(b.toastCalls.some(t => t.title === '已保存到相册'));
    await remote(b, 'back'); await b.dispatch(b.id('profile:nickname'), 'input', { value:' 新昵称 ' }); await b.dispatch(b.id('profile:email'), 'input', { value:'new@example.com' });
    await b.dispatch(b.id('profile:submit')); await b.dispatch(b.id('profile:submit')); assert.equal(b.network.filter(n => n.url.endsWith('/app/user/update')).length, 1);
    assert.equal(holdUpdate.data.nickname, '新昵称'); assert.equal(holdUpdate.data.email, 'new@example.com'); assert.equal(holdUpdate.data.avatar, 'https://owned.invalid/avatar/new.png'); assert.equal(holdUpdate.data.password, undefined, 'optional blank password is omitted');
    holdUpdate.success({ statusCode:200, data:JSON.stringify({ code:200, data:{} }) }); await b.flush();
    assert.equal(auth.getAccessToken(), ''); assert.equal(auth.getRefreshToken(), ''); assert.equal(b.storage.has('qt-email'), false); assert.ok(b.toastCalls.some(t => t.title === '资料已更新，请重新登录'));
    assert.equal(b.clock.timeoutCount(800), 1); for (const unload of b.lifecycle.unload) unload(); await b.flush(); assert.equal(b.clock.timeoutCount(800), 0);
    await b.clock.runTimers(1000); assert.equal(b.routeEvents().length, 0, 'original 800ms relaunch is removed when page unloads');
  } finally { await b.close(); }
};

cases['login-success'] = async () => {
  for (const leaveBeforeTimer of [false, true]) {
    let loginResponse = null;
    const b = await formFixture({ width:800, height:360, requestHandler:options => {
      if (options.url.endsWith('/app/user/login')) { loginResponse = options; return; }
      if (options.url.endsWith('/app/user/me')) return options.success({ statusCode:200, data:JSON.stringify({ code:200, data:{ user:{ id:28, nickname:'电视账号', email:'tv@example.com', avatar:'' }, roles:['TESTER'] } }) });
      options.fail?.({ errMsg:'owned background collection response unavailable' });
    } });
    try {
      const player = b.load('stores/player.ts').usePlayerStore(); player.restore();
      const guest = player.createLocalPlaylist('访客电视歌单'); assert.ok(guest);
      await b.mount('pages/login/index.uvue');
      await b.dispatch(b.id('login:account'), 'input', { value:'tvuser' }); await b.dispatch(b.id('login:password'), 'input', { value:'validpass' });
      b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('login:submit'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
      assert.equal(b.network.filter(n => n.url.endsWith('/app/user/login')).length, 1);
      loginResponse.success({ statusCode:200, data:JSON.stringify({ code:200, data:{ token:'owned-login-access', refreshToken:'owned-login-refresh', expiresIn:3600,
        user:{ id:28, nickname:'电视账号', email:'tv@example.com', avatar:'' }, roles:['TESTER'], permissions:['user:ai:music:use'] } }) }); await b.flush();
      const auth = b.load('services/auth.ts'); assert.equal(auth.getUserId(), '28'); assert.equal(auth.getAccessToken(), 'owned-login-access'); assert.equal(auth.getRefreshToken(), 'owned-login-refresh');
      assert.equal(auth.getTokenExpiry(), b.clock.now()+3600000); assert.equal(b.storage.get('qt-token'), 'owned-login-access'); assert.equal(b.storage.get('qt-nickname'), '电视账号'); assert.equal(b.storage.get('qt-email'), 'tv@example.com');
      assert.deepEqual(JSON.parse(b.storage.get('qt-roles')), ['TESTER']); assert.deepEqual(JSON.parse(b.storage.get('qt-permissions')), ['user:ai:music:use']);
      assert.ok(player.pickerPlaylists().some(p => p.id === guest.id && p.name === '访客电视歌单'), 'actual guest collection is adopted before account identity commits');
      assert.ok(b.network.some(n => n.url.endsWith('/app/user/me'))); assert.ok(b.toastCalls.some(t => t.title === '登录成功')); assert.equal(b.clock.timeoutCount(500), 1);
      if (leaveBeforeTimer) { for (const unload of b.lifecycle.unload) unload(); await b.flush(); assert.equal(b.clock.timeoutCount(500), 0); }
      await b.clock.runTimers(500);
      assert.deepEqual(b.routeEvents().map(r => r.action + ':' + (r.url ?? '')), leaveBeforeTimer ? [] : ['relaunch:/pages/home/index'], 'single-page login returns home, unloaded login does not navigate');
    } finally { await b.close(); }
  }
};

cases['feedback-submit-fields'] = async () => {
  const b = await formFixture({ width:480, height:360 });
  try {
    await b.mount('pages/feedback/submit.uvue');
    assert.equal(b.inputs().length, 3, 'original title/content/contact fields');
    b.inputs().forEach((node, index) => fieldGeometry(b, node, 'feedback submit field ' + index));
    assert.deepEqual(b.inputs().map(node => node.props.maxlength), [128,5000,64]);
    assert.ok(px(b, b.id('feedback:content'), 'height') >= 140, 'existing multi-line body stays an editing area, not one row');
    assert.ok(classes(b.byClass('scroll')[0]).includes('qt-tv-scroll')); assert.equal(px(b, b.byClass('scroll')[0], 'width'), 288);
    b.byClass('card').forEach(node => assert.equal(px(b, node, 'width'), 288, 'each original card uses the same actual form content width'));
    for (const name of ['label','hint','privacy']) b.byClass(name).forEach(node => textLine(b, node, 'feedback ' + name));
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); b.inputs().forEach(node => fieldGeometry(b, node, 'huge feedback field'));
    assert.ok(px(b, b.id('feedback:content'), 'height') >= 4 * px(b, b.id('feedback:content'), 'line-height'));
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('feedback:title'), true); await remote(b, 'down'); await remote(b, 'right'); assert.equal(b.activations.length, 0, 'directional field navigation never enters editing');
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(b.byClass('card')[0]).width, undefined); assert.equal(b.css(b.inputs()[0]).height, undefined);
  } finally { await b.close(); }
};

cases['feedback-submit-business'] = async () => {
  for (const lifecyclePoint of ['normal','before-response','before-navigation']) {
    let held = null;
    const b = await formFixture({ width:800, height:360, requestHandler:options => { if (options.url.endsWith('/app/feedback/submit')) held = options; else options.fail?.({ errMsg:'owned route absent' }); } });
    try {
      const auth = b.load('services/auth.ts'); auth.saveUserId('28'); auth.saveTokens({ accessToken:'owned-access', refreshToken:'owned-refresh', expiresAt:b.clock.now()+3600000 });
      await b.mount('pages/feedback/submit.uvue');
      await b.dispatch(b.id('feedback:submit')); assert.equal(b.network.length, 0); assert.ok(b.toastCalls.some(t => t.title === '请填写标题'));
      await b.dispatch(b.id('feedback:title'), 'input', { value:' 电视输入反馈 ' }); await b.dispatch(b.id('feedback:submit')); assert.equal(b.network.length, 0); assert.ok(b.toastCalls.some(t => t.title === '请填写内容'));
      await b.dispatch(b.byClass('seg-item')[1]); await b.dispatch(b.id('feedback:content'), 'input', { value:' 保留原始反馈正文 ' }); await b.dispatch(b.id('feedback:contact'), 'input', { value:'   ' });
      b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('feedback:submit'), true); await remote(b, 'ok'); await remote(b, 'ok', 1); await b.dispatch(b.id('feedback:submit'));
      assert.equal(b.network.length, 1); assert.equal(held.method, 'POST'); assert.deepEqual(JSON.parse(JSON.stringify(held.data)), { type:'request', title:'电视输入反馈', content:'保留原始反馈正文' });
      for (const header of ['X-App-Ut','X-App-Version','X-Device','X-OS']) assert.ok(held.header[header] != null, 'real feedback HTTP retains unified ' + header);
      if (lifecyclePoint === 'before-response') { for (const unload of b.lifecycle.unload) unload(); await b.flush(); }
      held.success({ statusCode:200, data:JSON.stringify({ code:200, data:{ id:28, title:'电视输入反馈' } }) }); await b.flush();
      assert.equal(b.toastCalls.some(t => t.title === '提交成功'), lifecyclePoint !== 'before-response'); assert.equal(b.clock.timeoutCount(600), lifecyclePoint === 'before-response' ? 0 : 1);
      if (lifecyclePoint === 'before-navigation') { for (const unload of b.lifecycle.unload) unload(); await b.flush(); assert.equal(b.clock.timeoutCount(600), 0); }
      await b.clock.runTimers(600); assert.deepEqual(b.routeEvents().map(r => r.action), lifecyclePoint === 'normal' ? ['back'] : [], 'original 600ms navigation respects alive cleanup');
    } finally { await b.close(); }
  }
};

cases['feedback-detail-fields'] = async () => {
  const b = await formFixture({ width:480, height:360, routeOptions:{ id:'28' }, requestHandler:options => {
    const data = options.url.endsWith('/replies') ? [{ id:9, feedbackId:28, nickname:'官方', userType:'ADMIN', content:'回复正文', replyTime:'2026-11-15 08:00:00' }] : { id:28, title:'反馈详情标题', content:'既有正文', type:'issue', status:'received', isPublic:false, device:'TV fixture', os:'Android', appVersion:'1', createTime:'2026-11-15 08:00:00' };
    options.success({ statusCode:200, data:JSON.stringify({ code:200, data }) });
  } });
  try {
    const auth = b.load('services/auth.ts'); auth.saveUserId('28'); auth.saveTokens({ accessToken:'owned-access', refreshToken:'owned-refresh', expiresAt:b.clock.now()+3600000 });
    await b.mount('pages/feedback/detail.uvue'); assert.equal(b.byClass('fb-title').length, 1, 'real detail HTTP is rendered');
    assert.equal(b.inputs().length, 1); fieldGeometry(b, b.inputs()[0], 'feedback detail reply'); assert.equal(b.inputs()[0].props.maxlength, 2000); assert.equal(b.inputs()[0].props['confirm-type'], 'send');
    assert.ok(classes(b.byClass('scroll')[0]).includes('qt-tv-scroll'));
    const send = b.id('feedback:send'); assert.ok(send && px(b, send, 'height') >= 56 && px(b, send, 'min-width') >= 56, 'original send action has full-label TV target');
    assert.ok(classes(send).includes('qt-tv-skip'), 'blank reply action is excluded from TV navigation');
    for (const name of ['fb-title','fb-content','meta-text','label','reply-nickname','reply-time','reply-content','send-btn-text','type-badge-text','status-badge-text','official-badge-text']) b.byClass(name).forEach(node => textLine(b, node, 'detail ' + name));
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); fieldGeometry(b, b.inputs()[0], 'huge reply'); assert.ok(px(b, b.id('feedback:send'), 'height') >= px(b, b.inputs()[0], 'height'));
    assert.equal(b.css(b.byClass('reply-head')[0])['flex-wrap'], 'wrap', 'reply metadata can wrap under huge TV font');
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(b.inputs()[0]).height, undefined); assert.equal(b.css(b.id('feedback:send'))['height'], undefined);
  } finally { await b.close(); }
};

cases['feedback-detail-business'] = async () => {
  for (const scenario of ['private','public','replies-failed','missing']) {
    let held = null;
    const b = await formFixture({ width:800, height:360, routeOptions:{ id:'28' }, requestHandler:options => {
      if (options.url.endsWith('/app/feedback/28')) {
        if (scenario === 'missing') return options.fail({ errMsg:'owned detail missing' });
        return options.success({ statusCode:200, data:JSON.stringify({ code:200, data:{ id:28, title:'电视反馈', content:'原正文', isPublic:scenario === 'public' } }) });
      }
      if (options.url.endsWith('/app/feedback/28/replies')) {
        if (scenario === 'replies-failed') return options.fail({ errMsg:'owned reply-list failure' });
        return options.success({ statusCode:200, data:JSON.stringify({ code:200, data:[] }) });
      }
      if (options.url.endsWith('/app/feedback/reply')) { held = options; return; }
      options.fail?.({ errMsg:'owned route absent' });
    } });
    try {
      const auth = b.load('services/auth.ts'); auth.saveUserId('28'); auth.saveTokens({ accessToken:'owned-access', refreshToken:'owned-refresh', expiresAt:b.clock.now()+3600000 });
      await b.mount('pages/feedback/detail.uvue');
      if (scenario === 'missing') { assert.equal(b.inputs().length, 0); assert.equal(b.byClass('empty').length, 1); assert.equal(b.network.filter(n => n.url.endsWith('/replies')).length, 0); continue; }
      assert.equal(b.byClass('fb-title').length, 1, 'reply-list failure does not discard existing detail');
      if (scenario === 'public') {
        assert.equal(b.inputs().length, 0); assert.equal(b.id('feedback:send'), undefined); assert.ok(b.byClass('input-locked-text').some(n => textOf(n) === '公开反馈不支持回复')); assert.equal(b.tv.qtTvFocus('feedback:reply'), false); assert.equal(b.tv.qtTvFocus('feedback:send'), false); assert.equal(held, null); continue;
      }
      await b.dispatch(b.id('feedback:reply'), 'confirm'); assert.equal(held, null, 'empty confirm submits nothing');
      await b.dispatch(b.id('feedback:reply'), 'input', { value:' 补充原反馈 ' }); b.tv.qtTvRefreshFocus(); assert.equal(classes(b.id('feedback:send')).includes('qt-tv-skip'), false);
      assert.equal(b.tv.qtTvFocus('feedback:send'), true); await remote(b, 'ok'); await remote(b, 'ok', 1); await b.dispatch(b.id('feedback:reply'), 'confirm');
      assert.equal(b.network.filter(n => n.url.endsWith('/app/feedback/reply')).length, 1); assert.deepEqual(JSON.parse(JSON.stringify(held.data)), { feedbackId:28, content:'补充原反馈' }); assert.ok(classes(b.id('feedback:send')).includes('qt-tv-skip'));
      held.success({ statusCode:200, data:JSON.stringify({ code:200, data:{ id:9, feedbackId:28, content:'补充原反馈', nickname:'用户', userType:'USER', replyTime:'2026-11-15 08:00:00' } }) }); await b.flush();
      assert.equal(b.id('feedback:reply').props.value, ''); assert.ok(b.byClass('reply-content').some(n => textOf(n) === '补充原反馈')); assert.ok(b.toastCalls.some(t => t.title === '已回复')); assert.equal(b.routeEvents().length, 0);
    } finally { await b.close(); }
  }
};

cases['ai-provider-fields'] = async () => {
  const b = await formFixture({ width:480, height:360 });
  try {
    b.load('services/ai-mode.ts').saveAiMode('local'); await b.mount('pages/ai-providers/index.uvue');
    assert.equal(b.byClass('empty-title').length, 1); await b.dispatch(b.button('新增供应商')); b.tv.qtTvRefreshFocus();
    assert.equal(b.tv.qtTvHasModal(), true, 'existing QtSheet owns edit scope'); assert.equal(b.inputs().length, 4);
    b.inputs().forEach((node, index) => fieldGeometry(b, node, 'AI draft field ' + index)); assert.deepEqual(b.inputs().map(node => node.props.maxlength), [24,256,64,256]);
    assert.ok(classes(b.byClass('page')[0]).includes('qt-tv-scroll')); assert.ok(classes(b.byClass('edit-scroll')[0]).includes('qt-tv-scroll'));
    b.byClass('field-row').forEach(node => assert.equal(b.css(node)['flex-direction'], 'column', 'short TV draft labels, values and actions stack rather than consume one narrow row'));
    b.byClass('field-label').forEach(node => textLine(b, node, 'AI field label'));
    const scroll = b.byClass('edit-scroll')[0]; assert.ok(px(b, scroll, 'height') + 97 <= 360 * 0.86, 'edit body reserves real QtSheet title/close and bottom budget');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); b.inputs().forEach(node => fieldGeometry(b, node, 'huge AI draft field'));
    assert.equal(b.tv.qtTvFocus('ai:name'), true); await remote(b, 'down'); assert.equal(b.activations.length, 0); assert.equal(b.tv.qtTvFocus('ai:add'), false, 'open edit suppresses background add action');
    await remote(b, 'back'); assert.equal(b.byClass('edit-scroll').length, 0); assert.equal(b.routeEvents().length, 0);
    b.tv.qtSetTvMode('touch'); await b.flush(); await b.dispatch(b.button('新增供应商')); assert.equal(b.css(b.inputs()[0]).height, undefined); assert.equal(b.css(b.byClass('field-row')[0])['flex-direction'], undefined, 'desktop draft keeps original horizontal rows');
  } finally { await b.close(); }
};

cases['ai-provider-actions'] = async () => {
  const b = await formFixture({ width:480, height:360 });
  try {
    await b.mount('pages/ai-providers/index.uvue');
    assert.equal(b.button('改用本地模型精选')?.props['data-qt-tv-id'], 'ai:local', 'real fallback action has stable remote identity');
    assert.equal(b.css(b.byClass('page')[0])['padding-left'], '0px'); assert.equal(px(b, b.button('改用本地模型精选'), 'width'), 258, 'fallback action fits actual 288px Frame column minus shared QtCard border/padding');
    await b.dispatch(b.button('改用本地模型精选')); assert.equal(b.load('services/ai-mode.ts').readAiMode(), 'local');
    assert.equal(b.button('新增供应商').props['data-qt-tv-id'], 'ai:add'); assert.equal(px(b, b.button('新增供应商'), 'width'), 288);
    const providers = b.load('services/ai-providers.ts'); providers.saveProviders({ activeId:'p1', profiles:[{ id:'p1', name:'现有供应商完整名称', baseUrl:'https://owned-model.invalid/v1', protocol:'openai', model:'owned-model', models:['owned-model'], keys:['owned-key-value'], icon:'', skipCertVerify:false }] });
    await b.dispatch(b.button('新增供应商')); assert.equal(b.tv.qtTvFocus('ai:add'), false); await b.dispatch(b.id('ai:name'), 'input', { value:'原配置' }); await b.dispatch(b.id('ai:base'), 'input', { value:'https://owned-model.invalid' }); await b.dispatch(b.id('ai:model'), 'input', { value:'owned-model' }); await b.dispatch(b.id('ai:key'), 'input', { value:'owned-key-value' }); await b.dispatch(b.button('保存'));
    b.byClass('profile-head').forEach(node => assert.ok(px(b, node, 'min-height') >= 56 && String(node.props['data-qt-tv-id']).includes(':head')));
    b.byClass('profile-btn-row').forEach(node => assert.equal(b.css(node)['flex-direction'], 'column', 'three full-label actions stay inside one narrow TV profile card'));
    b.byClass('profile-btn').forEach(node => { assert.equal(px(b, node, 'width'), 258); assert.equal(b.css(node)['margin-left'], '0px'); });
    for (const name of ['step-title','step-sub','profile-name','profile-url','profile-meta']) b.byClass(name).forEach(node => textLine(b, node, name));
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); b.byClass('profile-btn').forEach(node => assert.equal(px(b, node, 'width'), 258));
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(b.byClass('page')[0])['padding-left'], undefined); assert.equal(b.css(b.byClass('profile-btn-row')[0])['flex-direction'], undefined); assert.equal(b.css(b.byClass('profile-btn')[0]).width, undefined);
  } finally { await b.close(); }
};

cases['ai-provider-long-label'] = async () => {
  const b = await formFixture({ width:480, height:360 });
  try {
    await b.mount('pages/ai-providers/index.uvue'); b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    const action = b.button('改用本地模型精选'), label = walk(action).find(node => classes(node).includes('qt-button-label'));
    assert.equal(textOf(label).length, 8); assert.equal(px(b, action, 'width'), 258);
    assert.equal(b.css(action).height, 'auto', 'eight-character real TV action auto-grows beyond one 56px box'); assert.ok(px(b, action, 'min-height') >= 56);
    assert.equal(px(b, label, 'line-height'), 39); assert.equal(b.css(label)['white-space'], 'normal'); assert.equal(b.css(label)['flex-shrink'], '1'); assert.equal(b.css(label)['min-width'], '0px'); assert.equal(label.props['max-lines'], undefined);
    assert.ok(px(b, label, 'font-size') * 8 > 212, 'worked example: eight huge glyphs require two lines in the actual 258px action after shared 44px pad and 2px border');
    assert.ok(2 * px(b, label, 'line-height') + 16 + 2 <= 96, 'authored two-line minimum is a 96px logical box, not synthetic Yoga acceptance');
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(action).height, undefined); assert.equal(b.css(label)['white-space'], undefined); assert.equal(b.css(action)['min-height'], undefined);
  } finally { await b.close(); }
};

cases['ai-provider-business'] = async () => {
  const shapes = {
    openai:{ models:'/v1/models', chat:'/v1/chat/completions', response:{ model:'owned-second', choices:[{ message:{ content:'真实试连回复' } }] } },
    'openai-responses':{ models:'/v1/models', chat:'/v1/responses', response:{ model:'owned-second', output:[{ type:'message', content:[{ type:'output_text', text:'真实试连回复' }] }] } },
    anthropic:{ models:'/v1/models', chat:'/v1/messages', response:{ model:'owned-second', content:[{ type:'text', text:'真实试连回复' }] } },
    gemini:{ models:'/v1beta/models', chat:'/v1beta/models/owned-second:generateContent', response:{ modelVersion:'owned-second', candidates:[{ content:{ parts:[{ text:'真实试连回复' }] } }] } },
  };
  for (const [protocol, shape] of Object.entries(shapes)) {
    let heldModels, heldTest;
    const b = await formFixture({ width:480, height:360, requestHandler:options => {
      if (options.url === 'https://owned-model.invalid' + shape.models) { heldModels = options; return; }
      if (options.url === 'https://owned-model.invalid' + shape.chat) { heldTest = options; return; }
      options.fail?.({ errMsg:'owned route absent' });
    } });
    try {
      const providers = b.load('services/ai-providers.ts'); const original = { id:'p1', name:'原供应商', baseUrl:'https://owned-model.invalid/v1', protocol, model:'owned-first', models:['owned-first'], keys:['owned-key-value'], icon:'retained-icon', skipCertVerify:false };
      providers.saveProviders({ activeId:'p1', profiles:[original, { ...original, id:'p2', name:'备用供应商' }] }); b.load('services/ai-mode.ts').saveAiMode('local');
      await b.mount('pages/ai-providers/index.uvue'); assert.equal(b.option('服务端 AI'), undefined, 'non-admin original engine permissions stay intact');
      await b.dispatch(b.id('ai:p1:edit')); assert.equal(b.id('ai:key').props.value, ''); assert.ok(b.id('ai:key').props.placeholder.includes(providers.maskKey('owned-key-value'))); assert.ok(!b.text().includes('owned-key-value'));
      b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('ai:models'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
      assert.equal(b.network.filter(n => n.url === heldModels.url).length, 1); assert.ok(classes(b.id('ai:models')).includes('qt-tv-skip')); assert.equal(heldModels.sslVerify, true);
      for (const header of ['X-App-Ut','X-App-Version','X-Device','X-OS']) assert.equal(heldModels.header[header], undefined, 'third-party model listing never inherits astral client headers');
      const keyHeader = protocol === 'gemini' ? 'x-goog-api-key' : protocol === 'anthropic' ? 'x-api-key' : 'authorization'; assert.equal(heldModels.header[keyHeader], protocol.startsWith('openai') ? 'Bearer owned-key-value' : 'owned-key-value');
      heldModels.success({ statusCode:200, data:JSON.stringify(protocol === 'gemini' ? { models:[{ name:'models/owned-first' },{ name:'models/owned-second', supportedGenerationMethods:['generateContent'] },{ name:'models/owned-second' },{ name:'models/embedding', supportedGenerationMethods:['embedContent'] }] } : { data:[{ id:'owned-first' },{ id:'owned-second' },{ id:'owned-second' }] }) }); await b.flush();
      assert.equal(walk(b.byClass('as-list')[0]).filter(node => classes(node).includes('qo')).length, 2, 'real model parser filters duplicates and unsupported Gemini entries'); assert.equal(b.tv.qtTvFocus('ai:save'), false, 'actual model ActionSheet outranks editor');
      await b.dispatch(b.option('owned-second')); assert.equal(b.id('ai:model').props.value, 'owned-second'); assert.equal(b.tv.qtTvHasModal(), true, 'model choice returns to original editor');
      await b.dispatch(b.id('ai:certificate')); assert.ok(b.byClass('field-value').some(n => textOf(n) === '已跳过（自签证书网关用）'), 'QtSwitch click toggles original certificate state once');
      b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('ai:test'), true); await remote(b, 'ok'); await remote(b, 'ok', 1); assert.ok(classes(b.id('ai:test')).includes('qt-tv-skip')); assert.equal(b.network.filter(n => n.url === heldTest.url).length, 1); assert.equal(heldTest.sslVerify, false);
      const sent = JSON.parse(heldTest.data); if (protocol === 'gemini') assert.deepEqual(sent.contents, [{ role:'user', parts:[{ text:'你好' }] }]); else { assert.equal(sent.model, 'owned-second'); assert.deepEqual(sent[protocol === 'openai-responses' ? 'input' : 'messages'], [{ role:'user', content:'你好' }]); }
      for (const header of ['X-App-Ut','X-App-Version','X-Device','X-OS']) assert.equal(heldTest.header[header], undefined);
      heldTest.success({ statusCode:200, data:JSON.stringify(shape.response) }); await b.flush(); assert.ok(b.byClass('test-text').some(n => textOf(n).includes('连通（HTTP 200') && textOf(n).includes('真实试连回复')));
      await b.dispatch(b.id('ai:save')); const cfg = providers.readProviders(); const saved = cfg.profiles.find(p => p.id === 'p1'); assert.equal(saved.protocol, protocol); assert.deepEqual(Array.from(saved.keys), ['owned-key-value']); assert.deepEqual(Array.from(saved.models), ['owned-second']); assert.equal(saved.icon, 'retained-icon'); assert.equal(saved.skipCertVerify, true); assert.equal(cfg.activeId, 'p1'); assert.equal(b.byClass('edit-scroll').length, 0);
      await b.dispatch(b.id('ai:p2:active')); const writes = b.storageWrites.filter(([key]) => key === 'qt-ai-providers').length; await b.dispatch(b.id('ai:p2:active')); assert.equal(providers.readProviders().activeId, 'p2'); assert.equal(b.storageWrites.filter(([key]) => key === 'qt-ai-providers').length, writes, 'already active is an original no-op');
      await b.dispatch(b.id('ai:p2:delete')); b.tv.qtTvRefreshFocus(); assert.equal(b.byClass('qc-card').length, 1); assert.equal(b.tv.qtTvFocus('ai:p1:edit'), false); await remote(b, 'back'); assert.equal(providers.readProviders().profiles.length, 2, 'Back cancels deletion');
      await b.dispatch(b.id('ai:p2:delete')); b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('confirm-accept'), true); await remote(b, 'ok'); await remote(b, 'ok', 1); assert.equal(providers.readProviders().profiles.length, 1); assert.equal(providers.readProviders().activeId, 'p1');
      await b.dispatch(b.id('ai:p1:edit')); await b.dispatch(b.id('ai:models')); heldModels.fail({ errMsg:'owned list failure' }); await b.flush(); assert.ok(b.toastCalls.some(t => t.title.includes('请手动填模型 ID'))); assert.equal(b.id('ai:model').props.value, 'owned-second');
      await b.dispatch(b.id('ai:test')); heldTest.success({ statusCode:503, data:'owned gateway unavailable' }); await b.flush(); assert.ok(b.byClass('test-text').some(n => textOf(n) === '失败：接口返回 503')); assert.ok(!classes(b.id('ai:test')).includes('qt-tv-skip')); await remote(b, 'back');
      await b.dispatch(b.id('ai:add')); await b.dispatch(b.id('ai:save')); assert.equal(providers.readProviders().profiles.length, 1); assert.ok(b.toastCalls.some(t => t.title === '给供应商起个名字'));
      for (const [id, value] of [['ai:name','新供应商'],['ai:base','https://owned-model.invalid'],['ai:model','owned-second'],['ai:key','owned-new-key']]) await b.dispatch(b.id(id), 'input', { value }); await b.dispatch(b.id('ai:save')); assert.equal(providers.readProviders().profiles.length, 2); assert.equal(providers.readProviders().activeId, 'p1');
    } finally { await b.close(); }
  }
};

cases['playlist-import-fields'] = async () => {
  const b = await formFixture({ width:480, height:360 });
  try {
    await b.mount('pages/playlist-import/index.uvue'); assert.equal(b.runtimeErrors.length, 0); assert.equal(b.inputs().length, 2, 'deliberate v-show keeps original target input mounted before parse');
    fieldGeometry(b, b.byClass('link-input')[0], 'playlist link'); fieldGeometry(b, b.byClass('name-input')[0], 'playlist name');
    assert.equal(b.inputs()[0].props.maxlength, undefined); assert.equal(b.inputs()[1].props.maxlength, undefined, 'no invented maxlength constrains existing playlist names');
    assert.ok(b.byClass('form-scroll').some(node => classes(node).includes('qt-tv-scroll')), 'short import form is one remotely reachable native scroll'); assert.equal(b.css(b.byClass('page')[0])['padding-left'], '0px');
    assert.equal(b.css(b.byClass('input-row')[0])['flex-direction'], 'column'); assert.equal(px(b, b.id('playlist:parse'), 'height'), 56); assert.equal(px(b, b.id('playlist:parse'), 'width'), 254, '288px Form minus original card 32px padding and 2px border');
    assert.ok(px(b, b.id('playlist:platform'), 'height') >= 56); assert.ok(px(b, b.id('playlist:target'), 'height') >= 56); b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('playlist:name'), false, 'hidden v-show input remains native-mounted but out of TV focus');
    assert.equal(b.tv.qtTvFocus('playlist:link'), true); await remote(b, 'down'); assert.equal(b.activations.length, 0); assert.ok(b.inputs().every(node => node.props.focus !== true));
    await b.dispatch(b.id('playlist:parse')); assert.ok(b.toastCalls.some(t => t.title === '请先粘贴歌单链接')); assert.equal(b.byClass('lock-mask').length, 0); assert.equal(b.tv.qtTvHasModal(), false, 'blank validation releases original busy lock');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); b.inputs().forEach(node => fieldGeometry(b, node, 'huge playlist field')); for (const name of ['hint-text','step-title','plat-label','plat-hint','parse-btn-text']) b.byClass(name).forEach(node => textLine(b, node, name));
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(b.byClass('page')[0])['padding-left'], undefined); assert.equal(b.css(b.byClass('input-row')[0])['flex-direction'], undefined); assert.equal(b.css(b.id('playlist:parse')).height, undefined); assert.equal(b.css(b.id('playlist:link')).height, undefined);
  } finally { await b.close(); }
};

cases['playlist-import-actions'] = async () => {
  const meta = installedMetaBoundary(), b = await formFixture({ width:480, height:360, compilerUts:true, engineOverrides:meta.sdk });
  try {
    await b.mount('pages/playlist-import/index.uvue'); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush();
    assert.equal(b.load('stores/source-registry.ts').useSourceRegistryStore().ready, true, 'real installed state/header/engine response activates registry before UI assertions');
    assert.ok(meta.calls.some(c => c.name === 'readTextFile' && c.path.endsWith('/state.json'))); assert.ok(meta.calls.some(c => c.name === 'loadBundle'));
    const nameInput = b.id('playlist:name'); assert.equal(nameInput.parent.style.display, 'none', 'original v-show confirmation starts native-mounted and hidden');
    await b.dispatch(b.id('playlist:link'), 'input', { value:' https://owned-sheet.invalid/list?id=remote-list-1 ' });
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('playlist:parse'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
    const parses = meta.calls.filter(c => c.name === 'parseSheet'), details = meta.calls.filter(c => c.name === 'playlistDetail');
    assert.equal(parses.length, 1); assert.deepEqual(parses[0].args, { text:'https://owned-sheet.invalid/list?id=remote-list-1', source:'' }); assert.equal(parses[0].timeout, 3000);
    assert.equal(details.length, 1); assert.equal(details[0].args.id, 'remote-list-1'); assert.equal(details[0].args.source, 'wyy'); assert.ok(b.text().includes('原始远程歌单'));
    const collect = b.byClass('main-btn').find(n => textOf(n) === '收藏到收藏夹');
    assert.ok(px(b, collect, 'min-height') >= 56, 'original collect action has native 56px TV minimum');
    assert.equal(collect.props['data-qt-tv-id'], 'playlist:collect'); assert.equal(px(b, collect, 'width'), 254); textLine(b, walk(collect).find(n => n.tag === 'text'), 'playlist collect label');
    assert.equal(b.id('playlist:name'), nameInput, 'collect preview never remounts hidden import input');
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('playlist:collect'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
    const player = b.load('stores/player.ts').usePlayerStore(); assert.equal(player.savedPlaylists.filter(p => p.id === 'remote-list-1' && p.platform === 'wyy').length, 1);
    assert.equal(player.localPlaylists.length, 0, 'reference collection does not import local songs'); assert.equal(b.routeEvents().filter(r => r.url === '/pages/playlist/index?id=remote-list-1&platform=wyy&type=playlist').length, 1);
    assert.ok(classes(b.id('playlist:collect')).includes('qt-tv-skip')); assert.ok(b.toastCalls.some(t => t.title === '已收藏到收藏夹'));
    await b.dispatch(b.byClass('seg-item')[1]); assert.equal(b.id('playlist:name'), nameInput); assert.equal(nameInput.parent.style.display, 'none', 'switching original mode hides without remount');
    await b.dispatch(b.id('playlist:parse')); await b.flush(); assert.equal(nameInput.parent.style.display, ''); assert.equal(b.id('playlist:name'), nameInput); assert.equal(nameInput.value, '', 'name is not programmatically prefilled');
    const importButton = b.byClass('main-btn').find(n => textOf(n) === '导入到我的歌单'); assert.ok(px(b, importButton, 'min-height') >= 56); assert.equal(importButton.props['data-qt-tv-id'], 'playlist:import'); assert.equal(px(b, importButton, 'width'), 254);
    const follow = b.id('playlist:follow'); assert.ok(follow && classes(follow).includes('qsw'), 'follow targets actual shared QtSwitch'); assert.ok(px(b, follow, 'height') >= 56); assert.equal(b.css(follow.parent)['flex-direction'], 'column', 'short TV row reserves full label then actual switch');
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); assert.ok(px(b, importButton, 'min-height') >= Math.ceil(px(b, walk(importButton).find(n => n.tag === 'text'), 'font-size') * 1.35) + 16);
    const beforeImport = player.localPlaylists.length; b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('playlist:import'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(player.localPlaylists.length, beforeImport + 1); assert.equal(b.clock.timeoutCount(50), 1); assert.ok(classes(b.id('playlist:import')).includes('qt-tv-skip'));
    await b.clock.runTimers(50); assert.equal(player.songsOfPlaylist(player.localPlaylists.at(-1).id).length, 2, 'real batch import deduplicates source/id and imports two unique songs');
    assert.ok(b.toastCalls.some(t => t.title === '已导入 2 首歌曲')); assert.ok(b.text().includes('已导入 2 / 3 首到「原始远程歌单」')); assert.ok(classes(b.id('playlist:import')).includes('qt-tv-skip'));
    b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(b.id('playlist:import'))['min-height'], undefined); assert.equal(b.css(follow.parent)['flex-direction'], undefined); assert.equal(b.id('playlist:name'), nameInput);
  } finally { await b.close(); }
};

cases['playlist-target-menu'] = async () => {
  const meta = installedMetaBoundary(), b = await formFixture({ width:480, height:240, compilerUts:true, engineOverrides:meta.sdk });
  try {
    const player = b.load('stores/player.ts').usePlayerStore(); player.restore();
    const first = player.createLocalPlaylist('已有原目标'), last = player.createLocalPlaylist('很长的原有歌单名称用于末尾选项');
    for (let i = 0; i < 12; i++) player.createLocalPlaylist('原歌单' + i);
    await b.mount('pages/playlist-import/index.uvue'); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush();
    const originalName = b.id('playlist:name'); await b.dispatch(b.byClass('seg-item')[1]); await b.dispatch(b.id('playlist:link'), 'input', { value:'remote-list-1' }); await b.dispatch(b.id('playlist:parse')); await b.flush();
    assert.equal(b.id('playlist:name'), originalName); assert.equal(originalName.parent.style.display, '');
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('playlist:target'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
    const menu = b.byClass('plat-menu')[0]; assert.ok(menu); assert.equal(b.tv.qtTvHasModal(), true, 'original inline target menu owns a modal TV focus scope');
    assert.ok(classes(menu).includes('qt-tv-scroll')); assert.equal(px(b, menu, 'width'), 254); assert.ok(px(b, menu, 'height') >= 76 && px(b, menu, 'height') <= 128, '240px TV pane budgets inline target list before original form scrolling');
    assert.equal(px(b, b.id('playlist:target'), 'width'), 254, 'selected long label is bounded by actual card interior'); assert.equal(b.tv.qtTvFocus('playlist:parse'), false); assert.equal(b.tv.qtTvFocus('playlist:import'), false);
    await b.clock.runTimers(32); assert.equal(b.id('playlist:target:new').props.id, menu.props['scroll-into-view'], 'first selected original target is revealed after original native layout delay');
    assert.equal(b.tv.qtTvFocus('playlist:target:' + last.id), true); await remote(b, 'ok'); await remote(b, 'ok', 1); assert.equal(b.byClass('plat-menu').length, 0); assert.equal(b.tv.qtTvHasModal(), false);
    assert.equal(textOf(b.id('playlist:target')).includes(last.name), true); assert.equal(b.id('playlist:name'), undefined, 'original conditional new-name field unmounts for an existing target');
    assert.equal(b.tv.qtTvFocus('playlist:target'), true, 'closing inline target menu returns to original invoking identity'); await remote(b, 'ok'); await b.clock.runTimers(32);
    const selected = b.id('playlist:target:' + last.id); assert.equal(selected.props.id, b.byClass('plat-menu')[0].props['scroll-into-view'], 'reopen reveals original existing target without reordering records');
    await remote(b, 'back'); await remote(b, 'back', 1); assert.equal(b.byClass('plat-menu').length, 0); assert.equal(b.routeEvents().length, 0, 'Back closes only the inline menu, not page'); assert.equal(textOf(b.id('playlist:target')).includes(last.name), true);
    await b.dispatch(b.id('playlist:target')); b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); const hugeMenu = b.byClass('plat-menu')[0]; assert.ok(px(b, hugeMenu, 'height') <= 128); textLine(b, walk(selected).find(n => classes(n).includes('qo-label')), 'huge target option');
    assert.equal(b.tv.qtTvFocus('playlist:target:new'), true); await remote(b, 'ok'); assert.ok(b.id('playlist:name')); assert.notEqual(b.id('playlist:name'), originalName, 'original targetChoice conditional lifetime is kept, no synthetic key remount');
    await b.dispatch(b.id('playlist:target')); b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(px(b, b.byClass('plat-menu')[0], 'height'), 220); assert.equal(b.css(b.byClass('plat-menu')[0]).width, undefined); assert.equal(b.css(b.id('playlist:target')).width, undefined);
    assert.equal(player.localPlaylists.filter(p => p.id === first.id || p.id === last.id).length, 2, 'selection itself makes no collection writes');
  } finally { await b.close(); }
};

cases['playlist-busy-lock'] = async () => {
  let heldParse, heldDetail;
  const meta = installedMetaBoundary((name, _args, reply) => { if (name === 'parseSheet') { heldParse = reply; return 'HELD'; } if (name === 'playlistDetail') { heldDetail = reply; return 'HELD'; } });
  const b = await formFixture({ width:480, height:240, compilerUts:true, engineOverrides:meta.sdk });
  try {
    await b.mount('pages/playlist-import/index.uvue'); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush();
    await b.dispatch(b.id('playlist:link'), 'input', { value:'123456' }); b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('playlist:parse'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(meta.calls.filter(c => c.name === 'parseSheet').length, 1); assert.equal(b.byClass('lock-mask').length, 1); assert.equal(b.lifecycle.backPress.some(fn => fn({ from:'backbutton' })), true, 'original native Back stays blocked during parse');
    assert.equal(b.tv.qtTvHasModal(), true, 'original lock panel owns non-dismissible highest TV scope'); assert.equal(b.tv.qtTvFocus('playlist:link'), false); assert.equal(b.tv.qtTvFocus('playlist:platform'), false); assert.equal(b.tv.qtTvFocus(b.byClass('seg-item')[1].props['data-qt-tv-id']), false);
    for (const key of ['back','menu','ok','down','up','left','right']) await remote(b, key); await remote(b, 'back', 1); assert.equal(b.routeEvents().length, 0); assert.equal(meta.calls.filter(c => c.name === 'parseSheet').length, 1); assert.ok(b.activations.slice(1).every(([id]) => b.candidates.get(id) === b.byClass('lock-card')[0]), 'read-only lock scroll may activate, never a background control');
    const lock = b.byClass('lock-card')[0]; assert.ok(px(b, lock, 'width') <= 424); assert.ok(px(b, lock, 'height') <= 216); assert.ok(classes(lock).includes('qt-tv-scroll')); b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); b.byClass('lock-title').forEach(n => textLine(b, n, 'huge busy title')); b.byClass('lock-sub').forEach(n => textLine(b, n, 'huge busy note'));
    heldParse({ ok:true, value:JSON.stringify({ platform:'wyy', id:'remote-list-1' }), error:'' }); await b.flush(); assert.ok(heldDetail); assert.equal(b.tv.qtTvHasModal(), true, 'same original lock spans parse to detail fetch');
    heldDetail({ ok:true, value:JSON.stringify({ detail:{ id:'remote-list-1', platform:'wyy', name:'原歌单', complete:true, tracks:[{ id:'song-1', name:'原曲', singer:'原唱' }] } }), error:'' }); await b.flush();
    assert.equal(b.byClass('lock-mask').length, 0); assert.equal(b.tv.qtTvHasModal(), false); assert.equal(b.lifecycle.backPress.some(fn => fn({ from:'backbutton' })), false); assert.equal(b.tv.qtTvFocus('playlist:link'), true);
    assert.ok(b.animations.length > 0); assert.ok(b.animations.every(a => a.cancelled === 1), 'real QtLoading cancels its native animation when original lock disappears');
    await b.dispatch(b.id('playlist:parse')); assert.equal(b.tv.qtTvHasModal(), true); heldParse({ ok:true, value:'null', error:'' }); await b.flush(); assert.equal(b.tv.qtTvHasModal(), false); assert.ok(b.toastCalls.some(t => t.title.includes('可试试在平台里手动选择'))); assert.equal(meta.calls.filter(c => c.name === 'playlistDetail').length, 1, 'explicit-null parser never triggers local fallback or another detail');
    b.tv.qtSetTvMode('touch'); await b.flush(); await b.dispatch(b.id('playlist:parse')); const touchLock = b.byClass('lock-card')[0]; assert.equal(b.css(touchLock).width, undefined); assert.equal(b.css(touchLock).height, undefined); heldParse({ ok:true, value:'null', error:'' }); await b.flush();
  } finally { await b.close(); }
};

cases['playlist-original-business'] = async () => {
  for (const scenario of ['follow','duplicate','empty','epoch','target-deleted','existing-follow']) {
    const meta = installedMetaBoundary(name => scenario === 'empty' && name === 'playlistDetail' ? { detail:{ id:'remote-list-1', platform:'wyy', name:'空的原歌单', complete:false, tracks:[] } } : undefined);
    const b = await formFixture({ width:480, height:360, compilerUts:true, engineOverrides:meta.sdk });
    try {
      const player = b.load('stores/player.ts').usePlayerStore(); player.restore(); let existing;
      if (scenario === 'duplicate') player.createLocalPlaylist('原始远程歌单');
      if (scenario === 'existing-follow' || scenario === 'target-deleted') existing = player.createLocalPlaylist('原已有歌单');
      await b.mount('pages/playlist-import/index.uvue'); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush();
      await b.dispatch(b.byClass('seg-item')[1]); await b.dispatch(b.id('playlist:link'), 'input', { value:'remote-list-1' }); await b.dispatch(b.id('playlist:parse')); await b.flush();
      if (existing) { await b.dispatch(b.id('playlist:target')); await b.dispatch(b.id('playlist:target:' + existing.id)); }
      if (scenario === 'follow' || scenario === 'existing-follow') { b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('playlist:follow'), true); await remote(b, 'ok'); await remote(b, 'ok', 1); }
      if (scenario === 'empty') { assert.ok(classes(b.id('playlist:follow')).includes('qt-tv-skip')); const count = player.localPlaylists.length; await b.dispatch(b.id('playlist:import')); assert.equal(player.localPlaylists.length, count); assert.equal(b.clock.timeoutCount(50), 0); assert.ok(b.toastCalls.some(t => t.title === '该歌单没有可导入的歌曲')); continue; }
      if (scenario === 'duplicate') { const count = player.localPlaylists.length; await b.dispatch(b.id('playlist:import')); assert.equal(player.localPlaylists.length, count); assert.equal(b.clock.timeoutCount(50), 0); assert.ok(b.toastCalls.some(t => t.title === '已有同名歌单，换个名字吧')); await b.dispatch(b.id('playlist:name'), 'input', { value:'  原用户自定义名称  ' }); }
      b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('playlist:import'), true); await remote(b, 'ok'); await remote(b, 'ok', 1); assert.equal(b.clock.timeoutCount(50), 1); assert.equal(b.tv.qtTvHasModal(), true); assert.equal(b.tv.qtTvFocus('playlist:target'), false); await remote(b, 'back'); assert.equal(b.routeEvents().length, 0);
      const target = existing ?? player.localPlaylists.at(-1); if (scenario === 'epoch') b.load('services/auth.ts').clearTokens(); if (scenario === 'target-deleted') player.deleteLocalPlaylist(target.id);
      await b.clock.runTimers(50); assert.equal(b.tv.qtTvHasModal(), false); assert.equal(b.clock.timeoutCount(50), 0);
      if (scenario === 'epoch' || scenario === 'target-deleted') { assert.equal(player.songsOfPid(target.pid).length, 0); assert.ok(b.toastCalls.some(t => t.title === (scenario === 'epoch' ? '账号已变化，请重试' : '目标歌单已删除'))); assert.ok(!classes(b.id('playlist:import')).includes('qt-tv-skip')); continue; }
      assert.deepEqual(Array.from(player.songsOfPid(target.pid), song => [song.platform,song.id]), [['wyy','remote-song-1'],['wyy','remote-song-2']]); assert.ok(b.toastCalls.some(t => t.title === '已导入 2 首歌曲')); assert.equal(target.name, scenario === 'duplicate' ? '原用户自定义名称' : existing ? '原已有歌单' : '原始远程歌单');
      const follows = b.load('services/playlist-follow.ts'), record = follows.playlistFollow(target.pid); assert.equal(record != null, scenario === 'follow' || scenario === 'existing-follow');
      if (record) { assert.equal(record.source, 'wyy'); assert.equal(record.sourceId, 'remote-list-1'); assert.equal(record.enabled, true); assert.deepEqual(Array.from(record.baseline), ['["wyy","remote-song-1"]','["wyy","remote-song-2"]']); assert.equal(b.storage.has('qt-playlist-follow-v1:guest:journal'), false, 'real journal completed before receipt'); }
      assert.equal(b.routeEvents().length, 0, 'original local import remains on page'); assert.ok(b.animations.every(a => a.cancelled === 1));
    } finally { await b.close(); }
  }
};

cases['web-login-shell'] = async () => {
  for (const nativeView of [true,false]) {
    const native = [], reads = [], meta = installedMetaBoundary(), b = await formFixture({ width:480, height:240, compilerUts:true, routeOptions:{ source:'wyy' }, engineOverrides:meta.sdk, nativeOverrides:{
      supportsNativeAuthWebView:() => nativeView, openAuthWebView:(url, onClose, ua) => native.push({ url, onClose, ua }), closeAuthWebView:() => native.push({ closed:true }), getWebCookies:urls => { reads.push(Array.from(urls)); return Promise.resolve([]); },
    } });
    try {
      await b.mount('pages/web-login/index.uvue'); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush(); assert.equal(b.runtimeErrors.length, 0);
      assert.ok(b.text().includes('契约网易云')); assert.ok(b.text().includes('剩余 3:00')); assert.equal(b.clock.intervalCount(1500), 1); assert.equal(reads.length, 1);
      assert.equal(b.byClass('wl-web').length, nativeView ? 0 : 1); assert.equal(native.length, nativeView ? 1 : 0); assert.equal(b.byClass('ql-qr').length, 0, 'original website flow introduces no generated QR surface');
      const head = b.byClass('wl-head')[0]; assert.ok(classes(head).includes('qt-tv-scroll'), 'short TV header remains its own native readonly scroll above original web-view');
      assert.ok(px(b, head, 'height') >= 56 && px(b, head, 'height') <= 84, '240px pane keeps the web viewport after bounded header'); assert.equal(px(b, head, 'width'), 288);
      for (const name of ['wl-name','wl-status']) b.byClass(name).forEach(node => textLine(b, node, name));
      if (nativeView) {
        const pane = b.byClass('wl-native')[0]; assert.ok(classes(pane).includes('qt-tv-scroll')); assert.equal(px(b, pane, 'width'), 288); assert.equal(b.css(pane)['justify-content'], 'flex-start'); textLine(b, b.byClass('wl-native-text')[0], 'native instruction');
        const button = b.button('重新打开官方登录页'); assert.equal(button.props['data-qt-tv-id'], 'web:reopen'); assert.equal(b.css(button).height, 'auto'); assert.equal(b.css(button)['align-self'], 'stretch'); assert.ok(px(b, button, 'min-height') >= 56);
        b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('web:reopen'), true); await remote(b, 'ok'); await remote(b, 'ok', 1); assert.equal(native.length, 2, 'public reopen once preserves original native navigation');
      } else {
        const web = b.byClass('wl-web')[0]; assert.equal(web.props.src, 'https://owned-web.invalid/login'); assert.equal(px(b, web, 'width'), 288); assert.equal(b.css(web)['min-height'], '56px'); assert.equal(typeof web.props.onClick, 'undefined', 'original embedded web-view keeps native focus ownership; no fabricated click target'); b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('web:status'), true, 'original header provides readonly remote document navigation');
      }
      b.fonts.useFontScaleStore().setTier('huge'); await b.flush(); for (const name of ['wl-name','wl-status','wl-native-text']) b.byClass(name).forEach(node => textLine(b, node, 'huge ' + name)); assert.ok(px(b, head, 'height') <= 84);
      await b.clock.runTimers(180000); assert.equal(b.clock.intervalCount(1500), 0); assert.ok(b.text().includes('长时间未捕获到登录 Cookie'));
      const retry = b.button('重新加载'); assert.equal(retry.props['data-qt-tv-id'], 'web:retry'); assert.ok(px(b, retry, 'min-height') >= 56); b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('web:retry'), true); await remote(b, 'ok'); await remote(b, 'ok', 1); assert.equal(b.clock.intervalCount(1500), 1); assert.equal(native.length, nativeView ? 2 : 0, 'retry retains open native window and original inner web-view');
      b.tv.qtSetTvMode('touch'); await b.flush(); assert.equal(b.css(head).height, undefined); assert.equal(b.css(head).width, undefined); if (nativeView) { assert.equal(b.css(b.button('重新打开官方登录页')).height, undefined, 'touch button restores original class height rather than TV inline height'); assert.equal(b.css(b.byClass('wl-native')[0])['justify-content'], undefined, 'touch original centered CSS has no TV override'); }
      b.lifecycle.unload.forEach(fn => fn()); await b.flush(); assert.equal(b.clock.intervalCount(1500), 0); assert.equal(b.clock.timeoutCount(400), 0); assert.equal(b.load('services/source-web-login-session.ts').sourceWebLoginIsAvailable(), true, 'public unload releases only original lease');
    } finally { await b.close(); }
  }
};

cases['web-login-original-success'] = async () => {
  for (const nativeView of [true,false]) {
    const calls = [], cookies = deferred(), meta = installedMetaBoundary(), b = await formFixture({ width:800, height:360, compilerUts:true, routeOptions:{ source:'wyy' }, engineOverrides:meta.sdk, nativeOverrides:{
      supportsNativeAuthWebView:() => nativeView, openAuthWebView:(url, onClose, ua) => calls.push({ name:'open', url, onClose, ua }), closeAuthWebView:() => calls.push({ name:'close' }), getWebCookies:urls => { calls.push({ name:'cookies', urls:Array.from(urls) }); return cookies.promise; },
    } });
    try {
      const auth = b.load('services/source-auth.ts'), web = b.load('services/source-web-login.ts'), events = [];
      b.uni.$on(web.WEB_LOGIN_DONE_EVENT, source => events.push(source)); await b.mount('pages/web-login/index.uvue'); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush();
      assert.deepEqual(calls.map(c => c.name), nativeView ? ['open','cookies'] : ['cookies'], 'original native open/clear boundary precedes first cookie capture'); assert.deepEqual(calls.at(-1).urls, ['https://owned-web.invalid/']); if (nativeView) { assert.equal(calls[0].url, 'https://owned-web.invalid/login'); assert.equal(calls[0].ua, ''); }
      const originalWeb = b.byClass('wl-web')[0]; await b.clock.runTimers(4500); assert.equal(calls.filter(c => c.name === 'cookies').length, 1, 'original in-flight cookie request stays single-flight');
      cookies.resolve(['MUSIC_U=first; blank =  ; x=one', 'MUSIC_U=later; x=two; other=a=b']); await b.flush(); await b.flush();
      const imports = meta.calls.filter(c => c.name === 'authImportCookie'); assert.equal(imports.length, 1); assert.deepEqual(imports[0].args, { source:'wyy', cookie:'MUSIC_U=first; blank=; x=one; other=a=b' }); assert.equal(imports[0].timeout, 30000);
      const entries = auth.readSourceAuthEntries(); assert.equal(entries.length, 1); assert.equal(entries[0].source, 'wyy'); assert.equal(entries[0].account.cookie, 'MUSIC_U=first; blank=; x=one; other=a=b'); assert.deepEqual(JSON.parse(JSON.stringify(entries[0].account.user)), { id:'owned-source-user', nickname:'原音源账号', avatar:'https://owned-cover.invalid/user.png', vip:true, vipLabel:'原会员' }); assert.equal(entries[0].account.extrasJson, ''); assert.equal(auth.sourceAuthRevision('wyy'), 1); assert.deepEqual(events, ['wyy']);
      assert.equal(b.clock.intervalCount(1500), 0); assert.equal(b.clock.timeoutCount(400), 1); assert.ok(b.text().includes('登录成功，正在返回')); assert.ok(b.toastCalls.some(t => t.title === '已登录原音源账号（原会员）')); assert.equal(b.byClass('wl-reopen').length, 0);
      assert.equal(calls.filter(c => c.name === 'close').length, nativeView ? 1 : 0); assert.equal(b.byClass('wl-web')[0], originalWeb, 'inner web-view persists through original success render');
      assert.equal(meta.calls.filter(c => c.name === 'setAuth').length >= 1, true, 'real saved account injects original data engine credentials'); assert.deepEqual(JSON.parse(JSON.stringify(auth.readSourceAuthTogglesFor('wyy'))), { useMeta:true, usePlay:false }); assert.equal(b.network.length, 0, 'cookie/user never forwarded to app HTTP boundary');
      await b.clock.runTimers(399); assert.equal(b.routeEvents().length, 0); await b.clock.runTimers(1); assert.deepEqual(b.routeEvents(), [{ action:'back' }]); b.lifecycle.unload.forEach(fn => fn()); await b.flush(); assert.equal(b.clock.timeoutCount(400), 0); assert.equal(b.load('services/source-web-login-session.ts').sourceWebLoginIsAvailable(), true); assert.equal(calls.filter(c => c.name === 'close').length, nativeView ? 1 : 0, 'unload does not close a later or already-finished native window');
    } finally { await b.close(); }
  }
};

cases['web-login-original-retry'] = async () => {
  const native = [], reads = [], meta = installedMetaBoundary(name => name === 'authImportCookie' ? { ok:false, user:null } : undefined), b = await formFixture({ width:480, height:240, compilerUts:true, routeOptions:{ source:'wyy' }, engineOverrides:meta.sdk, nativeOverrides:{
    supportsNativeAuthWebView:() => true, openAuthWebView:(url,onClose,ua) => native.push({ url,onClose,ua }), closeAuthWebView:() => native.push({ close:true }), getWebCookies:urls => { reads.push(Array.from(urls)); return Promise.resolve(['MUSIC_U=original-retry']); },
  } });
  try {
    const auth = b.load('services/source-auth.ts'); await b.mount('pages/web-login/index.uvue'); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush(); await b.flush(); assert.equal(meta.calls.filter(c => c.name === 'authImportCookie').length, 1); assert.equal(auth.readSourceAuthEntries().length, 0);
    await b.clock.runTimers(3000); assert.equal(meta.calls.filter(c => c.name === 'authImportCookie').length, 3); assert.equal(b.toastCalls.filter(t => t.title.includes('但校验未通过')).length, 1, 'original repeated invalid credentials toast once per flow'); assert.equal(b.clock.intervalCount(1500), 1);
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('web:reopen'), true); await remote(b,'ok'); await remote(b,'ok',1); assert.equal(native.length, 2); native[0].onClose('old-native-message'); await b.flush(); assert.ok(!b.text().includes('登录页已关闭')); assert.ok(!b.toastCalls.some(t => t.title === 'old-native-message'), 'old close generation is inert');
    native[1].onClose(''); await b.flush(); assert.ok(b.text().includes('登录页已关闭')); assert.equal(b.clock.intervalCount(1500), 1, 'user closed official native login still captures cookies'); const before = reads.length; await b.clock.runTimers(1500); assert.equal(reads.length, before + 1);
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('web:reopen'), true); await remote(b,'ok'); await remote(b,'ok',1); assert.equal(native.length, 3); assert.ok(!b.text().includes('登录页已关闭'));
    await b.clock.runTimers(175500); assert.equal(b.clock.intervalCount(1500), 0); assert.ok(b.text().includes('已捕获官方登录 Cookie，但账号校验未通过')); assert.equal(b.clock.timeoutCount(400), 0); assert.equal(auth.sourceAuthRevision('wyy'), 0); assert.equal(b.routeEvents().length, 0);
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('web:retry'), true); await remote(b,'ok'); await remote(b,'ok',1); assert.equal(native.length, 3, 'public retry reuses still-open native window'); assert.equal(b.clock.intervalCount(1500), 1); assert.equal(b.toastCalls.filter(t => t.title.includes('但校验未通过')).length, 2, 'explicit retry resets original one-toast flow');
    b.lifecycle.hide.forEach(fn => fn()); await b.flush(); assert.equal(b.clock.intervalCount(1500), 1, 'official-app excursion does not dispose source lease'); b.lifecycle.show.forEach(fn => fn()); await b.flush(); assert.equal(native.length, 3); b.lifecycle.unload.forEach(fn => fn()); await b.flush(); assert.equal(b.clock.intervalCount(1500), 0); assert.equal(native.filter(c => c.close).length, 1); assert.equal(b.load('services/source-web-login-session.ts').sourceWebLoginIsAvailable(), true);
  } finally { await b.close(); }
};

cases['web-login-original-lifecycle'] = async () => {
  const originalUser = { id:'owned-source-user', nickname:'原音源账号', avatar:'https://owned-cover.invalid/user.png', vip:true, vipLabel:'原会员' };
  for (const scenario of ['cookie-deadline','auth-deadline','cookie-revision','auth-revision','cookie-unload','auth-unload','return-revision','return-unload']) {
    const calls = [], cookies = deferred(), heldCookie = scenario.startsWith('cookie-'); let heldAuth;
    const meta = installedMetaBoundary((name, _args, reply) => { if (name === 'authImportCookie' && scenario.startsWith('auth-')) { heldAuth = reply; return 'HELD'; } });
    const b = await formFixture({ width:480, height:240, compilerUts:true, routeOptions:{ source:'wyy' }, engineOverrides:meta.sdk, nativeOverrides:{
      supportsNativeAuthWebView:() => true, openAuthWebView:(url,onClose) => calls.push({ name:'open',url,onClose }), closeAuthWebView:() => calls.push({ name:'close' }),
      getWebCookies:() => { calls.push({ name:'cookies' }); return heldCookie ? cookies.promise : Promise.resolve(['MUSIC_U=original-lifecycle']); },
    } });
    try {
      const auth = b.load('services/source-auth.ts'), events = [];
      b.uni.$on(b.load('services/source-web-login.ts').WEB_LOGIN_DONE_EVENT, value => events.push(value));
      await b.mount('pages/web-login/index.uvue'); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush(); await b.flush();
      if (scenario.startsWith('auth-')) assert.equal(typeof heldAuth, 'function', scenario + ' holds only original native invoke callback');
      if (scenario.startsWith('return-')) { assert.equal(auth.sourceAuthRevision('wyy'), 1); assert.equal(events.length, 1); assert.equal(b.clock.timeoutCount(400), 1); }
      if (scenario.endsWith('deadline')) b.clock.advance(180000);
      if (scenario.endsWith('revision')) await auth.removeSourceAuthAccount('wyy');
      if (scenario.endsWith('unload')) { b.lifecycle.unload.forEach(fn => fn()); await b.flush(); assert.equal(b.clock.intervalCount(1500), 0); assert.equal(b.clock.timeoutCount(400), 0, 'unload clears original return timer while fixture is alive'); }
      if (heldCookie) cookies.resolve(['MUSIC_U=late-original-cookie']);
      if (heldAuth) heldAuth({ ok:true, value:JSON.stringify({ ok:true, user:originalUser }), error:'' });
      await b.flush(); await b.flush();
      if (scenario === 'return-revision') { assert.equal(b.clock.timeoutCount(400), 1, 'original previously scheduled return waits for callback-time revision guard'); await b.clock.runTimers(400); }
      assert.equal(b.clock.intervalCount(1500), 0, scenario + ' leaves no original polling interval'); assert.equal(b.clock.timeoutCount(400), 0); assert.equal(b.routeEvents().length, 0);
      assert.equal(events.length, scenario.startsWith('return-') ? 1 : 0, scenario + ' emits no stale success receipt');
      if (!scenario.startsWith('return-')) { assert.equal(auth.readSourceAuthEntries().length, 0); assert.equal(auth.sourceAuthRevision('wyy'), scenario.endsWith('revision') ? 1 : 0); assert.ok(!b.toastCalls.some(t => t.title.startsWith('已登录'))); }
      if (scenario.endsWith('deadline')) { assert.ok(b.text().includes('还没捕获到登录凭据') || b.text().includes('长时间未捕获到登录 Cookie')); assert.equal(calls.filter(c => c.name === 'close').length, 0, 'timeout does not close original window'); }
      if (scenario.endsWith('revision')) { if (scenario.startsWith('return-')) await b.clock.runTimers(400); assert.ok(b.text().includes('本次登录已取消')); assert.equal(calls.filter(c => c.name === 'close').length, 1); }
      if (scenario.endsWith('unload')) { calls.find(c => c.name === 'open').onClose('late-unloaded-native'); await b.flush(); assert.ok(!b.toastCalls.some(t => t.title === 'late-unloaded-native')); assert.equal(calls.filter(c => c.name === 'close').length, 1); assert.equal(b.load('services/source-web-login-session.ts').sourceWebLoginIsAvailable(), true); }
      if (heldCookie) assert.equal(meta.calls.filter(c => c.name === 'authImportCookie').length, 0, 'late cookie boundary never starts validation');
      if (scenario === 'return-revision') { assert.equal(auth.readSourceAuthEntries().length, 0); assert.equal(auth.sourceAuthRevision('wyy'), 2); assert.equal(b.routeEvents().length, 0); }
      if (!scenario.endsWith('unload')) { b.lifecycle.unload.forEach(fn => fn()); await b.flush(); assert.equal(b.clock.intervalCount(1500), 0); assert.equal(b.clock.timeoutCount(400), 0); }
    } finally { await b.close(); }
  }
};

cases['web-login-original-persistence'] = async () => {
  const calls = [], laterCookie = deferred(), meta = installedMetaBoundary(); let cookieReads = 0, dropAccountWrite = true;
  const b = await formFixture({ width:480, height:240, compilerUts:true, routeOptions:{ source:'wyy' }, engineOverrides:meta.sdk, nativeOverrides:{
    supportsNativeAuthWebView:() => true, openAuthWebView:(url,onClose) => calls.push({ name:'open',url,onClose }), closeAuthWebView:() => calls.push({ name:'close' }),
    getWebCookies:() => ++cookieReads === 1 ? Promise.resolve(['MUSIC_U=original-persist']) : laterCookie.promise,
  } });
  try {
    const auth = b.load('services/source-auth.ts'), events = [];
    b.uni.$on(b.load('services/source-web-login.ts').WEB_LOGIN_DONE_EVENT, value => events.push(value));
    b.setSdk({ setStorageSync(key,value) { if (key === 'qt-source-auth-accounts' && dropAccountWrite) throw new Error('fixture account storage failure'); b.storage.set(key,value); b.storageWrites.push([key,value]); } });
    await b.mount('pages/web-login/index.uvue'); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush(); await b.flush();
    assert.equal(auth.sourceAuthRevision('wyy'), 1); assert.equal(auth.readSourceAuthEntries().length, 0); assert.deepEqual(events, []); assert.equal(b.clock.timeoutCount(400), 0); assert.equal(b.routeEvents().length, 0);
    assert.equal(b.clock.intervalCount(1500), 1, 'original unreadable account write restarts real cookie polling'); assert.equal(cookieReads, 2); assert.equal(calls.filter(c => c.name === 'open').length, 2); assert.equal(calls.filter(c => c.name === 'close').length, 1, 'original retry reopens the finished native window after persistence failure'); assert.ok(b.toastCalls.some(t => t.title.includes('保存登录失败：账号凭据未成功写入本地存储')));
    assert.ok(!b.toastCalls.some(t => t.title.startsWith('已登录'))); dropAccountWrite = false; laterCookie.resolve(['MUSIC_U=original-persist']); await b.flush(); await b.flush();
    assert.equal(auth.sourceAuthRevision('wyy'), 2); assert.equal(auth.readSourceAuthEntries()[0].account.cookie, 'MUSIC_U=original-persist'); assert.equal(meta.calls.filter(c => c.name === 'authImportCookie').length, 2); assert.deepEqual(events, ['wyy']); assert.equal(b.clock.intervalCount(1500), 0); assert.equal(b.clock.timeoutCount(400), 1); assert.equal(calls.filter(c => c.name === 'close').length, 2);
    b.lifecycle.unload.forEach(fn => fn()); await b.flush(); assert.equal(b.clock.timeoutCount(400), 0); await b.clock.runTimers(400); assert.equal(b.routeEvents().length, 0, 'original successful retry is still disposed before delayed navigation');
  } finally { await b.close(); }
};

cases['web-login-original-qq'] = async () => {
  const expectedCookie = 'wxuin=o0123456; wxopenid=fixture-openid; qqmusic_key=fixture-key; extra=keep; qm_keyst=fixture-key; uin=123456';
  const user = { id:'fixture-wechat-user', nickname:'QQ 3456', avatar:'https://owned-cover.invalid/old.png', vip:false, vipLabel:'' };
  const calls = [], cookies = deferred(), meta = installedMetaBoundary(name => name === 'authImportCookie' ? { ok:true,user } : undefined);
  const b = await formFixture({ width:1920, height:1080, compilerUts:true, routeOptions:{ source:'qq' }, engineOverrides:meta.sdk, nativeOverrides:{
    supportsNativeAuthWebView:() => true, openAuthWebView:(url,onClose,ua) => calls.push({ name:'open',url,onClose,ua }), closeAuthWebView:() => calls.push({ name:'close' }),
    getWebCookies:urls => { calls.push({ name:'cookies',urls:Array.from(urls) }); return cookies.promise; },
  } });
  try {
    const auth = b.load('services/source-auth.ts'), events = [];
    b.uni.$on(b.load('services/source-web-login.ts').WEB_LOGIN_DONE_EVENT, value => events.push(value)); await b.mount('pages/web-login/index.uvue'); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush();
    assert.equal(calls[0].url, 'https://y.qq.com/n/ryqq/profile/login'); assert.equal(calls[0].ua, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    assert.deepEqual(calls[1].urls, ['https://y.qq.com/','https://u.y.qq.com/','https://c.y.qq.com/','https://qq.com/','https://open.weixin.qq.com/'], 'original QQ capture supplements host-only domains exactly once'); assert.equal(px(b,b.byClass('wl-head')[0],'width'),720, 'original Frame flow cap stays 720 on large TV');
    cookies.resolve(['wxuin=o0123456; wxopenid=fixture-openid; qqmusic_key=fixture-key','qqmusic_key=later-key; extra=keep']); await b.flush(); await b.flush();
    const imported = meta.calls.filter(c => c.name === 'authImportCookie'); assert.equal(imported.length,1); assert.deepEqual(imported[0].args,{ source:'qq',cookie:expectedCookie });
    const account = auth.readSourceAuthEntries()[0].account; assert.equal(account.cookie,expectedCookie); assert.deepEqual(JSON.parse(JSON.stringify(account.user)),{ id:'fixture-wechat-user',nickname:'微信 · 3456',avatar:'',vip:false,vipLabel:'' }, 'original numeric account-id normalization and WeChat display remain unchanged'); assert.equal(account.extrasJson,''); assert.equal(auth.sourceAuthRevision('qq'),1); assert.deepEqual(events,['qq']); assert.ok(b.toastCalls.some(t => t.title === '已登录微信 · 3456（非会员）'));
    assert.equal(b.clock.intervalCount(1500),0); assert.equal(b.clock.timeoutCount(400),1); assert.equal(calls.filter(c => c.name === 'close').length,1); assert.equal(b.network.length,0); b.lifecycle.unload.forEach(fn => fn()); await b.flush(); assert.equal(b.clock.timeoutCount(400),0);
  } finally { await b.close(); }
};

cases['web-login-original-entry'] = async () => {
  for (const scenario of ['missing','unsupported','unloaded-missing','unloaded-registry']) {
    const native = [], waitingRegistry = scenario === 'unloaded-registry'; let heldRegistry;
    const meta = installedMetaBoundary((name,_args,reply) => { if (name === 'sourceRegistry' && waitingRegistry) { heldRegistry = reply; return 'HELD'; } });
    const b = await formFixture({ width:480, height:240, compilerUts:true, routeOptions:scenario.includes('missing') ? {} : { source:'missing-source' }, engineOverrides:meta.sdk, nativeOverrides:{
      supportsNativeAuthWebView:() => true, openAuthWebView:(...args) => native.push({ name:'open',args }), closeAuthWebView:() => native.push({ name:'close' }), getWebCookies:async () => { native.push({ name:'cookies' }); return []; },
    } });
    try {
      await b.mount('pages/web-login/index.uvue'); if (!waitingRegistry && !scenario.includes('missing')) await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush();
      assert.equal(native.length,0); assert.equal(b.clock.intervalCount(1500),0); assert.equal(b.byClass('wl-web').length,0);
      if (waitingRegistry) { assert.equal(typeof heldRegistry,'function'); assert.equal(b.clock.timeoutCount(350),0); b.lifecycle.unload.forEach(fn => fn()); await b.flush(); heldRegistry({ ok:true,value:JSON.stringify({ sourcePolicyVersion:1,sources:meta.sources,qualities:[{ id:'320',name:'标准' }] }),error:'' }); await b.flush(); await b.flush(); assert.equal(b.clock.timeoutCount(350),0); assert.ok(!b.toastCalls.some(t => t.title.includes('暂不支持网页登录'))); }
      else { assert.equal(b.clock.timeoutCount(350),1); assert.ok(b.toastCalls.some(t => t.title === (scenario.includes('missing') ? '缺少音源参数' : '该音源暂不支持网页登录'))); assert.equal(b.routeEvents().length,0); if (scenario === 'unloaded-missing') { b.lifecycle.unload.forEach(fn => fn()); await b.flush(); assert.equal(b.clock.timeoutCount(350),0); } }
      await b.clock.runTimers(349); assert.equal(b.routeEvents().length,0); await b.clock.runTimers(1); assert.deepEqual(b.routeEvents(), scenario.startsWith('unloaded-') ? [] : [{ action:'back' }]);
      b.lifecycle.unload.forEach(fn => fn()); await b.flush(); assert.equal(b.load('services/source-web-login-session.ts').sourceWebLoginIsAvailable(),true); assert.equal(b.clock.timeoutCount(350),0); assert.equal(native.length,0);
    } finally { await b.close(); }
  }
};

cases['web-login-original-owner'] = async () => {
  for (const resume of [true,false]) {
    const native = [], firstCookie = deferred(), secondCookie = deferred(); let reads = 0;
    const meta = installedMetaBoundary(), b = await formFixture({ width:480, height:240, compilerUts:true, routeOptions:{ source:'wyy' }, engineOverrides:meta.sdk, nativeOverrides:{
      supportsNativeAuthWebView:() => true, openAuthWebView:(url,onClose) => native.push({ name:'open',url,onClose }), closeAuthWebView:() => native.push({ name:'close' }),
      getWebCookies:() => ++reads === 1 ? firstCookie.promise : secondCookie.promise,
    } });
    try {
      const session = b.load('services/source-web-login-session.ts'), auth = b.load('services/source-auth.ts'); await b.mount('pages/web-login/index.uvue'); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush();
      const old = native[0]; assert.equal(session.sourceWebLoginIsAvailable(),false); b.lifecycle.hide.forEach(fn => fn()); await b.flush(); assert.equal(session.sourceWebLoginIsAvailable(),false,'ordinary app hide retains current original owner');
      const otherOwner = session.claimSourceWebLogin(); old.onClose('obsolete-owner-close'); firstCookie.resolve(['MUSIC_U=obsolete-owner-cookie']); await b.flush(); await b.flush();
      assert.equal(auth.readSourceAuthEntries().length,0); assert.equal(meta.calls.filter(c => c.name === 'authImportCookie').length,0); assert.ok(!b.toastCalls.some(t => t.title === 'obsolete-owner-close'));
      b.lifecycle.show.forEach(fn => fn()); await b.flush(); assert.equal(session.sourceWebLoginIsCurrent(otherOwner),true,'retained page show does not steal active owner'); assert.equal(native.length,1);
      if (resume) {
        session.releaseSourceWebLogin(otherOwner); b.lifecycle.show.forEach(fn => fn()); await b.flush(); assert.equal(session.sourceWebLoginIsAvailable(),false); assert.equal(b.clock.intervalCount(1500),0); assert.ok(b.text().includes('本次登录已取消')); assert.equal(native.length,1,'retained page recovery does not auto-open or reuse obsolete window');
        b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('web:retry'),true); await remote(b,'ok'); await remote(b,'ok',1); assert.equal(native.filter(n => n.name === 'open').length,2); assert.equal(b.clock.intervalCount(1500),1); assert.equal(reads,2); old.onClose('obsolete-after-resume'); await b.flush(); assert.ok(!b.toastCalls.some(t => t.title === 'obsolete-after-resume'));
        b.lifecycle.unload.forEach(fn => fn()); await b.flush(); secondCookie.resolve(['MUSIC_U=late-disposed-cookie']); await b.flush(); assert.equal(native.filter(n => n.name === 'close').length,1); assert.equal(session.sourceWebLoginIsAvailable(),true);
      } else {
        b.lifecycle.unload.forEach(fn => fn()); await b.flush(); assert.equal(native.filter(n => n.name === 'close').length,0,'old page unload does not close later owner native singleton'); assert.equal(session.sourceWebLoginIsCurrent(otherOwner),true); session.releaseSourceWebLogin(otherOwner); assert.equal(session.sourceWebLoginIsAvailable(),true);
      }
      assert.equal(b.clock.intervalCount(1500),0); assert.equal(b.clock.timeoutCount(400),0); assert.equal(auth.readSourceAuthEntries().length,0); assert.equal(b.routeEvents().length,0);
    } finally { await b.close(); }
  }
};

cases['forms-compiler-restoration'] = async () => {
  const originalVShow = Object.getOwnPropertyDescriptor(Vue.vShow,'beforeMount');
  const plain = await formFixture({ width:480,height:240 });
  try { const proto = Object.getPrototypeOf(plain.load('services/http.ts').parseJsonToUtso('{}')); for (const name of ['getString','getNumber','getBoolean']) assert.equal(Object.getOwnPropertyDescriptor(proto,name),undefined,'fresh frozen fixture has no typed compiler accessor'); }
  finally { await plain.close(); }
  for (const route of ['pages/playlist-import/index.uvue','pages/web-login/index.uvue']) {
    const calls = [], heldCookie = deferred(), meta = installedMetaBoundary(), b = await formFixture({ width:480,height:240,compilerUts:true,engineOverrides:meta.sdk,routeOptions:{ source:'wyy' },nativeOverrides:{
      supportsNativeAuthWebView:() => true,openAuthWebView:() => calls.push('open'),closeAuthWebView:() => calls.push('close'),getWebCookies:() => heldCookie.promise,
    } });
    try {
      const sample = b.load('services/http.ts').parseJsonToUtso('{"name":"retained","number":7,"boolean":true}'); assert.equal(sample.getString('name'),'retained'); assert.equal(sample.getString('number'),null); assert.equal(sample.getNumber('number'),7); assert.equal(sample.getBoolean('boolean'),true);
      await b.mount(route); await b.load('stores/source-registry.ts').useSourceRegistryStore().ensure(); await b.flush(); assert.deepEqual(Object.getOwnPropertyDescriptor(Vue.vShow,'beforeMount'),originalVShow,'native v-show adapter restores original directive immediately after mount');
      if (route.includes('playlist-import')) { await b.dispatch(b.byClass('seg-item')[1]); await b.dispatch(b.id('playlist:link'),'input',{ value:'remote-list-1' }); await b.dispatch(b.id('playlist:parse')); await b.dispatch(b.id('playlist:target')); assert.equal(b.tv.qtTvHasModal(),true); assert.ok(b.clock.timeoutCount(32)>0,'original selection reveal waits on actual native delay'); }
      else { assert.equal(b.clock.intervalCount(1500),1); assert.deepEqual(calls,['open']); }
      assert.equal(typeof b.root.__vue_app__?.unmount,'function','original native container holds public Vue App instance'); b.root.__vue_app__.unmount(); await b.flush();
      assert.equal(b.clock.timeoutCount(32),0,'actual unmount cancels selection timers before fixture close'); assert.equal(b.clock.intervalCount(1500),0); assert.equal(b.clock.timeoutCount(400),0); assert.equal(b.tv.qtTvHasModal(),false); assert.deepEqual(Object.getOwnPropertyDescriptor(Vue.vShow,'beforeMount'),originalVShow);
      if (route.includes('web-login')) { heldCookie.resolve(['MUSIC_U=late-unmounted-cookie']); await b.flush(); assert.deepEqual(calls,['open','close']); assert.equal(meta.calls.filter(c => c.name === 'authImportCookie').length,0); assert.equal(b.load('services/source-web-login-session.ts').sourceWebLoginIsAvailable(),true); }
    } finally { await b.close(); }
    assert.deepEqual(b.restoredCompilerBindings.slice(0,5),['uts-json','uts-json','getString','getNumber','getBoolean']); assert.deepEqual(b.restoredCompilerBindings.slice(5),route.includes('web-login') ? ['web:onUnload','web:onShow','web:onLoad','web:computed','web:ref'] : []);
  }
  const after = await formFixture({ width:480,height:240 });
  try { const proto = Object.getPrototypeOf(after.load('services/http.ts').parseJsonToUtso('{}')); for (const name of ['getString','getNumber','getBoolean']) assert.equal(Object.getOwnPropertyDescriptor(proto,name),undefined,'later non-UTS fixture stays unpolluted'); await after.mount('pages/login/index.uvue'); fieldGeometry(after,after.id('login:account'),'later original login field'); assert.equal(after.runtimeErrors.length,0); }
  finally { await after.close(); }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Vue.vShow,'beforeMount'),originalVShow);
};

export async function runTvFormsChecks(selected = 'all') {
  const names = selected === 'all' ? Object.keys(cases) : [selected];
  for (const name of names) { assert.ok(cases[name], 'known forms case: ' + name); await cases[name](); console.log('PASS tv-forms ' + name); }
  console.log('TV forms: ' + names.length + ' approved public-template groups passed');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL('file:' + process.argv[1].replaceAll('\\', '/')))) {
  await runTvFormsChecks(process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'all');
}
