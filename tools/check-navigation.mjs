import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
function runnable(source, harmony) {
  const enabled = [true];
  source = source.split('\n').filter(line => {
    const begin = line.match(/^\s*\/\/\s*#(ifdef|ifndef)\s+(APP-HARMONY)/);
    if (begin) { enabled.push(enabled.at(-1) && (begin[1] === 'ifdef' ? harmony : !harmony)); return false; }
    if (/^\s*\/\/\s*#endif/.test(line)) { enabled.pop(); return false; }
    return enabled.at(-1);
  }).join('\n');
  return stripTypeScriptTypes(source.replace(/^import[\s\S]*?from\s*["'][^"']+["'];?\s*/gm, '').replace(/\bexport\s+/g, ''), { mode: 'strip' });
}
function harness({ wide = false, harmony = false } = {}) {
  let pages = ['/pages/home/index'], timerId = 0;
  const calls = [], timers = new Map(), interceptors = new Map();
  const scope = {
    reactive: value => value, ref: value => ({ value }),
    qtLayout: () => ({ isWide: wide }), qtTopRoute: () => pages.at(-1),
    getCurrentPages: () => pages.map(route => ({ route: route.slice(1) })),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    uni: {
      addInterceptor(kind, interceptor) {
        const list = interceptors.get(kind) ?? [];
        list.push(interceptor); interceptors.set(kind, list);
      },
      ...Object.fromEntries(['switchTab', 'reLaunch', 'navigateTo', 'navigateBack'].map(kind => [kind, (options = {}) => {
        // Like the runtime: normalize absent options, then invoke hooks before dispatch.
        const args = { ...options };
        for (const interceptor of interceptors.get(kind) ?? []) interceptor.invoke?.(args);
        calls.push({ kind, ...args });
      }])),
    },
  };
  const motion = runInNewContext(runnable(read('uni_modules/qt-ui/composables/qt-navigation-motion.ts'), harmony) + '\n({installQtNavigationMotion});', scope);
  motion.installQtNavigationMotion();
  Object.assign(scope, runInNewContext(runnable(read('uni_modules/qt-ui/composables/qt-wide-workspace.ts'), harmony) + '\n({qtOpenWideTool,qtCloseWideTool,qtIsWideToolHost,qtWideWorkspace,qtWideWorkspaceRefresh,qtWideToolActive});', scope));
  const api = runInNewContext(runnable(read('uni_modules/qt-ui/composables/qt-nav.ts'), harmony) + '\n({qtSwitchTab,qtRailSwitchTab,qtRailNavigate,qtNavigateBack});', scope);
  return { api, calls, timers, motion, interceptors, ws: scope.qtWideWorkspace(), scope,
    stack: routes => { pages = routes; }, top: () => pages.at(-1),
    succeed(call = calls.at(-1)) {
      if (call.kind === 'navigateBack') pages = pages.slice(0, Math.max(1, pages.length - (call.delta ?? 1)));
      else if (call.kind === 'navigateTo') pages.push(call.url);
      else pages = [call.url];
      call.success?.({});
    },
  };
}
const home = '/pages/home/index', profile = '/pages/profile/index', radio = '/pages/radio/index';
let count = 0;
function test(name, run) { run(); console.log('PASS navigation: ' + name); count++; }

test('global motion policy covers direct entry and all back paths without changing payloads', () => {
  for (const wide of [false, true]) {
    const h = harness({ wide });
    h.motion.installQtNavigationMotion();
    assert.equal(h.interceptors.get('navigateTo').length, 1, 'repeated startup must not duplicate hooks');
    assert.equal(h.interceptors.get('navigateBack').length, 1);
    let receipt = 0;
    const events = { selected() {} }, success = () => receipt++;
    h.scope.uni.navigateTo({ url: '/pages/playlist/index?id=a%2Fb', events, success, animationType: 'slide-in-right' });
    assert.equal(h.calls[0].animationType, 'none');
    assert.equal(h.calls[0].url, '/pages/playlist/index?id=a%2Fb');
    assert.equal(h.calls[0].events, events);
    h.succeed(); assert.equal(receipt, 1);
    h.scope.uni.navigateBack();
    assert.equal(h.calls.at(-1).animationType, 'none', 'no-argument business back is covered');
    h.scope.uni.navigateBack({ delta: 2, from: 'backbutton', animationType: 'slide-out-right', success });
    assert.equal(h.calls.at(-1).animationType, 'none');
    assert.equal(h.calls.at(-1).delta, 2);
    assert.equal(h.calls.at(-1).from, 'backbutton', 'page back guards must retain the system source');
    assert.equal(h.calls.at(-1).success, success);
    h.api.qtNavigateBack();
    assert.equal(h.calls.at(-1).animationType, 'none');
  }
});
test('portrait tool entry and wide native fallback both dispatch without sliding', () => {
  for (const wide of [false, true]) {
    const h = harness({ wide });
    h.stack(['/pages/playlist/index']); // No wide host: must take the native fallback.
    h.api.qtRailNavigate(radio);
    assert.equal(h.calls[0].kind, 'navigateTo');
    assert.equal(h.calls[0].animationType, 'none');
    h.succeed();
    h.api.qtRailNavigate('/pages/playlist/index');
    assert.equal(h.calls.at(-1).kind, 'navigateBack');
    assert.equal(h.calls.at(-1).animationType, 'none');
    h.succeed();
    h.api.qtSwitchTab(home);
    assert.equal(h.calls.at(-1).kind, 'switchTab');
    assert.equal(h.calls.at(-1).animationType, undefined, 'tab API does not accept motion parameters');
  }
});

test('portrait repeated taps coalesce to the last destination', () => {
  const h = harness();
  h.api.qtSwitchTab(profile);
  h.api.qtSwitchTab(profile);
  h.api.qtSwitchTab(home);
  assert.equal(h.calls.length, 1, 'one native tab switch may be in flight');
  h.succeed(h.calls[0]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].url, home);
  h.succeed();
  h.calls[0].fail?.({}); // A late receipt cannot relaunch the old destination.
  assert.equal(h.calls.length, 2);
  assert.equal(h.top(), home);
  assert.equal(h.timers.size, 0);
});
test('rapid final tap on the in-flight target cancels an intermediate intent', () => {
  const h = harness();
  h.api.qtSwitchTab(profile); h.api.qtSwitchTab(home); h.api.qtSwitchTab(profile);
  h.succeed();
  assert.equal(h.calls.length, 1);
  assert.equal(h.top(), profile);
});
test('tab view delegates even its rendered current item while navigation is pending', () => {
  const h = harness();
  const source = read('uni_modules/qt-ui/components/qt-tab-bar/qt-tab-bar.uvue');
  const handler = source.match(/function go\(path: string\): void \{[\s\S]*?\n\}/)[0];
  const go = runInNewContext(runnable(handler, false) + '\ngo;', { qtSwitchTab: h.api.qtSwitchTab, active: path => path === home.slice(1) });
  go(profile.slice(1)); go(home.slice(1)); h.succeed();
  assert.equal(h.calls.at(-1).url, home, 'old page props cannot swallow a newer Home intent');
  h.succeed();
});
test('hosted pane remains until target tab succeeds; no delayed redirect', () => {
  const h = harness({ wide: true });
  h.scope.qtOpenWideTool(radio);
  h.api.qtRailSwitchTab(profile);
  assert.equal(h.ws.route, radio, 'the old host must not be exposed before the switch');
  h.succeed();
  assert.equal(h.ws.route, '');
  h.api.qtRailNavigate('/pages/chart/index');
  assert.equal(h.ws.route, '/pages/chart/index');
  for (const fn of [...h.timers.values()]) fn();
  assert.equal(h.calls.length, 1, 'completed tab must never redirect a later tool click');
  assert.equal(h.ws.route, '/pages/chart/index');
});
test('deep native stack targets the requested tab without first showing its root', () => {
  for (const wide of [false, true]) {
    const h = harness({ wide });
    h.stack([home, '/pages/search/index', '/pages/playlist/index']);
    h.api.qtRailSwitchTab(profile);
    assert.deepEqual(h.calls.map(call => call.kind), ['switchTab']);
    assert.equal(h.calls[0].url, profile);
    h.succeed();
  }
});
test('failed superseded tab never relaunches its stale destination', () => {
  const h = harness();
  h.api.qtSwitchTab(profile); h.api.qtSwitchTab(home);
  h.calls[0].fail({});
  assert.equal(h.calls.length, 1);
  h.api.qtSwitchTab(profile);
  h.calls[1].fail({});
  assert.equal(h.calls[2].kind, 'reLaunch');
  h.calls[2].fail({});
  h.api.qtSwitchTab(profile);
  assert.equal(h.calls.length, 4, 'terminal failure releases the gate');
  h.succeed();
});
test('tool and tab intents share the same native-navigation gate', () => {
  const h = harness();
  h.api.qtRailNavigate(radio);
  h.api.qtSwitchTab(profile);
  assert.equal(h.calls.length, 1);
  h.succeed();
  assert.equal(h.calls.at(-1).url, profile);
  h.succeed();
  assert.equal(h.top(), profile);
});
test('a missing receipt releases the gate without replaying the expired request', () => {
  const h = harness({ wide: true });
  h.scope.qtOpenWideTool(radio);
  h.api.qtSwitchTab(profile);
  h.api.qtSwitchTab(profile); // A duplicate tap must not become an automatic timeout retry.
  const expired = h.calls[0];
  [...h.timers.values()][0]();
  assert.equal(h.calls.length, 1, 'watchdog never retries an obsolete target');
  h.api.qtRailNavigate('/pages/chart/index');
  expired.success?.({}); expired.fail?.({});
  assert.equal(h.ws.route, '/pages/chart/index', 'late receipt cannot close the newer pane');
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});
test('superseded wide unwind does not open the old tool after returning to host', () => {
  const h = harness({ wide: true });
  h.stack([home, '/pages/playlist/index']);
  h.api.qtRailNavigate(radio); h.api.qtSwitchTab(profile);
  h.succeed(h.calls[0]);
  assert.equal(h.ws.route, '');
  assert.equal(h.calls.at(-1).url, profile);
  h.succeed(); assert.equal(h.top(), profile);
});
test('no-op host close and Harmony relaunch retain their contracts', () => {
  const h = harness({ wide: true });
  h.scope.qtOpenWideTool(radio); h.api.qtRailSwitchTab(home);
  assert.equal(h.ws.route, ''); assert.equal(h.calls.length, 0);
  const hm = harness({ harmony: true });
  hm.api.qtSwitchTab(profile); hm.api.qtSwitchTab(home);
  assert.deepEqual(hm.calls.map(call => call.kind), ['reLaunch']);
  hm.succeed(); hm.succeed(); assert.equal(hm.top(), home);
});
console.log(`navigation: ${count} cases passed`);
