import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { ref, computed, reactive, watch, nextTick } from 'vue';
import { qtHdHomeMetrics } from '../uni_modules/qt-ui/composables/hd-layout.ts';

// Execute production width ownership and frame lifecycle registrations. Only
// the native page stack, lifecycle and window boundary are synthetic; no UI render.
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const runnable = code => stripTypeScriptTypes(code.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*/gm, '').replace(/\bexport\s+/g, ''), { mode: 'strip' });
const frame = read('uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue');
const capStart = frame.indexOf('const paneCapToken =');
const capEnd = frame.indexOf('/**', capStart);
assert.ok(capStart >= 0 && capEnd > capStart, 'frame cap lifecycle block is present');
const capCode = runnable(frame.slice(capStart, capEnd));

const routeStart = frame.indexOf('const currentRoute =');
const routeEnd = frame.indexOf('const selfHeader =', routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'production route resolution is present');
const routeCode = runnable(frame.slice(routeStart, routeEnd));
const railCode = runnable(['workspaceCoversPlayer', 'showRail'].map(name => {
  const declaration = frame.match(new RegExp('const ' + name + ' = computed\\([^\\n]+'))?.[0];
  assert.ok(declaration, 'production ' + name + ' declaration is present');
  return declaration;
}).join('\n'));
function harness() {
  const layout = reactive({ windowWidth: 1120, windowHeight: 640, isWide: true });
  const top = ref('/pages/home/index');
  const getCurrentPages = () => [{ route: top.value.slice(1) }];
  const chrome = runInNewContext(runnable(read('uni_modules/qt-ui/composables/qt-page-chrome.ts')) + '\n({qtIsSettingsRoute,qtIsProfileRoute})', { ref, getCurrentPages });
  const workspace = runInNewContext(runnable(read('uni_modules/qt-ui/composables/qt-wide-workspace.ts')) + '\n({qtWideWorkspace,qtOpenWideTool,qtCloseWideTool,qtPaneOn,qtWideToolActive,qtWideToolRoute,qtWideToolHostRoute,qtIsWideToolHost,qtWideWorkspaceRefresh,qtWideWorkspaceRefreshTick})', {
    ref, reactive, qtLayout: () => layout, qtTopRoute: () => top.value,
  });
  const tool = {
    get value() { return workspace.qtWideToolRoute(); },
    set value(v) { if (v == '') workspace.qtCloseWideTool(); else assert.equal(workspace.qtOpenWideTool(v), true); },
  };
  const widths = runInNewContext(runnable(read('uni_modules/qt-ui/composables/use-qt-widths.ts')) + '\n({qtContentWidth,qtContentWidthRaw,qtContentWidthCap,qtPushContentWidthCap,qtUpdateContentWidthCap,qtClearContentWidthCap})', {
    ref, qtLayout: () => layout, qtRailWidth: () => layout.isWide ? 96 : 0,
  });
  const frames = [];
  function create(route, expectedSplit = false, hosted = '', explicit = true) {
    const hooks = { mount: [], show: [], hide: [], unmount: [] };
    const stops = [];
    const family = chrome.qtIsSettingsRoute(route) || chrome.qtIsProfileRoute(route);
    assert.equal(family, expectedSplit, 'fixture must match the production route family');
    const showSplit = computed(() => layout.isWide && family);
    const paneWidthPx = computed(() => widths.qtContentWidthRaw('flow') - (showSplit.value ? 416 : 0));
    const api = runInNewContext(routeCode + railCode + capCode + '\n({syncPaneCap,paneCapToken,currentRoute,showRail})', {
      ...widths, ...workspace, ref, computed, layout, showSplit, paneWidthPx, hostedRoute: hosted,
      props: explicit ? { current: route } : {}, fullWidth: ref(false), getCurrentPages, qtTopRoute: () => top.value,
      onMounted: fn => hooks.mount.push(fn), onShow: fn => hooks.show.push(fn), onHide: fn => hooks.hide.push(fn),
      onUnmounted: fn => hooks.unmount.push(fn), watch: (...args) => stops.push(watch(...args)),
      frameAlive: true, chipMeasureGeneration: 0, chipMeasureTimer: 0, clearTimeout() {},
    });
    assert.equal(api.currentRoute.value, route, 'actual props/hosted/native stack route resolves this owner');
    const call = hook => { for (const fn of hooks[hook]) fn(); };
    let destroyed = false;
    const owner = { api, hooks, call, destroy() { if (destroyed) return; destroyed = true; call('unmount'); for (const stop of stops) stop(); } };
    frames.push(owner); call('mount');
    return owner;
  }
  return { layout, top, tool, widths, workspace, create, refresh: workspace.qtWideWorkspaceRefresh, destroy() { for (const f of frames) f.destroy(); } };
}

let passed = 0;
const pass = label => { passed++; console.log('PASS ' + label); };
{
  const declaration = frame.match(/const hostedRoute = [^\n]+/)[0];
  const claim = props => runInNewContext(runnable(declaration) + '\nhostedRoute;', {
    props, qtWideToolActive: () => true, qtWideToolRoute: () => '/pages/search/index',
    qtIsWideToolHost: route => ['/pages/home/index', '/pages/profile/index'].includes(route),
    qtTopRoute: () => '/pages/home/index',
  });
  assert.equal(claim({ current: '/pages/profile/index' }), '', 'cold target tab cannot claim the old host tool during switchTab');
  assert.equal(claim({ current: '/pages/home/index' }), '');
  assert.equal(claim({}), '/pages/search/index', 'actual embedded tools still claim their pane');
  pass('new target tab keeps its own frame identity while the old hosted pane awaits success');
}
for (const hostRoute of ['/pages/home/index', '/pages/profile/index']) {
  const h = harness();
  h.top.value = hostRoute;
  const home = h.create(hostRoute, hostRoute === '/pages/profile/index');
  assert.equal(home.api.showRail.value, true);
  h.tool.value = '/pages/daily/index';
  assert.equal(home.api.showRail.value, false, 'covered native fixed rail must unmount, not intercept docked rail gestures');
  const daily = h.create('/pages/daily/index', false, '/pages/daily/index');
  assert.equal(daily.api.showRail.value, false, 'hosted tool has only the workspace-owned rail');
  h.tool.value = '/pages/chart/index';
  assert.equal(home.api.showRail.value, false, 'switching tools must not remount the covered rail');
  h.tool.value = '';
  assert.equal(home.api.showRail.value, true, 'closing workspace restores the host rail');
  h.layout.isWide = false;
  assert.equal(home.api.showRail.value, false, 'compact pages never mount a rail');
  h.layout.isWide = true;
  assert.equal(home.api.showRail.value, true);
  h.destroy();
  pass(hostRoute + ': hosted workspace removes the native underlay rail and restores it on close');
}
{
  const h = harness();
  const home = h.create('/pages/home/index');
  const raw = h.widths.qtContentWidthRaw('grid');
  const homeWidth = computed(() => h.widths.qtContentWidth('grid'));
  const initial = qtHdHomeMetrics(homeWidth.value);
  assert.equal(initial.featureSplit, true);
  const profile = h.create('/pages/profile/index', true);
  assert.equal(homeWidth.value, raw, 'a retained/hidden profile frame must not cap cold-start home');
  assert.equal(qtHdHomeMetrics(homeWidth.value).featureSplit, initial.featureSplit);
  h.top.value = '/pages/profile/index'; home.call('hide'); profile.call('show'); h.refresh(); await nextTick();
  assert.equal(h.widths.qtContentWidthCap(), raw - 416, 'visible profile keeps its third-column cap');
  h.top.value = '/pages/home/index'; profile.call('hide'); home.call('show'); h.refresh(); await nextTick();
  assert.equal(homeWidth.value, raw, 'switchTab reuses home without unmounting profile');
  assert.equal(qtHdHomeMetrics(homeWidth.value).featureSplit, initial.featureSplit);
  h.destroy(); assert.equal(h.widths.qtContentWidthCap(), 0);
  pass('cold-start home / retained profile / switchTab restore the same home geometry');
}
{
  const h = harness();
  const home = h.create('/pages/home/index');
  const raw = h.widths.qtContentWidthRaw('grid');
  h.tool.value = '/pages/settings/index'; h.refresh(); await nextTick();
  const settings = h.create('/pages/settings/index', true, '/pages/settings/index');
  assert.equal(h.widths.qtContentWidthCap(), raw - 416, 'hosted settings must retain its right-pane cap');
  // The native stack is still home, and all component onShow hooks may share its lifecycle.
  home.call('show'); settings.call('show'); await nextTick();
  assert.equal(h.widths.qtContentWidthCap(), raw - 416, 'host onShow must not override its visible tool');
  h.tool.value = ''; h.refresh(); await nextTick();
  assert.equal(h.widths.qtContentWidth('grid'), raw, 'closing the tool releases its cap before component unmount');
  h.layout.windowWidth = 1280; await nextTick();
  assert.equal(h.widths.qtContentWidth('grid'), h.widths.qtContentWidthRaw('grid'), 'hidden resize must not reactivate old settings cap');
  settings.destroy(); home.destroy();
  pass('hosted settings cap follows logical tool visibility, not the native host route');
}
{
  const h = harness();
  h.top.value = '/pages/play-settings/index';
  const settings = h.create('/pages/play-settings/index', true);
  const cap = h.widths.qtContentWidthRaw('flow') - 416;
  assert.equal(h.widths.qtContentWidthCap(), cap);
  h.top.value = '/pages/login/index'; settings.call('hide');
  const login = h.create('/pages/login/index', false, '', false);
  assert.equal(h.widths.qtContentWidthCap(), 0, 'non-family deep page uses its own full content width');
  h.top.value = '/pages/play-settings/index'; login.call('hide'); settings.call('show');
  assert.equal(h.widths.qtContentWidthCap(), cap, 'older mounted settings owner is restored on navigateBack');
  login.destroy();
  assert.equal(h.widths.qtContentWidthCap(), cap, 'late destruction of covered frame cannot clear the restored owner');
  h.layout.isWide = false; h.layout.windowWidth = 390; await nextTick();
  assert.equal(h.widths.qtContentWidthCap(), 0, 'compact layout removes the split cap');
  h.layout.windowWidth = 1120; h.layout.isWide = true; await nextTick();
  assert.equal(h.widths.qtContentWidthCap(), cap, 'wide resize restores the visible settings split');
  settings.destroy();
  pass('navigateBack, non-LIFO unmount and compact/wide resize preserve cap ownership');
}
{
  const h = harness();
  const home = h.create('/pages/home/index');
  const profile = h.create('/pages/profile/index', true);
  const raw = h.widths.qtContentWidthRaw('grid');
  h.tool.value = '/pages/settings/index'; h.refresh(); await nextTick();
  assert.equal(h.workspace.qtPaneOn('/pages/settings/index', '/pages/home/index'), true);
  assert.equal(h.workspace.qtPaneOn('/pages/settings/index', '/pages/profile/index'), false, 'hidden tab must not create a duplicate tool frame');
  for (const [path, wrapper, host] of [['home', 'homePaneOn', '/pages/home/index'], ['profile', 'profilePaneOn', '/pages/profile/index']]) {
    const page = read('pages/' + path + '/index.uvue');
    const fn = page.match(new RegExp('function ' + wrapper + '\\(route: string\\): boolean \\{[\\s\\S]*?\\n\\}'))?.[0];
    assert.ok(fn, 'page binds its explicit host predicate');
    const predicate = runInNewContext(runnable(fn) + '\n' + wrapper, { qtPaneOn: h.workspace.qtPaneOn });
    assert.equal(predicate('/pages/settings/index'), host == '/pages/home/index');
    assert.equal((page.match(new RegExp(wrapper + "\\('/pages/", 'g')) ?? []).length, 8, 'every tool slot uses the host-bound predicate');
  }
  const settings = h.create('/pages/settings/index', true, '/pages/settings/index', false);
  for (const order of [[home, profile, settings], [settings, profile, home]]) {
    for (const owner of order) owner.call('show');
    assert.equal(h.widths.qtContentWidthCap(), raw - 416, 'only the real host tool wins under either lifecycle order');
  }
  const seq = h.workspace.qtWideWorkspace().openSeq;
  h.top.value = '/pages/login/index'; home.call('hide'); settings.call('hide');
  const login = h.create('/pages/login/index', false, '', false); h.refresh(); await nextTick();
  assert.equal(h.workspace.qtPaneOn('/pages/settings/index', '/pages/home/index'), true, 'deep-page navigation preserves the same tool component');
  assert.equal(h.widths.qtContentWidthCap(), 0, 'a covered hosted tool cannot cap the native deep page');
  h.top.value = '/pages/home/index'; login.call('hide'); home.call('show'); settings.call('show'); h.refresh(); await nextTick();
  assert.equal(h.widths.qtContentWidthCap(), raw - 416);
  assert.equal(h.workspace.qtWideWorkspace().openSeq, seq, 'return does not reopen/rebind the tool');
  h.top.value = '/pages/profile/index'; home.call('hide'); settings.call('hide'); profile.call('show'); h.refresh(); await nextTick();
  assert.equal(h.widths.qtContentWidthCap(), raw - 416, 'a lingering tool belonging to home must not suppress visible profile ownership');
  h.tool.value = ''; h.top.value = '/pages/home/index'; profile.call('hide'); home.call('show'); h.refresh(); await nextTick();
  assert.equal(h.widths.qtContentWidth('grid'), raw);
  h.destroy();
  pass('single recorded host, both page slot adapters, deep-page preservation and lifecycle order');
}
{
  const h = harness();
  h.top.value = '/pages/play-settings/index';
  const settings = h.create('/pages/play-settings/index', true, '', false);
  const cap = h.widths.qtContentWidthRaw('flow') - 416;
  h.top.value = '/pages/equalizer/index'; settings.call('hide');
  const equalizer = h.create('/pages/equalizer/index', true, '', false);
  assert.equal(h.widths.qtContentWidthCap(), cap, 'equalizer is a settings-family split page, not an unrestricted page');
  h.top.value = '/pages/play-settings/index'; equalizer.call('hide'); settings.call('show');
  assert.equal(h.widths.qtContentWidthCap(), cap, 'same-width activation transfers ownership');
  equalizer.destroy(); assert.equal(h.widths.qtContentWidthCap(), cap);
  h.destroy();
  pass('real equalizer family and same-width owner activation');
}
{
  const h = harness();
  const w = h.widths;
  let reads = 0;
  const cap = computed(() => { reads++; return w.qtContentWidthCap(); });
  assert.equal(cap.value, 0);
  const a = w.qtPushContentWidthCap(480, false), b = w.qtPushContentWidthCap(480, false);
  assert.equal(cap.value, 0); assert.equal(reads, 1, 'hidden pushes do not broadcast');
  w.qtUpdateContentWidthCap(a, 480, true); assert.equal(cap.value, 480);
  const visibleReads = reads;
  w.qtUpdateContentWidthCap(b, 480, true); assert.equal(cap.value, 480);
  w.qtUpdateContentWidthCap(a, 480, false); assert.equal(cap.value, 480);
  assert.equal(reads, visibleReads, 'same-width active migration does not broadcast');
  w.qtUpdateContentWidthCap(b, 480, false); assert.equal(cap.value, 0);
  const hiddenReads = reads;
  w.qtUpdateContentWidthCap(b, 600, false); w.qtClearContentWidthCap(a);
  assert.equal(cap.value, 0); assert.equal(reads, hiddenReads, 'hidden resize and non-LIFO cleanup do not broadcast');
  w.qtUpdateContentWidthCap(b, 600, true); assert.equal(cap.value, 600, 'show uses the newest hidden width');
  w.qtClearContentWidthCap(b); assert.equal(cap.value, 0);
  pass('inactive width updates and same-value owner migration preserve zero-work notifications');
}
{
  const h = harness();
  const token = h.widths.qtPushContentWidthCap(280);
  h.layout.isWide = false;
  for (const width of [320, 384, 412, 720]) {
    h.layout.windowWidth = width;
    for (const kind of ['form', 'prose', 'flow', 'list', 'detail', 'grid', 'full']) {
      assert.equal(h.widths.qtContentWidthRaw(kind), width, 'compact frame has no wide gutters or kind cap');
      assert.equal(h.widths.qtContentWidth(kind), width, 'old wide-pane cap must not shrink first compact render');
    }
  }
  h.layout.isWide = true; h.layout.windowWidth = 1120;
  assert.equal(h.widths.qtContentWidth('detail'), 280, 'wide pane caps still apply');
  h.widths.qtClearContentWidthCap(token); h.destroy();
  pass('compact first render uses full window before measurement or stale wide owner cleanup');
}
console.log('content width lifecycle: ' + passed + ' production behavior groups passed');
