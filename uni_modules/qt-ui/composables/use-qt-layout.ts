import { reactive } from "vue";

/**
 * 窗口尺寸档位（宽屏改造成员：所有页面/组件只按本枚举分支，不再各自写数字阈值）。
 *
 *   compact  <600   手机竖屏：底部 TabBar，无 rail
 *   medium   600-899 横屏手机 / 小窗：64px 图标 rail，单列
 *   wide     900-1279 平板：208px 完整 rail，按最小列宽决定单列/两列
 *   desktop  >=1280 桌面级窗口：208px rail，两列 + 常驻底部播放栏
 *
 * 阈值集中在这里，是为了修掉「qt-side-nav 用 860、home 用 720、各页 -wide 用 720」
 * 三套互不一致的断点（同一个窗口下 rail 已经收起、页面却还按宽屏排版）。
 */
export const QT_BREAKPOINT_MEDIUM = 600;
export const QT_BREAKPOINT_WIDE = 900;
export const QT_BREAKPOINT_DESKTOP = 1280;
/** 矮屏判定（640x360 / 车机低矮窗口）：横屏时可用高度不足以放下「头图 + 列表」 */
export const QT_BREAKPOINT_SHORT = 520;

/** 兼容既有 useQtLayout(breakpoint) 调用点的默认参数；不参与 isWide 判定。 */
export const QT_BREAKPOINT_DEFAULT = 720;

export type QtSizeClass = "compact" | "medium" | "wide" | "desktop";

export type QtLayoutState = {
  windowWidth: number;
  windowHeight: number;
  breakpoint: number;
  isLandscape: boolean;
  isWide: boolean;
  /** 宽度档位（只看 windowWidth，不含 isLandscape 的兼容分支） */
  sizeClass: QtSizeClass;
  /** sizeClass == "desktop"，多列布局的唯一开关 */
  isDesktop: boolean;
  /** 矮屏：windowHeight < 520 */
  isShort: boolean;
  /** 每发生一次真实尺寸变化自增；给「必须重建列表」的宿主做 key 用 */
  sizeEpoch: number;
};

const layout = reactive<QtLayoutState>({
  windowWidth: 375,
  windowHeight: 667,
  breakpoint: QT_BREAKPOINT_DEFAULT,
  isLandscape: false,
  isWide: false,
  sizeClass: "compact",
  isDesktop: false,
  isShort: false,
  sizeEpoch: 0,
});

let initialized = false;
/** 窗口尺寸监听定时器：0 表示未启动 */
let watcherTimer: number = 0;
/** App 退到后台时暂停监听，回前台恢复（由 App.uvue 调用） */
let watcherPaused = false;
/** 上一次真正读取系统信息的时间戳，用于挂载高峰期的同步节流 */
let lastReadAt = 0;

/**
 * 挂载节流窗口：长列表一次挂载上百个行组件（行组件 + 行内图标都会调 useQtLayout），
 * 每个组件都同步调一次 uni.getSystemInfoSync() 开销叠加很可观。
 * 200ms 内的重复读取直接复用上次结果 —— 窗口尺寸不可能在这点时间里变化两次。
 */
const READ_THROTTLE_MS = 200;

function sizeClassOf(width: number): QtSizeClass {
  if (width >= QT_BREAKPOINT_DESKTOP) return "desktop";
  if (width >= QT_BREAKPOINT_WIDE) return "wide";
  if (width >= QT_BREAKPOINT_MEDIUM) return "medium";
  return "compact";
}

function readWindowSize(force: boolean = false): { width: number; height: number } {
  const now = Date.now();
  if (!force && initialized && now - lastReadAt < READ_THROTTLE_MS) {
    return {
      width: layout.windowWidth,
      height: layout.windowHeight,
    };
  }
  lastReadAt = now;
  try {
    const info = uni.getSystemInfoSync();
    return {
      width: info.windowWidth,
      height: info.windowHeight,
    };
  } catch (_) {
    return {
      width: layout.windowWidth,
      height: layout.windowHeight,
    };
  }
}

export function refreshQtLayout(breakpoint: number = QT_BREAKPOINT_DEFAULT): void {
  layout.breakpoint = breakpoint;
  // 强制真读：调用方（App.onLaunch、检测到尺寸变化后）要的是当前真实尺寸，
  // 不能被挂载节流挡掉
  const size = readWindowSize(true);
  const changed = size.width != layout.windowWidth || size.height != layout.windowHeight;
  layout.windowWidth = size.width;
  layout.windowHeight = size.height;
  // 两个维度都必须是有效值才敢判横屏。某些 ROM 在转屏瞬间会把 windowHeight 报成 0
  // （getSystemInfoSync 拿到中间态），此时 `width > height` 恒真，竖屏手机被当成横屏：
  // 720x1280 的竖屏窗口会走「横屏 + medium」分支进入宽屏布局，长出 64px 图标 rail、
  // 底部 TabBar 消失（真机症状：竖屏手机整页变成宽屏版式）。宁可保守回落竖屏。
  layout.isLandscape = size.width > 0 && size.height > 0 && size.width > size.height;

  // Android 模拟器的 1600x900 往往经过高 DPI 缩放，
  // getSystemInfoSync().windowWidth 可能只有 400 左右，不能只用 720px 判断宽屏。
  // 横屏是宽屏布局的可靠信号，但**必须同时要求宽度达到 medium 档**：
  // 只看 isLandscape 会把 640x360 这类「横着的手机」也判成宽屏，于是 208px 的
  // rail 在 240dp 宽的窗口里占掉 45%，内容列被挤成一条。横屏但要放不下 rail 的
  // 情况（车机矮窗、小窗口分屏）应当退回 compact：走底部 TabBar、不要 rail。
  //
  // isWide 必须与 sizeClass 同源，只能用 wide/desktop 两档门槛（900/1280），
  // **不能再用历史遗留的 breakpoint=720**：720dp 是 medium 档（600–899），
  // 竖屏手机/平板在高 DPI 缩放下很容易正好落在 720dp，用 720 判宽屏会让
  // 「竖着的手机」也长出侧边 rail（真机症状：竖屏出现图标轨 + 无底部 TabBar）。
  layout.isWide = layout.windowWidth >= QT_BREAKPOINT_WIDE
    || (layout.isLandscape && layout.windowWidth >= QT_BREAKPOINT_MEDIUM);
  layout.sizeClass = sizeClassOf(layout.windowWidth);
  layout.isDesktop = layout.sizeClass == "desktop";
  layout.isShort = layout.windowHeight < QT_BREAKPOINT_SHORT;
  if (changed) layout.sizeEpoch = layout.sizeEpoch + 1;
  initialized = true;
}

function startWindowWatcher(breakpoint: number): void {
  // 后台期间不启动（等 resumeQtLayoutWatcher 拉起），避免后台组件挂载把轮询叫醒
  if (watcherPaused) return;
  if (watcherTimer != 0) return;
  watcherTimer = setInterval(() => {
    let width = layout.windowWidth;
    let height = layout.windowHeight;
    try {
      const info = uni.getSystemInfoSync();
      width = info.windowWidth;
      height = info.windowHeight;
    } catch (_) {
      return;
    }
    if (width == layout.windowWidth && height == layout.windowHeight) return;
    refreshQtLayout(breakpoint);
  }, 1000) as unknown as number;
}

function stopWindowWatcher(): void {
  if (watcherTimer != 0) {
    clearInterval(watcherTimer);
    watcherTimer = 0;
  }
}

/**
 * App onHide 时调用：真正停掉定时器（不再只是置标志——置标志时原生层的
 * 定时器仍每秒空转一次）。重新 startWindowWatcher 会用新的闭包和断点重建。
 */
export function pauseQtLayoutWatcher(): void {
  watcherPaused = true;
  stopWindowWatcher();
}

/** App onShow 时调用：恢复监听并立刻同步一次（后台期间可能被系统改了窗口尺寸） */
export function resumeQtLayoutWatcher(breakpoint: number = QT_BREAKPOINT_DEFAULT): void {
  watcherPaused = false;
  syncQtLayout(breakpoint);
  startWindowWatcher(breakpoint);
}

/** 手动同步一次：尺寸有变化时才刷新 reactive，无变化零开销 */
export function syncQtLayout(breakpoint: number = QT_BREAKPOINT_DEFAULT): void {
  if (!initialized) {
    refreshQtLayout(breakpoint);
    startWindowWatcher(breakpoint);
    return;
  }
  const size = readWindowSize();
  if (size.width != layout.windowWidth || size.height != layout.windowHeight) {
    refreshQtLayout(breakpoint);
  }
}

export function useQtLayout(breakpoint: number = QT_BREAKPOINT_DEFAULT): QtLayoutState {
  // 每次组件挂载都同步一次：跨页面导航、旋转后新开页面都能拿到最新窗口尺寸
  syncQtLayout(breakpoint);
  startWindowWatcher(breakpoint);
  return layout;
}

/**
 * 模块级单例的只读访问（无挂载副作用）。
 * 给「纯函数 helper 需要读当前档位」用：qt-widths / font-scale 这类工具不能在
 * 每次调用时启动窗口监听，只要读值。
 */
export function qtLayout(): QtLayoutState {
  return layout;
}

/** 状态栏高度（px）；navigationStyle: custom 的页面用它给内容让位 */
export function qtStatusBarPx(): number {
  try {
    const info = uni.getWindowInfo();
    return Math.round(info.statusBarHeight > 0 ? info.statusBarHeight : 0);
  } catch (_) {
    return 0;
  }
}

/**
 * JS 侧 rpx -> px 换算。**必须与 CSS 的 rpx 逐位一致**：uni-app x 的 rpx 一律按
 * `windowWidth / 750` 折算，没有任何封顶（`pages.json` 的
 * `rpxCalcMaxDeviceWidth` / `rpxCalcBaseDeviceWidth` 官方 schema 对 uni-app x 标了
 * `unixVer: "x"`，即不支持）。
 *
 * 反面教材（2026-10-20 修）：这里曾按「窗口 >500dp 后 CSS rpx 按 375 基准封顶」
 * 折算，即 `n * (win>500 ? 375 : win) / 750`。这个前提对 uni-app x 是错的 ——
 * 720dp 模拟器上实测 68rpx 渲染 64.7dp（= 68 × 720/750），而 qtRpx(68) 只算出 34px。
 * 于是「JS 算出的宽高」只有「CSS rpx 渲染出的文字/内边距」的一半：
 * 首页「为你整理」的 railHeight = cardWidth + qtRpx(140) 装不下两行 rpx 卡名、
 * 推荐歌单封面按 JS 卡宽裁切、悬浮球容器 60px 里塞 115px 的内圈。
 * 教训：任何一处「JS 算 px + CSS 用 rpx」混排的布局，都要求这两套换算同源。
 */
export function qtRpx(n: number): number {
  let win = 375;
  try {
    win = uni.getWindowInfo().windowWidth;
  } catch (_) {}
  return n * (win / 750);
}

/**
 * 只读宽屏判定：给「必须在模板里按宽窄分支、又不想在调用点引入布局 composable」
 * 的 helper 用（典型是 stores/font-scale.ts 的 qtFontDual —— 它要在内联字号里
 * 复现 `-wide` 的 px 覆盖，又不能触发 useQtLayout 的挂载同步与窗口监听副作用）。
 *
 * 直接读模块级单例 layout，所以与页面里的 `layout.isWide` 完全同源；在模板渲染
 * 期间调用同样会被 reactive 追踪，窗口变化时内联字号会跟着重算。
 */
export function qtIsWide(): boolean {
  return layout.isWide;
}

/** 只读档位判定（同上，给 helper 用） */
export function qtSizeClass(): QtSizeClass {
  return layout.sizeClass;
}

/** 是否桌面级窗口（多列布局开关） */
export function qtIsDesktop(): boolean {
  return layout.isDesktop;
}

/**
 * 宽屏左侧导航占用的横向宽度：
 *   未进宽屏        -> 0（底部 TabBar，无 rail）
 *   medium（600+）  -> 64（图标 rail，横屏手机 / 车机矮窗）
 *   wide/desktop    -> 208（完整 rail）
 *
 * 原实现是 `use-qt-tab-bar.ts` 里的 qtSideNavWidth(>=860?208:64)，与 rail 组件里的
 * `windowWidth < 860` 各写一份数字；这里统一成一份，两处都从这里取。
 */
export function qtRailWidth(): number {
  if (!layout.isWide) return 0;
  // 2026-10-25 对齐网易云 Pad：wide/desktop 档 rail 收成 96px 的「图标上、
  // 小字下」紧凑栏（原 208px 文字横排栏在 1097dp 窗口吃掉近 1/5 内容宽）。
  // medium 档仍是 64px 纯图标栏。
  return layout.sizeClass == "medium" ? 64 : 96;
}

/**
 * 底部悬浮 TabBar 的「总占位」：离地 24rpx + 高 120rpx = **144rpx**，与
 * `qt-tab-bar.uvue` 同源。
 *
 * 2026-10-20 修：原来是写死的 `72`（px，375dp 基准下的设计值）。但 TabBar 与整页
 * 手机档内容一样会随窗口宽度放大（见 qt-tab-bar 注释），常量写死 px 就只在 375dp
 * 手机上对；在 720dp 窗口上 TabBar 实际占 144 × 0.96 ≈ 138px，而这里仍返回 72，
 * 于是 toast 与悬浮球会压进 TabBar。改成走 `qtRpx(144)` 后与 CSS 完全同源。
 *
 * 给「浮在底部、必须让开 TabBar 才不遮挡」的宿主用（qt-toast-host；
 * qt-mini-player 悬浮球的初始边距也按它整体取值）。抽成函数而不是让各宿主
 * 各写一份，是因为这几处一旦不同步，症状是浮层静静压在图标上 —— 只在真机上
 * 看得见。宽屏下 TabBar 不渲染（qt-tab-bar 自带 v-if），但调用方本来就按
 * `layout.isWide` 分支，这里不做判断。
 */
export const QT_TAB_BAR_HEIGHT_RPX = 144;

export function qtTabBarHeightPx(): number {
  return qtRpx(QT_TAB_BAR_HEIGHT_RPX);
}

/**
 * 常驻底部播放栏高度（px）：宽屏下 qt-mini-player 从浮动 FAB 变成 dock 底栏，
 * 页面内容与 toast / 返回顶部都要让开这段高度。
 */
export const QT_PLAYER_BAR_HEIGHT_PX = 64;
