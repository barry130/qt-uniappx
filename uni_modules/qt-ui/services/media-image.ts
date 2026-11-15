import { decodeJpeg, decodePng, encodePng, convertIndexedToRgb } from "./vendor/media-codecs";
import { mediaPaletteFromPixels } from "./media-palette";
import type { MediaPalette } from "./media-palette";

/** Decode only the native 32px thumbnail, never the original album bitmap. */
export function decodeMediaSample(bytes: Uint8Array): number[] {
  if (bytes.length == 0 || bytes.length > 524288) return [];
  if (bytes[0] == 255 && bytes[1] == 216) {
    const image = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 0.02, maxMemoryUsageInMB: 8 });
    return Array.from(image.data);
  }
  if (bytes.length < 24 || bytes[0] != 137 || bytes[1] != 80 || bytes[2] != 78 || bytes[3] != 71) return [];
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(16) * header.getUint32(20) > 16384) return [];
  const decoded = decodePng(bytes);
  const indexed = decoded.palette != null ? convertIndexedToRgb(decoded) : null;
  const image = indexed != null ? { ...decoded, data: indexed, depth: 8, channels: indexed.length / (decoded.width * decoded.height) } : decoded;
  const divisor = image.depth == 16 ? 257 : image.depth < 8 ? (Math.pow(2, image.depth) - 1) / 255 : 1;
  const rgba: number[] = [];
  for (let i = 0; i < image.data.length; i += image.channels) {
    const red = image.data[i] / divisor;
    const green = image.channels <= 2 ? red : image.data[i + 1] / divisor;
    const blue = image.channels <= 2 ? red : image.data[i + 2] / divisor;
    const alpha = image.channels == 2 ? image.data[i + 1] / divisor : image.channels == 4 ? image.data[i + 3] / divisor : 255;
    rgba.push(red, green, blue, alpha);
  }
  return rgba;
}

/** A tiny PNG stretches smoothly in native image elements, including Vapor custom bases. */
export function mediaGradientPng(palette: MediaPalette): Uint8Array {
  const colors = [palette.top, palette.middle, palette.surface].map(color => [1, 3, 5].map(offset => parseInt(color.substring(offset, offset + 2), 16)));
  const pixels = new Uint8Array(128 * 4);
  for (let y = 0; y < 128; y++) {
    const ratio = y / 127;
    const from = ratio < 0.42 ? 0 : 1;
    const mix = Math.min(1, ratio < 0.42 ? ratio / 0.42 : (ratio - 0.42) / 0.47);
    for (let channel = 0; channel < 3; channel++) pixels[y * 4 + channel] = Math.round(colors[from][channel] * (1 - mix) + colors[from + 1][channel] * mix);
    pixels[y * 4 + 3] = 255;
  }
  return encodePng({ width: 1, height: 128, channels: 4, depth: 8, data: pixels });
}

export async function loadMediaPalette(src: string, current: () => boolean): Promise<MediaPalette | null> {
  let original = "";
  let temporary = "";
  try {
    const info = await new Promise<GetImageInfoSuccess>((resolve, reject) => uni.getImageInfo({ src, success: resolve, fail: reject }));
    original = info.path;
    if (!current()) return null;
    const thumbnail = await new Promise<CompressImageSuccess>((resolve, reject) => uni.compressImage({
      src: original, quality: 85, compressedWidth: 32, compressedHeight: 32, success: resolve, fail: reject,
    }));
    temporary = thumbnail.tempFilePath;
    if (!current()) return null;
    const data = await new Promise<ArrayBuffer>((resolve, reject) => uni.getFileSystemManager().readFile({
      filePath: temporary, success: result => resolve(result.data as ArrayBuffer), fail: reject,
    }));
    if (!current()) return null;
    const palette = mediaPaletteFromPixels(decodeMediaSample(new Uint8Array(data)));
    if (palette == null) return null;
    palette.cover = src;
    const png = mediaGradientPng(palette);
    palette.background = "data:image/png;base64," + uni.arrayBufferToBase64(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
    return palette;
  } catch (_) {
    // Missing/unsupported images keep the selected application skin.
    return null;
  } finally {
    // compressImage owns this new temporary file; never unlink the input/cache original.
    if (temporary.length > 0 && temporary != src && temporary != original) {
      uni.getFileSystemManager().unlink({ filePath: temporary, fail: () => {} });
    }
  }
}
