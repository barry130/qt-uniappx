// Executes the complete platform-management page, source-policy/aggregate/auth/
// quality services, registry and MusicApi. Only native engine/package I/O, uni
// lifecycle/storage/events and unrelated UI/player adapters are owned fixtures.
// Uses real Vue computed caching; no copied policy logic or fake disposal hooks.
// Offline checks do not prove HBuilderX/Vapor compilation or real-account QA.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as Vue from 'vue';
import { compile } from '@vue/compiler-dom';
import ts from 'typescript';
import { read, load, host, parseJsonToUtso, drain } from './check-source-auth-session.mjs';
import { sourcePolicyFixture } from './source-policy-fixture.mjs';
import { reorderFixture, compileReorderSfc, runReorderChecks } from './check-reorder-list.mjs';
import { runAggregateChecks } from './check-aggregate-sources.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const ids = rows => Array.from(rows, row => row.id);
const exported = text => [...text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)].map(match => match[1]);
const actual = (path, scope) => { const text = read(path); return load(text, exported(text), scope); };
const quiet = () => {};
const forbidden = () => { throw new Error('live network/playback is forbidden in this regression'); };
const user = { id: 'owned-account', nickname: 'Fixture listener', avatar: '', vip: false, vipLabel: '' };
const source = (id, name) => ({ id, name, short: name, color: '#6688aa',
  playlists: true, artist: true, album: true, charts: true, qualities: ['128', '320'],
  auth: { methods: ['qrcode', 'cookie', 'sms', 'password'], domains: [],
    webLogin: { url: 'https://fixture.invalid/login', cookieMarkers: [], note: '', captureUrls: [] } } });
const qualities = [{ id: '128', name: '标准 128k' }, { id: '320', name: '高品 320k' }];
const POLICY_PATH = 'services/source-policy.ts';
const AGGREGATE_KEY = 'qt-search-aggregate-sources';
const PAGE_PATH = 'pages/source-auth/index.uvue';
const PAGE_NAMES = ['musicSourceRows', 'enabledMusicSources', 'disabledMusicSources', 'policyMessage',
  'policySaving', 'changeMusicSource', 'toggleMusicSource', 'moveMusicSource', 'agRows', 'agAllSelected',
  'agSummary', 'agUseAll', 'agToggle', 'refreshTick', 'refreshFromStorage', 'sourceCards', 'authEmptyText',
  'qualitySheetActions', 'qualitySheetIds', 'qualitySheetSelectedIndex', 'showQualitySheet',
  'onQualitySheetSelect', 'accTrackWidth', 'expandedIds', 'toggleAllCards'];
// The approved seam observes the real page bindings and compiled template. It
// exports declarations only to provide the component setup context to the host.
const pageScript = read(PAGE_PATH).match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
const pageAst = ts.createSourceFile('source-auth.ts', pageScript, ts.ScriptTarget.Latest, true);
for (const node of pageAst.statements) {
  if (ts.isFunctionDeclaration(node) && node.name != null) PAGE_NAMES.push(node.name.text);
  if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name)) PAGE_NAMES.push(declaration.name.text);
  }
}
const publicPageNames = [...new Set(PAGE_NAMES)];
const pageSource = read(PAGE_PATH);
const template = pageSource.slice(pageSource.indexOf('<template>') + 10, pageSource.lastIndexOf('</template>', pageSource.indexOf('<script setup')));
const compilePageRender = components => new Function('Vue', compile(template, { mode: 'function',
  isCustomElement: tag => !['qt-reorder-list', 'QtReorderList', 'qt-action-sheet', 'QtActionSheet', ...Object.keys(components)].includes(tag),
}).code)({ ...Vue, resolveComponent: name => components[name] ?? ({ name, render: () => null }) });
const renderPage = compilePageRender({});
const descendants = node => node == null || typeof node !== 'object' ? [] : [node,
  ...(Array.isArray(node.children) ? node.children.flatMap(descendants) : [])];
const byClass = (node, name) => descendants(node).filter(item => String(item.props?.class ?? '').split(' ').includes(name));
const textOf = node => typeof node?.children === 'string' ? node.children :
  Array.isArray(node?.children) ? node.children.map(textOf).join('') : '';
const ctxOf = (page, extra = {}) => new Proxy({ ...page, qtFontDual: () => '', ...extra }, { get: (target, key) => Vue.unref(target[key]) });
const rendered = b => renderPage(ctxOf(b.page), []);
const publicReorder = b => descendants(rendered(b)).find(node => ['qt-reorder-list', 'QtReorderList'].includes(node.type?.name ?? node.type));
const publicCard = (b, id) => {
  const list = publicReorder(b), index = list.props.items.findIndex(item => item.id === id);
  assert.ok(index >= 0, 'a public platform card exists');
  const handle = { style: '', start: quiet, move: quiet, end: quiet, cancel: quiet, click: quiet };
  return { children: list.children.default({ id, index, handle }) };
};
const changeCardSwitch = async (b, id, className) => {
  const card = publicCard(b, id), row = byClass(card, className)[0];
  assert.ok(row, 'the setting is inside the platform card: ' + className);
  const toggle = descendants(row).find(node => ['QtSwitch', 'qt-switch'].includes(node.type?.name ?? node.type));
  assert.ok(toggle, 'the public control is the shared switch');
  assert.equal(toggle.props.disabled, false, 'this card setting is enabled');
  await toggle.props.onChange(!toggle.props['model-value']); await drain();
};

async function fixture({ initialPolicy = null, installed = true, legacy = false, wide = false, initialQuality = null } = {}) {
  const b = host();
  const listeners = new Map(), subscriptions = [];
  b.uni.$on = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn); subscriptions.push({ op: 'on', name, fn });
  };
  b.uni.$off = (name, fn) => { listeners.get(name)?.delete(fn); subscriptions.push({ op: 'off', name, fn }); };
  b.uni.$emit = (name, ...args) => {
    b.events.push([name, ...args]);
    for (const fn of [...(listeners.get(name) ?? [])]) fn(...args);
  };
  b.uni.request = forbidden;
  b.storage.set('qt-source-auth-schema', '3');
  b.storage.set('qt-source-play-quality-schema', '3');
  // 网络面别拆分回归用：模块装载（迁移）前预置音质存储
  if (initialQuality != null) for (const [seedKey, seedValue] of Object.entries(initialQuality)) b.storage.set(seedKey, seedValue);
  const key = read(POLICY_PATH).match(/SOURCE_POLICY_KEY\s*=\s*"([^"]+)"/)[1];
  if (initialPolicy != null) b.storage.set(key, typeof initialPolicy === 'string' ? initialPolicy : JSON.stringify(initialPolicy));
  const policy = sourcePolicyFixture(b.uni);
  const state = { running: false, context: null, calls: [], held: [], policyMode: 'accept',
    playSupported: null, installed, legacy,
    catalog: [source('wyy', '网易云'), source('qq', 'QQ音乐'), source('kw', '酷我')],
    aggregateReply: { batches: [] }, ensureCalls: 0 };
  const finish = (callback, value) => callback({ ok: true, value: JSON.stringify(value), error: '' });
  const metaPack = { id: 'meta-fixture', kind: 'meta', versionCode: 1, updatedAt: 1000 };
  const packages = {
    activePack: () => null, activeMetaPack: () => state.installed ? metaPack : null,
    ensureLocalStateRestored: async () => { state.ensureCalls++; },
    readPackArtifact: async () => '/*__QT_PACK__{"kind":"meta","id":"meta-fixture","name":"Owned metadata","versionCode":1,"versionName":"1"}*/\n// owned native package adapter',
    ARTIFACT_CHAIN: 'chain.json', ARTIFACT_PLAY: 'play-bundle.js', ARTIFACT_META: 'meta-bundle.js', PACK_KIND_META: 'meta',
    packs: () => state.installed ? [metaPack] : [], localState: () => ({ activeId: '', activeMetaId: state.installed ? metaPack.id : '' }),
  };
  const native = {
    start(_options, callback) {
      state.running = true; state.context = vm.createContext({ __qtHost: { request: forbidden } });
      callback({ engine: 'webview-v8', version: 'owned-fixture', hostApiVersion: 1, probe: '2' }, null);
    },
    stop(callback) { state.running = false; callback({ ok: true, error: '' }); },
    isRunning: () => state.running, isHealthy: () => state.running,
    evaluate(code, callback) {
      try { vm.runInContext(code, state.context); callback({ ok: true, value: 'null', error: '' }); }
      catch (error) { callback({ ok: false, value: '', error: error.message }); }
    },
    loadBundle(_text, callback) {
      state.context.__qtEntries = state.legacy ? {} : { setSourcePolicy: quiet };
      callback({ ok: true, error: '' });
    },
    loadPlayBundle: forbidden,
    invoke(name, args, _timeout, callback) {
      const parsed = JSON.parse(args); state.calls.push({ name, args: parsed });
      if (name === 'bundleInfo') return finish(callback, { name: 'meta-bundle', hostApiVersion: 1, sourcePolicyVersion: state.legacy ? 0 : 1 });
      if (name === 'setSourcePolicy') {
        if (state.policyMode === 'hold') { state.held.push(callback); return; }
        if (state.policyMode === 'reject') return callback({ ok: false, value: '', error: 'owned policy transport failed' });
        return finish(callback, { ok: state.policyMode !== 'bad-ack', playSupported: state.playSupported });
      }
      if (name === 'sourceRegistry') return finish(callback, { sources: state.catalog, qualities, sourcePolicyVersion: state.legacy ? 0 : 1 });
      if (name === 'getSourceQualities') return finish(callback, { mode: 'platform', qualities: [], aliases: {} });
      if (name === 'authUser') return finish(callback, { ok: true, user });
      if (name === 'setAuth' || name === 'clearAuth') return finish(callback, { ok: true });
      if (name === 'searchAll') return finish(callback, state.aggregateReply);
      throw new Error('unexpected native entry: ' + name);
    },
  };
  const scope = { ...b.vue, uni: b.uni, ...packages, ...native,
    logErr: quiet, logErrV: quiet, logInfo: quiet, logWarn: quiet, logWarnV: quiet };
  const utsJSON = { parse: parseJsonToUtso, stringify: JSON.stringify };
  const header = actual('services/source-pack-header.uts', { ...scope, JSON: utsJSON });
  const engine = actual('services/source-engine.uts', { ...scope, ...header, JSON: utsJSON });
  const auth = actual('services/source-auth.ts', { ...scope, ...engine });
  const network = actual('services/network-kind.ts', scope);
  const quality = actual('services/source-quality.ts', { ...scope, ...engine, ...auth, ...network });
  const ttl = actual('services/ttl-store.ts', scope);
  const music = actual('services/music-api.ts', { ...scope, ...engine, ...auth, ...quality, ...ttl,
    apiRequest: forbidden, resolveUrl: value => value, isLoggedIn: () => false, qtDiag: quiet,
    readSongEmbedded: async () => null, preferredSource: () => null,
    readLyricDisk: () => '', writeLyricDisk: quiet, removeLyricDisk: quiet, clearLyricDisk: quiet,
    mergeAggregateSongs: forbidden,
    ...actual('services/aggregate-sources.ts', scope),
  });
  const player = { savedPlaylists: [], quality: '320', play: forbidden, pause: forbidden, stop: forbidden };
  const downloads = { downloadQuality: '320' };
  const selection = Vue.reactive({ current: 'wyy', setSource(value) { this.current = value; } });
  const registryModule = actual('stores/source-registry.ts', { ...scope, ...engine, ...auth, ...quality, ...network,
    musicApi: music.musicApi, reactive: Vue.reactive, useSourceStore: () => selection,
    usePlayerStore: () => player, useDownloadsStore: () => downloads, SOURCE_PACKS_CHANGED_EVENT: 'qt-source-packs-changed',
  });
  const registry = registryModule.useSourceRegistryStore();
  await registry.ensure(); await drain();
  const aggregate = actual('services/aggregate-sources.ts', scope);
  const platform = actual('services/platform.ts', { ...scope, ...registryModule, PODCAST_PLATFORM: 'podcast' });
  const sync = actual('services/source-playlist-sync.ts', { ...scope, ...auth, usePlayerStore: () => player });
  const layout = Vue.reactive({ isWide: wide, windowWidth: wide ? 1067 : 390, windowHeight: 844, paneHeight: 780, safeBottomPx: 0 });
  const page = load(read(PAGE_PATH), publicPageNames, { ...scope, ...engine, ...auth, ...quality, ...network, ...aggregate, ...platform, ...sync,
    ref: Vue.ref, computed: Vue.computed, watch: Vue.watch, nextTick: Vue.nextTick, qtFontDual: () => '', useSourceRegistryStore: () => registry,
    usePlayerStore: () => player, useDownloadsStore: () => downloads,
    useThemeStore: () => ({ skin: { text: '#111111', textMuted: '#667788', divider: '#ddeeff', accent: '#cc3344' } }),
    useQtLayout: () => layout, supportsNativeAuthWebView: () => true, saveImageToGallery: forbidden,
    useQtSelectionReveal: () => ({ anchor: Vue.ref(''), itemId: index => 'owned-selection-' + index }),
    qtConfirm: async () => false, WEB_LOGIN_DONE_EVENT: 'qt-web-login-done',
  });
  for (const callback of b.hooks.load) callback();
  const replyPolicy = (ok = true, nextMode = 'accept') => {
    state.policyMode = nextMode;
    for (const callback of state.held.splice(0)) finish(callback, { ok, playSupported: state.playSupported });
  };
  return { ...b, page, policy, engine, auth, quality, aggregate, registry, music: music.musicApi,
    key, state, replyPolicy, listeners, subscriptions, selection, layout,
    policyCalls: () => state.calls.filter(call => call.name === 'setSourcePolicy'),
    eventCount: name => b.events.filter(event => event[0] === name).length,
  };
}

const mountedNodes = root => [root, ...root.children.flatMap(mountedNodes)];
const mountedClass = (root, name) => mountedNodes(root).filter(node => String(node.props.class ?? '').split(/\s+/).includes(name));
const mountedText = node => (node.text ?? '') + node.children.map(mountedText).join('');
const mountedCard = (view, id) => mountedClass(view.root, 'src-card').find(node =>
  mountedClass(node, 'src-name')[0]?.text === ({ wyy: '网易云', qq: 'QQ音乐', kw: '酷我' }[id] ?? id));
async function mountedPage(b) {
  const view = await reorderFixture({ width: b.layout.windowWidth, height: b.layout.windowHeight, top: 50, gap: 12,
    consumerComponentFactory(scope) {
      const uiScope = { ...scope, ...actual('uni_modules/qt-ui/composables/selection.ts', scope) };
      const components = { 'qt-reorder-list': scope.QtReorderList };
      for (const name of ['qt-card', 'qt-switch']) components[name] = compileReorderSfc(
        read(`uni_modules/qt-ui/components/${name}/${name}.uvue`), name + '.uvue', uiScope);
      const render = compilePageRender(components);
      const realLayout = scope.useQtLayout();
      return { name: 'ActualPlatformManagementPage', setup() {
        const context = ctxOf(b.page, { layout: realLayout, qtFontDual: scope.qtFontDual });
        return () => render(context, []);
      } };
    } });
  function setHeights(values) {
    for (const row of view.rows()) {
      const name = mountedClass(row, 'src-name')[0]?.text;
      if (name != null && values[name] != null) view.heights[row.props.id] = values[name];
    }
  }
  setHeights({ '网易云': 80, 'QQ音乐': 190, '酷我': 110, gone: 90 });
  return { ...view, setHeights, card: id => mountedCard(view, id),
    cardHandle: id => mountedClass(mountedCard(view, id), 'src-drag-handle')[0],
    cardOrder: () => mountedClass(view.root, 'src-name').map(node => node.text),
    scroll: () => mountedClass(view.root, 'auth-scroll')[0] };
}

let passed = 0;
async function check(name, run) {
  if (process.env.SOURCE_PLATFORM_CASE != null && !name.includes(process.env.SOURCE_PLATFORM_CASE)) return;
  await run(); passed++; console.log('  ✓ ' + name);
}

await check('one ordered card list replaces the rejected three independent sections', async () => {
  const b = await fixture(), view = rendered(b), reorder = publicReorder(b);
  assert.ok(reorder, 'the actual page must expose one draggable platform-card list');
  assert.deepEqual(ids(reorder.props.items), ['wyy', 'qq', 'kw']);
  assert.equal(typeof reorder.props.onReorder, 'function');
  assert.equal(typeof reorder.props.onActive, 'function');
  assert.equal(descendants(view).some(node => node.props?.title === '音乐源' || node.props?.title === '聚合搜索音源'), false);
  const pack = read('pages/source-pack/index.uvue');
  assert.doesNotMatch(pack, /musicSourceRows|agRows|toggleMusicSource|moveMusicSource|agToggle|agUseAll|source-policy|aggregate-sources|\.policy-|\.ag-wrap/);
  assert.match(pack, /音源包管理/);
});
await check('public drop reorders the same account cards and saves one complete policy without changing credentials or quality', async () => {
  const b = await fixture();
  await b.auth.saveSourceAuthAccount('qq', 'owned-cookie', user, ''); await drain(); b.page.refreshFromStorage();
  const accounts = b.storage.get('qt-source-auth-accounts'), before = b.policyCalls().length;
  const reorder = publicReorder(b);
  reorder.props.onActive(true); assert.equal(byClass(rendered(b), 'auth-scroll')[0].props.direction, 'none');
  await reorder.props.onReorder(['kw', 'wyy', 'qq']); reorder.props.onActive(false); await drain();
  assert.deepEqual(ids(b.page.sourceCards.value), ['kw', 'wyy', 'qq']);
  assert.deepEqual(Array.from(b.policy.sourcePolicySnapshot().order), ['kw', 'wyy', 'qq']);
  assert.equal(b.policy.sourcePolicySnapshot().enabled, null, 'dragging is not platform enable configuration');
  assert.equal(b.policyCalls().length, before + 1);
  assert.equal(b.eventCount(b.policy.SOURCE_POLICY_CHANGED_EVENT), 1);
  assert.equal(b.storage.get('qt-source-auth-accounts'), accounts);
  assert.equal(b.quality.sourcePlayQualityOf('qq', 'unchanged'), 'unchanged');
  assert.equal(byClass(rendered(b), 'auth-scroll')[0].props.direction, 'vertical');
  for (const callback of b.hooks.show) callback(); await drain();
  assert.deepEqual(ids(publicReorder(b).props.items), ['kw', 'wyy', 'qq']);
});
await check('real page slot and shared touch handle reorder measured account cards, preserve unknown IDs and survive reentry on compact/wide', async () => {
  for (const wide of [false, true]) {
    const b = await fixture({ wide, initialPolicy: { version: 1, enabled: ['wyy', 'kw'], order: ['wyy', 'gone', 'qq', 'kw'] } });
    await b.auth.saveSourceAuthAccount('wyy', 'owned-cookie', user, ''); await drain(); b.page.refreshFromStorage();
    b.quality.setSourcePlayQuality('wyy', '128'); b.page.refreshFromStorage();
    const before = b.policyCalls().length, accounts = b.storage.get('qt-source-auth-accounts');
    const view = await mountedPage(b);
    try {
      assert.deepEqual(view.cardOrder(), ['网易云', 'QQ音乐', '酷我']);
      const handle = view.cardHandle('wyy');
      assert.equal(view.style(handle).width, '44px'); assert.equal(view.style(handle).height, '44px');
      await view.dispatch(handle, 'touchstart', { y: 80 });
      assert.equal(view.scroll().props.direction, 'none'); await view.reply();
      await view.dispatch(handle, 'touchmove', { y: 440 });
      assert.equal(view.preview().length, 1);
      assert.equal(view.style(view.preview()[0]).top, '324px', '190px + 110px neighbours and measured 12px gaps set the destination');
      assert.equal(view.style(mountedClass(view.card('wyy').parent, 'qrl-body')[0]).transform, 'translateY(360px)');
      await view.dispatch(handle, 'touchend', { y: 440 }); await drain(); await view.flush();
      assert.deepEqual(view.cardOrder(), ['QQ音乐', '酷我', '网易云']);
      assert.deepEqual(plain(b.policy.sourcePolicySnapshot()), { version: 1, enabled: ['wyy', 'kw'], order: ['qq', 'gone', 'kw', 'wyy'] });
      assert.equal(b.policyCalls().length, before + 1); assert.equal(b.storage.get('qt-source-auth-accounts'), accounts);
      assert.equal(b.quality.sourcePlayQualityOf('wyy', ''), '128'); assert.deepEqual(plain(b.page.expandedIds.value), []);
      assert.equal(view.scroll().props.direction, 'vertical');
      await view.dispatch(handle, 'click'); assert.deepEqual(plain(b.page.expandedIds.value), []);
      view.setHeights({ '网易云': 80, 'QQ音乐': 190, '酷我': 110 });
      const nextHandle = view.cardHandle('kw'), saved = b.storage.get(b.key), calls = b.policyCalls().length;
      await view.dispatch(nextHandle, 'touchstart', { y: 270 }); await view.reply();
      await view.dispatch(nextHandle, 'touchmove', { y: 80 }); await view.dispatch(nextHandle, 'touchcancel', { y: 80 });
      assert.equal(b.storage.get(b.key), saved); assert.equal(b.policyCalls().length, calls); assert.equal(view.scroll().props.direction, 'vertical');
      for (const callback of b.hooks.show) callback(); await drain(); await view.flush();
      assert.deepEqual(view.cardOrder(), ['QQ音乐', '酷我', '网易云']);
      const reentered = await fixture({ wide, initialPolicy: saved });
      assert.deepEqual(ids(publicReorder(reentered).props.items), ['qq', 'kw', 'wyy']);
    } finally { await view.unmount(); }
  }
});
await check('real in-card QtSwitch clicks reach platform and aggregate services without changing auth, quality or cancellation', async () => {
  for (const wide of [false, true]) {
    const b = await fixture({ wide });
    await b.auth.saveSourceAuthAccount('wyy', 'owned-cookie', user, ''); await b.auth.setSourceAuthToggle('wyy', 'meta', false);
    b.quality.setSourcePlayQuality('wyy', '128'); b.quality.setSourceDownloadQuality('wyy', '320'); await drain(); b.page.refreshFromStorage();
    const accounts = b.storage.get('qt-source-auth-accounts'), authToggles = b.storage.get('qt-source-auth-toggles-v3');
    const view = await mountedPage(b);
    try {
      await view.dispatch(mountedClass(view.card('wyy'), 'src-title')[0], 'click');
      const switchOf = (id, row) => mountedClass(mountedClass(view.card(id), row)[0], 'qsw')[0];
      assert.ok(switchOf('wyy', 'platform-toggle-row')); assert.ok(switchOf('wyy', 'aggregate-toggle-row'));
      const calls = b.policyCalls().length;
      await view.dispatch(switchOf('wyy', 'aggregate-toggle-row'), 'click');
      assert.deepEqual(plain(b.aggregate.readAggregateSources()), ['qq', 'kw']); assert.equal(b.policyCalls().length, calls);
      await view.dispatch(switchOf('wyy', 'platform-toggle-row'), 'click'); await drain(); await view.flush();
      assert.equal(b.policy.sourceEnabled('wyy'), false); assert.equal(b.policyCalls().length, calls + 1);
      const aggregateSaved = b.storage.get(AGGREGATE_KEY);
      await view.dispatch(switchOf('wyy', 'aggregate-toggle-row'), 'click');
      assert.equal(b.storage.get(AGGREGATE_KEY), aggregateSaved, 'disabled platform does not edit its saved participation intent');
      await view.dispatch(switchOf('wyy', 'platform-toggle-row'), 'click'); await drain(); await view.flush();
      assert.equal(b.policy.sourceEnabled('wyy'), true); assert.equal(b.page.sourceCards.value.find(row => row.id === 'wyy').aggregate, false);
      await view.dispatch(switchOf('wyy', 'aggregate-toggle-row'), 'click');
      assert.deepEqual(plain(b.aggregate.readAggregateSources()), ['qq', 'kw', 'wyy']);
      const originalWrite = b.uni.setStorageSync, tick = b.page.refreshTick.value, events = b.eventCount(b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT);
      b.uni.setStorageSync = (key, value) => { if (key === AGGREGATE_KEY) throw new Error('owned full disk'); return originalWrite(key, value); };
      await view.dispatch(switchOf('wyy', 'aggregate-toggle-row'), 'click');
      assert.deepEqual(plain(b.aggregate.readAggregateSources()), ['qq', 'kw', 'wyy']);
      assert.equal(b.eventCount(b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT), events); assert.equal(b.page.refreshTick.value, tick);
      assert.match(b.toasts.at(-1).title, /保存失败.*owned full disk/); b.uni.setStorageSync = originalWrite;
      assert.equal(b.storage.get('qt-source-auth-accounts'), accounts); assert.equal(b.storage.get('qt-source-auth-toggles-v3'), authToggles);
      assert.equal(b.quality.sourcePlayQualityOf('wyy', ''), '128'); assert.equal(b.quality.sourceDownloadQualityOf('wyy', ''), '320');
      const handle = view.cardHandle('wyy'), saved = b.storage.get(b.key), callsNow = b.policyCalls().length;
      await view.dispatch(handle, 'touchstart', { y: 80 }); await view.reply();
      await view.dispatch(handle, 'touchmove', { y: 440 }); await view.dispatch(handle, 'touchcancel', { y: 440 });
      assert.equal(b.storage.get(b.key), saved); assert.equal(b.policyCalls().length, callsNow);
      assert.deepEqual(plain(b.page.expandedIds.value), ['wyy']); assert.equal(view.scroll().props.direction, 'vertical');
    } finally { await view.unmount(); }
  }
});
await check('real dropped cards wait for engine acknowledgement and reject extra touch and switch saves', async () => {
  const b = await fixture(), view = await mountedPage(b);
  try {
    await view.dispatch(mountedClass(view.card('wyy'), 'src-title')[0], 'click');
    b.state.policyMode = 'hold'; const calls = b.policyCalls().length;
    const handle = view.cardHandle('wyy');
    await view.dispatch(handle, 'touchstart', { y: 80 }); await view.reply();
    await view.dispatch(handle, 'touchmove', { y: 440 }); await view.dispatch(handle, 'touchend', { y: 440 }); await drain(); await view.flush();
    assert.equal(b.state.held.length, 1); assert.equal(b.page.policySaving.value, true);
    assert.deepEqual(view.cardOrder(), ['QQ音乐', '酷我', '网易云']); assert.equal(view.scroll().props.direction, 'vertical');
    const saved = b.storage.get(b.key), revision = b.policy.sourcePolicyRevision(), aggregate = b.aggregate.readAggregateSources();
    await view.dispatch(view.cardHandle('qq'), 'touchstart', { y: 80 });
    assert.equal(view.replies.length, 0); assert.equal(view.scroll().props.direction, 'vertical');
    for (const row of ['platform-toggle-row', 'aggregate-toggle-row'])
      await view.dispatch(mountedClass(mountedClass(view.card('wyy'), row)[0], 'qsw')[0], 'click');
    assert.equal(b.storage.get(b.key), saved); assert.equal(b.policy.sourcePolicyRevision(), revision);
    assert.equal(b.aggregate.readAggregateSources(), aggregate); assert.equal(b.policyCalls().length, calls + 1);
    b.replyPolicy(); await drain(); await view.flush(); assert.equal(b.page.policySaving.value, false);
    await view.dispatch(view.cardHandle('qq'), 'touchstart', { y: 80 }); await view.reply();
    await view.dispatch(view.cardHandle('qq'), 'touchcancel'); assert.equal(view.scroll().props.direction, 'vertical');
  } finally { b.replyPolicy(); await drain(); await view.unmount(); }
});
await check('real touch storage rejection preserves durable order and releases the parent for retry', async () => {
  const b = await fixture(), view = await mountedPage(b), write = b.uni.setStorageSync;
  const calls = b.policyCalls().length, revision = b.policy.sourcePolicyRevision();
  try {
    b.uni.setStorageSync = (key, value) => { if (key === b.key) throw new Error('owned reorder disk full'); return write(key, value); };
    const handle = view.cardHandle('wyy');
    await view.dispatch(handle, 'touchstart', { y: 80 }); await view.reply();
    await view.dispatch(handle, 'touchmove', { y: 440 }); await view.dispatch(handle, 'touchend', { y: 440 }); await drain(); await view.flush();
    assert.deepEqual(view.cardOrder(), ['网易云', 'QQ音乐', '酷我']); assert.equal(b.storage.has(b.key), false);
    assert.equal(b.policy.sourcePolicyRevision(), revision); assert.equal(b.policyCalls().length, calls);
    assert.equal(b.page.policySaving.value, false); assert.equal(view.scroll().props.direction, 'vertical');
    assert.equal(b.toasts.length, 1); assert.match(b.toasts[0].title, /保存失败.*owned reorder disk full/);
    b.uni.setStorageSync = write;
    await view.dispatch(view.cardHandle('wyy'), 'touchstart', { y: 80 }); await view.reply();
    await view.dispatch(view.cardHandle('wyy'), 'touchmove', { y: 440 }); await view.dispatch(view.cardHandle('wyy'), 'touchend', { y: 440 });
    await drain(); await view.flush(); assert.deepEqual(view.cardOrder(), ['QQ音乐', '酷我', '网易云']);
    assert.equal(b.policyCalls().length, calls + 1);
  } finally { b.uni.setStorageSync = write; await view.unmount(); }
});
await check('real touch rejects stale policy or registry snapshots and cancels late geometry on hide', async () => {
  for (const cause of ['policy', 'registry', 'hide']) {
    const b = await fixture(), view = await mountedPage(b);
    try {
      const handle = view.cardHandle('wyy'); await view.dispatch(handle, 'touchstart', { y: 80 });
      if (cause === 'policy') b.policy.saveSourcePolicy({ version: 1, enabled: ['wyy', 'kw'], order: ['wyy', 'qq', 'kw'] });
      if (cause === 'registry') b.registry.generation++;
      if (cause === 'hide') for (const callback of view.lifecycle.hide) callback();
      await drain(); await view.flush();
      const saved = b.storage.get(b.key), revision = b.policy.sourcePolicyRevision(), calls = b.policyCalls().length;
      await view.reply(); await view.dispatch(handle, 'touchmove', { y: 440 }); await view.dispatch(handle, 'touchend', { y: 440 });
      await drain(); await view.flush();
      assert.equal(b.storage.get(b.key), saved, cause + ' cannot publish a stale drag');
      assert.equal(b.policy.sourcePolicyRevision(), revision); assert.equal(b.policyCalls().length, calls);
      assert.deepEqual(view.cardOrder(), ['网易云', 'QQ音乐', '酷我']); assert.equal(view.scroll().props.direction, 'vertical');
      assert.equal(view.preview().length, 0);
    } finally { await view.unmount(); }
  }
});
await check('ended or orphan-crossing drag cannot publish a second order', async () => {
  const b = await fixture();
  await b.auth.saveSourceAuthAccount('gone', 'owned-orphan', user, ''); await drain(); b.page.refreshFromStorage();
  let list = publicReorder(b);
  list.props.onActive(true);
  await list.props.onReorder(['kw', 'wyy', 'qq', 'gone']); list.props.onActive(false); await drain();
  const saved = b.storage.get(b.key), revision = b.policy.sourcePolicyRevision(), calls = b.policyCalls().length;
  list = publicReorder(b);
  await list.props.onReorder(['qq', 'kw', 'wyy', 'gone']); await drain();
  assert.equal(b.storage.get(b.key), saved, 'a completed gesture is not a new drag');
  list.props.onActive(true);
  await list.props.onReorder(['qq', 'gone', 'kw', 'wyy']); list.props.onActive(false); await drain();
  assert.equal(b.storage.get(b.key), saved, 'orphan rows remain fixed anchors');
  assert.equal(b.policy.sourcePolicyRevision(), revision); assert.equal(b.policyCalls().length, calls);
});
await check('card aggregate switch can close the last participant, persists explicit none, and never requests online aggregate songs', async () => {
  const b = await fixture(), revision = b.policy.sourcePolicyRevision(), calls = b.policyCalls().length;
  b.page.toggleCard('wyy');
  assert.ok(textOf(publicCard(b, 'wyy')).includes('参与聚合搜索'));
  await changeCardSwitch(b, 'wyy', 'aggregate-toggle-row');
  b.page.toggleCard('qq'); await changeCardSwitch(b, 'qq', 'aggregate-toggle-row');
  b.page.toggleCard('kw'); await changeCardSwitch(b, 'kw', 'aggregate-toggle-row');
  assert.deepEqual(plain(b.aggregate.readAggregateSources()), []);
  assert.equal(b.page.agSummary.value, '聚合搜索已关闭');
  assert.equal(b.eventCount(b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT), 3);
  const before = b.state.calls.length;
  assert.deepEqual(plain(await b.music.searchMerged('owned song', 1, 20, b.aggregate.readAggregateSources(), 'wyy')), { songs: [], full: false });
  assert.deepEqual(plain(await b.music.allSearchBatches('owned song', 1, 20)), []);
  assert.equal(b.state.calls.length, before, 'even old packages must never interpret none as all');
  assert.equal(b.policy.sourcePolicyRevision(), revision); assert.equal(b.policyCalls().length, calls);
  for (const callback of b.hooks.show) callback(); await drain();
  assert.deepEqual(plain(b.aggregate.readAggregateSources()), []);
  await changeCardSwitch(b, 'qq', 'aggregate-toggle-row');
  assert.deepEqual(plain(b.aggregate.readAggregateSources()), ['qq']);
});
await check('compact/wide frame, flat policy CSS and original horizontal login actions stay intact', async () => {
  const text = read(PAGE_PATH);
  assert.match(text, /<qt-page-frame width-kind="flow" :max-width="720">/);
  assert.match(text, /class="acc-scroll"[^>]*direction="horizontal"/);
  assert.match(text, /\.acc-scroll\s*\{[^}]*height:\s*88rpx/);
  assert.match(text, /\.acc-scroll-wide\s*\{[^}]*height:\s*44px/);
  assert.doesNotMatch(text, /\.ag-wrap\s*\{|\.policy-source\s*\{/);
  assert.match(text, /\.scope-row\s*\{[^}]*border-bottom-style:\s*solid/);
  assert.match(text, /\.src-title\s*\{[^}]*min-width:\s*0/);
  assert.match(text, /\.src-drag-handle\s*\{[^}]*flex-shrink:\s*0/);
  for (const wide of [false, true]) {
    const b = await fixture({ wide });
    const row = b.page.sourceCards.value[0];
    assert.equal(row.qr && row.cookie && row.sms && row.pwd && row.web, true);
    assert.equal(b.page.accTrackWidth(row), wide ? '966px' : '580.32px');
  }
});
await check('default policy shows full catalog with enabled ranks and readable capability labels', async () => {
  const b = await fixture();
  assert.equal(b.registry.ready, true);
  assert.deepEqual(ids(b.page.musicSourceRows.value), ['wyy', 'qq', 'kw']);
  assert.deepEqual(Array.from(b.page.enabledMusicSources.value, row => row.rank), [1, 2, 3]);
  assert.equal(b.page.enabledMusicSources.value[0].first, true);
  assert.equal(b.page.enabledMusicSources.value[2].last, true);
  assert.match(b.page.musicSourceRows.value[0].details, /单曲.*歌单.*专辑.*歌手.*榜单/);
  assert.equal(b.page.policyMessage.value, '');
});
await check('page toggle commits device policy/event immediately and real engine applies it exactly once', async () => {
  const b = await fixture(), before = b.policyCalls().length;
  const events = b.eventCount(b.policy.SOURCE_POLICY_CHANGED_EVENT);
  const pending = b.page.changeMusicSource('qq', 0);
  assert.deepEqual(JSON.parse(b.storage.get(b.key)).enabled, ['wyy', 'kw']);
  assert.equal(b.page.policySaving.value, true);
  assert.equal(b.eventCount(b.policy.SOURCE_POLICY_CHANGED_EVENT), events + 1);
  await pending; await drain();
  assert.equal(b.policyCalls().length, before + 1, 'service event and explicit page await share the actual serialized engine task');
  assert.deepEqual(b.policyCalls().at(-1).args[0].enabled, ['wyy', 'kw']);
  assert.deepEqual(ids(b.page.enabledMusicSources.value), ['wyy', 'kw']);
  assert.deepEqual(ids(b.page.disabledMusicSources.value), ['qq']);
  assert.equal(b.page.policySaving.value, false);
});
await check('up/down reorder enabled platforms while disabled catalog members and stored order remain', async () => {
  const b = await fixture();
  await b.page.changeMusicSource('qq', 0);
  b.page.moveMusicSource('kw', -1); await drain();
  assert.deepEqual(ids(b.page.enabledMusicSources.value), ['kw', 'wyy']);
  assert.deepEqual(plain(b.policy.sourcePolicySnapshot().order), ['kw', 'qq', 'wyy']);
  b.page.moveMusicSource('kw', 1); await drain();
  assert.deepEqual(ids(b.page.enabledMusicSources.value), ['wyy', 'kw']);
  assert.deepEqual(Array.from(b.page.enabledMusicSources.value, row => row.rank), [1, 2]);
  b.page.toggleMusicSource('qq'); await drain();
  assert.deepEqual(ids(b.page.enabledMusicSources.value), ['wyy', 'qq', 'kw']);
});
await check('invalid/end-point moves do not mutate storage, revision, events or engine policy', async () => {
  const b = await fixture();
  const revision = b.policy.sourcePolicyRevision(), calls = b.policyCalls().length, events = b.events.length;
  await b.page.changeMusicSource('wyy', -1);
  await b.page.changeMusicSource('kw', 1);
  await b.page.changeMusicSource('missing', -1);
  assert.equal(b.policy.sourcePolicyRevision(), revision);
  assert.equal(b.storage.has(b.key), false);
  assert.equal(b.policyCalls().length, calls); assert.equal(b.events.length, events);
});
await check('all-off preserves credentials, both account toggles and selected qualities without starting playback', async () => {
  const b = await fixture();
  await b.auth.saveSourceAuthAccount('wyy', 'synthetic-cookie', user, '{"refresh_token":"synthetic-token"}');
  await b.auth.setSourceAuthToggle('wyy', 'meta', false);
  await b.auth.setSourceAuthToggle('wyy', 'play', true);
  b.quality.setSourcePlayQuality('wyy', '128'); b.quality.setSourceDownloadQuality('wyy', '320');
  await drain();
  const accounts = b.storage.get('qt-source-auth-accounts'), toggles = b.storage.get('qt-source-auth-toggles-v3');
  const playQuality = b.quality.sourcePlayQualityOf('wyy', ''), downloadQuality = b.quality.sourceDownloadQualityOf('wyy', '');
  const authRevision = b.auth.sourceAuthRevision('wyy'), start = b.state.calls.length;
  for (const id of ['wyy', 'qq', 'kw']) await b.page.changeMusicSource(id, 0);
  assert.deepEqual(plain(b.policy.sourcePolicySnapshot().enabled), []);
  assert.equal(b.policy.sourceEnabled('local'), true); assert.equal(b.policy.sourceEnabled('podcast'), true);
  assert.deepEqual(ids(b.registry.catalog), ['wyy', 'qq', 'kw']); assert.deepEqual(Array.from(b.registry.sourceIds()), []);
  assert.equal(b.selection.current, 'local');
  assert.equal(b.storage.get('qt-source-auth-accounts'), accounts); assert.equal(b.storage.get('qt-source-auth-toggles-v3'), toggles);
  assert.equal(b.auth.sourceAuthRevision('wyy'), authRevision);
  assert.equal(b.quality.sourcePlayQualityOf('wyy', ''), playQuality); assert.equal(b.quality.sourceDownloadQualityOf('wyy', ''), downloadQuality);
  assert.equal(b.state.calls.slice(start).some(call => /^(?:setAuth|clearAuth|getPlayUrl|accountFmNext|accountDailySongs)$/.test(call.name)), false);
  assert.equal(b.page.agSummary.value, '没有已启用的平台');
});
await check('held real-engine save prevents repeated toggle/move saves and releases only after acknowledgement', async () => {
  const b = await fixture(); b.state.policyMode = 'hold';
  const pending = b.page.changeMusicSource('qq', 0); await drain();
  const saved = b.storage.get(b.key), revision = b.policy.sourcePolicyRevision();
  assert.equal(b.state.held.length, 1);
  b.page.toggleMusicSource('kw'); b.page.moveMusicSource('wyy', 1); await drain();
  assert.equal(b.storage.get(b.key), saved); assert.equal(b.policy.sourcePolicyRevision(), revision);
  assert.equal(b.page.policySaving.value, true);
  b.replyPolicy(); await pending; await drain();
  assert.equal(b.page.policySaving.value, false); assert.equal(b.page.policyMessage.value, '');
});
await check('native storage failure leaves old live policy and returns one failure receipt without engine application', async () => {
  const b = await fixture(), oldWrite = b.uni.setStorageSync;
  const calls = b.policyCalls().length, revision = b.policy.sourcePolicyRevision();
  b.uni.setStorageSync = (key, value) => { if (key === b.key) throw new Error('owned disk full'); return oldWrite(key, value); };
  await b.page.changeMusicSource('qq', 0);
  assert.equal(b.policy.sourcePolicyRevision(), revision); assert.equal(b.policy.sourceEnabled('qq'), true);
  assert.equal(b.storage.has(b.key), false); assert.equal(b.policyCalls().length, calls);
  assert.equal(b.page.policySaving.value, false); assert.equal(b.toasts.length, 1);
  assert.match(b.toasts[0].title, /保存失败.*owned disk full/);
  b.uni.setStorageSync = oldWrite;
});
await check('internally caught engine failure refreshes cached status, preserves saved policy and permits retry', async () => {
  const b = await fixture(); assert.equal(b.page.policyMessage.value, '');
  b.state.policyMode = 'reject'; await b.page.changeMusicSource('qq', 0);
  assert.match(b.page.policyMessage.value, /音乐源设置未能应用.*owned policy transport failed/);
  assert.equal(b.policy.sourceEnabled('qq'), false); assert.equal(b.page.policySaving.value, false);
  assert.equal(b.toasts.length, 0, 'engine catches its own error; the visible status is not a success assumption');
  b.state.policyMode = 'accept'; await b.page.changeMusicSource('kw', -1);
  assert.equal(b.page.policyMessage.value, '');
  assert.deepEqual(ids(b.page.enabledMusicSources.value), ['kw', 'wyy']);
});
await check('negative package acknowledgement remains visible and package-upgrade routing is not renamed', async () => {
  const b = await fixture(); b.state.policyMode = 'bad-ack'; await b.page.changeMusicSource('qq', 0);
  assert.match(b.page.policyMessage.value, /音源包未接受音乐源设置/);
  assert.equal(b.policy.sourceEnabled('qq'), false);
  b.state.policyMode = 'accept'; b.state.playSupported = false; await b.page.changeMusicSource('kw', -1);
  assert.match(b.page.policyMessage.value, /音源包管理更新播放包/);
  assert.match(b.policy.SOURCE_POLICY_UPGRADE_MESSAGE, /音源包管理/);
});
await check('missing metadata keeps install hint; legacy metadata defaults all platforms on', async () => {
  const missing = await fixture({ installed: false });
  assert.equal(missing.registry.ready, false); assert.deepEqual(ids(missing.page.musicSourceRows.value), []);
  assert.match(missing.page.authEmptyText.value, /音源包管理.*数据包/);
  assert.match(missing.page.policyMessage.value, /安装数据包/);
  const legacy = await fixture({ legacy: true });
  assert.match(legacy.page.policyMessage.value, /已默认全部平台开启/);
  await legacy.page.changeMusicSource('qq', 0);
  assert.equal(legacy.policy.sourceEnabled('qq'), true);
  assert.equal(legacy.policyCalls().length, 0);
});
await check('aggregate default/empty selection is all enabled sources and uses full platform labels', async () => {
  const b = await fixture();
  assert.equal(b.aggregate.readAggregateSources(), null); assert.equal(b.page.agAllSelected.value, true);
  assert.deepEqual(Array.from(b.page.agRows.value, row => row.name), ['网易云', 'QQ音乐', '酷我']);
  assert.equal(b.page.agSummary.value, '全部已启用平台');
  b.page.agUseAll();
  assert.equal(b.storage.get(AGGREGATE_KEY), ''); assert.equal(b.aggregate.readAggregateSources(), null);
  assert.equal(b.eventCount(b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT), 1);
});
await check('each aggregate toggle persists once, emits its existing event and leaves policy/accounts alone', async () => {
  const b = await fixture(); const calls = b.policyCalls().length, revision = b.policy.sourcePolicyRevision();
  b.page.agToggle('qq');
  assert.deepEqual(JSON.parse(b.storage.get(AGGREGATE_KEY)), ['wyy', 'kw']);
  assert.equal(b.page.agAllSelected.value, false); assert.equal(b.page.agSummary.value, '已选 2 / 3');
  assert.equal(b.eventCount(b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT), 1);
  b.page.agToggle('qq');
  assert.deepEqual(plain(b.aggregate.readAggregateSources()), ['wyy', 'kw', 'qq']);
  assert.equal(b.eventCount(b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT), 2);
  assert.equal(b.policy.sourcePolicyRevision(), revision); assert.equal(b.policyCalls().length, calls);
  assert.equal(b.storage.has('qt-source-auth-accounts'), false);
});
await check('user-confirmed final aggregate choice persists none rather than reopening all platforms', async () => {
  const b = await fixture(); b.aggregate.saveAggregateSources(['wyy']);
  b.uni.$emit(b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT);
  assert.equal(b.page.agAllSelected.value, false); b.page.agToggle('wyy');
  assert.deepEqual(plain(b.aggregate.readAggregateSources()), []); assert.equal(b.page.agAllSelected.value, false);
  assert.equal(b.page.agRows.value.every(row => !row.on), true); assert.equal(b.page.agSummary.value, '聚合搜索已关闭');
});
await check('aggregate UI contains only enabled platforms while unavailable saved IDs survive editing/reinstall', async () => {
  const b = await fixture(); b.aggregate.saveAggregateSources(['wyy', 'qq', 'gone']);
  b.uni.$emit(b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT); await b.page.changeMusicSource('qq', 0);
  assert.deepEqual(ids(b.page.agRows.value), ['wyy', 'kw']);
  assert.deepEqual(plain(b.aggregate.readAggregateSources()), ['wyy', 'qq', 'gone']);
  b.page.agToggle('kw'); assert.deepEqual(plain(b.aggregate.readAggregateSources()), ['wyy', 'qq', 'gone', 'kw']);
  b.state.catalog.push(source('gone', '恢复平台')); await b.registry.refresh(); await drain();
  assert.equal(b.policy.sourceEnabled('gone'), false, 'newly installed platforms remain off after custom policy');
  await b.page.changeMusicSource('gone', 0);
  assert.equal(b.page.agRows.value.find(row => row.id === 'gone').on, true);
  assert.equal(b.page.agRows.value.find(row => row.id === 'gone').name, '恢复平台');
});
await check('real Vue cached computed values react to external policy and aggregate events', async () => {
  const b = await fixture(), oldRows = b.page.agRows.value, oldTick = b.page.refreshTick.value;
  assert.equal(b.page.agRows.value, oldRows, 'fixture must use actual computed caching');
  b.policy.saveSourcePolicy({ version: 1, enabled: ['kw'], order: ['kw', 'qq', 'wyy'] }); await drain();
  assert.ok(b.page.refreshTick.value > oldTick); assert.deepEqual(ids(b.page.enabledMusicSources.value), ['kw']);
  assert.deepEqual(ids(b.page.agRows.value), ['kw']); assert.notEqual(b.page.agRows.value, oldRows);
  b.aggregate.saveAggregateSources(['wyy']); b.uni.$emit(b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT);
  assert.equal(b.page.agRows.value[0].on, false); assert.equal(b.page.agAllSelected.value, false);
});
await check('registry generation invalidates cached aggregate rows without a page-local tick', async () => {
  const b = await fixture(), oldRows = b.page.agRows.value, oldTick = b.page.refreshTick.value, generation = b.registry.generation;
  b.storage.set(AGGREGATE_KEY, '["kw"]');
  assert.equal(b.page.agRows.value, oldRows, 'non-reactive storage alone cannot invalidate a Vue computed');
  b.registry.applyPolicy();
  assert.ok(b.registry.generation > generation); assert.equal(b.page.refreshTick.value, oldTick);
  assert.deepEqual(Array.from(b.page.agRows.value, row => row.on), [false, false, true]);
});
await check('actual onShow refreshes non-reactive preferences and ensures registry without resetting them', async () => {
  const b = await fixture(); assert.equal(b.page.agAllSelected.value, true);
  const ensures = b.state.ensureCalls; b.storage.set(AGGREGATE_KEY, '["qq"]');
  assert.equal(b.page.agAllSelected.value, true);
  for (const callback of b.hooks.show) callback(); await drain();
  assert.equal(b.hooks.show.length, 1); assert.equal(b.page.agAllSelected.value, false);
  assert.equal(b.page.agSummary.value, '已选 1 / 3'); assert.equal(b.storage.get(AGGREGATE_KEY), '["qq"]');
  assert.ok(b.state.ensureCalls >= ensures);
});
await check('actual unload/unmount removes exact page listeners and never detaches global registry/engine listeners', async () => {
  for (const action of ['unload', 'unmounted']) {
    const b = await fixture(), event = b.policy.SOURCE_POLICY_CHANGED_EVENT;
    const registered = b.subscriptions.filter(item => item.op === 'on' && item.fn === b.page.refreshFromStorage);
    assert.deepEqual(registered.map(item => item.name), [event, b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT]);
    const globalCount = b.listeners.get(event).size - 1;
    assert.ok(globalCount >= 2);
    assert.equal(b.hooks[action].length, 1);
    for (const callback of b.hooks[action]) callback();
    assert.equal(b.listeners.get(event).size, globalCount);
    assert.equal(b.listeners.get(b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT).size, 0);
    assert.equal(b.listeners.get('qt-web-login-done').size, 0);
    for (const item of registered) assert.ok(b.subscriptions.some(off => off.op === 'off' && off.name === item.name && off.fn === item.fn));
    const tick = b.page.refreshTick.value;
    b.policy.saveSourcePolicy({ version: 1, enabled: ['kw'], order: ['kw'] }); await drain();
    b.aggregate.saveAggregateSources(['kw']); b.uni.$emit(b.aggregate.AGGREGATE_SOURCES_CHANGED_EVENT);
    assert.equal(b.page.refreshTick.value, tick); assert.deepEqual(Array.from(b.registry.sourceIds()), ['kw']);
    const saved = b.storage.get(b.key), aggregateSaved = b.storage.get(AGGREGATE_KEY);
    await b.page.changeMusicSource('kw', 0); b.page.agUseAll(); b.page.agToggle('kw'); b.page.refreshFromStorage();
    assert.equal(b.storage.get(b.key), saved); assert.equal(b.storage.get(AGGREGATE_KEY), aggregateSaved);
    assert.equal(b.page.refreshTick.value, tick);
  }
});
await check('late engine acknowledgement after disposal cannot publish UI state or undo persisted device policy', async () => {
  for (const action of ['unload', 'unmounted']) {
    const b = await fixture(); b.state.policyMode = 'hold';
    const pending = b.page.changeMusicSource('qq', 0); await drain();
    assert.equal(b.state.held.length, 1);
    for (const callback of b.hooks[action]) callback();
    const tick = b.page.refreshTick.value, saved = b.storage.get(b.key);
    b.replyPolicy(); await pending; await drain();
    assert.equal(b.page.refreshTick.value, tick); assert.equal(b.toasts.length, 0);
    assert.equal(b.page.policySaving.value, true, 'dead-page refs are not changed by a late finally');
    assert.equal(b.storage.get(b.key), saved); assert.equal(b.policy.sourceEnabled('qq'), false);
    assert.deepEqual(b.policyCalls().at(-1).args[0].enabled, ['wyy', 'kw']);
  }
});
await check('late failed acknowledgement remains global but produces no departed-page receipt', async () => {
  const b = await fixture(); b.state.policyMode = 'hold';
  const pending = b.page.changeMusicSource('qq', 0); await drain();
  for (const callback of b.hooks.unload) callback();
  // Registry quality refresh and the explicit page await may retry the global
  // policy task. Keep the owned package negative on every acknowledgement.
  const tick = b.page.refreshTick.value; b.replyPolicy(false, 'bad-ack'); await pending; await drain();
  assert.equal(b.page.refreshTick.value, tick); assert.equal(b.toasts.length, 0);
  assert.equal(b.policy.sourceEnabled('qq'), false); assert.match(b.engine.sourcePolicyStatus().message, /未能应用/);
});
await check('disabled logged-in platform remains exactly one normal account/quality card; only absent catalog IDs are orphaned', async () => {
  const b = await fixture(); await b.auth.saveSourceAuthAccount('wyy', 'synthetic-cookie', user, '');
  await b.auth.saveSourceAuthAccount('gone', 'synthetic-orphan-cookie', user, ''); await drain();
  b.page.refreshFromStorage(); await b.page.changeMusicSource('wyy', 0);
  const cards = b.page.sourceCards.value;
  assert.equal(cards.filter(row => row.id === 'wyy').length, 1);
  const normal = cards.find(row => row.id === 'wyy');
  assert.equal(normal.orphan, false); assert.equal(normal.logged, true); assert.equal(normal.name, '网易云');
  assert.equal(cards.find(row => row.id === 'gone').orphan, true);
  b.page.showQualitySheet('wyy', '网易云', 'play');
  assert.deepEqual(Array.from(b.page.qualitySheetIds.value), ['128', '320']);
  assert.equal(b.page.qualitySheetSelectedIndex.value, 1);
  b.page.onQualitySheetSelect(b.page.qualitySheetActions.value[0], 0);
  assert.equal(b.quality.sourcePlayQualityOf('wyy', ''), '128'); assert.equal(b.policy.sourceEnabled('wyy'), false);
  b.state.catalog.push(source('gone', '恢复平台')); await b.registry.refresh(); await drain();
  assert.equal(b.page.sourceCards.value.filter(row => row.id === 'gone').length, 1);
  assert.equal(b.page.sourceCards.value.find(row => row.id === 'gone').orphan, false);
});
await check('actual MusicApi reads migrated whitelist, forwards it unchanged and discards disabled source batches', async () => {
  const b = await fixture(); b.page.agToggle('qq'); await b.page.changeMusicSource('qq', 0);
  b.state.aggregateReply = { batches: [
    { source: 'wyy', list: [{ id: 'one', name: 'Owned song', singer: 'Fixture', album: '', interval: 200 }] },
    { source: 'qq', list: [{ id: 'off', name: 'Disabled', singer: 'Fixture', album: '', interval: 200 }] },
  ] };
  const batches = await b.music.allSearchBatches('owned keyword', 1, 20);
  const call = b.state.calls.filter(item => item.name === 'searchAll').at(-1);
  assert.deepEqual(call.args[0].sources, ['wyy', 'kw']);
  assert.deepEqual(Array.from(batches, batch => batch.source), ['wyy']);
  b.page.agUseAll(); await b.music.allSearchBatches('owned keyword', 1, 20);
  assert.equal(Object.hasOwn(b.state.calls.filter(item => item.name === 'searchAll').at(-1).args[0], 'sources'), false);
});
await check('management page title/navigation is renamed while route/key and package-management responsibilities remain', () => {
  const pages = read('pages.json'), chrome = read('uni_modules/qt-ui/composables/qt-page-chrome.ts');
  const overview = read('uni_modules/qt-ui/components/qt-settings-overview/qt-settings-overview.uvue');
  const recommendation = read('uni_modules/qt-ui/components/qt-recommendation-source-control/qt-recommendation-source-control.uvue');
  const configuredPages = JSON.parse(pages.replace(/^\s*\/\/.*$/gm, '')).pages;
  assert.equal(configuredPages.find(page => page.path === 'pages/source-auth/index').style.navigationBarTitleText, '音源平台管理');
  const chromeApi = load(chrome, exported(chrome), { ref: Vue.ref, getCurrentPages: () => [] });
  assert.equal(chromeApi.qtPageTitle('/pages/source-auth/index'), '音源平台管理');
  assert.equal(chromeApi.qtIsSettingsRoute('/pages/source-auth/index'), true);
  assert.equal(chromeApi.qtPageTitle('/pages/source-pack/index'), '音源包管理');
  assert.match(overview, /key:\s*"source-auth"[^\n]*title:\s*"音源平台管理"/);
  assert.match(overview, /安装\s*\/\s*更新\s*\/\s*卸载/);
  assert.match(overview, /平台\s*\/\s*聚合\s*\/\s*账号/);
  assert.match(recommendation, /音源平台管理/); assert.match(recommendation, /\/pages\/source-auth\/index/);
  assert.doesNotMatch(recommendation, /音源账号|音源包管理/);
});
await check('network split: WIFI and cellular pickers resolve, highlight and persist independently', async () => {
  const b = await fixture();
  const before = b.page.sourceCards.value.find(row => row.id === 'wyy');
  assert.equal(before.playQualityWifiLabel, '高品 320k'); assert.equal(before.playQualityCellularLabel, '高品 320k');
  b.page.showQualitySheet('wyy', '网易云', 'play', 'wifi');
  assert.equal(b.page.qualitySheetTitle.value, '网易云 · 播放音质 · WIFI');
  assert.equal(b.page.qualitySheetSelectedIndex.value, 1);
  b.page.onQualitySheetSelect(b.page.qualitySheetActions.value[0], 0);
  b.page.showQualitySheet('wyy', '网易云', 'play', 'cellular');
  assert.equal(b.page.qualitySheetTitle.value, '网易云 · 播放音质 · 移动网络');
  assert.equal(b.page.qualitySheetSelectedIndex.value, 1, '移动网络的回落值不受 WIFI 写入影响');
  assert.equal(b.quality.sourcePlayQualityForNetwork('wyy', 'owned-fallback', 'wifi'), '128');
  assert.equal(b.quality.sourcePlayQualityForNetwork('wyy', 'owned-fallback', 'cellular'), 'owned-fallback');
  assert.equal(JSON.parse(b.storage.get('qt-source-play-qualities-wifi')).wyy, '128');
  assert.equal(b.storage.has('qt-source-play-qualities-cellular'), false, '未设置的网络不落库');
  b.page.showQualitySheet('wyy', '网易云', 'download', 'cellular');
  b.page.onQualitySheetSelect(b.page.qualitySheetActions.value[0], 0);
  assert.equal(b.quality.sourceDownloadQualityForNetwork('wyy', 'owned-fallback', 'cellular'), '128');
  assert.equal(b.quality.sourceDownloadQualityForNetwork('wyy', 'owned-fallback', 'wifi'), 'owned-fallback');
  b.page.showQualitySheet('wyy', '网易云', 'play', 'cellular');
  assert.equal(b.page.qualitySheetSelectedIndex.value, 0, '移动网络播放缺省跟随同网络的下载音质');
  const after = b.page.sourceCards.value.find(row => row.id === 'wyy');
  assert.equal(after.playQualityWifiLabel, '标准 128k');
  assert.equal(after.downloadQualityCellularLabel, '标准 128k');
  assert.equal(after.downloadQualityWifiLabel, '高品 320k');
});
await check('network flip re-routes current-network getters and notifies open UI through the shared event', async () => {
  const b = await fixture();
  b.quality.setSourcePlayQualityForNetwork('wyy', '128', 'wifi');
  b.quality.setSourcePlayQualityForNetwork('wyy', '320', 'cellular');
  assert.equal(b.quality.sourcePlayQualityOf('wyy', 'owned-fallback'), '128');
  const ticks = b.eventCount('qt-source-qualities-changed');
  for (const watcher of b.networkWatchers) watcher({ networkType: '5g' });
  assert.equal(b.quality.sourcePlayQualityOf('wyy', 'owned-fallback'), '320', '切换到移动网络后取移动网络表');
  assert.equal(b.eventCount('qt-source-qualities-changed'), ticks + 1, '网络切换转译成音质表变化事件');
  // 播放页菜单落地（setSourceQuality 同款）只写当前网络面别
  b.quality.setSourcePlayQuality('wyy', '128');
  assert.equal(JSON.parse(b.storage.get('qt-source-play-qualities-cellular')).wyy, '128');
  assert.equal(JSON.parse(b.storage.get('qt-source-play-qualities-wifi')).wyy, '128', 'WIFI 表不被移动网络写入改动');
});
await check('network split migration copies legacy tables into both networks, drops legacy keys and migrates stale tiers per network', async () => {
  const legacyPlayKey = read('services/source-quality.ts').match(/PLAY_QUALITIES_KEY = "([^"]+)"/)[1];
  const b = await fixture({ initialQuality: {
    [legacyPlayKey]: JSON.stringify({ wyy: '999' }),
    'qt-source-download-qualities': JSON.stringify({ kw: '999' }),
  } });
  assert.equal(b.music.highestQualityOf(['128', '320']), '320', '基准序取最高档（方向回归）');
  assert.equal(b.storage.has(legacyPlayKey), false, '旧播放键迁移后删除');
  assert.equal(b.storage.has('qt-source-download-qualities'), false, '旧下载键迁移后删除');
  assert.equal(b.storage.get('qt-source-quality-network-schema'), '1');
  // 迁移先复制（两个网络各拿一份 999），注册表加载后 migrateStaleQualities
  // 对两个网络对称收敛：999 不在 ['128','320'] → 改最高档 320
  assert.equal(b.quality.sourcePlayQualityForNetwork('wyy', '', 'wifi'), '320');
  assert.equal(b.quality.sourcePlayQualityForNetwork('wyy', '', 'cellular'), '320');
  assert.equal(b.quality.sourceDownloadQualityForNetwork('kw', '', 'wifi'), '320');
  assert.equal(b.quality.sourceDownloadQualityForNetwork('kw', '', 'cellular'), '320');
  assert.equal(JSON.parse(b.storage.get('qt-source-play-qualities-wifi')).wyy, '320');
  assert.equal(JSON.parse(b.storage.get('qt-source-play-qualities-cellular')).wyy, '320');
  assert.equal(JSON.parse(b.storage.get('qt-source-download-qualities-wifi')).kw, '320');
  assert.equal(JSON.parse(b.storage.get('qt-source-download-qualities-cellular')).kw, '320');
});
await check('update offer label keeps one v prefix per version', async () => {
  const bundleFs = read('services/source-bundle-fs.uts');
  const kindMeta = bundleFs.match(/export const PACK_KIND_META = "([^"]+)"/)[1];
  const kindPlay = bundleFs.match(/export const PACK_KIND_PLAY = "([^"]+)"/)[1];
  const svc = read('services/source-update.uts');
  const fn = svc.match(/export function offerLabel\(o: PackUpdateOffer\): string \{[\s\S]*?\n\}/)[0];
  const api = load('const PACK_KIND_META = "' + kindMeta + '";\n' + fn, ['offerLabel'], {});
  const offer = { kind: kindPlay, targetId: 'qt-audio', currentCode: 2026111101, newCode: 2026111401, newName: '2026.11.14.1', notes: '', channel: '', url: '' };
  assert.equal(api.offerLabel(offer), '播放包有新版本：v2026111101 → v2026111401（2026.11.14.1）');
  assert.equal(api.offerLabel({ ...offer, kind: kindMeta, currentCode: 0 }), '数据包有新版本：未安装 → v2026111401（2026.11.14.1）');
});
console.log(`Source-platform management: ${passed} passed (actual page/template/components/services/registry/MusicApi; owned offline boundaries).`);
if (process.env.SOURCE_PLATFORM_CASE == null) {
  await runAggregateChecks();
  await runReorderChecks();
}
