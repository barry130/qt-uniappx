import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const js = source => stripTypeScriptTypes(source.replace(/^import .*;$/gm, '').replace(/export /g, ''), { mode: 'strip' });
const math = runInNewContext(js(read('uni_modules/qt-ui/composables/player-presentation.ts')) + '\n({playerQueueMetrics,playerQueueWindow})');
const actions = runInNewContext(js(read('uni_modules/qt-ui/composables/playback-queue.ts')) + '\n({removePlaybackQueueItem,movePlaybackQueueItem,playbackQueueMetrics})', math);
const { removePlaybackQueueItem: remove, movePlaybackQueueItem: move, playbackQueueMetrics: metrics } = actions;
const song = id => ({id,platform:'local',name:id,singer:'artist'});
function store(queue, current = queue[0]) {
  return {
    queue, current, effects: [], currentIndex() { return this.queue.indexOf(this.current); },
    play(item) { this.current = item; this.effects.push('play:' + item.id); return Promise.resolve(); },
    syncTimeline() { this.effects.push('sync'); }, persist() { this.effects.push('persist'); },
    stop() { this.current = null; this.queue = []; this.effects.push('stop'); },
  };
}
const original = song('same'), duplicate = song('same'), next = song('next');
const p = store([original, duplicate, next]);
remove(p, 1);
assert.equal(p.current, original, 'removing a duplicate leaves current playback intact');
assert.deepEqual(p.effects, ['sync','persist']);
move(p, 0, 1);
assert.equal(p.current, original);
assert.equal(p.queue[1], original);
assert.deepEqual(p.effects.slice(2), ['sync','persist'], 'reorder must sync without restarting');
remove(p, 1);
assert.equal(p.current, next, 'removing current tail plays the remaining neighbour');
remove(p, 0);
assert.equal(p.current, null);
assert.equal(p.queue.length, 0);
assert.equal(p.effects.at(-1), 'stop', 'last item removal stops audio too');
const invalid = store([song('one')]);
for (const index of [-1,1,30]) remove(invalid, index);
move(invalid, 0, -1); move(invalid, 0, 1);
assert.deepEqual(invalid.effects, []);

for (const [width,height,wide] of [[320,568,false],[393,852,false],[600,360,true],[960,540,true],[1280,800,true],[1920,1080,true]]) {
  for (const scale of [0.8,1,1.3,1.5]) for (const count of [0,1,2,10000]) {
    const m = metrics(width,height,wide,24,16,76,scale,count);
    assert.ok(m.viewportPx >= 0);
    assert.ok(m.viewportPx + m.headerPx + m.insetBottomPx + m.panelBottomPx + 24 <= height);
    if (count <= 2) assert.ok(m.viewportPx <= m.stridePx * 2, 'short queues shrink to content');
    const w = math.playerQueueWindow(count,m.stridePx,m.viewportPx,500000,5);
    assert.ok(w.last - w.first < 30, 'large queues render a bounded window');
    assert.ok(w.scrollPx <= w.maxScrollPx);
  }
}

// Execute the real bar handler: only a local event is permitted, never route navigation.
const bar = read('uni_modules/qt-ui/components/qt-player-bar/qt-player-bar.uvue');
const open = bar.match(/function openQueue\(\): void \{[\s\S]*?\n\}/)[0];
const emitted = [];
runInNewContext(js(open) + '\nopenQueue()', { emit: e => emitted.push(e), uni: { navigateTo() { throw new Error('queue navigated'); } } });
assert.deepEqual(emitted, ['queue']);
for (const name of ['qt-page-frame','qt-wide-workspace']) {
  const owner = read(`uni_modules/qt-ui/components/${name}/${name}.uvue`);
  assert.match(owner, /<qt-player-bar[^>]+@queue="queueOpen = true"/);
  assert.match(owner, /<qt-playback-queue v-if="queueOpen" @close="queueOpen = false"/);
}
const overlay = runInNewContext(js(read('uni_modules/qt-ui/composables/playback-queue-overlay.ts')) + '\n({registerPlaybackQueueClose,unregisterPlaybackQueueClose,closePlaybackQueue})');
let closed = 0;
const old = () => { closed += 1; }, current = () => { closed += 10; };
overlay.registerPlaybackQueueClose(old); overlay.registerPlaybackQueueClose(current);
overlay.unregisterPlaybackQueueClose(old);
assert.equal(overlay.closePlaybackQueue(), true);
assert.equal(closed, 10, 'an old page unmount must not dismiss the newer queue');
assert.equal(overlay.closePlaybackQueue(), false, 'back is consumed exactly once');
console.log('playback queue: in-place opening, duplicate removal, native timeline, bounded windows and back dismissal passed');
