// 隔离执行缓存页的真实清理分支，验证选项边界和下载数据保留。
// node --disable-warning=ExperimentalWarning tools/check-cleanup.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const page = readFileSync(new URL('pages/cache/index.uvue', root), 'utf8');
const script = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const code = stripTypeScriptTypes(script.replace(/^import[\s\S]*?;\r?\n/gm, ''));
const playerSource = readFileSync(new URL('stores/player.ts', root), 'utf8');
const resetMethod = playerSource.match(/  async resetLocalData\(\): Promise<void> \{[\s\S]*?\n  \}/)[0];
function setup() {
  const saved = new Map([
    ['qt-downloads', 'saved music'], ['qt-download-tasks', 'queued jobs'],
    ['qt-download-dir', '/custom/music'], ['qt-download-quality', 'flac'],
    ['qt-access-token', 'test-token'], ['qt-refresh-token', 'test-refresh'],
    ['qt-user-id', 'test-user'], ['qt-roles', '["test"]'],
    ['qt-user-me', 'cached profile'], ['qt-search-history', 'queries'],
    ['qt-local-audio-v1', 'scanned songs'], ['qt-default-fav-playlist', 'favorite'],
    ['qt-ui-theme-v2', 'custom theme'], ['qt-desktop-lyric-font', '28'],
    ['qt-listen-stats-fallback', 'old stats'], ['unrelated', 'keep'],
  ]);
  const calls = [];
  let statsGate = Promise.resolve();
  const stats = { clear: async () => { await statsGate; saved.set('qt-listen-stats-fallback', 'empty'); } };
  const playerContext = vm.createContext({ useListenStatsStore: () => stats });
  const resetClass = stripTypeScriptTypes('class Player {\n' + resetMethod + '\n}\nPlayer;');
  const Player = vm.runInContext(resetClass, playerContext);
  const player = Object.assign(new Player(), {
    playing: false, mode: 'single', quality: 'flac', defaultFavPlaylistId: 'favorite',
    likedSongs: ['like'], history: ['song'], savedPlaylists: ['saved'], localPlaylists: ['local'],
    stop() { this.current = null; this.queue = []; this.playing = false; },
    persist() { calls.push('persist'); saved.set('player', JSON.stringify(this)); },
    syncRepeatMode() { calls.push('repeat'); },
    setQuality(q) { this.quality = q; this.persist(); },
    setSleep(minutes) { calls.push('sleep:' + minutes); },
  });
  const downloads = { concurrency: 8, downloadQuality: 'flac', customDir: '/custom/music' };
  const theme = { skin: { surface: '', border: '', divider: '', danger: '' },
    resetAll: () => calls.push('theme:reset') };
  const desktopLyric = new Proxy({}, { get: (_, name) => (...args) => {
    calls.push(String(name));
    if (String(name).startsWith('get') || String(name).startsWith('is')) return 0;
  } });
  const audioPlayer = {
    clearAudioCache: () => true, cacheSize: () => 0, setConcurrentMode() {}, setMuted() {}, setVolume() {}, changeRate() {},
    setEqualizerEnabled() {}, setEqualizerBands() {}, setCacheLimitMb() {}, getCacheLimitMb: () => 2048,
  };
  const context = vm.createContext({
    ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }),
    onShow() {}, onUnmounted() {}, useQtLayout: () => ({ isWide: false }),
    // 缓存页宽屏两列排版用的 composable，脚本执行路径与本用例无关，给个固定单列桩即可
    useQtTwoColumn: () => ({ layout: { isWide: false }, twoColumn: { value: false }, colStyle: { value: '' }, colsStyle: { value: '' } }),
    // 缓存页把监听统计计数的实时展示与「仅清统计」分支读自这个 store
    useListenStatsStore: () => ({ songs: [], clearOnly: async () => calls.push('stats:clearOnly') }),
    qtSplitTwoColumn: items => [items.slice(0, Math.ceil(items.length / 2)), items.slice(Math.ceil(items.length / 2))],
    useThemeStore: () => theme, usePlayerStore: () => player, useDownloadsStore: () => downloads,
    useDislikesStore: () => ({ reset: () => calls.push('dislikes') }),
    useLyricOffsetStore: () => ({ reset: () => calls.push('offsets') }),
    useSourceStore: () => ({ setSource: source => saved.set('qt-source', source) }),
    useFontScaleStore: () => ({ setTier: tier => calls.push('font:' + tier) }),
    usePlayerBarStore: () => ({ reset: () => calls.push('bar') }),
    clearCachedMe: () => saved.delete('qt-user-me'), desktopLyric, audioPlayer,
    DOWNLOAD_CONCURRENCY_DEFAULT: 3, isHarmonyOs: () => false,
    musicApi: { clearPlayUrlCache() {}, clearLyricCache() {}, resetLyricPicks: () => calls.push('picks'), playUrlCacheCount: () => 0, lyricCacheCount: () => 0 },
    clearSourceSwitchCache() {}, sourceSwitchCacheStat: () => ({ groups: 0, songs: 0 }),
    // 缓存页 ttl 清理项：import { ttlClearAll as clearTtlCache, ttlCount as ttlEntryCount }
    clearTtlCache: () => calls.push('ttl:clear'), ttlEntryCount: () => 0,
    formatFileSize: String, setTimeout: () => 1, clearTimeout() {}, qtShowToast: o => calls.push('toast:' + String(o.title)),
    uni: {
      removeStorageSync: key => saved.delete(key), getStorageInfoSync: () => ({ keys: [...saved.keys()] }),
      showToast() {}, reLaunch() {},
    },
  });
  const api = vm.runInContext(code + '\n({clearItem,clearSelected,checked,busy});', context);
  return { saved, calls, player, downloads, audioPlayer, api, setStatsGate: gate => { statsGate = gate; } };
}
function retainedDownloads(e) {
  assert.equal(e.saved.get('qt-downloads'), 'saved music');
  assert.equal(e.saved.get('qt-download-tasks'), 'queued jobs');
  assert.equal(e.saved.get('unrelated'), 'keep');
}
const settings = setup();
assert.deepEqual(Array.from(settings.api.checked.value), ['audio', 'playUrl', 'source', 'ttl', 'lyric']);
await settings.api.clearItem('settings');
retainedDownloads(settings);
assert.equal(settings.saved.get('qt-access-token'), 'test-token');
assert.equal(settings.saved.get('qt-search-history'), 'queries');
assert.equal(settings.saved.has('qt-download-dir'), false);
assert.equal(settings.downloads.customDir, '');
assert.equal(settings.downloads.downloadQuality, '320');
assert.equal(settings.player.quality, '320');
assert.equal(JSON.parse(settings.saved.get('player')).mode, 'sequence');
assert.ok(settings.calls.includes('setFontSp') && settings.calls.includes('setBackgroundMode'));
console.log('✓ 设置恢复即时更新播放器及原生歌词，同时保留下载、账号和音乐数据');

const local = setup();
let release;
local.setStatsGate(new Promise(resolve => { release = resolve; }));
let settled = false;
const pending = local.api.clearItem('localData').then(() => { settled = true; });
await Promise.resolve();
assert.equal(settled, false);
release();
await pending;
retainedDownloads(local);
assert.equal(local.saved.get('qt-access-token'), 'test-token');
assert.equal(local.saved.get('qt-download-dir'), '/custom/music');
assert.equal(local.saved.get('qt-ui-theme-v2'), 'custom theme');
assert.equal(local.saved.has('qt-search-history'), false);
assert.equal(local.saved.has('qt-local-audio-v1'), false);
assert.equal(local.player.history.length, 0);
assert.equal(local.player.localPlaylists.length, 0);
assert.equal(local.player.defaultFavPlaylistId, '');
assert.equal(local.player.quality, 'flac');
assert.equal(local.saved.get('qt-listen-stats-fallback'), 'empty');
assert.ok(local.calls.includes('picks'));
console.log('✓ 本地音乐清理等待统计保存，保留设置与账号');

const account = setup();
await account.api.clearItem('account');
retainedDownloads(account);
assert.equal(account.saved.has('qt-access-token'), false);
assert.equal(account.saved.has('qt-refresh-token'), false);
assert.equal(account.saved.has('qt-user-me'), false);
assert.equal(account.saved.get('qt-search-history'), 'queries');
assert.equal(account.saved.get('qt-download-dir'), '/custom/music');
console.log('✓ 仅勾选登录状态时不清理音乐数据和设置');

const partial = setup();
partial.audioPlayer.clearAudioCache = () => { throw new Error('busy'); };
await partial.api.clearSelected(['audio', 'settings']);
assert.equal(partial.player.quality, '320');
assert.equal(partial.api.busy.value, false);
retainedDownloads(partial);
console.log('✓ 单项失败后继续清理其余选项，并恢复按钮状态');

const all = setup();
await all.api.clearSelected(['audio', 'playUrl', 'source', 'lyric', 'localData', 'settings', 'account']);
retainedDownloads(all);
assert.equal(all.saved.has('qt-access-token'), false);
assert.equal(all.saved.has('qt-search-history'), false);
assert.equal(all.downloads.customDir, '');
console.log('✓ 全选清理仍保留下载歌曲记录和未完成下载任务');
