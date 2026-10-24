import { watch, type Ref } from "vue";
import { useQtLayout } from "./use-qt-layout";

/**
 * 原生 tabbar 可见性与宽窄屏联动：宽屏（横屏 / 平板 / 车机）由左侧导航
 * qt-side-nav 取代底部 tabbar，需要把原生 tabbar 隐藏；手机竖屏保持显示。
 * forceHide 用于弹层（公告 / 升级弹窗等）期间临时隐藏，结束后按宽窄屏恢复。
 * 仅限 tab 页使用；重复调用 show/hide 的报错通过 fail 回调吞掉。
 */
export function useQtTabBarSync(forceHide?: Ref<boolean>): void {
  const layout = useQtLayout();
  const apply = (): void => {
    // 底部导航已换成自绘 qt-tab-bar（跟随皮肤强调色），原生 tabBar 始终隐藏；
    // 宽屏由 qt-side-nav 接管，同样不需要原生 tabBar。
    try {
      uni.hideTabBar({ animation: false, fail: (_: any) => {} });
    } catch (_) {}
  };
  watch(() => layout.isWide, apply, { immediate: true });
  if (forceHide != null) watch(forceHide, apply);
}
