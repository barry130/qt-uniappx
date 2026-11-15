// Agreed seams: actual uploadAvatar/uploadPlaylistCover, observed via uni network/FS and returned URL/errors.
// Complete production media/http/auth/client-info/cache modules run here. Native/network/device/logging are synthetic.
// Existing production support is already present: first passing executions are GREEN, not invented RED cycles.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { read, load, host, drain, noop } from './check-source-auth-session.mjs';

const sources = new Map(['auth', 'http', 'client-info', 'avatar-cache', 'user-cache', 'media']
  .map(name => [name, read(`services/${name}.ts`)]));
const mediaSha = createHash('sha256').update(sources.get('media')).digest('hex');
const base = 'https://gateway.invalid/api/v1/';
const contentPath = '/api/v1/storage/upload-proxy/proxy-7/content';
const contentUrl = 'https://gateway.invalid/api/v1/storage/upload-proxy/proxy-7/content';
const imageUrl = 'https://images.invalid/uploaded.webp';
const directUrl = 'https://object.invalid/image?signature=fixture';
const plain = value => JSON.parse(JSON.stringify(value));
const rest = data => ({ code: 200, data });
const state = value => rest({ state: value });
const proxyPlan = () => ({ mode: 'PROXY', uploadId: 'proxy-7', contentPath });
const directPlan = method => ({ mode: 'DIRECT', ticket: {
  uploadUrl: directUrl, uploadId: 'direct-7', method, formField: 'image',
  formPolicy: 'fixture-policy', formAuthorization: 'fixture-form-authorization',
} });
const cases = {
  avatar: {
    plan: base + 'app/user/avatar/upload-plan', complete: base + 'app/user/avatar/complete',
    apply: base + 'app/user/avatar/apply', fileName: 'avatar.webp',
  },
  cover: {
    plan: base + 'app/user/like/playlist/local-7/cover/upload-plan',
    complete: base + 'app/user/like/playlist/local-7/cover/complete?platform=local',
    apply: base + 'app/user/like/playlist/local-7/cover/apply?platform=local', fileName: 'cover.webp',
  },
};
function moduleAt(name, scope) {
  let text = sources.get(name).replace(/^export\s*\{[^}]*\}(?:\s*from\s*["'][^"']+["'])?;?\s*/gm, '');
  // Select the actual APP-ANDROID conditional branch for this synthetic host; no native compiler claim.
  if (name === 'client-info') text = text.replace(/\/\/ #ifdef ([A-Z-]+)([\s\S]*?)\/\/ #endif/g,
    (_all, platform, body) => platform === 'APP-ANDROID' ? body : '');
  const names = [...text.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map(match => match[1]);
  return load(text, names, scope);
}
function fixture(filePath = 'unifile://picked/image.webp') {
  const b = host();
  const bytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0xff, 0x7b, 0x22, 1]).buffer;
  const files = new Map([[filePath, bytes]]), stats = [], reads = [], network = [];
  const fs = {
    getFileInfo(options) {
      stats.push(options.filePath);
      if (files.has(options.filePath)) options.success({ size: files.get(options.filePath).byteLength });
      else options.fail({ errMsg: 'fixture missing file' });
    },
    readFile(options) {
      reads.push(options.filePath);
      if (files.has(options.filePath)) options.success({ data: files.get(options.filePath) });
      else options.fail({ errMsg: 'fixture missing file' });
    },
    accessSync(path) { if (!files.has(path)) throw new Error('fixture missing file'); },
    copyFileSync(from, to) {
      if (!files.has(from)) throw new Error('fixture missing file');
      files.set(to, files.get(from));
    },
    unlinkSync(path) { files.delete(path); },
  };
  Object.assign(b.uni, {
    env: { USER_DATA_PATH: 'unifile://usr' }, getFileSystemManager: () => fs,
    getDeviceInfo: () => ({ deviceModel: 'Fixture Android', osName: 'Android', osVersion: '14' }),
    request: options => network.push({ kind: 'request', ...options }),
    uploadFile: options => network.push({ kind: 'multipart', ...options }),
    downloadFile: () => { throw new Error('picked upload must not re-download its image'); },
  });
  const scope = { uni: b.uni, logWarn: noop, logInfo: noop, logErrV: noop, qtDiag: noop };
  const auth = moduleAt('auth', scope);
  const client = moduleAt('client-info', { ...scope, getCurrentVersionName: () => '3.0.0-fixture' });
  Object.assign(scope, auth, client);
  const http = moduleAt('http', { ...scope, API_BASE_URL: base });
  Object.assign(scope, http);
  Object.assign(scope, moduleAt('avatar-cache', scope));
  Object.assign(scope, moduleAt('user-cache', { ...scope, accountApi: {
    me: () => { throw new Error('upload must not request /me'); },
  } }));
  const media = moduleAt('media', scope);
  const login = owner => {
    auth.saveUserId(owner);
    auth.saveTokens({ accessToken: owner + '-access', refreshToken: owner + '-refresh', expiresAt: Date.now() + 3600000 });
  };
  login('A');
  return { ...b, bytes, imageFiles: files, stats, reads, network, filePath, media, auth, http, login };
}
function begin(b, kind) {
  const pending = kind === 'avatar' ? b.media.uploadAvatar(b.filePath)
    : b.media.uploadPlaylistCover('local-7', 'local', b.filePath);
  pending.catch(noop); // Tests deliberately deliver failures after inspecting the external request.
  return pending;
}
async function reply(b, index, data, statusCode = 200) {
  assert.ok(b.network[index], 'expected external request ' + index);
  b.network[index].success({ statusCode, data });
  await drain();
}
function ownHeaders(request, mime) {
  assert.deepEqual(plain(request.header), {
    'Content-Type': mime, satoken: 'A-access', 'X-App-Ut': 'app-android',
    'X-App-Version': '3.0.0-fixture', 'X-Device': 'Fixture Android', 'X-OS': 'Android 14',
  });
}
function planRequest(b, kind) {
  const request = b.network[0];
  assert.equal(request.url, cases[kind].plan); assert.equal(request.method, 'POST');
  const body = plain(request.data);
  assert.equal(typeof body.idempotencyKey, 'string'); assert.ok(body.idempotencyKey.length > 0);
  delete body.idempotencyKey;
  assert.deepEqual(body, {
    ...(kind === 'cover' ? { platform: 'local' } : {}),
    fileName: cases[kind].fileName, contentType: 'image/webp', sizeBytes: 9,
  });
  ownHeaders(request, 'application/json');
  assert.deepEqual(b.stats, [b.filePath]);
}
function rawProxy(b, index) {
  const request = b.network[index];
  assert.equal(request.kind, 'request'); assert.equal(request.url, contentUrl);
  assert.equal(request.method, 'POST'); assert.equal(request.data, b.bytes);
  assert.equal(request.timeout, 120000); assert.equal(request.dataType, 'text');
  ownHeaders(request, 'image/webp');
}
function receiptRequest(b, kind, mode, index) {
  const request = b.network[index];
  assert.equal(request.url, cases[kind][mode === 'PROXY' ? 'apply' : 'complete']);
  assert.equal(request.method, 'POST');
  assert.deepEqual(plain(request.data), { uploadId: mode === 'PROXY' ? 'proxy-7' : 'direct-7' });
  ownHeaders(request, 'application/json');
}
let passed = 0;
async function check(label, test) { await test(); passed++; console.log('  ✓ ' + label); }

for (const kind of ['avatar', 'cover']) await check(`${kind}: PROXY plan → raw POST → apply returns permanent URL`, async () => {
  const b = fixture(), pending = begin(b, kind); await drain(); planRequest(b, kind);
  await reply(b, 0, JSON.stringify(rest(proxyPlan()))); rawProxy(b, 1);
  assert.equal(b.network.length, 2, 'apply waits for COMMITTED');
  await reply(b, 1, kind === 'avatar' ? JSON.stringify(state('COMMITTED')) : state('COMMITTED'));
  receiptRequest(b, kind, 'PROXY', 2);
  await reply(b, 2, rest({ url: imageUrl })); assert.equal(await pending, imageUrl);
  assert.equal(b.network.length, 3); assert.deepEqual(b.reads, [b.filePath]);
});

for (const kind of ['avatar', 'cover']) await check(`${kind}: CREATED resends identical bytes and COMMITTED on attempt 2 or 3 applies once`, async () => {
  for (const attempts of [2, 3]) {
    const b = fixture(), pending = begin(b, kind); await drain(); planRequest(b, kind);
    await reply(b, 0, rest(proxyPlan()));
    for (let attempt = 1; attempt <= attempts; attempt++) {
      rawProxy(b, attempt);
      assert.equal(b.network.length, attempt + 1, 'no apply before commitment');
      // Include the native UTSJSONObject shape as well as text/plain object responses.
      await reply(b, attempt, b.http.parseJsonToUtso(JSON.stringify(state(attempt === attempts ? 'COMMITTED' : 'CREATED'))));
    }
    receiptRequest(b, kind, 'PROXY', attempts + 1);
    await reply(b, attempts + 1, rest({ url: imageUrl })); assert.equal(await pending, imageUrl);
    assert.equal(b.network.length, attempts + 2); assert.deepEqual(b.reads, [b.filePath]);
  }
});
for (const kind of ['avatar', 'cover']) await check(`${kind}: three CREATED attempts stop without apply or a fourth send`, async () => {
  const b = fixture(), pending = begin(b, kind); await drain(); await reply(b, 0, rest(proxyPlan()));
  for (let attempt = 1; attempt <= 3; attempt++) { rawProxy(b, attempt); await reply(b, attempt, state('CREATED')); }
  await assert.rejects(pending, { message: '上传渠道暂不可用，请稍后重试' });
  assert.equal(b.network.length, 4); assert.deepEqual(b.reads, [b.filePath]);
});

for (const kind of ['avatar', 'cover']) await check(`${kind}: HTTP 403 keeps business message; HTTP 200 plain text stays in error`, async () => {
  for (const response of [
    { status: 403, body: JSON.stringify({ code: 403, msg: '今日上传次数已达上限' }), error: '今日上传次数已达上限' },
    { status: 403, body: { code: 403, msg: '目录未授予上传权限' }, error: '目录未授予上传权限' },
    { status: 200, body: '  网关拦截：请稍后重试  ', error: '代传失败（HTTP 200）：网关拦截：请稍后重试' },
  ]) {
    const b = fixture(), pending = begin(b, kind); await drain(); await reply(b, 0, rest(proxyPlan()));
    rawProxy(b, 1); await reply(b, 1, response.body, response.status);
    await assert.rejects(pending, { message: response.error });
    assert.equal(b.network.length, 2, 'failed body response must not apply or retry');
  }
});
for (const kind of ['avatar', 'cover']) await check(`${kind}: failed or malformed proxy receipts stop before apply`, async () => {
  for (const response of [
    { body: state('FAILED'), status: 200, error: '文件发送失败（FAILED）' },
    { body: rest({}), status: 200, error: '代传回执缺少状态' },
    { body: { code: 200 }, status: 200, error: '代传回执格式异常' },
    { body: state('COMMITTED'), status: 502, error: '代传失败（HTTP 502）' },
    { failure: true, error: '网络请求失败' },
  ]) {
    const b = fixture(), pending = begin(b, kind); await drain(); await reply(b, 0, rest(proxyPlan()));
    if (response.failure) { b.network[1].fail({ errMsg: 'fixture offline' }); await drain(); }
    else await reply(b, 1, response.body, response.status);
    await assert.rejects(pending, { message: response.error }); assert.equal(b.network.length, 2);
  }
});

for (const kind of ['avatar', 'cover']) await check(`${kind}: DIRECT PUT sends bytes without account/client headers then completes`, async () => {
  const b = fixture(), pending = begin(b, kind); await drain(); planRequest(b, kind);
  await reply(b, 0, rest(directPlan('PUT')));
  const request = b.network[1];
  assert.equal(request.url, directUrl); assert.equal(request.method, 'PUT'); assert.equal(request.data, b.bytes);
  assert.deepEqual(plain(request.header), { 'Content-Type': 'image/webp' });
  assert.equal(b.network.length, 2);
  await reply(b, 1, '', 204); receiptRequest(b, kind, 'DIRECT', 2);
  await reply(b, 2, rest({ url: imageUrl })); assert.equal(await pending, imageUrl);
  assert.equal(b.network.length, 3); assert.deepEqual(b.reads, [b.filePath]);
});
for (const kind of ['avatar', 'cover']) await check(`${kind}: DIRECT multipart preserves form credentials without account/client headers`, async () => {
  const b = fixture(), pending = begin(b, kind); await drain(); planRequest(b, kind);
  await reply(b, 0, rest(directPlan('POST')));
  const request = b.network[1];
  assert.equal(request.kind, 'multipart'); assert.equal(request.url, directUrl);
  assert.equal(request.filePath, b.filePath); assert.equal(request.name, 'image');
  assert.deepEqual(plain(request.formData), { policy: 'fixture-policy', authorization: 'fixture-form-authorization' });
  assert.equal(request.header, undefined, 'third-party multipart receives no custom headers');
  assert.equal(request.data, undefined); assert.deepEqual(b.reads, []);
  await reply(b, 1, '', 201); receiptRequest(b, kind, 'DIRECT', 2);
  await reply(b, 2, rest({ url: imageUrl })); assert.equal(await pending, imageUrl);
  assert.equal(b.network.length, 3);
});
for (const kind of ['avatar', 'cover']) await check(`${kind}: DIRECT storage errors never complete`, async () => {
  for (const method of ['PUT', 'POST']) {
    const b = fixture(), pending = begin(b, kind); await drain(); await reply(b, 0, rest(directPlan(method)));
    await reply(b, 1, 'fixture storage failure', 403);
    await assert.rejects(pending, { message: '上传失败（存储端 HTTP 403）' });
    assert.equal(b.network.length, 2);
  }
});

for (const kind of ['avatar', 'cover']) await check(`${kind}: account change or logout discards late and already-queued receipt URLs`, async () => {
  for (const mode of ['PROXY', 'DIRECT']) for (const timing of ['inflight', 'queued']) for (const action of ['switch', 'logout']) {
    const b = fixture(), pending = begin(b, kind); await drain();
    await reply(b, 0, rest(mode === 'PROXY' ? proxyPlan() : directPlan('PUT')));
    await reply(b, 1, mode === 'PROXY' ? state('COMMITTED') : '', 200);
    receiptRequest(b, kind, mode, 2);
    const changeSession = () => action === 'switch' ? b.login('B') : b.auth.clearTokens();
    if (timing === 'inflight') changeSession();
    b.network[2].success({ statusCode: 200, data: rest({ url: imageUrl }) });
    // Change identity before the upload coroutine consumes an otherwise valid HTTP receipt.
    if (timing === 'queued') changeSession();
    await drain();
    await assert.rejects(pending, { message: timing === 'inflight'
      ? '登录状态已变更，请重试' : '登录状态已变化，请重新操作' });
    assert.equal(b.network.length, 3);
  }
});
for (const kind of ['avatar', 'cover']) await check(`${kind}: filesystem size/read failures and unsupported images stop the upload`, async () => {
  const missing = fixture(); missing.imageFiles.delete(missing.filePath);
  await assert.rejects(begin(missing, kind), { message: '读取图片失败' }); assert.equal(missing.network.length, 0);
  const unreadable = fixture(), pending = begin(unreadable, kind); await drain(); planRequest(unreadable, kind);
  unreadable.imageFiles.delete(unreadable.filePath); await reply(unreadable, 0, rest(proxyPlan()));
  await assert.rejects(pending, { message: '读取图片失败' }); assert.equal(unreadable.network.length, 1);
  const unsupported = fixture('unifile://picked/image.gif');
  await assert.rejects(begin(unsupported, kind), { message: '仅支持 png / jpg / webp 图片' });
  assert.equal(unsupported.network.length, 0); assert.deepEqual(unsupported.stats, []);
});
for (const kind of ['avatar', 'cover']) await check(`${kind}: plan business failures or missing final URL never report success`, async () => {
  const failed = fixture(), first = begin(failed, kind); await drain();
  await reply(failed, 0, { code: 403, msg: '歌单不存在或目录策略已变更' }, 403);
  await assert.rejects(first, { message: '歌单不存在或目录策略已变更' }); assert.equal(failed.network.length, 1);
  for (const mode of ['PROXY', 'DIRECT']) {
    const b = fixture(), pending = begin(b, kind); await drain();
    await reply(b, 0, rest(mode === 'PROXY' ? proxyPlan() : directPlan('PUT')));
    await reply(b, 1, mode === 'PROXY' ? state('COMMITTED') : '');
    await reply(b, 2, rest({ url: '' }));
    await assert.rejects(pending, { message: '回执缺少图片地址' }); assert.equal(b.network.length, 3);
  }
});

console.log(`Media upload: ${passed} regressions passed (real production modules; synthetic network/filesystem).`);
console.log('Media production SHA256: ' + mediaSha);
