/**
 * 全应用页面切换无动画，横竖屏使用同一策略。
 * 在 App.onLaunch 最早安装，覆盖共享导航、业务直调、navigator 及系统返回键。
 * 只修改动画参数，保留 URL、delta、事件通道、回调和 onBackPress 的拦截语义。
 * switchTab / redirectTo / reLaunch 本身无页面转场，不给它们添加不支持的参数。
 */
let installed = false;

export function installQtNavigationMotion(): void {
  if (installed) return;
  installed = true;
  uni.addInterceptor("navigateTo", {
    invoke(options: NavigateToOptions): void {
      options.animationType = "none";
    },
  } as AddInterceptorOptions);
  uni.addInterceptor("navigateBack", {
    invoke(options: NavigateBackOptions): void {
      options.animationType = "none";
    },
  } as AddInterceptorOptions);
}
