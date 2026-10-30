// 批次⑥最小单测面：stores/persist-codec.ts 的落盘契约回归。
// 在 VM 沙箱里跑真实模块（stripTypeScriptTypes 去类型），只垫 UTSJSONObject/parseJsonToUtso 两个 uni 桥。
// 覆盖：全字段往返、旧格式兼容读取（新字段缺失→undefined）、脏文本→null、
//       pids 空串过滤、歌单嵌套 tracks 往返 + 单首脏 track 跳过。
// node tools/check-persist-codec.mjs（Node >= 22.13）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../stores/persist-codec.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
class Utso {
  constructor(data = {}) { this.data = data; }
  get(key) { return this.data[key] ?? null; }
  set(key, value) { this.data[key] = value; }
  toJSON() { return this.data; }
}
function wrap(value) {
  if (Array.isArray(value)) return value.map(wrap);
  if (value && typeof value === 'object') return new Utso(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wrap(v)])));
  return value;
}
const ctx = vm.createContext({ UTSJSONObject: Utso, parseJsonToUtso: (text) => wrap(JSON.parse(text)) });
vm.runInContext(code, ctx);
const { songToJson, songFromJson, playlistToJson, playlistFromJson } = vm.runInContext('({ songToJson, songFromJson, playlistToJson, playlistFromJson })', ctx);

let passed = 0;
function check(label, fn) { fn(); passed++; console.log('  ✓ ' + label); }
// VM 跨 realm 的普通对象过不了 deepStrictEqual（原型不同），先 JSON 归一化再比
function norm(value) { return JSON.parse(JSON.stringify(value)); }
const fullSong = {
  id: 's1', name: '测试歌', singer: '歌手', album: '专辑', picUrl: 'http://pic/1.png',
  platform: 'wyy', url: 'https://play/1.m4a', duration: 234, musicId: 'hash-1',
  likeSeq: 77, pids: ['p1', 'p2'],
};

check('全字段歌曲 songToJson→songFromJson 无损往返', () => {
  const back = songFromJson(songToJson(fullSong));
  assert.equal(back.id, 's1');
  assert.equal(back.name, '测试歌');
  assert.equal(back.url, 'https://play/1.m4a');
  assert.equal(back.duration, 234);
  assert.equal(back.musicId, 'hash-1');
  assert.equal(back.likeSeq, 77);
  assert.deepEqual(norm(back.pids), ['p1', 'p2']);
});

check('新字段为空时不落键（旧设备文本最小化）', () => {
  const text = songToJson({ id: 's2', name: 'n', singer: 'a', album: 'b', picUrl: '', platform: 'qq', url: '', duration: 0 });
  const obj = JSON.parse(text);
  assert.deepEqual(Object.keys(obj).sort(), ['album', 'id', 'name', 'picUrl', 'platform', 'singer']);
});

check('旧格式文本（无新字段）兼容读取，缺失→undefined/默认值', () => {
  const back = songFromJson('{"id":"s9","name":"老歌","singer":"","album":"","picUrl":"","platform":"qq","duration":180}');
  assert.equal(back.id, 's9');
  assert.equal(back.duration, 180);
  assert.equal(back.url, '');
  assert.equal(back.musicId, undefined);
  assert.equal(back.likeSeq, undefined);
  assert.equal(back.pids, undefined);
});

check('pids 含空串被过滤，全空→undefined', () => {
  const mixed = songFromJson(songToJson({ ...fullSong, pids: ['a', '', 'b'] }));
  assert.deepEqual(norm(mixed.pids), ['a', 'b']);
  const allEmpty = songFromJson(songToJson({ ...fullSong, pids: ['', ''] }));
  assert.equal(allEmpty.pids, undefined);
});

check('脏文本/空文本/缺 id → null', () => {
  assert.equal(songFromJson('not-json{'), null);
  assert.equal(songFromJson(''), null);
  assert.equal(songFromJson('{"name":"没有id"}'), null);
  assert.equal(songFromJson('{"id":"","name":"空id"}'), null);
});

check('歌单全字段往返（含嵌套 tracks）', () => {
  const pl = {
    id: 'pl1', name: '我的歌单', picUrl: 'http://pic/pl.png', playCount: '12', platform: 'local',
    description: '说明文字', likeSeq: 9, pid: 'GP-9',
    tracks: [fullSong, { ...fullSong, id: 's3', likeSeq: undefined, pids: undefined }],
  };
  const back = playlistFromJson(playlistToJson(pl));
  assert.equal(back.id, 'pl1');
  assert.equal(back.description, '说明文字');
  assert.equal(back.likeSeq, 9);
  assert.equal(back.pid, 'GP-9');
  assert.equal(back.tracks.length, 2);
  assert.equal(back.tracks[0].likeSeq, 77);
  assert.equal(back.tracks[1].likeSeq, undefined);
});

check('歌单旧格式：description/tracks/likeSeq/pid 缺失各得默认', () => {
  const back = playlistFromJson('{"id":"pl9","name":"老歌单","platform":"wyy"}');
  assert.equal(back.id, 'pl9');
  assert.equal(back.picUrl, '');
  assert.equal(back.playCount, '0');
  assert.equal(back.description, null);
  assert.equal(back.tracks, undefined);
  assert.equal(back.likeSeq, undefined);
  assert.equal(back.pid, undefined);
});

check('歌单嵌套脏 track 只跳过该首，其余保留', () => {
  const good = songToJson({ ...fullSong, id: 'ok1' });
  const text = JSON.stringify({ id: 'plx', name: 'x', platform: 'qq', tracks: [good, 'garbage{{{'] });
  const back = playlistFromJson(text);
  assert.equal(back.tracks.length, 1);
  assert.equal(back.tracks[0].id, 'ok1');
});

check('歌单脏文本/空文本/缺 id → null', () => {
  assert.equal(playlistFromJson('{{{'), null);
  assert.equal(playlistFromJson(''), null);
  assert.equal(playlistFromJson('{"name":"无id歌单"}'), null);
});

console.log(`[check-persist-codec] ${passed} 条落盘契约用例通过`);
