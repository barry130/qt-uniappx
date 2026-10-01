import { reactive } from "vue";

const SOURCE_KEY = "qt-source";

class SourceStore {
  current = "wyy";
  private sources: string[] = ["wyy", "qq", "kw", "kg"];

  restore(): void {
    try {
      const saved = uni.getStorageSync(SOURCE_KEY) as string;
      if (saved.length == 0) return;
      this.current = saved;
    } catch (_) {}
  }

  setSource(source: string): void {
    if (this.sources.indexOf(source) < 0) return;
    this.current = source;
    try {
      uni.setStorageSync(SOURCE_KEY, source);
    } catch (_) {}
  }
}

const sourceStore = reactive(new SourceStore()) as SourceStore;

export function useSourceStore(): SourceStore {
  return sourceStore;
}
