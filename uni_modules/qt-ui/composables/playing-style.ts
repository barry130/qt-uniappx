/** Presentation preferences are independent of playback, queue and lyric timing. */
export const PLAYING_STYLES = [
  { id: "classic", label: "经典唱片", description: "唱片与滚动歌词", icon: "disc" },
  { id: "rhythm", label: "歌词律动", description: "大字随唱词起伏", icon: "music" },
  { id: "gallery", label: "专辑画廊", description: "封面与三行歌词", icon: "disc" },
  { id: "focus", label: "纯净歌词", description: "专注三行歌词", icon: "type" },
];
export const PLAYING_BACKGROUNDS = [
  { id: "auto", label: "风格默认" }, { id: "theme", label: "跟随主题" },
  { id: "cover", label: "封面氛围" }, { id: "burgundy", label: "晚霞酒红" },
  { id: "midnight", label: "午夜蓝" }, { id: "forest", label: "松林绿" },
  { id: "image", label: "本地图片" },
];
export function normalizePlayingStyle(value: string): string {
  return PLAYING_STYLES.some(item => item.id == value) ? value : "classic";
}
export function normalizePlayingBackground(value: string): string {
  return PLAYING_BACKGROUNDS.some(item => item.id == value) ? value : "auto";
}
export function resolvePlayingBackground(style: string, background: string): string {
  if (background != "auto") return background;
  if (style == "rhythm") return "burgundy";
  if (style == "gallery") return "cover";
  if (style == "focus") return "midnight";
  return "theme";
}
export function playingBackgroundColor(kind: string): string {
  if (kind == "burgundy") return "#542638";
  if (kind == "midnight") return "#172b46";
  if (kind == "forest") return "#203e36";
  return "#17202b";
}

/** Ignore blank neighbours, but keep the current timed blank as an interlude. */
export function playingLyricNeighbours(lines: { text: string }[], active: number): number[] {
  if (lines.length == 0) return [];
  const current = Math.max(0, Math.min(lines.length - 1, active));
  const result: number[] = [];
  for (let i = current - 1; i >= 0; i--) {
    if (lines[i].text.trim().length > 0) { result.push(i); break; }
  }
  result.push(current);
  for (let i = current + 1; i < lines.length; i++) {
    if (lines[i].text.trim().length > 0) { result.push(i); break; }
  }
  return result;
}

/** Playback-clock animation: pause/seek never leaves an independent animation running. */
export function playingWordPulse(elapsedMs: number, startMs: number, durationMs: number): number {
  const ratio = Math.max(0, Math.min(1, (elapsedMs - startMs) / Math.max(1, durationMs)));
  return Math.sin(ratio * Math.PI);
}
