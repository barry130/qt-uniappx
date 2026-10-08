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

/**
 * 平台色按指定不透明度弱化（播放页背景氛围色等）。
 *
 * 色值来自数据包注册表，宿主不再按平台 id 写死四组 rgba：新增音源时
 * 只要包声明了 color，氛围色自动跟着变。注册表里没有该 id（本地音乐 /
 * 未装包 / 未知源）返回全透明，不硬套别家颜色。
 */
export function platformTint(platform: string, alpha: number): string {
  const registry = useSourceRegistryStore();
  if (!registry.has(platform)) return "rgba(10,13,20,0)";
  const color = registry.color(platform);
  if (color.length != 7 || color.charAt(0) != "#") return "rgba(10,13,20,0)";
  const rgb: number[] = [];
  for (let i = 1; i < 7; i += 2) {
    const value = parseInt(color.substring(i, i + 2), 16);
    if (isNaN(value)) return "rgba(10,13,20,0)";
    rgb.push(value);
  }
  const a = Math.round(alpha * 100) / 100;
  return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a + ")";
}
