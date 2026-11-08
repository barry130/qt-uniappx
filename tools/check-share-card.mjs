import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../pages/share-card/index.uvue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const runnable = stripTypeScriptTypes(script.replace(/^import .*;$/gm, ''), { mode: 'strip' });
const drain = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture() {
  const timers = new Map(), captures = [], shares = [], saves = [], toasts = [], loading = new Set();
  let seq = 0, unload;
  const native = {
    capture: options => captures.push(options),
    save: () => Promise.resolve('/Pictures/qtMusic/saved.png'),
    share: options => { shares.push(options); options.success?.({}); },
  };
  const context = {
    ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }),
    useQtLayout: () => ({ isWide: true, windowWidth: 1100 }),
    useThemeStore: () => ({ skin: {} }), useShareCardStore: () => ({ song: { name: 'Test', picUrl: 'cover.png' } }),
    onLoad: () => {}, onUnload: callback => { unload = callback; },
    qtTrackPage: () => {}, qtFontPx: () => '', DEFAULT_PLAYLIST_COVER_ASSET: 'fallback.png',
    qtShowToast: options => toasts.push(options.title), logError: () => {},
    beginLoading: () => { const id = ++seq; loading.add(id); return id; }, finishLoading: id => loading.delete(id),
    setTimeout: (callback, delay) => { const id = ++seq; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    uni: { getElementById: () => ({ takeSnapshot: options => native.capture(options) }), shareWithSystem: options => native.share(options) },
    saveImageToGallery: (path, name) => { saves.push({ path, name }); return native.save(); },
  };
  const page = runInNewContext(runnable + '\n({ doSave, doShare, onCoverLoad, working });', context);
  const tick = delay => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay === delay && timers.has(id)) { timers.delete(id); timer.callback(); }
    }
  };
  return { page, native, captures, shares, saves, toasts, loading, timers, tick, unload: () => unload() };
}

for (const action of ['doSave', 'doShare']) {
  const b = fixture(); b.page.onCoverLoad();
  b.page[action](); b.page[action]();
  b.tick(320);
  assert.equal(b.captures.length, 1, 'repeated taps must not duplicate capture');
  b.captures[0].success({ tempFilePath: '/cache/card.png' });
  await drain();
  const calls = action === 'doSave' ? b.saves : b.shares;
  assert.equal(calls.length, 1, 'capture completion must reach the requested native action');
  assert.equal(action === 'doSave' ? calls[0].path : calls[0].imageUrl, '/cache/card.png');
  assert.equal(b.loading.size, 0); assert.equal(b.page.working.value, false);
}
console.log('PASS save/share receive the captured file exactly once');

for (const failure of ['empty', 'callback', 'throw', 'timeout']) {
  const b = fixture(); b.page.onCoverLoad();
  if (failure === 'throw') b.native.capture = () => { throw Error('snapshot unavailable'); };
  b.page.doSave(); b.tick(320);
  if (failure === 'empty') b.captures[0].success({ tempFilePath: '' });
  if (failure === 'callback') b.captures[0].fail({ errMsg: 'capture failed' });
  if (failure === 'timeout') b.tick(12000);
  await drain();
  assert.equal(b.saves.length, 0); assert.ok(b.toasts.length > 0, failure + ' gives feedback');
  assert.equal(b.loading.size, 0); assert.equal(b.page.working.value, false);
  if (failure === 'timeout') { b.captures[0].success({ tempFilePath: '/cache/late.png' }); await drain(); assert.equal(b.saves.length, 0); }
}
console.log('PASS empty/failed/throwing/timed-out snapshots recover without late exports');

for (const stage of ['delay', 'capture']) {
  const b = fixture(); b.page.onCoverLoad(); b.page.doShare();
  if (stage === 'capture') b.tick(320);
  b.unload(); b.tick(320);
  if (stage === 'capture') b.captures[0].success({ tempFilePath: '/cache/late.png' });
  await drain();
  assert.equal(b.shares.length, 0); assert.equal(b.toasts.length, 0);
  assert.equal(b.loading.size, 0); assert.equal(b.timers.size, 0); assert.equal(b.page.working.value, false);
}
console.log('PASS leaving the page cancels pending capture and suppresses late sharing');

const pending = fixture(); pending.page.onCoverLoad();
let finishSave;
pending.native.save = () => new Promise(resolve => { finishSave = resolve; });
pending.page.doSave(); pending.tick(320); pending.captures[0].success({ tempFilePath: '/cache/card.png' }); await drain();
pending.page.doSave(); pending.tick(320);
assert.equal(pending.captures.length, 1, 'saving must retain the duplicate-tap guard');
finishSave('/Pictures/qtMusic/saved.png'); await drain();
assert.equal(pending.page.working.value, false);

for (const result of ['empty', 'reject']) {
  const b = fixture(); b.page.onCoverLoad();
  b.native.save = () => result === 'empty' ? Promise.resolve('') : Promise.reject(Error('disk full'));
  b.page.doSave(); b.tick(320); b.captures[0].success({ tempFilePath: '/cache/card.png' }); await drain();
  assert.ok(b.toasts.some(title => title.includes('保存失败')));
  assert.equal(b.loading.size, 0); assert.equal(b.page.working.value, false);
}
for (const method of ['throw', 'fail']) {
  const b = fixture(); b.page.onCoverLoad();
  b.native.share = options => { if (method === 'throw') throw Error('module missing'); options.fail({ errMsg: 'no target' }); };
  b.page.doShare(); b.tick(320); b.captures[0].success({ tempFilePath: '/cache/card.png' }); await drain();
  assert.ok(b.toasts.some(title => title.includes('分享')));
  assert.equal(b.loading.size, 0); assert.equal(b.page.working.value, false);
}
console.log('PASS pending exports block duplicate taps; native save/share failures are visible and retryable');
