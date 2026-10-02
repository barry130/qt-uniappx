import { useSourceRegistryStore } from "@/stores/source-registry";

/**
 * 平台展示信息（名称/短名/徽标色）：清单由数据包注册表声明
 * （stores/source-registry.ts），本文件只做「本地音乐」特判与未知 id 兜底。
 * 注册表加载完成前（引擎预热阶段）按「未知」显示，加载后依赖响应式自动刷新。
 */
export function platformLabel(platform: string): string {
  if (platform == "local") return "本地";
  return useSourceRegistryStore().label(platform);
}

export function platformShort(platform: string): string {
  return useSourceRegistryStore().short(platform);
}

export function platformColor(platform: string): string {
  return useSourceRegistryStore().color(platform);
}
