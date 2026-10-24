// 在隔离的 uni/UTS/文件桥环境执行真实 store，覆盖权限恢复与重装合并。
// node tools/check-listen-stats.mjs（Node >= 22.13）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const storeSource = readFileSync(new URL('../stores/listen-stats.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(storeSource.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
class Utso {
  constructor(data = {}) { this.data = data; }
  get(key) { return this.data[key] ?? null; }
  set(key, value) { this.data[key] = value; }
  toJSON() { return this.data; }
  static keys(obj) { return Object.keys(obj.data); }
}
function wrap(value) {
  if (Array.isArray(value)) return value.map(wrap);
  if (value && typeof value === 'object') return new Utso(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wrap(v)])));
  return value;
}
const song = { id: '1', platform: 'wyy', name: '测试歌曲', singer: '测试歌手', album: '', picUrl: '', url: 'temporary-url' };
const key = 'wyy:1';
function environment() {
  const env = { permission: false, readFail: false, file: '', private: new Map(), writes: 0, activeWrites: 0, maxWrites: 0, fail: false, gate: null, artistCalls: [] };
  env.boot = () => {
    const timers = new Map();
    let timerId = 0;
    const context = vm.createContext({
      reactive: (value) => value, UTSJSONObject: Utso,
      parseJsonToUtso: (text) => wrap(JSON.parse(text)),
      canWriteListenStats: () => env.permission,
      listenStatsPath: () => '/Download/QtMusic/listen-stats.json',
      // 备份桥：本用例不覆盖体积触发备份（由 check-listen-archive.mjs 负责），
      // 这里只提供能跑通的空实现：无备份权限、读回空串、写入成功但不落盘。
      canUseListenStatsArchive: () => false,
      readListenStatsArchive: async () => ({ ok: true, text: '', missing: true }),
      writeListenStatsArchive: async () => true,
      removeListenStatsArchive: async () => true,
      readListenStatsArchiveIndex: async () => ({ ok: true, text: '', missing: true }),
      writeListenStatsArchiveIndex: async () => true,
      removeListenStatsArchiveIndex: async () => true,
      readListenStatsFile: async () => env.readFail ? { ok: false, text: '', missing: false } : env.permission ? { ok: true, text: env.file, missing: false } : { ok: false, text: '', missing: false },
      writeListenStatsFile: async (text) => {
        env.activeWrites++; env.maxWrites = Math.max(env.maxWrites, env.activeWrites);
        try {
          if (env.gate) await env.gate;
          if (!env.permission || env.fail) return false;
          env.file = text; env.writes++; return true;
        } finally { env.activeWrites--; }
      },
      uni: { getStorageSync: (k) => env.private.get(k) ?? '', setStorageSync: (k, v) => env.private.set(k, v), removeStorageSync: (k) => env.private.delete(k) },
      musicApi: {
        artistSongs: async (_name, platform) => {
          env.artistCalls.push(platform);
          if (platform === 'wyy') throw Error('offline');
          return { picUrl: 'https://example.com/artist.png' };
        },
        searchArtists: async () => [],
      },
      setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
      clearTimeout: (id) => timers.delete(id),
    });
    return vm.runInContext(code + '\nuseListenStatsStore();', context);
  };
  return env;
}
function snapshot(count, seconds, updatedAt = 1) {
  return JSON.stringify({ version: 1, updatedAt, resetAt: 0, songs: [JSON.stringify({ song, count, seconds })], avatars: {} });
}
function first(env) { return JSON.parse(JSON.parse(env.file).songs[0]); }
let passed = 0;
function check(label, fn) { fn(); passed++; console.log('  ✓ ' + label); }

// 同一份旧公共存档 + 重装后尚未授权的新播放，跨重启后再授权。
const e = environment();
e.file = snapshot(10, 120);
let store = e.boot();
await store.load([], new Map());
await store.recordPlay(song);
await store.addSeconds(song, 8.5);
await store.addSeconds(song, NaN);
await store.addSeconds(song, -4);
await store.addSeconds(song, 100);
await store.flush();
check('未授权时持久化实际秒数与待合并增量', () => {
  assert.equal(store.totalSeconds, 8.5);
  const fallback = JSON.parse([...e.private.values()][0]);
  assert.equal(fallback.pendingCounts[key], 1);
  assert.equal(fallback.pendingSeconds[key], 8.5);
});
store = e.boot();
await store.load();
await store.recordPlay(song);
await store.addSeconds(song, 6.5);
await store.flush();
e.permission = true;
await store.flush();
check('授权前跨重启的记录合并至旧存档', () => {
  assert.equal(first(e).count, 12);
  assert.equal(first(e).seconds, 135);
  assert.equal(e.private.size, 0);
  assert.equal(first(e).song.url, undefined);
});
await store.flush();
await store.flush();
check('重复保存不会重复累计', () => assert.equal(first(e).count, 12));
store = e.boot();
await store.load();
check('模拟重装：仅公共文件即可恢复报告', () => {
  assert.equal(store.songs[0].count, 12);
  assert.equal(store.totalSeconds, 135);
});

// 在设置授予权限后冷启动：load 本身也必须合并待处理增量。
const cold = environment();
cold.file = snapshot(10, 120);
let coldStore = cold.boot();
await coldStore.recordPlay(song);
await coldStore.addSeconds(song, 5);
await coldStore.flush();
cold.permission = true;
coldStore = cold.boot();
await coldStore.load();
await coldStore.flush();
check('先授权再冷启动同样恢复旧记录和新增量', () => {
  assert.equal(first(cold).count, 11);
  assert.equal(first(cold).seconds, 125);
});

const legacy = environment();
const legacyStore = legacy.boot();
await legacyStore.load([song], new Map([[key, 4]]));
await legacyStore.flush();
await legacyStore.load([song], new Map([[key, 4]]));
check('旧次数迁移只执行一次，不伪造历史时长', () => {
  assert.equal(legacyStore.songs[0].count, 4);
  assert.equal(legacyStore.totalSeconds, 0);
});
await legacyStore.ensureArtistPic(song);
await legacyStore.ensureArtistPic({ ...song, platform: 'qq' });
await legacyStore.ensureArtistPic({ ...song, platform: 'kg' });
check('失败可换音源补头像，成功地址会本地保留并复用', () => {
  assert.equal(legacyStore.artistPic(song.singer), 'https://example.com/artist.png');
  assert.equal(legacy.artistCalls.join(','), 'wyy,qq');
});
await legacyStore.flush();
const legacyReloaded = legacy.boot();
await legacyReloaded.load();
check('头像地址跨启动恢复', () => assert.equal(legacyReloaded.artistPic(song.singer), 'https://example.com/artist.png'));

const clearing = environment();
clearing.file = snapshot(10, 120);
let clearStore = clearing.boot();
await clearStore.load();
await clearStore.clear();
clearStore = clearing.boot();
await clearStore.load();
clearing.permission = true;
await clearStore.flush();
check('无权限时清空后授权，不复活旧统计', () => assert.equal(JSON.parse(clearing.file).songs.length, 0));

const concurrent = environment();
concurrent.permission = true;
concurrent.file = snapshot(1, 2);
const serial = concurrent.boot();
await serial.load();
let release;
concurrent.gate = new Promise((resolve) => { release = resolve; });
const saving = serial.flush();
while (!concurrent.activeWrites) await Promise.resolve();
await serial.recordPlay(song);
await serial.addSeconds(song, 3);
const savingAgain = serial.flush();
release();
await Promise.all([saving, savingAgain]);
check('写盘串行，写盘中的新增播放不会丢失', () => {
  assert.equal(concurrent.maxWrites, 1);
  assert.equal(first(concurrent).count, 2);
  assert.equal(first(concurrent).seconds, 5);
});
concurrent.fail = true;
await serial.recordPlay(song);
await serial.flush();
check('公共写盘失败保留私有兜底，恢复后迁出', () => assert.equal(concurrent.private.size, 1));
concurrent.fail = false;
await serial.flush();
check('恢复写盘不重复累计', () => { assert.equal(first(concurrent).count, 3); assert.equal(concurrent.private.size, 0); });

// 执行真实收听会话状态机，覆盖墙钟累计、暂停/拖动、失败重试和循环。
const sessionSource = readFileSync(new URL('../services/listen-session.ts', import.meta.url), 'utf8');
const sessionCode = stripTypeScriptTypes(sessionSource.replace(/^export /gm, ''));
const ListenSession = vm.runInNewContext(sessionCode + '\nListenSession;');
check('慢速播放按墙钟累计而不是按音频位置累计', () => {
  const session = new ListenSession();
  session.start(key);
  assert.equal(session.sample(key, 0, 120, true, 0, 0.5, 1000), null);
  const one = session.sample(key, 0.5, 120, true, 1000, 0.5, 2000);
  assert.equal(one.seconds, 1);
  const two = session.sample(key, 1, 120, true, 2000, 0.5, 3000);
  assert.equal(two.seconds, 1);
});
check('暂停、缓冲和拖动不累计，恢复后重新建立采样基准', () => {
  const session = new ListenSession(); session.start(key);
  session.sample(key, 0, 120, true, 0, 1, 1000);
  session.sample(key, 1, 120, true, 1000, 1, 2000);
  assert.equal(session.sample(key, 1, 120, false, 2000, 1, 3000), null);
  assert.equal(session.sample(key, 30, 120, true, 3000, 1, 4000), null);
  const resumed = session.sample(key, 31, 120, true, 4000, 1, 5000);
  assert.equal(resumed.seconds, 1);
});
check('地址重试不会重置已累计会话', () => {
  const session = new ListenSession(); session.start(key);
  session.sample(key, 0, 60, true, 0, 1, 1000);
  session.sample(key, 1, 60, true, 1000, 1, 2000);
  session.resetSample();
  assert.equal(session.sample(key, 1, 60, true, 3000, 1, 4000), null);
  const afterRetry = session.sample(key, 2, 60, true, 4000, 1, 5000);
  assert.equal(afterRetry.seconds, 1);
});
check('自然结束只计一次完播，单曲循环开启新会话', () => {
  const session = new ListenSession(); session.start(key);
  session.sample(key, 0, 0, true, 0, 1, 1000);
  session.sample(key, 1, 0, true, 1000, 1, 2000);
  const ended = session.end(3000);
  assert.equal(ended.completed, 1); assert.equal(ended.plays, 1);
  assert.equal(session.end(4000), null);
  session.start(key);
  session.sample(key, 0, 0, true, 5000, 1, 6000);
  const loop = session.sample(key, 1, 0, true, 6000, 1, 7000);
  assert.equal(loop.seconds, 1);
});
// 执行真实报告聚合函数，保证 Top 5、完整排行和明细采用同一统计口径。
const reportSource = readFileSync(new URL('../services/listen-report.ts', import.meta.url), 'utf8');
const reportCode = stripTypeScriptTypes(reportSource.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
const report = vm.runInNewContext(reportCode + '\n({ reportEntries, reportTracks, reportDuration });');
const records = [
  { song, count: 6, seconds: 25 },
  { song: { ...song, platform: 'qq' }, count: 2, seconds: 200 },
  { song: { ...song, id: '2', singer: '另一歌手' }, count: 3, seconds: 80 },
  { song: { ...song, id: '3', singer: '' }, count: 0, seconds: 0 },
];
check('歌曲排行保留跨音源身份且次数与时长可独立排序', () => {
  assert.equal(report.reportEntries(records, 'songs', 'count')[0].id, 'wyy:1');
  assert.equal(report.reportEntries(records, 'songs', 'seconds')[0].id, 'qq:1');
  assert.equal(report.reportEntries(records, 'songs', 'count').length, 3);
});
check('歌手明细跨音源汇总次数、实际时长和歌曲数', () => {
  const first = report.reportEntries(records, 'artists', 'count')[0];
  assert.equal(first.count, 8); assert.equal(first.seconds, 225); assert.equal(first.tracks, 2);
  assert.equal(report.reportTracks(records, 'artists', song.singer).length, 2);
});
check('音源明细只包含对应平台的歌曲', () => {
  const first = report.reportEntries(records, 'sources', 'count')[0];
  assert.equal(first.id, 'wyy'); assert.equal(first.count, 9); assert.equal(first.seconds, 105);
  assert.equal(report.reportTracks(records, 'sources', 'qq').length, 1);
  assert.equal(report.reportTracks(records, 'songs', 'qq:1')[0].song.platform, 'qq');
});
check('排行和筛选不会重排或修改原始存档', () => {
  const before = JSON.stringify(records);
  report.reportEntries(records, 'songs', 'seconds'); report.reportTracks(records, 'artists', song.singer);
  assert.equal(JSON.stringify(records), before);
});
check('实际时长格式覆盖零值、分钟与小时边界', () => {
  assert.equal(report.reportDuration(0), '0秒');
  assert.equal(report.reportDuration(65.9), '1分5秒');
  assert.equal(report.reportDuration(3665), '1小时1分');
});
// 执行真实本地合辑规则，覆盖日期门槛、次数门槛、收藏交集和固定顺序。
const mixSource = readFileSync(new URL('../services/local-mixes.ts', import.meta.url), 'utf8');
const mixCode = stripTypeScriptTypes(mixSource.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
const mixApi = vm.runInNewContext(mixCode + '\n({ buildLocalMixes, shouldShowLocalMixes, MIN_SHOWN_LOCAL_MIXES });');
const mixNow = Date.now();
const nightDate = new Date(mixNow); nightDate.setHours(23, 0, 0, 0);
if (nightDate.getTime() > mixNow) nightDate.setTime(nightDate.getTime() - 24 * 60 * 60 * 1000);
const mixRows = [];
const mixLiked = [];
for (let i = 0; i < 5; i++) {
  const mixSong = { id: 'recent-' + i, platform: 'wyy', name: '最近歌' + i, singer: '歌手', album: '', picUrl: '', pids: ['fav'] };
  mixRows.push({ song: mixSong, count: 2, effectiveCount: 2, legacyCount: 0, seconds: 40, completed: 0, firstPlayedAt: mixNow - i * 1000, lastPlayedAt: nightDate.getTime() + i * 1000 });
  mixLiked.push(mixSong);
}
for (let i = 0; i < 5; i++) {
  const mixSong = { id: 'old-' + i, platform: 'qq', name: '旧歌' + i, singer: '歌手', album: '', picUrl: '', pids: ['fav'] };
  mixRows.push({ song: mixSong, count: 3, effectiveCount: 3, legacyCount: 0, seconds: 40, completed: 1, firstPlayedAt: mixNow - 31 * 24 * 60 * 60 * 1000, lastPlayedAt: mixNow - 31 * 24 * 60 * 60 * 1000 - i * 1000 });
  mixLiked.push(mixSong);
}
const mixes = mixApi.buildLocalMixes(mixRows, mixLiked, ['fav'], mixNow);
check('为你整理按固定顺序生成五类本地合辑，并忽略无日期旧记录', () => {
  assert.equal(JSON.stringify(mixes.map((mix) => mix.key)), JSON.stringify(['recent', 'most_played', 'favorite_picks', 'late_night', 'nostalgic']));
  assert.ok(mixes.every((mix) => mix.songs.length >= 5 && mix.songs.length <= 20));
});
check('收藏合辑只接受仍属于现存歌单的收藏', () => {
  const stale = mixApi.buildLocalMixes(mixRows, mixLiked, [], mixNow);
  assert.equal(stale.some((mix) => mix.key == 'favorite_picks'), false);
});
check('为你整理凑够两类就展示，一类不出场，统计未就绪也不出场', () => {
  assert.equal(mixApi.MIN_SHOWN_LOCAL_MIXES, 2);
  const full = mixApi.buildLocalMixes(mixRows, mixLiked, ['fav'], mixNow);
  assert.equal(mixApi.shouldShowLocalMixes(true, full), true);
  assert.equal(mixApi.shouldShowLocalMixes(true, full.slice(0, 2)), true);
  assert.equal(mixApi.shouldShowLocalMixes(true, full.slice(0, 1)), false);
  assert.equal(mixApi.shouldShowLocalMixes(true, []), false);
  assert.equal(mixApi.shouldShowLocalMixes(false, full), false);
});
check('只有最近在听一类时整区仍不出场（单类不算数）', () => {
  // 三天前的下午 14:00、每首只听 1 次：只够得上「最近在听」，
  // 次数不够 2 次、不是深夜、没到 30 天、也不在收藏里。
  const noonDate = new Date(mixNow); noonDate.setDate(noonDate.getDate() - 3); noonDate.setHours(14, 0, 0, 0);
  const singleRows = [];
  for (let i = 0; i < 5; i++) {
    const song = { id: 'single-' + i, platform: 'wyy', name: '单曲' + i, singer: '歌手', album: '', picUrl: '', pids: [] };
    singleRows.push({ song, count: 1, effectiveCount: 1, legacyCount: 0, seconds: 40, completed: 0, firstPlayedAt: noonDate.getTime(), lastPlayedAt: noonDate.getTime() + i * 1000 });
  }
  const single = mixApi.buildLocalMixes(singleRows, [], [], mixNow);
  assert.equal(single.map((mix) => mix.key).join(','), 'recent');
  assert.equal(mixApi.shouldShowLocalMixes(true, single), false);
});
// 执行真实文件桥，覆盖旧基座无新增导出与新基座公共目录能力。
const bridgeSource = readFileSync(new URL('../services/listen-stats-file.uts', import.meta.url), 'utf8');
function fileBridge(engine, android = true) {
  const calls = [];
  const source = bridgeSource.replace(/^[ \t]*\/\/ #if(n?)def APP-ANDROID\r?\n([\s\S]*?)^[ \t]*\/\/ #endif/gm,
    (_match, negative, body) => (negative ? !android : android) ? body : '');
  const bridgeCode = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
  const bridge = vm.runInNewContext(bridgeCode + '\n({ listenStatsPath, readListenStatsFile, writeListenStatsFile });', {
    QtJsEngine: Object.freeze(engine),
    queryPermissionStates: () => [{ applicable: true, unknown: false, granted: true }],
    readTextFile: (path, callback) => { calls.push(['read', path]); callback(true, 'saved', ''); },
    writeTextFile: (path, text, callback) => { calls.push(['write', path, text]); callback(true, '', ''); },
    renamePath: (from, to, callback) => { calls.push(['rename', from, to]); callback(true, '', ''); },
  });
  return { ...bridge, calls };
}
const oldBridge = fileBridge({});
const oldRead = await oldBridge.readListenStatsFile();
const oldWrite = await oldBridge.writeListenStatsFile('new');
check('旧基座缺少公共目录接口时不抛错、不读写公共文件', () => {
  assert.equal(oldBridge.listenStatsPath(), ''); assert.equal(oldRead.ok, false); assert.equal(oldRead.text, ''); assert.equal(oldWrite, false);
  assert.equal(oldBridge.calls.length, 0);
});
const newBridge = fileBridge({ publicDataDir: () => '/storage/emulated/10/Download/QtMusic' });
const newRead = await newBridge.readListenStatsFile();
const newWrite = await newBridge.writeListenStatsFile('new');
check('新基座使用系统返回的目录并先写临时文件再替换', () => {
  const path = '/storage/emulated/10/Download/QtMusic/listen-stats.json';
  assert.equal(newBridge.listenStatsPath(), path); assert.equal(newRead.ok, true); assert.equal(newRead.text, 'saved'); assert.equal(newWrite, true);
  assert.deepEqual(newBridge.calls, [['read', path], ['write', path + '.tmp', 'new'], ['rename', path + '.tmp', path]]);
});
check('公共目录接口异常或非 Android 平台安全降级', () => {
  assert.equal(fileBridge({ publicDataDir: () => { throw Error('unavailable'); } }).listenStatsPath(), '');
  assert.equal(fileBridge({ publicDataDir: () => '/Download/QtMusic' }, false).listenStatsPath(), '');
});
console.log(`[listen-stats] ${passed} 条回归用例通过`);
