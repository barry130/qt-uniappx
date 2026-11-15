import { qtSafePane } from '../uni_modules/qt-ui/composables/fold-geometry.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { reactive, ref, computed, watch, nextTick } from 'vue';
import { tvScriptFixture } from './tv-script-fixture.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const code = source => stripTypeScriptTypes(source.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*/gm, '').replace(/\bexport\s+/g, ''), {mode:'strip'});
const storage = new Map();
const uni = { getStorageSync:key=>storage.get(key) ?? '', setStorageSync:(key,value)=>storage.set(key,value) };
const loadSettings = () => runInNewContext(code(read('uni_modules/qt-ui/stores/mini-player.ts')) + '\n({useMiniPlayerSettings,setMiniPlayerMode})', {reactive,uni,logWarn(){}});
const preferences = loadSettings();
assert.equal(preferences.useMiniPlayerSettings().mode, 'expandable');
for (const mode of ['expandable','ball','bar','docked']) {
  preferences.setMiniPlayerMode(mode);
  assert.equal(loadSettings().useMiniPlayerSettings().mode, mode, 'restart restores mode');
}
preferences.setMiniPlayerMode('invalid');
assert.equal(preferences.useMiniPlayerSettings().mode, 'expandable');
storage.set('qt-mini-player-mode','obsolete-mode');
assert.equal(loadSettings().useMiniPlayerSettings().mode,'expandable','invalid saved value falls back safely');

const layout = reactive({windowWidth:390,windowHeight:844,isWide:false,safeBottomPx:20,paneLeft:0,paneTop:0,get paneWidth(){return this.windowWidth;},get paneHeight(){return this.windowHeight;}});
const settings = preferences.useMiniPlayerSettings();
const timers = new Map(); let timerId = 0;
const runTimers = () => {const work=[...timers.values()];timers.clear();work.forEach(fn=>fn());};
const mini = runInNewContext(code(read('uni_modules/qt-ui/services/mini-player-singleton.ts')) + '\n({miniPlayerMount,miniPlayerUnmount,miniExpanded,miniFabX,miniFabY,miniEdgeSide,miniCurrentWidth,miniCurrentHeight,miniExpandFromFab,miniCollapse,miniSnapToNearestEdge,miniSyncRenderSize})', {
  qtPerformance:{reduceMotion:false,expensiveEffects:true},qtMiniStripHeightPx:()=>layout.isWide?56:112*layout.windowWidth/750,reactive,ref,computed,watch,useMiniPlayerSettings:()=>settings,qtLayout:()=>layout,qtRpx:n=>n*layout.windowWidth/750,
  qtRailWidth:()=>layout.isWide?(layout.windowWidth>=900?96:64):0,
  uni:{...uni,getWindowInfo:()=>layout},logWarn(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},
  setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
});
const id = mini.miniPlayerMount();
const source = read('uni_modules/qt-ui/components/qt-mini-player/qt-mini-player.uvue');
const click = source.slice(source.indexOf('function onContainerClick()'),source.indexOf('function togglePlayback()'));
let opened=0;
const actions = runInNewContext(code('let moved=false;\n'+click)+'\n({onContainerClick,dragged:()=>{moved=true;}})', {settings,miniExpanded:mini.miniExpanded,miniExpandFromFab:mini.miniExpandFromFab,openPlayer:()=>{opened++;mini.miniCollapse();}});
for (const [width,height] of [[390,844],[640,360],[1280,800],[720,1280]]) {
  layout.windowWidth=width;layout.windowHeight=height;layout.isWide=width>=900||(width>=600&&width>height);
  await nextTick();runTimers();
  for (const mode of ['expandable','ball','bar','docked']) {
    preferences.setMiniPlayerMode(mode);await nextTick();runTimers();
    const before=opened;
    actions.onContainerClick();
    if(mode==='expandable') {
      assert.equal(opened,before,'first tap expands only');assert.equal(mini.miniExpanded.value,true);
      actions.onContainerClick();assert.equal(opened,before+1);assert.equal(mini.miniExpanded.value,false);
    } else assert.equal(opened,before+1,'one tap opens in direct modes');
    if(mode==='bar') {mini.miniCollapse();assert.equal(mini.miniExpanded.value,true,'outside click and navigation cannot collapse permanent strip');}
    actions.dragged();actions.onContainerClick();assert.equal(opened,before+1,'drag release must not navigate');
    if(mode!=='docked') {
      mini.miniFabX.value=width;mini.miniFabY.value=height;mini.miniSnapToNearestEdge();runTimers();
      assert.equal(mini.miniFabX.value+mini.miniCurrentWidth.value,width,'right snap includes full strip width');
      assert.ok(mini.miniFabY.value+mini.miniCurrentHeight.value<=height-layout.safeBottomPx,'drag respects bottom safe area');
    }
  }
}
mini.miniPlayerUnmount(id);

let window={windowWidth:375,windowHeight:800,screenHeight:800,screenTop:0,safeAreaInsets:{bottom:0}};
// Run Android's layout branch; iOS has no software key navigation.
const layoutCode=read('uni_modules/qt-ui/composables/use-qt-layout.ts').replace(/\/\/ #ifdef APP-IOS[\s\S]*?\/\/ #endif/g,'');
const geometry=runInNewContext(code(layoutCode)+'\n({useQtLayout,applyQtNativeSafeBottom,qtTabBarFloatGapPx,qtTabBarHeightPx,qtRpx,qtPlayerBarHeightPx})', {qtSafePane,reactive,console:{log(){}},uni:{getSystemInfoSync:()=>window,getWindowInfo:()=>window},setInterval:()=>1,clearInterval(){}});
const state=geometry.useQtLayout();
geometry.applyQtNativeSafeBottom(0,1);assert.equal(geometry.qtTabBarFloatGapPx(),32,'system-inset button navigation keeps original gap');
geometry.applyQtNativeSafeBottom(42,1);assert.equal(geometry.qtTabBarFloatGapPx(),0,'edge-to-edge buttons keep original placement');
geometry.applyQtNativeSafeBottom(0,0);assert.equal(geometry.qtTabBarFloatGapPx(),12,'gestures keep a 12px bottom gap at 375px');
geometry.applyQtNativeSafeBottom(20,0);assert.equal(geometry.qtTabBarFloatGapPx(),0,'never move into the mandatory gesture area');
const fontScale={scale:1};
const dock=runInNewContext(code(read('uni_modules/qt-ui/composables/mini-player-layout.ts'))+'\n({qtMiniDockBottomPx,qtMiniDockReservePx,qtMiniDockBarHeightPx,qtMiniStripHeightPx})',{...geometry,fontScale,qtLayout:()=>state});
assert.equal(dock.qtMiniDockBottomPx(true),geometry.qtTabBarHeightPx(true),'joined dock meets the navigation edge without overlap');
assert.equal(dock.qtMiniDockReservePx(false),20+8+56,'secondary page counts safe area once');
fontScale.scale=1.5;
assert.ok(dock.qtMiniDockBarHeightPx()>=60*1.5/2+14,'large font has room for both lines and progress');
fontScale.scale=1;
state.isWide=true;
assert.equal(dock.qtMiniDockReservePx(false),104,'wide dock counts its own safe area once');

// An already mounted native image can retain the old rpx basis after resize.
// The icon API keeps its existing compact-rpx/wide-px sizes, then binds pixels.
const iconSource = read('uni_modules/qt-ui/components/qt-icon/qt-icon.uvue');
const iconScript = iconSource.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)?.[1];
assert.ok(iconScript);
const iconProps = reactive({ name: 'skip-back', size: 32, color: '#000000' });
const icon = runInNewContext(code(iconScript) + '\n({sizeStyle})', {
  computed, defineProps: () => iconProps, useQtLayout: () => layout,
  qtRpx: n => n * layout.windowWidth / 750, iconSrc: () => '',
});
for (const [width, height] of [[640, 360], [1280, 800], [360, 800], [430, 932], [360, 800]]) {
  layout.windowWidth = width; layout.windowHeight = height;
  layout.isWide = width >= 900 || (width >= 600 && width > height);
  const expected = layout.isWide ? iconProps.size : iconProps.size * width / 750;
  assert.equal(icon.sizeStyle.value, `width:${expected}px;height:${expected}px;`, 'mounted icons must follow the latest window basis');
}
const visualCode = source.slice(source.indexOf('const props = defineProps'), source.indexOf('/**\n * 四模式迷你播放器'));
const sheetVisibility = runInNewContext(code(read('uni_modules/qt-ui/stores/sheet-visibility.ts')) + '\n({qtSheetOverlayOpen,qtSheetOverlayClose,qtSheetOverlayCount})', {ref});
const visuals = runInNewContext(code(visualCode) + '\n({coverSizeStyle,actionSizeStyle,toggleSizeStyle,fabSizeStyle,stripStyle,copyHeightStyle,sheetHidden})', {
  computed, defineProps: () => ({ aboveTab: true }), useMiniPlayerSettings: () => settings,
  layout, theme: { skin: { surface: '#ffffff', border: '#eeeeee', text: '#000000', textMuted: '#888888' } },
  fontScale, qtRpx: n => n * layout.windowWidth / 750, qtFontDualPx: () => '',
  qtMiniDockBarHeightPx: () => 56, miniRenderWidth: ref(300), miniRenderHeight: ref(56),
  qtSheetOverlayCount: sheetVisibility.qtSheetOverlayCount,
});
const dimension = (style, name) => {
  const match = style.match(new RegExp(`(?:^|;)${name}:([\\d.]+)px(?:;|$)`));
  assert.ok(match, `${name} must bind current pixels`);
  return Number(match[1]);
};
const samePixels = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.001, `${actual}px must match ${expected}px`);
assert.match(source, /class="mini-cover-wrap"[^>]*:style="coverSizeStyle \+ discStyle"/);
assert.match(source, /class="mini-cover"[^>]*:style="coverSizeStyle \+/);
for (const [width, height] of [[640, 360], [1280, 800], [360, 800], [430, 932], [360, 800]]) {
  layout.windowWidth = width; layout.windowHeight = height;
  layout.isWide = width >= 900 || (width >= 600 && width > height);
  for (const mode of ['expandable', 'ball', 'bar', 'docked']) {
    preferences.setMiniPlayerMode(mode);
    const unit = width / 750;
    samePixels(dimension(visuals.coverSizeStyle.value, 'width'), mode === 'docked' ? 76 * unit : layout.isWide ? 42 : 80 * unit);
    samePixels(dimension(visuals.actionSizeStyle.value, 'width'), mode === 'docked' ? 44 : layout.isWide ? 34 : 64 * unit);
    samePixels(dimension(visuals.toggleSizeStyle.value, 'width'), mode === 'docked' ? 36 : layout.isWide ? 34 : 64 * unit);
    samePixels(dimension(visuals.fabSizeStyle.value, 'width'), layout.isWide ? 72 : 120 * unit);
    samePixels(dimension(visuals.stripStyle.value, 'padding-left'), mode === 'docked' ? 20 * unit : layout.isWide ? 8 : 16 * unit);
    samePixels(dimension(visuals.copyHeightStyle.value, 'padding-left'), layout.isWide ? 10 : 16 * unit);
  }
}
// The whole bar hides while any QtSheet overlay is open, and a second sheet must
// not restore the bar while the first one is still up.
assert.equal(visuals.sheetHidden.value, true, 'no overlay keeps the bar visible');
sheetVisibility.qtSheetOverlayOpen();
assert.equal(visuals.sheetHidden.value, false, 'an open sheet hides the mini bar');
sheetVisibility.qtSheetOverlayOpen();
assert.equal(visuals.sheetHidden.value, false, 'a second sheet keeps the bar hidden');
sheetVisibility.qtSheetOverlayClose();
assert.equal(visuals.sheetHidden.value, false, 'closing one of two sheets keeps the bar hidden');
sheetVisibility.qtSheetOverlayClose();
assert.equal(visuals.sheetHidden.value, true, 'the bar returns only after the last sheet closes');
sheetVisibility.qtSheetOverlayClose(); sheetVisibility.qtSheetOverlayClose();
assert.equal(sheetVisibility.qtSheetOverlayCount().value, 0, 'stray close calls never underflow the counter');
assert.match(source, /v-if="player\.current != null && !layout\.isTv && \(settings\.mode != 'docked' \|\| !layout\.isWide\) && sheetHidden"/, 'the template gates the host on the overlay count');
assert.match(source, /:style="toggleSizeStyle \+ 'background-color:'/, 'the play/pause key binds its smaller docked size');
// QtSheet reports visibility centrally; the action sheet and the download page reuse it.
const sheetSource = read('uni_modules/qt-ui/components/qt-sheet/qt-sheet.uvue');
assert.match(sheetSource, /watch\(\(\): boolean => props\.visible[\s\S]*qtSheetOverlayOpen\(\)/, 'qt-sheet registers open sheets with the overlay counter');
assert.match(sheetSource, /onUnmounted[\s\S]*qtSheetOverlayClose\(\)/, 'qt-sheet unregisters on unmount to avoid leaks');
const actionSheetSource = read('uni_modules/qt-ui/components/qt-action-sheet/qt-action-sheet.uvue');
assert.match(actionSheetSource, /<QtSheet :visible="visible"/, 'qt-action-sheet inherits the overlay registration via qt-sheet');

// A fixed bar must clear a floating cover's angle, including retained hidden pages.
// Run the component's actual computed style so Vue dependency changes are exercised.
const rotationCode = source.slice(source.indexOf('const discStyle = computed'), source.indexOf('\nlet startX ='));
assert.ok(rotationCode.includes('const discStyle = computed'));
const pageVisible = ref(true), miniRotateDeg = ref(0);
const discStyle = runInNewContext(code('let lastRotation = 0;\n' + rotationCode) + '\ndiscStyle', {
  computed, settings, pageVisible, miniRotateDeg,
});
for (const [width, height] of [[390, 844], [1280, 800], [390, 844]]) {
  layout.windowWidth = width; layout.windowHeight = height;
  layout.isWide = width >= 900 || (width >= 600 && width > height);
  for (const mode of ['expandable', 'ball', 'bar']) {
    for (const hidden of [false, true]) {
      preferences.setMiniPlayerMode(mode);
      pageVisible.value = true;
      miniRotateDeg.value = 31.5;
      assert.equal(discStyle.value, 'transform: rotate(31.5deg);', 'floating covers use the shared angle');
      pageVisible.value = !hidden;
      void discStyle.value;
      miniRotateDeg.value = 173;
      assert.equal(discStyle.value, `transform: rotate(${hidden ? 31.5 : 173}deg);`, 'hidden floating covers retain their last frame');
      preferences.setMiniPlayerMode('docked');
      assert.equal(discStyle.value, 'transform: rotate(0deg);', 'switching to the fixed bar must explicitly clear rotation');
      assert.equal(miniRotateDeg.value, 173, 'fixed mode must not reset shared floating rotation');
      miniRotateDeg.value = 285.25;
      pageVisible.value = true;
      assert.equal(discStyle.value, 'transform: rotate(0deg);', 'returning to a retained page must keep the fixed cover upright');
      preferences.setMiniPlayerMode(mode);
      assert.equal(discStyle.value, 'transform: rotate(285.25deg);', 'switching back resumes the shared floating angle');
    }
  }
}

// Execute frame decisions with real reactive dependencies, including workspace ownership.
const frameSource=read('uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue');
const frameCode=frameSource.slice(frameSource.indexOf('const player = usePlayerStore();'),frameSource.indexOf('/**\n * 当前路由：优先'));
const tvUi=tvScriptFixture({uni});
for(const hostedRoute of ['', '/pages/search/index']) {
  const currentRoute=ref(hostedRoute||'/pages/home/index'),fullWidth=ref(false),toolActive=ref(false);
  const framePlayer=reactive({current:{}});
  const frame=runInNewContext(code(frameCode)+'\n({showPlayerBar,showDockTab,reservePlayerBar,workspaceCoversPlayer,hasBottomTab})',{
    ...tvUi,computed,currentRoute,fullWidth,hostedRoute,layout:state,usePlayerStore:()=>framePlayer,useMiniPlayerSettings:()=>settings,
    qtWideToolActive:()=>toolActive.value,qtIsWideToolHost:route=>route==='/pages/home/index',
  });
  for(const wide of [false,true])for(const mode of ['expandable','ball','bar','docked']) {
    state.isWide=wide;preferences.setMiniPlayerMode(mode);
    assert.equal(frame.reservePlayerBar.value,mode==='docked','floating modes do not shrink page content');
    assert.equal(frame.showPlayerBar.value,mode==='docked'&&wide&&hostedRoute==='','hosted tools never duplicate HD dock');
    assert.equal(frame.showDockTab.value,mode==='docked'&&!wide&&hostedRoute==='','only compact tab roots host replacement navigation');
    framePlayer.current=null;assert.equal(frame.reservePlayerBar.value,false,'empty queue never leaves blank dock space');framePlayer.current={};
    fullWidth.value=true;assert.equal(frame.reservePlayerBar.value,false);assert.equal(frame.showPlayerBar.value,false);fullWidth.value=false;
  }
  if(!hostedRoute){toolActive.value=true;assert.equal(frame.showPlayerBar.value,false,'workspace owns visible dock');}
}
// Render the real settings hint with the same unwrapped capabilities available
// to its template. A stale script binding previously crashed the whole subpage.
const playSettings = read('pages/play-settings/index.uvue');
const effectsHint = [...playSettings.matchAll(/\{\{([\s\S]*?)\}\}/g)]
  .find(match => match[1].includes('浮点输出') && match[1].includes('音量增强'))?.[1];
assert.ok(effectsHint, 'playback settings must retain its output capability hint');
const outputCapabilities = { floatOutput: true, softwareDecoder: true, volumeEnhancement: true };
const gainCapabilities = { floatOutput: false, softwareDecoder: false, volumeEnhancement: true };
const remoteCapabilities = { floatOutput: false, softwareDecoder: false, volumeEnhancement: false };
assert.match(runInNewContext(effectsHint, { capabilities: outputCapabilities }), /下一首或停止后重播生效/);
assert.match(runInNewContext(effectsHint, { capabilities: gainCapabilities }), /支持音量增强/);
assert.match(runInNewContext(effectsHint, { capabilities: gainCapabilities }), /暂不支持浮点输出和解码器选择/);
assert.match(runInNewContext(effectsHint, { capabilities: remoteCapabilities }), /当前播放方式暂不支持/);
console.log('mini player: four-mode taps, persistence, drag/rotation geometry, fixed-cover rotation reset, system-key preservation, dock clearance, smaller docked play key, sheet-overlay hiding and settings capability hint passed');
