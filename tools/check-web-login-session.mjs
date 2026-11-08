// Agreed public seam: complete onLoad/page actions -> native cookie/auth engine -> real credential storage/receipts.
// Executes actual web-login, registry, music-api, source-quality, source-auth and source-web-login modules.
// Only native WebView/cookies, installed-package filesystem facts, engine, Vue/store host and time are synthetic.
// No actual accounts, credentials, production requests, native compilation or device-login proof.
import assert from 'node:assert/strict';
import { read, load, host, deferred, drain, noop } from './check-source-auth-session.mjs';

const names = (path) => [...read(path).matchAll(/^export\s+(?:(?:async\s+)?function|const)\s+(\w+)/gm)].map((m) => m[1]);
const registryJson = (sources = ['wyy']) => JSON.stringify({ sources: sources.map((id) => ({
  id, name: id === 'wyy' ? '网易云' : id, short: id, color: '#111111',
  auth: { methods: ['cookie'], domains: ['auth.example.test'], webLogin: {
    url: `https://auth.example.test/${id}/login`, cookieMarkers: ['FIXTURE_LOGIN='],
    captureUrls: ['https://auth.example.test/'], note: '',
  } },
})), qualities: [] });
const validUser = (id = 'A') => JSON.stringify({ ok: true, user: {
  id, nickname: id === 'A' ? 'Alice' : 'Bob', avatar: '', vip: false, vipLabel: '',
} });
const cookie = (id = 'A') => [`FIXTURE_LOGIN=${id}; other=synthetic`];

function fixture({ holdInjection = false } = {}) {
  const b = host(), requests = [], cookies = [], native = { opens: [], closes: 0, current: null };
  const invokeSource = (name, args) => {
    if (name === 'sourceRegistry' || name === 'authImportCookie' || (name === 'setAuth' && holdInjection)) {
      const d = deferred(); requests.push({ name, args: JSON.parse(args)[0], ...d }); return d.promise;
    }
    return Promise.resolve('{}');
  };
  const service = load(read('services/source-auth.ts'), names('services/source-auth.ts'), {
    uni: b.uni, invokeSource, setMetaAuthHook: noop,
  });
  const quality = load(read('services/source-quality.ts'), names('services/source-quality.ts'), { uni: b.uni, invokeSource, ...service });
  const { musicApi } = load(read('services/music-api.ts'), ['musicApi'], {
    uni: b.uni, invokeSource, ...service, ...quality,
    ensureLocalStateRestored: async () => {}, activeMetaPack: () => ({ hash: 'fixture-package' }),
  });
  const source = load(read('stores/source.ts'), ['useSourceStore'], { uni: b.uni, reactive: (value) => value, logWarn: noop });
  const registryApi = load(read('stores/source-registry.ts'), ['useSourceRegistryStore'], {
    ...b.vue, uni: b.uni, reactive: (value) => value, ...source, ...quality, ...service, musicApi,
    SOURCE_PACKS_CHANGED_EVENT: 'fixture-source-packs-changed',
    usePlayerStore: () => ({ quality: '320' }), useDownloadsStore: () => ({ downloadQuality: '320' }),
  });
  const helpers = load(read('services/source-web-login.ts'), names('services/source-web-login.ts'));
  const logs = [], clock = { now: 10000 }, pageText = read('pages/web-login/index.uvue');
  const session = load(read('services/source-web-login-session.ts'), names('services/source-web-login-session.ts'));
  function createPage(h = host()) {
    h.hooks.hide = [];
    const page = load(pageText, ['retry', 'openNativeLogin', 'phase', 'webUrl', 'nativeOpen', 'nativeTip', 'statusText'], {
      ...h.vue, uni: { ...h.uni, navigateBack: (options) => h.routes.push(options) }, ...service, ...registryApi, ...helpers, ...session,
      Date: { now: () => clock.now }, onHide: (fn) => h.hooks.hide.push(fn),
      logErrV: (...args) => logs.push(args), useThemeStore: () => ({ skin: {} }), isAndroidOs: () => true,
      getWebCookies: (urls) => { const d = deferred(); cookies.push({ urls, ...d }); return d.promise; },
      openAuthWebView: (url, onClose, ua) => { const view = { url, onClose, ua }; native.opens.push(view); native.current = view; },
      closeAuthWebView: () => { native.closes++; native.current = null; },
    });
    return { ...h, page, loadPage: (source = 'wyy') => { for (const onLoad of h.hooks.load) onLoad({ source }); },
      flushTimeouts: () => { const tasks = [...h.timeouts.values()]; h.timeouts.clear(); for (const fn of tasks) fn(); },
    };
  }
  return { ...createPage(b), service, requests, cookies, native, logs, clock, createPage,
    registry: registryApi.useSourceRegistryStore(),
    ready: async (sources) => {
      const pending = registryApi.useSourceRegistryStore().ensure(); await drain();
      requests.find((r) => r.name === 'sourceRegistry').resolve(registryJson(sources)); await pending; await drain();
    },
  };
}
async function check(label, test) { await test(); console.log('  ✓ ' + label); }

await check('WEB-01: leaving during registry ensure must not open a departed page/native view', async () => {
  const b = fixture(); b.loadPage(); await drain();
  for (const onUnload of b.hooks.unload) onUnload();
  b.requests[0].resolve(registryJson()); await drain();
  assert.equal(b.native.opens.length, 0, 'late registry ensure must not open native login on the departed page');
  assert.equal(b.intervals.size, 0); assert.equal(b.cookies.length, 0); assert.equal(b.toasts.length, 0);
});
await check('WEB-02: a validated cookie arriving after unload cannot save or report login', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); b.cookies[0].resolve(cookie()); await drain();
  for (const onUnload of b.hooks.unload) onUnload();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain(); b.flushTimeouts();
  assert.equal(b.service.readSourceAuthEntries().length, 0, 'late validated cookie must not revive login after leaving');
  assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 0);
  assert.equal(b.toasts.length, 0); assert.equal(b.routes.length, 0); assert.equal(b.native.closes, 1);
});
await check('WEB-03: native cookies arriving after unload cannot start validation', async () => {
  const b = fixture(); await b.ready(); b.loadPage();
  for (const onUnload of b.hooks.unload) onUnload();
  b.cookies[0].resolve(cookie()); await drain();
  assert.equal(b.requests.filter((r) => r.name === 'authImportCookie').length, 0, 'withdrawn native cookies must not start an authentication request');
  assert.equal(b.toasts.length, 0); assert.equal(b.native.current, null);
});
await check('WEB-04: slow native cookie capture remains single-flight through validation', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); for (let i = 0; i < 5; i++) b.tick();
  assert.equal(b.cookies.length, 1, 'slow native cookie reads must not fan out on every timer tick');
  b.cookies[0].resolve(cookie()); await drain(); for (let i = 0; i < 5; i++) b.tick();
  assert.equal(b.cookies.length, 1, 'cookie capture cannot overlap an outstanding validation');
  const validations = b.requests.filter((r) => r.name === 'authImportCookie'); assert.equal(validations.length, 1);
  validations[0].resolve(validUser()); await drain(); b.flushTimeouts();
  assert.equal(b.service.readSourceAuthEntries()[0].account.cookie, 'FIXTURE_LOGIN=A; other=synthetic');
  assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 1); assert.equal(b.routes.length, 1);
});
await check('WEB-05: retrying B invalidates A validation and its finally cannot unlock B', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); b.cookies[0].resolve(cookie('A')); await drain();
  b.page.retry(); assert.equal(b.cookies.length, 2); assert.equal(b.native.opens.length, 1, 'retry retains the filled native WebView');
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser('A')); await drain();
  assert.equal(b.service.readSourceAuthEntries().length, 0, 'A validation cannot authenticate after retry B starts');
  b.tick(); assert.equal(b.cookies.length, 2, 'A finally cannot allow another B cookie read while B is pending');
  b.cookies[1].resolve(cookie('B')); await drain();
  b.requests.filter((r) => r.name === 'authImportCookie')[1].resolve(validUser('B')); await drain();
  assert.equal(b.service.readSourceAuthEntries()[0].account.user.id, 'B');
});
await check('WEB-06: embedded page unmount closes native login and discards pending cookies', async () => {
  const b = fixture(); await b.ready(); b.loadPage();
  for (const onUnmounted of b.hooks.unmounted) onUnmounted();
  assert.equal(b.native.current, null, 'embedded page unmount must close its native view');
  b.cookies[0].resolve(cookie()); await drain();
  assert.equal(b.requests.filter((r) => r.name === 'authImportCookie').length, 0);
  for (const onUnload of b.hooks.unload) onUnload(); assert.equal(b.native.closes, 1, 'double lifecycle cleanup is idempotent');
});
await check('WEB-07: credential removal during validation revokes the interactive submission', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); b.cookies[0].resolve(cookie()); await drain();
  await b.service.removeSourceAuthAccount('wyy');
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
  assert.equal(b.service.readSourceAuthEntries().length, 0, 'logout/removal must not be reversed by an older web validation');
  assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 0);
});
await check('WEB-08: leaving during real credential injection suppresses stale success/navigation', async () => {
  const b = fixture({ holdInjection: true }); await b.ready(); b.loadPage(); b.cookies[0].resolve(cookie()); await drain();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
  assert.equal(b.service.readSourceAuthEntries().length, 1, 'validation already accepted before leaving is not rolled back');
  for (const onUnload of b.hooks.unload) onUnload();
  b.requests.find((r) => r.name === 'setAuth').resolve('{}'); await drain(); b.flushTimeouts();
  assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 0, 'a departed page cannot report late injection success');
  assert.equal(b.toasts.length, 0); assert.equal(b.routes.length, 0); assert.equal(b.native.closes, 1);
});
await check('WEB-09: leaving after the success receipt cancels its delayed navigateBack', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); b.cookies[0].resolve(cookie()); await drain();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
  assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 1);
  for (const onUnload of b.hooks.unload) onUnload(); b.flushTimeouts();
  assert.equal(b.routes.length, 0, 'old success timer must not navigate away from a later page');
});
await check('WEB-10: native close callbacks from a departed page remain silent', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); const oldView = b.native.current;
  for (const onUnload of b.hooks.unload) onUnload(); oldView.onClose('fixture late close');
  assert.equal(b.toasts.length, 0, 'departed native callback must not display a stale warning');
});
await check('WEB-11: departed retry/reopen actions cannot revive timers or native login', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); for (const onUnload of b.hooks.unload) onUnload();
  b.page.retry(); b.page.openNativeLogin();
  assert.equal(b.native.opens.length, 1, 'a departed action must not open another native login');
  assert.equal(b.intervals.size, 0); assert.equal(b.cookies.length, 1);
});
await check('WEB-12: an old native callback cannot mark a newer same-page view closed', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); const oldView = b.native.current;
  b.page.openNativeLogin(); const nextView = b.native.current; oldView.onClose('fixture stale native close');
  assert.equal(b.page.nativeOpen.value, true, 'A close callback cannot overwrite B native view state');
  assert.equal(b.native.current, nextView); assert.equal(b.toasts.length, 0);
});
await check('WEB-13: unloading A cannot close the shared native WebView now owned by page B', async () => {
  const b = fixture(); await b.ready(['wyy', 'qq']); b.loadPage(); const nextPage = b.createPage(); nextPage.loadPage('qq');
  const nextView = b.native.current; for (const onUnload of b.hooks.unload) onUnload();
  assert.equal(b.native.current, nextView, 'A cleanup must not close B native login');
  assert.equal(b.native.closes, 0); nextPage.page.openNativeLogin(); assert.equal(b.native.opens.length, 3);
});
await check('WEB-14: page B takes over authentication; old A validation/actions cannot save or close B', async () => {
  const b = fixture(); await b.ready(['wyy', 'qq']); b.loadPage(); b.cookies[0].resolve(cookie()); await drain();
  const oldView = b.native.current, nextPage = b.createPage(); nextPage.loadPage('qq'); const nextView = b.native.current;
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
  oldView.onClose('fixture old owner'); b.page.retry(); b.page.openNativeLogin(); b.flushTimeouts();
  assert.equal(b.service.readSourceAuthEntries().length, 0); assert.equal(b.native.current, nextView);
  assert.equal(b.native.opens.length, 2); assert.equal(b.native.closes, 0); assert.equal(b.toasts.length, 0); assert.equal(b.routes.length, 0);
  b.cookies[1].resolve(cookie('B')); await drain();
  b.requests.filter((r) => r.name === 'authImportCookie')[1].resolve(validUser('B')); await drain();
  assert.equal(b.service.readSourceAuthEntries()[0].source, 'qq'); assert.equal(nextPage.events.filter((e) => e[0] === 'qt-weblogin-done').length, 1);
});
await check('WEB-15: invalid cookies notify once, transient validation errors unlock a normal retry', async () => {
  const b = fixture(); await b.ready(); b.loadPage();
  for (let i = 0; i < 2; i++) {
    b.cookies[i].resolve(cookie()); await drain(); b.requests.filter((r) => r.name === 'authImportCookie')[i].resolve('{"ok":false}'); await drain(); b.tick();
  }
  assert.equal(b.toasts.length, 1); assert.equal(b.service.readSourceAuthEntries().length, 0);
  b.cookies[2].resolve(cookie()); await drain(); b.requests.filter((r) => r.name === 'authImportCookie')[2].reject(new Error('fixture transient')); await drain(); b.tick();
  b.cookies[3].resolve(cookie('B')); await drain(); b.requests.filter((r) => r.name === 'authImportCookie')[3].resolve(validUser('B')); await drain();
  assert.equal(b.service.readSourceAuthEntries()[0].account.user.id, 'B'); assert.equal(b.logs.length, 1);
});
await check('WEB-16: dismissing the native dialog preserves cookie polling and official-app handoff', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); const view = b.native.current; b.native.current = null; view.onClose('');
  assert.equal(b.page.phase.value, 'polling'); assert.equal(b.intervals.size, 1); assert.match(b.page.nativeTip.value, /已关闭/);
  for (const onHide of b.hooks.hide ?? []) onHide();
  b.cookies[0].resolve(cookie()); await drain(); b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
  assert.equal(b.service.readSourceAuthEntries().length, 1); assert.equal(b.native.closes, 0);
});
await check('WEB-17: deterministic timeout discards pending cookies; retry preserves the filled WebView', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); b.clock.now += 180000; b.tick();
  assert.equal(b.page.phase.value, 'timeout'); assert.equal(b.intervals.size, 0); b.cookies[0].resolve(cookie()); await drain();
  assert.equal(b.requests.filter((r) => r.name === 'authImportCookie').length, 0);
  b.page.retry(); assert.equal(b.native.opens.length, 1); b.cookies[1].resolve(cookie('B')); await drain();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser('B')); await drain(); assert.equal(b.service.readSourceAuthEntries()[0].account.user.id, 'B');
});
await check('WEB-18: validation beyond the deadline is rejected even before the next timer tick', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); b.cookies[0].resolve(cookie()); await drain(); b.clock.now += 180000;
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
  assert.equal(b.service.readSourceAuthEntries().length, 0, 'the deadline is a wall-clock boundary, not just a timer hint');
  assert.equal(b.page.phase.value, 'timeout'); assert.equal(b.intervals.size, 0);
});
await check('WEB-19: stale validation errors after retry/unload/removal have no diagnostics or receipts', async () => {
  for (const reason of ['retry', 'unload', 'removal']) {
    const b = fixture(); await b.ready(); b.loadPage(); b.cookies[0].resolve(cookie()); await drain();
    if (reason === 'retry') b.page.retry();
    if (reason === 'unload') for (const onUnload of b.hooks.unload) onUnload();
    if (reason === 'removal') await b.service.removeSourceAuthAccount('wyy');
    b.requests.find((r) => r.name === 'authImportCookie').reject(new Error('fixture stale ' + reason)); await drain();
    assert.equal(b.logs.length, 0, 'revoked validation errors must remain inert: ' + reason); assert.equal(b.toasts.length, 0);
  }
});
await check('WEB-20: a real storage failure restarts polling instead of leaving a stopped polling phase', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); const writeStorage = b.uni.setStorageSync; let failOnce = true;
  b.uni.setStorageSync = (key, value) => { if (failOnce) { failOnce = false; throw new Error('fixture storage full'); } writeStorage(key, value); };
  b.cookies[0].resolve(cookie()); await drain(); b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
  assert.equal(b.intervals.size, 1, 'a live save failure needs a real running poll timer'); assert.equal(b.page.phase.value, 'polling');
  assert.equal(b.logs.length, 1); assert.equal(b.service.readSourceAuthEntries().length, 0);
  b.cookies[1].resolve(cookie('B')); await drain(); b.requests.filter((r) => r.name === 'authImportCookie')[1].resolve(validUser('B')); await drain();
  assert.equal(b.service.readSourceAuthEntries()[0].account.user.id, 'B'); assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 1);
});
await check('WEB-21: leaving during failed storage cannot revive polling or report the failure', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); const writeStorage = b.uni.setStorageSync; let failOnce = true;
  b.uni.setStorageSync = (key, value) => { if (failOnce) { failOnce = false; for (const onUnload of b.hooks.unload) onUnload(); throw new Error('fixture departed storage'); } writeStorage(key, value); };
  b.cookies[0].resolve(cookie()); await drain(); b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain(); b.flushTimeouts();
  assert.equal(b.service.readSourceAuthEntries().length, 0); assert.equal(b.toasts.length, 0); assert.equal(b.logs.length, 0); assert.equal(b.intervals.size, 0); assert.equal(b.routes.length, 0);
});
await check('WEB-22: a departed missing-source page cancels its failure navigateBack timer', async () => {
  const b = fixture(); await b.ready(); b.loadPage(''); assert.equal(b.toasts.length, 1);
  for (const onUnload of b.hooks.unload) onUnload(); b.flushTimeouts(); assert.equal(b.routes.length, 0, 'an old failure timer cannot pop a later page');
});
await check('WEB-23: retained A can explicitly retry after B unloads and A is shown again', async () => {
  const b = fixture(); await b.ready(['wyy', 'qq']); b.loadPage(); const nextPage = b.createPage(); nextPage.loadPage('qq');
  for (const onUnload of nextPage.hooks.unload) onUnload(); for (const onShow of b.hooks.show) onShow(); b.page.retry();
  assert.equal(b.cookies.length, 3, 'returned A must not be permanently locked behind a dead B owner');
  assert.equal(b.native.opens.length, 3); assert.equal(b.page.phase.value, 'polling');
  b.cookies[0].resolve(cookie('OLD-A')); b.cookies[1].resolve(cookie('OLD-B')); await drain();
  assert.equal(b.requests.filter((r) => r.name === 'authImportCookie').length, 0, 'returning must not revive either old flow');
  b.cookies[2].resolve(cookie('A')); await drain(); b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser('A')); await drain();
  assert.equal(b.service.readSourceAuthEntries()[0].account.user.id, 'A'); assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 1);
});
await check('WEB-24: ordinary hide/show handoff preserves the current native view and pending validation', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); const view = b.native.current;
  for (const onHide of b.hooks.hide) onHide(); for (const onShow of b.hooks.show) onShow(); for (const onShow of b.hooks.show) onShow();
  assert.equal(b.native.current, view); assert.equal(b.native.opens.length, 1); assert.equal(b.cookies.length, 1);
  b.cookies[0].resolve(cookie()); await drain(); b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain(); assert.equal(b.service.readSourceAuthEntries().length, 1);
});
await check('WEB-25: account removal during held real injection revokes the final success receipt', async () => {
  const b = fixture({ holdInjection: true }); await b.ready(); b.loadPage(); b.cookies[0].resolve(cookie()); await drain();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain(); const removal = b.service.removeSourceAuthAccount('wyy');
  b.requests.find((r) => r.name === 'setAuth').resolve('{}'); await removal; await drain(); b.flushTimeouts();
  assert.equal(b.service.readSourceAuthEntries().length, 0); assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 0);
  assert.equal(b.toasts.length, 0); assert.equal(b.routes.length, 0); assert.equal(b.page.phase.value, 'cancelled');
});
await check('WEB-26: newer page takeover during held injection suppresses A receipt without closing B', async () => {
  const b = fixture({ holdInjection: true }); await b.ready(['wyy', 'qq']); b.loadPage(); b.cookies[0].resolve(cookie()); await drain();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain(); const nextPage = b.createPage(); nextPage.loadPage('qq'); const nextView = b.native.current;
  b.requests.find((r) => r.name === 'setAuth').resolve('{}'); await drain(); b.flushTimeouts();
  assert.equal(b.native.current, nextView); assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 0); assert.equal(b.toasts.length, 0); assert.equal(b.routes.length, 0);
});
await check('WEB-27: native cookies returned beyond the deadline never reach authentication', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); b.clock.now += 180000; b.cookies[0].resolve(cookie()); await drain();
  assert.equal(b.requests.filter((r) => r.name === 'authImportCookie').length, 0); assert.equal(b.page.phase.value, 'timeout'); assert.equal(b.intervals.size, 0);
});
await check('WEB-28: normal success commits once, closes once, emits once and navigates once', async () => {
  const b = fixture(); await b.ready(); b.loadPage(); b.cookies[0].resolve(cookie()); await drain();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain(); b.tick(); b.flushTimeouts(); b.flushTimeouts();
  assert.equal(b.service.readSourceAuthEntries().length, 1); assert.equal(b.toasts.length, 1); assert.equal(b.native.closes, 1);
  assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 1); assert.equal(b.routes.length, 1); assert.equal(b.intervals.size, 0);
});
await check('WEB-29: retained startup wait stays revoked, but explicit retry can use its now-ready registry', async () => {
  const b = fixture(); b.loadPage(); const nextPage = b.createPage(); nextPage.loadPage();
  for (const onUnload of nextPage.hooks.unload) onUnload(); for (const onShow of b.hooks.show) onShow(); await b.ready();
  assert.equal(b.native.opens.length, 0, 'returning does not silently revive the old startup wait');
  b.page.retry(); assert.equal(b.native.opens.length, 1, 'explicit retry re-reads the registry after startup was interrupted');
  b.cookies[0].resolve(cookie()); await drain(); b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain(); assert.equal(b.service.readSourceAuthEntries().length, 1);
});
await check('WEB-30: retained A returning during held save is cancellable/retryable, never stuck in done', async () => {
  const b = fixture({ holdInjection: true }); await b.ready(); b.loadPage(); b.cookies[0].resolve(cookie()); await drain();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain(); const nextPage = b.createPage(); nextPage.loadPage();
  for (const onUnload of nextPage.hooks.unload) onUnload(); for (const onShow of b.hooks.show) onShow();
  assert.equal(b.page.phase.value, 'cancelled', 'an interrupted old done phase must not permanently hide the retry control');
  b.requests.find((r) => r.name === 'setAuth').resolve('{}'); await drain(); b.flushTimeouts(); assert.equal(b.toasts.length, 0); assert.equal(b.routes.length, 0);
  b.page.retry(); assert.equal(b.page.phase.value, 'polling'); assert.equal(b.cookies.length, 3);
});
await check('WEB-31: withdrawal inside actual native storage readback cannot report the returned old receipt', async () => {
  const b = fixture({ holdInjection: true }); await b.ready(); b.loadPage();
  b.cookies[0].resolve(cookie()); await drain();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
  const readStorage = b.uni.getStorageSync; let armed = true, withdrawals = 0;
  b.uni.getStorageSync = (key) => {
    const oldValue = readStorage(key);
    if (armed && typeof oldValue === 'string' && oldValue.includes('FIXTURE_LOGIN=A')) {
      armed = false; withdrawals++;
      for (const onUnload of b.hooks.unload) onUnload();
    }
    return oldValue;
  };
  b.requests.find((r) => r.name === 'setAuth').resolve('{}'); await drain();
  assert.equal(withdrawals, 1, 'the public receipt must actually cross the native read boundary');
  assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 0, 'a withdrawn readback cannot emit an old login success');
  assert.equal(b.toasts.length, 0); assert.equal(b.timeouts.size, 0); b.flushTimeouts(); assert.equal(b.routes.length, 0);
});
await check('WEB-32: removal during actual native storage write cannot be adopted as the save revision', async () => {
  const b = fixture(); await b.ready(); b.loadPage();
  const writeStorage = b.uni.setStorageSync; let armed = true, withdrawals = 0;
  b.uni.setStorageSync = (key, value) => {
    writeStorage(key, value);
    if (armed && typeof value === 'string' && value.includes('FIXTURE_LOGIN=A')) {
      armed = false; withdrawals++; void b.service.removeSourceAuthAccount('wyy');
    }
  };
  b.cookies[0].resolve(cookie()); await drain();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
  assert.equal(withdrawals, 1, 'the actual save must cross a revoking native write boundary');
  assert.equal(b.service.readSourceAuthEntries().length, 0);
  assert.equal(b.logs.length, 0, 'a withdrawn save must not report its stale storage failure');
  assert.equal(b.toasts.length, 0); assert.equal(b.intervals.size, 0); assert.equal(b.timeouts.size, 0);
  assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 0);
});
await check('WEB-33: an unchanged old account with different extras cannot substitute for the new saved payload', async () => {
  const b = fixture(); await b.ready();
  const oldExtras = '{"refresh_token":"fixture-old-extra"}';
  await b.service.saveSourceAuthAccount('wyy', cookie()[0], JSON.parse(validUser()).user, oldExtras);
  b.loadPage(); b.uni.setStorageSync = () => { throw new Error('fixture storage full'); };
  b.cookies[0].resolve(cookie()); await drain();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
  assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 0, 'old matching cookie/user cannot certify that empty extras were committed');
  assert.equal(b.logs.length, 1); assert.equal(b.intervals.size, 1); assert.equal(b.page.phase.value, 'polling');
  assert.equal(b.service.readSourceAuthEntries()[0].account.extrasJson, oldExtras, 'the native failure must really leave the old stored extras');
});
await check('WEB-34: leaving inside the native dialog-close boundary prevents the later credential save', async () => {
  const b = fixture(); await b.ready(); b.loadPage();
  let nativeView = b.native.current, armed = true, withdrawals = 0;
  Object.defineProperty(b.native, 'current', {
    get: () => nativeView,
    set: (view) => {
      nativeView = view;
      if (view == null && armed) {
        armed = false; withdrawals++;
        for (const onUnload of b.hooks.unload) onUnload();
      }
    },
  });
  b.cookies[0].resolve(cookie()); await drain();
  b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
  assert.equal(withdrawals, 1, 'the native dialog must actually close before the withdrawal');
  assert.equal(b.service.readSourceAuthEntries().length, 0, 'native close withdrawal cannot authorize a later credential write');
  assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 0);
  assert.equal(b.toasts.length, 0); assert.equal(b.intervals.size, 0); assert.equal(b.timeouts.size, 0);
});
await check('WEB-35: other readback revocations stay silent and cannot disturb the newly opened native view', async () => {
  for (const reason of ['unmount', 'removal', 'takeover', 'retry']) {
    const b = fixture({ holdInjection: true }); await b.ready(); b.loadPage();
    b.cookies[0].resolve(cookie()); await drain();
    b.requests.find((r) => r.name === 'authImportCookie').resolve(validUser()); await drain();
    const readStorage = b.uni.getStorageSync; let armed = true, withdrawals = 0;
    b.uni.getStorageSync = (key) => {
      const oldValue = readStorage(key);
      if (armed && typeof oldValue === 'string' && oldValue.includes('FIXTURE_LOGIN=A')) {
        armed = false; withdrawals++;
        if (reason === 'unmount') for (const onUnmount of b.hooks.unmounted) onUnmount();
        if (reason === 'removal') void b.service.removeSourceAuthAccount('wyy');
        if (reason === 'takeover') b.createPage().loadPage();
        if (reason === 'retry') b.page.retry();
      }
      return oldValue;
    };
    b.requests.find((r) => r.name === 'setAuth').resolve('{}'); await drain();
    assert.equal(withdrawals, 1, reason + ' must cross the actual native readback');
    assert.equal(b.events.filter((e) => e[0] === 'qt-weblogin-done').length, 0, reason + ' cannot report the preceding snapshot');
    assert.equal(b.toasts.length, 0); assert.equal(b.logs.length, 0); assert.equal(b.timeouts.size, 0);
    const currentView = b.native.current, closeCount = b.native.closes;
    b.flushTimeouts(); assert.equal(b.routes.length, 0); assert.equal(b.native.current, currentView); assert.equal(b.native.closes, closeCount);
  }
});
console.log('Web-login session: 35 passed (actual page/services; synthetic native/engine/host boundaries).');
