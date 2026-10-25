/**
 * 宽屏工具页「就地托管」：把 rail 工具入口的目标页作为**组件**渲染在当前 tab 页内，
 * 而不是导航到一个新页面。
 *
 * 为什么必须这么做（真机取证，MuMu 1920x1200）：
 *   uni-app x 在 app-android 上是**一页一个 Activity** —— tab 根页驻留在
 *   `io.dcloud.uniappxv.UniAppActivity`，其余每个页面各起一个
 *   `io.dcloud.uniappxv.activity.UniPageActivity`（`dumpsys activity activities` 实测：
 *   首页 + 5 个工具页 = 1 个 UniAppActivity + 5 个 UniPageActivity）。
 *   新 Activity 的内容首帧之前，Android 先显示**系统起始窗**（starting window），而
 *   `UniPageActivity` 的主题（aapt2 dump：`style/UniAppX.Activity.DefaultTheme`）**没有**
 *   覆写 `android:windowBackground` ⇒ 宽屏每点一次工具入口都必然看到 ~4 帧 / 133ms 的
 *   整窗近白（屏录逐帧实测：`f_032`–`f_035` 全窗 (249,249,249)，near-white 99.94%）。
 *
 *   `animationType` 只能改变这 4 帧的**形态**，关不掉它：
 *     none              → 整窗白闪（rail 和内容一起消失）；
 *     slide-in-right    → 白带从右往左横扫全屏，还把旧 rail 一起推走；
 *     fade-in           → 与原生白底合成，亮帧更大更显眼（已两次实测否决）。
 *   纯 JS 层也关不掉起始窗：39 条路由已全部配 `backgroundColor`（`@pageBg`），实测无效
 *   （起始窗属于窗口背景，不属于页面绘制内容）；`uni.preloadPage` 在 uni-app x 上不支持。
 *
 * 所以宽屏不再「导航」到工具页，而是把工具页整页挂进宿主 tab 页的框架层（官方
 * page-as-component，HBuilderX 4.71+，文档 `docs/page.md`、宽屏适配 `docs/adapt.md`
 * 明确把它列为 uni-app x 的组件级宽屏适配方案）：同一个 Activity、同一帧内换内容
 * ⇒ 没有起始窗、没有白帧，也不往页面栈里堆页面（顺带修掉「返回要逐页回退」）。
 *
 * 2026-10-19 用户实测反馈（v-if 分支互换版）：不再有起始窗白帧，但每次点 rail 工具
 * 入口都会「频闪」—— 旧工具页整棵树（rail/底栏/内容）先被拆掉，新工具页建好之前
 * 的一两帧会露出覆盖层纯背景，且每次重挂载都重跑加载（骨架屏又来一遍）。所以工具页
 * 改为**保活**：每个工具页只在首次打开时创建一次，之后切换/关闭只动 `visibility`
 * （App 平台 `visibility: hidden` 不绘制、不响应交互但仍参与布局，Android 3.9+
 * 支持，`docs/css/visibility.md`；官方多子页保活建议正是这个写法，
 * `docs/collocation/pagesjson.md`；`v-show` 在 Android(Vapor) 不支持，
 * `docs/vue/built-in.md` 平台差异表标 x）。收益：切换 = 同帧改一个 CSS 属性，
 * 无重建闪动；滚动位置/输入/已加载数据全部保留，第二次进入瞬时恢复。
 * 代价：每个用过的工具页常驻内存（宽屏目标设备可接受）；页面作为组件保活后，
 * 它们的 onShow 会挂在宿主页上、随宿主页一起触发 —— 各页加载都是幂等 ensureLoad，
 * 只有多余请求、没有正确性问题。
 *
 * 语义边界：
 *   - 只有两个 tab 根页能当宿主（它们常驻 tab 根 Activity，且自带 qt-page-frame）；
 *   - 窄屏、深链、以及栈顶不是宿主页时（例如从设置子页里点工具入口），qtOpenWideTool
 *     返回 false，调用方按原样走原生 navigateTo（见 qt-nav.ts）；
 *   - back 键先关托管（宿主页的 onBackPress 里调 qtCloseWideTool）。关闭/切 tab
 *     只是「藏」：已创建的工具页组件树保活在原地，下次打开瞬时恢复。
 */
import { reactive, ref } from "vue";
import { qtTopRoute } from "./qt-page-chrome";
import { qtLayout } from "./use-qt-layout";

/** 可被就地托管的工具页，与 qt-side-nav 的 5 个工具入口一一对应 */
export const QT_WIDE_TOOL_ROUTES: string[] = [
  "/pages/search/index",
  "/pages/daily-recommend/index",
  "/pages/daily/index",
  "/pages/playlists/index",
  "/pages/chart/index",
  "/pages/settings/index",
];

/**
 * 能做宿主的页面：两个 tab 根页。
 * 覆盖层要挂在它们的框架层里，才能「同窗口、同 Activity」地换内容。
 */
export const QT_WIDE_TOOL_HOSTS: string[] = [
  "/pages/home/index",
  "/pages/profile/index",
];

export type QtWideWorkspaceState = {
  /** 当前被托管的工具路由；空串＝没有托管 */
  route: string;
  /**
   * 「打开/切换工具」的递增序号，每次 qtOpenWideTool 都 +1（即使路由值没变）。
   * 覆盖层盯的是它而不是路由值 —— 见 qt-wide-workspace.uvue 的 watch 注释。
   */
  openSeq: number;
};

const state = reactive<QtWideWorkspaceState>({ route: "", openSeq: 0 });

/** 响应式状态（模板/computed 里读 route 即可订阅） */
export function qtWideWorkspace(): QtWideWorkspaceState {
  return state;
}

/** 当前被托管的工具路由；没有托管时为空串 */
export function qtWideToolRoute(): string {
  return state.route;
}

/** 该路由是否是可托管的工具页 */
export function qtIsWideToolRoute(route: string): boolean {
  return QT_WIDE_TOOL_ROUTES.indexOf(route) >= 0;
}

/** 该路由是否是可当宿主的 tab 根页 */
export function qtIsWideToolHost(route: string): boolean {
  return QT_WIDE_TOOL_HOSTS.indexOf(route) >= 0;
}

/** 当前是否托管着某个工具页 */
export function qtWideToolActive(): boolean {
  return state.route.length > 0;
}

/**
 * 现在能不能就地托管：宽屏 + 栈顶就是宿主 tab 页。
 *
 * 用**栈顶页**判定而不是「有没有宿主注册过」：从工具页里再跳出去的普通页面（歌曲页、
 * 歌单页……）栈顶不是宿主页，此时点 rail 工具入口必须回落到原生导航 —— 否则状态会被
 * 设上却没人渲染，等用户退回 tab 页时覆盖层突然自己冒出来。
 */
export function qtWideHostReady(): boolean {
  return qtLayout().isWide && qtIsWideToolHost(qtTopRoute());
}

/**
 * 打开/切换被托管的工具页。
 * 返回 false ＝ 当前环境不支持就地托管，调用方继续走原生导航。
 *
 * 重复点当前工具也要走完：序号 +1 是覆盖层「把工具页收进保活清单」的触发器，
 * 只比路由值相等就提前返回的话，换过 tab 之后同一个工具在新宿主上会点不动
 * （新宿主的覆盖层还没创建过这份工具页，而路由值没变、什么都不会发生）。
 */
export function qtOpenWideTool(url: string): boolean {
  if (!qtIsWideToolRoute(url)) return false;
  if (!qtWideHostReady()) return false;
  state.openSeq = state.openSeq + 1;
  state.route = url;
  return true;
}

/**
 * 关掉被托管的工具页（只关显示，不拆已创建的组件树 —— 保活见 qt-wide-workspace.uvue）。
 * 返回是否真的有关掉东西 —— 宿主页的 onBackPress 用它决定这次返回键要不要吞掉。
 */
export function qtCloseWideTool(): boolean {
  if (state.route.length == 0) return false;
  state.route = "";
  return true;
}

/**
 * 宿主页 onShow 递增的刷新号。
 *
 * 覆盖层的可见性判定里有 `qtTopRoute()`（getCurrentPages，**非响应式**）：从托管
 * 的工具页里 navigateTo 到歌曲/歌单等深页再返回宿主时，页面栈变了但没有任何
 * 响应式依赖变化，覆盖层的可见性 computed 不会重算。宿主页的 onShow 里调一下
 * qtWideWorkspaceRefresh() 强制重估（见 qt-wide-workspace.uvue 的 rootStyle）。
 */
const refreshTick = ref(0);
export function qtWideWorkspaceRefresh(): void {
  refreshTick.value = refreshTick.value + 1;
}
export function qtWideWorkspaceRefreshTick(): number {
  return refreshTick.value;
}
