import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = readFileSync(new URL("../uni_modules/qt-audio-player/utssdk/dlna-protocol.uts", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(source.replace(/^export /gm, ""), { mode: "strip" }), context);
const run = expression => JSON.parse(JSON.stringify(vm.runInContext(expression, context)));

assert.equal(run(`dlnaXmlEscape('A & B <歌> "x"')`), "A &amp; B &lt;歌&gt; &quot;x&quot;");
assert.equal(run(`dlnaTimeMs('01:02:03.250')`), 3723250);
assert.equal(run(`dlnaTimeMs('NOT_IMPLEMENTED')`), 0);
assert.equal(run(`dlnaTimeMs('00:99:01')`), 0);
assert.equal(run(`dlnaTimeText(3723250)`), "01:02:03");
assert.deepEqual(run(`dlnaByteRange('', 10)`), { start: 0, end: 9, partial: false });
assert.deepEqual(run(`dlnaByteRange('bytes=3-5', 10)`), { start: 3, end: 5, partial: true });
assert.deepEqual(run(`dlnaByteRange('bytes=7-', 10)`), { start: 7, end: 9, partial: true });
assert.deepEqual(run(`dlnaByteRange('bytes=-3', 10)`), { start: 7, end: 9, partial: true });
assert.deepEqual(run(`dlnaByteRange('bytes=8-200', 10)`), { start: 8, end: 9, partial: true });
for (const header of ["bytes=10-", "bytes=5-3", "bytes=0-1,4-5", "bytes=-0", "bytes=a-1", "items=1-2"]) {
  assert.equal(run(`dlnaByteRange(${JSON.stringify(header)}, 10)`), null, header);
}
assert.equal(run(`dlnaByteRange('bytes=0-', 0)`), null);
assert.equal(run(`dlnaMimeSupported('http-get:*:audio/mpeg:*,http-get:*:audio/x-flac:*', 'audio/flac')`), true);
assert.equal(run(`dlnaMimeSupported('http-get:*:audio/mpeg:*', 'audio/flac')`), false);
assert.equal(run(`dlnaMimeSupported('rtsp-rtp-udp:*:audio/mpeg:*', 'audio/mpeg')`), false);
assert.equal(run(`dlnaMimeFromPath('https://cdn.example/song.FLAC?sig=x')`), "audio/flac");
const didl = run(`dlnaDidl('id&1', 'A < B', '歌手', '专辑', '', 'http://192.168.1.2/dlna/token?x=1&y=2', 'audio/mpeg', 100, 60000)`);
assert.ok(didl.includes('id="id&amp;1"'));
assert.ok(didl.includes("<dc:title>A &lt; B</dc:title>"));
assert.ok(didl.includes("token?x=1&amp;y=2"));
assert.ok(didl.includes('duration="00:01:00"'));
assert.equal(run(`dlnaNaturalEnd('PLAYING', 'STOPPED', 59900, 60000, true, false, true)`), true);
for (const args of [
  ["PLAYING", "STOPPED", 59900, 60000, true, true, true],
  ["PLAYING", "STOPPED", 59900, 60000, true, false, false],
  ["TRANSITIONING", "STOPPED", 59900, 60000, true, false, true],
  ["PLAYING", "STOPPED", 10000, 60000, true, false, true],
  ["PLAYING", "STOPPED", 59900, 0, true, false, true],
  ["PAUSED_PLAYBACK", "STOPPED", 59900, 60000, true, false, true],
]) assert.equal(run(`dlnaNaturalEnd(${args.map(JSON.stringify).join(",")})`), false);
console.log("[check-dlna] passed: wire metadata, time, byte ranges, format matching and guarded natural-end decisions");
