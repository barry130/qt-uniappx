/**
 * 页面跳转的统一入口（宽屏去动画 + rail 工具入口就地托管）。
 *
 * 为什么需要：宽屏下左侧 rail 是 `position: fixed` 的常驻导航，由 `qt-page-frame`
 * 挂在框架层。但 Android 的 `uni.navigateTo` 默认会把**整个新页面**从右侧滑入，
 * rail 跟着一起滑 —— 观感上就是「换页时导航栏重新加载了一次」，与桌面软件
 * 「导航固定、只换内容区」的语义不符。
 *
 * rail 工具入口更进一步：宽屏下不再导航，而是把工具页**就地托管**进当前 tab 页
 * （qt-wide-workspace，官方 page-as-component）。原因是 uni-app x 在 Android 上一页
 * 一个 Activity，新 Activity 的系统起始窗必然先显示 ~4 帧默认底色（UniPageActivity
 * 主题没覆写 windowBackground），`animationType` 只能改变它的形态、关不掉它 —— 真机
 * 屏录实测见 qt-wide-workspace.ts 注释。就地托管是同 Activity、同帧换内容 ⇒ 没有起始窗。
 *
 * 普通页面跳转用 `uni.navigateTo` + `animationType: qtNavAnimation()`：宽屏瞬切（none），窄屏默认横滑。
 *
 * 平台事实（uni-app x 文档 api/navigator.md）：`animationType` 自 Android 4.18 起
 * 支持，合法值含 `none`；`animationDuration` 在 Android 不支持，所以只能选动画
 * 类型，不能调时长。pages.json 里的 `animationType` 在 Android 也不支持，只能在
 * 调用点传。
 */
import { qtLayout } from "./use-qt-layout";
import { qtTopRoute } from "./qt-page-chrome";
import {
  qtOpenWideTool,
  qtCloseWideTool,
  qtIsWideToolHost,
} from "./qt-wide-workspace";

/** 普通跳转：宽屏瞬切，窄屏保留默认横滑。 */
export function qtNavAnimation(): string {
  return qtLayout().isWide ? "none" : "auto";
}

/**
 * 切换底部导航页（发现 / 我的）的唯一入口。
 *
 * 为什么不让调用点直接用 `uni.switchTab`：鸿蒙（uni-app x）的原生 Tabs 容器
 * 在「往容器里追加第二个 tab 页」这条链路上不生效 —— `switchTab` 会回调 success、
 * `getCurrentPages()` 栈顶也会变成目标路由，但原生视图停在原页不动（2026-10-19
 * 真机探针实证：tab label 打出 S+ 后截图仍是首页）。`reLaunch` 到 tab 页同样
 * 走 `switchSelect`，一样不换视图。
 *
 * 解法：pages.json 在鸿蒙上**不注册 tabBar**（`#ifndef APP-HARMONY`），首页与我的
 * 退化成普通页面，切换改用 `reLaunch`（销毁重建页面栈，语义上等价切 tab，代价是
 * 页面重建）。其它平台保持 `switchTab`，失败时再降级 `reLaunch`。
 *
 * 注意：鸿蒙上 `uni.hideTabBar()` 会因为 tabBar 不存在而 reject，use-qt-tab-bar.ts
 * 已经吞掉这个错误，不用改。
 */
export function qtSwitchTab(url: string): void {
  // #ifdef APP-HARMONY
  uni.reLaunch({ url: url });
  // #endif
  // #ifndef APP-HARMONY
  uni.switchTab({
    url: url,
    fail: (_: any) => {
      uni.reLaunch({ url: url });
    },
  });
  // #endif
}

/**
 * rail 工具入口是工作区切换，而不是「继续向下钻一层」。
 *
 * 宽屏下三个层次依次尝试，目标都是「别让 Android 新建 Activity」：
 *   1. 就地托管（qt-wide-workspace）：栈顶就是宿主 tab 页时同窗口换内容 —— 既没有
 *      起始窗白帧，也不往页面栈里堆页面；用过的工具页保活，切换/重开瞬时恢复；
 *   2. 栈里有宿主页但栈顶不是它（歌曲页 / 歌单页 / 设置子页……）：先一次 `navigateBack`
 *      退回已经画好的宿主窗口（没有起始窗），成功后再就地托管；
 *   3. 连宿主页都没有（深链直达子页）：只能 `navigateTo`，同样用 `none` ——
 *      slide-in-right 虽能盖住创建帧，但白带横扫全屏、还把常驻 rail 一起推走，
 *      真机已实测否决（见 qt-wide-workspace.ts 头注释）；这条兜底路径在正常
 *      使用中几乎不会走到，宁可接受一次性的整窗瞬切。
 *
 * 窄屏完全按原样：直接 `navigateTo`（默认横滑）。
 */
function qtStackRouteAt(index: number): string {
  try {
    const pages = getCurrentPages();
    if (index < 0 || index >= pages.length) return "";
    const route = pages[index].route;
    if (route == null || route.length == 0) return "";
    return route.charAt(0) == "/" ? route : "/" + route;
  } catch (_) {
    return "";
  }
}

/** 找到目标在当前栈中的位置；-1 表示目标未挂载。 */
function qtStackRouteIndex(url: string): number {
  try {
    const pages = getCurrentPages();
    for (let i = pages.length - 1; i >= 0; i--) {
      if (qtStackRouteAt(i) == url) return i;
    }
  } catch (_) {}
  return -1;
}

export function qtRailNavigate(url: string): void {
  const current = qtTopRoute();
  if (current == url) return;
  // 宽屏首选：就地托管进栈顶的宿主 tab 页（同 Activity、同帧换内容 ⇒ 无起始窗白帧）
  if (qtOpenWideTool(url)) return;
  const pages = qtPageStackDepthSafe();
  // 栈顶不是宿主页、但栈里还有宿主 tab 页：先退回宿主页再托管。
  if (qtLayout().isWide) {
    let hostAt = -1;
    for (let i = pages - 1; i >= 0; i--) {
      if (qtIsWideToolHost(qtStackRouteAt(i))) {
        hostAt = i;
        break;
      }
    }
    if (hostAt >= 0 && hostAt < pages - 1) {
      const target = url;
      uni.navigateBack({
        delta: pages - 1 - hostAt,
        animationType: "none",
        success: () => {
          // 托管仍不成立（栈时序异常）时退回原生导航，别让这次点击落空
          if (!qtOpenWideTool(target)) {
            uni.navigateTo({ url: target, animationType: qtNavAnimation() });
          }
        },
      });
      return;
    }
  }
  const existing = qtStackRouteIndex(url);
  if (existing >= 0 && existing < pages - 1) {
    // 目标页仍在栈内：直接回到已挂载的原生视图，不创建/销毁目标页。
    uni.navigateBack({ delta: pages - 1 - existing, animationType: qtNavAnimation() });
    return;
  }
  uni.navigateTo({ url: url, animationType: qtNavAnimation() });
}

/**
 * 宽屏 rail 切换「发现 / 我的」前先关掉就地托管的工具页，再一次性回收工具工作路径。
 *
 * 工具页为避免闪动会短暂保留在栈中（就地托管后基本不再产生这类页面，但深链/旧路径
 * 可能留下）；直接 `switchTab` 时 Android 会逐个关闭这些 UniPageActivity，用户会看到
 * 一串回退。这里以 `navigateBack(delta)` + `none` 一次回到已挂载的 tab 根页，再切换
 * 目标 tab，既不会逐页回放，也不会让工具工作路径长期滞留。
 */
export function qtRailSwitchTab(url: string): void {
  // 就地托管的工具页不在页面栈里，也没法被 switchTab 关掉 —— 先关覆盖层
  qtCloseWideTool();
  if (qtTopRoute() == url) return;
  const pages = qtPageStackDepthSafe();
  if (!qtLayout().isWide || pages <= 1) {
    qtSwitchTab(url);
    return;
  }
  uni.navigateBack({
    delta: pages - 1,
    animationType: "none",
    success: () => {
      if (qtTopRoute() != url) qtSwitchTab(url);
    },
    fail: () => {
      // 非标准栈（例如深链）降级到运行时原生 tab 跳转。
      qtSwitchTab(url);
    },
  });
}

/** 返回上一页：宽屏同样去掉滑动动画 */
export function qtNavigateBack(): void {
  if (qtPageStackDepthSafe() > 1) {
    uni.navigateBack({ animationType: qtNavAnimation() });
    return;
  }
  // 栈底没有上一页（深链直达）：回首页而不是让返回键失效
  qtSwitchTab("/pages/home/index");
}

/** 页面栈深度（异常时按 1 处理，避免返回键误判成「有上一页」） */
function qtPageStackDepthSafe(): number {
  try {
    return getCurrentPages().length;
  } catch (_) {
    return 1;
  }
}
