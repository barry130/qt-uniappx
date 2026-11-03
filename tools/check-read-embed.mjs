// 批次⑧最小单测面：qt-app-native 内嵌标签「读取层」（read-embed.uts）的确定性回归。
// VM 沙箱跑真实字节层（stripTypeScriptTypes 去类型），写出侧 embed-bytes.uts 同场装载
// 做 round-trip；全部用例纯内存构造，无文件 IO、无 ffprobe 依赖。
// 覆盖：planMp3/planFlac 写出 → 读回一致、ID3v2.2/2.3/2.4 三版手造标签（PIC/ULT/APIC/USLT、
//       SyncSafe 帧长、标签级/帧级 unsynchronisation、文本编码 0/1/3）、FLAC PICTURE +
//       VORBIS_COMMENT LYRICS、前置 ID3 的 flac、多 APIC 择优、截断/魔数不符 fail-closed。
// node tools/check-read-embed.mjs（Node >= 22.13）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const writerSrc = readFileSync(new URL('../uni_modules/qt-app-native/utssdk/embed-bytes.uts', import.meta.url), 'utf8');
const readerSrc = readFileSync(new URL('../uni_modules/qt-app-native/utssdk/read-embed.uts', import.meta.url), 'utf8');
function strip(source) {
  // 与 check-harmony-network.mjs 同款三段式：多行 import → export {} 列表 → export 前缀
  return stripTypeScriptTypes(source
    .replace(/^import\b[\s\S]*?(?:;[ \t]*\r?\n|from\s+['"][^'"]+['"][ \t]*\r?\n)/gm, '')
    .replace(/^export \{[^}]*\};?\r?\n/gm, '')
    .replace(/^export /gm, ''));
}
const ctx = vm.createContext({ Uint8Array, Array, String, console });
vm.runInContext(strip(writerSrc), ctx);
vm.runInContext(strip(readerSrc), ctx);
const api = vm.runInContext('({ planMp3, planFlac, readMp3Embedded, readFlacEmbedded })', ctx);

// ---- 纯内存构造工具（宿主侧，统一 number[] 组装、末端转 Uint8Array） ----
const u8 = (arr) => new Uint8Array(arr);
function eqBytes(a, b) { assert.deepEqual(Array.from(a), Array.from(b)); } // 跨 VM realm 统一走 Array 比较
function syncsafe(n) { return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]; }
function be32(n) { return [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; }
function be24(n) { return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; }
function le32(n) { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]; }
function utf16leWithBom(text) {
  const out = [0xff, 0xfe];
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out.push(c & 0xff, (c >> 8) & 0xff);
  }
  return out;
}
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
function id3Tag(major, tagFlags, body) {
  return u8([0x49, 0x44, 0x33, major, 0x00, tagFlags].concat(syncsafe(body.length)).concat(body));
}
function frame23(id, body) {
  return ascii(id).concat(be32(body.length)).concat([0x00, 0x00]).concat(body);
}
function frame22(id, body) {
  return ascii(id).concat(be24(body.length)).concat(body);
}
function flacBlock(type, last, body) {
  return [type | (last ? 0x80 : 0x00)].concat(be24(body.length)).concat(body);
}
function vorbisEntries(entries) {
  const vendor = Array.from(new TextEncoder().encode('gate-vendor'));
  let body = le32(vendor.length).concat(vendor).concat(le32(entries.length));
  for (const entry of entries) {
    const eb = Array.from(new TextEncoder().encode(entry));
    body = body.concat(le32(eb.length)).concat(eb);
  }
  return body;
}

let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log('  ✓ ' + label); }

// (a) round-trip：planMp3 写出的标签读回封面与歌词
await check('round-trip mp3：planMp3 写出 → readMp3Embedded 读回封面/歌词一致', async () => {
  const mpeg = u8([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00, 0x00]);
  const cover = u8([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xab, 0xcd, 0xff, 0xd9]);
  const lrc = '[00:01.00]第一行歌词\r\n[00:02.50]第二行\r\n';
  const plan = api.planMp3(mpeg, { title: '测试歌名', artist: '测试歌手', album: '测试专辑', lrcText: lrc, coverBytes: cover, coverMime: 'image/jpeg' });
  assert.ok(plan);
  assert.equal(plan.oldTagSize, 0);
  const read = api.readMp3Embedded(plan.newTag);
  assert.ok(read);
  eqBytes(read.coverBytes, cover);
  assert.equal(read.coverMime, 'image/jpeg');
  assert.equal(read.lrcText, lrc); // CRLF 原样
});

// (b) round-trip：planFlac 重组头读回封面与歌词
await check('round-trip flac：planFlac 重组头 → readFlacEmbedded 读回封面/歌词一致', async () => {
  const prefix = u8([0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]
    .concat(new Array(34).fill(0)) // STREAMINFO 体（内容不校验）
    .concat([0x81, 0x00, 0x00, 0x00])); // PADDING last 块
  const cover = u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const lrc = '[00:03.00]FLAC行一\n[00:04.00]FLAC行二\n';
  const plan = api.planFlac(prefix, { title: '曲', artist: '人', album: '集', lrcText: lrc, coverBytes: cover, coverMime: 'image/png' });
  assert.ok(plan);
  const head = u8([0x66, 0x4c, 0x61, 0x43] // plan.streamInfo 只含 STREAMINFO 块本身，fLaC 魔数需自拼
    .concat(Array.from(plan.streamInfo))
    .concat(Array.from(plan.vorbisComment))
    .concat(plan.picture == null ? [] : Array.from(plan.picture)));
  const read = api.readFlacEmbedded(head);
  assert.ok(read);
  eqBytes(read.coverBytes, cover);
  assert.equal(read.coverMime, 'image/png');
  assert.equal(read.lrcText, lrc);
});

// (c) 手造 ID3v2.2：3 字符 PIC 帧 + 3 字节帧长
await check('ID3v2.2：PIC 帧（3 字符标识/3 字节帧长/PNG 格式字段）', async () => {
  const picData = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02];
  const body = [0x00].concat(ascii('PNG')).concat([0x03, 0x00]).concat(picData); // enc0 + 格式 + 类型 + latin1 空描述终止 + 数据
  const tag = id3Tag(2, 0x00, frame22('PIC', body));
  const read = api.readMp3Embedded(tag);
  assert.ok(read);
  eqBytes(read.coverBytes, picData);
  assert.equal(read.coverMime, 'image/png');
  assert.equal(read.lrcText, '');
});

// (d) ID3v2.4：SyncSafe 帧长 + 标签级 unsynchronisation（FF 00 摘除）
await check('ID3v2.4：SyncSafe 帧长 + 标签级 unsync（FF 00 对摘除后封面完好）', async () => {
  const decodedData = [0xff, 0x00, 0xaa, 0xbb]; // 含 FF 00 危险对
  const storedBody = [0x00].concat(ascii('image/png')).concat([0x00, 0x03, 0x00]).concat([0xff, 0x00, 0x00, 0xaa, 0xbb]);
  // 帧尺寸按「去 unsync 后」的解码长度写入；标签体按存储（补 0 后）形态
  const frame = ascii('APIC').concat(syncsafe(storedBody.length - 1)).concat([0x00, 0x00]).concat(storedBody);
  const tag = id3Tag(4, 0x80, frame);
  const read = api.readMp3Embedded(tag);
  assert.ok(read);
  eqBytes(read.coverBytes, decodedData);
  assert.equal(read.coverMime, 'image/png');
});

// (e) ID3v2.4：帧级 unsynchronisation（无标签级标志时逐帧摘除）
await check('ID3v2.4：帧级 unsync（帧标志 0x0002，标签级未开）', async () => {
  const decodedData = [0xff, 0x00, 0x11, 0x22];
  const storedBody = [0x00].concat(ascii('image/jpeg')).concat([0x00, 0x03, 0x00]).concat([0xff, 0x00, 0x00, 0x11, 0x22]);
  // 帧级 unsync 时帧尺寸按存储长度；解析后帧体再摘 FF 00
  const frame = ascii('APIC').concat(syncsafe(storedBody.length)).concat([0x00, 0x02]).concat(storedBody);
  const tag = id3Tag(4, 0x00, frame);
  const read = api.readMp3Embedded(tag);
  assert.ok(read);
  eqBytes(read.coverBytes, decodedData);
  assert.equal(read.coverMime, 'image/jpeg');
});

// (f) USLT 文本编码 1（UTF-16 + BOM）
await check('USLT 编码 1：UTF-16(BOM) 歌词正文原样解出', async () => {
  const lrc = '[01:00.00]测试歌词行';
  const body = [0x01].concat(ascii('XXX')).concat([0xff, 0xfe, 0x00, 0x00]).concat(utf16leWithBom(lrc));
  const tag = id3Tag(3, 0x00, frame23('USLT', body));
  const read = api.readMp3Embedded(tag);
  assert.ok(read);
  assert.equal(read.lrcText, lrc);
  assert.equal(read.coverBytes, null);
});

// (g) USLT 文本编码 3（UTF-8）
await check('USLT 编码 3：UTF-8 歌词正文原样解出', async () => {
  const lrc = '[02:00.00]English+中文混合 42';
  const body = [0x03].concat(ascii('XXX')).concat([0x00]).concat(Array.from(new TextEncoder().encode(lrc)));
  const tag = id3Tag(3, 0x00, frame23('USLT', body));
  const read = api.readMp3Embedded(tag);
  assert.ok(read);
  assert.equal(read.lrcText, lrc);
});

// (h) FLAC VORBIS_COMMENT：LYRICS 多行文本
await check('FLAC VORBIS_COMMENT：LYRICS= 多行文本完整解出', async () => {
  const lrc = '[00:01.00]行一\n[00:02.00]行二\n[00:03.00]行三\n';
  const flac = u8([0x66, 0x4c, 0x61, 0x43]
    .concat(flacBlock(4, false, vorbisEntries(['LYRICS=' + lrc])))
    .concat(flacBlock(1, true, [])));
  const read = api.readFlacEmbedded(flac);
  assert.ok(read);
  assert.equal(read.lrcText, lrc);
  assert.equal(read.coverBytes, null);
  assert.equal(read.coverMime, '');
});

// (i) 无标签文件 → null
await check('无标签：mp3 同步头直开 / 非 flac / 空数组 → null', async () => {
  assert.equal(api.readMp3Embedded(u8([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00])), null);
  assert.equal(api.readMp3Embedded(new Uint8Array(0)), null);
  assert.equal(api.readFlacEmbedded(u8([0x4f, 0x67, 0x67, 0x53, 0x00, 0x00, 0x00])), null);
  assert.equal(api.readFlacEmbedded(new Uint8Array(0)), null);
});

// (j) 截断：声明尺寸大于前缀 → **带回 coverNeed 的对象**（宿主据此放大窗口重读）；  
//     标签头都不完整 → null（fail-closed）。  
//     口径变更说明（2026-11-02）：旧实现在「全空且截断」时返回 null，宿主拿不到  
//     coverNeed 就直接放弃，大封面 + 无歌词的文件永远读不出封面（审阅实测）。
await check('截断：ID3 声明尺寸超出前缀 → 带 coverNeed 的对象；头不完整 → null', async () => {
  const tag = u8([0x49, 0x44, 0x33, 0x03, 0x00, 0x00].concat(syncsafe(500)).concat(new Array(40).fill(0x00)));
  const read = api.readMp3Embedded(tag);
  assert.ok(read, '截断标签不能返回 null，否则宿主拿不到 coverNeed');
  assert.equal(read.coverBytes, null);
  assert.equal(read.lrcText, '');
  assert.equal(read.coverNeed, 510); // 10 字节标签头 + 声明的体长 500
  assert.equal(api.readMp3Embedded(u8([0x49, 0x44, 0x33, 0x03, 0x00])), null); // 头都不完整
});

// (k) FLAC 魔数不符 → null
await check('FLAC：fLaC 魔数不符（OggS / 垃圾前缀 / ID3 后仍非 flac）→ null', async () => {
  assert.equal(api.readFlacEmbedded(u8([0x4f, 0x67, 0x67, 0x53].concat(new Array(40).fill(0)))), null);
  assert.equal(api.readFlacEmbedded(u8([0x00, 0x01, 0x02, 0x03, 0x04])), null);
  const fakeId3 = id3Tag(3, 0x00, frame23('TIT2', [0x01, 0xff, 0xfe, 0x00, 0x00, 0x00, 0x00]));
  assert.equal(api.readFlacEmbedded(u8(Array.from(fakeId3).concat([0x4f, 0x67, 0x67, 0x53]))), null);
});

// (l) 空 USLT：描述后无正文 → lrcText='' 且整体不算失败
await check('空 USLT：描述终止后无正文 → lrcText 为空串且正常返回对象', async () => {
  const body = [0x01].concat(ascii('XXX')).concat([0xff, 0xfe, 0x00, 0x00]); // 编码1 + 语言 + BOM + 描述终止，无歌词
  const tag = id3Tag(3, 0x00, frame23('USLT', body));
  const read = api.readMp3Embedded(tag);
  assert.ok(read);
  assert.equal(read.lrcText, '');
  assert.equal(read.coverBytes, null);
  assert.equal(read.coverMime, '');
});

// (m) 封面超出前缀：截断大封面 → 仍返回歌词，coverBytes=null 不崩
await check('封面超出前缀：APIC 帧体被截断 → 歌词照常返回、封面置空不崩', async () => {
  const bigCover = new Uint8Array(300000);
  for (let i = 0; i < bigCover.length; i++) bigCover[i] = i % 251;
  const lrc = '[00:01.00]截断场景歌词';
  const plan = api.planMp3(u8([0xff, 0xfb, 0x90, 0x44]), { title: 't', artist: 'a', album: 'b', lrcText: lrc, coverBytes: bigCover, coverMime: 'image/jpeg' });
  assert.ok(plan);
  assert.ok(plan.newTag.length > 65536);
  const read = api.readMp3Embedded(plan.newTag.slice(0, 65536)); // 只给 64KB 前缀，USLT 在前、APIC 被腰斩
  assert.ok(read);
  assert.equal(read.lrcText, lrc);
  assert.equal(read.coverBytes, null);
  assert.equal(read.coverMime, '');
});

// (n) 前置 ID3 标签的 flac：跳过 ID3 后按 flac 解析
await check('前置 ID3 的 flac：忽略前置标签内容，按 fLaC 解出 LYRICS', async () => {
  const picData = [0xff, 0xd8, 0xff, 0xaa];
  const picBody = [0x00].concat(ascii('JPG')).concat([0x03, 0x00]).concat(picData);
  const id3 = id3Tag(2, 0x00, frame22('PIC', picBody)); // 前置标签带封面
  const lrc = '[00:09.00]前置ID3后的FLAC歌词';
  const flac = u8([0x66, 0x4c, 0x61, 0x43].concat(flacBlock(4, true, vorbisEntries(['LYRICS=' + lrc]))));
  const read = api.readFlacEmbedded(u8(Array.from(id3).concat(Array.from(flac))));
  assert.ok(read);
  assert.equal(read.lrcText, lrc);
  assert.equal(read.coverBytes, null); // 前置 ID3 的封面不透传（该路径只认 flac 块）
});

// (o) 多 APIC 帧择优：优先 front cover(0x03)
await check('多 APIC 择优：front cover(0x03) 优先于其他类型', async () => {
  const back = [0x11, 0x22, 0x33];
  const front = [0xaa, 0xbb, 0xcc, 0xdd];
  const b1 = [0x00].concat(ascii('image/jpeg')).concat([0x00, 0x04, 0x00]).concat(back); // 类型 4 = 背面
  const b2 = [0x00].concat(ascii('image/png')).concat([0x00, 0x03, 0x00]).concat(front); // 类型 3 = 封面
  const tag = id3Tag(3, 0x00, frame23('APIC', b1).concat(frame23('APIC', b2)));
  const read = api.readMp3Embedded(tag);
  assert.ok(read);
  eqBytes(read.coverBytes, front);
  assert.equal(read.coverMime, 'image/png');
});

// (p) coverNeed：大封面被前缀截断时给出「还差多少字节」，宿主据此放大窗口重读
//     真机背景：网易 HI-RES FLAC 的 1-3MB PICTURE 会越过 1MiB 窗口，
//     旧实现只返回「歌词有、封面无」，播放页只能显示默认图（2026-11-02 现场）。
await check('coverNeed：flac 大 PICTURE 被截断 → 报出块尾位置，整段读入后封面正常', async () => {
  const cover = new Uint8Array(220 * 1024); // 220KB：PICTURE 块体必然越过 128KB 前缀
  for (let i = 0; i < cover.length; i++) cover[i] = (i * 7) % 251;
  const lrc = '[00:02.00]大封面场景';
  const picBody = be32(3) // 类型 3 = 封面
    .concat(be32(10)).concat(ascii('image/jpeg'))
    .concat(be32(0)) // 描述长度 0
    .concat(be32(1500)).concat(be32(1500)).concat(be32(24)).concat(be32(0))
    .concat(be32(cover.length)).concat(Array.from(cover));
  const flac = u8([0x66, 0x4c, 0x61, 0x43]
    .concat(flacBlock(4, false, vorbisEntries(['LYRICS=' + lrc])))
    .concat(flacBlock(6, true, picBody)));
  const truncated = flac.slice(0, 128 * 1024);
  const partial = api.readFlacEmbedded(truncated);
  assert.ok(partial, '截断前缀也要返回已抽到的歌词');
  assert.equal(partial.lrcText, lrc);
  assert.equal(partial.coverBytes, null);
  assert.ok(partial.coverNeed > truncated.length, 'coverNeed 必须大于已读长度，否则宿主不会放大窗口');
  // 按 coverNeed 放大重读：封面完整、coverNeed 归零
  const full = api.readFlacEmbedded(flac.slice(0, partial.coverNeed + 4096));
  assert.ok(full);
  assert.equal(full.coverNeed, 0);
  eqBytes(full.coverBytes, cover);
  assert.equal(full.coverMime, 'image/jpeg');
});

// (q) coverNeed：mp3 的 APIC 越过前缀 → 报出「整签声明长度」，放大后封面正常
await check('coverNeed：mp3 大 APIC 被截断 → 报出整签长度，整签读入后封面正常', async () => {
  const cover = new Uint8Array(200 * 1024);
  for (let i = 0; i < cover.length; i++) cover[i] = (i * 13) % 253;
  const lrc = '[00:03.00]mp3大封面';
  const plan = api.planMp3(u8([0xff, 0xfb, 0x90, 0x44]), {
    title: 't', artist: 'a', album: 'b', lrcText: lrc, coverBytes: cover, coverMime: 'image/png',
  });
  assert.ok(plan);
  const cut = plan.newTag.slice(0, 96 * 1024);
  const partial = api.readMp3Embedded(cut);
  assert.ok(partial);
  assert.equal(partial.lrcText, lrc);
  assert.equal(partial.coverBytes, null);
  assert.ok(partial.coverNeed > cut.length);
  const full = api.readMp3Embedded(plan.newTag.slice(0, partial.coverNeed + 4096));
  assert.ok(full);
  assert.equal(full.coverNeed, 0);
  eqBytes(full.coverBytes, cover);
  assert.equal(full.coverMime, 'image/png');
});

// (r) coverNeed 回归：**没有内嵌歌词**时也必须报出「还差多少」
//     2026-11-02 审阅实测：旧判据「全空且截断 → null」把 coverNeed 一起丢掉，
//     而两个解析器都 null 时宿主第一遍就 break → 大封面 + 无歌词的文件永远读不到封面
//     （正是本次重写要解决的网易 HI-RES 场景）。(p)/(q) 因为带了 LYRICS 才躲过这个洞。
await check('coverNeed：flac 大 PICTURE 且无内嵌歌词 → 仍报出块尾位置，放大后封面正常', async () => {
  const cover = new Uint8Array(220 * 1024);
  for (let i = 0; i < cover.length; i++) cover[i] = (i * 11) % 249;
  const picBody = be32(3).concat(be32(10)).concat(ascii('image/jpeg'))
    .concat(be32(0))
    .concat(be32(1200)).concat(be32(1200)).concat(be32(24)).concat(be32(0))
    .concat(be32(cover.length)).concat(Array.from(cover));
  const flac = u8([0x66, 0x4c, 0x61, 0x43].concat(flacBlock(6, true, picBody)));
  const truncated = flac.slice(0, 128 * 1024);
  const partial = api.readFlacEmbedded(truncated);
  assert.ok(partial, '只有大封面、没有歌词时不能返回 null，否则宿主拿不到 coverNeed');
  assert.equal(partial.lrcText, '');
  assert.equal(partial.coverBytes, null);
  assert.ok(partial.coverNeed > truncated.length, 'coverNeed 必须大于已读长度');
  const full = api.readFlacEmbedded(flac.slice(0, partial.coverNeed + 4096));
  assert.ok(full);
  assert.equal(full.coverNeed, 0);
  eqBytes(full.coverBytes, cover);
  assert.equal(full.coverMime, 'image/jpeg');
});

// (s) 同上，mp3 的 APIC 且无 USLT 歌词
await check('coverNeed：mp3 大 APIC 且无内嵌歌词 → 仍报出整签长度，放大后封面正常', async () => {
  const cover = new Uint8Array(200 * 1024);
  for (let i = 0; i < cover.length; i++) cover[i] = (i * 17) % 247;
  const plan = api.planMp3(u8([0xff, 0xfb, 0x90, 0x44]), {
    title: 't', artist: 'a', album: 'b', lrcText: '', coverBytes: cover, coverMime: 'image/jpeg',
  });
  assert.ok(plan);
  const cut = plan.newTag.slice(0, 96 * 1024);
  const partial = api.readMp3Embedded(cut);
  assert.ok(partial, '只有大 APIC、没有歌词时不能返回 null');
  assert.equal(partial.lrcText, '');
  assert.equal(partial.coverBytes, null);
  assert.ok(partial.coverNeed > cut.length);
  const full = api.readMp3Embedded(plan.newTag.slice(0, partial.coverNeed + 4096));
  assert.ok(full);
  assert.equal(full.coverNeed, 0);
  eqBytes(full.coverBytes, cover);
  assert.equal(full.coverMime, 'image/jpeg');
});

console.log(`[check-read-embed] ${passed} 条读取用例通过`);
