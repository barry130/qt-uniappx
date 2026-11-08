import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const compile=s=>stripTypeScriptTypes(s.replace(/^import[\s\S]*?from\s*["'][^"']+["'];?\s*/gm,'').replace(/^export /gm,''),{mode:'strip'});
const between=(s,a,b)=>{const start=s.indexOf(a),end=s.indexOf(b,start+a.length);assert.ok(start>=0&&end>start,a);return s.slice(start,end);};
const core=compile(read('uni_modules/qt-audio-player/utssdk/car-lyric.uts'));
const pure=vm.runInNewContext(core+'\n({parseCarLyric,carLyricAt,carLyricFields,carLyricText})');
let count=0;
const pass=name=>{count++;console.log('PASS '+name);};

{
  const lines=pure.parseCarLyric('[ar:123456]\n[00:03.50][00:08.500]第二行\r\n[00:01.00]第一行\n[00:06.00]\n[00:99]invalid\n[offset:500]');
  assert.deepEqual(Array.from(lines,l=>[l.timeMs,l.text]),[[500,'第一行'],[3000,'第二行'],[5500,''],[8000,'第二行']]);
  assert.equal(pure.carLyricAt(lines,499,0),'');assert.equal(pure.carLyricAt(lines,500,0),'第一行');
  assert.equal(pure.carLyricAt(lines,4000,1500),'第一行');assert.equal(pure.carLyricAt(lines,5500,0),'');
  assert.equal(pure.carLyricAt(lines,8500,0),'第二行');assert.equal(pure.carLyricAt(lines,600,0),'第一行');
  assert.equal(pure.parseCarLyric('普通纯文本歌词').length,0);
  assert.equal(pure.carLyricAt(lines,NaN,0),'');
  const word=pure.parseCarLyric('[1200,800]你(1200,200)好(1400,300)\n[3200,300]啊(0,100,0)');
  assert.deepEqual(Array.from(word,l=>[l.timeMs,l.text]),[[1200,'你好'],[3200,'啊']]);
  const clipped=pure.carLyricText('a'.repeat(159)+'😀尾');assert.equal(clipped,'a'.repeat(159));
  assert.ok(pure.parseCarLyric('[00:01]a\n'.repeat(5000)).length<=4000);
  assert.equal(pure.parseCarLyric('['+'9'.repeat(400)+':00]overflow').length,0);
  pass('timed lyrics: repeated tags, offsets, blanks, seeks, QRC, bounds and Unicode');
}

// Run the production metadata publisher and command implementation with fake media3
// boundary objects. No Bluetooth or native execution is claimed by this harness.
class Bundle {
  constructor(old){this.values=new Map(old?.values??[]);}
  getString(k){return this.values.get(k)??null;}
  putString(k,v){this.values.set(k,v);}
  containsKey(k){return this.values.has(k);}
  remove(k){this.values.delete(k);}
}
class Metadata {
  constructor(title='真实歌名',artist='真实歌手',displayTitle=null,extras=new Bundle()) {Object.assign(this,{title,artist,displayTitle,extras,albumTitle:'专辑',artworkUri:'cover://one',userRating:'liked'});}
  buildUpon(){let m=Object.assign(new Metadata(),this);return {setTitle(v){m.title=v;return this;},setArtist(v){m.artist=v;return this;},setDisplayTitle(v){m.displayTitle=v;return this;},setArtworkUri(v){m.artworkUri=v;return this;},setExtras(v){m.extras=v;return this;},build(){return m;}};}
}
const makeItem=(id,meta=new Metadata())=>({mediaId:id,mediaMetadata:meta,uri:'unchanged://audio',buildUpon(){let m=this.mediaMetadata;const item=this;return {setMediaMetadata(v){m=v;return this;},build(){return makeItem(item.mediaId,m);}};}});
const native=read('uni_modules/qt-audio-player/utssdk/app-android/index.uts');
let code=core+'\n'+between(native,'let gCarLyricGen:', '// ==================== 音频磁盘缓存');
code+='\nconst CAR_LYRIC_KEY="android.media.metadata.LYRICS";\n'+between(native,'function applyCarLyric(', '\n/**\n * 保留整首歌词');
code+='\n'+native.slice(native.indexOf('function carBluetoothConnected()'));
code=code.replaceAll('.toDouble()','').replaceAll('.toInt()','').replace('outputs.size','outputs.length').replaceAll('implements Runnable','').replaceAll('override run()','run()');
let item=makeItem('wyy:A'),position=0,connected=true,now=10000,replacements=0;
const tasks=new Map();
const handler={removeCallbacks:r=>tasks.delete(r),post:r=>{tasks.set(r,0);},postDelayed:(r,d)=>{tasks.set(r,d);}};
const player={getCurrentMediaItem:()=>item,getCurrentMediaItemIndex:()=>0,getCurrentPosition:()=>position,replaceMediaItem:(_i,next)=>{item=next;replacements++;}};
let casting=false;
const ctx=vm.createContext({Bundle,gMediaPlayer:player,dlnaActive:()=>casting,Build:{VERSION:{SDK_INT:35}},Context:{AUDIO_SERVICE:'audio'},AudioManager:{GET_DEVICES_OUTPUTS:2},AudioDeviceInfo:{TYPE_BLUETOOTH_A2DP:8},
  getContext:()=>({getSystemService:()=>({getDevices:()=>connected?[{getType:()=>8}]:[]})}),getHandler:()=>handler,SystemClock:{elapsedRealtime:()=>now},Looper:{myLooper:()=>1,getMainLooper:()=>1},Uri:{parse:v=>v},console});
vm.runInContext(compile(code)+`\nglobalThis.api={audioSetCarLyricMode,audioCarLyricToken,audioSetCarLyricFor,audioSetCarLyricOffset,tickCarLyric,QtCarLyricCommand,audioSetTrackCover,
  transition(mid){gCarTrackEpoch++;gCarTrackMid=mid;gCarLyricText=null;gCarLines=[];gCarLinesReady=false;gCarOffsetMs=0;scheduleCarLyricTick();},publishCarLyricFields};`,ctx);
const api=ctx.api;
api.transition('wyy:A');let token=api.audioCarLyricToken();
api.audioSetCarLyricFor('wyy:A',token,'[00:01]你好\n[00:04]世界\n[00:06]\n[00:08]再见',0);
assert.equal(tasks.size,0,'default-off mode has no ticker');assert.equal(item.mediaMetadata.title,'真实歌名');
position=1500;api.audioSetCarLyricMode(1);api.tickCarLyric();
assert.equal(item.mediaMetadata.artist,'你好');assert.equal(item.mediaMetadata.title,'真实歌名');
assert.equal(item.uri,'unchanged://audio');assert.equal(item.mediaMetadata.userRating,'liked');assert.equal(item.mediaMetadata.artworkUri,'cover://one');
const before=replacements;now+=1500;api.tickCarLyric();assert.equal(replacements,before,'same line must not rebuild metadata');
position=4500;api.tickCarLyric();assert.equal(item.mediaMetadata.artist,'世界');
api.audioSetCarLyricMode(2);api.tickCarLyric();assert.equal(item.mediaMetadata.title,'世界');assert.equal(item.mediaMetadata.artist,'真实歌手');
assert.equal(item.mediaMetadata.displayTitle,'世界');
connected=false;api.tickCarLyric();assert.equal(item.mediaMetadata.title,'真实歌名');assert.equal(item.mediaMetadata.displayTitle,null);
assert.equal(item.mediaMetadata.extras.containsKey('qt.car.original.title'),false);
connected=true;now+=1500;api.tickCarLyric();assert.equal(item.mediaMetadata.title,'世界');
api.audioSetCarLyricMode(0);assert.equal(item.mediaMetadata.title,'真实歌名');assert.equal(tasks.size,0);
pass('native metadata: default off, artist/title modes, reconnect, dedup, restoration and retained metadata');

{
  api.audioSetCarLyricMode(1);position=8500;api.tickCarLyric();assert.equal(item.mediaMetadata.artist,'再见');
  now+=1200;position=0;api.tickCarLyric();assert.equal(item.mediaMetadata.artist,'真实歌手');
  now+=1200;position=4500;api.audioSetCarLyricOffset('wyy:A',token,2500);api.tickCarLyric();assert.equal(item.mediaMetadata.artist,'你好');
  position=7000;api.audioSetCarLyricOffset('wyy:A',token,0);api.tickCarLyric();assert.equal(item.mediaMetadata.artist,'真实歌手');
  const late=new api.QtCarLyricCommand(1,'wyy:A',token,'[00:00]错误旧词',0);
  const oldItem=item;
  item=makeItem('wyy:B');api.transition('wyy:B');late.run();assert.equal(item.mediaMetadata.extras.getString('android.media.metadata.LYRICS'),null);
  item=oldItem;api.transition('wyy:A');late.run();now+=1200;api.tickCarLyric();assert.equal(item.mediaMetadata.artist,'真实歌手');
  token=api.audioCarLyricToken();api.audioSetCarLyricFor('wyy:A',token,'无时间轴的歌词',0);api.tickCarLyric();assert.equal(item.mediaMetadata.artist,'真实歌手');
  api.audioSetCarLyricFor('wyy:A',token,'',0);api.tickCarLyric();assert.equal(item.mediaMetadata.title,'真实歌名');
  pass('native lifecycle: seek/offset/blank/untimed lyrics and stale A→B→A bridge deliveries');
}

{
  const settings=read('pages/play-settings/index.uvue');
  assert.ok(settings.includes('carLyricSupported')&&settings.includes('openSheet("蓝牙车载歌词"'));
  assert.ok(read('pages/cache/index.uvue').includes('audioPlayer.setCarLyricMode(0)'));
  assert.ok(native.includes('getHandler().removeCallbacks(carLyricTicker)'));
  for(const path of ['app-android/index.uts','app-harmony/index.uts','index.uts']){
    const source=read('uni_modules/qt-audio-player/utssdk/'+path);
    assert.ok(source.indexOf('export function audioSetCarLyricMode(')>source.indexOf('export function audioSetEnhanceGain('),'new bridge exports append after existing method IDs');
  }
  const store=read('stores/player.ts');assert.ok(store.includes('this.carLyricLoadSeq != carSequence'));
  assert.ok(store.includes('audioPlayer.setCarLyric(currentText, carMid, carToken'));
  pass('settings/reset/cross-platform facade and guarded store integration contracts');
}

// Settings persistence and non-Android behavior are exercised through the actual facade.
{
  const source=read('services/audio-player.uts');
  const methods=between(source,'  carLyricSupported(): boolean {','  /** 无缝播放是否开启');
  for(const android of [true,false]) {
    const lines=[],keep=[true];
    for(const line of methods.split('\n')) {
      if(line.includes('// #ifdef ')){keep.push(android);continue;}
      if(line.includes('// #ifndef ')){keep.push(!android);continue;}
      if(line.includes('// #endif')){keep.pop();continue;}
      if(keep.every(Boolean))lines.push(line);
    }
    const storage=new Map(),modes=[];
    const Audio=vm.runInNewContext(compile('class Audio {\n'+lines.join('\n')+'\n}\nAudio'),{
      CAR_LYRIC_MODE_KEY:'mode',uni:{getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v)},
      audioSetCarLyricMode:m=>modes.push(m),logWarnV:()=>{},
    });
    const audio=new Audio();assert.equal(audio.getCarLyricMode(),0);
    audio.setCarLyricMode(2);assert.equal(audio.getCarLyricMode(),android?2:0);
    const restored=new Audio();assert.equal(restored.getCarLyricMode(),android?2:0);
    audio.setCarLyricMode(99);assert.equal(audio.getCarLyricMode(),0);
    if(android)assert.deepEqual(modes,[2,0]);
  }
  pass('facade: opt-in persistence, invalid settings reset and unsupported platform stays off');
}
console.log('car lyric: '+count+' groups passed (synthetic boundaries; no real car validation)');

{
  api.audioSetCarLyricMode(1);token=api.audioCarLyricToken();position=1000;
  api.audioSetCarLyricFor('wyy:A',token,'[00:00]保留歌词',0);api.tickCarLyric();
  const currentArtist=item.mediaMetadata.artist;
  api.audioSetTrackCover('wyy:A','file:///private/cover.jpg');
  assert.equal(item.mediaMetadata.artworkUri,'file:///private/cover.jpg');assert.equal(item.mediaMetadata.artist,currentArtist);
  assert.equal(item.uri,'unchanged://audio');assert.equal(item.mediaMetadata.userRating,'liked');
  api.audioSetTrackCover('wyy:B','file:///wrong.jpg');assert.equal(item.mediaMetadata.artworkUri,'file:///private/cover.jpg');
  api.audioSetCarLyricMode(0);assert.equal(item.mediaMetadata.artist,'真实歌手');
  casting=true;api.audioSetTrackCover('wyy:A','file:///remote-only.jpg');
  assert.equal(item.mediaMetadata.artworkUri,'file:///private/cover.jpg');casting=false;
  console.log('PASS current-track cover update preserves audio URI, rating and car-lyric metadata; stale track rejected');
}
