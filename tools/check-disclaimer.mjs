/**
 * 首次启动免责声明（stores/disclaimer.ts）的回归用例。
 *
 * 为什么给一个 store 单独写门禁：这段判定逻辑有两个消费方
 * （① pickDisclaimer 认领声明；② stores/notice.ts 的 buildSplashQueue 把声明从
 * 普通开屏队列里摘掉），并且与 qt-pc 的 `src/stores/disclaimer.ts` 是同构的两份实现。
 * 判据写岔的后果都不是"难看"：同一条公告弹两次、或用户勾了"今天不显示"把声明跳过。
 *
 * 运行：node tools/check-disclaimer.mjs
 * 说明：在隔离的 vm 里跑真实 store 源码（stripTypeScriptTypes 剥类型），
 * 不依赖 uni 运行时、不发请求 —— 与 tools/check-listen-stats.mjs 同一套做法。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const storeURL = new URL('../stores/disclaimer.ts', import.meta.url);
const storeSource = readFileSync(storeURL, 'utf8');
const noticeSource = readFileSync(new URL('../services/notice.ts', import.meta.url), 'utf8');

// sortNotices 是 services/notice.ts 的实现，这里只保留同款比较器：
// 少一处就少一处漂移，同时断言真实实现里那两个比较键还在（第 2 段用例）。
const sortNotices = (notices) => notices.slice().sort((a, b) => {
  const atop = a.isTop ?? 0;
  const btop = b.isTop ?? 0;
  if (atop !== btop) return btop - atop;
  const at = a.createTime ?? '';
  const bt = b.createTime ?? '';
  return bt.localeCompare(at);
});

const code = stripTypeScriptTypes(
  storeSource.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''),
);

/** 建一个隔离环境：uni storage 是内存 Map，通知列表可替换 */
function environment() {
  const env = { storage: new Map(), notices: [], failures: 0 };
  const context = () => vm.createContext({
    reactive: (value) => value,
    sortNotices,
    fetchActiveNotices: async () => {
      if (env.failures > 0) throw Error('offline');
      return env.notices;
    },
    uni: {
      getStorageSync: (key) => (env.storage.has(key) ? env.storage.get(key) : ''),
      setStorageSync: (key, value) => env.storage.set(key, value),
      removeStorageSync: (key) => env.storage.delete(key),
    },
    Math,
    JSON,
    Date,
  });
  /** 起一个全新的 store 实例（相当于一次冷启动） */
  env.boot = () => vm.runInContext(code + '\nnew DisclaimerStore();', context());
  /** 起一个能直接拿到模块级导出函数的上下文（判据函数不在 store 实例上） */
  env.probe = () => vm.runInContext(
    code + '\n({ isDisclaimerNotice, pickDisclaimer, shouldShow });', context());
  return env;
}

/** 造一条公告；over 覆盖字段 */
function notice(over = {}) {
  return {
    id: 1,
    display: 1,
    title: '使用前请先阅读',
    content: '<p>正文</p>',
    termsVersion: '2026.10',
    readSeconds: 3,
    isTop: 0,
    createTime: '2026-10-20 10:00:00',
    ...over,
  };
}

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + label);
}
async function checkAsync(label, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + label);
}

// ============ 1. 认领判据：开屏位 + 版本号非空 ============
{
  const env = environment();
  const store = env.boot();
  // 判据函数是模块级导出，不在 store 实例上，另起一个上下文取出来
  const probe = env.probe();
  assert.equal(typeof store.init, 'function');

  check('开屏位 + 版本号非空 = 免责声明', () => {
    assert.equal(probe.isDisclaimerNotice(notice()), true);
  });
  check('没有版本号就不是声明（普通开屏公告不能被摘走）', () => {
    assert.equal(probe.isDisclaimerNotice(notice({ termsVersion: undefined })), false);
    assert.equal(probe.isDisclaimerNotice(notice({ termsVersion: '' })), false);
    assert.equal(probe.isDisclaimerNotice(notice({ termsVersion: '   ' })), false);
  });
  check('只有版本号、没有开屏位也不是声明', () => {
    assert.equal(probe.isDisclaimerNotice(notice({ display: 4 })), false);
    assert.equal(probe.isDisclaimerNotice(notice({ display: 2 })), false);
  });
  check('display 缺失时回落到 type（老数据只有 type）', () => {
    assert.equal(probe.isDisclaimerNotice(notice({ display: undefined, type: 1 })), true);
    assert.equal(probe.isDisclaimerNotice(notice({ display: undefined, type: 4 })), false);
  });

  // ============ 2. 比较器不能漂移 ============
  check('services/notice.ts 的 sortNotices 仍按 isTop + createTime 倒序', () => {
    assert.ok(noticeSource.includes('bt.localeCompare(at)'),
      'sortNotices 的比较键变了，请同步更新本用例的替身实现');
    const list = [notice({ id: 1, createTime: '2026-10-20 10:00:00' }), notice({ id: 2, createTime: '2026-10-21 10:00:00' })];
    assert.equal(sortNotices(list)[0].id, 2, '新的排前面');
    const top = [notice({ id: 1, isTop: 1, createTime: '2026-10-01 10:00:00' }), notice({ id: 2, createTime: '2026-10-21 10:00:00' })];
    assert.equal(sortNotices(top)[0].id, 1, '置顶优先');
  });

  // ============ 3. pickDisclaimer ============
  check('从混合列表里只挑出声明', () => {
    const picked = probe.pickDisclaimer([
      notice({ id: 10, termsVersion: undefined }),
      notice({ id: 11, termsVersion: '2026.10', display: 1 }),
      notice({ id: 12, termsVersion: '2026.10', display: 4 }),
    ]);
    assert.equal(picked.id, 11);
  });
  check('没有声明返回 null（此时不弹）', () => {
    assert.equal(probe.pickDisclaimer([notice({ termsVersion: undefined })]), null);
    assert.equal(probe.pickDisclaimer([]), null);
  });
  check('多条声明取置顶的那条，其次取更新的', () => {
    const top = probe.pickDisclaimer([
      notice({ id: 20, createTime: '2026-10-21 10:00:00' }),
      notice({ id: 21, isTop: 1, createTime: '2026-10-01 10:00:00' }),
    ]);
    assert.equal(top.id, 21);
    const latest = probe.pickDisclaimer([
      notice({ id: 30, createTime: '2026-10-01 10:00:00' }),
      notice({ id: 31, createTime: '2026-10-21 10:00:00' }),
    ]);
    assert.equal(latest.id, 31);
  });
  check('读秒夹在 0..60（后台写 600 也不能把新用户锁十分钟）', () => {
    assert.equal(probe.pickDisclaimer([notice({ readSeconds: 600 })]).readSeconds, 60);
    assert.equal(probe.pickDisclaimer([notice({ readSeconds: -5 })]).readSeconds, 0);
    assert.equal(probe.pickDisclaimer([notice({ readSeconds: undefined })]).readSeconds, 0);
    assert.equal(probe.pickDisclaimer([notice({ readSeconds: 3 })]).readSeconds, 3);
  });
  check('字段缺失时给安全默认值（标题/正文/链接不抛错）', () => {
    const picked = probe.pickDisclaimer([notice({ title: undefined, content: undefined, url: undefined })]);
    assert.equal(picked.title, '');
    assert.equal(picked.content, '');
    assert.equal(picked.url, '');
  });

  // ============ 4. shouldShow ============
  const d = probe.pickDisclaimer([notice()]);
  check('没有接受记录 → 弹', () => {
    assert.equal(probe.shouldShow(null, d), true);
  });
  check('同版本 → 不弹', () => {
    assert.equal(probe.shouldShow({ termsVersion: '2026.10', acceptedAt: 'x' }, d), false);
  });
  check('版本变了 → 重新弹一次', () => {
    assert.equal(probe.shouldShow({ termsVersion: '2026.09', acceptedAt: 'x' }, d), true);
  });
  check('记录里版本号为空（旧裸字符串/存储异常）→ 按已接受，不骚扰老用户', () => {
    assert.equal(probe.shouldShow({ termsVersion: '', acceptedAt: '2026-10-18T03:00:00Z' }, d), false);
  });
  check('后端没下发声明 → 不弹（绝不弹空壳）', () => {
    assert.equal(probe.shouldShow(null, null), false);
  });
}

// ============ 5. init / accept / reopen（走真实 store 实例） ============
await checkAsync('init：拉到声明且没有记录 → pending 为 true，visible 为真', async () => {
  const env = environment();
  env.notices = [notice()];
  const store = env.boot();
  assert.equal(store.pending, null, '初值必须是 null，否则冷启动会先闪一个空弹窗');
  await store.init();
  assert.equal(store.pending, true);
  assert.equal(store.visible, true);
});

await checkAsync('init：拉取失败 → pending 为 false，启动流程不被卡住', async () => {
  const env = environment();
  env.failures = 1;
  const store = env.boot();
  await store.init();
  assert.equal(store.pending, false);
  assert.equal(store.visible, false);
});

await checkAsync('accept：落库含条款版本号，下次启动同版本不再弹', async () => {
  const env = environment();
  env.notices = [notice()];
  const first = env.boot();
  await first.init();
  first.accept();
  assert.equal(first.pending, false);
  assert.equal(first.visible, false);
  const raw = env.storage.get('qt-disclaimer-accepted');
  assert.ok(typeof raw === 'string' && raw.length > 0);
  const rec = JSON.parse(raw);
  assert.equal(rec.termsVersion, '2026.10');
  assert.ok(typeof rec.acceptedAt === 'string' && rec.acceptedAt.length > 0);

  const second = env.boot();
  await second.init();
  assert.equal(second.pending, false, '同一版本不该再弹');
});

await checkAsync('accept 之后版本号变了 → 新实例重新弹', async () => {
  const env = environment();
  env.notices = [notice()];
  const first = env.boot();
  await first.init();
  first.accept();

  env.notices = [notice({ id: 2, termsVersion: '2027.01' })];
  const second = env.boot();
  await second.init();
  assert.equal(second.pending, true);
});

await checkAsync('接受记录读坏了当作没接受过（重弹一次，好过永久漏弹）', async () => {
  const env = environment();
  env.notices = [notice()];
  env.storage.set('qt-disclaimer-accepted', '{ 这不是 JSON');
  const store = env.boot();
  await store.init();
  assert.equal(store.pending, true);
});

await checkAsync('旧版只写 ISO 时刻的裸字符串 → 按已接受，不打扰', async () => {
  const env = environment();
  env.notices = [notice()];
  env.storage.set('qt-disclaimer-accepted', '2026-10-18T03:00:00.000Z');
  const store = env.boot();
  await store.init();
  assert.equal(store.pending, false);
});

await checkAsync('reopen：取不到声明返回 false（界面据此提示，不留死按钮）', async () => {
  const env = environment();
  env.failures = 1;
  const store = env.boot();
  const shown = await store.reopen();
  assert.equal(shown, false);
  assert.equal(store.visible, false);
});

await checkAsync('reopen：拉到声明就展示，且不写接受记录', async () => {
  const env = environment();
  env.notices = [notice()];
  const store = env.boot();
  const shown = await store.reopen();
  assert.equal(shown, true);
  assert.equal(store.visible, true);
  assert.equal(env.storage.has('qt-disclaimer-accepted'), false, '「重新查看」不能替用户点同意');
});

console.log(`[disclaimer] ${passed} 条回归用例通过`);
