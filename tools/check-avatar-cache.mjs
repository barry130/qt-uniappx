// Actual avatar/auth/http/user-cache/media modules and shared Vue presentation.
// Storage, filesystem, network receipts and time are synthetic; no device timing claims.
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { read, load, deferred, drain, noop, parseJsonToUtso } from './check-source-auth-session.mjs';

const urlA = 'https://images.invalid/avatar-a.png';
const urlB = 'https://images.invalid/avatar-b.png';
const moduleAt = (path, scope) => {
  const text = read(path).replace(/^export\s*\{[^}]*\}(?:\s*from\s*["'][^"']+["'])?;?\s*/gm, '');
  const names = [...text.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map(m => m[1]);
  return load(text, names, scope);
};
const me = avatar => parseJsonToUtso(JSON.stringify({ user: { id: 'A', nickname: 'Alice', avatar } }));
function fixture(disk = { storage: new Map(), files: new Map() }, root = 'unifile://usr') {
  const downloads = [], requests = [], deleted = [], events = new Map(), unmounts = [];
  const b = { ...disk, disk, downloads, requests, deleted, time: 100000, failCopy: false, failStorage: false };
  class Clock extends Date { static now() { return b.time; } }
  const fs = {
    accessSync(path) { if (!disk.files.has(path)) throw new Error('fixture missing file'); },
    copyFileSync(from, to) {
      if (b.failCopy || !disk.files.has(from)) throw new Error('fixture copy failure');
      disk.files.set(to, disk.files.get(from));
    },
    unlinkSync(path) { deleted.push(path); disk.files.delete(path); },
    getFileInfo({ filePath, success, fail }) { if (disk.files.has(filePath)) success({ size: 64 }); else fail(); },
  };
  const uni = {
    env: { USER_DATA_PATH: root },
    getStorageSync: key => disk.storage.get(key) ?? '',
    setStorageSync: (key, value) => { if (b.failStorage) throw new Error('fixture storage failure'); disk.storage.set(key, value); },
    removeStorageSync: key => disk.storage.delete(key),
    getFileSystemManager: () => fs,
    downloadFile: options => downloads.push(options),
    uploadFile: options => options.success({ statusCode: 200 }),
    $on: (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    $off: (name, fn) => events.get(name)?.delete(fn),
    $emit: name => { for (const fn of events.get(name) ?? []) fn(); },
  };
  const scope = { uni, Date: Clock, logWarn: noop, ref, onUnmounted: fn => unmounts.push(fn) };
  Object.assign(scope, moduleAt('services/auth.ts', scope));
  Object.assign(scope, moduleAt('services/http.ts', { ...scope, API_BASE_URL: 'https://gateway.invalid/api/' }));
  b.avatar = moduleAt('services/avatar-cache.ts', scope);
  Object.assign(scope, b.avatar);
  b.user = moduleAt('services/user-cache.ts', { ...scope, accountApi: { me() {
    const d = deferred(); requests.push(d); return d.promise;
  } } });
  Object.assign(scope, b.user);
  b.display = moduleAt('uni_modules/qt-ui/composables/use-qt-avatar.ts', scope).useQtAvatar;
  b.auth = scope;
  b.login = (owner = 'A') => {
    scope.saveUserId(owner);
    scope.saveTokens({ accessToken: owner + '-access', refreshToken: owner + '-refresh', expiresAt: b.time + 3600000 });
  };
  b.finish = async (index, bytes = 'valid-image') => {
    const path = 'unifile://temp/avatar-' + index + '.png';
    disk.files.set(path, bytes);
    downloads[index].success({ statusCode: 200, tempFilePath: path });
    await drain();
    return path;
  };
  b.sourceBytes = () => disk.files.get(decodeURI(b.avatar.getAvatarSource().replace(/^file:\/\//, '')));
  b.listeners = () => events.get(scope.AVATAR_CHANGED_EVENT)?.size ?? 0;
  b.unmount = () => { for (const fn of unmounts) fn(); };
  b.media = extra => moduleAt('services/media.ts', { ...scope, ...extra });
  return b;
}
let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log('  ✓ ' + label); }

await check('first download is shared by three views; cold restart displays local bytes before any network', async () => {
  const b = fixture(); b.login(); b.user.setCachedMe(me(urlA));
  const views = Array.from({ length: 3 }, () => b.display());
  assert.equal(b.downloads.length, 1); assert.equal(b.listeners(), 3);
  assert.equal(views[0].avatarSource.value, b.avatar.DEFAULT_AVATAR_ASSET);
  assert.equal(b.downloads[0].header, undefined, 'public CDN must not receive account/client headers');
  await b.finish(0, 'A-image');
  const path = b.avatar.getAvatarSource();
  for (const view of views) assert.equal(view.avatarSource.value, path);
  assert.equal(b.sourceBytes(), 'A-image');
  b.unmount(); assert.equal(b.listeners(), 0);
  const restarted = fixture(b.disk); // Entirely new module instances, shared disk only.
  assert.equal(restarted.display().avatarSource.value, path);
  restarted.user.getCachedMe();
  await restarted.avatar.prepareCachedAvatar();
  assert.equal(restarted.downloads.length, 0);
  const pending = restarted.user.refreshMe();
  assert.equal(restarted.avatar.getAvatarSource(), path, '/me latency must not blank an existing image');
  restarted.requests[0].reject(new Error('fixture offline')); await pending;
  assert.equal(restarted.avatar.getAvatarSource(), path);
});
await check('replacement publishes only after copy; disk-full upload displays new temporary image over old cache', async () => {
  const b = fixture(); b.login(); b.avatar.cacheUserAvatar(urlA); await b.finish(0, 'old');
  const old = b.avatar.getAvatarSource();
  b.avatar.cacheUserAvatar(urlB);
  assert.equal(b.avatar.getAvatarSource(), old);
  await b.finish(1, 'new');
  assert.notEqual(b.avatar.getAvatarSource(), old); assert.equal(b.sourceBytes(), 'new');
  assert.ok(b.deleted.includes(old));
  b.files.set('unifile://picked/new.png', 'uploaded'); b.failCopy = true;
  b.avatar.cacheUserAvatar(urlA, 'unifile://picked/new.png');
  assert.equal(b.avatar.getAvatarSource(), 'unifile://picked/new.png');
  assert.equal(b.avatar.getCachedAvatarUrl(), urlA);
  assert.equal(b.downloads.length, 2, 'upload preview never re-downloads the same chosen bytes');
});
await check('changing account or logout discards late downloads and never trusts the legacy unowned URL', async () => {
  const b = fixture(); b.storage.set('qt-avatar', urlA); b.login();
  assert.equal(b.avatar.getCachedAvatarUrl(), '');
  b.avatar.cacheUserAvatar(urlA); b.login('B');
  assert.equal(b.avatar.getAvatarSource(), b.avatar.DEFAULT_AVATAR_ASSET);
  b.avatar.cacheUserAvatar(urlB); await b.finish(0, 'late-A');
  assert.equal(b.avatar.getAvatarSource(), b.avatar.DEFAULT_AVATAR_ASSET);
  await b.finish(1, 'B'); assert.equal(b.sourceBytes(), 'B');
  const view = b.display(); b.auth.clearTokens(); b.user.clearCachedMe();
  assert.equal(view.avatarSource.value, b.avatar.DEFAULT_AVATAR_ASSET);
  assert.equal(b.avatar.getCachedAvatarUrl(), '');
  b.login(); b.avatar.cacheUserAvatar(urlA); b.auth.clearTokens(); b.user.clearCachedMe();
  await b.finish(2, 'late-after-logout');
  assert.equal(b.avatar.getAvatarSource(), b.avatar.DEFAULT_AVATAR_ASSET);
  assert.equal([...b.files.keys()].filter(p => p.startsWith('unifile://usr/qt-user-avatar-')).length, 0);
});
await check('account-scoped profile migrates before /me; missing and corrupt files recover without a download loop', async () => {
  const b = fixture(); b.login(); b.storage.set('qt-user-me:A', JSON.stringify(me(urlA)));
  b.user.getCachedMe(); assert.equal(b.requests.length, 0); assert.equal(b.downloads.length, 1);
  await b.finish(0);
  b.files.delete(b.avatar.getAvatarSource());
  const c = fixture(b.disk), view = c.display();
  assert.equal(view.avatarSource.value, c.avatar.DEFAULT_AVATAR_ASSET); assert.equal(c.downloads.length, 1);
  await c.finish(0, 'corrupt'); view.onAvatarError();
  assert.equal(c.downloads.length, 2); await c.finish(1, 'still-corrupt'); view.onAvatarError();
  for (let i = 0; i < 10; i++) { view.refreshAvatar(); view.onAvatarError(); }
  assert.equal(c.downloads.length, 2, 'page refresh must obey decode-failure backoff');
  c.time += 30001; view.refreshAvatar(); assert.equal(c.downloads.length, 3);
  c.downloads[2].fail(); await drain();
  for (let i = 0; i < 10; i++) view.refreshAvatar();
  assert.equal(c.downloads.length, 3, 'network failure must also back off');
});
await check('successful upload uses picked bytes and invalidates an older /me response', async () => {
  const b = fixture(); b.login(); b.user.setCachedMe(me(urlA)); await b.finish(0, 'old');
  const pending = b.user.refreshMe();
  b.files.set('unifile://picked/avatar.png', 'new-upload');
  const media = b.media({ apiRequest: async path => {
    if (path.endsWith('upload-plan')) return parseJsonToUtso(JSON.stringify({ mode: 'DIRECT', ticket: {
      uploadUrl: 'https://upload.invalid/image', uploadId: 'id', method: 'POST', formField: 'file',
    } }));
    assert.equal(path, 'app/user/avatar/complete');
    return parseJsonToUtso(JSON.stringify({ url: urlB }));
  } });
  assert.equal(await media.uploadAvatar('unifile://picked/avatar.png'), urlB);
  assert.equal(b.sourceBytes(), 'new-upload'); assert.equal(media.getCachedAvatar(), urlB);
  assert.equal(b.downloads.length, 1);
  b.requests[0].resolve(me(urlA)); assert.equal(await pending, null);
  assert.equal(b.user.getCachedMe().get('user').get('avatar'), urlB);
  b.avatar.clearCachedAvatar();
  assert.equal(b.files.get('unifile://picked/avatar.png'), 'new-upload', 'cleanup may only remove owned cache files');
});
await check('absolute filesystem paths are escaped only for image display; stale URL downloads cannot replace new upload', async () => {
  const b = fixture(undefined, '/private/app files'); b.login();
  b.avatar.cacheUserAvatar(urlA);
  b.files.set('/picked/new.png', 'upload'); b.avatar.cacheUserAvatar(urlB, '/picked/new.png');
  const src = b.avatar.getAvatarSource();
  assert.match(src, /^file:\/\/\/private\/app%20files\/qt-user-avatar-/);
  await b.finish(0, 'old'); assert.equal(b.avatar.getAvatarSource(), src);
  assert.equal(b.avatar.getCachedAvatarUrl(), urlB);
  b.avatar.cacheUserAvatar(''); assert.equal(b.avatar.getAvatarSource(), b.avatar.DEFAULT_AVATAR_ASSET);
});
console.log(`Avatar startup: ${passed} regressions passed (real cache/upload modules; synthetic native boundaries).`);
