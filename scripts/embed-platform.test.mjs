/**
 * 平台层算法互证（node 镜像 app-android/index.uts 的 embedAudioTagsSync 全流程）
 * 运行: node scripts/embed-platform.test.mjs
 * 镜像范围: 前缀阶梯(64B→1MB→16MB mp3 / 1MB→16MB flac) + 文件切片写出 + 保留块搬运
 * 校验器: ffprobe/ffmpeg（与真机解析器独立互证）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planMp3, planFlac } from '../out-tmp/embed-bytes.mjs';

const TMP = fileURLToPath(new URL('../out-tmp/platform/', import.meta.url));
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
let pass = 0;
const fail = [];
function ok(name) { pass++; console.log('  ✓ ' + name); }
function bad(name, e) { fail.push(name); console.error('  ✗ ' + name + '\n    ' + (e && e.message ? e.message : e)); }
function probe(file, args) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', ...args, file], { encoding: 'utf8' }));
}
function tag(fmt, key) {
  for (const k of Object.keys(fmt.tags || {})) if (k.toLowerCase() === key) return fmt.tags[k];
  return undefined;
}
/** 歌词值：匹配 lyrics 或 lyrics-语言码 键（USLT 的 ffprobe 键是 lyrics-XXX） */
function lyricValue(fmt) {
  for (const k of Object.keys(fmt.tags || {})) if (k.toLowerCase().indexOf('lyrics') === 0) return fmt.tags[k];
  return undefined;
}
function attachedPic(file) {
  const j = probe(file, ['-show_streams']);
  let n = 0;
  for (const st of j.streams || []) if (st.disposition && st.disposition.attached_pic === 1) n++;
  return n;
}
function decodes(file) {
  try { execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { maxBuffer: 20e6 }); return true; } catch (e) { console.error('    decode err: ' + e.message.split('\n').slice(-2).join(' | ')); return false; }
}

/** readFileBytes 的 node 等价（前缀截断） */
function readFileBytes(path, maxLen) {
  const buf = readFileSync(path);
  return buf.length > maxLen ? new Uint8Array(buf.subarray(0, maxLen)) : new Uint8Array(buf);
}
/** copyRange 的 node 等价：从源文件 [from,to) 追加到 out 数组 */
function copyRange(out, srcPath, from, to) {
  const src = new Uint8Array(readFileSync(srcPath));
  if (to > src.length) return false;
  for (let i = from; i < to; i++) out.push(src[i]);
  return true;
}
function writeBytes(out, bytes) { for (let i = 0; i < bytes.length; i++) out.push(bytes[i]); }

/** 镜像 planMp3WithPrefixLadder */
function planMp3WithPrefixLadder(src, data) {
  for (const size of [64, 1024 * 1024, 16 * 1024 * 1024]) {
    const prefix = readFileBytes(src, size);
    const plan = planMp3(prefix, data);
    if (plan != null) return plan;
  }
  return null;
}
/** 镜像 embedAudioTagsSync 的 mp3 写出 */
function embedMp3LikeAndroid(srcPath, data) {
  const totalLen = readFileSync(srcPath).length;
  const plan = planMp3WithPrefixLadder(srcPath, data);
  if (plan == null) return null;
  const out = [];
  writeBytes(out, plan.newTag);
  if (!copyRange(out, srcPath, plan.oldTagSize, totalLen)) return null;
  return new Uint8Array(out);
}
/** 镜像 planFlacWithPrefixLadder + flac 写出（保留块搬运 + last 位清零） */
function embedFlacLikeAndroid(srcPath, data) {
  const totalLen = readFileSync(srcPath).length;
  let flac = null;
  for (const size of [1024 * 1024, 16 * 1024 * 1024]) {
    const prefix = readFileBytes(srcPath, size);
    const plan = planFlac(prefix, data);
    if (plan != null) { flac = { plan, prefix }; break; }
  }
  if (flac == null) return null;
  const out = [];
  writeBytes(out, new Uint8Array([0x66, 0x4c, 0x61, 0x43])); // fLaC 魔数
  writeBytes(out, flac.plan.streamInfo);
  for (const span of flac.plan.keptSpans) {
    const off = span.headerOffset;
    const head = new Uint8Array(4);
    head[0] = flac.prefix[off] & 0x7f; // last 位清零
    head[1] = flac.prefix[off + 1];
    head[2] = flac.prefix[off + 2];
    head[3] = flac.prefix[off + 3];
    writeBytes(out, head);
    if (!copyRange(out, srcPath, off + 4, off + 4 + span.dataLen)) return null;
  }
  writeBytes(out, flac.plan.vorbisComment);
  if (flac.plan.picture != null) writeBytes(out, flac.plan.picture);
  if (!copyRange(out, srcPath, flac.plan.audioOffset, totalLen)) return null;
  return new Uint8Array(out);
}

/** 造测试音频（extras: 逐个前插的字节块，模拟旧 ID3 头） */
function makeMp3(sec, extras = []) {
  const base = TMP + 'base-' + sec + 's.mp3';
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + sec, '-b:a', '128k', '-y', base]);
  let buf = readFileSync(base);
  for (const e of extras) buf = Buffer.concat([e, buf]);
  const f = TMP + 't-' + sec + 's.mp3';
  writeFileSync(f, buf);
  return f;
}
function makeFlac(sec) {
  const f = TMP + 't-' + sec + 's.flac';
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + sec, '-sample_fmt', 's16', '-c:a', 'flac', f]);
  return f;
}
const cover = readFileSync(fileURLToPath(new URL('../static/icon/mdpi.png', import.meta.url))); // PNG: 真实魔数
const data = {
  title: '测试歌名',
  artist: '测试歌手',
  album: '测试专辑',
  lrcText: '[00:01.00]第一行\n[00:05.00]second line',
  coverBytes: new Uint8Array(cover),
  coverMime: 'image/png',
};

const t1 = makeMp3(3);
try { const out = embedMp3LikeAndroid(t1, data); writeFileSync(TMP + 'r1.mp3', out);
  const fmt = probe(TMP + 'r1.mp3', ['-show_format']).format;
  if (tag(fmt, 'title') == '测试歌名' && tag(fmt, 'artist') == '测试歌手' && tag(fmt, 'album') == '测试专辑'
    && lyricValue(fmt) && lyricValue(fmt).includes('第一行')
    && attachedPic(TMP + 'r1.mp3') >= 1 && decodes(TMP + 'r1.mp3')) ok('mp3: 干净文件 全标签 + 音频可解码');
  else bad('mp3: 干净文件', new Error(JSON.stringify(fmt.tags)));
} catch (e) { bad('mp3: 干净文件', e); }

const t2 = makeMp3(3, [Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0, 0, 0, 10]), Buffer.alloc(10, 0x41)])]); // 20B 假 ID3v2
try { const out = embedMp3LikeAndroid(t2, data); writeFileSync(TMP + 'r2.mp3', out);
  const fmt = probe(TMP + 'r2.mp3', ['-show_format']).format;
  if (tag(fmt, 'title') == '测试歌名' && attachedPic(TMP + 'r2.mp3') >= 1 && decodes(TMP + 'r2.mp3')) ok('mp3: 带旧 ID3v2 头 → 剥离重写');
  else bad('mp3: 带旧 ID3v2 头', new Error('tags=' + JSON.stringify(fmt.tags)));
} catch (e) { bad('mp3: 带旧 ID3v2 头', e); }

const t3 = makeFlac(2);
try { const out = embedFlacLikeAndroid(t3, data); writeFileSync(TMP + 'r3.flac', out);
  const fmt = probe(TMP + 'r3.flac', ['-show_format']).format;
  if (tag(fmt, 'title') == '测试歌名' && tag(fmt, 'artist') == '测试歌手'
    && tag(fmt, 'lyrics') && tag(fmt, 'lyrics').includes('second line')
    && attachedPic(TMP + 'r3.flac') >= 1 && decodes(TMP + 'r3.flac')) ok('flac: 干净文件 全标签 + 音频可解码');
  else bad('flac: 干净文件', new Error('tags=' + JSON.stringify(fmt.tags)));
} catch (e) { bad('flac: 干净文件', e); }

// flac 幂等：对已嵌文件再嵌一遍（旧 VC/PICTURE 被剔除不累积）
try { const out2 = embedFlacLikeAndroid(TMP + 'r3.flac', data); writeFileSync(TMP + 'r4.flac', out2);
  const fmt = probe(TMP + 'r4.flac', ['-show_format']).format;
  const pics = attachedPic(TMP + 'r4.flac');
  if (pics == 1 && tag(fmt, 'title') == '测试歌名' && decodes(TMP + 'r4.flac')) ok('flac: 幂等重嵌, 封面仍 1 张');
  else bad('flac: 幂等重嵌', new Error('pics=' + pics + ' tags=' + JSON.stringify(fmt.tags)));
} catch (e) { bad('flac: 幂等重嵌', e); }

// mp3 幂等
try { const out2 = embedMp3LikeAndroid(TMP + 'r1.mp3', data); writeFileSync(TMP + 'r5.mp3', out2);
  const fmt = probe(TMP + 'r5.mp3', ['-show_format']).format;
  if (attachedPic(TMP + 'r5.mp3') == 1 && tag(fmt, 'title') == '测试歌名' && decodes(TMP + 'r5.mp3')) ok('mp3: 幂等重嵌, 封面仍 1 张');
  else bad('mp3: 幂等重嵌', new Error('pics=' + attachedPic(TMP + 'r5.mp3')));
} catch (e) { bad('mp3: 幂等重嵌', e); }

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
process.exit(fail.length ? 1 : 0);
