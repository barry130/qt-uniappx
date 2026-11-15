/** 应用更新全局弹窗行为门禁：执行真实源码，避免静态 import 检查假绿。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import * as vue from "vue";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
let passed = 0;
function check(name, run) {
  try { run(); passed++; console.log("PASS " + name); }
  catch (error) { errors.push(name + ": " + error.message); console.log("FAIL " + name + " -> " + error.message); }
}
function compile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}
async function checkAsync(name, run) {
  try { await run(); passed++; console.log("PASS " + name); }
  catch (error) { errors.push(name + ": " + error.message); console.log("FAIL " + name + " -> " + error.message); }
}
function loadUpdateService(vueRuntime = { ref: value => ({ value }) }) {
  const source = fs.readFileSync(path.join(appRoot, "services", "app-update.ts"), "utf8");
  const moduleBox = { exports: {} };
  const context = {
    require(id) {
      if (id === "vue") return vueRuntime;
      throw new Error("Unexpected import: " + id);
    },
    module: moduleBox,
    exports: moduleBox.exports,
  };
  vm.runInNewContext("(function(require,module,exports){" + compile(source) + "\n})(require,module,exports)", context);
  return moduleBox.exports;
}
function update(versionCode, versionName) {
  return {
    versionCode, versionName, updateNotes: "notes-" + versionName, isForce: false,
    downloadUrl: "https://example.invalid/" + versionName + ".apk",
  };
}

check("same-version publication and dismiss preserve public state", () => {
  const api = loadUpdateService();
  const state = api.appUpdateState();
  assert.equal(state.visible.value, false);
  assert.equal(state.info.value, null);
  api.publishAppUpdate(update(10, "1.0"));
  assert.equal(state.visible.value, true);
  assert.equal(state.info.value.versionName, "1.0");
  api.publishAppUpdate({ ...update(10, "1.0"), versionName: "1.0-force", isForce: true });
  assert.equal(state.info.value.versionName, "1.0");
  api.dismissAppUpdate();
  assert.equal(state.visible.value, false);
  assert.equal(state.info.value, null);
  api.publishAppUpdate(update(11, "1.1"));
  assert.equal(state.visible.value, true);
  assert.equal(state.info.value.versionCode, 11);
});

check("a visible update cannot be replaced by another version during download", () => {
  const api = loadUpdateService();
  const state = api.appUpdateState();
  api.publishAppUpdate(update(20, "2.0"));
  api.publishAppUpdate(update(21, "2.1"));
  assert.equal(state.visible.value, true);
  assert.equal(state.info.value.versionCode, 20);
  assert.equal(state.info.value.downloadUrl, "https://example.invalid/2.0.apk");
});

function extractBalanced(source, marker, openChar, closeChar) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "missing source marker: " + marker);
  const open = source.indexOf(openChar, start);
  assert.notEqual(open, -1, "missing opening token for: " + marker);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === openChar) depth++;
    if (source[i] === closeChar) depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("unbalanced source block: " + marker);
}
function homeSource() {
  return fs.readFileSync(path.join(appRoot, "pages", "home", "index.uvue"), "utf8");
}
// Integration seam agreed for Home: real production update functions/watchers,
// real Vue scheduling and app-update service; pending delivery/notice data are fixtures.
function homeFlowFixture() {
  const source = homeSource();
  const start = source.indexOf("const upgradeVisible = ref(false);");
  const end = source.indexOf("onMounted(() => {", start);
  assert.ok(start >= 0 && end > start, "missing Home update declarations and watchers");
  const api = loadUpdateService(vue);
  const state = api.appUpdateState();
  const pendingUpdateRef = vue.ref(null);
  const noticeStore = vue.reactive({ loaded: true, splashNotice: null });
  const scope = vue.effectScope();
  const context = {
    ref: vue.ref, computed: vue.computed, watch: vue.watch,
    appUpdateVisible: state.visible, pendingUpdateRef, noticeStore,
    publishAppUpdate: api.publishAppUpdate,
    consumePendingUpdate() {
      const pending = pendingUpdateRef.value;
      pendingUpdateRef.value = null;
      return pending;
    },
  };
  const program = source.slice(start, end) + "\n" +
    extractBalanced(source, "watch(appUpdateVisible,", "(", ")");
  scope.run(() => vm.runInNewContext(compile(program), context));
  return {
    state,
    async deliver(info) { pendingUpdateRef.value = info; await vue.nextTick(); },
    async close() { api.dismissAppUpdate(); await vue.nextTick(); },
    async noticeBusy(busy) { noticeStore.splashNotice = busy ? {} : null; await vue.nextTick(); },
    async publishElsewhere(info) { api.publishAppUpdate(info); await vue.nextTick(); },
    stop() { scope.stop(); },
  };
}

await checkAsync("Home-owned A close publishes queued B instead of dropping it", async () => {
  const fixture = homeFlowFixture();
  try {
    await fixture.deliver(update(30, "A"));
    assert.equal(fixture.state.info.value.versionName, "A");
    await fixture.deliver(update(31, "B"));
    assert.equal(fixture.state.info.value.versionName, "A", "active update stays immutable");
    await fixture.close();
    assert.equal(fixture.state.visible.value, true, "queued B must open after A closes");
    assert.equal(fixture.state.info.value.versionName, "B");
    await fixture.close();
    assert.equal(fixture.state.visible.value, false);
    assert.equal(fixture.state.info.value, null);
  } finally { fixture.stop(); }
});

await checkAsync("a repeated pending copy of Home's visible version does not reopen on close", async () => {
  const fixture = homeFlowFixture();
  try {
    await fixture.deliver(update(30, "A"));
    await fixture.deliver({ ...update(30, "A"), updateNotes: "refreshed metadata" });
    await fixture.close();
    assert.equal(fixture.state.visible.value, false, "the displayed version was already consumed");
    assert.equal(fixture.state.info.value, null);
  } finally { fixture.stop(); }
});

await checkAsync("Home-owned close preserves B until the notice gate becomes idle", async () => {
  const fixture = homeFlowFixture();
  try {
    await fixture.deliver(update(30, "A"));
    await fixture.noticeBusy(true);
    await fixture.deliver(update(31, "B"));
    await fixture.close();
    assert.equal(fixture.state.visible.value, false, "notice blocks B after A closes");
    assert.equal(fixture.state.info.value, null);
    await fixture.noticeBusy(false);
    assert.equal(fixture.state.info.value.versionName, "B");
    await fixture.close();
    assert.equal(fixture.state.visible.value, false);
  } finally { fixture.stop(); }
});

await checkAsync("a duplicate of visible A does not erase queued B", async () => {
  const fixture = homeFlowFixture();
  try {
    await fixture.deliver(update(30, "A"));
    await fixture.deliver(update(31, "B"));
    await fixture.deliver(update(30, "A"));
    await fixture.close();
    assert.equal(fixture.state.info.value.versionName, "B");
    await fixture.deliver(update(31, "B"));
    await fixture.close();
    assert.equal(fixture.state.visible.value, false);
  } finally { fixture.stop(); }
});

await checkAsync("repeated queued B is presented once after Home-owned A closes", async () => {
  const fixture = homeFlowFixture();
  try {
    await fixture.deliver(update(30, "A"));
    await fixture.deliver(update(31, "B"));
    await fixture.deliver(update(31, "B"));
    await fixture.close();
    assert.equal(fixture.state.info.value.versionName, "B");
    await fixture.close();
    assert.equal(fixture.state.visible.value, false);
    await fixture.noticeBusy(true);
    await fixture.noticeBusy(false);
    assert.equal(fixture.state.visible.value, false);
  } finally { fixture.stop(); }
});

await checkAsync("another page's close keeps Home ownership and notice gating intact", async () => {
  const fixture = homeFlowFixture();
  try {
    await fixture.publishElsewhere(update(29, "other"));
    await fixture.deliver(update(30, "A"));
    assert.equal(fixture.state.info.value.versionName, "other");
    await fixture.noticeBusy(true);
    await fixture.close();
    assert.equal(fixture.state.visible.value, false);
    await fixture.noticeBusy(false);
    assert.equal(fixture.state.info.value.versionName, "A");
    await fixture.deliver(update(31, "B"));
    await fixture.close();
    assert.equal(fixture.state.info.value.versionName, "B");
    await fixture.close();
    assert.equal(fixture.state.visible.value, false);
  } finally { fixture.stop(); }
});

function homeOpenFixture(globalVisible) {
  const source = extractBalanced(homeSource(), "function openUpgrade()", "{", "}");
  const context = {
    upgradeInfo: { value: update(30, "3.0") },
    displayedUpgradeInfo: { value: null },
    upgradeVisible: { value: false },
    upgradeHold: { value: false },
    appUpdateVisible: { value: globalVisible },
    published: 0,
    publishAppUpdate() { context.published++; },
  };
  vm.runInNewContext(compile(source + "\nglobalThis.run = openUpgrade;"), context);
  return context;
}
function homeWatcherFixture(localVisible, hold, noticeIdle) {
  const source = extractBalanced(homeSource(), "watch(appUpdateVisible,", "(", ")");
  const context = {
    appUpdateVisible: { value: false },
    upgradeInfo: { value: localVisible ? null : update(30, "3.0") },
    displayedUpgradeInfo: { value: localVisible ? update(30, "3.0") : null },
    upgradeVisible: { value: localVisible },
    upgradeHold: { value: hold },
    noticeIdle: { value: noticeIdle },
    opened: 0,
    openUpgrade() { context.opened++; },
    watch(_ref, callback) { context.callback = callback; },
  };
  vm.runInNewContext(compile(source), context);
  return context;
}

check("Home waits without publishing when another page owns the visible update", () => {
  const fixture = homeOpenFixture(true);
  fixture.run();
  assert.equal(fixture.published, 0);
  assert.equal(fixture.upgradeVisible.value, false);
  assert.equal(fixture.upgradeHold.value, true);
  assert.equal(fixture.upgradeInfo.value.versionCode, 30);
});

check("Home publishes and owns its update when the global host is idle", () => {
  const fixture = homeOpenFixture(false);
  fixture.run();
  assert.equal(fixture.published, 1);
  assert.equal(fixture.upgradeVisible.value, true);
  assert.equal(fixture.upgradeHold.value, false);
});

check("Home-owned close releases popup state exactly once", () => {
  const fixture = homeWatcherFixture(true, false, true);
  fixture.callback(false);
  assert.equal(fixture.upgradeVisible.value, false);
  assert.equal(fixture.upgradeInfo.value, null);
  assert.equal(fixture.upgradeHold.value, false);
  assert.equal(fixture.opened, 0);
});

check("cross-page close preserves and retries Home's queued update", () => {
  const fixture = homeWatcherFixture(false, true, true);
  fixture.callback(false);
  assert.equal(fixture.upgradeInfo.value.versionCode, 30);
  assert.equal(fixture.opened, 1);
});

check("cross-page close cannot bypass the notice gate", () => {
  const fixture = homeWatcherFixture(false, true, false);
  fixture.callback(false);
  assert.equal(fixture.upgradeInfo.value.versionCode, 30);
  assert.equal(fixture.upgradeHold.value, true);
  assert.equal(fixture.opened, 0);
});

check("another publisher marks Home's existing pending update as held", () => {
  const fixture = homeWatcherFixture(false, false, true);
  fixture.callback(true);
  assert.equal(fixture.upgradeInfo.value.versionCode, 30);
  assert.equal(fixture.upgradeHold.value, true);
  assert.equal(fixture.opened, 0);
});

function aboutWatcherFixture(initialText) {
  const page = fs.readFileSync(path.join(appRoot, "pages", "about", "index.uvue"), "utf8");
  const source = extractBalanced(page, "watch(appUpdateVisible,", "(", ")");
  const context = {
    appUpdateVisible: { value: false },
    updateText: { value: initialText },
    watch(_ref, callback) { context.callback = callback; },
  };
  vm.runInNewContext(compile(source), context);
  return context;
}

check("About restores its check action after its update popup closes", () => {
  const fixture = aboutWatcherFixture("发现新版本");
  fixture.callback(false);
  assert.equal(fixture.updateText.value, "点击检查");
});

check("About does not reset while the update is still visible", () => {
  const fixture = aboutWatcherFixture("发现新版本");
  fixture.callback(true);
  assert.equal(fixture.updateText.value, "发现新版本");
});

check("a stale close does not erase a newer latest-version result", () => {
  const fixture = aboutWatcherFixture("已是最新版本");
  fixture.callback(false);
  assert.equal(fixture.updateText.value, "已是最新版本");
});

check("frame host keeps real props, events, and page publisher calls", () => {
  const host = fs.readFileSync(path.join(appRoot, "uni_modules", "qt-ui", "components", "qt-app-update-host", "qt-app-update-host.uvue"), "utf8");
  assert.match(host, /<QtUpgradePopup/);
  assert.match(host, /:visible="st\.visible\.value"/);
  assert.match(host, /:info="st\.info\.value"/);
  assert.match(host, /@update:visible="onVisibleChange"/);
  assert.match(host, /@closed="onClosed"/);
  const frame = fs.readFileSync(path.join(appRoot, "uni_modules", "qt-ui", "components", "qt-page-frame", "qt-page-frame.uvue"), "utf8");
  assert.match(frame, /<qt-app-update-host\s*\/>/);
  for (const [page, argument] of [["home", "pending"], ["about", "pending"]]) {
    const body = fs.readFileSync(path.join(appRoot, "pages", page, "index.uvue"), "utf8");
    assert.doesNotMatch(body, /<qt-upgrade-popup[\s>]/);
    assert.match(body, new RegExp("publishAppUpdate\\(\\s*" + argument + "\\s*\\)"));
  }
});

check("host visible and closed callbacks dismiss the global service", () => {
  const file = path.join(appRoot, "uni_modules", "qt-ui", "components", "qt-app-update-host", "qt-app-update-host.uvue");
  const page = fs.readFileSync(file, "utf8");
  const match = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/);
  assert.ok(match, "missing host script setup");
  let dismissals = 0;
  const moduleBox = { exports: {} };
  const context = {
    require(id) {
      if (id === "@/services/app-update") return {
        appUpdateState: () => ({ visible: { value: false }, info: { value: null } }),
        dismissAppUpdate: () => { dismissals++; },
      };
      return {};
    },
    module: moduleBox,
    exports: moduleBox.exports,
  };
  const program = match[1] + "\nglobalThis.hooks = { onVisibleChange, onClosed };";
  vm.runInNewContext("(function(require,module,exports){" + compile(program) + "\n})(require,module,exports)", context);
  context.hooks.onVisibleChange(true);
  assert.equal(dismissals, 0);
  context.hooks.onVisibleChange(false);
  assert.equal(dismissals, 1);
  context.hooks.onClosed();
  assert.equal(dismissals, 2);
});

if (errors.length > 0) {
  console.log("[check-app-update] " + errors.length + " failed, " + passed + " passed");
  process.exitCode = 1;
} else console.log("[check-app-update] " + passed + " checks passed");
