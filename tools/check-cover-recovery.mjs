import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import { reactive, effect, stop } from 'vue';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8').replaceAll('\r\n','\n');
const between=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)+a.length));
const strip=s=>stripTypeScriptTypes(s.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*/gm,'').replace(/\bexport /g,''),{mode:'strip'});
const source=read('stores/player.ts');
let disk='', downloaded='', fetches=[], savedUrls=[], invalidated=0, resolveNetwork;
const ctx={
  musicApi:{songCover:async(s,refresh=false)=>{fetches.push({pic:s.picUrl,refresh});return resolveNetwork?await new Promise(r=>resolveNetwork=r):refresh?'https://fresh':'https://cover';}},
  cachedCoverFile:()=>disk,cacheCoverFile:async(_key,url)=>{savedUrls.push(url);return downloaded;},
  invalidateCachedCover:()=>{invalidated++;disk='';},statLocalFile:()=>-1,
  isLocalAudioPath:p=>!!p&&(p.startsWith('/')||p.startsWith('file:')||p.startsWith('unifile:')),
  audioPlayer:{setTrackCover(){}},logMsg(){},logMsgWarn(){},
};
const api=runInNewContext(strip(between(source,'function imageSrcOfLocal','/** 歌曲 key 安全化')+between(source,'class PlayerStore {','\nconst player = reactive(new PlayerStore())'))+'\n({PlayerStore,imageSrcOfLocal,coverSrcUsable})',ctx);
const song=()=>({id:'a',platform:'wyy',name:'自由的你',singer:'G.E.M.邓紫棋',picUrl:'',url:'/song.mp3'});
const host=()=>{const s=song();return Object.assign(Object.create(api.PlayerStore.prototype),{current:s,playSeq:1,coverLoads:new Map(),coverRetryAt:new Map(),embeddedCover:'',embeddedCoverKey:'',embeddedDiag:'内嵌标签：封面 0B',embeddedDiagKey:'wyy:a',localPathByMid:new Map([['wyy:a','/song.mp3']]),applyCover(song,url){song.picUrl=url;}});};
const wait=async p=>{await Promise.all([...p.coverLoads.values()]);await Promise.resolve();};
function reset(){disk='';downloaded='';fetches=[];savedUrls=[];resolveNetwork=null;invalidated=0;}
reset();{
  const p=host();disk='/private/media-cover-a.img';p.resolveLocalCover(p.current,null);
  assert.equal(p.coverOf(p.current),'file:///private/media-cover-a.img');assert.equal(fetches.length,0);
  p.current.picUrl='/private/legacy.jpg';assert.equal(p.coverOf(p.current),'file:///private/legacy.jpg');
  p.current.picUrl='file:///private/legacy.jpg';assert.equal(p.coverOf(p.current),p.current.picUrl);
  disk='/private/media-cover-wyy%3A3436855494.img';p.resolveLocalCover(p.current,null);
  assert.equal(p.coverOf(p.current),'file:///private/media-cover-wyy%253A3436855494.img','literal percent in cache filename survives Android URI decoding');
}
reset();{
  const p=host();downloaded='/private/downloaded.img';p.current.picUrl='file:///private/removed.img';
  p.resolveLocalCover(p.current,null);p.resolveLocalCover(p.current,null);await wait(p);
  assert.equal(fetches.length,1);assert.equal(fetches[0].pic,'','missing file cannot short-circuit API');
  assert.equal(p.coverOf(p.current),'file:///private/downloaded.img');assert.match(p.embeddedDiag,/联网补齐并缓存/);
}
reset();{
  const p=host();p.current.picUrl='https://expired';p.resolveLocalCover(p.current,null);await wait(p);
  assert.equal(fetches.length,2);assert.equal(fetches[1].refresh,true);assert.equal(p.current.picUrl,'https://fresh');
}
reset();{
  const p=host();p.persistEmbeddedCover=()=>'/private/embedded.jpg';p.resolveLocalCover(p.current,{coverPath:'/cache/cover.jpg'});
  assert.equal(fetches.length,0);assert.equal(p.coverOf(p.current),'file:///private/embedded.jpg');
}
reset();{
  const p=host();resolveNetwork=true;p.resolveLocalCover(p.current,null);const old=p.current;
  p.current={...song(),id:'b',picUrl:'https://b'};p.playSeq++;resolveNetwork('https://late');await wait(p);
  assert.equal(p.current.picUrl,'https://b');assert.equal(old.picUrl,'','stale response cannot update another track');
}
reset();{
  const p=host();disk='/private/broken.img';p.current.picUrl='file:///private/broken.img';resolveNetwork=true;
  p.recoverCover(p.current,p.current.picUrl);p.recoverCover(p.current,'file:///private/broken.img');
  assert.equal(invalidated,1);resolveNetwork('https://new');await wait(p);
  p.recoverCover(p.current,p.current.picUrl);assert.equal(invalidated,1,'failed decoder retry is bounded');
}
reset();{
  const p=host();let applied=0,completed;
  ctx.readSongEmbedded=()=>new Promise(r=>completed=r); // vm reads shared context object's new binding below
  const methods=between(source,'  private syncLocalFileMedia(', '  /** 内嵌标签落地');
  const helper=runInNewContext(strip('class Extras { '+methods+' }')+'\nExtras',{readSongEmbedded:()=>new Promise(r=>completed=r)});
  p.applyLocalFileMedia=()=>applied++;p.resolveLocalCover=()=>applied++;
  helper.prototype.syncLocalFileMedia.call(p,p.current,'/song.mp3');completed(null);await Promise.resolve();
  assert.equal(applied,2,'late local lookup completes both embedded and online cover fallback');
}
// Run API cover methods: refreshing must bypass an expired URL without touching audio URI.
{
  const raw=song();const p=reactive(Object.assign(Object.create(api.PlayerStore.prototype),{
    current:raw,queue:[raw],getPlaylistsContainingSong:()=>[],persist(){},
  }));
  let displayed='',renders=0;
  const runner=effect(()=>{displayed=p.current.picUrl;renders++;});
  p.applyCover(raw,'https://downloaded-cover');
  assert.equal(displayed,'https://downloaded-cover','already-mounted artwork reacts even when caller holds raw Song');
  assert.ok(renders>1);assert.equal(raw.picUrl,displayed);assert.equal(p.queue[0].picUrl,displayed);stop(runner);
}
{
  const methods=between(read('services/music-api.ts'),'  async songCover(', '  /**\n   * 清空全部歌词缓存');
  class Json {set(k,v){this[k]=v;}get(k){return this[k];}}
  const CoverApi=runInNewContext(strip('class CoverApi { '+methods+' }')+'\nCoverApi',{UTSJSONObject:Json});
  const a=new CoverApi();let args; a.songArgsOf=s=>s;a.strOf=s=>s??'';a.engineInvoke=async(_name,value)=>{args=value;return{get:()=> 'https://refreshed'};};
  const s={...song(),picUrl:'https://expired'};assert.equal(await a.songCover(s,true),'https://refreshed');
  assert.equal(args.song.picUrl,'');assert.equal(args.song.url,'/song.mp3');assert.equal(s.picUrl,'https://expired');
  let query='',limit=0;
  a.search=async(keyword,_source,_kind,_page,pageSize)=>{query=keyword;limit=pageSize;return[
    {...s,name:'自由的你 (Live)',picUrl:'https://wrong-live'},
    {...s,singer:'翻唱歌手',picUrl:'https://wrong-singer'},
    {...s,duration:120,picUrl:'https://wrong-length'},
    {...s,duration:296,picUrl:'https://local-match'},
  ];};
  assert.equal(await a.songCover({...s,platform:'local',name:'自由的你 (1)',duration:296},true),'https://local-match');
  assert.equal(query,'G.E.M.邓紫棋 自由的你');assert.equal(limit,5);
  a.search=async()=>[{...s,picUrl:'https://studio'}];
  assert.equal(await a.songCover({...s,platform:'local',name:'自由的你 (Live)'},true),'','keep genuine version suffixes');
}
console.log('cover recovery: readable disk URI, missing-file fallback, embedded priority, refresh, deduplication and stale-song guards passed');

{
  const files=new Set(['unifile://usr//media-cover-wyy%3Aa.img']);let requests=0;
  const fs={accessSync:p=>{if(!files.has(p))throw Error('missing');},copyFileSync:(s,d)=>{if(!files.has(s))throw Error('missing');files.add(d);},unlinkSync:p=>files.delete(p)};
  const diskApi=runInNewContext(strip(read('services/cover-disk-cache.ts'))+'\n({cacheCoverFile,cachedCoverFile,invalidateCachedCover})',{
    uni:{env:{USER_DATA_PATH:'unifile://usr/'},getFileSystemManager:()=>fs,getStorageSync:()=>'',setStorageSync(){}},
    downloadPublicCover:async()=>{requests++;files.add('/temp');return '/temp';},
  });
  const migrated=diskApi.cachedCoverFile('wyy:a');assert.ok(migrated.startsWith('unifile://usr/media-cover-v2-'));assert.ok(!migrated.includes('%'));
  assert.equal(await diskApi.cacheCoverFile('wyy:a','https://cover'),migrated);assert.equal(requests,0,'valid old cache migrates without network');
  diskApi.invalidateCachedCover('wyy:a');assert.equal(files.has(migrated),false);assert.equal(diskApi.cachedCoverFile('wyy:a'),'','bad legacy cache cannot come back');
  await diskApi.cacheCoverFile('wyy:a','https://cover');assert.equal(requests,1);
  const other=await diskApi.cacheCoverFile('wyy%3Aa','https://cover');assert.notEqual(other,migrated,'distinct keys never share a cache file');
}
console.log('cover cache: unifile-safe names, legacy migration and invalidation passed');
