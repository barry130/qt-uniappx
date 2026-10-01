import { reactive } from "vue";

export type QtLayoutState = {
  windowWidth: number;
  windowHeight: number;
  breakpoint: number;
  isLandscape: boolean;
  isWide: boolean;
};

const layout = reactive<QtLayoutState>({
  windowWidth: 375,
  windowHeight: 667,
  breakpoint: 720,
  isLandscape: false,
  isWide: false,
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

export function refreshQtLayout(breakpoint: number = 720): void {
  layout.breakpoint = breakpoint;
  // 强制真读：调用方（App.onLaunch、检测到尺寸变化后）要的是当前真实尺寸，
  // 不能被挂载节流挡掉
  const size = readWindowSize(true);
  layout.windowWidth = size.width;
  layout.windowHeight = size.height;
  layout.isLandscape = size.width > size.height;

  // Android 模拟器的 1600x900 往往经过高 DPI 缩放，
  // getSystemInfoSync().windowWidth 可能只有 400 左右，不能只用 720px 判断宽屏。
  // 横屏本身就是桌面 / 宽屏布局的可靠信号，同时保留真实宽度断点以支持平板和 Web。
  layout.isWide = layout.windowWidth >= breakpoint || layout.isLandscape;
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
export function resumeQtLayoutWatcher(breakpoint: number = 720): void {
  watcherPaused = false;
  syncQtLayout(breakpoint);
  startWindowWatcher(breakpoint);
}

/** 手动同步一次：尺寸有变化时才刷新 reactive，无变化零开销 */
export function syncQtLayout(breakpoint: number = 720): void {
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

export function useQtLayout(breakpoint: number = 720): QtLayoutState {
  // 每次组件挂载都同步一次：跨页面导航、旋转后新开页面都能拿到最新窗口尺寸
  syncQtLayout(breakpoint);
  startWindowWatcher(breakpoint);
  return layout;
}

/**
 * JS 侧 rpx -> px 换算，必须与 CSS 的 rpx 封顶行为保持一致：
 * pages.json 设 rpxCalcMaxDeviceWidth=500 / rpxCalcBaseDeviceWidth=375，
 * 窗口宽度超过 500dp 后 CSS rpx 按 375dp 基准计算；JS 若仍按
 * windowWidth/750 换算会比实际渲染大 2-3 倍（宽屏下进度条/列表定位全部错位）。
 */
/** 状态栏高度（px）；navigationStyle: custom 的页面用它给内容让位 */
export function qtStatusBarPx(): number {
  try {
    const info = uni.getWindowInfo();
    return Math.round(info.statusBarHeight > 0 ? info.statusBarHeight : 0);
  } catch (_) {
    return 0;
  }
}

export function qtRpx(n: number): number {
  let win = 375;
  try {
    win = uni.getWindowInfo().windowWidth;
  } catch (_) {}
  const base = win > 500 ? 375 : win;
  return n * (base / 750);
}
