import { computed, ref } from "vue";
import { qtLayout, qtRpx, qtRailWidth } from "../composables/use-qt-layout";

/**
 * 悬浮播放器（qt-mini-player）的全站共享 UI 状态。
 *
 * 2026-10-24 改造（用户：「全部页面共用一个悬浮播放器，页面返回或者进入页面
 * 不应该出现闪烁」）。此前每个页面各挂一份组件、各自维护位置/展开/旋转状态，
 * 再用一个「显示权」交接协议（注册 + 栈顶路由轮询）决定谁显示 —— 闪烁正是这个
 * 交接协议造成的：
 *   - navigateTo：新页一挂载就把显示权抢过去，**还完全可见**的旧页悬浮球当场
 *     消失，直到新页盖上来、自己的球才出现 —— 每次进页都有一段「球没了」的空洞；
 *   - navigateBack：出栈页卸载时才把显示权交回，下面的页要等卸载+刷新才冒出
 *     球，观感是「球跟着旧页飞走了、又在原位闪出来」；
 *   - switchTab：两边都不挂载，只能靠 250ms 轮询补交接 —— 球要迟到几百毫秒。
 *
 * 现在的架构：**没有显示权交接**。qt-page-frame 在每个页面挂同一份组件，全部
 * 实例渲染同一份共享状态（位置/展开/吸附侧/渲染尺寸/唱片旋转角都在这一个模块
 * 里），像素级一致：
 *   - 页面栈里被盖住的页面窗口本来就在顶层窗口后面（一页一 Activity），它的球
 *     不会被看到 —— 不需要任何协议去「藏」它；
 *   - 转场动画期间新旧两页同屏：两个一模一样的球按页面转场物理一起运动，
 *     视觉上就是同一个球（与宽屏 qt-player-bar 挂框架层、全页常驻同构）；
 *   - 第 2 个页面起**没有初始化阶段**：位置早已就位，球出现即正确位置，
 *     不再有「半高窗口算错位置再跳一次」的窗口期。
 *
 * 沿用的平台约束（详见各函数注释）：
 *   - 首帧窗口尺寸不可信（getWindowInfo 可能返回半高窗口），初始化要重试、
 *     落盘要有护栏；
 *   - 位置持久化格式 "x,y,窗口高"，第三段用于识别坏坐标；
 *   - 展开条必须吸附一侧，尺寸变化跨两帧渲染避免被 Vapor 合并成瞬移。
 */

/** 悬浮球当前位置（px，left/top）——全站共享，任何页面拖动都改这一份 */
export const miniFabX = ref(0);
export const miniFabY = ref(0);
/** 是否展开成播放条 */
export const miniExpanded = ref(false);
/** 当前吸附侧（"left" / "right"） */
export const miniEdgeSide = ref("left");
/** 吸附/展开动画进行中（transition 生效标记） */
export const miniEdgeAnimating = ref(false);
/** 显式维护的渲染尺寸（px）：宿主 fixed 盒子的宽高 */
export const miniRenderWidth = ref(0);
export const miniRenderHeight = ref(0);
/** 是否已按「稳定的窗口尺寸」完成定位；未就位前 resize 只重跑初始化、不落盘 */
export const miniPositioned = ref(false);
/** 唱片旋转角（度）；全站共享 ⇒ 换页后旋转连续，不再从 0 跳起 */
export const miniRotateDeg = ref(0);

/** 悬浮球尺寸（rpx）与展开条尺寸（rpx/px）。必须经 qtRpx 折算（见 use-qt-layout）。 */
export const MINI_FAB_SIZE_RPX = 120;
const MINI_WIDTH_RPX = 620;
const MINI_HEIGHT_RPX = 112;
const MINI_WIDTH_WIDE_PX = 360;
const MINI_HEIGHT_WIDE_PX = 56;
const FAB_WIDE_PX = 72;
/** 默认边距（rpx）：底部让开悬浮 TabBar 的占位（qtTabBarHeightPx = 144rpx 同源） */
const LEFT_MARGIN_RPX = 28;
const BOTTOM_MARGIN_RPX = 190;
/** 位置持久化 key；格式 "x,y,窗口高" */
const POS_KEY = "qt-mini-player-fab";

const layout = qtLayout();

/** 悬浮球边长（px）：宽屏固定 72，窄屏按 rpx 折算 */
export const miniFabPx = computed((): number => {
  layout.windowWidth;
  return layout.isWide ? FAB_WIDE_PX : qtRpx(MINI_FAB_SIZE_RPX);
});

/** 当前视觉尺寸宽（px）：展开成播放条或收缩成球 */
export const miniCurrentWidth = computed((): number => {
  layout.windowWidth;
  return miniExpanded.value
    ? (layout.isWide ? MINI_WIDTH_WIDE_PX : qtRpx(MINI_WIDTH_RPX))
    : miniFabPx.value;
});

/** 当前视觉尺寸高（px） */
export const miniCurrentHeight = computed((): number => {
  layout.windowWidth;
  return miniExpanded.value
    ? (layout.isWide ? MINI_HEIGHT_WIDE_PX : qtRpx(MINI_HEIGHT_RPX))
    : miniFabPx.value;
});

/* ---------------- 旋转（单一 rAF，全站共享） ---------------- */

let spinTimer: number | null = null;
let spinLastTime = 0;
let spinPlaying = false;
/** 挂载的组件实例数：>0 且正在播放才跑 rAF */
let mountCount = 0;

function rotateStep(timestamp: number): void {
  if (spinLastTime == 0) spinLastTime = timestamp;
  const dt = timestamp - spinLastTime;
  spinLastTime = timestamp;
  if (dt > 0) {
    // 约 12 度/秒，按实际经过时间计算，保证不同帧率下速度一致
    miniRotateDeg.value = (miniRotateDeg.value + dt * 0.012) % 360;
  }
  spinTimer = requestAnimationFrame(rotateStep);
}

function syncSpinLoop(): void {
  const shouldRun = mountCount > 0 && spinPlaying;
  if (shouldRun && spinTimer == null) {
    spinLastTime = 0;
    spinTimer = requestAnimationFrame(rotateStep);
    return;
  }
  if (!shouldRun && spinTimer != null) {
    cancelAnimationFrame(spinTimer);
    spinTimer = null;
  }
}

/** 组件 onMounted 调：登记一个渲染实例 */
export function miniPlayerMount(): void {
  mountCount += 1;
  syncSpinLoop();
}

/** 组件 onUnmounted 调 */
export function miniPlayerUnmount(): void {
  if (mountCount > 0) mountCount -= 1;
  syncSpinLoop();
}

/** 组件 watch(player.playing) 调 */
export function miniPlayerSetPlaying(playing: boolean): void {
  spinPlaying = playing;
  syncSpinLoop();
}

/* ---------------- 定位 / 落盘 ---------------- */

let initRetryTimer: number | null = null;
let initRetryLeft = 40;

function clearInitRetry(): void {
  if (initRetryTimer != null) {
    clearTimeout(initRetryTimer);
    initRetryTimer = null;
  }
}

/**
 * 初始化位置：优先使用上次拖动落盘的坐标，否则默认左侧、底部让开悬浮 TabBar。
 * 只在**首次**（miniPositioned=false）执行；后续页面的实例直接渲染共享位置。
 *
 * 窗口读数不稳定（0 或与 use-qtLayout 量测差得多 = 页面还没铺满的中间态）时
 * 不能按它算位置 —— 算出来的 y 会很小，一旦被 resize 落盘就会污染所有页面；
 * 50ms 重试，最多 40 次。稳定后不再依赖这条重试链。
 */
export function ensureMiniPositioned(): void {
  clearInitRetry();
  if (miniPositioned.value) return;
  const win = uni.getWindowInfo();
  // 高度优先取 useQtLayout 的量测值（响应式、与整套分栏判定同口径），
  // getWindowInfo 只在量测未就绪时兜底。
  const winW = layout.windowWidth > 0 ? layout.windowWidth : win.windowWidth;
  const winH = layout.windowHeight > 0 ? layout.windowHeight : win.windowHeight;
  const unstable = winW <= 0 || winH <= 0
    || (win.windowHeight > 0 && layout.windowHeight > 0 && Math.abs(win.windowHeight - layout.windowHeight) > 24);
  if (unstable && initRetryLeft > 0) {
    initRetryLeft--;
    initRetryTimer = setTimeout(ensureMiniPositioned, 50) as unknown as number;
    return;
  }
  if (winW <= 0 || winH <= 0) return;
  let x = qtRpx(LEFT_MARGIN_RPX);
  let y = winH - (layout.isWide ? 96 : qtRpx(BOTTOM_MARGIN_RPX)) - miniFabPx.value;
  if (layout.isWide) {
    // 宽屏左侧有导航 rail（wide/desktop 208px，medium 64px），默认落在 rail 右侧
    x = qtRailWidth() + 16;
  }
  try {
    const saved = uni.getStorageSync(POS_KEY) as string;
    if (saved.length > 0) {
      const parts = saved.split(",");
      // 只认三段格式 "x,y,窗口高"：第三段判断坐标是否在同一窗口高度下记录。
      // 两段是旧格式，可能躺着按半高窗口算出的坏坐标，一律忽略、回默认位置。
      if (parts.length == 3) {
        const sx = parseFloat(parts[0]);
        const sy = parseFloat(parts[1]);
        const sh = parseFloat(parts[2]);
        if (!isNaN(sx) && !isNaN(sy) && !isNaN(sh) && Math.abs(sh - winH) <= 8) {
          x = sx;
          y = sy;
        }
      }
    }
  } catch (_) {}
  const minX = layout.isWide ? qtRailWidth() + 8 : 0;
  const maxX = Math.max(minX, winW - miniFabPx.value);
  const maxY = Math.max(0, winH - miniFabPx.value);
  y = Math.max(0, Math.min(y, maxY));
  // 悬浮球始终吸附一侧；宽屏左侧避开 rail，右侧贴窗口右缘。
  miniEdgeSide.value = Math.abs(maxX - x) < Math.abs(x - minX) ? "right" : "left";
  x = miniEdgeSide.value == "right" ? maxX : minX;
  miniFabX.value = x;
  miniFabY.value = y;
  miniPositioned.value = true;
  // 复位重试预算：后续 resize 再次定位时还能重新等窗口稳定
  initRetryLeft = 40;
}

/**
 * 落盘当前坐标（"x,y,窗口高"）。
 *
 * 两条硬条件：必须已按稳定窗口初始化过；当前窗口尺寸与 useQtLayout 量测一致。
 * 否则宁可不存，也不要让半高窗口算出的坐标把下次启动带偏。
 */
function persistPosition(): void {
  if (!miniPositioned.value) return;
  const win = uni.getWindowInfo();
  const winH = layout.windowHeight > 0 ? layout.windowHeight : win.windowHeight;
  if (winH <= 0 || (win.windowHeight > 0 && layout.windowHeight > 0 && Math.abs(win.windowHeight - layout.windowHeight) > 24)) return;
  try {
    uni.setStorageSync(POS_KEY, Math.round(miniFabX.value) + "," + Math.round(miniFabY.value) + "," + Math.round(winH));
  } catch (_) {}
}

/* ---------------- 渲染尺寸（显式跨两帧，防 Vapor 合并成瞬移） ---------------- */

let sizeTimer: number | null = null;

/** 立即把渲染尺寸同步到当前视觉尺寸 */
export function miniSyncRenderSize(): void {
  miniRenderWidth.value = miniCurrentWidth.value;
  miniRenderHeight.value = miniCurrentHeight.value;
}

/** 下一帧再同步渲染尺寸：保证尺寸变化至少跨两个渲染帧（动画可见） */
export function miniAnimateToCurrentSize(): void {
  if (sizeTimer != null) {
    clearTimeout(sizeTimer);
    sizeTimer = null;
  }
  sizeTimer = setTimeout(() => {
    miniSyncRenderSize();
    sizeTimer = null;
  }, 16) as unknown as number;
}

/* ---------------- 吸附 / 展开 / 收起 ---------------- */

let edgeTimer: number | null = null;

function clearEdgeTimer(): void {
  if (edgeTimer != null) {
    clearTimeout(edgeTimer);
    edgeTimer = null;
  }
}

/**
 * 拖动结束后吸附最近一侧并落盘。
 * edgeAnimating 让 left/top/width/height 走 0.22s transition，而不是瞬移。
 */
export function miniSnapToNearestEdge(): void {
  const win = uni.getWindowInfo();
  const minX = layout.isWide ? qtRailWidth() + 8 : 0;
  const maxX = Math.max(minX, win.windowWidth - miniCurrentWidth.value);
  const distanceToLeft = Math.abs(miniFabX.value - minX);
  const distanceToRight = Math.abs(maxX - miniFabX.value);
  miniEdgeSide.value = distanceToRight < distanceToLeft ? "right" : "left";
  const targetX = miniEdgeSide.value == "right" ? maxX : minX;
  const maxY = Math.max(0, win.windowHeight - miniCurrentHeight.value);
  miniFabY.value = Math.max(0, Math.min(miniFabY.value, maxY));
  miniEdgeAnimating.value = true;
  miniFabX.value = targetX;
  clearEdgeTimer();
  edgeTimer = setTimeout(() => {
    miniEdgeAnimating.value = false;
    edgeTimer = null;
    persistPosition();
  }, 240) as unknown as number;
}

/**
 * 从球展开成播放条：先吸附一侧，播放条从该侧向内容区展开。
 * 保留当前球的位置作为动画起点，同时把目标左边界贴到选中侧 —— left 过渡与
 * 横向展开同帧进行，避免「先瞬移到边缘再展开」。
 */
export function miniExpandFromFab(): void {
  const win = uni.getWindowInfo();
  const minX = layout.isWide ? qtRailWidth() + 8 : 0;
  const maxFabX = Math.max(minX, win.windowWidth - miniFabPx.value);
  miniEdgeSide.value = Math.abs(maxFabX - miniFabX.value) < Math.abs(miniFabX.value - minX) ? "right" : "left";
  const miniWidth = layout.isWide ? MINI_WIDTH_WIDE_PX : qtRpx(MINI_WIDTH_RPX);
  const targetX = miniEdgeSide.value == "right" ? win.windowWidth - miniWidth : minX;
  miniExpanded.value = true;
  miniEdgeAnimating.value = true;
  miniFabX.value = targetX;
  miniFabY.value = Math.max(0, Math.min(miniFabY.value, win.windowHeight - miniCurrentHeight.value));
  miniAnimateToCurrentSize();
  clearEdgeTimer();
  edgeTimer = setTimeout(() => {
    miniEdgeAnimating.value = false;
    edgeTimer = null;
  }, 240) as unknown as number;
}

/**
 * 收起播放条回球（幂等：未展开时零开销）。
 * 收起时把球放回当前吸附侧：右侧展开条的 left 是整条宽度，
 * 直接切换回球会留下一个悬空位置。
 */
export function miniCollapse(): void {
  if (!miniExpanded.value) return;
  const win = uni.getWindowInfo();
  const minX = layout.isWide ? qtRailWidth() + 8 : 0;
  const maxX = Math.max(minX, win.windowWidth - miniFabPx.value);
  miniEdgeAnimating.value = true;
  miniExpanded.value = false;
  miniFabX.value = miniEdgeSide.value == "right" ? maxX : minX;
  miniAnimateToCurrentSize();
  miniFabY.value = Math.max(0, Math.min(miniFabY.value, win.windowHeight - miniFabPx.value));
  clearEdgeTimer();
  edgeTimer = setTimeout(() => {
    miniEdgeAnimating.value = false;
    edgeTimer = null;
  }, 240) as unknown as number;
}

/* ---------------- 窗口尺寸变化 ---------------- */

/**
 * 窗口尺寸变化（每个实例的 watch 调；幂等）。
 * 未就位：只补一次「按稳定尺寸初始化」，不钳制、不落盘。
 * 展开中：收起（展开条宽度是按旧窗口算的）。
 * 其余：按吸附侧重贴边缘、钳制纵向，最后落盘。
 */
export function onMiniWindowResize(): void {
  if (!miniPositioned.value) {
    ensureMiniPositioned();
    return;
  }
  if (miniExpanded.value) {
    miniCollapse();
    return;
  }
  const win = uni.getWindowInfo();
  const minX = layout.isWide ? qtRailWidth() + 8 : 0;
  const maxX = Math.max(minX, win.windowWidth - miniFabPx.value);
  miniFabX.value = miniEdgeSide.value == "right" ? maxX : minX;
  miniFabY.value = Math.max(0, Math.min(miniFabY.value, win.windowHeight - miniFabPx.value));
  persistPosition();
}

/** 窗口从窄变宽（进入宽屏）时由 v-if 直接卸载球；这里清掉悬着的动画状态 */
export function onMiniPlayerHidden(): void {
  clearEdgeTimer();
  miniEdgeAnimating.value = false;
  if (sizeTimer != null) {
    clearTimeout(sizeTimer);
    sizeTimer = null;
  }
}
