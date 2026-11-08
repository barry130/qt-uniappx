import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8').replaceAll('\r\n','\n');
const compile=s=>stripTypeScriptTypes(s.replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm,''),{mode:'strip'}).replace(/^export /gm,'');
const storage=new Map(),ref=value=>({value});
const song=(platform,id='1',name='稻香')=>({id,platform,name,singer:'周杰伦',album:'魔杰座',picUrl:'',duration:220});
const ctx=vm.createContext({ref,Set,Map,uni:{getStorageSync:k=>storage.get(k)??'',setStorageSync:(k,v)=>storage.set(k,v)},songFromJson:JSON.parse,songToJson:JSON.stringify});
vm.runInContext(compile(read('services/preferred-source.ts'))+'\nglobalThis.pref={savePreferredSource,preferredSource};',ctx);
const a=song('qq'),b=song('wyy'),c=song('kw');
ctx.pref.savePreferredSource(a,{...b,url:'https://expired',pids:['other']});assert.equal(ctx.pref.preferredSource(a).platform,'wyy');
assert.equal(ctx.pref.preferredSource(a).url,undefined);assert.equal(ctx.pref.preferredSource(a).pids,undefined);
ctx.pref.savePreferredSource(b,c);assert.equal(ctx.pref.preferredSource(a).platform,'kw');
ctx.pref.savePreferredSource(c,a);assert.equal(ctx.pref.preferredSource(a),null);assert.equal(ctx.pref.preferredSource(b).platform,'qq');
assert.equal(ctx.pref.preferredSource(song('local')),null);assert.equal(ctx.pref.preferredSource(song('qq','other')),null);
const choice=vm.createContext({ref,Set,Map,platformLabel:x=>x});
vm.runInContext(compile(read('services/collect-match.ts'))+'\n'+compile(read('services/collect-dup.ts'))+'\n'+compile(read('services/collect-choice.ts'))+'\nglobalThis.api={compareCollectMatch,prepareCollectMatch,findCrossSourceDup,buildCollectChoice,resolveCollectChoice,chooseCollectSongs,finishCollectChoice,toggleCollectChoice,collectChoiceState};',choice);
// 一套用例跑移动端的真实调用入口；工作区存在 PC 仓库时还检查规则/用例字节与结果。
const matchCases=JSON.parse(read('tools/collect-match.json'));
let pcMatch=null;
const pcMatchPath=new URL('../../qt-pc/src/lib/collect-match.ts',import.meta.url);
if(fs.existsSync(pcMatchPath)){
  const pcSource=fs.readFileSync(pcMatchPath,'utf8').replaceAll('\r\n','\n');
  assert.equal(read('services/collect-match.ts'),pcSource,'收藏相似度规则必须同步 qt-pc');
  assert.equal(read('tools/collect-match.json'),fs.readFileSync(new URL('../../qt-pc/tests/fixtures/collect-match.json',import.meta.url),'utf8').replaceAll('\r\n','\n'),'收藏相似度用例必须同步 qt-pc');
  pcMatch=vm.createContext({});
  vm.runInContext(compile(pcSource)+'\n'+compile(fs.readFileSync(new URL('../../qt-pc/src/lib/collect-dup.ts',import.meta.url),'utf8'))+'\nglobalThis.api={compareCollectMatch,prepareCollectMatch,findCrossSourceDup};',pcMatch);
}
for(const item of matchCases){
  const {a:left,b:right,match,label}=item;
  const leftSong={...song('qq','left',left[0]),singer:left[1],album:left[2]};
  const rightSong={...song('wyy','right',right[0]),singer:right[1],album:right[2]};
  const scores=choice.api.compareCollectMatch(choice.api.prepareCollectMatch(...left),choice.api.prepareCollectMatch(...right));
  assert.equal(scores.matches,match,label);
  assert.equal(choice.api.findCrossSourceDup(leftSong,[rightSong]).length,match?1:0,label);
  assert.equal(choice.api.findCrossSourceDup(rightSong,[leftSong]).length,match?1:0,label+' reverse');
  assert.equal(choice.api.findCrossSourceDup(leftSong,[{...rightSong,platform:'qq'}]).length,0,label+' same source');
  if(pcMatch){
    const pcScores=pcMatch.api.compareCollectMatch(pcMatch.api.prepareCollectMatch(...left),pcMatch.api.prepareCollectMatch(...right));
    assert.equal(JSON.stringify(scores),JSON.stringify(pcScores),label+' scores parity');
    assert.equal(pcMatch.api.findCrossSourceDup({...leftSong,title:leftSong.name},[{...rightSong,title:rightSong.name}]).length,match?1:0,label+' PC adapter');
  }
}
console.log(`collection matching: ${matchCases.length} fuzzy/exact/short-name/missing-metadata cases passed${pcMatch?' with qt-pc parity':''}`);
const api=choice.api,plan=api.buildCollectChoice([a,c,song('qq','2','晴天')],[b]);
assert.equal(plan.groups.length,1);const result=api.resolveCollectChoice(plan,['wyy:1']);assert.equal(result.adds.length,1);assert.equal(result.removes.length,2);
assert.ok(result.removes.every(s=>s.name==='稻香'));
const batch=api.buildCollectChoice([],[a,b,a]);assert.equal(batch.groups.length,1);assert.throws(()=>api.resolveCollectChoice(batch,[]));assert.equal(api.resolveCollectChoice(batch,['wyy:1']).adds.length,1);
const cancelled=api.chooseCollectSongs('list',[a],[b]);api.finishCollectChoice(false);assert.equal(await cancelled,null);
const saved=api.chooseCollectSongs('list',[a],[b]);api.toggleCollectChoice('qq:1');api.toggleCollectChoice('wyy:1');api.finishCollectChoice(true);assert.equal((await saved).removes[0].platform,'qq');
const replaced=api.chooseCollectSongs('one',[a],[b]);api.chooseCollectSongs('two',[a],[c]);assert.equal(await replaced,null);api.finishCollectChoice(false);
// Production picker transaction preserves other memberships and commits only a saved draft.
const player=read('stores/player.ts');
const start=player.indexOf('  private async prepareCollectChoice(');
const end=player.indexOf('\n  collectDupConflicts(',start);
let epoch=1,decision=async()=>result,writes=0,durable=null,queued=[];
const toasts=[];
const tx=vm.createContext({
  getSessionEpoch:()=>epoch,LIKED_KEY:'test-liked',
  collectKey:s=>s.platform+':'+s.id,
  chooseCollectSongs:(...args)=>decision(...args),
  qtShowToast:message=>toasts.push(message.title),
});
vm.runInContext(compile('class Host {\n'+player.slice(start,end)+'\n}\nglobalThis.methods=Host.prototype;'),tx);
function hostFor(songs,save=true){
  const host={
    likedSongs:songs,likedDirty:false,
    playlistPidOf:id=>['one','two','three'].includes(id)?id:'',
    songsOfPid(pid){return this.likedSongs.filter(s=>s.pids?.includes(pid));},
    playlistNameOf:id=>id,
    pickerSelectedIds(s){return this.likedSongs.find(t=>t.platform===s.platform&&t.id===s.id)?.pids?.slice()??[];},
    collectDupIn(s,id){return api.buildCollectChoice(this.songsOfPid(id),[s]).groups.flatMap(g=>g.songs.filter(t=>g.existingKeys.includes(t.platform+':'+t.id)));},
    likeSongPayloadJson:(s,pid)=>JSON.stringify({id:s.id,platform:s.platform,pid}),
    saveSongList(_key,next){writes++;if(save)durable=structuredClone(next);return save;},
    enqueueLikeOps:ops=>queued.push(...ops),
    refreshNativeRating:()=>{},
  };
  for(const name of Object.getOwnPropertyNames(tx.methods))if(name!=='constructor')host[name]=tx.methods[name];
  return host;
}
const host=hostFor([{...a,pids:['one','two']}]);
await host.collectWithChoice([b],'one');
assert.equal(host.likedSongs[0].pids.join(','),'two');
assert.equal(host.likedSongs[1].platform,'wyy');
assert.equal(writes,1);
assert.ok(queued.every(op=>JSON.parse(op.dataJson).pid==='one'));
assert.equal(durable.length,2);
const unchanged=hostFor([{...a,pids:['one','two']}],false),oldReference=unchanged.likedSongs;
queued=[];await unchanged.collectWithChoice([b],'one');
assert.equal(unchanged.likedSongs,oldReference);
assert.equal(unchanged.likedSongs[0].pids.join(','),'one,two');
assert.equal(queued.length,0);assert.ok(toasts.includes('收藏保存失败，原有歌曲已保留'));
decision=async()=>null;
const cancelledHost=hostFor([{...a,pids:['one','two']}]),before=writes;
assert.equal(await cancelledHost.collectWithChoice([b],'one'),false);assert.equal(writes,before);
// Cancel in a later playlist must also cancel earlier additions and unchecked memberships.
let calls=0;
decision=async(name,existing,incoming)=>++calls===1?api.resolveCollectChoice(api.buildCollectChoice(existing,incoming),incoming.map(s=>s.platform+':'+s.id)):null;
const multi=hostFor([{...a,pids:['two']}]);
assert.equal(await multi.applyPickerSelectionWithChoices(a,['one','three']),false);
assert.equal(multi.likedSongs.length,1);assert.equal(multi.likedSongs[0].pids.join(','),'two');
assert.equal(writes,before);
// A login change or membership edit while the sheet is open rejects the old draft.
decision=async()=>{epoch++;return result;};
assert.equal(await multi.collectWithChoice([b],'one'),false);assert.equal(writes,before);
decision=async()=>{multi.likedSongs.push({...c,pids:['one']});return result;};
assert.equal(await multi.collectWithChoice([b],'one'),false);assert.equal(writes,before);
decision=async(_name,existing,incoming)=>api.buildCollectChoice(existing,incoming);
const local=song('local','/music/local.flac');local.url='file:///music/local.flac';
const localHost=hostFor([]);assert.equal(await localHost.collectWithChoice([local],'one'),true);
assert.equal(localHost.likedSongs[0].url,local.url);
// Use the actual timeline builder: local file wins, remote cache key follows the preference.
storage.clear();ctx.pref.savePreferredSource(a,b);
const itemStart=player.indexOf('  private buildTimelineItem('),itemEnd=player.indexOf('\n  /**',itemStart);
const timeline=vm.createContext({preferredSource:ctx.pref.preferredSource});
vm.runInContext(compile('class Timeline {\n'+player.slice(itemStart,itemEnd)+'\n}\nglobalThis.build=Timeline.prototype.buildTimelineItem;'),timeline);
const timelineHost={mediaIdOf:s=>s.platform+':'+s.id,localPathByMid:new Map(),effQualityOf:s=>s.platform==='wyy'?'128':'320'};
const remoteItem=timeline.build.call(timelineHost,a);
assert.equal(remoteItem.mediaId,'qq:1');
assert.ok(remoteItem.uri.includes('source=wyy%3A1')&&remoteItem.uri.includes('q=128'));
timelineHost.localPathByMid.set('qq:1','file:///music/download.flac');
timeline.isLocalAudioPath=()=>false;
assert.equal(timeline.build.call(timelineHost,a).uri,'file:///music/download.flac');
// Actual API cache: saved source survives cached old URLs/lyrics, and valid URLs are reused.
class Utso{
  constructor(values={}){this.values=new Map(Object.entries(values));}
  get(key){return this.values.get(key)??null;}
  set(key,value){this.values.set(key,value);}
  static keys(obj){return [...obj.values.keys()];}
}
const disk=new Map(),engineCalls=[];
const music=vm.createContext({
  UTSJSONObject:Utso,preferredSource:ctx.pref.preferredSource,sourcePlayQualityOf:()=> '320',
  getPlayUrlByEngineResult:async s=>{engineCalls.push(s.platform);return {url:'https://audio/'+s.platform,line:null,actualQuality:'320',size:10,stalled:false};},
  uni:{getStorageSync:()=>'',setStorageSync:()=>{},$emit:()=>{}},readSongEmbedded:async()=>null,
  readLyricDisk:k=>disk.get(k)??'',writeLyricDisk:(k,v)=>disk.set(k,v),removeLyricDisk:k=>disk.delete(k),
  qtDiag:()=>{},Map,Set,
});
vm.runInContext(compile(read('services/music-api.ts'))+'\nglobalThis.api=musicApi;',music);
const musicApi=music.api;
musicApi.urlCacheSet('qq:1:320','https://old-source');
const resolved=await musicApi.resolvePlayUrl(a,'320','qq:1:320');
assert.equal(resolved.url,'https://audio/wyy');
assert.equal((await musicApi.resolvePlayUrl(a,'320','qq:1:320')).url,resolved.url);
assert.equal(engineCalls.join(','),'wyy');
ctx.pref.savePreferredSource(a,c);
assert.equal((await musicApi.resolvePlayUrl(a,'320','qq:1:320')).url,'https://audio/kw');
disk.set('qq:1','wrong old lyric');disk.set('qq:1:wbw','wrong old karaoke');
assert.equal(musicApi.cachedLyric(a),'');
musicApi.engineInvoke=async()=>new Utso({lyric:'[00:01]chosen lyric',translation:'',wordByWord:'',romanization:''});
assert.equal(await musicApi.lyrics(a),'[00:01]chosen lyric');
assert.equal(musicApi.cachedLyricWordByWord(a),'');
assert.equal(musicApi.cachedLyric(a),'[00:01]chosen lyric');
// Explicit lyric choice still takes priority over the playback source.
musicApi.lyricPickCache={'qq:1':b};assert.equal(musicApi.lyricKeyOf(a),'qq:1');
// An old in-flight URL must not attach its lyric target after a later manual choice.
const racing=song('qq','race'),racingPick=song('wyy','race-choice');
let finishOld;
music.getPlayUrlByEngineResult=()=>new Promise(resolve=>{finishOld=resolve;});
musicApi.normalizeOfficialQuality=(_platform,quality)=>quality;
const racingUrl=musicApi.playUrl(racing,'320');
ctx.pref.savePreferredSource(racing,racingPick);
music.getPlayUrlByEngineResult=async()=>({url:'https://audio/latest',line:null,actualQuality:'320',size:10,stalled:false});
finishOld({url:'https://audio/late-old',line:null,actualQuality:'320',size:10,stalled:false});
assert.equal(await racingUrl,'https://audio/latest');
// Persistent preferences are not an evictable URL cache. Exercise a cold-start restore.
storage.clear();ctx.pref.savePreferredSource(a,b);
for(let i=0;i<600;i++)ctx.pref.savePreferredSource(song('qq','bulk-'+i),song('wyy','bulk-'+i));
assert.equal(ctx.pref.preferredSource(a).platform,'wyy');
let largeReads=0;
const restored=vm.createContext({
  Map,Set,songFromJson:JSON.parse,songToJson:JSON.stringify,
  uni:{getStorageSync:k=>{if(!k.endsWith(':revision'))largeReads++;return storage.get(k)??'';},setStorageSync:(k,v)=>storage.set(k,v)},
});
vm.runInContext(compile(read('services/preferred-source.ts'))+'\nglobalThis.pref={preferredSource};',restored);
for(let i=0;i<50;i++)assert.equal(restored.pref.preferredSource(a).platform,'wyy');
assert.equal(largeReads,1,'the complete preference record is read once per revision');
console.log('source/collection: preference chains, cache source identity, local-first timeline, lyrics, version selection, cancel/stale scope and durable scoped commit passed');
