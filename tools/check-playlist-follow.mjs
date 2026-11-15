// Execute the production follow service, persistence codec, membership method and
// outbox. Only storage, remote metadata and the surrounding player host are fakes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { sourcePolicyFixture } from './source-policy-fixture.mjs';
const read = p => readFileSync(new URL('../'+p, import.meta.url), 'utf8');
const compile = s => stripTypeScriptTypes(s.replace(/^import[\s\S]*?from\s*["'][^"']+["'];?\s*/gm,'').replace(/^export /gm,''),{mode:'strip'});
class Utso {
  constructor(data={}) { Object.assign(this,data); }
  get(k) { return this[k] ?? null; }
  getString(k) { return this.get(k); }
  getNumber(k) { return this.get(k); }
  getBoolean(k) { return this.get(k); }
  set(k,v) { this[k]=v; }
}
const song = id => ({id,platform:'wyy',name:id,singer:'Singer',album:'',picUrl:''});
const key = id => JSON.stringify(['wyy',id]);
const plain = v => JSON.parse(JSON.stringify(v));
function boot(storage=new Map(), owner='A') {
  const env={storage,owner,epoch:1,remote:null,fail:null};
  const uni={getStorageSync:k=>storage.get(k)??'',setStorageSync:(k,v)=>{if(env.fail===k)throw Error('disk full');storage.set(k,v);},removeStorageSync:k=>{if(env.fail==='remove:'+k)throw Error('disk full');storage.delete(k);},$emit(){}};
  const ctx=vm.createContext({uni,...sourcePolicyFixture(uni),UTSJSONObject:Utso,parseJsonToUtso:s=>new Utso(JSON.parse(s)),
    getUserId:()=>env.owner,getSessionEpoch:()=>env.epoch,sessionIsCurrent:e=>e===env.epoch,
    getAccessToken:()=>'',logMsg(){},logWarn(){},musicApi:{playlist:async()=>{if(env.remote instanceof Error)throw env.remote;return await env.remote;}}});
  const load=(path,names)=>vm.runInContext(compile(read(path))+'\n({'+names+'})',ctx);
  const codec=load('stores/persist-codec.ts','songToJson,songFromJson');
  const transaction=load('services/collection-transaction.ts','prepareCollectionWrite,registerCollectionRecovery');
  const collection=load('services/collection-storage.ts','collectionStorageKey,prepareCollectionStorage,adoptGuestCollections');
  const {LikeSyncEngine}=load('services/like-sync.ts','LikeSyncEngine');
  const player={localPlaylists:[{id:'local1',pid:'p1',platform:'local'}],savedPlaylists:[],likedSongs:[],
    playlistPidOf:id=>id==='local1'?'p1':'',
    findCollectedSong(s){return this.likedSongs.findIndex(t=>t.id===s.id&&t.platform===s.platform);},
    addPidToSong(s,pid){s.pids??=[];if(!s.pids.includes(pid))s.pids.push(pid);},
    removePidFromSong(s,pid){const found=s.pids.includes(pid);s.pids=s.pids.filter(p=>p!==pid);return found;},
    likeSongPayloadJson:(s,pid)=>JSON.stringify({sid:s.id,platform:s.platform,pid,name:s.name,singer:s.singer,album:s.album}),
    refreshNativeRating(){},flushPendingOps:async()=>{},
    songsOfPid(pid){return this.likedSongs.filter(s=>s.pids?.includes(pid));}};
  const engine=new LikeSyncEngine(player);engine.load();
  const stored=storage.get(collection.collectionStorageKey('qt-liked-songs'));
  if(stored)player.likedSongs=JSON.parse(stored).map(codec.songFromJson);
  ctx.usePlayerStore=()=>player;ctx.likeSync=()=>engine;ctx.LIKED_KEY='qt-liked-songs';
  const src=read('stores/player.ts'); const a=src.indexOf('  applyFollowMembership('), b=src.indexOf('\n  /**',a);
  const Host=vm.runInContext(compile('class Host {\n'+src.slice(a,b)+'\n}\nHost'),ctx);
  player.applyFollowMembership=Host.prototype.applyFollowMembership;
  const removeStart=src.indexOf('  private removeSongFromPid('),removeEnd=src.indexOf('\n  /**',removeStart);
  player.removeSongFromPid=vm.runInContext(compile('class ManualHost {\n'+src.slice(removeStart,removeEnd)+'\n}\nManualHost'),ctx).prototype.removeSongFromPid;
  player.pushSongPid=(s,pid,action)=>engine.enqueueLikeOpsDurably([{type:'song',action,dataJson:player.likeSongPayloadJson(s,pid)}]);
  player.persist=()=>uni.setStorageSync(collection.collectionStorageKey('qt-liked-songs'),JSON.stringify(player.likedSongs.map(codec.songToJson)));
  const api=load('services/playlist-follow.ts','importWithPlaylistFollow,playlistFollow,previewPlaylistFollow,applyPlaylistFollow,recoverPlaylistFollow,togglePlaylistFollow,refreshDuePlaylistFollows');
  const remote=ids=>({id:'remote1',platform:'wyy',name:'Source',complete:true,tracks:ids.map(song)});
  return {...env,env,player,engine,api,codec,collection,remote,transaction,
    ids:()=>player.songsOfPid('p1').map(s=>s.id),
    seed:ids=>{player.likedSongs=ids.map(id=>({...song(id),pids:['p1']}));},
    import:ids=>api.importWithPlaylistFollow(player.localPlaylists[0],remote(ids),env.epoch)};
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS follow: '+name);}
await test('three-way merge preserves local additions/deletions and protected pre-import songs',async()=>{
  const h=boot();h.seed(['P']);assert.equal(h.import(['A','B','C','P','A']),3);
  h.player.likedSongs=h.player.likedSongs.filter(s=>s.id!=='B');h.player.likedSongs.push({...song('X'),pids:['p1']});
  h.env.remote=h.remote(['A','B','D','D']);const p=await h.api.previewPlaylistFollow('p1');
  assert.deepEqual(plain(p.added.map(s=>s.id)),['D']);assert.deepEqual(plain(p.removed.map(s=>s.id)),['C']);
  h.api.applyPlaylistFollow(p);assert.deepEqual(plain(h.ids()),['P','A','X','D']);
  h.env.remote=h.remote(['A','B','D','E']);h.api.applyPlaylistFollow(await h.api.previewPlaylistFollow('p1'));
  assert.deepEqual(plain(h.ids()),['P','A','X','D','E']);assert.ok(h.api.playlistFollow('p1').suppressed.includes(key('B')));
});
await test('missing baseline only checkpoints; incomplete responses and duplicate associations are refused',async()=>{
  const h=boot();h.import(['A']);assert.throws(()=>h.import(['B']),/已经关联/);
  const sk='qt-playlist-follow-v1:A';const row=JSON.parse(JSON.parse(h.storage.get(sk))[0]);row.baseline=null;
  h.storage.set(sk,JSON.stringify([JSON.stringify(row)]));h.env.remote=h.remote(['B']);
  const p=await h.api.previewPlaylistFollow('p1');assert.equal(p.added.length+p.removed.length,0);h.api.applyPlaylistFollow(p);
  h.env.remote={...h.remote(['C']),complete:false};await assert.rejects(h.api.previewPlaylistFollow('p1'),/完整/);assert.deepEqual(plain(h.ids()),['A']);
});
await test('local edits, settings changes, account changes and a stale remote response reject commit',async()=>{
  const h=boot();h.import(['A']);h.env.remote=h.remote(['A','B']);
  let p=await h.api.previewPlaylistFollow('p1');h.player.likedSongs.push({...song('X'),pids:['p1']});assert.throws(()=>h.api.applyPlaylistFollow(p),/歌曲已变化/);
  p=await h.api.previewPlaylistFollow('p1');h.api.togglePlaylistFollow('p1');assert.throws(()=>h.api.applyPlaylistFollow(p),/设置已变化/);
  p=await h.api.previewPlaylistFollow('p1');h.env.epoch++;assert.throws(()=>h.api.applyPlaylistFollow(p),/账号已变化/);
  let finish;h.env.remote=new Promise(r=>{finish=r;});const pending=h.api.previewPlaylistFollow('p1');h.env.epoch++;finish(h.remote(['A']));await assert.rejects(pending,/账号已变化/);
});
for(const boundary of ['qt-liked-songs:A','qt-like-pending-ops:A','qt-playlist-follow-v1:A','remove:qt-playlist-follow-v1:A:journal']) {
  await test('restart recovers membership/outbox/checkpoint after failure at '+boundary,async()=>{
    const h=boot();h.import(['A']);h.env.remote=h.remote(['B']);const p=await h.api.previewPlaylistFollow('p1');h.env.fail=boundary;
    // The outbox key is asserted below; a renamed storage contract must update this fixture.
    assert.throws(()=>h.api.applyPlaylistFollow(p),/disk full/);
    const restored=boot(h.storage);restored.api.recoverPlaylistFollow();restored.api.recoverPlaylistFollow();
    assert.deepEqual(plain(restored.ids()),['B']);assert.equal(restored.api.playlistFollow('p1').baseline[0],key('B'));
    assert.equal(restored.storage.has('qt-playlist-follow-v1:A:journal'),false);
    const ops=restored.engine.pendingOps;assert.ok(ops.some(o=>o.action==='add'&&JSON.parse(o.dataJson).sid==='B'));
    assert.ok(ops.some(o=>o.action==='remove'&&JSON.parse(o.dataJson).sid==='A'));
    assert.equal(ops.filter(o=>o.action==='add'&&JSON.parse(o.dataJson).sid==='B').length,1);
  });
}
await test('durable replay dedup preserves add/remove/add order and other playlists',()=>{
  const h=boot();const op=(action,pid='p1')=>({type:'song',action,dataJson:JSON.stringify({sid:'S',platform:'wyy',pid})});
  h.engine.enqueueLikeOpsDurably([op('add'),op('add'),op('remove'),op('add'),op('add','p2')]);
  assert.deepEqual(plain(h.engine.pendingOps.map(o=>o.action)),['add','remove','add','add']);
});
await test('a newer manual edit completes an interrupted checkpoint first and cannot be reverted by replay',async()=>{
  const h=boot();h.import(['A']);h.env.remote=h.remote(['B']);const preview=await h.api.previewPlaylistFollow('p1');
  h.env.fail='qt-playlist-follow-v1:A';assert.throws(()=>h.api.applyPlaylistFollow(preview),/disk full/);
  assert.throws(()=>h.player.removeSongFromPid(song('B'),'p1'),/disk full/,'failed recovery blocks later writes');
  assert.deepEqual(plain(h.ids()),['B']);h.env.fail=null;h.player.removeSongFromPid(song('B'),'p1');
  h.api.recoverPlaylistFollow();assert.deepEqual(plain(h.ids()),[]);
  assert.equal(h.storage.has('qt-playlist-follow-v1:A:journal'),false);
  assert.deepEqual(plain(h.engine.pendingOps.filter(o=>JSON.parse(o.dataJson).sid==='B').map(o=>o.action)),['add','remove']);
  const restarted=boot(h.storage);restarted.api.recoverPlaylistFollow();assert.deepEqual(plain(restarted.ids()),[]);
});
await test('collection upgrade retries after interruption and returning owners restore only their partition',()=>{
  const h=boot();h.storage.set('qt-like-account','A');h.storage.set('qt-liked-songs','A songs');h.storage.set('qt-local-playlists','A lists');
  h.env.fail='qt-local-playlists:A';assert.throws(()=>h.collection.prepareCollectionStorage(),/disk full/);
  assert.equal(h.storage.has('qt-collection-storage-v1'),false);h.env.fail=null;h.collection.prepareCollectionStorage();
  h.env.owner='B';assert.equal(h.storage.get(h.collection.collectionStorageKey('qt-liked-songs')),undefined);
  h.storage.set(h.collection.collectionStorageKey('qt-liked-songs'),'B songs');h.env.owner='A';
  assert.equal(h.storage.get(h.collection.collectionStorageKey('qt-liked-songs')),'A songs');assert.equal(h.collection.collectionStorageKey('qt-play-history'),'qt-play-history');
});
await test('first login adopts guest collections and follow baseline without overwriting returning owner data',()=>{
  const h=boot(new Map(),'');h.storage.set('qt-liked-songs','guest songs');h.storage.set('qt-playlist-follow-v1:guest','guest baseline');
  h.collection.adoptGuestCollections('A');assert.equal(h.storage.get('qt-liked-songs:A'),'guest songs');assert.equal(h.storage.get('qt-playlist-follow-v1:A'),'guest baseline');
  h.env.owner='A';h.collection.adoptGuestCollections('B');assert.equal(h.storage.has('qt-liked-songs:B'),false);
});
console.log(`playlist follow: ${passed} production behavior groups passed`);
