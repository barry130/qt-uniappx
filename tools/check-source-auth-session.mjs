// Agreed seam: run the complete UVue page script and real source-auth service.
// Only engine, native filesystem/storage, time and Vue host boundaries are synthetic.
// This does not compile Vapor or authenticate against any real third-party account.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
export const noop = () => {};
export class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return Object.hasOwn(this, key) ? this[key] : null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}
export function parseJsonToUtso(text) {
  function convert(value) {
    if (Array.isArray(value)) return value.map(convert);
    if (value != null && typeof value === 'object') {
      return new UTSJSONObject(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)])));
    }
    return value;
  }
  return convert(JSON.parse(text));
}
export function load(text, names, extra = {}) {
  const script = text.includes('<script setup') ? text.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1] : text;
  const cleaned = script.replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, '');
  const js = stripTypeScriptTypes(cleaned, { mode: 'strip' })
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var))/g, '');
  const context = vm.createContext({ console, UTSJSONObject, parseJsonToUtso, ...extra });
  vm.runInContext(js + `\n;globalThis.__api={${names.join(',')}};`, context);
  return context.__api;
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function drain() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
export function host() {
  const storage = new Map(), intervals = new Map(), timeouts = new Map();
  const hooks = { load: [], show: [], unload: [], unmounted: [] };
  const toasts = [], files = [], events = [], routes = [];
  let nextTimer = 1;
  const uni = {
    env: { CACHE_PATH: '/fixture/cache' },
    getStorageSync: (key) => storage.get(key) ?? '',
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    getFileSystemManager: () => ({ writeFileSync: (...args) => files.push(args) }),
    $emit: (...args) => events.push(args), $on: noop, $off: noop,
    reLaunch: (opts) => routes.push(opts), navigateTo: (opts) => routes.push(opts),
  };
  const vue = {
    ref: (value) => ({ value }),
    computed: (get) => ({ get value() { return get(); } }),
    onLoad: (fn) => hooks.load.push(fn), onShow: (fn) => hooks.show.push(fn),
    onUnload: (fn) => hooks.unload.push(fn), onUnmounted: (fn) => hooks.unmounted.push(fn),
    setInterval: (fn) => { const id = nextTimer++; intervals.set(id, fn); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { const id = nextTimer++; timeouts.set(id, fn); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    qtShowToast: (message) => toasts.push(message),
  };
  return { storage, intervals, timeouts, hooks, toasts, files, events, routes, uni, vue,
    tick: () => { for (const fn of [...intervals.values()]) fn(); } };
}
const serviceNames = [...read('services/source-auth.ts').matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1]);
const syncNames = [...read('services/source-playlist-sync.ts').matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1]);
export function qrFixture({ holdInjection = false } = {}) {
  const b = host(), requests = [], injections = [];
  const invokeSource = (name, args) => {
    if (name === 'setAuth' && holdInjection) {
      const d = deferred(); injections.push({ name, args: JSON.parse(args)[0], ...d }); return d.promise;
    }
    if (name !== 'authQrCreate' && name !== 'authQrPoll') return Promise.resolve('{}');
    const d = deferred(); requests.push({ name, args: JSON.parse(args)[0], ...d }); return d.promise;
  };
  const service = load(read('services/source-auth.ts'), serviceNames, {
    uni: b.uni, invokeSource, setMetaAuthHook: noop,
  });
  const player = { savedPlaylists: [] };
  const sync = load(read('services/source-playlist-sync.ts'), syncNames, { ...service, usePlayerStore: () => player });
  const page = load(read('pages/source-auth/index.uvue'), [
    'startQr', 'regenerateQr', 'closeQrSheet',
    'qrVisible', 'qrBusy', 'qrSource', 'qrKey', 'qrStatusText',
  ], {
    ...b.vue, uni: b.uni, ...service, ...sync,
    SOURCE_AUTH_CHANGED_EVENT: 'qt-source-auth-changed', WEB_LOGIN_DONE_EVENT: 'qt-web-login-done',
    useThemeStore: () => ({ skin: {} }), useQtLayout: () => ({ windowHeight: 800, safeBottomPx: 0, isWide: false }),
    useSourceRegistryStore: () => ({ sources: [], ensure: async () => {}, label: (s) => s }),
    usePlayerStore: () => player, useDownloadsStore: () => ({}), useQtSelectionReveal: () => ({}),
  });
  return { ...b, page, service, requests, injections };
}
const session = (key = 'A') => JSON.stringify({ key, image: 'data:image/png;base64,cG5n', expiresInSec: 180 });
const confirmed = (cookie = 'cookie-A') => JSON.stringify({ status: 'confirmed', credential: { cookie }, user: {
  id: 'account-A', nickname: 'Alice', avatar: '', vip: false, vipLabel: '',
} });
async function check(label, test) { await test(); console.log('  ✓ ' + label); }

export async function runQrChecks() {
  await check('QR-01: leaving during create cannot reopen the QR sheet or restart polling', async () => {
    const b = qrFixture();
    b.page.startQr('wyy', '网易云');
    assert.equal(b.requests.length, 1);
    for (const unload of b.hooks.unload) unload();
    b.requests[0].resolve(session()); await drain();
    assert.equal(b.page.qrVisible.value, false, 'late create must not reopen a departed page');
    assert.equal(b.intervals.size, 0, 'departed page must not restart polling');
    assert.equal(b.files.length, 0, 'late create must not publish a QR image');
    assert.equal(b.service.readSourceAuthEntries().length, 0);
  });
  await check('QR-02: canceling while confirmation is in flight cannot save an account', async () => {
    const b = qrFixture();
    b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain();
    b.tick(); assert.equal(b.requests[1].name, 'authQrPoll');
    b.page.closeQrSheet();
    b.requests[1].resolve(confirmed()); await drain();
    assert.equal(b.service.readSourceAuthEntries().length, 0, 'canceled QR confirmation must not authenticate');
    assert.equal(b.toasts.filter((t) => t.title.startsWith('已登录')).length, 0);
    assert.equal(b.intervals.size, 0);
  });
  await check('QR-03: slow polling remains single-flight and confirmation authenticates once', async () => {
    const b = qrFixture();
    b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain();
    for (let i = 0; i < 5; i++) b.tick();
    assert.equal(b.requests.filter((r) => r.name === 'authQrPoll').length, 1, 'one slow poll must not fan out on timer ticks');
    b.requests[1].resolve(confirmed()); await drain();
    assert.equal(b.service.readSourceAuthEntries()[0].account.cookie, 'cookie-A');
    assert.equal(b.toasts.filter((t) => t.title.startsWith('已登录')).length, 1);
    assert.equal(b.page.qrVisible.value, false);
    assert.equal(b.intervals.size, 0);
  });
  await check('QR-04: unmounting an embedded pane invalidates its pending QR create', async () => {
    const b = qrFixture(); b.page.startQr('wyy', '网易云');
    for (const unmounted of b.hooks.unmounted) unmounted();
    b.requests[0].resolve(session()); await drain();
    assert.equal(b.page.qrVisible.value, false, 'unmounted settings pane must not accept a late create');
    assert.equal(b.intervals.size, 0);
  });
  await check('QR-05: removing a source account invalidates its in-flight QR confirmation', async () => {
    const b = qrFixture();
    b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain(); b.tick();
    await b.service.removeSourceAuthAccount('wyy');
    b.requests[1].resolve(confirmed()); await drain();
    assert.equal(b.service.readSourceAuthEntries().length, 0, 'removed credentials must not be revived by an older QR flow');
    assert.equal(b.toasts.filter((t) => t.title.startsWith('已登录')).length, 0);
    assert.equal(b.intervals.size, 0);
  });
  await check('QR-06: regenerating B ignores A confirmation and A finally cannot unlock B poll', async () => {
    const b = qrFixture();
    b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session('A')); await drain(); b.tick();
    b.page.regenerateQr(); b.requests[2].resolve(session('B')); await drain(); b.tick();
    b.requests[1].resolve(confirmed()); await drain();
    assert.equal(b.page.qrKey.value, 'B'); assert.equal(b.page.qrVisible.value, true);
    assert.equal(b.service.readSourceAuthEntries().length, 0);
    b.tick(); assert.equal(b.requests.length, 4, 'A finally cannot allow another B request while B is pending');
    b.requests[3].resolve(JSON.stringify({ status: 'scanned' })); await drain();
    assert.equal(b.page.qrStatusText.value, '已扫码，请在手机上确认');
    b.tick(); assert.equal(b.requests.length, 5, 'B may poll again after its own request settles');
  });
  await check('QR-07: canceling create A permits B while A rejection cannot clear B busy or toast', async () => {
    const b = qrFixture(); b.page.startQr('wyy', '网易云'); b.page.closeQrSheet();
    b.page.startQr('qq', 'QQ音乐'); assert.equal(b.requests.length, 2);
    b.requests[0].reject(new Error('late A failure')); await drain();
    assert.equal(b.page.qrBusy.value, true); assert.equal(b.toasts.length, 0);
    b.requests[1].resolve(session('B')); await drain();
    assert.equal(b.page.qrSource.value, 'qq'); assert.equal(b.page.qrKey.value, 'B');
    assert.equal(b.page.qrBusy.value, false);
  });
  await check('QR-08: unloading during poll prevents account persistence and login receipt', async () => {
    const b = qrFixture(); b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain(); b.tick();
    for (const unload of b.hooks.unload) unload();
    b.requests[1].resolve(confirmed()); await drain();
    assert.equal(b.service.readSourceAuthEntries().length, 0); assert.equal(b.toasts.length, 0);
    assert.equal(b.intervals.size, 0);
  });
  await check('QR-09: a transient network error permits retry without overlapping polls', async () => {
    const b = qrFixture(); b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain(); b.tick();
    b.requests[1].reject(new Error('timeout')); await drain(); b.tick(); b.tick();
    assert.equal(b.requests.length, 3); assert.equal(b.page.qrVisible.value, true);
    assert.equal(b.toasts.length, 0); b.requests[2].resolve(confirmed()); await drain();
    assert.equal(b.service.readSourceAuthEntries()[0].account.cookie, 'cookie-A');
  });
  await check('QR-10: a missing engine stops polling and offers regeneration', async () => {
    const b = qrFixture(); b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain(); b.tick();
    b.requests[1].reject(new Error('引擎未就绪')); await drain(); b.tick();
    assert.equal(b.requests.length, 2); assert.equal(b.intervals.size, 0);
    assert.equal(b.page.qrStatusText.value, '二维码已过期，可重新生成');
    b.page.regenerateQr(); assert.equal(b.requests.length, 3);
  });
  await check('QR-11: a credential change during create revokes the old QR flow', async () => {
    const b = qrFixture(); b.page.startQr('wyy', '网易云'); await b.service.removeSourceAuthAccount('wyy');
    b.requests[0].resolve(session()); await drain();
    assert.equal(b.page.qrVisible.value, false); assert.equal(b.page.qrBusy.value, false);
    assert.equal(b.intervals.size, 0); assert.equal(b.files.length, 0);
  });
  await check('QR-12: completed A injection cannot close a regenerated B sheet', async () => {
    const b = qrFixture({ holdInjection: true });
    b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session('A')); await drain(); b.tick();
    b.requests[1].resolve(confirmed()); await drain(); assert.equal(b.injections.length, 1);
    b.tick(); b.tick(); assert.equal(b.requests.length, 2, 'confirmed is consumed before awaiting credential injection');
    b.page.regenerateQr(); b.requests[2].resolve(session('B')); await drain();
    b.injections[0].resolve('{}'); await drain();
    assert.equal(b.page.qrKey.value, 'B'); assert.equal(b.page.qrVisible.value, true);
    assert.equal(b.toasts.filter((t) => t.title.startsWith('已登录')).length, 0);
  });
  await check('QR-13: logout during credential injection must not report an old login success', async () => {
    const b = qrFixture({ holdInjection: true });
    b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain(); b.tick();
    b.requests[1].resolve(confirmed()); await drain(); assert.equal(b.injections.length, 1);
    const logout = b.service.removeSourceAuthAccount('wyy');
    b.injections[0].resolve('{}'); await logout; await drain();
    assert.equal(b.service.readSourceAuthEntries().length, 0);
    assert.equal(b.toasts.filter((t) => t.title.startsWith('已登录')).length, 0, 'removed account must not get an old success receipt');
  });
  await check('QR-14: a create failure after credential removal cannot disturb the withdrawn flow', async () => {
    const b = qrFixture(); b.page.startQr('wyy', '网易云'); await b.service.removeSourceAuthAccount('wyy');
    b.requests[0].reject(new Error('引擎未就绪')); await drain();
    assert.equal(b.toasts.length, 0, 'an error from a withdrawn credential flow is silent');
    assert.equal(b.page.qrBusy.value, false); assert.equal(b.page.qrVisible.value, false);
  });
  await check('QR-15: a poll failure after credential removal cannot disturb the withdrawn flow', async () => {
    const b = qrFixture(); b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain(); b.tick();
    await b.service.removeSourceAuthAccount('wyy');
    b.requests[1].reject(new Error('引擎未就绪')); await drain();
    assert.equal(b.toasts.length, 0, 'an error from a withdrawn poll is silent');
    assert.equal(b.page.qrVisible.value, false); assert.equal(b.intervals.size, 0);
  });
  await check('QR-16: a real storage failure keeps the sheet retryable and never reports login success', async () => {
    const b = qrFixture(); b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain(); b.tick();
    const storageWrite = b.uni.setStorageSync;
    b.uni.setStorageSync = () => { throw new Error('native disk write failed'); };
    b.requests[1].resolve(confirmed()); await drain();
    assert.equal(b.service.readSourceAuthEntries().length, 0);
    assert.equal(b.page.qrVisible.value, true, 'a swallowed storage failure must not close the QR sheet');
    assert.equal(b.toasts.filter((t) => t.title.startsWith('已登录')).length, 0);
    assert.equal(b.toasts.filter((t) => t.title.startsWith('保存登录失败')).length, 1);
    assert.match(b.page.qrStatusText.value, /保存失败/); assert.doesNotMatch(b.page.qrStatusText.value, /过期/);
    assert.equal(b.intervals.size, 0); b.tick(); assert.equal(b.requests.length, 2, 'a failed confirmation must not keep submitting');
    b.uni.setStorageSync = storageWrite; b.page.regenerateQr(); b.requests[2].resolve(session('B')); await drain(); b.tick();
    b.requests[3].resolve(confirmed('cookie-B')); await drain();
    assert.equal(b.service.readSourceAuthEntries()[0].account.cookie, 'cookie-B');
    assert.equal(b.toasts.filter((t) => t.title.startsWith('已登录')).length, 1); assert.equal(b.page.qrVisible.value, false);
  });
  await check('QR-17: an old stored account with the same cookie cannot substitute for the new user/extras', async () => {
    for (const staleField of ['user', 'extras']) {
      const b = qrFixture(); const oldUser = JSON.parse(confirmed()).user;
      if (staleField === 'user') oldUser.nickname = 'Old Alice';
      await b.service.saveSourceAuthAccount('wyy', 'cookie-A', oldUser, staleField === 'extras' ? '{"refresh_token":"stale"}' : '');
      b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain(); b.tick();
      b.uni.setStorageSync = () => { throw new Error('native disk write failed'); }; b.requests[1].resolve(confirmed()); await drain();
      assert.equal(b.service.readSourceAuthEntries().length, 1, 'old stored credentials remain intact');
      assert.equal(b.page.qrVisible.value, true); assert.match(b.page.qrStatusText.value, /保存失败/);
      assert.equal(b.toasts.filter((t) => t.title.startsWith('已登录')).length, 0);
    }
  });
  await check('QR-18: failure during unload/unmount/removal/regeneration is silent and cannot disturb a new sheet', async () => {
    for (const action of ['unload', 'unmounted', 'remove', 'regenerate']) {
      const b = qrFixture(); b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain(); b.tick();
      const storageWrite = b.uni.setStorageSync; let removal;
      b.uni.setStorageSync = () => {
        b.uni.setStorageSync = storageWrite;
        if (action === 'remove') removal = b.service.removeSourceAuthAccount('wyy');
        else if (action === 'regenerate') b.page.regenerateQr();
        else for (const hook of b.hooks[action]) hook();
        throw new Error('native disk write failed');
      };
      b.requests[1].resolve(confirmed()); await drain(); if (removal) await removal;
      assert.equal(b.toasts.length, 0, action + ': withdrawn save failures have no success or failure receipt: ' + JSON.stringify(b.toasts));
      assert.equal(b.service.readSourceAuthEntries().length, 0); assert.equal(b.intervals.size, 0);
      if (action === 'regenerate') {
        assert.equal(b.page.qrBusy.value, true); assert.equal(b.requests[2].name, 'authQrCreate');
        b.requests[2].resolve(session('B')); await drain(); assert.equal(b.page.qrVisible.value, true); assert.equal(b.page.qrKey.value, 'B');
        assert.doesNotMatch(b.page.qrStatusText.value, /保存失败/);
      } else assert.equal(b.page.qrVisible.value, false);
    }
  });
  await check('QR-19: a native readback returning old saved data after withdrawal cannot emit or close B', async () => {
    for (const action of ['regenerate', 'unload', 'unmounted', 'remove']) {
      const b = qrFixture({ holdInjection: true }); b.page.startQr('wyy', '网易云'); b.requests[0].resolve(session()); await drain(); b.tick();
      b.requests[1].resolve(confirmed()); await drain(); assert.equal(b.injections.length, 1);
      const storageRead = b.uni.getStorageSync;
      b.uni.getStorageSync = (key) => {
        const savedValue = storageRead(key); b.uni.getStorageSync = storageRead;
        if (action === 'regenerate') b.page.regenerateQr();
        else if (action === 'remove') void b.service.removeSourceAuthAccount('wyy');
        else for (const hook of b.hooks[action]) hook();
        return savedValue;
      };
      b.injections[0].resolve('{}'); await drain(); assert.equal(b.toasts.length, 0, action + ': stale readback has no success receipt');
      if (action === 'regenerate') {
        assert.equal(b.page.qrBusy.value, true); b.requests[2].resolve(session('B')); await drain();
        assert.equal(b.page.qrVisible.value, true); assert.equal(b.page.qrKey.value, 'B');
      } else assert.equal(b.page.qrVisible.value, false);
    }
  });
  console.log('Source-auth QR session: 19 passed (actual page and service; synthetic host boundaries).');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runQrChecks();
