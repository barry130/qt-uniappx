// 批次⑥最小单测面：services/like-sync.ts 收藏同步引擎的确定性核心回归。
// VM 沙箱跑真实类（stripTypeScriptTypes 去类型），垫 like/auth/logger/uni 存储桥。
// 覆盖：load/save 游标与积压队列往返 + 损坏条目跳过、payload 字段口径、
//       flushPendingOps 批量上送（200 分批/整批原子/失败保序/无效丢弃/seq 回写）、
//       ensurePlaylistPid 兜底生成、resetLikeSync / clearLocalLikeData。
// 范围说明：pullChanges 的多端 LWW 合并依赖完整 host 方法面，留作后续深化，
// 本脚本先锁住纯机器状态与推送管线（从 player.ts 抽出时的最高回归风险面）。
// node tools/check-like-sync.mjs（Node >= 22.13）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../services/like-sync.ts', import.meta.url), 'utf8');
const pidSource = readFileSync(new URL('../services/global-pid.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
const pidCode = stripTypeScriptTypes(pidSource.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));class Utso {
  constructor(data = {}) { this.data = data; }
  get(key) { return this.data[key] ?? null; }
  set(key, value) { this.data[key] = value; }
  toJSON() { return this.data; }
}
function wrap(value) {
  if (Array.isArray(value)) return value.map(wrap);
  if (value && typeof value === 'object') return new Utso(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wrap(v)])));
  return value;
}

function boot(env) {
  env.storage = new Map();
  env.batches = [];
  env.changes = [];
  env.logs = [];
  env.sessionEpoch = env.sessionEpoch ?? 0;
  env.userId = env.userId ?? '';
  env.host = {
    likedSongs: [], savedPlaylists: [], localPlaylists: [],
    likedDirty: false, playlistsDirty: false, localPlaylistsDirty: false,
    persistCount: 0, saveLocalCount: 0,
    findCollectedSongInList(list, id, platform) {
      return list.findIndex((song) => song.id === id && song.platform === platform);
    },
    findCollectedSongById(id, platform) {
      return env.host.likedSongs.findIndex((song) => song.id === id && song.platform === platform);
    },
    isLocallyOwnedPlaylist(pid) {
      return env.host.localPlaylists.some((playlist) => playlist.pid === pid || playlist.id === pid);
    },
    addPidToSong(song, pid) {
      song.pids = song.pids ?? [];
      if (!song.pids.includes(pid)) song.pids.push(pid);
    },
    removeSongsOfPlaylistLocal() {},
    persistNow() { env.host.persistCount++; },
    saveLocalPlaylistsNow() { env.host.saveLocalCount++; },
  };
  const ctx = vm.createContext({
    UTSJSONObject: Utso,
    parseJsonToUtso: (text) => wrap(JSON.parse(text)),
    getAccessToken: () => env.token,
    getUserId: () => env.userId,
    getSessionEpoch: () => env.sessionEpoch,
    sessionIsCurrent: (epoch) => env.sessionEpoch === epoch,
    logMsg: (...args) => { env.logs.push(args); },
    likeBatch: async (bodies) => {
      if (env.likeBatchImpl) return env.likeBatchImpl(bodies);
      if (env.failBatch) throw Error('network down');
      env.batches.push(bodies);
      return env.nextSeq;
    },
    fetchChanges: async (since) => {
      if (env.fetchChangesImpl) return env.fetchChangesImpl(since);
      env.changes.push('fetchChanges');
      return { maxSeq: 0, changes: [] };
    },
    fetchAllLikes: async (page) => {
      if (env.fetchAllLikesImpl) return env.fetchAllLikesImpl(page);
      env.changes.push('fetchAllLikes');
      return { songs: [], playlists: [], maxSeq: 0 };
    },
    uni: {
      getStorageSync: (k) => env.storage.get(k) ?? '',
      setStorageSync: (k, v) => env.storage.set(k, v),
      removeStorageSync: (k) => env.storage.delete(k),
    },
  });
  vm.runInContext(pidCode, ctx); // 装载真实的 generateGlobalPid（like-sync 的运行依赖）
  vm.runInContext(code, ctx);
  env.ctx = ctx;
  const { LikeSyncEngine } = vm.runInContext('({ LikeSyncEngine })', ctx);
  env.LikeSyncEngine = LikeSyncEngine;
  env.engine = new LikeSyncEngine(env.host);
  return env;
}

const songPayload = { sid: 's1', platform: 'wyy', name: '测试歌', singer: '歌手', album: '专辑' };
const songJson = JSON.stringify(songPayload);
function tick() { return new Promise((r) => setTimeout(r, 0)); }
function norm(v) { return JSON.parse(JSON.stringify(v)); }
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function remoteChange(id, seq) {
  return {
    type: 'song', id, platform: 'test', name: id, singer: '', album: '',
    hash: '', picUrl: '', deleted: false, updatedSeq: seq, pid: '',
  };
}

let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log('  ✓ ' + label); }

await check('load/save：游标与积压队列落盘往返', async () => {
  const env = boot({ token: null, nextSeq: 1 });
  env.storage.set('qt-like-cursor', '123.5');
  env.storage.set('qt-like-pending-ops', JSON.stringify([
    JSON.stringify({ type: 'song', action: 'add', dataJson: songJson }),
    'corrupt{{',                                   // 损坏条目跳过
    JSON.stringify({ type: 'album', action: 'add', dataJson: songJson }),  // 非法 type 跳过
    JSON.stringify({ type: 'song', action: 'toggle', dataJson: songJson }), // 非法 action 跳过
    JSON.stringify({ type: 'playlist', action: 'add', dataJson: JSON.stringify({ pid: 'GP-1', platform: 'local', name: '单' }) }),
  ]));
  env.engine.load();
  assert.equal(env.engine.likeCursor, 123.5);
  assert.equal(env.engine.pendingOps.length, 2);
  assert.equal(env.engine.pendingOps[0].type, 'song');
  assert.equal(env.engine.pendingOps[1].type, 'playlist');
  env.engine.save();
  assert.equal(env.storage.get('qt-like-cursor'), '123.5');
  const saved = JSON.parse(env.storage.get('qt-like-pending-ops'));
  assert.equal(saved.length, 2);
  assert.equal(JSON.parse(saved[0]).type, 'song');
});

await check('空存储 load：游标 0、队列为空', async () => {
  const env = boot({ token: null, nextSeq: 1 });
  env.engine.load();
  assert.equal(env.engine.likeCursor, 0);
  assert.deepEqual(norm(env.engine.pendingOps), []);
});

await check('AUTH-01：旧全局游标一次性迁入 UID 分区，换号不继承上一账号队列', async () => {
  const env = boot({ token: 'tok', nextSeq: 1, sessionEpoch: 0, userId: 'A' });
  env.storage.set('qt-like-cursor', '41');
  env.storage.set('qt-like-pending-ops', JSON.stringify([
    JSON.stringify({ type: 'song', action: 'add', dataJson: songJson }),
  ]));
  env.engine.load();
  assert.equal(env.storage.get('qt-like-cursor:A'), '41');
  assert.equal(env.storage.get('qt-like-account'), 'A');
  env.userId = 'B';
  const second = new env.LikeSyncEngine(env.host);
  second.load();
  assert.equal(second.likeCursor, 0);
  assert.equal(second.pendingOps.length, 0);
});

await check('AUTH-01：退出后切到 B 再回 A，A 的 scoped outbox 仍可恢复', async () => {
  const env = boot({ token: 'A', nextSeq: 1, sessionEpoch: 0, userId: 'A' });
  env.engine.load();
  env.engine.pendingOps = [{
    type: 'song',
    action: 'add',
    dataJson: JSON.stringify({ ...songPayload, sid: 'A-kept' }),
  }];
  env.engine.save();

  env.token = '';
  env.sessionEpoch = 1;
  // 登出本身不清 UID 或 scoped outbox。
  env.token = 'B';
  env.userId = 'B';
  env.sessionEpoch = 2;
  env.engine.clearLocalLikeData();
  assert.equal(env.engine.pendingOps.length, 0);

  env.engine.pendingOps = [{
    type: 'song',
    action: 'add',
    dataJson: JSON.stringify({ ...songPayload, sid: 'B-kept' }),
  }];
  env.engine.save();

  env.token = 'A';
  env.userId = 'A';
  env.sessionEpoch = 3;
  env.engine.clearLocalLikeData();
  assert.equal(env.engine.pendingOps.length, 1);
  assert.equal(JSON.parse(env.engine.pendingOps[0].dataJson).sid, 'A-kept');
  assert.equal(env.storage.get('qt-like-pending-ops:B').includes('B-kept'), true);
});

await check('likeSongPayloadJson：仅携带服务器字段，可选键缺省', async () => {
  const env = boot({ token: null, nextSeq: 1 });
  const full = JSON.parse(env.engine.likeSongPayloadJson({
    id: 's1', platform: 'wyy', name: '测试歌', singer: '歌手', album: '专辑',
    musicId: 'hash-1', picUrl: 'http://pic/1.png', pids: ['p1'],
  }, 'GP-7'));
  assert.deepEqual(norm(full), { sid: 's1', platform: 'wyy', name: '测试歌', singer: '歌手', album: '专辑', hash: 'hash-1', pid: 'GP-7', picUrl: 'http://pic/1.png' });
  const bare = JSON.parse(env.engine.likeSongPayloadJson({ id: 's2', platform: 'qq', name: 'b', singer: '', album: '' }));
  assert.deepEqual(Object.keys(bare).sort(), ['album', 'name', 'platform', 'sid', 'singer']);
  assert.equal('hash' in bare, false);
  assert.equal('pid' in bare, false);
  assert.equal('picUrl' in bare, false);
});

await check('likePlaylistPayloadJson：pid 缺失时经 ensurePlaylistPid 生成并写回 host', async () => {
  const env = boot({ token: null, nextSeq: 1 });
  const pl = { id: 'lp1', name: '我的歌单', platform: 'local', picUrl: '', pid: undefined, description: null, tracks: undefined, likeSeq: undefined };
  env.host.localPlaylists = [{ id: 'lp1', name: '我的歌单', platform: 'local', pid: null }];
  const pid = JSON.parse(env.engine.likePlaylistPayloadJson(pl)).pid;
  assert.equal(typeof pid, 'string');
  assert.ok(pid.length > 0);
  assert.notEqual(pid, 'lp1');
  assert.equal(env.host.localPlaylists[0].pid, pid);
  assert.equal(env.host.saveLocalCount, 1);
  // 平台歌单直接沿用 pid，不写回
  const fixed = JSON.parse(env.engine.likePlaylistPayloadJson({ id: 'p9', name: 'n', platform: 'wyy', picUrl: 'p', pid: 'W-9', description: null, tracks: undefined, likeSeq: undefined })).pid;
  assert.equal(fixed, 'W-9');
  assert.equal(env.host.saveLocalCount, 1);
});

await check('flushPendingOps：无 token 直返，积压不动', async () => {
  const env = boot({ token: null, nextSeq: 1 });
  env.engine.load(); // 空队列
  env.engine.pendingOps = [{ type: 'song', action: 'add', dataJson: songJson }];
  await env.engine.flushPendingOps();
  assert.equal(env.batches.length, 0);
  assert.equal(env.engine.pendingOps.length, 1);
});

await check('flushPendingOps：按序分批（450 条 → 200/200/50）、成功出队、likeSeq 回写且读游标不动', async () => {
  const env = boot({ token: 'tok', nextSeq: 3 });
  env.host.likedSongs = [{ id: 's5', platform: 'qq', name: '五', singer: '', album: '', picUrl: '', url: '', likeSeq: 0 }];
  env.engine.load();
  env.engine.pendingOps = Array.from({ length: 450 }, (_, i) => ({
    type: 'song', action: 'add',
    dataJson: JSON.stringify({ ...songPayload, sid: 's' + i, platform: 'qq' }),
  }));
  await env.engine.flushPendingOps();
  assert.equal(env.batches.length, 3);
  assert.deepEqual(env.batches.map((b) => b.length), [200, 200, 50]);
  // 批内保序
  assert.equal(JSON.parse(env.batches[0][0]).sid, 's0');
  assert.equal(JSON.parse(env.batches[1][0]).sid, 's200');
  assert.equal(JSON.parse(env.batches[2][0]).sid, 's400');
  assert.equal(env.engine.pendingOps.length, 0);
  assert.equal(env.engine.likeCursor, 0, 'write ACK is not a read checkpoint');
  const stamped = env.host.likedSongs[0];
  assert.equal(stamped.likeSeq, 3);
  assert.equal(env.host.likedDirty, true);
  assert.equal(env.storage.get('qt-like-cursor'), '0');
});

await check('flushPendingOps：推送失败整批原样留在队首保序，游标不动', async () => {
  const env = boot({ token: 'tok', nextSeq: 8, failBatch: true });
  env.engine.load();
  env.engine.pendingOps = [
    { type: 'song', action: 'add', dataJson: songJson },
    { type: 'song', action: 'remove', dataJson: songJson },
  ];
  await env.engine.flushPendingOps();
  assert.equal(env.batches.length, 0);
  assert.equal(env.engine.pendingOps.length, 2);
  assert.equal(env.engine.pendingOps[0].action, 'add');
  assert.equal(env.engine.likeCursor, 0);
  // 恢复网络后同一队列可完整重放
  env.failBatch = false;
  env.nextSeq = 9;
  await env.engine.flushPendingOps();
  assert.equal(env.batches.length, 1);
  assert.equal(env.batches[0].length, 2);
  assert.equal(env.engine.pendingOps.length, 0);
  assert.equal(env.engine.likeCursor, 0, 'write ACK must not skip unread changes');
});

await check('flushPendingOps：无法上送的 op（无平台/本地歌）静默丢弃，有效 op 正常推送', async () => {
  const env = boot({ token: 'tok', nextSeq: 4 });
  env.engine.load();
  env.engine.pendingOps = [
    { type: 'song', action: 'add', dataJson: JSON.stringify({ ...songPayload, platform: 'local' }) },
    { type: 'song', action: 'add', dataJson: JSON.stringify({ ...songPayload, platform: null }) },
    { type: 'song', action: 'add', dataJson: JSON.stringify({ ...songPayload, sid: '' }) },
    { type: 'song', action: 'add', dataJson: songJson },
  ];
  await env.engine.flushPendingOps();
  assert.equal(env.batches.length, 1);
  assert.equal(env.batches[0].length, 1);
  assert.equal(JSON.parse(env.batches[0][0]).sid, 's1');
  assert.equal(env.engine.pendingOps.length, 0);
});

await check('flushPendingOps：remove 不上送 picUrl；无归属 payload 不凭空造 pid', async () => {
  const env = boot({ token: 'tok', nextSeq: 2 });
  env.engine.load();
  env.engine.pendingOps = [{
    type: 'song', action: 'remove',
    dataJson: JSON.stringify({ ...songPayload, pid: 'GP-7', picUrl: 'http://pic/1.png' }),
  }];
  await env.engine.flushPendingOps();
  const body = JSON.parse(env.batches[0][0]);
  assert.equal(body.pid, 'GP-7');
  assert.equal('picUrl' in body, false);
});

await check('resetLikeSync / clearLocalLikeData：清本地收藏数据与引擎状态', async () => {
  const env = boot({ token: 'tok', nextSeq: 1 });
  env.engine.load();
  env.host.likedSongs = [{ id: 's1', platform: 'wyy', name: 'x', singer: '', album: '', picUrl: '', url: '' }];
  env.host.savedPlaylists = [{ id: 'p1', platform: 'wyy', name: 'x', picUrl: '', playCount: '1', description: null, tracks: undefined, likeSeq: undefined, pid: undefined }];
  env.host.localPlaylists = [{ id: 'lp1', platform: 'local', name: 'x', pid: 'GP-1' }];
  env.engine.clearLocalLikeData();
  assert.deepEqual(norm(env.host.likedSongs), []);
  assert.deepEqual(norm(env.host.savedPlaylists), []);
  assert.deepEqual(norm(env.host.localPlaylists), []);
  assert.equal(env.host.likedDirty, true);
  assert.equal(env.host.playlistsDirty, true);
  assert.equal(env.host.localPlaylistsDirty, true);
  assert.equal(env.host.persistCount, 1);
});

await check('generateGlobalPid：UUID v4 形态（8-4-4-4-12、hex 字符集、变体位 89ab）', async () => {
  const env = boot({ token: null, nextSeq: 1 });
  const gen = vm.runInContext('generateGlobalPid', env.ctx);
  const seen = new Set();
  for (let i = 0; i < 64; i++) {
    const pid = gen();
    assert.equal(pid.length, 36);
    assert.deepEqual(pid.split('-').map((s) => s.length), [8, 4, 4, 4, 12]);
    assert.equal(pid[14], '4');
    assert.ok('89ab'.includes(pid[19]));
    assert.ok(/^[0-9a-f-]{36}$/.test(pid));
    seen.add(pid);
  }
  assert.equal(seen.size, 64); // 64 连发不撞车
});

await check('AUTH-01：换号会作废旧拉取，旧响应不写入新账号', async () => {
  const env = boot({ token: 'A', nextSeq: 1, sessionEpoch: 0 });
  env.userId = 'A';
  const oldResponse = deferred();
  const requests = [];
  env.fetchChangesImpl = (since) => {
    requests.push({ account: env.token, type: 'changes', since });
    if (env.token === 'A') return oldResponse.promise;
    return Promise.resolve({ maxSeq: 11, changes: [] });
  };
  env.fetchAllLikesImpl = async (page) => {
    requests.push({ account: env.token, type: 'all', page });
    return {
      songs: page === 1 ? [{ ...remoteChange('B-private', 11), likeSeq: 11 }] : [],
      playlists: [],
      maxSeq: 11,
    };
  };
  env.engine.likeCursor = 10;
  const oldPull = env.engine.pullChanges();
  await tick();
  env.token = 'B';
  env.userId = 'B';
  env.sessionEpoch = 1;
  env.engine.clearLocalLikeData();
  await env.engine.pullChanges();
  assert.deepEqual(requests.map((r) => r.type), ['changes', 'all', 'all']);
  assert.deepEqual(norm(env.host.likedSongs.map((s) => s.id)), ['B-private']);
  oldResponse.resolve({ maxSeq: 11, changes: [remoteChange('A-private', 11)] });
  await oldPull;
  assert.deepEqual(norm(env.host.likedSongs.map((s) => s.id)), ['B-private']);
  assert.equal(env.engine.likeCursor, 11);
  assert.equal(env.storage.get('qt-like-cursor:B'), '11');
  assert.equal(env.storage.get('qt-like-account'), 'B');
});

await check('全量拉取 failed page 不 merge，保留本地收藏与游标', async () => {
  const env = boot({ token: 'tok', nextSeq: 1, sessionEpoch: 0 });
  const local = { ...remoteChange('local-kept', 3), likeSeq: 3 };
  env.host.likedSongs = [local];
  env.engine.likeCursor = 0;
  let calls = 0;
  env.fetchAllLikesImpl = async (page) => {
    calls++;
    if (page === 1) {
      return { songs: [{ ...remoteChange('server-1', 4), likeSeq: 4 }], playlists: [], maxSeq: 4 };
    }
    return null;
  };
  await env.engine.pullChanges();
  assert.equal(calls, 2);
  assert.deepEqual(norm(env.host.likedSongs.map((song) => song.id)), ['local-kept']);
  assert.equal(env.engine.likeCursor, 0);
});

await check('全量拉取 100 页封顶视为 partial snapshot，不执行破坏性 merge', async () => {
  const env = boot({ token: 'tok', nextSeq: 1, sessionEpoch: 0 });
  env.host.likedSongs = [{ ...remoteChange('local-kept', 3), likeSeq: 3 }];
  env.engine.likeCursor = 0;
  let calls = 0;
  env.fetchAllLikesImpl = async (page) => {
    calls++;
    return { songs: [{ ...remoteChange('server-' + page, page), likeSeq: page }], playlists: [], maxSeq: page };
  };
  await env.engine.pullChanges();
  assert.equal(calls, 100);
  assert.deepEqual(norm(env.host.likedSongs.map((song) => song.id)), ['local-kept']);
});

await check('启动对账 failed page 不删除或补推本地收藏', async () => {
  const env = boot({ token: 'tok', nextSeq: 1, sessionEpoch: 0 });
  env.engine.likeCursor = 9;
  env.fetchChangesImpl = async () => ({ maxSeq: 9, changes: [] });
  env.host.savedPlaylists = [{
    id: 'keep-list', platform: 'wyy', pid: 'keep-list', name: 'keep',
    picUrl: '', playCount: '', description: null, likeSeq: 9,
  }];
  env.host.likedSongs = [{ ...remoteChange('keep-song', 9), likeSeq: 9 }];
  env.fetchAllLikesImpl = async (page) => {
    if (page === 1) {
      return { songs: [], playlists: [{ id: 'other', pid: 'other', platform: 'wyy', name: 'other', picUrl: '', playCount: '', description: null }], maxSeq: 9 };
    }
    return null;
  };
  await env.engine.syncLikesOnLaunch();
  assert.deepEqual(norm(env.host.savedPlaylists.map((pl) => pl.id)), ['keep-list']);
  assert.deepEqual(norm(env.host.likedSongs.map((song) => song.id)), ['keep-song']);
  assert.equal(env.engine.pendingOps.length, 0);
});

await check('对账枚举中换号后不删除新账号收藏', async () => {
  const env = boot({ token: 'A', nextSeq: 1, sessionEpoch: 0, userId: 'A' });
  env.engine.likeCursor = 9;
  env.fetchChangesImpl = async () => ({ maxSeq: 9, changes: [] });
  const oldPage = deferred();
  let reconcileStarted = false;
  env.fetchAllLikesImpl = () => {
    reconcileStarted = true;
    return oldPage.promise;
  };
  const launch = env.engine.syncLikesOnLaunch();
  await tick();
  assert.equal(reconcileStarted, true);
  env.token = 'B';
  env.userId = 'B';
  env.sessionEpoch = 1;
  env.engine.clearLocalLikeData();
  env.host.savedPlaylists = [{
    id: 'B-list', platform: 'wyy', pid: 'B-list', name: 'B',
    picUrl: '', playCount: '', description: null, likeSeq: 9,
  }];
  oldPage.resolve({ songs: [], playlists: [], maxSeq: 9 });
  await launch;
  assert.deepEqual(norm(env.host.savedPlaylists.map((pl) => pl.id)), ['B-list']);
});

await check('SYNC-01：推送 ACK 不推进读游标，未读远端变更仍会应用', async () => {
  const env = boot({ token: 'tok', nextSeq: 102, sessionEpoch: 0 });
  const since = [];
  env.likeBatchImpl = async (bodies) => {
    env.batches.push(bodies);
    return 102;
  };
  env.fetchChangesImpl = async (cursor) => {
    since.push(cursor);
    return cursor < 101
      ? { maxSeq: 102, changes: [remoteChange('remote-101', 101)] }
      : { maxSeq: 102, changes: [] };
  };
  env.engine.likeCursor = 100;
  env.engine.pendingOps = [{
    type: 'song', action: 'add',
    dataJson: JSON.stringify({ ...songPayload, sid: 'local-write' }),
  }];
  await env.engine.pullChanges();
  assert.equal(since[0], 100);
  assert.deepEqual(
    norm(env.host.likedSongs.map((s) => s.id)),
    ['remote-101'],
    JSON.stringify({
      since,
      cursor: env.engine.likeCursor,
      pending: env.engine.pendingOps.length,
      logs: env.logs.map((args) => args.map((value) => value instanceof Error ? value.stack : String(value))),
    }),
  );
  assert.equal(env.engine.likeCursor, 101);
});

await check('SYNC-02：普通批次失败不拆条重排，恢复后仍按原 add/remove 顺序提交', async () => {
  const env = boot({ token: 'tok', nextSeq: 1, sessionEpoch: 0 });
  let offline = true;
  const order = [];
  env.likeBatchImpl = async (bodies) => {
    if (offline) throw new Error('temporary network failure');
    for (const body of bodies) order.push(JSON.parse(body).action);
    env.batches.push(bodies);
    return bodies.length;
  };
  env.engine.pendingOps = [
    { type: 'song', action: 'add', dataJson: songJson },
    { type: 'song', action: 'remove', dataJson: songJson },
  ];
  await env.engine.flushPendingOps();
  assert.deepEqual(env.engine.pendingOps.map((op) => op.action), ['add', 'remove']);
  assert.deepEqual(order, []);
  offline = false;
  await env.engine.flushPendingOps();
  assert.deepEqual(order, ['add', 'remove']);
  assert.equal(env.engine.pendingOps.length, 0);
});

await check('SYNC-03：损坏内层 dataJson 被隔离留痕，健康操作继续推送', async () => {
  const env = boot({ token: 'tok', nextSeq: 2, sessionEpoch: 0 });
  env.storage.set('qt-like-pending-ops', JSON.stringify([
    JSON.stringify({ type: 'song', action: 'add', dataJson: '{' }),
    JSON.stringify({ type: 'song', action: 'remove', dataJson: songJson }),
  ]));
  env.engine.load();
  assert.equal(env.engine.pendingOps.length, 1);
  assert.equal(env.engine.pendingOps[0].action, 'remove');
  const quarantine = JSON.parse(env.storage.get('qt-like-corrupt-ops'));
  assert.equal(quarantine.length, 1);
  assert.ok(quarantine[0].includes('{'));
  await env.engine.flushPendingOps();
  assert.equal(env.batches.length, 1);
  assert.equal(env.engine.pendingOps.length, 0);
});

console.log(`[check-like-sync] ${passed} 条引擎用例通过`);
