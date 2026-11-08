import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { ref, computed, effect } from 'vue';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const runnable = code => stripTypeScriptTypes(code.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*/gm, '').replace(/\bexport\s+/g, ''), {mode:'strip'});
const slice = (code, start, end) => {
  const a = code.indexOf(start), b = code.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return code.slice(a,b);
};
let passed = 0;
const pass = name => { passed++; console.log('PASS ' + name); };

// One shared animation across stacked pages; no work while invisible/background/wide.
{
  const layout = {windowWidth:390,windowHeight:844,isWide:false,safeBottomPx:0};
  const settings = {mode:"expandable"};
  const raf = new Map(), watches = [], timeouts = new Map();
  let id=0, writes=0, updates=0;
  const watchedRef = initial => { let value=initial; return {get value(){return value;}, set value(v){if(v!==value)updates++;value=v;}}; };
  const api = runInNewContext(runnable(read('uni_modules/qt-ui/services/mini-player-singleton.ts')) + '\n({miniPlayerMount,miniPlayerUnmount,miniPlayerSetPlaying,miniPlayerSetVisible,miniPlayerSetForeground,miniRotateDeg,ensureMiniPositioned,miniPositioned})', {
    qtMiniStripHeightPx:()=>layout.isWide?56:112*layout.windowWidth/750,useMiniPlayerSettings:()=>settings,computed,ref:watchedRef,watch:(get,callback)=>{watches.push({get,callback});},qtLayout:()=>layout,qtRpx:n=>n*layout.windowWidth/750,qtRailWidth:()=>96,
    requestAnimationFrame:fn=>{raf.set(++id,fn);return id;},cancelAnimationFrame:i=>raf.delete(i),
    setTimeout:fn=>{timeouts.set(++id,fn);return id;},clearTimeout:i=>timeouts.delete(i),logWarn:()=>{},
    uni:{getWindowInfo:()=>layout,getStorageSync:()=>'',setStorageSync:()=>{writes++;}},
  });
  const frame = time => { const work=[...raf.values()];raf.clear();for(const fn of work)fn(time); };
  const a=api.miniPlayerMount(), b=api.miniPlayerMount();
  assert.equal(watches.length,2);
  api.miniPlayerSetPlaying(true);assert.equal(raf.size,1);
  updates=0;
  for(let i=0;i<=120;i++)frame(i*1000/120);
  assert.ok(updates>=29&&updates<=30, '120Hz display commits at most 30 rotation updates per second');
  assert.ok(Math.abs(api.miniRotateDeg.value-12)<0.01,'rotation keeps the same wall-clock speed');
  api.miniPlayerSetVisible(a,false);assert.equal(raf.size,1);
  api.miniPlayerSetVisible(b,false);assert.equal(raf.size,0);
  api.miniPlayerSetVisible(b,true);assert.equal(raf.size,1);
  const late=[...raf.values()][0];
  api.miniPlayerSetForeground(false);assert.equal(raf.size,0);
  api.miniPlayerSetForeground(true);assert.equal(raf.size,1);
  late(99999);assert.equal(raf.size,1,'late cancelled callback cannot spawn another loop');
  layout.isWide=true;watches[1].callback();assert.equal(raf.size,1,'wide floating mode remains visible');
  api.ensureMiniPositioned();assert.equal(api.miniPositioned.value,true,'wide floating mode initializes coordinates');
  settings.mode='docked';watches[0].callback();assert.equal(raf.size,0,'dock has no decorative animation');
  settings.mode='expandable';watches[0].callback();
  layout.isWide=false;watches[1].callback();assert.equal(raf.size,1);
  const initialWrites=writes;layout.windowHeight=900;watches[1].callback();
  assert.equal(writes-initialWrites,1,'shared resize writes position once for two mounted pages');
  api.miniPlayerUnmount(a);assert.equal(raf.size,1,'unmounting a covered page keeps the active instance alive');
  api.miniPlayerUnmount(b);assert.equal(raf.size,0);
  api.miniPlayerMount();assert.equal(watches.length,2,'remount does not accumulate resize watchers');
  api.miniPlayerSetPlaying(false);assert.equal(raf.size,0);
  pass('mini-player: 30 updates/s at 120Hz; zero hidden/background loops; one resize writer');
}

{
  const source=read('uni_modules/qt-ui/components/qt-mini-player/qt-mini-player.uvue');
  const pageVisible=ref(true),miniRotateDeg=ref(0);
  const api=runInNewContext('let lastRotation=0;\n'+runnable(slice(source,'const discStyle =','let startX ='))+'\n({discStyle})',{computed,pageVisible,miniRotateDeg,settings:{mode:"expandable"},layout:{isWide:false}});
  let paints=0;effect(()=>{api.discStyle.value;paints++;});
  miniRotateDeg.value=12;pageVisible.value=false;const before=paints;
  for(let i=0;i<120;i++)miniRotateDeg.value=i;
  assert.equal(paints,before,'covered component unsubscribes from rotation ticks');
  pageVisible.value=true;assert.ok(api.discStyle.value.includes('119deg'));
  pass('covered mini-player: 120 animation changes cause zero style paints');
}

// The cap stack keeps its ownership semantics but only invalidates on visible changes.
{
  const api=runInNewContext(runnable(read('uni_modules/qt-ui/composables/use-qt-widths.ts'))+'\n({qtPushContentWidthCap,qtUpdateContentWidthCap,qtClearContentWidthCap,qtContentWidthCap})',{ref,qtLayout:()=>({}),qtRailWidth:()=>96});
  let evaluations=0;
  const consumer=computed(()=>{evaluations++;return api.qtContentWidthCap();});
  assert.equal(consumer.value,0);
  const a=api.qtPushContentWidthCap(600);assert.equal(consumer.value,600);
  const b=api.qtPushContentWidthCap(600);assert.equal(consumer.value,600);
  const baseline=evaluations;
  for(let i=0;i<100;i++){api.qtUpdateContentWidthCap(b,600);assert.equal(consumer.value,600);}
  api.qtUpdateContentWidthCap(a,400);assert.equal(consumer.value,600);
  assert.equal(evaluations,baseline,'unchanged or covered caps do not invalidate active consumers');
  api.qtClearContentWidthCap(b);assert.equal(consumer.value,400);
  api.qtClearContentWidthCap(a);assert.equal(consumer.value,0);
  pass('content widths: 100 unchanged updates cause zero consumer recomputations');
}

{
  const source=read('pages/search/index.uvue');
  let checks=0;
  class MeasuredSet extends Set { has(key){checks++;return super.has(key);} }
  const songs=ref([]);
  const api=runInNewContext(runnable(slice(source,'function uniquePlaylists(', 'async function runSearch('))+'\n({uniqueSongs,uniquePlaylists,uniqueArtists,uniqueAlbums,appendSongsInPlace})',{Set:MeasuredSet,songs});
  const unique=Array.from({length:6000},(_,i)=>({id:String(i),platform:i%2?'a':'b'}));
  const input=unique.concat(unique.slice(0,2000));
  for(const fn of ['uniqueSongs','uniquePlaylists','uniqueArtists','uniqueAlbums']){
    checks=0;const result=api[fn](input);
    assert.equal(result.length,6000);assert.equal(result[17],unique[17]);
    assert.equal(checks,8000,'one membership lookup per input');
  }
  songs.value=unique.slice(0,5900);const identity=songs.value;
  api.appendSongsInPlace(unique.slice(5800));assert.equal(songs.value,identity);assert.equal(songs.value.length,6000);
  const oldAll=read('pages/search/index.uvue').includes('v-show="type ==');assert.equal(oldAll,false,'only the active search category mounts native lists');
  let keyReads=0;
  const rows=Array.from({length:10000},(_,i)=>({get id(){keyReads++;return String(i)},platform:'wyy'}));
  const preview=runInNewContext(runnable(slice(source,'const allSongRows =','const allEmpty ='))+'\n({allSongRows,allPlaylistRows,allArtistRows,allAlbumRows})',{computed,songs:ref(rows),playlists:ref(rows),artists:ref(rows),albums:ref(rows)});
  assert.equal(preview.allSongRows.value.length,20);assert.equal(preview.allPlaylistRows.value.length,6);
  assert.equal(preview.allArtistRows.value.length,8);assert.equal(preview.allAlbumRows.value.length,6);
  assert.equal(keyReads,40,'All preview builds 40 rows, not four complete 10k lists');
  pass('search: linear deduplication; preview constructs only 40 of 40,000 source rows');
}

{
  const api=runInNewContext(runnable(read('uni_modules/qt-ui/services/icons.ts'))+'\n({iconSrc,size:()=>srcCache.size})');
  const initial=api.iconSrc('play','#123456');
  for(let i=0;i<5000;i++)api.iconSrc('play','#'+i.toString(16).padStart(6,'0'));
  assert.ok(api.size()<=384);assert.equal(api.iconSrc('play','#123456'),initial);
  pass('icons: 5,000 custom colors retain at most 384 cache entries without changing SVG output');
}

{
  const source=read('uni_modules/qt-ui/components/qt-back-to-top/qt-back-to-top.uvue');
  const code=slice(source,'const posStyle =','</script>');
  for(const [width,height,wide,safe] of [[390,844,false,34],[640,360,true,20],[900,700,true,0],[1920,1080,true,42]]){
    const layout={windowWidth:width,windowHeight:height,isWide:wide,safeBottomPx:safe};
    let queries=0;
    const api=runInNewContext(runnable(code)+'\n({posStyle})',{computed,layout,miniSettings:{mode:"docked"},qtMiniDockReservePx:()=>wide?84+safe:296*width/750+safe,player:{current:{}},qtRpx:n=>n*width/750,qtPlayerBarHeightPx:()=>84+safe,qtTabBarHeightPx:()=>184*width/750+safe,uni:{getWindowInfo(){queries++;return layout;}}});
    const style=api.posStyle.value;
    const top=Number(style.match(/top:([\d.]+)px/)[1]);
    const size=wide?40:80*width/750;
    const bottom=height-top-size;
    assert.ok(bottom>=(wide?84+safe:184*width/750+safe));assert.equal(queries,0);
  }
  pass('back-to-top: correct compact/wide dock clearance with zero window bridge calls');
}
console.log(`UI performance: ${passed} production behavior groups passed`);
