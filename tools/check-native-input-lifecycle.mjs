import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext, createContext } from 'node:vm';
import ts from 'typescript';
import { preprocessPlatform } from './platform-preprocess.mjs';

const servicePath = 'uni_modules/qt-ui/services/native-input-lifecycle.ts';
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const source = read(servicePath);
let passed = 0;
function check(name, test) {
  test();
  console.log('PASS ' + name);
  passed++;
}

function harness(platform = 'APP-ANDROID') {
  let current = null, sequence = 0, now = 0;
  const timers = new Map(), queued = new Map(), cleared = [], scheduled = [];
  const builtin = { name: 'input' };
  const textarea = { name: 'textarea' };
  const vue = {
    getCurrentInstance: () => current,
    onBeforeUnmount: (callback, owner) => {
      assert.ok(owner, 'the native input must own its cleanup');
      owner.beforeUnmount.push(callback);
    },
  };
  const runtime = createContext({
    setTimeout: function (callback, delay, ...args) {
      const id = ++sequence;
      const task = { id, callback, args, delay, time: now + (delay ?? 0) };
      timers.set(id, task);
      queued.set(id, task);
      scheduled.push(task);
      return id;
    },
    clearTimeout: id => { cleared.push(id); timers.delete(id); },
    setInterval: () => 999,
    clearInterval: () => {},
  });
  const originalSet = runtime.setTimeout, originalClear = runtime.clearTimeout;
  const originalInterval = runtime.setInterval;
  const app = { component: name => ({ Input: builtin, Textarea: textarea })[name] };
  function loadService() {
    const module = { exports: {} };
    const code = ts.transpileModule(preprocessPlatform(source, platform), {
      fileName: servicePath,
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    runInContext(`(function(require, module, exports) { ${code}\n})`, runtime)(
      id => {
        assert.equal(id, 'vue');
        return vue;
      }, module, module.exports,
    );
    return module.exports.installQtNativeInputLifecycle;
  }
  const install = loadService();
  function asOwner(owner, callback) {
    const previous = current;
    current = owner;
    try { return callback(); } finally { current = previous; }
  }
  function owner(type = builtin) { return { type, beforeUnmount: [] }; }
  function unmount(instance) {
    asOwner(instance, () => instance.beforeUnmount.forEach(callback => callback()));
  }
  function fire(id, evenIfCancelled = false, receiver = runtime) {
    const task = (evenIfCancelled ? queued : timers).get(id);
    if (!task) return;
    timers.delete(id);
    now = Math.max(now, task.time);
    return asOwner(null, () => task.callback.apply(receiver, task.args));
  }
  function tick(milliseconds) {
    const until = now + milliseconds;
    while (true) {
      const next = [...timers.values()].filter(task => task.time <= until).sort((a, b) => a.time - b.time || a.id - b.id)[0];
      if (!next) break;
      fire(next.id);
    }
    now = until;
  }
  return { runtime, originalSet, originalClear, originalInterval, timers, queued, cleared, scheduled, app, builtin, textarea, install, loadService, owner, asOwner, unmount, fire, tick };
}

// HBuilderX 5.34 built-in Input's lifecycle, confirmed in its Android snapshot:
// setup registers destroy(); mounted schedules an untracked 80ms style batch.
// See dcloudio/uni-app src/uni_modules/uni-form/components/input/input.uvue,
// commit ddbe86f5e346dfc9309063d93768ed3c1c0cf688 (same missing timeout cleanup).
function mountNativeInput(h, type = h.builtin) {
  const instance = h.owner(type);
  const native = {
    destroyed: false, batches: 0, styles: 0, ends: 0,
    beginUpdateBatch() {
      if (this.destroyed) throw new Error('UTS instance 20 is not registered: moduleName=_uni-form, methodId=19');
      this.batches++;
    },
    syncStyles() { this.styles++; },
    endUpdateBatch() { this.ends++; },
    destroy() { this.destroyed = true; },
  };
  // The framework registers this before our cleanup, during setup.
  instance.beforeUnmount.push(() => native.destroy());
  const id = h.asOwner(instance, () => h.runtime.setTimeout(() => {
    native.beginUpdateBatch();
    native.syncStyles();
    native.endUpdateBatch();
  }, 80));
  return { instance, native, id };
}

check('unprotected 80ms native style callback reproduces the reported methodId=19 failure', () => {
  const h = harness();
  const input = mountNativeInput(h);
  h.tick(10);
  h.unmount(input.instance);
  assert.throws(() => h.tick(70), /UTS instance 20 is not registered: moduleName=_uni-form, methodId=19/);
});

check('unmount cancels the pending native update and makes an already queued callback inert', () => {
  const h = harness();
  h.install(h.app);
  const input = mountNativeInput(h);
  h.tick(10);
  h.unmount(input.instance);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.cleared, [input.id]);
  h.fire(input.id, true);
  h.tick(100);
  assert.equal(input.native.batches, 0);
  h.unmount(input.instance);
  assert.deepEqual(h.cleared, [input.id], 'repeated teardown does not cancel the handle again');
});

check('a mounted input completes its normal style batch exactly once', () => {
  const h = harness();
  h.install(h.app);
  const input = mountNativeInput(h);
  h.tick(80);
  assert.deepEqual([input.native.batches, input.native.styles, input.native.ends], [1, 1, 1]);
  h.unmount(input.instance);
  assert.equal(h.cleared.length, 0, 'completed handles are released before teardown');
  h.fire(input.id, true);
  assert.equal(input.native.batches, 1);
});

check('textarea height initialization is canceled independently of other live form controls', () => {
  const h = harness();
  h.install(h.app);
  let heightUpdates = 0;
  const textarea = h.owner(h.textarea), liveTextarea = h.owner(h.textarea);
  const input = mountNativeInput(h);
  const removed = h.asOwner(textarea, () => h.runtime.setTimeout(() => heightUpdates++, 80));
  h.asOwner(liveTextarea, () => h.runtime.setTimeout(() => heightUpdates++, 80));
  h.tick(10);
  h.unmount(textarea);
  h.fire(removed, true);
  h.tick(100);
  assert.equal(heightUpdates, 1);
  assert.equal(input.native.batches, 1);
  h.unmount(liveTextarea);
  h.unmount(input.instance);
  assert.deepEqual(h.cleared, [removed]);
});

check('a runtime exposing only Textarea still receives lifecycle cleanup', () => {
  const h = harness();
  h.install({ component: name => name == 'textarea' ? h.textarea : undefined });
  const owner = h.owner(h.textarea);
  let called = false;
  const id = h.asOwner(owner, () => h.runtime.setTimeout(() => { called = true; }, 80));
  h.unmount(owner);
  h.fire(id, true);
  assert.equal(called, false);
  assert.equal(h.timers.size, 0);
});

check('rapid input replacement cancels only the old instance and retains the new input update', () => {
  const h = harness();
  h.install(h.app);
  const old = mountNativeInput(h);
  h.tick(20);
  const next = mountNativeInput(h);
  h.unmount(old.instance);
  h.fire(old.id, true);
  h.tick(100);
  assert.equal(old.native.batches, 0);
  assert.equal(next.native.batches, 1);
  assert.equal(next.native.destroyed, false);
});

check('multiple input timers share one cleanup and explicit cancellation releases its handle', () => {
  const h = harness();
  h.install(h.app);
  const instance = h.owner();
  let calls = 0;
  const ids = h.asOwner(instance, () => [40, 80, 120].map(delay => h.runtime.setTimeout(() => calls++, delay)));
  assert.equal(instance.beforeUnmount.length, 1);
  h.runtime.clearTimeout(ids[1]);
  h.tick(50);
  assert.equal(calls, 1);
  h.fire(ids[1], true);
  h.unmount(instance);
  h.fire(ids[2], true);
  assert.equal(calls, 1);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.cleared, [ids[1], ids[2]]);
});

check('owned timeouts retain native IDs, delays, arguments, callback context and return values', () => {
  const h = harness();
  h.install(h.app);
  const instance = h.owner(), data = { value: 42 }, receiver = { id: 'timer-host' };
  const id = h.asOwner(instance, () => h.runtime.setTimeout(function (first, second) {
    assert.equal(this, receiver);
    assert.equal(first, data);
    assert.equal(second, 'argument');
    return 'result';
  }, 80, data, 'argument'));
  assert.equal(id, h.scheduled[0].id);
  assert.equal(h.scheduled[0].delay, 80);
  assert.equal(h.fire(id, false, receiver), 'result');
});

check('page, player and similarly named custom component timers are forwarded without ownership', () => {
  const h = harness();
  h.install(h.app);
  const callback = () => {};
  for (const instance of [null, h.owner({ name: 'player' }), h.owner({ name: 'input' })]) {
    const id = h.asOwner(instance, () => h.runtime.setTimeout(callback, 250, 'same argument'));
    assert.equal(h.queued.get(id).callback, callback);
    assert.deepEqual(h.queued.get(id).args, ['same argument']);
    if (instance) {
      h.unmount(instance);
      assert.equal(instance.beforeUnmount.length, 0);
      assert.ok(h.timers.has(id));
    }
    h.runtime.clearTimeout(id);
  }
  const stringId = h.asOwner(h.owner(), () => h.runtime.setTimeout('legacy callback', 10));
  assert.equal(h.queued.get(stringId).callback, 'legacy callback');
  h.runtime.clearTimeout(stringId);
  assert.equal(h.runtime.setInterval, h.originalInterval);
});

check('errors from a live native callback still propagate', () => {
  const h = harness();
  h.install(h.app);
  const error = new Error('real input update error');
  const instance = h.owner();
  const id = h.asOwner(instance, () => h.runtime.setTimeout(() => { throw error; }, 80));
  assert.throws(() => h.fire(id), value => value === error);
  h.unmount(instance);
  assert.equal(h.cleared.length, 0, 'failed callbacks still release their tracking');
});

check('installation is idempotent across module reloads and additional app instances', () => {
  const h = harness();
  h.install(h.app);
  const set = h.runtime.setTimeout, clear = h.runtime.clearTimeout;
  const additionalInput = { name: 'input' };
  const reloadedInstall = h.loadService();
  reloadedInstall({ component: name => name == 'Input' ? additionalInput : undefined });
  h.install(h.app);
  assert.equal(h.runtime.setTimeout, set);
  assert.equal(h.runtime.clearTimeout, clear);
  const first = mountNativeInput(h);
  const second = mountNativeInput(h, additionalInput);
  h.unmount(first.instance);
  h.unmount(second.instance);
  assert.equal(first.instance.beforeUnmount.length, 2, 'framework teardown plus one timer cleanup');
  assert.equal(h.timers.size, 0);
  h.fire(first.id, true);
  h.fire(second.id, true);
});

check('scheduling from a disposed input cannot leave another native callback pending', () => {
  const h = harness();
  h.install(h.app);
  const input = mountNativeInput(h);
  h.unmount(input.instance);
  let calls = 0;
  const id = h.asOwner(input.instance, () => h.runtime.setTimeout(() => calls++, 80));
  assert.equal(h.timers.size, 0);
  h.fire(id, true);
  assert.equal(calls, 0);
});

check('100 mount / replace / unmount cycles release every timer without suppressing live batches', () => {
  const h = harness();
  h.install(h.app);
  for (let n = 0; n < 100; n++) {
    const removed = mountNativeInput(h), visible = mountNativeInput(h);
    h.unmount(removed.instance);
    h.tick(100);
    h.fire(removed.id, true);
    assert.equal(visible.native.batches, 1);
    h.unmount(visible.instance);
    assert.equal(h.timers.size, 0);
  }
});

check('non-Android platforms and runtimes without a registered input retain their timer APIs', () => {
  for (const platform of ['APP-IOS', 'APP-HARMONY', 'WEB']) {
    const h = harness(platform);
    h.install({ component: () => { throw new Error('Android registration must be preprocessed away'); } });
    assert.equal(h.runtime.setTimeout, h.originalSet);
    assert.equal(h.runtime.clearTimeout, h.originalClear);
  }
  const h = harness();
  h.install({ component: () => undefined });
  assert.equal(h.runtime.setTimeout, h.originalSet);
  assert.equal(h.runtime.clearTimeout, h.originalClear);
});

check('the real app entry installs the guard after native component registration, before mount', () => {
  const order = [], app = {};
  const module = { exports: {} };
  const code = ts.transpileModule(read('main.uts'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInContext(`(function(require, module, exports) { ${code}\n})`, createContext())(
    id => {
      if (id == 'vue') return { createSSRApp: () => { order.push('registered'); return app; } };
      if (id == './App.uvue') return { default: {} };
      assert.equal(id, '@/uni_modules/qt-ui/services/native-input-lifecycle');
      return { installQtNativeInputLifecycle: actual => { assert.equal(actual, app); order.push('guarded'); } };
    }, module, module.exports,
  );
  assert.equal(module.exports.createApp().app, app);
  assert.deepEqual(order, ['registered', 'guarded']);
});

console.log(`native input lifecycle: ${passed} checks passed`);
