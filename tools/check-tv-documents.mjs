// task-34 agreed seam: complete original production SFC + real QtUI/Frame,
// public props/default slot/click/tap/remote and unchanged business services.
// Owned substitutions: native viewport/files/engine/network/navigation/clock.
// Emitted px and synthetic native rectangles are not Yoga/device acceptance.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as Vue from 'vue';
import { tvListHostFixture } from './check-tv-list-hosts.mjs';

const cases = {};
const noop = () => {};
const walk = node => node == null ? [] : [node, ...node.children.flatMap(walk)];
const classes = node => String(node.props.class ?? '').split(/\s+/);
const textOf = node => node.text + node.children.map(textOf).join('');
const px = (b, node, name) => Number.parseFloat(b.css(node)[name] ?? '0');
const remote = async (b, key, repeat = 0) => {
  const code = { up:19, down:20, left:21, right:22, ok:23, back:4, menu:82 }[key];
  const consumed = b.tv.qtTvDispatchRemote({ key, code, action:'down', repeat }); await b.flush(); return consumed;
};

export async function documentFixture({ width = 1280, height = 720, savedMode = 'tv', initialStorage = {}, requestHandler = null,
  sdkOverrides = {}, engineOverrides = {}, nativeOverrides = {} } = {}) {
  const candidates = new Map(), collectedRoots = [], activations = [], scrolls = [], highlights = [], network = [], nativeCalls = [];
  const nativeIds = new WeakMap(); let serial = 0, b;
  function collect(root) {
    root = Vue.toRaw(root); collectedRoots.push(root); candidates.clear();
    return walk(root).flatMap((node, index) => {
      if (classes(node).includes('qt-tv-skip')) return [];
      const scroll = (node.tag === 'scroll-view' || node.tag === 'list-view') && classes(node).includes('qt-tv-scroll');
      const actionable = typeof node.props.onClick === 'function' || Array.isArray(node.props.onClick) || typeof node.props.onTap === 'function';
      if (!scroll && !actionable) return [];
      let id = nativeIds.get(node);
      if (!id) { id = 'native:custom:' + (node.props['data-qt-tv-id'] || 'document-node-' + ++serial); nativeIds.set(node, id); }
      candidates.set(id, node);
      return [{ id, left:28, top:28 + index * 60, width:300, height:56, visible:true, enabled:node.props.disabled !== true, input:false, longPress:false, scrollGroup:scroll ? id : '' }];
    });
  }
  const sdk = { publicDataDir:() => '', dataDir:() => '/owned-documents', queryPermissionStates:() => [], statLocalFile:() => -1,
    readEmbeddedTags:() => null, readTextFile:(_path, reply) => reply(false, '', 'fixture file absent'), exists:(_path, reply) => reply(true, '0', ''),
    start:() => false, isRunning:() => false, isHealthy:() => false, ...engineOverrides };
  b = await tvListHostFixture({ width, height, savedMode, initialStorage, realFrame:true,
    boundaryOverrides:{ 'services/music-api':undefined, 'services/http':undefined,
      'services/config':{ API_BASE_URL:'https://owned.invalid/api/' },
      'services/app-version':{ getCurrentVersionCode:() => 1, getCurrentVersionName:() => 'fixture' },
      'services/app-native':{ supportsHomeBackMode:() => true, isHarmonyOs:() => false, ...nativeOverrides },
      'uni_modules/qt-app-native':sdk, 'uni_modules/qt-js-engine':sdk,
      'services/tv-platform':{ tvReadDevice:() => ({ television:false, nativeAvailable:false }), tvStartRemote:noop, tvSetRemoteState:noop, tvStopRemote:noop,
        tvCollect:collect, tvHighlight:(...args) => highlights.push(args), tvActivate:(id, longPress) => {
          activations.push([id, longPress]); const target = candidates.get(id);
          if (target) void b.dispatch(target, typeof target.props.onTap === 'function' ? 'tap' : 'click');
        }, tvScroll:(id, direction) => { scrolls.push([id, direction]); return true; }, tvPresent:noop,
        tvBack:() => nativeCalls.push(['back']) } },
    sdkOverrides:{ getDeviceInfo:() => ({ deviceModel:'TV fixture', osName:'Android', osVersion:'14' }),
      showLoading:value => nativeCalls.push(['loading-show', value]), hideLoading:() => nativeCalls.push(['loading-hide']),
      request:options => { network.push({ url:options.url, method:options.method, data:options.data, header:options.header, options });
        if (requestHandler) requestHandler(options, network); else options.fail?.({ errMsg:'owned network response not selected' }); }, ...sdkOverrides } });
  b.fonts.fontScale.init();
  return { ...b, candidates, collectedRoots, activations, scrolls, highlights, network, nativeCalls };
}

// SDK callback transport only. Original package header/signature/registry,
// manifest offer/applyUpdate/rollback and loading/settlement are not replaced.
export function installNativeBoundary({ installedMeta = true, signReply = null, engineReply = null, fileReply = null } = {}) {
  const files = new Map(), calls = []; let running = false;
  const meta = { id:'meta-documents-fixture', kind:'meta', name:'原生契约数据包', versionCode:1, versionName:'1.0', updateUrl:'', installedAt:1, updatedAt:1, skipCodes:[] };
  if (installedMeta) {
    files.set('/owned-documents/source-bundle/state.json', JSON.stringify({ schema:3, packs:[meta], activeId:'', activeMetaId:meta.id, lastCheckAt:0 }));
    files.set('/owned-documents/source-bundle/install/' + meta.id + '/meta-bundle.js', '/*__QT_PACK__' + JSON.stringify(meta) + '*/\nexport default {};');
  }
  const sdk = {
    publicDataDir:() => '', dataDir:() => '/owned-documents', queryPermissionStates:() => [], statLocalFile:() => -1, readEmbeddedTags:() => null,
    isRunning:() => running, isHealthy:() => true,
    start(options, reply) { running = true; calls.push({ name:'start', options }); reply({ engine:'Native callback fixture', version:'1', hostApiVersion:1, probe:'2' }, null); },
    stop(reply) { running = false; calls.push({ name:'stop' }); reply?.({ ok:true, error:'' }); },
    readTextFile(path, reply) { calls.push({ name:'read', path }); files.has(path) ? reply(true, files.get(path), '') : reply(false, '', 'fixture file absent'); },
    writeTextFile(path, value, reply) { calls.push({ name:'write', path, value }); if (fileReply?.('write', path, value, reply) === 'HELD') return; files.set(path, value); reply(true, '', ''); },
    appendTextFile(path, value, reply) { files.set(path, (files.get(path) ?? '') + value); reply(true, '', ''); },
    exists:(path, reply) => reply(true, files.has(path) ? '1' : '0', ''),
    mkdirs:(_path, reply) => reply(true, '', ''),
    remove(path, reply) { for (const key of [...files.keys()]) if (key === path || key.startsWith(path + '/')) files.delete(key); reply(true, '', ''); },
    renamePath(from, to, reply) { calls.push({ name:'rename', from, to }); if (fileReply?.('rename', from, to, reply) === 'HELD') return; if (!files.has(from)) { reply(false, '', 'fixture file absent'); return; } files.set(to, files.get(from)); files.delete(from); reply(true, '', ''); },
    listDir(_path, reply) { reply(true, '[]', ''); },
    loadBundle(code, reply) { calls.push({ name:'loadBundle', code }); reply({ ok:true, error:'' }); },
    loadPlayBundle(code, reply) { calls.push({ name:'loadPlayBundle', code }); reply({ ok:true, error:'' }); },
    evaluate(code, reply) { calls.push({ name:'evaluate', code }); reply({ ok:true, value:'null', error:'' }); },
    verifyPackSignature(content, signature, publicKey, reply) { const call = { name:'signature', content, signature, publicKey }; calls.push(call); if (signReply) signReply(reply, call); else reply({ ok:true, value:'ok', error:'' }); },
    invoke(name, argsJson, timeout, reply) {
      const args = JSON.parse(argsJson), call = { name, args, argsJson, timeout }; calls.push(call);
      const configured = engineReply?.(name, args, reply, call); if (configured === 'HELD') return;
      let value = configured;
      if (value === undefined) {
        if (name === 'bundleInfo') value = { name:'meta-bundle', hostApiVersion:1, metaRevision:1, sourcePolicyVersion:1 };
        else if (name === 'sourceRegistry') value = { sourcePolicyVersion:1, sources:[], qualities:[] };
        else if (name === 'setSourcePolicy') value = { ok:true, playSupported:true };
        else value = { ok:true };
      }
      reply({ ok:true, value:JSON.stringify(value), error:'' });
    },
  };
  return { sdk, files, calls };
}

async function installFixture({ width = 480, height = 360, savedMode = 'tv', tier = 'huge', notes = '原始发布说明'.repeat(80), release = {},
  manifestHandler = null, downloadHandler = null, ...nativeOptions } = {}) {
  const native = installNativeBoundary(nativeOptions), downloads = [], compilerReceipts = [];
  const releaseData = { sourceVersionCode:7, sourceVersionName:'7.0', platforms:[], hostApiVersion:1, channel:'stable', notes, publishedAt:'', rollbackTo:0, bad:false, published:true,
    artifacts:[{ path:'play-bundle.js', version:7, url:'https://owned-artifact.invalid/play.js', packId:'play-official', packVersionCode:7, packVersionName:'7.0' }], ...release };
  const b = await documentFixture({ width, height, savedMode, initialStorage:{ 'qt-ui-font-scale':tier }, engineOverrides:native.sdk,
    requestHandler(options) {
      if (options.url.includes('/source/manifest')) {
        if (manifestHandler) manifestHandler(options, releaseData);
        else options.success?.({ statusCode:200, data:JSON.stringify({ code:200, data:{ schema:1, generatedAt:'', release:releaseData } }) });
      } else if (options.url.includes('/source/report')) options.success?.({ statusCode:200, data:'{"code":200,"data":null}' });
      else options.fail?.({ errMsg:'owned request not configured' });
    }, sdkOverrides:{ downloadFile:options => { downloads.push(options); if (downloadHandler) downloadHandler(options, native); else options.fail?.({ errMsg:'owned download not configured' }); } } });
  const http = b.load('services/http.ts'), prototype = Object.getPrototypeOf(http.parseJsonToUtso('{}'));
  const accessors = [['getString','string'], ['getNumber','number'], ['getBoolean','boolean']], descriptors = accessors.map(([name]) => [name, Object.getOwnPropertyDescriptor(prototype, name)]);
  for (const [name, type] of accessors) Object.defineProperty(prototype, name, { configurable:true, value(key) { const value = this.get(key); return typeof value === type ? value : null; } });
  const realms = [['services/source-pack-header.uts','parsePackHeader'], ['services/source-engine.uts','sourceEngineEpoch']].map(([path, name]) => {
    const json = b.load(path)[name].constructor('return JSON')(), parse = json.parse;
    json.parse = text => http.parseJsonToUtso(text); return { json, parse };
  });
  const close = b.close;
  b.close = async () => { try { await close(); } finally {
    for (const { json, parse } of realms) { json.parse = parse; assert.equal(json.parse, parse); compilerReceipts.push('exact-uts-json-restored'); }
    for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(prototype, name, descriptor); else delete prototype[name]; assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, name), descriptor); compilerReceipts.push('exact-' + name + '-descriptor-restored'); }
  } };
  return { ...b, nativeBoundary:native, downloads, compilerReceipts, releaseData };
}

cases['card-full-template'] = async () => {
  const title = '原有卡片完整标题需要按电视距离自然换行并保持原有插槽', description = '原有说明文本需要逐行展示，不通过省略号或固定高度丢掉后半段。'.repeat(5);
  for (const tier of ['tiny', 'small', 'normal', 'large', 'huge']) {
    const b = await documentFixture({ width:480, height:360, initialStorage:{ 'qt-ui-font-scale':tier } });
    let clicks = 0;
    try {
      await b.mount('../_tmp/tv-documents/card-host.uvue', { title, description, scrollStyle:'height:200px;width:288px;', 'onSlot-click':() => { clicks++; } });
      const card = b.byClass('qt-card')[0], heading = b.byClass('qt-card-title')[0], note = b.byClass('qt-card-description')[0];
      assert.ok(b.byClass('qt-page-frame').length === 1, 'actual production Frame, not a page mock');
      assert.equal(textOf(heading), title); assert.equal(textOf(note), description); assert.equal(b.byClass('fixture-existing-slot').length, 1);
      assert.ok(px(b, heading, 'font-size') >= 20 && px(b, note, 'font-size') >= 20, 'TV floor20 for every saved tier');
      assert.ok(px(b, heading, 'line-height') >= px(b, heading, 'font-size') * 1.3, 'TV card title has explicit native line metric');
      assert.ok(px(b, note, 'line-height') >= px(b, note, 'font-size') * 1.4, 'TV card description remains legible at huge font');
      assert.equal(b.css(heading)['align-self'], 'stretch'); assert.equal(b.css(note)['align-self'], 'stretch');
      assert.equal(heading.props['max-lines'], undefined); assert.equal(note.props['max-lines'], undefined);
      assert.equal(b.css(card).height, undefined, 'generic card retains natural slot/content height');
      assert.equal(b.css(card).padding, '14px', 'existing 288px Frame column keeps 258px QtCard inner budget');
      assert.ok(px(b, b.button('原有插槽动作'), 'min-height') >= 56, 'existing QtButton remains slot action owner');
      await b.dispatch(b.button('原有插槽动作')); assert.equal(clicks, 1, 'default slot action passes through once, no invented card event');
      b.tv.qtSetTvMode('touch'); await b.flush();
      assert.equal(b.css(heading)['line-height'], undefined); assert.equal(b.css(note)['line-height'], undefined);
      assert.equal(b.css(heading)['align-self'], undefined); assert.equal(b.css(note)['align-self'], undefined);
      assert.equal(b.css(card).padding, '17.92px', 'known original 480px compact padding');
      assert.deepEqual(b.runtimeErrors, []); assert.equal(b.warnings.length, 0);
    } finally { await b.close(); }
  }
};

cases['feedback-full-template-tap'] = async () => {
  const title = '完整反馈标题不能截掉：播放列表滚动之后仍然希望遥控器准确选中原有反馈', content = '原始反馈内容保留全部说明文字，不把电视阅读改成一行摘要。'.repeat(12);
  for (const inColumn of [false, true]) for (const tier of ['tiny', 'small', 'normal', 'large', 'huge']) {
    const b = await documentFixture({ width:480, height:360, initialStorage:{ 'qt-ui-font-scale':tier } }); let taps = 0;
    try {
      await b.mount('../_tmp/tv-documents/feedback-host.uvue', { title, content, typeText:'功能建议', typeColor:'#6d7fd8', statusText:'待处理', statusColor:'#5b8b68', timeText:'2026-11-15 10:00', showPublic:true, inColumn, onTap:() => { taps++; } });
      const card = b.byClass('fb-item')[0], heading = b.byClass('fb-title')[0], body = b.byClass('fb-content')[0];
      assert.equal(textOf(heading), title); assert.equal(textOf(body), content);
      assert.equal(b.css(b.byClass('fb-head')[0])['flex-direction'], 'column', 'TV badges and long title have separate native lines, not a compressed inline row');
      assert.equal(heading.props['max-lines'], undefined, 'TV title remains complete'); assert.equal(body.props['max-lines'], undefined, 'TV content remains complete');
      assert.ok(px(b, card, 'min-height') >= 56, 'existing tap card is a TV-sized action');
      for (const name of ['type-badge-text','fb-title','status-badge-text','fb-content','fb-time','fb-public']) {
        const text = b.byClass(name)[0]; assert.ok(px(b, text, 'font-size') >= 20, name + ' floor20');
        assert.ok(px(b, text, 'line-height') >= px(b, text, 'font-size') * 1.3, name + ' has explicit actual-font native line');
      }
      assert.equal(b.css(heading)['margin-left'], '0px'); assert.equal(b.css(heading)['margin-right'], '0px');
      assert.equal(b.css(heading).flex, 'none'); assert.equal(b.css(b.byClass('fb-foot')[0])['flex-direction'], 'column');
      await b.dispatch(card, 'tap'); assert.equal(taps, 1, 'original public tap event retained once');
      b.tv.qtTvRefreshFocus(); await b.flush();
      const nativeId = [...b.candidates].find(([, node]) => node === card)?.[0]; assert.ok(nativeId, 'native collector sees actual tap action, not a decorative fallback');
      assert.equal(b.tv.qtTvFocus(nativeId), true); assert.equal(await remote(b, 'ok'), true); assert.equal(taps, 2);
      assert.equal(await remote(b, 'ok', 1), true); assert.equal(taps, 2, 'held OK consumes repeat without duplicate original tap');
      b.tv.qtSetTvMode('touch'); await b.flush();
      const touchTitle = b.byClass('fb-title')[0], touchBody = b.byClass('fb-content')[0];
      assert.equal(touchTitle.props['max-lines'], 1); assert.equal(touchBody.props['max-lines'], 2);
      assert.equal(b.css(b.byClass('fb-head')[0])['flex-direction'], undefined); assert.equal(b.css(card)['min-height'], undefined);
      assert.equal(b.css(touchTitle)['margin-left'], undefined); assert.equal(b.css(touchTitle)['line-height'], undefined);
      assert.deepEqual(b.runtimeErrors, []); assert.equal(b.warnings.length, 0);
    } finally { await b.close(); }
  }
};

cases['install-public-offer-document'] = async () => {
  const notes = '本次官方播放音源包发布说明：原有线路、格式与故障提示保持完整。'.repeat(45);
  const b = await installFixture({ notes, height:240 }), settled = [];
  try {
    await b.mount('../_tmp/tv-documents/install-host.uvue', { onSettled:result => settled.push(result) });
    await b.dispatch(b.button('打开播放包安装引导')); await b.flush();
    assert.ok(b.byClass('qpis-body').length === 1, 'real original global service offer opens original component within production Frame');
    assert.deepEqual(settled, []); assert.equal(textOf(b.byClass('qpis-info-notes')[0]), notes, 'real parsed manifest notes appear unchanged');
    const body = b.byClass('qpis-body')[0];
    assert.equal(body.tag, 'scroll-view'); assert.ok(classes(body).includes('qt-tv-scroll'), 'TV release notes/actions have an actual remotely scrollable native document');
    assert.ok(px(b, body, 'height') >= 40, '240px huge-font TV keeps positive document viewport by scrolling actions with the notes');
    assert.equal(b.byClass('qpis-info-notes')[0].props['max-lines'], undefined, 'TV notes are not truncated to four lines');
    for (const label of ['立即安装','手动管理']) {
      const action = b.button(label), child = walk(action).find(node => classes(node).includes('qt-button-label'));
      assert.ok(walk(body).includes(action), 'original ' + label + ' travels within the native document, not an overflowing footer');
      assert.ok(px(b, action, 'min-height') >= 56); assert.equal(b.css(action).height, 'auto'); assert.equal(b.css(action)['align-self'], 'stretch');
      assert.ok(px(b, child, 'line-height') >= px(b, child, 'font-size') * 1.3);
    }
    for (const name of ['qpis-desc','qpis-info-title','qpis-info-notes']) {
      const text = b.byClass(name)[0]; assert.ok(text, 'original ' + name + ' text node'); assert.ok(px(b, text, 'font-size') >= 20);
      assert.ok(px(b, text, 'line-height') >= px(b, text, 'font-size') * 1.4, name + ' actual font/native line');
    }
    b.tv.qtTvRefreshFocus(); await b.flush();
    assert.equal(b.tv.qtTvFocus('native:custom:play-install-document'), true); assert.equal(await remote(b, 'down'), true);
    assert.deepEqual(b.scrolls.at(-1), ['native:custom:play-install-document','down'], 'remote direction reaches actual native document scroll SDK');
    b.clock.advance(90); await remote(b, 'up');
    assert.deepEqual(b.scrolls.at(-1), ['native:custom:play-install-document','up'], 'remote up also reaches the actual native document SDK');
    assert.equal(b.tv.qtTvFocus('native:custom:play-install-manual'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.deepEqual(settled, ['dismissed']); assert.deepEqual(b.routes, [{ action:'navigate', url:'/pages/source-pack/index' }]); assert.equal(b.byClass('qpis-body').length, 0);
    const manifest = b.network.find(call => call.url.includes('/source/manifest'));
    assert.ok(manifest.url.includes('platform=1') && manifest.url.includes('hostApiVersion=1') && manifest.url.includes('appVersionCode=1'));
    for (const name of ['X-App-Ut','X-App-Version','X-Device','X-OS']) assert.ok(manifest.header[name], 'original astral ' + name + ' retained');
    assert.deepEqual(b.runtimeErrors, []); assert.equal(b.warnings.length, 0);
  } finally { await b.close(); }
  assert.deepEqual(b.compilerReceipts, ['exact-uts-json-restored','exact-uts-json-restored','exact-getString-descriptor-restored','exact-getNumber-descriptor-restored','exact-getBoolean-descriptor-restored']);
};

const playPackText = (overrides = {}, signed = true) => {
  const header = { kind:'play', id:'play-official', name:'官方播放包', versionCode:7, versionName:'7.0', updateUrl:'', ...overrides };
  const content = '/*__QT_PACK__' + JSON.stringify(header) + '*/\nexport function __qtPlayPackFactory() { return {}; }\n';
  return content + (signed ? '/*__QT_SIGN__' + JSON.stringify({ alg:'ed25519', sig:'A'.repeat(86) + '==' }) + '*/' : '');
};
const smokeSong = { id:'original-smoke-id', name:'原始候选曲目', singer:'原始歌手', album:'原始专辑', duration:180, picUrl:'' };
function smokeEngineReply(name) {
  if (name === 'sourceRegistry') return { sourcePolicyVersion:1, sources:[{ id:'kw', name:'候选源', short:'kw', color:'#777777' }], qualities:[{ id:'128', name:'128K', description:'' }] };
  if (name === 'search') return { list:[smokeSong] };
  if (name === 'getPlayUrl') return { url:'https://owned-audio.invalid/smoke.mp3', actualQuality:'128' };
  if (name === 'verifyPlayable') return { ok:true };
}
async function microtasksUntil(b, predicate, label) {
  for (let i = 0; i < 30 && !predicate(); i++) await b.flush();
  assert.ok(predicate(), label);
}

cases['install-public-busy-success'] = async () => {
  let pendingDownload = null, background = 0;
  const b = await installFixture({ height:360, engineReply:smokeEngineReply, downloadHandler:options => { pendingDownload = options; } }), settled = [];
  try {
    await b.mount('../_tmp/tv-documents/install-host.uvue', { onSettled:result => settled.push(result), onBackground:() => { background++; } });
    await b.dispatch(b.button('打开播放包安装引导')); await microtasksUntil(b, () => b.byClass('qpis-body').length === 1, 'public offer visible');
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('native:custom:play-install-now'), true);
    await remote(b, 'ok'); await microtasksUntil(b, () => pendingDownload != null, 'original pickSmokeSongs and applyUpdate reached native download boundary');
    assert.deepEqual(settled, []); assert.equal(b.downloads.length, 1);
    assert.ok(classes(b.button('立即安装')).includes('qt-button-disabled')); assert.ok(classes(b.button('手动管理')).includes('qt-button-disabled'));
    assert.equal(b.byClass('qs-close').length, 0, 'busy original Sheet dismissible contract removes close');
    assert.equal(await remote(b, 'ok', 1), true); assert.equal(await remote(b, 'back'), true); assert.equal(await remote(b, 'back', 1), true);
    await b.dispatch(b.byClass('qs-mask')[0]); await b.dispatch(b.button('手动管理')); await b.dispatch(b.button('立即安装'));
    assert.deepEqual(settled, []); assert.equal(b.downloads.length, 1); assert.equal(background, 0); assert.deepEqual(b.routes, []);
    assert.ok(b.nativeBoundary.calls.some(call => call.name === 'loadBundle'), 'real original data engine loaded installed meta through native callback');
    assert.deepEqual(b.nativeBoundary.calls.find(call => call.name === 'search')?.args[0], { source:'kw', keyword:'晴天', page:1, size:5 }, 'original public service picks source/search candidate, not synthetic smoke bypass');
    assert.equal(pendingDownload.url, 'https://owned-artifact.invalid/play.js'); assert.equal(pendingDownload.header, undefined, 'third-party download has no astral client headers');
    b.nativeBoundary.files.set('/owned-documents/download.tmp', playPackText()); pendingDownload.success({ statusCode:200, tempFilePath:'/owned-documents/download.tmp' });
    await microtasksUntil(b, () => settled.length > 0, 'original transactional install completes service promise');
    assert.deepEqual(settled, ['installed']); assert.equal(b.byClass('qpis-body').length, 0); assert.equal(background, 0);
    assert.equal(b.nativeBoundary.calls.filter(call => call.name === 'signature').length, 1);
    assert.equal(b.nativeBoundary.calls.filter(call => call.name === 'loadPlayBundle').length, 1);
    assert.equal(b.nativeBoundary.calls.find(call => call.name === 'getPlayUrl')?.args[0].id, 'original-smoke-id');
    assert.deepEqual(b.nativeBoundary.calls.find(call => call.name === 'verifyPlayable')?.args[0], { url:'https://owned-audio.invalid/smoke.mp3' });
    assert.equal(b.load('services/source-bundle-fs.uts').activePack().id, 'play-official');
    assert.equal(b.load('services/source-bundle-fs.uts').activePack().signVerified, true);
    assert.equal(b.load('services/source-engine.uts').playPackReady(), true);
    assert.ok(b.toastCalls.at(-1).title.includes('已安装并生效'), 'original installer result surfaced unchanged');
    assert.equal(b.nativeCalls.filter(call => call[0] === 'loading-show').length, b.nativeCalls.filter(call => call[0] === 'loading-hide').length, 'original loading tokens settle in pairs');
    assert.deepEqual(b.runtimeErrors, []); assert.equal(b.warnings.length, 0);
  } finally { await b.close(); }
};

cases['install-public-failures-rollback'] = async () => {
  for (const scenario of ['download','wrong-header','unsigned','bad-signature','write','smoke']) {
    const options = {
      engineReply:(name, ...rest) => scenario === 'smoke' && name === 'getPlayUrl' ? { url:'' } : smokeEngineReply(name, ...rest),
      signReply:scenario === 'bad-signature' ? reply => reply({ ok:true, value:'mismatch', error:'' }) : null,
      fileReply:scenario === 'write' ? (operation, path, value, reply) => { if (operation === 'write' && path.includes('/play-official/play-bundle.js')) { reply(false, '', 'owned storage write failure'); return 'HELD'; } } : null,
      downloadHandler(options, native) {
        if (scenario === 'download') { options.fail({ errMsg:'owned download failure' }); return; }
        native.files.set('/owned-documents/download.tmp', playPackText(scenario === 'wrong-header' ? { versionCode:6 } : {}, scenario !== 'unsigned'));
        options.success({ statusCode:200, tempFilePath:'/owned-documents/download.tmp' });
      },
    };
    const b = await installFixture(options), settled = [];
    try {
      await b.mount('../_tmp/tv-documents/install-host.uvue', { onSettled:result => settled.push(result) });
      await b.dispatch(b.button('打开播放包安装引导')); await b.flush();
      await b.dispatch(b.button('立即安装')); await microtasksUntil(b, () => b.toastCalls.length > 0, scenario + ' original failure toast');
      assert.deepEqual(settled, [], scenario + ' leaves original promise open for retry/manual');
      assert.equal(b.byClass('qpis-body').length, 1); assert.ok(!classes(b.button('立即安装')).includes('qt-button-disabled'));
      assert.equal(b.load('services/source-bundle-fs.uts').activePack(), null, scenario + ' never leaves failed official pack active');
      const toast = b.toastCalls.at(-1).title, signatures = b.nativeBoundary.calls.filter(call => call.name === 'signature'), loads = b.nativeBoundary.calls.filter(call => call.name === 'loadPlayBundle');
      if (scenario === 'download') { assert.ok(toast.includes('下载失败')); assert.equal(signatures.length, 0); }
      if (scenario === 'wrong-header') { assert.ok(toast.includes('文件头与发现的版本不符')); assert.equal(signatures.length, 0); }
      if (scenario === 'unsigned') { assert.ok(toast.includes('文件缺少有效的官方签名')); assert.equal(signatures.length, 0); }
      if (scenario === 'bad-signature') { assert.ok(toast.includes('签名不匹配')); assert.equal(signatures.length, 1); }
      if (scenario === 'write') { assert.ok(toast.includes('落盘失败')); assert.equal(signatures.length, 1); }
      if (scenario !== 'smoke') assert.equal(loads.length, 0, scenario + ' does not execute rejected play body');
      else {
        assert.ok(toast.includes('已回滚到 未安装')); assert.equal(loads.length, 1);
        assert.ok(b.nativeBoundary.calls.filter(call => call.name === 'getPlayUrl').length >= 2, 'real original smoke tries candidate twice');
        assert.equal(b.load('services/source-engine.uts').playPackReady(), false);
        assert.equal(b.load('services/source-bundle-fs.uts').isPackBadVersion('play-official', 7), false, 'original first-install rollback removes the pack row; markPackBad has no retained row to tag');
        const report = b.network.find(call => call.url.includes('/source/report')); assert.ok(report); assert.equal(report.data.get('result'), 'smoke_failed');
      }
      b.tv.qtTvRefreshFocus(); assert.equal(await remote(b, 'back'), true); assert.equal(await remote(b, 'back', 1), true);
      assert.deepEqual(settled, ['dismissed']); assert.equal(b.byClass('qpis-body').length, 0); assert.deepEqual(b.routes, []);
      assert.equal(b.nativeCalls.filter(call => call[0] === 'loading-show').length, b.nativeCalls.filter(call => call[0] === 'loading-hide').length);
      assert.deepEqual(b.runtimeErrors, []); assert.equal(b.warnings.length, 0);
    } finally { await b.close(); }
  }
};

cases['guide-public-modal-document'] = async () => {
  const b = await documentFixture({ width:480, height:360, initialStorage:{ 'qt-ui-font-scale':'huge' } });
  let go = 0, dismiss = 0, background = 0;
  try {
    await b.mount('../_tmp/tv-documents/guide-host.uvue', { onGo:() => { go++; }, onDismiss:() => { dismiss++; }, onBackground:() => { background++; } });
    b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvFocus('native:custom:fixture-open-guide'), true);
    await remote(b, 'ok'); await b.flush();
    b.tv.qtTvRefreshFocus();
    assert.equal(b.tv.qtTvHasModal(), true, 'visible original metadata guide owns TV modal before page navigation');
    const panel = b.byClass('mg-card')[0], document = b.byClass('mg-tv-document')[0];
    assert.equal(b.collectedRoots.at(-1), Vue.toRaw(panel), 'actual guide panel ref, not mask or a synthetic missing ref, is native modal root');
    assert.equal(document.tag, 'scroll-view'); assert.ok(classes(document).includes('qt-tv-scroll'));
    assert.ok(px(b, document, 'height') > 100 && px(b, document, 'height') <= 304, '480x360 huge guide leaves pane gutters and positive native document budget');
    assert.equal(b.css(panel).padding, '0px'); assert.equal(b.css(panel).width, '424px');
    assert.equal(textOf(b.byClass('mg-title')[0]), '安装数据包，启用在线功能');
    assert.equal(textOf(b.byClass('mg-sub')[0]), '在线搜索 · 歌单 · 歌词 · 封面');
    assert.equal(textOf(b.byClass('mg-body')[0]), '应用未内置数据包：需在「音源包管理」页安装一次，支持从链接或本地文件安装。未安装时在线功能不可用（搜索/歌单/歌词/在线播放），本地音乐播放不受影响。');
    for (const name of ['mg-title','mg-sub','mg-body']) {
      const text = b.byClass(name)[0]; assert.ok(px(b, text, 'font-size') >= 20); assert.ok(px(b, text, 'line-height') >= px(b, text, 'font-size') * 1.4);
      assert.equal(b.css(text)['align-self'], 'stretch'); assert.equal(text.props['max-lines'], undefined);
    }
    assert.equal(b.css(b.byClass('mg-divider')[0]).width, '380px', 'divider fits the real 424px panel minus two 22px document gutters');
    for (const label of ['暂不','去安装']) {
      const button = b.button(label); assert.ok(walk(document).includes(button)); assert.ok(px(b, button, 'min-height') >= 56);
      assert.equal(b.css(button).height, 'auto'); assert.equal(b.css(button)['align-self'], 'stretch');
    }
    assert.equal(b.tv.qtTvFocus('native:custom:fixture-guide-background'), false, 'visible guide isolates original background action');
    assert.equal(b.tv.qtTvFocus('native:custom:meta-guide-document'), true); await remote(b, 'down'); b.clock.advance(90); await remote(b, 'up');
    assert.deepEqual(b.scrolls.slice(-2), [['native:custom:meta-guide-document','down'],['native:custom:meta-guide-document','up']]);
    assert.equal(b.tv.qtTvFocus('native:custom:meta-guide-go'), true); await remote(b, 'ok'); await remote(b, 'ok', 1);
    assert.equal(go, 1); assert.equal(dismiss, 0); assert.equal(background, 0); assert.deepEqual(b.routes, []); assert.equal(b.network.length, 0, 'guide remains original emit-only, no invented installer/download/route');
    await remote(b, 'back'); await remote(b, 'back', 1);
    assert.equal(dismiss, 1); assert.equal(b.byClass('mg-card').length, 0); assert.equal(b.tv.qtTvHasModal(), false);
    assert.equal(b.tv.qtTvFocusedId(), 'native:custom:fixture-open-guide', 'original opener focus is restored by shared modal');
    await b.dispatch(b.button('打开数据包指路')); await b.dispatch(b.byClass('mg-card')[0]); assert.equal(dismiss, 1, 'original card click.stop does not dismiss through mask');
    await b.dispatch(b.byClass('mg-mask')[0]); assert.equal(dismiss, 2, 'original mask emits dismiss exactly once');
    assert.deepEqual(b.runtimeErrors, []); assert.equal(b.warnings.length, 0);
  } finally { await b.close(); }
};

cases['guide-tv-touch-lifecycle'] = async () => {
  for (const tier of ['tiny','small','normal','large','huge']) {
    const b = await documentFixture({ width:480, height:360, initialStorage:{ 'qt-ui-font-scale':tier } }); let go = 0, dismiss = 0;
    try {
      await b.mount('../_tmp/tv-documents/guide-host.uvue', { removeOnDismiss:true, onGo:() => { go++; }, onDismiss:() => { dismiss++; } });
      await b.dispatch(b.button('打开数据包指路')); b.tv.qtTvRefreshFocus(); assert.equal(b.tv.qtTvHasModal(), true);
      for (const name of ['mg-title','mg-sub','mg-body']) { const text = b.byClass(name)[0]; assert.ok(px(b, text, 'font-size') >= 20); assert.ok(px(b, text, 'line-height') >= px(b, text, 'font-size') * 1.4); }
      assert.equal(b.css(b.byClass('mg-card')[0]).width, '424px'); assert.equal(b.css(b.byClass('mg-tv-document')[0]).height, '304px');
      b.tv.qtTvFocus('native:custom:meta-guide-dismiss'); b.tv.qtSetTvMode('touch'); await b.flush();
      assert.equal(b.tv.qtTvHasModal(), false); assert.equal(b.byClass('mg-tv-document').length, 0);
      assert.equal(b.css(b.byClass('mg-card')[0]).width, '384px', 'same-mounted touch recovers original 600rpx preferred width');
      assert.equal(b.css(b.byClass('mg-card')[0]).padding, undefined); assert.equal(b.css(b.byClass('mg-title')[0])['line-height'], undefined);
      assert.equal(b.byClass('mg-actions').length, 1); assert.equal(b.css(b.button('暂不'))['min-height'], undefined); assert.equal(b.css(b.button('暂不')).height, undefined, 'original touch button keeps its existing rpx class height, not a TV inline height');
      await b.dispatch(b.button('去安装')); assert.equal(go, 1); assert.equal(dismiss, 0); assert.equal(b.byClass('mg-card').length, 1, 'original go remains emit-only and does not secretly dismiss');
      b.tv.qtSetTvMode('tv'); await b.flush(); b.tv.qtTvRefreshFocus();
      for (const hide of b.lifecycle.hide) await hide(); await b.flush(); assert.equal(await remote(b, 'back'), false, 'hidden host cannot consume Back');
      for (const show of b.lifecycle.show) await show(); b.tv.qtSetTvMode('tv'); await b.flush(); b.tv.qtTvRefreshFocus();
      assert.equal(b.tv.qtTvHasModal(), true); assert.equal(b.tv.qtTvFocus('native:custom:meta-guide-dismiss'), true);
      await remote(b, 'ok'); await remote(b, 'ok', 1); assert.equal(dismiss, 1); assert.equal(b.byClass('mg-card').length, 0); assert.equal(b.tv.qtTvHasModal(), false, 'unmounted original guide releases its modal scope');
      assert.deepEqual(b.routes, []); assert.deepEqual(b.runtimeErrors, []); assert.equal(b.warnings.length, 0);
    } finally { await b.close(); }
    assert.equal(b.tv.qtTvHasModal(), false, 'full host teardown leaves no guide scope');
  }
};

export async function runDocumentCases(names = Object.keys(cases)) {
  for (const name of names) { assert.ok(cases[name], 'known document group: ' + name); await cases[name](); console.log('PASS ' + name); }
}
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  await runDocumentCases(process.argv.slice(2).length ? process.argv.slice(2) : undefined);
  console.log('PASS full production document components / public business + native-remote seam');
}
