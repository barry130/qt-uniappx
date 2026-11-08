/** Actual-source regressions for package commit/rollback, source-account CAS and
 * login navigation. All storage, network and native boundaries are in memory. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = new Proxy({}, { get: () => () => {} });
const parseUtso = text => JSON.parse(text, (k, v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    Object.defineProperties(v, { get: { value: key => v[key] ?? null }, set: { value: (key, value) => { v[key] = value; } } });
  }
  return v;
});
function nativeBranches(text) {
  return text.replace(/\/\/ #ifndef APP-ANDROID \|\| APP-HARMONY[\s\S]*?\/\/ #endif/g, '');
}
function load(file, modules, globals = {}, append = '') {
  const text = nativeBranches(fs.readFileSync(path.join(root, file), 'utf8')) + '\n' + append;
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...globals });
  vm.runInContext(`class UTSJSONObject { get(k) { return this[k] ?? null } set(k,v) { this[k]=v } static keys(o) { return Object.keys(o) } }
    const parse=JSON.parse; JSON.parse=(s)=>parse(s,(k,v)=>{ if(v && typeof v==='object' && !Array.isArray(v)) Object.setPrototypeOf(v,UTSJSONObject.prototype); return v });`, context);
  context.module = { exports: {} }; context.exports = context.module.exports;
  context.require = id => { if (id in modules) return modules[id]; throw Error('unexpected import: ' + id); };
  vm.runInContext(js, context, { filename: file });
  return context.module.exports;
}
const meta = (id = 'test-play', code = 1, kind = 'play') => ({ id, kind, name: id, versionCode: code, versionName: String(code), updateUrl: '', dir: '', installedAt: 1, updatedAt: code, skipCodes: [], lastProbeAt: 0, installSource: 'file', installRef: '', lastError: '', lastErrorAt: 0, signVerified: false });
const packText = (p, body = 'good') => '/*__QT_PACK__' + JSON.stringify(p) + '*/\n__qtPlayPackFactory;' + body;
let cases = 0;
function pass(label) { console.log('OK ' + label); cases++; }

function diskFixture() {
  const files = new Map(); let failWrite = ''; let failRename = '';
  const native = {
    dataDir: () => '/app',
    readTextFile: (p, cb) => cb(files.has(p), files.get(p) ?? '', 'missing'),
    writeTextFile: (p, text, cb) => { if (p.includes(failWrite) && failWrite) { files.set(p, 'partial'); cb(false, '', 'disk full'); } else { files.set(p, text); cb(true, '', ''); } },
    renamePath: (a, b, cb) => { if (b === failRename) return cb(false, '', 'rename failed'); files.set(b, files.get(a)); files.delete(a); cb(true, '', ''); },
    exists: (p, cb) => cb(true, files.has(p) ? '1' : '0', ''),
    remove: (p, cb) => { for (const key of files.keys()) if (key === p || key.startsWith(p + '/')) files.delete(key); cb(true, '', ''); },
    mkdirs: (p, cb) => cb(true, '', ''), listDir: (p, cb) => cb(true, '[]', ''),
  };
  const open = () => load('services/source-bundle-fs.uts', { '@/uni_modules/qt-js-engine': native, '@/services/logger': quiet, '@/services/http': { parseJsonToUtso: parseUtso } });
  return { files, open, failWrite: p => { failWrite = p; }, failRename: p => { failRename = p; } };
}
{
  const d = diskFixture(), s = d.open(), p = meta();
  assert.equal(await s.putPack(p, true), true);
  await s.writePackArtifact(p.id, s.ARTIFACT_PLAY, 'old');
  d.failWrite('play-bundle.js.stage-');
  assert.equal(await s.writePackArtifact(p.id, s.ARTIFACT_PLAY, 'new'), false);
  assert.equal(await s.readPackArtifact(p.id, s.ARTIFACT_PLAY), 'old');
  d.failWrite(''); d.failRename(s.statePath());
  assert.equal(await s.putPack(meta(p.id, 2), true), false);
  assert.equal(s.activePack().versionCode, 1);
  assert.equal(await s.removePack(p.id), false);
  assert.equal(await s.readPackArtifact(p.id, s.ARTIFACT_PLAY), 'old');
  pass('failed staging/state publication/removal preserve published package and registry');
}
{
  const d = diskFixture(), s = d.open(), p = meta();
  await s.putPack(p, true); await s.writePackArtifact(p.id, s.ARTIFACT_PLAY, 'old');
  const main = s.artifactPath(p.id, s.ARTIFACT_PLAY);
  await s.writeTextFileAt(main + '.prev', 'old');
  await s.writeTextFileAt(main + '.prev.chain', 'old-chain');
  assert.equal(await s.beginPackInstall(p.id, p.kind, 2, true, true), true);
  await s.writePackArtifact(p.id, s.ARTIFACT_PLAY, 'new');
  const restarted = d.open(); await restarted.restoreLocalState();
  assert.equal(await restarted.readPackArtifact(p.id, s.ARTIFACT_PLAY), 'old');
  assert.equal(await restarted.readPackArtifact(p.id, s.ARTIFACT_CHAIN), 'old-chain');
  assert.equal(restarted.activePack().versionCode, 1);
  pass('restart between artifact and registry commits restores main + chain');
}
{
  const d = diskFixture(), s = d.open(), p = meta();
  await s.putPack(p, true); await s.writePackArtifact(p.id, s.ARTIFACT_PLAY, 'old');
  const main = s.artifactPath(p.id, s.ARTIFACT_PLAY);
  await s.writeTextFileAt(main + '.prev', 'old');
  await s.beginPackInstall(p.id, p.kind, 2, true, false);
  await s.writePackArtifact(p.id, s.ARTIFACT_PLAY, 'new');
  await s.putPack(meta(p.id, 2), true);
  const restarted = d.open(); await restarted.restoreLocalState();
  assert.equal(await restarted.readPackArtifact(p.id, s.ARTIFACT_PLAY), 'new');
  assert.equal(restarted.activePack().versionCode, 2);
  pass('restart after registry commit keeps the committed new artifact');
}
{
  const d = diskFixture(), s = d.open(), p = meta();
  await s.putPack(p, true); await s.writePackArtifact(p.id, s.ARTIFACT_PLAY, 'old');
  await s.beginPackInstall(p.id, p.kind, 2, true, true); // missing backups simulate incomplete recovery
  assert.equal(await s.recoverPackInstall(), false);
  assert.equal(await s.beginPackInstall('other-play', 'play', 3, false, false), false);
  await s.pruneOrphans();
  assert.equal(await s.readPackArtifact(p.id, s.ARTIFACT_PLAY), 'old');
  await assert.rejects(d.open().restoreLocalState(), /恢复未完成/);
  pass('failed journal recovery blocks restore, replacement installation and pruning');
}
function installFixture({ failCommit = false, rollbackLoad = true } = {}) {
  let state = { activeId: 'test-play', activeMetaId: '', packs: [meta()], lastCheckAt: 0 };
  const files = new Map([['/packs/test-play/play-bundle.js', 'old-body'], ['/packs/test-play/chain.json', 'old-chain']]);
  let pruned = 0, runningCode = 1, cacheReady = true, loads = 0;
  const byId = id => state.packs.find(p => p.id === id) ?? null;
  const storage = {
    PACK_KIND_META: 'meta', PACK_KIND_PLAY: 'play', ARTIFACT_PLAY: 'play-bundle.js', ARTIFACT_META: 'meta-bundle.js', ARTIFACT_CHAIN: 'chain.json',
    localState: () => state, packById: byId, activePack: () => byId(state.activeId), activeMetaPack: () => null,
    ensureLocalStateRestored: async () => {}, recoverPackInstall: async () => true, beginPackInstall: async () => true, finishPackInstall: async () => true,
    packDirOf: id => '/packs/' + id, artifactOfKind: kind => kind + '-bundle.js', artifactPath: (id, art) => '/packs/' + id + '/' + art,
    ensurePackDir: async () => true, readPackArtifact: async (id, art) => files.get('/packs/' + id + '/' + art) ?? '',
    writePackArtifact: async (id, art, text) => { files.set('/packs/' + id + '/' + art, text); return true; },
    writeTextFileAt: async (p, text) => { files.set(p, text); return true; }, readTextFileAt: async p => files.get(p) ?? '',
    removeFileAt: async p => { files.delete(p); return true; }, removePackArtifact: async (id, art) => { files.delete('/packs/' + id + '/' + art); return true; },
    putPack: async (p, active) => { if (failCommit) return false; state.packs = [p]; if (active) state.activeId = p.id; return true; },
    restorePackRecord: async (p, id, a, m) => { state.packs = p ? [p] : []; state.activeId = a; state.activeMetaId = m; return true; },
    pruneOrphans: async () => { pruned++; }, isOfficialPackId: () => false, clearPackError: async () => {}, notePackError: async () => {},
  };
  const engine = {
    invalidatePlayPackCache: () => { cacheReady = false; }, playPackReady: () => cacheReady,
    loadedPlayPackId: () => state.activeId, loadedPlayPackCode: () => runningCode,
    ensurePlayPackLoaded: async () => { loads++; if (loads > 1 && !rollbackLoad) return false; runningCode = byId(state.activeId).versionCode; cacheReady = true; return true; },
    getPlayUrlByEngine: async () => '', verifyPlayableByEngine: async () => false,
  };
  const svc = load('services/source-update.uts', { '@/services/source-bundle-fs': storage, '@/services/source-engine': engine,
    '@/services/http': {}, '@/services/client-info': {}, '@/services/auth': {}, '@/services/app-version': {}, '@/services/music-api': { musicApi: { clearPlayUrlCache() {} } },
    '@/services/source-pack-header': {}, '@/services/pack-signature': { splitSignatureBlock: text => ({ content: text }) }, '@/services/pack-safety': { scanPackText: () => '' }, '@/services/logger': quiet,
  }, { uni: { $emit() {} } }, 'export { installPackText };');
  return { svc, files, state: () => state, pruned: () => pruned, code: () => runningCode };
}
{
  const f = installFixture({ failCommit: true });
  const r = await f.svc.installPackText(packText(meta('test-play', 2)), meta('test-play', 2), [], true, 'file', 'x.js');
  assert.equal(r.ok, false); assert.equal(f.pruned(), 0); assert.equal(f.state().packs[0].versionCode, 1);
  assert.equal(f.files.get('/packs/test-play/play-bundle.js'), 'old-body'); assert.equal(f.files.get('/packs/test-play/chain.json'), 'old-chain');
  pass('PACK-01 actual install rejects failed registry commit without prune and restores both artifacts');
}
for (const rollbackLoad of [true, false]) {
  const f = installFixture({ rollbackLoad });
  const r = await f.svc.installPackText(packText(meta('test-play', 2)), meta('test-play', 2), [{ name: 'fixture' }], true, 'file', 'x.js');
  assert.equal(r.ok, false); assert.equal(r.message.includes('已回滚'), rollbackLoad);
  assert.equal(r.message.includes('回滚未完成'), !rollbackLoad);
  assert.equal(f.files.get('/packs/test-play/chain.json'), 'old-chain');
  assert.equal(f.code(), rollbackLoad ? 1 : 2);
  pass('PACK-04 rollback ' + (rollbackLoad ? 'confirms old live revision' : 'reports runtime reload failure'));
}
{
  let p = meta(), body = 'bad', attempts = 0;
  const svc = load('services/source-engine.uts', {
    '@/services/source-bundle-fs': { ensureLocalStateRestored: async () => {}, activePack: () => p, activeMetaPack: () => meta('test-meta', 1, 'meta'), ARTIFACT_PLAY: 'play-bundle.js', ARTIFACT_META: 'meta-bundle.js', ARTIFACT_CHAIN: 'chain.json', PACK_KIND_META: 'meta', readPackArtifact: async (id, art) => art === 'meta-bundle.js' ? 'meta' : art === 'play-bundle.js' ? body : '' },
    '@/services/source-pack-header': { parsePackHeader: () => ({ kind: 'meta', versionCode: 1 }) }, '@/services/logger': quiet,
    '@/uni_modules/qt-js-engine': {
      isHealthy: () => true, isRunning: () => true,
      start: (opts, cb) => cb({ hostApiVersion: 1, version: 'test', engine: 'test', probe: '2' }, null), stop: cb => cb({ ok: true }), loadBundle: (code, cb) => cb({ ok: true }),
      loadPlayBundle: (code, cb) => { attempts++; cb({ ok: code !== 'bad', error: 'bad body' }); },
      invoke: (name, args, timeout, cb) => cb({ ok: true, value: name === 'bundleInfo' ? '{"name":"meta-bundle","hostApiVersion":1}' : '{"ok":true}' }),
    },
  }, { uni: { $emit() {} } });
  assert.equal(await svc.ensurePlayPackLoaded(), false);
  const failedAttempts = attempts;
  assert.equal(await svc.ensurePlayPackLoaded(), false); assert.equal(attempts, failedAttempts);
  p = meta('test-play', 2); body = 'good';
  assert.equal(await svc.ensurePlayPackLoaded(), true); assert.equal(attempts, failedAttempts + 1);
  p = { ...p, updatedAt: 3 }; assert.equal(await svc.ensurePlayPackLoaded(), true); assert.equal(attempts, failedAttempts + 2);
  pass('PACK-02 bad v1 → same-ID good v2 and same-version reinstall both load');
}
function authFixture() {
  const storage = new Map(), pending = [];
  const svc = load('services/source-auth.ts', { './source-engine': { setMetaAuthHook() {}, invokeSource: async name => name === 'authUser' ? await new Promise(resolve => pending.push(resolve)) : '{}' }, './http': { parseJsonToUtso: text => JSON.parse(text, (k, v) => { if (v && typeof v === 'object' && !Array.isArray(v)) { Object.defineProperties(v, { get: { value: k => v[k] ?? null }, set: { value: (k, x) => { v[k] = x; } } }); } return v; }) } }, { uni: { getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, v), removeStorageSync: k => storage.delete(k), $emit() {} } });
  return { svc, pending };
}
const user = id => ({ id, nickname: id, avatar: '', vip: false, vipLabel: '' });
for (const replace of [false, true]) {
  const { svc, pending } = authFixture();
  await svc.saveSourceAuthAccount('qq', 'old-cookie', user('A'), '');
  const task = svc.refreshAllSourceAccounts('test'); await Promise.resolve();
  if (replace) await svc.saveSourceAuthAccount('qq', 'new-cookie', user('B'), '');
  else await svc.removeSourceAuthAccount('qq');
  pending[0]('{"ok":true,"credential":{"cookie":"rotated-old"}}');
  const stats = await task; assert.equal(stats.rotated, 0);
  const entries = svc.readSourceAuthEntries();
  assert.equal(entries.length, replace ? 1 : 0);
  if (replace) assert.equal(entries[0].account.user.id, 'B');
  pass('PACK-03 late refresh after ' + (replace ? 'account replacement' : 'logout') + ' cannot commit');
}

// Execute Android navigation methods with minimal Android boundary stand-ins.
{
  const text = fs.readFileSync(path.join(root, 'uni_modules/qt-app-native/utssdk/app-android/index.uts'), 'utf8');
  const functions = text.slice(text.indexOf('function qtAuthTrustedOrigin('), text.indexOf('/** 轻提示：', text.indexOf('function qtAuthTrustedOrigin(')));
  const client = text.slice(text.indexOf('class QtAuthWebViewClient'), text.indexOf('/** 登录 WebView：额外接管'));
  const launched = [];
  const Uri = { parse: value => { const u = new URL(value); return { getScheme: () => u.protocol.slice(0, -1), getHost: () => u.hostname, getUserInfo: () => u.username || u.password ? 'user' : null, getPort: () => u.port ? Number(u.port) : -1, toString: () => value }; } };
  class Intent {
    static ACTION_VIEW = 'view'; static CATEGORY_BROWSABLE = 'browsable'; static URI_INTENT_SCHEME = 1;
    constructor(action, data) { this.action = action; this.data = data; this.extras = {}; }
    static parseUri(value) { return { getData: () => Uri.parse('mqqapi://sso'), getPackage: () => value.includes('evil.package') ? 'evil.package' : 'com.tencent.mobileqq', component: 'evil.Component', selector: 'evil.Selector', extras: { dangerous: true } }; }
    setPackage(value) { this.package = value; } addCategory(value) { this.category = value; }
  }
  const context = vm.createContext({ console, Uri, Intent, WebViewClient: class {}, UTSAndroid: { getUniActivity: () => ({ startActivity: intent => launched.push(intent) }) }, qtAuthFail: () => {}, gAuthExternalLaunched: false });
  vm.runInContext(ts.transpileModule(functions + client + '\nglobalThis.Client=QtAuthWebViewClient;', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  const invoke = (initial, current, url, frame = true, gesture = true) => new context.Client(initial).shouldOverrideUrlLoading({ getUrl: () => current }, { getUrl: () => ({ toString: () => url }), isForMainFrame: () => frame, hasGesture: () => gesture });
  const trusted = 'https://y.qq.com/login';
  for (const args of [[trusted, trusted, 'mqqapi://sso', false, true], [trusted, trusted, 'mqqapi://sso', true, false], ['https://custom.example', trusted, 'mqqapi://sso'], [trusted, 'https://y.qq.com.evil.example', 'mqqapi://sso'], [trusted, trusted, 'file:///private'], [trusted, trusted, 'intent://sso#evil.package']]) invoke(...args);
  assert.equal(launched.length, 0);
  invoke(trusted, trusted, 'intent://sso#Intent;component=evil.Component;end');
  assert.equal(launched.length, 1); assert.equal(launched[0].package, 'com.tencent.mobileqq'); assert.equal(launched[0].category, 'browsable'); assert.equal(launched[0].action, 'view'); assert.equal(launched[0].component, undefined); assert.deepEqual(launched[0].extras, {});
  pass('SEC-02 rejects untrusted/iframe/automatic navigation and rebuilds sanitized QQ intent');
}
console.log(`source-integrity: ${cases} actual-source regression groups passed`);
