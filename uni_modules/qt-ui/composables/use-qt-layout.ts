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
  /**
   * 底部安全区高度（px）：三键导航 / 虚拟导航条遮住窗口底边的部分。
   * 鸿蒙窗口默认 edge-to-edge，导航条直接压在应用内容上；Android 的
   * Activity/页面可能分别报告完整窗口与已经避让的窗口，需要按几何扣除已避让量。
   * 悬浮 TabBar / toast 让位 / 悬浮球初始边距 / 页面滚动内容底 padding
   * 都要把它叠上去，否则非全面屏手机上底部元素与触控键重叠。
   * 来源优先级：原生避让区（applyQtNativeSafeBottom 写入）> uni.safeAreaInsets
   * ——安卓上后者报 592（真值 158 设备像素 / 42 逻辑像素，2026-10-31 vivo V2505A
   * 实锤），既不是设备像素也不是逻辑像素，只能当原生读数到达前的兜底，
   * 详见 readSafeBottom。**本字段单位是逻辑像素（CSS px）**。
   */
  safeBottomPx: number;
  /** 系统底栏的完整高度，不随页面是否已经 inset 改变；仅用于导航间距策略。 */
  navigationInsetPx: number;
  /** -1 unknown; 0 gestures / no keys; 1 system navigation keys (even when already inset). */
  navigationKeys: number;
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
  safeBottomPx: 0,
  navigationInsetPx: 0,
  navigationKeys: -1,
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
 * 原生侧异步读到的底部导航避让高度（px）。-1 = 尚未读到（此时退回 uni 的
 * safeAreaInsets，见 readSafeBottom）；>=0 = 原生已给出结论，此时它是唯一可信来源
 *（写入方 applyQtNativeSafeBottom，来源 qt-app-native 避让区查询）。
 */
let nativeBottomInsetPx: number = -1;

/**
 * uni safeAreaInsets 兜底值的封顶比例（相对窗口高）。安卓上这个读数报的是 592
 * （三键导航真值 158 设备像素 = 42 逻辑像素，这个 592 既不是设备像素也不是逻辑
 * 像素，占窗口高 18.7%），不夹住会把内容区收短半屏；封顶只在原生读数到达前 /
 * 没有原生读数的平台起作用。
 */
const SAFE_BOTTOM_FALLBACK_CAP_RATIO = 0.15;

/**
 * 挂载节流窗口：长列表一次挂载上百个行组件（行组件 + 行内图标都会调 useQtLayout），
 * 每个组件都同步查询窗口开销叠加很可观。200ms 内的挂载读取复用快照；
 * onResize 与原生 inset 回调不走节流，真实变化立即同步。
 */
const READ_THROTTLE_MS = 200;

function sizeClassOf(width: number): QtSizeClass {
  if (width >= QT_BREAKPOINT_DESKTOP) return "desktop";
  if (width >= QT_BREAKPOINT_WIDE) return "wide";
  if (width >= QT_BREAKPOINT_MEDIUM) return "medium";
  return "compact";
}

function readWindowSnapshot(): GetWindowInfoResult | null {
  try {
    const info = uni.getWindowInfo();
    if (!Number.isFinite(info.windowWidth) || !Number.isFinite(info.windowHeight)
      || info.windowWidth <= 0 || info.windowHeight <= 0) return null;
    return info;
  } catch (_) {
    // 新 Activity 首帧/转屏暂不可读时保留完整旧快照，不把已消费的 inset 加回来。
    return null;
  }
}

export function refreshQtLayout(breakpoint: number = QT_BREAKPOINT_DEFAULT): void {
  layout.breakpoint = breakpoint;
  lastReadAt = Date.now();
  const info = readWindowSnapshot();
  if (info != null) applyWindowSnapshot(info);
}

/** 高度和安全区必须出自同一次窗口查询，不能拼接两个 Activity 的几何。 */
function applyWindowSnapshot(info: GetWindowInfoResult): void {
  const size = { width: info.windowWidth, height: info.windowHeight };
  const safeBottom = readSafeBottom(info);
  const changed = size.width != layout.windowWidth || size.height != layout.windowHeight;
  layout.windowWidth = size.width;
  layout.windowHeight = size.height;
  // 两个维度都必须是有效值才敢判横屏。某些 ROM 在转屏瞬间会把 windowHeight 报成 0
  // （getSystemInfoSync 拿到中间态），此时 `width > height` 恒真，竖屏手机被当成横屏：
  // 720x1280 的竖屏窗口会走「横屏 + medium」分支进入宽屏布局，长出 64px 图标 rail、
  // 底部 TabBar 消失。有效性保护已在赋值前拒绝中间态，保留最后有效快照。
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
  // 底部安全区：三键导航 / 鸿蒙虚拟导航条的高度。随窗口快照更新而不是
  // 挂载时读一次就完事，因为用户可以在系统设置里切换「三键导航 ↔ 手势导航」，
  // 窗口尺寸不变（不触发上面的 changed），但安全区变了。
  layout.safeBottomPx = safeBottom;
  layout.navigationInsetPx = nativeBottomInsetPx >= 0 ? nativeBottomInsetPx : safeBottom;
  // #ifdef APP-IOS
  layout.navigationKeys = 0;
  // #endif
  if (changed) layout.sizeEpoch = layout.sizeEpoch + 1;
  initialized = true;
}

/** Android 的导航 inset 仍可能是整条系统栏高度，而运行时已缩短页面窗口。 */
function remainingAndroidBottomInset(inset: number, info: GetWindowInfoResult): number {
  if (inset <= 0) return 0;
  if (!Number.isFinite(info.screenHeight) || info.screenHeight <= 0) {
    return initialized ? Math.min(inset, layout.safeBottomPx) : inset;
  }
  // screenTop 是窗口在屏幕上的位置；自定义导航的正常全屏窗口为 0。
  // 部分运行时未提供该字段时，windowTop 给出同一自定义页面的顶部位置。
  const top = info.screenTop != null && info.screenTop >= 0 ? info.screenTop
    : info.windowTop != null && info.windowTop >= 0 ? info.windowTop : 0;
  const outside = Math.max(0, info.screenHeight - top - info.windowHeight);
  return Math.max(0, inset - outside);
}

function readSafeBottom(info: GetWindowInfoResult): number {
  // #ifdef APP-ANDROID || APP-HARMONY
  // 原生读数一旦到手就是唯一可信来源，且已在 services/app-native.uts 里折算成
  // **逻辑像素**（原生给的是设备像素：三键导航真值 158 设备像素 = 42 逻辑像素）。
  // 2026-10-31 vivo V2505A 实锤：uni.getWindowInfo().safeAreaInsets.bottom 报 592，
  // 既不是设备像素（158）也不是逻辑像素（42），拿它当逻辑像素写进 padding-bottom
  // 就是 592 设备像素 —— 内容容器 3168 → 2576，绝对定位的悬浮 TabBar
  // （bottom = 24rpx + 592 逻辑像素）被顶到窗口中部（实测 top=1707）。
  // 鸿蒙上同款接口恒回 0，也只能靠原生。
  // Android 的符号只描述原生 contentRoot；运行时窗口可能尚未同步，仍按完整栏高算。
  if (nativeBottomInsetPx != -1) {
    // #ifdef APP-ANDROID
    return Math.round(remainingAndroidBottomInset(nativeBottomInsetPx, info));
    // #endif
    // #ifndef APP-ANDROID
    return nativeBottomInsetPx > 0 ? nativeBottomInsetPx : 0;
    // #endif
  }
  // #endif
  let fromInsets = 0;
  const insets = info.safeAreaInsets;
  if (insets != null && insets.bottom > 0) fromInsets = Math.round(insets.bottom);
  // 兜底也必须夹：安卓上这个读数报 592（真值 158 设备像素 / 42 逻辑像素，被当成
  // 逻辑像素就是 592 设备像素），原生读数到达之前直接采信会让首帧把内容区收短半屏。
  // 按窗口高的固定比例封顶，不写死 px（大屏上三键导航也更高）；iOS 没有原生读数，
  // 走的就是这条，102 设备像素量级远在封顶内。
  if (fromInsets > 0) {
    const cap = Math.round(info.windowHeight * SAFE_BOTTOM_FALLBACK_CAP_RATIO);
    if (fromInsets > cap) fromInsets = cap;
  }
  return fromInsets;
}

/**
 * 写入原生侧异步读到的底部导航避让高度（App.uvue 启动与每次回前台时，
 * 经 services/app-native.uts 的 readBottomNavInset 回调进来）。
 * uni.getWindowInfo().safeAreaInsets.bottom 在两端都不可信（2026-10-31 真机反馈：
 * 安卓机悬浮 TabBar 跑到屏幕中部、鸿蒙机压在导航键上）：安卓上它报 592（真值
 * 158 设备像素 / 42 逻辑像素），鸿蒙上恒回 0。所以原生读数一到手就覆盖掉 insets，
 * 只在原生读数还没到（本函数从未被调用、nativeBottomInsetPx 仍是 -1）时才退回
 * insets，见 readSafeBottom。传进来的 px 已是**逻辑像素**（换算在
 * services/app-native.uts 的 readBottomNavInset 里做，原生给的是设备像素）。
 * Android 负数仍保留栏高：contentRoot 已避让不代表 getWindowInfo 已更新。
 * 完整栏高减掉同一次窗口查询里已消费的部分，才能让 height - inset 始终稳定。
 * 值没变不赋值，避免无谓作废响应式绑定。
 */
export function applyQtNativeSafeBottom(px: number, navigationKeys: number = -1): void {
  if (!Number.isFinite(px)) return;
  if (navigationKeys >= 0) layout.navigationKeys = navigationKeys > 0 ? 1 : 0;
  let clamped = px > 0 ? Math.round(px) : 0;
  // #ifdef APP-ANDROID
  clamped = Math.round(Math.abs(px));
  // #endif
  const sameNativeInset = clamped == nativeBottomInsetPx;
  nativeBottomInsetPx = clamped;
  const previous = layout.safeBottomPx;
  const info = readWindowSnapshot();
  // 首帧未知不是“重新覆盖导航键”。等有效窗口再一起发布高度与剩余避让。
  if (info == null) return;
  applyWindowSnapshot(info);
  const merged = layout.safeBottomPx;
  if (sameNativeInset && merged == previous) return;
  // 留痕一次（每次回前台一条）：安卓上 insets 与原生读数会差一个屏幕密度，
  // 有这行日志就不必再靠 View 树几何反推（2026-10-31 排查就是这么绕的）。
  let rawInsets = 0;
  const insets = info.safeAreaInsets;
  if (insets != null && insets.bottom > 0) rawInsets = Math.round(insets.bottom);
  console.log("[QtLayout] safeBottom native=" + clamped + " insets=" + rawInsets + " -> " + merged);
}

function startWindowWatcher(breakpoint: number): void {
  // 后台期间不启动（等 resumeQtLayoutWatcher 拉起），避免后台组件挂载把轮询叫醒
  if (watcherPaused) return;
  if (watcherTimer != 0) return;
  watcherTimer = setInterval(() => {
    // 安全区也可能单独变化；只写入实际变化的响应式值，不重复创建快照读取。
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

/** 挂载同步：节流读取，尺寸与安全区无变化时不触发 reactive 更新。 */
export function syncQtLayout(breakpoint: number = QT_BREAKPOINT_DEFAULT): void {
  if (!initialized) {
    refreshQtLayout(breakpoint);
    startWindowWatcher(breakpoint);
    return;
  }
  if (Date.now() - lastReadAt < READ_THROTTLE_MS) return;
  refreshQtLayout(breakpoint);
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
  // 即使初始化前走真实窗口兜底，也先订阅响应式宽度，防止早期 computed 永久缓存。
  // 初始化后只读共享快照；比例与原生 CSS rpx 一致，内容限宽不能封顶换算。
  const width = layout.windowWidth;
  if (initialized) return n * (width / 750);
  let win = 375;
  try {
    win = uni.getWindowInfo().windowWidth;
  } catch (_) {
    // 静默：窗口信息读不出按 375 基准宽换算
  }
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

/** Legacy maximum (120rpx bar + 64rpx gap); actual gap depends on navigation keys. */
export const QT_TAB_BAR_HEIGHT_RPX = 184;

/** 系统栏已提供底部间隔时不额外悬空；不能用“本页还需避让多少”决定间距。 */
export function qtTabBarFloatGapPx(): number {
  const previous = layout.navigationInsetPx > 0 ? 0 : QT_TAB_BAR_HEIGHT_RPX - 120;
  const gap = layout.navigationKeys == 0 ? Math.min(previous, 24) : previous;
  return qtRpx(gap);
}

export function qtTabBarHeightPx(joined: boolean = false): number {
  return qtRpx(joined ? 88 : 120) + qtTabBarFloatGapPx() + layout.safeBottomPx;
}

/**
 * 常驻底部播放栏高度（px）：宽屏下 qt-mini-player 从浮动 FAB 变成 dock 底栏，
 * 页面内容与 toast / 返回顶部都要让开这段高度。
 */
export const QT_PLAYER_BAR_HEIGHT_PX = 84;

/** Dock controls + system navigation inset. Frame, toast and back-to-top share this budget. */
export function qtPlayerBarHeightPx(): number {
  return QT_PLAYER_BAR_HEIGHT_PX + layout.safeBottomPx;
}
