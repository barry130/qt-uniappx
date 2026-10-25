/**
 * embed-bytes.uts 的 node 自测（不进构建产物，仅本机验证字节层正确性）
 * 运行: node scripts/embed-bytes.test.mjs
 *   前置: npx esbuild uni_modules/qt-app-native/utssdk/embed-bytes.uts --loader:.uts=ts --format=esm --outfile=out-tmp/embed-bytes.mjs
 * 校验器: ffprobe / ffmpeg（本机 PATH 中, 与真机解析器独立互证）
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { planMp3, planFlac, utf16leEncode, utf8Encode, base64Encode, base64Decode } from '../out-tmp/embed-bytes.mjs';

const TMP = fileURLToPath(new URL('../out-tmp/', import.meta.url));
mkdirSync(TMP, { recursive: true });
let pass = 0;
const fail = [];
function ok(name) { pass++; console.log('  ✓ ' + name); }
function bad(name, e) { fail.push(name); console.error('  ✗ ' + name + '\n    ' + (e && e.message ? e.message : e)); }
function probe(file, args) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', ...args, file], { encoding: 'utf8' }));
}
/** 大小写不敏感取 tag（flac=TITLE 大写, mp3=title 小写） */
function tag(fmt, key) {
  for (const k of Object.keys(fmt.tags || {})) if (k.toLowerCase() === key) return fmt.tags[k];
  return undefined;
}
/** attached_pic 流存在性（ffprobe: disposition.attached_pic==1） */
function attachedPic(file) { return attachedPicCount(file) >= 1; }
function attachedPicCount(file) {
  const j = probe(file, ['-show_streams']);
  let n = 0;
  for (const st of j.streams || []) if (st.disposition && st.disposition.attached_pic === 1) n++;
  return n;
}
/** 整文件解码校验: 音频区原样可解码 */
function decodes(file) {
  try { execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { maxBuffer: 20e6 }); return true; } catch { return false; }
}

/* ---------- 1. 编码器 ---------- */
try {
  const u16 = utf16leEncode('A中');
  assert.deepStrictEqual([...u16], [0xff, 0xfe, 0x41, 0, 0x2d, 0x4e]);
  const u8 = utf8Encode('A中😀');
  assert.strictEqual(u8.length, 1 + 3 + 4);
  assert.deepStrictEqual([...u8], [0x41, 0xe4, 0xb8, 0xad, 0xf0, 0x9f, 0x98, 0x80]);
  ok('utf16le(BOM)+utf8(代理对)');
} catch (e) { bad('utf16le(BOM)+utf8(代理对)', e); }

try {
  // 与 node 原生互证 + 边界(空/1/2/3字节/带换行/非法字符)
  for (const n of [0, 1, 2, 3, 4, 255, 4096]) {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 37 + 11) & 0xff;
    const enc = base64Encode(buf);
    assert.strictEqual(enc, Buffer.from(buf).toString('base64'), 'b64 enc n=' + n);
    const dec = base64Decode(enc);
    assert.deepStrictEqual([...dec], [...buf], 'b64 dec n=' + n);
  }
  assert.deepStrictEqual(
    [...base64Decode(Buffer.from('hi').toString('base64') + String.fromCharCode(10))],
    [...Buffer.from('hi')],
    '容忍换行'
  );
  const bad2 = base64Decode('a!bc');
  assert.strictEqual(bad2.length, 0, '非法字符 → 空串');
  assert.strictEqual(base64Decode('').length, 0, '空输入');
  ok('base64 编解码往返(node 原生互证)');
} catch (e) { bad('base64 编解码往返(node 原生互证)', e); }

/* ---------- 真实样本生成 ---------- */
// 真 mp3 帧（0.3s 正弦, 44.1k 单声道）
const realMp3Audio = execFileSync('ffmpeg',
  ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '0.3', '-f', 'mp3', '-c:a', 'libmp3lame', '-b:a', '64k', '-'],
  { maxBuffer: 20e6 });
// 真 PNG（红色 64x64）
const png = execFileSync('ffmpeg',
  ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-'],
  { maxBuffer: 20e6 });
assert.ok(png[0] === 0x89 && png[1] === 0x50, 'PNG 魔数');

// 合成「旧 ID3v2.3 标签」: ID3 + TIT2(旧标题)
function syncsafe4(len) { return [(len >> 21) & 0x7f, (len >> 14) & 0x7f, (len >> 7) & 0x7f, len & 0x7f]; }
function oldTextFrame(id, latin1Text) {
  const body = Buffer.concat([Buffer.from([0x00]), Buffer.from(latin1Text, 'latin1'), Buffer.from([0x00, 0x00])]);
  const head = Buffer.concat([Buffer.from(id, 'ascii'), Buffer.from([(body.length >> 24) & 0xff, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, 0, 0])]);
  return Buffer.concat([head, body]);
}
const oldFrame = oldTextFrame('TIT2', 'old-title');
const oldTag = Buffer.concat([
  Buffer.from('ID3'), Buffer.from([3, 0, 0]), Buffer.from(syncsafe4(oldFrame.length)), oldFrame,
]);
// 旧 flac: ffmpeg 真文件 + 自塞一个「旧 VC + 大 PADDING」以覆盖真实场景
function buildFlac(padLen, splitPad) {
  const raw = execFileSync('ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.2', '-f', 'flac', '-'],
    { maxBuffer: 20e6 });
  const buf = Buffer.from(raw);
  let pos = 42;
  for (;;) {
    const isLast = (buf[pos] & 0x80) !== 0;
    const len = buf.readUIntBE(pos + 1, 3);
    pos += 4 + len;
    if (isLast) break;
  }
  const audio = buf.subarray(pos);
  const streamInfoData = buf.subarray(8, 42); // 34B
  const mk = (type, last, body) => Buffer.concat([
    Buffer.from([(type & 0x7f) | (last ? 0x80 : 0)]),
    (() => { const b = Buffer.alloc(3); b.writeUIntBE(body.length, 0, 3); return b; })(),
    body,
  ]);
  const vendor = Buffer.from('ffmpeg');
  const oldVcBody = Buffer.concat([
    (() => { const a = Buffer.alloc(4); a.writeUInt32LE(vendor.length, 0); return a; })(),
    vendor,
    (() => { const c = Buffer.alloc(4); c.writeUInt32LE(0, 0); return c; })(),
  ]);
  const oldVc = mk(4, false, oldVcBody); // 旧 VC 带 last=0
  if (splitPad) {
    // 大 PADDING(last=0) + 小 PADDING(last=1): 用于测试「后续块头落在前缀外」
    const pad1 = mk(1, false, Buffer.alloc(padLen, 0));
    const pad2 = mk(1, true, Buffer.alloc(16, 0));
    return Buffer.concat([Buffer.from('fLaC'), mk(0, false, streamInfoData), oldVc, pad1, pad2, audio]);
  }
  const pad = mk(1, true, Buffer.alloc(padLen, 0)); // 大 PADDING, last=1
  return Buffer.concat([Buffer.from('fLaC'), mk(0, false, streamInfoData), oldVc, pad, audio]);
}

/* ---------- 2. planMp3 ---------- */
{
  const mp3 = Buffer.concat([oldTag, realMp3Audio]);
  let name = 'planMp3: 旧标签剥离 + 帧同步嗅探';
  try {
    // ffmpeg 自身还会写一个 ID3 标签 → 文件头是「合成旧标签 + ffmpeg 标签」双重, 必须一并跳过
    let ffmpegTagLen = 0;
    if (realMp3Audio[0] === 0x49 && realMp3Audio[1] === 0x44 && realMp3Audio[2] === 0x33) {
      ffmpegTagLen = 10 + ((realMp3Audio[6] & 0x7f) << 21) + ((realMp3Audio[7] & 0x7f) << 14) + ((realMp3Audio[8] & 0x7f) << 7) + (realMp3Audio[9] & 0x7f);
    }
    const plan = planMp3(new Uint8Array(mp3), { title: '新标题', artist: '', album: '', lrcText: '', coverBytes: null, coverMime: '' });
    assert.ok(plan, 'plan 不应为 null');
    assert.strictEqual(plan.oldTagSize, oldTag.length + ffmpegTagLen, '旧标签长度(含 ffmpeg 自带标签)');
    const out = Buffer.concat([Buffer.from(plan.newTag), mp3.subarray(plan.oldTagSize)]);
    const f = TMP + 't.mp3';
    writeFileSync(f, out);
    const j = probe(f, ['-show_format']);
    assert.strictEqual(tag(j.format, 'title'), '新标题', '标题');
    assert.notStrictEqual(tag(j.format, 'title'), 'old-title', '旧标题必须被替换');
    assert.ok(decodes(f), '音频区原样可解码');
    ok(name);
  } catch (e) { bad(name, e); }

  name = 'planMp3: flac 字节伪装 mp3 → null';
  try {
    assert.strictEqual(planMp3(new Uint8Array(Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(60, 0)])), { title: 'x', artist: '', album: '', lrcText: '', coverBytes: null, coverMime: '' }), null);
    ok(name);
  } catch (e) { bad(name, e); }

  name = 'planMp3: USLT 歌词 + APIC 封面 (ffprobe 互证)';
  try {
    const plan = planMp3(new Uint8Array(mp3), {
      title: 'T', artist: '歌手甲', album: '专辑Z',
      lrcText: '[00:00.50]第一行\n[00:02.00]second line\n',
      coverBytes: new Uint8Array(png), coverMime: 'image/png',
    });
    const out = Buffer.concat([Buffer.from(plan.newTag), mp3.subarray(plan.oldTagSize)]);
    const f = TMP + 'full.mp3';
    writeFileSync(f, out);
    const fmt = probe(f, ['-show_format']).format;
    assert.strictEqual(tag(fmt, 'title'), 'T');
    assert.strictEqual(tag(fmt, 'artist'), '歌手甲');
    assert.strictEqual(tag(fmt, 'album'), '专辑Z');
    assert.ok(decodes(f), '音频区原样可解码');
    assert.ok(attachedPic(f), 'APIC 被识别为 attached_pic 流');
    ok(name);
  } catch (e) { bad(name, e); }
}

/* ---------- 3. planFlac ---------- */
function assembleFlac(src, plan) {
  const parts = [Buffer.from('fLaC'), Buffer.from(plan.streamInfo)];
  for (const sp of plan.keptSpans) {
    // 原块头 4B（在真机上由平台层做 last 位清零；此处原样, 因 last 块必在 spans 末尾=pad, 其 last 位需清零）
    const head = Buffer.from(src.subarray(sp.headerOffset, sp.headerOffset + 4));
    head[0] = head[0] & 0x7f; // last 清零（测试端模拟平台层职责）
    parts.push(head, Buffer.from(src.subarray(sp.headerOffset + 4, sp.headerOffset + 4 + sp.dataLen)));
  }
  parts.push(Buffer.from(plan.vorbisComment));
  if (plan.picture) parts.push(Buffer.from(plan.picture));
  parts.push(Buffer.from(src.subarray(plan.audioOffset)));
  return Buffer.concat(parts);
}
{
  let name = 'planFlac: 剔旧 VC/旧 PADDING(last) + 新 VC + PICTURE (ffprobe 互证)';
  try {
    const flac = buildFlac(64);
    const plan = planFlac(new Uint8Array(flac), {
      title: 'F题', artist: 'F手', album: 'F辑',
      lrcText: '[00:01.00]flac 歌词\n',
      coverBytes: new Uint8Array(png), coverMime: 'image/png',
    });
    assert.ok(plan, 'plan 不应为 null');
    const out = assembleFlac(flac, plan);
    const f = TMP + 't.flac';
    writeFileSync(f, out);
    const j = probe(f, ['-show_format']);
    assert.strictEqual(tag(j.format, 'title'), 'F题');
    assert.strictEqual(tag(j.format, 'artist'), 'F手');
    assert.strictEqual(tag(j.format, 'album'), 'F辑');
    assert.strictEqual(j.format.nb_streams, 2, '音频+封面双流');
    assert.ok(decodes(f), '音频区原样可解码');
    assert.ok(attachedPic(f), 'PICTURE 被识别为 attached_pic 流');
    ok(name);
  } catch (e) { bad(name, e); }

  name = 'planFlac: 幂等（对已嵌文件重嵌, 旧块被剔除不累积）';
  try {
    const flac = buildFlac(64);
    const d1 = { title: 'v1', artist: 'a', album: 'b', lrcText: '[00:01.00]x\n', coverBytes: new Uint8Array(png), coverMime: 'image/png' };
    const p1 = planFlac(new Uint8Array(flac), d1);
    const out1 = assembleFlac(flac, p1);
    const d2 = { title: 'v2', artist: 'a', album: 'b', lrcText: '[00:01.00]x\n', coverBytes: new Uint8Array(png), coverMime: 'image/png' };
    const p2 = planFlac(new Uint8Array(out1), d2);
    const out2 = assembleFlac(out1, p2);
    writeFileSync(TMP + 't2.flac', out2);
    const j = probe(TMP + 't2.flac', ['-show_format']);
    assert.strictEqual(tag(j.format, 'title'), 'v2');
    assert.strictEqual(attachedPicCount(TMP + 't2.flac'), 1, 'PICTURE 不累积');
    assert.ok(decodes(TMP + 't2.flac'), '重嵌后音频区仍可解码');
    ok(name);
  } catch (e) { bad(name, e); }

  name = 'planFlac: 块头落在前缀外 → null（调用方扩前缀重试路径）';
  try {
    // 场景A: 非last 大 PADDING(1MB, last=0) + 小 PADDING(last=1) → 1MB 前缀只看到第一个头, 第二个头在 1MB+ 之外
    const flacA = buildFlac(1024 * 1024, true);
    const cutA = flacA.subarray(0, 1024 * 300);
    assert.strictEqual(planFlac(new Uint8Array(cutA), { title: 'x', artist: '', album: '', lrcText: '', coverBytes: null, coverMime: '' }), null, '后续块头不可见时应 null');
    const fullA = planFlac(new Uint8Array(flacA.subarray(0, 1024 * 2048)), { title: 'x', artist: '', album: '', lrcText: '', coverBytes: null, coverMime: '' });
    assert.ok(fullA, '扩到 2MB 前缀后应有 plan');
    // 场景B: last 大 PADDING(1MB) → 只要 4 个块头字节在前缀内即可 plan（数据可越界, 由平台层搬运）
    const flacB = buildFlac(1024 * 1024, false);
    const planB = planFlac(new Uint8Array(flacB.subarray(0, 4096)), { title: 'x', artist: '', album: '', lrcText: '', coverBytes: null, coverMime: '' });
    assert.ok(planB, 'last 块头在前缀内即应 plan');
    assert.strictEqual(planB.keptSpans.length, 1, '保留块只应剩 padding');
    ok(name);
  } catch (e) { bad(name, e); }
}

console.log(`\n${pass} passed, ${fail.length} failed${fail.length ? ': ' + fail.join(', ') : ''}`);
process.exit(fail.length ? 1 : 0);
