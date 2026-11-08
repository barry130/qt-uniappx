/**
 * 页面跳转的统一入口（rail 工具入口就地托管 + 栈内直达）。
 *
 * 为什么需要：rail 工具入口在宽屏下不再导航，而是把工具页**就地托管**进当前
 * tab 页（qt-wide-workspace，官方 page-as-component）。原因是 uni-app x 在
 * Android 上一页一个 Activity，新 Activity 的系统起始窗必然先显示 ~4 帧默认底色
 * （UniPageActivity 主题没覆写 windowBackground），`animationType` 只能改变它的
 * 形态、关不掉它 —— 真机屏录实测见 qt-wide-workspace.ts 注释。就地托管是同
 * Activity、同帧换内容 ⇒ 没有起始窗。
 *
 * 普通页面进入与返回由 App 启动时安装的 qt-navigation-motion 统一设为 none，
 * 横竖屏均不再横滑。业务直调 uni.navigateTo / navigateBack 也遵循相同策略。
 * 原生新页面仍需要创建和加载；关闭动画不代表消除首次渲染等待。
 *
 * 平台事实（uni-app x 文档 api/navigator.md）：`animationType` 自 Android 4.18 起
 * 支持，合法值含 `none`；`animationDuration` 在 Android 不支持。
 * 通过 API 拦截器设置动画，不依赖不同平台对 pages.json 动画配置的支持差异。
 */
import { qtLayout } from "./use-qt-layout";
import { qtTopRoute } from "./qt-page-chrome";
import {
  qtOpenWideTool,
  qtCloseWideTool,
  qtIsWideToolHost,
  qtWideWorkspaceRefresh,
  qtWideWorkspace,
} from "./qt-wide-workspace";

type QtNavIntent = { url: string; tab: boolean };
let activeIntent: QtNavIntent | null = null;
let queuedIntent: QtNavIntent | null = null;
let navSequence = 0;
let navWatchdog = 0;

/** 原生导航一次只发一条；过渡期间只保留最后一次点击，不逐条回放。 */
function requestNavigation(url: string, tab: boolean): void {
  const intent: QtNavIntent = { url: url, tab: tab };
  if (activeIntent != null) {
    // 又点回正在前往的目的地，相当于撤销等待中的另一目的地，无需再发一遍。
    queuedIntent = activeIntent.url == url && activeIntent.tab == tab ? null : intent;
    return;
  }
  activeIntent = intent;
  const sequence = ++navSequence;
  // 只解除缺失回执的锁，不定时重跳旧目的地。迟到回执由序号隔离。
  navWatchdog = setTimeout(() => { finishNavigation(sequence); }, 2000) as number;
  if (tab) switchTabNow(url, sequence);
  else navigateToolNow(url, sequence);
}

function navigationCurrent(sequence: number): boolean {
  return activeIntent != null && sequence == navSequence;
}

function navigationSuperseded(sequence: number): boolean {
  if (!navigationCurrent(sequence)) return true;
  const active = activeIntent;
  const queued = queuedIntent;
  return active != null && queued != null && (active.url != queued.url || active.tab != queued.tab);
}

function finishNavigation(sequence: number): void {
  if (!navigationCurrent(sequence)) return;
  clearTimeout(navWatchdog);
  navWatchdog = 0;
  activeIntent = null;
  const next = queuedIntent;
  queuedIntent = null;
  if (next != null) requestNavigation(next.url, next.tab);
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
  requestNavigation(url, true);
}

function switchTabNow(url: string, sequence: number): void {
  const workspace = qtWideWorkspace();
  const paneSequence = workspace.openSeq;
  const paneRoute = workspace.route;
  const origin = qtTopRoute();
  const closePane = (): void => {
    // 不能让旧回执卸载此后新开的工具页（包括同路由的新实例）。
    if (workspace.openSeq == paneSequence && workspace.route == paneRoute) qtCloseWideTool();
    qtWideWorkspaceRefresh();
  };
  const success = (): void => {
    if (!navigationCurrent(sequence)) return;
    closePane();
    finishNavigation(sequence);
  };
  const failed = (): void => { finishNavigation(sequence); };
  if (origin == url) {
    success();
    return;
  }
  // 保留旧内容直到目标 tab 成功，不先 navigateBack 到另一个宿主页。
  // #ifdef APP-HARMONY
  uni.reLaunch({ url: url, success: success, fail: failed });
  // #endif
  // #ifndef APP-HARMONY
  uni.switchTab({
    url: url,
    success: success,
    fail: (_: any) => {
      if (!navigationCurrent(sequence)) return;
      if (navigationSuperseded(sequence) || qtTopRoute() != origin) {
        finishNavigation(sequence);
        return;
      }
      uni.reLaunch({ url: url, success: success, fail: failed });
    },
  });
  // #endif
}

/**
 * rail 工具入口是工作区切换，而不是「继续向下钻一层」。
 *
 * 宽屏下三个层次依次尝试，目标都是「别让 Android 新建 Activity」：
 *   1. 就地托管（qt-wide-workspace）：栈顶就是宿主 tab 页时同窗口换内容 —— 既没有
 *      起始窗白帧，也不往页面栈里堆页面；单活动 pane，切换即换挂（16~300ms）；
 *   2. 栈里有宿主页但栈顶不是它（歌曲页 / 歌单页 / 设置子页……）：先一次 `navigateBack`
 *      退回已经画好的宿主窗口（没有起始窗），成功后再就地托管；
 *   3. 连宿主页都没有（深链直达子页）：只能 `navigateTo`，同样用 `none` ——
 *      slide-in-right 虽能盖住创建帧，但白带横扫全屏、还把常驻 rail 一起推走，
 *      真机已实测否决（见 qt-wide-workspace.ts 头注释）；这条兜底路径在正常
 *      使用中几乎不会走到，宁可接受一次性的整窗瞬切。
 *
 * 窄屏直接 `navigateTo`，同样由全局动画策略设为无动画。
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
  } catch (_) {
    // 静默：页面栈读不出按未挂载处理，调用方走常规导航
  }
  return -1;
}

export function qtRailNavigate(url: string): void {
  requestNavigation(url, false);
}

function navigateToolNow(url: string, sequence: number): void {
  const done = (): void => { finishNavigation(sequence); };
  const current = qtTopRoute();
  if (current == url) { done(); return; }
  // 宽屏首选：就地托管进栈顶的宿主 tab 页（同 Activity、同帧换内容 ⇒ 无起始窗白帧）
  if (qtOpenWideTool(url)) { done(); return; }
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
          if (!navigationCurrent(sequence)) return;
          if (navigationSuperseded(sequence)) { done(); return; }
          // 托管仍不成立（栈时序异常）时退回原生导航，别让这次点击落空
          if (!qtOpenWideTool(target)) {
            uni.navigateTo({ url: target, success: done, fail: done });
          } else done();
        },
        fail: done,
      });
      return;
    }
  }
  const existing = qtStackRouteIndex(url);
  if (existing >= 0 && existing < pages - 1) {
    // 目标页仍在栈内：直接回到已挂载的原生视图，不创建/销毁目标页。
    uni.navigateBack({ delta: pages - 1 - existing, success: done, fail: done });
    return;
  }
  uni.navigateTo({ url: url, success: done, fail: done });
}

/**
 * 侧栏与竖屏底栏共用同一切换事务。switchTab 自己回收非 tab 页；先回根再切 tab
 * 会把无关宿主页作为 B→C→A 的中间帧露出来。托管 pane 只在目标 tab 成功后关闭。
 */
export function qtRailSwitchTab(url: string): void {
  qtSwitchTab(url);
}

/** 返回上一页：全局策略统一去掉横竖屏的滑动动画。 */
export function qtNavigateBack(): void {
  if (qtPageStackDepthSafe() > 1) {
    uni.navigateBack();
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
