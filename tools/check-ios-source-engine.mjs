/**
 * Execute the real iOS UTS driver/prelude/bootstrap with an asynchronous native substitute.
 * ES modules are parsed and evaluated by vm.SourceTextModule, never stripped to plain scripts.
 * This checks bridge/lifecycle semantics; it does not claim WKWebView/URLSession/CryptoKit compilation.
 *
 * node --experimental-vm-modules --disable-warning=ExperimentalWarning tools/check-ios-source-engine.mjs [meta.js play.js]
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { createPublicKey, verify, webcrypto } from 'node:crypto';
import { preprocessPlatform } from './platform-preprocess.mjs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const nativeRoot = 'uni_modules/qt-js-engine/utssdk/app-ios/';
function template(file, name) {
  const source = read(nativeRoot + file);
  const marker = `export const ${name} = \``;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'missing JS template ' + name);
  const body = start + marker.length;
  const end = source.indexOf('`', body);
  assert.ok(end > body, 'unterminated JS template ' + name);
  return source.slice(body, end);
}
const prelude = template('prelude.uts', 'QT_JS_PRELUDE');
const bootstrap = template('bootstrap.uts', 'QT_IOS_BOOTSTRAP');
const source = stripTypeScriptTypes(read(nativeRoot + 'index.uts')
  .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"][ \t]*;?[ \t]*\r?\n/gm, '')
  .replace(/^export /gm, ''));

class Clock {
  now = 0;
  seq = 0;
  timers = new Map();
  set(fn, delay = 0) {
    const id = ++this.seq;
    this.timers.set(id, { fn, at: this.now + Math.max(0, Number(delay) || 0) });
    return id;
  }
  clear(id) { this.timers.delete(id); }
  async advance(target) {
    let guard = 0;
    while (true) {
      const pending = [...this.timers.entries()]
        .filter(([, item]) => item.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (!pending.length) break;
      assert.ok(++guard < 100000, 'native timer loop did not become idle');
      const [id, task] = pending[0];
      this.timers.delete(id);
      this.now = task.at;
      task.fn();
      await new Promise(setImmediate); // Includes JS Promise jobs and SourceTextModule linking.
    }
    this.now = Math.max(this.now, target);
    await new Promise(setImmediate);
  }
  async until(condition, deadline = this.now + 40000) {
    while (!condition()) {
      const first = Math.min(...[...this.timers.values()].map((item) => item.at));
      assert.ok(Number.isFinite(first) && first <= deadline, 'callback did not settle before its deadline');
      await this.advance(first);
    }
  }
}

class UTSJSONObject {
  get(key) { return this[key] ?? null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}
const bridgeJSON = {
  stringify: JSON.stringify,
  parseObject: (text) => {
    try {
      const result = JSON.parse(text);
      return result && typeof result === 'object' && !Array.isArray(result)
        ? Object.assign(new UTSJSONObject(), result) : null;
    } catch { return null; }
  },
  parse: (text) => {
    const result = JSON.parse(text);
    return result && typeof result === 'object' && !Array.isArray(result)
      ? Object.assign(new UTSJSONObject(), result) : result;
  },
};

function environment() {
  const clock = new Clock();
  const native = {
    page: null, healthy: false, epoch: 0, moduleSeq: 0,
    prepareDelay: 1, prepares: 0, evalDelay: 1,
    activeEvaluations: 0, maximumEvaluations: 0,
    replies: [], requests: [], fileCalls: [], modules: new Map(), files: new Map(),
    blockedEvaluations: [], warnings: [],
    prepare(callback) {
      this.prepares++;
      const generation = ++this.epoch;
      this.healthy = true;
      this.page = vm.createContext({
        console: { log() {}, error() {}, warn() {} },
        crypto: webcrypto,
        navigator: {},
      });
      this.page.__qtModuleCache = new Map();
      clock.set(() => callback(generation === this.epoch ? '17.0' : '', generation === this.epoch ? '' : 'native stopped'), this.prepareDelay);
    },
    stop(callback) {
      this.epoch++;
      this.healthy = false;
      this.page = null;
      this.modules.clear();
      // Deliberately keep delayed HTTP/eval replies to verify that the UTS generation guard rejects them.
      this.activeEvaluations = 0;
      clock.set(() => callback('', ''), 0);
    },
    isHealthy() { return this.healthy; },
    async importModule(address, page) {
      assert.match(address, /^qtsource:\/\/engine\//);
      const cache = page.__qtModuleCache;
      if (cache.has(address)) return cache.get(address);
      assert.ok(this.modules.has(address), 'module source was released before WebKit could read it');
      const module = new vm.SourceTextModule(this.modules.get(address), {
        context: page,
        identifier: address,
        importModuleDynamically: (specifier) => this.importModule(specifier, page),
      });
      cache.set(address, module);
      await module.link((specifier) => this.importModule(specifier, page));
      await module.evaluate({ timeout: 500 });
      return module;
    },
    evaluate(code, callback) {
      const page = this.page;
      const generation = this.epoch;
      if (!page || !this.healthy) { clock.set(() => callback('', 'native page unavailable'), 0); return; }
      this.activeEvaluations++;
      this.maximumEvaluations = Math.max(this.maximumEvaluations, this.activeEvaluations);
      if (code.includes('__HANG_EVAL')) {
        this.blockedEvaluations.push(callback);
        return;
      }
      clock.set(() => {
        let value = '', error = '';
        try {
          value = vm.runInContext(code, page, {
            timeout: 500,
            importModuleDynamically: (address) => this.importModule(address, page),
          });
          value = value == null ? '' : String(value);
        } catch (failure) { error = String(failure); }
        this.activeEvaluations = Math.max(0, this.activeEvaluations - 1);
        clock.set(() => callback(value, generation === this.epoch ? error : 'late native evaluation'), this.evalDelay);
      }, 0);
    },
    provideModule(slot, code, callback) {
      const address = `qtsource://engine/${slot}-${this.epoch}-${++this.moduleSeq}.js`;
      this.modules.set(address, code);
      clock.set(() => callback(address, ''), 0);
    },
    releaseModule(address) { this.modules.delete(address); },
    request(raw, callback) {
      const request = JSON.parse(raw);
      this.requests.push(request);
      const reply = this.replies.shift() ?? { body: '{"ok":true}', delay: 1 };
      clock.set(() => callback(JSON.stringify({
        statusCode: reply.status ?? 200,
        headersJson: JSON.stringify(reply.headers ?? { 'content-type': 'text/plain' }),
        body: reply.body ?? '',
        error: reply.error ?? '',
      }), ''), reply.delay ?? 1);
    },
    dataDir: () => '/app/Library/Application Support/QtMusic',
    publicDataDir: () => '/app/Documents/QtMusic',
    fileOperation(operation, path, text, callback) {
      this.fileCalls.push([operation, path, text]);
      clock.set(() => {
        let value = '';
        if (operation === 'write') this.files.set(path, text);
        if (operation === 'append') this.files.set(path, (this.files.get(path) ?? '') + text);
        if (operation === 'read' || operation === 'asset') {
          if (!this.files.has(path)) { callback('0', '', 'No such file'); return; }
          value = this.files.get(path);
        }
        if (operation === 'exists') value = this.files.has(path) || [...this.files.keys()].some((key) => key.startsWith(path + '/')) ? '1' : '0';
        if (operation === 'list') {
          const entries = new Map();
          for (const [key, contents] of this.files) {
            if (!key.startsWith(path + '/')) continue;
            const suffix = key.slice(path.length + 1);
            const [name] = suffix.split('/');
            const directory = suffix.includes('/');
            entries.set(name, { name, dir: directory, size: directory ? 0 : Buffer.byteLength(contents) });
          }
          value = JSON.stringify([...entries.values()]);
        }
        if (operation === 'remove') {
          for (const key of this.files.keys()) if (key === path || key.startsWith(path + '/')) this.files.delete(key);
        }
        if (operation === 'rename') {
          if (!this.files.has(path)) { callback('0', '', 'No such file'); return; }
          this.files.set(text, this.files.get(path));
          this.files.delete(path);
        }
        callback('1', value, '');
      }, 0);
    },
    verifyPackSignature(content, signature, publicKey, callback) {
      clock.set(() => {
        try {
          assert.match(publicKey, /^[\da-f]{64}$/i);
          const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'hex')]);
          const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
          callback('1', verify(null, Buffer.from(content, 'utf8'), key, Buffer.from(signature, 'base64')) ? 'ok' : 'bad', '');
        } catch (error) { callback('0', '', String(error)); }
      }, 0);
    },
  };
  const app = vm.createContext({
    QtJsEngineNative: native,
    QT_JS_PRELUDE: prelude,
    QT_IOS_BOOTSTRAP: bootstrap,
    UTSJSONObject,
    UTSiOS: { getResourcePath: (path) => '/app/bundle' + path },
    JSON: bridgeJSON,
    Date: { now: () => clock.now },
    setTimeout: (fn, delay) => clock.set(fn, delay),
    clearTimeout: (id) => clock.clear(id),
    console: { log() {}, error: (...args) => native.warnings.push(args), warn: (...args) => native.warnings.push(args) },
  });
  vm.runInContext(source + `
globalThis.api = {
  start, stop, evaluate, loadBundle, loadPlayBundle, invoke, dropOp, isRunning, isHealthy,
  dataDir, publicDataDir, readTextFile, writeTextFile, appendTextFile, renamePath, exists,
  remove, mkdirs, listDir, readAssetText, spikeNativeTimer, verifyPackSignature
};`, app, { filename: 'ios-driver.uts' });
  const api = app.api;
  const request = async (name, ...args) => {
    let reply;
    api[name](...args, (...values) => { assert.equal(reply, undefined, name + ' callback delivered twice'); reply = values; });
    await clock.until(() => reply !== undefined);
    return reply;
  };
  return { api, clock, native, request };
}

const meta = `
let activePlay = null;
let callCount = 0;
export function echo(value) { callCount++; return value; }
export async function query(value) {
  const response = await __qtHost.request('https://music.test/info', {
    method: 'GET', headers: { Referer: 'https://music.test/', Range: 'bytes=0-41' },
    timeoutMs: 1000, responseEncoding: value
  });
  return JSON.stringify(response);
}
export function installPlayPack(args) {
  globalThis.__qtPlayPackFactory = undefined;
  new Function(args.code)();
  activePlay = globalThis.__qtPlayPackFactory();
  return activePlay.name;
}
export function playName() { return activePlay ? activePlay.name : ''; }
export function calls() { return String(callCount); }
export function timer() { return new Promise((resolve) => setTimeout(() => resolve('timer-ok'), 12)); }
globalThis.__qtEntries = { echo, query, installPlayPack, playName, calls, timer };
`;
const handoff = read('services/source-engine.uts').match(/const PLAY_FACTORY_HANDOFF_CODE = "([^"]+)"/)?.[1];
assert.ok(handoff, 'missing production play factory handoff');

let passed = 0;
async function check(label, test) {
  await test();
  passed++;
  console.log('  ✓ ' + label);
}
async function started() {
  const env = environment();
  const [info, error] = await env.request('start', {});
  assert.equal(error, null);
  assert.equal(info.engine, 'webkit-jsc');
  assert.equal(info.probe, '2');
  return env;
}
async function loaded() {
  const env = await started();
  const [reply] = await env.request('loadBundle', meta);
  assert.equal(reply.ok, true, reply.error);
  return env;
}

// Complete production services run after selecting a platform. Only imported
// native/file/network boundaries are supplied by the same driver substitute above.
const serviceJSON = {
  stringify: JSON.stringify,
  parse: (text) => JSON.parse(text, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.setPrototypeOf(value, UTSJSONObject.prototype);
    return value;
  }),
};
function loadService(path, platform, globals = {}) {
  const text = preprocessPlatform(read(path), platform);
  const names = [...text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)].map((match) => match[1]);
  const code = stripTypeScriptTypes(text
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"][ \t]*;?[ \t]*\r?\n/gm, '')
    .replace(/^export /gm, ''));
  const scope = vm.createContext({
    JSON: serviceJSON, UTSJSONObject, console: { log() {}, warn() {}, error() {} }, ...globals,
  });
  vm.runInContext(code + `\n;globalThis.__api={${names.join(',')}};`, scope, { filename: path + ':' + platform });
  return scope.__api;
}
function fileImports(env) {
  return {
    nativeDataDir: env.api.dataDir,
    nativeReadTextFile: env.api.readTextFile,
    nativeWriteTextFile: env.api.writeTextFile,
    nativeAppendTextFile: env.api.appendTextFile,
    nativeRenamePath: env.api.renamePath,
    nativeExists: env.api.exists,
    nativeRemove: env.api.remove,
    nativeMkdirs: env.api.mkdirs,
    nativeListDir: env.api.listDir,
  };
}
function storageService(env, platform = 'APP-IOS') {
  return loadService('services/source-bundle-fs.uts', platform, {
    ...fileImports(env), parseJsonToUtso: serviceJSON.parse, logInfo() {}, logWarnV() {},
  });
}
async function finishService(env, task) {
  let finished = false, result, error;
  Promise.resolve(task).then((value) => { result = value; finished = true; }, (reason) => { error = reason; finished = true; });
  await new Promise(setImmediate);
  await env.clock.until(() => finished);
  if (error) throw error;
  return result;
}

await check('启动幂等并保持串行求值', async () => {
  const env = environment();
  let first, second;
  env.api.start({}, (...args) => { first = args; });
  env.api.start({}, (...args) => { second = args; });
  await env.clock.until(() => first !== undefined && second !== undefined);
  assert.equal(first[0].probe, '2');
  assert.equal(second[0].probe, '2');
  assert.equal(env.native.prepares, 1);
  assert.equal(env.native.maximumEvaluations, 1);
  assert.equal(env.api.isHealthy(), true);
});

await check('Unicode 求值和真实 JS 异常回执', async () => {
  const env = await started();
  const text = "中文🎵\0'\n\u2028\u2029";
  const [result] = await env.request('evaluate', JSON.stringify(text));
  assert.equal(result.ok, true);
  assert.equal(result.value, text);
  const [failure] = await env.request('evaluate', 'throw new Error("eval-failed")');
  assert.equal(failure.ok, false);
  assert.match(failure.error, /eval-failed/);
});

await check('ESM 语法错误在顶层执行前拒绝，旧数据入口可用', async () => {
  const env = await loaded();
  const [result] = await env.request('loadBundle', 'globalThis.__badSideEffect = true; export const broken = ;');
  assert.equal(result.ok, false);
  assert.match(result.error, /语法错误/);
  const [probe] = await env.request('evaluate', 'String(globalThis.__badSideEffect)');
  assert.equal(probe.value, 'undefined');
  const [echo] = await env.request('invoke', 'echo', '["retained-meta"]', 1000);
  assert.equal(echo.value, 'retained-meta');
  assert.equal(env.native.modules.size, 0);
});

await check('播放包重复装载与生产交接桩保持数据槽', async () => {
  const env = await loaded();
  for (const name of ['first', 'second']) {
    const [result] = await env.request('loadPlayBundle', `globalThis.__qtPlayPackFactory = function () { return { name: ${JSON.stringify(name)} }; };`);
    assert.equal(result.ok, true, result.error);
    const [install] = await env.request('invoke', 'installPlayPack', JSON.stringify([{ code: handoff }]), 1000);
    assert.equal(install.ok, true, install.error);
    assert.equal(install.value, name);
    const [echo] = await env.request('invoke', 'echo', '["meta-still-here"]', 1000);
    assert.equal(echo.value, 'meta-still-here');
  }
  const [invalid] = await env.request('loadPlayBundle', 'globalThis.__notAPlayPack = true;');
  assert.equal(invalid.ok, false);
  const [stash] = await env.request('evaluate', 'typeof globalThis.__qtPlayFactoryStash');
  assert.equal(stash.value, 'undefined');
});

await check('HTTP 多行请求头、JSON 和原始 base64 响应贯通', async () => {
  const env = await loaded();
  env.native.replies.push({ status: 206, body: '{"歌曲":"test"}', headers: { 'x-qt-flac-bits': '24' } });
  const [reply] = await env.request('invoke', 'query', '[""]', 1000);
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(JSON.parse(reply.value), { statusCode: 206, headers: { 'x-qt-flac-bits': '24' }, body: { 歌曲: 'test' } });
  assert.match(env.native.requests[0].headers, /Range: bytes=0-41/);
  assert.match(env.native.requests[0].headers, /Referer: https:\/\/music.test\//);
  assert.doesNotMatch(env.native.requests[0].headers, /X-App-Ut|X-Device|X-OS/);
  const binary = Buffer.from([0, 127, 128, 255]).toString('base64');
  env.native.replies.push({ body: binary });
  const [image] = await env.request('invoke', 'query', '["base64"]', 1000);
  assert.equal(JSON.parse(image.value).body, binary);
  assert.equal(env.native.requests[1].encoding, 'base64');
});

await check('非法 invoke 参数失败，入口没有被执行', async () => {
  const env = await loaded();
  const [invalid] = await env.request('invoke', 'echo', '{"not":"array"}', 1000);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /JSON 数组/);
  const [calls] = await env.request('invoke', 'calls', '[]', 1000);
  assert.equal(calls.value, '0');
});

await check('HTTP 超时只结算一次，迟到 JS 结果被丢弃', async () => {
  const env = await loaded();
  env.native.replies.push({ body: '"late"', delay: 500 });
  const replies = [];
  env.api.invoke('query', '[""]', 100, (reply) => replies.push(reply));
  await env.clock.until(() => replies.length === 1);
  assert.equal(replies[0].error, 'timeout');
  await env.clock.advance(env.clock.now + 600);
  assert.equal(replies.length, 1);
});

await check('旧引擎 HTTP 编号与新引擎重复也不会串回执', async () => {
  const env = await loaded();
  env.native.replies.push({ body: '"OLD"', delay: 250 }, { body: '"NEW"', delay: 350 });
  const old = [];
  env.api.invoke('query', '[""]', 1000, (reply) => old.push(reply));
  await env.clock.until(() => env.native.requests.length === 1);
  await env.request('stop');
  assert.equal(old.length, 1);
  assert.equal(old[0].ok, false);
  await env.request('start', {});
  await env.request('loadBundle', meta);
  const [current] = await env.request('invoke', 'query', '[""]', 1000);
  assert.equal(JSON.parse(current.value).body, 'NEW');
  assert.equal(env.native.requests[0].id, env.native.requests[1].id);
  assert.equal(old.length, 1);
});

await check('停止取消正在求值和排队操作，晚到求值不重复结算', async () => {
  const env = await loaded();
  const first = [], second = [], third = [];
  env.api.evaluate('__HANG_EVAL', (reply) => first.push(reply));
  env.api.evaluate('1 + 1', (reply) => second.push(reply));
  env.api.invoke('echo', '["queued"]', 1000, (reply) => third.push(reply));
  await env.clock.until(() => env.native.blockedEvaluations.length === 1);
  await env.request('stop');
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(third.length, 1);
  assert.equal(first[0].ok, false);
  env.native.blockedEvaluations[0]('{"ok":1,"v":"late"}', '');
  await env.clock.advance(env.clock.now + 30);
  assert.equal(first.length, 1);
});

await check('求值看门狗隔离全部待办，stop/start 可恢复', async () => {
  const env = await loaded();
  const replies = [];
  env.api.evaluate('__HANG_EVAL', (reply) => replies.push(reply));
  await env.clock.until(() => replies.length === 1);
  assert.equal(replies[0].ok, false);
  assert.match(replies[0].error, /超时/);
  assert.equal(env.api.isHealthy(), false);
  const [blocked, error] = await env.request('start', {});
  assert.equal(blocked, null);
  assert.match(error, /隔离/);
  await env.request('stop');
  await env.request('start', {});
  const [restored] = await env.request('evaluate', '1 + 1');
  assert.equal(restored.value, '2');
});

await check('停止中的启动回执不会覆盖新实例', async () => {
  const env = environment();
  env.native.prepareDelay = 50;
  const old = [], current = [];
  env.api.start({}, (...reply) => old.push(reply));
  env.api.stop(() => {});
  env.api.start({}, (...reply) => current.push(reply));
  await env.clock.until(() => current.length === 1);
  assert.equal(old.length, 1);
  assert.equal(old[0][0], null);
  assert.equal(current[0][0].probe, '2');
  assert.equal(env.api.isRunning(), true);
  assert.equal(env.api.isHealthy(), true);
});

await check('内容进程退出被健康接口发现', async () => {
  const env = await started();
  env.native.healthy = false;
  assert.equal(env.api.isHealthy(), false);
  await env.request('stop');
  await env.request('start', {});
  assert.equal(env.api.isHealthy(), true);
});

await check('原生定时器 spike 不破坏正式定时器入口', async () => {
  const env = await loaded();
  const [fired, error] = await env.request('spikeNativeTimer', 20);
  assert.equal(fired, '7');
  assert.equal(error, '');
  const [reply] = await env.request('invoke', 'timer', '[]', 1000);
  assert.equal(reply.value, 'timer-ok');
});

await check('dropOp 结算取消，其他调用继续工作', async () => {
  const env = await loaded();
  env.native.replies.push({ body: '"late"', delay: 250 });
  const replies = [];
  env.api.invoke('query', '[""]', 1000, (reply) => replies.push(reply));
  await env.clock.until(() => env.native.requests.length === 1);
  env.api.dropOp(1);
  await env.clock.until(() => replies.length === 1);
  assert.equal(replies[0].error, '调用已放弃');
  await env.clock.advance(env.clock.now + 300);
  assert.equal(replies.length, 1);
  const [next] = await env.request('invoke', 'echo', '["still-running"]', 1000);
  assert.equal(next.value, 'still-running');
});

await check('文件调用保持 UTF-8 文本及错误/布尔桥契约', async () => {
  const env = environment();
  const path = env.api.dataDir() + '/state.json';
  const text = '中文🎵\0\n';
  const [ok] = await env.request('writeTextFile', path, text);
  assert.equal(ok, true);
  await env.request('appendTextFile', path, 'append');
  const [readOK, value] = await env.request('readTextFile', path);
  assert.equal(readOK, true);
  assert.equal(value, text + 'append');
  const [existsOK, existsValue] = await env.request('exists', path);
  assert.equal(existsOK, true);
  assert.equal(existsValue, '1');
  const [missing, missingValue, missingError] = await env.request('readTextFile', path + '.missing');
  assert.equal(missing, false);
  assert.equal(missingValue, '');
  assert.match(missingError, /ENOENT|No such file/);
  const [invalid, , error] = await env.request('readAssetText', '../outside.txt');
  assert.equal(invalid, false);
  assert.match(error, /资源路径/);
  await env.request('readAssetText', 'static/theme.json');
  assert.equal(env.native.fileCalls.at(-1)[1], '/app/bundle/static/theme.json');
});

await check('Ed25519 原生回调独立于引擎，正确/篡改/格式错误均明确', async () => {
  const env = environment();
  const key = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  const signature = Buffer.from(
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155' +
    '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b', 'hex').toString('base64');
  const [valid] = await env.request('verifyPackSignature', '', signature, key);
  assert.equal(valid.ok, true);
  assert.equal(valid.value, 'ok');
  const [tampered] = await env.request('verifyPackSignature', 'changed', signature, key);
  assert.equal(tampered.value, 'bad');
  const [invalid] = await env.request('verifyPackSignature', '', signature, 'not-hex');
  assert.equal(invalid.ok, false);
  assert.ok(invalid.error);
});

await check('iOS 音源包文件、活动槽与后续版本提交能在重启后恢复', async () => {
  const env = environment();
  const store = storageService(env);
  assert.equal(store.packageRoot(), env.api.dataDir() + '/source-bundle');
  for (const kind of ['meta', 'play']) {
    const id = 'test-' + kind;
    const pack = {
      id, kind, name: '测试' + kind, versionCode: 1, versionName: '1', updateUrl: '',
      dir: store.packDirOf(id), installedAt: 1, updatedAt: 1, skipCodes: [], lastProbeAt: 0,
      installSource: 'file', installRef: id + '.js', lastError: '', lastErrorAt: 0, signVerified: false,
    };
    assert.equal(await finishService(env, store.ensurePackDir(id)), true);
    assert.equal(await finishService(env, store.writePackArtifact(id, store.artifactOfKind(kind), 'v1 中文🎵')), true);
    assert.equal(await finishService(env, store.putPack(pack, true)), true);
    assert.equal(await finishService(env, store.writePackArtifact(id, store.artifactOfKind(kind), 'v2 中文🎵')), true);
    assert.equal(await finishService(env, store.putPack({ ...pack, versionCode: 2, updatedAt: 2 }, true)), true);
  }
  const restarted = storageService(env);
  await finishService(env, restarted.ensureLocalStateRestored());
  assert.equal(restarted.activeMetaPack().id, 'test-meta');
  assert.equal(restarted.activePack().id, 'test-play');
  assert.equal(restarted.activePack().versionCode, 2);
  assert.equal(await finishService(env, restarted.readPackArtifact('test-meta', restarted.ARTIFACT_META)), 'v2 中文🎵');
  assert.equal(await finishService(env, restarted.readPackArtifact('test-play', restarted.ARTIFACT_PLAY)), 'v2 中文🎵');
  assert.ok([...env.native.files.keys()].every((key) => !key.includes('.stage-')), 'atomic staging files must be cleaned');
  const orphan = restarted.packDirOf('orphan-play') + '/play-bundle.js';
  env.native.files.set(orphan, 'orphan');
  await finishService(env, restarted.pruneOrphans());
  assert.equal(env.native.files.has(orphan), false);
  assert.equal(await finishService(env, restarted.removePack('test-play')), true);
  assert.equal(restarted.activePack(), null);
  const afterRemoval = storageService(env);
  await finishService(env, afterRemoval.ensureLocalStateRestored());
  assert.equal(afterRemoval.activePack(), null);
  assert.equal(afterRemoval.activeMetaPack().id, 'test-meta');
});

await check('iOS 日志通过原生追加落盘，读取与重启保留此前内容', async () => {
  const env = environment();
  const logger = () => loadService('services/logger.uts', 'APP-IOS', {
    ...fileImports(env), uni: { getStorageSync() { return ''; } },
    getClientUt: () => 'ios', getClientDevice: () => 'iPhone', getClientOs: () => 'iOS 17',
    getCurrentVersionName: () => 'test', getCurrentVersionCode: () => 1,
  });
  const first = logger();
  assert.equal(first.logSupported(), true);
  assert.equal(first.logPath(), env.api.dataDir() + '/logs/quietmusic.log');
  first.initLogger();
  first.logInfo('SourceEngine', '音源就绪 中文🎵');
  assert.equal(await finishService(env, first.flushLogs()), true);
  const second = logger();
  second.initLogger();
  second.logWarn('SourceEngine', '重启 https://astral.canace.cn/api/v1/test');
  const lines = await finishService(env, second.readLogs());
  assert.ok(lines.some((line) => line.includes('音源就绪 中文🎵')));
  assert.ok(lines.some((line) => line.includes('重启 /api/v1/test')));
  assert.equal(lines.filter((line) => line.includes('===== 启动')).length, 2);
  assert.equal(await finishService(env, second.logBytes()), Buffer.byteLength(env.native.files.get(second.logPath())));
});

await check('三端更新平台号、manifest 白名单及上报按实际平台选择，H5 保持文件能力降级', async () => {
  for (const [platform, expected] of [['APP-IOS', 1102], ['APP-ANDROID', 1101], ['APP-HARMONY', 1106], ['H5', 1101]]) {
    const env = environment();
    const requests = [];
    let allowed = [1102];
    const manifest = () => ({
      code: 200, data: { schema: 3, generatedAt: '', release: {
        sourceVersionCode: 2, sourceVersionName: '2', hostApiVersion: 1, platforms: allowed,
        rollbackTo: 0, published: true, bad: false, artifacts: [{ path: 'play-bundle.js', url: 'https://packs.test/play.js' }],
      } },
    });
    const store = storageService(env, platform);
    const updates = loadService('services/source-update.uts', platform, {
      ...store,
      // Platform filtering is independent of disk initialization.
      ensureLocalStateRestored: async () => {}, packById: () => null, isPackBadVersion: () => false,
      uni: { request(options) { requests.push(options); options.success({ statusCode: 200, data: JSON.stringify(manifest()) }); } },
      resolveUrl: (path) => 'https://gateway.test/' + path, parseJsonToUtso: serviceJSON.parse,
      mergeClientHeaders(headers) { headers.set('X-App-Ut', platform); }, getAccessToken: () => '',
      getCurrentVersionCode: () => 1, getCurrentVersionName: () => '1', logErrV() {}, logInfo() {}, logWarn() {},
    });
    assert.equal(updates.currentPlatform(), expected);
    const iosOnly = await updates.officialInstallOffer('play');
    assert.equal(iosOnly !== null, expected === 1102);
    assert.match(requests.at(-1).url, new RegExp('[?]platform=' + expected + '&'));
    allowed = [expected];
    assert.ok(await updates.officialInstallOffer('play'));
    allowed = [];
    assert.ok(await updates.officialInstallOffer('play'));
    await updates.reportResult(2, true, '');
    assert.equal(requests.at(-1).data.get('platform'), expected);
    if (platform === 'H5') {
      assert.equal(store.packageRoot(), '');
      assert.equal(await store.writePackArtifact('test-play', store.ARTIFACT_PLAY, 'unavailable'), false);
      const log = loadService('services/logger.uts', platform);
      assert.equal(log.logSupported(), false);
    } else {
      assert.equal(store.packageRoot(), env.api.dataDir() + '/source-bundle');
    }
  }
});

const [realMetaPath, realPlayPath] = process.argv.slice(2);
if (realMetaPath && realPlayPath) {
  await check('真实官方 meta/play 产物通过相同模块与工厂交接通道', async () => {
    const env = await started();
    const realMeta = readFileSync(realMetaPath, 'utf8');
    const realPlay = readFileSync(realPlayPath, 'utf8');
    const [metaLoaded] = await env.request('loadBundle', realMeta);
    assert.equal(metaLoaded.ok, true, metaLoaded.error);
    const [playLoaded] = await env.request('loadPlayBundle', realPlay);
    assert.equal(playLoaded.ok, true, playLoaded.error);
    const [installed] = await env.request('invoke', 'installPlayPack', JSON.stringify([{ code: handoff }]), 10000);
    assert.equal(installed.ok, true, installed.error);
    assert.equal(JSON.parse(installed.value).ok, true);
    const [info] = await env.request('invoke', 'bundleInfo', '[]', 1000);
    const details = JSON.parse(info.value);
    assert.equal(details.name, 'meta-bundle');
    assert.equal(details.hostApiVersion, 1);
    assert.ok(details.playPack);
    assert.equal(env.native.requests.length, 0, 'offline installation must not send HTTP');
  });
}

console.log(`\n[check-ios-source-engine] ${passed} 项通过（原生框架编译/真机行为需另验）。`);
