import { reactive } from "vue";
import { normalizePlayingStyle, normalizePlayingBackground } from "../composables/playing-style";

const KEY = "qt-playing-style-v1";
const state = reactive({ style: "classic", background: "auto", image: "", saveError: false });
let restored = false;
export function usePlayingStyle() {
  if (!restored) {
    restored = true;
    try {
      const raw = uni.getStorageSync(KEY);
      if (typeof raw == "string" && raw.length > 0) {
        const saved = JSON.parse(raw);
        state.style = normalizePlayingStyle(saved.style);
        state.background = normalizePlayingBackground(saved.background);
        state.image = typeof saved.image == "string" ? saved.image : "";
        if (state.background == "image" && state.image.length == 0) state.background = "auto";
      }
    } catch (_) {
      // Corrupt storage keeps the defaults without overwriting the saved value.
      restored = false;
    }
  }
  return state;
}
export function savePlayingStyle(): void {
  restored = true;
  try {
    uni.setStorageSync(KEY, JSON.stringify({ style: state.style, background: state.background, image: state.image }));
    state.saveError = false;
  } catch (_) {
    state.saveError = true;
  }
}
export function selectPlayingStyle(value: string): void {
  state.style = normalizePlayingStyle(value);
  savePlayingStyle();
}
export function selectPlayingBackground(value: string, image: string = ""): void {
  if (value == "image") {
    if (image.length > 0) state.image = image;
    if (state.image.length == 0) return;
  }
  state.background = normalizePlayingBackground(value);
  savePlayingStyle();
}
