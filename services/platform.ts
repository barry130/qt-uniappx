import { useSourceRegistryStore } from "@/stores/source-registry";
import { PODCAST_PLATFORM } from "@/services/podcast";

/**
 * 平台展示信息（名称/短名/徽标色）：清单由数据包注册表声明
 * （stores/source-registry.ts），本文件只做「本地音乐 / 播客」这两个
 * 非音源平台的特判与未知 id 兜底。
 *
 * 播客不是音源包：单集音频直链直接交给播放引擎（见 services/podcast.ts 与
 * music-api.playUrl 的播客短路），注册表里永远不会有它，所以必须在这里拦，
 * 否则列表角标会显示「未知」。注册表加载完成前（引擎预热阶段）其它平台按
 * 「未知」显示，加载后依赖响应式自动刷新。
 */
export function platformLabel(platform: string): string {
  if (platform == "local") return "本地";
  if (platform == PODCAST_PLATFORM) return "播客";
  return useSourceRegistryStore().label(platform);
}

export function platformShort(platform: string): string {
  if (platform == PODCAST_PLATFORM) return "播客";
  return useSourceRegistryStore().short(platform);
}

export function platformColor(platform: string): string {
  if (platform == PODCAST_PLATFORM) return "#7c5cff";
  return useSourceRegistryStore().color(platform);
}
