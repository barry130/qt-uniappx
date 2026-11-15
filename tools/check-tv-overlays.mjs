// Approved seam: complete compiled existing overlay templates -> real public
// events/services, with actual TV modal/navigation and QtRichText loaded.
// Owned boundaries: native window/collect/activation/browser/download, clock,
// HTTP/account data. Geometry is synthetic, not a native Yoga/device assertion.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Vue from 'vue';
import { tvSettingsFixture } from './check-tv-settings.mjs';

const UI = 'uni_modules/qt-ui/components/';
const paths = {
  disclaimer: UI + 'qt-first-run-disclaimer/qt-first-run-disclaimer.uvue',
  upgrade: UI + 'qt-upgrade-popup/qt-upgrade-popup.uvue',
  notice: UI + 'qt-notice-splash/qt-notice-splash.uvue',
};
const cases = {};
const noop = () => {};
const walk = node => node == null ? [] : [node, ...node.children.flatMap(walk)];
const classes = node => String(node.props.class ?? '').split(/\s+/);
const first = (b, cls) => b.byClass(cls)[0];
const text = node => node.text + node.children.map(text).join('');
const px = (b, node, prop) => Number.parseFloat(b.css(node)[prop] ?? '0');
const remote = async (b, key, repeat = 0) => {
  const codes = { up: 19, down: 20, left: 21, right: 22, ok: 23, back: 4, menu: 82 };
  const result = b.tv.qtTvDispatchRemote({ key, code: codes[key], action: 'down', repeat });
  await b.flush(); return result;
};
const terms = overrides => ({ title: '使用前请先阅读', content: '<p>这是完整条款正文。</p>',
  url: '', termsVersion: 'fixture-v1', readSeconds: 3, ...overrides });
const updateInfo = overrides => ({ versionName: '2.0.0-beta', versionCode: 200, versionInfo: '<p>完整更新说明。</p>',
  updateType: '1', downloadUrl: 'https://fixture.example/app.apk', browserUrl: 'https://fixture.example/download',
  channel: 'beta', isForce: false, fileSize: 52428800, md5: '', isGithub: 0, ...overrides });
const splash = overrides => ({ id: 91, title: '开屏公告', content: '<p>完整公告正文。</p>',
  url: '', dialogClosable: 1, ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const captureUpgrade = (events, info = updateInfo()) => Vue.reactive({ visible: true, info,
  'onUpdate:visible': value => events.push(['visible', value]), onClosed: () => events.push(['closed']) });

async function fixture({ mode = 'tv', width = 1280, height = 720, boundaries = {} } = {}) {
  const browserCalls = [], exitCalls = [], nativeBacks = [], collections = [], scrollCalls = [], candidates = new Map();
  const ids = new WeakMap(); let b, sequence = 0;
  function collect(root) {
    // Vue's synthetic native objects are proxy-wrapped by template refs; the
    // native adapter boundary receives the same underlying mounted element.
    root = Vue.toRaw(root);
    collections.push(root); candidates.clear();
    return walk(root).flatMap((node, index) => {
      if (classes(node).includes('qt-tv-skip')) return [];
      const scroll = classes(node).includes('qt-tv-scroll');
      if (!scroll && typeof node.props.onClick !== 'function' && !Array.isArray(node.props.onClick)) return [];
      let id = ids.get(node);
      if (!id) { id = 'native:custom:' + (node.props['data-qt-tv-id'] || 'node-' + ++sequence); ids.set(node, id); }
      candidates.set(id, node);
      return [{ id, left: 28, top: 28 + index * 60, width: 500, height: 56,
        visible: true, enabled: true, input: false, longPress: false,
        scrollGroup: scroll ? id : '' }];
    });
  }
  const defaults = {
    'services/tv-platform': { tvReadDevice: () => ({ television: false, nativeAvailable: false }),
      tvStartRemote: noop, tvSetRemoteState: noop, tvStopRemote: noop, tvCollect: collect,
      tvHighlight: noop, tvActivate: id => { const node = candidates.get(id); if (node) void b.dispatch(node); },
      tvScroll: (id, direction) => { scrollCalls.push([id, direction]); return true; },
      tvPresent: noop, tvBack: () => nativeBacks.push('back') },
    'services/app-native': { supportsHomeBackMode: () => true, isHarmonyOs: () => false,
      openInBrowser: url => browserCalls.push(url), exitApp: () => exitCalls.push('exit') },
    'services/auth': { getAccessToken: () => '', isLoggedIn: () => false },
    'services/http': { apiRequest: async () => { throw new Error('unselected HTTP boundary'); } },
    'services/app-version': { getCurrentVersionCode: () => 1, getCurrentVersionName: () => 'fixture' },
    'services/upgrade': undefined, // actual format/probe/fallback orchestration
    'services/music-api': { isQtAdmin: () => false, musicApi: {}, accountApi: {} },
    'services/logger': { logWarn: noop, logWarnV: noop, logErrV: noop, logInfo: noop,
      logMsg: noop, logMsgErr: noop, logSupported: () => false, logBytes: async () => 0 },
    'uni_modules/qt-app-native': { ensurePublicDirPermission: async () => false,
      saveToPublicMedia: async () => { throw new Error('unselected file boundary'); } },
  };
  b = await tvSettingsFixture({ savedMode: mode, width, height,
    boundaryOverrides: { ...defaults, ...boundaries } });
  return { ...b, browserCalls, exitCalls, nativeBacks, collections, scrollCalls, candidates };
}

cases['disclaimer-lock'] = async () => {
  const b = await fixture(), accepted = [], props = Vue.reactive({ visible: true, notice: terms(),
    onAccepted: () => accepted.push('accepted') });
  let dispose = null, underlyingBacks = 0;
  try {
    dispose = b.tv.qtTvRegisterScope({ root: { children: [], props: {} }, active: () => true,
      modal: true, priority: 3000, onBack: () => underlyingBacks++ });
    await b.mount(paths.disclaimer, props, false);
    assert.ok(b.text().includes('请阅读（3s）'), 'real countdown starts when visible disclaimer mounts');
    await remote(b, 'back');
    assert.equal(underlyingBacks, 0, 'disclaimer consumes Back above confirmation and never closes the background');
    assert.deepEqual(accepted, [], 'Back never accepts disclaimer');
    assert.deepEqual(b.exitCalls, [], 'Back never maps disclaimer to ordinary notice exit');
    assert.equal(b.collections.at(-1), first(b, 'frd-card'), 'TV scope collects the actual mounted card ref, not a mask');
    assert.ok(classes(first(b, 'frd-mask')).includes('qt-tv-skip'));
    assert.ok(classes(first(b, 'frd-card')).includes('qt-tv-skip'));
    assert.ok(classes(first(b, 'frd-content')).includes('qt-tv-scroll'), 'long terms expose one readonly scrolling surface');
    assert.equal([...b.candidates.values()].includes(first(b, 'frd-btn')), false, 'locked countdown confirm is absent from focus candidates');
    await b.dispatch(first(b, 'frd-btn')); assert.deepEqual(accepted, [], 'stale direct click also respects the original countdown guard');
    await b.clock.runTimers(2999); await remote(b, 'back');
    assert.equal(underlyingBacks, 0); assert.ok(b.text().includes('请阅读（1s）'));
    await b.clock.runTimers(1); b.tv.qtTvRefreshFocus(); await b.flush();
    assert.ok([...b.candidates.values()].includes(first(b, 'frd-btn')), 'confirmation enters live focus candidates only after countdown finishes');
    const confirmId = [...b.candidates.entries()].find(([, node]) => node === first(b, 'frd-btn'))[0];
    assert.equal(b.tv.qtTvFocus(confirmId), true);
    await remote(b, 'ok', 1); assert.deepEqual(accepted, [], 'held OK is not a second acceptance path');
    await remote(b, 'ok'); assert.deepEqual(accepted, ['accepted'], 'one public remote activation reaches original accepted event once');
    props.visible = false; await b.flush(); await remote(b, 'back');
    assert.equal(underlyingBacks, 1, 'closing the visible component restores underlying modal ownership');
    props.visible = true; await b.flush();
    assert.ok(b.text().includes('请阅读（3s）'), 'reopen restarts the original countdown');
    await b.close(); assert.equal(b.clock.intervalCount(1000), 0, 'unmount clears the original countdown timer');
  } finally { dispose?.(); await b.close(); }
};

cases['disclaimer-density'] = async () => {
  for (const [width, height] of [[1280, 720], [800, 360]]) {
    const b = await fixture({ width, height }), props = Vue.reactive({ visible: true,
      notice: terms({ url: 'https://fixture.example/terms', readSeconds: 0 }) });
    try {
      await b.mount(paths.disclaimer, props, false);
      assert.equal(px(b, first(b, 'frd-mask'), 'z-index'), 3200, 'TV visual layer matches its locked modal rank');
      assert.ok(px(b, first(b, 'frd-btn'), 'min-height') >= 56, 'TV confirmation has a complete logical-pixel remote target');
      assert.ok(px(b, first(b, 'frd-link'), 'min-height') >= 56, 'complete terms link has the same TV target floor');
      for (const cls of ['frd-title', 'frd-btn-text', 'frd-link-text']) {
        const node = first(b, cls), size = px(b, node, 'font-size');
        assert.ok(size >= 20, 'TV ' + cls + ' uses explicit readable text');
        assert.ok(px(b, node, 'line-height') >= size * 1.35, 'TV ' + cls + ' line box follows its actual font');
      }
      assert.ok(px(b, first(b, 'frd-card'), 'width') <= width - 56, 'TV card keeps logical outer gutters');
      assert.ok(px(b, first(b, 'frd-card'), 'max-height') <= height - 56, 'short TV retains its fixed controls inside the pane');
      assert.ok(px(b, first(b, 'frd-content'), 'height') >= 0);
      await b.dispatch(first(b, 'frd-link'));
      assert.deepEqual(b.browserCalls, ['https://fixture.example/terms'], 'the visible TV link keeps its existing browser service effect');
      b.tv.qtSetTvMode('touch'); await b.flush();
      assert.equal(px(b, first(b, 'frd-mask'), 'z-index'), 0, 'touch leaves the existing class-based 999 visual layer intact');
      assert.equal(px(b, first(b, 'frd-btn'), 'min-height'), 0, 'touch uses original 44px wide confirmation class');
      assert.equal(px(b, first(b, 'frd-card'), 'max-height'), Math.max(260, height - 32), 'touch restores original wide pane budget');
    } finally { await b.close(); }
  }
  const phone = await fixture({ mode: 'touch', width: 375, height: 800 }), accepted = [];
  try {
    await phone.mount(paths.disclaimer, { visible: true, notice: terms({ readSeconds: 0 }), onAccepted: () => accepted.push('accepted') }, false);
    assert.equal(px(phone, first(phone, 'frd-card'), 'width'), 327, 'phone keeps its existing shared modal width (375 minus two 24px gutters)');
    assert.equal(phone.css(first(phone, 'frd-content'))['max-height'], '760rpx', 'phone keeps its original short-content max-height contract');
    await phone.dispatch(first(phone, 'frd-btn')); assert.deepEqual(accepted, ['accepted']);
  } finally { await phone.close(); }
};

cases['upgrade-density'] = async () => {
  for (const [width, height] of [[1280, 720], [800, 360]]) {
    const apk = deferred(), b = await fixture({ width, height, boundaries: {
      'services/app-native': { supportsHomeBackMode: () => true, isHarmonyOs: () => false,
        openInBrowser: noop, exitApp: noop, downloadApk: (_url, progress) => { progress(70, 100, 70); return apk.promise; },
        installApk: () => true },
    } });
    try {
      await b.mount(paths.upgrade, captureUpgrade([], updateInfo()), false);
      assert.equal(px(b, first(b, 'up-mask'), 'z-index'), 1800);
      for (const cls of ['up-title', 'up-version', 'up-badge-text', 'up-size']) {
        const node = first(b, cls), size = px(b, node, 'font-size');
        assert.ok(size >= 20, 'TV update ' + cls + ' readable font');
        assert.ok(px(b, node, 'line-height') >= size * 1.35, 'TV update ' + cls + ' explicit coherent line box');
      }
      assert.ok(px(b, first(b, 'up-card'), 'width') <= width - 56);
      assert.ok(px(b, first(b, 'up-card'), 'height') <= height - 56);
      assert.equal(px(b, b.button('直接下载'), 'height'), 56, 'original QtButton gets the shared TV target');
      assert.equal(b.button('直接下载').props['data-qt-tv-id'], 'upgrade-direct');
      assert.equal(b.button('浏览器下载').props['data-qt-tv-id'], 'upgrade-browser');
      assert.equal(b.button('以后再说').props['data-qt-tv-id'], 'upgrade-later');
      await b.dispatch(b.button('直接下载'));
      const progress = first(b, 'up-progress-text'), size = px(b, progress, 'font-size');
      assert.ok(size >= 20); assert.ok(px(b, progress, 'line-height') >= size * 1.35, 'download progress is TV-readable without a clipped short row');
      b.tv.qtSetTvMode('touch'); await b.flush();
      assert.equal(px(b, first(b, 'up-mask'), 'z-index'), 0);
      assert.equal(px(b, b.button('下载中...'), 'height'), 44, 'wide touch restores original small QtButton');
      assert.equal(px(b, first(b, 'up-title'), 'line-height'), 0, 'touch title retains original class-based natural line');
      apk.reject(new Error('cleanup fixture')); await b.flush();
    } finally { await b.close(); }
  }
};

cases['upgrade-busy-escape'] = async () => {
  const api = deferred(), apk = deferred(), calls = [], events = [];
  const b = await fixture({ boundaries: {
    'services/http': { apiRequest: (...args) => { calls.push(['http', args[0]]); return api.promise; } },
    'services/app-native': { supportsHomeBackMode: () => true, isHarmonyOs: () => false,
      openInBrowser: url => calls.push(['browser', url]), exitApp: () => calls.push(['exit']),
      downloadApk: (url, progress) => { calls.push(['download', url]); progress(40, 100, 40); return apk.promise; },
      installApk: path => { calls.push(['install', path]); return true; } },
  } });
  let underlyingBacks = 0, dispose = null;
  try {
    dispose = b.tv.qtTvRegisterScope({ root: { children: [], props: {} }, active: () => true,
      modal: true, priority: 1700, onBack: () => underlyingBacks++ });
    await b.mount(paths.upgrade, captureUpgrade(events, updateInfo({ isForce: true, isGithub: 1 })), false);
    await b.dispatch(b.button('直接下载'));
    assert.deepEqual(calls, [['http', 'app/github/accels']], 'original resolver owns acceleration discovery');
    assert.ok(b.text().includes('测速中...')); assert.equal(b.button('以后再说'), undefined);
    await remote(b, 'back'); await remote(b, 'ok', 1);
    assert.deepEqual(events, []); assert.equal(underlyingBacks, 0, 'probe Back is consumed by actual gate');
    api.resolve([]); await b.flush();
    assert.ok(b.text().includes('下载中...')); assert.ok(b.text().includes('40%'));
    assert.deepEqual(calls, [['http', 'app/github/accels'], ['download', 'https://fixture.example/app.apk']], 'empty acceleration list preserves original fallback download URL');
    await remote(b, 'back'); assert.deepEqual(events, []); assert.equal(underlyingBacks, 0);
    await b.dispatch(b.button('下载中...'));
    assert.equal(calls.filter(([name]) => name === 'download').length, 1, 'disabled direct action never starts a second download');
    apk.reject(new Error('fixture download failure')); await b.flush();
    assert.ok(b.button('以后再说'), 'existing download-failure escape exposes the original cancel action');
    assert.ok(b.toastCalls.some(value => value.title === 'fixture download failure'));
    await remote(b, 'back');
    assert.deepEqual(events, [['visible', false], ['closed']], 'post-failure Back follows escape permission through original cancel once');
    assert.equal(calls.filter(([name]) => name === 'install').length, 0);
  } finally { dispose?.(); await b.close(); }
};

cases['upgrade-install-contract'] = async () => {
  for (const [isForce, installerResult] of [[false, true], [true, true], [true, false]]) {
    const apk = deferred(), permissions = deferred(), save = deferred(), calls = [], events = [];
    const b = await fixture({ boundaries: {
      'services/app-native': { supportsHomeBackMode: () => true, isHarmonyOs: () => false, openInBrowser: noop, exitApp: noop,
        downloadApk: (url, progress) => { calls.push(['download', url]); progress(100, 100, 100); return apk.promise; },
        installApk: path => { calls.push(['install', path]); return installerResult; } },
      'uni_modules/qt-app-native': { ensurePublicDirPermission: () => { calls.push(['permission']); return permissions.promise; },
        saveToPublicMedia: (...args) => { calls.push(['save', ...args]); return save.promise; } },
    } });
    try {
      await b.mount(paths.upgrade, captureUpgrade(events, updateInfo({ isForce })), false);
      await b.dispatch(b.button('直接下载')); apk.resolve('fixture://temporary.apk'); await b.flush();
      assert.deepEqual(calls.map(([name]) => name), ['download', 'permission'], 'actual orchestration awaits public-dir permission before save/install');
      await remote(b, 'back'); assert.deepEqual(events, []);
      permissions.resolve(true); await b.flush();
      assert.deepEqual(calls[2], ['save', 'fixture://temporary.apk', 'download', '轻听音乐_v2.0.0-beta.apk', 'QtDownload/Update']);
      assert.equal(calls.some(([name]) => name === 'install'), false, 'installer waits for original async public save');
      save.resolve('fixture://public/QtDownload/Update/app.apk'); await b.flush();
      assert.deepEqual(calls[3], ['install', 'fixture://public/QtDownload/Update/app.apk']);
      if (!isForce) {
        assert.equal(b.clock.timeoutCount(600), 1, 'optional completion retains its original 600ms delayed close');
        await remote(b, 'back'); assert.deepEqual(events, [], 'optional completion remains busy until the original timer');
        await b.clock.runTimers(600); assert.deepEqual(events, [['visible', false], ['closed']]);
      } else {
        assert.equal(b.clock.timeoutCount(600), 0, 'forced completion never schedules optional closure');
        await remote(b, 'back');
        assert.deepEqual(events, installerResult ? [] : [['visible', false], ['closed']], 'forced installer-success stays gated; original failed-launch escape closes');
      }
    } finally { await b.close(); }
  }
};

cases['unmount-owned-timers'] = async () => {
  const mounted = Vue.ref(true), props = { visible: true, notice: terms() }, accepted = [];
  props.onAccepted = () => accepted.push('accepted');
  let b;
  const container = { __esModule: true, default: Vue.defineComponent({ setup: () => () => Vue.h('view', {},
    mounted.value ? Vue.h(b.load(paths.disclaimer).default, props) : null) }) };
  b = await fixture({ boundaries: { 'fixture-disclaimer-lifecycle': container } });
  try {
    b.load('uni_modules/qt-ui/composables/use-qt-layout.ts').resumeQtLayoutWatcher();
    const backgroundTimers = b.clock.intervalCount(1000);
    await b.mount('fixture-disclaimer-lifecycle', {}, false);
    assert.equal(b.clock.intervalCount(1000), backgroundTimers + 1);
    mounted.value = false; await b.flush();
    assert.equal(b.clock.intervalCount(1000), backgroundTimers, 'component unmount cancels only its interval before fixture-wide timer cleanup');
    await b.clock.runTimers(3000); assert.deepEqual(accepted, []);
    mounted.value = true; await b.flush();
    assert.ok(b.text().includes('请阅读（3s）'), 'a fresh mount gets its own complete countdown');
  } finally { await b.close(); }

  for (const stage of ['probe', 'scheduled-close']) {
    const api = deferred(), events = [], calls = [], mounted = Vue.ref(true);
    let b;
    const container = { __esModule: true, default: Vue.defineComponent({ setup: () => () => Vue.h('view', {},
      mounted.value ? Vue.h(b.load(paths.upgrade).default, captureUpgrade(events, updateInfo({ isGithub: stage === 'probe' ? 1 : 0 }))) : null) }) };
    b = await fixture({ boundaries: { 'fixture-upgrade-lifecycle': container,
      'services/http': { apiRequest: () => api.promise },
      'services/app-native': { supportsHomeBackMode: () => true, isHarmonyOs: () => false, openInBrowser: noop, exitApp: noop,
        downloadApk: async url => { calls.push(['download', url]); return 'fixture://temporary.apk'; },
        installApk: path => { calls.push(['install', path]); return true; } },
    } });
    try {
      await b.mount('fixture-upgrade-lifecycle', {}, false); await b.dispatch(b.button('直接下载'));
      if (stage === 'probe') {
        assert.ok(b.text().includes('测速中...')); assert.deepEqual(calls, []);
      } else {
        assert.deepEqual(calls, [['download', 'https://fixture.example/app.apk'], ['install', 'fixture://temporary.apk']]);
        assert.equal(b.clock.timeoutCount(600), 1);
      }
      mounted.value = false; await b.flush();
      assert.equal(b.clock.timeoutCount(600), 0, 'actual component cleanup clears a scheduled close, independent of fixture.close');
      api.resolve([]); await b.flush(); await b.clock.runTimers(600);
      assert.deepEqual(events, [], 'late resolver/timer does not emit a close from an unmounted dedicated shell');
      if (stage === 'probe') assert.deepEqual(calls, [], 'unmounted resolver does not start a native download');
    } finally { await b.close(); }
  }
};

cases['upgrade-back'] = async () => {
  const b = await fixture(), events = [], props = captureUpgrade(events);
  let dispose = null, underlyingBacks = 0;
  try {
    dispose = b.tv.qtTvRegisterScope({ root: { children: [], props: {} }, active: () => true,
      modal: true, priority: 1700, onBack: () => underlyingBacks++ });
    await b.mount(paths.upgrade, props, false);
    await remote(b, 'back');
    assert.equal(underlyingBacks, 0, 'optional upgrade Back acts on its mounted modal, not a lower notice');
    assert.deepEqual(events, [['visible', false], ['closed']], 'Back follows mask permission then original cancel and closes exactly once');
    assert.equal(b.collections.at(-1), first(b, 'up-card'));
    assert.ok(classes(first(b, 'up-mask')).includes('qt-tv-skip'));
    assert.ok(classes(first(b, 'up-card')).includes('qt-tv-skip'));
    assert.ok(classes(first(b, 'up-content')).includes('qt-tv-scroll'));
    events.length = 0;
    props.info = updateInfo({ isForce: true }); await b.flush();
    await remote(b, 'back'); await remote(b, 'back', 1);
    assert.deepEqual(events, [], 'forced upgrade Back respects maskClosable, not unconditional cancel');
    assert.equal(underlyingBacks, 0); assert.equal(b.button('以后再说'), undefined);
    await b.dispatch(b.button('浏览器下载'));
    assert.deepEqual(b.browserCalls, ['https://fixture.example/download']);
    assert.deepEqual(events, [], 'forced browser branch retains the original gate');
    props.info = updateInfo(); await b.flush();
    await b.dispatch(b.button('浏览器下载'));
    assert.deepEqual(events, [['visible', false], ['closed']], 'optional browser branch retains close event ordering');
  } finally { dispose?.(); await b.close(); }
};

cases['notice-density-events'] = async () => {
  for (const [width, height] of [[1280, 720], [800, 420], [800, 360]]) {
    const b = await fixture({ width, height }), events = [], props = Vue.reactive({ notice: splash({ url: 'https://fixture.example/notice' }), onClosed: value => events.push(value) });
    try {
      await b.mount(paths.notice, props, false);
      assert.equal(px(b, first(b, 'nts-mask'), 'z-index'), 1700);
      for (const cls of ['nts-title', 'nts-btn-text-primary', 'nts-btn-text-secondary', 'nts-check-text']) {
        const node = first(b, cls), size = px(b, node, 'font-size');
        assert.ok(size >= 20); assert.ok(px(b, node, 'line-height') >= size * 1.35, 'notice ' + cls + ' coherent TV text line');
      }
      for (const cls of ['nts-btn-primary', 'nts-btn-secondary', 'nts-check-row']) assert.ok(px(b, first(b, cls), 'min-height') >= 56, 'notice ' + cls + ' full-size remote target');
      assert.equal(first(b, 'nts-btn-primary').props['data-qt-tv-id'], 'notice-know');
      assert.equal(first(b, 'nts-btn-secondary').props['data-qt-tv-id'], 'notice-jump');
      assert.equal(first(b, 'qt-checkbox').props['data-qt-tv-id'], 'notice-hide-today');
      assert.ok(classes(first(b, 'nts-check-row')).includes('qt-tv-skip'), 'one checkbox focus target, not a duplicate clickable parent');
      assert.ok(px(b, first(b, 'nts-card'), 'width') <= width - 56);
      assert.ok(px(b, first(b, 'nts-card'), 'max-height') <= height - 56);
      await b.dispatch(first(b, 'qt-checkbox')); await remote(b, 'back');
      assert.deepEqual(events, [true], 'checkbox change.stop toggles once and original Back reports hideToday=true');
      events.length = 0; props.notice = splash({ id: 92, url: 'https://fixture.example/notice' }); await b.flush();
      await remote(b, 'back'); assert.deepEqual(events, [false], 'next notice resets the original hide-today flag');
      events.length = 0; await b.dispatch(first(b, 'nts-check-row'));
      await b.dispatch(first(b, 'nts-btn-secondary'));
      assert.deepEqual(b.browserCalls, ['https://fixture.example/notice'], 'actual openNoticeUrl reaches browser boundary');
      assert.deepEqual(events, [true], 'jump has exactly one close payload and never also invokes the mask');
      b.tv.qtSetTvMode('touch'); await b.flush();
      assert.equal(px(b, first(b, 'nts-btn-primary'), 'min-height'), 0);
      assert.equal(px(b, first(b, 'nts-mask'), 'z-index'), 0);
      assert.equal(px(b, first(b, 'nts-title'), 'line-height'), 0, 'wide touch leaves original title class line');
      assert.equal(px(b, first(b, 'nts-card'), 'max-height'), Math.max(260, height - 32));
    } finally { await b.close(); }
  }
  const b = await fixture({ mode: 'touch', width: 375, height: 800 }), events = [];
  try {
    await b.mount(paths.notice, { notice: splash(), onClosed: value => events.push(value) }, false);
    assert.equal(px(b, first(b, 'nts-card'), 'width'), 310, 'phone notice retains original 620rpx-equivalent card');
    assert.equal(b.css(first(b, 'nts-content'))['max-height'], '760rpx');
    await b.dispatch(first(b, 'nts-btn-primary')); assert.deepEqual(events, [false]);
    assert.deepEqual(b.exitCalls, []);
  } finally { await b.close(); }
};

cases['modal-priority-stack'] = async () => {
  const closed = [], updateClosed = [], accepted = [];
  const notice = Vue.reactive({ notice: splash(), onClosed: value => { closed.push(value); notice.notice = null; } });
  const upgrade = Vue.reactive({ visible: true, info: updateInfo(), 'onUpdate:visible': value => { updateClosed.push(['visible', value]); upgrade.visible = value; }, onClosed: () => updateClosed.push(['closed']) });
  const disclaimer = Vue.reactive({ visible: true, notice: terms({ readSeconds: 0 }), onAccepted: () => { accepted.push('accepted'); disclaimer.visible = false; } });
  let b;
  const container = { __esModule: true, default: Vue.defineComponent({ setup: () => () => Vue.h('view', {}, [
    Vue.h(b.load(paths.notice).default, notice), Vue.h(b.load(paths.upgrade).default, upgrade),
    Vue.h(b.load(paths.disclaimer).default, disclaimer),
    Vue.h(b.load(UI + 'qt-confirm-host/qt-confirm-host.uvue').default),
  ]) }) };
  b = await fixture({ boundaries: { 'fixture-overlays-stack': container, 'services/confirm': undefined } });
  let confirmation;
  try {
    await b.mount('fixture-overlays-stack', {}, false);
    confirmation = b.load('services/confirm.ts').qtConfirm({ title: '底层既有确认', content: '该确认不抢首启条款。' });
    await b.flush(); await remote(b, 'back');
    assert.equal(b.collections.at(-1), first(b, 'frd-card'), 'disclaimer3200 owns focus above actual confirmation3000');
    assert.deepEqual([closed, updateClosed, accepted], [[], [], []]);
    assert.equal(b.tv.qtTvFocus('upgrade-direct'), false, 'background upgrade target excluded by real modal containment');
    assert.equal(b.tv.qtTvFocus('disclaimer-confirm'), true); await remote(b, 'ok');
    assert.deepEqual(accepted, ['accepted']);
    let confirmed = false; confirmation.then(() => { confirmed = true; });
    await remote(b, 'back'); assert.equal(await confirmation, false); assert.equal(confirmed, true);
    assert.deepEqual(updateClosed, [], 'actual confirm Back never leaks into next upgrade');
    assert.equal(b.tv.qtTvFocus('upgrade-direct'), true, 'original upgrade becomes visible after higher gates release');
    assert.equal(b.tv.qtTvFocus('notice-know'), false, 'lower notice remains outside active scope');
    await remote(b, 'back'); assert.deepEqual(updateClosed, [['visible', false], ['closed']]);
    assert.deepEqual(closed, []); assert.equal(b.tv.qtTvFocus('notice-know'), true);
    await remote(b, 'back'); assert.deepEqual(closed, [false]);
    assert.deepEqual(b.exitCalls, [], 'all generic Back paths keep explicit locked exit separate');
    assert.deepEqual(b.nativeBacks, [], 'business modal stack never reaches native page Back');
    assert.equal(first(b, 'frd-mask'), undefined, 'accepted disclaimer no longer renders its visual scope');
  } finally { await b.close(); }
};

cases['real-richtext-scroll-links'] = async () => {
  const html = '<h2>标题片段</h2><p>普通正文片段</p><p><span style="font-size:7px;color:#333333">作者小字</span></p><ul><li>列表片段</li></ul><p><a href="https://fixture.example/rich-link">原真实链接</a></p><img src="fixture://image.png" />';
  for (const kind of ['disclaimer', 'upgrade', 'notice']) {
    const b = await fixture({ width: 800, height: 360 }), effects = [];
    try {
      b.fonts.useFontScaleStore().setTier('tiny'); await b.flush();
      const props = kind === 'disclaimer' ? { visible: true, notice: terms({ content: html }), onAccepted: () => effects.push('accepted') }
        : kind === 'upgrade' ? captureUpgrade(effects, updateInfo({ versionInfo: html }))
          : { notice: splash({ content: html }), onClosed: value => effects.push(value) };
      await b.mount(paths[kind], props, false);
      b.tv.qtTvRefreshFocus(); await b.flush();
      const rich = first(b, 'qrt'), body = first(b, kind === 'disclaimer' ? 'frd-content' : kind === 'upgrade' ? 'up-content' : 'nts-content');
      for (const fragment of ['标题片段', '普通正文片段', '作者小字', '列表片段', '原真实链接']) {
        const node = walk(rich).find(node => node.tag === 'text' && node.text === fragment);
        assert.ok(node, 'actual parser renders ' + kind + '/' + fragment);
        const size = px(b, node, 'font-size');
        assert.ok(size >= 20, 'actual TV run has its own readable font, including authored small text');
        assert.ok(px(b, node, 'line-height') >= 34, 'actual TV run retains complete 1.7 line box');
      }
      assert.ok(classes(body).includes('qt-tv-scroll'));
      assert.ok(![...b.candidates.values()].some(node => node === first(b, 'qrt-img')), 'inert image is not a remote target');
      assert.equal([...b.candidates.values()].filter(node => walk(rich).includes(node)).length, 1, 'only the real richtext link participates in focus');
      const bodyId = [...b.candidates.entries()].find(([, node]) => node === body)[0];
      assert.equal(b.tv.qtTvFocus(bodyId), true);
      b.clock.advance(100); await remote(b, 'up');
      assert.deepEqual(b.scrollCalls.at(-1), [bodyId, 'up'], 'readonly document routes to its original native scroll ancestor');
      const link = [...b.candidates.entries()].find(([, node]) => node.props.onClick && text(node) === '原真实链接');
      assert.ok(link); assert.equal(b.tv.qtTvFocus(link[0]), true);
      await remote(b, 'ok', 1); assert.deepEqual(b.browserCalls, []);
      await remote(b, 'ok'); assert.deepEqual(b.browserCalls, ['https://fixture.example/rich-link'], 'actual richtext onTap/openNoticeUrl fires once');
      assert.deepEqual(effects, [], 'rich links stop at the card, not mask/accept/dismiss');
      b.tv.qtSetTvMode('touch'); await b.flush();
      const plainRun = walk(rich).find(node => node.tag === 'text' && node.text === '普通正文片段');
      assert.equal(b.css(plainRun)['font-size'], undefined, 'original plain touch run style has no synthesized font override');
      assert.equal(b.css(plainRun)['line-height'], undefined, 'original touch run line behavior restored');
    } finally { await b.close(); }
  }
};

cases['upgrade-narrow-metadata-document'] = async () => {
  const versionName = '2.0.0-beta-' + 'release-candidate-'.repeat(30);
  const b = await fixture({ width: 480, height: 360 });
  try {
    b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
    await b.mount(paths.upgrade, captureUpgrade([], updateInfo({ versionName })), false);
    const body = first(b, 'up-content');
    for (const cls of ['up-header', 'up-title', 'up-version', 'up-badge-text', 'up-size']) {
      assert.ok(walk(body).includes(first(b, cls)), 'full narrow/huge update heading and metadata scroll with the original announcement instead of growing a pinned header');
    }
    assert.equal(text(first(b, 'up-version')), versionName, 'long release metadata remains intact');
    assert.equal(px(b, first(b, 'up-card'), 'height'), 304);
    b.tv.qtSetTvMode('touch'); await b.flush();
    assert.equal(walk(first(b, 'up-content')).includes(first(b, 'up-header')), false, 'touch retains its original compact external header');
  } finally { await b.close(); }
};

cases['upgrade-short-action-budget'] = async () => {
  for (const width of [480, 640, 800]) {
    const b = await fixture({ width, height: 360 }), events = [];
    try {
      await b.mount(paths.upgrade, captureUpgrade(events), false);
      for (const tier of ['tiny', 'normal', 'huge']) {
        b.fonts.useFontScaleStore().setTier(tier); await b.flush();
        const actions = first(b, 'up-actions'), slots = actions.children.filter(node => classes(node).includes('up-action'));
        const inner = px(b, first(b, 'up-card'), 'width') - 48;
        const oldEqualSlot = (inner - 24) / 3; // original three flex slots and two 12px gaps
        let rowWidth = 0, rowHeight = 0, totalHeight = 0;
        for (const slot of slots) {
          const button = walk(slot).find(node => classes(node).includes('qt-button'));
          const label = walk(button).find(node => classes(node).includes('qt-button-label'));
          const allocation = px(b, slot, 'width') || oldEqualSlot;
          const pad = b.css(button).padding.trim().split(/\s+/).map(Number.parseFloat);
          const horizontalPadding = pad.length === 1 ? pad[0] * 2 : pad[1] * 2;
          const completeLabel = text(label).length * px(b, label, 'font-size') + horizontalPadding + 2;
          assert.ok(allocation >= completeLabel, 'short TV ' + width + '/' + tier + ' gives complete ' + text(label) + ' label, actual padding and border their own action width');
          assert.ok(px(b, slot, 'width') > 0, 'TV action has a concrete native flex-basis width');
          rowWidth += allocation + px(b, slot, 'margin-right');
          rowHeight = Math.max(rowHeight, px(b, button, 'height'));
          if (px(b, slot, 'margin-right') === 0) {
            assert.ok(rowWidth <= inner, 'complete remote action row fits the original footer inner width');
            totalHeight += rowHeight; rowWidth = 0; rowHeight = 0;
            if (slot !== slots.at(-1)) totalHeight += 12;
          }
        }
        assert.equal(b.css(actions)['flex-wrap'], 'wrap');
        const remaining = px(b, first(b, 'up-card'), 'height') - 24 - totalHeight - 2;
        assert.ok(remaining >= 80, '304px short card retains a useful announcement viewport above complete pinned actions');
        assert.equal(px(b, first(b, 'up-content'), 'height'), remaining, 'original readonly viewport explicitly deducts each full action row and footer padding');
        assert.deepEqual(slots.flatMap(slot => walk(slot).filter(node => classes(node).includes('qt-button')).map(node => node.props['data-qt-tv-id'])), ['upgrade-later', 'upgrade-direct', 'upgrade-browser']);
      }
      b.tv.qtSetTvMode('touch'); await b.flush();
      assert.equal(b.css(first(b, 'up-actions'))['flex-wrap'], undefined, 'touch restores its original three-action or two-download row without a TV wrap override');
      for (const slot of b.byClass('up-action')) assert.equal(b.css(slot).width, undefined, 'touch original flexible action width is unchanged');
      await b.dispatch(b.button('以后再说'));
      assert.deepEqual(events, [['visible', false], ['closed']], 'original cancel public event order still fires once');
    } finally { await b.close(); }
  }
};

cases['long-title-document-budget'] = async () => {
  const fullTitle = '这是一份保持完整标题与完整正文的通知\n' + '很长的标题内容'.repeat(30);
  for (const width of [800, 480]) {
    for (const kind of ['disclaimer', 'notice']) {
      const b = await fixture({ width, height: 360 });
      try {
        b.fonts.useFontScaleStore().setTier('huge'); await b.flush();
        const props = kind === 'disclaimer' ? { visible: true, notice: terms({ title: fullTitle, url: 'https://fixture.example/terms' }) }
          : { notice: splash({ title: fullTitle, url: 'https://fixture.example/notice' }) };
        await b.mount(paths[kind], props, false);
        const cls = kind === 'disclaimer' ? 'frd' : 'nts';
        const title = first(b, cls + '-title'), body = first(b, cls + '-content'), card = first(b, cls + '-card');
        assert.equal(text(title), fullTitle, 'complete backend title is rendered without truncation or substitution');
        assert.ok(walk(body).includes(title), 'TV full title shares the original readonly document scroll budget instead of overflowing a one-line pinned header');
        assert.equal(title.props['max-lines'], undefined, 'long title remains fully reachable rather than an ellipsis-only header');
        assert.ok(px(b, body, 'height') >= 80, 'short huge-font document retains a useful scroll viewport above original pinned controls');
        assert.equal(px(b, card, 'max-height'), 304, 'long title never enlarges the centered card beyond its short pane');
        b.tv.qtSetTvMode('touch'); await b.flush();
        assert.equal(walk(first(b, cls + '-content')).includes(first(b, cls + '-title')), false, 'same-window touch restores the original external title placement');
        assert.equal(text(first(b, cls + '-title')), fullTitle);
      } finally { await b.close(); }
    }
  }
};

cases['notice-short-budget'] = async () => {
  for (const width of [800, 640, 480]) {
    const b = await fixture({ width, height: 360 });
    try {
      await b.mount(paths.notice, { notice: splash({ url: 'https://fixture.example/notice' }) }, false);
      for (const tier of ['tiny', 'normal', 'huge']) {
        b.fonts.useFontScaleStore().setTier(tier); await b.flush();
        const body = first(b, 'nts-content'), card = first(b, 'nts-card');
        assert.ok(px(b, body, 'height') >= 34, 'short TV ' + width + '/' + tier + ' keeps at least one readable scroll line');
        assert.equal(b.css(first(b, 'nts-actions'))['flex-direction'], 'row', 'short TV retains the existing two actions side by side');
        const know = first(b, 'nts-btn-primary'), jump = first(b, 'nts-btn-secondary'), check = first(b, 'nts-check-row');
        const row = Math.max(px(b, know, 'min-height'), px(b, jump, 'min-height'));
        const checkOwnLine = px(b, check, 'margin-top') > 0;
        const stack = 48 + px(b, body, 'height') + 16 + row + (checkOwnLine ? 12 + px(b, check, 'min-height') : 0);
        assert.ok(stack <= px(b, card, 'max-height'), 'styled header/body/action lines fit the actual 304px card budget');
        const inner = px(b, card, 'width') - 48;
        const checkReserved = checkOwnLine ? 0 : px(b, check, 'width') + 12;
        const actionWidth = (inner - checkReserved - 12) / 2;
        assert.ok(actionWidth >= px(b, first(b, 'nts-btn-text-primary'), 'font-size') * 4, 'complete know label fits its short-row allocation');
        assert.ok(actionWidth >= px(b, first(b, 'nts-btn-text-secondary'), 'font-size') * 4, 'complete jump label fits its short-row allocation');
        assert.ok(px(b, know, 'width') >= px(b, first(b, 'nts-btn-text-primary'), 'font-size') * 4 + 16, 'native row gets a concrete width, not a zero-basis flex-wrap action');
        assert.ok(px(b, jump, 'width') >= px(b, first(b, 'nts-btn-text-secondary'), 'font-size') * 4 + 16, 'native jump receives the same complete-label width contract');
        assert.ok(px(b, know, 'width') + 12 + px(b, jump, 'width') + checkReserved <= inner, 'actual action widths and check reservation fit their single row');
        assert.ok(px(b, check, 'width') <= inner, 'five-character hide-today label and native checkbox fit the actual pane');
      }
    } finally { await b.close(); }
  }
};

cases['notice-back-contract'] = async () => {
  const b = await fixture(), events = [], props = Vue.reactive({ notice: splash({ dialogClosable: 0 }), onClosed: value => events.push(value) });
  let underlyingBacks = 0, dispose = null;
  try {
    dispose = b.tv.qtTvRegisterScope({ root: { children: [], props: {} }, active: () => true,
      modal: true, priority: 1400, onBack: () => underlyingBacks++ });
    await b.mount(paths.notice, props, false);
    await remote(b, 'back'); await remote(b, 'back', 1);
    assert.equal(underlyingBacks, 0, 'locked splash consumes Back above the original player queue');
    assert.deepEqual(events, [], 'locked Back never emits ordinary notice close');
    assert.deepEqual(b.exitCalls, [], 'locked Back is mask permission, not explicit onKnow exit');
    assert.equal(b.collections.at(-1), first(b, 'nts-card'));
    assert.ok(classes(first(b, 'nts-mask')).includes('qt-tv-skip'));
    assert.ok(classes(first(b, 'nts-card')).includes('qt-tv-skip'));
    assert.ok(classes(first(b, 'nts-content')).includes('qt-tv-scroll'));
    assert.equal(first(b, 'nts-check-row'), undefined, 'locked splash retains original hidden hide-today control');
    const know = first(b, 'nts-btn-primary');
    const id = [...b.candidates.entries()].find(([, node]) => node === know)[0];
    assert.equal(b.tv.qtTvFocus(id), true); await remote(b, 'ok', 1);
    assert.deepEqual(b.exitCalls, []); await remote(b, 'ok');
    assert.deepEqual(b.exitCalls, ['exit'], 'only explicit original confirmation exits the locked notice once');
    props.notice = splash(); await b.flush();
    await remote(b, 'back'); assert.deepEqual(events, [false], 'closable notice Back retains public hide-today close payload');
    props.notice = null; await b.flush(); await remote(b, 'back');
    assert.equal(underlyingBacks, 1, 'null notice restores underlying modal owner');
  } finally { dispose?.(); await b.close(); }
};

export async function runTvOverlayChecks(selected = 'all') {
  const entries = selected === 'all' ? Object.entries(cases) : [[selected, cases[selected]]];
  assert.ok(entries.every(([, fn]) => typeof fn === 'function'), 'known public overlay case');
  for (const [name, fn] of entries) { await fn(); console.log('PASS TV overlays ' + name); }
  console.log('TV overlays: ' + entries.length + ' approved public-template groups passed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runTvOverlayChecks(process.argv[2] ?? 'all');
}
