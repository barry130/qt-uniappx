// 网络面别音质回归（2026-11-14）：执行真实 services/network-kind.ts +
// services/source-quality.ts。只替换 uni 存储/网络检测/事件边界；验证
// WIFI 与移动网络两张表的独立读写、当前网络路由、旧表迁移与恢复默认。
// VM 不证明 Vapor 编译、真机网络切换时序或引擎取链行为（后者由
// check-source-platform-management 与 check-playback-source 覆盖）。
import assert from 'node:assert/strict';
import { read, load, host, drain } from './check-source-auth-session.mjs';

const exported = text => [...text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)].map(match => match[1]);
const actual = (path, scope) => { const text = read(path); return load(text, exported(text), scope); };
const legacyPlayKey = read('services/source-quality.ts').match(/PLAY_QUALITIES_KEY = "([^"]+)"/)[1];
const QUALITIES_EVENT = 'qt-source-qualities-changed';

function fixture({ networkType = 'wifi', storage = null } = {}) {
  const b = host();
  b.uni.getNetworkType = (options) => { options.success({ networkType }); };
  const listeners = new Map();
  b.uni.$on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); };
  b.uni.$off = (name, fn) => { listeners.get(name)?.delete(fn); };
  b.uni.$emit = (name, ...args) => {
    b.events.push([name, ...args]);
    for (const fn of [...(listeners.get(name) ?? [])]) fn(...args);
  };
  if (storage != null) for (const [key, value] of storage) b.storage.set(key, value);
  const network = actual('services/network-kind.ts', { uni: b.uni });
  const quality = actual('services/source-quality.ts', { uni: b.uni, ...network });
  return { ...b, network, quality,
    flip: (type) => { for (const watcher of b.networkWatchers) watcher({ networkType: type }); },
    eventCount: (name) => b.events.filter(event => event[0] === name).length };
}

let passed = 0;
async function check(name, run) { await run(); passed++; console.log('  ✓ ' + name); }

await check('network-kind: 检测前按移动网络保守处理，回调后收敛；非 wifi 一律移动网络口径', async () => {
  const b = fixture({ networkType: 'cellular' });
  assert.equal(b.network.currentNetworkKind(), 'cellular');
  assert.equal(b.network.currentNetworkKind(), 'cellular', '监听接管只做一次');
  b.flip('wifi');
  assert.equal(b.network.currentNetworkKind(), 'wifi');
  b.flip('none');
  assert.equal(b.network.currentNetworkKind(), 'cellular', '断网/未知按移动网络保守处理');
  b.flip('ethernet');
  assert.equal(b.network.currentNetworkKind(), 'cellular', '以太网不视作 WIFI');
});

await check('getter 回落链按网络独立：未存档位回落调用方默认，空默认回 320', async () => {
  const b = fixture();
  assert.equal(b.quality.sourcePlayQualityForNetwork('wyy', 'flac', 'wifi'), 'flac');
  assert.equal(b.quality.sourceDownloadQualityForNetwork('wyy', 'flac', 'cellular'), 'flac');
  assert.equal(b.quality.sourcePlayQualityForNetwork('wyy', '', 'wifi'), '320');
  assert.equal(b.quality.sourceDownloadQualityForNetwork('wyy', '', 'cellular'), '320');
});

await check('WIFI 与移动网络独立落库：键分离、值互不影响、形状校验照旧', async () => {
  const b = fixture();
  assert.equal(b.quality.setSourcePlayQualityForNetwork('wyy', 'flac', 'wifi'), true);
  assert.equal(b.quality.setSourceDownloadQualityForNetwork('wyy', '128', 'cellular'), true);
  assert.equal(b.quality.sourcePlayQualityForNetwork('wyy', 'fallback', 'wifi'), 'flac');
  assert.equal(b.quality.sourcePlayQualityForNetwork('wyy', 'fallback', 'cellular'), 'fallback');
  assert.equal(b.quality.sourceDownloadQualityForNetwork('wyy', 'fallback', 'wifi'), 'fallback');
  assert.equal(b.quality.sourceDownloadQualityForNetwork('wyy', 'fallback', 'cellular'), '128');
  assert.deepEqual(JSON.parse(b.storage.get('qt-source-play-qualities-wifi')), { wyy: 'flac' });
  assert.deepEqual(JSON.parse(b.storage.get('qt-source-download-qualities-cellular')), { wyy: '128' });
  assert.equal(b.storage.has('qt-source-play-qualities-cellular'), false, '未设置的网络不落库');
  assert.equal(b.storage.has('qt-source-download-qualities-wifi'), false);
  assert.equal(b.quality.setSourcePlayQualityForNetwork('bad id!', 'flac', 'wifi'), false, '平台 id 形状校验');
  assert.equal(b.quality.setSourceDownloadQualityForNetwork('wyy', 'not a quality!', 'wifi'), false, '档位 id 形状校验');
});

await check('当前网络读写：切换后 getter 与写入都路由到新面别表', async () => {
  const b = fixture();
  b.quality.setSourcePlayQualityForNetwork('wyy', 'flac', 'wifi');
  b.quality.setSourcePlayQualityForNetwork('wyy', '128', 'cellular');
  assert.equal(b.quality.sourcePlayQualityOf('wyy', 'fallback'), 'flac', '默认 WIFI 表');
  b.flip('5g');
  assert.equal(b.quality.sourcePlayQualityOf('wyy', 'fallback'), '128', '切换后取移动网络表');
  b.quality.setSourcePlayQuality('wyy', '320');
  assert.equal(JSON.parse(b.storage.get('qt-source-play-qualities-cellular')).wyy, '320');
  assert.equal(JSON.parse(b.storage.get('qt-source-play-qualities-wifi')).wyy, 'flac', 'WIFI 表不被当前网络写入改动');
});

await check('网络切换转译成音质表变化事件；同面别重复回调不刷事件', async () => {
  const b = fixture();
  b.quality.sourcePlayQualityOf('wyy', 'fallback');
  const before = b.eventCount(QUALITIES_EVENT);
  assert.equal(b.eventCount('qt-network-kind-changed'), 1, '初始检测（保守移动网络→WIFI）发一次');
  b.flip('4g');
  assert.equal(b.eventCount('qt-network-kind-changed'), 2);
  assert.equal(b.eventCount(QUALITIES_EVENT), before + 1, 'source-quality 转译广播');
  b.flip('wifi');
  b.flip('wifi');
  assert.equal(b.eventCount('qt-network-kind-changed'), 3, '同面别重复回调不产生事件');
  assert.equal(b.eventCount(QUALITIES_EVENT), before + 2);
});

await check('迁移：旧不分网络表复制进两张网络表后删除；缺位才写、标记幂等', async () => {
  const b = fixture({ storage: new Map([
    ['qt-source-play-quality-schema', '3'],
    [legacyPlayKey, JSON.stringify({ wyy: 'flac', kw: '母带' })],
    ['qt-source-download-qualities', JSON.stringify({ kw: '320' })],
  ]) });
  assert.equal(b.storage.has(legacyPlayKey), false, '旧播放键迁移后删除');
  assert.equal(b.storage.has('qt-source-download-qualities'), false, '旧下载键迁移后删除');
  assert.equal(b.storage.get('qt-source-quality-network-schema'), '1');
  // 脏档位（形状不过）整条丢弃；合法档位两个网络各拿一份
  assert.deepEqual(JSON.parse(b.storage.get('qt-source-play-qualities-wifi')), { wyy: 'flac' });
  assert.deepEqual(JSON.parse(b.storage.get('qt-source-play-qualities-cellular')), { wyy: 'flac' });
  assert.deepEqual(JSON.parse(b.storage.get('qt-source-download-qualities-wifi')), { kw: '320' });
  assert.deepEqual(JSON.parse(b.storage.get('qt-source-download-qualities-cellular')), { kw: '320' });
  assert.equal(b.quality.sourcePlayQualityForNetwork('wyy', 'fallback', 'cellular'), 'flac');
  // 标记已写（模拟下一次进程）：不再复制，已独立改过的值保留
  const b2 = fixture({ storage: new Map([
    ['qt-source-quality-network-schema', '1'],
    [legacyPlayKey, JSON.stringify({ wyy: 'flac' })],
    ['qt-source-play-qualities-wifi', JSON.stringify({ wyy: '128' })],
  ]) });
  assert.equal(JSON.parse(b2.storage.get('qt-source-play-qualities-wifi')).wyy, '128', '已独立改过的 WIFI 值不被迁移覆盖');
  assert.equal(b2.storage.has('qt-source-play-qualities-cellular'), false, '标记在时不重搬');
  // 标记缺失但某张网络表已有值：缺位补齐、已有位保留
  const b3 = fixture({ storage: new Map([
    ['qt-source-play-quality-schema', '3'],
    [legacyPlayKey, JSON.stringify({ wyy: 'flac', qq: '320' })],
    ['qt-source-play-qualities-wifi', JSON.stringify({ wyy: '128' })],
  ]) });
  assert.deepEqual(JSON.parse(b3.storage.get('qt-source-play-qualities-wifi')), { wyy: '128', qq: '320' }, '已有位保留、缺位补齐');
  assert.deepEqual(JSON.parse(b3.storage.get('qt-source-play-qualities-cellular')), { wyy: 'flac', qq: '320' });
});

await check('恢复默认：新旧六键全清，读回落全局默认', async () => {
  const b = fixture({ storage: new Map([
    ['qt-source-quality-network-schema', '1'],
    ['qt-source-play-qualities-wifi', JSON.stringify({ wyy: 'flac' })],
    ['qt-source-play-qualities-cellular', JSON.stringify({ wyy: 'flac' })],
    ['qt-source-download-qualities-wifi', JSON.stringify({ wyy: '320' })],
    ['qt-source-download-qualities-cellular', JSON.stringify({ wyy: '320' })],
  ]) });
  b.quality.resetSourceQualities();
  for (const key of ['qt-source-play-qualities-wifi', 'qt-source-play-qualities-cellular',
    'qt-source-download-qualities-wifi', 'qt-source-download-qualities-cellular', legacyPlayKey, 'qt-source-download-qualities'])
    assert.equal(b.storage.has(key), false, key + ' 已清除');
  assert.equal(b.quality.sourcePlayQualityOf('wyy', 'owned'), 'owned');
  assert.equal(b.eventCount(QUALITIES_EVENT) > 0, true, '恢复默认后广播一次');
});

console.log(`Source-quality network split: ${passed} passed (actual network-kind/source-quality modules; owned storage/network boundaries).`);
