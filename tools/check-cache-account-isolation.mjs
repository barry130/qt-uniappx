// Agreed seam: checkbox selection -> submit -> confirmation -> actual cache page action.
// Real auth.ts and user-cache.ts run against fixture storage. No network or real accounts.
// Unrelated cache counters and Vue/native UI host are synthetic; not a complete Pinia/device test.
import assert from 'node:assert/strict';
import { read, load, host, deferred, drain, noop, UTSJSONObject } from './check-source-auth-session.mjs';

function fixture() {
  const b = host(), confirmations = [];
  const authNames = [...read('services/auth.ts').matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1]);
  const auth = load(read('services/auth.ts'), authNames, { uni: b.uni, logWarn: noop });
  const userCache = load(read('services/user-cache.ts'), ['setCachedMe', 'getCachedMe', 'clearCachedMe', 'refreshMe'], {
    uni: b.uni, ...auth, accountApi: { me: () => { throw new Error('unexpected network'); } },
    cacheUserAvatar: noop, seedCachedAvatar: noop, clearCachedAvatar: noop,
  });
  const player = { playing: false, savedPlaylists: [{ id: 'A-playlist', platform: 'wyy' }], favorites: ['A-song'] };
  const downloads = { tasks: [{ id: 'download-A' }], concurrency: 3 };
  const musicApi = { playUrlCacheCount: () => 0, lyricCacheCount: () => 0 };
  const page = load(read('pages/cache/index.uvue'), ['toggle', 'submit', 'isChecked', 'busy', 'submitText'], {
    ...b.vue, uni: b.uni, ...auth, ...userCache,
    qtConfirm: (options) => { const d = deferred(); confirmations.push({ options, ...d }); return d.promise; },
    useQtTwoColumn: () => ({ layout: { isWide: false }, twoColumn: { value: false }, colStyle: {}, colsStyle: {} }),
    qtSplitTwoColumn: (items) => [items.slice(0, 5), items.slice(5)],
    useThemeStore: () => ({ skin: {} }), usePlayerStore: () => player, useDownloadsStore: () => downloads,
    useDislikesStore: () => ({}), useLyricOffsetStore: () => ({}), useSourceStore: () => ({}),
    useListenStatsStore: () => ({ songs: [] }), audioPlayer: { cacheSize: () => 0 }, musicApi,
    sourceSwitchCacheStat: () => ({ groups: 0, songs: 0 }), ttlEntryCount: () => 0,
  });
  auth.saveUserId('A');
  auth.saveTokens({ accessToken: 'A-access', refreshToken: 'A-refresh', expiresAt: Date.now() + 3600000 });
  // Match the recursive UTSJSONObject conversion performed by the real HTTP boundary.
  userCache.setCachedMe(new UTSJSONObject({ user: new UTSJSONObject({ id: 'A', nickname: 'Alice' }) }));
  const preserved = {
    'qt-like-account': 'A', 'qt-like-pending-ops:A': '[{"kind":"favorite","id":"A-song"}]',
    'qt-download-tasks': '[{"id":"download-A"}]', 'qt-ui-font-scale': 'large',
    'qt-source-auth-accounts': '{"wyy":{"cookie":"source-account-A"}}',
  };
  for (const [key, value] of Object.entries(preserved)) b.storage.set(key, value);
  for (const id of ['audio', 'playUrl', 'source', 'ttl', 'lyric']) page.toggle(id);
  page.toggle('account');
  return { ...b, auth, userCache, page, confirmations, preserved, player, downloads };
}

const b = fixture();
const epoch = b.auth.getSessionEpoch();
b.page.submit();
assert.equal(b.confirmations.length, 1);
b.confirmations[0].resolve(true); await drain();
assert.equal(b.auth.getSessionEpoch(), epoch + 1, 'only-account clear must invalidate the actual auth session');
assert.equal(b.auth.getUserId(), 'A', 'collection ownership UID must survive sign-out');
assert.equal(b.auth.getAccessToken(), ''); assert.equal(b.auth.getRefreshToken(), '');
for (const [key, value] of Object.entries(b.preserved)) assert.equal(b.storage.get(key), value, `unselected ${key} must survive`);
assert.equal(b.player.savedPlaylists[0].id, 'A-playlist'); assert.equal(b.player.favorites[0], 'A-song');
assert.equal(b.downloads.tasks[0].id, 'download-A'); assert.equal(b.downloads.concurrency, 3);
assert.equal(b.storage.has('qt-user-me:A'), false, 'clear the departing owner profile cache without losing UID');
assert.equal(b.toasts.at(-1).title, '已清除所选内容');
console.log('  ✓ CACHE-01: only login state clears tokens/session and retains collection ownership and unselected data');
{
  const b = fixture(), epoch = b.auth.getSessionEpoch(); const snapshot = [...b.storage.entries()];
  b.page.submit(); b.confirmations[0].resolve(false); await drain();
  assert.equal(b.auth.getSessionEpoch(), epoch); assert.equal(b.auth.getAccessToken(), 'A-access');
  assert.deepEqual([...b.storage.entries()], snapshot); assert.equal(b.page.busy.value, false);
  console.log('  ✓ CACHE-02: canceling the destructive confirmation keeps session and all data');
}
{
  const b = fixture(); b.page.toggle('account'); b.page.submit();
  assert.equal(b.page.submitText.value, '请选择要清除的内容'); assert.equal(b.confirmations.length, 0);
  assert.equal(b.auth.getAccessToken(), 'A-access');
  console.log('  ✓ CACHE-03: no selected item cannot submit or sign out');
}
{
  const b = fixture(), oldSession = b.auth.captureAuthSession(); b.page.submit();
  b.confirmations[0].resolve(true); await drain();
  assert.equal(b.auth.renewTokensIfCurrent(oldSession, {
    accessToken: 'late-A-access', refreshToken: 'late-A-refresh', expiresAt: Date.now() + 3600000,
  }), false);
  assert.equal(b.auth.getAccessToken(), ''); assert.equal(b.auth.getUserId(), 'A');
  console.log('  ✓ CACHE-04: a pre-clear renewal cannot revive the signed-out session');
}
{
  const b = fixture(), epoch = b.auth.getSessionEpoch(); b.page.submit(); b.page.submit();
  assert.equal(b.confirmations.length, 2);
  b.confirmations[0].resolve(true); b.confirmations[1].resolve(true); await drain();
  assert.equal(b.auth.getSessionEpoch(), epoch + 1); assert.equal(b.timeouts.size, 1);
  assert.equal(b.toasts.length, 1);
  console.log('  ✓ CACHE-05: duplicate confirmations do not repeat clearing or navigation');
}
{
  const b = fixture(); b.page.submit(); b.confirmations[0].resolve(true); await drain();
  assert.equal(b.timeouts.size, 1);
  for (const unmounted of b.hooks.unmounted) unmounted();
  assert.equal(b.timeouts.size, 0); assert.equal(b.routes.length, 0);
  console.log('  ✓ CACHE-06: departing the cleared page cancels its delayed navigation');
}
console.log('Cache account isolation: 6 passed (actual page/auth/user-cache; synthetic host and unrelated counters).');
