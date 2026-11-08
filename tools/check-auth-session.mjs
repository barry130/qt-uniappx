// Isolated auth/session regressions: actual auth.ts, http.ts and user-cache.ts
// with only storage/network boundaries replaced. No production requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

class UTSJSONObject {
  constructor(value = {}) { Object.assign(this, value); }
  get(key) { return Object.hasOwn(this, key) ? this[key] : null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}

const toUtso = (value) => {
  if (Array.isArray(value)) return value.map(toUtso);
  if (value != null && typeof value === 'object') {
    return new UTSJSONObject(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toUtso(item)]),
    ));
  }
  return value;
};

const parseJsonToUtso = (text) => toUtso(JSON.parse(text));
const noop = () => {};
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function compile(text) {
  const withoutImports = text
    .replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*/gm, '');
  return stripTypeScriptTypes(withoutImports, { mode: 'strip' })
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var))/g, '');
}

function load(text, names, extra = {}) {
  const context = vm.createContext({
    console,
    UTSJSONObject,
    parseJsonToUtso,
    ...extra,
  });
  vm.runInContext(
    compile(text) + `\n;globalThis.__api={${names.join(',')}};`,
    context,
  );
  return context.__api;
}

function boundary() {
  const storage = new Map();
  const requests = [];
  const uni = {
    getStorageSync: (key) => storage.get(key) ?? '',
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    request: (options) => { requests.push(options); },
  };
  return { storage, requests, uni };
}

function loadAuth(b) {
  return load(read('services/auth.ts'), [
    'saveTokens', 'getAccessToken', 'getRefreshToken', 'clearTokens',
    'captureAuthSession', 'renewTokensIfCurrent', 'clearTokensIfCurrent',
    'getSessionEpoch', 'sessionIsCurrent', 'saveUserId', 'getUserId',
    'parseTokenResponse', 'isTokenExpired', 'shouldRefreshToken',
  ], { uni: b.uni, logWarn: noop });
}

function loadHttp(b, auth) {
  return load(read('services/http.ts'), ['tryRefreshToken', 'apiRequest'], {
    uni: b.uni,
    ...auth,
    API_BASE_URL: 'https://gateway.invalid/api/',
    mergeClientHeaders: noop,
    qtDiag: noop,
    logErrV: noop,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + label);
}

await check('AUTH-02：旧 refresh 成功不能覆盖新登录 token', async () => {
  const b = boundary();
  const auth = loadAuth(b);
  auth.saveTokens({
    accessToken: 'A-old',
    refreshToken: 'A-refresh',
    expiresAt: Date.now() + 60_000,
  });
  const http = loadHttp(b, auth);
  const pending = http.tryRefreshToken();
  const refreshRequest = b.requests.at(-1);
  assert.equal(refreshRequest.header.get('satoken'), 'A-old');
  auth.saveTokens({
    accessToken: 'B-new',
    refreshToken: 'B-refresh',
    expiresAt: Date.now() + 60_000,
  });
  refreshRequest.success({
    statusCode: 200,
    data: JSON.stringify({
      code: 200,
      data: { token: 'A-new', refreshToken: 'A-new-refresh', expiresIn: 3600 },
    }),
  });
  assert.equal(await pending, 'stale');
  assert.equal(auth.getAccessToken(), 'B-new');
  assert.equal(auth.getRefreshToken(), 'B-refresh');
});

await check('AUTH-02：旧 refresh 失效不能清空新登录 token', async () => {
  const b = boundary();
  const auth = loadAuth(b);
  auth.saveTokens({
    accessToken: 'A-old',
    refreshToken: 'A-refresh',
    expiresAt: Date.now() + 60_000,
  });
  const http = loadHttp(b, auth);
  const pending = http.tryRefreshToken();
  const refreshRequest = b.requests.at(-1);
  auth.saveTokens({
    accessToken: 'B-new',
    refreshToken: 'B-refresh',
    expiresAt: Date.now() + 60_000,
  });
  refreshRequest.success({
    statusCode: 200,
    data: JSON.stringify({ code: 401, data: null }),
  });
  assert.equal(await pending, 'stale');
  assert.equal(auth.getAccessToken(), 'B-new');
  assert.equal(auth.getRefreshToken(), 'B-refresh');
});

await check('AUTH-02：当前会话明确失效时仍清除 token 并返回 invalid', async () => {
  const b = boundary();
  const auth = loadAuth(b);
  auth.saveTokens({
    accessToken: 'A-old',
    refreshToken: 'A-refresh',
    expiresAt: Date.now() + 60_000,
  });
  const http = loadHttp(b, auth);
  const pending = http.tryRefreshToken();
  b.requests.at(-1).success({
    statusCode: 200,
    data: JSON.stringify({ code: 401, data: null }),
  });
  assert.equal(await pending, 'invalid');
  assert.equal(auth.getAccessToken(), '');
  assert.equal(auth.getRefreshToken(), '');
});

await check('AUTH-02：旧会话等待中的 401 请求在换号后拒绝而非以新 token 重试', async () => {
  const b = boundary();
  const auth = loadAuth(b);
  auth.saveTokens({
    accessToken: 'A-old',
    refreshToken: 'A-refresh',
    expiresAt: Date.now() + 3_600_000,
  });
  const http = loadHttp(b, auth);
  const first = http.apiRequest('app/user/one', new UTSJSONObject(), 'GET', true);
  const second = http.apiRequest('app/user/two', new UTSJSONObject(), 'GET', true);
  const firstRequest = b.requests.at(-2);
  const secondRequest = b.requests.at(-1);
  firstRequest.success({ statusCode: 200, data: JSON.stringify({ code: 401 }) });
  assert.equal(b.requests.length, 3, 'first 401 starts one refresh');
  secondRequest.success({ statusCode: 200, data: JSON.stringify({ code: 401 }) });
  assert.equal(b.requests.length, 3, 'second 401 joins the same refresh');
  const refreshRequest = b.requests.at(-1);
  auth.saveTokens({
    accessToken: 'B-new',
    refreshToken: 'B-refresh',
    expiresAt: Date.now() + 3_600_000,
  });
  refreshRequest.success({
    statusCode: 200,
    data: JSON.stringify({
      code: 200,
      data: { token: 'A-new', refreshToken: 'A-new-refresh', expiresIn: 3600 },
    }),
  });
  const settled = await Promise.allSettled([first, second]);
  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[1].status, 'rejected');
  assert.equal(auth.getAccessToken(), 'B-new');
  assert.equal(b.requests.length, 3, 'stale waiters must not retry under account B');
});

await check('AUTH-03：清缓存后登录 B，不复用 A 的在途 /me，也不缓存 A 的资料', async () => {
  const b = boundary();
  const auth = loadAuth(b);
  auth.saveTokens({
    accessToken: 'A-token',
    refreshToken: 'A-refresh',
    expiresAt: Date.now() + 3_600_000,
  });
  auth.saveUserId('A');
  const firstMe = deferred();
  let meRequests = 0;
  const userCache = load(read('services/user-cache.ts'), [
    'refreshMe', 'clearCachedMe', 'getCachedMe',
  ], {
    uni: b.uni,
    ...auth,
    cacheUserAvatar: noop, seedCachedAvatar: noop, clearCachedAvatar: noop,
    accountApi: {
      me: () => {
        meRequests++;
        if (meRequests === 1) return firstMe.promise;
        return Promise.resolve(new UTSJSONObject({
          user: new UTSJSONObject({ id: 'B' }),
        }));
      },
    },
  });
  const accountA = userCache.refreshMe();
  await drain();
  userCache.clearCachedMe();
  auth.saveTokens({
    accessToken: 'B-token',
    refreshToken: 'B-refresh',
    expiresAt: Date.now() + 3_600_000,
  });
  auth.saveUserId('B');
  const accountB = userCache.refreshMe();
  const responseB = await accountB;
  firstMe.resolve(new UTSJSONObject({
    user: new UTSJSONObject({ id: 'A' }),
  }));
  assert.equal(await accountA, null);
  assert.equal(meRequests, 2);
  assert.equal(responseB.get('user').get('id'), 'B');
  assert.equal(userCache.getCachedMe().get('user').get('id'), 'B');
  assert.equal(b.storage.has('qt-user-me:B'), true);
  assert.equal(b.storage.has('qt-user-me:A'), false);
});

console.log(`[check-auth-session] ${passed} 条认证/缓存用例通过`);
