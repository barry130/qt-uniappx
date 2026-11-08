import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { reactive, ref, computed, watch, nextTick } from 'vue';

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

const layout = reactive({windowWidth:390,windowHeight:844,isWide:false,safeBottomPx:20});
const settings = preferences.useMiniPlayerSettings();
const timers = new Map(); let timerId = 0;
const runTimers = () => {const work=[...timers.values()];timers.clear();work.forEach(fn=>fn());};
const mini = runInNewContext(code(read('uni_modules/qt-ui/services/mini-player-singleton.ts')) + '\n({miniPlayerMount,miniPlayerUnmount,miniExpanded,miniFabX,miniFabY,miniEdgeSide,miniCurrentWidth,miniCurrentHeight,miniExpandFromFab,miniCollapse,miniSnapToNearestEdge,miniSyncRenderSize})', {
  qtMiniStripHeightPx:()=>layout.isWide?56:112*layout.windowWidth/750,reactive,ref,computed,watch,useMiniPlayerSettings:()=>settings,qtLayout:()=>layout,qtRpx:n=>n*layout.windowWidth/750,
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
const geometry=runInNewContext(code(layoutCode)+'\n({useQtLayout,applyQtNativeSafeBottom,qtTabBarFloatGapPx,qtTabBarHeightPx,qtRpx,qtPlayerBarHeightPx})', {reactive,console:{log(){}},uni:{getSystemInfoSync:()=>window,getWindowInfo:()=>window},setInterval:()=>1,clearInterval(){}});
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

// Execute frame decisions with real reactive dependencies, including workspace ownership.
const frameSource=read('uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue');
const frameCode=frameSource.slice(frameSource.indexOf('const player = usePlayerStore();'),frameSource.indexOf('/**\n * 当前路由：优先'));
for(const hostedRoute of ['', '/pages/search/index']) {
  const currentRoute=ref(hostedRoute||'/pages/home/index'),fullWidth=ref(false),toolActive=ref(false);
  const framePlayer=reactive({current:{}});
  const frame=runInNewContext(code(frameCode)+'\n({showPlayerBar,showDockTab,reservePlayerBar,workspaceCoversPlayer,hasBottomTab})',{
    computed,currentRoute,fullWidth,hostedRoute,layout:state,usePlayerStore:()=>framePlayer,useMiniPlayerSettings:()=>settings,
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
console.log('mini player: four-mode taps, persistence, drag/rotation geometry, system-key preservation and dock clearance passed');
