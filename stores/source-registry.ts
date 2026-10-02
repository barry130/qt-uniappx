import { reactive } from "vue";
import { musicApi, RegistryQuality, RegistrySource } from "@/services/music-api";
import { SOURCE_PACKS_CHANGED_EVENT } from "@/services/source-update";
import { useSourceStore } from "@/stores/source";

/**
 * 音源/音质注册表（数据包声明，宿主不内置清单）。
 *
 * 数据包经 `__qtEntries.sourceRegistry()` 声明音源（id/名称/短名/色值，
 * 顺序即 UI 展示顺序）与音质档位；后续新增/下线音源、调整音质只需发新
 * 数据包。未装数据包 / 旧版包（无该入口）时 ready=false 且各页面引导去
 * 设置→音源包管理；已取到的清单在后续空响应（引擎重载空窗等瞬态）时保留，
 * 本地音乐不受影响。
 *
 * 刷新时机：
 * - 各页面 onShow/onMounted 调 ensure()（幂等，成功过就不再请求）；
 * - 音源包安装/更新/卸载后 SOURCE_PACKS_CHANGED_EVENT 自动重取
 *   （事件在引擎重载完成、播放地址缓存清空之后广播，见 source-update.uts）。
 */
class SourceRegistryStore {
  /** 数据包声明的音源清单（顺序即切换器/榜单/设置页的展示顺序） */
  sources: RegistrySource[] = [];
  /** 数据包声明的音质档位（播放器/设置页/下载的选项来源） */
  qualities: RegistryQuality[] = [];
  /** 已成功取到注册表（区分「还没取到」与「未装包为空」） */
  ready = false;
  /** 进行中的加载（并发 ensure 共享同一次请求） */
  private loading: Promise<void> | null = null;

  /** 幂等拉取：成功过就直接返回，未成功则发起/搭车同一次加载 */
  ensure(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.loading != null) return this.loading;
    this.loading = this.load();
    return this.loading;
  }

  /** 强制重取（音源包变更后由事件触发；失败静默——注册表不是页面主数据） */
  async refresh(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      const registry = await musicApi.sourceRegistry();
      if (registry == null) {
        // 未装数据包 / 旧版包无注册表入口 / 引擎未就绪（换包重载的空窗也走这里）：
        // 只置未就绪等下次 ensure 重试，不清空已取到的清单——瞬时空响应把
        // 音源/音质选项清成空白（且无自动重试）比短暂显示旧清单伤害大得多。
        this.ready = false;
        return;
      }
      this.sources = registry.sources;
      this.qualities = registry.qualities;
      this.ready = true;
      this.validateCurrentSource();
    } finally {
      this.loading = null;
    }
  }

  /** UI 直接遍历用的源 id 列表（顺序 = 数据包声明顺序） */
  sourceIds(): string[] {
    return this.sources.map((s) => s.id);
  }

  has(id: string): boolean {
    for (let i = 0; i < this.sources.length; i++) {
      if (this.sources[i].id == id) return true;
    }
    return false;
  }

  /** 音源展示名（本地音乐固定「本地」；未知 id 兜底「未知」） */
  label(id: string): string {
    if (id == "local") return "本地";
    for (let i = 0; i < this.sources.length; i++) {
      if (this.sources[i].id == id) return this.sources[i].name;
    }
    return "未知";
  }

  /** 紧凑徽标文案（歌曲行/歌单卡角标） */
  short(id: string): string {
    if (id == "local") return "本地";
    for (let i = 0; i < this.sources.length; i++) {
      if (this.sources[i].id == id) return this.sources[i].short;
    }
    return "未知";
  }

  /** 平台徽标底色（#rrggbb；本地与未知源用中性灰） */
  color(id: string): string {
    if (id == "local") return "#8b93a7";
    for (let i = 0; i < this.sources.length; i++) {
      if (this.sources[i].id == id) return this.sources[i].color;
    }
    return "#8b92a1";
  }

  /** 音质展示名（旧存量值兜底：320 显示高品 320k，其余显示原始 id） */
  qualityLabel(id: string): string {
    for (let i = 0; i < this.qualities.length; i++) {
      if (this.qualities[i].id == id) return this.qualities[i].name;
    }
    if (id == "320") return "高品 320k";
    return id;
  }

  /**
   * 注册表加载后纠正当前音源：换包后原音源可能已下线（存量 storage 里也
   * 可能存着脏值），回退到数据包声明的第一个音源，避免页面拿死 id 请求。
   */
  private validateCurrentSource(): void {
    if (this.sources.length == 0) return;
    const store = useSourceStore();
    if (!this.has(store.current)) store.setSource(this.sources[0].id);
  }
}

const sourceRegistryStore = reactive(new SourceRegistryStore()) as SourceRegistryStore;

// 音源包安装/更新/卸载完成后重取注册表（bumpPacksChanged 在引擎重载后才广播，
// 这里拿到的一定是新版包的清单；重取失败维持原清单，下次 ensure 再试）
uni.$on(SOURCE_PACKS_CHANGED_EVENT, () => {
  sourceRegistryStore.ready = false;
  sourceRegistryStore.ensure();
});

export function useSourceRegistryStore(): SourceRegistryStore {
  return sourceRegistryStore;
}
