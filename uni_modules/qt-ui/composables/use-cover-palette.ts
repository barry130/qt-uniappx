import { ref, watch, onMounted, onUnmounted } from "vue";
import { cachedMediaPalette, cacheMediaPalette } from "../services/media-palette";
import type { MediaPalette } from "../services/media-palette";
import { loadMediaPalette } from "../services/media-image";

/** One request per settled cover; hidden pages do not decode or commit late image results. */
export function useCoverPalette(source: () => string, enabled: () => boolean) {
  const palette = ref<MediaPalette | null>(null);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stop: (() => void) | null = null;
  let disposed = false;
  function cancel(): void {
    generation++;
    if (timer != null) clearTimeout(timer);
    timer = null;
  }
  function update(): void {
    cancel();
    palette.value = null;
    const key = source();
    if (!enabled() || key.length == 0 || disposed) return;
    const cached = cachedMediaPalette(key);
    if (cached != null) { palette.value = cached; return; }
    const request = generation;
    const current = (): boolean => !disposed && request == generation && enabled() && source() == key;
    timer = setTimeout(async () => {
      timer = null;
      if (!current()) return;
      const value = await loadMediaPalette(key, current);
      if (!current() || value == null) return;
      cacheMediaPalette(key, value);
      palette.value = value;
    }, 120);
  }
  // Defer the immediate read until the page has initialized its cover fallback state.
  onMounted(() => { stop = watch(() => source() + "|" + enabled(), update, { immediate: true }); });
  onUnmounted(() => {
    disposed = true;
    cancel();
    if (stop != null) stop();
  });
  return palette;
}
