import { reactive } from "vue";

const SOURCE_KEY = "qt-source";

class SourceStore {
  /** 启动默认（注册表加载后若不在数据包清单内，会被纠正为第一个音源） */
  current = "wyy";

  restore(): void {
    try {
      const saved = uni.getStorageSync(SOURCE_KEY) as string;
      if (saved.length == 0) return;
      this.current = saved;
    } catch (_) {}
  }

  /**
   * 写入当前音源。清单在数据包注册表里（stores/source-registry.ts），
   * UI 只会传注册表里的 id；换包后存量值的有效性由注册表的
   * validateCurrentSource 纠正，这里不做本端校验。
   */
  setSource(source: string): void {
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
