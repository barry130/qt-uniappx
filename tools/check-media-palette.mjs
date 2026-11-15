import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import jpeg from "jpeg-js";
import { decode as fixtureDecodePng, encode as fixtureEncodePng } from "fast-png";
import { mediaPaletteFromPixels, cachedMediaPalette, cacheMediaPalette } from "../uni_modules/qt-ui/services/media-palette.ts";
import { playingTrackMetrics } from "../uni_modules/qt-ui/composables/playing-track-metrics.ts";

// Match Android's UTF-8-only TextDecoder, including top-level module loading.
const NativeTextDecoder = globalThis.TextDecoder;
globalThis.TextDecoder = class extends NativeTextDecoder {
  constructor(encoding = "utf-8", options) {
    if (!["utf-8", "utf8"].includes(encoding.toLowerCase())) throw new RangeError("unsupported runtime encoding");
    super(encoding, options);
  }
};
const { decodeJpeg, decodePng, encodePng, convertIndexedToRgb } = await import("../uni_modules/qt-ui/services/vendor/media-codecs.js");
globalThis.TextDecoder = NativeTextDecoder;

const luminance = color => {
  const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const contrast = (a, b) => {
  const values = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
};
assert.equal(mediaPaletteFromPixels([]), null);
assert.equal(mediaPaletteFromPixels([255, 0, 0, 0]), null, "transparent art falls back to the application skin");
for (const pixel of [[210, 25, 45, 255], [110, 185, 206, 255], [18, 102, 55, 255], [255, 255, 255, 255], [0, 0, 0, 255]]) {
  const palette = mediaPaletteFromPixels(pixel);
  for (const surface of [palette.top, palette.middle, palette.surface]) {
    assert.ok(contrast(palette.ink, surface) >= 7, "main text retains high contrast over the entire gradient");
    assert.ok(contrast(palette.muted, surface) >= 4.5, "secondary text remains readable");
  }
  assert.ok(contrast(palette.accent, palette.controlInk) >= 7, "transport icon remains readable on its cover tint");
}
const red = mediaPaletteFromPixels([210, 25, 45, 255]);
const blue = mediaPaletteFromPixels([110, 185, 206, 255]);
assert.notEqual(red.top, blue.top, "different cover hues produce different media backgrounds");
const bordered = mediaPaletteFromPixels([...new Array(300).fill([255, 255, 255, 255]).flat(), 210, 25, 45, 255]);
assert.equal(bordered.top, red.top, "a white sleeve does not wash out the album hue");
for (let index = 0; index < 64; index++) cacheMediaPalette("lru:" + index, red);
assert.equal(cachedMediaPalette("lru:0"), red);
cacheMediaPalette("lru:64", blue);
assert.equal(cachedMediaPalette("lru:1"), null);
assert.equal(cachedMediaPalette("lru:0"), red, "recently used covers survive bounded LRU eviction");

const readScript = path => stripTypeScriptTypes(readFileSync(new URL("../" + path, import.meta.url), "utf8").replace(/^import .*;$/gm, "").replace(/^export /gm, ""));
const imageScript = readScript("uni_modules/qt-ui/services/media-image.ts");
const samplePixels = new Uint8Array(32 * 32 * 4);
for (let i = 0; i < samplePixels.length; i += 4) samplePixels.set([110, 185, 206, 255], i);
const thumbnail = fixtureEncodePng({ width: 32, height: 32, data: samplePixels, channels: 4, text: { Title: "café" } });
assert.equal(decodePng(thumbnail).text.Title, "café", "PNG Latin-1 metadata works without a platform Latin-1 codec");
const nativeCalls = [], removed = [];
let thumbPath = "/sample/owned.png", compressError = false, readError = false, staleAfterCompress = false, current = true;
const native = {
  getImageInfo: options => { nativeCalls.push("info"); options.success({ path: "/cache/original.jpg" }); },
  compressImage: options => {
    nativeCalls.push("compress");
    assert.equal(options.compressedWidth, 32); assert.equal(options.compressedHeight, 32);
    if (compressError) { options.fail(Error("unsupported")); return; }
    if (staleAfterCompress) current = false;
    options.success({ tempFilePath: thumbPath });
  },
  getFileSystemManager: () => ({
    readFile: options => { nativeCalls.push("read"); readError ? options.fail(Error("gone")) : options.success({ data: thumbnail.buffer.slice(thumbnail.byteOffset, thumbnail.byteOffset + thumbnail.byteLength) }); },
    unlink: options => removed.push(options.filePath),
  }),
  arrayBufferToBase64: value => Buffer.from(value).toString("base64"),
};
const imageApi = runInNewContext(imageScript + "\n;({decodeMediaSample,mediaGradientPng,loadMediaPalette});", { decodeJpeg, decodePng, encodePng, convertIndexedToRgb, mediaPaletteFromPixels, uni: native });
assert.deepEqual(Array.from(imageApi.decodeMediaSample(thumbnail)), Array.from(samplePixels));
const jpegBytes = jpeg.encode({ width: 32, height: 32, data: samplePixels }, 90).data;
assert.equal(imageApi.decodeMediaSample(jpegBytes).length, samplePixels.length);
const gradient = fixtureDecodePng(imageApi.mediaGradientPng(blue));
assert.equal(gradient.width, 1); assert.equal(gradient.height, 128);
assert.deepEqual(Array.from(gradient.data.slice(0, 3)), [1, 3, 5].map(offset => parseInt(blue.top.slice(offset, offset + 2), 16)));
assert.deepEqual(Array.from(gradient.data.slice(-4, -1)), [1, 3, 5].map(offset => parseInt(blue.surface.slice(offset, offset + 2), 16)));
const nativePalette = await imageApi.loadMediaPalette("native:cover", () => current);
assert.equal(nativePalette.cover, "native:cover");
assert.ok(nativePalette.background.startsWith("data:image/png;base64,"));
assert.deepEqual(removed, ["/sample/owned.png"], "the temporary thumbnail is released after reading");
current = false; nativeCalls.length = 0;
assert.equal(await imageApi.loadMediaPalette("native:stale", () => current), null);
assert.deepEqual(nativeCalls, ["info"], "superseded covers skip thumbnail generation");
current = true; staleAfterCompress = true; nativeCalls.length = 0;
assert.equal(await imageApi.loadMediaPalette("native:late", () => current), null);
assert.deepEqual(nativeCalls, ["info", "compress"]);
assert.equal(removed.at(-1), "/sample/owned.png", "late native thumbnails are still released");
current = true; staleAfterCompress = false; readError = true;
assert.equal(await imageApi.loadMediaPalette("native:read-fail", () => current), null);
assert.equal(removed.at(-1), "/sample/owned.png");
readError = false; thumbPath = "/cache/original.jpg"; const removalCount = removed.length;
await imageApi.loadMediaPalette("native:shared", () => current);
assert.equal(removed.length, removalCount, "a native API returning the original must never cause its deletion");
compressError = true;
assert.equal(await imageApi.loadMediaPalette("native:fail", () => current), null);

// Exercise the production lifecycle with deliberately reversed asynchronous replies.
const script = readScript("uni_modules/qt-ui/composables/use-cover-palette.ts");
const props = { src: "sampler:first", enabled: true };
const requests = [], timers = new Map();
let timerId = 0, watchChange, dispose, mount;
const lifecycle = runInNewContext(script + "\n;({useCoverPalette});", {
  ref: value => ({ value }),
  onMounted: callback => { mount = callback; },
  onUnmounted: callback => { dispose = callback; },
  watch: (_get, callback) => { watchChange = callback; callback(); return () => {}; },
  setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
  clearTimeout: id => timers.delete(id),
  loadMediaPalette: (key, current) => new Promise(resolve => requests.push({ key, current, resolve })),
  cachedMediaPalette, cacheMediaPalette,
});
const flush = () => { for (const [key, callback] of [...timers]) { timers.delete(key); callback(); } };
const drain = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const sampled = lifecycle.useCoverPalette(() => props.src, () => props.enabled);
mount(); flush();
props.src = "sampler:second"; watchChange(); flush();
requests[1].resolve({ ...blue, cover: props.src }); await drain();
assert.equal(sampled.value.cover, props.src);
requests[0].resolve({ ...red, cover: "sampler:first" }); await drain();
assert.equal(sampled.value.cover, props.src, "late old cover callbacks cannot repaint the new song");
props.src = "sampler:third"; watchChange(); flush();
props.enabled = false; watchChange();
requests[2].resolve({ ...red, cover: "sampler:third" }); await drain();
assert.equal(sampled.value, null, "hidden pages discard pending work");
props.src = "sampler:second"; props.enabled = true; watchChange(); flush();
assert.equal(requests.length, 3, "cached covers do not load another image");
assert.equal(sampled.value.cover, "sampler:second");
props.src = "sampler:fourth"; watchChange(); dispose(); flush();
assert.equal(requests.length, 3, "unmount cancels the debounce before native decoding");

const page = readFileSync(new URL("../pages/player/index.uvue", import.meta.url), "utf8");
const metricsCode = stripTypeScriptTypes(readFileSync(new URL("../uni_modules/qt-ui/composables/player-presentation.ts", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""));
const portraitPlayerMetrics = new Function("playingTrackMetrics", metricsCode + "\nreturn portraitPlayerMetrics;")(playingTrackMetrics);
for (const [width, height, windowWidth] of [[320, 568, 320], [360, 800, 360], [390, 844, 390], [340, 640, 700]]) {
  for (const scale of [0.85, 1, 1.15, 1.3, 1.5]) {
    const metrics = portraitPlayerMetrics(width, height, 24, 24, scale, windowWidth, "网易云音乐 · 高品 320k", "gallery", "但愿人长久");
    const unit = windowWidth / 750;
    const context = playingTrackMetrics(metrics.trackWidthPx, windowWidth, false, false, scale, "网易云音乐 · 高品 320k", true, "但愿人长久");
    assert.ok(metrics.discRpx * unit <= Math.min(300, width * 0.765), "album artwork follows the preview proportion");
    assert.ok(metrics.headingHeightPx <= context.heightPx);
    assert.ok(context.contextCopyPx + context.contextCoverPx + context.hitPx + context.gapPx + 10 <= metrics.trackWidthPx + 0.001);
    // 歌词页标题改为两行紧排（歌名-歌手 / 平台·音质），整块 copy 区域可点；
    // 触摸目标由整块高度保证，不再要求次行单独 44px（那会把两行撑开）。
    assert.ok(context.heightPx >= 44, "the condensed heading keeps a 44px source touch target across two tight lines");
    assert.ok(metrics.focusHeightPx >= 0);
    assert.ok(metrics.contentHeightPx + metrics.footerPx + metrics.padTopPx + metrics.padBottomPx + 24 <= height + 0.001);
  }
}
const normal = playingTrackMetrics(316, 360, false, false, 1, "网易云音乐 · 高品 320k", false, "但愿人长久");
assert.equal(normal.stacked, false, "ordinary package labels fit beside the artist at 360dp");
assert.ok(normal.sourceWidthPx < 180, "Latin quality suffixes do not inflate the source chip");
assert.match(page, /mediaPalette\.value\?\.cover == art\(\)/, "a cached palette is tied to its actual cover");
assert.match(page, /<QtPlayingTrack :compact="true"/);
console.log("Media palette: contrast, JPEG/PNG thumbnails, native temporary-file cleanup, bounded LRU, callback races, and gallery/heading geometry passed");
