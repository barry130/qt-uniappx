import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

// Run the public production APIs with synthetic window/timer boundaries only.
// A tiny cached consumer models reactive invalidation; this is not a Vapor build.
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const runnable = source => stripTypeScriptTypes(source.replace(/^import .*;$/gm, '').replace(/\bexport\s+/g, ''), { mode: 'strip' });
function harness() {
  let window = { windowWidth: 400, windowHeight: 800, screenHeight: 800, screenTop: 0, safeAreaInsets: { bottom: 0 } };
  let systemWindow = null, windowUnavailable = false;
  const timers = new Map();
  let timerId = 0, subscriber = null;
  const deps = new Map();
  const reactive = value => new Proxy(value, {
    get(target, key) {
      if (subscriber != null) {
        if (!deps.has(key)) deps.set(key, new Set());
        deps.get(key).add(subscriber);
      }
      return target[key];
    },
    set(target, key, value) {
      if (target[key] !== value) {
        target[key] = value;
        for (const invalidate of deps.get(key) ?? []) invalidate();
      }
      return true;
    },
  });
  const androidLayout = read('uni_modules/qt-ui/composables/use-qt-layout.ts').replace(/\/\/ #ifdef APP-IOS[\s\S]*?\/\/ #endif/g, '');
  const api = runInNewContext(runnable(androidLayout) + '\n({ useQtLayout, refreshQtLayout, qtLayout, qtRpx, qtRailWidth, qtTabBarFloatGapPx, qtTabBarHeightPx, qtPlayerBarHeightPx, pauseQtLayoutWatcher, resumeQtLayoutWatcher, applyQtNativeSafeBottom });', {
    reactive, console: { log() {} },
    uni: { getSystemInfoSync: () => systemWindow ?? window, getWindowInfo: () => {
      if (windowUnavailable) throw new Error('window not attached');
      return window;
    } },
    setInterval: fn => { timers.set(++timerId, fn); return timerId; },
    clearInterval: id => timers.delete(id),
  });
  const cached = get => {
    let dirty = true, value;
    const invalidate = () => { dirty = true; };
    return () => {
      if (dirty) {
        subscriber = invalidate;
        try { value = get(); } finally { subscriber = null; }
        dirty = false;
      }
      return value;
    };
  };
  return { api, cached, timers, setWindow: info => { window = { ...window, ...info }; },
    setSystemWindow: info => { systemWindow = info; }, unavailable: value => { windowUnavailable = value; },
    resize: (width, height) => { window = { ...window, windowWidth: width, windowHeight: height, screenHeight: height }; } };
}
let cases = 0;
const selected = process.argv[2];
function test(name, run) {
  if (selected != null && selected != name) return;
  run(); cases++; console.log('PASS ' + name);
}
test('rpx', () => {
  const h = harness();
  const state = h.api.useQtLayout();
  const row = h.cached(() => h.api.qtRpx(104));
  assert.equal(row(), 104 * 400 / 750);
  h.resize(500, 800); h.api.refreshQtLayout();
  assert.equal(state.isWide, false);
  assert.equal(row(), 104 * 500 / 750, 'same-compact resize must invalidate a cached rpx consumer');
  // Keep native rpx parity: large widths must never be silently capped.
  h.resize(1920, 1080); h.api.refreshQtLayout();
  assert.equal(h.api.qtRpx(750), 1920);
  assert.equal(h.api.qtRailWidth(), 96);
  h.api.pauseQtLayoutWatcher();
});
test('rpx-before-layout', () => {
  const h = harness();
  const row = h.cached(() => h.api.qtRpx(104));
  assert.equal(row(), 104 * 400 / 750, 'pre-initialization fallback still reads the real window');
  h.api.useQtLayout();
  h.resize(500, 800); h.api.refreshQtLayout();
  assert.equal(row(), 104 * 500 / 750, 'an early cached consumer must subscribe before the singleton initializes');
  h.api.pauseQtLayoutWatcher();
});
test('page-resize', () => {
  const h = harness();
  const state = h.api.useQtLayout();
  const page = read('uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue');
  // Exercise the callback registered with the page lifecycle adapter, not a copy.
  const registration = page.match(/if \(hostedRoute\.length == 0\) \{\s*onResize\([\s\S]*?\n\}/)?.[0] ?? '';
  const handlers = [];
  const attach = hostedRoute => runInNewContext(runnable(registration), {
    hostedRoute, onResize: fn => handlers.push(fn), refreshQtLayout: h.api.refreshQtLayout,
  });
  attach(''); attach('/pages/search/index');
  assert.equal(handlers.length, 1, 'only the host frame must register an immediate resize callback');
  h.resize(600, 360); handlers[0]();
  assert.equal(state.windowWidth, 600);
  assert.equal(state.isWide, true, 'resize must update immediately without the polling timer');
  assert.equal(h.timers.size, 1, 'embedded frames must not add polling timers');
  h.api.pauseQtLayoutWatcher(); assert.equal(h.timers.size, 0);
  h.api.resumeQtLayoutWatcher(); assert.equal(h.timers.size, 1);
  h.api.pauseQtLayoutWatcher();
});
test('invalid-window', () => {
  const h = harness();
  const state = h.api.useQtLayout();
  const epoch = state.sizeEpoch;
  for (const [width, height] of [[720, 0], [0, 800], [NaN, 800], [Infinity, 800], [-1, 800]]) {
    h.resize(width, height); h.api.refreshQtLayout();
    assert.equal(state.windowWidth, 400, 'transient invalid sizes must retain the last valid window');
    assert.equal(state.windowHeight, 800);
    assert.equal(state.sizeEpoch, epoch);
    assert.equal(state.isWide, false);
  }
  h.resize(640, 360); h.api.refreshQtLayout();
  assert.equal(state.isWide, true);
  assert.equal(state.sizeClass, 'medium');
  assert.equal(h.api.qtRailWidth(), 64);
  assert.equal(state.sizeEpoch, epoch + 1);
  h.api.refreshQtLayout();
  assert.equal(state.sizeEpoch, epoch + 1, 'unchanged sizes must not rebuild lists');
  h.api.pauseQtLayoutWatcher();
});
test('workspace-resize', () => {
  const h = harness();
  const layout = h.api.useQtLayout();
  h.resize(1000, 700); h.api.refreshQtLayout();
  let top = '/pages/home/index';
  const workspace = runInNewContext(runnable(read('uni_modules/qt-ui/composables/qt-wide-workspace.ts')) + '\n({ qtWideWorkspace, qtOpenWideTool, qtCloseWideTool, qtWideWorkspaceRefreshTick, qtWideWorkspaceRefresh, qtIsWideToolHost, qtWideToolRoute });', {
    reactive: value => value, ref: value => ({ value }), qtTopRoute: () => top, qtLayout: () => layout,
  });
  const ws = workspace.qtWideWorkspace();
  assert.equal(workspace.qtOpenWideTool('/pages/search/index'), true);
  const watchers = [];
  const component = read('uni_modules/qt-ui/components/qt-wide-workspace/qt-wide-workspace.uvue').split('<script setup lang="ts">')[1].split('</script>')[0];
  const view = runInNewContext(runnable(component) + '\n({ stageStyle });', {
    ref: value => ({ value }), onHide: () => {},
    computed: get => ({ get value() { return get(); } }),
    watch: (get, callback) => watchers.push({ get, callback, previous: get() }),
    defineProps: () => ({ hostRoute: '/pages/home/index' }),
    qtWideWorkspace: workspace.qtWideWorkspace, qtCloseWideTool: workspace.qtCloseWideTool,
    qtWideWorkspaceRefreshTick: workspace.qtWideWorkspaceRefreshTick,
    qtTopRoute: () => top, useQtLayout: () => layout,
    useMiniPlayerSettings: () => ({ mode: 'expandable' }),
    useThemeStore: () => ({ skin: { background: '#ffffff' } }), useSourceUpdateStore: () => ({ updatePending: false }),
  });
  const notify = () => {
    for (const w of watchers) {
      const value = w.get();
      if (value != w.previous) { w.callback(value, w.previous); w.previous = value; }
    }
  };
  const sequence = ws.openSeq;
  // The active search component stays mounted: its input/results remain in the same instance.
  h.resize(400, 800); h.api.refreshQtLayout(); notify();
  assert.equal(ws.route, '/pages/search/index', 'rotation must not discard the active tool');
  assert.equal(ws.openSeq, sequence, 'rotation must not reopen/remount the tool');
  assert.ok(!view.stageStyle.value.includes('visibility:hidden'), 'the active tool must remain visible in compact layout');
  assert.equal(workspace.qtOpenWideTool('/pages/chart/index'), false, 'new compact navigation retains the native-page policy');
  top = '/pages/playlist/index'; workspace.qtWideWorkspaceRefresh();
  assert.ok(view.stageStyle.value.includes('visibility:hidden'), 'a deep page must not be covered by the host workspace');
  top = '/pages/home/index'; workspace.qtWideWorkspaceRefresh();
  assert.ok(!view.stageStyle.value.includes('visibility:hidden'));
  h.resize(1000, 700); h.api.refreshQtLayout(); notify();
  assert.equal(ws.route, '/pages/search/index');
  assert.equal(ws.openSeq, sequence);
  // The compact header must close its hosted tool, not switch the underlying tab.
  h.resize(400, 800); h.api.refreshQtLayout(); notify();
  let nativeNavigation = 0;
  const frame = read('uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue');
  const back = frame.match(/function onBack\(\): void \{[\s\S]*?\n\}/)?.[0];
  assert.ok(back, 'the public header-back adapter must exist');
  runInNewContext(runnable(back) + '\nonBack();', {
    hostedRoute: '/pages/search/index', qtTopRoute: () => top,
    qtWideToolRoute: workspace.qtWideToolRoute, qtIsWideToolHost: workspace.qtIsWideToolHost,
    qtCloseWideTool: workspace.qtCloseWideTool, qtPageStackDepth: () => 1,
    qtSwitchTab: () => { nativeNavigation++; }, uni: { navigateBack: () => { nativeNavigation++; } },
  });
  assert.equal(nativeNavigation, 0, 'closing a visible hosted tool must not navigate the native stack');
  assert.equal(ws.route, '');
  assert.equal(workspace.qtCloseWideTool(), false, 'an empty workspace must not consume another back press');
  assert.ok(view.stageStyle.value.includes('visibility:hidden'));
  h.api.pauseQtLayoutWatcher();
});
test('central-breakpoints', () => {
  const h = harness();
  const state = h.api.useQtLayout();
  for (const [width, height, wide, size, rail] of [
    [375, 812, false, 'compact', 0], [599, 360, false, 'compact', 0],
    [600, 900, false, 'medium', 0], [600, 360, true, 'medium', 64],
    [899, 1200, false, 'medium', 0], [899, 520, true, 'medium', 64],
    [900, 1200, true, 'wide', 96], [1279, 900, true, 'wide', 96],
    [1280, 900, true, 'desktop', 96], [1920, 1080, true, 'desktop', 96],
  ]) {
    h.resize(width, height); h.api.refreshQtLayout();
    assert.equal(state.isWide, wide, width + 'x' + height);
    assert.equal(state.sizeClass, size);
    assert.equal(h.api.qtRailWidth(), rail);
    assert.equal(state.isShort, height < 520);
    assert.equal(state.isDesktop, size == 'desktop');
  }
  h.api.pauseQtLayoutWatcher();
});
test('safe-bottom', () => {
  const h = harness();
  const state = h.api.useQtLayout();
  const epoch = state.sizeEpoch;
  h.api.applyQtNativeSafeBottom(42);
  assert.equal(state.safeBottomPx, 42, 'native logical px must not be multiplied by rpx density');
  assert.equal(state.sizeEpoch, epoch, 'safe-area updates are not width/height changes');
  h.resize(1920, 1080); h.api.refreshQtLayout();
  assert.equal(state.safeBottomPx, 42, 'resize must not compound native bottom avoidance');
  h.api.applyQtNativeSafeBottom(-42);
  assert.equal(state.safeBottomPx, 42, 'a signed callback cannot discard the bar while the viewport still reports full height');
  h.setWindow({windowHeight:1038});h.api.refreshQtLayout();
  assert.equal(state.safeBottomPx, 0, 'once the viewport consumes the inset it must not be applied again');
  assert.equal(state.navigationInsetPx,42,'system avoidance must retain the full navigation height for stable tab spacing');
  h.api.pauseQtLayoutWatcher();
});
test('navigation-inset-already-consumed', () => {
  const h = harness();
  const state = h.api.useQtLayout();
  // Vivo V2505A 日志：导航栏42.13逻辑px，页面窗口845→803，原生回调仍报42.13。
  h.setWindow({windowWidth:384,windowHeight:845,screenHeight:845,screenTop:0,safeAreaInsets:{bottom:43}});
  h.api.refreshQtLayout();
  h.api.applyQtNativeSafeBottom(42.13,1);
  assert.equal(state.safeBottomPx,42,'edge-to-edge still needs one complete navigation-bar avoidance');
  h.setWindow({windowHeight:803,safeAreaInsets:{bottom:0}});
  h.api.applyQtNativeSafeBottom(42.13,1);
  assert.equal(state.safeBottomPx,0,'unchanged native reading must recheck the shortened runtime viewport');
  assert.equal(state.navigationKeys,1,'already-inset navigation keys still retain their tab spacing policy');
  h.api.refreshQtLayout();
  assert.equal(state.safeBottomPx,0,'a subsequent window refresh must not restore duplicate bottom padding');

  const computed = get => ({get value(){return get();}});
  const frame = read('uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue');
  const frameBinding = frame.match(/const contentStyle = computed\([\s\S]*?\n\}\);/)[0];
  const frameStyle = runInNewContext(runnable(frameBinding)+'\ncontentStyle;', {
    computed,layout:state,framed:{value:false},fullWidth:{value:false},reservePlayerBar:{value:false},
  });
  const sheet = read('uni_modules/qt-ui/components/qt-sheet/qt-sheet.uvue');
  const sheetBinding = sheet.match(/const panelStyle = computed\([\s\S]*?\n\}\);/)[0];
  const panelStyle = runInNewContext(runnable(sheetBinding)+'\npanelStyle;', {
    computed,layout:state,qtSheetWidth:()=>420,theme:{skin:{sheetSurface:'#fff'}},
  });
  assert.equal(frameStyle.value,'padding-bottom:0px;','settings content must reach the already-safe bottom');
  assert.ok(panelStyle.value.endsWith('padding-bottom:4.096px;'),'cancel footer retains only the ordinary small sheet padding');

  h.setWindow({windowHeight:824}); h.api.refreshQtLayout();
  assert.equal(state.safeBottomPx,21,'partial system avoidance needs only the uncovered remainder');
  h.setWindow({windowHeight:845}); h.api.refreshQtLayout();
  assert.equal(state.safeBottomPx,42,'returning to an overlapping viewport restores avoidance');
  assert.equal(frameStyle.value,'padding-bottom:42px;');
  assert.ok(panelStyle.value.endsWith('padding-bottom:42px;'),'edge-to-edge cancel remains above navigation keys');
  h.setWindow({windowHeight:804,screenTop:41}); h.api.refreshQtLayout();
  assert.equal(state.safeBottomPx,42,'a top status bar alone must not count as bottom avoidance');
  h.setWindow({windowHeight:762}); h.api.refreshQtLayout();
  assert.equal(state.safeBottomPx,0,'top and bottom system insets are accounted for separately');
  h.setWindow({windowHeight:845,screenTop:0}); h.api.refreshQtLayout();
  h.api.applyQtNativeSafeBottom(0,0);
  assert.equal(state.safeBottomPx,0,'gesture mode with no overlap does not invent a bottom spacer');
  h.api.applyQtNativeSafeBottom(24,0);
  assert.equal(state.safeBottomPx,24,'visible edge-to-edge gesture indicator remains protected');
  h.setWindow({windowHeight:821}); h.api.refreshQtLayout();
  assert.equal(state.safeBottomPx,0,'already-reserved gesture indicator is not reserved a second time');
  h.setWindow({windowHeight:0}); h.api.applyQtNativeSafeBottom(24,0);
  assert.equal(state.safeBottomPx,0,'unsettled window geometry preserves previously confirmed avoidance');
  h.api.pauseQtLayoutWatcher();
});
test('page-entry-inset-stability', () => {
  const h = harness();
  h.setWindow({windowWidth:384,windowHeight:845,screenHeight:845,screenTop:0,safeAreaInsets:{bottom:43}});
  const state = h.api.useQtLayout();
  h.api.applyQtNativeSafeBottom(42.13,1);
  const dock = runInNewContext(runnable(read('uni_modules/qt-ui/composables/mini-player-layout.ts')) + '\n({qtMiniDockTopPx,qtMiniDockBarHeightPx,qtMiniDockBottomPx})', {
    ...h.api,fontScale:{scale:1},
  });
  const computed = get => ({ get value(){return get();} });
  const miniSource = read('uni_modules/qt-ui/components/qt-mini-player/qt-mini-player.uvue');
  const hostBinding = miniSource.match(/const hostStyle = computed\([\s\S]*?\n\}\);/)[0];
  const host = runInNewContext(runnable(hostBinding)+'\nhostStyle;', {
    ...h.api,...dock,computed,isDocked:{value:true},props:{aboveTab:false},
    renderWidth:{get value(){return state.windowWidth-h.api.qtRpx(48);}},
    renderHeight:{get value(){return dock.qtMiniDockBarHeightPx();}},
  });
  const originalTop = dock.qtMiniDockTopPx(false);
  const top = () => Number(host.value.match(/(?:^|;)top:([\d.]+)px;/)[1]);
  assert.equal(top(),originalTop);
  assert.ok(host.value.includes('bottom:auto;'),'the native root must not subtract a stale bottom inset independently');

  // Root has already shortened to803 before the JS snapshot catches up. A bottom:50
  // anchor would jump up42px here; the old complete height/inset pair keeps the top.
  h.setWindow({windowHeight:803,safeAreaInsets:{bottom:0}});
  assert.equal(top(),originalTop,'new Activity first frame uses the last complete safe-edge coordinate');
  h.setSystemWindow({windowWidth:384,windowHeight:845});
  h.api.refreshQtLayout();
  assert.equal(state.windowHeight,803,'do not mix stale getSystemInfoSync dimensions with new window insets');
  assert.equal(state.safeBottomPx,0);
  assert.equal(top(),originalTop,'height and inset changes cancel without moving the playback row');
  const epoch = state.sizeEpoch;
  for (const invalid of [{windowWidth:0},{windowHeight:0},{windowHeight:NaN}]) {
    h.setWindow({windowWidth:384,windowHeight:803,...invalid});
    h.api.applyQtNativeSafeBottom(42.13,1); h.api.refreshQtLayout();
    assert.equal(top(),originalTop,'invalid page-mount samples cannot restore full navigation padding');
    assert.equal(state.safeBottomPx,0); assert.equal(state.sizeEpoch,epoch);
  }
  h.unavailable(true); h.api.applyQtNativeSafeBottom(42.13,1); h.api.refreshQtLayout();
  assert.equal(top(),originalTop,'temporary query failure retains the complete snapshot');
  h.unavailable(false);
  for (const height of [845,803,845,803]) {
    h.setWindow({windowWidth:384,windowHeight:height});
    h.api.applyQtNativeSafeBottom(42.13,1);
    assert.equal(top(),originalTop,'native callback alone publishes both dimensions and avoidance');
  }
  h.setWindow({windowWidth:900,windowHeight:450,screenHeight:492}); h.api.refreshQtLayout();
  assert.equal(state.isWide,true); assert.equal(state.safeBottomPx,0,'real orientation changes still publish immediately');
  h.setWindow({windowWidth:384,windowHeight:845,screenHeight:845});
  h.api.applyQtNativeSafeBottom(0,0);
  assert.equal(state.windowHeight,845); assert.equal(state.navigationKeys,0);
  assert.equal(dock.qtMiniDockTopPx(false),originalTop+42,'removing system keys genuinely releases their height');
  h.api.pauseQtLayoutWatcher();
});
test('native-unknown-inset', () => {
  const source = read('services/app-native.uts');
  const adapter = source.match(/export function readBottomNavInset\([\s\S]*?\n\}/)[0];
  const outputs = [];
  let sample = [42,1];
  const api = runInNewContext(runnable(adapter)+'\nreadBottomNavInset;', {
    readBottomNavInsetNative: callback => callback(...sample),devicePxToLogical: px => px,logErrV(){},
  });
  for (sample of [[42,1],[0,-1],[-42,1],[0,0]]) api((...value)=>outputs.push(value));
  assert.deepEqual(outputs,[[42,1],[-42,1],[0,0]],'unknown Android Activity insets must not overwrite a known bottom with zero');
});
test('frame-and-dock-inset-handoff', () => {
  const h = harness();
  h.setWindow({windowWidth:384,windowHeight:845,screenHeight:845,screenTop:0,safeAreaInsets:{bottom:43}});
  const state = h.api.useQtLayout();
  h.api.applyQtNativeSafeBottom(42.13,1);
  const computed = get => ({get value(){return get();}});
  const dock = runInNewContext(runnable(read('uni_modules/qt-ui/composables/mini-player-layout.ts')) + '\n({qtMiniDockTopPx,qtMiniDockReservePx,qtMiniDockBarHeightPx})', {
    ...h.api,fontScale:{scale:1},
  });
  const source = read('uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue');
  const declarations = ['shellStyle','contentStyle','dockSurfaceStyle'].map(name => source.match(new RegExp('const '+name+' = computed\\([\\s\\S]*?\\n\\}\\);'))[0]).join('\n');
  const hasBottomTab = {value:false}, reservePlayerBar = {value:true};
  const frame = runInNewContext(runnable(declarations)+'\n({shellStyle,contentStyle,dockSurfaceStyle});', {
    ...h.api,...dock,computed,layout:state,hasBottomTab,reservePlayerBar,selfHeader:{value:false},framed:{value:false},fullWidth:{value:false},
    qtStatusBarPx:()=>41,theme:{skin:{surface:'#fff',border:'#ddd'}},
  });
  const px = (style,key) => Number(style.match(new RegExp('(?:^|;)'+key+':([\\d.]+)px;'))?.[1] ?? 0);
  const tabSource=read('uni_modules/qt-ui/components/qt-tab-bar/qt-tab-bar.uvue');
  const tabBinding=tabSource.match(/const positionStyle = computed\([\s\S]*?\n\}\);/)[0];
  const tabProps={frameDock:true,joined:true};
  const tab=runInNewContext(runnable(tabBinding)+'\npositionStyle;',{...h.api,computed,props:tabProps,layout:state});
  const barSource=read('uni_modules/qt-ui/components/qt-player-bar/qt-player-bar.uvue');
  const barBinding=barSource.match(/const barStyle = computed\([\s\S]*?\n\}\);/)[0];
  const bar=runInNewContext(runnable(barBinding)+'\nbarStyle;',{...h.api,computed,props:{docked:true},layout:state,theme:{skin:{}}});
  // Native parent bounds can change BEFORE JS has a new snapshot. Exercise the
  // actual frame bindings: a flex shell inherits those bounds, an explicit
  // non-shrinking shell retains the coherent window-height/padding pair.
  const contentBottom = nativeHeight => {
    const shell = frame.shellStyle.value;
    const height = /flex:none;/.test(shell) ? px(shell,'height') : nativeHeight;
    return height - px(frame.contentStyle.value,'padding-bottom');
  };
  const initialTop = dock.qtMiniDockTopPx(false);
  assert.equal(contentBottom(845),initialTop);
  h.setWindow({windowHeight:803,safeAreaInsets:{bottom:0}});
  assert.equal(contentBottom(803),initialTop,'native root shrinking before JS must not create the reported 42px blank band');
  h.api.refreshQtLayout();
  assert.equal(contentBottom(803),initialTop);

  for (const aboveTab of [false,true]) {
    hasBottomTab.value = aboveTab;
    const stableTop = dock.qtMiniDockTopPx(aboveTab);
    // A negative callback describes system avoidance, not removal of the bar.
    // Exercise either order of raw sign and viewport-size publication.
    for (const [height,raw] of [[845,-42.13],[803,-42.13],[845,42.13],[803,42.13]]) {
      h.setWindow({windowHeight:height});
      h.api.applyQtNativeSafeBottom(raw,1);
      assert.equal(dock.qtMiniDockTopPx(aboveTab),stableTop,'page handoff must not shift standalone or joined controls');
      assert.equal(contentBottom(height),stableTop,'list and playback row must share the same safe edge');
      if (aboveTab) {
        assert.equal(px(frame.dockSurfaceStyle.value,'top'),stableTop,'joined background stays attached to its controls');
        assert.ok(Math.abs(px(tab.value,'top')-stableTop-dock.qtMiniDockBarHeightPx())<1e-9,'tab stays joined to the playback row across root changes');
      }
    }
  }
  hasBottomTab.value=false;
  reservePlayerBar.value=false;
  assert.equal(contentBottom(803),803,'floating mode / empty queue only reserves system avoidance');
  h.setWindow({windowHeight:845});h.api.refreshQtLayout();
  assert.equal(contentBottom(803),803,'no dock still uses a coherent safe bottom');
  reservePlayerBar.value=true;
  h.setWindow({windowHeight:503});h.api.refreshQtLayout();
  assert.equal(contentBottom(503),503-dock.qtMiniDockBarHeightPx()-h.api.qtRpx(16),'keyboard resize is applied immediately');

  h.setWindow({windowWidth:900,windowHeight:450,screenHeight:492});h.api.refreshQtLayout();
  const wideTop=dock.qtMiniDockTopPx(false);
  assert.equal(contentBottom(450),wideTop,'wide and hosted content use the same dock budget');
  assert.equal(px(bar.value,'top'),wideTop);
  h.setWindow({windowHeight:492});h.api.applyQtNativeSafeBottom(-42.13,1);
  assert.equal(contentBottom(450),wideTop,'wide system-inset/e2e handoff is stable too');
  assert.equal(px(bar.value,'top'),wideTop,'wide playback controls do not inherit a second native bottom reduction');
  h.setWindow({windowWidth:384,windowHeight:845,screenHeight:845});h.api.applyQtNativeSafeBottom(0,0);
  assert.equal(contentBottom(845),845-dock.qtMiniDockBarHeightPx()-h.api.qtRpx(16),'genuine removal of navigation keys releases space');
  h.api.pauseQtLayoutWatcher();
});
test('immersive-player-inset-handoff', () => {
  const h = harness();
  h.setWindow({windowWidth:384,windowHeight:845,screenHeight:845,screenTop:0,safeAreaInsets:{bottom:43}});
  const layout = h.api.useQtLayout();
  h.api.applyQtNativeSafeBottom(42.13,1);
  const computed = get => ({get value(){return get();}});
  const frameSource = read('uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue');
  const playerSource = read('pages/player/index.uvue');
  const declarations = ['shellStyle','contentStyle'].map(name => frameSource.match(new RegExp('const '+name+' = computed\\([\\s\\S]*?\\n\\}\\);'))[0]).join('\n');
  const frame = runInNewContext(runnable(declarations)+'\n({shellStyle,contentStyle});', {
    computed,layout,fullWidth:{value:true},reservePlayerBar:{value:false},framed:{value:false},
    // During native navigation the old route may still identify a page with a frame header.
    selfHeader:{value:false},qtStatusBarPx:()=>41,
  });
  const stageBinding = playerSource.match(/const portraitStageStyle = computed\([^\n]+/)[0];
  const stage = runInNewContext(runnable(stageBinding)+'\nportraitStageStyle;', {computed,layout});
  const metrics = runInNewContext(runnable(read('uni_modules/qt-ui/composables/player-presentation.ts'))+'\n({portraitPlayerMetrics,widePlayerMetrics});');
  const px = (style,key) => Number(style.match(new RegExp('(?:^|;)'+key+':([\\d.]+)px;'))?.[1] ?? 0);
  const stageBottom = nativeHeight => {
    const shell = frame.shellStyle.value;
    const shellHeight = shell.includes('flex:none;') ? px(shell,'height') : nativeHeight;
    return shellHeight - px(frame.contentStyle.value,'padding-bottom') - px(stage.value,'margin-bottom');
  };
  const verifyPortrait = nativeHeight => {
    const safeEdge = layout.windowHeight - layout.safeBottomPx;
    assert.equal(stageBottom(nativeHeight),safeEdge,'frame and player must consume the navigation inset once, not crop the last tools row');
    const unit = layout.windowWidth / 750;
    for (const scale of [0.85,1,1.15,1.3,1.5]) {
      const m = metrics.portraitPlayerMetrics(layout.windowWidth,layout.windowHeight,41,layout.safeBottomPx,scale);
      assert.ok(Math.abs((m.discRpx+m.reservedRpx)*unit-stageBottom(nativeHeight))<0.001,'classic/gallery geometry must fit the actual parent, not just an independent height estimate');
      const bottomPadding = 28 * unit;
      const toolsBottom = (m.discRpx+m.reservedRpx)*unit-bottomPadding;
      assert.ok(toolsBottom<=Math.min(stageBottom(nativeHeight),nativeHeight),'the complete bottom toolbar must remain above the native clipping edge');
    }
  };
  assert.match(playerSource, /<qt-page-frame :full-width="true">/);
  verifyPortrait(845);
  h.setWindow({windowHeight:803,safeAreaInsets:{bottom:0}});
  verifyPortrait(803); // Native root changes first, shared snapshot is still845/42.
  h.api.refreshQtLayout(); verifyPortrait(803);
  for (const [height,raw] of [[845,-42.13],[803,-42.13],[845,42.13],[803,42.13]]) {
    h.setWindow({windowHeight:height});h.api.applyQtNativeSafeBottom(raw,1);
    verifyPortrait(803);
    assert.equal(stageBottom(803),803,'equivalent full/inset windows cannot move or obscure player controls');
  }
  h.setWindow({windowHeight:845});h.api.applyQtNativeSafeBottom(24,0);verifyPortrait(845);
  h.api.applyQtNativeSafeBottom(0,0);verifyPortrait(845);
  h.setWindow({windowWidth:900,windowHeight:492,screenHeight:492});h.api.applyQtNativeSafeBottom(42,1);
  const wideBottom = () => {
    const m = metrics.widePlayerMetrics(900,layout.windowHeight,41,layout.safeBottomPx,true,7,1);
    return px(frame.shellStyle.value,'height')-px(frame.shellStyle.value,'padding-top')-px(frame.contentStyle.value,'padding-bottom')-m.padBottomPx;
  };
  assert.equal(wideBottom(),442,'immersive frame cannot also inset the player header during route handoff');
  h.setWindow({windowHeight:450});h.api.refreshQtLayout();
  assert.equal(wideBottom(),442,'wide controls stay stable as system navigation becomes inset');
  h.api.pauseQtLayoutWatcher();
});
test('docked-controls-never-inherit-snap-animation',()=>{
  const source=read('uni_modules/qt-ui/components/qt-mini-player/qt-mini-player.uvue');
  const binding=source.match(/const containerStyle = computed\([\s\S]*?\n\}\);/)[0];
  const isDocked={value:true},miniEdgeAnimating={value:true};
  const style=runInNewContext(runnable(binding)+'\ncontainerStyle;',{
    computed:get=>({get value(){return get();}}),renderWidth:{value:360},renderHeight:{value:56},
    isDocked,miniEdgeAnimating,joinedDock:{value:false},qtRpx:n=>n/2,
  });
  assert.ok(!style.value.includes('transition:'),'fixed playback controls must not animate after a floating-mode snap');
  isDocked.value=false;
  assert.ok(style.value.includes('transition:'),'floating drag/snap animation remains available');
});
test('app-keeps-signed-navigation-height', () => {
  const source=read('App.uvue');
  const callback=source.match(/function refreshBottomNavInset\(\): void \{[\s\S]*?\n\}/)[0];
  let sample=[-42.13,1];
  const received=[];
  const refresh=runInNewContext(runnable(callback)+'\nrefreshBottomNavInset;',{
    readBottomNavInset:fn=>fn(...sample),describeBottomNavInset:()=>'',loggedBottomNavDiag:'',logLine(){},LOG_INFO:0,
    applyQtNativeSafeBottom:(...args)=>received.push(args),
  });
  for(sample of [[-42.13,1],[42.13,1],[0,0]])refresh();
  assert.deepEqual(received,[[-42.13,1],[42.13,1],[0,0]],'App must not discard navigation height before reconciling it with the viewport');
});
console.log('responsive layout: ' + cases + ' public behavior cases passed');
