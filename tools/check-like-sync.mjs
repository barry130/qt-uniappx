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
  env.host = {
    likedSongs: [], savedPlaylists: [], localPlaylists: [],
    likedDirty: false, playlistsDirty: false, localPlaylistsDirty: false,
    persistCount: 0, saveLocalCount: 0,
    persistNow() { env.host.persistCount++; },
    saveLocalPlaylistsNow() { env.host.saveLocalCount++; },
  };
  const ctx = vm.createContext({
    UTSJSONObject: Utso,
    parseJsonToUtso: (text) => wrap(JSON.parse(text)),
    getAccessToken: () => env.token,
    logMsg: () => {},
    likeBatch: async (bodies) => {
      if (env.failBatch) throw Error('network down');
      env.batches.push(bodies);
      return env.nextSeq;
    },
    fetchChanges: async () => { env.changes.push('fetchChanges'); return { ok: true, items: [] }; },
    fetchAllLikes: async () => { env.changes.push('fetchAllLikes'); return { ok: true, items: [] }; },
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
  env.engine = new LikeSyncEngine(env.host);
  return env;
}

const songPayload = { sid: 's1', platform: 'wyy', name: '测试歌', singer: '歌手', album: '专辑' };
const songJson = JSON.stringify(songPayload);
function tick() { return new Promise((r) => setTimeout(r, 0)); }
function norm(v) { return JSON.parse(JSON.stringify(v)); }

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

await check('flushPendingOps：按序分批（450 条 → 200/200/50）、成功出队、游标盖章、likeSeq 回写', async () => {
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
  assert.equal(env.engine.likeCursor, 3);
  const stamped = env.host.likedSongs[0];
  assert.equal(stamped.likeSeq, 3);
  assert.equal(env.host.likedDirty, true);
  assert.ok(env.storage.get('qt-like-cursor') === '3');
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
  assert.equal(env.engine.likeCursor, 9);
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

console.log(`[check-like-sync] ${passed} 条引擎用例通过`);
