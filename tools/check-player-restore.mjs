// Execute the production restore/migration/persistence methods and cache action.
// Only storage, native audio, collection sync and the stats IO boundary are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const compile = source => stripTypeScriptTypes(source.replace(/^import[\s\S]*?\bfrom\s*["'][^"']+["'];?\s*/gm, ''), { mode: 'strip' }).replace(/^export /gm, '');
const noop = () => {};
class Json {
  get(key) { return this[key] ?? null; }
  set(key, value) { this[key] = value; }
  static keys(value) { return Object.keys(value); }
}
const song = id => ({ id, platform: 'qq', name: id, singer: 'Artist', album: '', picUrl: '', duration: 240 });
const keyOf = {
  state: 'qt-player-state', history: 'qt-history-songs', local: 'qt-local-playlists', liked: 'qt-liked-songs',
};
const playerSource = read('stores/player.ts');
const playerCode = playerSource.slice(0, playerSource.indexOf('\n/** 收藏同步引擎单例。'));
const httpSource = read('services/http.ts');
const jsonCode = httpSource.slice(httpSource.indexOf('function jsonValueToUtso('));

function fixture() {
  const storage = new Map(), writes = [], events = [];
  const context = vm.createContext({
    console, UTSJSONObject: Json,
    uni: {
      getStorageSync: key => storage.get(key) ?? '',
      setStorageSync(key, value) { writes.push([key, value]); storage.set(key, value); },
      removeStorageSync: key => storage.delete(key), $on: noop,
    },
    ListenSession: class { start() {} resetSample() {} },
    collectionStorageKey: key => key, prepareCollectionStorage: noop,
    likeSync: () => ({ load: noop }), generateGlobalPid: () => 'migrated-pid',
    DEFAULT_PLAYLIST_COVER_ASSET: '/static/icon.png', DISLIKES_CHANGED_EVENT: 'dislikes', SOURCE_POLICY_CHANGED_EVENT: 'source-policy',
    useListenStatsStore: () => ({ load: () => events.push('stats-load'), flush: () => events.push('stats-flush') }),
    audioPlayer: {
      bind: noop, onResolveRequest: noop, onDlnaResolveRequest: noop, onTrackChanged: noop, onSetRating: noop,
      pause: () => events.push('pause'), stop: () => events.push('stop'),
      clearAudioCache: () => { events.push('clear-cache'); return true; },
    },
    setInterval: () => 1, clearInterval: noop, isLocalAudioPath: () => false,
    isHarmonyOs: () => false,
  });
  vm.runInContext(compile(jsonCode + '\n' + read('stores/persist-codec.ts') + '\n' + playerCode)
    + '\nglobalThis.api = {PlayerStore, songToJson, playlistToJson};', context);
  const { PlayerStore, songToJson, playlistToJson } = context.api;
  function seed({ legacy = false, current = true, queue = true, radio = false } = {}) {
    const a = song('saved-track'), b = song('next-track');
    const state = { mode: 'random', quality: 'flac', queue: queue ? [a, b, a].map(songToJson) : [], currentIndex: 2,
      progress: 37.5, duration: 240, lockedNext: 'qq:next-track', playCounts: { 'qq:saved-track': 4 } };
    if (current) state.current = songToJson(a);
    storage.set(keyOf.state, JSON.stringify(radio ? { current: songToJson(song('radio-track')), queue: [], radioBackup: JSON.stringify(state) } : state));
    storage.set(keyOf.history, JSON.stringify([songToJson(a), songToJson(b)]));
    storage.set(keyOf.local, JSON.stringify([playlistToJson({ id: 'legacy', name: 'Local playlist', platform: 'local',
      picUrl: '/static/logo.png', playCount: '0', tracks: legacy ? [a, b] : [], pid: legacy ? undefined : 'existing-pid' })]));
    return state;
  }
  return { storage, writes, events, context, PlayerStore, seed };
}

let passed = 0;
async function check(name, fn) { await fn(); console.log('PASS ' + name); passed++; }
for (const legacy of [false, true]) await check('cold start preserves paused current, exact queue occurrence and progress; legacy=' + legacy, () => {
  const f = fixture(); f.seed({ legacy });
  const player = new f.PlayerStore(); player.restore();
  assert.equal(player.current?.id, 'saved-track', 'restoring collections must not overwrite the unread playback snapshot');
  assert.equal(player.queue.length, 3); assert.equal(player.current, player.queue[2]);
  assert.equal(player.playing, false); assert.equal(player.progress, 37.5); assert.equal(player.duration, 240);
  assert.equal(player.mode, 'random'); assert.equal(player.quality, 'flac'); assert.equal(player.lockedNextMid, 'qq:next-track');
  assert.equal(player.playCounts.get('qq:saved-track'), 4); assert.equal(player.history.length, 2);
  assert.ok(f.events.indexOf('stats-load') < f.events.indexOf('stats-flush'), 'stats must load before migration can flush');
  for (const [, text] of f.writes.filter(([key]) => key === keyOf.state)) {
    assert.equal(JSON.parse(JSON.parse(text).current).id, 'saved-track', 'no intermediate write may replace the saved current with an empty state');
  }
  if (legacy) {
    assert.equal(player.likedSongs.length, 2);
    assert.equal(player.likedSongs[0].pids[0], 'migrated-pid');
    assert.equal(player.localPlaylists[0].tracks.length, 0);
    const again = new f.PlayerStore(); again.restore();
    assert.equal(again.current?.id, 'saved-track'); assert.equal(again.queue.length, 3);
    assert.equal(again.likedSongs.length, 2, 'migration remains idempotent');
  }
});
await check('standalone current without a queue survives legacy collection migration', () => {
  const f = fixture(); f.seed({ legacy: true, queue: false });
  const player = new f.PlayerStore(); player.restore();
  assert.equal(player.current?.id, 'saved-track'); assert.equal(player.queue.length, 0); assert.equal(player.progress, 37.5);
});
for (const empty of [false, true]) await check('FM restart preserves ordinary snapshot through migration; empty=' + empty, () => {
  const f = fixture(); f.seed({ legacy: true, current: !empty, queue: !empty, radio: true });
  const player = new f.PlayerStore(); player.restore();
  assert.equal(player.current?.id ?? null, empty ? null : 'saved-track');
  assert.equal(player.queue.length, empty ? 0 : 3); assert.equal(player.radioActive, false); assert.equal(player.playing, false);
});
await check('fresh install and explicitly empty queue never adopt unrelated listening history', () => {
  for (const seeded of [false, true]) {
    const f = fixture(); if (seeded) f.seed({ legacy: true, current: false, queue: false });
    const player = new f.PlayerStore(); player.restore();
    assert.equal(player.current, null); assert.equal(player.queue.length, 0); assert.equal(player.playing, false);
  }
});
for (const playing of [false, true]) await check('audio cache clearing retains current/queue/progress on page and next launch; playing=' + playing, async () => {
  const f = fixture(); f.seed(); const player = new f.PlayerStore(); player.restore(); player.playing = playing;
  const revision = player.playbackRevision();
  f.context.player = player;
  const page = read('pages/cache/index.uvue');
  const start = page.indexOf('async function clearItem('), end = page.indexOf('\n  if (id == "playUrl")', start);
  vm.runInContext(compile(page.slice(start, end) + '\nreturn false;\n}') + '\nglobalThis.clearItem = clearItem;', f.context);
  assert.equal(await f.context.clearItem('audio'), true);
  assert.equal(player.current?.id, 'saved-track'); assert.equal(player.queue.length, 3); assert.equal(player.progress, 37.5);
  assert.equal(player.playing, false); assert.ok(player.playbackRevision() > revision, 'cancel any in-flight play before releasing cache files');
  assert.deepEqual(f.events.filter(event => ['pause', 'stop', 'clear-cache'].includes(event)), ['pause', 'clear-cache']);
  const again = new f.PlayerStore(); again.restore();
  assert.equal(again.current?.id, 'saved-track'); assert.equal(again.current, again.queue[2]); assert.equal(again.progress, 37.5);
});
console.log('player restore / cache: ' + passed + ' groups passed (production source; synthetic IO boundaries)');
