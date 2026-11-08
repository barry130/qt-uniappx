import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8').replaceAll('\r\n','\n');
const between=(s,a,b)=>{const i=s.indexOf(a),j=s.indexOf(b,i+a.length);assert.ok(i>=0&&j>i,a);return s.slice(i,j);};
const compile=s=>stripTypeScriptTypes(s.replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm,''),{mode:'strip'}).replace(/^export /gm,'');
const noop=()=>{};
const song=(id,platform='wyy',url='')=>({id,platform,url,name:'Song '+id,singer:'Artist',album:'',picUrl:'',duration:200});
class Json {get(k){return this[k]??null;}set(k,v){this[k]=v;}static keys(o){return Object.keys(o);}}
const storage=new Map();let files=new Set(),downloads=[],library=[],network='4g';const calls=[];
const context=vm.createContext({console,UTSJSONObject:Json,parseJsonToUtso:t=>Object.assign(new Json(),JSON.parse(t)),
  uni:{getStorageSync:k=>storage.get(k)??(k.includes('local-audio')?library:''),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),getNetworkType:o=>o.success({networkType:network})},
  useDownloadsStore:()=>({items:downloads,find:s=>downloads.find(d=>d.song.id===s.id&&d.song.platform===s.platform)}),
  statLocalFile:p=>files.has(p)?100:-1,logMsg:noop,logMsgWarn:noop,qtShowToast:noop,preferredSource:()=>null,
  STATE_KEY:'state',PROGRESS_KEY:'progress',DEFAULT_FAV_KEY:'fav',PRELOAD_TTL_MS:300000,
  audioPlayer:{setRepeatMode:n=>calls.push(['repeat',n]),stop:()=>calls.push(['stop']),getGapless:()=>true,preloadTrack:p=>calls.push(['preload',p])},
});
const source=read('stores/player.ts');
const playerClass=between(source,'class PlayerStore {','\nconst player = reactive(new PlayerStore())');
vm.runInContext(compile(read('services/local-first.ts'))+'\n'+compile(read('stores/persist-codec.ts'))+'\n'+compile(playerClass)+'\nglobalThis.api={LocalAudioLookup,localFirstEnabled,PlayerStore};',context);
const {LocalAudioLookup,PlayerStore}=context.api;
let groups=0;
const check=async(name,fn)=>{await fn();groups++;console.log('PASS '+name);};
const host=()=>Object.assign(Object.create(PlayerStore.prototype),{radioActive:false,radioBackup:'',current:null,queue:[],mode:'random',quality:'320',progress:0,duration:0,lockedNextMid:'',playCounts:new Map(),playing:false,playSeq:0,
  localFirstFailed:new Map(),localFirstUsed:new Map(),localPathByMid:new Map(),resolvedUrlMap:new Map(),localFirstTick:0,
  persist(){this.saveState();},effQualityOf:()=> '320',listenSession:{start:noop},stopProgressClock:noop,markProgress(p){this.progress=p;},resume(){this.playing=true;}});

await check('all sources: explicit file, download identity, library identity, metadata, missing file and rejection',()=>{
  const local=song('1','local'); library=[{id:'1',title:local.name,singer:local.singer,album:'',duration:200,uri:'content://1'}];
  // Use the production storage key, including configurations whose value is substituted by the host.
  const key=read('services/local-first.ts').match(/const LOCAL_AUDIO_KEY = "([^"]+)"/)[1];storage.set(key,library);
  downloads=[{song:song('2'),path:'/2.mp3'}]; files=new Set(['content://1','/2.mp3','/explicit.mp3']);
  const lookup=new LocalAudioLookup();
  assert.equal(lookup.find(local),'content://1');assert.equal(lookup.find(song('2')),'/2.mp3');
  assert.equal(lookup.find(song('2','wyy','/explicit.mp3')),'/explicit.mp3');
  assert.equal(lookup.find({...song('2'),platform:'qq'}),'/2.mp3');
  assert.equal(lookup.find(song('2'),'/2.mp3'),null);
  assert.equal(lookup.find({...song('2'),singer:'different',platform:'qq'}),null);
  assert.equal(lookup.find(song('missing','wyy','/gone.mp3')),null);
  storage.set('qt-playback-local-first',false);assert.equal(context.api.localFirstEnabled(),true);
});
await check('favorites preserve new local URI and repair old favorites before timeline; HTTP URL never bypasses local',()=>{
  const p=host();p.likedSongs=[];
  const local=song('1','local','content://1');p.collectSongInto(local,'fav');assert.equal(p.likedSongs[0].url,'content://1');
  const old=song('1','local');p.queue=[old,song('2','wyy','https://old')];p.current=old;
  p.refreshLocalPathIndex();assert.equal(old.url,'content://1');
  assert.equal(p.buildTimelineItem(old).uri,'content://1');assert.equal(p.buildTimelineItem(p.queue[1]).uri,'/2.mp3');
  p.queue[1].picUrl='https://cover';assert.equal(p.buildTimelineItem(p.queue[1]).coverUrl,'','native artwork waits for embedded check');
});
await check('mobile gapless does not fetch next online audio; Wi-Fi uses one guarded preload; local never preloads online',async()=>{
  const p=host();p.playing=true;const next=song('remote');calls.length=0;
  p.warmNextOnlineUrl(next);assert.equal(calls.length,0);
  network='wifi';p.warmNextOnlineUrl(next);assert.equal(calls.filter(x=>x[0]==='preload').length,1);
  p.warmNextOnlineUrl(song('2'));assert.equal(calls.filter(x=>x[0]==='preload').length,1);
});
for(const empty of [false,true])await check('FM cold start restores ordinary queue/mode/position, paused, empty='+empty,()=>{
  const p=host();const a=song('ordinary');p.current=empty?null:a;p.queue=empty?[]:[a];p.progress=empty?0:37.5;p.duration=200;p.playing=true;p.lockedNextMid='wyy:later';
  p.beginRadio();assert.equal(p.radioActive,true);assert.equal(p.mode,'sequence');
  p.current=song('fm');p.queue=[p.current];p.progress=80;p.persist();
  storage.set('progress',JSON.stringify({key:'wyy:ordinary',progress:150}));
  const fresh=host();fresh.loadState();
  assert.equal(fresh.radioActive,false);assert.equal(fresh.mode,'random');assert.equal(fresh.queue.length,empty?0:1);
  if(!empty){assert.equal(fresh.current.id,'ordinary');assert.equal(fresh.progress,37.5);}
  assert.equal(fresh.playing,false);assert.equal(fresh.lockedNextMid,'wyy:later');
});
await check('FM exit restores empty and paused snapshots; external queue keeps user choice; repeated start preserves original',()=>{
  const p=host();const a=song('ordinary');p.current=a;p.queue=[a];p.progress=12.25;
  p.beginRadio();p.current=song('fm');p.queue=[p.current];p.beginRadio();p.endRadio();
  assert.equal(p.current.id,'ordinary');assert.equal(p.progress,12.25);assert.equal(p.playing,false);assert.equal(p.mode,'random');
  p.beginRadio();const chosen=song('chosen');p.current=chosen;p.queue=[chosen];p.endRadio(false);
  assert.equal(p.current.id,'chosen');assert.equal(p.radioActive,false);assert.equal(p.mode,'random');
  p.current=null;p.queue=[];p.beginRadio();p.current=song('fm');p.queue=[p.current];p.endRadio();assert.equal(p.current,null);assert.equal(p.queue.length,0);
});
await check('FM refuses takeover when persistence fails and preserves ordinary queue',()=>{
  const p=host();p.current=song('ordinary');p.queue=[p.current];p.saveState=()=>false;
  assert.throws(()=>p.beginRadio(),/保存/);assert.equal(p.radioActive,false);assert.equal(p.current.id,'ordinary');assert.equal(p.mode,'random');
});
await check('FM tail pauses instead of looping old recommendations',()=>{
  const p=host();p.radioActive=true;p.queue=[song('fm')];p.current=p.queue[0];p.mode='sequence';p.playing=true;p.pause=()=>p.playing=false;
  p.next();assert.equal(p.playing,false);assert.equal(p.current.id,'fm');
});
await check('lyric cache survives process restart, source invalidation and clear',()=>{
  vm.runInContext(compile(read('services/lyric-disk-cache.ts'))+'\nglobalThis.disk={readLyricDisk,writeLyricDisk,removeLyricDisk,clearLyricDisk};',context);
  const disk=context.disk;disk.writeLyricDisk('wyy:1','[00:01]hello');assert.equal(disk.readLyricDisk('wyy:1'),'[00:01]hello');
  disk.removeLyricDisk('wyy:1');assert.equal(disk.readLyricDisk('wyy:1'),'');disk.writeLyricDisk('wyy:2','text');disk.clearLyricDisk();assert.equal(disk.readLyricDisk('wyy:2'),'');
});
await check('FM cancellation while preference is loading never claims queue',async()=>{
  let resolve;const pref=new Promise(r=>resolve=r);const p=host();let begins=0;p.beginRadio=()=>begins++;
  const radioSource=read('stores/radio.ts');
  const radioClass=between(radioSource,'class RadioStore {','\n// ---- 心跳');
  const ctx=vm.createContext({usePlayerStore:()=>p,loadPreference:()=>pref,readTaste:()=> 'heart',stopHeartbeat:noop,logMsgWarn:noop,errMsg:e=>e.message});
  vm.runInContext(compile(radioClass)+'\nglobalThis.radio=new RadioStore();',ctx);
  const task=ctx.radio.start();ctx.radio.stop();resolve({});await task;assert.equal(begins,0);assert.equal(ctx.radio.active,false);
});
await check('FM delayed start yields when user has already selected another song',async()=>{
  let resolve;const pref=new Promise(r=>resolve=r);const p=host();let begins=0;p.beginRadio=()=>begins++;
  const code=between(read('stores/radio.ts'),'class RadioStore {','\n// ---- 心跳');
  const ctx=vm.createContext({usePlayerStore:()=>p,loadPreference:()=>pref,readTaste:()=> 'heart',stopHeartbeat:noop,logMsgWarn:noop,errMsg:e=>e.message});
  vm.runInContext(compile(code)+'\nglobalThis.radio=new RadioStore();',ctx);
  const task=ctx.radio.start();p.playSeq++;resolve({});await task;assert.equal(begins,0);assert.equal(ctx.radio.loading,false);
});
await check('shared embedded lookup deduplicates concurrent consumers; lookup without tags permits fallback',async()=>{
  let reads=0;
  const ctx=vm.createContext({statLocalFile:()=>100,localFileFor:async s=>s.id==='missing'?null:'/song.mp3',readEmbeddedTags:()=>{reads++;return{lrcText:'[00:01]embedded',coverPath:'/cover.jpg'};},setTimeout});
  vm.runInContext(compile(read('services/local-media.ts'))+'\nglobalThis.read=readSongEmbedded;',ctx);
  const results=await Promise.all([ctx.read(song('a')),ctx.read(song('a')),ctx.read(song('a'))]);
  assert.equal(reads,1);assert.equal(results[0].lrcText,'[00:01]embedded');assert.equal(await ctx.read(song('missing')),null);
});
await check('lyrics prefer embedded over cached online words, suppress mixed translations; absent embedded uses cache then fetch',async()=>{
  const src=read('services/music-api.ts');let embedded={lrcText:'embedded'},fetches=0;
  const methods=between(src,'  async lyrics(song: Song)', '  /**\n   * 取址后顺手预热歌词');
  const cacheMethods=between(src,'  private cacheGet(', '  /**\n   * 作废单条歌词缓存');
  const ensure=between(src,'  private async ensureLyric(', '  /** ensureLyric 的实际取词步骤');
  const lyricKey=between(src,'  private lyricKeyOf(', '  // ==================== 引擎调用');
  const ctx=vm.createContext({readSongEmbedded:async()=>embedded,readLyricDisk:()=>'',writeLyricDisk:noop,qtDiag:noop,LYRIC_EMPTY_TTL_MS:60000,preferredSource:()=>null});
  vm.runInContext(compile('class Music {\n'+methods+cacheMethods+ensure+lyricKey+'\n}\nglobalThis.Music=Music;'),ctx);
  const api=Object.assign(new ctx.Music(),{lyricCache:new Json(),lyricAsked:new Map(),lyricInflight:new Map(),pickedLyricOf:()=>null,fetchLyricFor:async function(_s,k){fetches++;this.lyricCache.set(k,'online');}});
  api.lyricCache.set('wyy:a','stale-online');api.lyricCache.set('wyy:a:tr','stale-translation');
  assert.equal(await api.lyrics(song('a')),'embedded');assert.equal(await api.lyricTranslation(song('a')),'');assert.equal(fetches,0);
  embedded=null;assert.equal(await api.lyrics(song('a')),'stale-online');assert.equal(fetches,0);
  assert.equal(await api.lyrics(song('b')),'online');assert.equal(fetches,1);
});
await check('cover cache reuses disk files and coalesces concurrent network fetches',async()=>{
  const disk=new Set();let requests=0;
  const ctx=vm.createContext({uni:{env:{USER_DATA_PATH:'/private'},getFileSystemManager:()=>({accessSync:p=>{if(!disk.has(p))throw Error('missing');},copyFileSync:(p,d)=>{if(p!='/temp'&&!disk.has(p))throw Error('missing');disk.add(d);}})},downloadPublicCover:async()=>{requests++;return '/temp';}});
  vm.runInContext(compile(read('services/cover-disk-cache.ts'))+'\nglobalThis.cache=cacheCoverFile;',ctx);
  const [a,b]=await Promise.all([ctx.cache('wyy:a','https://cover'),ctx.cache('wyy:a','https://cover')]);assert.equal(a,b);assert.equal(requests,1);
  assert.equal(await ctx.cache('wyy:a','https://cover'),a);assert.equal(requests,1);
});
console.log('local media / FM: '+groups+' groups passed (actual source, synthetic boundaries)');
