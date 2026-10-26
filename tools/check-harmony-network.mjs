/**
 * 鸿蒙网络回归：stripTypeScriptTypes + vm 执行真实请求/回调，不发网络或写构建输出。
 * 运行：node --disable-warning=ExperimentalWarning tools/check-harmony-network.mjs
 *
 * HTTP 的 .ts 工具编译后保留标准 JSON.parse（坏 JSON 抛错）；包头 .uts 则变成
 * UTS.JSON.parse（坏 JSON 记错并返回 null）。替身必须保留这个区别，否则会漏检。
 * 这是源码隔离测试；Harmony 编译、桥接与设备启动由 Lead 单独验证。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const httpSource = source('services/http.ts');
const updateSource = source('services/source-update.uts');
const statSource = source('uni_modules/qt-stat/utssdk/app-harmony/index.uts');
const headerSource = source('services/source-pack-header.uts');

function executable(text) {
  return stripTypeScriptTypes(text
    .replace(/^import\b[\s\S]*?(?:;[ \t]*\r?\n|from\s+['"][^'"]+['"][ \t]*\r?\n)/gm, '')
    .replace(/^export \{[^}]*\};?\r?\n/gm, '')
    .replace(/^export /gm, ''));
}

class UTSJSONObject {
  get(key) { return this[key] ?? null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}

/** 只抽取这次改动相关的真实函数；不复制实现，也不装载音源安装/引擎等无关模块。 */
function functions(text, names) {
  return names.map((name) => {
    const match = text.match(new RegExp('(?:export )?(?:async )?function ' + name + '\\([^]*?\\n\\}'));
    assert.ok(match, 'missing source function: ' + name);
    return match[0].replace(/^export /, '');
  }).join('\n');
}
function constants(text, names) {
  return names.map((name) => {
    const match = text.match(new RegExp('^const ' + name + ' = [^\\r\\n]+', 'm'));
    assert.ok(match, 'missing source constant: ' + name);
    return match[0];
  }).join('\n');
}
const httpCode = executable(httpSource);
const authCode = executable(source('services/auth.ts'));
const updateCode = executable(
  constants(updateSource, ['HOST_API_VERSION', 'MANIFEST_TIMEOUT_MS', 'PROBE_TIMEOUT_MS', 'PROBE_RANGE_BYTES', 'DOWNLOAD_TIMEOUT_MS']) + '\n' +
  functions(updateSource, ['requestJson', 'fetchManifest', 'probePackHeader', 'probeRangeText', 'manifestFromJson', 'releaseFromJson', 'strOf', 'numOf', 'boolOfDefault', 'downloadTextFollowHop', 'downloadTextOnce', 'downloadToTemp', 'extractHopLink', 'isSecurePackLink']),
);
const statCode = executable(
  constants(statSource, ['QUEUE_KEY', 'MAX_RETRY', 'SERVER_BATCH_LIMIT', 'REQUEST_TIMEOUT']) + '\n' +
  functions(statSource, ['persistQueue', 'flushInternal', 'applyClientHeaders', 'sendNext', 'onSendFailure']),
);
const headerCode = executable(headerSource);
const gateway = 'https://gateway.test/api/v1/';
const packUrl = 'https://packs.test/play.js?signature=private';
const packText = '/*__QT_PACK__{"kind":"play","id":"play-test","name":"test","versionCode":2,"versionName":"2"}*/\n(function(){})()';
let passed = 0;
async function check(label, fn) {
  // 原生 success 回调丢异常时 Promise 会悬空；用短 watchdog 把挂起变成明确失败。
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('pending request: ' + label)), 2000); }),
    ]);
    passed++;
    console.log('  ✓ ' + label);
  } finally {
    clearTimeout(timer);
  }
}

/** uni-network 的 json 分支：UTS.JSON.parse(data) || data；错误已记入控制台。 */
function environment() {
  const env = {
    storage: new Map(), replies: [], requests: [], logs: [], implicitParses: [],
    strictParses: [], utsParses: [], callbackErrors: [], cleared: 0,
    downloads: [], downloadReplies: [], files: new Map(), removed: [],
  };
  const uni = {
    getStorageSync: (key) => env.storage.get(key) ?? '',
    setStorageSync: (key, value) => env.storage.set(key, value),
    removeStorageSync: (key) => env.storage.delete(key),
    request: (options) => {
      env.requests.push(options);
      const reply = env.replies.shift();
      assert.ok(reply, 'unexpected request: ' + options.url);
      // 保持真正 uni.request 的异步回调，避免同步替身掩盖刷新锁/Promise 的时序问题。
      queueMicrotask(() => {
        try {
          if (reply.fail) { options.fail({ errMsg: 'request:fail offline' }); return; }
          let data = reply.data;
          if ((options.dataType ?? 'json') === 'json' && typeof data === 'string' && data.length > 0) {
            env.implicitParses.push(data);
            data = env.utsJSON.parse(data) || data;
          }
          const response = { statusCode: reply.status ?? 200, data };
          // 统计链路只看状态；读取响应体本身就应该让该用例失败。
          if (reply.unreadableBody) Object.defineProperty(response, 'data', {
            get() { throw new Error('statistics must not read response body'); },
          });
          options.success(response);
        } catch (error) {
          env.callbackErrors.push(error);
        }
      });
    },
    downloadFile: (options) => {
      env.downloads.push(options);
      const reply = env.downloadReplies.shift();
      queueMicrotask(() => {
        try {
          if (!reply || reply.fail) { options.fail({ errMsg: 'downloadFile:fail offline' }); return; }
          options.success({ statusCode: reply.status ?? 200, tempFilePath: reply.tempFilePath ?? '/tmp/pack.js' });
        } catch (error) {
          env.callbackErrors.push(error);
        }
      });
    },
  };
  const auth = vm.runInNewContext(authCode + '\n({ getAccessToken, saveTokens, clearTokens, parseTokenResponse, shouldRefreshToken });', { uni, Date });
  env.login = (token = 'old-token', expiresAt = Date.now() + 3600000) => {
    auth.saveTokens({ accessToken: token, refreshToken: 'refresh-secret', expiresAt });
    env.storage.set('qt-token', token);
  };
  const context = vm.createContext({
    UTSJSONObject, API_BASE_URL: gateway, uni,
    ...auth,
    clearTokens: () => { env.cleared++; auth.clearTokens(); },
    mergeClientHeaders: (headers) => headers.set('X-App-Ut', 'app-harmony'),
    qtDiag: (...values) => env.logs.push(values),
    logErrV: (...values) => env.logs.push(values),
    logWarn: (...values) => env.logs.push(values),
    logInfo: (...values) => env.logs.push(values),
    readTextFileAt: (path) => Promise.resolve(env.files.get(path) ?? ''),
    removeFileAt: (path) => { env.files.delete(path); env.removed.push(path); return Promise.resolve(true); },
    JSON: {
      parse: (text) => { env.strictParses.push(text); return JSON.parse(text); },
      stringify: JSON.stringify,
    },
  });
  env.http = vm.runInContext(httpCode + '\n({ apiRequest, tryRefreshToken, parseJsonToUtso, jsonValueToUtso, asUtso, state: () => ({ isRefreshing, pending: pendingRequests.length, refreshPromise }) });', context);
  // 与当前 Harmony UTS/JSON.ts 同语义：标准 parse + 递归包装；异常记错后返回 null。
  env.utsJSON = {
    parse(text) {
      env.utsParses.push(text);
      try { return env.http.jsonValueToUtso(JSON.parse(text)); }
      catch (error) { env.logs.push(['UTS.JSON', String(error)]); return null; }
    },
  };
  const headerContext = vm.createContext({ UTSJSONObject, JSON: env.utsJSON });
  context.parsePackHeader = vm.runInContext(headerCode + '\nparsePackHeader;', headerContext);
  context.parseJsonToUtso = env.http.parseJsonToUtso;
  context.getCurrentVersionCode = () => 42;
  context.currentPlatform = () => 1106;
  env.update = vm.runInContext(updateCode + '\n({ requestJson, fetchManifest, probePackHeader });', context);
  const statContext = vm.createContext({
    UTSJSONObject, uni, JSON,
    initialized: true, ingestUrl: gateway + 'app/stat/report',
    utName: 'app-harmony', appVersionName: '3.0.0', modelName: 'test', osName: 'HarmonyOS 5',
    queue: [], sending: false, consecutiveFailures: 0,
    log: (...values) => env.logs.push(values),
  });
  env.stat = vm.runInContext(statCode + '\n({ add: (event) => queue.push(event), flush: () => new Promise(resolve => flushInternal(resolve)), state: () => ({ size: queue.length, sending, consecutiveFailures }) });', statContext);
  env.assertText = () => {
    assert.equal(env.callbackErrors.length, 0, env.callbackErrors.map(String).join('\n'));
    assert.equal(env.implicitParses.length, 0, 'uni.request must not run its implicit JSON parser');
    assert.equal(env.replies.length, 0, 'unused stub replies');
    assert.equal(env.downloadReplies.length, 0, 'unused download stubs');
    assert.ok(env.requests.length > 0);
    for (const request of env.requests) assert.equal(request.dataType, 'text');
    const state = env.http.state();
    assert.equal(state.isRefreshing, false, 'refresh lock must be released');
    assert.equal(state.pending, 0, 'refresh wait queue must be drained');
    assert.equal(state.refreshPromise, null, 'refresh promise must be reset');
  };
  return env;
}

await check('strict JSON helper rebuilds nested UTS objects and throws on malformed input without logging it', () => {
  const env = environment();
  const parsed = env.http.parseJsonToUtso('{"rows":[{"id":7}],"active":false}');
  assert.equal(parsed.get('rows')[0].get('id'), 7);
  assert.equal(parsed.get('active'), false);
  for (const text of ['<html>private-response</html>', '', '{"bad":']) {
    assert.throws(() => env.http.parseJsonToUtso(text), { name: 'SyntaxError' });
  }
  for (const invalid of [null, [], 7, true, 'null', '[]', '"text"']) {
    assert.throws(() => env.http.asUtso(invalid), { message: '响应数据格式异常' });
  }
  const wrapped = new UTSJSONObject();
  wrapped.set('id', 2);
  assert.equal(env.http.asUtso(wrapped), wrapped);
  assert.equal(env.http.asUtso({ nested: { id: 3 } }).get('nested').get('id'), 3);
  assert.equal(env.logs.length, 0);
});

await check('API success preserves QtRestResp code=0/200, nested values and bare object responses', async () => {
  for (const code of [0, 200]) {
    const env = environment();
    env.replies.push({ data: JSON.stringify({ code, data: { rows: [{ id: 7 }], total: 1 } }) });
    const body = await env.http.apiRequest('app/notices');
    assert.equal(body.get('rows')[0].get('id'), 7);
    assert.equal(body.get('total'), 1);
    assert.equal(env.requests[0].header.get('X-App-Ut'), 'app-harmony');
    env.assertText();
  }
  const env = environment();
  env.replies.push({ data: '{"value":8}' });
  assert.equal((await env.http.apiRequest('app/test')).get('value'), 8);
});

await check('API 2xx HTML/empty/malformed JSON/null/array/scalar rejects with format error and exposes no response body', async () => {
  for (const data of ['<html>private-response</html>', '', '{"bad":', 'null', '[]', '"private-response"', '7']) {
    const env = environment();
    env.replies.push({ data });
    await assert.rejects(env.http.apiRequest('app/test'), { message: '响应数据格式异常' });
    assert.equal(env.logs.flat().join(' ').includes('private-response'), false);
    env.assertText();
  }
});

await check('HTTP errors retain status or server message, and business errors retain their message', async () => {
  for (const [reply, expected] of [
    [{ status: 502, data: '<html>private-response</html>' }, 'HTTP 502'],
    [{ status: 400, data: '{"msg":"invalid parameter"}' }, 'invalid parameter'],
    [{ status: 503, data: '{"message":"temporarily unavailable"}' }, 'temporarily unavailable'],
    [{ status: 200, data: '{"code":300,"msg":"business rejected"}' }, 'business rejected'],
  ]) {
    const env = environment();
    env.replies.push(reply);
    await assert.rejects(env.http.apiRequest('app/test'), { message: expected });
    env.assertText();
  }
});

await check('HTTP transport failure keeps the network error contract', async () => {
  const env = environment();
  env.replies.push({ fail: true });
  await assert.rejects(env.http.apiRequest('app/test'), { message: '网络请求失败' });
  env.assertText();
});

await check('refresh HTML/malformed/empty/null/HTTP error preserves login; explicit business refusal clears it', async () => {
  for (const reply of [
    { data: '<html>private-response</html>' }, { data: '' }, { data: '{"bad":' },
    { data: 'null' }, { status: 502, data: 'Bad gateway' },
  ]) {
    const env = environment();
    env.login('access-secret');
    env.replies.push(reply);
    assert.equal(await env.http.tryRefreshToken(), 'network');
    assert.equal(env.cleared, 0);
    assert.equal(env.storage.get('qt-token'), 'access-secret');
    env.assertText();
  }
  const env = environment();
  env.login();
  env.replies.push({ data: '{"code":401,"msg":"expired"}' });
  assert.equal(await env.http.tryRefreshToken(), 'invalid');
  assert.equal(env.cleared, 1);
});

await check('business 401 refreshes once, retries with new token, and drains concurrent waiting requests', async () => {
  const env = environment();
  env.login();
  env.replies.push(
    { data: '{"code":401}' }, { data: '{"code":401}' },
    { data: '{"code":200,"data":{"token":"new-token","refreshToken":"new-refresh","expiresIn":3600}}' },
    { data: '{"code":200,"data":{"value":1}}' },
    { data: '{"code":200,"data":{"value":2}}' },
  );
  const values = await Promise.all([env.http.apiRequest('app/a'), env.http.apiRequest('app/b')]);
  assert.equal(values[0].get('value'), 1);
  assert.equal(values[1].get('value'), 2);
  assert.equal(env.requests.filter((request) => request.url.endsWith('user/refresh')).length, 1);
  assert.equal(env.requests[3].header.get('satoken'), 'new-token');
  assert.equal(env.requests[4].header.get('satoken'), 'new-token');
  env.assertText();
});

await check('malformed refresh response rejects all waiting 401 requests without clearing login', async () => {
  const env = environment();
  env.login('access-secret');
  env.replies.push(
    { data: '{"code":401}' }, { data: '{"code":401}' },
    { data: '<html>private-response</html>' },
  );
  const values = await Promise.allSettled([env.http.apiRequest('app/a'), env.http.apiRequest('app/b')]);
  for (const value of values) {
    assert.equal(value.status, 'rejected');
    assert.equal(value.reason.message, '网络请求失败');
  }
  assert.equal(env.cleared, 0);
  assert.equal(env.storage.get('qt-token'), 'access-secret');
  env.assertText();
});

await check('proactive refresh shares one request, saves real token fields and sends both callers with the new token', async () => {
  const env = environment();
  env.login('near-expiry', Date.now() + 60000);
  env.replies.push(
    { data: '{"code":0,"data":{"token":"renewed","refreshToken":"renewed-refresh","expiresIn":7200}}' },
    { data: '{"code":200,"data":{"value":1}}' },
    { data: '{"code":200,"data":{"value":2}}' },
  );
  const values = await Promise.all([
    env.http.apiRequest('app/a', new UTSJSONObject(), 'GET', true),
    env.http.apiRequest('app/b', new UTSJSONObject(), 'GET', true),
  ]);
  assert.deepEqual(values.map((value) => value.get('value')), [1, 2]);
  assert.equal(env.requests.length, 3);
  assert.equal(env.requests[0].url, gateway + 'app/user/refresh');
  assert.equal(env.requests[0].header.get('satoken'), 'near-expiry');
  assert.equal(env.requests[1].header.get('satoken'), 'renewed');
  assert.equal(env.requests[2].header.get('satoken'), 'renewed');
  assert.equal(env.storage.get('qt-access-token'), 'renewed');
  assert.equal(env.storage.get('qt-token'), 'renewed');
  assert.equal(env.storage.get('qt-refresh-token'), 'renewed-refresh');
  assert.ok(env.storage.get('qt-token-expiry') > Date.now() + 7100000);
  env.assertText();
});

await check('refresh network and business failures drain all 401 callers, release locks and allow the next request', async () => {
  for (const [reply, expected, preservesLogin] of [
    [{ data: '<html>private-response</html>' }, '网络请求失败', true],
    [{ status: 502, data: '<html>private-response</html>' }, '网络请求失败', true],
    [{ fail: true }, '网络请求失败', true],
    [{ data: '{"code":401,"msg":"expired"}' }, '登录状态已失效，请重新登录', false],
  ]) {
    const env = environment();
    env.login();
    env.replies.push({ data: '{"code":401}' }, { data: '{"code":401}' }, reply);
    const results = await Promise.allSettled([env.http.apiRequest('app/a'), env.http.apiRequest('app/b')]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.message, expected);
    }
    assert.equal(env.storage.has('qt-access-token'), preservesLogin);
    assert.equal(env.storage.has('qt-refresh-token'), preservesLogin);
    assert.equal(env.storage.has('qt-token'), preservesLogin);
    assert.equal(env.logs.flat().join(' ').includes('private-response'), false);
    if (preservesLogin) {
      // 再次 401 必须可以重新刷新；证明失败后未复用旧 promise 或锁死。
      env.replies.push(
        { data: '{"code":401}' },
        { data: '{"code":200,"data":{"token":"recovered"}}' },
        { data: '{"code":200,"data":{"value":3}}' },
      );
    } else {
      env.replies.push({ data: '{"code":200,"data":{"value":3}}' });
    }
    assert.equal((await env.http.apiRequest('app/recovery')).get('value'), 3);
    env.assertText();
  }
});

await check('external API URLs retain their absolute address and receive no token or client headers', async () => {
  const env = environment();
  env.login();
  env.replies.push({ data: '{"value":7}' });
  assert.equal((await env.http.apiRequest('https://third-party.test/data?signature=private')).get('value'), 7);
  const request = env.requests[0];
  assert.equal(request.url, 'https://third-party.test/data?signature=private');
  assert.equal(request.header.get('satoken'), null);
  assert.equal(request.header.get('X-App-Ut'), null);
  env.assertText();
});

await check('manifest/report JSON accepts code=0/200; HTTP, business and malformed responses resolve null', async () => {
  for (const [reply, ok] of [
    [{ data: '{"code":200,"data":{"schema":1}}' }, true],
    [{ data: '{"code":0,"data":{"schema":2}}' }, true],
    [{ status: 502, data: '<html>private-response</html>' }, false],
    [{ data: '<html>private-response</html>' }, false], [{ data: '' }, false],
    [{ data: '{"bad":' }, false], [{ data: 'null' }, false], [{ data: '[]' }, false],
    [{ data: '{"code":300,"msg":"rejected"}' }, false], [{ data: '{"schema":1}' }, false],
    [{ fail: true }, false],
  ]) {
    const env = environment();
    env.login('access-secret');
    env.replies.push(reply);
    const body = await env.update.requestJson(gateway + 'app/source/manifest', 'GET', null);
    assert.equal(body != null, ok);
    if (ok) assert.ok(body.get('data').get('schema') > 0);
    assert.equal(env.requests[0].header.get('X-App-Ut'), 'app-harmony');
    assert.equal(env.requests[0].header.get('satoken'), 'access-secret');
    assert.equal(env.logs.flat().join(' ').includes('private-response'), false);
    env.assertText();
  }
});

await check('fetchManifest parses real nested release fields and returns null for bad JSON without throwing', async () => {
  const env = environment();
  const manifest = {
    schema: 1, generatedAt: '2026-10-25',
    release: {
      sourceVersionCode: 2, sourceVersionName: '2', platforms: [1106], hostApiVersion: 1,
      artifacts: [{ path: 'play-bundle.js', version: 1, url: packUrl }],
    },
  };
  env.replies.push({ data: JSON.stringify({ code: 200, data: manifest }) });
  const parsed = await env.update.fetchManifest();
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.release.platforms[0], 1106);
  assert.equal(parsed.release.artifacts[0].url, packUrl);
  assert.equal(parsed.release.published, true);
  assert.equal(env.requests[0].url, gateway + 'app/source/manifest?platform=1106&hostApiVersion=1&appVersionCode=42');
  env.assertText();
  for (const data of ['', '{"bad":', '<html>private-response</html>', 'null', '{"code":200,"data":null}']) {
    const invalid = environment();
    invalid.replies.push({ data });
    assert.equal(await invalid.update.fetchManifest(), null);
    assert.equal(invalid.logs.flat().join(' ').includes('private-response'), false);
    invalid.assertText();
  }
  const unavailable = environment();
  unavailable.replies.push({ status: 503, data: '<html>private-response</html>' });
  assert.equal(await unavailable.update.fetchManifest(), null);
  assert.equal(unavailable.strictParses.length, 0, 'non-2xx manifest must not parse body');
  unavailable.assertText();
});

await check('manifest artifacts parse direct packId/packVersionCode/packVersionName (meta offer without probe) and default to empty when absent', async () => {
  const env = environment();
  const manifest = {
    schema: 3, generatedAt: '2026-10-26',
    release: {
      sourceVersionCode: 2026102601, sourceVersionName: '2026.10.26.1', platforms: [1106], hostApiVersion: 1,
      artifacts: [
        { path: 'meta-bundle.js', version: 5, url: packUrl, packId: 'meta-official', packVersionCode: 2026102601, packVersionName: '2026.10.26.meta' },
        { path: 'play-bundle.js', version: 5, url: packUrl },
      ],
    },
  };
  env.replies.push({ data: JSON.stringify({ code: 200, data: manifest }) });
  const parsed = await env.update.fetchManifest();
  const meta = parsed.release.artifacts[0];
  assert.equal(meta.path, 'meta-bundle.js');
  assert.equal(meta.packId, 'meta-official');
  assert.equal(meta.packVersionCode, 2026102601);
  assert.equal(meta.packVersionName, '2026.10.26.meta');
  // 旧后端不下发直发字段 → 空 id/0 版本号，meta 分支回退产物头探测
  const legacy = parsed.release.artifacts[1];
  assert.equal(legacy.packId, '');
  assert.equal(legacy.packVersionCode, 0);
  assert.equal(legacy.packVersionName, '');
  // 直发口径只解析 manifest，不应对产物 url 发起任何探测请求
  assert.equal(env.requests.length, 1);
  env.assertText();
});

await check('Range pack probe receives JS verbatim for HTTP 200/206 without implicit JSON or client headers', async () => {
  for (const status of [200, 206]) {
    const env = environment();
    env.replies.push({ status, data: packText });
    const header = await env.update.probePackHeader(packUrl);
    assert.equal(header.id, 'play-test');
    assert.equal(header.versionCode, 2);
    assert.equal(env.requests[0].header.get('Range'), 'bytes=0-4095');
    assert.equal(env.requests[0].header.get('X-App-Ut'), null);
    assert.equal(env.requests[0].header.get('satoken'), null);
    assert.equal(env.strictParses.length, 0, 'JS pack must not enter the HTTP JSON parser');
    assert.equal(env.utsParses.length, 1);
    assert.equal(env.utsParses[0], packText.substring('/*__QT_PACK__'.length, packText.indexOf('*/')));
    assert.equal(env.logs.length, 0);
    env.assertText();
  }
});

await check('Range probe HTML/HTTP error returns null and rejects non-HTTPS without a request', async () => {
  for (const reply of [{ data: '<html>private-response</html>' }, { status: 404, data: packText }]) {
    const env = environment();
    env.replies.push(reply);
    assert.equal(await env.update.probePackHeader(packUrl), null);
    env.assertText();
  }
  const env = environment();
  assert.equal(await env.update.probePackHeader('http://packs.test/play.js'), null);
  assert.equal(env.requests.length, 0);
  assert.equal(env.downloads.length, 0, 'HTTPS gate must reject before downloadFile');
});

await check('probe follows the HTML jump-page hop when the Range probe body carries an https link', async () => {
  const env = environment();
  env.replies.push({ status: 200, data: '<a href="https://asset.test/play.js">Found</a>' });
  env.replies.push({ status: 206, data: packText });
  const header = await env.update.probePackHeader(packUrl);
  assert.equal(header.id, 'play-test');
  assert.equal(header.versionCode, 2);
  assert.equal(env.requests.length, 2);
  assert.equal(env.requests[1].url, 'https://asset.test/play.js');
  assert.equal(env.downloads.length, 0, 'successful hop must not fall through to downloadFile');
  env.assertText();
});

await check('probe falls back to the install-channel downloadFile when the Range probe gets a redirect status', async () => {
  const env = environment();
  env.replies.push({ status: 302, data: '<a href="https://asset.test/meta.js">Found</a>' });
  env.downloadReplies.push({ status: 200, tempFilePath: '/tmp/meta.js' });
  env.files.set('/tmp/meta.js', packText);
  const header = await env.update.probePackHeader(packUrl);
  assert.equal(header.id, 'play-test');
  assert.equal(header.versionCode, 2);
  assert.equal(env.downloads.length, 1);
  assert.equal(env.downloads[0].url, packUrl);
  assert.deepEqual(env.removed, ['/tmp/meta.js']);
  assert.equal(env.files.size, 0, 'temp file must be cleaned after read');
  env.assertText();
});

await check('statistics accepts empty/non-JSON 2xx based on status and retains failed batches for retry', async () => {
  const env = environment();
  env.stat.add({ evt: 'launcher', ts: 1 });
  env.replies.push({ status: 502, data: '<html>private-response</html>', unreadableBody: true });
  assert.equal(await env.stat.flush(), false);
  assert.equal(env.stat.state().size, 1);
  assert.equal(env.stat.state().sending, false);
  env.replies.push({ status: 204, data: '', unreadableBody: true });
  assert.equal(await env.stat.flush(), true);
  assert.equal(env.requests[1].data.get('events')[0].evt, 'launcher');
  env.stat.add({ evt: 'show', ts: 2 });
  env.replies.push({ data: 'accepted', unreadableBody: true });
  assert.equal(await env.stat.flush(), true);
  assert.equal(env.stat.state().size, 0);
  const header = env.requests[0].header;
  for (const [key, value] of Object.entries({ 'X-App-Ut': 'app-harmony', 'X-App-Version': '3.0.0', 'X-Device': 'test', 'X-OS': 'HarmonyOS 5' })) {
    assert.equal(header.get(key), value);
  }
  assert.equal(header.get('satoken'), null);
  assert.equal(env.logs.flat().join(' ').includes('private-response'), false);
  env.assertText();
});

await check('statistics drains batches of at most 200, rejects concurrent sends and retains second failed batch', async () => {
  const env = environment();
  for (let i = 0; i < 201; i++) env.stat.add({ evt: 'page', ts: i });
  env.replies.push({ status: 200, data: 'accepted' }, { fail: true });
  const sending = env.stat.flush();
  assert.equal(await env.stat.flush(), false);
  assert.equal(await sending, false);
  assert.equal(env.requests.length, 2);
  assert.equal(env.requests[0].data.get('events').length, 200);
  assert.equal(env.requests[1].data.get('events').length, 1);
  assert.equal(env.stat.state().size, 1);
  env.replies.push({ status: 200, data: '<html>accepted-response</html>' });
  assert.equal(await env.stat.flush(), true);
  assert.equal(env.requests[2].data.get('events')[0].ts, 200);
  assert.equal(env.stat.state().size, 0);
  env.assertText();
});

console.log(`[harmony-network] ${passed} checks passed; simulated runtime only, no Harmony build/device validation.`);
