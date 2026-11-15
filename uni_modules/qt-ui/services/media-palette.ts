/** Small cover-derived tokens; independent of the application skin and setting selection color. */
export type MediaPalette = {
  cover: string;
  surface: string;
  top: string;
  middle: string;
  ink: string;
  muted: string;
  accent: string;
  rail: string;
  controlInk: string;
  background: string;
};

const palettes = new Map<string, MediaPalette>();
const PALETTE_LIMIT = 64;

export function cachedMediaPalette(key: string): MediaPalette | null {
  const value = palettes.get(key);
  if (value == null) return null;
  palettes.delete(key);
  palettes.set(key, value);
  return value;
}

export function cacheMediaPalette(key: string, value: MediaPalette): void {
  if (key.length == 0) return;
  palettes.delete(key);
  palettes.set(key, value);
  if (palettes.size > PALETTE_LIMIT) {
    const oldest = Array.from(palettes.keys())[0];
    palettes.delete(oldest);
  }
}

function hslColor(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = lightness - chroma / 2;
  const part = Math.floor(hue / 60) % 6;
  const red = part == 0 || part == 5 ? chroma : part == 1 || part == 4 ? x : 0;
  const green = part == 1 || part == 2 ? chroma : part == 0 || part == 3 ? x : 0;
  const blue = part == 3 || part == 4 ? chroma : part == 2 || part == 5 ? x : 0;
  return "#" + [red, green, blue].map(value => Math.round((value + m) * 255).toString(16).padStart(2, "0")).join("");
}

/** Quantize a 32px RGBA sample, excluding transparent pixels and white/black borders. */
export function mediaPaletteFromPixels(pixels: number[]): MediaPalette | null {
  const weights = new Array<number>(18).fill(0);
  const saturationSums = new Array<number>(18).fill(0);
  let visible = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    visible++;
    const red = pixels[i] / 255, green = pixels[i + 1] / 255, blue = pixels[i + 2] / 255;
    const high = Math.max(red, green, blue), low = Math.min(red, green, blue);
    const chroma = high - low, lightness = (high + low) / 2;
    if (chroma < 0.04 || lightness < 0.06 || lightness > 0.94) continue;
    const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
    const rawHue = high == red ? (green - blue) / chroma : high == green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
    const hue = (rawHue * 60 + 360) % 360;
    const bucket = Math.floor(hue / 20);
    const weight = (0.4 + saturation) * (1 - Math.abs(lightness - 0.5));
    weights[bucket] += weight;
    saturationSums[bucket] += saturation * weight;
  }
  if (visible == 0) return null;
  let best = 0;
  for (let i = 1; i < weights.length; i++) if (weights[i] > weights[best]) best = i;
  const colorful = weights[best] > 0;
  const hue = colorful ? best * 20 + 10 : 220;
  const saturation = colorful ? Math.min(0.42, saturationSums[best] / weights[best] * 0.55) : 0.045;
  return {
    cover: "",
    surface: "#17181d",
    top: hslColor(hue, saturation, 0.245),
    middle: hslColor(hue, saturation * 0.82, 0.135),
    ink: "#f5f3f0",
    muted: "#c3c7ce",
    accent: hslColor(hue, colorful ? Math.max(0.24, saturation) : 0.06, 0.75),
    rail: "rgba(255,255,255,0.15)",
    controlInk: hslColor(hue, saturation, 0.12),
    background: "",
  };
}
