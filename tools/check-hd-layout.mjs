import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { qtHdHomeMetrics, qtHdPlayerMetrics } from "../uni_modules/qt-ui/composables/hd-layout.ts";
import "./check-playback-queue.mjs";

for (const width of [488, 540, 724, 1136, 1504, 1600]) {
  let previousColumns = 3;
  for (const scale of [1, 1.15, 1.5]) {
    const m = qtHdHomeMetrics(width, scale);
    assert.ok(m.cardPx >= 136 && m.cardPx <= 180, 'cover remains within reviewed HD sizes');
    assert.ok(m.songColumns >= 1 && m.songColumns <= previousColumns, 'larger type must not add columns');
    assert.ok(m.songColumns * m.songPx + (m.songColumns - 1) * 24 <= m.innerPx, 'actual row and gaps fit');
    if (m.featureSplit) {
      assert.equal(m.featurePx + m.shortcutPx + 16, m.innerPx);
      assert.ok(m.featurePx >= 440, 'feature must retain readable title space');
    } else assert.equal(m.featurePx, m.innerPx);
    previousColumns = m.songColumns;
  }
}
for (const width of [544, 772, 1184, 1824]) {
  const m = qtHdPlayerMetrics(width, 1.3);
  assert.equal(m.wingPx * 2 + m.centerPx, Math.max(0, Math.floor(width) - 32));
  assert.equal(m.copyPx >= 0, true);
  assert.equal(m.timePx >= 42, true);
  assert.ok(m.centerPx >= 148, 'all three 40px transport targets and 28px spacing fit');
  assert.ok(m.wingPx >= (m.showVolume ? 216 : 80), 'mode, queue and optional volume fit');
}
// Execute the production seek handlers across a song replacement and replay of
// the same song. The native slider is the event boundary; the store is mocked.
const bar = readFileSync(new URL('../uni_modules/qt-ui/components/qt-player-bar/qt-player-bar.uvue', import.meta.url), 'utf8');
const handlers = bar.slice(bar.indexOf('let seekTrackKey ='), bar.indexOf('// ── 收藏'));
const sought = [];
let revision = 1;
const player = { current: {platform:'local',id:'A'}, duration:200, playbackRevision:()=>revision, seek:n=>sought.push(n) };
const dragValue = {value:-1};
const api = runInNewContext(stripTypeScriptTypes(handlers, {mode:'strip'}) + '\n({onSeekStart,onSeekChanging,onSeekChange,onSeekCancel})', {player,dragValue,watch:()=>{}});
api.onSeekStart(); api.onSeekChanging({detail:{value:500}});
assert.equal(dragValue.value,100); api.onSeekChange({detail:{value:600}});
assert.deepEqual(sought,[120]);
api.onSeekStart(); api.onSeekChanging({detail:{value:800}});
player.current = {platform:'local',id:'B'}; revision++;
api.onSeekChange({detail:{value:800}}); assert.deepEqual(sought,[120], 'late drag must not seek the new song');
api.onSeekStart(); revision++; api.onSeekChange({detail:{value:800}});
assert.deepEqual(sought,[120], 'same song restarted is a new playback intent');
api.onSeekStart(); api.onSeekCancel(); api.onSeekChange({detail:{value:800}});
assert.deepEqual(sought,[120], 'cancelled drag must not commit');
api.onSeekStart(); api.onSeekChange({detail:{value:250}});
assert.deepEqual(sought,[120,50], 'fresh gesture after cancellation can seek');
console.log("hd layout: home/player geometry and production seek intent cases passed");
